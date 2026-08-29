import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = process.env.PUBLIC_HISTORY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_PATH)
  : resolve(ROOT, "data", "public-history.json");
const SUMMARY_PATH = process.env.PUBLIC_HISTORY_SUMMARY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_SUMMARY_PATH)
  : resolve(ROOT, "data", "public-history-summary.json");
const INSTAGRAM_MEDIA_DIR = process.env.OWNER_COMMENT_INSTAGRAM_MEDIA_DIR
  ? resolve(process.env.OWNER_COMMENT_INSTAGRAM_MEDIA_DIR)
  : resolve(ROOT, "public", "media", "instagram");
const INSTAGRAM_MEDIA_BASE =
  "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram";
const PLATFORMS = new Set(["instagram", "tiktok"]);
const MEDIA_CONCURRENCY = 4;
const MEDIA_TIMEOUT_MS = 20_000;
const MAX_MEDIA_BYTES = 5_000_000;

function parseOptions(argv) {
  const options = { input: null, dryRun: false, skipMediaCache: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--skip-media-cache") options.skipMediaCache = true;
    else if (argument.startsWith("--input=")) options.input = argument.slice("--input=".length);
    else throw new Error(`Option inconnue : ${argument}`);
  }
  if (!options.input) throw new Error("--input=<fichier JSON privé> est requis.");
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} doit être une chaîne non vide.`);
  }
  return value.trim();
}

function nullableString(value, label) {
  if (value == null) return null;
  return requireString(value, label);
}

function nullableCount(value, label) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} doit être un entier positif ou null.`);
  }
  return value;
}

function requireIso(value, label) {
  const normalized = requireString(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} doit être une date ISO valide.`);
  return new Date(normalized).toISOString();
}

function nullableIso(value, label) {
  return value == null ? null : requireIso(value, label);
}

function safeHttpsUrl(value, label, platform, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = requireString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} doit être une URL valide.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} doit utiliser HTTPS.`);
  const hostname = url.hostname.toLowerCase();
  const allowed = platform === "instagram"
    ? hostname === "instagram.com" || hostname.endsWith(".instagram.com") || hostname.endsWith(".cdninstagram.com") || hostname.endsWith(".fbcdn.net")
    : hostname === "tiktok.com" || hostname.endsWith(".tiktok.com");
  if (!allowed) throw new Error(`${label} ne correspond pas à ${platform}.`);
  return url.toString();
}

function isHostOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function safeThumbnailUrl(value, label, platform, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = requireString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} doit être une URL valide.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} doit utiliser HTTPS.`);
  const hostname = url.hostname.toLowerCase();
  const allowed = platform === "instagram"
    ? ["instagram.com", "cdninstagram.com", "fbcdn.net"].some((domain) => isHostOrSubdomain(hostname, domain))
    : ["tiktokcdn.com", "tiktokcdn-eu.com", "tiktokcdn-us.com"].some((domain) => isHostOrSubdomain(hostname, domain));
  if (!allowed) throw new Error(`${label} ne correspond pas à un CDN ${platform} autorisé.`);
  return url.toString();
}

function instagramShortcode(contentUrl) {
  let url;
  try {
    url = new URL(contentUrl);
  } catch {
    return null;
  }
  return url.pathname.match(
    /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]{5,64})(?:\/|$)/,
  )?.[1] ?? null;
}

function cachedInstagramThumbnailUrl(contentUrl) {
  const shortcode = instagramShortcode(contentUrl);
  return shortcode ? `${INSTAGRAM_MEDIA_BASE}/${shortcode}.jpg` : null;
}

function directInstagramThumbnailUrl(contentUrl) {
  const shortcode = instagramShortcode(contentUrl);
  return shortcode ? `https://www.instagram.com/p/${shortcode}/media/?size=l` : null;
}

async function usableJpeg(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1_000 || info.size > MAX_MEDIA_BYTES) return false;
    const bytes = await readFile(path);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(path, bytes) {
  const temporary = `${path}.${process.pid}.${Date.now()}.next`;
  try {
    await writeFile(temporary, bytes);
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error?.code)) throw error;
      await unlink(path).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function downloadInstagramThumbnail(media) {
  const destination = resolve(INSTAGRAM_MEDIA_DIR, `${media.shortcode}.jpg`);
  if (await usableJpeg(destination)) return "cached";

  const candidates = [media.sourceUrl, media.directUrl].filter(
    (value, index, values) =>
      typeof value === "string" && value.startsWith("https://") && values.indexOf(value) === index,
  );
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("image/jpeg")) {
        throw new Error(`type inattendu ${contentType || "absent"}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.length < 1_000 ||
        bytes.length > MAX_MEDIA_BYTES ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff
      ) {
        throw new Error(`JPEG invalide (${bytes.length} octets)`);
      }
      await writeAtomically(destination, bytes);
      return "downloaded";
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Miniature Instagram ${media.shortcode} indisponible : ${lastError?.message ?? lastError}`,
  );
}

async function cacheInstagramThumbnails(mediaItems) {
  const unique = new Map();
  for (const media of mediaItems) {
    if (media) unique.set(media.shortcode, media);
  }
  await mkdir(INSTAGRAM_MEDIA_DIR, { recursive: true });
  const queue = [...unique.values()];
  let cursor = 0;
  let downloaded = 0;
  let cached = 0;
  async function worker() {
    while (cursor < queue.length) {
      const media = queue[cursor++];
      const result = await downloadInstagramThumbnail(media);
      if (result === "downloaded") downloaded += 1;
      else cached += 1;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MEDIA_CONCURRENCY, Math.max(1, queue.length)) }, () => worker()),
  );
  return { downloaded, cached };
}

function precision(value, label) {
  if (value == null) return "unknown";
  if (!["exact", "platform-rounded", "unknown"].includes(value)) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function normalizedComment(entry, index, platform, capturedAt) {
  const row = requireRecord(entry, `comments[${index}]`);
  const id = requireString(row.id, `comments[${index}].id`);
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(id)) {
    throw new Error(`comments[${index}].id contient des caractères non autorisés.`);
  }
  const text = requireString(row.text, `comments[${index}].text`);
  const target = requireRecord(row.target, `comments[${index}].target`);
  const contentUrl = safeHttpsUrl(target.url, `comments[${index}].target.url`, platform);
  const commentUrl = safeHttpsUrl(row.url ?? contentUrl, `comments[${index}].url`, platform);
  const publishedAt = nullableIso(row.publishedAt, `comments[${index}].publishedAt`);
  const audienceValue = nullableCount(target.audienceValue, `comments[${index}].target.audienceValue`);
  const audiencePrecision = precision(target.audiencePrecision, `comments[${index}].target.audiencePrecision`);
  const sourceThumbnailUrl = safeThumbnailUrl(
    target.thumbnailUrl,
    `comments[${index}].target.thumbnailUrl`,
    platform,
    { nullable: true },
  );
  const thumbnailUrl = platform === "instagram"
    ? cachedInstagramThumbnailUrl(contentUrl) ?? sourceThumbnailUrl
    : sourceThumbnailUrl;
  const metrics = row.metrics == null ? {} : requireRecord(row.metrics, `comments[${index}].metrics`);
  const likes = nullableCount(metrics.likes, `comments[${index}].metrics.likes`);
  const replies = nullableCount(metrics.replies, `comments[${index}].metrics.replies`);
  const targetTitle = nullableString(target.title, `comments[${index}].target.title`) ?? `Contenu ${platform} commenté`;
  const source = `authorized-${platform}-activity`;
  const metricHistory = likes == null && replies == null
    ? []
    : [{
        capturedAt,
        views: null,
        likes,
        comments: replies,
        shares: null,
        saves: null,
        pollVotes: null,
        source,
      }];

  const post = {
    platform,
    externalId: `comment:${id}`,
    url: commentUrl,
    title: targetTitle,
    text,
    format: "comment",
    thumbnailUrl,
    publishedAt,
    views: null,
    likes,
    comments: replies,
    shares: null,
    saves: null,
    raw: {
      collector: source,
      activityType: "published-comment",
      sourceKind: source,
      publishedAtPrecision: publishedAt ? "exact" : "unknown",
      firstObservedAt: capturedAt,
      lastObservedAt: capturedAt,
      commentTarget: {
        contentId: nullableString(target.contentId, `comments[${index}].target.contentId`),
        url: contentUrl,
        title: targetTitle,
        thumbnailUrl,
        authorHandle: nullableString(target.authorHandle, `comments[${index}].target.authorHandle`),
        authorName: nullableString(target.authorName, `comments[${index}].target.authorName`),
        authorProfileUrl: safeHttpsUrl(target.authorProfileUrl, `comments[${index}].target.authorProfileUrl`, platform, { nullable: true }),
        audienceValue,
        audienceLabel: nullableString(target.audienceLabel, `comments[${index}].target.audienceLabel`),
        audiencePrecision,
        audienceObservedAt: nullableIso(target.audienceObservedAt, `comments[${index}].target.audienceObservedAt`),
        source,
      },
      metricHistory,
    },
  };
  const shortcode = platform === "instagram" ? instagramShortcode(contentUrl) : null;
  return {
    post,
    media: shortcode
      ? {
          shortcode,
          sourceUrl: sourceThumbnailUrl,
          directUrl: directInstagramThumbnailUrl(contentUrl),
        }
      : null,
  };
}

function mergeComment(existing, incoming) {
  if (!existing) return incoming;
  const existingTarget = isRecord(existing.raw?.commentTarget) ? existing.raw.commentTarget : {};
  const incomingTarget = isRecord(incoming.raw?.commentTarget) ? incoming.raw.commentTarget : {};
  const history = new Map();
  for (const point of [
    ...(Array.isArray(existing.raw?.metricHistory) ? existing.raw.metricHistory : []),
    ...(Array.isArray(incoming.raw?.metricHistory) ? incoming.raw.metricHistory : []),
  ]) {
    if (point?.capturedAt && Number.isFinite(Date.parse(point.capturedAt))) {
      history.set(point.capturedAt, point);
    }
  }
  return {
    ...existing,
    ...incoming,
    title: isGenericCommentTargetTitle(incoming.title) ? existing.title ?? incoming.title : incoming.title,
    thumbnailUrl: incoming.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    publishedAt: incoming.publishedAt ?? existing.publishedAt ?? null,
    likes: incoming.likes ?? existing.likes ?? null,
    comments: incoming.comments ?? existing.comments ?? null,
    raw: {
      ...(existing.raw ?? {}),
      ...incoming.raw,
      firstObservedAt: [existing.raw?.firstObservedAt, incoming.raw.firstObservedAt].filter(Boolean).sort().at(0),
      lastObservedAt: [existing.raw?.lastObservedAt, incoming.raw.lastObservedAt].filter(Boolean).sort().at(-1),
      commentTarget: mergeNullableRecord(existingTarget, incomingTarget),
      metricHistory: [...history.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    },
  };
}

function mergeNullableRecord(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "title" && isGenericCommentTargetTitle(value) && !isGenericCommentTargetTitle(merged[key])) {
      continue;
    }
    if (key === "audiencePrecision" && value === "unknown" && merged[key] && merged[key] !== "unknown") {
      continue;
    }
    if (value != null || merged[key] == null) merged[key] = value;
  }
  return merged;
}

function isGenericCommentTargetTitle(value) {
  return typeof value === "string" && /^Contenu (?:instagram|tiktok) commenté$/i.test(value.trim());
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function latestIso(...values) {
  return values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort().at(-1);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const inputPath = resolve(options.input);
  const [input, snapshot, summary] = await Promise.all([
    readJson(inputPath),
    readJson(HISTORY_PATH),
    readJson(SUMMARY_PATH),
  ]);
  const source = requireRecord(input, "input");
  const platform = requireString(source.platform, "input.platform");
  if (!PLATFORMS.has(platform)) throw new Error("input.platform doit être instagram ou tiktok.");
  const capturedAt = requireIso(source.capturedAt, "input.capturedAt");
  if (!Array.isArray(source.comments)) throw new Error("input.comments doit être un tableau.");

  const normalized = source.comments.map((entry, index) => normalizedComment(entry, index, platform, capturedAt));
  const incoming = normalized.map((item) => item.post);
  const unique = new Map();
  for (const item of incoming) unique.set(item.externalId, item);
  const posts = new Map(snapshot.posts.map((post) => [`${post.platform}:${post.externalId}`, post]));
  let inserted = 0;
  let updated = 0;
  for (const item of unique.values()) {
    const key = `${platform}:${item.externalId}`;
    const previous = posts.get(key);
    posts.set(key, mergeComment(previous, item));
    if (previous) updated += 1;
    else inserted += 1;
  }

  const nextPosts = [...posts.values()].sort((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? "")));
  const nextGeneratedAt = latestIso(snapshot.generatedAt, capturedAt) ?? capturedAt;
  const nextSnapshot = { ...snapshot, generatedAt: nextGeneratedAt, posts: nextPosts };
  const platformPosts = nextPosts.filter((post) => post.platform === platform);
  const nextSummary = {
    ...summary,
    generatedAt: nextGeneratedAt,
    totalPostCount: nextPosts.length,
    platformCounts: { ...summary.platformCounts, [platform]: platformPosts.length },
    formatCounts: {
      ...summary.formatCounts,
      [platform]: {
        ...(summary.formatCounts?.[platform] ?? {}),
        comment: platformPosts.filter((post) => post.format === "comment").length,
      },
    },
  };

  let media = { downloaded: 0, cached: 0 };
  if (platform === "instagram" && !options.dryRun && !options.skipMediaCache) {
    media = await cacheInstagramThumbnails(normalized.map((item) => item.media));
  }

  if (!options.dryRun) {
    await Promise.all([
      writeFile(HISTORY_PATH, `${JSON.stringify(nextSnapshot, null, 2)}\n`, "utf8"),
      writeFile(SUMMARY_PATH, `${JSON.stringify(nextSummary, null, 2)}\n`, "utf8"),
    ]);
  }
  process.stdout.write(`${JSON.stringify({
    platform,
    capturedAt,
    inputCount: source.comments.length,
    uniqueCount: unique.size,
    inserted,
    updated,
    mediaDownloaded: media.downloaded,
    mediaCached: media.cached,
    dryRun: options.dryRun,
  }, null, 2)}\n`);
}

await main();
