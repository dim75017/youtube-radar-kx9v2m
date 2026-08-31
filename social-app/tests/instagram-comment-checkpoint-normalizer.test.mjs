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
        ownComments: [{ age: "0h", text: "first exact comment" }],
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
  assert.ok(first.capture.comments.every((comment) => comment.publishedAt === null));
  assert.ok(first.capture.comments.every((comment) => comment.metrics.likes === null));
  assert.ok(first.capture.comments.every((comment) => comment.metrics.replies === null));
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

test("records the two completion stalls, the recent delta and the observed age range", () => {
  const { manifest, capture } = normalizeInstagramCheckpoint(fixture());

  assert.equal(manifest.inventoryStatus, "complete");
  assert.equal(manifest.endReached, true);
  assert.deepEqual(manifest.relativeAgeRange, {
    newestRelativeAge: "0h",
    oldestRelativeAge: "37w",
  });
  assert.deepEqual(manifest.completionEvidence.newest.stallIterations, [15, 16, 17]);
  assert.deepEqual(manifest.completionEvidence.oldest.stallIterations, [19, 20, 21]);
  assert.equal(manifest.completionEvidence.recentDelta.iteration, 22);
  assert.equal(capture.inventory.recordCount, capture.comments.length);
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
