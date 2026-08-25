export type LiveMetricHistoryPoint = {
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  poll_votes: null;
  source: "live-scanner";
};

type UnknownRow = Record<string, unknown>;

/**
 * Attach only observations that were actually persisted by a scan. Database
 * maintenance timestamps such as `updated_at` are deliberately ignored: they
 * say when a row changed, not when the audience metric was captured.
 */
export function attachLiveMetricHistory(
  posts: readonly UnknownRow[],
  snapshotRows: readonly UnknownRow[],
): UnknownRow[] {
  const historyByPost = groupLiveMetricHistory(snapshotRows);

  return posts.map((post) => {
    const postId = nonemptyString(post.id);
    const metricHistory = postId ? historyByPost.get(postId) ?? [] : [];
    const latestCapture = metricHistory.at(-1)?.captured_at;

    return {
      ...post,
      metric_history: metricHistory,
      last_metric_at: latestCapture ?? nonemptyString(post.last_seen_at),
    };
  });
}

export function groupLiveMetricHistory(
  snapshotRows: readonly UnknownRow[],
): Map<string, LiveMetricHistoryPoint[]> {
  const byPostAndCapture = new Map<string, Map<string, LiveMetricHistoryPoint>>();

  for (const row of snapshotRows) {
    const postId = nonemptyString(row.post_id);
    const capturedAt = validTimestamp(row.captured_at);
    if (!postId || !capturedAt) continue;

    let byCapture = byPostAndCapture.get(postId);
    if (!byCapture) {
      byCapture = new Map<string, LiveMetricHistoryPoint>();
      byPostAndCapture.set(postId, byCapture);
    }

    // One scan normally yields one row per post. If two scans share the exact
    // same timestamp, the query order makes the last persisted row win as a
    // whole; fields from distinct observations are never blended together.
    byCapture.set(capturedAt, {
      captured_at: capturedAt,
      views: publicMetric(row.views),
      likes: publicMetric(row.likes),
      comments: publicMetric(row.comments),
      shares: publicMetric(row.shares),
      saves: publicMetric(row.saves),
      poll_votes: null,
      source: "live-scanner",
    });
  }

  return new Map(
    [...byPostAndCapture.entries()].map(([postId, byCapture]) => [
      postId,
      [...byCapture.values()].sort((left, right) =>
        left.captured_at.localeCompare(right.captured_at),
      ),
    ]),
  );
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function validTimestamp(value: unknown): string | null {
  const timestamp = nonemptyString(value);
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
  return timestamp;
}

function publicMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
