import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY_PATH = process.env.PUBLIC_HISTORY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_PATH)
  : resolve(ROOT, "data", "public-history.json");
const SUMMARY_PATH = process.env.PUBLIC_HISTORY_SUMMARY_PATH
  ? resolve(process.env.PUBLIC_HISTORY_SUMMARY_PATH)
  : resolve(ROOT, "data", "public-history-summary.json");
const PROVIDER = "youtube-public-metadata";
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
  if (options.concurrency > 5) throw new Error("La concurrence maximale est 5 afin de respecter YouTube.");
  return options;
}

function positiveInteger(argument, prefix) {
  const value = Number(argument.slice(prefix.length));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${prefix} attend un entier positif.`);
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function targetUrlForComment(post) {
  try {
    const url = new URL(post.url);
    url.searchParams.delete("lc");
    return url.toString();
  } catch {
    return null;
  }
}

function targetId(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.searchParams.get("v") ?? url.pathname.match(/^\/post\/([^/?#]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function needsTarget(post) {
  if (post.platform !== "youtube" || post.format !== "comment") return false;
  const target = post.raw?.commentTarget;
  return !isRecord(target) || !target.authorName || target.audienceValue == null || !target.thumbnailUrl;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(html.match(new RegExp(`<meta\\s+property=["']${escaped}["']\\s+content=["']([^"']*)`, "i"))?.[1] ?? "").trim() || null;
}

function compactTitle(value, fallback) {
  const text = String(value ?? fallback ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Contenu YouTube commenté";
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/json",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  return response.text();
}

function channelMetadataFromHtml(html, fallbackUrl) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let entity = null;
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isRecord(parsed?.mainEntity)) entity = parsed.mainEntity;
    } catch {
      // Ignore unrelated or malformed structured-data blocks.
    }
  }
  const statistics = Array.isArray(entity?.interactionStatistic) ? entity.interactionStatistic : [];
  const follow = statistics.find((item) => isRecord(item) && item.interactionType?.["@type"] === "FollowAction");
  const audienceValue = Number.isInteger(Number(follow?.userInteractionCount))
    ? Number(follow.userInteractionCount)
    : null;
  const profileUrl = httpsUrl(entity?.url) ?? fallbackUrl;
  let handle = typeof entity?.alternateName === "string" ? entity.alternateName.replace(/^@/, "") : null;
  if (!handle && profileUrl) handle = new URL(profileUrl).pathname.match(/^\/@([^/?#]+)/)?.[1] ?? null;
  return {
    authorName: typeof entity?.name === "string" ? entity.name : null,
    authorHandle: handle,
    authorProfileUrl: profileUrl,
    audienceValue,
    audienceLabel: audienceValue == null
      ? null
      : `${new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(audienceValue)} abonnés`,
  };
}

const channelCache = new Map();

async function channelMetadata(authorUrl) {
  if (!authorUrl) return { authorName: null, authorHandle: null, authorProfileUrl: null, audienceValue: null, audienceLabel: null };
  if (!channelCache.has(authorUrl)) {
    channelCache.set(authorUrl, (async () => {
      const html = await fetchText(`${authorUrl.replace(/\/$/, "")}/about`);
      return html
        ? channelMetadataFromHtml(html, authorUrl)
        : { authorName: null, authorHandle: null, authorProfileUrl: authorUrl, audienceValue: null, audienceLabel: null };
    })());
  }
  return channelCache.get(authorUrl);
}

async function videoTarget(urlValue, observedAt) {
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(urlValue)}`;
  const raw = await fetchText(endpoint);
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const authorUrl = httpsUrl(data.author_url);
  const channel = await channelMetadata(authorUrl);
  return {
    contentId: targetId(urlValue),
    url: urlValue,
    title: compactTitle(data.title),
    thumbnailUrl: httpsUrl(data.thumbnail_url),
    authorHandle: channel.authorHandle,
    authorName: channel.authorName ?? (typeof data.author_name === "string" ? data.author_name : null),
    authorProfileUrl: channel.authorProfileUrl ?? authorUrl,
    audienceValue: channel.audienceValue,
    audienceLabel: channel.audienceLabel,
    audiencePrecision: channel.audienceValue == null ? "unknown" : "platform-rounded",
    audienceObservedAt: observedAt,
    source: PROVIDER,
  };
}

async function communityTarget(urlValue, observedAt) {
  const html = await fetchText(urlValue);
  if (!html) return null;
  const authorMatch = html.match(/authorText"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"[\s\S]{0,900}?canonicalBaseUrl"\s*:\s*"([^"]+)"/);
  const authorName = authorMatch ? decodeHtml(authorMatch[1]) : null;
  const authorUrl = authorMatch?.[2]?.startsWith("/")
    ? httpsUrl(`https://www.youtube.com${authorMatch[2]}`)
    : httpsUrl(authorMatch?.[2]);
  const channel = await channelMetadata(authorUrl);
  const description = metaContent(html, "og:description");
  return {
    contentId: targetId(urlValue),
    url: urlValue,
    title: compactTitle(description, metaContent(html, "og:title")),
    thumbnailUrl: httpsUrl(metaContent(html, "og:image")),
    authorHandle: channel.authorHandle,
    authorName: channel.authorName ?? authorName,
    authorProfileUrl: channel.authorProfileUrl ?? authorUrl,
    audienceValue: channel.audienceValue,
    audienceLabel: channel.audienceLabel,
    audiencePrecision: channel.audienceValue == null ? "unknown" : "platform-rounded",
    audienceObservedAt: observedAt,
    source: PROVIDER,
  };
}

async function targetMetadata(urlValue, observedAt) {
  return new URL(urlValue).pathname.startsWith("/post/")
    ? communityTarget(urlValue, observedAt)
    : videoTarget(urlValue, observedAt);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [snapshot, summary] = await Promise.all([
    JSON.parse(await readFile(HISTORY_PATH, "utf8")),
    JSON.parse(await readFile(SUMMARY_PATH, "utf8")),
  ]);
  const targetCandidates = new Map();
  for (const post of snapshot.posts
    .filter(needsTarget)
    .sort((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? "")))) {
    const url = targetUrlForComment(post);
    if (url && !targetCandidates.has(url)) targetCandidates.set(url, post);
    if (targetCandidates.size >= options.limit) break;
  }
  const targets = [...targetCandidates.keys()];
  const observedAt = new Date().toISOString();
  const enrichments = new Map();
  let unavailable = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const url = targets[index];
      try {
        const target = await targetMetadata(url, observedAt);
        if (target) enrichments.set(url, target);
        else unavailable += 1;
      } catch {
        unavailable += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, targets.length) }, () => worker()));

  let enrichedComments = 0;
  const nextPosts = snapshot.posts.map((post) => {
    if (post.platform !== "youtube" || post.format !== "comment") return post;
    const url = targetUrlForComment(post);
    const target = url ? enrichments.get(url) : null;
    if (!target) return post;
    enrichedComments += 1;
    return {
      ...post,
      title: target.title,
      thumbnailUrl: target.thumbnailUrl ?? post.thumbnailUrl ?? null,
      raw: { ...(post.raw ?? {}), commentTarget: target },
    };
  });

  if (!options.dryRun && enrichedComments > 0) {
    await Promise.all([
      writeFile(HISTORY_PATH, `${JSON.stringify({ ...snapshot, posts: nextPosts }, null, 2)}\n`, "utf8"),
      writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    ]);
  }
  const remainingTargets = new Set(
    snapshot.posts.filter(needsTarget).map(targetUrlForComment).filter(Boolean),
  ).size - enrichments.size;
  process.stdout.write(`${JSON.stringify({
    provider: PROVIDER,
    observedAt,
    candidateTargetCount: targets.length,
    enrichedTargets: enrichments.size,
    enrichedComments,
    unavailable,
    remainingTargets: Math.max(0, remainingTargets),
    dryRun: options.dryRun,
  }, null, 2)}\n`);
}

await main();
