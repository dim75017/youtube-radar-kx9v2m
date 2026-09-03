import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { collectYoutubeApiMetrics } from "../scripts/youtube_comment_metrics_api.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts", "sync_youtube_comment_metrics.mjs");

test("publishes every collected YouTube comment metric without losing history", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "youtube-comment-sync-"));
  const metricsPath = resolve(directory, "metrics.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
  const statusPath = resolve(directory, "status.json");
  await writeFile(metricsPath, JSON.stringify({
    results: {
      commentA: {
        likes: 130_000,
        replies: 784,
        capturedAt: "2026-08-29T08:00:00.000Z",
        source: "youtube-direct-comment",
      },
      commentB: {
        likes: 4,
        replies: 2,
        capturedAt: "2026-08-27T08:00:00.000Z",
        source: "youtube-direct-comment",
      },
    },
  }));
  await writeFile(historyPath, JSON.stringify({
    generatedAt: "2026-08-28T00:00:00.000Z",
    posts: [
      {
        platform: "youtube",
        externalId: "commentA",
        format: "comment",
        likes: null,
        comments: null,
        raw: { metricHistory: [] },
      },
      {
        platform: "youtube",
        externalId: "commentB",
        format: "comment",
        likes: 9,
        comments: 3,
        raw: {
          metricHistory: [{
            capturedAt: "2026-08-28T08:00:00.000Z",
            likes: 9,
            comments: 3,
            source: "youtube-direct-comment",
          }],
        },
      },
      { platform: "youtube", externalId: "video", format: "video", likes: 99 },
    ],
  }));
  await writeFile(summaryPath, JSON.stringify({ generatedAt: "2026-08-28T00:00:00.000Z" }));
  await writeFile(statusPath, JSON.stringify({
    generatedAt: "2026-08-28T00:00:00.000Z",
    platforms: {
      youtube: {
        status: "partial",
        attemptedAt: "2026-08-28T00:00:00.000Z",
        lastRealObservationAt: "2026-08-28T00:00:00.000Z",
        inventoryStatus: "stale",
        endReached: null,
        metricCoverage: { observed: 0, published: 0, total: 2 },
        error: "L’inventaire propriétaire complet reste à rescanner.",
      },
    },
  }));

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      YOUTUBE_COMMENT_METRICS_PATH: metricsPath,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
      OWNER_COMMENT_REFRESH_STATUS_PATH: statusPath,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  const [fresh, stale, video] = history.posts;
  assert.equal(fresh.likes, 130_000);
  assert.equal(fresh.comments, 784);
  assert.equal(fresh.raw.metricHistory.length, 1);
  assert.equal(fresh.raw.lastObservedAt, "2026-08-29T08:00:00.000Z");
  assert.equal(stale.likes, 9, "an older observation must not replace the latest total");
  assert.equal(stale.comments, 3);
  assert.equal(stale.raw.metricHistory.length, 2);
  assert.equal(video.likes, 99);
  assert.equal(history.generatedAt, "2026-08-29T08:00:00.000Z");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.deepEqual(status.platforms.youtube.metricCoverage, {
    observed: 2,
    published: 2,
    total: 2,
  });
  assert.equal(status.platforms.youtube.attemptedAt, "2026-08-29T08:00:00.000Z");
  assert.equal(status.platforms.youtube.lastRealObservationAt, "2026-08-29T08:00:00.000Z");
  assert.equal(status.platforms.youtube.status, "partial");
  assert.equal(status.platforms.youtube.inventoryStatus, "stale");
  assert.equal(status.platforms.youtube.endReached, null);
  assert.equal(status.platforms.youtube.error, "L’inventaire propriétaire complet reste à rescanner.");

  const serialized = await readFile(historyPath, "utf8");
  const serializedStatus = await readFile(statusPath, "utf8");
  const repeated = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      YOUTUBE_COMMENT_METRICS_PATH: metricsPath,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
      OWNER_COMMENT_REFRESH_STATUS_PATH: statusPath,
    },
  });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(await readFile(historyPath, "utf8"), serialized);
  assert.equal(await readFile(statusPath, "utf8"), serializedStatus);
});

test("keeps the checked-in metrics and public comment cards in parity", async () => {
  const [metrics, history] = await Promise.all([
    readJson(resolve(ROOT, "data", "youtube-comment-metrics.json")),
    readJson(resolve(ROOT, "data", "public-history.json")),
  ]);
  const comments = new Map(
    history.posts
      .filter((post) => post.platform === "youtube" && post.format === "comment")
      .map((post) => [String(post.externalId).replace(/^comment:/, ""), post]),
  );
  for (const [id, metric] of Object.entries(metrics.results)) {
    if (!Number.isInteger(metric.likes) && !Number.isInteger(metric.replies)) continue;
    const post = comments.get(id);
    assert.ok(post, `missing public YouTube comment ${id}`);
    assert.ok(
      post.raw.metricHistory.some((point) => point.capturedAt === metric.capturedAt),
      `missing metric observation for ${id}`,
    );
  }

  const gta = comments.get("UgxIBbRhXJjWKuj224Z4AaABAg");
  const smoking = comments.get("Ugx5LAFnueKv7eNB6t14AaABAg");
  const gtaMetric = metrics.results.UgxIBbRhXJjWKuj224Z4AaABAg;
  const smokingMetric = metrics.results.Ugx5LAFnueKv7eNB6t14AaABAg;
  assert.equal(gta.likes, gtaMetric.likes);
  assert.equal(gta.comments, gtaMetric.replies);
  assert.equal(gta.raw.commentTarget.audienceValue, 13_600_000);
  assert.equal(smoking.likes, smokingMetric.likes);
  assert.equal(smoking.comments, smokingMetric.replies);
});

test("runs the metric sync in CI and never converts an unavailable label to zero", async () => {
  const [workflow, collector] = await Promise.all([
    readFile(resolve(ROOT, "..", ".github", "workflows", "social-youtube-comment-metrics.yml"), "utf8"),
    readFile(resolve(ROOT, "scripts", "collect_youtube_comment_metrics.mjs"), "utf8"),
  ]);
  assert.match(workflow, /node scripts\/sync_youtube_comment_metrics\.mjs/);
  assert.match(workflow, /YOUTUBE_API_KEY: \$\{\{ secrets\.YOUTUBE_API_KEY \}\}/);
  assert.match(
    workflow,
    /git add data\/youtube-comment-metrics\.json data\/public-history\.json data\/public-history-summary\.json data\/owner-comment-refresh-status\.json/,
  );
  assert.match(collector, /YOUTUBE_COMMENT_REFRESH_AFTER_MS/);
  assert.doesNotMatch(collector, /parseCount\([^\n]+\) \?\? 0/);
  assert.match(collector, /--mute-audio/);
  assert.match(collector, /resourceType\(\) === "media" \? route\.abort\(\)/);
});

test("collects top-level comments and replies in API batches while preserving unresolved fallbacks", async () => {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith("/commentThreads")) {
      return jsonResponse({
        items: [{
          id: "thread-topA",
          snippet: {
            totalReplyCount: 3,
            topLevelComment: { id: "topA", snippet: { likeCount: 12 } },
          },
        }],
      });
    }
    return jsonResponse({ items: [{ id: "parent.reply", snippet: { likeCount: 7 } }] });
  };
  const entries = [
    { id: "topA", url: "https://example.test/topA" },
    { id: "topMissing", url: "https://example.test/topMissing" },
    { id: "parent.reply", url: "https://example.test/reply" },
  ];

  const outcome = await collectYoutubeApiMetrics(entries, { apiKey: "test-key", fetchImpl });
  assert.deepEqual(outcome.resolved.get("topA"), { likes: 12, replies: 3 });
  assert.deepEqual(outcome.resolved.get("parent.reply"), { likes: 7, replies: 0 });
  assert.deepEqual(outcome.unresolved.map((entry) => entry.id), ["topMissing"]);
  assert.deepEqual(outcome.errors, []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("id"), "topA,topMissing");
  assert.equal(requests[1].searchParams.get("id"), "parent.reply");
});

test("keeps every API error in the DOM fallback and skips API calls without a key", async () => {
  const entries = [{ id: "topA" }, { id: "parent.reply" }];
  let calls = 0;
  const failingFetch = async () => {
    calls += 1;
    throw new Error("request failed with secret test-key");
  };

  const failed = await collectYoutubeApiMetrics(entries, { apiKey: "test-key", fetchImpl: failingFetch });
  assert.equal(failed.resolved.size, 0);
  assert.deepEqual(failed.unresolved.map((entry) => entry.id), ["topA", "parent.reply"]);
  assert.equal(failed.errors.length, 2);
  assert.ok(failed.errors.every((error) => !error.error.includes("test-key")));

  const noKey = await collectYoutubeApiMetrics(entries, { fetchImpl: failingFetch });
  assert.equal(noKey.resolved.size, 0);
  assert.deepEqual(noKey.unresolved, entries);
  assert.equal(calls, 2, "the two keyed endpoint batches are the only attempted requests");
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
