import assert from "node:assert/strict";
import test from "node:test";

import {
  attachLiveMetricHistory,
  groupLiveMetricHistory,
} from "../lib/live-metric-history.ts";

test("live metric snapshots are grouped chronologically without inventing values", () => {
  const grouped = groupLiveMetricHistory([
    {
      post_id: "youtube:one",
      captured_at: "2026-08-04T12:00:00.000Z",
      views: 180,
      likes: null,
      comments: 8,
      shares: null,
      saves: null,
    },
    {
      post_id: "youtube:one",
      captured_at: "2026-08-04T10:00:00.000Z",
      views: 100,
      likes: 12,
      comments: 4,
      shares: null,
      saves: null,
    },
    {
      post_id: "youtube:one",
      captured_at: "not-a-date",
      views: 999,
    },
  ]);

  assert.deepEqual(
    grouped.get("youtube:one")?.map((point) => point.captured_at),
    ["2026-08-04T10:00:00.000Z", "2026-08-04T12:00:00.000Z"],
  );
  assert.deepEqual(
    grouped.get("youtube:one")?.map((point) => point.views),
    [100, 180],
  );
  assert.equal(grouped.get("youtube:one")?.[1].likes, null);
  assert.equal(grouped.get("youtube:one")?.[1].poll_votes, null);
  assert.equal(grouped.get("youtube:one")?.[1].source, "live-scanner");
});

test("the API mapping uses captures, never updated_at, as metric timestamps", () => {
  const posts = attachLiveMetricHistory(
    [
      {
        id: "youtube:one",
        first_seen_at: "2026-08-04T09:00:00.000Z",
        last_seen_at: "2026-08-04T12:00:00.000Z",
        updated_at: "2099-01-01T00:00:00.000Z",
      },
      {
        id: "youtube:without-snapshot",
        last_seen_at: "2026-08-03T08:00:00.000Z",
        updated_at: "2099-01-01T00:00:00.000Z",
      },
    ],
    [
      {
        post_id: "youtube:one",
        captured_at: "2026-08-04T10:00:00.000Z",
        views: 100,
      },
      {
        post_id: "youtube:one",
        captured_at: "2026-08-04T12:00:00.000Z",
        views: 180,
      },
    ],
  );

  assert.equal(posts[0].last_metric_at, "2026-08-04T12:00:00.000Z");
  assert.equal(posts[0].metric_history[0].captured_at, "2026-08-04T10:00:00.000Z");
  assert.equal(posts[0].first_seen_at, "2026-08-04T09:00:00.000Z");
  assert.equal(posts[1].last_metric_at, "2026-08-03T08:00:00.000Z");
  assert.deepEqual(posts[1].metric_history, []);
  assert.notEqual(posts[0].last_metric_at, posts[0].updated_at);
  assert.notEqual(posts[1].last_metric_at, posts[1].updated_at);
});
