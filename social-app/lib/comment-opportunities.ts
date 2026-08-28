export type CommentOpportunityPlatform = "instagram" | "tiktok" | "youtube" | "x";
export type CommentOpportunityStatus = "surging" | "hot" | "watch";
export type CommentOpportunityTone = "funny" | "smart" | "complice";
export type CommentOpportunityRiskLevel = "low" | "medium";
export type CommentOpportunityExactness = "exact" | "platform-estimate" | "unavailable";
export type CommentOpportunityCategory =
  | "gaming"
  | "cinema"
  | "music"
  | "tech"
  | "sport"
  | "internet"
  | "other";
/**
 * Weight of the cultural moment, not of the account. `s` is a moment the whole
 * feed is talking about within the hour; `b` is ordinary virality.
 */
export type CommentOpportunityMomentTier = "s" | "a" | "b";
export type CommentOpportunityDiscoverySource = "watchlist" | "viral-scan";
export type CommentOpportunityVelocityMetric = "views" | "likes" | "comments";
/**
 * Where the three proposals come from. `fallback` means the voice engine was
 * unreachable and the lines were derived conservatively from public metadata,
 * which a community manager still has to be able to identify at a glance.
 */
export type CommentOpportunityCommentsSource = "voice-engine" | "curated" | "fallback";

export type CommentOpportunityMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type CommentOpportunityObservation = CommentOpportunityMetrics & {
  capturedAt: string;
  sourceLabel: string;
  sourceUrl: string;
  exactness: CommentOpportunityExactness;
};

export type CommentSuggestion = {
  tone: CommentOpportunityTone;
  label: string;
  text: string;
};

export type CommentOpportunityDiscovery = {
  source: CommentOpportunityDiscoverySource;
  accountHandle: string | null;
  accountTier: CommentOpportunityMomentTier | null;
};

export type CommentOpportunityVelocity = {
  metric: CommentOpportunityVelocityMetric;
  perHour: number;
  windowHours: number;
  fromCapturedAt: string;
  toCapturedAt: string;
};

export type CommentOpportunity = {
  id: string;
  platform: CommentOpportunityPlatform;
  category: CommentOpportunityCategory;
  author: string;
  title: string;
  caption: string;
  url: string;
  mediaType: "video";
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  capturedAt: string;
  status: CommentOpportunityStatus;
  momentTier: CommentOpportunityMomentTier;
  discovery: CommentOpportunityDiscovery;
  velocity: CommentOpportunityVelocity | null;
  lofiFitScore: number;
  commentabilityScore: number;
  priorityScore: number;
  whyNow: string;
  risk: {
    level: CommentOpportunityRiskLevel;
    note: string;
  };
  metrics: CommentOpportunityMetrics;
  observations: CommentOpportunityObservation[];
  comments: CommentSuggestion[];
  commentsSource: CommentOpportunityCommentsSource;
  alertedAt: string | null;
};

export type CommentOpportunitySourceCheck = {
  id: string;
  platform: CommentOpportunityPlatform;
  status: "success" | "limited" | "failed";
  checkedAt: string;
  label: string;
};

export type CommentOpportunityFeed = {
  version: 2;
  capturedAt: string;
  nextRefreshAt: string;
  cadenceHours: 6;
  fastLaneMinutes: 15;
  fastLaneCheckedAt: string | null;
  watchlistAccountCount: number;
  sourceChecks: CommentOpportunitySourceCheck[];
  opportunities: CommentOpportunity[];
};

export const COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS = 6;
export const COMMENT_OPPORTUNITY_FAST_LANE_MINUTES = 15;
export const COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH = 160;

/**
 * How long an early reaction can still land near the top of a comment section.
 * A major drop is crowded within hours; ordinary virality stays open a day.
 */
export const COMMENT_OPPORTUNITY_GOLDEN_WINDOW_HOURS: Record<
  CommentOpportunityMomentTier,
  number
> = { s: 6, a: 12, b: 24 };

const HOUR_IN_MILLISECONDS = 60 * 60 * 1_000;
const MINUTE_IN_MILLISECONDS = 60 * 1_000;
const MIN_VELOCITY_WINDOW_MS = 10 * MINUTE_IN_MILLISECONDS;
const MAX_VELOCITY_WINDOW_MS = 48 * HOUR_IN_MILLISECONDS;
/** A single datapoint on an s-tier account is a drop, not yet a measurement. */
const UNMEASURED_DROP_GRACE_MS = 3 * HOUR_IN_MILLISECONDS;
/** Past this age, a big counter describes a back catalogue, not a moment. */
const MOMENTOUS_AGE_MS = 48 * HOUR_IN_MILLISECONDS;

const METRIC_KEYS = ["views", "likes", "comments", "shares"] as const;
const VELOCITY_METRIC_KEYS = ["views", "likes", "comments"] as const;
const VALID_PLATFORMS = new Set<CommentOpportunityPlatform>([
  "instagram",
  "tiktok",
  "youtube",
  "x",
]);
const VALID_STATUSES = new Set<CommentOpportunityStatus>([
  "surging",
  "hot",
  "watch",
]);
const VALID_TONES = new Set<CommentOpportunityTone>([
  "funny",
  "smart",
  "complice",
]);
const VALID_EXACTNESS = new Set<CommentOpportunityExactness>([
  "exact",
  "platform-estimate",
  "unavailable",
]);
const VALID_RISK_LEVELS = new Set<CommentOpportunityRiskLevel>([
  "low",
  "medium",
]);
const VALID_CATEGORIES = new Set<CommentOpportunityCategory>([
  "gaming",
  "cinema",
  "music",
  "tech",
  "sport",
  "internet",
  "other",
]);
const VALID_MOMENT_TIERS = new Set<CommentOpportunityMomentTier>(["s", "a", "b"]);
const VALID_DISCOVERY_SOURCES = new Set<CommentOpportunityDiscoverySource>([
  "watchlist",
  "viral-scan",
]);
const VALID_COMMENTS_SOURCES = new Set<CommentOpportunityCommentsSource>([
  "voice-engine",
  "curated",
  "fallback",
]);

export const COMMENT_OPPORTUNITY_CATEGORY_LABELS: Record<
  CommentOpportunityCategory,
  string
> = {
  gaming: "Gaming",
  cinema: "Ciné · Séries · Anime",
  music: "Musique",
  tech: "Tech",
  sport: "Sport",
  internet: "Créateurs",
  other: "Autre",
};

export const COMMENT_OPPORTUNITY_MOMENT_TIER_LABELS: Record<
  CommentOpportunityMomentTier,
  string
> = {
  s: "Moment majeur",
  a: "Gros buzz",
  b: "Veille",
};

/**
 * Momentum thresholds, expressed per hour on the counter a platform actually
 * exposes. Views, likes and comments are never compared to each other: each
 * metric carries its own scale.
 */
const MOMENT_TIER_THRESHOLDS: Record<
  CommentOpportunityVelocityMetric,
  { s: number; a: number }
> = {
  views: { s: 200_000, a: 25_000 },
  likes: { s: 20_000, a: 2_500 },
  comments: { s: 2_000, a: 250 },
};

/** A card whose subject is sensitive can never be published as low risk. */
const SENSITIVE_SUBJECT_PATTERN =
  /\b(?:rip|r\.i\.p|died|dies|death|dead|passed\s+away|funeral|obituary|killed|shooting|murder|terror|attack|war|invasion|bombing|unabomber|genocide|hostage|earthquake|wildfire|hurricane|flood|famine|cancer|suicide|overdose|assault|drunk|intoxicated|sleep\s+deprivation|lawsuit|arrested|convicted|verdict|election|president|senate|parliament|protest|riot|strike|layoffs|bankruptcy|deces|décès|mort|tuerie|attentat|guerre|séisme|seisme|incendie|inondation|proces|procès|élection|election)\b/iu;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (!isText(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isNullablePublicMetric(value: unknown) {
  return value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isScore(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100;
}

function normalizeComment(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function metricsMatch(
  left: CommentOpportunityMetrics,
  right: CommentOpportunityMetrics,
) {
  return METRIC_KEYS.every((key) => left[key] === right[key]);
}

function hasAnyMetric(metrics: CommentOpportunityMetrics) {
  return METRIC_KEYS.some((key) => metrics[key] !== null);
}

export function isPromotionalComment(text: string) {
  const containsLink = /(?:https?:\/\/|www\.)/iu.test(text);
  const containsHashtag = /(?:^|\s)#[\p{L}\p{N}_-]+/iu.test(text);
  const containsPromotion = /(?:\bfollow\b|\bsubscribe\b|\bstream\b|\blisten\s+to\b|\bcheck\s+out\b|\blink\s+in\s+bio\b|\bour\s+(?:channel|playlist|music|album|radio)\b|\blofi\s+girl\s+(?:channel|playlist|music|radio)\b)/iu.test(text);
  return containsLink || containsHashtag || containsPromotion;
}

/**
 * Reads the subject of the post, never the proposed comment: a card about a
 * death or a trial must be reviewed by a human even when the wording is soft.
 */
export function commentOpportunityIsSensitive(
  opportunity: Pick<CommentOpportunity, "title" | "caption">,
) {
  return SENSITIVE_SUBJECT_PATTERN.test(`${opportunity.title} ${opportunity.caption}`);
}

export function isNativeCommentOpportunityUrl(
  candidate: string,
  platform: CommentOpportunityPlatform,
) {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:") return false;
    if (platform === "instagram") {
      return (host === "instagram.com" || host.endsWith(".instagram.com")) &&
        /^\/(?:reel|reels)\/[^/]+$/iu.test(path);
    }
    if (platform === "tiktok") {
      return (host === "tiktok.com" || host.endsWith(".tiktok.com")) &&
        /^\/@[^/]+\/video\/\d{12,24}$/iu.test(path);
    }
    if (platform === "youtube") {
      if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return false;
      // A major drop is almost always a long-form upload, not a Short.
      if (/^\/shorts\/[A-Za-z0-9_-]{11}$/u.test(path)) return true;
      return path === "/watch" &&
        /^[A-Za-z0-9_-]{11}$/u.test(url.searchParams.get("v") ?? "");
    }
    return (
      host === "x.com" ||
      host.endsWith(".x.com") ||
      host === "twitter.com" ||
      host.endsWith(".twitter.com")
    ) && /^\/[^/]+\/status\/\d+$/iu.test(path);
  } catch {
    return false;
  }
}

/**
 * Identity of the underlying post, so the same video cannot enter the queue
 * twice under two ids or two URL shapes.
 */
export function nativeCommentOpportunityIdentity(
  opportunity: Pick<CommentOpportunity, "platform" | "url">,
) {
  const url = new URL(opportunity.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (opportunity.platform === "youtube") {
    const nativeId = segments[0]?.toLowerCase() === "shorts"
      ? segments[1]
      : url.searchParams.get("v");
    return `youtube:${nativeId ?? ""}`;
  }
  if (opportunity.platform === "instagram") {
    return `instagram:${segments[1] ?? ""}`;
  }
  return `${opportunity.platform}:${segments.at(-1) ?? ""}`;
}

/**
 * "Surging" is reserved for a measured increase on the same public counter.
 * A single large counter is strong performance, but it is not acceleration.
 */
export function hasCommentOpportunityAccelerationEvidence(
  opportunity: Pick<CommentOpportunity, "observations">,
) {
  if (opportunity.observations.length < 2) return false;
  const first = opportunity.observations[0];
  const latest = opportunity.observations.at(-1);
  if (!latest || Date.parse(latest.capturedAt) <= Date.parse(first.capturedAt)) {
    return false;
  }
  return METRIC_KEYS.some((key) => {
    const before = first[key];
    const after = latest[key];
    return before !== null && after !== null && after > before;
  });
}

/**
 * Quantifies momentum on the freshest pair of comparable readings of a single
 * counter. It never mixes two metrics and never extrapolates: without two
 * readings of the same counter, momentum stays unknown rather than zero.
 */
export function measureCommentOpportunityVelocity(
  observations: readonly CommentOpportunityObservation[],
): CommentOpportunityVelocity | null {
  for (const metric of VELOCITY_METRIC_KEYS) {
    const readings = observations
      .filter((observation) => observation[metric] !== null)
      .map((observation) => ({
        value: observation[metric] as number,
        at: Date.parse(observation.capturedAt),
        capturedAt: observation.capturedAt,
      }))
      .filter((reading) => Number.isFinite(reading.at));
    if (readings.length < 2) continue;

    const latest = readings.at(-1)!;
    // Closest earlier reading that is far enough apart to divide by, so a
    // burst of scans a minute apart cannot manufacture a huge rate.
    const earlier = readings
      .slice(0, -1)
      .reverse()
      .find((reading) =>
        latest.at - reading.at >= MIN_VELOCITY_WINDOW_MS &&
        latest.at - reading.at <= MAX_VELOCITY_WINDOW_MS
      );
    if (!earlier || latest.value <= earlier.value) continue;

    const windowMs = latest.at - earlier.at;
    return {
      metric,
      perHour: Math.round(((latest.value - earlier.value) * HOUR_IN_MILLISECONDS) / windowMs),
      windowHours: Math.round((windowMs / HOUR_IN_MILLISECONDS) * 100) / 100,
      fromCapturedAt: earlier.capturedAt,
      toCapturedAt: latest.capturedAt,
    };
  }
  return null;
}

/**
 * Tier is derived, never declared. It reads measured momentum first; the only
 * concession to reputation is a freshly dropped video from an s-tier watchlist
 * account, which is held at `a` while its second reading is still pending.
 */
export function commentOpportunityMomentTier(
  opportunity: Pick<
    CommentOpportunity,
    "velocity" | "discovery" | "metrics" | "publishedAt" | "capturedAt"
  >,
): CommentOpportunityMomentTier {
  const { velocity } = opportunity;
  if (velocity) {
    const thresholds = MOMENT_TIER_THRESHOLDS[velocity.metric];
    if (velocity.perHour >= thresholds.s) return "s";
    if (velocity.perHour >= thresholds.a) return "a";
  }

  // A huge counter on an old post is back catalogue, not a moment. Absolute
  // volume only earns a tier while the post is still new enough that a comment
  // has somewhere to land.
  if (isRecentAtCapture(opportunity, MOMENTOUS_AGE_MS)) {
    const views = opportunity.metrics.views ?? 0;
    const likes = opportunity.metrics.likes ?? 0;
    if (views >= 5_000_000 || likes >= 1_000_000) return "s";
    if (views >= 1_000_000 || likes >= 250_000) return "a";
  }

  if (
    velocity === null &&
    opportunity.discovery.source === "watchlist" &&
    opportunity.discovery.accountTier === "s" &&
    isRecentAtCapture(opportunity, UNMEASURED_DROP_GRACE_MS)
  ) {
    return "a";
  }
  return "b";
}

function isRecentAtCapture(
  opportunity: Pick<CommentOpportunity, "publishedAt" | "capturedAt">,
  maxAgeMs: number,
) {
  if (opportunity.publishedAt === null) return false;
  const publishedAt = Date.parse(opportunity.publishedAt);
  const capturedAt = Date.parse(opportunity.capturedAt);
  if (!Number.isFinite(publishedAt) || !Number.isFinite(capturedAt)) return false;
  return capturedAt - publishedAt <= maxAgeMs;
}

/**
 * Editorial-only composite: it deliberately ignores raw cross-platform
 * counters, which are not comparable between Instagram, TikTok, YouTube and X.
 */
export function commentOpportunityPriorityScore(
  opportunity: Pick<CommentOpportunity, "lofiFitScore" | "commentabilityScore">,
) {
  return Math.round(
    opportunity.lofiFitScore * 0.55 + opportunity.commentabilityScore * 0.45,
  );
}

export function commentOpportunityFreshnessScore(
  opportunity: Pick<CommentOpportunity, "publishedAt" | "capturedAt">,
  referenceAt = opportunity.capturedAt,
) {
  if (opportunity.publishedAt === null) return 45;
  const publishedAt = Date.parse(opportunity.publishedAt);
  const referenceTimestamp = Date.parse(referenceAt);
  if (!Number.isFinite(publishedAt) || !Number.isFinite(referenceTimestamp)) return 0;
  const ageHours = Math.max(0, (referenceTimestamp - publishedAt) / HOUR_IN_MILLISECONDS);
  return Math.round(100 * 2 ** (-ageHours / 48));
}

export type CommentOpportunityGoldenWindow = {
  state: "unknown" | "open" | "closing" | "closed";
  closesAt: string | null;
  remainingMinutes: number | null;
  totalHours: number;
};

/**
 * The window is the actionable part of the card: past it, a comment lands on
 * page nine of the section and the whole point is gone.
 */
export function commentOpportunityGoldenWindow(
  opportunity: Pick<CommentOpportunity, "publishedAt" | "momentTier">,
  nowIso: string,
): CommentOpportunityGoldenWindow {
  const totalHours = COMMENT_OPPORTUNITY_GOLDEN_WINDOW_HOURS[opportunity.momentTier];
  const publishedAt = opportunity.publishedAt === null
    ? Number.NaN
    : Date.parse(opportunity.publishedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(publishedAt) || !Number.isFinite(now)) {
    return { state: "unknown", closesAt: null, remainingMinutes: null, totalHours };
  }
  const closesAtTimestamp = publishedAt + totalHours * HOUR_IN_MILLISECONDS;
  const remainingMinutes = Math.round((closesAtTimestamp - now) / MINUTE_IN_MILLISECONDS);
  const closesAt = new Date(closesAtTimestamp).toISOString();
  if (remainingMinutes <= 0) {
    return { state: "closed", closesAt, remainingMinutes: 0, totalHours };
  }
  return {
    state: remainingMinutes <= totalHours * 15 ? "closing" : "open",
    closesAt,
    remainingMinutes,
    totalHours,
  };
}

export function commentOpportunityRankScore(
  opportunity: Pick<
    CommentOpportunity,
    "priorityScore" | "publishedAt" | "capturedAt" | "status" | "risk" | "momentTier"
  >,
  referenceAt = opportunity.capturedAt,
) {
  const statusAdjustment = opportunity.status === "surging"
    ? 4
    : opportunity.status === "watch"
      ? -6
      : 0;
  const tierAdjustment = opportunity.momentTier === "s"
    ? 12
    : opportunity.momentTier === "a"
      ? 5
      : 0;
  const riskAdjustment = opportunity.risk.level === "medium" ? -6 : 0;
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        opportunity.priorityScore * 0.7 +
          commentOpportunityFreshnessScore(opportunity, referenceAt) * 0.3 +
          statusAdjustment +
          tierAdjustment +
          riskAdjustment,
      ),
    ),
  );
}

export function rankCommentOpportunities(
  opportunities: readonly CommentOpportunity[],
  referenceAt?: string,
) {
  return [...opportunities].sort((left, right) => {
    const rightRankScore = commentOpportunityRankScore(right, referenceAt ?? right.capturedAt);
    const leftRankScore = commentOpportunityRankScore(left, referenceAt ?? left.capturedAt);
    if (rightRankScore !== leftRankScore) {
      return rightRankScore - leftRankScore;
    }
    if (right.priorityScore !== left.priorityScore) {
      return right.priorityScore - left.priorityScore;
    }
    const rightPublishedAt = right.publishedAt === null
      ? Date.parse(right.capturedAt)
      : Date.parse(right.publishedAt);
    const leftPublishedAt = left.publishedAt === null
      ? Date.parse(left.capturedAt)
      : Date.parse(left.publishedAt);
    if (rightPublishedAt !== leftPublishedAt) {
      return rightPublishedAt - leftPublishedAt;
    }
    return left.title.localeCompare(right.title, "fr");
  });
}

function assertMetrics(
  value: unknown,
  context: string,
): asserts value is CommentOpportunityMetrics {
  if (!value || typeof value !== "object") {
    throw new Error(`Métriques de commentaire invalides : ${context}`);
  }
  const metrics = value as CommentOpportunityMetrics;
  if (METRIC_KEYS.some((key) => !isNullablePublicMetric(metrics[key]))) {
    throw new Error(`Métriques de commentaire invalides : ${context}`);
  }
}

function velocityMatches(
  declared: CommentOpportunityVelocity | null,
  measured: CommentOpportunityVelocity | null,
) {
  if (declared === null || measured === null) return declared === measured;
  return declared.metric === measured.metric &&
    declared.perHour === measured.perHour &&
    declared.windowHours === measured.windowHours &&
    declared.fromCapturedAt === measured.fromCapturedAt &&
    declared.toCapturedAt === measured.toCapturedAt;
}

export function assertCommentOpportunityFeed(
  value: unknown,
): CommentOpportunityFeed {
  if (!value || typeof value !== "object") {
    throw new Error("Snapshot Commentaires invalide.");
  }
  const feed = value as CommentOpportunityFeed;
  const capturedTimestamp = typeof feed.capturedAt === "string"
    ? Date.parse(feed.capturedAt)
    : Number.NaN;
  const nextRefreshTimestamp = typeof feed.nextRefreshAt === "string"
    ? Date.parse(feed.nextRefreshAt)
    : Number.NaN;
  const fastLaneTimestamp = feed.fastLaneCheckedAt === null
    ? null
    : typeof feed.fastLaneCheckedAt === "string"
      ? Date.parse(feed.fastLaneCheckedAt)
      : Number.NaN;
  if (
    feed.version !== 2 ||
    feed.cadenceHours !== COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS ||
    feed.fastLaneMinutes !== COMMENT_OPPORTUNITY_FAST_LANE_MINUTES ||
    !Number.isFinite(capturedTimestamp) ||
    !Number.isFinite(nextRefreshTimestamp) ||
    nextRefreshTimestamp <= capturedTimestamp ||
    nextRefreshTimestamp - capturedTimestamp >
      COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS * HOUR_IN_MILLISECONDS ||
    (fastLaneTimestamp !== null &&
      (!Number.isFinite(fastLaneTimestamp) || fastLaneTimestamp > capturedTimestamp)) ||
    !Number.isInteger(feed.watchlistAccountCount) ||
    feed.watchlistAccountCount < 0 ||
    !Array.isArray(feed.sourceChecks) ||
    !Array.isArray(feed.opportunities)
  ) {
    throw new Error("Snapshot Commentaires invalide.");
  }

  const sourceCheckIds = new Set<string>();
  const checkedPlatforms = new Set<CommentOpportunityPlatform>();
  for (const sourceCheck of feed.sourceChecks) {
    const checkedTimestamp = typeof sourceCheck?.checkedAt === "string"
      ? Date.parse(sourceCheck.checkedAt)
      : Number.NaN;
    if (
      !sourceCheck ||
      !isText(sourceCheck.id) ||
      sourceCheckIds.has(sourceCheck.id) ||
      !VALID_PLATFORMS.has(sourceCheck.platform) ||
      checkedPlatforms.has(sourceCheck.platform) ||
      !["success", "limited", "failed"].includes(sourceCheck.status) ||
      !Number.isFinite(checkedTimestamp) ||
      checkedTimestamp > capturedTimestamp ||
      !isText(sourceCheck.label)
    ) {
      throw new Error(`Contrôle de source Commentaires invalide : ${sourceCheck?.id ?? "inconnu"}`);
    }
    sourceCheckIds.add(sourceCheck.id);
    checkedPlatforms.add(sourceCheck.platform);
  }
  if (checkedPlatforms.size !== VALID_PLATFORMS.size) {
    throw new Error("Une source doit être contrôlée pour chaque plateforme Commentaires.");
  }

  const ids = new Set<string>();
  const nativePosts = new Set<string>();
  const allCommentTexts = new Set<string>();
  for (const opportunity of feed.opportunities) {
    if (!opportunity || typeof opportunity !== "object") {
      throw new Error("Opportunité de commentaire invalide.");
    }
    const publishedTimestamp = opportunity.publishedAt === null
      ? null
      : typeof opportunity.publishedAt === "string"
        ? Date.parse(opportunity.publishedAt)
        : Number.NaN;
    const opportunityCapturedTimestamp = typeof opportunity.capturedAt === "string"
      ? Date.parse(opportunity.capturedAt)
      : Number.NaN;
    const alertedTimestamp = opportunity.alertedAt === null
      ? null
      : typeof opportunity.alertedAt === "string"
        ? Date.parse(opportunity.alertedAt)
        : Number.NaN;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(opportunity.id) ||
      ids.has(opportunity.id) ||
      !VALID_PLATFORMS.has(opportunity.platform) ||
      !VALID_CATEGORIES.has(opportunity.category) ||
      opportunity.mediaType !== "video" ||
      !isText(opportunity.author) ||
      !isText(opportunity.title) ||
      !isText(opportunity.caption) ||
      !isNativeCommentOpportunityUrl(opportunity.url, opportunity.platform) ||
      (opportunity.thumbnailUrl !== null && !isHttpsUrl(opportunity.thumbnailUrl)) ||
      (opportunity.durationSeconds !== null &&
        (typeof opportunity.durationSeconds !== "number" ||
          !Number.isFinite(opportunity.durationSeconds) ||
          opportunity.durationSeconds <= 0)) ||
      (publishedTimestamp !== null &&
        (!Number.isFinite(publishedTimestamp) || publishedTimestamp > capturedTimestamp)) ||
      !Number.isFinite(opportunityCapturedTimestamp) ||
      opportunityCapturedTimestamp > capturedTimestamp ||
      // `alertedAt` records something this system did, not something it
      // observed, and the alert necessarily fires after the snapshot it was
      // read from. It is only required to be a real timestamp.
      (alertedTimestamp !== null && !Number.isFinite(alertedTimestamp)) ||
      VALID_STATUSES.has(opportunity.status) === false ||
      !VALID_MOMENT_TIERS.has(opportunity.momentTier) ||
      !opportunity.discovery ||
      !VALID_DISCOVERY_SOURCES.has(opportunity.discovery.source) ||
      (opportunity.discovery.accountHandle !== null &&
        !isText(opportunity.discovery.accountHandle)) ||
      (opportunity.discovery.accountTier !== null &&
        !VALID_MOMENT_TIERS.has(opportunity.discovery.accountTier)) ||
      (opportunity.discovery.source === "watchlist" &&
        (opportunity.discovery.accountHandle === null ||
          opportunity.discovery.accountTier === null)) ||
      !isScore(opportunity.lofiFitScore) ||
      !isScore(opportunity.commentabilityScore) ||
      !isScore(opportunity.priorityScore) ||
      opportunity.priorityScore !== commentOpportunityPriorityScore(opportunity) ||
      !isText(opportunity.whyNow) ||
      opportunity.whyNow.length > 220 ||
      !opportunity.risk ||
      !VALID_RISK_LEVELS.has(opportunity.risk.level) ||
      !isText(opportunity.risk.note)
    ) {
      throw new Error(`Opportunité de commentaire invalide : ${opportunity.id ?? "inconnue"}`);
    }
    ids.add(opportunity.id);
    const nativeIdentity = nativeCommentOpportunityIdentity(opportunity);
    if (nativePosts.has(nativeIdentity)) {
      throw new Error(`Post natif dupliqué : ${opportunity.url}`);
    }
    nativePosts.add(nativeIdentity);

    assertMetrics(opportunity.metrics, opportunity.id);
    if (!Array.isArray(opportunity.observations) || opportunity.observations.length === 0) {
      throw new Error(`Provenance métrique absente : ${opportunity.id}`);
    }
    let previousObservationTimestamp = Number.NEGATIVE_INFINITY;
    for (const observation of opportunity.observations) {
      const observationTimestamp = typeof observation?.capturedAt === "string"
        ? Date.parse(observation.capturedAt)
        : Number.NaN;
      assertMetrics(observation, opportunity.id);
      if (
        !Number.isFinite(observationTimestamp) ||
        observationTimestamp <= previousObservationTimestamp ||
        observationTimestamp > capturedTimestamp ||
        !isText(observation.sourceLabel) ||
        !isHttpsUrl(observation.sourceUrl) ||
        !VALID_EXACTNESS.has(observation.exactness) ||
        (observation.exactness === "unavailable" && hasAnyMetric(observation)) ||
        (observation.exactness !== "unavailable" && !hasAnyMetric(observation))
      ) {
        throw new Error(`Observation de commentaire invalide : ${opportunity.id}`);
      }
      previousObservationTimestamp = observationTimestamp;
    }
    const latestObservation = opportunity.observations.at(-1);
    if (
      !latestObservation ||
      latestObservation.capturedAt !== opportunity.capturedAt ||
      !metricsMatch(opportunity.metrics, latestObservation)
    ) {
      throw new Error(`Métriques sans provenance concordante : ${opportunity.id}`);
    }
    if (
      !velocityMatches(
        opportunity.velocity,
        measureCommentOpportunityVelocity(opportunity.observations),
      )
    ) {
      throw new Error(`Vitesse non dérivable des relevés : ${opportunity.id}`);
    }
    if (opportunity.momentTier !== commentOpportunityMomentTier(opportunity)) {
      throw new Error(`Palier de moment non dérivable : ${opportunity.id}`);
    }
    if (opportunity.status === "surging" &&
      !hasCommentOpportunityAccelerationEvidence(opportunity)) {
      throw new Error(`Accélération non prouvée : ${opportunity.id}`);
    }
    if (opportunity.status === "hot" && !hasAnyMetric(opportunity.metrics)) {
      throw new Error(`Statut hot sans signal public : ${opportunity.id}`);
    }
    if (commentOpportunityIsSensitive(opportunity) && opportunity.risk.level !== "medium") {
      throw new Error(`Sujet sensible publié sans relecture : ${opportunity.id}`);
    }

    if (!Array.isArray(opportunity.comments) || opportunity.comments.length !== 3) {
      throw new Error(`Trois commentaires requis : ${opportunity.id}`);
    }
    if (!VALID_COMMENTS_SOURCES.has(opportunity.commentsSource)) {
      throw new Error(`Origine des commentaires invalide : ${opportunity.id}`);
    }
    const tones = new Set<CommentOpportunityTone>();
    const commentTexts = new Set<string>();
    for (const comment of opportunity.comments) {
      const normalizedText = isText(comment?.text)
        ? normalizeComment(comment.text)
        : "";
      if (
        !comment ||
        !VALID_TONES.has(comment.tone) ||
        tones.has(comment.tone) ||
        !isText(comment.label) ||
        !normalizedText ||
        normalizedText.length > COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH ||
        commentTexts.has(normalizedText) ||
        allCommentTexts.has(normalizedText) ||
        isPromotionalComment(comment.text)
      ) {
        throw new Error(`Commentaire proposé invalide : ${opportunity.id}`);
      }
      tones.add(comment.tone);
      commentTexts.add(normalizedText);
      allCommentTexts.add(normalizedText);
    }
    if (tones.size !== VALID_TONES.size) {
      throw new Error(`Tons de commentaire incomplets : ${opportunity.id}`);
    }
  }

  for (const sourceCheck of feed.sourceChecks) {
    const platformCount = feed.opportunities.filter(
      (opportunity) => opportunity.platform === sourceCheck.platform,
    ).length;
    if (sourceCheck.status === "failed" && platformCount > 0) {
      throw new Error(`Source échouée mais opportunités publiées : ${sourceCheck.platform}`);
    }
    if (sourceCheck.status === "success" && platformCount === 0) {
      throw new Error(`Source réussie sans opportunité : ${sourceCheck.platform}`);
    }
  }
  return feed;
}
