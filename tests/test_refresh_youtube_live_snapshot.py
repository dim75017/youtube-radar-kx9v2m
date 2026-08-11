import json
import tempfile
import unittest
from pathlib import Path

import openpyxl

import refresh_youtube_live_snapshot as live


class RefreshYouTubeLiveSnapshotTests(unittest.TestCase):
    def workbook(self):
        workbook = openpyxl.Workbook()
        streams = workbook.active
        streams.title = "Live Streams"
        streams.append(["Video ID", "Channel", "Title", "URL", "Started", "Discovery keywords"])
        streams.append(["abcdefghijk", "Channel A", "Stream A 2026-08-11 12:00", "", "2025-01-01", "lofi"])
        streams.append(["zyxwvutsrqp", "Channel B", "Stream B", "", "2025-02-01", "jazz"])
        history = workbook.create_sheet("Live History")
        history.append(["Video ID", "Scan Date", "Concurrent Viewers"])
        history.append(["abcdefghijk", "2026-08-10", 100])
        history.append(["zyxwvutsrqp", "2026-08-10", 50])
        hourly = workbook.create_sheet("Live Hourly")
        hourly.append(["Video ID", "Scan Timestamp", "Concurrent Viewers"])
        hourly.append(["abcdefghijk", "2026-08-11T11:00:00Z", 60])
        hourly.append(["abcdefghijk", "2026-08-11T12:00:00Z", 42])
        hourly.append(["zyxwvutsrqp", "2026-08-11T02:00:00Z", 9])
        return workbook

    def test_builds_compact_summary_and_preserves_official_audience(self):
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "Lofi_Radar_data.js"
            snapshot.write_text(
                'window.LOFI_DATA={"d":{"lives":[{"vid":"abcdefghijk",'
                '"madeForKids":false,"audiences":["youtube"]}]}};',
                encoding="utf-8",
            )
            payload = live.build_payload(self.workbook(), snapshot)
        self.assertEqual(payload["metrics"]["tracked"], 2)
        self.assertEqual(payload["metrics"]["active"], 1)
        self.assertNotIn("liveHourly", payload["d"])
        first = next(row for row in payload["d"]["lives"] if row["vid"] == "abcdefghijk")
        self.assertEqual(first["title"], "Stream A")
        self.assertIs(first["madeForKids"], False)
        self.assertEqual(first["audiences"], ["youtube"])
        self.assertEqual(payload["d"]["liveSummary"]["abcdefghijk"]["now"], 42)
        self.assertEqual(payload["d"]["liveSummary"]["abcdefghijk"]["peak24"], 60)
        self.assertIs(payload["d"]["liveSummary"]["abcdefghijk"]["active"], True)
        self.assertIs(payload["d"]["liveSummary"]["zyxwvutsrqp"]["active"], False)

    def test_daily_workflow_refreshes_asset_without_hourly_deploy_loop(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        push_paths = workflow.split('pull_request:', 1)[0]
        self.assertIn('python refresh_youtube_live_snapshot.py', workflow)
        self.assertIn('git add Lofi_Radar_data.js Lofi_Radar_live_data.js', workflow)
        self.assertNotIn("- 'Lofi_Radar_live_data.js'", push_paths)
        self.assertNotRegex(workflow, r"cron:\s*['\"]?[^\n]*\* \* \* \*['\"]?")


if __name__ == "__main__":
    unittest.main()
