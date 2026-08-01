#!/usr/bin/env python3
"""Create a refresh credential for read-only YouTube Analytics access.

This is an intentionally small, one-time local OAuth helper.  It binds only
to the IPv4 loopback interface, verifies a cryptographically random OAuth
state value, and stores only the long-lived credential needed by the remote
collector.  Secret and token values are never written to the terminal.
"""

from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping


AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly"
CALLBACK_PATH = "/oauth2/callback"
DEFAULT_TIMEOUT_SECONDS = 300.0


class AuthorizationError(RuntimeError):
    """A safe-to-display OAuth setup error that contains no credential value."""


@dataclass(frozen=True)
class DesktopOAuthClient:
    client_id: str
    client_secret: str


def load_desktop_client(path: Path | str) -> DesktopOAuthClient:
    """Load only Google's installed/desktop client JSON shape."""

    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AuthorizationError("the desktop OAuth JSON could not be read") from exc

    installed = payload.get("installed") if isinstance(payload, dict) else None
    if not isinstance(installed, dict):
        raise AuthorizationError("the OAuth JSON must describe an installed desktop app")

    client_id = str(installed.get("client_id") or "").strip()
    client_secret = str(installed.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        raise AuthorizationError("the desktop OAuth JSON is incomplete")
    if not client_id.endswith(".apps.googleusercontent.com"):
        raise AuthorizationError("the desktop OAuth client identifier is invalid")
    return DesktopOAuthClient(client_id=client_id, client_secret=client_secret)


def build_authorization_url(
    client: DesktopOAuthClient,
    redirect_uri: str,
    state: str,
) -> str:
    """Build a consent URL whose scope cannot be widened by CLI input."""

    if not state:
        raise AuthorizationError("the OAuth state could not be created")
    query = urllib.parse.urlencode(
        {
            "client_id": client.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": YOUTUBE_ANALYTICS_SCOPE,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "false",
            "state": state,
        }
    )
    return AUTHORIZATION_ENDPOINT + "?" + query


class OAuthCallbackServer(http.server.HTTPServer):
    """Single-purpose loopback server carrying no externally reachable bind."""

    allow_reuse_address = True

    def __init__(self, expected_state: str):
        self.expected_state = expected_state
        self.authorization_code: str | None = None
        self.authorization_error: str | None = None
        super().__init__(("127.0.0.1", 0), OAuthCallbackHandler)

    @property
    def redirect_uri(self) -> str:
        return f"http://127.0.0.1:{self.server_port}{CALLBACK_PATH}"


class OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """Accept one valid callback while ignoring unrelated or forged requests."""

    server: OAuthCallbackServer

    def log_message(self, _format: str, *args: object) -> None:
        # The default logger includes the complete query string (OAuth code and
        # state), so it must remain disabled.
        return

    def _reply(self, status: int, heading: str, detail: str) -> None:
        body = (
            "<!doctype html><meta charset=utf-8>"
            f"<title>{heading}</title><h1>{heading}</h1><p>{detail}</p>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != CALLBACK_PATH:
            self._reply(404, "Not found", "This local endpoint only accepts the OAuth callback.")
            return

        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        states = query.get("state", [])
        received_state = states[0] if len(states) == 1 else ""
        if not received_state or not hmac.compare_digest(received_state, self.server.expected_state):
            self._reply(400, "Authorization rejected", "The OAuth security state did not match.")
            return

        if query.get("error"):
            self.server.authorization_error = "authorization was denied by Google"
            self._reply(400, "Authorization declined", "No credential was saved.")
            return

        codes = query.get("code", [])
        code = codes[0].strip() if len(codes) == 1 else ""
        if not code:
            self.server.authorization_error = "the OAuth callback did not contain a code"
            self._reply(400, "Authorization failed", "No credential was saved.")
            return

        self.server.authorization_code = code
        self._reply(200, "Authorization complete", "You can close this browser tab.")


def wait_for_authorization_code(server: OAuthCallbackServer, timeout: float) -> str:
    """Serve callbacks until one has a valid state and code, or time runs out."""

    if timeout <= 0:
        raise AuthorizationError("the local OAuth callback timed out")
    deadline = time.monotonic() + timeout
    while server.authorization_code is None and server.authorization_error is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AuthorizationError("the local OAuth callback timed out")
        server.timeout = min(0.5, remaining)
        server.handle_request()
    if server.authorization_error:
        raise AuthorizationError(server.authorization_error)
    if not server.authorization_code:
        raise AuthorizationError("the OAuth callback did not return a code")
    return server.authorization_code


def _decode_token_response(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AuthorizationError("Google returned an invalid token response") from exc
    if not isinstance(payload, dict):
        raise AuthorizationError("Google returned an invalid token response")
    return payload


def exchange_authorization_code(
    client: DesktopOAuthClient,
    code: str,
    redirect_uri: str,
    *,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Exchange a one-time code without ever surfacing the response body."""

    body = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client.client_id,
            "client_secret": client.client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    ).encode("ascii")
    request = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = _decode_token_response(response.read())
    except urllib.error.HTTPError as exc:
        raise AuthorizationError(f"Google rejected the token exchange (HTTP {exc.code})") from exc
    except urllib.error.URLError as exc:
        raise AuthorizationError("the Google token exchange could not be reached") from exc
    except TimeoutError as exc:
        raise AuthorizationError("the Google token exchange timed out") from exc

    access_token = str(payload.get("access_token") or "").strip()
    refresh_token = str(payload.get("refresh_token") or "").strip()
    if not access_token:
        raise AuthorizationError("Google did not return an access token")
    if not refresh_token:
        raise AuthorizationError("Google did not return a refresh token")

    returned_scope = str(payload.get("scope") or "").strip()
    if returned_scope and set(returned_scope.split()) != {YOUTUBE_ANALYTICS_SCOPE}:
        raise AuthorizationError("Google returned an unexpected OAuth scope")
    return payload


def token_document(
    client: DesktopOAuthClient,
    token_response: Mapping[str, Any],
) -> dict[str, Any]:
    """Keep only the durable authorized-user fields; discard the access token."""

    refresh_token = str(token_response.get("refresh_token") or "").strip()
    if not refresh_token:
        raise AuthorizationError("Google did not return a refresh token")
    return {
        "type": "authorized_user",
        "client_id": client.client_id,
        "client_secret": client.client_secret,
        "refresh_token": refresh_token,
        "token_uri": TOKEN_ENDPOINT,
        "scopes": [YOUTUBE_ANALYTICS_SCOPE],
    }


def write_token_file(path: Path | str, document: Mapping[str, Any]) -> Path:
    """Atomically persist a credential with owner-only mode where supported."""

    target = Path(path).expanduser().resolve()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
        )
    except OSError as exc:
        raise AuthorizationError("the token output could not be prepared") from exc

    temporary = Path(temporary_name)
    try:
        if hasattr(os, "fchmod"):
            try:
                os.fchmod(descriptor, 0o600)
            except OSError:
                pass
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            descriptor = -1
            json.dump(dict(document), handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
        return target
    except (OSError, TypeError, ValueError) as exc:
        raise AuthorizationError("the token output could not be written securely") from exc
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def authorize(
    client_secret_path: Path | str,
    token_output: Path | str,
    *,
    open_browser: bool = False,
    callback_timeout: float = DEFAULT_TIMEOUT_SECONDS,
    browser_opener: Callable[..., bool] = webbrowser.open,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
    status: Callable[[str], None] = print,
) -> Path:
    """Run the complete local flow and return the secured output path."""

    client_path = Path(client_secret_path).expanduser().resolve()
    output_path = Path(token_output).expanduser().resolve()
    if client_path == output_path:
        raise AuthorizationError("the token output must differ from the client JSON")
    client = load_desktop_client(client_path)
    state = secrets.token_urlsafe(32)

    with OAuthCallbackServer(state) as server:
        authorization_url = build_authorization_url(client, server.redirect_uri, state)
        status("OAuth authorization ready on localhost.")
        if open_browser:
            try:
                opened = browser_opener(authorization_url, new=2, autoraise=True)
            except Exception as exc:
                raise AuthorizationError("the authorization browser could not be opened") from exc
            if opened is False:
                raise AuthorizationError("the authorization browser could not be opened")
            status("Browser opened for Google authorization.")
        else:
            status("Browser opening disabled; waiting for the OAuth callback.")
        code = wait_for_authorization_code(server, callback_timeout)
        redirect_uri = server.redirect_uri

    response = exchange_authorization_code(client, code, redirect_uri, urlopen=urlopen)
    target = write_token_file(output_path, token_document(client, response))
    status("OAuth authorization complete.")
    status(f"Credentials written to: {target}")
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Authorize read-only YouTube Analytics access using a desktop OAuth client."
    )
    parser.add_argument("--client-secret", required=True, type=Path, help="Desktop OAuth client JSON")
    parser.add_argument("--token-output", required=True, type=Path, help="Secure output JSON path")
    browser = parser.add_mutually_exclusive_group()
    browser.add_argument(
        "--open-browser",
        dest="open_browser",
        action="store_true",
        help="Open the Google consent page in the default browser",
    )
    browser.add_argument(
        "--no-browser",
        dest="open_browser",
        action="store_false",
        help="Never open a browser automatically (intended for tests)",
    )
    parser.set_defaults(open_browser=False)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        authorize(
            args.client_secret,
            args.token_output,
            open_browser=args.open_browser,
            callback_timeout=args.timeout,
        )
    except AuthorizationError as exc:
        print(f"Authorization failed: {exc}.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Authorization cancelled.", file=sys.stderr)
        return 130
    except Exception:
        # Do not let an unexpected third-party or OS exception stringify
        # credential-bearing request objects into terminal logs.
        print("Authorization failed unexpectedly.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
