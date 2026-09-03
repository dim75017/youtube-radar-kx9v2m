import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  importOwnerAudienceAnalytics,
  parseCsv,
  parseMetaInsightsCsv,
} from "../scripts/import-owner-audience-analytics.mjs";

const PROFILES = {
  youtube: "https://www.youtube.com/@LofiGirl",
  instagram: "https://www.instagram.com/lofigirl/",
  tiktok: "https://www.tiktok.com/@lofigirl",
  x: "https://x.com/lofigirl",
};

test("parseCsv préserve une date X contenant des virgules", () => {
  const rows = parseCsv('Date,Impressions\n"Tue, Aug 25, 2026",10963\n');
  assert.deepEqual(rows, [{ Date: "Tue, Aug 25, 2026", Impressions: "10963" }]);
});

test("l'import natif normalise les jours sans interpolation ni décalage de date", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "audience-native-"));
  const paths = {
    analytics: resolve(root, "audience-analytics.json"),
    history: resolve(root, "audience-history.json"),
    posts: resolve(root, "public-history.json"),
    manifest: resolve(root, "manifest.json"),
    youtube: resolve(root, "youtube.csv"),
    followers: resolve(root, "followers.csv"),
    overview: resolve(root, "overview.csv"),
    x: resolve(root, "x.csv"),
  };

  await Promise.all([
    writeFile(paths.analytics, JSON.stringify(emptyAnalytics()), "utf8"),
    writeFile(paths.history, JSON.stringify(emptyHistory()), "utf8"),
    writeFile(paths.posts, JSON.stringify({ posts: [] }), "utf8"),
    writeFile(paths.youtube, "Date,Subscribers\n2026-08-24,12\n2026-08-25,-3\n", "utf8"),
    writeFile(
      paths.followers,
      '"Date","Followers","Difference in followers from previous day"\n"23 August","100","10"\n"24 August","110","-3"\n"25 August","107","0"\n',
      "utf8",
    ),
    writeFile(
      paths.overview,
      '"Date","Video Views","Profile Views","Likes","Comments","Shares"\n"23 August","10","2","3","1","1"\n"24 August","20","4","6","2","2"\n"25 August","","","9","-2","3"\n',
      "utf8",
    ),
    writeFile(
      paths.x,
      'Date,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Unfollows,Replies,Reposts,Profile visits,Create Post,Video views,Media views\n"Tue, Aug 25, 2026",,10,20,1,2,,3,1,2,7,1,8,9\n"Mon, Aug 24, 2026",50,5,10,0,1,2,1,0,1,3,0,4,5\n',
      "utf8",
    ),
  ]);

  await writeFile(
    paths.manifest,
    JSON.stringify({
      collectedAt: "2026-08-25T16:00:00.000Z",
      platforms: {
        youtube: {
          provider: "youtube-studio-export",
          sourceUrl: "https://studio.youtube.com/analytics",
          currentFollowers: {
            value: 2000,
            observedAt: "2026-08-25T15:00:00.000Z",
            sourceUrl: "https://studio.youtube.com/analytics",
            label: "YouTube exact",
          },
          dailySubscribersCsv: {
            path: "youtube.csv",
            provider: "youtube-studio-export",
            sourceUrl: "https://studio.youtube.com/analytics",
          },
        },
        instagram: {
          provider: "instagram-insights",
          sourceUrl: "https://www.instagram.com/accounts/insights/",
          periods: {
            "30d": {
              startDate: "2026-07-27",
              endDate: "2026-08-25",
              metrics: { views: 1000, profileVisits: 20 },
            },
          },
        },
        tiktok: {
          provider: "tiktok-studio-export",
          sourceUrl: "https://www.tiktok.com/tiktokstudio/analytics",
          firstDate: "2026-08-23",
          followersCsv: { path: "followers.csv" },
          overviewCsv: { path: "overview.csv" },
        },
        x: {
          provider: "x-analytics-export",
          sourceUrl: "https://studio.x.com/analytics",
          dailyCsv: { path: "x.csv" },
        },
      },
    }),
    "utf8",
  );

  const result = await importOwnerAudienceAnalytics({
    manifestPath: paths.manifest,
    analyticsPath: paths.analytics,
    historyPath: paths.history,
    postsPath: paths.posts,
  });

  assert.deepEqual(
    result.analytics.platforms.x.daily.map((point) => point.date),
    ["2026-08-24", "2026-08-25"],
  );
  assert.deepEqual(
    result.analytics.platforms.tiktok.daily.map((point) => point.metrics.followersNet),
    [null, 10, -3],
  );
  assert.equal(result.analytics.platforms.tiktok.daily.at(-1).metrics.contentViews, null);
  assert.equal(result.analytics.platforms.tiktok.daily.at(-1).metrics.profileVisits, null);
  assert.equal(result.analytics.platforms.tiktok.daily.at(-1).metrics.comments, null);
  assert.equal(result.analytics.platforms.x.daily.at(-1).metrics.impressions, null);
  assert.equal(result.analytics.platforms.x.daily.at(-1).metrics.newFollowers, null);
  assert.equal(result.analytics.platforms.x.daily.at(-1).metrics.followersNet, null);
  assert.equal(result.analytics.platforms.x.daily.at(-1).metrics.unfollows, 3);
  assert.equal(result.analytics.platforms.instagram.periods["30d"].metrics.contentViews, 1000);
  assert.equal(result.history.platforms.youtube.observations.at(-1).followers, 2000);
  assert.equal(result.history.platforms.tiktok.observations.at(-1).followers, 107);

  const persisted = JSON.parse(await readFile(paths.analytics, "utf8"));
  assert.equal(persisted.platforms.x.daily.at(-1).date, "2026-08-25");

  await Promise.all([
    writeFile(
      paths.followers,
      '"Date","Followers","Difference in followers from previous day"\n"25 August","107","-3"\n"26 August","111","0"\n',
      "utf8",
    ),
    writeFile(
      paths.overview,
      '"Date","Video Views","Profile Views","Likes","Comments","Shares"\n"25 August","31","7","10","3","3"\n"26 August","40","8","12","4","4"\n',
      "utf8",
    ),
    writeFile(
      paths.manifest,
      JSON.stringify({
        collectedAt: "2026-08-26T16:00:00.000Z",
        platforms: {
          tiktok: {
            provider: "tiktok-studio-export",
            sourceUrl: "https://www.tiktok.com/tiktokstudio/analytics",
            firstDate: "2026-08-25",
            followersCsv: { path: "followers.csv" },
            overviewCsv: { path: "overview.csv" },
          },
        },
      }),
      "utf8",
    ),
  ]);

  const increment = await importOwnerAudienceAnalytics({
    manifestPath: paths.manifest,
    analyticsPath: paths.analytics,
    historyPath: paths.history,
    postsPath: paths.posts,
  });

  assert.deepEqual(
    increment.analytics.platforms.tiktok.daily.map((point) => point.date),
    ["2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26"],
  );
  assert.deepEqual(
    increment.analytics.platforms.tiktok.daily.map(
      (point) => point.metrics.followersNet,
    ),
    [null, 10, -3, 4],
  );
  assert.equal(
    increment.analytics.platforms.tiktok.periods.all.startDate,
    "2026-08-23",
  );
  assert.equal(
    increment.analytics.platforms.tiktok.periods.all.endDate,
    "2026-08-26",
  );
  assert.deepEqual(
    increment.analytics.platforms.instagram.periods["30d"],
    result.analytics.platforms.instagram.periods["30d"],
  );

  const repeated = await importOwnerAudienceAnalytics({
    manifestPath: paths.manifest,
    analyticsPath: paths.analytics,
    historyPath: paths.history,
    postsPath: paths.posts,
  });
  assert.deepEqual(repeated.analytics, increment.analytics);
});

test("parseMetaInsightsCsv ignore l'enveloppe à trois lignes de Meta Business Suite", () => {
  const rows = parseMetaInsightsCsv(
    'sep=,\n"Instagram follows"\n"Date","Primary"\n"2026-08-24T00:00:00","691"\n',
  );
  assert.deepEqual(rows, [{ Date: "2026-08-24T00:00:00", Primary: "691" }]);
});

test("l'import Meta Instagram fusionne les métriques quotidiennes sans reconstruire les followers", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "audience-meta-instagram-"));
  const paths = {
    analytics: resolve(root, "audience-analytics.json"),
    history: resolve(root, "audience-history.json"),
    posts: resolve(root, "public-history.json"),
    manifest: resolve(root, "manifest.json"),
  };
  const csvPaths = Object.fromEntries([
    ["contentViews", "views.csv"],
    ["reach", "reach.csv"],
    ["engagements", "interactions.csv"],
    ["externalLinkTaps", "links.csv"],
    ["profileVisits", "visits.csv"],
    ["newFollowers", "follows.csv"],
  ].map(([metric, file]) => [metric, resolve(root, file)]));
  const analytics = emptyAnalytics();
  analytics.platforms.instagram.periods["30d"] = nativePeriod({
    followersTotal: 1_430_107,
    accountsEngaged: 362_098,
    profileActivity: 124_882,
    contentViews: 9_999,
    profileVisits: 999,
  });
  const native30d = structuredClone(analytics.platforms.instagram.periods["30d"]);

  await Promise.all([
    writeFile(paths.analytics, JSON.stringify(analytics), "utf8"),
    writeFile(paths.history, JSON.stringify(emptyHistory()), "utf8"),
    writeFile(paths.posts, JSON.stringify({ posts: [] }), "utf8"),
    writeFile(csvPaths.contentViews, metaCsvUtf16("Views", [["2026-08-24", 10], ["2026-08-25", 20]])),
    writeFile(csvPaths.reach, metaCsv("Reach", [["2026-08-24", 11], ["2026-08-25", 21]]), "utf8"),
    writeFile(csvPaths.engagements, metaCsv("Content interactions", [["2026-08-24", 12], ["2026-08-25", 22]]), "utf8"),
    writeFile(csvPaths.externalLinkTaps, metaCsv("Instagram link clicks", [["2026-08-24", 1], ["2026-08-25", 2]]), "utf8"),
    writeFile(csvPaths.profileVisits, metaCsv("Instagram profile visits", [["2026-08-24", 3], ["2026-08-25", 4]]), "utf8"),
    writeFile(csvPaths.newFollowers, metaCsv("Instagram follows", [["2026-08-24", 5], ["2026-08-25", 6]]), "utf8"),
  ]);

  await writeFile(paths.manifest, JSON.stringify({
    collectedAt: "2026-08-26T11:00:00.000Z",
    platforms: {
      instagram: {
        provider: "meta-business-suite-export",
        sourceUrl: "https://business.facebook.com/latest/insights/overview",
        dailyCsvs: Object.fromEntries(Object.entries(csvPaths).map(([metric, path]) => [
          metric,
          { path: path.split(/[\\/]/).at(-1) },
        ])),
      },
    },
  }), "utf8");

  const first = await importOwnerAudienceAnalytics({
    manifestPath: paths.manifest,
    analyticsPath: paths.analytics,
    historyPath: paths.history,
    postsPath: paths.posts,
  });
  const august25 = first.analytics.platforms.instagram.daily.at(-1);
  assert.deepEqual(august25.metrics, nativeMetrics({
    contentViews: 20,
    reach: 21,
    engagements: 22,
    externalLinkTaps: 2,
    profileVisits: 4,
    newFollowers: 6,
  }));
  assert.equal(august25.metrics.followersTotal, null);
  assert.equal(august25.metrics.followersNet, null);
  assert.equal(Number.isInteger(august25.metrics.newFollowers), true);
  assert.deepEqual(first.analytics.platforms.instagram.periods["30d"], native30d);
  assert.equal(first.analytics.platforms.instagram.periods["7d"].metrics.contentViews, 30);
  assert.equal(first.analytics.platforms.instagram.periods["7d"].metrics.profileVisits, 7);
  assert.equal(first.analytics.platforms.instagram.periods["7d"].metrics.newFollowers, 11);
  assert.equal(first.analytics.platforms.instagram.periods.all.metrics.contentViews, 30);

  await writeFile(csvPaths.newFollowers, metaCsv("Instagram follows", [["2026-08-25", 7]]), "utf8");
  await writeFile(paths.manifest, JSON.stringify({
    collectedAt: "2026-08-26T12:00:00.000Z",
    platforms: {
      instagram: {
        provider: "meta-business-suite-export",
        sourceUrl: "https://business.facebook.com/latest/insights/overview",
        dailyCsvs: { newFollowers: { path: "follows.csv" } },
      },
    },
  }), "utf8");
  const increment = await importOwnerAudienceAnalytics({
    manifestPath: paths.manifest,
    analyticsPath: paths.analytics,
    historyPath: paths.history,
    postsPath: paths.posts,
  });
  assert.equal(increment.analytics.platforms.instagram.daily.at(-1).metrics.contentViews, 20);
  assert.equal(increment.analytics.platforms.instagram.daily.at(-1).metrics.newFollowers, 7);
  assert.deepEqual(increment.analytics.platforms.instagram.periods["30d"], native30d);
  assert.equal(increment.analytics.platforms.instagram.periods["7d"].metrics.newFollowers, 11);
});

function emptyAnalytics() {
  return {
    version: 1,
    generatedAt: "2026-08-26T00:00:00.000Z",
    platforms: Object.fromEntries(Object.entries(PROFILES).map(([platform, profileUrl]) => [
      platform,
      {
        profileUrl,
        lastSuccessfulImportAt: null,
        daily: [],
        periods: Object.fromEntries(
          ["7d", "28d", "30d", "60d", "90d", "365d", "all"].map((key) => [key, null]),
        ),
      },
    ])),
  };
}

function emptyHistory() {
  const engagementByPeriod = {
    "30d": null,
    "90d": null,
    "180d": null,
    "365d": null,
    all: null,
  };
  return {
    version: 2,
    generatedAt: "2026-01-01T12:00:00.000Z",
    platforms: Object.fromEntries(Object.entries(PROFILES).map(([platform, profileUrl]) => [
      platform,
      {
        profileUrl,
        observations: [{
          capturedAt: "2026-01-01T12:00:00.000Z",
          followers: 10,
          precision: "exact",
          sourceUrl: profileUrl,
          label: `${platform} seed`,
        }],
        engagementByPeriod,
      },
    ])),
  };
}

function metaCsv(title, values) {
  return `sep=,\n"${title}"\n"Date","Primary"\n${values.map(([date, value]) => `"${date}T00:00:00","${value}"`).join("\n")}\n`;
}

function metaCsvUtf16(title, values) {
  return Buffer.from(`\uFEFF${metaCsv(title, values)}`, "utf16le");
}

function nativeMetrics(partial = {}) {
  return Object.fromEntries([
    "followersTotal", "followersNet", "contentViews", "impressions", "reach",
    "profileVisits", "engagements", "likes", "comments", "shares", "bookmarks",
    "replies", "reposts", "newFollowers", "unfollows", "mediaViews",
    "watchTimeSeconds", "accountsEngaged", "profileActivity", "externalLinkTaps",
    "contentPublished",
  ].map((key) => [key, Object.hasOwn(partial, key) ? partial[key] : null]));
}

function nativePeriod(partial) {
  return {
    startDate: "2026-07-27",
    endDate: "2026-08-25",
    metrics: nativeMetrics(partial),
    provenance: {
      provider: "instagram-insights",
      collectedAt: "2026-08-25T10:00:00.000Z",
      sourceUrl: "https://www.instagram.com/accounts/insights/",
      basis: "native-period-aggregate",
    },
  };
}
