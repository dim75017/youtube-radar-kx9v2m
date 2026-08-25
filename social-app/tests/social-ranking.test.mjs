import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  publicRankingLabel,
  rankPostsByPublicMetric,
} from "../lib/social-ranking.ts";

const PUBLIC_HISTORY = JSON.parse(
  readFileSync(new URL("../data/public-history.json", import.meta.url), "utf8"),
);

function post(overrides = {}) {
  return {
    external_post_id: "post",
    format: "video",
    likes: null,
    views: null,
    comments: null,
    shares: null,
    saves: null,
    poll_votes: null,
    published_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function snapshotPost(item) {
  return post({
    external_post_id: item.externalId,
    format: item.format,
    likes: item.likes,
    views: item.views,
    comments: item.comments,
    shares: item.shares,
    saves: item.saves,
    poll_votes: item.raw?.pollVotes ?? null,
    published_at: item.publishedAt,
  });
}

test("sorts strictly by known likes before any secondary signal", () => {
  const source = [
    post({ external_post_id: "nine", likes: 9, views: 100_000_000 }),
    post({ external_post_id: "ten", likes: 10, views: 1 }),
    post({ external_post_id: "missing", likes: null, views: 200_000_000 }),
  ];
  const ranked = rankPostsByPublicMetric(source);

  assert.equal(ranked.metric, "likes");
  assert.deepEqual(ranked.posts.map((item) => item.external_post_id), ["ten", "nine", "missing"]);
  assert.deepEqual(source.map((item) => item.external_post_id), ["nine", "ten", "missing"]);
});

test("uses poll votes only to break equal likes", () => {
  const ranked = rankPostsByPublicMetric([
    post({ external_post_id: "popular-votes", format: "community_poll", likes: 2_200, poll_votes: 99_000 }),
    post({ external_post_id: "popular-likes", format: "community_poll", likes: 2_600, poll_votes: 31_000 }),
    post({ external_post_id: "tie-high", format: "community_poll", likes: 2_000, poll_votes: 50_000 }),
    post({ external_post_id: "tie-low", format: "community_poll", likes: 2_000, poll_votes: 10_000 }),
  ]);

  assert.deepEqual(ranked.posts.map((item) => item.external_post_id), [
    "popular-likes",
    "popular-votes",
    "tie-high",
    "tie-low",
  ]);
});

test("falls back explicitly to views when an entire category has no likes", () => {
  const ranked = rankPostsByPublicMetric([
    post({ external_post_id: "low", format: "short", views: 10 }),
    post({ external_post_id: "high", format: "short", views: 100 }),
  ]);

  assert.equal(ranked.metric, "views");
  assert.equal(publicRankingLabel(ranked.metric), "Vues décroissantes · likes indisponibles");
  assert.deepEqual(ranked.posts.map((item) => item.external_post_id), ["high", "low"]);
});

test("keeps an unmeasured category stable and never uses the date", () => {
  const ranked = rankPostsByPublicMetric([
    post({ external_post_id: "b", format: "comment", published_at: "2020-01-01T00:00:00Z" }),
    post({ external_post_id: "a", format: "comment", published_at: "2030-01-01T00:00:00Z" }),
  ]);

  assert.equal(ranked.metric, null);
  assert.deepEqual(ranked.posts.map((item) => item.external_post_id), ["a", "b"]);
});

test("keeps the known snapshot winners under the requested raw ranking", () => {
  const tikTok = PUBLIC_HISTORY.posts
    .filter((item) => item.platform === "tiktok")
    .map(snapshotPost);
  const images = PUBLIC_HISTORY.posts
    .filter((item) => item.platform === "youtube" && item.format === "community_image")
    .map(snapshotPost);
  const text = PUBLIC_HISTORY.posts
    .filter((item) => item.platform === "youtube" && item.format === "community_text")
    .map(snapshotPost);
  const shorts = PUBLIC_HISTORY.posts
    .filter((item) => item.platform === "youtube" && item.format === "short")
    .map(snapshotPost);

  assert.equal(rankPostsByPublicMetric(tikTok).posts[0].external_post_id, "7532570759349226774");
  assert.equal(rankPostsByPublicMetric(images).posts[0].external_post_id, "UgkxzRdC32FUR_wPFHq2U-V6QzZSsJCo3huE");
  assert.equal(rankPostsByPublicMetric(text).posts[0].external_post_id, "UgkxLBRAQx4mbnvn7DIiw3N5ktSzS9iWj7DB");
  const rankedShorts = rankPostsByPublicMetric(shorts);
  assert.equal(rankedShorts.metric, "likes");
  assert.ok(rankedShorts.posts[0].likes !== null);
  assert.ok(shorts.every((item) => item.views !== null));
});
