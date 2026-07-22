#!/usr/bin/env python3
"""Expand Spotify Radar's measured instrumental/background-music universe.

The licensed Soundcharts export already contains an editorial classification table
for background-music genres, but most rows do not yet have Spotify IDs or daily
stream history.  Soundcharts' song audience endpoint returns both the Spotify
identifier and up to 90 daily cumulative stream points.  This collector turns
that editorial universe into real, measurable Spotify tracks, enriches rights and
artist identity once, and appends exact histories to ``Spotify_Performance_data.js``.

The script is designed for a 4M request/month plan:

* audience history is refreshed for the full target pool every production run;
* song metadata and artist identifiers/stats are cached and refreshed slowly;
* HTTP success without usable Spotify points never advances freshness;
* no missing daily point is extrapolated.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import re
import threading
import urllib.parse
from pathlib import Path
from typing import Any, Iterable, Mapping

from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
)


SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
CACHE_VERSION = 1

TARGET_GENRES = frozenset(
    {
        "lofi_hip_hop",
        "guitar",
        "nature",
        "jazz_jazzhop",
        "classical",
        "ambient",
        "piano",
        "halloween_lofi",
        "christmas_lofi",
        "dark_ambient",
        "phonk_instrumental",
        "dnb_instrumental",
        "synthwave",
        "sleep",
        "meditation",
        "soundscape",
        "other_instrumental",
    }
)

TRACK_EXTRA_FIELDS = (
    "artists",
    "spotify_aliases",
    "isrc",
    "image_url",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "rights_confidence",
    "source_tier",
)

ARTIST_EXTRA_FIELDS = (
    "spotify_followers",
    "contact_url",
    "contact_platform",
    "source_tier",
)

MAJOR_MARKERS = tuple(
    marker.casefold()
    for marker in (
        "Sony Music",
        "Sony Entertainment",
        "Columbia Records",
        "RCA Records",
        "Epic Records",
        "Arista Records",
        "Universal Music",
        "UMG",
        "Republic Records",
        "Interscope",
        "Geffen",
        "Capitol Records",
        "Island Records",
        "Def Jam",
        "Polydor",
        "Virgin Music",
        "EMI",
        "Warner Music",
        "Warner Records",
        "Atlantic Records",
        "Elektra",
        "Parlophone",
        "300 Entertainment",
        "BMG Rights",
    )
)

SPOTIFY_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")


class InstrumentalPoolError(RuntimeError):
    """Safe, secret-free failure raised by the pool collector."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def read_js_payload(path: Path, prefix: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise InstrumentalPoolError(f"{path} does not start with {prefix[:-1]}")
    try:
        payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise InstrumentalPoolError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise InstrumentalPoolError(f"{path} does not contain an object payload")
    return payload


def write_js_payload(path: Path, payload: dict[str, Any], prefix: str) -> None:
    path.write_text(prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def read_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": CACHE_VERSION, "updated_at": None, "tracks": {}, "artists": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InstrumentalPoolError(f"{path} contains invalid cache JSON") from exc
    if not isinstance(payload, dict):
        raise InstrumentalPoolError("Instrumental cache must be an object")
    payload.setdefault("version", CACHE_VERSION)
    payload.setdefault("tracks", {})
    payload.setdefault("artists", {})
    return payload


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
        raise InstrumentalPoolError(f"Schema field {name} was not initialized")
    while len(row) <= index:
        row.append(None)
    row[index] = value


def ensure_schema_fields(payload: dict[str, Any], group: str, names: Iterable[str]) -> tuple[list[str], list[list[Any]]]:
    schemas = payload.setdefault("schemas", {})
    if not isinstance(schemas, dict):
        raise InstrumentalPoolError("Soundcharts schemas must be an object")
    schema = schemas.setdefault(group, [])
    rows = payload.setdefault(group, [])
    if not isinstance(schema, list) or not isinstance(rows, list):
        raise InstrumentalPoolError(f"Invalid {group} export")
    for name in names:
        if name in schema:
            continue
        schema.append(name)
        for row in rows:
            if isinstance(row, list):
                row.append(None)
    return schema, rows


def finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return value
    return None


def normalize_day(value: Any) -> str | None:
    raw = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return None


def normalize_timestamp(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def is_stale(value: Any, days: int) -> bool:
    stamp = normalize_timestamp(value)
    if not stamp:
        return True
    parsed = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return dt.datetime.now(dt.timezone.utc) - parsed >= dt.timedelta(days=max(0, days))


def merge_history(existing: Any, incoming: Any, keep_days: int = 120) -> list[list[Any]]:
    daily: dict[str, int] = {}
    for source in (existing, incoming):
        if not isinstance(source, list):
            continue
        for point in source:
            if isinstance(point, list) and len(point) >= 2:
                raw_day, raw_value = point[0], point[1]
            elif isinstance(point, Mapping):
                raw_day, raw_value = point.get("date"), point.get("value")
            else:
                continue
            day = normalize_day(raw_day)
            value = finite_number(raw_value)
            if day and value is not None:
                daily[day] = int(value)
    if not daily:
        return []
    latest = dt.date.fromisoformat(max(daily))
    cutoff = latest - dt.timedelta(days=max(31, keep_days))
    return [[day, daily[day]] for day in sorted(daily) if dt.date.fromisoformat(day) >= cutoff]


def counter_window(history: list[list[Any]], days: int) -> int | None:
    if not history:
        return None
    by_day = {str(point[0]): int(point[1]) for point in history if isinstance(point, list) and len(point) >= 2}
    latest_day, latest_value = history[-1][0], int(history[-1][1])
    baseline = (dt.date.fromisoformat(latest_day) - dt.timedelta(days=days)).isoformat()
    return latest_value - by_day[baseline] if baseline in by_day else None


def walk_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def parse_audience_response(response: Any, preferred_id: str = "") -> dict[str, Any] | None:
    """Extract a canonical Spotify ID and exact cumulative daily points.

    Soundcharts occasionally returns multiple Spotify identifiers for one song.
    We keep aliases and choose deterministically: preferred existing ID first,
    otherwise the identifier with the most dated points, newest point, then ID.
    """

    series: dict[str, dict[str, int]] = {}
    for item in walk_dicts(response):
        day = normalize_day(item.get("date"))
        plots = item.get("plots")
        if not day or not isinstance(plots, list):
            continue
        for plot in plots:
            if not isinstance(plot, dict):
                continue
            identifier = str(plot.get("identifier") or "").strip()
            value = finite_number(plot.get("value"))
            if not SPOTIFY_ID_RE.fullmatch(identifier) or value is None:
                continue
            series.setdefault(identifier, {})[day] = int(value)
    if not series:
        return None

    def rank(item: tuple[str, dict[str, int]]) -> tuple[int, str, int, str]:
        identifier, points = item
        latest_day = max(points) if points else ""
        latest_value = points.get(latest_day, 0)
        preferred = 1 if identifier == preferred_id else 0
        return preferred, len(points), latest_day, latest_value

    canonical, points_by_day = max(series.items(), key=rank)
    points = [[day, points_by_day[day]] for day in sorted(points_by_day)]
    return {
        "spotify_id": canonical,
        "aliases": sorted(series),
        "history": points,
        "latest_day": points[-1][0],
        "latest_value": points[-1][1],
        "delta_24h": counter_window(points, 1),
        "streams_7d": counter_window(points, 7),
        "streams_30d": counter_window(points, 30),
    }


def editorial_candidates(payload: dict[str, Any], include_review: bool = True) -> list[dict[str, Any]]:
    editorial = payload.get("editorial") if isinstance(payload.get("editorial"), dict) else {}
    schema = editorial.get("track_schema") if isinstance(editorial.get("track_schema"), list) else []
    rows = editorial.get("tracks") if isinstance(editorial.get("tracks"), list) else []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        uuid = str(field(row, schema, "soundcharts_uuid") or "").strip()
        genre = str(field(row, schema, "primary_genre") or "").strip()
        genre_confidence = finite_number(field(row, schema, "genre_confidence"))
        ai_risk = str(field(row, schema, "ai_risk") or "unknown").strip().casefold()
        expansion = str(field(row, schema, "expansion_status") or "review").strip().casefold()
        instrumental = str(field(row, schema, "instrumental_status") or "unknown").strip().casefold()
        instrumental_confidence = finite_number(field(row, schema, "instrumental_confidence"))
        source_tier = str(field(row, schema, "source_tier") or "").strip().casefold()
        playlist_source = source_tier in {"editorial_playlist", "playlist_artist_catalogue"}
        ai_safe = ai_risk in {"low", "faible"}
        ai_reviewable = playlist_source and ai_risk in {"", "unknown", "unclassified", "pending"}
        if not uuid or uuid in seen or genre not in TARGET_GENRES:
            continue
        if genre_confidence is None or genre_confidence < 0.5:
            continue
        if not ai_safe and not ai_reviewable:
            continue
        verified = ai_safe and instrumental == "instrumental" and (instrumental_confidence or 0) >= 0.5
        if expansion != "eligible" and not (include_review and expansion == "review"):
            continue
        if expansion == "eligible" and not verified and not include_review:
            continue
        seen.add(uuid)
        out.append(
            {
                "soundcharts_uuid": uuid,
                "spotify_id": str(field(row, schema, "spotify_id") or "").strip(),
                "title": str(field(row, schema, "name") or "Titre non renseigné"),
                "credit_name": str(field(row, schema, "artist") or "Artiste non renseigné"),
                "release_date": str(field(row, schema, "release_date") or ""),
                "primary_genre": genre,
                "subgenres": list(field(row, schema, "subgenres") or [])
                if isinstance(field(row, schema, "subgenres"), list)
                else [],
                "genre_confidence": float(genre_confidence),
                "instrumental_status": instrumental,
                "instrumental_confidence": float(instrumental_confidence or 0),
                "ai_risk": ai_risk,
                "ai_risk_score": finite_number(field(row, schema, "ai_risk_score")),
                "expansion_status": expansion,
                "classification_status": "verified" if verified else "needs_listen",
                "metadata_status": str(field(row, schema, "metadata_status") or ""),
                "updated_at": str(field(row, schema, "updated_at") or ""),
                "source_tier": source_tier,
                "playlist_ids": list(field(row, schema, "playlist_ids") or [])
                if isinstance(field(row, schema, "playlist_ids"), list)
                else [],
                "playlist_names": list(field(row, schema, "playlist_names") or [])
                if isinstance(field(row, schema, "playlist_names"), list)
                else [],
                "playlist_count": int(finite_number(field(row, schema, "playlist_count")) or 0),
                "playlist_best_position": finite_number(field(row, schema, "playlist_best_position")),
                "playlist_followers_total": int(finite_number(field(row, schema, "playlist_followers_total")) or 0),
                "playlist_first_seen_at": str(field(row, schema, "playlist_first_seen_at") or ""),
                "playlist_last_seen_at": str(field(row, schema, "playlist_last_seen_at") or ""),
                "discovered_at": str(field(row, schema, "discovered_at") or ""),
            }
        )
    return out


def prioritize_candidates(
    payload: dict[str, Any],
    performance: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), dict) else {}
    opportunity_schema = schemas.get("opportunities") if isinstance(schemas.get("opportunities"), list) else []
    opportunity_rows = payload.get("opportunities") if isinstance(payload.get("opportunities"), list) else []
    opportunity_uuids = {
        str(field(row, opportunity_schema, "soundcharts_uuid") or "").strip()
        for row in opportunity_rows
    }
    track_schema = schemas.get("tracks") if isinstance(schemas.get("tracks"), list) else []
    track_rows = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    measured_uuids = {
        str(field(row, track_schema, "soundcharts_uuid") or "").strip()
        for row in track_rows
        if field(row, track_schema, "soundcharts_uuid")
    }
    performance_tracks = performance.get("tracks") if isinstance(performance.get("tracks"), dict) else {}

    def timestamp(value: Any) -> float:
        raw = str(value or "").strip()
        if not raw:
            return 0.0
        try:
            parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.timestamp()

    def priority(item: dict[str, Any]) -> tuple[int, float, int, int, str]:
        uuid = item["soundcharts_uuid"]
        source_tier = str(item.get("source_tier") or "")
        playlist_source = source_tier in {"editorial_playlist", "playlist_artist_catalogue"}
        measured = uuid in measured_uuids or bool(item.get("spotify_id") and item.get("spotify_id") in performance_tracks)
        if uuid in opportunity_uuids:
            tier = 0
        elif playlist_source and not measured:
            tier = 1
        elif item.get("classification_status") == "verified":
            tier = 2
        elif playlist_source:
            tier = 3
        else:
            tier = 4
        return (
            tier,
            timestamp(item.get("discovered_at") or item.get("updated_at")),
            int(item.get("playlist_count") or 0),
            int(item.get("playlist_followers_total") or 0),
            uuid,
        )

    # Reverse evidence/date fields inside a stable tier without reversing the
    # tier itself.
    return sorted(
        candidates,
        key=lambda item: (
            priority(item)[0],
            -priority(item)[1],
            -priority(item)[2],
            -priority(item)[3],
            priority(item)[4],
        ),
    )


def normalize_name(value: Any) -> str:
    text = re.sub(r"[^0-9a-z]+", " ", str(value or "").casefold())
    return re.sub(r"\s+", " ", text).strip()


def infer_rights(label: Any, copyright_text: Any, artists: list[dict[str, Any]], credit_name: str) -> tuple[str, float]:
    label_text = str(label or "").strip()
    copyright_value = str(copyright_text or "").strip()
    combined = f"{label_text} {copyright_value}".casefold()
    if any(marker in combined for marker in MAJOR_MARKERS):
        return "major", 0.98

    artist_names = [str(artist.get("name") or "").strip() for artist in artists if isinstance(artist, dict)]
    if credit_name:
        artist_names.append(credit_name)
    normalized_label = normalize_name(label_text)
    normalized_copyright = normalize_name(copyright_value)
    normalized_artists = [normalize_name(name) for name in artist_names if normalize_name(name)]
    artist_owned_label = bool(normalized_label and any(normalized_label == name for name in normalized_artists))
    artist_copyright = bool(normalized_copyright and any(name in normalized_copyright for name in normalized_artists))
    self_marker = any(marker in combined for marker in ("self released", "self-released", "independent artist", "artist release"))
    if self_marker or artist_owned_label or (not label_text and artist_copyright):
        return "self_released", 0.9 if (artist_owned_label or self_marker) else 0.75
    if label_text:
        return "independent_label", 0.65
    if artist_copyright:
        return "self_released", 0.6
    return "unknown", 0.25


def parse_song_detail(response: Any, editorial: dict[str, Any]) -> dict[str, Any] | None:
    obj = response.get("object") if isinstance(response, dict) else None
    if not isinstance(obj, dict):
        return None
    main_ids = {
        str(item.get("uuid") or "")
        for item in obj.get("mainArtists", [])
        if isinstance(item, dict) and item.get("uuid")
    }
    artists = []
    for item in obj.get("artists", []):
        if not isinstance(item, dict):
            continue
        uuid = str(item.get("uuid") or "").strip()
        name = str(item.get("name") or "").strip()
        if not uuid or not name:
            continue
        artists.append(
            {
                "soundcharts_uuid": uuid,
                "spotify_id": "",
                "name": name,
                "role": "main" if uuid in main_ids or not main_ids else "featured",
                "soundcharts_url": str(item.get("appUrl") or ""),
                "image_url": str(item.get("imageUrl") or ""),
            }
        )
    credit = str(obj.get("creditName") or editorial.get("credit_name") or "")
    rights, confidence = infer_rights(obj.get("label"), obj.get("copyright"), artists, credit)
    isrc = obj.get("isrc")
    if isinstance(isrc, dict):
        isrc = isrc.get("value")
    return {
        "soundcharts_uuid": str(obj.get("uuid") or editorial.get("soundcharts_uuid") or ""),
        "title": str(obj.get("name") or editorial.get("title") or ""),
        "credit_name": credit,
        "artists": artists,
        "release_date": str(obj.get("releaseDate") or editorial.get("release_date") or ""),
        "label": str(obj.get("label") or ""),
        "copyright": str(obj.get("copyright") or ""),
        "isrc": str(isrc or ""),
        "image_url": str(obj.get("imageUrl") or ""),
        "duration": finite_number(obj.get("duration")),
        "explicit": bool(obj.get("explicit")) if obj.get("explicit") is not None else None,
        "rights_status": rights,
        "rights_confidence": confidence,
        "fetched_at": utc_now(),
    }


def parse_artist_identifiers(response: Any) -> dict[str, Any]:
    items = response.get("items") if isinstance(response, dict) else []
    spotify_id = ""
    social_candidates: list[tuple[int, str, str]] = []
    priority = {
        "website": 0,
        "instagram": 1,
        "bandcamp": 2,
        "soundcloud": 3,
        "tiktok": 4,
        "facebook": 5,
        "youtube": 6,
        "twitter": 7,
        "x": 7,
    }
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("platformCode") or "").casefold()
        identifier = str(item.get("identifier") or "").strip()
        url = str(item.get("url") or "").strip()
        if code == "spotify" and SPOTIFY_ID_RE.fullmatch(identifier):
            if item.get("default") or item.get("verified") or not spotify_id:
                spotify_id = identifier
        if url and code in priority:
            social_candidates.append((priority[code], code, url))
    social_candidates.sort()
    contact_platform = social_candidates[0][1] if social_candidates else ""
    contact_url = social_candidates[0][2] if social_candidates else ""
    return {"spotify_id": spotify_id, "contact_platform": contact_platform, "contact_url": contact_url}


def parse_artist_stats(response: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "monthly_listeners": None,
        "monthly_listeners_change": None,
        "monthly_listeners_date": None,
        "spotify_followers": None,
    }
    if not isinstance(response, dict):
        return result
    for section, output_name in (("streaming", "monthly_listeners"), ("social", "spotify_followers")):
        values = response.get(section)
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict) or str(item.get("platform") or "").casefold() != "spotify":
                continue
            value = finite_number(item.get("value"))
            if value is None:
                continue
            result[output_name] = int(value)
            if section == "streaming":
                change = finite_number(item.get("evolution"))
                result["monthly_listeners_change"] = int(change) if change is not None else None
                result["monthly_listeners_date"] = normalize_day(item.get("date"))
            break
    return result


class RequestBudget:
    def __init__(self, maximum: int):
        self.maximum = max(0, maximum)
        self.used = 0
        self.lock = threading.Lock()

    def claim(self, count: int = 1) -> bool:
        with self.lock:
            if self.used + count > self.maximum:
                return False
            self.used += count
            return True


def parallel_requests(
    client: Any,
    tasks: Iterable[tuple[str, str]],
    budget: RequestBudget,
    workers: int,
) -> tuple[dict[str, Any], int]:
    selected: list[tuple[str, str]] = []
    for key, path in tasks:
        if not budget.claim():
            break
        selected.append((key, path))
    results: dict[str, Any] = {}
    failures = 0

    def fetch(task: tuple[str, str]) -> tuple[str, Any]:
        key, path = task
        return key, client.get(path)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(fetch, task) for task in selected]
        stop_error: SoundchartsError | None = None
        for future in concurrent.futures.as_completed(futures):
            try:
                key, payload = future.result()
                results[key] = payload
            except (SoundchartsQuotaReserveError, SoundchartsRequestLimitError) as exc:
                stop_error = exc
                failures += 1
            except (SoundchartsError, OSError, RuntimeError):
                failures += 1
    if stop_error is not None:
        raise stop_error
    return results, failures


def _row_maps(payload: dict[str, Any], group: str) -> tuple[list[str], list[list[Any]], dict[str, list[Any]], dict[str, list[Any]]]:
    schema, rows = ensure_schema_fields(payload, group, [])
    by_spotify: dict[str, list[Any]] = {}
    by_uuid: dict[str, list[Any]] = {}
    for row in rows:
        spotify_id = str(field(row, schema, "spotify_id") or "").strip()
        uuid = str(field(row, schema, "soundcharts_uuid") or "").strip()
        if spotify_id:
            by_spotify[spotify_id] = row
        if uuid:
            by_uuid[uuid] = row
    return schema, rows, by_spotify, by_uuid


def _new_row(schema: list[str]) -> list[Any]:
    return [None] * len(schema)


def expand_instrumental_pool(
    soundcharts: dict[str, Any],
    performance: dict[str, Any],
    cache: dict[str, Any],
    client: Any,
    *,
    workers: int = 24,
    max_requests: int = 80_000,
    history_days: int = 90,
    metadata_refresh_days: int = 30,
    artist_refresh_days: int = 7,
    limit: int | None = None,
    include_review: bool = True,
) -> dict[str, Any]:
    candidates = prioritize_candidates(
        soundcharts,
        performance,
        editorial_candidates(soundcharts, include_review=include_review),
    )
    if limit is not None:
        candidates = candidates[: max(0, limit)]
    if not candidates:
        raise InstrumentalPoolError("No target editorial tracks are available")

    track_schema, track_rows = ensure_schema_fields(
        soundcharts,
        "tracks",
        (
            "spotify_id",
            "artist",
            "title",
            "release_date",
            "streams",
            "delta",
            "source_date",
            "observed_at",
            "rights_status",
            "status_source",
            "label",
            "copyright",
            "distributor",
            "metadata_status",
            "identifiers_status",
            "metadata_updated_at",
            "soundcharts_uuid",
            "previous_source_date",
            *TRACK_EXTRA_FIELDS,
        ),
    )
    artist_schema, artist_rows = ensure_schema_fields(
        soundcharts,
        "artists",
        (
            "spotify_id",
            "name",
            "monthly_listeners",
            "delta",
            "source_date",
            "observed_at",
            "qualifies",
            "fal_in",
            "fal_out",
            "soundcharts_uuid",
            *ARTIST_EXTRA_FIELDS,
        ),
    )
    tracks_by_uuid: dict[str, list[Any]] = {}
    tracks_by_spotify: dict[str, list[Any]] = {}
    for row in track_rows:
        uuid = str(field(row, track_schema, "soundcharts_uuid") or "").strip()
        spotify_id = str(field(row, track_schema, "spotify_id") or "").strip()
        if uuid:
            tracks_by_uuid[uuid] = row
        if spotify_id:
            tracks_by_spotify[spotify_id] = row

    artists_by_uuid: dict[str, list[Any]] = {}
    artists_by_spotify: dict[str, list[Any]] = {}
    for row in artist_rows:
        uuid = str(field(row, artist_schema, "soundcharts_uuid") or "").strip()
        spotify_id = str(field(row, artist_schema, "spotify_id") or "").strip()
        if uuid:
            artists_by_uuid[uuid] = row
        if spotify_id:
            artists_by_spotify[spotify_id] = row

    cache_tracks = cache.setdefault("tracks", {})
    cache_artists = cache.setdefault("artists", {})
    if not isinstance(cache_tracks, dict) or not isinstance(cache_artists, dict):
        raise InstrumentalPoolError("Instrumental cache groups must be objects")

    budget = RequestBudget(max_requests)
    today = utc_today()
    period_days = min(90, max(31, history_days))
    start = (today - dt.timedelta(days=period_days - 1)).isoformat()
    end = today.isoformat()

    audience_tasks: list[tuple[str, str]] = []
    preferred_ids: dict[str, str] = {}
    candidate_by_uuid = {item["soundcharts_uuid"]: item for item in candidates}
    for item in candidates:
        uuid = item["soundcharts_uuid"]
        current_row = tracks_by_uuid.get(uuid)
        preferred = (
            str(field(current_row, track_schema, "spotify_id") or "").strip()
            if current_row is not None
            else str(cache_tracks.get(uuid, {}).get("spotify_id") or item.get("spotify_id") or "").strip()
        )
        preferred_ids[uuid] = preferred
        query = urllib.parse.urlencode({"startDate": start, "endDate": end, "limit": max(100, period_days + 5)})
        audience_tasks.append((uuid, f"/api/v2/song/{urllib.parse.quote(uuid)}/audience/spotify?{query}"))

    audience_responses, audience_failures = parallel_requests(client, audience_tasks, budget, workers)
    audiences: dict[str, dict[str, Any]] = {}
    for uuid, response in audience_responses.items():
        parsed = parse_audience_response(response, preferred_ids.get(uuid, ""))
        if parsed:
            audiences[uuid] = parsed

    metadata_tasks: list[tuple[str, str]] = []
    for item in candidates:
        uuid = item["soundcharts_uuid"]
        cached = cache_tracks.get(uuid) if isinstance(cache_tracks.get(uuid), dict) else {}
        if not cached or is_stale(cached.get("fetched_at"), metadata_refresh_days):
            metadata_tasks.append((uuid, f"/api/v2/song/{urllib.parse.quote(uuid)}"))
    metadata_responses, metadata_failures = parallel_requests(client, metadata_tasks, budget, workers)
    for uuid, response in metadata_responses.items():
        parsed = parse_song_detail(response, candidate_by_uuid[uuid])
        if parsed:
            existing = cache_tracks.get(uuid) if isinstance(cache_tracks.get(uuid), dict) else {}
            cache_tracks[uuid] = {**existing, **parsed}

    unique_artists: dict[str, str] = {}
    for item in candidates:
        cached = cache_tracks.get(item["soundcharts_uuid"])
        if not isinstance(cached, dict):
            continue
        for artist in cached.get("artists", []):
            if isinstance(artist, dict) and artist.get("soundcharts_uuid") and artist.get("name"):
                unique_artists[str(artist["soundcharts_uuid"])] = str(artist["name"])

    identifier_tasks: list[tuple[str, str]] = []
    stats_tasks: list[tuple[str, str]] = []
    for uuid, name in unique_artists.items():
        cached = cache_artists.get(uuid) if isinstance(cache_artists.get(uuid), dict) else {}
        if not cached or is_stale(cached.get("identifiers_fetched_at"), metadata_refresh_days):
            identifier_tasks.append((uuid, f"/api/v2/artist/{urllib.parse.quote(uuid)}/identifiers?offset=0&limit=100"))
        if not cached or is_stale(cached.get("stats_fetched_at"), artist_refresh_days):
            stats_tasks.append((uuid, f"/api/v2/artist/{urllib.parse.quote(uuid)}/current/stats"))
        if uuid not in cache_artists:
            cache_artists[uuid] = {"name": name}

    identifier_responses, identifier_failures = parallel_requests(client, identifier_tasks, budget, workers)
    for uuid, response in identifier_responses.items():
        entry = cache_artists.setdefault(uuid, {})
        entry.update(parse_artist_identifiers(response))
        entry["identifiers_fetched_at"] = utc_now()

    stats_responses, stats_failures = parallel_requests(client, stats_tasks, budget, workers)
    for uuid, response in stats_responses.items():
        entry = cache_artists.setdefault(uuid, {})
        entry.update(parse_artist_stats(response))
        related = response.get("related") if isinstance(response, dict) else None
        if isinstance(related, dict):
            entry["name"] = str(related.get("name") or entry.get("name") or "")
            entry["image_url"] = str(related.get("imageUrl") or entry.get("image_url") or "")
            entry["soundcharts_url"] = str(related.get("appUrl") or entry.get("soundcharts_url") or "")
        entry["stats_fetched_at"] = utc_now()

    performance_tracks = performance.setdefault("tracks", {})
    if not isinstance(performance_tracks, dict):
        raise InstrumentalPoolError("Performance tracks must be an object")

    measured = 0
    inserted = 0
    updated = 0
    daily_ready = 0
    verified_measured = 0
    review_measured = 0
    playlist_selected = sum(
        str(item.get("source_tier") or "") in {"editorial_playlist", "playlist_artist_catalogue"}
        for item in candidates
    )
    playlist_measured = 0
    rights_counts: dict[str, int] = {}
    latest_source_date: str | None = None
    now = utc_now()

    for item in candidates:
        uuid = item["soundcharts_uuid"]
        audience = audiences.get(uuid)
        if not audience:
            continue
        track_meta = cache_tracks.get(uuid) if isinstance(cache_tracks.get(uuid), dict) else {}
        spotify_id = audience["spotify_id"]
        row = tracks_by_uuid.get(uuid) or tracks_by_spotify.get(spotify_id)
        if row is None:
            row = _new_row(track_schema)
            track_rows.append(row)
            inserted += 1
        else:
            updated += 1

        structured_artists: list[dict[str, Any]] = []
        for artist in track_meta.get("artists", []) if isinstance(track_meta, dict) else []:
            if not isinstance(artist, dict):
                continue
            artist_uuid = str(artist.get("soundcharts_uuid") or "").strip()
            cached_artist = cache_artists.get(artist_uuid) if isinstance(cache_artists.get(artist_uuid), dict) else {}
            structured_artists.append(
                {
                    "soundcharts_uuid": artist_uuid,
                    "spotify_id": str(cached_artist.get("spotify_id") or ""),
                    "name": str(artist.get("name") or cached_artist.get("name") or ""),
                    "role": str(artist.get("role") or "unknown"),
                }
            )

        rights_status = str(track_meta.get("rights_status") or field(row, track_schema, "rights_status") or "unknown")
        rights_confidence = finite_number(track_meta.get("rights_confidence")) or 0.25
        history = merge_history(
            performance_tracks.get(spotify_id, {}).get("history")
            if isinstance(performance_tracks.get(spotify_id), dict)
            else [],
            audience["history"],
        )
        latest_day = audience["latest_day"]
        previous = (dt.date.fromisoformat(latest_day) - dt.timedelta(days=1)).isoformat()

        values = {
            "spotify_id": spotify_id,
            "artist": str(track_meta.get("credit_name") or item["credit_name"]),
            "title": str(track_meta.get("title") or item["title"]),
            "release_date": str(track_meta.get("release_date") or item["release_date"]),
            "streams": int(audience["latest_value"]),
            "delta": audience["delta_24h"],
            "source_date": latest_day,
            "observed_at": now,
            "rights_status": rights_status,
            "status_source": "soundcharts_song_metadata",
            "label": str(track_meta.get("label") or ""),
            "copyright": str(track_meta.get("copyright") or ""),
            "distributor": str(track_meta.get("distributor") or ""),
            "metadata_status": "complete" if track_meta else item.get("metadata_status") or "pending",
            "identifiers_status": "complete",
            "metadata_updated_at": str(track_meta.get("fetched_at") or item.get("updated_at") or now),
            "soundcharts_uuid": uuid,
            "previous_source_date": previous if audience["delta_24h"] is not None else None,
            "artists": structured_artists,
            "spotify_aliases": audience["aliases"],
            "isrc": str(track_meta.get("isrc") or ""),
            "image_url": str(track_meta.get("image_url") or ""),
            "primary_genre": item["primary_genre"],
            "subgenres": item["subgenres"],
            "genre_confidence": item["genre_confidence"],
            "instrumental_status": item["instrumental_status"],
            "instrumental_confidence": item["instrumental_confidence"],
            "ai_risk": item["ai_risk"],
            "ai_risk_score": item["ai_risk_score"],
            "expansion_status": item["expansion_status"],
            "rights_confidence": rights_confidence,
            "source_tier": item.get("source_tier") or "instrumental_editorial_daily",
        }
        for name, value in values.items():
            set_field(row, track_schema, name, value)
        tracks_by_uuid[uuid] = row
        tracks_by_spotify[spotify_id] = row

        perf_entry = performance_tracks.setdefault(spotify_id, {})
        if not isinstance(perf_entry, dict):
            perf_entry = {}
            performance_tracks[spotify_id] = perf_entry
        perf_entry.update(
            {
                "history": history,
                "soundcharts_uuid": uuid,
                "observed_at": now,
                "cadence_days": 1,
                "source": "soundcharts_instrumental_pool",
                "classification": {
                    "genre": item["primary_genre"],
                    "subgenres": item["subgenres"],
                    "genre_confidence": item["genre_confidence"],
                    "genre_source": item.get("source_tier") or "soundcharts_editorial",
                    "instrumental": item["instrumental_status"],
                    "instrumental_confidence": item["instrumental_confidence"],
                    "ai_risk": item["ai_risk"],
                    "ai_risk_score": item["ai_risk_score"],
                },
                "rights_status": rights_status,
                "rights_confidence": rights_confidence,
                "spotify_aliases": audience["aliases"],
            }
        )
        measured += 1
        daily_ready += int(audience["delta_24h"] is not None)
        verified_measured += int(item["classification_status"] == "verified")
        review_measured += int(item["classification_status"] == "needs_listen")
        playlist_measured += int(
            str(item.get("source_tier") or "") in {"editorial_playlist", "playlist_artist_catalogue"}
        )
        rights_counts[rights_status] = rights_counts.get(rights_status, 0) + 1
        if latest_source_date is None or latest_day > latest_source_date:
            latest_source_date = latest_day

        for structured in structured_artists:
            artist_uuid = structured["soundcharts_uuid"]
            cached_artist = cache_artists.get(artist_uuid) if isinstance(cache_artists.get(artist_uuid), dict) else {}
            artist_spotify = str(cached_artist.get("spotify_id") or structured.get("spotify_id") or "")
            artist_row = artists_by_uuid.get(artist_uuid) or (artists_by_spotify.get(artist_spotify) if artist_spotify else None)
            if artist_row is None:
                artist_row = _new_row(artist_schema)
                artist_rows.append(artist_row)
            old_listeners = finite_number(field(artist_row, artist_schema, "monthly_listeners")) or 0
            listeners = finite_number(cached_artist.get("monthly_listeners"))
            listener_change = finite_number(cached_artist.get("monthly_listeners_change"))
            if listener_change is None and listeners is not None and old_listeners:
                listener_change = int(listeners) - int(old_listeners)
            artist_values = {
                "spotify_id": artist_spotify,
                "name": str(cached_artist.get("name") or structured.get("name") or ""),
                "monthly_listeners": int(listeners) if listeners is not None else int(old_listeners),
                "delta": int(listener_change) if listener_change is not None else None,
                "source_date": cached_artist.get("monthly_listeners_date"),
                "observed_at": cached_artist.get("stats_fetched_at") or now,
                "qualifies": 1 if listeners is not None and 1_000 <= listeners <= 5_000_000 else 0,
                "fal_in": field(artist_row, artist_schema, "fal_in") or 0,
                "fal_out": field(artist_row, artist_schema, "fal_out") or 0,
                "soundcharts_uuid": artist_uuid,
                "spotify_followers": cached_artist.get("spotify_followers"),
                "contact_url": cached_artist.get("contact_url"),
                "contact_platform": cached_artist.get("contact_platform"),
                "source_tier": "instrumental_editorial",
            }
            for name, value in artist_values.items():
                set_field(artist_row, artist_schema, name, value)
            artists_by_uuid[artist_uuid] = artist_row
            if artist_spotify:
                artists_by_spotify[artist_spotify] = artist_row

    if measured == 0:
        raise InstrumentalPoolError("No target Soundcharts track returned a usable Spotify stream history")

    performance["source"] = "soundcharts_daily"
    performance["generated_at"] = now
    cache["version"] = CACHE_VERSION
    cache["updated_at"] = now

    editorial_all = editorial_candidates(soundcharts, include_review=True)
    verified_total = sum(item["classification_status"] == "verified" for item in editorial_all)
    review_total = len(editorial_all) - verified_total
    discography = soundcharts.get("coverage", {}).get("discography", {}) if isinstance(soundcharts.get("coverage"), dict) else {}
    summary = {
        "status": "success",
        "finished_at": now,
        "catalog_total": int(discography.get("total") or 0) if isinstance(discography, dict) else 0,
        "target_editorial_total": len(editorial_all),
        "target_verified_total": verified_total,
        "target_needs_listen_total": review_total,
        "selected": len(candidates),
        "measured": measured,
        "daily_delta_ready": daily_ready,
        "verified_measured": verified_measured,
        "needs_listen_measured": review_measured,
        "playlist_discovery_selected": playlist_selected,
        "playlist_discovery_measured": playlist_measured,
        "inserted_tracks": inserted,
        "updated_tracks": updated,
        "rights": rights_counts,
        "latest_source_date": latest_source_date,
        "requests": budget.used,
        "quota_remaining": getattr(client, "quota_remaining", None),
        "failures": {
            "audience": audience_failures,
            "metadata": metadata_failures,
            "artist_identifiers": identifier_failures,
            "artist_stats": stats_failures,
        },
        "cadence": {
            "target_pool": "daily",
            "history_window_days": period_days,
            "no_extrapolation": True,
        },
    }
    soundcharts["instrumental_pool"] = summary
    freshness = soundcharts.setdefault("freshness", {})
    if isinstance(freshness, dict):
        freshness["instrumental_pool_at"] = now
    performance.setdefault("freshness", {})["instrumental_pool_at"] = now
    performance["instrumental_pool"] = summary
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument("--cache", type=Path, default=Path("soundcharts-instrumental-cache.json"))
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--max-requests", type=int, default=80_000)
    parser.add_argument("--history-days", type=int, default=90)
    parser.add_argument("--metadata-refresh-days", type=int, default=30)
    parser.add_argument("--artist-refresh-days", type=int, default=7)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--verified-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    soundcharts = read_js_payload(args.soundcharts, SOUNDCHARTS_PREFIX)
    performance = read_js_payload(args.performance, PERFORMANCE_PREFIX)
    cache = read_cache(args.cache)
    client = SoundchartsClient(
        __import__("os").environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        __import__("os").environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        __import__("os").environ.get("SOUNDCHARTS_TEAM_ID", ""),
        request_limit=args.max_requests,
    )
    client.authenticate()
    client.require_quota_reserve()
    summary = expand_instrumental_pool(
        soundcharts,
        performance,
        cache,
        client,
        workers=args.workers,
        max_requests=args.max_requests,
        history_days=args.history_days,
        metadata_refresh_days=args.metadata_refresh_days,
        artist_refresh_days=args.artist_refresh_days,
        limit=args.limit,
        include_review=not args.verified_only,
    )
    write_js_payload(args.soundcharts, soundcharts, SOUNDCHARTS_PREFIX)
    write_js_payload(args.performance, performance, PERFORMANCE_PREFIX)
    write_cache(args.cache, cache)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
