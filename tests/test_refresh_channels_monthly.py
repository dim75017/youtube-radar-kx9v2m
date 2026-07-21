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

    def test_partial_rerun_keeps_valid_same_month_metrics(self):
        first = int(datetime(2026, 7, 1, 8, tzinfo=timezone.utc).timestamp() * 1000)
        later = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        points = channels.append_monthly([[first, 125, 1_500]], later, 0, None)
        self.assertEqual(points, [[later, 125, 1_500]])

    def test_recent_twelve_month_average_is_preferred(self):
        jan = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
        jul = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
        estimate = channels.smoothed_monthly_subscriber_growth(
            [[jan, 10_000, None], [jul, 22_000, None]]
        )
        self.assertAlmostEqual(estimate, 1_000, delta=10)

    def test_flat_recent_window_falls_back_to_all_retained_months(self):
        old = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
        recent = int(datetime(2025, 8, 1, tzinfo=timezone.utc).timestamp() * 1000)
        latest = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
        estimate = channels.smoothed_monthly_subscriber_growth(
            [[old, 1_000, None], [recent, 13_000, None], [latest, 13_000, None]]
        )
        self.assertIsNotNone(estimate)
        self.assertGreater(estimate, 0)

    def test_fully_flat_curve_is_unknown_not_zero(self):
        first = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
        latest = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertIsNone(
            channels.smoothed_monthly_subscriber_growth(
                [[first, 10_000, None], [latest, 10_000, None]]
            )
        )

    def test_alias_normalization_keeps_snapshot_keys_stable(self):
        self.assertEqual(channels.normalized_alias("@LofiGirl"), "lofigirl")
        self.assertEqual(
            channels.normalized_alias("UCAbCdEfGhIjKlMnOpQrStUv"),
            "ucabcdefghijklmnopqrstuv",
        )


if __name__ == "__main__":
    unittest.main()
