import datetime as dt
import inspect
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scan_soundcharts_fal_phase1 import (
    CATALOG_SCOPE_META_KEY,
    CATALOG_SCOPE_VERSION,
    FalPhase1Error,
    HARD_MIN_QUOTA_RESERVE,
    KnownIdentities,
    Phase1Scanner,
    SeedArtist,
    build_inventory_profile,
    build_known_identities,
    build_report,
    evidence_decision,
    extract_evidence,
    extract_seed_cohort,
    freeze_seed_cohort,
    open_state,
    parse_related_page,
    plan_quota_budget,
    prepare_runtime_state,
    next_quota_reset,
    reconcile_seed_ledger,
    requeue_failed_work,
)
from refresh_soundcharts_daily import read_js_payload, SOUNDCHARTS_PREFIX


ARTIST_SCHEMA = [
    "spotify_id",
    "name",
    "monthly_listeners",
    "qualifies",
    "soundcharts_uuid",
    "fal_out",
    "source_tier",
]


def payload_with_artists(rows):
    return {
        "generated_at": "2026-07-21T16:01:02Z",
        "schemas": {"artists": ARTIST_SCHEMA, "tracks": []},
        "artists": rows,
        "tracks": [],
    }


def empty_known():
    return KnownIdentities(set(), set(), set(), set(), set())


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


class FalPhase1Tests(unittest.TestCase):
    def state(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        connection = open_state(Path(tmp.name) / "phase1.sqlite3")
        self.addCleanup(connection.close)
        return connection

    def scanner(self, connection, client, known=None, **kwargs):
        return Phase1Scanner(
            connection,
            client,
            known or empty_known(),
            workers=1,
            related_limit=1,
            catalog_page_size=1,
            min_audience=50_000,
            recent_days=1_095,
            retry_limit=2,
            max_related_artists=None,
            as_of=dt.date(2026, 7, 29),
            **kwargs,
        )

    def insert_candidate(self, connection, uuid, status="discovered", spotify_id=""):
        connection.execute(
            """INSERT INTO candidates(
                 soundcharts_uuid,spotify_id,name,status,evidence_json,first_seen_at,updated_at)
               VALUES(?,?,?,?,?,?,?)""",
            (uuid, spotify_id, uuid, status, "{}", "2026-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
        )
        connection.commit()

    def test_seed_cohort_uses_50k_floor_blacklist_and_no_audience_ceiling(self):
        payload = payload_with_artists(
            [
                ["spotify-b", "Beta", 70_000, 0, "uuid-b", 0, None],
                ["spotify-a", "Alpha", 60_000, 0, "uuid-a", 0, None],
                ["spotify-a", "Alpha", 65_000, 1, "uuid-a", 40, "instrumental_editorial"],
                ["spotify-low", "Small", 49_999, 1, "uuid-low", 40, "instrumental_editorial"],
                ["spotify-high", "Large", 5_000_001, 1, "uuid-high", 40, "instrumental_editorial"],
                ["", "Missing Spotify ID", 100_000, 1, "uuid-no-spotify", 40, "instrumental_editorial"],
                ["spotify-pop", "Bruno Mars", 100_000, 1, "uuid-pop", 40, "instrumental_editorial"],
            ]
        )
        seeds, eligible = extract_seed_cohort(payload, max_seeds=10)
        self.assertEqual(eligible, 3)
        self.assertEqual([seed.soundcharts_uuid for seed in seeds], ["uuid-a", "uuid-high", "uuid-b"])
        self.assertEqual(seeds[0].monthly_listeners, 65_000)

        with self.assertRaises(FalPhase1Error):
            extract_seed_cohort(payload, max_seeds=1)

    def test_audited_seed_snapshot_has_4186_unique_identities(self):
        root = Path(__file__).resolve().parents[1]
        payload = read_js_payload(root / "Spotify_Soundcharts_data_20260721T181420Z.js", SOUNDCHARTS_PREFIX)
        seeds, eligible = extract_seed_cohort(payload)
        self.assertEqual(eligible, 4_186)
        self.assertEqual(len(seeds), 4_186)

    def test_active_snapshot_is_included_in_known_identity_dedup(self):
        active = {
            "schemas": {
                "artists": ["spotify_id", "soundcharts_uuid", "name"],
                "tracks": ["spotify_id", "soundcharts_uuid", "isrc"],
            },
            "artists": [["active-spotify-id-0001", "active-artist-uuid", "Active"]],
            "tracks": [["active-track-id-00001", "active-track-uuid", "FRABC2600001"]],
        }
        known = build_known_identities(active)
        self.assertIn("active-artist-uuid", known.artist_uuids)
        self.assertIn("active-track-id-00001", known.track_spotify_ids)
        self.assertIn("FRABC2600001", known.track_isrcs)

    def test_missing_related_spotify_id_is_resolved_before_duplicate_decision(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        known_spotify = "knownspotifyid000000001"

        def respond(path):
            if "/related?" in path:
                return {"page": {"total": 1, "offset": 0, "limit": 1}, "items": [{"uuid": "candidate-uuid", "name": "Candidate"}]}
            if "/identifiers?" in path:
                return {"items": [{"platform": "spotify", "identifier": known_spotify}]}
            raise AssertionError(f"unexpected call: {path}")

        client = FakeClient(respond)
        known = empty_known()
        known.artist_spotify_ids.add(known_spotify)
        scanner = self.scanner(connection, client, known)
        self.assertTrue(scanner.scan_related_batch())
        self.assertEqual(
            connection.execute("SELECT status FROM candidates WHERE soundcharts_uuid='candidate-uuid'").fetchone()[0],
            "identity_pending",
        )
        self.assertTrue(scanner.scan_identity_batch())
        row = connection.execute(
            "SELECT spotify_id,status FROM candidates WHERE soundcharts_uuid='candidate-uuid'"
        ).fetchone()
        self.assertEqual(tuple(row), (known_spotify, "duplicate_existing"))
        self.assertFalse(any("/current/stats" in path for path in client.paths))

    def test_related_rows_deduplicate_two_soundcharts_uuids_with_same_spotify_id(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        scanner = self.scanner(connection, FakeClient(lambda _: {}))
        shared = "sharedspotifyid00000001"
        scanner._upsert_related(
            "seed-uuid",
            {"soundcharts_uuid": "candidate-one", "spotify_id": shared, "name": "One", "rank": 1, "evidence": {}},
        )
        scanner._upsert_related(
            "seed-uuid",
            {"soundcharts_uuid": "candidate-two", "spotify_id": shared, "name": "Two", "rank": 2, "evidence": {}},
        )
        statuses = {
            row["soundcharts_uuid"]: row["status"]
            for row in connection.execute("SELECT soundcharts_uuid,status FROM candidates")
        }
        self.assertEqual(statuses["candidate-one"], "discovered")
        self.assertEqual(statuses["candidate-two"], "duplicate_existing")

    def test_new_related_artist_blacklist_is_terminal_and_genre_markers_are_conservative(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        scanner = self.scanner(connection, FakeClient(lambda _: {}))
        scanner._upsert_related(
            "seed-uuid",
            {
                "soundcharts_uuid": "blacklisted-uuid",
                "spotify_id": "blacklistedspotify000001",
                "name": "Bruno Mars",
                "rank": 1,
                "evidence": {},
            },
        )
        row = connection.execute("SELECT status,reason FROM candidates").fetchone()
        self.assertEqual(tuple(row), ("blocked_blacklist", "public_artist_blacklist"))
        self.assertEqual(
            evidence_decision({"genres": ["Dance Pop"]})[0],
            "blocked_out_of_scope",
        )
        self.assertIsNone(evidence_decision({"genres": ["Lofi Hip Hop"]})[0])

    def test_v225_song_evidence_reads_nested_genres_and_audio_without_inventing_ai(self):
        evidence = extract_evidence(
            {
                "type": "song",
                "object": {
                    "uuid": "track-v225",
                    "genres": [
                        {"root": "Ambient", "sub": ["Dark Ambient", "Instrumental"]},
                        {"root": "Electronic", "sub": ["Downtempo"]},
                    ],
                    "audio": {
                        "instrumentalness": 0.93,
                        "speechiness": 0.04,
                    },
                },
            }
        )

        self.assertEqual(
            set(evidence["genres"]),
            {"Ambient", "Dark Ambient", "Instrumental", "Electronic", "Downtempo"},
        )
        self.assertIs(evidence["instrumental"], True)
        self.assertIsNone(evidence["vocal"])
        self.assertAlmostEqual(evidence["instrumentalness"], 0.93)
        self.assertAlmostEqual(evidence["speechiness"], 0.04)
        self.assertEqual(evidence["ai_risk"], "unknown")

    def test_v225_low_instrumentalness_is_not_promoted_to_explicit_vocal_evidence(self):
        evidence = extract_evidence(
            {
                "object": {
                    "genres": [{"root": "Ambient", "sub": []}],
                    "audio": {"instrumentalness": 0.2, "speechiness": 0.03},
                }
            }
        )

        self.assertIsNone(evidence["instrumental"])
        self.assertIsNone(evidence["vocal"])
        self.assertEqual(evidence["ai_risk"], "unknown")
        self.assertIsNone(evidence_decision(evidence)[0])

    def test_audience_uses_current_stats_value_and_50k_floor(self):
        connection = self.state()
        self.insert_candidate(connection, "candidate-ok")
        self.insert_candidate(connection, "candidate-low")

        def respond(path):
            value = 60_000 if "candidate-ok" in path else 49_999
            return {"object": {"streaming": [{"platform": "spotify", "value": value, "date": "2026-07-29"}]}}

        client = FakeClient(respond)
        scanner = Phase1Scanner(
            connection,
            client,
            empty_known(),
            workers=2,
            related_limit=1,
            catalog_page_size=1,
            min_audience=50_000,
            recent_days=1_095,
            retry_limit=2,
            max_related_artists=None,
            as_of=dt.date(2026, 7, 29),
        )
        self.assertTrue(scanner.scan_audience_batch())
        rows = {
            row["soundcharts_uuid"]: row
            for row in connection.execute("SELECT * FROM candidates ORDER BY soundcharts_uuid")
        }
        self.assertEqual(rows["candidate-ok"]["monthly_listeners"], 60_000)
        self.assertEqual(rows["candidate-ok"]["status"], "activity_pending")
        self.assertEqual(rows["candidate-low"]["status"], "blocked_audience_low")
        self.assertEqual(rows["candidate-low"]["reason"], "below_50000_monthly_listeners")
        self.assertTrue(all("/current/stats" in path for path in client.paths))

    def test_vocal_track_is_blocked_individually_and_catalogue_continues(self):
        connection = self.state()
        self.insert_candidate(connection, "artist-uuid", status="activity_pending", spotify_id="artistspotifyid0000001")

        def respond(path):
            if "offset=0" in path:
                return {
                    "page": {"total": 2, "offset": 0, "limit": 1},
                    "items": [{"uuid": "track-vocal", "name": "Vocal Track", "releaseDate": "2026-01-01", "genres": ["Vocal"]}],
                }
            if "offset=1" in path:
                return {
                    "page": {"total": 2, "offset": 1, "limit": 1},
                    "items": [{"uuid": "track-ambient", "name": "Quiet Track", "releaseDate": "2025-12-01", "genres": ["Ambient"]}],
                }
            raise AssertionError(f"unexpected call: {path}")

        client = FakeClient(respond)
        scanner = self.scanner(connection, client)
        self.assertTrue(scanner.scan_activity_batch())
        self.assertEqual(
            connection.execute("SELECT status FROM candidates WHERE soundcharts_uuid='artist-uuid'").fetchone()[0],
            "catalog_pending",
        )
        self.assertEqual(
            connection.execute("SELECT status FROM tracks WHERE soundcharts_uuid='track-vocal'").fetchone()[0],
            "blocked_explicit_vocal",
        )
        self.assertTrue(scanner.scan_catalog_batch())
        self.assertEqual(
            connection.execute("SELECT status FROM candidates WHERE soundcharts_uuid='artist-uuid'").fetchone()[0],
            "review_inventory_complete",
        )
        tracks = {
            row["soundcharts_uuid"]: row
            for row in connection.execute("SELECT * FROM tracks ORDER BY soundcharts_uuid")
        }
        self.assertEqual(tracks["track-vocal"]["status"], "blocked_explicit_vocal")
        self.assertEqual(tracks["track-ambient"]["status"], "review_metadata_pending")
        self.assertEqual(tracks["track-ambient"]["isrc"], "")
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 2)
        self.assertEqual(
            client.paths,
            [
                "/api/v2.21/artist/artist-uuid/songs?mainPerformer=1&sortBy=releaseDate&sortOrder=desc&offset=0&limit=1",
                "/api/v2.21/artist/artist-uuid/songs?mainPerformer=1&sortBy=releaseDate&sortOrder=desc&offset=1&limit=1",
            ],
        )
        self.assertFalse(any("/api/v2/song/" in path for path in client.paths))

    def test_main_performer_v1_migration_keeps_graph_identity_and_audience_only(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "phase1.sqlite3"
        connection = open_state(path)
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seed-spotify", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        self.insert_candidate(connection, "candidate-complete", status="review_inventory_complete", spotify_id="spotify-complete")
        self.insert_candidate(connection, "candidate-empty", status="review_inventory_complete", spotify_id="spotify-empty")
        self.insert_candidate(connection, "candidate-inactive", status="blocked_inactive", spotify_id="spotify-inactive")
        self.insert_candidate(connection, "candidate-unaffected", status="blocked_audience_low", spotify_id="spotify-low")
        connection.execute(
            """UPDATE candidates SET monthly_listeners=75000,source_count=3,best_rank=2,
                      latest_release_date='2026-07-01',catalog_offset=2,catalog_total=2
               WHERE soundcharts_uuid='candidate-complete'"""
        )
        connection.execute(
            """UPDATE candidates SET monthly_listeners=80000,source_count=2,best_rank=4,
                      latest_release_date='2026-06-01',catalog_offset=0,catalog_total=0
               WHERE soundcharts_uuid='candidate-empty'"""
        )
        connection.execute(
            """UPDATE candidates SET monthly_listeners=90000,latest_release_date='2020-01-01',
                      catalog_offset=1,catalog_total=1
               WHERE soundcharts_uuid='candidate-inactive'"""
        )
        connection.execute(
            "INSERT INTO related_edges(seed_uuid,candidate_uuid,rank,observed_at) VALUES(?,?,?,?)",
            ("seed-uuid", "candidate-complete", 1, "2026-07-29T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO candidate_sources(candidate_uuid,seed_uuid,rank) VALUES(?,?,?)",
            ("candidate-complete", "seed-uuid", 1),
        )
        for track_uuid, candidate_uuid in (
            ("legacy-track-complete", "candidate-complete"),
            ("legacy-track-inactive", "candidate-inactive"),
        ):
            connection.execute(
                """INSERT INTO tracks(
                     soundcharts_uuid,candidate_uuid,status,reason,evidence_json,first_seen_at,updated_at)
                   VALUES(?,?,'review_metadata_pending','phase2_metadata_classification_required','{}',?,?)""",
                (track_uuid, candidate_uuid, "2026-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
            )
            connection.execute(
                "INSERT INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES(?,?,?)",
                (candidate_uuid, track_uuid, "2026-07-29T00:00:00Z"),
            )
        connection.execute("DELETE FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,))
        connection.commit()
        connection.close()

        migrated = open_state(path)
        self.addCleanup(migrated.close)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 0)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM candidate_tracks").fetchone()[0], 0)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM seeds").fetchone()[0], 1)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM related_edges").fetchone()[0], 1)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM candidate_sources").fetchone()[0], 1)
        complete = migrated.execute(
            """SELECT spotify_id,monthly_listeners,source_count,best_rank,status,reason,
                      catalog_offset,catalog_total,latest_release_date
               FROM candidates WHERE soundcharts_uuid='candidate-complete'"""
        ).fetchone()
        self.assertEqual(
            tuple(complete),
            (
                "spotify-complete",
                75_000,
                3,
                2,
                "activity_pending",
                "main_performer_v1_rescan_required",
                0,
                None,
                None,
            ),
        )
        empty = migrated.execute(
            "SELECT status,catalog_offset,catalog_total FROM candidates WHERE soundcharts_uuid='candidate-empty'"
        ).fetchone()
        self.assertEqual(tuple(empty), ("activity_pending", 0, None))
        inactive = migrated.execute(
            "SELECT status,catalog_offset,catalog_total FROM candidates WHERE soundcharts_uuid='candidate-inactive'"
        ).fetchone()
        self.assertEqual(tuple(inactive), ("activity_pending", 0, None))
        unaffected = migrated.execute(
            "SELECT status,spotify_id FROM candidates WHERE soundcharts_uuid='candidate-unaffected'"
        ).fetchone()
        self.assertEqual(tuple(unaffected), ("blocked_audience_low", "spotify-low"))
        self.assertEqual(
            migrated.execute("SELECT value FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,)).fetchone()[0],
            CATALOG_SCOPE_VERSION,
        )
        self.assertEqual(
            migrated.execute("SELECT value FROM meta WHERE key='main_performer_v1_tracks_deleted'").fetchone()[0],
            "2",
        )

    def test_main_performer_v1_migration_resumes_at_zero_and_second_open_is_noop(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "phase1.sqlite3"
        connection = open_state(path)
        self.insert_candidate(connection, "candidate-resume", status="review_inventory_complete")
        connection.execute(
            """UPDATE candidates SET catalog_offset=7,catalog_total=7,latest_release_date='2026-01-01'
               WHERE soundcharts_uuid='candidate-resume'"""
        )
        connection.execute(
            """INSERT INTO tracks(
                 soundcharts_uuid,candidate_uuid,status,reason,evidence_json,first_seen_at,updated_at)
               VALUES('legacy-track','candidate-resume','review_metadata_pending',
                      'phase2_metadata_classification_required','{}',?,?)""",
            ("2026-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES(?,?,?)",
            ("candidate-resume", "legacy-track", "2026-07-29T00:00:00Z"),
        )
        connection.execute("DELETE FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,))
        connection.commit()
        connection.close()

        migrated = open_state(path)
        client = FakeClient(
            lambda path: (
                {
                    "page": {"total": 2, "offset": 0, "limit": 1},
                    "items": [{"uuid": "main-track-one", "name": "Main One", "releaseDate": "2026-07-01"}],
                }
                if "offset=0" in path
                else {
                    "page": {"total": 2, "offset": 1, "limit": 1},
                    "items": [{"uuid": "main-track-two", "name": "Main Two", "releaseDate": "2026-06-01"}],
                }
            )
        )
        scanner = self.scanner(migrated, client)
        self.assertTrue(scanner.scan_activity_batch())
        self.assertTrue(scanner.scan_catalog_batch())
        self.assertEqual(
            client.paths,
            [
                "/api/v2.21/artist/candidate-resume/songs?mainPerformer=1&sortBy=releaseDate&sortOrder=desc&offset=0&limit=1",
                "/api/v2.21/artist/candidate-resume/songs?mainPerformer=1&sortBy=releaseDate&sortOrder=desc&offset=1&limit=1",
            ],
        )
        self.assertEqual(
            tuple(
                migrated.execute(
                    "SELECT status,catalog_offset,catalog_total FROM candidates WHERE soundcharts_uuid='candidate-resume'"
                ).fetchone()
            ),
            ("review_inventory_complete", 2, 2),
        )
        applied_at = migrated.execute(
            "SELECT value FROM meta WHERE key='main_performer_v1_applied_at'"
        ).fetchone()[0]
        migrated.close()

        reopened = open_state(path)
        self.addCleanup(reopened.close)
        self.assertEqual(
            [row[0] for row in reopened.execute("SELECT soundcharts_uuid FROM tracks ORDER BY soundcharts_uuid")],
            ["main-track-one", "main-track-two"],
        )
        self.assertEqual(
            reopened.execute("SELECT value FROM meta WHERE key='main_performer_v1_applied_at'").fetchone()[0],
            applied_at,
        )

    def test_dry_run_state_copy_absorbs_scope_migration_without_touching_checkpoint(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "phase1.sqlite3"
        connection = open_state(path)
        self.insert_candidate(connection, "candidate-dry-run", status="review_inventory_complete")
        connection.execute(
            """UPDATE candidates SET catalog_offset=1,catalog_total=1
               WHERE soundcharts_uuid='candidate-dry-run'"""
        )
        connection.execute(
            """INSERT INTO tracks(
                 soundcharts_uuid,candidate_uuid,status,reason,evidence_json,first_seen_at,updated_at)
               VALUES('legacy-dry-run-track','candidate-dry-run','review_metadata_pending',
                      'phase2_metadata_classification_required','{}',?,?)""",
            ("2026-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES(?,?,?)",
            ("candidate-dry-run", "legacy-dry-run-track", "2026-07-29T00:00:00Z"),
        )
        connection.execute("DELETE FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,))
        connection.commit()
        connection.close()

        dry_run_dir, runtime_path = prepare_runtime_state(path, dry_run=True)
        self.assertIsNotNone(dry_run_dir)
        self.assertNotEqual(runtime_path, path)
        simulated = open_state(runtime_path)
        self.assertEqual(simulated.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 0)
        self.assertEqual(
            simulated.execute("SELECT value FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,)).fetchone()[0],
            CATALOG_SCOPE_VERSION,
        )
        simulated.close()
        dry_run_dir.cleanup()

        original = sqlite3.connect(path)
        try:
            self.assertEqual(original.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 1)
            self.assertIsNone(
                original.execute("SELECT value FROM meta WHERE key=?", (CATALOG_SCOPE_META_KEY,)).fetchone()
            )
            self.assertEqual(
                tuple(
                    original.execute(
                        "SELECT status,catalog_offset,catalog_total FROM candidates WHERE soundcharts_uuid='candidate-dry-run'"
                    ).fetchone()
                ),
                ("review_inventory_complete", 1, 1),
            )
        finally:
            original.close()

    def test_page_cursor_accepts_confirmed_empty_end_and_rejects_partial_page(self):
        rows, total, next_offset = parse_related_page(
            {"page": {"total": 0, "offset": 0, "limit": 50}, "items": []},
            offset=0,
            limit=50,
        )
        self.assertEqual((rows, total, next_offset), ([], 0, None))
        with self.assertRaises(FalPhase1Error):
            parse_related_page(
                {
                    "page": {"total": 10, "offset": 0, "limit": 50},
                    "items": [{"uuid": "only-one", "name": "Partial"}],
                },
                offset=0,
                limit=50,
            )

    def test_page_rejects_success_envelopes_with_errors_or_without_collection(self):
        with self.assertRaises(FalPhase1Error):
            parse_related_page(
                {
                    "errors": [{"code": "upstream_partial", "message": "incomplete"}],
                    "page": {"total": 0, "offset": 0, "limit": 50},
                    "items": [],
                },
                offset=0,
                limit=50,
            )
        with self.assertRaises(FalPhase1Error):
            parse_related_page(
                {"page": {"total": 0, "offset": 0, "limit": 50}},
                offset=0,
                limit=50,
            )

    def test_invalid_page_does_not_advance_seed_cursor(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        client = FakeClient(
            lambda _: {
                "page": {"total": 10, "offset": 5, "limit": 1},
                "items": [{"uuid": "candidate", "name": "Candidate"}],
            }
        )
        scanner = self.scanner(connection, client)
        self.assertTrue(scanner.scan_related_batch())
        row = connection.execute("SELECT related_offset,status,attempts FROM seeds").fetchone()
        self.assertEqual(tuple(row), (0, "pending", 1))

    def test_first_catalogue_page_is_stored_when_release_date_is_unknown(self):
        connection = self.state()
        self.insert_candidate(connection, "artist-unknown-date", status="activity_pending")
        client = FakeClient(
            lambda _: {
                "page": {"total": 1, "offset": 0, "limit": 1},
                "items": [{"uuid": "track-unknown-date", "name": "Unknown Date", "releaseDate": ""}],
            }
        )
        scanner = self.scanner(connection, client)
        self.assertTrue(scanner.scan_activity_batch())
        self.assertEqual(
            connection.execute("SELECT status FROM candidates").fetchone()[0],
            "review_activity_unknown",
        )
        self.assertEqual(
            connection.execute("SELECT status FROM tracks").fetchone()[0],
            "review_metadata_pending",
        )

    def test_candidate_track_join_preserves_collaboration_membership(self):
        connection = self.state()
        self.insert_candidate(connection, "artist-one", status="catalog_pending")
        self.insert_candidate(connection, "artist-two", status="catalog_pending")
        scanner = self.scanner(connection, FakeClient(lambda _: {}))
        light = {
            "soundcharts_uuid": "shared-track",
            "spotify_id": "",
            "isrc": "",
            "title": "Shared",
            "credit_name": "One & Two",
            "release_date": "2026-01-01",
            "evidence": {},
        }
        scanner._store_track("artist-one", light)
        scanner._store_track("artist-two", light)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 1)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM candidate_tracks").fetchone()[0], 2)

    def test_existing_state_must_match_frozen_cohort_and_failed_work_requeues(self):
        connection = self.state()
        seed = SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)
        freeze_seed_cohort(
            connection,
            [seed],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        with self.assertRaises(FalPhase1Error):
            freeze_seed_cohort(
                connection,
                [SeedArtist("other-uuid", "otherspotifyid00000001", "Other", 100_000, True)],
                source_eligible=1,
                snapshot_name="seed.js",
                snapshot_generated_at="2026-07-21T00:00:00Z",
            )
        connection.execute("UPDATE seeds SET status='failed',attempts=3,error_code='invalid_page'")
        connection.execute(
            "INSERT INTO errors(stage,entity_uuid,error_code,observed_at) VALUES('related_page','seed-uuid','invalid_page','2026-07-29T00:00:00Z')"
        )
        connection.commit()
        counts = requeue_failed_work(connection)
        self.assertEqual(counts["seeds"], 1)
        self.assertEqual(connection.execute("SELECT status FROM seeds").fetchone()[0], "pending")

    def test_report_is_aggregate_staging_only(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("seed-uuid", "seedspotifyid0000000001", "Seed", 100_000, True)],
            source_eligible=1,
            snapshot_name="seed.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        report = build_report(
            connection,
            source_eligible=1,
            source_snapshot=Path("seed.js"),
            source_generated_at="2026-07-21T00:00:00Z",
        )
        self.assertTrue(report["staging_only"])
        self.assertFalse(report["canonical_written"])
        self.assertEqual(
            report["safeguards"]["new_candidate_monthly_listeners"],
            {"minimum": 50_000, "maximum": None},
        )
        self.assertEqual(report["discographies"]["mode"], "inventory_light")
        self.assertEqual(report["discographies"]["scope_version"], "main_performer_v1")
        self.assertEqual(
            set(report["coverage"]["seed_related"]),
            {"expected", "scanned", "usable", "missing"},
        )
        self.assertEqual(report["coverage"]["seed_related"]["expected"], 1)
        self.assertEqual(report["coverage"]["seed_related"]["missing"], 1)
        self.assertEqual(report["inventory_profile"]["release_date_distribution"]["total"], 0)
        self.assertNotIn("seed-uuid", str(report))

    def test_inventory_profile_is_exhaustive_and_reports_only_aggregates(self):
        connection = self.state()
        self.insert_candidate(connection, "candidate-a", status="review_inventory_complete")
        rows = [
            ("track-recent", "2026-07-01"),
            ("track-year", "2026-01-01"),
            ("track-three", "2024-01-01"),
            ("track-old", "2020-01-01"),
            ("track-unknown", ""),
        ]
        for track_uuid, release_date in rows:
            connection.execute(
                """INSERT INTO tracks(
                     soundcharts_uuid,candidate_uuid,release_date,status,reason,evidence_json,
                     first_seen_at,updated_at)
                   VALUES(?,?,?,'review_metadata_pending','phase2_metadata_classification_required','{}',?,?)""",
                (track_uuid, "candidate-a", release_date, "2026-07-29T00:00:00Z", "2026-07-29T00:00:00Z"),
            )
            connection.execute(
                "INSERT INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES(?,?,?)",
                ("candidate-a", track_uuid, "2026-07-29T00:00:00Z"),
            )
        connection.execute("UPDATE candidates SET catalog_total=5,catalog_offset=5 WHERE soundcharts_uuid='candidate-a'")
        connection.commit()

        profile = build_inventory_profile(connection, as_of=dt.date(2026, 7, 29))
        releases = profile["release_date_distribution"]
        self.assertEqual(releases["total"], 5)
        self.assertEqual(releases["age_lte_90_days"], 1)
        self.assertEqual(releases["age_91_days_to_1_year"], 1)
        self.assertEqual(releases["age_1_to_3_years"], 1)
        self.assertEqual(releases["age_over_3_years"], 1)
        self.assertEqual(releases["unknown_date"], 1)
        catalogues = profile["candidate_catalogue_distribution"]
        self.assertEqual(catalogues["size_1_20"], 1)
        self.assertEqual(catalogues["max_reported_catalogue"], 5)
        self.assertEqual(catalogues["max_observed_track_links"], 5)
        self.assertNotIn("candidate-a", str(profile))
        self.assertNotIn("track-recent", str(profile))

    def test_dynamic_quota_budget_protects_maintenance_and_rolls_after_reset(self):
        before = plan_quota_budget(
            quota_remaining=3_000_000,
            requested=40_000,
            maintenance_daily_requests=60_000,
            maintenance_through=None,
            as_of="2026-07-29T00:00:00Z",
        )
        self.assertEqual(before.maintenance_through, "2026-08-18")
        self.assertEqual(before.maintenance_days, 21)
        self.assertEqual(before.maintenance_reserve, 1_260_000)
        self.assertEqual(before.protected_floor, HARD_MIN_QUOTA_RESERVE + 1_260_000)
        self.assertEqual(before.allowed, 40_000)

        constrained = plan_quota_budget(
            quota_remaining=before.protected_floor + 7_500,
            requested=40_000,
            maintenance_daily_requests=60_000,
            maintenance_through=None,
            as_of="2026-07-29T00:00:00Z",
        )
        self.assertEqual(constrained.allowed, 7_500)

        self.assertEqual(
            next_quota_reset("2026-08-18T19:10:00Z").isoformat(),
            "2026-08-18T19:11:00+00:00",
        )
        after = plan_quota_budget(
            quota_remaining=3_000_000,
            requested=40_000,
            maintenance_daily_requests=60_000,
            maintenance_through=None,
            as_of="2026-08-18T19:12:00Z",
        )
        self.assertEqual(after.maintenance_through, "2026-09-18")
        self.assertEqual(after.maintenance_days, 32)
        self.assertGreater(after.maintenance_reserve, 0)

        reset_day_override = plan_quota_budget(
            quota_remaining=3_000_000,
            requested=40_000,
            maintenance_daily_requests=60_000,
            maintenance_through="2026-08-18",
            as_of="2026-08-18T19:12:00Z",
        )
        self.assertEqual(reset_day_override.maintenance_through, "2026-09-18")
        self.assertGreater(reset_day_override.maintenance_reserve, 0)

        stale_override = plan_quota_budget(
            quota_remaining=3_000_000,
            requested=40_000,
            maintenance_daily_requests=60_000,
            maintenance_through="2026-08-18",
            as_of="2026-08-19T00:00:00Z",
        )
        self.assertEqual(stale_override.maintenance_through, "2026-09-18")
        self.assertGreaterEqual(stale_override.hard_reserve, 500_000)

    def test_v1_checkpoint_migrates_and_ledger_extension_is_append_only(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "phase1.sqlite3"
        connection = open_state(path)
        freeze_seed_cohort(
            connection,
            [SeedArtist("old-seed", "old-spotify", "Old", 100_000, True)],
            source_eligible=1,
            snapshot_name="historical.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        connection.execute(
            "UPDATE seeds SET status='complete',related_offset=50,related_total=50 WHERE soundcharts_uuid='old-seed'"
        )
        self.insert_candidate(connection, "candidate-preserved", status="review_inventory_complete")
        connection.execute(
            """INSERT INTO tracks(
                 soundcharts_uuid,candidate_uuid,spotify_id,isrc,title,credit_name,release_date,
                 status,reason,evidence_json,first_seen_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "track-preserved",
                "candidate-preserved",
                "track-spotify",
                "FRABC2600001",
                "Track",
                "Artist",
                "2026-01-01",
                "review_metadata_pending",
                "phase2_metadata_classification_required",
                "{}",
                "2026-07-29T00:00:00Z",
                "2026-07-29T00:00:00Z",
            ),
        )
        connection.execute("UPDATE meta SET value='1' WHERE key='state_version'")
        connection.commit()
        connection.close()

        migrated = open_state(path)
        self.addCleanup(migrated.close)
        ledger = {
            "cohort_hash": "ledger-hash",
            "generated_at": "2026-07-29T00:00:00Z",
            "coverage": {"expected_displayed": 2},
        }
        result = reconcile_seed_ledger(
            migrated,
            [
                SeedArtist("old-seed", "old-spotify", "Old", 0, True),
                SeedArtist("new-seed", "new-spotify", "New", 0, True),
            ],
            [{"spotify_id": "pending-spotify", "name": "Pending", "sources": ["performance_artist"]}],
            ledger,
        )
        self.assertEqual(result["state_seeds_before"], 1)
        self.assertEqual(result["appended"], 1)
        self.assertEqual(result["state_seeds_after"], 2)
        self.assertEqual(result["resolution_pending"], 1)
        self.assertEqual(
            tuple(
                migrated.execute(
                    "SELECT status,related_offset,related_total FROM seeds WHERE soundcharts_uuid='old-seed'"
                ).fetchone()
            ),
            ("complete", 50, 50),
        )
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM candidates").fetchone()[0], 1)
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM tracks").fetchone()[0], 1)
        self.assertEqual(migrated.execute("SELECT value FROM meta WHERE key='state_version'").fetchone()[0], "2")
        self.assertEqual(
            migrated.execute("SELECT status FROM seed_resolution_pending").fetchone()[0],
            "resolution_pending",
        )

    def test_seed_alias_reconciliation_keeps_rows_but_suppresses_duplicate_calls(self):
        connection = self.state()
        freeze_seed_cohort(
            connection,
            [SeedArtist("old-alias", "spotify-one", "Old alias", 100_000, True)],
            source_eligible=1,
            snapshot_name="historical.js",
            snapshot_generated_at="2026-07-21T00:00:00Z",
        )
        ledger = {
            "cohort_hash": "ledger-hash",
            "generated_at": "2026-07-29T00:00:00Z",
            "coverage": {"expected_displayed": 1},
            "artists": [
                {
                    "soundcharts_uuid": "canonical",
                    "spotify_id": "spotify-one",
                    "soundcharts_uuid_aliases": ["canonical", "old-alias"],
                    "spotify_id_aliases": ["spotify-one"],
                }
            ],
        }
        result = reconcile_seed_ledger(
            connection,
            [SeedArtist("canonical", "spotify-one", "Canonical", 100_000, True)],
            [],
            ledger,
        )
        self.assertEqual(result["appended"], 1)
        self.assertEqual(result["uuid_aliases"], 1)
        self.assertEqual(result["historical_alias_rows"], 1)
        self.assertEqual(result["suppressed_pending_alias_rows"], 1)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0], 2)
        self.assertEqual(
            connection.execute("SELECT status FROM seeds WHERE soundcharts_uuid='old-alias'").fetchone()[0],
            "alias_superseded",
        )
        self.assertEqual(
            connection.execute("SELECT canonical_uuid FROM seed_aliases WHERE alias_uuid='old-alias'").fetchone()[0],
            "canonical",
        )
        coverage = build_report(
            connection,
            source_eligible=1,
            source_snapshot=Path("ledger.json"),
            source_generated_at="2026-07-29T00:00:00Z",
            seed_ledger=ledger,
        )["coverage"]["seed_related"]
        self.assertEqual(coverage["expected"], 1)
        self.assertEqual(coverage["missing"], 1)
        flipped = {
            **ledger,
            "artists": [
                {
                    "soundcharts_uuid": "old-alias",
                    "spotify_id": "spotify-one",
                    "soundcharts_uuid_aliases": ["canonical", "old-alias"],
                    "spotify_id_aliases": ["spotify-one"],
                }
            ],
        }
        with self.assertRaises(FalPhase1Error):
            reconcile_seed_ledger(
                connection,
                [SeedArtist("old-alias", "spotify-one", "Old alias", 100_000, True)],
                [],
                flipped,
            )

    def test_phase_one_stops_before_per_track_detail_enrichment(self):
        source = inspect.getsource(Phase1Scanner.run)
        self.assertIn("scan_catalog_batch", source)
        self.assertNotIn("scan_track_details_batch", source)


if __name__ == "__main__":
    unittest.main()
