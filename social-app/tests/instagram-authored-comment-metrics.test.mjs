import test from "node:test";
import assert from "node:assert/strict";

import {
  assertDedicatedInstagramProfilePath,
  buildInstagramImportRow,
  buildInstagramMetricQueue,
  instagramAccessState,
  parseInstagramCount,
  parseInstagramMetricLabels,
} from "../scripts/collect_instagram_authored_comment_metrics.mjs";

test("parseInstagramCount understands exact and compact public counters", () => {
  assert.equal(parseInstagramCount("1 like"), 1);
  assert.equal(parseInstagramCount("12 likes"), 12);
  assert.equal(parseInstagramCount("1.2K likes"), 1_200);
  assert.equal(parseInstagramCount("2,5 k replies"), 2_500);
  assert.equal(parseInstagramCount("1,234 likes"), 1_234);
  assert.equal(parseInstagramCount("12.345 likes"), 12_345);
  assert.equal(parseInstagramCount("1,2 likes"), null);
  assert.equal(parseInstagramCount("Like"), null);
});

test("parseInstagramMetricLabels never invents a hidden zero", () => {
  assert.deepEqual(parseInstagramMetricLabels(["3 likes", "View 2 replies"]), {
    likes: 3,
    replies: 2,
    ambiguousLikes: false,
    ambiguousReplies: false,
  });
  assert.deepEqual(parseInstagramMetricLabels(["Like", "Reply"]), {
    likes: null,
    replies: null,
    ambiguousLikes: false,
    ambiguousReplies: false,
  });
  assert.deepEqual(parseInstagramMetricLabels(["Like", "3 likes", "Reply", "View 2 replies"]), {
    likes: 3,
    replies: 2,
    ambiguousLikes: false,
    ambiguousReplies: false,
  });
});

test("ambiguous metric labels fail closed", () => {
  assert.deepEqual(parseInstagramMetricLabels(["3 likes", "4 likes", "1 reply"]), {
    likes: null,
    replies: 1,
    ambiguousLikes: true,
    ambiguousReplies: false,
  });
});

test("instagramAccessState detects authentication, challenge and throttling", () => {
  assert.equal(instagramAccessState({ url: "https://www.instagram.com/accounts/login/", text: "" }), "unauthenticated");
  assert.equal(instagramAccessState({ url: "https://www.instagram.com/challenge/", text: "" }), "challenge");
  assert.equal(instagramAccessState({ url: "https://www.instagram.com/p/x/", text: "Please wait a few minutes" }), "rate-limited");
  assert.equal(instagramAccessState({ url: "https://www.instagram.com/p/x/", text: "A normal post" }), "ready");
});

test("the metric collector cannot open a profile outside its dedicated work directory", () => {
  assert.match(
    assertDedicatedInstagramProfilePath("work/owner-comments/browser-profiles/instagram"),
    /owner-comments[\\/]browser-profiles[\\/]instagram$/u,
  );
  assert.throws(
    () => assertDedicatedInstagramProfilePath("../Chrome/User Data"),
    /profil doit rester/u,
  );
});

test("buildInstagramMetricQueue selects only authored comments with attributable Instagram targets", () => {
  const snapshot = {
    posts: [
      {
        platform: "instagram",
        format: "comment",
        externalId: "comment:18123456789012345",
        url: "https://www.instagram.com/p/ABC123/c/18123456789012345/",
        text: "cozy comment",
        raw: {
          commentIdKind: "native",
          commentTarget: { url: "https://www.instagram.com/p/ABC123/" },
        },
      },
      {
        platform: "instagram",
        format: "comment",
        externalId: "comment:synthetic",
        url: "https://www.instagram.com/your_activity/interactions/comments/",
        text: "missing target",
        raw: { commentIdKind: "synthetic", commentTarget: { url: null } },
      },
      {
        platform: "instagram",
        format: "comment",
        externalId: "comment:instagram-synthetic-deadbeef",
        url: "https://www.instagram.com/creator/reel/SYNTHETIC/",
        text: "safe exact-text target",
        raw: {
          commentIdKind: "synthetic",
          commentTarget: { url: "https://www.instagram.com/creator/reel/SYNTHETIC/" },
        },
      },
      { platform: "youtube", format: "comment", externalId: "comment:yt", url: "https://youtube.com/watch?v=x", text: "x" },
    ],
  };
  const queue = buildInstagramMetricQueue(snapshot);
  assert.equal(queue.length, 2);
  assert.deepEqual(
    {
      id: queue[0].id,
      idKind: queue[0].idKind,
      contentUrl: queue[0].contentUrl,
      commentUrl: queue[0].commentUrl,
      text: queue[0].text,
      isNativeDeepLink: queue[0].isNativeDeepLink,
    },
    {
      id: "18123456789012345",
      idKind: "native",
      contentUrl: "https://www.instagram.com/p/ABC123/",
      commentUrl: "https://www.instagram.com/p/ABC123/c/18123456789012345/",
      text: "cozy comment",
      isNativeDeepLink: true,
    },
  );
  assert.deepEqual(
    {
      id: queue[1].id,
      idKind: queue[1].idKind,
      contentUrl: queue[1].contentUrl,
      commentUrl: queue[1].commentUrl,
      text: queue[1].text,
      isNativeDeepLink: queue[1].isNativeDeepLink,
    },
    {
      id: "instagram-synthetic-deadbeef",
      idKind: "synthetic",
      contentUrl: "https://www.instagram.com/reel/SYNTHETIC/",
      commentUrl: "https://www.instagram.com/reel/SYNTHETIC/",
      text: "safe exact-text target",
      isNativeDeepLink: false,
    },
  );
});

test("buildInstagramImportRow produces a null-safe importer row with an exact observed date", () => {
  const existing = {
    platform: "instagram",
    format: "comment",
    externalId: "comment:18123456789012345",
    url: "https://www.instagram.com/p/ABC123/c/18123456789012345/",
    title: "Target",
    text: "cozy comment",
    publishedAt: "2026-08-20T00:00:00.000Z",
    thumbnailUrl: "https://example.test/thumb.jpg",
    raw: {
      commentIdKind: "native",
      publishedAtPrecision: "approximate",
      commentTarget: {
        contentId: "ABC123",
        url: "https://www.instagram.com/p/ABC123/",
        authorHandle: "creator",
        audiencePrecision: "unknown",
      },
      commentObservation: { relativeAge: "1w" },
    },
  };
  const [candidate] = buildInstagramMetricQueue({ posts: [existing] });
  const row = buildInstagramImportRow(
    candidate,
    {
      status: "observed",
      publishedAt: "2026-08-20T12:34:56.000Z",
      metrics: { likes: 12, replies: null },
    },
    "2026-08-31T12:00:00.000Z",
  );
  assert.equal(row.id, "18123456789012345");
  assert.equal(row.publishedAtPrecision, "exact");
  assert.equal(row.metrics.likes, 12);
  assert.equal(row.metrics.replies, null);
  assert.equal(row.target.url, "https://www.instagram.com/p/ABC123/");
  assert.equal(row.observation.observedAt, "2026-08-31T12:00:00.000Z");
});
