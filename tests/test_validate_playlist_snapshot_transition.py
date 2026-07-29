import copy
import unittest
from pathlib import Path

import validate_playlist_snapshot_transition as subject


ROOT = Path(__file__).parents[1]


def payload() -> dict:
    return {
        "meta": {
            "snapshot_ts": "2026-07-28 22:39",
            "generated_ts": "2026-07-28 22:39",
            "playlists_discovered": 2,
            "playlists_enriched": 2,
            "playlists_10k_plus": 1,
            "playlist_followers_status": {
                "day": "2026-07-29",
                "expected": 1,
                "updated": 1,
                "complete": True,
            },
        },
        "cols": ["id", "followers", "big10k", "image_url"],
        "rows": [
            ["playlist-1", 100, 1, "https://assets.test/one.jpg"],
            ["playlist-2", 50, 0, "https://assets.test/two.jpg"],
        ],
        "hist": {
            "playlist-1": [["2026-07-28", 90], ["2026-07-29", 100]],
            "playlist-2": [["2026-07-28", 50]],
        },
    }


class PlaylistSnapshotTransitionTests(unittest.TestCase):
    def test_dashboard_loads_only_the_canonical_playlist_export(self):
        spotify_index = (ROOT / "spotify" / "index.html").read_text(encoding="utf-8")
        root_index = (ROOT / "index.html").read_text(encoding="utf-8")

        self.assertIn("Spotify_Playlists_canonical_data.js", spotify_index)
        self.assertIn("Spotify_Playlists_canonical_data.js", root_index)
        self.assertNotIn("Spotify_Playlists_data.js", spotify_index)
        self.assertNotIn("Spotify_Playlists_data.js", root_index)

    def test_newer_additive_snapshot_is_accepted(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["meta"]["snapshot_ts"] = "2026-07-29 18:47"
        candidate["meta"]["generated_ts"] = "2026-07-29 18:47"
        candidate["meta"]["playlist_followers_status"] = {
            "day": "2026-07-30",
            "expected": 1,
            "updated": 1,
            "complete": True,
        }
        candidate["hist"]["playlist-1"].append(["2026-07-30", 110])

        summary = subject.validate_snapshot_transition(previous, candidate)

        self.assertEqual(summary["history_points"], 4)

    def test_same_day_measurement_can_be_corrected_without_losing_the_date(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["meta"]["snapshot_ts"] = "2026-07-28 23:10"
        candidate["hist"]["playlist-1"][-1][1] = 105

        subject.validate_snapshot_transition(previous, candidate)

    def test_older_source_snapshot_is_rejected_even_with_a_new_generated_time(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["meta"]["snapshot_ts"] = "2026-07-17 20:51"
        candidate["meta"]["generated_ts"] = "2026-07-29 09:42"

        with self.assertRaisesRegex(subject.SnapshotRegression, "moved backwards"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_removed_column_is_rejected(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["cols"].remove("image_url")
        for row in candidate["rows"]:
            row.pop()

        with self.assertRaisesRegex(subject.SnapshotRegression, "removed columns: image_url"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_removed_playlist_is_rejected(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["rows"].pop()

        with self.assertRaisesRegex(subject.SnapshotRegression, "removed 1 playlists"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_removed_history_point_is_rejected(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["hist"]["playlist-1"].pop(0)

        with self.assertRaisesRegex(subject.SnapshotRegression, "discarded follower history"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_expired_history_can_be_compacted_at_the_pipeline_retention_boundary(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        previous["hist"]["playlist-1"] = [
            ["2025-06-01", 10],
            ["2026-07-28", 90],
            ["2026-07-29", 100],
        ]
        candidate["hist"]["playlist-1"] = [
            ["2026-07-28", 90],
            ["2026-07-29", 100],
        ]

        subject.validate_snapshot_transition(previous, candidate)

    def test_removed_follower_status_is_rejected(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        del candidate["meta"]["playlist_followers_status"]

        with self.assertRaisesRegex(subject.SnapshotRegression, "removed meta.playlist_followers_status"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_same_day_complete_coverage_cannot_regress(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["meta"]["playlist_followers_status"]["updated"] = 0
        candidate["meta"]["playlist_followers_status"]["complete"] = False

        with self.assertRaisesRegex(subject.SnapshotRegression, "same-day follower coverage regressed"):
            subject.validate_snapshot_transition(previous, candidate)

    def test_representative_legacy_bridge_shape_is_rejected(self):
        previous = payload()
        candidate = copy.deepcopy(previous)
        candidate["meta"].update(
            snapshot_ts="2026-07-17 20:51",
            generated_ts="2026-07-29 09:42",
        )
        del candidate["meta"]["playlist_followers_status"]
        candidate["cols"].remove("image_url")
        for row in candidate["rows"]:
            row.pop()
        candidate["hist"] = {
            playlist_id: [points[0]] for playlist_id, points in candidate["hist"].items()
        }

        with self.assertRaises(subject.SnapshotRegression):
            subject.validate_snapshot_transition(previous, candidate)

    def test_published_canonical_snapshot_is_self_consistent(self):
        canonical = subject.read_payload(ROOT / "Spotify_Playlists_canonical_data.js")

        summary = subject.validate_snapshot_transition(canonical, canonical)

        self.assertGreaterEqual(summary["rows"], 12_000)
        self.assertGreaterEqual(summary["history_points"], 9_000)


if __name__ == "__main__":
    unittest.main()
