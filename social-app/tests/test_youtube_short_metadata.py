from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from enrich_youtube_short_metadata import iso_from_details, update_from_details


class YouTubeShortMetadataTests(unittest.TestCase):
    def test_prefers_public_timestamp_and_marks_it_exact(self) -> None:
        post = {"publishedAt": None, "raw": {}}
        changed = update_from_details(post, {"timestamp": 1_689_953_220}, "2026-08-04T16:00:00Z")
        self.assertTrue(changed)
        self.assertEqual(post["publishedAt"], "2023-07-21T15:27:00Z")
        self.assertEqual(post["raw"]["publishedAtPrecision"], "exact")

    def test_falls_back_to_upload_date(self) -> None:
        self.assertEqual(iso_from_details({"upload_date": "20230721"}), "2023-07-21T00:00:00Z")
        self.assertIsNone(iso_from_details({"upload_date": "not-a-date"}))


if __name__ == "__main__":
    unittest.main()
