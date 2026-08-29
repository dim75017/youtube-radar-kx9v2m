import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isTrendEditorialScanLate,
  TREND_EDITORIAL_SCAN_MAX_AGE_HOURS,
} from "../lib/trend-health.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINIMUM_CANDIDATE_COUNT = 50;
const MINIMUM_VIDEO_QUALIFIED_INVENTORY_COUNT = 50;
const MINIMUM_AUDIO_QUALIFIED_CLUSTER_COUNT = 3;
const MINIMUM_PUBLISHED_INVENTORY_COUNT = 50;

const SOURCES = [
  {
    key: "video",
    label: "Trends vidéos",
    feedPath: resolve(root, "data", "trends", "feed.json"),
    statusPath: resolve(root, "data", "trends", "refresh-status.json"),
  },
  {
    key: "audio",
    label: "Trends audio",
    feedPath: resolve(root, "data", "audio-trends", "feed.json"),
    statusPath: resolve(root, "data", "audio-trends", "refresh-status.json"),
  },
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function uniqueNonEmptyStrings(value) {
  return Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length;
}

export function validateDiscoveryAudit(audit, checkedAt, { key = "video" } = {}) {
  const issues = [];
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return ["discoveryAudit absent"];
  }

  if (audit.complete !== true) issues.push("discoveryAudit incomplet");

  const scannedAt = typeof audit.scannedAt === "string" ? audit.scannedAt : null;
  if (!isIso(scannedAt)) {
    issues.push("discoveryAudit.scannedAt invalide");
  } else if (isTrendEditorialScanLate(scannedAt, checkedAt)) {
    issues.push(`discoveryAudit.scannedAt dépasse ${TREND_EDITORIAL_SCAN_MAX_AGE_HOURS} h`);
  }

  if (!Number.isSafeInteger(audit.candidateCount) || audit.candidateCount < MINIMUM_CANDIDATE_COUNT) {
    issues.push(`discoveryAudit.candidateCount doit être >= ${MINIMUM_CANDIDATE_COUNT}`);
  }

  if (key === "audio") {
    if (
      !Number.isSafeInteger(audit.qualifiedClusterCount) ||
      audit.qualifiedClusterCount < MINIMUM_AUDIO_QUALIFIED_CLUSTER_COUNT
    ) {
      issues.push(
        `discoveryAudit.qualifiedClusterCount doit être >= ${MINIMUM_AUDIO_QUALIFIED_CLUSTER_COUNT}`,
      );
    }
    if (
      !Number.isSafeInteger(audit.publishedInventoryCount) ||
      audit.publishedInventoryCount < MINIMUM_PUBLISHED_INVENTORY_COUNT
    ) {
      issues.push(
        `discoveryAudit.publishedInventoryCount doit être >= ${MINIMUM_PUBLISHED_INVENTORY_COUNT}`,
      );
    }
    if (
      Number.isSafeInteger(audit.qualifiedInventoryCount) &&
      Number.isSafeInteger(audit.qualifiedClusterCount) &&
      audit.qualifiedInventoryCount !== audit.qualifiedClusterCount
    ) {
      issues.push("qualifiedInventoryCount doit correspondre aux clusters audio fraîchement qualifiés");
    }
    if (
      Number.isSafeInteger(audit.qualificationAudit?.freshQualifiedCount) &&
      Number.isSafeInteger(audit.qualifiedClusterCount) &&
      audit.qualificationAudit.freshQualifiedCount !== audit.qualifiedClusterCount
    ) {
      issues.push("qualifiedClusterCount ne correspond pas à qualificationAudit.freshQualifiedCount");
    }
  } else if (
    !Number.isSafeInteger(audit.qualifiedInventoryCount) ||
    audit.qualifiedInventoryCount < MINIMUM_VIDEO_QUALIFIED_INVENTORY_COUNT
  ) {
    issues.push(
      `discoveryAudit.qualifiedInventoryCount doit être >= ${MINIMUM_VIDEO_QUALIFIED_INVENTORY_COUNT}`,
    );
  }

  const candidatePoolChanges = readCandidatePoolChanges(audit, key);
  if (!candidatePoolChanges) {
    issues.push(key === "audio"
      ? "discoveryAudit.candidatePoolDelta doit exposer added, removed et retained"
      : "discoveryAudit doit exposer added, removed et retained");
  } else if (
    Number.isSafeInteger(audit.candidateCount) &&
    candidatePoolChanges.added + candidatePoolChanges.retained !== audit.candidateCount
  ) {
    issues.push("candidate pool: added + retained doit correspondre à candidateCount");
  }
  return issues;
}

function validateSelectionAudit(key, audit, feedTrendIds) {
  const issues = [];
  const selection = readSelectionChanges(audit, key);
  if (!selection) {
    return {
      selection: null,
      issues: [key === "audio"
        ? "discoveryAudit.selectionAudit absent ou invalide"
        : "audit de sélection vidéo absent ou invalide"],
    };
  }

  if (selection.added !== selection.removed) {
    issues.push("rotation publiée: le nombre ajouté doit correspondre au nombre retiré");
  }
  if (selection.added === 0) {
    if (!isNonEmptyString(selection.noRotationReason)) {
      issues.push("rotation nulle sans noRotationReason vérifiable");
    }
  } else if (selection.noRotationReason !== null) {
    issues.push("noRotationReason doit être null lorsqu'une rotation est publiée");
  }

  for (const id of selection.addedIds) {
    if (!feedTrendIds.has(id)) issues.push(`trend ajoutée absente du feed publié: ${id}`);
  }
  for (const id of selection.removedIds) {
    if (feedTrendIds.has(id)) issues.push(`trend déclarée retirée encore présente dans le feed: ${id}`);
  }
  return { selection, issues };
}

export function evaluateTrendHealth(
  { key, label, feed, status, readIssues = [] },
  checkedAt = new Date().toISOString(),
) {
  const issues = [...readIssues];
  const capturedAt = typeof feed?.capturedAt === "string" ? feed.capturedAt : null;
  if (!isIso(capturedAt)) {
    issues.push("feed.capturedAt invalide");
  } else if (isTrendEditorialScanLate(capturedAt, checkedAt)) {
    issues.push(`feed.capturedAt dépasse ${TREND_EDITORIAL_SCAN_MAX_AGE_HOURS} h`);
  }

  const audit = status?.discoveryAudit;
  issues.push(...validateDiscoveryAudit(audit, checkedAt, { key }));
  if (status?.status !== "success") {
    issues.push(`le refresh ${key === "audio" ? "audio" : "vidéo"} n'a pas le statut success`);
  }
  if (key === "audio" && status?.published !== true) {
    issues.push("le refresh audio n'est pas publié");
  }

  const discoveryScannedAt = typeof audit?.scannedAt === "string" ? audit.scannedAt : null;
  if (
    isIso(capturedAt) &&
    isIso(discoveryScannedAt) &&
    Date.parse(capturedAt) !== Date.parse(discoveryScannedAt)
  ) {
    issues.push("feed.capturedAt ne correspond pas au scan qualifié publié");
  }

  const feedTrends = Array.isArray(feed?.trends) ? feed.trends : null;
  const feedInventoryCount = feedTrends?.length ?? null;
  if (feedInventoryCount === null || feedInventoryCount < MINIMUM_PUBLISHED_INVENTORY_COUNT) {
    issues.push(`le feed publié doit contenir au moins ${MINIMUM_PUBLISHED_INVENTORY_COUNT} trends`);
  }
  if (
    key === "video" &&
    Number.isSafeInteger(audit?.qualifiedInventoryCount) &&
    Number.isSafeInteger(feedInventoryCount) &&
    audit.qualifiedInventoryCount > feedInventoryCount
  ) {
    issues.push("qualifiedInventoryCount dépasse l'inventaire réellement publié");
  }
  if (
    key === "audio" &&
    Number.isSafeInteger(audit?.publishedInventoryCount) &&
    Number.isSafeInteger(feedInventoryCount) &&
    audit.publishedInventoryCount !== feedInventoryCount
  ) {
    issues.push("publishedInventoryCount ne correspond pas à l'inventaire audio réellement publié");
  }

  const feedTrendIds = new Set(
    (feedTrends ?? []).map((trend) => trend?.id).filter(isNonEmptyString),
  );
  const { selection, issues: selectionIssues } = validateSelectionAudit(key, audit, feedTrendIds);
  issues.push(...selectionIssues);

  const candidatePoolChanges = readCandidatePoolChanges(audit, key);
  return {
    key,
    label,
    healthy: issues.length === 0,
    capturedAt,
    discoveryScannedAt,
    candidateCount: audit?.candidateCount ?? null,
    qualifiedInventoryCount: audit?.qualifiedInventoryCount ?? null,
    qualifiedClusterCount: audit?.qualifiedClusterCount ?? null,
    publishedInventoryCount: key === "audio"
      ? audit?.publishedInventoryCount ?? null
      : feedInventoryCount,
    feedInventoryCount,
    candidatePoolChanges,
    selectionChanges: selection,
    issues,
  };
}

export async function checkTrendFeedsHealth({
  checkedAt = new Date().toISOString(),
  sources = SOURCES,
} = {}) {
  if (!Number.isFinite(Date.parse(checkedAt))) {
    throw new Error("Horodatage de contrôle Trends invalide.");
  }
  const results = await Promise.all(sources.map(async (source) => {
    const [feedDocument, statusDocument] = await Promise.all([
      readJsonDocument(source.feedPath, "feed"),
      readJsonDocument(source.statusPath, "refresh-status"),
    ]);
    return evaluateTrendHealth({
      key: source.key,
      label: source.label,
      feed: feedDocument.value,
      status: statusDocument.value,
      readIssues: [feedDocument.issue, statusDocument.issue].filter(Boolean),
    }, checkedAt);
  }));
  return {
    checkedAt,
    healthy: results.every((result) => result.healthy),
    results,
  };
}

async function readJsonDocument(path, documentLabel) {
  const displayPath = relative(root, path).replaceAll("\\", "/");
  try {
    return { value: JSON.parse(await readFile(path, "utf8")), issue: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: null, issue: `${documentLabel} JSON absent (${displayPath})` };
    }
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    return {
      value: null,
      issue: `${documentLabel} JSON illisible ou corrompu (${displayPath}): ${detail}`,
    };
  }
}

function readCandidatePoolChanges(audit, key) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
  const source = key === "audio" ? audit.candidatePoolDelta : audit;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const added = changeCount(source.added);
  const removed = changeCount(source.removed);
  const retained = changeCount(source.retained ?? source.retainedIds);
  if ([added, removed, retained].some((count) => count === null)) return null;
  return {
    added,
    removed,
    retained,
    changed: added > 0 || removed > 0,
  };
}

function readSelectionChanges(audit, key) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
  const raw = key === "audio" ? audit.selectionAudit : {
    evaluatedAt: audit.scannedAt,
    addedTrendIds: audit.newQualifiedTrendIds,
    removedTrendIds: audit.removedTrendIds,
    retainedTrendIds: audit.retainedQualifiedTrendIds,
    noRotationReason: audit.noRotationReason,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const addedIds = raw.addedTrendIds;
  const removedIds = raw.removedTrendIds;
  const retainedIds = raw.retainedTrendIds;
  if (
    !isIso(raw.evaluatedAt) ||
    !uniqueNonEmptyStrings(addedIds) ||
    !uniqueNonEmptyStrings(removedIds) ||
    !uniqueNonEmptyStrings(retainedIds)
  ) return null;
  if (
    key === "video" &&
    ((Number.isSafeInteger(audit.newQualifiedCount) && audit.newQualifiedCount !== addedIds.length) ||
      (Number.isSafeInteger(audit.removedTrendCount) && audit.removedTrendCount !== removedIds.length))
  ) return null;
  const noRotationReason = raw.noRotationReason === null
    ? null
    : isNonEmptyString(raw.noRotationReason)
      ? raw.noRotationReason.trim()
      : undefined;
  if (noRotationReason === undefined) return null;
  return {
    evaluatedAt: raw.evaluatedAt,
    added: addedIds.length,
    removed: removedIds.length,
    retained: retainedIds.length,
    addedIds,
    removedIds,
    retainedIds,
    noRotationReason,
    changed: addedIds.length > 0 || removedIds.length > 0,
  };
}

function changeCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}

async function main() {
  const report = await checkTrendFeedsHealth({
    checkedAt: process.env.TRENDS_HEALTH_NOW ?? new Date().toISOString(),
  });
  for (const result of report.results) {
    const pool = result.candidatePoolChanges;
    const poolLabel = pool
      ? `pool ${pool.changed ? "modifié" : "inchangé"} (+${pool.added}/-${pool.removed}/${pool.retained} retenus)`
      : "pool non documenté";
    const selection = result.selectionChanges;
    const rotationLabel = selection
      ? selection.changed
        ? `rotation +${selection.added}/-${selection.removed}`
        : `rotation nulle justifiée (${selection.noRotationReason})`
      : "rotation non documentée";
    const qualifiedLabel = result.key === "audio"
      ? `${result.qualifiedClusterCount ?? "?"} clusters frais, ${result.publishedInventoryCount ?? "?"} publiés`
      : `${result.qualifiedInventoryCount ?? "?"} qualifiés`;
    if (result.healthy) {
      console.log(
        `OK ${result.label}: scan ${result.discoveryScannedAt}, ` +
        `${result.candidateCount} candidats, ${qualifiedLabel}, ${poolLabel}, ${rotationLabel}.`,
      );
      continue;
    }
    console.error(
      `FAIL ${result.label}: ${result.issues.join("; ")}. ` +
      `Audit: ${result.candidateCount ?? "?"} candidats, ${qualifiedLabel}, ${poolLabel}, ${rotationLabel}.`,
    );
  }
  if (!report.healthy) process.exitCode = 1;
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) await main();
