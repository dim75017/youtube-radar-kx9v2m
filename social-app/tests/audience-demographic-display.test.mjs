import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { audienceDemographicDisplayEntries } from "../lib/audience-demographic-display.mjs";

const snapshot = JSON.parse(
  await readFile(new URL("../data/audience-demographics.json", import.meta.url), "utf8"),
);

test("keeps all seven YouTube age ranges in chronological order", () => {
  const entries = audienceDemographicDisplayEntries(snapshot.platforms.youtube.ages.entries, "ages");

  assert.deepEqual(entries.map((entry) => entry.label), [
    "13–17", "18–24", "25–34", "35–44", "45–54", "55–64", "65+",
  ]);
  assert.ok(entries.every((entry) => entry.reported && entry.share !== null));
});

test("shows Instagram's missing 13–17 range without inventing zero percent", () => {
  const entries = audienceDemographicDisplayEntries(snapshot.platforms.instagram.ages.entries, "ages");

  assert.equal(entries[0].label, "13–17");
  assert.equal(entries[0].reported, false);
  assert.equal(entries[0].share, null);
  assert.deepEqual(entries.slice(1).map((entry) => entry.label), [
    "18–24", "25–34", "35–44", "45–54", "55–64", "65+",
  ]);
});

test("keeps TikTok's native 55+ range merged and flags 13–17 as unreported", () => {
  const entries = audienceDemographicDisplayEntries(snapshot.platforms.tiktok.ages.entries, "ages");

  assert.deepEqual(entries.map((entry) => entry.label), [
    "13–17", "18–24", "25–34", "35–44", "45–54", "55+",
  ]);
  assert.equal(entries[0].share, null);
  assert.equal(entries.at(-1).share, 0.02);
  assert.doesNotMatch(entries.map((entry) => entry.key).join(" "), /age_55_64|age_65_plus/);
});

test("always orders genders female, male, then native residual categories", () => {
  const instagram = audienceDemographicDisplayEntries(
    snapshot.platforms.instagram.genders.entries,
    "genders",
  );
  const tiktok = audienceDemographicDisplayEntries(
    snapshot.platforms.tiktok.genders.entries,
    "genders",
  );

  assert.deepEqual(instagram.map((entry) => entry.key), ["female", "male"]);
  assert.deepEqual(tiktok.map((entry) => entry.key), ["female", "male", "other"]);
  assert.equal(tiktok.at(-1).share, 0);
  assert.equal(tiktok.at(-1).reported, true, "a native 0% remains distinct from missing data");
});
