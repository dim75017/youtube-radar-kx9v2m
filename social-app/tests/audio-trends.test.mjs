import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS,
  MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES,
  MIN_PUBLISHABLE_AUDIO_TRENDS,
  assertAudioTrendFeed,
  deriveAudioTrendGrowth,
  isAudioTrendThumbnailExpired,
  isCachedAudioTrendThumbnailUrl,
  isPublishableAudioTrendReferenceVideo,
  isOfficialAudioTrendThumbnailUrl,
  isInstagramSignedPlaybackUrl,
  isNativeAudioReferenceVideoUrl,
  isNativeAudioTrendUrl,
} from "../lib/audio-trends.ts";

const storedFeed = JSON.parse(
  await readFile(new URL("../data/audio-trends/feed.json", import.meta.url), "utf8"),
);

function thresholdCompliantFixture(feed) {
  const fixture = structuredClone(feed);
  for (const trend of fixture.trends) {
    if (isPublishableAudioTrendReferenceVideo(trend.referenceVideo)) continue;
    trend.referenceVideo.metrics.likes = MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES;
    trend.referenceVideo.durationSeconds =
      MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS - 0.001;
  }
  return fixture;
}

const bootstrapFeed = thresholdCompliantFixture(storedFeed);

test("the published audio feed uses stable local frames instead of expiring CDN previews", async () => {
  const thumbnails = storedFeed.trends
    .map((trend) => trend.referenceVideo.thumbnailUrl)
    .filter((thumbnailUrl) => thumbnailUrl !== null);

  assert.ok(
    thumbnails.length >= storedFeed.trends.length - 1,
    "at most one audio card may use the explicit visual fallback",
  );
  assert.ok(thumbnails.every((thumbnailUrl) => isCachedAudioTrendThumbnailUrl(thumbnailUrl)));

  for (const thumbnailUrl of thumbnails) {
    const frame = await stat(new URL(`../public/${thumbnailUrl}`, import.meta.url));
    assert.ok(frame.isFile());
    assert.ok(frame.size > 0);
  }
});

function validProposals() {
  return [
    { id: "quiet-start", title: "Quiet start", concept: "Lofi Girl follows the whisper with one precise library action.", copy: "Start quietly.", character: "lofi-girl", tone: "cozy" },
    { id: "wrong-shelf", title: "Wrong shelf", concept: "The whispered line reveals that Lofi Girl studied the wrong shelf.", copy: "Wrong chapter.", character: "lofi-girl", tone: "funny" },
    { id: "two-minute-rule", title: "Two-minute rule", concept: "The whisper cues Lofi Girl to begin with two minutes of reading.", copy: "Two minutes first.", character: "lofi-girl", tone: "smart" },
    { id: "library-light", title: "Library light", concept: "Each whispered word turns on one pool of light around Lofi Girl.", copy: "Follow the light.", character: "lofi-girl", tone: "cinematic" },
    { id: "silent-room", title: "Silent room", concept: "Lofi Girl hears every tiny sound once the whisper stops.", copy: "Libraries are never silent.", character: "lofi-girl", tone: "relatable" },
    { id: "cat-whisper", title: "Cat whisper", concept: "The whisper comes from the cat hidden behind Lofi Girl's books.", copy: "Mystery solved.", character: "lofi-girl", tone: "cat" },
    { id: "stealth-quest", title: "Stealth quest", concept: "Lofi Boy treats the whispered library rule like a stealth-game objective.", copy: "Stealth mode enabled.", character: "lofi-boy", tone: "gaming" },
  ];
}

function instagramPlaybackUrl(expiresAt) {
  const encodedExpiry = Math.floor(Date.parse(expiresAt) / 1_000).toString(16).toUpperCase();
  return `https://scontent-cdg4-1.cdninstagram.com/o1/v/t2/f2/m86/reference.mp4?_nc_ht=scontent-cdg4-1.cdninstagram.com&oh=0123456789abcdef0123456789abcdef&oe=${encodedExpiry}&vs=1&_nc_vs=1`;
}

function validTrend() {
  return {
    id: "instagram-library-whisper",
    platform: "instagram",
    type: "spoken",
    title: "Library whisper",
    author: "@quietcreator",
    audioUrl: "https://www.instagram.com/reels/audio/123456789012345/",
    source: {
      capturedAt: "2026-08-11T11:00:00.000Z",
      label: "Instagram · page audio native",
      url: "https://www.instagram.com/reels/audio/123456789012345/",
      exactness: "exact",
    },
    referenceVideo: {
      author: "@quietcreator",
      caption: "the library is never actually silent",
      url: "https://www.instagram.com/reel/AbCdEfGhIjK/",
      thumbnailUrl: "https://scontent-cdg4-1.cdninstagram.com/v/t51.29350-15/reference.webp",
      durationSeconds: 12.4,
      publishedAt: "2026-08-10T09:00:00.000Z",
      capturedAt: "2026-08-11T11:00:00.000Z",
      sourceLabel: "Instagram · vidéo et compteurs publics",
      sourceUrl: "https://www.instagram.com/reel/AbCdEfGhIjK/",
      exactness: "platform-estimate",
      metrics: {
        views: 800000,
        likes: 90000,
        comments: null,
        shares: null,
      },
    },
    usageObservations: [
      {
        capturedAt: "2026-08-10T11:00:00.000Z",
        uses: 1000,
        rank: null,
        rankWindow: null,
        sourceLabel: "Instagram · page audio native",
        sourceUrl: "https://www.instagram.com/reels/audio/123456789012345/",
        exactness: "exact",
      },
      {
        capturedAt: "2026-08-11T11:00:00.000Z",
        uses: 1300,
        rank: null,
        rankWindow: null,
        sourceLabel: "Instagram · page audio native",
        sourceUrl: "https://www.instagram.com/reels/audio/123456789012345/?locale=fr_FR",
        exactness: "exact",
      },
    ],
    reuseEvidence: {
      verifiedAt: "2026-08-11T11:00:00.000Z",
      minimumDistinctCreators: 3,
      summary: "Le même audio a été vérifié dans trois Reels publiés par trois créateurs distincts.",
      posts: [
        { platform: "instagram", author: "@quietcreator", url: "https://www.instagram.com/reel/AbCdEfGhIjK/", capturedAt: "2026-08-11T11:00:00.000Z" },
        { platform: "instagram", author: "@libraryfriend", url: "https://www.instagram.com/reel/LmNoPqRsTuV/", capturedAt: "2026-08-11T11:00:00.000Z" },
        { platform: "instagram", author: "@nightreader", url: "https://www.instagram.com/reel/WxYz0123456/", capturedAt: "2026-08-11T11:00:00.000Z" },
      ],
    },
    lofiFitScore: 94,
    lofiAngle: "Lofi Girl coupe sa musique une seconde pour identifier le chuchotement impossible au fond de la bibliothèque.",
    lofiFitRationale: "Le dialogue court se transpose naturellement dans une scène de bibliothèque avec Lofi Girl.",
    proposals: validProposals(),
  };
}

function paddingTrend(index) {
  const trend = validTrend();
  const suffix = String(index).padStart(4, "0");
  const audioId = String(9_000_000_000_000_000 + index);
  trend.id = `padding-audio-trend-${suffix}`;
  trend.audioUrl = `https://www.instagram.com/reels/audio/${audioId}/`;
  trend.source.url = trend.audioUrl;
  trend.referenceVideo.url = `https://www.instagram.com/reel/PadRef${suffix}/`;
  trend.referenceVideo.sourceUrl = trend.referenceVideo.url;
  trend.usageObservations = trend.usageObservations.map((observation, observationIndex) => ({
    ...observation,
    sourceUrl: observationIndex === 0
      ? trend.audioUrl
      : `${trend.audioUrl}?locale=fr_FR`,
  }));
  trend.reuseEvidence.posts = ["a", "b", "c"].map((letter) => ({
    platform: "instagram",
    author: `@padding-${suffix}-${letter}`,
    url: `https://www.instagram.com/reel/Pad${suffix}${letter}/`,
    capturedAt: "2026-08-11T11:00:00.000Z",
  }));
  return trend;
}

function feedWith(...trends) {
  const feed = structuredClone(bootstrapFeed);
  feed.sourceChecks[0] = {
    id: "instagram-audio-native",
    platform: "instagram",
    status: "success",
    checkedAt: "2026-08-11T11:00:00.000Z",
    label: "Instagram Reels · pages audio natives",
    sourceUrl: "https://www.instagram.com/reels/",
  };
  feed.trends = [
    ...trends,
    ...Array.from(
      { length: Math.max(0, MIN_PUBLISHABLE_AUDIO_TRENDS - trends.length) },
      (_, index) => paddingTrend(index + 1),
    ),
  ];
  return feed;
}

test("a threshold-compliant feed contains sourced audio signals without invented growth", () => {
  assert.equal(assertAudioTrendFeed(bootstrapFeed), bootstrapFeed);
  assert.equal(bootstrapFeed.version, 1);
  assert.equal(bootstrapFeed.cadenceHours, 24);
  assert.equal(bootstrapFeed.trends.length, MIN_PUBLISHABLE_AUDIO_TRENDS);
  const platformCounts = new Map(
    ["instagram", "tiktok", "youtube"].map((platform) => [
      platform,
      bootstrapFeed.trends.filter((trend) => trend.platform === platform).length,
    ]),
  );
  assert.equal(
    [...platformCounts.values()].reduce((total, count) => total + count, 0),
    MIN_PUBLISHABLE_AUDIO_TRENDS,
  );
  assert.ok([...platformCounts.values()].every((count) => count > 0));
  assert.ok(bootstrapFeed.trends.every((trend) => trend.lofiAngle.length > 0));
  assert.equal(
    bootstrapFeed.trends.reduce((total, trend) => total + trend.proposals.length, 0),
    350,
  );
  for (const trend of bootstrapFeed.trends) {
    assert.equal(trend.proposals.length, 7, trend.id);
    assert.equal(new Set(trend.proposals.map((proposal) => proposal.id)).size, 7, trend.id);
    assert.equal(new Set(trend.proposals.map((proposal) => proposal.title)).size, 7, trend.id);
    assert.equal(new Set(trend.proposals.map((proposal) => proposal.concept)).size, 7, trend.id);
    assert.equal(new Set(trend.proposals.map((proposal) => proposal.copy)).size, 7, trend.id);
    assert.ok(
      trend.proposals.filter((proposal) => proposal.character === "lofi-girl").length >= 6,
      trend.id,
    );
    assert.ok(trend.reuseEvidence.minimumDistinctCreators >= 3, trend.id);
    assert.ok(new Set(
      trend.reuseEvidence.posts.map((post) => post.author.replace(/^@/u, "").toLowerCase()),
    ).size >= 3, trend.id);
    assert.ok(new Set(trend.reuseEvidence.posts.map((post) => post.url)).size >= 3, trend.id);
  }
  assert.ok(bootstrapFeed.trends.every((trend) => !("growth" in trend)));
  assert.deepEqual(
    new Set(bootstrapFeed.sourceChecks.map((check) => check.platform)),
    new Set(["instagram", "tiktok", "youtube"]),
  );
  assert.ok(
    bootstrapFeed.sourceChecks.every((check) =>
      ["success", "failed", "limited"].includes(check.status)
    ),
  );
  assert.ok(
    bootstrapFeed.trends
      .filter((trend) => trend.platform === "instagram")
      .every(
        (trend) =>
          trend.referenceVideo.playbackUrl &&
          trend.referenceVideo.playbackCapturedAt &&
          trend.referenceVideo.playbackExpiresAt,
      ),
  );
  const trendsWithMeasuredGrowth = bootstrapFeed.trends.filter((trend) =>
    deriveAudioTrendGrowth(trend.usageObservations)
  );
  assert.ok(trendsWithMeasuredGrowth.length >= 3);
});

test("the publishable inventory accepts 50 distinct trends and rejects 49", () => {
  assert.equal(assertAudioTrendFeed(bootstrapFeed), bootstrapFeed);
  const incomplete = structuredClone(bootstrapFeed);
  incomplete.trends = incomplete.trends.slice(0, MIN_PUBLISHABLE_AUDIO_TRENDS - 1);
  assert.throws(
    () => assertAudioTrendFeed(incomplete),
    /au moins 50 tendances distinctes/i,
  );
});

test("TikTok music slug and case variants cannot bypass native-audio deduplication", () => {
  const duplicated = structuredClone(bootstrapFeed);
  const firstTikTokIndex = duplicated.trends.findIndex((trend) => trend.platform === "tiktok");
  const secondTikTokIndex = duplicated.trends.findIndex((trend, index) =>
    index > firstTikTokIndex && trend.platform === "tiktok"
  );
  const first = duplicated.trends[firstTikTokIndex];
  const second = duplicated.trends[secondTikTokIndex];
  const musicId = first.audioUrl.match(/(\d{8,24})\/?$/u)?.[1];
  assert.ok(musicId);
  second.audioUrl = `https://m.tiktok.com/music/DIFFERENT-SLUG-${musicId}?lang=en`;
  second.source.url = second.audioUrl;

  assert.throws(() => assertAudioTrendFeed(duplicated), /audio natif dupliqué/i);
});

test("reference videos fail closed below 50,000 likes or outside the sub-30-second window", () => {
  for (const likes of [null, MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES - 1]) {
    const trend = validTrend();
    trend.referenceVideo.metrics.likes = likes;
    assert.equal(isPublishableAudioTrendReferenceVideo(trend.referenceVideo), false);
    assert.throws(
      () => assertAudioTrendFeed(feedWith(trend)),
      /at least 50000 public likes are required/i,
    );
  }

  for (const durationSeconds of [null, 0, MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS]) {
    const trend = validTrend();
    trend.referenceVideo.durationSeconds = durationSeconds;
    assert.equal(isPublishableAudioTrendReferenceVideo(trend.referenceVideo), false);
    assert.throws(
      () => assertAudioTrendFeed(feedWith(trend)),
      /(?:reference video|r.f.rence audio)/i,
    );
  }

  const boundary = validTrend();
  boundary.referenceVideo.metrics.likes = MIN_AUDIO_TREND_REFERENCE_VIDEO_LIKES;
  boundary.referenceVideo.durationSeconds =
    MAX_AUDIO_TREND_REFERENCE_VIDEO_DURATION_SECONDS - 0.001;
  assert.equal(isPublishableAudioTrendReferenceVideo(boundary.referenceVideo), true);
  assert.equal(assertAudioTrendFeed(feedWith(boundary)).trends[0].id, boundary.id);
});

test("growth is derived from two comparable usage counters, never stored", () => {
  const trend = validTrend();
  const feed = feedWith(trend);
  assert.equal(assertAudioTrendFeed(feed), feed);
  const growth = deriveAudioTrendGrowth(trend.usageObservations);
  assert.deepEqual(growth, {
    fromCapturedAt: "2026-08-10T11:00:00.000Z",
    toCapturedAt: "2026-08-11T11:00:00.000Z",
    fromUses: 1000,
    toUses: 1300,
    deltaUses: 300,
    growthPercent: 30,
    elapsedHours: 24,
    usesPerDay: 300,
    exactness: "exact",
    sourceUrl: "https://www.instagram.com/reels/audio/123456789012345/",
  });

  const storedGrowth = structuredClone(feed);
  storedGrowth.trends[0].growth = growth;
  assert.throws(() => assertAudioTrendFeed(storedGrowth), /champ inattendu/i);
});

test("one counter, rank-only evidence and incomparable counters never imply growth", () => {
  const trend = validTrend();
  const [first, second] = trend.usageObservations;
  assert.equal(deriveAudioTrendGrowth([first]), null);
  assert.equal(deriveAudioTrendGrowth([
    { ...first, uses: null, rank: 2, rankWindow: "7d" },
    { ...second, uses: null, rank: 1, rankWindow: "7d" },
  ]), null);
  assert.equal(deriveAudioTrendGrowth([
    first,
    { ...second, sourceUrl: "https://www.instagram.com/reels/audio/999999999999999/" },
  ]), null);
  assert.equal(deriveAudioTrendGrowth([
    first,
    { ...second, exactness: "platform-estimate" },
  ]), null);
});

test("rank and rankWindow can preserve Creative Center evidence without a usage count", () => {
  const trend = validTrend();
  trend.platform = "tiktok";
  trend.id = "tiktok-study-desk-sound";
  trend.type = "music";
  trend.audioUrl = "https://www.tiktok.com/music/study-desk-7412345678901234567";
  trend.source.url = trend.audioUrl;
  trend.source.label = "TikTok · page musique native";
  trend.referenceVideo.url = "https://www.tiktok.com/@deskcreator/video/7412345678901234567";
  trend.referenceVideo.sourceUrl = trend.referenceVideo.url;
  trend.referenceVideo.thumbnailUrl =
    "https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/7412345678901234567.jpeg";
  trend.reuseEvidence.posts = ["deskcreator", "studyfriend", "nightreader"].map(
    (author, index) => ({
      platform: "tiktok",
      author: `@${author}`,
      url: `https://www.tiktok.com/@${author}/video/74123456789012345${67 + index}`,
      capturedAt: "2026-08-11T11:00:00.000Z",
    }),
  );
  trend.usageObservations = [{
    capturedAt: "2026-08-11T11:00:00.000Z",
    uses: null,
    rank: 4,
    rankWindow: "7d",
    sourceLabel: "TikTok Creative Center · Popular Music",
    sourceUrl: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/pc/en",
    exactness: "exact",
  }];
  const feed = feedWith(trend);
  feed.sourceChecks[0].status = "limited";
  feed.sourceChecks[1] = {
    id: "tiktok-creative-center",
    platform: "tiktok",
    status: "success",
    checkedAt: "2026-08-11T11:00:00.000Z",
    label: "TikTok Creative Center · Popular Music",
    sourceUrl: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/pc/en",
  };
  assert.equal(assertAudioTrendFeed(feed), feed);
  assert.equal(deriveAudioTrendGrowth(trend.usageObservations), null);
});

test("native audio and video URLs are platform-bound", () => {
  assert.equal(
    isNativeAudioTrendUrl("https://www.instagram.com/reels/audio/123456789/", "instagram"),
    true,
  );
  assert.equal(
    isNativeAudioTrendUrl("https://www.tiktok.com/music/original-sound-7412345678901234567", "tiktok"),
    true,
  );
  assert.equal(
    isNativeAudioTrendUrl("https://www.youtube.com/source/AbCdEfGhI_j/shorts", "youtube"),
    true,
  );
  assert.equal(
    isNativeAudioReferenceVideoUrl("https://www.youtube.com/shorts/AbCdEfGhI_j", "youtube"),
    true,
  );
  assert.equal(
    isNativeAudioTrendUrl("https://example.com/audio/123", "instagram"),
    false,
  );
  assert.equal(
    isNativeAudioReferenceVideoUrl("https://www.youtube.com/shorts/AbCdEfGhI_j", "tiktok"),
    false,
  );
});

test("publishable reference metrics must be present, sourced and non-fabricated", () => {
  const withoutMetrics = validTrend();
  withoutMetrics.referenceVideo.metrics = null;
  withoutMetrics.referenceVideo.exactness = "unavailable";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(withoutMetrics)),
    /at least 50000 public likes are required/i,
  );

  const unavailableWithMetrics = validTrend();
  unavailableWithMetrics.referenceVideo.exactness = "unavailable";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(unavailableWithMetrics)),
    /inventées/i,
  );

  const emptyMetrics = validTrend();
  emptyMetrics.referenceVideo.metrics = {
    views: null,
    likes: null,
    comments: null,
    shares: null,
  };
  assert.throws(() => assertAudioTrendFeed(feedWith(emptyMetrics)), /vides/i);

  const foreignMetricSource = validTrend();
  foreignMetricSource.referenceVideo.sourceUrl = "https://example.com/post/1";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(foreignMetricSource)),
    /vidéo de référence/i,
  );
});

test("reference thumbnails are restricted to official platform CDNs", () => {
  assert.equal(
    isOfficialAudioTrendThumbnailUrl("media/audio-trends/quiet-library.webp", "instagram"),
    true,
  );
  assert.equal(isCachedAudioTrendThumbnailUrl("media/audio-trends/quiet-library.webp"), true);
  assert.equal(isCachedAudioTrendThumbnailUrl("media/audio-trends/../secret.webp"), false);
  assert.equal(isCachedAudioTrendThumbnailUrl("/media/audio-trends/quiet-library.webp"), false);
  assert.equal(
    isOfficialAudioTrendThumbnailUrl(
      "https://scontent-cdg4-1.cdninstagram.com/v/t51.29350-15/reference.webp",
      "instagram",
    ),
    true,
  );
  assert.equal(
    isOfficialAudioTrendThumbnailUrl(
      "https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/reference.jpeg",
      "tiktok",
    ),
    true,
  );
  assert.equal(
    isOfficialAudioTrendThumbnailUrl(
      "https://p16.muscdn.com/obj/tos-maliva-p-0068/reference",
      "tiktok",
    ),
    true,
  );
  assert.equal(
    isOfficialAudioTrendThumbnailUrl(
      "https://scontent-cdg4-1.cdninstagram.com/reference.webp",
      "tiktok",
    ),
    false,
  );
  assert.equal(
    isOfficialAudioTrendThumbnailUrl("https://images.example.test/reference.webp", "instagram"),
    false,
  );

  const foreignThumbnail = validTrend();
  foreignThumbnail.referenceVideo.thumbnailUrl = "https://images.example.test/reference.webp";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(foreignThumbnail)),
    /r.f.rence audio invalide/i,
  );

  const crossPlatformThumbnail = validTrend();
  crossPlatformThumbnail.referenceVideo.thumbnailUrl =
    "https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/reference.jpeg";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(crossPlatformThumbnail)),
    /r.f.rence audio invalide/i,
  );
});

test("expired signed TikTok thumbnails fail before rendering while cached frames stay valid", () => {
  const now = Date.parse("2026-08-25T08:00:00.000Z");
  assert.equal(
    isAudioTrendThumbnailExpired(
      "https://p16-sign-va.tiktokcdn.com/frame.jpeg?x-expires=1787288400&x-signature=old",
      now,
    ),
    true,
  );
  assert.equal(
    isAudioTrendThumbnailExpired(
      `https://p16-sign-va.tiktokcdn.com/frame.jpeg?x-expires=${Math.floor((now + 30_000) / 1_000)}&x-signature=soon`,
      now,
    ),
    true,
  );
  assert.equal(
    isAudioTrendThumbnailExpired(
      `https://p16-sign-va.tiktokcdn.com/frame.jpeg?x-expires=${Math.floor((now + 3_600_000) / 1_000)}&x-signature=fresh`,
      now,
    ),
    false,
  );
  assert.equal(
    isAudioTrendThumbnailExpired(
      "https://p16-sign-va.tiktokcdn.com/frame.jpeg?x-signature=missing-expiry",
      now,
    ),
    true,
  );
  assert.equal(
    isAudioTrendThumbnailExpired("media/audio-trends/quiet-library.webp", now),
    false,
  );
  assert.equal(
    isAudioTrendThumbnailExpired("https://i.ytimg.com/vi/AbCdEfGhI_j/hqdefault.jpg", now),
    false,
  );
});

test("signed Instagram playback is atomic, short-lived and restricted to scontent CDN", () => {
  const trend = validTrend();
  const capturedAt = new Date(
    Date.parse(bootstrapFeed.capturedAt) - 60 * 60 * 1_000,
  ).toISOString();
  const expiresAt = new Date(
    Date.parse(bootstrapFeed.capturedAt) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  trend.referenceVideo.playbackUrl = instagramPlaybackUrl(expiresAt);
  trend.referenceVideo.playbackCapturedAt = capturedAt;
  trend.referenceVideo.playbackExpiresAt = expiresAt;
  assert.equal(isInstagramSignedPlaybackUrl(trend.referenceVideo.playbackUrl, expiresAt), true);
  const signedFeed = feedWith(trend);
  assert.equal(assertAudioTrendFeed(signedFeed), signedFeed);

  const partial = validTrend();
  partial.referenceVideo.playbackUrl = instagramPlaybackUrl(expiresAt);
  assert.throws(() => assertAudioTrendFeed(feedWith(partial)), /lecture Instagram sign/i);

  const foreignHost = validTrend();
  foreignHost.referenceVideo.playbackUrl = instagramPlaybackUrl(expiresAt)
    .replace("scontent-cdg4-1.cdninstagram.com", "media.example.com");
  foreignHost.referenceVideo.playbackCapturedAt = capturedAt;
  foreignHost.referenceVideo.playbackExpiresAt = expiresAt;
  assert.throws(() => assertAudioTrendFeed(feedWith(foreignHost)), /lecture Instagram sign/i);

  const mismatchedExpiry = structuredClone(trend);
  mismatchedExpiry.referenceVideo.playbackExpiresAt = new Date(
    Date.parse(expiresAt) - 60 * 60 * 1_000,
  ).toISOString();
  assert.throws(() => assertAudioTrendFeed(feedWith(mismatchedExpiry)), /lecture Instagram sign/i);
});

test("usage validation rejects invented, ambiguous and chronologically invalid evidence", () => {
  const unavailableWithUses = validTrend();
  unavailableWithUses.usageObservations[0].exactness = "unavailable";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(unavailableWithUses)),
    /observation d'usage/i,
  );

  const rankWithoutWindow = validTrend();
  rankWithoutWindow.usageObservations[0].uses = null;
  rankWithoutWindow.usageObservations[0].rank = 3;
  assert.throws(
    () => assertAudioTrendFeed(feedWith(rankWithoutWindow)),
    /observation d'usage/i,
  );

  const negativeUses = validTrend();
  negativeUses.usageObservations[0].uses = -1;
  assert.throws(
    () => assertAudioTrendFeed(feedWith(negativeUses)),
    /observation d'usage/i,
  );

  const futureObservation = validTrend();
  futureObservation.usageObservations[1].capturedAt = "2100-01-01T00:00:00.000Z";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(futureObservation)),
    /observation d'usage/i,
  );
});

test("metadata provenance, platform sources and native audio identities are strict", () => {
  const foreignAudio = validTrend();
  foreignAudio.audioUrl = "https://example.com/audio/123";
  assert.throws(() => assertAudioTrendFeed(feedWith(foreignAudio)), /trend audio invalide/i);

  const mismatchedProvenance = validTrend();
  mismatchedProvenance.source.url = "https://www.instagram.com/reels/audio/999999999999999/";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(mismatchedProvenance)),
    /provenance audio/i,
  );

  const duplicated = validTrend();
  const copy = structuredClone(duplicated);
  copy.id = "instagram-library-whisper-copy";
  assert.throws(() => assertAudioTrendFeed(feedWith(duplicated, copy)), /dupliqué/i);

  const pendingWithTimestamp = structuredClone(bootstrapFeed);
  pendingWithTimestamp.sourceChecks[0].status = "pending";
  pendingWithTimestamp.sourceChecks[0].checkedAt = bootstrapFeed.capturedAt;
  assert.throws(
    () => assertAudioTrendFeed(pendingWithTimestamp),
    /contrôle de source/i,
  );

  const missingLofiAngle = validTrend();
  missingLofiAngle.lofiAngle = "";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(missingLofiAngle)),
    /trend audio invalide/i,
  );
});

test("audio editorial proposals require seven distinct concepts with a Lofi Girl focus", () => {
  const missingProposal = validTrend();
  missingProposal.proposals.pop();
  assert.throws(
    () => assertAudioTrendFeed(feedWith(missingProposal)),
    /trend audio invalide/i,
  );

  const duplicateId = validTrend();
  duplicateId.proposals[1].id = duplicateId.proposals[0].id;
  assert.throws(
    () => assertAudioTrendFeed(feedWith(duplicateId)),
    /proposition audio invalide/i,
  );

  const invalidTone = validTrend();
  invalidTone.proposals[0].tone = "generic";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(invalidTone)),
    /proposition audio invalide/i,
  );

  const insufficientGirlFocus = validTrend();
  insufficientGirlFocus.proposals[1].character = "lofi-boy";
  assert.throws(
    () => assertAudioTrendFeed(feedWith(insufficientGirlFocus)),
    /focus Lofi Girl insuffisant/i,
  );
});
