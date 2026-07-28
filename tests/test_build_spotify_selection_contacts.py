import json
import unittest
from pathlib import Path

import build_spotify_selection_contacts as subject


class SpotifySelectionContactDirectoryTests(unittest.TestCase):
    def test_checked_in_directory_covers_the_current_selection_seed(self):
        seeds = json.loads(Path("spotify-selection-artist-seeds.json").read_text(encoding="utf-8"))["artists"]
        raw = Path("Spotify_Selection_Contacts_data.js").read_text(encoding="utf-8").strip()
        payload = json.loads(raw.removeprefix(subject.PREFIX).removesuffix(";"))
        records = payload["artists"]
        seed_ids = {row["spotify_id"] for row in seeds}
        self.assertEqual(len(seed_ids), 11)
        self.assertTrue(seed_ids.issubset(records))
        self.assertTrue(all(records[spotify_id]["priority"] for spotify_id in seed_ids))
        self.assertEqual(records["6qxdmY3SMyvfVadKXWTZQi"]["email"], "info@andantepiano.nl")
        self.assertEqual(records["77efGNIP8xtX0iCb5RCHCG"]["channels"], [])
        self.assertEqual(records["3WuT8leyL0ikW55vAra4rD"]["channels"], [])

    def test_exports_only_explicit_public_channels_and_priorities(self):
        cache = {
            "updated_at": "2026-07-28T10:00:00Z",
            "artists": {
                "uuid-a": {
                    "spotify_id": "artist-a",
                    "name": "Artist A",
                    "contact_url": "https://instagram.com/artist-a",
                    "contact_platform": "instagram",
                    "identifiers_fetched_at": "2026-07-28T09:00:00Z",
                },
                "uuid-b": {
                    "spotify_id": "artist-b",
                    "name": "Artist B",
                    "contact_url": "javascript:alert(1)",
                    "contact_research": {"checked_at": "2026-07-28T08:00:00Z", "result": "no_public_business_email"},
                },
            },
        }
        result = subject.build_directory(cache, {"artists": [{"spotify_id": "artist-a"}]}, {"artists": []})
        self.assertEqual(result["artists"]["artist-a"]["channels"], [{"platform": "instagram", "url": "https://instagram.com/artist-a"}])
        self.assertTrue(result["artists"]["artist-a"]["priority"])
        self.assertEqual(result["artists"]["artist-b"]["channels"], [])
        self.assertEqual(result["artists"]["artist-b"]["scan_status"], "no_public_contact_found")

    def test_source_backed_override_is_deduplicated(self):
        cache = {"artists": {"uuid-a": {"spotify_id": "artist-a", "contact_url": "https://artist.test", "contact_platform": "website"}}}
        overrides = {"artists": [{"spotify_id": "artist-a", "email": "BOOKING@ARTIST.TEST", "channels": [{"platform": "website", "url": "https://artist.test"}], "sources_checked": ["https://artist.test/contact"]}]}
        result = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]
        self.assertEqual(result["email"], "booking@artist.test")
        self.assertEqual(len(result["channels"]), 1)
        self.assertEqual(result["scan_status"], "email_found")
        self.assertEqual(result["sources_checked"], ["https://artist.test/contact"])

    def test_source_backed_exclusion_removes_a_false_positive(self):
        cache = {"artists": {"uuid-a": {"spotify_id": "artist-a", "contact_url": "https://soundcloud.com/wrong-profile", "contact_platform": "soundcloud"}}}
        overrides = {"artists": [{"spotify_id": "artist-a", "exclude_urls": ["https://soundcloud.com/wrong-profile"], "scan_status": "no_public_contact_found"}]}
        result = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]
        self.assertEqual(result["channels"], [])
        self.assertEqual(result["scan_status"], "no_public_contact_found")

    def test_priority_artist_missing_from_cache_is_exported_as_pending(self):
        priorities = {"artists": [{"spotify_id": "artist-new", "soundcharts_uuid": "uuid-new", "name": "New Artist"}]}
        result = subject.build_directory({"artists": {}}, priorities, {"artists": []})
        self.assertEqual(result["artists"]["artist-new"]["scan_status"], "pending")
        self.assertEqual(result["artists"]["artist-new"]["soundcharts_uuid"], "uuid-new")
        self.assertEqual(result["stats"]["priority_artists"], 1)

    def test_equivalent_social_urls_are_deduplicated(self):
        cache = {"artists": {"uuid-a": {"spotify_id": "artist-a", "contact_url": "https://instagram.com/artist-a", "contact_platform": "instagram"}}}
        overrides = {"artists": [{"spotify_id": "artist-a", "channels": [{"platform": "instagram", "url": "https://www.instagram.com/artist-a/"}], "sources_checked": ["https://www.instagram.com/artist-a/"]}]}
        channels = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]["channels"]
        self.assertEqual(channels, [{"platform": "instagram", "url": "https://www.instagram.com/artist-a/"}])

    def test_unsafe_urls_and_unsourced_override_email_are_rejected(self):
        cache = {"artists": {"uuid-a": {"spotify_id": "artist-a", "contact_url": "http://127.0.0.1/private", "contact_platform": "website"}}}
        overrides = {"artists": [{"spotify_id": "artist-a", "email": "booking@artist.test"}]}
        record = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]
        self.assertEqual(record["channels"], [])
        self.assertEqual(record["email"], "")
        self.assertEqual(record["scan_status"], "pending")

    def test_unsourced_override_channel_is_rejected(self):
        cache = {"artists": {"uuid-a": {"spotify_id": "artist-a"}}}
        overrides = {"artists": [{"spotify_id": "artist-a", "channels": [{"platform": "instagram", "url": "https://instagram.com/unverified"}]}]}
        record = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]
        self.assertEqual(record["channels"], [])
        self.assertEqual(record["scan_status"], "pending")

    def test_latest_real_contact_check_wins_over_static_override_date(self):
        cache = {
            "artists": {
                "uuid-a": {
                    "spotify_id": "artist-a",
                    "identifiers_fetched_at": "2026-07-30T08:00:00Z",
                    "contact_research": {"checked_at": "2026-07-29T08:00:00Z"},
                }
            }
        }
        overrides = {"artists": [{"spotify_id": "artist-a", "checked_at": "2026-07-28"}]}
        record = subject.build_directory(cache, {}, overrides)["artists"]["artist-a"]
        self.assertEqual(record["checked_at"], "2026-07-29T08:00:00Z")


if __name__ == "__main__":
    unittest.main()
