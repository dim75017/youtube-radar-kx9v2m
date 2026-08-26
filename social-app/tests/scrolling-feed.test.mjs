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
]);

test("the connected Instagram snapshot preserves the real run and eight qualified sources", () => {
  assert.equal(feed.capturedAt, "2026-08-26");
  assert.equal(feed.minimumLikes, SCROLLING_MINIMUM_LIKES);
  assert.equal(feed.runs.length, 1);
  assert.equal(feed.items.length, 8);

  const [run] = feed.runs;
  assert.equal(run.platform, "instagram");
  assert.equal(run.surface, "home");
  assert.equal(run.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(run.seenCount, 28);
  assert.equal(run.qualifyingCount, 8);

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
    assert.equal(item.source.sponsored, null);
    assert.ok(item.source.metrics.likes >= SCROLLING_MINIMUM_LIKES);
    likes += item.source.metrics.likes;
  }
  assert.equal(likes, 908_300);
});

test("the exploration taxonomy is broad and distinguishes observed lenses from future probes", () => {
  assert.equal(themes.explorationLenses.length, 30);
  assert.deepEqual(themes.explorationLenses, feed.explorationLenses);
  assert.equal(feed.explorationLenses.filter((lens) => lens.observedInSnapshot).length, 6);
  assert.equal(
    feed.explorationLenses.find((lens) => lens.id === "animal-companions")?.observedInSnapshot,
    false,
  );
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
  wrongObservation.explorationLenses.find((lens) => lens.id === "animal-companions").observedInSnapshot = true;
  assert.throws(() => assertScrollingFeed(wrongObservation), /observedInSnapshot incohérent/u);
});

test("the API route validates both snapshots, disables caching and refuses writes", async () => {
  const route = await readFile(new URL("../app/api/scrolling/route.ts", import.meta.url), "utf8");
  assert.match(route, /assertScrollingFeed\(/u);
  assert.match(route, /scrollingThemesJson as ScrollingThemeCatalog/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.match(route, /status: 405/u);
  assert.match(route, /navigation privée explicitement confiée/u);
});
