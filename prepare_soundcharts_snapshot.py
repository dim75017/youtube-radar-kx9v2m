#!/usr/bin/env python3
"""Prepare and atomically activate a sanitized Soundcharts web snapshot.

``prepare`` is deliberately side-effect-light: it reads an existing
``window.SPOTIFY_SOUNDCHARTS`` payload and creates a new, UTC-dated file next
to it.  It never edits the source payload or ``spotify/index.html``.

``activate`` is the separate publishing step.  It performs a strict
compare-and-swap on the single Soundcharts filename referenced by
``spotify/index.html``.  The previously referenced export is never removed.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
SNAPSHOT_BASENAME_RE = re.compile(
    r"^Spotify_Soundcharts_data(?:_[A-Za-z0-9_-]+)?\.js$"
)
SOUNDCHARTS_REFERENCE_RE = re.compile(
    r"(?P<quote>['\"])(?P<value>[^'\"]*Spotify_Soundcharts_data"
    r"(?:_[A-Za-z0-9_-]+)?\.js(?:\?[^'\"]*)?)(?P=quote)"
)
SOUNDCHARTS_FILENAME_RE = re.compile(
    r"Spotify_Soundcharts_data(?:_[A-Za-z0-9_-]+)?\.js"
)

# This is the reviewed, explicit public quarantine already used by the
# dashboard.  It is intentionally not an inference from audience size.
PUBLIC_ARTIST_BLACKLIST = frozenset(
    {
        "powfu",
        "bruno mars",
        "metallica",
        "michael jackson",
        "justin bieber",
        "shakira",
        "lady gaga",
        "pitbull",
        "david guetta",
        "calvin harris",
        "dua lipa",
        "kendrick lamar",
        "black eyed peas",
        "sean paul",
        "jennifer lopez",
        "ellie goulding",
        "bring me the horizon",
        "a$ap rocky",
        "asap rocky",
        "sarcastic sounds",
        # Manual review: vocal artist surfaced as an instrumental candidate.
        "corbon amodio",
        "rxseboy",
        "sody",
        "dominic fike",
        "burna boy",
        "dj snake",
        "drake",
        "the weeknd",
        "ed sheeran",
    }
)

COMPOSITE_CREDIT_RE = re.compile(
    r"(?:\s&\s|,|\bfeat(?:uring)?\.?\b|\bft\.?\b|\sx\s|\bwith\b|\bvs\.?\b|\s/\s)",
    re.IGNORECASE,
)
FORBIDDEN_RIGHTS = frozenset({"major", "mixed"})
CONTACTABLE_RIGHTS = frozenset({"self_released", "independent_label"})
ALLOWED_OPPORTUNITY_STATUSES = frozenset({"verified", "needs_listen"})
ALLOWED_AI_RISKS = frozenset({"low", "faible"})
TARGET_GENRES = frozenset(
    {
        "lofi_hip_hop",
        "guitar",
        "acoustic",
        "fingerstyle",
        "nature",
        "soundscape",
        "jazz_jazzhop",
        "classical",
        "ambient",
        "dark_ambient",
        "piano",
        "halloween_lofi",
        "christmas_lofi",
        "phonk_instrumental",
        "dnb_instrumental",
    }
)
PUBLIC_MIN_CONFIDENCE = 0.5
PUBLIC_MIN_ARTIST_MONTHLY_LISTENERS = 1_000
PUBLIC_MAX_ARTIST_MONTHLY_LISTENERS = 5_000_000
PUBLIC_MAX_TRACK_STREAMS = 250_000_000


class SnapshotError(RuntimeError):
    """Base error for snapshot preparation and activation."""


class SnapshotValidationError(SnapshotError):
    """Raised when a payload is unsafe for public activation."""


class CompareAndSwapError(SnapshotError):
    """Raised when the live pointer differs from the expected old pointer."""


@dataclass(frozen=True)
class PreparationResult:
    source: Path
    output: Path
    report: Mapping[str, Any]


def _normalise_text(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).casefold()
    return " ".join(text.split())


NORMALISED_PUBLIC_ARTIST_BLACKLIST = frozenset(
    _normalise_text(name) for name in PUBLIC_ARTIST_BLACKLIST
)


def _nonempty(value: Any) -> bool:
    return value is not None and bool(str(value).strip())


def _schema(payload: Mapping[str, Any], name: str) -> list[str]:
    schemas = payload.get("schemas")
    if not isinstance(schemas, Mapping):
        return []
    schema = schemas.get(name)
    return list(schema) if isinstance(schema, list) else []


def _row_value(row: Any, schema: Sequence[str], field: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(field)
    if not isinstance(row, (list, tuple)):
        return None
    try:
        index = schema.index(field)
    except ValueError:
        return None
    return row[index] if index < len(row) else None


def _set_row_value(row: Any, schema: Sequence[str], field: str, value: Any) -> None:
    if isinstance(row, dict):
        row[field] = value
        return
    if not isinstance(row, list):
        return
    try:
        index = schema.index(field)
    except ValueError:
        return
    if index < len(row):
        row[index] = value


def _number_at_least(value: Any, minimum: float) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return number >= minimum


def _finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def _identity_pair_from_row(row: Any, schema: Sequence[str]) -> tuple[str, str]:
    return (
        str(_row_value(row, schema, "spotify_id") or "").strip(),
        str(_row_value(row, schema, "soundcharts_uuid") or "").strip(),
    )


def _identity_pair_from_collaborator(collaborator: Any) -> tuple[str, str]:
    if not isinstance(collaborator, Mapping):
        return "", ""
    return (
        str(collaborator.get("spotify_id") or "").strip(),
        str(collaborator.get("soundcharts_uuid") or "").strip(),
    )


def _identity_pair_complete(pair: tuple[str, str]) -> bool:
    return bool(pair[0] and pair[1])


def _identity_from_row(row: Any, schema: Sequence[str]) -> tuple[str, str, str]:
    return (
        _normalise_text(_row_value(row, schema, "name")),
        str(_row_value(row, schema, "spotify_id") or "").strip(),
        str(_row_value(row, schema, "soundcharts_uuid") or "").strip(),
    )


def _collaborator_identity(collaborator: Any) -> tuple[str, str, str]:
    if not isinstance(collaborator, Mapping):
        return "", "", ""
    return (
        _normalise_text(collaborator.get("name")),
        str(collaborator.get("spotify_id") or "").strip(),
        str(collaborator.get("soundcharts_uuid") or "").strip(),
    )


def _mentions_name(value: Any, names: Iterable[str]) -> bool:
    text = _normalise_text(value)
    if not text:
        return False
    for name in names:
        if text == name:
            return True
        if re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", text):
            return True
    return False


def _identity_is_banned(
    identity: tuple[str, str, str],
    banned_names: set[str],
    banned_spotify_ids: set[str],
    banned_soundcharts_uuids: set[str],
) -> bool:
    name, spotify_id, soundcharts_uuid = identity
    return (
        name in banned_names
        or bool(spotify_id and spotify_id in banned_spotify_ids)
        or bool(soundcharts_uuid and soundcharts_uuid in banned_soundcharts_uuids)
    )


def _iter_identity_rows(payload: Mapping[str, Any]) -> Iterable[tuple[str, str, str]]:
    for collection in ("artists", "fal"):
        schema = _schema(payload, collection)
        rows = payload.get(collection)
        if isinstance(rows, list):
            for row in rows:
                yield _identity_from_row(row, schema)

    editorial = payload.get("editorial")
    if isinstance(editorial, Mapping):
        schema = editorial.get("artist_schema")
        schema = list(schema) if isinstance(schema, list) else []
        rows = editorial.get("artists")
        if isinstance(rows, list):
            for row in rows:
                yield _identity_from_row(row, schema)

    for collection in ("tracks", "opportunities"):
        schema = _schema(payload, collection)
        rows = payload.get(collection)
        if not isinstance(rows, list):
            continue
        for row in rows:
            collaborators = _row_value(row, schema, "artists")
            if isinstance(collaborators, list):
                for collaborator in collaborators:
                    yield _collaborator_identity(collaborator)


def _build_banned_identity_index(
    payload: Mapping[str, Any],
) -> tuple[set[str], set[str], set[str]]:
    banned_names = set(NORMALISED_PUBLIC_ARTIST_BLACKLIST)
    banned_spotify_ids: set[str] = set()
    banned_soundcharts_uuids: set[str] = set()
    identities = list(_iter_identity_rows(payload))

    # Fixed-point propagation makes aliases with the same structured IDs part
    # of the same quarantined identity without treating a credit string as an
    # artist identity by itself.
    changed = True
    while changed:
        changed = False
        for identity in identities:
            name, spotify_id, soundcharts_uuid = identity
            if not _identity_is_banned(
                identity,
                banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            ):
                continue
            before = (
                len(banned_names),
                len(banned_spotify_ids),
                len(banned_soundcharts_uuids),
            )
            if name:
                banned_names.add(name)
            if spotify_id:
                banned_spotify_ids.add(spotify_id)
            if soundcharts_uuid:
                banned_soundcharts_uuids.add(soundcharts_uuid)
            after = (
                len(banned_names),
                len(banned_spotify_ids),
                len(banned_soundcharts_uuids),
            )
            changed = changed or after != before

    return banned_names, banned_spotify_ids, banned_soundcharts_uuids


def _row_identity_is_banned(
    row: Any,
    schema: Sequence[str],
    banned_names: set[str],
    banned_spotify_ids: set[str],
    banned_soundcharts_uuids: set[str],
) -> bool:
    return _identity_is_banned(
        _identity_from_row(row, schema),
        banned_names,
        banned_spotify_ids,
        banned_soundcharts_uuids,
    )


def _row_has_banned_credit_or_collaborator(
    row: Any,
    schema: Sequence[str],
    banned_names: set[str],
    banned_spotify_ids: set[str],
    banned_soundcharts_uuids: set[str],
) -> bool:
    collaborators = _row_value(row, schema, "artists")
    if isinstance(collaborators, list) and collaborators:
        # Structured provider identities are authoritative.  The display
        # credit may contain aliases or a legitimate canonical name such as
        # "Drake Hughes" and must never override exact provider identity.
        return any(
            _identity_is_banned(
                _collaborator_identity(collaborator),
                banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            )
            for collaborator in collaborators
        )
    for field in ("artist", "credit_name"):
        if _mentions_name(_row_value(row, schema, field), banned_names):
            return True
    return False


def _structured_collaborators_complete(row: Any, schema: Sequence[str]) -> bool:
    collaborators = _row_value(row, schema, "artists")
    return bool(collaborators) and isinstance(collaborators, list) and all(
        isinstance(collaborator, Mapping)
        and _nonempty(collaborator.get("spotify_id"))
        and _nonempty(collaborator.get("soundcharts_uuid"))
        for collaborator in collaborators
    )


def _opportunity_contact_gate_passes(row: Any, schema: Sequence[str]) -> bool:
    return (
        _normalise_text(_row_value(row, schema, "opportunity_status")) == "verified"
        and _normalise_text(_row_value(row, schema, "instrumental_status"))
        == "instrumental"
        and _number_at_least(
            _row_value(row, schema, "instrumental_confidence"), 0.5
        )
        and _normalise_text(_row_value(row, schema, "primary_genre"))
        in TARGET_GENRES
        and _number_at_least(_row_value(row, schema, "genre_confidence"), 0.5)
        and _normalise_text(_row_value(row, schema, "ai_risk"))
        in ALLOWED_AI_RISKS
        and _normalise_text(_row_value(row, schema, "rights_status"))
        in CONTACTABLE_RIGHTS
        and _structured_collaborators_complete(row, schema)
    )


def _opportunity_exposes_contact(row: Any, schema: Sequence[str]) -> bool:
    status = _normalise_text(_row_value(row, schema, "contact_status"))
    if status in {"ready", "social"}:
        return True
    if _nonempty(_row_value(row, schema, "contact_email")) or _nonempty(
        _row_value(row, schema, "contact_url")
    ):
        return True
    collaborators = _row_value(row, schema, "artists")
    return isinstance(collaborators, list) and any(
        isinstance(collaborator, Mapping)
        and any(
            _nonempty(collaborator.get(field))
            for field in ("email", "url", "contact_email", "contact_url", "public_contacts")
        )
        for collaborator in collaborators
    )


def _scrub_opportunity_contacts(row: Any, schema: Sequence[str]) -> None:
    _set_row_value(row, schema, "contact_email", "")
    _set_row_value(row, schema, "contact_url", "")
    _set_row_value(row, schema, "contact_platform", "")
    current_status = _normalise_text(_row_value(row, schema, "contact_status"))
    _set_row_value(
        row,
        schema,
        "contact_status",
        "enrich" if current_status == "enrich" else "blocked",
    )
    collaborators = _row_value(row, schema, "artists")
    if not isinstance(collaborators, list):
        return
    for collaborator in collaborators:
        if not isinstance(collaborator, dict):
            continue
        for field in (
            "email",
            "url",
            "contact_email",
            "contact_url",
            "contact_platform",
            "public_contacts",
        ):
            if field in collaborator:
                collaborator[field] = [] if field == "public_contacts" else ""


def _is_composite_credit(row: Any, schema: Sequence[str]) -> bool:
    credit = _row_value(row, schema, "credit_name")
    if not _nonempty(credit):
        credit = _row_value(row, schema, "artist")
    return bool(COMPOSITE_CREDIT_RE.search(str(credit or "")))


def _is_incomplete_composite_identity(row: Any, schema: Sequence[str]) -> bool:
    name, spotify_id, soundcharts_uuid = _identity_from_row(row, schema)
    return bool(COMPOSITE_CREDIT_RE.search(name)) and not (
        _nonempty(spotify_id) and _nonempty(soundcharts_uuid)
    )


def _strict_public_classification_passes(
    row: Any, schema: Sequence[str]
) -> bool:
    return (
        _normalise_text(_row_value(row, schema, "primary_genre"))
        in TARGET_GENRES
        and _number_at_least(
            _row_value(row, schema, "genre_confidence"),
            PUBLIC_MIN_CONFIDENCE,
        )
        and _normalise_text(_row_value(row, schema, "instrumental_status"))
        == "instrumental"
        and _number_at_least(
            _row_value(row, schema, "instrumental_confidence"),
            PUBLIC_MIN_CONFIDENCE,
        )
        and _normalise_text(_row_value(row, schema, "ai_risk"))
        in ALLOWED_AI_RISKS
        and _normalise_text(_row_value(row, schema, "expansion_status"))
        == "eligible"
    )


def _verified_opportunity_classification_passes(
    row: Any, schema: Sequence[str]
) -> bool:
    return (
        _normalise_text(_row_value(row, schema, "primary_genre"))
        in TARGET_GENRES
        and _number_at_least(
            _row_value(row, schema, "genre_confidence"),
            PUBLIC_MIN_CONFIDENCE,
        )
        and _normalise_text(_row_value(row, schema, "instrumental_status"))
        == "instrumental"
        and _number_at_least(
            _row_value(row, schema, "instrumental_confidence"),
            PUBLIC_MIN_CONFIDENCE,
        )
        and _normalise_text(_row_value(row, schema, "ai_risk"))
        in ALLOWED_AI_RISKS
    )


def _public_artist_audience_is_bounded(
    row: Any, schema: Sequence[str]
) -> bool:
    listeners = _finite_number(_row_value(row, schema, "monthly_listeners"))
    return (
        listeners is not None
        and listeners >= PUBLIC_MIN_ARTIST_MONTHLY_LISTENERS
        and listeners <= PUBLIC_MAX_ARTIST_MONTHLY_LISTENERS
    )


def _public_artist_rows_by_pair(
    payload: Mapping[str, Any],
) -> dict[tuple[str, str], Any]:
    schema = _schema(payload, "artists")
    rows = payload.get("artists")
    if not isinstance(rows, list):
        return {}
    return {
        pair: row
        for row in rows
        if _identity_pair_complete(pair := _identity_pair_from_row(row, schema))
    }


def _public_track_failure_reason(
    row: Any,
    schema: Sequence[str],
    artist_rows_by_pair: Mapping[tuple[str, str], Any],
    artist_schema: Sequence[str],
    banned_names: set[str],
    banned_spotify_ids: set[str],
    banned_soundcharts_uuids: set[str],
) -> str | None:
    if _row_has_banned_credit_or_collaborator(
        row,
        schema,
        banned_names,
        banned_spotify_ids,
        banned_soundcharts_uuids,
    ):
        return "blacklisted_identity"
    if not _nonempty(_row_value(row, schema, "spotify_id")) or not _nonempty(
        _row_value(row, schema, "soundcharts_uuid")
    ):
        return "missing_track_ids"
    if not _strict_public_classification_passes(row, schema):
        return "classification_not_strict"
    if _normalise_text(_row_value(row, schema, "rights_status")) not in (
        CONTACTABLE_RIGHTS
    ):
        return "rights_not_self_or_indie"
    if not _number_at_least(
        _row_value(row, schema, "rights_confidence"),
        PUBLIC_MIN_CONFIDENCE,
    ):
        return "rights_confidence_too_low"
    streams = _finite_number(_row_value(row, schema, "streams"))
    if streams is None or streams < 0 or streams > PUBLIC_MAX_TRACK_STREAMS:
        return "track_size_unknown_or_too_large"
    if not _structured_collaborators_complete(row, schema):
        if _is_composite_credit(row, schema):
            return "composite_credit_without_complete_ids"
        return "incomplete_collaborators"
    collaborators = _row_value(row, schema, "artists")
    for collaborator in collaborators:
        pair = _identity_pair_from_collaborator(collaborator)
        artist = artist_rows_by_pair.get(pair)
        if artist is None:
            return "artist_identity_not_in_public_index"
        if _row_identity_is_banned(
            artist,
            artist_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            return "blacklisted_identity"
        if not _public_artist_audience_is_bounded(artist, artist_schema):
            return "artist_size_unknown_or_too_large"
    return None


def _row_links_to_public_track(
    row: Any,
    schema: Sequence[str],
    public_track_pairs: set[tuple[str, str]],
) -> bool:
    pair = _identity_pair_from_row(row, schema)
    return _identity_pair_complete(pair) and pair in public_track_pairs


def _unique_track_pairs_by_soundcharts_uuid(
    public_track_pairs: Iterable[tuple[str, str]],
) -> dict[str, tuple[str, str]]:
    candidates: dict[str, set[str]] = {}
    for spotify_id, soundcharts_uuid in public_track_pairs:
        if not spotify_id or not soundcharts_uuid:
            continue
        candidates.setdefault(soundcharts_uuid, set()).add(spotify_id)
    return {
        soundcharts_uuid: (next(iter(spotify_ids)), soundcharts_uuid)
        for soundcharts_uuid, spotify_ids in candidates.items()
        if len(spotify_ids) == 1
    }


def _complete_editorial_track_pair(
    row: Any,
    schema: Sequence[str],
    public_pair_by_soundcharts_uuid: Mapping[str, tuple[str, str]],
) -> bool:
    spotify_id, soundcharts_uuid = _identity_pair_from_row(row, schema)
    canonical = public_pair_by_soundcharts_uuid.get(soundcharts_uuid)
    if canonical is None or (spotify_id and spotify_id != canonical[0]):
        return False
    if not spotify_id:
        _set_row_value(row, schema, "spotify_id", canonical[0])
    return _identity_pair_from_row(row, schema) == canonical


def _update_if_direct_count(
    container: Any,
    key: str,
    before: int,
    after: int,
) -> None:
    if not isinstance(container, dict) or key not in container:
        return
    if container.get(key) == before:
        container[key] = after


def _counter_from_rows(
    rows: Sequence[Any], schema: Sequence[str], field: str
) -> dict[str, int]:
    values = Counter(
        str(_row_value(row, schema, field) or "").strip()
        for row in rows
        if _nonempty(_row_value(row, schema, field))
    )
    return dict(values)


def _refresh_counts(
    payload: dict[str, Any], before_counts: Mapping[str, int]
) -> None:
    artists = payload.get("artists") if isinstance(payload.get("artists"), list) else []
    fal = payload.get("fal") if isinstance(payload.get("fal"), list) else []
    tracks = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    opportunities = (
        payload.get("opportunities")
        if isinstance(payload.get("opportunities"), list)
        else []
    )
    editorial = payload.get("editorial")
    editorial_artists = (
        editorial.get("artists")
        if isinstance(editorial, Mapping) and isinstance(editorial.get("artists"), list)
        else []
    )
    editorial_tracks = (
        editorial.get("tracks")
        if isinstance(editorial, Mapping) and isinstance(editorial.get("tracks"), list)
        else []
    )

    coverage = payload.get("coverage")
    if isinstance(coverage, dict):
        _update_if_direct_count(
            coverage.get("artists"),
            "exported",
            before_counts["artists"],
            len(artists),
        )
        _update_if_direct_count(
            coverage.get("tracks"),
            "exported",
            before_counts["tracks"],
            len(tracks),
        )
        fal_coverage = coverage.get("fal")
        for key in ("candidates", "exported"):
            _update_if_direct_count(
                fal_coverage, key, before_counts["fal"], len(fal)
            )
        if isinstance(fal_coverage, dict) and "resolved" in fal_coverage:
            fal_schema = _schema(payload, "fal")
            resolved_exported = sum(
                1
                for row in fal
                if _nonempty(_row_value(row, fal_schema, "spotify_id"))
                and _nonempty(_row_value(row, fal_schema, "soundcharts_uuid"))
            )
            _update_if_direct_count(
                fal_coverage,
                "resolved",
                before_counts["fal"],
                resolved_exported,
            )

    if isinstance(editorial, dict):
        for key in ("artist_count", "artists_count"):
            _update_if_direct_count(
                editorial,
                key,
                before_counts["editorial.artists"],
                len(editorial_artists),
            )
        for key in ("track_count", "tracks_count"):
            _update_if_direct_count(
                editorial,
                key,
                before_counts["editorial.tracks"],
                len(editorial_tracks),
            )

    opportunity_schema = _schema(payload, "opportunities")
    scoring = payload.get("opportunity_scoring")
    sync = payload.get("opportunity_sync")
    for container in (scoring, sync):
        if isinstance(container, dict):
            container["opportunities"] = len(opportunities)
            if "deal_types" in container:
                container["deal_types"] = _counter_from_rows(
                    opportunities, opportunity_schema, "deal_type"
                )
    if isinstance(scoring, dict):
        if "classification" in scoring:
            scoring["classification"] = _counter_from_rows(
                opportunities, opportunity_schema, "opportunity_status"
            )
        if "contacts" in scoring:
            scoring["contacts"] = _counter_from_rows(
                opportunities, opportunity_schema, "contact_status"
            )


DISCOVERY_CATALOGUE_VERSION = 1
DISCOVERY_TRACK_FIELDS = (
    "soundcharts_uuid",
    "spotify_id",
    "title",
    "credit_name",
    "artists",
    "release_date",
    "image_url",
    "label",
    "copyright",
    "rights_status",
    "rights_confidence",
    "streams",
    "streams_delta_24h",
    "streams_source_date",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "review_reasons",
    "metadata_status",
    "source_tier",
    "playlist_ids",
    "playlist_names",
    "playlist_count",
    "playlist_best_position",
    "playlist_followers_total",
    "playlist_first_seen_at",
    "playlist_last_seen_at",
    "playlist_placements",
    "discovery_source_playlist_ids",
    "discovery_source_playlist_names",
    "artist_soundcharts_uuids",
    "discovered_at",
    "updated_at",
    "availability_status",
)

DISCOVERY_ARTIST_FIELDS = (
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "monthly_listeners",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "review_reasons",
    "source_tier",
    "playlist_ids",
    "playlist_names",
    "playlist_count",
    "catalogue_tracks_discovered",
    "discovered_at",
    "last_catalogue_scan_at",
    "track_count",
    "availability_status",
)

DISCOVERY_PLAYLIST_FIELDS = (
    "spotify_id",
    "name",
    "position",
    "followers",
    "first_seen_at",
    "last_seen_at",
)


def _mapping_from_row(row: Any, schema: Sequence[str]) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    if not isinstance(row, (list, tuple)):
        return {}
    return {
        name: row[index] if index < len(row) else None
        for index, name in enumerate(schema)
    }


def _catalogue_playlist_placements(editorial_track: Mapping[str, Any]) -> list[dict[str, Any]]:
    placements: list[dict[str, Any]] = []
    raw = editorial_track.get("playlist_placements")
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        spotify_id = str(item.get("spotify_id") or item.get("playlist_id") or "").strip()
        name = str(item.get("name") or item.get("playlist_name") or "").strip()
        if not spotify_id and not name:
            continue
        placements.append(
            {
                "spotify_id": spotify_id,
                "name": name,
                "position": _finite_number(item.get("position")),
                "followers": int(_finite_number(item.get("followers") or item.get("playlist_followers")) or 0),
                "first_seen_at": str(item.get("first_seen_at") or item.get("entry_date") or "")[:10],
                "last_seen_at": str(item.get("last_seen_at") or "")[:10],
            }
        )
    if placements:
        placements.sort(
            key=lambda item: (
                item.get("position") is None,
                item.get("position") or 10**9,
                -int(item.get("followers") or 0),
                item.get("name") or "",
            )
        )
        return placements
    ids = editorial_track.get("playlist_ids") if isinstance(editorial_track.get("playlist_ids"), list) else []
    names = editorial_track.get("playlist_names") if isinstance(editorial_track.get("playlist_names"), list) else []
    return [
        {
            "spotify_id": str(playlist_id or ""),
            "name": str(names[index] if index < len(names) else ""),
            "position": editorial_track.get("playlist_best_position") if index == 0 else None,
            "followers": 0,
            "first_seen_at": str(editorial_track.get("playlist_first_seen_at") or "")[:10],
            "last_seen_at": str(editorial_track.get("playlist_last_seen_at") or "")[:10],
        }
        for index, playlist_id in enumerate(ids)
        if playlist_id or (index < len(names) and names[index])
    ]


def _build_discovery_catalogue(payload: Mapping[str, Any]) -> dict[str, Any]:
    editorial = payload.get("editorial") if isinstance(payload.get("editorial"), Mapping) else {}
    editorial_track_schema = editorial.get("track_schema") if isinstance(editorial.get("track_schema"), list) else []
    editorial_track_rows = editorial.get("tracks") if isinstance(editorial.get("tracks"), list) else []
    editorial_artist_schema = editorial.get("artist_schema") if isinstance(editorial.get("artist_schema"), list) else []
    editorial_artist_rows = editorial.get("artists") if isinstance(editorial.get("artists"), list) else []

    measured_schema = _schema(payload, "tracks")
    measured_rows = payload.get("tracks") if isinstance(payload.get("tracks"), list) else []
    measured_by_uuid = {
        str(_row_value(row, measured_schema, "soundcharts_uuid") or "").strip(): _mapping_from_row(row, measured_schema)
        for row in measured_rows
        if _row_value(row, measured_schema, "soundcharts_uuid")
    }
    opportunity_schema = _schema(payload, "opportunities")
    opportunity_rows = payload.get("opportunities") if isinstance(payload.get("opportunities"), list) else []
    opportunity_by_uuid = {
        str(_row_value(row, opportunity_schema, "soundcharts_uuid") or "").strip(): _mapping_from_row(row, opportunity_schema)
        for row in opportunity_rows
        if _row_value(row, opportunity_schema, "soundcharts_uuid")
    }

    tracks: list[dict[str, Any]] = []
    artist_track_counts: Counter[str] = Counter()
    for raw in editorial_track_rows:
        editorial_track = _mapping_from_row(raw, editorial_track_schema)
        uuid = str(editorial_track.get("soundcharts_uuid") or "").strip()
        if not uuid:
            continue
        measured = measured_by_uuid.get(uuid, {})
        opportunity = opportunity_by_uuid.get(uuid, {})
        placements = _catalogue_playlist_placements(editorial_track)
        spotify_id = str(editorial_track.get("spotify_id") or measured.get("spotify_id") or "").strip()
        structured_artists = measured.get("artists") if isinstance(measured.get("artists"), list) else []
        artist_uuids = editorial_track.get("artist_soundcharts_uuids") if isinstance(editorial_track.get("artist_soundcharts_uuids"), list) else []
        for artist_uuid in artist_uuids:
            if artist_uuid:
                artist_track_counts[str(artist_uuid)] += 1
        measured_flag = bool(measured and measured.get("streams") is not None)
        opportunity_status = str(opportunity.get("opportunity_status") or "").casefold()
        source_tier = str(editorial_track.get("source_tier") or measured.get("source_tier") or "").casefold()
        if opportunity_status == "verified":
            availability = "verified"
        elif opportunity_status == "needs_listen":
            availability = "needs_listen"
        elif measured_flag:
            availability = "measured"
        elif source_tier == "playlist_artist_catalogue":
            availability = "catalogue_discovered"
        elif placements:
            availability = "playlist_discovered"
        else:
            availability = "discovered"
        rights_status = str(measured.get("rights_status") or editorial_track.get("rights_status") or "unknown")
        row = {
            "soundcharts_uuid": uuid,
            "spotify_id": spotify_id,
            "title": str(measured.get("title") or editorial_track.get("name") or "Titre non renseigné"),
            "credit_name": str(measured.get("artist") or editorial_track.get("artist") or "Artiste non renseigné"),
            "artists": structured_artists,
            "release_date": str(measured.get("release_date") or editorial_track.get("release_date") or ""),
            "image_url": str(measured.get("image_url") or editorial_track.get("image_url") or ""),
            "label": str(measured.get("label") or editorial_track.get("label") or ""),
            "copyright": str(measured.get("copyright") or editorial_track.get("copyright") or ""),
            "rights_status": rights_status,
            "rights_confidence": _finite_number(measured.get("rights_confidence") or editorial_track.get("rights_confidence")),
            "streams": _finite_number(measured.get("streams")),
            "streams_delta_24h": _finite_number(measured.get("delta")),
            "streams_source_date": str(measured.get("source_date") or ""),
            "primary_genre": str(measured.get("primary_genre") or editorial_track.get("primary_genre") or "other_instrumental"),
            "subgenres": measured.get("subgenres") if isinstance(measured.get("subgenres"), list) else (
                editorial_track.get("subgenres") if isinstance(editorial_track.get("subgenres"), list) else []
            ),
            "genre_confidence": _finite_number(measured.get("genre_confidence") or editorial_track.get("genre_confidence")),
            "instrumental_status": str(measured.get("instrumental_status") or editorial_track.get("instrumental_status") or "unknown"),
            "instrumental_confidence": _finite_number(measured.get("instrumental_confidence") or editorial_track.get("instrumental_confidence")),
            "ai_risk": str(measured.get("ai_risk") or editorial_track.get("ai_risk") or "unknown"),
            "ai_risk_score": _finite_number(measured.get("ai_risk_score") or editorial_track.get("ai_risk_score")),
            "expansion_status": str(measured.get("expansion_status") or editorial_track.get("expansion_status") or "review"),
            "review_reasons": editorial_track.get("review_reasons") if isinstance(editorial_track.get("review_reasons"), list) else [],
            "metadata_status": str(measured.get("metadata_status") or editorial_track.get("metadata_status") or "playlist_only"),
            "source_tier": source_tier,
            "playlist_ids": [item.get("spotify_id") for item in placements if item.get("spotify_id")],
            "playlist_names": [item.get("name") for item in placements if item.get("name")],
            "playlist_count": len(placements),
            "playlist_best_position": min(
                [int(item["position"]) for item in placements if item.get("position") is not None],
                default=None,
            ),
            "playlist_followers_total": sum(int(item.get("followers") or 0) for item in placements),
            "playlist_first_seen_at": min(
                [item.get("first_seen_at") for item in placements if item.get("first_seen_at")],
                default=str(editorial_track.get("playlist_first_seen_at") or "")[:10],
            ),
            "playlist_last_seen_at": max(
                [item.get("last_seen_at") for item in placements if item.get("last_seen_at")],
                default=str(editorial_track.get("playlist_last_seen_at") or "")[:10],
            ),
            "playlist_placements": placements,
            "discovery_source_playlist_ids": editorial_track.get("discovery_source_playlist_ids")
            if isinstance(editorial_track.get("discovery_source_playlist_ids"), list)
            else [],
            "discovery_source_playlist_names": editorial_track.get("discovery_source_playlist_names")
            if isinstance(editorial_track.get("discovery_source_playlist_names"), list)
            else [],
            "artist_soundcharts_uuids": artist_uuids,
            "discovered_at": str(editorial_track.get("discovered_at") or ""),
            "updated_at": str(editorial_track.get("updated_at") or measured.get("metadata_updated_at") or ""),
            "availability_status": availability,
        }
        tracks.append(row)

    artists: list[dict[str, Any]] = []
    for raw in editorial_artist_rows:
        artist = _mapping_from_row(raw, editorial_artist_schema)
        uuid = str(artist.get("soundcharts_uuid") or "").strip()
        if not uuid:
            continue
        spotify_id = str(artist.get("spotify_id") or "").strip()
        listeners = _finite_number(artist.get("monthly_listeners"))
        expansion = str(artist.get("expansion_status") or "review")
        availability = "identified" if spotify_id else "discovered"
        if listeners is not None:
            availability = "measured"
        if expansion == "eligible" and spotify_id and listeners is not None:
            availability = "verified"
        row = {
            "soundcharts_uuid": uuid,
            "spotify_id": spotify_id,
            "name": str(artist.get("name") or "Artiste non renseigné"),
            "monthly_listeners": listeners,
            "primary_genre": str(artist.get("primary_genre") or "other_instrumental"),
            "subgenres": artist.get("subgenres") if isinstance(artist.get("subgenres"), list) else [],
            "genre_confidence": _finite_number(artist.get("genre_confidence")),
            "instrumental_status": str(artist.get("instrumental_status") or "unknown"),
            "instrumental_confidence": _finite_number(artist.get("instrumental_confidence")),
            "ai_risk": str(artist.get("ai_risk") or "unknown"),
            "ai_risk_score": _finite_number(artist.get("ai_risk_score")),
            "expansion_status": expansion,
            "review_reasons": artist.get("review_reasons") if isinstance(artist.get("review_reasons"), list) else [],
            "source_tier": str(artist.get("source_tier") or ""),
            "playlist_ids": artist.get("playlist_ids") if isinstance(artist.get("playlist_ids"), list) else [],
            "playlist_names": artist.get("playlist_names") if isinstance(artist.get("playlist_names"), list) else [],
            "playlist_count": int(_finite_number(artist.get("playlist_count")) or 0),
            "catalogue_tracks_discovered": int(_finite_number(artist.get("catalogue_tracks_discovered")) or 0),
            "discovered_at": str(artist.get("discovered_at") or ""),
            "last_catalogue_scan_at": str(artist.get("last_catalogue_scan_at") or ""),
            "track_count": int(artist_track_counts.get(uuid, 0)),
            "availability_status": availability,
        }
        artists.append(row)

    tracks.sort(
        key=lambda row: (
            0 if row.get("availability_status") == "verified" else 1,
            0 if row.get("streams") is not None else 1,
            -(float(row.get("streams_delta_24h") or 0)),
            -(float(row.get("streams") or 0)),
            row.get("title") or "",
        )
    )
    artists.sort(
        key=lambda row: (
            0 if row.get("availability_status") == "verified" else 1,
            -(float(row.get("monthly_listeners") or 0)),
            row.get("name") or "",
        )
    )
    counts = {
        "tracks": len(tracks),
        "artists": len(artists),
        "measured_tracks": sum(row.get("streams") is not None for row in tracks),
        "playlist_tracks": sum(bool(row.get("playlist_count")) for row in tracks),
        "catalogue_tracks": sum(row.get("source_tier") == "playlist_artist_catalogue" for row in tracks),
        "verified_tracks": sum(row.get("availability_status") == "verified" for row in tracks),
    }
    for row in tracks:
        placements = row.get("playlist_placements") if isinstance(row.get("playlist_placements"), list) else []
        row["playlist_placements"] = [
            [placement.get(key) for key in DISCOVERY_PLAYLIST_FIELDS]
            for placement in placements
            if isinstance(placement, Mapping)
        ]
    compact_tracks = [[row.get(key) for key in DISCOVERY_TRACK_FIELDS] for row in tracks]
    compact_artists = [[row.get(key) for key in DISCOVERY_ARTIST_FIELDS] for row in artists]
    return {
        "version": DISCOVERY_CATALOGUE_VERSION,
        "generated_at": str(payload.get("generated_at") or ""),
        "track_schema": list(DISCOVERY_TRACK_FIELDS),
        "artist_schema": list(DISCOVERY_ARTIST_FIELDS),
        "playlist_schema": list(DISCOVERY_PLAYLIST_FIELDS),
        "tracks": compact_tracks,
        "artists": compact_artists,
        "counts": counts,
    }


def _filter_discovery_catalogue_for_publication(
    catalogue: Mapping[str, Any],
    banned_names: set[str],
    banned_spotify_ids: set[str],
    banned_soundcharts_uuids: set[str],
) -> dict[str, Any]:
    """Keep the broad browse layer while applying identity quarantine.

    The discovery catalogue deliberately contains tracks which have not yet
    passed the strict contactability/classification gate.  It is a read-only
    research surface (no contacts), so rebuilding it from the *strict* rows at
    the end of sanitisation silently discarded all of those tracks.  Preserve
    the pre-gate projection, but never let a quarantined identity back in.
    """

    result = copy.deepcopy(dict(catalogue))
    track_schema = result.get("track_schema")
    track_schema = list(track_schema) if isinstance(track_schema, list) else []
    artist_schema = result.get("artist_schema")
    artist_schema = list(artist_schema) if isinstance(artist_schema, list) else []

    tracks = result.get("tracks") if isinstance(result.get("tracks"), list) else []
    artists = result.get("artists") if isinstance(result.get("artists"), list) else []
    retained_tracks = [
        row for row in tracks
        if not _row_has_banned_credit_or_collaborator(
            row,
            track_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        )
    ]
    retained_artists = [
        row for row in artists
        if not _row_identity_is_banned(
            row,
            artist_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        )
    ]
    track_records = [_mapping_from_row(row, track_schema) for row in retained_tracks]
    result["tracks"] = retained_tracks
    result["artists"] = retained_artists
    result["counts"] = {
        "tracks": len(retained_tracks),
        "artists": len(retained_artists),
        "measured_tracks": sum(record.get("streams") is not None for record in track_records),
        "playlist_tracks": sum(bool(record.get("playlist_count")) for record in track_records),
        "catalogue_tracks": sum(
            record.get("source_tier") == "playlist_artist_catalogue"
            for record in track_records
        ),
        "verified_tracks": sum(
            record.get("availability_status") == "verified"
            for record in track_records
        ),
    }
    return result


def sanitize_payload(payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a public-safe copy and a deterministic removal report.

    General public collections are an allowlist, not a staging mirror.  A
    public track must carry strict genre/instrumental/AI/rights evidence and
    every collaborator must resolve by an exact Spotify + Soundcharts pair to
    a measured, bounded artist.  ``needs_listen`` remains available only in
    the track-first opportunity collection.
    """

    if not isinstance(payload, Mapping):
        raise SnapshotValidationError("Soundcharts payload must be a JSON object")
    sanitized: dict[str, Any] = copy.deepcopy(dict(payload))
    if not isinstance(sanitized.get("opportunities"), list):
        raise SnapshotValidationError("SC.opportunities must be present and be a list")

    editorial = sanitized.get("editorial")
    # Build this before strict public pruning.  The browse layer is allowed to
    # expose an honest “À classifier” track; it must not be reduced to the
    # small contactable/fully classified subset.
    full_discovery_catalogue = _build_discovery_catalogue(sanitized)
    sanitized["discovery_catalogue"] = full_discovery_catalogue
    before_counts = {
        "artists": len(sanitized.get("artists", []))
        if isinstance(sanitized.get("artists"), list)
        else 0,
        "fal": len(sanitized.get("fal", []))
        if isinstance(sanitized.get("fal"), list)
        else 0,
        "tracks": len(sanitized.get("tracks", []))
        if isinstance(sanitized.get("tracks"), list)
        else 0,
        "opportunities": len(sanitized["opportunities"]),
        "editorial.artists": len(editorial.get("artists", []))
        if isinstance(editorial, Mapping) and isinstance(editorial.get("artists"), list)
        else 0,
        "editorial.tracks": len(editorial.get("tracks", []))
        if isinstance(editorial, Mapping) and isinstance(editorial.get("tracks"), list)
        else 0,
        "discovery.tracks": len(sanitized.get("discovery_catalogue", {}).get("tracks", []))
        if isinstance(sanitized.get("discovery_catalogue"), Mapping)
        else 0,
        "discovery.artists": len(sanitized.get("discovery_catalogue", {}).get("artists", []))
        if isinstance(sanitized.get("discovery_catalogue"), Mapping)
        else 0,
    }

    banned_names, banned_spotify_ids, banned_soundcharts_uuids = (
        _build_banned_identity_index(sanitized)
    )
    removed: dict[str, int] = {}
    artist_schema = _schema(sanitized, "artists")
    artist_rows_by_pair = _public_artist_rows_by_pair(sanitized)
    track_schema = _schema(sanitized, "tracks")
    track_reasons = Counter()
    retained_tracks: list[Any] = []
    for row in sanitized.get("tracks", []) if isinstance(sanitized.get("tracks"), list) else []:
        failure = _public_track_failure_reason(
            row,
            track_schema,
            artist_rows_by_pair,
            artist_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        )
        if failure:
            track_reasons[failure] += 1
            continue
        retained_tracks.append(row)
    if isinstance(sanitized.get("tracks"), list):
        sanitized["tracks"] = retained_tracks
    removed["tracks"] = sum(track_reasons.values())

    eligible_artist_pairs = {
        _identity_pair_from_collaborator(collaborator)
        for row in retained_tracks
        for collaborator in (_row_value(row, track_schema, "artists") or [])
    }
    public_track_pairs = {
        _identity_pair_from_row(row, track_schema) for row in retained_tracks
    }
    public_pair_by_soundcharts_uuid = _unique_track_pairs_by_soundcharts_uuid(
        public_track_pairs
    )

    artist_reasons = Counter()
    retained_artists: list[Any] = []
    for row in sanitized.get("artists", []) if isinstance(sanitized.get("artists"), list) else []:
        pair = _identity_pair_from_row(row, artist_schema)
        if _row_identity_is_banned(
            row,
            artist_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            artist_reasons["blacklisted_identity"] += 1
        elif _is_incomplete_composite_identity(row, artist_schema):
            artist_reasons["composite_identity_without_complete_ids"] += 1
        elif not _identity_pair_complete(pair):
            artist_reasons["incomplete_identity"] += 1
        elif pair not in eligible_artist_pairs:
            artist_reasons["not_referenced_by_strict_track"] += 1
        elif not _public_artist_audience_is_bounded(row, artist_schema):
            artist_reasons["size_unknown_or_too_large"] += 1
        else:
            retained_artists.append(row)
    if isinstance(sanitized.get("artists"), list):
        sanitized["artists"] = retained_artists
    removed["artists"] = sum(artist_reasons.values())

    fal_schema = _schema(sanitized, "fal")
    fal_reasons = Counter()
    retained_fal: list[Any] = []
    for row in sanitized.get("fal", []) if isinstance(sanitized.get("fal"), list) else []:
        pair = _identity_pair_from_row(row, fal_schema)
        if _row_identity_is_banned(
            row,
            fal_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            fal_reasons["blacklisted_identity"] += 1
        elif _is_incomplete_composite_identity(row, fal_schema):
            fal_reasons["composite_identity_without_complete_ids"] += 1
        elif not _identity_pair_complete(pair):
            fal_reasons["incomplete_identity"] += 1
        elif pair not in eligible_artist_pairs:
            fal_reasons["not_referenced_by_strict_track"] += 1
        elif not _public_artist_audience_is_bounded(row, fal_schema):
            fal_reasons["size_unknown_or_too_large"] += 1
        elif not bool(_row_value(row, fal_schema, "qualifies")):
            fal_reasons["not_qualified"] += 1
        elif _normalise_text(_row_value(row, fal_schema, "rights_status")) not in CONTACTABLE_RIGHTS:
            fal_reasons["rights_not_self_or_indie"] += 1
        else:
            retained_fal.append(row)
    if isinstance(sanitized.get("fal"), list):
        sanitized["fal"] = retained_fal
    removed["fal"] = sum(fal_reasons.values())

    editorial_artist_reasons = Counter()
    editorial_track_reasons = Counter()
    editorial_track_ids_completed = 0
    if isinstance(editorial, dict):
        editorial_artist_schema = editorial.get("artist_schema")
        editorial_artist_schema = (
            list(editorial_artist_schema)
            if isinstance(editorial_artist_schema, list)
            else []
        )
        retained_editorial_artists: list[Any] = []
        for row in editorial.get("artists", []) if isinstance(editorial.get("artists"), list) else []:
            pair = _identity_pair_from_row(row, editorial_artist_schema)
            if _row_identity_is_banned(
                row,
                editorial_artist_schema,
                banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            ):
                editorial_artist_reasons["blacklisted_identity"] += 1
            elif _is_incomplete_composite_identity(
                row, editorial_artist_schema
            ):
                editorial_artist_reasons[
                    "composite_identity_without_complete_ids"
                ] += 1
            elif not _identity_pair_complete(pair):
                editorial_artist_reasons["incomplete_identity"] += 1
            elif pair not in eligible_artist_pairs:
                editorial_artist_reasons["not_referenced_by_strict_track"] += 1
            elif not _strict_public_classification_passes(
                row, editorial_artist_schema
            ):
                editorial_artist_reasons["classification_not_strict"] += 1
            elif not _public_artist_audience_is_bounded(
                row, editorial_artist_schema
            ):
                editorial_artist_reasons["size_unknown_or_too_large"] += 1
            else:
                retained_editorial_artists.append(row)
        if isinstance(editorial.get("artists"), list):
            editorial["artists"] = retained_editorial_artists
        removed["editorial.artists"] = sum(editorial_artist_reasons.values())

        editorial_track_schema = editorial.get("track_schema")
        editorial_track_schema = (
            list(editorial_track_schema)
            if isinstance(editorial_track_schema, list)
            else []
        )
        retained_editorial_tracks: list[Any] = []
        for row in editorial.get("tracks", []) if isinstance(editorial.get("tracks"), list) else []:
            spotify_id_before = _identity_pair_from_row(
                row, editorial_track_schema
            )[0]
            if not _strict_public_classification_passes(
                row, editorial_track_schema
            ):
                editorial_track_reasons["classification_not_strict"] += 1
            elif not _complete_editorial_track_pair(
                row,
                editorial_track_schema,
                public_pair_by_soundcharts_uuid,
            ) or not _row_links_to_public_track(
                row, editorial_track_schema, public_track_pairs
            ):
                editorial_track_reasons["not_linked_to_strict_track"] += 1
            else:
                editorial_track_ids_completed += int(not spotify_id_before)
                retained_editorial_tracks.append(row)
        if isinstance(editorial.get("tracks"), list):
            editorial["tracks"] = retained_editorial_tracks
        removed["editorial.tracks"] = sum(editorial_track_reasons.values())

    opportunity_schema = _schema(sanitized, "opportunities")
    opportunity_reasons = Counter()
    retained_opportunities: list[Any] = []
    seen_opportunity_spotify_ids: set[str] = set()
    contacts_scrubbed = 0
    opportunities_downgraded = 0
    for row in sanitized["opportunities"]:
        if _row_has_banned_credit_or_collaborator(
            row,
            opportunity_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            opportunity_reasons["blacklisted_identity"] += 1
            continue
        if not _structured_collaborators_complete(row, opportunity_schema):
            opportunity_reasons["incomplete_collaborators"] += 1
            continue
        spotify_track_id = str(
            _row_value(row, opportunity_schema, "spotify_id") or ""
        ).strip()
        if not spotify_track_id:
            opportunity_reasons["missing_spotify_track_id"] += 1
            continue
        if spotify_track_id in seen_opportunity_spotify_ids:
            opportunity_reasons["duplicate_spotify_track_id"] += 1
            continue
        status = _normalise_text(
            _row_value(row, opportunity_schema, "opportunity_status")
        )
        if status not in ALLOWED_OPPORTUNITY_STATUSES:
            opportunity_reasons["invalid_status"] += 1
            continue
        if status == "verified" and not _verified_opportunity_classification_passes(
            row, opportunity_schema
        ):
            _set_row_value(
                row, opportunity_schema, "opportunity_status", "needs_listen"
            )
            _set_row_value(
                row, opportunity_schema, "classification_status", "needs_listen"
            )
            status = "needs_listen"
            opportunities_downgraded += 1
        rights = _normalise_text(_row_value(row, opportunity_schema, "rights_status"))
        if rights in FORBIDDEN_RIGHTS:
            opportunity_reasons["major_or_mixed"] += 1
            continue
        contact_must_be_nonactionable = (
            status == "needs_listen"
            or rights not in CONTACTABLE_RIGHTS
            or not _opportunity_contact_gate_passes(row, opportunity_schema)
        )
        if contact_must_be_nonactionable:
            exposed_before_scrub = _opportunity_exposes_contact(
                row, opportunity_schema
            )
            _scrub_opportunity_contacts(row, opportunity_schema)
            # A snapshot must never be held hostage by a malformed legacy row,
            # but it must also never publish a contact whose underlying track
            # is not contactable.  Rows normally arrive as mutable JSON lists
            # or objects.  If an unusual shape prevents the scrub from taking
            # effect, quarantine that one opportunity instead of failing the
            # complete collection/publish cycle.
            if _opportunity_exposes_contact(row, opportunity_schema):
                opportunity_reasons["unscrubbable_contact"] += 1
                continue
            contacts_scrubbed += int(exposed_before_scrub)
        seen_opportunity_spotify_ids.add(spotify_track_id)
        retained_opportunities.append(row)
    sanitized["opportunities"] = retained_opportunities
    removed["opportunities"] = sum(opportunity_reasons.values())

    # Keep the broad, pre-gate browse projection, while applying the same
    # quarantine index as the strict collections.  Rebuilding from the strict
    # rows here would make newly scanned playlist/catalogue tracks disappear
    # until a later classification pass.
    sanitized["discovery_catalogue"] = _filter_discovery_catalogue_for_publication(
        full_discovery_catalogue,
        banned_names,
        banned_spotify_ids,
        banned_soundcharts_uuids,
    )
    _refresh_counts(sanitized, before_counts)
    validate_payload(sanitized)

    report: dict[str, Any] = {
        "before": before_counts,
        "after": {
            "artists": len(sanitized.get("artists", [])),
            "fal": len(sanitized.get("fal", [])),
            "tracks": len(sanitized.get("tracks", [])),
            "opportunities": len(sanitized["opportunities"]),
            "editorial.artists": len(editorial.get("artists", []))
            if isinstance(editorial, Mapping)
            else 0,
            "editorial.tracks": len(editorial.get("tracks", []))
            if isinstance(editorial, Mapping)
            else 0,
            "discovery.tracks": len(sanitized.get("discovery_catalogue", {}).get("tracks", []))
            if isinstance(sanitized.get("discovery_catalogue"), Mapping)
            else 0,
            "discovery.artists": len(sanitized.get("discovery_catalogue", {}).get("artists", []))
            if isinstance(sanitized.get("discovery_catalogue"), Mapping)
            else 0,
        },
        "removed": removed,
        "track_removal_reasons": dict(track_reasons),
        "artist_removal_reasons": dict(artist_reasons),
        "fal_removal_reasons": dict(fal_reasons),
        "editorial_artist_removal_reasons": dict(editorial_artist_reasons),
        "editorial_track_removal_reasons": dict(editorial_track_reasons),
        "editorial_track_spotify_ids_completed": editorial_track_ids_completed,
        "opportunity_removal_reasons": dict(opportunity_reasons),
        "opportunity_contacts_scrubbed": contacts_scrubbed,
        "opportunities_downgraded_to_needs_listen": opportunities_downgraded,
        "blacklisted_spotify_ids": len(banned_spotify_ids),
        "blacklisted_soundcharts_uuids": len(banned_soundcharts_uuids),
    }
    return sanitized, report


def _contains_gates(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            bool(re.search(r"\bgates\b", str(key), re.IGNORECASE))
            or _contains_gates(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_gates(item) for item in value)
    return isinstance(value, str) and bool(
        re.search(r"\bgates\b", value, re.IGNORECASE)
    )


def validate_payload(payload: Mapping[str, Any]) -> None:
    """Reject any payload that must not be activated publicly."""

    if not isinstance(payload, Mapping):
        raise SnapshotValidationError("Soundcharts payload must be a JSON object")
    opportunities = payload.get("opportunities")
    if not isinstance(opportunities, list):
        raise SnapshotValidationError("SC.opportunities must be present and be a list")
    if not opportunities:
        raise SnapshotValidationError("SC.opportunities must not be empty")
    for collection in ("artists", "tracks"):
        rows = payload.get(collection)
        if not isinstance(rows, list) or not rows:
            raise SnapshotValidationError(
                f"SC.{collection} must be present and non-empty"
            )
    editorial = payload.get("editorial")
    if not isinstance(editorial, Mapping):
        raise SnapshotValidationError("SC.editorial must be present")
    for collection in ("artists", "tracks"):
        rows = editorial.get(collection)
        if not isinstance(rows, list) or not rows:
            raise SnapshotValidationError(
                f"SC.editorial.{collection} must be present and non-empty"
            )
    discovery_catalogue = payload.get("discovery_catalogue")
    # Legacy collector fixtures and pre-projection payloads are still valid inputs
    # to the generic validator. Public snapshots always receive a discovery
    # catalogue in ``sanitize_payload`` before this function is called.
    if discovery_catalogue is not None:
        if not isinstance(discovery_catalogue, Mapping):
            raise SnapshotValidationError("SC.discovery_catalogue must be an object")
        for collection in ("artists", "tracks"):
            rows = discovery_catalogue.get(collection)
            if not isinstance(rows, list) or not rows:
                raise SnapshotValidationError(
                    f"SC.discovery_catalogue.{collection} must be present and non-empty"
                )
        forbidden_discovery_fields = {"contact_email", "contact_url", "email", "phone"}
        discovery_track_schema = discovery_catalogue.get("track_schema")
        discovery_artist_schema = discovery_catalogue.get("artist_schema")
        if not isinstance(discovery_track_schema, list) or not isinstance(discovery_artist_schema, list):
            raise SnapshotValidationError("SC.discovery_catalogue schemas are missing")
        if forbidden_discovery_fields.intersection(discovery_track_schema) or forbidden_discovery_fields.intersection(discovery_artist_schema):
            raise SnapshotValidationError("SC.discovery_catalogue exposes a contact field")
        for row in discovery_catalogue.get("tracks", []):
            if not isinstance(row, (list, tuple, Mapping)):
                raise SnapshotValidationError("SC.discovery_catalogue.tracks contains an invalid row")
            if not _nonempty(_row_value(row, discovery_track_schema, "soundcharts_uuid")):
                raise SnapshotValidationError("SC.discovery_catalogue track lacks Soundcharts UUID")
        for row in discovery_catalogue.get("artists", []):
            if not isinstance(row, (list, tuple, Mapping)):
                raise SnapshotValidationError("SC.discovery_catalogue.artists contains an invalid row")
            if not _nonempty(_row_value(row, discovery_artist_schema, "soundcharts_uuid")):
                raise SnapshotValidationError("SC.discovery_catalogue artist lacks Soundcharts UUID")
    gate_payload = {key: value for key, value in payload.items() if key != "discovery_catalogue"}
    if _contains_gates(gate_payload):
        raise SnapshotValidationError("forbidden Gates category/text remains")

    banned_names, banned_spotify_ids, banned_soundcharts_uuids = (
        _build_banned_identity_index(payload)
    )
    configured_banned_names = set(NORMALISED_PUBLIC_ARTIST_BLACKLIST)
    artist_schema = _schema(payload, "artists")
    artist_rows_by_pair = _public_artist_rows_by_pair(payload)
    track_schema = _schema(payload, "tracks")
    eligible_artist_pairs: set[tuple[str, str]] = set()
    public_track_pairs: set[tuple[str, str]] = set()
    for row in payload.get("tracks", []) if isinstance(payload.get("tracks"), list) else []:
        failure = _public_track_failure_reason(
            row,
            track_schema,
            artist_rows_by_pair,
            artist_schema,
            configured_banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        )
        if failure:
            raise SnapshotValidationError(
                f"SC.tracks contains non-public row: {failure}"
            )
        public_track_pairs.add(_identity_pair_from_row(row, track_schema))
        eligible_artist_pairs.update(
            _identity_pair_from_collaborator(collaborator)
            for collaborator in (_row_value(row, track_schema, "artists") or [])
        )

    for row in payload.get("artists", []) if isinstance(payload.get("artists"), list) else []:
        pair = _identity_pair_from_row(row, artist_schema)
        if _row_identity_is_banned(
            row,
            artist_schema,
            configured_banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            raise SnapshotValidationError("blacklisted identity remains in SC.artists")
        if not _identity_pair_complete(pair) or _is_incomplete_composite_identity(
            row, artist_schema
        ):
            raise SnapshotValidationError(
                "SC.artists contains incomplete/composite identity"
            )
        if pair not in eligible_artist_pairs:
            raise SnapshotValidationError(
                "SC.artists identity is not referenced by a strict public track"
            )
        if not _public_artist_audience_is_bounded(row, artist_schema):
            raise SnapshotValidationError(
                "SC.artists contains unknown/too-large audience"
            )

    fal_schema = _schema(payload, "fal")
    for row in payload.get("fal", []) if isinstance(payload.get("fal"), list) else []:
        pair = _identity_pair_from_row(row, fal_schema)
        if _row_identity_is_banned(
            row,
            fal_schema,
            configured_banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            raise SnapshotValidationError("blacklisted identity remains in SC.fal")
        if not _identity_pair_complete(pair) or _is_incomplete_composite_identity(
            row, fal_schema
        ):
            raise SnapshotValidationError("SC.fal contains incomplete/composite identity")
        if pair not in eligible_artist_pairs:
            raise SnapshotValidationError(
                "SC.fal identity is not referenced by a strict public track"
            )
        if not _public_artist_audience_is_bounded(row, fal_schema):
            raise SnapshotValidationError("SC.fal contains unknown/too-large audience")
        if not bool(_row_value(row, fal_schema, "qualifies")):
            raise SnapshotValidationError("SC.fal contains an unqualified candidate")
        if _normalise_text(
            _row_value(row, fal_schema, "rights_status")
        ) not in CONTACTABLE_RIGHTS:
            raise SnapshotValidationError("SC.fal lacks self-release/indie rights")

    if isinstance(editorial, Mapping):
        editorial_artist_schema = editorial.get("artist_schema")
        editorial_artist_schema = (
            list(editorial_artist_schema)
            if isinstance(editorial_artist_schema, list)
            else []
        )
        for row in editorial.get("artists", []) if isinstance(editorial.get("artists"), list) else []:
            pair = _identity_pair_from_row(row, editorial_artist_schema)
            if _row_identity_is_banned(
                row,
                editorial_artist_schema,
                configured_banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            ):
                raise SnapshotValidationError(
                    "blacklisted identity remains in SC.editorial.artists"
                )
            if not _identity_pair_complete(
                pair
            ) or _is_incomplete_composite_identity(
                row, editorial_artist_schema
            ):
                raise SnapshotValidationError(
                    "SC.editorial.artists contains incomplete/composite identity"
                )
            if pair not in eligible_artist_pairs:
                raise SnapshotValidationError(
                    "SC.editorial.artists is not referenced by a strict public track"
                )
            if not _strict_public_classification_passes(
                row, editorial_artist_schema
            ) or not _public_artist_audience_is_bounded(
                row, editorial_artist_schema
            ):
                raise SnapshotValidationError(
                    "SC.editorial.artists fails strict public classification/size"
                )

        editorial_track_schema = editorial.get("track_schema")
        editorial_track_schema = (
            list(editorial_track_schema)
            if isinstance(editorial_track_schema, list)
            else []
        )
        for row in editorial.get("tracks", []) if isinstance(editorial.get("tracks"), list) else []:
            if not _strict_public_classification_passes(
                row, editorial_track_schema
            ) or not _row_links_to_public_track(
                row,
                editorial_track_schema,
                public_track_pairs,
            ):
                raise SnapshotValidationError(
                    "SC.editorial.tracks is not a strict linked public track"
                )

    opportunity_schema = _schema(payload, "opportunities")
    seen_spotify_track_ids: set[str] = set()
    for row in opportunities:
        if not _structured_collaborators_complete(row, opportunity_schema):
            raise SnapshotValidationError(
                "SC.opportunities contains incomplete collaborator IDs"
            )
        if _row_has_banned_credit_or_collaborator(
            row,
            opportunity_schema,
            set(NORMALISED_PUBLIC_ARTIST_BLACKLIST),
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            raise SnapshotValidationError(
                "blacklisted identity remains in SC.opportunities"
            )
        spotify_track_id = str(
            _row_value(row, opportunity_schema, "spotify_id") or ""
        ).strip()
        if not spotify_track_id:
            raise SnapshotValidationError(
                "SC.opportunities contains a missing Spotify track ID"
            )
        if spotify_track_id in seen_spotify_track_ids:
            raise SnapshotValidationError(
                "SC.opportunities contains duplicate Spotify track IDs"
            )
        seen_spotify_track_ids.add(spotify_track_id)
        status = _normalise_text(
            _row_value(row, opportunity_schema, "opportunity_status")
        )
        if status not in ALLOWED_OPPORTUNITY_STATUSES:
            raise SnapshotValidationError(
                "SC.opportunities status must be verified or needs_listen"
            )
        if status == "verified" and not _verified_opportunity_classification_passes(
            row, opportunity_schema
        ):
            raise SnapshotValidationError(
                "verified SC.opportunities must pass genre/instrumental/AI classification"
            )
        rights = _normalise_text(_row_value(row, opportunity_schema, "rights_status"))
        if rights in FORBIDDEN_RIGHTS:
            raise SnapshotValidationError(
                "SC.opportunities contains major/mixed rights"
            )
        contact_status = _normalise_text(
            _row_value(row, opportunity_schema, "contact_status")
        )
        exposes_contact = _opportunity_exposes_contact(row, opportunity_schema)
        if exposes_contact and not _opportunity_contact_gate_passes(
            row, opportunity_schema
        ):
            raise SnapshotValidationError(
                "actionable contact fails instrumental/genre/rights/identity gates"
            )
        if status == "needs_listen" or rights not in CONTACTABLE_RIGHTS:
            if contact_status not in {"blocked", "enrich"}:
                raise SnapshotValidationError(
                    "needs_listen/unknown-rights contact must be blocked or enrich"
                )
            if exposes_contact:
                raise SnapshotValidationError(
                    "needs_listen/unknown-rights opportunity exposes contact data"
                )


def load_payload(path: Path | str) -> dict[str, Any]:
    source = Path(path)
    text = source.read_text(encoding="utf-8")
    if not text.startswith(SOUNDCHARTS_PREFIX):
        raise SnapshotValidationError(
            f"{source} does not start with {SOUNDCHARTS_PREFIX!r}"
        )
    json_text = text[len(SOUNDCHARTS_PREFIX) :].strip()
    if json_text.endswith(";"):
        json_text = json_text[:-1].rstrip()
    try:
        payload = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise SnapshotValidationError(f"invalid Soundcharts JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise SnapshotValidationError("Soundcharts payload must be a JSON object")
    return payload


def _utc_now(value: dt.datetime | None = None) -> dt.datetime:
    current = value or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        raise SnapshotError("snapshot timestamp must be timezone-aware")
    return current.astimezone(dt.timezone.utc)


def snapshot_filename(value: dt.datetime | None = None) -> str:
    return f"Spotify_Soundcharts_data_{_utc_now(value):%Y%m%dT%H%M%SZ}.js"


def prepare_snapshot(
    source: Path | str,
    *,
    output_dir: Path | str | None = None,
    now: dt.datetime | None = None,
) -> PreparationResult:
    source_path = Path(source).resolve()
    destination_dir = (
        Path(output_dir).resolve() if output_dir is not None else source_path.parent
    )
    if not destination_dir.is_dir():
        raise SnapshotError(f"output directory does not exist: {destination_dir}")
    output = destination_dir / snapshot_filename(now)
    if output == source_path:
        raise SnapshotError("snapshot output must differ from its source")
    if output.exists():
        raise SnapshotError(f"snapshot already exists; refusing overwrite: {output}")

    sanitized, report = sanitize_payload(load_payload(source_path))
    serialized = (
        SOUNDCHARTS_PREFIX
        + json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    # Validate both the wrapper and the exact serialized bytes before writing.
    if not serialized.startswith(SOUNDCHARTS_PREFIX):
        raise SnapshotValidationError("invalid Soundcharts wrapper prefix")
    parsed_round_trip = json.loads(
        serialized[len(SOUNDCHARTS_PREFIX) :].strip().rstrip(";")
    )
    validate_payload(parsed_round_trip)

    # Exclusive creation protects both an existing dated snapshot and the
    # source export from accidental overwrite.
    with output.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(serialized)
    return PreparationResult(source=source_path, output=output, report=report)


def _reference_filename(value: str) -> str:
    matches = SOUNDCHARTS_FILENAME_RE.findall(value)
    if len(matches) != 1:
        raise CompareAndSwapError(
            f"expected one Soundcharts filename in pointer, found {len(matches)}"
        )
    return matches[0]


def _validate_snapshot_basename(value: str, label: str) -> str:
    basename = _reference_filename(str(value))
    if not SNAPSHOT_BASENAME_RE.fullmatch(basename):
        raise CompareAndSwapError(f"invalid {label} Soundcharts filename: {value}")
    return basename


def current_snapshot_name(index_path: Path | str) -> str:
    """Return the sole existing Soundcharts filename referenced by the index."""

    index = Path(index_path).resolve()
    original = index.read_text(encoding="utf-8")
    references = list(SOUNDCHARTS_REFERENCE_RE.finditer(original))
    if len(references) != 1:
        raise CompareAndSwapError(
            f"expected exactly one Soundcharts src in {index}, found {len(references)}"
        )
    current_value = references[0].group("value")
    current_name = _validate_snapshot_basename(current_value, "current")
    current_path_text = current_value.split("?", 1)[0]
    current_export = (index.parent / current_path_text).resolve()
    if not current_export.is_file():
        raise CompareAndSwapError(f"current export is missing: {current_export}")
    return current_name


def activate_snapshot(
    index_path: Path | str,
    *,
    expected_old: str,
    new: str,
) -> Path:
    """CAS the sole Soundcharts filename in ``index_path``.

    The path/query around the filename is preserved.  The new export must
    already exist beside the old export, and both remain present afterwards.
    """

    index = Path(index_path).resolve()
    expected_name = _validate_snapshot_basename(expected_old, "expected-old")
    new_name = _validate_snapshot_basename(new, "new")
    if expected_name == new_name:
        raise CompareAndSwapError("new Soundcharts pointer equals expected old pointer")

    original = index.read_text(encoding="utf-8")
    references = list(SOUNDCHARTS_REFERENCE_RE.finditer(original))
    if len(references) != 1:
        raise CompareAndSwapError(
            f"expected exactly one Soundcharts src in {index}, found {len(references)}"
        )
    match = references[0]
    current_value = match.group("value")
    current_name = _reference_filename(current_value)
    if current_name != expected_name:
        raise CompareAndSwapError(
            f"Soundcharts pointer changed: expected {expected_name}, found {current_name}"
        )

    current_path_text = current_value.split("?", 1)[0]
    current_export = (index.parent / current_path_text).resolve()
    new_value = current_value.replace(current_name, new_name, 1)
    new_path_text = new_value.split("?", 1)[0]
    new_export = (index.parent / new_path_text).resolve()
    if not current_export.is_file():
        raise CompareAndSwapError(f"expected old export is missing: {current_export}")
    if not new_export.is_file():
        raise CompareAndSwapError(f"new export is missing: {new_export}")

    replacement = (
        match.group("quote") + new_value + match.group("quote")
    )
    updated = original[: match.start()] + replacement + original[match.end() :]

    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="",
            delete=False,
            dir=index.parent,
            prefix=f".{index.name}.",
            suffix=".tmp",
        ) as handle:
            temp_name = handle.name
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())

        # A second read immediately before the swap is the compare phase.  If
        # another publisher changed the pointer, the prepared temp is discarded.
        if index.read_text(encoding="utf-8") != original:
            raise CompareAndSwapError("index changed during activation")
        os.replace(temp_name, index)
        temp_name = None
    finally:
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)

    if not current_export.is_file():
        raise CompareAndSwapError("old export disappeared during activation")
    return new_export


def _parse_timestamp(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("timestamp must include a UTC offset or Z")
    return parsed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="mode", required=True)

    prepare = subparsers.add_parser(
        "prepare", help="create a sanitized UTC-dated root snapshot"
    )
    prepare.add_argument("--source", required=True, type=Path)
    prepare.add_argument(
        "--output-dir",
        type=Path,
        help="repository root (defaults to the source file's directory)",
    )
    prepare.add_argument(
        "--timestamp",
        type=_parse_timestamp,
        help="deterministic ISO timestamp for tests/recovery; defaults to now UTC",
    )

    activate = subparsers.add_parser(
        "activate", help="strictly swap spotify/index.html to a prepared snapshot"
    )
    activate.add_argument("--index", required=True, type=Path)
    activate.add_argument("--expected-old", required=True)
    activate.add_argument("--new", required=True)

    current = subparsers.add_parser(
        "current", help="print the existing Soundcharts snapshot referenced by the index"
    )
    current.add_argument("--index", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.mode == "prepare":
            result = prepare_snapshot(
                args.source,
                output_dir=args.output_dir,
                now=args.timestamp,
            )
            print(
                json.dumps(
                    {
                        "status": "prepared",
                        "source": str(result.source),
                        "output": str(result.output),
                        "report": result.report,
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        if args.mode == "current":
            print(current_snapshot_name(args.index))
            return 0

        activated = activate_snapshot(
            args.index,
            expected_old=args.expected_old,
            new=args.new,
        )
        print(json.dumps({"status": "activated", "export": str(activated)}))
        return 0
    except (OSError, ValueError, SnapshotError) as exc:
        parser = _build_parser()
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
