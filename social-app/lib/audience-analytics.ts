export const AUDIENCE_ANALYTICS_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
] as const;

export const AUDIENCE_ANALYTICS_METRIC_KEYS = [
  "followersTotal",
  "followersNet",
  "contentViews",
  "impressions",
  "reach",
  "profileVisits",
  "engagements",
  "likes",
  "comments",
  "shares",
  "bookmarks",
  "replies",
  "reposts",
  "newFollowers",
  "unfollows",
  "mediaViews",
  "watchTimeSeconds",
  "accountsEngaged",
  "profileActivity",
  "externalLinkTaps",
  "contentPublished",
] as const;

export const AUDIENCE_ANALYTICS_PERIOD_KEYS = [
  "7d",
  "28d",
  "30d",
  "60d",
  "90d",
  "365d",
  "all",
] as const;

export type AudienceAnalyticsPlatform =
  (typeof AUDIENCE_ANALYTICS_PLATFORMS)[number];
export type AudienceAnalyticsMetricKey =
  (typeof AUDIENCE_ANALYTICS_METRIC_KEYS)[number];
export type AudienceAnalyticsPeriodKey =
  (typeof AUDIENCE_ANALYTICS_PERIOD_KEYS)[number];

export type AudienceAnalyticsMetrics = Record<
  AudienceAnalyticsMetricKey,
  number | null
>;

export type AudienceAnalyticsProvenance = {
  provider: string;
  collectedAt: string;
  sourceUrl: string;
  basis: string;
};

export type AudienceAnalyticsDailyPoint = {
  date: string;
  metrics: AudienceAnalyticsMetrics;
  provenance: AudienceAnalyticsProvenance;
};

export type AudienceAnalyticsPeriodSnapshot = {
  startDate: string;
  endDate: string;
  metrics: AudienceAnalyticsMetrics;
  provenance: AudienceAnalyticsProvenance;
};

export type AudienceAnalyticsPlatformSnapshot = {
  profileUrl: string;
  lastSuccessfulImportAt: string | null;
  daily: AudienceAnalyticsDailyPoint[];
  periods: Record<
    AudienceAnalyticsPeriodKey,
    AudienceAnalyticsPeriodSnapshot | null
  >;
};

export type AudienceAnalytics = {
  version: 1;
  generatedAt: string;
  platforms: Record<
    AudienceAnalyticsPlatform,
    AudienceAnalyticsPlatformSnapshot
  >;
};

const SIGNED_METRIC_KEYS = new Set<AudienceAnalyticsMetricKey>([
  "followersNet",
]);
const PERIOD_DAYS: Record<AudienceAnalyticsPeriodKey, number | null> = {
  "7d": 7,
  "28d": 28,
  "30d": 30,
  "60d": 60,
  "90d": 90,
  "365d": 365,
  all: null,
};
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Validate the complete, public, normalized native-analytics snapshot. */
export function assertAudienceAnalytics(value: unknown): AudienceAnalytics {
  const snapshot = strictRecord(
    value,
    ["version", "generatedAt", "platforms"],
    "Le snapshot analytics audience",
  );
  if (snapshot.version !== 1) {
    throw new Error("Le snapshot analytics audience doit utiliser la version 1.");
  }
  const generatedAt = assertTimestamp(snapshot.generatedAt, "generatedAt");
  const generatedTime = Date.parse(generatedAt);
  const platforms = strictRecord(
    snapshot.platforms,
    AUDIENCE_ANALYTICS_PLATFORMS,
    "platforms",
  );

  for (const platform of AUDIENCE_ANALYTICS_PLATFORMS) {
    assertPlatformSnapshot(platforms[platform], platform, generatedTime);
  }

  return value as AudienceAnalytics;
}

/**
 * Merge two already-normalized snapshots without duplicating dates.
 * A newer native observation wins as a whole, preserving truthful row-level
 * provenance. Two different rows captured at the exact same instant are a
 * conflict and are rejected instead of being blended.
 */
export function mergeAudienceAnalytics(
  currentValue: unknown,
  incomingValue: unknown,
): AudienceAnalytics {
  const current = assertAudienceAnalytics(currentValue);
  const incoming = assertAudienceAnalytics(incomingValue);
  const platforms = Object.fromEntries(
    AUDIENCE_ANALYTICS_PLATFORMS.map((platform) => {
      const before = current.platforms[platform];
      const after = incoming.platforms[platform];
      if (before.profileUrl !== after.profileUrl) {
        throw new Error(
          `${platform}.profileUrl ne peut pas changer pendant une fusion.`,
        );
      }

      const daily = mergeDatedRows(
        before.daily,
        after.daily,
        (row) => row.date,
        `${platform}.daily`,
      );
      const periods = Object.fromEntries(
        AUDIENCE_ANALYTICS_PERIOD_KEYS.map((period) => [
          period,
          selectObservedRow(
            before.periods[period],
            after.periods[period],
            `${platform}.periods.${period}`,
          ),
        ]),
      ) as AudienceAnalyticsPlatformSnapshot["periods"];

      return [
        platform,
        {
          profileUrl: before.profileUrl,
          lastSuccessfulImportAt: latestTimestamp(
            before.lastSuccessfulImportAt,
            after.lastSuccessfulImportAt,
          ),
          daily,
          periods,
        },
      ];
    }),
  ) as AudienceAnalytics["platforms"];

  const merged: AudienceAnalytics = {
    version: 1,
    generatedAt: latestTimestamp(current.generatedAt, incoming.generatedAt)!,
    platforms,
  };
  return assertAudienceAnalytics(merged);
}

/** Return only observed daily rows in the requested inclusive calendar window. */
export function filterAudienceAnalyticsDaily(
  daily: readonly AudienceAnalyticsDailyPoint[],
  period: AudienceAnalyticsPeriodKey,
  endDate: string,
): AudienceAnalyticsDailyPoint[] {
  if (!AUDIENCE_ANALYTICS_PERIOD_KEYS.includes(period)) {
    throw new Error(`Période analytics audience inconnue : ${period}.`);
  }
  const canonicalEndDate = assertDate(endDate, "endDate");
  const endTime = dateTime(canonicalEndDate);
  const days = PERIOD_DAYS[period];
  const minimumTime = days === null
    ? Number.NEGATIVE_INFINITY
    : endTime - (days - 1) * DAY_MS;

  return daily.filter((point, index) => {
    const date = assertDate(point?.date, `daily[${index}].date`);
    const time = dateTime(date);
    return time >= minimumTime && time <= endTime;
  });
}

export function emptyAudienceAnalyticsMetrics(): AudienceAnalyticsMetrics {
  return Object.fromEntries(
    AUDIENCE_ANALYTICS_METRIC_KEYS.map((key) => [key, null]),
  ) as AudienceAnalyticsMetrics;
}

export function emptyAudienceAnalyticsPeriods(): AudienceAnalyticsPlatformSnapshot["periods"] {
  return Object.fromEntries(
    AUDIENCE_ANALYTICS_PERIOD_KEYS.map((key) => [key, null]),
  ) as AudienceAnalyticsPlatformSnapshot["periods"];
}

function assertPlatformSnapshot(
  value: unknown,
  platform: AudienceAnalyticsPlatform,
  generatedTime: number,
): void {
  const snapshot = strictRecord(
    value,
    ["profileUrl", "lastSuccessfulImportAt", "daily", "periods"],
    platform,
  );
  assertHttpsUrl(snapshot.profileUrl, `${platform}.profileUrl`);
  if (snapshot.lastSuccessfulImportAt !== null) {
    const importedAt = assertTimestamp(
      snapshot.lastSuccessfulImportAt,
      `${platform}.lastSuccessfulImportAt`,
    );
    assertNotAfterSnapshot(importedAt, generatedTime, `${platform}.lastSuccessfulImportAt`);
  }
  if (!Array.isArray(snapshot.daily)) {
    throw new Error(`${platform}.daily doit être un tableau.`);
  }

  let previousDate = "";
  for (const [index, value] of snapshot.daily.entries()) {
    const point = strictRecord(
      value,
      ["date", "metrics", "provenance"],
      `${platform}.daily[${index}]`,
    );
    const date = assertDate(point.date, `${platform}.daily[${index}].date`);
    if (previousDate && date <= previousDate) {
      throw new Error(
        `${platform}.daily doit être trié par date croissante, sans doublon.`,
      );
    }
    previousDate = date;
    assertMetrics(point.metrics, `${platform}.daily[${index}].metrics`);
    assertProvenance(
      point.provenance,
      `${platform}.daily[${index}].provenance`,
      generatedTime,
    );
  }

  const periods = strictRecord(
    snapshot.periods,
    AUDIENCE_ANALYTICS_PERIOD_KEYS,
    `${platform}.periods`,
  );
  for (const period of AUDIENCE_ANALYTICS_PERIOD_KEYS) {
    const value = periods[period];
    if (value === null) continue;
    const entry = strictRecord(
      value,
      ["startDate", "endDate", "metrics", "provenance"],
      `${platform}.periods.${period}`,
    );
    const startDate = assertDate(
      entry.startDate,
      `${platform}.periods.${period}.startDate`,
    );
    const endDate = assertDate(
      entry.endDate,
      `${platform}.periods.${period}.endDate`,
    );
    if (startDate > endDate) {
      throw new Error(`${platform}.periods.${period} a une plage inversée.`);
    }
    assertMetrics(entry.metrics, `${platform}.periods.${period}.metrics`);
    assertProvenance(
      entry.provenance,
      `${platform}.periods.${period}.provenance`,
      generatedTime,
    );
  }
}

function assertMetrics(value: unknown, label: string): void {
  const metrics = strictRecord(value, AUDIENCE_ANALYTICS_METRIC_KEYS, label);
  for (const key of AUDIENCE_ANALYTICS_METRIC_KEYS) {
    const metric = metrics[key];
    if (metric === null) continue;
    if (typeof metric !== "number" || !Number.isFinite(metric)) {
      throw new Error(`${label}.${key} doit être un nombre fini ou null.`);
    }
    if (!SIGNED_METRIC_KEYS.has(key) && metric < 0) {
      throw new Error(`${label}.${key} ne peut pas être négatif.`);
    }
  }
}

function assertProvenance(
  value: unknown,
  label: string,
  generatedTime: number,
): void {
  const provenance = strictRecord(
    value,
    ["provider", "collectedAt", "sourceUrl", "basis"],
    label,
  );
  assertNonemptyString(provenance.provider, `${label}.provider`);
  const collectedAt = assertTimestamp(
    provenance.collectedAt,
    `${label}.collectedAt`,
  );
  assertNotAfterSnapshot(collectedAt, generatedTime, `${label}.collectedAt`);
  assertHttpsUrl(provenance.sourceUrl, `${label}.sourceUrl`);
  assertNonemptyString(provenance.basis, `${label}.basis`);
}

function mergeDatedRows<T extends { provenance: AudienceAnalyticsProvenance }>(
  current: readonly T[],
  incoming: readonly T[],
  key: (row: T) => string,
  label: string,
): T[] {
  const byDate = new Map(current.map((row) => [key(row), row]));
  for (const row of incoming) {
    const rowKey = key(row);
    byDate.set(
      rowKey,
      selectObservedRow(byDate.get(rowKey) ?? null, row, `${label}.${rowKey}`)!,
    );
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

function selectObservedRow<T extends { provenance: AudienceAnalyticsProvenance }>(
  current: T | null,
  incoming: T | null,
  label: string,
): T | null {
  if (!current) return incoming;
  if (!incoming) return current;
  const before = Date.parse(current.provenance.collectedAt);
  const after = Date.parse(incoming.provenance.collectedAt);
  if (after > before) return incoming;
  if (after < before) return current;
  if (stableJson(current) !== stableJson(incoming)) {
    throw new Error(`${label} contient deux observations différentes au même instant.`);
  }
  return current;
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} doit être un objet.`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} manque les clés : ${missing.join(", ")}.`);
  }
  if (unknown.length > 0) {
    throw new Error(`${label} contient des clés inconnues : ${unknown.join(", ")}.`);
  }
  return record;
}

function assertDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${label} doit utiliser le format YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const canonical = new Date(Date.UTC(year, month - 1, day));
  if (
    canonical.getUTCFullYear() !== year ||
    canonical.getUTCMonth() !== month - 1 ||
    canonical.getUTCDate() !== day
  ) {
    throw new Error(`${label} doit être une date réelle.`);
  }
  return value;
}

function assertTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} doit être un timestamp ISO avec fuseau horaire.`);
  }
  return value;
}

function assertHttpsUrl(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} doit être une URL HTTPS.`);
  }
}

function assertNonemptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} est requis.`);
  }
}

function assertNotAfterSnapshot(
  value: string,
  generatedTime: number,
  label: string,
): void {
  if (Date.parse(value) > generatedTime) {
    throw new Error(`${label} ne peut pas être postérieur à generatedAt.`);
  }
}

function latestTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function dateTime(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) =>
      `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
