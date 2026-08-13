import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import refresh_youtube_daily as radar


class InnertubeResponse(io.BytesIO):
    def __init__(
        self,
        payload,
        final_url=(
            "https://www.youtube.com/youtubei/v1/player"
            "?prettyPrint=false"
        ),
    ):
        if isinstance(payload, bytes):
            body = payload
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        super().__init__(body)
        self.final_url = final_url

    def geturl(self):
        return self.final_url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class DailyHistoryTests(unittest.TestCase):
    def test_official_api_hydration_preserves_made_for_kids_tristate(self):
        now = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)
        captured = {}
        items = []
        for video_id, status in (
            ("abcdefghijk", {"madeForKids": True}),
            ("zyxwvutsrqp", {"madeForKids": False}),
            ("mnopqrstuvw", {}),
        ):
            items.append({
                "id": video_id,
                "snippet": {
                    "title": "Long instrumental mix",
                    "publishedAt": "2026-01-01T00:00:00Z",
                    "channelTitle": "Channel",
                    "channelId": "UC1234567890123456789012",
                },
                "contentDetails": {"duration": "PT1H"},
                "statistics": {"viewCount": "1000000"},
                "status": status,
            })

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def fake_open(url, timeout=30):
            captured["url"] = url
            return Response(json.dumps({"items": items}).encode())

        with patch.object(radar.urllib.request, "urlopen", side_effect=fake_open):
            rows = radar.fetch_api_rows(
                ["abcdefghijk", "zyxwvutsrqp", "mnopqrstuvw"],
                now,
                "secret",
            )
        query = radar.urllib.parse.parse_qs(radar.urllib.parse.urlparse(captured["url"]).query)
        self.assertIn("status", query["part"][0].split(","))
        self.assertIs(rows["abcdefghijk"]["madeForKids"], True)
        self.assertIs(rows["zyxwvutsrqp"]["madeForKids"], False)
        self.assertNotIn("madeForKids", rows["mnopqrstuvw"])
        self.assertEqual(rows["abcdefghijk"]["metadataSource"], radar.METADATA_SOURCE_API)
        self.assertEqual(rows["abcdefghijk"]["pubSource"], radar.METADATA_SOURCE_API)

    def test_kids_search_requires_official_true_and_instrumental_long_form(self):
        now = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)
        ids = ["abcdefghijk", "zyxwvutsrqp", "mnopqrstuvw", "qrstuvwxyz0"]
        search_payload = {
            "items": [{"id": {"videoId": video_id}} for video_id in ids],
        }
        official = {
            "abcdefghijk": {
                "vid": "abcdefghijk", "title": "Baby sleep music instrumental · 3 hours",
                "views": 2_000_000, "durH": 3, "channel": "Calm Baby",
                "madeForKids": True, "_scanDescription": "instrumental sleep music",
            },
            "zyxwvutsrqp": {
                "vid": "zyxwvutsrqp", "title": "Baby sleep music instrumental",
                "views": 3_000_000, "durH": 2, "channel": "General Music",
                "madeForKids": False, "_scanDescription": "instrumental",
            },
            "mnopqrstuvw": {
                "vid": "mnopqrstuvw", "title": "Kids sing along instrumental songs",
                "views": 4_000_000, "durH": 2, "channel": "Singing Kids",
                "madeForKids": True, "_scanDescription": "sing along with vocals",
            },
            "qrstuvwxyz0": {
                "vid": "qrstuvwxyz0", "title": "Baby sleep music instrumental live",
                "views": 5_000_000, "durH": 8, "channel": "Calm Baby",
                "madeForKids": True, "_scanDescription": "instrumental",
                "_liveBroadcastContent": "upcoming",
            },
        }
        for row in official.values():
            row.setdefault("_liveBroadcastContent", "none")
        spec = {
            "query": "baby sleep music instrumental",
            "genre": "Baby sleep",
            "cluster": "Relaxation / meditation",
            "audience": "kids",
        }
        with patch.object(radar, "youtube_api_payload", return_value=search_payload), patch.object(
            radar, "fetch_api_rows", return_value=official
        ):
            rows, raw, enriched = radar.fetch_kids_search(spec, now, "secret")
        self.assertEqual((raw, enriched), (4, 4))
        self.assertEqual([row["vid"] for row in rows], ["abcdefghijk"])
        self.assertIs(rows[0]["madeForKids"], True)
        self.assertEqual(rows[0]["audiences"], ["kids"])
        self.assertNotIn("_scanDescription", rows[0])
        with self.assertRaisesRegex(RuntimeError, "requires YOUTUBE_API_KEY"):
            radar.fetch_kids_search(spec, now, "")

    def test_kids_queries_are_builtin_with_top_100_bootstrap_and_safe_daily_budget(self):
        specs = [s for s in radar.query_specs({"d": {}}, include_kids=True) if s["audience"] == "kids"]
        queries = [s["query"].lower() for s in specs]
        self.assertEqual(radar.KIDS_BOOTSTRAP_SEARCH_RESULTS, 100)
        self.assertEqual(radar.KIDS_SEARCH_RESULTS, 50)
        self.assertTrue(all(s["searchResults"] == 100 for s in specs))
        calls = len(specs) * 2
        self.assertLessEqual(calls, radar.MAX_KIDS_SEARCH_CALLS)
        daily = [
            s
            for s in radar.query_specs({"d": {"kids": [{"vid": "abcdefghijk"}]}}, include_kids=True)
            if s["audience"] == "kids"
        ]
        self.assertTrue(all(s["searchResults"] == 50 for s in daily))
        empty_but_bootstrapped = [
            s
            for s in radar.query_specs({
                "d": {"kids": []},
                "videoMetrics": {"kids_queries": len(radar.KIDS_QUERY_SPECS)},
            }, include_kids=True)
            if s["audience"] == "kids"
        ]
        self.assertEqual(len(empty_but_bootstrapped), 40)
        self.assertTrue(all(s["searchResults"] == 50 for s in empty_but_bootstrapped))
        self.assertEqual(len(queries), len(set(queries)))
        for fragment in (
            "baby sleep", "toddler", "kids lofi", "ambient music for babies",
            "piano music for babies", "classical music for babies", "jazz for babies",
            "bossa nova for babies", "chill house for kids", "drum and bass for kids",
        ):
            self.assertTrue(any(fragment in query for query in queries), fragment)
        self.assertFalse(any("phonk" in query for query in queries))
        self.assertTrue(all(
            any(signal in query for signal in ("instrumental", "no vocals", "no lyrics"))
            for query in queries
        ))

    def test_dom_marker_accepts_only_exact_family_options_destinations(self):
        for href in (
            "https://www.youtube.com/myfamily/#mf-compare",
            "https://youtube.com/myfamily/#mf-compare",
            "https://ytkids.app.goo.gl/abc123",
        ):
            self.assertTrue(radar.is_kids_marker_href(href), href)
        for href in (
            "https://www.youtube.com/myfamily/",
            "https://www.youtube.com/myfamily/#other",
            "https://evil.example/?next=https://youtube.com/myfamily/#mf-compare",
            "https://not-ytkids.app.goo.gl/abc123",
            "http://ytkids.app.goo.gl/abc123",
            "javascript:void(0)",
        ):
            self.assertFalse(radar.is_kids_marker_href(href), href)

    @staticmethod
    def _kids_player_payload(
        video_id,
        *,
        mode="PLAYBACK_MODE_PAUSED_ONLY",
        status="OK",
        include_text=True,
        support_url=(
            "//support.google.com/youtube/bin/answer.py"
            "?answer=9632097&nohelpkit=1&hl=en"
        ),
    ):
        renderer = {"playbackMode": mode}
        if include_text or support_url is not None:
            notification = {}
            if include_text:
                notification["responseText"] = {
                    "runs": [{
                        "text": (
                            "Miniplayer is off for videos made for kids. "
                            "Tap play to resume"
                        ),
                    }],
                }
            if support_url is not None:
                notification["actionButton"] = {
                    "buttonRenderer": {
                        "navigationEndpoint": {
                            "urlEndpoint": {"url": support_url},
                        },
                    },
                }
            renderer["minimizedEndpoint"] = {
                "addToToastAction": {
                    "item": {"notificationActionRenderer": notification},
                },
            }
        return {
            "videoDetails": {"videoId": video_id},
            "playabilityStatus": {
                "status": status,
                "miniplayer": {"miniplayerRenderer": renderer},
            },
        }

    def test_innertube_player_uses_exact_android_post_and_three_kids_signals(self):
        video_id = "Pk7UDVYh2bs"
        payload = self._kids_player_payload(video_id)
        captured = {}

        def fake_open(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return InnertubeResponse(payload)

        client = radar.YouTubeInnertubePlayerClient(retries=0)
        with patch.object(radar.urllib.request, "urlopen", side_effect=fake_open):
            self.assertTrue(client.has_kids_player_signals(video_id))

        request = captured["request"]
        parsed = radar.urllib.parse.urlparse(request.full_url)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "www.youtube.com")
        self.assertEqual(parsed.path, "/youtubei/v1/player")
        self.assertEqual(
            radar.urllib.parse.parse_qs(parsed.query),
            {"prettyPrint": ["false"]},
        )
        self.assertNotIn("key", radar.urllib.parse.parse_qs(parsed.query))
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["videoId"], video_id)
        self.assertEqual(body["context"]["client"], {
            "clientName": "ANDROID",
            "clientVersion": radar.KIDS_INNERTUBE_CLIENT_VERSION,
            "androidSdkVersion": 35,
            "hl": "en",
            "gl": "US",
        })
        self.assertIs(body["contentCheckOk"], True)
        self.assertIs(body["racyCheckOk"], True)
        headers = {
            key.casefold(): value for key, value in request.header_items()
        }
        self.assertEqual(headers["x-youtube-client-name"], "3")
        self.assertEqual(
            headers["x-youtube-client-version"],
            radar.KIDS_INNERTUBE_CLIENT_VERSION,
        )
        self.assertEqual(headers["accept-language"], "en-US,en;q=0.9")
        self.assertNotIn("cookie", headers)
        self.assertIsInstance(
            radar.KidsDomValidator()._get_client(),
            radar.YouTubeInnertubePlayerClient,
        )

    def test_innertube_player_accepts_only_coherent_positive_or_negative(self):
        kids_id = "Pk7UDVYh2bs"
        normal_id = "XVFUtEh9zrY"
        client = radar.YouTubeInnertubePlayerClient(retries=2)
        negative = self._kids_player_payload(
            normal_id,
            mode="PLAYBACK_MODE_ALLOW",
            include_text=False,
            support_url=None,
        )
        negative["unrelatedRecommendation"] = {
            "playbackMode": "PLAYBACK_MODE_PAUSED_ONLY",
            "text": "Miniplayer is off for videos made for kids. Tap play to resume",
            "url": "https://support.google.com/youtube/bin/answer.py?answer=9632097",
        }
        with patch.object(
            radar.urllib.request,
            "urlopen",
            side_effect=lambda *args, **kwargs: InnertubeResponse(negative),
        ) as opened, patch.object(radar.time, "sleep") as slept:
            self.assertFalse(client.has_kids_player_signals(normal_id))
        self.assertEqual(opened.call_count, 1)
        slept.assert_not_called()

        invalid_payloads = {
            "wrong video": self._kids_player_payload(kids_id),
            "non-OK": self._kids_player_payload(kids_id, status="LOGIN_REQUIRED"),
            "missing renderer": {
                "videoDetails": {"videoId": kids_id},
                "playabilityStatus": {"status": "OK"},
            },
            "unknown mode": self._kids_player_payload(kids_id, mode="UNKNOWN"),
        }
        invalid_payloads["wrong video"]["videoDetails"]["videoId"] = normal_id
        for label, invalid in invalid_payloads.items():
            strict_client = radar.YouTubeInnertubePlayerClient(retries=0)
            with self.subTest(case=label), patch.object(
                radar.urllib.request,
                "urlopen",
                side_effect=lambda *args, payload=invalid, **kwargs: InnertubeResponse(payload),
            ):
                with self.assertRaises(radar.KidsDomProbeError):
                    strict_client.has_kids_player_signals(kids_id)

    def test_innertube_player_rejects_partial_or_misplaced_signals(self):
        video_id = "Pk7UDVYh2bs"
        partials = {
            2: self._kids_player_payload(video_id, support_url=None),
            1: self._kids_player_payload(
                video_id, include_text=False, support_url=None
            ),
        }
        for signal_count, payload in partials.items():
            client = radar.YouTubeInnertubePlayerClient(
                retries=1, retry_delay_seconds=0.25
            )
            with self.subTest(signals=signal_count), patch.object(
                radar.urllib.request,
                "urlopen",
                side_effect=lambda *args, body=payload, **kwargs: InnertubeResponse(body),
            ) as opened, patch.object(radar.time, "sleep") as slept:
                with self.assertRaisesRegex(
                    radar.KidsDomProbeError, f"signals={signal_count}/3"
                ):
                    client.has_kids_player_signals(video_id)
            self.assertEqual(opened.call_count, 2)
            slept.assert_called_once_with(0.25)

        allow_with_marker = self._kids_player_payload(
            video_id, mode="PLAYBACK_MODE_ALLOW"
        )
        with patch.object(
            radar.urllib.request,
            "urlopen",
            return_value=InnertubeResponse(allow_with_marker),
        ):
            with self.assertRaises(radar.KidsDomProbeError):
                radar.YouTubeInnertubePlayerClient(retries=0).has_kids_player_signals(video_id)

    def test_innertube_support_url_is_strict(self):
        valid = (
            "//support.google.com/youtube/bin/answer.py"
            "?answer=9632097&nohelpkit=1&hl=en"
        )
        self.assertTrue(
            radar.YouTubeInnertubePlayerClient._has_support_answer(valid)
        )
        self.assertTrue(radar.YouTubeInnertubePlayerClient._has_support_answer(
            "https://support.google.com/youtube/answer/9632097"
        ))
        for value in (
            "http://support.google.com/youtube/bin/answer.py?answer=9632097",
            "https://evil.example/youtube/bin/answer.py?answer=9632097",
            "https://support.google.com.evil.example/youtube/bin/answer.py?answer=9632097",
            "https://support.google.com:443/youtube/bin/answer.py?answer=9632097",
            "https://support.google.com/youtube/bin/answer.py?answer=96320970",
            "https://support.google.com/youtube/bin/answer.py?answer=9632097&answer=9632097",
            "https://evil.example/?next=https://support.google.com/youtube/answer/9632097",
            "//support.google.com/other?answer=9632097",
        ):
            with self.subTest(url=value):
                self.assertFalse(
                    radar.YouTubeInnertubePlayerClient._has_support_answer(value)
                )

    def test_innertube_player_rejects_redirected_endpoint(self):
        video_id = "Pk7UDVYh2bs"
        payload = self._kids_player_payload(video_id)
        invalid_urls = (
            "http://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            "https://youtube.com/youtubei/v1/player?prettyPrint=false",
            "https://www.youtube.com:443/youtubei/v1/player?prettyPrint=false",
            "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=public",
        )
        for final_url in invalid_urls:
            with self.subTest(url=final_url), patch.object(
                radar.urllib.request,
                "urlopen",
                return_value=InnertubeResponse(payload, final_url),
            ):
                with self.assertRaisesRegex(
                    radar.KidsDomProbeError, "expected endpoint"
                ):
                    radar.YouTubeInnertubePlayerClient(retries=0).has_kids_player_signals(video_id)

    def test_innertube_player_retries_transient_and_malformed_responses(self):
        video_id = "Pk7UDVYh2bs"
        good = self._kids_player_payload(video_id)
        endpoint = radar.YouTubeInnertubePlayerClient._ENDPOINT
        failures = (
            radar.urllib.error.HTTPError(
                endpoint, 503, "busy", {}, io.BytesIO(b"busy")
            ),
            radar.urllib.error.HTTPError(
                endpoint, 403, "blocked", {}, io.BytesIO(b"blocked")
            ),
            radar.http.client.IncompleteRead(b"partial", 100),
            b"{not-json",
            {"videoDetails": {"videoId": video_id}},
        )
        for failure in failures:
            responses = iter((failure, good))

            def fake_open(*args, **kwargs):
                value = next(responses)
                if isinstance(value, Exception):
                    raise value
                return InnertubeResponse(value)

            client = radar.YouTubeInnertubePlayerClient(
                retries=1, retry_delay_seconds=0.25
            )
            with self.subTest(failure=type(failure).__name__), patch.object(
                radar.urllib.request, "urlopen", side_effect=fake_open
            ) as opened, patch.object(radar.time, "sleep") as slept:
                self.assertTrue(client.has_kids_player_signals(video_id))
            self.assertEqual(opened.call_count, 2)
            slept.assert_called_once_with(0.25)

    def test_innertube_player_fails_closed_after_malformed_json_exhaustion(self):
        video_id = "Pk7UDVYh2bs"
        client = radar.YouTubeInnertubePlayerClient(
            retries=1, retry_delay_seconds=0
        )
        with patch.object(
            radar.urllib.request,
            "urlopen",
            side_effect=lambda *args, **kwargs: InnertubeResponse(b"{bad-json"),
        ) as opened:
            with self.assertRaisesRegex(radar.KidsDomProbeError, "malformed JSON"):
                client.has_kids_player_signals(video_id)
        self.assertEqual(opened.call_count, 2)

    def test_innertube_player_rejects_noncanonical_json_and_oversize(self):
        video_id = "Pk7UDVYh2bs"
        malformed = (
            b'{"videoDetails":{},"videoDetails":{}}',
            b'{"value":NaN}',
            b'[]',
        )
        for raw in malformed:
            with self.subTest(raw=raw), patch.object(
                radar.urllib.request,
                "urlopen",
                side_effect=lambda *args, body=raw, **kwargs: InnertubeResponse(body),
            ):
                with self.assertRaises(radar.KidsDomProbeError):
                    radar.YouTubeInnertubePlayerClient(retries=0).has_kids_player_signals(video_id)

        with patch.object(radar, "KIDS_INNERTUBE_MAX_JSON_BYTES", 8), patch.object(
            radar.urllib.request,
            "urlopen",
            return_value=InnertubeResponse(b"123456789"),
        ):
            with self.assertRaisesRegex(radar.KidsDomProbeError, "bounded JSON size"):
                radar.YouTubeInnertubePlayerClient(retries=0).has_kids_player_signals(video_id)

        with self.assertRaisesRegex(ValueError, "Invalid Innertube Android"):
            radar.YouTubeInnertubePlayerClient(client_version="bad\nheader")

    def test_dom_probe_rejects_consent_then_continues(self):
        client = object.__new__(radar.ChromeWebDriverClient)
        client.session_id = "session"
        marker_states = iter(("blocked", "marker"))
        requests = []

        def fake_request(method, path, payload=None):
            requests.append((method, path, payload))
            if path.endswith("/url"):
                return None
            if payload["script"] == radar.ChromeWebDriverClient._MARKER_SCRIPT:
                return next(marker_states)
            if payload["script"] == radar.ChromeWebDriverClient._CONSENT_SCRIPT:
                return "clicked"
            raise AssertionError(payload)

        client._request = fake_request
        with patch.object(
            radar.time, "monotonic", side_effect=(0.0, 0.0, 0.1, 0.2)
        ), patch.object(radar.time, "sleep"):
            self.assertTrue(client.has_family_options_marker("abcdefghijk"))
        self.assertIn("&gl=US", requests[0][2]["url"])
        self.assertTrue(any(
            payload and payload.get("script") == radar.ChromeWebDriverClient._CONSENT_SCRIPT
            for _, _, payload in requests
        ))

    def test_dom_validator_runs_canaries_once_and_fails_closed(self):
        class FakeClient:
            def __init__(self, answers):
                self.answers = answers
                self.calls = []

            def has_family_options_marker(self, video_id):
                self.calls.append(video_id)
                return self.answers.get(video_id, False)

            def close(self):
                pass

        answers = {
            radar.KIDS_DOM_POSITIVE_CANARIES[0]: True,
            radar.KIDS_DOM_POSITIVE_CANARIES[1]: True,
            radar.KIDS_DOM_NEGATIVE_CANARY: False,
            "abcdefghijk": True,
            "zyxwvutsrqp": False,
        }
        client = FakeClient(answers)
        validator = radar.KidsDomValidator(client)
        self.assertTrue(validator.is_made_for_kids("abcdefghijk"))
        self.assertFalse(validator.is_made_for_kids("zyxwvutsrqp"))
        for canary in (*radar.KIDS_DOM_POSITIVE_CANARIES, radar.KIDS_DOM_NEGATIVE_CANARY):
            self.assertEqual(client.calls.count(canary), 1)

        failing = FakeClient({
            radar.KIDS_DOM_POSITIVE_CANARIES[0]: True,
            radar.KIDS_DOM_POSITIVE_CANARIES[1]: False,
            radar.KIDS_DOM_NEGATIVE_CANARY: False,
        })
        failed_validator = radar.KidsDomValidator(
            failing,
            canary_retries=1,
            canary_retry_delay_seconds=0,
        )
        with self.assertRaisesRegex(radar.KidsDomCanaryError, "failed closed"):
            failed_validator.is_made_for_kids("abcdefghijk")
        for canary in (*radar.KIDS_DOM_POSITIVE_CANARIES, radar.KIDS_DOM_NEGATIVE_CANARY):
            self.assertEqual(failing.calls.count(canary), 2)
        calls_after_failure = list(failing.calls)
        with self.assertRaises(radar.KidsDomCanaryError):
            failed_validator.is_made_for_kids("abcdefghijk")
        self.assertEqual(failing.calls, calls_after_failure)

    def test_dom_validator_retries_complete_canary_batch_then_succeeds(self):
        first_positive, second_positive = radar.KIDS_DOM_POSITIVE_CANARIES
        batches = (
            {
                first_positive: True,
                second_positive: False,
                radar.KIDS_DOM_NEGATIVE_CANARY: False,
            },
            {
                first_positive: True,
                second_positive: True,
                radar.KIDS_DOM_NEGATIVE_CANARY: False,
            },
        )

        class BatchClient:
            def __init__(self):
                self.calls = []

            def has_family_options_marker(self, video_id):
                batch_index = min(
                    len(self.calls) // 3,
                    len(batches) - 1,
                )
                self.calls.append(video_id)
                return batches[batch_index][video_id]

            def close(self):
                pass

        client = BatchClient()
        validator = radar.KidsDomValidator(
            client,
            canary_retries=1,
            canary_retry_delay_seconds=0.25,
        )
        with patch.object(radar.time, "sleep") as slept:
            validator.ensure_canaries()
        expected_batch = [
            first_positive,
            second_positive,
            radar.KIDS_DOM_NEGATIVE_CANARY,
        ]
        self.assertEqual(client.calls, expected_batch * 2)
        slept.assert_called_once_with(0.25)
        validator.ensure_canaries()
        self.assertEqual(client.calls, expected_batch * 2)

    def test_no_key_shard_still_runs_all_40_kids_queries(self):
        class Validator:
            def __init__(self):
                self.canary_checks = 0

            def ensure_canaries(self):
                self.canary_checks += 1

        validator = Validator()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            output = root / "youtube-shard-0.json"
            manifest = root / "tracked.json"
            radar.write_snapshot(snapshot, {
                "d": {
                    "all": [{"vid": "abcdefghijk", "title": "Focus music"}],
                    "trends": [], "news": [], "ours": [], "kids": [], "lives": [],
                }
            })
            manifest.write_text(json.dumps({
                "version": 1, "ids": ["abcdefghijk"], "quarantine_ids": [],
            }), encoding="utf-8")
            with patch.dict(radar.os.environ, {"YOUTUBE_API_KEY": ""}), patch.object(
                radar, "fetch_owned_ydl_rows", return_value={}
            ), patch.object(
                radar, "fetch_one_video",
                return_value={"vid": "abcdefghijk", "views": 200_000},
            ), patch.object(
                radar, "fetch_discovery_spec", return_value=([], 1, 1)
            ) as discovery, patch.object(
                radar, "kids_dom_validator", return_value=validator
            ):
                artifact = radar.run_shard(snapshot, output, 0, 1, manifest)
        self.assertEqual(len(radar.KIDS_QUERY_SPECS), 40)
        self.assertEqual(artifact["queries_total"], 40)
        self.assertEqual(artifact["kids_queries_total"], 40)
        self.assertEqual(artifact["kids_queries_ok"], 40)
        self.assertEqual(validator.canary_checks, 1)
        self.assertEqual(discovery.call_count, 40)
        self.assertTrue(all(call.args[2] == "" for call in discovery.call_args_list))

    def test_no_key_fallback_prefilters_then_sets_dom_kids_provenance(self):
        now = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)
        good = {
            "id": "abcdefghijk", "title": "SLEEP MUSIC FOR KIDS - Nursery Rhymes Music",
            "duration": 3 * 3600, "view_count": 2_000_000,
            "is_live": False,
        }
        too_short = dict(good, id="zyxwvutsrqp", duration=19 * 60)

        class Reader:
            def __init__(self, result):
                self.result = result
                self.calls = []

            def extract_info(self, target, download=False):
                self.calls.append(target)
                return self.result

        flat_reader = Reader({"entries": [good, too_short]})
        full = dict(
            good,
            upload_date="20260801",
            description="Instrumental sleep music without vocals",
            tags=["instrumental", "baby sleep"],
            channel="Calm Baby",
            channel_url="https://www.youtube.com/@CalmBaby",
        )
        full_reader = Reader(full)

        class Validator:
            def __init__(self):
                self.calls = []
                self.canary_checks = 0

            def ensure_canaries(self):
                self.canary_checks += 1

            def is_made_for_kids(self, video_id):
                self.calls.append(video_id)
                return True

        validator = Validator()
        spec = {
            "query": "baby sleep music instrumental",
            "genre": "Baby sleep",
            "cluster": "Relaxation / meditation",
            "audience": "kids",
            "searchResults": 100,
        }
        with patch.object(radar, "kids_search_ydl", return_value=flat_reader), patch.object(
            radar, "ydl", return_value=full_reader
        ), patch.object(radar, "kids_dom_validator", return_value=validator):
            rows, raw, enriched = radar.fetch_kids_search_ydl(spec, now)
        self.assertEqual((raw, enriched), (2, 1))
        self.assertIn("sp=CAMSAhgC", flat_reader.calls[0])
        self.assertEqual(len(full_reader.calls), 1)
        self.assertEqual(validator.canary_checks, 1)
        self.assertEqual(validator.calls, ["abcdefghijk"])
        self.assertEqual([row["vid"] for row in rows], ["abcdefghijk"])
        self.assertIs(rows[0]["madeForKids"], True)
        self.assertEqual(
            rows[0]["madeForKidsSource"],
            "youtube_innertube_android_player_restrictions",
        )
        self.assertEqual(rows[0]["audiences"], ["kids"])

        rejecting = Validator()
        rejecting.is_made_for_kids = lambda video_id: False
        unused_full_reader = Reader(full)
        with patch.object(radar, "kids_search_ydl", return_value=flat_reader), patch.object(
            radar, "ydl", return_value=unused_full_reader
        ), patch.object(radar, "kids_dom_validator", return_value=rejecting):
            rejected_rows, _, rejected_enriched = radar.fetch_kids_search_ydl(spec, now)
        self.assertEqual(rejected_rows, [])
        self.assertEqual(rejected_enriched, 1)
        self.assertEqual(len(unused_full_reader.calls), 1)

        class BrokenValidator:
            def ensure_canaries(self):
                pass

            def is_made_for_kids(self, video_id):
                raise radar.KidsDomProbeError("webdriver lost")

        with patch.object(radar, "kids_search_ydl", return_value=flat_reader), patch.object(
            radar, "ydl", return_value=unused_full_reader
        ), patch.object(radar, "kids_dom_validator", return_value=BrokenValidator()):
            with self.assertRaisesRegex(radar.KidsDomProbeError, "webdriver lost"):
                radar.fetch_kids_search_ydl(spec, now)

        class BrokenReader:
            def extract_info(self, target, download=False):
                raise RuntimeError("yt-dlp extraction failed")

        with patch.object(radar, "kids_search_ydl", return_value=flat_reader), patch.object(
            radar, "ydl", return_value=BrokenReader()
        ), patch.object(radar, "kids_dom_validator", return_value=validator):
            with self.assertRaisesRegex(RuntimeError, "could be enriched"):
                radar.fetch_kids_search_ydl(spec, now)

    def test_no_key_fallback_runs_canaries_when_prefilter_is_empty(self):
        now = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)

        class Reader:
            def __init__(self, result):
                self.result = result
                self.calls = []

            def extract_info(self, target, download=False):
                self.calls.append(target)
                return self.result

        flat_reader = Reader({"entries": [{
            "id": "abcdefghijk",
            "title": "Baby sleep music instrumental",
            "duration": None,
            "view_count": 2_000_000,
        }]})
        full_reader = Reader({})

        class Validator:
            def __init__(self):
                self.canary_checks = 0
                self.calls = []

            def ensure_canaries(self):
                self.canary_checks += 1

            def is_made_for_kids(self, video_id):
                self.calls.append(video_id)
                return True

        validator = Validator()
        spec = {
            "query": "baby sleep music instrumental",
            "genre": "Baby sleep",
            "cluster": "Relaxation / meditation",
            "audience": "kids",
            "searchResults": 100,
        }
        with patch.object(radar, "kids_search_ydl", return_value=flat_reader), patch.object(
            radar, "ydl", return_value=full_reader
        ), patch.object(radar, "kids_dom_validator", return_value=validator):
            rows, raw, enriched = radar.fetch_kids_search_ydl(spec, now)
        self.assertEqual((rows, raw, enriched), ([], 1, 0))
        self.assertEqual(validator.canary_checks, 1)
        self.assertEqual(validator.calls, [])
        self.assertEqual(full_reader.calls, [])

    def test_instrumental_filter_rejects_kids_vocal_and_spoken_signals(self):
        base = {"duration": 3 * 3600, "title": "Baby sleep music instrumental"}
        self.assertTrue(radar.is_instrumental(base))
        for signal in (
            "lyrics", "vocals", "sing along", "children singing", "bedtime story",
            "spoken word", "voice-over", "guided affirmations", "choir", "humming",
            "children voices", "mantra",
        ):
            row = dict(base, description=signal)
            self.assertFalse(radar.is_instrumental(row), signal)
        self.assertFalse(radar.is_instrumental(dict(base, duration=19 * 60)))
        self.assertTrue(radar.is_instrumental(
            dict(base, title="Baby sleep music · no vocals")
        ))
        self.assertTrue(radar.is_instrumental(
            dict(base, title="Baby sleep music without lyrics")
        ))
        self.assertTrue(radar.is_instrumental(
            dict(base, title="Nursery rhyme piano instrumental")
        ))

    def test_kids_filter_rejects_confirmed_vocal_false_positives(self):
        base = {
            "durH": 3,
            "title": "Baby sleep music instrumental",
            "_scanDescription": "instrumental music box, no vocals",
        }
        verified = dict(
            base,
            vid="abcdefghijk",
            audiences=["kids"],
            madeForKids=True,
            madeForKidsSource="youtube_innertube_android_player_restrictions",
            instrumentalVerified=True,
            liveStatus="none",
            views=200_000,
            vpm=20_000,
        )
        self.assertTrue(radar.is_kids_instrumental(verified))
        self.assertTrue(radar.is_verified_kids_candidate(verified))
        for video_id in ("eNSCeIa5_5g", "Mi0XBUz562Y"):
            denied = dict(verified, vid=video_id)
            self.assertFalse(radar.is_kids_instrumental(denied), video_id)
            self.assertFalse(radar.is_verified_kids_candidate(denied), video_id)

    def test_merge_keyword_rows_preserves_kids_truth_in_both_orders(self):
        youtube = {
            "vid": "abcdefghijk", "views": 2_000_000, "kw": "focus music",
            "audiences": ["youtube"],
        }
        kids = {
            "vid": "abcdefghijk", "views": 2_000_000,
            "kw": "baby sleep music instrumental", "audiences": ["kids"],
            "madeForKids": True,
        }
        for rows in ([youtube, kids], [kids, youtube]):
            merged = radar.merge_keyword_rows(rows)[0]
            self.assertIs(merged["madeForKids"], True)
            self.assertEqual(merged["audiences"], ["youtube", "kids"])
            self.assertEqual(merged["kwCount"], 2)

    def test_update_row_changes_kids_status_only_when_official_value_exists(self):
        now = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)
        existing = {"vid": "abcdefghijk", "madeForKids": True}
        radar.update_row(existing, {"vid": "abcdefghijk", "views": 2}, now)
        self.assertIs(existing["madeForKids"], True)
        radar.update_row(existing, {"vid": "abcdefghijk", "madeForKids": False}, now)
        self.assertIs(existing["madeForKids"], False)

    def test_avatar_overlay_includes_kids_channels(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "avatars.js"
            count = radar.write_avatar_overlay({
                "d": {
                    "all": [], "trends": [], "news": [],
                    "kids": [{
                        "chUrl": "https://www.youtube.com/channel/UC1234567890123456789012",
                        "channelId": "UC1234567890123456789012",
                    }],
                }
            }, output)
            rendered = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn("UC1234567890123456789012", rendered)

    def test_kids_candidate_stays_in_separate_public_bucket(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, {
                "d": {
                    "all": [{"vid": "abcdefghijk", "views": 1_000_000, "pub": 1700000000000}],
                    "trends": [], "news": [], "ours": [], "recos": [], "roadmap": [], "lives": [],
                }
            })
            generated = int(datetime(2026, 8, 10, 8, tzinfo=timezone.utc).timestamp() * 1000)
            artifact = {
                "version": 1, "generated_ms": generated, "shard": 0, "shards": 1,
                "tracked_total": 1, "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"], "tracked_fresh_ids": ["abcdefghijk"],
                "tracked_failed_ids": [], "tracked_unavailable_ids": [], "tracked_recovered_ids": [],
                "queries_total": 1, "queries_ok": 1, "queries_raw": 3, "queries_enriched": 3,
                "fresh": [{"vid": "abcdefghijk", "views": 1_000_001, "pub": 1700000000000}],
                "owned_fresh": [], "live_audiences": {},
                "candidates": [{
                    "vid": "zyxwvutsrqp", "title": "Baby sleep music instrumental",
                    "views": 150_000, "pub": generated - 10 * 86400000, "ageM": 1,
                    "vpm": 150_000, "genre": "Baby sleep", "cluster": "Relaxation / meditation",
                    "kw": "baby sleep music instrumental", "audiences": ["kids"],
                    "madeForKids": True, "durH": 2, "channel": "Calm Baby",
                }],
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "expected .* Kids queries"):
                radar.merge_artifacts(
                    snapshot, avatars, shards, 1,
                    generate_recommendations=False,
                    require_kids=True,
                )
            artifact["kids_queries_total"] = len(radar.KIDS_QUERY_SPECS)
            artifact["kids_queries_ok"] = len(radar.KIDS_QUERY_SPECS) - 2
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "40/40.*38/40"):
                radar.merge_artifacts(
                    snapshot, avatars, shards, 1,
                    generate_recommendations=False,
                    require_kids=True,
                )
            artifact["kids_queries_ok"] = len(radar.KIDS_QUERY_SPECS)
            verified_candidates = artifact["candidates"]
            artifact["candidates"] = []
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            with self.assertRaisesRegex(RuntimeError, "no verified candidates"):
                radar.merge_artifacts(
                    snapshot, avatars, shards, 1,
                    generate_recommendations=False,
                    require_kids=True,
                )
            artifact["candidates"] = verified_candidates
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            summary = radar.merge_artifacts(
                snapshot, avatars, shards, 1,
                generate_recommendations=False,
                require_kids=True,
            )
            artifact["generated_ms"] = generated + 3600000
            artifact["fresh"][0]["views"] = 1_000_002
            artifact["candidates"] = []
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            daily_summary = radar.merge_artifacts(
                snapshot, avatars, shards, 1,
                generate_recommendations=False,
                require_kids=True,
            )
            data = radar.read_snapshot(snapshot)["d"]
        self.assertEqual([row["vid"] for row in data["kids"]], ["zyxwvutsrqp"])
        self.assertNotIn("zyxwvutsrqp", {row["vid"] for row in data["all"]})
        self.assertEqual(summary["kids_added"], 1)
        self.assertEqual(daily_summary["kids_added"], 0)
        self.assertEqual(
            [row["vid"] for row in data["kids"]],
            ["zyxwvutsrqp"],
        )

    def test_rerun_replaces_same_utc_day(self):
        day = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        later = day + 4 * 3600000
        points = radar.append_daily_point([[day, 100]], later, 125)
        self.assertEqual(points, [[later, 125]])

    def test_merge_updates_existing_video_and_adds_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            payload = {
                "t": 1,
                "d": {
                    "all": [{"vid": "abcdefghijk", "title": "Old", "views": 100, "pub": 1700000000000, "kw": "focus music"}],
                    "trends": [],
                    "news": [],
                    "recos": [],
                    "roadmap": [],
                },
            }
            radar.write_snapshot(snapshot, payload)
            generated = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            artifact = {
                "version": 1,
                "generated_ms": generated,
                "shard": 0,
                "shards": 1,
                "tracked_total": 1,
                "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"],
                "tracked_fresh_ids": ["abcdefghijk"],
                "queries_total": 1,
                "queries_ok": 1,
                "queries_raw": 10,
                "queries_enriched": 10,
                "fresh": [{
                    "vid": "abcdefghijk",
                    "title": "Fresh",
                    "views": 150,
                    "pub": 1700000000000,
                    "chUrl": "https://www.youtube.com/@FocusChannel",
                    "channelId": "UC1234567890123456789012",
                }],
                "candidates": [],
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            summary = radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
            history = json.loads((root / "video_history" / "61.json").read_text(encoding="utf-8"))
            self.assertEqual(merged["d"]["all"][0]["views"], 150)
            self.assertEqual(merged["d"]["all"][0]["title"], "Fresh")
            self.assertEqual(merged["d"]["all"][0]["channelId"], "UC1234567890123456789012")
            self.assertNotIn("hist", merged["d"])
            self.assertEqual(history["d"]["abcdefghijk"], [[generated, 150]])
            self.assertEqual(merged["videoMetricsT"], generated)
            self.assertEqual(merged["videoMetrics"]["search_results"], 10)
            self.assertEqual(merged["videoMetrics"]["search_results_enriched"], 10)
            self.assertEqual(summary["updated"], 1)

    def test_discovery_failure_never_blocks_factual_daily_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, {
                "t": 1,
                "d": {
                    "all": [{"vid": "abcdefghijk", "title": "Tracked", "views": 100, "pub": 1700000000000}],
                    "trends": [], "news": [], "recos": [], "roadmap": [],
                },
            })
            manifest = root / "tracked.json"
            ours_digest = radar.hashlib.sha256(b"abcdefghijk").hexdigest()
            manifest.write_text(
                json.dumps({
                    "version": 2,
                    "scan_scope": "all",
                    "ids": ["abcdefghijk"],
                    "ours_ids": ["abcdefghijk"],
                    "ours_total": 1,
                    "ours_digest": ours_digest,
                    "quarantine_ids": [],
                }),
                encoding="utf-8",
            )
            generated = int(datetime(2026, 8, 4, 8, tzinfo=timezone.utc).timestamp() * 1000)
            with patch.object(radar, "utc_now_ms", return_value=generated), patch.object(
                radar, "fetch_owned_ydl_rows", side_effect=RuntimeError("owned discovery unavailable")
            ), patch.object(
                radar, "query_specs", return_value=[{"query": "focus music"}]
            ), patch.object(
                radar, "fetch_search", side_effect=RuntimeError("search unavailable")
            ), patch.object(
                radar,
                "fetch_one_video",
                return_value={"vid": "abcdefghijk", "title": "Tracked", "views": 150, "pub": 1700000000000},
            ), patch.dict(radar.os.environ, {"YOUTUBE_API_KEY": ""}):
                artifact = radar.run_shard(
                    snapshot,
                    shards / "youtube-shard-0.json",
                    0,
                    1,
                    tracked_manifest=manifest,
                )

            self.assertEqual(artifact["tracked_ok"], 1)
            self.assertEqual(artifact["queries_ok"], 0)
            self.assertFalse(artifact["owned_ok"])
            radar.merge_artifacts(
                snapshot,
                avatars,
                shards,
                1,
                generate_recommendations=False,
            )
            merged = radar.read_snapshot(snapshot)
            metrics = merged["videoMetrics"]
            self.assertFalse(metrics["partial"])
            self.assertTrue(metrics["discovery_partial"])
            self.assertFalse(metrics["owned_discovery_ok"])
            self.assertEqual(metrics["history_updated"], 1)
            self.assertTrue(radar.snapshot_freshness(snapshot, generated)["fresh"])

    def test_daily_history_keeps_latest_point_per_paris_day(self):
        morning = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        evening = morning + 10 * 3600000
        next_day = morning + 24 * 3600000
        points = radar.normalize_daily_points(
            [[morning, 100], [evening, 125], [next_day, 140]], next_day
        )
        self.assertEqual(points, [[evening, 125], [next_day, 140]])

    def test_scans_on_both_sides_of_paris_midnight_are_not_deduplicated(self):
        july_27_paris = int(datetime(2026, 7, 27, 16, 7, tzinfo=timezone.utc).timestamp() * 1000)
        july_28_paris = int(datetime(2026, 7, 27, 23, 49, tzinfo=timezone.utc).timestamp() * 1000)
        points = radar.normalize_daily_points(
            [[july_27_paris, 100], [july_28_paris, 125]],
            july_28_paris,
        )
        self.assertEqual(points, [[july_27_paris, 100], [july_28_paris, 125]])
        self.assertEqual(radar.history_day_key(july_27_paris), "2026-07-27")
        self.assertEqual(radar.history_day_key(july_28_paris), "2026-07-28")

    def test_daily_history_drops_points_before_20_july_2026(self):
        before = int(datetime(2026, 7, 19, 20, tzinfo=timezone.utc).timestamp() * 1000)
        start = int(datetime(2026, 7, 20, 20, tzinfo=timezone.utc).timestamp() * 1000)
        next_day = start + 86400000
        points = radar.normalize_daily_points([[before, 100], [start, 120], [next_day, 150]], next_day)
        self.assertEqual(points, [[start, 120], [next_day, 150]])

    def test_history_is_not_erased_when_a_source_temporarily_omits_an_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            history_dir = Path(tmp)
            stamp = int(datetime(2026, 7, 27, 16, tzinfo=timezone.utc).timestamp() * 1000)
            path = history_dir / "61.json"
            path.write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"abcdefghijk": [[stamp, 100]]}}),
                encoding="utf-8",
            )
            radar.update_history_shards(history_dir, set(), {}, {}, stamp + 3600000)
            history = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(history["d"]["abcdefghijk"], [[stamp, 100]])

    def test_canonical_owned_video_sheet_fails_closed(self):
        with patch.object(radar.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertRaisesRegex(RuntimeError, "canonical dashboard video list"):
                radar.sheet_video_ids()

    def test_sheet_manifest_includes_every_video_tab_visible_in_the_dashboard(self):
        from openpyxl import Workbook

        workbook = Workbook()
        all_videos = workbook.active
        all_videos.title = "All Videos"
        all_videos["A2"] = '=IMAGE("https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg")'
        trends = workbook.create_sheet("Trends")
        trends["A2"] = '=HYPERLINK("https://youtu.be/zyxwvutsrqp","Thumb")'
        news = workbook.create_sheet("News")
        news["B2"] = '=HYPERLINK("https://www.youtube.com/shorts/mnopqrstuvw","News")'
        ours = workbook.create_sheet("Our Videos")
        ours["A2"] = "12345678901"
        payload = io.BytesIO()
        workbook.save(payload)
        payload.seek(0)

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        with patch.object(radar.urllib.request, "urlopen", return_value=Response(payload.read())):
            catalog = radar.sheet_video_catalog()
            ids = catalog["all"]
        self.assertEqual(
            ids,
            {"abcdefghijk", "zyxwvutsrqp", "mnopqrstuvw", "12345678901"},
        )
        self.assertEqual(catalog["ours"], {"12345678901"})

    def test_one_canonical_manifest_is_reused_by_all_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            manifest_path = root / "artifacts" / "tracked.json"
            radar.write_snapshot(snapshot, {"videoMetricsT": 123, "d": {}})
            with patch.object(
                radar,
                "sheet_video_catalog",
                return_value={"all": {"abcdefghijk", "zyxwvutsrqp"}, "ours": {"abcdefghijk"}},
            ), patch.object(radar, "tracked_ids", return_value=["abcdefghijk", "zyxwvutsrqp"]) as tracked:
                manifest = radar.write_tracked_manifest(snapshot, manifest_path)
            loaded = radar.read_tracked_manifest(manifest_path)
        tracked.assert_called_once()
        self.assertEqual(manifest["ids"], ["abcdefghijk", "zyxwvutsrqp"])
        self.assertEqual(manifest["ours_ids"], ["abcdefghijk"])
        self.assertEqual(manifest["ours_total"], 1)
        self.assertEqual(loaded, ["abcdefghijk", "zyxwvutsrqp"])

    def test_publicly_unavailable_ids_are_quarantined_but_kept_as_recovery_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            manifest_path = root / "artifacts" / "tracked.json"
            radar.write_snapshot(snapshot, {
                "videoMetricsT": 123,
                "videoMetrics": {"unavailable_ids": ["abcdefghijk"]},
                "d": {
                    "all": [
                        {"vid": "abcdefghijk", "title": "Unavailable"},
                        {"vid": "zyxwvutsrqp", "title": "Public"},
                    ],
                },
            })
            with patch.object(
                radar,
                "sheet_video_catalog",
                return_value={
                    "all": {"abcdefghijk", "zyxwvutsrqp"},
                    "ours": {"abcdefghijk", "zyxwvutsrqp"},
                },
            ):
                manifest = radar.write_tracked_manifest(snapshot, manifest_path)
            active = radar.read_tracked_manifest(manifest_path)
            probes = radar.read_quarantine_manifest(manifest_path)
        self.assertEqual(manifest["ids"], ["zyxwvutsrqp"])
        self.assertEqual(manifest["ours_ids"], ["abcdefghijk", "zyxwvutsrqp"])
        self.assertEqual(manifest["ours_total"], 2)
        self.assertEqual(active, ["zyxwvutsrqp"])
        self.assertEqual(probes, ["abcdefghijk"])

    def test_missing_subscriber_count_does_not_become_zero(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        row = radar.info_to_row(
            {
                "id": "abcdefghijk",
                "title": "Focus mix",
                "view_count": 100,
                "duration": 3600,
                "upload_date": "20260719",
            },
            now,
        )
        self.assertNotIn("subs", row)

    def test_video_info_preserves_channel_id_for_avatar_lookup(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        row = radar.info_to_row(
            {
                "id": "abcdefghijk",
                "title": "Focus mix",
                "view_count": 100,
                "duration": 3600,
                "upload_date": "20260719",
                "channel_id": "UC1234567890123456789012",
                "channel_url": "https://www.youtube.com/@FocusChannel",
            },
            now,
        )
        self.assertEqual(row["channelId"], "UC1234567890123456789012")

    def test_public_watch_duration_uses_real_length_seconds(self):
        self.assertEqual(
            radar.parse_watch_duration('{"videoDetails":{"lengthSeconds":"3661"}}'),
            3661.0,
        )
        self.assertIsNone(radar.parse_watch_duration('{"videoDetails":{}}'))

    def test_owned_genre_is_inferred_only_from_explicit_title_words(self):
        self.assertEqual(
            radar.owned_genre_from_title("summer lofi - chill beats to relax to"),
            "Lofi / chillhop",
        )
        self.assertEqual(radar.owned_genre_from_title("Deep Focus"), "")

    def test_update_row_backfills_genre_without_overwriting_curated_genre(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        empty = {"vid": "abcdefghijk"}
        radar.update_row(
            empty,
            {"genre": "Lofi / chillhop", "genreSource": "title_explicit"},
            now,
        )
        self.assertEqual(empty["genre"], "Lofi / chillhop")
        self.assertEqual(empty["genreSource"], "title_explicit")

        curated = {"vid": "abcdefghijk", "genre": "Ambient"}
        radar.update_row(
            curated,
            {"genre": "Lofi / chillhop", "genreSource": "title_explicit"},
            now,
        )
        self.assertEqual(curated["genre"], "Ambient")

    def test_update_row_keeps_precise_api_metadata_against_yt_dlp(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        precise_pub = 1_700_000_000_123
        existing = {
            "vid": "abcdefghijk",
            "title": "Canonical API title",
            "views": 100,
            "pub": precise_pub,
            "metadataSource": radar.METADATA_SOURCE_API,
            "pubSource": radar.METADATA_SOURCE_API,
        }
        radar.update_row(existing, {
            "vid": "abcdefghijk",
            "title": "Less reliable discovery title",
            "views": 150,
            "pub": 1_700_006_400_000,
            "metadataSource": radar.METADATA_SOURCE_YTDLP,
            "pubSource": radar.METADATA_SOURCE_YTDLP,
        }, now)
        self.assertEqual(existing["views"], 150)
        self.assertEqual(existing["title"], "Canonical API title")
        self.assertEqual(existing["pub"], precise_pub)
        self.assertEqual(existing["pubSource"], radar.METADATA_SOURCE_API)

        legacy = {"vid": "zyxwvutsrqp", "pub": precise_pub, "views": 10}
        radar.update_row(legacy, {
            "vid": "zyxwvutsrqp",
            "title": "yt-dlp title must not replace legacy metadata",
            "views": 20,
            "pub": 1_700_006_400_000,
            "metadataSource": radar.METADATA_SOURCE_YTDLP,
            "pubSource": radar.METADATA_SOURCE_YTDLP,
        }, now)
        self.assertEqual(legacy["views"], 20)
        self.assertEqual(legacy["pub"], precise_pub)
        self.assertEqual(legacy["pubSource"], radar.METADATA_SOURCE_PRESERVED)
        self.assertEqual(
            legacy["title"],
            "yt-dlp title must not replace legacy metadata",
        )

    def test_card_validation_rejects_stale_views_or_derived_metrics(self):
        now = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
        pub = 1_700_000_000_000
        fresh = {"abcdefghijk": {"vid": "abcdefghijk", "views": 200, "pub": pub}}
        age = radar.age_months(pub, now)
        valid = {
            "all": [{
                "vid": "abcdefghijk",
                "views": 200,
                "pub": pub,
                "ageM": age,
                "vpm": 200 / age,
            }],
        }
        self.assertEqual(
            radar.validate_card_refresh(valid, fresh, {"abcdefghijk"}, now),
            (1, 1),
        )
        valid["all"][0]["vpm"] = 0
        with self.assertRaisesRegex(RuntimeError, "vpm"):
            radar.validate_card_refresh(valid, fresh, {"abcdefghijk"}, now)

    def test_official_upload_lookup_uses_the_channel_uploads_playlist(self):
        responses = iter([
            {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": "UUofficial"}}}]},
            {"items": [{"contentDetails": {"videoId": "abcdefghijk"}}]},
        ])
        with patch.object(radar, "youtube_api_payload", side_effect=lambda *args: next(responses)) as api:
            ids = radar.fetch_owned_upload_ids("test-key")
        self.assertEqual(ids, ["abcdefghijk"])
        self.assertEqual(api.call_args_list[0].args[0], "channels")
        self.assertEqual(api.call_args_list[1].args[0], "playlistItems")

    def test_official_upload_fallback_uses_the_public_channel_videos_page(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)

        class Channel:
            def extract_info(self, url, download=False):
                self.url = url
                return {"entries": [{"id": "abcdefghijk"}]}

        channel = Channel()
        with patch.object(radar, "owned_ydl", return_value=channel), patch.object(
            radar,
            "fetch_one_video",
            return_value={
                "vid": "abcdefghijk",
                "title": "summer lofi - chill beats to relax to",
                "views": 100,
            },
        ), patch.object(radar, "fetch_public_duration", return_value=3661.0) as duration:
            rows = radar.fetch_owned_ydl_rows(now)
        self.assertEqual(channel.url, "https://www.youtube.com/@LofiGirl/videos")
        self.assertEqual(rows["abcdefghijk"]["source"], "Official Lofi Girl daily scan")
        self.assertEqual(rows["abcdefghijk"]["genre"], "Lofi / chillhop")
        self.assertAlmostEqual(rows["abcdefghijk"]["durH"], 3661 / 3600)
        duration.assert_called_once_with("abcdefghijk")

    def test_merge_inserts_official_upload_into_analysis_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, {"t": 1, "d": {"all": [{"vid": "abcdefghijk", "views": 100, "pub": 1700000000000}], "trends": [], "news": [], "ours": [], "recos": [], "roadmap": []}})
            generated = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            tracked = {"vid": "abcdefghijk", "title": "Tracked", "views": 101, "pub": 1700000000000}
            owned = {"vid": "zyxwvutsrqp", "title": "New Lofi Girl upload", "views": 200, "pub": generated, "durH": 1.0, "source": "Official Lofi Girl daily scan"}
            artifact = {"version": 1, "generated_ms": generated, "shard": 0, "shards": 1, "tracked_total": 1, "tracked_ok": 1, "tracked_ids": ["abcdefghijk"], "tracked_fresh_ids": ["abcdefghijk"], "queries_total": 1, "queries_ok": 1, "queries_raw": 1, "queries_enriched": 1, "fresh": [tracked, owned], "owned_fresh": [owned], "candidates": []}
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
            self.assertEqual(merged["d"]["ours"][0]["vid"], "zyxwvutsrqp")
            history = json.loads((root / "video_history" / "7a.json").read_text(encoding="utf-8"))
            self.assertEqual(history["d"]["zyxwvutsrqp"], [[generated, 200]])

    def test_existing_owned_card_uses_tracked_fresh_not_owned_discovery_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
            precise_pub = 1_700_000_000_123
            radar.write_snapshot(snapshot, {
                "d": {
                    "all": [], "trends": [], "news": [], "kids": [],
                    "ours": [{
                        "vid": "abcdefghijk",
                        "title": "Canonical title",
                        "views": 100,
                        "pub": precise_pub,
                        "metadataSource": radar.METADATA_SOURCE_API,
                        "pubSource": radar.METADATA_SOURCE_API,
                    }],
                    "recos": [], "roadmap": [], "lives": [],
                },
            })
            tracked = {
                "vid": "abcdefghijk",
                "title": "Canonical title",
                "views": 250,
                "pub": precise_pub,
                "metadataSource": radar.METADATA_SOURCE_API,
                "pubSource": radar.METADATA_SOURCE_API,
            }
            discovery = {
                "vid": "abcdefghijk",
                "title": "Discovery title",
                "views": 175,
                "pub": precise_pub + 86_400_000,
                "metadataSource": radar.METADATA_SOURCE_YTDLP,
                "pubSource": radar.METADATA_SOURCE_YTDLP,
                "source": "Official Lofi Girl daily scan",
            }
            artifact = {
                "version": 1, "generated_ms": generated, "shard": 0, "shards": 1,
                "tracked_total": 1, "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"],
                "tracked_fresh_ids": ["abcdefghijk"],
                "tracked_failed_ids": [], "tracked_unavailable_ids": [],
                "tracked_recovered_ids": [], "queries_total": 0, "queries_ok": 0,
                "queries_raw": 0, "queries_enriched": 0, "owned_ok": True,
                "fresh": [tracked], "owned_fresh": [discovery], "candidates": [],
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            summary = radar.merge_artifacts(
                snapshot,
                avatars,
                shards,
                1,
                generate_recommendations=False,
            )
            merged = radar.read_snapshot(snapshot)
        card = merged["d"]["ours"][0]
        self.assertEqual(card["views"], 250)
        self.assertEqual(card["pub"], precise_pub)
        self.assertEqual(card["title"], "Canonical title")
        self.assertEqual(card["source"], "Official Lofi Girl daily scan")
        self.assertEqual(summary["card_rows_expected"], 1)
        self.assertEqual(summary["card_rows_updated"], 1)

    def test_all_83_sheet_owned_cards_are_materialized_from_fresh_beyond_discovery_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
            ids = [f"{index:011d}" for index in range(83)]
            digest = radar.hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()
            radar.write_snapshot(snapshot, {
                "d": {
                    "all": [], "trends": [], "news": [], "kids": [],
                    "ours": [{"vid": video_id, "title": "Sheet title"} for video_id in ids[:50]],
                    "recos": [], "roadmap": [], "lives": [],
                },
            })
            fresh = [{
                "vid": video_id,
                "title": f"Canonical {index}",
                "views": 100_000 + index,
                "pub": 1_700_000_000_000 + index,
                "metadataSource": radar.METADATA_SOURCE_API,
                "pubSource": radar.METADATA_SOURCE_API,
            } for index, video_id in enumerate(ids)]
            artifact = {
                "version": 1, "scan_scope": "standard", "generated_ms": generated,
                "shard": 0, "shards": 1, "tracked_total": 83, "tracked_ok": 83,
                "tracked_ids": ids, "tracked_fresh_ids": ids,
                "tracked_failed_ids": [], "tracked_unavailable_ids": [],
                "tracked_recovered_ids": [], "queries_total": 0, "queries_ok": 0,
                "queries_raw": 0, "queries_enriched": 0, "owned_ok": True,
                "fresh": fresh, "owned_fresh": fresh[:50], "candidates": [],
                "canonical_ours_manifest": True,
                "canonical_ours_ids": ids,
                "canonical_ours_total": 83,
                "canonical_ours_digest": digest,
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            summary = radar.merge_artifacts(
                snapshot, avatars, shards, 1,
                generate_recommendations=False,
                scan_scope="standard",
            )
            merged = radar.read_snapshot(snapshot)

        self.assertEqual(len(merged["d"]["ours"]), 83)
        by_id = {row["vid"]: row for row in merged["d"]["ours"]}
        self.assertEqual(by_id[ids[-1]]["views"], 100_082)
        self.assertEqual(by_id[ids[-1]]["pub"], 1_700_000_000_082)
        self.assertEqual(summary["sheet_ours_expected"], 83)
        self.assertEqual(summary["sheet_ours_updated"], 83)
        self.assertEqual(merged["videoMetrics"]["sheet_ours_expected"], 83)
        self.assertEqual(merged["videoMetrics"]["sheet_ours_updated"], 83)
        self.assertEqual(summary["analysis_rows_expected"], 83)
        self.assertEqual(summary["analysis_rows_updated"], 83)

    def test_visible_analysis_proof_matches_real_sheet_snapshot_merge_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
            sheet_ids = [f"s{index:010d}" for index in range(79)]
            extra_ids = [f"x{index:010d}" for index in range(12)]
            all_ids = sorted(sheet_ids + extra_ids)
            digest = radar.hashlib.sha256(
                "\n".join(sorted(sheet_ids)).encode("utf-8")
            ).hexdigest()
            # Mirrors production: 79 unique Sheet rows, seven short rows hidden
            # by Analyse, plus twelve snapshot-only rows of which one is short.
            existing_extras = [{
                "vid": video_id,
                "title": f"Snapshot-only {index}",
                "views": 90_000 + index,
                "pub": 1_700_000_100_000 + index,
                "durH": 0.025 if index == 0 else None,
            } for index, video_id in enumerate(extra_ids)]
            radar.write_snapshot(snapshot, {"d": {
                "all": [], "trends": [], "news": [], "kids": [],
                "ours": existing_extras,
                "recos": [], "roadmap": [], "lives": [],
            }})
            fresh = []
            for index, video_id in enumerate(sheet_ids):
                fresh.append({
                    "vid": video_id,
                    "title": f"Sheet {index}",
                    "views": 100_000 + index,
                    "pub": 1_700_000_000_000 + index,
                    "durH": 0.01 if index < 7 else 1.0,
                    "metadataSource": radar.METADATA_SOURCE_API,
                    "pubSource": radar.METADATA_SOURCE_API,
                })
            for index, row in enumerate(existing_extras):
                fresh.append({
                    **row,
                    "views": 110_000 + index,
                    "metadataSource": radar.METADATA_SOURCE_API,
                    "pubSource": radar.METADATA_SOURCE_API,
                })
            artifact = {
                "version": 1, "scan_scope": "standard", "generated_ms": generated,
                "shard": 0, "shards": 1, "tracked_total": 91, "tracked_ok": 91,
                "tracked_ids": all_ids, "tracked_fresh_ids": all_ids,
                "tracked_failed_ids": [], "tracked_unavailable_ids": [],
                "tracked_recovered_ids": [], "queries_total": 0, "queries_ok": 0,
                "queries_raw": 0, "queries_enriched": 0, "owned_ok": True,
                "fresh": fresh, "owned_fresh": fresh[:50], "candidates": [],
                "canonical_ours_manifest": True,
                "canonical_ours_ids": sorted(sheet_ids),
                "canonical_ours_total": 79,
                "canonical_ours_digest": digest,
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            summary = radar.merge_artifacts(
                snapshot, avatars, shards, 1,
                generate_recommendations=False,
                scan_scope="standard",
            )
            merged = radar.read_snapshot(snapshot)

        visible = [row for row in merged["d"]["ours"] if radar.is_analysis_card(row)]
        self.assertEqual(len({row["vid"] for row in merged["d"]["ours"]}), 91)
        self.assertEqual(len(visible), 83)
        self.assertEqual(summary["sheet_ours_expected"], 79)
        self.assertEqual(summary["sheet_ours_updated"], 79)
        self.assertEqual(summary["analysis_rows_expected"], 83)
        self.assertEqual(summary["analysis_rows_updated"], 83)

    def test_canonical_sheet_owned_proof_rejects_a_truncated_shard_union(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
            ids = [f"{index:011d}" for index in range(83)]
            digest = radar.hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest()
            radar.write_snapshot(snapshot, {"d": {
                "all": [], "trends": [], "news": [], "kids": [], "ours": [],
                "recos": [], "roadmap": [], "lives": [],
            }})
            partial = ids[:-1]
            fresh = [{
                "vid": video_id, "views": 100_000 + index,
                "pub": 1_700_000_000_000 + index,
                "metadataSource": radar.METADATA_SOURCE_API,
                "pubSource": radar.METADATA_SOURCE_API,
            } for index, video_id in enumerate(partial)]
            artifact = {
                "version": 1, "scan_scope": "standard", "generated_ms": generated,
                "shard": 0, "shards": 1, "tracked_total": 82, "tracked_ok": 82,
                "tracked_ids": partial, "tracked_fresh_ids": partial,
                "tracked_failed_ids": [], "tracked_unavailable_ids": [],
                "tracked_recovered_ids": [], "queries_total": 0, "queries_ok": 0,
                "queries_raw": 0, "queries_enriched": 0, "owned_ok": True,
                "fresh": fresh, "owned_fresh": fresh[:50], "candidates": [],
                "canonical_ours_manifest": True,
                "canonical_ours_ids": partial,
                "canonical_ours_total": 83,
                "canonical_ours_digest": digest,
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "truncated or inconsistent"):
                radar.merge_artifacts(
                    snapshot, avatars, shards, 1,
                    generate_recommendations=False,
                    scan_scope="standard",
                )

    def test_fallback_quarantines_only_after_two_consecutive_missing_scans(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            public_id = "abcdefghijk"
            missing_id = "zyxwvutsrqp"
            radar.write_snapshot(snapshot, {
                "t": 1,
                "d": {
                    "all": [
                        {"vid": public_id, "views": 100, "pub": 1700000000000},
                        {"vid": missing_id, "views": 200, "pub": 1700000000000},
                    ],
                    "trends": [],
                    "news": [],
                    "ours": [],
                    "recos": [],
                    "roadmap": [],
                },
            })

            def write_missing_artifact(generated, views):
                artifact = {
                    "version": 1,
                    "generated_ms": generated,
                    "shard": 0,
                    "shards": 1,
                    "tracked_total": 2,
                    "tracked_ok": 1,
                    "tracked_ids": [public_id, missing_id],
                    "tracked_fresh_ids": [public_id],
                    "tracked_failed_ids": [missing_id],
                    "tracked_unavailable_ids": [],
                    "tracked_recovered_ids": [],
                    "queries_total": 1,
                    "queries_ok": 1,
                    "queries_raw": 1,
                    "queries_enriched": 1,
                    "fresh": [{"vid": public_id, "views": views, "pub": 1700000000000}],
                    "owned_fresh": [],
                    "candidates": [],
                }
                (shards / "youtube-shard-0.json").write_text(
                    json.dumps(artifact), encoding="utf-8"
                )

            first = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            write_missing_artifact(first, 101)
            with patch.object(radar, "MIN_PUBLISH_TRACK_RATIO", 0.0):
                radar.merge_artifacts(snapshot, avatars, shards, 1)
            first_metrics = radar.read_snapshot(snapshot)["videoMetrics"]
            self.assertTrue(first_metrics["partial"])
            self.assertEqual(first_metrics["tracked"], 2)
            self.assertEqual(first_metrics["updated"], 1)
            self.assertEqual(first_metrics["missing_ids"], [missing_id])
            self.assertEqual(first_metrics["unavailable_ids"], [])

            second = first + 3600000
            write_missing_artifact(second, 102)
            with patch.object(radar, "MIN_PUBLISH_TRACK_RATIO", 0.0):
                radar.merge_artifacts(snapshot, avatars, shards, 1)
            second_metrics = radar.read_snapshot(snapshot)["videoMetrics"]
            self.assertFalse(second_metrics["partial"])
            self.assertEqual(second_metrics["tracked"], 1)
            self.assertEqual(second_metrics["updated"], 1)
            self.assertEqual(second_metrics["missing_ids"], [])
            self.assertEqual(second_metrics["unavailable_ids"], [missing_id])

            third = second + 3600000
            recovery_artifact = {
                "version": 1,
                "generated_ms": third,
                "shard": 0,
                "shards": 1,
                "tracked_total": 1,
                "tracked_ok": 1,
                "tracked_ids": [public_id],
                "tracked_fresh_ids": [public_id],
                "tracked_failed_ids": [],
                "tracked_unavailable_ids": [],
                "tracked_recovered_ids": [missing_id],
                "queries_total": 1,
                "queries_ok": 1,
                "queries_raw": 1,
                "queries_enriched": 1,
                "fresh": [
                    {"vid": public_id, "views": 103, "pub": 1700000000000},
                    {"vid": missing_id, "views": 201, "pub": 1700000000000},
                ],
                "owned_fresh": [],
                "candidates": [],
            }
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(recovery_artifact), encoding="utf-8"
            )
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            recovery_metrics = radar.read_snapshot(snapshot)["videoMetrics"]
            self.assertFalse(recovery_metrics["partial"])
            self.assertEqual(recovery_metrics["tracked"], 2)
            self.assertEqual(recovery_metrics["updated"], 2)
            self.assertEqual(recovery_metrics["unavailable_ids"], [])
            recovery_history = json.loads(
                (root / "video_history" / "7a.json").read_text(encoding="utf-8")
            )
            self.assertEqual(recovery_history["d"][missing_id][-1], [third, 201])

    def test_fallback_single_miss_then_success_never_quarantines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            public_id, intermittent_id = "abcdefghijk", "zyxwvutsrqp"
            radar.write_snapshot(snapshot, {
                "d": {
                    "all": [
                        {"vid": public_id, "pub": 1700000000000},
                        {"vid": intermittent_id, "pub": 1700000000000},
                    ],
                    "trends": [], "news": [], "ours": [], "recos": [], "roadmap": [],
                }
            })

            def write_artifact(generated, fresh, failed):
                ids = [public_id, intermittent_id]
                artifact = {
                    "version": 1, "generated_ms": generated, "shard": 0, "shards": 1,
                    "tracked_total": 2, "tracked_ok": len(fresh), "tracked_ids": ids,
                    "tracked_fresh_ids": [row["vid"] for row in fresh],
                    "tracked_failed_ids": failed, "tracked_unavailable_ids": [],
                    "tracked_recovered_ids": [], "queries_total": 1, "queries_ok": 1,
                    "queries_raw": 1, "queries_enriched": 1, "fresh": fresh,
                    "owned_fresh": [], "candidates": [],
                }
                (shards / "youtube-shard-0.json").write_text(
                    json.dumps(artifact), encoding="utf-8"
                )

            first = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            write_artifact(first, [{"vid": public_id, "views": 100, "pub": 1700000000000}], [intermittent_id])
            with patch.object(radar, "MIN_PUBLISH_TRACK_RATIO", 0.0):
                radar.merge_artifacts(snapshot, avatars, shards, 1)
            self.assertEqual(
                radar.read_snapshot(snapshot)["videoMetrics"]["missing_ids"],
                [intermittent_id],
            )

            second = first + 3600000
            write_artifact(second, [
                {"vid": public_id, "views": 101, "pub": 1700000000000},
                {"vid": intermittent_id, "views": 201, "pub": 1700000000000},
            ], [])
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            metrics = radar.read_snapshot(snapshot)["videoMetrics"]
            self.assertFalse(metrics["partial"])
            self.assertEqual(metrics["tracked"], 2)
            self.assertEqual(metrics["updated"], 2)
            self.assertEqual(metrics["missing_ids"], [])
            self.assertEqual(metrics["unavailable_ids"], [])

    def test_avatar_overlay_links_handle_to_channel_id_without_overwriting_atlas(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "avatars.js"
            count = radar.write_avatar_overlay(
                {
                    "d": {
                        "all": [{
                            "chUrl": "https://www.youtube.com/@FocusChannel",
                            "channelId": "UC1234567890123456789012",
                        }],
                        "trends": [],
                        "news": [],
                    }
                },
                output,
            )
            rendered = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn('"@FocusChannel":"UC1234567890123456789012"', rendered)
        self.assertIn("if(!atlas.channels[key])", rendered)

    def test_recent_search_uses_month_filter_and_enriches_results(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)

        class FlatSearch:
            url = None

            def extract_info(self, url, download=False):
                self.url = url
                return {"entries": [{"id": "abcdefghijk"}]}

        class FullVideo:
            def extract_info(self, url, download=False):
                return {
                    "id": "abcdefghijk",
                    "title": "Long focus mix",
                    "view_count": 20_000,
                    "duration": 3600,
                    "upload_date": "20260719",
                    "channel": "Focus Channel",
                }

        flat = FlatSearch()
        with patch.object(radar, "search_ydl", return_value=flat), patch.object(
            radar, "ydl", return_value=FullVideo()
        ):
            rows, raw, enriched = radar.fetch_search(
                {"query": "focus music", "genre": "Ambient", "cluster": "Focus"}, now
            )
        self.assertIn("sp=EgIIBA%3D%3D", flat.url)
        self.assertEqual((raw, enriched, len(rows)), (1, 1, 1))
        self.assertEqual(rows[0]["rank"], 1)
        self.assertEqual(rows[0]["added"], now)

    def test_news_view_floor_is_100k_and_prunes_legacy_rows(self):
        data = {
            "news": [
                {"vid": "abcdefghijk", "views": 99_999},
                {"vid": "zyxwvutsrqp", "views": 100_000},
                {"vid": "mnopqrstuvw", "views": 250_000},
            ]
        }
        removed = radar.prune_news_below_view_floor(data)
        self.assertEqual(radar.MIN_NEWS_VIEWS, 100_000)
        self.assertEqual(removed, 1)
        self.assertEqual(
            [row["vid"] for row in data["news"]],
            ["zyxwvutsrqp", "mnopqrstuvw"],
        )

    def test_merge_rejects_99999_views_and_accepts_100000(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(
                datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000
            )
            radar.write_snapshot(
                snapshot,
                {
                    "t": 1,
                    "d": {
                        "all": [{"vid": "abcdefghijk", "views": 1_000_000, "pub": 1700000000000}],
                        "trends": [],
                        "news": [],
                        "ours": [],
                        "recos": [],
                        "roadmap": [],
                    },
                },
            )
            artifact = {
                "version": 1,
                "generated_ms": generated,
                "shard": 0,
                "shards": 1,
                "tracked_total": 1,
                "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"],
                "tracked_fresh_ids": ["abcdefghijk"],
                "queries_total": 1,
                "queries_ok": 1,
                "queries_raw": 2,
                "queries_enriched": 2,
                "fresh": [{"vid": "abcdefghijk", "views": 1_000_001, "pub": 1700000000000}],
                "candidates": [
                    {
                        "vid": "zyxwvutsrqp",
                        "title": "Below floor",
                        "views": 99_999,
                        "ageM": 1,
                        "vpm": 99_999,
                        "kw": "focus music",
                    },
                    {
                        "vid": "mnopqrstuvw",
                        "title": "At floor",
                        "views": 100_000,
                        "ageM": 1,
                        "vpm": 100_000,
                        "kw": "focus music",
                    },
                ],
            }
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
        self.assertEqual(
            [row["vid"] for row in merged["d"]["news"]],
            ["mnopqrstuvw"],
        )

    def test_watchdog_requires_today_history_and_publish_thresholds(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "snapshot.js"
            stamp = int(datetime(2026, 7, 28, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {
                "videoMetricsT": stamp,
                "videoMetrics": {
                    "tracked": 1000,
                    "updated": 1000,
                    "keywords": 100,
                    "keywords_ok": 100,
                    "history_updated": 1000,
                    "card_rows_expected": 1000,
                    "card_rows_updated": 1000,
                    "sheet_ours_expected": 83,
                    "sheet_ours_updated": 83,
                    "analysis_rows_expected": 83,
                    "analysis_rows_updated": 83,
                    "history_day": "2026-07-28",
                    "day_timezone": "Europe/Paris",
                    "partial": False,
                },
                "d": {},
            })
            healthy = radar.snapshot_freshness(snapshot, stamp + 3600000)
            stale = radar.snapshot_freshness(snapshot, stamp + 24 * 3600000)
            partial_payload = radar.read_snapshot(snapshot)
            partial_payload["videoMetrics"].update({"updated": 999, "history_updated": 999, "partial": True})
            radar.write_snapshot(snapshot, partial_payload)
            partial = radar.snapshot_freshness(snapshot, stamp + 3600000)
        self.assertTrue(healthy["fresh"])
        self.assertFalse(stale["fresh"])
        self.assertFalse(partial["fresh"])

    def test_pages_verifier_requires_both_snapshot_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            history_dir = root / "video_history"
            history_dir.mkdir()
            stamp = int(datetime(2026, 7, 28, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {
                "videoMetricsT": stamp,
                "videoMetrics": {
                    "history_updated": 2,
                    "card_rows_expected": 2,
                    "card_rows_updated": 2,
                    "sheet_ours_expected": 1,
                    "sheet_ours_updated": 1,
                    "analysis_rows_expected": 1,
                    "analysis_rows_updated": 1,
                },
                "d": {},
            })
            pool = root / "Lofi_Radar_recommendation_pool.js"
            pool.write_text(
                radar.POOL_PREFIX + json.dumps({"sourceT": stamp, "items": [{}] * 1001}) + ";\n",
                encoding="utf-8",
            )
            (history_dir / "61.json").write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"abcdefghijk": [[stamp, 100]]}}),
                encoding="utf-8",
            )
            (history_dir / "62.json").write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"lmnopqrstuv": [[stamp, 200]]}}),
                encoding="utf-8",
            )

            class Response(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    self.close()

            responses = iter([
                Response(snapshot.read_bytes()),
                Response(pool.read_bytes()),
                Response((history_dir / "61.json").read_bytes()),
                Response((history_dir / "62.json").read_bytes()),
            ])
            with patch.object(radar.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: next(responses)):
                result = radar.verify_publication(
                    "https://example.test/radar/",
                    snapshot,
                    history_dir,
                    timeout_seconds=1,
                    interval_seconds=1,
                )
        self.assertTrue(result["published"])
        self.assertEqual(result["recommendations"], 1001)
        self.assertEqual(result["snapshot"], stamp)
        self.assertEqual(result["history_min"], stamp)
        self.assertEqual(result["history_shards"], 2)
        self.assertEqual(result["history_points"], 2)

    def test_core_pages_verifier_does_not_depend_on_recommendation_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            history_dir = root / "video_history"
            history_dir.mkdir()
            stamp = int(datetime(2026, 8, 4, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {
                "videoMetricsT": stamp,
                "videoMetrics": {
                    "history_updated": 1,
                    "card_rows_expected": 1,
                    "card_rows_updated": 1,
                    "sheet_ours_expected": 1,
                    "sheet_ours_updated": 1,
                    "analysis_rows_expected": 1,
                    "analysis_rows_updated": 1,
                },
                "d": {},
            })
            shard = history_dir / "61.json"
            shard.write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"abcdefghijk": [[stamp, 100]]}}),
                encoding="utf-8",
            )

            class Response(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    self.close()

            responses = iter([Response(snapshot.read_bytes()), Response(shard.read_bytes())])
            with patch.object(
                radar.urllib.request,
                "urlopen",
                side_effect=lambda *args, **kwargs: next(responses),
            ):
                result = radar.verify_publication(
                    "https://example.test/radar/",
                    snapshot,
                    history_dir,
                    timeout_seconds=1,
                    interval_seconds=1,
                    require_recommendation_pool=False,
                )
        self.assertTrue(result["published"])
        self.assertIsNone(result["recommendations"])
        self.assertEqual(result["snapshot"], stamp)
        self.assertEqual(result["history_min"], stamp)

    def test_pages_verifier_rejects_fresh_shard_metadata_with_missing_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            history_dir = root / "video_history"
            history_dir.mkdir()
            stamp = int(datetime(2026, 8, 4, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {
                "videoMetricsT": stamp,
                "videoMetrics": {
                    "history_updated": 1,
                    "card_rows_expected": 1,
                    "card_rows_updated": 1,
                    "sheet_ours_expected": 1,
                    "sheet_ours_updated": 1,
                    "analysis_rows_expected": 1,
                    "analysis_rows_updated": 1,
                },
                "d": {},
            })
            shard = history_dir / "61.json"
            shard.write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"abcdefghijk": [[stamp, 100]]}}),
                encoding="utf-8",
            )
            remote_shard = json.dumps({"version": 1, "updated": stamp, "d": {}}).encode()

            class Response(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    self.close()

            responses = iter([Response(snapshot.read_bytes()), Response(remote_shard)])
            with patch.object(
                radar.urllib.request,
                "urlopen",
                side_effect=lambda *args, **kwargs: next(responses),
            ), patch.object(radar.time, "monotonic", side_effect=[0, 0, 2]), patch.object(
                radar.time, "sleep", return_value=None
            ):
                with self.assertRaisesRegex(RuntimeError, "stale history shards"):
                    radar.verify_publication(
                        "https://example.test/radar/",
                        snapshot,
                        history_dir,
                        timeout_seconds=1,
                        interval_seconds=1,
                        require_recommendation_pool=False,
                    )


class ScanScopeTests(unittest.TestCase):
    @staticmethod
    def _payload():
        return {
            "t": 111,
            "videoMetricsT": 222,
            "videoMetrics": {
                "tracked": 1,
                "updated": 1,
                "missing_ids": [],
                "unavailable_ids": [],
                "sentinel": {"keep": [1, 2, 3]},
            },
            "videoHistory": {"updated": 222, "sentinel": "keep"},
            "d": {
                "all": [{
                    "vid": "abcdefghijk",
                    "title": "Focus music",
                    "views": 100_000,
                    "pub": 1_700_000_000_000,
                    "kw": "focus music",
                    "genre": "Lofi / chillhop",
                    "cluster": "Study / focus / work",
                }],
                "trends": [{"vid": "abcdefghijk", "sentinel": "trend"}],
                "news": [{"vid": "abcdefghijk", "sentinel": "news"}],
                "ours": [{"vid": "abcdefghijk", "sentinel": "ours"}],
                "recos": [{"id": "recommendation", "sentinel": ["keep"]}],
                "roadmap": [{"id": "roadmap", "sentinel": {"keep": True}}],
                "lives": [{"vid": "livevideo01", "sentinel": "live"}],
                "kids": [],
            },
            "sentinel": {"top_level": "keep"},
        }

    @staticmethod
    def _artifact(scope, generated, **overrides):
        artifact = {
            "version": 1,
            "scan_scope": scope,
            "generated_ms": generated,
            "shard": 0,
            "shards": 1,
            "tracked_total": 1,
            "tracked_ok": 1,
            "tracked_ids": ["abcdefghijk"],
            "tracked_fresh_ids": ["abcdefghijk"],
            "tracked_failed_ids": [],
            "tracked_unavailable_ids": [],
            "tracked_recovered_ids": [],
            "queries_total": 0,
            "queries_ok": 0,
            "queries_raw": 0,
            "queries_enriched": 0,
            "kids_queries_total": 0,
            "kids_queries_ok": 0,
            "kids_results_examined": 0,
            "kids_candidates_kept": 0,
            "owned_ok": True,
            "owned_fresh": [],
            "live_audiences": {},
            "fresh": [{
                "vid": "abcdefghijk",
                "title": "Fresh focus music",
                "views": 100_001,
                "pub": 1_700_000_000_000,
            }],
            "candidates": [],
        }
        artifact.update(overrides)
        return artifact

    def test_query_specs_reads_kids_metrics_for_top_50_daily_mode(self):
        payload = {
            "d": {"kids": []},
            "kidsMetrics": {"queries": len(radar.KIDS_QUERY_SPECS)},
            "videoMetrics": {"kids_queries": 0},
        }
        specs = [
            spec
            for spec in radar.query_specs(payload, include_kids=True)
            if spec.get("audience") == "kids"
        ]
        self.assertEqual(len(specs), len(radar.KIDS_QUERY_SPECS))
        self.assertTrue(all(spec["searchResults"] == 50 for spec in specs))

    def test_standard_shard_excludes_every_kids_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            output = root / "youtube-shard-0.json"
            manifest = root / "tracked.json"
            payload = self._payload()
            payload["d"]["kids"] = [{
                "vid": "kidsvideo01",
                "kw": "baby sleep music instrumental",
                "madeForKids": True,
            }]
            radar.write_snapshot(snapshot, payload)
            manifest.write_text(json.dumps({
                "version": 1,
                "scan_scope": "standard",
                "ids": ["abcdefghijk", "kidsvideo01"],
                "quarantine_ids": [],
            }), encoding="utf-8")
            seen_specs = []

            def discovery(spec, now_ms, api_key):
                seen_specs.append(dict(spec))
                return [], 1, 1

            with patch.dict(radar.os.environ, {"YOUTUBE_API_KEY": ""}), patch.object(
                radar,
                "fetch_one_video",
                side_effect=lambda video_id, now_ms: {
                    "vid": video_id,
                    "views": 100_001,
                    "pub": 1_700_000_000_000,
                },
            ), patch.object(
                radar, "fetch_owned_ydl_rows", return_value={}
            ), patch.object(
                radar, "fetch_discovery_spec", side_effect=discovery
            ), patch.object(
                radar, "kids_dom_validator"
            ) as validator, patch.object(
                radar, "fetch_kids_search"
            ) as kids_api, patch.object(
                radar, "fetch_kids_search_ydl"
            ) as kids_public, patch.object(
                radar, "sheet_video_ids"
            ) as sheet:
                artifact = radar.run_shard(
                    snapshot,
                    output,
                    0,
                    1,
                    manifest,
                    scan_scope="standard",
                )
                output_scope = json.loads(
                    output.read_text(encoding="utf-8")
                )["scan_scope"]

        self.assertEqual(artifact["scan_scope"], "standard")
        self.assertEqual(artifact["tracked_ids"], ["abcdefghijk", "kidsvideo01"])
        self.assertEqual(artifact["tracked_ok"], 2)
        self.assertEqual(artifact["kids_queries_total"], 0)
        self.assertTrue(seen_specs)
        self.assertTrue(
            all(spec.get("audience") == "youtube" for spec in seen_specs)
        )
        validator.assert_not_called()
        kids_api.assert_not_called()
        kids_public.assert_not_called()
        sheet.assert_not_called()
        self.assertEqual(output_scope, "standard")

    def test_standard_manifest_includes_existing_kids_without_kids_discovery(self):
        payload = self._payload()
        payload["d"]["kids"] = [{"vid": "kidsvideo01"}]
        with patch.object(radar, "sheet_video_ids", return_value=set()):
            ids = radar.tracked_ids(payload, "standard")
        self.assertEqual(ids, ["abcdefghijk", "kidsvideo01"])

    def test_kids_shard_runs_only_kids_specs_without_owned_live_or_sheet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            output = root / "youtube-shard-0.json"
            radar.write_snapshot(snapshot, self._payload())
            seen_specs = []

            def discovery(spec, now_ms, api_key):
                seen_specs.append(dict(spec))
                return [], 2, 1

            with patch.dict(
                radar.os.environ, {"YOUTUBE_API_KEY": "test-key"}
            ), patch.object(
                radar, "fetch_discovery_spec", side_effect=discovery
            ), patch.object(
                radar, "fetch_api_rows", return_value={}
            ) as api_rows, patch.object(
                radar, "fetch_owned_api_rows"
            ) as owned_api, patch.object(
                radar, "fetch_owned_ydl_rows"
            ) as owned_public, patch.object(
                radar, "kids_dom_validator"
            ) as validator, patch.object(
                radar, "sheet_video_ids"
            ) as sheet:
                artifact = radar.run_shard(
                    snapshot,
                    output,
                    0,
                    1,
                    scan_scope="kids",
                )
                output_scope = json.loads(
                    output.read_text(encoding="utf-8")
                )["scan_scope"]

        self.assertEqual(artifact["scan_scope"], "kids")
        self.assertEqual(artifact["tracked_total"], 0)
        self.assertEqual(
            artifact["queries_total"], len(radar.KIDS_QUERY_SPECS)
        )
        self.assertEqual(
            artifact["kids_queries_total"], len(radar.KIDS_QUERY_SPECS)
        )
        self.assertEqual(len(seen_specs), len(radar.KIDS_QUERY_SPECS))
        self.assertTrue(
            all(spec.get("audience") == "kids" for spec in seen_specs)
        )
        owned_api.assert_not_called()
        owned_public.assert_not_called()
        validator.assert_not_called()
        sheet.assert_not_called()
        api_rows.assert_called_once()
        self.assertEqual(api_rows.call_args.args[0], [])
        self.assertEqual(output_scope, "kids")

    def test_standard_merge_refreshes_preserved_kids_counters_and_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(
                datetime(2026, 8, 11, 8, tzinfo=timezone.utc).timestamp()
                * 1000
            )
            payload = self._payload()
            payload["kidsMetricsT"] = 987654321
            payload["kidsMetrics"] = {
                "queries": 40,
                "queries_ok": 40,
                "nested": {"preserve": [3, 2, 1]},
            }
            payload["d"]["kids"] = [{
                "vid": "kidsvideo01",
                "title": "Preserve this Kids cohort row",
                "views": 222_222,
                "pub": 1_700_000_000_000,
                "ageM": 10,
                "vpm": 22_222,
                "durH": 2,
                "madeForKids": True,
                "madeForKidsSource": "youtube_data_api_status",
                "custom": {"preserve": ["byte", "value"]},
            }]
            radar.write_snapshot(snapshot, payload)
            artifact = self._artifact(
                "standard",
                generated,
                tracked_total=2,
                tracked_ok=2,
                tracked_ids=["abcdefghijk", "kidsvideo01"],
                tracked_fresh_ids=["abcdefghijk", "kidsvideo01"],
                fresh=[
                    {
                        "vid": "abcdefghijk",
                        "title": "Fresh focus music",
                        "views": 100_001,
                        "pub": 1_700_000_000_000,
                    },
                    {
                        "vid": "kidsvideo01",
                        "title": "Fresh official Kids title",
                        "views": 333_333,
                        "pub": 1_700_000_000_000,
                        "metadataSource": radar.METADATA_SOURCE_API,
                        "pubSource": radar.METADATA_SOURCE_API,
                        "madeForKids": True,
                        "madeForKidsSource": "youtube_data_api_status",
                    },
                ],
            )
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact),
                encoding="utf-8",
            )

            radar.merge_artifacts(
                snapshot,
                avatars,
                shards,
                1,
                generate_recommendations=False,
                scan_scope="standard",
            )
            after = radar.read_snapshot(snapshot)

        self.assertEqual([row["vid"] for row in after["d"]["kids"]], ["kidsvideo01"])
        self.assertEqual(after["d"]["kids"][0]["views"], 333_333)
        self.assertEqual(after["d"]["kids"][0]["title"], "Fresh official Kids title")
        self.assertEqual(
            after["d"]["kids"][0]["custom"],
            {"preserve": ["byte", "value"]},
        )
        self.assertEqual(after["kidsMetricsT"], generated)
        self.assertEqual(after["kidsMetrics"]["queries"], 40)
        self.assertEqual(after["kidsMetrics"]["nested"], {"preserve": [3, 2, 1]})
        self.assertEqual(after["kidsMetrics"]["tracked"], 1)
        self.assertEqual(after["kidsMetrics"]["updated"], 1)
        self.assertEqual(after["kidsMetrics"]["history_updated"], 1)
        self.assertFalse(after["kidsMetrics"]["partial"])
        self.assertEqual(after["videoMetrics"]["card_rows_expected"], after["videoMetrics"]["card_rows_updated"])

    def test_kids_bootstrap_changes_only_dedicated_state_avatar_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            history = root / "history"
            shards.mkdir()
            generated = int(
                datetime(2026, 8, 11, 8, tzinfo=timezone.utc).timestamp()
                * 1000
            )
            radar.write_snapshot(snapshot, self._payload())
            before = radar.read_snapshot(snapshot)
            candidate = {
                "vid": "kidsvideo01",
                "title": "Baby sleep music instrumental - 2 hours",
                "views": 250_000,
                "pub": generated - 30 * 86400000,
                "ageM": 1,
                "vpm": 250_000,
                "durH": 2,
                "channel": "Calm Baby",
                "chUrl": (
                    "https://www.youtube.com/channel/"
                    "UC1234567890123456789012"
                ),
                "channelId": "UC1234567890123456789012",
                "genre": "Baby sleep",
                "cluster": "Relaxation / meditation",
                "kw": "baby sleep music instrumental",
                "audiences": ["kids"],
                "madeForKids": True,
                "madeForKidsSource": (
                    "youtube_innertube_android_player_restrictions"
                ),
                "instrumentalVerified": True,
                "liveStatus": "none",
            }
            artifact = self._artifact(
                "kids",
                generated,
                tracked_total=0,
                tracked_ok=0,
                tracked_ids=[],
                tracked_fresh_ids=[],
                fresh=[candidate],
                queries_total=len(radar.KIDS_QUERY_SPECS),
                queries_ok=len(radar.KIDS_QUERY_SPECS),
                queries_raw=4000,
                queries_enriched=1800,
                kids_queries_total=len(radar.KIDS_QUERY_SPECS),
                kids_queries_ok=len(radar.KIDS_QUERY_SPECS),
                kids_results_examined=4000,
                kids_candidates_kept=1,
                candidates=[candidate],
            )
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )

            summary = radar.merge_artifacts(
                snapshot,
                avatars,
                shards,
                1,
                history_dir=history,
                generate_recommendations=False,
                require_kids=True,
                scan_scope="kids",
            )
            after = radar.read_snapshot(snapshot)
            history_payload = json.loads(
                (
                    history
                    / radar.history_shard_name(candidate["vid"])
                ).read_text(encoding="utf-8")
            )
            avatar_text = avatars.read_text(encoding="utf-8")

        for key in before:
            if key != "d":
                self.assertEqual(after[key], before[key], key)
        for bucket, rows in before["d"].items():
            if bucket != "kids":
                self.assertEqual(after["d"][bucket], rows, bucket)

        self.assertEqual(
            [row["vid"] for row in after["d"]["kids"]],
            [candidate["vid"]],
        )
        self.assertEqual(after["kidsMetricsT"], generated)
        self.assertEqual(
            after["kidsMetrics"]["queries"],
            len(radar.KIDS_QUERY_SPECS),
        )
        self.assertEqual(after["kidsMetrics"]["candidates_kept"], 1)
        self.assertEqual(summary["kids_added"], 1)
        self.assertEqual(
            history_payload["d"][candidate["vid"]],
            [[generated, 250_000]],
        )
        self.assertIn(candidate["channelId"], avatar_text)

    def test_scope_only_history_preserves_out_of_scope_series_same_shard(self):
        with tempfile.TemporaryDirectory() as tmp:
            history = Path(tmp)
            in_scope = "abcdefghijk"
            out_of_scope = "a1234567890"
            old = int(
                datetime(2026, 8, 9, 8, tzinfo=timezone.utc).timestamp()
                * 1000
            )
            now = int(
                datetime(2026, 8, 11, 8, tzinfo=timezone.utc).timestamp()
                * 1000
            )
            outside_points = [
                [old + 3000, 9],
                [old, 7],
                [old, 7],
            ]
            path = history / radar.history_shard_name(in_scope)
            self.assertEqual(
                path.name,
                radar.history_shard_name(out_of_scope),
            )
            path.write_text(json.dumps({
                "version": 1,
                "updated": old,
                "d": {
                    in_scope: [[old, 100]],
                    out_of_scope: outside_points,
                },
            }), encoding="utf-8")

            radar.update_history_shards(
                history,
                {in_scope},
                {in_scope: {"views": 150}},
                {},
                now,
                scope_only=True,
            )
            updated = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(updated["d"][out_of_scope], outside_points)
        self.assertEqual(updated["d"][in_scope][-1], [now, 150])

    def test_merge_rejects_scope_mismatch_and_duplicate_shards(self):
        generated = int(
            datetime(2026, 8, 11, 8, tzinfo=timezone.utc).timestamp()
            * 1000
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, self._payload())
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(self._artifact("kids", generated)),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                RuntimeError, "Artifact scope mismatch"
            ):
                radar.merge_artifacts(
                    snapshot,
                    avatars,
                    shards,
                    1,
                    generate_recommendations=False,
                    scan_scope="standard",
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, self._payload())
            duplicate = self._artifact(
                "standard", generated, shard=0, shards=2
            )
            for suffix in ("a", "b"):
                (shards / f"youtube-shard-{suffix}.json").write_text(
                    json.dumps(duplicate), encoding="utf-8"
                )
            with self.assertRaisesRegex(
                RuntimeError, "Duplicate shard artifacts"
            ):
                radar.merge_artifacts(
                    snapshot,
                    avatars,
                    shards,
                    2,
                    generate_recommendations=False,
                    scan_scope="standard",
                )



if __name__ == "__main__":
    unittest.main()
