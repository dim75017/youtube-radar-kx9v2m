export function dailyRotationIndex(
  itemId: string,
  capturedAt: string,
  optionCount: number,
) {
  if (!Number.isInteger(optionCount) || optionCount <= 0) return 0;
  const dayKey = capturedAt.slice(0, 10);
  let hash = 2_166_136_261;
  for (const character of itemId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const dayTimestamp = Date.parse(`${dayKey}T00:00:00.000Z`);
  const dayNumber = Number.isFinite(dayTimestamp)
    ? Math.floor(dayTimestamp / 86_400_000)
    : 0;
  return (hash + dayNumber) % optionCount;
}
