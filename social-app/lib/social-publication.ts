import type { ScheduledIdea } from "./editorial-workflow.ts";
import type { SocialPlatform } from "./social-scanner.ts";

export const PUBLICATION_STORAGE_KEY = "lofi-social-radar:publication-queue:v1";
export const PUBLICATION_TIMEZONE = "Europe/Paris" as const;

export type PublicationPlanStatus = "draft" | "approved" | "scheduled";

export type PublicationPlan = {
  id: string;
  ideaId: string;
  sourceScheduleFingerprint: string;
  sourceScheduleUpdatedAt: string;
  title: string;
  format: string;
  caption: string;
  mediaUrl: string;
  platforms: SocialPlatform[];
  publishAtLocal: string;
  timezone: typeof PUBLICATION_TIMEZONE;
  status: PublicationPlanStatus;
  revision: number;
  approvedRevision: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicationQueueState = {
  version: 1;
  plans: Record<string, PublicationPlan>;
  tombstones: Record<string, string>;
};

export type PublicationPlanPatch = Partial<
  Pick<PublicationPlan, "caption" | "mediaUrl" | "platforms" | "publishAtLocal">
>;

export const EMPTY_PUBLICATION_QUEUE: PublicationQueueState = {
  version: 1,
  plans: {},
  tombstones: {},
};

const PLATFORM_ORDER: SocialPlatform[] = ["youtube", "instagram", "tiktok", "x"];
const LOCAL_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function publicationPlanFromScheduledIdea(
  item: ScheduledIdea,
  now: Date | string | number = new Date(),
): PublicationPlan {
  if (item.status !== "planned") {
    throw new Error("Une publication déjà publiée ne peut pas revenir dans la file.");
  }
  const timestamp = isoTimestamp(now);
  return {
    id: `publication-plan:${item.ideaId}`,
    ideaId: item.ideaId,
    sourceScheduleFingerprint: scheduledIdeaFingerprint(item),
    sourceScheduleUpdatedAt: isoTimestamp(item.updatedAt),
    title: item.title,
    format: item.format,
    caption: item.hook,
    mediaUrl: "",
    platforms: [item.platform],
    publishAtLocal: `${item.scheduledFor}T18:00`,
    timezone: PUBLICATION_TIMEZONE,
    status: "draft",
    revision: 1,
    approvedRevision: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function mergeScheduledIdeasIntoPublicationQueue(
  schedule: readonly ScheduledIdea[],
  queue: PublicationQueueState,
  now: Date | string | number = new Date(),
): PublicationQueueState {
  const activeSchedule = schedule.filter((item) => item.status === "planned");
  const activeIdeaIds = new Set(activeSchedule.map((item) => item.ideaId));
  const sourceByIdea = new Map(schedule.map((item) => [item.ideaId, item] as const));
  const plans: Record<string, PublicationPlan> = {};
  const tombstones = Object.entries(queue.tombstones ?? {}).reduce<Record<string, string>>(
    (result, [ideaId, timestamp]) => {
      result[ideaId] = isoTimestamp(timestamp);
      return result;
    },
    {},
  );
  let changed = false;
  for (const item of schedule) {
    if (item.status === "planned") continue;
    const invalidatedAt = isoTimestamp(item.updatedAt);
    if (!tombstones[item.ideaId] || tombstones[item.ideaId].localeCompare(invalidatedAt) < 0) {
      tombstones[item.ideaId] = invalidatedAt;
      changed = true;
    }
  }
  for (const plan of Object.values(queue.plans)) {
    if (activeIdeaIds.has(plan.ideaId)) {
      const tombstone = tombstones[plan.ideaId];
      if (!tombstone || tombstone.localeCompare(plan.sourceScheduleUpdatedAt) < 0) {
        plans[plan.ideaId] = plan;
      } else {
        changed = true;
      }
      continue;
    }
    const source = sourceByIdea.get(plan.ideaId);
    const invalidatedAt = source ? isoTimestamp(source.updatedAt) : isoTimestamp(now);
    if (!tombstones[plan.ideaId] || tombstones[plan.ideaId].localeCompare(invalidatedAt) < 0) {
      tombstones[plan.ideaId] = invalidatedAt;
    }
    changed = true;
  }
  for (const item of activeSchedule) {
    const itemUpdatedAt = isoTimestamp(item.updatedAt);
    const tombstone = tombstones[item.ideaId];
    if (tombstone && tombstone.localeCompare(itemUpdatedAt) >= 0) continue;
    if (tombstone) {
      delete tombstones[item.ideaId];
      changed = true;
    }
    const existing = plans[item.ideaId];
    if (existing?.sourceScheduleFingerprint === scheduledIdeaFingerprint(item)) continue;
    if (existing && existing.sourceScheduleUpdatedAt.localeCompare(itemUpdatedAt) > 0) continue;
    plans[item.ideaId] = publicationPlanFromScheduledIdea(item, now);
    changed = true;
  }
  return changed ? { version: 1, plans, tombstones } : queue;
}

export function updatePublicationPlan(
  plan: PublicationPlan,
  patch: PublicationPlanPatch,
  now: Date | string | number = new Date(),
): PublicationPlan {
  const next = {
    caption: patch.caption === undefined ? plan.caption : patch.caption,
    mediaUrl: patch.mediaUrl === undefined ? plan.mediaUrl : patch.mediaUrl.trim(),
    platforms: patch.platforms === undefined
      ? plan.platforms
      : normalizePlatforms(patch.platforms),
    publishAtLocal: patch.publishAtLocal === undefined
      ? plan.publishAtLocal
      : patch.publishAtLocal,
  };
  const changed = next.caption !== plan.caption ||
    next.mediaUrl !== plan.mediaUrl ||
    next.publishAtLocal !== plan.publishAtLocal ||
    next.platforms.join(",") !== plan.platforms.join(",");
  if (!changed) return plan;

  return {
    ...plan,
    ...next,
    status: "draft",
    revision: plan.revision + 1,
    approvedRevision: null,
    updatedAt: isoTimestamp(now),
  };
}

export function publicationReadinessIssues(
  plan: PublicationPlan,
  now: Date | string | number = new Date(),
): string[] {
  const issues: string[] = [];
  if (!plan.caption.trim()) issues.push("Ajoute le texte final.");
  if (!plan.platforms.length) issues.push("Choisis au moins un réseau.");

  const mediaRequired = plan.platforms.some((platform) => platform !== "x");
  if (mediaRequired && !plan.mediaUrl) {
    issues.push("Ajoute le média final pour YouTube, Instagram ou TikTok.");
  } else if (plan.mediaUrl && !isSafeHttpsUrl(plan.mediaUrl)) {
    issues.push("Le média doit utiliser une URL publique HTTPS, sans identifiants ni paramètres.");
  }

  if (!isValidLocalDateTime(plan.publishAtLocal)) {
    issues.push("Choisis une heure Europe/Paris valide et non ambiguë.");
  } else if (localDateTimeIsPast(plan.publishAtLocal, now)) {
    issues.push("Choisis une date et une heure futures.");
  }
  return issues;
}

export function approvePublicationPlan(
  plan: PublicationPlan,
  now: Date | string | number = new Date(),
): PublicationPlan {
  const issues = publicationReadinessIssues(plan, now);
  if (issues.length) throw new Error(issues.join(" "));
  return {
    ...plan,
    status: "approved",
    approvedRevision: plan.revision,
    updatedAt: isoTimestamp(now),
  };
}

export function markPublicationPlanScheduled(
  plan: PublicationPlan,
  now: Date | string | number = new Date(),
): PublicationPlan {
  if (plan.status !== "approved" || plan.approvedRevision !== plan.revision) {
    throw new Error("Valide cette version exacte avant de la programmer.");
  }
  const issues = publicationReadinessIssues(plan, now);
  if (issues.length) throw new Error(issues.join(" "));
  return {
    ...plan,
    status: "scheduled",
    updatedAt: isoTimestamp(now),
  };
}

export function findPublicationScheduleCollision(
  plan: PublicationPlan,
  queue: PublicationQueueState,
): PublicationPlan | null {
  return Object.values(queue.plans).find((candidate) =>
    candidate.ideaId !== plan.ideaId &&
    candidate.status === "scheduled" &&
    candidate.publishAtLocal === plan.publishAtLocal &&
    candidate.platforms.some((platform) => plan.platforms.includes(platform)),
  ) ?? null;
}

export function revokePublicationPlan(
  plan: PublicationPlan,
  now: Date | string | number = new Date(),
): PublicationPlan {
  if (plan.status === "draft") return plan;
  return {
    ...plan,
    status: "draft",
    revision: plan.revision + 1,
    approvedRevision: null,
    updatedAt: isoTimestamp(now),
  };
}

export function normalizePublicationQueue(value: unknown): PublicationQueueState {
  if (!value || typeof value !== "object") return { version: 1, plans: {}, tombstones: {} };
  const candidate = value as Partial<PublicationQueueState>;
  if (!candidate.plans || typeof candidate.plans !== "object") {
    return { version: 1, plans: {}, tombstones: {} };
  }
  const plans = Object.values(candidate.plans)
    .filter(isPublicationPlan)
    .reduce<Record<string, PublicationPlan>>((result, plan) => {
      result[plan.ideaId] = {
        ...plan,
        sourceScheduleUpdatedAt: isoTimestamp(plan.sourceScheduleUpdatedAt),
        createdAt: isoTimestamp(plan.createdAt),
        updatedAt: isoTimestamp(plan.updatedAt),
      };
      return result;
    }, {});
  const tombstones = candidate.tombstones && typeof candidate.tombstones === "object"
    ? Object.entries(candidate.tombstones).reduce<Record<string, string>>((result, [ideaId, timestamp]) => {
      if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) {
        result[ideaId] = isoTimestamp(timestamp);
      }
      return result;
    }, {})
    : {};
  for (const [ideaId, plan] of Object.entries(plans)) {
    const tombstone = tombstones[ideaId];
    if (tombstone && tombstone.localeCompare(plan.sourceScheduleUpdatedAt) >= 0) {
      delete plans[ideaId];
    }
  }
  const scheduledSlots = new Map<string, string>();
  const conflictingIdeaIds = new Set<string>();
  for (const plan of Object.values(plans).filter((item) => item.status === "scheduled")) {
    for (const platform of plan.platforms) {
      const slot = `${platform}:${plan.publishAtLocal}`;
      const existingIdeaId = scheduledSlots.get(slot);
      if (existingIdeaId) {
        conflictingIdeaIds.add(existingIdeaId);
        conflictingIdeaIds.add(plan.ideaId);
      } else {
        scheduledSlots.set(slot, plan.ideaId);
      }
    }
  }
  for (const ideaId of conflictingIdeaIds) {
    const plan = plans[ideaId];
    if (!plan) continue;
    plans[ideaId] = {
      ...plan,
      status: "draft",
      revision: plan.revision + 1,
      approvedRevision: null,
    };
  }
  return { version: 1, plans, tombstones };
}

export function sortedPublicationPlans(queue: PublicationQueueState): PublicationPlan[] {
  return Object.values(queue.plans).sort((left, right) =>
    left.publishAtLocal.localeCompare(right.publishAtLocal) ||
    left.title.localeCompare(right.title, "fr-FR"),
  );
}

function isPublicationPlan(value: unknown): value is PublicationPlan {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublicationPlan>;
  const validStatus = candidate.status === "draft" ||
    candidate.status === "approved" ||
    candidate.status === "scheduled";
  const validRevision = Number.isInteger(candidate.revision) &&
    (candidate.revision ?? 0) > 0;
  const validApproval = candidate.status === "draft"
    ? candidate.approvedRevision === null
    : candidate.approvedRevision === candidate.revision;
  const validShape = validStatus && validRevision && validApproval &&
    typeof candidate.id === "string" &&
    typeof candidate.ideaId === "string" &&
    typeof candidate.sourceScheduleFingerprint === "string" &&
    typeof candidate.sourceScheduleUpdatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.sourceScheduleUpdatedAt ?? "")) &&
    typeof candidate.title === "string" &&
    typeof candidate.format === "string" &&
    typeof candidate.caption === "string" &&
    typeof candidate.mediaUrl === "string" &&
    Array.isArray(candidate.platforms) &&
    candidate.platforms.every(isPlatform) &&
    typeof candidate.publishAtLocal === "string" &&
    candidate.timezone === PUBLICATION_TIMEZONE &&
    typeof candidate.createdAt === "string" &&
    Number.isFinite(Date.parse(candidate.createdAt ?? "")) &&
    typeof candidate.updatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.updatedAt ?? ""));
  if (!validShape) return false;
  if (candidate.status === "draft") return true;
  const plan = candidate as PublicationPlan;
  const mediaRequired = plan.platforms.some((platform) => platform !== "x");
  return Boolean(plan.caption.trim()) &&
    plan.platforms.length > 0 &&
    isValidLocalDateTime(plan.publishAtLocal) &&
    (!mediaRequired || Boolean(plan.mediaUrl)) &&
    (!plan.mediaUrl || isSafeHttpsUrl(plan.mediaUrl));
}

function normalizePlatforms(platforms: readonly SocialPlatform[]): SocialPlatform[] {
  const selected = new Set(platforms.filter(isPlatform));
  return PLATFORM_ORDER.filter((platform) => selected.has(platform));
}

function isPlatform(value: unknown): value is SocialPlatform {
  return value === "youtube" || value === "instagram" || value === "tiktok" || value === "x";
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isPublicMediaHostname(url.hostname);
  } catch {
    return false;
  }
}

function isValidLocalDateTime(value: string): boolean {
  return parisInstantCandidates(value).length === 1;
}

function localDateTimeIsPast(
  value: string,
  now: Date | string | number,
): boolean {
  const candidates = parisInstantCandidates(value);
  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime()) || candidates.length !== 1) return true;
  return candidates[0] <= reference.getTime();
}

function parisInstantCandidates(value: string): number[] {
  if (!LOCAL_DATE_TIME_PATTERN.test(value)) return [];
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  const roundTrip = new Date(wallClockUtc);
  if (roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute) return [];

  return [60, 120]
    .map((offsetMinutes) => wallClockUtc - offsetMinutes * 60_000)
    .filter((candidate) => parisDateTimeKey(candidate) === value);
}

function isPublicMediaHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return false;
  }
  if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname)) {
    return false;
  }
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second, third] = ipv4;
    return first >= 1 && first <= 223 &&
      first !== 10 &&
      first !== 127 &&
      !(first === 100 && second >= 64 && second <= 127) &&
      !(first === 169 && second === 254) &&
      !(first === 172 && second >= 16 && second <= 31) &&
      !(first === 192 && second === 0 && third === 0) &&
      !(first === 192 && second === 0 && third === 2) &&
      !(first === 192 && second === 168) &&
      !(first === 198 && (second === 18 || second === 19)) &&
      !(first === 198 && second === 51 && third === 100) &&
      !(first === 203 && second === 0 && third === 113);
  }
  return hostname.includes(".");
}

function scheduledIdeaFingerprint(item: ScheduledIdea): string {
  return JSON.stringify([
    isoTimestamp(item.createdAt),
    isoTimestamp(item.updatedAt),
    item.title,
    item.hook,
    item.platform,
    item.format,
    item.scheduledFor,
    item.status,
  ]);
}

function parisDateTimeKey(value: Date | string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date de référence invalide.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PUBLICATION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function isoTimestamp(value: Date | string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date de référence invalide.");
  return date.toISOString();
}
