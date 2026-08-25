export type TrendPlatform = "instagram" | "tiktok" | "youtube" | "x";
export type TrendLifecycle = "new" | "rising" | "peaking" | "steady" | "watch";
export type TrendConfidence = "high" | "medium" | "watch";
export type TrendTone = "complice" | "cozy" | "absurde";
export type TrendCharacter = "lofi-girl" | "lofi-boy";
export type TrendRefreshStatus = "success" | "degraded";

export type TrendSourceCheck = {
  id: string;
  label: string;
  platform: TrendPlatform;
  status: "success" | "failed";
  checkedAt: string;
  candidatesMatched: number;
};

export type TrendRefreshCounts = {
  checkedSources: number;
  matchedSignals: number;
  actionable: number;
  lofiGirl: number;
  lofiBoy: number;
};

export type TrendDiscoverySourceBreakdown = {
  id: string;
  label: string;
  platform: TrendPlatform;
  status: "success" | "failed";
  candidateCount: number;
  matchedTrendIds: string[];
  candidateUrls: string[];
};

export type TrendDiscoveryAudit = {
  scannedAt: string;
  complete: boolean;
  candidateCount: number;
  qualifiedInventoryCount: number;
  currentMatchedCount: number;
  added: number;
  removed: number;
  retained: number;
  candidateUrls: string[];
  matchedTrendIds: string[];
  sourceBreakdown: TrendDiscoverySourceBreakdown[];
  reachabilityCheckedAt: string;
  availablePosts: number;
  unavailablePosts: number;
  unavailablePostUrls: string[];
};

export type TrendRefreshMetadata = {
  cadenceHours: 24;
  lastAttemptAt: string;
  lastSuccessfulAt: string;
  nextScheduledAt: string;
  status: TrendRefreshStatus;
  runId: string | null;
  runUrl: string | null;
  sourceChecks: TrendSourceCheck[];
  counts: TrendRefreshCounts;
  discoveryAudit?: TrendDiscoveryAudit;
};

export type TrendObservation = {
  id: string;
  platform: TrendPlatform;
  sourceLabel: string;
  sourceUrl: string;
  observedAt: string;
  windowLabel: string;
  signal: string;
  rank: number | null;
  posts: number | null;
  views: number | null;
  uses: number | null;
  exactness: "exact" | "platform-estimate" | "editorial-observation";
};

export type TrendProposal = {
  tone: TrendTone;
  label: string;
  title: string;
  concept: string;
  copy: string;
};

export type TrendReferencePost = {
  platform: TrendPlatform;
  author: string | null;
  caption: string;
  url: string;
  mediaType: "image" | "video" | "text" | "unknown";
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  capturedAt: string;
  selectionLabel: string;
  sourceLabel: string;
  sourceUrl: string;
  exactness: TrendObservation["exactness"];
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
};

export type TrendReusePost = {
  platform: TrendPlatform;
  author: string;
  url: string;
  capturedAt: string;
};

export type TrendReuseEvidence = {
  verifiedAt: string;
  minimumDistinctCreators: 3;
  summary: string;
  posts: TrendReusePost[];
};

export type SocialTrend = {
  id: string;
  trendKey: string;
  clusterKey: string;
  title: string;
  character: TrendCharacter;
  territory: string;
  firstSeenAt: string;
  lastVerifiedAt: string;
  type: "hashtag" | "sound" | "spoken-audio" | "meme-template" | "format" | "moment";
  summary: string;
  mechanic: string;
  platforms: TrendPlatform[];
  keywords: string[];
  lifecycle: TrendLifecycle;
  confidence: TrendConfidence;
  momentumScore: number;
  lofiFitScore: number;
  saturationRisk: number;
  whyLofi: string;
  timing: string;
  production: string;
  caveat: string;
  referencePost: TrendReferencePost | null;
  reuseEvidence: TrendReuseEvidence | null;
  observations: TrendObservation[];
  proposals: TrendProposal[];
};

export type SocialTrendFeed = {
  version: 6;
  capturedAt: string;
  refresh: TrendRefreshMetadata;
  market: string;
  methodology: string;
  trends: SocialTrend[];
};

const CONFIDENCE_WEIGHT: Record<TrendConfidence, number> = {
  high: 100,
  medium: 76,
  watch: 52,
};

export const TREND_PRIORITY_THRESHOLD = 90;
export const MIN_TREND_VIDEO_LIKES = 50_000;
export const MAX_TREND_VIDEO_DURATION_SECONDS = 30;
export const MIN_ACTIONABLE_TREND_LOFI_FIT = 85;
export const TREND_REFRESH_CADENCE_HOURS = 24;
export const TREND_PUBLISH_MAX_AGE_HOURS = 26;
export const TREND_ACTIVE_MAX_VERIFICATION_AGE_HOURS = 72;
export const TREND_STEADY_MAX_VERIFICATION_AGE_HOURS = 14 * 24;
export const MIN_TREND_DISCOVERY_PARSED_SOURCES = 3;
export const MIN_TREND_DISCOVERY_CANDIDATE_URLS = 50;
export const MIN_PUBLISHABLE_ACTIONABLE_TRENDS = 50;
export const MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS = 50;
export const MIN_PUBLISHABLE_VIDEO_PROPOSALS = 100;
export const MIN_PUBLISHABLE_LOFI_GIRL_SHARE = 0.8;
export const MIN_TREND_DISTINCT_CREATORS = 3;

const HOUR_IN_MILLISECONDS = 60 * 60 * 1_000;

export function hasValidTrendReferenceDuration(referencePost: TrendReferencePost) {
  if (referencePost.mediaType !== "video") {
    return referencePost.durationSeconds === null;
  }
  return (
    referencePost.durationSeconds !== null &&
    Number.isFinite(referencePost.durationSeconds) &&
    referencePost.durationSeconds > 0 &&
    referencePost.durationSeconds < MAX_TREND_VIDEO_DURATION_SECONDS
  );
}

export function isQualifiedTrendReferencePost(
  referencePost: TrendReferencePost | null,
) {
  if (!referencePost || !hasValidTrendReferenceDuration(referencePost)) return false;
  if (referencePost.mediaType === "unknown") return false;
  if (referencePost.mediaType !== "video") return true;
  return (
    referencePost.metrics.likes !== null &&
    referencePost.metrics.likes >= MIN_TREND_VIDEO_LIKES
  );
}

type NativeTrendPost = Pick<TrendReusePost, "platform" | "url">;

function canonicalNativePostIdentity(post: NativeTrendPost) {
  const url = new URL(post.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const nativeId = post.platform === "instagram"
    ? segments[1]
    : post.platform === "tiktok"
      ? segments.at(-1)
      : post.platform === "youtube"
        ? segments[1]
        : segments.at(-1);
  return `${post.platform}:${nativeId}`;
}

function normalizeTrendCreator(author: string) {
  return author
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fr");
}

function isNativePostUrlForPlatform(candidate: string, platform: TrendPlatform) {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:") return false;
    if (platform === "instagram") {
      return (host === "instagram.com" || host.endsWith(".instagram.com")) &&
        /^\/(?:p|reel)\/[^/]+$/i.test(path);
    }
    if (platform === "tiktok") {
      return (host === "tiktok.com" || host.endsWith(".tiktok.com")) &&
        /^\/@[^/]+\/video\/\d{12,24}$/i.test(path);
    }
    if (platform === "youtube") {
      return (host === "youtube.com" || host.endsWith(".youtube.com")) &&
        /^\/shorts\/[A-Za-z0-9_-]{11}$/i.test(path);
    }
    return (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) &&
      /^\/[^/]+\/status\/\d+$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * A single viral post is not a trend. This proof requires at least three
 * distinct creators and three distinct native posts, including the card's
 * reference post exactly once.
 */
export function isVerifiedMultiCreatorTrend(trend: SocialTrend) {
  const evidence = trend.reuseEvidence;
  const referencePost = trend.referencePost;
  if (
    !evidence ||
    !referencePost ||
    typeof referencePost.author !== "string" ||
    !normalizeTrendCreator(referencePost.author) ||
    !trend.platforms.includes(referencePost.platform) ||
    !isNativePostUrlForPlatform(referencePost.url, referencePost.platform) ||
    evidence.minimumDistinctCreators !== MIN_TREND_DISTINCT_CREATORS ||
    typeof evidence.summary !== "string" ||
    !evidence.summary.trim() ||
    !Array.isArray(evidence.posts) ||
    evidence.posts.length < MIN_TREND_DISTINCT_CREATORS
  ) {
    return false;
  }

  const firstSeenTimestamp = Date.parse(trend.firstSeenAt);
  const lastVerifiedTimestamp = Date.parse(trend.lastVerifiedAt);
  const evidenceVerifiedTimestamp = Date.parse(evidence.verifiedAt);
  if (
    !Number.isFinite(firstSeenTimestamp) ||
    !Number.isFinite(lastVerifiedTimestamp) ||
    !Number.isFinite(evidenceVerifiedTimestamp) ||
    evidenceVerifiedTimestamp < firstSeenTimestamp ||
    evidenceVerifiedTimestamp > lastVerifiedTimestamp
  ) {
    return false;
  }

  const referenceIdentity = canonicalNativePostIdentity(referencePost);
  const referenceAuthor = normalizeTrendCreator(referencePost.author);
  const nativePosts = new Set<string>();
  const creators = new Set<string>();
  let referenceMatches = 0;

  for (const post of evidence.posts) {
    if (
      !post ||
      typeof post.author !== "string" ||
      !normalizeTrendCreator(post.author) ||
      !trend.platforms.includes(post.platform) ||
      !isNativePostUrlForPlatform(post.url, post.platform)
    ) {
      return false;
    }
    const capturedTimestamp = Date.parse(post.capturedAt);
    if (
      !Number.isFinite(capturedTimestamp) ||
      capturedTimestamp < firstSeenTimestamp ||
      capturedTimestamp > evidenceVerifiedTimestamp
    ) {
      return false;
    }
    const identity = canonicalNativePostIdentity(post);
    if (nativePosts.has(identity)) return false;
    nativePosts.add(identity);
    const creator = normalizeTrendCreator(post.author);
    creators.add(creator);
    if (identity === referenceIdentity) {
      if (creator !== referenceAuthor) return false;
      referenceMatches += 1;
    }
  }

  return (
    referenceMatches === 1 &&
    nativePosts.size >= MIN_TREND_DISTINCT_CREATORS &&
    creators.size >= MIN_TREND_DISTINCT_CREATORS
  );
}

export function isActionableSocialTrend(trend: SocialTrend) {
  return (
    trend.lifecycle !== "watch" &&
    trend.lofiFitScore >= MIN_ACTIONABLE_TREND_LOFI_FIT &&
    isQualifiedTrendReferencePost(trend.referencePost) &&
    isVerifiedMultiCreatorTrend(trend)
  );
}

export function trendPriorityScore(trend: SocialTrend) {
  const saturationPenalty = Math.max(0, trend.saturationRisk - 55) * 0.16;
  return Math.max(
    0,
    Math.min(
      99,
      Math.round(
        trend.lofiFitScore * 0.65 +
          trend.momentumScore * 0.2 +
          CONFIDENCE_WEIGHT[trend.confidence] * 0.15 -
          saturationPenalty,
      ),
    ),
  );
}

export function rankSocialTrends(trends: readonly SocialTrend[]) {
  return [...trends].sort((left, right) => {
    const scoreDelta = trendPriorityScore(right) - trendPriorityScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    if (right.lofiFitScore !== left.lofiFitScore) {
      return right.lofiFitScore - left.lofiFitScore;
    }
    return left.title.localeCompare(right.title, "fr");
  });
}

/**
 * Selects a Lofi Girl-led feed without changing any trend priority score.
 * Each universe keeps its own score order; Lofi Boy is capped at 20% and
 * interleaved after groups of four Lofi Girl trends when enough data exists.
 */
export function selectGirlFirstSocialTrends(
  trends: readonly SocialTrend[],
  limit = MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
) {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0;
  const targetSize = Math.min(normalizedLimit, trends.length);
  if (targetSize === 0) return [];

  const ranked = rankSocialTrends(trends);
  const girls = ranked.filter((trend) => trend.character === "lofi-girl");
  const boys = ranked.filter((trend) => trend.character === "lofi-boy");
  const minimumGirlCount = Math.ceil(
    targetSize * MIN_PUBLISHABLE_LOFI_GIRL_SHARE,
  );
  const maximumBoyCount = targetSize - minimumGirlCount;
  const selectedBoyCount = Math.min(boys.length, maximumBoyCount);
  const selectedGirlCount = Math.min(
    girls.length,
    targetSize - selectedBoyCount,
  );
  const selectedGirls = girls.slice(0, selectedGirlCount);
  const selectedBoys = boys.slice(0, selectedBoyCount);

  let remaining = targetSize - selectedGirls.length - selectedBoys.length;
  if (remaining > 0) {
    const extraGirls = girls.slice(selectedGirls.length, selectedGirls.length + remaining);
    selectedGirls.push(...extraGirls);
    remaining -= extraGirls.length;
  }
  if (remaining > 0) {
    selectedBoys.push(
      ...boys.slice(selectedBoys.length, selectedBoys.length + remaining),
    );
  }

  const selected: SocialTrend[] = [];
  let girlIndex = 0;
  let boyIndex = 0;
  while (
    girlIndex < selectedGirls.length ||
    boyIndex < selectedBoys.length
  ) {
    for (let index = 0; index < 4 && girlIndex < selectedGirls.length; index += 1) {
      selected.push(selectedGirls[girlIndex]);
      girlIndex += 1;
    }
    if (boyIndex < selectedBoys.length) {
      selected.push(selectedBoys[boyIndex]);
      boyIndex += 1;
    }
    if (girlIndex >= selectedGirls.length) {
      while (boyIndex < selectedBoys.length) {
        selected.push(selectedBoys[boyIndex]);
        boyIndex += 1;
      }
    }
  }

  return selected.slice(0, targetSize);
}

export function filterSocialTrends(
  trends: readonly SocialTrend[],
  options: {
    platform?: TrendPlatform | "all";
    lifecycle?: TrendLifecycle | "all" | "priority";
    character?: TrendCharacter | "all";
  } = {},
) {
  const platform = options.platform ?? "all";
  const lifecycle = options.lifecycle ?? "all";
  const character = options.character ?? "all";
  return rankSocialTrends(
    trends.filter((trend) => {
      if (platform !== "all" && !trend.platforms.includes(platform)) return false;
      if (character !== "all" && trend.character !== character) return false;
      if (lifecycle === "priority") {
        return trendPriorityScore(trend) >= TREND_PRIORITY_THRESHOLD;
      }
      if (lifecycle !== "all" && trend.lifecycle !== lifecycle) return false;
      return true;
    }),
  );
}

type PublishableTrendFeedOptions = {
  now?: Date | string | number;
  allowStaleSemanticEvidence?: boolean;
};

function canonicalReferenceIdentity(referencePost: TrendReferencePost) {
  return canonicalNativePostIdentity(referencePost);
}

function resolveNowTimestamp(now: PublishableTrendFeedOptions["now"]) {
  const timestamp = now === undefined
    ? Date.now()
    : now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Date de contrÃ´le du feed Trends invalide.");
  }
  return timestamp;
}

export function assertSocialTrendFeed(value: unknown): SocialTrendFeed {
  if (!value || typeof value !== "object") {
    throw new Error("Snapshot Trends invalide.");
  }
  const feed = value as SocialTrendFeed;
  const isText = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0;
  const isScore = (candidate: unknown): candidate is number =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0 &&
    candidate <= 100;
  const isWebUrl = (candidate: unknown) => {
    if (!isText(candidate)) return false;
    try {
      const url = new URL(candidate);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  };
  const validPlatforms = new Set<TrendPlatform>(["instagram", "tiktok", "youtube", "x"]);
  const validCharacters = new Set<TrendCharacter>(["lofi-girl", "lofi-boy"]);
  const validLifecycles = new Set<TrendLifecycle>(["new", "rising", "peaking", "steady", "watch"]);
  const validConfidences = new Set<TrendConfidence>(["high", "medium", "watch"]);
  const validTypes = new Set<SocialTrend["type"]>([
    "hashtag",
    "sound",
    "spoken-audio",
    "meme-template",
    "format",
    "moment",
  ]);
  const validExactness = new Set<TrendObservation["exactness"]>([
    "exact",
    "platform-estimate",
    "editorial-observation",
  ]);
  const validMediaTypes = new Set<TrendReferencePost["mediaType"]>([
    "image",
    "video",
    "text",
    "unknown",
  ]);
  const validRefreshStatuses = new Set<TrendRefreshStatus>([
    "success",
    "degraded",
  ]);
  const isNullableMetric = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
  const capturedTimestamp = typeof feed?.capturedAt === "string"
    ? Date.parse(feed.capturedAt)
    : Number.NaN;
  const refresh = feed?.refresh;
  if (
    feed?.version !== 6 ||
    !isText(feed.capturedAt) ||
    !Number.isFinite(capturedTimestamp) ||
    !refresh ||
    refresh.cadenceHours !== TREND_REFRESH_CADENCE_HOURS ||
    !isText(refresh.lastAttemptAt) ||
    !Number.isFinite(Date.parse(refresh.lastAttemptAt)) ||
    !isText(refresh.lastSuccessfulAt) ||
    !Number.isFinite(Date.parse(refresh.lastSuccessfulAt)) ||
    !isText(refresh.nextScheduledAt) ||
    !Number.isFinite(Date.parse(refresh.nextScheduledAt)) ||
    !validRefreshStatuses.has(refresh.status) ||
    (refresh.runId !== null && !isText(refresh.runId)) ||
    (refresh.runUrl !== null && !isWebUrl(refresh.runUrl)) ||
    !Array.isArray(refresh.sourceChecks) ||
    refresh.sourceChecks.length === 0 ||
    !refresh.counts ||
    !isText(feed.market) ||
    !isText(feed.methodology) ||
    !Array.isArray(feed.trends)
  ) {
    throw new Error("Snapshot Trends invalide.");
  }
  const lastAttemptTimestamp = Date.parse(refresh.lastAttemptAt);
  const lastSuccessfulTimestamp = Date.parse(refresh.lastSuccessfulAt);
  const nextScheduledTimestamp = Date.parse(refresh.nextScheduledAt);
  if (
    lastSuccessfulTimestamp > lastAttemptTimestamp ||
    lastAttemptTimestamp > capturedTimestamp ||
    nextScheduledTimestamp <= capturedTimestamp ||
    nextScheduledTimestamp - lastAttemptTimestamp >
      TREND_PUBLISH_MAX_AGE_HOURS * HOUR_IN_MILLISECONDS
  ) {
    throw new Error("MÃ©tadonnÃ©es de rafraÃ®chissement Trends incohÃ©rentes.");
  }
  const sourceCheckIds = new Set<string>();
  for (const check of refresh.sourceChecks) {
    const checkedTimestamp = typeof check?.checkedAt === "string"
      ? Date.parse(check.checkedAt)
      : Number.NaN;
    if (
      !check ||
      !isText(check.id) ||
      sourceCheckIds.has(check.id) ||
      !isText(check.label) ||
      !validPlatforms.has(check.platform) ||
      !["success", "failed"].includes(check.status) ||
      !isText(check.checkedAt) ||
      !Number.isFinite(checkedTimestamp) ||
      checkedTimestamp < lastAttemptTimestamp ||
      checkedTimestamp > capturedTimestamp ||
      !Number.isInteger(check.candidatesMatched) ||
      check.candidatesMatched < 0
    ) {
      throw new Error(`ContrÃ´le de source Trends invalide : ${check?.id ?? "inconnu"}`);
    }
    sourceCheckIds.add(check.id);
  }
  const refreshCountValues = [
    refresh.counts.checkedSources,
    refresh.counts.matchedSignals,
    refresh.counts.actionable,
    refresh.counts.lofiGirl,
    refresh.counts.lofiBoy,
  ];
  if (
    refreshCountValues.some((count) => !Number.isInteger(count) || count < 0) ||
    refresh.counts.checkedSources !== refresh.sourceChecks.filter(
      (check) => check.status === "success",
    ).length ||
    refresh.counts.matchedSignals !== refresh.sourceChecks.reduce(
      (total, check) =>
        check.status === "success" ? total + check.candidatesMatched : total,
      0,
    )
  ) {
    throw new Error("Compteurs de rafraÃ®chissement Trends incohÃ©rents.");
  }
  const discoveryAudit = refresh.discoveryAudit;
  if (discoveryAudit !== undefined) {
    const scannedTimestamp = typeof discoveryAudit?.scannedAt === "string"
      ? Date.parse(discoveryAudit.scannedAt)
      : Number.NaN;
    const reachabilityTimestamp = typeof discoveryAudit?.reachabilityCheckedAt === "string"
      ? Date.parse(discoveryAudit.reachabilityCheckedAt)
      : Number.NaN;
    const integerFields = [
      discoveryAudit?.candidateCount,
      discoveryAudit?.qualifiedInventoryCount,
      discoveryAudit?.currentMatchedCount,
      discoveryAudit?.added,
      discoveryAudit?.removed,
      discoveryAudit?.retained,
      discoveryAudit?.availablePosts,
      discoveryAudit?.unavailablePosts,
    ];
    if (
      !discoveryAudit ||
      !isText(discoveryAudit.scannedAt) ||
      !Number.isFinite(scannedTimestamp) ||
      typeof discoveryAudit.complete !== "boolean" ||
      scannedTimestamp < lastAttemptTimestamp ||
      scannedTimestamp > capturedTimestamp ||
      !isText(discoveryAudit.reachabilityCheckedAt) ||
      !Number.isFinite(reachabilityTimestamp) ||
      reachabilityTimestamp < lastAttemptTimestamp ||
      reachabilityTimestamp > capturedTimestamp ||
      integerFields.some((count) => !Number.isInteger(count) || count < 0) ||
      discoveryAudit.qualifiedInventoryCount > refresh.counts.actionable ||
      discoveryAudit.currentMatchedCount > refresh.counts.actionable ||
      discoveryAudit.added + discoveryAudit.retained !== discoveryAudit.candidateCount ||
      !Array.isArray(discoveryAudit.candidateUrls) ||
      discoveryAudit.candidateUrls.length > discoveryAudit.candidateCount ||
      new Set(discoveryAudit.candidateUrls).size !== discoveryAudit.candidateUrls.length ||
      discoveryAudit.candidateUrls.some((url) => !isWebUrl(url)) ||
      !Array.isArray(discoveryAudit.matchedTrendIds) ||
      discoveryAudit.matchedTrendIds.length !== discoveryAudit.currentMatchedCount ||
      new Set(discoveryAudit.matchedTrendIds).size !== discoveryAudit.matchedTrendIds.length ||
      discoveryAudit.matchedTrendIds.some((id) => !isText(id)) ||
      !Array.isArray(discoveryAudit.unavailablePostUrls) ||
      discoveryAudit.unavailablePostUrls.length > discoveryAudit.unavailablePosts ||
      discoveryAudit.unavailablePostUrls.some((url) => !isWebUrl(url)) ||
      !Array.isArray(discoveryAudit.sourceBreakdown) ||
      discoveryAudit.sourceBreakdown.length !== refresh.sourceChecks.length
    ) {
      throw new Error("Audit de découverte Trends invalide.");
    }
    const breakdownIds = new Set<string>();
    for (const source of discoveryAudit.sourceBreakdown) {
      if (
        !source ||
        !isText(source.id) ||
        breakdownIds.has(source.id) ||
        !sourceCheckIds.has(source.id) ||
        !isText(source.label) ||
        !validPlatforms.has(source.platform) ||
        !["success", "failed"].includes(source.status) ||
        !Number.isInteger(source.candidateCount) ||
        source.candidateCount < 0 ||
        !Array.isArray(source.candidateUrls) ||
        source.candidateUrls.length > source.candidateCount ||
        new Set(source.candidateUrls).size !== source.candidateUrls.length ||
        source.candidateUrls.some((url) => !isWebUrl(url)) ||
        !Array.isArray(source.matchedTrendIds) ||
        new Set(source.matchedTrendIds).size !== source.matchedTrendIds.length ||
        source.matchedTrendIds.some((id) => !isText(id))
      ) {
        throw new Error(`Source d'audit Trends invalide : ${source?.id ?? "inconnue"}.`);
      }
      breakdownIds.add(source.id);
    }
  }
  const ids = new Set<string>();
  const trendKeys = new Set<string>();
  const observationIds = new Set<string>();
  for (const trend of feed.trends) {
    if (!trend || typeof trend !== "object") {
      throw new Error("Trend incomplète ou invalide.");
    }
    if (!trend.id || ids.has(trend.id)) throw new Error(`Trend dupliquée : ${trend.id}`);
    ids.add(trend.id);
    const normalizedTrendKey = trend.trendKey?.trim().toLocaleLowerCase("fr");
    if (!normalizedTrendKey || trendKeys.has(normalizedTrendKey)) {
      throw new Error(`ClÃ© de trend dupliquÃ©e ou invalide : ${trend.trendKey ?? trend.id}`);
    }
    trendKeys.add(normalizedTrendKey);
    const firstSeenTimestamp = typeof trend.firstSeenAt === "string"
      ? Date.parse(trend.firstSeenAt)
      : Number.NaN;
    const lastVerifiedTimestamp = typeof trend.lastVerifiedAt === "string"
      ? Date.parse(trend.lastVerifiedAt)
      : Number.NaN;
    if (
      !isText(trend.trendKey) ||
      !isText(trend.clusterKey) ||
      !isText(trend.title) ||
      !validCharacters.has(trend.character) ||
      !isText(trend.territory) ||
      !isText(trend.firstSeenAt) ||
      !Number.isFinite(firstSeenTimestamp) ||
      !isText(trend.lastVerifiedAt) ||
      !Number.isFinite(lastVerifiedTimestamp) ||
      firstSeenTimestamp > lastVerifiedTimestamp ||
      lastVerifiedTimestamp > capturedTimestamp ||
      !validTypes.has(trend.type) ||
      !isText(trend.summary) ||
      !isText(trend.mechanic) ||
      !Array.isArray(trend.platforms) ||
      !trend.platforms.length ||
      trend.platforms.some((platform) => !validPlatforms.has(platform)) ||
      !Array.isArray(trend.keywords) ||
      trend.keywords.some((keyword) => !isText(keyword)) ||
      !validLifecycles.has(trend.lifecycle) ||
      !validConfidences.has(trend.confidence) ||
      !isScore(trend.momentumScore) ||
      !isScore(trend.lofiFitScore) ||
      !isScore(trend.saturationRisk) ||
      !isText(trend.whyLofi) ||
      !isText(trend.timing) ||
      !isText(trend.production) ||
      !isText(trend.caveat) ||
      !Object.prototype.hasOwnProperty.call(trend, "referencePost") ||
      !Object.prototype.hasOwnProperty.call(trend, "reuseEvidence")
    ) {
      throw new Error(`Trend incomplète ou invalide : ${trend.id}`);
    }
    const referencePost = trend.referencePost;
    if (referencePost !== null) {
      if (!referencePost || typeof referencePost !== "object") {
        throw new Error(`Post de référence invalide : ${trend.id}`);
      }
      const metrics = referencePost.metrics;
      if (
        !validPlatforms.has(referencePost.platform) ||
        !trend.platforms.includes(referencePost.platform) ||
        (referencePost.author !== null && !isText(referencePost.author)) ||
        !isText(referencePost.caption) ||
        !isNativePostUrlForPlatform(referencePost.url, referencePost.platform) ||
        !validMediaTypes.has(referencePost.mediaType) ||
        !hasValidTrendReferenceDuration(referencePost) ||
        (referencePost.thumbnailUrl !== null && !isWebUrl(referencePost.thumbnailUrl)) ||
        (referencePost.publishedAt !== null &&
          (!isText(referencePost.publishedAt) ||
            !Number.isFinite(Date.parse(referencePost.publishedAt)) ||
            Date.parse(referencePost.publishedAt) > capturedTimestamp)) ||
        !isText(referencePost.capturedAt) ||
        !Number.isFinite(Date.parse(referencePost.capturedAt)) ||
        Date.parse(referencePost.capturedAt) < firstSeenTimestamp ||
        Date.parse(referencePost.capturedAt) > lastVerifiedTimestamp ||
        !isText(referencePost.selectionLabel) ||
        !isText(referencePost.sourceLabel) ||
        !isWebUrl(referencePost.sourceUrl) ||
        !validExactness.has(referencePost.exactness) ||
        !metrics ||
        !isNullableMetric(metrics.views) ||
        !isNullableMetric(metrics.likes) ||
        !isNullableMetric(metrics.comments) ||
        !isNullableMetric(metrics.shares) ||
        (referencePost.mediaType === "video" &&
          (metrics.likes === null || metrics.likes < MIN_TREND_VIDEO_LIKES)) ||
        (referencePost.exactness === "editorial-observation" &&
          [metrics.views, metrics.likes, metrics.comments, metrics.shares].some((metric) => metric !== null))
      ) {
        throw new Error(`Post de référence invalide : ${trend.id}`);
      }
    }
    const reuseEvidence = trend.reuseEvidence;
    if (reuseEvidence !== null) {
      const verifiedTimestamp = typeof reuseEvidence?.verifiedAt === "string"
        ? Date.parse(reuseEvidence.verifiedAt)
        : Number.NaN;
      if (
        !reuseEvidence ||
        typeof reuseEvidence !== "object" ||
        reuseEvidence.minimumDistinctCreators !== MIN_TREND_DISTINCT_CREATORS ||
        !isText(reuseEvidence.summary) ||
        !isText(reuseEvidence.verifiedAt) ||
        !Number.isFinite(verifiedTimestamp) ||
        verifiedTimestamp < firstSeenTimestamp ||
        verifiedTimestamp > lastVerifiedTimestamp ||
        !Array.isArray(reuseEvidence.posts) ||
        reuseEvidence.posts.length < MIN_TREND_DISTINCT_CREATORS
      ) {
        throw new Error(`Preuve multi-créateurs invalide : ${trend.id}`);
      }
      for (const post of reuseEvidence.posts) {
        const capturedTimestamp = typeof post?.capturedAt === "string"
          ? Date.parse(post.capturedAt)
          : Number.NaN;
        if (
          !post ||
          typeof post !== "object" ||
          !validPlatforms.has(post.platform) ||
          !trend.platforms.includes(post.platform) ||
          !isText(post.author) ||
          !isNativePostUrlForPlatform(post.url, post.platform) ||
          !isText(post.capturedAt) ||
          !Number.isFinite(capturedTimestamp) ||
          capturedTimestamp < firstSeenTimestamp ||
          capturedTimestamp > verifiedTimestamp
        ) {
          throw new Error(`Post de reprise invalide : ${trend.id}`);
        }
      }
      if (!isVerifiedMultiCreatorTrend(trend)) {
        throw new Error(`Preuve multi-créateurs insuffisante : ${trend.id}`);
      }
    }
    if (!Array.isArray(trend.observations) || !trend.observations.length) {
      throw new Error(`Trend sans source : ${trend.id}`);
    }
    if (!Array.isArray(trend.proposals)) throw new Error(`Propositions absentes : ${trend.id}`);
    if (trend.proposals.length !== 3) throw new Error(`Trois tons requis : ${trend.id}`);
    const tones = new Set(trend.proposals.map((proposal) => proposal.tone));
    if (tones.size !== 3 || !tones.has("complice") || !tones.has("cozy") || !tones.has("absurde")) {
      throw new Error(`Tons incomplets : ${trend.id}`);
    }
    for (const proposal of trend.proposals) {
      if (
        !isText(proposal.label) ||
        !isText(proposal.title) ||
        !isText(proposal.concept) ||
        !isText(proposal.copy)
      ) {
        throw new Error(`Proposition incomplète : ${trend.id}`);
      }
    }
    for (const observation of trend.observations) {
      if (
        !isText(observation.id) ||
        observationIds.has(observation.id) ||
        !validPlatforms.has(observation.platform) ||
        !isText(observation.sourceLabel) ||
        !isWebUrl(observation.sourceUrl) ||
        !isText(observation.observedAt) ||
        !Number.isFinite(Date.parse(observation.observedAt)) ||
        Date.parse(observation.observedAt) < firstSeenTimestamp ||
        Date.parse(observation.observedAt) > lastVerifiedTimestamp ||
        !isText(observation.windowLabel) ||
        !isText(observation.signal) ||
        !validExactness.has(observation.exactness)
      ) {
        throw new Error(`Observation invalide : ${trend.id}`);
      }
      observationIds.add(observation.id);
      for (const metric of [observation.rank, observation.posts, observation.views, observation.uses]) {
        if (metric !== null && (!Number.isFinite(metric) || metric < 0)) {
          throw new Error(`Métrique invalide : ${trend.id}`);
        }
      }
    }
  }
  if (
    discoveryAudit &&
    (
      discoveryAudit.matchedTrendIds.some((id) => !ids.has(id)) ||
      discoveryAudit.sourceBreakdown.some((source) =>
        source.matchedTrendIds.some((id) => !ids.has(id)))
    )
  ) {
    throw new Error("Audit de découverte Trends lié à une trend inconnue.");
  }
  const actionable = feed.trends.filter(isActionableSocialTrend);
  const lofiGirlCount = actionable.filter(
    (trend) => trend.character === "lofi-girl",
  ).length;
  const lofiBoyCount = actionable.length - lofiGirlCount;
  if (
    refresh.counts.actionable !== actionable.length ||
    refresh.counts.lofiGirl !== lofiGirlCount ||
    refresh.counts.lofiBoy !== lofiBoyCount ||
    refresh.counts.lofiGirl + refresh.counts.lofiBoy !==
      refresh.counts.actionable
  ) {
    throw new Error("Compteurs de tendances exploitables incohÃ©rents.");
  }
  return feed;
}

export function hasCompleteTrendDiscoveryAudit(
  feed: SocialTrendFeed,
  now: Date | string | number = Date.now(),
) {
  const audit = feed.refresh.discoveryAudit;
  if (!audit || feed.refresh.status !== "success") return false;
  const nowTimestamp = resolveNowTimestamp(now);
  const scannedTimestamp = Date.parse(audit.scannedAt);
  const maximumAge = TREND_PUBLISH_MAX_AGE_HOURS * HOUR_IN_MILLISECONDS;
  return (
    audit.complete === true &&
    audit.scannedAt === feed.capturedAt &&
    audit.scannedAt === feed.refresh.lastAttemptAt &&
    audit.reachabilityCheckedAt === audit.scannedAt &&
    scannedTimestamp <= nowTimestamp &&
    nowTimestamp - scannedTimestamp <= maximumAge &&
    audit.candidateCount >= MIN_TREND_DISCOVERY_CANDIDATE_URLS &&
    audit.candidateUrls.length >= MIN_TREND_DISCOVERY_CANDIDATE_URLS &&
    audit.qualifiedInventoryCount >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS &&
    audit.sourceBreakdown.filter((source) => source.status === "success").length >=
      MIN_TREND_DISCOVERY_PARSED_SOURCES
  );
}

export function assertPublishableSocialTrendFeed(
  value: unknown,
  options: PublishableTrendFeedOptions = {},
) {
  const feed = assertSocialTrendFeed(value);
  const nowTimestamp = resolveNowTimestamp(options.now);
  const capturedTimestamp = Date.parse(feed.capturedAt);
  const lastAttemptTimestamp = Date.parse(feed.refresh.lastAttemptAt);
  const lastSuccessfulTimestamp = Date.parse(feed.refresh.lastSuccessfulAt);
  const maximumAge = TREND_PUBLISH_MAX_AGE_HOURS * HOUR_IN_MILLISECONDS;
  const completeDiscoveryAudit = hasCompleteTrendDiscoveryAudit(feed, nowTimestamp);
  if (options.allowStaleSemanticEvidence && !completeDiscoveryAudit) {
    throw new Error(
      "Un scan éditorial complet est requis pour dissocier la fraîcheur du feed de ses preuves immuables.",
    );
  }

  if (
    capturedTimestamp > nowTimestamp ||
    lastAttemptTimestamp > nowTimestamp ||
    lastSuccessfulTimestamp > nowTimestamp
  ) {
    throw new Error("Le feed Trends contient une date future.");
  }
  if (
    nowTimestamp - capturedTimestamp > maximumAge ||
    nowTimestamp - lastAttemptTimestamp > maximumAge ||
    nowTimestamp - lastSuccessfulTimestamp > maximumAge
  ) {
    throw new Error(
      `Le snapshot Trends dÃ©passe la fraÃ®cheur maximale de ${TREND_PUBLISH_MAX_AGE_HOURS} h.`,
    );
  }
  if (feed.refresh.status !== "success") {
    throw new Error("Le dernier rafraÃ®chissement Trends n'est pas complet.");
  }

  const actionable = feed.trends.filter(isActionableSocialTrend);
  if (actionable.length < MIN_PUBLISHABLE_ACTIONABLE_TRENDS) {
    throw new Error(
      `Au moins ${MIN_PUBLISHABLE_ACTIONABLE_TRENDS} trends exploitables sont requises.`,
    );
  }
  const actionableVideos = actionable.filter(
    (trend) => trend.referencePost?.mediaType === "video",
  );
  if (actionableVideos.length < MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS) {
    throw new Error(
      `Au moins ${MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS} trends vidéo exploitables et distinctes sont requises.`,
    );
  }
  const videoProposalCount = actionableVideos
    .reduce((total, trend) => total + trend.proposals.length, 0);
  if (videoProposalCount < MIN_PUBLISHABLE_VIDEO_PROPOSALS) {
    throw new Error(
      `Au moins ${MIN_PUBLISHABLE_VIDEO_PROPOSALS} propositions vidéo sont requises.`,
    );
  }

  const referenceIdentities = new Set<string>();
  const actionableTrendKeys = new Set<string>();
  for (const trend of actionable) {
    const referencePost = trend.referencePost;
    if (
      trend.lifecycle === "watch" ||
      !referencePost ||
      referencePost.mediaType === "unknown" ||
      !isVerifiedMultiCreatorTrend(trend)
    ) {
      throw new Error(`Trend non publiable : ${trend.id}`);
    }
    const lastVerifiedTimestamp = Date.parse(trend.lastVerifiedAt);
    const reuseVerifiedTimestamp = Date.parse(trend.reuseEvidence!.verifiedAt);
    const maximumVerificationAgeHours = trend.lifecycle === "steady"
      ? TREND_STEADY_MAX_VERIFICATION_AGE_HOURS
      : TREND_ACTIVE_MAX_VERIFICATION_AGE_HOURS;
    const hasInvalidSemanticTimestamp =
      lastVerifiedTimestamp > nowTimestamp || reuseVerifiedTimestamp > nowTimestamp;
    const hasExpiredSemanticEvidence =
      nowTimestamp - lastVerifiedTimestamp >
        maximumVerificationAgeHours * HOUR_IN_MILLISECONDS ||
      nowTimestamp - reuseVerifiedTimestamp >
        maximumVerificationAgeHours * HOUR_IN_MILLISECONDS;
    if (
      hasInvalidSemanticTimestamp ||
      (!options.allowStaleSemanticEvidence && hasExpiredSemanticEvidence)
    ) {
      throw new Error(
        `Trend trop ancienne : ${trend.id} (vÃ©rification > ${maximumVerificationAgeHours} h).`,
      );
    }
    const referenceIdentity = canonicalReferenceIdentity(referencePost);
    if (referenceIdentities.has(referenceIdentity)) {
      throw new Error(`RÃ©fÃ©rence native dupliquÃ©e : ${referencePost.url}`);
    }
    referenceIdentities.add(referenceIdentity);
    const trendKey = trend.trendKey.trim().toLocaleLowerCase("fr");
    if (actionableTrendKeys.has(trendKey)) {
      throw new Error(`ClÃ© de trend dupliquÃ©e : ${trend.trendKey}`);
    }
    actionableTrendKeys.add(trendKey);
  }

  const topTrends = selectGirlFirstSocialTrends(
    actionableVideos,
    MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
  );
  const lofiGirlCount = topTrends.filter(
    (trend) => trend.character === "lofi-girl",
  ).length;
  if (
    topTrends.length !== MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS ||
    lofiGirlCount / topTrends.length < MIN_PUBLISHABLE_LOFI_GIRL_SHARE
  ) {
    throw new Error("Le top 50 Trends doit contenir au moins 80 % de Lofi Girl.");
  }

  return feed;
}

export function latestTrendObservation(trend: SocialTrend) {
  return [...trend.observations].sort((left, right) =>
    right.observedAt.localeCompare(left.observedAt),
  )[0];
}
