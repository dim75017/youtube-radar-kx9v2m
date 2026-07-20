"""Daily YouTube Radar refresh: discovery, current metrics and history.

The workflow runs this collector in deterministic shards, uploads one JSON
artifact per shard, then calls the same script with ``--merge-dir``.  Only the
merge phase writes the public snapshot, so partial scans never look fresh.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import sys
import threading
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SNAPSHOT = ROOT / "Lofi_Radar_data.js"
DEFAULT_AVATARS = ROOT / "Lofi_Radar_new_channel_avatars.js"
DEFAULT_HISTORY_DIR = ROOT / "video_history"
SHEET_EXPORT = (
    "https://docs.google.com/spreadsheets/d/"
    "1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI/export?format=xlsx"
)

MIN_SECONDS = 20 * 60
MIN_ALL_VIEWS = 1_000_000
MIN_TREND_VIEWS = 500_000
MAX_TREND_AGE_MONTHS = 12
MIN_NEWS_VIEWS = 1_000
MIN_NEWS_VPM = 10_000
MAX_NEWS_AGE_MONTHS = 3
MAX_NEWS_ROWS = 1_000
SEARCH_RESULTS = int(os.environ.get("RADAR_SEARCH_RESULTS", "10"))
TRACK_WORKERS = int(os.environ.get("RADAR_TRACK_WORKERS", "12"))
SEARCH_WORKERS = int(os.environ.get("RADAR_SEARCH_WORKERS", "4"))
MIN_TRACK_RATIO = 0.90
MIN_QUERY_RATIO = 0.90
HISTORY_RETENTION_DAYS = 400
THREAD = threading.local()

# Genre words such as "hip hop" are intentionally not rejected: this is an
# instrumental long-form radar.  We reject explicit vocal/performance signals.
VOCAL = re.compile(
    r"\b(?:lyrics?|lyric\s+video|official\s+(?:music\s+)?video|music\s+video|"
    r"vocals?|vocal\s+(?:mix|edit|version)|singer|singing|sung|rap(?:ping)?|"
    r"feat(?:uring)?\.?|ft\.?|acap+ella|a\s+cappella|live\s+performance|concert)\b",
    re.I,
)
VIDEO_ID = re.compile(r"^[\w-]{11}$")
ISO_DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def atomic_write_text(path: Path, content: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def read_snapshot(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    return json.loads(re.sub(r"^window\.LOFI_DATA=", "", raw).rstrip(";\n"))


def write_snapshot(path: Path, payload: dict) -> None:
    atomic_write_text(
        path,
        "window.LOFI_DATA="
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";",
    )


def split_keywords(value: object) -> list[str]:
    return [part.strip() for part in re.split(r"\s*;\s*|[\r\n]+", str(value or "")) if part.strip()]


def stable_shard(value: str, shards: int) -> int:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % shards


def to_ms(info: dict) -> int | None:
    stamp = info.get("timestamp") or info.get("release_timestamp")
    if isinstance(stamp, (int, float)):
        return int(stamp * 1000)
    date = str(info.get("upload_date") or "")
    try:
        return int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def parse_iso_duration(value: str | None) -> float | None:
    match = ISO_DURATION.match(value or "")
    if not match:
        return None
    parts = {key: int(number or 0) for key, number in match.groupdict().items()}
    return float(
        parts["days"] * 86400
        + parts["hours"] * 3600
        + parts["minutes"] * 60
        + parts["seconds"]
    )


def age_months(published_ms: int | None, now_ms: int) -> float | None:
    if not published_ms:
        return None
    return max((now_ms - published_ms) / 2_629_746_000, 0.1)


def cluster_for(title: str, fallback: str = "") -> str:
    text = title.lower()
    if any(word in text for word in ("work", "focus", "study", "coding", "office")):
        return "Study / focus / work"
    if any(word in text for word in ("drive", "car", "night", "drift", "gym", "gaming")):
        return "Gaming / night drive"
    return fallback or "Relaxation / meditation"


def is_instrumental(info: dict) -> bool:
    duration = info.get("duration")
    if not isinstance(duration, (int, float)) or duration < MIN_SECONDS:
        return False
    text = " ".join(str(info.get(key) or "") for key in ("title", "description", "channel", "uploader"))
    return not VOCAL.search(text)


def ydl():
    if not hasattr(THREAD, "ydl"):
        import yt_dlp

        THREAD.ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "playlistend": SEARCH_RESULTS,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "ignore_no_formats_error": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.ydl


def search_ydl():
    if not hasattr(THREAD, "search_ydl"):
        import yt_dlp

        THREAD.search_ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": True,
                "playlistend": SEARCH_RESULTS,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.search_ydl


def info_to_row(info: dict, now_ms: int, *, genre: str = "", cluster: str = "", query: str = "") -> dict | None:
    video_id = str(info.get("id") or "")
    views = info.get("view_count")
    duration = info.get("duration")
    if not VIDEO_ID.match(video_id) or not isinstance(views, (int, float)):
        return None
    published = to_ms(info)
    age = age_months(published, now_ms)
    row = {
        "title": str(info.get("title") or "").strip(),
        "vid": video_id,
        "url": info.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
        "views": int(views),
        "channel": info.get("channel") or info.get("uploader") or "Unknown channel",
        "chUrl": info.get("channel_url") or info.get("uploader_url") or "",
    }
    followers = info.get("channel_follower_count")
    if isinstance(followers, (int, float)) and followers > 0:
        row["subs"] = int(followers)
    if isinstance(duration, (int, float)):
        row["durH"] = float(duration) / 3600
    if published:
        row["pub"] = published
    if age is not None:
        row["ageM"] = age
        row["vpm"] = int(views) / age
    if genre:
        row["genre"] = genre
        row["cluster"] = cluster_for(row["title"], cluster)
    if query:
        row["kw"] = query
        row["kwCount"] = 1
        row["pattern"] = "Daily keyword scan"
        row["added"] = now_ms
    return row


def fetch_one_video(video_id: str, now_ms: int) -> dict | None:
    info = ydl().extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    return info_to_row(info or {}, now_ms)


def fetch_search(spec: dict, now_ms: int) -> tuple[list[dict], int, int]:
    # Current yt-dlp releases no longer expose ``ytsearchdate``.  Use the
    # actual YouTube "This month" search filter; known catalogue videos are
    # refreshed separately by ID, while this pass discovers new uploads.
    search_url = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote_plus(spec["query"])
        + "&sp=EgIIBA%3D%3D"
    )
    info = search_ydl().extract_info(search_url, download=False) or {}
    entries = [item for item in (info.get("entries") or []) if item]
    if not entries:
        raise RuntimeError("YouTube returned no raw search results")
    rows: list[dict] = []
    enriched = 0
    for rank, item in enumerate(entries, start=1):
        video_id = str(item.get("id") or "")
        if not VIDEO_ID.match(video_id):
            continue
        try:
            full = ydl().extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            ) or {}
        except Exception:
            continue
        if not full:
            continue
        enriched += 1
        if not is_instrumental(full):
            continue
        row = info_to_row(
            full,
            now_ms,
            genre=spec["genre"],
            cluster=spec["cluster"],
            query=spec["query"],
        )
        if row:
            row["rank"] = rank
            rows.append(row)
    if enriched / len(entries) < 0.50:
        raise RuntimeError(f"Only {enriched}/{len(entries)} search results could be enriched")
    return rows, len(entries), enriched


def fetch_api_rows(video_ids: list[str], now_ms: int, key: str) -> dict[str, dict]:
    """Fast official metrics path when a YOUTUBE_API_KEY secret is present."""
    out: dict[str, dict] = {}
    for start in range(0, len(video_ids), 50):
        batch = video_ids[start : start + 50]
        query = urllib.parse.urlencode(
            {"part": "snippet,contentDetails,statistics", "id": ",".join(batch), "key": key}
        )
        with urllib.request.urlopen(
            "https://www.googleapis.com/youtube/v3/videos?" + query, timeout=30
        ) as response:
            payload = json.load(response)
        for item in payload.get("items") or []:
            snippet = item.get("snippet") or {}
            statistics = item.get("statistics") or {}
            duration = parse_iso_duration((item.get("contentDetails") or {}).get("duration"))
            try:
                published = int(
                    datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00")).timestamp()
                    * 1000
                )
                views = int(statistics["viewCount"])
            except (KeyError, TypeError, ValueError):
                continue
            age = age_months(published, now_ms)
            video_id = item.get("id")
            row = {
                "title": snippet.get("title") or "",
                "vid": video_id,
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "views": views,
                "pub": published,
                "ageM": age,
                "vpm": views / age if age else None,
                "channel": snippet.get("channelTitle") or "Unknown channel",
                "chUrl": f"https://www.youtube.com/channel/{snippet.get('channelId', '')}",
            }
            if duration is not None:
                row["durH"] = duration / 3600
            out[video_id] = row
    return out


def query_specs(payload: dict) -> list[dict]:
    votes: dict[str, dict[str, Counter]] = defaultdict(lambda: {"genre": Counter(), "cluster": Counter()})
    for bucket in ("all", "trends", "news"):
        for row in payload.get("d", {}).get(bucket, []):
            for query in split_keywords(row.get("kw")):
                votes[query]["genre"][str(row.get("genre") or "Other")] += 1
                votes[query]["cluster"][str(row.get("cluster") or "Relaxation / meditation")] += 1
    return [
        {
            "query": query,
            "genre": data["genre"].most_common(1)[0][0],
            "cluster": data["cluster"].most_common(1)[0][0],
        }
        for query, data in sorted(votes.items())
    ]


def sheet_video_ids() -> set[str]:
    """Load the public Our Videos tab so owned videos also get daily history."""
    try:
        from openpyxl import load_workbook

        with urllib.request.urlopen(SHEET_EXPORT, timeout=45) as response:
            workbook = load_workbook(io.BytesIO(response.read()), read_only=True, data_only=True)
        title = next((name for name in workbook.sheetnames if "Our Videos" in name), None)
        if not title:
            return set()
        ids = set()
        for (value,) in workbook[title].iter_rows(min_row=2, max_col=1, values_only=True):
            video_id = str(value or "").strip()
            if VIDEO_ID.match(video_id):
                ids.add(video_id)
        return ids
    except Exception as exc:
        print(f"WARN: could not load Our Videos: {type(exc).__name__}: {exc}", file=sys.stderr)
        return set()


def tracked_ids(payload: dict) -> list[str]:
    ids = {
        str(row.get("vid"))
        for bucket in ("all", "trends", "news")
        for row in payload.get("d", {}).get(bucket, [])
        if VIDEO_ID.match(str(row.get("vid") or ""))
    }
    ids.update(sheet_video_ids())
    return sorted(ids)


def merge_keyword_rows(rows: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    keywords: dict[str, set[str]] = defaultdict(set)
    ranks: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        video_id = row["vid"]
        old = by_id.get(video_id)
        if not old or int(row.get("views") or 0) >= int(old.get("views") or 0):
            by_id[video_id] = dict(row)
        keywords[video_id].update(split_keywords(row.get("kw")))
        if isinstance(row.get("rank"), (int, float)):
            ranks[video_id].append(int(row["rank"]))
    for video_id, row in by_id.items():
        if keywords[video_id]:
            row["kw"] = "; ".join(sorted(keywords[video_id], key=str.lower))
            row["kwCount"] = len(keywords[video_id])
        if ranks[video_id]:
            row["rank"] = min(ranks[video_id])
    return list(by_id.values())


def run_shard(snapshot: Path, output: Path, shard: int, shards: int) -> dict:
    payload = read_snapshot(snapshot)
    now_ms = utc_now_ms()
    ids = [video_id for video_id in tracked_ids(payload) if stable_shard(video_id, shards) == shard]
    specs = [spec for spec in query_specs(payload) if stable_shard(spec["query"], shards) == shard]

    fresh: dict[str, dict] = {}
    track_failed = 0
    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if api_key:
        try:
            fresh.update(fetch_api_rows(ids, now_ms, api_key))
        except Exception as exc:
            raise RuntimeError(f"YouTube Data API metrics failed closed: {type(exc).__name__}: {exc}") from exc
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=TRACK_WORKERS) as pool:
            future_to_id = {pool.submit(fetch_one_video, video_id, now_ms): video_id for video_id in ids}
            for future in concurrent.futures.as_completed(future_to_id):
                video_id = future_to_id[future]
                try:
                    row = future.result()
                    if row:
                        fresh[video_id] = row
                    else:
                        track_failed += 1
                except Exception as exc:
                    track_failed += 1
                    print(f"WARN tracked {video_id}: {type(exc).__name__}: {exc}", file=sys.stderr)

    tracked_fresh_ids = sorted(fresh)

    candidates: list[dict] = []
    query_failed = 0
    query_raw = 0
    query_enriched = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as pool:
        future_to_spec = {pool.submit(fetch_search, spec, now_ms): spec for spec in specs}
        for future in concurrent.futures.as_completed(future_to_spec):
            spec = future_to_spec[future]
            try:
                rows, raw_count, enriched_count = future.result()
                query_raw += raw_count
                query_enriched += enriched_count
                candidates.extend(rows)
                for row in rows:
                    previous = fresh.get(row["vid"])
                    if not previous or int(row.get("views") or 0) >= int(previous.get("views") or 0):
                        fresh[row["vid"]] = row
            except Exception as exc:
                query_failed += 1
                print(f"WARN query {spec['query']}: {type(exc).__name__}: {exc}", file=sys.stderr)

    track_ok = len(ids) - track_failed if not api_key else len(fresh.keys() & set(ids))
    query_ok = len(specs) - query_failed
    if ids and track_ok / len(ids) < MIN_TRACK_RATIO:
        raise RuntimeError(f"Shard {shard}: only {track_ok}/{len(ids)} tracked videos refreshed")
    if specs and query_ok / len(specs) < MIN_QUERY_RATIO:
        raise RuntimeError(f"Shard {shard}: only {query_ok}/{len(specs)} keyword searches succeeded")

    artifact = {
        "version": 1,
        "generated_at": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
        "generated_ms": now_ms,
        "shard": shard,
        "shards": shards,
        "tracked_total": len(ids),
        "tracked_ok": track_ok,
        "queries_total": len(specs),
        "queries_ok": query_ok,
        "queries_raw": query_raw,
        "queries_enriched": query_enriched,
        "tracked_ids": ids,
        "tracked_fresh_ids": tracked_fresh_ids,
        "fresh": list(fresh.values()),
        "candidates": merge_keyword_rows(candidates),
    }
    atomic_write_text(output, json.dumps(artifact, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({key: artifact[key] for key in ("shard", "tracked_total", "tracked_ok", "queries_total", "queries_ok")}))
    return artifact


def update_row(existing: dict, fresh: dict, now_ms: int) -> None:
    for key in ("title", "url", "durH", "views", "pub", "channel", "chUrl", "subs"):
        if fresh.get(key) not in (None, ""):
            existing[key] = fresh[key]
    published = existing.get("pub")
    views = existing.get("views")
    age = age_months(int(published), now_ms) if isinstance(published, (int, float)) else None
    if age is not None:
        existing["ageM"] = age
        if isinstance(views, (int, float)):
            existing["vpm"] = views / age


def merge_discovery_fields(existing: dict, discovered: dict) -> None:
    keywords = set(split_keywords(existing.get("kw")))
    keywords.update(split_keywords(discovered.get("kw")))
    if keywords:
        existing["kw"] = "; ".join(sorted(keywords, key=str.lower))
        existing["kwCount"] = len(keywords)
    ranks = [
        int(value)
        for value in (existing.get("rank"), discovered.get("rank"))
        if isinstance(value, (int, float)) and value > 0
    ]
    if ranks:
        existing["rank"] = min(ranks)


def normalize_daily_points(points: list, now_ms: int) -> list[list[int]]:
    by_day: dict[object, list[int]] = {}
    for point in points or []:
        if isinstance(point, list) and len(point) >= 2:
            try:
                parsed = [int(point[0]), int(point[1])]
                day = datetime.fromtimestamp(parsed[0] / 1000, timezone.utc).date()
                if day not in by_day or parsed[0] >= by_day[day][0]:
                    by_day[day] = parsed
            except (TypeError, ValueError):
                pass
    cutoff = now_ms - HISTORY_RETENTION_DAYS * 86400000
    return sorted(
        (point for point in by_day.values() if point[0] >= cutoff),
        key=lambda point: point[0],
    )


def append_daily_point(points: list, now_ms: int, views: int) -> list[list[int]]:
    return normalize_daily_points(list(points or []) + [[now_ms, int(views)]], now_ms)


def history_shard_name(video_id: str) -> str:
    return f"{ord(video_id[0]):02x}.json"


def update_history_shards(
    history_dir: Path,
    desired_ids: set[str],
    fresh: dict[str, dict],
    legacy: dict,
    now_ms: int,
) -> tuple[int, int]:
    """Update bounded, lazy-loaded history shards outside the main snapshot."""
    history_dir.mkdir(parents=True, exist_ok=True)
    names = {history_shard_name(video_id) for video_id in desired_ids}
    names.update(history_shard_name(video_id) for video_id in legacy if VIDEO_ID.match(video_id))
    names.update(path.name for path in history_dir.glob("*.json"))
    total_ids = 0
    written = 0
    for name in sorted(names):
        path = history_dir / name
        current = {}
        if path.exists():
            try:
                current = (json.loads(path.read_text(encoding="utf-8")).get("d") or {})
            except (OSError, ValueError, AttributeError):
                current = {}
        updated: dict[str, list[list[int]]] = {}
        candidate_ids = set(current) | {
            video_id for video_id in desired_ids if history_shard_name(video_id) == name
        }
        for video_id in candidate_ids:
            if video_id not in desired_ids:
                continue
            points = list(current.get(video_id) or []) + list(legacy.get(video_id) or [])
            row = fresh.get(video_id)
            if row and isinstance(row.get("views"), (int, float)):
                points.append([now_ms, int(row["views"])])
            clean = normalize_daily_points(points, now_ms)
            if clean:
                updated[video_id] = clean
        total_ids += len(updated)
        rendered = json.dumps(
            {"version": 1, "updated": now_ms, "d": updated},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        previous = path.read_text(encoding="utf-8") if path.exists() else None
        if previous != rendered:
            atomic_write_text(path, rendered)
            written += 1
    return total_ids, written


def write_avatar_overlay(payload: dict, path: Path) -> int:
    channels: dict[str, str] = {}
    for bucket in ("all", "trends", "news"):
        for row in payload.get("d", {}).get(bucket, []):
            match = re.search(r"/channel/(UC[\w-]+)", str(row.get("chUrl") or ""))
            if match:
                channel_id = match.group(1)
                channels[channel_id] = f"https://unavatar.io/youtube/{channel_id}?fallback=false"
    rendered = (
        "/* Channel logos refreshed automatically alongside the daily YouTube radar. */\n"
        "window.YT_CHANNEL_AVATARS=window.YT_CHANNEL_AVATARS||{channels:{},videos:{}};\n"
        "window.YT_CHANNEL_AVATARS.channels=window.YT_CHANNEL_AVATARS.channels||{};\n"
        "Object.assign(window.YT_CHANNEL_AVATARS.channels,"
        + json.dumps(channels, ensure_ascii=False, separators=(",", ":"))
        + ");\n"
    )
    atomic_write_text(path, rendered)
    return len(channels)


def merge_artifacts(
    snapshot: Path,
    avatars: Path,
    merge_dir: Path,
    expected_shards: int,
    history_dir: Path | None = None,
) -> dict:
    files = sorted(merge_dir.rglob("youtube-shard-*.json"))
    artifacts = [json.loads(path.read_text(encoding="utf-8")) for path in files]
    seen_shards = {int(artifact["shard"]) for artifact in artifacts}
    if seen_shards != set(range(expected_shards)):
        raise RuntimeError(f"Expected shards 0..{expected_shards - 1}, got {sorted(seen_shards)}")
    if any(int(artifact.get("shards", -1)) != expected_shards for artifact in artifacts):
        raise RuntimeError("Shard-count mismatch in artifacts")

    tracked_total = sum(int(a.get("tracked_total", 0)) for a in artifacts)
    tracked_ok = sum(int(a.get("tracked_ok", 0)) for a in artifacts)
    queries_total = sum(int(a.get("queries_total", 0)) for a in artifacts)
    queries_ok = sum(int(a.get("queries_ok", 0)) for a in artifacts)
    queries_raw = sum(int(a.get("queries_raw", 0)) for a in artifacts)
    queries_enriched = sum(int(a.get("queries_enriched", 0)) for a in artifacts)
    if not tracked_total or tracked_ok / tracked_total < MIN_TRACK_RATIO:
        raise RuntimeError(f"Merge rejected: {tracked_ok}/{tracked_total} tracked videos refreshed")
    if not queries_total or queries_ok / queries_total < MIN_QUERY_RATIO:
        raise RuntimeError(f"Merge rejected: {queries_ok}/{queries_total} keyword searches succeeded")

    payload = read_snapshot(snapshot)
    data = payload.setdefault("d", {})
    legacy_history = data.pop("hist", {})
    now_ms = max(int(a.get("generated_ms", 0)) for a in artifacts) or utc_now_ms()
    fresh: dict[str, dict] = {}
    candidates: list[dict] = []
    for artifact in artifacts:
        candidates.extend(artifact.get("candidates") or [])
        for row in artifact.get("fresh") or []:
            video_id = row.get("vid")
            if not VIDEO_ID.match(str(video_id or "")):
                continue
            previous = fresh.get(video_id)
            if not previous or int(row.get("views") or 0) >= int(previous.get("views") or 0):
                fresh[video_id] = row

    for bucket in ("all", "trends", "news"):
        for row in data.setdefault(bucket, []):
            current = fresh.get(row.get("vid"))
            if current:
                update_row(row, current, now_ms)

    by_all = {row.get("vid"): row for row in data["all"]}
    by_trends = {row.get("vid"): row for row in data["trends"]}
    by_news = {row.get("vid"): row for row in data["news"]}
    inserted_all = 0
    inserted_trends = 0
    inserted_news = 0
    for row in merge_keyword_rows(candidates):
        views = int(row.get("views") or 0)
        age = row.get("ageM")
        for current in (by_all.get(row["vid"]), by_trends.get(row["vid"]), by_news.get(row["vid"])):
            if current:
                merge_discovery_fields(current, row)
        if views >= MIN_ALL_VIEWS and row["vid"] not in by_all:
            data["all"].append(row)
            by_all[row["vid"]] = row
            inserted_all += 1
        if (
            views >= MIN_TREND_VIEWS
            and isinstance(age, (int, float))
            and age <= MAX_TREND_AGE_MONTHS
            and row["vid"] not in by_trends
        ):
            data["trends"].append(dict(row))
            by_trends[row["vid"]] = row
            inserted_trends += 1
        if (
            views >= MIN_NEWS_VIEWS
            and isinstance(age, (int, float))
            and age <= MAX_NEWS_AGE_MONTHS
            and (row.get("vpm") or 0) >= MIN_NEWS_VPM
            and row["vid"] not in by_news
        ):
            discovered = dict(row)
            discovered["disc"] = row.get("kw") or ""
            discovered["days"] = 1
            discovered["why"] = (
                "Discovered by the daily recent-video scan; "
                f"{views:,} views at {age:.1f} months "
                f"({int(row.get('vpm') or 0):,} views/month)."
            )
            data["news"].append(discovered)
            by_news[row["vid"]] = discovered
            inserted_news += 1

    for row in data["news"]:
        if isinstance(row.get("added"), (int, float)):
            row["days"] = max(1, int((now_ms - row["added"]) / 86400000) + 1)

    data["trends"] = [
        row
        for row in data["trends"]
        if int(row.get("views") or 0) >= MIN_TREND_VIEWS
        and isinstance(row.get("ageM"), (int, float))
        and row["ageM"] <= MAX_TREND_AGE_MONTHS
    ]
    for bucket in ("all", "trends", "news"):
        data[bucket].sort(key=lambda row: row.get("vpm") or 0, reverse=True)
    if len(data["news"]) > MAX_NEWS_ROWS:
        data["news"] = sorted(
            data["news"], key=lambda row: row.get("added") or 0, reverse=True
        )[:MAX_NEWS_ROWS]

    desired_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    desired_ids.update(
        str(row.get("vid"))
        for bucket in ("all", "trends", "news")
        for row in data[bucket]
        if VIDEO_ID.match(str(row.get("vid") or ""))
    )
    history_ids, history_files = update_history_shards(
        history_dir or snapshot.parent / "video_history",
        desired_ids,
        fresh,
        legacy_history,
        now_ms,
    )

    payload["t"] = now_ms
    payload["videoMetricsT"] = now_ms
    payload["videoMetrics"] = {
        "tracked": tracked_total,
        "updated": tracked_ok,
        "keywords": queries_total,
        "keywords_ok": queries_ok,
        "search_results": queries_raw,
        "search_results_enriched": queries_enriched,
    }
    payload["videoHistory"] = {
        "layout": "video_history/{first_char_hex}.json",
        "retention_days": HISTORY_RETENTION_DAYS,
        "updated": now_ms,
    }
    avatar_count = write_avatar_overlay(payload, avatars)
    write_snapshot(snapshot, payload)
    summary = {
        "tracked": tracked_total,
        "updated": tracked_ok,
        "keywords": queries_total,
        "keywords_ok": queries_ok,
        "history_ids": history_ids,
        "history_files": history_files,
        "all_added": inserted_all,
        "trends_added": inserted_trends,
        "news_added": inserted_news,
        "avatars": avatar_count,
        "timestamp": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--avatars", type=Path, default=DEFAULT_AVATARS)
    parser.add_argument("--history-dir", type=Path, default=DEFAULT_HISTORY_DIR)
    parser.add_argument("--shard", type=int)
    parser.add_argument("--shards", type=int, default=10)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--merge-dir", type=Path)
    args = parser.parse_args()
    if args.merge_dir:
        merge_artifacts(args.snapshot, args.avatars, args.merge_dir, args.shards, args.history_dir)
        return
    if args.shard is None or args.output is None:
        parser.error("collector mode requires --shard and --output")
    if args.shard < 0 or args.shard >= args.shards:
        parser.error("--shard must be in [0, --shards)")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run_shard(args.snapshot, args.output, args.shard, args.shards)


if __name__ == "__main__":
    main()
