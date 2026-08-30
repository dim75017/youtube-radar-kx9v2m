import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertAudioTrendFeed,
  isCachedAudioTrendThumbnailUrl,
  isOfficialAudioTrendThumbnailUrl,
  isInstagramSignedPlaybackUrl,
  isPublishableAudioTrendReferenceVideo,
} from "../lib/audio-trends.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = resolve(root, "data", "audio-trends", "feed.json");
const statusPath = resolve(root, "data", "audio-trends", "refresh-status.json");
const videoTrendFeedPath = resolve(root, "data", "trends", "feed.json");
const TRACKED_PLATFORMS = ["instagram", "tiktok"];
const PARIS_TIMEZONE = "Europe/Paris";
const COUNTER_LINK_WINDOW = 8_192;
const INSTAGRAM_REEL_HTML_MAX_BYTES = 2_000_000;
const INSTAGRAM_PLAYBACK_PROBE_BYTES = 262_144;
const INSTAGRAM_PLAYBACK_MIN_VALIDITY_MS = 6 * 60 * 60 * 1_000;
const INSTAGRAM_PLAYBACK_MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000;
const TIKTOK_OEMBED_MAX_BYTES = 256_000;
const TIKTOK_THUMBNAIL_PROBE_BYTES = 65_536;
const TIKTOK_THUMBNAIL_MAX_BYTES = 10_000_000;
const AUDIO_DISCOVERY_HTML_MAX_BYTES = 2_000_000;
const AUDIO_DISCOVERY_NEARBY_REFERENCE_WINDOW = 8_192;
const AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT = 200;
const AUDIO_DISCOVERY_REFERENCE_LIMIT_PER_SOURCE = 50;
const AUDIO_DISCOVERY_REFERENCE_CONCURRENCY = 4;
const AUDIO_QUALIFICATION_MAX_AGE_MS = 26 * 60 * 60 * 1_000;
const AUDIO_REFRESH_MAX_ROTATIONS = 5;
const AUDIO_DISCOVERY_EDITORIAL_HOSTS = new Set([
  "buffer.com",
  "later.com",
  "socialpilot.co",
  "www.socialpilot.co",
]);

export const AUDIO_REFRESH_CONCURRENCY = 6;
export const AUDIO_REFRESH_TIMEOUT_MS = 12_000;
export const AUDIO_REFRESH_MIN_PROVIDER_MATCHES = 2;
export const AUDIO_REFRESH_MIN_PROVIDER_COVERAGE = 0.7;
export const AUDIO_REFRESH_MIN_TOTAL_COVERAGE = 0.75;
export const AUDIO_REFRESH_MIN_DISTINCT_TRENDS = 50;
export const AUDIO_DISCOVERY_SOURCES = Object.freeze([
  Object.freeze({
    id: "buffer-tiktok-trends",
    label: "Buffer · tendances et sons TikTok",
    url: "https://buffer.com/resources/how-to-find-trending-tiktok-sounds/",
  }),
  Object.freeze({
    id: "later-instagram-reels-trends",
    label: "Later · tendances Reels Instagram",
    url: "https://later.com/blog/instagram-reels-trends/",
  }),
  Object.freeze({
    id: "socialpilot-tiktok-trends",
    label: "SocialPilot · tendances TikTok",
    url: "https://www.socialpilot.co/blog/tiktok-trends",
  }),
  Object.freeze({
    id: "socialpilot-instagram-reels-trends",
    label: "SocialPilot · tendances Reels Instagram",
    url: "https://www.socialpilot.co/blog/instagram-reels-trends",
  }),
]);

export function evaluateAudioRefreshInventory(feed) {
  const trends = Array.isArray(feed?.trends) ? feed.trends : [];
  const trendIds = new Set();
  const audioUrls = new Set();
  const referenceUrls = new Set();
  const unpublishableReferenceTrendIds = [];

  for (const [index, trend] of trends.entries()) {
    if (typeof trend?.id === "string" && trend.id.trim().length > 0) {
      trendIds.add(trend.id.trim());
    }
    const audioUrl = canonicalInventoryUrl(trend?.audioUrl);
    if (audioUrl) audioUrls.add(audioUrl);
    const referenceUrl = canonicalInventoryUrl(trend?.referenceVideo?.url);
    if (referenceUrl) referenceUrls.add(referenceUrl);
    if (!isPublishableAudioTrendReferenceVideo(trend?.referenceVideo)) {
      unpublishableReferenceTrendIds.push(
        typeof trend?.id === "string" && trend.id.trim().length > 0
          ? trend.id.trim()
          : `index-${index}`,
      );
    }
  }

  const inventory = {
    requiredDistinctTrends: AUDIO_REFRESH_MIN_DISTINCT_TRENDS,
    totalTrends: trends.length,
    distinctTrendIds: trendIds.size,
    distinctAudioUrls: audioUrls.size,
    distinctReferenceUrls: referenceUrls.size,
    publishableReferenceVideos: trends.length - unpublishableReferenceTrendIds.length,
    unpublishableReferenceTrendIds,
  };
  return {
    ...inventory,
    publishable: inventory.totalTrends >= AUDIO_REFRESH_MIN_DISTINCT_TRENDS &&
      inventory.distinctTrendIds >= AUDIO_REFRESH_MIN_DISTINCT_TRENDS &&
      inventory.distinctAudioUrls >= AUDIO_REFRESH_MIN_DISTINCT_TRENDS &&
      inventory.distinctReferenceUrls >= AUDIO_REFRESH_MIN_DISTINCT_TRENDS &&
      inventory.publishableReferenceVideos === inventory.totalTrends,
  };
}

export function extractEditorialAudioCandidates(html, {
  sourceId = "editorial-source",
  sourceUrl = "https://example.com/",
} = {}) {
  return extractEditorialDiscoveryDocument(html, { sourceId, sourceUrl }).candidates;
}

export function extractEditorialUnpairedReferenceCandidates(html, {
  sourceId = "editorial-source",
  sourceUrl = "https://example.com/",
} = {}) {
  return extractEditorialDiscoveryDocument(html, { sourceId, sourceUrl }).unpairedReferences;
}

function extractEditorialDiscoveryDocument(html, {
  sourceId,
  sourceUrl,
}) {
  const normalized = decodeEditorialDiscoveryHtml(html);
  const mediaUrls = [];
  const pattern = /https:\/\/(?:www\.)?(?:tiktok\.com|instagram\.com)\/[^\s"'<>\\]{1,2048}/giu;
  for (const match of normalized.matchAll(pattern)) {
    const rawUrl = trimEditorialUrl(match[0]);
    const audio = canonicalDiscoveredAudioUrl(rawUrl);
    if (audio) {
      mediaUrls.push({
        kind: "audio",
        platform: audio.platform,
        url: audio.url,
        index: match.index ?? 0,
      });
      continue;
    }
    const reference = canonicalDiscoveredReferenceUrl(rawUrl);
    if (reference) {
      mediaUrls.push({
        kind: "reference",
        platform: reference.platform,
        url: reference.url,
        index: match.index ?? 0,
      });
    }
  }

  const references = mediaUrls.filter((candidate) => candidate.kind === "reference");
  const usedReferenceIndexes = new Set();
  const byAudioUrl = new Map();
  for (const audio of mediaUrls.filter((candidate) => candidate.kind === "audio")) {
    const existing = byAudioUrl.get(audio.url);
    if (existing?.referenceUrl) continue;
    const nearestReference = references
      .filter((candidate) => !usedReferenceIndexes.has(candidate.index))
      .filter((candidate) => candidate.platform === audio.platform)
      .map((candidate) => ({
        candidate,
        distance: Math.abs(candidate.index - audio.index),
      }))
      .filter(({ distance }) => distance <= AUDIO_DISCOVERY_NEARBY_REFERENCE_WINDOW)
      .sort((left, right) => left.distance - right.distance)[0]?.candidate ?? null;
    if (nearestReference) usedReferenceIndexes.add(nearestReference.index);
    if (!existing || (!existing.referenceUrl && nearestReference)) {
      byAudioUrl.set(audio.url, {
        platform: audio.platform,
        audioUrl: audio.url,
        referenceUrl: nearestReference?.url ?? null,
        sourceId,
        sourceUrl,
      });
    }
  }
  const unpairedReferences = [...new Map(
    references
      .filter((candidate) => !usedReferenceIndexes.has(candidate.index))
      .map((candidate) => [candidate.url, {
        platform: candidate.platform,
        referenceUrl: candidate.url,
        sourceId,
        sourceUrl,
      }]),
  ).values()].sort((left, right) => left.referenceUrl.localeCompare(right.referenceUrl, "en"));
  return {
    candidates: [...byAudioUrl.values()].sort((left, right) =>
      left.audioUrl.localeCompare(right.audioUrl, "en")
    ),
    unpairedReferences,
  };
}

export async function scanAudioTrendDiscovery({
  feed,
  videoTrendFeed = null,
  previousDiscoveryAudit = null,
  now,
  sources = AUDIO_DISCOVERY_SOURCES,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
  concurrency = Math.min(AUDIO_REFRESH_CONCURRENCY, 4),
  qualificationResult = null,
}) {
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("Horodatage de découverte audio invalide.");
  }
  const inventory = evaluateAudioRefreshInventory(feed);
  const configuredSources = Array.isArray(sources) ? sources : [];
  if (configuredSources.length === 0) {
    return emptyAudioDiscoveryAudit(feed, inventory, null, "not-run");
  }

  const [sourceResults, qualification] = await Promise.all([
    mapWithConcurrency(
      configuredSources,
      concurrency,
      (source) => inspectEditorialDiscoverySource(source, { fetchImpl, timeoutMs }),
    ),
    qualificationResult
      ? Promise.resolve(qualificationResult)
      : qualifyAudioTrendCandidates({
          feed,
          videoTrendFeed,
          now,
          fetchImpl,
          timeoutMs,
          concurrency,
        }),
  ]);
  const discoveredByAudioUrl = new Map();
  for (const result of sourceResults) {
    for (const candidate of result.candidates) {
      const existing = discoveredByAudioUrl.get(candidate.audioUrl);
      if (!existing) {
        discoveredByAudioUrl.set(candidate.audioUrl, {
          ...candidate,
          sourceIds: [candidate.sourceId],
        });
        continue;
      }
      if (!existing.referenceUrl && candidate.referenceUrl) {
        existing.referenceUrl = candidate.referenceUrl;
      }
      if (!existing.sourceIds.includes(candidate.sourceId)) {
        existing.sourceIds.push(candidate.sourceId);
      }
    }
  }

  const candidates = [...discoveredByAudioUrl.values()]
    .sort((left, right) => left.audioUrl.localeCompare(right.audioUrl, "en"));
  const currentAudioUrls = new Set(
    feed.trends
      .map((trend) => canonicalInventoryUrl(trend.audioUrl))
      .filter(Boolean),
  );
  const currentMatchedCount = candidates.filter((candidate) =>
    currentAudioUrls.has(canonicalInventoryUrl(candidate.audioUrl))
  ).length;
  const qualifiedInventoryCount = qualification.audit.freshQualifiedCount;
  const retainedIds = feed.trends
    .filter((trend) => candidates.some((candidate) =>
      canonicalInventoryUrl(candidate.audioUrl) === canonicalInventoryUrl(trend.audioUrl)
    ))
    .map((trend) => trend.id);
  const added = candidates
    .filter((candidate) => !currentAudioUrls.has(canonicalInventoryUrl(candidate.audioUrl)))
    .map((candidate) => candidate.audioUrl);
  const removed = feed.trends
    .filter((trend) => !candidates.some((candidate) =>
      canonicalInventoryUrl(candidate.audioUrl) === canonicalInventoryUrl(trend.audioUrl)
    ))
    .map((trend) => trend.audioUrl);
  const allSourcesSucceeded = sourceResults.every((result) => result.status === "success");
  const previousRegistry = previousDiscoveryAudit?.candidateRegistry ?? {
    updatedAt: previousDiscoveryAudit?.complete === true ? previousDiscoveryAudit.scannedAt : null,
    candidateCount: Array.isArray(previousDiscoveryAudit?.candidateAudioUrls)
      ? previousDiscoveryAudit.candidateAudioUrls.length
      : 0,
    candidateAudioUrls: Array.isArray(previousDiscoveryAudit?.candidateAudioUrls)
      ? previousDiscoveryAudit.candidateAudioUrls
      : [],
    candidateReferences: Array.isArray(previousDiscoveryAudit?.candidateReferences)
      ? previousDiscoveryAudit.candidateReferences
      : [],
  };
  const previousCandidateUrls = new Set(
    previousRegistry.candidateAudioUrls.map(canonicalInventoryUrl).filter(Boolean),
  );
  const currentCandidateUrls = new Set(
    candidates.map((candidate) => canonicalInventoryUrl(candidate.audioUrl)).filter(Boolean),
  );
  const candidateRegistry = allSourcesSucceeded
    ? {
        updatedAt: now,
        candidateCount: candidates.length,
        candidateAudioUrls: candidates
          .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT)
          .map((candidate) => candidate.audioUrl),
        candidateReferences: candidates
          .filter((candidate) => candidate.referenceUrl)
          .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT)
          .map((candidate) => ({
            audioUrl: candidate.audioUrl,
            referenceUrl: candidate.referenceUrl,
          })),
      }
    : previousRegistry;
  const candidatePoolDelta = allSourcesSucceeded
    ? {
        status: "compared",
        added: [...currentCandidateUrls].filter((url) => !previousCandidateUrls.has(url)).length,
        removed: [...previousCandidateUrls].filter((url) => !currentCandidateUrls.has(url)).length,
        retained: [...currentCandidateUrls].filter((url) => previousCandidateUrls.has(url)).length,
      }
    : {
        status: "preserved-after-source-failure",
        added: 0,
        removed: 0,
        retained: previousCandidateUrls.size,
      };
  const candidatePlatformCounts = Object.fromEntries(TRACKED_PLATFORMS.map((platform) => [
    platform,
    candidates.filter((candidate) => candidate.platform === platform).length,
  ]));
  const platformDiscoveryComplete = TRACKED_PLATFORMS.every((platform) =>
    candidatePlatformCounts[platform] > 0
  );
  const complete = allSourcesSucceeded &&
    candidates.length >= AUDIO_REFRESH_MIN_DISTINCT_TRENDS &&
    platformDiscoveryComplete &&
    qualification.audit.complete &&
    qualification.audit.freshQualifiedCount >= 3;
  return {
    scannedAt: now,
    status: complete ? "success" : "incomplete",
    complete,
    candidateCount: candidates.length,
    qualifiedInventoryCount,
    qualifiedClusterCount: qualification.audit.freshQualifiedCount,
    currentMatchedCount,
    candidatePlatformCounts,
    candidateRegistry,
    candidatePoolDelta,
    qualificationAudit: {
      ...qualification.audit,
      discoveredCandidateCount: candidates.length,
      discoveredWithoutMultiCreatorProofCount: candidates.filter((candidate) =>
        !qualification.audit.qualifiedAudioUrls.some((audioUrl) =>
          canonicalInventoryUrl(audioUrl) === canonicalInventoryUrl(candidate.audioUrl)
        )
      ).length,
    },
    newCandidateCount: added.length,
    added,
    removed,
    retainedIds,
    candidateAudioUrls: candidates
      .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT)
      .map((candidate) => candidate.audioUrl),
    candidateReferences: candidates
      .filter((candidate) => candidate.referenceUrl)
      .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT)
      .map((candidate) => ({
        audioUrl: candidate.audioUrl,
        referenceUrl: candidate.referenceUrl,
      })),
    sourceBreakdown: sourceResults.map((result) => ({
      id: result.id,
      label: result.label,
      url: result.url,
      status: result.status,
      candidateCount: result.candidates.length,
      referenceCandidateCount: result.candidates.filter((candidate) => candidate.referenceUrl).length,
      unpairedReferenceCount: result.unpairedReferenceCount,
      resolvedReferenceCount: result.resolvedReferenceCount,
      referenceResolutionErrors: result.referenceResolutionErrors,
      error: result.error,
    })),
    qualifiedCandidates: qualification.candidates,
    currentEvidence: qualification.currentEvidence,
  };
}

async function inspectEditorialDiscoverySource(source, { fetchImpl, timeoutMs }) {
  const normalizedSource = normalizeEditorialDiscoverySource(source);
  try {
    const response = await fetchImpl(
      normalizedSource.url,
      publicPageRequestOptions(timeoutMs),
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.url && !isSameEditorialSource(response.url, normalizedSource.url)) {
      throw new Error("redirection vers une autre source éditoriale");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!Number.isFinite(Number(declaredLength)) ||
        Number(declaredLength) > AUDIO_DISCOVERY_HTML_MAX_BYTES)
    ) {
      throw new Error("page éditoriale trop volumineuse");
    }
    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > AUDIO_DISCOVERY_HTML_MAX_BYTES) {
      throw new Error("page éditoriale trop volumineuse après lecture");
    }
    const document = extractEditorialDiscoveryDocument(html, {
      sourceId: normalizedSource.id,
      sourceUrl: normalizedSource.url,
    });
    const unpairedTikTokReferences = document.unpairedReferences
      .filter((candidate) => candidate.platform === "tiktok")
      .slice(0, AUDIO_DISCOVERY_REFERENCE_LIMIT_PER_SOURCE);
    const resolvedReferences = await mapWithConcurrency(
      unpairedTikTokReferences,
      AUDIO_DISCOVERY_REFERENCE_CONCURRENCY,
      async (candidate) => {
        try {
          return {
            candidate: await collectTikTokDiscoveredAudio({
              referenceUrl: candidate.referenceUrl,
              fetchImpl,
              timeoutMs,
            }),
            error: null,
          };
        } catch (error) {
          return {
            candidate: null,
            error: `${candidate.referenceUrl}: ${
              error instanceof Error ? error.message : "erreur inconnue"
            }`,
          };
        }
      },
    );
    const candidatesByAudioUrl = new Map(document.candidates.map((candidate) => [
      candidate.audioUrl,
      candidate,
    ]));
    for (const result of resolvedReferences) {
      if (!result.candidate || candidatesByAudioUrl.has(result.candidate.audioUrl)) continue;
      candidatesByAudioUrl.set(result.candidate.audioUrl, {
        ...result.candidate,
        sourceId: normalizedSource.id,
        sourceUrl: normalizedSource.url,
      });
    }
    return {
      ...normalizedSource,
      status: "success",
      candidates: [...candidatesByAudioUrl.values()].sort((left, right) =>
        left.audioUrl.localeCompare(right.audioUrl, "en")
      ),
      unpairedReferenceCount: unpairedTikTokReferences.length,
      resolvedReferenceCount: resolvedReferences.filter((result) => result.candidate).length,
      referenceResolutionErrors: resolvedReferences
        .filter((result) => result.error)
        .map((result) => result.error),
      error: null,
    };
  } catch (error) {
    return {
      ...normalizedSource,
      status: "failed",
      candidates: [],
      unpairedReferenceCount: 0,
      resolvedReferenceCount: 0,
      referenceResolutionErrors: [],
      error: error instanceof Error ? error.message : "erreur inconnue",
    };
  }
}

export async function qualifyAudioTrendCandidates({
  feed,
  videoTrendFeed = null,
  now,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
  concurrency = AUDIO_REFRESH_CONCURRENCY,
}) {
  const nowTimestamp = Date.parse(now);
  if (!Number.isFinite(nowTimestamp)) throw new Error("Horodatage de qualification audio invalide.");
  const currentAudioUrls = new Set(
    feed.trends.map((trend) => canonicalInventoryUrl(trend.audioUrl)).filter(Boolean),
  );
  const videoFeedCapturedAt = typeof videoTrendFeed?.capturedAt === "string"
    ? videoTrendFeed.capturedAt
    : null;
  const videoDiscoveryAudit = videoTrendFeed?.refresh?.discoveryAudit;
  const videoDiscoveryAuditScannedAt = typeof videoDiscoveryAudit?.scannedAt === "string"
    ? videoDiscoveryAudit.scannedAt
    : null;
  const videoDiscoveryAuditFresh = videoDiscoveryAudit?.complete === true &&
    Number.isFinite(Date.parse(videoDiscoveryAuditScannedAt ?? "")) &&
    nowTimestamp - Date.parse(videoDiscoveryAuditScannedAt) <= AUDIO_QUALIFICATION_MAX_AGE_MS;
  const videoFeedFresh = videoDiscoveryAuditFresh &&
    Number.isFinite(Date.parse(videoFeedCapturedAt ?? "")) &&
    nowTimestamp - Date.parse(videoFeedCapturedAt) <= AUDIO_QUALIFICATION_MAX_AGE_MS;
  const videoJobs = videoFeedFresh && Array.isArray(videoTrendFeed?.trends)
    ? videoTrendFeed.trends
      .filter(isQualifiableVideoTrend)
      .map((trend) => ({ kind: "video", id: trend.id, trend }))
    : [];
  const auditClusterJobs = videoFeedFresh
    ? exactMusicClusterQualificationJobs(videoDiscoveryAudit, now)
    : [];
  // Existing video cards are eligible only behind a fresh, complete global
  // video discovery audit. The audio pass then reattributes every native URL
  // to one exact TikTok music identity today; old link reachability alone is
  // never enough. Exact clusters not promoted into the video feed are carried
  // by the audit lane as independent jobs, so a zero-rotation video scan can
  // still qualify fresh audio candidates.
  const jobs = [...videoJobs, ...auditClusterJobs];
  const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
    try {
      return await qualifyAudioIdentityFromTrend(job, {
        now,
        fetchImpl,
        timeoutMs,
      });
    } catch (error) {
      return {
        kind: job.kind,
        id: job.id,
        qualified: false,
        current: job.kind === "current",
        candidate: null,
        audioUrl: null,
        matchedCreatorCount: 0,
        error: error instanceof Error ? error.message : "erreur inconnue",
      };
    }
  });
  const qualifiedResults = results.filter((result) => result.qualified && result.kind === "video");
  const qualifiedByAudioUrl = new Map();
  for (const result of qualifiedResults) {
    const key = canonicalInventoryUrl(result.audioUrl);
    if (!key) continue;
    const existing = qualifiedByAudioUrl.get(key);
    if (!existing || candidateSelectionScore(result.candidate) > candidateSelectionScore(existing.candidate)) {
      qualifiedByAudioUrl.set(key, result);
    }
  }
  const qualified = [...qualifiedByAudioUrl.values()];
  const newQualified = qualified.filter((result) =>
    !currentAudioUrls.has(canonicalInventoryUrl(result.audioUrl))
  );
  const currentQualified = qualified.filter((result) =>
    currentAudioUrls.has(canonicalInventoryUrl(result.audioUrl))
  );
  return {
    candidates: newQualified.map((result) => result.candidate).filter(Boolean),
    currentEvidence: currentQualified
      .map((result) => result.candidate)
      .filter(Boolean),
    audit: {
      attemptedAt: now,
      complete: jobs.length > 0 && results.length === jobs.length,
      videoFeedCapturedAt,
      videoFeedFresh,
      videoDiscoveryAuditScannedAt,
      videoDiscoveryAuditFresh,
      attemptedTrendCount: results.length,
      attemptedCurrentTrendCount: 0,
      attemptedFreshVideoTrendCount: videoJobs.length,
      attemptedFreshAuditClusterCount: auditClusterJobs.length,
      freshQualifiedCount: qualified.length,
      qualifiedClusterCount: qualified.length,
      freshCurrentQualifiedCount: currentQualified.length,
      freshNewQualifiedCount: newQualified.length,
      qualifiedAudioUrls: qualified
        .map((result) => result.audioUrl)
        .filter(Boolean)
        .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT),
      rejected: results
        .filter((result) => !result.qualified)
        .slice(0, AUDIO_DISCOVERY_AUDIT_CANDIDATE_LIMIT)
        .map((result) => ({
          kind: result.kind,
          id: result.id,
          matchedCreatorCount: result.matchedCreatorCount,
          error: result.error,
        })),
    },
  };
}

async function qualifyAudioIdentityFromTrend(job, { now, fetchImpl, timeoutMs }) {
  const trend = job.trend;
  const reference = job.kind === "current" ? trend.referenceVideo : trend.referencePost;
  const evidence = trend.reuseEvidence;
  if (!isPublishableAudioTrendReferenceVideo(reference)) {
    throw new Error("video de reference sous le seuil de 50k likes ou hors limite de 30 s");
  }
  const minimumDistinctCreators = Number.isSafeInteger(evidence?.minimumDistinctCreators)
    ? evidence.minimumDistinctCreators
    : 3;
  const posts = distinctTikTokEvidencePosts(evidence?.posts);
  if (minimumDistinctCreators < 3 || posts.length < minimumDistinctCreators) {
    throw new Error("moins de trois createurs TikTok distincts");
  }
  const verificationPosts = distinctTikTokEvidencePosts([
    ...posts,
    {
      platform: "tiktok",
      author: reference.author,
      url: reference.url,
      capturedAt: reference.capturedAt,
    },
  ]);
  const observations = await mapWithConcurrency(
    verificationPosts,
    Math.min(AUDIO_DISCOVERY_REFERENCE_CONCURRENCY, verificationPosts.length),
    async (post) => {
      try {
        return {
          post,
          audio: await collectTikTokDiscoveredAudio({
            referenceUrl: post.url,
            fetchImpl,
            timeoutMs,
          }),
          error: null,
        };
      } catch (error) {
        return {
          post,
          audio: null,
          error: error instanceof Error ? error.message : "erreur inconnue",
        };
      }
    },
  );
  const groups = new Map();
  for (const observation of observations) {
    const key = canonicalInventoryUrl(observation.audio?.audioUrl);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const expectedCurrentUrl = job.kind === "current"
    ? canonicalInventoryUrl(trend.audioUrl)
    : null;
  const winningEntry = [...groups.entries()]
    .filter(([audioUrl, group]) =>
      group.length >= minimumDistinctCreators &&
      (expectedCurrentUrl === null || audioUrl === expectedCurrentUrl)
    )
    .sort((left, right) => right[1].length - left[1].length)[0] ?? null;
  if (!winningEntry) {
    return {
      kind: job.kind,
      id: job.id,
      qualified: false,
      current: job.kind === "current",
      candidate: null,
      audioUrl: expectedCurrentUrl,
      matchedCreatorCount: Math.max(0, ...[...groups.values()].map((group) => group.length)),
      error: "aucune identite audio commune verifiee sur trois createurs distincts",
    };
  }
  const [audioIdentity, matchingObservations] = winningEntry;
  const referenceIdentity = nativeTikTokVideoIdentity(reference.url);
  const referenceObservation = matchingObservations.find((observation) =>
    nativeTikTokVideoIdentity(observation.post.url) === referenceIdentity
  );
  if (!referenceObservation) {
    throw new Error("la video de reference n'utilise pas l'audio commun qualifie");
  }
  const audioUrl = referenceObservation.audio.audioUrl;
  if (canonicalInventoryUrl(audioUrl) !== audioIdentity) {
    throw new Error("identite audio qualifiee incoherente");
  }
  const evidencePosts = matchingObservations
    .slice(0, Math.max(3, minimumDistinctCreators))
    .map((observation) => ({
      platform: "tiktok",
      author: observation.post.author,
      url: canonicalTikTokReferenceUrl(observation.post.url),
      capturedAt: now,
    }));
  const candidate = job.kind === "current"
    ? {
        kind: "current",
        id: trend.id,
        audioUrl,
        reuseEvidence: {
          verifiedAt: now,
          minimumDistinctCreators,
          summary: `Le même audio TikTok a été réattribué nativement à ${evidencePosts.length} créateurs distincts pendant le scan du jour.`,
          posts: evidencePosts,
        },
        selectionScore: candidateSelectionScore(trend),
      }
    : buildAudioTrendCandidateFromVideoTrend({
        videoTrend: trend,
        audio: referenceObservation.audio,
        audioUrl,
        evidencePosts,
        now,
      });
  return {
    kind: job.kind,
    id: job.id,
    qualified: true,
    current: job.kind === "current",
    candidate,
    audioUrl,
    matchedCreatorCount: evidencePosts.length,
    error: null,
  };
}

function isQualifiableVideoTrend(trend) {
  return trend?.character === "lofi-girl" &&
    trend?.referencePost?.platform === "tiktok" &&
    isPublishableAudioTrendReferenceVideo(trend.referencePost) &&
    distinctTikTokEvidencePosts(trend?.reuseEvidence?.posts).length >= 3;
}

function exactMusicClusterQualificationJobs(discoveryAudit, now) {
  const observations = Array.isArray(discoveryAudit?.candidateObservations)
    ? discoveryAudit.candidateObservations
    : [];
  const qualificationByMusicId = new Map(
    (Array.isArray(discoveryAudit?.musicClusterQualifications)
      ? discoveryAudit.musicClusterQualifications
      : [])
      .filter((qualification) => qualification?.status === "qualified")
      .map((qualification) => [String(qualification.musicId), qualification]),
  );
  return (Array.isArray(discoveryAudit?.exactMusicClusters)
    ? discoveryAudit.exactMusicClusters
    : [])
    .flatMap((cluster) => {
      const musicId = String(cluster?.musicId ?? "").trim();
      const qualification = qualificationByMusicId.get(musicId);
      if (!musicId || !qualification) return [];
      const evidenceUrls = new Set(
        (Array.isArray(qualification.evidenceUrls) ? qualification.evidenceUrls : [])
          .map(canonicalTikTokReferenceUrlSafe)
          .filter(Boolean),
      );
      const clusterObservations = observations.filter((observation) =>
        String(observation?.music?.id ?? "") === musicId &&
        evidenceUrls.has(canonicalTikTokReferenceUrlSafe(observation?.url))
      );
      const reference = clusterObservations
        .filter((observation) => isPublishableAudioTrendReferenceVideo({
          durationSeconds: observation?.durationSeconds,
          metrics: observation?.metrics,
        }))
        .sort((left, right) => right.metrics.likes - left.metrics.likes)[0];
      const evidencePosts = distinctTikTokEvidencePosts(clusterObservations.map((observation) => ({
        platform: "tiktok",
        author: observation.author,
        url: observation.url,
        capturedAt: observation.capturedAt ?? observation.lastObservedAt ?? now,
      })));
      if (!reference || evidencePosts.length < 3) return [];
      return [{
        kind: "video",
        id: `video-audit-music-${musicId}`,
        trend: {
          id: `video-audit-music-${musicId}`,
          title: boundedText(cluster.musicTitle, 120) || `Son TikTok ${musicId.slice(-6)}`,
          character: "lofi-girl",
          summary: "Cluster audio TikTok exact issu du scan vidéo quotidien.",
          mechanic: "Réutilisation native du même identifiant audio par plusieurs créateurs.",
          momentumScore: 80,
          lofiFitScore: 90,
          whyLofi: "Le cluster audio natif peut porter une scène Lofi courte sans copier les exécutions sources.",
          lastVerifiedAt: now,
          referencePost: {
            platform: "tiktok",
            author: reference.author,
            caption: boundedText(reference.caption, 500) || "Sans légende publique.",
            url: canonicalTikTokReferenceUrl(reference.url),
            durationSeconds: reference.durationSeconds,
            thumbnailUrl: reference.thumbnailUrl ?? null,
            publishedAt: reference.publishedAt ?? null,
            capturedAt: reference.capturedAt ?? reference.lastObservedAt ?? now,
            sourceLabel: "TikTok · métadonnées publiques natives",
            sourceUrl: canonicalTikTokReferenceUrl(reference.url),
            exactness: "exact",
            metrics: {
              views: reference.metrics?.views ?? null,
              likes: reference.metrics.likes,
              comments: reference.metrics?.comments ?? null,
              shares: reference.metrics?.shares ?? null,
            },
          },
          reuseEvidence: {
            verifiedAt: now,
            minimumDistinctCreators: 3,
            summary: `Le scan vidéo du jour a qualifié l'identifiant audio TikTok ${musicId} chez ${evidencePosts.length} créateurs distincts.`,
            posts: evidencePosts.slice(0, 5),
          },
          proposals: [],
        },
      }];
    });
}

function canonicalTikTokReferenceUrlSafe(candidate) {
  try {
    return nativeTikTokVideoIdentity(candidate)
      ? canonicalTikTokReferenceUrl(candidate)
      : null;
  } catch {
    return null;
  }
}

function distinctTikTokEvidencePosts(posts) {
  if (!Array.isArray(posts)) return [];
  const authors = new Set();
  const urls = new Set();
  return posts.filter((post) => {
    const identity = nativeTikTokVideoIdentity(post?.url);
    const author = typeof post?.author === "string"
      ? post.author.trim().replace(/^@/u, "").toLocaleLowerCase("en")
      : "";
    const url = identity ? canonicalTikTokReferenceUrl(post.url) : null;
    if (post?.platform !== "tiktok" || !identity || !author || authors.has(author) || urls.has(url)) {
      return false;
    }
    authors.add(author);
    urls.add(url);
    return true;
  });
}

function buildAudioTrendCandidateFromVideoTrend({
  videoTrend,
  audio,
  audioUrl,
  evidencePosts,
  now,
}) {
  const reference = videoTrend.referencePost;
  const id = `audio-${videoTrend.id}`.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const audioTitle = boundedText(audio?.title, 120) || boundedText(videoTrend.title, 120);
  const audioAuthor = boundedText(audio?.author, 120) || boundedText(reference.author, 120);
  const lofiAngle = boundedText(
    videoTrend.proposals?.find((proposal) => proposal.tone === "complice")?.concept ??
      videoTrend.mechanic ??
      videoTrend.summary,
    220,
  );
  const lofiFitRationale = boundedText(
    videoTrend.whyLofi ?? videoTrend.lofiFitRationale ?? videoTrend.summary,
    300,
  );
  return {
    id,
    platform: "tiktok",
    type: /original sound|son original|originalton/iu.test(audioTitle) ? "original" : "music",
    title: audioTitle,
    author: audioAuthor,
    audioUrl,
    source: {
      capturedAt: now,
      label: "TikTok · audio oEmbed attribué à trois créateurs distincts",
      url: audioUrl,
      exactness: "exact",
    },
    referenceVideo: {
      author: boundedText(reference.author, 120),
      caption: boundedText(reference.caption ?? videoTrend.summary, 500),
      url: canonicalTikTokReferenceUrl(reference.url),
      thumbnailUrl: audio?.thumbnailUrl ?? null,
      durationSeconds: reference.durationSeconds,
      publishedAt: reference.publishedAt ?? null,
      capturedAt: reference.capturedAt,
      sourceLabel: boundedText(reference.sourceLabel, 200),
      sourceUrl: canonicalTikTokReferenceUrl(reference.url),
      exactness: reference.exactness === "exact" ? "exact" : "platform-estimate",
      metrics: {
        views: reference.metrics?.views ?? null,
        likes: reference.metrics.likes,
        comments: reference.metrics?.comments ?? null,
        shares: reference.metrics?.shares ?? null,
      },
    },
    usageObservations: [{
      capturedAt: now,
      uses: null,
      rank: null,
      rankWindow: null,
      sourceLabel: "TikTok · compteur global non exposé publiquement",
      sourceUrl: audioUrl,
      exactness: "unavailable",
    }],
    reuseEvidence: {
      verifiedAt: now,
      minimumDistinctCreators: 3,
      summary: `Le même audio TikTok a été attribué nativement à ${evidencePosts.length} créateurs distincts pendant le scan du jour.`,
      posts: evidencePosts.slice(0, 5),
    },
    lofiFitScore: Math.max(0, Math.min(100, Math.round(videoTrend.lofiFitScore ?? 0))),
    lofiAngle,
    lofiFitRationale,
    proposals: buildAudioProposalsFromVideoTrend(videoTrend, id),
    selectionScore: candidateSelectionScore(videoTrend),
  };
}

function buildAudioProposalsFromVideoTrend(videoTrend, id) {
  const byTone = new Map(
    (Array.isArray(videoTrend.proposals) ? videoTrend.proposals : [])
      .map((proposal) => [proposal.tone, proposal]),
  );
  const base = boundedText(videoTrend.mechanic ?? videoTrend.summary, 420);
  const proposal = (tone, title, suffix, sourceTone, character = "lofi-girl") => {
    const source = byTone.get(sourceTone);
    return {
      id: `${id}-${tone}`,
      title,
      concept: boundedText(`${source?.concept ?? base} ${suffix}`, 600),
      copy: boundedText(`${source?.copy ?? "Adaptation Lofi"} · ${title}.`, 240),
      character,
      tone,
    };
  };
  return [
    proposal("cozy", "Version cozy", "Avec une lumière douce et un rythme calme.", "cozy"),
    proposal("funny", "Version drôle", "Le chat provoque le décalage final.", "absurde"),
    proposal("smart", "Version smart", "Le montage rend la mécanique lisible dès la première seconde.", "complice"),
    proposal("cinematic", "Version cinématique", "La transition devient une mini-scène en trois plans.", "cozy"),
    proposal("relatable", "Version relatable", "La situation ramène le format à la procrastination ou aux études.", "complice"),
    proposal("cat", "Version chat", "Le chat détourne la mécanique au dernier beat.", "absurde"),
    proposal("gaming", "Version gaming", "Lofi Boy transforme le format en objectif de quête.", "complice", "lofi-boy"),
  ];
}

function candidateSelectionScore(candidate) {
  if (!candidate || typeof candidate !== "object") return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(candidate.selectionScore)) return candidate.selectionScore;
  const lofiFit = Number.isFinite(candidate.lofiFitScore) ? candidate.lofiFitScore : 0;
  const momentum = Number.isFinite(candidate.momentumScore) ? candidate.momentumScore : 0;
  const likes = candidate.referenceVideo?.metrics?.likes ?? candidate.referencePost?.metrics?.likes ?? 0;
  return lofiFit * 1_000_000_000 + momentum * 1_000_000 + Math.min(likes, 999_999);
}

function boundedText(candidate, maximumLength) {
  const text = String(candidate ?? "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

function applyQualifiedAudioCandidates(feed, {
  qualifiedCandidates,
  currentEvidence,
  now,
}) {
  const originalIds = new Set(feed.trends.map((trend) => trend.id));
  const reverifiedTrendIds = [];
  for (const evidence of currentEvidence) {
    const trend = feed.trends.find((candidate) =>
      canonicalInventoryUrl(candidate.audioUrl) === canonicalInventoryUrl(evidence.audioUrl)
    );
    if (!trend || !evidence.reuseEvidence) continue;
    trend.reuseEvidence = structuredClone(evidence.reuseEvidence);
    reverifiedTrendIds.push(trend.id);
  }

  const addedTrendIds = [];
  const addedAudioUrls = [];
  const removedTrendIds = [];
  const removedAudioUrls = [];
  const rejected = [];
  const candidates = [...qualifiedCandidates]
    .sort((left, right) => candidateSelectionScore(right) - candidateSelectionScore(left));
  for (const candidateWithScore of candidates.slice(0, AUDIO_REFRESH_MAX_ROTATIONS)) {
    const audioUrl = canonicalInventoryUrl(candidateWithScore.audioUrl);
    if (!audioUrl || feed.trends.some((trend) => canonicalInventoryUrl(trend.audioUrl) === audioUrl)) {
      continue;
    }
    if (feed.trends.some((trend) =>
      canonicalInventoryUrl(trend.referenceVideo.url) ===
        canonicalInventoryUrl(candidateWithScore.referenceVideo?.url)
    )) {
      rejected.push({ id: candidateWithScore.id, reason: "video de reference deja publiee" });
      continue;
    }
    const weakest = [...feed.trends]
      .sort((left, right) => candidateSelectionScore(left) - candidateSelectionScore(right))[0];
    if (!weakest || candidateSelectionScore(candidateWithScore) <= candidateSelectionScore(weakest)) {
      rejected.push({ id: candidateWithScore.id, reason: "score inferieur au dernier audio conserve" });
      continue;
    }
    const index = feed.trends.findIndex((trend) => trend.id === weakest.id);
    const candidate = structuredClone(candidateWithScore);
    delete candidate.selectionScore;
    feed.trends.splice(index, 1, candidate);
    addedTrendIds.push(candidate.id);
    addedAudioUrls.push(candidate.audioUrl);
    removedTrendIds.push(weakest.id);
    removedAudioUrls.push(weakest.audioUrl);
  }
  const noRotationReason = addedTrendIds.length > 0
    ? null
    : qualifiedCandidates.length === 0
      ? "Aucun nouvel audio ne réunit aujourd’hui une référence ≥ 50 k likes, une durée < 30 s et trois créateurs natifs partageant la même identité audio."
      : "Les nouveaux audios qualifiés n'ont pas dépassé la dernière carte conservée selon le score Lofi Fit, la dynamique et les likes de référence.";
  return {
    evaluatedAt: now,
    addedTrendIds,
    addedAudioUrls,
    removedTrendIds,
    removedAudioUrls,
    retainedTrendIds: feed.trends
      .filter((trend) => originalIds.has(trend.id))
      .map((trend) => trend.id),
    reverifiedTrendIds,
    rejected,
    noRotationReason,
  };
}

function emptyAudioDiscoveryAudit(feed, inventory, scannedAt, status) {
  return {
    scannedAt,
    status,
    complete: false,
    candidateCount: 0,
    qualifiedInventoryCount: 0,
    qualifiedClusterCount: 0,
    currentMatchedCount: 0,
    candidatePlatformCounts: Object.fromEntries(TRACKED_PLATFORMS.map((platform) => [platform, 0])),
    candidateRegistry: {
      updatedAt: null,
      candidateCount: 0,
      candidateAudioUrls: [],
      candidateReferences: [],
    },
    candidatePoolDelta: { status: "not-run", added: 0, removed: 0, retained: 0 },
    qualificationAudit: {
      attemptedAt: scannedAt,
      complete: false,
      videoFeedCapturedAt: null,
      videoFeedFresh: false,
      videoDiscoveryAuditScannedAt: null,
      videoDiscoveryAuditFresh: false,
      attemptedTrendCount: 0,
      attemptedCurrentTrendCount: 0,
      attemptedFreshVideoTrendCount: 0,
      attemptedFreshAuditClusterCount: 0,
      freshQualifiedCount: 0,
      qualifiedClusterCount: 0,
      freshCurrentQualifiedCount: 0,
      freshNewQualifiedCount: 0,
      qualifiedAudioUrls: [],
      rejected: [],
      discoveredCandidateCount: 0,
      discoveredWithoutMultiCreatorProofCount: 0,
    },
    newCandidateCount: 0,
    added: [],
    removed: [],
    retainedIds: Array.isArray(feed?.trends) ? feed.trends.map((trend) => trend.id) : [],
    candidateAudioUrls: [],
    candidateReferences: [],
    sourceBreakdown: [],
    qualifiedCandidates: [],
    currentEvidence: [],
  };
}

export async function buildAudioTrendRefresh({
  feed,
  videoTrendFeed = null,
  previousRefreshStatus = null,
  now = new Date().toISOString(),
  fetchImpl = fetch,
  discoverySources = [],
  concurrency = AUDIO_REFRESH_CONCURRENCY,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
}) {
  if (!Number.isFinite(Date.parse(now))) throw new Error("Horodatage de refresh audio invalide.");
  const candidate = structuredClone(feed);
  const inventory = evaluateAudioRefreshInventory(candidate);
  if (!inventory.publishable) {
    const status = {
      version: 1,
      attemptedAt: now,
      status: "failed",
      published: false,
      inventory,
      discoveryAudit: emptyAudioDiscoveryAudit(
        candidate,
        inventory,
        null,
        "not-run",
      ),
      coverage: emptyAudioRefreshCoverage(false),
      providers: [],
    };
    const error = new Error(
      `Inventaire Audio Trends insuffisant: ${inventory.distinctTrendIds} trends, ` +
      `${inventory.distinctAudioUrls} audios et ${inventory.distinctReferenceUrls} references distinctes; ` +
      `${inventory.publishableReferenceVideos}/${inventory.totalTrends} videos de reference publiables; ` +
      `minimum ${inventory.requiredDistinctTrends}.`,
    );
    error.refreshStatus = status;
    throw error;
  }
  const current = assertAudioTrendFeed(candidate);
  const next = structuredClone(current);
  const jobs = next.trends.filter((trend) => TRACKED_PLATFORMS.includes(trend.platform));
  const [checks, discoveryResult] = await Promise.all([
    mapWithConcurrency(jobs, concurrency, (trend) =>
      inspectAudioTrend(trend, { capturedAt: now, fetchImpl, timeoutMs })
    ),
    scanAudioTrendDiscovery({
      feed: current,
      videoTrendFeed,
      previousDiscoveryAudit: previousRefreshStatus?.discoveryAudit ?? null,
      now,
      sources: discoverySources,
      fetchImpl,
      timeoutMs,
      concurrency,
    }),
  ]);
  const {
    qualifiedCandidates,
    currentEvidence,
    ...discoveryAudit
  } = discoveryResult;
  const selectionAudit = applyQualifiedAudioCandidates(next, {
    qualifiedCandidates,
    currentEvidence,
    now,
  });
  const selectedInventory = evaluateAudioRefreshInventory(next);
  discoveryAudit.qualifiedInventoryCount = discoveryAudit.qualificationAudit.freshQualifiedCount;
  discoveryAudit.qualifiedClusterCount = discoveryAudit.qualificationAudit.freshQualifiedCount;
  discoveryAudit.publishedInventoryCount = selectedInventory.totalTrends;
  discoveryAudit.selectionAudit = selectionAudit;

  const providerResults = TRACKED_PLATFORMS.map((platform) => {
    const platformChecks = checks.filter((check) => check.platform === platform);
    const checked = platformChecks.length;
    const matched = platformChecks.filter((check) => check.matched).length;
    const updated = platformChecks.filter((check) => check.updated).length;
    const thumbnailChecked = platform === "tiktok" ? checked : 0;
    const thumbnailMatched = platformChecks.filter((check) => check.thumbnailMatched).length;
    const thumbnailCoverage = thumbnailChecked === 0 ? 0 : thumbnailMatched / thumbnailChecked;
    const thumbnailComplete = thumbnailChecked > 0 && thumbnailMatched === thumbnailChecked;
    const requiredMatched = requiredProviderMatches(checked);
    const status = checked > 0 && matched >= requiredMatched
      ? "success"
      : checked > 0
        ? "limited"
        : "failed";
    const errors = platformChecks
      .filter((check) => check.error)
      .map((check) => `${check.id}: ${check.error}`);
    if (status === "limited") {
      errors.push(
        `compteurs natifs attribuables limites: ${matched}/${checked}, ` +
        `seuil de couverture analytique ${requiredMatched}`,
      );
    }
    if (platform === "tiktok" && !thumbnailComplete) {
      errors.push(`couverture miniatures insuffisante: ${thumbnailMatched}/${thumbnailChecked}, minimum ${thumbnailChecked}`);
    }
    return {
      platform,
      checked,
      matched,
      updated,
      requiredMatched,
      coverage: checked === 0 ? 0 : matched / checked,
      thumbnailChecked,
      thumbnailMatched,
      thumbnailCoverage,
      thumbnailComplete,
      status,
      errors,
    };
  });

  providerResults.push({
    platform: "youtube",
    checked: 0,
    matched: 0,
    updated: 0,
    requiredMatched: 0,
    coverage: 0,
    thumbnailChecked: 0,
    thumbnailMatched: 0,
    thumbnailCoverage: 0,
    thumbnailComplete: false,
    status: "limited",
    errors: ["YouTube n'expose pas de compteur global d'utilisations audio comparable."],
  });

  const baseCoverage = evaluateAudioRefreshCoverage(providerResults);
  const instagramPlaybackChecks = checks.filter((check) => check.platform === "instagram");
  const instagramPlaybackMatched = instagramPlaybackChecks
    .filter((check) => check.playbackMatched).length;
  const instagramPlaybackComplete = instagramPlaybackChecks.length > 0 &&
    instagramPlaybackMatched === instagramPlaybackChecks.length;
  const tiktokThumbnailChecks = checks.filter((check) => check.platform === "tiktok");
  const tiktokThumbnailMatched = tiktokThumbnailChecks
    .filter((check) => check.thumbnailMatched).length;
  const tiktokThumbnailComplete = tiktokThumbnailChecks.length > 0 &&
    tiktokThumbnailMatched === tiktokThumbnailChecks.length;
  const assetChecksComplete = instagramPlaybackComplete && tiktokThumbnailComplete;
  // Counters, signed playback URLs and remote thumbnails are useful enrichment,
  // but they do not establish that an audio is reused by distinct creators.
  // They therefore remain audited without being allowed to veto a complete
  // editorial discovery + a fail-closed 50-trend qualified inventory.
  const editorialPublication = discoveryAudit.complete && selectedInventory.publishable;
  const coverage = {
    ...baseCoverage,
    catalogPublishable: selectedInventory.publishable,
    instagramPlaybackChecked: instagramPlaybackChecks.length,
    instagramPlaybackMatched,
    instagramPlaybackComplete,
    tiktokThumbnailChecked: tiktokThumbnailChecks.length,
    tiktokThumbnailMatched,
    tiktokThumbnailCoverage: tiktokThumbnailChecks.length === 0
      ? 0
      : tiktokThumbnailMatched / tiktokThumbnailChecks.length,
    tiktokThumbnailComplete,
    thumbnailPublishable: tiktokThumbnailComplete,
    assetPublishable: selectedInventory.publishable && assetChecksComplete,
    discoveryPublishable: discoveryAudit.complete,
    counterPublishable: baseCoverage.publishable,
    publishable: editorialPublication,
  };
  const status = {
    version: 1,
    attemptedAt: now,
    status: editorialPublication ? "success" : "failed",
    published: coverage.publishable,
    inventory: selectedInventory,
    discoveryAudit,
    coverage,
    providers: providerResults,
  };

  if (!coverage.publishable) {
    const reason = !discoveryAudit.complete
      ? `Découverte audio incomplète: ${discoveryAudit.candidateCount}/${AUDIO_REFRESH_MIN_DISTINCT_TRENDS} URLs audio natives, ` +
        `${discoveryAudit.qualifiedInventoryCount} clusters audio fraîchement qualifiés (minimum 3), ` +
        `${discoveryAudit.publishedInventoryCount ?? selectedInventory.totalTrends} cartes publiables conservées, ` +
        `${discoveryAudit.candidatePlatformCounts.instagram} Instagram et ` +
        `${discoveryAudit.candidatePlatformCounts.tiktok} TikTok, ` +
        `${discoveryAudit.currentMatchedCount} correspondances exactes avec l'inventaire (informatives), ` +
        `${discoveryAudit.sourceBreakdown.filter((source) => source.status === "success").length}/${discoveryAudit.sourceBreakdown.length} sources lisibles.`
      : "Inventaire Audio Trends non publiable.";
    const error = new Error(reason);
    error.refreshStatus = status;
    throw error;
  }

  next.capturedAt = now;
  next.nextRefreshAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();
  next.sourceChecks = next.sourceChecks.map((sourceCheck) => {
    if (!TRACKED_PLATFORMS.includes(sourceCheck.platform)) return sourceCheck;
    const result = providerResults.find((candidate) => candidate.platform === sourceCheck.platform);
    if (!result) return sourceCheck;
    return {
      ...sourceCheck,
      status: result.status,
      checkedAt: now,
    };
  });
  assertAudioTrendFeed(next);
  return { feed: next, status };
}

async function inspectAudioTrend(trend, { capturedAt, fetchImpl, timeoutMs }) {
  let playbackMatched = false;
  let thumbnailMatched = false;
  const assetErrors = [];
  try {
    const expectedIdentity = nativeAudioIdentity(trend.audioUrl, trend.platform);
    if (!expectedIdentity) throw new Error("identite audio native absente");

    const playbackPromise = trend.platform === "instagram"
      ? collectInstagramSignedPlayback({
          referenceUrl: trend.referenceVideo.url,
          capturedAt,
          fetchImpl,
          timeoutMs,
        })
      : Promise.resolve(null);
    const thumbnailPromise = trend.platform === "tiktok"
      ? collectTikTokThumbnail({
          referenceUrl: trend.referenceVideo.url,
          fetchImpl,
          timeoutMs,
        })
      : Promise.resolve(null);
    const counterPromise = fetchImpl(trend.audioUrl, publicPageRequestOptions(timeoutMs));
    const [playbackResult, thumbnailResult, counterResult] = await Promise.allSettled([
      playbackPromise,
      thumbnailPromise,
      counterPromise,
    ]);
    if (playbackResult.status === "fulfilled" && playbackResult.value) {
      playbackMatched = true;
      trend.referenceVideo.playbackUrl = playbackResult.value.url;
      trend.referenceVideo.playbackCapturedAt = playbackResult.value.capturedAt;
      trend.referenceVideo.playbackExpiresAt = playbackResult.value.expiresAt;
    }
    if (thumbnailResult.status === "fulfilled" && thumbnailResult.value) {
      thumbnailMatched = true;
      // The public feed uses repository-owned frames so its cards do not turn
      // black as soon as TikTok's signed CDN URLs expire. Still verify the
      // native thumbnail on every scan, but never replace a stable cache hit.
      if (!isCachedAudioTrendThumbnailUrl(trend.referenceVideo.thumbnailUrl ?? "")) {
        trend.referenceVideo.thumbnailUrl = thumbnailResult.value.url;
      }
    }
    if (playbackResult.status === "rejected") {
      assetErrors.push(playbackResult.reason instanceof Error
        ? playbackResult.reason.message
        : "playback Instagram indisponible");
    }
    if (thumbnailResult.status === "rejected") {
      assetErrors.push(thumbnailResult.reason instanceof Error
        ? thumbnailResult.reason.message
        : "miniature TikTok indisponible");
    }
    if (counterResult.status === "rejected") throw counterResult.reason;

    const playback = playbackResult.value;
    const thumbnail = thumbnailResult.value;
    const response = counterResult.value;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const finalUrl = response.url || trend.audioUrl;
    const finalIdentity = nativeAudioIdentity(finalUrl, trend.platform);
    if (!finalIdentity || finalIdentity !== expectedIdentity) {
      throw new Error("redirection vers une autre identite audio");
    }

    const html = await response.text();
    const parsed = parsePublicUsageCounter(html, trend.platform, {
      expectedAudioUrl: trend.audioUrl,
      responseUrl: finalUrl,
    });
    if (!parsed || parsed.audioId !== expectedIdentity) {
      throw new Error("compteur public non lie a cette identite audio");
    }

    const previousUses = [...trend.usageObservations]
      .reverse()
      .find((observation) => observation.uses !== null)?.uses ?? null;
    if (previousUses !== null && parsed.uses < previousUses) {
      throw new Error("compteur incoherent avec le dernier releve");
    }

    const lastCapturedAt = trend.usageObservations.at(-1)?.capturedAt;
    if (lastCapturedAt && sameParisDay(lastCapturedAt, capturedAt)) {
      return {
        id: trend.id,
        platform: trend.platform,
        matched: true,
        updated: Boolean(playback || thumbnail),
        playbackMatched,
        thumbnailMatched,
        error: assetErrors.length > 0 ? assetErrors.join("; ") : null,
      };
    }

    const sourceUrl = canonicalNativeAudioUrl(trend.audioUrl);
    trend.usageObservations.push({
      capturedAt,
      uses: parsed.uses,
      rank: null,
      rankWindow: null,
      sourceLabel: `${trend.platform === "tiktok" ? "TikTok" : "Instagram"} · compteur public${parsed.exactness === "platform-estimate" ? " abrege" : ""}`,
      sourceUrl,
      exactness: parsed.exactness,
    });
    trend.usageObservations = trend.usageObservations.slice(-30);
    return {
      id: trend.id,
      platform: trend.platform,
      matched: true,
      updated: true,
      playbackMatched,
      thumbnailMatched,
      error: assetErrors.length > 0 ? assetErrors.join("; ") : null,
    };
  } catch (error) {
    return {
      id: trend.id,
      platform: trend.platform,
      matched: false,
      updated: playbackMatched || thumbnailMatched,
      playbackMatched,
      thumbnailMatched,
      error: [
        ...assetErrors,
        error instanceof Error ? error.message : "erreur inconnue",
      ].filter((message, index, messages) => messages.indexOf(message) === index).join("; "),
    };
  }
}

export async function collectInstagramSignedPlayback({
  referenceUrl,
  capturedAt,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
}) {
  const expectedShortcode = nativeInstagramReelIdentity(referenceUrl);
  if (!expectedShortcode) throw new Error("reference Reel Instagram invalide");
  const response = await fetchImpl(referenceUrl, publicPageRequestOptions(timeoutMs));
  if (!response.ok) throw new Error(`Reel Instagram HTTP ${response.status}`);
  const finalUrl = response.url || referenceUrl;
  if (nativeInstagramReelIdentity(finalUrl) !== expectedShortcode) {
    throw new Error("redirection vers un autre Reel Instagram");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > INSTAGRAM_REEL_HTML_MAX_BYTES) {
    throw new Error("page Reel Instagram trop volumineuse");
  }
  const html = await response.text();
  if (new TextEncoder().encode(html).byteLength > INSTAGRAM_REEL_HTML_MAX_BYTES) {
    throw new Error("page Reel Instagram trop volumineuse apres lecture");
  }

  const capturedTimestamp = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTimestamp)) throw new Error("horodatage playback invalide");
  const candidates = extractInstagramSignedPlaybackCandidates(html)
    .map((url) => ({ url, expiresAt: instagramPlaybackExpiresAt(url) }))
    .filter(({ expiresAt }) => {
      if (!expiresAt) return false;
      const validity = Date.parse(expiresAt) - capturedTimestamp;
      return validity >= INSTAGRAM_PLAYBACK_MIN_VALIDITY_MS &&
        validity <= INSTAGRAM_PLAYBACK_MAX_VALIDITY_MS;
    });
  if (candidates.length === 0) {
    throw new Error("URL MP4 Instagram signee absente ou trop proche de son expiration");
  }

  const probeErrors = [];
  for (const candidate of candidates) {
    try {
      await verifyInstagramSignedPlayback(candidate.url, {
        expiresAt: candidate.expiresAt,
        fetchImpl,
        timeoutMs,
      });
      return {
        url: candidate.url,
        capturedAt,
        expiresAt: candidate.expiresAt,
      };
    } catch (error) {
      probeErrors.push(error instanceof Error ? error.message : "probe inconnue");
    }
  }
  throw new Error(`aucun MP4 Instagram lisible avec son: ${probeErrors.join("; ")}`);
}

export async function collectTikTokThumbnail({
  referenceUrl,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
}) {
  const expectedVideoId = nativeTikTokVideoIdentity(referenceUrl);
  if (!expectedVideoId) throw new Error("reference video TikTok invalide");

  const canonicalReferenceUrl = canonicalTikTokReferenceUrl(referenceUrl);
  const endpoint = new URL("https://www.tiktok.com/oembed");
  endpoint.searchParams.set("url", canonicalReferenceUrl);
  const response = await fetchImpl(endpoint.toString(), tiktokOEmbedRequestOptions(timeoutMs));
  if (!response.ok) throw new Error(`oEmbed TikTok HTTP ${response.status}`);
  if (response.url && !isExpectedTikTokOEmbedResponseUrl(response.url, expectedVideoId)) {
    throw new Error("redirection oEmbed TikTok invalide");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!Number.isFinite(Number(declaredLength)) || Number(declaredLength) > TIKTOK_OEMBED_MAX_BYTES)
  ) {
    throw new Error("reponse oEmbed TikTok trop volumineuse");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > TIKTOK_OEMBED_MAX_BYTES) {
    throw new Error("reponse oEmbed TikTok trop volumineuse apres lecture");
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("reponse oEmbed TikTok non JSON");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.type !== "video" ||
    payload.provider_name !== "TikTok" ||
    !isOfficialTikTokProviderUrl(payload.provider_url) ||
    !oEmbedHtmlMatchesTikTokVideo(payload.html, expectedVideoId) ||
    typeof payload.thumbnail_url !== "string" ||
    !isOfficialAudioTrendThumbnailUrl(payload.thumbnail_url, "tiktok")
  ) {
    throw new Error("oEmbed TikTok non attribuable a la video de reference");
  }

  const accessibleUrl = await verifyTikTokThumbnail(payload.thumbnail_url, {
    fetchImpl,
    timeoutMs,
  });
  return { url: accessibleUrl };
}

export async function collectTikTokDiscoveredAudio({
  referenceUrl,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
}) {
  const expectedVideoId = nativeTikTokVideoIdentity(referenceUrl);
  if (!expectedVideoId) throw new Error("reference video TikTok invalide");

  const canonicalReferenceUrl = canonicalTikTokReferenceUrl(referenceUrl);
  const endpoint = new URL("https://www.tiktok.com/oembed");
  endpoint.searchParams.set("url", canonicalReferenceUrl);
  const response = await fetchImpl(endpoint.toString(), tiktokOEmbedRequestOptions(timeoutMs));
  if (!response.ok) throw new Error(`oEmbed TikTok HTTP ${response.status}`);
  if (response.url && !isExpectedTikTokOEmbedResponseUrl(response.url, expectedVideoId)) {
    throw new Error("redirection oEmbed TikTok invalide");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!Number.isFinite(Number(declaredLength)) || Number(declaredLength) > TIKTOK_OEMBED_MAX_BYTES)
  ) {
    throw new Error("reponse oEmbed TikTok trop volumineuse");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > TIKTOK_OEMBED_MAX_BYTES) {
    throw new Error("reponse oEmbed TikTok trop volumineuse apres lecture");
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("reponse oEmbed TikTok non JSON");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.type !== "video" ||
    payload.provider_name !== "TikTok" ||
    !isOfficialTikTokProviderUrl(payload.provider_url) ||
    !oEmbedHtmlMatchesTikTokVideo(payload.html, expectedVideoId)
  ) {
    throw new Error("oEmbed TikTok non attribuable a la video de reference");
  }

  const candidates = extractEditorialAudioCandidates(payload.html, {
    sourceId: "tiktok-oembed",
    sourceUrl: endpoint.toString(),
  }).filter((candidate) => candidate.platform === "tiktok");
  const exactCandidates = candidates.filter((candidate) =>
    candidate.referenceUrl &&
    nativeTikTokVideoIdentity(candidate.referenceUrl) === expectedVideoId
  );
  if (exactCandidates.length !== 1) {
    throw new Error("audio TikTok absent ou ambigu dans le oEmbed attribue");
  }
  const audioLabel = extractTikTokOEmbedAudioLabel(payload.html, exactCandidates[0].audioUrl);
  const separatorIndex = audioLabel.lastIndexOf(" - ");
  const title = separatorIndex > 0 ? audioLabel.slice(0, separatorIndex).trim() : audioLabel;
  const author = separatorIndex > 0 ? audioLabel.slice(separatorIndex + 3).trim() : "TikTok";
  return {
    platform: "tiktok",
    audioUrl: exactCandidates[0].audioUrl,
    referenceUrl: canonicalReferenceUrl,
    title: title || "Audio TikTok",
    author: author || "TikTok",
    thumbnailUrl: typeof payload.thumbnail_url === "string" &&
        isOfficialAudioTrendThumbnailUrl(payload.thumbnail_url, "tiktok")
      ? payload.thumbnail_url
      : null,
  };
}

function extractTikTokOEmbedAudioLabel(html, expectedAudioUrl) {
  if (typeof html !== "string") return "Audio TikTok";
  const decoded = decodeEditorialDiscoveryHtml(html);
  for (const match of decoded.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    const audio = canonicalDiscoveredAudioUrl(match[1]);
    if (audio?.platform !== "tiktok" || canonicalInventoryUrl(audio.url) !== canonicalInventoryUrl(expectedAudioUrl)) {
      continue;
    }
    return match[2]
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;|&#0*160;/giu, " ")
      .replace(/&amp;|&#0*38;|&#x0*26;/giu, "&")
      .replace(/^\s*♬\s*/u, "")
      .replace(/\s+/gu, " ")
      .trim() || "Audio TikTok";
  }
  return "Audio TikTok";
}

function canonicalTikTokReferenceUrl(candidate) {
  const url = new URL(candidate);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function nativeTikTokVideoIdentity(candidate) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(hostname === "tiktok.com" || hostname.endsWith(".tiktok.com"))
    ) {
      return null;
    }
    return url.pathname.replace(/\/+$/u, "")
      .match(/^\/@[^/]+\/video\/(\d{12,24})$/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isOfficialTikTokProviderUrl(candidate) {
  if (typeof candidate !== "string") return false;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      (hostname === "tiktok.com" || hostname === "www.tiktok.com") &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function isExpectedTikTokOEmbedResponseUrl(candidate, expectedVideoId) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(hostname === "tiktok.com" || hostname === "www.tiktok.com") ||
      url.pathname.replace(/\/+$/u, "") !== "/oembed"
    ) {
      return false;
    }
    const embeddedReference = url.searchParams.get("url");
    return embeddedReference === null || nativeTikTokVideoIdentity(embeddedReference) === expectedVideoId;
  } catch {
    return false;
  }
}

function oEmbedHtmlMatchesTikTokVideo(html, expectedVideoId) {
  if (typeof html !== "string" || html.length === 0 || html.length > 100_000) return false;
  const identities = [
    ...[...html.matchAll(/data-video-id\s*=\s*["'](\d{12,24})["']/giu)]
      .map((match) => match[1]),
    ...[...html.matchAll(/https:\/\/(?:www\.)?tiktok\.com\/@[^/"'\s<>]+\/video\/(\d{12,24})/giu)]
      .map((match) => match[1]),
  ];
  return identities.length > 0 &&
    identities.includes(expectedVideoId) &&
    identities.every((identity) => identity === expectedVideoId);
}

async function verifyTikTokThumbnail(candidate, { fetchImpl, timeoutMs }) {
  if (!isOfficialAudioTrendThumbnailUrl(candidate, "tiktok")) {
    throw new Error("URL miniature TikTok invalide");
  }
  const response = await fetchImpl(candidate, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg",
      Range: `bytes=0-${TIKTOK_THUMBNAIL_PROBE_BYTES - 1}`,
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (![200, 206].includes(response.status)) {
    throw new Error(`miniature TikTok HTTP ${response.status}`);
  }
  const finalUrl = response.url || candidate;
  if (!isOfficialAudioTrendThumbnailUrl(finalUrl, "tiktok")) {
    throw new Error("redirection miniature TikTok invalide");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!contentType?.startsWith("image/")) throw new Error("miniature TikTok non image");
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!Number.isFinite(Number(declaredLength)) ||
      Number(declaredLength) <= 0 ||
      Number(declaredLength) > TIKTOK_THUMBNAIL_MAX_BYTES)
  ) {
    throw new Error("taille miniature TikTok invalide");
  }
  const prefix = await readResponsePrefix(response, TIKTOK_THUMBNAIL_PROBE_BYTES);
  if (!isImagePrefix(prefix, contentType)) throw new Error("octets miniature TikTok invalides");
  return finalUrl;
}

function isImagePrefix(bytes, contentType) {
  if (!(bytes instanceof Uint8Array)) return false;
  if (contentType === "image/jpeg" || contentType === "image/jpg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12 &&
      new TextDecoder("latin1").decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder("latin1").decode(bytes.slice(8, 12)) === "WEBP";
  }
  if (contentType === "image/avif") {
    const signature = new TextDecoder("latin1").decode(bytes.slice(0, 32));
    return bytes.length >= 12 && signature.includes("ftyp") && /(?:avif|avis)/u.test(signature);
  }
  return false;
}

function tiktokOEmbedRequestOptions(timeoutMs) {
  return {
    headers: {
      Accept: "application/json",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  };
}

export function extractInstagramSignedPlaybackCandidates(html) {
  let decoded = String(html ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/\\\//gu, "/")
      .replace(/&amp;/giu, "&")
      .replace(/&#0*38;|&#x0*26;/giu, "&");
  }
  const pattern = /https:\/\/scontent(?:-[a-z0-9-]+)?\.cdninstagram\.com\/[^"'<>\\\s]{1,8000}/giu;
  const candidates = [];
  for (const match of decoded.matchAll(pattern)) {
    const candidate = match[0];
    if (candidate.length > 8_192 || !isInstagramSignedPlaybackUrl(candidate)) continue;
    candidates.push(candidate);
  }
  return [...new Set(candidates)].sort((left, right) =>
    instagramPlaybackCandidateScore(right) - instagramPlaybackCandidateScore(left)
  );
}

export function instagramPlaybackExpiresAt(candidate) {
  if (!isInstagramSignedPlaybackUrl(candidate)) return null;
  const encodedExpiry = new URL(candidate).searchParams.get("oe");
  const expiryMilliseconds = Number.parseInt(encodedExpiry, 16) * 1_000;
  if (!Number.isSafeInteger(expiryMilliseconds)) return null;
  return new Date(expiryMilliseconds).toISOString();
}

async function verifyInstagramSignedPlayback(candidate, {
  expiresAt,
  fetchImpl,
  timeoutMs,
}) {
  if (!isInstagramSignedPlaybackUrl(candidate, expiresAt)) {
    throw new Error("URL CDN Instagram invalide");
  }
  const response = await fetchImpl(candidate, {
    headers: {
      Accept: "video/mp4",
      Origin: "https://dim75017.github.io",
      Range: `bytes=0-${INSTAGRAM_PLAYBACK_PROBE_BYTES - 1}`,
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (![200, 206].includes(response.status)) {
    throw new Error(`CDN Instagram HTTP ${response.status}`);
  }
  const finalUrl = response.url || candidate;
  if (!isInstagramSignedPlaybackUrl(finalUrl, expiresAt)) {
    throw new Error("redirection CDN Instagram invalide");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "video/mp4") throw new Error("contenu CDN non MP4");
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin !== "*" && allowOrigin !== "https://dim75017.github.io") {
    throw new Error("CDN Instagram non lisible depuis GitHub Pages");
  }
  const prefix = await readResponsePrefix(response, INSTAGRAM_PLAYBACK_PROBE_BYTES);
  const boxText = new TextDecoder("latin1").decode(prefix);
  const hasVideo = boxText.includes("vide") &&
    (boxText.includes("avc1") || boxText.includes("hvc1") || boxText.includes("hev1"));
  const hasAudio = boxText.includes("soun") && boxText.includes("mp4a");
  if (!hasVideo || !hasAudio) throw new Error("MP4 Instagram sans pistes audio et video confirmees");
}

function nativeInstagramReelIdentity(candidate) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(hostname === "instagram.com" || hostname.endsWith(".instagram.com"))
    ) {
      return null;
    }
    return url.pathname.replace(/\/+$/u, "")
      .match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)$/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function instagramPlaybackCandidateScore(candidate) {
  const url = new URL(candidate);
  return Number(url.searchParams.has("vs")) + Number(url.searchParams.has("_nc_vs"));
}

function publicPageRequestOptions(timeoutMs) {
  return {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function decodeEditorialDiscoveryHtml(html) {
  let decoded = String(html ?? "");
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      )
      .replace(/\\\//gu, "/")
      .replace(/&quot;|&#0*34;|&#x0*22;/giu, "\"")
      .replace(/&apos;|&#0*39;|&#x0*27;/giu, "'")
      .replace(/&amp;|&#0*38;|&#x0*26;/giu, "&");
  }
  return decoded;
}

function trimEditorialUrl(candidate) {
  return String(candidate ?? "")
    .replace(/[),.;!?\]}]+$/gu, "")
    .slice(0, 2_048);
}

function canonicalDiscoveredAudioUrl(candidate) {
  for (const platform of TRACKED_PLATFORMS) {
    if (!nativeAudioIdentity(candidate, platform)) continue;
    return {
      platform,
      url: canonicalNativeAudioUrl(candidate),
    };
  }
  return null;
}

function canonicalDiscoveredReferenceUrl(candidate) {
  const tiktokIdentity = nativeTikTokVideoIdentity(candidate);
  if (tiktokIdentity) {
    return {
      platform: "tiktok",
      url: canonicalTikTokReferenceUrl(candidate),
    };
  }
  const instagramIdentity = nativeInstagramReelIdentity(candidate);
  if (!instagramIdentity) return null;
  const url = new URL(candidate);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return {
    platform: "instagram",
    url: url.toString(),
  };
}

function normalizeEditorialDiscoverySource(source) {
  if (
    !source ||
    typeof source !== "object" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source.id ?? "") ||
    typeof source.label !== "string" ||
    source.label.trim().length === 0 ||
    typeof source.url !== "string"
  ) {
    throw new Error("Source éditoriale audio invalide.");
  }
  const url = new URL(source.url);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !AUDIO_DISCOVERY_EDITORIAL_HOSTS.has(hostname)
  ) {
    throw new Error(`Source éditoriale audio non autorisée: ${source.id}`);
  }
  url.search = "";
  url.hash = "";
  return {
    id: source.id,
    label: source.label.trim(),
    url: url.toString(),
  };
}

function isSameEditorialSource(candidate, expected) {
  try {
    const actualUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    return actualUrl.protocol === "https:" &&
      actualUrl.hostname.toLowerCase() === expectedUrl.hostname.toLowerCase();
  } catch {
    return false;
  }
}

async function readResponsePrefix(response, maximumBytes) {
  if (!response.body) {
    return new Uint8Array((await response.arrayBuffer()).slice(0, maximumBytes));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function nativeAudioIdentity(candidate, platform) {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:") return null;
    if (platform === "instagram") {
      if (!(host === "instagram.com" || host.endsWith(".instagram.com"))) return null;
      return path.match(/^\/reels\/audio\/([A-Za-z0-9_-]+)$/u)?.[1] ?? null;
    }
    if (platform === "tiktok") {
      if (!(host === "tiktok.com" || host.endsWith(".tiktok.com"))) return null;
      return path.match(/^\/music\/[^/]*?(\d{8,24})$/u)?.[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export function parsePublicUsageCounter(html, platform, {
  expectedAudioUrl,
  responseUrl = expectedAudioUrl,
} = {}) {
  const audioId = nativeAudioIdentity(expectedAudioUrl, platform);
  const responseAudioId = nativeAudioIdentity(responseUrl, platform);
  if (!audioId || !responseAudioId || responseAudioId !== audioId) return null;

  const normalized = String(html ?? "")
    .replaceAll("\\u00e9", "e")
    .replaceAll("\\u00e8", "e")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#x202f;", " ")
    .replaceAll("&#8239;", " ");
  const identityPositions = allIndexesOf(normalized, audioId);
  const candidates = [];

  const patterns = platform === "tiktok"
    ? [
        { kind: "structured", pattern: /"(?:videoCount|video_count)"\s*:\s*"?(\d{1,12})"?/giu },
        { kind: "text", pattern: /(\d+(?:[.,]\d+)?)\s*([KMB])?\s*(?:videos|video)/giu },
      ]
    : [
        { kind: "structured", pattern: /"(?:reelsCount|clipsCount|mediaCount|reels_count|clips_count|media_count)"\s*:\s*"?(\d{1,12})"?/giu },
        { kind: "text", pattern: /(\d+(?:[.,]\d+)?)\s*([KMB])?\s*(?:reels?|videos|video)/giu },
      ];

  for (const { kind, pattern } of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const uses = parseCompactNumber(match[1], match[2]?.toUpperCase() ?? "");
      if (!Number.isSafeInteger(uses) || uses < 1) continue;
      candidates.push({
        uses,
        exactness: match[2] ? "platform-estimate" : "exact",
        kind,
        index: match.index ?? 0,
      });
    }
  }

  if (candidates.length === 0) return null;
  let linked = candidates;
  if (identityPositions.length > 0) {
    linked = candidates.filter((candidate) =>
      minimumDistance(candidate.index, identityPositions) <= COUNTER_LINK_WINDOW
    );
  }
  if (linked.length === 0) return null;

  const structured = linked.filter((candidate) => candidate.kind === "structured");
  const preferred = structured.length > 0 ? structured : linked;
  const distinctValues = new Set(preferred.map((candidate) => candidate.uses));
  if (distinctValues.size !== 1) return null;

  const exactCandidate = preferred.find((candidate) => candidate.exactness === "exact");
  const chosen = exactCandidate ?? preferred[0];
  return { uses: chosen.uses, exactness: chosen.exactness, audioId };
}

export function requiredProviderMatches(checked) {
  if (!Number.isInteger(checked) || checked <= 0) return 0;
  return Math.max(
    AUDIO_REFRESH_MIN_PROVIDER_MATCHES,
    Math.ceil(checked * AUDIO_REFRESH_MIN_PROVIDER_COVERAGE),
  );
}

export function evaluateAudioRefreshCoverage(providerResults) {
  const tracked = providerResults.filter((result) =>
    TRACKED_PLATFORMS.includes(result.platform) && result.checked > 0
  );
  const totalChecked = tracked.reduce((total, result) => total + result.checked, 0);
  const totalMatched = tracked.reduce((total, result) => total + result.matched, 0);
  const requiredTotal = totalChecked === 0
    ? AUDIO_REFRESH_MIN_PROVIDER_MATCHES
    : Math.max(
        AUDIO_REFRESH_MIN_PROVIDER_MATCHES,
        Math.ceil(totalChecked * AUDIO_REFRESH_MIN_TOTAL_COVERAGE),
      );
  const providersPassed = tracked.length === TRACKED_PLATFORMS.length && tracked.every((result) =>
    result.matched >= requiredProviderMatches(result.checked)
  );
  return {
    totalChecked,
    totalMatched,
    requiredTotal,
    ratio: totalChecked === 0 ? 0 : totalMatched / totalChecked,
    providersPassed,
    publishable: providersPassed && totalMatched >= requiredTotal,
  };
}

function canonicalInventoryUrl(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/u, "");
    const tiktokMusicId = /(?:^|\.)tiktok\.com$/u.test(url.hostname)
      ? url.pathname.match(/^\/music\/[^/]*?(\d{8,24})$/u)?.[1]
      : null;
    if (tiktokMusicId) return `https://www.tiktok.com/music/${tiktokMusicId}`;
    return url.toString();
  } catch {
    return null;
  }
}

function emptyAudioRefreshCoverage(catalogPublishable) {
  return {
    totalChecked: 0,
    totalMatched: 0,
    requiredTotal: AUDIO_REFRESH_MIN_PROVIDER_MATCHES,
    ratio: 0,
    providersPassed: false,
    catalogPublishable,
    instagramPlaybackChecked: 0,
    instagramPlaybackMatched: 0,
    instagramPlaybackComplete: false,
    tiktokThumbnailChecked: 0,
    tiktokThumbnailMatched: 0,
    tiktokThumbnailCoverage: 0,
    tiktokThumbnailComplete: false,
    thumbnailPublishable: false,
    assetPublishable: false,
    discoveryPublishable: false,
    counterPublishable: false,
    publishable: false,
  };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, requestedConcurrency));
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: safeConcurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function allIndexesOf(text, search) {
  const positions = [];
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const index = text.indexOf(search, fromIndex);
    if (index < 0) break;
    positions.push(index);
    fromIndex = index + search.length;
  }
  return positions;
}

function minimumDistance(index, anchors) {
  return anchors.reduce(
    (minimum, anchor) => Math.min(minimum, Math.abs(index - anchor)),
    Number.POSITIVE_INFINITY,
  );
}

function parseCompactNumber(raw, suffix) {
  const value = Number(String(raw).replace(",", "."));
  const multiplier = suffix === "B"
    ? 1_000_000_000
    : suffix === "M"
      ? 1_000_000
      : suffix === "K"
        ? 1_000
        : 1;
  return Math.round(value * multiplier);
}

function canonicalNativeAudioUrl(candidate) {
  const url = new URL(candidate);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function sameParisDay(left, right) {
  const formatter = new Intl.DateTimeFormat("fr-CA", {
    timeZone: PARIS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(left)) === formatter.format(new Date(right));
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function cacheAddedAudioTrendThumbnails({
  feed,
  selectionAudit,
  fetchImpl = fetch,
  timeoutMs = AUDIO_REFRESH_TIMEOUT_MS,
  outputDirectory = resolve(root, "public", "media", "audio-trends"),
}) {
  const addedIds = new Set(selectionAudit?.addedTrendIds ?? []);
  const added = feed.trends.filter((trend) => addedIds.has(trend.id));
  await mkdir(outputDirectory, { recursive: true });
  for (const trend of added) {
    const candidate = trend.referenceVideo.thumbnailUrl;
    if (typeof candidate !== "string" || !isOfficialAudioTrendThumbnailUrl(candidate, "tiktok")) {
      throw new Error(`miniature native absente pour la nouvelle trend ${trend.id}`);
    }
    const response = await fetchImpl(candidate, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg",
        "User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0; +https://github.com/dim75017/youtube-radar-kx9v2m)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`miniature ${trend.id} HTTP ${response.status}`);
    const finalUrl = response.url || candidate;
    if (!isOfficialAudioTrendThumbnailUrl(finalUrl, "tiktok")) {
      throw new Error(`redirection miniature invalide pour ${trend.id}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const extension = contentType === "image/jpeg" || contentType === "image/jpg"
      ? "jpg"
      : contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : contentType === "image/avif"
            ? "avif"
            : null;
    if (!extension) throw new Error(`format miniature invalide pour ${trend.id}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && (declaredLength <= 0 || declaredLength > TIKTOK_THUMBNAIL_MAX_BYTES)) {
      throw new Error(`taille miniature invalide pour ${trend.id}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength <= 0 ||
      bytes.byteLength > TIKTOK_THUMBNAIL_MAX_BYTES ||
      !isImagePrefix(bytes.slice(0, 64), contentType)
    ) {
      throw new Error(`octets miniature invalides pour ${trend.id}`);
    }
    const fileName = `${trend.id}.${extension}`;
    await writeFile(resolve(outputDirectory, fileName), bytes);
    trend.referenceVideo.thumbnailUrl = `media/audio-trends/${fileName}`;
  }
  return added.map((trend) => trend.referenceVideo.thumbnailUrl);
}

async function main() {
  const attemptedAt = new Date().toISOString();
  const [feed, videoTrendFeed, previousRefreshStatus] = await Promise.all([
    readFile(feedPath, "utf8").then(JSON.parse),
    readFile(videoTrendFeedPath, "utf8").then(JSON.parse),
    readFile(statusPath, "utf8").then(JSON.parse).catch(() => null),
  ]);
  let result = null;
  try {
    result = await buildAudioTrendRefresh({
      feed,
      videoTrendFeed,
      previousRefreshStatus,
      now: attemptedAt,
      discoverySources: AUDIO_DISCOVERY_SOURCES,
    });
    const cachedThumbnails = await cacheAddedAudioTrendThumbnails({
      feed: result.feed,
      selectionAudit: result.status.discoveryAudit.selectionAudit,
    });
    result.status.assetCache = {
      status: "success",
      cachedCount: cachedThumbnails.length,
      paths: cachedThumbnails,
    };
    assertAudioTrendFeed(result.feed);
    await Promise.all([
      writeJsonAtomic(feedPath, result.feed),
      writeJsonAtomic(statusPath, result.status),
    ]);
    console.log(
      `Audio refresh published: ${result.status.coverage.totalMatched}/${result.status.coverage.totalChecked} counters linked.`,
    );
  } catch (error) {
    const failedStatus = error?.refreshStatus ?? (result
      ? {
          ...result.status,
          status: "failed",
          published: false,
          assetCache: {
            status: "failed",
            cachedCount: null,
            paths: null,
            error: error instanceof Error ? error.message : "échec inconnu",
          },
        }
      : {
      version: 1,
      attemptedAt,
      status: "failed",
      published: false,
      inventory: evaluateAudioRefreshInventory(feed),
      discoveryAudit: emptyAudioDiscoveryAudit(
        feed,
        evaluateAudioRefreshInventory(feed),
        null,
        "not-run",
      ),
      coverage: emptyAudioRefreshCoverage(false),
      providers: [],
    });
    await writeJsonAtomic(statusPath, failedStatus);
    throw error;
  }
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) await main();
