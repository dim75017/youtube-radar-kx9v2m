#!/usr/bin/env python3
"""Grow Spotify Radar from editorial playlists and their artists' catalogues.

The job deliberately separates discovery from measurement:

* every known Spotify editorial playlist in the target background-music genres
  is scanned for its current Soundcharts tracklist;
* unseen playlist tracks and credited artists enter the editorial candidate pool;
* a rotating page of each discovered artist's main-performer catalogue is added;
* the existing instrumental-pool collector resolves Spotify IDs, stream histories,
  rights and contacts under its own quota-aware scheduler.

New playlist/catalogue rows are *review* candidates.  They are never marked as
instrumental or AI-safe before the existing classification/evidence gates prove it.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
import urllib.parse
from pathlib import Path
from typing import Any, Iterable, Mapping

from expand_soundcharts_instrumental_pool import parse_song_detail
from refresh_soundcharts_daily import (
    PLAYLISTS_PREFIX,
    SOUNDCHARTS_PREFIX,
    SoundchartsClient,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
    read_js_payload,
    write_js_payload,
)

CACHE_VERSION = 1
DISCOVERY_VERSION = 1

PLAYLIST_GENRE_MAP = {
    "piano": "piano",
    "lofi / chillhop": "lofi_hip_hop",
    "ambient": "ambient",
    "nature": "nature",
    "jazz / bossa": "jazz_jazzhop",
}

TRACK_FIELDS = (
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "artist",
    "release_date",
    "label",
    "copyright",
    "isrc",
    "image_url",
    "rights_status",
    "rights_confidence",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "review_reasons",
    "metadata_status",
    "updated_at",
    "source_tier",
    "playlist_ids",
    "playlist_names",
    "playlist_count",
    "playlist_best_position",
    "playlist_followers_total",
    "playlist_first_seen_at",
    "playlist_last_seen_at",
    "playlist_placements",
    "discovery_source_playlist_ids",
    "discovery_source_playlist_names",
    "artist_soundcharts_uuids",
    "discovered_at",
)

ARTIST_FIELDS = (
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "monthly_listeners",
    "qualifies",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "review_reasons",
    "updated_at",
    "source_tier",
    "playlist_ids",
    "playlist_names",
    "playlist_count",
    "catalogue_tracks_discovered",
    "discovered_at",
    "last_catalogue_scan_at",
)


class PlaylistDiscoveryError(RuntimeError):
    """Safe failure raised when playlist discovery cannot produce usable output."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def read_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": CACHE_VERSION, "tracks": {}, "artists": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlaylistDiscoveryError(f"{path} contains invalid cache JSON") from exc
    if not isinstance(payload, dict):
        raise PlaylistDiscoveryError("Instrumental cache must be an object")
    payload.setdefault("version", CACHE_VERSION)
    payload.setdefault("tracks", {})
    payload.setdefault("artists", {})
    return payload


def read_baseline(path: Path | None) -> dict[str, Any]:
    """Read the spreadsheet-derived archive seed without importing contacts."""
    if path is None or not path.exists():
        return {"artists": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlaylistDiscoveryError(f"Baseline seed file {path} is invalid") from exc
    artists = payload.get("artists") if isinstance(payload, dict) else None
    if not isinstance(artists, list):
        raise PlaylistDiscoveryError("Baseline seed file is missing artists")
    clean: list[dict[str, str]] = []
    for artist in artists:
        if not isinstance(artist, Mapping):
            continue
        spotify_id = str(artist.get("spotify_id") or "").strip()
        name = str(artist.get("name") or "").strip()
        if spotify_id and name:
            clean.append({"spotify_id": spotify_id, "name": name})
    return {**payload, "artists": clean}


def write_cache(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def index_of(schema: list[str], name: str) -> int | None:
    try:
        return schema.index(name)
    except ValueError:
        return None


def field(row: Any, schema: list[str], name: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(name)
    index = index_of(schema, name)
    return row[index] if index is not None and isinstance(row, list) and index < len(row) else None


def set_field(row: list[Any], schema: list[str], name: str, value: Any) -> None:
    index = index_of(schema, name)
    if index is None:
        raise PlaylistDiscoveryError(f"Schema field {name} was not initialized")
    while len(row) <= index:
        row.append(None)
    row[index] = value


def ensure_editorial_schema(editorial: dict[str, Any], group: str, names: Iterable[str]) -> tuple[list[str], list[list[Any]]]:
    schema_key = "track_schema" if group == "tracks" else "artist_schema"
    schema = editorial.setdefault(schema_key, [])
    rows = editorial.setdefault(group, [])
    if not isinstance(schema, list) or not isinstance(rows, list):
        raise PlaylistDiscoveryError(f"Invalid editorial {group} structure")
    for name in names:
        if name in schema:
            continue
        schema.append(name)
        for row in rows:
            if isinstance(row, list):
                row.append(None)
    return schema, rows


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    try:
        parsed = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _clean_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _merge_unique(*values: Any) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        for item in _clean_list(value):
            if item not in seen:
                seen.add(item)
                out.append(item)
    return out


def _day(value: Any) -> str | None:
    raw = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return None


def _first_day(*values: Any) -> str | None:
    days = sorted(day for day in (_day(value) for value in values) if day)
    return days[0] if days else None


def _latest_day(*values: Any) -> str | None:
    days = sorted(day for day in (_day(value) for value in values) if day)
    return days[-1] if days else None


def select_editorial_playlists(payload: dict[str, Any]) -> list[dict[str, Any]]:
    columns = payload.get("cols") if isinstance(payload.get("cols"), list) else []
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    positions = {name: index for index, name in enumerate(columns)}
    required = {"id", "name", "curatorCat", "followers", "tracks", "genre"}
    if not required.issubset(positions):
        raise PlaylistDiscoveryError("Playlist export is missing required columns")

    selected: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, list):
            continue
        curator = str(row[positions["curatorCat"]] if positions["curatorCat"] < len(row) else "").casefold()
        display_genre = str(row[positions["genre"]] if positions["genre"] < len(row) else "").strip()
        internal_genre = PLAYLIST_GENRE_MAP.get(display_genre.casefold())
        if curator != "editorial" or not internal_genre:
            continue
        spotify_id = str(row[positions["id"]] if positions["id"] < len(row) else "").strip()
        if not spotify_id:
            continue
        followers = _finite_number(row[positions["followers"]] if positions["followers"] < len(row) else None)
        tracks = _finite_number(row[positions["tracks"]] if positions["tracks"] < len(row) else None)
        selected.append(
            {
                "spotify_id": spotify_id,
                "name": str(row[positions["name"]] if positions["name"] < len(row) else spotify_id).strip(),
                "display_genre": display_genre,
                "primary_genre": internal_genre,
                "followers": int(followers) if followers is not None and followers >= 0 else 0,
                "expected_tracks": int(tracks) if tracks is not None and tracks >= 0 else 0,
            }
        )
    selected.sort(key=lambda item: (-item["followers"], item["name"].casefold(), item["spotify_id"]))
    return selected


def parallel_get(
    client: Any,
    tasks: Iterable[tuple[str, str]],
    *,
    workers: int,
) -> tuple[dict[str, Any], int]:
    task_list = list(tasks)
    if not task_list:
        return {}, 0
    results: dict[str, Any] = {}
    failures = 0

    def fetch(task: tuple[str, str]) -> tuple[str, Any]:
        key, path = task
        return key, client.get(path)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(fetch, task) for task in task_list]
        for future in concurrent.futures.as_completed(futures):
            try:
                key, payload = future.result()
                results[key] = payload
            except (SoundchartsQuotaReserveError, SoundchartsRequestLimitError):
                for pending in futures:
                    pending.cancel()
                raise
            except (SoundchartsError, OSError, RuntimeError):
                failures += 1
    return results, failures


def parse_playlist_metadata(response: Any) -> dict[str, Any] | None:
    obj = response.get("object") if isinstance(response, dict) else None
    if not isinstance(obj, dict):
        return None
    uuid = str(obj.get("uuid") or "").strip()
    if not uuid:
        return None
    return {
        "soundcharts_uuid": uuid,
        "name": str(obj.get("name") or ""),
        "followers": int(_finite_number(obj.get("latestSubscriberCount")) or 0),
        "tracks": int(_finite_number(obj.get("latestTrackCount")) or 0),
        "latest_crawl_date": str(obj.get("latestCrawlDate") or ""),
    }


def parse_playlist_track_page(response: Any, playlist: Mapping[str, Any]) -> tuple[list[dict[str, Any]], int]:
    page = response.get("page") if isinstance(response, dict) else None
    total = int(_finite_number(page.get("total")) or 0) if isinstance(page, dict) else 0
    items = response.get("items") if isinstance(response, dict) else []
    out: list[dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        song = item.get("song")
        if not isinstance(song, dict):
            continue
        uuid = str(song.get("uuid") or "").strip()
        if not uuid:
            continue
        position = _finite_number(item.get("position"))
        out.append(
            {
                "soundcharts_uuid": uuid,
                "name": str(song.get("name") or "").strip(),
                "credit_name": str(song.get("creditName") or "").strip(),
                "playlist_id": str(playlist.get("spotify_id") or ""),
                "playlist_uuid": str(playlist.get("soundcharts_uuid") or ""),
                "playlist_name": str(playlist.get("name") or ""),
                "primary_genre": str(playlist.get("primary_genre") or ""),
                "playlist_followers": int(_finite_number(playlist.get("followers")) or 0),
                "position": int(position) if position is not None and position > 0 else None,
                "entry_date": _day(item.get("entryDate")),
                "exit_date": _day(item.get("exitDate")),
            }
        )
    return out, total


def aggregate_track_evidence(placements: Iterable[dict[str, Any]], observed_day: str) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for placement in placements:
        uuid = str(placement.get("soundcharts_uuid") or "")
        if not uuid:
            continue
        entry = grouped.setdefault(
            uuid,
            {
                "soundcharts_uuid": uuid,
                "name": str(placement.get("name") or ""),
                "credit_name": str(placement.get("credit_name") or ""),
                "placements": [],
            },
        )
        entry["placements"].append(dict(placement))
        if not entry.get("name") and placement.get("name"):
            entry["name"] = str(placement["name"])
        if not entry.get("credit_name") and placement.get("credit_name"):
            entry["credit_name"] = str(placement["credit_name"])

    for entry in grouped.values():
        placements_list = entry["placements"]
        by_playlist: dict[str, dict[str, Any]] = {}
        for placement in placements_list:
            playlist_id = str(placement.get("playlist_id") or "")
            previous = by_playlist.get(playlist_id)
            rank = placement.get("position") if placement.get("position") is not None else 10**9
            previous_rank = previous.get("position") if previous and previous.get("position") is not None else 10**9
            if previous is None or rank < previous_rank:
                by_playlist[playlist_id] = placement
        unique = list(by_playlist.values())
        unique.sort(key=lambda item: (item.get("position") is None, item.get("position") or 10**9, -int(item.get("playlist_followers") or 0)))
        placement_rows = [
            {
                "spotify_id": str(item.get("playlist_id") or ""),
                "soundcharts_uuid": str(item.get("playlist_uuid") or ""),
                "name": str(item.get("playlist_name") or ""),
                "position": int(item["position"]) if item.get("position") is not None else None,
                "followers": max(0, int(item.get("playlist_followers") or 0)),
                "first_seen_at": _first_day(item.get("entry_date"), observed_day),
                "last_seen_at": observed_day,
                "exit_date": item.get("exit_date"),
            }
            for item in unique
        ]
        follower_sum = sum(max(0, int(item.get("playlist_followers") or 0)) for item in unique)
        positions = [int(item["position"]) for item in unique if item.get("position") is not None]
        genre_weight: dict[str, int] = {}
        for item in unique:
            genre = str(item.get("primary_genre") or "")
            genre_weight[genre] = genre_weight.get(genre, 0) + max(1, int(item.get("playlist_followers") or 0))
        primary_genre = max(genre_weight, key=lambda genre: (genre_weight[genre], genre)) if genre_weight else "other_instrumental"
        entry.update(
            {
                "playlist_ids": [str(item.get("playlist_id") or "") for item in unique if item.get("playlist_id")],
                "playlist_names": [str(item.get("playlist_name") or "") for item in unique if item.get("playlist_name")],
                "playlist_count": len(unique),
                "playlist_best_position": min(positions) if positions else None,
                "playlist_followers_total": follower_sum,
                "playlist_first_seen_at": _first_day(*(item.get("entry_date") for item in unique), observed_day),
                "playlist_last_seen_at": observed_day,
                "playlist_placements": placement_rows,
                "primary_genre": primary_genre,
                "subgenres": sorted(genre for genre in genre_weight if genre and genre != primary_genre),
                "top_playlist": unique[0] if unique else None,
            }
        )
    return grouped


def discovery_rank(item: Mapping[str, Any]) -> tuple[int, int, int, str]:
    position = int(item.get("playlist_best_position") or 10**9)
    return (
        int(item.get("playlist_count") or 0),
        int(item.get("playlist_followers_total") or 0),
        -position,
        str(item.get("soundcharts_uuid") or ""),
    )


def _new_row(schema: list[str]) -> list[Any]:
    return [None] * len(schema)


def _row_index(rows: list[list[Any]], schema: list[str]) -> dict[str, list[Any]]:
    out: dict[str, list[Any]] = {}
    for row in rows:
        uuid = str(field(row, schema, "soundcharts_uuid") or "").strip()
        if uuid:
            out[uuid] = row
    return out


def _genre_confidence(evidence: Mapping[str, Any]) -> float:
    count = int(evidence.get("playlist_count") or 0)
    followers = int(evidence.get("playlist_followers_total") or 0)
    if count >= 3 or followers >= 1_000_000:
        return 0.78
    if count >= 2 or followers >= 100_000:
        return 0.7
    return 0.6


def _normalise_playlist_placements(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, Mapping):
            continue
        spotify_id = str(item.get("spotify_id") or item.get("playlist_id") or "").strip()
        name = str(item.get("name") or item.get("playlist_name") or "").strip()
        if not spotify_id and not name:
            continue
        position = _finite_number(item.get("position"))
        followers = _finite_number(item.get("followers") or item.get("playlist_followers"))
        rows.append(
            {
                "spotify_id": spotify_id,
                "soundcharts_uuid": str(item.get("soundcharts_uuid") or item.get("playlist_uuid") or "").strip(),
                "name": name,
                "position": int(position) if position is not None and position > 0 else None,
                "followers": max(0, int(followers or 0)),
                "first_seen_at": _day(item.get("first_seen_at") or item.get("entry_date")),
                "last_seen_at": _day(item.get("last_seen_at")),
                "exit_date": _day(item.get("exit_date")),
            }
        )
    return rows


def _merge_playlist_placements(*values: Any) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for value in values:
        for item in _normalise_playlist_placements(value):
            key = item["spotify_id"] or item["name"].casefold()
            previous = merged.get(key)
            if previous is None:
                merged[key] = dict(item)
                continue
            positions = [v for v in (previous.get("position"), item.get("position")) if v is not None]
            previous["position"] = min(positions) if positions else None
            previous["followers"] = max(int(previous.get("followers") or 0), int(item.get("followers") or 0))
            previous["first_seen_at"] = _first_day(previous.get("first_seen_at"), item.get("first_seen_at"))
            previous["last_seen_at"] = _latest_day(previous.get("last_seen_at"), item.get("last_seen_at"))
            previous["exit_date"] = _latest_day(previous.get("exit_date"), item.get("exit_date"))
            if not previous.get("name") and item.get("name"):
                previous["name"] = item["name"]
            if not previous.get("soundcharts_uuid") and item.get("soundcharts_uuid"):
                previous["soundcharts_uuid"] = item["soundcharts_uuid"]
    return sorted(
        merged.values(),
        key=lambda item: (item.get("position") is None, item.get("position") or 10**9, -int(item.get("followers") or 0), item.get("name") or ""),
    )


def cache_track_discovery_evidence(
    cache_tracks: dict[str, Any],
    evidence: Mapping[str, Any],
    *,
    source_tier: str,
    now: str,
) -> dict[str, Any]:
    uuid = str(evidence.get("soundcharts_uuid") or "").strip()
    current = cache_tracks.get(uuid) if isinstance(cache_tracks.get(uuid), dict) else {}
    placements = _merge_playlist_placements(current.get("playlist_placements"), evidence.get("playlist_placements"))
    playlist_ids = _merge_unique(current.get("playlist_ids"), evidence.get("playlist_ids"))
    playlist_names = _merge_unique(current.get("playlist_names"), evidence.get("playlist_names"))
    current.update(
        {
            "soundcharts_uuid": uuid,
            "title": str(current.get("title") or evidence.get("name") or "Titre non renseigné"),
            "credit_name": str(current.get("credit_name") or evidence.get("credit_name") or "Artiste non renseigné"),
            "primary_genre": str(current.get("primary_genre") or evidence.get("primary_genre") or "other_instrumental"),
            "subgenres": _merge_unique(current.get("subgenres"), evidence.get("subgenres")),
            "source_tier": str(current.get("source_tier") or source_tier),
            "metadata_status": str(current.get("metadata_status") or "playlist_only"),
            "playlist_ids": playlist_ids,
            "playlist_names": playlist_names,
            "playlist_count": len(playlist_ids),
            "playlist_best_position": min(
                [
                    value
                    for value in (
                        _finite_number(current.get("playlist_best_position")),
                        _finite_number(evidence.get("playlist_best_position")),
                    )
                    if value is not None
                ],
                default=None,
            ),
            "playlist_followers_total": max(
                int(_finite_number(current.get("playlist_followers_total")) or 0),
                int(_finite_number(evidence.get("playlist_followers_total")) or 0),
            ),
            "playlist_first_seen_at": _first_day(current.get("playlist_first_seen_at"), evidence.get("playlist_first_seen_at")),
            "playlist_last_seen_at": _latest_day(current.get("playlist_last_seen_at"), evidence.get("playlist_last_seen_at")),
            "playlist_placements": placements,
            "discovered_at": str(current.get("discovered_at") or now),
            "updated_at": now,
        }
    )
    cache_tracks[uuid] = current
    return current


def upsert_editorial_track(
    rows: list[list[Any]],
    schema: list[str],
    by_uuid: dict[str, list[Any]],
    evidence: Mapping[str, Any],
    *,
    detail: Mapping[str, Any] | None,
    source_tier: str,
    now: str,
) -> tuple[list[Any], bool]:
    uuid = str(evidence.get("soundcharts_uuid") or "").strip()
    if not uuid:
        raise PlaylistDiscoveryError("Cannot upsert a track without Soundcharts UUID")
    row = by_uuid.get(uuid)
    inserted = row is None
    if row is None:
        row = _new_row(schema)
        rows.append(row)
        by_uuid[uuid] = row

    current_source = str(field(row, schema, "source_tier") or "")
    playlist_ids = _merge_unique(field(row, schema, "playlist_ids"), evidence.get("playlist_ids"))
    playlist_names = _merge_unique(field(row, schema, "playlist_names"), evidence.get("playlist_names"))
    playlist_placements = _merge_playlist_placements(
        field(row, schema, "playlist_placements"), evidence.get("playlist_placements")
    )
    existing_first = field(row, schema, "playlist_first_seen_at")
    existing_last = field(row, schema, "playlist_last_seen_at")
    artist_uuids = _merge_unique(
        field(row, schema, "artist_soundcharts_uuids"),
        [
            str(artist.get("soundcharts_uuid") or "")
            for artist in (detail.get("artists", []) if isinstance(detail, Mapping) else [])
            if isinstance(artist, Mapping)
        ],
    )
    genre = str(field(row, schema, "primary_genre") or evidence.get("primary_genre") or "other_instrumental")
    existing_confidence = _finite_number(field(row, schema, "genre_confidence"))
    current_instrumental = str(field(row, schema, "instrumental_status") or "unknown")
    current_ai = str(field(row, schema, "ai_risk") or "unknown")
    current_expansion = str(field(row, schema, "expansion_status") or "review")

    values = {
        "soundcharts_uuid": uuid,
        "spotify_id": str(field(row, schema, "spotify_id") or ""),
        "name": str((detail or {}).get("title") or evidence.get("name") or field(row, schema, "name") or "Titre non renseigné"),
        "artist": str((detail or {}).get("credit_name") or evidence.get("credit_name") or field(row, schema, "artist") or "Artiste non renseigné"),
        "release_date": str((detail or {}).get("release_date") or field(row, schema, "release_date") or ""),
        "label": str((detail or {}).get("label") or field(row, schema, "label") or ""),
        "copyright": str((detail or {}).get("copyright") or field(row, schema, "copyright") or ""),
        "isrc": str((detail or {}).get("isrc") or field(row, schema, "isrc") or ""),
        "image_url": str((detail or {}).get("image_url") or field(row, schema, "image_url") or ""),
        "rights_status": str((detail or {}).get("rights_status") or field(row, schema, "rights_status") or "unknown"),
        "rights_confidence": _finite_number((detail or {}).get("rights_confidence"))
        or _finite_number(field(row, schema, "rights_confidence"))
        or 0.25,
        "primary_genre": genre,
        "subgenres": _merge_unique(field(row, schema, "subgenres"), evidence.get("subgenres")),
        "genre_confidence": max(float(existing_confidence or 0), _genre_confidence(evidence)),
        "instrumental_status": current_instrumental,
        "instrumental_confidence": field(row, schema, "instrumental_confidence"),
        "ai_risk": current_ai,
        "ai_risk_score": field(row, schema, "ai_risk_score"),
        "expansion_status": current_expansion if current_expansion in {"eligible", "review"} else "review",
        "review_reasons": _merge_unique(
            field(row, schema, "review_reasons"),
            ["playlist_editorial_discovery", "instrumental_check_required", "ai_check_required"],
        ),
        "metadata_status": "complete" if detail else str(field(row, schema, "metadata_status") or "playlist_only"),
        "updated_at": now,
        "source_tier": current_source or source_tier,
        "playlist_ids": playlist_ids,
        "playlist_names": playlist_names,
        "playlist_count": len(playlist_ids),
        "playlist_best_position": min(
            [
                value
                for value in (
                    _finite_number(field(row, schema, "playlist_best_position")),
                    _finite_number(evidence.get("playlist_best_position")),
                )
                if value is not None
            ],
            default=None,
        ),
        "playlist_followers_total": max(
            int(_finite_number(field(row, schema, "playlist_followers_total")) or 0),
            int(_finite_number(evidence.get("playlist_followers_total")) or 0),
        ),
        "playlist_first_seen_at": _first_day(existing_first, evidence.get("playlist_first_seen_at")),
        "playlist_last_seen_at": _latest_day(existing_last, evidence.get("playlist_last_seen_at")),
        "playlist_placements": playlist_placements,
        "discovery_source_playlist_ids": _merge_unique(
            field(row, schema, "discovery_source_playlist_ids"), evidence.get("discovery_source_playlist_ids")
        ),
        "discovery_source_playlist_names": _merge_unique(
            field(row, schema, "discovery_source_playlist_names"), evidence.get("discovery_source_playlist_names")
        ),
        "artist_soundcharts_uuids": artist_uuids,
        "discovered_at": str(field(row, schema, "discovered_at") or now),
    }
    for name, value in values.items():
        set_field(row, schema, name, value)
    return row, inserted


def upsert_editorial_artist(
    rows: list[list[Any]],
    schema: list[str],
    by_uuid: dict[str, list[Any]],
    artist: Mapping[str, Any],
    evidence: Mapping[str, Any],
    *,
    source_tier: str,
    now: str,
) -> tuple[list[Any], bool]:
    uuid = str(artist.get("soundcharts_uuid") or "").strip()
    if not uuid:
        raise PlaylistDiscoveryError("Cannot upsert an artist without Soundcharts UUID")
    row = by_uuid.get(uuid)
    inserted = row is None
    if row is None:
        row = _new_row(schema)
        rows.append(row)
        by_uuid[uuid] = row
    playlist_ids = _merge_unique(field(row, schema, "playlist_ids"), evidence.get("playlist_ids"))
    playlist_names = _merge_unique(field(row, schema, "playlist_names"), evidence.get("playlist_names"))
    values = {
        "soundcharts_uuid": uuid,
        "spotify_id": str(field(row, schema, "spotify_id") or artist.get("spotify_id") or ""),
        "name": str(artist.get("name") or field(row, schema, "name") or "Artiste non renseigné"),
        "monthly_listeners": field(row, schema, "monthly_listeners"),
        "qualifies": field(row, schema, "qualifies"),
        "primary_genre": str(field(row, schema, "primary_genre") or evidence.get("primary_genre") or "other_instrumental"),
        "subgenres": _merge_unique(field(row, schema, "subgenres"), evidence.get("subgenres")),
        "genre_confidence": max(float(_finite_number(field(row, schema, "genre_confidence")) or 0), _genre_confidence(evidence)),
        "instrumental_status": str(field(row, schema, "instrumental_status") or "unknown"),
        "instrumental_confidence": field(row, schema, "instrumental_confidence"),
        "ai_risk": str(field(row, schema, "ai_risk") or "unknown"),
        "ai_risk_score": field(row, schema, "ai_risk_score"),
        "expansion_status": str(field(row, schema, "expansion_status") or "review"),
        "review_reasons": _merge_unique(
            field(row, schema, "review_reasons"),
            ["playlist_editorial_artist", "catalogue_discovery"],
        ),
        "updated_at": now,
        "source_tier": str(field(row, schema, "source_tier") or source_tier),
        "playlist_ids": playlist_ids,
        "playlist_names": playlist_names,
        "playlist_count": len(playlist_ids),
        "catalogue_tracks_discovered": int(_finite_number(field(row, schema, "catalogue_tracks_discovered")) or 0),
        "discovered_at": str(field(row, schema, "discovered_at") or now),
        "last_catalogue_scan_at": field(row, schema, "last_catalogue_scan_at"),
    }
    for name, value in values.items():
        set_field(row, schema, name, value)
    return row, inserted


def catalogue_artist_order(
    artist_uuids: Iterable[str],
    artist_state: Mapping[str, Any],
    *,
    limit: int,
    baseline_artist_uuids: Iterable[str] = (),
) -> list[str]:
    unique = sorted(set(str(uuid) for uuid in artist_uuids if uuid))
    baseline = {str(uuid) for uuid in baseline_artist_uuids if uuid}
    unique.sort(
        key=lambda uuid: (
            0 if uuid in baseline else 1,
            1 if isinstance(artist_state.get(uuid), Mapping) and artist_state[uuid].get("last_scan_at") else 0,
            str((artist_state.get(uuid) or {}).get("last_scan_at") or ""),
            uuid,
        )
    )
    return unique[: max(0, limit)]


def parse_catalogue_page(response: Any, artist_uuid: str, artist_name: str, genre: str) -> tuple[list[dict[str, Any]], int, int | None]:
    page = response.get("page") if isinstance(response, dict) else None
    total = int(_finite_number(page.get("total")) or 0) if isinstance(page, dict) else 0
    offset = int(_finite_number(page.get("offset")) or 0) if isinstance(page, dict) else 0
    limit = int(_finite_number(page.get("limit")) or 0) if isinstance(page, dict) else 0
    next_offset = offset + limit if limit and offset + limit < total else 0
    items = response.get("items") if isinstance(response, dict) else []
    out: list[dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        uuid = str(item.get("uuid") or "").strip()
        if not uuid:
            continue
        out.append(
            {
                "soundcharts_uuid": uuid,
                "name": str(item.get("name") or "").strip(),
                "credit_name": str(item.get("creditName") or artist_name).strip(),
                "release_date": str(item.get("releaseDate") or ""),
                "primary_genre": genre,
                "subgenres": [],
                "playlist_ids": [],
                "playlist_names": [],
                "playlist_count": 0,
                "playlist_best_position": None,
                "playlist_followers_total": 0,
                "playlist_first_seen_at": None,
                "playlist_last_seen_at": None,
                "artist_soundcharts_uuids": [artist_uuid],
            }
        )
    return out, total, next_offset


def discover_from_playlists(
    soundcharts: dict[str, Any],
    playlists_payload: dict[str, Any],
    cache: dict[str, Any],
    client: Any,
    *,
    workers: int = 10,
    page_size: int = 100,
    playlist_limit: int | None = None,
    max_new_playlist_tracks: int = 450,
    max_catalog_artists: int = 250,
    catalog_page_size: int = 25,
    max_new_catalog_tracks: int = 1_200,
    baseline: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    now = utc_now()
    observed_day = utc_today().isoformat()
    editorial = soundcharts.setdefault("editorial", {})
    if not isinstance(editorial, dict):
        raise PlaylistDiscoveryError("Soundcharts editorial group must be an object")
    track_schema, track_rows = ensure_editorial_schema(editorial, "tracks", TRACK_FIELDS)
    artist_schema, artist_rows = ensure_editorial_schema(editorial, "artists", ARTIST_FIELDS)
    tracks_by_uuid = _row_index(track_rows, track_schema)
    artists_by_uuid = _row_index(artist_rows, artist_schema)

    cache_tracks = cache.setdefault("tracks", {})
    cache_artists = cache.setdefault("artists", {})
    discovery = cache.setdefault(
        "playlist_discovery",
        {"version": DISCOVERY_VERSION, "playlists": {}, "artists": {}},
    )
    if not isinstance(cache_tracks, dict) or not isinstance(cache_artists, dict) or not isinstance(discovery, dict):
        raise PlaylistDiscoveryError("Invalid cache groups")
    discovery.setdefault("version", DISCOVERY_VERSION)
    playlist_state = discovery.setdefault("playlists", {})
    artist_state = discovery.setdefault("artists", {})
    if not isinstance(playlist_state, dict) or not isinstance(artist_state, dict):
        raise PlaylistDiscoveryError("Invalid playlist discovery state")
    baseline_ids = {
        str(item.get("spotify_id") or "").strip()
        for item in (baseline or {}).get("artists", [])
        if isinstance(item, Mapping) and str(item.get("spotify_id") or "").strip()
    }
    baseline_playlist_artist_uuids: set[str] = set()

    playlists = select_editorial_playlists(playlists_payload)
    if playlist_limit is not None:
        playlists = playlists[: max(0, playlist_limit)]
    metadata_tasks: list[tuple[str, str]] = []
    playlist_by_id = {item["spotify_id"]: item for item in playlists}
    for item in playlists:
        state = playlist_state.get(item["spotify_id"])
        cached_uuid = str(state.get("soundcharts_uuid") or "") if isinstance(state, dict) else ""
        if cached_uuid:
            item["soundcharts_uuid"] = cached_uuid
        else:
            metadata_tasks.append(
                (
                    item["spotify_id"],
                    "/api/v2.8/playlist/by-platform/spotify/" + urllib.parse.quote(item["spotify_id"]),
                )
            )
    metadata_responses, metadata_failures = parallel_get(client, metadata_tasks, workers=workers)
    for spotify_id, response in metadata_responses.items():
        parsed = parse_playlist_metadata(response)
        if not parsed:
            continue
        item = playlist_by_id[spotify_id]
        item["soundcharts_uuid"] = parsed["soundcharts_uuid"]
        if parsed["followers"]:
            item["followers"] = parsed["followers"]
        if parsed["tracks"]:
            item["expected_tracks"] = parsed["tracks"]
        playlist_state[spotify_id] = {
            **(playlist_state.get(spotify_id) if isinstance(playlist_state.get(spotify_id), dict) else {}),
            **parsed,
            "spotify_id": spotify_id,
            "primary_genre": item["primary_genre"],
            "resolved_at": now,
        }

    resolved_playlists = [item for item in playlists if item.get("soundcharts_uuid")]
    first_page_tasks = [
        (
            item["spotify_id"],
            f"/api/v2.20/playlist/{urllib.parse.quote(str(item['soundcharts_uuid']))}/tracks/latest?offset=0&limit={page_size}",
        )
        for item in resolved_playlists
    ]
    first_pages, first_page_failures = parallel_get(client, first_page_tasks, workers=workers)
    placements: list[dict[str, Any]] = []
    extra_page_tasks: list[tuple[str, str]] = []
    scanned_playlists = 0
    for item in resolved_playlists:
        response = first_pages.get(item["spotify_id"])
        if response is None:
            continue
        scanned_playlists += 1
        parsed, total = parse_playlist_track_page(response, item)
        placements.extend(parsed)
        for offset in range(page_size, total, page_size):
            key = f"{item['spotify_id']}:{offset}"
            path = f"/api/v2.20/playlist/{urllib.parse.quote(str(item['soundcharts_uuid']))}/tracks/latest?offset={offset}&limit={page_size}"
            extra_page_tasks.append((key, path))
        state = playlist_state.setdefault(item["spotify_id"], {})
        state.update(
            {
                "soundcharts_uuid": item["soundcharts_uuid"],
                "name": item["name"],
                "primary_genre": item["primary_genre"],
                "followers": item["followers"],
                "latest_track_count": total,
                "last_scan_at": now,
            }
        )
    extra_pages, extra_page_failures = parallel_get(client, extra_page_tasks, workers=workers)
    for key, response in extra_pages.items():
        spotify_id = key.split(":", 1)[0]
        item = playlist_by_id.get(spotify_id)
        if item:
            parsed, _ = parse_playlist_track_page(response, item)
            placements.extend(parsed)

    evidence_by_uuid = aggregate_track_evidence(placements, observed_day)
    all_playlist_artist_uuids: set[str] = set()
    evidence_by_artist: dict[str, dict[str, Any]] = {}
    new_artist_uuids: set[str] = set()

    def register_detail_artists(detail: Mapping[str, Any] | None, evidence: Mapping[str, Any]) -> None:
        if not isinstance(detail, Mapping):
            return
        for artist in detail.get("artists", []):
            if not isinstance(artist, Mapping):
                continue
            artist_uuid = str(artist.get("soundcharts_uuid") or "").strip()
            if not artist_uuid:
                continue
            all_playlist_artist_uuids.add(artist_uuid)
            if str(artist.get("spotify_id") or "").strip() in baseline_ids:
                baseline_playlist_artist_uuids.add(artist_uuid)
            evidence_by_artist.setdefault(artist_uuid, dict(evidence))
            _, inserted_artist = upsert_editorial_artist(
                artist_rows,
                artist_schema,
                artists_by_uuid,
                artist,
                evidence,
                source_tier="editorial_playlist",
                now=now,
            )
            if inserted_artist:
                new_artist_uuids.add(artist_uuid)
            cached_artist = cache_artists.setdefault(artist_uuid, {})
            if isinstance(cached_artist, dict):
                cached_artist.setdefault("name", str(artist.get("name") or ""))
                cached_artist.setdefault("source_tier", "editorial_playlist")

    known_track_uuids = set(tracks_by_uuid)
    unseen = [evidence for uuid, evidence in evidence_by_uuid.items() if uuid not in known_track_uuids]
    unseen.sort(key=discovery_rank, reverse=True)

    # Persist every playlist track immediately as a lightweight discovery row.
    # Detail/identifier/stream enrichment remains quota-aware, but visibility no
    # longer waits for those later stages.
    new_playlist_tracks = 0
    for evidence in evidence_by_uuid.values():
        cached_detail = cache_track_discovery_evidence(
            cache_tracks, evidence, source_tier="editorial_playlist", now=now
        )
        _, inserted = upsert_editorial_track(
            track_rows,
            track_schema,
            tracks_by_uuid,
            evidence,
            detail=cached_detail if cached_detail.get("artists") else None,
            source_tier="editorial_playlist",
            now=now,
        )
        new_playlist_tracks += int(inserted)
        register_detail_artists(cached_detail, evidence)

    selected_unseen = unseen[: max(0, max_new_playlist_tracks)]
    detail_tasks = [
        (item["soundcharts_uuid"], "/api/v2/song/" + urllib.parse.quote(item["soundcharts_uuid"]))
        for item in selected_unseen
    ]
    detail_responses, detail_failures = parallel_get(client, detail_tasks, workers=workers)
    playlist_tracks_detailed = 0

    for evidence in selected_unseen:
        uuid = evidence["soundcharts_uuid"]
        raw_detail = detail_responses.get(uuid)
        parsed_detail = parse_song_detail(raw_detail, evidence) if raw_detail is not None else None
        if parsed_detail:
            existing = cache_tracks.get(uuid) if isinstance(cache_tracks.get(uuid), dict) else {}
            cache_tracks[uuid] = {**existing, **parsed_detail}
            cache_track_discovery_evidence(
                cache_tracks, evidence, source_tier="editorial_playlist", now=now
            )
            playlist_tracks_detailed += 1
        upsert_editorial_track(
            track_rows,
            track_schema,
            tracks_by_uuid,
            evidence,
            detail=parsed_detail,
            source_tier="editorial_playlist",
            now=now,
        )
        register_detail_artists(parsed_detail, evidence)

    # Existing playlist-derived artists remain in the rotation, even on days
    # when every playlist song is already known.
    for artist_uuid, row in artists_by_uuid.items():
        source_tier = str(field(row, artist_schema, "source_tier") or "")
        if source_tier in {"editorial_playlist", "playlist_artist_catalogue"}:
            all_playlist_artist_uuids.add(artist_uuid)
            evidence_by_artist.setdefault(
                artist_uuid,
                {
                    "primary_genre": str(field(row, artist_schema, "primary_genre") or "other_instrumental"),
                    "subgenres": field(row, artist_schema, "subgenres") or [],
                    "playlist_ids": field(row, artist_schema, "playlist_ids") or [],
                    "playlist_names": field(row, artist_schema, "playlist_names") or [],
                    "playlist_count": field(row, artist_schema, "playlist_count") or 0,
                    "playlist_followers_total": 0,
                },
            )

    artists_to_scan = catalogue_artist_order(
        all_playlist_artist_uuids,
        artist_state,
        limit=max_catalog_artists,
        baseline_artist_uuids=baseline_playlist_artist_uuids,
    )
    catalogue_tasks: list[tuple[str, str]] = []
    for artist_uuid in artists_to_scan:
        state = artist_state.get(artist_uuid) if isinstance(artist_state.get(artist_uuid), Mapping) else {}
        offset = int(_finite_number(state.get("offset")) or 0)
        query = urllib.parse.urlencode(
            {
                "isMain": 1,
                "sortBy": "releaseDate",
                "sortOrder": "desc",
                "offset": offset,
                "limit": catalog_page_size,
            }
        )
        catalogue_tasks.append(
            (artist_uuid, f"/api/v2.21/artist/{urllib.parse.quote(artist_uuid)}/songs?{query}")
        )
    catalogue_responses, catalogue_failures = parallel_get(client, catalogue_tasks, workers=workers)
    new_catalogue_tracks = 0
    catalog_rows_added_by_artist: dict[str, int] = {}
    for artist_uuid in artists_to_scan:
        response = catalogue_responses.get(artist_uuid)
        if response is None:
            continue
        artist_row = artists_by_uuid.get(artist_uuid)
        artist_name = str(field(artist_row, artist_schema, "name") or cache_artists.get(artist_uuid, {}).get("name") or "Artiste non renseigné") if artist_row is not None else str((cache_artists.get(artist_uuid) or {}).get("name") or "Artiste non renseigné")
        evidence = evidence_by_artist.get(artist_uuid, {})
        genre = str(evidence.get("primary_genre") or "other_instrumental")
        songs, total, next_offset = parse_catalogue_page(response, artist_uuid, artist_name, genre)
        # Never advance an artist cursor past a page that could not be fully
        # integrated because of the per-run track cap.  A later cycle must
        # retry the same page, otherwise the rotation silently loses part of
        # that artist's discography.
        unseen_songs = [song for song in songs if song["soundcharts_uuid"] not in tracks_by_uuid]
        if new_catalogue_tracks + len(unseen_songs) > max_new_catalog_tracks:
            break
        added_for_artist = 0
        for song in songs:
            uuid = song["soundcharts_uuid"]
            if uuid in tracks_by_uuid:
                continue
            song_evidence = {
                **song,
                # The artist was discovered through these playlists; the
                # catalogue track itself was not necessarily present in them.
                "playlist_ids": [],
                "playlist_names": [],
                "playlist_count": 0,
                "playlist_best_position": None,
                "playlist_followers_total": 0,
                "playlist_first_seen_at": None,
                "playlist_last_seen_at": None,
                "playlist_placements": [],
                "discovery_source_playlist_ids": evidence.get("playlist_ids") or [],
                "discovery_source_playlist_names": evidence.get("playlist_names") or [],
                "subgenres": evidence.get("subgenres") or [],
            }
            cache_track_discovery_evidence(
                cache_tracks, song_evidence, source_tier="playlist_artist_catalogue", now=now
            )
            upsert_editorial_track(
                track_rows,
                track_schema,
                tracks_by_uuid,
                song_evidence,
                detail=None,
                source_tier="playlist_artist_catalogue",
                now=now,
            )
            new_catalogue_tracks += 1
            added_for_artist += 1
        catalog_rows_added_by_artist[artist_uuid] = added_for_artist
        artist_state[artist_uuid] = {
            **(artist_state.get(artist_uuid) if isinstance(artist_state.get(artist_uuid), dict) else {}),
            "offset": int(next_offset or 0),
            "total": total,
            "last_scan_at": now,
        }
        if artist_row is not None:
            current_count = int(_finite_number(field(artist_row, artist_schema, "catalogue_tracks_discovered")) or 0)
            set_field(artist_row, artist_schema, "catalogue_tracks_discovered", current_count + added_for_artist)
            set_field(artist_row, artist_schema, "last_catalogue_scan_at", now)
            set_field(artist_row, artist_schema, "updated_at", now)

    discovery["version"] = DISCOVERY_VERSION
    discovery["updated_at"] = now
    cache["version"] = CACHE_VERSION
    cache["updated_at"] = now

    failures = {
        "playlist_metadata": metadata_failures,
        "playlist_first_pages": first_page_failures,
        "playlist_extra_pages": extra_page_failures,
        "song_details": detail_failures,
        "artist_catalogues": catalogue_failures,
    }
    summary = {
        "status": "success",
        "finished_at": now,
        "playlists_targeted": len(playlists),
        "playlists_resolved": len(resolved_playlists),
        "playlists_scanned": scanned_playlists,
        "tracklist_rows": len(placements),
        "unique_playlist_tracks": len(evidence_by_uuid),
        "unseen_playlist_tracks": len(unseen),
        "new_playlist_tracks": new_playlist_tracks,
        "playlist_tracks_detailed": playlist_tracks_detailed,
        "new_artist_credits": len(new_artist_uuids),
        "catalogue_artists_available": len(all_playlist_artist_uuids),
        "catalogue_artists_scanned": len(catalogue_responses),
        "new_catalogue_tracks": new_catalogue_tracks,
        "editorial_tracks_total": len(track_rows),
        "editorial_artists_total": len(artist_rows),
        "baseline_catalogue": {
            "source_track_rows": int(_finite_number((baseline or {}).get("source_track_rows")) or 0),
            "source_artist_rows": int(_finite_number((baseline or {}).get("source_artist_rows")) or 0),
            "structured_artist_seeds": len(baseline_ids),
            "playlist_artist_matches": len(baseline_playlist_artist_uuids),
            "prioritized_catalogues": sum(artist_uuid in baseline_playlist_artist_uuids for artist_uuid in artists_to_scan),
            "archive_only_until_validated": True,
        },
        "requests": int(getattr(client, "requests_claimed", 0)),
        "quota_remaining": getattr(client, "quota_remaining", None),
        "failures": failures,
        "cadence": {
            "playlist_tracklists": "daily_all_target_editorial",
            "artist_catalogues": "daily_rotating_page",
            "no_instrumental_or_ai_assumption": True,
        },
    }
    if scanned_playlists == 0 or not evidence_by_uuid:
        raise PlaylistDiscoveryError("No target editorial playlist returned a usable tracklist")
    soundcharts["playlist_discovery"] = summary
    freshness = soundcharts.setdefault("freshness", {})
    if isinstance(freshness, dict):
        freshness["playlist_discovery_at"] = now
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--playlists", type=Path, default=Path("Spotify_Playlists_data.js"))
    parser.add_argument("--cache", type=Path, default=Path("soundcharts-instrumental-cache.json"))
    parser.add_argument("--baseline", type=Path, default=Path("spotify-catalogue-baseline.json"))
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--max-requests", type=int, default=1_400)
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--playlist-limit", type=int)
    parser.add_argument("--max-new-playlist-tracks", type=int, default=450)
    parser.add_argument("--max-catalog-artists", type=int, default=250)
    parser.add_argument("--catalog-page-size", type=int, default=25)
    parser.add_argument("--max-new-catalog-tracks", type=int, default=1_200)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    soundcharts = read_js_payload(args.soundcharts, SOUNDCHARTS_PREFIX)
    playlists = read_js_payload(args.playlists, PLAYLISTS_PREFIX)
    cache = read_cache(args.cache)
    baseline = read_baseline(args.baseline)
    client = SoundchartsClient(
        os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
        request_limit=max(1, args.max_requests),
    )
    client.authenticate()
    client.require_quota_reserve()
    summary = discover_from_playlists(
        soundcharts,
        playlists,
        cache,
        client,
        workers=args.workers,
        page_size=max(10, min(100, args.page_size)),
        playlist_limit=args.playlist_limit,
        max_new_playlist_tracks=max(0, args.max_new_playlist_tracks),
        max_catalog_artists=max(0, args.max_catalog_artists),
        catalog_page_size=max(5, min(100, args.catalog_page_size)),
        max_new_catalog_tracks=max(0, args.max_new_catalog_tracks),
        baseline=baseline,
    )
    write_js_payload(args.soundcharts, soundcharts, SOUNDCHARTS_PREFIX)
    write_cache(args.cache, cache)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
