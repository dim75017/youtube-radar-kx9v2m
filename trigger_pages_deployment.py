#!/usr/bin/env python3
"""Request one coalesced deployment of the latest GitHub Pages revision."""

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


REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REF_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
TRANSIENT_HTTP_CODES = {408, 409, 425, 429, 500, 502, 503, 504}


def _validated(value: str, pattern: re.Pattern[str], label: str) -> str:
    value = (value or "").strip()
    if not pattern.fullmatch(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


def _request_json(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "youtube-radar-pages-dispatch",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def wait_for_ref_sha(
    *,
    repository: str,
    ref: str,
    sha: str,
    token: str,
    timeout: int = 120,
    interval: int = 3,
    sleep=time.sleep,
    monotonic=time.monotonic,
) -> None:
    """Wait until GitHub's workflow-dispatch ref resolves to the pushed SHA."""

    repository = _validated(repository, REPOSITORY_RE, "repository")
    ref = _validated(ref, REF_RE, "ref")
    sha = _validated(sha, SHA_RE, "sha")
    if not token:
        raise ValueError("missing GITHUB_TOKEN/GH_TOKEN")
    if timeout < 1 or timeout > 600:
        raise ValueError("ref timeout must be between 1 and 600 seconds")
    if interval < 0 or interval > 60:
        raise ValueError("ref interval must be between 0 and 60 seconds")
    encoded_ref = urllib.parse.quote(ref, safe="")
    url = f"https://api.github.com/repos/{repository}/git/ref/heads/{encoded_ref}"
    deadline = monotonic() + timeout
    observed = ""
    while True:
        try:
            payload = _request_json(url, token)
            observed = str((payload.get("object") or {}).get("sha") or "")
            if observed == sha:
                return
        except urllib.error.HTTPError as exc:
            if exc.code not in TRANSIENT_HTTP_CODES:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"GitHub ref lookup failed with HTTP {exc.code}: {detail}"
                ) from exc
        except urllib.error.URLError as exc:
            observed = f"network error: {exc.reason}"
        if monotonic() >= deadline:
            raise RuntimeError(
                f"GitHub ref {ref} did not resolve requested Pages SHA {sha}; "
                f"last observed {observed or 'none'}"
            )
        sleep(interval)


def wait_for_pages_run(
    *,
    repository: str,
    run_id: int,
    sha: str,
    token: str,
    timeout: int = 1800,
    interval: int = 10,
    sleep=time.sleep,
    monotonic=time.monotonic,
) -> int:
    """Wait for the exact workflow-dispatch run and require its success."""

    repository = _validated(repository, REPOSITORY_RE, "repository")
    sha = _validated(sha, SHA_RE, "sha")
    if not token:
        raise ValueError("missing GITHUB_TOKEN/GH_TOKEN")
    if not isinstance(run_id, int) or isinstance(run_id, bool) or run_id <= 0:
        raise ValueError("run_id must be a positive integer")
    if timeout < 1 or timeout > 3600:
        raise ValueError("run timeout must be between 1 and 3600 seconds")
    if interval < 0 or interval > 60:
        raise ValueError("run interval must be between 0 and 60 seconds")
    run_url = f"https://api.github.com/repos/{repository}/actions/runs/{run_id}"
    deadline = monotonic() + timeout
    while True:
        try:
            run = _request_json(run_url, token)
            observed_id = int(run.get("id") or 0)
            observed_sha = str(run.get("head_sha") or "")
            if observed_id != run_id or observed_sha != sha:
                raise RuntimeError(
                    f"Pages run identity diverged: requested run={run_id} sha={sha}, "
                    f"observed run={observed_id} sha={observed_sha or 'none'}"
                )
            if run.get("status") == "completed":
                conclusion = str(run.get("conclusion") or "")
                if conclusion != "success":
                    raise RuntimeError(
                        f"Exact Pages workflow run {run_id} completed with {conclusion or 'no conclusion'}"
                    )
                return int(run_id)
        except urllib.error.HTTPError as exc:
            if exc.code not in TRANSIENT_HTTP_CODES:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"GitHub Pages run lookup failed with HTTP {exc.code}: {detail}"
                ) from exc
        except urllib.error.URLError:
            pass
        if monotonic() >= deadline:
            raise RuntimeError(f"Timed out waiting for exact Pages run {run_id}")
        sleep(interval)


def dispatch_pages(
    *,
    repository: str,
    sha: str,
    token: str,
    ref: str = "main",
    retry_attempt: int = 0,
    attempts: int = 4,
    ref_timeout: int = 120,
    wait_for_completion: bool = False,
    run_timeout: int = 1800,
    sleep=time.sleep,
) -> int:
    """Dispatch deploy-pages.yml, retrying only transient API failures."""

    repository = _validated(repository, REPOSITORY_RE, "repository")
    sha = _validated(sha, SHA_RE, "sha")
    ref = _validated(ref, REF_RE, "ref")
    if not token:
        raise ValueError("missing GITHUB_TOKEN/GH_TOKEN")
    if attempts < 1 or attempts > 8:
        raise ValueError("attempts must be between 1 and 8")
    if retry_attempt < 0 or retry_attempt > 3:
        raise ValueError("retry_attempt must be between 0 and 3")

    wait_for_ref_sha(
        repository=repository,
        ref=ref,
        sha=sha,
        token=token,
        timeout=ref_timeout,
        sleep=sleep,
    )

    payload = json.dumps(
        {
            "ref": ref,
            "return_run_details": True,
            "inputs": {
                "requested_sha": sha,
                "retry_attempt": str(retry_attempt),
            },
        },
        separators=(",", ":"),
    ).encode("utf-8")
    url = (
        f"https://api.github.com/repos/{repository}/actions/workflows/"
        "deploy-pages.yml/dispatches"
    )
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "youtube-radar-pages-dispatch",
        },
    )

    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status = int(getattr(response, "status", response.getcode()))
                response_payload = json.load(response) if status == 200 else {}
            if status != 200:
                raise RuntimeError(f"unexpected GitHub dispatch status: {status}")
            run_id = int(response_payload.get("workflow_run_id") or 0)
            if run_id <= 0:
                raise RuntimeError("GitHub Pages dispatch returned no workflow run ID")
            if wait_for_completion:
                return wait_for_pages_run(
                    repository=repository,
                    run_id=run_id,
                    sha=sha,
                    token=token,
                    timeout=run_timeout,
                    sleep=sleep,
                )
            return run_id
        except urllib.error.HTTPError as exc:
            if exc.code not in TRANSIENT_HTTP_CODES or attempt == attempts:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"GitHub Pages dispatch failed with HTTP {exc.code}: {detail}"
                ) from exc
        except urllib.error.URLError as exc:
            if attempt == attempts:
                raise RuntimeError(f"GitHub Pages dispatch failed: {exc.reason}") from exc
        sleep(min(2 ** (attempt - 1), 8))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--ref", default="main")
    parser.add_argument("--retry-attempt", type=int, default=0)
    parser.add_argument("--attempts", type=int, default=4)
    parser.add_argument("--ref-timeout", type=int, default=120)
    parser.add_argument("--wait-for-completion", action="store_true")
    parser.add_argument("--run-timeout", type=int, default=1800)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    try:
        run_id = dispatch_pages(
            repository=args.repository,
            sha=args.sha,
            token=token,
            ref=args.ref,
            retry_attempt=args.retry_attempt,
            attempts=args.attempts,
            ref_timeout=args.ref_timeout,
            wait_for_completion=args.wait_for_completion,
            run_timeout=args.run_timeout,
        )
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(
        f"Requested Pages deployment run {run_id} for {args.sha} on {args.ref}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
