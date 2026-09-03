import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIENCE_ANALYTICS_PLATFORMS,
  AUDIENCE_ANALYTICS_PERIOD_KEYS,
  assertAudienceAnalytics,
} from "../lib/audience-analytics.ts";
import {
  AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS,
  AUDIENCE_DEMOGRAPHICS_PLATFORMS,
  assertAudienceDemographics,
} from "../lib/audience-demographics.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR_MS = 60 * 60 * 1_000;

export const AUDIENCE_NATIVE_MAX_AGE_HOURS = 26;

/**
 * Closed list of native metrics promised by the dashboard for each platform.
 * A missing value fails closed instead of being replaced by zero or inferred
 * from a public counter. This deliberately includes YouTube metrics not yet
 * supported by the legacy subscriber-only CSV importer, so that importer can
 * never make an incomplete analytics refresh appear healthy.
 */
export const AUDIENCE_NATIVE_REQUIRED_METRICS = Object.freeze({
  youtube: Object.freeze([
    "followersNet",
    "contentViews",
    "watchTimeSeconds",
    "impressions",
    "engagements",
  ]),
  instagram: Object.freeze([
    "followersTotal",
    "contentViews",
    "reach",
    "profileVisits",
    "engagements",
    "newFollowers",
    "accountsEngaged",
    "profileActivity",
    "externalLinkTaps",
  ]),
  tiktok: Object.freeze([
    "followersTotal",
    "followersNet",
    "contentViews",
    "profileVisits",
    "likes",
    "comments",
    "shares",
  ]),
  x: Object.freeze([
    "followersNet",
    "contentViews",
    "impressions",
    "profileVisits",
    "engagements",
    "likes",
    "shares",
    "bookmarks",
    "replies",
    "reposts",
    "newFollowers",
    "unfollows",
    "mediaViews",
    "contentPublished",
  ]),
});

/** X currently declares every demographic dimension unavailable. */
export const AUDIENCE_NATIVE_REQUIRED_DEMOGRAPHICS = Object.freeze({
  youtube: Object.freeze([...AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS]),
  instagram: Object.freeze([...AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS]),
  tiktok: Object.freeze([...AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS]),
  x: Object.freeze([]),
});

export function buildAudienceNativeHealthReport({
  analytics: analyticsValue,
  demographics: demographicsValue,
  checkedAt = new Date().toISOString(),
  maxAgeHours = AUDIENCE_NATIVE_MAX_AGE_HOURS,
}) {
  const checkedTime = requireTimestamp(checkedAt, "checkedAt");
  if (typeof maxAgeHours !== "number" || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("maxAgeHours doit être un nombre strictement positif.");
  }

  const analytics = assertAudienceAnalytics(analyticsValue);
  const demographics = assertAudienceDemographics(demographicsValue);
  const checks = [];

  checks.push(timestampCheck({
    key: "audience-analytics.generatedAt",
    dataset: "audience-analytics",
    kind: "snapshot",
    observedAt: analytics.generatedAt,
    checkedAt,
    checkedTime,
    maxAgeHours,
  }));

  for (const platform of AUDIENCE_ANALYTICS_PLATFORMS) {
    const snapshot = analytics.platforms[platform];
    checks.push(timestampCheck({
      key: `audience-analytics.${platform}.lastSuccessfulImportAt`,
      dataset: "audience-analytics",
      platform,
      kind: "import",
      observedAt: snapshot.lastSuccessfulImportAt,
      checkedAt,
      checkedTime,
      maxAgeHours,
    }));

    for (const metric of AUDIENCE_NATIVE_REQUIRED_METRICS[platform]) {
      const latest = latestMetricObservation(snapshot, metric);
      checks.push(timestampCheck({
        key: `audience-analytics.${platform}.metrics.${metric}`,
        dataset: "audience-analytics",
        platform,
        kind: "metric",
        metric,
        // A freshly downloaded copy of an old export must not pass health.
        // The platform import timestamp is audited separately above; metric
        // freshness is anchored to the latest day the export actually covers.
        observedAt: latest?.dataThrough ?? null,
        checkedAt,
        checkedTime,
        maxAgeHours,
        dataThrough: latest?.dataThrough ?? null,
        collectedAt: latest?.collectedAt ?? null,
        source: latest?.source ?? null,
      }));
    }
  }

  checks.push(timestampCheck({
    key: "audience-demographics.generatedAt",
    dataset: "audience-demographics",
    kind: "snapshot",
    observedAt: demographics.generatedAt,
    checkedAt,
    checkedTime,
    maxAgeHours,
  }));

  for (const platform of AUDIENCE_DEMOGRAPHICS_PLATFORMS) {
    const snapshot = demographics.platforms[platform];
    const required = new Set(AUDIENCE_NATIVE_REQUIRED_DEMOGRAPHICS[platform]);
    for (const dimension of AUDIENCE_DEMOGRAPHIC_DIMENSION_KEYS) {
      const value = snapshot[dimension];
      if (!required.has(dimension)) {
        checks.push({
          key: `audience-demographics.${platform}.${dimension}`,
          dataset: "audience-demographics",
          platform,
          kind: "dimension",
          dimension,
          required: false,
          status: "not-required",
          observedAt: value?.provenance.collectedAt ?? null,
          checkedAt,
          ageHours: value
            ? roundedHours(checkedTime - Date.parse(value.provenance.collectedAt))
            : null,
          maxAgeHours,
          dataThrough: value?.provenance.periodLabel ?? null,
          source: value?.provenance.provider ?? null,
        });
        continue;
      }
      checks.push(timestampCheck({
        key: `audience-demographics.${platform}.${dimension}`,
        dataset: "audience-demographics",
        platform,
        kind: "dimension",
        dimension,
        observedAt: value?.provenance.collectedAt ?? null,
        checkedAt,
        checkedTime,
        maxAgeHours,
        dataThrough: value?.provenance.periodLabel ?? null,
        source: value?.provenance.provider ?? null,
      }));
    }
  }

  const failures = checks.filter((check) => ["missing", "stale", "future"].includes(check.status));
  return {
    version: 1,
    checkedAt,
    maxAgeHours,
    healthy: failures.length === 0,
    checks,
    failures,
  };
}

export function formatAudienceNativeHealthReport(report) {
  const summary = report.healthy
    ? `HEALTHY: ${report.checks.length} contrôles natifs dans la fenêtre de ${formatHours(report.maxAgeHours)} h.`
    : `UNHEALTHY: ${report.failures.length}/${report.checks.length} contrôles natifs en échec (seuil ${formatHours(report.maxAgeHours)} h).`;
  const lines = [
    `Audience native health @ ${report.checkedAt}`,
    summary,
  ];

  for (const check of report.checks) {
    const details = [];
    if (check.observedAt) details.push(`observedAt=${check.observedAt}`);
    if (check.ageHours !== null) details.push(`age=${formatHours(check.ageHours)} h`);
    if (check.dataThrough) details.push(`dataThrough=${check.dataThrough}`);
    if (check.collectedAt) details.push(`collectedAt=${check.collectedAt}`);
    if (check.source) details.push(`source=${check.source}`);
    const suffix = details.length > 0 ? `; ${details.join("; ")}` : "";

    if (check.status === "stale") {
      lines.push(
        `[FAIL stale] ${check.key}: ${formatHours(check.ageHours)} h > ${formatHours(check.maxAgeHours)} h${suffix}`,
      );
    } else if (check.status === "missing") {
      lines.push(`[FAIL missing] ${check.key}: aucune observation native${suffix}`);
    } else if (check.status === "future") {
      lines.push(`[FAIL future] ${check.key}: observation postérieure au contrôle${suffix}`);
    } else if (check.status === "not-required") {
      lines.push(`[SKIP not-required] ${check.key}${suffix}`);
    } else {
      lines.push(`[OK fresh] ${check.key}${suffix}`);
    }
  }
  return lines.join("\n");
}

export async function runAudienceNativeHealthCli(argv = process.argv.slice(2)) {
  const analyticsPath = resolve(cliArgument(argv, "--analytics") ?? resolve(root, "data", "audience-analytics.json"));
  const demographicsPath = resolve(cliArgument(argv, "--demographics") ?? resolve(root, "data", "audience-demographics.json"));
  const checkedAt = cliArgument(argv, "--now") ?? new Date().toISOString();
  const maxAgeValue = cliArgument(argv, "--max-age-hours");
  const maxAgeHours = maxAgeValue === null
    ? AUDIENCE_NATIVE_MAX_AGE_HOURS
    : Number(maxAgeValue);
  const [analytics, demographics] = await Promise.all([
    readJson(analyticsPath),
    readJson(demographicsPath),
  ]);
  const report = buildAudienceNativeHealthReport({
    analytics,
    demographics,
    checkedAt,
    maxAgeHours,
  });
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatAudienceNativeHealthReport(report)}\n`,
  );
  return report.healthy ? 0 : 1;
}

function latestMetricObservation(snapshot, metric) {
  const candidates = [];
  for (const point of snapshot.daily) {
    if (point.metrics[metric] === null) continue;
    candidates.push({
      collectedAt: point.provenance.collectedAt,
      dataThrough: point.date,
      source: "daily",
    });
  }
  for (const period of AUDIENCE_ANALYTICS_PERIOD_KEYS) {
    const point = snapshot.periods[period];
    if (!point || point.metrics[metric] === null) continue;
    candidates.push({
      collectedAt: point.provenance.collectedAt,
      dataThrough: point.endDate,
      source: `period:${period}`,
    });
  }
  return candidates.sort((left, right) => (
    right.dataThrough.localeCompare(left.dataThrough) ||
    Date.parse(right.collectedAt) - Date.parse(left.collectedAt)
  ))[0] ?? null;
}

function timestampCheck({
  key,
  dataset,
  platform = null,
  kind,
  metric = null,
  dimension = null,
  observedAt,
  checkedAt,
  checkedTime,
  maxAgeHours,
  dataThrough = null,
  collectedAt = null,
  source = null,
}) {
  if (observedAt === null) {
    return {
      key,
      dataset,
      platform,
      kind,
      metric,
      dimension,
      required: true,
      status: "missing",
      observedAt: null,
      checkedAt,
      ageHours: null,
      maxAgeHours,
      dataThrough,
      collectedAt,
      source,
    };
  }
  const observedTime = requireObservationTimestamp(observedAt, key, checkedTime);
  const ageMilliseconds = checkedTime - observedTime;
  const maxAgeMilliseconds = maxAgeHours * HOUR_MS;
  const status = ageMilliseconds < 0
    ? "future"
    : ageMilliseconds > maxAgeMilliseconds
      ? "stale"
      : "fresh";
  return {
    key,
    dataset,
    platform,
    kind,
    metric,
    dimension,
    required: true,
    status,
    observedAt,
    checkedAt,
    ageHours: roundedHours(ageMilliseconds),
    maxAgeHours,
    dataThrough,
    collectedAt,
    source,
  };
}

function cliArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requiert une valeur.`);
  }
  return value;
}

function requireTimestamp(value, label) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} doit être un timestamp ISO valide.`);
  }
  return timestamp;
}

function requireObservationTimestamp(value, label, checkedTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return requireTimestamp(value, label);
  }
  const dayStart = requireTimestamp(`${value}T00:00:00.000Z`, label);
  const dayEnd = requireTimestamp(`${value}T23:59:59.999Z`, label);
  if (checkedTime >= dayStart && checkedTime <= dayEnd) return checkedTime;
  return dayEnd;
}

function roundedHours(milliseconds) {
  return Math.round((milliseconds / HOUR_MS) * 100) / 100;
}

function formatHours(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  runAudienceNativeHealthCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Audience native health check failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
