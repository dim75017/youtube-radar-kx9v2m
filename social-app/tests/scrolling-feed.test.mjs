import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SCROLLING_AGENT_TAB_CONTEXT,
  SCROLLING_BROWSER_CONTEXT,
  SCROLLING_MINIMUM_LIKES,
  assertScrollingFeed,
  assertScrollingThemeCatalog,
} from "../lib/scrolling.ts";

const rawFeed = JSON.parse(
  await readFile(new URL("../data/scrolling/feed.json", import.meta.url), "utf8"),
);
const rawThemes = JSON.parse(
  await readFile(new URL("../data/scrolling/themes.json", import.meta.url), "utf8"),
);
const feed = assertScrollingFeed(rawFeed, rawThemes);
const themes = assertScrollingThemeCatalog(rawThemes);

const expectedSources = new Map([
  ["DZia5FeumDj", { author: "houseofvocal", likes: 350_700 }],
  ["DbYjkQPtJn6", { author: "electronicmusic.official", likes: 239_800 }],
  ["DbCKZ4GBz7u", { author: "musictravellove", likes: 75_400 }],
  ["Db8r9u4D15T", { author: "lofigirl", likes: 53_700 }],
  ["DcNWAhVFDnJ", { author: "paulvandyk", likes: 23_600 }],
  ["Davd2wNtfmU", { author: "djnamedpaul", likes: 75_900 }],
  ["DZAFvCNp226", { author: "edmhouse.us", likes: 65_100 }],
  ["DaMlY1vs5Yu", { author: "iavrilspain", likes: 24_100 }],
  ["DcD1rswtT6U", { author: "edmhousenetwork", likes: 17_400 }],
  ["DabIJvSzbdq", { author: "_morphflex", likes: 75_800 }],
  ["DcJYmaNupbm", { author: "edmmusic", likes: 27_900 }],
  ["DcYi4EjDBXq", { author: "armadamusic", likes: 12_200 }],
  ["DZ7c-mFsOji", { author: "maddixmusic", likes: 71_400 }],
  ["DcWN5YevqHv", { author: "travelwithsidd14", likes: 597_200 }],
  ["DbG5osCg9QE", { author: "the_galixx", likes: 38_500 }],
  ["DbtJiXXxfjW", { author: "royyschneider", likes: 74_500 }],
  ["DbYSNmZItaC", { author: "annikaverwest", likes: 180_700 }],
  ["DcBfcbAIXvC", { author: "wildlife.ayush", likes: 39_300 }],
  ["DbV5t3Eqz_j", { author: "llama.5060060", likes: 28_700 }],
  ["DZR-b4sIhTR", { author: "condsty", likes: 108_400 }],
  ["DcdlfsWoorn", { author: "bloodytincture", likes: 21_300 }],
  ["DZRlrpLSBC2", { author: "finding.unforgettable.songs", likes: 18_300 }],
  ["Dce3sikyoqt", { author: "theangelicanero", likes: 268_800 }],
  ["DcEN_awjpoC", { author: "edmmusic", likes: 50_800 }],
  ["DcXA1WNCCNO", { author: "nature_aroundclock", likes: 102_000 }],
  ["Dcf8s00gWRD", { author: "winxclub", likes: 81_800 }],
  ["Db89Cn4hrAX", { author: "subtronics", likes: 37_700 }],
  ["DcgN-zooXp4", { author: "cyberpunkgame", likes: 26_200 }],
  ["DcfW6l-iHAF", { author: "thescenicgamerofficial", likes: 23_700 }],
  ["DcJuyWRvjnK", { author: "rebbford", likes: 10_600 }],
  ["DcHMXywMQNz", { author: "_yes_but", likes: 70_000 }],
  ["Db7PHynj43z", { author: "happymotionanimations", likes: 38_900 }],
  ["Db_Pq4gxhsL", { author: "girls", likes: 759_400 }],
  ["DcrYMcGsE_R", { author: "apluslisaa", likes: 24_400 }],
  ["DcVyjuOPHU8", { author: "studyw_cathie", likes: 124_000 }],
  ["DMXCcQqtLdr", { author: "shreesvlog_", likes: 45_300 }],
  ["DbVZ1qxJprE", { author: "110vestruck", likes: 112_000 }],
  ["DVBaDwIk1qP", { author: "tingzhang4281", likes: 609_000 }],
  ["CaV4urErTkb", { author: "cats_of_instagram", likes: 2_300_000 }],
  ["CvnoXhAv3Ka", { author: "cats_of_instagram", likes: 492_000 }],
  ["DZaQ-mAhIlB", { author: "the.anndra.edit", likes: 113_000 }],
  ["DceYgjnMtTN", { author: "_yes_but", likes: 45_500 }],
  ["Db_LQ9tJKEw", { author: "playlistdechanael", likes: 12_300 }],
  ["DZFYc_Yzxx7", { author: "felis_creations", likes: 277_600 }],
  ["Da59xDsSqw4", { author: "bryanjohnson_", likes: 67_900 }],
  ["DQ4vP_lDDpO", { author: "alvathehotdog", likes: 490_400 }],
  ["DP2cQvAj6vn", { author: "okdstudio", likes: 58_300 }],
  ["DPm6Ba2ku3B", { author: "cocowyocoloring", likes: 26_400 }],
  ["DPo-6-pDKLP", { author: "mrs.miuki", likes: 322_200 }],
  ["DPg1rABjG5v", { author: "pembethepinkcat", likes: 15_500 }],
  ["DP3xc1DkTlW", { author: "goldenbenjamin", likes: 62_500 }],
  ["DOdG60ZEmJE", { author: "raccoon_uuu", likes: 62_000 }],
  ["DcMDebEx6Iq", { author: "jesskindagames", likes: 42_000 }],
  ["CbQVBPCJsFt", { author: "studyquill", likes: 15_300 }],
  ["CsrIIw5pmF8", { author: "nala_cat", likes: 242_300 }],
  ["DZvQ4UORy3q", { author: "a_typical_tuesday", likes: 2_700_000 }],
  ["DZ1F0T5Js45", { author: "smileydingoes", likes: 1_100_000 }],
  ["DRnZaTdjuVK", { author: "dreamlightvalleydecor", likes: 27_600 }],
  ["Db_-VrpRaO6", { author: "byhakes", likes: 195_400 }],
  ["Dcvb3tSRy4p", { author: "girls", likes: 157_600 }],
  ["Dcayd7XIV40", { author: "chopper__daily", likes: 450_100 }],
  ["Dcglrg3OrxG", { author: "trashygas1", likes: 346_300 }],
  ["Db58wLmyQU5", { author: "_by.alexander", likes: 66_900 }],
  ["DcaC4CKNu7f", { author: "srtacience", likes: 1_200_000 }],
  ["DchcOSyIp1g", { author: "crunchyroll", likes: 58_000 }],
  ["DaA9qx0PTf0", { author: "usageek_", likes: 70_400 }],
  ["DcTsdCDO4Wh", { author: "ambientzoning", likes: 18_500 }],
  ["DcyuPmXl8NN", { author: "cornelluniversity", likes: 12_400 }],
  ["DcWgdLhkf1s", { author: "harrypotter", likes: 99_400 }],
  ["DcyoD_9MD9L", { author: "_yes_but", likes: 31_700 }],
  ["Da0BDNOCEap", { author: "cats_of_instagram", likes: 38_200 }],
  ["Db-tYInJyYk", { author: "jose_naranja", likes: 69_600, comments: 623 }],
]);

test("the connected Instagram snapshot preserves the historical and new-account runs", () => {
  assert.match(feed.capturedAt, /^2026-09-04/u);
  assert.equal(feed.minimumLikes, SCROLLING_MINIMUM_LIKES);
  assert.equal(feed.runs.length, 26);
  assert.equal(feed.items.length, 72);

  const initialRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26");
  const extendedRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26-extended");
  const eveningRun = feed.runs.find((run) => run.id === "instagram-home-2026-08-26-evening");
  const newAccountHomeRun = feed.runs.find((run) => run.id === "instagram-home-2026-09-01-new-account");
  const calibrationRun = feed.runs.find((run) => run.id === "instagram-search-2026-09-01-calibration");
  const manualCalibrationRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-02-manual-calibration",
  );
  const postCalibrationHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-02-post-calibration",
  );
  const longCalibrationRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-02-long-calibration",
  );
  const userSeedRun = feed.runs.find((run) => run.id === "instagram-search-2026-09-02-user-seeds");
  const afterLongCalibrationHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-02-after-long-calibration",
  );
  const finalImmersionSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-02-immersion-final",
  );
  const finalImmersionHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-02-immersion-final",
  );
  const heartbeatSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-02-heartbeat-1715",
  );
  const heartbeatHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-02-heartbeat-1715",
  );
  const eveningHeartbeatSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-02-heartbeat-2115",
  );
  const bigHomeScrollRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-02-big-scroll-2332",
  );
  const morningSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-03-heartbeat-0915",
  );
  const morningHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-03-heartbeat-0915",
  );
  const frequencyBoostSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-03-frequency-boost-1940",
  );
  const frequencyBoostHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-03-frequency-boost-1940",
  );
  const eveningSearchRun = feed.runs.find(
    (run) => run.id === "instagram-search-2026-09-03-heartbeat-2115",
  );
  const eveningHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-03-heartbeat-2115",
  );
  const septemberFourthReelsRun = feed.runs.find(
    (run) => run.id === "instagram-reels-2026-09-04-heartbeat-1915",
  );
  const septemberFourthHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-04-heartbeat-1915",
  );
  const septemberFourthLateReelsRun = feed.runs.find(
    (run) => run.id === "instagram-reels-2026-09-04-heartbeat-2115",
  );
  const septemberFourthLateHomeRun = feed.runs.find(
    (run) => run.id === "instagram-home-2026-09-04-heartbeat-2115",
  );
  assert.ok(initialRun);
  assert.ok(extendedRun);
  assert.ok(eveningRun);
  assert.ok(newAccountHomeRun);
  assert.ok(calibrationRun);
  assert.ok(manualCalibrationRun);
  assert.ok(postCalibrationHomeRun);
  assert.ok(longCalibrationRun);
  assert.ok(userSeedRun);
  assert.ok(afterLongCalibrationHomeRun);
  assert.ok(finalImmersionSearchRun);
  assert.ok(finalImmersionHomeRun);
  assert.ok(heartbeatSearchRun);
  assert.ok(heartbeatHomeRun);
  assert.ok(eveningHeartbeatSearchRun);
  assert.ok(bigHomeScrollRun);
  assert.ok(morningSearchRun);
  assert.ok(morningHomeRun);
  assert.ok(frequencyBoostSearchRun);
  assert.ok(frequencyBoostHomeRun);
  assert.ok(eveningSearchRun);
  assert.ok(eveningHomeRun);
  assert.ok(septemberFourthReelsRun);
  assert.ok(septemberFourthHomeRun);
  assert.ok(septemberFourthLateReelsRun);
  assert.ok(septemberFourthLateHomeRun);
  assert.equal(initialRun.platform, "instagram");
  assert.equal(initialRun.surface, "home");
  assert.equal(initialRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(initialRun.seenCount, 28);
  assert.equal(initialRun.qualifyingCount, 8);
  assert.equal(initialRun.sponsoredCount, 0);
  assert.equal(extendedRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(extendedRun.seenCount, 504);
  assert.equal(extendedRun.qualifyingCount, 236);
  assert.equal(extendedRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === extendedRun.id).length, 16);
  assert.ok(feed.items.filter((item) => item.runId === extendedRun.id).length < extendedRun.qualifyingCount);
  assert.equal(eveningRun.browserContext, SCROLLING_BROWSER_CONTEXT);
  assert.equal(eveningRun.seenCount, 151);
  assert.equal(eveningRun.qualifyingCount, 53);
  assert.equal(eveningRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === eveningRun.id).length, 6);
  assert.ok(feed.items.filter((item) => item.runId === eveningRun.id).length < eveningRun.qualifyingCount);
  assert.ok(Date.parse(eveningRun.capturedAt) > Date.parse(extendedRun.capturedAt));
  assert.equal(newAccountHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(newAccountHomeRun.surface, "home");
  assert.equal(newAccountHomeRun.seenCount, 48);
  assert.equal(newAccountHomeRun.qualifyingCount, 5);
  assert.equal(newAccountHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === newAccountHomeRun.id).length, 3);
  assert.ok(feed.items.filter((item) => item.runId === newAccountHomeRun.id).length < newAccountHomeRun.qualifyingCount);
  assert.equal(calibrationRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(calibrationRun.surface, "search");
  assert.equal(calibrationRun.seenCount, 14);
  assert.equal(calibrationRun.qualifyingCount, 7);
  assert.equal(calibrationRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === calibrationRun.id).length, 5);
  assert.ok(feed.items.filter((item) => item.runId === calibrationRun.id).length < calibrationRun.qualifyingCount);
  assert.ok(Date.parse(newAccountHomeRun.capturedAt) > Date.parse(eveningRun.capturedAt));
  assert.equal(calibrationRun.capturedAt, newAccountHomeRun.capturedAt);
  assert.equal(manualCalibrationRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(manualCalibrationRun.surface, "search");
  assert.equal(manualCalibrationRun.seenCount, 20);
  assert.equal(manualCalibrationRun.qualifyingCount, 1);
  assert.equal(manualCalibrationRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === manualCalibrationRun.id).length, 0);
  assert.ok(manualCalibrationRun.themeIds.includes("introversion-social-battery"));
  assert.equal(postCalibrationHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(postCalibrationHomeRun.surface, "home");
  assert.equal(postCalibrationHomeRun.seenCount, 27);
  assert.equal(postCalibrationHomeRun.qualifyingCount, 0);
  assert.equal(postCalibrationHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === postCalibrationHomeRun.id).length, 0);
  assert.ok(Date.parse(manualCalibrationRun.capturedAt) > Date.parse(calibrationRun.capturedAt));
  assert.equal(manualCalibrationRun.capturedAt, postCalibrationHomeRun.capturedAt);
  assert.equal(longCalibrationRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(longCalibrationRun.surface, "search");
  assert.equal(longCalibrationRun.seenCount, 51);
  assert.equal(longCalibrationRun.qualifyingCount, 9);
  assert.equal(longCalibrationRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === longCalibrationRun.id).length, 5);
  assert.ok(longCalibrationRun.themeIds.includes("reading-and-journaling"));
  assert.ok(longCalibrationRun.themeIds.includes("work-coding-creative-block"));
  assert.ok(longCalibrationRun.themeIds.includes("beatmaking-process"));
  assert.equal(userSeedRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(userSeedRun.surface, "search");
  assert.equal(userSeedRun.seenCount, 10);
  assert.equal(userSeedRun.qualifyingCount, 10);
  assert.equal(userSeedRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === userSeedRun.id).length, 9);
  assert.ok(userSeedRun.themeIds.includes("easter-eggs-and-alternate-rooms"));
  assert.equal(afterLongCalibrationHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(afterLongCalibrationHomeRun.surface, "home");
  assert.equal(afterLongCalibrationHomeRun.seenCount, 31);
  assert.equal(afterLongCalibrationHomeRun.qualifyingCount, 0);
  assert.equal(afterLongCalibrationHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === afterLongCalibrationHomeRun.id).length, 0);
  assert.ok(Date.parse(longCalibrationRun.capturedAt) > Date.parse(postCalibrationHomeRun.capturedAt));
  assert.equal(longCalibrationRun.capturedAt, userSeedRun.capturedAt);
  assert.equal(longCalibrationRun.capturedAt, afterLongCalibrationHomeRun.capturedAt);
  assert.equal(finalImmersionSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(finalImmersionSearchRun.surface, "search");
  assert.equal(finalImmersionSearchRun.seenCount, 160);
  assert.equal(finalImmersionSearchRun.qualifyingCount, 10);
  assert.equal(finalImmersionSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === finalImmersionSearchRun.id).length, 3);
  assert.ok(finalImmersionSearchRun.themeIds.includes("cozy-games-rpg-worlds"));
  assert.ok(finalImmersionSearchRun.themeIds.includes("reading-and-journaling"));
  assert.equal(finalImmersionHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(finalImmersionHomeRun.surface, "home");
  assert.equal(finalImmersionHomeRun.seenCount, 86);
  assert.equal(finalImmersionHomeRun.qualifyingCount, 2);
  assert.equal(finalImmersionHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === finalImmersionHomeRun.id).length, 2);
  assert.ok(Date.parse(finalImmersionSearchRun.capturedAt) > Date.parse(longCalibrationRun.capturedAt));
  assert.equal(finalImmersionSearchRun.capturedAt, finalImmersionHomeRun.capturedAt);
  assert.equal(heartbeatSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(heartbeatSearchRun.surface, "search");
  assert.equal(heartbeatSearchRun.seenCount, 39);
  assert.equal(heartbeatSearchRun.qualifyingCount, 7);
  assert.equal(heartbeatSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === heartbeatSearchRun.id).length, 1);
  assert.ok(heartbeatSearchRun.themeIds.includes("sleep-insomnia-bedtime"));
  assert.ok(heartbeatSearchRun.themeIds.includes("cozy-games-rpg-worlds"));
  assert.equal(heartbeatHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(heartbeatHomeRun.surface, "home");
  assert.equal(heartbeatHomeRun.seenCount, 21);
  assert.equal(heartbeatHomeRun.qualifyingCount, 4);
  assert.equal(heartbeatHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === heartbeatHomeRun.id).length, 4);
  assert.ok(heartbeatHomeRun.themeIds.includes("animal-companions"));
  assert.ok(heartbeatHomeRun.themeIds.includes("reading-and-journaling"));
  assert.ok(Date.parse(heartbeatSearchRun.capturedAt) > Date.parse(finalImmersionHomeRun.capturedAt));
  assert.equal(heartbeatSearchRun.capturedAt, heartbeatHomeRun.capturedAt);
  assert.equal(eveningHeartbeatSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(eveningHeartbeatSearchRun.surface, "search");
  assert.equal(eveningHeartbeatSearchRun.seenCount, 10);
  assert.equal(eveningHeartbeatSearchRun.qualifyingCount, 9);
  assert.equal(eveningHeartbeatSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === eveningHeartbeatSearchRun.id).length, 1);
  assert.ok(eveningHeartbeatSearchRun.themeIds.includes("releases-artist-collabs"));
  assert.ok(Date.parse(eveningHeartbeatSearchRun.capturedAt) > Date.parse(heartbeatHomeRun.capturedAt));
  assert.equal(bigHomeScrollRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(bigHomeScrollRun.surface, "home");
  assert.equal(bigHomeScrollRun.seenCount, 152);
  assert.equal(bigHomeScrollRun.qualifyingCount, 43);
  assert.equal(bigHomeScrollRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === bigHomeScrollRun.id).length, 3);
  assert.ok(bigHomeScrollRun.themeIds.includes("fan-art-and-spotlights"));
  assert.ok(bigHomeScrollRun.themeIds.includes("vinyl-and-instruments"));
  assert.ok(Date.parse(bigHomeScrollRun.capturedAt) > Date.parse(eveningHeartbeatSearchRun.capturedAt));
  assert.equal(morningSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(morningSearchRun.surface, "search");
  assert.equal(morningSearchRun.seenCount, 56);
  assert.equal(morningSearchRun.qualifyingCount, 6);
  assert.equal(morningSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === morningSearchRun.id).length, 0);
  assert.equal(morningHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(morningHomeRun.surface, "home");
  assert.equal(morningHomeRun.seenCount, 38);
  assert.equal(morningHomeRun.qualifyingCount, 4);
  assert.equal(morningHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === morningHomeRun.id).length, 3);
  assert.ok(Date.parse(morningSearchRun.capturedAt) > Date.parse(bigHomeScrollRun.capturedAt));
  assert.equal(morningSearchRun.capturedAt, morningHomeRun.capturedAt);
  assert.equal(frequencyBoostSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(frequencyBoostSearchRun.surface, "search");
  assert.equal(frequencyBoostSearchRun.seenCount, 50);
  assert.equal(frequencyBoostSearchRun.qualifyingCount, 14);
  assert.equal(frequencyBoostSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === frequencyBoostSearchRun.id).length, 2);
  assert.ok(frequencyBoostSearchRun.themeIds.includes("easter-eggs-and-alternate-rooms"));
  assert.equal(frequencyBoostHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(frequencyBoostHomeRun.surface, "home");
  assert.equal(frequencyBoostHomeRun.seenCount, 18);
  assert.equal(frequencyBoostHomeRun.qualifyingCount, 4);
  assert.equal(frequencyBoostHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === frequencyBoostHomeRun.id).length, 0);
  assert.ok(Date.parse(frequencyBoostSearchRun.capturedAt) > Date.parse(morningHomeRun.capturedAt));
  assert.equal(frequencyBoostSearchRun.capturedAt, frequencyBoostHomeRun.capturedAt);
  assert.equal(eveningSearchRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(eveningSearchRun.surface, "search");
  assert.equal(eveningSearchRun.seenCount, 44);
  assert.equal(eveningSearchRun.qualifyingCount, 8);
  assert.equal(eveningSearchRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === eveningSearchRun.id).length, 1);
  assert.ok(eveningSearchRun.themeIds.includes("reading-and-journaling"));
  assert.equal(eveningHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(eveningHomeRun.surface, "home");
  assert.equal(eveningHomeRun.seenCount, 23);
  assert.equal(eveningHomeRun.qualifyingCount, 0);
  assert.equal(eveningHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === eveningHomeRun.id).length, 0);
  assert.ok(Date.parse(eveningSearchRun.capturedAt) > Date.parse(frequencyBoostHomeRun.capturedAt));
  assert.equal(eveningSearchRun.capturedAt, eveningHomeRun.capturedAt);
  assert.equal(septemberFourthReelsRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(septemberFourthReelsRun.surface, "reels");
  assert.equal(septemberFourthReelsRun.seenCount, 103);
  assert.equal(septemberFourthReelsRun.qualifyingCount, 0);
  assert.equal(septemberFourthReelsRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === septemberFourthReelsRun.id).length, 0);
  assert.ok(septemberFourthReelsRun.themeIds.includes("cozy-games-rpg-worlds"));
  assert.equal(septemberFourthHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(septemberFourthHomeRun.surface, "home");
  assert.equal(septemberFourthHomeRun.seenCount, 53);
  assert.equal(septemberFourthHomeRun.qualifyingCount, 0);
  assert.equal(septemberFourthHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === septemberFourthHomeRun.id).length, 0);
  assert.ok(Date.parse(septemberFourthReelsRun.capturedAt) > Date.parse(eveningHomeRun.capturedAt));
  assert.equal(septemberFourthReelsRun.capturedAt, septemberFourthHomeRun.capturedAt);
  assert.equal(septemberFourthLateReelsRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(septemberFourthLateReelsRun.surface, "reels");
  assert.equal(septemberFourthLateReelsRun.seenCount, 121);
  assert.equal(septemberFourthLateReelsRun.qualifyingCount, 0);
  assert.equal(septemberFourthLateReelsRun.sponsoredCount, 0);
  assert.equal(
    feed.items.filter((item) => item.runId === septemberFourthLateReelsRun.id).length,
    0,
  );
  assert.ok(septemberFourthLateReelsRun.themeIds.includes("study-exams-pomodoro"));
  assert.ok(septemberFourthLateReelsRun.themeIds.includes("animal-companions"));
  assert.equal(septemberFourthLateHomeRun.browserContext, SCROLLING_AGENT_TAB_CONTEXT);
  assert.equal(septemberFourthLateHomeRun.surface, "home");
  assert.equal(septemberFourthLateHomeRun.seenCount, 57);
  assert.equal(septemberFourthLateHomeRun.qualifyingCount, 0);
  assert.equal(septemberFourthLateHomeRun.sponsoredCount, 0);
  assert.equal(feed.items.filter((item) => item.runId === septemberFourthLateHomeRun.id).length, 0);
  assert.ok(
    Date.parse(septemberFourthLateReelsRun.capturedAt) >
      Date.parse(septemberFourthHomeRun.capturedAt),
  );
  assert.equal(septemberFourthLateReelsRun.capturedAt, septemberFourthLateHomeRun.capturedAt);
  assert.equal(feed.capturedAt, septemberFourthLateHomeRun.capturedAt);

  let likes = 0;
  for (const item of feed.items) {
    const expected = expectedSources.get(item.source.postId);
    assert.ok(expected, `unexpected source ${item.source.postId}`);
    assert.equal(item.source.author, expected.author);
    assert.equal(item.source.metrics.likes, expected.likes);
    assert.equal(item.source.metrics.precision, "platform-rounded");
    assert.equal(item.source.metrics.views, null);
    assert.equal(item.source.metrics.comments, expected.comments ?? null);
    assert.equal(item.source.metrics.shares, null);
    assert.equal(item.source.metrics.saves, null);
    assert.equal(item.source.thumbnailUrl, null);
    assert.ok(item.source.sponsored === null || item.source.sponsored === false);
    assert.ok(item.source.metrics.likes >= SCROLLING_MINIMUM_LIKES);
    likes += item.source.metrics.likes;
  }
  assert.equal(likes, [...expectedSources.values()].reduce((sum, source) => sum + source.likes, 0));
});

test("the exploration taxonomy is broad and distinguishes observed lenses from future probes", () => {
  assert.equal(themes.explorationLenses.length, 30);
  assert.deepEqual(themes.explorationLenses, feed.explorationLenses);
  assert.equal(feed.explorationLenses.filter((lens) => lens.observedInSnapshot).length, 24);
  assert.equal(
    feed.explorationLenses.find((lens) => lens.id === "animal-companions")?.observedInSnapshot,
    true,
  );
  for (const newlyObserved of [
    "lore-pov-mini-episodes",
    "easter-eggs-and-alternate-rooms",
    "cozy-games-rpg-worlds",
    "introversion-social-battery",
    "work-coding-creative-block",
    "reading-and-journaling",
    "beatmaking-process",
  ]) {
    assert.equal(
      feed.explorationLenses.find((lens) => lens.id === newlyObserved)?.observedInSnapshot,
      true,
    );
  }
  for (const required of [
    "study-exams-pomodoro",
    "adhd-focus-rituals",
    "sleep-insomnia-bedtime",
    "work-coding-creative-block",
    "cafe-train-commute-travel",
    "lore-pov-mini-episodes",
    "cozy-games-rpg-worlds",
    "beatmaking-process",
    "fan-art-and-spotlights",
    "visual-formats-lab",
  ]) {
    assert.ok(feed.explorationLenses.some((lens) => lens.id === required), `missing lens ${required}`);
  }

  const doubleTakeLens = feed.explorationLenses.find(
    (lens) => lens.id === "easter-eggs-and-alternate-rooms",
  );
  assert.ok(doubleTakeLens);
  assert.match(doubleTakeLens.description, /DcwhlAHioLv/u);
  assert.match(doubleTakeLens.specialty, /micro-anomalies visuelles/u);
  assert.match(doubleTakeLens.discoverySignals.join(" "), /révélation innocente/u);
  assert.match(doubleTakeLens.adaptationAngles.join(" "), /un post sur quatre à six/u);
  assert.match(doubleTakeLens.rejectIf.join(" "), /vape, drogue, arme/u);
});

test("every Lofi adaptation keeps the canonical companion and bans generated media", () => {
  for (const item of feed.items) {
    const { character, companion } = item.adaptation.cast;
    if (character === "lofi-girl") assert.equal(companion, "cat");
    if (character === "lofi-boy") assert.equal(companion, "dog");
    if (character === "both") assert.equal(companion, "cat-and-dog");
    const guardrails = item.adaptation.productionGuardrails.join(" ");
    assert.match(guardrails, /100\s*%\s*humaine?/iu);
    assert.match(guardrails, /Aucune image, vidéo, voix ou musique générée par IA/iu);
    assert.ok(item.adaptation.sequence.length >= 3);
  }
});

test("the validator accepts delegated agent tabs but refuses a classic browser profile or authentication material", () => {
  const delegatedAgentTab = structuredClone(feed);
  delegatedAgentTab.runs.at(-1).browserContext = SCROLLING_AGENT_TAB_CONTEXT;
  assert.doesNotThrow(() => assertScrollingFeed(delegatedAgentTab));

  const classicProfile = structuredClone(feed);
  classicProfile.runs[0].browserContext = "default-profile";
  assert.throws(
    () => assertScrollingFeed(classicProfile),
    /contexte de navigation explicitement confié obligatoire/u,
  );

  const withCookie = structuredClone(feed);
  withCookie.runs[0].cookie = "forbidden";
  assert.throws(() => assertScrollingFeed(withCookie), /donnée d’authentification interdite/u);
});

test("the validator keeps unknown metrics nullable and refuses invented or weak likes", () => {
  const nullable = structuredClone(feed);
  nullable.items[0].source.metrics.views = null;
  assert.doesNotThrow(() => assertScrollingFeed(nullable));

  const missingLikes = structuredClone(feed);
  missingLikes.items[0].source.metrics.likes = null;
  missingLikes.items[0].source.metrics.precision = "unavailable";
  assert.throws(() => assertScrollingFeed(missingLikes), /Seuil de likes non atteint/u);

  const weakLikes = structuredClone(feed);
  weakLikes.items[0].source.metrics.likes = 9_999;
  assert.throws(() => assertScrollingFeed(weakLikes), /Seuil de likes non atteint/u);
});

test("the validator rejects duplicate sources, external media and inconsistent companions", () => {
  const duplicate = structuredClone(feed);
  duplicate.items[1].source = structuredClone(duplicate.items[0].source);
  assert.throws(() => assertScrollingFeed(duplicate), /Source Scrolling dupliquée/u);

  const externalThumbnail = structuredClone(feed);
  externalThumbnail.items[0].source.thumbnailUrl = "https://scontent.cdninstagram.com/signed.jpg?token=secret";
  assert.throws(
    () => assertScrollingFeed(externalThumbnail),
    /donnée d’authentification interdite|miniature externe ou éphémère refusée/u,
  );

  const wrongAnimal = structuredClone(feed);
  wrongAnimal.items[0].adaptation.cast.companion = "dog";
  assert.throws(() => assertScrollingFeed(wrongAnimal), /personnage et animal incohérents/u);
});

test("the feed and themes catalogue cannot silently diverge", () => {
  const divergentThemes = structuredClone(themes);
  divergentThemes.explorationLenses[0].label = "Changed";
  assert.throws(
    () => assertScrollingFeed(feed, divergentThemes),
    /themes\.json diverge du snapshot Scrolling/u,
  );

  const wrongObservation = structuredClone(feed);
  wrongObservation.explorationLenses.find((lens) => lens.id === "anxiety-and-overthinking").observedInSnapshot = true;
  assert.throws(() => assertScrollingFeed(wrongObservation), /observedInSnapshot incohérent/u);
});

test("the validator separates observed, qualified, retained and sponsored counts", () => {
  const tooManyRetained = structuredClone(feed);
  tooManyRetained.runs.find((run) => run.id.endsWith("extended")).qualifyingCount = 15;
  assert.throws(() => assertScrollingFeed(tooManyRetained), /Plus d’idées retenues/u);

  const impossibleSponsoredCount = structuredClone(feed);
  impossibleSponsoredCount.runs.find((run) => run.id.endsWith("extended")).sponsoredCount = 505;
  assert.throws(() => assertScrollingFeed(impossibleSponsoredCount), /sponsoredCount invalide/u);

  const uncountedSponsoredSource = structuredClone(feed);
  uncountedSponsoredSource.items.find((item) => item.runId.endsWith("extended")).source.sponsored = true;
  assert.throws(() => assertScrollingFeed(uncountedSponsoredSource), /sources sponsorisées retenues qu’observées/u);
});

test("the API route validates both snapshots, disables caching and refuses writes", async () => {
  const route = await readFile(new URL("../app/api/scrolling/route.ts", import.meta.url), "utf8");
  assert.match(route, /assertScrollingFeed\(/u);
  assert.match(route, /scrollingThemesJson as ScrollingThemeCatalog/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.match(route, /status: 405/u);
  assert.match(route, /navigation privée explicitement confiée/u);
});
