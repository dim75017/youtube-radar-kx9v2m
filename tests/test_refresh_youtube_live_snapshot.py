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

    def test_discovers_official_streams_and_does_not_invent_historical_peaks(self):
        class Reader:
            def __init__(self, payloads):
                self.payloads = payloads

            def extract_info(self, url, download=False):
                return self.payloads[url]

        observed = 1_786_640_000_000
        ids = ("0muHFBSiybw", "LTiqKDrjqr4")
        flat = Reader({
            live.OFFICIAL_STREAMS_URL: {
                "entries": [
                    {"id": ids[0], "live_status": "is_live"},
                    {"id": ids[1], "live_status": "is_live"},
                    {"id": "abcdefghijk", "live_status": "was_live"},
                ]
            },
            live.OFFICIAL_UPLOADS_URL: {
                "entries": [{"id": ids[0], "live_status": "is_live"}]
            },
        })
        detail = Reader({
            f"https://www.youtube.com/watch?v={ids[0]}": {
                "id": ids[0], "channel_id": live.OFFICIAL_CHANNEL_ID,
                "availability": "public",
                "title": "summer lofi radio ☀️ music to put you in a better mood 2026-08-13 19:08",
                "is_live": True, "live_status": "is_live", "concurrent_view_count": 3208,
                "release_timestamp": 1_786_546_921,
            },
            f"https://www.youtube.com/watch?v={ids[1]}": {
                "id": ids[1], "channel_id": live.OFFICIAL_CHANNEL_ID,
                "availability": "public",
                "title": "24/7 deep sleep music 🌌 calm ambient to sleep & dream to",
                "is_live": True, "live_status": "is_live", "concurrent_view_count": 859,
                "release_timestamp": 1_785_344_581,
            },
            "https://www.youtube.com/watch?v=abcdefghijk": {
                "id": "abcdefghijk",
                "channel_id": live.OFFICIAL_CHANNEL_ID,
                "availability": "public",
                "is_live": False,
                "live_status": "was_live",
            },
        })
        official = live.discover_official_live_streams(
            observed, flat_reader=flat, detail_reader=detail
        )
        payload = live.build_payload(self.workbook(), official_snapshot=official)
        by_id = {row["vid"]: row for row in payload["d"]["lives"]}
        self.assertEqual(set(ids) - set(by_id), set())
        self.assertEqual(by_id[ids[0]]["title"], "summer lofi radio ☀️ music to put you in a better mood")
        self.assertEqual(by_id[ids[0]]["started"], 1_786_546_921_000)
        self.assertEqual(payload["d"]["liveSummary"][ids[0]]["now"], 3208)
        self.assertIsNone(payload["d"]["liveSummary"][ids[0]]["peak24"])
        self.assertIsNone(payload["d"]["liveSummary"][ids[0]]["peakAll"])
        self.assertEqual(payload["metrics"]["officialExpected"], 2)
        self.assertEqual(payload["metrics"]["officialVerified"], 2)
        self.assertEqual(payload["metrics"]["officialAdded"], 2)
        self.assertEqual(payload["metrics"]["officialObservedT"], observed)
        self.assertEqual(official["metrics"]["streamsTabCandidates"], 2)
        self.assertEqual(official["metrics"]["streamsTabActive"], 2)
        self.assertEqual(official["metrics"]["listingConfirmedEnded"], 0)
        self.assertEqual(official["metrics"]["uploadsPlaylistActive"], 1)
        self.assertLess(payload["metrics"]["sheetSourceLatestT"], observed)

    def test_partial_streams_listing_recovers_previous_live_and_confirms_ended(self):
        class Reader:
            def __init__(self, payloads):
                self.payloads = payloads

            def extract_info(self, url, download=False):
                return self.payloads[url]

        listing_id = "0muHFBSiybw"
        recovered_id = "LTiqKDrjqr4"
        ended_id = "X4VbdwhkE10"
        flat = Reader({
            live.OFFICIAL_STREAMS_URL: {
                "entries": [
                    {"id": listing_id, "live_status": "is_live"},
                    {"id": "abcdefghijk", "live_status": "is_upcoming"},
                ]
            },
            live.OFFICIAL_UPLOADS_URL: {"entries": []},
        })
        active = lambda video_id, title: {
            "id": video_id,
            "channel_id": live.OFFICIAL_CHANNEL_ID,
            "availability": "public",
            "title": title,
            "is_live": True,
            "live_status": "is_live",
            "concurrent_view_count": 10,
            "release_timestamp": 1_785_344_581,
        }
        detail = Reader({
            f"https://www.youtube.com/watch?v={listing_id}": active(listing_id, "summer"),
            f"https://www.youtube.com/watch?v={recovered_id}": active(recovered_id, "sleep"),
            f"https://www.youtube.com/watch?v={ended_id}": {
                "id": ended_id,
                "channel_id": live.OFFICIAL_CHANNEL_ID,
                "availability": "public",
                "is_live": False,
                "live_status": "was_live",
            },
            "https://www.youtube.com/watch?v=abcdefghijk": {
                "id": "abcdefghijk",
                "channel_id": live.OFFICIAL_CHANNEL_ID,
                "availability": "public",
                "is_live": False,
                "live_status": "is_upcoming",
            },
        })
        result = live.discover_official_live_streams(
            1_786_640_000_000,
            flat_reader=flat,
            detail_reader=detail,
            previous_active={
                recovered_id: {"trusted": True},
                ended_id: {"trusted": True},
            },
        )
        self.assertEqual({row["vid"] for row in result["rows"]}, {listing_id, recovered_id})
        self.assertEqual(result["metrics"]["listingActive"], 1)
        self.assertEqual(result["metrics"]["previousActive"], 2)
        self.assertEqual(result["metrics"]["missingFromListing"], 2)
        self.assertEqual(result["metrics"]["recoveredStillLive"], 1)
        self.assertEqual(result["metrics"]["confirmedEnded"], 1)
        self.assertEqual(result["metrics"]["listingConfirmedEnded"], 1)

    def test_trusted_previous_live_with_ambiguous_identity_blocks_discovery(self):
        class Reader:
            def __init__(self, payload):
                self.payload = payload

            def extract_info(self, url, download=False):
                return self.payload

        video_id = "LTiqKDrjqr4"
        with self.assertRaisesRegex(RuntimeError, "conflicting identity"):
            live.discover_official_live_streams(
                1_786_640_000_000,
                flat_reader=Reader({"entries": []}),
                detail_reader=Reader({
                    "id": video_id,
                    "channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx",
                }),
                previous_active={video_id: {"trusted": True}},
            )

    def test_trusted_zero_viewer_live_remains_in_previous_active_cohort(self):
        with tempfile.TemporaryDirectory() as directory:
            asset = Path(directory) / "Lofi_Radar_live_data.js"
            asset.write_text(
                'window.LOFI_LIVE_DATA={"d":{"lives":[{'
                '"vid":"0muHFBSiybw","channelId":"'
                + live.OFFICIAL_CHANNEL_ID
                + '","source":"Official Lofi Girl streams scan",'
                '"liveStatus":"is_live"}],"liveSummary":{'
                '"0muHFBSiybw":{"now":0,"active":false}}},"metrics":{'
                '"officialExpected":1,"officialVerified":1}};\n',
                encoding="utf-8",
            )
            cohort = live.load_previous_active_official_lives(asset)
        self.assertEqual(cohort, {"0muHFBSiybw": {"trusted": True}})

    def test_streams_tab_entry_without_flat_status_is_hydrated_not_dropped(self):
        class Reader:
            def __init__(self, payloads):
                self.payloads = payloads

            def extract_info(self, url, download=False):
                return self.payloads[url]

        video_id = "0muHFBSiybw"
        flat = Reader({
            live.OFFICIAL_STREAMS_URL: {"entries": [{"id": video_id}]},
            live.OFFICIAL_UPLOADS_URL: {"entries": []},
        })
        detail = Reader({f"https://www.youtube.com/watch?v={video_id}": {
            "id": video_id,
            "channel_id": live.OFFICIAL_CHANNEL_ID,
            "availability": "public",
            "title": "summer lofi radio",
            "is_live": True,
            "live_status": "is_live",
            "concurrent_view_count": 25,
            "release_timestamp": 1_786_546_921,
        }})
        result = live.discover_official_live_streams(
            1_786_640_000_000, flat_reader=flat, detail_reader=detail
        )
        self.assertEqual([row["vid"] for row in result["rows"]], [video_id])
        self.assertEqual(result["metrics"]["streamsTabUnknown"], 1)

    def test_official_stream_discovery_rejects_wrong_channel_or_missing_counter(self):
        base = {
            "id": "0muHFBSiybw",
            "channel_id": live.OFFICIAL_CHANNEL_ID,
            "availability": "public",
            "title": "summer lofi radio",
            "is_live": True,
            "live_status": "is_live",
            "concurrent_view_count": 1,
            "release_timestamp": 1_786_546_921,
        }
        for mutation in (
            {"channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx"},
            {"live_status": "is_upcoming"},
            {"is_live": False},
            {"availability": "private"},
            {"concurrent_view_count": None},
        ):
            with self.subTest(mutation=mutation):
                with self.assertRaises(RuntimeError):
                    live.official_live_row({**base, **mutation}, 1_786_640_000_000)

    def test_one_sheet_point_does_not_become_a_peak_or_mask_sheet_staleness(self):
        workbook = self.workbook()
        streams = live.sheet_by_name(workbook, "Live Streams")
        hourly = live.sheet_by_name(workbook, "Live Hourly")
        video_id = "0muHFBSiybw"
        streams.append([
            video_id, "Lofi Girl", "summer lofi radio", "", "2026-08-12", "official"
        ])
        hourly.append([video_id, "2026-08-11T12:00:00Z", 3200])
        observed = 1_786_640_000_000
        official = {
            "rows": [{
                "vid": video_id,
                "channel": "Lofi Girl",
                "channelId": live.OFFICIAL_CHANNEL_ID,
                "title": "summer lofi radio",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "started": 1_786_546_921_000,
                "liveStatus": "is_live",
            }],
            "points": {video_id: [(observed, 3250)]},
            "metrics": {"expected": 1, "verified": 1, "observedT": observed},
        }
        payload = live.build_payload(workbook, official_snapshot=official)
        summary = payload["d"]["liveSummary"][video_id]
        self.assertEqual(summary["now"], 3250)
        self.assertIsNone(summary["peak24"])
        self.assertIsNone(summary["peakAll"])
        self.assertEqual(
            payload["metrics"]["sheetSourceLatestT"],
            live.to_ms("2026-08-11T12:00:00Z"),
        )
        self.assertEqual(payload["metrics"]["sourceLatestT"], observed)
        with self.assertRaisesRegex(RuntimeError, "Livestream Sheet is"):
            live.ensure_sheet_freshness(payload, 8, now_ms=observed)

        official["points"][video_id] = [(observed + 1, 0)]
        zero_payload = live.build_payload(workbook, official_snapshot=official)
        self.assertIs(zero_payload["d"]["liveSummary"][video_id]["active"], True)

    def test_daily_workflow_refreshes_asset_without_hourly_deploy_loop(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        push_paths = workflow.split('pull_request:', 1)[0]
        self.assertIn('python refresh_youtube_live_snapshot.py', workflow)
        self.assertIn('yt-dlp==2026.7.4 openpyxl', workflow)
        live_step = workflow.split('Refresh compact livestream first-paint snapshot', 1)[1].split(
            'Commit factual catalogue and daily analytics first', 1
        )[0]
        self.assertIn('id: live_snapshot', live_step)
        self.assertIn('continue-on-error: true', live_step)
        report_step = workflow.split('Report incomplete official livestream discovery', 1)[1]
        self.assertIn("steps.live_snapshot.outcome != 'success'", report_step)
        self.assertIn('exit 1', report_step)
        self.assertLess(
            workflow.index('Commit factual catalogue and daily analytics first'),
            workflow.index('Report incomplete official livestream discovery'),
        )
        self.assertIn('git add Lofi_Radar_data.js Lofi_Radar_live_data.js', workflow)
        self.assertNotIn("- 'Lofi_Radar_live_data.js'", push_paths)
        self.assertNotRegex(workflow, r"cron:\s*['\"]?[^\n]*\* \* \* \*['\"]?")


if __name__ == "__main__":
    unittest.main()
