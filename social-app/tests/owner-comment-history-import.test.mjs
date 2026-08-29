import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPORTER = resolve(ROOT, "scripts", "import_owner_comment_history.mjs");

async function invokeImport(
  input,
  { skipMediaCache = true, seededInstagramShortcode = null } = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), "owner-comments-"));
  const inputPath = resolve(directory, "private-input.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
  const instagramMediaDirectory = resolve(directory, "instagram-media");
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  await writeFile(historyPath, `${JSON.stringify({ generatedAt: "2026-08-27T00:00:00.000Z", coverage: [], posts: [] }, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify({ generatedAt: "2026-08-27T00:00:00.000Z", totalPostCount: 0, platformCounts: { youtube: 0, instagram: 0, tiktok: 0, x: 0 }, formatCounts: { youtube: {}, instagram: {}, tiktok: {}, x: {} }, coverage: [] }, null, 2)}\n`, "utf8");
  if (seededInstagramShortcode) {
    await mkdir(instagramMediaDirectory, { recursive: true });
    await writeFile(
      resolve(instagramMediaDirectory, `${seededInstagramShortcode}.jpg`),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_100)]),
    );
  }

  const arguments_ = [IMPORTER, `--input=${inputPath}`];
  if (skipMediaCache) arguments_.push("--skip-media-cache");
  const result = spawnSync(process.execPath, arguments_, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
      OWNER_COMMENT_INSTAGRAM_MEDIA_DIR: instagramMediaDirectory,
    },
  });
  return { result, historyPath, summaryPath, instagramMediaDirectory };
}

async function runImport(input) {
  const { result, historyPath, summaryPath } = await invokeImport(input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    history: JSON.parse(await readFile(historyPath, "utf8")),
    summary: JSON.parse(await readFile(summaryPath, "utf8")),
    result: JSON.parse(result.stdout),
  };
}

test("imports a closed Instagram comment record and deduplicates native IDs", async () => {
  const base = {
    id: "ig-comment-1",
    url: "https://www.instagram.com/p/ABC123/?comment_id=1",
    text: "cozy level unlocked",
    publishedAt: "2026-08-28T07:00:00.000Z",
    target: {
      contentId: "ABC123",
      url: "https://www.instagram.com/p/ABC123/",
      title: "Morning desk setup",
      thumbnailUrl: "https://scontent.cdninstagram.com/example.jpg",
      authorHandle: "creator",
      authorName: "Creator",
      authorProfileUrl: "https://www.instagram.com/creator/",
      audienceValue: 12300,
      audienceLabel: "12,3 k abonnés",
      audiencePrecision: "platform-rounded",
      audienceObservedAt: "2026-08-28T07:15:00.000Z",
    },
    metrics: { likes: 3, replies: 1 },
    cookie: "must-never-be-published",
  };
  const output = await runImport({
    platform: "instagram",
    capturedAt: "2026-08-28T07:20:00.000Z",
    comments: [base, { ...base, text: "latest observed text" }],
  });

  assert.equal(output.result.inputCount, 2);
  assert.equal(output.result.uniqueCount, 1);
  assert.equal(output.history.posts.length, 1);
  const [post] = output.history.posts;
  assert.equal(post.externalId, "comment:ig-comment-1");
  assert.equal(post.format, "comment");
  assert.equal(post.text, "latest observed text");
  assert.equal(
    post.thumbnailUrl,
    "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
  );
  assert.equal(post.raw.commentTarget.thumbnailUrl, post.thumbnailUrl);
  assert.equal(post.raw.commentTarget.audienceValue, 12300);
  assert.equal(post.raw.commentTarget.audiencePrecision, "platform-rounded");
  assert.equal(JSON.stringify(post).includes("must-never-be-published"), false);
  assert.equal(output.summary.formatCounts.instagram.comment, 1);
});

test("preserves a signed thumbnail from an approved TikTok CDN", async () => {
  const thumbnailUrl = "https://p16-sign.tiktokcdn-us.com/expiring.jpg?x-expires=1";
  const output = await runImport({
    platform: "tiktok",
    capturedAt: "2026-08-28T08:00:00.000Z",
    comments: [{
      id: "tt-comment-1",
      url: "https://www.tiktok.com/@creator/video/123?comment_id=456",
      text: "the cat understood the assignment",
      publishedAt: "2026-08-28T07:50:00.000Z",
      target: {
        contentId: "123",
        url: "https://www.tiktok.com/@creator/video/123",
        title: "Cat study break",
        thumbnailUrl,
        authorHandle: "creator",
        authorProfileUrl: "https://www.tiktok.com/@creator",
        audienceValue: 98000,
        audienceLabel: "98 k abonnés",
        audiencePrecision: "platform-rounded",
        audienceObservedAt: "2026-08-28T07:58:00.000Z",
      },
      metrics: { likes: null, replies: null },
    }],
  });

  const [post] = output.history.posts;
  assert.equal(post.thumbnailUrl, thumbnailUrl);
  assert.equal(post.raw.commentTarget.thumbnailUrl, thumbnailUrl);
  assert.equal(post.raw.commentTarget.url, "https://www.tiktok.com/@creator/video/123");
  assert.equal(post.raw.commentTarget.audienceLabel, "98 k abonnés");
});

test("reuses a validated Instagram cache before publishing its same-origin URL", async () => {
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T08:00:00.000Z",
      comments: [{
        id: "ig-cached-comment",
        url: "https://www.instagram.com/p/ABC123/?comment_id=456",
        text: "cached and cozy",
        publishedAt: "2026-08-28T07:50:00.000Z",
        target: {
          contentId: "ABC123",
          url: "https://www.instagram.com/p/ABC123/",
          title: "Study desk",
          thumbnailUrl: "https://scontent.cdninstagram.com/temporary.jpg",
          authorHandle: "creator",
          authorProfileUrl: "https://www.instagram.com/creator/",
          audienceValue: 12_300,
          audienceLabel: "12,3 k abonnés",
          audiencePrecision: "platform-rounded",
          audienceObservedAt: "2026-08-28T07:58:00.000Z",
        },
        metrics: { likes: 2, replies: 1 },
      }],
    },
    { skipMediaCache: false, seededInstagramShortcode: "ABC123" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mediaCached, 1);
  assert.equal(report.mediaDownloaded, 0);
  const history = JSON.parse(await readFile(historyPath, "utf8"));
  assert.equal(
    history.posts[0].thumbnailUrl,
    "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
  );
});

test("rejects a TikTok thumbnail hosted outside approved TikTok CDNs", async () => {
  const { result } = await invokeImport({
    platform: "tiktok",
    capturedAt: "2026-08-28T08:00:00.000Z",
    comments: [{
      id: "tt-comment-unsafe-thumbnail",
      url: "https://www.tiktok.com/@creator/video/123?comment_id=789",
      text: "still cozy",
      publishedAt: null,
      target: {
        contentId: "123",
        url: "https://www.tiktok.com/@creator/video/123",
        title: "Cat study break",
        thumbnailUrl: "https://tiktokcdn-us.com.attacker.example/unsafe.jpg",
        authorHandle: "creator",
        authorProfileUrl: "https://www.tiktok.com/@creator",
        audienceValue: 98000,
        audienceLabel: "98 k abonnés",
        audiencePrecision: "platform-rounded",
        audienceObservedAt: "2026-08-28T07:58:00.000Z",
      },
      metrics: { likes: null, replies: null },
    }],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CDN tiktok autorisé/);
});

test("does not label a partial owner-comment inventory as successful", async () => {
  const status = JSON.parse(
    await readFile(resolve(ROOT, "data", "owner-comment-refresh-status.json"), "utf8"),
  );
  for (const platform of ["youtube", "instagram", "tiktok"]) {
    const inventory = status.platforms[platform];
    assert.ok(inventory.inventoryStatus, `${platform} inventory status is missing`);
    if (inventory.endReached !== true || inventory.inventoryStatus !== "complete") {
      assert.notEqual(inventory.status, "success", `${platform} is not proven exhaustive`);
    }
  }
  assert.equal(status.platforms.instagram.endReached, false);
  assert.equal(status.platforms.tiktok.nativeIdCount, 0);
});

test("an incomplete recent target never erases older verified metadata", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "owner-comments-merge-"));
  const inputPath = resolve(directory, "private-input.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
  const existing = {
    platform: "tiktok",
    externalId: "comment:stable-comment",
    url: "https://www.tiktok.com/@creator/video/123",
    title: "Original title",
    text: "same comment",
    format: "comment",
    thumbnailUrl: "https://p16-sign.tiktokcdn-us.com/stable.jpg",
    publishedAt: "2026-08-27T08:00:00.000Z",
    likes: 9,
    comments: 2,
    raw: {
      firstObservedAt: "2026-08-27T09:00:00.000Z",
      lastObservedAt: "2026-08-27T09:00:00.000Z",
      metricHistory: [],
      commentTarget: {
        contentId: "123",
        url: "https://www.tiktok.com/@creator/video/123",
        title: null,
        thumbnailUrl: "https://p16-sign.tiktokcdn-us.com/stable.jpg",
        authorHandle: "creator",
        audienceValue: 98_000,
        audienceLabel: "98 k abonnés",
        audiencePrecision: "platform-rounded",
      },
    },
  };
  await writeFile(inputPath, JSON.stringify({
    platform: "tiktok",
    capturedAt: "2026-08-29T08:00:00.000Z",
    comments: [{
      id: "stable-comment",
      url: "https://www.tiktok.com/@creator/video/123",
      text: "same comment",
      publishedAt: null,
      target: {
        contentId: "123",
        url: "https://www.tiktok.com/@creator/video/123",
        title: "Original title",
        thumbnailUrl: null,
        authorHandle: "creator",
        authorName: null,
        authorProfileUrl: null,
        audienceValue: null,
        audienceLabel: null,
        audiencePrecision: "unknown",
        audienceObservedAt: null,
      },
      metrics: { likes: null, replies: null },
    }],
  }));
  await writeFile(historyPath, JSON.stringify({ generatedAt: "2026-08-27T09:00:00.000Z", coverage: [], posts: [existing] }));
  await writeFile(summaryPath, JSON.stringify({
    generatedAt: "2026-08-27T09:00:00.000Z",
    totalPostCount: 1,
    platformCounts: { youtube: 0, instagram: 0, tiktok: 1, x: 0 },
    formatCounts: { youtube: {}, instagram: {}, tiktok: { comment: 1 }, x: {} },
    coverage: [],
  }));

  const result = spawnSync(process.execPath, [IMPORTER, `--input=${inputPath}`, "--skip-media-cache"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_HISTORY_PATH: historyPath, PUBLIC_HISTORY_SUMMARY_PATH: summaryPath },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(await readFile(historyPath, "utf8"));
  const [merged] = output.posts;
  assert.equal(merged.thumbnailUrl, existing.thumbnailUrl);
  assert.equal(merged.title, existing.title);
  assert.equal(merged.publishedAt, existing.publishedAt);
  assert.equal(merged.likes, 9);
  assert.equal(merged.comments, 2);
  assert.equal(merged.raw.commentTarget.audienceValue, 98_000);
  assert.equal(merged.raw.commentTarget.audienceLabel, "98 k abonnés");
  assert.equal(merged.raw.commentTarget.audiencePrecision, "platform-rounded");
});
