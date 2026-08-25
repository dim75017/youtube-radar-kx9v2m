/**
 * Refuse an unusable Instagram profile discovery before the caller mutates
 * public-history.json. A public account known to contain posts returning zero
 * is a collector failure (login wall, challenge or markup change), not an
 * empty-history observation.
 */
export function assertInstagramProfileListing({ listed, snapshot }) {
  if (!Number.isInteger(listed) || listed < 0) {
    throw new TypeError(`Invalid Instagram listing count: ${listed}`);
  }
  if (listed > 0) return;

  const existingCount = Array.isArray(snapshot?.posts)
    ? snapshot.posts.filter((post) => post?.platform === "instagram").length
    : 0;
  const existingCoverage = Array.isArray(snapshot?.coverage)
    ? snapshot.coverage.find((item) => item?.platform === "instagram")
    : null;
  const coverageCount = Number.isFinite(Number(existingCoverage?.itemCount))
    ? Number(existingCoverage.itemCount)
    : 0;
  const hasCompleteCoverage = /^complete(?:-|$)/i.test(String(existingCoverage?.status ?? ""));

  const protectedState = [];
  if (existingCount > 0) protectedState.push(`${existingCount} existing post(s)`);
  if (coverageCount > 0) protectedState.push(`coverage itemCount=${coverageCount}`);
  if (hasCompleteCoverage) protectedState.push(`coverage status=${existingCoverage.status}`);
  const context = protectedState.length ? ` (${protectedState.join(", ")})` : "";

  throw new Error(
    `Instagram collection refused: the public profile returned 0 posts${context}. `
      + "This usually means a login wall, challenge or markup change; existing history and coverage were preserved.",
  );
}

/**
 * The hourly profile collector is incremental and cannot recertify an already
 * complete historical backfill. It may enrich/add posts, but it must never
 * replace that stronger coverage record with its own partial-profile status.
 */
export function preserveCertifiedInstagramCoverage(existing, incoming) {
  if (!existing || !/^complete(?:-|$)/i.test(String(existing.status ?? ""))) return incoming;

  const existingCount = Number(existing.itemCount) || 0;
  const incomingCount = Number(incoming?.itemCount) || 0;
  if (incomingCount <= existingCount) return existing;

  return {
    ...incoming,
    accountUrl: existing.accountUrl ?? incoming.accountUrl,
    scope: existing.scope ?? incoming.scope,
    status: existing.status,
    limitations: existing.limitations ?? incoming.limitations,
  };
}
