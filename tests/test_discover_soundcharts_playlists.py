import copy
import datetime as dt
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

    def test_editorial_title_signal_overrides_broad_source_bucket(self):
        payload = {
            "cols": ["id", "name", "owner", "curatorCat", "followers", "tracks", "genre"],
            "rows": [
                ["lofi-beats", "lofi beats", "Spotify", "editorial", 1_000_000, 100, "Ambient"],
                ["37i9dQZF1DWZeKCadgRdKQ", "Deep Focus", "Spotify", "editorial", 1_000_000, 100, "Lofi / chillhop"],
            ],
        }
        selected = subject.select_editorial_playlists(payload)
        by_id = {item["spotify_id"]: item["primary_genre"] for item in selected}
        self.assertEqual(by_id["lofi-beats"], "lofi_hip_hop")
        self.assertEqual(by_id["37i9dQZF1DWZeKCadgRdKQ"], "ambient")

    def test_independent_playlist_selection_requires_strong_background_signal(self):
        payload = {
            "cols": ["id", "name", "owner", "curatorCat", "followers", "tracks", "genre", "use_case", "kw"],
            "rows": [
                ["lofi", "Lofi hip hop beats to study", "Curator", "independent", 800_000, 200, "Ambient", "Study", "lofi beats|lofi for study"],
                ["ambient", "Dark Ambient for Deep Focus", "Curator", "independent", 200_000, 90, "Other / multi-genre", "Focus", "dark ambient music"],
                ["running", "RUNNING Music Hits 2026", "Curator", "independent", 1_800_000, 100, "Lofi / chillhop", "Focus", "work music"],
                ["gym", "GYM PHONK 2026", "Curator", "independent", 1_700_000, 120, "Lofi / chillhop", "Focus", "work music"],
                ["house", "Deep House Covers", "Curator", "independent", 400_000, 80, "Ambient", "Focus", "ambient for work"],
            ],
        }
        selected = subject.select_playlists(payload, "independent")
        self.assertEqual([item["spotify_id"] for item in selected], ["lofi", "ambient"])
        self.assertEqual(selected[0]["source_tier"], "independent_playlist")
        self.assertEqual(selected[1]["primary_genre"], "dark_ambient")

    def test_targeted_dark_ambient_scope_and_follower_floor(self):
        payload = {
            "cols": ["id", "name", "owner", "curatorCat", "followers", "tracks", "genre", "use_case", "kw"],
            "rows": [
                ["dark-small", "Dark Ambient", "Curator", "independent", 9_999, 60, "Ambient", "Focus", "dark ambient music"],
                ["dark-large", "Dark Ambient", "Curator", "independent", 10_000, 90, "Ambient", "Focus", "dark ambient music"],
                ["ambient-large", "Ambient", "Curator", "independent", 500_000, 90, "Ambient", "Focus", "ambient music"],
            ],
        }
        selected = subject.select_playlists(payload, "dark_ambient")
        self.assertEqual([item["spotify_id"] for item in selected], ["dark-large", "dark-small"])
        eligible = subject.filter_playlists_by_followers(selected, 10_000)
        self.assertEqual([item["spotify_id"] for item in eligible], ["dark-large"])

    def test_targeted_scan_resolves_unknown_audiences_before_follower_floor(self):
        payload = {
            "cols": ["id", "name", "owner", "curatorCat", "followers", "tracks", "genre", "use_case", "kw"],
            "rows": [
                ["dark-unknown", "Dark Ambient", "Curator", "independent", 0, 0, "Ambient", "Focus", "dark ambient music"],
                ["dark-small", "Dark Ambient Sleep", "Curator", "independent", 9_000, 10, "Ambient", "Focus", "dark ambient music"],
            ],
        }
        page = {"page": {"offset": 0, "limit": 100, "total": 1, "next": None}, "items": [{"position": 1, "entryDate": "2026-07-20", "song": {"uuid": "dark-song", "name": "Night", "creditName": "Artist"}}]}
        client = FakeClient(
            {
                "/by-platform/spotify/dark-unknown": {"object": {"uuid": "dark-playlist-unknown", "latestSubscriberCount": 20_000, "latestTrackCount": 1}},
                "/by-platform/spotify/dark-small": {"object": {"uuid": "dark-playlist-small", "latestSubscriberCount": 9_000, "latestTrackCount": 1}},
                "/playlist/dark-playlist-unknown/tracks/latest": page,
            }
        )
        soundcharts = empty_soundcharts()
        cache = {"version": 1, "tracks": {}, "artists": {}}
        summary = subject.discover_from_playlists(
            soundcharts, payload, cache, client, workers=1,
            playlist_scope="dark_ambient", min_playlist_followers=10_000,
            max_new_playlist_tracks=0, max_catalog_artists=0,
        )
        self.assertEqual(summary["playlists_candidates"], 2)
        self.assertEqual(summary["playlists_targeted"], 1)
        self.assertEqual(summary["playlists_scanned"], 1)

    def test_independent_playlist_rotation_prefers_unscanned_then_oldest(self):
        rows = [
            {"spotify_id": "new", "name": "New", "followers": 10},
            {"spotify_id": "old", "name": "Old", "followers": 100},
            {"spotify_id": "recent", "name": "Recent", "followers": 1_000},
        ]
        ordered = subject.playlist_scan_order(
            rows,
            {
                "old": {"last_scan_at": "2026-07-01T00:00:00Z"},
                "recent": {"last_scan_at": "2026-07-23T00:00:00Z"},
            },
            limit=3,
        )
        self.assertEqual([item["spotify_id"] for item in ordered], ["new", "old", "recent"])

    def test_dark_ambient_playlists_are_prioritized_within_each_rotation(self):
        rows = [
            {"spotify_id": "generic", "name": "Ambient", "followers": 2_000_000, "primary_genre": "ambient"},
            {"spotify_id": "dark", "name": "Dark Ambient", "followers": 1_000, "primary_genre": "dark_ambient"},
            {"spotify_id": "piano", "name": "Piano", "followers": 3_000_000, "primary_genre": "piano"},
        ]
        ordered = subject.playlist_scan_order(rows, {}, limit=3)
        self.assertEqual([item["spotify_id"] for item in ordered], ["dark", "piano", "generic"])

    def test_editorial_source_remains_authoritative_over_independent(self):
        self.assertEqual(
            subject.preferred_source_tier("editorial_playlist", "independent_playlist"),
            "editorial_playlist",
        )

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
            },
        ]
        evidence = subject.aggregate_track_evidence(placements, "2026-07-21")["song-1"]
        self.assertEqual(evidence["playlist_count"], 2)
        self.assertEqual(evidence["playlist_best_position"], 5)
        self.assertEqual(evidence["playlist_followers_total"], 350_000)
        self.assertEqual(evidence["primary_genre"], "ambient")

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
                baseline={
                    "source_track_rows": 51_053,
                    "source_artist_rows": 533,
                    "artists": [{"name": "Quiet Artist", "spotify_id": "artist-1-spotify"}],
                },
            )

        self.assertEqual(summary["playlists_scanned"], 1)
        self.assertEqual(summary["new_playlist_tracks"], 2)
        self.assertEqual(summary["new_artist_credits"], 2)
        self.assertEqual(summary["new_catalogue_tracks"], 2)
        self.assertEqual(summary["baseline_catalogue"]["source_track_rows"], 51_053)
        self.assertEqual(summary["baseline_catalogue"]["structured_artist_seeds"], 1)
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

    def test_catalogue_rotation_prioritizes_revalidated_baseline_artist(self):
        ordered = subject.catalogue_artist_order(
            ["a", "b", "c"],
            {"a": {}, "b": {}, "c": {}},
            limit=3,
            baseline_artist_uuids={"c"},
        )
        self.assertEqual(ordered, ["c", "a", "b"])

    def test_catalogue_track_cap_does_not_advance_unintegrated_artist_cursor(self):
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
                max_new_catalog_tracks=1,
            )

        self.assertEqual(summary["new_catalogue_tracks"], 1)
        state = cache["playlist_discovery"]["artists"]
        self.assertEqual(state["artist-1"]["offset"], 25)
        self.assertNotIn("artist-2", state)


if __name__ == "__main__":
    unittest.main()
