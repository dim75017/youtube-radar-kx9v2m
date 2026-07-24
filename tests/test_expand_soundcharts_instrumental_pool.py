import copy
import datetime as dt
import tempfile
import unittest
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
        "related": {"name": "Nova Issue", "imageUrl": "https://assets.test/nova.jpg"},
        "social": [{"platform": "spotify", "value": 2196, "date": "2026-07-21"}],
        "streaming": [
            {
                "platform": "spotify",
                "value": 1_283_880,
                "date": "2026-07-21",
                "evolution": 49_489,
            }
        ],
    }


class InstrumentalPoolTests(unittest.TestCase):
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
        self.assertEqual(parsed["instrumental_confidence"], 0.95)
        self.assertEqual(parsed["soundcharts_genres"][0]["root"], "Hip-Hop/Rap")

    def test_explicit_vocal_genre_never_becomes_instrumental(self):
        detail = song_detail()
        detail["object"]["genres"] = [{"root": "Vocal Jazz", "sub": ["Singer Songwriter"]}]
        editorial = subject.editorial_candidates(payload())[0]
        parsed = subject.parse_song_detail(detail, editorial)
        self.assertEqual(parsed["instrumental_status"], "vocal")
        self.assertEqual(parsed["instrumental_confidence"], 0.95)

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
            FakeClient({"/api/v2/song/song-uuid": detail}),
            workers=1,
            max_requests=1,
        )
        refreshed_schema = current["editorial"]["track_schema"]
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(subject.field(row, refreshed_schema, "primary_genre"), "ambient")
        self.assertEqual(subject.field(row, refreshed_schema, "genre_source"), "soundcharts_song")
        self.assertEqual(subject.field(row, refreshed_schema, "instrumental_status"), "instrumental")
        self.assertEqual(subject.field(row, refreshed_schema, "ai_risk"), "unknown")
        self.assertTrue(subject.field(row, refreshed_schema, "soundcharts_genres_checked_at"))

    def test_expansion_inserts_track_history_artist_and_contact(self):
        client = FakeClient(
            {
                "/audience/spotify?": audience_response(),
                "/api/v2/song/song-uuid": song_detail(),
                "/artist/artist-uuid/identifiers": identifiers_response(),
                "/artist/artist-uuid/current/stats": stats_response(),
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

    def test_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            payload = {"version": 1, "tracks": {"a": {"spotify_id": "x"}}, "artists": {}}
            subject.write_cache(path, payload)
            self.assertEqual(subject.read_cache(path)["tracks"], payload["tracks"])


if __name__ == "__main__":
    unittest.main()
