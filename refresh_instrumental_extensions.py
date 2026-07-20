"""Refresh the public Radar snapshot with the new instrumental extensions.

This job is deliberately self-contained: it writes the exact file served by
GitHub Pages (publish_repo/Lofi_Radar_data.js), rather than only producing an
intermediate scan artifact.  It can therefore be scheduled safely.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SNAPSHOT = Path(os.environ.get("RADAR_SNAPSHOT", ROOT / "publish_repo" / "Lofi_Radar_data.js"))
AVATAR_SNAPSHOT = Path(os.environ.get("RADAR_AVATARS", ROOT / "Lofi_Radar_new_channel_avatars.js"))
# Keep the dependency in this project.  The old exploratory copy lives in a
# protected worktree and is not a reliable runtime dependency.
YTDLP_ROOT = ROOT / "ytdeps"
if YTDLP_ROOT.exists(): sys.path.insert(0, str(YTDLP_ROOT))
import yt_dlp  # noqa: E402

MIN_SECONDS = 20 * 60
MIN_ALL_VIEWS = 1_000_000
MIN_TREND_VIEWS = 500_000
# Explore beyond the first handful of results. The job remains bounded and
# runs hourly, while a wider query corpus builds a genuinely useful niche map.
# Cover the actual YouTube search space instead of taking only the first page.
# The strict format / vocal / title gates below keep this wider intake clean.
MAX_RESULTS = 100
THREAD = threading.local()
MAX_WORKERS = 4
# A successful refresh currently returns well over one thousand candidates.
# These deliberately conservative gates stop rate limits or extractor breakage
# from being presented to the public site as a fresh scan.
MIN_SUCCESS_RATIO = 0.80
MIN_CANDIDATES = 100

# Intentional strictness: do not let lyrics, rap or vocal performances leak
# into a catalogue whose promise is long-form instrumental listening.
VOCAL = re.compile(
    r"\b(?:lyrics?|lyric\s+video|official\s+(?:music\s+)?video|music\s+video|"
    r"vocals?|vocal\s+(?:mix|edit|version)|singer|singing|sung|rap(?:ping)?|"
    r"hip[ -]?hop|feat(?:uring)?\.?|ft\.?|acap+ella|a\s+cappella|"
    r"live\s+performance|concert|cover)\b", re.I,
)

QUERIES = {
    "Chill house": [
        "chill house", "chill house music", "chill house mix",
        "lofi house instrumental mix", "chill house instrumental mix",
        "chill house mix no vocals", "deep house instrumental mix",
        "deep house for work instrumental", "deep house for study instrumental",
        "lofi deep house instrumental", "ambient house instrumental mix",
        "ambient house mix no vocals", "organic house instrumental mix",
        "organic house mix instrumental", "downtempo house instrumental mix",
        "melodic house instrumental mix", "balearic house instrumental mix",
        "house music for focus instrumental", "house music for coding instrumental",
    ],
    "Phonk": [
        "phonk", "phonk music", "phonk mix",
        "phonk instrumental mix", "phonk mix no vocals",
        "chill phonk instrumental mix", "chill phonk no vocals mix",
        "lofi phonk instrumental", "ambient phonk instrumental mix",
        "atmospheric phonk instrumental", "wave phonk instrumental mix",
        "drift phonk instrumental mix", "phonk for driving instrumental",
        "phonk for gaming instrumental", "phonk for gym instrumental",
        "dark phonk instrumental mix", "phonk background music instrumental",
    ],
    "Drum & Bass": [
        "drum and bass", "drum and bass music", "dnb", "dnb music",
        "drum and bass instrumental mix", "dnb instrumental mix",
        "liquid drum and bass instrumental mix", "liquid dnb instrumental mix",
        "liquid drum and bass mix no vocals", "atmospheric drum and bass instrumental",
        "atmospheric dnb instrumental mix", "ambient drum and bass instrumental",
        "ambient dnb instrumental mix", "intelligent drum and bass mix",
        "intelligent dnb instrumental", "jazzy liquid dnb instrumental",
        "liquid jungle instrumental mix", "lofi drum and bass instrumental mix",
        "drum and bass for work instrumental", "dnb for study instrumental",
    ],
}

GENRE_TITLE_MARKERS = {
    "Chill house": re.compile(r"\b(?:lo[- ]?fi|chill|deep|ambient|organic|downtempo|melodic|balearic)\s+house\b", re.I),
    "Phonk": re.compile(r"\bphonk\b", re.I),
    "Drum & Bass": re.compile(r"\b(?:drum\s*(?:and|&|n)\s*bass|dnb|d&b|liquid\s+(?:dnb|drum\s*(?:and|&|n)\s*bass)|intelligent\s+(?:dnb|drum\s*(?:and|&|n)\s*bass)|jungle\s+(?:dnb|drum\s*(?:and|&|n)\s*bass))\b", re.I),
}


def ydl() -> yt_dlp.YoutubeDL:
    if not hasattr(THREAD, "client"):
        THREAD.client = yt_dlp.YoutubeDL({
            "quiet": True, "no_warnings": True, "skip_download": True,
            # Flat search results omit duration and view counts, which makes a
            # strict long-form / instrumental gate impossible.
            "playlistend": MAX_RESULTS,
            "socket_timeout": 10, "retries": 1, "extractor_retries": 1,
            "ignoreerrors": True, "ignore_no_formats_error": True,
            "cachedir": False, "geo_bypass_country": "FR",
            "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
        })
    return THREAD.client


def ms_from_item(item: dict) -> int | None:
    stamp = item.get("timestamp")
    if isinstance(stamp, (int, float)):
        return int(stamp * 1000)
    date = str(item.get("upload_date") or "")
    try:
        return int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def is_instrumental(item: dict) -> bool:
    duration = item.get("duration")
    if not isinstance(duration, (int, float)) or duration < MIN_SECONDS:
        return False
    text = " ".join(str(item.get(k) or "") for k in ("title", "description", "channel", "uploader"))
    return not VOCAL.search(text)


def is_genre_match(item: dict, genre: str) -> bool:
    """Require an explicit genre signal in the video's own title.

    Search terms alone are not evidence: that was the source of ambient
    videos being shown as Drum & Bass in the dashboard.
    """
    return bool(GENRE_TITLE_MARKERS[genre].search(str(item.get("title") or "")))


def cluster_for(title: str) -> str:
    text = title.lower()
    if any(x in text for x in ("work", "focus", "study", "coding", "office")):
        return "Study / focus / work"
    if any(x in text for x in ("drive", "car", "night", "drift", "gym", "gaming")):
        return "Gaming / night drive"
    return "Relaxation / meditation"


def scan(genre: str, query: str) -> list[dict]:
    info = ydl().extract_info(f"ytsearch{MAX_RESULTS}:{query}", download=False) or {}
    out = []
    for item in info.get("entries") or []:
        if not item or not item.get("id") or not is_instrumental(item) or not is_genre_match(item, genre):
            continue
        pub = ms_from_item(item)
        views = int(item.get("view_count") or 0)
        if not pub or not views:
            continue
        age_m = max((datetime.now(timezone.utc).timestamp() * 1000 - pub) / 2_629_746_000, 0.1)
        out.append({
            "title": str(item.get("title") or "").strip(), "vid": item["id"],
            "url": item.get("webpage_url") or f"https://www.youtube.com/watch?v={item['id']}",
            "durH": float(item["duration"]) / 3600, "views": views,
            "vpm": views / age_m, "pub": pub, "ageM": age_m, "genre": genre,
            "cluster": cluster_for(str(item.get("title") or "")),
            "channel": item.get("channel") or item.get("uploader") or "Unknown channel",
            "chUrl": item.get("channel_url") or item.get("uploader_url") or "",
            "subs": int(item.get("channel_follower_count") or 0), "kw": query,
            "kwCount": 1, "pattern": "Instrumental extension scan",
        })
    return out


def read_snapshot() -> dict:
    raw = SNAPSHOT.read_text(encoding="utf-8")
    return json.loads(re.sub(r"^window\.LOFI_DATA=", "", raw).rstrip(";\n"))


def merge(rows: list[dict], candidates: list[dict]) -> int:
    by_id = {r.get("vid"): r for r in rows}
    inserted = 0
    for row in candidates:
        old = by_id.get(row["vid"])
        if old:
            old["kw"] = "; ".join(sorted(set((str(old.get("kw") or "").split("; ")) + [row["kw"]])))
            old["kwCount"] = len(old["kw"].split("; "))
            continue
        rows.append(row); by_id[row["vid"]] = row; inserted += 1
    rows.sort(key=lambda r: r.get("vpm") or 0, reverse=True)
    return inserted


def write_avatar_overlay(payload: dict, active: list[str]) -> int:
    """Keep actual channel images in sync with the public extension snapshot."""
    channels: dict[str, str] = {}
    for bucket in ("all", "trends"):
        for row in payload["d"].get(bucket, []):
            if row.get("genre") not in active:
                continue
            match = re.search(r"/channel/(UC[\\w-]+)", str(row.get("chUrl") or ""))
            if match:
                channel_id = match.group(1)
                channels[channel_id] = f"https://unavatar.io/youtube/{channel_id}?fallback=false"
    rendered = (
        "/* Channel logos refreshed automatically alongside the instrumental radar. */\\n"
        "window.YT_CHANNEL_AVATARS=window.YT_CHANNEL_AVATARS||{channels:{},videos:{}};\\n"
        "window.YT_CHANNEL_AVATARS.channels=window.YT_CHANNEL_AVATARS.channels||{};\\n"
        "Object.assign(window.YT_CHANNEL_AVATARS.channels," +
        json.dumps(channels, ensure_ascii=False, separators=(",", ":")) + ");\\n"
    )
    atomic_write_text(AVATAR_SNAPSHOT, rendered)
    return len(channels)


def atomic_write_text(path: Path, content: str) -> None:
    """Replace generated files only after their full content is on disk."""
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--genre", choices=list(QUERIES), action="append", help="Refresh only one genre")
    args = parser.parse_args()
    active = args.genre or list(QUERIES)
    payload = read_snapshot()
    d = payload["d"]
    candidates: list[dict] = []
    jobs = [(genre, query) for genre in active for query in QUERIES[genre]]
    successful_queries = 0
    failed_queries = 0
    # Independent search pages are safe to enrich concurrently. Four workers
    # keeps the hourly job practical without hammering YouTube.
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        future_to_job = {}
        for genre, query in jobs:
            print(f"Scanning {genre}: {query}", flush=True)
            future_to_job[pool.submit(scan, genre, query)] = (genre, query)
        for future in concurrent.futures.as_completed(future_to_job):
            _genre, query = future_to_job[future]
            try:
                candidates.extend(future.result())
                successful_queries += 1
            except Exception as exc:
                failed_queries += 1
                print(f"WARN {query}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    success_ratio = successful_queries / len(jobs) if jobs else 0
    if success_ratio < MIN_SUCCESS_RATIO or len(candidates) < MIN_CANDIDATES:
        raise RuntimeError(
            "Refresh rejected: "
            f"{successful_queries}/{len(jobs)} queries succeeded "
            f"({success_ratio:.0%}), {failed_queries} failed, "
            f"and only {len(candidates)} candidates passed the strict gates"
        )
    all_rows = [r for r in candidates if r["views"] >= MIN_ALL_VIEWS]
    trend_rows = [r for r in candidates if r["views"] >= MIN_TREND_VIEWS and r["ageM"] <= 12]
    inserted_all = merge(d.setdefault("all", []), all_rows)
    inserted_trends = merge(d.setdefault("trends", []), trend_rows)
    avatar_count = write_avatar_overlay(payload, active)
    payload["t"] = int(datetime.now(timezone.utc).timestamp() * 1000)
    atomic_write_text(
        SNAPSHOT,
        "window.LOFI_DATA=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";",
    )
    print(json.dumps({"genres": active, "queries_ok": successful_queries, "queries_failed": failed_queries, "candidates": len(candidates), "all_added": inserted_all, "trends_added": inserted_trends, "avatars": avatar_count, "snapshot": str(SNAPSHOT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
