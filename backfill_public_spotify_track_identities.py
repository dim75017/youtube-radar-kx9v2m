#!/usr/bin/env python3
"""Backfill exact Soundcharts identities for public Spotify tracks.

The public browse catalogue contains a protected internal cohort whose exact
Spotify track IDs are known but whose Soundcharts song UUIDs are not.  This
collector resolves those identities without promoting or rewriting any
canonical catalogue:

1. reuse exact Spotify-artist -> Soundcharts-artist pairs already present in
   the licensed snapshot or the performance store;
2. enumerate the corresponding Soundcharts artist discographies;
3. use title equality only to shortlist song UUIDs;
4. accept a track mapping only when Soundcharts returns the exact 22-character
   Spotify ID either in the discography row or in a numeric Spotify audience
   plot for that song UUID.

State is resumable SQLite.  By default the script writes only the private
state and a JSON report.  ``--apply-performance`` may add resolved identities
and their source-backed histories to ``Spotify_Performance_data.js``.  It
never writes ``Spotify_Soundcharts_data.js`` or
``Spotify_Browse_Catalogue_data.js``.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import re
import sqlite3
import unicodedata
import urllib.parse
import uuid as uuid_module
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from backfill_soundcharts_fal_spotify_ids import extract_spotify_plot_candidates
from discover_soundcharts_playlists import parse_artist_metadata
from refresh_soundcharts_daily import (
    SoundchartsClient,
    SoundchartsDataUnavailableError,
    SoundchartsError,
    SoundchartsQuotaReserveError,
    SoundchartsRequestLimitError,
    extract_song_audience_points,
    field,
    merge_history,
    read_js_payload,
    read_performance_payload,
    utc_now,
    write_performance_payload,
)
from scan_soundcharts_fal_phase1 import (
    FalPhase1Error,
    _list_items as list_catalogue_items,
    parse_catalogue_page as parse_fal_catalogue_page,
)


STATE_VERSION = 1
DEFAULT_STATE = Path("soundcharts-public-track-identity-backfill-v1.sqlite3")
DEFAULT_REPORT = Path("soundcharts-public-track-identity-backfill-report-v1.json")
DEFAULT_BROWSE = Path("Spotify_Browse_Catalogue_data.js")
DEFAULT_SOUNDCHARTS = Path("Spotify_Soundcharts_data.js")
DEFAULT_PERFORMANCE = Path("Spotify_Performance_data.js")
DEFAULT_MAX_REQUESTS = 20_000
ABSOLUTE_MAX_REQUESTS = 22_000
MIN_QUOTA_RESERVE = 1_400_000
DEFAULT_WORKERS = 10
MAX_WORKERS = 10
DEFAULT_HISTORY_DAYS = 90
DEFAULT_PAGE_SIZE = 100
MAX_RETRIES = 2
AUTHORITATIVE_ARTIST_IDENTITY_SOURCES = {
    "soundcharts_snapshot",
    "performance_artist",
}
SPOTIFY_ID_RE = re.compile(r"[A-Za-z0-9]{22}")
SPOTIFY_TRACK_URI_RE = re.compile(r"spotify:track:([A-Za-z0-9]{22})(?:$|[?#])", re.IGNORECASE)
SPOTIFY_TRACK_URL_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-[^/]+/)?track/([A-Za-z0-9]{22})(?:$|[/?#])",
    re.IGNORECASE,
)
BROWSE_PREFIX = "window.SPOTIFY_BROWSE_CATALOGUE="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="


STATE_SQL = """
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  spotify_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  release_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  soundcharts_uuid TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  history_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id TEXT
);

CREATE TABLE IF NOT EXISTS artists (
  spotify_id TEXT PRIMARY KEY,
  soundcharts_uuid TEXT,
  identity_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'identity_pending',
  next_offset INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  updated_at TEXT NOT NULL,
  last_run_id TEXT
);

CREATE TABLE IF NOT EXISTS target_artists (
  target_spotify_id TEXT NOT NULL,
  artist_spotify_id TEXT NOT NULL,
  PRIMARY KEY(target_spotify_id, artist_spotify_id),
  FOREIGN KEY(target_spotify_id) REFERENCES targets(spotify_id),
  FOREIGN KEY(artist_spotify_id) REFERENCES artists(spotify_id)
);

CREATE TABLE IF NOT EXISTS candidates (
  target_spotify_id TEXT NOT NULL,
  soundcharts_uuid TEXT NOT NULL,
  artist_soundcharts_uuid TEXT NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  source_release_date TEXT NOT NULL DEFAULT '',
  exact_discography_identifier INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  history_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  updated_at TEXT NOT NULL,
  last_run_id TEXT,
  PRIMARY KEY(target_spotify_id, soundcharts_uuid),
  FOREIGN KEY(target_spotify_id) REFERENCES targets(spotify_id)
);

CREATE INDEX IF NOT EXISTS idx_public_identity_targets_status
  ON targets(status, spotify_id);
CREATE INDEX IF NOT EXISTS idx_public_identity_artists_status
  ON artists(status, spotify_id);
CREATE INDEX IF NOT EXISTS idx_public_identity_candidates_status
  ON candidates(status, soundcharts_uuid, target_spotify_id);
"""


class PublicIdentityBackfillError(RuntimeError):
    """Fail-closed error for the public performance identity backfill."""


def exact_spotify_id(value: Any) -> str:
    raw = str(value or "").strip()
    return raw if SPOTIFY_ID_RE.fullmatch(raw) else ""


def normalize_title(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(text.split())


def _primitive_identifier(value: Any) -> Any:
    if not isinstance(value, Mapping):
        return value
    return value.get("value") or value.get("identifier") or value.get("id")


def _spotify_track_id_from_uri_or_url(value: Any) -> str:
    raw = str(value or "").strip()
    exact = exact_spotify_id(raw)
    if exact:
        return exact
    for pattern in (SPOTIFY_TRACK_URI_RE, SPOTIFY_TRACK_URL_RE):
        match = pattern.fullmatch(raw)
        if match:
            return match.group(1)
    return ""


def extract_song_spotify_id(song: Any) -> str:
    """Extract only a Spotify *track* ID from a Soundcharts song object.

    Soundcharts song payloads can contain nested artist objects with their own
    Spotify IDs.  Generic recursive identifier walkers therefore risk binding
    an artist ID to a track.  This parser reads only root song-ID fields and
    explicit song identity/link containers, skips every artist/performer
    branch, accepts Spotify track URLs/URIs only, and fails closed when more
    than one exact track ID is present.
    """

    if not isinstance(song, Mapping):
        return ""
    candidates: set[str] = set()

    def normalized_key(value: Any) -> str:
        return re.sub(r"[^a-z0-9_]", "", str(value or "").casefold())

    def is_artist_identity(value: Any) -> bool:
        if not isinstance(value, Mapping):
            return False
        entity = normalized_key(
            value.get("entityType")
            or value.get("entity_type")
            or value.get("objectType")
            or value.get("object_type")
            or value.get("entity")
            or value.get("kind")
            or value.get("role")
            or value.get("type")
        )
        return "artist" in entity or "performer" in entity

    for key in ("spotify_id", "spotifyId"):
        raw_identity = song.get(key)
        candidate = (
            ""
            if is_artist_identity(raw_identity)
            else _spotify_track_id_from_uri_or_url(
                _primitive_identifier(raw_identity)
            )
        )
        if candidate:
            candidates.add(candidate)
    for key in ("spotify_url", "spotifyUrl", "spotify_uri", "spotifyUri"):
        candidate = _spotify_track_id_from_uri_or_url(song.get(key))
        if candidate:
            candidates.add(candidate)

    allowed_roots = {
        "identifiers",
        "externalids",
        "external_ids",
        "platformidentifiers",
        "platform_identifiers",
        "platforms",
        "streaminglinks",
        "streaming_links",
        "links",
        "urls",
    }
    blocked_tokens = {
        "artist",
        "artists",
        "performer",
        "performers",
        "credit",
        "credits",
        "mainartist",
        "featuredartist",
        "featuredartists",
    }

    def visit(value: Any, hint: str = "") -> None:
        if isinstance(value, Mapping):
            if is_artist_identity(value):
                return
            platform = normalized_key(
                value.get("platform")
                or value.get("platformCode")
                or value.get("platform_code")
                or value.get("service")
                or value.get("provider")
            )
            identifier = _primitive_identifier(
                value.get("identifier") or value.get("value") or value.get("id")
            )
            if "spotify" in platform:
                candidate = _spotify_track_id_from_uri_or_url(identifier)
                if candidate:
                    candidates.add(candidate)
            for raw_key, nested in value.items():
                key = normalized_key(raw_key)
                if key in blocked_tokens or "artist" in key or "performer" in key:
                    continue
                if "spotify" in key and not is_artist_identity(nested):
                    candidate = _spotify_track_id_from_uri_or_url(
                        _primitive_identifier(nested)
                    )
                    if candidate:
                        candidates.add(candidate)
                if key in allowed_roots or hint in allowed_roots:
                    visit(nested, key)
        elif isinstance(value, (list, tuple)):
            for nested in value:
                visit(nested, hint)
        elif isinstance(value, str) and "spotify" in hint:
            candidate = _spotify_track_id_from_uri_or_url(value)
            if candidate:
                candidates.add(candidate)

    for raw_key, value in song.items():
        key = normalized_key(raw_key)
        if key in allowed_roots:
            visit(value, key)
    return next(iter(candidates)) if len(candidates) == 1 else ""


def parse_public_catalogue_page(
    response: Any,
    *,
    artist_uuid: str,
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int | None, int | None]:
    """Use the proven page contract but replace its generic ID traversal."""

    tracks, total, next_offset = parse_fal_catalogue_page(
        response,
        artist_uuid=artist_uuid,
        offset=offset,
        limit=limit,
    )
    raw_items = list_catalogue_items(response)
    if len(raw_items) != len(tracks):
        raise FalPhase1Error("Soundcharts song page could not preserve row identity")
    for track, raw in zip(tracks, raw_items):
        song = raw.get("song") if isinstance(raw.get("song"), Mapping) else raw
        track["spotify_id"] = extract_song_spotify_id(song)
    return tracks, total, next_offset


def safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def open_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.exists() and path.stat().st_size > 0
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        if existing:
            quick_check = connection.execute("PRAGMA quick_check").fetchone()
            if not quick_check or str(quick_check[0]).lower() != "ok":
                raise PublicIdentityBackfillError(
                    "Restored public identity checkpoint failed quick_check"
                )
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(STATE_SQL)
        quick_check = connection.execute("PRAGMA quick_check").fetchone()
        if not quick_check or str(quick_check[0]).lower() != "ok":
            raise PublicIdentityBackfillError(
                "Public identity checkpoint failed quick_check after schema validation"
            )
    except PublicIdentityBackfillError:
        if connection is not None:
            connection.close()
        raise
    except (sqlite3.DatabaseError, OSError) as exc:
        if connection is not None:
            try:
                connection.close()
            except sqlite3.Error:
                pass
        raise PublicIdentityBackfillError(
            "Public identity checkpoint is corrupt or unreadable"
        ) from exc
    row = connection.execute("SELECT value FROM metadata WHERE key='state_version'").fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO metadata(key,value) VALUES('state_version',?)", (str(STATE_VERSION),)
        )
    elif str(row["value"]) != str(STATE_VERSION):
        raise PublicIdentityBackfillError(
            f"Unsupported public identity state version {row['value']}"
        )
    connection.commit()
    return connection


def _rows(payload: Mapping[str, Any], group: str) -> tuple[list[str], list[list[Any]]]:
    schemas = payload.get("schemas")
    schema = schemas.get(group) if isinstance(schemas, Mapping) else None
    rows = payload.get(group)
    if not isinstance(schema, list) or not isinstance(rows, list):
        return [], []
    return schema, [row for row in rows if isinstance(row, list)]


def _browse_catalogue(payload: Mapping[str, Any]) -> tuple[list[str], list[list[Any]], list[str], list[list[Any]]]:
    discovery = payload.get("discovery_catalogue")
    if not isinstance(discovery, Mapping):
        raise PublicIdentityBackfillError("Browse catalogue has no discovery_catalogue")
    track_schema = discovery.get("track_schema")
    track_rows = discovery.get("tracks")
    artist_schema = discovery.get("artist_schema")
    artist_rows = discovery.get("artists")
    if not isinstance(track_schema, list) or not isinstance(track_rows, list):
        raise PublicIdentityBackfillError("Browse catalogue has no valid track table")
    if not isinstance(artist_schema, list) or not isinstance(artist_rows, list):
        raise PublicIdentityBackfillError("Browse catalogue has no valid artist table")
    return (
        track_schema,
        [row for row in track_rows if isinstance(row, list)],
        artist_schema,
        [row for row in artist_rows if isinstance(row, list)],
    )


def _add_identity(
    destination: dict[str, set[str]], spotify_id: Any, soundcharts_uuid: Any
) -> None:
    spotify = exact_spotify_id(spotify_id)
    uuid = str(soundcharts_uuid or "").strip()
    if spotify and uuid:
        destination.setdefault(spotify, set()).add(uuid)


def build_artist_identity_map(
    browse: Mapping[str, Any],
    soundcharts: Mapping[str, Any],
    performance_summary: Mapping[str, Any],
) -> tuple[dict[str, tuple[str, str]], dict[str, dict[str, list[str]]]]:
    """Return exact artist mappings with current sources taking precedence.

    The current licensed snapshot and performance store are authoritative.  A
    disagreement between those two sources is blocked.  Browse-only mappings
    are accepted only when unique and no authoritative source exists.
    """

    strict: dict[str, set[str]] = {}
    performance: dict[str, set[str]] = {}
    browse_pairs: dict[str, set[str]] = {}

    soundcharts_schema, soundcharts_rows = _rows(soundcharts, "artists")
    for row in soundcharts_rows:
        _add_identity(
            strict,
            field(row, soundcharts_schema, "spotify_id"),
            field(row, soundcharts_schema, "soundcharts_uuid"),
        )

    for spotify_id, entry in (performance_summary.get("artists") or {}).items():
        if isinstance(entry, Mapping):
            _add_identity(performance, spotify_id, entry.get("soundcharts_uuid"))

    _, _, browse_artist_schema, browse_artist_rows = _browse_catalogue(browse)
    for row in browse_artist_rows:
        _add_identity(
            browse_pairs,
            field(row, browse_artist_schema, "spotify_id"),
            field(row, browse_artist_schema, "soundcharts_uuid"),
        )

    resolved: dict[str, tuple[str, str]] = {}
    conflicts: dict[str, dict[str, list[str]]] = {}
    for spotify_id in sorted(set(strict) | set(performance) | set(browse_pairs)):
        strict_values = strict.get(spotify_id, set())
        performance_values = performance.get(spotify_id, set())
        authoritative = strict_values | performance_values
        if len(authoritative) == 1:
            source = "soundcharts_snapshot" if strict_values else "performance_artist"
            resolved[spotify_id] = (next(iter(authoritative)), source)
            continue
        if len(authoritative) > 1:
            conflicts[spotify_id] = {
                "soundcharts_snapshot": sorted(strict_values),
                "performance_artist": sorted(performance_values),
                "browse_artist": sorted(browse_pairs.get(spotify_id, set())),
            }
            continue
        browse_values = browse_pairs.get(spotify_id, set())
        if len(browse_values) == 1:
            resolved[spotify_id] = (next(iter(browse_values)), "browse_artist")
        elif len(browse_values) > 1:
            conflicts[spotify_id] = {
                "soundcharts_snapshot": [],
                "performance_artist": [],
                "browse_artist": sorted(browse_values),
            }
    return resolved, conflicts


def _performance_track_uuid(performance_summary: Mapping[str, Any], spotify_id: str) -> str:
    tracks = performance_summary.get("tracks")
    entry = tracks.get(spotify_id) if isinstance(tracks, Mapping) else None
    return str(entry.get("soundcharts_uuid") or "").strip() if isinstance(entry, Mapping) else ""


def normalize_exhausted_artist_retries(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    now: str | None = None,
) -> dict[str, int]:
    timestamp = now or utc_now()
    identity = connection.execute(
        """UPDATE artists SET status='identity_unavailable',
                  error_code=COALESCE(NULLIF(error_code,''),'identity_retry_budget_exhausted'),
                  updated_at=?,last_run_id=?
             WHERE status IN ('identity_pending','identity_retry') AND attempts>=?""",
        (timestamp, run_id, MAX_RETRIES),
    ).rowcount
    catalogue = connection.execute(
        """UPDATE artists SET status='catalogue_unavailable',
                  error_code=COALESCE(NULLIF(error_code,''),'catalogue_retry_budget_exhausted'),
                  updated_at=?,last_run_id=?
             WHERE status IN ('catalogue_pending','catalogue_retry') AND attempts>=?""",
        (timestamp, run_id, MAX_RETRIES),
    ).rowcount
    return {"identity_unavailable": identity, "catalogue_unavailable": catalogue}


def seed_state(
    connection: sqlite3.Connection,
    browse: Mapping[str, Any],
    soundcharts: Mapping[str, Any],
    performance_summary: Mapping[str, Any],
    *,
    run_id: str,
) -> dict[str, int]:
    track_schema, track_rows, _, _ = _browse_catalogue(browse)
    artist_map, artist_conflicts = build_artist_identity_map(
        browse, soundcharts, performance_summary
    )
    now = utc_now()
    seeded = 0
    skipped_mapped = 0
    invalid_track_ids = 0
    no_artist_identity = 0
    artist_ids: set[str] = set()

    for row in track_rows:
        spotify_id = exact_spotify_id(field(row, track_schema, "spotify_id"))
        if not spotify_id:
            invalid_track_ids += 1
            continue
        browse_uuid = str(field(row, track_schema, "soundcharts_uuid") or "").strip()
        performance_uuid = _performance_track_uuid(performance_summary, spotify_id)
        if browse_uuid or performance_uuid:
            skipped_mapped += 1
            existing = connection.execute(
                "SELECT 1 FROM targets WHERE spotify_id=?", (spotify_id,)
            ).fetchone()
            if existing:
                connection.execute(
                    """UPDATE targets SET status='resolved_existing',
                              soundcharts_uuid=?,updated_at=?,last_run_id=?
                         WHERE spotify_id=?""",
                    (browse_uuid or performance_uuid, now, run_id, spotify_id),
                )
            continue

        title = str(field(row, track_schema, "title") or "").strip()
        release_date = str(field(row, track_schema, "release_date") or "")[:10]
        target_existed = connection.execute(
            "SELECT 1 FROM targets WHERE spotify_id=?", (spotify_id,)
        ).fetchone() is not None
        connection.execute(
            """INSERT INTO targets(
                   spotify_id,title,normalized_title,release_date,status,
                   first_seen_at,updated_at,last_run_id)
                 VALUES(?,?,?,?,?,?,?,?)
                 ON CONFLICT(spotify_id) DO UPDATE SET
                   title=excluded.title,normalized_title=excluded.normalized_title,
                   release_date=excluded.release_date,updated_at=excluded.updated_at,
                   last_run_id=excluded.last_run_id""",
            (
                spotify_id,
                title,
                normalize_title(title),
                release_date,
                "pending",
                now,
                now,
                run_id,
            ),
        )
        seeded += 1
        raw_artists = field(row, track_schema, "artists")
        row_artist_ids = {
            exact_spotify_id(artist.get("spotify_id"))
            for artist in (raw_artists if isinstance(raw_artists, list) else [])
            if isinstance(artist, Mapping)
        }
        row_artist_ids.discard("")
        if not row_artist_ids:
            connection.execute(
                """UPDATE targets SET status='no_artist_identity',
                          error_code='public_artist_spotify_id_missing',updated_at=?
                     WHERE spotify_id=?""",
                (now, spotify_id),
            )
            no_artist_identity += 1
            continue

        connection.execute(
            """UPDATE targets SET status='pending',error_code=NULL,updated_at=?,last_run_id=?
                 WHERE spotify_id=? AND status IN (
                   'no_artist_identity','artist_catalogue_unavailable')""",
            (now, run_id, spotify_id),
        )

        for artist_spotify_id in sorted(row_artist_ids):
            artist_ids.add(artist_spotify_id)
            resolved = artist_map.get(artist_spotify_id)
            conflict = artist_conflicts.get(artist_spotify_id)
            existing_artist = connection.execute(
                "SELECT * FROM artists WHERE spotify_id=?", (artist_spotify_id,)
            ).fetchone()
            if resolved:
                artist_uuid, source = resolved
                status = "catalogue_pending"
                error_code = None
            elif conflict:
                artist_uuid, source = "", ""
                status = "identity_conflict"
                error_code = "authoritative_artist_uuid_conflict"
            else:
                artist_uuid, source = "", ""
                status = "identity_pending"
                error_code = None
            authoritative_refresh = bool(
                existing_artist
                and resolved
                and source in AUTHORITATIVE_ARTIST_IDENTITY_SOURCES
                and (
                    str(existing_artist["soundcharts_uuid"] or "").strip()
                    != artist_uuid
                    or str(existing_artist["identity_source"] or "").strip()
                    not in AUTHORITATIVE_ARTIST_IDENTITY_SOURCES
                )
            )
            connection.execute(
                """INSERT INTO artists(
                       spotify_id,soundcharts_uuid,identity_source,status,error_code,
                       updated_at,last_run_id)
                     VALUES(?,?,?,?,?,?,?)
                     ON CONFLICT(spotify_id) DO UPDATE SET
                       soundcharts_uuid=CASE
                         WHEN excluded.soundcharts_uuid<>'' THEN excluded.soundcharts_uuid
                         ELSE artists.soundcharts_uuid END,
                       identity_source=CASE
                         WHEN excluded.identity_source<>'' THEN excluded.identity_source
                         ELSE artists.identity_source END,
                       status=CASE
                         WHEN artists.status IN (
                           'catalogue_complete','identity_conflict',
                           'identity_unavailable','catalogue_unavailable'
                         ) OR artists.attempts>=? THEN artists.status
                         ELSE excluded.status END,
                       error_code=CASE
                         WHEN artists.status IN (
                           'identity_conflict','identity_unavailable','catalogue_unavailable'
                         ) OR artists.attempts>=? THEN artists.error_code
                         ELSE excluded.error_code END,
                       updated_at=excluded.updated_at,
                       last_run_id=excluded.last_run_id""",
                (
                    artist_spotify_id,
                    artist_uuid,
                    source,
                    status,
                    error_code,
                    now,
                    run_id,
                    MAX_RETRIES,
                    MAX_RETRIES,
                ),
            )
            if authoritative_refresh:
                previous_uuid = str(
                    existing_artist["soundcharts_uuid"] or ""
                ).strip()
                if previous_uuid and previous_uuid != artist_uuid:
                    connection.execute(
                        """DELETE FROM candidates
                            WHERE artist_soundcharts_uuid=?
                              AND target_spotify_id IN (
                                SELECT target_spotify_id FROM target_artists
                                 WHERE artist_spotify_id=?
                              )""",
                        (previous_uuid, artist_spotify_id),
                    )
                connection.execute(
                    """UPDATE artists SET soundcharts_uuid=?,identity_source=?,
                              status='catalogue_pending',next_offset=0,total=NULL,
                              attempts=0,error_code=NULL,updated_at=?,last_run_id=?
                         WHERE spotify_id=?""",
                    (artist_uuid, source, now, run_id, artist_spotify_id),
                )
            if not target_existed:
                # A newly visible track may belong to an artist whose previous
                # discography cursor was already complete. Re-read that
                # artist from offset zero so the new release can be resolved.
                connection.execute(
                    """UPDATE artists SET status='catalogue_pending',next_offset=0,
                              total=NULL,error_code=NULL,updated_at=?,last_run_id=?
                         WHERE spotify_id=? AND soundcharts_uuid IS NOT NULL
                           AND trim(soundcharts_uuid)<>''
                           AND status='catalogue_complete'""",
                    (now, run_id, artist_spotify_id),
                )
            connection.execute(
                """INSERT OR IGNORE INTO target_artists(
                       target_spotify_id,artist_spotify_id) VALUES(?,?)""",
                (spotify_id, artist_spotify_id),
            )
            if authoritative_refresh:
                connection.execute(
                    """UPDATE targets SET status='pending',soundcharts_uuid=NULL,
                              evidence_json='{}',history_json='[]',error_code=NULL,
                              updated_at=?,last_run_id=?
                         WHERE status NOT IN ('resolved','resolved_existing')
                           AND spotify_id IN (
                             SELECT target_spotify_id FROM target_artists
                              WHERE artist_spotify_id=?
                           )""",
                    (now, run_id, artist_spotify_id),
                )

    normalize_exhausted_artist_retries(connection, run_id=run_id, now=now)
    connection.commit()
    return {
        "seeded_targets": seeded,
        "skipped_already_mapped": skipped_mapped,
        "invalid_track_ids": invalid_track_ids,
        "targets_without_artist_identity": no_artist_identity,
        "target_artist_ids": len(artist_ids),
        "artist_identity_conflicts": len(artist_conflicts.keys() & artist_ids),
    }


def _fetch_one(client: Any, key: str, path: str) -> tuple[str, Any | None, str | None]:
    try:
        return key, client.get(path), None
    except SoundchartsRequestLimitError:
        return key, None, "request_limit"
    except SoundchartsQuotaReserveError:
        return key, None, "quota_reserve"
    except SoundchartsDataUnavailableError:
        return key, None, "unavailable"
    except (SoundchartsError, OSError, RuntimeError, FalPhase1Error):
        return key, None, "request_failed"


def _parallel_fetch(
    client: Any,
    tasks: Sequence[tuple[str, str]],
    *,
    workers: int,
) -> list[tuple[str, Any | None, str | None]]:
    if not tasks:
        return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(_fetch_one, client, key, path) for key, path in tasks]
        return [future.result() for future in concurrent.futures.as_completed(futures)]


def resolve_artist_identities(
    connection: sqlite3.Connection,
    client: Any,
    *,
    workers: int,
    run_id: str,
) -> tuple[int, str]:
    now = utc_now()
    normalize_exhausted_artist_retries(
        connection, run_id=run_id, now=now
    )
    connection.commit()
    rows = connection.execute(
        """SELECT * FROM artists
            WHERE status IN ('identity_pending','identity_retry') AND attempts<?
            ORDER BY spotify_id""",
        (MAX_RETRIES,),
    ).fetchall()
    tasks = [
        (
            str(row["spotify_id"]),
            "/api/v2.9/artist/by-platform/spotify/"
            + urllib.parse.quote(str(row["spotify_id"])),
        )
        for row in rows
    ]
    resolved = 0
    halt_reason = ""
    for spotify_id, response, error in _parallel_fetch(client, tasks, workers=workers):
        if error in {"request_limit", "quota_reserve"}:
            halt_reason = error
            continue
        if error:
            connection.execute(
                """UPDATE artists SET status=CASE
                            WHEN attempts+1>=? THEN 'identity_unavailable'
                            ELSE 'identity_retry' END,
                          attempts=attempts+1,
                          error_code=?,updated_at=?,last_run_id=? WHERE spotify_id=?""",
                (MAX_RETRIES, error, now, run_id, spotify_id),
            )
            continue
        parsed = parse_artist_metadata(response, spotify_id)
        if not parsed or not str(parsed.get("soundcharts_uuid") or "").strip():
            connection.execute(
                """UPDATE artists SET status='identity_unavailable',attempts=attempts+1,
                          error_code='exact_soundcharts_artist_uuid_missing',updated_at=?,
                          last_run_id=? WHERE spotify_id=?""",
                (now, run_id, spotify_id),
            )
            continue
        connection.execute(
            """UPDATE artists SET soundcharts_uuid=?,identity_source='soundcharts_artist_by_platform',
                      status='catalogue_pending',attempts=0,error_code=NULL,updated_at=?,
                      last_run_id=? WHERE spotify_id=?""",
            (parsed["soundcharts_uuid"], now, run_id, spotify_id),
        )
        resolved += 1
    connection.commit()
    return resolved, halt_reason


def _target_rows_for_artist(
    connection: sqlite3.Connection, artist_spotify_id: str
) -> list[sqlite3.Row]:
    return connection.execute(
        """SELECT t.* FROM targets AS t
             JOIN target_artists AS ta ON ta.target_spotify_id=t.spotify_id
            WHERE ta.artist_spotify_id=?
              AND t.status NOT IN ('resolved','resolved_existing','ambiguous')
            ORDER BY t.spotify_id""",
        (artist_spotify_id,),
    ).fetchall()


def integrate_catalogue_page(
    connection: sqlite3.Connection,
    artist_row: sqlite3.Row,
    response: Any,
    *,
    page_size: int,
    run_id: str,
) -> tuple[int, bool]:
    artist_spotify_id = str(artist_row["spotify_id"])
    artist_uuid = str(artist_row["soundcharts_uuid"] or "").strip()
    offset = int(artist_row["next_offset"] or 0)
    tracks, total, next_offset = parse_public_catalogue_page(
        response,
        artist_uuid=artist_uuid,
        offset=offset,
        limit=page_size,
    )
    targets = _target_rows_for_artist(connection, artist_spotify_id)
    targets_by_id = {str(row["spotify_id"]): row for row in targets}
    targets_by_title: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in targets:
        targets_by_title[str(row["normalized_title"])].append(row)
    inserted = 0
    now = utc_now()
    for track in tracks:
        uuid = str(track.get("soundcharts_uuid") or "").strip()
        if not uuid:
            continue
        explicit_spotify_id = exact_spotify_id(track.get("spotify_id"))
        candidates: Iterable[sqlite3.Row]
        exact = 0
        if explicit_spotify_id and explicit_spotify_id in targets_by_id:
            candidates = [targets_by_id[explicit_spotify_id]]
            exact = 1
        elif explicit_spotify_id:
            candidates = []
        else:
            candidates = targets_by_title.get(normalize_title(track.get("title")), [])
        for target in candidates:
            before = connection.total_changes
            connection.execute(
                """INSERT INTO candidates(
                       target_spotify_id,soundcharts_uuid,artist_soundcharts_uuid,
                       source_title,source_release_date,exact_discography_identifier,
                       status,updated_at,last_run_id)
                     VALUES(?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(target_spotify_id,soundcharts_uuid) DO UPDATE SET
                       exact_discography_identifier=MAX(
                         candidates.exact_discography_identifier,
                         excluded.exact_discography_identifier),
                       updated_at=excluded.updated_at,last_run_id=excluded.last_run_id""",
                (
                    str(target["spotify_id"]),
                    uuid,
                    artist_uuid,
                    str(track.get("title") or ""),
                    str(track.get("release_date") or "")[:10],
                    exact,
                    "pending",
                    now,
                    run_id,
                ),
            )
            inserted += int(connection.total_changes > before)
    complete = next_offset is None
    connection.execute(
        """UPDATE artists SET next_offset=?,total=?,status=?,attempts=0,
                  error_code=NULL,updated_at=?,last_run_id=? WHERE spotify_id=?""",
        (
            0 if complete else int(next_offset),
            total,
            "catalogue_complete" if complete else "catalogue_pending",
            now,
            run_id,
            artist_spotify_id,
        ),
    )
    connection.commit()
    return inserted, complete


def enumerate_discographies(
    connection: sqlite3.Connection,
    client: Any,
    *,
    workers: int,
    page_size: int,
    run_id: str,
) -> tuple[int, int, str]:
    pages = 0
    candidates = 0
    halt_reason = ""
    now = utc_now()
    normalize_exhausted_artist_retries(
        connection, run_id=run_id, now=now
    )
    connection.commit()
    while True:
        rows = connection.execute(
            """SELECT * FROM artists
                WHERE status IN ('catalogue_pending','catalogue_retry')
                  AND soundcharts_uuid IS NOT NULL AND trim(soundcharts_uuid)<>''
                  AND attempts<?
                ORDER BY next_offset,spotify_id LIMIT ?""",
            (MAX_RETRIES, max(1, workers)),
        ).fetchall()
        if not rows:
            break
        tasks: list[tuple[str, str]] = []
        by_spotify: dict[str, sqlite3.Row] = {}
        for row in rows:
            spotify_id = str(row["spotify_id"])
            by_spotify[spotify_id] = row
            query = urllib.parse.urlencode(
                {
                    "mainPerformer": 1,
                    "sortBy": "releaseDate",
                    "sortOrder": "desc",
                    "offset": int(row["next_offset"] or 0),
                    "limit": page_size,
                }
            )
            tasks.append(
                (
                    spotify_id,
                    f"/api/v2.21/artist/{urllib.parse.quote(str(row['soundcharts_uuid']))}/songs?{query}",
                )
            )
        for spotify_id, response, error in _parallel_fetch(client, tasks, workers=workers):
            row = by_spotify[spotify_id]
            now = utc_now()
            if error in {"request_limit", "quota_reserve"}:
                halt_reason = error
                continue
            if error:
                attempts = int(row["attempts"] or 0) + 1
                connection.execute(
                    """UPDATE artists SET status=?,attempts=?,error_code=?,updated_at=?,
                              last_run_id=? WHERE spotify_id=?""",
                    (
                        "catalogue_retry" if attempts < MAX_RETRIES else "catalogue_unavailable",
                        attempts,
                        error,
                        now,
                        run_id,
                        spotify_id,
                    ),
                )
                connection.commit()
                continue
            try:
                inserted, _ = integrate_catalogue_page(
                    connection,
                    row,
                    response,
                    page_size=page_size,
                    run_id=run_id,
                )
            except FalPhase1Error:
                attempts = int(row["attempts"] or 0) + 1
                connection.execute(
                    """UPDATE artists SET status=?,attempts=?,error_code='invalid_catalogue_page',
                              updated_at=?,last_run_id=? WHERE spotify_id=?""",
                    (
                        "catalogue_retry" if attempts < MAX_RETRIES else "catalogue_unavailable",
                        attempts,
                        now,
                        run_id,
                        spotify_id,
                    ),
                )
                connection.commit()
                continue
            pages += 1
            candidates += inserted
        if halt_reason:
            break
    return pages, candidates, halt_reason


def _audience_query(history_days: int, as_of: dt.date) -> str:
    start = as_of - dt.timedelta(days=max(1, history_days) - 1)
    return urllib.parse.urlencode(
        {
            "startDate": start.isoformat(),
            "endDate": as_of.isoformat(),
            "limit": max(100, history_days + 5),
        }
    )


def validate_candidates(
    connection: sqlite3.Connection,
    client: Any,
    *,
    workers: int,
    history_days: int,
    as_of: dt.date,
    run_id: str,
) -> tuple[int, int, str]:
    attempted = 0
    matched = 0
    halt_reason = ""
    query = _audience_query(history_days, as_of)
    while True:
        rows = connection.execute(
            """SELECT soundcharts_uuid FROM candidates
                WHERE status IN ('pending','retry')
                GROUP BY soundcharts_uuid ORDER BY soundcharts_uuid LIMIT ?""",
            (max(1, workers),),
        ).fetchall()
        if not rows:
            break
        tasks = [
            (
                str(row["soundcharts_uuid"]),
                f"/api/v2/song/{urllib.parse.quote(str(row['soundcharts_uuid']))}/audience/spotify?{query}",
            )
            for row in rows
        ]
        for uuid, response, error in _parallel_fetch(client, tasks, workers=workers):
            candidate_rows = connection.execute(
                "SELECT * FROM candidates WHERE soundcharts_uuid=?", (uuid,)
            ).fetchall()
            now = utc_now()
            if error in {"request_limit", "quota_reserve"}:
                halt_reason = error
                continue
            attempted += 1
            if error:
                for row in candidate_rows:
                    attempts = int(row["attempts"] or 0) + 1
                    # An exact identifier in the artist-song response remains
                    # valid identity proof even when audience history is not
                    # available.  Title-only candidates never receive this
                    # fallback.
                    if int(row["exact_discography_identifier"] or 0) == 1:
                        connection.execute(
                            """UPDATE candidates SET status='matched',attempts=?,
                                      evidence_json=?,history_json='[]',error_code=?,
                                      updated_at=?,last_run_id=?
                                 WHERE target_spotify_id=? AND soundcharts_uuid=?""",
                            (
                                attempts,
                                safe_json(
                                    {
                                        "source": "soundcharts_artist_songs_exact_spotify_id",
                                        "audience_status": error,
                                    }
                                ),
                                error,
                                now,
                                run_id,
                                row["target_spotify_id"],
                                uuid,
                            ),
                        )
                        matched += 1
                    else:
                        next_status = (
                            "unavailable"
                            if error == "unavailable" or attempts >= MAX_RETRIES
                            else "retry"
                        )
                        connection.execute(
                            """UPDATE candidates SET status=?,attempts=?,error_code=?,
                                      updated_at=?,last_run_id=?
                                 WHERE target_spotify_id=? AND soundcharts_uuid=?""",
                            (
                                next_status,
                                attempts,
                                error,
                                now,
                                run_id,
                                row["target_spotify_id"],
                                uuid,
                            ),
                        )
                connection.commit()
                continue

            exact_ids = {
                candidate.spotify_id
                for candidate in extract_spotify_plot_candidates(response)
            }
            for row in candidate_rows:
                target_id = str(row["target_spotify_id"])
                exact_discography = int(row["exact_discography_identifier"] or 0) == 1
                if target_id in exact_ids:
                    points = extract_song_audience_points(
                        response, target_id, require_identifier_match=True
                    )
                    status = "matched"
                    evidence = {
                        "source": "soundcharts_song_audience_spotify_plot",
                        "spotify_id": target_id,
                        "soundcharts_uuid": uuid,
                        "plot_identifiers": sorted(exact_ids),
                        "points": len(points),
                        "discography_exact_identifier": exact_discography,
                    }
                    matched += 1
                elif exact_discography:
                    # Two licensed Soundcharts endpoints disagree about the
                    # platform identity.  Never choose one silently.
                    points = []
                    status = "identity_conflict"
                    evidence = {
                        "source": "soundcharts_endpoint_conflict",
                        "discography_spotify_id": target_id,
                        "audience_plot_identifiers": sorted(exact_ids),
                    }
                else:
                    points = []
                    status = "rejected"
                    evidence = {
                        "source": "soundcharts_song_audience_spotify_plot",
                        "expected_spotify_id": target_id,
                        "plot_identifiers": sorted(exact_ids),
                    }
                connection.execute(
                    """UPDATE candidates SET status=?,attempts=attempts+1,
                              evidence_json=?,history_json=?,error_code=NULL,
                              updated_at=?,last_run_id=?
                         WHERE target_spotify_id=? AND soundcharts_uuid=?""",
                    (
                        status,
                        safe_json(evidence),
                        safe_json(points),
                        now,
                        run_id,
                        target_id,
                        uuid,
                    ),
                )
            connection.commit()
        if halt_reason:
            break
    return attempted, matched, halt_reason


def finalize_targets(connection: sqlite3.Connection, *, run_id: str) -> dict[str, int]:
    now = utc_now()
    counts = defaultdict(int)
    target_rows = connection.execute(
        """SELECT * FROM targets
            WHERE status NOT IN ('resolved_existing','no_artist_identity')
            ORDER BY spotify_id"""
    ).fetchall()
    for target in target_rows:
        spotify_id = str(target["spotify_id"])
        artists = connection.execute(
            """SELECT a.status FROM artists AS a
                 JOIN target_artists AS ta ON ta.artist_spotify_id=a.spotify_id
                WHERE ta.target_spotify_id=?""",
            (spotify_id,),
        ).fetchall()
        if not artists:
            status = "no_artist_identity"
            error_code = "public_artist_spotify_id_missing"
        elif any(str(row["status"]) in {"identity_pending", "identity_retry", "catalogue_pending", "catalogue_retry"} for row in artists):
            counts["pending"] += 1
            continue
        elif any(str(row["status"]) in {"identity_conflict", "identity_unavailable", "catalogue_unavailable"} for row in artists):
            status = "artist_catalogue_unavailable"
            error_code = "artist_identity_or_catalogue_unavailable"
        else:
            candidates = connection.execute(
                "SELECT * FROM candidates WHERE target_spotify_id=? ORDER BY soundcharts_uuid",
                (spotify_id,),
            ).fetchall()
            if any(str(row["status"]) in {"pending", "retry"} for row in candidates):
                counts["pending"] += 1
                continue
            conflicts = [row for row in candidates if str(row["status"]) == "identity_conflict"]
            matched = [row for row in candidates if str(row["status"]) == "matched"]
            unavailable = [row for row in candidates if str(row["status"]) == "unavailable"]
            matched_uuids = {str(row["soundcharts_uuid"]) for row in matched}
            if conflicts or len(matched_uuids) > 1:
                status = "ambiguous"
                error_code = "multiple_or_conflicting_soundcharts_identities"
                evidence = {
                    "matched_soundcharts_uuids": sorted(matched_uuids),
                    "conflicting_soundcharts_uuids": sorted(
                        {str(row["soundcharts_uuid"]) for row in conflicts}
                    ),
                }
                connection.execute(
                    """UPDATE targets SET status=?,soundcharts_uuid=NULL,evidence_json=?,
                              history_json='[]',error_code=?,updated_at=?,last_run_id=?
                         WHERE spotify_id=?""",
                    (status, safe_json(evidence), error_code, now, run_id, spotify_id),
                )
                counts[status] += 1
                continue
            if unavailable:
                status = "candidate_validation_unavailable"
                error_code = "soundcharts_audience_identity_unavailable"
                connection.execute(
                    """UPDATE targets SET status=?,soundcharts_uuid=NULL,evidence_json=?,
                              history_json='[]',error_code=?,updated_at=?,last_run_id=?
                         WHERE spotify_id=?""",
                    (
                        status,
                        safe_json(
                            {
                                "unavailable_soundcharts_uuids": sorted(
                                    {str(row["soundcharts_uuid"]) for row in unavailable}
                                )
                            }
                        ),
                        error_code,
                        now,
                        run_id,
                        spotify_id,
                    ),
                )
                counts[status] += 1
                continue
            if len(matched_uuids) == 1:
                matched_row = next(row for row in matched if str(row["soundcharts_uuid"]) in matched_uuids)
                status = "resolved"
                error_code = None
                connection.execute(
                    """UPDATE targets SET status='resolved',soundcharts_uuid=?,
                              evidence_json=?,history_json=?,error_code=NULL,
                              updated_at=?,last_run_id=? WHERE spotify_id=?""",
                    (
                        matched_row["soundcharts_uuid"],
                        matched_row["evidence_json"],
                        matched_row["history_json"],
                        now,
                        run_id,
                        spotify_id,
                    ),
                )
                counts[status] += 1
                continue
            status = "no_exact_match"
            error_code = "exact_spotify_id_not_observed"
        connection.execute(
            """UPDATE targets SET status=?,soundcharts_uuid=NULL,error_code=?,
                      updated_at=?,last_run_id=? WHERE spotify_id=?""",
            (status, error_code, now, run_id, spotify_id),
        )
        counts[status] += 1
    connection.commit()
    return dict(counts)


def apply_resolved_to_performance(
    connection: sqlite3.Connection,
    performance_path: Path,
    *,
    run_id: str,
) -> dict[str, int]:
    payload = read_performance_payload(performance_path)
    tracks = payload.setdefault("tracks", {})
    if not isinstance(tracks, dict):
        raise PublicIdentityBackfillError("Performance tracks store is not an object")
    added = 0
    unchanged = 0
    conflicts = 0
    now = utc_now()
    for row in connection.execute(
        "SELECT * FROM targets WHERE status='resolved' ORDER BY spotify_id"
    ).fetchall():
        spotify_id = str(row["spotify_id"])
        uuid = str(row["soundcharts_uuid"] or "").strip()
        if not uuid:
            continue
        entry = tracks.get(spotify_id)
        if entry is not None and not isinstance(entry, dict):
            conflicts += 1
            continue
        entry = dict(entry or {})
        previous_uuid = str(entry.get("soundcharts_uuid") or "").strip()
        if previous_uuid and previous_uuid != uuid:
            conflicts += 1
            continue
        history = json.loads(str(row["history_json"] or "[]"))
        entry["history"] = merge_history(entry.get("history"), history)
        entry["soundcharts_uuid"] = uuid
        entry["observed_at"] = now
        entry["maintenance_last_attempt_at"] = now
        entry["cadence_days"] = 1
        entry["source"] = "soundcharts_song_audience_spotify"
        entry["identity_backfill"] = {
            "version": STATE_VERSION,
            "run_id": run_id,
            "source": "exact_spotify_id",
            "applied_at": now,
        }
        if tracks.get(spotify_id) == entry:
            unchanged += 1
        else:
            tracks[spotify_id] = entry
            added += 1
    if added:
        payload["generated_at"] = now
        payload["identity_backfill"] = {
            "version": STATE_VERSION,
            "run_id": run_id,
            "applied_at": now,
            "resolved_tracks_added": added,
            "canonical_catalogue_written": False,
        }
        write_performance_payload(performance_path, payload)
    return {"added": added, "unchanged": unchanged, "conflicts": conflicts}


def _status_counts(connection: sqlite3.Connection, table: str) -> dict[str, int]:
    if table not in {"targets", "artists", "candidates"}:
        raise ValueError("Unsupported state table")
    return {
        str(row["status"]): int(row["count"])
        for row in connection.execute(
            f"SELECT status,COUNT(*) AS count FROM {table} GROUP BY status ORDER BY status"
        ).fetchall()
    }


def build_report(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    seed: Mapping[str, int],
    requests_claimed: int,
    quota_before: int | None,
    quota_after: int | None,
    halt_reason: str,
    pages: int,
    candidate_requests: int,
    performance_changes: Mapping[str, int],
    apply_performance: bool,
) -> dict[str, Any]:
    target_counts = _status_counts(connection, "targets")
    active = target_counts.get("pending", 0)
    unresolved = sum(
        target_counts.get(status, 0)
        for status in (
            "no_artist_identity",
            "artist_catalogue_unavailable",
            "no_exact_match",
            "ambiguous",
            "candidate_validation_unavailable",
        )
    )
    return {
        "version": STATE_VERSION,
        "generated_at": utc_now(),
        "run_id": run_id,
        "status": "quota_protected" if halt_reason == "quota_reserve" else (
            "request_cap_reached" if halt_reason == "request_limit" else (
                "partial_retry_required" if active else (
                    "complete_with_unresolved" if unresolved else "complete_exact_backfill"
                )
            )
        ),
        "staging_only": not apply_performance,
        "performance_only": True,
        "canonical_written": False,
        "browse_catalogue_written": False,
        "policy": {
            "artist_identity_sources": [
                "soundcharts_snapshot",
                "performance_artist",
                "browse_artist",
                "soundcharts_artist_by_platform",
            ],
            "discography_endpoint": "/api/v2.21/artist/{uuid}/songs",
            "validation_endpoint": "/api/v2/song/{uuid}/audience/spotify",
            "identity_requirement": "exact_22_character_spotify_id",
            "title_matching_is_shortlist_only": True,
            "ambiguous_never_assigned": True,
            "canonical_promotion_allowed": False,
            "raw_responses_persisted": False,
            "maximum_requests": ABSOLUTE_MAX_REQUESTS,
            "minimum_quota_reserve": MIN_QUOTA_RESERVE,
        },
        "requests": {
            "claimed": requests_claimed,
            "quota_observed_before": quota_before,
            "quota_observed_after": quota_after,
            "protected_floor": MIN_QUOTA_RESERVE,
            "halt_reason": halt_reason or None,
            "discography_pages": pages,
            "candidate_audience_requests": candidate_requests,
        },
        "seed": dict(seed),
        "coverage": {
            "targets": target_counts,
            "artists": _status_counts(connection, "artists"),
            "candidates": _status_counts(connection, "candidates"),
        },
        "performance_changes": dict(performance_changes),
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--browse-catalogue", type=Path, default=DEFAULT_BROWSE)
    parser.add_argument("--soundcharts", type=Path, default=DEFAULT_SOUNDCHARTS)
    parser.add_argument("--performance", type=Path, default=DEFAULT_PERFORMANCE)
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--quota-reserve", type=int, default=MIN_QUOTA_RESERVE)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--history-days", type=int, default=DEFAULT_HISTORY_DAYS)
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--as-of")
    parser.add_argument("--apply-performance", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not 1 <= int(args.max_requests) <= ABSOLUTE_MAX_REQUESTS:
        raise PublicIdentityBackfillError(
            f"max_requests must be between 1 and {ABSOLUTE_MAX_REQUESTS}"
        )
    if int(args.quota_reserve) < MIN_QUOTA_RESERVE:
        raise PublicIdentityBackfillError(
            f"quota_reserve must protect at least {MIN_QUOTA_RESERVE} calls"
        )
    if not 1 <= int(args.workers) <= MAX_WORKERS:
        raise PublicIdentityBackfillError(f"workers must be between 1 and {MAX_WORKERS}")
    if not 1 <= int(args.history_days) <= 365:
        raise PublicIdentityBackfillError("history_days must be between 1 and 365")
    if not 1 <= int(args.page_size) <= 100:
        raise PublicIdentityBackfillError("page_size must be between 1 and 100")

    run_id = str(args.run_id or os.environ.get("GITHUB_RUN_ID") or uuid_module.uuid4().hex)
    as_of = (
        dt.date.fromisoformat(str(args.as_of)[:10])
        if args.as_of
        else dt.datetime.now(dt.timezone.utc).date()
    )
    browse = read_js_payload(args.browse_catalogue, prefix=BROWSE_PREFIX)
    soundcharts = read_js_payload(args.soundcharts)
    # The root summary is sufficient for seeding and avoids hydrating every
    # history shard before the first network request.
    performance_summary = read_js_payload(args.performance, prefix=PERFORMANCE_PREFIX)
    connection = open_state(args.state)
    client: Any | None = None
    quota_before: int | None = None
    halt_reason = ""
    pages = 0
    candidate_requests = 0
    performance_changes: Mapping[str, int] = {"added": 0, "unchanged": 0, "conflicts": 0}
    try:
        seed = seed_state(
            connection,
            browse,
            soundcharts,
            performance_summary,
            run_id=run_id,
        )
        active = connection.execute(
            """SELECT COUNT(*) FROM targets
                WHERE status IN ('pending','artist_catalogue_unavailable')"""
        ).fetchone()[0]
        if active:
            client = SoundchartsClient(
                os.environ.get("SOUNDCHARTS_CLIENT_ID", ""),
                os.environ.get("SOUNDCHARTS_CLIENT_SECRET", ""),
                os.environ.get("SOUNDCHARTS_TEAM_ID", ""),
                quota_reserve=int(args.quota_reserve),
                request_limit=int(args.max_requests),
            )
            client.authenticate()
            quota_before = client.quota_remaining
            _, halt_reason = resolve_artist_identities(
                connection,
                client,
                workers=int(args.workers),
                run_id=run_id,
            )
            if not halt_reason:
                pages, _, halt_reason = enumerate_discographies(
                    connection,
                    client,
                    workers=int(args.workers),
                    page_size=int(args.page_size),
                    run_id=run_id,
                )
            if not halt_reason:
                candidate_requests, _, halt_reason = validate_candidates(
                    connection,
                    client,
                    workers=int(args.workers),
                    history_days=int(args.history_days),
                    as_of=as_of,
                    run_id=run_id,
                )
        finalize_targets(connection, run_id=run_id)
        if args.apply_performance:
            performance_changes = apply_resolved_to_performance(
                connection, args.performance, run_id=run_id
            )
        report = build_report(
            connection,
            run_id=run_id,
            seed=seed,
            requests_claimed=int(getattr(client, "requests_claimed", 0) or 0),
            quota_before=quota_before,
            quota_after=getattr(client, "quota_remaining", None),
            halt_reason=halt_reason,
            pages=pages,
            candidate_requests=candidate_requests,
            performance_changes=performance_changes,
            apply_performance=bool(args.apply_performance),
        )
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
