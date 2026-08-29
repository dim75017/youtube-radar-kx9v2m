import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditNativeTrendCandidateReachability,
  auditTrendReuseEvidenceReachability,
  buildDailyTrendRefresh,
  countMatchedSignals,
  extractNativeTrendCandidateUrls,
  extractYouTubeShortSearchResults,
  localDateKey,
  mergeTrendCandidateObservations,
  nativeTrendVerificationRequest,
  normalizeSourceText,
  parseTikTokTrendCandidateHtml,
  parseYouTubeShortMetadataHtml,
  verifyNativeTrendPost,
} from "../scripts/refresh-social-trends.mjs";
import {
  assertPublishableSocialTrendFeed,
  isActionableSocialTrend,
  isQualifiedTrendReferencePost,
  isVerifiedMultiCreatorTrend,
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

const promotionReferenceUrl =
  "https://www.tiktok.com/@hope_schwing/video/7667660831471045918";
const promotionYouTubeEvidence = [
  {
    videoId: "qNv0ZejUZ6c",
    title: "Me at the same age as my parents",
    author: "Retro Gamer Lofi",
    durationSeconds: 35,
  },
  {
    videoId: "hNLAS7NkKTM",
    title: "Me vs My Parents at the Same Age 😂 #shorts",
    author: "BuzzQuil",
    durationSeconds: 40,
  },
];

const actionableTrendTerms = feed.trends
  .filter(isActionableSocialTrend)
  .flatMap((trend) => [trend.title, ...trend.keywords])
  .join(" ");

function tiktokHydrationFixture(candidateUrl, options = {}) {
  const match = candidateUrl.match(/https:\/\/www\.tiktok\.com\/@([^/]+)\/video\/(\d+)/u);
  assert.ok(match, `invalid TikTok fixture URL ${candidateUrl}`);
  const [, author, videoId] = match;
  const isPromotionReference = candidateUrl === promotionReferenceUrl;
  const isAutomaticMusicCluster = options.enableAutomaticCluster !== false &&
    /^radar[0-2]$/u.test(author);
  const isAutomaticMusicReference = author === "radar0";
  const itemStruct = {
    id: videoId,
    desc: isPromotionReference
      ? "Bro I was 9 years old when my mom was this age LMAO"
      : `Candidate ${videoId}`,
    createTime: "1785266428",
    author: { uniqueId: author },
    music: {
      id: isPromotionReference
        ? "6696414028652087298"
        : isAutomaticMusicCluster
          ? "7777777777777777777"
          : videoId,
      title: isPromotionReference
        ? "Hey Baby (Drop It to the Floor) (feat. T-Pain)"
        : isAutomaticMusicCluster
          ? "Focus Bell"
          : `Unique sound ${videoId}`,
      authorName: isPromotionReference
        ? "Pitbull"
        : isAutomaticMusicCluster
          ? "Public Sound Creator"
          : author,
    },
    video: {
      duration: isPromotionReference ? 6 : 12,
      cover: `https://p16-sign.tiktokcdn.com/${videoId}.jpeg`,
    },
    stats: {
      playCount: isPromotionReference ? 1_000_000 : isAutomaticMusicReference ? 800_000 : 10_000,
      diggCount: isPromotionReference ? 182_000 : isAutomaticMusicReference ? 90_000 : 500,
      commentCount: isPromotionReference ? 354 : 2,
      shareCount: isPromotionReference ? 3_367 : 1,
    },
  };
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": { itemInfo: { itemStruct } },
    },
  })}</script>`;
}

function youtubeSearchFixture() {
  return `<script>var ytInitialData = ${JSON.stringify({
    results: promotionYouTubeEvidence.map((video) => ({
      shortsLockupViewModel: {
        onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: video.videoId } } },
        overlayMetadata: { primaryText: { content: video.title } },
      },
    })),
  })};</script>`;
}

function youtubeMetadataFixture(video) {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: {
      videoId: video.videoId,
      title: video.title,
      author: video.author,
      lengthSeconds: String(video.durationSeconds),
      viewCount: "120000",
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg` }] },
    },
    microformat: {
      playerMicroformatRenderer: { uploadDate: "2026-08-20T12:00:00Z" },
    },
  })};</script>{"likeCount":"1234"}`;
}

function successfulSourceFetch(url) {
  const source = watchlists.sources.find((candidate) => candidate.url === url);
  if (!source) {
    if (/^https:\/\/www\.youtube\.com\/results\?/u.test(url)) {
      return Promise.resolve(new Response(youtubeSearchFixture(), { status: 200 }));
    }
    const youtubeEvidence = promotionYouTubeEvidence.find((video) =>
      url === `https://www.youtube.com/shorts/${video.videoId}`);
    if (youtubeEvidence) {
      return Promise.resolve(new Response(youtubeMetadataFixture(youtubeEvidence), { status: 200 }));
    }
    if (/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/u.test(url)) {
      return Promise.resolve(new Response(tiktokHydrationFixture(url), { status: 200 }));
    }
    const decoded = decodeURIComponent(url);
    const marker = [
      ...feed.trends
        .flatMap((trend) => trend.reuseEvidence?.posts ?? [])
        .map((post) => nativeTrendVerificationRequest(post).marker),
      ...nativeCandidateUrls.map((candidateUrl) => nativeTrendVerificationRequest({
        platform: candidateUrl.includes("tiktok.com")
          ? "tiktok"
          : candidateUrl.includes("instagram.com")
            ? "instagram"
            : candidateUrl.includes("youtube.com")
              ? "youtube"
              : "x",
        url: candidateUrl,
      }).marker),
      ...promotionYouTubeEvidence.map((video) => video.videoId),
      nativeTrendVerificationRequest({
        platform: "tiktok",
        url: promotionReferenceUrl,
      }).marker,
    ]
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
    `<html><body>${source.requiredMarkers.join(" ")} ${actionableTrendTerms} ${nativeCandidateUrls.join(" ")} ${promotionReferenceUrl}</body></html>`,
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

test("public TikTok and YouTube pages expose exact candidate metadata without playback", () => {
  const capturedAt = "2026-08-23T12:00:00Z";
  const tiktok = parseTikTokTrendCandidateHtml(
    tiktokHydrationFixture(promotionReferenceUrl),
    promotionReferenceUrl,
    capturedAt,
  );
  assert.equal(tiktok.author, "@hope_schwing");
  assert.equal(tiktok.music.id, "6696414028652087298");
  assert.equal(tiktok.durationSeconds, 6);
  assert.equal(tiktok.metrics.likes, 182_000);

  const searchResults = extractYouTubeShortSearchResults(youtubeSearchFixture());
  assert.deepEqual(
    searchResults.map((result) => result.videoId),
    promotionYouTubeEvidence.map((video) => video.videoId),
  );
  const youtube = parseYouTubeShortMetadataHtml(
    youtubeMetadataFixture(promotionYouTubeEvidence[0]),
    `https://www.youtube.com/shorts/${promotionYouTubeEvidence[0].videoId}`,
    capturedAt,
  );
  assert.equal(youtube.author, "Retro Gamer Lofi");
  assert.equal(youtube.durationSeconds, 35);
  assert.equal(youtube.metrics.views, 120_000);
});

test("candidate observations persist across a failed run without advancing old timestamps", () => {
  const previous = [{
    ...parseTikTokTrendCandidateHtml(
      tiktokHydrationFixture(nativeCandidateUrls[3]),
      nativeCandidateUrls[3],
      "2026-08-20T10:00:00Z",
    ),
    firstObservedAt: "2026-08-20T10:00:00Z",
    lastObservedAt: "2026-08-20T10:00:00Z",
  }];
  const current = [parseTikTokTrendCandidateHtml(
    tiktokHydrationFixture(nativeCandidateUrls[4]),
    nativeCandidateUrls[4],
    "2026-08-21T10:00:00Z",
  )];
  const merged = mergeTrendCandidateObservations(previous, current, "2026-08-21T10:00:00Z");
  assert.equal(merged.length, 2);
  assert.equal(
    merged.find((observation) => observation.url === nativeCandidateUrls[3]).lastObservedAt,
    "2026-08-20T10:00:00Z",
  );
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

test("native discovery candidates are verified before they count toward the daily pool", async () => {
  const unreachableMarker = nativeTrendVerificationRequest({
    platform: "tiktok",
    url: nativeCandidateUrls[0],
  }).marker;
  const audit = await auditNativeTrendCandidateReachability([
    nativeCandidateUrls[0],
    nativeCandidateUrls[0],
    nativeCandidateUrls[1],
  ], {
    fetchImpl: async (url) => decodeURIComponent(url).includes(unreachableMarker)
      ? new Response("missing", { status: 404 })
      : successfulSourceFetch(url),
  });

  assert.equal(audit.checkedCandidateUrls.length, 2);
  assert.deepEqual(audit.availableCandidateUrls, [nativeCandidateUrls[1]]);
  assert.deepEqual(audit.failures.map((failure) => failure.url), [nativeCandidateUrls[0]]);
});

test("a complete scan composes new cards from real three-creator proofs", async () => {
  const baselineActionable = feed.trends.filter(isActionableSocialTrend);
  const baselineActionableIds = new Set(baselineActionable.map((trend) => trend.id));
  const originalReferences = new Map(feed.trends.map((trend) =>
    [trend.id, structuredClone(trend.referencePost)]));
  const originalSemanticProofs = new Map(feed.trends.map((trend) => [trend.id, structuredClone({
    lastVerifiedAt: trend.lastVerifiedAt,
    reuseEvidence: trend.reuseEvidence,
  })]));
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
  const refreshedActionable = result.feed.trends.filter(isActionableSocialTrend);
  const promotedTrendIds = refreshedActionable
    .filter((trend) => !baselineActionableIds.has(trend.id))
    .map((trend) => trend.id);
  assert.equal(result.feed.refresh.counts.actionable, refreshedActionable.length);
  assert.ok(
    result.feed.refresh.counts.actionable >= MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
  );
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
    result.feed.refresh.discoveryAudit.retainedQualifiedCount,
    result.feed.refresh.discoveryAudit.retainedQualifiedTrendIds.length,
  );
  assert.ok(
    result.feed.refresh.discoveryAudit.retainedQualifiedTrendIds.every((id) =>
      baselineActionableIds.has(id)
    ),
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.newQualifiedCount,
    result.feed.refresh.discoveryAudit.newQualifiedTrendIds.length,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.refreshedQualifiedCount,
    result.feed.refresh.discoveryAudit.refreshedQualifiedTrendIds.length,
  );
  assert.equal(
    result.feed.refresh.discoveryAudit.retainedQualifiedCount +
      result.feed.refresh.discoveryAudit.refreshedQualifiedCount +
      result.feed.refresh.discoveryAudit.newQualifiedCount,
    result.feed.refresh.discoveryAudit.qualifiedInventoryCount,
  );
  assert.ok(promotedTrendIds.length >= 1, "the composed feed must contain a real new card");
  assert.ok(
    promotedTrendIds.includes("tiktok-music-7777777777777777777"),
    "the deterministic three-creator native music cluster must rotate into the feed",
  );
  assert.ok(
    result.feed.refresh.discoveryAudit.newQualifiedTrendIds.includes(
      "tiktok-music-7777777777777777777",
    ),
  );
  assert.equal(result.feed.refresh.discoveryAudit.exactMusicClusters.length, 1);
  assert.equal(result.feed.refresh.discoveryAudit.pendingExactMusicClusters.length, 0);
  assert.equal(
    result.feed.refresh.discoveryAudit.availablePosts,
    result.feed.trends
      .filter(isActionableSocialTrend)
      .reduce((total, trend) => total + trend.reuseEvidence.posts.length, 0),
  );
  assert.equal(result.feed.refresh.discoveryAudit.unavailablePosts, 0);
  assert.equal(
    result.feed.refresh.discoveryAudit.candidateUrls.length,
    nativeCandidateUrls.length + promotionYouTubeEvidence.length + 1,
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
  const requalifiedExistingIds = new Set([
    ...result.feed.refresh.discoveryAudit.refreshedQualifiedTrendIds,
    ...result.feed.refresh.discoveryAudit.newQualifiedTrendIds.filter((id) =>
      originalReferences.has(id)
    ),
  ]);
  for (const trend of result.feed.trends.filter((candidate) => originalReferences.has(candidate.id))) {
    if (requalifiedExistingIds.has(trend.id)) {
      assert.equal(trend.referencePost.url, originalReferences.get(trend.id).url);
      assert.equal(isQualifiedTrendReferencePost(trend.referencePost), true);
      assert.equal(isVerifiedMultiCreatorTrend(trend), true);
      assert.equal(trend.lastVerifiedAt, now);
      assert.equal(trend.reuseEvidence.verifiedAt, now);
      continue;
    }
    assert.deepEqual(
      trend.referencePost,
      originalReferences.get(trend.id),
      `native metrics changed on retained trend ${trend.id}`,
    );
    assert.deepEqual(
      { lastVerifiedAt: trend.lastVerifiedAt, reuseEvidence: trend.reuseEvidence },
      originalSemanticProofs.get(trend.id),
      `semantic timestamps changed on retained trend ${trend.id}`,
    );
  }
  const automaticMusicTrend = result.feed.trends.find((trend) =>
    trend.id === "tiktok-music-7777777777777777777");
  assert.equal(automaticMusicTrend.referencePost.metrics.likes, 90_000);
  assert.equal(automaticMusicTrend.referencePost.durationSeconds, 12);
  assert.equal(automaticMusicTrend.reuseEvidence.posts.length, 3);
  assert.equal(new Set(
    automaticMusicTrend.reuseEvidence.posts.map((post) => post.author),
  ).size, 3);
  assert.equal(
    result.feed.trends.some((trend) => trend.id === "same-age-as-parents"),
    true,
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

test("editorial wording coverage stays separate from qualified native-proof inventory", async () => {
  const limitedDiscoveryText = feed.trends.find(isActionableSocialTrend).title;

  const result = await buildDailyTrendRefresh({
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
        `${source.requiredMarkers.join(" ")} ${limitedDiscoveryText} ${nativeCandidateUrls.join(" ")} ${promotionReferenceUrl}`,
        { status: 200 },
      ));
    },
    xBearerToken: "test-token",
  });

  assert.ok(result.feed.refresh.discoveryAudit.candidateCount >= 50);
  assert.ok(result.feed.refresh.discoveryAudit.currentMatchedCount < 50);
  assert.equal(
    result.feed.refresh.discoveryAudit.qualifiedInventoryCount,
    result.feed.trends.filter(isActionableSocialTrend).length,
  );
  assert.ok(
    result.feed.refresh.discoveryAudit.newQualifiedCount >= 1,
    "native three-creator proof must still create a real qualified rotation",
  );
});

test("a large reachable pool cannot masquerade as a successful discovery scan", async () => {
  await assert.rejects(
    buildDailyTrendRefresh({
      feed,
      watchlists,
      now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
      force: true,
      fetchImpl: (url) => {
        const source = watchlists.sources.find((candidate) => candidate.url === url);
        if (source?.kind === "x-api") {
          return Promise.resolve(Response.json({ data: [{ trend_name: actionableTrendTerms }] }));
        }
        if (source) {
          return Promise.resolve(new Response(
            `${source.requiredMarkers.join(" ")} ${actionableTrendTerms} ${nativeCandidateUrls.join(" ")}`,
            { status: 200 },
          ));
        }
        if (/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/u.test(url)) {
          return Promise.resolve(new Response(
            tiktokHydrationFixture(url, { enableAutomaticCluster: false }),
            { status: 200 },
          ));
        }
        return successfulSourceFetch(url);
      },
      xBearerToken: "test-token",
    }),
    (error) => {
      assert.match(error.message, /couverture sémantique.*rotation nulle/i);
      assert.equal(error.refreshStatus.discoveryAudit.candidateCount, nativeCandidateUrls.length);
      assert.equal(error.refreshStatus.discoveryAudit.newQualifiedCount, 0);
      assert.equal(error.refreshStatus.discoveryAudit.complete, false);
      return true;
    },
  );
});

test("zero rotation is accepted only when every discovered candidate was semantically parsed", async () => {
  const zeroRotationCandidates = Array.from({ length: 60 }, (_, index) =>
    `https://www.tiktok.com/@zerorotation${index}/video/${780000000000000000n + BigInt(index)}`);
  const result = await buildDailyTrendRefresh({
    feed,
    watchlists,
    now: new Date(Date.parse(feed.capturedAt) + 60 * 60 * 1_000).toISOString(),
    force: true,
    fetchImpl: (url) => {
      const source = watchlists.sources.find((candidate) => candidate.url === url);
      if (source?.kind === "x-api") {
        return Promise.resolve(Response.json({
          data: [{ trend_name: zeroRotationCandidates.join(" ") }],
        }));
      }
      if (source) {
        return Promise.resolve(new Response(
          `${source.requiredMarkers.join(" ")} ${zeroRotationCandidates.join(" ")}`,
          { status: 200 },
        ));
      }
      if (/^https:\/\/www\.tiktok\.com\/@zerorotation\d+\/video\/\d+$/u.test(url)) {
        return Promise.resolve(new Response(
          tiktokHydrationFixture(url, { enableAutomaticCluster: false }),
          { status: 200 },
        ));
      }
      if (url.startsWith("https://www.tiktok.com/oembed?")) {
        const marker = decodeURIComponent(url).match(/\/video\/(\d{12,24})/u)?.[1];
        if (marker) return Promise.resolve(new Response(marker, { status: 200 }));
      }
      return successfulSourceFetch(url);
    },
    xBearerToken: "test-token",
  });

  assert.equal(result.feed.refresh.discoveryAudit.newQualifiedCount, 0);
  assert.equal(result.feed.refresh.discoveryAudit.refreshedQualifiedCount, 0);
  assert.match(result.feed.refresh.discoveryAudit.noRotationReason, /Tous les 60 candidats/i);
  assert.equal(result.feed.refresh.discoveryAudit.complete, true);
  assert.deepEqual(result.feed.trends, feed.trends);
});

test("the daily publisher fails closed when fewer than 50 evidence sets remain reachable", async () => {
  const actionable = feed.trends.filter(isActionableSocialTrend);
  const unavailableMarkers = actionable
    .slice(0, 4)
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
    (error) => {
      assert.match(error.message, /Seulement \d+\/\d+ trends qualifiées.*minimum 50/i);
      assert.ok(
        error.refreshStatus.discoveryAudit.qualifiedInventoryCount <
          MIN_PUBLISHABLE_ACTIONABLE_VIDEO_TRENDS,
      );
      return true;
    },
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

test("the scheduled video refresh publishes every validated data-only commit", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/social-refresh-video-trends.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /permissions:\s*\n\s*contents: write\s*\n\s*actions: write/u);
  assert.match(workflow, /if: steps\.commit\.outputs\.changed == 'true'/u);
  assert.match(workflow, /gh workflow run deploy-pages\.yml --ref main/u);
  assert.match(workflow, /requested_sha="\$\(git rev-parse HEAD\)"/u);
});
