#!/usr/bin/env python3
"""Count live Soundcharts song totals for every mapped radar artist.

The audit reuses the production client's OAuth/API-key fallback, never prints
credentials, and stores only aggregate counts plus the largest discographies.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import threading
import time
import urllib.parse
from collections import Counter
from pathlib import Path
from typing import Any

from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsError,
    SoundchartsHttpError,
)

PREFIX = "window.SPOTIFY_SOUNDCHARTS="


def clean(value: str) -> str:
    return value.strip().strip("\ufeff\u200b").strip("\"'").strip()


def read_payload(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(PREFIX):
        raise RuntimeError("Unexpected Spotify_Soundcharts_data.js prefix")
    payload = json.loads(text[len(PREFIX) :].strip().removesuffix(";"))
    if not isinstance(payload, dict):
        raise RuntimeError("Invalid Soundcharts payload")
    return payload


def main() -> int:
    app_id = clean(os.environ.get("SOUNDCHARTS_CLIENT_ID", ""))
    api_key = clean(os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""))
    team_id = clean(os.environ.get("SOUNDCHARTS_TEAM_ID", ""))
    if not app_id or not api_key:
        raise RuntimeError("Soundcharts credentials are missing")

    client = SoundchartsClient(app_id, api_key, team_id)
    client.authenticate()

    payload = read_payload(Path("Spotify_Soundcharts_data.js"))
    schema = list(payload.get("schemas", {}).get("artists", []))
    rows = payload.get("artists", [])

    def field(row: list[Any], name: str) -> Any:
        try:
            index = schema.index(name)
        except ValueError:
            return None
        return row[index] if index < len(row) else None

    artists: list[tuple[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        uuid = str(field(row, "soundcharts_uuid") or "").strip()
        name = str(field(row, "name") or "").strip()
        if uuid and uuid not in seen:
            seen.add(uuid)
            artists.append((uuid, name))
    if not artists:
        raise RuntimeError("No mapped Soundcharts artists")

    state_lock = threading.Lock()
    rate_lock = threading.Lock()
    state: dict[str, Any] = {"requests": 0, "next_call": 0.0}

    def throttle() -> None:
        # 40 logical calls/second = 2,400/minute, below Soundcharts' advice.
        with rate_lock:
            now = time.monotonic()
            target = max(now, float(state["next_call"]))
            state["next_call"] = target + 0.025
            delay = target - now
        if delay > 0:
            time.sleep(delay)

    def request_json(path: str) -> tuple[int, Any]:
        throttle()
        with state_lock:
            state["requests"] += 1
        try:
            body = client.get(path)
        except SoundchartsHttpError as exc:
            return exc.status, None
        except SoundchartsError:
            return 599, None
        return (200, body) if body is not None else (404, None)

    favorite_probe: dict[str, Any]
    try:
        status, body = request_json("/api/v2/favorite/artists?offset=0&limit=20")
        page = body.get("page") if isinstance(body, dict) else None
        favorite_probe = {
            "status": status,
            "total": page.get("total") if isinstance(page, dict) else None,
        }
    except Exception as exc:  # pragma: no cover - diagnostic guard
        favorite_probe = {"error": type(exc).__name__}

    def count_artist(entry: tuple[str, str]) -> dict[str, Any]:
        uuid, name = entry
        query = urllib.parse.urlencode(
            {"offset": 0, "limit": 1, "sortBy": "releaseDate", "sortOrder": "desc"}
        )
        status, body = request_json(
            f"/api/v2/artist/{urllib.parse.quote(uuid)}/songs?{query}"
        )
        page = body.get("page") if isinstance(body, dict) else None
        total = page.get("total") if isinstance(page, dict) else None
        return {
            "uuid": uuid,
            "name": name,
            "status": status,
            "total": int(total) if isinstance(total, (int, float)) else 0,
        }

    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(count_artist, entry) for entry in artists]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                results.append(future.result())
            except Exception as exc:  # pragma: no cover - diagnostic guard
                results.append(
                    {"status": "exception", "error": type(exc).__name__, "total": 0}
                )
            if index % 250 == 0:
                with state_lock:
                    request_count = state["requests"]
                print(
                    json.dumps(
                        {
                            "processed": index,
                            "artists": len(artists),
                            "requests": request_count,
                            "quota_remaining": client.quota_remaining,
                        }
                    )
                )

    successful = [result for result in results if result.get("status") == 200]
    totals = [int(result.get("total") or 0) for result in successful]
    ranked = sorted(successful, key=lambda item: int(item.get("total") or 0), reverse=True)
    sorted_totals = sorted(totals)

    with state_lock:
        request_count = int(state["requests"])

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "live_soundcharts_api",
        "endpoint": "/api/v2/artist/{uuid}/songs?limit=1",
        "authentication_mode": client.auth_mode,
        "artists_queried": len(artists),
        "status_counts": dict(Counter(str(result.get("status")) for result in results)),
        "artists_successful": len(successful),
        "sum_of_page_totals": sum(totals),
        "mean_songs_per_artist": round(sum(totals) / len(totals), 2) if totals else None,
        "median_songs_per_artist": sorted_totals[len(sorted_totals) // 2] if totals else None,
        "maximum_songs_for_one_artist": max(totals) if totals else None,
        "artists_over_100": sum(total > 100 for total in totals),
        "artists_over_500": sum(total > 500 for total in totals),
        "artists_over_1000": sum(total > 1000 for total in totals),
        "largest_discographies": [
            {key: item.get(key) for key in ("uuid", "name", "total")} for item in ranked[:30]
        ],
        "requests_used": request_count,
        "quota_remaining": client.quota_remaining,
        "favorite_artist_probe": favorite_probe,
        "current_export_track_rows": len(payload.get("tracks", [])),
        "existing_export_coverage": payload.get("coverage", {}),
    }
    Path("soundcharts-live-total-count.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
