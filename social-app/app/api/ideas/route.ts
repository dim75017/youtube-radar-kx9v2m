import {
  actorFromRequest,
  ensureSocialSchema,
  getD1,
  routeError,
} from "../../../db/runtime";

type TrendRow = {
  id: string;
  title: string;
  brand_fit: number;
  velocity_score: number;
  saturation_risk: number;
  brand_risk: number;
  origin: string;
};

type IdeaPayload = {
  trendId?: string;
  title?: string;
  concept?: string;
  objective?: string;
  platform?: string;
  format?: string;
  character?: string;
  hook?: string;
  cta?: string;
  productionEffort?: string;
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export async function POST(request: Request) {
  try {
    await ensureSocialSchema();
    const payload = (await request.json()) as IdeaPayload;
    const required = [
      payload.trendId,
      payload.title,
      payload.concept,
      payload.objective,
      payload.platform,
      payload.format,
      payload.character,
      payload.hook,
    ];
    if (required.some((value) => !value?.trim())) {
      return Response.json(
        { error: "Complète les champs essentiels avant d’envoyer l’idée." },
        { status: 400 },
      );
    }

    const db = getD1();
    const trend = await db
      .prepare(
        `SELECT id, title, brand_fit, velocity_score, saturation_risk,
                brand_risk, origin
         FROM trends WHERE id = ?`,
      )
      .bind(payload.trendId)
      .first<TrendRow>();
    if (!trend) {
      return Response.json({ error: "Tendance introuvable." }, { status: 404 });
    }

    const effort = payload.productionEffort?.trim() || "Moyen";
    const feasibility = effort === "Faible" ? 92 : effort === "Élevé" ? 54 : 76;
    const brand = clamp(trend.brand_fit - trend.brand_risk * 0.2);
    const timing = clamp(trend.velocity_score - trend.saturation_risk * 0.35);
    const evidence = trend.origin === "demo" ? 36 : 58;
    const priority = clamp(
      brand * 0.3 +
        timing * 0.25 +
        evidence * 0.2 +
        78 * 0.15 +
        feasibility * 0.1 -
        trend.brand_risk * 0.35,
    );
    const confidence =
      trend.origin === "demo" ? "Données insuffisantes" : "Confiance limitée";
    const scoreExplanation =
      "Priorité éditoriale explicable : 30 % marque, 25 % timing, 20 % preuves, 15 % objectif, 10 % faisabilité, moins les risques. Ce score n’est pas une garantie de performance.";
    const id = `idea_${crypto.randomUUID()}`;
    const predictionVersion = "rules-v1.0";
    const immutablePrediction = {
      capturedAt: new Date().toISOString(),
      version: predictionVersion,
      trendId: trend.id,
      trendTitle: trend.title,
      brand,
      timing,
      evidence,
      feasibility,
      priority,
      confidence,
      explanation: scoreExplanation,
    };

    await db.batch([
      db
        .prepare(
          `INSERT INTO ideas (
            id, trend_id, title, concept, objective, platform, format,
            character, hook, cta, brand_score, timing_score, evidence_score,
            feasibility_score, priority_score, confidence_label,
            score_explanation, prediction_version, prediction_snapshot,
            production_effort, status, origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?)`,
        )
        .bind(
          id,
          trend.id,
          payload.title!.trim(),
          payload.concept!.trim(),
          payload.objective!.trim(),
          payload.platform!.trim(),
          payload.format!.trim(),
          payload.character!.trim(),
          payload.hook!.trim(),
          payload.cta?.trim() || "",
          brand,
          timing,
          evidence,
          feasibility,
          priority,
          confidence,
          scoreExplanation,
          predictionVersion,
          JSON.stringify(immutablePrediction),
          effort,
          trend.origin,
        ),
      db
        .prepare(
          `INSERT INTO decision_events (
            entity_type, entity_id, action, to_status, actor_label,
            rationale, immutable_snapshot
          ) VALUES ('idea', ?, 'created', 'review', ?, ?, ?)`,
        )
        .bind(
          id,
          actorFromRequest(request),
          `Créée depuis la tendance « ${trend.title} »`,
          JSON.stringify(immutablePrediction),
        ),
    ]);

    return Response.json({ id, priority, confidence }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
