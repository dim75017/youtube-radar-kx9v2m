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
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DEFAULT_SNAPSHOT = ROOT / "Lofi_Radar_data.js"
DEFAULT_AVATARS = ROOT / "Lofi_Radar_new_channel_avatars.js"
DEFAULT_HISTORY_DIR = ROOT / "video_history"
RADAR_TIMEZONE_NAME = "Europe/Paris"
RADAR_TIMEZONE = ZoneInfo(RADAR_TIMEZONE_NAME)
DAILY_VIEW_HISTORY_START_MS = int(datetime(2026, 7, 20, tzinfo=RADAR_TIMEZONE).timestamp() * 1000)
SHEET_EXPORT = (
    "https://docs.google.com/spreadsheets/d/"
    "1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI/export?format=xlsx"
)

MIN_SECONDS = 20 * 60
MIN_ALL_VIEWS = 1_000_000
MIN_TREND_VIEWS = 500_000
MAX_TREND_AGE_MONTHS = 12
MIN_NEWS_VIEWS = 100_000
MIN_NEWS_VPM = 10_000
MAX_NEWS_AGE_MONTHS = 3
MAX_NEWS_ROWS = 1_000
SEARCH_RESULTS = int(os.environ.get("RADAR_SEARCH_RESULTS", "10"))
TRACK_WORKERS = int(os.environ.get("RADAR_TRACK_WORKERS", "12"))
SEARCH_WORKERS = int(os.environ.get("RADAR_SEARCH_WORKERS", "4"))
MIN_TRACK_RATIO = 0.90
MIN_QUERY_RATIO = 0.90
MIN_PUBLISH_TRACK_RATIO = 0.99
MIN_PUBLISH_QUERY_RATIO = 0.99
HISTORY_RETENTION_DAYS = 400
OWN_CHANNEL_HANDLES = ("@LofiGirl",)
OWN_UPLOADS_PER_CHANNEL = 50
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
CHANNEL_ID = re.compile(r"^UC[\w-]{22}$")
ISO_DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)
DEFERRED_GENRE = re.compile(r"\bphonk\b", re.I)


def is_deferred_row(row: dict) -> bool:
    """Phonk is paused in the YouTube roadmap and must not re-enter the radar."""
    fields = ("genre", "title", "kw", "disc", "niche", "concept", "scene", "style", "channel")
    return bool(DEFERRED_GENRE.search(" ".join(str(row.get(field) or "") for field in fields)))


def prune_deferred_rows(data: dict) -> set[str]:
    """Remove paused genres from public buckets and return their video IDs."""
    dropped: set[str] = set()
    for bucket in ("all", "trends", "news", "ours"):
        visible = []
        for row in list(data.get(bucket) or []):
            if is_deferred_row(row):
                video_id = str(row.get("vid") or "")
                if VIDEO_ID.match(video_id):
                    dropped.add(video_id)
                continue
            visible.append(row)
        data[bucket] = visible
    for bucket in ("recos", "roadmap", "lives"):
        data[bucket] = [
            row for row in (data.get(bucket) or [])
            if not is_deferred_row(row) and str(row.get("vid") or "") not in dropped
        ]
    for bucket in ("hist", "liveHist", "liveHourly"):
        history = data.get(bucket)
        if isinstance(history, dict):
            for video_id in dropped:
                history.pop(video_id, None)
    return dropped


def prune_news_below_view_floor(data: dict) -> int:
    """Keep daily discoveries only once they reach the public view floor."""
    rows = list(data.get("news") or [])
    data["news"] = [
        row for row in rows if int(row.get("views") or 0) >= MIN_NEWS_VIEWS
    ]
    return len(rows) - len(data["news"])


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def atomic_write_text(path: Path, content: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def parse_snapshot_text(raw: str) -> dict:
    return json.loads(re.sub(r"^window\.LOFI_DATA=", "", raw).rstrip(";\n"))


def read_snapshot(path: Path) -> dict:
    return parse_snapshot_text(path.read_text(encoding="utf-8"))


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


def owned_ydl():
    """Use a dedicated playlist reader so the official channel is not capped at 10 uploads."""
    if not hasattr(THREAD, "owned_ydl"):
        import yt_dlp

        THREAD.owned_ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": True,
                "playlistend": OWN_UPLOADS_PER_CHANNEL,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.owned_ydl


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
    channel_id = str(info.get("channel_id") or "")
    if CHANNEL_ID.match(channel_id):
        row["channelId"] = channel_id
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
                "channelId": snippet.get("channelId") or "",
            }
            if duration is not None:
                row["durH"] = duration / 3600
            out[video_id] = row
    return out


def youtube_api_payload(path: str, params: dict[str, object]) -> dict:
    """Load one YouTube Data API response without exposing the API key in logs."""
    query = urllib.parse.urlencode(params)
    with urllib.request.urlopen(
        "https://www.googleapis.com/youtube/v3/" + path + "?" + query,
        timeout=30,
    ) as response:
        return json.load(response)


def fetch_owned_upload_ids(api_key: str) -> list[str]:
    """Return recent public uploads from the official Lofi Girl channel(s)."""
    ids: list[str] = []
    for handle in OWN_CHANNEL_HANDLES:
        channels = youtube_api_payload(
            "channels",
            {"part": "contentDetails", "forHandle": handle, "key": api_key},
        ).get("items") or []
        if not channels:
            raise RuntimeError(f"Official channel lookup returned no channel for {handle}")
        uploads = ((channels[0].get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
        if not uploads:
            raise RuntimeError(f"Official channel {handle} has no uploads playlist")
        page_token = ""
        while len(ids) < OWN_UPLOADS_PER_CHANNEL:
            params: dict[str, object] = {
                "part": "contentDetails",
                "playlistId": uploads,
                "maxResults": min(50, OWN_UPLOADS_PER_CHANNEL - len(ids)),
                "key": api_key,
            }
            if page_token:
                params["pageToken"] = page_token
            payload = youtube_api_payload("playlistItems", params)
            ids.extend(
                str((item.get("contentDetails") or {}).get("videoId") or "")
                for item in payload.get("items") or []
            )
            page_token = str(payload.get("nextPageToken") or "")
            if not page_token:
                break
    return list(dict.fromkeys(video_id for video_id in ids if VIDEO_ID.match(video_id)))


def fetch_owned_api_rows(now_ms: int, api_key: str) -> dict[str, dict]:
    """Refresh recent official uploads so Analyse cannot miss a new release."""
    rows = fetch_api_rows(fetch_owned_upload_ids(api_key), now_ms, api_key)
    if not rows:
        raise RuntimeError("Official Lofi Girl upload scan returned no usable videos")
    for row in rows.values():
        row["source"] = "Official Lofi Girl daily scan"
    return rows


def fetch_owned_ydl_rows(now_ms: int) -> dict[str, dict]:
    """Fallback when the repository has no YouTube API secret configured."""
    info = owned_ydl().extract_info("https://www.youtube.com/@LofiGirl/videos", download=False) or {}
    ids = [
        str(item.get("id") or "")
        for item in info.get("entries") or []
        if item and VIDEO_ID.match(str(item.get("id") or ""))
    ]
    if not ids:
        raise RuntimeError("Official Lofi Girl channel returned no recent uploads")
    rows: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=TRACK_WORKERS) as pool:
        future_to_id = {pool.submit(fetch_one_video, video_id, now_ms): video_id for video_id in ids}
        for future in concurrent.futures.as_completed(future_to_id):
            row = future.result()
            if row:
                row["source"] = "Official Lofi Girl daily scan"
                rows[row["vid"]] = row
    if not rows:
        raise RuntimeError("Official Lofi Girl upload scan returned no usable videos")
    return rows


def query_specs(payload: dict) -> list[dict]:
    votes: dict[str, dict[str, Counter]] = defaultdict(lambda: {"genre": Counter(), "cluster": Counter()})
    for bucket in ("all", "trends", "news"):
        for row in payload.get("d", {}).get(bucket, []):
            if is_deferred_row(row):
                continue
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
            raise RuntimeError("Our Videos tab is missing from the radar Sheet")
        ids = set()
        for (value,) in workbook[title].iter_rows(min_row=2, max_col=1, values_only=True):
            video_id = str(value or "").strip()
            if VIDEO_ID.match(video_id):
                ids.add(video_id)
        return ids
    except Exception as exc:
        raise RuntimeError(
            f"Could not load the canonical Our Videos list: {type(exc).__name__}: {exc}"
        ) from exc


def tracked_ids(payload: dict) -> list[str]:
    ids = {
        str(row.get("vid"))
        for bucket in ("all", "trends", "news", "ours")
        for row in payload.get("d", {}).get(bucket, [])
        if not is_deferred_row(row)
        if VIDEO_ID.match(str(row.get("vid") or ""))
    }
    ids.update(sheet_video_ids())
    return sorted(ids)


def write_tracked_manifest(snapshot: Path, output: Path) -> dict:
    """Resolve the canonical tracked set once for every parallel scan shard."""
    payload = read_snapshot(snapshot)
    ids = tracked_ids(payload)
    if not ids:
        raise RuntimeError("Canonical tracked-video manifest is empty")
    manifest = {
        "version": 1,
        "generated_ms": utc_now_ms(),
        "snapshot_metrics_ms": int(payload.get("videoMetricsT") or 0),
        "ids": ids,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(output, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"tracked_manifest": len(ids), "output": str(output)}))
    return manifest


def read_tracked_manifest(path: Path) -> list[str]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    ids = [str(video_id) for video_id in (manifest.get("ids") or []) if VIDEO_ID.match(str(video_id or ""))]
    if int(manifest.get("version") or 0) != 1 or not ids:
        raise RuntimeError(f"Invalid or empty tracked-video manifest: {path}")
    if len(ids) != len(set(ids)):
        raise RuntimeError(f"Duplicate IDs in tracked-video manifest: {path}")
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


def run_shard(
    snapshot: Path,
    output: Path,
    shard: int,
    shards: int,
    tracked_manifest: Path | None = None,
) -> dict:
    payload = read_snapshot(snapshot)
    now_ms = utc_now_ms()
    all_tracked_ids = read_tracked_manifest(tracked_manifest) if tracked_manifest else tracked_ids(payload)
    ids = [video_id for video_id in all_tracked_ids if stable_shard(video_id, shards) == shard]
    specs = [spec for spec in query_specs(payload) if stable_shard(spec["query"], shards) == shard]

    fresh: dict[str, dict] = {}
    track_failed = 0
    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    owned_fresh: dict[str, dict] = {}
    # One deterministic shard discovers the official uploads. The merge only
    # runs after every shard passes, so a failed Lofi Girl lookup cannot
    # silently publish a snapshot that misses a new release.
    if shard == 0:
        owned_fresh = fetch_owned_api_rows(now_ms, api_key) if api_key else fetch_owned_ydl_rows(now_ms)
        fresh.update(owned_fresh)
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

    tracked_fresh_ids = sorted(set(ids) & set(fresh))

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

    track_ok = len(tracked_fresh_ids)
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
        "owned_fresh": list(owned_fresh.values()),
        "fresh": list(fresh.values()),
        "candidates": merge_keyword_rows(candidates),
    }
    atomic_write_text(output, json.dumps(artifact, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({key: artifact[key] for key in ("shard", "tracked_total", "tracked_ok", "queries_total", "queries_ok")}))
    return artifact


def update_row(existing: dict, fresh: dict, now_ms: int) -> None:
    for key in ("title", "url", "durH", "views", "pub", "channel", "chUrl", "channelId", "subs"):
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


def history_day_key(timestamp_ms: int) -> str:
    """Return the dashboard's business day for a UTC timestamp."""
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).astimezone(RADAR_TIMEZONE).date().isoformat()


def normalize_daily_points(points: list, now_ms: int) -> list[list[int]]:
    by_day: dict[object, list[int]] = {}
    for point in points or []:
        if isinstance(point, list) and len(point) >= 2:
            try:
                parsed = [int(point[0]), int(point[1])]
                day = history_day_key(parsed[0])
                if day not in by_day or parsed[0] >= by_day[day][0]:
                    by_day[day] = parsed
            except (TypeError, ValueError):
                pass
    cutoff = max(now_ms - HISTORY_RETENTION_DAYS * 86400000, DAILY_VIEW_HISTORY_START_MS)
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
            # Never erase a measured history merely because a transient source
            # stopped returning its ID. Only desired IDs receive a new point.
            points = list(current.get(video_id) or [])
            if video_id in desired_ids:
                points += list(legacy.get(video_id) or [])
            row = fresh.get(video_id)
            if video_id in desired_ids and row and isinstance(row.get("views"), (int, float)):
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


def validate_history_refresh(
    history_dir: Path,
    expected_views: dict[str, int],
    now_ms: int,
) -> int:
    """Fail the publication if a refreshed counter did not reach daily history."""
    expected_day = history_day_key(now_ms)
    missing: list[str] = []
    for video_id, views in sorted(expected_views.items()):
        path = history_dir / history_shard_name(video_id)
        try:
            points = (json.loads(path.read_text(encoding="utf-8")).get("d") or {}).get(video_id) or []
        except (OSError, ValueError, AttributeError):
            points = []
        day_points = [
            point
            for point in points
            if isinstance(point, list)
            and len(point) >= 2
            and history_day_key(int(point[0])) == expected_day
        ]
        if not day_points or int(day_points[-1][1]) != int(views):
            missing.append(video_id)
    if missing:
        sample = ", ".join(missing[:8])
        raise RuntimeError(
            f"History refresh rejected for {len(missing)}/{len(expected_views)} videos "
            f"on {expected_day} ({sample})"
        )
    return len(expected_views)


def write_avatar_overlay(payload: dict, path: Path) -> int:
    channels: dict[str, str] = {}
    aliases: dict[str, str] = {}
    for bucket in ("all", "trends", "news"):
        for row in payload.get("d", {}).get(bucket, []):
            channel_url = str(row.get("chUrl") or "")
            id_match = re.search(r"/channel/(UC[\w-]+)", channel_url)
            handle_match = re.search(r"youtube\.com/@([^/?#]+)", channel_url, re.I)
            channel_id = str(row.get("channelId") or (id_match.group(1) if id_match else ""))
            handle = "@" + handle_match.group(1) if handle_match else ""
            if CHANNEL_ID.match(channel_id):
                channels[channel_id] = f"https://unavatar.io/youtube/{channel_id}?fallback=false"
                if handle:
                    aliases[handle] = channel_id
            elif handle:
                channels[handle] = f"https://unavatar.io/youtube/{handle}?fallback=false"
    rendered = (
        "/* Channel logos refreshed automatically alongside the daily YouTube radar. */\n"
        "window.YT_CHANNEL_AVATARS=window.YT_CHANNEL_AVATARS||{channels:{},videos:{}};\n"
        "window.YT_CHANNEL_AVATARS.channels=window.YT_CHANNEL_AVATARS.channels||{};\n"
        "window.YT_CHANNEL_AVATARS.aliases=window.YT_CHANNEL_AVATARS.aliases||{};\n"
        "(()=>{const atlas=window.YT_CHANNEL_AVATARS,fresh="
        + json.dumps(channels, ensure_ascii=False, separators=(",", ":"))
        + ";Object.keys(fresh).forEach(key=>{if(!atlas.channels[key])atlas.channels[key]=fresh[key];});"
        "Object.assign(atlas.aliases,"
        + json.dumps(aliases, ensure_ascii=False, separators=(",", ":"))
        + ");})();\n"
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
    if not tracked_total or tracked_ok / tracked_total < MIN_PUBLISH_TRACK_RATIO:
        raise RuntimeError(f"Merge rejected: {tracked_ok}/{tracked_total} tracked videos refreshed")
    if not queries_total or queries_ok / queries_total < MIN_PUBLISH_QUERY_RATIO:
        raise RuntimeError(f"Merge rejected: {queries_ok}/{queries_total} keyword searches succeeded")
    tracked_fresh_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_fresh_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    if len(tracked_fresh_ids) != tracked_ok:
        raise RuntimeError(
            f"Merge rejected: {tracked_ok} refreshed counters but "
            f"{len(tracked_fresh_ids)} traceable refreshed IDs"
        )

    payload = read_snapshot(snapshot)
    data = payload.setdefault("d", {})
    prune_deferred_rows(data)
    legacy_history = data.pop("hist", {})
    now_ms = max(int(a.get("generated_ms", 0)) for a in artifacts) or utc_now_ms()
    fresh: dict[str, dict] = {}
    owned_fresh: dict[str, dict] = {}
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
        for row in artifact.get("owned_fresh") or []:
            video_id = row.get("vid")
            if VIDEO_ID.match(str(video_id or "")):
                owned_fresh[video_id] = row

    for bucket in ("all", "trends", "news"):
        for row in data.setdefault(bucket, []):
            current = fresh.get(row.get("vid"))
            if current:
                update_row(row, current, now_ms)
    removed_low_view_news = prune_news_below_view_floor(data)

    by_ours = {row.get("vid"): row for row in data.setdefault("ours", [])}
    inserted_ours = 0
    for row in owned_fresh.values():
        current = by_ours.get(row["vid"])
        if current:
            update_row(current, row, now_ms)
            current["source"] = row.get("source") or current.get("source")
        else:
            added = dict(row)
            data["ours"].append(added)
            by_ours[added["vid"]] = added
            inserted_ours += 1
    data["ours"].sort(key=lambda row: row.get("pub") or 0, reverse=True)

    by_all = {row.get("vid"): row for row in data["all"]}
    by_trends = {row.get("vid"): row for row in data["trends"]}
    by_news = {row.get("vid"): row for row in data["news"]}
    inserted_all = 0
    inserted_trends = 0
    inserted_news = 0
    for row in merge_keyword_rows(candidates):
        if is_deferred_row(row):
            continue
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
    prune_deferred_rows(data)

    desired_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    desired_ids.update(
        str(row.get("vid"))
        for bucket in ("all", "trends", "news", "ours")
        for row in data[bucket]
        if VIDEO_ID.match(str(row.get("vid") or ""))
    )
    resolved_history_dir = history_dir or snapshot.parent / "video_history"
    history_ids, history_files = update_history_shards(
        resolved_history_dir,
        desired_ids,
        fresh,
        legacy_history,
        now_ms,
    )
    expected_history_views = {
        video_id: int(fresh[video_id]["views"])
        for video_id in tracked_fresh_ids
        if video_id in fresh and isinstance(fresh[video_id].get("views"), (int, float))
    }
    if len(expected_history_views) != tracked_ok:
        raise RuntimeError(
            f"Merge rejected: {tracked_ok} refreshed videos but "
            f"{len(expected_history_views)} usable history values"
        )
    history_updated = validate_history_refresh(resolved_history_dir, expected_history_views, now_ms)
    history_day = history_day_key(now_ms)

    payload["t"] = now_ms
    payload["videoMetricsT"] = now_ms
    payload["videoMetrics"] = {
        "tracked": tracked_total,
        "updated": tracked_ok,
        "keywords": queries_total,
        "keywords_ok": queries_ok,
        "search_results": queries_raw,
        "search_results_enriched": queries_enriched,
        "history_updated": history_updated,
        "history_day": history_day,
        "day_timezone": RADAR_TIMEZONE_NAME,
        "partial": tracked_ok < tracked_total or queries_ok < queries_total,
    }
    payload["videoHistory"] = {
        "layout": "video_history/{first_char_hex}.json",
        "retention_days": HISTORY_RETENTION_DAYS,
        "updated": now_ms,
        "day": history_day,
        "day_timezone": RADAR_TIMEZONE_NAME,
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
        "history_updated": history_updated,
        "history_day": history_day,
        "all_added": inserted_all,
        "trends_added": inserted_trends,
        "news_added": inserted_news,
        "news_removed_below_view_floor": removed_low_view_news,
        "ours_added": inserted_ours,
        "avatars": avatar_count,
        "timestamp": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def snapshot_freshness(snapshot: Path, now_ms: int | None = None) -> dict:
    """Return a machine-readable daily health decision for the watchdog cron."""
    payload = read_snapshot(snapshot)
    metrics = payload.get("videoMetrics") or {}
    stamp = int(payload.get("videoMetricsT") or 0)
    now_ms = int(now_ms or utc_now_ms())
    tracked = int(metrics.get("tracked") or 0)
    updated = int(metrics.get("updated") or 0)
    keywords = int(metrics.get("keywords") or 0)
    keywords_ok = int(metrics.get("keywords_ok") or 0)
    history_updated = int(metrics.get("history_updated") or 0)
    same_day = bool(stamp) and history_day_key(stamp) == history_day_key(now_ms)
    fresh = (
        same_day
        and tracked > 0
        and updated == tracked
        and keywords > 0
        and keywords_ok == keywords
        and history_updated == updated
        and not bool(metrics.get("partial"))
        and metrics.get("history_day") == history_day_key(stamp)
        and metrics.get("day_timezone") == RADAR_TIMEZONE_NAME
    )
    return {
        "fresh": fresh,
        "today": history_day_key(now_ms),
        "snapshot_day": history_day_key(stamp) if stamp else None,
        "tracked": tracked,
        "updated": updated,
        "keywords": keywords,
        "keywords_ok": keywords_ok,
        "history_updated": history_updated,
    }


def verify_publication(
    base_url: str,
    snapshot: Path,
    history_dir: Path,
    timeout_seconds: int = 900,
    interval_seconds: int = 15,
) -> dict:
    """Wait until GitHub Pages serves both the new snapshot and its history."""
    local = read_snapshot(snapshot)
    expected = int(local.get("videoMetricsT") or 0)
    if not expected:
        raise RuntimeError("Local snapshot has no validated videoMetricsT")
    shards = sorted(history_dir.glob("*.json"))
    if not shards:
        raise RuntimeError("Local history directory has no shards")
    root = base_url.rstrip("/") + "/"
    deadline = time.monotonic() + max(timeout_seconds, 1)
    last_error = "not attempted"
    while time.monotonic() < deadline:
        cache_buster = urllib.parse.urlencode({"expected": expected, "attempt": int(time.time())})
        try:
            with urllib.request.urlopen(root + "Lofi_Radar_data.js?" + cache_buster, timeout=30) as response:
                remote = parse_snapshot_text(response.read().decode("utf-8"))
            remote_stamp = int(remote.get("videoMetricsT") or 0)
            if remote_stamp < expected:
                last_error = f"served snapshot={remote_stamp}, expected={expected}"
                time.sleep(max(interval_seconds, 1))
                continue
            stale_shards: list[str] = []
            history_stamps: list[int] = []
            for shard in shards:
                with urllib.request.urlopen(
                    root + "video_history/" + shard.name + "?" + cache_buster,
                    timeout=30,
                ) as response:
                    history_stamp = int((json.load(response) or {}).get("updated") or 0)
                history_stamps.append(history_stamp)
                if history_stamp < expected:
                    stale_shards.append(shard.name)
            if not stale_shards:
                result = {
                    "published": True,
                    "expected": expected,
                    "snapshot": remote_stamp,
                    "history_min": min(history_stamps),
                    "history_shards": len(history_stamps),
                }
                print(json.dumps(result))
                return result
            last_error = f"{len(stale_shards)}/{len(shards)} stale history shards: {', '.join(stale_shards[:8])}"
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(max(interval_seconds, 1))
    raise RuntimeError(f"GitHub Pages did not publish the validated YouTube refresh: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--avatars", type=Path, default=DEFAULT_AVATARS)
    parser.add_argument("--history-dir", type=Path, default=DEFAULT_HISTORY_DIR)
    parser.add_argument("--shard", type=int)
    parser.add_argument("--shards", type=int, default=10)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--merge-dir", type=Path)
    parser.add_argument("--tracked-manifest", type=Path)
    parser.add_argument("--write-tracked-manifest", type=Path)
    parser.add_argument("--check-fresh-today", action="store_true")
    parser.add_argument("--verify-base-url")
    parser.add_argument("--verify-timeout", type=int, default=900)
    parser.add_argument("--verify-interval", type=int, default=15)
    args = parser.parse_args()
    if args.write_tracked_manifest:
        write_tracked_manifest(args.snapshot, args.write_tracked_manifest)
        return
    if args.check_fresh_today:
        health = snapshot_freshness(args.snapshot)
        print(json.dumps(health))
        raise SystemExit(0 if health["fresh"] else 1)
    if args.verify_base_url:
        verify_publication(
            args.verify_base_url,
            args.snapshot,
            args.history_dir,
            args.verify_timeout,
            args.verify_interval,
        )
        return
    if args.merge_dir:
        merge_artifacts(args.snapshot, args.avatars, args.merge_dir, args.shards, args.history_dir)
        return
    if args.shard is None or args.output is None:
        parser.error("collector mode requires --shard and --output")
    if args.shard < 0 or args.shard >= args.shards:
        parser.error("--shard must be in [0, --shards)")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run_shard(args.snapshot, args.output, args.shard, args.shards, args.tracked_manifest)


if __name__ == "__main__":
    main()
