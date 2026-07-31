#!/usr/bin/env python3
"""Report exact daily follower-history coverage for dashboard playlists."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from spotify_performance_store import read_performance_payload


PLAYLISTS_PREFIX = "window.SPOTIFY_PLAYLISTS="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
PARIS_TIMEZONE = ZoneInfo("Europe/Paris")


def read_payload(path: Path, prefix: str) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith(prefix):
        raise ValueError(f"Unexpected payload prefix in {path}")
    value = json.loads(raw[len(prefix) :].strip().removesuffix(";"))
    if not isinstance(value, dict):
        raise ValueError(f"Unexpected payload type in {path}")
    return value


def enabled(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return value is True or value == 1


def has_numeric_day(history: Any, day: str) -> bool:
    if not isinstance(history, list):
        return False
    for point in history:
        if isinstance(point, list) and len(point) >= 2:
            point_day, value = point[0], point[1]
        elif isinstance(point, dict):
            point_day, value = point.get("date"), point.get("value")
        else:
            continue
        if str(point_day)[:10] != day or isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return True
    return False


def coverage(
    playlists_path: Path,
    performance_path: Path,
    day: str,
) -> dict[str, Any]:
    playlists = read_payload(playlists_path, PLAYLISTS_PREFIX)
    performance = read_performance_payload(performance_path)
    columns = list(playlists.get("cols") or [])
    rows = playlists.get("rows") or []
    id_index = columns.index("id")
    visible_index = columns.index("big10k")
    expected_ids = {
        str(row[id_index])
        for row in rows
        if isinstance(row, list)
        and len(row) > max(id_index, visible_index)
        and row[id_index]
        and enabled(row[visible_index])
    }
    playlist_histories = playlists.get("hist") if isinstance(playlists.get("hist"), dict) else {}
    performance_histories = (
        performance.get("playlists") if isinstance(performance.get("playlists"), dict) else {}
    )
    playlist_updated = {
        playlist_id
        for playlist_id in expected_ids
        if has_numeric_day(playlist_histories.get(playlist_id), day)
    }
    performance_updated = {
        playlist_id
        for playlist_id in expected_ids
        if has_numeric_day(
            (performance_histories.get(playlist_id) or {}).get("history")
            if isinstance(performance_histories.get(playlist_id), dict)
            else None,
            day,
        )
    }
    updated_ids = playlist_updated & performance_updated
    missing_ids = sorted(expected_ids - updated_ids)
    return {
        "day": day,
        "expected": len(expected_ids),
        "updated": len(updated_ids),
        "missing": len(missing_ids),
        "playlist_export_updated": len(playlist_updated),
        "performance_export_updated": len(performance_updated),
        "complete": bool(expected_ids) and not missing_ids,
        "missing_ids": missing_ids[:20],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--playlists",
        type=Path,
        default=Path("Spotify_Playlists_canonical_data.js"),
    )
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument("--day", default="")
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--require-complete", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    day = args.day or dt.datetime.now(PARIS_TIMEZONE).date().isoformat()
    status = coverage(args.playlists, args.performance, day)
    print(json.dumps(status, ensure_ascii=False))
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            for key in ("day", "expected", "updated", "missing", "complete"):
                value = status[key]
                if isinstance(value, bool):
                    value = str(value).lower()
                output.write(f"{key}={value}\n")
    return int(args.require_complete and not status["complete"])


if __name__ == "__main__":
    raise SystemExit(main())
