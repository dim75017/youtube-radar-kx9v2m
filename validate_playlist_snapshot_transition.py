#!/usr/bin/env python3
"""Reject a Spotify playlist snapshot that regresses the published history."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
from typing import Any


PREFIX = "window.SPOTIFY_PLAYLISTS="
HISTORY_RETENTION_DAYS = 400
MONOTONIC_META_COUNTS = (
    "playlists_discovered",
    "playlists_enriched",
    "playlists_10k_plus",
)


class SnapshotRegression(ValueError):
    """Raised when a candidate would discard already-published data."""


def read_payload(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith(PREFIX):
        raise SnapshotRegression(f"{path}: unexpected playlist payload prefix")
    try:
        payload = json.loads(raw[len(PREFIX) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise SnapshotRegression(f"{path}: invalid JSON payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise SnapshotRegression(f"{path}: playlist payload must be an object")
    return payload


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value.strip():
        raise SnapshotRegression(f"missing {field}")
    normalized = value.strip().replace("Z", "+00:00")
    try:
        stamp = dt.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise SnapshotRegression(f"invalid {field}: {value!r}") from exc
    if stamp.tzinfo is not None:
        stamp = stamp.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return stamp


def row_index(payload: dict[str, Any], label: str) -> tuple[list[str], dict[str, list[Any]]]:
    columns = payload.get("cols")
    rows = payload.get("rows")
    if not isinstance(columns, list) or not all(isinstance(column, str) for column in columns):
        raise SnapshotRegression(f"{label}: cols must be a string array")
    if "id" not in columns:
        raise SnapshotRegression(f"{label}: id column is missing")
    if not isinstance(rows, list):
        raise SnapshotRegression(f"{label}: rows must be an array")
    id_index = columns.index("id")
    indexed: dict[str, list[Any]] = {}
    for position, row in enumerate(rows):
        if not isinstance(row, list) or len(row) <= id_index or not row[id_index]:
            raise SnapshotRegression(f"{label}: row {position} has no playlist id")
        playlist_id = str(row[id_index])
        if playlist_id in indexed:
            raise SnapshotRegression(f"{label}: duplicate playlist id {playlist_id}")
        indexed[playlist_id] = row
    return columns, indexed


def history_dates(payload: dict[str, Any], label: str) -> dict[str, set[str]]:
    raw_histories = payload.get("hist")
    if raw_histories is None:
        return {}
    if not isinstance(raw_histories, dict):
        raise SnapshotRegression(f"{label}: hist must be an object")
    histories: dict[str, set[str]] = {}
    for playlist_id, raw_points in raw_histories.items():
        if not isinstance(raw_points, list):
            raise SnapshotRegression(f"{label}: history for {playlist_id} must be an array")
        dates: set[str] = set()
        for point in raw_points:
            if isinstance(point, list) and len(point) >= 2:
                day, value = point[0], point[1]
            elif isinstance(point, dict):
                day, value = point.get("date"), point.get("value")
            else:
                raise SnapshotRegression(f"{label}: malformed history point for {playlist_id}")
            if not isinstance(day, str) or len(day) < 10:
                raise SnapshotRegression(f"{label}: history point without a date for {playlist_id}")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise SnapshotRegression(f"{label}: non-numeric history point for {playlist_id} on {day}")
            dates.add(day[:10])
        histories[str(playlist_id)] = dates
    return histories


def integer_meta(meta: dict[str, Any], field: str, label: str) -> int:
    value = meta.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SnapshotRegression(f"{label}: missing numeric meta.{field}")
    return int(value)


def validate_status(previous_meta: dict[str, Any], candidate_meta: dict[str, Any]) -> None:
    previous = previous_meta.get("playlist_followers_status")
    if not isinstance(previous, dict):
        return
    candidate = candidate_meta.get("playlist_followers_status")
    if not isinstance(candidate, dict):
        raise SnapshotRegression("candidate removed meta.playlist_followers_status")
    previous_day = str(previous.get("day") or "")[:10]
    candidate_day = str(candidate.get("day") or "")[:10]
    if len(previous_day) != 10 or len(candidate_day) != 10:
        raise SnapshotRegression("playlist follower status has no valid day")
    if candidate_day < previous_day:
        raise SnapshotRegression(
            f"playlist follower status day moved backwards: {previous_day} -> {candidate_day}"
        )
    previous_expected = integer_meta(previous, "expected", "previous follower status")
    candidate_expected = integer_meta(candidate, "expected", "candidate follower status")
    if candidate_expected < previous_expected:
        raise SnapshotRegression(
            f"playlist follower cohort shrank: {previous_expected} -> {candidate_expected}"
        )
    if candidate_day == previous_day:
        previous_updated = integer_meta(previous, "updated", "previous follower status")
        candidate_updated = integer_meta(candidate, "updated", "candidate follower status")
        if candidate_updated < previous_updated:
            raise SnapshotRegression(
                f"same-day follower coverage regressed: {previous_updated} -> {candidate_updated}"
            )
        if previous.get("complete") is True and candidate.get("complete") is not True:
            raise SnapshotRegression("same-day complete follower coverage became incomplete")


def validate_snapshot_transition(
    previous: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    previous_meta = previous.get("meta")
    candidate_meta = candidate.get("meta")
    if not isinstance(previous_meta, dict) or not isinstance(candidate_meta, dict):
        raise SnapshotRegression("both snapshots must contain meta objects")

    previous_stamp = parse_timestamp(previous_meta.get("snapshot_ts"), "previous meta.snapshot_ts")
    candidate_stamp = parse_timestamp(candidate_meta.get("snapshot_ts"), "candidate meta.snapshot_ts")
    if candidate_stamp < previous_stamp:
        raise SnapshotRegression(
            "playlist source snapshot moved backwards: "
            f"{previous_meta.get('snapshot_ts')} -> {candidate_meta.get('snapshot_ts')}"
        )

    previous_columns, previous_rows = row_index(previous, "previous snapshot")
    candidate_columns, candidate_rows = row_index(candidate, "candidate snapshot")
    removed_columns = sorted(set(previous_columns) - set(candidate_columns))
    if removed_columns:
        raise SnapshotRegression(f"candidate removed columns: {', '.join(removed_columns)}")
    removed_ids = sorted(set(previous_rows) - set(candidate_rows))
    if removed_ids:
        sample = ", ".join(removed_ids[:5])
        raise SnapshotRegression(
            f"candidate removed {len(removed_ids)} playlists (first ids: {sample})"
        )

    for field in MONOTONIC_META_COUNTS:
        previous_count = integer_meta(previous_meta, field, "previous snapshot")
        candidate_count = integer_meta(candidate_meta, field, "candidate snapshot")
        if candidate_count < previous_count:
            raise SnapshotRegression(
                f"meta.{field} regressed: {previous_count} -> {candidate_count}"
            )

    previous_histories = history_dates(previous, "previous snapshot")
    candidate_histories = history_dates(candidate, "candidate snapshot")
    removed_history_ids = sorted(set(previous_histories) - set(candidate_histories))
    if removed_history_ids:
        raise SnapshotRegression(
            f"candidate removed history for {len(removed_history_ids)} playlists"
        )
    missing_points = []
    for playlist_id, previous_dates in previous_histories.items():
        candidate_dates = candidate_histories.get(playlist_id, set())
        protected_previous_dates = previous_dates
        if candidate_dates:
            latest_candidate_day = max(dt.date.fromisoformat(day) for day in candidate_dates)
            retention_cutoff = latest_candidate_day - dt.timedelta(days=HISTORY_RETENTION_DAYS)
            protected_previous_dates = {
                day
                for day in previous_dates
                if dt.date.fromisoformat(day) >= retention_cutoff
            }
        missing_dates = sorted(protected_previous_dates - candidate_dates)
        if missing_dates:
            missing_points.append((playlist_id, missing_dates))
    if missing_points:
        playlist_id, dates = missing_points[0]
        raise SnapshotRegression(
            "candidate discarded follower history points for "
            f"{len(missing_points)} playlists (first: {playlist_id} {','.join(dates[:5])})"
        )

    validate_status(previous_meta, candidate_meta)
    return {
        "previous_snapshot": previous_meta.get("snapshot_ts"),
        "candidate_snapshot": candidate_meta.get("snapshot_ts"),
        "rows": len(candidate_rows),
        "columns": len(candidate_columns),
        "history_playlists": len(candidate_histories),
        "history_points": sum(len(dates) for dates in candidate_histories.values()),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        summary = validate_snapshot_transition(
            read_payload(args.previous),
            read_payload(args.candidate),
        )
    except SnapshotRegression as exc:
        print(json.dumps({"valid": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"valid": True, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
