import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

from backfill_public_spotify_track_identities import (
    MAX_RETRIES,
    PublicIdentityBackfillError,
    apply_resolved_to_performance,
    build_artist_identity_map,
    enumerate_discographies,
    extract_song_spotify_id,
    finalize_targets,
    integrate_catalogue_page,
    open_state,
    parse_public_catalogue_page,
    resolve_artist_identities,
    seed_state,
    validate_candidates,
)
from refresh_soundcharts_daily import read_performance_payload


TRACK_A = "A1b2C3d4E5f6G7h8I9j0K1"
TRACK_B = "B1c2D3e4F5g6H7i8J9k0L1"
TRACK_C = "C1d2E3f4G5h6I7j8K9l0M1"
ARTIST_A = "D1e2F3g4H5i6J7k8L9m0N1"
ARTIST_B = "E1f2G3h4I5j6K7l8M9n0O1"


TRACK_SCHEMA = [
    "spotify_id",
    "soundcharts_uuid",
    "title",
    "artists",
    "release_date",
]
ARTIST_SCHEMA = ["name", "spotify_id", "soundcharts_uuid"]
SOUNDCHARTS_ARTIST_SCHEMA = ["soundcharts_uuid", "spotify_id", "name"]


def browse_payload(tracks, artists):
    return {
        "discovery_catalogue": {
            "track_schema": TRACK_SCHEMA,
            "tracks": tracks,
            "artist_schema": ARTIST_SCHEMA,
            "artists": artists,
        }
    }


def soundcharts_payload(artists):
    return {
        "schemas": {"artists": SOUNDCHARTS_ARTIST_SCHEMA},
        "artists": artists,
    }


def audience(*identifiers):
    return {
        "items": [
            {
                "date": "2026-08-08",
                "plots": [
                    {"identifier": identifier, "value": 100_000 + index}
                    for index, identifier in enumerate(identifiers)
                ],
            },
            {
                "date": "2026-08-09",
                "plots": [
                    {"identifier": identifier, "value": 101_000 + index}
                    for index, identifier in enumerate(identifiers)
                ],
            },
        ]
    }


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        uuid = path.split("/song/", 1)[1].split("/audience/", 1)[0]
        response = self.responses[uuid]
        if isinstance(response, BaseException):
            raise response
        return response


class CountingClient:
    def __init__(self):
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        raise AssertionError("terminal/max-retry artist must not make a request")


class ErrorClient:
    def __init__(self):
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        raise RuntimeError("temporary request failure")


class PublicSpotifyIdentityBackfillTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.state_path = Path(self.tempdir.name) / "state.sqlite3"
        self.connection = open_state(self.state_path)

    def tearDown(self):
        self.connection.close()
        self.tempdir.cleanup()

    def test_artist_identity_prefers_current_authoritative_sources(self):
        browse = browse_payload(
            [],
            [["Artist", ARTIST_A, "stale-browse-uuid"]],
        )
        soundcharts = soundcharts_payload(
            [["current-uuid", ARTIST_A, "Artist"]]
        )
        performance = {
            "artists": {ARTIST_A: {"soundcharts_uuid": "current-uuid"}}
        }
        resolved, conflicts = build_artist_identity_map(
            browse, soundcharts, performance
        )
        self.assertEqual(
            resolved[ARTIST_A], ("current-uuid", "soundcharts_snapshot")
        )
        self.assertEqual(conflicts, {})

    def test_artist_identity_blocks_current_source_conflict(self):
        browse = browse_payload([], [])
        soundcharts = soundcharts_payload(
            [["snapshot-uuid", ARTIST_A, "Artist"]]
        )
        performance = {
            "artists": {ARTIST_A: {"soundcharts_uuid": "performance-uuid"}}
        }
        resolved, conflicts = build_artist_identity_map(
            browse, soundcharts, performance
        )
        self.assertNotIn(ARTIST_A, resolved)
        self.assertEqual(
            conflicts[ARTIST_A]["soundcharts_snapshot"], ["snapshot-uuid"]
        )
        self.assertEqual(
            conflicts[ARTIST_A]["performance_artist"], ["performance-uuid"]
        )

    def test_seed_targets_only_tracks_without_direct_mapping(self):
        browse = browse_payload(
            [
                [
                    TRACK_A,
                    "",
                    "Quiet Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-01",
                ],
                [
                    TRACK_B,
                    "browse-track-uuid",
                    "Already mapped",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-02",
                ],
                [TRACK_C, "", "No artist", [], "2025-01-03"],
            ],
            [["Artist", ARTIST_A, "artist-uuid"]],
        )
        performance = {
            "artists": {ARTIST_A: {"soundcharts_uuid": "artist-uuid"}},
            "tracks": {},
        }
        summary = seed_state(
            self.connection,
            browse,
            soundcharts_payload([]),
            performance,
            run_id="seed-run",
        )
        self.assertEqual(summary["seeded_targets"], 2)
        self.assertEqual(summary["skipped_already_mapped"], 1)
        self.assertEqual(summary["targets_without_artist_identity"], 1)
        target = self.connection.execute(
            "SELECT * FROM targets WHERE spotify_id=?", (TRACK_A,)
        ).fetchone()
        self.assertEqual(target["status"], "pending")
        artist = self.connection.execute(
            "SELECT * FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()
        self.assertEqual(artist["soundcharts_uuid"], "artist-uuid")
        self.assertEqual(artist["status"], "catalogue_pending")
        no_artist = self.connection.execute(
            "SELECT status FROM targets WHERE spotify_id=?", (TRACK_C,)
        ).fetchone()[0]
        self.assertEqual(no_artist, "no_artist_identity")

    def test_corrupt_restored_checkpoint_fails_quick_check(self):
        corrupt = Path(self.tempdir.name) / "corrupt.sqlite3"
        corrupt.write_bytes(b"not-a-sqlite-checkpoint")
        with self.assertRaisesRegex(
            PublicIdentityBackfillError, "corrupt|quick_check"
        ):
            open_state(corrupt)

    def test_song_identity_ignores_nested_artist_spotify_id_and_uses_title(self):
        artist = self._seed_single_target()
        response = {
            "page": {"total": 1, "offset": 0, "limit": 100},
            "items": [
                {
                    "song": {
                        "uuid": "song-uuid",
                        "name": "Quiet Morning",
                        "artists": [
                            {
                                "name": "Nested Artist",
                                "platforms": [
                                    {
                                        "platform": "spotify",
                                        "identifier": ARTIST_B,
                                    }
                                ],
                            }
                        ],
                    }
                }
            ],
        }
        tracks, _, _ = parse_public_catalogue_page(
            response,
            artist_uuid="artist-uuid",
            offset=0,
            limit=100,
        )
        self.assertEqual(tracks[0]["spotify_id"], "")
        inserted, complete = integrate_catalogue_page(
            self.connection,
            artist,
            response,
            page_size=100,
            run_id="catalogue-run",
        )
        self.assertEqual(inserted, 1)
        self.assertTrue(complete)
        candidate = self.connection.execute("SELECT * FROM candidates").fetchone()
        self.assertEqual(candidate["target_spotify_id"], TRACK_A)
        self.assertEqual(candidate["exact_discography_identifier"], 0)

    def test_song_identity_accepts_only_direct_track_identity(self):
        self.assertEqual(
            extract_song_spotify_id(
                {
                    "spotifyId": TRACK_A,
                    "artists": [{"spotifyId": ARTIST_A}],
                }
            ),
            TRACK_A,
        )
        self.assertEqual(
            extract_song_spotify_id(
                {
                    "links": {
                        "spotify": f"https://open.spotify.com/track/{TRACK_A}"
                    }
                }
            ),
            TRACK_A,
        )
        self.assertEqual(
            extract_song_spotify_id(
                {
                    "links": {
                        "spotify": f"https://open.spotify.com/artist/{ARTIST_A}"
                    }
                }
            ),
            "",
        )
        self.assertEqual(
            extract_song_spotify_id(
                {
                    "identifiers": [
                        {
                            "platform": "spotify",
                            "type": "artist",
                            "identifier": ARTIST_A,
                        }
                    ]
                }
            ),
            "",
        )

    def test_song_identity_with_multiple_track_ids_fails_closed(self):
        self.assertEqual(
            extract_song_spotify_id(
                {
                    "spotify_id": TRACK_A,
                    "spotify_url": f"https://open.spotify.com/track/{TRACK_B}",
                }
            ),
            "",
        )

    def _seed_single_target(self):
        browse = browse_payload(
            [
                [
                    TRACK_A,
                    "",
                    "Quiet Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-01",
                ]
            ],
            [["Artist", ARTIST_A, "artist-uuid"]],
        )
        seed_state(
            self.connection,
            browse,
            soundcharts_payload([]),
            {
                "artists": {ARTIST_A: {"soundcharts_uuid": "artist-uuid"}},
                "tracks": {},
            },
            run_id="seed-run",
        )
        return self.connection.execute(
            "SELECT * FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()

    def test_resume_preserves_terminal_states_and_normalizes_max_retry(self):
        self._seed_single_target()
        browse = browse_payload(
            [
                [
                    TRACK_A,
                    "",
                    "Quiet Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-01",
                ],
                [
                    TRACK_B,
                    "",
                    "Second Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-02",
                ],
            ],
            [["Artist", ARTIST_A, "artist-uuid"]],
        )
        for status, attempts, expected_status in (
            ("identity_conflict", 0, "identity_conflict"),
            ("identity_unavailable", 1, "identity_unavailable"),
            ("catalogue_unavailable", MAX_RETRIES, "catalogue_unavailable"),
            ("catalogue_retry", MAX_RETRIES, "catalogue_unavailable"),
        ):
            self.connection.execute(
                """UPDATE artists SET status=?,attempts=?,error_code='terminal-error'
                     WHERE spotify_id=?""",
                (status, attempts, ARTIST_A),
            )
            self.connection.commit()
            seed_state(
                self.connection,
                browse,
                soundcharts_payload([]),
                {
                    "artists": {
                        ARTIST_A: {"soundcharts_uuid": "artist-uuid"}
                    },
                    "tracks": {},
                },
                run_id=f"resume-{status}",
            )
            row = self.connection.execute(
                "SELECT status,attempts,error_code FROM artists WHERE spotify_id=?",
                (ARTIST_A,),
            ).fetchone()
            self.assertEqual(row["status"], expected_status)
            self.assertEqual(row["attempts"], attempts)
            self.assertEqual(row["error_code"], "terminal-error")

    def test_terminal_identity_recovers_from_new_authoritative_exact_mapping(self):
        browse = browse_payload(
            [
                [
                    TRACK_A,
                    "",
                    "Quiet Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-01",
                ]
            ],
            [["Artist", ARTIST_A, ""]],
        )
        seed_state(
            self.connection,
            browse,
            soundcharts_payload([]),
            {"artists": {}, "tracks": {}},
            run_id="unresolved-seed",
        )
        self.connection.execute(
            """UPDATE artists SET status='identity_unavailable',attempts=?,
                      error_code='identity_retry_budget_exhausted'
                 WHERE spotify_id=?""",
            (MAX_RETRIES, ARTIST_A),
        )
        self.connection.commit()

        seed_state(
            self.connection,
            browse,
            soundcharts_payload([]),
            {
                "artists": {
                    ARTIST_A: {"soundcharts_uuid": "new-authoritative-uuid"}
                },
                "tracks": {},
            },
            run_id="authoritative-recovery",
        )
        artist = self.connection.execute(
            "SELECT * FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()
        self.assertEqual(artist["soundcharts_uuid"], "new-authoritative-uuid")
        self.assertEqual(artist["identity_source"], "performance_artist")
        self.assertEqual(artist["status"], "catalogue_pending")
        self.assertEqual(artist["attempts"], 0)
        self.assertIsNone(artist["error_code"])

    def test_changed_authoritative_uuid_resets_catalogue_and_stale_candidates(self):
        self._seed_single_target()
        now = "2026-08-10T00:00:00Z"
        self.connection.execute(
            """UPDATE artists SET soundcharts_uuid='stale-uuid',
                      identity_source='browse_artist',status='catalogue_unavailable',
                      next_offset=100,total=200,attempts=?,error_code='request_failed'
                 WHERE spotify_id=?""",
            (MAX_RETRIES, ARTIST_A),
        )
        self.connection.execute(
            """INSERT INTO candidates(
                   target_spotify_id,soundcharts_uuid,artist_soundcharts_uuid,
                   source_title,status,updated_at,last_run_id)
                 VALUES(?,?,?,?,?,?,?)""",
            (
                TRACK_A,
                "stale-song-uuid",
                "stale-uuid",
                "Quiet Morning",
                "pending",
                now,
                "stale-run",
            ),
        )
        self.connection.execute(
            """UPDATE targets SET status='ambiguous',error_code='stale-ambiguity'
                 WHERE spotify_id=?""",
            (TRACK_A,),
        )
        self.connection.commit()
        browse = browse_payload(
            [
                [
                    TRACK_A,
                    "",
                    "Quiet Morning",
                    [{"spotify_id": ARTIST_A}],
                    "2025-01-01",
                ]
            ],
            [["Artist", ARTIST_A, "stale-uuid"]],
        )
        seed_state(
            self.connection,
            browse,
            soundcharts_payload([]),
            {
                "artists": {
                    ARTIST_A: {"soundcharts_uuid": "fresh-authoritative-uuid"}
                },
                "tracks": {},
            },
            run_id="changed-authoritative-identity",
        )
        artist = self.connection.execute(
            "SELECT * FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()
        self.assertEqual(artist["soundcharts_uuid"], "fresh-authoritative-uuid")
        self.assertEqual(artist["status"], "catalogue_pending")
        self.assertEqual(artist["next_offset"], 0)
        self.assertIsNone(artist["total"])
        self.assertEqual(artist["attempts"], 0)
        target = self.connection.execute(
            "SELECT status,error_code FROM targets WHERE spotify_id=?", (TRACK_A,)
        ).fetchone()
        self.assertEqual(target["status"], "pending")
        self.assertIsNone(target["error_code"])
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0],
            0,
        )

    def test_identity_retry_becomes_terminal_at_max_retries(self):
        self._seed_single_target()
        self.connection.execute(
            """UPDATE artists SET status='identity_retry',soundcharts_uuid=NULL,
                      attempts=?,error_code='request_failed' WHERE spotify_id=?""",
            (MAX_RETRIES - 1, ARTIST_A),
        )
        self.connection.commit()
        client = ErrorClient()
        resolved, halt = resolve_artist_identities(
            self.connection, client, workers=1, run_id="terminal-identity"
        )
        self.assertEqual((resolved, halt), (0, ""))
        artist = self.connection.execute(
            "SELECT status,attempts,error_code FROM artists WHERE spotify_id=?",
            (ARTIST_A,),
        ).fetchone()
        self.assertEqual(artist["status"], "identity_unavailable")
        self.assertEqual(artist["attempts"], MAX_RETRIES)
        self.assertEqual(artist["error_code"], "request_failed")
        self.assertEqual(len(client.paths), 1)

    def test_max_retry_artist_is_not_fetched_again(self):
        self._seed_single_target()
        client = CountingClient()
        self.connection.execute(
            """UPDATE artists SET status='identity_retry',soundcharts_uuid=NULL,
                      attempts=? WHERE spotify_id=?""",
            (MAX_RETRIES, ARTIST_A),
        )
        self.connection.commit()
        resolved, halt = resolve_artist_identities(
            self.connection, client, workers=1, run_id="resume-identity"
        )
        self.assertEqual((resolved, halt), (0, ""))
        artist = self.connection.execute(
            "SELECT status,error_code FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()
        self.assertEqual(artist["status"], "identity_unavailable")
        self.assertEqual(artist["error_code"], "identity_retry_budget_exhausted")
        self.connection.execute(
            """UPDATE artists SET status='catalogue_retry',soundcharts_uuid='artist-uuid',
                      attempts=?,error_code=NULL WHERE spotify_id=?""",
            (MAX_RETRIES, ARTIST_A),
        )
        self.connection.commit()
        pages, candidates, halt = enumerate_discographies(
            self.connection,
            client,
            workers=1,
            page_size=100,
            run_id="resume-catalogue",
        )
        self.assertEqual((pages, candidates, halt), (0, 0, ""))
        artist = self.connection.execute(
            "SELECT status,error_code FROM artists WHERE spotify_id=?", (ARTIST_A,)
        ).fetchone()
        self.assertEqual(artist["status"], "catalogue_unavailable")
        self.assertEqual(artist["error_code"], "catalogue_retry_budget_exhausted")
        self.assertEqual(client.paths, [])

    def test_discography_title_is_shortlist_and_audience_id_is_proof(self):
        artist = self._seed_single_target()
        inserted, complete = integrate_catalogue_page(
            self.connection,
            artist,
            {
                "page": {"total": 1, "offset": 0, "limit": 100},
                "items": [
                    {
                        "uuid": "song-uuid",
                        "name": "Quiet Morning",
                        "releaseDate": "2025-01-01",
                    }
                ],
            },
            page_size=100,
            run_id="catalogue-run",
        )
        self.assertEqual(inserted, 1)
        self.assertTrue(complete)
        candidate = self.connection.execute("SELECT * FROM candidates").fetchone()
        self.assertEqual(candidate["exact_discography_identifier"], 0)

        attempted, matched, halt = validate_candidates(
            self.connection,
            FakeClient({"song-uuid": audience(TRACK_A)}),
            workers=1,
            history_days=90,
            as_of=dt.date(2026, 8, 10),
            run_id="audience-run",
        )
        self.assertEqual((attempted, matched, halt), (1, 1, ""))
        finalized = finalize_targets(self.connection, run_id="finalize-run")
        self.assertEqual(finalized["resolved"], 1)
        target = self.connection.execute(
            "SELECT * FROM targets WHERE spotify_id=?", (TRACK_A,)
        ).fetchone()
        self.assertEqual(target["soundcharts_uuid"], "song-uuid")
        self.assertEqual(
            json.loads(target["history_json"]),
            [["2026-08-08", 100_000], ["2026-08-09", 101_000]],
        )

    def test_title_match_with_different_audience_id_is_never_assigned(self):
        artist = self._seed_single_target()
        integrate_catalogue_page(
            self.connection,
            artist,
            {
                "page": {"total": 1, "offset": 0, "limit": 100},
                "items": [{"uuid": "wrong-song", "name": "Quiet Morning"}],
            },
            page_size=100,
            run_id="catalogue-run",
        )
        validate_candidates(
            self.connection,
            FakeClient({"wrong-song": audience(TRACK_B)}),
            workers=1,
            history_days=90,
            as_of=dt.date(2026, 8, 10),
            run_id="audience-run",
        )
        finalized = finalize_targets(self.connection, run_id="finalize-run")
        self.assertEqual(finalized["no_exact_match"], 1)
        target = self.connection.execute(
            "SELECT status,soundcharts_uuid FROM targets WHERE spotify_id=?",
            (TRACK_A,),
        ).fetchone()
        self.assertEqual(target["status"], "no_exact_match")
        self.assertIsNone(target["soundcharts_uuid"])

    def test_two_exact_uuid_matches_remain_ambiguous(self):
        artist = self._seed_single_target()
        integrate_catalogue_page(
            self.connection,
            artist,
            {
                "page": {"total": 2, "offset": 0, "limit": 100},
                "items": [
                    {"uuid": "song-one", "name": "Quiet Morning"},
                    {"uuid": "song-two", "name": "Quiet Morning"},
                ],
            },
            page_size=100,
            run_id="catalogue-run",
        )
        validate_candidates(
            self.connection,
            FakeClient(
                {
                    "song-one": audience(TRACK_A),
                    "song-two": audience(TRACK_A),
                }
            ),
            workers=2,
            history_days=90,
            as_of=dt.date(2026, 8, 10),
            run_id="audience-run",
        )
        finalized = finalize_targets(self.connection, run_id="finalize-run")
        self.assertEqual(finalized["ambiguous"], 1)
        target = self.connection.execute(
            "SELECT status,soundcharts_uuid FROM targets WHERE spotify_id=?",
            (TRACK_A,),
        ).fetchone()
        self.assertEqual(target["status"], "ambiguous")
        self.assertIsNone(target["soundcharts_uuid"])

    def test_unvalidated_competing_candidate_blocks_a_matched_uuid(self):
        artist = self._seed_single_target()
        integrate_catalogue_page(
            self.connection,
            artist,
            {
                "page": {"total": 2, "offset": 0, "limit": 100},
                "items": [
                    {"uuid": "song-matched", "name": "Quiet Morning"},
                    {"uuid": "song-unavailable", "name": "Quiet Morning"},
                ],
            },
            page_size=100,
            run_id="catalogue-run",
        )
        validate_candidates(
            self.connection,
            FakeClient(
                {
                    "song-matched": audience(TRACK_A),
                    "song-unavailable": RuntimeError("unavailable"),
                }
            ),
            workers=2,
            history_days=90,
            as_of=dt.date(2026, 8, 10),
            run_id="audience-run",
        )
        # The generic failure is retried once in a later batch and then kept
        # unavailable; the known match must still not be published.
        finalized = finalize_targets(self.connection, run_id="finalize-run")
        self.assertEqual(finalized["candidate_validation_unavailable"], 1)
        target = self.connection.execute(
            "SELECT status,soundcharts_uuid FROM targets WHERE spotify_id=?",
            (TRACK_A,),
        ).fetchone()
        self.assertEqual(target["status"], "candidate_validation_unavailable")
        self.assertIsNone(target["soundcharts_uuid"])

    def test_performance_apply_does_not_touch_canonical_catalogue(self):
        now = "2026-08-10T00:00:00Z"
        self.connection.execute(
            """INSERT INTO targets(
                   spotify_id,title,normalized_title,status,soundcharts_uuid,
                   evidence_json,history_json,first_seen_at,updated_at,last_run_id)
                 VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                TRACK_A,
                "Quiet Morning",
                "quiet morning",
                "resolved",
                "song-uuid",
                "{}",
                json.dumps([["2026-08-09", 101_000]]),
                now,
                now,
                "test",
            ),
        )
        self.connection.commit()
        performance = Path(self.tempdir.name) / "Spotify_Performance_data.js"
        performance.write_text(
            "window.SPOTIFY_PERFORMANCE="
            + json.dumps(
                {
                    "source": "soundcharts_daily",
                    "tracks": {},
                    "artists": {},
                    "playlists": {},
                }
            )
            + ";\n",
            encoding="utf-8",
        )
        changes = apply_resolved_to_performance(
            self.connection, performance, run_id="apply-run"
        )
        self.assertEqual(changes["added"], 1)
        payload = read_performance_payload(performance)
        self.assertEqual(
            payload["tracks"][TRACK_A]["soundcharts_uuid"], "song-uuid"
        )
        self.assertEqual(
            payload["tracks"][TRACK_A]["history"], [["2026-08-09", 101_000]]
        )
        self.assertFalse(
            (Path(self.tempdir.name) / "Spotify_Soundcharts_data.js").exists()
        )
        self.assertFalse(
            (Path(self.tempdir.name) / "Spotify_Browse_Catalogue_data.js").exists()
        )


if __name__ == "__main__":
    unittest.main()
