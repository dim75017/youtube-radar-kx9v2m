import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PLAYLIST_PROMO_CADENCE_HOURS,
  PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES,
  assertPlaylistPromoFeed,
  latestPlaylistPromoObservation,
} from "../lib/playlist-promos.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FEED_PATH = resolve(root, "data", "playlist-promos", "feed.json");
const DEFAULT_SEEDS_PATH = resolve(root, "data", "playlist-promos", "seeds.json");
const DEFAULT_STATUS_PATH = resolve(root, "data", "playlist-promos", "refresh-status.json");
const MAX_EMBED_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cleanError(error) {
  return String(error?.message ?? error ?? "Erreur inconnue")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function nextRefreshAt(now) {
  return new Date(
    Date.parse(now) + PLAYLIST_PROMO_CADENCE_HOURS * 60 * 60 * 1_000,
  ).toISOString();
}

export function instagramShortcodeFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(host === "instagram.com" || host.endsWith(".instagram.com"))
    ) {
      return null;
    }
    return url.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]{5,32})\/?$/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function canonicalInstagramPostUrl(value) {
  const shortcode = instagramShortcodeFromUrl(value);
  return shortcode ? `https://www.instagram.com/p/${shortcode}/` : null;
}

export function instagramEmbedUrl(value) {
  const shortcode = instagramShortcodeFromUrl(value);
  return shortcode
    ? `https://www.instagram.com/p/${shortcode}/embed/captioned/?_fb_noscript=1`
    : null;
}

function balancedJsonObject(source, start) {
  if (source[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function findShortcodeMedia(value, depth = 0) {
  if (!isObject(value) || depth > 12) return null;
  if (isObject(value.gql_data?.shortcode_media)) return value.gql_data.shortcode_media;
  if (isObject(value.shortcode_media)) return value.shortcode_media;
  for (const nested of Object.values(value)) {
    if (isObject(nested)) {
      const found = findShortcodeMedia(nested, depth + 1);
      if (found) return found;
    } else if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findShortcodeMedia(item, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function parsePossibleJson(source) {
  const trimmed = String(source).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const media = findShortcodeMedia(parsed);
    if (media) return media;
  } catch {
    // Some embeds wrap the JSON in a JavaScript callback.
  }

  const markers = ['{"gql_data"', '{"shortcode_media"'];
  for (const marker of markers) {
    let offset = 0;
    while (offset < source.length) {
      const start = source.indexOf(marker, offset);
      if (start < 0) break;
      const candidate = balancedJsonObject(source, start);
      if (candidate) {
        try {
          const media = findShortcodeMedia(JSON.parse(candidate));
          if (media) return media;
        } catch {
          // Continue to the next attributable JSON object.
        }
      }
      offset = start + marker.length;
    }
  }
  return null;
}

function extractShortcodeMedia(html) {
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of html.matchAll(scriptPattern)) {
    const media = parsePossibleJson(match[1]);
    if (media) return media;
  }
  return parsePossibleJson(html);
}

function nestedCount(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const key of path) current = isObject(current) ? current[key] : undefined;
    if (safeInteger(current)) return current;
  }
  return null;
}

function firstCaption(media) {
  const edges = media.edge_media_to_caption?.edges;
  if (!Array.isArray(edges) || edges.length === 0) return "";
  const text = edges[0]?.node?.text;
  return typeof text === "string" ? text.trim() : "";
}

export function parseInstagramPlaylistPromoEmbed(html, { expectedShortcode = null } = {}) {
  if (!nonEmptyText(html)) throw new Error("HTML embed Instagram vide.");
  if (Buffer.byteLength(html, "utf8") > MAX_EMBED_BYTES) {
    throw new Error("HTML embed Instagram trop volumineux.");
  }
  const media = extractShortcodeMedia(html);
  if (!media) throw new Error("gql_data.shortcode_media absent de l'embed Instagram.");

  const shortcode = nonEmptyText(media.shortcode) ? media.shortcode.trim() : expectedShortcode;
  if (!SHORTCODE.test(shortcode ?? "")) throw new Error("Shortcode Instagram absent ou invalide.");
  if (expectedShortcode && shortcode !== expectedShortcode) {
    throw new Error(`Embed Instagram non attribuable : ${shortcode} au lieu de ${expectedShortcode}.`);
  }
  if (media.__typename !== "GraphVideo") {
    throw new Error(`Le média ${shortcode} n'est pas une vidéo Instagram attribuable.`);
  }

  const author = typeof media.owner?.username === "string"
    ? media.owner.username.trim().toLowerCase()
    : "";
  const likes = nestedCount(media, [
    ["edge_liked_by", "count"],
    ["edge_media_preview_like", "count"],
  ]);
  const comments = nestedCount(media, [
    ["edge_media_to_comment", "count"],
    ["edge_media_to_parent_comment", "count"],
  ]);
  const views = safeInteger(media.video_view_count) ? media.video_view_count : null;
  const durationSeconds = typeof media.video_duration === "number" &&
      Number.isFinite(media.video_duration) &&
      media.video_duration > 0 &&
      media.video_duration <= 300
    ? media.video_duration
    : null;
  const productType = typeof media.product_type === "string"
    ? media.product_type.trim().toLowerCase()
    : "unknown";
  const width = media.dimensions?.width;
  const height = media.dimensions?.height;

  if (!author) throw new Error(`Auteur Instagram absent pour ${shortcode}.`);
  if (!safeInteger(likes)) throw new Error(`Likes exacts absents pour ${shortcode}.`);
  if (!safeInteger(comments)) throw new Error(`Commentaires exacts absents pour ${shortcode}.`);
  if (!safeInteger(views)) throw new Error(`Vues exactes absentes pour ${shortcode}.`);
  if (durationSeconds === null) throw new Error(`Durée exacte absente pour ${shortcode}.`);
  if (!["ad", "organic"].includes(productType)) {
    throw new Error(`product_type non qualifiable pour ${shortcode}.`);
  }
  if (!safeInteger(width) || width === 0 || !safeInteger(height) || height === 0) {
    throw new Error(`Dimensions vidéo absentes pour ${shortcode}.`);
  }

  return {
    shortcode,
    author,
    caption: firstCaption(media),
    likes,
    comments,
    views,
    durationSeconds,
    productType,
    typename: media.__typename,
    dimensions: { width, height },
  };
}

export function assertPlaylistPromoSeeds(value) {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !nonEmptyText(value.source) ||
    !Array.isArray(value.seeds) ||
    value.seeds.length === 0 ||
    value.seeds.length > 500
  ) {
    throw new Error("Seeds Pubs playlists invalides.");
  }
  const ids = new Set();
  const shortcodes = new Set();
  for (const seed of value.seeds) {
    const urlShortcode = instagramShortcodeFromUrl(seed?.url);
    if (
      !isObject(seed) ||
      !SLUG.test(seed.id ?? "") ||
      ids.has(seed.id) ||
      seed.platform !== "instagram" ||
      !SHORTCODE.test(seed.shortcode ?? "") ||
      shortcodes.has(seed.shortcode) ||
      urlShortcode !== seed.shortcode ||
      canonicalInstagramPostUrl(seed.url) !== seed.url ||
      !nonEmptyText(seed.expectedAuthor) ||
      !["ad", "organic", "unknown"].includes(seed.expectedProductType) ||
      typeof seed.enabled !== "boolean" ||
      !Number.isFinite(Date.parse(seed.addedAt))
    ) {
      throw new Error(`Seed Pubs playlists invalide : ${seed?.id ?? "inconnu"}.`);
    }
    ids.add(seed.id);
    shortcodes.add(seed.shortcode);
  }
  return value;
}

function sameObservation(left, right) {
  return left &&
    left.likes === right.likes &&
    left.comments === right.comments &&
    left.views === right.views &&
    left.shares === right.shares &&
    left.precision === right.precision &&
    left.metricScope === right.metricScope;
}

function successfulResultBySeed(results) {
  const bySeed = new Map();
  for (const result of results) {
    if (!isObject(result) || !nonEmptyText(result.seedId) || bySeed.has(result.seedId)) {
      throw new Error("Résultats de refresh Pubs playlists invalides ou dupliqués.");
    }
    bySeed.set(result.seedId, result);
  }
  return bySeed;
}

export function buildPlaylistPromoRefresh({ feed: rawFeed, seeds: rawSeeds, results, now }) {
  if (!Number.isFinite(Date.parse(now))) throw new Error("Horodatage de refresh invalide.");
  const feed = structuredClone(assertPlaylistPromoFeed(rawFeed));
  const seeds = assertPlaylistPromoSeeds(rawSeeds);
  if (!Array.isArray(results)) throw new Error("Résultats de refresh absents.");
  const enabledSeeds = seeds.seeds.filter((seed) => seed.enabled);
  const resultBySeed = successfulResultBySeed(results);

  if (resultBySeed.size !== enabledSeeds.length) {
    throw new Error(`Refresh incomplet : ${resultBySeed.size}/${enabledSeeds.length} seeds retournées.`);
  }

  const itemById = new Map(feed.items.map((item) => [item.id, item]));
  let updatedCount = 0;
  for (const seed of enabledSeeds) {
    const result = resultBySeed.get(seed.id);
    if (!result || result.status !== "success" || !isObject(result.post)) {
      throw new Error(`Refresh incomplet pour ${seed.id} : ${result?.error ?? "aucun résultat"}.`);
    }
    const post = result.post;
    const item = itemById.get(seed.id);
    if (!item) throw new Error(`Le feed ne contient pas le seed ${seed.id}.`);
    if (
      post.shortcode !== seed.shortcode ||
      post.author !== seed.expectedAuthor.toLowerCase() ||
      canonicalInstagramPostUrl(item.url) !== seed.url
    ) {
      throw new Error(`Attribution Instagram incohérente pour ${seed.id}.`);
    }
    if (seed.expectedProductType !== "unknown" && post.productType !== seed.expectedProductType) {
      throw new Error(`product_type inattendu pour ${seed.id} : ${post.productType}.`);
    }
    if (!safeInteger(post.likes) || post.likes < PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES) {
      throw new Error(`Seuil natif de 10 000 likes non prouvé pour ${seed.id}.`);
    }
    if (!safeInteger(post.comments) || !safeInteger(post.views)) {
      throw new Error(`Compteurs exacts incomplets pour ${seed.id}.`);
    }

    const observation = {
      capturedAt: now,
      likes: post.likes,
      comments: post.comments,
      views: post.views,
      shares: null,
      precision: "exact",
      metricScope: "native-post",
      sourceLabel: "Instagram embed public · compteurs du post natif",
      sourceUrl: seed.url,
    };
    const latest = latestPlaylistPromoObservation(item);
    if (!sameObservation(latest, observation)) {
      item.observations.push(observation);
      updatedCount += 1;
    }
    item.author = post.author;
    item.caption = post.caption;
    item.durationSeconds = post.durationSeconds;
    item.productType = post.productType;
    if (post.productType === "ad") {
      item.lane = "paid";
      item.paidStatus = "verified-paid";
      item.paidEvidence = "Instagram embed public : gql_data.shortcode_media.product_type=ad.";
    } else {
      item.lane = "organic";
      item.paidStatus = "organic-only";
      item.paidEvidence = null;
    }
  }

  feed.capturedAt = now;
  feed.nextRefreshAt = nextRefreshAt(now);
  const instagramSource = feed.sourceChecks.find((source) => source.id === "instagram-known-embeds");
  if (!instagramSource) throw new Error("Source Instagram du feed absente.");
  instagramSource.status = "success";
  instagramSource.checkedAt = now;
  instagramSource.note = `${enabledSeeds.length}/${enabledSeeds.length} médias attribués ; compteurs exacts, durée, dimensions et product_type vérifiés.`;

  const nextFeed = assertPlaylistPromoFeed(feed);
  return {
    feed: nextFeed,
    status: {
      version: 1,
      status: "success",
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      nextRefreshAt: nextFeed.nextRefreshAt,
      seedCount: enabledSeeds.length,
      checkedCount: enabledSeeds.length,
      matchedCount: enabledSeeds.length,
      qualifiedCount: enabledSeeds.length,
      updatedCount,
      failedCount: 0,
      preservedLastGoodFeed: false,
      errors: [],
      note: "Tous les embeds ont été attribués. Les compteurs sont ceux des posts natifs ; product_type qualifie séparément le statut paid.",
    },
  };
}

async function fetchInstagramSeed(seed, { fetchImpl, timeoutMs }) {
  const url = instagramEmbedUrl(seed.url);
  if (!url) throw new Error(`URL Instagram invalide pour ${seed.id}.`);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://lofigirl.com)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) throw new Error("Instagram rate-limited (HTTP 429).");
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Instagram demande une authentification (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(`Instagram embed HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_EMBED_BYTES) {
    throw new Error("Instagram embed trop volumineux.");
  }
  const html = await response.text();
  return parseInstagramPlaylistPromoEmbed(html, { expectedShortcode: seed.shortcode });
}

function failedStatus({ previousStatus, now, seedCount, results, error }) {
  const failed = results.filter((result) => result.status !== "success");
  return {
    version: 1,
    status: "failed",
    lastAttemptAt: now,
    lastSuccessfulAt: previousStatus?.lastSuccessfulAt ?? null,
    nextRefreshAt: nextRefreshAt(now),
    seedCount,
    checkedCount: results.length,
    matchedCount: results.length - failed.length,
    qualifiedCount: 0,
    updatedCount: 0,
    failedCount: Math.max(failed.length, 1),
    preservedLastGoodFeed: true,
    errors: [
      cleanError(error),
      ...failed.map((result) => `${result.seedId}: ${cleanError(result.error)}`),
    ].filter((message, index, all) => all.indexOf(message) === index),
    note: "Refresh fail-closed : le dernier bon feed a été conservé sans modification.",
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function refreshPlaylistPromos({
  feedPath = DEFAULT_FEED_PATH,
  seedsPath = DEFAULT_SEEDS_PATH,
  statusPath = DEFAULT_STATUS_PATH,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = new Date().toISOString(),
} = {}) {
  const [rawFeed, rawSeeds, rawStatus] = await Promise.all([
    readFile(feedPath, "utf8"),
    readFile(seedsPath, "utf8"),
    readFile(statusPath, "utf8").catch(() => "null"),
  ]);
  const feed = assertPlaylistPromoFeed(JSON.parse(rawFeed));
  const seeds = assertPlaylistPromoSeeds(JSON.parse(rawSeeds));
  const previousStatus = JSON.parse(rawStatus);
  const enabledSeeds = seeds.seeds.filter((seed) => seed.enabled);
  const results = [];

  try {
    for (const seed of enabledSeeds) {
      try {
        const post = await fetchInstagramSeed(seed, { fetchImpl, timeoutMs });
        results.push({ seedId: seed.id, status: "success", post });
      } catch (error) {
        results.push({ seedId: seed.id, status: "failed", error: cleanError(error) });
        throw error;
      }
    }
    const refreshed = buildPlaylistPromoRefresh({ feed, seeds, results, now });
    await writeJsonAtomic(feedPath, refreshed.feed);
    await writeJsonAtomic(statusPath, refreshed.status);
    return refreshed;
  } catch (error) {
    const status = failedStatus({
      previousStatus,
      now,
      seedCount: enabledSeeds.length,
      results,
      error,
    });
    await writeJsonAtomic(statusPath, status);
    const failure = new Error(cleanError(error));
    failure.status = status;
    throw failure;
  }
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const match = argument.match(/^--(feed|seeds|status|now|timeout-ms)=(.+)$/u);
    if (!match) throw new Error(`Argument inconnu : ${argument}`);
    if (match[1] === "timeout-ms") {
      const timeoutMs = Number(match[2]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
        throw new Error("--timeout-ms doit être compris entre 1000 et 60000.");
      }
      options.timeoutMs = timeoutMs;
    } else if (match[1] === "now") {
      if (!Number.isFinite(Date.parse(match[2]))) throw new Error("--now invalide.");
      options.now = new Date(match[2]).toISOString();
    } else {
      options[`${match[1]}Path`] = resolve(match[2]);
    }
  }
  return options;
}

async function main() {
  const result = await refreshPlaylistPromos(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `Pubs playlists : ${result.status.matchedCount}/${result.status.seedCount} vérifiées, ${result.status.updatedCount} mises à jour.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Pubs playlists : ${cleanError(error)}\n`);
    process.exitCode = 1;
  });
}
