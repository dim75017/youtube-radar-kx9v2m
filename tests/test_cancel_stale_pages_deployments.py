import io
import json
import unittest
import urllib.error
from unittest import mock

import cancel_stale_pages_deployments as module


SHA_ACTIVE = "1" * 40
SHA_DONE = "2" * 40
SHA_CURRENT = "3" * 40


class Response:
    def __init__(self, status, payload=b""):
        self.status = status
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def read(self):
        return self.payload


def payload(value):
    return json.dumps(value).encode("utf-8")


class CancelStalePagesDeploymentsTests(unittest.TestCase):
    def test_cancels_only_explicitly_active_main_deployment(self):
        responses = [
            Response(200, payload([{"sha": SHA_DONE}, {"sha": SHA_ACTIVE}])),
            Response(200, payload({"status": "succeed"})),
            Response(200, payload({"status": "deployment_queued"})),
            Response(204),
            Response(200, payload({"status": "deployment_cancelled"})),
        ]
        opener = mock.Mock(side_effect=responses)

        result = module.cancel_stale_pages_deployment(
            repository="dim75017/youtube-radar-kx9v2m",
            token="token",
            opener=opener,
            sleep=mock.Mock(),
        )

        self.assertEqual(result, SHA_ACTIVE)
        request = opener.call_args_list[3].args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertTrue(request.full_url.endswith(f"/{SHA_ACTIVE}/cancel"))

    def test_does_not_mutate_terminal_or_missing_deployments(self):
        missing = urllib.error.HTTPError(
            "url", 404, "not found", {}, io.BytesIO(b"{}")
        )
        opener = mock.Mock(
            side_effect=[
                Response(200, payload([{"sha": SHA_DONE}, {"sha": SHA_ACTIVE}])),
                Response(200, payload({"status": "failed"})),
                missing,
            ]
        )

        result = module.cancel_stale_pages_deployment(
            repository="dim75017/youtube-radar-kx9v2m",
            token="token",
            opener=opener,
        )

        self.assertIsNone(result)
        self.assertTrue(all(call.args[0].get_method() == "GET" for call in opener.call_args_list))

    def test_purging_cdn_is_a_non_cancellable_terminal_transition(self):
        opener = mock.Mock(
            side_effect=[
                Response(200, payload([{"sha": SHA_ACTIVE}])),
                Response(200, payload({"status": "purging_cdn"})),
            ]
        )

        result = module.cancel_stale_pages_deployment(
            repository="dim75017/youtube-radar-kx9v2m",
            token="token",
            opener=opener,
        )

        self.assertIsNone(result)
        self.assertTrue(
            all(call.args[0].get_method() == "GET" for call in opener.call_args_list)
        )

    def test_unknown_state_fails_closed_without_post(self):
        opener = mock.Mock(
            side_effect=[
                Response(200, payload([{"sha": SHA_ACTIVE}])),
                Response(200, payload({"status": "mystery"})),
            ]
        )

        with self.assertRaisesRegex(RuntimeError, "unknown status"):
            module.cancel_stale_pages_deployment(
                repository="dim75017/youtube-radar-kx9v2m",
                token="token",
                opener=opener,
            )
        self.assertTrue(all(call.args[0].get_method() == "GET" for call in opener.call_args_list))

    def test_empty_environment_stub_is_skipped_before_active_pages_deployment(self):
        responses = [
            Response(200, payload([{"sha": SHA_DONE}, {"sha": SHA_ACTIVE}])),
            Response(200, payload({"status": ""})),
            Response(200, payload({"status": "queued"})),
            Response(204),
            Response(200, payload({"status": "deployment_cancelled"})),
        ]
        opener = mock.Mock(side_effect=responses)

        result = module.cancel_stale_pages_deployment(
            repository="dim75017/youtube-radar-kx9v2m",
            token="token",
            opener=opener,
            sleep=mock.Mock(),
        )

        self.assertEqual(result, SHA_ACTIVE)
        posted = [
            call.args[0].full_url
            for call in opener.call_args_list
            if call.args[0].get_method() == "POST"
        ]
        self.assertEqual(posted, [f"https://api.github.com/repos/dim75017/youtube-radar-kx9v2m/pages/deployments/{SHA_ACTIVE}/cancel"])

    def test_current_run_deployment_is_excluded_before_inspecting_orphans(self):
        responses = [
            Response(
                200,
                payload(
                    [
                        {"sha": SHA_CURRENT},
                        {"sha": SHA_DONE},
                        {"sha": SHA_ACTIVE},
                    ]
                ),
            ),
            Response(200, payload({"status": "succeed"})),
            Response(200, payload({"status": "in_progress"})),
            Response(204),
            Response(200, payload({"status": "deployment_cancelled"})),
        ]
        opener = mock.Mock(side_effect=responses)

        result = module.cancel_stale_pages_deployment(
            repository="dim75017/youtube-radar-kx9v2m",
            token="token",
            exclude_sha=SHA_CURRENT,
            opener=opener,
            sleep=mock.Mock(),
        )

        self.assertEqual(result, SHA_ACTIVE)
        inspected_urls = [call.args[0].full_url for call in opener.call_args_list]
        self.assertFalse(any(SHA_CURRENT in url for url in inspected_urls))

    def test_invalid_repository_and_missing_token_are_rejected(self):
        with self.assertRaises(ValueError):
            module.cancel_stale_pages_deployment(repository="../bad", token="token")
        with self.assertRaises(ValueError):
            module.cancel_stale_pages_deployment(
                repository="dim75017/youtube-radar-kx9v2m", token=""
            )
        with self.assertRaises(ValueError):
            module.cancel_stale_pages_deployment(
                repository="dim75017/youtube-radar-kx9v2m",
                token="token",
                exclude_sha="not-a-sha",
            )


if __name__ == "__main__":
    unittest.main()
