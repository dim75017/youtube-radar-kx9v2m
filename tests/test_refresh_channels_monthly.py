import unittest
from datetime import datetime, timezone

import refresh_channels_monthly as channels


class MonthlyHistoryTests(unittest.TestCase):
    def test_rerun_replaces_same_utc_month(self):
        first = int(datetime(2026, 7, 1, 8, tzinfo=timezone.utc).timestamp() * 1000)
        later = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        points = channels.append_monthly([[first, 100, 1_000]], later, 125, 1_500)
        self.assertEqual(points, [[later, 125, 1_500]])

    def test_missing_views_remain_explicitly_unknown(self):
        stamp = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(channels.append_monthly([], stamp, 125, None), [[stamp, 125, None]])

    def test_alias_normalization_keeps_snapshot_keys_stable(self):
        self.assertEqual(channels.normalized_alias("@LofiGirl"), "lofigirl")
        self.assertEqual(
            channels.normalized_alias("UCAbCdEfGhIjKlMnOpQrStUv"),
            "ucabcdefghijklmnopqrstuv",
        )


if __name__ == "__main__":
    unittest.main()
