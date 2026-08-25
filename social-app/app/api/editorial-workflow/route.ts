import {
  actorFromRequest,
  ensureSocialSchema,
  getD1,
  routeError,
} from "../../../db/runtime";
import {
  findNextPlanningDate,
  isPlanningDateKey,
  type EditorialWorkflowState,
  type IdeaDecision,
  type IdeaFeedback,
  type ScheduledIdea,
} from "../../../lib/editorial-workflow";
import type { EditorialPattern, SocialIdea } from "../../../lib/social-ideas";
import type { SocialPlatform } from "../../../lib/social-scanner";

type FeedbackRow = {
  idea_id: string;
  decision: IdeaDecision;
  primary_platform: SocialPlatform;
  pattern: EditorialPattern;
  format: string;
  title: string;
  hook: string;
  base_potential_score: number;
  reason: string | null;
  updated_at: string;
};

type ScheduleRow = {
  id: string;
  idea_id: string;
  title: string;
  hook: string;
  platform: SocialPlatform;
  format: string;
  scheduled_for: string;
  status: "planned" | "published";
  created_at: string;
  updated_at: string;
};

type DecidePayload = {
  action?: "decide";
  decision?: IdeaDecision;
  reason?: string;
  idea?: Pick<
    SocialIdea,
    "id" | "title" | "hook" | "pattern" | "primaryPlatform" | "proposedFormat" | "potentialScore"
  >;
};

type ReschedulePayload = {
  action?: "reschedule";
  ideaId?: string;
  scheduledFor?: string;
};

export async function GET() {
  try {
    await ensureSocialSchema();
    return Response.json(await readWorkflow());
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureSocialSchema();
    const payload = (await request.json()) as DecidePayload | ReschedulePayload;
    if (payload.action === "reschedule") {
      return rescheduleIdea(request, payload);
    }
    return decideIdea(request, payload as DecidePayload);
  } catch (error) {
    return routeError(error);
  }
}

async function decideIdea(request: Request, payload: DecidePayload) {
  if (!payload.idea || !isDecision(payload.decision)) {
    return Response.json({ error: "Décision ou idée invalide." }, { status: 400 });
  }
  const idea = payload.idea;
  if (
    !idea.id?.trim() ||
    !idea.title?.trim() ||
    !idea.hook?.trim() ||
    !idea.proposedFormat?.trim() ||
    !isPlatform(idea.primaryPlatform) ||
    !isPattern(idea.pattern) ||
    !Number.isFinite(idea.potentialScore)
  ) {
    return Response.json({ error: "La fiche idée est incomplète." }, { status: 400 });
  }

  const db = getD1();
  const previous = await db
    .prepare("SELECT decision FROM editorial_idea_feedback WHERE idea_id = ?")
    .bind(idea.id)
    .first<{ decision: IdeaDecision }>();
  const workflow = await readWorkflow();
  const timestamp = new Date().toISOString();
  const scheduledFor = payload.decision === "produce"
    ? findNextPlanningDate(workflow.schedule, timestamp)
    : null;
  const snapshot = JSON.stringify({
    ...idea,
    decision: payload.decision,
    reason: payload.reason?.trim() || null,
    decidedAt: timestamp,
  });
  const statements = [
    db
      .prepare(
        `INSERT INTO editorial_idea_feedback (
          idea_id, decision, primary_platform, pattern, format, title, hook,
          base_potential_score, reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idea_id) DO UPDATE SET
          decision = excluded.decision,
          primary_platform = excluded.primary_platform,
          pattern = excluded.pattern,
          format = excluded.format,
          title = excluded.title,
          hook = excluded.hook,
          base_potential_score = excluded.base_potential_score,
          reason = excluded.reason,
          updated_at = excluded.updated_at`,
      )
      .bind(
        idea.id,
        payload.decision,
        idea.primaryPlatform,
        idea.pattern,
        idea.proposedFormat,
        idea.title.trim(),
        idea.hook.trim(),
        Math.round(idea.potentialScore),
        payload.reason?.trim() || null,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO decision_events (
          entity_type, entity_id, action, from_status, to_status,
          actor_label, rationale, immutable_snapshot
        ) VALUES ('editorial_idea', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        idea.id,
        payload.decision,
        previous?.decision ?? null,
        payload.decision,
        actorFromRequest(request),
        payload.reason?.trim() || null,
        snapshot,
      ),
  ];

  if (payload.decision === "produce") {
    statements.push(
      db
        .prepare(
          `INSERT INTO editorial_schedule (
            id, idea_id, title, hook, platform, format, scheduled_for,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
          ON CONFLICT(idea_id) DO UPDATE SET
            title = excluded.title,
            hook = excluded.hook,
            platform = excluded.platform,
            format = excluded.format,
            updated_at = excluded.updated_at`,
        )
        .bind(
          `schedule:${idea.id}`,
          idea.id,
          idea.title.trim(),
          idea.hook.trim(),
          idea.primaryPlatform,
          idea.proposedFormat.trim(),
          scheduledFor,
          timestamp,
          timestamp,
        ),
    );
  } else {
    statements.push(
      db.prepare("DELETE FROM editorial_schedule WHERE idea_id = ?").bind(idea.id),
    );
  }

  await db.batch(statements);
  return Response.json(await readWorkflow());
}

async function rescheduleIdea(request: Request, payload: ReschedulePayload) {
  if (!payload.ideaId?.trim() || !payload.scheduledFor || !isPlanningDateKey(payload.scheduledFor)) {
    return Response.json({ error: "Idée ou date invalide." }, { status: 400 });
  }
  const db = getD1();
  const workflow = await readWorkflow();
  const current = workflow.schedule.find((item) => item.ideaId === payload.ideaId);
  if (!current) {
    return Response.json({ error: "Idée planifiée introuvable." }, { status: 404 });
  }
  const collisions = workflow.schedule.filter(
    (item) => item.ideaId !== current.ideaId && item.scheduledFor === payload.scheduledFor,
  );
  if (collisions.length) {
    return Response.json(
      { error: "Ce créneau est déjà occupé. Choisis une autre date." },
      { status: 409 },
    );
  }
  const timestamp = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "UPDATE editorial_schedule SET scheduled_for = ?, updated_at = ? WHERE idea_id = ?",
      )
      .bind(payload.scheduledFor, timestamp, current.ideaId),
    db
      .prepare(
        `INSERT INTO decision_events (
          entity_type, entity_id, action, actor_label, rationale, immutable_snapshot
        ) VALUES ('editorial_schedule', ?, 'rescheduled', ?, ?, ?)`,
      )
      .bind(
        current.ideaId,
        actorFromRequest(request),
        `${current.scheduledFor} → ${payload.scheduledFor}`,
        JSON.stringify({ ...current, scheduledFor: payload.scheduledFor, updatedAt: timestamp }),
      ),
  ]);
  return Response.json(await readWorkflow());
}

async function readWorkflow(): Promise<EditorialWorkflowState> {
  const db = getD1();
  const [feedbackResult, scheduleResult] = await Promise.all([
    db.prepare("SELECT * FROM editorial_idea_feedback ORDER BY updated_at DESC").all<FeedbackRow>(),
    db.prepare("SELECT * FROM editorial_schedule ORDER BY scheduled_for, platform, idea_id").all<ScheduleRow>(),
  ]);
  const feedback = Object.fromEntries(
    (feedbackResult.results ?? []).map((row): [string, IdeaFeedback] => [
      row.idea_id,
      {
        ideaId: row.idea_id,
        decision: row.decision,
        primaryPlatform: row.primary_platform,
        pattern: row.pattern,
        format: row.format,
        title: row.title,
        hook: row.hook,
        basePotentialScore: row.base_potential_score,
        reason: row.reason,
        updatedAt: row.updated_at,
      },
    ]),
  );
  const schedule = (scheduleResult.results ?? []).map((row): ScheduledIdea => ({
    id: row.id,
    ideaId: row.idea_id,
    title: row.title,
    hook: row.hook,
    platform: row.platform,
    format: row.format,
    scheduledFor: row.scheduled_for,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return { feedback, schedule };
}

function isDecision(value: unknown): value is IdeaDecision {
  return value === "produce" || value === "rework" || value === "discard";
}

function isPlatform(value: unknown): value is SocialPlatform {
  return value === "youtube" || value === "instagram" || value === "tiktok" || value === "x";
}

function isPattern(value: unknown): value is EditorialPattern {
  return value === "cross_platform_echo" ||
    value === "suspense_reveal" ||
    value === "music_and_usage" ||
    value === "character_and_lore" ||
    value === "community_conversation" ||
    value === "activation" ||
    value === "relatable_humour";
}
