import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPORTER = resolve(ROOT, "scripts", "import_owner_comment_history.mjs");

async function invokeImport(input) {
  const directory = await mkdtemp(resolve(tmpdir(), "owner-comments-"));
  const inputPath = resolve(directory, "private-input.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  await writeFile(historyPath, `${JSON.stringify({ generatedAt: "2026-08-27T00:00:00.000Z", coverage: [], posts: [] }, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify({ generatedAt: "2026-08-27T00:00:00.000Z", totalPostCount: 0, platformCounts: { youtube: 0, instagram: 0, tiktok: 0, x: 0 }, formatCounts: { youtube: {}, instagram: {}, tiktok: {}, x: {} }, coverage: [] }, null, 2)}\n`, "utf8");

  const result = spawnSync(process.execPath, [IMPORTER, `--input=${inputPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLIC_HISTORY_PATH: historyPath,
      PUBLIC_HISTORY_SUMMARY_PATH: summaryPath,
    },
  });
  return { result, historyPath, summaryPath };
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
