import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInstagramProfileListing,
  preserveCertifiedInstagramCoverage,
} from "../scripts/instagram-public-profile-guard.mjs";

test("rejects a zero listing and leaves existing Instagram history untouched", () => {
  const snapshot = {
    posts: [
      { platform: "instagram", externalId: "old-a" },
      { platform: "x", externalId: "x-a" },
    ],
    coverage: [
      { platform: "instagram", status: "partial-public-profile", itemCount: 1 },
    ],
  };
  const before = structuredClone(snapshot);

  assert.throws(
    () => assertInstagramProfileListing({ listed: 0, snapshot }),
    /returned 0 posts.*existing history and coverage were preserved/i,
  );
  assert.deepEqual(snapshot, before);
});

test("rejects a zero listing when a complete coverage record exists", () => {
  const snapshot = {
    posts: [],
    coverage: [
      { platform: "instagram", status: "complete-public-profile", itemCount: 1676 },
    ],
  };

  assert.throws(
    () => assertInstagramProfileListing({ listed: 0, snapshot }),
    /coverage status=complete-public-profile/i,
  );
});

test("never treats an empty public profile result as a successful collection", () => {
  assert.throws(
    () => assertInstagramProfileListing({ listed: 0, snapshot: { posts: [], coverage: [] } }),
    /collection refused/i,
  );
});

test("accepts a non-empty Instagram listing", () => {
  assert.doesNotThrow(() => assertInstagramProfileListing({
    listed: 1676,
    snapshot: {
      posts: [{ platform: "instagram", externalId: "old-a" }],
      coverage: [{ platform: "instagram", status: "complete-public-profile", itemCount: 1676 }],
    },
  }));
});

test("rejects malformed listing counts", () => {
  assert.throws(
    () => assertInstagramProfileListing({ listed: Number.NaN, snapshot: {} }),
    /invalid Instagram listing count/i,
  );
});

test("does not downgrade a certified Instagram coverage record", () => {
  const certified = {
    platform: "instagram",
    status: "complete-public-profile",
    itemCount: 1676,
    scope: "certified manifest",
    limitations: ["Only public posts are included."],
  };
  const partial = {
    platform: "instagram",
    status: "partial-public-profile",
    itemCount: 1676,
    scope: "public profile",
    limitations: ["Only the current profile window was visible."],
  };

  assert.strictEqual(preserveCertifiedInstagramCoverage(certified, partial), certified);
});

test("keeps certification while extending its count with a newly observed post", () => {
  const certified = {
    platform: "instagram",
    accountUrl: "https://www.instagram.com/lofigirl/",
    status: "complete-public-profile",
    itemCount: 1676,
    scope: "certified manifest",
    limitations: ["Only public posts are included."],
  };
  const incremental = {
    platform: "instagram",
    accountUrl: "https://www.instagram.com/lofigirl/",
    status: "partial-public-profile",
    itemCount: 1677,
    scope: "public profile",
    newestPublishedAt: "2026-08-06T00:00:00.000Z",
    limitations: ["Only the current profile window was visible."],
  };

  assert.deepEqual(preserveCertifiedInstagramCoverage(certified, incremental), {
    ...incremental,
    status: certified.status,
    scope: certified.scope,
    limitations: certified.limitations,
  });
});
