import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeWorkspaceWithPublicHistory } from "../lib/public-history.ts";
import { matchesSocialFormatFilter } from "../lib/social-formats.ts";

async function snapshot() {
  return JSON.parse(
    await readFile(new URL("../data/public-history.json", import.meta.url), "utf8"),
  );
}

async function summary() {
  return JSON.parse(
    await readFile(
      new URL("../data/public-history-summary.json", import.meta.url),
      "utf8",
    ),
  );
}

test("the lightweight preview summary matches the complete history", async () => {
  const history = await snapshot();
  const manifest = await summary();
  const platforms = ["youtube", "instagram", "tiktok", "x"];

  assert.equal(manifest.generatedAt, history.generatedAt);
  assert.equal(manifest.totalPostCount, history.posts.length);
  assert.equal(
    platforms.reduce((total, platform) => total + manifest.platformCounts[platform], 0),
    history.posts.length,
  );

  for (const platform of platforms) {
    const posts = history.posts.filter((post) => post.platform === platform);
    assert.equal(manifest.platformCounts[platform], posts.length);
    for (const [filter, count] of Object.entries(manifest.formatCounts[platform])) {
      assert.equal(
        posts.filter((post) => matchesSocialFormatFilter(post, filter)).length,
        count,
        `${platform}:${filter}`,
      );
    }
  }
});

test("the preview bootstrap exposes exact counters before post cards load", async () => {
  const manifest = await summary();
  const workspace = mergeWorkspaceWithPublicHistory(
    null,
    {
      generatedAt: manifest.generatedAt,
      coverage: manifest.coverage,
      posts: [],
    },
    "public-snapshot",
    {
      editorialAnalysis: "none",
      accountCounts: manifest.platformCounts,
    },
  );

  assert.equal(workspace.posts.length, 0);
  assert.deepEqual(
    Object.fromEntries(
      workspace.accounts.map((account) => [account.platform, account.post_count]),
    ),
    manifest.platformCounts,
  );
  assert.equal(
    workspace.accounts.reduce((total, account) => total + account.post_count, 0),
    manifest.totalPostCount,
  );
});

test("the versioned YouTube history contains Shorts, Community posts and authorized creator comments", async () => {
  const history = await snapshot();
  const youtube = history.posts.filter((post) => post.platform === "youtube");
  const formats = new Set(youtube.map((post) => post.format));

  assert.ok(youtube.length > 0);
  assert.deepEqual(
    [...formats].sort(),
    ["comment", "community_image", "community_poll", "community_text", "short"],
  );
  assert.ok(youtube.filter((post) => post.format !== "comment").every((post) => !post.url.includes("/watch")));
  assert.ok(youtube.filter((post) => post.format === "comment").every((post) => post.url.includes("lc=")));
  assert.ok(youtube.every((post) => post.format !== "video"));
  assert.ok(youtube.every((post) => post.format !== "livestream"));
});

test("the workspace boundary also removes stale long videos and livestreams", async () => {
  const history = await snapshot();
  const stale = {
    platform: "youtube",
    external_post_id: "long-stale",
    url: "https://www.youtube.com/watch?v=long-stale",
    title: "A stale long video",
    text: "",
    format: "video",
  };
  const liveShort = {
    platform: "youtube",
    external_post_id: "short-live",
    url: "https://www.youtube.com/shorts/short-live",
    title: "A current Short",
    text: "",
    format: "short",
  };

  const workspace = mergeWorkspaceWithPublicHistory(
    { generatedAt: history.generatedAt, posts: [stale, liveShort] },
    history,
  );

  assert.equal(
    workspace.posts.some((post) => post.external_post_id === "long-stale"),
    false,
  );
  assert.equal(
    workspace.posts.some((post) => post.external_post_id === "short-live"),
    true,
  );
  assert.match(workspace.notice, /vidéos longues et lives sont exclus/i);
});

test("poll vote totals are exposed as a first-class UI metric", async () => {
  const history = await snapshot();
  const workspace = mergeWorkspaceWithPublicHistory(null, history);
  const polls = workspace.posts.filter(
    (post) => post.platform === "youtube" && post.format === "community_poll",
  );

  assert.ok(polls.length > 0);
  assert.ok(polls.some((post) => Number.isFinite(post.poll_votes)));
});

test("every public post carries a content-based editorial why", async () => {
  const history = await snapshot();
  const workspace = mergeWorkspaceWithPublicHistory(null, history);

  assert.ok(workspace.posts.length > 0);
  assert.ok(
    workspace.posts.every(
      (post) =>
        post.editorial_analysis?.version === "editorial-v1" &&
        post.editorial_analysis.scope === "copy-and-format",
    ),
  );

  const microProgress = workspace.posts.find(
    (post) => post.external_post_id === "Ugkxa0ul261Q-iU9NnzjDxvmyTaCRfvHdPgi",
  );
  assert.equal(microProgress?.editorial_analysis.primarySignal, "micro_progress");
  assert.doesNotMatch(
    [
      microProgress?.editorial_analysis.headline,
      microProgress?.editorial_analysis.mechanism,
      microProgress?.editorial_analysis.comparison,
      microProgress?.editorial_analysis.transferableLesson,
    ].join(" "),
    /\/100|percentile|score lifetime|likes?|vues?/i,
  );
});

test("the YouTube Community filter contains image posts only", async () => {
  const history = await snapshot();
  const youtube = history.posts.filter((post) => post.platform === "youtube");
  const communityImages = youtube.filter((post) =>
    matchesSocialFormatFilter(post, "community"),
  );

  assert.equal(
    communityImages.length,
    youtube.filter((post) => post.format === "community_image").length,
  );
  assert.ok(communityImages.length > 1_000);
  assert.ok(communityImages.every((post) => post.format === "community_image"));
  assert.ok(
    youtube
      .filter((post) => post.format === "community_text")
      .every((post) => !matchesSocialFormatFilter(post, "community")),
  );
  assert.ok(
    youtube
      .filter((post) => post.format === "community_poll")
      .every((post) => !matchesSocialFormatFilter(post, "community")),
  );
});

test("the public collector accumulates rolling Community windows", async () => {
  const collector = await readFile(
    new URL("../scripts/collect_public_history.py", import.meta.url),
    "utf8",
  );

  assert.match(collector, /load_existing_posts/);
  assert.match(collector, /existing_keys - observed_keys/);
  assert.match(collector, /Snapshot cumulatif append-only/);
  assert.match(collector, /max\(current_poll_votes, incoming_poll_votes\)/);
});

test("preserved history keeps per-post observation timestamps", async () => {
  const history = await snapshot();
  const post = history.posts[0];
  const firstObservedAt = "2026-07-01T10:00:00Z";
  const lastObservedAt = "2026-07-02T10:00:00Z";
  const workspace = mergeWorkspaceWithPublicHistory(null, {
    ...history,
    generatedAt: "2026-08-04T10:00:00Z",
    posts: [
      {
        ...post,
        raw: {
          ...post.raw,
          firstObservedAt,
          lastObservedAt,
          metricHistory: [],
        },
      },
    ],
  });
  const mapped = workspace.posts.find(
    (item) => item.external_post_id === post.externalId,
  );

  assert.ok(mapped);
  assert.equal(mapped.first_seen_at, firstObservedAt);
  assert.equal(mapped.last_seen_at, lastObservedAt);
  assert.equal(mapped.last_metric_at, "2026-08-04T10:00:00Z");
});

test("the workspace exposes factual metric observations without inventing launch data", async () => {
  const history = await snapshot();
  const post = history.posts.find((item) => item.platform === "tiktok");
  assert.ok(post);
  const firstCapturedAt = "2026-08-04T09:00:00Z";
  const secondCapturedAt = "2026-08-04T15:00:00Z";
  const thirdCapturedAt = "2026-08-04T21:00:00Z";
  const historicalPost = {
    ...post,
    views: 160,
    likes: 18,
    raw: {
      ...post.raw,
      publishedAtPrecision: "exact",
      metricHistory: [
        {
          capturedAt: firstCapturedAt,
          views: 100,
          likes: 10,
          comments: 1,
          shares: 2,
          saves: 3,
          pollVotes: null,
          source: "public-history-collector",
        },
        {
          capturedAt: secondCapturedAt,
          views: 160,
          likes: 18,
          comments: 2,
          shares: 3,
          saves: 5,
          pollVotes: null,
          source: "public-history-collector",
        },
      ],
    },
  };
  const workspace = mergeWorkspaceWithPublicHistory(
    {
      generatedAt: thirdCapturedAt,
      posts: [
        {
          platform: post.platform,
          external_post_id: post.externalId,
          url: post.url,
          title: post.title,
          text: post.text,
          format: post.format,
          thumbnail_url: post.thumbnailUrl,
          published_at: post.publishedAt,
          views: 220,
          likes: 25,
          metric_history: [
            {
              captured_at: secondCapturedAt,
              views: 160,
              likes: 18,
              source: "live-scanner",
            },
            {
              captured_at: thirdCapturedAt,
              views: 220,
              likes: 25,
              source: "live-scanner",
            },
          ],
        },
      ],
    },
    {
      ...history,
      posts: [historicalPost],
    },
  );
  const mapped = workspace.posts[0];

  assert.deepEqual(
    mapped.metric_history.map((point) => point.captured_at),
    [firstCapturedAt, secondCapturedAt, thirdCapturedAt],
  );
  assert.deepEqual(
    mapped.metric_history.map((point) => point.views),
    [100, 160, 220],
  );
  assert.equal(mapped.published_at_precision, "exact");
  assert.equal("launch_metrics" in mapped, false);
});

test("a legacy snapshot is exposed as one observation at generatedAt", async () => {
  const history = await snapshot();
  const source = history.posts.find((item) => item.platform === "youtube");
  assert.ok(source);
  const legacyRaw = { ...(source.raw ?? {}) };
  delete legacyRaw.metricHistory;
  const workspace = mergeWorkspaceWithPublicHistory(null, {
    ...history,
    posts: [{ ...source, raw: legacyRaw }],
  });
  const post = workspace.posts.find((item) => item.platform === "youtube");

  assert.ok(post);
  assert.equal(post.metric_history.length, 1);
  assert.equal(post.metric_history[0].captured_at, history.generatedAt);
});
