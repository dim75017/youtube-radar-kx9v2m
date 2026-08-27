import assert from "node:assert/strict";
import test from "node:test";

import { buildAudienceChartAxis } from "../lib/audience-chart-axis.mjs";

test("builds round signed follower ticks and keeps zero on the axis", () => {
  const axis = buildAudienceChartAxis(-1_406, 1_331);

  assert.equal(axis.minimum, -2_000);
  assert.equal(axis.maximum, 2_000);
  assert.equal(axis.step, 1_000);
  assert.deepEqual(axis.ticks, [2_000, 1_000, 0, -1_000, -2_000]);
});

test("uses professional whole-number ticks around a narrow follower total", () => {
  const axis = buildAudienceChartAxis(1_427_760, 1_430_347);

  assert.equal(axis.step, 1_000);
  assert.deepEqual(axis.ticks, [1_431_000, 1_430_000, 1_429_000, 1_428_000, 1_427_000]);
  assert.ok(axis.ticks.every(Number.isInteger));
});

test("never creates fractional ticks for count metrics", () => {
  const axis = buildAudienceChartAxis(2, 5);

  assert.equal(axis.step, 1);
  assert.deepEqual(axis.ticks, [5, 4, 3, 2]);
});

test("can calculate duration ticks in hours while preserving seconds", () => {
  const axis = buildAudienceChartAxis(3_600, 18_000, { unit: 3_600 });

  assert.equal(axis.step, 3_600);
  assert.deepEqual(axis.ticks, [18_000, 14_400, 10_800, 7_200, 3_600]);
});
