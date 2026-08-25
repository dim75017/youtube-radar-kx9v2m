/**
 * Editorial scoring of a comment opportunity.
 *
 * These two scores are heuristics, not measurements, and they are kept in one
 * auditable place for that reason. They answer two different questions:
 *
 * - `lofiFitScore`  : can Lofi Girl say something here that only she could say?
 * - `commentabilityScore` : is there a live comment section where being early
 *   is still worth anything?
 *
 * Neither of them ever compares raw counters across platforms.
 */

import {
  type CommentOpportunity,
  type CommentOpportunityCategory,
} from "./comment-opportunities.ts";

const HOUR_IN_MILLISECONDS = 60 * 60 * 1_000;

/** Baseline affinity of a vertical with the Lofi Girl universe. */
const CATEGORY_FIT: Record<CommentOpportunityCategory, number> = {
  music: 78,
  cinema: 72,
  gaming: 70,
  internet: 64,
  tech: 58,
  other: 54,
  sport: 44,
};

/**
 * Words that put the post inside the desk-lamp-and-rain world. Matching two of
 * them is a strong signal; matching six is usually a description that repeats
 * itself, so the bonus is capped.
 */
const AFFINITY_TERMS = [
  "study", "studying", "revision", "homework", "essay", "exam", "focus", "concentration",
  "chill", "cozy", "cosy", "calm", "relax", "slow", "quiet", "soft",
  "rain", "rainy", "storm", "snow", "autumn", "winter", "night", "midnight", "2am", "late night",
  "coffee", "café", "tea", "desk", "bedroom", "window", "lamp", "candle", "book", "reading",
  "cat", "kitten", "dog", "puppy",
  "lofi", "lo-fi", "beat", "beats", "piano", "jazz", "ambient", "soundtrack", "score", "ost",
  "playlist", "vinyl", "guitar", "melody", "theme song",
  "nostalgia", "nostalgic", "memories", "childhood", "years later", "anniversary",
  "sunset", "sunrise", "clouds", "forest", "ocean", "train", "city",
  // The board also carries hand-curated cards written in French.
  "révis", "revis", "devoirs", "bibliothèque", "pluie", "nuit", "bougie", "café",
  "chat", "cosy", "calme", "lecture", "vinyle", "automne", "hiver", "neige",
] as const;

/** Subjects where an in-character joke has nowhere to go. */
const ANTI_AFFINITY_TERMS = [
  "highlights", "full match", "press conference", "quarterly", "earnings", "keynote recap",
  "unboxing", "benchmark", "spec sheet", "tutorial", "how to install",
] as const;

function countTerms(haystack: string, terms: readonly string[]) {
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matches += 1;
  }
  return matches;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function commentOpportunityLofiFitScore(
  opportunity: Pick<CommentOpportunity, "category" | "title" | "caption" | "durationSeconds">,
) {
  const haystack = `${opportunity.title} ${opportunity.caption}`.toLocaleLowerCase("en");
  const affinity = Math.min(4, countTerms(haystack, AFFINITY_TERMS));
  const friction = Math.min(2, countTerms(haystack, ANTI_AFFINITY_TERMS));
  // A trailer or a music video is a moment; a two-hour upload is a programme.
  const lengthPenalty = opportunity.durationSeconds !== null && opportunity.durationSeconds > 1_800
    ? 6
    : 0;
  return clampScore(
    CATEGORY_FIT[opportunity.category] + affinity * 5 - friction * 7 - lengthPenalty,
  );
}

/**
 * Rewards a section that is actually talking, and being early enough that a
 * comment can still be seen. A post with a visible zero on comments is treated
 * as closed, because pasting into a disabled section wastes a CM's turn.
 */
export function commentOpportunityCommentabilityScore(
  opportunity: Pick<
    CommentOpportunity,
    "metrics" | "publishedAt" | "capturedAt" | "velocity" | "momentTier"
  >,
) {
  const { comments, views } = opportunity.metrics;
  if (comments === 0) return 12;

  let score = 55;
  if (comments !== null && views !== null && views > 0) {
    const conversationRate = comments / views;
    if (conversationRate >= 0.004) score += 18;
    else if (conversationRate >= 0.002) score += 12;
    else if (conversationRate >= 0.001) score += 6;
    else score -= 6;
  } else if (comments !== null && comments >= 1_000) {
    score += 8;
  }

  const publishedAt = opportunity.publishedAt === null
    ? Number.NaN
    : Date.parse(opportunity.publishedAt);
  const capturedAt = Date.parse(opportunity.capturedAt);
  if (Number.isFinite(publishedAt) && Number.isFinite(capturedAt)) {
    const ageHours = Math.max(0, (capturedAt - publishedAt) / HOUR_IN_MILLISECONDS);
    if (ageHours <= 3) score += 14;
    else if (ageHours <= 12) score += 8;
    else if (ageHours >= 72) score -= 10;
  }

  if (opportunity.momentTier === "s") score += 8;
  else if (opportunity.momentTier === "b") score -= 4;
  if (opportunity.velocity !== null) score += 4;

  return clampScore(score);
}

/**
 * One sentence a community manager can act on: what happened, how fast, and
 * how long the window stays open. Only stated facts, no adjectives.
 */
export function commentOpportunityWhyNow(
  opportunity: Pick<
    CommentOpportunity,
    "discovery" | "author" | "publishedAt" | "capturedAt" | "velocity" | "metrics" | "momentTier"
  >,
) {
  const parts: string[] = [];
  const publishedAt = opportunity.publishedAt === null
    ? Number.NaN
    : Date.parse(opportunity.publishedAt);
  const capturedAt = Date.parse(opportunity.capturedAt);
  if (Number.isFinite(publishedAt) && Number.isFinite(capturedAt)) {
    const ageHours = (capturedAt - publishedAt) / HOUR_IN_MILLISECONDS;
    const age = ageHours < 1
      ? `il y a ${Math.max(1, Math.round(ageHours * 60))} min`
      : `il y a ${Math.round(ageHours)} h`;
    parts.push(
      opportunity.discovery.source === "watchlist"
        ? `Publié par ${opportunity.author} ${age}.`
        : `Repéré ${age} après publication.`,
    );
  } else {
    parts.push(`Publication de ${opportunity.author}, date non exposée.`);
  }

  if (opportunity.velocity) {
    const metricLabel = opportunity.velocity.metric === "views"
      ? "vues"
      : opportunity.velocity.metric === "likes"
        ? "likes"
        : "commentaires";
    parts.push(
      `+${opportunity.velocity.perHour.toLocaleString("fr-FR")} ${metricLabel}/h mesurés sur ${opportunity.velocity.windowHours} h.`,
    );
  } else if (opportunity.metrics.views !== null) {
    parts.push(`${opportunity.metrics.views.toLocaleString("fr-FR")} vues au premier relevé, accélération pas encore mesurée.`);
  } else {
    parts.push("Compteurs publics indisponibles à ce relevé.");
  }

  if (opportunity.momentTier === "s") {
    parts.push("La section va saturer vite.");
  }
  const sentence = parts.join(" ");
  return sentence.length <= 220 ? sentence : `${sentence.slice(0, 217)}...`;
}
