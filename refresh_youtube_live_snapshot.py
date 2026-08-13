#!/usr/bin/env python3
"""Build the small, first-paint livestream snapshot used by the dashboard."""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import openpyxl
from openpyxl.utils.datetime import from_excel


SHEET_ID = "1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI"
XLSX_URL = (
    "https://docs.google.com/spreadsheets/d/"
    + SHEET_ID
    + "/export?format=xlsx"
)
VIDEO_ID = re.compile(r"^[\w-]{11}$")
TITLE_SCAN_SUFFIX = re.compile(
    r"\s*\d{4}-\d{2}-\d{2}[ T]?\d{2}:\d{2}(?::\d{2})?\s*$"
)
DAY_MS = 86_400_000
OFFICIAL_CHANNEL_ID = "UCSJ4gkVC6NrvII8umztf0Ow"
OFFICIAL_STREAMS_URL = "https://www.youtube.com/@LofiGirl/streams"
OFFICIAL_UPLOADS_URL = "https://www.youtube.com/playlist?list=UUSJ4gkVC6NrvII8umztf0Ow"
OFFICIAL_LISTING_LIMIT = 100


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def to_ms(value: object) -> int | None:
    if value is None or value == "":
        return None
    parsed: datetime
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime(value.year, value.month, value.day)
    elif isinstance(value, (int, float)):
        parsed = from_excel(value)
    else:
        raw = str(value).strip()
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def sheet_by_name(workbook, fragment: str):
    needle = fragment.casefold()
    for name in workbook.sheetnames:
        if needle in name.casefold():
            return workbook[name]
    raise RuntimeError(f"Sheet not found: {fragment}")


def clean_text(value: object) -> str:
    return "" if value is None else str(value).strip()


def positive_number(value: object, *, allow_zero: bool = False) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0 or (parsed == 0 and not allow_zero):
        return None
    return parsed


def official_live_row(info: dict, observed_ms: int) -> tuple[dict, tuple[int, int]]:
    """Project one verified active official stream without inventing counters."""
    video_id = clean_text(info.get("id"))
    if not VIDEO_ID.fullmatch(video_id):
        raise RuntimeError("Official stream response has no exact video ID")
    if clean_text(info.get("channel_id")) != OFFICIAL_CHANNEL_ID:
        raise RuntimeError(f"Official stream {video_id} belongs to an unexpected channel")
    if clean_text(info.get("availability")) != "public":
        raise RuntimeError(f"Official stream {video_id} is not verifiably public")
    if info.get("is_live") is not True or clean_text(info.get("live_status")) != "is_live":
        raise RuntimeError(f"Official stream {video_id} is not verifiably live")
    viewers = positive_number(info.get("concurrent_view_count"), allow_zero=True)
    if viewers is None:
        raise RuntimeError(f"Official stream {video_id} has no factual concurrent viewer count")
    title = TITLE_SCAN_SUFFIX.sub("", clean_text(info.get("title")))
    if not title:
        raise RuntimeError(f"Official stream {video_id} has no title")
    started_seconds = positive_number(
        info.get("release_timestamp") or info.get("timestamp")
    )
    if started_seconds is None:
        raise RuntimeError(f"Official stream {video_id} has no factual start timestamp")
    row = {
        "vid": video_id,
        "channel": "Lofi Girl",
        "channelId": OFFICIAL_CHANNEL_ID,
        "chUrl": f"https://www.youtube.com/channel/{OFFICIAL_CHANNEL_ID}",
        "title": title,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "started": int(started_seconds * 1000),
        "disc": "official Lofi Girl /streams",
        "audiences": ["youtube"],
        "liveStatus": "is_live",
        "source": "Official Lofi Girl streams scan",
    }
    return row, (int(observed_ms), int(viewers))


def discover_official_live_streams(
    observed_ms: int | None = None,
    *,
    flat_reader=None,
    detail_reader=None,
    previous_active: dict[str, dict] | None = None,
) -> dict:
    """Discover every currently-live radio exposed by the official streams tab."""
    observed_ms = int(observed_ms or utc_now_ms())
    if flat_reader is None or detail_reader is None:
        import yt_dlp
    if flat_reader is None:
        flat_reader = yt_dlp.YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": True,
            "playlistend": OFFICIAL_LISTING_LIMIT,
            "socket_timeout": 30,
            "retries": 2,
            "extractor_retries": 2,
            "ignoreerrors": False,
            "cachedir": False,
        })
    if detail_reader is None:
        detail_reader = yt_dlp.YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "socket_timeout": 30,
            "retries": 2,
            "extractor_retries": 2,
            "ignoreerrors": False,
            "cachedir": False,
        })
    streams_listing = flat_reader.extract_info(OFFICIAL_STREAMS_URL, download=False) or {}
    uploads_listing = flat_reader.extract_info(OFFICIAL_UPLOADS_URL, download=False) or {}

    def listing_ids(listing: dict, *, include_unknown: bool = False) -> list[str]:
        allowed = {"is_live", "is_upcoming"}
        if include_unknown:
            allowed.add("")
        return list(dict.fromkeys(
            clean_text(entry.get("id"))
            for entry in (listing.get("entries") or [])
            if entry
            and VIDEO_ID.fullmatch(clean_text(entry.get("id")))
            and clean_text(entry.get("live_status")) in allowed
        ))

    # Every valid row on /streams is hydrated. Flat live_status can disappear
    # during YouTube extractor drift; trusting it alone would silently hide a
    # newly-started radio. The uploads lane stays narrow and only contributes
    # entries explicitly marked live.
    streams_candidate_ids = listing_ids(streams_listing, include_unknown=True)
    streams_flat_active_ids = [
        video_id
        for video_id in listing_ids(streams_listing)
        if video_id in set(streams_candidate_ids)
    ]
    streams_unknown_ids = list(dict.fromkeys(
        clean_text(entry.get("id"))
        for entry in (streams_listing.get("entries") or [])
        if entry
        and VIDEO_ID.fullmatch(clean_text(entry.get("id")))
        and clean_text(entry.get("live_status")) == ""
    ))
    uploads_active_ids = listing_ids(uploads_listing)
    candidate_ids = list(dict.fromkeys(
        streams_flat_active_ids + streams_unknown_ids + uploads_active_ids
    ))
    previous_active = previous_active or {}
    if not candidate_ids and not previous_active:
        raise RuntimeError("Official Lofi Girl /streams returned no active livestreams")

    rows: list[dict] = []
    points: dict[str, list[tuple[int, int]]] = {}
    detail_cache: dict[str, dict] = {}

    def detail(video_id: str) -> dict:
        if video_id not in detail_cache:
            detail_cache[video_id] = detail_reader.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            ) or {}
        return detail_cache[video_id]

    active_ids: list[str] = []
    confirmed_listing_ended = 0
    for video_id in candidate_ids:
        info = detail(video_id)
        if clean_text(info.get("id")) != video_id:
            raise RuntimeError(f"Official stream detail identity mismatch for {video_id}")
        if (
            clean_text(info.get("channel_id")) == OFFICIAL_CHANNEL_ID
            and clean_text(info.get("availability")) == "public"
            and info.get("is_live") is False
            and clean_text(info.get("live_status")) in {"was_live", "post_live"}
        ):
            confirmed_listing_ended += 1
            continue
        if (
            clean_text(info.get("channel_id")) == OFFICIAL_CHANNEL_ID
            and clean_text(info.get("availability")) == "public"
            and info.get("is_live") is False
            and clean_text(info.get("live_status")) == "is_upcoming"
        ):
            confirmed_listing_ended += 1
            continue
        row, point = official_live_row(info, observed_ms)
        rows.append(row)
        points[video_id] = [point]
        active_ids.append(video_id)

    recovered = 0
    confirmed_ended = 0
    legacy_rejected = 0
    listing_set = set(active_ids)
    missing_previous = sorted(set(previous_active) - listing_set)
    for video_id in missing_previous:
        info = detail(video_id)
        trusted = previous_active[video_id].get("trusted") is True
        exact_identity = clean_text(info.get("id")) == video_id
        exact_channel = clean_text(info.get("channel_id")) == OFFICIAL_CHANNEL_ID
        if not exact_identity or not exact_channel:
            if trusted:
                raise RuntimeError(
                    f"Previously verified official stream {video_id} has conflicting identity"
                )
            legacy_rejected += 1
            continue
        if (
            clean_text(info.get("availability")) == "public"
            and info.get("is_live") is True
            and clean_text(info.get("live_status")) == "is_live"
        ):
            row, point = official_live_row(info, observed_ms)
            rows.append(row)
            points[video_id] = [point]
            recovered += 1
            continue
        if (
            clean_text(info.get("availability")) == "public"
            and info.get("is_live") is False
            and clean_text(info.get("live_status")) in {"was_live", "post_live"}
        ):
            confirmed_ended += 1
            continue
        raise RuntimeError(
            f"Previously active official stream {video_id} has ambiguous current status"
        )

    expected_ids = set(active_ids) | {
        video_id for video_id in missing_previous if video_id in points
    }
    if not rows:
        raise RuntimeError("Official Lofi Girl streams scan verified no active livestreams")
    if len(rows) != len(expected_ids) or set(points) != expected_ids:
        raise RuntimeError("Official Lofi Girl streams scan is incomplete")
    return {
        "rows": rows,
        "points": points,
        "metrics": {
            "expected": len(expected_ids),
            "verified": len(rows),
            "observedT": observed_ms,
            "listingActive": len(active_ids),
            "streamsTabCandidates": len(streams_candidate_ids),
            "streamsTabActive": len(streams_flat_active_ids),
            "streamsTabUnknown": len(streams_unknown_ids),
            "uploadsPlaylistActive": len(uploads_active_ids),
            "listingConfirmedEnded": confirmed_listing_ended,
            "previousActive": len(previous_active),
            "missingFromListing": len(missing_previous),
            "recoveredStillLive": recovered,
            "confirmedEnded": confirmed_ended,
            "legacyRejected": legacy_rejected,
        },
    }


def parse_live_catalogue(workbook) -> list[dict]:
    rows: list[dict] = []
    sheet = sheet_by_name(workbook, "Live Streams")
    for values in sheet.iter_rows(min_row=2, values_only=True):
        values = tuple(values) + (None,) * max(0, 7 - len(values))
        video_id = clean_text(values[0])
        if not VIDEO_ID.match(video_id):
            continue
        row = {
            "vid": video_id,
            "channel": clean_text(values[1]),
            "title": TITLE_SCAN_SUFFIX.sub("", clean_text(values[2])),
            "url": clean_text(values[3])
            or f"https://www.youtube.com/watch?v={video_id}",
            "started": to_ms(values[4]),
            "disc": clean_text(values[5]),
        }
        audience = clean_text(values[6])
        if re.search(r"\bkids?\b", audience, re.IGNORECASE):
            row["audiences"] = ["kids"]
        rows.append(row)
    return rows


def parse_history_points(workbook, fragment: str) -> dict[str, list[tuple[int, int]]]:
    points: dict[str, list[tuple[int, int]]] = defaultdict(list)
    sheet = sheet_by_name(workbook, fragment)
    for values in sheet.iter_rows(min_row=2, values_only=True):
        if len(values) < 3:
            continue
        video_id = clean_text(values[0])
        timestamp = to_ms(values[1])
        try:
            viewers = int(float(values[2]))
        except (TypeError, ValueError):
            continue
        if VIDEO_ID.match(video_id) and timestamp is not None:
            points[video_id].append((timestamp, viewers))
    return points


def load_existing_live_metadata(snapshot_path: Path | None) -> dict[str, dict]:
    if not snapshot_path or not snapshot_path.exists():
        return {}
    raw = snapshot_path.read_text(encoding="utf-8")
    raw = re.sub(r"^window\.LOFI_DATA=", "", raw).rstrip(";\n")
    payload = json.loads(raw)
    return {
        str(row.get("vid") or ""): row
        for row in ((payload.get("d") or {}).get("lives") or [])
        if VIDEO_ID.match(str(row.get("vid") or ""))
    }


def load_previous_active_official_lives(path: Path | None) -> dict[str, dict]:
    """Load the prior active official cohort so a partial listing cannot shrink it."""
    if not path or not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8")
    prefix = "window.LOFI_LIVE_DATA="
    if not raw.startswith(prefix):
        raise RuntimeError("Existing livestream bootstrap has an unexpected format")
    payload = json.loads(raw[len(prefix):].rstrip(";\n"))
    data = payload.get("d") or {}
    summaries = data.get("liveSummary") or {}
    metrics = payload.get("metrics") or {}
    proof_present = (
        positive_number(metrics.get("officialExpected"), allow_zero=True) is not None
        and metrics.get("officialVerified") is not None
        and int(metrics.get("officialExpected"))
        == int(metrics.get("officialVerified"))
    )
    result: dict[str, dict] = {}
    for row in data.get("lives") or []:
        video_id = clean_text(row.get("vid"))
        if not VIDEO_ID.fullmatch(video_id):
            continue
        trusted = (
            proof_present
            and clean_text(row.get("channelId")) == OFFICIAL_CHANNEL_ID
            and clean_text(row.get("source")) == "Official Lofi Girl streams scan"
            and clean_text(row.get("liveStatus")) == "is_live"
        )
        legacy = (
            not proof_present
            and clean_text(row.get("channel")) == "Lofi Girl"
            and (summaries.get(video_id) or {}).get("active") is True
        )
        if trusted or legacy:
            result[video_id] = {"trusted": trusted}
    return result


def build_payload(
    workbook,
    snapshot_path: Path | None = None,
    official_snapshot: dict | None = None,
) -> dict:
    lives = parse_live_catalogue(workbook)
    sheet_live_ids = {row["vid"] for row in lives}
    live_by_id = {row["vid"]: row for row in lives}
    official_snapshot = official_snapshot or {"rows": [], "points": {}, "metrics": {}}
    official_rows = official_snapshot.get("rows") or []
    official_ids: set[str] = set()
    for source in official_rows:
        video_id = clean_text(source.get("vid"))
        if not VIDEO_ID.fullmatch(video_id) or video_id in official_ids:
            raise RuntimeError("Official livestream snapshot has invalid or duplicate IDs")
        official_ids.add(video_id)
        current = live_by_id.get(video_id)
        if current is None:
            current = dict(source)
            lives.append(current)
            live_by_id[video_id] = current
        else:
            discovery = current.get("disc")
            current.update(source)
            if discovery:
                current["disc"] = discovery
    live_ids = {row["vid"] for row in lives}
    existing = load_existing_live_metadata(snapshot_path)
    for row in lives:
        previous = existing.get(row["vid"], {})
        for key in ("madeForKids", "audiences", "channelId", "chUrl", "subs"):
            if key in previous and key not in row:
                row[key] = previous[key]

    points: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for fragment in ("Live History", "Live Hourly"):
        for video_id, series in parse_history_points(workbook, fragment).items():
            if video_id in live_ids:
                points[video_id].extend(series)
    sheet_history_times = {
        video_id: {timestamp for timestamp, _ in series}
        for video_id, series in points.items()
        if series
    }
    sheet_source_latest = max(
        (timestamp for series in points.values() for timestamp, _ in series),
        default=0,
    )
    official_points = official_snapshot.get("points") or {}
    if set(official_points) != official_ids:
        raise RuntimeError("Official livestream rows and counter evidence do not match")
    for video_id, series in official_points.items():
        for point in series:
            if (
                not isinstance(point, (list, tuple))
                or len(point) != 2
                or positive_number(point[0]) is None
                or positive_number(point[1], allow_zero=True) is None
            ):
                raise RuntimeError(f"Official livestream {video_id} has invalid counter evidence")
            points[video_id].append((int(point[0]), int(point[1])))

    source_latest = max(
        (timestamp for series in points.values() for timestamp, _ in series),
        default=0,
    )
    cutoff_24h = source_latest - DAY_MS
    summary: dict[str, dict] = {}
    for video_id in sorted(live_ids):
        series = points.get(video_id) or []
        if not series:
            continue
        series.sort(key=lambda point: point[0])
        latest_t, now = series[-1]
        # A single collector observation is a current point, not a factual peak.
        # Wait for at least two distinct Sheet timestamps before exposing peaks.
        has_history_coverage = len(sheet_history_times.get(video_id, set())) >= 2
        peak_all = max((viewers for _, viewers in series), default=None) if has_history_coverage else None
        recent = (
            [viewers for timestamp, viewers in series if timestamp >= cutoff_24h]
            if has_history_coverage
            else []
        )
        summary[video_id] = {
            "now": now,
            "latestT": latest_t,
            "peak24": max(recent) if recent else None,
            "peakAll": peak_all,
            "active": (
                (video_id in official_ids and now >= 0)
                or (video_id not in official_ids and now > 0)
            ) and source_latest - latest_t <= 3 * 3_600_000,
        }

    if not lives or not summary or not source_latest:
        raise RuntimeError("Refusing to publish an empty livestream bootstrap")
    active = sum(1 for item in summary.values() if item.get("active") is True)
    official_metrics = official_snapshot.get("metrics") or {}
    official_expected = int(official_metrics.get("expected") or len(official_ids))
    official_verified = int(official_metrics.get("verified") or len(official_ids))
    official_observed = int(official_metrics.get("observedT") or 0)
    if official_expected != len(official_ids) or official_verified != len(official_ids):
        raise RuntimeError("Official livestream discovery proof is inconsistent")
    if official_ids and positive_number(official_observed) is None:
        raise RuntimeError("Official livestream discovery has no factual observation time")
    return {
        "t": source_latest,
        "d": {"lives": lives, "liveSummary": summary},
        "metrics": {
            "tracked": len(lives),
            "summarized": len(summary),
            "active": active,
            "sourceLatestT": source_latest,
            "sheetSourceLatestT": sheet_source_latest,
            "officialExpected": official_expected,
            "officialVerified": official_verified,
            "officialAdded": len(official_ids - sheet_live_ids),
            "officialUpdated": len(official_ids & sheet_live_ids),
            "officialObservedT": official_observed,
            "officialListingActive": int(official_metrics.get("listingActive") or 0),
            "officialStreamsTabCandidates": int(official_metrics.get("streamsTabCandidates") or 0),
            "officialStreamsTabActive": int(official_metrics.get("streamsTabActive") or 0),
            "officialStreamsTabUnknown": int(official_metrics.get("streamsTabUnknown") or 0),
            "officialUploadsPlaylistActive": int(official_metrics.get("uploadsPlaylistActive") or 0),
            "officialListingConfirmedEnded": int(official_metrics.get("listingConfirmedEnded") or 0),
            "officialPreviousActive": int(official_metrics.get("previousActive") or 0),
            "officialMissingFromListing": int(official_metrics.get("missingFromListing") or 0),
            "officialRecoveredStillLive": int(official_metrics.get("recoveredStillLive") or 0),
            "officialConfirmedEnded": int(official_metrics.get("confirmedEnded") or 0),
            "officialLegacyRejected": int(official_metrics.get("legacyRejected") or 0),
        },
    }


def read_workbook(source: str | None):
    if source:
        return openpyxl.load_workbook(source, read_only=True, data_only=True)
    request = urllib.request.Request(XLSX_URL, headers={"User-Agent": "LofiRadar/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        content = response.read()
    return openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)


def write_payload(path: Path, payload: dict) -> None:
    content = (
        "window.LOFI_LIVE_DATA="
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def ensure_sheet_freshness(
    payload: dict, max_age_hours: float, *, now_ms: int | None = None
) -> None:
    """Keep a fresh official observation from masking stale Sheet history."""
    if max_age_hours <= 0:
        return
    sheet_latest = int((payload.get("metrics") or {}).get("sheetSourceLatestT") or 0)
    if sheet_latest <= 0:
        raise RuntimeError("Livestream Sheet has no factual history timestamp")
    age_ms = int(now_ms or utc_now_ms()) - sheet_latest
    if age_ms > max_age_hours * 3_600_000:
        raise RuntimeError(
            f"Livestream Sheet is {age_ms / 3_600_000:.1f}h old; "
            "keeping the previous bootstrap"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", help="Use a local workbook instead of the public Sheet")
    parser.add_argument("--snapshot", type=Path, default=Path("Lofi_Radar_data.js"))
    parser.add_argument("--output", type=Path, default=Path("Lofi_Radar_live_data.js"))
    parser.add_argument("--max-age-hours", type=float, default=0)
    args = parser.parse_args()

    previous_active = load_previous_active_official_lives(args.output)
    official_snapshot = discover_official_live_streams(previous_active=previous_active)
    workbook = read_workbook(args.xlsx)
    try:
        payload = build_payload(workbook, args.snapshot, official_snapshot)
    finally:
        workbook.close()
    ensure_sheet_freshness(payload, args.max_age_hours)
    write_payload(args.output, payload)
    print(json.dumps(payload["metrics"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
