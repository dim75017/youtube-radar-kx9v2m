import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts", "sync_youtube_comment_metrics.mjs");

test("publishes every collected YouTube comment metric without losing history", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "youtube-comment-sync-"));
  const metricsPath = resolve(directory, "metrics.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
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

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      YOUTUBE_COMMENT_METRICS_PATH: metricsPath,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
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

  const serialized = await readFile(historyPath, "utf8");
  const repeated = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      YOUTUBE_COMMENT_METRICS_PATH: metricsPath,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
    },
  });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(await readFile(historyPath, "utf8"), serialized);
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
  assert.equal(gta.likes, 130_000);
  assert.equal(gta.comments, 784);
  assert.equal(gta.raw.commentTarget.audienceValue, 13_600_000);
  assert.equal(smoking.likes, 52_000);
  assert.equal(smoking.comments, 277);
});

test("runs the metric sync in CI and never converts an unavailable label to zero", async () => {
  const [workflow, collector] = await Promise.all([
    readFile(resolve(ROOT, "..", ".github", "workflows", "social-youtube-comment-metrics.yml"), "utf8"),
    readFile(resolve(ROOT, "scripts", "collect_youtube_comment_metrics.mjs"), "utf8"),
  ]);
  assert.match(workflow, /node scripts\/sync_youtube_comment_metrics\.mjs/);
  assert.match(
    workflow,
    /git add data\/youtube-comment-metrics\.json data\/public-history\.json data\/public-history-summary\.json/,
  );
  assert.match(collector, /YOUTUBE_COMMENT_REFRESH_AFTER_MS/);
  assert.doesNotMatch(collector, /parseCount\([^\n]+\) \?\? 0/);
  assert.match(collector, /--mute-audio/);
  assert.match(collector, /resourceType\(\) === "media" \? route\.abort\(\)/);
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
