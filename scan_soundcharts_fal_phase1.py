#!/usr/bin/env python3
"""Stage a resumable Soundcharts Fans Also Like + discography phase-one scan.

This collector is deliberately isolated from every public/canonical Spotify
Radar artifact. It freezes a deterministic, audited seed cohort, stores the
complete related-artist graph in SQLite, then qualifies only *new* artists
before walking their associated discographies, including featured tracks.

Unknown instrumental or AI status is review work, never approval.  Only
explicit vocal, out-of-taxonomy or high-AI evidence is blocked automatically.
The only outputs are the private staging database and an aggregate JSON report.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
import unicodedata
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from refresh_soundcharts_daily import (
    SOUNDCHARTS_PREFIX,
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
    extract_artist_spotify_metric,
    read_js_payload,
)
from prepare_soundcharts_snapshot import NORMALISED_PUBLIC_ARTIST_BLACKLIST
from spotify_performance_store import PerformanceStoreError, read_performance_payload


STATE_VERSION = 2
REPORT_VERSION = 2
HARD_MIN_QUOTA_RESERVE = 500_000
# Current maintenance is roughly 46.6k calls/day at the protected track cap.
# Keep retry/variance headroom without immobilising the separate FAL budget.
DEFAULT_MAINTENANCE_DAILY_REQUESTS = 60_000
QUOTA_RESET_DAY = 18
QUOTA_RESET_HOUR_UTC = 19
QUOTA_RESET_MINUTE_UTC = 11
DEFAULT_STATE = Path("soundcharts-fal-phase1-staging.sqlite3")
DEFAULT_REPORT = Path("soundcharts-fal-phase1-report.json")
DEFAULT_SEED_SNAPSHOT = Path("Spotify_Soundcharts_data_20260721T181420Z.js")
DEFAULT_BROWSE_SNAPSHOT = Path("Spotify_Browse_Catalogue_data.js")
DEFAULT_PERFORMANCE_SNAPSHOT = Path("Spotify_Performance_data.js")
DEFAULT_LEGACY_SNAPSHOT = Path("Spotify_Soundcharts_data.js")
DEFAULT_RADAR_SNAPSHOT = Path("Spotify_Radar_data.js")
DEFAULT_MAX_SEEDS = 6_000
DEFAULT_MIN_SEED_GUARD = 4_000
DEFAULT_MAX_SEED_GUARD = 4_500
DEFAULT_SEED_MIN_AUDIENCE = 50_000
DEFAULT_CANDIDATE_MIN_AUDIENCE = 50_000
DEFAULT_RECENT_DAYS = 1_095

TARGET_GENRE_MARKERS = (
    "lofi", "lo-fi", "chillhop", "jazzhop", "ambient", "soundscape", "nature",
    "piano", "classical", "neo-classical", "neoclassical", "acoustic", "guitar",
    "fingerstyle", "jazz", "bossa", "instrumental phonk", "phonk instrumental",
    "instrumental dnb", "dnb instrumental", "instrumental drum and bass",
    "drum and bass instrumental", "synthwave", "retrowave", "chill house",
    "lofi house", "lo-fi house", "dark ambient", "meditation music",
)
FORBIDDEN_GENRES = frozenset(
    {
        "pop", "pop rock", "rock", "hard rock", "metal", "heavy metal", "punk",
        "country", "reggaeton", "latin pop", "r&b", "rnb", "soul", "gospel",
        "vocal jazz", "rap", "hip hop rap", "trap rap", "singer songwriter",
    }
)
VOCAL_RE = re.compile(
    r"(?:^|\b)(?:vocal(?:s|ist)?|with lyrics?|singer(?: songwriter)?|rapper|rap vocals?)(?:\b|$)",
    re.IGNORECASE,
)
AI_HIGH_RE = re.compile(r"(?:^|\b)(?:high|elevated|eleve|elevé)(?:\b|$)", re.IGNORECASE)
SPOTIFY_ID_RE = re.compile(r"^[A-Za-z0-9]{15,32}$")
ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$", re.IGNORECASE)

TERMINAL_CANDIDATE_STATUSES = frozenset(
    {
        "duplicate_existing", "blocked_blacklist", "blocked_audience_low",
        "review_audience_unknown", "review_audience_unavailable", "blocked_inactive",
        "review_identity_unknown", "review_activity_unknown", "blocked_explicit_vocal", "blocked_out_of_scope",
        "blocked_ai_high", "review_complete", "review_inventory_complete", "eligible_complete", "failed",
    }
)


class FalPhase1Error(RuntimeError):
    """Safe collector error which contains no credentials."""


@dataclass(frozen=True)
class SeedArtist:
    soundcharts_uuid: str
    spotify_id: str
    name: str
    monthly_listeners: int
    qualifies: bool


@dataclass
class KnownIdentities:
    artist_uuids: set[str]
    artist_spotify_ids: set[str]
    track_uuids: set[str]
    track_spotify_ids: set[str]
    track_isrcs: set[str]


@dataclass(frozen=True)
class QuotaBudgetPlan:
    requested: int
    allowed: int
    quota_remaining: int
    hard_reserve: int
    maintenance_daily_requests: int
    maintenance_days: int
    maintenance_reserve: int
    protected_floor: int
    maintenance_through: str


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(text.split())


def finite_int(value: Any) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if math.isfinite(number) else None


def parse_iso_date(value: str | dt.date) -> dt.date:
    if isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise FalPhase1Error(f"Invalid ISO date: {value!r}") from exc


def parse_as_of(value: str | dt.date | dt.datetime | None) -> dt.datetime:
    if value is None:
        return dt.datetime.now(dt.timezone.utc)
    if isinstance(value, dt.datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=dt.timezone.utc)
    if isinstance(value, dt.date):
        return dt.datetime.combine(value, dt.time.min, tzinfo=dt.timezone.utc)
    raw = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        parsed = dt.datetime.combine(parse_iso_date(raw), dt.time.min, tzinfo=dt.timezone.utc)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=dt.timezone.utc)


def next_quota_reset(as_of: str | dt.date | dt.datetime | None = None) -> dt.datetime:
    """Return the next monthly Soundcharts reset anchor, never a past date."""

    now = parse_as_of(as_of).astimezone(dt.timezone.utc)
    candidate = dt.datetime(
        now.year,
        now.month,
        QUOTA_RESET_DAY,
        QUOTA_RESET_HOUR_UTC,
        QUOTA_RESET_MINUTE_UTC,
        tzinfo=dt.timezone.utc,
    )
    if now < candidate:
        return candidate
    if now.month == 12:
        year, month = now.year + 1, 1
    else:
        year, month = now.year, now.month + 1
    return dt.datetime(
        year,
        month,
        QUOTA_RESET_DAY,
        QUOTA_RESET_HOUR_UTC,
        QUOTA_RESET_MINUTE_UTC,
        tzinfo=dt.timezone.utc,
    )


def plan_quota_budget(
    *,
    quota_remaining: int | None,
    requested: int,
    maintenance_daily_requests: int,
    maintenance_through: str | dt.date | None,
    as_of: str | dt.date | dt.datetime | None = None,
    hard_reserve: int = HARD_MIN_QUOTA_RESERVE,
) -> QuotaBudgetPlan:
    """Return the only request budget FAL may safely consume.

    The maintenance allowance is inclusive of ``as_of`` and the reset/cutoff
    day.  A stale cutoff automatically rolls to the next monthly anchor, so
    maintenance protection never falls to zero after a reset; the hard 500k
    reserve also remains protected forever.  A missing server quota fails
    closed instead of guessing.
    """

    if quota_remaining is None:
        raise FalPhase1Error("Soundcharts did not expose quota remaining for FAL preflight")
    now = parse_as_of(as_of).astimezone(dt.timezone.utc)
    today = now.date()
    automatic_reset = next_quota_reset(now).date()
    through = parse_iso_date(maintenance_through) if maintenance_through else automatic_reset
    # A stale manual override must never collapse maintenance protection after
    # the reset.  Roll forward to the next monthly anchor automatically.
    if through < today or (through == today and through < automatic_reset):
        through = automatic_reset
    days = max(0, (through - today).days + 1)
    daily = max(0, int(maintenance_daily_requests))
    hard = max(HARD_MIN_QUOTA_RESERVE, int(hard_reserve))
    maintenance = days * daily
    protected_floor = hard + maintenance
    available = max(0, int(quota_remaining) - protected_floor)
    requested_safe = max(0, min(40_000, int(requested)))
    return QuotaBudgetPlan(
        requested=requested_safe,
        allowed=min(requested_safe, available),
        quota_remaining=int(quota_remaining),
        hard_reserve=hard,
        maintenance_daily_requests=daily,
        maintenance_days=days,
        maintenance_reserve=maintenance,
        protected_floor=protected_floor,
        maintenance_through=through.isoformat(),
    )


def row_record(row: Any, schema: Sequence[str]) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    if not isinstance(row, (list, tuple)):
        return {}
    return {name: row[index] if index < len(row) else None for index, name in enumerate(schema)}


def read_generic_js(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    marker = text.find("=")
    if marker < 0:
        raise FalPhase1Error(f"{path} is not a JavaScript data export")
    try:
        payload = json.loads(text[marker + 1 :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise FalPhase1Error(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise FalPhase1Error(f"{path} does not contain an object")
    return payload


def iter_records(payload: Mapping[str, Any], group: str) -> Iterable[dict[str, Any]]:
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), Mapping) else {}
    schema = schemas.get(group) if isinstance(schemas.get(group), list) else []
    rows = payload.get(group) if isinstance(payload.get(group), list) else []
    for row in rows:
        record = row_record(row, schema)
        if record:
            yield record


def iter_editorial_records(payload: Mapping[str, Any], group: str) -> Iterable[dict[str, Any]]:
    editorial = payload.get("editorial") if isinstance(payload.get("editorial"), Mapping) else {}
    schema = editorial.get(f"{group[:-1]}_schema") if isinstance(editorial.get(f"{group[:-1]}_schema"), list) else []
    rows = editorial.get(group) if isinstance(editorial.get(group), list) else []
    for row in rows:
        record = row_record(row, schema)
        if record:
            yield record


def _identity_from_record(record: Mapping[str, Any], *, artist: bool) -> tuple[str, str, str]:
    uuid = str(record.get("soundcharts_uuid") or record.get("uuid") or "").strip()
    spotify = str(record.get("spotify_id") or record.get("spotifyId") or "").strip()
    extra = str(record.get("name") if artist else record.get("isrc") or "").strip()
    return uuid, spotify, extra


def build_known_identities(
    soundcharts: Mapping[str, Any],
    browse: Mapping[str, Any] | None = None,
    radar: Mapping[str, Any] | None = None,
    performance: Mapping[str, Any] | None = None,
    legacy: Mapping[str, Any] | None = None,
) -> KnownIdentities:
    known = KnownIdentities(set(), set(), set(), set(), set())
    artist_records = list(iter_records(soundcharts, "artists")) + list(iter_editorial_records(soundcharts, "artists"))
    track_records = list(iter_records(soundcharts, "tracks")) + list(iter_editorial_records(soundcharts, "tracks"))
    if isinstance(legacy, Mapping):
        artist_records.extend(iter_records(legacy, "artists"))
        artist_records.extend(iter_editorial_records(legacy, "artists"))
        track_records.extend(iter_records(legacy, "tracks"))
        track_records.extend(iter_editorial_records(legacy, "tracks"))

    catalogue = browse.get("discovery_catalogue") if isinstance(browse, Mapping) else None
    if isinstance(catalogue, Mapping):
        artist_schema = catalogue.get("artist_schema") if isinstance(catalogue.get("artist_schema"), list) else []
        track_schema = catalogue.get("track_schema") if isinstance(catalogue.get("track_schema"), list) else []
        artist_records.extend(row_record(row, artist_schema) for row in catalogue.get("artists", []) if isinstance(catalogue.get("artists"), list))
        track_records.extend(row_record(row, track_schema) for row in catalogue.get("tracks", []) if isinstance(catalogue.get("tracks"), list))

    for record in artist_records:
        uuid, spotify, _ = _identity_from_record(record, artist=True)
        if uuid:
            known.artist_uuids.add(uuid)
        if spotify:
            known.artist_spotify_ids.add(spotify)
    for record in track_records:
        uuid, spotify, isrc = _identity_from_record(record, artist=False)
        if uuid:
            known.track_uuids.add(uuid)
        if spotify:
            known.track_spotify_ids.add(spotify)
        if isrc:
            known.track_isrcs.add(isrc.upper())

    if isinstance(radar, Mapping):
        for artist in radar.get("artists", []) if isinstance(radar.get("artists"), list) else []:
            if isinstance(artist, list) and len(artist) > 7 and artist[7]:
                known.artist_spotify_ids.add(str(artist[7]))
        for track in radar.get("rows", []) if isinstance(radar.get("rows"), list) else []:
            if isinstance(track, list) and len(track) > 6 and track[6]:
                known.track_spotify_ids.add(str(track[6]))
    if isinstance(performance, Mapping):
        for spotify_id, entry in (performance.get("artists") or {}).items():
            known.artist_spotify_ids.add(str(spotify_id))
            if isinstance(entry, Mapping) and entry.get("soundcharts_uuid"):
                known.artist_uuids.add(str(entry["soundcharts_uuid"]))
        for spotify_id, entry in (performance.get("tracks") or {}).items():
            known.track_spotify_ids.add(str(spotify_id))
            if isinstance(entry, Mapping) and entry.get("soundcharts_uuid"):
                known.track_uuids.add(str(entry["soundcharts_uuid"]))
    return known


def merge_known_identities(*groups: KnownIdentities) -> KnownIdentities:
    merged = KnownIdentities(set(), set(), set(), set(), set())
    for group in groups:
        merged.artist_uuids.update(group.artist_uuids)
        merged.artist_spotify_ids.update(group.artist_spotify_ids)
        merged.track_uuids.update(group.track_uuids)
        merged.track_spotify_ids.update(group.track_spotify_ids)
        merged.track_isrcs.update(group.track_isrcs)
    return merged


def _catalogue_records(payload: Mapping[str, Any] | None, group: str) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return []
    catalogue = payload.get("discovery_catalogue")
    if not isinstance(catalogue, Mapping):
        return []
    schema_name = f"{group[:-1]}_schema"
    schema = catalogue.get(schema_name) if isinstance(catalogue.get(schema_name), list) else []
    rows = catalogue.get(group) if isinstance(catalogue.get(group), list) else []
    return [row_record(row, schema) for row in rows if row_record(row, schema)]


def _latest_performance_audience(entry: Mapping[str, Any]) -> int | None:
    history = entry.get("monthly_listeners_history") or entry.get("history") or []
    if not isinstance(history, list) or not history:
        return None
    point = history[-1]
    value = point[1] if isinstance(point, list) and len(point) > 1 else point.get("value") if isinstance(point, Mapping) else None
    return finite_int(value)


def extract_seed_cohort(
    payload: Mapping[str, Any],
    *,
    max_seeds: int = DEFAULT_MAX_SEEDS,
    min_audience: int = DEFAULT_SEED_MIN_AUDIENCE,
) -> tuple[list[SeedArtist], int]:
    """Freeze the audited historical cohort; do not rebuild it from live deltas.

    The reviewed source contains 10,336 artist rows and resolves to 4,186
    unique, fully identified artists after the established blacklist, the
    50k+ audience floor and Spotify/Soundcharts deduplication. ``qualifies``,
    ``fal_out`` and ``source_tier`` are intentionally not seed filters.
    """
    by_uuid: dict[str, SeedArtist] = {}
    for record in iter_records(payload, "artists"):
        uuid = str(record.get("soundcharts_uuid") or "").strip()
        spotify = str(record.get("spotify_id") or "").strip()
        name = str(record.get("name") or spotify or f"soundcharts:{uuid[:8]}").strip()
        listeners = finite_int(record.get("monthly_listeners"))
        if not uuid or not spotify or listeners is None or listeners < min_audience:
            continue
        if normalize_text(name) in NORMALISED_PUBLIC_ARTIST_BLACKLIST:
            continue
        candidate = SeedArtist(
            soundcharts_uuid=uuid,
            spotify_id=spotify,
            name=name,
            monthly_listeners=listeners,
            qualifies=bool(finite_int(record.get("qualifies"))),
        )
        previous = by_uuid.get(uuid)
        if previous is None or (candidate.qualifies, bool(candidate.spotify_id)) > (previous.qualifies, bool(previous.spotify_id)):
            by_uuid[uuid] = candidate

    eligible_count = len(by_uuid)
    ordered = sorted(
        by_uuid.values(),
        key=lambda item: (
            0 if item.qualifies else 1,
            normalize_text(item.name),
            item.spotify_id,
            item.soundcharts_uuid,
        ),
    )
    if eligible_count > max(0, max_seeds):
        raise FalPhase1Error(
            f"Active seed cohort exceeds the configured capacity ({eligible_count} > {max_seeds}); refusing silent truncation"
        )
    return ordered, eligible_count


def cohort_hash(seeds: Sequence[SeedArtist]) -> str:
    encoded = json.dumps(
        [[seed.soundcharts_uuid, seed.spotify_id, seed.name, seed.monthly_listeners] for seed in seeds],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


SCHEMA_SQL = """
-- A single-file DELETE journal is intentional: GitHub artifacts restore only
-- the SQLite file, so no committed state may depend on a detached WAL file.
PRAGMA journal_mode=DELETE;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seeds (
  soundcharts_uuid TEXT PRIMARY KEY,
  spotify_id TEXT,
  name TEXT NOT NULL,
  monthly_listeners INTEGER NOT NULL,
  source_rank INTEGER NOT NULL,
  related_offset INTEGER NOT NULL DEFAULT 0,
  related_total INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seed_resolution_pending (
  spotify_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'resolution_pending',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seed_aliases (
  alias_uuid TEXT PRIMARY KEY,
  canonical_uuid TEXT NOT NULL,
  spotify_ids_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seed_aliases_canonical ON seed_aliases(canonical_uuid);
CREATE TABLE IF NOT EXISTS related_edges (
  seed_uuid TEXT NOT NULL,
  candidate_uuid TEXT NOT NULL,
  rank INTEGER NOT NULL,
  candidate_spotify_id TEXT,
  candidate_name TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(seed_uuid, candidate_uuid),
  FOREIGN KEY(seed_uuid) REFERENCES seeds(soundcharts_uuid)
);
CREATE TABLE IF NOT EXISTS candidates (
  soundcharts_uuid TEXT PRIMARY KEY,
  spotify_id TEXT,
  name TEXT,
  monthly_listeners INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  best_rank INTEGER,
  status TEXT NOT NULL DEFAULT 'discovered',
  reason TEXT,
  instrumental_status TEXT NOT NULL DEFAULT 'unknown',
  ai_risk TEXT NOT NULL DEFAULT 'unknown',
  genre_status TEXT NOT NULL DEFAULT 'unknown',
  latest_release_date TEXT,
  catalog_offset INTEGER NOT NULL DEFAULT 0,
  catalog_total INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_sources (
  candidate_uuid TEXT NOT NULL,
  seed_uuid TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY(candidate_uuid, seed_uuid),
  FOREIGN KEY(candidate_uuid) REFERENCES candidates(soundcharts_uuid),
  FOREIGN KEY(seed_uuid) REFERENCES seeds(soundcharts_uuid)
);
CREATE TABLE IF NOT EXISTS tracks (
  soundcharts_uuid TEXT PRIMARY KEY,
  candidate_uuid TEXT NOT NULL,
  spotify_id TEXT,
  isrc TEXT,
  title TEXT,
  credit_name TEXT,
  release_date TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(candidate_uuid) REFERENCES candidates(soundcharts_uuid)
);
CREATE INDEX IF NOT EXISTS idx_seeds_status_rank ON seeds(status, source_rank);
CREATE INDEX IF NOT EXISTS idx_candidates_status_rank ON candidates(status, source_count DESC, best_rank);
CREATE INDEX IF NOT EXISTS idx_tracks_spotify ON tracks(spotify_id);
CREATE INDEX IF NOT EXISTS idx_tracks_isrc ON tracks(isrc);
CREATE INDEX IF NOT EXISTS idx_sources_seed ON candidate_sources(seed_uuid);
CREATE TABLE IF NOT EXISTS candidate_tracks (
  candidate_uuid TEXT NOT NULL,
  track_uuid TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY(candidate_uuid, track_uuid),
  FOREIGN KEY(candidate_uuid) REFERENCES candidates(soundcharts_uuid),
  FOREIGN KEY(track_uuid) REFERENCES tracks(soundcharts_uuid)
);
CREATE INDEX IF NOT EXISTS idx_candidate_tracks_track ON candidate_tracks(track_uuid);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  entity_uuid TEXT,
  error_code TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
"""


def open_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_SQL)
    track_columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(tracks)")}
    if "attempts" not in track_columns:
        connection.execute("ALTER TABLE tracks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    if "error_code" not in track_columns:
        connection.execute("ALTER TABLE tracks ADD COLUMN error_code TEXT")
    connection.commit()
    stored_version = meta_get(connection, "state_version")
    if stored_version is None:
        connection.execute("INSERT INTO meta(key,value) VALUES('state_version',?)", (str(STATE_VERSION),))
    elif stored_version == "1" and STATE_VERSION == 2:
        # Explicit in-place schema migration.  The workflow first copies the
        # newest v1 artifact to a separately named v2 checkpoint, so the v1
        # artifact remains immutable and recoverable.
        connection.execute("BEGIN IMMEDIATE")
        meta_set(connection, "migrated_from_state_version", stored_version)
        meta_set(connection, "state_version", STATE_VERSION)
        meta_set(connection, "state_migrated_at", utc_now())
        connection.commit()
    elif stored_version != str(STATE_VERSION):
        connection.close()
        raise FalPhase1Error(
            f"Unsupported staging state version ({stored_version}; expected {STATE_VERSION})"
        )
    connection.commit()
    return connection


def meta_get(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def meta_set(connection: sqlite3.Connection, key: str, value: Any) -> None:
    connection.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def freeze_seed_cohort(
    connection: sqlite3.Connection,
    seeds: Sequence[SeedArtist],
    *,
    source_eligible: int,
    snapshot_name: str,
    snapshot_generated_at: str,
) -> int:
    existing = int(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0])
    if existing:
        expected_hash = cohort_hash(seeds)
        stored_hash = meta_get(connection, "cohort_hash")
        stored_snapshot = meta_get(connection, "cohort_snapshot")
        stored_eligible = meta_get(connection, "cohort_source_eligible")
        rows = connection.execute(
            "SELECT soundcharts_uuid,spotify_id,name,monthly_listeners FROM seeds ORDER BY source_rank"
        ).fetchall()
        stored_seeds = [
            SeedArtist(str(row[0]), str(row[1] or ""), str(row[2]), int(row[3]), False)
            for row in rows
        ]
        actual_hash = cohort_hash(stored_seeds)
        if (
            existing != len(seeds)
            or stored_hash != expected_hash
            or actual_hash != expected_hash
            or stored_snapshot != snapshot_name
            or stored_eligible != str(source_eligible)
        ):
            raise FalPhase1Error("Existing staging database does not match the frozen seed cohort")
        return existing
    now = utc_now()
    connection.executemany(
        """INSERT INTO seeds(soundcharts_uuid,spotify_id,name,monthly_listeners,source_rank,updated_at)
           VALUES(?,?,?,?,?,?)""",
        [
            (seed.soundcharts_uuid, seed.spotify_id, seed.name, seed.monthly_listeners, rank, now)
            for rank, seed in enumerate(seeds)
        ],
    )
    meta_set(connection, "cohort_hash", cohort_hash(seeds))
    meta_set(connection, "cohort_frozen_at", now)
    meta_set(connection, "cohort_source_eligible", source_eligible)
    meta_set(connection, "cohort_snapshot", snapshot_name)
    meta_set(connection, "cohort_snapshot_generated_at", snapshot_generated_at)
    connection.commit()
    return len(seeds)


def read_seed_ledger(
    path: Path,
    *,
    min_resolved: int,
    max_resolved: int,
) -> tuple[list[SeedArtist], list[dict[str, Any]], dict[str, Any]]:
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FalPhase1Error(f"Invalid FAL seed ledger: {path}") from exc
    if not isinstance(ledger, dict):
        raise FalPhase1Error("FAL seed ledger must contain an object")
    # Reuse the builder's canonical hash validation.  The builder has no
    # dependency on this scanner, so importing it here cannot form a cycle.
    from build_soundcharts_fal_seed_ledger import SeedLedgerError, validate_ledger

    try:
        validate_ledger(ledger, min_resolved=min_resolved, max_resolved=max_resolved)
    except SeedLedgerError as exc:
        raise FalPhase1Error(str(exc)) from exc

    seeds: list[SeedArtist] = []
    for item in ledger.get("artists", []):
        if not isinstance(item, Mapping):
            raise FalPhase1Error("FAL seed ledger artist row is malformed")
        uuid = str(item.get("soundcharts_uuid") or "").strip()
        spotify = str(item.get("spotify_id") or "").strip()
        name = str(item.get("name") or spotify or f"soundcharts:{uuid[:8]}").strip()
        seeds.append(
            SeedArtist(
                soundcharts_uuid=uuid,
                spotify_id=spotify,
                name=name,
                monthly_listeners=finite_int(item.get("monthly_listeners")) or 0,
                qualifies=True,
            )
        )
    seeds.sort(key=lambda item: (item.soundcharts_uuid, item.spotify_id, normalize_text(item.name)))
    pending = [dict(item) for item in ledger.get("resolution_pending", []) if isinstance(item, Mapping)]
    return seeds, pending, ledger


def reconcile_seed_ledger(
    connection: sqlite3.Connection,
    seeds: Sequence[SeedArtist],
    resolution_pending: Sequence[Mapping[str, Any]],
    ledger: Mapping[str, Any],
) -> dict[str, int]:
    """Transactionally extend v1/v2 state without restarting completed work."""

    ledger_uuids = {seed.soundcharts_uuid for seed in seeds}
    if len(ledger_uuids) != len(seeds) or "" in ledger_uuids:
        raise FalPhase1Error("FAL seed ledger contains duplicate or empty UUIDs")
    before = {
        "seeds": int(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0]),
        "candidates": int(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]),
        "tracks": int(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]),
    }
    existing_rows = connection.execute("SELECT soundcharts_uuid FROM seeds").fetchall()
    existing_uuids = {str(row[0]) for row in existing_rows}
    now = utc_now()
    appended = 0
    alias_rows: list[tuple[str, str, str, str]] = []
    for item in ledger.get("artists", []):
        if not isinstance(item, Mapping):
            continue
        canonical_uuid = str(item.get("soundcharts_uuid") or "").strip()
        spotify_ids = [str(value or "").strip() for value in item.get("spotify_id_aliases") or []]
        spotify_json = json.dumps(sorted(value for value in spotify_ids if value), ensure_ascii=False)
        for raw_alias in item.get("soundcharts_uuid_aliases") or []:
            alias_uuid = str(raw_alias or "").strip()
            if alias_uuid and alias_uuid != canonical_uuid:
                alias_rows.append((alias_uuid, canonical_uuid, spotify_json, now))
    alias_keys = [row[0] for row in alias_rows]
    if len(alias_keys) != len(set(alias_keys)):
        raise FalPhase1Error("FAL seed ledger maps one UUID alias to several canonical seeds")
    existing_aliases = {
        str(row[0]): str(row[1])
        for row in connection.execute("SELECT alias_uuid,canonical_uuid FROM seed_aliases")
    }
    canonical_was_alias = sorted(ledger_uuids & set(existing_aliases))
    conflicting_aliases = sorted(
        alias_uuid
        for alias_uuid, canonical_uuid, _, _ in alias_rows
        if alias_uuid in existing_aliases and existing_aliases[alias_uuid] != canonical_uuid
    )
    if canonical_was_alias or conflicting_aliases:
        raise FalPhase1Error(
            "FAL alias canonicalization changed across ledgers; refusing a destructive remap "
            f"(canonical_was_alias={canonical_was_alias[:5]}, conflicts={conflicting_aliases[:5]})"
        )
    suppressed_pending = 0
    try:
        connection.execute("BEGIN IMMEDIATE")
        next_rank = int(connection.execute("SELECT COALESCE(MAX(source_rank),-1)+1 FROM seeds").fetchone()[0])
        for seed in seeds:
            if seed.soundcharts_uuid in existing_uuids:
                continue
            connection.execute(
                """INSERT INTO seeds(soundcharts_uuid,spotify_id,name,monthly_listeners,source_rank,updated_at)
                   VALUES(?,?,?,?,?,?)""",
                (
                    seed.soundcharts_uuid,
                    seed.spotify_id,
                    seed.name,
                    seed.monthly_listeners,
                    next_rank,
                    now,
                ),
            )
            next_rank += 1
            appended += 1

        connection.executemany(
            """INSERT INTO seed_aliases(alias_uuid,canonical_uuid,spotify_ids_json,observed_at)
               VALUES(?,?,?,?) ON CONFLICT(alias_uuid) DO NOTHING""",
            alias_rows,
        )
        # Preserve every historical row and all of its graph edges, but do not
        # spend calls scanning a superseded UUID after its canonical alias has
        # joined the current ledger.
        for alias_uuid in alias_keys:
            suppressed_pending += connection.execute(
                """UPDATE seeds SET status='alias_superseded',error_code=NULL,updated_at=?
                   WHERE soundcharts_uuid=? AND status NOT IN ('complete','alias_superseded')""",
                (now, alias_uuid),
            ).rowcount

        resolved_spotify = {seed.spotify_id for seed in seeds if seed.spotify_id}
        for spotify_id in resolved_spotify:
            connection.execute("DELETE FROM seed_resolution_pending WHERE spotify_id=?", (spotify_id,))
        for item in resolution_pending:
            spotify_id = str(item.get("spotify_id") or "").strip()
            if not spotify_id or spotify_id in resolved_spotify:
                continue
            name = str(item.get("name") or spotify_id).strip()
            sources = item.get("sources") if isinstance(item.get("sources"), list) else []
            connection.execute(
                """INSERT INTO seed_resolution_pending(
                     spotify_id,name,sources_json,status,first_seen_at,updated_at)
                   VALUES(?,?,?,'resolution_pending',?,?)
                   ON CONFLICT(spotify_id) DO UPDATE SET
                     name=excluded.name,sources_json=excluded.sources_json,
                     status='resolution_pending',updated_at=excluded.updated_at""",
                (spotify_id, name, json.dumps(sources, ensure_ascii=False, sort_keys=True), now, now),
            )

        meta_set(connection, "cohort_mode", "canonical-accepted-v2")
        meta_set(connection, "seed_ledger_hash", ledger.get("cohort_hash") or "")
        meta_set(connection, "seed_ledger_generated_at", ledger.get("generated_at") or "")
        coverage = ledger.get("coverage") if isinstance(ledger.get("coverage"), Mapping) else {}
        meta_set(connection, "seed_ledger_expected_displayed", finite_int(coverage.get("expected_displayed")) or 0)
        meta_set(connection, "seed_ledger_resolved_uuid", len(seeds))
        meta_set(connection, "seed_ledger_unresolved", len(resolution_pending))
        meta_set(connection, "seed_ledger_reconciled_at", now)
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    after = {
        "seeds": int(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0]),
        "candidates": int(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]),
        "tracks": int(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]),
    }
    if after["seeds"] != before["seeds"] + appended:
        raise FalPhase1Error("Append-only seed reconciliation changed the cohort unexpectedly")
    if after["candidates"] != before["candidates"] or after["tracks"] != before["tracks"]:
        raise FalPhase1Error("Seed reconciliation modified candidate or track staging rows")
    return {
        "state_seeds_before": before["seeds"],
        "matched_existing": len(existing_uuids & ledger_uuids),
        "appended": appended,
        "state_seeds_after": after["seeds"],
        "carried_forward_historical_seeds": len(existing_uuids - ledger_uuids),
        "resolution_pending": int(
            connection.execute("SELECT COUNT(*) FROM seed_resolution_pending WHERE status='resolution_pending'").fetchone()[0]
        ),
        "uuid_aliases": len(alias_rows),
        "historical_alias_rows": int(
            connection.execute(
                "SELECT COUNT(*) FROM seeds WHERE soundcharts_uuid IN (SELECT alias_uuid FROM seed_aliases)"
            ).fetchone()[0]
        ),
        "suppressed_pending_alias_rows": suppressed_pending,
    }


def requeue_failed_work(connection: sqlite3.Connection) -> dict[str, int]:
    """Retry transient terminal failures once at the start of a later run."""

    counts = {"seeds": 0, "candidates": 0, "tracks": 0}
    counts["seeds"] = connection.execute(
        "UPDATE seeds SET status='pending',attempts=0,error_code=NULL,updated_at=? WHERE status='failed'",
        (utc_now(),),
    ).rowcount
    phase_status = {
        "identity": "identity_pending",
        "audience": "discovered",
        "activity": "activity_pending",
        "activity_page": "activity_pending",
        "catalog": "catalog_pending",
        "catalog_page": "catalog_pending",
    }
    failed_candidates = connection.execute(
        "SELECT soundcharts_uuid FROM candidates WHERE status='failed'"
    ).fetchall()
    for row in failed_candidates:
        uuid = str(row[0])
        error = connection.execute(
            "SELECT stage FROM errors WHERE entity_uuid=? ORDER BY id DESC LIMIT 1", (uuid,)
        ).fetchone()
        resume = phase_status.get(str(error[0]) if error else "", "discovered")
        connection.execute(
            "UPDATE candidates SET status=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?",
            (resume, utc_now(), uuid),
        )
        counts["candidates"] += 1
    # Track-detail failures belong to a later phase; keep the light inventory
    # available for review instead of leaving an unreachable failed row.
    counts["tracks"] = connection.execute(
        """UPDATE tracks SET status='review_metadata_pending',attempts=0,error_code=NULL,
           reason='phase2_metadata_classification_required',updated_at=? WHERE status='failed'""",
        (utc_now(),),
    ).rowcount
    meta_set(connection, "last_retry_requeue_at", utc_now())
    connection.commit()
    return counts


def _list_items(response: Any) -> list[Mapping[str, Any]]:
    if isinstance(response, list):
        return [item for item in response if isinstance(item, Mapping)]
    if not isinstance(response, Mapping):
        return []
    for key in ("items", "data", "results"):
        value = response.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, Mapping)]
    obj = response.get("object")
    if isinstance(obj, Mapping):
        return _list_items(obj)
    return []


def _has_collection_list(response: Any) -> bool:
    """Return whether the payload explicitly contains a supported list field.

    A successful HTTP response without a collection field is not proof of an
    empty Soundcharts page.  Keeping this separate from ``_list_items`` lets us
    distinguish a genuine empty ``items: []`` response from a malformed/error
    envelope such as ``{"page": {"total": 0}}``.
    """
    if not isinstance(response, Mapping):
        return False
    for key in ("items", "data", "results"):
        if isinstance(response.get(key), list):
            return True
    obj = response.get("object")
    return isinstance(obj, Mapping) and _has_collection_list(obj)


def _page_info(response: Any, item_count: int, offset: int, limit: int) -> tuple[int | None, int | None]:
    page = response.get("page") if isinstance(response, Mapping) and isinstance(response.get("page"), Mapping) else {}
    total = finite_int(page.get("total"))
    page_offset = finite_int(page.get("offset"))
    page_limit = finite_int(page.get("limit"))
    start = offset if page_offset is None else page_offset
    cursor = start + item_count
    effective_limit = page_limit if page_limit is not None and page_limit > 0 else limit
    if total is not None:
        if total > cursor and item_count < effective_limit:
            raise FalPhase1Error("Soundcharts returned an incomplete page before the total cursor")
        next_offset = cursor if cursor < total else None
    else:
        next_offset = cursor if item_count >= effective_limit and item_count > 0 else None
    hinted = finite_int(page.get("nextOffset") or page.get("next_offset"))
    if hinted is not None and next_offset is not None and hinted != next_offset:
        raise FalPhase1Error("Soundcharts next cursor does not match the returned item count")
    return total, next_offset


def _validate_page(response: Any, raw_items: Sequence[Mapping[str, Any]], *, expected_offset: int) -> None:
    if not isinstance(response, Mapping):
        raise FalPhase1Error("Soundcharts page is not an object")
    if response.get("errors"):
        raise FalPhase1Error("Soundcharts page contains API errors")
    if not _has_collection_list(response):
        raise FalPhase1Error("Soundcharts page has no supported collection list")
    page = response.get("page") if isinstance(response, Mapping) and isinstance(response.get("page"), Mapping) else None
    if page is not None:
        observed_offset = finite_int(page.get("offset"))
        if observed_offset is not None and observed_offset != expected_offset:
            raise FalPhase1Error("Soundcharts page offset does not match the requested cursor")
    if not raw_items:
        total = finite_int(page.get("total")) if page is not None else None
        if total is None or total > expected_offset:
            raise FalPhase1Error("Soundcharts page is unexpectedly empty or malformed")


def _identifier_values(obj: Any) -> tuple[str, str]:
    spotify = ""
    isrc = ""

    def visit(value: Any, hint: str = "") -> None:
        nonlocal spotify, isrc
        if isinstance(value, Mapping):
            direct_spotify = value.get("spotify_id") or value.get("spotifyId")
            if direct_spotify and SPOTIFY_ID_RE.fullmatch(str(direct_spotify).strip()):
                spotify = spotify or str(direct_spotify).strip()
            direct_isrc = value.get("isrc") or value.get("ISRC")
            if direct_isrc and ISRC_RE.fullmatch(str(direct_isrc).replace("-", "").strip()):
                isrc = isrc or str(direct_isrc).replace("-", "").upper().strip()
            code = normalize_text(value.get("platform") or value.get("platformCode") or value.get("type") or value.get("code"))
            identifier = value.get("identifier") or value.get("value") or value.get("id")
            if identifier:
                raw = str(identifier).strip()
                if "spotify" in code and SPOTIFY_ID_RE.fullmatch(raw):
                    spotify = spotify or raw
                if "isrc" in code and ISRC_RE.fullmatch(raw.replace("-", "")):
                    isrc = isrc or raw.replace("-", "").upper()
            for key, nested in value.items():
                if key not in {"name", "title", "creditName", "description", "biography"}:
                    visit(nested, normalize_text(key))
        elif isinstance(value, (list, tuple)):
            for nested in value:
                visit(nested, hint)
        elif isinstance(value, str):
            raw = value.strip()
            if "spotify" in hint and SPOTIFY_ID_RE.fullmatch(raw):
                spotify = spotify or raw
            if "isrc" in hint and ISRC_RE.fullmatch(raw.replace("-", "")):
                isrc = isrc or raw.replace("-", "").upper()

    visit(obj)
    return spotify, isrc


def _artist_object(item: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("artist", "object", "relatedArtist"):
        value = item.get(key)
        if isinstance(value, Mapping) and (value.get("uuid") or value.get("soundcharts_uuid")):
            return value
    return item


def parse_related_page(response: Any, *, offset: int, limit: int) -> tuple[list[dict[str, Any]], int | None, int | None]:
    related: list[dict[str, Any]] = []
    raw_items = _list_items(response)
    _validate_page(response, raw_items, expected_offset=offset)
    for index, raw in enumerate(raw_items):
        item = _artist_object(raw)
        uuid = str(item.get("soundcharts_uuid") or item.get("uuid") or "").strip()
        if not uuid:
            continue
        spotify, _ = _identifier_values(item)
        related.append(
            {
                "soundcharts_uuid": uuid,
                "spotify_id": spotify,
                "name": str(item.get("name") or item.get("artistName") or raw.get("name") or "").strip(),
                "rank": offset + index + 1,
                "evidence": extract_evidence(item),
            }
        )
    if len(related) != len(raw_items):
        raise FalPhase1Error("Soundcharts related page contains an artist without UUID")
    total, next_offset = _page_info(response, len(raw_items), offset, limit)
    return related, total, next_offset


def _date(value: Any) -> str:
    raw = str(value or "").strip()[:10]
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return ""


def extract_evidence(obj: Any) -> dict[str, Any]:
    genres: list[str] = []
    vocal: bool | None = None
    instrumental: bool | None = None
    ai_risk = "unknown"

    def visit(value: Any, key_hint: str = "") -> None:
        nonlocal vocal, instrumental, ai_risk
        if isinstance(value, Mapping):
            for key, nested in value.items():
                hint = normalize_text(key)
                if hint in {"genre", "genres", "subgenre", "subgenres", "primary genre", "primarygenre"}:
                    if isinstance(nested, str):
                        genres.append(nested.strip())
                    elif isinstance(nested, list):
                        for item in nested:
                            if isinstance(item, (str, int)):
                                genres.append(str(item).strip())
                            elif isinstance(item, Mapping):
                                label = item.get("name") or item.get("value") or item.get("slug")
                                if label:
                                    genres.append(str(label).strip())
                if hint in {"has lyrics", "haslyrics", "vocal", "vocals", "is vocal", "isvocal"} and isinstance(nested, bool):
                    vocal = nested
                if hint in {"instrumental", "is instrumental", "isinstrumental"} and isinstance(nested, bool):
                    instrumental = nested
                if hint in {"ai risk", "ai_risk", "airisk", "generative ai risk"} and nested is not None:
                    ai_risk = normalize_text(nested) or "unknown"
                visit(nested, hint)
        elif isinstance(value, (list, tuple)):
            for nested in value:
                visit(nested, key_hint)

    visit(obj)
    clean_genres = sorted({" ".join(genre.split()) for genre in genres if genre.strip()})
    return {"genres": clean_genres, "vocal": vocal, "instrumental": instrumental, "ai_risk": ai_risk}


def evidence_decision(evidence: Mapping[str, Any]) -> tuple[str | None, str, str, str]:
    genres = [normalize_text(value) for value in evidence.get("genres", []) if value]
    instrumental = "instrumental" if evidence.get("instrumental") is True else "unknown"
    if evidence.get("vocal") is True or evidence.get("instrumental") is False or any(VOCAL_RE.search(genre) for genre in genres):
        return "blocked_explicit_vocal", "vocal_evidence", "vocal", "unknown"
    ai_raw = normalize_text(evidence.get("ai_risk"))
    if ai_raw and ai_raw != "unknown" and AI_HIGH_RE.search(ai_raw):
        return "blocked_ai_high", "ai_high_evidence", instrumental, "unknown"
    target = any(any(marker in genre for marker in TARGET_GENRE_MARKERS) for genre in genres)
    forbidden = any(
        marker == genre or f" {marker} " in f" {genre} "
        for genre in genres
        for marker in FORBIDDEN_GENRES
    )
    if forbidden and not target:
        return "blocked_out_of_scope", "out_of_taxonomy_evidence", instrumental, "out_of_scope"
    genre_status = "in_scope" if target else "unknown"
    ai_status = "low" if ai_raw in {"low", "faible"} else "unknown"
    return None, "", instrumental, genre_status if genre_status else ai_status


def parse_catalogue_page(
    response: Any,
    *,
    artist_uuid: str,
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int | None, int | None]:
    tracks: list[dict[str, Any]] = []
    raw_items = _list_items(response)
    _validate_page(response, raw_items, expected_offset=offset)
    for raw in raw_items:
        item = raw.get("song") if isinstance(raw.get("song"), Mapping) else raw
        uuid = str(item.get("soundcharts_uuid") or item.get("uuid") or "").strip()
        if not uuid:
            continue
        spotify, isrc = _identifier_values(item)
        evidence = extract_evidence(item)
        tracks.append(
            {
                "soundcharts_uuid": uuid,
                "spotify_id": spotify,
                "isrc": isrc,
                "title": str(item.get("name") or item.get("title") or "").strip(),
                "credit_name": str(item.get("creditName") or item.get("artistName") or "").strip(),
                "release_date": _date(item.get("releaseDate") or item.get("release_date")),
                "artist_uuid": artist_uuid,
                "evidence": evidence,
            }
        )
    if len(tracks) != len(raw_items):
        raise FalPhase1Error("Soundcharts song page contains a track without UUID")
    total, next_offset = _page_info(response, len(raw_items), offset, limit)
    return tracks, total, next_offset


def latest_release_date(tracks: Sequence[Mapping[str, Any]]) -> str:
    dates = [str(track.get("release_date") or "") for track in tracks if track.get("release_date")]
    return max(dates) if dates else ""


def is_recent(release_date: str, *, as_of: dt.date, recent_days: int) -> bool | None:
    if not release_date:
        return None
    try:
        release = dt.date.fromisoformat(release_date[:10])
    except ValueError:
        return None
    return 0 <= (as_of - release).days <= recent_days


class Phase1Scanner:
    def __init__(
        self,
        connection: sqlite3.Connection,
        client: Any,
        known: KnownIdentities,
        *,
        workers: int,
        related_limit: int,
        catalog_page_size: int,
        min_audience: int,
        recent_days: int,
        retry_limit: int,
        max_related_artists: int | None,
        as_of: dt.date | None = None,
    ):
        self.connection = connection
        self.client = client
        self.known = known
        self.workers = max(1, workers)
        self.related_limit = max(1, related_limit)
        self.catalog_page_size = max(1, catalog_page_size)
        self.min_audience = max(0, min_audience)
        self.recent_days = max(1, recent_days)
        self.retry_limit = max(1, retry_limit)
        self.max_related_artists = max_related_artists if max_related_artists and max_related_artists > 0 else None
        self.as_of = as_of or dt.datetime.now(dt.timezone.utc).date()
        self.halt_reason: str | None = None

    def _fetch_batch(self, tasks: Sequence[tuple[str, str]]) -> tuple[dict[str, Any], dict[str, str]]:
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}

        def fetch(task: tuple[str, str]) -> tuple[str, Any]:
            key, path = task
            return key, self.client.get(path)

        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as executor:
            future_map = {executor.submit(fetch, task): task[0] for task in tasks}
            for future in concurrent.futures.as_completed(future_map):
                key = future_map[future]
                try:
                    result_key, payload = future.result()
                    results[result_key] = payload
                except SoundchartsRequestLimitError:
                    errors[key] = "request_limit"
                    self.halt_reason = "request_limit"
                except SoundchartsQuotaReserveError:
                    errors[key] = "quota_reserve"
                    self.halt_reason = "quota_reserve"
                except SoundchartsDataUnavailableError:
                    errors[key] = "unavailable"
                except (SoundchartsError, OSError, RuntimeError):
                    errors[key] = "request_failed"
        return results, errors

    def _record_error(self, stage: str, uuid: str, code: str) -> None:
        self.connection.execute(
            "INSERT INTO errors(stage,entity_uuid,error_code,observed_at) VALUES(?,?,?,?)",
            (stage, uuid, code, utc_now()),
        )

    def _retry_or_fail(self, table: str, uuid: str, current_attempts: int, stage: str, error_code: str) -> None:
        attempts = current_attempts + 1
        status = "failed" if attempts >= self.retry_limit and error_code not in {"request_limit", "quota_reserve"} else None
        if table == "seeds":
            self.connection.execute(
                "UPDATE seeds SET attempts=?, error_code=?, status=COALESCE(?,status), updated_at=? WHERE soundcharts_uuid=?",
                (attempts, error_code, status, utc_now(), uuid),
            )
        elif table == "candidates":
            self.connection.execute(
                "UPDATE candidates SET attempts=?, error_code=?, status=COALESCE(?,status), updated_at=? WHERE soundcharts_uuid=?",
                (attempts, error_code, status, utc_now(), uuid),
            )
        else:
            self.connection.execute(
                "UPDATE tracks SET attempts=?, error_code=?, status=COALESCE(?,status), updated_at=? WHERE soundcharts_uuid=?",
                (attempts, error_code, status, utc_now(), uuid),
            )
        self._record_error(stage, uuid, error_code)

    def _upsert_related(self, seed_uuid: str, item: Mapping[str, Any]) -> None:
        now = utc_now()
        uuid = str(item["soundcharts_uuid"])
        spotify = str(item.get("spotify_id") or "")
        name = str(item.get("name") or "")
        rank = int(item.get("rank") or 0)
        duplicate_in_state = bool(
            spotify
            and self.connection.execute(
                "SELECT 1 FROM candidates WHERE soundcharts_uuid<>? AND spotify_id=? LIMIT 1",
                (uuid, spotify),
            ).fetchone()
        )
        duplicate = (
            uuid in self.known.artist_uuids
            or bool(spotify and spotify in self.known.artist_spotify_ids)
            or duplicate_in_state
        )
        blacklisted = normalize_text(name) in NORMALISED_PUBLIC_ARTIST_BLACKLIST
        status = (
            "blocked_blacklist"
            if blacklisted
            else "duplicate_existing" if duplicate else ("discovered" if spotify else "identity_pending")
        )
        reason = "public_artist_blacklist" if blacklisted else ("known_soundcharts_or_spotify_artist" if duplicate else None)
        evidence = dict(item.get("evidence") or {})
        decision, decision_reason, instrumental, genre_status = evidence_decision(evidence)
        if decision and not duplicate and not blacklisted:
            status, reason = decision, decision_reason
        ai_risk = "high" if decision == "blocked_ai_high" else ("low" if normalize_text(evidence.get("ai_risk")) in {"low", "faible"} else "unknown")
        self.connection.execute(
            """INSERT INTO candidates(
                 soundcharts_uuid,spotify_id,name,status,reason,instrumental_status,ai_risk,genre_status,
                 best_rank,evidence_json,first_seen_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(soundcharts_uuid) DO UPDATE SET
                 spotify_id=CASE WHEN candidates.spotify_id='' THEN excluded.spotify_id ELSE candidates.spotify_id END,
                 name=CASE WHEN candidates.name='' THEN excluded.name ELSE candidates.name END,
                 best_rank=MIN(COALESCE(candidates.best_rank,excluded.best_rank),excluded.best_rank),
                 evidence_json=CASE WHEN candidates.evidence_json='{}' THEN excluded.evidence_json ELSE candidates.evidence_json END,
                 updated_at=excluded.updated_at""",
            (
                uuid, spotify, name, status, reason, instrumental, ai_risk,
                genre_status, rank, json.dumps(evidence, ensure_ascii=False, sort_keys=True), now, now,
            ),
        )
        self.connection.execute(
            """INSERT INTO candidate_sources(candidate_uuid,seed_uuid,rank) VALUES(?,?,?)
               ON CONFLICT(candidate_uuid,seed_uuid) DO UPDATE SET rank=MIN(rank,excluded.rank)""",
            (uuid, seed_uuid, rank),
        )
        self.connection.execute(
            """INSERT INTO related_edges(seed_uuid,candidate_uuid,rank,candidate_spotify_id,candidate_name,observed_at)
               VALUES(?,?,?,?,?,?) ON CONFLICT(seed_uuid,candidate_uuid) DO UPDATE SET
               rank=MIN(rank,excluded.rank), observed_at=excluded.observed_at""",
            (seed_uuid, uuid, rank, spotify, str(item.get("name") or ""), now),
        )
        self.connection.execute(
            """UPDATE candidates SET
               source_count=(SELECT COUNT(*) FROM candidate_sources WHERE candidate_uuid=?),
               best_rank=(SELECT MIN(rank) FROM candidate_sources WHERE candidate_uuid=?), updated_at=?
               WHERE soundcharts_uuid=?""",
            (uuid, uuid, now, uuid),
        )

    def scan_related_batch(self) -> bool:
        rows = self.connection.execute(
            "SELECT * FROM seeds WHERE status='pending' ORDER BY source_rank LIMIT ?", (self.workers,)
        ).fetchall()
        if not rows:
            return False
        tasks = []
        for row in rows:
            query = urllib.parse.urlencode({"limit": self.related_limit, "offset": int(row["related_offset"])})
            tasks.append((row["soundcharts_uuid"], f"/api/v2/artist/{urllib.parse.quote(row['soundcharts_uuid'])}/related?{query}"))
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            row = by_uuid[uuid]
            try:
                related, total, next_offset = parse_related_page(
                    response, offset=int(row["related_offset"]), limit=self.related_limit
                )
            except FalPhase1Error:
                self._retry_or_fail("seeds", uuid, int(row["attempts"]), "related_page", "invalid_page")
                continue
            for item in related:
                self._upsert_related(uuid, item)
            self.connection.execute(
                "UPDATE seeds SET related_offset=?,related_total=COALESCE(?,related_total),status=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?",
                (next_offset or int(row["related_offset"]) + len(related), total, "pending" if next_offset is not None else "complete", utc_now(), uuid),
            )
        for uuid, code in errors.items():
            self._retry_or_fail("seeds", uuid, int(by_uuid[uuid]["attempts"]), "related", code)
        self.connection.commit()
        return True

    def scan_identity_batch(self) -> bool:
        """Resolve Spotify identity before deciding that an FAL artist is new."""

        rows = self.connection.execute(
            "SELECT * FROM candidates WHERE status='identity_pending' ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?",
            (self.workers,),
        ).fetchall()
        if not rows:
            return False
        tasks = [
            (
                row["soundcharts_uuid"],
                f"/api/v2/artist/{urllib.parse.quote(row['soundcharts_uuid'])}/identifiers?offset=0&limit=100",
            )
            for row in rows
        ]
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            spotify, _ = _identifier_values(response)
            if not spotify:
                status, reason = "review_identity_unknown", "spotify_artist_id_missing"
            else:
                duplicate_in_state = self.connection.execute(
                    "SELECT 1 FROM candidates WHERE soundcharts_uuid<>? AND spotify_id=? LIMIT 1",
                    (uuid, spotify),
                ).fetchone()
                duplicate = spotify in self.known.artist_spotify_ids or duplicate_in_state is not None
                status = "duplicate_existing" if duplicate else "discovered"
                reason = "known_or_staged_spotify_artist" if duplicate else None
            self.connection.execute(
                "UPDATE candidates SET spotify_id=?,status=?,reason=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?",
                (spotify, status, reason, utc_now(), uuid),
            )
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                self.connection.execute(
                    "UPDATE candidates SET status='review_identity_unknown',reason='soundcharts_identifiers_unavailable',error_code=?,updated_at=? WHERE soundcharts_uuid=?",
                    (code, utc_now(), uuid),
                )
                self._record_error("identity", uuid, code)
            else:
                self._retry_or_fail("candidates", uuid, int(row["attempts"]), "identity", code)
        self.connection.commit()
        return True

    def scan_audience_batch(self) -> bool:
        if self.max_related_artists is not None:
            allowed = "AND soundcharts_uuid IN (SELECT soundcharts_uuid FROM candidates WHERE status='discovered' ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?)"
            rows = self.connection.execute(
                f"SELECT * FROM candidates WHERE status='discovered' {allowed} ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?",
                (self.max_related_artists, self.workers),
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT * FROM candidates WHERE status='discovered' ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?",
                (self.workers,),
            ).fetchall()
        if not rows:
            return False
        tasks = [(row["soundcharts_uuid"], f"/api/v2/artist/{urllib.parse.quote(row['soundcharts_uuid'])}/current/stats") for row in rows]
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            metric = extract_artist_spotify_metric(response)
            listeners = finite_int(metric.get("value")) if isinstance(metric, Mapping) else None
            if listeners is None:
                status, reason = "review_audience_unknown", "spotify_monthly_listeners_missing"
            elif listeners < self.min_audience:
                status, reason = "blocked_audience_low", f"below_{self.min_audience}_monthly_listeners"
            else:
                status, reason = "activity_pending", None
            self.connection.execute(
                "UPDATE candidates SET monthly_listeners=?,status=?,reason=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?",
                (listeners, status, reason, utc_now(), uuid),
            )
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                self.connection.execute(
                    "UPDATE candidates SET status='review_audience_unavailable',reason='soundcharts_stats_unavailable',error_code=?,updated_at=? WHERE soundcharts_uuid=?",
                    (code, utc_now(), uuid),
                )
                self._record_error("audience", uuid, code)
            else:
                self._retry_or_fail("candidates", uuid, int(row["attempts"]), "audience", code)
        self.connection.commit()
        return True

    def _track_duplicate(self, track: Mapping[str, Any]) -> bool:
        uuid = str(track.get("soundcharts_uuid") or "")
        spotify = str(track.get("spotify_id") or "")
        isrc = str(track.get("isrc") or "").upper()
        if uuid in self.known.track_uuids or (spotify and spotify in self.known.track_spotify_ids) or (isrc and isrc in self.known.track_isrcs):
            return True
        row = self.connection.execute(
            """SELECT 1 FROM tracks WHERE soundcharts_uuid=?
               OR (?<>'' AND spotify_id=?) OR (?<>'' AND isrc=?) LIMIT 1""",
            (uuid, spotify, spotify, isrc, isrc),
        ).fetchone()
        return row is not None

    def _store_track(self, candidate_uuid: str, track: Mapping[str, Any]) -> str | None:
        now = utc_now()
        evidence = dict(track.get("evidence") or {})
        decision, decision_reason, _, _ = evidence_decision(evidence)
        duplicate = self._track_duplicate(track)
        status = "duplicate_existing" if duplicate else (decision or "review_metadata_pending")
        track_reason = (
            "known_soundcharts_spotify_or_isrc"
            if duplicate
            else decision_reason or "phase2_metadata_classification_required"
        )
        self.connection.execute(
            """INSERT INTO tracks(soundcharts_uuid,candidate_uuid,spotify_id,isrc,title,credit_name,release_date,status,reason,evidence_json,first_seen_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(soundcharts_uuid) DO UPDATE SET
               spotify_id=COALESCE(NULLIF(tracks.spotify_id,''),excluded.spotify_id),
               isrc=COALESCE(NULLIF(tracks.isrc,''),excluded.isrc),
               title=COALESCE(NULLIF(tracks.title,''),excluded.title),
               credit_name=COALESCE(NULLIF(tracks.credit_name,''),excluded.credit_name),
               release_date=COALESCE(NULLIF(tracks.release_date,''),excluded.release_date),
               evidence_json=CASE WHEN tracks.evidence_json='{}' THEN excluded.evidence_json ELSE tracks.evidence_json END,
               updated_at=excluded.updated_at""",
            (
                str(track["soundcharts_uuid"]), candidate_uuid, str(track.get("spotify_id") or ""),
                str(track.get("isrc") or "").upper(), str(track.get("title") or ""),
                str(track.get("credit_name") or ""), str(track.get("release_date") or ""),
                status, track_reason, json.dumps(evidence, ensure_ascii=False, sort_keys=True), now, now,
            ),
        )
        self.connection.execute(
            """INSERT INTO candidate_tracks(candidate_uuid,track_uuid,first_seen_at) VALUES(?,?,?)
               ON CONFLICT(candidate_uuid,track_uuid) DO NOTHING""",
            (candidate_uuid, str(track["soundcharts_uuid"]), now),
        )
        return None

    def _store_page(self, candidate_uuid: str, tracks: Sequence[Mapping[str, Any]]) -> None:
        for track in tracks:
            self._store_track(candidate_uuid, track)

    def scan_activity_batch(self) -> bool:
        rows = self.connection.execute(
            "SELECT * FROM candidates WHERE status='activity_pending' ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?",
            (self.workers,),
        ).fetchall()
        if not rows:
            return False
        tasks = []
        for row in rows:
            query = urllib.parse.urlencode(
                {"sortBy": "releaseDate", "sortOrder": "desc", "offset": 0, "limit": self.catalog_page_size}
            )
            tasks.append((row["soundcharts_uuid"], f"/api/v2.21/artist/{urllib.parse.quote(row['soundcharts_uuid'])}/songs?{query}"))
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            try:
                tracks, total, next_offset = parse_catalogue_page(
                    response, artist_uuid=uuid, offset=0, limit=self.catalog_page_size
                )
            except FalPhase1Error:
                self._retry_or_fail("candidates", uuid, int(by_uuid[uuid]["attempts"]), "activity_page", "invalid_page")
                continue
            # Persist the observed first page even when its release date cannot
            # establish recent activity. The cursor still stays at page zero
            # unless the page itself passed every structural validation above.
            self._store_page(uuid, tracks)
            latest = latest_release_date(tracks)
            recent = is_recent(latest, as_of=self.as_of, recent_days=self.recent_days)
            if recent is None:
                status, reason = "review_activity_unknown", "latest_release_date_missing"
            elif not recent:
                status, reason = "blocked_inactive", "no_release_within_1095_days"
            else:
                # Track-level vocal/out-of-scope/AI evidence blocks only that
                # track. It must never discard the artist's other instrumental
                # catalogue pages.
                if next_offset is None:
                    status, reason = "review_inventory_complete", "phase2_metadata_classification_required"
                else:
                    status, reason = "catalog_pending", None
            self.connection.execute(
                """UPDATE candidates SET latest_release_date=?,catalog_offset=?,catalog_total=?,status=?,reason=?,
                   attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?""",
                (latest or None, next_offset or len(tracks), total, status, reason, utc_now(), uuid),
            )
        for uuid, code in errors.items():
            self._retry_or_fail("candidates", uuid, int(by_uuid[uuid]["attempts"]), "activity", code)
        self.connection.commit()
        return True

    def scan_catalog_batch(self) -> bool:
        rows = self.connection.execute(
            "SELECT * FROM candidates WHERE status='catalog_pending' ORDER BY source_count DESC,best_rank,soundcharts_uuid LIMIT ?",
            (self.workers,),
        ).fetchall()
        if not rows:
            return False
        tasks = []
        for row in rows:
            query = urllib.parse.urlencode(
                {"sortBy": "releaseDate", "sortOrder": "desc", "offset": int(row["catalog_offset"]), "limit": self.catalog_page_size}
            )
            tasks.append((row["soundcharts_uuid"], f"/api/v2.21/artist/{urllib.parse.quote(row['soundcharts_uuid'])}/songs?{query}"))
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            row = by_uuid[uuid]
            try:
                tracks, total, next_offset = parse_catalogue_page(
                    response, artist_uuid=uuid, offset=int(row["catalog_offset"]), limit=self.catalog_page_size
                )
            except FalPhase1Error:
                self._retry_or_fail("candidates", uuid, int(row["attempts"]), "catalog_page", "invalid_page")
                continue
            self._store_page(uuid, tracks)
            if next_offset is None:
                status, reason = "review_inventory_complete", "phase2_metadata_classification_required"
            else:
                status, reason = "catalog_pending", None
            self.connection.execute(
                "UPDATE candidates SET catalog_offset=?,catalog_total=COALESCE(?,catalog_total),status=?,reason=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?",
                (next_offset or int(row["catalog_offset"]) + len(tracks), total, status, reason, utc_now(), uuid),
            )
        for uuid, code in errors.items():
            self._retry_or_fail("candidates", uuid, int(by_uuid[uuid]["attempts"]), "catalog", code)
        self.connection.commit()
        return True

    def _detail_duplicate(self, uuid: str, spotify: str, isrc: str) -> bool:
        if (
            uuid in self.known.track_uuids
            or bool(spotify and spotify in self.known.track_spotify_ids)
            or bool(isrc and isrc in self.known.track_isrcs)
        ):
            return True
        return bool(
            self.connection.execute(
                """SELECT 1 FROM tracks WHERE soundcharts_uuid<>? AND
                   ((?<>'' AND spotify_id=?) OR (?<>'' AND isrc=?)) LIMIT 1""",
                (uuid, spotify, spotify, isrc, isrc),
            ).fetchone()
        )

    def scan_track_details_batch(self) -> bool:
        """Enrich light discography rows before track-level classification."""

        rows = self.connection.execute(
            "SELECT * FROM tracks WHERE status='detail_pending' ORDER BY first_seen_at,soundcharts_uuid LIMIT ?",
            (self.workers,),
        ).fetchall()
        if not rows:
            return False
        tasks = [
            (row["soundcharts_uuid"], f"/api/v2.25/song/{urllib.parse.quote(row['soundcharts_uuid'])}")
            for row in rows
        ]
        results, errors = self._fetch_batch(tasks)
        by_uuid = {row["soundcharts_uuid"]: row for row in rows}
        for uuid, response in results.items():
            row = by_uuid[uuid]
            obj = response.get("object") if isinstance(response, Mapping) and isinstance(response.get("object"), Mapping) else response
            spotify, isrc = _identifier_values(response)
            spotify = spotify or str(row["spotify_id"] or "")
            isrc = (isrc or str(row["isrc"] or "")).upper()
            evidence = extract_evidence(response)
            decision, reason, _, _ = evidence_decision(evidence)
            duplicate = self._detail_duplicate(uuid, spotify, isrc)
            if duplicate:
                status, reason = "duplicate_existing", "known_or_staged_soundcharts_spotify_or_isrc"
            elif decision:
                status = decision
            else:
                status, reason = "review", "instrumental_or_ai_confirmation_required"
            title = str(obj.get("name") or row["title"] or "") if isinstance(obj, Mapping) else str(row["title"] or "")
            credit = str(obj.get("creditName") or row["credit_name"] or "") if isinstance(obj, Mapping) else str(row["credit_name"] or "")
            release = _date(obj.get("releaseDate")) if isinstance(obj, Mapping) else ""
            self.connection.execute(
                """UPDATE tracks SET spotify_id=?,isrc=?,title=?,credit_name=?,release_date=COALESCE(NULLIF(?,''),release_date),
                   status=?,reason=?,evidence_json=?,attempts=0,error_code=NULL,updated_at=? WHERE soundcharts_uuid=?""",
                (
                    spotify,
                    isrc,
                    title,
                    credit,
                    release,
                    status,
                    reason,
                    json.dumps(evidence, ensure_ascii=False, sort_keys=True),
                    utc_now(),
                    uuid,
                ),
            )
        for uuid, code in errors.items():
            row = by_uuid[uuid]
            if code == "unavailable":
                self.connection.execute(
                    """UPDATE tracks SET status='review',reason='soundcharts_song_detail_unavailable',
                       error_code=?,updated_at=? WHERE soundcharts_uuid=?""",
                    (code, utc_now(), uuid),
                )
                self._record_error("song_detail", uuid, code)
            else:
                self._retry_or_fail("tracks", uuid, int(row["attempts"]), "song_detail", code)
        self.connection.commit()
        return True

    def finalize_detail_candidates(self) -> bool:
        rows = self.connection.execute(
            """SELECT c.soundcharts_uuid,
                      SUM(CASE WHEN t.status='detail_pending' THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS failed
               FROM candidates c LEFT JOIN tracks t ON t.candidate_uuid=c.soundcharts_uuid
               WHERE c.status='details_pending' GROUP BY c.soundcharts_uuid"""
        ).fetchall()
        changed = False
        for row in rows:
            if int(row["pending"] or 0) > 0:
                continue
            if int(row["failed"] or 0) > 0:
                status, reason = "failed", "song_detail_enrichment_failed"
            else:
                status, reason = "review_complete", "instrumental_or_ai_confirmation_required"
            self.connection.execute(
                "UPDATE candidates SET status=?,reason=?,updated_at=? WHERE soundcharts_uuid=?",
                (status, reason, utc_now(), row["soundcharts_uuid"]),
            )
            changed = True
        if changed:
            self.connection.commit()
        return changed

    def run(self) -> str:
        while not self.halt_reason:
            if self.connection.execute("SELECT 1 FROM seeds WHERE status='pending' LIMIT 1").fetchone():
                self.scan_related_batch()
                continue
            if self.scan_identity_batch():
                continue
            if self.scan_audience_batch():
                continue
            if self.scan_activity_batch():
                continue
            if self.scan_catalog_batch():
                continue
            break
        return self.halt_reason or "idle"


def _counts(connection: sqlite3.Connection, table: str, field: str = "status") -> dict[str, int]:
    return {
        str(row[0]): int(row[1])
        for row in connection.execute(f"SELECT {field},COUNT(*) FROM {table} GROUP BY {field} ORDER BY {field}")
    }


def _coverage(expected: int, scanned: int, usable: int) -> dict[str, int]:
    expected = max(0, int(expected))
    scanned = max(0, min(expected, int(scanned)))
    usable = max(0, min(expected, int(usable)))
    return {
        "expected": expected,
        "scanned": scanned,
        "usable": usable,
        "missing": max(0, expected - usable),
    }


def build_coverage_report(connection: sqlite3.Connection) -> dict[str, dict[str, int]]:
    active_seed_where = "soundcharts_uuid NOT IN (SELECT alias_uuid FROM seed_aliases)"
    seed_expected = int(
        connection.execute(f"SELECT COUNT(*) FROM seeds WHERE {active_seed_where}").fetchone()[0]
    )
    seed_scanned = int(
        connection.execute(
            f"""SELECT COUNT(*) FROM seeds WHERE {active_seed_where}
                  AND (status<>'pending' OR related_offset>0 OR attempts>0)"""
        ).fetchone()[0]
    )
    seed_usable = int(
        connection.execute(
            f"SELECT COUNT(*) FROM seeds WHERE {active_seed_where} AND status='complete'"
        ).fetchone()[0]
    )

    candidate_expected = int(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0])
    terminal_placeholders = ",".join("?" for _ in TERMINAL_CANDIDATE_STATUSES)
    terminal_values = tuple(sorted(TERMINAL_CANDIDATE_STATUSES))
    candidate_scanned = int(
        connection.execute(
            f"SELECT COUNT(*) FROM candidates WHERE status IN ({terminal_placeholders}) OR attempts>0",
            terminal_values,
        ).fetchone()[0]
    )
    candidate_usable = int(
        connection.execute(
            f"SELECT COUNT(*) FROM candidates WHERE status IN ({terminal_placeholders}) AND status<>'failed'",
            terminal_values,
        ).fetchone()[0]
    )

    catalogue = connection.execute(
        """SELECT COALESCE(SUM(catalog_total),0),
                  COALESCE(SUM(MIN(catalog_offset,catalog_total)),0)
           FROM candidates WHERE catalog_total IS NOT NULL"""
    ).fetchone()
    catalogue_expected = int(catalogue[0] or 0)
    catalogue_scanned = int(catalogue[1] or 0)
    catalogue_usable = int(
        connection.execute(
            """SELECT COUNT(*) FROM candidate_tracks ct
               JOIN candidates c ON c.soundcharts_uuid=ct.candidate_uuid
               WHERE c.catalog_total IS NOT NULL"""
        ).fetchone()[0]
    )
    resolution_pending = int(
        connection.execute(
            "SELECT COUNT(*) FROM seed_resolution_pending WHERE status='resolution_pending'"
        ).fetchone()[0]
    )
    return {
        "seed_related": _coverage(seed_expected, seed_scanned, seed_usable),
        "candidate_assessment": _coverage(candidate_expected, candidate_scanned, candidate_usable),
        "discography_items": _coverage(catalogue_expected, catalogue_scanned, catalogue_usable),
        "seed_identity_resolution": _coverage(
            seed_expected + resolution_pending,
            seed_expected,
            seed_expected,
        ),
    }


def build_inventory_profile(
    connection: sqlite3.Connection,
    *,
    as_of: dt.date | None = None,
) -> dict[str, Any]:
    """Aggregate the large staging inventory without any external requests."""

    today = as_of or dt.datetime.now(dt.timezone.utc).date()
    cutoff_90 = (today - dt.timedelta(days=90)).isoformat()
    cutoff_1y = (today - dt.timedelta(days=365)).isoformat()
    cutoff_3y = (today - dt.timedelta(days=365 * 3)).isoformat()
    releases = connection.execute(
        """SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN date(release_date) IS NULL THEN 1 ELSE 0 END) AS unknown_date,
             SUM(CASE WHEN date(release_date)>=date(?) THEN 1 ELSE 0 END) AS age_lte_90_days,
             SUM(CASE WHEN date(release_date)>=date(?) AND date(release_date)<date(?) THEN 1 ELSE 0 END) AS age_91_days_to_1_year,
             SUM(CASE WHEN date(release_date)>=date(?) AND date(release_date)<date(?) THEN 1 ELSE 0 END) AS age_1_to_3_years,
             SUM(CASE WHEN date(release_date)<date(?) THEN 1 ELSE 0 END) AS age_over_3_years
           FROM tracks""",
        (cutoff_90, cutoff_1y, cutoff_90, cutoff_3y, cutoff_1y, cutoff_3y),
    ).fetchone()
    catalogues = connection.execute(
        """SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN catalog_total IS NULL THEN 1 ELSE 0 END) AS unknown,
             SUM(CASE WHEN catalog_total=0 THEN 1 ELSE 0 END) AS empty,
             SUM(CASE WHEN catalog_total BETWEEN 1 AND 20 THEN 1 ELSE 0 END) AS size_1_20,
             SUM(CASE WHEN catalog_total BETWEEN 21 AND 50 THEN 1 ELSE 0 END) AS size_21_50,
             SUM(CASE WHEN catalog_total BETWEEN 51 AND 100 THEN 1 ELSE 0 END) AS size_51_100,
             SUM(CASE WHEN catalog_total BETWEEN 101 AND 500 THEN 1 ELSE 0 END) AS size_101_500,
             SUM(CASE WHEN catalog_total BETWEEN 501 AND 1000 THEN 1 ELSE 0 END) AS size_501_1000,
             SUM(CASE WHEN catalog_total>1000 THEN 1 ELSE 0 END) AS size_over_1000,
             MAX(catalog_total) AS max_reported_catalogue
           FROM candidates"""
    ).fetchone()
    max_links = int(
        connection.execute(
            """SELECT COALESCE(MAX(track_count),0) FROM (
                 SELECT COUNT(*) AS track_count FROM candidate_tracks GROUP BY candidate_uuid
               )"""
        ).fetchone()[0]
    )

    release_counts = {key: int(releases[key] or 0) for key in releases.keys()}
    catalogue_counts = {key: int(catalogues[key] or 0) for key in catalogues.keys()}
    classified_release_total = sum(
        release_counts[key]
        for key in (
            "unknown_date",
            "age_lte_90_days",
            "age_91_days_to_1_year",
            "age_1_to_3_years",
            "age_over_3_years",
        )
    )
    if classified_release_total != release_counts["total"]:
        raise FalPhase1Error("Staging release-date distribution is not exhaustive")
    return {
        "release_date_distribution": {
            **release_counts,
            "as_of": today.isoformat(),
            "cutoffs": {
                "90_days": cutoff_90,
                "1_year": cutoff_1y,
                "3_years": cutoff_3y,
            },
            "future_dates_are_in_lte_90_days": True,
        },
        "candidate_catalogue_distribution": {
            **catalogue_counts,
            "max_observed_track_links": max_links,
        },
    }


def build_report(
    connection: sqlite3.Connection,
    *,
    source_eligible: int,
    source_snapshot: Path,
    source_generated_at: str,
    requests_claimed: int = 0,
    quota_remaining: int | None = None,
    halt_reason: str | None = None,
    budget_plan: QuotaBudgetPlan | None = None,
    seed_ledger: Mapping[str, Any] | None = None,
    reconciliation: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    seed_counts = _counts(connection, "seeds")
    candidate_counts = _counts(connection, "candidates")
    track_counts = _counts(connection, "tracks")
    seed_failures = seed_counts.get("failed", 0)
    candidate_failures = candidate_counts.get("failed", 0)
    seed_pending = seed_counts.get("pending", 0)
    candidate_pending = sum(
        count for status, count in candidate_counts.items() if status not in TERMINAL_CANDIDATE_STATUSES
    )
    deferred = 0
    resolution_pending = int(
        connection.execute(
            "SELECT COUNT(*) FROM seed_resolution_pending WHERE status='resolution_pending'"
        ).fetchone()[0]
    )
    complete = (
        seed_pending == 0
        and candidate_pending == 0
        and seed_failures == 0
        and candidate_failures == 0
        and resolution_pending == 0
    )
    if complete:
        status = "complete"
    elif seed_failures or candidate_failures:
        status = "blocked"
    elif resolution_pending and seed_pending == 0 and candidate_pending == 0:
        status = "awaiting_resolution"
    elif requests_claimed or halt_reason:
        status = "partial"
    else:
        status = "ready"
    error_counts = {
        f"{row[0]}:{row[1]}": int(row[2])
        for row in connection.execute("SELECT stage,error_code,COUNT(*) FROM errors GROUP BY stage,error_code ORDER BY stage,error_code")
    }
    no_external_id = int(
        connection.execute("SELECT COUNT(*) FROM tracks WHERE COALESCE(spotify_id,'')='' AND COALESCE(isrc,'')=''").fetchone()[0]
    )
    ledger_coverage = seed_ledger.get("coverage") if isinstance(seed_ledger, Mapping) and isinstance(seed_ledger.get("coverage"), Mapping) else {}
    ledger_alias = seed_ledger.get("alias_dedup") if isinstance(seed_ledger, Mapping) and isinstance(seed_ledger.get("alias_dedup"), Mapping) else {}
    return {
        "version": REPORT_VERSION,
        "generated_at": utc_now(),
        "status": status,
        "complete": complete,
        "staging_only": True,
        "canonical_written": False,
        "source": {
            "snapshot": source_snapshot.name,
            "generated_at": source_generated_at or None,
            "eligible_seed_identities_now": source_eligible,
            "frozen_cohort_hash": meta_get(connection, "cohort_hash"),
            "frozen_at": meta_get(connection, "cohort_frozen_at"),
        },
        "cohort": {
            "frozen_seeds": int(connection.execute("SELECT COUNT(*) FROM seeds").fetchone()[0]),
            "status_counts": seed_counts,
        },
        "seed_ledger": {
            "mode": meta_get(connection, "cohort_mode") or "audited-historical-v1",
            "expected_displayed": finite_int(ledger_coverage.get("expected_displayed")),
            "expected_identity_components": finite_int(ledger_coverage.get("expected_identity_components")),
            "unique_spotify_identities": finite_int(ledger_coverage.get("unique_spotify_identities")),
            "resolved_uuid": finite_int(ledger_coverage.get("resolved_uuid")),
            "resolved_source_uuids": finite_int(ledger_coverage.get("resolved_source_uuids")),
            "resolved_seed_uuids": finite_int(ledger_coverage.get("resolved_seed_uuids")),
            "unresolved": finite_int(ledger_coverage.get("unresolved")),
            "unresolved_display_identities": finite_int(ledger_coverage.get("unresolved_display_identities")),
            "resolution_pending": resolution_pending,
            "cohort_hash": seed_ledger.get("cohort_hash") if isinstance(seed_ledger, Mapping) else None,
            "alias_dedup": dict(ledger_alias),
            "state_uuid_aliases": int(connection.execute("SELECT COUNT(*) FROM seed_aliases").fetchone()[0]),
            "reconciliation": dict(reconciliation or {}),
        },
        "coverage": build_coverage_report(connection),
        "inventory_profile": build_inventory_profile(connection),
        "requests": {
            "claimed_this_run": requests_claimed,
            "quota_remaining": quota_remaining,
            "halt_reason": halt_reason,
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
        "related_graph": {
            "edges": int(connection.execute("SELECT COUNT(*) FROM related_edges").fetchone()[0]),
            "unique_candidates": int(connection.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]),
            "status_counts": candidate_counts,
        },
        "discographies": {
            "mode": "inventory_light",
            "tracks_staged": int(connection.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]),
            "candidate_track_links": int(connection.execute("SELECT COUNT(*) FROM candidate_tracks").fetchone()[0]),
            "track_status_counts": track_counts,
            "tracks_without_spotify_or_isrc": no_external_id,
            "pending_candidates": candidate_pending,
            "deferred_candidates": deferred,
        },
        "safeguards": {
            "new_candidate_monthly_listeners": {"minimum": DEFAULT_CANDIDATE_MIN_AUDIENCE, "maximum": None},
            "recent_activity_days": DEFAULT_RECENT_DAYS,
            "instrumental_unknown": "review",
            "ai_unknown": "review",
            "explicit_vocal": "blocked",
            "explicit_out_of_taxonomy": "blocked",
            "explicit_ai_high": "blocked",
            "reviewed_artist_blacklist": "blocked",
            "deduplication": {
                "soundcharts_uuid": "always",
                "spotify_id": "when_present_in_phase1_source",
                "isrc": "when_present_in_phase1_source",
                "missing_track_identifiers": "deferred_to_phase2",
            },
            "track_metadata_enrichment": "deferred_to_phase2",
            "lyrics_and_ai_unknown": "review_metadata_pending",
            "publication": "disabled",
        },
        "errors": error_counts,
    }


def write_report(path: Path, report: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-snapshot", type=Path, default=DEFAULT_SEED_SNAPSHOT)
    parser.add_argument(
        "--seed-ledger",
        type=Path,
        help="versioned canonical/accepted seed ledger; extends an existing checkpoint append-only",
    )
    parser.add_argument(
        "--active-snapshot",
        type=Path,
        help="currently active strict Soundcharts snapshot, used only for duplicate detection",
    )
    parser.add_argument("--browse-catalogue", "--browse-snapshot", dest="browse_catalogue", type=Path, default=DEFAULT_BROWSE_SNAPSHOT)
    parser.add_argument("--performance", type=Path, default=DEFAULT_PERFORMANCE_SNAPSHOT)
    parser.add_argument("--legacy-snapshot", type=Path, default=DEFAULT_LEGACY_SNAPSHOT)
    parser.add_argument("--radar-snapshot", type=Path, default=DEFAULT_RADAR_SNAPSHOT)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--max-seeds", type=int, default=DEFAULT_MAX_SEEDS)
    parser.add_argument("--min-seed-guard", type=int, default=DEFAULT_MIN_SEED_GUARD)
    parser.add_argument("--max-seed-guard", type=int, default=DEFAULT_MAX_SEED_GUARD)
    parser.add_argument("--seed-min-audience", type=int, default=DEFAULT_SEED_MIN_AUDIENCE)
    parser.add_argument("--candidate-min-audience", type=int, default=DEFAULT_CANDIDATE_MIN_AUDIENCE)
    parser.add_argument("--recent-days", type=int, default=DEFAULT_RECENT_DAYS)
    parser.add_argument("--related-limit", type=int, default=50)
    parser.add_argument("--catalog-page-size", type=int, default=100)
    parser.add_argument("--max-related-artists", type=int)
    parser.add_argument("--max-requests", type=int, default=1_400)
    parser.add_argument("--quota-reserve", type=int, default=500_000)
    parser.add_argument(
        "--maintenance-through",
        help=(
            "inclusive maintenance protection cutoff/reset date (YYYY-MM-DD); "
            "defaults to the next monthly 18th at 19:11 UTC"
        ),
    )
    parser.add_argument(
        "--maintenance-daily-requests",
        type=int,
        default=DEFAULT_MAINTENANCE_DAILY_REQUESTS,
    )
    parser.add_argument("--budget-as-of", help=argparse.SUPPRESS)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--retry-limit", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true", help="inspect/sync state and report without Soundcharts auth")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    soundcharts = read_js_payload(args.seed_snapshot, SOUNDCHARTS_PREFIX)
    active = read_js_payload(args.active_snapshot, SOUNDCHARTS_PREFIX) if args.active_snapshot and args.active_snapshot.exists() else None
    browse = read_generic_js(args.browse_catalogue) if args.browse_catalogue.exists() else None
    try:
        performance = read_performance_payload(args.performance) if args.performance.exists() else None
    except PerformanceStoreError as exc:
        raise FalPhase1Error(str(exc)) from exc
    legacy = read_js_payload(args.legacy_snapshot, SOUNDCHARTS_PREFIX) if args.legacy_snapshot.exists() else None
    radar = read_generic_js(args.radar_snapshot) if args.radar_snapshot.exists() else None
    ledger: dict[str, Any] | None = None
    resolution_pending: list[dict[str, Any]] = []
    if args.seed_ledger:
        seeds, resolution_pending, ledger = read_seed_ledger(
            args.seed_ledger,
            min_resolved=max(0, args.min_seed_guard),
            max_resolved=max(args.min_seed_guard, args.max_seed_guard),
        )
        source_eligible = len(seeds)
        source_path = args.seed_ledger
        source_generated_at = str(ledger.get("generated_at") or "")
    else:
        seeds, source_eligible = extract_seed_cohort(
            soundcharts,
            max_seeds=max(0, args.max_seeds),
            min_audience=max(0, args.seed_min_audience),
        )
        source_path = args.seed_snapshot
        source_generated_at = str(soundcharts.get("generated_at") or "")
    if source_eligible < max(0, args.min_seed_guard) or source_eligible > max(args.min_seed_guard, args.max_seed_guard):
        raise FalPhase1Error(
            f"Active seed cohort failed the truncation guard ({source_eligible}; expected {args.min_seed_guard}-{args.max_seed_guard})"
        )
    if not seeds:
        raise FalPhase1Error("Active seed cohort is empty")
    known = build_known_identities(soundcharts, browse, radar, performance, legacy)
    if active is not None:
        known = merge_known_identities(
            known,
            build_known_identities(active, browse, radar, performance, legacy),
        )
    connection = open_state(args.state)
    reconciliation: dict[str, Any] | None = None
    if ledger is not None:
        reconciliation = reconcile_seed_ledger(connection, seeds, resolution_pending, ledger)
    else:
        freeze_seed_cohort(
            connection,
            seeds,
            source_eligible=source_eligible,
            snapshot_name=args.seed_snapshot.name,
            snapshot_generated_at=source_generated_at,
        )
    if args.dry_run:
        report = build_report(
            connection,
            source_eligible=source_eligible,
            source_snapshot=source_path,
            source_generated_at=source_generated_at,
            seed_ledger=ledger,
            reconciliation=reconciliation,
        )
        write_report(args.report, report)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        connection.close()
        return 0

    hard_reserve = max(HARD_MIN_QUOTA_RESERVE, int(args.quota_reserve))
    client = SoundchartsClient(
        __import__("os").environ.get("SOUNDCHARTS_CLIENT_ID", ""),
        __import__("os").environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
        __import__("os").environ.get("SOUNDCHARTS_TEAM_ID", ""),
        quota_reserve=hard_reserve,
        request_limit=None,
    )
    client.authenticate()
    client.require_quota_reserve()
    budget_plan = plan_quota_budget(
        quota_remaining=getattr(client, "quota_remaining", None),
        requested=max(0, args.max_requests),
        maintenance_daily_requests=max(0, args.maintenance_daily_requests),
        maintenance_through=args.maintenance_through,
        as_of=args.budget_as_of,
        hard_reserve=hard_reserve,
    )
    client.request_limit = budget_plan.allowed
    # Enforce the dynamic floor on every concurrent request, not just during
    # preflight, in case server-side quota changes unexpectedly during a run.
    client.quota_reserve = budget_plan.protected_floor
    if budget_plan.allowed <= 0:
        report = build_report(
            connection,
            source_eligible=source_eligible,
            source_snapshot=source_path,
            source_generated_at=source_generated_at,
            quota_remaining=getattr(client, "quota_remaining", None),
            halt_reason="maintenance_quota_protected",
            budget_plan=budget_plan,
            seed_ledger=ledger,
            reconciliation=reconciliation,
        )
        write_report(args.report, report)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
        connection.close()
        return 0
    client.require_quota_reserve()
    requeue_failed_work(connection)
    scanner = Phase1Scanner(
        connection,
        client,
        known,
        workers=max(1, args.workers),
        related_limit=max(1, min(100, args.related_limit)),
        catalog_page_size=max(1, min(100, args.catalog_page_size)),
        min_audience=max(0, args.candidate_min_audience),
        recent_days=max(1, args.recent_days),
        retry_limit=max(1, args.retry_limit),
        max_related_artists=args.max_related_artists,
    )
    halt_reason = scanner.run()
    report = build_report(
        connection,
        source_eligible=source_eligible,
        source_snapshot=source_path,
        source_generated_at=source_generated_at,
        requests_claimed=int(getattr(client, "requests_claimed", 0)),
        quota_remaining=getattr(client, "quota_remaining", None),
        halt_reason=None if halt_reason == "idle" else halt_reason,
        budget_plan=budget_plan,
        seed_ledger=ledger,
        reconciliation=reconciliation,
    )
    write_report(args.report, report)
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
