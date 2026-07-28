#!/usr/bin/env python3
"""Import a 365-day YouTube Studio table export into ``STUDIO_DATA``.

The importer accepts either the CSV itself or the ZIP downloaded from Studio.
It intentionally exports only complete, measured rows: views, impressions,
impressions CTR, average view duration and average percentage viewed must all
be present in the source row.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import unicodedata
import zipfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Iterable


OUTPUT_PREFIX = "window.STUDIO_DATA="
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
REQUIRED_FIELDS = ("video_id", "views", "impressions", "ctr", "average_view_duration", "average_percentage_viewed")
MAX_CSV_BYTES = 64 * 1024 * 1024
TOTAL_MARKERS = {"total", "totals", "totaux", "grand total", "total general", "total generale"}


class StudioImportError(RuntimeError):
    """The supplied export cannot safely populate the Studio snapshot."""


@dataclass(frozen=True)
class ParsedTable:
    source_name: str
    data: dict[str, dict[str, int | float]]
    coverage: dict[str, int | str]


def normalize_header(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.replace("%", " percent ").replace("&", " and ").lower()
    return " ".join(re.findall(r"[a-z0-9]+", text))


def canonical_header(value: object) -> str | None:
    header = normalize_header(value)
    if header in {"content", "contenu", "video id", "id video", "id de la video", "video"}:
        return "video_id"
    if header in {"views", "view", "vues", "vue"}:
        return "views"
    if header in {"impressions", "impression"}:
        return "impressions"
    if "impression" in header and (
        "click through" in header
        or "clickthrough" in header
        or "taux de clic" in header
        or "taux clic" in header
    ):
        return "ctr"
    if (
        ("average" in header and "view" in header and "duration" in header)
        or ("duree moyenne" in header and ("visionnage" in header or "vue" in header))
    ):
        return "average_view_duration"
    if (
        ("average" in header and "percentage" in header and "view" in header)
        or ("pourcentage moyen" in header and ("regarde" in header or "visionne" in header))
    ):
        return "average_percentage_viewed"
    return None


def _localized_decimal(value: object) -> Decimal | None:
    raw = ("" if value is None else str(value)).strip().replace("%", "")
    raw = raw.replace("\u00a0", "").replace("\u202f", "").replace(" ", "").replace("'", "")
    if not raw or raw in {"-", "—", "–", "N/A", "n/a"}:
        return None
    if "," in raw and "." in raw:
        decimal_separator = "," if raw.rfind(",") > raw.rfind(".") else "."
        grouping_separator = "." if decimal_separator == "," else ","
        raw = raw.replace(grouping_separator, "").replace(decimal_separator, ".")
    elif "," in raw:
        raw = raw.replace(",", ".")
    try:
        number = Decimal(raw)
    except InvalidOperation:
        return None
    if not number.is_finite() or number < 0:
        return None
    return number


def parse_count(value: object) -> int | None:
    raw = ("" if value is None else str(value)).strip().replace("\u00a0", "").replace("\u202f", "").replace(" ", "").replace("'", "")
    if not raw or raw in {"-", "—", "–", "N/A", "n/a"}:
        return None
    if re.fullmatch(r"\d{1,3}(?:[,.]\d{3})+", raw):
        raw = raw.replace(",", "").replace(".", "")
    number = _localized_decimal(raw)
    if number is None or number != number.to_integral_value():
        return None
    return int(number)


def parse_percentage(value: object) -> float | None:
    number = _localized_decimal(value)
    if number is None:
        return None
    return float(number)


def parse_duration_ms(value: object) -> int | None:
    raw = ("" if value is None else str(value)).strip()
    if not raw or raw in {"-", "—", "–", "N/A", "n/a"}:
        return None
    parts = raw.split(":")
    if len(parts) == 1:
        seconds = _localized_decimal(parts[0])
    elif len(parts) in {2, 3}:
        parsed = [_localized_decimal(part) for part in parts]
        if any(part is None for part in parsed):
            return None
        assert all(part is not None for part in parsed)
        if parsed[-1] >= 60 or (len(parts) == 3 and parsed[-2] >= 60):
            return None
        if len(parts) == 2:
            seconds = parsed[0] * 60 + parsed[1]
        else:
            seconds = parsed[0] * 3600 + parsed[1] * 60 + parsed[2]
    else:
        return None
    if seconds is None:
        return None
    return int((seconds * 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise StudioImportError("Studio CSV encoding is not supported")


def _table_rows(text: str) -> tuple[list[list[str]], dict[str, int]]:
    candidates: list[tuple[int, list[list[str]], dict[str, int]]] = []
    for delimiter in (",", ";", "\t"):
        rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
        for position, row in enumerate(rows[:80]):
            mapping: dict[str, int] = {}
            for index, header in enumerate(row):
                canonical = canonical_header(header)
                if canonical and canonical not in mapping:
                    mapping[canonical] = index
            score = sum(field in mapping for field in REQUIRED_FIELDS)
            if score == len(REQUIRED_FIELDS):
                candidates.append((position, rows, mapping))
                break
    if not candidates:
        raise StudioImportError("No CSV table contains the six required Studio columns")
    header_position, rows, mapping = min(candidates, key=lambda candidate: candidate[0])
    return rows[header_position + 1 :], mapping


def _cell(row: list[str], mapping: dict[str, int], field: str) -> str:
    index = mapping[field]
    return row[index] if index < len(row) else ""


def parse_table(raw: bytes, source_name: str) -> ParsedTable:
    if len(raw) > MAX_CSV_BYTES:
        raise StudioImportError(f"Studio CSV is larger than {MAX_CSV_BYTES} bytes")
    rows, mapping = _table_rows(_decode_csv(raw))
    data: dict[str, dict[str, int | float]] = {}
    source_rows = complete_rows = incomplete_rows = invalid_rows = total_rows = duplicate_rows = 0

    for row in rows:
        if not any(str(cell).strip() for cell in row):
            continue
        raw_id = _cell(row, mapping, "video_id")
        video_id = str(raw_id or "").strip()
        if normalize_header(video_id) in TOTAL_MARKERS:
            total_rows += 1
            continue
        source_rows += 1
        if not VIDEO_ID.fullmatch(video_id):
            invalid_rows += 1
            continue

        views = parse_count(_cell(row, mapping, "views"))
        impressions = parse_count(_cell(row, mapping, "impressions"))
        ctr = parse_percentage(_cell(row, mapping, "ctr"))
        average_view_duration = parse_duration_ms(_cell(row, mapping, "average_view_duration"))
        average_percentage_viewed = parse_percentage(_cell(row, mapping, "average_percentage_viewed"))
        metrics = (views, impressions, ctr, average_view_duration, average_percentage_viewed)
        if any(metric is None for metric in metrics):
            incomplete_rows += 1
            continue
        if video_id in data:
            duplicate_rows += 1
        data[video_id] = {
            "views": views,
            "imp": impressions,
            "ctr": ctr,
            "awtMs": average_view_duration,
            "awp": average_percentage_viewed,
        }
        complete_rows += 1

    coverage: dict[str, int | str] = {
        "sourceFile": source_name,
        "sourceRows": source_rows,
        "completeRows": complete_rows,
        "includedVideos": len(data),
        "incompleteRows": incomplete_rows,
        "invalidRows": invalid_rows,
        "totalRowsIgnored": total_rows,
        "duplicateRows": duplicate_rows,
    }
    if not data:
        raise StudioImportError("Studio export contains no row with all five required metrics")
    return ParsedTable(source_name=source_name, data=data, coverage=coverage)


def _csv_sources(path: Path) -> Iterable[tuple[str, bytes]]:
    if not path.is_file():
        raise StudioImportError(f"Input does not exist: {path}")
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir() or not info.filename.lower().endswith(".csv"):
                    continue
                if info.file_size > MAX_CSV_BYTES:
                    continue
                yield info.filename, archive.read(info)
        return
    if path.suffix.lower() != ".csv":
        raise StudioImportError("Input must be a YouTube Studio ZIP or CSV export")
    yield path.name, path.read_bytes()


def load_best_table(path: Path) -> ParsedTable:
    tables: list[ParsedTable] = []
    errors: list[str] = []
    for name, raw in _csv_sources(path):
        try:
            tables.append(parse_table(raw, name))
        except StudioImportError as exc:
            errors.append(f"{name}: {exc}")
    if not tables:
        detail = "; ".join(errors[:5]) or "archive contains no CSV"
        raise StudioImportError(f"No usable Studio table found ({detail})")
    return max(tables, key=lambda table: (len(table.data), int(table.coverage["completeRows"]), table.source_name))


def parse_data_through(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--data-through must use YYYY-MM-DD") from exc


def _label(day: dt.date) -> str:
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"365 days · as of {day.day} {months[day.month - 1]} {day.year}"


def build_payload(table: ParsedTable, data_through: dt.date, scan_at: dt.datetime | None = None) -> dict:
    observed = scan_at or dt.datetime.now(dt.timezone.utc)
    if observed.tzinfo is None:
        raise StudioImportError("scan_at must be timezone-aware")
    observed = observed.astimezone(dt.timezone.utc).replace(microsecond=0)
    return {
        "t": int(observed.timestamp() * 1000),
        "label": _label(data_through),
        "dataThrough": data_through.isoformat(),
        "scanAt": observed.isoformat().replace("+00:00", "Z"),
        "coverage": table.coverage,
        "d": table.data,
    }


def write_payload(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = OUTPUT_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(rendered, encoding="utf-8")
    os.replace(temporary, path)


def import_studio_export(
    input_path: Path,
    output_path: Path,
    data_through: dt.date,
    *,
    scan_at: dt.datetime | None = None,
) -> dict:
    table = load_best_table(input_path)
    payload = build_payload(table, data_through, scan_at)
    write_payload(output_path, payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a YouTube Studio 365-day ZIP/CSV export")
    parser.add_argument("--input", type=Path, required=True, help="Studio ZIP or CSV export")
    parser.add_argument("--output", type=Path, required=True, help="Destination JavaScript snapshot")
    parser.add_argument("--data-through", type=parse_data_through, required=True, help="Last included day (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    payload = import_studio_export(args.input, args.output, args.data_through)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "dataThrough": payload["dataThrough"],
                "scanAt": payload["scanAt"],
                "coverage": payload["coverage"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
