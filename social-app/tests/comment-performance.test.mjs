import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
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

test("wires the truthful performance view into both public runtimes", async () => {
  const [component, socialOs, page, preview] = await Promise.all([
    readFile(new URL("../app/CommentPerformanceView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/SocialOS.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../preview/main.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(socialOs, /view === "comment-performance"/);
  assert.match(socialOs, />Performance</);
  assert.match(component, /Abonnés attribués aux commentaires/);
  assert.match(component, /Non attribuable/);
  assert.match(component, /il n’est donc pas utilisé ici comme résultat des commentaires/);
  assert.match(component, /les nouveaux commentaires ne sont pas ajoutés automatiquement/i);
  assert.match(component, /Les gains ne sont jamais répartis artificiellement/);
  assert.doesNotMatch(component, /followersNet|followerContext/);
  assert.doesNotMatch(component, /taux d.engagement/i);
  assert.match(page, /owner-comment-refresh-status\.json/);
  assert.match(preview, /RAW_OWNER_COMMENT_REFRESH_STATUS_URL/);
});
