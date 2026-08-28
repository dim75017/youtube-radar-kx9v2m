import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = process.env.PUBLIC_HISTORY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_PATH)
  : resolve(ROOT, "data", "public-history.json");
const SUMMARY_PATH = process.env.PUBLIC_HISTORY_SUMMARY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_SUMMARY_PATH)
  : resolve(ROOT, "data", "public-history-summary.json");
const PLATFORMS = new Set(["instagram", "tiktok"]);

function parseOptions(argv) {
  const options = { input: null, dryRun: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
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

function stableInstagramThumbnailUrl(contentUrl) {
  let url;
  try {
    url = new URL(contentUrl);
  } catch {
    return null;
  }
  const shortcode = url.pathname.match(
    /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,64})(?:\/|$)/,
  )?.[1];
  return shortcode
    ? `https://www.instagram.com/p/${shortcode}/media/?size=l`
    : null;
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
  const thumbnailUrl = platform === "instagram"
    ? stableInstagramThumbnailUrl(contentUrl) ?? safeThumbnailUrl(
        target.thumbnailUrl,
        `comments[${index}].target.thumbnailUrl`,
        platform,
        { nullable: true },
      )
    : safeThumbnailUrl(
        target.thumbnailUrl,
        `comments[${index}].target.thumbnailUrl`,
        platform,
        { nullable: true },
      );
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

  return {
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
}

function mergeComment(existing, incoming) {
  if (!existing) return incoming;
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
    publishedAt: incoming.publishedAt ?? existing.publishedAt ?? null,
    likes: incoming.likes ?? existing.likes ?? null,
    comments: incoming.comments ?? existing.comments ?? null,
    raw: {
      ...(existing.raw ?? {}),
      ...incoming.raw,
      firstObservedAt: [existing.raw?.firstObservedAt, incoming.raw.firstObservedAt].filter(Boolean).sort().at(0),
      lastObservedAt: [existing.raw?.lastObservedAt, incoming.raw.lastObservedAt].filter(Boolean).sort().at(-1),
      metricHistory: [...history.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    },
  };
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

  const incoming = source.comments.map((entry, index) => normalizedComment(entry, index, platform, capturedAt));
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
    dryRun: options.dryRun,
  }, null, 2)}\n`);
}

await main();
