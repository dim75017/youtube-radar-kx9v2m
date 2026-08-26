import tempfile
import unittest
from pathlib import Path

import build_spotify_playlist_analytics as subject


class BuildSpotifyPlaylistAnalyticsTests(unittest.TestCase):
    def test_builds_only_visible_playlists_with_real_histories(self):
        source = {
            "meta": {
                "generated_ts": "2026-08-26 08:30",
                "playlist_followers_status": {
                    "day": "2026-08-26",
                    "scope": "dashboard",
                    "expected": 1,
                    "updated": 1,
                    "missing": 0,
                    "complete": True,
                },
            },
            "cols": [*subject.OUTPUT_COLUMNS, "big10k"],
            "rows": [
                [
                    "playlist-visible", "Visible", "Owner", "editorial", 12000, 50,
                    "2026-08-24", "2026-08-26", "Piano", "Focus", 18, "", "",
                    "https://assets.test/visible.jpg", 1,
                ],
                [
                    "playlist-hidden", "Hidden", "Owner", "independent", 9000, 30,
                    "2026-08-24", "2026-08-26", "Piano", "Focus", 12, "", "",
                    "https://assets.test/hidden.jpg", 0,
                ],
            ],
            "hist": {
                "playlist-visible": [
                    ["2026-08-26", 12000],
                    ["2026-08-25", 11900],
                    ["2026-08-25", 11950],
                    ["bad-day", 999],
                    ["2026-08-24", False],
                ],
                "playlist-hidden": [["2026-08-26", 9000]],
            },
        }

        payload = subject.build_payload(source)

        self.assertEqual(payload["version"], 1)
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(payload["rows"][0][0], "playlist-visible")
        self.assertEqual(
            payload["hist"]["playlist-visible"],
            [["2026-08-25", 11950], ["2026-08-26", 12000]],
        )
        self.assertNotIn("playlist-hidden", payload["hist"])

    def test_complete_status_cannot_hide_a_missing_daily_point(self):
        source = {
            "meta": {
                "playlist_followers_status": {
                    "day": "2026-08-26", "expected": 1, "complete": True,
                },
            },
            "cols": [*subject.OUTPUT_COLUMNS, "big10k"],
            "rows": [[
                "playlist-visible", "Visible", "Owner", "editorial", 12000, 50,
                "2026-08-24", "2026-08-25", "Piano", "Focus", 18, "", "", "", 1,
            ]],
            "hist": {"playlist-visible": [["2026-08-25", 12000]]},
        }
        with self.assertRaisesRegex(ValueError, "real point for every visible playlist"):
            subject.build_payload(source)

    def test_writer_uses_the_lazy_browser_global(self):
        payload = {"version": 1, "status": {}, "cols": [], "rows": [], "hist": {}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "playlist-analytics.js"
            subject.write_payload(path, payload)
            raw = path.read_text(encoding="utf-8")
        self.assertTrue(raw.startswith(subject.OUTPUT_PREFIX))
        self.assertTrue(raw.endswith(";\n"))


if __name__ == "__main__":
    unittest.main()
