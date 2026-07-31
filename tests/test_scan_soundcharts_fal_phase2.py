import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from refresh_soundcharts_daily import SoundchartsDataUnavailableError, SoundchartsError
from scan_soundcharts_fal_phase1 import open_state
from scan_soundcharts_fal_phase2 import (
    ArtistGateScanner,
    FalPhase2Error,
    PHASE2_REPORT_VERSION,
    PHASE2_STATE_VERSION,
    Phase2Scanner,
    QueueMigration,
    assert_phase1_complete,
    build_report,
    canary_zero_yield,
    evidence_yield,
    initialize_artist_gate,
    main,
    migrate_gated_track_queue,
    migrate_recent_queue,
    open_phase1_state,
    open_phase2_state,
    parse_args,
    plan_interleaved_budget,
    reconcile_phase1_source,
    run_interleaved_batches,
)


class FakeClient:
    def __init__(self, responder):
        self.responder = responder
        self.paths = []
        self.requests_claimed = 0
        self.quota_remaining = 1_000_000

    def get(self, path):
        self.paths.append(path)
        self.requests_claimed += 1
        return self.responder(path)


class FalPhase2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self._close_connections)
        self.phase1_path = Path(self.temp.name) / "phase1.sqlite3"
        self.phase2_path = Path(self.temp.name) / "phase2.sqlite3"
        writable = open_state(self.phase1_path)
        writable.execute(
            """INSERT INTO seeds(
                 soundcharts_uuid,spotify_id,name,monthly_listeners,source_rank,status,updated_at)
               VALUES('seed-1','spotify-seed','Seed',50000,0,'complete','2026-07-31T00:00:00Z')"""
        )
        writable.execute(
            """INSERT INTO candidates(
                 soundcharts_uuid,spotify_id,name,monthly_listeners,status,evidence_json,
                 first_seen_at,updated_at)
               VALUES('candidate-1','spotify-candidate','Candidate',50000,
                      'review_inventory_complete','{}','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"""
        )
        writable.commit()
        writable.close()
        self.phase1 = open_phase1_state(self.phase1_path)
        self.phase2 = open_phase2_state(self.phase2_path)

    def _close_connections(self):
        for name in ("phase1", "phase2"):
            connection = getattr(self, name, None)
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass

    def add_track(self, uuid, release="2026-07-01", evidence=None, status="review_metadata_pending"):
        self.phase1.close()
        writable = open_state(self.phase1_path)
        writable.execute(
            """INSERT INTO tracks(
                 soundcharts_uuid,candidate_uuid,title,release_date,status,reason,
                 evidence_json,first_seen_at,updated_at)
               VALUES(?,?,?,?,?,'phase2_metadata_classification_required',?,?,?)""",
            (
                uuid,
                "candidate-1",
                uuid,
                release,
                status,
                json.dumps(evidence or {}),
                "2026-07-31T00:00:00Z",
                "2026-07-31T00:00:00Z",
            ),
        )
        writable.execute(
            "INSERT OR IGNORE INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES('candidate-1',?,'2026-07-31T00:00:00Z')",
            (uuid,),
        )
        writable.execute(
            "UPDATE candidates SET catalog_total=(SELECT COUNT(*) FROM candidate_tracks WHERE candidate_uuid='candidate-1') WHERE soundcharts_uuid='candidate-1'"
        )
        writable.commit()
        writable.close()
        self.phase1 = open_phase1_state(self.phase1_path)

    def migrate(self, maximum=10):
        return migrate_recent_queue(
            self.phase1,
            self.phase2,
            max_new_queue=maximum,
            active_queue_cap=maximum,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
        )

    def scanner(self, client, **kwargs):
        return Phase2Scanner(
            self.phase1,
            self.phase2,
            client,
            workers=1,
            retry_limit=2,
            canary_min_sample=500,
            continue_zero_yield=False,
            **kwargs,
        )

    def test_phase1_completion_gate_rejects_empty_or_pending_inventory(self):
        with self.assertRaises(FalPhase2Error):
            assert_phase1_complete(self.phase1)
        self.add_track("track-1")
        assert_phase1_complete(self.phase1)

        self.phase1.close()
        writable = open_state(self.phase1_path)
        writable.execute("UPDATE seeds SET status='pending'")
        writable.commit()
        writable.close()
        self.phase1 = open_phase1_state(self.phase1_path)
        with self.assertRaises(FalPhase2Error):
            assert_phase1_complete(self.phase1)

    def test_bounded_local_prefilter_queues_only_recent_tracks(self):
        self.add_track("recent-unknown")
        self.add_track("recent-vocal", evidence={"vocal": True})
        self.add_track("too-old", release="2020-01-01")
        self.add_track("date-unknown", release="")
        migration = self.migrate(maximum=3)
        self.assertEqual(migration.selected, 2)
        self.assertEqual(migration.pending, 1)
        self.assertEqual(migration.locally_blocked, 1)
        statuses = dict(
            self.phase2.execute(
                "SELECT track_uuid,queue_status FROM fal_phase2_queue ORDER BY track_uuid"
            ).fetchall()
        )
        self.assertEqual(statuses["recent-unknown"], "pending")
        self.assertEqual(statuses["recent-vocal"], "blocked_explicit_vocal")
        self.assertNotIn("too-old", statuses)
        self.assertNotIn("date-unknown", statuses)

    def test_artist_gate_blocks_superstar_before_any_track_detail_call(self):
        self.add_track("superstar-track")
        inserted, total = initialize_artist_gate(self.phase1, self.phase2)
        self.assertEqual(total, 1)
        client = FakeClient(
            lambda path: {
                "object": {
                    "name": "Candidate",
                    "careerStage": "superstar",
                    "genres": ["Ambient"],
                }
            }
        )
        scanner = ArtistGateScanner(self.phase2, client, workers=1, retry_limit=2)
        self.assertTrue(scanner.scan_batch())
        gate = self.phase2.execute(
            "SELECT gate_status,reason FROM fal_phase2_artist_gate WHERE candidate_uuid='candidate-1'"
        ).fetchone()
        self.assertEqual(tuple(gate), ("blocked", "career_stage_superstar"))
        migration = migrate_gated_track_queue(
            self.phase1,
            self.phase2,
            max_new_queue=10,
            active_queue_cap=10,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
        )
        self.assertEqual(migration.selected, 0)
        self.assertEqual(client.paths, ["/api/v2/artist/candidate-1"])

    def test_artist_gate_opens_track_queue_only_for_target_genre(self):
        self.add_track("ambient-track")
        initialize_artist_gate(self.phase1, self.phase2)
        client = FakeClient(
            lambda path: {
                "object": {
                    "name": "Candidate",
                    "careerStage": "mid_level",
                    "genres": [{"root": "Electronic", "sub": ["Dark Ambient"]}],
                }
            }
        )
        ArtistGateScanner(self.phase2, client, workers=1, retry_limit=2).scan_batch()
        migration = migrate_gated_track_queue(
            self.phase1,
            self.phase2,
            max_new_queue=10,
            active_queue_cap=10,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
        )
        self.assertEqual(migration.selected, 1)
        row = self.phase2.execute(
            "SELECT candidate_uuid,queue_status FROM fal_phase2_queue WHERE track_uuid='ambient-track'"
        ).fetchone()
        self.assertEqual(tuple(row), ("candidate-1", "pending"))

    def test_interleaved_budget_reserves_track_progress_before_all_gates_finish(self):
        budget = plan_interleaved_budget(
            500,
            artist_gate_active=19_075,
            track_details_paused=False,
        )
        self.assertEqual((budget.artist_gate, budget.track_detail), (400, 100))
        self.assertEqual(
            plan_interleaved_budget(
                2,
                artist_gate_active=19_075,
                track_details_paused=False,
            ).track_detail,
            1,
        )
        self.assertEqual(
            plan_interleaved_budget(
                500,
                artist_gate_active=0,
                track_details_paused=False,
            ).track_detail,
            500,
        )

    def test_automatic_run_enriches_a_gated_track_while_other_artist_gates_remain(self):
        self.add_track("ambient-track")
        initialize_artist_gate(self.phase1, self.phase2)
        now = "2026-07-31T00:00:00Z"
        for index in range(2, 6):
            self.phase2.execute(
                """INSERT INTO fal_phase2_artist_gate(
                     candidate_uuid,candidate_name,monthly_listeners,source_count,best_rank,
                     first_seen_at,updated_at)
                   VALUES(?,?,50000,0,?,?,?)""",
                (f"candidate-{index}", f"Candidate {index}", index, now, now),
            )
        self.phase2.commit()

        def respond(path):
            if path == "/api/v2/artist/candidate-1":
                return {
                    "object": {
                        "name": "Candidate",
                        "careerStage": "mid_level",
                        "genres": ["Ambient"],
                    }
                }
            if path.startswith("/api/v2/artist/"):
                return {"object": {"name": "Unknown", "genres": ["Electronic"]}}
            if path == "/api/v2.25/song/ambient-track":
                return {
                    "object": {
                        "name": "Ambient track",
                        "genres": [{"root": "Ambient", "sub": []}],
                        "audio": {"instrumentalness": 0.95, "speechiness": 0.01},
                    }
                }
            raise AssertionError(f"unexpected call: {path}")

        client = FakeClient(respond)
        result = run_interleaved_batches(
            self.phase1,
            self.phase2,
            client,
            allowed_requests=5,
            max_new_queue=10,
            active_queue_cap=10,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
            workers=1,
            retry_limit=2,
            canary_min_sample=500,
            continue_zero_yield=False,
            track_details_paused=False,
        )

        self.assertEqual((result.budget.artist_gate, result.budget.track_detail), (4, 1))
        self.assertEqual((result.artist_requests, result.track_requests), (4, 1))
        self.assertEqual(client.requests_claimed, 5)
        self.assertIsNotNone(
            self.phase2.execute(
                "SELECT 1 FROM fal_phase2_details WHERE track_uuid='ambient-track'"
            ).fetchone()
        )
        pending_gates = int(
            self.phase2.execute(
                """SELECT COUNT(*) FROM fal_phase2_artist_gate
                    WHERE gate_status IN ('pending','retry')"""
            ).fetchone()[0]
        )
        self.assertEqual(pending_gates, 1)

    def test_zero_yield_pause_spends_no_track_budget_but_keeps_gate_progress(self):
        budget = plan_interleaved_budget(
            500,
            artist_gate_active=19_075,
            track_details_paused=True,
        )
        self.assertEqual((budget.artist_gate, budget.track_detail), (500, 0))

    def test_new_phase1_source_reopens_artist_bulk_and_only_queues_new_tracks(self):
        self.add_track("z-existing-track")
        initialize_artist_gate(self.phase1, self.phase2)
        self.phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET gate_status='eligible',reason='target_genre_evidence'
                WHERE candidate_uuid='candidate-1'"""
        )
        self.phase2.commit()
        self.assertEqual(reconcile_phase1_source(self.phase2, "phase1-source-a"), 1)

        first = migrate_gated_track_queue(
            self.phase1,
            self.phase2,
            max_new_queue=10,
            active_queue_cap=10,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
        )
        self.assertEqual(first.selected, 1)
        initial_gate = self.phase2.execute(
            """SELECT bulk_cursor_track_uuid,bulk_complete
                 FROM fal_phase2_artist_gate WHERE candidate_uuid='candidate-1'"""
        ).fetchone()
        self.assertEqual(tuple(initial_gate), ("z-existing-track", 1))

        # This UUID sorts before the completed cursor. It is discoverable only
        # if the new immutable phase-1 source reopens the artist bulk scan.
        self.add_track("a-new-track")
        self.assertEqual(reconcile_phase1_source(self.phase2, "phase1-source-b"), 1)
        reopened_gate = self.phase2.execute(
            """SELECT bulk_cursor_track_uuid,bulk_complete
                 FROM fal_phase2_artist_gate WHERE candidate_uuid='candidate-1'"""
        ).fetchone()
        self.assertEqual(tuple(reopened_gate), ("", 0))

        second = migrate_gated_track_queue(
            self.phase1,
            self.phase2,
            max_new_queue=10,
            active_queue_cap=10,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
        )
        self.assertEqual(second.selected, 1)
        queued = [
            row[0]
            for row in self.phase2.execute(
                "SELECT track_uuid FROM fal_phase2_queue ORDER BY track_uuid"
            ).fetchall()
        ]
        self.assertEqual(queued, ["a-new-track", "z-existing-track"])
        self.assertEqual(len(queued), len(set(queued)))
        final_gate = self.phase2.execute(
            """SELECT bulk_cursor_track_uuid,bulk_complete
                 FROM fal_phase2_artist_gate WHERE candidate_uuid='candidate-1'"""
        ).fetchone()
        self.assertEqual(tuple(final_gate), ("z-existing-track", 1))

    def test_same_or_empty_phase1_source_keeps_completed_artist_cursor(self):
        self.add_track("stable-track")
        initialize_artist_gate(self.phase1, self.phase2)
        self.phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET gate_status='eligible',bulk_cursor_track_uuid='stable-track',bulk_complete=1
                WHERE candidate_uuid='candidate-1'"""
        )
        self.phase2.commit()
        self.assertEqual(reconcile_phase1_source(self.phase2, "phase1-source-a"), 1)
        self.phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET bulk_cursor_track_uuid='stable-track',bulk_complete=1
                WHERE candidate_uuid='candidate-1'"""
        )
        self.phase2.commit()

        self.assertEqual(reconcile_phase1_source(self.phase2, "phase1-source-a"), 0)
        self.assertEqual(reconcile_phase1_source(self.phase2, ""), 0)
        gate = self.phase2.execute(
            """SELECT bulk_cursor_track_uuid,bulk_complete
                 FROM fal_phase2_artist_gate WHERE candidate_uuid='candidate-1'"""
        ).fetchone()
        self.assertEqual(tuple(gate), ("stable-track", 1))

    def test_unknown_detail_stays_review_and_is_never_accepted(self):
        self.add_track("track-unknown")
        self.migrate()
        client = FakeClient(lambda path: {"object": {"name": "Unknown", "releaseDate": "2026-07-01"}})
        scanner = self.scanner(client)
        self.assertTrue(scanner.scan_batch())
        row = self.phase2.execute(
            "SELECT * FROM fal_phase2_details WHERE track_uuid='track-unknown'"
        ).fetchone()
        self.assertEqual(row["decision"], "review_metadata_unknown")
        self.assertEqual(row["instrumental_status"], "unknown")
        self.assertEqual(row["ai_risk"], "unknown")
        self.assertEqual(row["genre_status"], "unknown")
        self.assertEqual(client.requests_claimed, 1)

    def test_real_v225_instrumental_signal_stays_in_human_review_while_ai_is_unknown(self):
        self.add_track("track-ready")
        self.migrate()
        client = FakeClient(
            lambda path: {
                "type": "song",
                "object": {
                    "name": "Ready",
                    "genres": [
                        {"root": "Ambient", "sub": ["Dark Ambient", "Instrumental"]}
                    ],
                    "audio": {
                        "instrumentalness": 0.94,
                        "speechiness": 0.02,
                    },
                }
            }
        )
        self.scanner(client).scan_batch()
        row = self.phase2.execute(
            "SELECT * FROM fal_phase2_details WHERE track_uuid='track-ready'"
        ).fetchone()
        evidence = json.loads(row["evidence_json"])

        self.assertEqual(client.paths, ["/api/v2.25/song/track-ready"])
        self.assertEqual(row["instrumental_status"], "instrumental")
        self.assertEqual(row["genre_status"], "in_scope")
        self.assertEqual(row["ai_risk"], "unknown")
        self.assertTrue(row["decision"].startswith("review_"))
        self.assertNotEqual(row["decision"], "eligible")
        self.assertAlmostEqual(evidence["instrumentalness"], 0.94)
        self.assertAlmostEqual(evidence["speechiness"], 0.02)
        self.assertEqual(evidence["ai_risk"], "unknown")
        stats = evidence_yield(self.phase2)
        self.assertEqual(stats["useful_signal"], 1)
        self.assertEqual(stats["evidence_ready"], 0)
        self.assertFalse(canary_zero_yield(self.phase2, 1))

    def test_404_is_terminal_review_without_fabricated_metadata(self):
        self.add_track("track-404")
        self.migrate()

        def unavailable(_):
            raise SoundchartsDataUnavailableError(404)

        scanner = self.scanner(FakeClient(unavailable))
        scanner.scan_batch()
        row = self.phase2.execute(
            "SELECT queue_status,attempts FROM fal_phase2_queue WHERE track_uuid='track-404'"
        ).fetchone()
        self.assertEqual(row["queue_status"], "review_metadata_unavailable")
        self.assertEqual(row["attempts"], 0)

    def test_transient_failures_retry_then_stop_in_review(self):
        self.add_track("track-retry")
        self.migrate()

        def failed(_):
            raise SoundchartsError("temporary")

        scanner = self.scanner(FakeClient(failed))
        scanner.scan_batch()
        first = self.phase2.execute(
            "SELECT queue_status,attempts FROM fal_phase2_queue WHERE track_uuid='track-retry'"
        ).fetchone()
        self.assertEqual((first["queue_status"], first["attempts"]), ("retry", 1))
        scanner.scan_batch()
        second = self.phase2.execute(
            "SELECT queue_status,attempts FROM fal_phase2_queue WHERE track_uuid='track-retry'"
        ).fetchone()
        self.assertEqual((second["queue_status"], second["attempts"]), ("review_request_failed", 2))
        self.assertEqual(scanner.client.requests_claimed, 2)

    def test_zero_signal_canary_pauses_further_scheduled_spend(self):
        now = "2026-07-31T00:00:00Z"
        for index in range(2):
            self.phase2.execute(
                """INSERT INTO fal_phase2_details(
                     track_uuid,decision,reason,evidence_json,enriched_at)
                   VALUES(?, 'review_metadata_unknown','unknown','{}',?)""",
                (f"unknown-{index}", now),
            )
        self.phase2.commit()
        self.assertTrue(canary_zero_yield(self.phase2, 2))
        stats = evidence_yield(self.phase2)
        self.assertEqual(stats["useful_signal"], 0)
        self.assertEqual(stats["useful_signal_rate"], 0.0)

    def test_report_is_explicitly_staging_only(self):
        self.add_track("track-report")
        migration = self.migrate()
        report = build_report(
            self.phase1,
            self.phase2,
            migration=migration,
            recent_days=1095,
            as_of=dt.date(2026, 7, 31),
            active_queue_cap=5000,
            canary_min_sample=500,
        )
        self.assertTrue(report["staging_only"])
        self.assertFalse(report["canonical_written"])
        self.assertFalse(report["dashboard_written"])
        self.assertEqual(report["queue"]["active_cap"], 5000)
        self.assertTrue(report["details"]["unknowns_are_never_accepted"])
        self.assertEqual(report["version"], PHASE2_REPORT_VERSION)
        prefilter = report["prefilter"]
        self.assertEqual(
            prefilter["recent_review_pending_known_date_before_artist_gate"], 1
        )
        self.assertEqual(prefilter["recent_tracks_present_in_phase2_queue"], 1)
        self.assertNotIn("eligible_recent_not_yet_migrated", prefilter)

    def test_dry_run_simulates_queue_without_mutating_resumable_state(self):
        self.add_track("dry-run-track")
        initialize_artist_gate(self.phase1, self.phase2)
        self.phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET gate_status='eligible',bulk_complete=0
                WHERE candidate_uuid='candidate-1'"""
        )
        self.phase2.commit()
        self.phase1.close()
        self.phase2.close()
        self.phase1 = None
        self.phase2 = None
        before = self.phase2_path.read_bytes()
        report_path = Path(self.temp.name) / "dry-run-report.json"

        result = main(
            [
                "--phase1-state",
                str(self.phase1_path),
                "--state",
                str(self.phase2_path),
                "--report",
                str(report_path),
                "--max-new-queue",
                "10",
                "--active-queue-cap",
                "10",
                "--as-of",
                "2026-07-31",
                "--dry-run",
            ]
        )

        self.assertEqual(result, 0)
        self.assertEqual(self.phase2_path.read_bytes(), before)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["queue"]["migrated_this_run"], 1)
        self.phase1 = open_phase1_state(self.phase1_path)
        self.phase2 = open_phase2_state(self.phase2_path)
        self.assertEqual(
            self.phase2.execute("SELECT COUNT(*) FROM fal_phase2_queue").fetchone()[0],
            0,
        )

    def test_real_run_migrates_once_and_reports_that_same_migration(self):
        self.add_track("single-migration-track")
        initialize_artist_gate(self.phase1, self.phase2)
        self.phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET gate_status='eligible',bulk_complete=0
                WHERE candidate_uuid='candidate-1'"""
        )
        self.phase2.commit()
        self.phase1.close()
        self.phase2.close()
        self.phase1 = None
        self.phase2 = None
        report_path = Path(self.temp.name) / "real-run-report.json"

        class MainFakeClient:
            def __init__(self, *_args, **_kwargs):
                self.requests_claimed = 0
                self.quota_remaining = 10_000_000
                self.quota_reserve = 0
                self.request_limit = None

            def authenticate(self):
                return None

            def require_quota_reserve(self):
                return None

            def get(self, _path):
                self.requests_claimed += 1
                self.quota_remaining -= 1
                return {"object": {"name": "Single migration"}}

        with mock.patch(
            "scan_soundcharts_fal_phase2.SoundchartsClient", MainFakeClient
        ):
            result = main(
                [
                    "--phase1-state",
                    str(self.phase1_path),
                    "--state",
                    str(self.phase2_path),
                    "--report",
                    str(report_path),
                    "--max-requests",
                    "1",
                    "--max-new-queue",
                    "10",
                    "--active-queue-cap",
                    "10",
                    "--maintenance-daily-requests",
                    "0",
                    "--as-of",
                    "2026-07-31",
                    "--budget-as-of",
                    "2026-07-31",
                ]
            )

        self.assertEqual(result, 0)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["queue"]["migrated_this_run"], 1)
        self.assertEqual(report["requests"]["claimed_this_run"], 1)
        self.phase1 = open_phase1_state(self.phase1_path)
        self.phase2 = open_phase2_state(self.phase2_path)
        self.assertEqual(
            self.phase2.execute("SELECT COUNT(*) FROM fal_phase2_queue").fetchone()[0],
            1,
        )

    def test_phase2_uses_a_fresh_v2_private_state(self):
        self.assertEqual(PHASE2_STATE_VERSION, 2)
        self.assertEqual(PHASE2_REPORT_VERSION, 2)
        self.assertEqual(
            self.phase2.execute(
                "SELECT value FROM meta WHERE key='fal_phase2_state_version'"
            ).fetchone()[0],
            "2",
        )

    def test_cli_defaults_to_a_500_call_canary(self):
        args = parse_args(["--phase1-state", "phase1.sqlite3"])
        self.assertEqual(args.max_requests, 500)
        self.assertEqual(args.canary_min_sample, 500)
        self.assertFalse(args.continue_zero_yield)


if __name__ == "__main__":
    unittest.main()

