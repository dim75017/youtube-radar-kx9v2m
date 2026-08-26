import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertPlaylistPromoSeeds,
  buildPlaylistPromoRefresh,
  canonicalInstagramPostUrl,
  instagramEmbedUrl,
  instagramShortcodeFromUrl,
  parseInstagramPlaylistPromoEmbed,
  refreshPlaylistPromos,
} from "../scripts/refresh-playlist-promos.mjs";

const storedFeed = JSON.parse(
  await readFile(new URL("../data/playlist-promos/feed.json", import.meta.url), "utf8"),
);
const storedSeeds = JSON.parse(
  await readFile(new URL("../data/playlist-promos/seeds.json", import.meta.url), "utf8"),
);
const storedStatus = JSON.parse(
  await readFile(new URL("../data/playlist-promos/refresh-status.json", import.meta.url), "utf8"),
);

function shortcode(item) {
  return instagramShortcodeFromUrl(item.url);
}

function postFromItem(item, overrides = {}) {
  const observation = item.observations.at(-1);
  return {
    shortcode: shortcode(item),
    author: item.author,
    caption: item.caption,
    likes: observation.likes,
    comments: observation.comments,
    views: observation.views,
    durationSeconds: item.durationSeconds,
    productType: item.productType,
    typename: "GraphVideo",
    dimensions: { width: 1080, height: 1920 },
    ...overrides,
  };
}

function embedHtml(post) {
  const captionEdges = post.caption
    ? [{ node: { text: post.caption } }]
    : [];
  return `<!doctype html><script>window.__additionalDataLoaded('extra',${JSON.stringify({
    gql_data: {
      shortcode_media: {
        shortcode: post.shortcode,
        __typename: post.typename,
        dimensions: post.dimensions,
        owner: { username: post.author },
        edge_liked_by: { count: post.likes },
        edge_media_to_comment: { count: post.comments },
        video_view_count: post.views,
        video_duration: post.durationSeconds,
        product_type: post.productType,
        edge_media_to_caption: { edges: captionEdges },
      },
    },
  })});</script>`;
}

function successfulResults(feed = storedFeed) {
  return feed.items.map((item) => ({
    seedId: item.id,
    status: "success",
    post: postFromItem(item),
  }));
}

test("Instagram URL helpers canonicalize only attributable native posts", () => {
  assert.equal(
    instagramShortcodeFromUrl("https://www.instagram.com/reel/DUjAoDvgKKr/?igsi=abc"),
    "DUjAoDvgKKr",
  );
  assert.equal(
    canonicalInstagramPostUrl("https://instagram.com/reels/DUjAoDvgKKr/"),
    "https://www.instagram.com/p/DUjAoDvgKKr/",
  );
  assert.equal(
    instagramEmbedUrl("https://www.instagram.com/p/DUjAoDvgKKr/"),
    "https://www.instagram.com/p/DUjAoDvgKKr/embed/captioned/?_fb_noscript=1",
  );
  assert.equal(canonicalInstagramPostUrl("https://example.com/p/DUjAoDvgKKr/"), null);
});

test("the embed parser reads exact public gql_data fields", () => {
  const item = storedFeed.items[0];
  const expected = postFromItem(item);
  const parsed = parseInstagramPlaylistPromoEmbed(embedHtml(expected), {
    expectedShortcode: expected.shortcode,
  });
  assert.deepEqual(parsed, expected);

  const captionless = postFromItem(storedFeed.items.at(-1), { caption: "" });
  assert.equal(
    parseInstagramPlaylistPromoEmbed(embedHtml(captionless), {
      expectedShortcode: captionless.shortcode,
    }).caption,
    "",
  );
});

test("the embed parser fails closed on wrong identity or incomplete counters", () => {
  const post = postFromItem(storedFeed.items[0]);
  assert.throws(
    () => parseInstagramPlaylistPromoEmbed(embedHtml(post), { expectedShortcode: "Wrong123" }),
    /non attribuable/u,
  );
  assert.throws(
    () => parseInstagramPlaylistPromoEmbed(embedHtml({ ...post, views: null }), {
      expectedShortcode: post.shortcode,
    }),
    /Vues exactes absentes/u,
  );
  assert.throws(
    () => parseInstagramPlaylistPromoEmbed(embedHtml({ ...post, productType: "unknown" }), {
      expectedShortcode: post.shortcode,
    }),
    /product_type non qualifiable/u,
  );
});

test("seed validation rejects query-bearing or duplicate URLs", () => {
  assert.equal(assertPlaylistPromoSeeds(storedSeeds).seeds.length, 9);
  const query = structuredClone(storedSeeds);
  query.seeds[0].url += "?igsi=tracking";
  assert.throws(() => assertPlaylistPromoSeeds(query), /Seed Pubs playlists invalide/u);

  const duplicate = structuredClone(storedSeeds);
  duplicate.seeds[1].shortcode = duplicate.seeds[0].shortcode;
  duplicate.seeds[1].url = duplicate.seeds[0].url;
  assert.throws(() => assertPlaylistPromoSeeds(duplicate), /Seed Pubs playlists invalide/u);
});

test("a complete refresh appends changed exact metrics and remains idempotent otherwise", () => {
  const now = "2026-08-27T07:54:12.000Z";
  const results = successfulResults();
  results[0].post.likes += 250;
  results[0].post.views += 1_000;
  const refreshed = buildPlaylistPromoRefresh({
    feed: storedFeed,
    seeds: storedSeeds,
    results,
    now,
  });
  assert.equal(refreshed.status.status, "success");
  assert.equal(refreshed.status.updatedCount, 1);
  assert.equal(refreshed.feed.items[0].observations.length, 2);
  assert.equal(refreshed.feed.items[1].observations.length, 1);
  assert.equal(refreshed.feed.items[0].lane, "paid");
  assert.equal(refreshed.feed.items[0].observations.at(-1).metricScope, "native-post");

  const idempotent = buildPlaylistPromoRefresh({
    feed: storedFeed,
    seeds: storedSeeds,
    results: successfulResults(),
    now,
  });
  assert.equal(idempotent.status.updatedCount, 0);
  assert.ok(idempotent.feed.items.every((item) => item.observations.length === 1));
});

test("partial, under-threshold and product_type-mismatched refreshes are rejected", () => {
  const now = "2026-08-27T07:54:12.000Z";
  assert.throws(
    () => buildPlaylistPromoRefresh({
      feed: storedFeed,
      seeds: storedSeeds,
      results: successfulResults().slice(0, 8),
      now,
    }),
    /Refresh incomplet/u,
  );

  const underThreshold = successfulResults();
  underThreshold[0].post.likes = 9_999;
  assert.throws(
    () => buildPlaylistPromoRefresh({
      feed: storedFeed,
      seeds: storedSeeds,
      results: underThreshold,
      now,
    }),
    /10 000 likes non prouvé/u,
  );

  const wrongProductType = successfulResults();
  wrongProductType[0].post.productType = "organic";
  assert.throws(
    () => buildPlaylistPromoRefresh({
      feed: storedFeed,
      seeds: storedSeeds,
      results: wrongProductType,
      now,
    }),
    /product_type inattendu/u,
  );
});

test("the file refresh preserves the last good feed on the first failed response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "playlist-promos-fail-"));
  const feedPath = join(directory, "feed.json");
  const seedsPath = join(directory, "seeds.json");
  const statusPath = join(directory, "refresh-status.json");
  const originalFeed = `${JSON.stringify(storedFeed, null, 2)}\n`;
  try {
    await Promise.all([
      writeFile(feedPath, originalFeed, "utf8"),
      writeFile(seedsPath, `${JSON.stringify(storedSeeds, null, 2)}\n`, "utf8"),
      writeFile(statusPath, `${JSON.stringify(storedStatus, null, 2)}\n`, "utf8"),
    ]);
    await assert.rejects(
      refreshPlaylistPromos({
        feedPath,
        seedsPath,
        statusPath,
        now: "2026-08-27T07:54:12.000Z",
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      }),
      /rate-limited/u,
    );
    assert.equal(await readFile(feedPath, "utf8"), originalFeed);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(status.status, "failed");
    assert.equal(status.preservedLastGoodFeed, true);
    assert.equal(status.lastSuccessfulAt, storedStatus.lastSuccessfulAt);
    assert.equal(status.updatedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the file refresh publishes only after all nine embeds are attributable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "playlist-promos-success-"));
  const feedPath = join(directory, "feed.json");
  const seedsPath = join(directory, "seeds.json");
  const statusPath = join(directory, "refresh-status.json");
  const itemByShortcode = new Map(storedFeed.items.map((item) => [shortcode(item), item]));
  try {
    await Promise.all([
      writeFile(feedPath, `${JSON.stringify(storedFeed, null, 2)}\n`, "utf8"),
      writeFile(seedsPath, `${JSON.stringify(storedSeeds, null, 2)}\n`, "utf8"),
      writeFile(statusPath, `${JSON.stringify(storedStatus, null, 2)}\n`, "utf8"),
    ]);
    const result = await refreshPlaylistPromos({
      feedPath,
      seedsPath,
      statusPath,
      now: "2026-08-27T07:54:12.000Z",
      fetchImpl: async (url) => {
        const requested = new URL(url).pathname.match(
          /^\/p\/([A-Za-z0-9_-]+)\/embed\/captioned\/?$/u,
        )?.[1] ?? null;
        const item = itemByShortcode.get(requested);
        assert.ok(item, `unexpected URL ${url}`);
        return new Response(embedHtml(postFromItem(item)), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    assert.equal(result.status.matchedCount, 9);
    assert.equal(result.status.updatedCount, 0);
    const written = JSON.parse(await readFile(feedPath, "utf8"));
    assert.equal(written.capturedAt, "2026-08-27T07:54:12.000Z");
    assert.ok(written.items.every((item) => item.observations.length === 1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
