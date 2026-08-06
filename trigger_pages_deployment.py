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


def dispatch_pages(
    *,
    repository: str,
    sha: str,
    token: str,
    ref: str = "main",
    attempts: int = 4,
    sleep=time.sleep,
) -> None:
    """Dispatch deploy-pages.yml, retrying only transient API failures."""

    repository = _validated(repository, REPOSITORY_RE, "repository")
    sha = _validated(sha, SHA_RE, "sha")
    ref = _validated(ref, REF_RE, "ref")
    if not token:
        raise ValueError("missing GITHUB_TOKEN/GH_TOKEN")
    if attempts < 1 or attempts > 8:
        raise ValueError("attempts must be between 1 and 8")

    payload = json.dumps(
        {"ref": ref, "inputs": {"requested_sha": sha}},
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
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "youtube-radar-pages-dispatch",
        },
    )

    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status = int(getattr(response, "status", response.getcode()))
            if status != 204:
                raise RuntimeError(f"unexpected GitHub dispatch status: {status}")
            return
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
    parser.add_argument("--attempts", type=int, default=4)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    try:
        dispatch_pages(
            repository=args.repository,
            sha=args.sha,
            token=token,
            ref=args.ref,
            attempts=args.attempts,
        )
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"Requested coalesced Pages deployment for {args.sha} on {args.ref}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
