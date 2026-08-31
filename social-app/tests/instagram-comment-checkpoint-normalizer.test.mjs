import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeInstagramCheckpoint,
  reconcileCaptureWithExistingHistory,
} from "../scripts/normalize_instagram_comment_checkpoint.mjs";

function fixture() {
  return {
    platform: "instagram",
    capturedAt: "2026-08-31T08:53:49.414Z",
    comments: [
      {
        ownComments: [
          { age: "0h", text: "first exact comment" },
          { age: "1d", text: "second exact comment" },
        ],
        targetAge: "1d",
        targetAuthor: "creator",
        targetText: "Real target title",
        thumbnailUrl: "https://scontent.cdninstagram.com/v/media_123.jpg?expires=soon",
        passes: ["newest"],
        firstSeenIteration: 0,
        lastSeenIteration: 17,
      },
      {
        ownComments: [{ age: "37w", text: "oldest exact comment" }],
        targetAge: "37w",
        targetAuthor: "lofigirl",
        targetText: null,
        thumbnailUrl: "https://scontent.cdninstagram.com/v/media_999.webp?expires=soon",
        url: "https://www.instagram.com/p/ABC_123?igsh=test",
        shortcode: "ABC_123",
        passes: ["oldest"],
        firstSeenIteration: 18,
        lastSeenIteration: 21,
      },
      {
        ownComments: [{
          age: "0h",
          text: "first exact comment",
          metrics: { likes: 12, replies: 3 },
        }],
        targetAge: "1d",
        targetAuthor: "creator",
        targetText: "Real target title",
        thumbnailUrl: "https://scontent.cdninstagram.com/v/media_123.jpg?different=query",
        passes: ["newest-delta"],
        firstSeenIteration: 22,
        lastSeenIteration: 22,
      },
    ],
    scrollLog: [
      ...[15, 16, 17].map((iteration) => ({
        pass: "newest",
        iteration,
        visible: 100,
        added: 0,
        total: 100,
        scrollTop: 900,
        scrollHeight: 1_000,
      })),
      ...[19, 20, 21].map((iteration) => ({
        pass: "oldest",
        iteration,
        visible: 30,
        added: 0,
        total: 130,
        scrollTop: 900,
        scrollHeight: 1_000,
      })),
      {
        pass: "newest-delta",
        iteration: 22,
        visible: 3,
        added: 1,
        total: 131,
        note: "delta",
      },
    ],
  };
}

function addContinuousAllTimeEvidence(checkpoint) {
  checkpoint.allTimeEndReached = true;
  checkpoint.completionProof = {
    allTimeSelected: true,
    boundaryReached: true,
    cursorExhausted: true,
    boundaryStallCount: 3,
    stableReconciliationPasses: 2,
  };
  for (let week = 4; week <= 36; week += 4) {
    checkpoint.comments.push({
      ownComments: [{ age: `${week}w`, text: `continuity comment ${week}` }],
      targetAge: `${week}w`,
      targetAuthor: `creator${week}`,
      targetText: `Continuity target ${week}`,
      thumbnailUrl: `https://scontent.cdninstagram.com/v/media_${week}.jpg`,
      passes: ["oldest"],
      firstSeenIteration: 18,
      lastSeenIteration: 21,
    });
  }
  return checkpoint;
}

test("normalizes and deduplicates individual authored comments with stable synthetic IDs", () => {
  const first = normalizeInstagramCheckpoint(fixture());
  const second = normalizeInstagramCheckpoint(fixture());

  assert.equal(first.capture.comments.length, 3);
  assert.equal(first.manifest.recordCount, 3);
  assert.equal(first.manifest.rawIndividualObservationCount, 4);
  assert.equal(first.manifest.deduplicatedExactObservationCount, 1);
  assert.equal(first.manifest.sourceCardCount, 3);
  assert.equal(new Set(first.capture.comments.map((comment) => comment.id)).size, 3);
  assert.deepEqual(
    first.capture.comments.map((comment) => comment.id),
    second.capture.comments.map((comment) => comment.id),
  );
  assert.equal(first.manifest.identity.duplicateOrdinalApplied, 0);
  assert.ok(first.capture.comments.every((comment) => comment.idKind === "synthetic"));
  assert.ok(first.capture.comments.every((comment) => comment.publishedAt != null));
  assert.ok(first.capture.comments.every((comment) => comment.publishedAtPrecision === "approximate"));
  assert.ok(first.capture.comments.every((comment) => comment.observation.observedAt === fixture().capturedAt));
  const measured = first.capture.comments.find((comment) => comment.text === "first exact comment");
  assert.deepEqual(measured.metrics, { likes: 12, replies: 3 });
  assert.ok(first.capture.comments.filter((comment) => comment !== measured).every(
    (comment) => comment.metrics.likes === null && comment.metrics.replies === null,
  ));
  assert.doesNotMatch(first.manifest.identity.keyParts.join(" "), /relativeAge/u);
});

test("keeps a synthetic identity stable while Instagram's relative age changes", () => {
  const firstFixture = fixture();
  const nextFixture = fixture();
  nextFixture.capturedAt = "2026-09-01T08:53:49.414Z";
  nextFixture.comments[0].ownComments[0].age = "1d";

  const first = normalizeInstagramCheckpoint(firstFixture).capture.comments.find(
    (comment) => comment.text === "first exact comment",
  );
  const next = normalizeInstagramCheckpoint(nextFixture).capture.comments.find(
    (comment) => comment.text === "first exact comment",
  );

  assert.equal(first.id, next.id);
  assert.equal(first.publishedAt, next.publishedAt);
});

test("accepts older month and year relative ages without inventing exact precision", () => {
  const checkpoint = fixture();
  checkpoint.comments[1].ownComments[0].age = "1y";
  const { capture } = normalizeInstagramCheckpoint(checkpoint);
  const old = capture.comments.find((comment) => comment.text === "oldest exact comment");

  assert.equal(old.publishedAtPrecision, "approximate");
  assert.equal(old.observation.relativeAge, "1y");
  assert.match(old.publishedAt, /^2025-/u);
});

test("keeps only proven permalinks and marks every other target unavailable", () => {
  const { capture, manifest } = normalizeInstagramCheckpoint(fixture());
  const available = capture.comments.filter((comment) => comment.url != null);
  const unavailable = capture.comments.filter((comment) => comment.url == null);

  assert.equal(available.length, 1);
  assert.equal(available[0].url, "https://www.instagram.com/p/ABC_123/");
  assert.equal(available[0].target.url, available[0].url);
  assert.equal(available[0].target.contentId, "ABC_123");
  assert.equal(available[0].target.unavailable, false);
  assert.equal(available[0].target.title, "Publication Instagram de @lofigirl (texte cible non fourni)");
  assert.ok(unavailable.every((comment) => comment.target.unavailable === true));
  assert.ok(unavailable.every((comment) => comment.target.status === "unavailable"));
  assert.ok(unavailable.every((comment) => !("url" in comment.target)));
  assert.equal(manifest.coverage.permalink.covered, 1);
  assert.equal(manifest.coverage.permalink.total, 3);
  assert.equal(
    capture.activitySourceUrl,
    "https://www.instagram.com/your_activity/interactions/comments/",
  );
});

test("records scroll stalls without confusing a chronology gap with a complete inventory", () => {
  const { manifest, capture } = normalizeInstagramCheckpoint(fixture());

  assert.equal(manifest.inventoryStatus, "partial");
  assert.equal(manifest.endReached, false);
  assert.deepEqual(manifest.issues, ["relative-age-gap", "all-time-end-not-proven"]);
  assert.deepEqual(manifest.relativeAgeRange, {
    newestRelativeAge: "0h",
    oldestRelativeAge: "37w",
  });
  assert.deepEqual(manifest.completionEvidence.newest.stallIterations, [15, 16, 17]);
  assert.deepEqual(manifest.completionEvidence.oldest.stallIterations, [19, 20, 21]);
  assert.equal(manifest.completionEvidence.recentDelta.iteration, 22);
  assert.deepEqual(manifest.relativeAgeContinuity.gaps, [
    { fromWeek: 1, toWeek: 36 },
  ]);
  assert.equal(capture.inventory.recordCount, capture.comments.length);
});

test("keeps a hidden-thread inventory partial when its expansion audit fails", () => {
  const checkpoint = fixture();
  checkpoint.comments[0].rawText = "Target caption\nView entire thread";
  const threadExpansionAudit = {
    platform: "instagram",
    attemptedAt: "2026-08-31T09:46:57.278Z",
    source: "Instagram comments activity",
    status: "partial",
    identifiedThreadCards: 1,
    attemptedThreadCards: 1,
    expandedThreadCards: 0,
    failedThreadCards: 1,
    notAttemptedThreadCards: 0,
    newAuthoredComments: 0,
    failure: "The native thread route had no verifiable shortcode.",
    canonicalExportStatus: "not_available_in_this_pass",
    endReached: false,
    inventoryStatus: "partial",
  };
  const { manifest, capture } = normalizeInstagramCheckpoint(checkpoint, {
    threadExpansionAudit,
  });

  assert.equal(manifest.inventoryStatus, "partial");
  assert.equal(manifest.endReached, false);
  assert.deepEqual(manifest.issues, [
    "hidden-threads-not-exhausted",
    "thread-expansion-audit-partial",
    "relative-age-gap",
    "all-time-end-not-proven",
  ]);
  assert.equal(manifest.threadExpansionAudit.identifiedThreadCards, 1);
  assert.equal(manifest.threadExpansionAudit.failure, threadExpansionAudit.failure);
  assert.equal(capture.inventory.inventoryStatus, "partial");
  assert.equal(capture.inventory.endReached, false);
  assert.equal(capture.comments.length, 3);
});

test("accepts a complete audit for every identified hidden thread", () => {
  const checkpoint = addContinuousAllTimeEvidence(fixture());
  checkpoint.comments[0].rawText = "Target caption\nView entire thread";
  const { manifest } = normalizeInstagramCheckpoint(checkpoint, {
    threadExpansionAudit: {
      platform: "instagram",
      attemptedAt: "2026-08-31T10:00:00.000Z",
      status: "complete",
      identifiedThreadCards: 1,
      attemptedThreadCards: 1,
      expandedThreadCards: 1,
      failedThreadCards: 0,
      notAttemptedThreadCards: 0,
      newAuthoredComments: 1,
      failure: null,
      endReached: true,
      inventoryStatus: "complete",
    },
  });

  assert.equal(manifest.inventoryStatus, "complete");
  assert.equal(manifest.endReached, true);
  assert.deepEqual(manifest.issues, []);
});

test("refuses a claimed All time end without a closed completion proof", () => {
  const checkpoint = addContinuousAllTimeEvidence(fixture());
  delete checkpoint.completionProof;
  const { manifest } = normalizeInstagramCheckpoint(checkpoint);

  assert.equal(manifest.inventoryStatus, "partial");
  assert.equal(manifest.endReached, false);
  assert.ok(manifest.issues.includes("completion-proof-missing"));
});

test("a complete thread audit must account for every hidden thread", () => {
  const checkpoint = addContinuousAllTimeEvidence(fixture());
  checkpoint.comments[0].rawText = "Target caption\nVoir tout le fil";
  const { manifest } = normalizeInstagramCheckpoint(checkpoint, {
    threadExpansionAudit: {
      platform: "instagram",
      attemptedAt: "2026-08-31T10:00:00.000Z",
      status: "complete",
      identifiedThreadCards: 1,
      attemptedThreadCards: 1,
      expandedThreadCards: 0,
      failedThreadCards: 0,
      notAttemptedThreadCards: 0,
      newAuthoredComments: 0,
      failure: null,
      endReached: true,
      inventoryStatus: "complete",
    },
  });

  assert.equal(manifest.inventoryStatus, "partial");
  assert.ok(manifest.issues.includes("hidden-threads-not-exhausted"));
});

test("an explicitly partial zero-thread audit cannot be promoted to complete", () => {
  const checkpoint = addContinuousAllTimeEvidence(fixture());
  const { manifest } = normalizeInstagramCheckpoint(checkpoint, {
    threadExpansionAudit: {
      platform: "instagram",
      attemptedAt: "2026-08-31T10:00:00.000Z",
      status: "partial",
      identifiedThreadCards: 0,
      attemptedThreadCards: 0,
      expandedThreadCards: 0,
      failedThreadCards: 0,
      notAttemptedThreadCards: 0,
      newAuthoredComments: 0,
      failure: "La détection native n’a pas pu être prouvée.",
      endReached: false,
      inventoryStatus: "partial",
    },
  });

  assert.equal(manifest.inventoryStatus, "partial");
  assert.ok(manifest.issues.includes("thread-expansion-audit-partial"));
});

function existingPost({
  externalId,
  text,
  authorHandle,
  contentId,
  title = "Historical caption",
  url = "https://www.instagram.com/p/HISTORICAL/",
}) {
  return {
    platform: "instagram",
    format: "comment",
    externalId,
    text,
    title,
    url,
    raw: {
      commentTarget: { authorHandle, contentId, title, url },
    },
  };
}

test("pre-reconciles one exact text/author row only with independent target proof", () => {
  const { capture } = normalizeInstagramCheckpoint(fixture());
  const history = {
    posts: [
      existingPost({
        externalId: "comment:18123456789012345",
        text: "first exact comment",
        authorHandle: "creator",
        contentId: "media_123",
        title: "creator Different caption",
      }),
    ],
  };
  const reconciled = reconcileCaptureWithExistingHistory(capture, history);

  assert.equal(reconciled.report.matchedCount, 1);
  assert.equal(reconciled.report.newCount, 2);
  assert.equal(reconciled.comments[0].id, "18123456789012345");
  assert.equal(reconciled.comments[0].idKind, "native");
  assert.deepEqual(
    reconciled.comments[0].observation.existingHistoryMatch.proofs,
    ["thumbnail-asset-fingerprint"],
  );
});

test("does not match without target proof and fails closed on ambiguity", () => {
  const { capture } = normalizeInstagramCheckpoint(fixture());
  const originalId = capture.comments[0].id;
  const noProof = reconcileCaptureWithExistingHistory(capture, {
    posts: [
      existingPost({
        externalId: "comment:ig-no-proof",
        text: "first exact comment",
        authorHandle: "creator",
        contentId: "different_asset",
        title: "creator Different caption",
      }),
    ],
  });
  assert.equal(noProof.report.matchedCount, 0);
  assert.equal(noProof.comments[0].id, originalId);

  assert.throws(
    () =>
      reconcileCaptureWithExistingHistory(capture, {
        posts: [
          existingPost({
            externalId: "comment:ig-ambiguous-a",
            text: "first exact comment",
            authorHandle: "creator",
            contentId: "media_123",
          }),
          existingPost({
            externalId: "comment:ig-ambiguous-b",
            text: "first exact comment",
            authorHandle: "creator",
            contentId: "media_123",
          }),
        ],
      }),
    /ambigu/u,
  );
});

test("accepts a canonical Instagram permalink match and preserves synthetic ID kind", () => {
  const { capture } = normalizeInstagramCheckpoint(fixture());
  const permalinkComment = capture.comments.find((comment) => comment.url != null);
  const result = reconcileCaptureWithExistingHistory(
    { ...capture, comments: [permalinkComment] },
    {
      posts: [
        existingPost({
          externalId: "comment:ig-permalink-match",
          text: "oldest exact comment",
          authorHandle: "lofigirl",
          contentId: "different_asset",
          title: "lofigirl",
          url: "https://www.instagram.com/lofigirl/reel/ABC_123/",
        }),
      ],
    },
  );

  assert.equal(result.report.matchedCount, 1);
  assert.equal(result.comments[0].id, "ig-permalink-match");
  assert.equal(result.comments[0].idKind, "synthetic");
  assert.deepEqual(
    result.comments[0].observation.existingHistoryMatch.proofs,
    ["canonical-permalink-shortcode"],
  );
});
