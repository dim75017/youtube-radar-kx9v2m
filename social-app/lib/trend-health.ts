export const TREND_EDITORIAL_SCAN_MAX_AGE_HOURS = 26;

const HOUR_IN_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1_000;

export function isTrendEditorialScanLate(
  capturedAt: string | null | undefined,
  checkedAt: number | string | Date = Date.now(),
) {
  if (!capturedAt) return true;
  const capturedTimestamp = Date.parse(capturedAt);
  const checkedTimestamp = checkedAt instanceof Date
    ? checkedAt.getTime()
    : typeof checkedAt === "number"
      ? checkedAt
      : Date.parse(checkedAt);
  if (!Number.isFinite(capturedTimestamp) || !Number.isFinite(checkedTimestamp)) {
    return true;
  }
  if (capturedTimestamp > checkedTimestamp + MAXIMUM_CLOCK_SKEW_MILLISECONDS) {
    return true;
  }
  return checkedTimestamp - capturedTimestamp >
    TREND_EDITORIAL_SCAN_MAX_AGE_HOURS * HOUR_IN_MILLISECONDS;
}
