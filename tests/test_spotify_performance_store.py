import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import spotify_performance_store as subject


def sample_payload():
    return {
        "source": "soundcharts_daily",
        "generated_at": "2026-07-31T10:00:00Z",
        "tracks": {
            "track-a": {
                "soundcharts_uuid": "uuid-a",
                "history": [["2026-07-29", 100], ["2026-07-30", 120], ["2026-07-31", 150]],
            },
            "track-b": {
                "soundcharts_uuid": "uuid-b",
                "history": [["2026-07-30", 200], ["2026-07-31", 205]],
            },
            "track-c": {"soundcharts_uuid": "uuid-c", "history": []},
        },
        "artists": {"artist-a": {"history": [["2026-07-31", 50000]]}},
        "playlists": {"playlist-a": {"history": [["2026-07-31", 1000]]}},
        "freshness": {"tracks_catalogue_at": "2026-07-31T10:00:00Z"},
        "run": {"status": "success"},
        "custom_metadata": {"kept": True},
    }


def write_legacy(path, payload):
    path.write_text(
        subject.PERFORMANCE_PREFIX
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


class SpotifyPerformanceStoreTests(unittest.TestCase):
    def test_legacy_to_sharded_round_trip_preserves_every_entry_and_metadata(self):
        original = sample_payload()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Spotify_Performance_data.js"
            write_legacy(root, original)

            legacy = subject.read_performance_payload(root)
            self.assertEqual(legacy, original)
            result = subject.write_performance_payload(root, legacy, shard_count=2)
            hydrated = subject.read_performance_payload(root)
            stored_root = subject._read_root(root)

            self.assertEqual(hydrated["tracks"], original["tracks"])
            self.assertEqual(hydrated["artists"], original["artists"])
            self.assertEqual(hydrated["playlists"], original["playlists"])
            self.assertEqual(hydrated["custom_metadata"], original["custom_metadata"])
            self.assertEqual(set(stored_root["tracks"]), set(original["tracks"]))
            self.assertEqual(stored_root["tracks"]["track-a"]["history"], [["2026-07-31", 150]])
            self.assertEqual(stored_root["track_shards"]["tracks_total"], 3)
            self.assertEqual(result["shards"], 2)
            self.assertEqual(
                stored_root["run"]["performance_store"]["tracks_total"],
                len(original["tracks"]),
            )
            for descriptor in stored_root["track_shards"]["shards"]:
                self.assertLessEqual(descriptor["bytes"], subject.MAX_TRACK_SHARD_BYTES)

    def test_missing_or_corrupt_shard_fails_closed(self):
        for damage in ("missing", "corrupt"):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "Spotify_Performance_data.js"
                subject.write_performance_payload(root, sample_payload(), shard_count=2)
                manifest = subject._read_root(root)["track_shards"]
                descriptor = next(item for item in manifest["shards"] if item["tracks"])
                shard = root.parent / descriptor["path"]
                if damage == "missing":
                    shard.unlink()
                else:
                    shard.write_bytes(shard.read_bytes() + b"corrupt")
                with self.assertRaises(subject.PerformanceStoreError):
                    subject.read_performance_payload(root)

    def test_duplicate_manifest_bucket_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Spotify_Performance_data.js"
            subject.write_performance_payload(root, sample_payload(), shard_count=2)
            stored_root = subject._read_root(root)
            stored_root["track_shards"]["shards"][1]["bucket"] = stored_root["track_shards"]["shards"][0]["bucket"]
            subject._atomic_write(root, subject._root_bytes(stored_root))
            with self.assertRaisesRegex(subject.PerformanceStoreError, "duplicate or invalid buckets"):
                subject.read_performance_payload(root)

    def test_root_switch_is_atomic_when_manifest_write_fails(self):
        original = sample_payload()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Spotify_Performance_data.js"
            write_legacy(root, original)
            original_bytes = root.read_bytes()
            real_atomic_write = subject._atomic_write

            def fail_root(target, data):
                if target == root:
                    raise subject.PerformanceStoreError("simulated root failure")
                return real_atomic_write(target, data)

            with patch.object(subject, "_atomic_write", side_effect=fail_root):
                with self.assertRaisesRegex(subject.PerformanceStoreError, "simulated root failure"):
                    subject.write_performance_payload(root, copy.deepcopy(original), shard_count=2)

            self.assertEqual(root.read_bytes(), original_bytes)
            self.assertEqual(subject.read_performance_payload(root), original)

    def test_new_manifest_removes_only_stale_unreferenced_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Spotify_Performance_data.js"
            first = sample_payload()
            subject.write_performance_payload(root, first, shard_count=2)
            old_paths = {
                (root.parent / item["path"]).resolve()
                for item in subject._read_root(root)["track_shards"]["shards"]
            }
            second = copy.deepcopy(first)
            second["tracks"]["track-a"]["history"].append(["2026-08-01", 175])
            subject.write_performance_payload(root, second, shard_count=2)
            new_paths = {
                (root.parent / item["path"]).resolve()
                for item in subject._read_root(root)["track_shards"]["shards"]
            }
            self.assertTrue(all(path.exists() for path in new_paths))
            self.assertTrue(all(not path.exists() for path in old_paths - new_paths))
            self.assertEqual(subject.read_performance_payload(root)["tracks"], second["tracks"])

    def test_writer_increases_shard_count_before_any_oversized_write(self):
        payload = sample_payload()
        payload["tracks"] = {
            f"track-{index}": {"history": [["2026-07-31", index]], "padding": "x" * 120}
            for index in range(40)
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(subject, "MAX_TRACK_SHARD_BYTES", 1_200):
            root = Path(directory) / "Spotify_Performance_data.js"
            result = subject.write_performance_payload(root, payload, shard_count=1)
            self.assertGreater(result["shards"], 1)
            manifest = subject._read_root(root)["track_shards"]
            self.assertTrue(all(item["bytes"] <= 1_200 for item in manifest["shards"]))
            self.assertEqual(subject.read_performance_payload(root)["tracks"], payload["tracks"])


if __name__ == "__main__":
    unittest.main()
