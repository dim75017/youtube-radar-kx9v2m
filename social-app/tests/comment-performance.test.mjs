import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildYoutubeExternalCommentMonthlyImpact,
  buildYoutubeCommentPerformance,
} from "../lib/comment-performance.ts";

const REFERENCE = "2026-08-31T05:51:44.585Z";

function post(overrides = {}) {
  return {
    id: "youtube:top-a",
    external_post_id: "top-a",
    platform: "youtube",
    format: "comment",
    url: "https://www.youtube.com/watch?v=video&lc=top-a",
    title: "Target video",
    text: "cozy",
    published_at: "2026-08-20T10:00:00.000Z",
    published_at_precision: "exact",
    likes: 10,
    comments: 3,
    raw_json: JSON.stringify({ activityType: "publié un commentaire" }),
    metric_history: [
      { captured_at: "2026-08-21T00:00:00.000Z", likes: 7, comments: 2 },
      { captured_at: "2026-08-30T00:00:00.000Z", likes: 10, comments: 3 },
    ],
    ...overrides,
  };
}

test("reports YouTube comment activity, current interactions and real snapshot change", () => {
  const summary = buildYoutubeCommentPerformance([
    post(),
    post({
      id: "youtube:top-a.reply-b",
      external_post_id: "top-a.reply-b",
      published_at: "2026-08-21T10:00:00.000Z",
      published_at_precision: "approximate",
      likes: 4,
      comments: 99,
      raw_json: JSON.stringify({ activityType: "répondu à un commentaire" }),
      metric_history: [
        { captured_at: "2026-08-22T00:00:00.000Z", likes: 1, comments: 99 },
        { captured_at: "2026-08-30T00:00:00.000Z", likes: 4, comments: 101 },
      ],
    }),
    post({
      id: "youtube:missing",
      external_post_id: "missing",
      published_at: "2026-08-22T10:00:00.000Z",
      published_at_precision: "unknown",
      likes: null,
      comments: null,
      metric_history: [],
    }),
    post({
      id: "youtube:older-but-still-growing",
      external_post_id: "older-but-still-growing",
      published_at: "2020-01-01T10:00:00.000Z",
      likes: 2,
      comments: 0,
      metric_history: [
        { captured_at: "2026-08-23T00:00:00.000Z", likes: 0, comments: 0 },
        { captured_at: "2026-08-30T00:00:00.000Z", likes: 2, comments: 0 },
      ],
    }),
    post({ platform: "instagram", id: "instagram:ignored" }),
  ], REFERENCE, "30d");

  assert.equal(summary.totalPublished, 3);
  assert.equal(summary.commentsPublished, 2);
  assert.equal(summary.repliesPublished, 1);
  assert.equal(summary.measuredCount, 2);
  assert.equal(summary.likesReceived, 14);
  assert.equal(
    summary.repliesReceived,
    3,
    "thread reply totals must not be attributed to our authored reply",
  );
  assert.equal(summary.interactionsReceived, 17);
  assert.equal(summary.engagedShare, 1);
  assert.equal(summary.medianInteractions, 8.5);
  assert.equal(summary.tracking.comparedCount, 3);
  assert.equal(summary.tracking.likesNetChange, 8);
  assert.equal(summary.tracking.repliesNetChange, 1);
  assert.equal(summary.tracking.points.reduce(
    (total, point) => total + point.likesNetChange + point.repliesNetChange,
    0,
  ), 9);
  const observedPoint = summary.tracking.points.find(
    (point) => point.likesNetChange || point.repliesNetChange,
  );
  assert.equal(observedPoint.firstComparedAt, "2026-08-21T00:00:00.000Z");
  assert.equal(observedPoint.lastComparedAt, "2026-08-30T00:00:00.000Z");
  assert.equal(summary.inventoryExactDates, 2);
  assert.equal(summary.inventoryApproximateDates, 2);
  assert.equal(summary.buckets.length, 30);
  assert.equal(summary.buckets.reduce(
    (total, bucket) => total + bucket.commentsPublished + bucket.repliesPublished,
    0,
  ), 3);
  assert.equal(summary.bestComment?.id, "top-a");
});

test("uses yearly buckets for the full inventory and keeps empty years visible", () => {
  const summary = buildYoutubeCommentPerformance([
    post({ published_at: "2015-03-27T11:22:00.000Z" }),
    post({ id: "youtube:new", external_post_id: "new", published_at: "2026-08-04T12:03:00.000Z" }),
  ], REFERENCE, "all");

  assert.equal(summary.buckets.at(0).key, "2015");
  assert.equal(summary.buckets.at(-1).key, "2026");
  assert.equal(summary.buckets.length, 12);
  assert.equal(summary.buckets.find((bucket) => bucket.key === "2020").cumulativePublished, 1);
  assert.equal(summary.buckets.at(-1).cumulativePublished, 2);
});

test("builds a monthly impact series from comments on external videos only", () => {
  const summary = buildYoutubeExternalCommentMonthlyImpact([
    post({
      id: "youtube:may",
      external_post_id: "may",
      published_at: "2025-05-06T16:13:00.000Z",
      likes: 130_000,
      comments: 784,
      text: "okay fine, I'll put my pencil down for this",
    }),
    post({
      id: "youtube:june",
      external_post_id: "june",
      published_at: "2025-06-28T12:31:00.000Z",
      likes: 139_000,
      comments: 627,
      text: "LESSSGOOOOOO",
    }),
    post({
      id: "youtube:owned",
      external_post_id: "owned",
      published_at: "2025-06-29T12:31:00.000Z",
      likes: 999_999,
      comments: 999,
      raw_json: JSON.stringify({
        activityType: "publié un commentaire",
        commentTarget: { authorHandle: "LofiGirl" },
      }),
    }),
    post({
      id: "youtube:community",
      external_post_id: "community",
      url: "https://www.youtube.com/post/community",
      published_at: "2025-06-30T12:31:00.000Z",
      likes: 999_999,
      comments: 999,
    }),
  ], REFERENCE, 36);

  assert.equal(summary.points.length, 36);
  assert.equal(summary.points.at(0).key, "2023-09");
  assert.equal(summary.points.at(-1).key, "2026-08");
  assert.equal(summary.commentsPublished, 2);
  assert.equal(summary.interactionsReceived, 270_411);
  assert.equal(summary.points.find((point) => point.key === "2025-05").commentsPublished, 1);
  assert.equal(summary.points.find((point) => point.key === "2025-05").topComment.text, "okay fine, I'll put my pencil down for this");
  assert.equal(summary.points.find((point) => point.key === "2025-06").commentsPublished, 1);
});

test("moves the truthful comment graph into YouTube Analytics and removes the Performance tab", async () => {
  const [component, socialOs, page, preview] = await Promise.all([
    readFile(new URL("../app/YoutubeCommentAnalyticsChart.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../preview/main.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(socialOs, /view === "comment-performance"/);
  assert.doesNotMatch(socialOs, />Performance</);
  assert.match(socialOs, /activePlatform === "youtube"[\s\S]*?<YoutubeCommentAnalyticsChart/);
  assert.match(component, /Commentaires publiés par mois/);
  assert.match(component, /vidéos d’autres créateurs/);
  assert.match(component, /YouTube ne fournit pas les visites de chaîne ni les abonnements attribuables/);
  assert.match(component, /Mois partiel/);
  assert.match(component, /Commentaire à \+10 k/);
  assert.doesNotMatch(component, /followersNet|followerContext/);
  assert.doesNotMatch(component, /taux d.engagement/i);
  assert.match(page, /owner-comment-refresh-status\.json/);
  assert.match(preview, /RAW_OWNER_COMMENT_REFRESH_STATUS_URL/);
});
