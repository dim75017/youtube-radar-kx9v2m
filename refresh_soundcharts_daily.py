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
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


API_BASE = "https://customer.api.soundcharts.com"
TOKEN_URL = "https://account.soundcharts.com/oauth/token"
SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
PLAYLISTS_PREFIX = "window.SPOTIFY_PLAYLISTS="
AUTH_PROBE = "/api/v2/referential/platforms/streaming"
MIN_SERVER_QUOTA_RESERVE = 500_000


class SoundchartsError(RuntimeError):
    """A safe, non-secret-bearing collector failure."""


class SoundchartsHttpError(SoundchartsError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(f"Soundcharts HTTP error ({status})")


class SoundchartsQuotaReserveError(SoundchartsError):
    """Raised before a request could consume the protected server reserve."""


class SoundchartsRequestLimitError(SoundchartsError):
    """Raised before a request could exceed this collector's attempt cap."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


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
    path.write_text(prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def read_performance_payload(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "source": "soundcharts_daily",
            "generated_at": None,
            "tracks": {},
            "artists": {},
            "playlists": {},
        }
    payload = read_js_payload(path, PERFORMANCE_PREFIX)
    payload.setdefault("source", "soundcharts_daily")
    payload.setdefault("tracks", {})
    payload.setdefault("artists", {})
    payload.setdefault("playlists", {})
    return payload


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
    retries: int = 3,
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
            if exc.code == 404:
                return None, dict(exc.headers)
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

    def authenticate(self) -> None:
        direct = {"x-app-id": self.app_id, "x-api-key": self.api_key, "Accept": "application/json"}
        try:
            _, response_headers = request_json(API_BASE + AUTH_PROBE, direct, retries=1)
            self.headers = direct
            self.auth_mode = "api_headers"
            self._record_headers(response_headers, reset=True)
            return
        except SoundchartsHttpError:
            pass

        token = access_token(self.app_id, self.api_key, self.team_id)
        bearer = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        _, response_headers = request_json(API_BASE + AUTH_PROBE, bearer, retries=1)
        self.headers = bearer
        self.auth_mode = "oauth_bearer"
        self._record_headers(response_headers, reset=True)

    def get(self, path: str) -> Any:
        if not self.headers:
            raise SoundchartsError("Soundcharts client is not authenticated")
        payload, response_headers = request_json(
            API_BASE + path,
            self.headers,
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


def _identifier_matches(identifier: str, spotify_id: str) -> bool:
    if not spotify_id:
        return False
    identifier = identifier.strip()
    return identifier == spotify_id or identifier.endswith(spotify_id)


def extract_song_audience_points(response: Any, spotify_id: str = "") -> list[list[Any]]:
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
        if chosen is None and len(numeric) == 1:
            chosen = numeric[0]
        if chosen is None:
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
    usable: int = 0
    available: int = 0
    selected: int = 0

    def summary(self) -> dict[str, Any]:
        return {
            "requests": self.requests,
            "failures": self.failures,
            "usable": self.usable,
            "available": self.available,
            "selected": self.selected,
        }


def parallel_collect(
    client: SoundchartsClient,
    tasks: Iterable[dict[str, Any]],
    *,
    workers: int,
    max_requests: int,
) -> tuple[list[tuple[dict[str, Any], Any]], int, int, int, int]:
    all_tasks = list(tasks)
    selected = all_tasks[: max(0, max_requests)]
    results: list[tuple[dict[str, Any], Any]] = []
    failures = 0

    def collect(task: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        return task, client.get(str(task["path"]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(collect, task) for task in selected]
        stop_error: SoundchartsError | None = None
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except (SoundchartsQuotaReserveError, SoundchartsRequestLimitError) as exc:
                stop_error = exc
                failures += 1
            except SoundchartsError:
                failures += 1
    if stop_error is not None:
        raise stop_error
    return results, len(selected), failures, len(all_tasks), len(selected)


def refresh_tracks(
    payload: dict[str, Any],
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
    history_days: int,
) -> Outcome:
    schema, rows = ensure_schema_fields(
        payload,
        "tracks",
        ["streams", "delta", "observed_at", "source_date", "previous_source_date"],
    )
    period_days = min(90, max(65, history_days))
    start = (utc_today() - dt.timedelta(days=period_days - 1)).isoformat()
    end = utc_today().isoformat()
    tasks = []
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        if not uuid:
            continue
        spotify_id = str(field(row, schema, "spotify_id") or "")
        query = urllib.parse.urlencode({"startDate": start, "endDate": end, "limit": max(100, history_days + 5)})
        tasks.append(
            {
                "row": row,
                "uuid": str(uuid),
                "spotify_id": spotify_id,
                "path": f"/api/v2/song/{urllib.parse.quote(str(uuid))}/audience/spotify?{query}",
            }
        )

    outcome = Outcome("tracks")
    results, outcome.requests, outcome.failures, outcome.available, outcome.selected = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    store = performance.setdefault("tracks", {})
    now = utc_now()
    for task, response in results:
        points = extract_song_audience_points(response, task["spotify_id"])
        if not points:
            outcome.items.append({"entity": "track", "id": task["uuid"], "ok": response is not None, "usable": False})
            continue
        row = task["row"]
        latest_day, latest_value = points[-1]
        by_day = {day: value for day, value in points}
        prior_day = previous_day(latest_day)
        prior_value = by_day.get(prior_day)
        delta = latest_value - prior_value if prior_value is not None else None
        key = task["spotify_id"] or f"soundcharts:{task['uuid']}"
        entry = store.setdefault(key, {})
        entry["history"] = merge_history(entry.get("history"), points)
        entry["soundcharts_uuid"] = task["uuid"]
        entry["observed_at"] = now
        entry["cadence_days"] = 1
        entry["source"] = "soundcharts_song_audience_spotify"

        set_field(row, schema, "streams", latest_value)
        set_field(row, schema, "delta", delta)
        set_field(row, schema, "source_date", latest_day)
        set_field(row, schema, "previous_source_date", prior_day if prior_value is not None else None)
        set_field(row, schema, "observed_at", now)
        outcome.usable += 1
        outcome.items.append(
            {
                "entity": "track",
                "id": key,
                "value": latest_value,
                "date": latest_day,
                "delta_24h": delta,
                "points": len(points),
                "ok": True,
                "usable": True,
            }
        )
    return outcome


def refresh_artists(
    payload: dict[str, Any],
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
) -> Outcome:
    schema, rows = ensure_schema_fields(payload, "artists", ["monthly_listeners", "delta", "observed_at"])
    tasks = []
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        if not uuid:
            continue
        tasks.append(
            {
                "row": row,
                "uuid": str(uuid),
                "spotify_id": str(field(row, schema, "spotify_id") or ""),
                "name": str(field(row, schema, "name") or ""),
                "path": f"/api/v2/artist/{urllib.parse.quote(str(uuid))}/current/stats",
            }
        )

    outcome = Outcome("artists")
    results, outcome.requests, outcome.failures, outcome.available, outcome.selected = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    store = performance.setdefault("artists", {})
    now = utc_now()
    for task, response in results:
        metric = extract_artist_spotify_metric(response)
        if not metric:
            outcome.items.append({"entity": "artist", "id": task["uuid"], "ok": response is not None, "usable": False})
            continue
        row = task["row"]
        value = int(metric["value"])
        previous = field(row, schema, "monthly_listeners")
        delta = value - int(previous) if isinstance(previous, (int, float)) else metric.get("evolution")
        day = metric.get("date") or utc_today().isoformat()
        key = task["spotify_id"] or task["name"] or task["uuid"]
        entry = store.setdefault(key, {})
        merged = merge_history(entry.get("history") or entry.get("monthly_listeners_history"), [[day, value]])
        entry["history"] = merged
        entry["monthly_listeners_history"] = merged
        entry["soundcharts_uuid"] = task["uuid"]
        entry["observed_at"] = now
        entry["source"] = "soundcharts_artist_current_stats"

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
                "ok": True,
                "usable": True,
            }
        )
    return outcome


def refresh_playlists(
    path: Path,
    performance: dict[str, Any],
    client: SoundchartsClient,
    workers: int,
    budget: int,
) -> Outcome:
    playlists = read_js_payload(path, PLAYLISTS_PREFIX)
    columns = list(playlists.get("cols", []))
    rows = playlists.get("rows", [])
    id_index = index_of(columns, "id")
    followers_index = index_of(columns, "followers")
    if id_index is None or followers_index is None:
        raise SoundchartsError("Spotify playlist export does not contain id/followers columns")

    tasks = []
    for row in rows:
        playlist_id = row[id_index] if id_index < len(row) else None
        if playlist_id:
            tasks.append(
                {
                    "row": row,
                    "id": str(playlist_id),
                    "path": f"/api/v2.20/playlist/by-platform/spotify/{urllib.parse.quote(str(playlist_id))}",
                }
            )

    outcome = Outcome("playlists")
    results, outcome.requests, outcome.failures, outcome.available, outcome.selected = parallel_collect(
        client, tasks, workers=workers, max_requests=budget
    )
    store = performance.setdefault("playlists", {})
    day = utc_today().isoformat()
    now = utc_now()
    for task, response in results:
        followers = first_numeric_named(response, {"latestSubscriberCount", "subscriberCount", "followers"})
        if followers is None:
            outcome.items.append({"entity": "playlist", "id": task["id"], "ok": response is not None, "usable": False})
            continue
        row = task["row"]
        while len(row) <= followers_index:
            row.append(None)
        row[followers_index] = followers
        entry = store.setdefault(task["id"], {})
        entry["history"] = merge_history(entry.get("history"), [[day, followers]])
        entry["observed_at"] = now
        entry["source"] = "soundcharts_playlist_spotify"
        outcome.usable += 1
        outcome.items.append(
            {
                "entity": "playlist",
                "id": task["id"],
                "followers": followers,
                "date": day,
                "ok": True,
                "usable": True,
            }
        )

    if outcome.usable:
        meta = playlists.setdefault("meta", {})
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
        meta["snapshot_ts"] = stamp
        meta["generated_ts"] = stamp
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
    results, outcome.requests, outcome.failures, outcome.available, outcome.selected = parallel_collect(
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


def smoke_test(payload: dict[str, Any], client: SoundchartsClient, history_days: int) -> dict[str, Any]:
    artist_schema = list(payload.get("schemas", {}).get("artists", []))
    track_schema = list(payload.get("schemas", {}).get("tracks", []))

    artist_metric = None
    artist_requests = 0
    for row in payload.get("artists", [])[:50]:
        uuid = field(row, artist_schema, "soundcharts_uuid")
        if not uuid:
            continue
        artist_requests += 1
        response = client.get(f"/api/v2/artist/{urllib.parse.quote(str(uuid))}/current/stats")
        artist_metric = extract_artist_spotify_metric(response)
        if artist_metric or artist_requests >= 8:
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

    if not artist_metric:
        raise SoundchartsError("Authentication succeeded but no Spotify artist metric could be parsed")
    if not track_points:
        raise SoundchartsError("Authentication succeeded but no Spotify song audience point could be parsed")
    return {
        "status": "success",
        "auth_mode": client.auth_mode,
        "artist_requests": artist_requests,
        "track_requests": track_requests,
        "artist_metric_date": artist_metric.get("date"),
        "track_points": len(track_points),
        "latest_track_date": track_points[-1][0],
        "quota_remaining": client.quota_remaining,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["full", "artists", "tracks", "fal", "playlists", "smoke"], default="full")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--max-requests", type=int, default=100000)
    parser.add_argument("--history-days", type=int, default=95)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument("--playlists", type=Path, default=Path("Spotify_Playlists_data.js"))
    parser.add_argument("--history-dir", type=Path, default=Path("soundcharts-history"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = SoundchartsClient(
        os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
        request_limit=args.max_requests,
    )
    client.authenticate()
    client.require_quota_reserve()
    print(json.dumps({"authentication": "success", "mode": client.auth_mode, "quota_remaining": client.quota_remaining}))

    payload = read_js_payload(args.soundcharts)
    if args.mode == "smoke":
        print(json.dumps(smoke_test(payload, client, min(args.history_days, 14))))
        return 0

    performance = read_performance_payload(args.performance)
    remaining = max(1, args.max_requests)
    modes = [args.mode] if args.mode != "full" else ["tracks", "artists", "playlists", "fal"]
    outcomes: dict[str, Outcome] = {}

    for mode in modes:
        if remaining <= 0:
            break
        if mode == "tracks":
            outcome = refresh_tracks(payload, performance, client, args.workers, remaining, args.history_days)
        elif mode == "artists":
            outcome = refresh_artists(payload, performance, client, args.workers, remaining)
        elif mode == "playlists":
            outcome = refresh_playlists(args.playlists, performance, client, args.workers, remaining)
        elif mode == "fal":
            outcome = refresh_fal(payload, client, args.workers, remaining)
        else:  # pragma: no cover - argparse constrains the value
            raise SoundchartsError(f"Unsupported mode {mode}")
        outcomes[mode] = outcome
        remaining = max(0, remaining - outcome.requests)
        print(json.dumps({mode: outcome.summary(), "remaining_budget": remaining}))

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
    freshness["run"] = run_summary

    performance["source"] = "soundcharts_daily"
    performance["generated_at"] = now
    performance["freshness"] = {
        "tracks_at": freshness.get("tracks_at"),
        "artists_at": freshness.get("artists_at"),
        "playlists_at": now if outcomes.get("playlists") and outcomes["playlists"].usable else None,
    }
    performance["run"] = run_summary

    write_js_payload(args.soundcharts, payload, SOUNDCHARTS_PREFIX)
    write_js_payload(args.performance, performance, PERFORMANCE_PREFIX)

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
    history_path = args.history_dir / f"{utc_today().isoformat()}.json"
    history_path.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(run_summary))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SoundchartsError as exc:
        print(f"Soundcharts refresh failed: {exc}", file=os.sys.stderr)
        raise SystemExit(1)
