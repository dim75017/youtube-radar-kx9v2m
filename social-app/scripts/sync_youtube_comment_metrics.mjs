import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const METRICS_PATH = resolve(
  process.env.YOUTUBE_COMMENT_METRICS_PATH ?? resolve(ROOT, "data", "youtube-comment-metrics.json"),
);
const HISTORY_PATH = resolve(
  process.env.PUBLIC_HISTORY_PATH ?? resolve(ROOT, "data", "public-history.json"),
);
const SUMMARY_PATH = resolve(
  process.env.PUBLIC_HISTORY_SUMMARY_PATH ?? resolve(ROOT, "data", "public-history-summary.json"),
);
const STATUS_PATH = resolve(
  process.env.OWNER_COMMENT_REFRESH_STATUS_PATH ?? resolve(ROOT, "data", "owner-comment-refresh-status.json"),
);

const [metrics, snapshot, summary, status] = await Promise.all([
  readJson(METRICS_PATH),
  readJson(HISTORY_PATH),
  readJson(SUMMARY_PATH),
  readJson(STATUS_PATH),
]);

if (!isRecord(metrics.results) || !Array.isArray(snapshot.posts)) {
  throw new Error("Les métriques ou l’historique public YouTube sont invalides.");
}
if (!isRecord(status.platforms) || !isRecord(status.platforms.youtube)) {
  throw new Error("Le statut de rafraîchissement des commentaires YouTube est invalide.");
}

const observedMetricEntries = Object.entries(metrics.results).filter(([, metric]) => {
  if (!isRecord(metric) || !validIso(metric.capturedAt)) return false;
  return nonnegativeInteger(metric.likes) != null || nonnegativeInteger(metric.replies) != null;
});
const latestMetricObservationAt = latestIso(
  ...observedMetricEntries.map(([, metric]) => metric.capturedAt),
);
const total = snapshot.posts.filter(
  (post) => post?.platform === "youtube" && post?.format === "comment",
).length;

let matched = 0;
let updated = 0;
let observationsAdded = 0;
let newestObservationAt = null;

snapshot.posts = snapshot.posts.map((post) => {
  if (post?.platform !== "youtube" || post?.format !== "comment") return post;
  const metric = metrics.results[commentId(post.externalId)];
  if (!isRecord(metric)) return post;
  const capturedAt = validIso(metric.capturedAt);
  if (!capturedAt) return post;
  const likes = nonnegativeInteger(metric.likes);
  const replies = nonnegativeInteger(metric.replies);
  if (likes == null && replies == null) return post;
  matched += 1;
  newestObservationAt = latestIso(newestObservationAt, capturedAt);

  const raw = isRecord(post.raw) ? post.raw : {};
  const existingHistory = Array.isArray(raw.metricHistory)
    ? raw.metricHistory.filter((point) => validIso(point?.capturedAt))
    : [];
  const previousLatestAt = existingHistory
    .map((point) => validIso(point.capturedAt))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const observation = {
    capturedAt,
    views: null,
    likes,
    comments: replies,
    shares: null,
    saves: null,
    pollVotes: null,
    source: typeof metric.source === "string" && metric.source.trim()
      ? metric.source.trim()
      : "youtube-direct-comment",
  };
  const history = new Map(existingHistory.map((point) => [validIso(point.capturedAt), point]));
  if (!history.has(capturedAt)) observationsAdded += 1;
  history.set(capturedAt, observation);

  const isLatest = previousLatestAt == null || capturedAt >= previousLatestAt;
  const nextLikes = isLatest ? likes ?? post.likes ?? null : post.likes ?? null;
  const nextReplies = isLatest ? replies ?? post.comments ?? null : post.comments ?? null;
  if (
    nextLikes !== (post.likes ?? null) ||
    nextReplies !== (post.comments ?? null) ||
    history.size !== existingHistory.length
  ) {
    updated += 1;
  }

  return {
    ...post,
    likes: nextLikes,
    comments: nextReplies,
    raw: {
      ...raw,
      lastObservedAt: latestIso(raw.lastObservedAt, capturedAt) ?? capturedAt,
      metricHistory: [...history.values()].sort((left, right) =>
        left.capturedAt.localeCompare(right.capturedAt)),
    },
  };
});

if (newestObservationAt) {
  snapshot.generatedAt = latestIso(snapshot.generatedAt, newestObservationAt) ?? newestObservationAt;
  summary.generatedAt = latestIso(summary.generatedAt, newestObservationAt) ?? newestObservationAt;
}
if (latestMetricObservationAt) {
  const youtubeStatus = status.platforms.youtube;
  status.generatedAt = latestIso(status.generatedAt, latestMetricObservationAt) ?? latestMetricObservationAt;
  status.platforms.youtube = {
    ...youtubeStatus,
    attemptedAt: latestIso(youtubeStatus.attemptedAt, latestMetricObservationAt)
      ?? latestMetricObservationAt,
    lastRealObservationAt: latestIso(youtubeStatus.lastRealObservationAt, latestMetricObservationAt)
      ?? latestMetricObservationAt,
    metricCoverage: {
      observed: observedMetricEntries.length,
      published: matched,
      total,
    },
  };
}

await Promise.all([
  writeJson(HISTORY_PATH, snapshot),
  writeJson(SUMMARY_PATH, summary),
  writeJson(STATUS_PATH, status),
]);

process.stdout.write(`${JSON.stringify({
  metricCount: Object.keys(metrics.results).length,
  matched,
  updated,
  observationsAdded,
  newestObservationAt,
  metricCoverage: status.platforms.youtube.metricCoverage,
}, null, 2)}\n`);

function commentId(value) {
  return String(value ?? "").replace(/^comment:/, "");
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validIso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestIso(...values) {
  return values.map(validIso).filter(Boolean).sort().at(-1) ?? null;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
