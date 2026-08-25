import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isTrendEditorialScanLate,
  TREND_EDITORIAL_SCAN_MAX_AGE_HOURS,
} from "../lib/trend-health.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINIMUM_CANDIDATE_COUNT = 50;
const MINIMUM_QUALIFIED_INVENTORY_COUNT = 50;

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

export function validateDiscoveryAudit(audit, checkedAt) {
  const issues = [];
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return ["discoveryAudit absent"];
  }

  if (audit.complete !== true) {
    issues.push("discoveryAudit incomplet");
  }

  const scannedAt = typeof audit.scannedAt === "string" ? audit.scannedAt : null;
  if (!scannedAt || !Number.isFinite(Date.parse(scannedAt))) {
    issues.push("discoveryAudit.scannedAt invalide");
  } else if (isTrendEditorialScanLate(scannedAt, checkedAt)) {
    issues.push(`discoveryAudit.scannedAt dépasse ${TREND_EDITORIAL_SCAN_MAX_AGE_HOURS} h`);
  }

  if (!Number.isSafeInteger(audit.candidateCount) || audit.candidateCount < MINIMUM_CANDIDATE_COUNT) {
    issues.push(`discoveryAudit.candidateCount doit être >= ${MINIMUM_CANDIDATE_COUNT}`);
  }
  if (
    !Number.isSafeInteger(audit.qualifiedInventoryCount) ||
    audit.qualifiedInventoryCount < MINIMUM_QUALIFIED_INVENTORY_COUNT
  ) {
    issues.push(
      `discoveryAudit.qualifiedInventoryCount doit être >= ${MINIMUM_QUALIFIED_INVENTORY_COUNT}`,
    );
  }

  const candidatePoolChanges = readCandidatePoolChanges(audit);
  if (!candidatePoolChanges) {
    issues.push("discoveryAudit doit exposer added, removed et retained");
  } else if (
    Number.isSafeInteger(audit.candidateCount) &&
    candidatePoolChanges.added + candidatePoolChanges.retained !== audit.candidateCount
  ) {
    issues.push("discoveryAudit added + retained doit correspondre à candidateCount");
  }
  return issues;
}

export function evaluateTrendHealth({ key, label, feed, status }, checkedAt = new Date().toISOString()) {
  const issues = [];
  const capturedAt = typeof feed?.capturedAt === "string" ? feed.capturedAt : null;
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) {
    issues.push("feed.capturedAt invalide");
  } else if (isTrendEditorialScanLate(capturedAt, checkedAt)) {
    issues.push(`feed.capturedAt dépasse ${TREND_EDITORIAL_SCAN_MAX_AGE_HOURS} h`);
  }

  const audit = status?.discoveryAudit;
  issues.push(...validateDiscoveryAudit(audit, checkedAt));
  if (key === "audio") {
    if (status?.published !== true || !["success", "degraded"].includes(status?.status)) {
      issues.push("le refresh audio n'est pas publié");
    }
  } else if (status?.status !== "success") {
    issues.push("le refresh vidéo n'est pas publié avec succès");
  }

  const discoveryScannedAt = typeof audit?.scannedAt === "string" ? audit.scannedAt : null;
  if (
    capturedAt &&
    discoveryScannedAt &&
    Number.isFinite(Date.parse(capturedAt)) &&
    Number.isFinite(Date.parse(discoveryScannedAt)) &&
    Date.parse(capturedAt) !== Date.parse(discoveryScannedAt)
  ) {
    issues.push("feed.capturedAt ne correspond pas au scan qualifié publié");
  }

  const feedInventoryCount = Array.isArray(feed?.trends) ? feed.trends.length : null;
  if (feedInventoryCount === null || feedInventoryCount < MINIMUM_QUALIFIED_INVENTORY_COUNT) {
    issues.push(`le feed publié doit contenir au moins ${MINIMUM_QUALIFIED_INVENTORY_COUNT} trends`);
  }
  if (
    Number.isSafeInteger(audit?.qualifiedInventoryCount) &&
    Number.isSafeInteger(feedInventoryCount) &&
    audit.qualifiedInventoryCount > feedInventoryCount
  ) {
    issues.push("qualifiedInventoryCount dépasse l'inventaire réellement publié");
  }

  const candidatePoolChanges = readCandidatePoolChanges(audit);
  return {
    key,
    label,
    healthy: issues.length === 0,
    capturedAt,
    discoveryScannedAt,
    candidateCount: audit?.candidateCount ?? null,
    qualifiedInventoryCount: audit?.qualifiedInventoryCount ?? null,
    feedInventoryCount,
    candidatePoolChanges,
    issues,
  };
}

export async function checkTrendFeedsHealth({ checkedAt = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(checkedAt))) {
    throw new Error("Horodatage de contrôle Trends invalide.");
  }
  const results = await Promise.all(SOURCES.map(async (source) => {
    const [feed, status] = await Promise.all([
      readJson(source.feedPath),
      readJson(source.statusPath),
    ]);
    return evaluateTrendHealth({ key: source.key, label: source.label, feed, status }, checkedAt);
  }));
  return {
    checkedAt,
    healthy: results.every((result) => result.healthy),
    results,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function readCandidatePoolChanges(audit) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
  const added = changeCount(audit.added);
  const removed = changeCount(audit.removed);
  const retained = changeCount(audit.retained ?? audit.retainedIds);
  if ([added, removed, retained].some((count) => count === null)) return null;
  return {
    added,
    removed,
    retained,
    changed: added > 0 || removed > 0,
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
    const rotation = result.candidatePoolChanges;
    const rotationLabel = rotation
      ? `pool ${rotation.changed ? "modifié" : "inchangé"} (+${rotation.added}/-${rotation.removed}/${rotation.retained} retenus)`
      : "rotation non documentée";
    if (result.healthy) {
      console.log(
        `OK ${result.label}: scan ${result.discoveryScannedAt}, ` +
        `${result.candidateCount} candidats, ${result.qualifiedInventoryCount} qualifiés, ${rotationLabel}.`,
      );
      continue;
    }
    console.error(
      `FAIL ${result.label}: ${result.issues.join("; ")}. ` +
      `Audit: ${result.candidateCount ?? "?"} candidats, ` +
      `${result.qualifiedInventoryCount ?? "?"} qualifiés, ${rotationLabel}.`,
    );
  }
  if (!report.healthy) process.exitCode = 1;
}

const executedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (executedDirectly) await main();
