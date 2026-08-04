#!/usr/bin/env python3
"""Privately backfill Spotify track IDs for stream-eligible FAL staging rows.

The Soundcharts Spotify audience response embeds the platform track identity in
``plots[].identifier``.  This collector accepts only an exact 22-character
Spotify identifier attached to a numeric audience plot.  Ambiguous identities,
within-phase-2 duplicates, missing values and request failures stay in the
private phase-2 SQLite checkpoint for review; nothing is written to canonical or dashboard
exports.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import urllib.parse
import uuid as uuid_module
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
)
from scan_soundcharts_fal_phase1 import finite_int, meta_get, meta_set, utc_now


BACKFILL_VERSION = 1
EXPECTED_PHASE2_STATE_VERSION = "3"
DEFAULT_STATE = Path("soundcharts-fal-phase2-state-v3.sqlite3")
DEFAULT_REPORT = Path("soundcharts-fal-spotify-id-backfill-report-v1.json")
DEFAULT_MAX_REQUESTS = 15_000
ABSOLUTE_MAX_REQUESTS = 15_000
MIN_QUOTA_RESERVE = 1_400_000
DEFAULT_WORKERS = 10
MAX_WORKERS = 10
DEFAULT_HISTORY_DAYS = 90
DEFAULT_RETRY_LIMIT = 2
SPOTIFY_ID_RE = re.compile(r"[A-Za-z0-9]{22}")
ACTIVE_STATUSES = ("pending", "retry")


BACKFILL_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS fal_phase2_spotify_id_backfill (
  track_uuid TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  selected_spotify_id TEXT,
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  conflicting_track_uuids_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  queued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_spotify_id_backfill_status
  ON fal_phase2_spotify_id_backfill(status, track_uuid);
"""


class FalSpotifyIdBackfillError(RuntimeError):
    """Fail-closed error for the private Spotify-ID backfill."""


@dataclass(frozen=True)
class PlotCandidate:
    spotify_id: str
    plot_count: int
    dated_plot_count: int
    first_date: str
    last_date: str
    latest_value: int | None
    maximum_value: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "spotify_id": self.spotify_id,
            "plot_count": self.plot_count,
            "dated_plot_count": self.dated_plot_count,
            "first_date": self.first_date,
            "last_date": self.last_date,
            "latest_value": self.latest_value,
            "maximum_value": self.maximum_value,
        }


@dataclass(frozen=True)
class FetchOutcome:
    track_uuid: str
    response: Any | None = None
    error_code: str | None = None


def _walk_mappings(value: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        yield value
        for child in value.values():
            yield from _walk_mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_mappings(child)


def _normalise_day(value: Any) -> str:
    raw = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return ""


def exact_spotify_plot_identifier(value: Any) -> str:
    """Return only an exact Spotify base62 track ID, never a suffix guess."""

    raw = str(value or "").strip()
    return raw if SPOTIFY_ID_RE.fullmatch(raw) else ""


def extract_spotify_plot_candidates(response: Any) -> list[PlotCandidate]:
    """Collect every exact ID attached to a numeric Soundcharts audience plot."""

    observations: dict[str, list[tuple[str, int]]] = {}
    for item in _walk_mappings(response):
        plots = item.get("plots")
        if not isinstance(plots, list):
            continue
        day = _normalise_day(item.get("date"))
        for plot in plots:
            if not isinstance(plot, Mapping):
                continue
            spotify_id = exact_spotify_plot_identifier(plot.get("identifier"))
            value = finite_int(plot.get("value"))
            if not spotify_id or value is None or value < 0:
                continue
            observations.setdefault(spotify_id, []).append((day, value))

    candidates: list[PlotCandidate] = []
    for spotify_id in sorted(observations):
        values = observations[spotify_id]
        dated = sorted((day, value) for day, value in values if day)
        latest_value = dated[-1][1] if dated else values[-1][1]
        numeric_values = [value for _, value in values]
        candidates.append(
            PlotCandidate(
                spotify_id=spotify_id,
                plot_count=len(values),
                dated_plot_count=len(dated),
                first_date=dated[0][0] if dated else "",
                last_date=dated[-1][0] if dated else "",
                latest_value=latest_value,
                maximum_value=max(numeric_values) if numeric_values else None,
            )
        )
    return candidates


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def open_private_state(path: Path) -> sqlite3.Connection:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise FalSpotifyIdBackfillError("A non-empty private phase-2 checkpoint is required")
    connection = sqlite3.connect(resolved)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    quick_check = connection.execute("PRAGMA quick_check").fetchone()
    if not quick_check or str(quick_check[0]).lower() != "ok":
        connection.close()
        raise FalSpotifyIdBackfillError("Phase-2 SQLite quick_check failed")
    required = {
        "meta",
        "fal_phase2_details",
        "fal_phase2_stream_gate",
    }
    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    missing = sorted(required - tables)
    if missing:
        connection.close()
        raise FalSpotifyIdBackfillError(
            "Phase-2 checkpoint is missing required private tables: " + ", ".join(missing)
        )
    if meta_get(connection, "fal_phase2_state_version") != EXPECTED_PHASE2_STATE_VERSION:
        connection.close()
        raise FalSpotifyIdBackfillError("Spotify-ID backfill requires phase-2 state version 3")
    return connection


def validate_phase2_report(path: Path | None) -> dict[str, Any]:
    if path is None:
        raise FalSpotifyIdBackfillError("The phase-2 completion report is required")
    if not path.is_file():
        raise FalSpotifyIdBackfillError("The phase-2 completion report is missing")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FalSpotifyIdBackfillError("The phase-2 completion report is invalid") from exc
    if not isinstance(payload, dict):
        raise FalSpotifyIdBackfillError("The phase-2 completion report must be an object")
    if payload.get("complete") is not True:
        raise FalSpotifyIdBackfillError("Spotify-ID backfill requires a complete phase-2 scan")
    if payload.get("staging_only") is not True:
        raise FalSpotifyIdBackfillError("Phase-2 source is not marked staging-only")
    if payload.get("canonical_written") is not False:
        raise FalSpotifyIdBackfillError("Phase-2 source reports a canonical write")
    if payload.get("dashboard_written") is not False:
        raise FalSpotifyIdBackfillError("Phase-2 source reports a dashboard write")
    stream_gate = payload.get("stream_gate") or {}
    if finite_int(stream_gate.get("minimum_streams")) != 100_000:
        raise FalSpotifyIdBackfillError("Phase-2 report lost the strict 100k stream gate")
    return payload


def validate_report_state_alignment(
    connection: sqlite3.Connection, phase2_report: Mapping[str, Any]
) -> int:
    """Bind the paid backfill to the exact completed stream-gate checkpoint."""

    stream_gate = phase2_report.get("stream_gate") or {}
    status_counts = stream_gate.get("status_counts") or {}
    reported_eligible = finite_int(status_counts.get("eligible"))
    if reported_eligible is None:
        raise FalSpotifyIdBackfillError(
            "Phase-2 report does not contain the eligible stream-gate count"
        )
    state_eligible = int(
        connection.execute(
            "SELECT COUNT(*) FROM fal_phase2_stream_gate WHERE gate_status='eligible'"
        ).fetchone()[0]
    )
    if reported_eligible != state_eligible:
        raise FalSpotifyIdBackfillError(
            "Phase-2 report/state eligible-count mismatch "
            f"({reported_eligible} reported; {state_eligible} in SQLite)"
        )
    if state_eligible <= 0:
        raise FalSpotifyIdBackfillError("Phase-2 state contains no stream-eligible tracks")
    stream_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(fal_phase2_stream_gate)"
        ).fetchall()
    }
    if "streams_total" not in stream_columns:
        raise FalSpotifyIdBackfillError(
            "Phase-2 stream gate lacks the lifetime streams_total proof"
        )
    invalid_eligible = int(
        connection.execute(
            """SELECT COUNT(*) FROM fal_phase2_stream_gate
                 WHERE gate_status='eligible'
                   AND (streams_total IS NULL OR streams_total<100000)"""
        ).fetchone()[0]
    )
    if invalid_eligible:
        raise FalSpotifyIdBackfillError(
            f"Phase-2 state contains {invalid_eligible} invalid eligible stream rows"
        )
    return state_eligible


def ensure_backfill_schema(connection: sqlite3.Connection) -> bool:
    exists = connection.execute(
        """SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='fal_phase2_spotify_id_backfill'"""
    ).fetchone()
    connection.executescript(BACKFILL_SCHEMA_SQL)
    if not exists:
        meta_set(connection, "fal_phase2_spotify_id_backfill_version", BACKFILL_VERSION)
        meta_set(connection, "fal_phase2_spotify_id_backfill_initialized_at", utc_now())
        connection.commit()
        return True
    stored = meta_get(connection, "fal_phase2_spotify_id_backfill_version")
    if stored != str(BACKFILL_VERSION):
        raise FalSpotifyIdBackfillError(
            f"Unsupported Spotify-ID backfill version ({stored}; expected {BACKFILL_VERSION})"
        )
    expected_columns = {
        "track_uuid",
        "status",
        "selected_spotify_id",
        "candidate_ids_json",
        "evidence_json",
        "conflicting_track_uuids_json",
        "attempts",
        "error_code",
        "queued_at",
        "updated_at",
        "last_run_id",
    }
    actual_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(fal_phase2_spotify_id_backfill)"
        ).fetchall()
    }
    if actual_columns != expected_columns:
        raise FalSpotifyIdBackfillError("Spotify-ID backfill table schema is incompatible")
    return False


def _valid_existing_spotify_id(value: Any) -> str:
    return exact_spotify_plot_identifier(value)


def seed_backfill_rows(connection: sqlite3.Connection) -> int:
    """Queue only stream-eligible rows whose Spotify identity is still absent."""

    now = utc_now()
    before = connection.total_changes
    connection.execute(
        """INSERT OR IGNORE INTO fal_phase2_spotify_id_backfill(
               track_uuid,status,queued_at,updated_at)
             SELECT s.track_uuid,'pending',?,?
               FROM fal_phase2_stream_gate AS s
              WHERE s.gate_status='eligible'
                AND (s.spotify_id IS NULL OR trim(s.spotify_id)='')""",
        (now, now),
    )
    inserted = connection.total_changes - before
    connection.commit()
    return int(inserted)


def reconcile_preexisting_detail_ids(connection: sqlite3.Connection, run_id: str) -> int:
    """Use a valid private detail identity without spending a duplicate API call."""

    rows = connection.execute(
        """SELECT b.track_uuid,d.spotify_id
             FROM fal_phase2_spotify_id_backfill AS b
             JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
             JOIN fal_phase2_details AS d ON d.track_uuid=b.track_uuid
            WHERE b.status IN ('pending','retry')
              AND s.gate_status='eligible'
              AND (s.spotify_id IS NULL OR trim(s.spotify_id)='')
              AND d.spotify_id IS NOT NULL AND trim(d.spotify_id)<>''
            ORDER BY b.track_uuid"""
    ).fetchall()
    resolved = 0
    for row in rows:
        track_uuid = str(row["track_uuid"])
        spotify_id = _valid_existing_spotify_id(row["spotify_id"])
        if not spotify_id:
            connection.execute(
                """UPDATE fal_phase2_spotify_id_backfill
                      SET status='identity_conflict',candidate_ids_json=?,evidence_json=?,
                          error_code='invalid_existing_detail_spotify_id',updated_at=?,last_run_id=?
                    WHERE track_uuid=?""",
                (
                    safe_json([]),
                    safe_json({"existing_detail_spotify_id": str(row["spotify_id"])}),
                    utc_now(),
                    run_id,
                    track_uuid,
                ),
            )
            continue
        conflicts = existing_conflicts(connection, spotify_id, track_uuid)
        if conflicts:
            connection.execute(
                """UPDATE fal_phase2_spotify_id_backfill
                      SET status='duplicate_within_phase2',candidate_ids_json=?,evidence_json=?,
                          conflicting_track_uuids_json=?,
                          error_code='duplicate_within_phase2_existing_identity',
                          updated_at=?,last_run_id=?
                    WHERE track_uuid=?""",
                (
                    safe_json([spotify_id]),
                    safe_json({"source": "preexisting_private_detail"}),
                    safe_json(conflicts),
                    utc_now(),
                    run_id,
                    track_uuid,
                ),
            )
            continue
        _assign_identity(connection, track_uuid, spotify_id)
        connection.execute(
            """UPDATE fal_phase2_spotify_id_backfill
                  SET status='resolved',selected_spotify_id=?,candidate_ids_json=?,
                      evidence_json=?,conflicting_track_uuids_json='[]',error_code=NULL,
                      updated_at=?,last_run_id=?
                WHERE track_uuid=?""",
            (
                spotify_id,
                safe_json([spotify_id]),
                safe_json({"source": "preexisting_private_detail"}),
                utc_now(),
                run_id,
                track_uuid,
            ),
        )
        resolved += 1
    connection.commit()
    return resolved


def existing_conflicts(
    connection: sqlite3.Connection, spotify_id: str, track_uuid: str
) -> list[str]:
    rows = connection.execute(
        """SELECT track_uuid FROM fal_phase2_stream_gate
             WHERE spotify_id=? AND track_uuid<>?
           UNION
           SELECT track_uuid FROM fal_phase2_details
             WHERE spotify_id=? AND track_uuid<>?""",
        (spotify_id, track_uuid, spotify_id, track_uuid),
    ).fetchall()
    conflicts = {str(row[0]) for row in rows if str(row[0] or "").strip()}
    # Retain conflicts already observed in a previous private run, even when a
    # candidate was deliberately not assigned because its response was ambiguous.
    prior = connection.execute(
        """SELECT track_uuid,candidate_ids_json
             FROM fal_phase2_spotify_id_backfill
            WHERE track_uuid<>?
              AND status IN ('ambiguous','duplicate_within_phase2','identity_conflict')""",
        (track_uuid,),
    ).fetchall()
    for row in prior:
        try:
            candidates = json.loads(str(row["candidate_ids_json"] or "[]"))
        except json.JSONDecodeError:
            candidates = []
        if spotify_id in candidates:
            conflicts.add(str(row["track_uuid"]))
    return sorted(conflicts)


def _assign_identity(
    connection: sqlite3.Connection, track_uuid: str, spotify_id: str
) -> None:
    connection.execute(
        """UPDATE fal_phase2_stream_gate SET spotify_id=?
             WHERE track_uuid=? AND (spotify_id IS NULL OR trim(spotify_id)='')""",
        (spotify_id, track_uuid),
    )
    connection.execute(
        """UPDATE fal_phase2_details SET spotify_id=?
             WHERE track_uuid=? AND (spotify_id IS NULL OR trim(spotify_id)='')""",
        (spotify_id, track_uuid),
    )


def merge_resolved_identity_cache(
    connection: sqlite3.Connection,
    cache_path: Path,
    *,
    run_id: str,
) -> int:
    """Carry safe resolved IDs from an older encrypted backfill checkpoint.

    A newer phase-2 plaintext checkpoint can legitimately supersede the last
    encrypted backfill state.  Only exact, internally consistent, unique IDs
    previously resolved by this backfill are copied, and only into the same
    eligible track UUID when the new checkpoint has no identity or conflict.
    """

    resolved = cache_path.resolve()
    if resolved == Path(connection.execute("PRAGMA database_list").fetchone()[2]).resolve():
        return 0
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise FalSpotifyIdBackfillError("Encrypted identity-cache state is missing")
    cache = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    cache.row_factory = sqlite3.Row
    try:
        if cache.execute("PRAGMA quick_check").fetchone()[0].lower() != "ok":
            raise FalSpotifyIdBackfillError("Encrypted identity-cache quick_check failed")
        tables = {
            str(row[0])
            for row in cache.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "fal_phase2_spotify_id_backfill" not in tables:
            return 0
        if meta_get(cache, "fal_phase2_state_version") != EXPECTED_PHASE2_STATE_VERSION:
            raise FalSpotifyIdBackfillError("Identity cache is not phase-2 state version 3")
        rows = cache.execute(
            """SELECT b.track_uuid,b.selected_spotify_id,
                      s.spotify_id AS stream_spotify_id,d.spotify_id AS detail_spotify_id
                 FROM fal_phase2_spotify_id_backfill AS b
                 JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
                 JOIN fal_phase2_details AS d ON d.track_uuid=b.track_uuid
                WHERE b.status='resolved'
                ORDER BY b.track_uuid"""
        ).fetchall()
    finally:
        cache.close()

    valid: list[tuple[str, str]] = []
    claims: dict[str, set[str]] = {}
    for row in rows:
        track_uuid = str(row["track_uuid"] or "").strip()
        spotify_id = exact_spotify_plot_identifier(row["selected_spotify_id"])
        if (
            not track_uuid
            or not spotify_id
            or str(row["stream_spotify_id"] or "").strip() != spotify_id
            or str(row["detail_spotify_id"] or "").strip() != spotify_id
        ):
            continue
        valid.append((track_uuid, spotify_id))
        claims.setdefault(spotify_id, set()).add(track_uuid)

    merged = 0
    now = utc_now()
    for track_uuid, spotify_id in valid:
        if len(claims.get(spotify_id, set())) != 1:
            continue
        target = connection.execute(
            """SELECT s.gate_status,s.spotify_id AS stream_spotify_id,
                      d.spotify_id AS detail_spotify_id
                 FROM fal_phase2_stream_gate AS s
                 JOIN fal_phase2_details AS d ON d.track_uuid=s.track_uuid
                WHERE s.track_uuid=?""",
            (track_uuid,),
        ).fetchone()
        if not target or str(target["gate_status"]) != "eligible":
            continue
        if str(target["stream_spotify_id"] or "").strip():
            continue
        if str(target["detail_spotify_id"] or "").strip():
            continue
        if existing_conflicts(connection, spotify_id, track_uuid):
            continue
        _assign_identity(connection, track_uuid, spotify_id)
        connection.execute(
            """INSERT INTO fal_phase2_spotify_id_backfill(
                   track_uuid,status,selected_spotify_id,candidate_ids_json,
                   evidence_json,conflicting_track_uuids_json,attempts,error_code,
                   queued_at,updated_at,last_run_id)
                 VALUES(?,'resolved',?,?,?,'[]',0,NULL,?,?,?)
                 ON CONFLICT(track_uuid) DO UPDATE SET
                   status='resolved',selected_spotify_id=excluded.selected_spotify_id,
                   candidate_ids_json=excluded.candidate_ids_json,
                   evidence_json=excluded.evidence_json,
                   conflicting_track_uuids_json='[]',error_code=NULL,
                   updated_at=excluded.updated_at,last_run_id=excluded.last_run_id""",
            (
                track_uuid,
                spotify_id,
                safe_json([spotify_id]),
                safe_json({"source": "encrypted_prior_backfill_state"}),
                now,
                now,
                run_id,
            ),
        )
        merged += 1
    connection.commit()
    return merged


def quarantine_resolved_backfill_conflicts(
    connection: sqlite3.Connection,
    *,
    spotify_id: str,
    claiming_track_uuid: str,
    run_id: str,
) -> list[str]:
    """Revoke only IDs previously assigned by this backfill, never source IDs.

    A response processed in a later batch can reveal that a Spotify ID already
    assigned by an earlier backfill batch is not unique.  Both candidates must
    then remain quarantined.  Pre-existing identities outside the backfill
    table are intentionally left untouched.
    """

    rows = connection.execute(
        """SELECT track_uuid,conflicting_track_uuids_json
             FROM fal_phase2_spotify_id_backfill
            WHERE status='resolved' AND selected_spotify_id=? AND track_uuid<>?""",
        (spotify_id, claiming_track_uuid),
    ).fetchall()
    revoked: list[str] = []
    now = utc_now()
    for row in rows:
        track_uuid = str(row["track_uuid"])
        try:
            conflicts = set(
                str(value)
                for value in json.loads(
                    str(row["conflicting_track_uuids_json"] or "[]")
                )
                if str(value).strip()
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            conflicts = set()
        conflicts.add(claiming_track_uuid)
        connection.execute(
            """UPDATE fal_phase2_stream_gate SET spotify_id=NULL
                 WHERE track_uuid=? AND spotify_id=?""",
            (track_uuid, spotify_id),
        )
        connection.execute(
            """UPDATE fal_phase2_details SET spotify_id=NULL
                 WHERE track_uuid=? AND spotify_id=?""",
            (track_uuid, spotify_id),
        )
        connection.execute(
            """UPDATE fal_phase2_spotify_id_backfill
                  SET status='duplicate_within_phase2',selected_spotify_id=NULL,
                      conflicting_track_uuids_json=?,
                      error_code='duplicate_within_phase2_discovered_later',
                      updated_at=?,last_run_id=?
                WHERE track_uuid=?""",
            (safe_json(sorted(conflicts)), now, run_id, track_uuid),
        )
        revoked.append(track_uuid)
    return sorted(revoked)


class SpotifyIdBackfillScanner:
    """Bounded concurrent reader for the already-approved audience endpoint."""

    def __init__(
        self,
        connection: sqlite3.Connection,
        client: Any,
        *,
        workers: int = DEFAULT_WORKERS,
        history_days: int = DEFAULT_HISTORY_DAYS,
        retry_limit: int = DEFAULT_RETRY_LIMIT,
        as_of: str | dt.date | None = None,
        run_id: str = "",
    ) -> None:
        self.connection = connection
        self.client = client
        self.workers = max(1, min(MAX_WORKERS, int(workers)))
        self.history_days = max(1, min(365, int(history_days)))
        self.retry_limit = max(1, int(retry_limit))
        self.run_id = str(run_id or uuid_module.uuid4().hex)
        today = (
            dt.date.fromisoformat(str(as_of)[:10])
            if as_of
            else dt.datetime.now(dt.timezone.utc).date()
        )
        start = today - dt.timedelta(days=self.history_days - 1)
        self.query = urllib.parse.urlencode(
            {
                "startDate": start.isoformat(),
                "endDate": today.isoformat(),
                "limit": max(100, self.history_days + 5),
            }
        )
        self.halt_reason = ""
        self.rows_attempted = 0

    def _fetch(self, row: sqlite3.Row) -> FetchOutcome:
        track_uuid = str(row["track_uuid"])
        path = (
            f"/api/v2/song/{urllib.parse.quote(track_uuid)}/audience/spotify?{self.query}"
        )
        try:
            return FetchOutcome(track_uuid, response=self.client.get(path))
        except SoundchartsRequestLimitError:
            return FetchOutcome(track_uuid, error_code="request_limit")
        except SoundchartsQuotaReserveError:
            return FetchOutcome(track_uuid, error_code="quota_reserve")
        except SoundchartsDataUnavailableError:
            return FetchOutcome(track_uuid, error_code="unavailable")
        except (SoundchartsError, OSError, RuntimeError):
            return FetchOutcome(track_uuid, error_code="request_failed")

    def _store_batch(self, outcomes: Sequence[FetchOutcome]) -> None:
        parsed: dict[str, list[PlotCandidate]] = {
            outcome.track_uuid: extract_spotify_plot_candidates(outcome.response)
            for outcome in outcomes
            if outcome.error_code is None
        }
        claims: dict[str, set[str]] = {}
        for track_uuid, candidates in parsed.items():
            for candidate in candidates:
                claims.setdefault(candidate.spotify_id, set()).add(track_uuid)

        now = utc_now()
        for outcome in sorted(outcomes, key=lambda item: item.track_uuid):
            track_uuid = outcome.track_uuid
            if outcome.error_code:
                if outcome.error_code in {"request_limit", "quota_reserve"}:
                    self.halt_reason = outcome.error_code
                    self.connection.execute(
                        """UPDATE fal_phase2_spotify_id_backfill
                              SET error_code=?,updated_at=?,last_run_id=?
                            WHERE track_uuid=?""",
                        (outcome.error_code, now, self.run_id, track_uuid),
                    )
                    continue
                current = self.connection.execute(
                    """SELECT attempts FROM fal_phase2_spotify_id_backfill
                         WHERE track_uuid=?""",
                    (track_uuid,),
                ).fetchone()
                attempts = int(current[0] or 0) + 1 if current else 1
                if outcome.error_code == "unavailable":
                    status = "unavailable"
                else:
                    status = "request_failed" if attempts >= self.retry_limit else "retry"
                self.connection.execute(
                    """UPDATE fal_phase2_spotify_id_backfill
                          SET status=?,attempts=?,error_code=?,updated_at=?,last_run_id=?
                        WHERE track_uuid=?""",
                    (status, attempts, outcome.error_code, now, self.run_id, track_uuid),
                )
                self.rows_attempted += 1
                continue

            candidates = parsed.get(track_uuid, [])
            candidate_ids = [candidate.spotify_id for candidate in candidates]
            evidence = {"source": "soundcharts_song_audience_spotify_plot", "candidates": [
                candidate.as_dict() for candidate in candidates
            ]}
            if not candidates:
                self.connection.execute(
                    """UPDATE fal_phase2_spotify_id_backfill
                          SET status='missing',candidate_ids_json='[]',evidence_json=?,
                              conflicting_track_uuids_json='[]',attempts=attempts+1,
                              error_code='exact_plot_identifier_missing',updated_at=?,last_run_id=?
                        WHERE track_uuid=?""",
                    (safe_json(evidence), now, self.run_id, track_uuid),
                )
                self.rows_attempted += 1
                continue
            if len(candidates) > 1:
                self.connection.execute(
                    """UPDATE fal_phase2_spotify_id_backfill
                          SET status='ambiguous',candidate_ids_json=?,evidence_json=?,
                              conflicting_track_uuids_json='[]',attempts=attempts+1,
                              error_code='multiple_exact_plot_identifiers',updated_at=?,last_run_id=?
                        WHERE track_uuid=?""",
                    (
                        safe_json(candidate_ids),
                        safe_json(evidence),
                        now,
                        self.run_id,
                        track_uuid,
                    ),
                )
                self.rows_attempted += 1
                continue

            spotify_id = candidates[0].spotify_id
            conflicts = set(existing_conflicts(self.connection, spotify_id, track_uuid))
            conflicts.update(claims.get(spotify_id, set()) - {track_uuid})
            if conflicts:
                revoked = quarantine_resolved_backfill_conflicts(
                    self.connection,
                    spotify_id=spotify_id,
                    claiming_track_uuid=track_uuid,
                    run_id=self.run_id,
                )
                conflicts.update(revoked)
            detail = self.connection.execute(
                "SELECT spotify_id FROM fal_phase2_details WHERE track_uuid=?",
                (track_uuid,),
            ).fetchone()
            detail_id = str(detail[0] or "").strip() if detail else ""
            if detail_id and detail_id != spotify_id:
                evidence["existing_detail_spotify_id"] = detail_id
                self.connection.execute(
                    """UPDATE fal_phase2_spotify_id_backfill
                          SET status='identity_conflict',candidate_ids_json=?,evidence_json=?,
                              conflicting_track_uuids_json=?,attempts=attempts+1,
                              error_code='detail_and_audience_identity_disagree',updated_at=?,last_run_id=?
                        WHERE track_uuid=?""",
                    (
                        safe_json(candidate_ids),
                        safe_json(evidence),
                        safe_json(sorted(conflicts)),
                        now,
                        self.run_id,
                        track_uuid,
                    ),
                )
                self.rows_attempted += 1
                continue
            if conflicts:
                self.connection.execute(
                    """UPDATE fal_phase2_spotify_id_backfill
                          SET status='duplicate_within_phase2',candidate_ids_json=?,evidence_json=?,
                              conflicting_track_uuids_json=?,attempts=attempts+1,
                              error_code='duplicate_within_phase2_identity',updated_at=?,last_run_id=?
                        WHERE track_uuid=?""",
                    (
                        safe_json(candidate_ids),
                        safe_json(evidence),
                        safe_json(sorted(conflicts)),
                        now,
                        self.run_id,
                        track_uuid,
                    ),
                )
                self.rows_attempted += 1
                continue

            _assign_identity(self.connection, track_uuid, spotify_id)
            self.connection.execute(
                """UPDATE fal_phase2_spotify_id_backfill
                      SET status='resolved',selected_spotify_id=?,candidate_ids_json=?,
                          evidence_json=?,conflicting_track_uuids_json='[]',attempts=attempts+1,
                          error_code=NULL,updated_at=?,last_run_id=?
                    WHERE track_uuid=?""",
                (
                    spotify_id,
                    safe_json(candidate_ids),
                    safe_json(evidence),
                    now,
                    self.run_id,
                    track_uuid,
                ),
            )
            self.rows_attempted += 1
        self.connection.commit()

    def run(self, *, max_rows: int) -> int:
        remaining_rows = max(0, int(max_rows))
        while remaining_rows > 0 and not self.halt_reason:
            rows = self.connection.execute(
                """SELECT b.*
                     FROM fal_phase2_spotify_id_backfill AS b
                     JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
                    WHERE b.status IN ('pending','retry')
                      AND b.attempts<?
                      AND s.gate_status='eligible'
                      AND (s.spotify_id IS NULL OR trim(s.spotify_id)='')
                    ORDER BY b.queued_at,b.track_uuid LIMIT ?""",
                (self.retry_limit, min(self.workers, remaining_rows)),
            ).fetchall()
            if not rows:
                break
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=min(self.workers, len(rows))
            ) as executor:
                outcomes = list(executor.map(self._fetch, rows))
            self._store_batch(outcomes)
            attempted = sum(
                1
                for outcome in outcomes
                if outcome.error_code not in {"request_limit", "quota_reserve"}
            )
            remaining_rows -= attempted
            if attempted <= 0:
                break
        return self.rows_attempted


def status_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        str(row[0]): int(row[1])
        for row in connection.execute(
            """SELECT status,COUNT(*) FROM fal_phase2_spotify_id_backfill
                 GROUP BY status ORDER BY status"""
        ).fetchall()
    }


def _count(
    connection: sqlite3.Connection, query: str, params: Sequence[Any] = ()
) -> int:
    return int(connection.execute(query, tuple(params)).fetchone()[0])


def build_report(
    connection: sqlite3.Connection,
    *,
    state_path: Path,
    state_sha256_before: str,
    schema_created: bool,
    seeded: int,
    cached_resolved_merged: int,
    preexisting_resolved: int,
    run_id: str,
    source_artifact_id: str,
    max_requests: int,
    quota_reserve: int,
    quota_before: int | None,
    client: Any | None,
    halt_reason: str,
    rows_attempted: int,
    phase2_report: Mapping[str, Any],
) -> dict[str, Any]:
    counts = status_counts(connection)
    active = sum(counts.get(status, 0) for status in ACTIVE_STATUSES)
    eligible_total = _count(
        connection,
        "SELECT COUNT(*) FROM fal_phase2_stream_gate WHERE gate_status='eligible'",
    )
    eligible_with_id = _count(
        connection,
        """SELECT COUNT(*) FROM fal_phase2_stream_gate
             WHERE gate_status='eligible' AND spotify_id IS NOT NULL AND trim(spotify_id)<>''""",
    )
    state_sha256_after = file_sha256(state_path)
    claimed = int(getattr(client, "requests_claimed", 0) or 0) if client else 0
    quota_after = finite_int(getattr(client, "quota_remaining", None)) if client else None
    if halt_reason == "quota_reserve":
        status = "quota_protected"
    elif halt_reason == "request_limit" and active:
        status = "request_cap_reached"
    elif active:
        status = "partial_retry_required"
    else:
        status = "complete_private_review_ready"
    return {
        "version": BACKFILL_VERSION,
        "generated_at": utc_now(),
        "run_id": run_id,
        "status": status,
        "complete": active == 0,
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "state_changed": state_sha256_after != state_sha256_before,
        "source": {
            "artifact_name": "soundcharts-fal-phase2-state-v3",
            "artifact_id": str(source_artifact_id or ""),
            "state_filename": state_path.name,
            "state_sha256_before": state_sha256_before,
            "state_sha256_after": state_sha256_after,
            "phase2_complete": phase2_report.get("complete") is True,
        },
        "policy": {
            "source_endpoint": "/api/v2/song/{uuid}/audience/spotify",
            "identity_source": "numeric plots[].identifier",
            "spotify_id_format": "exact_22_character_base62",
            "eligible_stream_gate_only": True,
            "ambiguous_never_assigned": True,
            "duplicate_within_phase2_never_assigned": True,
            "canonical_catalogue_compared": False,
            "canonical_promotion_allowed": False,
            "raw_responses_persisted": False,
            "maximum_requests": ABSOLUTE_MAX_REQUESTS,
            "minimum_quota_reserve": MIN_QUOTA_RESERVE,
        },
        "requests": {
            "requested_maximum": max_requests,
            "claimed": claimed,
            "rows_attempted": rows_attempted,
            "quota_observed_before": quota_before,
            "quota_observed_after": quota_after,
            "protected_floor": quota_reserve,
            "halt_reason": halt_reason or None,
        },
        "changes": {
            "schema_created": schema_created,
            "rows_seeded": seeded,
            "cached_resolved_ids_merged": cached_resolved_merged,
            "preexisting_private_detail_ids_resolved": preexisting_resolved,
            "resolved_this_run": int(
                connection.execute(
                    """SELECT COUNT(*) FROM fal_phase2_spotify_id_backfill
                         WHERE status='resolved' AND last_run_id=?""",
                    (run_id,),
                ).fetchone()[0]
            ),
        },
        "coverage": {
            "stream_eligible_tracks": eligible_total,
            "stream_eligible_tracks_with_spotify_id": eligible_with_id,
            "stream_eligible_tracks_without_spotify_id": max(
                0, eligible_total - eligible_with_id
            ),
            "active": active,
            "status_counts": counts,
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--phase2-report", type=Path, required=True)
    parser.add_argument("--identity-cache-state", type=Path)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--source-artifact-id", default="")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--quota-reserve", type=int, default=MIN_QUOTA_RESERVE)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--history-days", type=int, default=DEFAULT_HISTORY_DAYS)
    parser.add_argument("--retry-limit", type=int, default=DEFAULT_RETRY_LIMIT)
    parser.add_argument("--as-of")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not 1 <= int(args.max_requests) <= ABSOLUTE_MAX_REQUESTS:
        raise FalSpotifyIdBackfillError(
            f"max_requests must be between 1 and {ABSOLUTE_MAX_REQUESTS}"
        )
    if int(args.quota_reserve) < MIN_QUOTA_RESERVE:
        raise FalSpotifyIdBackfillError(
            f"quota_reserve must protect at least {MIN_QUOTA_RESERVE} calls"
        )
    if not 1 <= int(args.workers) <= MAX_WORKERS:
        raise FalSpotifyIdBackfillError(f"workers must be between 1 and {MAX_WORKERS}")
    if not 1 <= int(args.retry_limit) <= 5:
        raise FalSpotifyIdBackfillError("retry_limit must be between 1 and 5")

    phase2_report = validate_phase2_report(args.phase2_report)
    state_path = args.state.resolve()
    state_sha256_before = file_sha256(state_path)
    connection = open_private_state(state_path)
    run_id = str(args.run_id or os.environ.get("GITHUB_RUN_ID") or uuid_module.uuid4().hex)
    client: Any | None = None
    quota_before: int | None = None
    halt_reason = ""
    rows_attempted = 0
    try:
        validate_report_state_alignment(connection, phase2_report)
        schema_created = ensure_backfill_schema(connection)
        cached_resolved_merged = (
            merge_resolved_identity_cache(
                connection,
                args.identity_cache_state,
                run_id=run_id,
            )
            if args.identity_cache_state is not None
            else 0
        )
        seeded = seed_backfill_rows(connection)
        preexisting_resolved = reconcile_preexisting_detail_ids(connection, run_id)
        active = _count(
            connection,
            """SELECT COUNT(*) FROM fal_phase2_spotify_id_backfill AS b
                 JOIN fal_phase2_stream_gate AS s ON s.track_uuid=b.track_uuid
                WHERE b.status IN ('pending','retry')
                  AND b.attempts<?
                  AND s.gate_status='eligible'
                  AND (s.spotify_id IS NULL OR trim(s.spotify_id)='')""",
            (int(args.retry_limit),),
        )
        if active:
            client = SoundchartsClient(
                os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
                os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
                os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
                quota_reserve=int(args.quota_reserve),
                request_limit=int(args.max_requests),
            )
            client.authenticate()
            client.require_quota_reserve()
            quota_before = finite_int(getattr(client, "quota_remaining", None))
            allowed = client.available_request_budget(min(int(args.max_requests), active))
            if allowed <= 0:
                halt_reason = "quota_reserve"
            else:
                scanner = SpotifyIdBackfillScanner(
                    connection,
                    client,
                    workers=int(args.workers),
                    history_days=int(args.history_days),
                    retry_limit=int(args.retry_limit),
                    as_of=args.as_of,
                    run_id=run_id,
                )
                rows_attempted = scanner.run(max_rows=allowed)
                halt_reason = scanner.halt_reason
        if schema_created or cached_resolved_merged or seeded or preexisting_resolved or active:
            meta_set(connection, "fal_phase2_spotify_id_backfill_last_run_id", run_id)
            meta_set(connection, "fal_phase2_spotify_id_backfill_last_run_at", utc_now())
            connection.commit()
        report = build_report(
            connection,
            state_path=state_path,
            state_sha256_before=state_sha256_before,
            schema_created=schema_created,
            seeded=seeded,
            cached_resolved_merged=cached_resolved_merged,
            preexisting_resolved=preexisting_resolved,
            run_id=run_id,
            source_artifact_id=str(args.source_artifact_id or ""),
            max_requests=int(args.max_requests),
            quota_reserve=int(args.quota_reserve),
            quota_before=quota_before,
            client=client,
            halt_reason=halt_reason,
            rows_attempted=rows_attempted,
            phase2_report=phase2_report,
        )
    finally:
        connection.close()

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
