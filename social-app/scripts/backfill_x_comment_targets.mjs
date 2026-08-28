import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = process.env.PUBLIC_HISTORY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_PATH)
  : resolve(ROOT, "data", "public-history.json");
const SUMMARY_PATH = process.env.PUBLIC_HISTORY_SUMMARY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_SUMMARY_PATH)
  : resolve(ROOT, "data", "public-history-summary.json");
const PROVIDER = "fxtwitter-public-thread";
const USER_AGENT = "lofi-radar-comment-history/1.0";

function parseOptions(argv) {
  const options = { limit: 120, concurrency: 3, dryRun: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--all") options.limit = Number.POSITIVE_INFINITY;
    else if (argument.startsWith("--limit=")) options.limit = positiveInteger(argument, "--limit=");
    else if (argument.startsWith("--concurrency=")) options.concurrency = positiveInteger(argument, "--concurrency=");
    else throw new Error(`Option inconnue : ${argument}`);
  }
  if (options.concurrency > 5) throw new Error("La concurrence maximale est 5 afin de respecter la source publique.");
  return options;
}

function positiveInteger(argument, prefix) {
  const value = Number(argument.slice(prefix.length));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${prefix} attend un entier positif.`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasStoredTarget(post) {
  return isRecord(post.raw?.commentTarget) && typeof post.raw.commentTarget.url === "string";
}

function legacyReplyCandidate(post) {
  return post.platform === "x" && (
    post.format === "comment" ||
    /^@[A-Za-z0-9_]{1,30}\b/.test(String(post.text ?? "").trim())
  );
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parentThumbnail(parent) {
  const media = isRecord(parent?.media) ? parent.media : {};
  const candidates = [
    ...(Array.isArray(media.all) ? media.all : []),
    ...(Array.isArray(media.photos) ? media.photos : []),
    ...(Array.isArray(media.videos) ? media.videos : []),
  ];
  for (const item of candidates) {
    if (!isRecord(item)) continue;
    const candidate = httpsUrl(item.thumbnail_url) ?? httpsUrl(item.url);
    if (candidate) return candidate;
  }
  return null;
}

function compactTitle(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Post X commenté";
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

async function fetchThread(id) {
  const endpoint = `https://api.fxtwitter.com/2/thread/${encodeURIComponent(id)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(endpoint, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) return null;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800 * (attempt + 1)));
  }
  return null;
}

function targetFromThread(payload, observedAt) {
  if (!isRecord(payload) || !isRecord(payload.status)) return null;
  const status = payload.status;
  const reply = isRecord(status.replying_to) ? status.replying_to : null;
  const parentId = reply?.status == null ? null : String(reply.status);
  if (!parentId || !Array.isArray(payload.thread)) return null;
  const parent = payload.thread.find((item) => isRecord(item) && String(item.id) === parentId);
  if (!isRecord(parent)) return null;
  const author = isRecord(parent.author) ? parent.author : {};
  const followers = Number.isInteger(author.followers) && author.followers >= 0
    ? author.followers
    : null;
  const parentUrl = httpsUrl(parent.url) ?? httpsUrl(reply.url);
  if (!parentUrl) return null;

  return {
    contentId: parentId,
    url: parentUrl,
    title: compactTitle(parent.text),
    thumbnailUrl: parentThumbnail(parent),
    authorHandle: typeof author.screen_name === "string" ? author.screen_name : null,
    authorName: typeof author.name === "string" ? author.name : null,
    authorProfileUrl: httpsUrl(author.url) ?? httpsUrl(reply.profile_url),
    audienceValue: followers,
    audienceLabel: followers == null ? null : `${followers} abonnés`,
    audiencePrecision: followers == null ? "unknown" : "exact",
    audienceObservedAt: observedAt,
    source: PROVIDER,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [snapshot, summary] = await Promise.all([
    readJson(HISTORY_PATH),
    readJson(SUMMARY_PATH),
  ]);
  const candidates = snapshot.posts
    .filter((post) => legacyReplyCandidate(post) && !hasStoredTarget(post))
    .sort((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? "")))
    .slice(0, options.limit);
  const observedAt = new Date().toISOString();
  const enrichments = new Map();
  let unavailable = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const post = candidates[index];
      try {
        const payload = await fetchThread(String(post.externalId));
        const target = targetFromThread(payload, observedAt);
        if (target) enrichments.set(String(post.externalId), target);
        else unavailable += 1;
      } catch {
        unavailable += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, candidates.length) }, () => worker()));

  const nextPosts = snapshot.posts.map((post) => {
    if (post.platform !== "x") return post;
    const target = enrichments.get(String(post.externalId));
    if (!target) return post;
    return {
      ...post,
      format: "comment",
      raw: {
        ...(post.raw ?? {}),
        legacyFormat: post.format,
        replyToId: target.contentId,
        commentTarget: target,
      },
    };
  });
  const xPosts = nextPosts.filter((post) => post.platform === "x");
  const publishedXPosts = xPosts.filter((post) => !legacyReplyCandidate(post));
  const nextSummary = {
    ...summary,
    formatCounts: {
      ...summary.formatCounts,
      x: {
        ...(summary.formatCounts?.x ?? {}),
        comment: xPosts.length - publishedXPosts.length,
        static: publishedXPosts.filter((post) => post.format === "static").length,
        video: publishedXPosts.filter((post) => post.format === "video").length,
        text: publishedXPosts.filter((post) => post.format === "text").length,
      },
    },
  };

  if (!options.dryRun && enrichments.size > 0) {
    await Promise.all([
      writeFile(HISTORY_PATH, `${JSON.stringify({ ...snapshot, posts: nextPosts }, null, 2)}\n`, "utf8"),
      writeFile(SUMMARY_PATH, `${JSON.stringify(nextSummary, null, 2)}\n`, "utf8"),
    ]);
  }

  process.stdout.write(`${JSON.stringify({
    provider: PROVIDER,
    observedAt,
    candidateCount: candidates.length,
    enriched: enrichments.size,
    unavailable,
    remaining: Math.max(0, snapshot.posts.filter((post) => legacyReplyCandidate(post) && !hasStoredTarget(post)).length - enrichments.size),
    dryRun: options.dryRun,
  }, null, 2)}\n`);
}

await main();
