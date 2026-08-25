import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIENCE_ANALYTICS_METRIC_KEYS,
  AUDIENCE_ANALYTICS_PERIOD_KEYS,
  AUDIENCE_ANALYTICS_PLATFORMS,
  assertAudienceAnalytics,
  emptyAudienceAnalyticsMetrics,
  emptyAudienceAnalyticsPeriods,
  filterAudienceAnalyticsDaily,
  mergeAudienceAnalytics,
} from "../lib/audience-analytics.ts";

const PROFILE_URLS = {
  youtube: "https://www.youtube.com/@LofiGirl",
  instagram: "https://www.instagram.com/lofigirl/",
  tiktok: "https://www.tiktok.com/@lofigirl",
  x: "https://x.com/lofigirl",
};

test("validates a complete closed version 1 analytics snapshot", () => {
  const snapshot = fixture();
  snapshot.platforms.youtube.lastSuccessfulImportAt = "2026-08-25T10:00:00.000Z";
  snapshot.platforms.youtube.daily.push(dailyPoint(
    "2026-08-24",
    "2026-08-25T10:00:00.000Z",
    { followersTotal: 15_820_270, followersNet: -12, contentViews: 250_000 },
  ));
  snapshot.platforms.youtube.periods["7d"] = periodSnapshot(
    "2026-08-18",
    "2026-08-24",
    "2026-08-25T10:00:00.000Z",
    { followersNet: 351, impressions: 1_250_000 },
  );

  assert.equal(assertAudienceAnalytics(snapshot), snapshot);
  assert.deepEqual(AUDIENCE_ANALYTICS_PLATFORMS, [
    "youtube",
    "instagram",
    "tiktok",
    "x",
  ]);
  assert.deepEqual(AUDIENCE_ANALYTICS_PERIOD_KEYS, [
    "7d",
    "28d",
    "30d",
    "60d",
    "90d",
    "365d",
    "all",
  ]);
  assert.equal(Object.keys(snapshot.platforms.youtube.daily[0].metrics).length, 21);
  assert.deepEqual(
    Object.keys(snapshot.platforms.youtube.daily[0].metrics),
    [...AUDIENCE_ANALYTICS_METRIC_KEYS],
  );
});

test("rejects unknown and missing keys at every public contract boundary", () => {
  const mutations = [
    {
      label: "root",
      mutate: (value) => { value.secret = "no"; },
    },
    {
      label: "platforms",
      mutate: (value) => { value.platforms.facebook = value.platforms.x; },
    },
    {
      label: "platform",
      mutate: (value) => { value.platforms.youtube.cookie = "no"; },
    },
    {
      label: "daily",
      mutate: (value) => {
        value.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
        value.platforms.youtube.daily[0].raw = {};
      },
    },
    {
      label: "periods",
      mutate: (value) => { value.platforms.youtube.periods["14d"] = null; },
    },
    {
      label: "period snapshot",
      mutate: (value) => {
        value.platforms.youtube.periods["7d"] = periodSnapshot();
        value.platforms.youtube.periods["7d"].privateNote = "no";
      },
    },
    {
      label: "metrics",
      mutate: (value) => {
        value.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
        value.platforms.youtube.daily[0].metrics.password = 1;
      },
    },
    {
      label: "provenance",
      mutate: (value) => {
        value.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
        value.platforms.youtube.daily[0].provenance.token = "no";
      },
    },
  ];

  for (const candidate of mutations) {
    const snapshot = fixture();
    candidate.mutate(snapshot);
    assert.throws(
      () => assertAudienceAnalytics(snapshot),
      /clés inconnues/i,
      candidate.label,
    );
  }

  const missingMetric = fixture();
  missingMetric.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
  delete missingMetric.platforms.youtube.daily[0].metrics.reach;
  assert.throws(
    () => assertAudienceAnalytics(missingMetric),
    /manque les clés.*reach/i,
  );

  const missingPeriod = fixture();
  delete missingPeriod.platforms.youtube.periods["28d"];
  assert.throws(
    () => assertAudienceAnalytics(missingPeriod),
    /manque les clés.*28d/i,
  );
});

test("accepts signed follower net changes but rejects other negatives and non-finite values", () => {
  const signed = fixture();
  signed.platforms.instagram.daily.push(dailyPoint(
    "2026-08-24",
    "2026-08-25T09:00:00.000Z",
    { followersNet: -27 },
  ));
  assert.doesNotThrow(() => assertAudienceAnalytics(signed));

  for (const [metric, value, expected] of [
    ["newFollowers", -1, /newFollowers.*négatif/i],
    ["watchTimeSeconds", Number.NaN, /watchTimeSeconds.*fini/i],
    ["impressions", Number.POSITIVE_INFINITY, /impressions.*fini/i],
  ]) {
    const snapshot = fixture();
    snapshot.platforms.instagram.daily.push(dailyPoint("2026-08-24"));
    snapshot.platforms.instagram.daily[0].metrics[metric] = value;
    assert.throws(() => assertAudienceAnalytics(snapshot), expected);
  }
});

test("requires real unique ascending daily dates and ordered period bounds", () => {
  const duplicate = fixture();
  duplicate.platforms.tiktok.daily.push(
    dailyPoint("2026-08-24"),
    dailyPoint("2026-08-24"),
  );
  assert.throws(
    () => assertAudienceAnalytics(duplicate),
    /trié.*sans doublon/i,
  );

  const reversed = fixture();
  reversed.platforms.tiktok.daily.push(
    dailyPoint("2026-08-24"),
    dailyPoint("2026-08-23"),
  );
  assert.throws(
    () => assertAudienceAnalytics(reversed),
    /trié.*sans doublon/i,
  );

  const impossible = fixture();
  impossible.platforms.x.daily.push(dailyPoint("2026-02-30"));
  assert.throws(() => assertAudienceAnalytics(impossible), /date réelle/i);

  const inverted = fixture();
  inverted.platforms.x.periods["30d"] = periodSnapshot(
    "2026-08-24",
    "2026-08-01",
  );
  assert.throws(() => assertAudienceAnalytics(inverted), /plage inversée/i);
});

test("requires safe provenance and timestamps no newer than the snapshot", () => {
  const insecure = fixture();
  insecure.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
  insecure.platforms.youtube.daily[0].provenance.sourceUrl = "http://example.com/export";
  assert.throws(() => assertAudienceAnalytics(insecure), /URL HTTPS/i);

  const zoneless = fixture();
  zoneless.platforms.youtube.daily.push(dailyPoint("2026-08-24"));
  zoneless.platforms.youtube.daily[0].provenance.collectedAt = "2026-08-25T09:00:00";
  assert.throws(() => assertAudienceAnalytics(zoneless), /timestamp ISO.*fuseau/i);

  const futureCollection = fixture();
  futureCollection.platforms.youtube.daily.push(dailyPoint(
    "2026-08-24",
    "2026-08-26T09:00:00.000Z",
  ));
  assert.throws(
    () => assertAudienceAnalytics(futureCollection),
    /postérieur à generatedAt/i,
  );

  const futureImport = fixture();
  futureImport.platforms.youtube.lastSuccessfulImportAt = "2026-08-26T09:00:00.000Z";
  assert.throws(
    () => assertAudienceAnalytics(futureImport),
    /postérieur à generatedAt/i,
  );
});

test("merges idempotently by date and keeps the newest whole observed row", () => {
  const current = fixture("2026-08-25T10:00:00.000Z");
  current.platforms.youtube.lastSuccessfulImportAt = "2026-08-25T09:00:00.000Z";
  current.platforms.youtube.daily.push(dailyPoint(
    "2026-08-24",
    "2026-08-25T09:00:00.000Z",
    { followersTotal: 100, impressions: 500 },
  ));
  current.platforms.youtube.periods["7d"] = periodSnapshot(
    "2026-08-18",
    "2026-08-24",
    "2026-08-25T09:00:00.000Z",
    { impressions: 500 },
  );

  assert.deepEqual(mergeAudienceAnalytics(current, current), current);
  const reordered = structuredClone(current);
  reordered.platforms.youtube.daily[0] = {
    provenance: reordered.platforms.youtube.daily[0].provenance,
    metrics: Object.fromEntries(
      Object.entries(reordered.platforms.youtube.daily[0].metrics).reverse(),
    ),
    date: reordered.platforms.youtube.daily[0].date,
  };
  assert.deepEqual(
    mergeAudienceAnalytics(current, reordered),
    current,
    "JSON property order must not create a false conflict",
  );

  const incoming = fixture("2026-08-25T12:00:00.000Z");
  incoming.platforms.youtube.lastSuccessfulImportAt = "2026-08-25T11:00:00.000Z";
  incoming.platforms.youtube.daily.push(
    dailyPoint(
      "2026-08-23",
      "2026-08-25T11:00:00.000Z",
      { followersTotal: 98 },
    ),
    dailyPoint(
      "2026-08-24",
      "2026-08-25T11:00:00.000Z",
      { followersTotal: 101, impressions: null },
    ),
  );
  incoming.platforms.youtube.periods["7d"] = periodSnapshot(
    "2026-08-18",
    "2026-08-24",
    "2026-08-25T11:00:00.000Z",
    { impressions: 700 },
  );

  const merged = mergeAudienceAnalytics(current, incoming);
  assert.equal(merged.generatedAt, incoming.generatedAt);
  assert.equal(
    merged.platforms.youtube.lastSuccessfulImportAt,
    incoming.platforms.youtube.lastSuccessfulImportAt,
  );
  assert.deepEqual(
    merged.platforms.youtube.daily.map((point) => point.date),
    ["2026-08-23", "2026-08-24"],
  );
  assert.equal(merged.platforms.youtube.daily[1].metrics.followersTotal, 101);
  assert.equal(
    merged.platforms.youtube.daily[1].metrics.impressions,
    null,
    "rows are never blended across provenance records",
  );
  assert.equal(merged.platforms.youtube.periods["7d"].metrics.impressions, 700);
  assert.deepEqual(mergeAudienceAnalytics(merged, incoming), merged);
  assert.equal(current.platforms.youtube.daily[0].metrics.followersTotal, 100);
});

test("rejects profile changes and simultaneous contradictory rows during merge", () => {
  const current = fixture();
  current.platforms.x.daily.push(dailyPoint("2026-08-24"));

  const changedProfile = fixture();
  changedProfile.platforms.x.profileUrl = "https://x.com/another-account";
  assert.throws(
    () => mergeAudienceAnalytics(current, changedProfile),
    /profileUrl ne peut pas changer/i,
  );

  const conflict = fixture();
  conflict.platforms.x.daily.push(dailyPoint(
    "2026-08-24",
    "2026-08-25T09:00:00.000Z",
    { followersTotal: 999 },
  ));
  assert.throws(
    () => mergeAudienceAnalytics(current, conflict),
    /observations différentes au même instant/i,
  );
});

test("filters inclusive calendar periods without filling missing days", () => {
  const daily = [
    dailyPoint("2026-08-01"),
    dailyPoint("2026-08-04"),
    dailyPoint("2026-08-07"),
    dailyPoint("2026-08-10"),
    dailyPoint("2026-08-11"),
  ];

  assert.deepEqual(
    filterAudienceAnalyticsDaily(daily, "7d", "2026-08-10")
      .map((point) => point.date),
    ["2026-08-04", "2026-08-07", "2026-08-10"],
  );
  assert.deepEqual(
    filterAudienceAnalyticsDaily(daily, "all", "2026-08-10")
      .map((point) => point.date),
    ["2026-08-01", "2026-08-04", "2026-08-07", "2026-08-10"],
  );
  assert.throws(
    () => filterAudienceAnalyticsDaily(daily, "14d", "2026-08-10"),
    /Période.*inconnue/i,
  );
  assert.throws(
    () => filterAudienceAnalyticsDaily(daily, "7d", "2026-02-30"),
    /date réelle/i,
  );
});

function fixture(generatedAt = "2026-08-25T12:00:00.000Z") {
  return {
    version: 1,
    generatedAt,
    platforms: Object.fromEntries(
      AUDIENCE_ANALYTICS_PLATFORMS.map((platform) => [
        platform,
        {
          profileUrl: PROFILE_URLS[platform],
          lastSuccessfulImportAt: null,
          daily: [],
          periods: emptyAudienceAnalyticsPeriods(),
        },
      ]),
    ),
  };
}

function dailyPoint(
  date,
  collectedAt = "2026-08-25T09:00:00.000Z",
  metricOverrides = {},
) {
  return {
    date,
    metrics: {
      ...emptyAudienceAnalyticsMetrics(),
      ...metricOverrides,
    },
    provenance: provenance(collectedAt),
  };
}

function periodSnapshot(
  startDate = "2026-08-18",
  endDate = "2026-08-24",
  collectedAt = "2026-08-25T09:00:00.000Z",
  metricOverrides = {},
) {
  return {
    startDate,
    endDate,
    metrics: {
      ...emptyAudienceAnalyticsMetrics(),
      ...metricOverrides,
    },
    provenance: provenance(collectedAt),
  };
}

function provenance(collectedAt) {
  return {
    provider: "native-analytics-export",
    collectedAt,
    sourceUrl: "https://example.com/native-analytics",
    basis: "native-daily-metric",
  };
}
