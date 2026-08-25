import datetime as dt
import json
from pathlib import Path
import unittest

import spotify_counter_integrity as subject


def history(start: str, values: list[int]) -> list[list[object]]:
    first = dt.date.fromisoformat(start)
    return [
        [(first + dt.timedelta(days=index)).isoformat(), value]
        for index, value in enumerate(values)
    ]


class SpotifyCounterIntegrityTests(unittest.TestCase):
    def test_shared_python_javascript_contract(self):
        fixture = json.loads(
            (Path(__file__).with_name("spotify_counter_integrity_cases.json")).read_text(
                encoding="utf-8"
            )
        )
        for case in fixture["cases"]:
            with self.subTest(case=case["id"]):
                result = subject.sanitize_counter_history(case["history"])
                self.assertEqual(result["status"], case["expected"]["status"])
                self.assertEqual(result["changed"], case["expected"]["changed"])
                self.assertEqual(result["history"], case["expected"]["history"])
                self.assertEqual(
                    [event["type"] for event in result["events"]],
                    case["expected"]["event_types"],
                )

    def test_reverie_last_point_is_quarantined(self):
        values = [145_000 + index * 2_000 for index in range(31)]
        points = history("2026-07-19", values)
        points.append(["2026-08-19", 241_582_598])

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "spike_quarantined")
        self.assertEqual(result["history"][-1], ["2026-08-18", values[-1]])
        self.assertEqual(
            result["events"][-1]["candidate"],
            ["2026-08-19", 241_582_598],
        )

    def test_high_base_jump_is_detected_from_its_own_velocity(self):
        values = [334_000_000 + index * 104_000 for index in range(31)]
        points = history("2026-07-19", values)
        points.append(["2026-08-19", values[-1] + 45_864_653])

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "spike_quarantined")
        self.assertEqual(result["history"][-1][1], values[-1])

    def test_small_absolute_jump_is_detected_when_it_dwarfs_prior_flow(self):
        values = [134_000 + index * 5 for index in range(31)]
        points = history("2026-07-19", values)
        points.append(["2026-08-19", values[-1] + 596_503])

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "spike_quarantined")
        self.assertEqual(result["history"][-1][1], values[-1])

    def test_isolated_identity_flip_is_removed_without_losing_stable_history(self):
        points = history(
            "2026-08-01",
            [41_000_000, 41_030_000, 6_580, 41_090_000, 41_120_000],
        )

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "isolated_glitch_removed")
        self.assertNotIn(["2026-08-03", 6_580], result["history"])
        self.assertEqual(result["history"][-1], ["2026-08-05", 41_120_000])

    def test_persistent_quiet_rebase_remains_quarantined(self):
        values = [120_000 + index * 200 for index in range(31)]
        points = history("2026-07-01", values)
        points.extend(
            [
                ["2026-08-01", 6_700_000],
                ["2026-08-02", 6_700_120],
                ["2026-08-03", 6_700_230],
            ]
        )

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "spike_quarantined")
        self.assertEqual(result["history"][-1], ["2026-07-31", values[-1]])
        self.assertEqual(len(result["events"][-1]["quarantined_points"]), 3)

    def test_sustained_acceleration_is_not_rewritten(self):
        values = [100_000 + index * 500 for index in range(31)]
        points = history("2026-07-01", values)
        points.extend(
            [
                ["2026-08-01", values[-1] + 200_000],
                ["2026-08-02", values[-1] + 350_000],
                ["2026-08-03", values[-1] + 500_000],
            ]
        )

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["history"], points)

    def test_unconfirmed_downward_reset_keeps_last_stable_total(self):
        values = [70_000_000 + index * 50_000 for index in range(31)]
        points = history("2026-07-19", values)
        points.append(["2026-08-19", 145_446])

        result = subject.sanitize_counter_history(points)

        self.assertEqual(result["status"], "spike_quarantined")
        self.assertEqual(result["history"][-1][1], values[-1])


if __name__ == "__main__":
    unittest.main()
