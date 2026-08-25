import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  importOwnerAudienceAnalytics,
  parseCsv,
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
      '"Date","Video Views","Profile Views","Likes","Comments","Shares"\n"23 August","10","2","3","1","1"\n"24 August","20","4","6","2","2"\n"25 August","30","6","9","-2","3"\n',
      "utf8",
    ),
    writeFile(
      paths.x,
      'Date,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Unfollows,Replies,Reposts,Profile visits,Create Post,Video views,Media views\n"Tue, Aug 25, 2026",100,10,20,1,2,5,3,1,2,7,1,8,9\n"Mon, Aug 24, 2026",50,5,10,0,1,2,1,0,1,3,0,4,5\n',
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
  assert.equal(result.analytics.platforms.tiktok.daily.at(-1).metrics.comments, null);
  assert.equal(result.analytics.platforms.instagram.periods["30d"].metrics.contentViews, 1000);
  assert.equal(result.history.platforms.youtube.observations.at(-1).followers, 2000);
  assert.equal(result.history.platforms.tiktok.observations.at(-1).followers, 107);

  const persisted = JSON.parse(await readFile(paths.analytics, "utf8"));
  assert.equal(persisted.platforms.x.daily.at(-1).date, "2026-08-25");
});

function emptyAnalytics() {
  const periods = Object.fromEntries(
    ["7d", "28d", "30d", "60d", "90d", "365d", "all"].map((key) => [key, null]),
  );
  return {
    version: 1,
    generatedAt: "2026-08-24T00:00:00.000Z",
    platforms: Object.fromEntries(Object.entries(PROFILES).map(([platform, profileUrl]) => [
      platform,
      { profileUrl, lastSuccessfulImportAt: null, daily: [], periods },
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
