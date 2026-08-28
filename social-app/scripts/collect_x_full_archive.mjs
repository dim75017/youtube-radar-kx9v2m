/**
 * Exhaustive X API v2 full-archive collector for @lofigirl.
 *
 * Authentication is accepted from X_BEARER_TOKEN or TWITTER_BEARER_TOKEN only.
 * Results are merged after every page into work/x-scan-progress.json so an
 * interrupted run can resume from the last next_token without losing data.
 *
 * After the first complete archive pass, use --incremental. That mode is
 * deliberately fail-closed: it only calls X when a completed full-archive
 * marker exists either in the local progress file or in public-history
 * coverage, then requests IDs strictly newer than the newest saved post.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sanitizeJsonUnicode, toWellFormedUnicode, truncateUnicode } from "./lib/well_formed_unicode.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRESS_PATH = resolve(ROOT, "work", "x-scan-progress.json");
const BACKUP_PATH = `${PROGRESS_PATH}.backup`;
const PUBLIC_HISTORY_PATH = resolve(ROOT, "data", "public-history.json");
const ENDPOINT = "https://api.x.com/2/tweets/search/all";
const QUERY = "from:lofigirl -is:retweet";
const PROVIDER = "x-api-v2-full-archive";
const COMPLETE_PUBLIC_HISTORY_STATUS = "complete-api-full-archive";
// Full-archive search otherwise defaults to a recent window. This is the
// earliest date supported by the complete X archive.
const START_TIME = "2006-03-21T00:00:00Z";
const MAX_RESULTS = 500;
const TWEET_FIELDS = [
  "id",
  "text",
  "created_at",
  "public_metrics",
  "attachments",
  "note_tweet",
  "author_id",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
];
const EXPANSIONS = [
  "attachments.media_keys",
  "author_id",
  "referenced_tweets.id",
  "referenced_tweets.id.author_id",
  "referenced_tweets.id.attachments.media_keys",
];
const MEDIA_FIELDS = [
  "media_key",
  "type",
  "url",
  "preview_image_url",
  "width",
  "height",
  "duration_ms",
  "alt_text",
  "public_metrics",
];
const USER_FIELDS = [
  "id",
  "username",
  "name",
  "public_metrics",
];

function parseOptions(argv) {
  const options = {
    dryRun: false,
    restart: false,
    incremental: false,
    maxPages: Number.POSITIVE_INFINITY,
  };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--restart") options.restart = true;
    else if (argument === "--incremental") options.incremental = true;
    else if (argument.startsWith("--max-pages=")) {
      const value = Number(argument.slice("--max-pages=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-pages doit être un entier supérieur ou égal à 1.");
      }
      options.maxPages = value;
    } else {
      throw new Error(`Option inconnue : ${argument}`);
    }
  }
  if (options.restart && options.incremental) {
    throw new Error("--restart et --incremental sont incompatibles : choisissez un nouveau full scan ou la mise à jour incrémentale.");
  }
  return options;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function asFiniteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function asCompactCount(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[
    (match[2] ?? "").toLowerCase()
  ] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

function metricsFromSummary(summary) {
  const parsed = {};
  if (typeof summary !== "string") return parsed;
  const mapping = {
    reply: "comments",
    replies: "comments",
    repost: "shares",
    reposts: "shares",
    like: "likes",
    likes: "likes",
    bookmark: "saves",
    bookmarks: "saves",
    view: "views",
    views: "views",
  };
  for (const match of summary.matchAll(/([\d.,]+(?:[KMB])?)\s+(replies|reply|reposts|repost|likes|like|bookmarks|bookmark|views|view)\b/gi)) {
    parsed[mapping[match[2].toLowerCase()]] = asCompactCount(match[1]);
  }
  return parsed;
}

function maxCount(...values) {
  const counts = values.map(asFiniteCount).filter((value) => value != null);
  return counts.length ? Math.max(...counts) : null;
}

function cleanText(value) {
  return typeof value === "string" ? toWellFormedUnicode(value).replace(/\r\n/g, "\n").trim() : "";
}

function titleFromText(value) {
  const title = cleanText(value).replace(/\s+/g, " ");
  return title ? truncateUnicode(title, 180) : "Post X Lofi Girl";
}

function metricSummary(post) {
  const values = [
    [post.comments, "reply", "replies"],
    [post.shares, "repost", "reposts"],
    [post.likes, "like", "likes"],
    [post.saves, "bookmark", "bookmarks"],
    [post.views, "view", "views"],
  ];
  return values
    .filter(([value]) => value != null)
    .map(([value, singular, plural]) => `${value} ${value === 1 ? singular : plural}`)
    .join(", ");
}

function mediaForTweet(tweet, mediaByKey) {
  const keys = Array.isArray(tweet.attachments?.media_keys) ? tweet.attachments.media_keys : [];
  return keys.map((key) => mediaByKey.get(key)).filter(Boolean).map((item) => ({
    mediaKey: item.media_key,
    type: item.type,
    url: item.url ?? null,
    previewImageUrl: item.preview_image_url ?? null,
    width: asFiniteCount(item.width),
    height: asFiniteCount(item.height),
    durationMs: asFiniteCount(item.duration_ms),
    altText: item.alt_text ?? null,
    publicMetrics: item.public_metrics ?? null,
  }));
}

function apiPost(tweet, mediaByKey, referencedTweetsById, usersById, observedAt) {
  const media = mediaForTweet(tweet, mediaByKey);
  const hasVideo = media.some((item) => item.type === "video" || item.type === "animated_gif");
  const hasStatic = media.some((item) => item.type === "photo");
  const primaryMedia = media.find((item) => item.previewImageUrl || item.url) ?? null;
  const publicMetrics = tweet.public_metrics ?? {};
  const text = cleanText(tweet.note_tweet?.text) || cleanText(tweet.text);
  const retweets = asFiniteCount(publicMetrics.retweet_count);
  const quotes = asFiniteCount(publicMetrics.quote_count);
  const shares = retweets == null && quotes == null ? null : (retweets ?? 0) + (quotes ?? 0);
  const replyReference = Array.isArray(tweet.referenced_tweets)
    ? tweet.referenced_tweets.find((reference) => reference?.type === "replied_to")
    : null;
  const parentTweet = replyReference?.id
    ? referencedTweetsById.get(String(replyReference.id)) ?? null
    : null;
  const parentMedia = parentTweet ? mediaForTweet(parentTweet, mediaByKey) : [];
  const parentPrimaryMedia =
    parentMedia.find((item) => item.previewImageUrl || item.url) ?? null;
  const parentAuthor = parentTweet?.author_id
    ? usersById.get(String(parentTweet.author_id)) ?? null
    : null;
  const parentFollowers = asFiniteCount(parentAuthor?.public_metrics?.followers_count);
  const commentTarget = replyReference
    ? {
        contentId: String(replyReference.id),
        url: parentAuthor?.username
          ? `https://x.com/${parentAuthor.username}/status/${replyReference.id}`
          : `https://x.com/i/status/${replyReference.id}`,
        title: parentTweet ? titleFromText(parentTweet.note_tweet?.text || parentTweet.text) : "Post X commenté",
        thumbnailUrl: parentPrimaryMedia?.previewImageUrl ?? parentPrimaryMedia?.url ?? null,
        authorHandle: parentAuthor?.username ?? null,
        authorName: parentAuthor?.name ?? null,
        authorProfileUrl: parentAuthor?.username
          ? `https://x.com/${parentAuthor.username}`
          : null,
        audienceValue: parentFollowers,
        audienceLabel: parentFollowers == null ? null : `${parentFollowers} abonnés`,
        audiencePrecision: parentFollowers == null ? "unknown" : "exact",
        audienceObservedAt: observedAt,
        source: "x-api-v2-referenced-tweet",
      }
    : null;

  const post = {
    id: String(tweet.id),
    externalId: String(tweet.id),
    platform: "x",
    url: `https://x.com/lofigirl/status/${tweet.id}`,
    text,
    title: titleFromText(text),
    time: tweet.created_at ?? null,
    publishedAt: tweet.created_at ?? null,
    format: commentTarget ? "comment" : hasVideo ? "video" : hasStatic ? "static" : "text",
    image: primaryMedia?.previewImageUrl ?? primaryMedia?.url ?? null,
    thumbnailUrl: primaryMedia?.previewImageUrl ?? primaryMedia?.url ?? null,
    media,
    comments: asFiniteCount(publicMetrics.reply_count),
    shares,
    likes: asFiniteCount(publicMetrics.like_count),
    saves: asFiniteCount(publicMetrics.bookmark_count),
    views: asFiniteCount(publicMetrics.impression_count),
    raw: {
      collector: PROVIDER,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      publicMetrics: {
        ...publicMetrics,
        retweet_count: retweets,
        quote_count: quotes,
      },
      conversationId: tweet.conversation_id ?? null,
      inReplyToUserId: tweet.in_reply_to_user_id ?? null,
      replyToId: replyReference?.id ? String(replyReference.id) : null,
      ...(commentTarget ? { commentTarget } : {}),
    },
  };
  post.metrics = metricSummary(post);
  return post;
}

function mergePost(current, incoming, observedAt) {
  if (!current) return incoming;
  const summaryMetrics = metricsFromSummary(current.metrics);
  const incomingIsOfficialObservation = incoming.raw?.collector === PROVIDER;
  const observedMetric = (key) => incomingIsOfficialObservation
    ? asFiniteCount(incoming[key])
    : maxCount(current[key], summaryMetrics[key], incoming[key]);
  const merged = {
    ...current,
    ...incoming,
    id: String(incoming.id ?? current.id),
    externalId: String(incoming.externalId ?? current.externalId ?? incoming.id ?? current.id),
    platform: "x",
    url: incoming.url || current.url,
    text: incoming.text || current.text || "",
    title: incoming.text ? titleFromText(incoming.text) : current.title || incoming.title,
    time: incoming.time || current.time || null,
    publishedAt: incoming.publishedAt || current.publishedAt || current.time || null,
    format:
      incoming.format === "comment" || current.format !== "comment"
        ? incoming.format
        : current.format,
    image: incoming.image || current.image || current.thumbnailUrl || null,
    thumbnailUrl: incoming.thumbnailUrl || current.thumbnailUrl || current.image || null,
    media: Array.isArray(incoming.media) && incoming.media.length ? incoming.media : current.media,
    comments: observedMetric("comments"),
    shares: observedMetric("shares"),
    likes: observedMetric("likes"),
    saves: observedMetric("saves"),
    views: observedMetric("views"),
    raw: {
      ...(current.raw ?? {}),
      ...(incoming.raw ?? {}),
      firstObservedAt: current.raw?.firstObservedAt ?? incoming.raw?.firstObservedAt ?? observedAt,
      lastObservedAt: observedAt,
    },
  };
  merged.metrics = metricSummary(merged);
  return merged;
}

function sortPosts(posts) {
  return posts.sort((left, right) => {
    const dateOrder = String(right.publishedAt ?? right.time ?? "").localeCompare(
      String(left.publishedAt ?? left.time ?? ""),
    );
    return dateOrder || String(right.id ?? right.externalId ?? "").localeCompare(
      String(left.id ?? left.externalId ?? ""),
    );
  });
}

function asSnowflake(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{1,30}$/.test(normalized) || BigInt(normalized) <= 0n) return null;
  return normalized;
}

function highestSnowflake(posts) {
  let highest = null;
  for (const post of Array.isArray(posts) ? posts : []) {
    const candidate = asSnowflake(post?.externalId) ?? asSnowflake(post?.id);
    if (candidate && (highest == null || BigInt(candidate) > BigInt(highest))) highest = candidate;
  }
  return highest;
}

async function incrementalBaseline(progress) {
  const publicHistory = await readJson(PUBLIC_HISTORY_PATH, { coverage: [], posts: [] });
  const xCoverage = Array.isArray(publicHistory.coverage)
    ? publicHistory.coverage.find((item) => item?.platform === "x")
    : null;
  const localFullArchiveCompleted = Boolean(progress?.xApiFullArchive?.completedAt);
  const publicFullArchiveCompleted = xCoverage?.status === COMPLETE_PUBLIC_HISTORY_STATUS;
  const publicXPosts = publicFullArchiveCompleted && Array.isArray(publicHistory.posts)
    ? publicHistory.posts.filter((post) => post?.platform === "x")
    : [];

  if (!localFullArchiveCompleted && !publicFullArchiveCompleted) {
    throw new Error(
      `Mise à jour X refusée avant tout appel : aucun full scan certifié. Terminez d’abord le rattrapage initial, puis importez-le avec coverage[x].status="${COMPLETE_PUBLIC_HISTORY_STATUS}".`,
    );
  }

  const candidates = [];
  if (localFullArchiveCompleted) {
    const localId = highestSnowflake(progress.posts);
    if (localId) candidates.push({ id: localId, source: "work/x-scan-progress.json" });
  }
  if (publicFullArchiveCompleted) {
    const publicId = highestSnowflake(publicXPosts);
    if (publicId) candidates.push({ id: publicId, source: "data/public-history.json" });
  }
  candidates.sort((left, right) => {
    if (BigInt(left.id) === BigInt(right.id)) return 0;
    return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
  });
  if (!candidates.length) {
    throw new Error("Mise à jour X refusée avant tout appel : le full scan certifié ne contient aucun identifiant X valide.");
  }
  return { ...candidates[0], publicXPosts };
}

async function saveProgress(progress) {
  await mkdir(dirname(PROGRESS_PATH), { recursive: true });
  try {
    await copyFile(PROGRESS_PATH, BACKUP_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${PROGRESS_PATH}.${process.pid}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(sanitizeJsonUnicode(progress), null, 2)}\n`, "utf8");
  await rename(temporaryPath, PROGRESS_PATH);
}

function requestUrl({ nextToken, sinceId = null }) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", QUERY);
  if (sinceId) url.searchParams.set("since_id", sinceId);
  else url.searchParams.set("start_time", START_TIME);
  url.searchParams.set("max_results", String(MAX_RESULTS));
  url.searchParams.set("tweet.fields", TWEET_FIELDS.join(","));
  url.searchParams.set("expansions", EXPANSIONS.join(","));
  url.searchParams.set("media.fields", MEDIA_FIELDS.join(","));
  url.searchParams.set("user.fields", USER_FIELDS.join(","));
  if (nextToken) url.searchParams.set("next_token", nextToken);
  return url;
}

function safeErrorBody(value) {
  return truncateUnicode(String(value ?? "").replace(/\s+/g, " "), 800);
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function fetchPage(bearerToken, request) {
  const url = requestUrl(request);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "User-Agent": "lofi-social-radar/1.0",
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt === 7) throw error;
      const delay = Math.min(30_000, 1_000 * (2 ** attempt));
      process.stderr.write(`Connexion X interrompue, nouvelle tentative dans ${Math.ceil(delay / 1_000)} s.\n`);
      await sleep(delay);
      continue;
    }

    const body = await response.text();
    if (response.ok) {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload.data) && Array.isArray(payload.errors) && payload.errors.length) {
        throw new Error(`X API a refusé la page : ${safeErrorBody(JSON.stringify(payload.errors))}`);
      }
      return payload;
    }

    if (response.status === 429 && attempt < 7) {
      const resetAt = Number(response.headers.get("x-rate-limit-reset"));
      const resetDelay = Number.isFinite(resetAt) ? Math.max(1_000, resetAt * 1_000 - Date.now() + 2_000) : 60_000;
      const delay = Math.min(resetDelay, 16 * 60_000);
      process.stderr.write(`Limite X atteinte, reprise automatique dans ${Math.ceil(delay / 1_000)} s.\n`);
      await sleep(delay);
      continue;
    }

    if (response.status >= 500 && attempt < 7) {
      const delay = Math.min(30_000, 1_000 * (2 ** attempt));
      process.stderr.write(`X API indisponible (${response.status}), nouvelle tentative dans ${Math.ceil(delay / 1_000)} s.\n`);
      await sleep(delay);
      continue;
    }

    throw new Error(`X API ${response.status} ${response.statusText}: ${safeErrorBody(body)}`);
  }
  throw new Error("X API n’a pas répondu après plusieurs tentatives.");
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const bearerToken = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || "";

  let progress = await readJson(PROGRESS_PATH, { posts: [] });
  const currentPosts = Array.isArray(progress.posts) ? progress.posts : [];
  const postsById = new Map();
  for (const post of currentPosts) {
    const id = String(post?.id ?? post?.externalId ?? "");
    if (id) postsById.set(id, post);
  }

  const previousFullScan = progress.xApiFullArchive ?? {};
  // A plain rerun after a completed archive must never repay for the archive by
  // accident. --restart remains the explicit opt-in for a brand-new full pass.
  const incremental = options.incremental || (!options.restart && Boolean(previousFullScan.completedAt));
  const previousScan = incremental ? progress.xApiIncremental ?? {} : previousFullScan;
  const resolvedBaseline = incremental ? await incrementalBaseline(progress) : null;
  // GitHub Actions does not retain the ignored work/ directory between runs.
  // Seed the checkpoint from the certified public snapshot so the importer
  // always receives an exhaustive, non-reducing set even when X returns zero.
  if (incremental) {
    for (const publicPost of resolvedBaseline.publicXPosts) {
      const id = asSnowflake(publicPost?.externalId) ?? asSnowflake(publicPost?.id);
      if (id && !postsById.has(id)) postsById.set(id, { ...publicPost, id });
    }
  }
  const initialKnownPostCount = postsById.size;
  const hasIncrementalResumeState = Array.isArray(previousScan.observedIds)
    && asFiniteCount(previousScan.pagesSinceBaseline) != null
    && asFiniteCount(previousScan.fetchedSinceBaseline) != null;
  const canResume = !options.restart
    && previousScan.query === QUERY
    && typeof previousScan.nextToken === "string"
    && previousScan.nextToken.length > 0
    && !previousScan.completedAt
    && (incremental
      ? asSnowflake(previousScan.sinceId) != null && hasIncrementalResumeState
      : previousScan.startTime === START_TIME);
  if (incremental
    && !previousScan.completedAt
    && previousScan.nextToken
    && !hasIncrementalResumeState) {
    throw new Error("Reprise incrémentale refusée avant tout appel : le checkpoint incomplet ne contient pas l'état d'observation requis.");
  }
  const sinceId = incremental
    ? (canResume ? asSnowflake(previousScan.sinceId) : resolvedBaseline.id)
    : null;
  let nextToken = canResume ? previousScan.nextToken : null;
  const startedAt = canResume && previousScan.startedAt ? previousScan.startedAt : new Date().toISOString();

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      mode: incremental ? "incremental" : "full-archive",
      endpoint: ENDPOINT,
      query: QUERY,
      startTime: incremental ? null : START_TIME,
      sinceId,
      baselineSource: resolvedBaseline?.source ?? null,
      seededPublicPosts: resolvedBaseline?.publicXPosts.length ?? 0,
      resuming: canResume,
      maxResults: MAX_RESULTS,
      tweetFields: TWEET_FIELDS,
      expansions: EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
      progressPath: PROGRESS_PATH,
      publicHistoryPath: PUBLIC_HISTORY_PATH,
      tokenConfigured: Boolean(bearerToken),
      willCallApi: false,
      willWrite: false,
    }, null, 2)}\n`);
    return;
  }

  if (!bearerToken) {
    throw new Error("Token absent : définissez X_BEARER_TOKEN ou TWITTER_BEARER_TOKEN. Aucun appel réseau n’a été effectué.");
  }

  let pagesThisRun = 0;
  let fetchedThisRun = 0;
  let pagesSinceBaseline = canResume ? asFiniteCount(previousScan.pagesSinceBaseline) ?? 0 : 0;
  let fetchedSinceBaseline = canResume ? asFiniteCount(previousScan.fetchedSinceBaseline) ?? 0 : 0;
  const observedIds = new Set();
  if (incremental && canResume) {
    for (const value of previousScan.observedIds) {
      const id = asSnowflake(value);
      if (!id) throw new Error("Reprise incrémentale refusée avant tout appel : observedIds contient un identifiant invalide.");
      observedIds.add(id);
    }
  }

  do {
    const payload = await fetchPage(bearerToken, { nextToken, sinceId });
    const observedAt = new Date().toISOString();
    const mediaByKey = new Map(
      (Array.isArray(payload.includes?.media) ? payload.includes.media : [])
        .filter((item) => item?.media_key)
        .map((item) => [item.media_key, item]),
    );
    const referencedTweetsById = new Map(
      (Array.isArray(payload.includes?.tweets) ? payload.includes.tweets : [])
        .filter((item) => item?.id)
        .map((item) => [String(item.id), item]),
    );
    const usersById = new Map(
      (Array.isArray(payload.includes?.users) ? payload.includes.users : [])
        .filter((item) => item?.id)
        .map((item) => [String(item.id), item]),
    );
    const pageTweets = Array.isArray(payload.data) ? payload.data : [];
    const pageIds = new Set();
    for (const tweet of pageTweets) {
      const incoming = apiPost(
        tweet,
        mediaByKey,
        referencedTweetsById,
        usersById,
        observedAt,
      );
      pageIds.add(incoming.id);
      if (incremental) observedIds.add(incoming.id);
      postsById.set(incoming.id, mergePost(postsById.get(incoming.id), incoming, observedAt));
    }

    pagesThisRun += 1;
    fetchedThisRun += pageTweets.length;
    pagesSinceBaseline += 1;
    fetchedSinceBaseline += pageTweets.length;
    nextToken = payload.meta?.next_token ?? null;
    const completed = !nextToken;

    // A browser-based collector may still be running alongside this one. Re-read
    // the latest file before every checkpoint and retain anything it discovered.
    const latestProgress = await readJson(PROGRESS_PATH, { posts: [] });
    const latestPosts = Array.isArray(latestProgress.posts) ? latestProgress.posts : [];
    for (const diskPost of latestPosts) {
      const id = String(diskPost?.id ?? diskPost?.externalId ?? "");
      if (!id) continue;
      const collectedPost = postsById.get(id);
      if (!collectedPost) {
        postsById.set(id, diskPost);
        continue;
      }
      // Re-loading a baseline row is not a new observation. The disk copy is
      // authoritative unless this exact API response returned the ID.
      if (!pageIds.has(id)) {
        postsById.set(id, diskPost);
        continue;
      }
      postsById.set(id, mergePost(diskPost, collectedPost, observedAt));
    }

    const posts = sortPosts([...postsById.values()]);
    const minimumExpected = Math.max(currentPosts.length, latestPosts.length, initialKnownPostCount);
    if (posts.length < minimumExpected) {
      throw new Error(`Refus de réduire le scan X de ${minimumExpected} à ${posts.length} posts.`);
    }

    const scanState = {
      provider: PROVIDER,
      endpoint: ENDPOINT,
      mode: incremental ? "incremental" : "full-archive",
      query: QUERY,
      startTime: incremental ? null : START_TIME,
      sinceId,
      maxResults: MAX_RESULTS,
      startedAt,
      lastPageAt: observedAt,
      completedAt: completed ? observedAt : null,
      nextToken,
      pagesThisRun,
      fetchedThisRun,
      ...(incremental ? {
        pagesSinceBaseline,
        fetchedSinceBaseline,
        observedIds: [...observedIds].sort((left, right) => {
          if (BigInt(left) === BigInt(right)) return 0;
          return BigInt(left) < BigInt(right) ? -1 : 1;
        }),
      } : {}),
      resultCount: posts.length,
      newestId: highestSnowflake(posts),
    };
    progress = {
      ...latestProgress,
      updatedAt: observedAt,
      posts,
      ...(incremental
        ? { xApiIncremental: scanState }
        : { xApiFullArchive: scanState }),
    };
    await saveProgress(progress);
    process.stdout.write(`${JSON.stringify({
      page: pagesThisRun,
      fetched: pageTweets.length,
      totalFetchedThisRun: fetchedThisRun,
      savedPosts: posts.length,
      nextPage: Boolean(nextToken),
      completed,
    })}\n`);
    if (nextToken && pagesThisRun < options.maxPages) {
      // Full-archive app-only access is limited to one request per second.
      await sleep(1_100);
    }
  } while (nextToken && pagesThisRun < options.maxPages);

  if (nextToken) {
    process.stdout.write(`Pause demandée après ${pagesThisRun} page(s) ; la prochaine exécution reprendra au next_token sauvegardé.\n`);
  } else if (incremental) {
    process.stdout.write(`Mise à jour X incrémentale terminée : ${fetchedThisRun} post(s) retourné(s), depuis l’ID ${sinceId}.\n`);
  } else {
    process.stdout.write(`Scan X Full Archive terminé : ${postsById.size} posts sauvegardés.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
