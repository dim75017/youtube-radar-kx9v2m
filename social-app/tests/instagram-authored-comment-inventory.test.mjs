import assert from "node:assert/strict";
import test from "node:test";

import {
  assessInstagramInventoryCompletion,
  assertDedicatedInstagramProfilePath,
  extractClosedInstagramComments,
  extractPaginationEvidence,
  mergeInstagramInventory,
} from "../scripts/collect_instagram_authored_comment_inventory.mjs";

const capturedAt = "2026-08-31T15:00:00.000Z";

function payload({ id = "18010911389940269", text = "so fun 🤩", hasNext = false } = {}) {
  return {
    data: {
      activity: {
        page_info: { has_next_page: hasNext, end_cursor: hasNext ? "opaque-cursor" : null },
        items: [{
          media: {
            code: "Dci0yH9OU32",
            product_type: "clips",
            caption: { text: "Target caption" },
            user: { username: "creator", full_name: "Creator" },
            image_versions2: {
              candidates: [{ url: "https://scontent.cdninstagram.com/v/thumb.jpg" }],
            },
          },
          comment: {
            pk: id,
            text,
            created_at_utc: 1_777_000_000,
            user: { username: "lofigirl" },
            comment_like_count: 12,
            child_comment_count: 3,
          },
        }],
      },
    },
  };
}

test("extracts only the closed fields of an attributable native Lofi Girl comment", () => {
  const [comment] = extractClosedInstagramComments(payload(), capturedAt);
  assert.equal(comment.id, "18010911389940269");
  assert.equal(comment.idKind, "native");
  assert.equal(comment.url, "https://www.instagram.com/reel/Dci0yH9OU32/c/18010911389940269/");
  assert.equal(comment.target.url, "https://www.instagram.com/reel/Dci0yH9OU32/");
  assert.equal(comment.target.title, "Target caption");
  assert.equal(comment.target.authorHandle, "creator");
  assert.equal(comment.target.thumbnailUrl, "https://scontent.cdninstagram.com/v/thumb.jpg");
  assert.equal(comment.text, "so fun 🤩");
  assert.equal(comment.metrics.likes, 12);
  assert.equal(comment.metrics.replies, 3);
  assert.equal(comment.observation.observedAt, capturedAt);
  assert.equal(JSON.stringify(comment).includes("opaque-cursor"), false);
});

test("rejects comments from another author or without a native ID, exact date or target", () => {
  const wrongAuthor = payload();
  wrongAuthor.data.activity.items[0].comment.user.username = "someone_else";
  const noId = payload();
  delete noId.data.activity.items[0].comment.pk;
  const noDate = payload();
  delete noDate.data.activity.items[0].comment.created_at_utc;
  const noTarget = payload();
  delete noTarget.data.activity.items[0].media.code;
  assert.deepEqual(extractClosedInstagramComments(wrongAuthor, capturedAt), []);
  assert.deepEqual(extractClosedInstagramComments(noId, capturedAt), []);
  assert.deepEqual(extractClosedInstagramComments(noDate, capturedAt), []);
  assert.deepEqual(extractClosedInstagramComments(noTarget, capturedAt), []);
});

test("pagination evidence hashes cursors and never returns their raw value", () => {
  const evidence = extractPaginationEvidence(payload({ hasNext: true }));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].hasNext, true);
  assert.match(evidence[0].cursorHash, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes("opaque-cursor"), false);
  assert.equal(extractPaginationEvidence(payload({ hasNext: false }))[0].hasNext, false);
});

test("native IDs merge idempotently, preserve real metrics and quarantine identity collisions", () => {
  const [first] = extractClosedInstagramComments(payload(), capturedAt);
  const next = structuredClone(first);
  next.metrics.likes = null;
  next.metrics.replies = 4;
  next.observation.observedAt = "2026-09-01T10:00:00.000Z";
  const merged = mergeInstagramInventory([first], [next]);
  assert.equal(merged.comments.length, 1);
  assert.equal(merged.comments[0].metrics.likes, 12);
  assert.equal(merged.comments[0].metrics.replies, 4);
  assert.equal(merged.collisions.length, 0);

  const conflicting = structuredClone(first);
  conflicting.text = "different text";
  const collision = mergeInstagramInventory([first], [conflicting]);
  assert.equal(collision.comments.length, 1);
  assert.deepEqual(collision.collisions, [{
    id: first.id,
    reason: "native-id-identity-conflict",
  }]);
});

test("completion requires All time, a real boundary, two stable passes and no unresolved work", () => {
  const complete = assessInstagramInventoryCompletion({
    allTimeSelected: true,
    boundaryReached: true,
    cursorExhausted: false,
    boundaryStallCount: 3,
    stableReconciliationPasses: 2,
    unresolvedThreadCount: 0,
    collisionCount: 0,
  });
  assert.equal(complete.inventoryStatus, "complete");
  assert.equal(complete.endReached, true);
  assert.deepEqual(complete.issues, []);

  for (const override of [
    { allTimeSelected: false },
    { boundaryReached: false },
    { cursorExhausted: false, boundaryStallCount: 2 },
    { stableReconciliationPasses: 1 },
    { unresolvedThreadCount: 1 },
    { collisionCount: 1 },
  ]) {
    const partial = assessInstagramInventoryCompletion({
      allTimeSelected: true,
      boundaryReached: true,
      cursorExhausted: true,
      boundaryStallCount: 3,
      stableReconciliationPasses: 2,
      unresolvedThreadCount: 0,
      collisionCount: 0,
      ...override,
    });
    assert.equal(partial.inventoryStatus, "partial");
    assert.equal(partial.endReached, false);
    assert.ok(partial.issues.length > 0);
  }
});

test("the browser profile cannot escape the dedicated private work directory", () => {
  assert.match(
    assertDedicatedInstagramProfilePath("work/owner-comments/browser-profiles/instagram"),
    /owner-comments[\\/]browser-profiles[\\/]instagram$/u,
  );
  assert.throws(
    () => assertDedicatedInstagramProfilePath("../Chrome/User Data"),
    /profil doit rester/u,
  );
  assert.throws(
    () => assertDedicatedInstagramProfilePath("work/owner-comments/browser-profiles"),
    /profil doit rester/u,
  );
});
