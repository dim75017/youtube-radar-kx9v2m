from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import refresh_soundcharts_daily as subject


class RefreshSoundchartsTests(unittest.TestCase):
    def test_read_and_write_payload_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "soundcharts.js"
            original = {"artists": [["one"]], "freshness": {"artists_at": "old"}}
            subject.write_js_payload(path, original)
            self.assertEqual(subject.read_js_payload(path), original)


    def test_spotify_metric_rejects_other_platforms(self):
        payload = {"items": [{"platform": "apple_music", "streams": 999}, {"platform": "spotify", "streams": 123}]}
        self.assertEqual(subject.spotify_metric(payload, {"streams"}), 123)
        self.assertIsNone(subject.spotify_metric({"platform": "apple_music", "streams": 999}, {"streams"}))


    def test_refresh_artist_updates_only_a_real_spotify_value(self):
        payload = {
            "schemas": {"artists": ["monthly_listeners", "delta", "observed_at", "soundcharts_uuid"]},
            "artists": [[10, None, None, "artist-1"]],
        }
        with patch.object(subject, "parallel_collect", return_value=([("artist-1", {"spotify": {"monthlyListeners": 42}})], 1, 0)):
            history, successes, failures = subject.refresh_artists(payload, "token", 1, 1)
        self.assertEqual((successes, failures), (1, 0))
        self.assertEqual(payload["artists"][0][0:2], [42, 32])
        self.assertEqual(history[0]["value"], 42)
