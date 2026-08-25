import type { NormalizedPost, SocialPlatform } from "./social-scanner.ts";
import {
  buildEditorialAnalysisMap,
  buildEditorialAnalysisMapForTargets,
  editorialPostKey,
  type EditorialWhy,
} from "./social-editorial-analysis.ts";
import { isInScopeSocialPost } from "./social-formats.ts";
import { rankPostsByPublicMetric } from "./social-ranking.ts";
import { buildSocialAnalysisFromRanked, rankPosts } from "./social-score.ts";

export type HistoryCoverage = {
  platform: SocialPlatform;
  accountUrl: string;
  scope: string;
  status: "complete-public-profile" | "limited" | "unavailable" | string;
  itemCount: number;
  oldestPublishedAt: string | null;
  newestPublishedAt: string | null;
  limitations: string[];
};

export type PublicHistorySnapshot = {
  generatedAt: string;
  coverage: HistoryCoverage[];
  posts: NormalizedPost[];
};

export type PublicHistorySummary = {
  generatedAt: string;
  totalPostCount: number;
  platformCounts: Record<SocialPlatform, number>;
  formatCounts: Partial<Record<SocialPlatform, Record<string, number>>>;
  coverage: HistoryCoverage[];
};

export type PublicHistoryMergeOptions = {
  editorialAnalysis?: "all" | "leaders" | "none";
  accountCounts?: Partial<Record<SocialPlatform, number>>;
};

export type PublicMetricSnapshot = {
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: number | null;
  source: string | null;
};

export type PublishedAtPrecision = "exact" | "approximate" | "unknown";

export type PublicWorkspaceAccount = {
  id: string;
  platform: SocialPlatform;
  handle: string;
  display_name: string;
  profile_url: string;
  external_account_id: string | null;
  source_kind: string;
  coverage_label: string;
  status: "ready" | "limited" | "error" | "idle";
  follower_count: number | null;
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  post_count: number;
  [key: string]: unknown;
};

export type PublicWorkspacePost = {
  id: string;
  account_id: string;
  platform: SocialPlatform;
  external_post_id: string;
  external_id?: string;
  url: string;
  title: string;
  text: string;
  format: string;
  thumbnail_url: string | null;
  published_at: string | null;
  published_at_precision: PublishedAtPrecision;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: number | null;
  performance_score: number | null;
  score_confidence: "high" | "medium" | "low" | "insufficient";
  score_explanation: string;
  analysis_label: string | null;
  source_kind: string;
  first_seen_at: string;
  last_seen_at: string;
  last_metric_at: string;
  metric_history: PublicMetricSnapshot[];
  editorial_analysis?: EditorialWhy;
  [key: string]: unknown;
};

export type PublicWorkspacePayload = {
  mode: "live" | "public-snapshot";
  notice: string;
  generatedAt: string;
  accounts: PublicWorkspaceAccount[];
  posts: PublicWorkspacePost[];
  scans: unknown[];
  analysis: ReturnType<typeof buildSocialAnalysisFromRanked> | null;
  historyCoverage: HistoryCoverage[];
};

type WorkspaceInput = {
  mode?: string;
  notice?: string;
  generatedAt?: string;
  accounts?: Array<Record<string, unknown>>;
  posts?: Array<Record<string, unknown>>;
  scans?: unknown[];
};

const ACCOUNT_META: Record<
  SocialPlatform,
  {
    id: string;
    handle: string;
    profileUrl: string;
    externalAccountId: string | null;
  }
> = {
  youtube: {
    id: "lofigirl-youtube",
    handle: "LofiGirl",
    profileUrl: "https://www.youtube.com/@LofiGirl",
    externalAccountId: "UCSJ4gkVC6NrvII8umztf0Ow",
  },
  instagram: {
    id: "lofigirl-instagram",
    handle: "lofigirl",
    profileUrl: "https://www.instagram.com/lofigirl/",
    externalAccountId: null,
  },
  tiktok: {
    id: "lofigirl-tiktok",
    handle: "lofigirl",
    profileUrl: "https://www.tiktok.com/@lofigirl",
    externalAccountId: null,
  },
  x: {
    id: "lofigirl-x",
    handle: "lofigirl",
    profileUrl: "https://x.com/lofigirl",
    externalAccountId: null,
  },
};

const PLATFORM_ORDER: SocialPlatform[] = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
];

/**
 * Superpose le relevé récent du backend et le backfill public versionné.
 * Les champs récents gagnent lorsqu'ils existent, mais une valeur manquante ne
 * détruit jamais une métrique déjà observée dans le snapshot historique.
 */
export function mergeWorkspaceWithPublicHistory(
  workspace: WorkspaceInput | null | undefined,
  snapshot: PublicHistorySnapshot,
  mode: PublicWorkspacePayload["mode"] = "live",
  options: PublicHistoryMergeOptions = {},
): PublicWorkspacePayload {
  const liveObservedAt = workspace?.generatedAt ?? snapshot.generatedAt;
  const livePosts = (workspace?.posts ?? [])
    .map(normalizedFromWorkspace)
    .filter((post): post is NormalizedPost => post !== null)
    .filter((post) => isInScopeSocialPost(post))
    .map((post) => ensureMetricHistory(post, liveObservedAt, "live-workspace"));
  const merged = new Map<string, NormalizedPost>();

  for (const post of snapshot.posts) {
    if (!isUsablePost(post) || !isInScopeSocialPost(post)) continue;
    merged.set(
      postKey(post),
      sanitizePost(
        ensureMetricHistory(post, snapshot.generatedAt, "public-history-snapshot"),
      ),
    );
  }
  for (const post of livePosts) {
    const key = postKey(post);
    const historical = merged.get(key);
    merged.set(key, historical ? mergePost(historical, post) : post);
  }

  const ranked = rankPosts(
    [...merged.values()],
    workspace?.generatedAt ?? snapshot.generatedAt,
  );
  const editorialMode = options.editorialAnalysis ?? "all";
  const editorialAnalyses =
    editorialMode === "all"
      ? buildEditorialAnalysisMap(ranked)
      : editorialMode === "leaders"
        ? buildEditorialAnalysisMapForTargets(
            ranked,
            publicEditorialLeaderKeys(ranked),
          )
        : new Map<string, EditorialWhy>();
  const liveByKey = new Map(
    (workspace?.posts ?? []).map((post) => [workspacePostKey(post), post]),
  );
  const generatedAt = latestIso(workspace?.generatedAt, snapshot.generatedAt);
  const posts = ranked.map((post) => {
    const live = liveByKey.get(postKey(post));
    const account = ACCOUNT_META[post.platform];
    const editorialAnalysis = editorialAnalyses.get(editorialPostKey(post));
    const metricHistory = metricHistoryFromRaw(post.raw);
    const firstObservedAt =
      rawString(post.raw, "firstObservedAt") ??
      metricHistory.at(0)?.captured_at ??
      snapshot.generatedAt;
    const lastObservedAt =
      rawString(post.raw, "lastObservedAt") ??
      metricHistory.at(-1)?.captured_at ??
      firstObservedAt;
    return {
      ...(live ?? {}),
      id: `${post.platform}:${post.externalId}`,
      account_id: account.id,
      platform: post.platform,
      external_id: post.externalId,
      external_post_id: post.externalId,
      url: post.url,
      title: post.title ?? "",
      text: post.text ?? "",
      format: post.format ?? "Publication",
      thumbnail_url: post.thumbnailUrl,
      published_at: post.publishedAt,
      published_at_precision: publishedAtPrecision(post),
      views: post.views,
      likes: post.likes,
      comments: post.comments,
      shares: post.shares,
      saves: post.saves,
      poll_votes:
        rawNumber(post.raw, "pollVotes") ??
        rawNumber(post.raw, "pollTotalVotes"),
      raw_json: post.raw == null ? null : JSON.stringify(post.raw),
      performance_score: post.performanceScore,
      confidence: post.confidence,
      score_confidence: post.confidence,
      score_explanation: post.scoreExplanation,
      cohort_key: post.cohortKey,
      metric_coverage: JSON.stringify(post.metricCoverage),
      rank: post.rank,
      platform_rank: post.platformRank,
      analysis_label: typeof live?.analysis_label === "string" ? live.analysis_label : null,
      source_kind:
        typeof live?.source_kind === "string"
          ? live.source_kind
          : "public-profile-history",
      first_seen_at:
        typeof live?.first_seen_at === "string" ? live.first_seen_at : firstObservedAt,
      last_seen_at:
        typeof live?.last_seen_at === "string" ? live.last_seen_at : lastObservedAt,
      last_metric_at:
        typeof live?.last_metric_at === "string"
          ? live.last_metric_at
          : metricHistory.at(-1)?.captured_at ?? lastObservedAt,
      metric_history: metricHistory,
      ...(editorialAnalysis ? { editorial_analysis: editorialAnalysis } : {}),
    } satisfies PublicWorkspacePost;
  });

  const coverageByPlatform = new Map(
    snapshot.coverage.map((item) => [item.platform, item]),
  );
  const baseAccounts = new Map(
    (workspace?.accounts ?? [])
      .filter((account) => isPlatform(account.platform))
      .map((account) => [account.platform as SocialPlatform, account]),
  );
  const counts = countByPlatform(posts);
  const accounts = PLATFORM_ORDER.map((platform) => {
    const meta = ACCOUNT_META[platform];
    const existing = baseAccounts.get(platform);
    const coverage = coverageByPlatform.get(platform);
    const count = options.accountCounts?.[platform] ?? counts.get(platform) ?? 0;
    const coverageComplete = coverage?.status.startsWith("complete") ?? false;
    const coverageLabel = coverage
      ? coverageComplete
        ? `${coverage.scope} · ${coverage.itemCount} contenu${coverage.itemCount > 1 ? "s" : ""} énuméré${coverage.itemCount > 1 ? "s" : ""}.`
        : `${coverage.scope}${count > 0 ? ` · ${count} contenu${count > 1 ? "s" : ""} visible${count > 1 ? "s" : ""} dans le relevé récent.` : "."} ${coverage.limitations[0] ?? "Couverture propriétaire requise."}`
      : platform === "instagram"
        ? "Historique non accessible sans connexion du compte professionnel Meta."
        : platform === "x"
          ? `${count} posts publics visibles · l’historique complet requiert l’API ou l’archive du compte.`
          : "Aucun backfill historique disponible.";
    return {
      ...(existing ?? {}),
      id: meta.id,
      platform,
      handle: meta.handle,
      display_name: "Lofi Girl",
      profile_url: meta.profileUrl,
      external_account_id:
        typeof existing?.external_account_id === "string"
          ? existing.external_account_id
          : meta.externalAccountId,
      source_kind: coverage ? "public-profile-history" : "public-profile-limited",
      coverage_label: coverageLabel,
      status:
        coverageComplete ? "ready" : "limited",
      follower_count: numberOrNull(existing?.follower_count),
      last_scan_at: stringOrNull(existing?.last_scan_at) ?? generatedAt,
      last_success_at: count > 0 ? stringOrNull(existing?.last_success_at) ?? generatedAt : null,
      last_error: stringOrNull(existing?.last_error),
      post_count: count,
    } satisfies PublicWorkspaceAccount;
  });

  return {
    mode,
    notice:
      "Historique public des comptes officiels Lofi Girl, limité aux formats éditoriaux demandés. Sur YouTube, seuls les Shorts et posts Communauté sont inclus : les vidéos longues et lives sont exclus. Les limites de collecte des commentaires écrits par le compte restent visibles et aucune métrique manquante n’est inventée.",
    generatedAt,
    accounts,
    posts,
    scans: workspace?.scans ?? [],
    analysis:
      ranked.length > 0
        ? buildSocialAnalysisFromRanked(ranked, generatedAt, editorialAnalyses)
        : null,
    historyCoverage: snapshot.coverage,
  };
}

function publicEditorialLeaderKeys(
  posts: ReturnType<typeof rankPosts>,
): string[] {
  const keys = new Set<string>();
  const cohorts = new Map<string, typeof posts>();
  const platforms = new Set<SocialPlatform>();

  for (const post of posts) {
    if (!platforms.has(post.platform)) {
      platforms.add(post.platform);
      keys.add(editorialPostKey(post));
    }
    const format = (post.format ?? "unknown")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const cohortKey = `${post.platform}:${format}`;
    const cohort = cohorts.get(cohortKey);
    if (cohort) cohort.push(post);
    else cohorts.set(cohortKey, [post]);
  }

  for (const cohort of cohorts.values()) {
    const leaders = rankPostsByPublicMetric(
      cohort.map((post) => {
        const raw = post.raw && typeof post.raw === "object" ? post.raw : null;
        return {
          post,
          external_post_id: post.externalId,
          format: post.format ?? "unknown",
          likes: post.likes,
          views: post.views,
          comments: post.comments,
          shares: post.shares,
          saves: post.saves,
          poll_votes:
            rawNumber(raw, "pollVotes") ?? rawNumber(raw, "pollTotalVotes"),
        };
      }),
    ).posts.slice(0, 4);
    for (const { post } of leaders) keys.add(editorialPostKey(post));
  }

  return [...keys];
}

function normalizedFromWorkspace(
  value: Record<string, unknown>,
): NormalizedPost | null {
  const platform = value.platform;
  const externalId = value.external_post_id ?? value.external_id;
  const url = value.url;
  if (!isPlatform(platform) || typeof externalId !== "string" || typeof url !== "string") {
    return null;
  }
  const raw = rawValue(value.raw_json);
  const workspaceMetricHistory = mergeMetricHistories(
    metricHistoryFromRaw(raw),
    metricHistoryFromUnknown(value.metric_history),
  );
  return {
    platform,
    externalId,
    url,
    title: stringOrNull(value.title),
    text: stringOrNull(value.text),
    format: stringOrNull(value.format),
    thumbnailUrl: stringOrNull(value.thumbnail_url),
    publishedAt: stringOrNull(value.published_at),
    views: numberOrNull(value.views),
    likes: numberOrNull(value.likes),
    comments: numberOrNull(value.comments),
    shares: numberOrNull(value.shares),
    saves: numberOrNull(value.saves),
    raw:
      workspaceMetricHistory.length > 0
        ? {
            ...(raw ?? {}),
            metricHistory: workspaceMetricHistory.map(metricSnapshotToRaw),
          }
        : raw,
  };
}

function sanitizePost(post: NormalizedPost): NormalizedPost {
  return {
    ...post,
    title: stringOrNull(post.title),
    text: stringOrNull(post.text),
    format: stringOrNull(post.format),
    thumbnailUrl: stringOrNull(post.thumbnailUrl),
    publishedAt: stringOrNull(post.publishedAt),
    views: numberOrNull(post.views),
    likes: numberOrNull(post.likes),
    comments: numberOrNull(post.comments),
    shares: numberOrNull(post.shares),
    saves: numberOrNull(post.saves),
    raw: post.raw ?? null,
  };
}

function mergePost(history: NormalizedPost, live: NormalizedPost): NormalizedPost {
  const historyRaw =
    typeof history.raw === "object" && history.raw ? history.raw : {};
  const liveRaw = typeof live.raw === "object" && live.raw ? live.raw : {};
  const metricHistory = mergeMetricHistories(
    metricHistoryFromRaw(historyRaw),
    metricHistoryFromRaw(liveRaw),
  );
  return {
    platform: live.platform,
    externalId: live.externalId,
    url: live.url || history.url,
    title: live.title ?? history.title,
    text: live.text ?? history.text,
    format: live.format ?? history.format,
    thumbnailUrl: live.thumbnailUrl ?? history.thumbnailUrl,
    publishedAt: live.publishedAt ?? history.publishedAt,
    views: live.views ?? history.views,
    likes: live.likes ?? history.likes,
    comments: live.comments ?? history.comments,
    shares: live.shares ?? history.shares,
    saves: live.saves ?? history.saves,
    raw: {
      ...historyRaw,
      ...liveRaw,
      metricHistory: metricHistory.map(metricSnapshotToRaw),
    },
  };
}

function isUsablePost(post: NormalizedPost): boolean {
  return isPlatform(post.platform) && Boolean(post.externalId) && Boolean(post.url);
}

function isPlatform(value: unknown): value is SocialPlatform {
  return PLATFORM_ORDER.includes(value as SocialPlatform);
}

function postKey(post: Pick<NormalizedPost, "platform" | "externalId">): string {
  return `${post.platform}:${post.externalId}`;
}

function workspacePostKey(post: Record<string, unknown>): string {
  return `${String(post.platform ?? "")}:${String(post.external_post_id ?? post.external_id ?? "")}`;
}

function ensureMetricHistory(
  post: NormalizedPost,
  capturedAt: string,
  fallbackSource: string,
): NormalizedPost {
  const raw = typeof post.raw === "object" && post.raw ? post.raw : {};
  const existing = metricHistoryFromRaw(raw);
  if (existing.length > 0) {
    return {
      ...post,
      raw: { ...raw, metricHistory: existing.map(metricSnapshotToRaw) },
    };
  }
  const firstObservation: PublicMetricSnapshot = {
    captured_at: capturedAt,
    views: nonnegativeNumberOrNull(post.views),
    likes: nonnegativeNumberOrNull(post.likes),
    comments: nonnegativeNumberOrNull(post.comments),
    shares: nonnegativeNumberOrNull(post.shares),
    saves: nonnegativeNumberOrNull(post.saves),
    poll_votes:
      rawNumber(raw, "pollVotes") ?? rawNumber(raw, "pollTotalVotes"),
    source: rawString(raw, "collector") ?? fallbackSource,
  };
  return {
    ...post,
    raw: { ...raw, metricHistory: [metricSnapshotToRaw(firstObservation)] },
  };
}

function metricHistoryFromRaw(
  raw: Record<string, unknown> | null,
): PublicMetricSnapshot[] {
  return raw ? metricHistoryFromUnknown(raw.metricHistory) : [];
}

function metricHistoryFromUnknown(value: unknown): PublicMetricSnapshot[] {
  let candidate = value;
  if (typeof value === "string" && value) {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  const parsed = candidate
    .map(metricSnapshotFromUnknown)
    .filter((point): point is PublicMetricSnapshot => point !== null);
  return mergeMetricHistories(parsed);
}

function metricSnapshotFromUnknown(value: unknown): PublicMetricSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  const capturedAt = stringOrNull(point.capturedAt ?? point.captured_at);
  if (!capturedAt) return null;
  return {
    captured_at: capturedAt,
    views: nonnegativeNumberOrNull(point.views),
    likes: nonnegativeNumberOrNull(point.likes),
    comments: nonnegativeNumberOrNull(point.comments),
    shares: nonnegativeNumberOrNull(point.shares),
    saves: nonnegativeNumberOrNull(point.saves),
    poll_votes: nonnegativeNumberOrNull(point.pollVotes ?? point.poll_votes),
    source: stringOrNull(point.source),
  };
}

function mergeMetricHistories(
  ...histories: readonly PublicMetricSnapshot[][]
): PublicMetricSnapshot[] {
  const byCapturedAt = new Map<string, PublicMetricSnapshot>();
  for (const history of histories) {
    for (const point of history) {
      const current = byCapturedAt.get(point.captured_at);
      byCapturedAt.set(point.captured_at, {
        captured_at: point.captured_at,
        views: point.views ?? current?.views ?? null,
        likes: point.likes ?? current?.likes ?? null,
        comments: point.comments ?? current?.comments ?? null,
        shares: point.shares ?? current?.shares ?? null,
        saves: point.saves ?? current?.saves ?? null,
        poll_votes: point.poll_votes ?? current?.poll_votes ?? null,
        source: point.source ?? current?.source ?? null,
      });
    }
  }
  return [...byCapturedAt.values()].sort((left, right) =>
    left.captured_at.localeCompare(right.captured_at),
  );
}

function metricSnapshotToRaw(
  point: PublicMetricSnapshot,
): Record<string, unknown> {
  return {
    capturedAt: point.captured_at,
    views: point.views,
    likes: point.likes,
    comments: point.comments,
    shares: point.shares,
    saves: point.saves,
    pollVotes: point.poll_votes,
    source: point.source,
  };
}

function publishedAtPrecision(post: NormalizedPost): PublishedAtPrecision {
  if (!post.publishedAt) return "unknown";
  const precision = rawString(post.raw, "publishedAtPrecision");
  return precision === "exact" || precision === "approximate"
    ? precision
    : "unknown";
}

function rawValue(value: unknown): NormalizedPost["raw"] {
  if (value && typeof value === "object") return value as NormalizedPost["raw"];
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as NormalizedPost["raw"];
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeNumberOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function rawNumber(
  raw: Record<string, unknown> | null,
  key: string,
): number | null {
  return raw ? numberOrNull(raw[key]) : null;
}

function rawString(
  raw: Record<string, unknown> | null,
  key: string,
): string | null {
  return raw ? stringOrNull(raw[key]) : null;
}

function countByPlatform(posts: readonly PublicWorkspacePost[]): Map<SocialPlatform, number> {
  const counts = new Map<SocialPlatform, number>();
  for (const post of posts) {
    counts.set(post.platform, (counts.get(post.platform) ?? 0) + 1);
  }
  return counts;
}

function latestIso(left: string | undefined, right: string): string {
  if (!left) return right;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
