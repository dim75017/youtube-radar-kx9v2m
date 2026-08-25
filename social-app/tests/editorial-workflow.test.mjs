import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPreferenceLearning,
  feedbackForIdea,
  findNextPlanningDate,
  normalizeWorkflowState,
  scheduleAcceptedIdea,
  updateScheduledDate,
} from "../lib/editorial-workflow.ts";

function idea(overrides = {}) {
  return {
    id: "idea-youtube-01",
    title: "La petite victoire du soir",
    pattern: "relatable_humour",
    primaryPlatform: "youtube",
    platformRank: 1,
    potentialScore: 78,
    seedPosts: [],
    observedSignal: { summary: "Signal", evidence: [] },
    proposedFormat: "Short vertical de 12 secondes",
    hook: "Quand tu coches enfin la dernière tâche.",
    platformAdaptations: {
      youtube: { format: "Short", execution: "Une boucle verticale." },
      instagram: { format: "Reel", execution: "Une boucle verticale." },
      tiktok: { format: "Vidéo", execution: "Une boucle verticale." },
      x: { format: "Image", execution: "Un arrêt sur image." },
    },
    confidence: "high",
    confidenceScore: 80,
    confidenceRationale: "Test prioritaire.",
    limits: ["Hypothèse."],
    assetPolicy: "official-assets-only",
    ...overrides,
  };
}

test("accepted concepts lift similar ideas without learning a platform preference", () => {
  const accepted = idea({ id: "accepted", potentialScore: 70 });
  const rejected = idea({
    id: "rejected",
    primaryPlatform: "x",
    pattern: "activation",
    proposedFormat: "Post texte",
  });
  const feedback = {
    accepted: feedbackForIdea(accepted, "produce", "2026-08-06T10:00:00.000Z"),
    rejected: feedbackForIdea(rejected, "discard", "2026-08-06T11:00:00.000Z"),
  };
  const [learned] = applyPreferenceLearning(
    [idea({ id: "candidate", potentialScore: 78 })],
    feedback,
  );

  assert.ok(learned.learnedPotentialScore > 78);
  assert.ok(learned.learningDelta <= 12);
  assert.match(learned.learningExplanation, /acceptées/i);
});

test("automatically schedules accepted ideas in the next collision-free slot", () => {
  const first = scheduleAcceptedIdea(
    idea(),
    [],
    "2026-08-06T12:00:00.000Z",
  );
  const second = scheduleAcceptedIdea(
    idea({ id: "idea-youtube-02", title: "Deuxième idée" }),
    [first],
    "2026-08-06T12:00:00.000Z",
  );
  const instagram = scheduleAcceptedIdea(
    idea({ id: "idea-instagram-01", primaryPlatform: "instagram" }),
    [first, second],
    "2026-08-06T12:00:00.000Z",
  );

  assert.equal(first.scheduledFor, "2026-08-07");
  assert.equal(second.scheduledFor, "2026-08-08");
  assert.equal(instagram.scheduledFor, "2026-08-09");
  assert.equal(findNextPlanningDate([first, second, instagram], "2026-08-06"), "2026-08-10");
});

test("a planned idea can be moved and malformed persisted data is ignored", () => {
  const planned = scheduleAcceptedIdea(idea(), [], "2026-08-06T12:00:00.000Z");
  const moved = updateScheduledDate(
    [planned],
    planned.ideaId,
    "2026-08-12",
    "2026-08-06T13:00:00.000Z",
  );
  const normalized = normalizeWorkflowState({
    feedback: { broken: { decision: "maybe" } },
    schedule: [...moved, { id: "broken" }],
  });

  assert.equal(moved[0].scheduledFor, "2026-08-12");
  assert.deepEqual(normalized.feedback, {});
  assert.equal(normalized.schedule.length, 1);
});

test("rescheduling refuses malformed dates and any editorial collision", () => {
  const first = scheduleAcceptedIdea(idea(), [], "2026-08-06T12:00:00.000Z");
  const second = scheduleAcceptedIdea(
    idea({ id: "idea-youtube-02" }),
    [first],
    "2026-08-06T12:00:00.000Z",
  );

  assert.throws(
    () => updateScheduledDate([first, second], second.ideaId, first.scheduledFor),
    /publication est déjà/i,
  );
  assert.throws(
    () => updateScheduledDate([first], first.ideaId, "2026-99-99"),
    /AAAA-MM-JJ/i,
  );
});
