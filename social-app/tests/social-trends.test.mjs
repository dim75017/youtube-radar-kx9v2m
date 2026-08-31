import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPublishableSocialTrendFeed,
  assertSocialTrendFeed,
  filterSocialTrends,
  isActionableSocialTrend,
  isQualifiedTrendReferencePost,
  isVerifiedMultiCreatorTrend,
  MAX_TREND_VIDEO_DURATION_SECONDS,
  MIN_ACTIONABLE_TREND_LOFI_FIT,
  MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
  MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
  MIN_PUBLISHABLE_VIDEO_PROPOSALS,
  MIN_PUBLISHABLE_LOFI_GIRL_SHARE,
  MIN_TREND_DISTINCT_CREATORS,
  MIN_TREND_VIDEO_LIKES,
  rankSocialTrends,
  selectGirlFirstSocialTrends,
  TREND_ACTIVE_MAX_VERIFICATION_AGE_HOURS,
  TREND_PUBLISH_MAX_AGE_HOURS,
  TREND_REFRESH_CADENCE_HOURS,
  TREND_STEADY_MAX_VERIFICATION_AGE_HOURS,
  TREND_PRIORITY_THRESHOLD,
  trendPriorityScore,
} from "../lib/social-trends.ts";

const feed = JSON.parse(
  await readFile(new URL("../data/trends/feed.json", import.meta.url), "utf8"),
);

function referenceUrlMatchesPlatform(referencePost) {
  const url = new URL(referencePost.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (referencePost.platform === "instagram") {
    return (host === "instagram.com" || host.endsWith(".instagram.com")) &&
      /^\/(?:p|reel)\/[^/]+$/i.test(path);
  }
  if (referencePost.platform === "tiktok") {
    return (host === "tiktok.com" || host.endsWith(".tiktok.com")) &&
      /^\/@[^/]+\/video\/\d{12,24}$/i.test(path);
  }
  if (referencePost.platform === "youtube") {
    return (host === "youtube.com" || host.endsWith(".youtube.com")) &&
      /^\/shorts\/[A-Za-z0-9_-]{11}$/i.test(path);
  }
  return (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) &&
    /^\/[^/]+\/status\/\d+$/i.test(path);
}

function cloneWithFirstReferencePost() {
  const snapshot = structuredClone(feed);
  const trend = snapshot.trends.find((candidate) => candidate.referencePost !== null);
  assert.ok(trend?.referencePost, "the fixture must contain a reference post");
  return { snapshot, trend, referencePost: trend.referencePost };
}

function cloneWithFirstVideoReferencePost() {
  const snapshot = structuredClone(feed);
  const trend = snapshot.trends.find(
    (candidate) => candidate.referencePost?.mediaType === "video",
  );
  assert.ok(trend?.referencePost, "the fixture must contain a video reference post");
  return { snapshot, trend, referencePost: trend.referencePost };
}

function cloneWithFirstNonVideoReferencePost() {
  const snapshot = structuredClone(feed);
  const trend = snapshot.trends.find(
    (candidate) => candidate.referencePost && candidate.referencePost.mediaType !== "video",
  );
  assert.ok(trend?.referencePost, "the fixture must contain a non-video reference post");
  return { snapshot, trend, referencePost: trend.referencePost };
}

function syncRefreshCounts(snapshot) {
  const actionable = snapshot.trends.filter(isActionableSocialTrend);
  const actionableIds = new Set(actionable.map((trend) => trend.id));
  const lofiGirl = actionable.filter(
    (trend) => trend.character === "lofi-girl",
  ).length;
  snapshot.refresh.counts.actionable = actionable.length;
  snapshot.refresh.counts.lofiGirl = lofiGirl;
  snapshot.refresh.counts.lofiBoy = actionable.length - lofiGirl;
  if (snapshot.refresh.discoveryAudit) {
    snapshot.refresh.discoveryAudit.matchedTrendIds =
      snapshot.refresh.discoveryAudit.matchedTrendIds.filter((id) => actionableIds.has(id));
    snapshot.refresh.discoveryAudit.currentMatchedCount =
      snapshot.refresh.discoveryAudit.matchedTrendIds.length;
    snapshot.refresh.discoveryAudit.qualifiedInventoryCount = Math.min(
      snapshot.refresh.discoveryAudit.qualifiedInventoryCount,
      actionable.length,
    );
  }
  return snapshot;
}

function shortlyAfterCapture(snapshot = feed) {
  return new Date(Date.parse(snapshot.capturedAt) + 60_000);
}

function freshPublishableFixture(snapshot = feed) {
  const fixture = structuredClone(snapshot);
  for (const trend of fixture.trends.filter(isActionableSocialTrend)) {
    trend.lastVerifiedAt = fixture.capturedAt;
    trend.reuseEvidence.verifiedAt = fixture.capturedAt;
  }
  return fixture;
}

test("the current snapshot is complete, sourced and honest about missing metrics", () => {
  assert.equal(assertSocialTrendFeed(feed), feed);
  assert.equal(feed.version, 6);
  assert.equal(feed.refresh.cadenceHours, TREND_REFRESH_CADENCE_HOURS);
  assert.ok(
    feed.refresh.runId === null || feed.refresh.runId.trim().length > 0,
  );
  assert.ok(
    feed.refresh.runUrl === null ||
      new URL(feed.refresh.runUrl).protocol === "https:",
  );
  assert.ok(feed.refresh.sourceChecks.length > 0);
  assert.equal(
    feed.refresh.counts.checkedSources,
    feed.refresh.sourceChecks.filter((check) => check.status === "success").length,
  );
  assert.equal(
    feed.refresh.counts.matchedSignals,
    feed.refresh.sourceChecks
      .filter((check) => check.status === "success")
      .reduce((total, check) => total + check.candidatesMatched, 0),
  );
  assert.ok(Date.parse(feed.capturedAt) >= Date.parse("2026-08-10T00:00:00+02:00"));
  assert.ok(feed.trends.length >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS);
  assert.equal(new Set(feed.trends.map((trend) => trend.id)).size, feed.trends.length);
  assert.equal(
    new Set(feed.trends.map((trend) => trend.trendKey.toLowerCase())).size,
    feed.trends.length,
  );

  const trendsWithReference = feed.trends.filter((trend) => trend.referencePost !== null);
  const trendsWithoutReference = feed.trends.filter((trend) => trend.referencePost === null);
  assert.ok(trendsWithReference.length >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS);
  assert.ok(trendsWithoutReference.every((trend) => !isActionableSocialTrend(trend)));

  for (const trend of feed.trends) {
    assert.ok(["lofi-girl", "lofi-boy"].includes(trend.character), trend.id);
    assert.ok(trend.trendKey.trim().length > 0, trend.id);
    assert.ok(trend.clusterKey.trim().length > 0, trend.id);
    assert.ok(trend.territory.trim().length > 0, trend.id);
    assert.ok(Date.parse(trend.firstSeenAt) <= Date.parse(trend.lastVerifiedAt), trend.id);
    assert.ok(Date.parse(trend.lastVerifiedAt) <= Date.parse(feed.capturedAt), trend.id);
    assert.ok(trend.observations.length >= 1, trend.id);
    assert.ok(
      trend.observations.every(
        (observation) =>
          Date.parse(observation.observedAt) >= Date.parse(trend.firstSeenAt) &&
          Date.parse(observation.observedAt) <= Date.parse(trend.lastVerifiedAt),
      ),
      trend.id,
    );
    assert.deepEqual(
      new Set(trend.proposals.map((proposal) => proposal.tone)),
      new Set(["complice", "cozy", "absurde"]),
      trend.id,
    );
    assert.ok(trend.proposals.every((proposal) => proposal.concept && proposal.copy), trend.id);
    assert.ok(trend.observations.every((observation) => observation.sourceUrl.startsWith("https://")), trend.id);
    assert.ok(
      trend.observations
        .filter((observation) => observation.exactness === "editorial-observation")
        .every((observation) =>
          [observation.rank, observation.posts, observation.views, observation.uses]
            .every((metric) => metric === null),
        ),
      `${trend.id} must not expose an editorial report as a platform metric`,
    );

    if (trend.referencePost === null) {
      assert.equal(trend.reuseEvidence, null, trend.id);
      continue;
    }

    const referencePost = trend.referencePost;
    assert.equal(isQualifiedTrendReferencePost(referencePost), true, trend.id);
    assert.ok(trend.platforms.includes(referencePost.platform), trend.id);
    assert.ok(referenceUrlMatchesPlatform(referencePost), trend.id);
    assert.equal(new URL(referencePost.url).protocol, "https:", trend.id);
    assert.equal(new URL(referencePost.sourceUrl).protocol, "https:", trend.id);
    if (referencePost.thumbnailUrl !== null) {
      assert.equal(new URL(referencePost.thumbnailUrl).protocol, "https:", trend.id);
    }
    assert.ok(Number.isFinite(Date.parse(referencePost.capturedAt)), trend.id);
    assert.ok(
      Date.parse(referencePost.capturedAt) >= Date.parse(trend.firstSeenAt) &&
        Date.parse(referencePost.capturedAt) <= Date.parse(trend.lastVerifiedAt),
      trend.id,
    );
    if (referencePost.publishedAt !== null) {
      assert.ok(Number.isFinite(Date.parse(referencePost.publishedAt)), trend.id);
      assert.ok(
        Date.parse(referencePost.publishedAt) <= Date.parse(feed.capturedAt),
        trend.id,
      );
    }
    for (const metric of Object.values(referencePost.metrics)) {
      assert.ok(
        metric === null || (Number.isFinite(metric) && metric >= 0),
        trend.id,
      );
    }
    if (referencePost.mediaType === "video") {
      assert.ok(
        referencePost.metrics.likes >= MIN_TREND_VIDEO_LIKES,
        `${trend.id} must clear the public video-like threshold`,
      );
      assert.ok(
        referencePost.durationSeconds > 0 &&
          referencePost.durationSeconds < MAX_TREND_VIDEO_DURATION_SECONDS,
        `${trend.id} must be a verified video under 30 seconds`,
      );
    } else {
      assert.equal(referencePost.durationSeconds, null, trend.id);
    }
    if (referencePost.exactness === "editorial-observation") {
      assert.ok(
        Object.values(referencePost.metrics).every((metric) => metric === null),
        trend.id,
      );
    }
    if (isActionableSocialTrend(trend)) {
      assert.equal(isVerifiedMultiCreatorTrend(trend), true, trend.id);
      assert.ok(trend.reuseEvidence, trend.id);
      assert.equal(
        trend.reuseEvidence.minimumDistinctCreators,
        MIN_TREND_DISTINCT_CREATORS,
        trend.id,
      );
      assert.ok(
        trend.reuseEvidence.posts.length >= MIN_TREND_DISTINCT_CREATORS,
        trend.id,
      );
    }
  }

  assert.ok(
    feed.trends.some((trend) =>
      trend.observations.some((observation) => observation.views === null),
    ),
    "missing public metrics must stay null instead of being invented",
  );
});

test("the actionable feed keeps only strong, qualified Lofi-universe executions", () => {
  const actionable = feed.trends.filter(isActionableSocialTrend);
  assert.ok(
    actionable.length >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
    "the feed must expose at least 50 actionable trends",
  );
  assert.ok(
    actionable.every((trend) => trend.lofiFitScore >= MIN_ACTIONABLE_TREND_LOFI_FIT),
    "every actionable trend must clear the Lofi-fit threshold",
  );
  assert.ok(
    actionable.every((trend) => isQualifiedTrendReferencePost(trend.referencePost)),
    "every actionable trend must keep a qualified reference post",
  );
  assert.ok(
    actionable.every(isVerifiedMultiCreatorTrend),
    "every actionable trend must prove reuse by at least three creators",
  );
  assert.ok(
    actionable.every(
      (trend) =>
        trend.lifecycle !== "watch" &&
        trend.referencePost?.mediaType !== "unknown",
    ),
    "watch and unknown-media trends must stay outside the actionable feed",
  );
  const videoTrends = actionable.filter(
    (trend) => trend.referencePost?.mediaType === "video",
  );
  const videoProposalCount = videoTrends.reduce(
    (total, trend) => total + trend.proposals.length,
    0,
  );
  assert.ok(videoTrends.length >= MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS);
  assert.equal(new Set(videoTrends.map((trend) => trend.id)).size, videoTrends.length);
  assert.equal(
    new Set(videoTrends.map((trend) => trend.trendKey.trim().toLocaleLowerCase("fr"))).size,
    videoTrends.length,
  );
  assert.equal(
    new Set(videoTrends.map((trend) => trend.referencePost.url)).size,
    videoTrends.length,
  );
  assert.ok(videoTrends.every((trend) => trend.proposals.length === 3));
  assert.ok(videoProposalCount >= MIN_PUBLISHABLE_VIDEO_PROPOSALS);

  const excluded = feed.trends.filter((trend) => !isActionableSocialTrend(trend));
  assert.ok(excluded.length > 0, "the snapshot must retain rejected candidates for auditability");
  assert.ok(
    excluded.every((trend) => !actionable.some((candidate) => candidate.id === trend.id)),
  );

  const lofiBoyTrends = actionable.filter((trend) => trend.character === "lofi-boy");
  assert.ok(lofiBoyTrends.length > 0, "the feed must expose a real Lofi Boy selection");
  assert.ok(
    lofiBoyTrends.some((trend) => trend.territory.toLowerCase().includes("introversion")),
    "Lofi Boy must cover introversion",
  );
  assert.ok(
    lofiBoyTrends.some((trend) => trend.territory.toLowerCase().includes("cinéma")),
    "Lofi Boy must cover recent film culture",
  );
});

test("the actionable Lofi-fit threshold changes exactly between 84 and 85", () => {
  assert.equal(MIN_ACTIONABLE_TREND_LOFI_FIT, 85);
  const qualified = feed.trends.find((trend) =>
    isQualifiedTrendReferencePost(trend.referencePost),
  );
  assert.ok(qualified, "the fixture must contain a qualified trend reference");

  const belowThreshold = structuredClone(qualified);
  belowThreshold.lofiFitScore = 84;
  assert.equal(isActionableSocialTrend(belowThreshold), false);

  const atThreshold = structuredClone(qualified);
  atThreshold.lofiFitScore = 85;
  assert.equal(isActionableSocialTrend(atThreshold), true);
});

test("watch lifecycle and unknown media can never become actionable", () => {
  const actionable = feed.trends.find(isActionableSocialTrend);
  assert.ok(actionable?.referencePost, "the fixture must contain an actionable trend");

  const watch = structuredClone(actionable);
  watch.lifecycle = "watch";
  assert.equal(isActionableSocialTrend(watch), false);

  const unknown = structuredClone(actionable);
  unknown.referencePost.mediaType = "unknown";
  unknown.referencePost.durationSeconds = null;
  assert.equal(isQualifiedTrendReferencePost(unknown.referencePost), false);
  assert.equal(isActionableSocialTrend(unknown), false);
});

test("a trend is actionable only after reuse by three distinct creators is proven", () => {
  assert.equal(MIN_TREND_DISTINCT_CREATORS, 3);
  const actionable = feed.trends.find(isActionableSocialTrend);
  assert.ok(actionable?.referencePost);
  assert.ok(actionable.reuseEvidence);
  assert.equal(isVerifiedMultiCreatorTrend(actionable), true);

  const uniqueUrls = new Set(
    actionable.reuseEvidence.posts.map((post) => {
      const url = new URL(post.url);
      return `${post.platform}:${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    }),
  );
  const distinctCreators = new Set(
    actionable.reuseEvidence.posts.map((post) =>
      post.author.normalize("NFKC").trim().replace(/^@+/, "").toLocaleLowerCase("fr")
    ),
  );
  assert.equal(uniqueUrls.size, actionable.reuseEvidence.posts.length);
  assert.ok(distinctCreators.size >= MIN_TREND_DISTINCT_CREATORS);

  const withoutProof = structuredClone(actionable);
  withoutProof.reuseEvidence = null;
  assert.equal(isVerifiedMultiCreatorTrend(withoutProof), false);
  assert.equal(isActionableSocialTrend(withoutProof), false);

  const duplicateCreator = structuredClone(actionable);
  duplicateCreator.reuseEvidence.posts = duplicateCreator.reuseEvidence.posts.slice(0, 3);
  duplicateCreator.reuseEvidence.posts[1].author =
    ` @${duplicateCreator.reuseEvidence.posts[0].author.replace(/^@+/, "").toUpperCase()} `;
  duplicateCreator.reuseEvidence.posts[2].author = duplicateCreator.reuseEvidence.posts[0].author;
  assert.equal(isVerifiedMultiCreatorTrend(duplicateCreator), false);

  const duplicateNativePost = structuredClone(actionable);
  duplicateNativePost.reuseEvidence.posts[1] = {
    ...duplicateNativePost.reuseEvidence.posts[1],
    platform: duplicateNativePost.reuseEvidence.posts[0].platform,
    url: `${duplicateNativePost.reuseEvidence.posts[0].url}?utm_source=duplicate`,
  };
  assert.equal(isVerifiedMultiCreatorTrend(duplicateNativePost), false);

  const withoutReferenceInProof = structuredClone(actionable);
  withoutReferenceInProof.reuseEvidence.posts =
    withoutReferenceInProof.reuseEvidence.posts.filter(
      (post) => post.url !== withoutReferenceInProof.referencePost.url,
    );
  assert.equal(isVerifiedMultiCreatorTrend(withoutReferenceInProof), false);
});

test("the v6 refresh proof is internally consistent and nullable outside GitHub", () => {
  assert.equal(feed.refresh.cadenceHours, TREND_REFRESH_CADENCE_HOURS);
  assert.ok(feed.refresh.sourceChecks.every((check) =>
    Date.parse(check.checkedAt) >= Date.parse(feed.refresh.lastAttemptAt) &&
    Date.parse(check.checkedAt) <= Date.parse(feed.capturedAt)
  ));

  const withoutRunUrl = structuredClone(feed);
  withoutRunUrl.refresh.runUrl = null;
  assert.equal(assertSocialTrendFeed(withoutRunUrl), withoutRunUrl);

  const invalidRunUrl = structuredClone(feed);
  invalidRunUrl.refresh.runUrl = "not-a-run-url";
  assert.throws(() => assertSocialTrendFeed(invalidRunUrl), /snapshot trends invalide/i);

  const invalidCheckedCount = structuredClone(feed);
  invalidCheckedCount.refresh.counts.checkedSources += 1;
  assert.throws(() => assertSocialTrendFeed(invalidCheckedCount), /compteurs/i);

  const duplicateCheck = structuredClone(feed);
  assert.ok(duplicateCheck.refresh.sourceChecks.length >= 2);
  duplicateCheck.refresh.sourceChecks[1].id = duplicateCheck.refresh.sourceChecks[0].id;
  assert.throws(() => assertSocialTrendFeed(duplicateCheck), /source trends invalide/i);
});

test("the publishable contract requires a fresh daily run and 50 verified trends", () => {
  const publishableFeed = freshPublishableFixture();
  assert.equal(
    assertPublishableSocialTrendFeed(publishableFeed, {
      now: shortlyAfterCapture(publishableFeed),
    }),
    publishableFeed,
  );

  const staleNow = new Date(
    Date.parse(publishableFeed.capturedAt) +
      TREND_PUBLISH_MAX_AGE_HOURS * 60 * 60 * 1_000 +
      1,
  );
  assert.throws(
    () => assertPublishableSocialTrendFeed(publishableFeed, { now: staleNow }),
    /fra|26 h/i,
  );

  const degraded = structuredClone(publishableFeed);
  degraded.refresh.status = "degraded";
  assert.throws(
    () => assertPublishableSocialTrendFeed(degraded, { now: shortlyAfterCapture(degraded) }),
    /pas complet/i,
  );

  const tooSmall = structuredClone(publishableFeed);
  const actionable = tooSmall.trends.filter(isActionableSocialTrend);
  for (const trend of actionable.slice(MIN_PUBLISHABLE_ACTIONABLE_TRENDS - 1)) {
    trend.lofiFitScore = 0;
  }
  syncRefreshCounts(tooSmall);
  assert.throws(
    () => assertPublishableSocialTrendFeed(tooSmall, { now: shortlyAfterCapture(tooSmall) }),
    /50 trends/i,
  );

  const tooFewVideos = structuredClone(publishableFeed);
  const videosToDowngrade = tooFewVideos.trends
    .filter((trend) =>
      isActionableSocialTrend(trend) && trend.referencePost?.mediaType === "video")
    .slice(MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS - 1);
  assert.ok(videosToDowngrade.length > 0);
  for (const downgradedVideo of videosToDowngrade) {
    downgradedVideo.referencePost.mediaType = "image";
    downgradedVideo.referencePost.durationSeconds = null;
  }
  syncRefreshCounts(tooFewVideos);
  const remainingVideos = tooFewVideos.trends.filter(
    (trend) => isActionableSocialTrend(trend) && trend.referencePost?.mediaType === "video",
  );
  assert.equal(
    remainingVideos.length,
    MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS - 1,
  );
  assert.ok(
    remainingVideos.reduce((total, trend) => total + trend.proposals.length, 0) >=
      MIN_PUBLISHABLE_VIDEO_PROPOSALS,
    "the regression fixture must still clear the old proposal-only guard",
  );
  assert.throws(
    () => assertPublishableSocialTrendFeed(tooFewVideos, {
      now: shortlyAfterCapture(tooFewVideos),
    }),
    /50 trends vidéo/i,
  );
});

test("the top 50 videos are Girl-first while keeping real priority scores unchanged", () => {
  const actionable = feed.trends.filter(
    (trend) => isActionableSocialTrend(trend) && trend.referencePost?.mediaType === "video",
  );
  const scoresBefore = new Map(
    actionable.map((trend) => [trend.id, trendPriorityScore(trend)]),
  );
  const selected = selectGirlFirstSocialTrends(
    actionable,
    MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
  );
  const girls = selected.filter((trend) => trend.character === "lofi-girl");
  const boys = selected.filter((trend) => trend.character === "lofi-boy");

  assert.equal(selected.length, MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS);
  assert.ok(girls.length / selected.length >= MIN_PUBLISHABLE_LOFI_GIRL_SHARE);
  assert.equal(selected[0].character, "lofi-girl");
  if (boys.length > 0) {
    assert.equal(selected.slice(0, 5).filter((trend) => trend.character === "lofi-girl").length, 4);
    assert.equal(selected[4].character, "lofi-boy");
  }
  for (const character of ["lofi-girl", "lofi-boy"]) {
    const universe = selected.filter((trend) => trend.character === character);
    assert.ok(
      universe.every(
        (trend, index) =>
          index === 0 ||
          trendPriorityScore(universe[index - 1]) >= trendPriorityScore(trend),
      ),
      `${character} must keep its internal score order`,
    );
  }
  assert.ok(
    selected.every(
      (trend) => scoresBefore.get(trend.id) === trendPriorityScore(trend),
    ),
    "Girl-first selection must not mutate or inflate any score",
  );
});

test("publishable validation rejects a Girl-minority top, stale cards and duplicate native references", () => {
  const publishableFeed = freshPublishableFixture();
  const tooFewGirls = structuredClone(publishableFeed);
  const girlActionables = tooFewGirls.trends.filter(
    (trend) =>
      trend.character === "lofi-girl" && isActionableSocialTrend(trend),
  );
  const maximumGirlsBelowThreshold =
    Math.ceil(MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS * MIN_PUBLISHABLE_LOFI_GIRL_SHARE) - 1;
  for (const trend of girlActionables.slice(maximumGirlsBelowThreshold)) {
    trend.character = "lofi-boy";
  }
  syncRefreshCounts(tooFewGirls);
  assert.throws(
    () => assertPublishableSocialTrendFeed(tooFewGirls, { now: shortlyAfterCapture(tooFewGirls) }),
    /80 % de Lofi Girl/i,
  );

  const staleCard = structuredClone(publishableFeed);
  const staleTrend = staleCard.trends.find(
    (trend) =>
      trend.lifecycle !== "steady" && isActionableSocialTrend(trend),
  );
  assert.ok(staleTrend?.referencePost);
  const staleVerifiedAt = new Date(
    Date.parse(staleCard.capturedAt) -
      (TREND_ACTIVE_MAX_VERIFICATION_AGE_HOURS + 1) * 60 * 60 * 1_000,
  ).toISOString();
  staleTrend.firstSeenAt = new Date(
    Date.parse(staleVerifiedAt) - 24 * 60 * 60 * 1_000,
  ).toISOString();
  staleTrend.lastVerifiedAt = staleVerifiedAt;
  staleTrend.referencePost.capturedAt = staleVerifiedAt;
  staleTrend.reuseEvidence.verifiedAt = staleVerifiedAt;
  for (const post of staleTrend.reuseEvidence.posts) {
    post.capturedAt = staleVerifiedAt;
  }
  for (const observation of staleTrend.observations) {
    observation.observedAt = staleVerifiedAt;
  }
  assert.equal(assertSocialTrendFeed(staleCard), staleCard);
  assert.throws(
    () => assertPublishableSocialTrendFeed(staleCard, { now: shortlyAfterCapture(staleCard) }),
    /trop ancienne|72 h/i,
  );

  const steadyBoundary = structuredClone(publishableFeed);
  const steadyTrend = steadyBoundary.trends.find(
    (trend) =>
      trend.lifecycle === "steady" && isActionableSocialTrend(trend),
  );
  assert.ok(steadyTrend?.referencePost);
  const steadyNow = shortlyAfterCapture(steadyBoundary);
  const steadyVerifiedAt = new Date(
    steadyNow.getTime() -
      TREND_STEADY_MAX_VERIFICATION_AGE_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  steadyTrend.firstSeenAt = new Date(
    Date.parse(steadyVerifiedAt) - 24 * 60 * 60 * 1_000,
  ).toISOString();
  steadyTrend.lastVerifiedAt = steadyVerifiedAt;
  steadyTrend.referencePost.capturedAt = steadyVerifiedAt;
  steadyTrend.reuseEvidence.verifiedAt = steadyVerifiedAt;
  for (const post of steadyTrend.reuseEvidence.posts) {
    post.capturedAt = steadyVerifiedAt;
  }
  for (const observation of steadyTrend.observations) {
    observation.observedAt = steadyVerifiedAt;
  }
  assert.equal(
    assertPublishableSocialTrendFeed(steadyBoundary, { now: steadyNow }),
    steadyBoundary,
  );

  const expiredSteady = structuredClone(steadyBoundary);
  const expiredSteadyTrend = expiredSteady.trends.find(
    (trend) => trend.id === steadyTrend.id,
  );
  assert.ok(expiredSteadyTrend?.referencePost);
  const expiredAt = new Date(Date.parse(steadyVerifiedAt) - 1).toISOString();
  expiredSteadyTrend.firstSeenAt = new Date(
    Date.parse(expiredAt) - 24 * 60 * 60 * 1_000,
  ).toISOString();
  expiredSteadyTrend.lastVerifiedAt = expiredAt;
  expiredSteadyTrend.referencePost.capturedAt = expiredAt;
  expiredSteadyTrend.reuseEvidence.verifiedAt = expiredAt;
  for (const post of expiredSteadyTrend.reuseEvidence.posts) {
    post.capturedAt = expiredAt;
  }
  for (const observation of expiredSteadyTrend.observations) {
    observation.observedAt = expiredAt;
  }
  assert.throws(
    () => assertPublishableSocialTrendFeed(expiredSteady, { now: steadyNow }),
    /trop ancienne|336 h/i,
  );

  const duplicateReference = structuredClone(publishableFeed);
  const samePlatformPair = duplicateReference.trends
    .filter(isActionableSocialTrend)
    .map((trend, index, trends) => [
      trend,
      trends.slice(index + 1).find(
        (candidate) =>
          candidate.referencePost.platform === trend.referencePost.platform,
      ),
    ])
    .find((pair) => pair[1]);
  assert.ok(samePlatformPair);
  const duplicatedTrend = samePlatformPair[1];
  const previousReferenceUrl = duplicatedTrend.referencePost.url;
  samePlatformPair[1].referencePost.url = `${samePlatformPair[0].referencePost.url}?utm_source=duplicate`;
  const reuseReference = duplicatedTrend.reuseEvidence.posts.find(
    (post) => post.url === previousReferenceUrl,
  );
  assert.ok(reuseReference);
  reuseReference.url = duplicatedTrend.referencePost.url;
  assert.equal(assertSocialTrendFeed(duplicateReference), duplicateReference);
  assert.throws(
    () => assertPublishableSocialTrendFeed(duplicateReference, { now: shortlyAfterCapture(duplicateReference) }),
    /dupliqu/i,
  );
});

test("v6 validation rejects duplicate trend keys and future trend observations", () => {
  const duplicateTrendKey = structuredClone(feed);
  duplicateTrendKey.trends[1].trendKey = duplicateTrendKey.trends[0].trendKey.toUpperCase();
  assert.throws(() => assertSocialTrendFeed(duplicateTrendKey), /cl.*trend.*dupliqu/i);

  const futureObservation = structuredClone(feed);
  futureObservation.trends[0].observations[0].observedAt = "2100-01-01T00:00:00.000Z";
  assert.throws(() => assertSocialTrendFeed(futureObservation), /observation invalide/i);
});

test("runtime validation rejects an unknown lifecycle and an unverifiable source", () => {
  assert.throws(() => assertSocialTrendFeed(null), /snapshot trends invalide/i);

  const invalidLifecycle = structuredClone(feed);
  invalidLifecycle.trends[0].lifecycle = "viral-ish";
  assert.throws(() => assertSocialTrendFeed(invalidLifecycle), /invalide/i);

  const invalidSource = structuredClone(feed);
  invalidSource.trends[0].observations[0].sourceUrl = "not-a-source";
  assert.throws(() => assertSocialTrendFeed(invalidSource), /observation invalide/i);

  const invalidCharacter = structuredClone(feed);
  invalidCharacter.trends[0].character = "lofi-cat";
  assert.throws(() => assertSocialTrendFeed(invalidCharacter), /invalide/i);

  const missingTerritory = structuredClone(feed);
  missingTerritory.trends[0].territory = "";
  assert.throws(() => assertSocialTrendFeed(missingTerritory), /invalide/i);
});

test("reference posts reject a foreign domain, an incoherent platform and a future capture", () => {
  const invalidDomain = cloneWithFirstReferencePost();
  invalidDomain.referencePost.url = "https://example.com/reel/not-a-platform-post";
  assert.throws(
    () => assertSocialTrendFeed(invalidDomain.snapshot),
    /Post de référence invalide/i,
  );

  const invalidPlatform = cloneWithFirstReferencePost();
  invalidPlatform.referencePost.platform = "threads";
  assert.throws(
    () => assertSocialTrendFeed(invalidPlatform.snapshot),
    /Post de référence invalide/i,
  );

  const futureCapture = cloneWithFirstReferencePost();
  futureCapture.referencePost.capturedAt = "2100-01-01T00:00:00.000Z";
  assert.throws(
    () => assertSocialTrendFeed(futureCapture.snapshot),
    /Post de référence invalide/i,
  );
});

test("reference posts reject negative or editorially inferred metrics", () => {
  const negativeMetric = cloneWithFirstReferencePost();
  negativeMetric.referencePost.metrics.likes = -1;
  assert.throws(
    () => assertSocialTrendFeed(negativeMetric.snapshot),
    /Post de référence invalide/i,
  );

  const editorialMetric = cloneWithFirstReferencePost();
  editorialMetric.referencePost.exactness = "editorial-observation";
  editorialMetric.referencePost.metrics = {
    views: 1,
    likes: null,
    comments: null,
    shares: null,
  };
  assert.throws(
    () => assertSocialTrendFeed(editorialMetric.snapshot),
    /Post de référence invalide/i,
  );
});

test("video references enforce 50,000 likes and a verified duration under 30 seconds", () => {
  const belowThreshold = cloneWithFirstVideoReferencePost();
  belowThreshold.referencePost.metrics.likes = MIN_TREND_VIDEO_LIKES - 1;
  assert.throws(
    () => assertSocialTrendFeed(belowThreshold.snapshot),
    /Post de référence invalide/i,
  );

  const missingLikes = cloneWithFirstVideoReferencePost();
  missingLikes.referencePost.metrics.likes = null;
  assert.throws(
    () => assertSocialTrendFeed(missingLikes.snapshot),
    /Post de référence invalide/i,
  );

  for (const invalidDuration of [null, 0, 30, 30.001, Number.POSITIVE_INFINITY]) {
    const invalid = cloneWithFirstVideoReferencePost();
    invalid.referencePost.durationSeconds = invalidDuration;
    assert.throws(
      () => assertSocialTrendFeed(invalid.snapshot),
      /Post de référence invalide/i,
    );
  }

  const justBelowLimit = cloneWithFirstVideoReferencePost();
  justBelowLimit.referencePost.durationSeconds = 29.999;
  assert.equal(assertSocialTrendFeed(justBelowLimit.snapshot), justBelowLimit.snapshot);

  const durationOnImage = cloneWithFirstNonVideoReferencePost();
  durationOnImage.referencePost.durationSeconds = 12;
  assert.throws(
    () => assertSocialTrendFeed(durationOnImage.snapshot),
    /Post de référence invalide/i,
  );
});

test("ranking and feed filters surface the strongest opportunities by platform and universe", () => {
  const ranked = rankSocialTrends(feed.trends);
  assert.ok(trendPriorityScore(ranked[0]) >= trendPriorityScore(ranked.at(-1)));
  assert.ok(ranked.every((trend) => trendPriorityScore(trend) >= 0));

  const instagram = filterSocialTrends(feed.trends, { platform: "instagram" });
  assert.ok(instagram.length > 0);
  assert.ok(instagram.every((trend) => trend.referencePost?.platform === "instagram"));

  for (const platform of ["instagram", "tiktok", "youtube", "x"]) {
    const platformTrends = filterSocialTrends(feed.trends, { platform });
    assert.ok(
      platformTrends.every((trend) => trend.referencePost?.platform === platform),
      `the ${platform} filter must never render another platform's reference post`,
    );
  }

  const lofiBoy = filterSocialTrends(feed.trends, { character: "lofi-boy" });
  assert.equal(
    lofiBoy.length,
    feed.trends.filter((trend) => trend.character === "lofi-boy").length,
  );
  assert.ok(lofiBoy.length > 0);
  assert.ok(lofiBoy.every((trend) => trend.character === "lofi-boy"));

  const priorities = filterSocialTrends(feed.trends, { lifecycle: "priority" });
  assert.ok(priorities.length > 0);
  assert.ok(priorities.length < feed.trends.length);
  assert.ok(
    priorities.every(
      (trend) => trendPriorityScore(trend) >= TREND_PRIORITY_THRESHOLD,
    ),
  );
});
