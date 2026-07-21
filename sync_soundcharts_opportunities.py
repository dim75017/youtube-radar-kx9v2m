#!/usr/bin/env python3
"""Keep Spotify Radar's track-first A&R opportunity export live.

The licensed Soundcharts collector refreshes the large artist/track catalogue and
``Spotify_Performance_data.js``.  The public ``#opps`` view, however, consumes a
separate, stricter ``opportunities`` array.  This bridge restores that reviewed
strict allow-list when an upstream refresh omits it, then refreshes only its
measured stream fields from the current catalogue and daily history.

No opportunity is invented from the broad catalogue.  Classification, rights,
editorial evidence and artist identity always come from the reviewed seed (or a
newer existing opportunity export).  Only counters, daily deltas and the two
counter-based score components are updated here.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
from pathlib import Path
from typing import Any, Iterable


SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
DEFAULT_SEED = Path("Spotify_Soundcharts_data_20260720T0217_editorial_strict.js")

METRIC_FIELDS = (
    "streams",
    "streams_source_date",
    "streams_observed_at",
    "streams_delta_24h",
    "delta_previous_source_date",
    "delta_previous_observed_at",
    "delta_window_hours",
)


class OpportunitySyncError(RuntimeError):
    """Raised when the strict opportunity bridge cannot produce safe output."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_js_payload(path: Path, prefix: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise OpportunitySyncError(f"{path} does not start with {prefix[:-1]}")
    try:
        payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise OpportunitySyncError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise OpportunitySyncError(f"{path} does not contain an object payload")
    return payload


def write_js_payload(path: Path, payload: dict[str, Any], prefix: str) -> None:
    path.write_text(prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def index_of(schema: list[str], name: str) -> int | None:
    try:
        return schema.index(name)
    except ValueError:
        return None


def field(row: Any, schema: list[str], name: str) -> Any:
    if isinstance(row, dict):
        return row.get(name)
    index = index_of(schema, name)
    return row[index] if index is not None and isinstance(row, list) and index < len(row) else None


def set_field(row: Any, schema: list[str], name: str, value: Any) -> None:
    if isinstance(row, dict):
        row[name] = value
        return
    index = index_of(schema, name)
    if index is None:
        raise OpportunitySyncError(f"Opportunity schema is missing {name}")
    if not isinstance(row, list):
        raise OpportunitySyncError("Opportunity rows must be arrays or objects")
    while len(row) <= index:
        row.append(None)
    row[index] = value


def ensure_fields(schema: list[str], rows: list[Any], names: Iterable[str]) -> None:
    for name in names:
        if name in schema:
            continue
        schema.append(name)
        for row in rows:
            if isinstance(row, list):
                row.append(None)


def number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return value
    return None


def normalize_day(value: Any) -> str | None:
    day = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(day).isoformat()
    except ValueError:
        return None


def previous_day(day: str) -> str:
    return (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()


def normalize_history(raw: Any) -> list[list[Any]]:
    daily: dict[str, int] = {}
    if not isinstance(raw, list):
        return []
    for point in raw:
        if isinstance(point, list) and len(point) >= 2:
            raw_day, raw_value = point[0], point[1]
        elif isinstance(point, dict):
            raw_day, raw_value = point.get("date"), point.get("value")
        else:
            continue
        day = normalize_day(raw_day)
        value = number(raw_value)
        if day and value is not None:
            daily[day] = int(value)
    return [[day, daily[day]] for day in sorted(daily)]


def row_map(payload: dict[str, Any], group: str, key_name: str) -> tuple[list[str], dict[str, Any]]:
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), dict) else {}
    schema = list(schemas.get(group, [])) if isinstance(schemas.get(group), list) else []
    rows = payload.get(group, []) if isinstance(payload.get(group), list) else []
    mapped: dict[str, Any] = {}
    for row in rows:
        key = str(field(row, schema, key_name) or "")
        if key:
            mapped[key] = row
    return schema, mapped


def metric_snapshot(
    spotify_id: str,
    track_row: Any,
    track_schema: list[str],
    performance_entry: Any,
    fallback_observed_at: str | None,
) -> dict[str, Any]:
    """Return the freshest counter plus an exact 24-hour baseline when available."""

    entry = performance_entry if isinstance(performance_entry, dict) else {}
    history = normalize_history(entry.get("history"))
    history_by_day = {day: value for day, value in history}
    history_day = history[-1][0] if history else None
    history_value = history[-1][1] if history else None

    track_day = normalize_day(field(track_row, track_schema, "source_date")) if track_row is not None else None
    track_value = number(field(track_row, track_schema, "streams")) if track_row is not None else None

    use_history = history_day is not None and (track_day is None or history_day >= track_day)
    source_day = history_day if use_history else track_day
    stream_value = history_value if use_history else track_value
    if stream_value is None and history_value is not None:
        source_day, stream_value = history_day, history_value
    if stream_value is None and track_value is not None:
        source_day, stream_value = track_day, track_value

    observed_at = (
        entry.get("observed_at")
        or (field(track_row, track_schema, "observed_at") if track_row is not None else None)
        or fallback_observed_at
    )

    delta: int | float | None = None
    baseline_day: str | None = None
    baseline_observed_at: str | None = None
    if source_day and stream_value is not None:
        wanted = previous_day(source_day)
        if wanted in history_by_day:
            baseline_day = wanted
            delta = int(stream_value) - history_by_day[wanted]
            baseline_observed_at = entry.get("previous_observed_at")
        elif track_row is not None:
            candidate_day = normalize_day(field(track_row, track_schema, "previous_source_date"))
            candidate_delta = number(field(track_row, track_schema, "delta"))
            if candidate_day == wanted and candidate_delta is not None:
                baseline_day = candidate_day
                delta = candidate_delta

    return {
        "spotify_id": spotify_id,
        "streams": int(stream_value) if stream_value is not None else None,
        "source_date": source_day,
        "observed_at": observed_at,
        "delta_24h": int(delta) if delta is not None else None,
        "previous_source_date": baseline_day,
        "previous_observed_at": baseline_observed_at,
        "delta_window_hours": 24 if baseline_day and delta is not None else None,
        "history_points": len(history),
    }


def momentum_score(delta: int | float | None) -> int:
    if delta is None or delta <= 0:
        return 0
    if delta >= 500_000:
        return 35
    if delta >= 100_000:
        return 30
    if delta >= 25_000:
        return 24
    if delta >= 5_000:
        return 18
    if delta >= 1_000:
        return 12
    return 6


def traction_score(streams: int | float | None) -> int:
    if streams is None or streams <= 0:
        return 0
    if streams >= 100_000_000:
        return 25
    if streams >= 10_000_000:
        return 22
    if streams >= 1_000_000:
        return 18
    if streams >= 100_000:
        return 12
    if streams >= 10_000:
        return 8
    return 4


def update_reasons(row: Any, schema: list[str], snapshot: dict[str, Any]) -> None:
    codes = field(row, schema, "reason_codes")
    reasons = field(row, schema, "reasons")
    codes = list(codes) if isinstance(codes, list) else []
    reasons = list(reasons) if isinstance(reasons, list) else []
    pairs = list(zip(codes, reasons))
    pairs = [
        (code, reason)
        for code, reason in pairs
        if not str(code).startswith("streams_24h_") and str(code) != "streams_observed"
    ]

    fresh: list[tuple[str, str]] = []
    delta = snapshot.get("delta_24h")
    streams = snapshot.get("streams")
    source_day = snapshot.get("source_date")
    if delta is not None:
        direction = "positive" if delta > 0 else ("negative" if delta < 0 else "flat")
        sign = "+" if delta > 0 else ""
        fresh.append((f"streams_24h_{direction}", f"{sign}{int(delta):,} streams Spotify sur 24 h ({source_day}).".replace(",", " ")))
    if streams is not None:
        fresh.append(("streams_observed", f"{int(streams):,} streams Spotify cumulés au {source_day}.".replace(",", " ")))

    combined = fresh + pairs
    set_field(row, schema, "reason_codes", [code for code, _ in combined])
    set_field(row, schema, "reasons", [reason for _, reason in combined])


def normalize_top_playlist(row: Any, schema: list[str]) -> None:
    value = field(row, schema, "editorial_top_playlist")
    if isinstance(value, dict):
        set_field(row, schema, "editorial_top_playlist", value.get("name") or value.get("spotify_id") or "")


def synchronize_opportunities(
    current: dict[str, Any],
    seed: dict[str, Any],
    performance: dict[str, Any],
    *,
    seed_name: str,
) -> dict[str, Any]:
    current_schemas = current.setdefault("schemas", {})
    if not isinstance(current_schemas, dict):
        raise OpportunitySyncError("Current Soundcharts schemas are invalid")

    current_opportunities = current.get("opportunities")
    current_opportunity_schema = current_schemas.get("opportunities")
    restored_from_seed = not (
        isinstance(current_opportunities, list)
        and current_opportunities
        and isinstance(current_opportunity_schema, list)
        and current_opportunity_schema
    )

    if restored_from_seed:
        seed_schemas = seed.get("schemas") if isinstance(seed.get("schemas"), dict) else {}
        seed_schema = seed_schemas.get("opportunities")
        seed_rows = seed.get("opportunities")
        if not isinstance(seed_schema, list) or not seed_schema or not isinstance(seed_rows, list) or not seed_rows:
            raise OpportunitySyncError("The reviewed seed does not contain opportunities")
        opportunity_schema = copy.deepcopy(seed_schema)
        opportunities = copy.deepcopy(seed_rows)
        current_schemas["opportunities"] = opportunity_schema
        current["opportunities"] = opportunities
        if "opportunity_scoring" in seed:
            current["opportunity_scoring"] = copy.deepcopy(seed["opportunity_scoring"])
    else:
        opportunity_schema = list(current_opportunity_schema)
        opportunities = current_opportunities
        current_schemas["opportunities"] = opportunity_schema

    ensure_fields(
        opportunity_schema,
        opportunities,
        (*METRIC_FIELDS, "score", "score_momentum", "score_traction", "reason_codes", "reasons", "metadata_updated_at"),
    )

    track_schema, tracks_by_id = row_map(current, "tracks", "spotify_id")
    performance_tracks = performance.get("tracks") if isinstance(performance.get("tracks"), dict) else {}
    fallback_observed_at = str(current.get("generated_at") or performance.get("generated_at") or utc_now())

    metrics_populated = 0
    deltas_populated = 0
    missing_ids: list[str] = []
    latest_observed_at: str | None = None
    latest_source_day: str | None = None

    for row in opportunities:
        spotify_id = str(field(row, opportunity_schema, "spotify_id") or "")
        if not spotify_id:
            continue
        track_row = tracks_by_id.get(spotify_id)
        performance_entry = performance_tracks.get(spotify_id)
        if track_row is None and not isinstance(performance_entry, dict):
            missing_ids.append(spotify_id)
            continue

        snapshot = metric_snapshot(spotify_id, track_row, track_schema, performance_entry, fallback_observed_at)
        if snapshot["streams"] is None:
            missing_ids.append(spotify_id)
            continue

        set_field(row, opportunity_schema, "streams", snapshot["streams"])
        set_field(row, opportunity_schema, "streams_source_date", snapshot["source_date"])
        set_field(row, opportunity_schema, "streams_observed_at", snapshot["observed_at"])
        set_field(row, opportunity_schema, "streams_delta_24h", snapshot["delta_24h"])
        set_field(row, opportunity_schema, "delta_previous_source_date", snapshot["previous_source_date"])
        set_field(row, opportunity_schema, "delta_previous_observed_at", snapshot["previous_observed_at"])
        set_field(row, opportunity_schema, "delta_window_hours", snapshot["delta_window_hours"])

        if track_row is not None:
            metadata_updated_at = field(track_row, track_schema, "metadata_updated_at")
            if metadata_updated_at:
                set_field(row, opportunity_schema, "metadata_updated_at", metadata_updated_at)

        new_momentum = momentum_score(snapshot["delta_24h"])
        new_traction = traction_score(snapshot["streams"])
        set_field(row, opportunity_schema, "score_momentum", new_momentum)
        set_field(row, opportunity_schema, "score_traction", new_traction)
        editorial = number(field(row, opportunity_schema, "score_editorial")) or 0
        recency = number(field(row, opportunity_schema, "score_recency")) or 0
        relationship = number(field(row, opportunity_schema, "score_relationship")) or 0
        set_field(row, opportunity_schema, "score", min(100, int(new_momentum + new_traction + editorial + recency + relationship)))

        normalize_top_playlist(row, opportunity_schema)
        update_reasons(row, opportunity_schema, snapshot)
        metrics_populated += 1
        deltas_populated += int(snapshot["delta_24h"] is not None)
        if snapshot["observed_at"] and (latest_observed_at is None or str(snapshot["observed_at"]) > latest_observed_at):
            latest_observed_at = str(snapshot["observed_at"])
        if snapshot["source_date"] and (latest_source_day is None or str(snapshot["source_date"]) > latest_source_day):
            latest_source_day = str(snapshot["source_date"])

    if not opportunities:
        raise OpportunitySyncError("Opportunity export is empty")
    if metrics_populated == 0:
        raise OpportunitySyncError("No reviewed opportunity could be joined to a current stream counter")

    sync_time = utc_now()
    freshness = current.setdefault("freshness", {})
    if not isinstance(freshness, dict):
        freshness = {}
        current["freshness"] = freshness
    freshness["opportunities_at"] = latest_observed_at or sync_time
    current["opportunity_sync"] = {
        "status": "success",
        "finished_at": sync_time,
        "seed": seed_name if restored_from_seed else "existing_opportunities",
        "restored_from_seed": restored_from_seed,
        "opportunities": len(opportunities),
        "metrics_populated": metrics_populated,
        "daily_deltas_populated": deltas_populated,
        "latest_source_date": latest_source_day,
        "missing_metric_ids": missing_ids,
        "metric_source": "Spotify_Performance_data.js + current Soundcharts tracks",
    }
    return current["opportunity_sync"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    current = read_js_payload(args.soundcharts, SOUNDCHARTS_PREFIX)
    seed = read_js_payload(args.seed, SOUNDCHARTS_PREFIX)
    performance = read_js_payload(args.performance, PERFORMANCE_PREFIX)
    summary = synchronize_opportunities(current, seed, performance, seed_name=str(args.seed))
    write_js_payload(args.soundcharts, current, SOUNDCHARTS_PREFIX)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
