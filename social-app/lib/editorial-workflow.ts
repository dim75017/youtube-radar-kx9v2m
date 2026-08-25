import type { SocialIdea } from "./social-ideas.ts";
import type { SocialPlatform } from "./social-scanner.ts";

export type IdeaDecision = "produce" | "rework" | "discard";

export type IdeaFeedback = {
  ideaId: string;
  decision: IdeaDecision;
  primaryPlatform: SocialPlatform;
  pattern: SocialIdea["pattern"];
  format: string;
  title: string;
  hook: string;
  basePotentialScore: number;
  reason: string | null;
  updatedAt: string;
};

export type ScheduledIdea = {
  id: string;
  ideaId: string;
  title: string;
  hook: string;
  platform: SocialPlatform;
  format: string;
  scheduledFor: string;
  status: "planned" | "published";
  createdAt: string;
  updatedAt: string;
};

export type EditorialWorkflowState = {
  feedback: Record<string, IdeaFeedback>;
  schedule: ScheduledIdea[];
};

export type LearnedIdea = SocialIdea & {
  learnedPotentialScore: number;
  learningDelta: number;
  learningExplanation: string;
};

export const EMPTY_EDITORIAL_WORKFLOW: EditorialWorkflowState = {
  feedback: {},
  schedule: [],
};

const DECISION_SIGNAL: Record<IdeaDecision, number> = {
  produce: 1,
  rework: 0.15,
  discard: -1,
};

/**
 * Ajuste le potentiel de chaque proposition à partir des décisions précédentes.
 * Le signal reste volontairement borné : il personnalise l'ordre sans effacer
 * la performance observée dans l'historique social.
 */
export function applyPreferenceLearning(
  ideas: readonly SocialIdea[],
  feedback: Readonly<Record<string, IdeaFeedback>>,
): LearnedIdea[] {
  const examples = Object.values(feedback);

  return ideas
    .map((idea) => {
      const patternSignal = averageSignal(
        examples.filter((item) => item.pattern === idea.pattern),
      );
      const formatSignal = averageSignal(
        examples.filter((item) => normalizeFormat(item.format) === normalizeFormat(idea.proposedFormat)),
      );
      const learningDelta = clamp(
        Math.round(patternSignal * 8 + formatSignal * 4),
        -12,
        12,
      );
      const learnedPotentialScore = clamp(
        idea.potentialScore + learningDelta,
        1,
        100,
      );
      const learningExplanation = learningDelta === 0
        ? examples.length
          ? "Pas encore de préférence nette sur ce type d'idée."
          : "Classement initial fondé sur les posts historiques."
        : learningDelta > 0
          ? `Remonte de ${learningDelta} point${learningDelta > 1 ? "s" : ""} selon les idées déjà acceptées.`
          : `Recule de ${Math.abs(learningDelta)} point${Math.abs(learningDelta) > 1 ? "s" : ""} selon les idées déjà écartées.`;

      return {
        ...idea,
        learnedPotentialScore,
        learningDelta,
        learningExplanation,
      };
    })
    .sort((left, right) =>
      right.learnedPotentialScore - left.learnedPotentialScore ||
      left.id.localeCompare(right.id),
    );
}

export function feedbackForIdea(
  idea: SocialIdea,
  decision: IdeaDecision,
  updatedAt: string,
  reason: string | null = null,
): IdeaFeedback {
  return {
    ideaId: idea.id,
    decision,
    primaryPlatform: idea.primaryPlatform,
    pattern: idea.pattern,
    format: idea.proposedFormat,
    title: idea.title,
    hook: idea.hook,
    basePotentialScore: idea.potentialScore,
    reason,
    updatedAt,
  };
}

export function scheduleAcceptedIdea(
  idea: SocialIdea,
  existing: readonly ScheduledIdea[],
  now: Date | string | number = new Date(),
): ScheduledIdea {
  const alreadyScheduled = existing.find((item) => item.ideaId === idea.id);
  if (alreadyScheduled) return alreadyScheduled;

  const timestamp = toIsoTimestamp(now);
  return {
    id: `schedule:${idea.id}`,
    ideaId: idea.id,
    title: idea.title,
    hook: idea.hook,
    platform: idea.primaryPlatform,
    format: idea.proposedFormat,
    scheduledFor: findNextPlanningDate(existing, now),
    status: "planned",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function findNextPlanningDate(
  schedule: readonly ScheduledIdea[],
  now: Date | string | number = new Date(),
): string {
  const cursor = startOfUtcDay(now);
  cursor.setUTCDate(cursor.getUTCDate() + 1);

  for (let offset = 0; offset < 366; offset += 1) {
    const date = dateKey(cursor);
    const items = schedule.filter(
      (item) => item.status === "planned" && item.scheduledFor === date,
    );
    if (!items.length) return date;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  throw new Error("Aucun créneau éditorial disponible dans les 12 prochains mois.");
}

export function updateScheduledDate(
  schedule: readonly ScheduledIdea[],
  ideaId: string,
  scheduledFor: string,
  now: Date | string | number = new Date(),
): ScheduledIdea[] {
  if (!isPlanningDateKey(scheduledFor)) {
    throw new Error("La date du planning doit utiliser le format AAAA-MM-JJ.");
  }
  const current = schedule.find((item) => item.ideaId === ideaId);
  if (!current) throw new Error("Idée planifiée introuvable.");
  if (
    schedule.some(
      (item) =>
        item.ideaId !== ideaId &&
        item.status === "planned" &&
        item.scheduledFor === scheduledFor,
    )
  ) {
    throw new Error("Une publication est déjà prévue à cette date.");
  }
  const updatedAt = toIsoTimestamp(now);
  return schedule
    .map((item) => item.ideaId === ideaId ? { ...item, scheduledFor, updatedAt } : item)
    .sort(compareScheduleItems);
}

export function normalizeWorkflowState(value: unknown): EditorialWorkflowState {
  if (!value || typeof value !== "object") return { feedback: {}, schedule: [] };
  const candidate = value as Partial<EditorialWorkflowState>;
  const feedbackEntries = candidate.feedback && typeof candidate.feedback === "object"
    ? Object.entries(candidate.feedback).filter((entry): entry is [string, IdeaFeedback] =>
        isFeedback(entry[1]),
      )
    : [];
  const schedule = Array.isArray(candidate.schedule)
    ? candidate.schedule.filter(isScheduledIdea).sort(compareScheduleItems)
    : [];
  return {
    feedback: Object.fromEntries(feedbackEntries),
    schedule,
  };
}

export function compareScheduleItems(left: ScheduledIdea, right: ScheduledIdea) {
  return left.scheduledFor.localeCompare(right.scheduledFor) ||
    left.ideaId.localeCompare(right.ideaId);
}

function averageSignal(items: readonly IdeaFeedback[]): number {
  if (!items.length) return 0;
  return items.reduce((sum, item) => sum + DECISION_SIGNAL[item.decision], 0) / items.length;
}

function normalizeFormat(value: string) {
  return value.toLocaleLowerCase("fr-FR").replace(/[^a-z0-9]+/g, " ").trim();
}

function isFeedback(value: unknown): value is IdeaFeedback {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IdeaFeedback>;
  return typeof candidate.ideaId === "string" &&
    (candidate.decision === "produce" || candidate.decision === "rework" || candidate.decision === "discard") &&
    isPlatform(candidate.primaryPlatform) &&
    typeof candidate.pattern === "string" &&
    typeof candidate.format === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.hook === "string" &&
    typeof candidate.basePotentialScore === "number" &&
    typeof candidate.updatedAt === "string";
}

function isScheduledIdea(value: unknown): value is ScheduledIdea {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScheduledIdea>;
  return typeof candidate.id === "string" &&
    typeof candidate.ideaId === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.hook === "string" &&
    isPlatform(candidate.platform) &&
    typeof candidate.format === "string" &&
    typeof candidate.scheduledFor === "string" &&
    isPlanningDateKey(candidate.scheduledFor) &&
    (candidate.status === "planned" || candidate.status === "published") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string";
}

function isPlatform(value: unknown): value is SocialPlatform {
  return value === "youtube" || value === "instagram" || value === "tiktok" || value === "x";
}

export function isPlanningDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function startOfUtcDay(value: Date | string | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date de référence invalide.");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function toIsoTimestamp(value: Date | string | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date de référence invalide.");
  return date.toISOString();
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
