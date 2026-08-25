export type AudioTrendPlatform = "instagram" | "tiktok" | "youtube";
export type AudioTrendType = "music" | "spoken" | "original";
export type AudioTrendExactness = "exact" | "platform-estimate" | "unavailable";
export type AudioTrendSourceStatus = "pending" | "success" | "limited" | "failed";
export type AudioTrendProposalCharacter = "lofi-girl" | "lofi-boy";
export type AudioTrendProposalTone =
  | "cozy"
  | "funny"
  | "smart"
  | "cinematic"
  | "relatable"
  | "cat"
  | "gaming";

export type AudioTrendProposal = {
  id: string;
  title: string;
  concept: string;
  copy: string;
  character: AudioTrendProposalCharacter;
  tone: AudioTrendProposalTone;
};

export type AudioTrendPublicMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type AudioTrendReferenceVideo = {
  author: string;
  caption: string;
  url: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  capturedAt: string;
  sourceLabel: string;
  sourceUrl: string;
  exactness: AudioTrendExactness;
  metrics: AudioTrendPublicMetrics | null;
  playbackUrl?: string | null;
  playbackCapturedAt?: string | null;
  playbackExpiresAt?: string | null;
};

export type AudioTrendUsageObservation = {
  capturedAt: string;
  uses: number | null;
  rank: number | null;
  rankWindow: string | null;
  sourceLabel: string;
  sourceUrl: string;
  exactness: AudioTrendExactness;
};

export type AudioTrendReuseEvidencePost = {
  platform: AudioTrendPlatform;
  author: string;
  url: string;
  capturedAt: string;
};

export type AudioTrendReuseEvidence = {
  verifiedAt: string;
  minimumDistinctCreators: number;
  summary: string;
  posts: AudioTrendReuseEvidencePost[];
};

export type AudioTrend = {
  id: string;
  platform: AudioTrendPlatform;
  type: AudioTrendType;
  title: string;
  author: string;
  audioUrl: string;
  source: {
    capturedAt: string;
    label: string;
    url: string;
    exactness: Exclude<AudioTrendExactness, "unavailable">;
  };
  referenceVideo: AudioTrendReferenceVideo;
  usageObservations: AudioTrendUsageObservation[];
  reuseEvidence: AudioTrendReuseEvidence;
  lofiFitScore: number;
  lofiAngle: string;
  lofiFitRationale: string;
  proposals: AudioTrendProposal[];
};

export type AudioTrendSourceCheck = {
  id: string;
  platform: AudioTrendPlatform;
  status: AudioTrendSourceStatus;
  checkedAt: string | null;
  label: string;
  sourceUrl: string;
};

export type AudioTrendFeed = {
  version: 1;
  capturedAt: string;
  nextRefreshAt: string;
  cadenceHours: 24;
  methodology: string;
  sourceChecks: AudioTrendSourceCheck[];
  trends: AudioTrend[];
};

export type AudioTrendGrowth = {
  fromCapturedAt: string;
  toCapturedAt: string;
  fromUses: number;
  toUses: number;
  deltaUses: number;
  growthPercent: number | null;
  elapsedHours: number;
  usesPerDay: number;
  exactness: Exclude<AudioTrendExactness, "unavailable">;
  sourceUrl: string;
};

export const AUDIO_TREND_REFRESH_CADENCE_HOURS = 24;
export const MIN_PUBLISHABLE_AUDIO_TRENDS = 50;
export const MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES = 50_000;
export const MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS = 30;

const HOUR_IN_MILLISECONDS = 60 * 60 * 1_000;
const INSTAGRAM_PLAYBACK_MIN_VALIDITY_MS = HOUR_IN_MILLISECONDS;
const INSTAGRAM_PLAYBACK_MAX_VALIDITY_MS = 7 * 24 * HOUR_IN_MILLISECONDS;
const METRIC_KEYS = ["views", "likes", "comments", "shares"] as const;
const PLATFORMS: readonly AudioTrendPlatform[] = ["instagram", "tiktok", "youtube"];
const VALID_PLATFORMS = new Set<AudioTrendPlatform>(PLATFORMS);
const VALID_TYPES = new Set<AudioTrendType>(["music", "spoken", "original"]);
const VALID_EXACTNESS = new Set<AudioTrendExactness>([
  "exact",
  "platform-estimate",
  "unavailable",
]);
const VALID_SOURCE_STATUSES = new Set<AudioTrendSourceStatus>([
  "pending",
  "success",
  "limited",
  "failed",
]);
const VALID_PROPOSAL_CHARACTERS = new Set<AudioTrendProposalCharacter>([
  "lofi-girl",
  "lofi-boy",
]);
const VALID_PROPOSAL_TONES = new Set<AudioTrendProposalTone>([
  "cozy",
  "funny",
  "smart",
  "cinematic",
  "relatable",
  "cat",
  "gaming",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Audio cards are publishable only when their native reference is itself a
 * proven short-form hit. Missing public metrics or duration fail closed.
 */
export function isPublishableAudioTrendReferenceVideo(value: unknown) {
  if (!isObject(value) || !isObject(value.metrics)) return false;
  const likes = value.metrics.likes;
  const durationSeconds = value.durationSeconds;
  return (
    typeof likes === "number" &&
    Number.isSafeInteger(likes) &&
    likes >= MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES &&
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds < MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS
  );
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`Champ inattendu dans ${context} : ${unexpected}`);
  }
}

function hasDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const TIKTOK_THUMBNAIL_DOMAINS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "muscdn.com",
] as const;

const AUDIO_TREND_THUMBNAIL_CACHE_PATTERN =
  /^media\/audio-trends\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:avif|jpe?g|png|webp)$/u;
const AUDIO_TREND_THUMBNAIL_EXPIRY_SAFETY_MS = 60_000;

export function isCachedAudioTrendThumbnailUrl(candidate: string) {
  return AUDIO_TREND_THUMBNAIL_CACHE_PATTERN.test(candidate);
}

export function isAudioTrendThumbnailExpired(
  candidate: string,
  now = Date.now(),
) {
  if (isCachedAudioTrendThumbnailUrl(candidate)) return false;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (!TIKTOK_THUMBNAIL_DOMAINS.some((domain) => hasDomain(hostname, domain))) {
      return false;
    }
    const rawExpiry = url.searchParams.get("x-expires");
    const hasSignature = url.searchParams.has("x-signature");
    if (rawExpiry === null) return hasSignature;
    const expirySeconds = Number(rawExpiry);
    return !Number.isSafeInteger(expirySeconds) ||
      expirySeconds * 1_000 <= now + AUDIO_TREND_THUMBNAIL_EXPIRY_SAFETY_MS;
  } catch {
    return true;
  }
}

/**
 * Thumbnail URLs are accepted only from the platform that owns the reference
 * video or from the repository's exact same-origin cache path. This deliberately
 * excludes arbitrary hosts and arbitrary local paths.
 */
export function isOfficialAudioTrendThumbnailUrl(
  candidate: string,
  platform: AudioTrendPlatform,
) {
  if (isCachedAudioTrendThumbnailUrl(candidate)) return true;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return false;
    }
    if (platform === "instagram") {
      return hasDomain(hostname, "cdninstagram.com") ||
        hasDomain(hostname, "fbcdn.net") ||
        hasDomain(hostname, "instagram.com");
    }
    if (platform === "tiktok") {
      return TIKTOK_THUMBNAIL_DOMAINS.some((domain) => hasDomain(hostname, domain));
    }
    return hasDomain(hostname, "ytimg.com") || hasDomain(hostname, "youtube.com");
  } catch {
    return false;
  }
}

function canonicalUrl(candidate: string) {
  const url = new URL(candidate);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname.toLowerCase()}${pathname}`;
}

export function isNativeAudioTrendUrl(
  candidate: string,
  platform: AudioTrendPlatform,
) {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:") return false;
    if (platform === "instagram") {
      return hasDomain(host, "instagram.com") &&
        /^\/reels\/audio\/[A-Za-z0-9_-]+$/u.test(path);
    }
    if (platform === "tiktok") {
      return hasDomain(host, "tiktok.com") &&
        /^\/music\/[^/]*\d{8,24}$/u.test(path);
    }
    return hasDomain(host, "youtube.com") &&
      /^\/source\/[A-Za-z0-9_-]{11}\/shorts$/u.test(path);
  } catch {
    return false;
  }
}

export function isNativeAudioReferenceVideoUrl(
  candidate: string,
  platform: AudioTrendPlatform,
) {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:") return false;
    if (platform === "instagram") {
      return hasDomain(host, "instagram.com") &&
        /^\/(?:reel|reels)\/[^/]+$/u.test(path);
    }
    if (platform === "tiktok") {
      return hasDomain(host, "tiktok.com") &&
        /^\/@[^/]+\/video\/\d{12,24}$/u.test(path);
    }
    return hasDomain(host, "youtube.com") &&
      /^\/shorts\/[A-Za-z0-9_-]{11}$/u.test(path);
  } catch {
    return false;
  }
}

export function isInstagramSignedPlaybackUrl(
  candidate: string,
  declaredExpiresAt?: string,
) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const declaredHost = url.searchParams.get("_nc_ht")?.toLowerCase();
    const signedExpiry = url.searchParams.get("oe");
    const signature = url.searchParams.get("oh");
    if (
      url.protocol !== "https:" ||
      !/^scontent(?:-[a-z0-9-]+)?\.cdninstagram\.com$/u.test(hostname) ||
      declaredHost !== hostname ||
      !url.pathname.toLowerCase().endsWith(".mp4") ||
      !signature ||
      signature.length < 16 ||
      !signedExpiry ||
      !/^[0-9a-f]{8,16}$/iu.test(signedExpiry)
    ) {
      return false;
    }
    if (declaredExpiresAt === undefined) return true;
    if (!isTimestamp(declaredExpiresAt)) return false;
    const encodedExpiryMs = Number.parseInt(signedExpiry, 16) * 1_000;
    return Number.isSafeInteger(encodedExpiryMs) &&
      Math.abs(encodedExpiryMs - Date.parse(declaredExpiresAt)) < 1_000;
  } catch {
    return false;
  }
}

function isOfficialPlatformSourceUrl(
  candidate: string,
  platform: AudioTrendPlatform,
) {
  if (!isHttpsUrl(candidate)) return false;
  const host = new URL(candidate).hostname.toLowerCase();
  if (platform === "instagram") return hasDomain(host, "instagram.com");
  if (platform === "tiktok") return hasDomain(host, "tiktok.com");
  return hasDomain(host, "youtube.com");
}

function validUsageObservationForGrowth(
  observation: AudioTrendUsageObservation,
) {
  return isTimestamp(observation.capturedAt) &&
    observation.uses !== null &&
    Number.isSafeInteger(observation.uses) &&
    observation.uses >= 0 &&
    observation.exactness !== "unavailable" &&
    isHttpsUrl(observation.sourceUrl);
}

/**
 * Growth is evidence, never an input. It is derived only from at least two
 * usage counters measured from the same canonical source with the same
 * exactness. Rank-only observations are deliberately ignored.
 */
export function deriveAudioTrendGrowth(
  observations: readonly AudioTrendUsageObservation[],
): AudioTrendGrowth | null {
  const comparableSeries = new Map<string, AudioTrendUsageObservation[]>();
  for (const observation of observations) {
    if (!validUsageObservationForGrowth(observation)) continue;
    const key = `${observation.exactness}:${canonicalUrl(observation.sourceUrl)}`;
    const series = comparableSeries.get(key) ?? [];
    series.push(observation);
    comparableSeries.set(key, series);
  }

  const candidates = [...comparableSeries.values()]
    .map((series) => [...series].sort(
      (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
    ))
    .filter((series) =>
      series.length >= 2 &&
      Date.parse(series.at(-1)!.capturedAt) > Date.parse(series[0].capturedAt)
    )
    .sort((left, right) => {
      const latestDelta = Date.parse(right.at(-1)!.capturedAt) -
        Date.parse(left.at(-1)!.capturedAt);
      if (latestDelta !== 0) return latestDelta;
      return (Date.parse(right.at(-1)!.capturedAt) - Date.parse(right[0].capturedAt)) -
        (Date.parse(left.at(-1)!.capturedAt) - Date.parse(left[0].capturedAt));
    });

  const series = candidates[0];
  if (!series) return null;
  const first = series[0];
  const latest = series.at(-1)!;
  const fromUses = first.uses!;
  const toUses = latest.uses!;
  const deltaUses = toUses - fromUses;
  const elapsedHours = (
    Date.parse(latest.capturedAt) - Date.parse(first.capturedAt)
  ) / HOUR_IN_MILLISECONDS;

  return {
    fromCapturedAt: first.capturedAt,
    toCapturedAt: latest.capturedAt,
    fromUses,
    toUses,
    deltaUses,
    growthPercent: fromUses === 0 ? null : (deltaUses / fromUses) * 100,
    elapsedHours,
    usesPerDay: deltaUses * 24 / elapsedHours,
    exactness: first.exactness as Exclude<AudioTrendExactness, "unavailable">,
    sourceUrl: first.sourceUrl,
  };
}

function assertMetrics(
  metrics: unknown,
  context: string,
): asserts metrics is AudioTrendPublicMetrics {
  if (!isObject(metrics)) {
    throw new Error(`Métriques audio invalides : ${context}`);
  }
  assertOnlyKeys(metrics, METRIC_KEYS, `les métriques de ${context}`);
  if (METRIC_KEYS.some((key) => !isNullablePublicMetric(metrics[key]))) {
    throw new Error(`Métriques audio invalides : ${context}`);
  }
  if (METRIC_KEYS.every((key) => metrics[key] === null)) {
    throw new Error(`Métriques audio vides : ${context}`);
  }
}

function assertReferenceVideo(
  value: unknown,
  trend: Pick<AudioTrend, "id" | "platform">,
  feedCapturedTimestamp: number,
): asserts value is AudioTrendReferenceVideo {
  if (!isObject(value)) {
    throw new Error(`Vidéo de référence audio invalide : ${trend.id}`);
  }
  assertOnlyKeys(value, [
    "author",
    "caption",
    "url",
    "thumbnailUrl",
    "durationSeconds",
    "publishedAt",
    "capturedAt",
    "sourceLabel",
    "sourceUrl",
    "exactness",
    "metrics",
    "playbackUrl",
    "playbackCapturedAt",
    "playbackExpiresAt",
  ], `la vidéo de référence ${trend.id}`);
  const reference = value as AudioTrendReferenceVideo;
  const capturedTimestamp = isTimestamp(reference.capturedAt)
    ? Date.parse(reference.capturedAt)
    : Number.NaN;
  const publishedTimestamp = reference.publishedAt === null
    ? null
    : isTimestamp(reference.publishedAt)
      ? Date.parse(reference.publishedAt)
      : Number.NaN;
  if (
    !isText(reference.author) ||
    typeof reference.caption !== "string" ||
    !isNativeAudioReferenceVideoUrl(reference.url, trend.platform) ||
    (reference.thumbnailUrl !== null &&
      !isOfficialAudioTrendThumbnailUrl(reference.thumbnailUrl, trend.platform)) ||
    (reference.durationSeconds !== null &&
      (typeof reference.durationSeconds !== "number" ||
        !Number.isFinite(reference.durationSeconds) ||
        reference.durationSeconds <= 0)) ||
    !Number.isFinite(capturedTimestamp) ||
    capturedTimestamp > feedCapturedTimestamp ||
    (publishedTimestamp !== null &&
      (!Number.isFinite(publishedTimestamp) || publishedTimestamp > capturedTimestamp)) ||
    !isText(reference.sourceLabel) ||
    !isNativeAudioReferenceVideoUrl(reference.sourceUrl, trend.platform) ||
    canonicalUrl(reference.sourceUrl) !== canonicalUrl(reference.url) ||
    !VALID_EXACTNESS.has(reference.exactness)
  ) {
    throw new Error(`Vidéo de référence audio invalide : ${trend.id}`);
  }
  if (reference.metrics === null) {
    if (reference.exactness !== "unavailable") {
      throw new Error(`Métriques audio sans valeurs : ${trend.id}`);
    }
  } else {
    if (reference.exactness === "unavailable") {
      throw new Error(`Métriques audio inventées : ${trend.id}`);
    }
    assertMetrics(reference.metrics, trend.id);
  }
  if (
    reference.metrics === null ||
    reference.metrics.likes === null ||
    reference.metrics.likes < MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES
  ) {
    throw new Error(
      `Reference video for ${trend.id} is not publishable: ` +
      `at least ${MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES} public likes are required.`,
    );
  }
  if (
    reference.durationSeconds === null ||
    reference.durationSeconds <= 0 ||
    reference.durationSeconds >= MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS
  ) {
    throw new Error(
      `Reference video for ${trend.id} is not publishable: duration must be ` +
      `strictly greater than 0 and below ${MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS} seconds.`,
    );
  }

  const playbackFields = [
    reference.playbackUrl,
    reference.playbackCapturedAt,
    reference.playbackExpiresAt,
  ];
  const playbackAbsent = playbackFields.every((field) => field === undefined || field === null);
  if (!playbackAbsent) {
    const playbackCapturedTimestamp = isTimestamp(reference.playbackCapturedAt)
      ? Date.parse(reference.playbackCapturedAt)
      : Number.NaN;
    const playbackExpiresTimestamp = isTimestamp(reference.playbackExpiresAt)
      ? Date.parse(reference.playbackExpiresAt)
      : Number.NaN;
    if (
      trend.platform !== "instagram" ||
      typeof reference.playbackUrl !== "string" ||
      !isInstagramSignedPlaybackUrl(reference.playbackUrl, reference.playbackExpiresAt ?? undefined) ||
      !Number.isFinite(playbackCapturedTimestamp) ||
      !Number.isFinite(playbackExpiresTimestamp) ||
      playbackCapturedTimestamp > feedCapturedTimestamp ||
      playbackExpiresTimestamp <= feedCapturedTimestamp ||
      playbackExpiresTimestamp - playbackCapturedTimestamp < INSTAGRAM_PLAYBACK_MIN_VALIDITY_MS ||
      playbackExpiresTimestamp - playbackCapturedTimestamp > INSTAGRAM_PLAYBACK_MAX_VALIDITY_MS
    ) {
      throw new Error(`Lecture Instagram signée invalide : ${trend.id}`);
    }
  }
}

function assertUsageObservation(
  value: unknown,
  trend: Pick<AudioTrend, "id" | "platform">,
  feedCapturedTimestamp: number,
  previousTimestamp: number,
) {
  if (!isObject(value)) {
    throw new Error(`Observation d'usage audio invalide : ${trend.id}`);
  }
  assertOnlyKeys(value, [
    "capturedAt",
    "uses",
    "rank",
    "rankWindow",
    "sourceLabel",
    "sourceUrl",
    "exactness",
  ], `l'observation d'usage ${trend.id}`);
  const observation = value as AudioTrendUsageObservation;
  const timestamp = isTimestamp(observation.capturedAt)
    ? Date.parse(observation.capturedAt)
    : Number.NaN;
  const usesValid = observation.uses === null ||
    (typeof observation.uses === "number" &&
      Number.isSafeInteger(observation.uses) &&
      observation.uses >= 0);
  const rankValid = observation.rank === null ||
    (typeof observation.rank === "number" &&
      Number.isSafeInteger(observation.rank) &&
      observation.rank >= 1);
  if (
    !Number.isFinite(timestamp) ||
    timestamp <= previousTimestamp ||
    timestamp > feedCapturedTimestamp ||
    !usesValid ||
    !rankValid ||
    (observation.rank === null
      ? observation.rankWindow !== null
      : !isText(observation.rankWindow)) ||
    !isText(observation.sourceLabel) ||
    !isOfficialPlatformSourceUrl(observation.sourceUrl, trend.platform) ||
    !VALID_EXACTNESS.has(observation.exactness) ||
    (observation.exactness === "unavailable"
      ? observation.uses !== null || observation.rank !== null
      : observation.uses === null && observation.rank === null)
  ) {
    throw new Error(`Observation d'usage audio invalide : ${trend.id}`);
  }
  return timestamp;
}

function assertReuseEvidence(
  value: unknown,
  trend: Pick<AudioTrend, "id" | "platform">,
  feedCapturedTimestamp: number,
) {
  if (!isObject(value)) {
    throw new Error(`Preuve de réutilisation audio invalide : ${trend.id}`);
  }
  assertOnlyKeys(value, [
    "verifiedAt",
    "minimumDistinctCreators",
    "summary",
    "posts",
  ], `la preuve de réutilisation ${trend.id}`);
  const evidence = value as AudioTrendReuseEvidence;
  const verifiedTimestamp = isTimestamp(evidence.verifiedAt)
    ? Date.parse(evidence.verifiedAt)
    : Number.NaN;
  if (
    !Number.isFinite(verifiedTimestamp) ||
    verifiedTimestamp > feedCapturedTimestamp ||
    !Number.isSafeInteger(evidence.minimumDistinctCreators) ||
    evidence.minimumDistinctCreators < 3 ||
    !isText(evidence.summary) ||
    !Array.isArray(evidence.posts) ||
    evidence.posts.length < evidence.minimumDistinctCreators
  ) {
    throw new Error(`Preuve de réutilisation audio invalide : ${trend.id}`);
  }

  const authors = new Set<string>();
  const urls = new Set<string>();
  for (const postValue of evidence.posts) {
    if (!isObject(postValue)) {
      throw new Error(`Preuve de réutilisation audio invalide : ${trend.id}`);
    }
    assertOnlyKeys(postValue, [
      "platform",
      "author",
      "url",
      "capturedAt",
    ], `la publication de réutilisation ${trend.id}`);
    const post = postValue as AudioTrendReuseEvidencePost;
    const capturedTimestamp = isTimestamp(post.capturedAt)
      ? Date.parse(post.capturedAt)
      : Number.NaN;
    if (
      post.platform !== trend.platform ||
      !isText(post.author) ||
      !isNativeAudioReferenceVideoUrl(post.url, trend.platform) ||
      !Number.isFinite(capturedTimestamp) ||
      capturedTimestamp > verifiedTimestamp ||
      capturedTimestamp > feedCapturedTimestamp
    ) {
      throw new Error(`Preuve de réutilisation audio invalide : ${trend.id}`);
    }
    const authorIdentity = post.author.trim().replace(/^@/u, "").toLocaleLowerCase("en");
    const urlIdentity = canonicalUrl(post.url);
    if (authors.has(authorIdentity) || urls.has(urlIdentity)) {
      throw new Error(`Preuve de réutilisation audio dupliquée : ${trend.id}`);
    }
    authors.add(authorIdentity);
    urls.add(urlIdentity);
  }
  if (
    authors.size < evidence.minimumDistinctCreators ||
    urls.size < evidence.minimumDistinctCreators
  ) {
    throw new Error(`Preuve multi-créateurs insuffisante : ${trend.id}`);
  }
}

export function assertAudioTrendFeed(value: unknown): AudioTrendFeed {
  if (!isObject(value)) {
    throw new Error("Snapshot Audio Trends invalide.");
  }
  assertOnlyKeys(value, [
    "version",
    "capturedAt",
    "nextRefreshAt",
    "cadenceHours",
    "methodology",
    "sourceChecks",
    "trends",
  ], "le snapshot Audio Trends");
  const feed = value as AudioTrendFeed;
  const capturedTimestamp = isTimestamp(feed.capturedAt)
    ? Date.parse(feed.capturedAt)
    : Number.NaN;
  const nextRefreshTimestamp = isTimestamp(feed.nextRefreshAt)
    ? Date.parse(feed.nextRefreshAt)
    : Number.NaN;
  if (
    feed.version !== 1 ||
    feed.cadenceHours !== AUDIO_TREND_REFRESH_CADENCE_HOURS ||
    !Number.isFinite(capturedTimestamp) ||
    !Number.isFinite(nextRefreshTimestamp) ||
    nextRefreshTimestamp <= capturedTimestamp ||
    nextRefreshTimestamp - capturedTimestamp >
      AUDIO_TREND_REFRESH_CADENCE_HOURS * HOUR_IN_MILLISECONDS ||
    !isText(feed.methodology) ||
    !Array.isArray(feed.sourceChecks) ||
    !Array.isArray(feed.trends)
  ) {
    throw new Error("Snapshot Audio Trends invalide.");
  }
  if (feed.trends.length < MIN_PUBLISHABLE_AUDIO_TRENDS) {
    throw new Error(
      `Snapshot Audio Trends incomplet : au moins ${MIN_PUBLISHABLE_AUDIO_TRENDS} tendances distinctes sont requises.`,
    );
  }

  const sourceCheckIds = new Set<string>();
  const checkedPlatforms = new Set<AudioTrendPlatform>();
  for (const sourceCheckValue of feed.sourceChecks) {
    if (!isObject(sourceCheckValue)) {
      throw new Error("Contrôle de source Audio Trends invalide.");
    }
    assertOnlyKeys(sourceCheckValue, [
      "id",
      "platform",
      "status",
      "checkedAt",
      "label",
      "sourceUrl",
    ], "le contrôle de source Audio Trends");
    const sourceCheck = sourceCheckValue as AudioTrendSourceCheck;
    const checkedTimestamp = sourceCheck.checkedAt === null
      ? null
      : isTimestamp(sourceCheck.checkedAt)
        ? Date.parse(sourceCheck.checkedAt)
        : Number.NaN;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sourceCheck.id) ||
      sourceCheckIds.has(sourceCheck.id) ||
      !VALID_PLATFORMS.has(sourceCheck.platform) ||
      checkedPlatforms.has(sourceCheck.platform) ||
      !VALID_SOURCE_STATUSES.has(sourceCheck.status) ||
      !isText(sourceCheck.label) ||
      !isOfficialPlatformSourceUrl(sourceCheck.sourceUrl, sourceCheck.platform) ||
      (sourceCheck.status === "pending"
        ? sourceCheck.checkedAt !== null
        : checkedTimestamp === null ||
          !Number.isFinite(checkedTimestamp) ||
          checkedTimestamp > capturedTimestamp)
    ) {
      throw new Error(`Contrôle de source Audio Trends invalide : ${sourceCheck.id ?? "inconnu"}`);
    }
    sourceCheckIds.add(sourceCheck.id);
    checkedPlatforms.add(sourceCheck.platform);
  }
  if (checkedPlatforms.size !== PLATFORMS.length) {
    throw new Error("Une source Audio Trends est requise pour chaque plateforme prise en charge.");
  }

  const trendIds = new Set<string>();
  const nativeAudioUrls = new Set<string>();
  const referenceVideoUrls = new Set<string>();
  for (const trendValue of feed.trends) {
    if (!isObject(trendValue)) {
      throw new Error("Trend audio invalide.");
    }
    assertOnlyKeys(trendValue, [
      "id",
      "platform",
      "type",
      "title",
      "author",
      "audioUrl",
      "source",
      "referenceVideo",
      "usageObservations",
      "reuseEvidence",
      "lofiFitScore",
      "lofiAngle",
      "lofiFitRationale",
      "proposals",
    ], "la trend audio");
    const trend = trendValue as AudioTrend;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(trend.id) ||
      trendIds.has(trend.id) ||
      !VALID_PLATFORMS.has(trend.platform) ||
      !VALID_TYPES.has(trend.type) ||
      !isText(trend.title) ||
      !isText(trend.author) ||
      !isNativeAudioTrendUrl(trend.audioUrl, trend.platform) ||
      !isScore(trend.lofiFitScore) ||
      !isText(trend.lofiAngle) ||
      trend.lofiAngle.length > 220 ||
      /[\r\n]/u.test(trend.lofiAngle) ||
      !isText(trend.lofiFitRationale) ||
      trend.lofiFitRationale.length > 300 ||
      !Array.isArray(trend.proposals) ||
      trend.proposals.length !== 7 ||
      !Array.isArray(trend.usageObservations) ||
      trend.usageObservations.length === 0
    ) {
      throw new Error(`Trend audio invalide : ${trend.id ?? "inconnue"}`);
    }
    trendIds.add(trend.id);
    const audioIdentity = `${trend.platform}:${canonicalUrl(trend.audioUrl)}`;
    if (nativeAudioUrls.has(audioIdentity)) {
      throw new Error(`Audio natif dupliqué : ${trend.audioUrl}`);
    }
    nativeAudioUrls.add(audioIdentity);

    const proposalIds = new Set<string>();
    const proposalTitles = new Set<string>();
    const proposalConcepts = new Set<string>();
    const proposalCopies = new Set<string>();
    let lofiGirlProposalCount = 0;
    for (const proposalValue of trend.proposals) {
      if (!isObject(proposalValue)) {
        throw new Error(`Proposition audio invalide : ${trend.id}`);
      }
      assertOnlyKeys(proposalValue, [
        "id",
        "title",
        "concept",
        "copy",
        "character",
        "tone",
      ], `la proposition audio de ${trend.id}`);
      const proposal = proposalValue as AudioTrendProposal;
      const normalizedTitle = typeof proposal.title === "string"
        ? proposal.title.trim().toLocaleLowerCase("fr")
        : "";
      const normalizedConcept = typeof proposal.concept === "string"
        ? proposal.concept.trim().toLocaleLowerCase("fr")
        : "";
      const normalizedCopy = typeof proposal.copy === "string"
        ? proposal.copy.trim().toLocaleLowerCase("fr")
        : "";
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(proposal.id) ||
        proposalIds.has(proposal.id) ||
        !isText(proposal.title) ||
        !isText(proposal.concept) ||
        !isText(proposal.copy) ||
        !VALID_PROPOSAL_CHARACTERS.has(proposal.character) ||
        !VALID_PROPOSAL_TONES.has(proposal.tone) ||
        proposalTitles.has(normalizedTitle) ||
        proposalConcepts.has(normalizedConcept) ||
        proposalCopies.has(normalizedCopy)
      ) {
        throw new Error(`Proposition audio invalide : ${trend.id}`);
      }
      proposalIds.add(proposal.id);
      proposalTitles.add(normalizedTitle);
      proposalConcepts.add(normalizedConcept);
      proposalCopies.add(normalizedCopy);
      if (proposal.character === "lofi-girl") lofiGirlProposalCount += 1;
    }
    if (lofiGirlProposalCount < 6) {
      throw new Error(`Focus Lofi Girl insuffisant : ${trend.id}`);
    }

    if (!isObject(trend.source)) {
      throw new Error(`Provenance audio invalide : ${trend.id}`);
    }
    assertOnlyKeys(trend.source, ["capturedAt", "label", "url", "exactness"], `la provenance ${trend.id}`);
    const sourceTimestamp = isTimestamp(trend.source.capturedAt)
      ? Date.parse(trend.source.capturedAt)
      : Number.NaN;
    if (
      !Number.isFinite(sourceTimestamp) ||
      sourceTimestamp > capturedTimestamp ||
      !isText(trend.source.label) ||
      !isNativeAudioTrendUrl(trend.source.url, trend.platform) ||
      canonicalUrl(trend.source.url) !== canonicalUrl(trend.audioUrl) ||
      !["exact", "platform-estimate"].includes(trend.source.exactness)
    ) {
      throw new Error(`Provenance audio invalide : ${trend.id}`);
    }

    assertReferenceVideo(trend.referenceVideo, trend, capturedTimestamp);
    const referenceIdentity = `${trend.platform}:${canonicalUrl(trend.referenceVideo.url)}`;
    if (referenceVideoUrls.has(referenceIdentity)) {
      throw new Error(`Vidéo de référence audio dupliquée : ${trend.referenceVideo.url}`);
    }
    referenceVideoUrls.add(referenceIdentity);
    assertReuseEvidence(trend.reuseEvidence, trend, capturedTimestamp);
    let previousObservationTimestamp = Number.NEGATIVE_INFINITY;
    for (const observation of trend.usageObservations) {
      previousObservationTimestamp = assertUsageObservation(
        observation,
        trend,
        capturedTimestamp,
        previousObservationTimestamp,
      );
    }
  }

  if (
    trendIds.size < MIN_PUBLISHABLE_AUDIO_TRENDS ||
    nativeAudioUrls.size < MIN_PUBLISHABLE_AUDIO_TRENDS ||
    referenceVideoUrls.size < MIN_PUBLISHABLE_AUDIO_TRENDS
  ) {
    throw new Error(
      `Snapshot Audio Trends incomplet : ${MIN_PUBLISHABLE_AUDIO_TRENDS} identités, audios et références distincts sont requis.`,
    );
  }

  return feed;
}
