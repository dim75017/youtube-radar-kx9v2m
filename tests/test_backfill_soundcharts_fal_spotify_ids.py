import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from backfill_soundcharts_fal_spotify_ids import (
    ABSOLUTE_MAX_REQUESTS,
    FalSpotifyIdBackfillError,
    MIN_QUOTA_RESERVE,
    SpotifyIdBackfillScanner,
    ensure_backfill_schema,
    exact_spotify_plot_identifier,
    extract_spotify_plot_candidates,
    file_sha256,
    main,
    merge_resolved_identity_cache,
    reconcile_preexisting_detail_ids,
    seed_backfill_rows,
    validate_report_state_alignment,
)


SPOTIFY_A = "A1b2C3d4E5f6G7h8I9j0K1"
SPOTIFY_B = "B1c2D3e4F5g6H7i8J9k0L1"


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.requests_claimed = 0
        self.quota_remaining = 2_000_000

    def get(self, path):
        self.requests_claimed += 1
        self.quota_remaining -= 1
        track_uuid = path.split("/song/", 1)[1].split("/audience/", 1)[0]
        response = self.responses[track_uuid]
        if isinstance(response, BaseException):
            raise response
        return response


def audience(*identifiers):
    return {
        "items": [
            {
                "date": "2026-08-02",
                "plots": [
                    {"identifier": identifier, "value": 100_000 + index}
                    for index, identifier in enumerate(identifiers)
                ],
            },
            {
                "date": "2026-08-03",
                "plots": [
                    {"identifier": identifier, "value": 101_000 + index}
                    for index, identifier in enumerate(identifiers)
                ],
            },
        ]
    }


class SpotifyIdBackfillTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "phase2.sqlite3"
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO meta(key,value) VALUES('fal_phase2_state_version','3');
            CREATE TABLE fal_phase2_stream_gate(
              track_uuid TEXT PRIMARY KEY,
              spotify_id TEXT,
              gate_status TEXT NOT NULL,
              streams_total INTEGER
            );
            CREATE TABLE fal_phase2_details(
              track_uuid TEXT PRIMARY KEY,
              spotify_id TEXT
            );
            """
        )
        self.connection.commit()
        ensure_backfill_schema(self.connection)

    def tearDown(self):
        self.connection.close()
        self.tempdir.cleanup()

    def add_track(
        self,
        track_uuid,
        *,
        status="eligible",
        stream_id=None,
        detail_id=None,
        streams_total=100_000,
    ):
        self.connection.execute(
            "INSERT INTO fal_phase2_stream_gate VALUES(?,?,?,?)",
            (track_uuid, stream_id, status, streams_total),
        )
        self.connection.execute(
            "INSERT INTO fal_phase2_details VALUES(?,?)",
            (track_uuid, detail_id),
        )
        self.connection.commit()

    def scanner(self, responses, *, workers=10):
        return SpotifyIdBackfillScanner(
            self.connection,
            FakeClient(responses),
            workers=workers,
            as_of="2026-08-04",
            run_id="test-run",
        )

    def test_accepts_only_exact_22_character_numeric_plot_identifiers(self):
        self.assertEqual(exact_spotify_plot_identifier(SPOTIFY_A), SPOTIFY_A)
        self.assertEqual(exact_spotify_plot_identifier(f"spotify:track:{SPOTIFY_A}"), "")
        self.assertEqual(exact_spotify_plot_identifier("short"), "")
        candidates = extract_spotify_plot_candidates(
            {
                "items": [
                    {
                        "date": "2026-08-03",
                        "plots": [
                            {"identifier": SPOTIFY_A, "value": 123},
                            {"identifier": f"spotify:track:{SPOTIFY_B}", "value": 456},
                            {"identifier": SPOTIFY_B, "value": "not-numeric"},
                        ],
                    }
                ]
            }
        )
        self.assertEqual([candidate.spotify_id for candidate in candidates], [SPOTIFY_A])
        self.assertEqual(candidates[0].latest_value, 123)

    def test_unambiguous_audience_identity_updates_both_private_tables(self):
        self.add_track("track-one")
        self.assertEqual(seed_backfill_rows(self.connection), 1)
        scanner = self.scanner({"track-one": audience(SPOTIFY_A)})
        self.assertEqual(scanner.run(max_rows=1), 1)
        gate = self.connection.execute(
            "SELECT spotify_id FROM fal_phase2_stream_gate WHERE track_uuid='track-one'"
        ).fetchone()[0]
        detail = self.connection.execute(
            "SELECT spotify_id FROM fal_phase2_details WHERE track_uuid='track-one'"
        ).fetchone()[0]
        backfill = self.connection.execute(
            """SELECT status,selected_spotify_id,candidate_ids_json,evidence_json
                 FROM fal_phase2_spotify_id_backfill WHERE track_uuid='track-one'"""
        ).fetchone()
        self.assertEqual(gate, SPOTIFY_A)
        self.assertEqual(detail, SPOTIFY_A)
        self.assertEqual(backfill["status"], "resolved")
        self.assertEqual(backfill["selected_spotify_id"], SPOTIFY_A)
        self.assertEqual(json.loads(backfill["candidate_ids_json"]), [SPOTIFY_A])
        self.assertNotIn("items", backfill["evidence_json"])

    def test_ambiguous_identifiers_are_retained_but_never_assigned(self):
        self.add_track("track-ambiguous")
        seed_backfill_rows(self.connection)
        scanner = self.scanner(
            {"track-ambiguous": audience(SPOTIFY_A, SPOTIFY_B)}
        )
        scanner.run(max_rows=1)
        gate = self.connection.execute(
            "SELECT spotify_id FROM fal_phase2_stream_gate WHERE track_uuid='track-ambiguous'"
        ).fetchone()[0]
        row = self.connection.execute(
            """SELECT status,candidate_ids_json,error_code
                 FROM fal_phase2_spotify_id_backfill
                WHERE track_uuid='track-ambiguous'"""
        ).fetchone()
        self.assertIsNone(gate)
        self.assertEqual(row["status"], "ambiguous")
        self.assertEqual(json.loads(row["candidate_ids_json"]), [SPOTIFY_A, SPOTIFY_B])
        self.assertEqual(row["error_code"], "multiple_exact_plot_identifiers")

    def test_existing_duplicate_is_retained_but_never_assigned(self):
        self.add_track(
            "existing-track",
            status="blocked_streams_below_threshold",
            stream_id=SPOTIFY_A,
            detail_id=SPOTIFY_A,
        )
        self.add_track("new-track")
        seed_backfill_rows(self.connection)
        scanner = self.scanner({"new-track": audience(SPOTIFY_A)})
        scanner.run(max_rows=1)
        row = self.connection.execute(
            """SELECT status,candidate_ids_json,conflicting_track_uuids_json
                 FROM fal_phase2_spotify_id_backfill WHERE track_uuid='new-track'"""
        ).fetchone()
        self.assertEqual(row["status"], "duplicate_within_phase2")
        self.assertEqual(json.loads(row["candidate_ids_json"]), [SPOTIFY_A])
        self.assertEqual(json.loads(row["conflicting_track_uuids_json"]), ["existing-track"])
        self.assertIsNone(
            self.connection.execute(
                "SELECT spotify_id FROM fal_phase2_stream_gate WHERE track_uuid='new-track'"
            ).fetchone()[0]
        )
        existing = self.connection.execute(
            """SELECT s.spotify_id,d.spotify_id
                 FROM fal_phase2_stream_gate AS s
                 JOIN fal_phase2_details AS d ON d.track_uuid=s.track_uuid
                WHERE s.track_uuid='existing-track'"""
        ).fetchone()
        self.assertEqual(tuple(existing), (SPOTIFY_A, SPOTIFY_A))

    def test_same_identifier_claimed_twice_in_one_batch_blocks_both_rows(self):
        self.add_track("batch-one")
        self.add_track("batch-two")
        seed_backfill_rows(self.connection)
        scanner = self.scanner(
            {"batch-one": audience(SPOTIFY_B), "batch-two": audience(SPOTIFY_B)},
            workers=2,
        )
        scanner.run(max_rows=2)
        rows = self.connection.execute(
            """SELECT track_uuid,status,conflicting_track_uuids_json
                 FROM fal_phase2_spotify_id_backfill ORDER BY track_uuid"""
        ).fetchall()
        self.assertEqual(
            [row["status"] for row in rows],
            ["duplicate_within_phase2", "duplicate_within_phase2"],
        )
        self.assertEqual(
            json.loads(rows[0]["conflicting_track_uuids_json"]), ["batch-two"]
        )
        self.assertEqual(
            json.loads(rows[1]["conflicting_track_uuids_json"]), ["batch-one"]
        )

    def test_duplicate_discovered_in_later_batch_revokes_first_backfill_assignment(self):
        self.add_track("first-batch")
        self.add_track("second-batch")
        seed_backfill_rows(self.connection)
        responses = {
            "first-batch": audience(SPOTIFY_A),
            "second-batch": audience(SPOTIFY_A),
        }
        first_scanner = self.scanner(responses, workers=1)
        first_scanner.run(max_rows=1)
        first = self.connection.execute(
            """SELECT b.status,s.spotify_id
                 FROM fal_phase2_spotify_id_backfill AS b
                 JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
                WHERE b.track_uuid='first-batch'"""
        ).fetchone()
        self.assertEqual(tuple(first), ("resolved", SPOTIFY_A))

        second_scanner = self.scanner(responses, workers=1)
        second_scanner.run(max_rows=1)
        rows = self.connection.execute(
            """SELECT b.track_uuid,b.status,b.selected_spotify_id,
                      b.conflicting_track_uuids_json,s.spotify_id,d.spotify_id AS detail_id
                 FROM fal_phase2_spotify_id_backfill AS b
                 JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
                 JOIN fal_phase2_details AS d ON d.track_uuid=b.track_uuid
                ORDER BY b.track_uuid"""
        ).fetchall()
        self.assertEqual(
            [row["status"] for row in rows],
            ["duplicate_within_phase2", "duplicate_within_phase2"],
        )
        self.assertTrue(all(row["selected_spotify_id"] is None for row in rows))
        self.assertTrue(all(row["spotify_id"] is None for row in rows))
        self.assertTrue(all(row["detail_id"] is None for row in rows))
        self.assertEqual(
            json.loads(rows[0]["conflicting_track_uuids_json"]), ["second-batch"]
        )
        self.assertEqual(
            json.loads(rows[1]["conflicting_track_uuids_json"]), ["first-batch"]
        )

    def test_only_eligible_missing_stream_ids_are_queued(self):
        self.add_track("eligible-missing")
        self.add_track("eligible-known", stream_id=SPOTIFY_A, detail_id=SPOTIFY_A)
        self.add_track("below-threshold", status="blocked_streams_below_threshold")
        self.assertEqual(seed_backfill_rows(self.connection), 1)
        queued = self.connection.execute(
            "SELECT track_uuid FROM fal_phase2_spotify_id_backfill"
        ).fetchall()
        self.assertEqual([row[0] for row in queued], ["eligible-missing"])

    def test_valid_preexisting_private_detail_id_avoids_an_api_call(self):
        self.add_track("detail-known", detail_id=SPOTIFY_A)
        seed_backfill_rows(self.connection)
        self.assertEqual(
            reconcile_preexisting_detail_ids(self.connection, "offline-run"), 1
        )
        gate = self.connection.execute(
            "SELECT spotify_id FROM fal_phase2_stream_gate WHERE track_uuid='detail-known'"
        ).fetchone()[0]
        status = self.connection.execute(
            """SELECT status FROM fal_phase2_spotify_id_backfill
                 WHERE track_uuid='detail-known'"""
        ).fetchone()[0]
        self.assertEqual(gate, SPOTIFY_A)
        self.assertEqual(status, "resolved")

    def test_hard_limits_protect_quota_and_concurrency(self):
        self.assertEqual(ABSOLUTE_MAX_REQUESTS, 15_000)
        self.assertGreaterEqual(MIN_QUOTA_RESERVE, 1_400_000)
        scanner = SpotifyIdBackfillScanner(
            self.connection,
            FakeClient({}),
            workers=999,
            as_of="2026-08-04",
        )
        self.assertEqual(scanner.workers, 10)

    def test_report_and_100k_state_must_align_before_any_calls(self):
        self.add_track("valid-proof")
        report = {
            "stream_gate": {
                "status_counts": {"eligible": 1},
                "minimum_streams": 100_000,
            }
        }
        self.assertEqual(validate_report_state_alignment(self.connection, report), 1)
        self.connection.execute(
            "UPDATE fal_phase2_stream_gate SET streams_total=99999"
        )
        self.connection.commit()
        with self.assertRaises(FalSpotifyIdBackfillError):
            validate_report_state_alignment(self.connection, report)

    def test_noop_run_does_not_mutate_the_private_state(self):
        self.add_track(
            "already-known",
            stream_id=SPOTIFY_A,
            detail_id=SPOTIFY_A,
        )
        phase2_report = Path(self.tempdir.name) / "phase2-report.json"
        output_report = Path(self.tempdir.name) / "backfill-report.json"
        phase2_report.write_text(
            json.dumps(
                {
                    "complete": True,
                    "staging_only": True,
                    "canonical_written": False,
                    "dashboard_written": False,
                    "stream_gate": {
                        "minimum_streams": 100_000,
                        "status_counts": {"eligible": 1},
                    },
                }
            ),
            encoding="utf-8",
        )
        before = file_sha256(self.path)
        self.connection.close()
        main(
            [
                "--state",
                str(self.path),
                "--phase2-report",
                str(phase2_report),
                "--report",
                str(output_report),
            ]
        )
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        after = file_sha256(self.path)
        report = json.loads(output_report.read_text(encoding="utf-8"))
        self.assertEqual(before, after)
        self.assertFalse(report["state_changed"])

    def test_newer_phase2_state_merges_safe_ids_from_encrypted_cache(self):
        self.add_track("cache-track")
        cache_path = Path(self.tempdir.name) / "encrypted-cache.sqlite3"
        cache = sqlite3.connect(cache_path)
        cache.row_factory = sqlite3.Row
        cache.executescript(
            """
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO meta(key,value) VALUES('fal_phase2_state_version','3');
            CREATE TABLE fal_phase2_stream_gate(
              track_uuid TEXT PRIMARY KEY,spotify_id TEXT,gate_status TEXT NOT NULL,
              streams_total INTEGER
            );
            CREATE TABLE fal_phase2_details(track_uuid TEXT PRIMARY KEY,spotify_id TEXT);
            """
        )
        ensure_backfill_schema(cache)
        cache.execute(
            "INSERT INTO fal_phase2_stream_gate VALUES(?,?,?,?)",
            ("cache-track", SPOTIFY_A, "eligible", 100_000),
        )
        cache.execute(
            "INSERT INTO fal_phase2_details VALUES(?,?)",
            ("cache-track", SPOTIFY_A),
        )
        cache.execute(
            """INSERT INTO fal_phase2_spotify_id_backfill(
                   track_uuid,status,selected_spotify_id,candidate_ids_json,
                   evidence_json,conflicting_track_uuids_json,attempts,error_code,
                   queued_at,updated_at,last_run_id)
                 VALUES(?,'resolved',?,'[]','{}','[]',1,NULL,'now','now','old-run')""",
            ("cache-track", SPOTIFY_A),
        )
        cache.commit()
        cache.close()
        before_cache = file_sha256(cache_path)

        self.assertEqual(
            merge_resolved_identity_cache(
                self.connection, cache_path, run_id="new-run"
            ),
            1,
        )
        merged = self.connection.execute(
            """SELECT s.spotify_id,d.spotify_id,b.status,b.selected_spotify_id
                 FROM fal_phase2_stream_gate AS s
                 JOIN fal_phase2_details AS d ON d.track_uuid=s.track_uuid
                 JOIN fal_phase2_spotify_id_backfill AS b ON b.track_uuid=s.track_uuid
                WHERE s.track_uuid='cache-track'"""
        ).fetchone()
        self.assertEqual(
            tuple(merged),
            (SPOTIFY_A, SPOTIFY_A, "resolved", SPOTIFY_A),
        )
        self.assertEqual(before_cache, file_sha256(cache_path))


if __name__ == "__main__":
    unittest.main()
