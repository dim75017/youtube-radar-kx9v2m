import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertAudioTrendScanStatus,
  assertVideoTrendScanStatus,
  isScanLate,
} from "../lib/trend-scan-status.ts";

const [videoStatus, audioStatus] = await Promise.all([
  readFile(new URL("../data/trends/refresh-status.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/audio-trends/refresh-status.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("accepts the real daily video and audio discovery audits", () => {
  assert.equal(assertVideoTrendScanStatus(videoStatus).cadenceHours, 24);
  assert.ok(assertVideoTrendScanStatus(videoStatus).discoveryAudit.candidateCount >= 50);
  assert.ok(assertAudioTrendScanStatus(audioStatus).discoveryAudit.candidateCount >= 50);
});

test("rejects unsafe candidate links and impossible counters", () => {
  const unsafe = structuredClone(videoStatus);
  unsafe.discoveryAudit.candidateUrls = ["javascript:alert(1)"];
  assert.throws(() => assertVideoTrendScanStatus(unsafe), /invalide/i);

  const impossible = structuredClone(audioStatus);
  impossible.discoveryAudit.candidateCount = -1;
  assert.throws(() => assertAudioTrendScanStatus(impossible), /invalide/i);
});

test("the visible scan freshness boundary is 26 hours", () => {
  const scannedAt = "2026-08-25T06:00:00.000Z";
  assert.equal(isScanLate(scannedAt, Date.parse("2026-08-26T07:59:59.999Z")), false);
  assert.equal(isScanLate(scannedAt, Date.parse("2026-08-26T08:00:00.001Z")), true);
});
