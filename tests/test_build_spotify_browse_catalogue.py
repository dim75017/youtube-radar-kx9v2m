import copy
import unittest

import build_spotify_browse_catalogue as subject


TRACK_SCHEMA = [
    "soundcharts_uuid",
    "spotify_id",
    "title",
    "artists",
    "streams",
    "playlist_count",
    "playlist_first_seen_at",
    "playlist_last_seen_at",
    "availability_status",
]
ARTIST_SCHEMA = ["soundcharts_uuid", "spotify_id", "name", "monthly_listeners", "availability_status"]


def catalogue(track_rows, artist_rows):
    return {
        "version": 1,
        "generated_at": "2026-07-22T10:00:00Z",
        "track_schema": TRACK_SCHEMA,
        "artist_schema": ARTIST_SCHEMA,
        "playlist_schema": ["spotify_id", "name", "position", "followers", "first_seen_at", "last_seen_at"],
        "tracks": track_rows,
        "artists": artist_rows,
        "counts": {},
    }


class BrowseCatalogueTests(unittest.TestCase):
    def test_merge_preserves_old_rows_and_enriches_matching_rows(self):
        old = catalogue(
            [["track-a", "", "Old title", [{"soundcharts_uuid": "artist-a", "name": "Artist A", "contact_url": "hidden"}], None, 1, "2026-07-01", "2026-07-10", "playlist_discovered"]],
            [["artist-a", "", "Artist A", None, "discovered"]],
        )
        new = catalogue(
            [
                ["track-a", "spotify-a", "New title", [{"soundcharts_uuid": "artist-a", "spotify_id": "spotify-artist-a", "name": "Artist A"}], 1234, 2, "2026-07-03", "2026-07-22", "measured"],
                ["track-b", "spotify-b", "Track B", [], 50, 0, "", "", "measured"],
            ],
            [["artist-a", "spotify-artist-a", "Artist A", 12345, "measured"]],
        )
        merged = subject.merge_catalogues([old, new])
        self.assertGreaterEqual(merged["counts"]["tracks"], 2)
        schema = merged["track_schema"]
        rows = [subject._record(row, schema) for row in merged["tracks"]]
        track_a = next(row for row in rows if row.get("soundcharts_uuid") == "track-a" and row.get("spotify_id") == "spotify-a")
        self.assertEqual(track_a["title"], "New title")
        self.assertEqual(track_a["streams"], 1234)
        self.assertEqual(track_a["playlist_first_seen_at"], "2026-07-01")
        self.assertEqual(track_a["playlist_last_seen_at"], "2026-07-22")
        self.assertNotIn("contact_url", track_a["artists"][0])

    def test_policy_keeps_browsing_full_and_ar_strict(self):
        payload = {
            "generated_at": "2026-07-22T10:00:00Z",
            "tracks": [[1]],
            "artists": [[1]],
            "opportunities": [[1], [2]],
            "discovery_catalogue": catalogue(
                [["track-a", "spotify-a", "Track A", [], 1, 0, "", "", "measured"]],
                [["artist-a", "spotify-artist-a", "Artist A", 10, "measured"]],
            ),
        }
        result = subject.build_payload(
            [(subject.Path("snapshot.js"), payload)],
            None,
            minimum_tracks=1,
        )
        self.assertEqual(result["policy"]["browsing"], "full")
        self.assertEqual(result["policy"]["ar"], "strict")
        self.assertFalse(result["policy"]["unverified_records_contactable"])
        self.assertEqual(result["strict_snapshot_counts"]["opportunities"], 2)

    def test_forbidden_contact_columns_are_removed(self):
        unsafe = copy.deepcopy(catalogue([], []))
        unsafe["artist_schema"].append("contact_email")
        unsafe["artists"] = [["artist-a", "spotify-a", "Artist A", 100, "measured", "secret@example.test"]]
        merged = subject.merge_catalogues([unsafe])
        self.assertNotIn("contact_email", merged["artist_schema"])


if __name__ == "__main__":
    unittest.main()
