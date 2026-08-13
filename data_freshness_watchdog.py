#!/usr/bin/env python3
"""Detect stale public radar data and safely dispatch its existing collectors.

The checker deliberately reads only source-owned timestamps.  It never uses a
file modification time or manufactures a successful observation.  All daily
deadlines are evaluated in Europe/Paris, including daylight-saving changes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

from generate_youtube_recommendation_pool import GENERATOR_VERSION, POOL_PREFIX
from spotify_performance_store import PerformanceStoreError, read_performance_payload


PARIS = ZoneInfo("Europe/Paris")
ACTIVE_RUN_STATES = {"queued", "in_progress", "pending", "requested", "waiting"}
COLLECTION_EVENTS = {"schedule", "workflow_dispatch", "repository_dispatch", "push", "workflow_run"}
YOUTUBE_SNAPSHOT_PREFIX = "window.LOFI_DATA="
YOUTUBE_CARD_BUCKETS = ("all", "trends", "news", "ours", "kids")


@dataclass(frozen=True)
class Target:
    name: str
    workflow: str
    cooldown_minutes: int
    inputs: Mapping[str, str]


TARGETS: dict[str, Target] = {
    "spotify_core": Target(
        "spotify_core",
        "refresh-soundcharts.yml",
        180,
        {"scope": "strict_rebaseline", "max_requests": "6000", "freshness_gate": "true"},
    ),
    "spotify_followers": Target(
        "spotify_followers",
        "refresh-playlist-followers.yml",
        75,
        {"force": "false"},
    ),
    "spotify_browse": Target(
        "spotify_browse",
        "refresh-spotify-browse-catalogue.yml",
        30,
        {"force": "false"},
    ),
    "youtube_radar": Target(
        "youtube_radar",
        "refresh-instrumental-radar.yml",
        45,
        {"force": "false"},
    ),
    "youtube_recommendations": Target(
        "youtube_recommendations",
        "refresh-youtube-recommendations.yml",
        45,
        {},
    ),
    "youtube_channels": Target(
        "youtube_channels",
        "refresh-channel-radar.yml",
        120,
        {"force": "false"},
    ),
}


@dataclass(frozen=True)
class Freshness:
    target: str
    workflow: str
    due: bool
    reason: str
    observed_at: str | None
    cooldown_minutes: int
    inputs: Mapping[str, str]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_now(value: str | None) -> datetime:
    if not value:
        return utc_now()
    parsed = parse_timestamp(value)
    if parsed is None:
        raise ValueError(f"invalid --now value: {value}")
    return parsed


def parse_timestamp(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) or str(value).isdigit():
        raw = float(value)
        if raw > 10_000_000_000:
            raw /= 1000
        try:
            return datetime.fromtimestamp(raw, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_edge(path: Path, *, head: int = 0, tail: int = 0) -> str:
    if not path.exists():
        return ""
    size = path.stat().st_size
    with path.open("rb") as handle:
        chunks: list[bytes] = []
        if head:
            chunks.append(handle.read(min(head, size)))
        if tail and size > head:
            handle.seek(max(0, size - tail))
            chunks.append(handle.read(tail))
    return b"\n".join(chunks).decode("utf-8", errors="replace")


def regex_value(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text, flags=re.DOTALL)
    return match.group(1) if match else None


def local_day(value: datetime | None) -> date | None:
    return value.astimezone(PARIS).date() if value else None


def after_local_deadline(now: datetime, deadline: time) -> bool:
    return now.astimezone(PARIS).time().replace(tzinfo=None) >= deadline


def freshness_row(target: Target, due: bool, reason: str, observed: datetime | None) -> Freshness:
    return Freshness(
        target=target.name,
        workflow=target.workflow,
        due=due,
        reason=reason,
        observed_at=iso(observed),
        cooldown_minutes=target.cooldown_minutes,
        inputs=target.inputs,
    )


def read_youtube_snapshot(path: Path) -> Mapping[str, Any]:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith(YOUTUBE_SNAPSHOT_PREFIX):
        raise ValueError("unsupported Lofi_Radar_data.js assignment")
    payload = json.loads(raw[len(YOUTUBE_SNAPSHOT_PREFIX):].rstrip(";\n "))
    if not isinstance(payload, Mapping):
        raise ValueError("YouTube snapshot payload is not an object")
    return payload


def metric_int(metrics: Mapping[str, Any], key: str) -> int:
    value = metrics.get(key)
    if isinstance(value, bool):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def metric_day(metrics: Mapping[str, Any], key: str) -> date | None:
    try:
        return date.fromisoformat(str(metrics.get(key) or ""))
    except ValueError:
        return None


def youtube_card_history_problem(
    root: Path,
    snapshot: Mapping[str, Any],
    standard_day: date,
    kids_day: date,
) -> str | None:
    """Return the first publication-blocking card/history inconsistency."""

    data = snapshot.get("d")
    if not isinstance(data, Mapping):
        return "YouTube snapshot has no card catalogue"
    metrics = snapshot.get("videoMetrics")
    unavailable = {
        str(value)
        for value in (metrics.get("unavailable_ids") or [])
    } if isinstance(metrics, Mapping) else set()

    card_rows: dict[str, list[tuple[str, Mapping[str, Any]]]] = {}
    invalid_rows = 0
    for bucket in YOUTUBE_CARD_BUCKETS:
        rows = data.get(bucket) or []
        if not isinstance(rows, list):
            return f'YouTube card bucket "{bucket}" is invalid'
        for row in rows:
            if not isinstance(row, Mapping):
                invalid_rows += 1
                continue
            video_id = str(row.get("vid") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                invalid_rows += 1
                continue
            if video_id in unavailable:
                continue
            card_rows.setdefault(video_id, []).append((bucket, row))

    if invalid_rows:
        return f"YouTube snapshot contains {invalid_rows} card rows without a valid video id"
    if not card_rows:
        return "YouTube snapshot has no visible card rows"

    history_cache: dict[str, Mapping[str, Any] | None] = {}
    missing: set[str] = set()
    stale: set[str] = set()
    mismatched: set[str] = set()
    for video_id, rows in card_rows.items():
        shard_name = f"{ord(video_id[0]):02x}.json"
        if shard_name not in history_cache:
            shard_path = root / "video_history" / shard_name
            try:
                shard = json.loads(shard_path.read_text(encoding="utf-8"))
                history_cache[shard_name] = shard.get("d") if isinstance(shard, Mapping) else None
            except (OSError, ValueError, json.JSONDecodeError):
                history_cache[shard_name] = None
        shard_data = history_cache[shard_name]
        points = shard_data.get(video_id) if isinstance(shard_data, Mapping) else None
        if not isinstance(points, list) or not points:
            missing.add(video_id)
            continue
        valid_points = [
            point
            for point in points
            if isinstance(point, list) and len(point) >= 2 and parse_timestamp(point[0]) is not None
        ]
        if not valid_points:
            missing.add(video_id)
            continue
        latest = max(valid_points, key=lambda point: parse_timestamp(point[0]) or datetime.min.replace(tzinfo=timezone.utc))
        latest_time = parse_timestamp(latest[0])
        try:
            latest_views = int(latest[1])
        except (TypeError, ValueError):
            missing.add(video_id)
            continue
        expected_days = {kids_day if bucket == "kids" else standard_day for bucket, _row in rows}
        if latest_time is None or local_day(latest_time) not in expected_days:
            stale.add(video_id)
        for _bucket, row in rows:
            try:
                card_views = int(row.get("views"))
            except (TypeError, ValueError):
                mismatched.add(video_id)
                continue
            if card_views != latest_views:
                mismatched.add(video_id)

    if missing:
        sample = ", ".join(sorted(missing)[:3])
        return f"YouTube history is missing for {len(missing)} visible card videos ({sample})"
    if stale:
        sample = ", ".join(sorted(stale)[:3])
        return f"YouTube cards and latest history day diverge for {len(stale)} videos ({sample})"
    if mismatched:
        sample = ", ".join(sorted(mismatched)[:3])
        return f"YouTube card views and latest history disagree for {len(mismatched)} videos ({sample})"
    return None


def assess_youtube_radar(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    target = TARGETS["youtube_radar"]
    try:
        snapshot = read_youtube_snapshot(root / "Lofi_Radar_data.js")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return freshness_row(target, True, f"invalid public YouTube snapshot: {exc}", None)

    metrics = snapshot.get("videoMetrics")
    kids_metrics = snapshot.get("kidsMetrics")
    if not isinstance(metrics, Mapping):
        return freshness_row(target, True, "missing public YouTube observation", None)
    observed = parse_timestamp(snapshot.get("videoMetricsT"))
    history_day = metric_day(metrics, "history_day")
    tracked = metric_int(metrics, "tracked")
    updated = metric_int(metrics, "updated")
    history_updated = metric_int(metrics, "history_updated")
    partial = metrics.get("partial") is not False
    today = now.astimezone(PARIS).date()

    if observed is None or history_day is None:
        return freshness_row(target, True, "missing public YouTube observation", observed)
    if tracked <= 0:
        return freshness_row(target, True, "missing canonical YouTube tracked cohort", observed)
    if updated != tracked:
        return freshness_row(target, True, f"YouTube coverage is partial at {updated}/{tracked}", observed)
    if history_updated != updated:
        return freshness_row(
            target,
            True,
            f"YouTube history coverage is only {history_updated}/{updated}",
            observed,
        )
    if partial:
        return freshness_row(target, True, "YouTube snapshot is marked partial", observed)
    if metrics.get("day_timezone") != "Europe/Paris":
        return freshness_row(target, True, "YouTube history timezone is not Europe/Paris", observed)

    card_rows_expected = metric_int(metrics, "card_rows_expected")
    card_rows_updated = metric_int(metrics, "card_rows_updated")
    if card_rows_expected <= 0:
        return freshness_row(target, True, "missing YouTube card-row coverage proof", observed)
    if card_rows_updated != card_rows_expected:
        return freshness_row(
            target,
            True,
            f"YouTube card-row coverage is only {card_rows_updated}/{card_rows_expected}",
            observed,
        )
    sheet_ours_expected = metric_int(metrics, "sheet_ours_expected")
    sheet_ours_updated = metric_int(metrics, "sheet_ours_updated")
    if sheet_ours_expected <= 0:
        return freshness_row(target, True, "missing canonical Our Videos coverage proof", observed)
    if sheet_ours_updated != sheet_ours_expected:
        return freshness_row(
            target,
            True,
            f"Our Videos coverage is only {sheet_ours_updated}/{sheet_ours_expected}",
            observed,
        )
    analysis_rows_expected = metric_int(metrics, "analysis_rows_expected")
    analysis_rows_updated = metric_int(metrics, "analysis_rows_updated")
    if analysis_rows_expected <= 0:
        return freshness_row(target, True, "missing visible Analyse coverage proof", observed)
    if analysis_rows_updated != analysis_rows_expected:
        return freshness_row(
            target,
            True,
            f"visible Analyse coverage is only {analysis_rows_updated}/{analysis_rows_expected}",
            observed,
        )

    if not isinstance(kids_metrics, Mapping):
        return freshness_row(target, True, "missing daily YouTube Kids observation", observed)
    kids_observed = parse_timestamp(snapshot.get("kidsMetricsT"))
    kids_day = metric_day(kids_metrics, "history_day")
    kids_tracked = metric_int(kids_metrics, "tracked")
    kids_updated = metric_int(kids_metrics, "updated")
    kids_history_updated = metric_int(kids_metrics, "history_updated")
    if kids_observed is None or kids_day is None:
        return freshness_row(target, True, "missing daily YouTube Kids observation", kids_observed or observed)
    if kids_tracked <= 0:
        return freshness_row(target, True, "missing canonical YouTube Kids tracked cohort", kids_observed)
    if kids_updated != kids_tracked:
        return freshness_row(
            target,
            True,
            f"YouTube Kids coverage is partial at {kids_updated}/{kids_tracked}",
            kids_observed,
        )
    if kids_history_updated != kids_updated:
        return freshness_row(
            target,
            True,
            f"YouTube Kids history coverage is only {kids_history_updated}/{kids_updated}",
            kids_observed,
        )
    if kids_metrics.get("partial") is not False:
        return freshness_row(target, True, "YouTube Kids snapshot is marked partial", kids_observed)
    if kids_metrics.get("day_timezone") != "Europe/Paris":
        return freshness_row(target, True, "YouTube Kids history timezone is not Europe/Paris", kids_observed)

    card_problem = youtube_card_history_problem(root, snapshot, history_day, kids_day)
    if card_problem:
        return freshness_row(target, True, card_problem, observed)
    if now - observed > timedelta(hours=30):
        return freshness_row(target, True, "public YouTube observation is older than 30 hours", observed)
    if now - kids_observed > timedelta(hours=30):
        return freshness_row(target, True, "public YouTube Kids observation is older than 30 hours", kids_observed)
    if history_day < today and (ignore_deadline or after_local_deadline(now, time(10, 30))):
        return freshness_row(target, True, f"no public YouTube observation for Paris day {today}", observed)
    if kids_day < today and (ignore_deadline or after_local_deadline(now, time(10, 30))):
        return freshness_row(target, True, f"no public YouTube Kids observation for Paris day {today}", kids_observed)
    return freshness_row(
        target,
        False,
        f"public YouTube and Kids day {history_day}/{kids_day} is healthy; cards {card_rows_updated}/{card_rows_expected}",
        min(observed, kids_observed),
    )


def assess_youtube_recommendations(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    del ignore_deadline
    target = TARGETS["youtube_recommendations"]
    snapshot_text = read_edge(root / "Lofi_Radar_data.js", tail=96_000)
    snapshot_source = int(regex_value(snapshot_text, r'"videoMetricsT"\s*:\s*(\d+)') or 0)
    pool_path = root / "Lofi_Radar_recommendation_pool.js"
    manifest_path = root / "youtube_recommendation_ledger" / "manifest.json"
    if snapshot_source <= 0:
        return freshness_row(target, True, "missing factual YouTube source timestamp", None)
    if not pool_path.exists() or not manifest_path.exists():
        return freshness_row(target, True, "missing recommendation pool or ledger manifest", None)

    try:
        pool_raw = pool_path.read_text(encoding="utf-8").strip()
        if not pool_raw.startswith(POOL_PREFIX):
            raise ValueError("unsupported recommendation pool assignment")
        pool = json.loads(pool_raw[len(POOL_PREFIX):].rstrip(";\n "))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(pool, dict) or not isinstance(manifest, dict):
            raise ValueError("recommendation pool and manifest must be objects")
        pool_version = int(pool.get("version") or 0)
        manifest_version = int(manifest.get("generatorVersion") or 0)
        pool_source = int(pool.get("sourceT") or 0)
        manifest_source = int(manifest.get("sourceT") or 0)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        return freshness_row(target, True, f"invalid recommendation state: {exc}", None)

    observed = parse_timestamp(manifest.get("updatedAt"))
    pool_revision = str(pool.get("ledgerRevision") or "")
    manifest_revision = str(manifest.get("revision") or "")
    build_id = str(pool.get("buildId") or "")

    if pool_version != GENERATOR_VERSION or manifest_version != GENERATOR_VERSION:
        return freshness_row(
            target,
            True,
            f"recommendation generator version is {pool_version}/{manifest_version}, expected {GENERATOR_VERSION}",
            observed,
        )
    if pool_source != snapshot_source or manifest_source != snapshot_source:
        return freshness_row(
            target,
            True,
            f"recommendations use source {pool_source}/{manifest_source}, factual source is {snapshot_source}",
            observed,
        )
    if not pool_revision or pool_revision != manifest_revision:
        return freshness_row(target, True, "recommendation pool and ledger revisions differ", observed)
    if not build_id:
        return freshness_row(target, True, "recommendation pool has no buildId", observed)
    if observed is None:
        return freshness_row(target, True, "recommendation ledger has no valid updatedAt", observed)
    if now - observed > timedelta(hours=9):
        return freshness_row(target, True, "recommendation pool is older than nine hours", observed)
    return freshness_row(
        target,
        False,
        f"recommendation build {build_id} matches factual source and ledger {manifest_revision}",
        observed,
    )


def performance_freshness(root: Path) -> dict[str, datetime | int | None | str]:
    text = read_edge(root / "Spotify_Performance_data.js", tail=96_000)
    values: dict[str, datetime | int | None | str] = {}
    for key in ("tracks_catalogue_at", "artists_catalogue_at", "playlists_at"):
        values[key] = parse_timestamp(regex_value(text, rf'"{key}"\s*:\s*"([^"]+)"'))
    try:
        payload = read_performance_payload(root / "Spotify_Performance_data.js")
        values["store_error"] = (
            None
            if isinstance(payload.get("track_shards"), Mapping)
            else "legacy performance store is not sharded"
        )
        coverage = payload.get("maintenance_coverage")
        tracks = coverage.get("tracks") if isinstance(coverage, Mapping) else None
        policy = tracks.get("policy") if isinstance(tracks, Mapping) else None
        reasons = policy.get("reason_coverage") if isinstance(policy, Mapping) else None
        published = reasons.get("published_public") if isinstance(reasons, Mapping) else None
        if isinstance(published, Mapping):
            values["published_public_expected"] = int(published.get("expected_requests") or 0)
            values["published_public_selected"] = int(published.get("selected_requests") or 0)
            values["published_public_missing"] = int(published.get("missing_requests") or 0)
        else:
            values["published_public_expected"] = None
            values["published_public_selected"] = None
            values["published_public_missing"] = None
        entities = policy.get("published_public_entity_coverage") if isinstance(policy, Mapping) else None
        if isinstance(entities, Mapping):
            for key in (
                "public_entities",
                "resolvable_entities",
                "unresolved_entities",
                "selected_entities",
                "missing_selected_entities",
                "current_source_entities",
                "lagging_source_entities",
            ):
                output_key = (
                    "published_public_entities"
                    if key == "public_entities"
                    else f"published_public_{key}"
                )
                values[output_key] = int(entities.get(key) or 0)
        else:
            values["published_public_resolvable_entities"] = None
            values["published_public_selected_entities"] = None
            values["published_public_current_source_entities"] = None
            values["published_public_lagging_source_entities"] = None
    except PerformanceStoreError as exc:
        values["store_error"] = str(exc)
    return values


def assess_spotify_core(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    target = TARGETS["spotify_core"]
    values = performance_freshness(root)
    if values.get("store_error"):
        return freshness_row(target, True, f"Spotify performance store invalid: {values['store_error']}", None)
    required = [values.get("tracks_catalogue_at"), values.get("artists_catalogue_at")]
    if any(value is None for value in required):
        return freshness_row(target, True, "missing Spotify catalogue freshness timestamp", None)
    oldest = min(value for value in required if value is not None)
    today = now.astimezone(PARIS).date()
    if now - oldest > timedelta(hours=36):
        return freshness_row(target, True, "Spotify catalogue is older than 36 hours", oldest)
    if local_day(oldest) < today and (ignore_deadline or after_local_deadline(now, time(13, 45))):
        return freshness_row(target, True, f"no complete Spotify catalogue pass for Paris day {today}", oldest)
    public_expected = values.get("published_public_expected")
    public_selected = values.get("published_public_selected")
    public_missing = values.get("published_public_missing")
    if public_expected is None:
        return freshness_row(
            target,
            True,
            "missing proof that the public Spotify track cohort was scheduled",
            oldest,
        )
    if public_selected != public_expected or public_missing != 0:
        return freshness_row(
            target,
            True,
            f"public Spotify track coverage is partial at {public_selected}/{public_expected}",
            oldest,
        )
    resolvable = values.get("published_public_resolvable_entities")
    public_entities = values.get("published_public_entities")
    selected_entities = values.get("published_public_selected_entities")
    current_entities = values.get("published_public_current_source_entities")
    lagging_entities = values.get("published_public_lagging_source_entities")
    if resolvable is None or current_entities is None:
        return freshness_row(
            target,
            True,
            "missing proof that public Spotify histories reached a recent source day",
            oldest,
        )
    if not isinstance(public_entities, int) or public_entities <= 0:
        return freshness_row(
            target,
            True,
            "public Spotify track cohort is unexpectedly empty",
            oldest,
        )
    if selected_entities != resolvable:
        return freshness_row(
            target,
            True,
            f"public Spotify entity scheduling is partial at {selected_entities}/{resolvable}",
            oldest,
        )
    allowed_source_lag = max(10, (int(resolvable) + 99) // 100)
    if int(lagging_entities or 0) > allowed_source_lag:
        return freshness_row(
            target,
            True,
            f"public Spotify histories are current for only {current_entities}/{resolvable}",
            oldest,
        )
    unresolved = int(values.get("published_public_unresolved_entities") or 0)
    return freshness_row(
        target,
        False,
        (
            f"Spotify catalogue day {local_day(oldest)} is healthy; "
            f"public histories current at {current_entities}/{resolvable}, "
            f"unresolved identities {unresolved}"
        ),
        oldest,
    )


def assess_spotify_followers(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    target = TARGETS["spotify_followers"]
    text = read_edge(root / "Spotify_Playlists_canonical_data.js", head=8_192)
    block = regex_value(text, r'"playlist_followers_status"\s*:\s*\{([^{}]+)\}') or ""
    day_raw = regex_value(block, r'"day"\s*:\s*"(\d{4}-\d{2}-\d{2})"')
    observed = parse_timestamp(regex_value(block, r'"observed_at"\s*:\s*"([^"]+)"'))
    complete = regex_value(block, r'"complete"\s*:\s*(true|false)') == "true"
    expected = int(regex_value(block, r'"expected"\s*:\s*(\d+)') or 0)
    updated = int(regex_value(block, r'"updated"\s*:\s*(\d+)') or 0)
    try:
        measured_day = date.fromisoformat(day_raw) if day_raw else None
    except ValueError:
        measured_day = None
    today = now.astimezone(PARIS).date()

    if measured_day == today and complete and expected > 0 and updated == expected:
        return freshness_row(target, False, f"playlist followers complete at {updated}/{expected}", observed)
    if measured_day is None or measured_day < today - timedelta(days=1):
        return freshness_row(target, True, "playlist follower history is more than one Paris day behind", observed)
    if ignore_deadline or after_local_deadline(now, time(10, 0)):
        return freshness_row(
            target,
            True,
            f"playlist followers incomplete for {today}: {updated}/{expected}",
            observed,
        )
    return freshness_row(target, False, "playlist follower morning deadline has not passed", observed)


def active_snapshot_name(root: Path) -> str | None:
    text = (root / "spotify" / "index.html").read_text(encoding="utf-8", errors="replace")
    matches = re.findall(r'(Spotify_Soundcharts_data_\d{8}T\d{6}Z\.js)', text)
    return matches[-1] if matches else None


def assess_spotify_browse(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    del now
    del ignore_deadline
    target = TARGETS["spotify_browse"]
    text = read_edge(root / "Spotify_Browse_Catalogue_data.js", head=8_192)
    source = regex_value(text, r'"source_snapshot"\s*:\s*"([^"]+)"')
    observed = parse_timestamp(regex_value(text, r'"generated_at"\s*:\s*"([^"]+)"'))
    active = active_snapshot_name(root)
    if not active or not source:
        return freshness_row(target, True, "missing active Spotify browse source", observed)
    if source != active:
        return freshness_row(target, True, f"browse catalogue uses {source}, active snapshot is {active}", observed)
    return freshness_row(target, False, "browse catalogue matches the active Spotify snapshot", observed)


def assess_youtube_channels(root: Path, now: datetime, ignore_deadline: bool = False) -> Freshness:
    target = TARGETS["youtube_channels"]
    text = read_edge(root / "Lofi_Radar_chx.js", head=4_096)
    observed = parse_timestamp(regex_value(text, r'window\.CHX\s*=\s*\{\s*"t"\s*:\s*(\d+)'))
    local = now.astimezone(PARIS)
    if observed is None:
        return freshness_row(target, True, "missing YouTube channel-radar timestamp", observed)
    observed_local = observed.astimezone(PARIS)
    current_month = (local.year, local.month)
    observed_month = (observed_local.year, observed_local.month)
    deadline_passed = ignore_deadline or local.day > 1 or (local.day == 1 and local.time().replace(tzinfo=None) >= time(10, 30))
    if observed_month < current_month and deadline_passed:
        return freshness_row(target, True, "monthly YouTube channel radar is not current", observed)
    if now - observed > timedelta(days=45):
        return freshness_row(target, True, "monthly YouTube channel radar is older than 45 days", observed)
    return freshness_row(target, False, f"YouTube channel radar month {observed_local:%Y-%m} is healthy", observed)


ASSESSORS = {
    "spotify_core": assess_spotify_core,
    "spotify_followers": assess_spotify_followers,
    "spotify_browse": assess_spotify_browse,
    "youtube_radar": assess_youtube_radar,
    "youtube_recommendations": assess_youtube_recommendations,
    "youtube_channels": assess_youtube_channels,
}


def assess(
    root: Path,
    now: datetime,
    targets: Iterable[str] | None = None,
    *,
    ignore_deadline: bool = False,
) -> list[Freshness]:
    selected = list(targets or TARGETS)
    return [ASSESSORS[name](root, now, ignore_deadline) for name in selected]


class GitHubActionsClient:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token
        self.base = f"https://api.github.com/repos/{repository}"

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{self.base}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "User-Agent": "radar-data-freshness-watchdog",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API {method} {path} failed: {error.code} {detail}") from error
        return json.loads(raw) if raw else None

    def runs(self, workflow: str) -> list[Mapping[str, Any]]:
        encoded = urllib.parse.quote(workflow, safe="")
        payload = self.request("GET", f"/actions/workflows/{encoded}/runs?per_page=30") or {}
        return list(payload.get("workflow_runs") or [])

    def dispatch(self, workflow: str, inputs: Mapping[str, str]) -> None:
        encoded = urllib.parse.quote(workflow, safe="")
        self.request("POST", f"/actions/workflows/{encoded}/dispatches", {"ref": "main", "inputs": dict(inputs)})


def parse_run_time(row: Mapping[str, Any]) -> datetime | None:
    return parse_timestamp(row.get("created_at") or row.get("run_started_at"))


def dispatch_decision(status: Freshness, runs: Iterable[Mapping[str, Any]], now: datetime) -> tuple[bool, str]:
    if not status.due:
        return False, "fresh"
    relevant = [row for row in runs if str(row.get("event") or "") in COLLECTION_EVENTS]
    if any(str(row.get("status") or "") in ACTIVE_RUN_STATES for row in relevant):
        return False, "active run already exists"
    recent_times = [value for value in (parse_run_time(row) for row in relevant) if value is not None]
    latest = max(recent_times, default=None)
    if latest is not None and now - latest < timedelta(minutes=status.cooldown_minutes):
        remaining = timedelta(minutes=status.cooldown_minutes) - (now - latest)
        return False, f"cooldown active for {max(1, int(remaining.total_seconds() // 60))} more minutes"
    six_hours_ago = now - timedelta(hours=6)
    attempts = sum(1 for value in recent_times if value >= six_hours_ago)
    # A delayed upstream Soundcharts source day can make an otherwise complete
    # pass look stale. Permit one bounded repair after the scheduled attempt,
    # then stop instead of repeating the same paid calls three times.
    attempt_ceiling = 2 if "histories are current for only" in status.reason else 3
    if attempts >= attempt_ceiling:
        return False, f"retry ceiling reached ({attempt_ceiling} collection attempts in 6 hours)"
    return True, "stale and eligible for repair"


def dispatch_due(rows: Iterable[Freshness], client: GitHubActionsClient, now: datetime) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for row in rows:
        runs = client.runs(row.workflow) if row.due else []
        should_dispatch, decision = dispatch_decision(row, runs, now)
        if should_dispatch:
            client.dispatch(row.workflow, row.inputs)
        results.append(
            {
                "target": row.target,
                "due": row.due,
                "dispatched": should_dispatch,
                "decision": decision,
                "reason": row.reason,
            }
        )
    return results


def write_github_output(path: Path, row: Freshness) -> None:
    values = {
        "due": str(row.due).lower(),
        "reason": row.reason.replace("\n", " "),
        "observed_at": row.observed_at or "",
    }
    with path.open("a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def write_step_summary(path: Path, rows: Iterable[Freshness], dispatch: Iterable[Mapping[str, Any]] | None) -> None:
    decisions = {str(row.get("target")): row for row in (dispatch or [])}
    lines = [
        "## Radar data freshness",
        "",
        "| Target | Source state | Watchdog action |",
        "| --- | --- | --- |",
    ]
    for row in rows:
        decision = decisions.get(row.target, {})
        action = str(decision.get("decision") or ("repair required" if row.due else "fresh"))
        state = f"stale: {row.reason}" if row.due else row.reason
        lines.append(f"| {row.target} | {state.replace('|', '/')} | {action.replace('|', '/')} |")
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    result.add_argument("--now", help="UTC/offset-aware ISO timestamp for deterministic checks")
    result.add_argument("--target", action="append", choices=sorted(TARGETS))
    result.add_argument("--github-output", type=Path)
    result.add_argument("--print-due", action="store_true", help="print only true/false for one target")
    result.add_argument(
        "--fail-if-due",
        action="store_true",
        help="exit non-zero when any selected source fails its freshness or integrity guard",
    )
    result.add_argument(
        "--scheduled-check",
        action="store_true",
        help="collector cron: require the current Paris day/month without watchdog grace",
    )
    result.add_argument("--dispatch", action="store_true", help="dispatch stale collectors after anti-duplicate checks")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    now = parse_now(args.now)
    rows = assess(args.root, now, args.target, ignore_deadline=args.scheduled_check)
    if args.print_due:
        if len(rows) != 1:
            raise SystemExit("--print-due requires exactly one --target")
        print(str(rows[0].due).lower())
        return 0
    if args.github_output:
        if len(rows) != 1:
            raise SystemExit("--github-output requires exactly one --target")
        write_github_output(args.github_output, rows[0])

    payload: dict[str, Any] = {"checked_at": iso(now), "timezone": "Europe/Paris", "targets": [asdict(row) for row in rows]}
    dispatch_results: list[dict[str, Any]] | None = None
    if args.dispatch:
        repository = os.environ.get("GITHUB_REPOSITORY", "")
        token = os.environ.get("GITHUB_TOKEN", "")
        if not repository or not token:
            raise SystemExit("--dispatch requires GITHUB_REPOSITORY and GITHUB_TOKEN")
        dispatch_results = dispatch_due(rows, GitHubActionsClient(repository, token), now)
        payload["dispatch"] = dispatch_results
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        write_step_summary(Path(summary), rows, dispatch_results)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if dispatch_results and any("retry ceiling" in str(row.get("decision")) for row in dispatch_results):
        print("A stale target exceeded the automatic retry ceiling.", file=sys.stderr)
        return 2
    if args.fail_if_due and any(row.due for row in rows):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

