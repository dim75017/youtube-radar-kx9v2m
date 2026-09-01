import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPORTER = resolve(ROOT, "scripts", "import_x_progress_to_public_history.mjs");
const PROVIDER = "x-api-v2-full-archive";
const ENDPOINT = "https://api.x.com/2/tweets/search/all";
const QUERY = "from:lofigirl -is:retweet";

const oldPost = {
  platform: "x",
  externalId: "100",
  url: "https://x.com/lofigirl/status/100",
  title: "Already stored",
  text: "Already stored",
  format: "text",
  thumbnailUrl: null,
  publishedAt: "2026-08-01T00:00:00.000Z",
  views: 20,
  likes: 10,
  comments: 2,
  shares: 1,
  saves: 3,
  raw: {
    collector: PROVIDER,
    firstObservedAt: "2026-08-01T01:00:00.000Z",
    lastObservedAt: "2026-08-01T01:00:00.000Z",
    publicMetrics: {
      impression_count: 20,
      like_count: 10,
      reply_count: 2,
      retweet_count: 1,
      quote_count: 0,
      bookmark_count: 3,
    },
    metricHistory: [{
      capturedAt: "2026-08-01T01:00:00.000Z",
      views: 20,
      likes: 10,
      comments: 2,
      shares: 1,
      saves: 3,
      pollVotes: null,
      source: PROVIDER,
    }],
  },
};

function apiRow(id, observedAt, metrics) {
  return {
    id,
    externalId: id,
    platform: "x",
    url: `https://x.com/lofigirl/status/${id}`,
    text: `Post ${id}`,
    title: `Post ${id}`,
    time: "2026-08-05T00:00:00.000Z",
    publishedAt: "2026-08-05T00:00:00.000Z",
    format: "text",
    image: null,
    thumbnailUrl: null,
    media: [],
    ...metrics,
    raw: {
      collector: PROVIDER,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      publicMetrics: {
        impression_count: metrics.views,
        like_count: metrics.likes,
        reply_count: metrics.comments,
        retweet_count: metrics.shares,
        quote_count: 0,
        bookmark_count: metrics.saves,
      },
    },
  };
}

function snapshot() {
  return {
    generatedAt: "2026-08-01T01:00:00.000Z",
    coverage: [{
      platform: "x",
      accountUrl: "https://x.com/lofigirl",
      scope: "test",
      status: "complete-api-full-archive",
      itemCount: 1,
      oldestPublishedAt: oldPost.publishedAt,
      newestPublishedAt: oldPost.publishedAt,
      limitations: [],
    }],
    posts: [structuredClone(oldPost)],
  };
}

function incrementalProgress(posts, observedIds, completedAt) {
  return {
    posts,
    xApiIncremental: {
      provider: PROVIDER,
      endpoint: ENDPOINT,
      mode: "incremental",
      query: QUERY,
      startTime: null,
      sinceId: "100",
      startedAt: completedAt,
      lastPageAt: completedAt,
      completedAt,
      nextToken: null,
      pagesThisRun: 1,
      fetchedThisRun: observedIds.length,
      pagesSinceBaseline: 1,
      fetchedSinceBaseline: observedIds.length,
      observedIds,
      resultCount: posts.length,
    },
  };
}

async function runImporter(history, progress) {
  const directory = await mkdtemp(resolve(tmpdir(), "x-incremental-import-"));
  const historyPath = resolve(directory, "history.json");
  const progressPath = resolve(directory, "progress.json");
  const summaryPath = resolve(directory, "summary.json");
  const xPosts = history.posts.filter((post) => post.platform === "x");
  const publicSummary = {
    generatedAt: history.generatedAt,
    totalPostCount: history.posts.length,
    platformCounts: { youtube: 0, instagram: 0, tiktok: 0, x: xPosts.length },
    formatCounts: {
      youtube: { short: 0, community: 0, poll: 0, text: 0, comment: 0 },
      instagram: { reel: 0, static: 0, comment: 0 },
      tiktok: { video: 0, comment: 0 },
      x: {
        static: xPosts.filter((post) => post.format === "static").length,
        video: xPosts.filter((post) => post.format === "video").length,
        text: xPosts.filter((post) => post.format === "text").length,
      },
    },
    coverage: history.coverage,
  };
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(publicSummary, null, 2)}\n`, "utf8");
  const before = await readFile(historyPath, "utf8");
  const result = spawnSync(process.execPath, [IMPORTER], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
      X_PROGRESS_PATH: progressPath,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    before,
    after: await readFile(historyPath, "utf8"),
    summary: JSON.parse(result.stdout),
  };
}

test("incremental import changes only IDs returned by the API", async () => {
  const staleBaseline = apiRow("100", "2026-07-01T00:00:00.000Z", {
    views: 1,
    likes: 1,
    comments: 0,
    shares: 0,
    saves: 0,
  });
  const returned = apiRow("200", "2026-08-06T05:00:00.000Z", {
    views: 5,
    likes: 4,
    comments: 3,
    shares: 2,
    saves: 1,
  });
  const result = await runImporter(
    snapshot(),
    incrementalProgress([staleBaseline, returned], ["200"], "2026-08-06T05:00:00.000Z"),
  );
  const next = JSON.parse(result.after);
  assert.deepEqual(next.posts.find((post) => post.externalId === "100"), oldPost);
  const inserted = next.posts.find((post) => post.externalId === "200");
  assert.equal(inserted.raw.lastObservedAt, "2026-08-06T05:00:00.000Z");
  assert.equal(inserted.raw.metricHistory.length, 1);
  assert.equal(result.summary.inserted, 1);
  assert.equal(result.summary.updated, 0);
});

test("zero returned IDs leaves public history byte-for-byte unchanged", async () => {
  const staleBaseline = apiRow("100", "2026-07-01T00:00:00.000Z", {
    views: 1,
    likes: 1,
    comments: 0,
    shares: 0,
    saves: 0,
  });
  const result = await runImporter(
    snapshot(),
    incrementalProgress([staleBaseline], [], "2026-08-06T06:00:00.000Z"),
  );
  assert.equal(result.after, result.before);
  assert.equal(result.summary.changed, false);
  assert.equal(result.summary.willWrite, false);
});

test("the X incremental collector is scheduled daily and fails closed without its token", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/social-update-x-history.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron:\s*["'][^"']+["']/);
  assert.match(workflow, /Missing X_BEARER_TOKEN/);
  assert.match(workflow, /group:\s*social-public-history-write/);
});
