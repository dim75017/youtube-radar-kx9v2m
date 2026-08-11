#!/usr/bin/env python3
"""Build the small, first-paint livestream snapshot used by the dashboard."""

from __future__ import annotations

import argparse
import io
import json
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


def build_payload(workbook, snapshot_path: Path | None = None) -> dict:
    lives = parse_live_catalogue(workbook)
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
        peak_all = max(viewers for _, viewers in series)
        recent = [viewers for timestamp, viewers in series if timestamp >= cutoff_24h]
        summary[video_id] = {
            "now": now,
            "latestT": latest_t,
            "peak24": max(recent) if recent else None,
            "peakAll": peak_all,
            "active": now > 0 and source_latest - latest_t <= 3 * 3_600_000,
        }

    if not lives or not summary or not source_latest:
        raise RuntimeError("Refusing to publish an empty livestream bootstrap")
    active = sum(1 for item in summary.values() if item.get("active") is True)
    return {
        "t": source_latest,
        "d": {"lives": lives, "liveSummary": summary},
        "metrics": {
            "tracked": len(lives),
            "summarized": len(summary),
            "active": active,
            "sourceLatestT": source_latest,
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", help="Use a local workbook instead of the public Sheet")
    parser.add_argument("--snapshot", type=Path, default=Path("Lofi_Radar_data.js"))
    parser.add_argument("--output", type=Path, default=Path("Lofi_Radar_live_data.js"))
    parser.add_argument("--max-age-hours", type=float, default=0)
    args = parser.parse_args()

    workbook = read_workbook(args.xlsx)
    try:
        payload = build_payload(workbook, args.snapshot)
    finally:
        workbook.close()
    if args.max_age_hours > 0:
        age_ms = utc_now_ms() - int(payload["metrics"]["sourceLatestT"])
        if age_ms > args.max_age_hours * 3_600_000:
            raise RuntimeError(
                f"Livestream Sheet is {age_ms / 3_600_000:.1f}h old; "
                "keeping the previous bootstrap"
            )
    write_payload(args.output, payload)
    print(json.dumps(payload["metrics"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
