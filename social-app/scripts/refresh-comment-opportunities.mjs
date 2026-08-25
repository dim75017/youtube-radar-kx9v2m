/**
 * Comment radar refresh.
 *
 * Two lanes and two stores.
 *
 * - `--lane=fast` (every 15 minutes) reads the Atom feed of every watchlist
 *   channel. The feed is free, needs no API key, carries the public view
 *   counter, and updates within minutes of an upload. That is what lets a
 *   trailer reach the board while its comment section is still empty.
 * - `--lane=deep` (every 6 hours) widens the discovery horizon and prunes.
 *
 * The two stores exist because measuring and publishing are different jobs.
 * `candidates.json` holds a reading of everything the watchlist posted, which
 * is the only way to have a baseline when something starts to climb. The board
 * itself, `feed.json`, only receives what has cleared a bar: a community
 * manager should open it and see ten things worth a comment, not four hundred
 * uploads.
 *
 * Everything written is either read from a public source or derived from two
 * comparable readings of the same counter. Nothing is estimated, and a source
 * that fails leaves its previous verified snapshot in place.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCommentOpportunityFeed,
  commentOpportunityGoldenWindow,
  commentOpportunityIsSensitive,
  commentOpportunityMomentTier,
  commentOpportunityPriorityScore,
  COMMENT_OPPORTUNITY_FAST_LANE_MINUTES,
  COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS,
  hasCommentOpportunityAccelerationEvidence,
  measureCommentOpportunityVelocity,
  nativeCommentOpportunityIdentity,
  rankCommentOpportunities,
} from "../lib/comment-opportunities.ts";
import {
  commentOpportunityCommentabilityScore,
  commentOpportunityLofiFitScore,
  commentOpportunityWhyNow,
} from "../lib/comment-scoring.ts";
import {
  curatedLofiComments,
  fallbackLofiComments,
  requestLofiComments,
  validateLofiComment,
} from "../lib/lofi-voice.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "data", "comment-opportunities");
const defaultPaths = {
  feed: resolve(dataDir, "feed.json"),
  watchlist: resolve(dataDir, "watchlist.json"),
  candidates: resolve(dataDir, "candidates.json"),
  status: resolve(dataDir, "refresh-status.json"),
};

const MINUTE_IN_MILLISECONDS = 60 * 1_000;
const HOUR_IN_MILLISECONDS = 60 * MINUTE_IN_MILLISECONDS;
const DAY_IN_MILLISECONDS = 24 * HOUR_IN_MILLISECONDS;
const ATOM_TIMEOUT_MS = 12_000;
const ATOM_CONCURRENCY = 8;
/** How far back an upload can be and still be picked up as a discovery. */
const DISCOVERY_HORIZON_HOURS = { fast: 48, deep: 168 };
/** Two readings closer than this are the same reading; appending would lie. */
const MIN_OBSERVATION_GAP_MS = 8 * MINUTE_IN_MILLISECONDS;
/**
 * A card inside its golden window is re-read every lane pass, because that is
 * where acceleration is decided. Once the window is closed, hourly is plenty,
 * and it keeps the snapshot from churning on every single run.
 */
const HOT_OBSERVATION_GAP_MS = 14 * MINUTE_IN_MILLISECONDS;
const COLD_OBSERVATION_GAP_MS = 60 * MINUTE_IN_MILLISECONDS;
const MAX_OBSERVATIONS = 24;
const MAX_CANDIDATE_OBSERVATIONS = 8;
const MAX_CANDIDATES = 900;
const PRUNE_AFTER_DAYS = 14;
const MAX_BOARD_CARDS = 30;
const MAX_YOUTUBE_CARDS = 18;
const MIN_CARDS_PER_PLATFORM = 4;
/** A daily series is one opportunity, not five. */
const MAX_CARDS_PER_AUTHOR = 2;
/** Bounds both the wall clock of a 15-minute lane and the monthly bill. */
const MAX_VOICE_GENERATIONS = { fast: 6, deep: 18 };
const USER_AGENT =
  "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/lofi-social-radar)";

const PLATFORMS = ["youtube", "instagram", "tiktok", "x"];

// ---------------------------------------------------------------- Atom feeds

export function parseAtomEntries(xml) {
  const entries = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const body = block.split("</entry>")[0] ?? "";
    const videoId = body.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/u)?.[1];
    if (!videoId) continue;
    const published = body.match(/<published>([^<]+)<\/published>/u)?.[1] ?? null;
    const publishedAt = published ? new Date(published) : null;
    const thumbnail = body.match(/<media:thumbnail\s+url="([^"]+)"/u)?.[1] ?? null;
    const viewsRaw = body.match(/<media:statistics\s+views="(\d+)"/u)?.[1] ?? null;
    entries.push({
      videoId,
      title: decodeXmlText(body.match(/<title>([\s\S]*?)<\/title>/u)?.[1] ?? "").trim(),
      author: decodeXmlText(
        body.match(/<author>\s*<name>([\s\S]*?)<\/name>/u)?.[1] ?? "",
      ).trim(),
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime())
        ? publishedAt.toISOString()
        : null,
      thumbnailUrl: thumbnail?.startsWith("https://") ? thumbnail : null,
      description: decodeXmlText(
        body.match(/<media:description>([\s\S]*?)<\/media:description>/u)?.[1] ?? "",
      ).trim(),
      // The feed also carries a rating count. It is not a like counter and is
      // deliberately not read here.
      views: viewsRaw === null ? null : Number.parseInt(viewsRaw, 10),
    });
  }
  return entries;
}

function decodeXmlText(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&nbsp;|&#160;/gu, " ")
    .replace(/&amp;/gu, "&");
}

async function fetchChannelFeed(account, fetchImpl) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${account.youtubeChannelId}`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/atom+xml,application/xml", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(ATOM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { url, entries: parseAtomEntries(await response.text()) };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------------------------------------------------ Shaping

export function opportunityIdFor(platform, nativeId) {
  const slug = nativeId.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const digest = createHash("sha1").update(`${platform}:${nativeId}`).digest("hex").slice(0, 6);
  return `${platform === "youtube" ? "yt" : platform}-${slug || "post"}-${digest}`;
}

function observationGapFor(record, nowMs) {
  const publishedAt = record.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
  if (!Number.isFinite(publishedAt)) return COLD_OBSERVATION_GAP_MS;
  const window = commentOpportunityGoldenWindow(
    { publishedAt: record.publishedAt, momentTier: record.momentTier ?? "b" },
    new Date(nowMs).toISOString(),
  );
  return window.state === "closed" ? COLD_OBSERVATION_GAP_MS : HOT_OBSERVATION_GAP_MS;
}

function appendObservation(record, observation, { maxObservations, nowMs }) {
  const previous = record.observations.at(-1);
  if (previous) {
    const gap = Date.parse(observation.capturedAt) - Date.parse(previous.capturedAt);
    if (gap < MIN_OBSERVATION_GAP_MS) return record;
    const unchanged = previous.views === observation.views &&
      previous.likes === observation.likes &&
      previous.comments === observation.comments;
    const required = unchanged
      ? COLD_OBSERVATION_GAP_MS
      : observationGapFor(record, nowMs);
    if (gap < required) return record;
  }
  return {
    ...record,
    observations: [...record.observations, observation].slice(-maxObservations),
  };
}

/**
 * Recomputes everything derived, so a stored value can never drift away from
 * the observations that justify it.
 */
export function recomputeOpportunity(opportunity) {
  const latest = opportunity.observations.at(-1);
  const next = {
    ...opportunity,
    capturedAt: latest.capturedAt,
    metrics: {
      views: latest.views,
      likes: latest.likes,
      comments: latest.comments,
      shares: latest.shares,
    },
  };
  next.velocity = measureCommentOpportunityVelocity(next.observations);
  next.momentTier = commentOpportunityMomentTier(next);
  next.lofiFitScore = commentOpportunityLofiFitScore(next);
  next.commentabilityScore = commentOpportunityCommentabilityScore(next);
  next.priorityScore = commentOpportunityPriorityScore(next);
  next.whyNow = commentOpportunityWhyNow(next);
  // "Surging" needs growth visible from the first reading, not only between
  // the last two: a counter that just became readable is a measurement gap.
  next.status = next.velocity !== null && hasCommentOpportunityAccelerationEvidence(next)
    ? "surging"
    : next.metrics.views !== null || next.metrics.likes !== null
      ? "hot"
      : "watch";

  if (commentOpportunityIsSensitive(next)) {
    next.risk = {
      level: "medium",
      note: "Sujet potentiellement sensible détecté dans le titre ou la description : relire avant de poster.",
    };
  } else if (!next.risk || next.risk.note.startsWith("Sujet potentiellement sensible")) {
    next.risk = {
      level: "low",
      note: "Aucun sujet sensible détecté dans les métadonnées publiques.",
    };
  }
  return next;
}

function candidateFrom(entry, account, observation) {
  return {
    identity: `youtube:${entry.videoId}`,
    platform: "youtube",
    category: account.category ?? "other",
    author: entry.author || account.name,
    title: entry.title,
    caption: entry.description.slice(0, 900) || entry.title,
    url: `https://www.youtube.com/watch?v=${entry.videoId}`,
    thumbnailUrl: entry.thumbnailUrl,
    publishedAt: entry.publishedAt,
    momentTier: "b",
    discovery: {
      source: "watchlist",
      accountHandle: account.handle,
      accountTier: account.accountTier,
    },
    observations: [observation],
  };
}

function opportunityFromCandidate(candidate) {
  return recomputeOpportunity({
    id: opportunityIdFor(candidate.platform, candidate.identity.split(":")[1] ?? candidate.identity),
    platform: candidate.platform,
    category: candidate.category,
    author: candidate.author,
    title: candidate.title,
    caption: candidate.caption,
    url: candidate.url,
    mediaType: "video",
    durationSeconds: null,
    thumbnailUrl: candidate.thumbnailUrl,
    publishedAt: candidate.publishedAt,
    capturedAt: candidate.observations.at(-1).capturedAt,
    status: "watch",
    momentTier: "b",
    discovery: candidate.discovery,
    velocity: null,
    lofiFitScore: 0,
    commentabilityScore: 0,
    priorityScore: 0,
    whyNow: "",
    risk: null,
    metrics: { views: null, likes: null, comments: null, shares: null },
    observations: candidate.observations,
    comments: [],
    commentsSource: "fallback",
    alertedAt: null,
  });
}

/**
 * The bar between "we are watching this" and "a human should look now".
 * A major moment always passes. Everything else has to be both climbing and
 * plausible for the brand, otherwise the board fills with uploads nobody will
 * ever comment.
 */
export function qualifiesForBoard(opportunity) {
  if (opportunity.momentTier === "s") return opportunity.lofiFitScore >= 50;
  if (opportunity.momentTier === "a") return opportunity.lofiFitScore >= 58;
  return opportunity.lofiFitScore >= 72 && (opportunity.metrics.views ?? 0) >= 150_000;
}

// ------------------------------------------------------------- Voice engine

async function fillComments(opportunities, { apiKey, limit, fetchImpl, log, now }) {
  for (const opportunity of opportunities) {
    const curated = curatedLofiComments(opportunity);
    if (curated) {
      opportunity.comments = curated;
      opportunity.commentsSource = "curated";
    }
  }
  const needsVoice = rankCommentOpportunities(opportunities).filter((opportunity) => {
    const missing = opportunity.comments.length !== 3 ||
      opportunity.commentsSource === "fallback";
    if (!missing) return false;
    // A card the engine keeps refusing would otherwise be retried on every
    // pass, forever. Once its window is closed there is nothing left to write
    // a punchline for, so the retries stop with it.
    return commentOpportunityGoldenWindow(opportunity, now).state !== "closed";
  });
  const targeted = apiKey ? needsVoice.slice(0, limit) : [];
  let generated = 0;
  let refused = 0;

  for (const opportunity of targeted) {
    let result;
    try {
      result = await requestLofiComments(opportunity, { apiKey, fetchImpl });
    } catch (error) {
      result = { usable: false, reason: error instanceof Error ? error.message : "échec inconnu" };
    }
    if (result.usable) {
      opportunity.comments = result.comments;
      opportunity.commentsSource = "voice-engine";
      generated += 1;
    } else {
      refused += 1;
      log(`  voix indisponible pour ${opportunity.id} : ${result.reason}`);
    }
  }

  // Keep hand-written/model lines only while they are valid and unique across
  // the entire board. Every fallback is rebuilt from this card's metadata, so
  // an old generic placeholder can never survive a successful refresh.
  const reservedTexts = new Set();
  const fallbackRequired = new Set();
  const stableOrder = [...opportunities].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  for (const opportunity of stableOrder) {
    const normalized = opportunity.comments.map((comment) =>
      typeof comment?.text === "string"
        ? comment.text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en")
        : ""
    );
    const canKeep = opportunity.commentsSource !== "fallback" &&
      opportunity.comments.length === 3 &&
      new Set(normalized).size === 3 &&
      opportunity.comments.every((comment) => validateLofiComment(comment.text).ok) &&
      normalized.every((text) => !reservedTexts.has(text));
    if (canKeep) {
      for (const text of normalized) reservedTexts.add(text);
    } else {
      fallbackRequired.add(opportunity.id);
    }
  }
  for (const opportunity of stableOrder) {
    if (fallbackRequired.has(opportunity.id)) {
      opportunity.comments = fallbackLofiComments(opportunity, reservedTexts);
      opportunity.commentsSource = "fallback";
    }
  }
  return {
    generated,
    refused,
    pending: needsVoice.length - targeted.length,
    candidates: needsVoice.length,
  };
}

// --------------------------------------------------------------------- Feed

function platformLabel(platform) {
  if (platform === "instagram") return "Instagram";
  if (platform === "tiktok") return "TikTok";
  if (platform === "x") return "X";
  return "YouTube";
}

function buildSourceChecks(previousChecks, youtubeCheck, opportunities, capturedAt) {
  const checks = [youtubeCheck];
  for (const platform of PLATFORMS) {
    if (platform === "youtube") continue;
    const previous = previousChecks.find((check) => check.platform === platform);
    const count = opportunities.filter((item) => item.platform === platform).length;
    checks.push({
      id: previous?.id ?? `${platform}-native-public`,
      platform,
      // This run did not re-check the platform, so its status is downgraded
      // rather than inherited: a stale "success" would read as a fresh one.
      status: "limited",
      checkedAt: previous?.checkedAt ?? capturedAt,
      label: count > 0
        ? `${platformLabel(platform)} · relevé conservé du dernier passage vérifié, non recontrôlé par la voie rapide`
        : `${platformLabel(platform)} · aucune opportunité au dernier passage vérifié`,
    });
  }
  return checks;
}

/**
 * Keeps the board readable. Three constraints, in order: drop what is too old
 * to comment, never let one creator's upload schedule take six slots, and give
 * YouTube a ceiling of its own since it produces far more candidates than the
 * other three platforms combined.
 */
export function selectBoard(opportunities, nowMs, referenceAt) {
  const alive = opportunities.filter((opportunity) => {
    // These automated lanes only re-check YouTube. Pruning another platform
    // here would turn a source outage into silent data loss instead of keeping
    // that platform's last verified snapshot.
    if (opportunity.platform !== "youtube") return true;
    if (opportunity.publishedAt === null) return true;
    const publishedAt = Date.parse(opportunity.publishedAt);
    if (!Number.isFinite(publishedAt)) return true;
    return nowMs - publishedAt <= PRUNE_AFTER_DAYS * DAY_IN_MILLISECONDS;
  });

  const perAuthor = new Map();
  const deduped = [];
  for (const opportunity of rankCommentOpportunities(alive, referenceAt)) {
    const key = `${opportunity.platform}:${opportunity.author.toLocaleLowerCase("en")}`;
    const used = perAuthor.get(key) ?? 0;
    if (used >= MAX_CARDS_PER_AUTHOR) continue;
    perAuthor.set(key, used + 1);
    deduped.push(opportunity);
  }

  const byPlatform = new Map(
    PLATFORMS.map((platform) => [
      platform,
      deduped.filter((item) => item.platform === platform),
    ]),
  );
  const selected = PLATFORMS.flatMap((platform) =>
    (byPlatform.get(platform) ?? []).slice(0, MIN_CARDS_PER_PLATFORM)
  );
  const selectedIds = new Set(selected.map((item) => item.id));
  let youtubeCount = selected.filter((item) => item.platform === "youtube").length;

  for (const opportunity of rankCommentOpportunities(deduped, referenceAt)) {
    if (selected.length >= MAX_BOARD_CARDS) break;
    if (selectedIds.has(opportunity.id)) continue;
    if (opportunity.platform === "youtube" && youtubeCount >= MAX_YOUTUBE_CARDS) continue;
    selected.push(opportunity);
    selectedIds.add(opportunity.id);
    if (opportunity.platform === "youtube") youtubeCount += 1;
  }

  return rankCommentOpportunities(selected, referenceAt);
}

// --------------------------------------------------------------------- Main

export async function refreshCommentOpportunities(options = {}) {
  const lane = options.lane === "deep" ? "deep" : "fast";
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const log = options.log ?? ((message) => console.log(message));
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const paths = { ...defaultPaths, ...(options.paths ?? {}) };

  const [feed, watchlist, candidateStore] = await Promise.all([
    readJson(paths.feed),
    readJson(paths.watchlist),
    readJson(paths.candidates).catch(() => ({ version: 1, updatedAt: null, candidates: [] })),
  ]);
  const accounts = watchlist.accounts.filter((account) => account.youtubeChannelId);
  log(`Voie ${lane} : ${accounts.length} comptes surveillés.`);

  const horizonMs = DISCOVERY_HORIZON_HOURS[lane] * HOUR_IN_MILLISECONDS;
  const results = await mapWithConcurrency(accounts, ATOM_CONCURRENCY, async (account) => {
    try {
      return { account, ...(await fetchChannelFeed(account, fetchImpl)) };
    } catch (error) {
      return {
        account,
        url: null,
        entries: null,
        error: error instanceof Error ? error.message : "échec inconnu",
      };
    }
  });
  const reached = results.filter((result) => result.entries !== null);
  const failed = results.filter((result) => result.entries === null);
  if (reached.length === 0) {
    throw new Error("Aucun flux de la watchlist n'a répondu : relevé abandonné.");
  }

  // ------------------------------------------------ candidates (measurement)
  const candidates = new Map(
    candidateStore.candidates.map((candidate) => [candidate.identity, structuredClone(candidate)]),
  );
  const boardIdentities = new Set(
    feed.opportunities.map((opportunity) => nativeCommentOpportunityIdentity(opportunity)),
  );
  let discovered = 0;
  let remeasured = 0;

  for (const { account, url, entries } of reached) {
    for (const entry of entries) {
      if (entry.views === null) continue;
      const identity = `youtube:${entry.videoId}`;
      const publishedAt = entry.publishedAt ? Date.parse(entry.publishedAt) : Number.NaN;
      const isFresh = Number.isFinite(publishedAt) && nowMs - publishedAt <= horizonMs;
      const known = candidates.has(identity) || boardIdentities.has(identity);
      if (!known && !isFresh) continue;

      const observation = {
        capturedAt: now,
        views: entry.views,
        likes: null,
        comments: null,
        shares: null,
        sourceLabel: `YouTube · flux Atom public de ${account.name}`,
        sourceUrl: url,
        exactness: "exact",
      };
      const existing = candidates.get(identity);
      if (existing) {
        const updated = appendObservation(existing, observation, {
          maxObservations: MAX_CANDIDATE_OBSERVATIONS,
          nowMs,
        });
        if (updated !== existing) remeasured += 1;
        candidates.set(identity, updated);
      } else {
        candidates.set(identity, candidateFrom(entry, account, observation));
        discovered += 1;
      }
    }
  }

  // Candidates only exist to provide a baseline; past the horizon they are
  // dead weight and the board copy takes over.
  const liveCandidates = [...candidates.values()]
    .filter((candidate) => {
      const publishedAt = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN;
      if (!Number.isFinite(publishedAt)) return false;
      return nowMs - publishedAt <= DISCOVERY_HORIZON_HOURS.deep * HOUR_IN_MILLISECONDS;
    })
    .sort((left, right) =>
      Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? "")
    )
    .slice(0, MAX_CANDIDATES);

  // ------------------------------------------------------ board (publishing)
  const board = new Map(
    feed.opportunities.map((opportunity) => [
      nativeCommentOpportunityIdentity(opportunity),
      structuredClone(opportunity),
    ]),
  );
  let promoted = 0;

  for (const candidate of liveCandidates) {
    const scored = opportunityFromCandidate(candidate);
    // The candidate carries its tier so the next pass knows how often to
    // re-read it: something that just became a major moment must not stay on
    // the hourly cadence it was given when it was an ordinary upload.
    candidate.momentTier = scored.momentTier;
    const existing = board.get(candidate.identity);
    if (existing) {
      board.set(
        candidate.identity,
        appendObservation(existing, candidate.observations.at(-1), {
          maxObservations: MAX_OBSERVATIONS,
          nowMs,
        }),
      );
      continue;
    }
    if (!qualifiesForBoard(scored)) continue;
    board.set(candidate.identity, scored);
    promoted += 1;
  }

  // Every card is rescored by the same function on every run. Hand-written
  // proposals are kept, hand-written scores are not: two cards can only be
  // ranked against each other if they were measured on one scale.
  const opportunities = selectBoard(
    [...board.values()].map((opportunity) => recomputeOpportunity(opportunity)),
    nowMs,
    now,
  );
  const voice = await fillComments(opportunities, {
    apiKey,
    limit: MAX_VOICE_GENERATIONS[lane],
    fetchImpl,
    log,
    now,
  });
  const fallbackCount = opportunities.filter(
    (opportunity) => opportunity.commentsSource === "fallback",
  ).length;
  if (fallbackCount > 0 && options.allowFallback !== true) {
    throw new Error(
      `${fallbackCount} cartes sans commentaires éditoriaux spécifiques : dernier snapshot conservé.`,
    );
  }

  const youtubeCount = opportunities.filter((item) => item.platform === "youtube").length;
  const youtubeCheck = {
    id: "youtube-watchlist-atom",
    platform: "youtube",
    status: failed.length === 0 && youtubeCount > 0 ? "success" : "limited",
    checkedAt: now,
    label: `YouTube · ${reached.length}/${accounts.length} flux Atom de la watchlist lus${
      failed.length > 0 ? `, ${failed.length} injoignables` : ""
    }`,
  };

  const nextFeed = {
    version: 2,
    capturedAt: now,
    nextRefreshAt: new Date(
      nowMs + COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS * HOUR_IN_MILLISECONDS,
    ).toISOString(),
    cadenceHours: COMMENT_OPPORTUNITY_REFRESH_CADENCE_HOURS,
    fastLaneMinutes: COMMENT_OPPORTUNITY_FAST_LANE_MINUTES,
    fastLaneCheckedAt: now,
    watchlistAccountCount: accounts.length,
    sourceChecks: buildSourceChecks(feed.sourceChecks ?? [], youtubeCheck, opportunities, now),
    opportunities,
  };
  assertCommentOpportunityFeed(nextFeed);

  const status = {
    lane,
    ranAt: now,
    watchedAccounts: accounts.length,
    reachedChannels: reached.length,
    failedChannels: failed.map((result) => ({
      handle: result.account.handle,
      reason: result.error,
    })),
    discovered,
    remeasured,
    promoted,
    trackedCandidates: liveCandidates.length,
    published: nextFeed.opportunities.length,
    tierCounts: countBy(nextFeed.opportunities, (item) => item.momentTier),
    categoryCounts: countBy(nextFeed.opportunities, (item) => item.category),
    voice: { ...voice, engine: apiKey ? "anthropic" : "absent" },
  };

  if (!options.dryRun) {
    await writeFile(paths.feed, `${JSON.stringify(nextFeed, null, 2)}\n`, "utf8");
    await writeFile(
      paths.candidates,
      `${JSON.stringify({ version: 1, updatedAt: now, candidates: liveCandidates })}\n`,
      "utf8",
    );
    await writeFile(paths.status, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }
  return { feed: nextFeed, candidates: liveCandidates, status };
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1]?.endsWith("refresh-comment-opportunities.mjs")) {
  const laneArgument = process.argv.find((argument) => argument.startsWith("--lane="));
  const { status } = await refreshCommentOpportunities({
    lane: laneArgument?.slice("--lane=".length),
    dryRun: process.argv.includes("--dry-run"),
  });
  console.log(
    `\n${status.discovered} découvertes, ${status.remeasured} relevés, ${status.promoted} promotions, ${status.published} cartes au tableau.`,
  );
  console.log(`Candidats suivis : ${status.trackedCandidates}`);
  console.log(`Paliers : ${JSON.stringify(status.tierCounts)}`);
  console.log(`Thèmes : ${JSON.stringify(status.categoryCounts)}`);
  console.log(
    `Voix : ${status.voice.generated} générés, ${status.voice.refused} refusés, ${status.voice.pending} en attente (moteur ${status.voice.engine}).`,
  );
  if (status.failedChannels.length > 0) {
    console.log(`${status.failedChannels.length} flux injoignables.`);
  }
}
