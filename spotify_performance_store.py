#!/usr/bin/env python3
"""Transactional sharded storage for Spotify performance histories.

The public root export stays small and backwards-compatible: it retains every
track identity and its latest point.  Complete track entries live in immutable,
content-addressed JavaScript shards referenced by the root manifest.  Readers
hydrate and validate every shard before returning data, while browsers load the
same shards before ``spotify/dashboard.js`` starts.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping


PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
TRACK_SHARD_PREFIX = "window.SPOTIFY_PERFORMANCE_TRACK_SHARD="
TRACK_SHARD_SUFFIX = (
    ";window.SPOTIFY_PERFORMANCE=window.SPOTIFY_PERFORMANCE||{};"
    "window.SPOTIFY_PERFORMANCE.tracks=window.SPOTIFY_PERFORMANCE.tracks||{};"
    "Object.assign(window.SPOTIFY_PERFORMANCE.tracks,window.SPOTIFY_PERFORMANCE_TRACK_SHARD.tracks||{});"
    "window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED=window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED||{};"
    "window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED[window.SPOTIFY_PERFORMANCE_TRACK_SHARD.bucket]="
    "Object.keys(window.SPOTIFY_PERFORMANCE_TRACK_SHARD.tracks||{}).length;\n"
)
TRACK_SHARD_DIRECTORY = "Spotify_Performance_tracks"
TRACK_SHARD_MANIFEST_KEY = "track_shards"
TRACK_SHARD_STORE_VERSION = 1
DEFAULT_TRACK_SHARD_COUNT = 16
MAX_TRACK_SHARD_BYTES = 20_000_000


class PerformanceStoreError(RuntimeError):
    """A sharded performance export is incomplete, corrupt, or unsafe."""


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _root_bytes(payload: Mapping[str, Any]) -> bytes:
    return PERFORMANCE_PREFIX.encode("utf-8") + _json_bytes(payload) + b";\n"


def _shard_bytes(payload: Mapping[str, Any]) -> bytes:
    return (
        TRACK_SHARD_PREFIX.encode("utf-8")
        + _json_bytes(payload)
        + TRACK_SHARD_SUFFIX.encode("utf-8")
    )


def _read_root(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PerformanceStoreError(f"Could not read performance root {path}") from exc
    if not text.startswith(PERFORMANCE_PREFIX):
        raise PerformanceStoreError(f"{path} is not a Spotify performance export")
    try:
        payload = json.loads(text[len(PERFORMANCE_PREFIX) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise PerformanceStoreError(f"{path} contains invalid performance JSON") from exc
    if not isinstance(payload, dict):
        raise PerformanceStoreError(f"{path} does not contain a performance object")
    return payload


def _safe_shard_path(root: Path, relative: Any) -> Path:
    raw = str(relative or "").strip().replace("\\", "/")
    if not raw or raw.startswith("/") or ".." in Path(raw).parts:
        raise PerformanceStoreError("Performance manifest contains an unsafe shard path")
    path = root.parent / Path(raw)
    expected_parent = (root.parent / TRACK_SHARD_DIRECTORY).resolve()
    try:
        resolved = path.resolve()
    except OSError as exc:
        raise PerformanceStoreError(f"Could not resolve performance shard {raw}") from exc
    if resolved.parent != expected_parent:
        raise PerformanceStoreError("Performance manifest shard is outside its storage directory")
    return path


def _parse_shard(path: Path, expected_hash: str) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise PerformanceStoreError(f"Missing performance shard {path}") from exc
    observed_hash = hashlib.sha256(raw).hexdigest()
    if not expected_hash or observed_hash != expected_hash:
        raise PerformanceStoreError(f"Performance shard checksum mismatch for {path}")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PerformanceStoreError(f"Performance shard is not UTF-8: {path}") from exc
    if not text.startswith(TRACK_SHARD_PREFIX) or not text.endswith(TRACK_SHARD_SUFFIX):
        raise PerformanceStoreError(f"Performance shard wrapper is invalid: {path}")
    body = text[len(TRACK_SHARD_PREFIX) : -len(TRACK_SHARD_SUFFIX)]
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PerformanceStoreError(f"Performance shard contains invalid JSON: {path}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("tracks"), dict):
        raise PerformanceStoreError(f"Performance shard payload is invalid: {path}")
    return payload


def _track_bucket(track_id: str, shard_count: int) -> int:
    digest = hashlib.sha256(track_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % shard_count


def _validate_manifest(root: Path, payload: Mapping[str, Any], *, hydrate: bool) -> dict[str, Any]:
    manifest = payload.get(TRACK_SHARD_MANIFEST_KEY)
    if manifest is None:
        tracks = payload.get("tracks")
        if not isinstance(tracks, dict):
            raise PerformanceStoreError("Legacy performance tracks must be an object")
        return {
            "status": "legacy",
            "tracks": tracks if hydrate else None,
            "tracks_total": len(tracks),
            "shards": 0,
            "bytes": root.stat().st_size if root.exists() else 0,
        }
    if not isinstance(manifest, dict):
        raise PerformanceStoreError("Performance track shard manifest must be an object")
    if manifest.get("version") != TRACK_SHARD_STORE_VERSION:
        raise PerformanceStoreError("Unsupported performance track shard manifest version")
    shard_count = manifest.get("shard_count")
    descriptors = manifest.get("shards")
    if not isinstance(shard_count, int) or shard_count < 1:
        raise PerformanceStoreError("Performance manifest shard_count is invalid")
    if not isinstance(descriptors, list) or len(descriptors) != shard_count:
        raise PerformanceStoreError("Performance manifest shard list is incomplete")

    hydrated: dict[str, Any] = {}
    seen_buckets: set[int] = set()
    total_bytes = 0
    total_tracks = 0
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            raise PerformanceStoreError("Performance manifest contains an invalid shard descriptor")
        bucket = descriptor.get("bucket")
        if not isinstance(bucket, int) or not 0 <= bucket < shard_count or bucket in seen_buckets:
            raise PerformanceStoreError("Performance manifest contains duplicate or invalid buckets")
        seen_buckets.add(bucket)
        shard_path = _safe_shard_path(root, descriptor.get("path"))
        shard = _parse_shard(shard_path, str(descriptor.get("sha256") or ""))
        tracks = shard.get("tracks")
        if shard.get("version") != TRACK_SHARD_STORE_VERSION or shard.get("bucket") != bucket:
            raise PerformanceStoreError(f"Performance shard identity mismatch for {shard_path}")
        if len(tracks) != descriptor.get("tracks"):
            raise PerformanceStoreError(f"Performance shard track count mismatch for {shard_path}")
        if shard_path.stat().st_size != descriptor.get("bytes"):
            raise PerformanceStoreError(f"Performance shard byte count mismatch for {shard_path}")
        for track_id, entry in tracks.items():
            track_id = str(track_id)
            if _track_bucket(track_id, shard_count) != bucket:
                raise PerformanceStoreError(f"Performance track is stored in the wrong shard: {track_id}")
            if track_id in hydrated:
                raise PerformanceStoreError(f"Duplicate performance track across shards: {track_id}")
            if hydrate:
                hydrated[track_id] = entry
        total_tracks += len(tracks)
        total_bytes += shard_path.stat().st_size
    expected_total = manifest.get("tracks_total")
    if not isinstance(expected_total, int) or total_tracks != expected_total:
        raise PerformanceStoreError("Performance manifest total track count is inconsistent")
    summaries = payload.get("tracks")
    if not isinstance(summaries, dict) or len(summaries) != total_tracks:
        raise PerformanceStoreError("Performance root summaries do not match the shard catalogue")
    if hydrate and set(summaries) != set(hydrated):
        raise PerformanceStoreError("Performance root and shards contain different track identities")
    return {
        "status": "sharded",
        "tracks": hydrated if hydrate else None,
        "tracks_total": total_tracks,
        "shards": shard_count,
        "bytes": total_bytes,
    }


def read_performance_payload(path: Path) -> dict[str, Any]:
    """Read legacy or sharded data and return the complete historical payload."""

    if not path.exists():
        return {
            "source": "soundcharts_daily",
            "generated_at": None,
            "tracks": {},
            "artists": {},
            "playlists": {},
        }
    payload = _read_root(path)
    validation = _validate_manifest(path, payload, hydrate=True)
    if validation["status"] == "sharded":
        payload["tracks"] = validation["tracks"]
    payload.setdefault("source", "soundcharts_daily")
    payload.setdefault("tracks", {})
    payload.setdefault("artists", {})
    payload.setdefault("playlists", {})
    return payload


def validate_performance_store(path: Path) -> dict[str, Any]:
    """Fail closed when any manifest shard is absent or corrupt."""

    if not path.exists():
        raise PerformanceStoreError(f"Performance root is missing: {path}")
    return _validate_manifest(path, _read_root(path), hydrate=True)


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_bytes(data)
        temporary.replace(path)
    except OSError as exc:
        if temporary.exists():
            temporary.unlink()
        raise PerformanceStoreError(f"Could not atomically persist {path}") from exc


def _summary_entry(entry: Any) -> Any:
    if not isinstance(entry, dict):
        return entry
    summary = dict(entry)
    history = summary.get("history")
    if isinstance(history, list):
        summary["history"] = history[-1:] if history else []
    return summary


def write_performance_payload(
    path: Path,
    payload: Mapping[str, Any],
    *,
    shard_count: int = DEFAULT_TRACK_SHARD_COUNT,
) -> dict[str, Any]:
    """Write immutable shards first and atomically switch the root manifest last."""

    tracks = payload.get("tracks")
    if not isinstance(tracks, Mapping):
        raise PerformanceStoreError("Performance tracks must be an object")
    shard_count = max(1, int(shard_count))
    prepared: list[tuple[int, dict[str, Any], bytes, str]] = []
    while True:
        buckets: list[dict[str, Any]] = [dict() for _ in range(shard_count)]
        for raw_track_id, entry in tracks.items():
            track_id = str(raw_track_id)
            buckets[_track_bucket(track_id, shard_count)][track_id] = entry
        prepared = []
        largest = 0
        for bucket, bucket_tracks in enumerate(buckets):
            shard_payload = {
                "version": TRACK_SHARD_STORE_VERSION,
                "bucket": bucket,
                "tracks": dict(sorted(bucket_tracks.items())),
            }
            data = _shard_bytes(shard_payload)
            largest = max(largest, len(data))
            prepared.append((bucket, bucket_tracks, data, hashlib.sha256(data).hexdigest()))
        if largest <= MAX_TRACK_SHARD_BYTES:
            break
        shard_count *= 2
        if shard_count > 4_096:
            raise PerformanceStoreError("Performance history cannot be split below the shard size limit")

    shard_dir = path.parent / TRACK_SHARD_DIRECTORY
    descriptors: list[dict[str, Any]] = []
    active_paths: set[Path] = set()
    for bucket, bucket_tracks, data, digest in prepared:
        filename = f"tracks-{bucket:02d}-{digest[:16]}.js"
        shard_path = shard_dir / filename
        if not shard_path.exists() or hashlib.sha256(shard_path.read_bytes()).hexdigest() != digest:
            _atomic_write(shard_path, data)
        active_paths.add(shard_path.resolve())
        descriptors.append(
            {
                "bucket": bucket,
                "path": f"{TRACK_SHARD_DIRECTORY}/{filename}",
                "sha256": digest,
                "tracks": len(bucket_tracks),
                "bytes": len(data),
            }
        )

    persisted_store_summary = {
        "status": "sharded",
        "tracks_total": len(tracks),
        "shards": shard_count,
        "shard_bytes": sum(item["bytes"] for item in descriptors),
    }
    run = payload.get("run")
    if isinstance(run, dict):
        run["performance_store"] = dict(persisted_store_summary)
    freshness = payload.get("freshness")
    if isinstance(freshness, dict) and isinstance(freshness.get("run"), dict):
        freshness["run"]["performance_store"] = dict(persisted_store_summary)

    root_payload = dict(payload)
    root_payload["tracks"] = {
        str(track_id): _summary_entry(entry) for track_id, entry in tracks.items()
    }
    root_payload[TRACK_SHARD_MANIFEST_KEY] = {
        "version": TRACK_SHARD_STORE_VERSION,
        "algorithm": "sha256_mod",
        "shard_count": shard_count,
        "tracks_total": len(tracks),
        "shards": descriptors,
    }
    root_data = _root_bytes(root_payload)
    _atomic_write(path, root_data)

    # The new manifest is now the commit marker.  Old immutable shards can be
    # removed afterwards; interruption here only leaves harmless unreferenced files.
    stale_removed = 0
    stale_cleanup_errors: list[str] = []
    if shard_dir.exists():
        for stale in shard_dir.glob("tracks-*.js"):
            if stale.resolve() not in active_paths:
                try:
                    stale.unlink()
                    stale_removed += 1
                except OSError:
                    # The committed manifest never references stale files.
                    # Cleanup must not turn a valid paid refresh into a failure.
                    stale_cleanup_errors.append(str(stale))
    return {
        **persisted_store_summary,
        "root_bytes": len(root_data),
        "paths": [item["path"] for item in descriptors],
        "stale_removed": stale_removed,
        "stale_cleanup_errors": stale_cleanup_errors,
    }
