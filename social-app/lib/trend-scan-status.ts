export type VideoTrendScanAudit = {
  scannedAt: string;
  complete: boolean;
  candidateCount: number;
  qualifiedInventoryCount: number;
  currentMatchedCount: number;
  added: number;
  removed: number;
  retained: number;
  candidateUrls: string[];
  matchedTrendIds: string[];
};

export type VideoTrendScanStatus = {
  version: 1;
  cadenceHours: 24;
  lastAttemptAt: string;
  lastSuccessfulAt: string;
  status: "success" | "degraded";
  message: string;
  discoveryAudit: VideoTrendScanAudit;
};

export type AudioTrendCandidateReference = {
  audioUrl: string;
  referenceUrl: string;
};

export type AudioTrendScanAudit = {
  scannedAt: string | null;
  status: "success" | "incomplete" | "not-run";
  complete: boolean;
  candidateCount: number;
  qualifiedInventoryCount: number;
  currentMatchedCount: number;
  newCandidateCount: number;
  added: string[];
  removed: string[];
  retainedIds: string[];
  candidateAudioUrls: string[];
  candidateReferences: AudioTrendCandidateReference[];
};

export type AudioTrendScanStatus = {
  version: 1;
  attemptedAt: string;
  status: "success" | "failed";
  published: boolean;
  discoveryAudit: AudioTrendScanAudit;
};

const MAX_AUDIT_URLS = 250;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function assertUrlArray(value: unknown, context: string) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_AUDIT_URLS ||
    value.some((candidate) => !isHttpsUrl(candidate))
  ) {
    throw new Error(`${context} invalide.`);
  }
  return value as string[];
}

function assertIdArray(value: unknown, context: string) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_AUDIT_URLS ||
    value.some((candidate) =>
      typeof candidate !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate)
    )
  ) {
    throw new Error(`${context} invalide.`);
  }
  return value as string[];
}

export function assertVideoTrendScanStatus(value: unknown): VideoTrendScanStatus {
  if (!isObject(value) || !isObject(value.discoveryAudit)) {
    throw new Error("Statut du scan Trends vidéos invalide.");
  }
  const audit = value.discoveryAudit;
  if (
    value.version !== 1 ||
    value.cadenceHours !== 24 ||
    !isTimestamp(value.lastAttemptAt) ||
    !isTimestamp(value.lastSuccessfulAt) ||
    (value.status !== "success" && value.status !== "degraded") ||
    typeof value.message !== "string" ||
    (audit.scannedAt !== null && !isTimestamp(audit.scannedAt)) ||
    typeof audit.complete !== "boolean" ||
    !isCount(audit.candidateCount) ||
    !isCount(audit.qualifiedInventoryCount) ||
    !isCount(audit.currentMatchedCount) ||
    !isCount(audit.added) ||
    !isCount(audit.removed) ||
    !isCount(audit.retained)
  ) {
    throw new Error("Statut du scan Trends vidéos invalide.");
  }
  assertUrlArray(audit.candidateUrls, "URLs candidates vidéo");
  assertIdArray(audit.matchedTrendIds, "Identifiants vidéo retrouvés");
  return value as unknown as VideoTrendScanStatus;
}

export function assertAudioTrendScanStatus(value: unknown): AudioTrendScanStatus {
  if (!isObject(value) || !isObject(value.discoveryAudit)) {
    throw new Error("Statut du scan Trends audio invalide.");
  }
  const audit = value.discoveryAudit;
  if (
    value.version !== 1 ||
    !isTimestamp(value.attemptedAt) ||
    (value.status !== "success" && value.status !== "failed") ||
    typeof value.published !== "boolean" ||
    !isTimestamp(audit.scannedAt) ||
    !["success", "incomplete", "not-run"].includes(String(audit.status)) ||
    typeof audit.complete !== "boolean" ||
    !isCount(audit.candidateCount) ||
    !isCount(audit.qualifiedInventoryCount) ||
    !isCount(audit.currentMatchedCount) ||
    !isCount(audit.newCandidateCount)
  ) {
    throw new Error("Statut du scan Trends audio invalide.");
  }
  assertUrlArray(audit.added, "Nouveaux candidats audio");
  assertUrlArray(audit.removed, "Candidats audio retirés");
  assertIdArray(audit.retainedIds, "Identifiants audio conservés");
  assertUrlArray(audit.candidateAudioUrls, "URLs candidates audio");
  if (
    !Array.isArray(audit.candidateReferences) ||
    audit.candidateReferences.length > MAX_AUDIT_URLS ||
    audit.candidateReferences.some((candidate) =>
      !isObject(candidate) ||
      !isHttpsUrl(candidate.audioUrl) ||
      !isHttpsUrl(candidate.referenceUrl)
    )
  ) {
    throw new Error("Références candidates audio invalides.");
  }
  return value as unknown as AudioTrendScanStatus;
}

export function isScanLate(scannedAt: string | null | undefined, now = Date.now()) {
  const timestamp = Date.parse(scannedAt ?? "");
  return !Number.isFinite(timestamp) || now - timestamp > 26 * 60 * 60 * 1_000;
}
