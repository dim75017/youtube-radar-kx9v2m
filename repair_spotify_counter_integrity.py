#!/usr/bin/env python3
"""Audit or repair discontinuities in the Spotify Performance counter store."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any, Mapping

from spotify_counter_integrity import sanitize_counter_history
from spotify_performance_store import (
    read_performance_payload,
    validate_performance_store,
    write_performance_payload,
)


DEFAULT_PERFORMANCE = Path("Spotify_Performance_data.js")
BROWSE_PREFIX = "window.SPOTIFY_BROWSE_CATALOGUE="


def audit_payload(payload: Mapping[str, Any], *, repair: bool) -> dict[str, Any]:
    tracks = payload.get("tracks")
    if not isinstance(tracks, dict):
        raise ValueError("Spotify Performance tracks must be an object")

    checked_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )
    affected: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    event_day_counts: dict[str, int] = {}
    for raw_track_id, raw_entry in tracks.items():
        track_id = str(raw_track_id)
        history = raw_entry.get("history") if isinstance(raw_entry, Mapping) else raw_entry
        integrity = sanitize_counter_history(history)
        if not integrity["changed"]:
            continue
        status = str(integrity["status"])
        status_counts[status] = status_counts.get(status, 0) + 1
        for event in integrity["events"]:
            event_point = event.get("candidate") or event.get("removed")
            if isinstance(event_point, (list, tuple)) and event_point:
                event_day = str(event_point[0])[:10]
                event_day_counts[event_day] = event_day_counts.get(event_day, 0) + 1
        latest_before = (
            list(history[-1])
            if isinstance(history, list) and history and isinstance(history[-1], (list, tuple))
            else None
        )
        safe_history = integrity["history"]
        affected.append(
            {
                "spotify_id": track_id,
                "status": status,
                "latest_before": latest_before,
                "latest_safe": list(safe_history[-1]) if safe_history else None,
                "events": len(integrity["events"]),
            }
        )
        if not repair:
            continue
        if isinstance(raw_entry, dict):
            entry = raw_entry
        else:
            entry = {"history": history}
            tracks[raw_track_id] = entry
        entry["history"] = safe_history
        entry["counter_integrity"] = {
            "version": 1,
            "status": status,
            "checked_at": checked_at,
            "events": integrity["events"],
        }

    return {
        "status": "repaired" if repair and affected else "clean" if not affected else "unsafe",
        "tracks_checked": len(tracks),
        "affected_tracks": len(affected),
        "status_counts": status_counts,
        "event_day_counts": dict(sorted(event_day_counts.items())),
        "samples": affected[:50],
    }


def read_browse_payload(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(BROWSE_PREFIX):
        raise ValueError(f"{path} is not a Spotify Browse export")
    payload = json.loads(text[len(BROWSE_PREFIX) :].strip().removesuffix(";"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} does not contain a Browse object")
    return payload


def audit_browse_payload(
    performance: Mapping[str, Any],
    browse: Mapping[str, Any],
) -> dict[str, Any]:
    catalogue = browse.get("discovery_catalogue")
    if not isinstance(catalogue, Mapping):
        raise ValueError("Spotify Browse discovery_catalogue must be an object")
    schema = catalogue.get("track_schema")
    rows = catalogue.get("tracks")
    if not isinstance(schema, list) or not isinstance(rows, list):
        raise ValueError("Spotify Browse tracks/schema are invalid")
    required = ("spotify_id", "streams", "streams_delta_24h", "streams_source_date")
    try:
        indexes = {name: schema.index(name) for name in required}
    except ValueError as exc:
        raise ValueError("Spotify Browse counter fields are incomplete") from exc
    performance_tracks = performance.get("tracks")
    if not isinstance(performance_tracks, Mapping):
        raise ValueError("Spotify Performance tracks must be an object")

    compared = 0
    integrity_rows = 0
    mismatches: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, list):
            continue
        spotify_id = str(row[indexes["spotify_id"]] or "")
        entry = performance_tracks.get(spotify_id)
        if not isinstance(entry, Mapping):
            continue
        history = entry.get("history")
        if not isinstance(history, list) or not history:
            continue
        latest_day, latest_total = history[-1]
        source_day = str(row[indexes["streams_source_date"]] or "")[:10]
        metadata = entry.get("counter_integrity")
        integrity_status = (
            str(metadata.get("status") or "") if isinstance(metadata, Mapping) else ""
        )
        if integrity_status and integrity_status != "ok":
            integrity_rows += 1
        # A newer independent source may legitimately win. Every same-day or
        # quarantined Performance overlay must, however, be atomic.
        if source_day > str(latest_day) and integrity_status != "spike_quarantined":
            continue
        previous_day = (
            dt.date.fromisoformat(str(latest_day)) - dt.timedelta(days=1)
        ).isoformat()
        by_day = {str(day): value for day, value in history}
        previous_total = by_day.get(previous_day)
        expected_delta = (
            latest_total - previous_total if previous_total is not None else None
        )
        observed = {
            "streams": row[indexes["streams"]],
            "streams_delta_24h": row[indexes["streams_delta_24h"]],
            "streams_source_date": source_day,
        }
        expected = {
            "streams": latest_total,
            "streams_delta_24h": expected_delta,
            "streams_source_date": str(latest_day),
        }
        compared += 1
        if observed != expected:
            mismatches.append(
                {"spotify_id": spotify_id, "observed": observed, "expected": expected}
            )
    return {
        "public_tracks": len(rows),
        "performance_rows_compared": compared,
        "public_integrity_rows": integrity_rows,
        "mismatches": len(mismatches),
        "samples": mismatches[:25],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--performance", type=Path, default=DEFAULT_PERFORMANCE)
    parser.add_argument("--browse", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Fail if any unsafe history remains")
    mode.add_argument("--repair", action="store_true", help="Quarantine unsafe points and rewrite the store")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = read_performance_payload(args.performance)
    report = audit_payload(payload, repair=args.repair)
    if args.repair and report["affected_tracks"]:
        manifest = payload.get("track_shards")
        shard_count = (
            int(manifest.get("shard_count"))
            if isinstance(manifest, Mapping) and manifest.get("shard_count")
            else 16
        )
        report["performance_store"] = write_performance_payload(
            args.performance,
            payload,
            shard_count=shard_count,
        )
        validated = validate_performance_store(args.performance)
        report["validated_tracks"] = validated["tracks_total"]
    if args.browse:
        report["browse"] = audit_browse_payload(payload, read_browse_payload(args.browse))
    print(json.dumps({"spotify_counter_integrity": report}, ensure_ascii=False))
    browse_mismatches = int((report.get("browse") or {}).get("mismatches") or 0)
    return 1 if args.check and (report["affected_tracks"] or browse_mismatches) else 0


if __name__ == "__main__":
    raise SystemExit(main())
