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
ACTIVE_REQUEST_STATUSES = {"pending", "retry", "inflight"}
TERMINAL_REQUEST_STATUSES = {
    "complete_cache",
    "complete_phase1",
    "complete_provider",
    "identity_conflict",
    "unavailable",
    "request_failed",
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
            return f"/api/v2/artist/{quoted}/identifiers?offset=0&limit=100"
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
    counts = Counter(identities.values())
    now = utc_now()
    changed = 0
    for candidate_uuid, spotify_id in identities.items():
        existing = connection.execute(
            """SELECT spotify_id,identity_status FROM fal_phase3_artists
                 WHERE candidate_uuid=? AND is_active=1""",
            (candidate_uuid,),
        ).fetchone()
        if existing is None:
            continue
        existing_id = exact_spotify_id(existing["spotify_id"])
        conflict = counts[spotify_id] > 1 or (existing_id and existing_id != spotify_id)
        status = "identity_conflict" if conflict else "complete"
        selected = "" if conflict else spotify_id
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id=?,identity_status=?,identity_source=?,updated_at=?
                 WHERE candidate_uuid=?""",
            (selected, status, "phase1_candidates_exact_spotify_id", now, candidate_uuid),
        )
        connection.execute(
            """UPDATE fal_phase3_requests SET status=?,error_code=?,updated_at=?
                 WHERE request_kind='artist_identifiers' AND entity_id=?""",
            (
                "identity_conflict" if conflict else "complete_phase1",
                "duplicate_or_conflicting_phase1_artist_identity" if conflict else None,
                now,
                candidate_uuid,
            ),
        )
        changed += int(not conflict and (existing_id != spotify_id or existing["identity_status"] != "complete"))
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
    normalized_evidence = {
        "source": source,
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
        dt.datetime.fromisoformat(raw_stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


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
                  no_lyrics_status,ai_risk,provider_evidence_json,source_kind
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
    connection.execute(
        """UPDATE fal_phase3_tracks SET detail_status=?,rights_status=?,rights_confidence=?,
                  rights_basis=?,label=?,copyright=?,no_lyrics_status=?,ai_risk=?,
                  provider_evidence_json=?,source_kind=?,updated_at=? WHERE track_uuid=?""",
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
            now,
            track_uuid,
        ),
    )


def hydrate_from_cache(connection: sqlite3.Connection, cache_path: Path | None) -> tuple[int, int]:
    if cache_path is None or not cache_path.is_file():
        return 0, 0
    cache = load_json_object(cache_path, "Soundcharts instrumental cache")
    cached_tracks = cache.get("tracks") if isinstance(cache.get("tracks"), Mapping) else {}
    cached_artists = cache.get("artists") if isinstance(cache.get("artists"), Mapping) else {}
    track_changes = 0
    artist_changes = 0
    now = utc_now()
    for row in connection.execute(
        """SELECT track_uuid,detail_status FROM fal_phase3_tracks
             WHERE is_active=1"""
    ).fetchall():
        if str(row["detail_status"]) in {"complete_provider", "complete_cache"}:
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
        """SELECT candidate_uuid,spotify_id,identity_status FROM fal_phase3_artists
             WHERE is_active=1"""
    ).fetchall()
    cache_ids: dict[str, str] = {}
    proposed_ids: dict[str, str] = {}
    for row in artist_rows:
        candidate_uuid = str(row["candidate_uuid"])
        if str(row["identity_status"]) == "identity_conflict":
            continue
        current = exact_spotify_id(row["spotify_id"])
        if current:
            proposed_ids[candidate_uuid] = current
        entry = cached_artists.get(candidate_uuid)
        if isinstance(entry, Mapping):
            spotify_id = exact_spotify_id(entry.get("spotify_id"))
            if spotify_id:
                cache_ids[candidate_uuid] = spotify_id
                proposed_ids.setdefault(candidate_uuid, spotify_id)
    proposed_counts = Counter(proposed_ids.values())
    for row in artist_rows:
        candidate_uuid = str(row["candidate_uuid"])
        spotify_id = cache_ids.get(candidate_uuid, "")
        current = exact_spotify_id(row["spotify_id"])
        proposed = proposed_ids.get(candidate_uuid, "")
        conflict = bool(
            (spotify_id and current and current != spotify_id)
            or (proposed and proposed_counts.get(proposed, 0) > 1)
        )
        if conflict:
            connection.execute(
                """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                          identity_source='cache_or_cross_source_identity_conflict',updated_at=?
                     WHERE candidate_uuid=?""",
                (now, candidate_uuid),
            )
            connection.execute(
                """UPDATE fal_phase3_requests SET status='identity_conflict',
                          error_code='duplicate_or_conflicting_cache_artist_identity',updated_at=?
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


def _spotify_ids_in_identifier_response(payload: Any) -> list[str]:
    items = payload.get("items") if isinstance(payload, Mapping) else []
    return sorted(
        {
            exact_spotify_id(item.get("identifier"))
            for item in items
            if isinstance(item, Mapping)
            and str(item.get("platformCode") or "").casefold() == "spotify"
            and exact_spotify_id(item.get("identifier"))
        }
    )


def _store_artist_response(connection: sqlite3.Connection, task: RequestTask, payload: Any) -> str:
    parsed = parse_artist_identifiers(payload)
    provider_spotify_ids = _spotify_ids_in_identifier_response(payload)
    spotify_id = provider_spotify_ids[0] if len(provider_spotify_ids) == 1 else ""
    now = utc_now()
    if len(provider_spotify_ids) > 1:
        evidence = dict(parsed) if isinstance(parsed, Mapping) else {}
        evidence["spotify_ids"] = provider_spotify_ids
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                      identity_source='soundcharts_artist_identifiers_conflict',
                      identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=? AND is_active=1""",
            (safe_json(evidence), now, task.entity_id),
        )
        return "identity_conflict"
    if not spotify_id:
        return "identity_missing"
    duplicates = connection.execute(
        """SELECT candidate_uuid FROM fal_phase3_artists
             WHERE spotify_id=? AND candidate_uuid<>? AND identity_status='complete'
               AND is_active=1""",
        (spotify_id, task.entity_id),
    ).fetchall()
    if duplicates:
        conflicting = [str(row["candidate_uuid"]) for row in duplicates]
        for candidate_uuid in conflicting:
            connection.execute(
                """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                          identity_source='soundcharts_artist_identifiers_collision',updated_at=?
                     WHERE candidate_uuid=?""",
                (now, candidate_uuid),
            )
            connection.execute(
                """UPDATE fal_phase3_requests SET status='identity_conflict',
                          error_code='duplicate_provider_artist_spotify_id',updated_at=?
                     WHERE request_kind='artist_identifiers' AND entity_id=?""",
                (now, candidate_uuid),
            )
        connection.execute(
            """UPDATE fal_phase3_artists SET spotify_id='',identity_status='identity_conflict',
                      identity_source='soundcharts_artist_identifiers',identifiers_evidence_json=?,updated_at=?
                 WHERE candidate_uuid=? AND is_active=1""",
            (safe_json(parsed), now, task.entity_id),
        )
        return "identity_conflict"
    connection.execute(
        """UPDATE fal_phase3_artists SET spotify_id=?,identity_status='complete',
                  identity_source='soundcharts_artist_identifiers',identifiers_evidence_json=?,updated_at=?
             WHERE candidate_uuid=? AND is_active=1""",
        (spotify_id, safe_json(parsed), now, task.entity_id),
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
        if phase3_artist is not None:
            artist_id = exact_spotify_id(phase3_artist["spotify_id"])
            record["artist_spotify_id"] = artist_id
            record["artist_identity_status"] = (
                "complete" if artist_id and phase3_artist["identity_status"] == "complete" else str(phase3_artist["identity_status"])
            )
            record["phase3_artist_identity_source"] = str(phase3_artist["identity_source"] or "")
        # These two approvals are intentionally preserved exactly as supplied.
        record["source_approved_for_publication"] = raw.get("source_approved_for_publication") is True
        record["review_decision"] = str(raw.get("review_decision") or "pending")
        record["blocking_fields"] = review_blocking_fields(record)
        record["review_bucket"], record["review_reason"] = classify_review_bucket(record)
        if str(record.get("rights_status") or "").casefold() in {"major", "mixed"}:
            record["review_bucket"] = "blocked"
            record["review_reason"] = "explicit_blocking_rights_evidence"
        record["record_digest"] = stable_digest(
            {
                key: value
                for key, value in record.items()
                if key not in {"review_decision", "reviewer", "reviewed_at", "review_sources", "review_notes", "record_digest"}
            }
        )
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
    output["records_digest"] = stable_digest([row["record_digest"] for row in enriched_rows])
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
) -> dict[str, Any]:
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
    identity_complete = int(connection.execute(
        """SELECT COUNT(*) FROM fal_phase3_artists
             WHERE is_active=1 AND identity_status='complete' AND length(spotify_id)=22"""
    ).fetchone()[0])
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
        if active == 0 and terminal_failures == 0
        else "private_review_enrichment_exhausted_with_unresolved_evidence"
        if active == 0
        else "partial_private_evidence_retry_required"
    )
    return {
        "version": PHASE3_VERSION,
        "generated_at": utc_now(),
        "run_id": run_id,
        "status": status,
        "complete": active == 0 and terminal_failures == 0,
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
            "review_manifest_sha256": manifest_sha256,
            "state_sha256_before": state_sha256_before,
            "state_sha256_after": file_sha256(state_path),
        },
        "policy": {
            "priority_bucket": ADVANCED_BUCKET,
            "phase1_artist_identity_join_before_network": True,
            "bootstrap_cache_before_network": True,
            "artist_identifier_endpoint_residual_only": True,
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
        phase1_identities = hydrate_artist_identities_from_phase1(connection, args.phase1_state)
        cache_tracks, cache_artists = hydrate_from_cache(connection, args.cache)
        client, quota_before, halt_reason = run_network(
            connection,
            max_requests=int(args.max_requests),
            quota_reserve=int(args.quota_reserve),
            workers=int(args.workers),
            retry_limit=int(args.retry_limit),
            run_id=run_id,
        )
        enriched = build_enriched_manifest(manifest, connection)
        args.enriched_manifest_out.parent.mkdir(parents=True, exist_ok=True)
        args.enriched_manifest_out.write_text(
            json.dumps(enriched, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
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
