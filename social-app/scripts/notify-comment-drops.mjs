/**
 * Discord alert for a major drop.
 *
 * The board is only useful if somebody is looking at it. A trailer that lands
 * at 19:00 is worth a comment for about three hours, which is exactly when
 * nobody has the dashboard open. This posts the card and its three proposals
 * into the CM channel, once, and marks it as alerted so it never repeats.
 *
 * It posts to Discord. It never posts a comment anywhere: the CM still copies,
 * reads and decides.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCommentOpportunityFeed,
  commentOpportunityGoldenWindow,
  COMMENT_OPPORTUNITY_CATEGORY_LABELS,
  COMMENT_OPPORTUNITY_MOMENT_TIER_LABELS,
  rankCommentOpportunities,
} from "../lib/comment-opportunities.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = resolve(root, "data", "comment-opportunities", "feed.json");

/** Ceiling per run: an alert channel that cries wolf is muted within a week. */
const MAX_ALERTS_PER_RUN = 3;
const TONE_TITLES = { funny: "Drôle", smart: "Smart", complice: "Complice" };
const TIER_COLORS = { s: 0xfbbf24, a: 0x9aa8ff, b: 0x5d6485 };

/**
 * Alert-worthy means: big enough, still open, and not already announced.
 * A card whose window has closed is a dashboard entry, not a notification.
 */
export function selectAlertableDrops(feed, nowIso) {
  return rankCommentOpportunities(feed.opportunities, feed.capturedAt).filter((opportunity) => {
    if (opportunity.alertedAt !== null) return false;
    if (opportunity.momentTier === "b") return false;
    if (opportunity.risk.level === "medium") return false;
    const window = commentOpportunityGoldenWindow(opportunity, nowIso);
    return window.state === "open" || window.state === "closing";
  });
}

export function buildDiscordMessage(opportunity, nowIso) {
  const window = commentOpportunityGoldenWindow(opportunity, nowIso);
  const remaining = window.remainingMinutes === null
    ? "fenêtre inconnue"
    : window.remainingMinutes >= 60
      ? `fenêtre ~${Math.floor(window.remainingMinutes / 60)} h`
      : `fenêtre ~${window.remainingMinutes} min`;
  const velocity = opportunity.velocity
    ? `+${opportunity.velocity.perHour.toLocaleString("fr-FR")} ${opportunity.velocity.metric}/h sur ${opportunity.velocity.windowHours} h`
    : "accélération pas encore mesurée";

  return {
    // No role or everyone ping: the channel decides its own notification level.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: opportunity.title.slice(0, 250),
        url: opportunity.url,
        color: TIER_COLORS[opportunity.momentTier],
        author: { name: opportunity.author.slice(0, 250) },
        description: opportunity.whyNow.slice(0, 400),
        thumbnail: opportunity.thumbnailUrl ? { url: opportunity.thumbnailUrl } : undefined,
        fields: [
          ...opportunity.comments.map((comment) => ({
            name: TONE_TITLES[comment.tone] ?? comment.label,
            value: comment.text,
            inline: false,
          })),
          {
            name: "Signal",
            value: `${COMMENT_OPPORTUNITY_MOMENT_TIER_LABELS[opportunity.momentTier]} · ${COMMENT_OPPORTUNITY_CATEGORY_LABELS[opportunity.category]} · ${velocity} · ${remaining}`,
            inline: false,
          },
        ],
        footer: {
          text: opportunity.commentsSource === "curated"
            ? "Propositions écrites à la main. Rien n'est posté automatiquement."
            : opportunity.commentsSource === "voice-engine"
              ? "Propositions à relire avant de poster. Rien n'est posté automatiquement."
              : "Propositions génériques, à réécrire. Rien n'est posté automatiquement.",
        },
      },
    ],
  };
}

export async function notifyCommentDrops(options = {}) {
  const webhookUrl = options.webhookUrl ?? process.env.DISCORD_CM_WEBHOOK_URL ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date().toISOString();
  const log = options.log ?? ((message) => console.log(message));
  const path = options.feedPath ?? feedPath;

  const feed = assertCommentOpportunityFeed(JSON.parse(await readFile(path, "utf8")));
  const alertable = selectAlertableDrops(feed, now).slice(0, MAX_ALERTS_PER_RUN);
  const skipped = selectAlertableDrops(feed, now).length - alertable.length;
  if (skipped > 0) {
    log(`${skipped} drops éligibles non annoncés ce passage : plafond de ${MAX_ALERTS_PER_RUN}.`);
  }

  if (alertable.length === 0) {
    return { sent: 0, failed: 0, skipped, configured: webhookUrl.length > 0 };
  }
  if (!webhookUrl) {
    log(`${alertable.length} drops à annoncer, mais aucun webhook Discord configuré.`);
    return { sent: 0, failed: 0, skipped, configured: false };
  }

  let sent = 0;
  let failed = 0;
  for (const opportunity of alertable) {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildDiscordMessage(opportunity, now)),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Marked only after Discord accepted it, so a failed post is retried on
      // the next pass instead of being silently lost.
      opportunity.alertedAt = now;
      sent += 1;
      log(`Annoncé : ${opportunity.author} — ${opportunity.title}`);
    } catch (error) {
      failed += 1;
      log(`Échec d'annonce ${opportunity.id} : ${error instanceof Error ? error.message : "inconnu"}`);
    }
  }

  if (sent > 0 && !options.dryRun) {
    assertCommentOpportunityFeed(feed);
    await writeFile(path, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  }
  return { sent, failed, skipped, configured: true };
}

if (process.argv[1]?.endsWith("notify-comment-drops.mjs")) {
  const result = await notifyCommentDrops({ dryRun: process.argv.includes("--dry-run") });
  console.log(
    `${result.sent} annonce(s) envoyée(s), ${result.failed} échec(s)${
      result.configured ? "" : ", webhook absent"
    }.`,
  );
  if (result.failed > 0) process.exit(1);
}
