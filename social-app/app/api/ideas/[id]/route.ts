import {
  actorFromRequest,
  ensureSocialSchema,
  getD1,
  routeError,
} from "../../../../db/runtime";

type IdeaRow = {
  id: string;
  title: string;
  concept: string;
  objective: string;
  platform: string;
  format: string;
  character: string;
  hook: string;
  cta: string;
  status: string;
  prediction_snapshot: string;
  priority_score: number;
  row_version: number;
};

type DecisionPayload = {
  status?: "approved" | "rejected" | "review";
  rationale?: string;
  idealPublishAt?: string;
  expectedVersion?: number;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await ensureSocialSchema();
    const { id } = await context.params;
    const payload = (await request.json()) as DecisionPayload;
    if (!payload.status || !["approved", "rejected", "review"].includes(payload.status)) {
      return Response.json({ error: "Décision invalide." }, { status: 400 });
    }
    if (payload.status === "rejected" && !payload.rationale?.trim()) {
      return Response.json(
        { error: "Un motif court est requis pour refuser une idée." },
        { status: 400 },
      );
    }

    const db = getD1();
    const idea = await db
      .prepare("SELECT * FROM ideas WHERE id = ?")
      .bind(id)
      .first<IdeaRow>();
    if (!idea) {
      return Response.json({ error: "Idée introuvable." }, { status: 404 });
    }
    if (
      payload.expectedVersion !== undefined &&
      payload.expectedVersion !== idea.row_version
    ) {
      return Response.json(
        { error: "Cette idée a changé. Recharge la liste avant de décider." },
        { status: 409 },
      );
    }

    const nextVersion = idea.row_version + 1;
    const statements = [
      db
        .prepare(
          `UPDATE ideas
           SET status = ?, decision_note = ?, ideal_publish_at = ?,
               row_version = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND row_version = ?`,
        )
        .bind(
          payload.status,
          payload.rationale?.trim() || null,
          payload.idealPublishAt || null,
          nextVersion,
          id,
          idea.row_version,
        ),
      db
        .prepare(
          `INSERT INTO decision_events (
            entity_type, entity_id, action, from_status, to_status,
            actor_label, rationale, immutable_snapshot
          ) VALUES ('idea', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          payload.status === "review" ? "restored" : payload.status,
          idea.status,
          payload.status,
          actorFromRequest(request),
          payload.rationale?.trim() || null,
          idea.prediction_snapshot,
        ),
    ];

    if (payload.status === "approved") {
      const hookVariants = [
        idea.hook,
        `Sans dialogue : ${idea.hook}`,
        `Version communauté : ${idea.hook}`,
      ];
      const storyboard = [
        "0–2 s · image-signature et situation immédiatement lisible",
        "2–8 s · progression visuelle en deux ou trois plans calmes",
        "8–12 s · résolution et boucle propre vers le premier plan",
      ];
      const assets = [
        `${idea.character} · animation ou illustration validée`,
        "Décor et accessoires cohérents avec le lore",
        "Musique Lofi Records autorisée pour la plateforme",
      ];
      statements.push(
        db
          .prepare(
            `INSERT INTO briefs (
              id, idea_id, objective, message, hook_variants, storyboard,
              asset_requirements, success_criteria, deadline
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idea_id) DO UPDATE SET
              objective = excluded.objective,
              message = excluded.message,
              hook_variants = excluded.hook_variants,
              storyboard = excluded.storyboard,
              asset_requirements = excluded.asset_requirements,
              success_criteria = excluded.success_criteria,
              deadline = excluded.deadline`,
          )
          .bind(
            `brief_${crypto.randomUUID()}`,
            id,
            idea.objective,
            idea.concept,
            JSON.stringify(hookVariants),
            JSON.stringify(storyboard),
            JSON.stringify(assets),
            "Comparer la rétention et les sauvegardes à une cohorte de même format et de même âge, sans conclure avant un échantillon suffisant.",
            payload.idealPublishAt || null,
          ),
      );
    }

    await db.batch(statements);
    return Response.json({ id, status: payload.status, rowVersion: nextVersion });
  } catch (error) {
    return routeError(error);
  }
}
