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
    progress: Mapping[str,…19068 tokens truncated… "active": artist_gate_active,
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
