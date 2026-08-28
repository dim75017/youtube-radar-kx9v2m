import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAudienceAnalytics } from "../lib/audience-analytics.ts";
import { assertAudienceDemographics } from "../lib/audience-demographics.ts";
import { assertAudienceHistory } from "../lib/audience-metrics.ts";
import { assertAudioTrendFeed } from "../lib/audio-trends.ts";
import { assertCommentOpportunityFeed } from "../lib/comment-opportunities.ts";
import { assertPlaylistPromoFeed } from "../lib/playlist-promos.ts";
import { assertScrollingFeed } from "../lib/scrolling.ts";
import { assertSocialTrendFeed } from "../lib/social-trends.ts";
import {
  assertAudioTrendScanStatus,
  assertVideoTrendScanStatus,
} from "../lib/trend-scan-status.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = process.env.LOFI_SOCIAL_OUT_DIR
  ? resolve(root, process.env.LOFI_SOCIAL_OUT_DIR)
  : resolve(root, "work", "pages-dist");
const output = resolve(outputRoot, "data");
const platforms = ["youtube", "instagram", "tiktok", "x"];

const [
  snapshot,
  summary,
  trendFeed,
  videoTrendScanStatus,
  audioTrendFeed,
  audioTrendScanStatus,
  audienceHistory,
  audienceAnalytics,
  audienceDemographics,
  commentOpportunityFeed,
  commentOpportunityStatus,
  playlistPromoFeed,
  playlistPromoStatus,
  scrollingFeed,
] = await Promise.all([
  readJson(resolve(root, "data", "public-history.json")),
  readJson(resolve(root, "data", "public-history-summary.json")),
  readJson(resolve(root, "data", "trends", "feed.json")),
  readJson(resolve(root, "data", "trends", "refresh-status.json")),
  readJson(resolve(root, "data", "audio-trends", "feed.json")),
  readJson(resolve(root, "data", "audio-trends", "refresh-status.json")),
  readJson(resolve(root, "data", "audience-history.json")),
  readJson(resolve(root, "data", "audience-analytics.json")),
  readJson(resolve(root, "data", "audience-demographics.json")),
  readJson(resolve(root, "data", "comment-opportunities", "feed.json")),
  readJson(resolve(root, "data", "comment-opportunities", "refresh-status.json")),
  readJson(resolve(root, "data", "playlist-promos", "feed.json")),
  readJson(resolve(root, "data", "playlist-promos", "refresh-status.json")),
  readJson(resolve(root, "data", "scrolling", "feed.json")),
]);

if (snapshot.generatedAt !== summary.generatedAt) {
  throw new Error("Le résumé public ne correspond pas à la version de l’historique.");
}
if (snapshot.posts.length !== summary.totalPostCount) {
  throw new Error("Le total du résumé public ne correspond pas à l’historique.");
}
assertSocialTrendFeed(trendFeed);
assertVideoTrendScanStatus(videoTrendScanStatus);
assertAudioTrendFeed(audioTrendFeed);
assertAudioTrendScanStatus(audioTrendScanStatus);
assertAudienceHistory(audienceHistory);
assertAudienceAnalytics(audienceAnalytics);
assertAudienceDemographics(audienceDemographics);
assertCommentOpportunityFeed(commentOpportunityFeed);
if (
  !["fast", "deep"].includes(commentOpportunityStatus?.lane) ||
  !Number.isFinite(Date.parse(commentOpportunityStatus.ranAt)) ||
  !Number.isInteger(commentOpportunityStatus.watchedAccounts) ||
  !Number.isInteger(commentOpportunityStatus.published)
) {
  throw new Error("Le statut Commentaires est invalide.");
}
assertPlaylistPromoFeed(playlistPromoFeed);
assertScrollingFeed(scrollingFeed);
if (
  playlistPromoStatus?.version !== 1 ||
  !["success", "partial", "failed"].includes(playlistPromoStatus.status) ||
  !Number.isFinite(Date.parse(playlistPromoStatus.lastAttemptAt)) ||
  !Array.isArray(playlistPromoStatus.errors)
) {
  throw new Error("Le statut Pubs playlists est invalide.");
}

await mkdir(output, { recursive: true });
await mkdir(resolve(output, "trends"), { recursive: true });
await mkdir(resolve(output, "audio-trends"), { recursive: true });
await mkdir(resolve(output, "comment-opportunities"), { recursive: true });
await mkdir(resolve(output, "playlist-promos"), { recursive: true });
await mkdir(resolve(output, "scrolling"), { recursive: true });
await writeJson(resolve(output, "public-history-summary.json"), summary);
await writeJson(resolve(output, "public-history.json"), snapshot);
await writeJson(resolve(output, "audience-history.json"), audienceHistory);
await writeJson(resolve(output, "audience-analytics.json"), audienceAnalytics);
await writeJson(resolve(output, "audience-demographics.json"), audienceDemographics);
await writeJson(resolve(output, "trends", "feed.json"), trendFeed);
await writeJson(resolve(output, "trends", "refresh-status.json"), videoTrendScanStatus);
await writeJson(resolve(output, "audio-trends", "feed.json"), audioTrendFeed);
await writeJson(resolve(output, "audio-trends", "refresh-status.json"), audioTrendScanStatus);
await writeJson(resolve(output, "comment-opportunities", "feed.json"), commentOpportunityFeed);
await writeJson(
  resolve(output, "comment-opportunities", "refresh-status.json"),
  commentOpportunityStatus,
);
await writeJson(resolve(output, "playlist-promos", "feed.json"), playlistPromoFeed);
await writeJson(resolve(output, "playlist-promos", "refresh-status.json"), playlistPromoStatus);
await writeJson(resolve(output, "scrolling", "feed.json"), scrollingFeed);

for (const platform of platforms) {
  const posts = snapshot.posts.filter((post) => post.platform === platform);
  if (posts.length !== summary.platformCounts[platform]) {
    throw new Error(`Le compteur ${platform} du résumé public est incohérent.`);
  }
  await writeJson(resolve(output, `public-history-${platform}.json`), {
    generatedAt: snapshot.generatedAt,
    coverage: snapshot.coverage.filter((item) => item.platform === platform),
    posts,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
