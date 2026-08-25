import type { NormalizedPost, SocialPlatform } from "./social-scanner";
import {
  buildEditorialAnalysisMap,
  editorialPostKey,
} from "./social-editorial-analysis.ts";
import { rankPostsByPublicMetric } from "./social-ranking.ts";

export type SocialMetric =
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "pollVotes";

export type ScoreConfidence = "high" | "medium" | "low" | "insufficient";

export type RankedPost = NormalizedPost & {
  performanceScore: number | null;
  confidence: ScoreConfidence;
  scoreExplanation: string;
  metricCoverage: SocialMetric[];
  cohortKey: string;
  rank: number | null;
  platformRank: number | null;
};

export type SocialInsight = {
  id: string;
  platform: SocialPlatform | "all";
  title: string;
  detail: string;
  confidence: ScoreConfidence;
};

export type PlatformAnalysis = {
  platform: SocialPlatform;
  postCount: number;
  availableMetrics: SocialMetric[];
  topExternalId: string | null;
  topScore: number | null;
};

export type SocialAnalysis = {
  generatedAt: string;
  postCount: number;
  platformCount: number;
  headline: string;
  coverage: PlatformAnalysis[];
  insights: SocialInsight[];
  caveats: string[];
};

const METRICS: SocialMetric[] = [
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "pollVotes",
];
const PLATFORM_SORT_ORDER: SocialPlatform[] = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
];
const METRIC_WEIGHTS: Record<SocialMetric, number> = {
  views: 0.45,
  likes: 0.25,
  comments: 0.15,
  shares: 0.1,
  saves: 0.05,
  pollVotes: 0.45,
};
const METRIC_LABELS: Record<SocialMetric, string> = {
  views: "vues cumulées",
  likes: "likes cumulés",
  comments: "commentaires cumulés",
  shares: "partages cumulés",
  saves: "sauvegardes cumulées",
  pollVotes: "votes du sondage cumulés",
};

type ScoreDraft = RankedPost;

type ComparablePost = {
  post: NormalizedPost;
  formatKey: string;
  values: Record<SocialMetric, number | null>;
};

export function rankPosts(
  posts: readonly NormalizedPost[],
  _now: Date | string | number = new Date(),
): RankedPost[] {
  void _now; // Kept for API compatibility; lifetime scoring is intentionally age-independent.
  const comparable: ComparablePost[] = posts.map((post) => ({
    post,
    formatKey: normalizeFormat(post.format),
    values: comparableValues(post),
  }));
  const byPlatform = groupBy(comparable, (item) => item.post.platform);
  const drafts: ScoreDraft[] = [];

  for (const [platform, platformPosts] of byPlatform) {
    const byFormat = groupBy(platformPosts, (item) => item.formatKey);
    const percentileLookups = new Map<
      string,
      Map<SocialMetric, Map<number, number>>
    >();
    for (const [formatKey, cohort] of byFormat) {
      const byMetric = new Map<SocialMetric, Map<number, number>>();
      for (const metric of METRICS) {
        byMetric.set(metric, buildPercentileLookup(cohort, metric));
      }
      percentileLookups.set(formatKey, byMetric);
    }

    for (const item of platformPosts) {
      const cohort = byFormat.get(item.formatKey) ?? [item];
      const cohortKey = `${platform}:${item.formatKey}`;
      const metricCoverage = METRICS.filter(
        (metric) => item.values[metric] !== null,
      );
      const metricPercentiles: Partial<Record<SocialMetric, number>> = {};
      let weightedScore = 0;
      let availableWeight = 0;

      for (const metric of metricCoverage) {
        const value = item.values[metric];
        if (value === null) continue;
        const percentile =
          percentileLookups.get(item.formatKey)?.get(metric)?.get(value);
        if (percentile === undefined) continue;
        metricPercentiles[metric] = percentile;
        weightedScore += percentile * METRIC_WEIGHTS[metric];
        availableWeight += METRIC_WEIGHTS[metric];
      }

      const performanceScore =
        availableWeight > 0 ? Math.round(weightedScore / availableWeight) : null;
      const confidence = scoreConfidence(cohort.length, metricCoverage.length);

      drafts.push({
        ...item.post,
        performanceScore,
        confidence,
        scoreExplanation: explainScore(
          platform,
          cohort.length,
          metricCoverage,
          metricPercentiles,
          performanceScore,
        ),
        metricCoverage,
        cohortKey,
        rank: null,
        platformRank: null,
      });
    }
  }

  const sorted = drafts.sort(compareRankedPosts);
  let globalRank = 0;
  const platformRanks = new Map<SocialPlatform, number>();

  return sorted.map((post) => {
    if (post.performanceScore === null) return post;
    globalRank += 1;
    const platformRank = (platformRanks.get(post.platform) ?? 0) + 1;
    platformRanks.set(post.platform, platformRank);
    return { ...post, rank: globalRank, platformRank };
  });
}

export function buildSocialAnalysis(
  posts: readonly NormalizedPost[],
  now: Date | string | number = new Date(),
): SocialAnalysis {
  const referenceTime = validDate(now);
  const ranked = rankPosts(posts, referenceTime);
  return buildSocialAnalysisFromRanked(ranked, referenceTime);
}

export function buildSocialAnalysisFromRanked(
  ranked: readonly RankedPost[],
  now: Date | string | number = new Date(),
  precomputedEditorialAnalyses?: ReturnType<typeof buildEditorialAnalysisMap>,
): SocialAnalysis {
  const referenceTime = validDate(now);
  const byPlatform = groupBy(ranked, (post) => post.platform);
  const editorialAnalyses =
    precomputedEditorialAnalyses ?? buildEditorialAnalysisMap(ranked);
  const coverage: PlatformAnalysis[] = [];
  const insights: SocialInsight[] = [];

  for (const platform of platformOrder(byPlatform.keys())) {
    const platformPosts = byPlatform.get(platform) ?? [];
    const top = platformPosts.find((post) => post.performanceScore !== null) ?? null;
    const availableMetrics = METRICS.filter((metric) =>
      platformPosts.some((post) => sourceMetric(post, metric) !== null),
    );
    coverage.push({
      platform,
      postCount: platformPosts.length,
      availableMetrics,
      topExternalId: top?.externalId ?? null,
      topScore: top?.performanceScore ?? null,
    });

    if (!top) {
      insights.push({
        id: `${platform}-insufficient`,
        platform,
        title: `${platformLabel(platform)} · données insuffisantes`,
        detail:
          "Aucune métrique publique exploitable n’est disponible pour classer ces contenus.",
        confidence: "insufficient",
      });
      continue;
    }

    if (platformPosts.length === 1) {
      insights.push({
        id: `${platform}-single-post`,
        platform,
        title: `${platformLabel(platform)} · un seul contenu observable`,
        detail:
          "Le contenu est visible, mais il n’existe pas encore de cohorte pour déclarer un gagnant.",
        confidence: "low",
      });
      continue;
    }

    insights.push({
      id: `${platform}-top-${top.externalId}`,
      platform,
      title: `${platformLabel(platform)} · ${displayTitle(top)}`,
      detail: (() => {
        const analysis = editorialAnalyses.get(editorialPostKey(top));
        return analysis
          ? `${analysis.mechanism} ${analysis.comparison} À reproduire : ${analysis.transferableLesson}`
          : "Le texte public ne permet pas encore une lecture éditoriale spécifique.";
      })(),
      confidence: editorialAnalyses.get(editorialPostKey(top))?.confidence ?? "low",
    });
  }

  const platformCount = byPlatform.size;
  const editorialInsights = buildEditorialInsights(ranked, editorialAnalyses);
  return {
    generatedAt: referenceTime.toISOString(),
    postCount: ranked.length,
    platformCount,
    headline:
      ranked.length === 0
        ? "Aucun contenu public exploitable pour le moment."
        : `${ranked.length} contenus publics comparés séparément sur ${platformCount} plateforme${platformCount > 1 ? "s" : ""}.`,
    coverage,
    insights: [...editorialInsights, ...insights],
    caveats: [
      "Les scores lifetime transforment les compteurs cumulés en percentiles dans chaque plateforme et chaque format ; ils ne comparent jamais directement les volumes bruts entre réseaux.",
      "Une métrique absente est exclue puis les poids restants sont renormalisés ; elle n’est jamais remplacée par zéro.",
      "Les enseignements sont descriptifs et probabilistes : ils ne démontrent pas une causalité créative.",
    ],
  };
}

function buildEditorialInsights(
  posts: readonly RankedPost[],
  analyses: ReturnType<typeof buildEditorialAnalysisMap>,
): SocialInsight[] {
  const cohorts = new Map<string, RankedPost[]>();
  for (const post of posts) {
    const key = `${post.platform}:${post.format ?? "unknown"}`;
    const cohort = cohorts.get(key);
    if (cohort) cohort.push(post);
    else cohorts.set(key, [post]);
  }

  const categoryInsights = [...cohorts.values()]
    .filter((cohort) => cohort.length >= 2)
    .map((cohort) => {
      const top = publicTopPost(cohort);
      return { cohort, top, analysis: analyses.get(editorialPostKey(top)) };
    })
    .filter((item) => item.analysis !== undefined)
    .sort((left, right) =>
      right.cohort.length !== left.cohort.length
        ? right.cohort.length - left.cohort.length
        : editorialPostKey(left.top).localeCompare(editorialPostKey(right.top)),
    )
    .slice(0, 3)
    .map(({ top, analysis }) => ({
      id: `editorial-${top.platform}-${top.externalId}`,
      platform: top.platform,
      title: analysis!.headline,
      detail: `${analysis!.mechanism} ${analysis!.comparison} À reproduire : ${analysis!.transferableLesson}`,
      confidence: analysis!.confidence,
    }));

  const leaders = [...cohorts.values()]
    .filter((cohort) => cohort.length >= 2)
    .map(publicTopPost);
  const creativeGroups = groupBy(leaders, normalizedCreativeKey);
  const reusedCreative = [...creativeGroups.entries()]
    .map(([key, group]) => ({
      key,
      group,
      platforms: new Set(group.map((post) => post.platform)),
    }))
    .filter(
      (candidate) =>
        candidate.key.split(" ").length >= 4 && candidate.platforms.size >= 2,
    )
    .sort((left, right) =>
      right.platforms.size !== left.platforms.size
        ? right.platforms.size - left.platforms.size
        : left.key.localeCompare(right.key),
    )[0];

  if (!reusedCreative) return categoryInsights;
  const reference = reusedCreative.group[0];
  const analysis = analyses.get(editorialPostKey(reference));
  const platformNames = [...reusedCreative.platforms]
    .sort(
      (left, right) =>
        PLATFORM_SORT_ORDER.indexOf(left) - PLATFORM_SORT_ORDER.indexOf(right),
    )
    .map(platformLabel);
  return [
    {
      id: `cross-platform-${reusedCreative.key}`,
      platform: "all",
      title: `Créatif cross-platform · ${displayTitle(reference)}`,
      detail: `La même accroche apparaît parmi les références de ${joinFrench(platformNames)}. ${analysis?.headline ?? "Le noyau éditorial se transpose d’un réseau à l’autre"} : ${analysis?.mechanism ?? "la formulation conserve la même promesse tout en laissant chaque plateforme adapter son exécution."} À tester avec une déclinaison native par réseau, sans supposer que la répétition suffit à expliquer le résultat.`,
      confidence: reusedCreative.platforms.size >= 3 ? "medium" : "low",
    },
    ...categoryInsights,
  ];
}

function normalizedCreativeKey(post: RankedPost): string {
  return `${post.text?.trim() || post.title?.trim() || ""}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[\w.]+/g, " ")
    .replace(/#[\p{L}\p{N}_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinFrench(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} et ${values.at(-1)}`;
}

function publicTopPost(posts: readonly RankedPost[]): RankedPost {
  return rankPostsByPublicMetric(
    posts.map((post) => ({
      post,
      external_post_id: post.externalId,
      format: post.format ?? "unknown",
      likes: safeMetric(post.likes),
      views: safeMetric(post.views),
      comments: safeMetric(post.comments),
      shares: safeMetric(post.shares),
      saves: safeMetric(post.saves),
      poll_votes: sourceMetric(post, "pollVotes"),
    })),
  ).posts[0].post;
}

function comparableValues(
  post: NormalizedPost,
): Record<SocialMetric, number | null> {
  return {
    views: safeMetric(post.views),
    likes: safeMetric(post.likes),
    comments: safeMetric(post.comments),
    shares: safeMetric(post.shares),
    saves: safeMetric(post.saves),
    pollVotes: sourceMetric(post, "pollVotes"),
  };
}

function sourceMetric(post: NormalizedPost, metric: SocialMetric): number | null {
  if (metric !== "pollVotes") return safeMetric(post[metric]);
  const raw = post.raw;
  if (!raw) return null;
  return safeMetric(
    typeof raw.pollVotes === "number"
      ? raw.pollVotes
      : typeof raw.pollTotalVotes === "number"
        ? raw.pollTotalVotes
        : null,
  );
}

function buildPercentileLookup(
  cohort: readonly ComparablePost[],
  metric: SocialMetric,
): Map<number, number> {
  const values = cohort
    .map((candidate) => candidate.values[metric])
    .filter((candidate): candidate is number => candidate !== null)
    .sort((left, right) => left - right);
  const percentiles = new Map<number, number>();
  if (values.length === 0) return percentiles;
  if (values.length === 1) {
    percentiles.set(values[0], 50);
    return percentiles;
  }

  let firstEqual = 0;
  while (firstEqual < values.length) {
    let afterEqual = firstEqual + 1;
    while (
      afterEqual < values.length &&
      values[afterEqual] === values[firstEqual]
    ) {
      afterEqual += 1;
    }
    const equalCount = afterEqual - firstEqual;
    percentiles.set(
      values[firstEqual],
      Math.round(
        ((firstEqual + Math.max(0, equalCount - 1) / 2) /
          (values.length - 1)) *
          100,
      ),
    );
    firstEqual = afterEqual;
  }
  return percentiles;
}

function scoreConfidence(
  cohortSize: number,
  metricCount: number,
): ScoreConfidence {
  if (metricCount === 0) return "insufficient";
  if (cohortSize >= 8 && metricCount >= 3) return "high";
  if (cohortSize >= 4 && metricCount >= 2) return "medium";
  return "low";
}

function explainScore(
  platform: SocialPlatform,
  cohortSize: number,
  metricCoverage: SocialMetric[],
  metricPercentiles: Partial<Record<SocialMetric, number>>,
  score: number | null,
): string {
  if (score === null) {
    return `Aucune métrique publique comparable sur ${platformLabel(platform)}. Aucun score n’est calculé.`;
  }

  const strongest = metricCoverage
    .map((metric) => ({ metric, percentile: metricPercentiles[metric] ?? 50 }))
    .sort((left, right) =>
      right.percentile !== left.percentile
        ? right.percentile - left.percentile
        : METRICS.indexOf(left.metric) - METRICS.indexOf(right.metric),
    )
    .slice(0, 2)
    .map(
      ({ metric, percentile }) =>
        `${METRIC_LABELS[metric]} au ${percentile}e percentile`,
    );
  const signalLabel = metricCoverage.length > 1 ? "signaux" : "signal";
  const coverage = `${metricCoverage.length} ${signalLabel} public${metricCoverage.length > 1 ? "s" : ""} comparable${metricCoverage.length > 1 ? "s" : ""}`;
  return `Score lifetime ${score}/100 dans une cohorte ${platformLabel(platform)} de ${cohortSize} contenu${cohortSize > 1 ? "s" : ""} du même format · ${strongest.join(" · ")} · ${coverage}. Aucun bonus de récence. Lecture descriptive, pas causale.`;
}

function compareRankedPosts(left: ScoreDraft, right: ScoreDraft): number {
  if (left.performanceScore === null && right.performanceScore !== null) return 1;
  if (left.performanceScore !== null && right.performanceScore === null) return -1;
  if (left.performanceScore !== right.performanceScore) {
    return (right.performanceScore ?? -1) - (left.performanceScore ?? -1);
  }
  const confidenceDifference =
    confidenceOrder(right.confidence) - confidenceOrder(left.confidence);
  if (confidenceDifference !== 0) return confidenceDifference;
  if (left.cohortKey === right.cohortKey) {
    for (const metric of METRICS) {
      const metricDifference =
        (sourceMetric(right, metric) ?? -1) -
        (sourceMetric(left, metric) ?? -1);
      if (metricDifference !== 0) return metricDifference;
    }
  }
  const platformDifference =
    PLATFORM_SORT_ORDER.indexOf(left.platform) -
    PLATFORM_SORT_ORDER.indexOf(right.platform);
  if (platformDifference !== 0) return platformDifference;
  const cohortDifference = left.cohortKey.localeCompare(right.cohortKey);
  if (cohortDifference !== 0) return cohortDifference;
  return `${left.platform}:${left.externalId}`.localeCompare(
    `${right.platform}:${right.externalId}`,
  );
}

function validDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function safeMetric(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeFormat(value: string | null): string {
  const format = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return format || "unknown";
}

function groupBy<T, K>(
  values: readonly T[],
  keyFor: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function platformOrder(values: IterableIterator<SocialPlatform>): SocialPlatform[] {
  const present = new Set(values);
  return PLATFORM_SORT_ORDER.filter((platform) => present.has(platform));
}

function platformLabel(platform: SocialPlatform): string {
  if (platform === "youtube") return "YouTube";
  if (platform === "instagram") return "Instagram";
  if (platform === "tiktok") return "TikTok";
  return "X";
}

function displayTitle(post: NormalizedPost): string {
  const title = post.title?.trim() || post.text?.trim() || "";
  return title ? (title.length > 72 ? `${title.slice(0, 69).trimEnd()}…` : title) : post.externalId;
}

function confidenceOrder(value: ScoreConfidence): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}
