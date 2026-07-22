import json
import sys
import types
import unittest
from pathlib import Path

try:
    import refresh_soundcharts_daily  # noqa: F401
except ModuleNotFoundError:
    stub = types.ModuleType("refresh_soundcharts_daily")
    class SoundchartsError(RuntimeError):
        pass
    class SoundchartsQuotaReserveError(SoundchartsError):
        pass
    class SoundchartsRequestLimitError(SoundchartsError):
        pass
    class SoundchartsClient:
        pass
    stub.SoundchartsError = SoundchartsError
    stub.SoundchartsQuotaReserveError = SoundchartsQuotaReserveError
    stub.SoundchartsRequestLimitError = SoundchartsRequestLimitError
    stub.SoundchartsClient = SoundchartsClient
    stub.SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
    stub.PLAYLISTS_PREFIX = "window.SPOTIFY_PLAYLISTS="
    def read_js_payload(path, prefix):
        raw = Path(path).read_text(encoding="utf-8")
        return json.loads(raw[len(prefix):].strip().removesuffix(";"))
    def write_js_payload(path, payload, prefix):
        Path(path).write_text(prefix + json.dumps(payload) + ";\n", encoding="utf-8")
    stub.read_js_payload = read_js_payload
    stub.write_js_payload = write_js_payload
    sys.modules["refresh_soundcharts_daily"] = stub

from discover_soundcharts_playlists import discover_from_playlists
from prepare_soundcharts_snapshot import _build_discovery_catalogue
from sync_soundcharts_opportunities import merged_playlist_evidence


class FakeClient:
    def __init__(self):
        self.requests_claimed = 0
        self.quota_remaining = 4_000_000

    def get(self, path):
        self.requests_claimed += 1
        if path == "/api/v2.8/playlist/by-platform/spotify/editorial-1":
            return {
                "object": {
                    "uuid": "playlist-uuid-1",
                    "name": "Test Ambient",
                    "latestSubscriberCount": 250_000,
                    "latestTrackCount": 5,
                }
            }
        if path.startswith("/api/v2.20/playlist/playlist-uuid-1/tracks/latest"):
            return {
                "page": {"offset": 0, "limit": 100, "total": 5},
                "items": [
                    {
                        "position": index + 1,
                        "entryDate": f"2026-07-{index + 1:02d}",
                        "exitDate": None,
                        "song": {
                            "uuid": f"track-{index}",
                            "name": f"Track {index}",
                            "creditName": f"Artist {index}",
                        },
                    }
                    for index in range(5)
                ],
            }
        if path in {"/api/v2/song/track-0", "/api/v2/song/track-1"}:
            index = int(path.rsplit("-", 1)[1])
            artist_uuid = f"artist-{index}"
            return {
                "object": {
                    "uuid": f"track-{index}",
                    "name": f"Track {index}",
                    "creditName": f"Artist {index}",
                    "releaseDate": "2026-07-01",
                    "label": "",
                    "copyright": f"2026 Artist {index}",
                    "artists": [{"uuid": artist_uuid, "name": f"Artist {index}"}],
                    "mainArtists": [{"uuid": artist_uuid, "name": f"Artist {index}"}],
                }
            }
        raise AssertionError(f"Unexpected Soundcharts route: {path}")


class FullDiscoveryCatalogueTests(unittest.TestCase):
    def test_every_playlist_track_is_persisted_before_detail_enrichment(self):
        soundcharts = {"editorial": {}}
        playlists = {
            "cols": ["id", "name", "curatorCat", "followers", "tracks", "genre"],
            "rows": [["editorial-1", "Test Ambient", "editorial", 250_000, 5, "Ambient"]],
        }
        cache = {}
        summary = discover_from_playlists(
            soundcharts,
            playlists,
            cache,
            FakeClient(),
            workers=1,
            page_size=100,
            max_new_playlist_tracks=2,
            max_catalog_artists=0,
            max_new_catalog_tracks=0,
        )

        editorial = soundcharts["editorial"]
        schema = editorial["track_schema"]
        rows = editorial["tracks"]
        by_uuid = {row[schema.index("soundcharts_uuid")]: row for row in rows}

        self.assertEqual(summary["unique_playlist_tracks"], 5)
        self.assertEqual(summary["new_playlist_tracks"], 5)
        self.assertEqual(summary["playlist_tracks_detailed"], 2)
        self.assertEqual(len(rows), 5)
        self.assertEqual(len(cache["tracks"]), 5)
        self.assertEqual(by_uuid["track-4"][schema.index("metadata_status")], "playlist_only")
        self.assertEqual(by_uuid["track-0"][schema.index("metadata_status")], "complete")
        placements = by_uuid["track-4"][schema.index("playlist_placements")]
        self.assertEqual(placements[0]["name"], "Test Ambient")
        self.assertEqual(placements[0]["position"], 5)
        self.assertEqual(placements[0]["first_seen_at"], "2026-07-05")

    def test_public_discovery_projection_keeps_unmeasured_rows(self):
        track_schema = [
            "soundcharts_uuid", "spotify_id", "name", "artist", "release_date",
            "primary_genre", "genre_confidence", "instrumental_status",
            "instrumental_confidence", "ai_risk", "expansion_status", "metadata_status",
            "source_tier", "playlist_ids", "playlist_names", "playlist_count",
            "playlist_best_position", "playlist_followers_total", "playlist_first_seen_at",
            "playlist_last_seen_at", "playlist_placements", "artist_soundcharts_uuids",
            "discovered_at", "updated_at", "rights_status", "rights_confidence",
        ]
        artist_schema = [
            "soundcharts_uuid", "spotify_id", "name", "monthly_listeners", "primary_genre",
            "genre_confidence", "instrumental_status", "instrumental_confidence", "ai_risk",
            "expansion_status", "source_tier", "playlist_ids", "playlist_names",
            "playlist_count", "catalogue_tracks_discovered", "discovered_at",
            "last_catalogue_scan_at",
        ]
        track = {
            "soundcharts_uuid": "track-unmeasured",
            "spotify_id": "",
            "name": "Unmeasured Track",
            "artist": "New Artist",
            "release_date": "2026-07-01",
            "primary_genre": "ambient",
            "genre_confidence": 0.7,
            "instrumental_status": "unknown",
            "instrumental_confidence": None,
            "ai_risk": "unknown",
            "expansion_status": "review",
            "metadata_status": "playlist_only",
            "source_tier": "editorial_playlist",
            "playlist_ids": ["editorial-1"],
            "playlist_names": ["Test Ambient"],
            "playlist_count": 1,
            "playlist_best_position": 12,
            "playlist_followers_total": 250_000,
            "playlist_first_seen_at": "2026-07-05",
            "playlist_last_seen_at": "2026-07-22",
            "playlist_placements": [{
                "spotify_id": "editorial-1", "name": "Test Ambient", "position": 12,
                "followers": 250_000, "first_seen_at": "2026-07-05", "last_seen_at": "2026-07-22",
            }],
            "artist_soundcharts_uuids": ["artist-unmeasured"],
            "discovered_at": "2026-07-22T00:00:00Z",
            "updated_at": "2026-07-22T00:00:00Z",
            "rights_status": "unknown",
            "rights_confidence": 0.25,
        }
        artist = {
            "soundcharts_uuid": "artist-unmeasured",
            "spotify_id": "",
            "name": "New Artist",
            "monthly_listeners": None,
            "primary_genre": "ambient",
            "genre_confidence": 0.7,
            "instrumental_status": "unknown",
            "instrumental_confidence": None,
            "ai_risk": "unknown",
            "expansion_status": "review",
            "source_tier": "editorial_playlist",
            "playlist_ids": ["editorial-1"],
            "playlist_names": ["Test Ambient"],
            "playlist_count": 1,
            "catalogue_tracks_discovered": 0,
            "discovered_at": "2026-07-22T00:00:00Z",
            "last_catalogue_scan_at": "",
        }
        payload = {
            "generated_at": "2026-07-22T00:00:00Z",
            "schemas": {"tracks": [], "opportunities": []},
            "tracks": [],
            "opportunities": [],
            "editorial": {
                "track_schema": track_schema,
                "tracks": [[track.get(name) for name in track_schema]],
                "artist_schema": artist_schema,
                "artists": [[artist.get(name) for name in artist_schema]],
            },
        }
        catalogue = _build_discovery_catalogue(payload)
        self.assertEqual(catalogue["counts"]["tracks"], 1)
        status_index = catalogue["track_schema"].index("availability_status")
        self.assertEqual(catalogue["tracks"][0][status_index], "playlist_discovered")
        placement_index = catalogue["track_schema"].index("playlist_placements")
        self.assertEqual(catalogue["tracks"][0][placement_index][0][1], "Test Ambient")

    def test_editorial_evidence_keeps_names_positions_and_dates(self):
        evidence = merged_playlist_evidence(
            {
                "playlist_placements": [
                    {
                        "spotify_id": "editorial-1",
                        "name": "Test Ambient",
                        "position": 12,
                        "followers": 250_000,
                        "first_seen_at": "2026-07-05",
                        "last_seen_at": "2026-07-22",
                    }
                ]
            },
            {},
        )
        self.assertEqual(evidence["editorial_placement_count"], 1)
        self.assertEqual(evidence["editorial_best_position"], 12)
        self.assertEqual(evidence["editorial_first_seen_at"], "2026-07-05")
        self.assertEqual(evidence["editorial_playlists"][0]["name"], "Test Ambient")


if __name__ == "__main__":
    unittest.main()
