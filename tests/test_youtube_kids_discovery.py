import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import BytesIO, StringIO
from pathlib import Path
from unittest import mock

import youtube_kids_discovery_proof as subject


VIDEO_IDS = ["kidABC12345", "kidDEF12345"]


def valid_payload() -> dict:
    stamp = int(
        datetime(2026, 8, 13, 11, 37, tzinfo=timezone.utc).timestamp() * 1000
    )
    return {
        "keep": {"unrelated": [3, 2, 1]},
        "d": {
            "all": [{"vid": "stdABC12345", "views": 123}],
            "kids": [{"vid": video_id, "views": 456} for video_id in VIDEO_IDS],
        },
        "kidsMetricsT": stamp,
        "kidsMetrics": {
            "day": "2026-08-13",
            "day_timezone": "Europe/Paris",
            "tracked": 2,
            "updated": 2,
            "queries": subject.YOUTUBE_KIDS_EXPECTED_QUERIES,
            "queries_ok": subject.YOUTUBE_KIDS_EXPECTED_QUERIES,
            "results_examined": 4000,
            "candidates_kept": 47,
            "search_lanes_expected": subject.YOUTUBE_KIDS_EXPECTED_SEARCH_LANES,
            "search_lanes_completed": subject.YOUTUBE_KIDS_EXPECTED_SEARCH_LANES,
            "history_updated": 2,
            "history_day": "2026-08-13",
            "partial": False,
        },
    }


def write_snapshot(path: Path, payload: dict) -> None:
    path.write_text(
        subject.YOUTUBE_SNAPSHOT_PREFIX
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


class FakeResponse:
    def __init__(self, payload: dict):
        self.body = (
            subject.YOUTUBE_SNAPSHOT_PREFIX
            + json.dumps(payload, separators=(",", ":"))
            + ";\n"
        ).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return BytesIO(self.body).read()


class YoutubeKidsDiscoveryProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "Lofi_Radar_data.js"

    def tearDown(self):
        self.temp.cleanup()

    def stamp(self, payload: dict | None = None) -> dict:
        write_snapshot(self.path, payload or valid_payload())
        with redirect_stdout(StringIO()):
            subject.stamp_discovery(self.path)
        return subject.read_snapshot(self.path)

    def test_stamp_records_complete_source_backed_cohort_proof(self):
        after = self.stamp()
        metrics = after["kidsMetrics"]
        self.assertEqual(after["keep"], {"unrelated": [3, 2, 1]})
        self.assertEqual(after["kidsDiscoveryT"], after["kidsMetricsT"])
        self.assertEqual(metrics["discovery_day"], "2026-08-13")
        self.assertEqual(metrics["discovery_queries"], 40)
        self.assertEqual(metrics["discovery_queries_ok"], 40)
        self.assertEqual(metrics["discovery_results_examined"], 4000)
        self.assertEqual(metrics["discovery_candidates_kept"], 47)
        self.assertEqual(metrics["discovery_search_lanes_expected"], 80)
        self.assertEqual(metrics["discovery_search_lanes_completed"], 80)
        self.assertEqual(metrics["discovery_tracked"], 2)
        self.assertEqual(
            metrics["discovery_ids_digest"],
            subject.youtube_kids_cohort_digest(VIDEO_IDS),
        )
        self.assertIs(metrics["discovery_complete"], True)
        self.assertEqual(
            subject.validate_stamped_discovery_payload(after)["tracked"],
            2,
        )

    def test_stamp_fails_closed_on_incomplete_or_empty_discovery(self):
        cases = {
            "query": ("queries_ok", 39, "39/40"),
            "results": ("results_examined", 0, "yield/coverage is insufficient"),
            "candidates": ("candidates_kept", 0, "yield/coverage is insufficient"),
            "shallow": (
                "results_examined",
                subject.YOUTUBE_KIDS_MIN_RESULTS_EXAMINED - 1,
                "minimum results",
            ),
            "lanes": ("search_lanes_completed", 79, "79/80"),
            "coverage": ("updated", 1, "cohort coverage"),
            "partial": ("partial", True, "marked partial"),
        }
        for name, (field, value, message) in cases.items():
            with self.subTest(name=name):
                payload = valid_payload()
                payload["kidsMetrics"][field] = value
                write_snapshot(self.path, payload)
                with self.assertRaisesRegex(ValueError, message):
                    subject.stamp_discovery(self.path)

    def test_stamped_proof_rejects_a_forged_or_changed_cohort(self):
        after = self.stamp()
        after["kidsMetrics"]["discovery_ids_digest"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "digest diverges"):
            subject.validate_stamped_discovery_payload(after)

        after = self.stamp()
        after["d"]["kids"].append({"vid": "kidGHI12345", "views": 789})
        with self.assertRaisesRegex(ValueError, "cohort proof"):
            subject.validate_stamped_discovery_payload(after)

    def test_discovery_proof_survives_a_later_standard_counter_refresh(self):
        after = self.stamp()
        later = int(
            datetime(2026, 8, 14, 8, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        after["kidsMetricsT"] = later
        after["kidsMetrics"].update({
            "day": "2026-08-14",
            "history_day": "2026-08-14",
        })
        proof = subject.validate_stamped_discovery_payload(after)
        self.assertEqual(proof["day"], "2026-08-13")
        self.assertNotEqual(proof["stamp"], after["kidsMetricsT"])

    def test_publication_verifier_requires_the_stamped_remote_proof(self):
        local = self.stamp()
        with mock.patch.object(
            subject.urllib.request,
            "urlopen",
            return_value=FakeResponse(local),
        ):
            with redirect_stdout(StringIO()):
                result = subject.verify_publication(
                    "https://example.test/",
                    self.path,
                    timeout_seconds=1,
                    interval_seconds=1,
                )
        self.assertTrue(result["published"])
        self.assertEqual(result["tracked"], 2)


if __name__ == "__main__":
    unittest.main()
