import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPublishableSocialTrendFeed,
  assertSocialTrendFeed,
  isActionableSocialTrend,
  MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
  MIN_TREND_DISCOVERY_CANDIDATE_URLS,
  MIN_TREND_DISCOVERY_PARSED_SOURCES,
} from "../lib/social-trends.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = resolve(root, "data", "trends", "feed.json");
const watchlistsPath = resolve(root, "data", "trends", "watchlists.json");
const statusPath = resolve(root, "data", "trends", "refresh-status.json");
const REQUEST_TIMEOUT_MS = 20_000;
const NATIVE_POST_TIMEOUT_MS = 12_000;
const NATIVE_POST_CONCURRENCY = 8;
const PARIS_TIMEZONE = "Europe/Paris";
const MAX_DISCOVERY_CANDIDATE_URLS = 200;
const MAX_SOURCE_CANDIDATE_URLS = 60;

function cleanExtractedUrl(value) {
  return String(value ?? "")
    .replace(/&amp;/giu, "&")
    .replace(/&#0*38;/giu, "&")
    .replace(/[),.;!?\]}]+$/u, "");
}

export function canonicalNativeTrendCandidateUrl(value) {
  try {
    const url = new URL(cleanExtractedUrl(value));
    const host = url.hostname.toLowerCase().replace(/^www\./u, "").replace(/^m\./u, "");
    const path = url.pathname.replace(/\/+$/u, "");

    if (host === "tiktok.com") {
      const match = path.match(/^\/@([^/]+)\/video\/(\d{12,24})$/iu);
      return match ? `https://www.tiktok.com/@${match[1]}/video/${match[2]}` : null;
    }
    if (host === "instagram.com") {
      const match = path.match(/^\/(reel|reels|p)\/([A-Za-z0-9_-]{5,})$/u);
      if (!match) return null;
      const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
      return `https://www.instagram.com/${kind}/${match[2]}/`;
    }
    if (host === "youtube.com") {
      const shortsId = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/u)?.[1];
      if (shortsId) return `https://www.youtube.com/shorts/${shortsId}`;
      const watchId = path === "/watch" ? url.searchParams.get("v") : null;
      return /^[A-Za-z0-9_-]{11}$/u.test(watchId ?? "")
        ? `https://www.youtube.com/watch?v=${watchId}`
        : null;
    }
    if (host === "x.com" || host === "twitter.com") {
      const match = path.match(/^\/([^/]+)\/status\/(\d+)$/iu);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractNativeTrendCandidateUrls(sourceText) {
  const decoded = String(sourceText ?? "")
    .replace(/\\u002f/giu, "/")
    .replace(/\\\//gu, "/")
    .replace(/&quot;|&#0*34;/giu, '"');
  const urls = decoded.match(/https?:\/\/[^\s"'<>\\]+/giu) ?? [];
  return [...new Set(urls.map(canonicalNativeTrendCandidateUrl).filter(Boolean))].sort();
}

export function nativeTrendVerificationRequest(post) {
  const url = new URL(post.url);
  if (post.platform === "tiktok") {
    const id = url.pathname.match(/\/video\/(\d{12,24})/iu)?.[1];
    if (!id) throw new Error("identifiant TikTok absent");
    return {
      url: `https://www.tiktok.com/oembed?url=${encodeURIComponent(post.url)}`,
      marker: id,
    };
  }
  if (post.platform === "youtube") {
    const id = url.pathname.match(/\/(?:shorts|watch)\/([A-Za-z0-9_-]{11})/iu)?.[1]
      ?? url.searchParams.get("v");
    if (!id) throw new Error("identifiant YouTube absent");
    return {
      url: `https://www.youtube.com/oembed?url=${encodeURIComponent(post.url)}&format=json`,
      marker: id,
    };
  }
  if (post.platform === "x") {
    const id = url.pathname.match(/\/status\/(\d+)/iu)?.[1];
    if (!id) throw new Error("identifiant X absent");
    return {
      url: `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(post.url)}`,
      marker: id,
    };
  }
  const shortcode = url.pathname.match(/\/(?:p|reel|reels)\/([^/]+)/iu)?.[1];
  if (!shortcode) throw new Error("identifiant Instagram absent");
  return { url: post.url, marker: shortcode };
}

export async function verifyNativeTrendPost(post, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = nativeTrendVerificationRequest(post);
  const response = await fetchImpl(request.url, {
    headers: {
      Accept: "text/html,application/json,application/xhtml+xml",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/lofi-social-radar-preview)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(NATIVE_POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (!body.includes(request.marker)) {
    throw new Error("identité du post absente de la réponse");
  }
  return true;
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function auditTrendReuseEvidenceReachability(trends, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobs = trends.flatMap((trend) =>
    (trend.reuseEvidence?.posts ?? []).map((post) => ({ trend, post })),
  );
  const checks = await mapWithConcurrency(
    jobs,
    options.concurrency ?? NATIVE_POST_CONCURRENCY,
    async ({ trend, post }) => {
      try {
        await verifyNativeTrendPost(post, { fetchImpl });
        return { trendId: trend.id, url: post.url, ok: true };
      } catch (error) {
        return {
          trendId: trend.id,
          url: post.url,
          ok: false,
          error: error instanceof Error ? error.message : "échec inconnu",
        };
      }
    },
  );
  const checksByTrend = Map.groupBy(checks, (check) => check.trendId);
  const availableTrendIds = [];
  for (const trend of trends) {
    const trendChecks = checksByTrend.get(trend.id) ?? [];
    if (
      trend.reuseEvidence &&
      trendChecks.length === trend.reuseEvidence.posts.length &&
      trendChecks.every((check) => check.ok)
    ) {
      availableTrendIds.push(trend.id);
    }
  }
  const failures = checks.filter((check) => !check.ok);
  return {
    reachabilityCheckedAt: now,
    checkedPosts: checks.length,
    availablePosts: checks.length - failures.length,
    unavailablePosts: failures.length,
    availableTrends: availableTrendIds.length,
    availableTrendIds,
    failures,
  };
}

// Kept as a compatibility export for callers that used the old name. Despite
// that historical name, this function is now a read-only reachability audit.
export async function reverifyTrendReuseEvidence(trends, options = {}) {
  return auditTrendReuseEvidenceReachability(trends, options);
}

export function normalizeSourceText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function localDateKey(value, timeZone = PARIS_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function trendSearchTerms(trend) {
  const title = trend.title.split("·")[0]?.trim() ?? trend.title;
  return [...new Set([title, ...(trend.keywords ?? [])]
    .map(normalizeSourceText)
    .filter((term) => term.length >= 5))];
}

export function countMatchedSignals(sourceText, trends) {
  return matchedTrendIdsFromSource(sourceText, trends).length;
}

export function matchedTrendIdsFromSource(sourceText, trends) {
  const normalized = normalizeSourceText(sourceText);
  return trends
    .filter((trend) => trendSearchTerms(trend).some((term) => normalized.includes(term)))
    .map((trend) => trend.id);
}

export async function checkTrendSource(source, trends, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checkedAt = options.now ?? new Date().toISOString();
  try {
    const xBearerToken = options.xBearerToken ?? process.env.X_BEARER_TOKEN ?? process.env.TWITTER_BEARER_TOKEN;
    if (source.kind === "x-api" && !xBearerToken) {
      throw new Error("X_BEARER_TOKEN absent");
    }
    const response = await fetchImpl(source.url, {
      headers: {
        Accept: source.kind === "x-api" ? "application/json" : "text/html,application/xhtml+xml",
        ...(source.kind === "x-api" ? { Authorization: `Bearer ${xBearerToken}` } : {}),
        "User-Agent": "LofiSocialRadar/1.0 (+https://github.com/dim75017/lofi-social-radar-preview)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (source.kind === "x-api") {
      const payload = await response.json();
      const items = Array.isArray(payload?.data) ? payload.data : [];
      const trendNames = items
        .map((item) => typeof item?.trend_name === "string" ? item.trend_name : "")
        .filter(Boolean);
      if (!trendNames.length) throw new Error("aucune tendance X parsée");
      const sourceText = trendNames.join(" ");
      const normalizedNames = normalizeSourceText(sourceText);
      const candidateUrls = extractNativeTrendCandidateUrls(JSON.stringify(payload));
      const matchedTrendIds = matchedTrendIdsFromSource(sourceText, trends);
      return {
        id: source.id,
        label: source.label,
        platform: source.platform,
        status: "success",
        checkedAt,
        candidatesMatched: matchedTrendIds.length,
        candidateUrls,
        matchedTrendIds,
        signature: createHash("sha256").update(normalizedNames).digest("hex").slice(0, 16),
      };
    }
    const body = await response.text();
    const normalized = normalizeSourceText(body);
    const markers = source.requiredMarkers.map(normalizeSourceText);
    if (!markers.every((marker) => normalized.includes(marker))) {
      throw new Error("structure reconnue absente");
    }
    const candidateUrls = extractNativeTrendCandidateUrls(body);
    if (!candidateUrls.length) {
      throw new Error("aucune URL native candidate parsée");
    }
    const matchedTrendIds = matchedTrendIdsFromSource(body, trends);
    return {
      id: source.id,
      label: source.label,
      platform: source.platform,
      status: "success",
      checkedAt,
      candidatesMatched: matchedTrendIds.length,
      candidateUrls,
      matchedTrendIds,
      signature: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    };
  } catch (error) {
    return {
      id: source.id,
      label: source.label,
      platform: source.platform,
      status: "failed",
      checkedAt,
      candidatesMatched: 0,
      candidateUrls: [],
      matchedTrendIds: [],
      error: error instanceof Error ? error.message : "échec inconnu",
    };
  }
}

export function buildTrendDiscoveryAudit({
  previousAudit,
  checks,
  reachability,
  now,
}) {
  const successfulChecks = checks.filter((check) => check.status === "success");
  const candidateUrls = [...new Set(
    successfulChecks.flatMap((check) => check.candidateUrls ?? []),
  )].sort();
  const matchedTrendIds = [...new Set(
    successfulChecks.flatMap((check) => check.matchedTrendIds ?? []),
  )].sort();
  const availableTrendIds = new Set(reachability.availableTrendIds ?? []);
  const qualifiedTrendIds = matchedTrendIds.filter((id) => availableTrendIds.has(id));
  const previousCandidateUrls = new Set(
    (previousAudit?.candidateUrls ?? [])
      .map(canonicalNativeTrendCandidateUrl)
      .filter(Boolean),
  );
  const currentCandidateUrls = new Set(candidateUrls);
  const retained = candidateUrls.filter((url) => previousCandidateUrls.has(url)).length;
  const added = candidateUrls.length - retained;
  const removed = [...previousCandidateUrls]
    .filter((url) => !currentCandidateUrls.has(url))
    .length;

  return {
    scannedAt: now,
    complete:
      checks.filter((check) => check.status === "success").length >=
        MIN_TREND_DISCOVERY_PARSED_SOURCES &&
      candidateUrls.length >= MIN_TREND_DISCOVERY_CANDIDATE_URLS &&
      qualifiedTrendIds.length >= MIN_PUBLISHABLE_ACTIONABLE_TRENDS,
    candidateCount: candidateUrls.length,
    qualifiedInventoryCount: qualifiedTrendIds.length,
    currentMatchedCount: matchedTrendIds.length,
    added,
    removed,
    retained,
    candidateUrls: candidateUrls.slice(0, MAX_DISCOVERY_CANDIDATE_URLS),
    matchedTrendIds,
    sourceBreakdown: checks.map((check) => ({
      id: check.id,
      label: check.label,
      platform: check.platform,
      status: check.status,
      candidateCount: (check.candidateUrls ?? []).length,
      matchedTrendIds: check.matchedTrendIds ?? [],
      candidateUrls: (check.candidateUrls ?? []).slice(0, MAX_SOURCE_CANDIDATE_URLS),
    })),
    reachabilityCheckedAt: reachability.reachabilityCheckedAt,
    availablePosts: reachability.availablePosts,
    unavailablePosts: reachability.unavailablePosts,
    unavailablePostUrls: reachability.failures
      .map((failure) => failure.url)
      .slice(0, MAX_SOURCE_CANDIDATE_URLS),
  };
}

export async function buildDailyTrendRefresh({
  feed,
  watchlists,
  now = new Date().toISOString(),
  fetchImpl = fetch,
  force = false,
  xBearerToken,
}) {
  const current = assertSocialTrendFeed(structuredClone(feed));
  if (!force && localDateKey(current.refresh.lastSuccessfulAt) === localDateKey(now)) {
    return { skipped: true, feed: current, status: current.refresh };
  }

  const actionable = current.trends.filter(isActionableSocialTrend);
  const [checks, reachability] = await Promise.all([
    Promise.all(
      watchlists.sources.map((source) =>
        checkTrendSource(source, actionable, { fetchImpl, now, xBearerToken }),
      ),
    ),
    auditTrendReuseEvidenceReachability(actionable, { now, fetchImpl }),
  ]);
  const successfulChecks = checks.filter((check) => check.status === "success");
  const checkedSources = successfulChecks.length;
  const matchedSignals = successfulChecks.reduce(
    (total, check) => total + check.candidatesMatched,
    0,
  );
  const lofiGirl = actionable.filter((trend) => trend.character === "lofi-girl").length;
  const lofiBoy = actionable.filter((trend) => trend.character === "lofi-boy").length;
  const discoveryAudit = buildTrendDiscoveryAudit({
    previousAudit: current.refresh.discoveryAudit,
    checks,
    reachability,
    now,
  });
  const baseRefresh = {
    cadenceHours: 24,
    lastAttemptAt: now,
    lastSuccessfulAt: current.refresh.lastSuccessfulAt,
    nextScheduledAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString(),
    status: "degraded",
    runId: process.env.GITHUB_RUN_ID ?? `local-${localDateKey(now)}`,
    runUrl: process.env.GITHUB_RUN_URL ?? null,
    discoveryAudit,
    sourceChecks: checks.map((check) => ({
      id: check.id,
      label: check.label,
      platform: check.platform,
      status: check.status,
      checkedAt: check.checkedAt,
      candidatesMatched: check.candidatesMatched,
    })),
    counts: {
      checkedSources,
      matchedSignals,
      actionable: actionable.length,
      lofiGirl,
      lofiBoy,
    },
  };

  const minimumParsedSources = Math.max(
    MIN_TREND_DISCOVERY_PARSED_SOURCES,
    Number.isInteger(watchlists.minimumParsedSources) ? watchlists.minimumParsedSources : 0,
  );
  if (checkedSources < minimumParsedSources) {
    const error = new Error(
      `Seulement ${checkedSources}/${watchlists.sources.length} sources Trends ont été parsées; minimum ${minimumParsedSources}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (discoveryAudit.candidateCount < MIN_TREND_DISCOVERY_CANDIDATE_URLS) {
    const error = new Error(
      `Seulement ${discoveryAudit.candidateCount} URLs candidates natives ont été extraites; minimum ${MIN_TREND_DISCOVERY_CANDIDATE_URLS}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  if (discoveryAudit.qualifiedInventoryCount < MIN_PUBLISHABLE_ACTIONABLE_TRENDS) {
    const error = new Error(
      `Seulement ${discoveryAudit.qualifiedInventoryCount}/${actionable.length} trends ont conservé trois reprises natives accessibles; minimum ${MIN_PUBLISHABLE_ACTIONABLE_TRENDS}.`,
    );
    error.refreshStatus = baseRefresh;
    throw error;
  }

  const refreshedFeed = {
    ...current,
    capturedAt: now,
    refresh: {
      ...baseRefresh,
      lastSuccessfulAt: now,
      status: "success",
    },
  };
  assertSocialTrendFeed(refreshedFeed);
  assertPublishableSocialTrendFeed(refreshedFeed, {
    now,
    allowStaleSemanticEvidence: true,
  });
  return { skipped: false, feed: refreshedFeed, status: refreshedFeed.refresh };
}

async function writeJsonAtomic(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

async function main() {
  const attemptedAt = process.env.TREND_REFRESH_NOW ?? new Date().toISOString();
  const force = process.env.FORCE_TREND_REFRESH === "1";
  const [feed, watchlists] = await Promise.all([
    readFile(feedPath, "utf8").then(JSON.parse),
    readFile(watchlistsPath, "utf8").then(JSON.parse),
  ]);

  try {
    const result = await buildDailyTrendRefresh({ feed, watchlists, now: attemptedAt, force });
    if (result.skipped) {
      console.log(`Le feed Trends est déjà à jour pour ${localDateKey(attemptedAt)}.`);
      return;
    }
    await Promise.all([
      writeJsonAtomic(feedPath, result.feed),
      writeJsonAtomic(statusPath, {
        version: 1,
        ...result.status,
        message: "Rafraîchissement quotidien publié après validation complète.",
      }),
    ]);
    console.log(
      `Feed publié: ${result.status.counts.actionable} trends, ${result.status.counts.lofiGirl} Lofi Girl, ${result.status.counts.checkedSources} sources parsées.`,
    );
  } catch (error) {
    const status = error?.refreshStatus ?? {
      cadenceHours: 24,
      lastAttemptAt: attemptedAt,
      lastSuccessfulAt: feed?.refresh?.lastSuccessfulAt ?? feed?.capturedAt ?? attemptedAt,
      nextScheduledAt: new Date(Date.parse(attemptedAt) + 12 * 60 * 60 * 1_000).toISOString(),
      status: "degraded",
      runId: process.env.GITHUB_RUN_ID ?? `local-${localDateKey(attemptedAt)}`,
      runUrl: process.env.GITHUB_RUN_URL ?? null,
      discoveryAudit: feed?.refresh?.discoveryAudit,
      sourceChecks: [],
      counts: {
        checkedSources: 0,
        matchedSignals: 0,
        actionable: 0,
        lofiGirl: 0,
        lofiBoy: 0,
      },
    };
    await writeJsonAtomic(statusPath, {
      version: 1,
      ...status,
      message: error instanceof Error ? error.message : "Rafraîchissement Trends impossible.",
    });
    throw error;
  }
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) {
  await main();
}
