#!/usr/bin/env python3
"""Refresh Lofi Radar's licensed Soundcharts snapshots.

The collector only runs server-side in GitHub Actions.  It deliberately keeps
credentials out of the repository and preserves the previous public export if
Soundcharts is unavailable or returns no usable measurements.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


API_BASE = "https://customer.api.soundcharts.com"
TOKEN_URL = "https://account.soundcharts.com/oauth/token"
PREFIX = "window.SPOTIFY_SOUNDCHARTS="


class SoundchartsError(RuntimeError):
    """A safe, non-secret-bearing collector failure."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_js_payload(path: Path, prefix: str = PREFIX) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise SoundchartsError(f"{path} is not a {prefix[:-1]} export")
    try:
        return json.loads(text[len(prefix):].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise SoundchartsError(f"{path} contains invalid JSON") from exc


def write_js_payload(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def request_json(url: str, headers: dict[str, str], *, data: bytes | None = None, retries: int = 3) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # 404 means the source has not indexed this entity yet.  It is not
            # a collector failure and it does not justify publishing stale data.
            if exc.code == 404:
                return None
            if exc.code in {401, 403}:
                raise SoundchartsError(f"Soundcharts authentication/plan error ({exc.code})") from exc
            last_error = exc
            if exc.code != 429 and exc.code < 500:
                break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(min(8, 1.5 * (attempt + 1)))
    raise SoundchartsError("Soundcharts request failed after retries") from last_error


def access_token(client_id: str, client_secret: str) -> str:
    if not client_id or not client_secret:
        raise SoundchartsError("SOUNDCHARTS_CLIENT_ID or SOUNDCHARTS_CLIENT_SECRET is missing")
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
    token = request_json(TOKEN_URL, {"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"}, data=body)
    value = token.get("access_token") if isinstance(token, dict) else None
    if not value:
        raise SoundchartsError("Soundcharts did not return an access token")
    return str(value)


def api_get(token: str, path: str) -> Any:
    return request_json(f"{API_BASE}{path}", {"Authorization": f"Bearer {token}", "Accept": "application/json"})


def index_of(schema: list[str], field: str) -> int | None:
    try:
        return schema.index(field)
    except ValueError:
        return None


def field(row: list[Any], schema: list[str], name: str) -> Any:
    index = index_of(schema, name)
    return row[index] if index is not None and index < len(row) else None


def set_field(row: list[Any], schema: list[str], name: str, value: Any) -> None:
    index = index_of(schema, name)
    if index is None:
        return
    while len(row) <= index:
        row.append(None)
    row[index] = value


def spotify_metric(value: Any, names: set[str]) -> int | None:
    """Find a numeric Spotify metric without guessing from unrelated platforms."""
    if isinstance(value, dict):
        platform = str(value.get("platform") or value.get("platformCode") or "").lower()
        if platform == "spotify":
            for name in names:
                metric = value.get(name)
                if isinstance(metric, (int, float)):
                    return int(metric)
        spotify = value.get("spotify")
        if isinstance(spotify, dict):
            for name in names:
                metric = spotify.get(name)
                if isinstance(metric, (int, float)):
                    return int(metric)
        for nested in value.values():
            found = spotify_metric(nested, names)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = spotify_metric(nested, names)
            if found is not None:
                return found
    return None


def compact_result(entity: str, identifier: str, response: Any, metric_names: set[str]) -> dict[str, Any]:
    metric = spotify_metric(response, metric_names) if response else None
    return {"entity": entity, "id": identifier, "value": metric, "observed_at": utc_now(), "ok": response is not None}


def parallel_collect(
    token: str,
    tasks: Iterable[tuple[str, str]],
    *,
    workers: int,
    max_requests: int,
) -> tuple[list[tuple[str, Any]], int, int]:
    chosen = list(tasks)[:max_requests]
    successes = 0
    failures = 0

    def collect(task: tuple[str, str]) -> tuple[str, Any]:
        identifier, path = task
        return identifier, api_get(token, path)

    results: list[tuple[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(collect, task) for task in chosen]
        for future in concurrent.futures.as_completed(futures):
            try:
                identifier, response = future.result()
                successes += 1
                results.append((identifier, response))
            except SoundchartsError:
                failures += 1
    return results, successes, failures


def refresh_artists(payload: dict[str, Any], token: str, workers: int, budget: int) -> tuple[list[dict[str, Any]], int, int]:
    schema = list(payload.get("schemas", {}).get("artists", []))
    rows = payload.get("artists", [])
    tasks = []
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        if uuid:
            tasks.append((str(uuid), f"/api/v2/artist/{urllib.parse.quote(str(uuid))}/current/stats?period=1"))
    results, successes, failures = parallel_collect(token, tasks, workers=workers, max_requests=budget)
    by_uuid = {str(field(row, schema, "soundcharts_uuid")): row for row in rows}
    history = []
    for uuid, response in results:
        item = compact_result("artist", uuid, response, {"monthlyListeners", "monthly_listeners", "listeners"})
        row = by_uuid.get(uuid)
        if row is not None and item["value"] is not None:
            previous = field(row, schema, "monthly_listeners")
            set_field(row, schema, "monthly_listeners", item["value"])
            set_field(row, schema, "delta", item["value"] - previous if isinstance(previous, (int, float)) else None)
            set_field(row, schema, "observed_at", item["observed_at"])
        history.append(item)
    return history, successes, failures


def refresh_tracks(payload: dict[str, Any], token: str, workers: int, budget: int) -> tuple[list[dict[str, Any]], int, int]:
    schema = list(payload.get("schemas", {}).get("tracks", []))
    rows = payload.get("tracks", [])
    tasks = []
    for row in rows:
        uuid = field(row, schema, "soundcharts_uuid")
        if uuid:
            tasks.append((str(uuid), f"/api/v2/song/{urllib.parse.quote(str(uuid))}/current/stats?period=1"))
    results, successes, failures = parallel_collect(token, tasks, workers=workers, max_requests=budget)
    by_uuid = {str(field(row, schema, "soundcharts_uuid")): row for row in rows}
    history = []
    for uuid, response in results:
        item = compact_result("track", uuid, response, {"streams", "streamCount", "audience"})
        row = by_uuid.get(uuid)
        if row is not None and item["value"] is not None:
            previous = field(row, schema, "streams")
            set_field(row, schema, "streams", item["value"])
            set_field(row, schema, "delta", item["value"] - previous if isinstance(previous, (int, float)) else None)
            set_field(row, schema, "observed_at", item["observed_at"])
        history.append(item)
    return history, successes, failures


def refresh_fal(payload: dict[str, Any], token: str, workers: int, budget: int) -> tuple[list[dict[str, Any]], int, int]:
    artist_schema = list(payload.get("schemas", {}).get("artists", []))
    rows = payload.get("artists", [])
    # Only sources that already have a FAL relationship are queried: this keeps
    # the discovery graph focused and avoids turning a daily job into a blind crawl.
    tasks = []
    for row in rows:
        uuid = field(row, artist_schema, "soundcharts_uuid")
        outbound = field(row, artist_schema, "fal_out")
        if uuid and isinstance(outbound, (int, float)) and outbound > 0:
            tasks.append((str(uuid), f"/api/v2/artist/{urllib.parse.quote(str(uuid))}/related?limit=50"))
    results, successes, failures = parallel_collect(token, tasks, workers=workers, max_requests=budget)
    history = []
    for uuid, response in results:
        members = response.get("items", response.get("data", [])) if isinstance(response, dict) else response
        count = len(members) if isinstance(members, list) else None
        history.append({"entity": "fal", "id": uuid, "related_count": count, "observed_at": utc_now(), "ok": response is not None})
    return history, successes, failures


def refresh_playlists(path: Path, token: str, workers: int, budget: int) -> tuple[list[dict[str, Any]], int, int]:
    playlists = read_js_payload(path, "window.SPOTIFY_PLAYLISTS=")
    cols = list(playlists.get("cols", []))
    rows = playlists.get("rows", [])
    id_index = index_of(cols, "id")
    followers_index = index_of(cols, "followers")
    if id_index is None or followers_index is None:
        raise SoundchartsError("Spotify playlist export does not contain id/followers columns")
    tasks = []
    for row in rows:
        playlist_id = row[id_index] if id_index < len(row) else None
        if playlist_id:
            tasks.append((str(playlist_id), f"/api/v2.20/playlist/by-platform/spotify/{urllib.parse.quote(str(playlist_id))}"))
    results, successes, failures = parallel_collect(token, tasks, workers=workers, max_requests=budget)
    by_id = {str(row[id_index]): row for row in rows if id_index < len(row)}
    history = []
    for playlist_id, response in results:
        followers = spotify_metric(response, {"latestSubscriberCount", "subscriberCount", "followers"})
        history.append({"entity": "playlist", "id": playlist_id, "followers": followers, "observed_at": utc_now(), "ok": response is not None})
        row = by_id.get(playlist_id)
        if row is not None and followers is not None:
            while len(row) <= followers_index:
                row.append(None)
            row[followers_index] = followers
    if any(item["followers"] is not None for item in history):
        playlists["meta"]["snapshot_ts"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
        playlists["meta"]["generated_ts"] = playlists["meta"]["snapshot_ts"]
        text = "window.SPOTIFY_PLAYLISTS=" + json.dumps(playlists, ensure_ascii=False, separators=(",", ":")) + ";\n"
        path.write_text(text, encoding="utf-8")
    return history, successes, failures


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["full", "artists", "tracks", "fal", "playlists", "smoke"], default="full")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max-requests", type=int, default=15000)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--playlists", type=Path, default=Path("Spotify_Playlists_data.js"))
    parser.add_argument("--history-dir", type=Path, default=Path("soundcharts-history"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = access_token(os.environ.get("SOUNDCHARTS_CLIENT_ID", ""), os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""))
    if args.mode == "smoke":
        # One authenticated read proves the new credentials without altering data.
        api_get(token, "/api/v2/referential/platforms/streaming")
        print("Soundcharts authentication succeeded")
        return 0

    payload = read_js_payload(args.soundcharts)
    history: dict[str, Any] = {"generated_at": utc_now(), "mode": args.mode, "artists": [], "tracks": [], "fal": [], "playlists": [], "requests": 0, "failures": 0}
    remaining = max(1, args.max_requests)
    actions = {
        "artists": lambda: refresh_artists(payload, token, args.workers, remaining),
        "tracks": lambda: refresh_tracks(payload, token, args.workers, remaining),
        "fal": lambda: refresh_fal(payload, token, args.workers, remaining),
        "playlists": lambda: refresh_playlists(args.playlists, token, args.workers, remaining),
    }
    modes = [args.mode] if args.mode != "full" else ["artists", "tracks", "fal", "playlists"]
    refreshed = []
    for mode in modes:
        values, successes, failures = actions[mode]()
        history[mode] = values
        history["requests"] += successes + failures
        history["failures"] += failures
        remaining = max(0, remaining - successes - failures)
        if successes:
            refreshed.append(mode)
        if remaining == 0:
            break

    if not refreshed:
        raise SoundchartsError("No Soundcharts endpoint returned a usable response; previous export was kept")

    now = utc_now()
    payload["generated_at"] = now
    freshness = payload.setdefault("freshness", {})
    if "artists" in refreshed:
        freshness["artists_at"] = now
    if "tracks" in refreshed:
        freshness["tracks_at"] = now
    if "fal" in refreshed:
        freshness["fal_at"] = now
    freshness["run"] = {"mode": args.mode, "status": "success", "finished_at": now, "requests": history["requests"], "errors": history["failures"], "refreshed": refreshed}
    write_js_payload(args.soundcharts, payload)
    args.history_dir.mkdir(parents=True, exist_ok=True)
    history_path = args.history_dir / f"{dt.date.today().isoformat()}.json"
    history_path.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"refreshed": refreshed, "requests": history["requests"], "failures": history["failures"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SoundchartsError as exc:
        print(f"Soundcharts refresh failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
