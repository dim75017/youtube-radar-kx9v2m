#!/usr/bin/env python3
"""Resume the private FAL inventory with bounded track-detail enrichment.

Phase 2 deliberately operates inside the phase-1 SQLite staging checkpoint.
It never writes a repository, canonical export, dashboard file, or acceptance
decision.  Recent tracks are migrated into a deterministic, bounded work queue
only after local evidence has been checked.  Explicit vocal, out-of-scope, or
high-AI evidence is blocked; every unknown remains in human review.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import shutil
import sqlite3
import tempfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
)
from scan_soundcharts_fal_phase1 import (
    DEFAULT_MAINTENANCE_DAILY_REQUESTS,
    DEFAULT_RECENT_DAYS,
    HARD_MIN_QUOTA_RESERVE,
    TARGET_GENRE_MARKERS,
    TERMINAL_CANDIDATE_STATUSES,
    QuotaBudgetPlan,
    _date,
    _identifier_values,
    evidence_decision,
    extract_evidence,
    finite_int,
    meta_get,
    meta_set,
    normalize_text,
    parse_as_of,
    plan_quota_budget,
    utc_now,
)
from soundcharts_fal_artist_gate import (
    BLOCKED as ARTIST_BLOCKED,
    ELIGIBLE as ARTIST_ELIGIBLE,
    REVIEW as ARTIST_REVIEW,
    decide_artist_gate,
    parse_artist_gate_response,
)


PHASE2_STATE_VERSION = 2
PHASE2_REPORT_VERSION = 2
DEFAULT_STATE = Path("soundcharts-fal-phase2-staging.sqlite3")
DEFAULT_REPORT = Path("soundcharts-fal-phase2-report.json")
DEFAULT_MAX_REQUESTS = 500
DEFAULT_MAX_NEW_QUEUE = 2_000
DEFAULT_ACTIVE_QUEUE_CAP = 5_000
DEFAULT_MAINTENANCE_THROUGH = "2026-08-18"
MAX_BATCH_REQUESTS = 40_000
MAX_QUEUE_MIGRATION = 10_000
ARTIST_GATE_BUDGET_PERCENT = 80

ACTIVE_QUEUE_STATUSES = ("pending", "retry")
ACTIVE_ARTIST_GATE_STATUSES = ("pending", "retry")
TERMINAL_REVIEW_STATUSES = (
    "review_evidence_ready",
    "review_instrumental_signal",
    "review_genre_signal",
    "review_metadata_unknown",
    "review_metadata_unavailable",
    "review_request_failed",
)


class FalPhase2Error(RuntimeError):
    """Fail-closed phase-two error which contains no credentials."""


@dataclass(frozen=True)
class QueueMigration:
    requested: int
    capacity_before: int
    selected: int
    pending: int
    locally_blocked: int


@dataclass(frozen=True)
class InterleavedBudget:
    """Logical request split which prevents either work queue from starving."""

    allowed: int
    artist_gate: int
    track_detail: int


@dataclass(frozen=True)
class InterleavedRun:
    budget: InterleavedBudget
    migration: QueueMigration
    halt_reason: str
    artist_requests: int
    track_requests: int


def plan_interleaved_budget(
    allowed: int,
    *,
    artist_gate_active: int,
    track_details_paused: bool,
) -> InterleavedBudget:
    """Reserve track-detail capacity while the finite artist gate advances.

    With both phases available, 80% of a run is assigned to artist gates and
    20% to tracks admitted by completed gates.  A one-call run safely advances
    the prerequisite artist gate; once gates finish, tracks receive the entire
    budget.  A zero-yield pause never blocks the artist gate itself.
    """

    total = max(0, min(MAX_BATCH_REQUESTS, int(allowed)))
    artists = max(0, int(artist_gate_active))
    if total <= 0:
        return InterleavedBudget(0, 0, 0)
    if artists <= 0:
        return InterleavedBudget(total, 0, 0 if track_details_paused else total)
    if track_details_paused or total == 1:
        return InterleavedBudget(total, min(total, artists), 0)

    track_reserve = max(1, total * (100 - ARTIST_GATE_BUDGET_PERCENT) // 100)
    artist_budget = min(artists, total - track_reserve)
    return InterleavedBudget(total, artist_budget, total - artist_budget)


def _combine_migrations(left: QueueMigration, right: QueueMigration) -> QueueMigration:
    return QueueMigration(
        requested=max(left.requested, right.requested),
        capacity_before=max(left.capacity_before, right.capacity_before),
        selected=left.selected + right.selected,
        pending=left.pending + right.pending,
        locally_blocked=left.locally_blocked + right.locally_blocked,
    )


PHASE2_SCHEMA_SQL = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fal_phase2_queue (
  track_uuid TEXT PRIMARY KEY,
  candidate_uuid TEXT NOT NULL,
  release_date TEXT NOT NULL,
  queue_status TEXT NOT NULL,
  local_reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  queued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_queue_status
  ON fal_phase2_queue(queue_status, release_date DESC, track_uuid);
CREATE TABLE IF NOT EXISTS fal_phase2_artist_gate (
  candidate_uuid TEXT PRIMARY KEY,
  candidate_name TEXT NOT NULL DEFAULT '',
  monthly_listeners INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  best_rank INTEGER,
  gate_status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT 'artist_metadata_required',
  career_stage TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  bulk_cursor_track_uuid TEXT NOT NULL DEFAULT '',
  bulk_complete INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_artist_gate_status
  ON fal_phase2_artist_gate(gate_status, candidate_uuid);
CREATE TABLE IF NOT EXISTS fal_phase2_details (
  track_uuid TEXT PRIMARY KEY,
  spotify_id TEXT,
  isrc TEXT,
  title TEXT,
  credit_name TEXT,
  release_date TEXT,
  instrumental_status TEXT NOT NULL DEFAULT 'unknown',
  ai_risk TEXT NOT NULL DEFAULT 'unknown',
  genre_status TEXT NOT NULL DEFAULT 'unknown',
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  enriched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_details_spotify
  ON fal_phase2_details(spotify_id);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_details_isrc
  ON fal_phase2_details(isrc);
CREATE TABLE IF NOT EXISTS fal_phase2_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_uuid TEXT,
  error_code TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
"""


def open_phase1_state(path: Path) -> sqlite3.Connection:
    """Open the immutable phase-one v2 checkpoint read-only."""

    if not path.exists() or path.stat().st_size <= 0:
        raise FalPhase2Error("A non-empty private phase-1 v2 checkpoint is required")
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    stored = meta_get(connection, "state_version")
    if stored != "2":
        connection.close()
        raise FalPhase2Error("Phase 2 requires the phase-1 state_version=2 checkpoint")
    return connection


def open_phase2_state(path: Path) -> sqlite3.Connection:
    """Open the small, independent phase-two queue/results checkpoint."""

    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.executescript(PHASE2_SCHEMA_SQL)
    stored = meta_get(connection, "fal_phase2_state_version")
    if stored is None:
        meta_set(connection, "fal_phase2_state_version", PHASE2_STATE_VERSION)
        meta_set(connection, "fal_phase2_initialized_at", utc_now())
    elif stored != str(PHASE2_STATE_VERSION):
        connection.close()
        raise FalPhase2Error(
            f"Unsupported FAL phase-2 state version ({stored}; expected {PHASE2_STATE_VERSION})"
        )
    connection.commit()
    return connection


def assert_phase1_complete(connection: sqlite3.Connection) -> None:
    """Refuse enrichment until the restored phase-one inventory is complete."""

    seed_total = int(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0])
    track_total = int(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0])
    seed_blockers = int(
        connection.execute(
            "SELECT COUNT(*) FROM seeds WHERE status NOT IN ('complete','alias_superseded')"
        ).fetchone()[0]
    )
    terminal = tuple(sorted(TERMINAL_CANDIDATE_STATUSES))
    placeholders = ",".join("?" for _ in terminal)
    candidate_blockers = int(
        connection.execute(
            f"SELECT COUNT(*) FROM candidates WHERE status NOT IN ({placeholders})", terminal
        ).fetchone()[0]
    )
    failed_candidates = int(
        connection.execute("SELECT COUNT(*) FROM candidates WHERE status='failed'").fetchone()[0]
    )
    unresolved = int(
        connection.execute(
            "SELECT COUNT(*) FROM seed_resolution_pending WHERE status='resolution_pending'"
        ).fetchone()[0]
    )
    if seed_total <= 0 or track_total <= 0 or seed_blockers or candidate_blockers or failed_candidates or unresolved:
        raise FalPhase2Error(
            "Phase-1 checkpoint is not complete "
            f"(seeds={seed_total}, tracks={track_total}, seed_blockers={seed_blockers}, candidate_blockers={candidate_blockers}, "
            f"failed_candidates={failed_candidates}, unresolved_seeds={unresolved})"
        )


def initialize_artist_gate(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
) -> tuple[int, int]:
    """Materialise one resumable metadata gate per completed new artist.

    This deliberately happens before any song-detail bulk work.  It costs at
    most one artist metadata request per candidate and prevents a superstar's
    whole discography from monopolising the paid song queue.
    """

    rows = phase1.execute(
        """SELECT soundcharts_uuid,COALESCE(name,'') AS name,monthly_listeners,
                  source_count,best_rank
             FROM candidates
            WHERE status IN ('review_inventory_complete','review_complete','eligible_complete')
              AND COALESCE(catalog_total,0)>0
            ORDER BY source_count DESC,best_rank,soundcharts_uuid"""
    ).fetchall()
    now = utc_now()
    before = int(phase2.execute("SELECT COUNT(*) FROM fal_phase2_artist_gate").fetchone()[0])
    try:
        phase2.execute("BEGIN IMMEDIATE")
        for row in rows:
            result = phase2.execute(
                """INSERT INTO fal_phase2_artist_gate(
                     candidate_uuid,candidate_name,monthly_listeners,source_count,best_rank,
                     first_seen_at,updated_at)
                   VALUES(?,?,?,?,?,?,?) ON CONFLICT(candidate_uuid) DO UPDATE SET
                     candidate_name=CASE WHEN fal_phase2_artist_gate.candidate_name=''
                                         THEN excluded.candidate_name
                                         ELSE fal_phase2_artist_gate.candidate_name END,
                     monthly_listeners=COALESCE(
                         fal_phase2_artist_gate.monthly_listeners,excluded.monthly_listeners),
                     source_count=MAX(fal_phase2_artist_gate.source_count,excluded.source_count),
                     best_rank=COALESCE(fal_phase2_artist_gate.best_rank,excluded.best_rank)""",
                (
                    str(row["soundcharts_uuid"]),
                    str(row["name"] or ""),
                    finite_int(row["monthly_listeners"]),
                    finite_int(row["source_count"]) or 0,
                    finite_int(row["best_rank"]),
                    now,
                    now,
                ),
            )
        meta_set(phase2, "fal_phase2_artist_gate_initialized_at", now)
        phase2.commit()
    except Exception:
        phase2.rollback()
        raise
    total = int(phase2.execute("SELECT COUNT(*) FROM fal_phase2_artist_gate").fetchone()[0])
    return max(0, total - before), total


def reconcile_phase1_source(
    phase2: sqlite3.Connection,
    phase1_source_id: str,
) -> int:
    """Reopen eligible artist catalogues when phase 1 publishes a new source.

    A completed per-artist cursor only describes the phase-1 checkpoint that
    produced it.  Rewinding eligible artists lets the normal queue insertion
    discover tracks added by a later checkpoint, including UUIDs that sort
    before the former cursor.  Existing queue rows remain the deduplication
    ledger and are deliberately left untouched.
    """

    source_id = str(phase1_source_id or "").strip()
    previous_source = meta_get(phase2, "fal_phase2_phase1_source_id") or ""
    if not source_id or source_id == previous_source:
        return 0

    now = utc_now()
    try:
        phase2.execute("BEGIN IMMEDIATE")
        phase2.execute(
            "DELETE FROM meta WHERE key IN ('fal_phase2_queue_cursor_rowid','fal_phase2_queue_cursor_release_date','fal_phase2_queue_cursor_uuid')"
        )
        reopened = phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET bulk_cursor_track_uuid='',bulk_complete=0,updated_at=?
                WHERE gate_status='eligible'""",
            (now,),
        ).rowcount
        meta_set(phase2, "fal_phase2_phase1_source_id", source_id)
        meta_set(phase2, "fal_phase2_bulk_reopened_at", now)
        phase2.commit()
    except Exception:
        phase2.rollback()
        raise
    return max(0, int(reopened or 0))


def _safe_evidence(raw: Any) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    try:
        decoded = json.loads(str(raw or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return dict(decoded) if isinstance(decoded, Mapping) else {}


def _evidence_labels(evidence: Mapping[str, Any]) -> tuple[str, str, str]:
    instrumental = "unknown"
    if evidence.get("instrumental") is True:
        instrumental = "instrumental"
    elif evidence.get("instrumental") is False or evidence.get("vocal") is True:
        instrumental = "vocal"

    ai_raw = normalize_text(evidence.get("ai_risk"))
    if ai_raw in {"low", "faible"}:
        ai_risk = "low"
    elif ai_raw in {"high", "elevated", "eleve", "elevé"}:
        ai_risk = "high"
    else:
        ai_risk = "unknown"

    genres = [normalize_text(value) for value in evidence.get("genres", []) if value]
    genre_status = (
        "in_scope"
        if any(any(marker in genre for marker in TARGET_GENRE_MARKERS) for genre in genres)
        else "unknown"
    )
    return instrumental, ai_risk, genre_status


def local_prefilter(evidence: Mapping[str, Any]) -> tuple[str, str]:
    """Block only explicit local evidence; ambiguity remains eligible for detail lookup."""

    decision, reason, _, _ = evidence_decision(evidence)
    if decision in {"blocked_explicit_vocal", "blocked_out_of_scope", "blocked_ai_high"}:
        return decision, reason
    return "pending", "recent_track_requires_phase2_detail"


def migrate_recent_queue(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    *,
    max_new_queue: int,
    active_queue_cap: int,
    recent_days: int,
    as_of: str | dt.date | dt.datetime | None = None,
) -> QueueMigration:
    """Move a deterministic, bounded recent slice into the private queue."""

    requested = max(0, min(MAX_QUEUE_MIGRATION, int(max_new_queue)))
    cap = max(1, min(MAX_QUEUE_MIGRATION, int(active_queue_cap)))
    active = int(
        phase2.execute(
            "SELECT COUNT(*) FROM fal_phase2_queue WHERE queue_status IN ('pending','retry')"
        ).fetchone()[0]
    )
    capacity = max(0, cap - active)
    limit = min(requested, capacity)
    if limit <= 0:
        return QueueMigration(requested, capacity, 0, 0, 0)

    today = parse_as_of(as_of).astimezone(dt.timezone.utc).date()
    cutoff = today - dt.timedelta(days=max(1, int(recent_days)))
    cursor_rowid = finite_int(meta_get(phase2, "fal_phase2_queue_cursor_rowid")) or 0
    rows = phase1.execute(
        """SELECT t.rowid AS source_rowid,t.soundcharts_uuid,t.candidate_uuid,
                  t.release_date,t.evidence_json
             FROM tracks t
             WHERE t.status='review_metadata_pending'
              AND t.rowid>?
              AND date(substr(t.release_date,1,10)) BETWEEN date(?) AND date(?)
            ORDER BY t.rowid
            LIMIT ?""",
        (cursor_rowid, cutoff.isoformat(), today.isoformat(), limit),
    ).fetchall()
    now = utc_now()
    pending = 0
    blocked = 0
    inserted = 0
    try:
        phase2.execute("BEGIN IMMEDIATE")
        for row in rows:
            status, reason = local_prefilter(_safe_evidence(row["evidence_json"]))
            result = phase2.execute(
                """INSERT INTO fal_phase2_queue(
                     track_uuid,candidate_uuid,release_date,queue_status,local_reason,
                     queued_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(track_uuid) DO NOTHING""",
                (
                    row["soundcharts_uuid"],
                    row["candidate_uuid"],
                    row["release_date"],
                    status,
                    reason,
                    now,
                    now,
                ),
            )
            if result.rowcount:
                inserted += 1
                pending += int(status == "pending")
                blocked += int(status != "pending")
        if rows:
            meta_set(phase2, "fal_phase2_queue_cursor_rowid", rows[-1]["source_rowid"])
        meta_set(phase2, "fal_phase2_last_queue_migration_at", now)
        phase2.commit()
    except Exception:
        phase2.rollback()
        raise
    return QueueMigration(requested, capacity, inserted, pending, blocked)


def migrate_gated_track_queue(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    *,
    max_new_queue: int,
    active_queue_cap: int,
    recent_days: int,
    as_of: str | dt.date | dt.datetime | None = None,
) -> QueueMigration:
    """Queue recent tracks only for artists explicitly admitted by the gate.

    Progress is kept per artist rather than with a global track rowid.  That
    prevents a few giant discographies from monopolising the queue and avoids
    skipping artists whose metadata gate was completed later.
    """

    requested = max(0, min(MAX_QUEUE_MIGRATION, int(max_new_queue)))
    cap = max(1, min(MAX_QUEUE_MIGRATION, int(active_queue_cap)))
    active = int(
        phase2.execute(
            "SELECT COUNT(*) FROM fal_phase2_queue WHERE queue_status IN ('pending','retry')"
        ).fetchone()[0]
    )
    capacity = max(0, cap - active)
    target = min(requested, capacity)
    if target <= 0:
        return QueueMigration(requested, capacity, 0, 0, 0)

    today = parse_as_of(as_of).astimezone(dt.timezone.utc).date()
    cutoff = today - dt.timedelta(days=max(1, int(recent_days)))
    gates = phase2.execute(
        """SELECT candidate_uuid,bulk_cursor_track_uuid FROM fal_phase2_artist_gate
            WHERE gate_status='eligible' AND bulk_complete=0
            ORDER BY candidate_uuid"""
    ).fetchall()
    inserted = pending = blocked = 0
    now = utc_now()
    try:
        phase2.execute("BEGIN IMMEDIATE")
        for gate in gates:
            if inserted >= target:
                break
            candidate_uuid = str(gate["candidate_uuid"])
            cursor = str(gate["bulk_cursor_track_uuid"] or "")
            remaining = target - inserted
            rows = phase1.execute(
                """SELECT t.soundcharts_uuid,t.candidate_uuid,t.release_date,t.evidence_json
                     FROM candidate_tracks ct
                     JOIN tracks t ON t.soundcharts_uuid=ct.track_uuid
                    WHERE ct.candidate_uuid=?
                      AND t.status='review_metadata_pending'
                      AND t.soundcharts_uuid>?
                      AND date(substr(t.release_date,1,10)) BETWEEN date(?) AND date(?)
                    ORDER BY t.soundcharts_uuid
                    LIMIT ?""",
                (
                    candidate_uuid,
                    cursor,
                    cutoff.isoformat(),
                    today.isoformat(),
                    remaining + 1,
                ),
            ).fetchall()
            selected = rows[:remaining]
            for row in selected:
                status, reason = local_prefilter(_safe_evidence(row["evidence_json"]))
                result = phase2.execute(
                    """INSERT INTO fal_phase2_queue(
                         track_uuid,candidate_uuid,release_date,queue_status,local_reason,
                         queued_at,updated_at)
                       VALUES(?,?,?,?,?,?,?) ON CONFLICT(track_uuid) DO NOTHING""",
                    (
                        str(row["soundcharts_uuid"]),
                        candidate_uuid,
                        str(row["release_date"] or ""),
                        status,
                        reason,
                        now,
                        now,
                    ),
                )
                if result.rowcount:
                    inserted += 1
                    pending += int(status == "pending")
                    blocked += int(status != "pending")
            if selected:
                phase2.execute(
                    """UPDATE fal_phase2_artist_gate SET bulk_cursor_track_uuid=?,
                              bulk_complete=?,updated_at=? WHERE candidate_uuid=?""",
                    (
                        str(selected[-1]["soundcharts_uuid"]),
                        int(len(rows) <= remaining),
                        now,
                        candidate_uuid,
                    ),
                )
            elif not rows:
                phase2.execute(
                    "UPDATE fal_phase2_artist_gate SET bulk_complete=1,updated_at=? WHERE candidate_uuid=?",
                    (now, candidate_uuid),
                )
        meta_set(phase2, "fal_phase2_last_gated_queue_migration_at", now)
        phase2.commit()
    except Exception:
        phase2.rollback()
        raise
    return QueueMigration(requested, capacity, inserted, pending, blocked)


def _count_by_status(connection: sqlite3.Connection, table: str, field: str) -> dict[str, int]:
    return {
        str(row[0]): int(row[1])
        for row in connection.execute(
            f"SELECT {field},COUNT(*) FROM {table} GROUP BY {field} ORDER BY {field}"
        )
    }


def evidence_yield(connection: sqlite3.Connection) -> dict[str, int | float]:
    row = connection.execute(
        """SELECT COUNT(*) AS sampled,
                  SUM(CASE WHEN instrumental_status<>'unknown'
                                OR ai_risk<>'unknown'
                                OR genre_status<>'unknown'
                                OR decision IN ('blocked_explicit_vocal','blocked_out_of_scope','blocked_ai_high')
                           THEN 1 ELSE 0 END) AS useful_signal,
                  SUM(CASE WHEN decision='review_evidence_ready' THEN 1 ELSE 0 END) AS evidence_ready
             FROM fal_phase2_details"""
    ).fetchone()
    sampled = int(row["sampled"] or 0)
    useful = int(row["useful_signal"] or 0)
    ready = int(row["evidence_ready"] or 0)
    return {
        "sampled": sampled,
        "useful_signal": useful,
        "evidence_ready": ready,
        "useful_signal_rate": (useful / sampled) if sampled else 0.0,
        "evidence_ready_rate": (ready / sampled) if sampled else 0.0,
    }


def canary_zero_yield(connection: sqlite3.Connection, minimum_sample: int) -> bool:
    stats = evidence_yield(connection)
    return int(stats["sampled"]) >= max(1, int(minimum_sample)) and int(stats["useful_signal"]) == 0


class ArtistGateScanner:
    """Screen candidate artists once before opening any discography bulk."""

    def __init__(
        self,
        phase2: sqlite3.Connection,
        client: Any,
        *,
        workers: int,
        retry_limit: int,
    ) -> None:
        self.phase2 = phase2
        self.client = client
        self.workers = max(1, int(workers))
        self.retry_limit = max(1, int(retry_limit))
        self.halt_reason: str | None = None

    def _record_error(self, uuid: str, code: str) -> None:
        self.phase2.execute(
            "INSERT INTO fal_phase2_errors(track_uuid,error_code,observed_at) VALUES(?,?,?)",
            (uuid, f"artist_gate:{code}", utc_now()),
        )

    def _fetch_batch(self, rows: Sequence[sqlite3.Row]) -> tuple[dict[str, Any], dict[str, str]]:
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}

        def fetch(row: sqlite3.Row) -> tuple[str, Any]:
            uuid = str(row["candidate_uuid"])
            return uuid, self.client.get(f"/api/v2/artist/{urllib.parse.quote(uuid)}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(fetch, row): str(row["candidate_uuid"]) for row in rows}
            for future in concurrent.futures.as_completed(futures):
                uuid = futures[future]
                try:
                    result_uuid, payload = future.result()
                    results[result_uuid] = payload
                except SoundchartsRequestLimitError:
                    errors[uuid] = "request_limit"
                    self.halt_reason = "request_limit"
                except SoundchartsQuotaReserveError:
                    errors[uuid] = "quota_reserve"
                    self.halt_reason = "quota_reserve"
                except SoundchartsDataUnavailableError:
                    errors[uuid] = "unavailable"
                except (SoundchartsError, OSError, RuntimeError):
                    errors[uuid] = "request_failed"
        return results, errors

    def scan_batch(self, max_items: int | None = None) -> bool:
        limit = self.workers if max_items is None else min(self.workers * 4, max(0, int(max_items)))
        if limit <= 0:
            return False
        rows = self.phase2.execute(
            """SELECT * FROM fal_phase2_artist_gate
                WHERE gate_status IN ('pending','retry')
                ORDER BY source_count DESC,best_rank,monthly_listeners,candidate_uuid LIMIT ?""",
            (limit,),
        ).fetchall()
        if not rows:
            return False
        results, errors = self._fetch_batch(rows)
        by_uuid = {str(row["candidate_uuid"]): row for row in rows}
        now = utc_now()
        for uuid, response in results.items():
            evidence = parse_artist_gate_response(response)
            status, reason = decide_artist_gate(evidence)
            # Keep the public constants out of the checkpoint contract while
            # preserving their fail-closed meaning.
            if status not in {ARTIST_ELIGIBLE, ARTIST_BLOCKED, ARTIST_REVIEW}:
                status, reason = ARTIST_REVIEW, "invalid_gate_decision"
            self.phase2.execute(
                """UPDATE fal_phase2_artist_gate
                      SET gate_status=?,reason=?,career_stage=?,evidence_json=?,
                          attempts=0,error_code=NULL,updated_at=?
                    WHERE candidate_uuid=?""",
                (
                    status,
                    reason,
                    str(evidence.get("careerStage") or ""),
                    json.dumps(evidence, ensure_ascii=False, sort_keys=True),
                    now,
                    uuid,
                ),
            )
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                status, reason = "review_unavailable", "artist_metadata_unavailable"
                attempts = int(row["attempts"] or 0)
            elif code in {"request_limit", "quota_reserve"}:
                self.phase2.execute(
                    "UPDATE fal_phase2_artist_gate SET error_code=?,updated_at=? WHERE candidate_uuid=?",
                    (code, now, uuid),
                )
                self._record_error(uuid, code)
                continue
            else:
                attempts = int(row["attempts"] or 0) + 1
                status = "review_request_failed" if attempts >= self.retry_limit else "retry"
                reason = (
                    "bounded_artist_metadata_retries_exhausted"
                    if status == "review_request_failed"
                    else "transient_artist_metadata_retry"
                )
            self.phase2.execute(
                """UPDATE fal_phase2_artist_gate SET gate_status=?,reason=?,attempts=?,
                          error_code=?,updated_at=? WHERE candidate_uuid=?""",
                (status, reason, attempts, code, now, uuid),
            )
            self._record_error(uuid, code)
        self.phase2.commit()
        return True

    def run(self, max_requests: int | None = None) -> str:
        start = int(getattr(self.client, "requests_claimed", 0) or 0)
        budget = None if max_requests is None else max(0, int(max_requests))
        while not self.halt_reason:
            remaining = None
            if budget is not None:
                used = max(0, int(getattr(self.client, "requests_claimed", 0) or 0) - start)
                remaining = budget - used
                if remaining <= 0:
                    break
            if not self.scan_batch(max_items=remaining):
                break
        return self.halt_reason or "idle"


class Phase2Scanner:
    def __init__(
        self,
        phase1: sqlite3.Connection,
        phase2: sqlite3.Connection,
        client: Any,
        *,
        workers: int,
        retry_limit: int,
        canary_min_sample: int,
        continue_zero_yield: bool,
    ) -> None:
        self.phase1 = phase1
        self.phase2 = phase2
        self.client = client
        self.workers = max(1, int(workers))
        self.retry_limit = max(1, int(retry_limit))
        self.canary_min_sample = max(1, int(canary_min_sample))
        self.continue_zero_yield = bool(continue_zero_yield)
        self.halt_reason: str | None = None

    def _record_error(self, uuid: str, code: str) -> None:
        self.phase2.execute(
            "INSERT INTO fal_phase2_errors(track_uuid,error_code,observed_at) VALUES(?,?,?)",
            (uuid, code, utc_now()),
        )

    def _fetch_batch(self, rows: Sequence[sqlite3.Row]) -> tuple[dict[str, Any], dict[str, str]]:
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}

        def fetch(row: sqlite3.Row) -> tuple[str, Any]:
            uuid = str(row["track_uuid"])
            path = f"/api/v2.25/song/{urllib.parse.quote(uuid)}"
            return uuid, self.client.get(path)

        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(fetch, row): str(row["track_uuid"]) for row in rows}
            for future in concurrent.futures.as_completed(futures):
                uuid = futures[future]
                try:
                    result_uuid, payload = future.result()
                    results[result_uuid] = payload
                except SoundchartsRequestLimitError:
                    errors[uuid] = "request_limit"
                    self.halt_reason = "request_limit"
                except SoundchartsQuotaReserveError:
                    errors[uuid] = "quota_reserve"
                    self.halt_reason = "quota_reserve"
                except SoundchartsDataUnavailableError:
                    errors[uuid] = "unavailable"
                except (SoundchartsError, OSError, RuntimeError):
                    errors[uuid] = "request_failed"
        return results, errors

    def _is_duplicate(self, uuid: str, spotify_id: str, isrc: str) -> bool:
        if not spotify_id and not isrc:
            return False
        matches: list[str] = []
        # Keep the predicates separate so SQLite can use the phase-1 Spotify
        # and ISRC indexes instead of scanning the 5.2M-row inventory for an OR.
        if spotify_id:
            base = self.phase1.execute(
                """SELECT MIN(soundcharts_uuid) FROM tracks
                    WHERE soundcharts_uuid<>? AND status<>'duplicate_existing' AND spotify_id=?""",
                (uuid, spotify_id),
            ).fetchone()
            enriched = self.phase2.execute(
                """SELECT MIN(track_uuid) FROM fal_phase2_details
                    WHERE track_uuid<>? AND spotify_id=?""",
                (uuid, spotify_id),
            ).fetchone()
            matches.extend(str(value) for value in (base[0], enriched[0]) if value)
        if isrc:
            base = self.phase1.execute(
                """SELECT MIN(soundcharts_uuid) FROM tracks
                    WHERE soundcharts_uuid<>? AND status<>'duplicate_existing' AND isrc=?""",
                (uuid, isrc),
            ).fetchone()
            enriched = self.phase2.execute(
                """SELECT MIN(track_uuid) FROM fal_phase2_details
                    WHERE track_uuid<>? AND isrc=?""",
                (uuid, isrc),
            ).fetchone()
            matches.extend(str(value) for value in (base[0], enriched[0]) if value)
        return bool(matches and min(matches) < uuid)

    def _store_detail(self, row: sqlite3.Row, response: Any) -> None:
        uuid = str(row["track_uuid"])
        source = self.phase1.execute(
            "SELECT spotify_id,isrc,title,credit_name,release_date FROM tracks WHERE soundcharts_uuid=?",
            (uuid,),
        ).fetchone()
        if source is None:
            raise FalPhase2Error(f"Queued track disappeared from phase-1 staging: {uuid}")
        obj = (
            response.get("object")
            if isinstance(response, Mapping) and isinstance(response.get("object"), Mapping)
            else response
        )
        spotify_id, isrc = _identifier_values(response)
        spotify_id = spotify_id or str(source["spotify_id"] or "")
        isrc = (isrc or str(source["isrc"] or "")).upper()
        evidence = extract_evidence(response)
        blocked, reason, _, _ = evidence_decision(evidence)
        instrumental, ai_risk, genre_status = _evidence_labels(evidence)

        if self._is_duplicate(uuid, spotify_id, isrc):
            decision, reason = "duplicate_existing", "duplicate_identifier_found_in_private_staging"
        elif blocked:
            decision = blocked
        elif instrumental == "instrumental" and ai_risk == "low" and genre_status == "in_scope":
            decision, reason = "review_evidence_ready", "source_evidence_requires_human_validation"
        elif instrumental == "instrumental":
            decision, reason = (
                "review_instrumental_signal",
                "soundcharts_instrumentalness_requires_human_validation",
            )
        elif genre_status == "in_scope":
            decision, reason = (
                "review_genre_signal",
                "target_genre_requires_instrumental_confirmation",
            )
        else:
            decision, reason = "review_metadata_unknown", "instrumental_or_ai_confirmation_required"

        title = str(source["title"] or "")
        credit = str(source["credit_name"] or "")
        release = str(source["release_date"] or "")
        if isinstance(obj, Mapping):
            title = str(obj.get("name") or obj.get("title") or title)
            credit = str(obj.get("creditName") or obj.get("artistName") or credit)
            release = _date(obj.get("releaseDate") or obj.get("release_date")) or release
        now = utc_now()
        self.phase2.execute(
            """INSERT INTO fal_phase2_details(
                 track_uuid,spotify_id,isrc,title,credit_name,release_date,
                 instrumental_status,ai_risk,genre_status,decision,reason,evidence_json,enriched_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(track_uuid) DO UPDATE SET
                 spotify_id=excluded.spotify_id,isrc=excluded.isrc,title=excluded.title,
                 credit_name=excluded.credit_name,release_date=excluded.release_date,
                 instrumental_status=excluded.instrumental_status,ai_risk=excluded.ai_risk,
                 genre_status=excluded.genre_status,decision=excluded.decision,
                 reason=excluded.reason,evidence_json=excluded.evidence_json,
                 enriched_at=excluded.enriched_at""",
            (
                uuid,
                spotify_id,
                isrc,
                title,
                credit,
                release,
                instrumental,
                ai_risk,
                genre_status,
                decision,
                reason,
                json.dumps(evidence, ensure_ascii=False, sort_keys=True),
                now,
            ),
        )
        self.phase2.execute(
            """UPDATE fal_phase2_queue
                  SET queue_status=?,local_reason=?,attempts=0,error_code=NULL,updated_at=?
                WHERE track_uuid=?""",
            (decision, reason, now, uuid),
        )

    def _store_unavailable(self, row: sqlite3.Row) -> None:
        uuid = str(row["track_uuid"])
        source = self.phase1.execute(
            "SELECT spotify_id,isrc,title,credit_name,release_date FROM tracks WHERE soundcharts_uuid=?",
            (uuid,),
        ).fetchone()
        now = utc_now()
        self.phase2.execute(
            """INSERT INTO fal_phase2_details(
                 track_uuid,spotify_id,isrc,title,credit_name,release_date,
                 instrumental_status,ai_risk,genre_status,decision,reason,evidence_json,enriched_at)
               VALUES(?,?,?,?,?,?,'unknown','unknown','unknown',
                      'review_metadata_unavailable','soundcharts_song_detail_unavailable','{}',?)
               ON CONFLICT(track_uuid) DO UPDATE SET
                 decision='review_metadata_unavailable',reason='soundcharts_song_detail_unavailable',
                 enriched_at=excluded.enriched_at""",
            (
                uuid,
                str(source["spotify_id"] or ""),
                str(source["isrc"] or ""),
                str(source["title"] or ""),
                str(source["credit_name"] or ""),
                str(source["release_date"] or ""),
                now,
            ),
        )
        self.phase2.execute(
            """UPDATE fal_phase2_queue SET queue_status='review_metadata_unavailable',
                      local_reason='soundcharts_song_detail_unavailable',error_code='unavailable',
                      updated_at=? WHERE track_uuid=?""",
            (now, uuid),
        )
        self._record_error(uuid, "unavailable")

    def scan_batch(self, max_items: int | None = None) -> bool:
        limit = self.workers if max_items is None else min(self.workers, max(0, int(max_items)))
        if limit <= 0:
            return False
        rows = self.phase2.execute(
            """SELECT * FROM fal_phase2_queue
                WHERE queue_status IN ('pending','retry')
                ORDER BY release_date DESC,track_uuid LIMIT ?""",
            (limit,),
        ).fetchall()
        if not rows:
            return False
        by_uuid = {str(row["track_uuid"]): row for row in rows}
        results, errors = self._fetch_batch(rows)
        for uuid, response in results.items():
            self._store_detail(by_uuid[uuid], response)
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                self._store_unavailable(row)
                continue
            if code in {"request_limit", "quota_reserve"}:
                self.phase2.execute(
                    "UPDATE fal_phase2_queue SET error_code=?,updated_at=? WHERE track_uuid=?",
                    (code, utc_now(), uuid),
                )
                self._record_error(uuid, code)
                continue
            attempts = int(row["attempts"] or 0) + 1
            status = "review_request_failed" if attempts >= self.retry_limit else "retry"
            reason = "bounded_retries_exhausted" if status == "review_request_failed" else "transient_request_retry"
            self.phase2.execute(
                """UPDATE fal_phase2_queue SET queue_status=?,local_reason=?,attempts=?,
                          error_code=?,updated_at=? WHERE track_uuid=?""",
                (status, reason, attempts, code, utc_now(), uuid),
            )
            self._record_error(uuid, code)
        self.phase2.commit()
        return True

    def run(self, max_requests: int | None = None) -> str:
        start = int(getattr(self.client, "requests_claimed", 0) or 0)
        budget = None if max_requests is None else max(0, int(max_requests))
        while not self.halt_reason:
            remaining = None
            if budget is not None:
                used = max(0, int(getattr(self.client, "requests_claimed", 0) or 0) - start)
                remaining = budget - used
                if remaining <= 0:
                    break
            if not self.scan_batch(max_items=remaining):
                break
            if not self.continue_zero_yield and canary_zero_yield(self.phase2, self.canary_min_sample):
                self.halt_reason = "canary_zero_evidence_yield"
        return self.halt_reason or "idle"


def run_interleaved_batches(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    client: Any,
    *,
    allowed_requests: int,
    max_new_queue: int,
    active_queue_cap: int,
    recent_days: int,
    as_of: str | dt.date | dt.datetime | None,
    workers: int,
    retry_limit: int,
    canary_min_sample: int,
    continue_zero_yield: bool,
    track_details_paused: bool,
    initial_migration: QueueMigration | None = None,
) -> InterleavedRun:
    """Alternate bounded artist and track batches under one safe run budget."""

    artist_active = int(
        phase2.execute(
            """SELECT COUNT(*) FROM fal_phase2_artist_gate
                WHERE gate_status IN ('pending','retry')"""
        ).fetchone()[0]
    )
    budget = plan_interleaved_budget(
        allowed_requests,
        artist_gate_active=artist_active,
        track_details_paused=track_details_paused,
    )
    migration = initial_migration or QueueMigration(0, 0, 0, 0, 0)
    if budget.allowed <= 0:
        return InterleavedRun(budget, migration, "idle", 0, 0)

    worker_count = max(1, min(10, int(workers)))
    artist_scanner = ArtistGateScanner(
        phase2,
        client,
        workers=worker_count,
        retry_limit=max(1, int(retry_limit)),
    )
    track_scanner = Phase2Scanner(
        phase1,
        phase2,
        client,
        workers=worker_count,
        retry_limit=max(1, int(retry_limit)),
        canary_min_sample=max(1, int(canary_min_sample)),
        continue_zero_yield=continue_zero_yield,
    )
    start_claimed = int(getattr(client, "requests_claimed", 0) or 0)
    artist_remaining = budget.artist_gate
    track_remaining = budget.track_detail
    artist_requests = 0
    track_requests = 0
    logical_spent = 0
    halt = "idle"
    tracks_paused = track_details_paused

    while logical_spent < budget.allowed:
        progressed = False
        actual_spent = max(
            0,
            int(getattr(client, "requests_claimed", 0) or 0) - start_claimed,
        )
        total_remaining = budget.allowed - max(logical_spent, actual_spent)
        if artist_remaining > 0 and total_remaining > 0:
            artist_limit = min(artist_remaining, total_remaining, worker_count * 4)
            before = int(getattr(client, "requests_claimed", 0) or 0)
            did_artist_work = artist_scanner.scan_batch(max_items=artist_limit)
            after = int(getattr(client, "requests_claimed", 0) or 0)
            claimed = max(0, after - before)
            if did_artist_work:
                spent = max(1, claimed)
                artist_remaining = max(0, artist_remaining - spent)
                logical_spent += spent
                artist_requests += claimed
                progressed = True
            else:
                artist_remaining = 0
            if artist_scanner.halt_reason:
                halt = artist_scanner.halt_reason

        if not tracks_paused:
            gated = migrate_gated_track_queue(
                phase1,
                phase2,
                max_new_queue=max_new_queue,
                active_queue_cap=active_queue_cap,
                recent_days=recent_days,
                as_of=as_of,
            )
            migration = _combine_migrations(migration, gated)

        actual_spent = max(
            0,
            int(getattr(client, "requests_claimed", 0) or 0) - start_claimed,
        )
        total_remaining = budget.allowed - max(logical_spent, actual_spent)
        fatal_halt = halt in {"request_limit", "quota_reserve"}
        if not tracks_paused and not fatal_halt and track_remaining > 0 and total_remaining > 0:
            active_tracks = int(
                phase2.execute(
                    """SELECT COUNT(*) FROM fal_phase2_queue
                        WHERE queue_status IN ('pending','retry')"""
                ).fetchone()[0]
            )
            if active_tracks > 0:
                track_limit = min(track_remaining, total_remaining, worker_count)
                before = int(getattr(client, "requests_claimed", 0) or 0)
                did_track_work = track_scanner.scan_batch(max_items=track_limit)
                after = int(getattr(client, "requests_claimed", 0) or 0)
                claimed = max(0, after - before)
                if did_track_work:
                    spent = max(1, claimed)
                    track_remaining = max(0, track_remaining - spent)
                    logical_spent += spent
                    track_requests += claimed
                    progressed = True
                    if not continue_zero_yield and canary_zero_yield(
                        phase2, max(1, int(canary_min_sample))
                    ):
                        track_scanner.halt_reason = "canary_zero_evidence_yield"
                        halt = track_scanner.halt_reason
                        # The canary only pauses song-detail spend.  Reassign
                        # the untouched slice to prerequisite artist gates so
                        # the automatic run still advances safely.
                        artist_remaining += track_remaining
                        track_remaining = 0
                        tracks_paused = True
            if track_scanner.halt_reason:
                halt = track_scanner.halt_reason

        if halt in {"request_limit", "quota_reserve"}:
            break
        if not progressed or (artist_remaining <= 0 and track_remaining <= 0):
            break

    return InterleavedRun(
        budget=budget,
        migration=migration,
        halt_reason=halt,
        artist_requests=artist_requests,
        track_requests=track_requests,
    )


def build_report(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    *,
    migration: QueueMigration,
    recent_days: int,
    as_of: str | dt.date | dt.datetime | None,
    requests_claimed: int = 0,
    quota_remaining: int | None = None,
    halt_reason: str | None = None,
    budget_plan: QuotaBudgetPlan | None = None,
    interleaved_run: InterleavedRun | None = None,
    active_queue_cap: int = DEFAULT_ACTIVE_QUEUE_CAP,
    canary_min_sample: int = DEFAULT_MAX_REQUESTS,
) -> dict[str, Any]:
    today = parse_as_of(as_of).astimezone(dt.timezone.utc).date()
    cutoff = today - dt.timedelta(days=max(1, int(recent_days)))
    source = phase1.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status='review_metadata_pending' THEN 1 ELSE 0 END) AS review_pending,
                  SUM(CASE WHEN status='review_metadata_pending'
                                AND date(substr(release_date,1,10)) BETWEEN date(?) AND date(?)
                           THEN 1 ELSE 0 END) AS eligible_recent,
                  SUM(CASE WHEN status='review_metadata_pending'
                                AND date(substr(release_date,1,10)) IS NULL
                           THEN 1 ELSE 0 END) AS release_unknown,
                  SUM(CASE WHEN status='review_metadata_pending'
                                AND date(substr(release_date,1,10)) < date(?)
                           THEN 1 ELSE 0 END) AS release_old,
                  SUM(CASE WHEN status='review_metadata_pending'
                                AND date(substr(release_date,1,10)) > date(?)
                           THEN 1 ELSE 0 END) AS release_future
             FROM tracks""",
        (cutoff.isoformat(), today.isoformat(), cutoff.isoformat(), today.isoformat()),
    ).fetchone()
    queue_counts = _count_by_status(phase2, "fal_phase2_queue", "queue_status")
    decision_counts = _count_by_status(phase2, "fal_phase2_details", "decision")
    artist_gate_counts = _count_by_status(
        phase2, "fal_phase2_artist_gate", "gate_status"
    )
    active = sum(queue_counts.get(status, 0) for status in ACTIVE_QUEUE_STATUSES)
    artist_gate_active = sum(
        artist_gate_counts.get(status, 0) for status in ACTIVE_ARTIST_GATE_STATUSES
    )
    eligible_bulk_remaining = int(
        phase2.execute(
            """SELECT COUNT(*) FROM fal_phase2_artist_gate
                WHERE gate_status='eligible' AND bulk_complete=0"""
        ).fetchone()[0]
    )
    eligible_recent = int(source["eligible_recent"] or 0)
    queued_recent = int(
        phase2.execute(
            """SELECT COUNT(*) FROM fal_phase2_queue
                WHERE date(substr(release_date,1,10)) BETWEEN date(?) AND date(?)""",
            (cutoff.isoformat(), today.isoformat()),
        ).fetchone()[0]
    )
    yield_stats = evidence_yield(phase2)
    complete = artist_gate_active == 0 and eligible_bulk_remaining == 0 and active == 0
    if halt_reason == "canary_zero_evidence_yield":
        status = "paused_zero_evidence_yield"
    elif halt_reason == "maintenance_quota_protected":
        status = "quota_protected"
    elif halt_reason in {"request_limit", "quota_reserve"}:
        status = "partial"
    elif complete:
        status = "enrichment_complete_review_required"
    elif active or artist_gate_active:
        status = "partial"
    else:
        status = "ready"
    return {
        "version": PHASE2_REPORT_VERSION,
        "phase": "fal_phase2",
        "generated_at": utc_now(),
        "status": status,
        "complete": complete,
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "source_checkpoint": {
            "phase1_state_version": finite_int(meta_get(phase1, "state_version")),
            "phase2_state_version": finite_int(meta_get(phase2, "fal_phase2_state_version")),
            "phase1_complete_required": True,
        },
        "prefilter": {
            "as_of": today.isoformat(),
            "recent_days": max(1, int(recent_days)),
            "release_cutoff": cutoff.isoformat(),
            "tracks_total": int(source["total"] or 0),
            "phase1_review_metadata_pending": int(source["review_pending"] or 0),
            # This is the raw phase-1 review pool before the artist gate.  It
            # must not be presented as paid-call eligible: only tracks reached
            # through an explicitly eligible artist gate can enter phase 2.
            "recent_review_pending_known_date_before_artist_gate": eligible_recent,
            "release_date_unknown_kept_out_of_calls": int(source["release_unknown"] or 0),
            "release_too_old_kept_out_of_calls": int(source["release_old"] or 0),
            "future_release_kept_out_of_calls": int(source["release_future"] or 0),
            "recent_tracks_present_in_phase2_queue": queued_recent,
            "remaining_gated_work_is_tracked_by": (
                "artist_gate.eligible_bulk_remaining_and_queue.active"
            ),
            "explicit_vocal_out_of_scope_or_ai_high": "blocked_without_detail_call",
            "instrumental_or_ai_unknown": "review",
        },
        "artist_gate": {
            "endpoint": "/api/v2/artist/{uuid}",
            "status_counts": artist_gate_counts,
            "active": artist_gate_active,
            "eligible_bulk_remaining": eligible_bulk_remaining,
            "superstars_blocked_by_career_stage": True,
            "unknown_genre_stays_in_review": True,
            "ai_risk_is_never_inferred": True,
        },
        "queue": {
            "active_cap": max(1, min(MAX_QUEUE_MIGRATION, int(active_queue_cap))),
            "migration_requested": migration.requested,
            "migrated_this_run": migration.selected,
            "pending_after_local_prefilter": migration.pending,
            "locally_blocked_this_run": migration.locally_blocked,
            "status_counts": queue_counts,
            "active": active,
        },
        "work": {
            "active": artist_gate_active + active,
            "artist_gate_active": artist_gate_active,
            "track_detail_active": active,
        },
        "details": {
            "enriched": int(phase2.execute("SELECT COUNT(*) FROM fal_phase2_details").fetchone()[0]),
            "decision_counts": decision_counts,
            "unknowns_are_never_accepted": True,
            "human_validation_required_before_any_promotion": True,
            "yield": yield_stats,
            "canary_min_sample": max(1, int(canary_min_sample)),
            "zero_yield_schedule_paused": (
                int(yield_stats["sampled"]) >= max(1, int(canary_min_sample))
                and int(yield_stats["useful_signal"]) == 0
            ),
        },
        "requests": {
            "claimed_this_run": int(requests_claimed),
            "quota_remaining": quota_remaining,
            "halt_reason": halt_reason,
            "allocation": (
                {
                    "strategy": "weighted_artist_gate_with_track_detail_reserve",
                    "planned_allowed": interleaved_run.budget.allowed,
                    "planned_artist_gate": interleaved_run.budget.artist_gate,
                    "planned_track_detail": interleaved_run.budget.track_detail,
                    "claimed_artist_gate": interleaved_run.artist_requests,
                    "claimed_track_detail": interleaved_run.track_requests,
                }
                if interleaved_run is not None
                else None
            ),
            "preflight": (
                {
                    "requested": budget_plan.requested,
                    "allowed": budget_plan.allowed,
                    "hard_reserve": budget_plan.hard_reserve,
                    "maintenance_daily_requests": budget_plan.maintenance_daily_requests,
                    "maintenance_days": budget_plan.maintenance_days,
                    "maintenance_reserve": budget_plan.maintenance_reserve,
                    "protected_floor": budget_plan.protected_floor,
                    "maintenance_through": budget_plan.maintenance_through,
                }
                if budget_plan is not None
                else None
            ),
        },
        "publication": {
            "canonical": "disabled",
            "dashboard": "disabled",
            "approval": "requires_explicit_Dim_validation",
        },
    }


def write_report(path: Path, report: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase1-state", type=Path, required=True)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--phase1-source-id", default="")
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--max-new-queue", type=int, default=DEFAULT_MAX_NEW_QUEUE)
    parser.add_argument("--active-queue-cap", type=int, default=DEFAULT_ACTIVE_QUEUE_CAP)
    parser.add_argument("--recent-days", type=int, default=DEFAULT_RECENT_DAYS)
    parser.add_argument("--quota-reserve", type=int, default=HARD_MIN_QUOTA_RESERVE)
    parser.add_argument(
        "--maintenance-daily-requests",
        type=int,
        default=DEFAULT_MAINTENANCE_DAILY_REQUESTS,
    )
    parser.add_argument("--maintenance-through", default=DEFAULT_MAINTENANCE_THROUGH)
    parser.add_argument("--budget-as-of", help=argparse.SUPPRESS)
    parser.add_argument("--as-of", help="UTC date/datetime used only for deterministic recent-date filtering")
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--retry-limit", type=int, default=3)
    parser.add_argument("--canary-min-sample", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--continue-zero-yield", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not 0 <= int(args.max_requests) <= MAX_BATCH_REQUESTS:
        raise FalPhase2Error(f"max_requests must be between 0 and {MAX_BATCH_REQUESTS}")
    if not 0 <= int(args.max_new_queue) <= MAX_QUEUE_MIGRATION:
        raise FalPhase2Error(f"max_new_queue must be between 0 and {MAX_QUEUE_MIGRATION}")
    phase1 = open_phase1_state(args.phase1_state)
    dry_run_dir: tempfile.TemporaryDirectory[str] | None = None
    phase2_path = args.state
    if args.dry_run:
        # Preflight must be observational.  Run the exact queue/gate planning
        # against an isolated copy so schema initialization, source-id updates,
        # and queue cursor advances can never alter the resumable checkpoint.
        dry_run_dir = tempfile.TemporaryDirectory(prefix="soundcharts-fal-phase2-dry-run-")
        phase2_path = Path(dry_run_dir.name) / args.state.name
        if args.state.exists():
            shutil.copy2(args.state, phase2_path)
    phase2 = open_phase2_state(phase2_path)
    try:
        assert_phase1_complete(phase1)
        reconcile_phase1_source(phase2, args.phase1_source_id)
        initialize_artist_gate(phase1, phase2)
        paused = not args.continue_zero_yield and canary_zero_yield(
            phase2, args.canary_min_sample
        )
        artist_active = int(
            phase2.execute(
                """SELECT COUNT(*) FROM fal_phase2_artist_gate
                    WHERE gate_status IN ('pending','retry')"""
            ).fetchone()[0]
        )
        migration = QueueMigration(0, 0, 0, 0, 0)
        # A dry run may simulate bounded migration because it operates on the
        # isolated copy above.  Real runs migrate between gate/detail slices so
        # newly admitted artists can yield tracks during that same run.
        if args.dry_run and not paused:
            migration = migrate_gated_track_queue(
                phase1,
                phase2,
                max_new_queue=args.max_new_queue,
                active_queue_cap=args.active_queue_cap,
                recent_days=args.recent_days,
                as_of=args.as_of,
            )
        active = int(
            phase2.execute(
                "SELECT COUNT(*) FROM fal_phase2_queue WHERE queue_status IN ('pending','retry')"
            ).fetchone()[0]
        )
        eligible_bulk_remaining = int(
            phase2.execute(
                """SELECT COUNT(*) FROM fal_phase2_artist_gate
                    WHERE gate_status='eligible' AND bulk_complete=0"""
            ).fetchone()[0]
        )
        if (
            (paused and artist_active == 0)
            or args.dry_run
            or (
                artist_active <= 0
                and active <= 0
                and eligible_bulk_remaining <= 0
            )
            or args.max_requests <= 0
        ):
            report = build_report(
                phase1,
                phase2,
                migration=migration,
                recent_days=args.recent_days,
                as_of=args.as_of,
                halt_reason=(
                    "canary_zero_evidence_yield"
                    if paused and artist_active == 0
                    else ("dry_run" if args.dry_run else None)
                ),
                active_queue_cap=args.active_queue_cap,
                canary_min_sample=args.canary_min_sample,
            )
            write_report(args.report, report)
            print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
            return 0

        client = SoundchartsClient(
            os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
            os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
            os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
            quota_reserve=max(HARD_MIN_QUOTA_RESERVE, int(args.quota_reserve)),
            request_limit=None,
        )
        client.authenticate()
        client.require_quota_reserve()
        plan = plan_quota_budget(
            quota_remaining=getattr(client, "quota_remaining", None),
            requested=args.max_requests,
            maintenance_daily_requests=max(0, int(args.maintenance_daily_requests)),
            maintenance_through=args.maintenance_through,
            as_of=args.budget_as_of,
            hard_reserve=max(HARD_MIN_QUOTA_RESERVE, int(args.quota_reserve)),
        )
        client.request_limit = plan.allowed
        client.quota_reserve = plan.protected_floor
        if plan.allowed <= 0:
            report = build_report(
                phase1,
                phase2,
                migration=migration,
                recent_days=args.recent_days,
                as_of=args.as_of,
                quota_remaining=getattr(client, "quota_remaining", None),
                halt_reason="maintenance_quota_protected",
                budget_plan=plan,
                active_queue_cap=args.active_queue_cap,
                canary_min_sample=args.canary_min_sample,
            )
        else:
            client.require_quota_reserve()
            interleaved = run_interleaved_batches(
                phase1,
                phase2,
                client,
                allowed_requests=plan.allowed,
                max_new_queue=args.max_new_queue,
                active_queue_cap=args.active_queue_cap,
                recent_days=args.recent_days,
                as_of=args.as_of,
                workers=args.workers,
                retry_limit=args.retry_limit,
                canary_min_sample=args.canary_min_sample,
                continue_zero_yield=args.continue_zero_yield,
                track_details_paused=paused,
                initial_migration=migration,
            )
            migration = interleaved.migration
            halt = interleaved.halt_reason
            report = build_report(
                phase1,
                phase2,
                migration=migration,
                recent_days=args.recent_days,
                as_of=args.as_of,
                requests_claimed=int(getattr(client, "requests_claimed", 0)),
                quota_remaining=getattr(client, "quota_remaining", None),
                halt_reason=None if halt == "idle" else halt,
                budget_plan=plan,
                interleaved_run=interleaved,
                active_queue_cap=args.active_queue_cap,
                canary_min_sample=args.canary_min_sample,
            )
        write_report(args.report, report)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        return 0
    finally:
        phase2.close()
        phase1.close()
        if dry_run_dir is not None:
            dry_run_dir.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
