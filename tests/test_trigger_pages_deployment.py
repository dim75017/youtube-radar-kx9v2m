import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import trigger_pages_deployment as pages


class FakeResponse:
    def __init__(self, payload=None, status=204):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def read(self, *_args):
        if self.payload is None:
            return b""
        return json.dumps(self.payload).encode("utf-8")


class TriggerPagesDeploymentTests(unittest.TestCase):
    def test_dispatch_targets_the_dedicated_workflow_with_exact_sha(self):
        sha = "a" * 40
        with mock.patch.object(
            pages.urllib.request,
            "urlopen",
            side_effect=[
                FakeResponse({"object": {"sha": sha}}, 200),
                FakeResponse({"workflow_run_id": 101}, 200),
            ],
        ) as opener:
            run_id = pages.dispatch_pages(
                repository="dim75017/youtube-radar-kx9v2m",
                sha=sha,
                token="test-token",
                sleep=lambda _delay: None,
            )

        self.assertEqual(run_id, 101)
        request = opener.call_args_list[1].args[0]
        self.assertEqual(
            request.full_url,
            "https://api.github.com/repos/dim75017/youtube-radar-kx9v2m/"
            "actions/workflows/deploy-pages.yml/dispatches",
        )
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            json.loads(request.data),
            {
                "ref": "main",
                "return_run_details": True,
                "inputs": {"requested_sha": sha, "retry_attempt": "0"},
            },
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_dispatch_carries_the_bounded_recovery_attempt(self):
        with mock.patch.object(
            pages.urllib.request,
            "urlopen",
            side_effect=[
                FakeResponse({"object": {"sha": "f" * 40}}, 200),
                FakeResponse({"workflow_run_id": 102}, 200),
            ],
        ) as opener:
            pages.dispatch_pages(
                repository="owner/repo",
                sha="f" * 40,
                token="token",
                retry_attempt=2,
                sleep=lambda _delay: None,
            )

        self.assertEqual(
            json.loads(opener.call_args_list[1].args[0].data)["inputs"]["retry_attempt"],
            "2",
        )

    def test_transient_failures_retry_but_non_transient_errors_fail_closed(self):
        transient = urllib.error.HTTPError(
            "https://api.github.com", 503, "busy", {}, io.BytesIO(b"busy")
        )
        with mock.patch.object(
            pages.urllib.request,
            "urlopen",
            side_effect=[
                FakeResponse({"object": {"sha": "b" * 40}}, 200),
                transient,
                FakeResponse({"workflow_run_id": 103}, 200),
            ],
        ) as opener:
            pages.dispatch_pages(
                repository="owner/repo",
                sha="b" * 40,
                token="token",
                sleep=lambda _delay: None,
            )
        self.assertEqual(opener.call_count, 3)

        rejected = urllib.error.HTTPError(
            "https://api.github.com", 403, "forbidden", {}, io.BytesIO(b"denied")
        )
        with mock.patch.object(
            pages.urllib.request,
            "urlopen",
            side_effect=[
                FakeResponse({"object": {"sha": "c" * 40}}, 200),
                rejected,
            ],
        ) as opener:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                pages.dispatch_pages(
                    repository="owner/repo",
                    sha="c" * 40,
                    token="token",
                    sleep=lambda _delay: None,
                )
        self.assertEqual(opener.call_count, 2)

    def test_ref_must_reach_the_requested_sha_before_dispatch(self):
        sha = "1" * 40
        with mock.patch.object(
            pages,
            "_request_json",
            side_effect=[
                {"object": {"sha": "0" * 40}},
                {"object": {"sha": sha}},
            ],
        ) as request_json:
            pages.wait_for_ref_sha(
                repository="owner/repo",
                ref="main",
                sha=sha,
                token="token",
                timeout=10,
                interval=0,
                sleep=lambda _delay: None,
            )
        self.assertEqual(request_json.call_count, 2)

    def test_ref_timeout_fails_before_dispatching_the_wrong_revision(self):
        sha = "4" * 40
        clock = iter((0.0, 0.0, 2.0))
        with mock.patch.object(
            pages,
            "_request_json",
            return_value={"object": {"sha": "5" * 40}},
        ):
            with self.assertRaisesRegex(RuntimeError, "did not resolve requested Pages SHA"):
                pages.wait_for_ref_sha(
                    repository="owner/repo",
                    ref="main",
                    sha=sha,
                    token="token",
                    timeout=1,
                    interval=0,
                    sleep=lambda _delay: None,
                    monotonic=lambda: next(clock),
                )

    def test_wait_for_exact_pages_run_requires_success(self):
        sha = "2" * 40
        with mock.patch.object(
            pages,
            "_request_json",
            side_effect=[
                {"id": 123, "head_sha": sha, "status": "in_progress"},
                {"id": 123, "head_sha": sha, "status": "completed", "conclusion": "success"},
            ],
        ):
            run_id = pages.wait_for_pages_run(
                repository="owner/repo",
                run_id=123,
                sha=sha,
                token="token",
                timeout=10,
                interval=0,
                sleep=lambda _delay: None,
            )
        self.assertEqual(run_id, 123)

    def test_exact_pages_run_failure_is_not_reported_as_success(self):
        sha = "6" * 40
        with mock.patch.object(
            pages,
            "_request_json",
            return_value={
                "id": 789,
                "head_sha": sha,
                "status": "completed",
                "conclusion": "failure",
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "run 789 completed with failure"):
                pages.wait_for_pages_run(
                    repository="owner/repo",
                    run_id=789,
                    sha=sha,
                    token="token",
                    timeout=10,
                    interval=0,
                    sleep=lambda _delay: None,
                )

    def test_exact_pages_run_rejects_a_different_sha(self):
        with mock.patch.object(
            pages,
            "_request_json",
            return_value={
                "id": 790,
                "head_sha": "7" * 40,
                "status": "in_progress",
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "run identity diverged"):
                pages.wait_for_pages_run(
                    repository="owner/repo",
                    run_id=790,
                    sha="8" * 40,
                    token="token",
                    timeout=10,
                    interval=0,
                    sleep=lambda _delay: None,
                )

    def test_dispatch_requires_the_returned_run_id(self):
        with mock.patch.object(pages, "wait_for_ref_sha"):
            with mock.patch.object(
                pages.urllib.request,
                "urlopen",
                return_value=FakeResponse({}, 200),
            ):
                with self.assertRaisesRegex(RuntimeError, "returned no workflow run ID"):
                    pages.dispatch_pages(
                        repository="owner/repo",
                        sha="9" * 40,
                        token="token",
                    )

    def test_dispatch_can_wait_for_the_exact_pages_run(self):
        with mock.patch.object(pages, "wait_for_ref_sha") as wait_ref:
            with mock.patch.object(pages, "wait_for_pages_run", return_value=456) as wait_run:
                with mock.patch.object(
                    pages.urllib.request,
                    "urlopen",
                    return_value=FakeResponse({"workflow_run_id": 456}, 200),
                ):
                    result = pages.dispatch_pages(
                        repository="owner/repo",
                        sha="3" * 40,
                        token="token",
                        wait_for_completion=True,
                    )
        self.assertEqual(result, 456)
        wait_ref.assert_called_once()
        self.assertEqual(wait_run.call_args.kwargs["sha"], "3" * 40)
        self.assertEqual(wait_run.call_args.kwargs["run_id"], 456)

    def test_inputs_and_credentials_fail_closed(self):
        bad = (
            {"repository": "owner", "sha": "d" * 40, "token": "token"},
            {"repository": "owner/repo", "sha": "HEAD", "token": "token"},
            {"repository": "owner/repo", "sha": "d" * 40, "token": ""},
            {
                "repository": "owner/repo",
                "sha": "d" * 40,
                "token": "token",
                "retry_attempt": 4,
            },
        )
        for kwargs in bad:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    pages.dispatch_pages(**kwargs)

    def test_cli_uses_actions_token_without_exposing_it(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "secret"}, clear=True):
            with mock.patch.object(pages, "dispatch_pages", return_value=321) as dispatch:
                result = pages.main(
                    ["--repository", "owner/repo", "--sha", "e" * 40]
                )
        self.assertEqual(result, 0)
        self.assertEqual(dispatch.call_args.kwargs["token"], "secret")


if __name__ == "__main__":
    unittest.main()
