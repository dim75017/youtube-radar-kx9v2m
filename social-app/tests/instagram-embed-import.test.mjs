import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCertifiedInstagramImport,
  deriveInstagramPublishedAt,
  detectInstagramAccessBlock,
  hasCompactPublicCounter,
  mediaIdFromInstagramShortcode,
  normalizeInstagramManifest,
  parseInstagramEmbedHtml,
  parseInstagramOgHead,
} from "../scripts/import_instagram_embeds.mjs";

const INSTAGRAM_EPOCH_MS = 1_314_220_021_721n;

function mediaIdFor(iso) {
  return String(((BigInt(Date.parse(iso)) - INSTAGRAM_EPOCH_MS) << 23n) + 123n);
}

test("normalizes and deduplicates Instagram profile URLs by shortcode", () => {
  const manifest = normalizeInstagramManifest({
    updatedAt: "2026-08-05T20:26:26.164Z",
    urls: [
      "https://www.instagram.com//lofigirl/p/Static_One/",
      "https://www.instagram.com/lofigirl/p/Static_One/",
      "https://www.instagram.com/lofigirl/reel/Reel-Two/",
    ],
  });

  assert.equal(manifest.rawUrlCount, 3);
  assert.equal(manifest.uniqueShortcodeCount, 2);
  assert.equal(manifest.duplicateUrlCount, 1);
  assert.deepEqual(manifest.items.map((item) => [item.shortcode, item.kind]), [
    ["Static_One", "p"],
    ["Reel-Two", "reel"],
  ]);
  assert.equal(manifest.items[0].embedUrl, "https://www.instagram.com/p/Static_One/embed/captioned/?_fb_noscript=1");
  assert.match(manifest.hash, /^[a-f0-9]{64}$/);
});

test("parses factual fields from a minimal captioned embed", () => {
  const expectedDate = "2026-08-01T12:34:56.789Z";
  const mediaId = mediaIdFor(expectedDate);
  const html = `
    <html><body>
      <article data-ios-link="media?id=${mediaId}">
        <img class="EmbeddedMediaImage other" src="https://scontent.cdninstagram.com/photo.jpg?sig=1">
        <div class="Caption"><a>@lofigirl</a> Cozy &amp; calm ☕</div>
        <div class="SocialProof">1,234 likes</div>
        <div class="Comments">View all 56 comments</div>
      </article>
    </body></html>`;
  const parsed = parseInstagramEmbedHtml(html, { shortcode: "Fixture" });

  assert.equal(parsed.mediaId, mediaId);
  assert.equal(parsed.publishedAt, expectedDate);
  assert.equal(parsed.publishedAtPrecision, "approximate");
  assert.equal(parsed.publishedAtSource, "derived-media-id");
  assert.equal(parsed.caption, "Cozy & calm ☕");
  assert.equal(parsed.likes, 1_234);
  assert.equal(parsed.comments, 56);
  assert.equal(parsed.imageUrl, "https://scontent.cdninstagram.com/photo.jpg?sig=1");
});

test("decodes the Instagram base64url shortcode when media?id is absent", () => {
  const expectedMediaId = mediaIdFromInstagramShortcode("DbTkIwQjlPk");
  const parsed = parseInstagramEmbedHtml(`
    <body>
      <img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/fallback.jpg">
      <div class="Caption">Fallback ID</div>
    </body>`, { shortcode: "DbTkIwQjlPk" });
  assert.equal(parsed.mediaId, expectedMediaId);
  assert.equal(parsed.publishedAt, deriveInstagramPublishedAt(expectedMediaId));
  assert.equal(parsed.publishedAtPrecision, "approximate");
});

test("prefers factual day, caption and counters from direct-page OG metadata", () => {
  const parsed = parseInstagramOgHead(`
    <head>
      <meta property="og:description" content="7,738 likes, 42 comments - lofigirl on September 27, 2025: &quot;Study &amp;amp; relax ☕&quot;.">
      <meta property="og:image" content="https://scontent.cdninstagram.com/proof.jpg">
    </head>`, { shortcode: "DPHQuquiQW6" });
  assert.equal(parsed.likes, 7_738);
  assert.equal(parsed.comments, 42);
  assert.equal(parsed.caption, "Study & relax ☕");
  assert.equal(parsed.publishedAt, "2025-09-27T12:00:00.000Z");
  assert.equal(parsed.publishedAtSource, "instagram-og-description");
  assert.equal(parsed.publishedDatePrecision, "day");
  assert.equal(parsed.publishedAtPrecision, "approximate");
});

test("accepts collaborative posts attributed to another Instagram account", () => {
  const parsed = parseInstagramOgHead(
    '<head><meta property="og:description" content="1,411 likes, 20 comments - lofigirlshop on November 13, 2025: &quot;Fireplace season&quot;."></head>',
    { shortcode: "DRAWnBmjynM" },
  );
  assert.equal(parsed.authorUsername, "lofigirlshop");
  assert.equal(parsed.likes, 1_411);
  assert.equal(parsed.comments, 20);
  assert.equal(parsed.caption, "Fireplace season");
  assert.equal(parsed.publishedAt, "2025-11-13T12:00:00.000Z");
});

test("detects compact counters until an exact embed refinement replaces them", () => {
  const compact = {
    ogDescription: '46K likes, 166 comments - lofigirl on October 17, 2025: "Post".',
  };
  assert.equal(hasCompactPublicCounter(compact), true);
  assert.equal(hasCompactPublicCounter({
    ...compact,
    likesPrecision: "exact-embed",
    commentsPrecision: "exact-embed",
  }), false);
  assert.equal(hasCompactPublicCounter({
    ...compact,
    likesPrecision: "compact-public-only",
    commentsPrecision: "exact-og",
  }), false);
  assert.equal(hasCompactPublicCounter({
    ogDescription: '7,738 likes, 42 comments - lofigirl on September 27, 2025: "Post".',
  }), false);
});

test("keeps hidden metrics null and reads structured public counts", () => {
  const mediaId = mediaIdFor("2024-02-01T00:00:00.000Z");
  const withoutCounts = parseInstagramEmbedHtml(`
    <body><div data-ios-link="media?id=${mediaId}">
      <img class="EmbeddedMediaImage" src="https://scontent.xx.fbcdn.net/image.jpg">
      <div class="Caption">lofigirl just the caption</div>
    </div></body>`);
  assert.equal(withoutCounts.likes, null);
  assert.equal(withoutCounts.comments, null);

  const structured = parseInstagramEmbedHtml(`
    <body><div data-ios-link="media?id=${mediaId}">
      <img class="EmbeddedMediaImage" src="https://scontent.xx.fbcdn.net/image.jpg">
      <script type="application/json">{"like_count":0,"comments_count":12}</script>
    </div></body>`);
  assert.equal(structured.likes, 0);
  assert.equal(structured.comments, 12);
});

test("detects login walls and rate limits explicitly", () => {
  assert.equal(detectInstagramAccessBlock({ status: 429, html: "" }), "rate-limited");
  assert.equal(
    detectInstagramAccessBlock({ status: 200, html: "<title>Login • Instagram</title>" }),
    "login-required",
  );
  assert.equal(
    detectInstagramAccessBlock({
      status: 200,
      html: '<meta property="og:description" content="1 like, 0 comments - lofigirl on January 1, 2026">challenge_required',
    }),
    null,
  );
  assert.equal(
    detectInstagramAccessBlock({ status: 200, url: "https://www.instagram.com/challenge/" }),
    "login-required",
  );
  assert.equal(detectInstagramAccessBlock({ status: 200, html: "<body>Public embed</body>" }), null);
});

test("certified import appends and enriches Instagram without touching other platforms", () => {
  const manifest = normalizeInstagramManifest({
    updatedAt: "2026-08-05T20:26:26.164Z",
    completedAt: "2026-08-05T20:26:26.164Z",
    endReached: true,
    expectedCount: 2,
    links: [
      { kind: "p", url: "https://www.instagram.com/lofigirl/p/Existing/" },
      { kind: "reel", url: "https://www.instagram.com/lofigirl/reel/NewReel/" },
    ],
  });
  const firstMediaId = mediaIdFor("2025-01-01T10:00:00.000Z");
  const secondMediaId = mediaIdFor("2026-01-01T10:00:00.000Z");
  const completedAt = "2026-08-06T12:00:00.000Z";
  const progress = {
    version: 1,
    account: "lofigirl",
    manifest: {
      source: manifest.source,
      sourceUpdatedAt: manifest.sourceUpdatedAt,
      sourceCompletedAt: manifest.completedAt,
      endReached: true,
      expectedCount: 2,
      rawUrlCount: manifest.rawUrlCount,
      duplicateUrlCount: manifest.duplicateUrlCount,
      uniqueShortcodeCount: manifest.uniqueShortcodeCount,
      hash: manifest.hash,
    },
    collection: {
      provider: "instagram-public-captioned-embed",
      startedAt: "2026-08-06T11:00:00.000Z",
      completedAt,
      certified: true,
      okCount: 2,
      unavailableCount: 0,
      errorCount: 0,
      pendingCount: 0,
    },
    items: {
      Existing: {
        shortcode: "Existing",
        kind: "p",
        canonicalUrl: "https://www.instagram.com/lofigirl/p/Existing/",
        embedUrl: "https://www.instagram.com/p/Existing/embed/captioned/?_fb_noscript=1",
        stableThumbnailUrl: "https://www.instagram.com/p/Existing/media/?size=l",
        status: "ok",
        observedAt: completedAt,
        post: {
          mediaId: firstMediaId,
          caption: "Updated caption",
          imageUrl: "https://scontent.cdninstagram.com/existing.jpg",
          publishedAt: deriveInstagramPublishedAt(firstMediaId),
          likes: 25,
          comments: 4,
          publishedAtPrecision: "approximate",
          publishedAtSource: "derived-media-id",
          publishedAtFormula: "(mediaId >> 23) + 1314220021721",
        },
      },
      NewReel: {
        shortcode: "NewReel",
        kind: "reel",
        canonicalUrl: "https://www.instagram.com/lofigirl/reel/NewReel/",
        embedUrl: "https://www.instagram.com/reel/NewReel/embed/captioned/?_fb_noscript=1",
        stableThumbnailUrl: "https://www.instagram.com/p/NewReel/media/?size=l",
        status: "ok",
        observedAt: completedAt,
        post: {
          mediaId: secondMediaId,
          caption: null,
          imageUrl: null,
          publishedAt: deriveInstagramPublishedAt(secondMediaId),
          likes: null,
          comments: null,
          publishedAtPrecision: "approximate",
          publishedAtSource: "derived-media-id",
          publishedAtFormula: "(mediaId >> 23) + 1314220021721",
        },
      },
    },
  };
  const youtube = {
    platform: "youtube",
    externalId: "keep-me",
    url: "https://www.youtube.com/shorts/keep-me",
    title: "Untouched",
    text: null,
    format: "short",
    thumbnailUrl: null,
    publishedAt: "2026-01-02T00:00:00.000Z",
    views: 10,
    likes: 2,
    comments: 1,
    shares: null,
    saves: null,
    raw: { exact: true },
  };
  const existingInstagram = {
    platform: "instagram",
    externalId: "Existing",
    url: "https://www.instagram.com/lofigirl/p/Existing/",
    title: "Old",
    text: "Old",
    format: "static",
    thumbnailUrl: null,
    publishedAt: null,
    views: null,
    likes: 10,
    comments: null,
    shares: null,
    saves: null,
    raw: {
      firstObservedAt: "2026-07-01T00:00:00.000Z",
      lastObservedAt: "2026-07-01T00:00:00.000Z",
      metricHistory: [{
        capturedAt: "2026-07-01T00:00:00.000Z",
        views: null,
        likes: 10,
        comments: null,
        shares: null,
        saves: null,
        pollVotes: null,
        source: "legacy",
      }],
    },
  };
  const snapshot = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    coverage: [],
    posts: [youtube, existingInstagram],
  };
  const result = buildCertifiedInstagramImport({ snapshot, progress, manifest });
  const imported = result.snapshot.posts.filter((post) => post.platform === "instagram");

  assert.equal(result.summary.finalInstagramPosts, 2);
  assert.equal(result.summary.inserted, 1);
  assert.equal(result.summary.updated, 1);
  assert.deepEqual(result.snapshot.posts.find((post) => post.platform === "youtube"), youtube);
  assert.equal(imported.find((post) => post.externalId === "Existing").likes, 25);
  assert.equal(imported.find((post) => post.externalId === "Existing").raw.metricHistory.length, 2);
  assert.equal(imported.find((post) => post.externalId === "NewReel").likes, null);
  assert.equal(imported.find((post) => post.externalId === "NewReel").views, null);
  assert.equal(imported.find((post) => post.externalId === "NewReel").thumbnailUrl, "https://www.instagram.com/p/NewReel/media/?size=l");
  assert.equal(result.snapshot.coverage[0].status, "complete-public-profile");
  assert.equal(result.snapshot.coverage[0].itemCount, 2);
});

test("refuses an uncertified Instagram import", () => {
  const manifest = normalizeInstagramManifest({
    updatedAt: "2026-08-05T20:26:26.164Z",
    urls: ["https://www.instagram.com/lofigirl/p/Pending/"],
  });
  assert.throws(
    () => buildCertifiedInstagramImport({
      snapshot: { generatedAt: "2026-08-05T00:00:00.000Z", coverage: [], posts: [] },
      manifest,
      progress: {
        version: 1,
        account: "lofigirl",
        manifest: { ...manifest, uniqueShortcodeCount: 1, rawUrlCount: 1 },
        collection: { provider: "instagram-public-captioned-embed", certified: false, pendingCount: 1, errorCount: 0 },
        items: {},
      },
    }),
    /n'est pas certifié complet|n'est pas certifiée complète/i,
  );
});
