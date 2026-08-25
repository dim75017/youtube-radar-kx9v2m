import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCommentOpportunityFeed,
  commentOpportunityGoldenWindow,
  commentOpportunityIsSensitive,
  commentOpportunityMomentTier,
  commentOpportunityRankScore,
  commentOpportunityPriorityScore,
  hasCommentOpportunityAccelerationEvidence,
  isNativeCommentOpportunityUrl,
  measureCommentOpportunityVelocity,
  nativeCommentOpportunityIdentity,
  rankCommentOpportunities,
} from "../lib/comment-opportunities.ts";

const feed = JSON.parse(
  await readFile(new URL("../data/comment-opportunities/feed.json", import.meta.url), "utf8"),
);

test("the comment opportunity feed is a valid v2 snapshot with every platform checked", () => {
  assert.equal(assertCommentOpportunityFeed(feed), feed);
  assert.equal(feed.version, 2);
  assert.equal(feed.cadenceHours, 6);
  assert.equal(feed.fastLaneMinutes, 15);
  assert.ok(feed.watchlistAccountCount > 0);
  assert.ok(Date.parse(feed.nextRefreshAt) > Date.parse(feed.capturedAt));
  assert.equal(feed.sourceChecks.length, 4);
  assert.ok(feed.opportunities.length >= 20, "the board should not be nearly empty");
  assert.ok(feed.opportunities.length <= 30, "the board should remain immediately readable");

  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    const check = feed.sourceChecks.find((item) => item.platform === platform);
    assert.ok(check, `${platform} needs a source check`);
    // A platform is only allowed to claim success when it actually produced
    // something, and only allowed to show cards when it did not fail.
    const count = feed.opportunities.filter((item) => item.platform === platform).length;
    assert.ok(count >= 4, `${platform} needs at least four verified opportunities`);
    if (check.status === "success") assert.ok(count > 0, `${platform} claims success with no card`);
    if (check.status === "failed") assert.equal(count, 0, `${platform} failed yet published cards`);
  }

  assert.equal(new Set(feed.opportunities.map((item) => item.id)).size, feed.opportunities.length);
  assert.equal(
    new Set(feed.opportunities.map((item) => nativeCommentOpportunityIdentity(item))).size,
    feed.opportunities.length,
  );
  assert.equal(
    new Set(
      feed.opportunities.flatMap((item) =>
        item.comments.map((comment) => comment.text.normalize("NFKC").toLocaleLowerCase("en"))
      ),
    ).size,
    feed.opportunities.length * 3,
    "no proposed line may be reused on another video",
  );

  for (const opportunity of feed.opportunities) {
    assert.equal(opportunity.mediaType, "video", opportunity.id);
    assert.equal(isNativeCommentOpportunityUrl(opportunity.url, opportunity.platform), true, opportunity.id);
    assert.equal(opportunity.priorityScore, commentOpportunityPriorityScore(opportunity), opportunity.id);
    assert.equal(opportunity.momentTier, commentOpportunityMomentTier(opportunity), opportunity.id);
    assert.deepEqual(
      opportunity.velocity,
      measureCommentOpportunityVelocity(opportunity.observations),
      opportunity.id,
    );
    assert.equal(opportunity.observations.at(-1).capturedAt, opportunity.capturedAt, opportunity.id);
    assert.deepEqual(
      new Set(opportunity.comments.map((comment) => comment.tone)),
      new Set(["funny", "smart", "complice"]),
      opportunity.id,
    );
    for (const comment of opportunity.comments) {
      assert.ok(comment.text.length <= 160, opportunity.id);
      assert.doesNotMatch(comment.text, /https?:\/\/|www\.|#[\p{L}\p{N}_-]+/iu, opportunity.id);
      assert.doesNotMatch(comment.text, /\b(?:follow|subscribe|link in bio|check out)\b/iu, opportunity.id);
    }
    if (opportunity.status === "surging") {
      assert.equal(hasCommentOpportunityAccelerationEvidence(opportunity), true, opportunity.id);
    }
    if (commentOpportunityIsSensitive(opportunity)) {
      assert.equal(opportunity.risk.level, "medium", opportunity.id);
    }
  }
});

test("a long-form YouTube upload is a valid target, which is what a trailer is", () => {
  assert.equal(
    isNativeCommentOpportunityUrl("https://www.youtube.com/watch?v=QdBZY2fkU-0", "youtube"),
    true,
  );
  assert.equal(
    isNativeCommentOpportunityUrl("https://www.youtube.com/shorts/QdBZY2fkU-0", "youtube"),
    true,
  );
  assert.equal(isNativeCommentOpportunityUrl("https://www.youtube.com/watch?v=short", "youtube"), false);
  assert.equal(isNativeCommentOpportunityUrl("https://youtu.be/QdBZY2fkU-0", "youtube"), false);
  // Two URL shapes of the same video must collapse to one identity, otherwise
  // the same trailer can be queued twice.
  assert.equal(
    nativeCommentOpportunityIdentity({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=QdBZY2fkU-0",
    }),
    "youtube:QdBZY2fkU-0",
  );
  assert.notEqual(
    nativeCommentOpportunityIdentity({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    }),
    nativeCommentOpportunityIdentity({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
    }),
  );
});

test("velocity is measured on one counter, over a window wide enough to divide by", () => {
  const observation = (capturedAt, views) => ({
    capturedAt,
    views,
    likes: null,
    comments: null,
    shares: null,
    sourceLabel: "test",
    sourceUrl: "https://example.com/",
    exactness: "exact",
  });

  assert.equal(measureCommentOpportunityVelocity([observation("2026-08-13T10:00:00Z", 1_000)]), null);

  // Two readings a minute apart would divide a small delta by a tiny window
  // and invent an enormous rate. They are refused.
  assert.equal(
    measureCommentOpportunityVelocity([
      observation("2026-08-13T10:00:00Z", 1_000),
      observation("2026-08-13T10:01:00Z", 1_200),
    ]),
    null,
  );

  assert.deepEqual(
    measureCommentOpportunityVelocity([
      observation("2026-08-13T10:00:00Z", 1_000),
      observation("2026-08-13T11:00:00Z", 61_000),
    ]),
    {
      metric: "views",
      perHour: 60_000,
      windowHours: 1,
      fromCapturedAt: "2026-08-13T10:00:00Z",
      toCapturedAt: "2026-08-13T11:00:00Z",
    },
  );

  // A counter that stopped moving is not negative momentum, it is no momentum.
  assert.equal(
    measureCommentOpportunityVelocity([
      observation("2026-08-13T10:00:00Z", 5_000),
      observation("2026-08-13T11:00:00Z", 5_000),
    ]),
    null,
  );
});

test("a huge counter on an old upload is back catalogue, not a moment", () => {
  const base = {
    velocity: null,
    discovery: { source: "viral-scan", accountHandle: null, accountTier: null },
    metrics: { views: 9_000_000, likes: null, comments: null, shares: null },
    publishedAt: "2026-08-13T00:00:00Z",
    capturedAt: "2026-08-13T06:00:00Z",
  };
  assert.equal(commentOpportunityMomentTier(base), "s");
  assert.equal(
    commentOpportunityMomentTier({ ...base, capturedAt: "2026-08-20T00:00:00Z" }),
    "b",
    "a week later the same counter no longer describes a moment",
  );
});

test("a fresh drop from a major account is held at gros buzz until it is measured", () => {
  const drop = {
    velocity: null,
    discovery: { source: "watchlist", accountHandle: "@rockstargames", accountTier: "s" },
    metrics: { views: 12_000, likes: null, comments: null, shares: null },
    publishedAt: "2026-08-13T10:00:00Z",
    capturedAt: "2026-08-13T10:20:00Z",
  };
  assert.equal(commentOpportunityMomentTier(drop), "a");
  assert.equal(
    commentOpportunityMomentTier({
      ...drop,
      velocity: {
        metric: "views",
        perHour: 900_000,
        windowHours: 0.25,
        fromCapturedAt: "2026-08-13T10:05:00Z",
        toCapturedAt: "2026-08-13T10:20:00Z",
      },
    }),
    "s",
    "once the climb is measured, the measurement decides",
  );
});

test("the golden window closes faster on a major moment than on ordinary virality", () => {
  const published = "2026-08-13T10:00:00Z";
  const major = commentOpportunityGoldenWindow(
    { publishedAt: published, momentTier: "s" },
    "2026-08-13T15:00:00Z",
  );
  const ordinary = commentOpportunityGoldenWindow(
    { publishedAt: published, momentTier: "b" },
    "2026-08-13T15:00:00Z",
  );
  assert.equal(major.state, "closing");
  assert.equal(major.remainingMinutes, 60);
  assert.equal(ordinary.state, "open");
  assert.equal(ordinary.remainingMinutes, 19 * 60);
  assert.equal(
    commentOpportunityGoldenWindow({ publishedAt: published, momentTier: "s" }, "2026-08-14T00:00:00Z").state,
    "closed",
  );
  assert.equal(
    commentOpportunityGoldenWindow({ publishedAt: null, momentTier: "s" }, "2026-08-13T15:00:00Z").state,
    "unknown",
  );
});

test("a sensitive subject cannot be published as low risk", () => {
  const snapshot = structuredClone(feed);
  const opportunity = snapshot.opportunities[0];
  opportunity.title = `${opportunity.title} funeral coverage`;
  opportunity.risk = { level: "low", note: "rien à signaler" };
  assert.equal(commentOpportunityIsSensitive(opportunity), true);
  assert.throws(() => assertCommentOpportunityFeed(snapshot), /Sujet sensible/i);
});

test("an exact comment reused on another video is refused", () => {
  const snapshot = structuredClone(feed);
  snapshot.opportunities[1].comments[0].text = snapshot.opportunities[0].comments[0].text;
  assert.throws(
    () => assertCommentOpportunityFeed(snapshot),
    /Commentaire proposé invalide/u,
  );
});

test("a declared velocity that the observations do not support is refused", () => {
  const snapshot = structuredClone(feed);
  snapshot.opportunities[0].velocity = {
    metric: "views",
    perHour: 999_999,
    windowHours: 1,
    fromCapturedAt: snapshot.opportunities[0].observations[0].capturedAt,
    toCapturedAt: snapshot.opportunities[0].capturedAt,
  };
  assert.throws(() => assertCommentOpportunityFeed(snapshot), /Vitesse non dérivable/i);
});

test("a single large counter is hot, never acceleration evidence", () => {
  const opportunity = structuredClone(feed.opportunities[0]);
  opportunity.observations = [opportunity.observations.at(-1)];
  opportunity.status = "hot";
  assert.equal(opportunity.observations.length, 1);
  assert.equal(hasCommentOpportunityAccelerationEvidence(opportunity), false);
  opportunity.status = "surging";
  opportunity.velocity = null;
  // Keep every other derived field honest, so the failure under test is the
  // unproven acceleration and not a tier that no longer matches its inputs.
  opportunity.momentTier = commentOpportunityMomentTier(opportunity);
  const snapshot = structuredClone(feed);
  snapshot.opportunities[0] = opportunity;
  assert.throws(() => assertCommentOpportunityFeed(snapshot), /Accélération non prouvée/i);
});

test("ranking combines editorial fit, freshness and the weight of the moment", () => {
  const ranked = rankCommentOpportunities(feed.opportunities, feed.capturedAt);
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(
      commentOpportunityRankScore(ranked[index - 1], feed.capturedAt) >=
        commentOpportunityRankScore(ranked[index], feed.capturedAt),
    );
  }
  const fresh = {
    ...structuredClone(feed.opportunities[0]),
    id: "fresh-reference",
    priorityScore: 90,
    momentTier: "a",
    publishedAt: feed.capturedAt,
    status: "hot",
  };
  const stale = {
    ...structuredClone(feed.opportunities[1]),
    id: "stale-reference",
    priorityScore: 100,
    momentTier: "b",
    publishedAt: "2026-07-01T00:00:00Z",
    status: "hot",
  };
  assert.equal(
    rankCommentOpportunities([stale, fresh], feed.capturedAt)[0].id,
    fresh.id,
    "a fresh strong-fit reaction should outrank an old isolated viral post",
  );
});
