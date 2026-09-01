import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES,
  assertPlaylistPromoFeed,
  latestPlaylistPromoObservation,
  playlistPromoLikeDelta,
} from "../lib/playlist-promos.ts";

const rawFeed = JSON.parse(
  await readFile(new URL("../data/playlist-promos/feed.json", import.meta.url), "utf8"),
);
const feed = assertPlaylistPromoFeed(rawFeed);
const seeds = JSON.parse(
  await readFile(new URL("../data/playlist-promos/seeds.json", import.meta.url), "utf8"),
);

const expectedMetrics = new Map([
  ["DUjAoDvgKKr", { likes: 65_581, comments: 400, views: 1_509_383, duration: 13.5 }],
  ["DQevwh_ALiN", { likes: 20_181, comments: 150, views: 574_685, duration: 15.1 }],
  ["DMgEeBDMCUu", { likes: 100_483, comments: 747, views: 2_674_086, duration: 13.744 }],
  ["DMgEc7_sw-G", { likes: 58_663, comments: 464, views: 1_613_361, duration: 13.744 }],
  ["DNf3CrAgzjb", { likes: 41_387, comments: 203, views: 3_735_384, duration: 13.166 }],
  ["DVn4p70jJnZ", { likes: 89_057, comments: 2_322, views: 7_937_590, duration: 8.52 }],
  ["DLDyqsnsxuJ", { likes: 147_173, comments: 1_744, views: 6_211_803, duration: 19.285 }],
  ["DWgklGZAPfq", { likes: 187_830, comments: 639, views: 8_856_621, duration: 11.608 }],
  ["DLDyuqVsyNE", { likes: 22_915, comments: 399, views: 2_120_672, duration: 19.178 }],
  ["DQxJ_rTjGGI", { likes: 61_088, comments: 302, views: 1_328_816, duration: 9.634 }],
  ["DayGHrKgp0Y", { likes: 27_424, comments: 266, views: 227_162, duration: 21.733 }],
  ["DWNmRftjCzG", { likes: 10_985, comments: 105, views: 250_881, duration: 19.828 }],
  ["DIfys_hM9tZ", { likes: 9_736, comments: 58, views: 196_759, duration: 18.069 }],
  ["DIOeX1KMHlJ", { likes: 48_564, comments: 100, views: 2_179_381, duration: 11.678 }],
  ["DD6wy0vg8fs", { likes: 106_656, comments: 455, views: 4_682_984, duration: 13.837 }],
  ["DVVLL7XAIrK", { likes: 111_038, comments: 357, views: 1_650_605, duration: 14.764 }],
]);

test("the playlist promo feed validates and preserves the sixteen exact probes", () => {
  const trackedItems = [...feed.items, ...feed.candidates];
  const enabledSeeds = seeds.seeds.filter((seed) => seed.enabled);
  assert.equal(trackedItems.length, enabledSeeds.length);
  assert.deepEqual(
    new Set(trackedItems.map((item) => item.id)),
    new Set(enabledSeeds.map((seed) => seed.id)),
  );
  assert.equal(feed.assetBriefs.length, 6);
  assert.equal(feed.minimumOrganicLikes, 10_000);

  for (const item of trackedItems) {
    const shortcode = new URL(item.url).pathname.split("/").filter(Boolean).at(-1);
    const expected = expectedMetrics.get(shortcode);
    assert.ok(expected, `unexpected shortcode ${shortcode}`);
    const observation = item.observations[0];
    assert.ok(observation);
    assert.equal(observation.likes, expected.likes);
    assert.equal(observation.comments, expected.comments);
    assert.equal(observation.views, expected.views);
    assert.equal(item.durationSeconds, expected.duration);
    assert.equal(observation.precision, "exact");
    assert.equal(observation.metricScope, "native-post");
    const latest = latestPlaylistPromoObservation(item);
    if (feed.items.includes(item)) assert.ok(latest.likes >= PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES);
    else assert.ok(latest.likes < PLAYLIST_PROMO_MINIMUM_ORGANIC_LIKES);
  }
});

test("paid status is proven independently from native social proof", () => {
  for (const item of [...feed.items, ...feed.candidates]) {
    assert.equal(item.lane, "paid");
    assert.equal(item.paidStatus, "verified-paid");
    assert.equal(item.productType, "ad");
    assert.match(item.paidEvidence, /product_type=ad/u);
    assert.equal(latestPlaylistPromoObservation(item).metricScope, "native-post");
    assert.equal(item.reachBand, null);
  }
  assert.match(feed.methodology, /post natif/u);
  assert.match(feed.methodology, /ne mesurent ni les impressions payées, ni les clics, ni les conversions/u);
});

test("all local thumbnails referenced by the feed exist", async () => {
  for (const item of [...feed.items, ...feed.candidates]) {
    assert.ok(item.thumbnailUrl);
    await access(new URL(`../public/${item.thumbnailUrl}`, import.meta.url));
  }
});

test("asset briefs require fully human original production and avoid unsupported health claims", () => {
  const unsafeCopy = /(?:baisse(?:r)?\s+le\s+cortisol|guéri|soigne|traitement|endor(?:s|mir).*\b(?:5|cinq)\s+minutes)/iu;
  for (const brief of feed.assetBriefs) {
    const guardrails = brief.guardrails.join(" ");
    assert.match(guardrails, /100 % humain/iu);
    assert.match(
      guardrails,
      /\b(?:aucun|aucune|sans)\b[^.]{0,120}\b(?:IA générative|généré(?:e|es|s)? par IA|génération IA)\b/iu,
    );
    const publicCopy = [
      brief.title,
      brief.hook,
      brief.onScreenCopy,
      brief.cta,
      ...brief.shotList,
    ].join(" ");
    assert.doesNotMatch(publicCopy, unsafeCopy);
  }
});

test("the validator enforces ten thousand native likes even in the paid lane", () => {
  const invalid = structuredClone(feed);
  invalid.items[0].observations.at(-1).likes = 9_999;
  assert.throws(() => assertPlaylistPromoFeed(invalid), /Seuil de likes non atteint/u);

  const paidDeliveryOnly = structuredClone(feed);
  paidDeliveryOnly.items[0].observations.at(-1).metricScope = "ad-delivery";
  assert.throws(
    () => assertPlaylistPromoFeed(paidDeliveryOnly),
    /likes qualifiants doivent venir du post natif/u,
  );

  const promotableCandidate = structuredClone(feed);
  promotableCandidate.candidates[0].observations.at(-1).likes = 10_000;
  assert.throws(() => assertPlaylistPromoFeed(promotableCandidate), /Candidat déjà qualifié/u);
});

test("the validator rejects a product_type ad assigned to an organic lane", () => {
  const invalid = structuredClone(feed);
  invalid.items[0].lane = "organic";
  assert.throws(() => assertPlaylistPromoFeed(invalid), /Statut paid incohérent/u);
});

test("like deltas require two observations with the same precision", () => {
  const item = structuredClone(feed.candidates[0]);
  item.observations = [item.observations.at(-1)];
  assert.equal(playlistPromoLikeDelta(item), null);
  const firstObservation = item.observations[0];
  item.observations.push({
    ...firstObservation,
    capturedAt: new Date(Date.parse(firstObservation.capturedAt) + 24 * 3_600_000).toISOString(),
    likes: firstObservation.likes + 125,
  });
  assert.deepEqual(playlistPromoLikeDelta(item), { likes: 125, elapsedHours: 24 });
  item.observations[1].precision = "platform-rounded";
  assert.equal(playlistPromoLikeDelta(item), null);
});
