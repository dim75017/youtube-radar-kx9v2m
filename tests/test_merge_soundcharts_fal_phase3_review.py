import copy
import json
import tempfile
import unittest
from pathlib import Path

import merge_soundcharts_fal_phase3_review as merge
from build_soundcharts_fal_review_manifest import (
    BUCKET_ORDER,
    blocking_fields,
    classify_review_bucket,
    forbidden_genres_detected,
    stable_digest,
)


TRACK_ID_1 = "A" * 22
TRACK_ID_2 = "B" * 22
ARTIST_ID_1 = "C" * 22
ARTIST_ID_2 = "D" * 22
EVIDENCE_AT = "2026-08-19T08:00:00Z"


def refresh_row(record):
    evidence = record.get("source_evidence") or {}
    genres = list(record.get("genres") or []) + list(evidence.get("genres") or [])
    record["forbidden_genres_detected"] = forbidden_genres_detected(genres)
    record["identity_status"] = (
        "track_and_artist_complete"
        if record.get("spotify_identity_status") == "exact"
        and record.get("artist_identity_status") == "complete"
        and not record.get("duplicate_spotify_id")
        and not record.get("duplicate_isrc")
        else "incomplete"
    )
    record["blocking_fields"] = blocking_fields(record)
    record["review_bucket"], record["review_reason"] = classify_review_bucket(record)
    if record.get("rights_status") in {"major", "mixed"}:
        record["review_bucket"] = "blocked"
        record["review_reason"] = "explicit_blocking_rights_evidence"
    record["record_digest"] = merge.record_digest(record)
    return record


def refresh_manifest(payload):
    payload["tracks"] = [refresh_row(dict(row)) for row in payload["tracks"]]
    payload["track_schema"] = list(payload["tracks"][0]) if payload["tracks"] else []
    payload["records_digest"] = stable_digest(
        [row["record_digest"] for row in payload["tracks"]]
    )
    payload.setdefault("summary", {})["tracks"] = len(payload["tracks"])
    payload["summary"]["by_bucket"] = {
        bucket: sum(row["review_bucket"] == bucket for row in payload["tracks"])
        for bucket in BUCKET_ORDER
    }
    return payload


def phase2_record(number=1):
    spotify_id = TRACK_ID_1 if number == 1 else TRACK_ID_2
    row = {
        "track_uuid": f"track-{number}",
        "spotify_id": spotify_id,
        "detail_spotify_id": spotify_id,
        "stream_spotify_id": spotify_id,
        "spotify_url": f"https://open.spotify.com/track/{spotify_id}",
        "spotify_identity_status": "exact",
        "isrc": f"FRABC260000{number}",
        "title": f"Quiet Track {number}",
        "credit_name": f"Artist {number}",
        "release_date": "2026-08-01",
        "release_window_status": "within_window",
        "streams_total": 200_000 + number,
        "streams_source_date": "2026-08-18",
        "candidate_uuid": f"candidate-{number}",
        "candidate_name": f"Artist {number}",
        "monthly_listeners": 500_000,
        "source_count": 3,
        "best_rank": number,
        "career_stage": "growth",
        "artist_gate_status": "eligible",
        "artist_identity_status": "soundcharts_only",
        "instrumental_status": "instrumental",
        "genre_status": "in_scope",
        "ai_risk": "unknown",
        "rights_status": "unknown",
        "rights_confidence": None,
        "source_tier": "soundcharts_fal_phase2_private",
        "source_approved_for_publication": False,
        "instrumentalness": 0.91,
        "speechiness": 0.02,
        "explicit": False,
        "language_code": "zxx",
        "genres": ["lofi"],
        "forbidden_genres_detected": [],
        "duplicate_spotify_id": False,
        "duplicate_isrc": False,
        "source_evidence": {
            "genres": ["lofi"],
            "instrumental": True,
            "ai_risk": "unknown",
        },
        "phase2_decision": "review_required",
        "phase2_reason": "private_evidence_pending",
        "review_decision": "pending",
        "reviewer": "",
        "reviewed_at": "",
        "review_sources": [],
        "review_notes": "",
    }
    return refresh_row(row)


def phase2_manifest(rows=None):
    rows = list(rows or [phase2_record(1), phase2_record(2)])
    payload = {
        "version": 1,
        "generated_at": "2026-08-19T07:30:00Z",
        "source": {
            "kind": "soundcharts_fal_phase2_private_staging",
            "phase2_report_generated_at": "2026-08-19T07:00:00Z",
            "phase2_report_version": 4,
            "phase2_source_checkpoint": {
                "phase1_state_version": 2,
                "phase2_state_version": 3,
                "phase1_source_id": "101",
            },
            "phase2_state_sha256": "1" * 64,
            "phase2_report_sha256": "2" * 64,
        },
        "status": "human_review_required",
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "minimum_lifetime_streams": 100_000,
        "release_window": {
            "cutoff": "2025-08-19",
            "as_of": "2026-08-19",
            "inclusive": True,
        },
        "summary": {"tracks": len(rows)},
        "guardrails": {
            "stream_threshold_is_inclusive": True,
            "no_canonical_or_dashboard_write": True,
        },
        "records_digest": "",
        "track_schema": [],
        "tracks": rows,
    }
    return refresh_manifest(payload)


def mixed_phase2_manifest():
    priority = phase2_record(1)
    non_priority = phase2_record(2)
    non_priority["rights_status"] = "major"
    non_priority["rights_confidence"] = 0.99
    non_priority["source_evidence"].update(
        {
            "rights_status": "major",
            "rights_confidence": 0.99,
            "rights_basis": "phase2_explicit_major_rights",
        }
    )
    refresh_row(non_priority)
    return phase2_manifest([priority, non_priority])


def phase3_manifest(raw):
    payload = copy.deepcopy(raw)
    payload["generated_at"] = "2026-08-19T08:05:00Z"
    payload["status"] = "phase3_private_evidence_enriched_human_review_required"
    payload["promotion_executed"] = False
    payload["source"]["phase3_state_version"] = 1
    payload["guardrails"].update(merge.PHASE3_GUARDRAIL_ADDITIONS)
    for row in payload["tracks"]:
        row["source_evidence"].update(
            {
                "source": "soundcharts_song_v2_25",
                "source_contract": merge.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
                "evidence_updated_at": EVIDENCE_AT,
                "instrumental": True,
                "vocal": False,
                "genres": ["lofi", "ambient"],
                "ai_risk": "low",
                "rights_status": "self_released",
                "rights_confidence": 0.91,
                "rights_basis": "soundcharts_song_label_and_copyright",
                "no_lyrics": True,
            }
        )
        row.update(
            {
                "rights_status": "self_released",
                "rights_confidence": 0.91,
                "label": "Artist Self Release",
                "copyright": "2026 Artist",
                "no_lyrics": True,
                "ai_risk": "low",
                "artist_spotify_id": ARTIST_ID_1
                if row["track_uuid"] == "track-1"
                else ARTIST_ID_2,
                "artist_identity_status": "complete",
                "phase3_detail_status": "complete_provider",
                "phase3_artist_identity_source": "phase1_candidates_exact_spotify_id",
                "evidence_updated_at": EVIDENCE_AT,
                "source_contract": merge.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
                "source_approved_for_publication": False,
                "review_decision": "pending",
                "reviewer": "",
                "reviewed_at": "",
                "review_sources": [],
                "review_notes": "",
            }
        )
    return refresh_manifest(payload)


class Bundle:
    def __init__(self, root, raw=None, phase3=None):
        self.root = Path(root)
        self.raw_path = self.root / "phase2.json"
        self.phase3_path = self.root / "phase3.json"
        self.report_path = self.root / "phase3-report.json"
        self.output_path = self.root / "merged.json"
        self.raw = raw or phase2_manifest()
        self.phase3 = phase3 or phase3_manifest(self.raw)
        self.report = {}
        self.write_raw()
        self.write_phase3()
        self.report = self.make_report()
        self.write_report()

    @staticmethod
    def write_json(path, payload):
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def write_raw(self):
        self.write_json(self.raw_path, self.raw)

    def write_phase3(self, *, refresh=True, update_report=True):
        if refresh:
            refresh_manifest(self.phase3)
        self.write_json(self.phase3_path, self.phase3)
        if self.report and update_report:
            source = self.report["source"]
            source["enriched_manifest_sha256"] = merge.file_sha256(self.phase3_path)
            source["enriched_manifest_records_digest"] = self.phase3["records_digest"]
            source["enriched_manifest_row_count"] = len(self.phase3["tracks"])
            self.write_report()

    def make_report(self):
        active = 1
        priority_track_uuids = {
            str(row.get("track_uuid") or "")
            for row in self.raw["tracks"]
            if str(row.get("review_bucket") or "")
            == merge.ADVANCED_REVIEW_BUCKET
        }
        priority_rows = [
            row
            for row in self.phase3["tracks"]
            if str(row.get("track_uuid") or "") in priority_track_uuids
        ]
        (
            priority_artists,
            artist_complete,
            track_complete,
        ) = merge._phase3_manifest_technical_counts(priority_rows)
        priority_tracks = len(priority_rows)
        artist_unresolved = priority_artists - artist_complete
        track_unresolved = priority_tracks - track_complete
        state_unresolved = artist_unresolved + track_unresolved
        technical_complete = active == 0 and state_unresolved == 0
        return {
            "version": 1,
            "generated_at": "2026-08-19T08:06:00Z",
            "run_id": "12345-1",
            "status": "partial_private_evidence_retry_required",
            "complete": technical_complete,
            "technical_complete": technical_complete,
            "request_queue_exhausted": active == 0,
            "evidence_complete": False,
            "staging_only": True,
            "canonical_written": False,
            "dashboard_written": False,
            "promotion_executed": False,
            "row_level_data_uploaded_unencrypted": False,
            "minimum_lifetime_streams": 100_000,
            "source": {
                "kind": "soundcharts_fal_phase2_private_review_manifest",
                "phase2_source_artifact_id": "202",
                "phase1_source_artifact_id": "101",
                "phase2_state_sha256": "1" * 64,
                "phase2_report_sha256": "2" * 64,
                "phase1_state_sha256": "3" * 64,
                "cache_source_artifact_id": "",
                "cache_sha256": "",
                "review_manifest_sha256": merge.file_sha256(self.raw_path),
                "enriched_manifest_sha256": merge.file_sha256(self.phase3_path),
                "enriched_manifest_records_digest": self.phase3["records_digest"],
                "enriched_manifest_row_count": len(self.phase3["tracks"]),
                "state_sha256_before": "",
                "state_sha256_after": "4" * 64,
            },
            "policy": {
                "source_approval_remains_manual": True,
                "human_review_remains_manual": True,
                "automatic_promotion": False,
                "no_lyrics_requires_explicit_source_field": True,
                "ai_risk_never_inferred": True,
                "cache_track_terminal_contract": merge.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
                "cache_track_terminal_requires_timestamp": True,
                "cache_artist_terminal_requires_exact_id_and_identifiers_fetched_at": True,
                "cache_artifact_id_and_sha256_required": True,
                "phase1_artist_identity_join_before_network": True,
                "cross_source_identity_requires_live_provider_tiebreak": True,
                "artist_identifier_query_spotify_only_default": True,
                "provider_verified_never_tiebreaks": True,
                "provider_tiebreak_requires_unique_default_or_single_filtered_identity": True,
                "provider_tiebreak_must_match_phase1_or_cache": True,
                "audience_size_and_career_stage_never_block": True,
            },
            "coverage": {
                "priority_artists": priority_artists,
                "artist_identity_complete": artist_complete,
                "artist_state_unresolved": artist_unresolved,
                "priority_tracks": priority_tracks,
                "track_evidence_complete": track_complete,
                "track_state_technical_complete": track_complete,
                "track_state_unresolved": track_unresolved,
            },
            "requests": {
                "active_remaining": active,
                "terminal_unresolved": 0,
                "state_unresolved": state_unresolved,
            },
        }

    def write_report(self):
        self.write_json(self.report_path, self.report)

    def merge(self):
        return merge.merge_manifests(
            self.raw,
            self.phase3,
            self.report,
            phase2_manifest_sha256=merge.file_sha256(self.raw_path),
            phase3_manifest_sha256=merge.file_sha256(self.phase3_path),
            phase3_report_sha256=merge.file_sha256(self.report_path),
        )


class MergeSoundchartsFalPhase3ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = Bundle(self.temp.name)

    def make_mixed_bundle(self):
        raw = mixed_phase2_manifest()
        return Bundle(self.temp.name, raw=raw, phase3=phase3_manifest(raw))

    def test_happy_path_is_private_and_keeps_manual_fields_pending(self):
        payload = self.bundle.merge()
        self.assertTrue(payload["staging_only"])
        self.assertFalse(payload["canonical_written"])
        self.assertFalse(payload["dashboard_written"])
        self.assertFalse(payload["promotion_executed"])
        self.assertEqual(payload["summary"]["tracks"], 2)
        row = next(row for row in payload["tracks"] if row["track_uuid"] == "track-1")
        self.assertEqual(row["artist_spotify_id"], ARTIST_ID_1)
        self.assertEqual(row["artist_identity_status"], "complete")
        self.assertEqual(row["ai_risk"], "low")
        self.assertEqual(row["rights_status"], "self_released")
        self.assertTrue(row["no_lyrics"])
        self.assertFalse(row["source_approved_for_publication"])
        self.assertEqual(row["review_decision"], "pending")
        self.assertIn("source_tier", row["blocking_fields"])
        self.assertEqual(row["review_bucket"], "ai_review_required")
        self.assertEqual(row["record_digest"], merge.record_digest(row))
        self.assertEqual(
            payload["records_digest"],
            stable_digest([record["record_digest"] for record in payload["tracks"]]),
        )

    def test_cli_writes_the_private_merged_manifest(self):
        result = merge.main(
            [
                "--phase2-manifest",
                str(self.bundle.raw_path),
                "--phase3-manifest",
                str(self.bundle.phase3_path),
                "--phase3-report",
                str(self.bundle.report_path),
                "--output",
                str(self.bundle.output_path),
            ]
        )
        self.assertEqual(result, 0)
        payload = json.loads(self.bundle.output_path.read_text(encoding="utf-8"))
        self.assertTrue(payload["guardrails"]["identity_tuple_union_is_exact"])
        self.assertEqual(
            payload["source"]["merge"]["phase3_manifest_sha256"],
            merge.file_sha256(self.bundle.phase3_path),
        )

    def test_source_approval_is_part_of_record_digest_contract(self):
        row = copy.deepcopy(self.bundle.raw["tracks"][0])
        original = merge.record_digest(row)
        row["source_approved_for_publication"] = True
        self.assertNotEqual(merge.record_digest(row), original)

    def test_rejects_tampered_row_digest(self):
        self.bundle.phase3["tracks"][0]["title"] = "tampered without digest"
        self.bundle.write_phase3(refresh=False)
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "stale record digest"):
            self.bundle.merge()

    def test_rejects_phase3_manifest_hash_mismatch(self):
        self.bundle.report["source"]["enriched_manifest_sha256"] = "f" * 64
        self.bundle.write_report()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "enriched_manifest_sha256"):
            self.bundle.merge()

    def test_rejects_phase2_manifest_hash_mismatch(self):
        self.bundle.report["source"]["review_manifest_sha256"] = "e" * 64
        self.bundle.write_report()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "review_manifest_sha256"):
            self.bundle.merge()

    def test_rejects_missing_upstream_lineage_hash(self):
        self.bundle.report["source"]["phase1_state_sha256"] = ""
        self.bundle.write_report()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "Phase-1 state lineage"):
            self.bundle.merge()

    def test_accepts_a_fully_complete_technical_report(self):
        self.bundle.report["requests"].update(
            active_remaining=0,
            terminal_unresolved=0,
            state_unresolved=0,
        )
        self.bundle.report["request_queue_exhausted"] = True
        self.bundle.report["technical_complete"] = True
        self.bundle.report["complete"] = True
        self.bundle.write_report()

        payload = self.bundle.merge()

        self.assertEqual(payload["summary"]["tracks"], 2)

    def test_accepts_exhausted_queue_with_unresolved_private_state(self):
        row = self.bundle.phase3["tracks"][0]
        row["artist_spotify_id"] = ""
        row["artist_identity_status"] = "identity_conflict"
        row["phase3_artist_identity_source"] = (
            "cache_or_cross_source_identity_conflict"
        )
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"].update(
            active_remaining=0,
            terminal_unresolved=0,
            state_unresolved=1,
        )
        self.bundle.report["request_queue_exhausted"] = True
        self.bundle.report["technical_complete"] = False
        self.bundle.report["complete"] = False
        self.bundle.write_report()

        payload = self.bundle.merge()

        self.assertEqual(payload["summary"]["tracks"], 2)

    def test_rejects_complete_true_with_unresolved_private_state(self):
        row = self.bundle.phase3["tracks"][0]
        row["artist_spotify_id"] = ""
        row["artist_identity_status"] = "identity_conflict"
        row["phase3_artist_identity_source"] = (
            "cache_or_cross_source_identity_conflict"
        )
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"].update(
            active_remaining=0,
            terminal_unresolved=0,
            state_unresolved=1,
        )
        self.bundle.report["request_queue_exhausted"] = True
        self.bundle.report["technical_complete"] = False
        self.bundle.report["complete"] = True
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "completion flag disagrees with unresolved technical state",
        ):
            self.bundle.merge()

    def test_rejects_inconsistent_private_state_arithmetic(self):
        self.bundle.report["coverage"]["artist_state_unresolved"] = 1
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "artist state counts are arithmetically inconsistent",
        ):
            self.bundle.merge()

    def test_rejects_artist_completion_count_not_backed_by_manifest(self):
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "artist completion count disagrees with its manifest rows",
        ):
            self.bundle.merge()

    def test_rejects_track_completion_count_not_backed_by_manifest(self):
        self.bundle.report["coverage"].update(
            track_evidence_complete=1,
            track_state_technical_complete=1,
            track_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "track completion count disagrees with its manifest rows",
        ):
            self.bundle.merge()

    def test_rejects_false_flags_when_the_technical_state_is_complete(self):
        self.bundle.report["requests"]["active_remaining"] = 0
        self.bundle.report["request_queue_exhausted"] = True
        self.bundle.report["technical_complete"] = False
        self.bundle.report["complete"] = False
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "technical_complete flag disagrees with unresolved technical state",
        ):
            self.bundle.merge()

    def test_rejects_identity_tuple_union_mutation(self):
        self.bundle.phase3["tracks"][0]["spotify_id"] = "Z" * 22
        self.bundle.write_phase3()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "identity tuple unions differ"):
            self.bundle.merge()

    def test_rejects_missing_phase3_row_even_with_fresh_digests(self):
        self.bundle.phase3["tracks"].pop()
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            priority_artists=1,
            artist_identity_complete=1,
            priority_tracks=1,
            track_evidence_complete=1,
            track_state_technical_complete=1,
        )
        self.bundle.write_report()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "identity tuple unions differ"):
            self.bundle.merge()

    def test_mixed_manifest_counts_only_hash_bound_phase2_advanced_scope(self):
        bundle = self.make_mixed_bundle()

        self.assertEqual(
            [row["review_bucket"] for row in bundle.raw["tracks"]],
            [merge.ADVANCED_REVIEW_BUCKET, "blocked"],
        )
        self.assertEqual(bundle.report["coverage"]["priority_tracks"], 1)
        self.assertEqual(bundle.report["coverage"]["priority_artists"], 1)
        self.assertEqual(
            bundle.report["source"]["enriched_manifest_row_count"], 2
        )

        payload = bundle.merge()

        self.assertEqual(payload["summary"]["tracks"], 2)

    def test_mixed_manifest_rejects_removed_scoped_identity(self):
        bundle = self.make_mixed_bundle()
        bundle.phase3["tracks"] = [
            row
            for row in bundle.phase3["tracks"]
            if row["track_uuid"] != "track-1"
        ]
        bundle.write_phase3()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError, "identity tuple unions differ"
        ):
            bundle.merge()

    def test_mixed_manifest_rejects_added_scoped_identity(self):
        bundle = self.make_mixed_bundle()
        added = copy.deepcopy(bundle.phase3["tracks"][0])
        added.update(
            {
                "track_uuid": "track-added",
                "spotify_id": "E" * 22,
                "detail_spotify_id": "E" * 22,
                "stream_spotify_id": "E" * 22,
                "spotify_url": f"https://open.spotify.com/track/{'E' * 22}",
                "isrc": "FRABC2600099",
                "candidate_uuid": "candidate-added",
                "candidate_name": "Added Artist",
                "artist_spotify_id": "F" * 22,
            }
        )
        bundle.phase3["tracks"].append(added)
        bundle.write_phase3()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError, "identity tuple unions differ"
        ):
            bundle.merge()

    def test_mixed_manifest_rejects_mutated_scoped_identity(self):
        bundle = self.make_mixed_bundle()
        scoped = next(
            row for row in bundle.phase3["tracks"] if row["track_uuid"] == "track-1"
        )
        scoped["spotify_id"] = "Z" * 22
        bundle.write_phase3()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError, "identity tuple unions differ"
        ):
            bundle.merge()

    def test_rejects_authoritative_phase2_field_mutation(self):
        self.bundle.phase3["tracks"][0]["title"] = "Mutated title"
        self.bundle.write_phase3()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "authoritative Phase-2 field title"):
            self.bundle.merge()

    def test_rejects_non_allowlisted_source_evidence(self):
        self.bundle.phase3["tracks"][0]["source_evidence"]["invented_score"] = 1
        self.bundle.write_phase3()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "non-allowlisted"):
            self.bundle.merge()

    def test_accepts_provider_tiebreak_with_artist_provenance_and_no_song_evidence(self):
        row = self.bundle.phase3["tracks"][0]
        row["phase3_artist_identity_source"] = (
            "soundcharts_artist_identifiers_tiebreak"
        )
        row["phase3_artist_identity_contract"] = (
            merge.ARTIST_PROVIDER_IDENTITY_CONTRACT
        )
        row["phase3_artist_identity_observed_at"] = EVIDENCE_AT
        row["phase3_detail_status"] = "pending"
        row["source_contract"] = ""
        row["evidence_updated_at"] = ""
        row["source_evidence"]["source_contract"] = ""
        row["source_evidence"]["evidence_updated_at"] = ""
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            track_evidence_complete=1,
            track_state_technical_complete=1,
            track_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        payload = self.bundle.merge()

        merged = next(
            row for row in payload["tracks"] if row["track_uuid"] == "track-1"
        )
        self.assertEqual(merged["artist_spotify_id"], ARTIST_ID_1)
        self.assertEqual(merged["artist_identity_status"], "complete")
        self.assertEqual(
            merged["phase3_artist_identity_source"],
            "soundcharts_artist_identifiers_tiebreak",
        )
        self.assertEqual(
            merged["phase3_artist_identity_contract"],
            merge.ARTIST_PROVIDER_IDENTITY_CONTRACT,
        )
        self.assertEqual(
            merged["phase3_artist_identity_observed_at"], EVIDENCE_AT
        )
        self.assertEqual(merged["phase3_detail_status"], "pending")
        self.assertEqual(merged["source_contract"], "")
        self.assertEqual(merged["evidence_updated_at"], "")

    def test_rejects_provider_tiebreak_without_exact_artist_provenance(self):
        row = self.bundle.phase3["tracks"][0]
        row["phase3_artist_identity_source"] = (
            "soundcharts_artist_identifiers_tiebreak"
        )
        row["phase3_artist_identity_contract"] = "untrusted-provider-contract"
        row["phase3_artist_identity_observed_at"] = EVIDENCE_AT
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "provider artist identity lacks its exact contract/provenance",
        ):
            self.bundle.merge()

    def test_rejects_provider_tiebreak_with_naive_artist_timestamp(self):
        row = self.bundle.phase3["tracks"][0]
        row["phase3_artist_identity_source"] = (
            "soundcharts_artist_identifiers_tiebreak"
        )
        row["phase3_artist_identity_contract"] = (
            merge.ARTIST_PROVIDER_IDENTITY_CONTRACT
        )
        row["phase3_artist_identity_observed_at"] = "2026-08-19T08:00:00"
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "provider artist identity lacks its exact contract/provenance",
        ):
            self.bundle.merge()

    def test_rejects_unknown_artist_identity_source(self):
        self.bundle.phase3["tracks"][0]["phase3_artist_identity_source"] = (
            "untrusted_artist_identity_source"
        )
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "unsupported artist identity source",
        ):
            self.bundle.merge()

    def test_rejects_complete_identity_carried_by_a_conflict_source(self):
        row = self.bundle.phase3["tracks"][0]
        row["phase3_artist_identity_source"] = (
            "cache_or_cross_source_identity_conflict"
        )
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            artist_identity_complete=1,
            artist_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()

        with self.assertRaisesRegex(
            merge.FalPhase3ReviewMergeError,
            "conflict artist identity source cannot be complete",
        ):
            self.bundle.merge()

    def test_rejects_automated_human_review(self):
        self.bundle.phase3["tracks"][0]["review_decision"] = "approved"
        self.bundle.phase3["tracks"][0]["reviewer"] = "robot"
        self.bundle.write_phase3()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "manual field"):
            self.bundle.merge()

    def test_unproven_positive_phase3_evidence_is_not_received(self):
        row = self.bundle.phase3["tracks"][0]
        row["source_contract"] = ""
        row["evidence_updated_at"] = ""
        row["source_evidence"]["source_contract"] = ""
        row["source_evidence"]["evidence_updated_at"] = ""
        self.bundle.write_phase3()
        self.bundle.report["coverage"].update(
            track_evidence_complete=1,
            track_state_technical_complete=1,
            track_state_unresolved=1,
        )
        self.bundle.report["requests"]["state_unresolved"] = 1
        self.bundle.write_report()
        payload = self.bundle.merge()
        merged = next(row for row in payload["tracks"] if row["track_uuid"] == "track-1")
        self.assertEqual(merged["ai_risk"], "unknown")
        self.assertEqual(merged["rights_status"], "unknown")
        self.assertFalse(merged["no_lyrics"])
        self.assertEqual(merged["source_contract"], "")

    def test_negative_evidence_is_sticky_and_confidence_stays_attached(self):
        raw_row = self.bundle.raw["tracks"][0]
        raw_row["source_evidence"].update(
            {
                "vocal": True,
                "instrumental": False,
                "ai_risk": "high",
                "rights_status": "major",
                "rights_confidence": 0.3,
                "rights_basis": "major_label_copyright",
                "no_lyrics": False,
            }
        )
        raw_row["instrumental_status"] = "vocal"
        raw_row["ai_risk"] = "high"
        raw_row["rights_status"] = "major"
        raw_row["rights_confidence"] = 0.3
        raw_row["no_lyrics"] = False
        refresh_manifest(self.bundle.raw)
        self.bundle.write_raw()

        self.bundle.phase3 = phase3_manifest(self.bundle.raw)
        p3 = self.bundle.phase3["tracks"][0]
        p3["instrumental_status"] = "vocal"
        p3["source_evidence"].update(
            {
                "vocal": False,
                "instrumental": True,
                "ai_risk": "low",
                "rights_status": "self_released",
                "rights_confidence": 0.9,
                "no_lyrics": True,
            }
        )
        p3["ai_risk"] = "low"
        p3["rights_status"] = "self_released"
        p3["rights_confidence"] = 0.9
        p3["no_lyrics"] = True
        self.bundle.write_phase3(update_report=False)
        self.bundle.report = self.bundle.make_report()
        self.bundle.write_report()

        payload = self.bundle.merge()
        merged = next(row for row in payload["tracks"] if row["track_uuid"] == "track-1")
        self.assertEqual(merged["instrumental_status"], "vocal")
        self.assertEqual(merged["ai_risk"], "high")
        self.assertEqual(merged["rights_status"], "major")
        self.assertEqual(merged["rights_confidence"], 0.3)
        self.assertFalse(merged["no_lyrics"])
        self.assertEqual(merged["review_bucket"], "blocked")

    def test_rejects_conflicting_exact_artist_identity(self):
        raw = self.bundle.raw["tracks"][0]
        raw["artist_spotify_id"] = ARTIST_ID_2
        raw["artist_spotify_ids"] = [ARTIST_ID_2]
        raw["artists"] = [{"name": "Artist 1", "spotify_id": ARTIST_ID_2}]
        raw["artist_identity_status"] = "complete"
        refresh_manifest(self.bundle.raw)
        self.bundle.write_raw()

        self.bundle.phase3 = phase3_manifest(self.bundle.raw)
        p3 = self.bundle.phase3["tracks"][0]
        p3["artist_spotify_id"] = ARTIST_ID_1
        p3["artist_identity_status"] = "complete"
        self.bundle.write_phase3(update_report=False)
        self.bundle.report = self.bundle.make_report()
        self.bundle.write_report()
        with self.assertRaisesRegex(merge.FalPhase3ReviewMergeError, "conflicts with Phase-2 identity"):
            self.bundle.merge()


if __name__ == "__main__":
    unittest.main()
