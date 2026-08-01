#!/usr/bin/env python3
"""Refresh private YouTube Studio aggregates from the Reporting API.

The collector deliberately keeps its daily report store separate from the
public dashboard snapshot.  The existing manual snapshot is used only as an
auditable bootstrap baseline and is never blended with API days.  A public
snapshot is replaced only when the basic and reach reports provide at least
one identical, contiguous sequence of complete reporting days.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Mapping, Protocol


TOKEN_URL = "https://oauth2.googleapis.com/token"
REPORTING_ROOT = "https://youtubereporting.googleapis.com/v1"
OUTPUT_PREFIX = "window.STUDIO_DATA="
STATE_VERSION = 1
ROLLING_DAYS = 365
STATE_RETENTION_DAYS = 400

REPORTS = {
    "basic": ("channel_basic_a3", "Lofi Radar channel activity"),
    "reach": ("channel_reach_basic_a1", "Lofi Radar channel reach"),
}


class StudioReportingError(RuntimeError):
    """A source, authorization, validation, or persistence failure."""


@dataclass(frozen=True)
class Credentials:
    client_id: str
    client_secret: str
    refresh_token: str

    @classmethod
    def from_environment(cls) -> "Credentials":
        values = cls(
            os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip(),
            os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip(),
            os.environ.get("YOUTUBE_ANALYTICS_REFRESH_TOKEN", "").strip(),
        )
        missing = [
            name
            for name, value in (
                ("GOOGLE_OAUTH_CLIENT_ID", values.client_id),
                ("GOOGLE_OAUTH_CLIENT_SECRET", values.client_secret),
                ("YOUTUBE_ANALYTICS_REFRESH_TOKEN", values.refresh_token),
            )
            if not value
        ]
        if missing:
            raise StudioReportingError("missing OAuth secret(s): " + ", ".join(missing))
        return values


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        timeout: int = 60,
    ) -> bytes: ...


class UrllibTransport:
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        timeout: int = 60,
    ) -> bytes:
        request = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", errors="replace")
            raise StudioReportingError(f"HTTP {exc.code} for {method} {url}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise StudioReportingError(f"network failure for {method} {url}: {exc.reason}") from exc


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_time(value: dt.datetime) -> str:
    if value.tzinfo is None:
        raise StudioReportingError("timestamps must be timezone-aware")
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value: object) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise StudioReportingError(f"invalid API timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def parse_day(value: object) -> dt.date:
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as exc:
        raise StudioReportingError(f"invalid reporting day: {value!r}") from exc


def decimal_value(value: object, field: str) -> Decimal:
    raw = str(value if value is not None else "").strip()
    try:
        number = Decimal(raw)
    except InvalidOperation as exc:
        raise StudioReportingError(f"invalid {field}: {value!r}") from exc
    if not number.is_finite() or number < 0:
        raise StudioReportingError(f"invalid {field}: {value!r}")
    return number


def integer_value(value: object, field: str) -> int:
    number = decimal_value(value, field)
    if number != number.to_integral_value():
        raise StudioReportingError(f"non-integer {field}: {value!r}")
    return int(number)


def round_int(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def round_float(value: Decimal, places: str = "0.01") -> float:
    return float(value.quantize(Decimal(places), rounding=ROUND_HALF_UP))


class ReportingClient:
    def __init__(self, credentials: Credentials, transport: Transport):
        self.credentials = credentials
        self.transport = transport
        self.access_token = self._refresh_access_token()

    def _refresh_access_token(self) -> str:
        body = urllib.parse.urlencode(
            {
                "client_id": self.credentials.client_id,
                "client_secret": self.credentials.client_secret,
                "refresh_token": self.credentials.refresh_token,
                "grant_type": "refresh_token",
            }
        ).encode("ascii")
        raw = self.transport.request(
            "POST",
            TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=body,
        )
        payload = self._decode_json(raw, "OAuth token")
        token = str(payload.get("access_token") or "").strip()
        if not token:
            detail = str(payload.get("error_description") or payload.get("error") or "missing access_token")
            raise StudioReportingError(f"OAuth refresh failed: {detail}")
        return token

    @staticmethod
    def _decode_json(raw: bytes, context: str) -> dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StudioReportingError(f"{context} returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise StudioReportingError(f"{context} returned a non-object response")
        return value

    def json_request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, object] | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> dict[str, Any]:
        query = "?" + urllib.parse.urlencode(params) if params else ""
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.access_token}", "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        raw = self.transport.request(method, REPORTING_ROOT + path + query, headers=headers, body=body)
        return self._decode_json(raw, f"Reporting API {path}")

    def list_jobs(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        token = ""
        while True:
            params: dict[str, object] = {"pageSize": 1000, "includeSystemManaged": "true"}
            if token:
                params["pageToken"] = token
            payload = self.json_request("GET", "/jobs", params=params)
            page = payload.get("jobs") or []
            if not isinstance(page, list):
                raise StudioReportingError("Reporting API jobs response is malformed")
            rows.extend(row for row in page if isinstance(row, dict))
            token = str(payload.get("nextPageToken") or "")
            if not token:
                return rows

    def ensure_jobs(self, now: dt.datetime) -> dict[str, dict[str, Any]]:
        existing = self.list_jobs()
        resolved: dict[str, dict[str, Any]] = {}
        for kind, (report_type, name) in REPORTS.items():
            candidates = []
            for row in existing:
                if row.get("reportTypeId") != report_type:
                    continue
                expires = row.get("expireTime")
                if expires and parse_time(expires) <= now:
                    continue
                if not str(row.get("id") or ""):
                    continue
                candidates.append(row)
            if candidates:
                resolved[kind] = sorted(candidates, key=lambda row: str(row.get("createTime") or ""))[0]
                continue
            created = self.json_request(
                "POST", "/jobs", payload={"reportTypeId": report_type, "name": name}
            )
            if not str(created.get("id") or "") or created.get("reportTypeId") != report_type:
                raise StudioReportingError(f"job creation returned an invalid {kind} job")
            resolved[kind] = created
            existing.append(created)
        return resolved

    def list_reports(self, job_id: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        token = ""
        encoded = urllib.parse.quote(job_id, safe="")
        while True:
            params: dict[str, object] = {"pageSize": 1000}
            if token:
                params["pageToken"] = token
            payload = self.json_request("GET", f"/jobs/{encoded}/reports", params=params)
            page = payload.get("reports") or []
            if not isinstance(page, list):
                raise StudioReportingError("Reporting API reports response is malformed")
            rows.extend(row for row in page if isinstance(row, dict))
            token = str(payload.get("nextPageToken") or "")
            if not token:
                return rows

    def download(self, url: str) -> bytes:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise StudioReportingError("Reporting API returned an unsafe download URL")
        return self.transport.request(
            "GET", url, headers={"Authorization": f"Bearer {self.access_token}", "Accept": "text/csv"}
        )


def read_snapshot(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8-sig").strip()
    except OSError as exc:
        raise StudioReportingError(f"cannot read baseline snapshot {path}: {exc}") from exc
    if not raw.startswith(OUTPUT_PREFIX):
        raise StudioReportingError(f"{path} is not a STUDIO_DATA snapshot")
    rendered = raw[len(OUTPUT_PREFIX) :].strip()
    if rendered.endswith(";"):
        rendered = rendered[:-1]
    try:
        payload = json.loads(rendered)
    except json.JSONDecodeError as exc:
        raise StudioReportingError(f"{path} contains invalid STUDIO_DATA JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("d"), dict):
        raise StudioReportingError("baseline snapshot is missing its video data")
    parse_day(payload.get("dataThrough"))
    return payload


def new_state(baseline: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "baselineAudit": baseline,
        "jobs": {},
        "daily": {"basic": {}, "reach": {}},
        "daySources": {"basic": {}, "reach": {}},
        "processedReports": {"basic": {}, "reach": {}},
        "sync": {},
    }


def load_state(path: Path, baseline_path: Path) -> dict[str, Any]:
    if not path.exists():
        return new_state(read_snapshot(baseline_path))
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StudioReportingError(f"cannot read reporting state {path}: {exc}") from exc
    if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
        raise StudioReportingError("unsupported or malformed reporting state")
    for key in ("daily", "daySources", "processedReports"):
        value = state.get(key)
        if not isinstance(value, dict) or not all(isinstance(value.get(kind), dict) for kind in REPORTS):
            raise StudioReportingError(f"reporting state is missing {key}")
    if not isinstance(state.get("baselineAudit"), dict):
        raise StudioReportingError("reporting state is missing its baseline audit")
    return state


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise


def write_state(path: Path, state: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")


def report_days(report: Mapping[str, Any], observed_days: set[str]) -> list[str]:
    start_raw, end_raw = report.get("startTime"), report.get("endTime")
    if start_raw and end_raw:
        start = parse_time(start_raw).date()
        end = parse_time(end_raw).date()
        if end <= start:
            raise StudioReportingError(f"report {report.get('id')} has an invalid period")
        days: list[str] = []
        cursor = start
        while cursor < end:
            days.append(cursor.isoformat())
            cursor += dt.timedelta(days=1)
        if not observed_days.issubset(set(days)):
            raise StudioReportingError(f"report {report.get('id')} contains rows outside its period")
        return days
    if observed_days:
        return sorted(observed_days)
    raise StudioReportingError(f"report {report.get('id')} has neither a period nor dated rows")


def decode_csv(raw: bytes) -> csv.DictReader:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise StudioReportingError("Reporting API CSV is not UTF-8") from exc
    return csv.DictReader(io.StringIO(text))


def parse_basic_report(raw: bytes, expected_channel_id: str | None) -> tuple[dict[str, Any], set[str], set[str]]:
    reader = decode_csv(raw)
    required = {
        "date",
        "channel_id",
        "video_id",
        "views",
        "watch_time_minutes",
        "average_view_duration_percentage",
    }
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise StudioReportingError("basic report is missing required columns")
    daily: dict[str, dict[str, dict[str, Any]]] = {}
    days: set[str] = set()
    channels: set[str] = set()
    for row in reader:
        day = parse_day(row.get("date")).isoformat()
        days.add(day)
        channel = str(row.get("channel_id") or "").strip()
        if channel:
            channels.add(channel)
        video_id = str(row.get("video_id") or "").strip()
        if not video_id:
            continue
        if expected_channel_id and channel != expected_channel_id:
            raise StudioReportingError(f"basic report belongs to unexpected channel {channel!r}")
        views = integer_value(row.get("views"), "views")
        watch_ms = decimal_value(row.get("watch_time_minutes"), "watch_time_minutes") * Decimal(60000)
        awp = decimal_value(
            row.get("average_view_duration_percentage"), "average_view_duration_percentage"
        )
        target = daily.setdefault(day, {}).setdefault(
            video_id, {"views": 0, "watchMs": "0", "awpWeighted": "0"}
        )
        target["views"] += views
        target["watchMs"] = str(Decimal(target["watchMs"]) + watch_ms)
        target["awpWeighted"] = str(Decimal(target["awpWeighted"]) + awp * views)
    return daily, days, channels


def parse_reach_report(raw: bytes, expected_channel_id: str | None) -> tuple[dict[str, Any], set[str], set[str]]:
    reader = decode_csv(raw)
    required = {
        "date",
        "channel_id",
        "video_id",
        "video_thumbnail_impressions",
        "video_thumbnail_impressions_ctr",
    }
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise StudioReportingError("reach report is missing required columns")
    daily: dict[str, dict[str, dict[str, Any]]] = {}
    days: set[str] = set()
    channels: set[str] = set()
    for row in reader:
        day = parse_day(row.get("date")).isoformat()
        days.add(day)
        channel = str(row.get("channel_id") or "").strip()
        if channel:
            channels.add(channel)
        video_id = str(row.get("video_id") or "").strip()
        if not video_id:
            continue
        if expected_channel_id and channel != expected_channel_id:
            raise StudioReportingError(f"reach report belongs to unexpected channel {channel!r}")
        impressions = integer_value(row.get("video_thumbnail_impressions"), "video_thumbnail_impressions")
        ctr = decimal_value(row.get("video_thumbnail_impressions_ctr"), "video_thumbnail_impressions_ctr")
        target = daily.setdefault(day, {}).setdefault(
            video_id, {"impressions": 0, "ctrWeighted": "0"}
        )
        target["impressions"] += impressions
        target["ctrWeighted"] = str(Decimal(target["ctrWeighted"]) + ctr * impressions)
    return daily, days, channels


def newest_per_period(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for report in reports:
        report_id = str(report.get("id") or "")
        download_url = str(report.get("downloadUrl") or "")
        if not report_id or not download_url:
            raise StudioReportingError("Reporting API returned a report without id/downloadUrl")
        period = f"{report.get('startTime') or ''}|{report.get('endTime') or ''}"
        if period == "|":
            period = report_id
        current = selected.get(period)
        candidate_key = (str(report.get("createTime") or ""), report_id)
        current_key = (str(current.get("createTime") or ""), str(current.get("id") or "")) if current else None
        if current_key is None or candidate_key > current_key:
            selected[period] = report
    return sorted(selected.values(), key=lambda row: (str(row.get("createTime") or ""), str(row.get("id"))))


def import_reports(
    client: ReportingClient,
    state: dict[str, Any],
    jobs: Mapping[str, Mapping[str, Any]],
    expected_channel_id: str | None,
) -> tuple[int, set[str]]:
    imported = 0
    observed_channels: set[str] = set()
    for kind in REPORTS:
        job_id = str(jobs[kind].get("id") or "")
        for report in newest_per_period(client.list_reports(job_id)):
            report_id = str(report["id"])
            if report_id in state["processedReports"][kind]:
                continue
            raw = client.download(str(report["downloadUrl"]))
            if kind == "basic":
                parsed, observed_days, channels = parse_basic_report(raw, expected_channel_id)
            else:
                parsed, observed_days, channels = parse_reach_report(raw, expected_channel_id)
            observed_channels.update(channels)
            coverage_days = report_days(report, observed_days)
            created_at = str(report.get("createTime") or "")
            if created_at:
                parse_time(created_at)
            for day in coverage_days:
                current = state["daySources"][kind].get(day)
                current_key = (
                    str(current.get("createTime") or ""), str(current.get("reportId") or "")
                ) if isinstance(current, dict) else ("", "")
                candidate_key = (created_at, report_id)
                if current_key > candidate_key:
                    continue
                state["daily"][kind][day] = parsed.get(day, {})
                state["daySources"][kind][day] = {"reportId": report_id, "createTime": created_at}
            state["processedReports"][kind][report_id] = {
                "createTime": created_at,
                "startTime": report.get("startTime"),
                "endTime": report.get("endTime"),
            }
            imported += 1
    return imported, observed_channels


def contiguous_blocks(days: set[str]) -> list[list[str]]:
    ordered = sorted(parse_day(day) for day in days)
    blocks: list[list[dt.date]] = []
    for day in ordered:
        if not blocks or day != blocks[-1][-1] + dt.timedelta(days=1):
            blocks.append([day])
        else:
            blocks[-1].append(day)
    return [[day.isoformat() for day in block] for block in blocks]


def complete_window(state: Mapping[str, Any]) -> list[str]:
    basic_days = set(state["daySources"]["basic"])
    reach_days = set(state["daySources"]["reach"])
    blocks = contiguous_blocks(basic_days & reach_days)
    if not blocks:
        return []
    # Always publish the most recent gap-free common block.  A missing day may
    # honestly shorten the current window, but an older hole must never keep
    # dataThrough pinned while newer paired reports are available.
    block = max(blocks, key=lambda value: value[-1])
    return block[-ROLLING_DAYS:]


def aggregate_window(state: Mapping[str, Any], window: list[str]) -> dict[str, dict[str, int | float]]:
    basic_totals: dict[str, dict[str, Any]] = {}
    reach_totals: dict[str, dict[str, Any]] = {}
    for day in window:
        for video_id, row in state["daily"]["basic"].get(day, {}).items():
            target = basic_totals.setdefault(video_id, {"views": 0, "watchMs": Decimal(0), "awpWeighted": Decimal(0)})
            target["views"] += integer_value(row.get("views"), "stored views")
            target["watchMs"] += decimal_value(row.get("watchMs"), "stored watchMs")
            target["awpWeighted"] += decimal_value(row.get("awpWeighted"), "stored awpWeighted")
        for video_id, row in state["daily"]["reach"].get(day, {}).items():
            target = reach_totals.setdefault(video_id, {"impressions": 0, "ctrWeighted": Decimal(0)})
            target["impressions"] += integer_value(row.get("impressions"), "stored impressions")
            target["ctrWeighted"] += decimal_value(row.get("ctrWeighted"), "stored ctrWeighted")

    output: dict[str, dict[str, int | float]] = {}
    for video_id in sorted(set(basic_totals) & set(reach_totals)):
        basic, reach = basic_totals[video_id], reach_totals[video_id]
        views, impressions = int(basic["views"]), int(reach["impressions"])
        if views <= 0 or impressions <= 0:
            continue
        output[video_id] = {
            "views": views,
            "imp": impressions,
            "ctr": round_float(reach["ctrWeighted"] / impressions),
            "awtMs": round_int(basic["watchMs"] / views),
            "awp": round_float(basic["awpWeighted"] / views),
        }
    if not output:
        raise StudioReportingError("common reports contain no video with all required metrics")
    return output


def prune_state(state: dict[str, Any]) -> None:
    all_days = set(state["daySources"]["basic"]) | set(state["daySources"]["reach"])
    if not all_days:
        return
    cutoff = max(parse_day(day) for day in all_days) - dt.timedelta(days=STATE_RETENTION_DAYS - 1)
    for kind in REPORTS:
        for bucket in (state["daily"][kind], state["daySources"][kind]):
            for day in list(bucket):
                if parse_day(day) < cutoff:
                    del bucket[day]


def month_label(day: dt.date) -> str:
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"{day.day} {months[day.month - 1]} {day.year}"


def build_snapshot(
    state: Mapping[str, Any],
    window: list[str],
    data: Mapping[str, Mapping[str, int | float]],
    now: dt.datetime,
) -> dict[str, Any]:
    start, end = parse_day(window[0]), parse_day(window[-1])
    days = len(window)
    warmup = days < ROLLING_DAYS
    label = (
        f"{days} complete reporting day{'s' if days != 1 else ''} · "
        f"{month_label(start)} – {month_label(end)}"
        + (" · warm-up" if warmup else "")
    )
    stamp = iso_time(now)
    return {
        "t": int(now.timestamp() * 1000),
        "label": label,
        "dataThrough": end.isoformat(),
        "scanAt": stamp,
        "windowDays": days,
        "windowStart": start.isoformat(),
        "windowEnd": end.isoformat(),
        "coverage": {
            "source": "youtube-reporting-api",
            "includedVideos": len(data),
            "windowDays": days,
            "windowStart": start.isoformat(),
            "windowEnd": end.isoformat(),
            "warmup": warmup,
            "partial": False,
        },
        "sync": {
            "source": "youtube-reporting-api",
            "connected": True,
            "status": "healthy",
            "lastAttemptAt": stamp,
            "lastSuccessAt": stamp,
            "warmup": warmup,
            "partial": False,
        },
        "d": dict(data),
    }


def write_snapshot(path: Path, payload: Mapping[str, Any]) -> None:
    atomic_write_text(
        path,
        OUTPUT_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
    )


def materially_same_snapshot(path: Path, candidate: Mapping[str, Any]) -> bool:
    try:
        current = read_snapshot(path)
    except StudioReportingError:
        return False
    current_sync = current.get("sync")
    if not isinstance(current_sync, Mapping) or current_sync.get("source") != "youtube-reporting-api":
        return False
    return all(
        current.get(field) == candidate.get(field)
        for field in ("windowStart", "windowEnd", "windowDays", "d")
    )


def run_sync(
    *,
    output_path: Path,
    state_path: Path,
    credentials: Credentials,
    transport: Transport | None = None,
    now: dt.datetime | None = None,
    expected_channel_id: str | None = None,
) -> dict[str, Any]:
    observed = now or utc_now()
    if observed.tzinfo is None:
        raise StudioReportingError("now must be timezone-aware")
    observed = observed.astimezone(dt.timezone.utc)
    expected = (expected_channel_id or "").strip() or None
    state = load_state(state_path, output_path)
    client = ReportingClient(credentials, transport or UrllibTransport())
    jobs = client.ensure_jobs(observed)
    imported, channels = import_reports(client, state, jobs, expected)

    stored_channel = str(state.get("channelId") or "").strip() or None
    if expected and stored_channel and stored_channel != expected:
        raise StudioReportingError("stored reporting state belongs to a different channel")
    if expected:
        state["channelId"] = expected
    elif channels:
        if len(channels) != 1:
            raise StudioReportingError(f"reports contain multiple channels: {sorted(channels)}")
        observed_channel = next(iter(channels))
        if stored_channel and stored_channel != observed_channel:
            raise StudioReportingError("new reports do not match the stored channel")
        state["channelId"] = observed_channel

    state["jobs"] = {
        kind: {"id": str(jobs[kind]["id"]), "reportTypeId": REPORTS[kind][0]}
        for kind in REPORTS
    }
    prune_state(state)
    window = complete_window(state)
    stamp = iso_time(observed)
    state["sync"] = {
        "source": "youtube-reporting-api",
        "connected": True,
        "status": "healthy" if window else "waiting_reports",
        "lastAttemptAt": stamp,
        "lastSuccessAt": stamp if window else state.get("sync", {}).get("lastSuccessAt"),
        "warmup": bool(window and len(window) < ROLLING_DAYS),
        "partial": not bool(window),
    }

    published = False
    included_videos = 0
    if window:
        aggregate = aggregate_window(state, window)
        payload = build_snapshot(state, window, aggregate, observed)
        included_videos = len(aggregate)
        if not materially_same_snapshot(output_path, payload):
            write_snapshot(output_path, payload)
            state["publishedWindow"] = {
                "start": window[0],
                "end": window[-1],
                "days": len(window),
                "at": stamp,
            }
            published = True
        elif not isinstance(state.get("publishedWindow"), Mapping):
            state["publishedWindow"] = {
                "start": window[0],
                "end": window[-1],
                "days": len(window),
                "at": stamp,
            }

    write_state(state_path, state)
    return {
        "connected": True,
        "status": state["sync"]["status"],
        "jobs": {kind: state["jobs"][kind]["id"] for kind in REPORTS},
        "reportsImported": imported,
        "published": published,
        "windowStart": window[0] if window else None,
        "windowEnd": window[-1] if window else None,
        "windowDays": len(window),
        "includedVideos": included_videos,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh YouTube Studio metrics from daily Reporting API jobs")
    parser.add_argument("--output", type=Path, default=Path("Lofi_Radar_studio.js"))
    parser.add_argument("--state", type=Path, default=Path("youtube_studio_reporting_state.json"))
    parser.add_argument(
        "--expected-channel-id",
        default=os.environ.get("YOUTUBE_CHANNEL_ID") or os.environ.get("YOUTUBE_EXPECTED_CHANNEL_ID"),
        help="Expected YouTube channel ID (default: YOUTUBE_CHANNEL_ID)",
    )
    args = parser.parse_args(argv)
    try:
        summary = run_sync(
            output_path=args.output,
            state_path=args.state,
            credentials=Credentials.from_environment(),
            expected_channel_id=args.expected_channel_id,
        )
    except StudioReportingError as exc:
        print(f"YouTube Studio reporting refresh failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
