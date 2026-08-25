import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditTrendReuseEvidenceReachability,
  buildDailyTrendRefresh,
  countMatchedSignals,
  extractNativeTrendCandidateUrls,
  localDateKey,
  nativeTrendVerificationRequest,
  normalizeSourceText,
  verifyNativeTrendPost,
} from "../scripts/refresh-social-trends.mjs";
import {
  assertPublishableSocialTrendFeed,
  isActionableSocialTrend,
  MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
} from "../lib/social-trends.ts";

const feed = JSON.parse(
  await readFile(new URL("../data/trends/feed.json", import.meta.url), "utf8"),
);
const watchlists = JSON.parse(
  await readFile(new URL("../data/trends/watchlists.json", import.meta.url), "utf8"),
);

const nativeCandidateUrls = [
  ...Array.from({ length: 20 }, (_, index) =>
    `https://www.tiktok.com/@radar${index}/video/${770000000000000000n + BigInt(index)}`),
  ...Array.from({ length: 15 }, (_, index) =>
    `https://www.instagram.com/reel/RadarCandidate${String(index).padStart(2, "0")}/`),
  ...Array.from({ length: 15 }, (_, index) =>
    `https://www.youtube.com/shorts/radar${String(index).padStart(6, "0")}`),
  ...Array.from({ length: 10 }, (_, index) =>
    `https://x.com/radar${index}/status/${2100000000000000000n + BigInt(index)}`),
];

const actionableTrendTerms = feed.trends
  .filter(isActionableSocialTrend)
  .flatMap((trend) => [trend.title, ...trend.keywords])
  .join(" ");

function successfulSourceFetch(url) {
  const source = watchlists.sources.find((candidate) => candidate.url === url);
  if (!source) {
    const decoded = decodeURIComponent(url);
    const marker = feed.trends
      .flatMap((trend) => trend.reuseEvidence?.posts ?? [])
      .map((post) => nativeTrendVerificationRequest(post).marker)
      .find((candidate) => decoded.includes(candidate));
    assert.ok(marker, `unexpected source ${url}`);
    return Promise.resolve(new Response(
      `<html><body>${marker}</body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    ));
  }
  if (source.kind === "x-api") {
    return Promise.resolve(Response.json({
      data: [{ trend_name: actionableTrendTerms }],
    }));
  }
  return Promise.resolve(new Response(
    `<html><body>${source.requiredMarkers.join(" ")} ${actionableTrendTerms} ${nativeCandidateUrls.join(" ")}</body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  ));
}

test("source text normalization and matching are deterministic", () => {
  assert.equal(normalizeSourceText("<h1>ÉTUDES&nbsp;&amp; Focus</h1>"), "etudes & focus");
  const actionable = feed.trends.filter(isActionableSocialTrend);
  assert.ok(countMatchedSignals(actionable[0].title, actionable) >= 1);
});

test("native candidate extraction deduplicates posts and excludes non-post URLs", () => {
  const candidates = extractNativeTrendCandidateUrls(`
    https://www.tiktok.com/@study/video/770000000000000001?is_from_webapp=1
    https://www.tiktok.com/@study/video/770000000000000001
    https://www.tiktok.com/@study https://www.tiktok.com/tag/study
    https://www.instagram.com/reels/RadarCandidate00/?igsh=share
    https://www.instagram.com/share/reel/abc
    https://www.youtube.com/watch?v=radar000000 https://www.youtube.com/embed/radar000000
    https://twitter.com/radar/status/2100000000000000001?s=20
  `);
  assert.deepEqual(candidates, [
    "https://www.instagram.com/reel/RadarCandidate00/",
    "https://www.tiktok.com/@study/video/770000000000000001",
    "https://www.youtube.com/watch?v=radar000000",
    "https://x.com/radar/status/2100000000000000001",
  ]);
});

test("native post verification uses platform-owned endpoints and rejects identity drift", async () => {
  const posts = feed.trends
    .flatMap((trend) => trend.reuseEvidence?.posts ?? [])
    .filter((post, index, all) =>
      all.findIndex((candidate) => candidate.platform === post.platform) === index,
    );
  for (const post of posts) {
    const request = nativeTrendVerificationRequest(post);
    assert.match(request.url, /^https:\/\//);
    assert.ok(request.marker.length >= 5);
    await verifyNativeTrendPost(post, {
      fetchImpl: async () => new Response(request.marker, { status: 200 }),
    });
    await assert.rejects(
      verifyNativeTrendPost(post, {
        fetchImpl: async () => new Response("different post", { status: 200 }),
      }),
      /identité du post absente/i,
    );
  }
});

test("a real parsed-source run refreshes metadata without altering native metrics", async () => {
  const originalReferences = feed.trends.map((trend) => trend.referencePost);
  const originalSemanticProofs = structuredClone(feed.trends.map((trend) => ({
    lastVerifiedAt: trend.lastVerifiedAt,
    reuseEvidence: trend.reuseEvidence,
  })));
  const now = new Date(Date.parse(feed.capturedAt) + 4 * 24 * 60 * 60 * 1_000).toISOString();
  const result = await buildDailyTrendRefresh({
    feed,
    watchlists,
    now,
    force: true,
    fetchImpl: successfulSourceFetch,
    xBearerToken: "test-token",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.feed.capturedAt, now);
  assert.equal(result.feed.refresh.status, "success");
  assert.equal(result.feed.refresh.lastSuccessfulAt, now);
  assert.equal(result.feed.refresh.sourceChecks.length, watchlists.sources.length);
  assert.equal(result.feed.refresh.counts.checkedSources, watchlists.sources.length);
  assert.ok(result.feed.refresh.counts.matchedSignals > 0);
  assert.ok(result.feed.refresh.counts.actionable >= 50);
  assert.ok(result.feed.refresh.counts.lofiGirl >= 40);
  assert.equal(result.feed.refresh.discoveryAudit.scannedAt, now);
  assert.ok(result.feed.refresh.discoveryAudit.candidateCount >= 50);
  assert.ok(result.feed.refresh.discoveryAudit.qualifiedInventoryCount >= 50);
  assert.equal(
    result.feed.refresh.discoveryAudit.currentMatchedCount,
    result.feed.refresh.counts.actionable,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.qualifiedInventoryCount,
    result.feed.refresh.discoveryAudit.currentMatchedCount,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.availablePosts,
    feed.trends
      .filter(isActionableSocialTrend)
      .reduce((total, trend) => total + trend.reuseEvidence.posts.length, 0),
  );
  assert.equal(result.feed.refresh.discoveryAudit.unavailablePosts, 0);
  assert.equal(
    result.feed.refresh.discoveryAudit.candidateUrls.length,
    nativeCandidateUrls.length,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.added + result.feed.refresh.discoveryAudit.retained,
    result.feed.refresh.discoveryAudit.candidateCount,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.sourceBreakdown.length,
    watchlists.sources.length,
  );
  const actionableVideos = result.feed.trends.filter(
    (trend) => isActionableSocialTrend(trend) && trend.referencePost?.mediaType === "video",
  );
  assert.ok(actionableVideos.length >= MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS);
  assert.equal(new Set(actionableVideos.map((trend) => trend.id)).size, actionableVideos.length);
  assert.equal(
    new Set(
      actionableVideos.map((trend) => trend.trendKey.trim().toLocaleLowerCase("fr")),
    ).size,
    actionableVideos.length,
  );
  assert.equal(
    new Set(actionableVideos.map((trend) => trend.referencePost.url)).size,
    actionableVideos.length,
  );
  assert.deepEqual(
    result.feed.trends.map((trend) => trend.referencePost),
    originalReferences,
    "an editorial source check must never rewrite native post metrics",
  );
  assert.deepEqual(
    result.feed.trends.map((trend) => ({
      lastVerifiedAt: trend.lastVerifiedAt,
      reuseEvidence: trend.reuseEvidence,
    })),
    originalSemanticProofs,
    "reachability and discovery scans must not fabricate semantic proof freshness",
  );
  assert.throws(() => assertPublishableSocialTrendFeed(result.feed, { now }), /trop ancienne|72 h/i);
  assert.equal(
    assertPublishableSocialTrendFeed(result.feed, {
      now,
      allowStaleSemanticEvidence: true,
    }),
    result.feed,
  );
});

test("reachability auditing is read-only", async () => {
  const actionable = structuredClone(feed.trends.filter(isActionableSocialTrend));
  const before = structuredClone(actionable);
  const audit = await auditTrendReuseEvidenceReachability(actionable, {
    now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
    fetchImpl: successfulSourceFetch,
  });
  assert.equal(audit.availablePosts, audit.checkedPosts);
  assert.equal(audit.unavailablePosts, 0);
  assert.deepEqual(
    [...audit.availableTrendIds].sort(),
    actionable.map((trend) => trend.id).sort(),
  );
  assert.deepEqual(actionable, before);
});

test("the daily publisher fails closed when too few sources parse", async () => {
  await assert.rejects(
    buildDailyTrendRefresh({
      feed,
      watchlists,
      now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
      force: true,
      fetchImpl: async () => new Response("blocked", { status: 503 }),
    }),
    /sources Trends ont été parsées/i,
  );
});

test("the daily publisher rejects a parsed scan without a native candidate pool", async () => {
  const now = new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString();
  const oneCandidate = nativeCandidateUrls[0];

  await assert.rejects(
    buildDailyTrendRefresh({
      feed,
      watchlists,
      now,
      force: true,
      fetchImpl: (url) => {
        const source = watchlists.sources.find((candidate) => candidate.url === url);
        if (!source) return successfulSourceFetch(url);
        if (source.kind === "x-api") {
          return Promise.resolve(Response.json({ data: [{ trend_name: actionableTrendTerms }] }));
        }
        return Promise.resolve(new Response(
          `${source.requiredMarkers.join(" ")} ${actionableTrendTerms} ${oneCandidate}`,
          { status: 200 },
        ));
      },
      xBearerToken: "test-token",
    }),
    /1 URLs candidates natives.*minimum 50/i,
  );
});

test("the daily publisher rejects a large candidate pool that matches fewer than 50 current trends", async () => {
  const limitedDiscoveryText = feed.trends.find(isActionableSocialTrend).title;

  await assert.rejects(
    buildDailyTrendRefresh({
      feed,
      watchlists,
      now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
      force: true,
      fetchImpl: (url) => {
        const source = watchlists.sources.find((candidate) => candidate.url === url);
        if (!source) return successfulSourceFetch(url);
        if (source.kind === "x-api") {
          return Promise.resolve(Response.json({
            data: [{ trend_name: limitedDiscoveryText }],
          }));
        }
        return Promise.resolve(new Response(
          `${source.requiredMarkers.join(" ")} ${limitedDiscoveryText} ${nativeCandidateUrls.join(" ")}`,
          { status: 200 },
        ));
      },
      xBearerToken: "test-token",
    }),
    (error) => {
      assert.match(error.message, /trends.*reprises natives accessibles.*minimum 50/i);
      assert.ok(error.refreshStatus.discoveryAudit.candidateCount >= 50);
      assert.ok(error.refreshStatus.discoveryAudit.currentMatchedCount < 50);
      assert.equal(
        error.refreshStatus.discoveryAudit.qualifiedInventoryCount,
        error.refreshStatus.discoveryAudit.currentMatchedCount,
      );
      return true;
    },
  );
});

test("the daily publisher fails closed when fewer than 50 evidence sets remain reachable", async () => {
  const actionable = feed.trends.filter(isActionableSocialTrend);
  const unavailableMarkers = actionable
    .slice(0, 2)
    .flatMap((trend) => trend.reuseEvidence.posts)
    .map((post) => nativeTrendVerificationRequest(post).marker);

  await assert.rejects(
    buildDailyTrendRefresh({
      feed,
      watchlists,
      now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
      force: true,
      fetchImpl: (url) => unavailableMarkers.some((marker) => decodeURIComponent(url).includes(marker))
        ? Promise.resolve(new Response("missing", { status: 404 }))
        : successfulSourceFetch(url),
      xBearerToken: "test-token",
    }),
    /49\/51 trends.*reprises natives accessibles.*minimum 50/i,
  );
});

test("the retry slot skips paid or remote work after a success on the same Paris day", async () => {
  let fetchCount = 0;
  const result = await buildDailyTrendRefresh({
    feed,
    watchlists,
    now: feed.refresh.lastSuccessfulAt,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(fetchCount, 0);
  assert.equal(
    localDateKey(result.feed.refresh.lastSuccessfulAt),
    localDateKey(feed.refresh.lastSuccessfulAt),
  );
});
