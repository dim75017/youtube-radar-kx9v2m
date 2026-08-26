#!/usr/bin/env python3
"""Build the lazy public playlist-analytics payload from canonical daily data."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
from typing import Any


SOURCE_PREFIX = "window.SPOTIFY_PLAYLISTS="
OUTPUT_PREFIX = "window.SPOTIFY_PLAYLIST_ANALYTICS="
OUTPUT_COLUMNS = [
    "id",
    "name",
    "owner",
    "curatorCat",
    "followers",
    "tracks",
    "first_seen",
    "last_seen",
    "genre",
    "use_case",
    "fit",
    "estDate",
    "estConf",
    "image_url",
]


def read_payload(path: Path, prefix: str = SOURCE_PREFIX) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith(prefix):
        raise ValueError(f"Unexpected payload prefix in {path}")
    payload = json.loads(raw[len(prefix) :].strip().removesuffix(";"))
    if not isinstance(payload, dict):
        raise ValueError(f"Unexpected payload type in {path}")
    return payload


def enabled(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return value is True or value == 1


def valid_day(value: Any) -> str:
    day = str(value or "")[:10]
    try:
        return day if dt.date.fromisoformat(day).isoformat() == day else ""
    except ValueError:
        return ""


def normalize_history(raw: Any) -> list[list[Any]]:
    daily: dict[str, int | float] = {}
    for point in raw if isinstance(raw, list) else []:
        if isinstance(point, list) and len(point) >= 2:
            point_day, value = point[0], point[1]
        elif isinstance(point, dict):
            point_day, value = point.get("date"), point.get("value")
        else:
            continue
        day = valid_day(point_day)
        if not day or isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(float(value)) or float(value) < 0:
            continue
        numeric: int | float = int(value) if float(value).is_integer() else float(value)
        daily[day] = numeric
    return [[day, daily[day]] for day in sorted(daily)]


def field(row: list[Any], columns: list[str], name: str) -> Any:
    try:
        index = columns.index(name)
    except ValueError as error:
        raise ValueError(f"Missing canonical playlist column: {name}") from error
    return row[index] if index < len(row) else None


def build_payload(source: dict[str, Any]) -> dict[str, Any]:
    columns = list(source.get("cols") or [])
    rows = source.get("rows") if isinstance(source.get("rows"), list) else []
    histories = source.get("hist") if isinstance(source.get("hist"), dict) else {}
    for required in [*OUTPUT_COLUMNS, "big10k"]:
        if required not in columns:
            raise ValueError(f"Missing canonical playlist column: {required}")

    visible_rows = [
        row
        for row in rows
        if isinstance(row, list) and enabled(field(row, columns, "big10k"))
    ]
    if not visible_rows:
        raise ValueError("Playlist analytics cohort is empty")

    projected_rows: list[list[Any]] = []
    projected_histories: dict[str, list[list[Any]]] = {}
    for row in visible_rows:
        playlist_id = str(field(row, columns, "id") or "")
        if not playlist_id:
            raise ValueError("Visible playlist is missing its Spotify ID")
        if playlist_id in projected_histories:
            raise ValueError(f"Duplicate visible playlist ID: {playlist_id}")
        history = normalize_history(histories.get(playlist_id))
        if not history:
            raise ValueError(f"Visible playlist has no measured follower history: {playlist_id}")
        projected_rows.append([field(row, columns, name) for name in OUTPUT_COLUMNS])
        projected_histories[playlist_id] = history

    source_meta = source.get("meta") if isinstance(source.get("meta"), dict) else {}
    status = (
        source_meta.get("playlist_followers_status")
        if isinstance(source_meta.get("playlist_followers_status"), dict)
        else {}
    )
    expected = status.get("expected")
    if isinstance(expected, int) and expected != len(projected_rows):
        raise ValueError(
            f"Follower status expects {expected} playlists, projection contains {len(projected_rows)}"
        )
    status_day = valid_day(status.get("day"))
    if status.get("complete") is True:
        missing = [
            playlist_id
            for playlist_id, history in projected_histories.items()
            if not any(point[0] == status_day for point in history)
        ]
        if not status_day or missing:
            raise ValueError(
                "A complete follower status must have a real point for every visible playlist"
            )

    return {
        "version": 1,
        "generated_at": source_meta.get("generated_ts") or source_meta.get("snapshot_ts") or "",
        "status": status,
        "cols": OUTPUT_COLUMNS,
        "rows": projected_rows,
        "hist": projected_histories,
    }


def write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = OUTPUT_PREFIX + json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ) + ";\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--playlists",
        type=Path,
        default=Path("Spotify_Playlists_canonical_data.js"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("Spotify_Playlist_Analytics_data.js"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = build_payload(read_payload(args.playlists))
    write_payload(args.output, payload)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "playlists": len(payload["rows"]),
                "histories": len(payload["hist"]),
                "day": payload["status"].get("day"),
                "complete": payload["status"].get("complete") is True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
