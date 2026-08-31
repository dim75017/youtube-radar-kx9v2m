import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS,
  MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES,
} from "../lib/audio-trends.ts";

import {
  AUDIO_DISCOVERY_SOURCES,
  AUDIO_REFRESH_MIN_DISTINCT_TRENDS,
  buildAudioTrendRefresh,
  cacheAddedAudioTrendThumbnails,
  candidateSelectionScore,
  collectInstagramSignedPlayback,
  collectTikTokThumbnail,
  evaluateAudioRefreshCoverage,
  evaluateAudioRefreshInventory,
  extractEditorialAudioCandidates,
  extractInstagramSignedPlaybackCandidates,
  instagramPlaybackExpiresAt,
  mapWithConcurrency,
  nativeAudioIdentity,
  parsePublicUsageCounter,
  requiredProviderMatches,
  scanAudioTrendDiscovery,
} from "../scripts/refresh-audio-trends.mjs";

const storedFeed = JSON.parse(
  await readFile(new URL("../data/audio-trends/feed.json", import.meta.url), "utf8"),
);

const feed = structuredClone(storedFeed);
for (const [trendIndex, trend] of feed.trends
  .filter((candidate) => candidate.platform === "youtube")
  .entries()) {
  const audioId = 7_990_000_000_000_000_000n + BigInt(trendIndex);
  const firstVideoId = 7_980_000_000_000_000_000n + BigInt(trendIndex * 10);
  const audioUrl = `https://www.tiktok.com/music/fixture-audio-${audioId}`;
  const referenceUrl = `https://www.tiktok.com/@fixture-${trendIndex}/video/${firstVideoId}`;
  trend.platform = "tiktok";
  trend.audioUrl = audioUrl;
  trend.source.url = audioUrl;
  trend.source.label = "TikTok · fixture audio native";
  trend.referenceVideo.url = referenceUrl;
  trend.referenceVideo.sourceUrl = referenceUrl;
  trend.referenceVideo.sourceLabel = "TikTok · fixture vidéo publique";
  trend.referenceVideo.thumbnailUrl =
    `https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/${firstVideoId}.jpeg`;
  delete trend.referenceVideo.playbackUrl;
  delete trend.referenceVideo.playbackCapturedAt;
  delete trend.referenceVideo.playbackExpiresAt;
  trend.usageObservations = trend.usageObservations.map((observation) => ({
    ...observation,
    uses: null,
    rank: null,
    rankWindow: null,
    sourceLabel: "TikTok · fixture audio native ; compteur indisponible",
    sourceUrl: audioUrl,
    exactness: "unavailable",
  }));
  trend.reuseEvidence.posts = trend.reuseEvidence.posts.map((post, postIndex) => ({
    ...post,
    platform: "tiktok",
    url: `https://www.tiktok.com/@fixture-${trendIndex}-${postIndex}/video/${firstVideoId + BigInt(postIndex)}`,
  }));
}

test("fresh qualified audio outranks a much older high-fit card", () => {
  const now = "2026-08-31T12:00:00.000Z";
  const fresh = {
    lofiFitScore: 90,
    referenceVideo: { publishedAt: "2026-08-30T12:00:00.000Z", metrics: { likes: 80_000 } },
  };
  const stale = {
    lofiFitScore: 98,
    referenceVideo: { publishedAt: "2026-06-01T12:00:00.000Z", metrics: { likes: 2_000_000 } },
  };
  assert.ok(candidateSelectionScore(fresh, now) > candidateSelectionScore(stale, now));
});
const fixtureCapturedTimestamp = Math.max(
  Date.parse(feed.capturedAt),
  ...feed.trends.flatMap((trend) => [
    Date.parse(trend.referenceVideo.capturedAt),
    Date.parse(trend.reuseEvidence.verifiedAt),
    ...trend.reuseEvidence.posts.map((post) => Date.parse(post.capturedAt)),
  ]),
);
feed.capturedAt = new Date(fixtureCapturedTimestamp).toISOString();
feed.nextRefreshAt = new Date(fixtureCapturedTimestamp + 24 * 60 * 60 * 1_000).toISOString();
for (const trend of feed.trends) {
  const likes = trend.referenceVideo.metrics?.likes;
  const durationSeconds = trend.referenceVideo.durationSeconds;
  if (!Number.isSafeInteger(likes) || likes < MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES) {
    trend.referenceVideo.metrics.likes = MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES;
  }
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds >= MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS
  ) {
    trend.referenceVideo.durationSeconds =
      MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS - 0.001;
  }
  if (
    trend.referenceVideo.playbackExpiresAt &&
    Date.parse(trend.referenceVideo.playbackExpiresAt) <= fixtureCapturedTimestamp
  ) {
    delete trend.referenceVideo.playbackUrl;
    delete trend.referenceVideo.playbackCapturedAt;
    delete trend.referenceVideo.playbackExpiresAt;
  }
}

function counterHtml(trend, uses) {
  const audioId = nativeAudioIdentity(trend.audioUrl, trend.platform);
  assert.ok(audioId);
  const counterKey = trend.platform === "tiktok" ? "videoCount" : "mediaCount";
  return `<script type="application/json">{"audioId":"${audioId}","${counterKey}":${uses}}</script>`;
}

function latestUses(trend) {
  return [...trend.usageObservations]
    .reverse()
    .find((observation) => observation.uses !== null)?.uses ?? 1_000;
}

function signedPlaybackUrl(capturedAt, suffix = "primary") {
  const expiresAt = Date.parse(capturedAt) + 36 * 60 * 60 * 1_000;
  const encodedExpiry = Math.floor(expiresAt / 1_000).toString(16).toUpperCase();
  return `https://scontent-cdg4-1.cdninstagram.com/o1/v/t2/f2/m86/${suffix}.mp4?_nc_ht=scontent-cdg4-1.cdninstagram.com&oh=0123456789abcdef0123456789abcdef&oe=${encodedExpiry}&vs=1&_nc_vs=1`;
}

function signedPlaybackHtml(capturedAt) {
  const escaped = signedPlaybackUrl(capturedAt)
    .replaceAll("&", "\\u0026")
    .replaceAll("/", "\\/");
  return `<script>{"video_dash_manifest":"${escaped}"}</script>`;
}

function playbackProbeResponse() {
  return new Response("ftyp moov trak vide avc1 trak soun mp4a", {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "access-control-allow-origin": "*",
      "content-range": "bytes 0-40/1000",
    },
  });
}

function tiktokVideoId(trendOrUrl) {
  const url = typeof trendOrUrl === "string" ? trendOrUrl : trendOrUrl.referenceVideo.url;
  const identity = new URL(url).pathname.match(/\/video\/(\d{12,24})\/?$/u)?.[1];
  assert.ok(identity);
  return identity;
}

function tiktokThumbnailUrl(trendOrUrl) {
  return `https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/${tiktokVideoId(trendOrUrl)}.jpeg`;
}

function tiktokOEmbedPayload(trend, overrides = {}) {
  const videoId = tiktokVideoId(trend);
  return {
    version: "1.0",
    type: "video",
    provider_name: "TikTok",
    provider_url: "https://www.tiktok.com/",
    html: `<blockquote class="tiktok-embed" cite="${trend.referenceVideo.url}" data-video-id="${videoId}"><section><a href="${trend.audioUrl}?refer=embed">♬ Fixture audio - Fixture author</a></section></blockquote>`,
    thumbnail_url: tiktokThumbnailUrl(trend),
    thumbnail_width: 720,
    thumbnail_height: 1280,
    ...overrides,
  };
}

function tiktokTrendFromOEmbedRequest(url) {
  const candidate = new URL(url);
  if (candidate.hostname !== "www.tiktok.com" || candidate.pathname !== "/oembed") return null;
  const referenceUrl = candidate.searchParams.get("url");
  const trend = feed.trends.find((candidateTrend) =>
    candidateTrend.platform === "tiktok" &&
    (
      candidateTrend.referenceVideo.url === referenceUrl ||
      candidateTrend.reuseEvidence.posts.some((post) => post.url === referenceUrl)
    )
  );
  return trend
    ? {
        ...trend,
        referenceVideo: {
          ...trend.referenceVideo,
          url: referenceUrl,
        },
      }
    : null;
}

function thumbnailProbeResponse({ contentType = "image/jpeg", status = 206 } = {}) {
  const bytes = contentType === "image/jpeg"
    ? Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    : new TextEncoder().encode("not an image");
  return new Response(bytes, {
    status,
    headers: {
      "content-type": contentType,
      "content-range": "bytes 0-9/1000",
    },
  });
}

function inventoryFixture(count) {
  return {
    trends: Array.from({ length: count }, (_, index) => ({
      id: `audio-trend-${index + 1}`,
      audioUrl: `https://www.tiktok.com/music/audio-${10_000_000 + index}`,
      referenceVideo: {
        url: `https://www.tiktok.com/@creator-${index + 1}/video/${7_000_000_000_000_000_000n + BigInt(index)}`,
        durationSeconds: MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS - 0.001,
        metrics: { likes: MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES },
      },
    })),
  };
}

const TEST_DISCOVERY_SOURCES = [AUDIO_DISCOVERY_SOURCES[0]];

function validDiscoveryAudioUrls(count = AUDIO_REFRESH_MIN_DISTINCT_TRENDS) {
  const audioUrls = feed.trends
    .map((trend) => trend.audioUrl)
    .filter((audioUrl) =>
      nativeAudioIdentity(audioUrl, "instagram") ||
      nativeAudioIdentity(audioUrl, "tiktok")
    );
  assert.equal(audioUrls.length, feed.trends.length);
  return audioUrls.slice(0, count);
}

function generatedDiscoveryAudioUrls(count) {
  return Array.from({ length: count }, (_, index) =>
    `https://www.tiktok.com/music/editorial-${8_100_000_000_000_000_000n + BigInt(index)}`
  );
}

const COMPLETE_DISCOVERY_AUDIO_URLS = validDiscoveryAudioUrls();

function discoveryHtml(audioUrls = COMPLETE_DISCOVERY_AUDIO_URLS) {
  return audioUrls.map((audioUrl, index) => {
    const platform = nativeAudioIdentity(audioUrl, "instagram") ? "instagram" : "tiktok";
    const platformTrends = feed.trends.filter((trend) => trend.platform === platform);
    const referenceUrl = platformTrends[index % platformTrends.length].referenceVideo.url;
    return `<article><a href="${audioUrl}">audio</a><a href="${referenceUrl}">reference</a></article>`;
  }).join("\n");
}

function completeDiscoveryResponse(url, audioUrls) {
  if (!TEST_DISCOVERY_SOURCES.some((source) => source.url === String(url))) return null;
  return new Response(discoveryHtml(audioUrls), {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function qualificationFixture(audioUrls = validDiscoveryAudioUrls()) {
  return {
    candidates: [],
    currentEvidence: [],
    audit: {
      attemptedAt: "2026-08-21T14:00:00.000Z",
      complete: true,
      videoFeedCapturedAt: "2026-08-21T14:00:00.000Z",
      videoFeedFresh: true,
      videoDiscoveryAuditScannedAt: "2026-08-21T14:00:00.000Z",
      videoDiscoveryAuditFresh: true,
      attemptedTrendCount: audioUrls.length,
      attemptedCurrentTrendCount: 0,
      attemptedFreshVideoTrendCount: audioUrls.length,
      attemptedFreshAuditClusterCount: 0,
      freshQualifiedCount: audioUrls.length,
      qualifiedClusterCount: audioUrls.length,
      freshCurrentQualifiedCount: audioUrls.length,
      freshNewQualifiedCount: 0,
      qualifiedAudioUrls: audioUrls,
      rejected: [],
    },
  };
}

function freshQualifiedVideoTrend(now) {
  const videoIds = [
    "7680000000000000001",
    "7680000000000000002",
    "7680000000000000003",
  ];
  const authors = ["@fresh-one", "@fresh-two", "@fresh-three"];
  return {
    id: "fresh-three-creator-audio",
    fixtureAudioUrl: "https://www.tiktok.com/music/fresh-qualified-audio-7689999999999999999",
    title: "Fresh three-creator audio",
    character: "lofi-girl",
    summary: "Three creators use the same native audio for one concise study transition.",
    mechanic: "Cut from procrastination to focus on the same audio cue.",
    momentumScore: 100,
    lofiFitScore: 100,
    whyLofi: "The focus transition maps directly to Lofi Girl's study desk.",
    lastVerifiedAt: now,
    referencePost: {
      platform: "tiktok",
      author: authors[0],
      caption: "Fresh focus transition",
      url: `https://www.tiktok.com/${authors[0]}/video/${videoIds[0]}`,
      durationSeconds: 12.5,
      thumbnailUrl: null,
      publishedAt: new Date(Date.parse(now) - 2 * 60 * 60 * 1_000).toISOString(),
      capturedAt: now,
      sourceLabel: "TikTok · compteurs publics",
      sourceUrl: `https://www.tiktok.com/${authors[0]}/video/${videoIds[0]}`,
      exactness: "exact",
      metrics: {
        views: 12_000_000,
        likes: 9_000_000,
        comments: 42_000,
        shares: 800_000,
      },
    },
    reuseEvidence: {
      verifiedAt: now,
      minimumDistinctCreators: 3,
      summary: "Three distinct creators were verified.",
      posts: videoIds.map((videoId, index) => ({
        platform: "tiktok",
        author: authors[index],
        url: `https://www.tiktok.com/${authors[index]}/video/${videoId}`,
        capturedAt: now,
      })),
    },
    proposals: [
      { tone: "complice", concept: "Lofi Girl catches herself procrastinating, then starts one page.", copy: "Fine, one page." },
      { tone: "cozy", concept: "The room warms up as the focus cue lands.", copy: "Small start, soft light." },
      { tone: "absurde", concept: "The cat starts the timer before Lofi Girl does.", copy: "Manager on duty." },
    ],
  };
}

function freshCurrentQualificationVideoFeed(now, count = 3) {
  const targets = feed.trends
    .filter((trend) => trend.platform === "tiktok")
    .slice(0, count);
  assert.equal(targets.length, count);
  return {
    capturedAt: now,
    refresh: {
      discoveryAudit: {
        scannedAt: now,
        complete: true,
        candidateObservations: [],
        exactMusicClusters: [],
        musicClusterQualifications: [],
      },
    },
    trends: targets.map((target, trendIndex) => {
      const firstVideoId = 7_769_000_000_000_000_000n + BigInt(trendIndex * 10);
      const authors = Array.from({ length: 3 }, (_, index) => `@fresh-current-${trendIndex}-${index}`);
      const posts = authors.map((author, index) => ({
        platform: "tiktok",
        author,
        url: `https://www.tiktok.com/${author}/video/${firstVideoId + BigInt(index)}`,
        capturedAt: now,
      }));
      return {
        id: `fresh-current-${target.id}`,
        fixtureAudioUrl: target.audioUrl,
        title: `Fresh current cluster ${trendIndex + 1}`,
        character: "lofi-girl",
        summary: "A current native cluster verified across three creators.",
        mechanic: "Three creators reuse the same focus transition.",
        momentumScore: 80,
        lofiFitScore: Math.max(80, target.lofiFitScore),
        whyLofi: "The verified focus mechanic maps directly to the study desk.",
        lastVerifiedAt: now,
        referencePost: {
          platform: "tiktok",
          author: authors[0],
          caption: "Fresh current audio reference",
          url: posts[0].url,
          durationSeconds: 12,
          thumbnailUrl: null,
          publishedAt: new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString(),
          capturedAt: now,
          sourceLabel: "TikTok · compteurs publics",
          sourceUrl: posts[0].url,
          exactness: "exact",
          metrics: {
            views: 1_000_000,
            likes: 100_000,
            comments: 2_000,
            shares: 4_000,
          },
        },
        reuseEvidence: {
          verifiedAt: now,
          minimumDistinctCreators: 3,
          summary: "Three distinct creators were verified during the fresh video scan.",
          posts,
        },
        proposals: [
          { tone: "complice", concept: "Lofi Girl starts with one page.", copy: "Fine, one page." },
          { tone: "cozy", concept: "The room warms as focus lands.", copy: "Small start, soft light." },
          { tone: "absurde", concept: "The cat starts the timer.", copy: "Manager on duty." },
        ],
      };
    }),
  };
}

function freshVideoOEmbedPayload(referenceUrl, audioUrl) {
  const videoId = tiktokVideoId(referenceUrl);
  return {
    version: "1.0",
    type: "video",
    provider_name: "TikTok",
    provider_url: "https://www.tiktok.com/",
    html: `<blockquote class="tiktok-embed" cite="${referenceUrl}" data-video-id="${videoId}"><section><a href="${audioUrl}?refer=embed">♬ Fresh Qualified Audio - Fresh Artist</a></section></blockquote>`,
    thumbnail_url: `https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/${videoId}.jpeg`,
  };
}

function freshQualificationOEmbedResponse(url, videoTrendFeed) {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== "www.tiktok.com" || parsedUrl.pathname !== "/oembed") return null;
  const referenceUrl = parsedUrl.searchParams.get("url");
  const trend = videoTrendFeed.trends.find((candidate) =>
    candidate.referencePost.url === referenceUrl ||
    candidate.reuseEvidence.posts.some((post) => post.url === referenceUrl)
  );
  if (trend) return Response.json(freshVideoOEmbedPayload(referenceUrl, trend.fixtureAudioUrl));
  const observation = videoTrendFeed.refresh?.discoveryAudit?.candidateObservations
    ?.find((candidate) => candidate.url === referenceUrl);
  if (!observation?.music?.id) return null;
  return Response.json(freshVideoOEmbedPayload(
    referenceUrl,
    `https://www.tiktok.com/music/audit-cluster-${observation.music.id}`,
  ));
}

function freshAuditClusterVideoFeed(now, count = 3) {
  const candidateObservations = [];
  const exactMusicClusters = [];
  const musicClusterQualifications = [];
  for (let clusterIndex = 0; clusterIndex < count; clusterIndex += 1) {
    const musicId = String(7_779_000_000_000_000_000n + BigInt(clusterIndex));
    const observations = Array.from({ length: 3 }, (_, postIndex) => {
      const videoId = 7_778_000_000_000_000_000n + BigInt(clusterIndex * 10 + postIndex);
      const author = `@audit-${clusterIndex}-${postIndex}`;
      return {
        platform: "tiktok",
        url: `https://www.tiktok.com/${author}/video/${videoId}`,
        nativeId: String(videoId),
        author,
        caption: `Exact audit cluster ${clusterIndex + 1}`,
        publishedAt: new Date(Date.parse(now) - (postIndex + 1) * 60 * 60 * 1_000).toISOString(),
        capturedAt: now,
        lastObservedAt: now,
        durationSeconds: 12,
        thumbnailUrl: `https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/${videoId}.jpeg`,
        metrics: {
          views: 2_000_000 - postIndex * 100_000,
          likes: postIndex === 0 ? 900_000 : 80_000,
          comments: 2_000,
          shares: 5_000,
        },
        music: {
          id: musicId,
          title: `Audit cluster ${clusterIndex + 1}`,
          author: `Audit artist ${clusterIndex + 1}`,
        },
      };
    });
    const postUrls = observations.map((observation) => observation.url);
    candidateObservations.push(...observations);
    exactMusicClusters.push({
      musicId,
      musicTitle: `Audit cluster ${clusterIndex + 1}`,
      musicAuthor: `Audit artist ${clusterIndex + 1}`,
      distinctCreators: 3,
      referenceUrl: postUrls[0],
      postUrls,
    });
    musicClusterQualifications.push({
      musicId,
      status: "qualified",
      reason: null,
      evidenceUrls: postUrls,
    });
  }
  return {
    capturedAt: now,
    refresh: {
      discoveryAudit: {
        scannedAt: now,
        complete: true,
        candidateObservations,
        exactMusicClusters,
        musicClusterQualifications,
      },
    },
    trends: [],
  };
}

test("native audio counters are tied to the requested platform identity", () => {
  const instagramUrl = "https://www.instagram.com/reels/audio/123456789012345/";
  const html = '<script>{"audioId":"123456789012345","mediaCount":1200}</script>';
  assert.deepEqual(
    parsePublicUsageCounter(html, "instagram", {
      expectedAudioUrl: instagramUrl,
      responseUrl: instagramUrl,
    }),
    { uses: 1_200, exactness: "exact", audioId: "123456789012345" },
  );
  assert.equal(
    parsePublicUsageCounter(html, "instagram", {
      expectedAudioUrl: instagramUrl,
      responseUrl: "https://www.instagram.com/reels/audio/999999999999999/",
    }),
    null,
  );
  assert.equal(
    parsePublicUsageCounter(
      `${html}<script>{"audioId":"123456789012345","mediaCount":1300}</script>`,
      "instagram",
      { expectedAudioUrl: instagramUrl, responseUrl: instagramUrl },
    ),
    null,
    "ambiguous counters must fail closed instead of selecting the largest value",
  );
});

test("Instagram playback extraction keeps only strict signed scontent MP4 URLs", async () => {
  const capturedAt = "2026-08-12T10:00:00.000Z";
  const expected = signedPlaybackUrl(capturedAt);
  const html = `${signedPlaybackHtml(capturedAt)}<script>{"url":"https://evil.example/video.mp4?oh=0123456789abcdef&oe=6fffffff"}</script>`;
  assert.deepEqual(extractInstagramSignedPlaybackCandidates(html), [expected]);
  assert.equal(
    instagramPlaybackExpiresAt(expected),
    new Date(Date.parse(capturedAt) + 36 * 60 * 60 * 1_000).toISOString(),
  );

  const requested = [];
  const playback = await collectInstagramSignedPlayback({
    referenceUrl: "https://www.instagram.com/reel/DbieVLOsbLT/",
    capturedAt,
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes("instagram.com/reel/")) {
        return new Response(signedPlaybackHtml(capturedAt), { status: 200 });
      }
      if (url === expected) return playbackProbeResponse();
      assert.fail(`unexpected playback URL ${url}`);
    },
  });
  assert.deepEqual(playback, {
    url: expected,
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + 36 * 60 * 60 * 1_000).toISOString(),
  });
  assert.equal(requested.length, 2);
});

test("Instagram playback collection fails closed without an attributable playable MP4", async () => {
  await assert.rejects(
    collectInstagramSignedPlayback({
      referenceUrl: "https://www.instagram.com/reel/DbieVLOsbLT/",
      capturedAt: "2026-08-12T10:00:00.000Z",
      fetchImpl: async () => new Response("<html>embed only</html>", { status: 200 }),
    }),
    /URL MP4 Instagram signee absente/i,
  );
});

test("TikTok thumbnails come from the official oEmbed video and an accessible image CDN", async () => {
  const trend = feed.trends.find((candidate) => candidate.platform === "tiktok");
  assert.ok(trend);
  const expectedThumbnail = tiktokThumbnailUrl(trend);
  const requested = [];
  const thumbnail = await collectTikTokThumbnail({
    referenceUrl: trend.referenceVideo.url,
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      if (String(url).startsWith("https://www.tiktok.com/oembed?")) {
        assert.equal(new URL(url).searchParams.get("url"), trend.referenceVideo.url);
        return Response.json(tiktokOEmbedPayload(trend));
      }
      if (url === expectedThumbnail) return thumbnailProbeResponse();
      assert.fail(`unexpected TikTok thumbnail URL ${url}`);
    },
  });
  assert.deepEqual(thumbnail, { url: expectedThumbnail });
  assert.equal(requested.length, 2);
  assert.equal(requested[0].options.headers.Accept, "application/json");
  assert.match(requested[1].options.headers.Accept, /^image\//u);
});

test("TikTok thumbnail collection rejects mismatched identities, providers and non-images", async () => {
  const trend = feed.trends.find((candidate) => candidate.platform === "tiktok");
  assert.ok(trend);
  const mismatchedHtml = tiktokOEmbedPayload(trend, {
    html: '<blockquote data-video-id="7999999999999999999"></blockquote>',
  });
  await assert.rejects(
    collectTikTokThumbnail({
      referenceUrl: trend.referenceVideo.url,
      fetchImpl: async () => Response.json(mismatchedHtml),
    }),
    /non attribuable/i,
  );

  await assert.rejects(
    collectTikTokThumbnail({
      referenceUrl: trend.referenceVideo.url,
      fetchImpl: async () => Response.json(tiktokOEmbedPayload(trend, {
        provider_name: "Lookalike",
      })),
    }),
    /non attribuable/i,
  );

  await assert.rejects(
    collectTikTokThumbnail({
      referenceUrl: trend.referenceVideo.url,
      fetchImpl: async () => Response.json(tiktokOEmbedPayload(trend, {
        thumbnail_url: "https://images.example.test/reference.jpg",
      })),
    }),
    /non attribuable/i,
  );

  await assert.rejects(
    collectTikTokThumbnail({
      referenceUrl: trend.referenceVideo.url,
      fetchImpl: async (url) => String(url).startsWith("https://www.tiktok.com/oembed?")
        ? Response.json(tiktokOEmbedPayload(trend))
        : thumbnailProbeResponse({ contentType: "text/html" }),
    }),
    /non image/i,
  );
});

test("editorial discovery extracts only native audio URLs and nearby native references", () => {
  const html = `
    <a href="https://www.tiktok.com/music/original-sound-7643191632304671518?lang=en">sound</a>
    <a href="https://www.tiktok.com/@creator/video/7654586122093219105">video</a>
    <a href="https:\\/\\/www.instagram.com\\/reels\\/audio\\/123456789012345\\/">audio</a>
    <a href="https://www.instagram.com/reel/DbieVLOsbLT/?utm_source=editorial">reel</a>
    <a href="https://www.tiktok.com/music/original-sound-7643191632304671518">duplicate</a>
    <a href="https://www.tiktok.com/@creator">profile, not audio</a>
    <a href="https://evil.example/music/original-sound-999999999999">lookalike</a>
  `;
  const candidates = extractEditorialAudioCandidates(html, {
    sourceId: "buffer-tiktok-trends",
    sourceUrl: TEST_DISCOVERY_SOURCES[0].url,
  });
  assert.deepEqual(
    candidates.map((candidate) => ({
      platform: candidate.platform,
      audioUrl: candidate.audioUrl,
      referenceUrl: candidate.referenceUrl,
    })),
    [
      {
        platform: "instagram",
        audioUrl: "https://www.instagram.com/reels/audio/123456789012345",
        referenceUrl: "https://www.instagram.com/reel/DbieVLOsbLT",
      },
      {
        platform: "tiktok",
        audioUrl: "https://www.tiktok.com/music/original-sound-7643191632304671518",
        referenceUrl: "https://www.tiktok.com/@creator/video/7654586122093219105",
      },
    ],
  );
});

test("editorial discovery emits a bounded, deduplicated audit and requires a 50-audio pool", async () => {
  const completeUrls = validDiscoveryAudioUrls();
  const now = "2026-08-21T14:00:00.000Z";
  const complete = await scanAudioTrendDiscovery({
    feed,
    now,
    sources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => completeDiscoveryResponse(url, completeUrls),
    qualificationResult: qualificationFixture(completeUrls),
  });
  assert.equal(complete.scannedAt, now);
  assert.equal(complete.status, "success");
  assert.equal(complete.complete, true);
  assert.equal(complete.candidateCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  assert.deepEqual(complete.candidatePoolDelta, {
    status: "compared",
    added: AUDIO_REFRESH_MIN_DISTINCT_TRENDS,
    removed: 0,
    retained: 0,
  });
  assert.equal(complete.qualifiedInventoryCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  assert.equal(complete.currentMatchedCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  assert.equal(complete.newCandidateCount, 0);
  assert.deepEqual(complete.added, []);
  assert.deepEqual(complete.removed, []);
  assert.deepEqual(complete.retainedIds, feed.trends.map((trend) => trend.id));
  assert.ok(complete.candidateAudioUrls.length <= 200);
  assert.equal(complete.sourceBreakdown[0].status, "success");
  assert.equal(complete.sourceBreakdown[0].candidateCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);

  const incomplete = await scanAudioTrendDiscovery({
    feed,
    now,
    sources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => completeDiscoveryResponse(
      url,
      completeUrls.slice(0, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1),
    ),
    qualificationResult: qualificationFixture(completeUrls),
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.candidateCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
  assert.equal(incomplete.currentMatchedCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
  assert.equal(incomplete.qualifiedInventoryCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
});

test("a large two-platform editorial pool can complete when exact inventory matches are sparse", async () => {
  const candidateUrls = [
    feed.trends.find((trend) => trend.platform === "instagram").audioUrl,
    ...generatedDiscoveryAudioUrls(160),
  ];
  const audit = await scanAudioTrendDiscovery({
    feed,
    now: "2026-08-21T14:05:00.000Z",
    sources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => completeDiscoveryResponse(url, candidateUrls),
    qualificationResult: qualificationFixture(validDiscoveryAudioUrls()),
  });

  assert.equal(audit.candidateCount, 161);
  assert.equal(audit.currentMatchedCount, 1);
  assert.equal(audit.qualifiedInventoryCount, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  assert.equal(audit.newCandidateCount, 160);
  assert.equal(audit.complete, true);
  assert.equal(audit.status, "success");
});

test("new audio cards cache their official TikTok thumbnail under a stable local path", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "lofi-audio-thumbnail-"));
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const candidate = {
    trends: [{
      id: "audio-new-card",
      referenceVideo: {
        thumbnailUrl: "https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/new-card.jpeg",
      },
    }],
  };
  try {
    const paths = await cacheAddedAudioTrendThumbnails({
      feed: candidate,
      selectionAudit: { addedTrendIds: ["audio-new-card"] },
      outputDirectory,
      fetchImpl: async () => new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(bytes.byteLength),
        },
      }),
    });
    assert.deepEqual(paths, ["media/audio-trends/audio-new-card.jpg"]);
    assert.equal(
      candidate.trends[0].referenceVideo.thumbnailUrl,
      "media/audio-trends/audio-new-card.jpg",
    );
    assert.deepEqual(
      new Uint8Array(await readFile(join(outputDirectory, "audio-new-card.jpg"))),
      bytes,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("a failed source pass preserves the last successful candidate registry", async () => {
  const previousUrls = validDiscoveryAudioUrls();
  const previousRegistry = {
    updatedAt: "2026-08-20T14:00:00.000Z",
    candidateCount: previousUrls.length,
    candidateAudioUrls: previousUrls,
    candidateReferences: [],
  };
  const audit = await scanAudioTrendDiscovery({
    feed,
    now: "2026-08-21T14:00:00.000Z",
    sources: TEST_DISCOVERY_SOURCES,
    previousDiscoveryAudit: { candidateRegistry: previousRegistry },
    qualificationResult: qualificationFixture(previousUrls),
    fetchImpl: async () => new Response("blocked", { status: 503 }),
  });

  assert.equal(audit.complete, false);
  assert.equal(audit.status, "incomplete");
  assert.deepEqual(audit.candidateRegistry, previousRegistry);
  assert.equal(audit.candidateCount, 0);
  assert.deepEqual(audit.candidatePoolDelta, {
    status: "preserved-after-source-failure",
    added: 0,
    removed: 0,
    retained: previousUrls.length,
  });
});

test("publishing requires broad coverage on every tracked provider", () => {
  const instagramChecked = 8;
  const tiktokChecked = 42;
  assert.equal(requiredProviderMatches(instagramChecked), 6);
  assert.equal(requiredProviderMatches(tiktokChecked), 30);
  const oneMatch = evaluateAudioRefreshCoverage([
    { platform: "instagram", checked: instagramChecked, matched: 1 },
    { platform: "tiktok", checked: tiktokChecked, matched: 0 },
  ]);
  assert.equal(oneMatch.publishable, false);
  assert.equal(oneMatch.requiredTotal, 38);

  const missingProvider = evaluateAudioRefreshCoverage([
    { platform: "instagram", checked: instagramChecked, matched: instagramChecked },
  ]);
  assert.equal(missingProvider.publishable, false);

  const broadCoverage = evaluateAudioRefreshCoverage([
    { platform: "instagram", checked: instagramChecked, matched: 6 },
    { platform: "tiktok", checked: tiktokChecked, matched: 32 },
  ]);
  assert.equal(broadCoverage.publishable, true);
});

test("publication inventory accepts 50 distinct audio trends and rejects 49", () => {
  const complete = evaluateAudioRefreshInventory(
    inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS),
  );
  assert.equal(complete.totalTrends, 50);
  assert.equal(complete.distinctTrendIds, 50);
  assert.equal(complete.distinctAudioUrls, 50);
  assert.equal(complete.distinctReferenceUrls, 50);
  assert.equal(complete.publishable, true);

  const incomplete = evaluateAudioRefreshInventory(
    inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1),
  );
  assert.equal(incomplete.totalTrends, 49);
  assert.equal(incomplete.publishable, false);
});

test("publication inventory fails closed on duplicate audio or reference URLs", () => {
  const duplicateAudio = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  duplicateAudio.trends.at(-1).audioUrl = duplicateAudio.trends[0].audioUrl;
  const audioResult = evaluateAudioRefreshInventory(duplicateAudio);
  assert.equal(audioResult.distinctAudioUrls, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
  assert.equal(audioResult.publishable, false);

  const duplicateReference = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  duplicateReference.trends.at(-1).referenceVideo.url =
    duplicateReference.trends[0].referenceVideo.url;
  const referenceResult = evaluateAudioRefreshInventory(duplicateReference);
  assert.equal(referenceResult.distinctReferenceUrls, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
  assert.equal(referenceResult.publishable, false);
});

test("publication inventory deduplicates TikTok music URLs by immutable numeric ID", () => {
  const candidate = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  const musicId = candidate.trends[0].audioUrl.match(/(\d{8,24})\/?$/u)?.[1];
  assert.ok(musicId);
  candidate.trends.at(-1).audioUrl =
    `https://m.tiktok.com/music/ANOTHER-SLUG-${musicId}?lang=fr`;

  const result = evaluateAudioRefreshInventory(candidate);
  assert.equal(result.distinctAudioUrls, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
  assert.equal(result.publishable, false);
});

test("publication inventory fails closed on weak, missing or long reference videos", () => {
  for (const likes of [null, MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES - 1]) {
    const candidate = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
    candidate.trends.at(-1).referenceVideo.metrics.likes = likes;
    const result = evaluateAudioRefreshInventory(candidate);
    assert.equal(result.publishableReferenceVideos, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
    assert.deepEqual(result.unpublishableReferenceTrendIds, ["audio-trend-50"]);
    assert.equal(result.publishable, false);
  }

  for (const durationSeconds of [
    null,
    0,
    MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS,
    MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS + 1,
  ]) {
    const candidate = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
    candidate.trends.at(-1).referenceVideo.durationSeconds = durationSeconds;
    const result = evaluateAudioRefreshInventory(candidate);
    assert.equal(result.publishableReferenceVideos, AUDIO_REFRESH_MIN_DISTINCT_TRENDS - 1);
    assert.deepEqual(result.unpublishableReferenceTrendIds, ["audio-trend-50"]);
    assert.equal(result.publishable, false);
  }

  const boundary = inventoryFixture(AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  boundary.trends.at(-1).referenceVideo.metrics.likes =
    MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES;
  boundary.trends.at(-1).referenceVideo.durationSeconds =
    MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS - 0.001;
  assert.equal(evaluateAudioRefreshInventory(boundary).publishable, true);
});

test("the scanner never exceeds its configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(
    Array.from({ length: 20 }, (_, index) => index),
    3,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    },
  );
  assert.ok(peak <= 3);
  assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index * 2));
});

test("a complete linked scan updates all counters without mutating the input", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  const requested = [];
  const result = await buildAudioTrendRefresh({
    feed,
    videoTrendFeed,
    now,
    discoverySources: TEST_DISCOVERY_SOURCES,
    concurrency: 4,
    fetchImpl: async (url, options) => {
      requested.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      const discoveryResponse = completeDiscoveryResponse(url);
      if (discoveryResponse) return discoveryResponse;
      const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
      if (qualificationResponse) return qualificationResponse;
      const trend = feed.trends.find((candidate) => candidate.audioUrl === url);
      if (trend) return new Response(counterHtml(trend, latestUses(trend)), { status: 200 });
      const referenceTrend = feed.trends.find((candidate) =>
        candidate.platform === "instagram" && candidate.referenceVideo.url === url
      );
      if (referenceTrend) return new Response(signedPlaybackHtml(now), { status: 200 });
      if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
      const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
      if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
      if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
      assert.fail(`unexpected refresh URL ${url}`);
    },
  });

  const trackedTrends = feed.trends.filter((trend) => ["instagram", "tiktok"].includes(trend.platform));
  const instagramTrends = trackedTrends.filter((trend) => trend.platform === "instagram");
  const tiktokTrends = trackedTrends.filter((trend) => trend.platform === "tiktok");
  assert.ok(
    requested.length >=
    trackedTrends.length + instagramTrends.length * 2 + tiktokTrends.length * 2 +
      videoTrendFeed.trends.length * 3 +
      TEST_DISCOVERY_SOURCES.length,
  );
  assert.equal(result.status.coverage.totalMatched, trackedTrends.length);
  assert.equal(result.status.coverage.instagramPlaybackMatched, instagramTrends.length);
  assert.equal(result.status.coverage.instagramPlaybackComplete, true);
  assert.equal(result.status.coverage.tiktokThumbnailMatched, tiktokTrends.length);
  assert.equal(result.status.coverage.tiktokThumbnailCoverage, 1);
  assert.equal(result.status.coverage.tiktokThumbnailComplete, true);
  assert.equal(result.status.coverage.thumbnailPublishable, true);
  assert.equal(result.status.discoveryAudit.complete, true);
  assert.equal(result.status.published, true);
  assert.equal(result.feed.capturedAt, now);
  assert.ok(
    result.feed.trends
      .filter((trend) => ["instagram", "tiktok"].includes(trend.platform))
      .every((trend) => trend.usageObservations.at(-1).capturedAt === now),
  );
  assert.ok(
    result.feed.trends
      .filter((trend) => trend.platform === "instagram")
      .every((trend) =>
        typeof trend.referenceVideo.playbackUrl === "string" &&
        trend.referenceVideo.playbackCapturedAt === now &&
        Date.parse(trend.referenceVideo.playbackExpiresAt) > Date.parse(now)
      ),
  );
  assert.ok(
    result.feed.trends
      .filter((trend) => trend.platform === "tiktok")
      .every((trend) => {
        const previous = feed.trends.find((candidate) => candidate.id === trend.id);
        return previous.referenceVideo.thumbnailUrl?.startsWith("media/audio-trends/")
          ? trend.referenceVideo.thumbnailUrl === previous.referenceVideo.thumbnailUrl
          : trend.referenceVideo.thumbnailUrl === tiktokThumbnailUrl(trend);
      }),
  );
  assert.deepEqual(feed, original, "the last validated feed remains untouched until publication");
});

test("a fresh three-creator audio identity is promoted into the 50-card feed", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrend = freshQualifiedVideoTrend(now);
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now, 2);
  videoTrendFeed.trends.push(videoTrend);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const result = await buildAudioTrendRefresh({
    feed,
    videoTrendFeed,
    now,
    discoverySources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => {
      const discoveryResponse = completeDiscoveryResponse(url);
      if (discoveryResponse) return discoveryResponse;
      const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
      if (qualificationResponse) return qualificationResponse;
      const counterTrend = feed.trends.find((trend) => trend.audioUrl === url);
      if (counterTrend) return new Response(counterHtml(counterTrend, latestUses(counterTrend)), { status: 200 });
      if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
        return new Response(signedPlaybackHtml(now), { status: 200 });
      }
      if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
      const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
      if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
      if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
      assert.fail(`unexpected promotion URL ${url}`);
    },
  });

  const selection = result.status.discoveryAudit.selectionAudit;
  assert.equal(result.status.discoveryAudit.qualificationAudit.freshQualifiedCount, 3);
  assert.equal(result.status.discoveryAudit.qualificationAudit.freshNewQualifiedCount, 1);
  assert.equal(selection.addedTrendIds.length, 1);
  assert.equal(selection.removedTrendIds.length, 1);
  assert.equal(selection.noRotationReason, null);
  assert.equal(result.feed.trends.length, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  const promoted = result.feed.trends.find((trend) => trend.id === "audio-fresh-three-creator-audio");
  assert.ok(promoted);
  assert.equal(promoted.audioUrl, "https://www.tiktok.com/music/fresh-qualified-audio-7689999999999999999");
  assert.equal(promoted.referenceVideo.metrics.likes, 9_000_000);
  assert.ok(promoted.referenceVideo.durationSeconds < 30);
  assert.equal(promoted.reuseEvidence.posts.length, 3);
  assert.equal(new Set(promoted.reuseEvidence.posts.map((post) => post.author)).size, 3);
  assert.deepEqual(feed, original);
});

test("exact audio clusters from a fresh zero-rotation video audit can populate the audio feed", async () => {
  const rotationFeed = structuredClone(feed);
  const weakestBaseline = [...rotationFeed.trends]
    .sort((left, right) => left.lofiFitScore - right.lofiFitScore)
    .slice(0, 3);
  for (const trend of weakestBaseline) trend.lofiFitScore = 1;
  const original = structuredClone(rotationFeed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshAuditClusterVideoFeed(now);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const result = await buildAudioTrendRefresh({
    feed: rotationFeed,
    videoTrendFeed,
    now,
    discoverySources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => {
      const discoveryResponse = completeDiscoveryResponse(url);
      if (discoveryResponse) return discoveryResponse;
      const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
      if (qualificationResponse) return qualificationResponse;
      const counterTrend = rotationFeed.trends.find((trend) => trend.audioUrl === url);
      if (counterTrend) return new Response(counterHtml(counterTrend, latestUses(counterTrend)), { status: 200 });
      if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
        return new Response(signedPlaybackHtml(now), { status: 200 });
      }
      if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
      const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
      if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
      if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
      assert.fail(`unexpected exact-cluster URL ${url}`);
    },
  });

  const qualification = result.status.discoveryAudit.qualificationAudit;
  const selection = result.status.discoveryAudit.selectionAudit;
  assert.equal(qualification.attemptedFreshVideoTrendCount, 0);
  assert.equal(qualification.attemptedFreshAuditClusterCount, 3);
  assert.equal(qualification.freshQualifiedCount, 3);
  assert.equal(qualification.freshNewQualifiedCount, 3);
  assert.equal(result.status.discoveryAudit.qualifiedInventoryCount, 3);
  assert.equal(result.status.discoveryAudit.publishedInventoryCount, 50);
  assert.equal(selection.addedTrendIds.length, 3);
  assert.equal(selection.removedTrendIds.length, 3);
  assert.equal(selection.retainedTrendIds.length, 47);
  assert.equal(selection.noRotationReason, null);
  assert.equal(result.feed.trends.length, AUDIO_REFRESH_MIN_DISTINCT_TRENDS);
  assert.equal(result.status.published, true);
  assert.deepEqual(rotationFeed, original);
});

test("complete discovery publishes with optional counters while rewriting only native reuse proofs", async () => {
  const original = structuredClone(feed);
  const originalObservations = feed.trends.map((trend) => structuredClone(trend.usageObservations));
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const result = await buildAudioTrendRefresh({
    feed,
    videoTrendFeed,
    now,
    discoverySources: TEST_DISCOVERY_SOURCES,
    fetchImpl: async (url) => {
      const discoveryResponse = completeDiscoveryResponse(url);
      if (discoveryResponse) return discoveryResponse;
      const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
      if (qualificationResponse) return qualificationResponse;
      if (feed.trends.some((trend) => trend.audioUrl === url)) {
        return new Response("counter blocked", { status: 503 });
      }
      if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
        return new Response(signedPlaybackHtml(now), { status: 200 });
      }
      if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
      const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
      if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
      if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
      assert.fail(`unexpected degraded refresh URL ${url}`);
    },
  });

  assert.equal(result.status.status, "success");
  assert.equal(result.status.published, true);
  assert.equal(result.status.discoveryAudit.complete, true);
  assert.equal(result.status.coverage.totalMatched, 0);
  assert.equal(result.status.coverage.counterPublishable, false);
  assert.equal(result.status.coverage.instagramPlaybackMatched, instagramTrends.length);
  assert.equal(result.status.coverage.instagramPlaybackComplete, true);
  assert.equal(
    result.status.coverage.tiktokThumbnailMatched,
    feed.trends.filter((trend) => trend.platform === "tiktok").length,
  );
  assert.equal(result.status.coverage.tiktokThumbnailComplete, true);
  assert.deepEqual(
    result.feed.trends.map((trend) => trend.usageObservations),
    originalObservations,
    "failed counters must preserve every previous observation",
  );
  assert.deepEqual(
    result.feed.trends.filter((trend) => trend.platform === "instagram").map((trend) => trend.reuseEvidence),
    feed.trends.filter((trend) => trend.platform === "instagram").map((trend) => trend.reuseEvidence),
    "Instagram evidence is not refreshed without an attributable audio identity",
  );
  const reverifiedIds = new Set(
    result.status.discoveryAudit.selectionAudit.reverifiedTrendIds,
  );
  assert.equal(reverifiedIds.size, 3);
  assert.ok(
    result.feed.trends
      .filter((trend) => reverifiedIds.has(trend.id))
      .every((trend) => trend.reuseEvidence.verifiedAt === now),
    "only TikTok clusters with three exact oEmbed audio matches are refreshed",
  );
  assert.equal(result.feed.capturedAt, now);
  assert.equal(result.feed.sourceChecks.find((check) => check.platform === "instagram")?.status, "limited");
  assert.equal(result.feed.sourceChecks.find((check) => check.platform === "tiktok")?.status, "limited");
  assert.notEqual(
    result.feed.sourceChecks.find((check) => check.platform === "youtube")?.checkedAt,
    now,
    "the static YouTube limitation is not a real source check",
  );
  assert.ok(
    result.feed.trends
      .filter((trend) => trend.platform === "instagram")
      .every((trend) => trend.referenceVideo.playbackCapturedAt === now),
  );
  assert.deepEqual(feed, original);
});

test("asset-only checks cannot advance trend freshness without a complete discovery pool", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  let failure;
  try {
    await buildAudioTrendRefresh({
      feed,
      now,
      fetchImpl: async (url) => {
        if (feed.trends.some((trend) => trend.audioUrl === url)) {
          return new Response("counter blocked", { status: 503 });
        }
        if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
          return new Response(signedPlaybackHtml(now), { status: 200 });
        }
        if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
        const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
        if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
        if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
        assert.fail(`unexpected asset-only URL ${url}`);
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Découverte audio incomplète/i);
  assert.equal(failure.refreshStatus.status, "failed");
  assert.equal(failure.refreshStatus.published, false);
  assert.equal(failure.refreshStatus.discoveryAudit.status, "not-run");
  assert.equal(failure.refreshStatus.discoveryAudit.scannedAt, null);
  assert.equal(failure.refreshStatus.coverage.assetPublishable, true);
  assert.deepEqual(feed, original);
  assert.equal(feed.capturedAt, original.capturedAt);
  assert.equal(feed.nextRefreshAt, original.nextRefreshAt);
});

test("161 discovered audios with one exact match publish after independent native qualification", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const candidateUrls = [
    feed.trends.find((trend) => trend.platform === "instagram").audioUrl,
    ...generatedDiscoveryAudioUrls(160),
  ];
  const result = await buildAudioTrendRefresh({
      feed,
      videoTrendFeed,
      now,
      discoverySources: TEST_DISCOVERY_SOURCES,
      fetchImpl: async (url) => {
        const discoveryResponse = completeDiscoveryResponse(url, candidateUrls);
        if (discoveryResponse) return discoveryResponse;
        const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
        if (qualificationResponse) return qualificationResponse;
        if (feed.trends.some((trend) => trend.audioUrl === url)) {
          return new Response("counter blocked", { status: 503 });
        }
        if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
          return new Response(signedPlaybackHtml(now), { status: 200 });
        }
        if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
        const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
        if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
        if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
        assert.fail(`unexpected partial discovery URL ${url}`);
      },
    });

  assert.equal(result.status.discoveryAudit.candidateCount, 161);
  assert.equal(result.status.discoveryAudit.currentMatchedCount, 1);
  assert.equal(result.status.discoveryAudit.qualificationAudit.freshQualifiedCount, 3);
  assert.equal(result.status.discoveryAudit.qualifiedClusterCount, 3);
  assert.equal(result.status.discoveryAudit.qualifiedInventoryCount, 3);
  assert.equal(result.status.discoveryAudit.publishedInventoryCount, 50);
  assert.equal(result.status.discoveryAudit.complete, true);
  assert.equal(result.status.published, true);
  assert.deepEqual(feed, original);
});

test("old video evidence cannot be relabelled as a fresh audio qualification", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  videoTrendFeed.refresh.discoveryAudit.scannedAt = new Date(
    Date.parse(now) - 27 * 60 * 60 * 1_000,
  ).toISOString();

  let failure;
  try {
    await buildAudioTrendRefresh({
      feed,
      videoTrendFeed,
      now,
      discoverySources: TEST_DISCOVERY_SOURCES,
      fetchImpl: async (url) => completeDiscoveryResponse(url) ??
        new Response("blocked", { status: 503 }),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(failure.refreshStatus.status, "failed");
  assert.equal(failure.refreshStatus.published, false);
  assert.equal(
    failure.refreshStatus.discoveryAudit.qualificationAudit.videoDiscoveryAuditFresh,
    false,
  );
  assert.equal(
    failure.refreshStatus.discoveryAudit.qualificationAudit.freshQualifiedCount,
    0,
  );
  assert.equal(failure.refreshStatus.discoveryAudit.qualifiedInventoryCount, 0);
  assert.deepEqual(feed, original);
});

test("missing Instagram playback is audited but cannot veto editorial qualification", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const missingReferenceUrl = instagramTrends[0].referenceVideo.url;
  const result = await buildAudioTrendRefresh({
      feed,
      videoTrendFeed,
      now,
      discoverySources: TEST_DISCOVERY_SOURCES,
      fetchImpl: async (url) => {
        const discoveryResponse = completeDiscoveryResponse(url);
        if (discoveryResponse) return discoveryResponse;
        const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
        if (qualificationResponse) return qualificationResponse;
        if (feed.trends.some((trend) => trend.audioUrl === url) || url === missingReferenceUrl) {
          return new Response("blocked", { status: 503 });
        }
        if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
          return new Response(signedPlaybackHtml(now), { status: 200 });
        }
        if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
        const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
        if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
        if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
        assert.fail(`unexpected partial refresh URL ${url}`);
      },
    });

  assert.equal(result.status.status, "success");
  assert.equal(result.status.coverage.instagramPlaybackMatched, instagramTrends.length - 1);
  assert.equal(result.status.coverage.instagramPlaybackComplete, false);
  assert.equal(result.status.coverage.tiktokThumbnailComplete, true);
  assert.equal(result.status.published, true);
  assert.deepEqual(feed, original);
});

test("missing TikTok thumbnail is audited but cannot establish or veto qualification", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const videoTrendFeed = freshCurrentQualificationVideoFeed(now);
  const instagramTrends = feed.trends.filter((trend) => trend.platform === "instagram");
  const tiktokTrends = feed.trends.filter((trend) => trend.platform === "tiktok");
  const missingThumbnailUrl = tiktokThumbnailUrl(tiktokTrends[0]);
  const result = await buildAudioTrendRefresh({
      feed,
      videoTrendFeed,
      now,
      discoverySources: TEST_DISCOVERY_SOURCES,
      fetchImpl: async (url) => {
        const discoveryResponse = completeDiscoveryResponse(url);
        if (discoveryResponse) return discoveryResponse;
        const qualificationResponse = freshQualificationOEmbedResponse(url, videoTrendFeed);
        if (qualificationResponse) return qualificationResponse;
        const counterTrend = feed.trends.find((trend) => trend.audioUrl === url);
        if (counterTrend) {
          return new Response(counterHtml(counterTrend, latestUses(counterTrend)), { status: 200 });
        }
        if (instagramTrends.some((trend) => trend.referenceVideo.url === url)) {
          return new Response(signedPlaybackHtml(now), { status: 200 });
        }
        if (String(url).includes(".cdninstagram.com/")) return playbackProbeResponse();
        const thumbnailTrend = tiktokTrendFromOEmbedRequest(url);
        if (thumbnailTrend) return Response.json(tiktokOEmbedPayload(thumbnailTrend));
        if (url === missingThumbnailUrl) return new Response("missing", { status: 404 });
        if (String(url).includes(".tiktokcdn.com/")) return thumbnailProbeResponse();
        assert.fail(`unexpected thumbnail coverage URL ${url}`);
      },
    });

  assert.equal(result.status.status, "success");
  assert.equal(result.status.coverage.counterPublishable, true);
  assert.equal(result.status.coverage.instagramPlaybackComplete, true);
  assert.equal(result.status.coverage.tiktokThumbnailMatched, tiktokTrends.length - 1);
  assert.equal(
    result.status.coverage.tiktokThumbnailCoverage,
    (tiktokTrends.length - 1) / tiktokTrends.length,
  );
  assert.equal(result.status.coverage.tiktokThumbnailComplete, false);
  assert.equal(result.status.coverage.thumbnailPublishable, false);
  const tiktokProvider = result.status.providers.find((provider) => provider.platform === "tiktok");
  assert.equal(tiktokProvider.thumbnailMatched, tiktokTrends.length - 1);
  assert.equal(
    tiktokProvider.thumbnailCoverage,
    (tiktokTrends.length - 1) / tiktokTrends.length,
  );
  assert.match(
    tiktokProvider.errors.join(" "),
    new RegExp(
      `miniatures insuffisante: ${tiktokTrends.length - 1}\\/${tiktokTrends.length}`,
      "i",
    ),
  );
  assert.equal(result.status.published, true);
  assert.deepEqual(feed, original);
});

test("one successful counter can never publish over the last validated feed", async () => {
  const original = structuredClone(feed);
  const now = new Date(Date.parse(feed.capturedAt) + 25 * 60 * 60 * 1_000).toISOString();
  const soleSuccess = feed.trends.find((trend) => trend.platform === "tiktok");
  assert.ok(soleSuccess);

  let failure;
  try {
    await buildAudioTrendRefresh({
      feed,
      now,
      fetchImpl: async (url) => url === soleSuccess.audioUrl
        ? new Response(counterHtml(soleSuccess, latestUses(soleSuccess)), { status: 200 })
        : new Response("blocked", { status: 503 }),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(failure.refreshStatus.published, false);
  assert.equal(failure.refreshStatus.coverage.totalMatched, 1);
  assert.equal(failure.refreshStatus.coverage.instagramPlaybackMatched, 0);
  assert.deepEqual(feed, original);
});

test("the scheduled audio refresh publishes every validated data-only commit", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/social-refresh-audio-trends.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /permissions:\s*\n\s*contents: write\s*\n\s*actions: write/u);
  assert.match(workflow, /if: steps\.commit\.outputs\.changed == 'true'/u);
  assert.match(workflow, /gh workflow run deploy-pages\.yml --ref main/u);
  assert.match(workflow, /requested_sha="\$\(git rev-parse HEAD\)"/u);
});
