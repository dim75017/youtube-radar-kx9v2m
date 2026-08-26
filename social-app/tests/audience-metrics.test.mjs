import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUDIENCE_ENGAGEMENT_FORMULA,
  AUDIENCE_PERIODS,
  assertAudienceHistory,
  audienceGrowth,
  calculatePlatformEngagement,
  emptyEngagementByPeriod,
  latestAudienceObservation,
  recalculateAudienceEngagement,
} from "../lib/audience-metrics.ts";
import {
  AUDIENCE_COLLECTORS,
  audienceFreshnessError,
  collectAudienceHistory,
  compactCount,
} from "../scripts/collect-audience-history.mjs";

const historyPath = new URL("../data/audience-history.json", import.meta.url);
const postsPath = new URL("../data/public-history.json", import.meta.url);
const history = assertAudienceHistory(
  JSON.parse(await readFile(historyPath, "utf8")),
);
const publicHistory = JSON.parse(await readFile(postsPath, "utf8"));

test("validates the real version 2 snapshot, its five periods and plausible latest follower totals", () => {
  assert.equal(history.version, 2);
  assert.deepEqual(
    AUDIENCE_PERIODS.map(({ key, label, days }) => ({ key, label, days })),
    [
      { key: "30d", label: "30 jours", days: 30 },
      { key: "90d", label: "3 mois", days: 90 },
      { key: "180d", label: "6 mois", days: 180 },
      { key: "365d", label: "1 an", days: 365 },
      { key: "all", label: "All time", days: null },
    ],
  );
  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    assert.deepEqual(
      Object.keys(history.platforms[platform].engagementByPeriod).sort(),
      AUDIENCE_PERIODS.map((period) => period.key).sort(),
    );
  }
  assertLatestObservation("youtube", 10_000_000, ["exact", "platform-rounded"]);
  assertLatestObservation("instagram", 1_000_000, "exact");
  assertLatestObservation("tiktok", 1_000_000, ["exact", "platform-rounded"]);
  assertLatestObservation("x", 100_000, ["exact", "platform-rounded"]);
});

test("rejects invented zeroes, non-HTTPS sources and unknown precision", () => {
  const zero = structuredClone(history);
  zero.platforms.instagram.observations.at(-1).followers = 0;
  assert.throws(() => assertAudienceHistory(zero), /strictement positif/i);

  const insecure = structuredClone(history);
  insecure.platforms.tiktok.observations.at(-1).sourceUrl = "http://example.com";
  assert.throws(() => assertAudienceHistory(insecure), /HTTPS/i);

  const guessed = structuredClone(history);
  guessed.platforms.x.observations.at(-1).precision = "estimated";
  assert.throws(() => assertAudienceHistory(guessed), /precision/i);

  const missingPeriod = structuredClone(history);
  delete missingPeriod.platforms.youtube.engagementByPeriod["90d"];
  assert.throws(() => assertAudienceHistory(missingPeriod), /90d/i);
});

test("finds the latest point without relying on array order", () => {
  const platform = structuredClone(history.platforms.x);
  const expectedFollowers = latestAudienceObservation(platform).followers;
  platform.observations.reverse();
  assert.equal(latestAudienceObservation(platform).followers, expectedFollowers);
});

test("compares the first and last real points inside the selected window", () => {
  const platform = {
    profileUrl: "https://example.com/profile",
    engagementByPeriod: emptyEngagementByPeriod(),
    observations: [
      observation("2026-07-01T00:00:00.000Z", 500),
      observation("2026-08-04T00:00:00.000Z", 1_000),
      observation("2026-08-11T00:00:00.000Z", 1_100),
    ],
  };
  const weekly = audienceGrowth(platform, { days: 7 });
  assert.equal(weekly.followersDelta, 100);
  assert.equal(weekly.ratePercent, 10);
  assert.equal(weekly.elapsedDays, 7);
  assert.equal(weekly.from.followers, 1_000);
  assert.equal(weekly.to.followers, 1_100);

  const monthly = audienceGrowth(platform, { days: 30 });
  assert.equal(monthly.from.followers, 1_000);
  assert.equal(monthly.to.followers, 1_100);
  assert.equal(monthly.elapsedDays, 7);
  assert.equal(
    audienceGrowth(platform, { days: 6 }),
    null,
    "a one-point period must not fall back to an older all-time observation",
  );
  assert.equal(audienceGrowth(platform).from.followers, 500);
});

test("uses every measurable post in each calendar period and defaults to 30 days", () => {
  const latest = observation("2026-08-11T00:00:00.000Z", 1_000, "exact");
  const calculatedAt = "2026-08-11T12:00:00.000Z";
  const calculatedTime = Date.parse(calculatedAt);
  const daysAgo = (days) => new Date(
    calculatedTime - days * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const posts = Array.from({ length: 35 }, (_, index) => ({
    platform: "youtube",
    format: index % 2 ? "short" : "community_image",
    publishedAt: new Date(calculatedTime - (index + 1) * 12 * 60 * 60 * 1_000).toISOString(),
    likes: 9,
    comments: 1,
  }));
  posts.push(...[30, 40, 120, 250, 500].map((days) => ({
    platform: "youtube",
    format: "short",
    publishedAt: daysAgo(days),
    likes: 9,
    comments: 1,
  })));
  posts.push({
    platform: "youtube",
    format: "comment",
    publishedAt: daysAgo(1),
    likes: 50_000,
    comments: 50_000,
  });
  posts.push({
    platform: "youtube",
    format: "short",
    publishedAt: daysAgo(1),
    likes: null,
    comments: 4,
  });
  posts.push({
    platform: "youtube",
    format: "short",
    publishedAt: new Date(calculatedTime + 1_000).toISOString(),
    likes: 50_000,
    comments: 50_000,
  });

  const expectedSampleSizes = {
    "30d": 36,
    "90d": 37,
    "180d": 38,
    "365d": 39,
    all: 40,
  };
  const byPeriod = Object.fromEntries(
    AUDIENCE_PERIODS.map((period) => [
      period.key,
      calculatePlatformEngagement(
        "youtube",
        posts,
        latest,
        calculatedAt,
        period.key,
      ),
    ]),
  );

  for (const period of AUDIENCE_PERIODS) {
    const engagement = byPeriod[period.key];
    assert.ok(engagement);
    assert.equal(engagement.period, period.key);
    assert.equal(engagement.formula, AUDIENCE_ENGAGEMENT_FORMULA);
    assert.equal(engagement.sampleSize, expectedSampleSizes[period.key]);
    assert.equal(engagement.averageInteractions, 10);
    assert.equal(engagement.ratePercent, 1);
    assert.equal(engagement.followers, 1_000);
  }
  assert.deepEqual(
    calculatePlatformEngagement("youtube", posts, latest, calculatedAt),
    byPeriod["30d"],
    "the calculation must default to the last 30 calendar days",
  );
});

test("precomputes all five engagement periods for every platform", () => {
  const recalculated = recalculateAudienceEngagement(
    history,
    publicHistory.posts,
    history.generatedAt,
  );
  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    const sampleSizes = [];
    for (const period of AUDIENCE_PERIODS) {
      const engagement = recalculated.platforms[platform]
        .engagementByPeriod[period.key];
      assert.ok(
        engagement,
        `${platform}/${period.key} should have an engagement sample`,
      );
      assert.deepEqual(
        history.platforms[platform].engagementByPeriod[period.key],
        engagement,
        `${platform}/${period.key} stored engagement must match the current public history`,
      );
      assert.equal(engagement.period, period.key);
      assert.equal(engagement.formula, AUDIENCE_ENGAGEMENT_FORMULA);
      assert.ok(engagement.averageInteractions >= 0);
      assert.ok(engagement.ratePercent >= 0);
      sampleSizes.push(engagement.sampleSize);
    }
    assert.deepEqual(
      sampleSizes,
      sampleSizes.toSorted((left, right) => left - right),
      `${platform} calendar samples must only grow as the period widens`,
    );
    assert.ok(
      sampleSizes.at(-1) > 30,
      `${platform} all-time engagement must not be capped to 30 posts`,
    );
  }
});

test("a partial daily collection appends successes and preserves failed platforms", async () => {
  const latestTime = Math.max(
    ...["youtube", "instagram", "tiktok", "x"].map((platform) =>
      Date.parse(latestAudienceObservation(history.platforms[platform]).capturedAt)),
  );
  const capturedAt = new Date(latestTime + 24 * 60 * 60 * 1_000).toISOString();
  const beforeInstagram = history.platforms.instagram.observations.length;
  const beforeX = history.platforms.x.observations.length;
  const nextYouTube = latestAudienceObservation(history.platforms.youtube).followers + 1;
  const nextTikTok = latestAudienceObservation(history.platforms.tiktok).followers + 1;
  const collectors = {
    youtube: async () => observation(
      capturedAt,
      nextYouTube,
      latestAudienceObservation(history.platforms.youtube).precision,
    ),
    instagram: async () => { throw new Error("Meta indisponible"); },
    tiktok: async () => observation(capturedAt, nextTikTok, "exact"),
    x: async () => { throw new Error("X indisponible"); },
  };
  const result = await collectAudienceHistory({
    historyPath,
    postsPath,
    collectors,
    now: capturedAt,
    write: false,
  });

  assert.deepEqual(result.successes.map((item) => item.platform), ["youtube", "tiktok"]);
  assert.deepEqual(result.failures.map((item) => item.platform), ["instagram", "x"]);
  assert.equal(
    result.history.platforms.instagram.observations.length,
    beforeInstagram,
  );
  assert.equal(result.history.platforms.x.observations.length, beforeX);
  assert.equal(
    latestAudienceObservation(result.history.platforms.youtube).followers,
    nextYouTube,
  );
});

test("keeps only the latest real observation when two collectors run the same Paris day", async () => {
  const capturedAt = afterSnapshot(1);
  const platform = ["youtube", "instagram", "tiktok", "x"].find((candidate) =>
    parisCalendarDay(latestAudienceObservation(history.platforms[candidate]).capturedAt) ===
      parisCalendarDay(history.generatedAt));
  assert.ok(platform, "the snapshot should contain a real observation from its Paris day");
  const previousLength = history.platforms[platform].observations.length;
  const nextFollowers = latestAudienceObservation(history.platforms[platform]).followers + 1;
  const collectors = Object.fromEntries(
    ["youtube", "instagram", "tiktok", "x"].map((candidate) => [
      candidate,
      async () => observation(
        capturedAt,
        candidate === platform
          ? nextFollowers
          : latestAudienceObservation(history.platforms[candidate]).followers,
        latestAudienceObservation(history.platforms[candidate]).precision,
      ),
    ]),
  );
  const result = await collectAudienceHistory({
    historyPath,
    postsPath,
    collectors,
    now: capturedAt,
    write: false,
  });

  assert.equal(
    result.history.platforms[platform].observations.length,
    previousLength,
  );
  assert.equal(
    latestAudienceObservation(result.history.platforms[platform]).followers,
    nextFollowers,
  );
});

test("rejects an implausible same-day follower collapse and keeps the last good point", async () => {
  const capturedAt = afterSnapshot(2);
  const previousYouTube = latestAudienceObservation(history.platforms.youtube);
  const collectors = Object.fromEntries(
    ["youtube", "instagram", "tiktok", "x"].map((platform) => [
      platform,
      async () => observation(
        capturedAt,
        platform === "youtube"
          ? 498_000
          : latestAudienceObservation(history.platforms[platform]).followers,
        latestAudienceObservation(history.platforms[platform]).precision,
      ),
    ]),
  );
  const result = await collectAudienceHistory({
    historyPath,
    postsPath,
    collectors,
    now: capturedAt,
    write: false,
  });

  assert.ok(result.failures.some((item) =>
    item.platform === "youtube" && /variation audience incohérente/i.test(item.error)));
  assert.equal(
    latestAudienceObservation(result.history.platforms.youtube).followers,
    previousYouTube.followers,
  );
});

test("rejects two observations on the same Paris calendar day", () => {
  const duplicate = structuredClone(history);
  const latest = latestAudienceObservation(duplicate.platforms.youtube);
  duplicate.platforms.youtube.observations.push({
    ...latest,
    capturedAt: new Date(Date.parse(latest.capturedAt) + 60 * 60 * 1_000).toISOString(),
    followers: latest.followers + 1,
  });
  duplicate.generatedAt = duplicate.platforms.youtube.observations.at(-1).capturedAt;
  for (const platform of ["youtube", "instagram", "tiktok", "x"]) {
    for (const engagement of Object.values(duplicate.platforms[platform].engagementByPeriod)) {
      if (engagement) engagement.calculatedAt = duplicate.generatedAt;
    }
  }

  assert.throws(() => assertAudienceHistory(duplicate), /même jour.*Europe\/Paris/i);
});

test("uses the exact YouTube Studio count before any public rounded fallback", async () => {
  const capturedAt = "2026-08-25T09:30:00.000Z";
  const result = await AUDIENCE_COLLECTORS.youtube({
    capturedAt,
    env: { YOUTUBE_STUDIO_SUBSCRIBER_COUNT: "15820270" },
    fetchImpl: async () => {
      throw new Error("The public source must not be queried when Studio is available.");
    },
  });

  assert.deepEqual(result, {
    capturedAt,
    followers: 15_820_270,
    precision: "exact",
    sourceUrl: "https://studio.youtube.com/artist/a_lcagLDIDJj5/analytics/tab-overview/period-default/total_reach-all",
    label: "YouTube Studio · compteur d’abonnés exact vérifié",
  });
});

test("keeps the TikTok creator embed counter rounded instead of claiming exactness", async () => {
  const capturedAt = "2026-08-26T08:00:00.000Z";
  const result = await AUDIENCE_COLLECTORS.tiktok({
    capturedAt,
    env: {},
    fetchImpl: async (url) => url === "https://www.tiktok.com/@lofigirl"
      ? new Response("", { status: 403 })
      : new Response('<script>{"statsV2":{"followerCount":"1500000"}}</script>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });

  assert.equal(result.followers, 1_500_000);
  assert.equal(result.precision, "platform-rounded");
  assert.match(result.label, /arrondi/);
});

test("never replaces a same-day exact audience point with a rounded counter", async () => {
  const previousYouTube = latestAudienceObservation(history.platforms.youtube);
  assert.equal(previousYouTube.precision, "exact");
  const capturedAt = new Date(
    Date.parse(previousYouTube.capturedAt) + 60 * 60 * 1_000,
  ).toISOString();
  assert.equal(parisCalendarDay(capturedAt), parisCalendarDay(previousYouTube.capturedAt));
  const collectors = {
    youtube: async () => observation(capturedAt, 15_800_000, "platform-rounded"),
    instagram: async () => { throw new Error("ignoré"); },
    tiktok: async () => { throw new Error("ignoré"); },
    x: async () => { throw new Error("ignoré"); },
  };
  const result = await collectAudienceHistory({
    historyPath,
    postsPath,
    collectors,
    now: capturedAt,
    write: false,
  });

  assert.ok(result.failures.some((item) =>
    item.platform === "youtube" && /ne peut pas remplacer/i.test(item.error)));
  assert.deepEqual(
    latestAudienceObservation(result.history.platforms.youtube),
    previousYouTube,
  );
});

test("accepts a rounded observation on a later Paris day after an exact point", async () => {
  const previousYouTube = latestAudienceObservation(history.platforms.youtube);
  const previousLength = history.platforms.youtube.observations.length;
  const capturedAt = new Date(
    Date.parse(previousYouTube.capturedAt) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  assert.notEqual(parisCalendarDay(capturedAt), parisCalendarDay(previousYouTube.capturedAt));
  const collectors = {
    youtube: async () => observation(capturedAt, 15_800_000, "platform-rounded"),
    instagram: async () => { throw new Error("ignoré"); },
    tiktok: async () => { throw new Error("ignoré"); },
    x: async () => { throw new Error("ignoré"); },
  };
  const result = await collectAudienceHistory({
    historyPath,
    postsPath,
    collectors,
    now: capturedAt,
    write: false,
  });

  assert.ok(result.successes.some((item) => item.platform === "youtube"));
  assert.equal(
    result.history.platforms.youtube.observations.length,
    previousLength + 1,
  );
  assert.equal(
    latestAudienceObservation(result.history.platforms.youtube).precision,
    "platform-rounded",
  );
  assert.equal(audienceFreshnessError(result.history, "youtube", capturedAt), null);
});

test("replaces a same-day rounded observation with a later exact Studio point", async () => {
  const previousYouTube = latestAudienceObservation(history.platforms.youtube);
  const roundedAt = new Date(
    Date.parse(previousYouTube.capturedAt) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  const exactAt = new Date(Date.parse(roundedAt) + 60 * 60 * 1_000).toISOString();
  assert.equal(parisCalendarDay(roundedAt), parisCalendarDay(exactAt));
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lofi-audience-precision-"));
  const temporaryHistoryPath = join(temporaryDirectory, "audience-history.json");
  const skippedCollectors = {
    instagram: async () => { throw new Error("ignoré"); },
    tiktok: async () => { throw new Error("ignoré"); },
    x: async () => { throw new Error("ignoré"); },
  };

  try {
    const rounded = await collectAudienceHistory({
      historyPath,
      postsPath,
      outputPath: temporaryHistoryPath,
      collectors: {
        youtube: async () => observation(roundedAt, 15_800_000, "platform-rounded"),
        ...skippedCollectors,
      },
      now: roundedAt,
    });
    const exact = await collectAudienceHistory({
      historyPath: temporaryHistoryPath,
      postsPath,
      collectors: {
        youtube: async () => observation(exactAt, 15_820_300, "exact"),
        ...skippedCollectors,
      },
      now: exactAt,
      write: false,
    });

    assert.equal(
      exact.history.platforms.youtube.observations.length,
      rounded.history.platforms.youtube.observations.length,
    );
    assert.deepEqual(latestAudienceObservation(exact.history.platforms.youtube), {
      capturedAt: exactAt,
      followers: 15_820_300,
      precision: "exact",
      sourceUrl: "https://example.com/source",
      label: "Relevé réel de test",
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reports a missing required platform for the requested Paris day", () => {
  const latest = latestAudienceObservation(history.platforms.youtube);
  const nextDay = new Date(Date.parse(latest.capturedAt) + 24 * 60 * 60 * 1_000).toISOString();

  assert.equal(audienceFreshnessError(history, "youtube", latest.capturedAt), null);
  assert.match(
    audienceFreshnessError(history, "youtube", nextDay),
    /Aucun relevé youtube.*Europe\/Paris/i,
  );
});

test("rejects an invalid explicit YouTube Studio CLI count before collection", () => {
  const scriptPath = fileURLToPath(
    new URL("../scripts/collect-audience-history.mjs", import.meta.url),
  );
  for (const invalidArguments of [
    ["--youtube-studio-count", "not-a-number"],
    ["--youtube-studio-count", "0"],
    ["--youtube-studio-count"],
  ]) {
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath, ...invalidArguments],
      { encoding: "utf8" },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /youtube-studio-count.*entier strictement positif/i);
    assert.doesNotMatch(child.stdout, /"successes"/);
  }
});

test("the daily workflow enforces a fresh YouTube point on both scheduled passes", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/social-update-audience-history.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /cron: "37 6 \* \* \*"/);
  assert.match(workflow, /cron: "37 18 \* \* \*"/);
  assert.match(workflow, /filter:\s*blob:none/);
  assert.match(workflow, /sparse-checkout:[\s\S]*?\/social-app\//);
  assert.match(workflow, /\.github\/workflows\/social-update-audience-history\.yml/);
  assert.match(workflow, /--require-fresh-platform youtube/);
  assert.match(workflow, /Two daily collection passes/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(
    workflow,
    /gh workflow run deploy-pages\.yml --ref main[\s\\]*-f requested_sha="\$\(git rev-parse HEAD\)"/,
  );
  assert.doesNotMatch(workflow, /catch-up pass/i);
});

test("parses only explicit compact follower counters", () => {
  assert.equal(compactCount("15.8M"), 15_800_000);
  assert.equal(compactCount("1,548,859"), 1_548_859);
  assert.equal(compactCount("260.8K"), 260_800);
  assert.equal(compactCount("followers unknown"), null);
  assert.equal(compactCount("0"), null);
});

function observation(
  capturedAt,
  followers,
  precision = "milestone",
) {
  return {
    capturedAt,
    followers,
    precision,
    sourceUrl: "https://example.com/source",
    label: "Relevé réel de test",
  };
}

function assertLatestObservation(platform, minimumFollowers, precision) {
  const latest = latestAudienceObservation(history.platforms[platform]);
  assert.ok(Number.isFinite(Date.parse(latest.capturedAt)), `${platform} must have a dated real observation`);
  assert.ok(
    Date.parse(latest.capturedAt) <= Date.parse(history.generatedAt),
    `${platform} observation cannot be newer than the snapshot`,
  );
  assert.ok(
    latest.followers >= minimumFollowers,
    `${platform} must keep a plausible non-zero audience total`,
  );
  const allowedPrecisions = Array.isArray(precision) ? precision : [precision];
  assert.ok(
    allowedPrecisions.includes(latest.precision),
    `${platform} precision must be one of ${allowedPrecisions.join(", ")}`,
  );
}

function afterSnapshot(offsetMinutes) {
  return new Date(
    Date.parse(history.generatedAt) + offsetMinutes * 60 * 1_000,
  ).toISOString();
}

function parisCalendarDay(value) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
