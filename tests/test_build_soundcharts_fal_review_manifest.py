import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from build_soundcharts_fal_review_manifest import (
    FalReviewError,
    build_manifest,
    classify_review_bucket,
    main,
    open_read_only,
)
from scan_soundcharts_fal_phase2 import open_phase2_state


class FalReviewManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state_path = self.root / "phase2.sqlite3"
        self.report_path = self.root / "phase2-report.json"
        self.json_path = self.root / "review.json"
        self.tsv_path = self.root / "review.tsv"
        self.db = open_phase2_state(self.state_path)
        self.db.execute(
            """INSERT INTO fal_phase2_artist_gate(
                 candidate_uuid,candidate_name,monthly_listeners,source_count,best_rank,
                 gate_status,reason,career_stage,evidence_json,bulk_complete,
                 first_seen_at,updated_at)
               VALUES('artist-1','Artist',50000,3,2,'eligible','target_genre_evidence',
                      'long_tail','{}',1,'2026-08-04T00:00:00Z','2026-08-04T00:00:00Z')"""
        )
        self.report = {
            "version": 4,
            "generated_at": "2026-08-04T06:30:42Z",
            "complete": True,
            "staging_only": True,
            "canonical_written": False,
            "dashboard_written": False,
            "source_checkpoint": {"phase1_source_id": "phase1"},
            "prefilter": {
                "as_of": "2026-08-04",
                "release_cutoff": "2023-08-05",
                "recent_days": 1095,
            },
            "stream_gate": {
                "minimum_streams": 100000,
                "missing_or_ambiguous_never_passes": True,
                "status_counts": {"eligible": 0},
            },
        }

    def tearDown(self):
        self.db.close()

    def add_track(
        self,
        uuid,
        *,
        streams=100000,
        instrumental="instrumental",
        genre="in_scope",
        ai="unknown",
        decision="review_instrumental_signal",
        evidence=None,
        release_date="2026-07-01",
        detail_spotify_id=None,
        stream_spotify_id=None,
        isrc=None,
    ):
        now = "2026-08-04T00:00:00Z"
        generated_spotify_id = ("A" + "".join(ch for ch in uuid if ch.isalnum())).ljust(
            22, "0"
        )[:22]
        detail_spotify_id = (
            generated_spotify_id if detail_spotify_id is None else detail_spotify_id
        )
        stream_spotify_id = (
            generated_spotify_id if stream_spotify_id is None else stream_spotify_id
        )
        isrc = f"ISRC{uuid}" if isrc is None else isrc
        self.db.execute(
            """INSERT INTO fal_phase2_queue(
                 track_uuid,candidate_uuid,release_date,queue_status,local_reason,
                 queued_at,updated_at)
               VALUES(?,'artist-1',?, ?, 'review',?,?)""",
            (uuid, release_date, decision, now, now),
        )
        self.db.execute(
            """INSERT INTO fal_phase2_details(
                 track_uuid,spotify_id,isrc,title,credit_name,release_date,
                 instrumental_status,ai_risk,genre_status,decision,reason,
                 evidence_json,enriched_at)
               VALUES(?,?,?,?,?,?,?,?,?,?, 'review',?,?)""",
            (
                uuid,
                detail_spotify_id,
                isrc,
                f"Title {uuid}",
                "Artist",
                release_date,
                instrumental,
                ai,
                genre,
                decision,
                json.dumps(
                    evidence
                    or {
                        "genres": ["ambient"],
                        "instrumentalness": 0.95,
                        "speechiness": 0.02,
                        "explicit": False,
                    }
                ),
                now,
            ),
        )
        self.db.execute(
            """INSERT INTO fal_phase2_stream_gate(
                 track_uuid,spotify_id,gate_status,reason,streams_total,source_date,
                 history_json,queued_at,updated_at)
               VALUES(?,?,'eligible','lifetime_stream_threshold_met',?,'2026-08-03',
                      '[]',?,?)""",
            (uuid, stream_spotify_id, streams, now, now),
        )
        self.db.commit()

    def build(self):
        self.report["stream_gate"]["status_counts"]["eligible"] = self.db.execute(
            "SELECT COUNT(*) FROM fal_phase2_stream_gate WHERE gate_status='eligible'"
        ).fetchone()[0]
        return build_manifest(self.db, self.report, minimum_streams=100000)

    def test_ai_unknown_never_becomes_promotion_ready(self):
        self.add_track("track-ai-unknown")
        manifest = self.build()
        self.assertEqual(
            manifest["summary"]["by_bucket"]["ai_review_required"], 1
        )
        self.assertEqual(manifest["summary"]["by_bucket"]["promotion_ready"], 0)
        self.assertEqual(manifest["tracks"][0]["ai_risk"], "unknown")

    def test_only_complete_evidence_reaches_promotion_ready(self):
        self.add_track("track-ready", ai="low")
        self.add_track("track-genre", genre="unknown")
        self.add_track("track-instrumental", instrumental="unknown")
        manifest = self.build()
        counts = manifest["summary"]["by_bucket"]
        self.assertEqual(counts["promotion_ready"], 0)
        self.assertEqual(counts["ai_review_required"], 1)
        self.assertEqual(counts["genre_review_required"], 1)
        self.assertEqual(counts["instrumental_review_required"], 1)
        ready = next(row for row in manifest["tracks"] if row["track_uuid"] == "track-ready")
        self.assertIn("artist_spotify_id", ready["blocking_fields"])
        self.assertIn("rights_status", ready["blocking_fields"])
        self.assertIn("source_tier", ready["blocking_fields"])

    def test_explicit_vocal_is_blocked_even_with_other_positive_labels(self):
        bucket = classify_review_bucket(
            {
                "phase2_decision": "blocked_explicit_vocal",
                "instrumental_status": "instrumental",
                "genre_status": "in_scope",
                "ai_risk": "low",
            }
        )
        self.assertEqual(bucket[0], "blocked")

    def test_target_plus_forbidden_genre_is_removed_from_first_review_batch(self):
        self.add_track(
            "track-classical-pop",
            evidence={
                "genres": ["Classical", "Indie Pop"],
                "instrumentalness": 0.95,
                "speechiness": 0.02,
                "explicit": False,
            },
        )
        manifest = self.build()
        track = manifest["tracks"][0]
        self.assertEqual(track["review_bucket"], "genre_conflict_review_required")
        self.assertEqual(track["forbidden_genres_detected"], ["pop"])
        self.assertIn("genre_conflict", track["blocking_fields"])

    def test_release_cutoff_and_future_rows_never_enter_first_review_batch(self):
        self.add_track("track-too-old", release_date="2023-08-04")
        self.add_track("track-cutoff", release_date="2023-08-05")
        self.add_track("track-future", release_date="2026-08-05")
        self.add_track("track-missing-date", release_date="")
        self.add_track("track-invalid-date", release_date="not-a-date")
        manifest = self.build()
        by_uuid = {row["track_uuid"]: row for row in manifest["tracks"]}
        self.assertEqual(
            by_uuid["track-too-old"]["review_bucket"],
            "release_window_review_required",
        )
        self.assertEqual(
            by_uuid["track-future"]["review_bucket"],
            "release_window_review_required",
        )
        self.assertEqual(by_uuid["track-cutoff"]["review_bucket"], "ai_review_required")
        self.assertEqual(
            by_uuid["track-missing-date"]["review_bucket"],
            "release_window_review_required",
        )
        self.assertEqual(
            by_uuid["track-invalid-date"]["review_bucket"],
            "release_window_review_required",
        )
        self.assertIn("release_window", by_uuid["track-too-old"]["blocking_fields"])
        self.assertEqual(
            manifest["summary"]["by_bucket"]["release_window_review_required"], 4
        )

    def test_spotify_identity_mismatch_and_duplicates_are_quarantined(self):
        spotify_a = "4vFL08pP0H9RDUVj05qXyL"
        spotify_b = "5UpeJ6WZJdbX2ucwsYIRua"
        self.add_track(
            "track-mismatch",
            detail_spotify_id=spotify_a,
            stream_spotify_id=spotify_b,
        )
        self.add_track("track-duplicate-a", detail_spotify_id=spotify_a, stream_spotify_id=spotify_a, isrc="SAMEISRC")
        self.add_track("track-duplicate-b", detail_spotify_id=spotify_a, stream_spotify_id=spotify_a, isrc="SAMEISRC")
        manifest = self.build()
        by_uuid = {row["track_uuid"]: row for row in manifest["tracks"]}
        self.assertEqual(
            by_uuid["track-mismatch"]["review_bucket"],
            "identity_conflict_review_required",
        )
        self.assertEqual(by_uuid["track-mismatch"]["spotify_identity_status"], "mismatch")
        for uuid in ("track-duplicate-a", "track-duplicate-b"):
            self.assertEqual(
                by_uuid[uuid]["review_bucket"],
                "identity_conflict_review_required",
            )
            self.assertTrue(by_uuid[uuid]["duplicate_spotify_id"])
            self.assertTrue(by_uuid[uuid]["duplicate_isrc"])

    def test_report_eligible_count_is_mandatory_and_exact(self):
        self.add_track("track-report-count")
        del self.report["stream_gate"]["status_counts"]["eligible"]
        with self.assertRaisesRegex(FalReviewError, "eligible stream count"):
            build_manifest(self.db, self.report, minimum_streams=100000)

    def test_inclusive_100k_floor_and_invalid_eligible_row_fails_closed(self):
        self.add_track("track-100k", streams=100000, ai="low")
        self.assertEqual(self.build()["summary"]["tracks"], 1)
        self.db.execute(
            "UPDATE fal_phase2_stream_gate SET streams_total=99999 WHERE track_uuid='track-100k'"
        )
        self.db.commit()
        with self.assertRaisesRegex(FalReviewError, "invalid rows"):
            self.build()

    def test_cli_writes_review_artifacts_without_mutating_sqlite(self):
        self.add_track("track-cli")
        self.report["stream_gate"]["status_counts"]["eligible"] = 1
        self.report_path.write_text(json.dumps(self.report), encoding="utf-8")
        self.db.close()
        before = self.state_path.read_bytes()
        result = main(
            [
                "--state",
                str(self.state_path),
                "--phase2-report",
                str(self.report_path),
                "--json-out",
                str(self.json_path),
                "--tsv-out",
                str(self.tsv_path),
            ]
        )
        self.db = sqlite3.connect(self.state_path)
        self.assertEqual(result, 0)
        self.assertEqual(self.state_path.read_bytes(), before)
        payload = json.loads(self.json_path.read_text(encoding="utf-8"))
        self.assertTrue(payload["staging_only"])
        self.assertFalse(payload["canonical_written"])
        self.assertFalse(payload["dashboard_written"])
        self.assertTrue(payload["guardrails"]["unknown_ai_never_promotion_ready"])
        self.assertTrue(
            payload["guardrails"]["identity_rights_and_source_approval_required"]
        )
        self.assertEqual(len(payload["records_digest"]), 64)
        self.assertEqual(len(payload["tracks"][0]["record_digest"]), 64)
        self.assertIn("track-cli", self.tsv_path.read_text(encoding="utf-8"))

    def test_read_only_open_rejects_missing_state(self):
        with self.assertRaises(FalReviewError):
            open_read_only(self.root / "missing.sqlite3")


if __name__ == "__main__":
    unittest.main()
