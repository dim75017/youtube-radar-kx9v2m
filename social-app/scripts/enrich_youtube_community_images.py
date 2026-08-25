#!/usr/bin/env python3
"""Recover missing public image URLs for YouTube Community image posts."""

from __future__ import annotations

import argparse
import html
import json
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = ROOT / "data" / "public-history.json"
IMAGE_URL = re.compile(r"https://yt3\.ggpht\.com/[^\"\\\s]+")
PROFILE_IMAGE_MARKER = "_BSh2VVvVMzqBoKyWbQnyC35"


def candidate_images(page: str) -> list[str]:
    """Extract first-party post image candidates while excluding the channel avatar."""
    values: list[str] = []
    seen: set[str] = set()
    for matched in IMAGE_URL.findall(html.unescape(page)):
        value = matched.replace("\\u0026", "&").replace("\\/", "/")
        if PROFILE_IMAGE_MARKER in value or value in seen:
            continue
        seen.add(value)
        values.append(value)
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--limit", type=int, default=0, help="Limiter le nombre de posts (test).")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def fetch_page(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; LofiSocialRadar/1.0)"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", "replace")


def main() -> int:
    args = parse_args()
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    posts = snapshot.get("posts")
    if not isinstance(posts, list):
        raise SystemExit("Snapshot invalide : tableau posts absent.")
    targets = [
        post for post in posts
        if isinstance(post, dict)
        and post.get("platform") == "youtube"
        and post.get("format") == "community_image"
        and not post.get("thumbnailUrl")
        and isinstance(post.get("url"), str)
    ]
    if args.limit > 0:
        targets = targets[: args.limit]

    collected_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    updated = 0
    failed: list[str] = []
    for index, post in enumerate(targets, 1):
        try:
            choices = candidate_images(fetch_page(post["url"]))
        except Exception:
            choices = []
        if not choices:
            failed.append(str(post.get("externalId")))
        else:
            post["thumbnailUrl"] = choices[0]
            raw = post.setdefault("raw", {})
            if isinstance(raw, dict):
                raw["thumbnailRecoveredAt"] = collected_at
                raw["thumbnailSource"] = "YouTube public post page"
            updated += 1
        print(f"[{index}/{len(targets)}] {post.get('externalId')}", flush=True)
        time.sleep(0.15)

    if not args.dry_run:
        args.snapshot.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"targets": len(targets), "updated": updated, "failed": failed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
