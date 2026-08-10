import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from enrich_soundcharts_fal_phase3 import (
    ADVANCED_BUCKET,
    FalPhase3Error,
    RequestTask,
    _store_song_response,
    build_enriched_manifest,
    build_report,
    file_sha256,
    hydrate_artist_identities_from_phase1,
    hydrate_from_cache,
    main,
    open_state,
    pending_tasks,
    seed_advanced_bucket,
    strict_track_evidence,
    validate_manifest,
)
from expand_soundcharts_instrumental_pool import SOUNDCHARTS_SONG_EVIDENCE_CONTRACT


TRACK_ID = "1" * 22
ARTIST_ID = "A" * 22
TRACK_UUID = "track-soundcharts-1"
ARTIST_UUID = "artist-soundcharts-1"
CACHE_ARTIFACT_ID = "9066927152"


def advanced_record():
    return {
        "track_uuid": TRACK_UUID,
        "spotify_id": TRACK_ID,
        "spotify_identity_status": "exact",
        "isrc": "FRPH30000001",
        "title": "Quiet Horizon",
        "credit_name": "Quiet Artist",
        "release_date": "2026-02-01",
        "release_window_status": "within_window",
        "streams_total": 250_000,
        "streams_source_date": "2026-08-10",
        "candidate_uuid": ARTIST_UUID,
        "candidate_name": "Quiet Artist",
        "artist_identity_status": "soundcharts_only",
        "instrumental_status": "instrumental",
        "genre_status": "in_scope",
        "genres": ["Ambient"],
        "forbidden_genres_detected": [],
        "ai_risk": "unknown",
        "rights_status": "unknown",
        "rights_confidence": None,
        "source_tier": "soundcharts_fal_phase2_private",
        "source_approved_for_publication": False,
        "source_evidence": {
            "instrumental": True,
            "vocal": None,
            "genres": ["Ambient"],
            "ai_risk": "unknown",
        },
        "phase2_decision": "review_instrumental_signal",
        "phase2_reason": "soundcharts_instrumentalness_requires_human_validation",
        "review_bucket": ADVANCED_BUCKET,
        "review_reason": "instrumental_and_genre_evidenced_remaining_checks_required",
        "blocking_fields": ["ai_risk", "artist_spotify_id", "rights_status"],
        "review_decision": "pending",
        "reviewer": "",
        "reviewed_at": "",
        "review_sources": [],
        "review_notes": "",
        "record_digest": "source-record-digest",
    }


def review_manifest(*records):
    rows = list(records or (advanced_record(),))
    return {
        "version": 1,
        "generated_at": "2026-08-10T08:00:00Z",
        "status": "human_review_required",
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "minimum_lifetime_streams": 100_000,
        "summary": {
            "tracks": len(rows),
            "by_bucket": {ADVANCED_BUCKET: len(rows)},
        },
        "guardrails": {},
        "records_digest": "source-manifest-digest",
        "tracks": rows,
    }


def make_phase1(
    path: Path,
    *,
    spotify_id: str = ARTIST_ID,
    status: str = "review_inventory_complete",
    catalog_total: int = 1,
    related_track_uuid: str = TRACK_UUID,
):
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE candidates (
          soundcharts_uuid TEXT PRIMARY KEY,
          spotify_id TEXT,
          name TEXT,
          status TEXT,
          catalog_total INTEGER
        );
        CREATE TABLE candidate_tracks (
          candidate_uuid TEXT NOT NULL,
          track_uuid TEXT NOT NULL,
          PRIMARY KEY(candidate_uuid,track_uuid)
        );
        """
    )
    connection.execute(
        """INSERT INTO candidates(
             soundcharts_uuid,spotify_id,name,status,catalog_total) VALUES(?,?,?,?,?)""",
        (ARTIST_UUID, spotify_id, "Quiet Artist", status, catalog_total),
    )
    connection.execute(
        "INSERT INTO candidate_tracks(candidate_uuid,track_uuid) VALUES(?,?)",
        (ARTIST_UUID, related_track_uuid),
    )
    connection.commit()
    connection.close()


def cache_payload(
    *,
    vocal=None,
    ai_risk="unknown",
    current_contract=True,
    timestamp=True,
    rights_status="unknown",
):
    return {
        "version": 1,
        "tracks": {
            TRACK_UUID: {
                "soundcharts_uuid": TRACK_UUID,
                "title": "Quiet Horizon",
                "credit_name": "Quiet Artist",
                "artists": [
                    {
                        "soundcharts_uuid": ARTIST_UUID,
                        "name": "Quiet Artist",
                        "role": "main",
                    }
                ],
                "release_date": "2026-02-01",
                "label": "Quiet Artist",
                "copyright": "2026 Quiet Artist",
                "rights_status": rights_status,
                "source_evidence": {
                    "instrumental": True,
                    "vocal": vocal,
                    "genres": ["Ambient"],
                    "ai_risk": ai_risk,
                },
                "soundcharts_evidence_contract": (
                    SOUNDCHARTS_SONG_EVIDENCE_CONTRACT if current_contract else "legacy-v2"
                ),
                "fetched_at": "2026-08-10T08:00:00Z" if timestamp else "",
            }
        },
        "artists": {},
    }


def hydrate_bound_cache(connection, cache_path: Path):
    return hydrate_from_cache(
        connection,
        cache_path,
        cache_source_artifact_id=CACHE_ARTIFACT_ID,
        cache_sha256=file_sha256(cache_path),
    )


def cache_cli_args(cache_path: Path) -> list[str]:
    return [
        "--cache",
        str(cache_path),
        "--cache-source-artifact-id",
        CACHE_ARTIFACT_ID,
        "--cache-sha256",
        file_sha256(cache_path),
    ]


class FalPhase3Tests(unittest.TestCase):
    def test_manifest_selects_only_exact_advanced_rows(self):
        other = advanced_record()
        other["track_uuid"] = "track-other"
        other["review_bucket"] = "genre_review_required"
        payload = review_manifest(advanced_record(), other)
        payload["summary"]["by_bucket"][ADVANCED_BUCKET] = 1

        selected = validate_manifest(payload)

        self.assertEqual([row["track_uuid"] for row in selected], [TRACK_UUID])

    def test_manifest_rejects_advanced_row_without_exact_track_identity(self):
        record = advanced_record()
        record["spotify_id"] = "not-exact"
        with self.assertRaises(FalPhase3Error):
            validate_manifest(review_manifest(record))

    def test_phase1_identity_and_cache_are_joined_before_network(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_path = root / "phase3.sqlite3"
            phase1_path = root / "phase1.sqlite3"
            cache_path = root / "cache.json"
            make_phase1(phase1_path)
            cache_path.write_text(
                json.dumps(cache_payload(vocal=False, ai_risk="low")),
                encoding="utf-8",
            )
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                self.assertEqual(
                    hydrate_artist_identities_from_phase1(connection, phase1_path),
                    1,
                )
                track_changes, _ = hydrate_bound_cache(connection, cache_path)
                self.assertEqual(track_changes, 1)

                artist = connection.execute(
                    "SELECT * FROM fal_phase3_artists WHERE candidate_uuid=?",
                    (ARTIST_UUID,),
                ).fetchone()
                track = connection.execute(
                    "SELECT * FROM fal_phase3_tracks WHERE track_uuid=?",
                    (TRACK_UUID,),
                ).fetchone()
                self.assertEqual(artist["spotify_id"], ARTIST_ID)
                self.assertEqual(artist["identity_status"], "complete")
                self.assertEqual(track["detail_status"], "complete_cache")
                self.assertEqual(track["rights_status"], "self_released")
                self.assertEqual(track["no_lyrics_status"], "confirmed")
                self.assertEqual(track["ai_risk"], "low")
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM fal_phase3_requests WHERE status IN ('pending','retry')"
                    ).fetchone()[0],
                    0,
                )
            finally:
                connection.close()

    def test_phase1_identity_requires_completed_inventory_and_track_relation(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_path = root / "phase3.sqlite3"
            phase1_path = root / "phase1.sqlite3"
            make_phase1(phase1_path, status="blocked_ai_high")
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                self.assertEqual(
                    hydrate_artist_identities_from_phase1(connection, phase1_path),
                    0,
                )
                artist = connection.execute(
                    "SELECT spotify_id,identity_status FROM fal_phase3_artists"
                ).fetchone()
                self.assertEqual(artist["spotify_id"], "")
                self.assertEqual(artist["identity_status"], "pending")
            finally:
                connection.close()

    def test_source_shrink_quarantines_stale_rows_and_identity_mutation_fails_closed(self):
        second = advanced_record()
        second.update(
            track_uuid="track-soundcharts-2",
            spotify_id="2" * 22,
            candidate_uuid="artist-soundcharts-2",
            candidate_name="Second Artist",
            record_digest="second-record",
        )
        with tempfile.TemporaryDirectory() as raw_dir:
            state_path = Path(raw_dir) / "phase3.sqlite3"
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record(), second])
                seed_advanced_bucket(connection, [second])
                self.assertEqual(
                    [(task.kind, task.entity_id) for task in pending_tasks(
                        connection, retry_limit=3, limit=10
                    )],
                    [
                        ("artist_identifiers", "artist-soundcharts-2"),
                        ("song_detail", "track-soundcharts-2"),
                    ],
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM fal_phase3_tracks WHERE is_active=1"
                    ).fetchone()[0],
                    1,
                )
                mutated = dict(second)
                mutated["spotify_id"] = "3" * 22
                with self.assertRaisesRegex(FalPhase3Error, "identity mutation"):
                    seed_advanced_bucket(connection, [mutated])
                active = connection.execute(
                    "SELECT spotify_id,is_active FROM fal_phase3_tracks WHERE track_uuid=?",
                    (second["track_uuid"],),
                ).fetchone()
                self.assertEqual((active["spotify_id"], active["is_active"]), ("2" * 22, 1))
            finally:
                connection.close()

    def test_legacy_cache_is_nonterminal_and_negative_evidence_is_sticky(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            state_path = root / "phase3.sqlite3"
            cache_path = root / "cache.json"
            cache_path.write_text(
                json.dumps(
                    cache_payload(
                        vocal=True,
                        ai_risk="high",
                        current_contract=False,
                        rights_status="major",
                    )
                ),
                encoding="utf-8",
            )
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                self.assertEqual(hydrate_bound_cache(connection, cache_path)[0], 0)
                self.assertEqual(
                    connection.execute(
                        """SELECT status FROM fal_phase3_requests
                             WHERE request_kind='song_detail'"""
                    ).fetchone()[0],
                    "pending",
                )
                self.assertEqual(
                    _store_song_response(
                        connection,
                        RequestTask("song_detail", TRACK_UUID),
                        {
                            "object": {
                                "uuid": TRACK_UUID,
                                "name": "Quiet Horizon",
                                "creditName": "Quiet Artist",
                                "artists": [{"uuid": ARTIST_UUID, "name": "Quiet Artist"}],
                                "mainArtists": [{"uuid": ARTIST_UUID}],
                            }
                        },
                    ),
                    "complete_provider",
                )
                track = connection.execute(
                    "SELECT rights_status,ai_risk,provider_evidence_json FROM fal_phase3_tracks"
                ).fetchone()
                evidence = json.loads(track["provider_evidence_json"])
                self.assertEqual(track["rights_status"], "major")
                self.assertEqual(track["ai_risk"], "high")
                self.assertIs(evidence["vocal"], True)
                enriched = build_enriched_manifest(review_manifest(), connection)
                self.assertEqual(enriched["tracks"][0]["review_bucket"], "blocked")
                self.assertEqual(enriched["summary"]["by_bucket"], {"blocked": 1})
            finally:
                connection.close()

    def test_song_response_requires_present_matching_uuid(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            connection, _ = open_state(Path(raw_dir) / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                for value in (None, "another-track"):
                    payload = {"object": {"name": "Quiet Horizon"}}
                    if value is not None:
                        payload["object"]["uuid"] = value
                    with self.assertRaisesRegex(FalPhase3Error, "UUID"):
                        _store_song_response(
                            connection,
                            RequestTask("song_detail", TRACK_UUID),
                            payload,
                        )
            finally:
                connection.close()

    def test_current_contract_without_fetch_timestamp_stays_nonterminal(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            cache_path = root / "cache.json"
            cache_path.write_text(
                json.dumps(cache_payload(timestamp=False)), encoding="utf-8"
            )
            connection, _ = open_state(root / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                self.assertEqual(hydrate_bound_cache(connection, cache_path)[0], 0)
                row = connection.execute(
                    """SELECT t.detail_status,r.status
                         FROM fal_phase3_tracks t
                         JOIN fal_phase3_requests r ON r.entity_id=t.track_uuid
                        WHERE r.request_kind='song_detail'"""
                ).fetchone()
                self.assertEqual((row["detail_status"], row["status"]), ("pending", "pending"))
            finally:
                connection.close()

    def test_provider_success_is_never_regressed_by_an_older_cache(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            cache_path = root / "cache.json"
            cache_path.write_text(
                json.dumps(
                    cache_payload(
                        vocal=True,
                        ai_risk="high",
                        current_contract=False,
                        rights_status="major",
                    )
                ),
                encoding="utf-8",
            )
            connection, _ = open_state(root / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                _store_song_response(
                    connection,
                    RequestTask("song_detail", TRACK_UUID),
                    {
                        "object": {
                            "uuid": TRACK_UUID,
                            "name": "Quiet Horizon",
                            "creditName": "Quiet Artist",
                            "label": "Quiet Artist",
                            "copyright": "2026 Quiet Artist",
                            "artists": [{"uuid": ARTIST_UUID, "name": "Quiet Artist"}],
                            "mainArtists": [{"uuid": ARTIST_UUID}],
                        }
                    },
                )
                before = connection.execute(
                    "SELECT detail_status,rights_status,ai_risk,source_kind FROM fal_phase3_tracks"
                ).fetchone()
                hydrate_bound_cache(connection, cache_path)
                after = connection.execute(
                    "SELECT detail_status,rights_status,ai_risk,source_kind FROM fal_phase3_tracks"
                ).fetchone()
                self.assertEqual(tuple(before), tuple(after))
                self.assertEqual(after["detail_status"], "complete_provider")
                self.assertNotEqual(after["ai_risk"], "high")
            finally:
                connection.close()

    def test_terminal_unresolved_requests_never_report_complete(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            state_path = Path(raw_dir) / "phase3.sqlite3"
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                connection.execute(
                    """UPDATE fal_phase3_requests SET status=CASE request_kind
                         WHEN 'artist_identifiers' THEN 'complete_phase1' ELSE 'unavailable' END"""
                )
                connection.commit()
                report = build_report(
                    connection,
                    state_path=state_path,
                    state_sha256_before="",
                    run_id="run-1",
                    phase2_source_artifact_id="phase2",
                    phase1_source_artifact_id="phase1",
                    phase2_state_sha256="a" * 64,
                    phase2_report_sha256="b" * 64,
                    phase1_state_sha256="c" * 64,
                    manifest_sha256="d" * 64,
                    max_requests=1,
                    quota_reserve=1_400_000,
                    quota_before=None,
                    client=None,
                    halt_reason="request_batch_complete",
                    tracks_seeded=1,
                    artists_seeded=1,
                    phase1_identities=1,
                    cache_tracks=0,
                    cache_artists=0,
                    cache_source_artifact_id="",
                    cache_sha256="",
                )
                self.assertFalse(report["complete"])
                self.assertTrue(report["request_queue_exhausted"])
                self.assertEqual(report["requests"]["terminal_unresolved"], 1)
                self.assertIn("unresolved", report["status"])
            finally:
                connection.close()

    def test_cli_report_hash_matches_the_final_closed_state(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            manifest_path = root / "review.json"
            phase1_path = root / "phase1.sqlite3"
            cache_path = root / "cache.json"
            state_path = root / "phase3.sqlite3"
            report_path = root / "report.json"
            manifest_path.write_text(json.dumps(review_manifest()), encoding="utf-8")
            make_phase1(phase1_path)
            cache_path.write_text(json.dumps(cache_payload()), encoding="utf-8")
            main(
                [
                    "--review-manifest", str(manifest_path),
                    "--phase1-state", str(phase1_path),
                    *cache_cli_args(cache_path),
                    "--state", str(state_path),
                    "--enriched-manifest-out", str(root / "enriched.json"),
                    "--report", str(report_path),
                    "--max-requests", "0",
                ]
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["source"]["state_sha256_after"], file_sha256(state_path))

    def test_duplicate_cache_artist_identity_marks_every_active_artist_conflict(self):
        second = advanced_record()
        second.update(
            track_uuid="track-soundcharts-2",
            spotify_id="2" * 22,
            candidate_uuid="artist-soundcharts-2",
            candidate_name="Second Artist",
            record_digest="second-record",
        )
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            cache_path = root / "cache.json"
            cache_path.write_text(
                json.dumps(
                    {
                        "tracks": {},
                        "artists": {
                            ARTIST_UUID: {
                                "spotify_id": ARTIST_ID,
                                "identifiers_fetched_at": "2026-08-10T08:00:00Z",
                            },
                            second["candidate_uuid"]: {
                                "spotify_id": ARTIST_ID,
                                "identifiers_fetched_at": "2026-08-10T08:00:00Z",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            connection, _ = open_state(root / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record(), second])
                hydrate_bound_cache(connection, cache_path)
                rows = connection.execute(
                    "SELECT spotify_id,identity_status FROM fal_phase3_artists ORDER BY candidate_uuid"
                ).fetchall()
                self.assertEqual(
                    [(row["spotify_id"], row["identity_status"]) for row in rows],
                    [("", "identity_conflict"), ("", "identity_conflict")],
                )
            finally:
                connection.close()

    def test_artist_cache_identity_without_provider_timestamp_stays_pending(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            cache_path = root / "cache.json"
            payload = {
                "tracks": {},
                "artists": {ARTIST_UUID: {"spotify_id": ARTIST_ID}},
            }
            cache_path.write_text(json.dumps(payload), encoding="utf-8")
            connection, _ = open_state(root / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                self.assertEqual(hydrate_bound_cache(connection, cache_path)[1], 0)
                row = connection.execute(
                    """SELECT a.spotify_id,a.identity_status,r.status
                         FROM fal_phase3_artists a
                         JOIN fal_phase3_requests r ON r.entity_id=a.candidate_uuid
                        WHERE r.request_kind='artist_identifiers'"""
                ).fetchone()
                self.assertEqual(
                    (row["spotify_id"], row["identity_status"], row["status"]),
                    ("", "pending", "pending"),
                )

                payload["artists"][ARTIST_UUID]["identifiers_fetched_at"] = (
                    "2026-08-10T08:00:00Z"
                )
                cache_path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertEqual(hydrate_bound_cache(connection, cache_path)[1], 1)
                row = connection.execute(
                    """SELECT a.spotify_id,a.identity_status,r.status
                         FROM fal_phase3_artists a
                         JOIN fal_phase3_requests r ON r.entity_id=a.candidate_uuid
                        WHERE r.request_kind='artist_identifiers'"""
                ).fetchone()
                self.assertEqual(
                    (row["spotify_id"], row["identity_status"], row["status"]),
                    (ARTIST_ID, "complete", "complete_cache"),
                )
            finally:
                connection.close()

    def test_cache_artifact_sha_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            cache_path = root / "cache.json"
            cache_path.write_text(json.dumps(cache_payload()), encoding="utf-8")
            connection, _ = open_state(root / "phase3.sqlite3")
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                with self.assertRaisesRegex(FalPhase3Error, "SHA-256"):
                    hydrate_from_cache(
                        connection,
                        cache_path,
                        cache_source_artifact_id=CACHE_ARTIFACT_ID,
                        cache_sha256="0" * 64,
                    )
            finally:
                connection.close()

    def test_instrumentalness_or_explicit_false_never_infers_no_lyrics(self):
        evidence = strict_track_evidence(
            {
                "soundcharts_uuid": TRACK_UUID,
                "title": "Quiet Horizon",
                "credit_name": "Quiet Artist",
                "label": "Quiet Artist",
                "explicit": False,
                "instrumentalness": 0.99,
                "source_evidence": {
                    "instrumental": True,
                    "vocal": None,
                    "instrumentalness": 0.99,
                    "explicit": False,
                    "ai_risk": "unknown",
                },
            }
        )

        self.assertEqual(evidence["no_lyrics_status"], "unknown")
        self.assertEqual(evidence["ai_risk"], "unknown")

    def test_enriched_manifest_never_approves_source_or_human_review(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            state_path = Path(raw_dir) / "phase3.sqlite3"
            connection, _ = open_state(state_path)
            try:
                seed_advanced_bucket(connection, [advanced_record()])
                enriched = build_enriched_manifest(review_manifest(), connection)
            finally:
                connection.close()

        record = enriched["tracks"][0]
        self.assertFalse(record["source_approved_for_publication"])
        self.assertEqual(record["review_decision"], "pending")
        self.assertFalse(enriched["promotion_executed"])
        self.assertTrue(enriched["guardrails"]["source_approval_remains_manual"])
        self.assertTrue(enriched["guardrails"]["human_review_remains_manual"])

    def test_cli_dry_run_uses_no_credentials_and_writes_private_outputs(self):
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            manifest_path = root / "review.json"
            phase1_path = root / "phase1.sqlite3"
            cache_path = root / "cache.json"
            state_path = root / "private" / "phase3.sqlite3"
            enriched_path = root / "private" / "enriched.json"
            report_path = root / "aggregate" / "report.json"
            manifest_path.write_text(json.dumps(review_manifest()), encoding="utf-8")
            make_phase1(phase1_path)
            cache_path.write_text(json.dumps(cache_payload(vocal=False)), encoding="utf-8")

            result = main(
                [
                    "--review-manifest",
                    str(manifest_path),
                    "--phase1-state",
                    str(phase1_path),
                    *cache_cli_args(cache_path),
                    "--state",
                    str(state_path),
                    "--enriched-manifest-out",
                    str(enriched_path),
                    "--report",
                    str(report_path),
                    "--max-requests",
                    "0",
                ]
            )

            self.assertEqual(result, 0)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "dry_run_private_state_ready")
            self.assertEqual(report["requests"]["claimed"], 0)
            self.assertFalse(report["canonical_written"])
            self.assertFalse(report["dashboard_written"])
            self.assertFalse(report["promotion_executed"])
            self.assertTrue(state_path.is_file())
            self.assertTrue(enriched_path.is_file())


if __name__ == "__main__":
    unittest.main()
