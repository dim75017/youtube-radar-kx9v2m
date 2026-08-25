import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { commentOpportunityMomentTier } from "../lib/comment-opportunities.ts";
import {
  buildDiscordMessage,
  notifyCommentDrops,
  selectAlertableDrops,
} from "../scripts/notify-comment-drops.mjs";

const CAPTURED_AT = "2026-08-13T10:00:00.000Z";
/** Counters chosen so the derived tier is the one each case is testing. */
const TIER_VIEWS = { s: 6_000_000, a: 1_500_000, b: 40_000 };

/**
 * Fully synthetic cards rather than clones of the live snapshot: the board
 * changes every quarter of an hour, and a test that borrows from it starts
 * failing for reasons that have nothing to do with alerting.
 */
function feedWith(cases) {
  return {
    version: 2,
    capturedAt: CAPTURED_AT,
    nextRefreshAt: "2026-08-13T16:00:00.000Z",
    cadenceHours: 6,
    fastLaneMinutes: 15,
    fastLaneCheckedAt: CAPTURED_AT,
    watchlistAccountCount: 97,
    sourceChecks: ["youtube", "instagram", "tiktok", "x"].map((platform) => ({
      id: `${platform}-native-public`,
      platform,
      status: "limited",
      checkedAt: CAPTURED_AT,
      label: `${platform} · relevé de test`,
    })),
    opportunities: cases.map(({ tier = "a", ...rest }, index) => {
      const metrics = { views: TIER_VIEWS[tier], likes: null, comments: null, shares: null };
      const card = {
        id: `alert-case-${index}`,
        platform: "youtube",
        category: "gaming",
        author: "Rockstar Games",
        title: `Trailer de test numéro ${index}`,
        caption: "Une bande-annonce de test, sans sujet délicat.",
        url: `https://www.youtube.com/watch?v=aaaaaaaaa${index}0`,
        mediaType: "video",
        durationSeconds: null,
        thumbnailUrl: null,
        publishedAt: "2026-08-13T09:00:00.000Z",
        capturedAt: CAPTURED_AT,
        status: "hot",
        momentTier: tier,
        discovery: { source: "viral-scan", accountHandle: null, accountTier: null },
        velocity: null,
        lofiFitScore: 80,
        commentabilityScore: 60,
        priorityScore: 71,
        whyNow: "Carte de test.",
        risk: { level: "low", note: "rien à signaler" },
        metrics,
        observations: [
          {
            capturedAt: CAPTURED_AT,
            ...metrics,
            sourceLabel: "YouTube · flux Atom de test",
            sourceUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCtest",
            exactness: "exact",
          },
        ],
        comments: [
          { tone: "funny", label: "Drôle", text: `test trailer ${index} just closed the notebook` },
          { tone: "smart", label: "Smart", text: `test trailer ${index} is a precise title for this interruption` },
          { tone: "complice", label: "Complice", text: `the study table made room for test trailer ${index}` },
        ],
        commentsSource: "curated",
        alertedAt: null,
        ...rest,
      };
      card.momentTier = commentOpportunityMomentTier(card);
      return card;
    }),
  };
}

test("only an open, unannounced, low-risk moment is worth a notification", () => {
  const feed = feedWith([
    { tier: "s" },
    { tier: "b" },
    { tier: "s", alertedAt: "2026-08-13T09:30:00.000Z" },
    { tier: "s", risk: { level: "medium", note: "sujet à relire" } },
    { tier: "a", publishedAt: "2026-08-01T09:00:00.000Z" },
  ]);
  const alertable = selectAlertableDrops(feed, "2026-08-13T10:05:00.000Z");
  assert.deepEqual(alertable.map((item) => item.id), ["alert-case-0"]);
});

test("the message carries the three proposals and never pings the channel", () => {
  const feed = feedWith([{ tier: "s" }]);
  const message = buildDiscordMessage(feed.opportunities[0], "2026-08-13T10:05:00.000Z");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  const embed = message.embeds[0];
  assert.equal(embed.url, feed.opportunities[0].url);
  assert.equal(embed.fields.length, 4);
  assert.deepEqual(embed.fields.slice(0, 3).map((field) => field.value), feed.opportunities[0].comments.map((comment) => comment.text));
  assert.match(embed.fields[3].value, /fenêtre/u);
  assert.match(embed.footer.text, /Rien n'est posté automatiquement/u);
});

test("a card is only marked as announced once Discord has accepted it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comment-alerts-"));
  const path = join(dir, "feed.json");
  await writeFile(path, JSON.stringify(feedWith([{ tier: "s" }, { tier: "s" }])), "utf8");

  const calls = [];
  const failing = await notifyCommentDrops({
    feedPath: path,
    webhookUrl: "https://discord.com/api/webhooks/test",
    now: "2026-08-13T10:05:00.000Z",
    log: () => {},
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response("rate limited", { status: 429 });
    },
  });
  assert.equal(failing.sent, 0);
  assert.equal(failing.failed, 2);
  const afterFailure = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    afterFailure.opportunities.map((item) => item.alertedAt),
    [null, null],
    "a refused post must stay in the queue for the next pass",
  );

  const succeeding = await notifyCommentDrops({
    feedPath: path,
    webhookUrl: "https://discord.com/api/webhooks/test",
    now: "2026-08-13T10:20:00.000Z",
    log: () => {},
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.equal(succeeding.sent, 2);
  const afterSuccess = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    afterSuccess.opportunities.map((item) => item.alertedAt),
    ["2026-08-13T10:20:00.000Z", "2026-08-13T10:20:00.000Z"],
  );

  const repeat = await notifyCommentDrops({
    feedPath: path,
    webhookUrl: "https://discord.com/api/webhooks/test",
    now: "2026-08-13T10:35:00.000Z",
    log: () => {},
    fetchImpl: async () => {
      throw new Error("il ne devrait plus rien y avoir à annoncer");
    },
  });
  assert.equal(repeat.sent, 0);
});

test("no webhook means no alert and no crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comment-alerts-"));
  const path = join(dir, "feed.json");
  await writeFile(path, JSON.stringify(feedWith([{ tier: "s" }])), "utf8");
  const result = await notifyCommentDrops({
    feedPath: path,
    webhookUrl: "",
    now: "2026-08-13T10:05:00.000Z",
    log: () => {},
    fetchImpl: async () => {
      throw new Error("aucun appel réseau ne doit partir sans webhook");
    },
  });
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: 0, configured: false });
});
