import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import refresh_soundcharts_daily as subject


REAL_DATETIME = dt.datetime


class ParisBoundaryDateTime(REAL_DATETIME):
    """Freeze time after midnight in Paris but before midnight in UTC."""

    instant = REAL_DATETIME(2026, 7, 28, 22, 30, tzinfo=dt.timezone.utc)

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return cls.instant.replace(tzinfo=None)
        return cls.instant.astimezone(tz)


class FakeClient:
    def __init__(self, response):
        self.response = response

    def get(self, _path):
        return self.response


class PlaylistFollowerDailyIntegrityTests(unittest.TestCase):
    def test_incomplete_playlist_coverage_keeps_freshness_due_for_a_retry(self):
        previous = {"playlists_at": "2026-07-27T04:17:00Z"}
        incomplete = subject.Outcome("playlists")
        incomplete.available = 554
        incomplete.selected = 554
        incomplete.usable = 553

        merged = subject.merge_performance_freshness(
            previous,
            {},
            {"playlists": incomplete},
            "2026-07-28T04:17:00Z",
        )

        self.assertEqual(
            merged["playlists_at"],
            previous["playlists_at"],
            "partial follower coverage must stay due instead of claiming a fresh daily scan",
        )

        truncated = subject.Outcome("playlists")
        truncated.available = 554
        truncated.selected = 500
        truncated.usable = 500
        merged = subject.merge_performance_freshness(
            previous,
            {},
            {"playlists": truncated},
            "2026-07-28T04:17:00Z",
        )
        self.assertEqual(
            merged["playlists_at"],
            previous["playlists_at"],
            "a request cap must not postpone the retry for unscanned playlists",
        )

        failed = subject.Outcome("playlists")
        failed.available = 554
        failed.selected = 554
        failed.usable = 554
        failed.failures = 1
        merged = subject.merge_performance_freshness(
            previous,
            {},
            {"playlists": failed},
            "2026-07-28T04:17:00Z",
        )
        self.assertEqual(
            merged["playlists_at"],
            previous["playlists_at"],
            "a collector failure must keep the follower pass due",
        )

        empty = subject.Outcome("playlists")
        merged = subject.merge_performance_freshness(
            previous,
            {},
            {"playlists": empty},
            "2026-07-28T04:17:00Z",
        )
        self.assertEqual(merged["playlists_at"], previous["playlists_at"])

        complete = subject.Outcome("playlists")
        complete.available = 554
        complete.selected = 554
        complete.usable = 554
        merged = subject.merge_performance_freshness(
            previous,
            {},
            {"playlists": complete},
            "2026-07-28T04:17:00Z",
        )
        self.assertEqual(merged["playlists_at"], "2026-07-28T04:17:00Z")

    def test_refresh_uses_one_paris_calendar_point_and_updates_it_idempotently(self):
        playlists = {
            "cols": ["id", "followers", "last_seen", "big10k"],
            "rows": [["playlist-1", 100, "2026-07-28", 1]],
            "hist": {"playlist-1": [["2026-07-28", 100]]},
        }
        performance = {"playlists": {}}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "playlists.js"
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            with patch.object(subject.dt, "datetime", ParisBoundaryDateTime):
                subject.refresh_playlists(
                    path,
                    performance,
                    FakeClient({"object": {"latestSubscriberCount": 125}}),
                    1,
                    10,
                )
                subject.refresh_playlists(
                    path,
                    performance,
                    FakeClient({"object": {"latestSubscriberCount": 130}}),
                    1,
                    10,
                )
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)

        history = refreshed["hist"]["playlist-1"]
        paris_day_points = [point for point in history if point[0] == "2026-07-29"]
        self.assertEqual(paris_day_points, [["2026-07-29", 130]])
        self.assertEqual(len({point[0] for point in history}), len(history))
        self.assertEqual(
            subject.field(refreshed["rows"][0], refreshed["cols"], "last_seen"),
            "2026-07-29",
        )
        self.assertEqual(refreshed["meta"]["history_points_added_this_run"], 0)
        self.assertEqual(performance["playlists"]["playlist-1"]["history"], history)

    def test_missing_follower_metric_never_creates_a_zero_history_point(self):
        playlists = {
            "cols": ["id", "followers", "last_seen", "big10k"],
            "rows": [["playlist-1", 321, "2026-07-28", 1]],
            "hist": {"playlist-1": [["2026-07-28", 321]]},
        }
        performance = {"playlists": {}}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "playlists.js"
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            with patch.object(subject.dt, "datetime", ParisBoundaryDateTime):
                subject.refresh_playlists(
                    path,
                    performance,
                    FakeClient({"object": {"latestSubscriberCount": None, "imageUrl": "https://assets.test/cover.jpg"}}),
                    1,
                    10,
                )
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)

        self.assertEqual(refreshed["hist"]["playlist-1"], [["2026-07-28", 321]])
        self.assertEqual(subject.field(refreshed["rows"][0], refreshed["cols"], "followers"), 321)
        self.assertNotIn("playlist-1", performance["playlists"])
        self.assertFalse(any(point[1] == 0 for point in refreshed["hist"]["playlist-1"]))


if __name__ == "__main__":
    unittest.main()
