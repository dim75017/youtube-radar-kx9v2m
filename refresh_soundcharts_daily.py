#!/usr/bin/env python3
"""Refresh the licensed Soundcharts snapshots used by Spotify Radar.

The job runs server-side in GitHub Actions. Credentials never enter the public
artifacts. A run is considered successful only when at least one requested
metric is actually parsed; HTTP 200 responses containing no Spotify metric do
not advance freshness timestamps.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from zoneinfo import ZoneInfo

from spotify_performance_store import (
    DEFAULT_TRACK_SHARD_COUNT,
    MAX_TRACK_SHARD_BYTES,
    PERFORMANCE_PREFIX,
    PerformanceStoreError,
    read_performance_payload as read_sharded_performance_payload,
    validate_performance_store,
    write_performance_payload,
)
from spotify_counter_integrity import sanitize_counter_history


API_BASE = "https://customer.api.soundcharts.com"
TOKEN_URL = "https://account.soundcharts.com/oauth/token"
SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
BROWSE_CATALOGUE_PREFIX = "window.SPOTIFY_BROWSE_CATALOGUE="
PLAYLISTS_PREFIX = "window.SPOTIFY_PLAYLISTS="
AUTH_PROBE = "/api/v2/referential/platforms/streaming"
# Preserve 20% of the Developer plan's 500k monthly allowance for retries,
# manual A&R checks, and recovery. A 500k reserve would block every request on
# the very plan this collector is designed to use.
MIN_SERVER_QUOTA_RESERVE = 100_000
TRACK_ROTATION_BUCKETS = 7
RECENT_RELEASE_DAYS = 90
TRACK_MAINTENANCE_POLICY_VERSION = 4
TRACK_PUBLIC_STREAM_FLOOR = 100_000
TRACK_PROMOTION_WATCH_FLOOR = 75_000
ARTIST_LISTENING_WINDOW_DAYS = 90
ESTIMATED_NEW_TRACK_ENTRY_BYTES = 4_096
ESTIMATED_DAILY_POINT_BYTES = 128
PARIS_TIMEZONE = ZoneInfo("Europe/Paris")


class SoundchartsError(RuntimeError):
    """A safe, non-secret-bearing collector failure."""


class SoundchartsHttpError(SoundchartsError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(f"Soundcharts HTTP error ({status})")


class SoundchartsDataUnavailableError(SoundchartsHttpError):
    """The requested platform resource is not available from Soundcharts."""


class SoundchartsQuotaReserveError(SoundchartsError):
    """Raised before a request could consume the protected server reserve."""


class SoundchartsRequestLimitError(SoundchartsError):
    """Raised before a request could exceed this collector's attempt cap."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def paris_today() -> dt.date:
    """Return the dashboard business day, including the UTC/Paris boundary."""

    return dt.datetime.now(PARIS_TIMEZONE).date()


def clean_credential(value: str) -> str:
    cleaned = value.strip().strip("\ufeff\u200b")
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        cleaned = cleaned[1:-1].strip()
    return cleaned


def read_js_payload(path: Path, prefix: str = SOUNDCHARTS_PREFIX) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise SoundchartsError(f"{path} is not a {prefix[:-1]} export")
    try:
        payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise SoundchartsError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise SoundchartsError(f"{path} does not contain an object payload")
    return payload


def write_js_payload(path: Path, payload: dict[str, Any], prefix: str = SOUNDCHARTS_PREFIX) -> None:
    serialized = prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(serialized, encoding="utf-8")
        temporary.replace(path)
    except OSError as exc:
        if temporary.exists():
            temporary.unlink()
        raise SoundchartsError(f"Could not atomically persist {path}") from exc


def read_performance_payload(path: Path) -> dict[str, Any]:
    try:
        return read_sharded_performance_payload(path)
    except PerformanceStoreError as exc:
        raise SoundchartsError(str(exc)) from exc


def prune_track_histories_to_hot_window(
    performance: dict[str, Any],
    keep_days: int = 95,
) -> dict[str, list[list[Any]]]:
    """Keep the analytics hot window and return every older point for archival."""

    tracks = performance.get("tracks")
    if not isinstance(tracks, dict):
        raise SoundchartsError("Performance tracks must be an object")
    retained_days = max(61, keep_days)
    archived: dict[str, list[list[Any]]] = {}
    for spotify_id, entry in tracks.items():
        if not isinstance(entry, dict):
            continue
        history = normalize_history(entry.get("history"))
        if not history:
            continue
        latest = dt.date.fromisoformat(history[-1][0])
        cutoff = latest - dt.timedelta(days=retained_days - 1)
        old_points = [point for point in history if dt.date.fromisoformat(point[0]) < cutoff]
        if not old_points:
            continue
        kept_points = [point for point in history if dt.date.fromisoformat(point[0]) >= cutoff]
        entry["history"] = kept_points
        archived[str(spotify_id)] = old_points
    return archived


def write_track_history_archive(history_dir: Path, archived: Mapping[str, list[list[Any]]]) -> dict[str, Any]:
    """Merge pruned points into monthly gzip archives before the hot file is written."""

    by_month: dict[str, dict[str, list[list[Any]]]] = {}
    for spotify_id, points in archived.items():
        for day, value in normalize_history(points):
            by_month.setdefault(day[:7], {}).setdefault(str(spotify_id), []).append([day, value])
    if not by_month:
        return {"status": "not_needed", "points": 0, "tracks": 0, "files": []}

    archive_dir = history_dir / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    point_count = 0
    track_ids: set[str] = set()
    for month, incoming_tracks in sorted(by_month.items()):
        path = archive_dir / f"tracks-{month}.json.gz"
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if (
                    not isinstance(loaded, dict)
                    or loaded.get("month") != month
                    or not isinstance(loaded.get("tracks"), dict)
                ):
                    raise SoundchartsError(f"{path} contains an invalid track history archive")
                existing = loaded
            except (OSError, json.JSONDecodeError) as exc:
                raise SoundchartsError(f"{path} contains an unreadable track history archive") from exc
        tracks = existing.get("tracks") if isinstance(existing.get("tracks"), dict) else {}
        for spotify_id, points in incoming_tracks.items():
            merged = {day: value for day, value in normalize_history(tracks.get(spotify_id))}
            merged.update({day: value for day, value in normalize_history(points)})
            tracks[spotify_id] = [[day, merged[day]] for day in sorted(merged)]
            point_count += len(points)
            track_ids.add(spotify_id)
        archive_payload = {
            "version": 1,
            "source": "soundcharts_track_history_archive",
            "month": month,
            "tracks": tracks,
        }
        temporary = path.with_name(path.name + ".tmp")
        try:
            with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=9) as handle:
                json.dump(archive_payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
            temporary.replace(path)
        except OSError as exc:
            if temporary.exists():
                temporary.unlink()
            raise SoundchartsError(f"Could not persist {path} before pruning the hot history") from exc
        written.append(str(path))
    return {
        "status": "archived",
        "points": point_count,
        "tracks": len(track_ids),
        "files": written,
    }


def performance_storage_preflight(
    performance: Mapping[str, Any],
    payload: Mapping[str, Any],
    path: Path,
) -> dict[str, Any]:
    """Size the sharded write before paid track calls without a blob ceiling."""

    serialized = PERFORMANCE_PREFIX + json.dumps(performance, ensure_ascii=False, separators=(",", ":")) + ";\n"
    hot_bytes = len(serialized.encode("utf-8"))
    tracks = performance.get("tracks") if isinstance(performance.get("tracks"), Mapping) else {}
    known_ids = {str(spotify_id) for spotify_id in tracks}
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), Mapping) else {}
    schema = schemas.get("tracks") if isinstance(schemas.get("tracks"), list) else []
    rows = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    new_track_entries = 0
    for row in rows:
        if not isinstance(row, list) or not field(row, schema, "soundcharts_uuid"):
            continue
        uuid = str(field(row, schema, "soundcharts_uuid") or "").strip()
        spotify_id = str(field(row, schema, "spotify_id") or "").strip()
        storage_key = spotify_id or f"soundcharts:{uuid}"
        if storage_key not in known_ids:
            new_track_entries += 1
    projected_bytes = (
        hot_bytes
        + len(tracks) * ESTIMATED_DAILY_POINT_BYTES
        + new_track_entries * ESTIMATED_NEW_TRACK_ENTRY_BYTES
    )
    projected_shards = max(
        DEFAULT_TRACK_SHARD_COUNT,
        (projected_bytes + MAX_TRACK_SHARD_BYTES - 1) // MAX_TRACK_SHARD_BYTES,
    )
    summary = {
        "status": "sharded_ready",
        "current_file_bytes": path.stat().st_size if path.exists() else 0,
        "full_serialized_bytes": hot_bytes,
        "projected_full_bytes": projected_bytes,
        "projected_shards": projected_shards,
        "maximum_shard_bytes": MAX_TRACK_SHARD_BYTES,
        "tracks": len(tracks),
        "new_track_entries": new_track_entries,
    }
    return summary


def _retry_delay(attempt: int, headers: Mapping[str, str] | None = None) -> float:
    if headers:
        raw = headers.get("Retry-After") or headers.get("retry-after")
        try:
            return min(30.0, max(0.5, float(raw)))
        except (TypeError, ValueError):
            pass
    return min(12.0, 1.5 * (attempt + 1))


def request_json(
    url: str,
    headers: Mapping[str, str],
    *,
    data: bytes | None = None,
    retries: int = 5,
    timeout: int = 40,
    before_attempt: Callable[[], None] | None = None,
) -> tuple[Any, Mapping[str, str]]:
    """Return decoded JSON plus response headers, with bounded retry handling."""

    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        if before_attempt is not None:
            before_attempt()
        request = urllib.request.Request(
            url,
            data=data,
            headers=dict(headers),
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                return json.loads(body), dict(response.headers)
        except urllib.error.HTTPError as exc:
            if exc.code in {400, 404, 410, 422}:
                raise SoundchartsDataUnavailableError(exc.code) from exc
            if exc.code in {401, 403}:
                raise SoundchartsHttpError(exc.code) from exc
            last_error = exc
            if exc.code != 429 and exc.code < 500:
                break
            if attempt + 1 < retries:
                time.sleep(_retry_delay(attempt, dict(exc.headers)))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(_retry_delay(attempt))
    if isinstance(last_error, urllib.error.HTTPError):
        raise SoundchartsHttpError(last_error.code) from last_error
    raise SoundchartsError("Soundcharts request failed after retries") from last_error


def access_token(client_id: str, client_secret: str, team_id: str = "") -> str:
    """Compatibility fallback for accounts still using the OAuth gateway."""

    client_id = clean_credential(client_id)
    client_secret = clean_credential(client_secret)
    team_id = clean_credential(team_id)
    if not client_id or not client_secret:
        raise SoundchartsError("SOUNDCHARTS_CLIENT_ID or SOUNDCHARTS_CLIENT_SECRET is missing")

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    base_form = {"grant_type": "client_credentials"}
    with_team = dict(base_form, team_id=team_id) if team_id else base_form
    attempts: list[tuple[dict[str, str], dict[str, str]]] = [
        ({"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"}, with_team),
    ]
    if team_id:
        attempts.append(
            ({"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"}, base_form)
        )
    attempts.append(
        (
            {"Content-Type": "application/x-www-form-urlencoded"},
            dict(with_team, client_id=client_id, client_secret=client_secret),
        )
    )

    last_error: SoundchartsHttpError | None = None
    for headers, form in attempts:
        try:
            token, _ = request_json(
                TOKEN_URL,
                headers,
                data=urllib.parse.urlencode(form).encode("utf-8"),
                retries=1,
            )
        except SoundchartsHttpError as exc:
            last_error = exc
            continue
        value = token.get("access_token") if isinstance(token, dict) else None
        if value:
            return str(value)
    if last_error:
        raise SoundchartsError("Soundcharts rejected the configured credentials") from last_error
    raise SoundchartsError("Soundcharts did not return an access token")


class SoundchartsClient:
    """Authenticated Soundcharts client with official API-key auth and OAuth fallback."""

    def __init__(
        self,
        app_id: str,
        api_key: str,
        team_id: str = "",
        quota_reserve: int = MIN_SERVER_QUOTA_RESERVE,
        request_limit: int | None = None,
    ):
        self.app_id = clean_credential(app_id)
        self.api_key = clean_credential(api_key)
        self.team_id = clean_credential(team_id)
        if not self.app_id or not self.api_key:
            raise SoundchartsError("SOUNDCHARTS_CLIENT_ID or SOUNDCHARTS_CLIENT_SECRET is missing")
        self.headers: dict[str, str] = {}
        self.auth_mode = "uninitialized"
        self.quota_remaining: int | None = None
        self.quota_reserve = max(0, quota_reserve)
        self.request_limit = None if request_limit is None else max(0, request_limit)
        self.requests_claimed = 0
        self._quota_lock = threading.Lock()
        self._auth_lock = threading.RLock()
        self._auth_generation = 0

    def _record_headers(self, headers: Mapping[str, str], *, reset: bool = False) -> None:
        raw = headers.get("x-quota-remaining") or headers.get("X-Quota-Remaining")
        try:
            value = int(raw) if raw is not None else None
        except (TypeError, ValueError):
            value = None
        if value is not None:
            with self._quota_lock:
                if reset or self.quota_remaining is None:
                    self.quota_remaining = value
                else:
                    # Concurrent responses can arrive out of order. Keep the
                    # lowest observed/claimed value so the guard stays fail-safe.
                    self.quota_remaining = min(self.quota_remaining, value)

    def require_quota_reserve(self) -> None:
        with self._quota_lock:
            remaining = self.quota_remaining
        if remaining is None:
            raise SoundchartsQuotaReserveError(
                "Soundcharts did not report x-quota-remaining; collection is blocked"
            )
        if remaining <= self.quota_reserve:
            raise SoundchartsQuotaReserveError(
                f"Soundcharts quota reserve reached ({remaining} remaining; {self.quota_reserve} protected)"
            )

    def available_request_budget(self, requested: int) -> int:
        """Return the safe data-call budget before any collection request starts."""

        with self._quota_lock:
            remaining = self.quota_remaining
            claimed = self.requests_claimed
            request_limit = self.request_limit
        if remaining is None:
            raise SoundchartsQuotaReserveError(
                "Soundcharts did not report x-quota-remaining; collection is blocked"
            )
        server_budget = max(0, remaining - self.quota_reserve)
        local_budget = server_budget
        if request_limit is not None:
            local_budget = max(0, request_limit - claimed)
        return max(0, min(max(0, requested), server_budget, local_budget))

    def _claim_quota_request(self) -> None:
        """Reserve one server call before every HTTP attempt, including retries."""

        with self._quota_lock:
            if self.request_limit is not None and self.requests_claimed >= self.request_limit:
                raise SoundchartsRequestLimitError(
                    f"Soundcharts collector request cap reached ({self.request_limit})"
                )
            remaining = self.quota_remaining
            if remaining is None:
                raise SoundchartsQuotaReserveError(
                    "Soundcharts did not report x-quota-remaining; collection is blocked"
                )
            if remaining <= self.quota_reserve:
                raise SoundchartsQuotaReserveError(
                    f"Soundcharts quota reserve reached ({remaining} remaining; {self.quota_reserve} protected)"
                )
            self.requests_claimed += 1
            self.quota_remaining = remaining - 1

    def _authenticate_locked(self) -> None:
        """Replace authentication headers while ``_auth_lock`` is held."""

        direct = {"x-app-id": self.app_id, "x-api-key": self.api_key, "Accept": "application/json"}
        try:
            _, response_headers = request_json(API_BASE + AUTH_PROBE, direct, retries=1)
            self.headers = direct
            self.auth_mode = "api_headers"
            self._record_headers(response_headers, reset=True)
            self._auth_generation += 1
            return
        except SoundchartsHttpError:
            pass

        token = access_token(self.app_id, self.api_key, self.team_id)
        bearer = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        _, response_headers = request_json(API_BASE + AUTH_PROBE, bearer, retries=1)
        self.headers = bearer
        self.auth_mode = "oauth_bearer"
        self._record_headers(response_headers, reset=True)
        self._auth_generation += 1

    def authenticate(self) -> None:
        with self._auth_lock:
            self._authenticate_locked()

    def _authentication_snapshot(self) -> tuple[int, dict[str, str]]:
        with self._auth_lock:
            if not self.headers:
                raise SoundchartsError("Soundcharts client is not authenticated")
            return self._auth_generation, dict(self.headers)

    def _renew_after_unauthorized(self, observed_generation: int) -> dict[str, str]:
        """Renew once per expired auth generation and return current headers."""

        with self._auth_lock:
            if self._auth_generation == observed_generation:
                self._authenticate_locked()
            if not self.headers:
                raise SoundchartsError("Soundcharts client authentication renewal failed")
            return dict(self.headers)

    def get(self, path: str) -> Any:
        generation, headers = self._authentication_snapshot()
        try:
            payload, response_headers = request_json(
                API_BASE + path,
                headers,
                before_attempt=self._claim_quota_request,
            )
        except SoundchartsHttpError as exc:
            if exc.status != 401:
                raise
            renewed_headers = self._renew_after_unauthorized(generation)
            # This is a new data request, so it goes through the same quota and
            # per-run request-limit claim as every other HTTP attempt. A second
            # 401 is deliberately not retried again.
            payload, response_headers = request_json(
                API_BASE + path,
                renewed_headers,
                before_attempt=self._claim_quota_request,
            )
        self._record_headers(response_headers)
        return payload


def index_of(schema: list[str], name: str) -> int | None:
    try:
        return schema.index(name)
    except ValueError:
        return None


def field(row: list[Any], schema: list[str], name: str) -> Any:
    index = index_of(schema, name)
    return row[index] if index is not None and index < len(row) else None


def set_field(row: list[Any], schema: list[str], name: str, value: Any) -> None:
    index = index_of(schema, name)
    if index is None:
        raise SoundchartsError(f"Schema field {name} was not initialized")
    while len(row) <= index:
        row.append(None)
    row[index] = value


def ensure_schema_fields(payload: dict[str, Any], group: str, names: Iterable[str]) -> tuple[list[str], list[list[Any]]]:
    schemas = payload.setdefault("schemas", {})
    schema = schemas.setdefault(group, [])
    rows = payload.setdefault(group, [])
    if not isinstance(schema, list) or not isinstance(rows, list):
        raise SoundchartsError(f"Invalid {group} export structure")
    for name in names:
        if name in schema:
            continue
        schema.append(name)
        for row in rows:
            if isinstance(row, list):
                row.append(None)
    return schema, rows


def walk_dicts(value: Any, path: str = "$") -> Iterable[tuple[str, dict[str, Any]]]:
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from walk_dicts(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_dicts(child, f"{path}[{index}]")


def normalize_day(value: Any, fallback: str | None = None) -> str | None:
    day = str(value or "")[:10]
    if len(day) == 10 and day[4] == "-" and day[7] == "-":
        try:
            dt.date.fromisoformat(day)
            return day
        except ValueError:
            pass
    return fallback


def extract_artist_spotify_metric(response: Any) -> dict[str, Any] | None:
    """Parse the Spotify value from the CurrentStats streaming array."""

    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for path, item in walk_dicts(response):
        platform = str(item.get("platform") or item.get("platformCode") or item.get("identifier") or "").lower()
        value = item.get("value")
        if platform != "spotify" or not isinstance(value, (int, float)):
            continue
        lower_path = path.lower()
        score = 100 if "streaming" in lower_path else 0
        score -= 50 if any(token in lower_path for token in ("popularity", "score", "retention")) else 0
        date = normalize_day(item.get("date"), utc_today().isoformat())
        candidates.append(
            (
                score,
                date or "",
                {
                    "value": int(value),
                    "date": date,
                    "evolution": item.get("evolution"),
                    "percent_evolution": item.get("percentEvolution"),
                },
            )
        )
    if not candidates:
        return None
    candidates.sort(key=lambda candidate: (candidate[0], candidate[1]))
    return candidates[-1][2]


def extract_artist_spotify_listening_points(response: Any) -> list[list[Any]]:
    """Return dated Spotify monthly-listener observations from GlobalAudiencePlotCollection."""

    daily: dict[str, int] = {}
    for _, item in walk_dicts(response):
        day = normalize_day(item.get("date"))
        value = item.get("value")
        if (
            not day
            or isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value < 0
        ):
            continue
        daily[day] = int(value)
    return [[day, daily[day]] for day in sorted(daily)]


def artist_spotify_listening_path(
    uuid: str,
    history_days: int = ARTIST_LISTENING_WINDOW_DAYS,
    *,
    today: dt.date | None = None,
) -> str:
    """Build one bounded standard-plan request for Spotify monthly listeners."""

    end_day = today or utc_today()
    period_days = min(90, max(2, int(history_days)))
    start_day = end_day - dt.timedelta(days=period_days - 1)
    query = urllib.parse.urlencode(
        {
            "startDate": start_day.isoformat(),
            "endDate": end_day.isoformat(),
            "limit": 100,
            "sort": "asc",
        }
    )
    return (
        f"/api/v2/artist/{urllib.parse.quote(str(uuid), safe='')}"
        f"/streaming/spotify/listening?{query}"
    )


def _identifier_matches(identifier: str, spotify_id: str) -> bool:
    if not spotify_id:
        return False
    identifier = identifier.strip()
    return identifier == spotify_id or any(
        identifier.endswith(separator + spotify_id) for separator in ("/", ":", "=")
    )


def extract_song_audience_points(
    response: Any,
    spotify_id: str = "",
    *,
    require_identifier_match: bool = False,
) -> list[list[Any]]:
    """Return `[YYYY-MM-DD, cumulative Spotify streams]` points from SongPlot."""

    daily: dict[str, tuple[int, bool]] = {}
    for _, item in walk_dicts(response):
        day = normalize_day(item.get("date"))
        plots = item.get("plots")
        if not day or not isinstance(plots, list):
            continue
        numeric: list[tuple[str, int]] = []
        for plot in plots:
            if not isinstance(plot, dict) or not isinstance(plot.get("value"), (int, float)):
                continue
            numeric.append((str(plot.get("identifier") or ""), int(plot["value"])))
        if not numeric:
            continue
        exact = [(identifier, value) for identifier, value in numeric if _identifier_matches(identifier, spotify_id)]
        chosen: tuple[str, int] | None = exact[-1] if exact else None
        identifier_required = bool(spotify_id) or require_identifier_match
        if chosen is None and not identifier_required and len(numeric) == 1:
            chosen = numeric[0]
        if chosen is None and not identifier_required:
            spotify_named = [(identifier, value) for identifier, value in numeric if identifier.lower() == "spotify"]
            chosen = spotify_named[-1] if spotify_named else None
        if chosen is None:
            continue
        is_exact = bool(exact)
        previous = daily.get(day)
        if previous is None or (is_exact and not previous[1]):
            daily[day] = (chosen[1], is_exact)
    return [[day, daily[day][0]] for day in sorted(daily)]


def first_numeric_named(value: Any, names: set[str]) -> int | None:
    for _, item in walk_dicts(value):
        for name in names:
            metric = item.get(name)
            if isinstance(metric, (int, float)):
                return int(metric)
    return None


def first_text_named(value: Any, names: set[str]) -> str:
    """Return the first non-empty text field found in a Soundcharts response."""

    for _, item in walk_dicts(value):
        for name in names:
            candidate = item.get(name)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return ""


def spotify_metric(value: Any, names: set[str]) -> int | None:
    """Find a numeric metric specifically attached to Spotify."""

    for _, item in walk_dicts(value):
        platform = str(item.get("platform") or item.get("platformCode") or "").lower()
        if platform != "spotify":
            continue
        for name in names:
            metric = item.get(name)
            if isinstance(metric, (int, float)):
                return int(metric)
    spotify = value.get("spotify") if isinstance(value, dict) else None
    if isinstance(spotify, dict):
        for name in names:
            metric = spotify.get(name)
            if isinstance(metric, (int, float)):
                return int(metric)
    return None


def normalize_history(raw: Any) -> list[list[Any]]:
    daily: dict[str, int] = {}
    if not isinstance(raw, list):
        return []
    for point in raw:
        if isinstance(point, list) and len(point) >= 2:
            day, value = point[0], point[1]
        elif isinstance(point, dict):
            day, value = point.get("date"), point.get("value")
        else:
            continue
        normalized = normalize_day(day)
        if normalized and isinstance(value, (int, float)):
            daily[normalized] = int(value)
    return [[day, daily[day]] for day in sorted(daily)]


def merge_history(existing: Any, incoming: Any, keep_days: int = 400) -> list[list[Any]]:
    daily = {day: value for day, value in normalize_history(existing)}
    daily.update({day: value for day, value in normalize_history(incoming)})
    if not daily:
        return []
    latest = dt.date.fromisoformat(max(daily))
    cutoff = latest - dt.timedelta(days=max(1, keep_days))
    return [[day, daily[day]] for day in sorted(daily) if dt.date.fromisoformat(day) >= cutoff]


def previous_day(day: str) -> str:
    return (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()


@dataclass
class Outcome:
    mode: str
    items: list[dict[str, Any]] = dataclass_field(default_factory=list)
    requests: int = 0
    failures: int = 0
    unavailable: int = 0
    usable: int = 0
    follower_usable: int | None = None
    available: int = 0
    selected: int = 0
    policy: dict[str, Any] = dataclass_field(default_factory=dict)
    failure_diagnostics: list[dict[str, Any]] = dataclass_field(default_factory=list)
    unavailable_diagnostics: list[dict[str, Any]] = dataclass_field(default_factory=list)

    def coverage(self) -> dict[str, int]:
        return {
            "expected": self.available,
            "scanned": self.selected,
            "usable": self.usable,
            "missing": max(0, self.available - self.usable),
            "not_scanned": max(0, self.available - self.selected),
            "scanned_without_usable_data": max(0, self.selected - self.usable),
        }

    def summary(self) -> dict[str, Any]:
        summary = {
            "requests": self.requests,
            "failures": self.failures,
            "unavailable": self.unavailable,
            "usable": self.usable,
            "available": self.available,
            "selected": self.selected,
            "coverage": self.coverage(),
            "failure_diagnostics": self.failure_diagnostics,
            "unavailable_diagnostics": self.unavailable_diagnostics,
        }
        if self.policy:
            summary["policy"] = self.policy
        if self.follower_usable is not None:
            summary["follower_usable"] = self.follower_usable
        return summary


def safe_failure_diagnostic(exc: SoundchartsError) -> dict[str, Any]:
    """Return an aggregateable error signature without URLs or credentials."""

    if isinstance(exc, SoundchartsHttpError):
        status: int | str = exc.status
    elif isinstance(exc, SoundchartsQuotaReserveError):
        status = "quota_reserve"
    elif isinstance(exc, SoundchartsRequestLimitError):
        status = "request_limit"
    else:
        status = "request_failed"
    return {"type": type(exc).__name__, "status": status}


def parallel_collect(
    client: SoundchartsClient,
    tasks: Iterable[dict[str, Any]],
    *,
    workers: int,
    max_requests: int,
) -> tuple[
    list[tuple[dict[str, Any], Any]],
    int,
    int,
    int,
    int,
    int,
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    all_tasks = list(tasks)
    selected = all_tasks[: max(0, max_requests)]
    results: list[tuple[dict[str, Any], Any]] = []
    failures = 0
    unavailable = 0
    diagnostic_counts: dict[tuple[str, str], dict[str, Any]] = {}
    unavailable_counts: dict[tuple[str, str], dict[str, Any]] = {}

    def collect(task: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        return task, client.get(str(task["path"]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(collect, task) for task in selected]
        stop_error: SoundchartsError | None = None
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except SoundchartsDataUnavailableError as exc:
                unavailable += 1
                diagnostic = safe_failure_diagnostic(exc)
                key = (str(diagnostic["type"]), str(diagnostic["status"]))
                unavailable_counts.setdefault(key, dict(diagnostic, count=0))["count"] += 1
            except (SoundchartsQuotaReserveError, SoundchartsRequestLimitError) as exc:
                stop_error = exc
                failures += 1
                diagnostic = safe_failure_diagnostic(exc)
                key = (str(diagnostic["type"]), str(diagnostic["status"]))
                diagnostic_counts.setdefault(key, dict(diagnostic, count=0))["count"] += 1
            except SoundchartsError as exc:
                failures += 1
                diagnostic = safe_failure_diagnostic(exc)
                key = (str(diagnostic["type"]), str(diagnostic["status"]))
                diagnostic_counts.setdefault(key, dict(diagnostic, count=0))["count"] += 1
    diagnostics = sorted(diagnostic_counts.values(), key=lambda item: (str(item["type"]), str(item["status"])))
    unavailable_diagnostics = sorted(
        unavailable_counts.values(), key=lambda item: (str(item["type"]), str(item["status"]))
    )
    if stop_error is not None:
        print(json.dumps({"collection_failure": diagnostics}, ensure_ascii=False))
        raise stop_error
    return (
        results,
        len(selected),
        failures,
        unavailable,
        len(all_tasks),
        len(selected),
        diagnostics,
        unavailable_diagnostics,
    )


def parse_source_date(value: Any) -> dt.date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return dt.date.fromisoformat(text[:10])
    except ValueError:
        return None


def stable_rotation_bucket(value: str, buckets: int = TRACK_ROTATION_BUCKETS) -> int:
    bucket_count = max(1, buckets)
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % bucket_count


def read_priority_artist_references(path: Path | None) -> tuple[set[str], set[str]]:
    """Read the server-known Selection cohort without inferring browser-only CRM state."""

    if path is None or not path.exists():
        return set(), set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SoundchartsError(f"{path} contains invalid priority artist data") from exc
    rows = payload.get("artists") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise SoundchartsError(f"{path} does not contain an artists list")
    spotify_ids: set[str] = set()
    soundcharts_uuids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        spotify_id = str(row.get("spotify_id") or "").strip()
        soundcharts_uuid = str(row.get("soundcharts_uuid") or "").strip()
        if spotify_id:
            spotify_ids.add(spotify_id)
        if soundcharts_uuid:
            soundcharts_uuids.add(soundcharts_uuid)
    return spotify_ids, soundcharts_uuids


def _artist_references(value: Any) -> tuple[set[str], set[str]]:
    spotify_ids: set[str] = set()
    soundcharts_uuids: set[str] = set()
    if not isinstance(value, list):
        return spotify_ids, soundcharts_uuids
    for artist in value:
        if not isinstance(artist, dict):
            continue
        spotify_id = str(artist.get("spotify_id") or "").strip()
        soundcharts_uuid = str(artist.get("soundcharts_uuid") or "").strip()
        if spotify_id:
            spotify_ids.add(spotify_id)
        if soundcharts_uuid:
            soundcharts_uuids.add(soundcharts_uuid)
    return spotify_ids, soundcharts_uuids


def build_track_maintenance_metadata(
    payload: Mapping[str, Any],
    public_catalogue: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Index only source-backed fields that are useful to the maintenance scheduler."""

    metadata: dict[str, dict[str, Any]] = {}

    def merge_row(
        row: list[Any],
        schema: list[str],
        *,
        strict: bool = False,
        public: bool = False,
        opportunity: bool = False,
    ) -> None:
        spotify_id = str(field(row, schema, "spotify_id") or "").strip()
        if not spotify_id:
            return
        target = metadata.setdefault(
            spotify_id,
            {
                "artist_spotify_ids": set(),
                "artist_soundcharts_uuids": set(),
            },
        )
        release_date = parse_source_date(field(row, schema, "release_date"))
        if release_date is not None:
            target["release_date"] = release_date
        artist_ids, artist_uuids = _artist_references(field(row, schema, "artists"))
        artist_spotify_id = str(field(row, schema, "artist_spotify_id") or "").strip()
        artist_soundcharts_uuid = str(field(row, schema, "artist_soundcharts_uuid") or "").strip()
        if artist_spotify_id:
            artist_ids.add(artist_spotify_id)
        if artist_soundcharts_uuid:
            artist_uuids.add(artist_soundcharts_uuid)
        target["artist_spotify_ids"].update(artist_ids)
        target["artist_soundcharts_uuids"].update(artist_uuids)
        target["strict"] = bool(target.get("strict") or strict)
        target["public"] = bool(target.get("public") or public)
        target["opportunity"] = bool(target.get("opportunity") or opportunity)

    discovery = payload.get("discovery_catalogue")
    if isinstance(discovery, Mapping):
        schema = discovery.get("track_schema")
        rows = discovery.get("tracks")
        if isinstance(schema, list) and isinstance(rows, list):
            for row in rows:
                if isinstance(row, list):
                    merge_row(row, schema)

    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), Mapping) else {}
    track_schema = schemas.get("tracks") if isinstance(schemas.get("tracks"), list) else []
    tracks = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    for row in tracks:
        if isinstance(row, list):
            merge_row(row, track_schema, strict=True)

    opportunity_schema = schemas.get("opportunities") if isinstance(schemas.get("opportunities"), list) else []
    opportunities = payload.get("opportunities") if isinstance(payload.get("opportunities"), list) else []
    for row in opportunities:
        if isinstance(row, list):
            merge_row(row, opportunity_schema, opportunity=True)

    # The browse catalogue is the exact cohort a user can open in the public
    # dashboard.  It is intentionally a scheduling input only: reading it here
    # cannot promote or rewrite any Soundcharts row.  Without this join, trusted
    # internal tracks that already have an exact Soundcharts UUID in the
    # performance store fall back to the weekly rotation and their charts can
    # remain stale even while the collector reports a successful daily pass.
    public_discovery = (
        public_catalogue.get("discovery_catalogue")
        if isinstance(public_catalogue, Mapping)
        else None
    )
    if isinstance(public_discovery, Mapping):
        public_schema = public_discovery.get("track_schema")
        public_rows = public_discovery.get("tracks")
        if isinstance(public_schema, list) and isinstance(public_rows, list):
            for row in public_rows:
                if isinstance(row, list):
                    merge_row(row, public_schema, public=True)
    return metadata


def track_history_signals(entry: Mapping[str, Any], today: dt.date) -> dict[str, Any]:
    history = normalize_history(entry.get("history"))
    if not history:
        return {
            "true_points": 0,
            "latest_total": None,
            "velocity_7d": None,
            "acceleration_7d": None,
            "anomaly_or_acceleration": False,
            "observed_at": str(entry.get("maintenance_last_attempt_at") or entry.get("observed_at") or ""),
        }
    by_day = {dt.date.fromisoformat(day): int(value) for day, value in history}
    latest_day = max(by_day)
    latest_total = by_day[latest_day]

    def delta(days: int) -> int | None:
        prior = by_day.get(latest_day - dt.timedelta(days=days))
        return latest_total - prior if prior is not None else None

    velocity_7d = delta(7)
    previous_7d = None
    previous_start = by_day.get(latest_day - dt.timedelta(days=14))
    previous_end = by_day.get(latest_day - dt.timedelta(days=7))
    if previous_start is not None and previous_end is not None:
        previous_7d = previous_end - previous_start
    acceleration_7d = velocity_7d - previous_7d if velocity_7d is not None and previous_7d is not None else None

    latest_1d = delta(1)
    prior_daily: list[int] = []
    for offset in range(2, 9):
        end_value = by_day.get(latest_day - dt.timedelta(days=offset - 1))
        start_value = by_day.get(latest_day - dt.timedelta(days=offset))
        if end_value is not None and start_value is not None:
            prior_daily.append(end_value - start_value)
    spike = False
    if latest_1d is not None and prior_daily:
        median_prior = statistics.median(abs(value) for value in prior_daily)
        spike = latest_1d < 0 or (
            latest_1d >= 1_000 and latest_1d > max(1, median_prior) * 3
        )
    accelerating = bool(
        acceleration_7d is not None
        and acceleration_7d > 0
        and (previous_7d is None or acceleration_7d >= max(1_000, abs(previous_7d) * 0.25))
    )
    return {
        "true_points": len(history),
        "latest_total": latest_total,
        "velocity_7d": velocity_7d,
        "acceleration_7d": acceleration_7d,
        "anomaly_or_acceleration": bool(
            (spike or accelerating) and latest_day >= today - dt.timedelta(days=8)
        ),
        "observed_at": str(entry.get("maintenance_last_attempt_at") or entry.get("observed_at") or ""),
        "latest_day": latest_day,
        "history_is_current": latest_day >= today - dt.timedelta(days=8),
    }


def plan_track_maintenance(
    tasks: list[dict[str, Any]],
    store: Mapping[str, Any],
    metadata: Mapping[str, Mapping[str, Any]],
    budget: int,
    *,
    today: dt.date,
    priority_artist_ids: set[str] | None = None,
    priority_artist_uuids: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Build a bounded, deterministic daily plan before any track API call."""

    priority_artist_ids = priority_artist_ids or set()
    priority_artist_uuids = priority_artist_uuids or set()
    daily_bucket = today.toordinal() % TRACK_ROTATION_BUCKETS
    profiles: list[dict[str, Any]] = []
    reason_names = (
        "selection_or_negotiation",
        "opportunity",
        "published_public",
        "published_strict",
        "threshold_promotion_watch",
        "needs_two_true_points",
        "release_90d",
        "anomaly_or_acceleration",
        "velocity_or_recency",
        "weekly_rotation",
        "capacity_fill",
    )

    for task in tasks:
        reasons: set[str] = set()
        task_velocity: int | None = None
        task_total: int | None = None
        task_release: dt.date | None = None
        oldest_observed = ""
        stable_key = str(task.get("uuid") or "")
        for target in task.get("targets", []):
            spotify_id = str(target.get("spotify_id") or "").strip()
            key = spotify_id or f"soundcharts:{stable_key}"
            entry = store.get(key) if isinstance(store.get(key), Mapping) else {}
            signals = track_history_signals(entry, today)
            info = metadata.get(spotify_id) if spotify_id else None
            info = info if isinstance(info, Mapping) else {}
            artist_ids = info.get("artist_spotify_ids") if isinstance(info.get("artist_spotify_ids"), set) else set()
            artist_uuids = info.get("artist_soundcharts_uuids") if isinstance(info.get("artist_soundcharts_uuids"), set) else set()
            if artist_ids.intersection(priority_artist_ids) or artist_uuids.intersection(priority_artist_uuids):
                reasons.add("selection_or_negotiation")
            if info.get("opportunity"):
                reasons.add("opportunity")
            if info.get("public"):
                reasons.add("published_public")
            if info.get("strict") or isinstance(target.get("row"), list):
                reasons.add("published_strict")
            if int(signals.get("true_points") or 0) < 2:
                reasons.add("needs_two_true_points")
            release_date = info.get("release_date") if isinstance(info.get("release_date"), dt.date) else None
            if release_date is not None:
                age_days = (today - release_date).days
                if 0 <= age_days <= RECENT_RELEASE_DAYS:
                    reasons.add("release_90d")
                if task_release is None or release_date > task_release:
                    task_release = release_date
            if signals.get("anomaly_or_acceleration"):
                reasons.add("anomaly_or_acceleration")
            velocity = signals.get("velocity_7d")
            if isinstance(velocity, int) and (task_velocity is None or velocity > task_velocity):
                task_velocity = velocity
            total = signals.get("latest_total")
            if isinstance(total, int) and (task_total is None or total > task_total):
                task_total = total
            if isinstance(total, int) and total < TRACK_PUBLIC_STREAM_FLOOR:
                approaching_floor = total >= TRACK_PROMOTION_WATCH_FLOOR
                projected_crossing = (
                    isinstance(velocity, int)
                    and velocity > 0
                    and total + velocity >= TRACK_PUBLIC_STREAM_FLOOR
                )
                if approaching_floor or projected_crossing:
                    reasons.add("threshold_promotion_watch")
            observed = str(signals.get("observed_at") or "")
            if not oldest_observed or observed < oldest_observed:
                oldest_observed = observed

        bucket = stable_rotation_bucket(stable_key)
        # Only genuinely time-sensitive business rows are daily mandatory.
        # Public and strict catalogue membership is handled by the bounded
        # lanes below; making either whole catalogue mandatory permanently
        # starves rotation whenever it is larger than the daily request budget.
        mandatory = bool(
            reasons.intersection(
                {
                    "selection_or_negotiation",
                    "opportunity",
                    "anomaly_or_acceleration",
                }
            )
        )
        profiles.append(
            {
                "task": task,
                "stable_key": stable_key,
                "reasons": reasons,
                "mandatory": mandatory,
                "velocity_7d": task_velocity,
                "latest_total": task_total,
                "release_date": task_release,
                "observed_at": oldest_observed,
                "bucket": bucket,
            }
        )

    def mandatory_key(profile: Mapping[str, Any]) -> tuple[Any, ...]:
        reasons = profile["reasons"]
        return (
            0 if "selection_or_negotiation" in reasons else 1,
            0 if "opportunity" in reasons else 1,
            0 if "published_public" in reasons else 1,
            0 if "published_strict" in reasons else 1,
            0 if "threshold_promotion_watch" in reasons else 1,
            0 if "needs_two_true_points" in reasons else 1,
            0 if "release_90d" in reasons else 1,
            0 if "anomaly_or_acceleration" in reasons else 1,
            profile["observed_at"],
            profile["stable_key"],
        )

    def velocity_key(profile: Mapping[str, Any]) -> tuple[Any, ...]:
        release = profile["release_date"]
        return (
            -(profile["velocity_7d"] if isinstance(profile["velocity_7d"], int) else -1),
            -(release.toordinal() if isinstance(release, dt.date) else -1),
            -(profile["latest_total"] if isinstance(profile["latest_total"], int) else -1),
            profile["stable_key"],
        )

    def rotation_key(profile: Mapping[str, Any]) -> tuple[Any, ...]:
        return (
            profile["observed_at"],
            -(profile["velocity_7d"] if isinstance(profile["velocity_7d"], int) else -1),
            profile["stable_key"],
        )

    cap = max(0, min(budget, len(profiles)))
    mandatory = sorted((profile for profile in profiles if profile["mandatory"]), key=mandatory_key)
    selected: list[dict[str, Any]] = mandatory[:cap]
    selected_keys = {profile["stable_key"] for profile in selected}
    remaining_slots = cap - len(selected)

    nonmandatory = [profile for profile in profiles if profile["stable_key"] not in selected_keys]
    due_rotation = sorted(
        (profile for profile in nonmandatory if profile["bucket"] == daily_bucket),
        key=lambda profile: (
            0 if "published_public" in profile["reasons"] else 1,
            *rotation_key(profile),
        ),
    )
    for profile in due_rotation:
        profile["reasons"].add("weekly_rotation")

    # Weekly public coverage wins over opportunistic hot-track refreshes. A
    # normal maintenance pass selects the current public bucket first. A
    # larger explicit catch-up budget selects the whole public catalogue in
    # one pass before spending spare capacity on non-public history rows.
    public_profiles = sorted(
        (
            profile
            for profile in nonmandatory
            if "published_public" in profile["reasons"]
        ),
        key=lambda profile: (
            0 if profile["bucket"] == daily_bucket else 1,
            *rotation_key(profile),
        ),
    )
    # Fill every spare request with a public row, starting with today's due
    # bucket and then the oldest remaining public rows. At the normal 6k cap
    # this refreshes the 20k public catalogue in roughly four passes instead
    # of waiting a full week; the explicit catch-up lane can cover it at once.
    public_selected = public_profiles[:remaining_slots]
    selected.extend(public_selected)
    selected_keys.update(profile["stable_key"] for profile in public_selected)

    # Keep new, recent and threshold-adjacent candidates ahead of generic
    # non-public history rows without allowing them to displace public-catalogue
    # coverage. This preserves discovery quality while the public catalogue is
    # rotated (or fully caught up) first.
    remaining_slots = cap - len(selected)
    secondary_priority_reasons = {
        "published_strict",
        "threshold_promotion_watch",
        "needs_two_true_points",
        "release_90d",
    }
    secondary_candidates = sorted(
        (
            profile
            for profile in nonmandatory
            if profile["stable_key"] not in selected_keys
            if profile["reasons"].intersection(secondary_priority_reasons)
        ),
        key=mandatory_key,
    )
    secondary_selected = secondary_candidates[:remaining_slots]
    selected.extend(secondary_selected)
    selected_keys.update(profile["stable_key"] for profile in secondary_selected)

    remaining_slots = cap - len(selected)
    rotation_selected = [
        profile
        for profile in due_rotation
        if profile["stable_key"] not in selected_keys
    ][:remaining_slots]
    selected.extend(rotation_selected)
    selected_keys.update(profile["stable_key"] for profile in rotation_selected)

    remaining_slots = cap - len(selected)
    velocity_candidates = sorted(
        (
            profile
            for profile in nonmandatory
            if profile["stable_key"] not in selected_keys
            if isinstance(profile["velocity_7d"], int) or isinstance(profile["release_date"], dt.date)
        ),
        key=velocity_key,
    )
    for profile in velocity_candidates:
        profile["reasons"].add("velocity_or_recency")
    velocity_selected = velocity_candidates[:remaining_slots]
    selected.extend(velocity_selected)
    selected_keys.update(profile["stable_key"] for profile in velocity_selected)

    remaining_slots = cap - len(selected)
    if remaining_slots:
        capacity_selected = sorted(
            (profile for profile in nonmandatory if profile["stable_key"] not in selected_keys),
            key=rotation_key,
        )[:remaining_slots]
        for profile in capacity_selected:
            profile["reasons"].add("capacity_fill")
        selected.extend(capacity_selected)
        selected_keys.update(profile["stable_key"] for profile in capacity_selected)

    selected_reason_counts = {
        reason: sum(reason in profile["reasons"] for profile in selected) for reason in reason_names
    }
    expected_reason_counts = {
        reason: sum(reason in profile["reasons"] for profile in profiles) for reason in reason_names
    }
    bucket_coverage = {
        str(bucket): {
            "expected_requests": sum(profile["bucket"] == bucket for profile in profiles),
            "selected_requests": sum(profile["bucket"] == bucket for profile in selected),
        }
        for bucket in range(TRACK_ROTATION_BUCKETS)
    }
    selected_velocities = [
        profile["velocity_7d"]
        for profile in selected
        if "velocity_or_recency" in profile["reasons"] and isinstance(profile["velocity_7d"], int)
    ]
    public_due_requests = sum(
        profile["bucket"] == daily_bucket
        and not profile["mandatory"]
        and "published_public" in profile["reasons"]
        for profile in profiles
    )
    public_due_selected = sum(
        profile["bucket"] == daily_bucket
        and not profile["mandatory"]
        and "published_public" in profile["reasons"]
        for profile in selected
    )
    policy = {
        "version": TRACK_MAINTENANCE_POLICY_VERSION,
        "selection_mode": "adaptive_daily",
        "request_cap": budget,
        "expected_requests": len(profiles),
        "selected_requests": len(selected),
        "missing_requests": max(0, len(profiles) - len(selected)),
        "mandatory_requests": len(mandatory),
        "mandatory_selected": sum(profile["mandatory"] for profile in selected),
        "daily_rotation_bucket": daily_bucket,
        "rotation_bucket_count": TRACK_ROTATION_BUCKETS,
        "weekly_due_requests": len(due_rotation),
        "weekly_selected_requests": sum(
            profile["bucket"] == daily_bucket and not profile["mandatory"]
            for profile in selected
        ),
        "weekly_missing": max(
            0,
            len(due_rotation)
            - sum(
                profile["bucket"] == daily_bucket and not profile["mandatory"]
                for profile in selected
            ),
        ),
        "weekly_missing_requests": max(
            0,
            len(due_rotation)
            - sum(
                profile["bucket"] == daily_bucket and not profile["mandatory"]
                for profile in selected
            ),
        ),
        "public_due_requests": public_due_requests,
        "public_due_selected_requests": public_due_selected,
        "public_due_missing_requests": max(0, public_due_requests - public_due_selected),
        "velocity_cutoff_7d": min(selected_velocities) if selected_velocities else None,
        "reason_coverage": {
            reason: {
                "expected_requests": expected_reason_counts[reason],
                "selected_requests": selected_reason_counts[reason],
                "missing_requests": max(0, expected_reason_counts[reason] - selected_reason_counts[reason]),
            }
            for reason in reason_names
        },
        "rotation_coverage": bucket_coverage,
    }
    return [profile["task"] for profile in selected], policy


def refresh_tracks(
    payload: dict[str, Any],
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
    history_days: int,
    *,
    include_performance_catalogue: bool = False,
    public_catalogue: Mapping[str, Any] | None = None,
    priority_artist_ids: set[str] | None = None,
    priority_artist_uuids: set[str] | None = None,
    public_track_catchup: bool = False,
) -> Outcome:
    schema, rows = ensure_schema_fields(
        payload,
        "tracks",
        ["streams", "delta", "observed_at", "source_date", "previous_source_date"],
    )
    # Soundcharts source windows use UTC dates, while the dashboard's daily
    # maintenance contract is evaluated in Europe/Paris. Freeze both once so a
    # run near midnight (or spanning it) cannot plan one rotation day and be
    # validated against another.
    source_window_day = utc_today()
    business_day = paris_today()
    period_days = min(90, max(65, history_days))
    start = (source_window_day - dt.timedelta(days=period_days - 1)).isoformat()
    end = source_window_day.isoformat()
    store = performance.setdefault("tracks", {})
    if not isinstance(store, dict):
        raise SoundchartsError("Performance tracks must be an object")
    query = urllib.parse.urlencode({"startDate": start, "endDate": end, "limit": max(100, history_days + 5)})
    tasks_by_uuid: dict[str, dict[str, Any]] = {}
    scheduled_uuid_by_spotify: dict[str, str] = {}
    strict_spotify_ids: set[str] = set()
    preferred_uuid_by_spotify: dict[str, str] = {}
    public_spotify_ids: set[str] = set()
    public_discovery = (
        public_catalogue.get("discovery_catalogue")
        if isinstance(public_catalogue, Mapping)
        else None
    )
    public_schema = public_discovery.get("track_schema") if isinstance(public_discovery, Mapping) else None
    public_rows = public_discovery.get("tracks") if isinstance(public_discovery, Mapping) else None

    def add_target(
        uuid: str,
        spotify_id: str,
        row: list[Any] | None,
        *,
        performance_only: bool,
    ) -> None:
        if spotify_id:
            scheduled_uuid = scheduled_uuid_by_spotify.get(spotify_id)
            if scheduled_uuid and scheduled_uuid != uuid:
                if row is not None:
                    raise SoundchartsError("Conflicting authoritative Soundcharts UUID for a Spotify track")
                return
            scheduled_uuid_by_spotify[spotify_id] = uuid
        task = tasks_by_uuid.setdefault(
            uuid,
            {
                "uuid": uuid,
                "path": f"/api/v2/song/{urllib.parse.quote(uuid)}/audience/spotify?{query}",
                "targets": [],
            },
        )
        for existing_target in task["targets"]:
            if spotify_id and str(existing_target.get("spotify_id") or "") == spotify_id:
                if row is not None:
                    existing_target["row"] = row
                    existing_target["performance_only"] = False
                return
            if not spotify_id and not existing_target.get("spotify_id"):
                return
        task["targets"].append(
            {
                "row": row,
                "spotify_id": spotify_id,
                "performance_only": performance_only,
            }
        )

    for row in rows:
        uuid = str(field(row, schema, "soundcharts_uuid") or "").strip()
        if not uuid:
            continue
        spotify_id = str(field(row, schema, "spotify_id") or "").strip()
        if spotify_id:
            strict_spotify_ids.add(spotify_id)
            preferred_uuid_by_spotify[spotify_id] = uuid
        add_target(uuid, spotify_id, row, performance_only=False)

    # Resolve the exact public identity layer before adding discovery or
    # historical fallbacks. Authority is strict snapshot > public browse >
    # performance store, so one Spotify ID can never schedule two UUIDs.
    if isinstance(public_schema, list) and isinstance(public_rows, list):
        for public_row in public_rows:
            if not isinstance(public_row, list):
                continue
            spotify_id = str(field(public_row, public_schema, "spotify_id") or "").strip()
            uuid = str(field(public_row, public_schema, "soundcharts_uuid") or "").strip()
            if not spotify_id:
                continue
            public_spotify_ids.add(spotify_id)
            if uuid and spotify_id not in strict_spotify_ids:
                preferred_uuid_by_spotify[spotify_id] = uuid

    if include_performance_catalogue:
        # The cumulative discovery catalogue is the source-backed waiting
        # room for tracks below the public 100k floor.  Enrol every resolvable
        # row so crossing the threshold can be detected without first being
        # visible in the dashboard.
        discovery = payload.get("discovery_catalogue")
        if isinstance(discovery, Mapping):
            discovery_schema = discovery.get("track_schema")
            discovery_rows = discovery.get("tracks")
            if isinstance(discovery_schema, list) and isinstance(discovery_rows, list):
                for discovery_row in discovery_rows:
                    if not isinstance(discovery_row, list):
                        continue
                    uuid = str(field(discovery_row, discovery_schema, "soundcharts_uuid") or "").strip()
                    spotify_id = str(field(discovery_row, discovery_schema, "spotify_id") or "").strip()
                    if not uuid or spotify_id in strict_spotify_ids:
                        continue
                    preferred_uuid = preferred_uuid_by_spotify.get(spotify_id)
                    if preferred_uuid and preferred_uuid != uuid:
                        continue
                    add_target(uuid, spotify_id, None, performance_only=True)

        # Enrol exact public rows even when a sanitized candidate snapshot no
        # longer carries them.  They remain performance-only and therefore can
        # never be promoted by this maintenance pass.
        if isinstance(public_schema, list) and isinstance(public_rows, list):
            for public_row in public_rows:
                if not isinstance(public_row, list):
                    continue
                uuid = str(field(public_row, public_schema, "soundcharts_uuid") or "").strip()
                spotify_id = str(field(public_row, public_schema, "spotify_id") or "").strip()
                if not uuid or not spotify_id or spotify_id in strict_spotify_ids:
                    continue
                add_target(uuid, spotify_id, None, performance_only=True)

        for raw_key, entry in store.items():
            if not isinstance(entry, dict):
                continue
            uuid = str(entry.get("soundcharts_uuid") or "").strip()
            raw_key = str(raw_key or "").strip()
            spotify_id = "" if raw_key.startswith("soundcharts:") else raw_key
            # Strict/public identities are authoritative. A stale performance
            # entry for that same ID must never schedule a concurrent request
            # against its former Soundcharts UUID.
            if not uuid or not spotify_id or spotify_id in strict_spotify_ids:
                continue
            preferred_uuid = preferred_uuid_by_spotify.get(spotify_id)
            if preferred_uuid and preferred_uuid != uuid:
                continue
            add_target(uuid, spotify_id, None, performance_only=True)

    # One Soundcharts song request contains every Spotify plot/alias. Plan the
    # complete request set before the first data call, then select an explicit
    # daily cohort under the local and server-side quota caps.
    tasks = list(tasks_by_uuid.values())
    available_entities = sum(len(task["targets"]) for task in tasks)
    safe_budget = max(0, budget)
    available_budget = getattr(client, "available_request_budget", None)
    if callable(available_budget):
        safe_budget = available_budget(safe_budget)
    planning_budget = safe_budget
    if len(tasks) >= safe_budget > 0:
        # The hard cap counts real HTTP attempts, including retries. Keep a
        # small bounded margin so one transient 429/5xx cannot invalidate an
        # otherwise useful bounded maintenance pass at the very last request.
        retry_headroom = max(1, safe_budget // 50)
        planning_budget = max(1, safe_budget - retry_headroom)
    metadata = build_track_maintenance_metadata(payload, public_catalogue)
    selected_tasks, policy = plan_track_maintenance(
        tasks,
        store,
        metadata,
        planning_budget,
        today=business_day,
        priority_artist_ids=priority_artist_ids,
        priority_artist_uuids=priority_artist_uuids,
    )
    policy["execution_profile"] = (
        "public_catchup" if public_track_catchup else "daily_maintenance"
    )
    selected_entities = sum(len(task["targets"]) for task in selected_tasks)
    policy["requested_cap"] = max(0, budget)
    policy["safe_preflight_cap"] = safe_budget
    policy["planned_data_call_cap"] = planning_budget
    policy["retry_headroom_requests"] = max(0, safe_budget - planning_budget)
    policy["expected_entities"] = available_entities
    policy["selected_entities"] = selected_entities
    policy["missing_entities_before_collection"] = max(0, available_entities - selected_entities)
    print(json.dumps({"track_maintenance_preflight": policy}, ensure_ascii=False))

    outcome = Outcome("tracks")
    outcome.policy = policy
    attempted_at = utc_now()
    for task in selected_tasks:
        for target in task.get("targets", []):
            spotify_id = str(target.get("spotify_id") or "").strip()
            key = spotify_id or f"soundcharts:{task['uuid']}"
            entry = store.get(key)
            if isinstance(entry, dict):
                entry["maintenance_last_attempt_at"] = attempted_at
    (
        results,
        outcome.requests,
        outcome.failures,
        outcome.unavailable,
        outcome.available,
        outcome.selected,
        outcome.failure_diagnostics,
        outcome.unavailable_diagnostics,
    ) = parallel_collect(
        client, selected_tasks, workers=workers, max_requests=len(selected_tasks)
    )
    outcome.available = available_entities
    outcome.selected = selected_entities
    now = utc_now()
    refreshed_public_ids: set[str] = set()
    for task, response in results:
        targets = task.get("targets") if isinstance(task.get("targets"), list) else []
        require_identifier_match = len(targets) > 1
        for target in targets:
            spotify_id = str(target.get("spotify_id") or "")
            points = extract_song_audience_points(
                response,
                spotify_id,
                require_identifier_match=require_identifier_match,
            )
            key = spotify_id or f"soundcharts:{task['uuid']}"
            if not points:
                outcome.items.append(
                    {"entity": "track", "id": key, "ok": response is not None, "usable": False}
                )
                continue
            row = target.get("row")
            entry = store.setdefault(key, {})
            if not isinstance(entry, dict):
                entry = {}
                store[key] = entry
            previous_uuid = str(entry.get("soundcharts_uuid") or "").strip()
            identity_changed = bool(previous_uuid and previous_uuid != task["uuid"])
            # A corrected authoritative mapping may point at a completely
            # different Soundcharts song. Never splice the former song's
            # counters into the corrected identity: that creates artificial
            # jumps and gaps in the public chart. Keep only source-backed
            # points returned for the new UUID and record the reset for audit.
            previous_history = None if identity_changed else entry.get("history")
            merged_history = merge_history(previous_history, points)
            integrity = sanitize_counter_history(merged_history)
            entry["history"] = integrity["history"]
            if not entry["history"]:
                outcome.items.append(
                    {
                        "entity": "track",
                        "id": key,
                        "ok": True,
                        "usable": False,
                        "counter_integrity_status": integrity["status"],
                    }
                )
                continue
            latest_day, latest_value = entry["history"][-1]
            by_day = {day: value for day, value in entry["history"]}
            prior_day = previous_day(latest_day)
            prior_value = by_day.get(prior_day)
            delta = latest_value - prior_value if prior_value is not None else None
            if integrity["changed"]:
                entry["counter_integrity"] = {
                    "version": 1,
                    "status": integrity["status"],
                    "checked_at": now,
                    "events": integrity["events"],
                }
            if identity_changed:
                entry["previous_soundcharts_uuid"] = previous_uuid
                entry["identity_reset_at"] = now
            entry["soundcharts_uuid"] = task["uuid"]
            entry["observed_at"] = now
            entry["maintenance_last_attempt_at"] = attempted_at
            entry["cadence_days"] = 1
            entry["source"] = "soundcharts_song_audience_spotify"

            if isinstance(row, list):
                set_field(row, schema, "streams", latest_value)
                set_field(row, schema, "delta", delta)
                set_field(row, schema, "source_date", latest_day)
                set_field(row, schema, "previous_source_date", prior_day if prior_value is not None else None)
                set_field(row, schema, "observed_at", now)
            outcome.usable += 1
            if spotify_id in public_spotify_ids:
                refreshed_public_ids.add(spotify_id)
            outcome.items.append(
                {
                    "entity": "track",
                    "id": key,
                    "value": latest_value,
                    "date": latest_day,
                    "delta_24h": delta,
                    "points": len(entry["history"]),
                    "ok": True,
                    "usable": True,
                    "performance_only": bool(target.get("performance_only")),
                    "counter_integrity_status": integrity["status"],
                }
            )

    task_public_ids = {
        str(target.get("spotify_id") or "").strip()
        for task in tasks
        for target in task.get("targets", [])
        if str(target.get("spotify_id") or "").strip() in public_spotify_ids
    }
    selected_public_ids = {
        str(target.get("spotify_id") or "").strip()
        for task in selected_tasks
        for target in task.get("targets", [])
        if str(target.get("spotify_id") or "").strip() in public_spotify_ids
    }
    daily_cutoff = business_day - dt.timedelta(days=1)
    weekly_cutoff = business_day - dt.timedelta(days=7)
    usable_public_ids: set[str] = set()
    daily_current_public_ids: set[str] = set()
    weekly_current_public_ids: set[str] = set()
    latest_public_days: list[dt.date] = []
    for spotify_id in task_public_ids:
        entry = store.get(spotify_id)
        history = normalize_history(entry.get("history")) if isinstance(entry, Mapping) else []
        if not history:
            continue
        usable_public_ids.add(spotify_id)
        try:
            latest_day = dt.date.fromisoformat(history[-1][0])
        except (TypeError, ValueError):
            continue
        latest_public_days.append(latest_day)
        if latest_day >= daily_cutoff:
            daily_current_public_ids.add(spotify_id)
        if latest_day >= weekly_cutoff:
            weekly_current_public_ids.add(spotify_id)
    weekly_stale_entities = max(0, len(task_public_ids) - len(weekly_current_public_ids))
    policy["published_public_entity_coverage"] = {
        "public_entities": len(public_spotify_ids),
        "resolvable_entities": len(task_public_ids),
        "unresolved_entities": max(0, len(public_spotify_ids) - len(task_public_ids)),
        "selected_entities": len(selected_public_ids),
        "missing_selected_entities": max(0, len(task_public_ids) - len(selected_public_ids)),
        "refreshed_entities": len(refreshed_public_ids),
        "usable_history_entities": len(usable_public_ids),
        # Developer-plan maintenance refreshes active A&R priorities daily and
        # rotates the wider public cohort. Keep both windows visible so the
        # watchdog can enforce weekly completeness without hiding daily lag.
        "daily_current_source_entities": len(daily_current_public_ids),
        "daily_lagging_source_entities": max(0, len(task_public_ids) - len(daily_current_public_ids)),
        "daily_freshness_cutoff": daily_cutoff.isoformat(),
        "source_age_limit_days": 7,
        "current_source_entities": len(weekly_current_public_ids),
        "lagging_source_entities": weekly_stale_entities,
        "stale_source_entities": weekly_stale_entities,
        "freshness_cutoff": weekly_cutoff.isoformat(),
        "latest_source_date": max(latest_public_days).isoformat() if latest_public_days else None,
    }
    return outcome


def refresh_artists(
    payload: dict[str, Any],
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
    *,
    history_days: int = ARTIST_LISTENING_WINDOW_DAYS,
    include_performance_catalogue: bool = False,
) -> Outcome:
    schema, rows = ensure_schema_fields(payload, "artists", ["monthly_listeners", "delta", "observed_at"])
    store = performance.setdefault("artists", {})
    if not isinstance(store, dict):
        raise SoundchartsError("Performance artists must be an object")
    tasks = []
    strict_uuids: set[str] = set()
    listening_day = utc_today()
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        if not uuid:
            continue
        strict_uuids.add(str(uuid))
        tasks.append(
            {
                "row": row,
                "uuid": str(uuid),
                "spotify_id": str(field(row, schema, "spotify_id") or ""),
                "name": str(field(row, schema, "name") or ""),
                "path": artist_spotify_listening_path(str(uuid), history_days, today=listening_day),
            }
        )
    if include_performance_catalogue:
        for spotify_id, entry in store.items():
            if not isinstance(entry, dict):
                continue
            uuid = str(entry.get("soundcharts_uuid") or "").strip()
            spotify_id = str(spotify_id or "").strip()
            if not uuid or not spotify_id or uuid in strict_uuids:
                continue
            tasks.append(
                {
                    "row": None,
                    "uuid": uuid,
                    "spotify_id": spotify_id,
                    "name": "",
                    "path": artist_spotify_listening_path(uuid, history_days, today=listening_day),
                    "performance_only": True,
                }
            )

    outcome = Outcome("artists")
    (
        results,
        outcome.requests,
        outcome.failures,
        outcome.unavailable,
        outcome.available,
        outcome.selected,
        outcome.failure_diagnostics,
        outcome.unavailable_diagnostics,
    ) = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    now = utc_now()
    for task, response in results:
        points = extract_artist_spotify_listening_points(response)
        if not points:
            outcome.items.append({"entity": "artist", "id": task["uuid"], "ok": response is not None, "usable": False})
            continue
        row = task.get("row")
        day, value = points[-1]
        value = int(value)
        key = task["spotify_id"] or task["name"] or task["uuid"]
        entry = store.setdefault(key, {})
        if not isinstance(entry, dict):
            entry = {}
            store[key] = entry
        previous = None
        historical = normalize_history(entry.get("history") or entry.get("monthly_listeners_history"))
        prior_points = [point for point in [*historical, *points[:-1]] if point[0] < day]
        if prior_points:
            previous = max(prior_points, key=lambda point: point[0])[1]
        elif isinstance(row, list):
            previous = field(row, schema, "monthly_listeners")
        delta = value - int(previous) if isinstance(previous, (int, float)) else None
        merged = merge_history(historical, points)
        entry["history"] = merged
        entry["monthly_listeners_history"] = merged
        entry["soundcharts_uuid"] = task["uuid"]
        entry["observed_at"] = now
        entry["source"] = "soundcharts_artist_streaming_spotify_listening"

        if isinstance(row, list):
            set_field(row, schema, "monthly_listeners", value)
            set_field(row, schema, "delta", delta)
            set_field(row, schema, "observed_at", now)
        outcome.usable += 1
        outcome.items.append(
            {
                "entity": "artist",
                "id": key,
                "value": value,
                "date": day,
                "delta": delta,
                "points": len(points),
                "ok": True,
                "usable": True,
                "performance_only": bool(task.get("performance_only")),
            }
        )
    return outcome


def refresh_playlists(
    path: Path,
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
    *,
    dashboard_only: bool = False,
) -> Outcome:
    playlists = read_js_payload(path, PLAYLISTS_PREFIX)
    columns = list(playlists.get("cols", []))
    rows = playlists.get("rows", [])
    if "image_url" not in columns:
        columns.append("image_url")
        for row in rows:
            if isinstance(row, list):
                row.append("")
        playlists["cols"] = columns
    id_index = index_of(columns, "id")
    followers_index = index_of(columns, "followers")
    image_index = index_of(columns, "image_url")
    dashboard_index = index_of(columns, "big10k")
    last_seen_index = index_of(columns, "last_seen")
    if id_index is None or followers_index is None:
        raise SoundchartsError("Spotify playlist export does not contain id/followers columns")

    # Keep the browser payload and the performance export in lockstep.  The
    # former contains the initial discovery baseline while the latter is the
    # daily refresh source; either one alone is not a complete time series.
    history_store = playlists.get("hist")
    if not isinstance(history_store, dict):
        history_store = {}
        playlists["hist"] = history_store

    # The public dashboard intentionally exposes the curated ``big10k``
    # subset (currently 554 playlists), while the backing discovery file also
    # contains a much larger research backlog.  Refresh the visible set first
    # so the daily follower history always serves what users can actually see.
    # Rows without this flag retain the legacy behaviour and are refreshed
    # after the visible collection when the request budget permits.
    tasks_with_priority = []
    for position, row in enumerate(rows):
        playlist_id = row[id_index] if id_index < len(row) else None
        if playlist_id:
            visible = bool(row[dashboard_index]) if dashboard_index is not None and dashboard_index < len(row) else False
            if dashboard_only and not visible:
                continue
            tasks_with_priority.append(
                (
                    0 if visible else 1,
                    position,
                    {
                    "row": row,
                    "id": str(playlist_id),
                    # v2.8 is the current Soundcharts platform-ID lookup. It
                    # returns the playlist metadata including its latest
                    # Spotify subscriber count when Soundcharts has one.
                    "path": f"/api/v2.8/playlist/by-platform/spotify/{urllib.parse.quote(str(playlist_id))}",
                    },
                )
            )
    tasks = [task for _, _, task in sorted(tasks_with_priority, key=lambda item: (item[0], item[1]))]

    outcome = Outcome("playlists")
    outcome.follower_usable = 0
    (
        results,
        outcome.requests,
        outcome.failures,
        outcome.unavailable,
        outcome.available,
        outcome.selected,
        outcome.failure_diagnostics,
        outcome.unavailable_diagnostics,
    ) = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    store = performance.setdefault("playlists", {})
    day = paris_today().isoformat()
    now = utc_now()
    history_points_added = 0
    for task, response in results:
        followers = first_numeric_named(response, {"latestSubscriberCount", "subscriberCount", "followers"})
        image_url = first_text_named(response, {"imageUrl", "image_url", "coverUrl", "cover_url", "thumbnailUrl", "thumbnail_url"})
        if followers is None and not image_url:
            outcome.items.append({"entity": "playlist", "id": task["id"], "ok": response is not None, "usable": False})
            continue
        row = task["row"]
        if followers is not None:
            while len(row) <= followers_index:
                row.append(None)
            row[followers_index] = followers
            if last_seen_index is not None:
                while len(row) <= last_seen_index:
                    row.append("")
                row[last_seen_index] = day
        if image_url and image_index is not None:
            while len(row) <= image_index:
                row.append("")
            row[image_index] = image_url
        if followers is not None:
            entry = store.setdefault(task["id"], {})
            previous_history = merge_history(history_store.get(task["id"]), entry.get("history"))
            if day not in {point[0] for point in previous_history}:
                history_points_added += 1
            history = merge_history(previous_history, [[day, followers]])
            # Persist the same merged history in both files.  This prevents a
            # daily refresh from replacing the original baseline in the UI.
            history_store[task["id"]] = history
            entry["history"] = history
            entry["observed_at"] = now
            entry["source"] = "soundcharts_playlist_spotify"
        # A cover-only response is useful for artwork, but it is not a
        # follower observation and must never mark the daily pass as fresh.
        follower_usable = followers is not None
        outcome.usable += 1
        outcome.follower_usable += int(follower_usable)
        outcome.items.append(
            {
                "entity": "playlist",
                "id": task["id"],
                "followers": followers,
                "image_url": image_url or None,
                "date": day,
                "ok": True,
                "usable": follower_usable,
            }
        )

    if outcome.usable:
        meta = playlists.setdefault("meta", {})
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
        meta["snapshot_ts"] = stamp
        meta["generated_ts"] = stamp
        meta["history_points_added_this_run"] = history_points_added
        target_ids = [task["id"] for task in tasks]
        updated = sum(
            1
            for playlist_id in target_ids
            if any(
                point[0] == day and isinstance(point[1], (int, float)) and not isinstance(point[1], bool)
                for point in normalize_history(history_store.get(playlist_id))
            )
        )
        tracking_status = {
            "day": day,
            "scope": "dashboard" if dashboard_only else "all",
            "expected": len(target_ids),
            "selected": outcome.selected,
            "updated": updated,
            "missing": max(0, len(target_ids) - updated),
            "complete": bool(
                target_ids
                and outcome.failures == 0
                and outcome.selected == outcome.available
                and updated == len(target_ids)
            ),
            "observed_at": now,
        }
        meta["playlist_followers_status"] = tracking_status
        performance["playlist_followers_status"] = tracking_status
        write_js_payload(path, playlists, PLAYLISTS_PREFIX)
    return outcome


def refresh_fal(
    payload: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
) -> Outcome:
    schema = list(payload.get("schemas", {}).get("artists", []))
    rows = payload.get("artists", [])
    tasks = []
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        outbound = field(row, schema, "fal_out")
        if uuid and isinstance(outbound, (int, float)) and outbound > 0:
            tasks.append(
                {
                    "uuid": str(uuid),
                    "path": f"/api/v2/artist/{urllib.parse.quote(str(uuid))}/related?limit=50",
                }
            )

    outcome = Outcome("fal")
    (
        results,
        outcome.requests,
        outcome.failures,
        outcome.unavailable,
        outcome.available,
        outcome.selected,
        outcome.failure_diagnostics,
        outcome.unavailable_diagnostics,
    ) = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    for task, response in results:
        members = response.get("items", response.get("data", [])) if isinstance(response, dict) else response
        count = len(members) if isinstance(members, list) else None
        usable = count is not None
        outcome.usable += int(usable)
        outcome.items.append(
            {
                "entity": "fal",
                "id": task["uuid"],
                "related_count": count,
                "observed_at": utc_now(),
                "ok": response is not None,
                "usable": usable,
            }
        )
    return outcome


def merge_performance_freshness(
    previous: Mapping[str, Any] | None,
    payload_freshness: Mapping[str, Any] | None,
    outcomes: Mapping[str, Outcome],
    now: str,
    *,
    include_performance_catalogue: bool = False,
) -> dict[str, Any]:
    """Preserve metric timestamps not touched by a focused refresh mode."""

    old = previous if isinstance(previous, Mapping) else {}
    current = payload_freshness if isinstance(payload_freshness, Mapping) else {}
    playlist_outcome = outcomes.get("playlists")
    playlist_usable = (
        playlist_outcome.follower_usable
        if playlist_outcome and playlist_outcome.follower_usable is not None
        else playlist_outcome.usable if playlist_outcome else 0
    )
    playlist_complete = bool(
        playlist_outcome
        and playlist_outcome.available > 0
        and playlist_outcome.failures == 0
        and playlist_outcome.selected == playlist_outcome.available
        and playlist_usable == playlist_outcome.selected
    )
    merged = {
        "tracks_at": now if outcomes.get("tracks") and outcomes["tracks"].usable else current.get("tracks_at") or old.get("tracks_at"),
        "artists_at": now if outcomes.get("artists") and outcomes["artists"].usable else current.get("artists_at") or old.get("artists_at"),
        "playlists_at": now if playlist_complete else old.get("playlists_at"),
        # These dedicated timestamps prove that the scheduled catalogue
        # maintenance pass ran. Artists remain complete; tracks may use the
        # explicit adaptive coverage recorded in maintenance_coverage.
        "tracks_catalogue_at": old.get("tracks_catalogue_at"),
        "artists_catalogue_at": old.get("artists_catalogue_at"),
    }
    if include_performance_catalogue:
        for mode in ("tracks", "artists"):
            outcome = outcomes.get(mode)
            adaptive_track_pass = bool(
                mode == "tracks"
                and outcome
                and outcome.policy.get("selection_mode") == "adaptive_daily"
                and outcome.selected > 0
            )
            if (
                outcome
                and outcome.usable > 0
                and outcome.failures == 0
                and outcome.available > 0
                and (outcome.selected == outcome.available or adaptive_track_pass)
            ):
                merged[f"{mode}_catalogue_at"] = now
    return merged


def smoke_test(payload: dict[str, Any], client: SoundchartsClient, history_days: int) -> dict[str, Any]:
    artist_schema = list(payload.get("schemas", {}).get("artists", []))
    track_schema = list(payload.get("schemas", {}).get("tracks", []))

    artist_points: list[list[Any]] = []
    artist_requests = 0
    artist_period_days = min(90, max(10, history_days))
    for row in payload.get("artists", [])[:50]:
        uuid = field(row, artist_schema, "soundcharts_uuid")
        if not uuid:
            continue
        artist_requests += 1
        response = client.get(artist_spotify_listening_path(str(uuid), artist_period_days))
        artist_points = extract_artist_spotify_listening_points(response)
        if artist_points or artist_requests >= 8:
            break

    period_days = min(90, max(10, history_days))
    start = (utc_today() - dt.timedelta(days=period_days - 1)).isoformat()
    end = utc_today().isoformat()
    track_points: list[list[Any]] = []
    track_requests = 0
    for row in payload.get("tracks", [])[:100]:
        uuid = field(row, track_schema, "soundcharts_uuid")
        if not uuid:
            continue
        spotify_id = str(field(row, track_schema, "spotify_id") or "")
        query = urllib.parse.urlencode({"startDate": start, "endDate": end, "limit": max(100, history_days + 5)})
        track_requests += 1
        response = client.get(f"/api/v2/song/{urllib.parse.quote(str(uuid))}/audience/spotify?{query}")
        track_points = extract_song_audience_points(response, spotify_id)
        if track_points or track_requests >= 12:
            break

    if not artist_points:
        raise SoundchartsError("Authentication succeeded but no Spotify artist listening point could be parsed")
    if not track_points:
        raise SoundchartsError("Authentication succeeded but no Spotify song audience point could be parsed")
    return {
        "status": "success",
        "auth_mode": client.auth_mode,
        "artist_requests": artist_requests,
        "artist_points": len(artist_points),
        "track_requests": track_requests,
        "artist_metric_date": artist_points[-1][0],
        "track_points": len(track_points),
        "latest_track_date": track_points[-1][0],
        "quota_remaining": client.quota_remaining,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["full", "artists", "tracks", "fal", "playlists", "smoke", "storage"],
        default="full",
    )
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--max-requests", type=int, default=100000)
    parser.add_argument("--history-days", type=int, default=95)
    parser.add_argument(
        "--playlist-scope",
        choices=["all", "dashboard"],
        default="all",
        help="Refresh every discovered playlist or only the playlists published in the dashboard",
    )
    parser.add_argument(
        "--include-performance-catalogue",
        action="store_true",
        help="Refresh existing performance-only UUIDs without promoting them into the public Soundcharts export",
    )
    parser.add_argument(
        "--public-track-catchup",
        action="store_true",
        help="Mark a one-time bounded pass that must select the whole resolvable public track catalogue",
    )
    parser.add_argument(
        "--priority-artists",
        type=Path,
        default=Path("spotify-selection-artist-seeds.json"),
        help="Server-known Selection artists that must win over routine catalogue rotation",
    )
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument(
        "--browse-catalogue",
        type=Path,
        default=Path("Spotify_Browse_Catalogue_data.js"),
        help="Exact public track cohort that must receive daily performance priority",
    )
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument(
        "--playlists",
        type=Path,
        default=Path("Spotify_Playlists_canonical_data.js"),
    )
    parser.add_argument("--history-dir", type=Path, default=Path("soundcharts-history"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.mode == "storage":
        performance = read_performance_payload(args.performance)
        archived_track_history = prune_track_histories_to_hot_window(performance)
        archive_summary = write_track_history_archive(args.history_dir, archived_track_history)
        try:
            written = write_performance_payload(args.performance, performance)
            validated = validate_performance_store(args.performance)
        except PerformanceStoreError as exc:
            raise SoundchartsError(str(exc)) from exc
        print(
            json.dumps(
                {
                    "performance_store": {**written, "validated": validated},
                    "track_history_archive": archive_summary,
                },
                ensure_ascii=False,
            )
        )
        return 0

    payload = read_js_payload(args.soundcharts)
    browse_path = getattr(args, "browse_catalogue", Path("Spotify_Browse_Catalogue_data.js"))
    public_catalogue = (
        read_js_payload(browse_path, BROWSE_CATALOGUE_PREFIX)
        if browse_path.exists()
        else {}
    )
    performance = None if args.mode == "smoke" else read_performance_payload(args.performance)
    archived_track_history: dict[str, list[list[Any]]] = {}
    storage_preflight: dict[str, Any] | None = None
    if args.mode in {"full", "tracks"}:
        archived_track_history = prune_track_histories_to_hot_window(performance)
        storage_preflight = performance_storage_preflight(performance, payload, args.performance)
        print(json.dumps({"performance_storage_preflight": storage_preflight}, ensure_ascii=False))

    # Store validation and size planning deliberately happen before auth.  A
    # missing/corrupt shard can therefore never follow paid collection calls.
    client = SoundchartsClient(
        os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
        request_limit=args.max_requests,
    )
    client.authenticate()
    client.require_quota_reserve()
    print(json.dumps({"authentication": "success", "mode": client.auth_mode, "quota_remaining": client.quota_remaining}))

    if args.mode == "smoke":
        print(json.dumps(smoke_test(payload, client, min(args.history_days, 14))))
        return 0

    assert performance is not None
    priority_artist_ids, priority_artist_uuids = read_priority_artist_references(
        getattr(args, "priority_artists", Path("spotify-selection-artist-seeds.json"))
    )
    remaining = max(1, args.max_requests)
    modes = [args.mode] if args.mode != "full" else ["tracks", "artists", "playlists", "fal"]
    outcomes: dict[str, Outcome] = {}

    for mode in modes:
        if remaining <= 0:
            break
        if mode == "tracks":
            outcome = refresh_tracks(
                payload,
                performance,
                client,
                args.workers,
                remaining,
                args.history_days,
                include_performance_catalogue=args.include_performance_catalogue,
                public_catalogue=public_catalogue,
                priority_artist_ids=priority_artist_ids,
                priority_artist_uuids=priority_artist_uuids,
                public_track_catchup=getattr(args, "public_track_catchup", False),
            )
        elif mode == "artists":
            outcome = refresh_artists(
                payload,
                performance,
                client,
                args.workers,
                remaining,
                history_days=args.history_days,
                include_performance_catalogue=args.include_performance_catalogue,
            )
        elif mode == "playlists":
            outcome = refresh_playlists(
                args.playlists,
                performance,
                client,
                args.workers,
                remaining,
                dashboard_only=args.playlist_scope == "dashboard",
            )
        elif mode == "fal":
            outcome = refresh_fal(payload, client, args.workers, remaining)
        else:  # pragma: no cover - argparse constrains the value
            raise SoundchartsError(f"Unsupported mode {mode}")
        outcomes[mode] = outcome
        remaining = max(0, remaining - outcome.requests)
        print(json.dumps({mode: outcome.summary(), "remaining_budget": remaining}))
        if args.include_performance_catalogue and mode in {"tracks", "artists"}:
            incomplete = outcome.selected < outcome.available
            adaptive_track_pass = bool(
                mode == "tracks" and outcome.policy.get("selection_mode") == "adaptive_daily"
            )
            if outcome.failures > 0 or (incomplete and not adaptive_track_pass):
                # Fail before either export is written. The diagnostic is
                # deliberately aggregate-only: no request URL, entity ID,
                # credential or response body can reach the Actions log.
                print(
                    json.dumps(
                        {
                            "performance_catalogue_refresh": {
                                "mode": mode,
                                "status": "request_errors" if outcome.failures else "request_cap_incomplete",
                                "available": outcome.available,
                                "selected": outcome.selected,
                                "failures": outcome.failures,
                                "failure_diagnostics": outcome.failure_diagnostics,
                            }
                        },
                        ensure_ascii=False,
                    )
                )
                raise SoundchartsError(
                    f"Complete {mode} performance refresh failed; previous public exports were kept"
                )

    if args.mode in {"full", "tracks"} and ("tracks" not in outcomes or outcomes["tracks"].usable == 0):
        raise SoundchartsError("No usable Spotify track stream point was returned; previous public exports were kept")
    if args.mode == "artists" and outcomes.get("artists", Outcome("artists")).usable == 0:
        raise SoundchartsError("No usable Spotify artist metric was returned; previous public exports were kept")
    if args.mode == "playlists" and outcomes.get("playlists", Outcome("playlists")).usable == 0:
        raise SoundchartsError("No usable Spotify playlist metric was returned; previous public exports were kept")

    refreshed = [mode for mode, outcome in outcomes.items() if outcome.usable > 0]
    if not refreshed:
        raise SoundchartsError("No requested Soundcharts metric could be parsed; previous public exports were kept")

    now = utc_now()
    payload["generated_at"] = now
    freshness = payload.setdefault("freshness", {})
    if outcomes.get("artists") and outcomes["artists"].usable:
        freshness["artists_at"] = now
    if outcomes.get("tracks") and outcomes["tracks"].usable:
        freshness["tracks_at"] = now
    if outcomes.get("fal") and outcomes["fal"].usable:
        freshness["fal_at"] = now

    requests = sum(outcome.requests for outcome in outcomes.values())
    failures = sum(outcome.failures for outcome in outcomes.values())
    usable = sum(outcome.usable for outcome in outcomes.values())
    run_summary = {
        "mode": args.mode,
        "status": "success",
        "finished_at": now,
        "requests": requests,
        "errors": failures,
        "usable": usable,
        "refreshed": refreshed,
        "quota_remaining": client.quota_remaining,
        "auth_mode": client.auth_mode,
        "modes": {mode: outcome.summary() for mode, outcome in outcomes.items()},
    }
    if storage_preflight is not None:
        run_summary["storage_preflight"] = storage_preflight
    freshness["run"] = run_summary

    previous_performance_freshness = performance.get("freshness")
    performance["source"] = "soundcharts_daily"
    performance["generated_at"] = now
    performance["freshness"] = merge_performance_freshness(
        previous_performance_freshness,
        freshness,
        outcomes,
        now,
        include_performance_catalogue=args.include_performance_catalogue,
    )
    performance["run"] = run_summary
    maintenance_coverage = performance.setdefault("maintenance_coverage", {})
    if not isinstance(maintenance_coverage, dict):
        maintenance_coverage = {}
        performance["maintenance_coverage"] = maintenance_coverage
    for mode in ("tracks", "artists", "playlists"):
        outcome = outcomes.get(mode)
        if outcome is None:
            continue
        maintenance_coverage[mode] = {
            "observed_at": now,
            **outcome.coverage(),
            "policy": outcome.policy or None,
        }

    history_archive = write_track_history_archive(args.history_dir, archived_track_history)
    if args.mode in {"full", "tracks"}:
        run_summary["track_history_archive"] = history_archive
        performance["run"] = run_summary
        freshness["run"] = run_summary
    try:
        performance_store = write_performance_payload(args.performance, performance)
    except PerformanceStoreError as exc:
        raise SoundchartsError(str(exc)) from exc
    write_js_payload(args.soundcharts, payload, SOUNDCHARTS_PREFIX)
    run_summary["performance_store"] = {
        key: value for key, value in performance_store.items() if key != "paths"
    }

    args.history_dir.mkdir(parents=True, exist_ok=True)
    history = {
        "generated_at": now,
        "mode": args.mode,
        "requests": requests,
        "failures": failures,
        "usable": usable,
        "quota_remaining": client.quota_remaining,
        "outcomes": {mode: outcome.summary() for mode, outcome in outcomes.items()},
        "artists": outcomes.get("artists", Outcome("artists")).items,
        "tracks": outcomes.get("tracks", Outcome("tracks")).items,
        "fal": outcomes.get("fal", Outcome("fal")).items,
        "playlists": outcomes.get("playlists", Outcome("playlists")).items,
    }
    history_day = paris_today() if args.mode == "playlists" else utc_today()
    # Separate files prevent later artist/track passes from erasing the
    # playlist audit trail collected earlier on the same calendar day.
    history_path = args.history_dir / f"{history_day.isoformat()}-{args.mode}.json"
    history_path.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(run_summary))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SoundchartsError as exc:
        print(f"Soundcharts refresh failed: {exc}", file=os.sys.stderr)
        raise SystemExit(1)
