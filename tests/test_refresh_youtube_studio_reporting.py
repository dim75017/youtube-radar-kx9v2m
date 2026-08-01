import datetime as dt
import io
import json
import os
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import refresh_youtube_studio_reporting as studio


NOW = dt.datetime(2026, 8, 1, 12, 0, tzinfo=dt.timezone.utc)
CREDENTIALS = studio.Credentials("client-id", "client-secret", "refresh-token")


class FakeTransport:
    def __init__(self, *, jobs=None, reports=None, downloads=None, token_error=None):
        self.jobs = list(jobs or [])
        self.reports = dict(reports or {})
        self.downloads = dict(downloads or {})
        self.token_error = token_error
        self.calls = []
        self.created_jobs = []

    def request(self, method, url, *, headers=None, body=None, timeout=60):
        self.calls.append((method, url, dict(headers or {}), body, timeout))
        if url == studio.TOKEN_URL:
            if self.token_error:
                raise studio.StudioReportingError(self.token_error)
            form = urllib.parse.parse_qs((body or b"").decode("ascii"))
            if form.get("grant_type") != ["refresh_token"]:
                raise AssertionError("collector did not use the OAuth refresh-token grant")
            return json.dumps({"access_token": "access-token"}).encode()

        parsed = urllib.parse.urlparse(url)
        path = parsed.path
        if method == "GET" and path == "/v1/jobs":
            return json.dumps({"jobs": self.jobs}).encode()
        if method == "POST" and path == "/v1/jobs":
            payload = json.loads((body or b"{}").decode())
            created = {
                "id": f"job-{payload['reportTypeId']}",
                "reportTypeId": payload["reportTypeId"],
                "name": payload["name"],
                "createTime": "2026-08-01T12:00:00Z",
            }
            self.jobs.append(created)
            self.created_jobs.append(created)
            return json.dumps(created).encode()
        if method == "GET" and path.startswith("/v1/jobs/") and path.endswith("/reports"):
            job_id = urllib.parse.unquote(path.split("/")[3])
            return json.dumps({"reports": self.reports.get(job_id, [])}).encode()
        if method == "GET" and url in self.downloads:
            authorization = (headers or {}).get("Authorization")
            if authorization != "Bearer access-token":
                raise AssertionError("report download did not use the refreshed access token")
            return self.downloads[url]
        raise AssertionError(f"unexpected transport request: {method} {url}")


def job(kind):
    report_type, name = studio.REPORTS[kind]
    return {
        "id": f"job-{kind}",
        "reportTypeId": report_type,
        "name": name,
        "createTime": "2026-07-01T00:00:00Z",
    }


def report(kind, report_id, day, *, created="2026-08-01T06:00:00Z"):
    start = dt.date.fromisoformat(day)
    end = start + dt.timedelta(days=1)
    return {
        "id": report_id,
        "startTime": f"{start.isoformat()}T00:00:00Z",
        "endTime": f"{end.isoformat()}T00:00:00Z",
        "createTime": created,
        "downloadUrl": f"https://youtubereporting.googleapis.com/download/{kind}/{report_id}.csv",
    }


def basic_csv(day, rows):
    header = (
        "date,channel_id,video_id,views,watch_time_minutes,"
        "average_view_duration_percentage\n"
    )
    body = "".join(
        f"{day},UC-LOFI,{video_id},{views},{minutes},{awp}\n"
        for video_id, views, minutes, awp in rows
    )
    return (header + body).encode()


def reach_csv(day, rows):
    header = (
        "date,channel_id,video_id,video_thumbnail_impressions,"
        "video_thumbnail_impressions_ctr\n"
    )
    body = "".join(
        f"{day},UC-LOFI,{video_id},{impressions},{ctr}\n"
        for video_id, impressions, ctr in rows
    )
    return (header + body).encode()


def write_baseline(path):
    payload = {
        "t": 1,
        "label": "Manual 365-day export",
        "dataThrough": "2026-07-27",
        "scanAt": "2026-07-28T15:15:00Z",
        "d": {
            "manual-video": {"views": 999999, "imp": 888888, "ctr": 1.2, "awtMs": 30000, "awp": 25}
        },
    }
    path.write_text(studio.OUTPUT_PREFIX + json.dumps(payload) + ";\n", encoding="utf-8")
    return path.read_bytes()


def read_snapshot(path):
    raw = path.read_text(encoding="utf-8").strip()
    return json.loads(raw[len(studio.OUTPUT_PREFIX) :].removesuffix(";"))


class YoutubeStudioReportingTests(unittest.TestCase):
    def paths(self, root):
        return root / "Lofi_Radar_studio.js", root / "private-state.json"

    def run_sync_case(self, output, state, transport):
        return studio.run_sync(
            output_path=output,
            state_path=state,
            credentials=CREDENTIALS,
            transport=transport,
            now=NOW,
            expected_channel_id="UC-LOFI",
        )

    def test_download_rejects_untrusted_host_before_sending_bearer_token(self):
        transport = FakeTransport()
        client = studio.ReportingClient(CREDENTIALS, transport)

        with self.assertRaisesRegex(studio.StudioReportingError, "unsafe download URL"):
            client.download("https://attacker.example/report.csv")

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0][1], studio.TOKEN_URL)

    def test_jobs_are_created_once_and_waiting_does_not_replace_manual_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            original = write_baseline(output)
            transport = FakeTransport()

            first = self.run_sync_case(output, state_path, transport)
            state = json.loads(state_path.read_text(encoding="utf-8"))

            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(first["published"])
            self.assertEqual(first["status"], "waiting_reports")
            self.assertEqual(first["windowDays"], 0)
            self.assertEqual(len(transport.created_jobs), 2)
            self.assertEqual(
                {row["reportTypeId"] for row in transport.created_jobs},
                {"channel_basic_a3", "channel_reach_basic_a1"},
            )
            self.assertTrue(state["sync"]["connected"])
            self.assertTrue(state["sync"]["partial"])
            self.assertIsNone(state["sync"]["lastSuccessAt"])
            self.assertEqual(state["baselineAudit"]["d"]["manual-video"]["views"], 999999)

            transport.created_jobs.clear()
            second = self.run_sync_case(output, state_path, transport)
            self.assertEqual(transport.created_jobs, [])
            self.assertFalse(second["published"])
            self.assertEqual(output.read_bytes(), original)

    def test_common_api_day_replaces_manual_baseline_without_blending(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            write_baseline(output)
            basic = report("basic", "basic-1", "2026-07-28")
            reach = report("reach", "reach-1", "2026-07-28")
            transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [basic], "job-reach": [reach]},
                downloads={
                    basic["downloadUrl"]: basic_csv(
                        "2026-07-28",
                        [("video-1", 4, "2", "25"), ("video-1", 6, "8", "50")],
                    ),
                    reach["downloadUrl"]: reach_csv(
                        "2026-07-28",
                        [("video-1", 40, "5"), ("video-1", 60, "15")],
                    ),
                },
            )

            result = self.run_sync_case(output, state_path, transport)
            snapshot = read_snapshot(output)

            self.assertTrue(result["published"])
            self.assertEqual(snapshot["dataThrough"], "2026-07-28")
            self.assertEqual(snapshot["windowStart"], "2026-07-28")
            self.assertEqual(snapshot["windowEnd"], "2026-07-28")
            self.assertEqual(snapshot["windowDays"], 1)
            self.assertEqual(set(snapshot["d"]), {"video-1"})
            self.assertEqual(
                snapshot["d"]["video-1"],
                {"views": 10, "imp": 100, "ctr": 11.0, "awtMs": 60000, "awp": 40.0},
            )
            self.assertEqual(snapshot["sync"]["status"], "healthy")
            self.assertTrue(snapshot["sync"]["connected"])
            self.assertTrue(snapshot["sync"]["warmup"])
            self.assertFalse(snapshot["sync"]["partial"])
            self.assertNotIn("manual-video", snapshot["d"])

    def test_missing_day_shrinks_to_the_most_recent_complete_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            write_baseline(output)
            basic_reports = [report("basic", f"basic-{day}", f"2026-07-{day}") for day in (28, 29, 30)]
            reach_reports = [report("reach", f"reach-{day}", f"2026-07-{day}") for day in (28, 30)]
            downloads = {}
            for item in basic_reports:
                day = item["startTime"][:10]
                downloads[item["downloadUrl"]] = basic_csv(day, [("video-1", 10, "10", "50")])
            for item in reach_reports:
                day = item["startTime"][:10]
                downloads[item["downloadUrl"]] = reach_csv(day, [("video-1", 100, "10")])
            transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": basic_reports, "job-reach": reach_reports},
                downloads=downloads,
            )

            result = self.run_sync_case(output, state_path, transport)

            self.assertEqual(result["windowStart"], "2026-07-30")
            self.assertEqual(result["windowEnd"], "2026-07-30")
            self.assertEqual(result["windowDays"], 1)
            self.assertEqual(read_snapshot(output)["dataThrough"], "2026-07-30")

    def test_no_new_report_keeps_the_public_snapshot_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            write_baseline(output)
            basic = report("basic", "basic-1", "2026-07-28")
            reach = report("reach", "reach-1", "2026-07-28")
            transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [basic], "job-reach": [reach]},
                downloads={
                    basic["downloadUrl"]: basic_csv("2026-07-28", [("video-1", 10, "10", "50")]),
                    reach["downloadUrl"]: reach_csv("2026-07-28", [("video-1", 100, "10")]),
                },
            )
            self.run_sync_case(output, state_path, transport)
            first_snapshot = output.read_bytes()

            result = self.run_sync_case(output, state_path, transport)

            self.assertFalse(result["published"])
            self.assertEqual(result["reportsImported"], 0)
            self.assertEqual(output.read_bytes(), first_snapshot)

    def test_unpaired_basic_report_outside_the_window_does_not_rewrite_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            write_baseline(output)
            basic_28 = report("basic", "basic-28", "2026-07-28")
            reach_28 = report("reach", "reach-28", "2026-07-28")
            first_transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [basic_28], "job-reach": [reach_28]},
                downloads={
                    basic_28["downloadUrl"]: basic_csv("2026-07-28", [("video-1", 10, "10", "50")]),
                    reach_28["downloadUrl"]: reach_csv("2026-07-28", [("video-1", 100, "10")]),
                },
            )
            self.run_sync_case(output, state_path, first_transport)
            first_snapshot = output.read_bytes()

            basic_29 = report("basic", "basic-29", "2026-07-29", created="2026-08-01T07:00:00Z")
            second_transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [basic_28, basic_29], "job-reach": [reach_28]},
                downloads={
                    basic_29["downloadUrl"]: basic_csv("2026-07-29", [("video-1", 20, "20", "55")]),
                },
            )

            result = self.run_sync_case(output, state_path, second_transport)

            self.assertEqual(result["reportsImported"], 1)
            self.assertFalse(result["published"])
            self.assertEqual(result["windowEnd"], "2026-07-28")
            self.assertEqual(output.read_bytes(), first_snapshot)

    def test_newer_backfill_replaces_the_same_period_instead_of_adding_to_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            write_baseline(output)
            old_basic = report("basic", "basic-old", "2026-07-28", created="2026-07-29T06:00:00Z")
            old_reach = report("reach", "reach-old", "2026-07-28", created="2026-07-29T06:00:00Z")
            first_transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [old_basic], "job-reach": [old_reach]},
                downloads={
                    old_basic["downloadUrl"]: basic_csv("2026-07-28", [("video-1", 10, "10", "50")]),
                    old_reach["downloadUrl"]: reach_csv("2026-07-28", [("video-1", 100, "10")]),
                },
            )
            self.run_sync_case(output, state_path, first_transport)

            new_basic = report("basic", "basic-new", "2026-07-28", created="2026-07-30T06:00:00Z")
            new_reach = report("reach", "reach-new", "2026-07-28", created="2026-07-30T06:00:00Z")
            second_transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={
                    "job-basic": [old_basic, new_basic],
                    "job-reach": [old_reach, new_reach],
                },
                downloads={
                    new_basic["downloadUrl"]: basic_csv("2026-07-28", [("video-1", 30, "15", "60")]),
                    new_reach["downloadUrl"]: reach_csv("2026-07-28", [("video-1", 300, "20")]),
                },
            )

            result = self.run_sync_case(output, state_path, second_transport)
            snapshot = read_snapshot(output)
            state = json.loads(state_path.read_text(encoding="utf-8"))

            self.assertEqual(result["reportsImported"], 2)
            self.assertEqual(snapshot["d"]["video-1"]["views"], 30)
            self.assertEqual(snapshot["d"]["video-1"]["imp"], 300)
            self.assertEqual(snapshot["d"]["video-1"]["ctr"], 20.0)
            self.assertEqual(state["daySources"]["basic"]["2026-07-28"]["reportId"], "basic-new")
            self.assertEqual(state["daySources"]["reach"]["2026-07-28"]["reportId"], "reach-new")

    def test_auth_failure_is_fail_closed_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            original = write_baseline(output)
            transport = FakeTransport(token_error="refresh token rejected")

            with self.assertRaisesRegex(studio.StudioReportingError, "refresh token rejected"):
                self.run_sync_case(output, state_path, transport)

            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(state_path.exists())

    def test_expected_channel_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, state_path = self.paths(Path(temporary))
            original = write_baseline(output)
            basic = report("basic", "basic-1", "2026-07-28")
            reach = report("reach", "reach-1", "2026-07-28")
            transport = FakeTransport(
                jobs=[job("basic"), job("reach")],
                reports={"job-basic": [basic], "job-reach": [reach]},
                downloads={
                    basic["downloadUrl"]: basic_csv("2026-07-28", [("video-1", 10, "10", "50")]).replace(b"UC-LOFI", b"UC-WRONG"),
                    reach["downloadUrl"]: reach_csv("2026-07-28", [("video-1", 100, "10")]),
                },
            )

            with self.assertRaisesRegex(studio.StudioReportingError, "unexpected channel"):
                self.run_sync_case(output, state_path, transport)

            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(state_path.exists())

    def test_cli_forwards_explicit_channel_id_and_supports_environment_default(self):
        summary = {
            "connected": True,
            "status": "waiting_reports",
            "jobs": {},
            "reportsImported": 0,
            "published": False,
            "windowStart": None,
            "windowEnd": None,
            "windowDays": 0,
            "includedVideos": 0,
        }
        environment = {
            "GOOGLE_OAUTH_CLIENT_ID": "client-id",
            "GOOGLE_OAUTH_CLIENT_SECRET": "client-secret",
            "YOUTUBE_ANALYTICS_REFRESH_TOKEN": "refresh-token",
            "YOUTUBE_CHANNEL_ID": "UC-ENV",
        }
        with patch.dict(os.environ, environment, clear=True):
            with patch.object(studio, "run_sync", return_value=summary) as run_sync:
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(
                        studio.main(
                            [
                                "--output",
                                "snapshot.js",
                                "--state",
                                "private.json",
                                "--expected-channel-id",
                                "UC-EXPLICIT",
                            ]
                        ),
                        0,
                    )
                self.assertEqual(run_sync.call_args.kwargs["expected_channel_id"], "UC-EXPLICIT")

            with patch.object(studio, "run_sync", return_value=summary) as run_sync:
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(studio.main([]), 0)
                self.assertEqual(run_sync.call_args.kwargs["expected_channel_id"], "UC-ENV")

    def test_complete_window_keeps_only_the_latest_365_contiguous_days(self):
        start = dt.date(2025, 7, 1)
        days = [(start + dt.timedelta(days=offset)).isoformat() for offset in range(370)]
        state = {
            "daySources": {
                "basic": {day: {} for day in days},
                "reach": {day: {} for day in days},
            }
        }

        window = studio.complete_window(state)

        self.assertEqual(len(window), 365)
        self.assertEqual(window, days[-365:])


if __name__ == "__main__":
    unittest.main()
