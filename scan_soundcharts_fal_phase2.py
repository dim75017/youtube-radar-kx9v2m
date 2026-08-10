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
import re
import shutil
import sqlite3
import tempfile
import threading
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
    extract_song_audience_points,
)
from scan_soundcharts_fal_phase1 import (
    CATALOG_SCOPE_META_KEY,
    CATALOG_SCOPE_VERSION,
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


PHASE2_STATE_VERSION = 3
PHASE2_REPORT_VERSION = 4
RUN_PROGRESS_VERSION = 1
RUN_PROGRESS_META_KEY = "fal_phase2_run_progress_v1"
DEFAULT_STATE = Path("soundcharts-fal-phase2-staging.sqlite3")
DEFAULT_REPORT = Path("soundcharts-fal-phase2-report.json")
DEFAULT_MAX_REQUESTS = 500
DEFAULT_MAX_NEW_QUEUE = 2_000
DEFAULT_ACTIVE_QUEUE_CAP = 5_000
DEFAULT_MAINTENANCE_THROUGH = "2026-08-18"
MAX_BATCH_REQUESTS = 40_000
MAX_QUEUE_MIGRATION = 10_000
ARTIST_GATE_BUDGET_PERCENT = 80
DEFAULT_MIN_TRACK_STREAMS = 100_000
DEFAULT_STREAM_HISTORY_DAYS = 90
SPOTIFY_TRACK_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")
STREAM_GATE_META_VERSION = "spotify_lifetime_streams_v1"
STREAM_GATE_SEED_DECISIONS = (
    "review_evidence_ready",
    "review_instrumental_signal",
    "review_genre_signal",
    "review_metadata_unknown",
)

ACTIVE_QUEUE_STATUSES = ("pending", "retry")
ACTIVE_ARTIST_GATE_STATUSES = ("pending", "retry")
ACTIVE_STREAM_GATE_STATUSES = ("pending", "retry")
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


class RequestAttemptJournalError(FalPhase2Error):
    """Fail closed when durable per-attempt accounting cannot be written."""


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
    stream_requests: int = 0


def plan_interleaved_budget(
    allowed: int,
    *,
    artist_gate_active: int,
    track_details_paused: bool,
    stream_gate_active: int = 0,
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
    streams = max(0, int(stream_gate_active))
    track_work_paused = track_details_paused and streams <= 0
    if artists <= 0:
        return InterleavedBudget(total, 0, 0 if track_work_paused else total)
    if track_work_paused or total == 1:
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
CREATE TABLE IF NOT EXISTS fal_phase2_stream_gate (
  track_uuid TEXT PRIMARY KEY,
  spotify_id TEXT,
  gate_status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT 'stream_history_required',
  streams_total INTEGER,
  source_date TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  queued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase2_stream_gate_status
  ON fal_phase2_stream_gate(gate_status, track_uuid);
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


def _quota_remaining(client: Any) -> int | None:
    return finite_int(getattr(client, "quota_remaining", None))


class RequestAttemptJournal:
    """Append one durable-enough local record before every paid HTTP attempt.

    ``SoundchartsClient`` calls ``_claim_quota_request`` immediately before an
    HTTP attempt, including retries.  Wrapping that hook lets cancellation in
    the middle of a worker batch retain the exact claimed-attempt count without
    sharing a SQLite connection across worker threads.  A single ``os.write``
    under a lock is visible to the recovery step on the same runner; normal
    completion fsyncs once before the file descriptor is closed.
    """

    def __init__(
        self,
        path: Path,
        client: Any,
        *,
        run_token: str,
        run_id: str,
        run_attempt: str,
    ) -> None:
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path.resolve()
        self.client = client
        self.run_token = run_token
        self.run_id = run_id
        self.run_attempt = run_attempt
        self._fd = os.open(self.path, flags, 0o600)
        # Separate this run from a possible torn final line left by an older
        # local process. The unique run token still performs the real filter.
        os.write(self._fd, b"\n")
        self._closed = False
        self._lock = threading.Lock()
        self._kind: str | None = None
        self._error: BaseException | None = None
        self._hook_name = (
            "_claim_quota_request"
            if callable(getattr(client, "_claim_quota_request", None))
            else "get"
        )
        self._original_hook = getattr(client, self._hook_name)
        self._had_instance_hook = self._hook_name in getattr(client, "__dict__", {})
        self._instance_hook = getattr(client, "__dict__", {}).get(self._hook_name)
        setattr(
            client,
            self._hook_name,
            self._claim_and_record
            if self._hook_name == "_claim_quota_request"
            else self._get_and_record,
        )
        setattr(client, "_fal_phase2_request_journal", self)

    def set_kind(self, kind: str) -> None:
        if kind not in {"artist_gate", "track_detail", "track_stream"}:
            raise RequestAttemptJournalError(f"Unsupported request journal kind: {kind}")
        with self._lock:
            if self._kind is not None:
                raise RequestAttemptJournalError("Request journal kind is already active")
            self._kind = kind

    def clear_kind(self, kind: str) -> None:
        with self._lock:
            if self._kind == kind:
                self._kind = None

    def _kind_or_raise(self) -> str:
        with self._lock:
            if self._error is not None:
                raise RequestAttemptJournalError("Request journal previously failed") from self._error
            kind = self._kind
        if kind is None:
            raise RequestAttemptJournalError("Request journal kind is not set")
        return kind

    def _append(self, kind: str, quota_remaining: int | None) -> None:
        record = {
            "v": 1,
            "run_token": self.run_token,
            "run_id": self.run_id,
            "run_attempt": self.run_attempt,
            "kind": kind,
            "quota_remaining": quota_remaining,
            "claimed_at": utc_now(),
        }
        encoded = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        try:
            with self._lock:
                view = memoryview(encoded)
                while view:
                    written = os.write(self._fd, view)
                    if written <= 0:
                        raise OSError("request journal write returned no bytes")
                    view = view[written:]
        except BaseException as exc:
            with self._lock:
                self._error = exc
            raise RequestAttemptJournalError("Unable to append request attempt journal") from exc

    def _claim_and_record(self) -> None:
        kind = self._kind_or_raise()

        # Claim locally first, then append before allowing the HTTP attempt.
        # If append fails, the exception prevents the network request.
        self._original_hook()
        self._append(kind, _quota_remaining(self.client))

    def _get_and_record(self, *args: Any, **kwargs: Any) -> Any:
        """Test/custom-client fallback when no per-attempt claim hook exists."""

        kind = self._kind_or_raise()
        remaining = _quota_remaining(self.client)
        conservative = remaining - 1 if remaining is not None else None
        self._append(kind, conservative)
        return self._original_hook(*args, **kwargs)

    def raise_if_failed(self) -> None:
        with self._lock:
            error = self._error
        if error is not None:
            raise RequestAttemptJournalError("Request attempt accounting failed") from error

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            os.fsync(self._fd)
        finally:
            os.close(self._fd)
            if self._had_instance_hook:
                setattr(self.client, self._hook_name, self._instance_hook)
            else:
                try:
                    delattr(self.client, self._hook_name)
                except AttributeError:
                    pass


def _with_request_journal_kind(client: Any, kind: str, callback: Any) -> Any:
    journal = getattr(client, "_fal_phase2_request_journal", None)
    if not isinstance(journal, RequestAttemptJournal) or journal._closed:
        return callback()
    try:
        journal.set_kind(kind)
        try:
            result = callback()
        finally:
            journal.clear_kind(kind)
        journal.raise_if_failed()
        return result
    except BaseException:
        journal.close()
        raise


def _read_request_attempts(
    progress: Mapping[str, Any],
) -> dict[str, Any] | None:
    accounting = dict(progress.get("request_accounting") or {})
    if accounting.get("source") != "append_only_attempt_journal":
        return None
    path_value = str(accounting.get("path") or "").strip()
    run_token = str(accounting.get("run_token") or "").strip()
    if not path_value or not run_token:
        return None
    path = Path(path_value)
    if not path.is_file():
        return None

    artist = 0
    tracks = 0
    streams = 0
    quota: int | None = None
    last_attempt_at: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                try:
                    row = json.loads(raw)
                except (TypeError, ValueError, json.JSONDecodeError):
                    # A terminated write cannot be mistaken for a request: the
                    # HTTP attempt only begins after the complete append.
                    continue
                if not isinstance(row, dict) or row.get("run_token") != run_token:
                    continue
                kind = row.get("kind")
                if kind == "artist_gate":
                    artist += 1
                elif kind == "track_detail":
                    tracks += 1
                elif kind == "track_stream":
                    streams += 1
                else:
                    continue
                observed_quota = finite_int(row.get("quota_remaining"))
                if observed_quota is not None:
                    quota = observed_quota if quota is None else min(quota, observed_quota)
                last_attempt_at = str(row.get("claimed_at") or last_attempt_at or "") or None
    except OSError:
        return None
    return {
        "claimed_total": artist + tracks + streams,
        "claimed_artist_gate": artist,
        "claimed_track_detail": tracks,
        "claimed_track_stream": streams,
        "quota_remaining": quota,
        "last_attempt_at": last_attempt_at,
    }


def _runner_identity_matches(
    progress: Mapping[str, Any], *, run_id: str, run_attempt: str
) -> bool:
    expected_id = str(run_id or "").strip()
    expected_attempt = str(run_attempt or "").strip()
    if expected_id and str(progress.get("run_id") or "") != expected_id:
        return False
    if expected_attempt and str(progress.get("run_attempt") or "") != expected_attempt:
        return False
    return True


def _reconcile_request_attempts(
    connection: sqlite3.Connection,
    progress: dict[str, Any],
    *,
    commit: bool,
) -> dict[str, Any] | None:
    attempts = _read_request_attempts(progress)
    if attempts is None:
        return None
    requests = dict(progress.get("requests") or {})
    allocation = dict(progress.get("allocation") or {})
    for key in (
        "claimed_total",
        "claimed_artist_gate",
        "claimed_track_detail",
        "claimed_track_stream",
    ):
        requests[key] = int(attempts[key])
    allocation["claimed_artist_gate"] = int(attempts["claimed_artist_gate"])
    allocation["claimed_track_detail"] = int(attempts["claimed_track_detail"])
    allocation["claimed_track_stream"] = int(attempts["claimed_track_stream"])
    progress["requests"] = requests
    progress["allocation"] = allocation
    progress["updated_at"] = utc_now()
    accounting = dict(progress.get("request_accounting") or {})
    accounting["last_attempt_at"] = attempts.get("last_attempt_at")
    accounting["reconciled_at"] = progress["updated_at"]
    progress["request_accounting"] = accounting
    if attempts.get("quota_remaining") is not None:
        progress["quota_remaining"] = int(attempts["quota_remaining"])
        progress["quota_observed_at"] = attempts.get("last_attempt_at")
    _store_run_progress(connection, progress, commit=commit)
    return attempts


def load_run_progress(connection: sqlite3.Connection) -> dict[str, Any] | None:
    """Return the durable counters for the currently executing phase-2 run."""

    raw = meta_get(connection, RUN_PROGRESS_META_KEY)
    if not raw:
        return None
    try:
        progress = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(progress, dict) or finite_int(progress.get("version")) != RUN_PROGRESS_VERSION:
        return None
    return progress


def _store_run_progress(
    connection: sqlite3.Connection,
    progress: Mapping[str, Any],
    *,
    commit: bool,
) -> None:
    meta_set(
        connection,
        RUN_PROGRESS_META_KEY,
        json.dumps(dict(progress), ensure_ascii=False, sort_keys=True),
    )
    if commit:
        connection.commit()


def _migration_payload(migration: QueueMigration) -> dict[str, int]:
    return {
        "requested": int(migration.requested),
        "capacity_before": int(migration.capacity_before),
        "selected": int(migration.selected),
        "pending": int(migration.pending),
        "locally_blocked": int(migration.locally_blocked),
    }


def _budget_plan_payload(plan: QuotaBudgetPlan | None) -> dict[str, Any] | None:
    if plan is None:
        return None
    return {
        "requested": int(plan.requested),
        "allowed": int(plan.allowed),
        "hard_reserve": int(plan.hard_reserve),
        "maintenance_daily_requests": int(plan.maintenance_daily_requests),
        "maintenance_days": int(plan.maintenance_days),
        "maintenance_reserve": int(plan.maintenance_reserve),
        "protected_floor": int(plan.protected_floor),
        "maintenance_through": plan.maintenance_through,
    }


def begin_run_progress(
    connection: sqlite3.Connection,
    client: Any,
    *,
    budget: InterleavedBudget,
    budget_plan: QuotaBudgetPlan | None,
    migration: QueueMigration,
    run_id: str = "",
    run_attempt: str = "",
    request_journal: Path | None = None,
) -> RequestAttemptJournal | None:
    """Start a new durable run ledger before the first paid data request."""

    now = utc_now()
    runner_id = str(run_id or os.environ.get("GITHUB_RUN_ID") or "").strip()
    runner_attempt = str(
        run_attempt or os.environ.get("GITHUB_RUN_ATTEMPT") or ""
    ).strip()
    run_token = f"{runner_id or 'local'}:{runner_attempt or '0'}:{uuid.uuid4().hex}"
    journal: RequestAttemptJournal | None = None
    accounting: dict[str, Any] = {"source": "sqlite_committed_batches"}
    if request_journal is not None and callable(getattr(client, "get", None)):
        journal = RequestAttemptJournal(
            request_journal,
            client,
            run_token=run_token,
            run_id=runner_id,
            run_attempt=runner_attempt,
        )
        accounting = {
            "source": "append_only_attempt_journal",
            "path": str(journal.path),
            "run_token": run_token,
            "durability": "single_append_before_each_http_attempt",
        }
    progress = {
        "version": RUN_PROGRESS_VERSION,
        "run_id": runner_id,
        "run_attempt": runner_attempt,
        "run_token": run_token,
        "status": "running",
        "started_at": now,
        "updated_at": now,
        "last_committed_at": None,
        "quota_remaining": _quota_remaining(client),
        "quota_observed_at": now if _quota_remaining(client) is not None else None,
        "halt_reason": None,
        "requests": {
            "claimed_total": 0,
            "claimed_artist_gate": 0,
            "claimed_track_detail": 0,
            "claimed_track_stream": 0,
        },
        "allocation": {
            "strategy": "weighted_artist_gate_with_track_detail_reserve",
            "planned_allowed": int(budget.allowed),
            "planned_artist_gate": int(budget.artist_gate),
            "planned_track_detail": int(budget.track_detail),
            "claimed_artist_gate": 0,
            "claimed_track_detail": 0,
            "claimed_track_stream": 0,
        },
        "preflight": _budget_plan_payload(budget_plan),
        "migration": _migration_payload(migration),
        "request_accounting": accounting,
    }
    try:
        _store_run_progress(connection, progress, commit=True)
    except BaseException:
        if journal is not None:
            journal.close()
        raise
    return journal


def checkpoint_committed_requests(
    connection: sqlite3.Connection,
    client: Any,
    *,
    kind: str,
    claimed: int,
) -> None:
    """Atomically checkpoint request counters with one committed result batch."""

    progress = load_run_progress(connection)
    if progress is None:
        return
    if kind not in {"artist_gate", "track_detail", "track_stream"}:
        raise FalPhase2Error(f"Unsupported phase-2 request kind: {kind}")
    requests = dict(progress.get("requests") or {})
    allocation = dict(progress.get("allocation") or {})
    increment = max(0, int(claimed))
    key = f"claimed_{kind}"
    requests[key] = int(requests.get(key) or 0) + increment
    requests["claimed_total"] = int(requests.get("claimed_total") or 0) + increment
    allocation[key] = int(allocation.get(key) or 0) + increment
    now = utc_now()
    progress["requests"] = requests
    progress["allocation"] = allocation
    progress["updated_at"] = now
    progress["last_committed_at"] = now
    remaining = _quota_remaining(client)
    if remaining is not None:
        progress["quota_remaining"] = remaining
        progress["quota_observed_at"] = now
    # No commit here: the scanner commits this metadata together with the
    # corresponding artist/track rows, so neither side can get ahead.
    _store_run_progress(connection, progress, commit=False)


def checkpoint_run_migration(
    connection: sqlite3.Connection,
    migration: QueueMigration,
) -> None:
    progress = load_run_progress(connection)
    if progress is None:
        return
    progress["migration"] = _migration_payload(migration)
    progress["updated_at"] = utc_now()
    _store_run_progress(connection, progress, commit=True)


def finish_run_progress(
    connection: sqlite3.Connection,
    client: Any,
    *,
    halt_reason: str | None,
    migration: QueueMigration,
) -> None:
    progress = load_run_progress(connection)
    if progress is None:
        return
    attempts = _reconcile_request_attempts(connection, progress, commit=False)
    now = utc_now()
    progress["status"] = "finished"
    progress["finished_at"] = now
    progress["updated_at"] = now
    progress["halt_reason"] = halt_reason
    progress["migration"] = _migration_payload(migration)
    remaining = _quota_remaining(client)
    if remaining is not None:
        progress["quota_remaining"] = remaining
        progress["quota_observed_at"] = now
    elif attempts is not None and attempts.get("quota_remaining") is not None:
        progress["quota_remaining"] = int(attempts["quota_remaining"])
    _store_run_progress(connection, progress, commit=True)


def assert_phase1_complete(connection: sqlite3.Connection) -> None:
    """Refuse enrichment until the restored phase-one inventory is complete."""

    scope_version = meta_get(connection, CATALOG_SCOPE_META_KEY)
    if scope_version != CATALOG_SCOPE_VERSION:
        raise FalPhase2Error(
            "Phase-1 checkpoint uses an unsupported discography scope "
            f"({scope_version or 'missing'}; expected {CATALOG_SCOPE_VERSION})"
        )

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
    most one complete artist metadata request per candidate and keeps explicit
    vocal or out-of-scope catalogues out of the paid song queue.  Audience size
    alone is never a rejection criterion.
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


def _purge_orphan_phase2_tracks(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    *,
    batch_size: int = 500,
) -> tuple[int, int]:
    """Remove queue/details rows whose track disappeared from phase 1.

    Phase one can contain millions of tracks, while the phase-two checkpoint is
    intentionally much smaller.  Walk the union of phase-two UUIDs in bounded
    batches and probe phase one's indexed primary key instead of loading the
    whole phase-one inventory into memory.
    """

    queue_deleted = 0
    details_deleted = 0
    cursor = ""
    limit = max(1, min(500, int(batch_size)))
    while True:
        rows = phase2.execute(
            """SELECT track_uuid FROM (
                   SELECT track_uuid FROM fal_phase2_queue WHERE track_uuid>?
                   UNION
                   SELECT track_uuid FROM fal_phase2_details WHERE track_uuid>?
                   UNION
                   SELECT track_uuid FROM fal_phase2_stream_gate WHERE track_uuid>?
                 )
                 ORDER BY track_uuid
                 LIMIT ?""",
            (cursor, cursor, cursor, limit),
        ).fetchall()
        if not rows:
            break
        track_uuids = [str(row[0]) for row in rows]
        cursor = track_uuids[-1]
        placeholders = ",".join("?" for _ in track_uuids)
        present = {
            str(row[0])
            for row in phase1.execute(
                f"SELECT soundcharts_uuid FROM tracks WHERE soundcharts_uuid IN ({placeholders})",
                track_uuids,
            ).fetchall()
        }
        orphaned = [track_uuid for track_uuid in track_uuids if track_uuid not in present]
        if not orphaned:
            continue
        orphan_placeholders = ",".join("?" for _ in orphaned)
        queue_deleted += max(
            0,
            int(
                phase2.execute(
                    f"DELETE FROM fal_phase2_queue WHERE track_uuid IN ({orphan_placeholders})",
                    orphaned,
                ).rowcount
                or 0
            ),
        )
        details_deleted += max(
            0,
            int(
                phase2.execute(
                    f"DELETE FROM fal_phase2_details WHERE track_uuid IN ({orphan_placeholders})",
                    orphaned,
                ).rowcount
                or 0
            ),
        )
        phase2.execute(
            f"DELETE FROM fal_phase2_stream_gate WHERE track_uuid IN ({orphan_placeholders})",
            orphaned,
        )
    return queue_deleted, details_deleted


def reconcile_phase1_source(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    phase1_source_id: str,
) -> int:
    """Reopen eligible artist catalogues when phase 1 publishes a new source.

    A completed per-artist cursor only describes the phase-1 checkpoint that
    produced it.  Rewinding eligible artists lets the normal queue insertion
    discover tracks added by a later checkpoint, including UUIDs that sort
    before the former cursor.  Existing queue/details rows remain valid only
    while their track still exists in the new immutable phase-one inventory.
    """

    source_id = str(phase1_source_id or "").strip()
    previous_source = meta_get(phase2, "fal_phase2_phase1_source_id") or ""
    if not source_id or source_id == previous_source:
        return 0

    now = utc_now()
    try:
        phase2.execute("BEGIN IMMEDIATE")
        queue_deleted, details_deleted = _purge_orphan_phase2_tracks(phase1, phase2)
        phase2.execute(
            "DELETE FROM meta WHERE key IN ('fal_phase2_queue_cursor_rowid','fal_phase2_queue_cursor_release_date','fal_phase2_queue_cursor_uuid')"
        )
        reopened = phase2.execute(
            """UPDATE fal_phase2_artist_gate
                  SET bulk_cursor_track_uuid='',bulk_complete=0,updated_at=?
                WHERE gate_status='eligible'""",
            (now,),
        ).rowcount
        queue_deleted_total = (
            finite_int(meta_get(phase2, "fal_phase2_orphan_queue_rows_removed_total")) or 0
        ) + queue_deleted
        details_deleted_total = (
            finite_int(meta_get(phase2, "fal_phase2_orphan_details_rows_removed_total")) or 0
        ) + details_deleted
        meta_set(phase2, "fal_phase2_previous_phase1_source_id", previous_source)
        meta_set(phase2, "fal_phase2_phase1_source_id", source_id)
        meta_set(phase2, "fal_phase2_bulk_reopened_at", now)
        meta_set(phase2, "fal_phase2_source_reconciled_at", now)
        meta_set(phase2, "fal_phase2_source_reconciled_artists_reopened", reopened)
        meta_set(phase2, "fal_phase2_orphan_queue_rows_removed_last", queue_deleted)
        meta_set(phase2, "fal_phase2_orphan_details_rows_removed_last", details_deleted)
        meta_set(phase2, "fal_phase2_orphan_queue_rows_removed_total", queue_deleted_total)
        meta_set(phase2, "fal_phase2_orphan_details_rows_removed_total", details_deleted_total)
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
    commit: bool = True,
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
        if commit:
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


def seed_stream_gate(
    phase2: sqlite3.Connection,
    *,
    min_track_streams: int = DEFAULT_MIN_TRACK_STREAMS,
    history_days: int = DEFAULT_STREAM_HISTORY_DAYS,
    commit: bool = True,
) -> int:
    """Add every non-blocked detail result to the lifetime-stream gate.

    The phase-two state stays at v3: this is an additive staging table and the
    threshold is versioned independently.  A threshold change re-evaluates
    already measured rows locally, without spending another Soundcharts call.
    Missing stream history remains an explicit review state and can never pass.
    """

    threshold = max(0, int(min_track_streams))
    window = max(65, min(365, int(history_days)))
    decisions = tuple(STREAM_GATE_SEED_DECISIONS)
    placeholders = ",".join("?" for _ in decisions)
    now = utc_now()
    try:
        phase2.execute("BEGIN IMMEDIATE")
        meta_set(phase2, "fal_phase2_stream_gate_version", STREAM_GATE_META_VERSION)
        meta_set(phase2, "fal_phase2_stream_gate_min_streams", threshold)
        meta_set(phase2, "fal_phase2_stream_gate_history_days", window)
        # A later metadata correction may turn a review row into an explicit
        # block or duplicate.  Such a row must stop consuming stream calls.
        phase2.execute(
            f"""DELETE FROM fal_phase2_stream_gate
                  WHERE EXISTS (
                    SELECT 1 FROM fal_phase2_details d
                     WHERE d.track_uuid=fal_phase2_stream_gate.track_uuid
                       AND d.decision NOT IN ({placeholders})
                  )""",
            decisions,
        )
        inserted = phase2.execute(
            f"""INSERT OR IGNORE INTO fal_phase2_stream_gate(
                   track_uuid,spotify_id,gate_status,reason,queued_at,updated_at)
                 SELECT track_uuid,NULLIF(spotify_id,''),'pending',
                        'stream_history_required',?,?
                   FROM fal_phase2_details
                  WHERE decision IN ({placeholders})""",
            (now, now, *decisions),
        ).rowcount
        phase2.execute(
            """UPDATE fal_phase2_stream_gate
                  SET spotify_id=(
                        SELECT NULLIF(d.spotify_id,'') FROM fal_phase2_details d
                         WHERE d.track_uuid=fal_phase2_stream_gate.track_uuid
                      ),
                      updated_at=CASE WHEN spotify_id IS NULL THEN ? ELSE updated_at END
                WHERE EXISTS (
                        SELECT 1 FROM fal_phase2_details d
                         WHERE d.track_uuid=fal_phase2_stream_gate.track_uuid
                           AND NULLIF(d.spotify_id,'') IS NOT NULL
                      )
                  AND COALESCE(spotify_id,'')<>COALESCE((
                        SELECT NULLIF(d.spotify_id,'') FROM fal_phase2_details d
                         WHERE d.track_uuid=fal_phase2_stream_gate.track_uuid
                      ),'')""",
            (now,),
        )
        phase2.execute(
            """UPDATE fal_phase2_stream_gate
                  SET gate_status=CASE WHEN streams_total>=? THEN 'eligible'
                                       ELSE 'blocked_streams_below_threshold' END,
                      reason=CASE WHEN streams_total>=? THEN 'lifetime_stream_threshold_met'
                                  ELSE 'lifetime_streams_below_threshold' END,
                      attempts=0,error_code=NULL,updated_at=?
                WHERE streams_total IS NOT NULL""",
            (threshold, threshold, now),
        )
        meta_set(phase2, "fal_phase2_stream_gate_seeded_at", now)
        if commit:
            phase2.commit()
    except Exception:
        phase2.rollback()
        raise
    return max(0, int(inserted or 0))


def sync_stream_gate_detail(
    phase2: sqlite3.Connection,
    *,
    track_uuid: str,
    spotify_id: str,
    decision: str,
    updated_at: str,
) -> None:
    """Synchronize one freshly enriched detail without rescanning the table."""

    if decision not in STREAM_GATE_SEED_DECISIONS:
        phase2.execute(
            "DELETE FROM fal_phase2_stream_gate WHERE track_uuid=?",
            (track_uuid,),
        )
        return
    current = phase2.execute(
        "SELECT spotify_id FROM fal_phase2_stream_gate WHERE track_uuid=?",
        (track_uuid,),
    ).fetchone()
    normalized_spotify_id = str(spotify_id or "").strip() or None
    if current is None:
        phase2.execute(
            """INSERT INTO fal_phase2_stream_gate(
                   track_uuid,spotify_id,gate_status,reason,queued_at,updated_at)
                 VALUES(?,?,'pending','stream_history_required',?,?)""",
            (track_uuid, normalized_spotify_id, updated_at, updated_at),
        )
        return
    previous_spotify_id = str(current["spotify_id"] or "").strip() or None
    if previous_spotify_id != normalized_spotify_id:
        phase2.execute(
            """UPDATE fal_phase2_stream_gate
                  SET spotify_id=?,gate_status='pending',reason='spotify_identity_changed',
                      streams_total=NULL,source_date=NULL,history_json='[]',attempts=0,
                      error_code=NULL,updated_at=?
                WHERE track_uuid=?""",
            (normalized_spotify_id, updated_at, track_uuid),
        )


def _walk_mappings(value: Any):
    if isinstance(value, Mapping):
        yield value
        for child in value.values():
            yield from _walk_mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_mappings(child)


@dataclass(frozen=True)
class StreamGateMeasurement:
    """A cumulative stream series bound to a verified Spotify identifier."""

    spotify_id: str
    aliases: tuple[str, ...]
    points: list[list[Any]]
    ambiguous: bool = False


def extract_stream_gate_measurement(
    response: Any,
    spotify_id: str = "",
) -> StreamGateMeasurement:
    """Extract one exact Spotify series and retain its platform identifier.

    The audience endpoint returns Spotify identifiers on each numeric plot.  A
    missing local identifier may therefore be completed without a second API
    endpoint, but only when the response exposes exactly one valid Spotify
    track ID.  Multiple aliases remain in review instead of being guessed.
    """

    raw_preferred = str(spotify_id or "").strip()
    preferred = raw_preferred if SPOTIFY_TRACK_ID_RE.fullmatch(raw_preferred) else ""
    aliases: set[str] = set()
    for item in _walk_mappings(response):
        plots = item.get("plots")
        if not isinstance(plots, list):
            continue
        for plot in plots:
            if not isinstance(plot, Mapping):
                continue
            identifier = str(plot.get("identifier") or "").strip()
            if (
                SPOTIFY_TRACK_ID_RE.fullmatch(identifier)
                and isinstance(plot.get("value"), (int, float))
            ):
                aliases.add(identifier)

    if preferred:
        points = extract_song_audience_points(
            response,
            preferred,
            require_identifier_match=True,
        )
        return StreamGateMeasurement(
            spotify_id=preferred,
            aliases=tuple(sorted(aliases)),
            points=points,
            ambiguous=False,
        )
    if len(aliases) != 1:
        return StreamGateMeasurement(
            spotify_id="",
            aliases=tuple(sorted(aliases)),
            points=[],
            ambiguous=len(aliases) > 1,
        )
    discovered = next(iter(aliases))
    return StreamGateMeasurement(
        spotify_id=discovered,
        aliases=(discovered,),
        points=extract_song_audience_points(
            response,
            discovered,
            require_identifier_match=True,
        ),
        ambiguous=False,
    )


def extract_stream_gate_points(response: Any, spotify_id: str = "") -> list[list[Any]]:
    """Compatibility wrapper returning the exact cumulative Spotify points."""

    return extract_stream_gate_measurement(response, spotify_id).points


class StreamGateScanner:
    """Measure cumulative Spotify streams and apply the strict staging gate."""

    def __init__(
        self,
        phase2: sqlite3.Connection,
        client: Any,
        *,
        workers: int,
        retry_limit: int,
        min_track_streams: int = DEFAULT_MIN_TRACK_STREAMS,
        history_days: int = DEFAULT_STREAM_HISTORY_DAYS,
        as_of: str | dt.date | dt.datetime | None = None,
    ) -> None:
        self.phase2 = phase2
        self.client = client
        self.workers = max(1, int(workers))
        self.retry_limit = max(1, int(retry_limit))
        self.min_track_streams = max(0, int(min_track_streams))
        self.history_days = max(65, min(365, int(history_days)))
        today = parse_as_of(as_of).astimezone(dt.timezone.utc).date()
        start = today - dt.timedelta(days=self.history_days - 1)
        self.query = urllib.parse.urlencode(
            {
                "startDate": start.isoformat(),
                "endDate": today.isoformat(),
                "limit": max(100, self.history_days + 5),
            }
        )
        self.halt_reason: str | None = None

    def _record_error(self, uuid: str, code: str) -> None:
        self.phase2.execute(
            "INSERT INTO fal_phase2_errors(track_uuid,error_code,observed_at) VALUES(?,?,?)",
            (uuid, f"track_stream:{code}", utc_now()),
        )

    def _fetch_batch(self, rows: Sequence[sqlite3.Row]) -> tuple[dict[str, Any], dict[str, str]]:
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}

        def fetch(row: sqlite3.Row) -> tuple[str, Any]:
            uuid = str(row["track_uuid"])
            path = (
                f"/api/v2/song/{urllib.parse.quote(uuid)}/audience/spotify?{self.query}"
            )
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

    def _store_result(self, row: sqlite3.Row, response: Any) -> None:
        uuid = str(row["track_uuid"])
        spotify_id = str(row["spotify_id"] or "").strip()
        if spotify_id and not SPOTIFY_TRACK_ID_RE.fullmatch(spotify_id):
            self.phase2.execute(
                "UPDATE fal_phase2_stream_gate SET spotify_id=NULL WHERE track_uuid=?",
                (uuid,),
            )
            self.phase2.execute(
                """UPDATE fal_phase2_details SET spotify_id=NULL
                     WHERE track_uuid=? AND spotify_id=?""",
                (uuid, spotify_id),
            )
            spotify_id = ""
        measurement = extract_stream_gate_measurement(response, spotify_id)
        resolved_spotify_id = measurement.spotify_id
        points = measurement.points
        valid_points = [
            [str(point[0]), int(point[1])]
            for point in points
            if isinstance(point, (list, tuple))
            and len(point) >= 2
            and finite_int(point[1]) is not None
            and int(point[1]) >= 0
        ]
        now = utc_now()
        if resolved_spotify_id and resolved_spotify_id != spotify_id:
            duplicate = self.phase2.execute(
                """SELECT track_uuid FROM fal_phase2_details
                     WHERE track_uuid<>? AND spotify_id=?
                     UNION
                   SELECT track_uuid FROM fal_phase2_stream_gate
                     WHERE track_uuid<>? AND spotify_id=?
                     LIMIT 1""",
                (uuid, resolved_spotify_id, uuid, resolved_spotify_id),
            ).fetchone()
            if duplicate:
                self.phase2.execute(
                    """UPDATE fal_phase2_stream_gate
                          SET spotify_id=?,gate_status='review_spotify_identity_duplicate',
                              reason='spotify_identifier_already_bound_to_another_track',
                              streams_total=NULL,source_date=NULL,history_json='[]',
                              attempts=0,error_code=NULL,updated_at=?
                        WHERE track_uuid=?""",
                    (resolved_spotify_id, now, uuid),
                )
                return
            self.phase2.execute(
                """UPDATE fal_phase2_details
                      SET spotify_id=?
                    WHERE track_uuid=?""",
                (resolved_spotify_id, uuid),
            )
            self.phase2.execute(
                """UPDATE fal_phase2_stream_gate
                      SET spotify_id=?
                    WHERE track_uuid=?""",
                (resolved_spotify_id, uuid),
            )
        if not valid_points:
            self.phase2.execute(
                """UPDATE fal_phase2_stream_gate
                      SET gate_status='review_streams_unknown',
                          reason=?,
                          streams_total=NULL,source_date=NULL,history_json='[]',
                          attempts=0,error_code=NULL,updated_at=?
                    WHERE track_uuid=?""",
                (
                    "spotify_identifiers_ambiguous"
                    if measurement.ambiguous
                    else "spotify_stream_history_missing_or_ambiguous",
                    now,
                    uuid,
                ),
            )
            return
        source_date, streams_total = valid_points[-1]
        passed = streams_total >= self.min_track_streams
        self.phase2.execute(
            """UPDATE fal_phase2_stream_gate
                  SET spotify_id=COALESCE(NULLIF(?,''),spotify_id),
                      gate_status=?,reason=?,streams_total=?,source_date=?,history_json=?,
                      attempts=0,error_code=NULL,updated_at=?
                WHERE track_uuid=?""",
            (
                resolved_spotify_id,
                "eligible" if passed else "blocked_streams_below_threshold",
                "lifetime_stream_threshold_met" if passed else "lifetime_streams_below_threshold",
                streams_total,
                source_date,
                json.dumps(valid_points, ensure_ascii=False, separators=(",", ":")),
                now,
                uuid,
            ),
        )

    def _store_unavailable(self, row: sqlite3.Row) -> None:
        uuid = str(row["track_uuid"])
        now = utc_now()
        self.phase2.execute(
            """UPDATE fal_phase2_stream_gate
                  SET gate_status='review_streams_unavailable',
                      reason='soundcharts_spotify_stream_history_unavailable',
                      streams_total=NULL,source_date=NULL,history_json='[]',
                      error_code='unavailable',updated_at=?
                WHERE track_uuid=?""",
            (now, uuid),
        )
        self._record_error(uuid, "unavailable")

    def scan_batch(self, max_items: int | None = None) -> bool:
        limit = self.workers if max_items is None else min(self.workers, max(0, int(max_items)))
        if limit <= 0:
            return False
        rows = self.phase2.execute(
            """SELECT * FROM fal_phase2_stream_gate
                WHERE gate_status IN ('pending','retry')
                ORDER BY queued_at,track_uuid LIMIT ?""",
            (limit,),
        ).fetchall()
        if not rows:
            return False
        by_uuid = {str(row["track_uuid"]): row for row in rows}
        claimed_before = int(getattr(self.client, "requests_claimed", 0) or 0)
        results, errors = _with_request_journal_kind(
            self.client,
            "track_stream",
            lambda: self._fetch_batch(rows),
        )
        claimed_after = int(getattr(self.client, "requests_claimed", 0) or 0)
        for uuid, response in results.items():
            self._store_result(by_uuid[uuid], response)
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                self._store_unavailable(row)
                continue
            if code in {"request_limit", "quota_reserve"}:
                self.phase2.execute(
                    "UPDATE fal_phase2_stream_gate SET error_code=?,updated_at=? WHERE track_uuid=?",
                    (code, utc_now(), uuid),
                )
                self._record_error(uuid, code)
                continue
            attempts = int(row["attempts"] or 0) + 1
            status = "review_request_failed" if attempts >= self.retry_limit else "retry"
            reason = (
                "bounded_stream_retries_exhausted"
                if status == "review_request_failed"
                else "transient_stream_request_retry"
            )
            self.phase2.execute(
                """UPDATE fal_phase2_stream_gate
                      SET gate_status=?,reason=?,attempts=?,error_code=?,updated_at=?
                    WHERE track_uuid=?""",
                (status, reason, attempts, code, utc_now(), uuid),
            )
            self._record_error(uuid, code)
        checkpoint_committed_requests(
            self.phase2,
            self.client,
            kind="track_stream",
            claimed=max(0, claimed_after - claimed_before),
        )
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
            return uuid, self.client.get(f"/api/v2.9/artist/{urllib.parse.quote(uuid)}")

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
        claimed_before = int(getattr(self.client, "requests_claimed", 0) or 0)
        results, errors = _with_request_journal_kind(
            self.client,
            "artist_gate",
            lambda: self._fetch_batch(rows),
        )
        claimed_after = int(getattr(self.client, "requests_claimed", 0) or 0)
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
        checkpoint_committed_requests(
            self.phase2,
            self.client,
            kind="artist_gate",
            claimed=max(0, claimed_after - claimed_before),
        )
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
        sync_stream_gate_detail(
            self.phase2,
            track_uuid=uuid,
            spotify_id=spotify_id,
            decision=decision,
            updated_at=now,
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
        claimed_before = int(getattr(self.client, "requests_claimed", 0) or 0)
        results, errors = _with_request_journal_kind(
            self.client,
            "track_detail",
            lambda: self._fetch_batch(rows),
        )
        claimed_after = int(getattr(self.client, "requests_claimed", 0) or 0)
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
        checkpoint_committed_requests(
            self.phase2,
            self.client,
            kind="track_detail",
            claimed=max(0, claimed_after - claimed_before),
        )
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


def _run_interleaved_batches_impl(
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
    min_track_streams: int = DEFAULT_MIN_TRACK_STREAMS,
    stream_history_days: int = DEFAULT_STREAM_HISTORY_DAYS,
    initial_migration: QueueMigration | None = None,
    budget_plan: QuotaBudgetPlan | None = None,
    run_id: str = "",
    run_attempt: str = "",
    request_journal: Path | None = None,
) -> InterleavedRun:
    """Alternate bounded artist and track batches under one safe run budget."""

    seed_stream_gate(
        phase2,
        min_track_streams=min_track_streams,
        history_days=stream_history_days,
    )
    artist_active = int(
        phase2.execute(
            """SELECT COUNT(*) FROM fal_phase2_artist_gate
                WHERE gate_status IN ('pending','retry')"""
        ).fetchone()[0]
    )
    stream_active = int(
        phase2.execute(
            """SELECT COUNT(*) FROM fal_phase2_stream_gate
                WHERE gate_status IN ('pending','retry')"""
        ).fetchone()[0]
    )
    budget = plan_interleaved_budget(
        allowed_requests,
        artist_gate_active=artist_active,
        track_details_paused=track_details_paused,
        stream_gate_active=stream_active,
    )
    migration = initial_migration or QueueMigration(0, 0, 0, 0, 0)
    if budget.allowed <= 0:
        return InterleavedRun(budget, migration, "idle", 0, 0)

    journal = begin_run_progress(
        phase2,
        client,
        budget=budget,
        budget_plan=budget_plan,
        migration=migration,
        run_id=run_id,
        run_attempt=run_attempt,
        request_journal=request_journal,
    )

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
    stream_scanner = StreamGateScanner(
        phase2,
        client,
        workers=worker_count,
        retry_limit=max(1, int(retry_limit)),
        min_track_streams=min_track_streams,
        history_days=stream_history_days,
        as_of=as_of,
    )
    start_claimed = int(getattr(client, "requests_claimed", 0) or 0)
    artist_remaining = budget.artist_gate
    track_remaining = budget.track_detail
    artist_requests = 0
    track_requests = 0
    stream_requests = 0
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
            try:
                gated = migrate_gated_track_queue(
                    phase1,
                    phase2,
                    max_new_queue=max_new_queue,
                    active_queue_cap=active_queue_cap,
                    recent_days=recent_days,
                    as_of=as_of,
                    commit=False,
                )
                migration = _combine_migrations(migration, gated)
                # This commit also makes the queue rows above durable.  The
                # report can therefore never lag behind an advanced queue.
                checkpoint_run_migration(phase2, migration)
            except BaseException:
                phase2.rollback()
                raise

        actual_spent = max(
            0,
            int(getattr(client, "requests_claimed", 0) or 0) - start_claimed,
        )
        total_remaining = budget.allowed - max(logical_spent, actual_spent)
        fatal_halt = halt in {"request_limit", "quota_reserve"}
        if not fatal_halt and track_remaining > 0 and total_remaining > 0:
            active_streams = int(
                phase2.execute(
                    """SELECT COUNT(*) FROM fal_phase2_stream_gate
                        WHERE gate_status IN ('pending','retry')"""
                ).fetchone()[0]
            )
            if active_streams > 0:
                track_limit = min(track_remaining, total_remaining, worker_count)
                before = int(getattr(client, "requests_claimed", 0) or 0)
                did_stream_work = stream_scanner.scan_batch(max_items=track_limit)
                after = int(getattr(client, "requests_claimed", 0) or 0)
                claimed = max(0, after - before)
                if did_stream_work:
                    spent = max(1, claimed)
                    track_remaining = max(0, track_remaining - spent)
                    logical_spent += spent
                    stream_requests += claimed
                    progressed = True
                if stream_scanner.halt_reason:
                    halt = stream_scanner.halt_reason
            elif not tracks_paused:
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

    try:
        finish_run_progress(
            phase2,
            client,
            halt_reason=None if halt == "idle" else halt,
            migration=migration,
        )
    finally:
        if journal is not None:
            journal.close()
    return InterleavedRun(
        budget=budget,
        migration=migration,
        halt_reason=halt,
        artist_requests=artist_requests,
        track_requests=track_requests,
        stream_requests=stream_requests,
    )


def run_interleaved_batches(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    client: Any,
    **kwargs: Any,
) -> InterleavedRun:
    """Run phase 2 while always restoring the client's request hook."""

    try:
        return _run_interleaved_batches_impl(phase1, phase2, client, **kwargs)
    finally:
        journal = getattr(client, "_fal_phase2_request_journal", None)
        if isinstance(journal, RequestAttemptJournal):
            journal.close()


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
    stream_gate_counts = _count_by_status(
        phase2, "fal_phase2_stream_gate", "gate_status"
    )
    active = sum(queue_counts.get(status, 0) for status in ACTIVE_QUEUE_STATUSES)
    artist_gate_active = sum(
        artist_gate_counts.get(status, 0) for status in ACTIVE_ARTIST_GATE_STATUSES
    )
    stream_gate_active = sum(
        stream_gate_counts.get(status, 0) for status in ACTIVE_STREAM_GATE_STATUSES
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
    complete = (
        artist_gate_active == 0
        and eligible_bulk_remaining == 0
        and active == 0
        and stream_gate_active == 0
    )
    if halt_reason == "canary_zero_evidence_yield":
        status = "paused_zero_evidence_yield"
    elif halt_reason == "maintenance_quota_protected":
        status = "quota_protected"
    elif halt_reason in {"request_limit", "quota_reserve"}:
        status = "partial"
    elif complete:
        status = "enrichment_complete_review_required"
    elif active or artist_gate_active or stream_gate_active:
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
            "phase1_discography_scope": meta_get(phase1, CATALOG_SCOPE_META_KEY),
            "phase1_complete_required": True,
            "phase1_source_id": meta_get(phase2, "fal_phase2_phase1_source_id"),
            "reconciliation": {
                "previous_phase1_source_id": meta_get(
                    phase2, "fal_phase2_previous_phase1_source_id"
                ),
                "reconciled_at": meta_get(phase2, "fal_phase2_source_reconciled_at"),
                "eligible_artist_bulks_reopened": finite_int(
                    meta_get(phase2, "fal_phase2_source_reconciled_artists_reopened")
                )
                or 0,
                "orphan_queue_rows_removed_last": finite_int(
                    meta_get(phase2, "fal_phase2_orphan_queue_rows_removed_last")
                )
                or 0,
                "orphan_details_rows_removed_last": finite_int(
                    meta_get(phase2, "fal_phase2_orphan_details_rows_removed_last")
                )
                or 0,
                "orphan_queue_rows_removed_total": finite_int(
                    meta_get(phase2, "fal_phase2_orphan_queue_rows_removed_total")
                )
                or 0,
                "orphan_details_rows_removed_total": finite_int(
                    meta_get(phase2, "fal_phase2_orphan_details_rows_removed_total")
                )
                or 0,
            },
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
            "endpoint": "/api/v2.9/artist/{uuid}",
            "status_counts": artist_gate_counts,
            "active": artist_gate_active,
            "eligible_bulk_remaining": eligible_bulk_remaining,
            "audience_size_is_not_a_rejection_criterion": True,
            "unknown_genre_stays_in_review": True,
            "ai_risk_is_never_inferred": True,
        },
        "stream_gate": {
            "endpoint": "/api/v2/song/{uuid}/audience/spotify",
            "metric": "spotify_lifetime_cumulative_streams",
            "minimum_streams": finite_int(
                meta_get(phase2, "fal_phase2_stream_gate_min_streams")
            )
            or DEFAULT_MIN_TRACK_STREAMS,
            "history_days": finite_int(
                meta_get(phase2, "fal_phase2_stream_gate_history_days")
            )
            or DEFAULT_STREAM_HISTORY_DAYS,
            "status_counts": stream_gate_counts,
            "active": stream_gate_active,
            "missing_or_ambiguous_never_passes": True,
            "threshold_pass_is_not_canonical_acceptance": True,
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
            "active": artist_gate_active + active + stream_gate_active,
            "artist_gate_active": artist_gate_active,
            "track_detail_active": active,
            "track_stream_active": stream_gate_active,
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
                    "claimed_track_stream": interleaved_run.stream_requests,
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


def build_interrupted_report(
    phase1: sqlite3.Connection,
    phase2: sqlite3.Connection,
    *,
    recent_days: int,
    as_of: str | dt.date | dt.datetime | None,
    active_queue_cap: int,
    canary_min_sample: int,
    runner_outcome: str,
    run_id: str = "",
    run_attempt: str = "",
    request_journal: Path | None = None,
) -> dict[str, Any]:
    """Rebuild an interruption report from the last atomic SQLite checkpoint."""

    progress = load_run_progress(phase2)
    if progress is not None and not _runner_identity_matches(
        progress, run_id=run_id, run_attempt=run_attempt
    ):
        progress = None
    if progress is not None and request_journal is not None:
        accounting = dict(progress.get("request_accounting") or {})
        if accounting.get("source") == "append_only_attempt_journal":
            accounting["path"] = str(request_journal.resolve())
            progress["request_accounting"] = accounting
    journal_attempts = (
        _reconcile_request_attempts(phase2, progress, commit=True)
        if progress is not None
        else None
    )
    migration_data = dict((progress or {}).get("migration") or {})
    migration = QueueMigration(
        requested=int(migration_data.get("requested") or 0),
        capacity_before=int(migration_data.get("capacity_before") or 0),
        selected=int(migration_data.get("selected") or 0),
        pending=int(migration_data.get("pending") or 0),
        locally_blocked=int(migration_data.get("locally_blocked") or 0),
    )
    requests = dict((progress or {}).get("requests") or {})
    accounting_source = str(
        dict((progress or {}).get("request_accounting") or {}).get("source") or ""
    )
    journal_missing = (
        progress is not None
        and accounting_source == "append_only_attempt_journal"
        and journal_attempts is None
    )
    claimed: int | None = (
        int(requests.get("claimed_total") or 0)
        if progress is not None and not journal_missing
        else None
    )
    quota = (
        finite_int((progress or {}).get("quota_remaining"))
        if not journal_missing
        else None
    )
    outcome = str(runner_outcome or "failure").strip().lower().replace(" ", "_")
    halt_reason = f"runner_{outcome}"
    report = build_report(
        phase1,
        phase2,
        migration=migration,
        recent_days=recent_days,
        as_of=as_of,
        requests_claimed=claimed or 0,
        quota_remaining=quota,
        halt_reason=halt_reason,
        active_queue_cap=active_queue_cap,
        canary_min_sample=canary_min_sample,
    )
    report["runner_outcome"] = outcome
    report["observed_at"] = utc_now()
    if not report.get("complete"):
        report["status"] = "runner_interrupted" if outcome == "cancelled" else "runner_error"
    report_requests = dict(report.get("requests") or {})
    report_requests["claimed_this_run"] = claimed
    report_requests["allocation"] = (
        dict(progress.get("allocation") or {})
        if progress is not None and not journal_missing
        else None
    )
    report_requests["preflight"] = (
        dict(progress.get("preflight") or {}) if progress is not None else None
    )
    checkpoint_source = "unavailable"
    if progress is not None and not journal_missing:
        checkpoint_source = (
            "append_only_attempt_journal"
            if journal_attempts is not None
            else "sqlite_committed_batches"
        )
    report_requests["checkpoint"] = {
        "source": checkpoint_source,
        "progress_status": (progress or {}).get("status"),
        "run_id": (progress or {}).get("run_id"),
        "run_attempt": (progress or {}).get("run_attempt"),
        "run_token": (progress or {}).get("run_token"),
        "configured_source": accounting_source or None,
        "committed_lower_bound": (
            int(requests.get("claimed_total") or 0) if journal_missing else None
        ),
        "started_at": (progress or {}).get("started_at"),
        "last_committed_at": (progress or {}).get("last_committed_at"),
        "last_attempt_at": dict((progress or {}).get("request_accounting") or {}).get(
            "last_attempt_at"
        ),
        "quota_observed_at": (progress or {}).get("quota_observed_at"),
        "quota_semantics": (
            (
                "conservative_after_claims"
                if journal_attempts is not None
                else "last_known_after_committed_batch"
            )
            if quota is not None
            else "unavailable"
        ),
    }
    report["requests"] = report_requests
    return report


def write_report(path: Path, report: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


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
    parser.add_argument(
        "--min-lifetime-streams",
        "--min-track-streams",
        dest="min_track_streams",
        type=int,
        default=DEFAULT_MIN_TRACK_STREAMS,
    )
    parser.add_argument(
        "--stream-history-days",
        type=int,
        default=DEFAULT_STREAM_HISTORY_DAYS,
    )
    parser.add_argument("--canary-min-sample", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--continue-zero-yield", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help=(
            "Persist phase-1 source reconciliation and the bounded local queue "
            "without authenticating to Soundcharts"
        ),
    )
    parser.add_argument("--recover-interrupted-report", action="store_true")
    parser.add_argument("--runner-outcome", default="failure")
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", ""))
    parser.add_argument("--run-attempt", default=os.environ.get("GITHUB_RUN_ATTEMPT", ""))
    parser.add_argument("--request-journal", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not 0 <= int(args.max_requests) <= MAX_BATCH_REQUESTS:
        raise FalPhase2Error(f"max_requests must be between 0 and {MAX_BATCH_REQUESTS}")
    if not 0 <= int(args.max_new_queue) <= MAX_QUEUE_MIGRATION:
        raise FalPhase2Error(f"max_new_queue must be between 0 and {MAX_QUEUE_MIGRATION}")
    if int(args.min_track_streams) < 0:
        raise FalPhase2Error("min_track_streams must be non-negative")
    if not 65 <= int(args.stream_history_days) <= 365:
        raise FalPhase2Error("stream_history_days must be between 65 and 365")
    if args.dry_run and args.prepare_only:
        raise FalPhase2Error("dry_run and prepare_only are mutually exclusive")
    if args.recover_interrupted_report and args.prepare_only:
        raise FalPhase2Error("recover_interrupted_report and prepare_only are mutually exclusive")
    if args.prepare_only and not str(args.phase1_source_id or "").strip():
        raise FalPhase2Error("prepare_only requires a non-empty phase1_source_id")
    phase1 = open_phase1_state(args.phase1_state)
    dry_run_dir: tempfile.TemporaryDirectory[str] | None = None
    client: Any | None = None
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
        seed_stream_gate(
            phase2,
            min_track_streams=args.min_track_streams,
            history_days=args.stream_history_days,
        )
        if args.recover_interrupted_report:
            report = build_interrupted_report(
                phase1,
                phase2,
                recent_days=args.recent_days,
                as_of=args.as_of,
                active_queue_cap=args.active_queue_cap,
                canary_min_sample=args.canary_min_sample,
                runner_outcome=args.runner_outcome,
                run_id=args.run_id,
                run_attempt=args.run_attempt,
                request_journal=args.request_journal,
            )
            write_report(args.report, report)
            print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
            return 0
        reconcile_phase1_source(phase1, phase2, args.phase1_source_id)
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
        # A dry run simulates migration on its isolated copy.  Prepare-only
        # deliberately persists the same bounded local handoff without making
        # any Soundcharts request.  Paid runs migrate between gate/detail slices
        # so newly admitted artists can yield tracks during that same run.
        if (args.dry_run or args.prepare_only) and not paused:
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
        stream_active = int(
            phase2.execute(
                """SELECT COUNT(*) FROM fal_phase2_stream_gate
                    WHERE gate_status IN ('pending','retry')"""
            ).fetchone()[0]
        )
        eligible_bulk_remaining = int(
            phase2.execute(
                """SELECT COUNT(*) FROM fal_phase2_artist_gate
                    WHERE gate_status='eligible' AND bulk_complete=0"""
            ).fetchone()[0]
        )
        if (
            (paused and artist_active == 0 and stream_active == 0)
            or args.dry_run
            or args.prepare_only
            or (
                artist_active <= 0
                and active <= 0
                and stream_active <= 0
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
                    if paused and artist_active == 0 and stream_active == 0
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
                min_track_streams=args.min_track_streams,
                stream_history_days=args.stream_history_days,
                initial_migration=migration,
                budget_plan=plan,
                run_id=args.run_id,
                run_attempt=args.run_attempt,
                request_journal=args.request_journal,
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
        journal = getattr(client, "_fal_phase2_request_journal", None)
        if isinstance(journal, RequestAttemptJournal):
            journal.close()
        phase2.close()
        phase1.close()
        if dry_run_dir is not None:
            dry_run_dir.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
