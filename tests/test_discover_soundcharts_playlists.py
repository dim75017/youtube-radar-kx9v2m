import copy
import datetime as dt
import json
import tempfile
import unittest
from unittest.mock import patch

import discover_soundcharts_playlists as subject


class FakeClient:
    quota_remaining = 3_700_000

    def __init__(self, responses):
        self.responses = responses
        self.paths = []
        self.requests_claimed = 0

    def get(self, path):
        self.paths.append(path)
        self.requests_claimed += 1
        for needle, response in self.responses.items():
            if needle in path:
                return copy.deepcopy(response)
        raise AssertionError(f"Unexpected path: {path}")


def playlists_payload():
    return {
        "cols": ["id", "name", "owner", "curatorCat", "followers", "notes", "tracks", "first_seen", "last_seen", "lang", "genre"],
        "rows": [
            ["playlist-1", "Peaceful Piano", "Spotify", "editorial", 1_000_000, "ok", 2, "2026-07-01", "2026-07-21", "en", "Piano"],
            ["playlist-2", "Independent Mix", "Curator", "independent", 500_000, "ok", 2, "2026-07-01", "2026-07-21", "en", "Piano"],
            ["playlist-3", "Editorial Pop", "Spotify", "editorial", 2_000_000, "ok", 2, "2026-07-01", "2026-07-21", "en", "Pop"],
        ],
    }


def empty_soundcharts():
    return {
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
            "artist_schema": [
                "soundcharts_uuid",
                "spotify_id",
                "name",
                "monthly_listeners",
                "qualifies",
                "primary_genre",
                "subgenres",
                "genre_confidence",
                "instrumental_status",
                "instrumental_confidence",
                "ai_risk",
                "ai_risk_score",
                "expansion_status",
                "review_reasons",
                "updated_at",
            ],
            "tracks": [],
            "artists": [],
        }
    }


def playlist_metadata():
    return {
        "object": {
            "uuid": "playlist-uuid-1",
            "name": "Peaceful Piano",
            "description": "Calm piano for reading, studying and unwinding.",
            "latestSubscriberCount": 1_100_000,
            "latestTrackCount": 2,
            "latestCrawlDate": "2026-07-21",
        }
    }


def playlist_page():
    return {
        "page": {"offset": 0, "limit": 100, "total": 2, "next": None},
        "items": [
            {
                "position": 3,
                "entryDate": "2026-07-18",
                "exitDate": None,
                "song": {"uuid": "song-1", "name": "Soft Rain", "creditName": "Quiet Artist"},
            },
            {
                "position": 19,
                "entryDate": "2026-07-10",
                "exitDate": None,
                "song": {"uuid": "song-2", "name": "Night Keys", "creditName": "Second Artist"},
            },
        ],
    }


def song_detail(uuid, name, artist_uuid, artist_name):
    return {
        "object": {
            "uuid": uuid,
            "name": name,
            "creditName": artist_name,
            "releaseDate": "2026-06-01T00:00:00+00:00",
            "label": artist_name,
            "copyright": f"2026 {artist_name}",
            "artists": [{"uuid": artist_uuid, "name": artist_name, "appUrl": "", "imageUrl": ""}],
            "mainArtists": [{"uuid": artist_uuid, "name": artist_name}],
            "isrc": "TEST00000001",
            "imageUrl": "",
            "duration": 180,
            "explicit": False,
        }
    }


def catalogue_page(artist_uuid, song_uuid, title):
    return {
        "page": {"offset": 0, "limit": 25, "total": 30, "next": "next"},
        "items": [
            {
                "uuid": song_uuid,
                "name": title,
                "creditName": "Quiet Artist" if artist_uuid == "artist-1" else "Second Artist",
                "releaseDate": "2026-07-01T00:00:00+00:00",
            }
        ],
    }


class PlaylistDiscoveryTests(unittest.TestCase):
    def test_only_target_editorial_playlists_are_selected(self):
        selected = subject.select_editorial_playlists(playlists_payload())
        self.assertEqual([item["spotify_id"] for item in selected], ["playlist-1"])
        self.assertEqual(selected[0]["primary_genre"], "piano")

    def test_publisher_profile_seeds_are_prioritized_but_unclassified(self):
        publisher_sources = [
            {
                "spotify_id": "publisher-1",
                "name": "Publisher instrumental playlist",
                "primary_genre": "other_instrumental",
                "display_genre": "Unclassified publisher source",
                "followers": 0,
                "expected_tracks": 0,
                "source_tier": "publisher_profile_playlist",
                "source_profile_id": "publisher",
            }
        ]
        selected = subject.select_discovery_playlists(playlists_payload(), publisher_sources)
        self.assertEqual([item["spotify_id"] for item in selected[:2]], ["publisher-1", "playlist-1"])
        self.assertEqual(selected[0]["primary_genre"], "other_instrumental")
        self.assertEqual(selected[0]["source_tier"], "publisher_profile_playlist")

    def test_publisher_sources_require_explicit_playlist_ids(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = subject.Path(temporary_directory) / "sources.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "publishers": [
                            {
                                "id": "chillhopmusic",
                                "spotify_profile_url": "https://open.spotify.com/user/chillhopmusic",
                                "expected_public_playlists": 39,
                                "playlists": [{"spotify_id": "playlist-1", "name": "Known playlist"}],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            sources = subject.read_publisher_sources(path)
        self.assertEqual(sources[0]["source_profile_id"], "chillhopmusic")
        self.assertEqual(sources[0]["primary_genre"], "other_instrumental")

    def test_playlist_evidence_deduplicates_and_prefers_best_position(self):
        placements = [
            {
                "soundcharts_uuid": "song-1",
                "name": "Soft Rain",
                "credit_name": "Quiet Artist",
                "playlist_id": "one",
                "playlist_name": "One",
                "primary_genre": "piano",
                "playlist_followers": 100_000,
                "position": 20,
                "entry_date": "2026-07-01",
            },
            {
                "soundcharts_uuid": "song-1",
                "name": "Soft Rain",
                "credit_name": "Quiet Artist",
                "playlist_id": "one",
                "playlist_name": "One",
                "primary_genre": "piano",
                "playlist_followers": 100_000,
                "position": 5,
                "entry_date": "2026-07-02",
            },
            {
                "soundcharts_uuid": "song-1",
                "name": "Soft Rain",
                "credit_name": "Quiet Artist",
                "playlist_id": "two",
                "playlist_name": "Two",
                "primary_genre": "ambient",
                "playlist_followers": 250_000,
                "position": 12,
                "entry_date": "2026-07-03",
                "source_tier": "publisher_profile_playlist",
                "source_profile_id": "chillhopmusic",
            },
        ]
        evidence = subject.aggregate_track_evidence(placements, "2026-07-21")["song-1"]
        self.assertEqual(evidence["playlist_count"], 2)
        self.assertEqual(evidence["playlist_best_position"], 5)
        self.assertEqual(evidence["playlist_followers_total"], 350_000)
        self.assertEqual(evidence["primary_genre"], "ambient")
        self.assertEqual(evidence["source_tiers"], ["publisher_profile_playlist"])
        self.assertEqual(evidence["source_profile_ids"], ["chillhopmusic"])

    def test_discovery_onboards_playlist_tracks_artists_and_catalogues(self):
        client = FakeClient(
            {
                "/by-platform/spotify/playlist-1": playlist_metadata(),
                "/playlist/playlist-uuid-1/tracks/latest": playlist_page(),
                "/api/v2/song/song-1": song_detail("song-1", "Soft Rain", "artist-1", "Quiet Artist"),
                "/api/v2/song/song-2": song_detail("song-2", "Night Keys", "artist-2", "Second Artist"),
                "/artist/artist-1/songs?": catalogue_page("artist-1", "catalogue-song-1", "Morning Catalogue"),
                "/artist/artist-2/songs?": catalogue_page("artist-2", "catalogue-song-2", "Evening Catalogue"),
            }
        )
        soundcharts = empty_soundcharts()
        cache = {"version": 1, "tracks": {}, "artists": {}}
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)), patch.object(
            subject, "utc_now", return_value="2026-07-21T12:00:00Z"
        ):
            summary = subject.discover_from_playlists(
                soundcharts,
                playlists_payload(),
                cache,
                client,
                workers=1,
                max_new_playlist_tracks=10,
                max_catalog_artists=10,
                max_new_catalog_tracks=10,
            )

        self.assertEqual(summary["playlists_scanned"], 1)
        self.assertEqual(summary["new_playlist_tracks"], 2)
        self.assertEqual(summary["new_artist_credits"], 2)
        self.assertEqual(summary["new_catalogue_tracks"], 2)
        self.assertEqual(
            summary["playlist_metadata"]["playlist-1"]["description"],
            "Calm piano for reading, studying and unwinding.",
        )
        self.assertEqual(
            cache["playlist_discovery"]["playlists"]["playlist-1"]["description_checked_at"],
            "2026-07-21T12:00:00Z",
        )
        editorial = soundcharts["editorial"]
        track_schema = editorial["track_schema"]
        rows = {subject.field(row, track_schema, "soundcharts_uuid"): row for row in editorial["tracks"]}
        self.assertEqual(subject.field(rows["song-1"], track_schema, "source_tier"), "editorial_playlist")
        self.assertEqual(subject.field(rows["song-1"], track_schema, "playlist_best_position"), 3)
        self.assertEqual(subject.field(rows["song-1"], track_schema, "ai_risk"), "unknown")
        self.assertEqual(subject.field(rows["catalogue-song-1"], track_schema, "source_tier"), "playlist_artist_catalogue")
        self.assertEqual(subject.field(rows["catalogue-song-1"], track_schema, "expansion_status"), "review")
        artist_schema = editorial["artist_schema"]
        artist_ids = {subject.field(row, artist_schema, "soundcharts_uuid") for row in editorial["artists"]}
        self.assertEqual(artist_ids, {"artist-1", "artist-2"})
        self.assertEqual(cache["playlist_discovery"]["artists"]["artist-1"]["offset"], 25)

    def test_catalogue_rotation_prefers_never_scanned_then_oldest(self):
        ordered = subject.catalogue_artist_order(
            ["a", "b", "c"],
            {
                "a": {"last_scan_at": "2026-07-20T00:00:00Z"},
                "b": {},
                "c": {"last_scan_at": "2026-07-01T00:00:00Z"},
            },
            limit=3,
        )
        self.assertEqual(ordered, ["b", "c", "a"])


if __name__ == "__main__":
    unittest.main()
