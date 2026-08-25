import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scanPlatform } from "../lib/social-scanner.ts";
import { buildSocialAnalysis, rankPosts } from "../lib/social-score.ts";

const NOW = "2026-08-04T12:00:00.000Z";
const PUBLIC_HISTORY = JSON.parse(
  readFileSync(new URL("../data/public-history.json", import.meta.url), "utf8"),
);

function post(overrides) {
  return {
    platform: "youtube",
    externalId: "post",
    url: "https://example.test/post",
    title: "Post",
    text: "",
    format: "short",
    thumbnailUrl: null,
    publishedAt: "2026-08-02T12:00:00.000Z",
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    raw: {},
    ...overrides,
  };
}

test("renormalizes available metric weights instead of treating missing metrics as zero", () => {
  const ranked = rankPosts(
    [
      post({ externalId: "high", views: 200_000 }),
      post({ externalId: "low", views: 20_000 }),
    ],
    NOW,
  );

  assert.equal(ranked[0].externalId, "high");
  assert.equal(ranked[0].performanceScore, 100);
  assert.deepEqual(ranked[0].metricCoverage, ["views"]);
  assert.equal(ranked[1].performanceScore, 0);
});

test("ranks lifetime impact ahead of recent momentum", () => {
  const candidates = [
    post({
      platform: "tiktok",
      format: "video",
      externalId: "recent",
      publishedAt: "2026-08-01T18:06:26Z",
      views: 862_100,
      likes: 164_200,
      comments: 982,
      shares: 14_400,
      saves: 10_000,
    }),
    post({
      platform: "tiktok",
      format: "video",
      externalId: "lifetime-winner",
      publishedAt: "2025-07-29T18:21:43Z",
      views: 38_000_000,
      likes: 6_200_000,
      comments: 24_400,
      shares: 413_200,
      saves: 499_600,
    }),
  ];

  const now = rankPosts(candidates, NOW);
  const yearsLater = rankPosts(candidates, "2030-08-04T12:00:00.000Z");

  assert.equal(now[0].externalId, "lifetime-winner");
  assert.equal(now[0].performanceScore, 100);
  assert.equal(yearsLater[0].externalId, "lifetime-winner");
  assert.equal(yearsLater[0].performanceScore, now[0].performanceScore);
  assert.match(now[0].scoreExplanation, /lifetime/i);
  assert.doesNotMatch(now[0].scoreExplanation, /par vue|par jour/i);
});

test("keeps the known public-history winners at the top", () => {
  const ranked = rankPosts(PUBLIC_HISTORY.posts, PUBLIC_HISTORY.generatedAt);
  const tiktok = ranked.filter((item) => item.platform === "tiktok");
  const communityImages = ranked.filter(
    (item) => item.platform === "youtube" && item.format === "community_image",
  );
  const communityPolls = ranked.filter(
    (item) => item.platform === "youtube" && item.format === "community_poll",
  );

  assert.equal(tiktok[0].externalId, "7532570759349226774");
  assert.equal(tiktok[0].views, 38_000_000);
  assert.equal(communityImages[0].externalId, "UgkxCjn1cHXCa7sqLFrJPy-QzBrjV2UTM_vT");
  assert.equal(communityImages[0].likes, 80_816);
  assert.equal(communityPolls[0].externalId, "UgkxYNmB718MucZIiu1yCz3tnefOPWB3KjJw");
  assert.equal(communityPolls[0].raw.pollVotes, 6_600_000);
});

test("normalizes inside each platform before building a global order", () => {
  const ranked = rankPosts(
    [
      post({ platform: "youtube", externalId: "yt-high", views: 100_000 }),
      post({ platform: "youtube", externalId: "yt-low", views: 10_000 }),
      post({ platform: "x", externalId: "x-high", format: "text", views: 2_000 }),
      post({ platform: "x", externalId: "x-low", format: "text", views: 200 }),
    ],
    NOW,
  );

  const byId = new Map(ranked.map((item) => [item.externalId, item]));
  assert.equal(byId.get("yt-high").performanceScore, 100);
  assert.equal(byId.get("x-high").performanceScore, 100);
  assert.equal(byId.get("yt-low").performanceScore, 0);
  assert.equal(byId.get("x-low").performanceScore, 0);
  assert.equal(byId.get("yt-high").platformRank, 1);
  assert.equal(byId.get("x-high").platformRank, 1);
});

test("ranks Community polls with their public vote totals", () => {
  const ranked = rankPosts(
    [
      post({
        externalId: "poll-high",
        format: "community_poll",
        likes: 1_000,
        raw: { pollVotes: 40_000 },
      }),
      post({
        externalId: "poll-low",
        format: "community_poll",
        likes: 1_000,
        raw: { pollVotes: 4_000 },
      }),
    ],
    NOW,
  );

  assert.equal(ranked[0].externalId, "poll-high");
  assert.ok(ranked[0].metricCoverage.includes("pollVotes"));
  assert.match(ranked[0].scoreExplanation, /votes du sondage/i);
});

test("keeps posts with no public metric unscored and reports descriptive caveats", () => {
  const posts = [
    post({
      platform: "instagram",
      externalId: "ig-empty",
      format: "post",
      publishedAt: null,
    }),
  ];
  const ranked = rankPosts(posts, NOW);
  const analysis = buildSocialAnalysis(posts, NOW);

  assert.equal(ranked[0].performanceScore, null);
  assert.equal(ranked[0].confidence, "insufficient");
  assert.equal(ranked[0].rank, null);
  assert.equal(analysis.coverage[0].topScore, null);
  assert.match(analysis.insights[0].detail, /Aucune métrique publique/i);
  assert.ok(analysis.caveats.some((item) => /jamais remplacée par zéro/i.test(item)));
  assert.ok(analysis.caveats.some((item) => /causalité|causale/i.test(item)));
});

test("surfaces a reused cross-platform creative before mechanical platform notes", () => {
  const analysis = buildSocialAnalysis(
    [
      post({
        platform: "youtube",
        externalId: "yt-shared",
        title: "be ready, i’m coming for y’all 😈",
        views: 100_000,
      }),
      post({
        platform: "youtube",
        externalId: "yt-other",
        title: "late night study beats",
        views: 10_000,
      }),
      post({
        platform: "x",
        externalId: "x-shared",
        format: "video",
        title: "be ready, i’m coming for y’all 😈",
        views: 2_000,
        likes: 150,
      }),
      post({
        platform: "x",
        externalId: "x-other",
        format: "video",
        title: "another post",
        views: 200,
        likes: 5,
      }),
    ],
    NOW,
  );

  assert.match(analysis.insights[0].title, /cross-platform/i);
  assert.match(analysis.insights[0].detail, /YouTube.*X|X.*YouTube/i);
  assert.match(analysis.insights[0].detail, /test/i);
});

test("parses Instagram structured embed counts without filling unavailable metrics", async () => {
  const context = JSON.stringify({
    graphql_media: [
      {
        shortcode_media: {
          shortcode: "ABC123",
          __typename: "GraphVideo",
          display_url: "https://cdn.example.test/image.jpg",
          caption: "Study time",
          video_view_count: 4_567,
          edge_media_to_comment: { count: 12 },
          edge_liked_by: { count: 345 },
          taken_at_timestamp: 1_785_783_747,
          owner: {
            id: "42",
            username: "lofigirl",
            edge_followed_by: { count: 987_654 },
          },
        },
      },
    ],
  });
  const html = `<script>s.handle(${JSON.stringify({ nested: { contextJSON: context } })});</script>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  try {
    const result = await scanPlatform("instagram");
    assert.equal(result.externalAccountId, "42");
    assert.equal(result.followerCount, 987_654);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].url, "https://www.instagram.com/reel/ABC123/");
    assert.equal(result.posts[0].views, 4_567);
    assert.equal(result.posts[0].likes, 345);
    assert.equal(result.posts[0].comments, 12);
    assert.equal(result.posts[0].shares, null);
    assert.equal(result.posts[0].saves, null);
    assert.equal(result.posts[0].thumbnailUrl, "https://cdn.example.test/image.jpg");
    assert.equal(result.posts[0].publishedAt, "2026-08-03T19:02:27.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
