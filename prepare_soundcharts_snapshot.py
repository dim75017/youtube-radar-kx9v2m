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
        "rxseboy",
        "sody",
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
        _mentions_name(name, banned_names)
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
    for field in ("artist", "credit_name"):
        if _mentions_name(_row_value(row, schema, field), banned_names):
            return True
    collaborators = _row_value(row, schema, "artists")
    if isinstance(collaborators, list):
        return any(
            _identity_is_banned(
                _collaborator_identity(collaborator),
                banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            )
            for collaborator in collaborators
        )
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
            for field in ("email", "url", "contact_email", "contact_url")
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
        ):
            if field in collaborator:
                collaborator[field] = ""


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


def _filter_rows(rows: Any, keep: Any) -> tuple[list[Any], int]:
    if not isinstance(rows, list):
        return [], 0
    retained = [row for row in rows if keep(row)]
    return retained, len(rows) - len(retained)


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
            fal_coverage["resolved"] = sum(
                1
                for row in fal
                if _nonempty(_row_value(row, fal_schema, "spotify_id"))
                and _nonempty(_row_value(row, fal_schema, "soundcharts_uuid"))
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


def sanitize_payload(payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a public-safe copy and a deterministic removal report.

    Simple unresolved track credits remain in ``SC.tracks`` as staging data.
    A clearly composite unresolved credit is removed because it cannot safely
    represent several people as one artist.  Every opportunity, however, must
    have a non-empty structured collaborator list with both provider IDs.
    """

    if not isinstance(payload, Mapping):
        raise SnapshotValidationError("Soundcharts payload must be a JSON object")
    sanitized: dict[str, Any] = copy.deepcopy(dict(payload))
    if not isinstance(sanitized.get("opportunities"), list):
        raise SnapshotValidationError("SC.opportunities must be present and be a list")

    editorial = sanitized.get("editorial")
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
    }

    banned_names, banned_spotify_ids, banned_soundcharts_uuids = (
        _build_banned_identity_index(sanitized)
    )
    removed: dict[str, int] = {}

    for collection in ("artists", "fal"):
        schema = _schema(sanitized, collection)
        retained, removed_count = _filter_rows(
            sanitized.get(collection),
            lambda row, schema=schema: (
                not _row_identity_is_banned(
                    row,
                    schema,
                    banned_names,
                    banned_spotify_ids,
                    banned_soundcharts_uuids,
                )
                and not _is_incomplete_composite_identity(row, schema)
            ),
        )
        if isinstance(sanitized.get(collection), list):
            sanitized[collection] = retained
        removed[collection] = removed_count

    if isinstance(editorial, dict):
        artist_schema = editorial.get("artist_schema")
        artist_schema = list(artist_schema) if isinstance(artist_schema, list) else []
        retained, removed_count = _filter_rows(
            editorial.get("artists"),
            lambda row: (
                not _row_identity_is_banned(
                    row,
                    artist_schema,
                    banned_names,
                    banned_spotify_ids,
                    banned_soundcharts_uuids,
                )
                and not _is_incomplete_composite_identity(row, artist_schema)
            ),
        )
        if isinstance(editorial.get("artists"), list):
            editorial["artists"] = retained
        removed["editorial.artists"] = removed_count

        track_schema = editorial.get("track_schema")
        track_schema = list(track_schema) if isinstance(track_schema, list) else []
        retained, removed_count = _filter_rows(
            editorial.get("tracks"),
            lambda row: not _row_has_banned_credit_or_collaborator(
                row,
                track_schema,
                banned_names,
                banned_spotify_ids,
                banned_soundcharts_uuids,
            ),
        )
        if isinstance(editorial.get("tracks"), list):
            editorial["tracks"] = retained
        removed["editorial.tracks"] = removed_count

    track_schema = _schema(sanitized, "tracks")
    track_blacklist_removed = 0
    track_composite_unresolved_removed = 0
    retained_tracks: list[Any] = []
    for row in sanitized.get("tracks", []) if isinstance(sanitized.get("tracks"), list) else []:
        if _row_has_banned_credit_or_collaborator(
            row,
            track_schema,
            banned_names,
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            track_blacklist_removed += 1
            continue
        if _is_composite_credit(row, track_schema) and not _structured_collaborators_complete(
            row, track_schema
        ):
            track_composite_unresolved_removed += 1
            continue
        retained_tracks.append(row)
    if isinstance(sanitized.get("tracks"), list):
        sanitized["tracks"] = retained_tracks
    removed["tracks"] = track_blacklist_removed + track_composite_unresolved_removed

    opportunity_schema = _schema(sanitized, "opportunities")
    opportunity_reasons = Counter()
    retained_opportunities: list[Any] = []
    seen_opportunity_spotify_ids: set[str] = set()
    contacts_scrubbed = 0
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
        ai_risk = _normalise_text(_row_value(row, opportunity_schema, "ai_risk"))
        if ai_risk not in ALLOWED_AI_RISKS:
            opportunity_reasons["ai_risk_not_low"] += 1
            continue
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
            contacts_scrubbed += int(exposed_before_scrub)
        seen_opportunity_spotify_ids.add(spotify_track_id)
        retained_opportunities.append(row)
    sanitized["opportunities"] = retained_opportunities
    removed["opportunities"] = sum(opportunity_reasons.values())

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
        },
        "removed": removed,
        "track_removal_reasons": {
            "blacklisted_identity": track_blacklist_removed,
            "composite_credit_without_complete_ids": track_composite_unresolved_removed,
        },
        "opportunity_removal_reasons": dict(opportunity_reasons),
        "opportunity_contacts_scrubbed": contacts_scrubbed,
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
    if _contains_gates(payload):
        raise SnapshotValidationError("forbidden Gates category/text remains")

    banned_names, banned_spotify_ids, banned_soundcharts_uuids = (
        _build_banned_identity_index(payload)
    )
    # A blacklisted identity is allowed in the index only as one of the
    # configured seed strings, never in an exported entity.
    for collection in ("artists", "fal"):
        schema = _schema(payload, collection)
        rows = payload.get(collection)
        if isinstance(rows, list) and any(
            _row_identity_is_banned(
                row,
                schema,
                set(NORMALISED_PUBLIC_ARTIST_BLACKLIST),
                banned_spotify_ids,
                banned_soundcharts_uuids,
            )
            for row in rows
        ):
            raise SnapshotValidationError(
                f"blacklisted identity remains in SC.{collection}"
            )
        if isinstance(rows, list) and any(
            _is_incomplete_composite_identity(row, schema) for row in rows
        ):
            raise SnapshotValidationError(
                f"composite identity without both provider IDs remains in SC.{collection}"
            )

    editorial = payload.get("editorial")
    if isinstance(editorial, Mapping):
        artist_schema = editorial.get("artist_schema")
        artist_schema = list(artist_schema) if isinstance(artist_schema, list) else []
        if any(
            _row_identity_is_banned(
                row,
                artist_schema,
                set(NORMALISED_PUBLIC_ARTIST_BLACKLIST),
                banned_spotify_ids,
                banned_soundcharts_uuids,
            )
            for row in editorial.get("artists", [])
            if isinstance(editorial.get("artists"), list)
        ):
            raise SnapshotValidationError(
                "blacklisted identity remains in SC.editorial.artists"
            )
        if any(
            _is_incomplete_composite_identity(row, artist_schema)
            for row in editorial.get("artists", [])
            if isinstance(editorial.get("artists"), list)
        ):
            raise SnapshotValidationError(
                "composite identity without both provider IDs remains in SC.editorial.artists"
            )
        track_schema = editorial.get("track_schema")
        track_schema = list(track_schema) if isinstance(track_schema, list) else []
        if any(
            _row_has_banned_credit_or_collaborator(
                row,
                track_schema,
                set(NORMALISED_PUBLIC_ARTIST_BLACKLIST),
                banned_spotify_ids,
                banned_soundcharts_uuids,
            )
            for row in editorial.get("tracks", [])
            if isinstance(editorial.get("tracks"), list)
        ):
            raise SnapshotValidationError(
                "blacklisted identity remains in SC.editorial.tracks"
            )

    track_schema = _schema(payload, "tracks")
    for row in payload.get("tracks", []) if isinstance(payload.get("tracks"), list) else []:
        if _row_has_banned_credit_or_collaborator(
            row,
            track_schema,
            set(NORMALISED_PUBLIC_ARTIST_BLACKLIST),
            banned_spotify_ids,
            banned_soundcharts_uuids,
        ):
            raise SnapshotValidationError("blacklisted identity remains in SC.tracks")
        if _is_composite_credit(row, track_schema) and not _structured_collaborators_complete(
            row, track_schema
        ):
            raise SnapshotValidationError(
                "composite SC.tracks credit lacks complete structured collaborators"
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
        ai_risk = _normalise_text(_row_value(row, opportunity_schema, "ai_risk"))
        if ai_risk not in ALLOWED_AI_RISKS:
            raise SnapshotValidationError(
                "SC.opportunities ai_risk must be low/faible"
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
