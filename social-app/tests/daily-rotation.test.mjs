import assert from "node:assert/strict";
import test from "node:test";

import { dailyRotationIndex } from "../lib/daily-rotation.ts";

test("daily proposal rotation is stable within a day and advances the next day", () => {
  for (const optionCount of [3, 7]) {
    const morning = dailyRotationIndex("same-trend", "2026-08-11T07:00:00Z", optionCount);
    const evening = dailyRotationIndex("same-trend", "2026-08-11T22:00:00Z", optionCount);
    const nextDay = dailyRotationIndex("same-trend", "2026-08-12T07:00:00Z", optionCount);

    assert.equal(evening, morning);
    assert.equal(nextDay, (morning + 1) % optionCount);
  }
});

test("daily proposal rotation safely handles an empty proposal list", () => {
  assert.equal(dailyRotationIndex("trend", "2026-08-11T07:00:00Z", 0), 0);
});
