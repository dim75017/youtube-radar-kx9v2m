import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SCROLLING_BROWSER_CONTEXT,
  SCROLLING_MINIMUM_LIKES,
  assertScrollingFeed,
  assertScrollingThemeCatalog,
} from "../lib/scrolling.ts";

const rawFeed = JSON.parse(
  await readFile(new URL("../data/scrolling/feed.json", import.meta.url), "utf8"),
);
const rawThemes = JSON.parse(
  await readFile(new URL("../data/scrolling/themes.json", import.meta.url), "utf8"),
);
const feed = assertScrollingFeed(rawFeed, rawThemes);
const themes = assertScrollingThemeCatalog(rawThemes);

const expectedSources = new Map([
  ["DZia5FeumDj", { author: "houseofvocal", likes: 350_700 }],
  ["DbYjkQPtJn6", { author: "electronicmusic.official", likes: 239_800 }],
  ["DbCKZ4GBz7u", { author: "musictravellove", likes: 75_400 }],
  ["Db8r9u4D15T", { author: "lofigirl", likes: 53_700 }],
  ["DcNWAhVFDnJ", { author: "paulvandyk", likes: 23_600 }],
  ["Davd2wNtfmU", { author: "djnamedpaul", likes: 75_900 }],
  ["DZAFvCNp226", { author: "edmhouse.us", likes: 65_100 }],
  ["DaMlY1vs5Yu", { author: "iavrilspain", likes: 24_100 }],
  ["DcD1rswtT6U", { author: "edmhousenetwork", likes: 17_400 }],
  ["DabIJvSzbdq", { author: "_morphflex", likes: 75_800 }],
  ["DcJYmaNupbm", { author: "edmmusic", likes: 27_900 }],
  ["DcYi4EjDBXq", { author: "armadamusic", likes: 12_200 }],
  ["DZ7c-mFsOji", { author: "maddixmusic", likes: 71_400 }],
  ["DcWN5YevqHv", { author: "travelwithsidd14", likes: 597_200 }],
  ["DbG5osCg9QE", { author: "the_galixx", likes: 38_500 }],
  ["DbtJiXXxfjW", { author: "royyschneider", likes: 74_500 }],
  ["DbYSNmZItaC", { author: "annikaverwest", likes: 180_700 }],
  ["DcBfcbAIXvC", { author: "wildlife.ayush", likes: 39_300 }],
  ["DbV5t3Eqz_j", { author: "llama.5060060", likes: 28_700 }],
  ["DZR-b4sIhTR", { author: "condsty", likes: 108_400 }],
  ["DcdlfsWoorn", { author: "bloodytincture", likes: 21_300 }],
  ["DZRlrpLSBC2", { author: "finding.unforgettable.songs", likes: 18_300 }],
  ["Dce3sikyoqt", { author: "theangelicanero", likes: 268_800 }],
  ["DcEN_awjpoC", { author: "edmmusic", likes: 50_800 }],
  ["DcXA1WNCCNO", { author: "nature_aroundclock", likes: 102_000 }],
  ["Dcf8s00gWRD", { author: "winxclub", likes: 81_800 }],
  ["Db89Cn4hrAX", { author: "subtronics", likes: 37_700 }],
  ["DcgN-zooXp4", { author: "cyberpunkgame", likes: 26_200 }],
  ["DcfW6l-iHAF", { author: "thescenicgamerofficial", likes: 23_700 }],
  ["DcJuyWRvjnK", { author: "rebbford", likes: 10_600 }],
]);

test("the connected Instagram snapshot preserves all three private runs", () => {
  assert.match(feed.capturedAt, /^2026-08-26/u);
  assert.equal(feed.minimumLikes, SCROLLING_MINIMUM_LIKES);
  assert.equal(feed.runs.length, 3);
  assert.equal(feed.items.length, 30);

  const initialRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26");
  const extendedRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26-extended");
  const eveningRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26-evening");
  assert.ok(initialRun);
  assert.ok(extendedRun);
  assert.ok(eveningRun);
  assert.equal(initialRun.platform, "instagram");
  assert.equal(initialRun.surface, "home");
  assert.equal(initialRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(initialRun.seenCount, 28);
  assert.equal(initialRun.qualifyingCount, 8);
  assert.equal(initialRun.sponsoredCount, 0);
  assert.equal(extendedRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(extendedRun.seenCount, 504);
  assert.equal(extendedRun.qualifyingCount, 236);
  assert.equal(extendedRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === extendedRun.id).length, 16);
  assert.ok(feed.items.filter((item) => item.runId === extendedRun.id).length < extendedRun.qualifyingCount);
  assert.equal(eveningRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(eveningRun.seenCount, 151);
  assert.equal(eveningRun.qualifyingCount, 53);
  assert.equal(eveningRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === eveningRun.id).length, 6);
  assert.ok(feed.items.filter((item) => item.runId === eveningRun.id).length < eveningRun.qualifyingCount);
  assert.ok(Date.parse(eveningRun.capturedAt) > Date.parse(extendedRun.capturedAt));
  assert.equal(feed.capturedAt, eveningRun.capturedAt);

  let likes = 0;
  for (const item of feed.items) {
    const expected = expectedSources.get(item.source.postId);
    assert.ok(expected, `unexpected source ${item.source.postId}`);
    assert.equal(item.source.author, expected.author);
    assert.equal(item.source.metrics.likes, expected.likes);
    assert.equal(item.source.metrics.precision, "platform-rounded");
    assert.equal(item.source.metrics.views, null);
    assert.equal(item.source.metrics.comments, null);
    assert.equal(item.source.metrics.shares, null);
    assert.equal(item.source.metrics.saves, null);
    assert.equal(item.source.thumbnailUrl, null);
    assert.ok(item.source.sponsored === null || item.source.sponsored === false);
    assert.ok(item.source.metrics.likes >= SCROLLING_MINIMUM_LIKES);
    likes += item.source.metrics.likes;
  }
  assert.equal(likes, [...expectedSources.values()].reduce((sum, source) => sum + source.likes, 0));
});

test("the exploration taxonomy is broad and distinguishes observed lenses from future probes", () => {
  assert.equal(themes.explorationLenses.length, 30);
  assert.deepEqual(themes.explorationLenses, feed.explorationLenses);
  assert.equal(feed.explorationLenses.filter((lens) => lens.observedInSnapshot).length, 20);
  assert.equal(
    feed.explorationLenses.find((lens) => lens.id === "animal-companions")?.observedInSnapshot,
    true,
  );
  for (const newlyObserved of [
    "lore-pov-mini-episodes",
    "easter-eggs-and-alternate-rooms",
    "cozy-games-rpg-worlds",
  ]) {
    assert.equal(
      feed.explorationLenses.find((lens) => lens.id === newlyObserved)?.observedInSnapshot,
      true,
    );
  }
  for (const required of [
    "study-exams-pomodoro",
    "adhd-focus-rituals",
    "sleep-insomnia-bedtime",
    "work-coding-creative-block",
    "cafe-train-commute-travel",
    "lore-pov-mini-episodes",
    "cozy-games-rpg-worlds",
    "beatmaking-process",
    "fan-art-and-spotlights",
    "visual-formats-lab",
  ]) {
    assert.ok(feed.explorationLenses.some((lens) => lens.id === required), `missing lens ${required}`);
  }
});

test("every Lofi adaptation keeps the canonical companion and bans generated media", () => {
  for (const item of feed.items) {
    const { character, companion } = item.adaptation.cast;
    if (character === "lofi-girl") assert.equal(companion, "cat");
    if (character === "lofi-boy") assert.equal(companion, "dog");
    if (character === "both") assert.equal(companion, "cat-and-dog");
    const guardrails = item.adaptation.productionGuardrails.join(" ");
    assert.match(guardrails, /100\s*%\s*humaine?/iu);
    assert.match(guardrails, /Aucune image, vidéo, voix ou musique générée par IA/iu);
    assert.ok(item.adaptation.sequence.length >= 3);
  }
});

test("the validator refuses a classic browser profile or any authentication material", () => {
  const classicProfile = structuredClone(feed);
  classicProfile.runs[0].browserContext = "default-profile";
  assert.throws(
    () => assertScrollingFeed(classicProfile),
    /navigation privée explicitement confiée obligatoire/u,
  );

  const withCookie = structuredClone(feed);
  withCookie.runs[0].cookie = "forbidden";
  assert.throws(() => assertScrollingFeed(withCookie), /donnée d’authentification interdite/u);
});

test("the validator keeps unknown metrics nullable and refuses invented or weak likes", () => {
  const nullable = structuredClone(feed);
  nullable.items[0].source.metrics.views = null;
  assert.doesNotThrow(() => assertScrollingFeed(nullable));

  const missingLikes = structuredClone(feed);
  missingLikes.items[0].source.metrics.likes = null;
  missingLikes.items[0].source.metrics.precision = "unavailable";
  assert.throws(() => assertScrollingFeed(missingLikes), /Seuil de likes non atteint/u);

  const weakLikes = structuredClone(feed);
  weakLikes.items[0].source.metrics.likes = 9_999;
  assert.throws(() => assertScrollingFeed(weakLikes), /Seuil de likes non atteint/u);
});

test("the validator rejects duplicate sources, external media and inconsistent companions", () => {
  const duplicate = structuredClone(feed);
  duplicate.items[1].source = structuredClone(duplicate.items[0].source);
  assert.throws(() => assertScrollingFeed(duplicate), /Source Scrolling dupliquée/u);

  const externalThumbnail = structuredClone(feed);
  externalThumbnail.items[0].source.thumbnailUrl = "https://scontent.cdninstagram.com/signed.jpg?token=secret";
  assert.throws(
    () => assertScrollingFeed(externalThumbnail),
    /donnée d’authentification interdite|miniature externe ou éphémère refusée/u,
  );

  const wrongAnimal = structuredClone(feed);
  wrongAnimal.items[0].adaptation.cast.companion = "dog";
  assert.throws(() => assertScrollingFeed(wrongAnimal), /personnage et animal incohérents/u);
});

test("the feed and themes catalogue cannot silently diverge", () => {
  const divergentThemes = structuredClone(themes);
  divergentThemes.explorationLenses[0].label = "Changed";
  assert.throws(
    () => assertScrollingFeed(feed, divergentThemes),
    /themes\.json diverge du snapshot Scrolling/u,
  );

  const wrongObservation = structuredClone(feed);
  wrongObservation.explorationLenses.find((lens) => lens.id === "anxiety-and-overthinking").observedInSnapshot = true;
  assert.throws(() => assertScrollingFeed(wrongObservation), /observedInSnapshot incohérent/u);
});

test("the validator separates observed, qualified, retained and sponsored counts", () => {
  const tooManyRetained = structuredClone(feed);
  tooManyRetained.runs.find((run) => run.id.endsWith("extended")).qualifyingCount = 15;
  assert.throws(() => assertScrollingFeed(tooManyRetained), /Plus d’idées retenues/u);

  const impossibleSponsoredCount = structuredClone(feed);
  impossibleSponsoredCount.runs.find((run) => run.id.endsWith("extended")).sponsoredCount = 505;
  assert.throws(() => assertScrollingFeed(impossibleSponsoredCount), /sponsoredCount invalide/u);

  const uncountedSponsoredSource = structuredClone(feed);
  uncountedSponsoredSource.items.find((item) => item.runId.endsWith("extended")).source.sponsored = true;
  assert.throws(() => assertScrollingFeed(uncountedSponsoredSource), /sources sponsorisées retenues qu’observées/u);
});

test("the API route validates both snapshots, disables caching and refuses writes", async () => {
  const route = await readFile(new URL("../app/api/scrolling/route.ts", import.meta.url), "utf8");
  assert.match(route, /assertScrollingFeed\(/u);
  assert.match(route, /scrollingThemesJson as ScrollingThemeCatalog/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.match(route, /status: 405/u);
  assert.match(route, /navigation privée explicitement confiée/u);
});
