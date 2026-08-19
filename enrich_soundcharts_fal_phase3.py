#!/usr/bin/env python3
"""Enrich the highest-confidence FAL review bucket in private staging only.

Phase 3 deliberately does not publish or promote anything.  It joins exact
artist identities from the immutable phase-1 checkpoint, reuses normalized
Soundcharts song evidence already present in the private cache, and spends API
quota only on the remaining artist identifiers and song details.  Missing
evidence stays missing; source approval and human review are never automated.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import re
import sqlite3
import urllib.parse
import uuid as uuid_module
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from build_soundcharts_fal_review_manifest import (
    blocking_fields as review_blocking_fields,
    classify_review_bucket,
    forbidden_genres_detected as review_forbidden_genres_detected,
    stable_digest,
)
from expand_soundcharts_instrumental_pool import (
    SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
    infer_rights,
    parse_artist_identifiers,
    parse_song_detail,
)
from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsHttpError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
)


PHASE3_VERSION = 1
MANIFEST_VERSION = 1
DEFAULT_STATE = Path("soundcharts-fal-phase3-state-v1.sqlite3")
DEFAULT_REPORT = Path("soundcharts-fal-phase3-report-v1.json")
DEFAULT_ENRICHED_MANIFEST = Path("soundcharts-fal-phase3-review-manifest-v1.json")
DEFAULT_MINIMUM_STREAMS = 100_000
DEFAULT_MAX_REQUESTS = 0
ABSOLUTE_MAX_REQUESTS = 4_000
MIN_QUOTA_RESERVE = 1_400_000
DEFAULT_WORKERS = 8
MAX_WORKERS = 10
DEFAULT_RETRY_LIMIT = 3
ADVANCED_BUCKET = "ai_review_required"
SPOTIFY_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")
PROVIDER_IDENTITY_CONTRACT = "soundcharts_artist_identifiers_default_v1"
CURRENT_PROVIDER_IDENTITY_SOURCES = frozenset(
    {
        "soundcharts_artist_identifiers",
        "soundcharts_artist_identifiers_tiebreak",
    }
)
ACTIVE_REQUEST_STATUSES = {"pending", "retry", "inflight"}
TERMINAL_REQUEST_STATUSES = {
    "complete_cache",
    "complete_phase1",
    "complete_provider",
    "identity_conflict",
    "unavailable",
    "request_failed",
}
RECORD_DIGEST_EXCLUDED_FIELDS = {
    "review_decision",
    "reviewer",
    "reviewed_at",
    "review_sources",
    "review_notes",
    "record_digest",
}
PROVIDER_IDENTITY_RESOLUTION_REASON_ALLOWLIST = {
    "legacy_multi_id_provider_evidence_requeued_for_default_refresh",
    "legacy_multi_id_provider_evidence_retry_budget_exhausted",
    "legacy_provider_identity_outside_cross_source_candidates",
    "provider_exact_identity_missing",
    "provider_exact_identity_missing_cross_source_conflict",
    "provider_multiple_default_identities_cross_source_conflict",
    "provider_multiple_default_identities_without_cross_source_tiebreak",
    "provider_multiple_filtered_identities_cross_source_conflict",
    "provider_multiple_filtered_identities_without_cross_source_tiebreak",
    "provider_unique_default_identity_disagrees_with_existing_identity",
    "provider_unique_default_identity_accepted",
    "provider_unique_default_identity_matches_cross_source_candidate",
    "provider_unique_default_identity_outside_cross_source_candidates",
    "provider_unique_filtered_identity_disagrees_with_existing_identity",
    "provider_unique_filtered_identity_accepted",
    "provider_unique_filtered_identity_matches_cross_source_candidate",
    "provider_unique_filtered_identity_outside_cross_source_candidates",
}


STATE_SCHEMA = """
PRAGMA journal_mode=DELETE;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fal_phase3_tracks (
  track_uuid TEXT PRIMARY KEY,
  spotify_id TEXT NOT NULL,
  candidate_uuid TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  credit_name TEXT NOT NULL DEFAULT '',
  streams_total INTEGER NOT NULL,
  manifest_record_json TEXT NOT NULL,
  manifest_record_digest TEXT NOT NULL,
  detail_status TEXT NOT NULL DEFAULT 'pending',
  rights_status TEXT NOT NULL DEFAULT 'unknown',
  rights_confidence REAL,
  rights_basis TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  copyright TEXT NOT NULL DEFAULT '',
  no_lyrics_status TEXT NOT NULL DEFAULT 'unknown',
  ai_risk TEXT NOT NULL DEFAULT 'unknown',
  provider_evidence_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT '',
  evidence_updated_at TEXT NOT NULL DEFAULT '',
  source_contract TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase3_tracks_candidate
  ON fal_phase3_tracks(candidate_uuid,track_uuid);
CREATE TABLE IF NOT EXISTS fal_phase3_artists (
  candidate_uuid TEXT PRIMARY KEY,
  candidate_name TEXT NOT NULL DEFAULT '',
  spotify_id TEXT NOT NULL DEFAULT '',
  identity_status TEXT NOT NULL DEFAULT 'pending',
  identity_source TEXT NOT NULL DEFAULT '',
  identifiers_evidence_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fal_phase3_artists_spotify
  ON fal_phase3_artists(spotify_id);
CREATE TABLE IF NOT EXISTS fal_phase3_requests (
  request_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  last_run_id TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  queued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(request_kind,entity_id)
);
CREATE INDEX IF NOT EXISTS idx_fal_phase3_requests_status
  ON fal_phase3_requests(status,request_kind,entity_id);
CREATE TABLE IF NOT EXISTS fal_phase3_request_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  request_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  UNIQUE(run_id,request_kind,entity_id,attempt_number)
);
"""


class FalPhase3Error(RuntimeError):
    """Raised when private phase-3 evidence cannot be handled safely."""


@dataclass(frozen=True)
class RequestTask:
    kind: str
    entity_id: str

    @property
    def path(self) -> str:
        quoted = urllib.parse.quote(self.entity_id)
        if self.kind == "artist_identifiers":
            return (
                f"/api/v2/artist/{quoted}/identifiers"
                "?platform=spotify&onlyDefault=true&offset=0&limit=100"
            )
        if self.kind == "song_detail":
            return f"/api/v2.25/song/{quoted}"
        raise FalPhase3Error(f"Unsupported request kind: {self.kind}")


@dataclass(frozen=True)
class RequestOutcome:
    task: RequestTask
    payload: Any = None
    error_code: str = ""
    auth_failure: bool = False


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def exact_spotify_id(value: Any) -> str:
    candidate = str(value or "").strip()
    return candidate if SPOTIFY_ID_RE.fullmatch(candidate) else ""


def aware_iso_timestamp(value: Any) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    try:
        parsed = dt.datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return candidate if parsed.tzinfo is not None else ""


def provider_identity_provenance(
    evidence: Mapping[str, Any] | None,
) -> tuple[str, str]:
    evidence = evidence if isinstance(evidence, Mapping) else {}
    contract = str(evidence.get("provider_identity_contract") or "")
    observed_at = aware_iso_timestamp(evidence.get("provider_identity_observed_at"))
    if contract != PROVIDER_IDENTITY_CONTRACT or not observed_at:
        return "", ""
    return contract, observed_at


def file_sha256(path: Path) -> str:
    if not path.is_file():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def enriched_record_digest(record: Mapping[str, Any]) -> str:
    """Return the evidence digest while keeping manual review fields mutable."""

    return stable_digest(
        {
            key: value
            for key, value in record.items()
            if key not in RECORD_DIGEST_EXCLUDED_FIELDS
        }
    )


def recalculate_enriched_manifest_digests(
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Rebuild every row digest and the ordered manifest digest in place."""

    raw_rows = payload.get("tracks")
    if not isinstance(raw_rows, list):
        raise FalPhase3Error("Enriched manifest has no track rows")
    rows: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_rows):
        if not isinstance(raw, Mapping):
            raise FalPhase3Error(f"Enriched manifest row {index} is not an object")
        record = dict(raw)
        record["record_digest"] = enriched_record_digest(record)
        rows.append(record)
    payload["tracks"] = rows
    payload["track_schema"] = list(rows[0]) if rows else []
    summary = payload.get("summary")
    summary = dict(summary) if isinstance(summary, Mapping) else {}
    summary["tracks"] = len(rows)
    payload["summary"] = summary
    payload["records_digest"] = stable_digest(
        [record["record_digest"] for record in rows]
    )
    return {
        "records_digest": payload["records_digest"],
        "row_count": len(rows),
    }


def validate_enriched_manifest_digests(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Verify row/manifest digests and the manual-pending Phase-3 contract."""

    raw_rows = payload.get("tracks")
    if not isinstance(raw_rows, list):
        raise FalPhase3Error("Enriched manifest has no track rows")
    row_digests: list[str] = []
    for index, raw in enumerate(raw_rows):
        if not isinstance(raw, Mapping):
            raise FalPhase3Error(f"Enriched manifest row {index} is not an object")
        expected = enriched_record_digest(raw)
        if str(raw.get("record_digest") or "") != expected:
            raise FalPhase3Error(f"Enriched manifest row {index} has a stale digest")
        if raw.get("source_approved_for_publication") is not False:
            raise FalPhase3Error("Phase 3 cannot approve a publication source")
        if str(raw.get("review_decision") or "pending") != "pending":
            raise FalPhase3Error("Phase 3 cannot complete human review")
        review_sources = raw.get("review_sources")
        if isinstance(review_sources, Sequence) and not isinstance(
            review_sources, (str, bytes, bytearray)
        ):
            has_review_sources = bool(review_sources)
        else:
            has_review_sources = bool(review_sources)
        if any(
            (
                str(raw.get("reviewer") or "").strip(),
                str(raw.get("reviewed_at") or "").strip(),
                has_review_sources,
                str(raw.get("review_notes") or "").strip(),
            )
        ):
            raise FalPhase3Error("Phase 3 manual review fields must remain pending")
        row_digests.append(expected)
    expected_records_digest = stable_digest(row_digests)
    if str(payload.get("records_digest") or "") != expected_records_digest:
        raise FalPhase3Error("Enriched manifest records digest is stale")
    summary = payload.get("summary")
    if not isinstance(summary, Mapping) or int(summary.get("tracks") or 0) != len(
        raw_rows
    ):
        raise FalPhase3Error("Enriched manifest row count is inconsistent")
    return {
        "records_digest": expected_records_digest,
        "row_count": len(raw_rows),
    }


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise FalPhase3Error(f"{label} is missing: {path.resolve()}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FalPhase3Error(f"{label} is not valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise FalPhase3Error(f"{label} must be a JSON object")
    return dict(payload)


def validate_manifest(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    if int(payload.get("version") or 0) != MANIFEST_VERSION:
        raise FalPhase3Error("Phase 3 requires review manifest version 1")
    if payload.get("staging_only") is not True:
        raise FalPhase3Error("Review manifest is not staging-only")
    if payload.get("canonical_written") is not False:
        raise FalPhase3Error("Review manifest reports a canonical write")
    if payload.get("dashboard_written") is not False:
        raise FalPhase3Error("Review manifest reports a dashboard write")
    if int(payload.get("minimum_lifetime_streams") or 0) != DEFAULT_MINIMUM_STREAMS:
        raise FalPhase3Error("Review manifest lost the strict 100k floor")
    rows = payload.get("tracks")
    if not isinstance(rows, list):
        raise FalPhase3Error("Review manifest has no track rows")
    advanced: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, Mapping) or raw.get("review_bucket") != ADVANCED_BUCKET:
            continue
        row = dict(raw)
        track_uuid = str(row.get("track_uuid") or "").strip()
        spotify_id = exact_spotify_id(row.get("spotify_id"))
        candidate_uuid = str(row.get("candidate_uuid") or "").strip()
        streams = finite_number(row.get("streams_total"))
        if not track_uuid or not spotify_id or not candidate_uuid:
            raise FalPhase3Error("Advanced review row has an incomplete exact identity")
        if streams is None or streams < DEFAULT_MINIMUM_STREAMS:
            raise FalPhase3Error("Advanced review row is below the 100k floor")
        if str(row.get("instrumental_status") or "").casefold() != "instrumental":
            raise FalPhase3Error("Advanced review row lost instrumental evidence")
        if str(row.get("genre_status") or "").casefold() != "in_scope":
            raise FalPhase3Error("Advanced review row lost genre evidence")
        advanced.append(row)
    expected = (
        ((payload.get("summary") or {}).get("by_bucket") or {}).get(ADVANCED_BUCKET)
        if isinstance(payload.get("summary"), Mapping)
        else None
    )
    if expected is not None and int(expected) != len(advanced):
        raise FalPhase3Error("Advanced bucket count differs from manifest summary")
    return advanced


def open_state(path: Path) -> tuple[sqlite3.Connection, bool]:
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.is_file() and path.stat().st_size > 0
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(STATE_SCHEMA)
    # Version-1 checkpoints created by an early Phase-3 draft did not yet
    # quarantine rows removed from the current source manifest.  Add the
    # flags in place so an encrypted checkpoint remains safely resumable.
    for table in ("fal_phase3_tracks", "fal_phase3_artists", "fal_phase3_requests"):
        columns = {
            str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if "is_active" not in columns:
            connection.execute(
                f"ALTER TABLE {table} ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"
            )
    track_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(fal_phase3_tracks)").fetchall()
    }
    for column in ("evidence_updated_at", "source_contract"):
        if column not in track_columns:
            connection.execute(
                f"ALTER TABLE fal_phase3_tracks ADD COLUMN {column} "
                "TEXT NOT NULL DEFAULT ''"
            )
    check = connection.execute("PRAGMA quick_check").fetchone()
    if not check or check[0] != "ok":
        connection.close()
        raise FalPhase3Error(f"Phase-3 SQLite quick_check failed: {check!r}")
    stored = connection.execute(
        "SELECT value FROM meta WHERE key='fal_phase3_state_version'"
    ).fetchone()
    if stored is not None and int(stored[0]) != PHASE3_VERSION:
        connection.close()
        raise FalPhase3Error(
            f"Unsupported phase-3 state version {stored[0]} (expected {PHASE3_VERSION})"
        )
    connection.execute(
        "INSERT INTO meta(key,value) VALUES('fal_phase3_state_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(PHASE3_VERSION),),
    )
    connection.commit()
    return connection, not existed


def seed_advanced_bucket(
    connection: sqlite3.Connection,
    rows: Sequence[Mapping[str, Any]],
) -> tuple[int, int]:
    now = utc_now()
    tracks_before = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_tracks WHERE is_active=1").fetchone()[0]
    )
    artists_before = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_artists WHERE is_active=1").fetchone()[0]
    )
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("UPDATE fal_phase3_tracks SET is_active=0")
        connection.execute("UPDATE fal_phase3_artists SET is_active=0")
        connection.execute("UPDATE fal_phase3_requests SET is_active=0")
        for record in rows:
            track_uuid = str(record["track_uuid"])
            spotify_id = exact_spotify_id(record.get("spotify_id"))
            candidate_uuid = str(record["candidate_uuid"])
            existing = connection.execute(
                "SELECT spotify_id,candidate_uuid FROM fal_phase3_tracks WHERE track_uuid=?",
                (track_uuid,),
            ).fetchone()
            if existing is not None and (
                str(existing["spotify_id"]) != spotify_id
                or str(existing["candidate_uuid"]) != candidate_uuid
            ):
                raise FalPhase3Error(
                    f"Track identity mutation detected for {track_uuid}; checkpoint left unchanged"
                )
            record_digest = str(record.get("record_digest") or stable_digest(record))
            connection.execute(
                """INSERT INTO fal_phase3_tracks(
                     track_uuid,spotify_id,candidate_uuid,title,credit_name,streams_total,
                     manifest_record_json,manifest_record_digest,is_active,first_seen_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,1,?,?)
                   ON CONFLICT(track_uuid) DO UPDATE SET
                     title=excluded.title,credit_name=excluded.credit_name,
                     streams_total=excluded.streams_total,
                     manifest_record_json=excluded.manifest_record_json,
                     manifest_record_digest=excluded.manifest_record_digest,
                     is_active=1,updated_at=excluded.updated_at""",
                (
                    track_uuid,
                    spotify_id,
                    candidate_uuid,
                    str(record.get("title") or ""),
                    str(record.get("credit_name") or ""),
                    int(finite_number(record.get("streams_total")) or 0),
                    safe_json(dict(record)),
                    record_digest,
                    now,
                    now,
                ),
            )
            connection.execute(
                """INSERT INTO fal_phase3_artists(
                     candidate_uuid,candidate_name,is_active,first_seen_at,updated_at)
                   VALUES(?,?,1,?,?) ON CONFLICT(candidate_uuid) DO UPDATE SET
                     candidate_name=CASE WHEN excluded.candidate_name<>''
                                         THEN excluded.candidate_name
                                         ELSE fal_phase3_artists.candidate_name END,
                     is_active=1,updated_at=excluded.updated_at""",
                (candidate_uuid, str(record.get("candidate_name") or ""), now, now),
            )
            for kind, entity_id in (
                ("artist_identifiers", candidate_uuid),
                ("song_detail", track_uuid),
            ):
                connection.execute(
                    """INSERT INTO fal_phase3_requests(
                         request_kind,entity_id,is_active,queued_at,updated_at)
                       VALUES(?,?,1,?,?) ON CONFLICT(request_kind,entity_id) DO UPDATE SET
                         is_active=1,updated_at=excluded.updated_at""",
                    (kind, entity_id, now, now),
                )
        connection.execute(
            """UPDATE fal_phase3_requests SET status='retry',
                      error_code='interrupted_before_commit',updated_at=?
                 WHERE status='inflight' AND is_active=1""",
            (now,),
        )
        # Existing encrypted v1 checkpoints predate per-row evidence
        # provenance. Requeue those terminal song rows so a current cache or a
        # bounded provider call can establish the timestamp and contract rather
        # than silently treating legacy evidence as current.
        connection.execute(
            """UPDATE fal_phase3_requests SET status='retry',attempts=0,
                      error_code='missing_evidence_provenance',updated_at=?
                 WHERE request_kind='song_detail' AND is_active=1
                   AND entity_id IN (
                     SELECT track_uuid FROM fal_phase3_tracks
                      WHERE is_active=1
                        AND detail_status IN ('complete_cache','complete_provider')
                        AND (evidence_updated_at='' OR source_contract<>?)
                   )""",
            (now, SOUNDCHARTS_SONG_EVIDENCE_CONTRACT),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    tracks_after = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_tracks WHERE is_active=1").fetchone()[0]
    )
    artists_after = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_artists WHERE is_active=1").fetchone()[0]
    )
    return max(0, tracks_after - tracks_before), max(0, artists_after - artists_before)


def _read_only_sqlite(path: Path, required_table: str) -> sqlite3.Connection:
    if not path.is_file() or path.stat().st_size <= 0:
        raise FalPhase3Error(f"Private source SQLite is missing: {path.resolve()}")
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    check = connection.execute("PRAGMA quick_check").fetchone()
    table = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (required_table,)
    ).fetchone()
    if not check or check[0] != "ok" or table is None:
        connection.close()
        raise FalPhase3Error(f"Invalid private source SQLite: {path.resolve()}")
    return connection


def hydrate_artist_identities_from_phase1(
    connection: sqlite3.Connection,
    phase1_path: Path | None,
    *,
    retry_limit: int = DEFAULT_RETRY_LIMIT,
) -> int:
    if phase1_path is None:
        return 0
    source = _read_only_sqlite(phase1_path, "candidates")
    try:
        relation_table = source.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_tracks'"
        ).fetchone()
        if relation_table is None:
            raise FalPhase3Error("Phase-1 checkpoint lacks candidate_tracks provenance")
        active_tracks: dict[str, set[str]] = {}
        for row in connection.execute(
            "SELECT candidate_uuid,track_uuid FROM fal_phase3_tracks WHERE is_active=1"
        ).fetchall():
            active_tracks.setdefault(str(row["candidate_uuid"]), set()).add(str(row["track_uuid"]))
        uuids = sorted(active_tracks)
        identities: dict[str, str] = {}
        for offset in range(0, len(uuids), 400):
            chunk = uuids[offset : offset + 400]
            placeholders = ",".join("?" for _ in chunk)
            candidate_rows = source.execute(
                f"""SELECT soundcharts_uuid,spotify_id FROM candidates
                      WHERE soundcharts_uuid IN ({placeholders})
                        AND status IN ('review_inventory_complete','review_complete','eligible_complete')
                        AND COALESCE(catalog_total,0)>0""",
                chunk,
            ).fetchall()
            eligible_uuids = {str(row["soundcharts_uuid"]) for row in candidate_rows}
            related: set[str] = set()
            if eligible_uuids:
                relation_placeholders = ",".join("?" for _ in eligible_uuids)
                for relation in source.execute(
                    f"""SELECT candidate_uuid,track_uuid FROM candidate_tracks
                           WHERE candidate_uuid IN ({relation_placeholders})""",
                    sorted(eligible_uuids),
                ).fetchall():
                    candidate_uuid = str(relation["candidate_uuid"])
                    if str(relation["track_uuid"]) in active_tracks.get(candidate_uuid, set()):
                        related.add(candidate_uuid)
            for row in candidate_rows:
                if str(row["soundcharts_uuid"]) not in related:
                    continue
                spotify_id = exact_spotify_id(row["spotify_id"])
                if spotify_id:
                    identities[str(row["soundcharts_uuid"])] = spotify_id
    finally:
        source.close()
    now = utc_now()
    changed = 0
    for candidate_uuid, spotify_id in identities.items():
        existing = connection.execute(
            """SELECT spotify_id,identity_status,identity_source,identifiers_evidence_json
                 FROM fal_phase3_artists
                 WHERE candidate_uuid=? AND is_active=1""",
            (candidate_uuid,),
        ).fetchone()
        if existing is None:
            continue
        existing_id = exact_spotify_id(existing["spotify_id"])
        # Soundcharts can expose several candidate UUID aliases for the same
        # exact Spotify artist.  That many-to-one mapping is valid.  Only a
        # disagreement for the same candidate UUID is an identity conflict.
        conflict = bool(existing_id and existing_id != spotify_id)
        try:
            evidence = json.loads(str(existing["identifiers_evidence_json"] or "{}"))
        except json.JSONDecodeError:
            evidence = {}
        evidence = dict(evidence) if isinstance(evidence, Mapping) else {}
        evidence_ids = {
            exact_spotify_id(value)
            for key in (
                "existing_spotify_id",
                "cache_spotify_id",
                "provider_spotify_id",
                "spotify_id",
            )
            for value in (evidence.get(key),)
            if exact_spotify_id(value)
        }
        raw_evidence_ids = evidence.get("spotify_ids")
        provider_ids_from_evidence: set[str] = set()
        if isinstance(raw_evidence_ids, Sequence) and not isinstance(
            raw_evidence_ids, (str, bytes, bytearray)
        ):
            provider_ids_from_evidence.update(
                exact_spotify_id(value)
                for value in raw_evidence_ids
                if exact_spotify_id(value)
            )
            evidence_ids.update(provider_ids_from_evidence)
        sticky_evidence_conflict = bool(
            str(existing["identity_status"] or "") == "identity_conflict"
            and any(value != spotify_id for value in evidence_ids)
        )
        adjudicated_id = exact_spotify_id(evidence.get("provider_spotify_id"))
        provider_tiebreak_complete = bool(
            str(existing["identity_source"] or "")
            == "soundcharts_artist_identifiers_tiebreak"
            and existing_id
            and existing_id == adjudicated_id
        )
        cache_id = exact_spotify_id(evidence.get("cache_spotify_id"))
        cache_provider_tiebreak = bool(
            str(existing["identity_source"] or "")
            == "cache_or_cross_source_identity_conflict"
            and cache_id
            and cache_id != spotify_id
            and not adjudicated_id
        )
        legacy_multi_id_tiebreak = bool(
            str(existing["identity_status"] or "") == "identity_conflict"
            and str(existing["identity_source"] or "")
            == "soundcharts_artist_identifiers_conflict"
            and evidence.get("provider_tiebreak_initialized") is True
            and cache_id
            and cache_id != spotify_id
            and len(provider_ids_from_evidence) > 1
            and not adjudicated_id
            and "provider_spotify_identifiers_v2" not in evidence
            and evidence.get("provider_default_refresh_initialized") is not True
        )
        legacy_retry_available = False
        if legacy_multi_id_tiebreak:
            request = connection.execute(
                """SELECT attempts FROM fal_phase3_requests
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (candidate_uuid,),
            ).fetchone()
            attempts = int(request["attempts"] or 0) if request is not None else retry_limit
            legacy_retry_available = attempts < int(retry_limit)
            evidence["provider_default_refresh_initialized"] = True
            evidence["provider_identity_reason"] = (
                "legacy_multi_id_provider_evidence_requeued_for_default_refresh"
                if legacy_retry_available
                else "legacy_multi_id_provider_evidence_retry_budget_exhausted"
            )
        elif (
            str(existing["identity_status"] or "") == "identity_conflict"
            and adjudicated_id
            and adjudicated_id not in {spotify_id, cache_id}
            and not evidence.get("provider_identity_reason")
        ):
            evidence["provider_identity_reason"] = (
                "legacy_provider_identity_outside_cross_source_candidates"
            )
        needs_provider_tiebreak = bool(
            cache_provider_tiebreak or (legacy_multi_id_tiebreak and legacy_retry_available)
        )
        initialize_cache_tiebreak = bool(
            cache_provider_tiebreak
            and evidence.get("provider_tiebreak_initialized") is not True
        )
        initialize_provider_tiebreak = bool(
            initialize_cache_tiebreak
            or (legacy_multi_id_tiebreak and legacy_retry_available)
        )
        if needs_provider_tiebreak:
            evidence["provider_tiebreak_initialized"] = True
        if provider_tiebreak_complete:
            conflict = False
        else:
            conflict = conflict or sticky_evidence_conflict
        status = "identity_conflict" if conflict else "complete"
        selected = "" if conflict else spotify_id
        identity_source = "phase1_candidates_exact_spotify_id"
        if provider_tiebreak_complete:
            selected = existing_id
            identity_source = "soundcharts_artist_identifiers_tiebreak"
        elif needs_provider_tiebreak:
            identity_source = "cache_or_cross_source_identity_conflict"
        evidence["phase1_spotify_id"] = spotify_id
        if existing_id:
            evidence["existing_spotify_id"] = existing_id
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id=?,identity_status=?,identity_source=?,
                      identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=?""",
            (
                selected,
                status,
                identity_source,
                safe_json(evidence),
                now,
                candidate_uuid,
            ),
        )
        request_status = (
            "retry"
            if needs_provider_tiebreak
            else "complete_provider"
            if provider_tiebreak_complete
            else "identity_conflict"
            if conflict
            else "complete_phase1"
        )
        error_code = (
            "cross_source_identity_requires_provider_tiebreak"
            if needs_provider_tiebreak
            else "duplicate_or_conflicting_phase1_artist_identity"
            if conflict
            else None
        )
        if not needs_provider_tiebreak or initialize_provider_tiebreak:
            connection.execute(
                """UPDATE fal_phase3_requests SET status=?,error_code=?,updated_at=?
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (request_status, error_code, now, candidate_uuid),
            )
        if initialize_cache_tiebreak:
            connection.execute(
                """UPDATE fal_phase3_requests SET attempts=0
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (candidate_uuid,),
            )
        changed += int(
            not conflict
            and (
                existing_id != selected
                or existing["identity_status"] != "complete"
                or str(existing["identity_source"] or "") != identity_source
            )
        )
    connection.commit()
    return changed


def strict_track_evidence(
    parsed: Mapping[str, Any],
    *,
    source: str = "soundcharts_song_v2_25",
) -> dict[str, Any]:
    """Keep the explicit subset of one already-normalized v2.25 song detail.

    ``parse_song_detail`` is intentionally called exactly once at the network
    boundary.  Re-parsing its normalized result as a provider object can drop
    the original evidence contract, rights and boolean lyric fields.
    """

    parsed = dict(parsed) if isinstance(parsed, Mapping) else {}
    evidence = parsed.get("source_evidence")
    evidence = dict(evidence) if isinstance(evidence, Mapping) else {}
    label = str(parsed.get("label") or "").strip()
    copyright_text = str(parsed.get("copyright") or "").strip()
    rights_status = str(parsed.get("rights_status") or "unknown").strip().casefold()
    rights_confidence = finite_number(parsed.get("rights_confidence"))
    if rights_status not in {"self_released", "independent_label", "major", "mixed", "other_label"}:
        rights_status = "unknown"
        rights_confidence = None
    if rights_status == "unknown" and (label or copyright_text):
        artists = parsed.get("artists")
        artists = [dict(item) for item in artists if isinstance(item, Mapping)] if isinstance(artists, list) else []
        inferred_status, inferred_confidence = infer_rights(
            label,
            copyright_text,
            artists,
            str(parsed.get("credit_name") or ""),
        )
        if inferred_status != "unknown":
            rights_status = inferred_status
            rights_confidence = inferred_confidence
    rights_basis = ""
    if rights_status != "unknown":
        rights_basis = "soundcharts_song_label_and_copyright"
    no_lyrics = evidence.get("vocal") is False or evidence.get("no_lyrics") is True
    ai_risk = str(evidence.get("ai_risk") or parsed.get("ai_risk") or "unknown").strip().casefold()
    if ai_risk not in {"low", "faible", "high", "elevated", "eleve", "elevé"}:
        ai_risk = "unknown"
    if ai_risk == "faible":
        ai_risk = "low"
    if ai_risk in {"elevated", "eleve", "elevé"}:
        ai_risk = "high"
    evidence_updated_at = str(
        parsed.get("soundcharts_genres_checked_at") or parsed.get("fetched_at") or ""
    ).strip()
    source_contract = str(parsed.get("soundcharts_evidence_contract") or "").strip()
    normalized_evidence = {
        "source": source,
        "source_contract": source_contract,
        "evidence_updated_at": evidence_updated_at,
        "instrumental": (
            evidence.get("instrumental")
            if isinstance(evidence.get("instrumental"), bool)
            else None
        ),
        "vocal": evidence.get("vocal") if isinstance(evidence.get("vocal"), bool) else None,
        "genres": list(evidence.get("genres") or []),
        "ai_risk": ai_risk,
        "rights_status": rights_status,
        "rights_confidence": rights_confidence,
        "rights_basis": rights_basis,
        "no_lyrics": True if no_lyrics else None,
    }
    return {
        "rights_status": rights_status,
        "rights_confidence": rights_confidence,
        "rights_basis": rights_basis,
        "label": label,
        "copyright": copyright_text,
        "no_lyrics_status": "confirmed" if no_lyrics else "unknown",
        "ai_risk": ai_risk,
        "evidence_updated_at": evidence_updated_at,
        "source_contract": source_contract,
        "provider_evidence": normalized_evidence,
    }


def current_song_cache_entry(entry: Mapping[str, Any]) -> bool:
    """Return true only for a timestamped normalized v2.25 cache row."""

    if str(entry.get("soundcharts_evidence_contract") or "") != SOUNDCHARTS_SONG_EVIDENCE_CONTRACT:
        return False
    raw_stamp = str(
        entry.get("soundcharts_genres_checked_at") or entry.get("fetched_at") or ""
    ).strip()
    if not raw_stamp:
        return False
    try:
        parsed_stamp = dt.datetime.fromisoformat(raw_stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed_stamp.tzinfo is not None


def current_artist_cache_entry(entry: Mapping[str, Any]) -> bool:
    """Accept only an exact provider identity with a valid fetch timestamp."""

    if not exact_spotify_id(entry.get("spotify_id")):
        return False
    raw_stamp = str(entry.get("identifiers_fetched_at") or "").strip()
    if not raw_stamp:
        return False
    try:
        parsed_stamp = dt.datetime.fromisoformat(raw_stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed_stamp.tzinfo is not None


def _apply_track_evidence(
    connection: sqlite3.Connection,
    track_uuid: str,
    evidence: Mapping[str, Any],
    *,
    detail_status: str,
    source_kind: str,
) -> None:
    now = utc_now()
    previous = connection.execute(
        """SELECT rights_status,rights_confidence,rights_basis,label,copyright,
                  no_lyrics_status,ai_risk,provider_evidence_json,source_kind,
                  evidence_updated_at,source_contract
             FROM fal_phase3_tracks WHERE track_uuid=? AND is_active=1""",
        (track_uuid,),
    ).fetchone()
    if previous is None:
        raise FalPhase3Error(f"Track evidence has no active phase-3 row: {track_uuid}")
    try:
        previous_provider = json.loads(str(previous["provider_evidence_json"] or "{}"))
    except json.JSONDecodeError:
        previous_provider = {}
    previous_provider = previous_provider if isinstance(previous_provider, Mapping) else {}
    incoming_provider = evidence.get("provider_evidence")
    incoming_provider = incoming_provider if isinstance(incoming_provider, Mapping) else {}

    def risk_boolean(key: str) -> bool | None:
        old = previous_provider.get(key)
        new = incoming_provider.get(key)
        if key == "vocal":
            if old is True or new is True:
                return True
            if old is False or new is False:
                return False
        if key == "instrumental":
            if old is False or new is False:
                return False
            if old is True or new is True:
                return True
        return None

    merged_provider = dict(previous_provider)
    for key, value in incoming_provider.items():
        if value is not None and value != "":
            merged_provider[key] = value
    merged_provider["vocal"] = risk_boolean("vocal")
    merged_provider["instrumental"] = risk_boolean("instrumental")
    old_genres = previous_provider.get("genres") if isinstance(previous_provider.get("genres"), list) else []
    new_genres = incoming_provider.get("genres") if isinstance(incoming_provider.get("genres"), list) else []
    merged_provider["genres"] = list(
        dict.fromkeys(str(value) for value in [*old_genres, *new_genres] if str(value).strip())
    )

    old_ai = str(previous["ai_risk"] or "unknown")
    new_ai = str(evidence.get("ai_risk") or "unknown")
    ai_risk = "high" if "high" in {old_ai, new_ai} else "low" if "low" in {old_ai, new_ai} else "unknown"
    merged_provider["ai_risk"] = ai_risk

    rights_rank = {
        "unknown": 0,
        "self_released": 1,
        "independent_label": 2,
        "other_label": 3,
        "mixed": 4,
        "major": 5,
    }
    old_rights = str(previous["rights_status"] or "unknown")
    new_rights = str(evidence.get("rights_status") or "unknown")
    use_previous_rights = rights_rank.get(old_rights, 0) > rights_rank.get(new_rights, 0)
    rights_status = old_rights if use_previous_rights else new_rights
    rights_confidence = (
        finite_number(previous["rights_confidence"])
        if use_previous_rights
        else finite_number(evidence.get("rights_confidence"))
    )
    rights_basis = (
        str(previous["rights_basis"] or "")
        if use_previous_rights
        else str(evidence.get("rights_basis") or "")
    )
    merged_provider["rights_status"] = rights_status
    merged_provider["rights_confidence"] = rights_confidence
    merged_provider["rights_basis"] = rights_basis

    explicit_vocal = merged_provider.get("vocal") is True or merged_provider.get("instrumental") is False
    old_no_lyrics = str(previous["no_lyrics_status"] or "unknown") == "confirmed"
    new_no_lyrics = str(evidence.get("no_lyrics_status") or "unknown") == "confirmed"
    no_lyrics_status = "confirmed" if not explicit_vocal and (old_no_lyrics or new_no_lyrics) else "unknown"
    merged_provider["no_lyrics"] = True if no_lyrics_status == "confirmed" else None
    merged_source_kind = source_kind
    if str(previous["source_kind"] or "") and dict(previous_provider):
        merged_source_kind = f"{source_kind}_fail_closed_merge"
    evidence_updated_at = str(
        evidence.get("evidence_updated_at") or previous["evidence_updated_at"] or ""
    ).strip()
    source_contract = str(
        evidence.get("source_contract") or previous["source_contract"] or ""
    ).strip()
    connection.execute(
        """UPDATE fal_phase3_tracks SET detail_status=?,rights_status=?,rights_confidence=?,
                  rights_basis=?,label=?,copyright=?,no_lyrics_status=?,ai_risk=?,
                  provider_evidence_json=?,source_kind=?,evidence_updated_at=?,
                  source_contract=?,updated_at=? WHERE track_uuid=?""",
        (
            detail_status,
            rights_status,
            rights_confidence,
            rights_basis,
            str(evidence.get("label") or previous["label"] or ""),
            str(evidence.get("copyright") or previous["copyright"] or ""),
            no_lyrics_status,
            ai_risk,
            safe_json(merged_provider),
            merged_source_kind,
            evidence_updated_at,
            source_contract,
            now,
            track_uuid,
        ),
    )


def hydrate_from_cache(
    connection: sqlite3.Connection,
    cache_path: Path | None,
    *,
    cache_source_artifact_id: str = "",
    cache_sha256: str = "",
) -> tuple[int, int]:
    if cache_path is None or not cache_path.is_file():
        return 0, 0
    if not re.fullmatch(r"[1-9][0-9]*", str(cache_source_artifact_id or "")):
        raise FalPhase3Error("Soundcharts cache requires an exact artifact ID")
    if not re.fullmatch(r"[0-9a-f]{64}", str(cache_sha256 or "")):
        raise FalPhase3Error("Soundcharts cache requires an exact SHA-256")
    if file_sha256(cache_path) != str(cache_sha256):
        raise FalPhase3Error("Soundcharts cache SHA-256 does not match its restored artifact")
    cache = load_json_object(cache_path, "Soundcharts instrumental cache")
    cached_tracks = cache.get("tracks") if isinstance(cache.get("tracks"), Mapping) else {}
    cached_artists = cache.get("artists") if isinstance(cache.get("artists"), Mapping) else {}
    track_changes = 0
    artist_changes = 0
    now = utc_now()
    for row in connection.execute(
        """SELECT track_uuid,detail_status,evidence_updated_at,source_contract
             FROM fal_phase3_tracks
             WHERE is_active=1"""
    ).fetchall():
        if (
            str(row["detail_status"]) in {"complete_provider", "complete_cache"}
            and str(row["evidence_updated_at"] or "").strip()
            and str(row["source_contract"] or "")
            == SOUNDCHARTS_SONG_EVIDENCE_CONTRACT
        ):
            continue
        entry = cached_tracks.get(str(row["track_uuid"]))
        if not isinstance(entry, Mapping):
            continue
        if str(entry.get("soundcharts_uuid") or "").strip() != str(row["track_uuid"]):
            continue
        current_contract = current_song_cache_entry(entry)
        normalized = strict_track_evidence(
            dict(entry),
            source=(
                "soundcharts_song_v2_25"
                if current_contract
                else "soundcharts_legacy_cache_unverified_contract"
            ),
        )
        _apply_track_evidence(
            connection,
            str(row["track_uuid"]),
            normalized,
            detail_status="complete_cache" if current_contract else str(row["detail_status"]),
            source_kind=(
                "soundcharts_bootstrap_cache_v2_25"
                if current_contract
                else "soundcharts_bootstrap_cache_legacy_nonterminal"
            ),
        )
        if current_contract:
            connection.execute(
                """UPDATE fal_phase3_requests SET status='complete_cache',error_code=NULL,updated_at=?
                     WHERE request_kind='song_detail' AND entity_id=?""",
                (now, str(row["track_uuid"])),
            )
            track_changes += int(row["detail_status"] != "complete_cache")

    artist_rows = connection.execute(
        """SELECT candidate_uuid,spotify_id,identity_status,identity_source,
                  identifiers_evidence_json
             FROM fal_phase3_artists
             WHERE is_active=1"""
    ).fetchall()
    cache_ids: dict[str, str] = {}
    for row in artist_rows:
        candidate_uuid = str(row["candidate_uuid"])
        if str(row["identity_status"]) == "identity_conflict":
            continue
        entry = cached_artists.get(candidate_uuid)
        if isinstance(entry, Mapping) and current_artist_cache_entry(entry):
            spotify_id = exact_spotify_id(entry.get("spotify_id"))
            if spotify_id:
                cache_ids[candidate_uuid] = spotify_id
    for row in artist_rows:
        candidate_uuid = str(row["candidate_uuid"])
        spotify_id = cache_ids.get(candidate_uuid, "")
        current = exact_spotify_id(row["spotify_id"])
        provider_tiebreak_complete = bool(
            str(row["identity_source"] or "")
            == "soundcharts_artist_identifiers_tiebreak"
            and current
        )
        conflict = bool(
            spotify_id
            and current
            and current != spotify_id
            and not provider_tiebreak_complete
        )
        if conflict:
            try:
                evidence = json.loads(str(row["identifiers_evidence_json"] or "{}"))
            except json.JSONDecodeError:
                evidence = {}
            evidence = dict(evidence) if isinstance(evidence, Mapping) else {}
            evidence["existing_spotify_id"] = current
            evidence["cache_spotify_id"] = spotify_id
            evidence["provider_tiebreak_initialized"] = True
            connection.execute(
                """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                          identity_source='cache_or_cross_source_identity_conflict',
                          identifiers_evidence_json=?,updated_at=?
                     WHERE candidate_uuid=?""",
                (safe_json(evidence), now, candidate_uuid),
            )
            connection.execute(
                """UPDATE fal_phase3_requests SET status='retry',attempts=0,
                          error_code='cross_source_identity_requires_provider_tiebreak',updated_at=?
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (now, candidate_uuid),
            )
            continue
        if spotify_id and row["identity_status"] != "complete":
            connection.execute(
                """UPDATE fal_phase3_artists SET spotify_id=?,identity_status='complete',
                          identity_source='soundcharts_bootstrap_cache',updated_at=? WHERE candidate_uuid=?""",
                (spotify_id, now, candidate_uuid),
            )
            connection.execute(
                """UPDATE fal_phase3_requests SET status='complete_cache',error_code=NULL,updated_at=?
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (now, candidate_uuid),
            )
            artist_changes += 1
    connection.commit()
    return track_changes, artist_changes


def pending_tasks(
    connection: sqlite3.Connection,
    *,
    retry_limit: int,
    limit: int,
) -> list[RequestTask]:
    rows = connection.execute(
        """SELECT request_kind,entity_id FROM fal_phase3_requests
             WHERE is_active=1 AND status IN ('pending','retry') AND attempts<?
             ORDER BY CASE request_kind WHEN 'artist_identifiers' THEN 0 ELSE 1 END,
                      entity_id LIMIT ?""",
        (retry_limit, max(0, int(limit))),
    ).fetchall()
    return [RequestTask(str(row["request_kind"]), str(row["entity_id"])) for row in rows]


def claim_tasks(
    connection: sqlite3.Connection,
    tasks: Sequence[RequestTask],
    *,
    run_id: str,
) -> None:
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    for task in tasks:
        row = connection.execute(
            "SELECT attempts FROM fal_phase3_requests WHERE request_kind=? AND entity_id=?",
            (task.kind, task.entity_id),
        ).fetchone()
        attempt = int(row[0] or 0) + 1
        connection.execute(
            """UPDATE fal_phase3_requests SET status='inflight',attempts=?,error_code=NULL,
                      last_run_id=?,updated_at=? WHERE request_kind=? AND entity_id=?""",
            (attempt, run_id, now, task.kind, task.entity_id),
        )
        connection.execute(
            """INSERT INTO fal_phase3_request_attempts(
                 run_id,request_kind,entity_id,attempt_number,started_at)
               VALUES(?,?,?,?,?)""",
            (run_id, task.kind, task.entity_id, attempt, now),
        )
    connection.commit()


def fetch_tasks(client: Any, tasks: Sequence[RequestTask], workers: int) -> list[RequestOutcome]:
    def fetch(task: RequestTask) -> RequestOutcome:
        try:
            return RequestOutcome(task, payload=client.get(task.path))
        except SoundchartsRequestLimitError:
            return RequestOutcome(task, error_code="request_limit")
        except SoundchartsQuotaReserveError:
            return RequestOutcome(task, error_code="quota_reserve")
        except SoundchartsDataUnavailableError:
            return RequestOutcome(task, error_code="unavailable")
        except SoundchartsHttpError as exc:
            if exc.status in {401, 403}:
                return RequestOutcome(task, error_code=f"http_{exc.status}", auth_failure=True)
            return RequestOutcome(task, error_code=f"http_{exc.status}")
        except (SoundchartsError, OSError, RuntimeError):
            return RequestOutcome(task, error_code="request_failed")

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers, len(tasks))) as executor:
        return list(executor.map(fetch, tasks))


def _spotify_identifier_response_evidence(
    payload: Any,
) -> tuple[list[str], str, str, list[dict[str, Any]]]:
    """Normalize top-level Spotify identifiers without inferring a preference.

    The live request is filtered with ``onlyDefault=true``.  One explicit
    default wins even if the provider also returns non-default IDs; otherwise a
    single exact filtered ID is sufficient when the ``default`` flag is
    omitted.  ``verified`` is retained as evidence only and never breaks a tie.
    """

    items = payload.get("items") if isinstance(payload, Mapping) else []
    by_id: dict[str, dict[str, Any]] = {}
    for item in items if isinstance(items, Sequence) else []:
        if not isinstance(item, Mapping):
            continue
        if str(item.get("platformCode") or "").casefold() != "spotify":
            continue
        spotify_id = exact_spotify_id(item.get("identifier"))
        if not spotify_id:
            continue
        normalized = by_id.setdefault(
            spotify_id,
            {
                "spotify_id": spotify_id,
                "default": False,
                "verified": False,
            },
        )
        normalized["default"] = bool(normalized["default"] or item.get("default") is True)
        normalized["verified"] = bool(
            normalized["verified"] or item.get("verified") is True
        )

    normalized_items = [by_id[key] for key in sorted(by_id)]
    provider_ids = [str(item["spotify_id"]) for item in normalized_items]
    default_ids = [
        str(item["spotify_id"]) for item in normalized_items if item["default"] is True
    ]
    if len(default_ids) == 1:
        preferred_id = default_ids[0]
        preference_reason = "provider_unique_default_identity"
    elif len(default_ids) > 1:
        preferred_id = ""
        preference_reason = "provider_multiple_default_identities"
    elif len(provider_ids) == 1:
        preferred_id = provider_ids[0]
        preference_reason = "provider_unique_filtered_identity"
    elif len(provider_ids) > 1:
        preferred_id = ""
        preference_reason = "provider_multiple_filtered_identities"
    else:
        preferred_id = ""
        preference_reason = "provider_exact_identity_missing"
    return provider_ids, preferred_id, preference_reason, normalized_items


def _spotify_ids_in_identifier_response(payload: Any) -> list[str]:
    return _spotify_identifier_response_evidence(payload)[0]


def _store_artist_response(connection: sqlite3.Connection, task: RequestTask, payload: Any) -> str:
    parsed = parse_artist_identifiers(payload)
    (
        provider_spotify_ids,
        preferred_spotify_id,
        provider_preference_reason,
        normalized_provider_identifiers,
    ) = _spotify_identifier_response_evidence(payload)
    now = utc_now()
    existing = connection.execute(
        """SELECT spotify_id,identity_source,identifiers_evidence_json
             FROM fal_phase3_artists
             WHERE candidate_uuid=? AND is_active=1""",
        (task.entity_id,),
    ).fetchone()
    if existing is None:
        raise FalPhase3Error(f"Artist response has no active phase-3 row: {task.entity_id}")
    existing_id = exact_spotify_id(existing["spotify_id"])
    try:
        previous_evidence = json.loads(str(existing["identifiers_evidence_json"] or "{}"))
    except json.JSONDecodeError:
        previous_evidence = {}
    previous_evidence = (
        dict(previous_evidence) if isinstance(previous_evidence, Mapping) else {}
    )
    evidence = previous_evidence
    evidence.update(dict(parsed) if isinstance(parsed, Mapping) else {})
    evidence["provider_spotify_identifiers_v2"] = normalized_provider_identifiers
    evidence["provider_identity_contract"] = PROVIDER_IDENTITY_CONTRACT
    evidence["provider_identity_observed_at"] = now
    evidence["provider_identity_reason"] = provider_preference_reason
    if provider_spotify_ids:
        evidence["spotify_ids"] = provider_spotify_ids
    phase1_id = exact_spotify_id(previous_evidence.get("phase1_spotify_id"))
    cache_id = exact_spotify_id(previous_evidence.get("cache_spotify_id"))
    tiebreak_candidates = {value for value in (phase1_id, cache_id) if value}
    cross_source_tiebreak = bool(
        str(existing["identity_source"] or "")
        == "cache_or_cross_source_identity_conflict"
    )
    if cross_source_tiebreak:
        if preferred_spotify_id:
            evidence["provider_spotify_id"] = preferred_spotify_id
        if not preferred_spotify_id:
            evidence["provider_identity_reason"] = (
                f"{provider_preference_reason}_cross_source_conflict"
            )
        elif not tiebreak_candidates or preferred_spotify_id not in tiebreak_candidates:
            evidence["provider_identity_reason"] = (
                f"{provider_preference_reason}_outside_cross_source_candidates"
            )
        else:
            evidence["provider_identity_reason"] = (
                f"{provider_preference_reason}_matches_cross_source_candidate"
            )
            connection.execute(
                """UPDATE fal_phase3_artists SET spotify_id=?,identity_status='complete',
                          identity_source='soundcharts_artist_identifiers_tiebreak',
                          identifiers_evidence_json=?,updated_at=?
                     WHERE candidate_uuid=? AND is_active=1""",
                (preferred_spotify_id, safe_json(evidence), now, task.entity_id),
            )
            return "complete_provider"
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                      identity_source='soundcharts_artist_identifiers_conflict',
                      identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=? AND is_active=1""",
            (safe_json(evidence), now, task.entity_id),
        )
        return "identity_conflict"
    if not preferred_spotify_id and len(provider_spotify_ids) > 1:
        evidence["provider_identity_reason"] = (
            f"{provider_preference_reason}_without_cross_source_tiebreak"
        )
        if existing_id:
            evidence["existing_spotify_id"] = existing_id
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                      identity_source='soundcharts_artist_identifiers_conflict',
                      identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=? AND is_active=1""",
            (safe_json(evidence), now, task.entity_id),
        )
        return "identity_conflict"
    if not preferred_spotify_id:
        return "identity_missing"
    evidence["provider_spotify_id"] = preferred_spotify_id
    if existing_id and existing_id != preferred_spotify_id:
        evidence["existing_spotify_id"] = existing_id
        evidence["provider_identity_reason"] = (
            f"{provider_preference_reason}_disagrees_with_existing_identity"
        )
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                      identity_source='soundcharts_artist_identifiers_conflict',
                      identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=? AND is_active=1""",
            (safe_json(evidence), now, task.entity_id),
        )
        return "identity_conflict"
    evidence["provider_identity_reason"] = f"{provider_preference_reason}_accepted"
    connection.execute(
        """UPDATE fal_phase3_artists SET spotify_id=?,identity_status='complete',
                  identity_source='soundcharts_artist_identifiers',identifiers_evidence_json=?,updated_at=?
             WHERE candidate_uuid=? AND is_active=1""",
        (preferred_spotify_id, safe_json(evidence), now, task.entity_id),
    )
    return "complete_provider"


def _store_song_response(connection: sqlite3.Connection, task: RequestTask, payload: Any) -> str:
    row = connection.execute(
        "SELECT manifest_record_json FROM fal_phase3_tracks WHERE track_uuid=?",
        (task.entity_id,),
    ).fetchone()
    if row is None:
        raise FalPhase3Error(f"Song response has no phase-3 row: {task.entity_id}")
    try:
        fallback = json.loads(str(row["manifest_record_json"] or "{}"))
    except json.JSONDecodeError:
        fallback = {}
    obj = payload.get("object") if isinstance(payload, Mapping) else None
    response_uuid = str(obj.get("uuid") or "").strip() if isinstance(obj, Mapping) else ""
    if not response_uuid or response_uuid != task.entity_id:
        raise FalPhase3Error("Soundcharts song response UUID is missing or does not match the request")
    parsed = parse_song_detail(payload, fallback if isinstance(fallback, Mapping) else {})
    if not isinstance(parsed, Mapping):
        return "invalid_response"
    normalized = strict_track_evidence(dict(parsed))
    _apply_track_evidence(
        connection,
        task.entity_id,
        normalized,
        detail_status="complete_provider",
        source_kind="soundcharts_song_v2_25",
    )
    return "complete_provider"


def store_outcomes(
    connection: sqlite3.Connection,
    outcomes: Sequence[RequestOutcome],
    *,
    run_id: str,
    retry_limit: int,
) -> str:
    halt_reason = ""
    now = utc_now()
    for outcome in outcomes:
        task = outcome.task
        request = connection.execute(
            "SELECT attempts FROM fal_phase3_requests WHERE request_kind=? AND entity_id=?",
            (task.kind, task.entity_id),
        ).fetchone()
        attempts = int(request[0] or 0) if request else 0
        error = outcome.error_code
        if not error:
            try:
                status = (
                    _store_artist_response(connection, task, outcome.payload)
                    if task.kind == "artist_identifiers"
                    else _store_song_response(connection, task, outcome.payload)
                )
            except FalPhase3Error:
                status, error = "invalid_response", "invalid_response"
            if status in {"identity_missing", "invalid_response"}:
                error = status
                status = "retry" if attempts < retry_limit else f"terminal_{status}"
        elif error == "unavailable":
            status = "unavailable"
        elif error in {"request_limit", "quota_reserve"}:
            status = "retry"
            halt_reason = error
        elif outcome.auth_failure:
            status = "retry"
            halt_reason = "authentication_rejected"
        else:
            status = "request_failed" if attempts >= retry_limit else "retry"

        connection.execute(
            """UPDATE fal_phase3_requests SET status=?,error_code=?,updated_at=?
                 WHERE request_kind=? AND entity_id=?""",
            (status, error or None, now, task.kind, task.entity_id),
        )
        connection.execute(
            """UPDATE fal_phase3_request_attempts SET finished_at=?,outcome=?
                 WHERE run_id=? AND request_kind=? AND entity_id=? AND attempt_number=?""",
            (now, status, run_id, task.kind, task.entity_id, attempts),
        )
    if halt_reason:
        connection.execute(
            """UPDATE fal_phase3_requests SET status='retry',error_code=?,updated_at=?
                 WHERE status='inflight' AND last_run_id=?""",
            (halt_reason, now, run_id),
        )
    connection.commit()
    return halt_reason


def run_network(
    connection: sqlite3.Connection,
    *,
    max_requests: int,
    quota_reserve: int,
    workers: int,
    retry_limit: int,
    run_id: str,
) -> tuple[Any | None, int | None, str]:
    if max_requests <= 0:
        return None, None, "dry_run"
    tasks = pending_tasks(connection, retry_limit=retry_limit, limit=max_requests)
    if not tasks:
        return None, None, "idle"
    client = SoundchartsClient(
        os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
        quota_reserve=quota_reserve,
        request_limit=max_requests,
    )
    client.authenticate()
    client.require_quota_reserve()
    quota_before = int(client.quota_remaining) if client.quota_remaining is not None else None
    safe_budget = client.available_request_budget(min(max_requests, len(tasks)))
    if safe_budget <= 0:
        return client, quota_before, "quota_reserve"
    tasks = tasks[:safe_budget]
    halt_reason = ""
    for offset in range(0, len(tasks), workers):
        batch = tasks[offset : offset + workers]
        claim_tasks(connection, batch, run_id=run_id)
        outcomes = fetch_tasks(client, batch, workers)
        halt_reason = store_outcomes(
            connection,
            outcomes,
            run_id=run_id,
            retry_limit=retry_limit,
        )
        if halt_reason:
            break
    return client, quota_before, halt_reason or "request_batch_complete"


def build_enriched_manifest(
    manifest: Mapping[str, Any],
    connection: sqlite3.Connection,
) -> dict[str, Any]:
    tracks_by_uuid = {
        str(row["track_uuid"]): row
        for row in connection.execute(
            "SELECT * FROM fal_phase3_tracks WHERE is_active=1"
        ).fetchall()
    }
    artists_by_uuid = {
        str(row["candidate_uuid"]): row
        for row in connection.execute(
            "SELECT * FROM fal_phase3_artists WHERE is_active=1"
        ).fetchall()
    }
    enriched_rows: list[dict[str, Any]] = []
    for raw in manifest.get("tracks") or []:
        if not isinstance(raw, Mapping):
            continue
        record = dict(raw)
        record["evidence_updated_at"] = ""
        record["source_contract"] = ""
        record["phase3_artist_identity_contract"] = ""
        record["phase3_artist_identity_observed_at"] = ""
        phase3_track = tracks_by_uuid.get(str(record.get("track_uuid") or ""))
        phase3_artist = artists_by_uuid.get(str(record.get("candidate_uuid") or ""))
        if phase3_track is not None:
            source_evidence = record.get("source_evidence")
            source_evidence = dict(source_evidence) if isinstance(source_evidence, Mapping) else {}
            try:
                provider = json.loads(str(phase3_track["provider_evidence_json"] or "{}"))
            except json.JSONDecodeError:
                provider = {}
            if isinstance(provider, Mapping):
                for key, value in provider.items():
                    if value is not None and value != "":
                        source_evidence[key] = value
            record["source_evidence"] = source_evidence
            provider_genres = source_evidence.get("genres")
            provider_genres = provider_genres if isinstance(provider_genres, list) else []
            record["forbidden_genres_detected"] = review_forbidden_genres_detected(
                [str(value) for value in provider_genres]
            )
            record["rights_status"] = str(phase3_track["rights_status"] or "unknown")
            record["rights_confidence"] = phase3_track["rights_confidence"]
            record["label"] = str(phase3_track["label"] or "")
            record["copyright"] = str(phase3_track["copyright"] or "")
            if str(phase3_track["no_lyrics_status"]) == "confirmed":
                record["no_lyrics"] = True
            if str(phase3_track["ai_risk"]) in {"low", "high"}:
                record["ai_risk"] = str(phase3_track["ai_risk"])
            if source_evidence.get("vocal") is True or source_evidence.get("instrumental") is False:
                record["instrumental_status"] = "vocal"
                record["phase3_decision"] = "blocked_explicit_vocal"
            record["phase3_detail_status"] = str(phase3_track["detail_status"])
            record["evidence_updated_at"] = str(
                phase3_track["evidence_updated_at"] or ""
            )
            record["source_contract"] = str(phase3_track["source_contract"] or "")
        if phase3_artist is not None:
            artist_id = exact_spotify_id(phase3_artist["spotify_id"])
            identity_status = str(phase3_artist["identity_status"] or "")
            identity_source = str(phase3_artist["identity_source"] or "")
            record["artist_spotify_id"] = artist_id
            record["artist_identity_status"] = (
                "complete" if artist_id and identity_status == "complete" else identity_status
            )
            record["phase3_artist_identity_source"] = identity_source
            if (
                artist_id
                and identity_status == "complete"
                and identity_source in CURRENT_PROVIDER_IDENTITY_SOURCES
            ):
                try:
                    identity_evidence = json.loads(
                        str(phase3_artist["identifiers_evidence_json"] or "{}")
                    )
                except json.JSONDecodeError:
                    identity_evidence = {}
                identity_evidence = (
                    identity_evidence if isinstance(identity_evidence, Mapping) else {}
                )
                identity_contract, identity_observed_at = provider_identity_provenance(
                    identity_evidence
                )
                if identity_contract and identity_observed_at:
                    record["phase3_artist_identity_contract"] = identity_contract
                    record["phase3_artist_identity_observed_at"] = identity_observed_at
        # Automated enrichment can never carry or manufacture a human approval.
        record["source_approved_for_publication"] = False
        record["review_decision"] = "pending"
        record["reviewer"] = ""
        record["reviewed_at"] = ""
        record["review_sources"] = []
        record["review_notes"] = ""
        record["blocking_fields"] = review_blocking_fields(record)
        record["review_bucket"], record["review_reason"] = classify_review_bucket(record)
        if str(record.get("rights_status") or "").casefold() in {"major", "mixed"}:
            record["review_bucket"] = "blocked"
            record["review_reason"] = "explicit_blocking_rights_evidence"
        enriched_rows.append(record)
    output = dict(manifest)
    output["generated_at"] = utc_now()
    output["status"] = "phase3_private_evidence_enriched_human_review_required"
    output["staging_only"] = True
    output["canonical_written"] = False
    output["dashboard_written"] = False
    output["promotion_executed"] = False
    output["source"] = dict(output.get("source") or {})
    output["source"]["phase3_state_version"] = PHASE3_VERSION
    output["guardrails"] = dict(output.get("guardrails") or {})
    output["guardrails"].update(
        {
            "source_approval_remains_manual": True,
            "human_review_remains_manual": True,
            "ai_risk_never_inferred": True,
            "no_lyrics_never_inferred_from_instrumentalness": True,
            "audience_size_and_career_stage_never_block": True,
            "canonical_promotion_implemented": False,
        }
    )
    output["tracks"] = enriched_rows
    output["track_schema"] = list(enriched_rows[0]) if enriched_rows else []
    by_bucket = Counter(str(row.get("review_bucket") or "unknown") for row in enriched_rows)
    output["summary"] = dict(output.get("summary") or {})
    output["summary"]["tracks"] = len(enriched_rows)
    output["summary"]["by_bucket"] = dict(sorted(by_bucket.items()))
    recalculate_enriched_manifest_digests(output)
    validate_enriched_manifest_digests(output)
    return output


def request_status_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        f"{row[0]}:{row[1]}": int(row[2])
        for row in connection.execute(
            """SELECT request_kind,status,COUNT(*) FROM fal_phase3_requests
                 WHERE is_active=1
                 GROUP BY request_kind,status ORDER BY request_kind,status"""
        ).fetchall()
    }


def provider_identity_resolution_counts(
    connection: sqlite3.Connection,
) -> dict[str, int]:
    """Return only allowlisted aggregate reasons; never expose provider IDs."""

    counts: Counter[str] = Counter()
    rows = connection.execute(
        """SELECT identifiers_evidence_json FROM fal_phase3_artists
             WHERE is_active=1"""
    ).fetchall()
    for row in rows:
        try:
            evidence = json.loads(str(row["identifiers_evidence_json"] or "{}"))
        except json.JSONDecodeError:
            evidence = {}
        reason = (
            str(evidence.get("provider_identity_reason") or "")
            if isinstance(evidence, Mapping)
            else ""
        )
        if not reason:
            continue
        counts[
            reason
            if reason in PROVIDER_IDENTITY_RESOLUTION_REASON_ALLOWLIST
            else "unclassified_provider_identity_resolution"
        ] += 1
    return dict(sorted(counts.items()))


def build_report(
    connection: sqlite3.Connection,
    *,
    state_path: Path,
    state_sha256_before: str,
    run_id: str,
    phase2_source_artifact_id: str,
    phase1_source_artifact_id: str,
    phase2_state_sha256: str,
    phase2_report_sha256: str,
    phase1_state_sha256: str,
    manifest_sha256: str,
    enriched_manifest_sha256: str,
    enriched_manifest_records_digest: str,
    enriched_manifest_row_count: int,
    max_requests: int,
    quota_reserve: int,
    quota_before: int | None,
    client: Any | None,
    halt_reason: str,
    tracks_seeded: int,
    artists_seeded: int,
    phase1_identities: int,
    cache_tracks: int,
    cache_artists: int,
    cache_source_artifact_id: str,
    cache_sha256: str,
) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{64}", str(enriched_manifest_sha256 or "")):
        raise FalPhase3Error("Enriched manifest requires an exact SHA-256 binding")
    if not re.fullmatch(
        r"[0-9a-f]{64}", str(enriched_manifest_records_digest or "")
    ):
        raise FalPhase3Error("Enriched manifest requires an exact records digest")
    if int(enriched_manifest_row_count) < 0:
        raise FalPhase3Error("Enriched manifest row count cannot be negative")
    track_total = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_tracks WHERE is_active=1").fetchone()[0]
    )
    artist_total = int(
        connection.execute("SELECT COUNT(*) FROM fal_phase3_artists WHERE is_active=1").fetchone()[0]
    )
    active = int(connection.execute(
        """SELECT COUNT(*) FROM fal_phase3_requests
             WHERE is_active=1 AND status IN ('pending','retry','inflight')"""
    ).fetchone()[0])
    terminal_failures = int(connection.execute(
        """SELECT COUNT(*) FROM fal_phase3_requests
             WHERE is_active=1 AND status NOT IN (
               'pending','retry','inflight','complete_cache','complete_phase1','complete_provider'
             )"""
    ).fetchone()[0])
    artist_state_rows = connection.execute(
        """SELECT spotify_id,identity_status,identity_source,identifiers_evidence_json
             FROM fal_phase3_artists
             WHERE is_active=1"""
    ).fetchall()
    complete_artist_ids: list[str] = []
    for row in artist_state_rows:
        spotify_id = exact_spotify_id(row["spotify_id"])
        if str(row["identity_status"] or "") != "complete" or not spotify_id:
            continue
        if str(row["identity_source"] or "") in CURRENT_PROVIDER_IDENTITY_SOURCES:
            try:
                identity_evidence = json.loads(
                    str(row["identifiers_evidence_json"] or "{}")
                )
            except json.JSONDecodeError:
                identity_evidence = {}
            if not provider_identity_provenance(
                identity_evidence if isinstance(identity_evidence, Mapping) else {}
            )[0]:
                continue
        complete_artist_ids.append(spotify_id)
    identity_complete = len(complete_artist_ids)
    unique_spotify_artists = len(set(complete_artist_ids))
    artist_state_unresolved = artist_total - identity_complete
    track_state_rows = connection.execute(
        """SELECT detail_status,evidence_updated_at,source_contract
             FROM fal_phase3_tracks WHERE is_active=1"""
    ).fetchall()
    track_state_technical_complete = sum(
        1
        for row in track_state_rows
        if str(row["detail_status"] or "") in {"complete_cache", "complete_provider"}
        and aware_iso_timestamp(row["evidence_updated_at"])
        and str(row["source_contract"] or "") == SOUNDCHARTS_SONG_EVIDENCE_CONTRACT
    )
    track_state_unresolved = track_total - track_state_technical_complete
    state_unresolved = artist_state_unresolved + track_state_unresolved
    state_complete = state_unresolved == 0
    technical_complete = active == 0 and terminal_failures == 0 and state_complete
    no_lyrics = int(connection.execute(
        """SELECT COUNT(*) FROM fal_phase3_tracks
             WHERE is_active=1 AND no_lyrics_status='confirmed'"""
    ).fetchone()[0])
    ai_counts = {str(row[0]): int(row[1]) for row in connection.execute(
        """SELECT ai_risk,COUNT(*) FROM fal_phase3_tracks WHERE is_active=1
             GROUP BY ai_risk ORDER BY ai_risk"""
    ).fetchall()}
    rights_counts = {str(row[0]): int(row[1]) for row in connection.execute(
        """SELECT rights_status,COUNT(*) FROM fal_phase3_tracks WHERE is_active=1
             GROUP BY rights_status ORDER BY rights_status"""
    ).fetchall()}
    claimed = int(getattr(client, "requests_claimed", 0) or 0) if client else 0
    quota_after = getattr(client, "quota_remaining", None) if client else None
    status = (
        "dry_run_private_state_ready"
        if halt_reason == "dry_run"
        else "quota_protected"
        if halt_reason == "quota_reserve"
        else "authentication_blocked"
        if halt_reason == "authentication_rejected"
        else "private_review_enrichment_complete"
        if technical_complete
        else "private_review_enrichment_exhausted_with_unresolved_evidence"
        if active == 0
        else "partial_private_evidence_retry_required"
    )
    return {
        "version": PHASE3_VERSION,
        "generated_at": utc_now(),
        "run_id": run_id,
        "status": status,
        "complete": technical_complete,
        "technical_complete": technical_complete,
        "request_queue_exhausted": active == 0,
        "evidence_complete": False,
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "promotion_executed": False,
        "row_level_data_uploaded_unencrypted": False,
        "minimum_lifetime_streams": DEFAULT_MINIMUM_STREAMS,
        "source": {
            "kind": "soundcharts_fal_phase2_private_review_manifest",
            "phase2_source_artifact_id": str(phase2_source_artifact_id or ""),
            "phase1_source_artifact_id": str(phase1_source_artifact_id or ""),
            "phase2_state_sha256": str(phase2_state_sha256 or ""),
            "phase2_report_sha256": str(phase2_report_sha256 or ""),
            "phase1_state_sha256": str(phase1_state_sha256 or ""),
            "cache_source_artifact_id": str(cache_source_artifact_id or ""),
            "cache_sha256": str(cache_sha256 or ""),
            "review_manifest_sha256": manifest_sha256,
            "enriched_manifest_sha256": str(enriched_manifest_sha256),
            "enriched_manifest_records_digest": str(
                enriched_manifest_records_digest
            ),
            "enriched_manifest_row_count": int(enriched_manifest_row_count),
            "state_sha256_before": state_sha256_before,
            "state_sha256_after": file_sha256(state_path),
        },
        "policy": {
            "priority_bucket": ADVANCED_BUCKET,
            "phase1_artist_identity_join_before_network": True,
            "bootstrap_cache_before_network": True,
            "cache_track_terminal_contract": SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
            "cache_track_terminal_requires_timestamp": True,
            "cache_artist_terminal_requires_exact_id_and_identifiers_fetched_at": True,
            "cache_artifact_id_and_sha256_required": True,
            "cross_source_identity_requires_live_provider_tiebreak": True,
            "artist_identifier_endpoint_residual_only": True,
            "artist_identifier_query_spotify_only_default": True,
            "provider_verified_never_tiebreaks": True,
            "provider_tiebreak_requires_unique_default_or_single_filtered_identity": True,
            "provider_tiebreak_must_match_phase1_or_cache": True,
            "song_detail_endpoint": "/api/v2.25/song/{uuid}",
            "no_lyrics_requires_explicit_source_field": True,
            "ai_risk_never_inferred": True,
            "audience_size_and_career_stage_never_block": True,
            "source_approval_remains_manual": True,
            "human_review_remains_manual": True,
            "automatic_promotion": False,
            "maximum_requests": ABSOLUTE_MAX_REQUESTS,
            "minimum_quota_reserve": MIN_QUOTA_RESERVE,
        },
        "requests": {
            "requested_maximum": max_requests,
            "claimed": claimed,
            "quota_observed_before": quota_before,
            "quota_observed_after": int(quota_after) if quota_after is not None else None,
            "protected_floor": quota_reserve,
            "halt_reason": halt_reason,
            "active_remaining": active,
            "terminal_unresolved": terminal_failures,
            "state_unresolved": state_unresolved,
            "status_counts": request_status_counts(connection),
        },
        "changes": {
            "tracks_seeded": tracks_seeded,
            "artists_seeded": artists_seeded,
            "artist_identities_joined_from_phase1": phase1_identities,
            "track_details_reused_from_cache": cache_tracks,
            "artist_identities_reused_from_cache": cache_artists,
        },
        "coverage": {
            "priority_tracks": track_total,
            "priority_artists": artist_total,
            "artist_identity_complete": identity_complete,
            "artist_identity_rows_complete": identity_complete,
            "artist_state_unresolved": artist_state_unresolved,
            "unique_spotify_artists_complete": unique_spotify_artists,
            "track_evidence_complete": track_state_technical_complete,
            "track_state_technical_complete": track_state_technical_complete,
            "track_state_unresolved": track_state_unresolved,
            "provider_identity_resolution_counts": provider_identity_resolution_counts(
                connection
            ),
            "no_lyrics_explicit": no_lyrics,
            "ai_risk_counts": ai_counts,
            "rights_status_counts": rights_counts,
            "source_approval_pending": track_total,
            "human_review_pending": track_total,
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-manifest", type=Path, required=True)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--phase1-state", type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--enriched-manifest-out", type=Path, default=DEFAULT_ENRICHED_MANIFEST)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--phase2-source-artifact-id", default="")
    parser.add_argument("--phase1-source-artifact-id", default="")
    parser.add_argument("--phase2-state-sha256", default="")
    parser.add_argument("--phase2-report-sha256", default="")
    parser.add_argument("--phase1-state-sha256", default="")
    parser.add_argument("--cache-source-artifact-id", default="")
    parser.add_argument("--cache-sha256", default="")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--quota-reserve", type=int, default=MIN_QUOTA_RESERVE)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--retry-limit", type=int, default=DEFAULT_RETRY_LIMIT)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not 0 <= int(args.max_requests) <= ABSOLUTE_MAX_REQUESTS:
        raise FalPhase3Error(f"max_requests must be between 0 and {ABSOLUTE_MAX_REQUESTS}")
    if int(args.quota_reserve) < MIN_QUOTA_RESERVE:
        raise FalPhase3Error(f"quota_reserve must protect at least {MIN_QUOTA_RESERVE} calls")
    if not 1 <= int(args.workers) <= MAX_WORKERS:
        raise FalPhase3Error(f"workers must be between 1 and {MAX_WORKERS}")
    if not 1 <= int(args.retry_limit) <= 3:
        raise FalPhase3Error("retry_limit must be between 1 and 3")

    manifest = load_json_object(args.review_manifest, "FAL review manifest")
    advanced = validate_manifest(manifest)
    lineage_values = (
        str(args.phase2_source_artifact_id or ""),
        str(args.phase1_source_artifact_id or ""),
        str(args.phase2_state_sha256 or ""),
        str(args.phase2_report_sha256 or ""),
        str(args.phase1_state_sha256 or ""),
    )
    if any(lineage_values):
        if not all(lineage_values[:2]) or not all(
            re.fullmatch(r"[0-9a-f]{64}", value) for value in lineage_values[2:]
        ):
            raise FalPhase3Error("Source artifact lineage must be complete and SHA-256 bound")
        manifest_phase1 = str(
            (((manifest.get("source") or {}).get("phase2_source_checkpoint") or {}).get("phase1_source_id"))
            or ""
        )
        if manifest_phase1 != lineage_values[1]:
            raise FalPhase3Error("Review manifest Phase-1 lineage does not match the restored source")
    state_path = args.state.resolve()
    state_sha256_before = file_sha256(state_path)
    connection, _ = open_state(state_path)
    run_id = str(args.run_id or os.environ.get("GITHUB_RUN_ID") or uuid_module.uuid4().hex)
    client: Any | None = None
    quota_before: int | None = None
    halt_reason = ""
    try:
        tracks_seeded, artists_seeded = seed_advanced_bucket(connection, advanced)
        phase1_identities = hydrate_artist_identities_from_phase1(
            connection,
            args.phase1_state,
            retry_limit=int(args.retry_limit),
        )
        cache_tracks, cache_artists = hydrate_from_cache(
            connection,
            args.cache,
            cache_source_artifact_id=str(args.cache_source_artifact_id or ""),
            cache_sha256=str(args.cache_sha256 or ""),
        )
        client, quota_before, halt_reason = run_network(
            connection,
            max_requests=int(args.max_requests),
            quota_reserve=int(args.quota_reserve),
            workers=int(args.workers),
            retry_limit=int(args.retry_limit),
            run_id=run_id,
        )
        enriched = build_enriched_manifest(manifest, connection)
        enriched_binding = recalculate_enriched_manifest_digests(enriched)
        if validate_enriched_manifest_digests(enriched) != enriched_binding:
            raise FalPhase3Error("Enriched manifest binding changed before write")
        args.enriched_manifest_out.parent.mkdir(parents=True, exist_ok=True)
        args.enriched_manifest_out.write_text(
            json.dumps(enriched, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        written_enriched = load_json_object(
            args.enriched_manifest_out, "Written FAL phase-3 enriched manifest"
        )
        if validate_enriched_manifest_digests(written_enriched) != enriched_binding:
            raise FalPhase3Error("Written enriched manifest binding is inconsistent")
        enriched_manifest_sha256 = file_sha256(args.enriched_manifest_out)
        connection.execute(
            "INSERT INTO meta(key,value) VALUES('fal_phase3_last_run_id',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (run_id,),
        )
        connection.execute(
            "INSERT INTO meta(key,value) VALUES('fal_phase3_last_run_at',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (utc_now(),),
        )
        connection.commit()
        report = build_report(
            connection,
            state_path=state_path,
            state_sha256_before=state_sha256_before,
            run_id=run_id,
            phase2_source_artifact_id=str(args.phase2_source_artifact_id or ""),
            phase1_source_artifact_id=str(args.phase1_source_artifact_id or ""),
            phase2_state_sha256=str(args.phase2_state_sha256 or ""),
            phase2_report_sha256=str(args.phase2_report_sha256 or ""),
            phase1_state_sha256=str(args.phase1_state_sha256 or ""),
            manifest_sha256=file_sha256(args.review_manifest),
            enriched_manifest_sha256=enriched_manifest_sha256,
            enriched_manifest_records_digest=str(enriched_binding["records_digest"]),
            enriched_manifest_row_count=int(enriched_binding["row_count"]),
            max_requests=int(args.max_requests),
            quota_reserve=int(args.quota_reserve),
            quota_before=quota_before,
            client=client,
            halt_reason=halt_reason,
            tracks_seeded=tracks_seeded,
            artists_seeded=artists_seeded,
            phase1_identities=phase1_identities,
            cache_tracks=cache_tracks,
            cache_artists=cache_artists,
            cache_source_artifact_id=str(args.cache_source_artifact_id or ""),
            cache_sha256=str(args.cache_sha256 or ""),
        )
    finally:
        connection.close()

    # Hash only after SQLite has closed so the report binds to the exact file
    # that the workflow encrypts and uploads.
    report["source"]["state_sha256_after"] = file_sha256(state_path)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
