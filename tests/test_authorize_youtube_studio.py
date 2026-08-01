import contextlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

import authorize_youtube_studio as oauth


CLIENT_ID = "test-client.apps.googleusercontent.com"
CLIENT_SECRET = "unit-test-client-secret"
ACCESS_TOKEN = "unit-test-access-token"
REFRESH_TOKEN = "unit-test-refresh-token"


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.payload


class AuthorizeYoutubeStudioTests(unittest.TestCase):
    def make_client_file(self, directory: Path, *, shape="installed") -> Path:
        path = directory / "desktop-client.json"
        path.write_text(
            json.dumps(
                {
                    shape: {
                        "client_id": CLIENT_ID,
                        "client_secret": CLIENT_SECRET,
                        "auth_uri": oauth.AUTHORIZATION_ENDPOINT,
                        "token_uri": oauth.TOKEN_ENDPOINT,
                        "redirect_uris": ["http://localhost"],
                    }
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_authorization_url_has_only_the_readonly_scope_and_offline_consent(self):
        client = oauth.DesktopOAuthClient(CLIENT_ID, CLIENT_SECRET)
        url = oauth.build_authorization_url(client, "http://127.0.0.1:54321/oauth2/callback", "safe-state")
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "accounts.google.com")
        self.assertEqual(query["scope"], [oauth.YOUTUBE_ANALYTICS_SCOPE])
        self.assertEqual(query["access_type"], ["offline"])
        self.assertEqual(query["prompt"], ["consent"])
        self.assertEqual(query["include_granted_scopes"], ["false"])
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["state"], ["safe-state"])

    def test_only_installed_desktop_client_json_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            valid = oauth.load_desktop_client(self.make_client_file(directory))
            self.assertEqual(valid.client_id, CLIENT_ID)
            self.assertEqual(valid.client_secret, CLIENT_SECRET)

            web = self.make_client_file(directory, shape="web")
            with self.assertRaisesRegex(oauth.AuthorizationError, "installed desktop"):
                oauth.load_desktop_client(web)

    def test_loopback_callback_rejects_wrong_state_then_accepts_valid_state(self):
        state = "expected-state-value"
        server = oauth.OAuthCallbackServer(state)
        results = []

        def send_callbacks():
            time.sleep(0.03)
            wrong = server.redirect_uri + "?" + urllib.parse.urlencode({"state": "forged", "code": "wrong-code"})
            try:
                urllib.request.urlopen(wrong, timeout=2)
            except urllib.error.HTTPError as exc:
                results.append(exc.code)
            valid = server.redirect_uri + "?" + urllib.parse.urlencode({"state": state, "code": "valid-code"})
            with urllib.request.urlopen(valid, timeout=2) as response:
                results.append(response.status)

        sender = threading.Thread(target=send_callbacks, daemon=True)
        sender.start()
        try:
            code = oauth.wait_for_authorization_code(server, timeout=2)
        finally:
            server.server_close()
        sender.join(timeout=2)
        self.assertEqual(code, "valid-code")
        self.assertEqual(results, [400, 200])
        self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_code_exchange_uses_expected_fields_and_never_returns_request_values_in_errors(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = urllib.parse.parse_qs(request.data.decode("ascii"))
            captured["timeout"] = timeout
            return FakeResponse(
                {
                    "access_token": ACCESS_TOKEN,
                    "refresh_token": REFRESH_TOKEN,
                    "scope": oauth.YOUTUBE_ANALYTICS_SCOPE,
                    "token_type": "Bearer",
                }
            )

        client = oauth.DesktopOAuthClient(CLIENT_ID, CLIENT_SECRET)
        payload = oauth.exchange_authorization_code(
            client,
            "one-time-code",
            "http://127.0.0.1:54321/oauth2/callback",
            urlopen=fake_urlopen,
        )
        self.assertEqual(payload["refresh_token"], REFRESH_TOKEN)
        self.assertEqual(captured["url"], oauth.TOKEN_ENDPOINT)
        self.assertEqual(captured["body"]["grant_type"], ["authorization_code"])
        self.assertEqual(captured["body"]["client_id"], [CLIENT_ID])
        self.assertEqual(captured["body"]["client_secret"], [CLIENT_SECRET])
        self.assertEqual(captured["body"]["code"], ["one-time-code"])

    def test_missing_refresh_token_is_a_hard_failure(self):
        def fake_urlopen(_request, timeout):
            self.assertGreater(timeout, 0)
            return FakeResponse(
                {
                    "access_token": ACCESS_TOKEN,
                    "scope": oauth.YOUTUBE_ANALYTICS_SCOPE,
                }
            )

        with self.assertRaisesRegex(oauth.AuthorizationError, "did not return a refresh token"):
            oauth.exchange_authorization_code(
                oauth.DesktopOAuthClient(CLIENT_ID, CLIENT_SECRET),
                "one-time-code",
                "http://127.0.0.1:54321/oauth2/callback",
                urlopen=fake_urlopen,
            )

    def test_atomic_output_discards_access_token_and_requests_restricted_permissions(self):
        document = oauth.token_document(
            oauth.DesktopOAuthClient(CLIENT_ID, CLIENT_SECRET),
            {"access_token": ACCESS_TOKEN, "refresh_token": REFRESH_TOKEN},
        )
        self.assertNotIn("access_token", document)
        with tempfile.TemporaryDirectory() as directory_name:
            output = Path(directory_name) / "private" / "youtube-token.json"
            real_replace = os.replace
            real_chmod = os.chmod
            with mock.patch.object(oauth.os, "replace", wraps=real_replace) as replace_mock, mock.patch.object(
                oauth.os, "chmod", wraps=real_chmod
            ) as chmod_mock:
                written = oauth.write_token_file(output, document)
            self.assertEqual(written, output.resolve())
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), document)
            replace_mock.assert_called_once()
            self.assertTrue(any(call.args == (output.resolve(), 0o600) for call in chmod_mock.call_args_list))
            leftovers = list(output.parent.glob(f".{output.name}.*.tmp"))
            self.assertEqual(leftovers, [])

    def test_cli_defaults_to_no_browser_and_no_secret_or_token_is_printed(self):
        parser = oauth.build_parser()
        args = parser.parse_args(["--client-secret", "client.json", "--token-output", "token.json"])
        self.assertFalse(args.open_browser)
        args = parser.parse_args(
            ["--client-secret", "client.json", "--token-output", "token.json", "--no-browser"]
        )
        self.assertFalse(args.open_browser)

        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(oauth, "authorize", return_value=Path("token.json")) as authorize_mock:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = oauth.main(
                    ["--client-secret", "client.json", "--token-output", "token.json", "--no-browser"]
                )
        self.assertEqual(result, 0)
        self.assertFalse(authorize_mock.call_args.kwargs["open_browser"])
        combined = stdout.getvalue() + stderr.getvalue()
        for secret_value in (CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN):
            self.assertNotIn(secret_value, combined)

    def test_failure_message_never_leaks_google_response_body(self):
        sensitive_body = json.dumps(
            {"error": "invalid_grant", "client_secret": CLIENT_SECRET, "refresh_token": REFRESH_TOKEN}
        ).encode("utf-8")

        def failing_urlopen(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(sensitive_body))

        with self.assertRaises(oauth.AuthorizationError) as caught:
            oauth.exchange_authorization_code(
                oauth.DesktopOAuthClient(CLIENT_ID, CLIENT_SECRET),
                "one-time-code",
                "http://127.0.0.1:54321/oauth2/callback",
                urlopen=failing_urlopen,
            )
        message = str(caught.exception)
        self.assertIn("HTTP 400", message)
        self.assertNotIn(CLIENT_SECRET, message)
        self.assertNotIn(REFRESH_TOKEN, message)


if __name__ == "__main__":
    unittest.main()
