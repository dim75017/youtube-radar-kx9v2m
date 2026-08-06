import json
import tempfile
import unittest
from pathlib import Path

from build_soundcharts_fal_promotion_cohort import (
    FalPromotionError,
    build_cohort,
    main,
)


TRACK_ID = "1" * 22
OTHER_TRACK_ID = "2" * 22
CANONICAL_TRACK_ID = "3" * 22
ARTIST_ID = "A" * 22


def canonical_payload(*track_ids):
    ids = list(track_ids or (CANONICAL_TRACK_ID,))
    return {
        "version": 1,
        "policy": {"minimum_lifetime_streams": 100_000},
        "discovery_catalogue": {
            "track_schema": ["spotify_id", "title"],
            "tracks": [[spotify_id, "Canonical"] for spotify_id in ids],
        },
        "active_legacy_spotify_ids": ids,
        "trusted_internal_spotify_ids": ids,
    }


def ready_record(spotify_id=TRACK_ID, track_uuid="track-ready", isrc="FRREADY00001"):
    return {
        "track_uuid": track_uuid,
        "spotify_id": spotify_id,
        "spotify_identity_status": "exact",
        "isrc": isrc,
        "title": "Quiet Horizon",
        "credit_name": "Small Artist",
        "release_date": "2026-01-12",
        "release_window_status": "within_window",
        "streams_total": 250_000,
        "streams_source_date": "2026-08-04",
        "candidate_uuid": "artist-soundcharts-1",
        "candidate_name": "Small Artist",
        "artist_identity_status": "complete",
        "artist_spotify_id": ARTIST_ID,
        "instrumental_status": "instrumental",
        "genre_status": "in_scope",
        "genres": ["Ambient"],
        "forbidden_genres_detected": [],
        "ai_risk": "low",
        "rights_status": "self_released",
        "rights_confidence": 0.9,
        "source_tier": "verified_soundcharts_and_manual_review",
        "source_approved_for_publication": True,
        "source_evidence": {
            "instrumental": True,
            "vocal": False,
            "genres": ["Ambient"],
            "ai_risk": "low",
            "rights_status": "self_released",
            "is_superstar": False,
        },
        "phase2_decision": "review_evidence_ready",
        "review_bucket": "promotion_ready",
        "review_decision": "approved",
        "reviewer": "A&R reviewer",
        "reviewed_at": "2026-08-06T09:00:00Z",
        "review_sources": ["Soundcharts song profile", "Spotify artist profile"],
        "review_notes": "Evidence checked; canonical promotion still requires Dim.",
        "record_digest": "source-record-digest",
    }


def manifest(*records):
    rows = list(records)
    return {
        "version": 1,
        "generated_at": "2026-08-06T08:30:00Z",
        "status": "human_review_required",
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "minimum_lifetime_streams": 100_000,
        "summary": {"tracks": len(rows)},
        "records_digest": "manifest-records-digest",
        "tracks": rows,
    }


class SoundchartsFalPromotionCohortTests(unittest.TestCase):
    def test_only_fully_evidenced_reviewed_noncanonical_row_enters_cohort(self):
        cohort, summary = build_cohort(
            manifest(ready_record()),
            canonical_payload(),
            source_manifest_sha256="manifest-sha",
            canonical_sha256="canonical-sha",
        )

        self.assertEqual(summary["promotion_candidate_track_count"], 1)
        self.assertEqual(summary["promotion_candidate_artist_count"], 1)
        self.assertEqual(summary["blocked_row_count"], 0)
        self.assertEqual(len(cohort["tracks"]), 1)
        self.assertEqual(cohort["tracks"][0]["spotify_id"], TRACK_ID)
        self.assertEqual(cohort["tracks"][0]["blocking_fields"], [])
        self.assertTrue(
            cohort["tracks"][0]["explicit_dim_promotion_validation_required"]
        )
        self.assertFalse(cohort["canonical_written"])
        self.assertFalse(cohort["dashboard_written"])
        self.assertFalse(cohort["promotion_executed"])
        self.assertEqual(cohort["status"], "awaiting_explicit_dim_validation")
        self.assertTrue(cohort["tracks"][0]["opportunity_eligible"])
        self.assertFalse(cohort["tracks"][0]["ai_review_required"])

    def test_exact_canonical_spotify_id_is_excluded_without_fuzzy_matching(self):
        cohort, summary = build_cohort(
            manifest(ready_record(spotify_id=CANONICAL_TRACK_ID)),
            canonical_payload(CANONICAL_TRACK_ID),
        )

        self.assertEqual(cohort["tracks"], [])
        self.assertEqual(summary["canonical_duplicate_row_count"], 1)
        self.assertEqual(
            summary["blocking_field_counts"]["canonical_duplicate_spotify_id"], 1
        )
        self.assertEqual(summary["promotion_candidate_track_count"], 0)
        self.assertEqual(
            cohort["canonical_comparison"]["method"],
            "exact_spotify_track_id_only",
        )
        self.assertFalse(cohort["canonical_comparison"]["fuzzy_matching_used"])

    def test_missing_no_lyrics_and_non_superstar_evidence_never_gets_inferred(self):
        record = ready_record()
        record["monthly_listeners"] = 50_001
        record["career_stage"] = "emerging"
        record["speechiness"] = 0.01
        record["source_evidence"].pop("vocal")
        record["source_evidence"].pop("is_superstar")

        cohort, summary = build_cohort(manifest(record), canonical_payload())

        self.assertEqual(cohort["tracks"], [])
        self.assertEqual(summary["blocking_field_counts"]["no_lyrics_evidence"], 1)
        self.assertEqual(
            summary["blocking_field_counts"]["non_superstar_evidence"], 1
        )
        self.assertEqual(summary["unknown_or_unproven_row_count"], 1)

    def test_current_phase2_unknown_rights_source_identity_and_ai_stays_excluded(self):
        record = ready_record()
        record.update(
            {
                "artist_identity_status": "soundcharts_only",
                "artist_spotify_id": "",
                "ai_risk": "unknown",
                "rights_status": "unknown",
                "rights_confidence": None,
                "source_tier": "soundcharts_fal_phase2_private",
                "source_approved_for_publication": False,
                "review_decision": "pending",
                "reviewer": "",
                "reviewed_at": "",
                "review_sources": [],
            }
        )
        record["source_evidence"]["ai_risk"] = "unknown"

        cohort, summary = build_cohort(manifest(record), canonical_payload())

        self.assertEqual(cohort["tracks"], [])
        for blocker in (
            "artist_identity",
            "artist_spotify_id",
            "rights_evidence",
            "source_approval",
            "human_review",
        ):
            self.assertEqual(summary["blocking_field_counts"][blocker], 1)

    def test_ai_unknown_can_only_enter_catalogue_review_lane(self):
        record = ready_record()
        record["ai_risk"] = "unknown"
        record["source_evidence"]["ai_risk"] = "unknown"

        cohort, summary = build_cohort(manifest(record), canonical_payload())

        self.assertEqual(summary["promotion_candidate_track_count"], 1)
        self.assertEqual(summary["ai_review_required_candidate_track_count"], 1)
        self.assertEqual(summary["opportunity_candidate_track_count"], 0)
        self.assertTrue(cohort["tracks"][0]["ai_review_required"])
        self.assertFalse(cohort["tracks"][0]["opportunity_eligible"])

    def test_ai_high_is_excluded_from_every_lane(self):
        record = ready_record()
        record["ai_risk"] = "high"
        record["source_evidence"]["ai_risk"] = "high"

        cohort, summary = build_cohort(manifest(record), canonical_payload())

        self.assertEqual(cohort["tracks"], [])
        self.assertEqual(summary["blocking_field_counts"]["ai_high_risk"], 1)

    def test_duplicate_spotify_id_or_isrc_excludes_every_conflicting_row(self):
        first = ready_record(track_uuid="first", isrc="FRDUP0000001")
        second = ready_record(track_uuid="second", isrc="FRDUP0000001")
        second["title"] = "Second Name"

        cohort, summary = build_cohort(manifest(first, second), canonical_payload())

        self.assertEqual(cohort["tracks"], [])
        self.assertEqual(summary["blocking_field_counts"]["duplicate_spotify_id"], 2)
        self.assertEqual(summary["blocking_field_counts"]["duplicate_isrc"], 2)

    def test_summary_is_aggregate_only_and_contains_no_row_identifiers(self):
        _, summary = build_cohort(manifest(ready_record()), canonical_payload())
        encoded = json.dumps(summary, sort_keys=True)

        self.assertNotIn(TRACK_ID, encoded)
        self.assertNotIn(ARTIST_ID, encoded)
        self.assertNotIn("Quiet Horizon", encoded)
        self.assertNotIn('"tracks"', encoded)
        self.assertFalse(summary["row_level_data_uploaded"])
        self.assertTrue(summary["explicit_dim_validation_required"])

    def test_invalid_or_non_staging_inputs_fail_closed(self):
        bad_manifest = manifest(ready_record())
        bad_manifest["staging_only"] = False
        with self.assertRaises(FalPromotionError):
            build_cohort(bad_manifest, canonical_payload())

        bad_canonical = canonical_payload()
        bad_canonical["policy"]["minimum_lifetime_streams"] = 0
        with self.assertRaises(FalPromotionError):
            build_cohort(manifest(ready_record()), bad_canonical)

    def test_cli_writes_private_rows_separately_from_aggregate_summary(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            review_path = root / "review.json"
            canonical_path = root / "canonical.js"
            cohort_path = root / "private" / "cohort.json"
            summary_path = root / "aggregate" / "summary.json"
            review_path.write_text(json.dumps(manifest(ready_record())), encoding="utf-8")
            canonical_path.write_text(
                "window.SPOTIFY_BROWSE_CATALOGUE="
                + json.dumps(canonical_payload())
                + ";\n",
                encoding="utf-8",
            )

            result = main(
                [
                    "--review-manifest",
                    str(review_path),
                    "--canonical",
                    str(canonical_path),
                    "--private-cohort-out",
                    str(cohort_path),
                    "--summary-out",
                    str(summary_path),
                ]
            )

            self.assertEqual(result, 0)
            private_payload = json.loads(cohort_path.read_text(encoding="utf-8"))
            public_summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(len(private_payload["tracks"]), 1)
            self.assertNotIn("tracks", public_summary)
            self.assertFalse(public_summary["row_level_data_uploaded"])


if __name__ == "__main__":
    unittest.main()
