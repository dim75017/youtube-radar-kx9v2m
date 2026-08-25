import datetime as dt
from pathlib import Path
import tempfile
import unittest

import repair_spotify_counter_integrity as subject
from spotify_performance_store import read_performance_payload, write_performance_payload


def daily_history() -> list[list[object]]:
    start = dt.date(2026, 7, 19)
    points = [
        [(start + dt.timedelta(days=index)).isoformat(), 145_000 + index * 2_000]
        for index in range(31)
    ]
    points.append(["2026-08-19", 241_582_598])
    return points


class RepairSpotifyCounterIntegrityTests(unittest.TestCase):
    def test_browse_audit_requires_atomic_safe_total_date_and_delta(self):
        performance = {
            "tracks": {
                "reverie": {
                    "history": [["2026-08-17", 202_751], ["2026-08-18", 205_208]],
                    "counter_integrity": {"status": "spike_quarantined"},
                }
            }
        }
        schema = ["spotify_id", "streams", "streams_delta_24h", "streams_source_date"]
        browse = {
            "discovery_catalogue": {
                "track_schema": schema,
                "tracks": [["reverie", 205_208, 2_457, "2026-08-18"]],
            }
        }

        clean = subject.audit_browse_payload(performance, browse)
        self.assertEqual(clean["public_integrity_rows"], 1)
        self.assertEqual(clean["mismatches"], 0)

        browse["discovery_catalogue"]["tracks"][0] = [
            "reverie", 241_582_598, 241_377_390, "2026-08-19"
        ]
        corrupt = subject.audit_browse_payload(performance, browse)
        self.assertEqual(corrupt["mismatches"], 1)
    def test_audit_reports_without_mutating_and_repair_is_idempotent(self):
        payload = {
            "tracks": {
                "reverie": {"history": daily_history(), "soundcharts_uuid": "song-1"},
                "clean": {"history": [["2026-08-18", 100], ["2026-08-19", 110]]},
            }
        }
        before = list(payload["tracks"]["reverie"]["history"])

        audit = subject.audit_payload(payload, repair=False)

        self.assertEqual(audit["status"], "unsafe")
        self.assertEqual(audit["affected_tracks"], 1)
        self.assertEqual(payload["tracks"]["reverie"]["history"], before)

        repaired = subject.audit_payload(payload, repair=True)
        self.assertEqual(repaired["status"], "repaired")
        entry = payload["tracks"]["reverie"]
        self.assertEqual(entry["history"][-1], ["2026-08-18", 205_000])
        self.assertEqual(entry["counter_integrity"]["status"], "spike_quarantined")
        self.assertEqual(subject.audit_payload(payload, repair=False)["affected_tracks"], 0)

    def test_repaired_sharded_store_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Spotify_Performance_data.js"
            payload = {
                "source": "soundcharts_daily",
                "tracks": {"reverie": {"history": daily_history()}},
                "artists": {},
                "playlists": {},
            }
            write_performance_payload(path, payload, shard_count=2)
            hydrated = read_performance_payload(path)
            report = subject.audit_payload(hydrated, repair=True)
            write_performance_payload(path, hydrated, shard_count=2)

            self.assertEqual(report["affected_tracks"], 1)
            restored = read_performance_payload(path)["tracks"]["reverie"]
            self.assertEqual(restored["history"][-1], ["2026-08-18", 205_000])
            self.assertEqual(restored["counter_integrity"]["status"], "spike_quarantined")


if __name__ == "__main__":
    unittest.main()
