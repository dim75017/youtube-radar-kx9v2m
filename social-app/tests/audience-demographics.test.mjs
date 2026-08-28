import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS,
  AUDIENCE_DEMOGRAPHICS_PLATFORMS,
  assertAudienceDemographics,
} from "../lib/audience-demographics.ts";

const PUBLIC_SNAPSHOT_URL = new URL(
  "../data/audience-demographics.json",
  import.meta.url,
);

test("validates the closed public demographic snapshot", async () => {
  const snapshot = assertAudienceDemographics(
    JSON.parse(await readFile(PUBLIC_SNAPSHOT_URL, "utf8")),
  );

  assert.equal(snapshot.version, 1);
  assert.deepEqual(AUDIENCE_DEMOGRAPHICS_PLATFORMS, [
    "youtube",
    "instagram",
    "tiktok",
    "x",
  ]);
  assert.deepEqual(AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS, [
    "countries",
    "ages",
    "genders",
  ]);
  assert.equal(snapshot.platforms.youtube.genders.entries[0].share, 0.303);
  const youtubeCountries = snapshot.platforms.youtube.countries.entries;
  assert.equal(youtubeCountries.length, 20);
  assert.ok(youtubeCountries.every((entry) => entry.countryCode !== null));
  assert.deepEqual(
    youtubeCountries.map((entry) => entry.countryCode),
    [
      "US", "BR", "IN", "FR", "CA", "GB", "RU", "DE", "JP", "ID",
      "AU", "AR", "MX", "TW", "VN", "ES", "PH", "PL", "KR", "UA",
    ],
  );
  assert.equal(snapshot.platforms.instagram.ages.entries[1].share, 0.438);
  assert.equal(snapshot.platforms.tiktok.countries.entries.at(-1).countryCode, null);
  assert.equal(snapshot.platforms.x.status, "unavailable");
  assert.equal(snapshot.platforms.x.countries, null);
  assert.equal(snapshot.platforms.x.ages, null);
  assert.equal(snapshot.platforms.x.genders, null);
});

test("keeps provenance per available dimension", async () => {
  const snapshot = assertAudienceDemographics(
    JSON.parse(await readFile(PUBLIC_SNAPSHOT_URL, "utf8")),
  );

  for (const platform of ["youtube", "instagram", "tiktok"]) {
    for (const dimension of AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS) {
      const provenance = snapshot.platforms[platform][dimension].provenance;
      assert.match(provenance.sourceUrl, /^https:\/\//);
      assert.match(provenance.collectedAt, /Z$/);
      assert.ok(provenance.provider);
      assert.ok(provenance.basis);
      assert.ok(provenance.periodLabel);
    }
  }
});

test("ships a local SVG flag for every published country", async () => {
  const snapshot = assertAudienceDemographics(
    JSON.parse(await readFile(PUBLIC_SNAPSHOT_URL, "utf8")),
  );
  const countryCodes = new Set(
    Object.values(snapshot.platforms)
      .flatMap((platform) => platform.countries?.entries ?? [])
      .map((entry) => entry.countryCode)
      .filter(Boolean),
  );

  for (const countryCode of countryCodes) {
    const svg = await readFile(
      new URL(`../public/flags/${countryCode.toLowerCase()}.svg`, import.meta.url),
      "utf8",
    );
    assert.match(svg, /<svg\b/);
    assert.match(svg, /viewBox="0 0 120 90"/);
  }
  const fallback = await readFile(
    new URL("../public/flags/globe.svg", import.meta.url),
    "utf8",
  );
  assert.match(fallback, /<svg\b/);
});

test("requires unique keys, bounded shares, and coherent distribution totals", () => {
  const duplicate = fixture();
  duplicate.platforms.youtube.genders.entries[1].key = "female";
  assert.throws(
    () => assertAudienceDemographics(duplicate),
    /clé dupliquée female/i,
  );

  const outOfRange = fixture();
  outOfRange.platforms.youtube.genders.entries[0].share = 1.1;
  assert.throws(
    () => assertAudienceDemographics(outOfRange),
    /share doit être compris entre 0 et 1/i,
  );

  const incomplete = fixture();
  incomplete.platforms.youtube.genders.entries[0].share = 0.2;
  assert.throws(
    () => assertAudienceDemographics(incomplete),
    /doit totaliser environ 100 %/i,
  );

  const oversizedCountries = fixture();
  oversizedCountries.platforms.youtube.countries.entries[0].share = 0.8;
  assert.throws(
    () => assertAudienceDemographics(oversizedCountries),
    /dépasse 100 %/i,
  );
});

test("requires ISO2 country codes and reserves null for other territories", () => {
  const invalidIso = fixture();
  invalidIso.platforms.youtube.countries.entries[0].countryCode = "USA";
  assert.throws(
    () => assertAudienceDemographics(invalidIso),
    /code ISO2/i,
  );

  const missingIso = fixture();
  missingIso.platforms.youtube.countries.entries[0].countryCode = null;
  assert.throws(
    () => assertAudienceDemographics(missingIso),
    /code ISO2/i,
  );

  const otherWithCode = fixture();
  otherWithCode.platforms.youtube.countries.entries.push({
    key: "other_territories",
    label: "Autres territoires",
    share: 0.01,
    countryCode: "ZZ",
  });
  assert.throws(
    () => assertAudienceDemographics(otherWithCode),
    /null pour Autres/i,
  );

  const countryOnAge = fixture();
  countryOnAge.platforms.youtube.ages.entries[0].countryCode = "FR";
  assert.throws(
    () => assertAudienceDemographics(countryOnAge),
    /null hors pays/i,
  );
});

test("rejects unknown keys, unsafe provenance, and future observations", () => {
  const unknownRoot = fixture();
  unknownRoot.privateExport = "no";
  assert.throws(
    () => assertAudienceDemographics(unknownRoot),
    /clés inconnues/i,
  );

  const unknownEntry = fixture();
  unknownEntry.platforms.youtube.ages.entries[0].raw = {};
  assert.throws(
    () => assertAudienceDemographics(unknownEntry),
    /clés inconnues/i,
  );

  const insecure = fixture();
  insecure.platforms.youtube.ages.provenance.sourceUrl = "http://example.com";
  assert.throws(
    () => assertAudienceDemographics(insecure),
    /URL HTTPS/i,
  );

  const future = fixture();
  future.platforms.youtube.ages.provenance.collectedAt =
    "2026-08-26T10:26:00.000Z";
  assert.throws(
    () => assertAudienceDemographics(future),
    /postérieur à generatedAt/i,
  );
});

test("requires status to describe dimension availability exactly", () => {
  const falselyAvailable = fixture();
  falselyAvailable.platforms.x.status = "available";
  assert.throws(
    () => assertAudienceDemographics(falselyAvailable),
    /status doit être unavailable/i,
  );

  const partial = fixture();
  partial.platforms.youtube.ages = null;
  assert.throws(
    () => assertAudienceDemographics(partial),
    /status doit être partial/i,
  );
  partial.platforms.youtube.status = "partial";
  assert.doesNotThrow(() => assertAudienceDemographics(partial));
});

function fixture() {
  return {
    version: 1,
    generatedAt: "2026-08-26T10:25:00.000Z",
    platforms: {
      youtube: platform("https://www.youtube.com/@LofiGirl"),
      instagram: platform("https://www.instagram.com/lofigirl/"),
      tiktok: platform("https://www.tiktok.com/@lofigirl"),
      x: {
        profileUrl: "https://x.com/lofigirl",
        status: "unavailable",
        countries: null,
        ages: null,
        genders: null,
      },
    },
  };
}

function platform(profileUrl) {
  return {
    profileUrl,
    status: "available",
    countries: dimension([
      { key: "france", label: "France", share: 0.4, countryCode: "FR" },
      { key: "united_states", label: "États-Unis", share: 0.3, countryCode: "US" },
    ]),
    ages: dimension([
      { key: "age_18_24", label: "18–24", share: 0.4, countryCode: null },
      { key: "age_25_34", label: "25–34", share: 0.6, countryCode: null },
    ]),
    genders: dimension([
      { key: "female", label: "Femme", share: 0.5, countryCode: null },
      { key: "male", label: "Homme", share: 0.5, countryCode: null },
    ]),
  };
}

function dimension(entries) {
  return {
    entries,
    provenance: {
      provider: "native-analytics",
      sourceUrl: "https://example.com/native-analytics",
      collectedAt: "2026-08-26T10:24:57.000Z",
      basis: "native-audience-dashboard",
      periodLabel: "28 derniers jours",
    },
  };
}
