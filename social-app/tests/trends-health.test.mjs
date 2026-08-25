import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTrendHealth,
  validateDiscoveryAudit,
} from "../scripts/check-trends-health.mjs";
import { isTrendEditorialScanLate } from "../lib/trend-health.ts";

const checkedAt = "2026-08-21T12:00:00.000Z";
const freshCapturedAt = "2026-08-21T10:00:00.000Z";

function healthyStatus() {
  return {
    status: "success",
    discoveryAudit: {
      scannedAt: freshCapturedAt,
      complete: true,
      candidateCount: 72,
      qualifiedInventoryCount: 55,
      added: 17,
      removed: 3,
      retained: 55,
    },
  };
}

function inventory(count = 55) {
  return Array.from({ length: count }, (_value, index) => ({ id: `trend-${index}` }));
}

test("editorial scan freshness turns late strictly after 26 hours", () => {
  assert.equal(
    isTrendEditorialScanLate("2026-08-20T10:00:00.000Z", checkedAt),
    false,
  );
  assert.equal(
    isTrendEditorialScanLate("2026-08-20T09:59:59.999Z", checkedAt),
    true,
  );
  assert.equal(isTrendEditorialScanLate("invalid", checkedAt), true);
});

test("health requires a recent discovery audit and at least 50 candidates and qualified trends", () => {
  assert.deepEqual(validateDiscoveryAudit(healthyStatus().discoveryAudit, checkedAt), []);
  assert.match(validateDiscoveryAudit(null, checkedAt).join(" "), /absent/i);
  assert.match(
    validateDiscoveryAudit({
      scannedAt: "2026-08-19T00:00:00.000Z",
      complete: false,
      candidateCount: 49,
      qualifiedInventoryCount: 49,
      added: 0,
      removed: 0,
      retained: 49,
    }, checkedAt).join(" "),
    /incomplet.*dépasse 26 h.*candidateCount.*qualifiedInventoryCount/i,
  );
});

test("asset-only refreshes cannot make a trend feed healthy", () => {
  const result = evaluateTrendHealth({
    key: "audio",
    label: "Trends audio",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: {
      status: "degraded",
      published: true,
      coverage: { thumbnailPublishable: true },
    },
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /discoveryAudit absent/i);
});

test("fresh feed and complete discovery audit are healthy", () => {
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: healthyStatus(),
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.candidatePoolChanges, {
    added: 17,
    removed: 3,
    retained: 55,
    changed: true,
  });
});

test("a candidate scan cannot impersonate the qualified published feed", () => {
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status: {
      ...healthyStatus(),
      status: "degraded",
      discoveryAudit: {
        ...healthyStatus().discoveryAudit,
        scannedAt: "2026-08-21T11:00:00.000Z",
      },
    },
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(
    result.issues.join(" "),
    /refresh vidéo n'est pas publié.*capturedAt ne correspond pas au scan qualifié publié/i,
  );
});

test("an unchanged but fully qualified candidate pool remains honest and healthy", () => {
  const status = healthyStatus();
  status.discoveryAudit = {
    ...status.discoveryAudit,
    candidateCount: 55,
    added: 0,
    removed: 0,
    retained: 55,
  };
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status,
  }, checkedAt);
  assert.equal(result.healthy, true);
  assert.equal(result.candidatePoolChanges?.changed, false);
});

test("candidate pool deltas must reconcile with the audited candidate count", () => {
  const status = healthyStatus();
  status.discoveryAudit = {
    ...status.discoveryAudit,
    candidateCount: 70,
  };
  const result = evaluateTrendHealth({
    key: "video",
    label: "Trends vidéos",
    feed: { capturedAt: freshCapturedAt, trends: inventory() },
    status,
  }, checkedAt);
  assert.equal(result.healthy, false);
  assert.match(result.issues.join(" "), /added \+ retained.*candidateCount/i);
});
