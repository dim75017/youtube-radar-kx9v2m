import copy
import datetime as dt
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

import expand_soundcharts_instrumental_pool as subject


class FakeClient:
    quota_remaining = 3_900_000

    def __init__(self, responses):
        self.responses = responses
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        for needle, response in self.responses.items():
            if needle in path:
                if isinstance(response, BaseException):
                    raise response
                return copy.deepcopy(response)
        raise AssertionError(f"Unexpected path: {path}")


def payload():
    return {
        "coverage": {"discography": {"total": 271713}},
        "schemas": {
            "tracks": [
                "spotify_id",
                "artist",
                "title",
                "release_date",
                "streams",
                "delta",
                "source_date",
                "observed_at",
                "rights_status",
                "status_source",
                "label",
                "copyright",
                "distributor",
                "metadata_status",
                "identifiers_status",
                "metadata_updated_at",
                "soundcharts_uuid",
                "previous_source_date",
            ],
            "artists": [
                "spotify_id",
                "name",
                "monthly_listeners",
                "delta",
                "source_date",
                "observed_at",
                "qualifies",
                "fal_in",
                "fal_out",
                "soundcharts_uuid",
            ],
        },
        "tracks": [],
        "artists": [],
        "editorial": {
            "track_schema": [
                "soundcharts_uuid",
                "spotify_id",
                "name",
                "artist",
                "release_date",
                "primary_genre",
                "subgenres",
                "genre_confidence",
                "instrumental_status",
                "instrumental_confidence",
                "ai_risk",
                "ai_risk_score",
                "expansion_status",
                "review_reasons",
                "metadata_status",
                "updated_at",
            ],
            "tracks": [
                [
                    "song-uuid",
                    None,
                    "Dignity",
                    "Nova Issue",
                    "2025-02-26",
                    "ambient",
                    ["piano"],
                    0.91,
                    "instrumental",
                    1.0,
                    "low",
                    0,
                    "eligible",
                    [],
                    "complete",
                    "2026-07-20T00:00:00Z",
                ]
            ],
        },
    }


def audience_response():
    return {
        "items": [
            {"date": "2026-07-19", "plots": [{"identifier": "4vFL08pP0H9RDUVj05qXyL", "value": 100}]},
            {"date": "2026-07-20", "plots": [{"identifier": "4vFL08pP0H9RDUVj05qXyL", "value": 120}]},
            {"date": "2026-07-21", "plots": [{"identifier": "4vFL08pP0H9RDUVj05qXyL", "value": 155}]},
        ]
    }


def song_detail():
    return {
        "object": {
            "uuid": "song-uuid",
            "name": "Dignity",
            "isrc": "SE4RG2500506",
            "creditName": "Nova Issue",
            "artists": [
                {
                    "uuid": "artist-uuid",
                    "name": "Nova Issue",
                    "appUrl": "https://app.soundcharts.test/artist/nova-issue",
                    "imageUrl": "https://assets.test/nova.jpg",
                }
            ],
            "mainArtists": [{"uuid": "artist-uuid", "name": "Nova Issue"}],
            "releaseDate": "2025-02-26T00:00:00+00:00",
            "label": "Nova Issue",
            "copyright": "2025 Nova Issue",
            "imageUrl": "https://assets.test/song.jpg",
            "duration": 166,
            "explicit": False,
        }
    }


def identifiers_response():
    return {
        "items": [
            {
                "platformCode": "spotify",
                "identifier": "2JG4r9snKhqze9RGKeGEvh",
                "url": "https://open.spotify.com/artist/2JG4r9snKhqze9RGKeGEvh",
                "default": True,
                "verified": True,
            },
            {
                "platformCode": "instagram",
                "identifier": "novaissue",
                "url": "https://instagram.com/novaissue",
            },
        ]
    }


def stats_response():
    return {
        "related": {
            "artist": {
                "name": "Nova Issue",
                "imageUrl": "https://assets.test/nova.jpg",
                "appUrl": "https://app.soundcharts.com/app/artist/nova",
            },
            "platform": "spotify",
        },
        "items": [
            {"date": "2026-07-20T00:00:00+00:00", "value": 1_234_391},
            {"date": "2026-07-21T00:00:00+00:00", "value": 1_283_880},
        ],
    }


def protected_checked_payload(
    *,
    genres=None,
    evidence_contract="",
    source_evidence=None,
):
    current = payload()
    current["editorial"]["tracks"] = []
    protected_spotify_id = "1234567890123456789012"
    discovery_schema = [
        "soundcharts_uuid",
        "spotify_id",
        "title",
        "credit_name",
        "release_date",
        "streams",
        "primary_genre",
        "subgenres",
        "genre_confidence",
        "instrumental_status",
        "instrumental_confidence",
        "ai_risk",
        "ai_risk_score",
        "metadata_status",
        "updated_at",
        "source_tier",
        "soundcharts_genres",
        "soundcharts_genres_checked_at",
        "soundcharts_evidence_contract",
        "source_evidence",
    ]
    record = {
        "soundcharts_uuid": "protected-uuid",
        "spotify_id": protected_spotify_id,
        "title": "Protected Dark Ambient",
        "credit_name": "Protected Artist",
        "release_date": "2026-01-01",
        "streams": 250_000,
        "primary_genre": "dark_ambient",
        "subgenres": [],
        "genre_confidence": 0.8,
        "instrumental_status": "unknown",
        "instrumental_confidence": None,
        "ai_risk": "unknown",
        "ai_risk_score": None,
        "metadata_status": "complete",
        "updated_at": "2026-08-06T00:00:00Z",
        "source_tier": "independent_playlist",
        "soundcharts_genres": list(genres or []),
        "soundcharts_genres_checked_at": "2026-08-06T00:00:00Z",
        "soundcharts_evidence_contract": evidence_contract,
        "source_evidence": dict(source_evidence or {}),
    }
    current["discovery_catalogue"] = {
        "track_schema": discovery_schema,
        "tracks": [[record.get(name) for name in discovery_schema]],
    }
    return current, protected_spotify_id


class InstrumentalPoolTests(unittest.TestCase):
    def test_song_detail_path_uses_fal_evidence_contract(self):
        self.assertEqual(
            subject.soundcharts_song_detail_path("song uuid"),
            "/api/v2.25/song/song%20uuid",
        )

    def test_audience_response_discovers_spotify_id_and_exact_delta(self):
        parsed = subject.parse_audience_response(audience_response())
        self.assertEqual(parsed["spotify_id"], "4vFL08pP0H9RDUVj05qXyL")
        self.assertEqual(parsed["latest_value"], 155)
        self.assertEqual(parsed["delta_24h"], 35)
        self.assertIsNone(parsed["streams_7d"])

    def test_multiple_spotify_aliases_are_retained(self):
        response = {
            "items": [
                {
                    "date": "2026-07-21",
                    "plots": [
                        {"identifier": "11DtUkOzvRc4PLMvWdzSKn", "value": 100},
                        {"identifier": "5UpeJ6WZJdbX2ucwsYIRua", "value": 100},
                    ],
                }
            ]
        }
        parsed = subject.parse_audience_response(response, "5UpeJ6WZJdbX2ucwsYIRua")
        self.assertEqual(parsed["spotify_id"], "5UpeJ6WZJdbX2ucwsYIRua")
        self.assertEqual(parsed["aliases"], ["11DtUkOzvRc4PLMvWdzSKn", "5UpeJ6WZJdbX2ucwsYIRua"])

    def test_song_metadata_recognizes_artist_owned_release(self):
        editorial = subject.editorial_candidates(payload())[0]
        parsed = subject.parse_song_detail(song_detail(), editorial)
        self.assertEqual(parsed["rights_status"], "self_released")
        self.assertGreaterEqual(parsed["rights_confidence"], 0.9)
        self.assertEqual(parsed["artists"][0]["role"], "main")

    def test_song_metadata_uses_exact_soundcharts_genres(self):
        detail = song_detail()
        detail["object"]["genres"] = [
            {"root": "Hip-Hop/Rap", "sub": ["Lo-Fi", "Instrumental Hip Hop"]},
            {"root": "Ambient", "sub": ["Dark Ambient"]},
        ]
        parsed = subject.parse_song_detail(detail, subject.editorial_candidates(payload())[0])
        self.assertEqual(parsed["primary_genre"], "dark_ambient")
        self.assertIn("lofi_hip_hop", parsed["subgenres"])
        self.assertEqual(parsed["genre_source"], "soundcharts_song")
        self.assertEqual(parsed["instrumental_status"], "instrumental")
        self.assertEqual(parsed["instrumental_confidence"], 1.0)
        self.assertEqual(parsed["soundcharts_genres"][0]["root"], "Hip-Hop/Rap")

    def test_explicit_vocal_genre_never_becomes_instrumental(self):
        detail = song_detail()
        detail["object"]["genres"] = [{"root": "Vocal Jazz", "sub": ["Singer Songwriter"]}]
        editorial = subject.editorial_candidates(payload())[0]
        parsed = subject.parse_song_detail(detail, editorial)
        self.assertEqual(parsed["instrumental_status"], "vocal")
        self.assertEqual(parsed["instrumental_confidence"], 0.95)

    def test_song_audio_features_remain_review_only(self):
        detail = song_detail()
        detail["object"]["audioFeatures"] = {
            "instrumentalness": 0.82,
            "speechiness": 0.04,
        }
        editorial = subject.editorial_candidates(payload())[0]
        editorial["instrumental_status"] = "unknown"
        editorial["instrumental_confidence"] = None
        editorial["source_tier"] = "independent_playlist"
        parsed = subject.parse_song_detail(detail, editorial)
        self.assertEqual(parsed["instrumental_status"], "unknown")
        self.assertIsNone(parsed["instrumental_confidence"])
        self.assertIsNone(parsed["source_evidence"]["instrumental"])
        self.assertIsNone(parsed["source_evidence"]["no_lyrics"])
        self.assertEqual(parsed["source_evidence"]["instrumentalness"], 0.82)
        self.assertEqual(parsed["source_evidence"]["speechiness"], 0.04)
        self.assertFalse(parsed["source_evidence"]["instrumental_proof_complete"])
        self.assertEqual(
            parsed["soundcharts_evidence_contract"],
            subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
        )

    def test_song_evidence_parser_reads_the_complete_v225_response(self):
        detail = song_detail()
        detail["evidence"] = {
            "genres": ["Dark Ambient"],
            "audioFeatures": {"instrumentalness": 0.84, "speechiness": 0.03},
        }
        editorial = subject.editorial_candidates(payload())[0]
        editorial["instrumental_status"] = "unknown"
        editorial["instrumental_confidence"] = None
        editorial["source_tier"] = "independent_playlist"
        parsed = subject.parse_song_detail(detail, editorial)

        self.assertEqual(parsed["primary_genre"], "dark_ambient")
        self.assertEqual(parsed["instrumental_status"], "unknown")
        self.assertEqual(parsed["source_evidence"]["instrumentalness"], 0.84)

    def test_song_speechiness_alone_does_not_claim_vocal_or_instrumental(self):
        detail = song_detail()
        detail["object"]["genres"] = [
            {"root": "Ambient", "sub": ["Instrumental"]}
        ]
        detail["object"]["audioFeatures"] = {
            "instrumentalness": 0.91,
            "speechiness": 0.48,
        }
        editorial = subject.editorial_candidates(payload())[0]
        editorial["instrumental_status"] = "unknown"
        editorial["instrumental_confidence"] = None
        editorial["source_tier"] = "independent_playlist"
        parsed = subject.parse_song_detail(detail, editorial)
        self.assertEqual(parsed["instrumental_status"], "unknown")
        self.assertIsNone(parsed["instrumental_confidence"])
        self.assertEqual(parsed["source_evidence"]["speechiness"], 0.48)

    def test_automatic_instrumental_requires_literal_no_lyrics_pair(self):
        editorial = subject.editorial_candidates(payload())[0]
        editorial["instrumental_status"] = "unknown"
        editorial["instrumental_confidence"] = None
        editorial["source_tier"] = "independent_playlist"

        instrumental_only = song_detail()
        instrumental_only["object"]["isInstrumental"] = True
        parsed = subject.parse_song_detail(instrumental_only, editorial)
        self.assertEqual(parsed["instrumental_status"], "unknown")
        self.assertTrue(parsed["source_evidence"]["instrumental"])
        self.assertIsNone(parsed["source_evidence"]["no_lyrics"])

        no_lyrics_only = song_detail()
        no_lyrics_only["object"]["hasLyrics"] = False
        parsed = subject.parse_song_detail(no_lyrics_only, editorial)
        self.assertEqual(parsed["instrumental_status"], "unknown")
        self.assertIsNone(parsed["source_evidence"]["instrumental"])
        self.assertTrue(parsed["source_evidence"]["no_lyrics"])

        complete = song_detail()
        complete["object"]["isInstrumental"] = True
        complete["object"]["hasLyrics"] = False
        parsed = subject.parse_song_detail(complete, editorial)
        self.assertEqual(parsed["instrumental_status"], "instrumental")
        self.assertEqual(parsed["instrumental_confidence"], 0.99)
        self.assertTrue(parsed["source_evidence"]["instrumental_proof_complete"])
        self.assertIn(
            "response.object.isInstrumental",
            parsed["source_evidence"]["instrumental_sources"],
        )
        self.assertIn(
            "response.object.hasLyrics",
            parsed["source_evidence"]["no_lyrics_sources"],
        )

    def test_literal_lyrics_signal_blocks_complete_instrumental_pair(self):
        detail = song_detail()
        detail["object"]["isInstrumental"] = True
        detail["object"]["noLyrics"] = True
        detail["evidence"] = {"hasLyrics": True}
        editorial = subject.editorial_candidates(payload())[0]
        editorial["source_tier"] = "independent_playlist"
        parsed = subject.parse_song_detail(detail, editorial)

        self.assertEqual(parsed["instrumental_status"], "vocal")
        self.assertTrue(parsed["source_evidence"]["vocal"])
        self.assertFalse(parsed["source_evidence"]["no_lyrics"])

    def test_explicit_non_instrumental_flag_is_fail_closed_as_vocal_risk(self):
        detail = song_detail()
        detail["evidence"] = {"instrumental": False}
        parsed = subject.parse_song_detail(
            detail,
            subject.editorial_candidates(payload())[0],
        )

        self.assertEqual(parsed["instrumental_status"], "vocal")
        self.assertTrue(parsed["has_vocal_evidence"])

    def test_prior_vocal_evidence_is_sticky_against_instrumental_refresh(self):
        current = payload()
        schema, rows = subject.ensure_editorial_classification_fields(current)
        row = rows[0]
        subject.set_field(row, schema, "instrumental_status", "vocal")
        subject.set_field(row, schema, "instrumental_confidence", 0.95)
        subject.set_field(
            row,
            schema,
            "source_evidence",
            {
                "vocal": True,
                "explicit": True,
                "speechiness": 0.51,
                "instrumental": False,
            },
        )

        subject.update_editorial_classification(
            current,
            "song-uuid",
            {
                "instrumental_status": "instrumental",
                "instrumental_confidence": 0.99,
                "has_instrumental_evidence": True,
                "has_vocal_evidence": False,
                "source_evidence": {
                    "vocal": False,
                    "explicit": False,
                    "speechiness": 0.02,
                    "instrumental": True,
                    "instrumentalness": 0.99,
                },
                "soundcharts_genres": [],
                "soundcharts_genres_checked_at": "2026-08-10T00:00:00Z",
            },
        )

        evidence = subject.field(row, schema, "source_evidence")
        self.assertEqual(subject.field(row, schema, "instrumental_status"), "vocal")
        self.assertTrue(evidence["vocal"])
        self.assertTrue(evidence["explicit"])
        self.assertFalse(evidence["instrumental"])
        self.assertEqual(evidence["speechiness"], 0.51)

    def test_classification_backfill_updates_genre_without_inventing_ai_risk(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        for name in ("source_tier",):
            schema.append(name)
            current["editorial"]["tracks"][0].append(None)
        row = current["editorial"]["tracks"][0]
        row[schema.index("source_tier")] = "independent_playlist"
        row[schema.index("instrumental_status")] = "unknown"
        row[schema.index("instrumental_confidence")] = None
        row[schema.index("ai_risk")] = "unknown"
        detail = song_detail()
        detail["object"]["genres"] = [{"root": "Ambient", "sub": ["Instrumental"]}]
        cache = {"version": 1, "tracks": {}, "artists": {}}
        summary = subject.classify_soundcharts_genres(
            current,
            cache,
            FakeClient({"/api/v2.25/song/song-uuid": detail}),
            workers=1,
            max_requests=1,
        )
        refreshed_schema = current["editorial"]["track_schema"]
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(subject.field(row, refreshed_schema, "primary_genre"), "ambient")
        self.assertEqual(subject.field(row, refreshed_schema, "genre_source"), "soundcharts_song")
        self.assertEqual(subject.field(row, refreshed_schema, "instrumental_status"), "unknown")
        self.assertIn(
            "instrumental_check_required",
            subject.field(row, refreshed_schema, "review_reasons"),
        )
        self.assertEqual(subject.field(row, refreshed_schema, "ai_risk"), "unknown")
        self.assertEqual(subject.field(row, refreshed_schema, "rights_status"), "self_released")
        self.assertGreaterEqual(
            subject.field(row, refreshed_schema, "rights_confidence"),
            0.9,
        )
        self.assertEqual(
            subject.field(row, refreshed_schema, "artist_soundcharts_uuids"),
            ["artist-uuid"],
        )
        self.assertTrue(subject.field(row, refreshed_schema, "soundcharts_genres_checked_at"))

    def test_legacy_numeric_playlist_approval_is_rechecked_and_downgraded(self):
        current = payload()
        schema, rows = subject.ensure_editorial_classification_fields(current)
        if "source_tier" not in schema:
            schema.append("source_tier")
            for existing_row in rows:
                existing_row.append(None)
        row = rows[0]
        subject.set_field(row, schema, "source_tier", "independent_playlist")
        subject.set_field(row, schema, "instrumental_status", "instrumental")
        subject.set_field(row, schema, "instrumental_confidence", 0.9)
        subject.set_field(row, schema, "ai_risk", "low")
        subject.set_field(
            row,
            schema,
            "soundcharts_genres_checked_at",
            "2026-08-19T00:00:00Z",
        )
        subject.set_field(
            row,
            schema,
            "soundcharts_evidence_contract",
            "soundcharts_song_v2.25_evidence_v2",
        )
        subject.set_field(
            row,
            schema,
            "source_evidence",
            {
                "schema_version": 2,
                "instrumental": True,
                "instrumentalness": 0.94,
                "speechiness": 0.02,
            },
        )
        detail = song_detail()
        detail["object"]["audioFeatures"] = {
            "instrumentalness": 0.94,
            "speechiness": 0.02,
        }
        # A current no-lyrics half must not combine with the legacy
        # numeric-derived instrumental half into a false approval.
        detail["object"]["hasLyrics"] = False
        client = FakeClient({"/api/v2.25/song/song-uuid": detail})

        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            client,
            workers=1,
            max_requests=1,
        )

        self.assertEqual(client.paths, ["/api/v2.25/song/song-uuid"])
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(subject.field(row, schema, "instrumental_status"), "unknown")
        self.assertIsNone(
            subject.field(row, schema, "instrumental_confidence")
        )
        self.assertEqual(
            subject.field(row, schema, "soundcharts_evidence_contract"),
            subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
        )
        self.assertFalse(
            subject.field(row, schema, "source_evidence")[
                "instrumental_proof_complete"
            ]
        )

    def test_classification_cache_vocal_block_is_sticky_against_positive_pair(self):
        current = payload()
        schema, rows = subject.ensure_editorial_classification_fields(current)
        if "source_tier" not in schema:
            schema.append("source_tier")
            for existing_row in rows:
                existing_row.append(None)
        row = rows[0]
        subject.set_field(row, schema, "source_tier", "independent_playlist")
        subject.set_field(row, schema, "instrumental_status", "unknown")
        subject.set_field(row, schema, "instrumental_confidence", None)
        subject.set_field(row, schema, "ai_risk", "unknown")
        detail = song_detail()
        detail["object"]["isInstrumental"] = True
        detail["object"]["hasLyrics"] = False
        cache = {
            "version": 1,
            "tracks": {
                "song-uuid": {
                    "instrumental_status": "vocal",
                    "instrumental_confidence": 0.95,
                    "source_evidence": {
                        "vocal": True,
                        "explicit": True,
                        "instrumental": False,
                    },
                }
            },
            "artists": {},
        }

        subject.classify_soundcharts_genres(
            current,
            cache,
            FakeClient({"/api/v2.25/song/song-uuid": detail}),
            workers=1,
            max_requests=1,
        )

        self.assertEqual(subject.field(row, schema, "instrumental_status"), "vocal")
        evidence = subject.field(row, schema, "source_evidence")
        self.assertTrue(evidence["vocal"])
        self.assertTrue(evidence["explicit"])
        self.assertFalse(evidence["instrumental"])
        self.assertEqual(cache["tracks"]["song-uuid"]["instrumental_status"], "vocal")

    def test_classification_prioritizes_100k_dark_ambient_before_lower_stream_rows(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        schema.append("source_tier")
        first = current["editorial"]["tracks"][0]
        first.append("independent_playlist")
        first[schema.index("soundcharts_uuid")] = "low-stream-song"
        first[schema.index("primary_genre")] = "ambient"
        first[schema.index("instrumental_status")] = "unknown"
        first[schema.index("instrumental_confidence")] = None
        first[schema.index("ai_risk")] = "unknown"

        second = list(first)
        second[schema.index("soundcharts_uuid")] = "dark-100k-song"
        second[schema.index("name")] = "Dark priority"
        second[schema.index("primary_genre")] = "dark_ambient"
        current["editorial"]["tracks"].append(second)
        current["discovery_catalogue"] = {
            "track_schema": ["soundcharts_uuid", "streams", "primary_genre"],
            "tracks": [
                ["low-stream-song", 10_000, "ambient"],
                ["dark-100k-song", 250_000, "dark_ambient"],
            ],
        }

        detail = song_detail()
        detail["object"]["uuid"] = "dark-100k-song"
        detail["object"]["genres"] = [
            {"root": "Ambient", "sub": ["Dark Ambient", "Instrumental"]}
        ]
        detail["object"]["isInstrumental"] = True
        detail["object"]["hasLyrics"] = False
        client = FakeClient({"/api/v2.25/song/dark-100k-song": detail})
        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            client,
            workers=1,
            max_requests=1,
        )

        self.assertEqual(client.paths, ["/api/v2.25/song/dark-100k-song"])
        self.assertEqual(summary["selected_stream_eligible"], 1)
        self.assertEqual(summary["selected_dark_ambient"], 1)
        self.assertEqual(
            summary["rules"]["request_priority"],
            "streams_100k_then_dark_ambient_then_streams_desc",
        )

    def test_classification_reaches_dark_ambient_kept_only_in_discovery_catalogue(self):
        current = payload()
        current["editorial"]["tracks"] = []
        current["discovery_catalogue"] = {
            "track_schema": [
                "soundcharts_uuid",
                "title",
                "credit_name",
                "release_date",
                "streams",
                "primary_genre",
                "subgenres",
                "genre_confidence",
                "instrumental_status",
                "instrumental_confidence",
                "ai_risk",
                "source_tier",
                "review_reasons",
            ],
            "tracks": [[
                "dark-discovery-only",
                "Discovery-only dark track",
                "Dark Artist",
                "2026-01-01",
                350_000,
                "dark_ambient",
                [],
                0.8,
                "unknown",
                None,
                "unknown",
                "independent_playlist",
                ["instrumental_check_required"],
            ]],
        }
        detail = song_detail()
        detail["object"]["uuid"] = "dark-discovery-only"
        detail["object"]["genres"] = [
            {"root": "Ambient", "sub": ["Dark Ambient", "Instrumental"]}
        ]
        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            FakeClient({"/api/v2.25/song/dark-discovery-only": detail}),
            workers=1,
            max_requests=1,
        )

        schema = current["discovery_catalogue"]["track_schema"]
        row = current["discovery_catalogue"]["tracks"][0]
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(subject.field(row, schema, "primary_genre"), "dark_ambient")
        self.assertEqual(subject.field(row, schema, "instrumental_status"), "unknown")
        self.assertEqual(subject.field(row, schema, "ai_risk"), "unknown")
        self.assertTrue(subject.field(row, schema, "soundcharts_genres_checked_at"))
    def test_unknown_song_rights_never_erase_strong_editorial_rights(self):
        current = payload()
        schema, rows = subject.ensure_editorial_classification_fields(current)
        row = rows[0]
        subject.set_field(row, schema, "rights_status", "self_released")
        subject.set_field(row, schema, "rights_confidence", 0.97)

        updated = subject.update_editorial_classification(
            current,
            "song-uuid",
            {
                "rights_status": "unknown",
                "rights_confidence": None,
                "artists": [],
                "soundcharts_genres": [],
                "soundcharts_genres_checked_at": "2026-08-06T00:00:00Z",
            },
        )

        self.assertTrue(updated)
        self.assertEqual(subject.field(row, schema, "rights_status"), "self_released")
        self.assertEqual(subject.field(row, schema, "rights_confidence"), 0.97)

    def test_protected_review_track_is_injected_and_classified_first(self):
        current = payload()
        editorial_schema = current["editorial"]["track_schema"]
        editorial_schema.append("source_tier")
        regular = current["editorial"]["tracks"][0]
        regular.append("independent_playlist")
        regular[editorial_schema.index("instrumental_status")] = "unknown"
        regular[editorial_schema.index("instrumental_confidence")] = None
        regular[editorial_schema.index("ai_risk")] = "unknown"
        protected_spotify_id = "1234567890123456789012"
        discovery_schema = [
            "soundcharts_uuid", "spotify_id", "title", "credit_name",
            "release_date", "primary_genre", "subgenres",
            "genre_confidence", "instrumental_status",
            "instrumental_confidence", "ai_risk", "ai_risk_score",
            "metadata_status", "updated_at", "source_tier",
        ]
        protected_record = {
            "soundcharts_uuid": "protected-uuid",
            "spotify_id": protected_spotify_id,
            "title": "Protected Dark Ambient",
            "credit_name": "Protected Artist",
            "release_date": "2026-01-01",
            "primary_genre": "dark_ambient",
            "subgenres": [],
            "genre_confidence": 0.8,
            "instrumental_status": "unknown",
            "instrumental_confidence": None,
            "ai_risk": "unknown",
            "ai_risk_score": None,
            "metadata_status": "complete",
            "updated_at": "2026-08-06T00:00:00Z",
            "source_tier": "independent_playlist",
        }
        current["discovery_catalogue"] = {
            "track_schema": discovery_schema,
            "tracks": [[protected_record.get(name) for name in discovery_schema]],
        }
        detail = song_detail()
        detail["object"]["uuid"] = "protected-uuid"
        detail["object"]["name"] = "Protected Dark Ambient"
        detail["object"]["creditName"] = "Protected Artist"
        detail["object"]["genres"] = [
            {"root": "Ambient", "sub": ["Dark Ambient", "Instrumental"]}
        ]
        detail["object"]["isInstrumental"] = True
        detail["object"]["hasLyrics"] = False
        client = FakeClient({"/api/v2.25/song/protected-uuid": detail})
        cache = {"version": 1, "tracks": {}, "artists": {}}

        summary = subject.classify_soundcharts_genres(
            current,
            cache,
            client,
            workers=1,
            max_requests=1,
            protected_spotify_ids={protected_spotify_id},
        )

        self.assertEqual(summary["protected_requested"], 1)
        self.assertEqual(summary["protected_mapped"], 1)
        self.assertEqual(summary["protected_inserted"], 1)
        self.assertEqual(summary["protected_selected"], 1)
        self.assertEqual(len(client.paths), 1)
        self.assertIn("protected-uuid", client.paths[0])
        schema = current["editorial"]["track_schema"]
        protected_row = next(
            row
            for row in current["editorial"]["tracks"]
            if subject.field(row, schema, "spotify_id") == protected_spotify_id
        )
        self.assertEqual(
            subject.field(protected_row, schema, "source_tier"),
            "independent_playlist",
        )
        self.assertEqual(subject.field(protected_row, schema, "ai_risk"), "unknown")
        self.assertEqual(
            subject.field(protected_row, schema, "instrumental_status"),
            "instrumental",
        )
        self.assertEqual(subject.field(protected_row, schema, "expansion_status"), "review")

    def test_protected_legacy_zero_evidence_is_rechecked_once_with_v225(self):
        current, protected_spotify_id = protected_checked_payload()
        detail = song_detail()
        detail["object"]["uuid"] = "protected-uuid"
        detail["object"]["genres"] = []
        detail["object"]["audioFeatures"] = {
            "instrumentalness": 0.88,
            "speechiness": 0.04,
        }
        client = FakeClient({"/api/v2.25/song/protected-uuid": detail})

        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            client,
            workers=1,
            max_requests=1,
            protected_spotify_ids={protected_spotify_id},
        )

        self.assertEqual(client.paths, ["/api/v2.25/song/protected-uuid"])
        self.assertEqual(summary["protected_legacy_zero_evidence_pending"], 1)
        self.assertEqual(summary["protected_legacy_zero_evidence_selected"], 1)
        self.assertEqual(summary["remaining"], 0)
        self.assertFalse(summary["rules"]["automatic_promotion"])
        schema = current["discovery_catalogue"]["track_schema"]
        row = current["discovery_catalogue"]["tracks"][0]
        self.assertEqual(
            subject.field(row, schema, "soundcharts_evidence_contract"),
            subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
        )
        self.assertIsNone(
            subject.field(row, schema, "source_evidence")["instrumental"]
        )
        self.assertEqual(
            subject.field(row, schema, "source_evidence")["instrumentalness"],
            0.88,
        )

    def test_protected_checked_explicit_evidence_is_not_reopened(self):
        current, protected_spotify_id = protected_checked_payload(
            genres=[{"root": "Ambient", "sub": ["Dark Ambient"]}],
            evidence_contract=subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
        )
        client = FakeClient({})

        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            client,
            workers=1,
            max_requests=1,
            protected_spotify_ids={protected_spotify_id},
        )

        self.assertEqual(client.paths, [])
        self.assertEqual(summary["protected_legacy_zero_evidence_pending"], 0)
        self.assertEqual(summary["selected"], 0)

    def test_protected_current_zero_evidence_contract_is_not_reopened_forever(self):
        current, protected_spotify_id = protected_checked_payload(
            evidence_contract=subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
            source_evidence={"schema_version": 2, "ai_risk": "unknown"},
        )
        client = FakeClient({})

        summary = subject.classify_soundcharts_genres(
            current,
            {"version": 1, "tracks": {}, "artists": {}},
            client,
            workers=1,
            max_requests=1,
            protected_spotify_ids={protected_spotify_id},
        )

        self.assertEqual(client.paths, [])
        self.assertEqual(summary["protected_legacy_zero_evidence_pending"], 0)
        self.assertEqual(summary["remaining"], 0)

    def test_protected_legacy_404_is_terminal_and_never_refetched(self):
        current, protected_spotify_id = protected_checked_payload()
        cache = {"version": 1, "tracks": {}, "artists": {}}
        client = FakeClient(
            {
                "/api/v2.25/song/protected-uuid":
                    subject.SoundchartsDataUnavailableError(404),
            }
        )
        with patch.object(subject, "utc_now", return_value="2026-08-10T00:00:00Z"):
            first = subject.classify_soundcharts_genres(
                current,
                cache,
                client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )

        schema = current["discovery_catalogue"]["track_schema"]
        row = current["discovery_catalogue"]["tracks"][0]
        refresh = subject.field(row, schema, "soundcharts_evidence_refresh")
        self.assertEqual(refresh["status"], "terminal_unavailable")
        self.assertEqual(refresh["error_code"], "http_404")
        self.assertEqual(first["protected_legacy_terminal_after"], 1)

        no_call_client = FakeClient({})
        with patch.object(subject, "utc_now", return_value="2026-08-20T00:00:00Z"):
            second = subject.classify_soundcharts_genres(
                current,
                cache,
                no_call_client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )
        self.assertEqual(no_call_client.paths, [])
        self.assertEqual(second["selected"], 0)
        self.assertEqual(second["protected_legacy_terminal_before"], 1)

    def test_protected_legacy_invalid_payload_is_terminal(self):
        current, protected_spotify_id = protected_checked_payload()
        cache = {"version": 1, "tracks": {}, "artists": {}}
        client = FakeClient({"/api/v2.25/song/protected-uuid": {"object": []}})
        with patch.object(subject, "utc_now", return_value="2026-08-10T00:00:00Z"):
            first = subject.classify_soundcharts_genres(
                current,
                cache,
                client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )

        schema = current["discovery_catalogue"]["track_schema"]
        row = current["discovery_catalogue"]["tracks"][0]
        refresh = subject.field(row, schema, "soundcharts_evidence_refresh")
        self.assertEqual(refresh["status"], "terminal_invalid_response")
        self.assertEqual(first["invalid_responses"], 1)
        self.assertEqual(first["protected_legacy_terminal_after"], 1)

        no_call_client = FakeClient({})
        with patch.object(subject, "utc_now", return_value="2026-08-20T00:00:00Z"):
            second = subject.classify_soundcharts_genres(
                current,
                cache,
                no_call_client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )
        self.assertEqual(no_call_client.paths, [])
        self.assertEqual(second["selected"], 0)

    def test_protected_legacy_transient_failures_backoff_then_stop_at_cap(self):
        current, protected_spotify_id = protected_checked_payload()
        cache = {"version": 1, "tracks": {}, "artists": {}}

        def fail_at(timestamp):
            client = FakeClient(
                {
                    "/api/v2.25/song/protected-uuid":
                        subject.SoundchartsHttpError(503),
                }
            )
            with patch.object(subject, "utc_now", return_value=timestamp):
                summary = subject.classify_soundcharts_genres(
                    current,
                    cache,
                    client,
                    workers=1,
                    max_requests=1,
                    protected_spotify_ids={protected_spotify_id},
                )
            return client, summary

        first_client, first = fail_at("2026-08-10T00:00:00Z")
        self.assertEqual(len(first_client.paths), 1)
        self.assertEqual(first["protected_legacy_retry_waiting_after"], 1)

        waiting_client = FakeClient({})
        with patch.object(subject, "utc_now", return_value="2026-08-10T01:00:00Z"):
            waiting = subject.classify_soundcharts_genres(
                current,
                cache,
                waiting_client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )
        self.assertEqual(waiting_client.paths, [])
        self.assertEqual(waiting["protected_legacy_retry_waiting_before"], 1)

        second_client, second = fail_at("2026-08-10T07:00:00Z")
        self.assertEqual(len(second_client.paths), 1)
        self.assertEqual(second["protected_legacy_retry_waiting_after"], 1)
        third_client, third = fail_at("2026-08-10T20:00:00Z")
        self.assertEqual(len(third_client.paths), 1)
        self.assertEqual(third["protected_legacy_terminal_after"], 1)

        schema = current["discovery_catalogue"]["track_schema"]
        row = current["discovery_catalogue"]["tracks"][0]
        refresh = subject.field(row, schema, "soundcharts_evidence_refresh")
        self.assertEqual(refresh["attempts"], 3)
        self.assertEqual(refresh["status"], "terminal_retry_exhausted")

        terminal_client = FakeClient({})
        with patch.object(subject, "utc_now", return_value="2026-08-20T00:00:00Z"):
            terminal = subject.classify_soundcharts_genres(
                current,
                cache,
                terminal_client,
                workers=1,
                max_requests=1,
                protected_spotify_ids={protected_spotify_id},
            )
        self.assertEqual(terminal_client.paths, [])
        self.assertEqual(terminal["protected_legacy_terminal_before"], 1)

    def test_explicit_artist_catalogue_can_be_exactly_classified_without_becoming_an_opportunity(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        schema.append("source_tier")
        current["editorial"]["tracks"][0].append("explicit_artist_catalogue")
        row = current["editorial"]["tracks"][0]
        row[schema.index("instrumental_status")] = "unknown"
        row[schema.index("instrumental_confidence")] = None
        row[schema.index("ai_risk")] = "unknown"
        detail = song_detail()
        detail["object"]["genres"] = [{"root": "Ambient", "sub": ["Instrumental"]}]
        cache = {"version": 1, "tracks": {}, "artists": {}}
        summary = subject.classify_soundcharts_genres(
            current,
            cache,
            FakeClient({"/api/v2.25/song/song-uuid": detail}),
            workers=1,
            max_requests=1,
        )
        refreshed_schema = current["editorial"]["track_schema"]
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(subject.field(row, refreshed_schema, "primary_genre"), "ambient")
        self.assertEqual(subject.field(row, refreshed_schema, "ai_risk"), "unknown")
        self.assertNotIn("explicit_artist_catalogue", subject.PLAYLIST_SOURCE_TIERS)

    def test_expansion_inserts_track_history_artist_and_contact(self):
        client = FakeClient(
            {
                "/audience/spotify?": audience_response(),
                "/api/v2.25/song/song-uuid": song_detail(),
                "/artist/artist-uuid/identifiers": identifiers_response(),
                "/artist/artist-uuid/streaming/spotify/listening?": stats_response(),
            }
        )
        soundcharts = payload()
        performance = {"tracks": {}, "artists": {}, "playlists": {}}
        cache = {"version": 1, "tracks": {}, "artists": {}}
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)):
            summary = subject.expand_instrumental_pool(
                soundcharts,
                performance,
                cache,
                client,
                workers=1,
                max_requests=20,
                limit=1,
            )

        self.assertEqual(summary["measured"], 1)
        self.assertEqual(summary["daily_delta_ready"], 1)
        self.assertEqual(summary["catalog_total"], 271713)
        schema = soundcharts["schemas"]["tracks"]
        row = soundcharts["tracks"][0]
        self.assertEqual(subject.field(row, schema, "spotify_id"), "4vFL08pP0H9RDUVj05qXyL")
        self.assertEqual(subject.field(row, schema, "streams"), 155)
        self.assertEqual(subject.field(row, schema, "delta"), 35)
        self.assertEqual(subject.field(row, schema, "primary_genre"), "ambient")
        self.assertEqual(subject.field(row, schema, "rights_status"), "self_released")
        artists = subject.field(row, schema, "artists")
        self.assertEqual(artists[0]["spotify_id"], "2JG4r9snKhqze9RGKeGEvh")

        history = performance["tracks"]["4vFL08pP0H9RDUVj05qXyL"]["history"]
        self.assertEqual(history[-2:], [["2026-07-20", 120], ["2026-07-21", 155]])
        artist_schema = soundcharts["schemas"]["artists"]
        artist = soundcharts["artists"][0]
        self.assertEqual(subject.field(artist, artist_schema, "monthly_listeners"), 1_283_880)
        self.assertEqual(subject.field(artist, artist_schema, "contact_url"), "https://instagram.com/novaissue")
        self.assertEqual(
            subject.field(artist, artist_schema, "public_contacts"),
            [{"platform": "instagram", "url": "https://instagram.com/novaissue"}],
        )
        listening_paths = [
            path for path in client.paths if "/streaming/spotify/listening?" in path
        ]
        self.assertEqual(len(listening_paths), 1)
        self.assertFalse(any("/current/stats" in path for path in client.paths))
        parsed = urllib.parse.urlsplit(listening_paths[0])
        self.assertEqual(
            urllib.parse.parse_qs(parsed.query),
            {
                "startDate": ["2026-04-23"],
                "endDate": ["2026-07-21"],
                "limit": ["100"],
                "sort": ["asc"],
            },
        )
        self.assertEqual(
            cache["artists"]["artist-uuid"]["monthly_listeners_source"],
            "soundcharts_artist_streaming_spotify_listening",
        )

    def test_artist_stats_parser_uses_latest_valid_listening_point(self):
        response = stats_response()
        response["items"].extend(
            [
                {"date": "invalid", "value": 9_999_999},
                {"date": "2026-07-22", "value": True},
                {"date": "2026-07-21T23:00:00+00:00", "value": 1_284_000},
            ]
        )

        self.assertEqual(
            subject.parse_artist_stats(response),
            {
                "monthly_listeners": 1_284_000,
                "monthly_listeners_change": 49_609,
                "monthly_listeners_date": "2026-07-21",
                "monthly_listeners_source": "soundcharts_artist_streaming_spotify_listening",
            },
        )
        self.assertEqual(subject.parse_artist_stats({"items": []}), {})
        self.assertIsNone(
            subject.parse_artist_stats(
                {
                    "items": [
                        {"date": "2026-07-18", "value": 1_200_000},
                        {"date": "2026-07-21", "value": 1_284_000},
                    ]
                }
            )["monthly_listeners_change"]
        )

    def test_weak_candidate_refresh_preserves_existing_strict_track_evidence(self):
        current = payload()
        editorial_schema = current["editorial"]["track_schema"]
        editorial_schema.append("source_tier")
        editorial_row = current["editorial"]["tracks"][0]
        editorial_row.append("editorial_playlist")
        editorial_row[editorial_schema.index("instrumental_status")] = "unknown"
        editorial_row[editorial_schema.index("instrumental_confidence")] = None
        editorial_row[editorial_schema.index("ai_risk")] = "unknown"
        editorial_row[editorial_schema.index("expansion_status")] = "review"

        track_schema, track_rows = subject.ensure_schema_fields(
            current,
            "tracks",
            subject.TRACK_EXTRA_FIELDS,
        )
        strict_artists = [
            {
                "soundcharts_uuid": "strict-artist-uuid",
                "spotify_id": "strict-artist-spotify",
                "name": "Strict Artist",
                "role": "main",
            }
        ]
        strict_values = {
            "spotify_id": "4vFL08pP0H9RDUVj05qXyL",
            "artist": "Strict Artist",
            "title": "Approved title",
            "streams": 120,
            "rights_status": "self_released",
            "rights_confidence": 0.95,
            "status_source": "soundcharts_strict",
            "soundcharts_uuid": "song-uuid",
            "artists": strict_artists,
            "primary_genre": "dark_ambient",
            "subgenres": ["drone"],
            "genre_confidence": 0.93,
            "genre_source": "soundcharts_strict",
            "soundcharts_genres": [{"root": "Ambient", "sub": ["Dark Ambient"]}],
            "soundcharts_genres_checked_at": "2026-07-20T00:00:00Z",
            "instrumental_status": "instrumental",
            "instrumental_confidence": 0.97,
            "ai_risk": "low",
            "ai_risk_score": 0.02,
            "expansion_status": "eligible",
            "source_tier": "instrumental_editorial",
        }
        strict_row = subject._new_row(track_schema)
        for name, value in strict_values.items():
            subject.set_field(strict_row, track_schema, name, value)
        track_rows.append(strict_row)

        detail = song_detail()
        detail["object"]["name"] = "Fresh metadata title"
        detail["object"]["label"] = "Fresh metadata label"
        detail["object"]["artists"] = []
        detail["object"]["mainArtists"] = []
        client = FakeClient(
            {
                "/audience/spotify?": audience_response(),
                "/api/v2.25/song/song-uuid": detail,
            }
        )
        performance = {"tracks": {}, "artists": {}, "playlists": {}}
        cache = {"version": 1, "tracks": {}, "artists": {}}
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)):
            summary = subject.expand_instrumental_pool(
                current,
                performance,
                cache,
                client,
                workers=1,
                max_requests=5,
                limit=1,
            )

        self.assertEqual(summary["updated_tracks"], 1)
        self.assertEqual(summary["needs_listen_measured"], 1)
        self.assertEqual(subject.field(strict_row, track_schema, "streams"), 155)
        self.assertEqual(subject.field(strict_row, track_schema, "delta"), 35)
        self.assertEqual(subject.field(strict_row, track_schema, "title"), "Fresh metadata title")
        self.assertEqual(subject.field(strict_row, track_schema, "label"), "Fresh metadata label")
        self.assertEqual(
            subject.field(strict_row, track_schema, "spotify_aliases"),
            ["4vFL08pP0H9RDUVj05qXyL"],
        )
        for name, value in strict_values.items():
            if name in {"artist", "title", "streams"}:
                continue
            self.assertEqual(subject.field(strict_row, track_schema, name), value, name)

    def test_normal_projection_uses_sticky_cached_vocal_evidence(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        schema.append("source_tier")
        row = current["editorial"]["tracks"][0]
        row.append("editorial_playlist")
        row[schema.index("instrumental_status")] = "unknown"
        row[schema.index("instrumental_confidence")] = None
        row[schema.index("ai_risk")] = "unknown"
        row[schema.index("expansion_status")] = "review"

        detail = song_detail()
        detail["object"]["artists"] = []
        detail["object"]["mainArtists"] = []
        detail["object"]["genres"] = [
            {"root": "Ambient", "sub": ["Instrumental"]}
        ]
        detail["evidence"] = {
            "instrumental": True,
            "audioFeatures": {"instrumentalness": 0.98, "speechiness": 0.01},
        }
        client = FakeClient(
            {
                "/audience/spotify?": audience_response(),
                "/api/v2.25/song/song-uuid": detail,
            }
        )
        cache = {
            "version": 1,
            "tracks": {
                "song-uuid": {
                    "instrumental_status": "vocal",
                    "instrumental_confidence": 0.95,
                    "source_evidence": {
                        "vocal": True,
                        "explicit": True,
                        "instrumental": False,
                        "speechiness": 0.54,
                    },
                    "fetched_at": "2026-01-01T00:00:00Z",
                    "soundcharts_genres_checked_at": "2026-01-01T00:00:00Z",
                }
            },
            "artists": {},
        }
        performance = {"tracks": {}, "artists": {}, "playlists": {}}

        with (
            patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)),
            self.assertRaisesRegex(
                subject.InstrumentalPoolError,
                "No target Soundcharts track returned a usable Spotify stream history",
            ),
        ):
            subject.expand_instrumental_pool(
                current,
                performance,
                cache,
                client,
                workers=1,
                max_requests=5,
                limit=1,
            )

        merged = cache["tracks"]["song-uuid"]
        self.assertEqual(merged["instrumental_status"], "vocal")
        self.assertTrue(merged["source_evidence"]["vocal"])
        self.assertTrue(merged["source_evidence"]["explicit"])
        self.assertFalse(merged["source_evidence"]["instrumental"])
        self.assertEqual(subject.field(row, schema, "instrumental_status"), "vocal")
        self.assertEqual(current["tracks"], [])
        self.assertEqual(performance["tracks"], {})

    def test_parallel_expansion_propagates_quota_reserve_stop(self):
        class ReserveClient:
            def get(self, _path):
                raise subject.SoundchartsQuotaReserveError("protected reserve reached")

        with self.assertRaises(subject.SoundchartsQuotaReserveError):
            subject.parallel_requests(
                ReserveClient(),
                [("track", "/api/v2/song/track")],
                subject.RequestBudget(1),
                workers=1,
            )

    def test_parallel_expansion_propagates_request_limit_stop(self):
        class LimitedClient:
            def get(self, _path):
                raise subject.SoundchartsRequestLimitError("request cap reached")

        with self.assertRaises(subject.SoundchartsRequestLimitError):
            subject.parallel_requests(
                LimitedClient(),
                [("track", "/api/v2/song/track")],
                subject.RequestBudget(1),
                workers=1,
            )

    def test_parallel_auth_failure_cancels_unstarted_work_and_returns_immediately(self):
        for status in (401, 403):
            with self.subTest(status=status):
                slow_started = threading.Event()
                release_slow = threading.Event()
                call_done = threading.Event()
                paths: list[str] = []
                paths_lock = threading.Lock()
                caught: list[BaseException] = []

                class AuthClient:
                    def get(self, path):
                        with paths_lock:
                            paths.append(path)
                        if path == "/auth":
                            if not slow_started.wait(1):
                                raise AssertionError("second worker did not start")
                            raise subject.SoundchartsHttpError(status)
                        if path == "/slow":
                            slow_started.set()
                            release_slow.wait(5)
                            return {"ok": True}
                        raise AssertionError(f"cancelled task unexpectedly started: {path}")

                def invoke():
                    try:
                        subject.parallel_requests_detailed(
                            AuthClient(),
                            [
                                ("auth", "/auth"),
                                ("slow", "/slow"),
                                ("never-1", "/never-1"),
                                ("never-2", "/never-2"),
                            ],
                            subject.RequestBudget(4),
                            workers=2,
                        )
                    except BaseException as exc:  # captured from worker test thread
                        caught.append(exc)
                    finally:
                        call_done.set()

                caller = threading.Thread(target=invoke, daemon=True)
                caller.start()
                try:
                    self.assertTrue(
                        call_done.wait(1),
                        "auth failure waited for an unrelated in-flight request",
                    )
                finally:
                    release_slow.set()
                    caller.join(2)

                self.assertEqual(len(caught), 1)
                self.assertIsInstance(caught[0], subject.SoundchartsHttpError)
                self.assertEqual(caught[0].status, status)
                self.assertCountEqual(paths, ["/auth", "/slow"])

    def test_playlist_discovery_unknown_ai_enters_measurement_as_needs_listen(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        for name in (
            "source_tier",
            "playlist_ids",
            "playlist_names",
            "playlist_count",
            "playlist_best_position",
            "playlist_followers_total",
            "discovered_at",
        ):
            schema.append(name)
            current["editorial"]["tracks"][0].append(None)
        row = current["editorial"]["tracks"][0]
        row[schema.index("instrumental_status")] = "unknown"
        row[schema.index("instrumental_confidence")] = None
        row[schema.index("ai_risk")] = "unknown"
        row[schema.index("expansion_status")] = "review"
        row[schema.index("source_tier")] = "editorial_playlist"
        row[schema.index("playlist_count")] = 2
        row[schema.index("playlist_followers_total")] = 1_500_000
        row[schema.index("discovered_at")] = "2026-07-21T10:00:00Z"

        candidates = subject.editorial_candidates(current)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["classification_status"], "needs_listen")
        self.assertEqual(candidates[0]["source_tier"], "editorial_playlist")

    def test_candidate_priority_keeps_opportunities_then_new_playlist_tracks(self):
        current = payload()
        schema = current["editorial"]["track_schema"]
        for name in ("source_tier", "playlist_count", "playlist_followers_total", "discovered_at"):
            schema.append(name)
            current["editorial"]["tracks"][0].append(None)
        original = current["editorial"]["tracks"][0]
        original[schema.index("source_tier")] = "instrumental_editorial"

        playlist_row = copy.deepcopy(original)
        playlist_row[schema.index("soundcharts_uuid")] = "playlist-song"
        playlist_row[schema.index("name")] = "Playlist Discovery"
        playlist_row[schema.index("instrumental_status")] = "unknown"
        playlist_row[schema.index("instrumental_confidence")] = None
        playlist_row[schema.index("ai_risk")] = "unknown"
        playlist_row[schema.index("expansion_status")] = "review"
        playlist_row[schema.index("source_tier")] = "editorial_playlist"
        playlist_row[schema.index("playlist_count")] = 3
        playlist_row[schema.index("playlist_followers_total")] = 2_000_000
        playlist_row[schema.index("discovered_at")] = "2026-07-21T10:00:00Z"
        current["editorial"]["tracks"].append(playlist_row)

        opp_schema = ["soundcharts_uuid"]
        current["schemas"]["opportunities"] = opp_schema
        current["opportunities"] = [["song-uuid"]]
        candidates = subject.editorial_candidates(current)
        ordered = subject.prioritize_candidates(current, {"tracks": {}}, candidates)
        self.assertEqual([item["soundcharts_uuid"] for item in ordered], ["song-uuid", "playlist-song"])

    def test_major_rights_are_excluded_by_classifier(self):
        rights, confidence = subject.infer_rights(
            "Columbia Records",
            "℗ 2026 Sony Music Entertainment",
            [{"name": "Artist"}],
            "Artist",
        )
        self.assertEqual(rights, "major")
        self.assertGreater(confidence, 0.9)

    def test_exclusive_license_overrides_oneheart_artist_owned_label(self):
        for spelling in ("license", "licence"):
            with self.subTest(spelling=spelling):
                rights, confidence = subject.infer_rights(
                    "Øneheart",
                    f"℗ 2026 Øneheart, under exclusive {spelling} to Dreamscape Records",
                    [{"name": "Øneheart"}],
                    "Øneheart",
                )
                self.assertEqual(rights, "independent_label")
                self.assertGreaterEqual(confidence, 0.98)

    def test_exclusive_license_from_also_identifies_the_label(self):
        rights, confidence = subject.infer_rights(
            "Amen Worldwide",
            "\u00a9 2022 Amen Worldwide (under exclusive license from John Lee)",
            [{"name": "John Lee"}],
            "John Lee",
        )
        self.assertEqual(rights, "independent_label")
        self.assertGreaterEqual(confidence, 0.98)

    def test_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            payload = {
                "version": 1,
                "tracks": {
                    "a": {
                        "spotify_id": "x",
                        "soundcharts_evidence_refresh": {
                            "contract": subject.SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
                            "status": "retry_wait",
                            "attempts": 1,
                            "last_attempt_at": "2026-08-10T00:00:00Z",
                            "next_retry_at": "2026-08-10T06:00:00Z",
                            "error_code": "http_503",
                        },
                    }
                },
                "artists": {},
            }
            subject.write_cache(path, payload)
            self.assertEqual(subject.read_cache(path)["tracks"], payload["tracks"])

    def test_cache_read_reconciles_exclusive_licence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            subject.write_cache(
                path,
                {
                    "version": 1,
                    "tracks": {
                        "oneheart-song": {
                            "spotify_id": "oneheart-track",
                            "label": "Øneheart",
                            "copyright": (
                                "℗ 2026 Øneheart, under exclusive licence "
                                "to Dreamscape Records"
                            ),
                            "rights_status": "self_released",
                            "rights_confidence": 0.9,
                        }
                    },
                    "artists": {},
                },
            )
            cached = subject.read_cache(path)["tracks"]["oneheart-song"]
            self.assertEqual(cached["rights_status"], "independent_label")
            self.assertEqual(cached["label"], "Dreamscape Records")
            self.assertGreaterEqual(cached["rights_confidence"], 0.98)

    def test_cache_drops_snapshot_only_track_duplicates(self):
        payload = {
            "version": 1,
            "tracks": {
                "song-uuid": {
                    "soundcharts_uuid": "song-uuid",
                    "title": "Track",
                    "playlist_placements": [{"spotify_id": "playlist"}],
                    "updated_at": "2026-07-24T00:00:00Z",
                    "soundcharts_genres_checked_at": "2026-07-24T00:00:00Z",
                }
            },
            "artists": {},
        }
        compacted = subject.compact_cache(payload)
        self.assertEqual(compacted["tracks"]["song-uuid"]["title"], "Track")
        self.assertIn("soundcharts_genres_checked_at", compacted["tracks"]["song-uuid"])
        self.assertNotIn("soundcharts_uuid", compacted["tracks"]["song-uuid"])
        self.assertNotIn("playlist_placements", compacted["tracks"]["song-uuid"])
        self.assertNotIn("updated_at", compacted["tracks"]["song-uuid"])


if __name__ == "__main__":
    unittest.main()
