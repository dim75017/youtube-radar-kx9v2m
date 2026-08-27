const NICE_STEP_FACTORS = [1, 2, 2.5, 5, 10];

/**
 * Build a stable axis whose bounds and ticks use human-friendly increments.
 * `unit` lets duration metrics calculate the scale in minutes or hours while
 * returning values in their original unit.
 *
 * @param {number} minimum
 * @param {number} maximum
 * @param {{ targetIntervals?: number, unit?: number, minimumStep?: number }} [options]
 */
export function buildAudienceChartAxis(
  minimum,
  maximum,
  { targetIntervals = 4, unit = 1, minimumStep = 1 } = {},
) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new TypeError("Audience chart bounds must be finite numbers.");
  }
  if (!Number.isFinite(unit) || unit <= 0) {
    throw new TypeError("Audience chart unit must be a positive number.");
  }

  const lower = Math.min(minimum, maximum) / unit;
  const upper = Math.max(minimum, maximum) / unit;
  const safeIntervals = Math.max(1, Math.round(targetIntervals));
  const rawSpan = upper - lower;
  const span = rawSpan > 0
    ? rawSpan
    : Math.max(Math.abs(upper) * 0.01, minimumStep, Number.EPSILON);
  const roughStep = span / safeIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalizedStep = roughStep / magnitude;
  const factor = NICE_STEP_FACTORS.find((candidate) => candidate >= normalizedStep) ?? 10;
  const stepInUnit = Math.max(minimumStep, factor * magnitude);
  let niceMinimumInUnit = Math.floor(lower / stepInUnit) * stepInUnit;
  let niceMaximumInUnit = Math.ceil(upper / stepInUnit) * stepInUnit;

  if (niceMinimumInUnit === niceMaximumInUnit) {
    niceMinimumInUnit -= stepInUnit;
    niceMaximumInUnit += stepInUnit;
  }

  const intervalCount = Math.max(
    1,
    Math.round((niceMaximumInUnit - niceMinimumInUnit) / stepInUnit),
  );
  const precision = Math.min(12, Math.max(0, -Math.floor(Math.log10(stepInUnit)) + 2));
  const normalize = (value) => {
    const normalized = Number(value.toFixed(precision));
    return Object.is(normalized, -0) ? 0 : normalized;
  };
  const ticks = Array.from({ length: intervalCount + 1 }, (_, index) =>
    normalize((niceMaximumInUnit - index * stepInUnit) * unit),
  );

  return {
    minimum: normalize(niceMinimumInUnit * unit),
    maximum: normalize(niceMaximumInUnit * unit),
    step: normalize(stepInUnit * unit),
    ticks,
  };
}
