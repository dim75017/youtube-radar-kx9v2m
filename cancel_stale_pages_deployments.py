#!/usr/bin/env python3
"""Cancel an orphaned GitHub Pages deployment before publishing a new one."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


REPOSITORY_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$"
)
REF_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ACTIVE_STATUSES = {
    "building",
    "deployment_queued",
    "in_progress",
    "pending",
    "queued",
}
TERMINAL_STATUSES = {
    "cancelled",
    "deployment_cancelled",
    "deployment_failed",
    "deployment_succeeded",
    "failed",
    "failure",
    "succeed",
    "success",
}


def _validated(value: str, pattern: re.Pattern[str], label: str) -> str:
    value = (value or "").strip()
    if not pattern.fullmatch(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


def _request(
    *,
    url: str,
    token: str,
    method: str = "GET",
    opener=urllib.request.urlopen,
) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "youtube-radar-pages-preflight",
        },
    )
    try:
        with opener(request, timeout=30) as response:
            return int(getattr(response, "status", response.getcode())), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read()
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GitHub Pages preflight failed: {exc.reason}") from exc


def _decode_json(body: bytes, label: str):
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid GitHub response for {label}") from exc


def cancel_stale_pages_deployment(
    *,
    repository: str,
    token: str,
    ref: str = "main",
    exclude_sha: str | None = None,
    lookback: int = 24,
    poll_attempts: int = 12,
    opener=urllib.request.urlopen,
    sleep=time.sleep,
) -> str | None:
    """Cancel the one explicitly active Pages deployment found on ``ref``.

    Only commits returned by GitHub for the selected branch are inspected. A
    deployment is cancelled only when its status is an explicit active state;
    successful and failed deployments are never mutated.
    """

    repository = _validated(repository, REPOSITORY_RE, "repository")
    ref = _validated(ref, REF_RE, "ref")
    if exclude_sha is not None:
        exclude_sha = _validated(exclude_sha, SHA_RE, "excluded SHA")
    if not token:
        raise ValueError("missing GITHUB_TOKEN/GH_TOKEN")
    if lookback < 1 or lookback > 100:
        raise ValueError("lookback must be between 1 and 100")
    if poll_attempts < 1 or poll_attempts > 30:
        raise ValueError("poll_attempts must be between 1 and 30")

    encoded_ref = urllib.parse.quote(ref, safe="")
    commits_url = (
        f"https://api.github.com/repos/{repository}/commits"
        f"?sha={encoded_ref}&per_page={lookback}"
    )
    status, body = _request(url=commits_url, token=token, opener=opener)
    if status != 200:
        detail = body.decode("utf-8", errors="replace")
        raise RuntimeError(f"cannot list main commits (HTTP {status}): {detail}")
    commits = _decode_json(body, "commit list")
    if not isinstance(commits, list):
        raise RuntimeError("invalid GitHub commit list")

    for item in commits:
        sha = item.get("sha") if isinstance(item, dict) else None
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise RuntimeError("invalid commit SHA in GitHub commit list")
        # A job with the github-pages environment creates its own deployment
        # record before this preflight runs. Its status can be temporarily
        # empty; it is the deployment we are about to execute, not an orphan.
        if sha == exclude_sha:
            continue
        deployment_url = (
            f"https://api.github.com/repos/{repository}/pages/deployments/{sha}"
        )
        deployment_status, deployment_body = _request(
            url=deployment_url,
            token=token,
            opener=opener,
        )
        if deployment_status == 404:
            continue
        if deployment_status != 200:
            detail = deployment_body.decode("utf-8", errors="replace")
            raise RuntimeError(
                f"cannot inspect Pages deployment {sha} "
                f"(HTTP {deployment_status}): {detail}"
            )
        payload = _decode_json(deployment_body, f"Pages deployment {sha}")
        state = str(payload.get("status", "")).strip().lower()
        if state in TERMINAL_STATUSES:
            continue
        if state not in ACTIVE_STATUSES:
            raise RuntimeError(
                f"refusing to cancel Pages deployment {sha} with unknown status {state!r}"
            )

        cancel_status, cancel_body = _request(
            url=f"{deployment_url}/cancel",
            token=token,
            method="POST",
            opener=opener,
        )
        if cancel_status not in {204, 404}:
            detail = cancel_body.decode("utf-8", errors="replace")
            raise RuntimeError(
                f"cannot cancel Pages deployment {sha} "
                f"(HTTP {cancel_status}): {detail}"
            )

        for attempt in range(poll_attempts):
            check_status, check_body = _request(
                url=deployment_url,
                token=token,
                opener=opener,
            )
            if check_status == 404:
                return sha
            if check_status != 200:
                detail = check_body.decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"cannot verify Pages cancellation {sha} "
                    f"(HTTP {check_status}): {detail}"
                )
            check_payload = _decode_json(
                check_body, f"Pages cancellation status {sha}"
            )
            check_state = str(check_payload.get("status", "")).strip().lower()
            if check_state in TERMINAL_STATUSES:
                return sha
            if check_state not in ACTIVE_STATUSES:
                raise RuntimeError(
                    f"unknown Pages status after cancellation for {sha}: {check_state!r}"
                )
            if attempt + 1 < poll_attempts:
                sleep(5)
        raise RuntimeError(f"Pages deployment {sha} remained active after cancellation")

    return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", default="main")
    parser.add_argument("--exclude-sha")
    parser.add_argument("--lookback", type=int, default=24)
    parser.add_argument("--poll-attempts", type=int, default=12)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    try:
        cancelled_sha = cancel_stale_pages_deployment(
            repository=args.repository,
            token=token,
            ref=args.ref,
            exclude_sha=args.exclude_sha,
            lookback=args.lookback,
            poll_attempts=args.poll_attempts,
        )
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if cancelled_sha:
        print(f"Cancelled orphaned Pages deployment {cancelled_sha}.")
    else:
        print("No orphaned Pages deployment found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
