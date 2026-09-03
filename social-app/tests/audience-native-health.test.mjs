import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUDIENCE_ANALYTICS_PLATFORMS,
  emptyAudienceAnalyticsMetrics,
  emptyAudienceAnalyticsPeriods,
} from "../lib/audience-analytics.ts";
import {
  AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS,
  AUDIENCE_DEMOGRAPHICS_PLATFORMS,
} from "../lib/audience-demographics.ts";
import {
  AUDIENCE_NATIVE_MAX_AGE_HOURS,
  AUDIENCE_NATIVE_REQUIRED_DEMOGRAPHICS,
  AUDIENCE_NATIVE_REQUIRED_METRICS,
  buildAudienceNativeHealthReport,
  formatAudienceNativeHealthReport,
} from "../scripts/check-audience-native-health.mjs";

const FRESH_AT = "2026-09-03T11:00:00.000Z";
const CHECKED_AT = "2026-09-03T12:00:00.000Z";

test("accepts observations exactly 26 hours old and audits every configured metric", () => {
  const observedAt = "2026-09-02T12:00:00.000Z";
  const report = buildAudienceNativeHealthReport({
    analytics: analyticsFixture(observedAt),
    demographics: demographicsFixture(observedAt),
    checkedAt: "2026-09-03T14:00:00.000Z",
  });

  assert.equal(AUDIENCE_NATIVE_MAX_AGE_HOURS, 26);
  assert.equal(report.healthy, true);
  assert.equal(report.failures.length, 0);
  for (const platform of AUDIENCE_ANALYTICS_PLATFORMS) {
    for (const metric of AUDIENCE_NATIVE_REQUIRED_METRICS[platform]) {
      assert.equal(
        check(report, `audience-analytics.${platform}.metrics.${metric}`).status,
        "fresh",
      );
    }
  }
  for (const dimension of AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS) {
    assert.equal(
      check(report, `audience-demographics.x.${dimension}`).status,
      "not-required",
    );
  }
});

test("fails an old data day even when the export was collected recently", () => {
  const analytics = analyticsFixture(FRESH_AT);
  analytics.platforms.youtube.daily[0].date = "2026-09-01";

  const report = buildAudienceNativeHealthReport({
    analytics,
    demographics: demographicsFixture(FRESH_AT),
    checkedAt: CHECKED_AT,
  });
  const issue = check(
    report,
    "audience-analytics.youtube.metrics.followersNet",
  );

  assert.equal(report.healthy, false);
  assert.equal(
    report.failures.length,
    AUDIENCE_NATIVE_REQUIRED_METRICS.youtube.length,
  );
  assert.ok(report.failures.every((failure) => failure.platform === "youtube"));
  assert.equal(issue.status, "stale");
  assert.equal(issue.ageHours, 36);
  assert.equal(issue.observedAt, "2026-09-01");
  assert.equal(issue.dataThrough, "2026-09-01");
  assert.equal(issue.collectedAt, FRESH_AT);
  assert.match(
    formatAudienceNativeHealthReport(report),
    /youtube\.metrics\.followersNet: 36 h > 26 h[\s\S]*collectedAt=2026-09-03T11:00:00\.000Z/,
  );
});

test("reports missing required metrics and demographic dimensions without inventing values", () => {
  const analytics = analyticsFixture(FRESH_AT);
  analytics.platforms.instagram.daily[0].metrics.reach = null;
  const demographics = demographicsFixture(FRESH_AT);
  demographics.platforms.tiktok.ages = null;
  demographics.platforms.tiktok.status = "partial";

  const report = buildAudienceNativeHealthReport({
    analytics,
    demographics,
    checkedAt: CHECKED_AT,
  });

  assert.deepEqual(
    report.failures.map((issue) => [issue.key, issue.status]),
    [
      ["audience-analytics.instagram.metrics.reach", "missing"],
      ["audience-demographics.tiktok.ages", "missing"],
    ],
  );
  assert.match(
    formatAudienceNativeHealthReport(report),
    /instagram\.metrics\.reach: aucune observation native/,
  );
});

test("uses the newest truthful metric provenance across daily and period exports", () => {
  const analytics = analyticsFixture(FRESH_AT);
  analytics.platforms.youtube.daily[0].date = "2026-08-31";
  analytics.platforms.youtube.daily[0].provenance.collectedAt =
    "2026-08-31T08:00:00.000Z";
  const metrics = emptyAudienceAnalyticsMetrics();
  for (const metric of AUDIENCE_NATIVE_REQUIRED_METRICS.youtube) {
    metrics[metric] = 12;
  }
  analytics.platforms.youtube.periods["7d"] = {
    startDate: "2026-08-27",
    endDate: "2026-09-02",
    metrics,
    provenance: provenance(FRESH_AT),
  };

  const report = buildAudienceNativeHealthReport({
    analytics,
    demographics: demographicsFixture(FRESH_AT),
    checkedAt: CHECKED_AT,
  });
  const metric = check(
    report,
    "audience-analytics.youtube.metrics.followersNet",
  );

  assert.equal(report.healthy, true);
  assert.equal(metric.status, "fresh");
  assert.equal(metric.observedAt, "2026-09-02");
  assert.equal(metric.dataThrough, "2026-09-02");
  assert.equal(metric.collectedAt, FRESH_AT);
  assert.equal(metric.source, "period:7d");
});

test("fails future timestamps and invalid thresholds explicitly", () => {
  const report = buildAudienceNativeHealthReport({
    analytics: analyticsFixture("2026-09-03T13:00:00.000Z"),
    demographics: demographicsFixture("2026-09-03T13:00:00.000Z"),
    checkedAt: CHECKED_AT,
  });

  assert.ok(report.failures.every((issue) => issue.status === "future"));
  assert.throws(
    () => buildAudienceNativeHealthReport({
      analytics: analyticsFixture(FRESH_AT),
      demographics: demographicsFixture(FRESH_AT),
      checkedAt: CHECKED_AT,
      maxAgeHours: 0,
    }),
    /strictement positif/,
  );
});

test("treats a date-only observation for the checked day as fresh, not future", () => {
  const analytics = analyticsFixture(FRESH_AT);
  for (const platform of AUDIENCE_ANALYTICS_PLATFORMS) {
    analytics.platforms[platform].daily[0].date = "2026-09-03";
  }
  const report = buildAudienceNativeHealthReport({
    analytics,
    demographics: demographicsFixture(FRESH_AT),
    checkedAt: CHECKED_AT,
  });

  assert.equal(report.healthy, true);
  assert.ok(
    report.checks
      .filter((entry) => entry.kind === "metric")
      .every((entry) => entry.status === "fresh" && entry.ageHours === 0),
  );
});

test("daily and scheduled workflows enforce the native health contract", async () => {
  const [dailyWorkflow, healthWorkflow, packageJson] = await Promise.all([
    readFile(new URL("../../.github/workflows/social-update-audience-history.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/social-check-audience-native-health.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(
    dailyWorkflow,
    /name: Audit native analytics and demographics freshness[\s\S]*?id: native_health[\s\S]*?continue-on-error: true[\s\S]*?check-audience-native-health\.mjs/,
  );
  assert.match(
    dailyWorkflow,
    /steps\.native_health\.outcome == 'failure'/,
  );
  assert.match(
    dailyWorkflow,
    /name: Commit only the audience snapshot[\s\S]*?if: steps\.validation\.outcome == 'success'/,
  );
  assert.match(healthWorkflow, /schedule:[\s\S]*?cron:/);
  assert.match(healthWorkflow, /check-audience-native-health\.mjs/);
  assert.match(packageJson, /"audience:native:health"/);
});

function analyticsFixture(collectedAt) {
  return {
    version: 1,
    generatedAt: collectedAt,
    platforms: Object.fromEntries(AUDIENCE_ANALYTICS_PLATFORMS.map((platform) => {
      const metrics = emptyAudienceAnalyticsMetrics();
      for (const metric of AUDIENCE_NATIVE_REQUIRED_METRICS[platform]) {
        metrics[metric] = 1;
      }
      return [platform, {
        profileUrl: profileUrl(platform),
        lastSuccessfulImportAt: collectedAt,
        daily: [{
          date: "2026-09-02",
          metrics,
          provenance: provenance(collectedAt),
        }],
        periods: emptyAudienceAnalyticsPeriods(),
      }];
    })),
  };
}

function demographicsFixture(collectedAt) {
  return {
    version: 1,
    generatedAt: collectedAt,
    platforms: Object.fromEntries(AUDIENCE_DEMOGRAPHICS_PLATFORMS.map((platform) => {
      const required = new Set(AUDIENCE_NATIVE_REQUIRED_DEMOGRAPHICS[platform]);
      return [platform, {
        profileUrl: profileUrl(platform),
        status: required.size === 0 ? "unavailable" : "available",
        countries: required.has("countries") ? dimension("countries", collectedAt) : null,
        ages: required.has("ages") ? dimension("ages", collectedAt) : null,
        genders: required.has("genders") ? dimension("genders", collectedAt) : null,
      }];
    })),
  };
}

function dimension(kind, collectedAt) {
  const entries = kind === "countries"
    ? [{ key: "france", label: "France", share: 0.5, countryCode: "FR" }]
    : kind === "ages"
      ? [{ key: "age_25_34", label: "25–34", share: 1, countryCode: null }]
      : [{ key: "female", label: "Femme", share: 1, countryCode: null }];
  return {
    entries,
    provenance: {
      ...provenance(collectedAt),
      periodLabel: "28 derniers jours",
    },
  };
}

function provenance(collectedAt) {
  return {
    provider: "native-test-export",
    collectedAt,
    sourceUrl: "https://example.com/native-export",
    basis: "native-test-fixture",
  };
}

function profileUrl(platform) {
  return {
    youtube: "https://www.youtube.com/@LofiGirl",
    instagram: "https://www.instagram.com/lofigirl/",
    tiktok: "https://www.tiktok.com/@lofigirl",
    x: "https://x.com/lofigirl",
  }[platform];
}

function check(report, key) {
  const value = report.checks.find((candidate) => candidate.key === key);
  assert.ok(value, `Contrôle absent : ${key}`);
  return value;
}
