import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPORTER = resolve(ROOT, "scripts", "import_owner_comment_history.mjs");

async function invokeImport(
  input,
  {
    skipMediaCache = true,
    seededInstagramShortcode = null,
    dryRun = false,
    history = { generatedAt: "2026-08-27T00:00:00.000Z", coverage: [], posts: [] },
    summary = { generatedAt: "2026-08-27T00:00:00.000Z", totalPostCount: 0, platformCounts: { youtube: 0, instagram: 0, tiktok: 0, x: 0 }, formatCounts: { youtube: {}, instagram: {}, tiktok: {}, x: {} }, coverage: [] },
    writeReport = false,
  } = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), "owner-comments-"));
  const inputPath = resolve(directory, "private-input.json");
  const historyPath = resolve(directory, "history.json");
  const summaryPath = resolve(directory, "summary.json");
  const reportPath = resolve(directory, "report.json");
  const instagramMediaDirectory = resolve(directory, "instagram-media");
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (seededInstagramShortcode) {
    await mkdir(instagramMediaDirectory, { recursive: true });
    await writeFile(
      resolve(instagramMediaDirectory, `${seededInstagramShortcode}.jpg`),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_100)]),
    );
  }

  const arguments_ = [IMPORTER, `--input=${inputPath}`];
  if (skipMediaCache) arguments_.push("--skip-media-cache");
  if (dryRun) arguments_.push("--dry-run");
  if (writeReport) arguments_.push(`--report=${reportPath}`);
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
  return { result, historyPath, summaryPath, reportPath, instagramMediaDirectory, directory };
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

test("imports a closed Instagram comment record and coalesces identical native IDs", async () => {
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
    comments: [base, { ...base }],
  });

  assert.equal(output.result.inputCount, 2);
  assert.equal(output.result.uniqueCount, 1);
  assert.equal(output.history.posts.length, 1);
  const [post] = output.history.posts;
  assert.equal(post.externalId, "comment:ig-comment-1");
  assert.equal(post.format, "comment");
  assert.equal(post.text, "cozy level unlocked");
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

test("caches Instagram thumbnails from username-prefixed reel permalinks", async () => {
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-29T11:04:55.207Z",
      comments: [{
        id: "ig-prefixed-reel",
        url: "https://www.instagram.com/creator/reel/ABC123/",
        text: "cozy grid match",
        publishedAt: null,
        target: {
          contentId: "ABC123",
          url: "https://www.instagram.com/creator/reel/ABC123/",
          title: "Study break",
          thumbnailUrl: "https://scontent.cdninstagram.com/temporary.jpg",
          authorHandle: "creator",
          authorProfileUrl: "https://www.instagram.com/creator/",
          audienceValue: 12_300,
          audienceLabel: "12,300 followers",
          audiencePrecision: "exact",
          audienceObservedAt: "2026-08-29T11:00:00.000Z",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    { skipMediaCache: false, seededInstagramShortcode: "ABC123" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
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

test("rejects contradictory duplicate native IDs instead of silently keeping the last row", async () => {
  const shared = {
    id: "18123456789012345",
    url: "https://www.instagram.com/p/ABC123/c/18123456789012345/",
    publishedAt: "2026-08-28T07:00:00.000Z",
    target: {
      contentId: "ABC123",
      url: "https://www.instagram.com/p/ABC123/",
      title: "Desk",
      thumbnailUrl: null,
      audiencePrecision: "unknown",
    },
    metrics: { likes: 3, replies: 1 },
  };
  const { result, historyPath } = await invokeImport({
    platform: "instagram",
    capturedAt: "2026-08-28T08:00:00.000Z",
    comments: [
      { ...shared, text: "first text" },
      { ...shared, text: "different text" },
    ],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ID dupliqué contradictoire 18123456789012345.*text/);
  assert.equal(JSON.parse(await readFile(historyPath, "utf8")).posts.length, 0);
});

test("reconciles a safe native Instagram ID with one synthetic legacy row", async () => {
  const legacy = {
    platform: "instagram",
    externalId: "comment:legacy-browser-42",
    url: "https://www.instagram.com/creator/reel/ABC123/",
    title: "Legacy target title",
    text: "cafe\u0301   cozy",
    format: "comment",
    thumbnailUrl: "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
    publishedAt: "2026-08-27T20:00:00.000Z",
    likes: 9,
    comments: 2,
    raw: {
      collector: "legacy-browser-scroll",
      commentIdKind: "synthetic",
      firstObservedAt: "2026-08-27T21:00:00.000Z",
      lastObservedAt: "2026-08-27T21:00:00.000Z",
      commentTarget: {
        contentId: "legacy-media-id",
        url: "https://www.instagram.com/creator/reel/ABC123/",
        title: "Legacy target title",
        thumbnailUrl: "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
        audienceValue: 12_345,
        audienceLabel: "12 345 abonnés",
        audiencePrecision: "exact",
      },
      metricHistory: [{
        capturedAt: "2026-08-27T21:00:00.000Z",
        views: null,
        likes: 9,
        comments: 2,
        shares: null,
        saves: null,
        pollVotes: null,
        source: "legacy-browser-scroll",
      }],
    },
  };
  const output = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      inventory: { inventoryStatus: "complete", endReached: true, recordCount: 1 },
      comments: [{
        id: "18123456789012345",
        text: "café cozy",
        publishedAt: "2026-08-28T07:00:00.000Z",
        target: {
          contentId: "ABC123",
          url: "https://www.instagram.com/p/ABC123/",
          title: null,
          thumbnailUrl: null,
          audienceValue: null,
          audienceLabel: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    { history: { generatedAt: "2026-08-27T21:00:00.000Z", coverage: [], posts: [legacy] } },
  );

  assert.equal(output.result.status, 0, output.result.stderr || output.result.stdout);
  const report = JSON.parse(output.result.stdout);
  const history = JSON.parse(await readFile(output.historyPath, "utf8"));
  assert.equal(report.reconciled, 1);
  assert.equal(report.inserted, 0);
  assert.equal(report.inventory.inventoryStatus, "complete");
  assert.equal(history.posts.length, 1);
  const [post] = history.posts;
  assert.equal(post.externalId, "comment:18123456789012345");
  assert.equal(post.likes, 9);
  assert.equal(post.comments, 2);
  assert.equal(post.raw.commentTarget.audienceValue, 12_345);
  assert.equal(post.raw.commentTarget.audiencePrecision, "exact");
  assert.deepEqual(post.raw.reconciledFromExternalIds, ["comment:legacy-browser-42"]);
  assert.equal(post.raw.metricHistory.length, 1);
});

test("never reconciles legacy rows by comment text alone", async () => {
  const legacy = {
    platform: "instagram",
    externalId: "comment:legacy-wrong-target",
    url: "https://www.instagram.com/p/OTHER1/",
    title: "Other post",
    text: "same cozy reply",
    format: "comment",
    thumbnailUrl: null,
    publishedAt: "2026-08-28T07:00:00.000Z",
    likes: 4,
    comments: 1,
    raw: {
      commentIdKind: "synthetic",
      commentTarget: { url: "https://www.instagram.com/p/OTHER1/" },
      metricHistory: [],
    },
  };
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      comments: [{
        id: "18123456789012345",
        text: "same cozy reply",
        publishedAt: "2026-08-28T07:30:00.000Z",
        target: {
          contentId: "ABC123",
          url: "https://www.instagram.com/p/ABC123/",
          title: "Right post",
          thumbnailUrl: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    { history: { generatedAt: "2026-08-28T08:00:00.000Z", coverage: [], posts: [legacy] } },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.reconciled, 0);
  assert.equal(report.inserted, 1);
  assert.equal(JSON.parse(await readFile(historyPath, "utf8")).posts.length, 2);
});

test("reports ambiguous legacy reconciliation and leaves every candidate untouched", async () => {
  const legacyPosts = ["legacy-a", "legacy-b"].map((id, index) => ({
    platform: "instagram",
    externalId: `comment:${id}`,
    url: "https://www.instagram.com/p/ABC123/",
    title: `Legacy ${index + 1}`,
    text: "same target and reply",
    format: "comment",
    thumbnailUrl: null,
    publishedAt: `2026-08-28T07:0${index}:00.000Z`,
    likes: index,
    comments: null,
    raw: {
      commentIdKind: "synthetic",
      commentTarget: { url: "https://www.instagram.com/p/ABC123/" },
      metricHistory: [],
    },
  }));
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      comments: [{
        id: "18123456789012345",
        text: "same target and reply",
        publishedAt: "2026-08-28T07:30:00.000Z",
        target: {
          contentId: "ABC123",
          url: "https://www.instagram.com/p/ABC123/",
          title: "Right post",
          thumbnailUrl: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    {
      dryRun: true,
      history: { generatedAt: "2026-08-28T08:00:00.000Z", coverage: [], posts: legacyPosts },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.inserted, 0);
  assert.equal(report.updated, 0);
  assert.equal(report.reconciled, 0);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual(
    report.details.ambiguous[0].candidateExternalIds,
    ["comment:legacy-a", "comment:legacy-b"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(historyPath, "utf8")).posts,
    legacyPosts,
  );
});

test("quarantines an unavailable target only when no honest public URL exists", async () => {
  const output = await runImport({
    platform: "instagram",
    capturedAt: "2026-08-28T09:00:00.000Z",
    comments: [
      {
        id: "18123456789012345",
        url: "https://www.instagram.com/p/ABC123/c/18123456789012345/",
        text: "thread still addressable",
        publishedAt: "2026-08-28T07:00:00.000Z",
        target: {
          contentId: "ABC123",
          unavailable: true,
          title: null,
          thumbnailUrl: "https://scontent.cdninstagram.com/expired.jpg",
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      },
      {
        id: "18123456789012346",
        text: "deleted without permalink",
        publishedAt: "2026-08-27T07:00:00.000Z",
        target: {
          contentId: "deleted-media",
          status: "deleted",
          title: "Removed post",
          thumbnailUrl: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      },
    ],
  });

  assert.equal(output.result.inserted, 1);
  assert.equal(output.result.skipped, 1);
  assert.equal(output.result.quarantined, 1);
  assert.equal(output.history.posts.length, 1);
  const [post] = output.history.posts;
  assert.equal(post.url, "https://www.instagram.com/p/ABC123/c/18123456789012345/");
  assert.equal(post.raw.commentTarget.url, null);
  assert.equal(post.raw.commentTarget.unavailable, true);
  assert.match(
    post.thumbnailUrl,
    /^https:\/\/dim75017\.github\.io\/youtube-radar-kx9v2m\/social\/media\/instagram\/comment-[a-f0-9]{24}\.jpg$/u,
  );
  assert.equal(output.result.details.skipped[0].id, "18123456789012346");
});

test("publishes an unresolved Instagram activity row without inventing a target link", async () => {
  const id = "18123456789012999";
  const cacheKey = `comment-${createHash("sha256")
    .update(`instagram-owner-comment:${id}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  const activitySourceUrl =
    "https://www.instagram.com/your_activity/interactions/comments";
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      activitySourceUrl,
      comments: [{
        id,
        idKind: "native",
        text: "the desk lamp understood the assignment",
        publishedAt: "2026-08-27T07:00:00.000Z",
        target: {
          contentId: null,
          unavailable: true,
          title: "Publication Instagram",
          thumbnailUrl:
            "https://scontent.cdninstagram.com/signed/private-looking-token.jpg?stp=dst-jpg",
          authorHandle: "study.creator",
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    {
      skipMediaCache: false,
      seededInstagramShortcode: cacheKey,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.inserted, 1);
  assert.equal(report.skipped, 0);
  assert.equal(report.quarantined, 0);
  assert.equal(report.mediaCached, 1);
  assert.equal(report.mediaFailed, 0);

  const [post] = JSON.parse(await readFile(historyPath, "utf8")).posts;
  assert.equal(
    post.url,
    "https://www.instagram.com/your_activity/interactions/comments/",
  );
  assert.equal(post.raw.commentTarget.url, null);
  assert.equal(post.raw.commentTarget.unavailable, true);
  assert.equal(
    post.raw.commentTarget.authorProfileUrl,
    "https://www.instagram.com/study.creator/",
  );
  assert.equal(
    post.thumbnailUrl,
    `https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/${cacheKey}.jpg`,
  );
  assert.equal(post.raw.commentTarget.thumbnailUrl, post.thumbnailUrl);
  assert.equal(
    JSON.stringify(post.raw.commentTarget).includes("your_activity"),
    false,
  );
  assert.equal(post.thumbnailUrl.includes("private-looking-token"), false);
});

test("an unavailable activity refresh preserves an existing verified Instagram target", async () => {
  const id = "18123456789012777";
  const unusedIncomingCacheKey = `comment-${createHash("sha256")
    .update(`instagram-owner-comment:${id}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  const targetUrl = "https://www.instagram.com/p/ABC123/";
  const existing = {
    platform: "instagram",
    externalId: `comment:${id}`,
    url: `${targetUrl}?comment_id=${id}`,
    title: "Verified study desk",
    text: "the lamp understood the assignment",
    format: "comment",
    thumbnailUrl:
      "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
    publishedAt: "2026-08-27T07:00:00.000Z",
    views: null,
    likes: 12,
    comments: 2,
    shares: null,
    saves: null,
    raw: {
      collector: "authorized-instagram-activity",
      activityType: "published-comment",
      sourceKind: "authorized-instagram-activity",
      commentIdKind: "native",
      nativeCommentId: id,
      firstObservedAt: "2026-08-27T08:00:00.000Z",
      lastObservedAt: "2026-08-27T08:00:00.000Z",
      commentTarget: {
        contentId: "ABC123",
        url: targetUrl,
        title: "Verified study desk",
        thumbnailUrl:
          "https://dim75017.github.io/youtube-radar-kx9v2m/social/media/instagram/ABC123.jpg",
        authorHandle: "study.creator",
        authorName: "Study Creator",
        authorProfileUrl: "https://www.instagram.com/study.creator/",
        audienceValue: 125_000,
        audienceLabel: "125 k abonnés",
        audiencePrecision: "platform-rounded",
        audienceObservedAt: "2026-08-27T08:00:00.000Z",
        source: "authorized-instagram-activity",
        unavailable: false,
      },
      metricHistory: [],
    },
  };
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      activitySourceUrl:
        "https://www.instagram.com/your_activity/interactions/comments/",
      comments: [{
        id,
        text: existing.text,
        publishedAt: existing.publishedAt,
        target: {
          unavailable: true,
          title: "Publication Instagram",
          thumbnailUrl:
            "https://scontent.cdninstagram.com/signed/unavailable-refresh.jpg?stp=dst-jpg",
          authorHandle: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: 13, replies: 2 },
      }],
    },
    {
      history: {
        generatedAt: "2026-08-27T08:00:00.000Z",
        coverage: [],
        posts: [existing],
      },
      summary: {
        generatedAt: "2026-08-27T08:00:00.000Z",
        totalPostCount: 1,
        platformCounts: { youtube: 0, instagram: 1, tiktok: 0, x: 0 },
        formatCounts: { youtube: {}, instagram: { comment: 1 }, tiktok: {}, x: {} },
        coverage: [],
      },
      skipMediaCache: false,
      seededInstagramShortcode: unusedIncomingCacheKey,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mediaDownloaded, 0);
  assert.equal(report.mediaCached, 0);
  assert.equal(report.mediaFailed, 0);
  const [merged] = JSON.parse(await readFile(historyPath, "utf8")).posts;
  assert.equal(merged.url, existing.url);
  assert.equal(merged.title, existing.title);
  assert.equal(merged.thumbnailUrl, existing.thumbnailUrl);
  assert.equal(merged.raw.commentTarget.url, targetUrl);
  assert.equal(merged.raw.commentTarget.unavailable, false);
  assert.equal(merged.raw.commentTarget.authorHandle, "study.creator");
  assert.equal(merged.raw.commentTarget.audienceValue, 125_000);
  assert.equal(merged.likes, 13);
  assert.equal(merged.raw.lastObservedAt, "2026-08-28T09:00:00.000Z");
});

test("rejects an activity fallback that is not the exact Instagram comments page", async () => {
  const { result } = await invokeImport({
    platform: "instagram",
    capturedAt: "2026-08-28T09:00:00.000Z",
    activitySourceUrl: "https://www.instagram.com/lofigirl/",
    comments: [],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /activitySourceUrl.*your_activity\/interactions\/comments/u);
});

test("keeps a completion manifest partial unless the end and record count are proven", async () => {
  const input = {
    platform: "tiktok",
    capturedAt: "2026-08-28T09:00:00.000Z",
    inventory: {
      inventoryStatus: "complete",
      endReached: false,
      recordCount: 99,
    },
    comments: [{
      id: "7654321098765432101",
      url: "https://www.tiktok.com/@creator/video/7654321098765432100?comment_id=7654321098765432101",
      text: "cozy manifest check",
      publishedAt: "2026-08-28T07:00:00.000Z",
      target: {
        contentId: "7654321098765432100",
        url: "https://www.tiktok.com/@creator/video/7654321098765432100",
        title: "Study break",
        thumbnailUrl: null,
        audiencePrecision: "unknown",
      },
      metrics: { likes: null, replies: null },
    }],
  };
  const { result, historyPath } = await invokeImport(input, { dryRun: true });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.inventory.inventoryStatus, "partial");
  assert.equal(report.inventory.coherent, false);
  assert.deepEqual(
    report.inventory.issues,
    ["end-not-reached", "record-count-mismatch", "invalid-complete-claim"],
  );
  assert.equal(report.inserted, 1);
  assert.equal(report.dryRun, true);
  assert.equal(JSON.parse(await readFile(historyPath, "utf8")).posts.length, 0);
});

test("fails closed when a complete inventory would drop a quarantined row", async () => {
  const initialHistory = {
    generatedAt: "2026-08-27T00:00:00.000Z",
    coverage: [],
    posts: [],
  };
  const { result, historyPath } = await invokeImport(
    {
      platform: "instagram",
      capturedAt: "2026-08-28T09:00:00.000Z",
      inventory: {
        inventoryStatus: "complete",
        endReached: true,
        recordCount: 1,
      },
      comments: [{
        id: "18123456789012998",
        text: "this row must not disappear silently",
        publishedAt: "2026-08-27T07:00:00.000Z",
        target: {
          unavailable: true,
          title: "Publication supprimée",
          thumbnailUrl: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    { history: initialHistory },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Inventaire déclaré complet refusé.*1 ligne\(s\).*écartées ou mises en quarantaine/u,
  );
  assert.deepEqual(
    JSON.parse(await readFile(historyPath, "utf8")),
    initialHistory,
  );
});

test("writes history, summary and an optional report atomically", async () => {
  const output = await invokeImport(
    {
      platform: "tiktok",
      capturedAt: "2026-08-28T09:00:00.000Z",
      comments: [{
        id: "7654321098765432101",
        url: "https://www.tiktok.com/@creator/video/7654321098765432100",
        text: "atomic and cozy",
        publishedAt: "2026-08-28T07:00:00.000Z",
        target: {
          contentId: "7654321098765432100",
          url: "https://www.tiktok.com/@creator/video/7654321098765432100",
          title: "Study break",
          thumbnailUrl: null,
          audiencePrecision: "unknown",
        },
        metrics: { likes: null, replies: null },
      }],
    },
    { writeReport: true },
  );

  assert.equal(output.result.status, 0, output.result.stderr || output.result.stdout);
  assert.equal(JSON.parse(await readFile(output.historyPath, "utf8")).posts.length, 1);
  assert.equal(JSON.parse(await readFile(output.summaryPath, "utf8")).totalPostCount, 1);
  assert.deepEqual(
    JSON.parse(await readFile(output.reportPath, "utf8")),
    JSON.parse(output.result.stdout),
  );
  assert.equal((await readdir(output.directory)).some((name) => name.endsWith(".next")), false);
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
