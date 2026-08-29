import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPublishableSocialTrendFeed,
  assertSocialTrendFeed,
  isActionableSocialTrend,
  MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
  MIN_TREND_DISCOVERY_CANDIDATE_URLS,
  MIN_TREND_DISCOVERY_PARSED_SOURCES,
  trendPriorityScore,
} from "../lib/social-trends.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = resolve(root, "data", "trends", "feed.json");
const watchlistsPath = resolve(root, "data", "trends", "watchlists.json");
const statusPath = resolve(root, "data", "trends", "refresh-status.json");
const REQUEST_TIMEOUT_MS = 20_000;
const NATIVE_POST_TIMEOUT_MS = 12_000;
const NATIVE_POST_CONCURRENCY = 8;
const PARIS_TIMEZONE = "Europe/Paris";
const MAX_DISCOVERY_CANDIDATE_URLS = 200;
const MAX_SOURCE_CANDIDATE_URLS = 60;
const MAX_PERSISTED_CANDIDATE_OBSERVATIONS = 200;
const CANDIDATE_OBSERVATION_MAX_AGE_DAYS = 30;
const YOUTUBE_SEARCH_RESULT_LIMIT = 30;
const MAX_QUALIFIED_ACTIONABLE_TRENDS = 60;

const VIDEO_PROMOTION_RECIPES = [
  {
    id: "same-age-as-parents",
    trendKey: "same-age-as-parents",
    clusterKey: "format:same-age-as-parents",
    sourceId: "socialpilot-tiktok",
    referenceUrl: "https://www.tiktok.com/@hope_schwing/video/7667660831471045918",
    youtubeQueries: [
      '"me vs my parents at the same age" shorts',
      '"my parents at my age" trend shorts',
    ],
    youtubeTitlePatterns: [
      /same age as my parents/iu,
      /parents at my age/iu,
      /me vs my parents at the same age/iu,
      /me and my (?:mom|dad) at my age/iu,
      /(?:mom|dad) and i were the same age/iu,
    ],
  },
];

function cleanExtractedUrl(value) {
  return String(value ?? "")
    .replace(/&amp;/giu, "&")
    .replace(/&#0*38;/giu, "&")
    .replace(/[),.;!?\]}]+$/u, "");
}

export function canonicalNativeTrendCandidateUrl(value) {
  try {
    const url = new URL(cleanExtractedUrl(value));
    const host = url.hostname.toLowerCase().replace(/^www\./u, "").replace(/^m\./u, "");
    const path = url.pathname.replace(/\/+$/u, "");

    if (host === "tiktok.com") {
      const match = path.match(/^\/@([^/]+)\/video\/(\d{12,24})$/iu);
      return match ? `https://www.tiktok.com/@${match[1]}/video/${match[2]}` : null;
    }
    if (host === "instagram.com") {
      const match = path.match(/^\/(reel|reels|p)\/([A-Za-z0-9_-]{5,})$/u);
      if (!match) return null;
      const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
      return `https://www.instagram.com/${kind}/${match[2]}/`;
    }
    if (host === "youtube.com") {
      const shortsId = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/u)?.[1];
      if (shortsId) return `https://www.youtube.com/shorts/${shortsId}`;
      const watchId = path === "/watch" ? url.searchParams.get("v") : null;
      return /^[A-Za-z0-9_-]{11}$/u.test(watchId ?? "")
        ? `https://www.youtube.com/watch?v=${watchId}`
        : null;
    }
    if (host === "x.com" || host === "twitter.com") {
      const match = path.match(/^\/([^/]+)\/status\/(\d+)$/iu);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractNativeTrendCandidateUrls(sourceText) {
  const decoded = String(sourceText ?? "")
    .replace(/\\u002f/giu, "/")
    .replace(/\\\//gu, "/")
    .replace(/&quot;|&#0*34;/giu, '"');
  const urls = decoded.match(/https?:\/\/[^\s"'<>\\]+/giu) ?? [];
  return [...new Set(urls.map(canonicalNativeTrendCandidateUrl).filter(Boolean))].sort();
}

export function nativeTrendVerificationRequest(post) {
  const url = new URL(post.url);
  if (post.platform === "tiktok") {
    const id = url.pathname.match(/\/video\/(\d{12,24})/iu)?.[1];
    if (!id) throw new Error("identifiant TikTok absent");
    return {
      url: `https://www.tiktok.com/oembed?url=${encodeURIComponent(post.url)}`,
      marker: id,
    };
  }
  if (post.platform === "youtube") {
    const id = url.pathname.match(/\/(?:shorts|watch)\/([A-Za-z0-9_-]{11})/iu)?.[1]
      ?? url.searchParams.get("v");
    if (!id) throw new Error("identifiant YouTube absent");
    return {
      url: `https://www.youtube.com/oembed?url=${encodeURIComponent(post.url)}&format=json`,
      marker: id,
    };
  }
  if (post.platform === "x") {
    const id = url.pathname.match(/\/status\/(\d+)/iu)?.[1];
    if (!id) throw new Error("identifiant X absent");
    return {
      url: `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(post.url)}`,
      marker: id,
    };
  }
  const shortcode = url.pathname.match(/\/(?:p|reel|reels)\/([^/]+)/iu)?.[1];
  if (!shortcode) throw new Error("identifiant Instagram absent");
  return { url: post.url, marker: shortcode };
}

export async function verifyNativeTrendPost(post, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = nativeTrendVerificationRequest(post);
  const response = await fetchImpl(request.url, {
    headers: {
      Accept: "text/html,application/json,application/xhtml+xml",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(NATIVE_POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (!body.includes(request.marker)) {
    throw new Error("identité du post absente de la réponse");
  }
  return true;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function jsonObjectAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const objectStart = source.indexOf("{", markerIndex + marker.length);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart, index + 1);
    }
  }
  return null;
}

function nullableNativeMetric(value) {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

function normalizedCreator(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^@+/u, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("fr");
}

export function parseTikTokTrendCandidateHtml(html, candidateUrl, capturedAt) {
  const canonicalUrl = canonicalNativeTrendCandidateUrl(candidateUrl);
  const postId = canonicalUrl?.match(/\/video\/(\d{12,24})$/u)?.[1];
  if (!canonicalUrl || !postId || nativeTrendCandidatePlatform(canonicalUrl) !== "tiktok") {
    throw new Error("URL candidate TikTok invalide");
  }
  const scriptMatch = String(html).match(
    /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/iu,
  );
  if (!scriptMatch) throw new Error("métadonnées natives TikTok absentes");
  let payload;
  try {
    payload = JSON.parse(scriptMatch[1]);
  } catch {
    throw new Error("métadonnées natives TikTok illisibles");
  }
  const item = payload?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  if (!item || String(item.id) !== postId) {
    throw new Error("identité TikTok candidate incohérente");
  }
  const authorId = String(item.author?.uniqueId ?? "").trim();
  const musicId = String(item.music?.id ?? "").trim();
  const durationSeconds = nullableNativeMetric(item.video?.duration);
  if (!authorId || !musicId || !durationSeconds) {
    throw new Error("auteur, son ou durée TikTok absent");
  }
  const createTimeSeconds = nullableNativeMetric(item.createTime);
  const publishedAt = createTimeSeconds === null
    ? null
    : new Date(createTimeSeconds * 1_000).toISOString();
  const thumbnailUrl = [item.video?.cover, item.video?.dynamicCover, item.video?.originCover]
    .find((value) => typeof value === "string" && /^https:\/\//u.test(value)) ?? null;
  return {
    platform: "tiktok",
    url: canonicalUrl,
    nativeId: postId,
    author: `@${authorId}`,
    caption: String(item.desc ?? "").trim(),
    publishedAt,
    capturedAt,
    durationSeconds,
    thumbnailUrl,
    metrics: {
      views: nullableNativeMetric(item.stats?.playCount),
      likes: nullableNativeMetric(item.stats?.diggCount),
      comments: nullableNativeMetric(item.stats?.commentCount),
      shares: nullableNativeMetric(item.stats?.shareCount),
    },
    music: {
      id: musicId,
      title: String(item.music?.title ?? "").trim() || null,
      author: String(item.music?.authorName ?? "").trim() || null,
    },
  };
}

async function fetchTikTokTrendCandidate(candidateUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const capturedAt = options.now ?? new Date().toISOString();
  const response = await fetchImpl(candidateUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(NATIVE_POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseTikTokTrendCandidateHtml(await response.text(), candidateUrl, capturedAt);
}

export async function auditTikTokTrendCandidates(candidateUrls, options = {}) {
  const tiktokUrls = [...new Set(candidateUrls
    .map(canonicalNativeTrendCandidateUrl)
    .filter((url) => url && nativeTrendCandidatePlatform(url) === "tiktok"))].sort();
  const checks = await mapWithConcurrency(
    tiktokUrls,
    options.concurrency ?? NATIVE_POST_CONCURRENCY,
    async (url) => {
      try {
        return {
          ok: true,
          observation: await fetchTikTokTrendCandidate(url, options),
        };
      } catch (error) {
        return {
          ok: false,
          url,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  return {
    checkedUrls: tiktokUrls,
    observations: checks.filter((check) => check.ok).map((check) => check.observation),
    failures: checks.filter((check) => !check.ok),
  };
}

export function mergeTrendCandidateObservations(previous, current, now) {
  const minimumTimestamp = Date.parse(now) -
    CANDIDATE_OBSERVATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
  const observations = new Map();
  for (const observation of Array.isArray(previous) ? previous : []) {
    const url = canonicalNativeTrendCandidateUrl(observation?.url);
    const lastObservedTimestamp = Date.parse(
      observation?.lastObservedAt ?? observation?.capturedAt ?? "",
    );
    if (!url || !Number.isFinite(lastObservedTimestamp) || lastObservedTimestamp < minimumTimestamp) {
      continue;
    }
    observations.set(url, { ...observation, url });
  }
  for (const observation of current) {
    const url = canonicalNativeTrendCandidateUrl(observation?.url);
    if (!url) continue;
    const existing = observations.get(url);
    observations.set(url, {
      ...existing,
      ...observation,
      url,
      firstObservedAt: existing?.firstObservedAt ?? observation.capturedAt,
      lastObservedAt: observation.capturedAt,
    });
  }
  return [...observations.values()]
    .sort((left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt))
    .slice(0, MAX_PERSISTED_CANDIDATE_OBSERVATIONS);
}

export function qualifiedTikTokMusicClusters(candidateObservations) {
  const groups = Map.groupBy(
    candidateObservations.filter((observation) =>
      observation?.platform === "tiktok" && observation?.music?.id),
    (observation) => observation.music.id,
  );
  return [...groups.entries()].flatMap(([musicId, observations]) => {
    const creators = new Set(observations.map((observation) =>
      normalizedCreator(observation.author)).filter(Boolean));
    const reference = observations
      .filter((observation) =>
        observation.durationSeconds < 30 &&
        observation.metrics?.likes !== null &&
        observation.metrics.likes >= 50_000)
      .sort((left, right) => right.metrics.likes - left.metrics.likes)[0];
    if (creators.size < 3 || !reference) return [];
    return [{
      musicId,
      musicTitle: reference.music.title,
      musicAuthor: reference.music.author,
      distinctCreators: creators.size,
      referenceUrl: reference.url,
      postUrls: [...new Set(observations.map((observation) => observation.url))].sort(),
    }];
  });
}

export function extractYouTubeShortSearchResults(html) {
  const json = jsonObjectAfterMarker(String(html), "var ytInitialData = ");
  if (!json) throw new Error("résultats YouTube publics absents");
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("résultats YouTube publics illisibles");
  }
  const results = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const lockup = value.shortsLockupViewModel;
    const videoId = lockup?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const title = lockup?.overlayMetadata?.primaryText?.content;
    if (/^[A-Za-z0-9_-]{11}$/u.test(videoId ?? "") && typeof title === "string") {
      results.push({
        videoId,
        title: title.trim(),
        url: `https://www.youtube.com/shorts/${videoId}`,
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return [...new Map(results.map((result) => [result.videoId, result])).values()]
    .slice(0, YOUTUBE_SEARCH_RESULT_LIMIT);
}

export function parseYouTubeShortMetadataHtml(html, candidateUrl, capturedAt) {
  const canonicalUrl = canonicalNativeTrendCandidateUrl(candidateUrl);
  const videoId = canonicalUrl?.match(/\/shorts\/([A-Za-z0-9_-]{11})$/u)?.[1];
  if (!canonicalUrl || !videoId) throw new Error("URL candidate YouTube Shorts invalide");
  const playerJson = jsonObjectAfterMarker(String(html), "var ytInitialPlayerResponse = ");
  if (!playerJson) throw new Error("métadonnées natives YouTube absentes");
  let player;
  try {
    player = JSON.parse(playerJson);
  } catch {
    throw new Error("métadonnées natives YouTube illisibles");
  }
  const details = player?.videoDetails;
  if (!details || details.videoId !== videoId) {
    throw new Error("identité YouTube candidate incohérente");
  }
  const author = String(details.author ?? "").trim();
  const durationSeconds = nullableNativeMetric(details.lengthSeconds);
  if (!author || !durationSeconds) throw new Error("auteur ou durée YouTube absent");
  const microformat = player?.microformat?.playerMicroformatRenderer;
  const publishedAt = typeof microformat?.uploadDate === "string"
    ? new Date(microformat.uploadDate).toISOString()
    : typeof microformat?.publishDate === "string"
      ? new Date(microformat.publishDate).toISOString()
      : null;
  const likeCount = String(html).match(/"likeCount":"(\d+)"/u)?.[1] ?? null;
  const thumbnails = Array.isArray(details.thumbnail?.thumbnails)
    ? details.thumbnail.thumbnails
    : [];
  return {
    platform: "youtube",
    url: canonicalUrl,
    nativeId: videoId,
    author,
    caption: String(details.title ?? "").trim(),
    publishedAt,
    capturedAt,
    durationSeconds,
    thumbnailUrl: thumbnails.at(-1)?.url ?? null,
    metrics: {
      views: nullableNativeMetric(details.viewCount),
      likes: nullableNativeMetric(likeCount),
      comments: null,
      shares: null,
    },
  };
}

async function searchYouTubeShorts(query, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return extractYouTubeShortSearchResults(await response.text());
}

async function fetchYouTubeShortMetadata(candidateUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(candidateUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(NATIVE_POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseYouTubeShortMetadataHtml(
    await response.text(),
    candidateUrl,
    options.now ?? new Date().toISOString(),
  );
}

function buildSameAgeParentsTrend({ reference, reusePosts, now, existing }) {
  const observationId = `socialpilot-same-age-parents-${localDateKey(now).replaceAll("-", "")}`;
  const observation = {
    id: observationId,
    platform: "tiktok",
    sourceLabel: "SocialPilot · tendances TikTok",
    sourceUrl: "https://www.socialpilot.co/blog/tiktok-trends",
    observedAt: now,
    windowLabel: "Scan éditorial quotidien",
    signal: "SocialPilot documente le format où l’on compare sa vie à celle de ses parents au même âge ; les reprises natives vérifiées montrent la même mécanique chez trois créateurs distincts.",
    rank: null,
    posts: null,
    views: null,
    uses: null,
    exactness: "editorial-observation",
  };
  const base = existing ?? {
    id: "same-age-as-parents",
    trendKey: "same-age-as-parents",
    clusterKey: "format:same-age-as-parents",
    title: "Moi au même âge que mes parents",
    character: "lofi-girl",
    territory: "Études & quotidien",
    firstSeenAt: now,
    type: "format",
    summary: "Un contraste en deux temps compare ce que faisaient ses parents au même âge avec sa propre réalité, souvent beaucoup plus banale ou chaotique.",
    mechanic: "Montrer d’abord une photo ou une scène marquante des parents au même âge, puis couper vers sa propre version actuelle avec un contraste lisible immédiatement.",
    platforms: ["tiktok", "youtube"],
    keywords: [
      "me at the same age as my parents",
      "me vs my parents at the same age",
      "my parents at my age",
      "generation contrast",
      "student life",
    ],
    lifecycle: "rising",
    confidence: "high",
    momentumScore: 92,
    lofiFitScore: 98,
    saturationRisk: 44,
    whyLofi: "Le format oppose naturellement les grands récits familiaux à la réalité universelle d’une session d’étude, avec une chute immédiatement compréhensible.",
    timing: "À produire cette semaine pendant que le format circule encore dans les sélections éditoriales et les reprises récentes.",
    production: "Vidéo verticale de 8 à 12 secondes : une vieille photo ou un carton texte, puis un plan officiel de Lofi Girl face à ses notes et au chat.",
    caveat: "Utiliser uniquement des visuels familiaux autorisés ou une reconstitution originale. Ne pas reprendre les images des créateurs vérifiés.",
    proposals: [
      {
        tone: "complice",
        label: "Complice",
        title: "Au même âge",
        concept: "Le premier carton raconte que ses parents avaient déjà traversé le monde ; la coupe révèle Lofi Girl qui hésite encore à commencer sa fiche.",
        copy: "Mes parents à mon âge : une aventure. Moi : encore sur l’introduction.",
      },
      {
        tone: "cozy",
        label: "Cozy",
        title: "Deux chemins, même âge",
        concept: "Une photo ancienne laisse place à une soirée calme de Lofi Girl, avec thé, pluie et chat, sans juger les deux parcours.",
        copy: "Même âge, autre époque, autre façon d’avancer.",
      },
      {
        tone: "absurde",
        label: "Absurde",
        title: "Le grand écart générationnel",
        concept: "Ses parents sont présentés comme propriétaires à 22 ans ; Lofi Girl fête solennellement le fait d’avoir retrouvé son stylo.",
        copy: "Eux : une maison. Moi : ce stylo était perdu depuis mardi.",
      },
    ],
    observations: [],
    referencePost: null,
    reuseEvidence: null,
  };
  const observations = [...(base.observations ?? []).filter((item) => item.id !== observationId), observation];
  return {
    ...base,
    platforms: [...new Set([...(base.platforms ?? []), "tiktok", "youtube"])],
    lastVerifiedAt: now,
    referencePost: {
      platform: "tiktok",
      author: reference.author,
      caption: reference.caption || "Sans légende publique.",
      url: reference.url,
      mediaType: "video",
      durationSeconds: reference.durationSeconds,
      thumbnailUrl: reference.thumbnailUrl,
      publishedAt: reference.publishedAt,
      capturedAt: now,
      selectionLabel: `Exemple court vérifié · ${reference.metrics.likes.toLocaleString("fr-FR")} likes`,
      sourceLabel: "TikTok · données publiques natives",
      sourceUrl: reference.url,
      exactness: "exact",
      metrics: reference.metrics,
    },
    reuseEvidence: {
      verifiedAt: now,
      minimumDistinctCreators: 3,
      summary: "La comparaison entre sa vie actuelle et celle de ses parents au même âge a été contrôlée dans trois créations natives de trois auteurs distincts ; les vidéos d’explication, reposts et homonymes ont été exclus.",
      posts: reusePosts.map((post) => ({
        platform: post.platform,
        author: post.author,
        url: post.url,
        capturedAt: now,
      })),
    },
    observations,
  };
}

function titleMatchesRecipe(title, recipe) {
  const normalized = normalizeSourceText(title);
  return recipe.youtubeTitlePatterns.some((pattern) => pattern.test(normalized));
}

export async function qualifyVideoPromotionRecipe({
  recipe,
  sourceChecks,
  currentCandidateObservations,
  currentTrends,
  fetchImpl = fetch,
  now,
}) {
  const sourceCheck = sourceChecks.find((check) => check.id === recipe.sourceId);
  const referenceUrl = canonicalNativeTrendCandidateUrl(recipe.referenceUrl);
  const reference = currentCandidateObservations.find((candidate) =>
    candidate.url === referenceUrl);
  if (
    sourceCheck?.status !== "success" ||
    !(sourceCheck.candidateUrls ?? []).includes(referenceUrl) ||
    !reference
  ) {
    return {
      recipeId: recipe.id,
      status: "not-observed",
      trend: null,
      evidence: [],
      reason: "la référence éditoriale native n’a pas été observée pendant ce passage",
    };
  }
  if (
    reference.durationSeconds >= 30 ||
    reference.metrics?.likes === null ||
    reference.metrics.likes < 50_000
  ) {
    return {
      recipeId: recipe.id,
      status: "rejected",
      trend: null,
      evidence: [reference],
      reason: "la référence ne respecte pas <30 s et ≥50 k likes",
    };
  }

  const searchChecks = await Promise.all(recipe.youtubeQueries.map(async (query) => {
    try {
      return { query, status: "success", results: await searchYouTubeShorts(query, { fetchImpl }) };
    } catch (error) {
      return {
        query,
        status: "failed",
        results: [],
        error: error instanceof Error ? error.message : "échec inconnu",
      };
    }
  }));
  const matchingResults = [...new Map(
    searchChecks
      .flatMap((check) => check.results)
      .filter((result) => titleMatchesRecipe(result.title, recipe))
      .map((result) => [result.videoId, result]),
  ).values()];
  const metadataChecks = await mapWithConcurrency(
    matchingResults,
    NATIVE_POST_CONCURRENCY,
    async (result) => {
      try {
        const metadata = await fetchYouTubeShortMetadata(result.url, { fetchImpl, now });
        return titleMatchesRecipe(metadata.caption, recipe)
          ? { ok: true, metadata }
          : { ok: false, url: result.url, error: "titre natif hors mécanique" };
      } catch (error) {
        return {
          ok: false,
          url: result.url,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  const selectedEvidence = [];
  const creators = new Set([normalizedCreator(reference.author)]);
  for (const candidate of metadataChecks
    .filter((check) => check.ok)
    .map((check) => check.metadata)
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""))) {
    const creator = normalizedCreator(candidate.author);
    if (!creator || creators.has(creator)) continue;
    creators.add(creator);
    selectedEvidence.push(candidate);
    if (selectedEvidence.length === 2) break;
  }
  if (selectedEvidence.length < 2) {
    return {
      recipeId: recipe.id,
      status: searchChecks.some((check) => check.status === "success") ? "rejected" : "failed",
      trend: null,
      evidence: [reference, ...selectedEvidence],
      searchChecks,
      reason: `seulement ${1 + selectedEvidence.length}/3 créateurs natifs distincts vérifiés`,
    };
  }
  const existing = currentTrends.find((trend) => trend.trendKey === recipe.trendKey);
  const reusePosts = [reference, ...selectedEvidence];
  return {
    recipeId: recipe.id,
    status: "qualified",
    trend: buildSameAgeParentsTrend({ reference, reusePosts, now, existing }),
    evidence: reusePosts,
    searchChecks,
  };
}

function safeTrendLabel(value, fallback) {
  const cleaned = String(value ?? "").replace(/\s+/gu, " ").trim();
  return cleaned && cleaned.length <= 80 ? cleaned : fallback;
}

export function buildTikTokMusicTrend({ cluster, reference, reusePosts, now, existing }) {
  const musicTitle = safeTrendLabel(cluster.musicTitle, `Son TikTok ${cluster.musicId.slice(-6)}`);
  const musicAuthor = safeTrendLabel(cluster.musicAuthor, "créateur non indiqué");
  const observationId = `tiktok-music-${cluster.musicId}-${localDateKey(now).replaceAll("-", "")}`;
  const observation = {
    id: observationId,
    platform: "tiktok",
    sourceLabel: "TikTok · métadonnées publiques natives",
    sourceUrl: reference.url,
    observedAt: now,
    windowLabel: "Candidats du scan éditorial quotidien",
    signal: `Le même identifiant audio natif TikTok (${cluster.musicId}) a été vérifié chez ${reusePosts.length} créateurs distincts.`,
    rank: null,
    posts: reusePosts.length,
    views: null,
    uses: null,
    exactness: "exact",
  };
  const base = existing ?? {
    id: `tiktok-music-${cluster.musicId}`,
    trendKey: `tiktok-music-${cluster.musicId}`,
    clusterKey: `sound:tiktok:${cluster.musicId}`,
    title: `${musicTitle} · son TikTok en reprise`,
    character: "lofi-girl",
    territory: "Études & quotidien",
    firstSeenAt: now,
    type: "sound",
    summary: `Le son natif « ${musicTitle} » de ${musicAuthor} apparaît dans plusieurs créations indépendantes ; le cluster repose sur l’identifiant audio exact, pas sur une ressemblance de titre.`,
    mechanic: "Utiliser ce son natif sous un montage Lofi original très court, avec une situation lisible sans dépendre des images ou du scénario des exemples.",
    platforms: ["tiktok"],
    keywords: [musicTitle, musicAuthor, `TikTok music ${cluster.musicId}`, "study edit", "Lofi Girl"],
    lifecycle: "rising",
    confidence: "high",
    momentumScore: Math.min(
      98,
      82 + Math.min(8, reusePosts.length * 2) +
        Math.min(8, Math.floor(Math.log10(Math.max(1, reference.metrics.likes)))),
    ),
    lofiFitScore: 90,
    saturationRisk: Math.min(75, 35 + reusePosts.length * 3),
    whyLofi: "Un son déjà repris par plusieurs créateurs peut porter une scène Lofi immédiatement reconnaissable sans copier leur exécution.",
    timing: "À tester dans les prochains jours tant que les reprises du même identifiant audio restent visibles dans les sources quotidiennes.",
    production: "Montage vertical original de 8 à 12 secondes avec trois plans maximum et une chute visuelle compréhensible même sans le son.",
    caveat: "Aucune écoute audio n’a été effectuée pendant le scan. Vérifier manuellement paroles, tonalité, droits et disponibilité du son sur le compte avant validation créative.",
    proposals: [
      {
        tone: "complice",
        label: "Complice",
        title: "La session qui devait durer dix minutes",
        concept: "Lofi Girl ouvre un cahier pour une petite tâche ; trois cartons horaires montrent que la nuit entière y est passée.",
        copy: "Je fais juste cette page et j’arrête. Bien sûr.",
      },
      {
        tone: "cozy",
        label: "Cozy",
        title: "Trois signes que la soirée commence",
        concept: "La lampe s’allume, le thé arrive et le chat se pose près du cahier dans une boucle visuelle calme.",
        copy: "Lampe, thé, pluie. On peut enfin ralentir.",
      },
      {
        tone: "absurde",
        label: "Absurde",
        title: "Le chat prend le contrôle",
        concept: "Le montage commence comme une routine d’étude puis le chat valide, annule et reprogramme chaque tâche avec sa patte.",
        copy: "Mon nouveau manager refuse toutes mes deadlines.",
      },
    ],
    observations: [],
    referencePost: null,
    reuseEvidence: null,
  };
  return {
    ...base,
    lastVerifiedAt: now,
    referencePost: {
      platform: "tiktok",
      author: reference.author,
      caption: reference.caption || "Sans légende publique.",
      url: reference.url,
      mediaType: "video",
      durationSeconds: reference.durationSeconds,
      thumbnailUrl: reference.thumbnailUrl,
      publishedAt: reference.publishedAt,
      capturedAt: now,
      selectionLabel: `Exemple court vérifié · ${reference.metrics.likes.toLocaleString("fr-FR")} likes`,
      sourceLabel: "TikTok · données publiques natives",
      sourceUrl: reference.url,
      exactness: "exact",
      metrics: reference.metrics,
    },
    reuseEvidence: {
      verifiedAt: now,
      minimumDistinctCreators: 3,
      summary: `Le même identifiant audio TikTok ${cluster.musicId} a été contrôlé directement dans ${reusePosts.length} créations de ${reusePosts.length} auteurs distincts.`,
      posts: reusePosts.map((post) => ({
        platform: "tiktok",
        author: post.author,
        url: post.url,
        capturedAt: now,
      })),
    },
    observations: [...(base.observations ?? []).filter((item) => item.id !== observationId), observation],
  };
}

export async function qualifyTikTokMusicCluster({
  cluster,
  candidateObservations,
  currentTrends,
  fetchImpl = fetch,
  now,
}) {
  const currentEvidenceUrls = new Set(currentTrends.flatMap((trend) => [
    trend.referencePost?.url,
    ...(trend.reuseEvidence?.posts ?? []).map((post) => post.url),
  ].filter(Boolean).map(canonicalNativeTrendCandidateUrl).filter(Boolean)));
  const existing = currentTrends.find((trend) =>
    trend.clusterKey === `sound:tiktok:${cluster.musicId}`);
  if (!existing && cluster.postUrls.some((url) => currentEvidenceUrls.has(url))) {
    return {
      musicId: cluster.musicId,
      status: "already-covered",
      trend: null,
      evidence: [],
      reason: "au moins une preuve appartient déjà à une carte éditoriale existante",
    };
  }
  const registryUrls = candidateObservations
    .filter((observation) => observation?.music?.id === cluster.musicId)
    .map((observation) => observation.url);
  const checks = await mapWithConcurrency(
    [...new Set(registryUrls)],
    NATIVE_POST_CONCURRENCY,
    async (url) => {
      try {
        return { ok: true, observation: await fetchTikTokTrendCandidate(url, { fetchImpl, now }) };
      } catch (error) {
        return {
          ok: false,
          url,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  const exactObservations = checks
    .filter((check) => check.ok && check.observation.music.id === cluster.musicId)
    .map((check) => check.observation);
  const distinct = [];
  const creators = new Set();
  for (const observation of exactObservations
    .sort((left, right) => (right.metrics.likes ?? -1) - (left.metrics.likes ?? -1))) {
    const creator = normalizedCreator(observation.author);
    if (!creator || creators.has(creator)) continue;
    creators.add(creator);
    distinct.push(observation);
  }
  const reference = distinct.find((observation) =>
    observation.durationSeconds < 30 &&
    observation.metrics.likes !== null &&
    observation.metrics.likes >= 50_000);
  if (distinct.length < 3 || !reference) {
    return {
      musicId: cluster.musicId,
      status: checks.some((check) => !check.ok) ? "failed" : "rejected",
      trend: null,
      evidence: distinct,
      reason: `revalidation directe insuffisante (${distinct.length} créateurs, référence ${reference ? "valide" : "absente"})`,
    };
  }
  const reusePosts = [reference, ...distinct.filter((post) => post.url !== reference.url)].slice(0, 5);
  return {
    musicId: cluster.musicId,
    status: "qualified",
    trend: buildTikTokMusicTrend({ cluster, reference, reusePosts, now, existing }),
    evidence: reusePosts,
  };
}

export async function auditTrendReuseEvidenceReachability(trends, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobs = trends.flatMap((trend) =>
    (trend.reuseEvidence?.posts ?? []).map((post) => ({ trend, post })),
  );
  const checks = await mapWithConcurrency(
    jobs,
    options.concurrency ?? NATIVE_POST_CONCURRENCY,
    async ({ trend, post }) => {
      try {
        await verifyNativeTrendPost(post, { fetchImpl });
        return { trendId: trend.id, url: post.url, ok: true };
      } catch (error) {
        return {
          trendId: trend.id,
          url: post.url,
          ok: false,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  const checksByTrend = Map.groupBy(checks, (check) => check.trendId);
  const availableTrendIds = [];
  for (const trend of trends) {
    const trendChecks = checksByTrend.get(trend.id) ?? [];
    if (
      trend.reuseEvidence &&
      trendChecks.length === trend.reuseEvidence.posts.length &&
      trendChecks.every((check) => check.ok)
    ) {
      availableTrendIds.push(trend.id);
    }
  }
  const failures = checks.filter((check) => !check.ok);
  return {
    reachabilityCheckedAt: now,
    checkedPosts: checks.length,
    availablePosts: checks.length - failures.length,
    unavailablePosts: failures.length,
    availableTrends: availableTrendIds.length,
    availableTrendIds,
    failures,
  };
}

function nativeTrendCandidatePlatform(candidateUrl) {
  const url = new URL(candidateUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./u, "").replace(/^m\./u, "");
  if (host === "tiktok.com") return "tiktok";
  if (host === "instagram.com") return "instagram";
  if (host === "youtube.com") return "youtube";
  if (host === "x.com" || host === "twitter.com") return "x";
  throw new Error("plateforme native candidate inconnue");
}

export async function auditNativeTrendCandidateReachability(candidateUrls, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const canonicalUrls = [...new Set(
    candidateUrls.map(canonicalNativeTrendCandidateUrl).filter(Boolean),
  )].sort();
  const checks = await mapWithConcurrency(
    canonicalUrls,
    options.concurrency ?? NATIVE_POST_CONCURRENCY,
    async (url) => {
      try {
        await verifyNativeTrendPost({
          platform: nativeTrendCandidatePlatform(url),
          url,
        }, { fetchImpl });
        return { url, ok: true };
      } catch (error) {
        return {
          url,
          ok: false,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  return {
    checkedCandidateUrls: canonicalUrls,
    availableCandidateUrls: checks.filter((check) => check.ok).map((check) => check.url),
    failures: checks.filter((check) => !check.ok),
  };
}

// Kept as a compatibility export for callers that used the old name. Despite
// that historical name, this function is now a read-only reachability audit.
export async function reverifyTrendReuseEvidence(trends, options = {}) {
  return auditTrendReuseEvidenceReachability(trends, options);
}

export function normalizeSourceText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function localDateKey(value, timeZone = PARIS_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function trendSearchTerms(trend) {
  const title = trend.title.split("·")[0]?.trim() ?? trend.title;
  return [...new Set([title, ...(trend.keywords ?? [])]
    .map(normalizeSourceText)
    .filter((term) => term.length >= 5))];
}

export function countMatchedSignals(sourceText, trends) {
  return matchedTrendIdsFromSource(sourceText, trends).length;
}

export function matchedTrendIdsFromSource(sourceText, trends) {
  const normalized = normalizeSourceText(sourceText);
  return trends
    .filter((trend) => trendSearchTerms(trend).some((term) => normalized.includes(term)))
    .map((trend) => trend.id);
}

export async function checkTrendSource(source, trends, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checkedAt = options.now ?? new Date().toISOString();
  try {
    const xBearerToken = options.xBearerToken ?? process.env.X_BEARER_TOKEN ?? process.env.TWITTER_BEARER_TOKEN;
    if (source.kind === "x-api" && !xBearerToken) {
      throw new Error("X_BEARER_TOKEN absent");
    }
    const response = await fetchImpl(source.url, {
      headers: {
        Accept: source.kind === "x-api" ? "application/json" : "text/html,application/xhtml+xml",
        ...(source.kind === "x-api" ? { Authorization: `Bearer ${xBearerToken}` } : {}),
        "User-Agent": "LofiSocialRadar/1.0 (+https://github.com/dim75017/youtube-radar-kx9v2m)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (source.kind === "x-api") {
      const payload = await response.json();
      const items = Array.isArray(payload?.data) ? payload.data : [];
      const trendNames = items
        .map((item) => typeof item?.trend_name === "string" ? item.trend_name : "")
        .filter(Boolean);
      if (!trendNames.length) throw new Error("aucune tendance X parsée");
      const sourceText = trendNames.join(" ");
      const normalizedNames = normalizeSourceText(sourceText);
      const candidateUrls = extractNativeTrendCandidateUrls(JSON.stringify(payload));
      const matchedTrendIds = matchedTrendIdsFromSource(sourceText, trends);
      return {
        id: source.id,
        label: source.label,
        platform: source.platform,
        status: "success",
        checkedAt,
        candidatesMatched: matchedTrendIds.length,
        candidateUrls,
        matchedTrendIds,
        signature: createHash("sha256").update(normalizedNames).digest("hex").slice(0, 16),
      };
    }
    const body = await response.text();
    const normalized = normalizeSourceText(body);
    const markers = source.requiredMarkers.map(normalizeSourceText);
    if (!markers.every((marker) => normalized.includes(marker))) {
      throw new Error("structure reconnue absente");
    }
    const candidateUrls = extractNativeTrendCandidateUrls(body);
    if (!candidateUrls.length) {
      throw new Error("aucune URL native candidate parsée");
    }
    const matchedTrendIds = matchedTrendIdsFromSource(body, trends);
    return {
      id: source.id,
      label: source.label,
      platform: source.platform,
      status: "success",
      checkedAt,
      candidatesMatched: matchedTrendIds.length,
      candidateUrls,
      matchedTrendIds,
      signature: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    };
  } catch (error) {
    return {
      id: source.id,
      label: source.label,
      platform: source.platform,
      status: "failed",
      checkedAt,
      candidatesMatched: 0,
      candidateUrls: [],
      matchedTrendIds: [],
      error: error instanceof Error ? error.message : "échec inconnu",
    };
  }
}

export function buildTrendDiscoveryAudit({
  previousAudit,
  checks,
  reachability,
  candidateReachability,
  candidateObservations,
  tiktokCandidateAudit,
  exactMusicClusters,
  pendingExactMusicClusters,
  musicClusterAudits,
  recipeAudits,
  nextActionable,
  retainedQualifiedTrendIds,
  refreshedQualifiedTrendIds,
  newQualifiedTrendIds,
  removedTrendIds,
  qualificationComplete,
  noRotationReason,
  now,
}) {
  const successfulChecks = checks.filter((check) => check.status === "success");
  const candidateUrls = candidateReachability.availableCandidateUrls;
  const matchedTrendIds = [...new Set(
    successfulChecks.flatMap((check) => check.matchedTrendIds ?? []),
  )].sort();
  const qualifiedTrendIds = nextActionable.map((trend) => trend.id).sort();
  const previousCandidateUrls = new Set(
    (previousAudit?.candidateUrls ?? [])
      .map(canonicalNativeTrendCandidateUrl)
      .filter(Boolean),
  );
  const currentCandidateUrls = new Set(candidateUrls);
  const retained = candidateUrls.filter((url) => previousCandidateUrls.has(url)).length;
  const added = candidateUrls.length - retained;
  const removed = [...previousCandidateUrls]
    .filter((url) => !currentCandidateUrls.has(url))
    .length;
  const rankedPriorityScores = nextActionable
    .map(trendPriorityScore)
    .sort((left, right) => right - left);
  const top50CutoffScore = rankedPriorityScores[
    MIN_PUBLISHABLE_ACTIONABLE_TRENDS - 1
  ] ?? null;

  return {
    scannedAt: now,
    complete:
      checks.filter((check) => check.status === "success").length >=
        MIN_TREND_DISCOVERY_PARSED_SOURCES &&
      candidateUrls.length >= MIN_TREND_DISCOVERY_CANDIDATE_URLS &&
      qualifiedTrendIds.length >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS &&
      qualificationComplete,
    candidateCount: candidateUrls.length,
    qualifiedInventoryCount: qualifiedTrendIds.length,
    currentMatchedCount: matchedTrendIds.length,
    added,
    removed,
    retained,
    candidateUrls: candidateUrls.slice(0, MAX_DISCOVERY_CANDIDATE_URLS),
    matchedTrendIds,
    retainedQualifiedCount: retainedQualifiedTrendIds.length,
    retainedQualifiedTrendIds: [...retainedQualifiedTrendIds].sort(),
    refreshedQualifiedCount: refreshedQualifiedTrendIds.length,
    refreshedQualifiedTrendIds: [...refreshedQualifiedTrendIds].sort(),
    newQualifiedCount: newQualifiedTrendIds.length,
    newQualifiedTrendIds: [...newQualifiedTrendIds].sort(),
    removedTrendCount: removedTrendIds.length,
    removedTrendIds: [...removedTrendIds].sort(),
    noRotationReason,
    candidateObservations,
    tiktokCandidateEnrichment: {
      checked: tiktokCandidateAudit.checkedUrls.length,
      parsed: tiktokCandidateAudit.observations.length,
      failed: tiktokCandidateAudit.failures.length,
      failures: tiktokCandidateAudit.failures.slice(0, MAX_SOURCE_CANDIDATE_URLS),
    },
    exactMusicClusters,
    pendingExactMusicClusters,
    musicClusterQualifications: musicClusterAudits.map((audit) => ({
      musicId: audit.musicId,
      status: audit.status,
      reason: audit.reason ?? null,
      evidenceUrls: audit.evidence.map((post) => post.url),
      priorityScore: audit.trend ? trendPriorityScore(audit.trend) : null,
      top50CutoffScore,
      beatsTop50Cutoff: audit.trend && top50CutoffScore !== null
        ? trendPriorityScore(audit.trend) >= top50CutoffScore
        : null,
    })),
    recipeQualifications: recipeAudits.map((audit) => ({
      recipeId: audit.recipeId,
      status: audit.status,
      reason: audit.reason ?? null,
      evidenceUrls: audit.evidence.map((post) => post.url),
      priorityScore: audit.trend ? trendPriorityScore(audit.trend) : null,
      top50CutoffScore,
      beatsTop50Cutoff: audit.trend && top50CutoffScore !== null
        ? trendPriorityScore(audit.trend) >= top50CutoffScore
        : null,
    })),
    sourceBreakdown: checks.map((check) => ({
      id: check.id,
      label: check.label,
      platform: check.platform,
      status: check.status,
      candidateCount: (check.candidateUrls ?? []).length,
      matchedTrendIds: check.matchedTrendIds ?? [],
      candidateUrls: (check.candidateUrls ?? []).slice(0, MAX_SOURCE_CANDIDATE_URLS),
    })),
    reachabilityCheckedAt: reachability.reachabilityCheckedAt,
    availablePosts: nextActionable.reduce(
      (total, trend) => total + (trend.reuseEvidence?.posts.length ?? 0),
      0,
    ),
    unavailablePosts: reachability.unavailablePosts,
    unavailablePostUrls: reachability.failures
      .map((failure) => failure.url)
      .slice(0, MAX_SOURCE_CANDIDATE_URLS),
  };
}

export async function buildDailyTrendRefresh({
  feed,
  watchlists,
  previousDiscoveryAudit,
  now = new Date().toISOString(),
  fetchImpl = fetch,
  force = false,
  xBearerToken,
}) {
  const current = assertSocialTrendFeed(structuredClone(feed));
  if (!force && localDateKey(current.refresh.lastSuccessfulAt) === localDateKey(now)) {
    return { skipped: true, feed: current, status: current.refresh };
  }

  const actionable = current.trends.filter(isActionableSocialTrend);
  const [initialChecks, reachability] = await Promise.all([
    Promise.all(
      watchlists.sources.map((source) =>
        checkTrendSource(source, actionable, { fetchImpl, now, xBearerToken }),
      ),
    ),
    auditTrendReuseEvidenceReachability(actionable, { now, fetchImpl }),
  ]);
  const discoveredCandidateUrls = [...new Set(
    initialChecks
      .filter((check) => check.status === "success")
      .flatMap((check) => check.candidateUrls ?? []),
  )].sort();
  const tiktokCandidateAudit = await auditTikTokTrendCandidates(
    discoveredCandidateUrls,
    { fetchImpl, now },
  );
  const candidateObservations = mergeTrendCandidateObservations(
    previousDiscoveryAudit?.candidateObservations ??
      current.refresh.discoveryAudit?.candidateObservations,
    tiktokCandidateAudit.observations,
    now,
  );
  const exactMusicClusters = qualifiedTikTokMusicClusters(candidateObservations);
  const [recipeAudits, musicClusterAudits] = await Promise.all([
    Promise.all(VIDEO_PROMOTION_RECIPES.map((recipe) =>
      qualifyVideoPromotionRecipe({
        recipe,
        sourceChecks: initialChecks,
        currentCandidateObservations: tiktokCandidateAudit.observations,
        currentTrends: current.trends,
        fetchImpl,
        now,
      }))),
    Promise.all(exactMusicClusters.map((cluster) =>
      qualifyTikTokMusicCluster({
        cluster,
        candidateObservations,
        currentTrends: current.trends,
        fetchImpl,
        now,
      }))),
  ]);
  const qualifiedRecipeAudits = recipeAudits.filter((audit) =>
    audit.status === "qualified" && audit.trend);
  const qualifiedMusicClusterAudits = musicClusterAudits.filter((audit) =>
    audit.status === "qualified" && audit.trend);
  const qualifiedSemanticAudits = [
    ...qualifiedRecipeAudits,
    ...qualifiedMusicClusterAudits,
  ];
  const qualificationEvidenceUrls = qualifiedSemanticAudits.flatMap((audit) =>
    audit.evidence.map((post) => post.url));
  const candidateReachability = await auditNativeTrendCandidateReachability(
    [...discoveredCandidateUrls, ...qualificationEvidenceUrls],
    { fetchImpl },
  );

  const existingTrendIds = new Set(current.trends.map((trend) => trend.id));
  const qualifiedCandidateTrends = qualifiedSemanticAudits.map((audit) => audit.trend);
  const qualifiedCandidateById = new Map(
    qualifiedCandidateTrends.map((trend) => [trend.id, trend]),
  );
  const availableRetainedIds = new Set(reachability.availableTrendIds ?? []);
  const unavailableTrendIds = actionable
    .filter((trend) => !availableRetainedIds.has(trend.id) && !qualifiedCandidateById.has(trend.id))
    .map((trend) => trend.id);
  const unavailableTrendIdSet = new Set(unavailableTrendIds);
  const preliminaryTrends = current.trends.flatMap((trend) => {
    const qualifiedReplacement = qualifiedCandidateById.get(trend.id);
    if (qualifiedReplacement) {
      qualifiedCandidateById.delete(trend.id);
      return [qualifiedReplacement];
    }
    if (isActionableSocialTrend(trend) && unavailableTrendIdSet.has(trend.id)) return [];
    return [trend];
  });
  preliminaryTrends.push(...qualifiedCandidateById.values());
  const rankedActionableIds = new Set(
    preliminaryTrends
      .filter(isActionableSocialTrend)
      .sort((left, right) => trendPriorityScore(right) - trendPriorityScore(left))
      .slice(0, MAX_QUALIFIED_ACTIONABLE_TRENDS)
      .map((trend) => trend.id),
  );
  const nextTrends = preliminaryTrends.filter((trend) =>
    !isActionableSocialTrend(trend) || rankedActionableIds.has(trend.id));
  const nextActionable = nextTrends.filter(isActionableSocialTrend);
  const nextTrendIds = new Set(nextTrends.map((trend) => trend.id));
  const refreshedQualifiedTrendIds = qualifiedCandidateTrends
    .filter((trend) => existingTrendIds.has(trend.id) && nextTrendIds.has(trend.id))
    .map((trend) => trend.id);
  const newQualifiedTrendIds = qualifiedCandidateTrends
    .filter((trend) => !existingTrendIds.has(trend.id) && nextTrendIds.has(trend.id))
    .map((trend) => trend.id);
  const removedTrendIds = actionable
    .filter((trend) => !nextTrendIds.has(trend.id))
    .map((trend) => trend.id);
  const refreshedQualifiedIdSet = new Set(refreshedQualifiedTrendIds);
  const retainedQualifiedTrendIds = nextActionable
    .filter((trend) =>
      existingTrendIds.has(trend.id) && !refreshedQualifiedIdSet.has(trend.id))
    .map((trend) => trend.id);

  const checks = initialChecks.map((check) => {
    const recipeTrendIds = qualifiedRecipeAudits
      .filter((audit) =>
        VIDEO_PROMOTION_RECIPES.some((recipe) =>
          recipe.id === audit.recipeId && recipe.sourceId === check.id))
      .map((audit) => audit.trend.id);
    const musicTrendIds = qualifiedMusicClusterAudits
      .filter((audit) => audit.evidence.some((post) =>
        (check.candidateUrls ?? []).includes(post.url)))
      .map((audit) => audit.trend.id);
    const matchedTrendIds = [...new Set([
      ...(check.matchedTrendIds ?? []),
      ...recipeTrendIds,
      ...musicTrendIds,
    ])].filter((id) => nextTrendIds.has(id)).sort();
    return {
      ...check,
      candidatesMatched: matchedTrendIds.length,
      matchedTrendIds,
    };
  });

  const pendingExactMusicClusters = musicClusterAudits
    .filter((audit) => ["failed", "rejected"].includes(audit.status))
    .map((audit) => exactMusicClusters.find((cluster) => cluster.musicId === audit.musicId))
    .filter(Boolean);
  const everyCurrentTikTokCandidateParsed =
    tiktokCandidateAudit.checkedUrls.length > 0 &&
    tiktokCandidateAudit.failures.length === 0;
  const everyDiscoveredCandidateReachable = candidateReachability.failures.length === 0;
  const everyDiscoveredCandidateSemanticallyParsed =
    discoveredCandidateUrls.length > 0 &&
    discoveredCandidateUrls.every((url) => nativeTrendCandidatePlatform(url) === "tiktok") &&
    tiktokCandidateAudit.checkedUrls.length === discoveredCandidateUrls.length;
  const qualificationLanesSucceeded =
    recipeAudits.every((audit) => audit.status !== "failed") &&
    pendingExactMusicClusters.length === 0;
  const completeZeroRotationAudit =
    everyCurrentTikTokCandidateParsed &&
    everyDiscoveredCandidateReachable &&
    everyDiscoveredCandidateSemanticallyParsed &&
    qualificationLanesSucceeded;
  const qualificationComplete =
    everyCurrentTikTokCandidateParsed &&
    qualificationLanesSucceeded &&
    (qualifiedSemanticAudits.length > 0 || completeZeroRotationAudit);
  const top50CutoffScore = nextActionable
    .map(trendPriorityScore)
    .sort((left, right) => right - left)[MIN_PUBLISHABLE_ACTIONABLE_TRENDS - 1] ?? null;
  const noRotationReason = newQualifiedTrendIds.length === 0
    ? refreshedQualifiedTrendIds.length > 0
      ? `${refreshedQualifiedTrendIds.length} cluster(s) existant(s) ont été requalifiés nativement ; aucun nouveau cluster vérifié n’a dépassé le cutoff top 50 (${top50CutoffScore ?? "indisponible"}).`
      : qualifiedSemanticAudits.length > 0
        ? `${qualifiedSemanticAudits.length} cluster(s) ont été qualifiés pendant le passage, mais aucune nouvelle carte n’a dépassé le cutoff top 50 (${top50CutoffScore ?? "indisponible"}).`
      : completeZeroRotationAudit
        ? `Tous les ${discoveredCandidateUrls.length} candidats natifs ont été parsés et classés ; aucun groupe inédit n’atteint trois créateurs avec une référence <30 s et ≥50 k likes (cutoff top 50 : ${top50CutoffScore ?? "indisponible"}).`
        : null
    : null;

  const successfulChecks = checks.filter((check) => check.status === "success");
  const checkedSources = successfulChecks.length;
  const matchedSignals = successfulChecks.reduce(
    (total, check) => total + check.candidatesMatched,
    0,
  );
  const lofiGirl = nextActionable.filter((trend) => trend.character === "lofi-girl").length;
  const lofiBoy = nextActionable.filter((trend) => trend.character === "lofi-boy").length;
  const discoveryAudit = buildTrendDiscoveryAudit({
    previousAudit: previousDiscoveryAudit ?? current.refresh.discoveryAudit,
    checks,
    reachability,
    candidateReachability,
    candidateObservations,
    tiktokCandidateAudit,
    exactMusicClusters,
    pendingExactMusicClusters,
    musicClusterAudits,
    recipeAudits,
    nextActionable,
    retainedQualifiedTrendIds,
    refreshedQualifiedTrendIds,
    newQualifiedTrendIds,
    removedTrendIds,
    qualificationComplete,
    noRotationReason,
    now,
  });
  const baseRefresh = {
    cadenceHours: 24,
    lastAttemptAt: now,
    lastSuccessfulAt: current.refresh.lastSuccessfulAt,
    nextScheduledAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString(),
    status: "degraded",
    runId: process.env.GITHUB_RUN_ID ?? `local-${localDateKey(now)}`,
    runUrl: process.env.GITHUB_RUN_URL ?? null,
    discoveryAudit,
    sourceChecks: checks.map((check) => ({
      id: check.id,
      label: check.label,
      platform: check.platform,
      status: check.status,
      checkedAt: check.checkedAt,
      candidatesMatched: check.candidatesMatched,
    })),
    counts: {
      checkedSources,
      matchedSignals,
      actionable: nextActionable.length,
      lofiGirl,
      lofiBoy,
    },
  };

  const minimumParsedSources = Math.max(
    MIN_TREND_DISCOVERY_PARSED_SOURCES,
    Number.isInteger(watchlists.minimumParsedSources) ? watchlists.minimumParsedSources : 0,
  );
  if (checkedSources < minimumParsedSources) {
    const error = new Error(
      `Seulement ${checkedSources}/${watchlists.sources.length} sources Trends ont été parsées; minimum ${minimumParsedSources}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (discoveryAudit.candidateCount < MIN_TREND_DISCOVERY_CANDIDATE_URLS) {
    const error = new Error(
      `Seulement ${discoveryAudit.candidateCount} URLs candidates natives ont été extraites; minimum ${MIN_TREND_DISCOVERY_CANDIDATE_URLS}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (tiktokCandidateAudit.failures.length > 0) {
    const error = new Error(
      `${tiktokCandidateAudit.failures.length}/${tiktokCandidateAudit.checkedUrls.length} candidats TikTok n’ont pas fourni leurs métadonnées natives; le scan vidéo reste incomplet.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (!qualifiedSemanticAudits.length && !completeZeroRotationAudit) {
    const details = [
      ...recipeAudits.map((audit) =>
        `${audit.recipeId}: ${audit.reason ?? audit.status}`),
      ...musicClusterAudits.map((audit) =>
        `music:${audit.musicId}: ${audit.reason ?? audit.status}`),
    ].join("; ");
    const error = new Error(
      `Aucun cluster vidéo ou audio n’a été requalifié et la couverture sémantique ne permet pas de prouver une rotation nulle (${details}).`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (pendingExactMusicClusters.length > 0) {
    const error = new Error(
      `${pendingExactMusicClusters.length} nouveau(x) cluster(s) audio TikTok satisfait/satisfont les preuves natives mais n’ont pas encore d’adaptation éditoriale sûre.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (discoveryAudit.qualifiedInventoryCount < MIN_PUBLISHABLE_ACTIONABLE_TRENDS) {
    const error = new Error(
      `Seulement ${discoveryAudit.qualifiedInventoryCount}/${nextActionable.length} trends qualifiées composent le prochain feed; minimum ${MIN_PUBLISHABLE_ACTIONABLE_TRENDS}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  const refreshedFeed = {
    ...current,
    capturedAt: now,
    trends: nextTrends,
    refresh: {
      ...baseRefresh,
      lastSuccessfulAt: now,
      status: "success",
    },
  };
  assertSocialTrendFeed(refreshedFeed);
  assertPublishableSocialTrendFeed(refreshedFeed, {
    now,
    allowStaleSemanticEvidence: true,
  });
  return { skipped: false, feed: refreshedFeed, status: refreshedFeed.refresh };
}

async function writeJsonAtomic(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

async function main() {
  const attemptedAt = process.env.TREND_REFRESH_NOW ?? new Date().toISOString();
  const force = process.env.FORCE_TREND_REFRESH === "1";
  const [feed, watchlists, previousStatus] = await Promise.all([
    readFile(feedPath, "utf8").then(JSON.parse),
    readFile(watchlistsPath, "utf8").then(JSON.parse),
    readFile(statusPath, "utf8").then(JSON.parse).catch(() => null),
  ]);

  try {
    const result = await buildDailyTrendRefresh({
      feed,
      watchlists,
      previousDiscoveryAudit: previousStatus?.discoveryAudit,
      now: attemptedAt,
      force,
    });
    if (result.skipped) {
      console.log(`Le feed Trends est déjà à jour pour ${localDateKey(attemptedAt)}.`);
      return;
    }
    await Promise.all([
      writeJsonAtomic(feedPath, result.feed),
      writeJsonAtomic(statusPath, {
        version: 1,
        ...result.status,
        message: "Rafraîchissement quotidien publié après validation complète.",
      }),
    ]);
    console.log(
      `Feed publié: ${result.status.counts.actionable} trends, ${result.status.counts.lofiGirl} Lofi Girl, ${result.status.counts.checkedSources} sources parsées.`,
    );
  } catch (error) {
    const status = error?.refreshStatus ?? {
      cadenceHours: 24,
      lastAttemptAt: attemptedAt,
      lastSuccessfulAt: feed?.refresh?.lastSuccessfulAt ?? feed?.capturedAt ?? attemptedAt,
      nextScheduledAt: new Date(Date.parse(attemptedAt) + 12 * 60 * 60 * 1_000).toISOString(),
      status: "degraded",
      runId: process.env.GITHUB_RUN_ID ?? `local-${localDateKey(attemptedAt)}`,
      runUrl: process.env.GITHUB_RUN_URL ?? null,
      discoveryAudit: feed?.refresh?.discoveryAudit,
      sourceChecks: [],
      counts: {
        checkedSources: 0,
        matchedSignals: 0,
        actionable: 0,
        lofiGirl: 0,
        lofiBoy: 0,
      },
    };
    await writeJsonAtomic(statusPath, {
      version: 1,
      ...status,
      message: error instanceof Error ? error.message : "Rafraîchissement Trends impossible.",
    });
    throw error;
  }
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) {
  await main();
}
