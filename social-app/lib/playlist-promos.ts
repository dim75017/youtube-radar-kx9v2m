export type PlaylistPromoPlatform =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "pinterest";

export type PlaylistPromoLane = "organic" | "paid";
export type PlaylistPromoPaidStatus = "unknown" | "verified-paid" | "organic-only";
export type PlaylistPromoProductType = "ad" | "organic" | "unknown";
export type PlaylistPromoMetricScope = "native-post" | "ad-delivery";
export type PlaylistDestination =
  | "spotify"
  | "apple-music"
  | "youtube-music"
  | "deezer"
  | "multi-dsp"
  | "unknown";
export type PlaylistPromoMetricPrecision = "exact" | "platform-rounded";
export type PlaylistPromoCreativeFamily =
  | "problem-solution"
  | "relatable-meme"
  | "playlist-proof"
  | "mood-scene"
  | "reaction"
  | "direct-benefit";

export type PlaylistPromoObservation = {
  capturedAt: string;
  likes: number;
  comments: number | null;
  views: number | null;
  shares: number | null;
  precision: PlaylistPromoMetricPrecision;
  metricScope: PlaylistPromoMetricScope;
  sourceLabel: string;
  sourceUrl: string;
};

export type PlaylistPromoCreative = {
  family: PlaylistPromoCreativeFamily;
  hook: string;
  mechanic: string;
  cta: string;
  lofiAdaptation: string;
  riskNote: string | null;
  assetBriefId: string;
};

export type PlaylistPromoItem = {
  id: string;
  platform: PlaylistPromoPlatform;
  lane: PlaylistPromoLane;
  paidStatus: PlaylistPromoPaidStatus;
  productType: PlaylistPromoProductType;
  paidEvidence: string | null;
  author: string;
  title: string;
  caption: string;
  url: string;
  publishedOn: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  destination: PlaylistDestination;
  destinationUrl: string | null;
  destinationConfidence: "confirmed" | "likely" | "unknown";
  destinationEvidence: string;
  adLibraryId: string | null;
  reachBand: string | null;
  tags: string[];
  creative: PlaylistPromoCreative;
  observations: PlaylistPromoObservation[];
};

export type PlaylistPromoAssetBrief = {
  id: string;
  title: string;
  priority: 1 | 2 | 3;
  playlistUseCase: string;
  character: "lofi-girl" | "lofi-boy" | "lofi-cafe";
  durationSeconds: number;
  hook: string;
  shotList: string[];
  onScreenCopy: string;
  cta: string;
  requiredAssets: string[];
  guardrails: string[];
};

export type PlaylistPromoSourceCheck = {
  id: string;
  platform: PlaylistPromoPlatform;
  lane: PlaylistPromoLane;
  status: "success" | "limited" | "pending" | "failed";
  checkedAt: string | null;
  label: string;
  sourceUrl: string;
  note: string;
};

export type PlaylistPromoFeed = {
  version: 2;
  capturedAt: string;
  nextRefreshAt: string;
  cadenceHours: 24;
  minimumOrganicLikes: 10_000;
  methodology: string;
  limitations: string[];
  sourceChecks: PlaylistPromoSourceCheck[];
  items: PlaylistPromoItem[];
  candidates: PlaylistPromoItem[];
  assetBriefs: PlaylistPromoAssetBrief[];
};

export const PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES = 10_000;
export const PLAYLIST_PROMO_CADENCE_HOURS = 24;

const PLATFORMS = new Set<PlaylistPromoPlatform>([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "pinterest",
]);
const LANES = new Set<PlaylistPromoLane>(["organic", "paid"]);
const PAID_STATUSES = new Set<PlaylistPromoPaidStatus>([
  "unknown",
  "verified-paid",
  "organic-only",
]);
const PRODUCT_TYPES = new Set<PlaylistPromoProductType>([
  "ad",
  "organic",
  "unknown",
]);
const METRIC_SCOPES = new Set<PlaylistPromoMetricScope>([
  "native-post",
  "ad-delivery",
]);
const DESTINATIONS = new Set<PlaylistDestination>([
  "spotify",
  "apple-music",
  "youtube-music",
  "deezer",
  "multi-dsp",
  "unknown",
]);
const PRECISIONS = new Set<PlaylistPromoMetricPrecision>([
  "exact",
  "platform-rounded",
]);
const CREATIVE_FAMILIES = new Set<PlaylistPromoCreativeFamily>([
  "problem-solution",
  "relatable-meme",
  "playlist-proof",
  "mood-scene",
  "reaction",
  "direct-benefit",
]);
const LOCAL_THUMBNAIL =
  /^media\/playlist-promos\/[A-Za-z0-9_-]+\.(?:avif|jpe?g|png|webp)$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isNullableMetric(value: unknown) {
  return value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function canonicalUrl(value: string) {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function isNativePostUrl(value: string, platform: PlaylistPromoPlatform) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "");
    if (url.protocol !== "https:") return false;
    if (platform === "instagram") {
      return (host === "instagram.com" || host.endsWith(".instagram.com")) &&
        /^\/(?:p|reel|reels)\/[A-Za-z0-9_-]+$/u.test(path);
    }
    if (platform === "tiktok") {
      return (host === "tiktok.com" || host.endsWith(".tiktok.com")) &&
        /^\/@[^/]+\/video\/\d{12,24}$/u.test(path);
    }
    if (platform === "youtube") {
      return (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") &&
        (/^\/shorts\/[A-Za-z0-9_-]{11}$/u.test(path) || /^\/[A-Za-z0-9_-]{11}$/u.test(path));
    }
    return isHttpsUrl(value);
  } catch {
    return false;
  }
}

export function latestPlaylistPromoObservation(item: PlaylistPromoItem) {
  return [...item.observations].sort(
    (left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt),
  )[0] ?? null;
}

export function playlistPromoLikeDelta(item: PlaylistPromoItem) {
  if (item.observations.length < 2) return null;
  const observations = [...item.observations].sort(
    (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
  );
  const first = observations[0];
  const latest = observations.at(-1)!;
  if (first.precision !== latest.precision) return null;
  return {
    likes: latest.likes - first.likes,
    elapsedHours: (Date.parse(latest.capturedAt) - Date.parse(first.capturedAt)) / 3_600_000,
  };
}

export function assertPlaylistPromoFeed(value: unknown): PlaylistPromoFeed {
  if (!isObject(value)) throw new Error("Feed Pubs playlists invalide.");
  const feed = value as PlaylistPromoFeed;
  const capturedAt = Date.parse(feed.capturedAt);
  const nextRefreshAt = Date.parse(feed.nextRefreshAt);
  if (
    feed.version !== 2 ||
    feed.cadenceHours !== PLAYLIST_PROMO_CADENCE_HOURS ||
    feed.minimumOrganicLikes !== PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(nextRefreshAt) ||
    nextRefreshAt <= capturedAt ||
    nextRefreshAt - capturedAt > PLAYLIST_PROMO_CADENCE_HOURS * 3_600_000 ||
    !isText(feed.methodology) ||
    !Array.isArray(feed.limitations) ||
    !feed.limitations.every(isText) ||
    !Array.isArray(feed.sourceChecks) ||
    !Array.isArray(feed.items) ||
    !Array.isArray(feed.candidates) ||
    !Array.isArray(feed.assetBriefs)
  ) {
    throw new Error("Feed Pubs playlists incomplet.");
  }

  const briefIds = new Set<string>();
  for (const brief of feed.assetBriefs) {
    if (
      !isObject(brief) ||
      !SLUG.test(brief.id) ||
      briefIds.has(brief.id) ||
      !isText(brief.title) ||
      ![1, 2, 3].includes(brief.priority) ||
      !isText(brief.playlistUseCase) ||
      !["lofi-girl", "lofi-boy", "lofi-cafe"].includes(brief.character) ||
      !Number.isSafeInteger(brief.durationSeconds) ||
      brief.durationSeconds < 6 ||
      brief.durationSeconds > 30 ||
      !isText(brief.hook) ||
      !Array.isArray(brief.shotList) ||
      brief.shotList.length < 3 ||
      !brief.shotList.every(isText) ||
      !isText(brief.onScreenCopy) ||
      !isText(brief.cta) ||
      !Array.isArray(brief.requiredAssets) ||
      !brief.requiredAssets.every(isText) ||
      !Array.isArray(brief.guardrails) ||
      !brief.guardrails.every(isText)
    ) {
      throw new Error(`Brief asset invalide : ${brief?.id ?? "inconnu"}`);
    }
    briefIds.add(brief.id);
  }

  const itemIds = new Set<string>();
  const itemUrls = new Set<string>();
  const trackedItems = [
    ...feed.items.map((item) => ({ item, qualified: true })),
    ...feed.candidates.map((item) => ({ item, qualified: false })),
  ];
  for (const { item, qualified } of trackedItems) {
    if (
      !isObject(item) ||
      !SLUG.test(item.id) ||
      itemIds.has(item.id) ||
      !PLATFORMS.has(item.platform) ||
      !LANES.has(item.lane) ||
      !PAID_STATUSES.has(item.paidStatus) ||
      !PRODUCT_TYPES.has(item.productType) ||
      (item.paidEvidence !== null && !isText(item.paidEvidence)) ||
      !isText(item.author) ||
      !isText(item.title) ||
      typeof item.caption !== "string" ||
      !isNativePostUrl(item.url, item.platform) ||
      !DAY.test(item.publishedOn) ||
      (item.durationSeconds !== null &&
        (!Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0 || item.durationSeconds > 300)) ||
      (item.thumbnailUrl !== null && !LOCAL_THUMBNAIL.test(item.thumbnailUrl)) ||
      !DESTINATIONS.has(item.destination) ||
      (item.destinationUrl !== null && !isHttpsUrl(item.destinationUrl)) ||
      !["confirmed", "likely", "unknown"].includes(item.destinationConfidence) ||
      !isText(item.destinationEvidence) ||
      (item.adLibraryId !== null && !isText(item.adLibraryId)) ||
      (item.reachBand !== null && !isText(item.reachBand)) ||
      !Array.isArray(item.tags) ||
      !item.tags.every(isText) ||
      !isObject(item.creative) ||
      !CREATIVE_FAMILIES.has(item.creative.family) ||
      !isText(item.creative.hook) ||
      !isText(item.creative.mechanic) ||
      !isText(item.creative.cta) ||
      !isText(item.creative.lofiAdaptation) ||
      (item.creative.riskNote !== null && !isText(item.creative.riskNote)) ||
      !briefIds.has(item.creative.assetBriefId) ||
      !Array.isArray(item.observations) ||
      item.observations.length === 0
    ) {
      throw new Error(`Création playlist invalide : ${item?.id ?? "inconnue"}`);
    }
    const identity = canonicalUrl(item.url);
    if (itemUrls.has(identity)) throw new Error(`URL playlist dupliquée : ${item.url}`);
    if (item.paidStatus === "verified-paid" && item.lane !== "paid") {
      throw new Error(`Statut paid incohérent : ${item.id}`);
    }
    if (
      item.productType === "ad" &&
      (item.paidStatus !== "verified-paid" || item.lane !== "paid" || !isText(item.paidEvidence))
    ) {
      throw new Error(`Preuve product_type paid incohérente : ${item.id}`);
    }
    if (
      item.productType === "organic" &&
      (item.paidStatus !== "organic-only" || item.lane !== "organic")
    ) {
      throw new Error(`Statut organique incohérent : ${item.id}`);
    }
    if (item.destinationConfidence === "unknown" && item.destinationUrl !== null) {
      throw new Error(`Destination inconnue avec URL : ${item.id}`);
    }
    itemIds.add(item.id);
    itemUrls.add(identity);

    let previousAt = Number.NEGATIVE_INFINITY;
    for (const observation of item.observations) {
      const observedAt = Date.parse(observation.capturedAt);
      if (
        !Number.isFinite(observedAt) ||
        observedAt > capturedAt ||
        observedAt <= previousAt ||
        !Number.isSafeInteger(observation.likes) ||
        observation.likes < 0 ||
        !isNullableMetric(observation.comments) ||
        !isNullableMetric(observation.views) ||
        !isNullableMetric(observation.shares) ||
        !PRECISIONS.has(observation.precision) ||
        !METRIC_SCOPES.has(observation.metricScope) ||
        !isText(observation.sourceLabel) ||
        !isHttpsUrl(observation.sourceUrl) ||
        canonicalUrl(observation.sourceUrl) !== identity
      ) {
        throw new Error(`Observation playlist invalide : ${item.id}`);
      }
      previousAt = observedAt;
    }
    const latest = latestPlaylistPromoObservation(item);
    if (!latest) {
      throw new Error(`Observation playlist absente : ${item.id}`);
    }
    if (qualified && latest.likes < feed.minimumOrganicLikes) {
      throw new Error(`Seuil de likes non atteint : ${item.id}`);
    }
    if (!qualified && latest.likes >= feed.minimumOrganicLikes) {
      throw new Error(`Candidat déjà qualifié : ${item.id}`);
    }
    if (latest.metricScope !== "native-post") {
      throw new Error(`Les likes qualifiants doivent venir du post natif : ${item.id}`);
    }
  }

  const sourceIds = new Set<string>();
  for (const source of feed.sourceChecks) {
    if (
      !isObject(source) ||
      !SLUG.test(source.id) ||
      sourceIds.has(source.id) ||
      !PLATFORMS.has(source.platform) ||
      !LANES.has(source.lane) ||
      !["success", "limited", "pending", "failed"].includes(source.status) ||
      (source.checkedAt !== null && (!isTimestamp(source.checkedAt) || Date.parse(source.checkedAt) > capturedAt)) ||
      !isText(source.label) ||
      !isHttpsUrl(source.sourceUrl) ||
      !isText(source.note)
    ) {
      throw new Error(`Source Pubs playlists invalide : ${source?.id ?? "inconnue"}`);
    }
    sourceIds.add(source.id);
  }

  return feed;
}
