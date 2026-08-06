import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import trigger_pages_deployment as pages


class FakeResponse:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status


class TriggerPagesDeploymentTests(unittest.TestCase):
    def test_dispatch_targets_the_dedicated_workflow_with_exact_sha(self):
        sha = "a" * 40
        with mock.patch.object(
            pages.urllib.request, "urlopen", return_value=FakeResponse()
        ) as opener:
            pages.dispatch_pages(
                repository="dim75017/youtube-radar-kx9v2m",
                sha=sha,
                token="test-token",
                sleep=lambda _delay: None,
            )

        request = opener.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://api.github.com/repos/dim75017/youtube-radar-kx9v2m/"
            "actions/workflows/deploy-pages.yml/dispatches",
        )
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            json.loads(request.data),
            {"ref": "main", "inputs": {"requested_sha": sha}},
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_transient_failures_retry_but_non_transient_errors_fail_closed(self):
        transient = urllib.error.HTTPError(
            "https://api.github.com", 503, "busy", {}, io.BytesIO(b"busy")
        )
        with mock.patch.object(
            pages.urllib.request,
            "urlopen",
            side_effect=[transient, FakeResponse()],
        ) as opener:
            pages.dispatch_pages(
                repository="owner/repo",
                sha="b" * 40,
                token="token",
                sleep=lambda _delay: None,
            )
        self.assertEqual(opener.call_count, 2)

        rejected = urllib.error.HTTPError(
            "https://api.github.com", 403, "forbidden", {}, io.BytesIO(b"denied")
        )
        with mock.patch.object(
            pages.urllib.request, "urlopen", side_effect=rejected
        ) as opener:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                pages.dispatch_pages(
                    repository="owner/repo",
                    sha="c" * 40,
                    token="token",
                    sleep=lambda _delay: None,
                )
        self.assertEqual(opener.call_count, 1)

    def test_inputs_and_credentials_fail_closed(self):
        bad = (
            {"repository": "owner", "sha": "d" * 40, "token": "token"},
            {"repository": "owner/repo", "sha": "HEAD", "token": "token"},
            {"repository": "owner/repo", "sha": "d" * 40, "token": ""},
        )
        for kwargs in bad:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    pages.dispatch_pages(**kwargs)

    def test_cli_uses_actions_token_without_exposing_it(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "secret"}, clear=True):
            with mock.patch.object(pages, "dispatch_pages") as dispatch:
                result = pages.main(
                    ["--repository", "owner/repo", "--sha", "e" * 40]
                )
        self.assertEqual(result, 0)
        self.assertEqual(dispatch.call_args.kwargs["token"], "secret")


if __name__ == "__main__":
    unittest.main()
