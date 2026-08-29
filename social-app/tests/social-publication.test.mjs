import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PUBLICATION_QUEUE,
  approvePublicationPlan,
  findPublicationScheduleCollision,
  markPublicationPlanScheduled,
  mergeScheduledIdeasIntoPublicationQueue,
  normalizePublicationQueue,
  publicationPlanFromScheduledIdea,
  publicationReadinessIssues,
  revokePublicationPlan,
  sortedPublicationPlans,
  updatePublicationPlan,
} from "../lib/social-publication.ts";

const NOW = "2026-08-29T10:00:00.000Z";

function scheduled(overrides = {}) {
  return {
    id: "schedule:idea-01",
    ideaId: "idea-01",
    title: "Late night study loop",
    hook: "one more page, then sleep",
    platform: "instagram",
    format: "Reel",
    scheduledFor: "2026-09-05",
    status: "planned",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("a validated editorial idea becomes a publication draft, not an authorization to post", () => {
  const plan = publicationPlanFromScheduledIdea(scheduled(), NOW);
  assert.equal(plan.status, "draft");
  assert.equal(plan.approvedRevision, null);
  assert.deepEqual(plan.platforms, ["instagram"]);
  assert.equal(plan.publishAtLocal, "2026-09-05T18:00");
  assert.equal(plan.caption, "one more page, then sleep");
  assert.match(publicationReadinessIssues(plan, NOW).join(" "), /média final/i);
});

test("approval freezes the exact revision and any edit invalidates it", () => {
  const draft = updatePublicationPlan(
    publicationPlanFromScheduledIdea(scheduled(), NOW),
    {
      mediaUrl: "https://media.example/lofi-reel.mp4",
      platforms: ["x", "instagram", "instagram"],
    },
    "2026-08-29T10:05:00.000Z",
  );
  assert.deepEqual(draft.platforms, ["instagram", "x"]);
  const approved = approvePublicationPlan(draft, NOW);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedRevision, approved.revision);

  const edited = updatePublicationPlan(
    approved,
    { caption: `${approved.caption} ☕` },
    "2026-08-29T10:10:00.000Z",
  );
  assert.equal(edited.status, "draft");
  assert.equal(edited.approvedRevision, null);
  assert.equal(edited.revision, approved.revision + 1);
  assert.throws(() => markPublicationPlanScheduled(edited, NOW), /Valide cette version exacte/i);
});

test("only an approved future payload can enter the local schedule", () => {
  const draft = updatePublicationPlan(
    publicationPlanFromScheduledIdea(scheduled({ platform: "x" }), NOW),
    { platforms: ["x"], caption: "focus mode: still loading" },
    NOW,
  );
  assert.deepEqual(publicationReadinessIssues(draft, NOW), []);
  const scheduledPlan = markPublicationPlanScheduled(
    approvePublicationPlan(draft, NOW),
    NOW,
  );
  assert.equal(scheduledPlan.status, "scheduled");

  const past = updatePublicationPlan(
    scheduledPlan,
    { publishAtLocal: "2026-08-28T18:00" },
    NOW,
  );
  assert.match(publicationReadinessIssues(past, NOW).join(" "), /futures/i);

  const revoked = revokePublicationPlan(scheduledPlan, NOW);
  assert.equal(revoked.status, "draft");
  assert.equal(revoked.approvedRevision, null);
  assert.equal(revoked.revision, scheduledPlan.revision + 1);

  const conflicting = {
    ...scheduledPlan,
    id: "publication-plan:idea-02",
    ideaId: "idea-02",
  };
  assert.equal(
    findPublicationScheduleCollision(conflicting, {
      version: 1,
      plans: { [scheduledPlan.ideaId]: scheduledPlan },
    })?.ideaId,
    scheduledPlan.ideaId,
  );

  const normalizedCollision = normalizePublicationQueue({
    version: 1,
    plans: {
      [scheduledPlan.ideaId]: scheduledPlan,
      [conflicting.ideaId]: conflicting,
    },
    tombstones: {},
  });
  assert.equal(normalizedCollision.plans[scheduledPlan.ideaId].status, "draft");
  assert.equal(normalizedCollision.plans[conflicting.ideaId].status, "draft");
  assert.equal(normalizedCollision.plans[scheduledPlan.ideaId].approvedRevision, null);
  assert.equal(normalizedCollision.plans[conflicting.ideaId].approvedRevision, null);
});

test("schedule merging is idempotent and malformed saved entries are discarded", () => {
  const first = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled(), scheduled({ ideaId: "idea-02", id: "schedule:idea-02", scheduledFor: "2026-09-06" })],
    EMPTY_PUBLICATION_QUEUE,
    NOW,
  );
  const second = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled(), scheduled({ ideaId: "idea-02", id: "schedule:idea-02", scheduledFor: "2026-09-06" })],
    first,
    NOW,
  );
  assert.equal(second, first);
  assert.deepEqual(sortedPublicationPlans(first).map((item) => item.ideaId), ["idea-01", "idea-02"]);

  const pruned = mergeScheduledIdeasIntoPublicationQueue([scheduled()], first, NOW);
  assert.deepEqual(Object.keys(pruned.plans), ["idea-01"]);

  const normalized = normalizePublicationQueue({
    version: 99,
    plans: { valid: first.plans["idea-01"], broken: { ideaId: "broken" } },
  });
  assert.deepEqual(Object.keys(normalized.plans), ["idea-01"]);
  assert.equal(normalized.version, 1);

  const tampered = normalizePublicationQueue({
    version: 1,
    plans: {
      unsafe: { ...first.plans["idea-01"], status: "approved", approvedRevision: null },
    },
  });
  assert.deepEqual(tampered.plans, {});

  const impossible = normalizePublicationQueue({
    version: 1,
    plans: {
      unsafe: {
        ...first.plans["idea-01"],
        status: "scheduled",
        approvedRevision: first.plans["idea-01"].revision,
        platforms: [],
      },
    },
  });
  assert.deepEqual(impossible.plans, {});
});

test("published editorial items are excluded and cannot re-enter the publication queue", () => {
  const draftQueue = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled()],
    EMPTY_PUBLICATION_QUEUE,
    NOW,
  );
  const published = scheduled({ status: "published" });

  assert.throws(
    () => publicationPlanFromScheduledIdea(published, NOW),
    /déjà publiée/i,
  );
  const removed = mergeScheduledIdeasIntoPublicationQueue([published], draftQueue, NOW);
  assert.deepEqual(removed.plans, {});
  assert.equal(removed.tombstones["idea-01"], NOW);

  const staleTabMerge = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled({ updatedAt: NOW })],
    removed,
    "2026-08-30T12:00:00.000Z",
  );
  assert.deepEqual(staleTabMerge.plans, {});
  assert.equal(staleTabMerge.tombstones["idea-01"], NOW);

  const revalidated = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled({ updatedAt: "2026-08-31T12:00:00.000Z" })],
    removed,
    "2026-08-31T12:00:00.000Z",
  );
  assert.equal(revalidated.plans["idea-01"].status, "draft");
  assert.equal(revalidated.tombstones["idea-01"], undefined);

  const publishedWithoutSavedPlan = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled({
      status: "published",
      updatedAt: "2026-08-29T09:00:00-05:00",
    })],
    EMPTY_PUBLICATION_QUEUE,
    NOW,
  );
  assert.equal(publishedWithoutSavedPlan.tombstones["idea-01"], "2026-08-29T14:00:00.000Z");
  const offsetSafe = mergeScheduledIdeasIntoPublicationQueue(
    [scheduled({ updatedAt: "2026-08-29T12:00:00.000Z" })],
    publishedWithoutSavedPlan,
    NOW,
  );
  assert.deepEqual(offsetSafe.plans, {});

  const contradictoryStorage = normalizePublicationQueue({
    version: 1,
    plans: draftQueue.plans,
    tombstones: { "idea-01": "2026-08-29T14:00:00.000Z" },
  });
  assert.deepEqual(contradictoryStorage.plans, {});
});

test("revoking then revalidating an idea never restores an old approved payload", () => {
  const originalSchedule = scheduled();
  const original = publicationPlanFromScheduledIdea(originalSchedule, NOW);
  const approved = approvePublicationPlan(
    updatePublicationPlan(original, { mediaUrl: "https://media.example/old.mp4" }, NOW),
    NOW,
  );
  const revalidatedSchedule = scheduled({
    createdAt: "2026-08-30T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
    hook: "new exact copy",
  });
  const queue = mergeScheduledIdeasIntoPublicationQueue(
    [revalidatedSchedule],
    { version: 1, plans: { [approved.ideaId]: approved } },
    "2026-08-30T08:00:00.000Z",
  );
  assert.equal(queue.plans[approved.ideaId].status, "draft");
  assert.equal(queue.plans[approved.ideaId].approvedRevision, null);
  assert.equal(queue.plans[approved.ideaId].caption, "new exact copy");
});

test("any authoritative source change resets an approved local payload", () => {
  const original = publicationPlanFromScheduledIdea(scheduled(), NOW);
  const approved = approvePublicationPlan(
    updatePublicationPlan(original, { mediaUrl: "https://media.example/old.mp4" }, NOW),
    NOW,
  );
  const changedSource = scheduled({
    title: "Revised late night loop",
    scheduledFor: "2026-09-08",
    updatedAt: "2026-08-30T08:00:00.000Z",
  });
  const queue = mergeScheduledIdeasIntoPublicationQueue(
    [changedSource],
    { version: 1, plans: { [approved.ideaId]: approved } },
    "2026-08-30T08:00:00.000Z",
  );

  assert.equal(queue.plans[approved.ideaId].status, "draft");
  assert.equal(queue.plans[approved.ideaId].title, "Revised late night loop");
  assert.equal(queue.plans[approved.ideaId].publishAtLocal, "2026-09-08T18:00");
});

test("an older workflow tab cannot overwrite a newer source revision", () => {
  const newerSchedule = scheduled({
    title: "New authoritative title",
    updatedAt: "2026-08-30T09:00:00.000Z",
  });
  const newerPlan = publicationPlanFromScheduledIdea(newerSchedule, "2026-08-30T09:00:00.000Z");
  const queue = { version: 1, plans: { [newerPlan.ideaId]: newerPlan } };
  const staleSchedule = scheduled({
    title: "Stale title",
    updatedAt: "2026-08-29T09:00:00.000Z",
  });

  const merged = mergeScheduledIdeasIntoPublicationQueue([staleSchedule], queue, NOW);
  assert.equal(merged, queue);
  assert.equal(merged.plans[newerPlan.ideaId].title, "New authoritative title");
});

test("media URLs with credentials, secrets, fragments or private hosts are rejected", () => {
  const base = publicationPlanFromScheduledIdea(scheduled(), NOW);
  for (const mediaUrl of [
    "https://user:password@media.example/video.mp4",
    "https://media.example/video.mp4?token=secret",
    "https://media.example/video.mp4#secret",
    "https://localhost/video.mp4",
    "https://192.168.1.10/video.mp4",
    "https://100.64.0.1/video.mp4",
    "https://224.0.0.1/video.mp4",
  ]) {
    const plan = updatePublicationPlan(base, { mediaUrl }, NOW);
    assert.match(publicationReadinessIssues(plan, NOW).join(" "), /sans identifiants ni paramètres/i);
  }
});

test("Europe Paris DST gaps and overlaps are rejected while a unique local time is accepted", () => {
  const base = publicationPlanFromScheduledIdea(scheduled({ platform: "x" }), "2026-01-01T00:00:00.000Z");
  const at = (publishAtLocal) => updatePublicationPlan(
    base,
    { platforms: ["x"], publishAtLocal },
    "2026-01-01T00:00:00.000Z",
  );

  assert.match(
    publicationReadinessIssues(at("2026-03-29T02:30"), "2026-01-01T00:00:00.000Z").join(" "),
    /valide et non ambiguë/i,
  );
  assert.match(
    publicationReadinessIssues(at("2026-10-25T02:30"), "2026-01-01T00:00:00.000Z").join(" "),
    /valide et non ambiguë/i,
  );
  assert.deepEqual(
    publicationReadinessIssues(at("2026-03-29T03:30"), "2026-01-01T00:00:00.000Z"),
    [],
  );
});
