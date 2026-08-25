#!/usr/bin/env python3
"""Fill missing publication dates for the public Lofi Girl YouTube Shorts archive.

This only adds metadata returned by YouTube's public video page. It deliberately
does not replace the metric snapshots collected by the radar, so ranking and
historic observations remain traceable to their original collection time.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = ROOT / "data" / "public-history.json"


def iso_from_details(details: dict[str, Any]) -> str | None:
    """Return YouTube's public video timestamp as a UTC ISO value."""
    timestamp = details.get("release_timestamp") or details.get("timestamp")
    if isinstance(timestamp, (int, float)) and timestamp > 0:
        return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")

    upload_date = details.get("upload_date")
    if isinstance(upload_date, str) and len(upload_date) == 8 and upload_date.isdigit():
        return f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}T00:00:00Z"
    return None


def nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return int(value)


def update_from_details(post: dict[str, Any], details: dict[str, Any], collected_at: str) -> bool:
    """Apply durable public Short metadata and metrics, without inventing a value."""
    published_at = iso_from_details(details)
    if not published_at:
        return False

    changed = post.get("publishedAt") != published_at
    post["publishedAt"] = published_at
    raw = post.setdefault("raw", {})
    if not isinstance(raw, dict):
        raw = {}
        post["raw"] = raw
    raw["publishedAtPrecision"] = "exact"
    raw["publicMetadataCollectedAt"] = collected_at
    raw["publicMetadataSource"] = "yt-dlp YouTube video page"
    metric_sources = raw.setdefault("metricSources", {})
    if not isinstance(metric_sources, dict):
        metric_sources = {}
        raw["metricSources"] = metric_sources
    for field, detail_field in (("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count")):
        value = nonnegative_int(details.get(detail_field))
        if value is None:
            continue
        if post.get(field) != value:
            post[field] = value
            changed = True
        metric_sources[field] = f"yt-dlp YouTube video page {detail_field}"
    return changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--limit", type=int, default=0, help="Limiter le nombre de Shorts traités (test).")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    local_dependency = ROOT / "work" / "ytdeps"
    if local_dependency.is_dir():
        sys.path.insert(0, str(local_dependency))
    try:
        from yt_dlp import YoutubeDL
    except ImportError as error:
        raise SystemExit(
            "yt-dlp est requis. Installer dans un environnement local puis relancer ce script."
        ) from error

    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    posts = snapshot.get("posts")
    if not isinstance(posts, list):
        raise SystemExit("Snapshot invalide : tableau posts absent.")
    targets = [
        post
        for post in posts
        if isinstance(post, dict)
        and post.get("platform") == "youtube"
        and post.get("format") == "short"
        and isinstance(post.get("externalId"), str)
    ]
    if args.limit > 0:
        targets = targets[: args.limit]

    collected_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    updated = 0
    failed: list[str] = []
    options = {"quiet": True, "skip_download": True, "noplaylist": True, "ignoreerrors": True}
    with YoutubeDL(options) as youtube:
        for index, post in enumerate(targets, 1):
            external_id = post["externalId"]
            try:
                details = youtube.extract_info(
                    f"https://www.youtube.com/shorts/{external_id}", download=False
                )
            except Exception:  # Public pages may transiently fail; retain old data.
                failed.append(external_id)
                continue
            if not isinstance(details, dict) or not iso_from_details(details):
                failed.append(external_id)
                continue
            updated += int(update_from_details(post, details, collected_at))
            print(f"[{index}/{len(targets)}] {external_id}", flush=True)

    if not args.dry_run:
        args.snapshot.write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps({"targets": len(targets), "updated": updated, "failed": failed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
