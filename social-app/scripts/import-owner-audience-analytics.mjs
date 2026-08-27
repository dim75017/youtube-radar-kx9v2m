import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIENCE_ANALYTICS_METRIC_KEYS,
  AUDIENCE_ANALYTICS_PERIOD_KEYS,
  assertAudienceAnalytics,
  emptyAudienceAnalyticsMetrics,
  emptyAudienceAnalyticsPeriods,
  mergeAudienceAnalytics,
} from "../lib/audience-analytics.ts";
import {
  AUDIENCE_PLATFORMS,
  assertAudienceHistory,
  recalculateAudienceEngagement,
} from "../lib/audience-metrics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ANALYTICS_PATH = resolve(ROOT, "data", "audience-analytics.json");
const DEFAULT_HISTORY_PATH = resolve(ROOT, "data", "audience-history.json");
const DEFAULT_POSTS_PATH = resolve(ROOT, "data", "public-history.json");
const DAY_MS = 24 * 60 * 60 * 1_000;
const PERIOD_DAYS = {
  "7d": 7,
  "28d": 28,
  "30d": 30,
  "60d": 60,
  "90d": 90,
  "365d": 365,
  all: null,
};
const PROFILE_URLS = {
  youtube: "https://www.youtube.com/@LofiGirl",
  instagram: "https://www.instagram.com/lofigirl/",
  tiktok: "https://www.tiktok.com/@lofigirl",
  x: "https://x.com/lofigirl",
};
const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);
const SHORT_MONTHS = new Map([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
]);
const ADDITIVE_METRICS = new Set([
  "followersNet", "contentViews", "impressions", "profileVisits",
  "engagements", "likes", "comments", "shares", "bookmarks", "replies",
  "reposts", "newFollowers", "unfollows", "mediaViews", "watchTimeSeconds",
  "accountsEngaged", "profileActivity", "externalLinkTaps", "contentPublished",
]);
const INSTAGRAM_DAILY_CSVS = [
  { manifestKeys: ["contentViews", "views"], metric: "contentViews", label: "Instagram views" },
  { manifestKeys: ["reach"], metric: "reach", label: "Instagram reach" },
  { manifestKeys: ["engagements", "interactions"], metric: "engagements", label: "Instagram interactions" },
  { manifestKeys: ["externalLinkTaps", "linkClicks"], metric: "externalLinkTaps", label: "Instagram link clicks" },
  { manifestKeys: ["profileVisits", "visits"], metric: "profileVisits", label: "Instagram profile visits" },
  { manifestKeys: ["newFollowers", "follows"], metric: "newFollowers", label: "Instagram follows" },
];

export async function importOwnerAudienceAnalytics(options = {}) {
  const manifestPath = options.manifestPath;
  if (!manifestPath) throw new Error("Le chemin --manifest est requis.");
  const analyticsPath = options.analyticsPath ?? DEFAULT_ANALYTICS_PATH;
  const historyPath = options.historyPath ?? DEFAULT_HISTORY_PATH;
  const postsPath = options.postsPath ?? DEFAULT_POSTS_PATH;
  const write = options.write !== false;

  const manifest = assertManifest(await readJson(manifestPath));
  const collectedAt = new Date(manifest.collectedAt).toISOString();
  const [analyticsValue, historyValue, publicHistory] = await Promise.all([
    readJson(analyticsPath),
    readJson(historyPath),
    readJson(postsPath),
  ]);
  const analytics = options.replace === true
    ? emptyAnalyticsSnapshot(collectedAt)
    : assertAudienceAnalytics(analyticsValue);
  const history = assertAudienceHistory(historyValue);
  const incoming = emptyAnalyticsSnapshot(collectedAt);
  const dailyAggregationSources = new Map();

  if (manifest.platforms.youtube?.dailySubscribersCsv) {
    const source = manifest.platforms.youtube.dailySubscribersCsv;
    const rows = parseCsv(await readFile(resolveManifestPath(manifestPath, source.path), "utf8"));
    incoming.platforms.youtube.daily = parseYouTubeSubscribers(rows, source, collectedAt);
    dailyAggregationSources.set("youtube", source);
    incoming.platforms.youtube.lastSuccessfulImportAt = collectedAt;
  }

  if (manifest.platforms.instagram?.periods) {
    const platform = manifest.platforms.instagram;
    for (const [period, snapshot] of Object.entries(platform.periods)) {
      if (!AUDIENCE_ANALYTICS_PERIOD_KEYS.includes(period)) {
        throw new Error(`Période Instagram inconnue : ${period}.`);
      }
      incoming.platforms.instagram.periods[period] = {
        startDate: assertDate(snapshot.startDate, `instagram.${period}.startDate`),
        endDate: assertDate(snapshot.endDate, `instagram.${period}.endDate`),
        metrics: metrics({
          followersTotal: snapshot.metrics.followersTotal,
          contentViews: snapshot.metrics.views,
          reach: snapshot.metrics.viewers,
          engagements: snapshot.metrics.interactions,
          accountsEngaged: snapshot.metrics.accountsEngaged,
          profileActivity: snapshot.metrics.profileActivity,
          profileVisits: snapshot.metrics.profileVisits,
          externalLinkTaps: snapshot.metrics.externalLinkTaps,
        }),
        provenance: provenance(platform, collectedAt, "native-period-aggregate"),
      };
    }
    incoming.platforms.instagram.lastSuccessfulImportAt = collectedAt;
  }

  if (manifest.platforms.instagram?.dailyCsvs) {
    const platform = manifest.platforms.instagram;
    const { daily, coveredMetrics, source } = await parseInstagramDailyCsvs(
      platform,
      manifestPath,
      collectedAt,
    );
    incoming.platforms.instagram.daily = mergeDailyMetrics(
      analytics.platforms.instagram.daily,
      daily,
      coveredMetrics,
    );
    dailyAggregationSources.set("instagram", { source, coveredMetrics });
    incoming.platforms.instagram.lastSuccessfulImportAt = collectedAt;
  }

  if (
    manifest.platforms.tiktok?.followersCsv &&
    manifest.platforms.tiktok?.overviewCsv
  ) {
    const platform = manifest.platforms.tiktok;
    const followerRows = parseCsv(
      await readFile(resolveManifestPath(manifestPath, platform.followersCsv.path), "utf8"),
    );
    const overviewRows = parseCsv(
      await readFile(resolveManifestPath(manifestPath, platform.overviewCsv.path), "utf8"),
    );
    incoming.platforms.tiktok.daily = parseTikTokDaily(
      followerRows,
      overviewRows,
      platform,
      collectedAt,
    );
    dailyAggregationSources.set("tiktok", platform);
    incoming.platforms.tiktok.lastSuccessfulImportAt = collectedAt;
  }

  if (manifest.platforms.x?.dailyCsv) {
    const platform = manifest.platforms.x;
    const rows = parseCsv(
      await readFile(resolveManifestPath(manifestPath, platform.dailyCsv.path), "utf8"),
    );
    incoming.platforms.x.daily = parseXDaily(rows, platform, collectedAt);
    dailyAggregationSources.set("x", platform);
    incoming.platforms.x.lastSuccessfulImportAt = collectedAt;
  }

  if (dailyAggregationSources.has("tiktok")) {
    recalculateTikTokFollowerNet(analytics.platforms.tiktok.daily);
    alignIncomingTikTokFollowerNet(
      incoming.platforms.tiktok.daily,
      analytics.platforms.tiktok.daily,
    );
  }
  const mergedAnalytics = mergeAudienceAnalytics(analytics, incoming);
  if (dailyAggregationSources.has("tiktok")) {
    recalculateTikTokFollowerNet(mergedAnalytics.platforms.tiktok.daily);
  }
  // A short incremental export must not shrink the derived 30/90/365/all
  // aggregates. Recompute them from the complete merged daily series. Native
  // Instagram period snapshots remain indivisible; daily exports only fill
  // period windows that do not already have a native snapshot.
  for (const [platform, value] of dailyAggregationSources) {
    const source = value?.source ?? value;
    const derived = aggregateDailyPeriods(
      mergedAnalytics.platforms[platform].daily,
      source,
      collectedAt,
    );
    mergedAnalytics.platforms[platform].periods = platform === "instagram"
      ? mergeInstagramDerivedPeriods(
        mergedAnalytics.platforms[platform].periods,
        derived,
      )
      : derived;
  }
  const nextHistory = structuredClone(history);

  for (const platform of AUDIENCE_PLATFORMS) {
    const current = manifest.platforms[platform]?.currentFollowers;
    if (current) {
      upsertHistoryObservation(nextHistory, platform, {
        capturedAt: new Date(current.observedAt ?? collectedAt).toISOString(),
        followers: positiveInteger(current.value, `${platform}.currentFollowers.value`),
        precision: "exact",
        sourceUrl: httpsUrl(current.sourceUrl, `${platform}.currentFollowers.sourceUrl`),
        label: nonempty(current.label, `${platform}.currentFollowers.label`),
      });
    }
  }

  for (const point of incoming.platforms.tiktok.daily) {
    if (point.metrics.followersTotal === null) continue;
    upsertHistoryObservation(nextHistory, "tiktok", {
      capturedAt: `${point.date}T10:00:00.000Z`,
      followers: positiveInteger(point.metrics.followersTotal, "tiktok.followersTotal"),
      precision: "exact",
      sourceUrl: point.provenance.sourceUrl,
      label: "TikTok Studio · total followers quotidien exporté",
    });
  }

  const posts = Array.isArray(publicHistory?.posts) ? publicHistory.posts : [];
  const recalculatedHistory = recalculateAudienceEngagement(
    nextHistory,
    posts,
    collectedAt,
  );
  assertAudienceAnalytics(mergedAnalytics);
  assertAudienceHistory(recalculatedHistory);

  if (write) {
    await Promise.all([
      writeJsonAtomically(analyticsPath, mergedAnalytics),
      writeJsonAtomically(historyPath, recalculatedHistory),
    ]);
  }
  return { analytics: mergedAnalytics, history: recalculatedHistory };
}

function emptyAnalyticsSnapshot(generatedAt) {
  return {
    version: 1,
    generatedAt,
    platforms: Object.fromEntries(
      AUDIENCE_PLATFORMS.map((platform) => [
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

function parseYouTubeSubscribers(rows, source, collectedAt) {
  requireColumns(rows, ["Date", "Subscribers"], "YouTube Studio");
  return rows.map((row, index) => ({
    date: assertDate(row.Date, `youtube[${index}].Date`),
    metrics: metrics({ followersNet: integer(row.Subscribers, `youtube[${index}].Subscribers`) }),
    provenance: provenance(source, collectedAt, "native-daily-metric"),
  })).sort(byDate);
}

function parseTikTokDaily(followerRows, overviewRows, platform, collectedAt) {
  requireColumns(
    followerRows,
    ["Date", "Followers", "Difference in followers from previous day"],
    "TikTok followers",
  );
  requireColumns(
    overviewRows,
    ["Date", "Video Views", "Profile Views", "Likes", "Comments", "Shares"],
    "TikTok overview",
  );
  const firstDate = assertDate(platform.firstDate, "tiktok.firstDate");
  const overviewByDate = new Map();
  for (const [index, row] of overviewRows.entries()) {
    const date = datedEnglishDay(row.Date, firstDate, index, `tiktok.overview[${index}]`);
    overviewByDate.set(date, row);
  }
  const daily = followerRows.map((row, index) => {
    const date = datedEnglishDay(row.Date, firstDate, index, `tiktok.followers[${index}]`);
    const overview = overviewByDate.get(date);
    if (!overview) throw new Error(`TikTok overview absent pour ${date}.`);
    integer(
      row["Difference in followers from previous day"],
      `tiktok[${index}].exportedFollowersDifference`,
    );
    return {
      date,
      metrics: metrics({
        followersTotal: positiveInteger(row.Followers, `tiktok[${index}].Followers`),
        followersNet: null,
        contentViews: nonnegativeInteger(overview["Video Views"], `tiktok[${index}].views`),
        profileVisits: nonnegativeInteger(overview["Profile Views"], `tiktok[${index}].profileViews`),
        likes: nullableNonnegativeInteger(overview.Likes, `tiktok[${index}].likes`),
        comments: nullableNonnegativeInteger(overview.Comments, `tiktok[${index}].comments`),
        shares: nullableNonnegativeInteger(overview.Shares, `tiktok[${index}].shares`),
      }),
      provenance: provenance(platform, collectedAt, "native-daily-metric"),
    };
  }).sort(byDate);
  // TikTok's exported "difference from previous day" is shifted one row
  // forward at the range boundary. Derive the daily net from the two exact
  // totals instead; the first day remains null because its prior total is not
  // present in this export.
  for (let index = 1; index < daily.length; index += 1) {
    daily[index].metrics.followersNet =
      daily[index].metrics.followersTotal - daily[index - 1].metrics.followersTotal;
  }
  return daily;
}

async function parseInstagramDailyCsvs(platform, manifestPath, collectedAt) {
  const dailyCsvs = platform.dailyCsvs;
  if (!dailyCsvs || typeof dailyCsvs !== "object" || Array.isArray(dailyCsvs)) {
    throw new Error("instagram.dailyCsvs doit être un objet.");
  }
  const rowsByMetric = new Map();
  let source = null;
  for (const definition of INSTAGRAM_DAILY_CSVS) {
    const entry = definition.manifestKeys
      .map((key) => dailyCsvs[key])
      .find((candidate) => candidate !== undefined);
    if (!entry) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`instagram.dailyCsvs.${definition.manifestKeys[0]} doit être un objet.`);
    }
    const path = nonempty(entry.path, `instagram.dailyCsvs.${definition.manifestKeys[0]}.path`);
    const metricSource = sourceDetails(platform, entry);
    const rows = await readMetaInsightsCsv(resolveManifestPath(manifestPath, path));
    requireColumns(rows, ["Date", "Primary"], definition.label);
    rowsByMetric.set(definition.metric, rows.map((row, index) => ({
      date: parseMetaInsightsDate(row.Date, `${definition.label}[${index}].Date`),
      value: nullableNonnegativeInteger(
        row.Primary,
        `${definition.label}[${index}].Primary`,
      ),
    })));
    source ??= metricSource;
    if (
      source.provider !== metricSource.provider ||
      source.sourceUrl !== metricSource.sourceUrl
    ) {
      throw new Error("Tous les CSV quotidiens Instagram doivent avoir la même provenance.");
    }
  }
  if (rowsByMetric.size === 0) {
    throw new Error("instagram.dailyCsvs ne contient aucun export reconnu.");
  }

  const pointsByDate = new Map();
  for (const [metric, rows] of rowsByMetric) {
    for (const row of rows) {
      const point = pointsByDate.get(row.date) ?? metrics({});
      point[metric] = row.value;
      pointsByDate.set(row.date, point);
    }
  }
  return {
    daily: [...pointsByDate.entries()].map(([date, values]) => ({
      date,
      metrics: values,
      provenance: provenance(source, collectedAt, "native-daily-metric"),
    })).sort(byDate),
    coveredMetrics: new Set(rowsByMetric.keys()),
    source,
  };
}

function sourceDetails(platform, entry) {
  return {
    provider: entry.provider ?? platform.provider,
    sourceUrl: entry.sourceUrl ?? platform.sourceUrl,
  };
}

function mergeDailyMetrics(current, incoming, coveredMetrics) {
  const currentByDate = new Map(current.map((point) => [point.date, point]));
  const merged = new Map(currentByDate);
  for (const point of incoming) {
    const previous = currentByDate.get(point.date);
    if (!previous) {
      merged.set(point.date, point);
      continue;
    }
    const values = metrics({});
    for (const key of AUDIENCE_ANALYTICS_METRIC_KEYS) {
      values[key] = coveredMetrics.has(key)
        ? point.metrics[key]
        : previous.metrics[key];
    }
    merged.set(point.date, {
      date: point.date,
      metrics: values,
      provenance: point.provenance,
    });
  }
  return [...merged.values()].sort(byDate);
}

function mergeInstagramDerivedPeriods(current, derived) {
  return Object.fromEntries(AUDIENCE_ANALYTICS_PERIOD_KEYS.map((period) => {
    const before = current[period];
    const after = derived[period];
    // A period snapshot is one indivisible native observation: its range,
    // metrics and provenance must always describe the same export. Daily CSVs
    // only fill periods that do not already have a native snapshot.
    return [period, before ?? after];
  }));
}

function recalculateTikTokFollowerNet(daily) {
  for (let index = 1; index < daily.length; index += 1) {
    const previous = daily[index - 1];
    const current = daily[index];
    const previousTime = Date.parse(`${previous.date}T00:00:00.000Z`);
    const currentTime = Date.parse(`${current.date}T00:00:00.000Z`);
    if (currentTime - previousTime !== DAY_MS) continue;
    if (
      previous.metrics.followersTotal === null ||
      current.metrics.followersTotal === null
    ) continue;
    current.metrics.followersNet =
      current.metrics.followersTotal - previous.metrics.followersTotal;
  }
}

function alignIncomingTikTokFollowerNet(incoming, current) {
  const totalsByDate = new Map();
  for (const point of [...current, ...incoming]) {
    if (point.metrics.followersTotal !== null) {
      totalsByDate.set(point.date, point.metrics.followersTotal);
    }
  }
  for (const point of incoming) {
    if (point.metrics.followersTotal === null) continue;
    const previousDate = new Date(
      Date.parse(`${point.date}T00:00:00.000Z`) - DAY_MS,
    ).toISOString().slice(0, 10);
    const previousTotal = totalsByDate.get(previousDate);
    if (previousTotal === undefined) continue;
    point.metrics.followersNet = point.metrics.followersTotal - previousTotal;
  }
}

function parseXDaily(rows, platform, collectedAt) {
  requireColumns(
    rows,
    ["Date", "Impressions", "Likes", "Engagements", "Bookmarks", "Shares", "New follows", "Unfollows", "Replies", "Reposts", "Profile visits", "Create Post", "Video views", "Media views"],
    "X Analytics",
  );
  return rows.map((row, index) => {
    const date = parseXCalendarDate(row.Date, `x[${index}].Date`);
    const newFollowers = nonnegativeInteger(row["New follows"], `x[${index}].newFollowers`);
    const unfollows = nonnegativeInteger(row.Unfollows, `x[${index}].unfollows`);
    return {
      date,
      metrics: metrics({
        followersNet: newFollowers - unfollows,
        contentViews: nonnegativeInteger(row["Video views"], `x[${index}].videoViews`),
        impressions: nonnegativeInteger(row.Impressions, `x[${index}].impressions`),
        profileVisits: nonnegativeInteger(row["Profile visits"], `x[${index}].profileVisits`),
        engagements: nonnegativeInteger(row.Engagements, `x[${index}].engagements`),
        likes: nonnegativeInteger(row.Likes, `x[${index}].likes`),
        shares: nonnegativeInteger(row.Shares, `x[${index}].shares`),
        bookmarks: nonnegativeInteger(row.Bookmarks, `x[${index}].bookmarks`),
        replies: nonnegativeInteger(row.Replies, `x[${index}].replies`),
        reposts: nonnegativeInteger(row.Reposts, `x[${index}].reposts`),
        newFollowers,
        unfollows,
        mediaViews: nonnegativeInteger(row["Media views"], `x[${index}].mediaViews`),
        contentPublished: nonnegativeInteger(row["Create Post"], `x[${index}].contentPublished`),
      }),
      provenance: provenance(platform, collectedAt, "native-daily-metric"),
    };
  }).sort(byDate);
}

function parseXCalendarDate(value, label) {
  const match = String(value).trim().match(/^[A-Za-z]{3},\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  const month = match ? SHORT_MONTHS.get(match[1].toLowerCase()) : undefined;
  if (!match || month === undefined) throw new Error(`${label} est invalide.`);
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[2])) {
    throw new Error(`${label} est invalide.`);
  }
  return date.toISOString().slice(0, 10);
}

function aggregateDailyPeriods(daily, source, collectedAt) {
  const periods = emptyAudienceAnalyticsPeriods();
  if (daily.length === 0) return periods;
  const endDate = daily.at(-1).date;
  const endTime = Date.parse(`${endDate}T00:00:00.000Z`);
  for (const period of AUDIENCE_ANALYTICS_PERIOD_KEYS) {
    const days = PERIOD_DAYS[period];
    const startTime = days === null ? Number.NEGATIVE_INFINITY : endTime - (days - 1) * DAY_MS;
    const rows = daily.filter((point) => {
      const time = Date.parse(`${point.date}T00:00:00.000Z`);
      return time >= startTime && time <= endTime;
    });
    if (rows.length === 0) continue;
    const values = metrics({});
    for (const key of AUDIENCE_ANALYTICS_METRIC_KEYS) {
      if (key === "followersTotal") {
        values[key] = [...rows].reverse().find((row) => row.metrics[key] !== null)?.metrics[key] ?? null;
        continue;
      }
      if (!ADDITIVE_METRICS.has(key)) continue;
      const observed = rows.map((row) => row.metrics[key]).filter((value) => value !== null);
      values[key] = observed.length > 0 ? observed.reduce((sum, value) => sum + value, 0) : null;
    }
    periods[period] = {
      startDate: rows[0].date,
      endDate: rows.at(-1).date,
      metrics: values,
      provenance: provenance(source, collectedAt, "native-daily-aggregate"),
    };
  }
  return periods;
}

function metrics(values) {
  const result = emptyAudienceAnalyticsMetrics();
  for (const [key, value] of Object.entries(values)) {
    if (!AUDIENCE_ANALYTICS_METRIC_KEYS.includes(key)) {
      throw new Error(`Métrique analytics inconnue : ${key}.`);
    }
    result[key] = value === undefined ? null : value;
  }
  return result;
}

function provenance(source, collectedAt, basis) {
  return {
    provider: nonempty(source.provider, "provider"),
    collectedAt,
    sourceUrl: httpsUrl(source.sourceUrl, "sourceUrl"),
    basis,
  };
}

function upsertHistoryObservation(history, platform, observation) {
  const observations = history.platforms[platform].observations;
  const day = parisCalendarDay(observation.capturedAt);
  const index = observations.findIndex((candidate) => parisCalendarDay(candidate.capturedAt) === day);
  if (index >= 0) observations[index] = observation;
  else observations.push(observation);
  observations.sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
}

function datedEnglishDay(label, firstDate, index, path) {
  const match = String(label).trim().match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (!match || !MONTHS.has(match[2].toLowerCase())) {
    throw new Error(`${path}.Date est invalide.`);
  }
  const expected = new Date(Date.parse(`${firstDate}T00:00:00.000Z`) + index * DAY_MS);
  if (expected.getUTCDate() !== Number(match[1]) || expected.getUTCMonth() !== MONTHS.get(match[2].toLowerCase())) {
    throw new Error(`${path}.Date rompt la série quotidienne attendue.`);
  }
  return expected.toISOString().slice(0, 10);
}

export function parseCsv(text) {
  return recordsToRows(parseCsvRecords(text), "CSV");
}

/** Parse the three-line CSV envelope exported by Meta Business Suite. */
export function parseMetaInsightsCsv(text) {
  const records = parseCsvRecords(text);
  if (records[0]?.[0]?.trim().toLowerCase() === "sep=") records.shift();
  // Meta writes a one-cell title (for example “Instagram follows”) before
  // the regular Date / Primary header.
  if (records[0]?.length === 1) records.shift();
  return recordsToRows(records, "CSV Meta Business Suite");
}

async function readMetaInsightsCsv(path) {
  const bytes = await readFile(path);
  // Meta Business Suite's Windows export is UTF-16 LE with a BOM. Keeping
  // decoding here makes the importer accept both that native file and UTF-8
  // copies without relying on the caller's locale.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.toString("utf16le")
    : bytes.toString("utf8");
  return parseMetaInsightsCsv(text);
}

function parseCsvRecords(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value !== ""));
}

function recordsToRows(records, label) {
  const [header, ...body] = records;
  if (!header) return [];
  return body.map((values, rowIndex) => {
    if (values.length !== header.length) {
      throw new Error(`${label} ligne ${rowIndex + 2} : ${values.length} colonnes au lieu de ${header.length}.`);
    }
    return Object.fromEntries(header.map((key, index) => [key, values[index]]));
  });
}

function requireColumns(rows, columns, label) {
  if (rows.length === 0) throw new Error(`${label} ne contient aucune ligne.`);
  for (const column of columns) {
    if (!(column in rows[0])) throw new Error(`${label} ne contient pas la colonne ${column}.`);
  }
}

function resolveManifestPath(manifestPath, value) {
  return resolve(dirname(resolve(manifestPath)), value);
}

function assertManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Le manifeste d’import doit être un objet.");
  }
  if (!Number.isFinite(Date.parse(value.collectedAt))) {
    throw new Error("manifest.collectedAt doit être une date valide.");
  }
  if (!value.platforms || typeof value.platforms !== "object" || Array.isArray(value.platforms)) {
    throw new Error("manifest.platforms est requis.");
  }
  return value;
}

function integer(value, label) {
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed)) throw new Error(`${label} doit être un entier.`);
  return parsed;
}

function nonnegativeInteger(value, label) {
  const parsed = integer(value, label);
  if (parsed < 0) throw new Error(`${label} doit être positif ou nul.`);
  return parsed;
}

function nullableNonnegativeInteger(value, label) {
  if (String(value).trim() === "") return null;
  const parsed = integer(value, label);
  // Native dashboards can emit a negative daily correction after moderation
  // or deletion. The public non-negative metric stays absent for that day;
  // it is never coerced to zero.
  return parsed < 0 ? null : parsed;
}

function parseMetaInsightsDate(value, label) {
  const candidate = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?(?:Z)?$/.test(candidate)) {
    throw new Error(`${label} est invalide.`);
  }
  return assertDate(candidate.slice(0, 10), label);
}

function positiveInteger(value, label) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw new Error(`${label} doit être strictement positif.`);
  return parsed;
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} est requis.`);
  return value.trim();
}

function httpsUrl(value, label) {
  const candidate = nonempty(value, label);
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error(`${label} doit être une URL HTTPS.`);
  return url.href;
}

function assertDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} doit être au format YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} est invalide.`);
  }
  return value;
}

function parisCalendarDay(value) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function byDate(left, right) {
  return left.date.localeCompare(right.date);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function cliArgument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = cliArgument("manifest");
  importOwnerAudienceAnalytics({
    manifestPath,
    replace: process.argv.includes("--replace"),
  })
    .then(({ analytics }) => {
      const counts = Object.fromEntries(
        AUDIENCE_PLATFORMS.map((platform) => [platform, analytics.platforms[platform].daily.length]),
      );
      console.log(JSON.stringify({ ok: true, dailyRows: counts }, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
