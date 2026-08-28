import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const historyPath = resolve(root, "data", "private-youtube-comment-history.json");
const privateMetricsPath = resolve(root, "data", "private-youtube-comment-metrics.json");
const publicMetricsPath = resolve(root, "data", "youtube-comment-metrics.json");
const snapshotPath = resolve(root, "data", "public-history.json");
const summaryPath = resolve(root, "data", "public-history-summary.json");

const MONTHS = {
  "janv.": 0,
  janvier: 0,
  "févr.": 1,
  février: 1,
  mars: 2,
  "avr.": 3,
  avril: 3,
  mai: 4,
  juin: 5,
  "juil.": 6,
  juillet: 6,
  "août": 7,
  "sept.": 8,
  "oct.": 9,
  "nov.": 10,
  "déc.": 11,
};

const [history, privateMetrics, publicMetrics, snapshot, summary] = await Promise.all([
  readJson(historyPath),
  readJson(privateMetricsPath, { results: {} }),
  readJson(publicMetricsPath, { results: {} }),
  readJson(snapshotPath),
  readJson(summaryPath),
]);

if (!Array.isArray(history.comments)) {
  throw new Error("L’historique autorisé des commentaires YouTube est invalide.");
}

const observedAt = validDate(history.extractedAt) ?? snapshot.generatedAt;
const publishedAt = validDate(process.env.PUBLIC_HISTORY_PUBLISHED_AT) ?? new Date().toISOString();
const metricResults = {
  ...(publicMetrics.results ?? {}),
  ...(privateMetrics.results ?? {}),
};
const existing = new Map(snapshot.posts.map((post) => [`${post.platform}:${post.externalId}`, post]));

for (const activity of history.comments) {
  const comment = normalizeComment(activity, observedAt, metricResults);
  if (!comment) continue;
  const key = `${comment.platform}:${comment.externalId}`;
  existing.set(key, mergeComment(existing.get(key), comment));
}

snapshot.posts = sortPosts([...existing.values()]);
const youtube = snapshot.posts.filter((post) => post.platform === "youtube");
const youtubeCommentCount = youtube.filter((post) => post.format === "comment").length;
const youtubeShortCount = youtube.filter((post) => post.format === "short").length;
const youtubeCommunityCount = youtube.filter((post) =>
  ["community_image", "community_poll", "community_text"].includes(post.format),
).length;
const youtubeDates = youtube.map((post) => post.publishedAt).filter(validDate).sort();
const youtubeCoverage = snapshot.coverage.find((item) => item.platform === "youtube");
if (!youtubeCoverage) throw new Error("La couverture YouTube publique est absente.");

youtubeCoverage.scope = `${youtubeShortCount} Shorts + ${youtubeCommunityCount} posts Communauté + ${youtubeCommentCount} commentaires publiés`;
youtubeCoverage.itemCount = youtube.length;
youtubeCoverage.oldestPublishedAt = youtubeDates.at(0) ?? null;
youtubeCoverage.newestPublishedAt = youtubeDates.at(-1) ?? null;
youtubeCoverage.limitations = [...new Set([
  ...(youtubeCoverage.limitations ?? []).filter(
    (item) =>
      !/commentaires publiés par le compte.*ne sont pas énumérables/i.test(item) &&
      item !== "Les commentaires publiés par Lofi Girl proviennent de l’export My Activity autorisé du propriétaire du compte et pointent chacun vers leur page YouTube publique." &&
      item !== "Les likes et réponses sont affichés uniquement lorsqu’ils ont été observés directement sur la page du commentaire ; les autres métriques restent nulles.",
  ),
  "Les commentaires publiés par Lofi Girl proviennent de l’export My Activity autorisé du propriétaire du compte et pointent chacun vers leur page YouTube publique.",
  "Les likes et réponses sont affichés uniquement lorsqu’ils ont été observés directement sur la page du commentaire ; les autres métriques restent nulles.",
])];

snapshot.generatedAt = publishedAt;
summary.totalPostCount = snapshot.posts.length;
summary.platformCounts.youtube = youtube.length;
summary.formatCounts.youtube.comment = youtubeCommentCount;
summary.coverage = snapshot.coverage;
summary.generatedAt = publishedAt;

await Promise.all([
  writeJson(snapshotPath, snapshot),
  writeJson(summaryPath, summary),
]);

console.log(`Commentaires YouTube publiés : ${youtubeCommentCount} · total historique : ${snapshot.posts.length}`);

function normalizeComment(activity, observedAt, metrics) {
  if (!activity || typeof activity.url !== "string" || typeof activity.comment !== "string") return null;
  let externalId;
  let targetUrl;
  let targetId;
  let thumbnailUrl;
  try {
    const url = new URL(activity.url);
    externalId = url.searchParams.get("lc");
    url.searchParams.delete("lc");
    targetUrl = url.toString();
    const videoId = url.searchParams.get("v");
    targetId = videoId ?? url.pathname.match(/^\/post\/([^/?#]+)/)?.[1] ?? null;
    thumbnailUrl = videoId
      ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
      : null;
  } catch {
    return null;
  }
  if (!externalId) return null;

  const metric = metrics[externalId] ?? {};
  const publishedAt = activityDateToIso(activity.dateLabel, activity.time, observedAt);
  const metricCapturedAt = validDate(metric.capturedAt);
  const likes = nonnegative(metric.likes);
  const replies = nonnegative(metric.replies);
  const targetTitle =
    typeof activity.target === "string" && activity.target.trim()
      ? activity.target.trim()
      : "Contenu YouTube commenté";
  return {
    platform: "youtube",
    externalId,
    url: activity.url,
    title: targetTitle,
    text: activity.comment.trim(),
    format: "comment",
    thumbnailUrl,
    publishedAt,
    views: null,
    likes,
    comments: replies,
    shares: null,
    saves: null,
    raw: {
      collector: "authorized-google-my-activity",
      activityType: typeof activity.action === "string" ? activity.action : null,
      sourceKind: "authorized-google-my-activity",
      publishedAtPrecision: /\d{4}/.test(String(activity.dateLabel ?? "")) ? "exact" : "inferred-year",
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      commentTarget: {
        contentId: targetId,
        url: targetUrl,
        title: targetTitle,
        thumbnailUrl,
        authorHandle: null,
        authorName: null,
        authorProfileUrl: null,
        audienceValue: null,
        audienceLabel: null,
        audiencePrecision: "unknown",
        audienceObservedAt: null,
        source: "youtube-comment-permalink",
      },
      metricHistory: metricCapturedAt
        ? [{ capturedAt: metricCapturedAt, views: null, likes, comments: replies, shares: null, saves: null, pollVotes: null, source: "youtube-direct-comment" }]
        : [],
    },
  };
}

function mergeComment(existing, incoming) {
  if (!existing) return incoming;
  const existingHistory = Array.isArray(existing.raw?.metricHistory) ? existing.raw.metricHistory : [];
  const incomingHistory = Array.isArray(incoming.raw?.metricHistory) ? incoming.raw.metricHistory : [];
  const history = new Map();
  for (const point of [...existingHistory, ...incomingHistory]) {
    if (validDate(point?.capturedAt)) history.set(point.capturedAt, point);
  }
  return {
    ...existing,
    ...incoming,
    likes: incoming.likes ?? existing.likes ?? null,
    comments: incoming.comments ?? existing.comments ?? null,
    raw: {
      ...(existing.raw ?? {}),
      ...incoming.raw,
      firstObservedAt: [existing.raw?.firstObservedAt, incoming.raw.firstObservedAt].filter(validDate).sort().at(0) ?? incoming.raw.firstObservedAt,
      lastObservedAt: [existing.raw?.lastObservedAt, incoming.raw.lastObservedAt].filter(validDate).sort().at(-1) ?? incoming.raw.lastObservedAt,
      metricHistory: [...history.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    },
  };
}

function activityDateToIso(dateLabel, time, referenceIso) {
  if (typeof dateLabel !== "string") return null;
  const reference = new Date(referenceIso);
  const [hours = 0, minutes = 0] = typeof time === "string" ? time.split(":").map(Number) : [];
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (dateLabel === "Aujourd’hui" || dateLabel === "Aujourd'hui") {
    return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), hours, minutes)).toISOString();
  }
  if (dateLabel === "Hier") {
    return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() - 1, hours, minutes)).toISOString();
  }
  const match = dateLabel.match(/^(\d{1,2})\s+([^\s]+)(?:\s+(\d{4}))?$/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  return new Date(Date.UTC(Number(match[3] ?? reference.getUTCFullYear()), MONTHS[match[2]], Number(match[1]), hours, minutes)).toISOString();
}

function sortPosts(posts) {
  return posts.sort((left, right) => {
    const leftDate = validDate(left.publishedAt);
    const rightDate = validDate(right.publishedAt);
    if (leftDate && rightDate) return rightDate.localeCompare(leftDate) || left.platform.localeCompare(right.platform) || left.externalId.localeCompare(right.externalId);
    if (leftDate) return -1;
    if (rightDate) return 1;
    return left.platform.localeCompare(right.platform) || left.externalId.localeCompare(right.externalId);
  });
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
