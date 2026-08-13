#!/usr/bin/env python3
"""Stamp and verify a complete, source-backed YouTube Kids discovery pass."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any, Mapping
from zoneinfo import ZoneInfo

from data_freshness_watchdog import (
    YOUTUBE_KIDS_EXPECTED_QUERIES,
    YOUTUBE_KIDS_EXPECTED_SEARCH_LANES,
    YOUTUBE_KIDS_MIN_RESULTS_EXAMINED,
    YOUTUBE_SNAPSHOT_PREFIX,
    parse_timestamp,
    youtube_kids_cohort_digest,
    youtube_kids_cohort_ids,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_SNAPSHOT = ROOT / "Lofi_Radar_data.js"
PARIS = ZoneInfo("Europe/Paris")


def read_snapshot(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith(YOUTUBE_SNAPSHOT_PREFIX):
        raise ValueError("unsupported Lofi_Radar_data.js assignment")
    payload = json.loads(raw[len(YOUTUBE_SNAPSHOT_PREFIX):].rstrip(";\n "))
    if not isinstance(payload, dict):
        raise ValueError("YouTube snapshot payload is not an object")
    return payload


def write_snapshot(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = (
        YOUTUBE_SNAPSHOT_PREFIX
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            Path(temporary_name).unlink()
        except OSError:
            pass
        raise


def required_int(metrics: Mapping[str, Any], key: str) -> int:
    value = metrics.get(key)
    if isinstance(value, bool):
        raise ValueError(f"Kids metric {key} is not an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Kids metric {key} is not an integer") from exc
    return parsed


def validate_discovery_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    metrics = payload.get("kidsMetrics")
    if not isinstance(metrics, Mapping):
        raise ValueError("snapshot has no Kids metrics")
    stamp = required_int(payload, "kidsMetricsT")
    observed = parse_timestamp(stamp)
    if observed is None:
        raise ValueError("Kids metrics timestamp is invalid")
    day_text = str(metrics.get("day") or "")
    history_day_text = str(metrics.get("history_day") or "")
    try:
        day = date.fromisoformat(day_text)
        history_day = date.fromisoformat(history_day_text)
    except ValueError as exc:
        raise ValueError("Kids metrics day is invalid") from exc
    if day != history_day or observed.astimezone(PARIS).date() != day:
        raise ValueError("Kids metrics timestamp and Paris history day diverge")
    if metrics.get("day_timezone") != "Europe/Paris":
        raise ValueError("Kids metrics timezone is not Europe/Paris")

    queries = required_int(metrics, "queries")
    queries_ok = required_int(metrics, "queries_ok")
    if queries != YOUTUBE_KIDS_EXPECTED_QUERIES or queries_ok != queries:
        raise ValueError(
            f"Kids query proof is {queries_ok}/{queries}, expected "
            f"{YOUTUBE_KIDS_EXPECTED_QUERIES}/{YOUTUBE_KIDS_EXPECTED_QUERIES}"
        )
    results_examined = required_int(metrics, "results_examined")
    candidates_kept = required_int(metrics, "candidates_kept")
    search_lanes_expected = required_int(metrics, "search_lanes_expected")
    search_lanes_completed = required_int(metrics, "search_lanes_completed")
    if (
        search_lanes_expected != YOUTUBE_KIDS_EXPECTED_SEARCH_LANES
        or search_lanes_completed != search_lanes_expected
    ):
        raise ValueError(
            f"Kids search lane proof is {search_lanes_completed}/"
            f"{search_lanes_expected}, expected {YOUTUBE_KIDS_EXPECTED_SEARCH_LANES}/"
            f"{YOUTUBE_KIDS_EXPECTED_SEARCH_LANES}"
        )
    if results_examined < YOUTUBE_KIDS_MIN_RESULTS_EXAMINED or candidates_kept <= 0:
        raise ValueError(
            f"Kids discovery yield/coverage is insufficient "
            f"({candidates_kept}/{results_examined}, minimum results "
            f"{YOUTUBE_KIDS_MIN_RESULTS_EXAMINED})"
        )

    cohort_ids = youtube_kids_cohort_ids(payload)
    tracked = required_int(metrics, "tracked")
    updated = required_int(metrics, "updated")
    history_updated = required_int(metrics, "history_updated")
    if tracked != len(cohort_ids) or updated != tracked or history_updated != updated:
        raise ValueError(
            f"Kids cohort coverage is tracked={tracked}, updated={updated}, "
            f"history={history_updated}, cards={len(cohort_ids)}"
        )
    if metrics.get("partial") is not False:
        raise ValueError("Kids metrics are marked partial")
    return {
        "stamp": stamp,
        "day": day.isoformat(),
        "queries": queries,
        "queries_ok": queries_ok,
        "results_examined": results_examined,
        "candidates_kept": candidates_kept,
        "search_lanes_expected": search_lanes_expected,
        "search_lanes_completed": search_lanes_completed,
        "tracked": tracked,
        "ids_digest": youtube_kids_cohort_digest(cohort_ids),
    }


def validate_stamped_discovery_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the durable discovery marker independently of newer counter refreshes."""
    metrics = payload.get("kidsMetrics")
    if not isinstance(metrics, Mapping):
        raise ValueError("snapshot has no Kids metrics")
    stamp = required_int(payload, "kidsDiscoveryT")
    observed = parse_timestamp(stamp)
    if observed is None:
        raise ValueError("Kids discovery timestamp is invalid")
    day_text = str(metrics.get("discovery_day") or "")
    try:
        day = date.fromisoformat(day_text)
    except ValueError as exc:
        raise ValueError("Kids discovery day is invalid") from exc
    if observed.astimezone(PARIS).date() != day:
        raise ValueError("Kids discovery timestamp and Paris day diverge")
    if metrics.get("discovery_complete") is not True:
        raise ValueError("Kids discovery is not marked complete")

    queries = required_int(metrics, "discovery_queries")
    queries_ok = required_int(metrics, "discovery_queries_ok")
    if queries != YOUTUBE_KIDS_EXPECTED_QUERIES or queries_ok != queries:
        raise ValueError(
            f"Kids discovery query proof is {queries_ok}/{queries}, expected "
            f"{YOUTUBE_KIDS_EXPECTED_QUERIES}/{YOUTUBE_KIDS_EXPECTED_QUERIES}"
        )
    results_examined = required_int(metrics, "discovery_results_examined")
    candidates_kept = required_int(metrics, "discovery_candidates_kept")
    search_lanes_expected = required_int(metrics, "discovery_search_lanes_expected")
    search_lanes_completed = required_int(metrics, "discovery_search_lanes_completed")
    if (
        search_lanes_expected != YOUTUBE_KIDS_EXPECTED_SEARCH_LANES
        or search_lanes_completed != search_lanes_expected
    ):
        raise ValueError(
            f"Kids discovery search lane proof is {search_lanes_completed}/"
            f"{search_lanes_expected}, expected {YOUTUBE_KIDS_EXPECTED_SEARCH_LANES}/"
            f"{YOUTUBE_KIDS_EXPECTED_SEARCH_LANES}"
        )
    if results_examined < YOUTUBE_KIDS_MIN_RESULTS_EXAMINED or candidates_kept <= 0:
        raise ValueError(
            f"Kids discovery yield/coverage is insufficient "
            f"({candidates_kept}/{results_examined}, minimum results "
            f"{YOUTUBE_KIDS_MIN_RESULTS_EXAMINED})"
        )

    cohort_ids = youtube_kids_cohort_ids(payload)
    tracked = required_int(metrics, "discovery_tracked")
    if tracked != len(cohort_ids):
        raise ValueError(
            f"Kids discovery cohort proof is {tracked}/{len(cohort_ids)}"
        )
    digest = youtube_kids_cohort_digest(cohort_ids)
    if str(metrics.get("discovery_ids_digest") or "") != digest:
        raise ValueError("Kids discovery cohort digest diverges")
    return {
        "stamp": stamp,
        "day": day.isoformat(),
        "queries": queries,
        "queries_ok": queries_ok,
        "results_examined": results_examined,
        "candidates_kept": candidates_kept,
        "search_lanes_expected": search_lanes_expected,
        "search_lanes_completed": search_lanes_completed,
        "tracked": tracked,
        "ids_digest": digest,
    }


def stamp_discovery(path: Path) -> dict[str, Any]:
    payload = read_snapshot(path)
    proof = validate_discovery_payload(payload)
    metrics = dict(payload["kidsMetrics"])
    metrics.update({
        "discovery_day": proof["day"],
        "discovery_queries": proof["queries"],
        "discovery_queries_ok": proof["queries_ok"],
        "discovery_results_examined": proof["results_examined"],
        "discovery_candidates_kept": proof["candidates_kept"],
        "discovery_search_lanes_expected": proof["search_lanes_expected"],
        "discovery_search_lanes_completed": proof["search_lanes_completed"],
        "discovery_tracked": proof["tracked"],
        "discovery_ids_digest": proof["ids_digest"],
        "discovery_complete": True,
    })
    payload["kidsDiscoveryT"] = proof["stamp"]
    payload["kidsMetrics"] = metrics
    write_snapshot(path, payload)
    result = {
        "stamped": True,
        "kidsDiscoveryT": proof["stamp"],
        "discovery_day": proof["day"],
        "queries": proof["queries"],
        "tracked": proof["tracked"],
    }
    print(json.dumps(result, separators=(",", ":")))
    return result


def verify_publication(
    base_url: str,
    snapshot: Path,
    timeout_seconds: int,
    interval_seconds: int,
) -> dict[str, Any]:
    local = read_snapshot(snapshot)
    expected = validate_stamped_discovery_payload(local)
    # The file being published must be the output of this Kids merge itself,
    # not a later standard counter refresh carrying an older discovery marker.
    source = validate_discovery_payload(local)
    if expected != source:
        raise ValueError("local Kids discovery marker does not match its source proof")
    expected_stamp = expected["stamp"]

    root = base_url.rstrip("/") + "/"
    deadline = time.monotonic() + max(1, timeout_seconds)
    last_error = "not attempted"
    while time.monotonic() < deadline:
        query = urllib.parse.urlencode({
            "kidsDiscovery": expected_stamp,
            "attempt": int(time.time()),
        })
        try:
            with urllib.request.urlopen(
                root + "Lofi_Radar_data.js?" + query,
                timeout=30,
            ) as response:
                raw = response.read().decode("utf-8")
            if not raw.strip().startswith(YOUTUBE_SNAPSHOT_PREFIX):
                raise ValueError("served YouTube snapshot assignment is malformed")
            remote = json.loads(
                raw.strip()[len(YOUTUBE_SNAPSHOT_PREFIX):].rstrip(";\n ")
            )
            if not isinstance(remote, Mapping):
                raise ValueError("served YouTube snapshot payload is malformed")
            remote_proof = validate_stamped_discovery_payload(remote)
            remote_stamp = remote_proof["stamp"]
            if remote_stamp < expected_stamp:
                last_error = f"served Kids discovery={remote_stamp}, expected={expected_stamp}"
            elif (
                remote_stamp == expected_stamp
                and remote_proof["ids_digest"] != expected["ids_digest"]
            ):
                last_error = "served Kids cohort differs from the published discovery proof"
            else:
                result = {
                    "published": True,
                    "kidsDiscoveryT": remote_stamp,
                    "discovery_day": remote_proof["day"],
                    "queries": remote_proof["queries"],
                    "tracked": remote_proof["tracked"],
                }
                print(json.dumps(result, separators=(",", ":")))
                return result
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(max(1, interval_seconds))
    raise RuntimeError(f"GitHub Pages did not publish Kids discovery: {last_error}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    action = result.add_mutually_exclusive_group(required=True)
    action.add_argument("--stamp", action="store_true")
    action.add_argument("--verify-base-url")
    result.add_argument("--verify-timeout", type=int, default=900)
    result.add_argument("--verify-interval", type=int, default=15)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.stamp:
        stamp_discovery(args.snapshot)
    else:
        verify_publication(
            args.verify_base_url,
            args.snapshot,
            args.verify_timeout,
            args.verify_interval,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
