#!/usr/bin/env python3
"""Build the Spotify browsing catalogue.

The Spotify Radar has two intentionally different data contracts:

* ``Toutes les pistes`` / ``Tous les artistes`` are inventory views. Their
  active projection contains the exact spreadsheet-backed catalogue of artists
  who already released with the label, plus fully evidenced external
  discoveries. Every visible track has at least 100,000 observed lifetime
  Spotify streams; lower or missing counters stay archived.
* ``Opportunités A&R`` and every contact/deal action remain fail-closed and are
  sourced exclusively from the sanitized ``window.SPOTIFY_SOUNDCHARTS`` export.

This script materializes the first contract into a separate public file.  It
also supports an explicit ``--strict-rebased`` migration mode. In that mode,
only exact Spotify track IDs present in the trusted internal spreadsheet may
use the internal-catalogue lane (100k stream floor only). Every external source
must pass the genre, instrumental, AI, rights, identity and stream-evidence
gates. Historical rows remain preserved in ``Spotify_Radar_data.js`` and Git
history as archive.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from prepare_soundcharts_snapshot import PUBLIC_ARTIST_BLACKLIST
from spotify_rights import reconciled_label, reconcile_rights

SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
BROWSE_PREFIX = "window.SPOTIFY_BROWSE_CATALOGUE="
VERSION = 1

TRACK_KEY_FIELDS = ("spotify_id", "soundcharts_uuid")
ARTIST_KEY_FIELDS = ("spotify_id", "soundcharts_uuid", "name")
NESTED_ARTIST_FIELDS = (
    "spotify_id",
    "soundcharts_uuid",
    "name",
    "role",
    "image_url",
)
FORBIDDEN_SCHEMA_FIELDS = {
    "contact_email",
    "contact_url",
    "contact_platform",
    "email",
    "phone",
    "phone_number",
}

TRUSTED_CATALOGUE_SOURCE_TIER = "trusted_internal_catalogue"
TRUSTED_CATALOGUE_AVAILABILITY = "catalogue_trusted"
PROMOTED_FAL_SOURCE_TIER = "soundcharts_fal_promoted"
MANUAL_ARCHIVE_STORAGE_KEY = "spotify_catalogue_archives_v1"
LOW_AI_RISKS = frozenset({"low", "faible"})
REVIEW_AI_RISKS = frozenset(
    {"", "unknown", "a verifier", "à vérifier", "a classifier", "à classifier", "pending", "review"}
)


# These are the accepted provenance paths for the staged rebaseline.  Source
# provenance is necessary but never sufficient: every row still passes all of
# the strict evidence gates below. A publisher profile may be added only after
# its playlists have been reviewed and declared in the collector configuration.
STRICT_SOURCE_TIERS = {
    TRUSTED_CATALOGUE_SOURCE_TIER,
    # This provenance is assigned only after the private FAL review manifest
    # has all required evidence and an explicit promotion has been approved.
    PROMOTED_FAL_SOURCE_TIER,
    "editorial_playlist",
    # These are playlist-discovery sources. They remain subject to every
    # strict genre, instrumental, AI, rights and identity gate below.
    "independent_playlist",
    "instrumental_editorial_daily",
    "playlist_artist_catalogue",
}
STRICT_GENRES = {
    "lofi_hip_hop",
    "guitar",
    "piano",
    "acoustic",
    "fingerstyle",
    "ambient",
    "dark_ambient",
    "nature",
    "soundscape",
    "jazz_jazzhop",
    "classical",
    "halloween_lofi",
    "christmas_lofi",
    "instrumental_phonk",
    "phonk_instrumental",
    "instrumental_dnb",
    "dnb_instrumental",
}
STRICT_RIGHTS = {"self_released", "independent_label"}
MIN_STRICT_CONFIDENCE = 0.5
MIN_TRACK_LIFETIME_STREAMS = 100_000
COMPOSITE_CREDIT = re.compile(r"(?:\s(?:&|feat\.?|featuring|ft\.?|x|×)\s|,)", re.IGNORECASE)

EVIDENCE_FIELDS = {
    "primary_genre": {
        "confidence": "genre_confidence",
        "weak": {
            "unknown", "unclassified", "other", "other_undefined",
            "to_classify", "a_classifier", "trusted_catalogue",
        },
        "blocking": set(),
    },
    "instrumental_status": {
        "confidence": "instrumental_confidence",
        "weak": {"unknown", "to_verify", "a_verifier", "trusted_catalogue"},
        "blocking": {"vocal"},
    },
    "ai_risk": {
        "confidence": "ai_risk_score",
        "weak": {"unknown", "to_verify", "a_verifier"},
        "blocking": {"high"},
    },
    "rights_status": {
        "confidence": "rights_confidence",
        "weak": {
            "unknown", "unverified", "to_verify", "a_verifier",
            "catalogue_trusted", "trusted_catalogue",
        },
        "blocking": {"major"},
    },
}

IDENTITY_FIELDS = {"spotify_id", "soundcharts_uuid"}

PROTECTED_REVIEW_TRACK_FIELDS = (
    "spotify_id",
    "soundcharts_uuid",
    "title",
    "credit_name",
    "streams",
    "streams_source_date",
    "primary_genre",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "rights_status",
    "source_tier",
)


class BrowseCatalogueError(RuntimeError):
    """Raised when a usable broad catalogue cannot be produced safely."""


def _read_payload(path: Path, prefix: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise BrowseCatalogueError(f"{path} does not start with {prefix[:-1]}")
    try:
        payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise BrowseCatalogueError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise BrowseCatalogueError(f"{path} does not contain an object payload")
    return payload


def _write_payload(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(
        BROWSE_PREFIX
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    try:
        parsed = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _latest_performance_point(entry: Any) -> tuple[str, float] | None:
    """Return the newest factual cumulative stream point from Performance."""

    if not isinstance(entry, Mapping):
        return None
    latest: tuple[dt.date, float] | None = None
    history = entry.get("history")
    for point in history if isinstance(history, list) else []:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            day = dt.date.fromisoformat(str(point[0])[:10])
        except ValueError:
            continue
        total = _finite_number(point[1])
        if total is None or total < 0:
            continue
        if latest is None or day > latest[0]:
            latest = (day, total)
    if latest is None:
        return None
    return latest[0].isoformat(), latest[1]


def _overlay_latest_performance_streams(
    track_records: Sequence[dict[str, Any]],
    performance_tracks: Mapping[str, Any] | None,
) -> int:
    """Refresh candidate counters before the 100k active-catalogue gate.

    Performance may update only a source-backed catalogue row.  An orphan
    Performance identity is never promoted on its own because it lacks the
    classification, rights and artist evidence required by the catalogue.
    """

    if not isinstance(performance_tracks, Mapping):
        return 0
    by_soundcharts: dict[str, list[Any]] = {}
    for spotify_id, entry in performance_tracks.items():
        if not isinstance(entry, Mapping):
            continue
        soundcharts_uuid = str(entry.get("soundcharts_uuid") or "").strip()
        if soundcharts_uuid:
            by_soundcharts.setdefault(soundcharts_uuid, []).append(entry)

    applied = 0
    for row in track_records:
        spotify_id = str(row.get("spotify_id") or "").strip()
        soundcharts_uuid = str(row.get("soundcharts_uuid") or "").strip()
        entry = performance_tracks.get(spotify_id) if spotify_id else None
        if not isinstance(entry, Mapping) and soundcharts_uuid:
            uuid_matches = by_soundcharts.get(soundcharts_uuid, [])
            if len(uuid_matches) == 1:
                entry = uuid_matches[0]
        latest = _latest_performance_point(entry)
        if latest is None:
            continue
        latest_day, latest_total = latest
        source_day = str(
            row.get("streams_source_date") or row.get("source_date") or ""
        )[:10]
        # A newer source snapshot wins.  On the same day Performance is the
        # authoritative history used by every Analytics surface.
        if source_day and source_day > latest_day:
            continue
        row["streams"] = int(latest_total) if latest_total.is_integer() else latest_total
        if "streams_source_date" in row:
            row["streams_source_date"] = latest_day
        applied += 1
    return applied


def _spotify_id_from_url(value: Any) -> str:
    match = re.search(
        r"spotify\.com/(?:intl-[^/?#]+/)?track/([A-Za-z0-9]+)",
        str(value or ""),
    )
    return match.group(1) if match else ""


def _trusted_catalogue_from_csv(path: Path, artist_seeds_path: Path | None) -> dict[str, Any]:
    """Read the internal catalogue without importing contacts or credentials.

    The spreadsheet is the business-approved cohort of artists who already
    released with the label. Exact track IDs from this file are eligible for
    inventory browsing once they reach the lifetime-stream floor. This trust
    never grants A&R opportunity, contact or automatic-expansion eligibility.
    """
    artist_ids: dict[str, str] = {}
    if artist_seeds_path and artist_seeds_path.exists():
        try:
            seeds = json.loads(artist_seeds_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BrowseCatalogueError(f"{artist_seeds_path} contains invalid JSON") from exc
        for row in seeds.get("artists", []) if isinstance(seeds, Mapping) else []:
            if not isinstance(row, Mapping):
                continue
            name = str(row.get("name") or "").strip()
            spotify_id = str(row.get("spotify_id") or "").strip()
            if name and spotify_id:
                artist_ids[name.casefold()] = spotify_id

    track_schema = [
        "spotify_id", "soundcharts_uuid", "title", "credit_name", "artists",
        "artist_soundcharts_uuids", "release_date", "streams", "streams_delta_24h",
        "rights_status", "rights_confidence", "label", "copyright", "primary_genre",
        "subgenres", "genre_confidence", "instrumental_status", "instrumental_confidence",
        "ai_risk", "availability_status", "source_tier", "metadata_status", "image_url",
        "playlist_ids", "playlist_names", "playlist_count", "playlist_best_position",
        "playlist_followers_total", "playlist_placements", "discovered_at", "updated_at",
        "review_reasons",
    ]
    artist_schema = [
        "name", "spotify_id", "soundcharts_uuid", "monthly_listeners", "primary_genre",
        "subgenres", "genre_confidence", "instrumental_status", "instrumental_confidence",
        "ai_risk", "availability_status", "source_tier", "image_url",
    ]
    tracks: list[dict[str, Any]] = []
    artists: dict[str, dict[str, Any]] = {}
    track_index_by_spotify: dict[str, int] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for raw in csv.DictReader(handle):
            artist_name = str(raw.get("Artiste") or "").strip()
            title = str(raw.get("Track") or "").strip()
            spotify_id = _spotify_id_from_url(raw.get("Lien Spotify"))
            if not artist_name or not title or not spotify_id:
                continue
            streams = _finite_number(raw.get("Streams"))
            if spotify_id in track_index_by_spotify:
                # The source sheet can contain the same Spotify track under
                # more than one affiliated-artist row. Keep one canonical
                # identity and the largest observed lifetime counter so row
                # order cannot incorrectly move it below the public floor.
                existing = tracks[track_index_by_spotify[spotify_id]]
                previous_streams = _finite_number(existing.get("streams"))
                if streams is not None and (
                    previous_streams is None or streams > previous_streams
                ):
                    existing["streams"] = streams
                continue
            artist_spotify_id = artist_ids.get(artist_name.casefold(), "")
            status = str(raw.get("Statut") or "").strip().casefold()
            raw_rights = "self_released" if status == "self-released" else "catalogue_trusted"
            raw_label = str(raw.get("Label / Copyright") or "").strip()
            rights_status, rights_confidence, _ = reconcile_rights(
                raw_rights, raw_label, raw_label
            )
            artist = {
                "name": artist_name, "spotify_id": artist_spotify_id, "soundcharts_uuid": "",
                "monthly_listeners": None, "primary_genre": "trusted_catalogue", "subgenres": [],
                "genre_confidence": None, "instrumental_status": "trusted_catalogue",
                "instrumental_confidence": None, "ai_risk": "unknown",
                "availability_status": TRUSTED_CATALOGUE_AVAILABILITY,
                "source_tier": TRUSTED_CATALOGUE_SOURCE_TIER, "image_url": "",
            }
            artists.setdefault(artist_name.casefold(), artist)
            tracks.append({
                "spotify_id": spotify_id, "soundcharts_uuid": "", "title": title,
                "credit_name": artist_name,
                "artists": [{"name": artist_name, "spotify_id": artist_spotify_id, "soundcharts_uuid": "", "role": "primary", "image_url": ""}],
                "artist_soundcharts_uuids": [], "release_date": str(raw.get("Date") or "").strip(),
                "streams": streams, "streams_delta_24h": None,
                "rights_status": rights_status, "rights_confidence": rights_confidence,
                "label": reconciled_label(raw_label, raw_label),
                "copyright": raw_label,
                "primary_genre": "trusted_catalogue", "subgenres": [], "genre_confidence": None,
                "instrumental_status": "trusted_catalogue", "instrumental_confidence": None,
                "ai_risk": "unknown", "availability_status": TRUSTED_CATALOGUE_AVAILABILITY,
                "source_tier": TRUSTED_CATALOGUE_SOURCE_TIER, "metadata_status": "internal_catalogue",
                "image_url": "", "playlist_ids": [], "playlist_names": [], "playlist_count": 0,
                "playlist_best_position": None, "playlist_followers_total": None,
                "playlist_placements": [], "discovered_at": "", "updated_at": "", "review_reasons": [],
            })
            track_index_by_spotify[spotify_id] = len(tracks) - 1
    if not tracks:
        raise BrowseCatalogueError(f"Trusted catalogue {path} yielded no valid Spotify tracks")
    return {
        "version": VERSION, "generated_at": "", "track_schema": track_schema,
        "artist_schema": artist_schema, "playlist_schema": [], "tracks": tracks,
        "artists": list(artists.values()),
    }


def _record(row: Any, schema: Sequence[str]) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    if not isinstance(row, (list, tuple)):
        return {}
    return {
        name: row[index] if index < len(row) else None
        for index, name in enumerate(schema)
    }


def _meaningful(value: Any) -> bool:
    return value not in (None, "") and value != [] and value != {}


def _merge_unique(*values: Any) -> list[Any]:
    out: list[Any] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, list):
            continue
        for item in value:
            marker = json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
            if marker in seen:
                continue
            seen.add(marker)
            out.append(item)
    return out


def _clean_nested_artists(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, Mapping):
            continue
        clean = {
            field: item.get(field)
            for field in NESTED_ARTIST_FIELDS
            if _meaningful(item.get(field))
        }
        if clean.get("spotify_id") or clean.get("soundcharts_uuid") or clean.get("name"):
            rows.append(clean)
    return rows


def _evidence_key(value: Any) -> str:
    return re.sub(r"[\s/-]+", "_", str(value or "").strip().casefold())


def _evidence_choice(
    field: str,
    previous: Any,
    incoming: Any,
    previous_confidence: Any = None,
    incoming_confidence: Any = None,
) -> str:
    """Choose the safer evidence without letting an unknown erase a proof.

    Explicit negative evidence is sticky because accepting a later positive or
    unknown row would silently re-enable a vocal, high-AI-risk or major-label
    record. Other conflicting evidence changes only when the incoming source
    carries at least as much numeric confidence.
    """
    if not _meaningful(incoming):
        return "previous"
    if not _meaningful(previous):
        return "incoming"
    policy = EVIDENCE_FIELDS[field]
    old_key = _evidence_key(previous)
    new_key = _evidence_key(incoming)
    blockers = policy["blocking"]
    if old_key in blockers:
        return "previous"
    if new_key in blockers:
        return "incoming"
    old_weak = old_key in policy["weak"]
    new_weak = new_key in policy["weak"]
    if new_weak and not old_weak:
        return "previous"
    if old_weak and not new_weak:
        return "incoming"
    if old_key == new_key:
        return "incoming"
    old_confidence = _finite_number(previous_confidence)
    new_confidence = _finite_number(incoming_confidence)
    if new_confidence is not None and (
        old_confidence is None or new_confidence >= old_confidence
    ):
        return "incoming"
    return "previous"


def _merge_evidence_pair(
    merged: dict[str, Any],
    previous: Mapping[str, Any],
    incoming: Mapping[str, Any],
    field: str,
) -> None:
    policy = EVIDENCE_FIELDS[field]
    confidence_field = str(policy["confidence"])
    old_value = previous.get(field)
    new_value = incoming.get(field)
    old_confidence = previous.get(confidence_field)
    new_confidence = incoming.get(confidence_field)
    choice = _evidence_choice(
        field,
        old_value,
        new_value,
        old_confidence,
        new_confidence,
    )
    selected = new_value if choice == "incoming" else old_value
    if _meaningful(selected):
        merged[field] = selected

    if _evidence_key(old_value) == _evidence_key(new_value):
        confidences = [
            value
            for value in (
                _finite_number(old_confidence),
                _finite_number(new_confidence),
            )
            if value is not None
        ]
        if confidences:
            merged[confidence_field] = max(confidences)
        return
    selected_confidence = new_confidence if choice == "incoming" else old_confidence
    if _meaningful(selected_confidence):
        merged[confidence_field] = selected_confidence
    elif confidence_field in merged and not _meaningful(merged.get(confidence_field)):
        merged.pop(confidence_field, None)


def _manifest_spotify_ids(value: Any) -> frozenset[str]:
    ids: set[str] = set()
    for item in value if isinstance(value, list) else []:
        spotify_id = (
            str(item.get("spotify_id") or "").strip()
            if isinstance(item, Mapping)
            else str(item or "").strip()
        )
        if spotify_id:
            ids.add(spotify_id)
    return frozenset(ids)


def _read_exclusions(path: Path) -> dict[str, frozenset[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BrowseCatalogueError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, Mapping):
        raise BrowseCatalogueError(f"{path} does not contain an exclusion object")
    return {
        "artist_spotify_ids": _manifest_spotify_ids(
            payload.get("artist_spotify_ids")
        ),
        "track_spotify_ids": _manifest_spotify_ids(
            payload.get("track_spotify_ids")
        ),
    }


def _merge_nested_artist(
    previous: Mapping[str, Any], incoming: Mapping[str, Any]
) -> dict[str, Any]:
    merged = dict(previous)
    for field, value in incoming.items():
        if not _meaningful(value):
            continue
        old_value = merged.get(field)
        if (
            field in IDENTITY_FIELDS
            and _meaningful(old_value)
            and str(old_value).strip() != str(value).strip()
        ):
            continue
        merged[field] = value
    return merged


def _row_key(record: Mapping[str, Any], fields: Sequence[str]) -> str:
    for field in fields:
        value = str(record.get(field) or "").strip()
        if value:
            return f"{field}:{value.casefold() if field == 'name' else value}"
    return ""


def _reconcile_track_rights(record: Mapping[str, Any]) -> dict[str, Any]:
    reconciled = dict(record)
    previous_status = reconciled.get("rights_status")
    rights_status, rights_confidence, licensee = reconcile_rights(
        previous_status,
        reconciled.get("label"),
        reconciled.get("copyright"),
        reconciled.get("rights_confidence"),
    )
    if licensee:
        reconciled["rights_status"] = rights_status
        if rights_confidence is not None:
            reconciled["rights_confidence"] = rights_confidence
        reconciled["label"] = reconciled_label(
            reconciled.get("label"),
            reconciled.get("copyright"),
        )
    elif _meaningful(previous_status):
        reconciled["rights_status"] = rights_status
    return reconciled


def _merge_record(previous: Mapping[str, Any], incoming: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(previous)
    evidence_fields = set(EVIDENCE_FIELDS)
    evidence_confidence_fields = {
        str(policy["confidence"])
        for policy in EVIDENCE_FIELDS.values()
    }
    list_fields = {
        "artists",
        "subgenres",
        "review_reasons",
        "playlist_ids",
        "playlist_names",
        "playlist_placements",
        "discovery_source_playlist_ids",
        "discovery_source_playlist_names",
        "artist_soundcharts_uuids",
    }
    first_seen_fields = {"playlist_first_seen_at", "discovered_at"}
    last_seen_fields = {"playlist_last_seen_at", "updated_at", "last_catalogue_scan_at"}
    for field, value in incoming.items():
        if field in list_fields:
            if field == "artists":
                old = _clean_nested_artists(merged.get(field))
                new = _clean_nested_artists(value)
                by_key: dict[str, dict[str, Any]] = {}
                for artist in [*old, *new]:
                    key = _row_key(artist, ARTIST_KEY_FIELDS)
                    if key:
                        by_key[key] = _merge_nested_artist(
                            by_key.get(key, {}), artist
                        )
                merged[field] = list(by_key.values())
            else:
                merged[field] = _merge_unique(merged.get(field), value)
            continue
        if field in evidence_fields or field in evidence_confidence_fields:
            continue
        if field in IDENTITY_FIELDS:
            old_value = merged.get(field)
            if (
                _meaningful(old_value)
                and _meaningful(value)
                and str(old_value).strip() != str(value).strip()
            ):
                reason = f"identity_conflict:{field}"
                merged["review_reasons"] = _merge_unique(
                    merged.get("review_reasons"), [reason]
                )
                continue
        if field in first_seen_fields:
            candidates = [str(v) for v in (merged.get(field), value) if v]
            merged[field] = min(candidates) if candidates else ""
            continue
        if field in last_seen_fields:
            candidates = [str(v) for v in (merged.get(field), value) if v]
            merged[field] = max(candidates) if candidates else ""
            continue
        if field == "playlist_best_position":
            numbers = [
                number
                for number in (_finite_number(merged.get(field)), _finite_number(value))
                if number is not None and number > 0
            ]
            merged[field] = int(min(numbers)) if numbers else None
            continue
        if field in {"playlist_count", "playlist_followers_total", "catalogue_tracks_discovered", "track_count"}:
            numbers = [
                number
                for number in (_finite_number(merged.get(field)), _finite_number(value))
                if number is not None
            ]
            merged[field] = int(max(numbers)) if numbers else 0
            continue
        if _meaningful(value):
            merged[field] = value
    for field in EVIDENCE_FIELDS:
        _merge_evidence_pair(merged, previous, incoming, field)
    if "artists" in merged:
        merged["artists"] = _clean_nested_artists(merged.get("artists"))
    return merged


def _schema_union(catalogues: Iterable[Mapping[str, Any]], key: str) -> list[str]:
    out: list[str] = []
    for catalogue in catalogues:
        schema = catalogue.get(key)
        for name in schema if isinstance(schema, list) else []:
            text = str(name)
            if text in FORBIDDEN_SCHEMA_FIELDS or text in out:
                continue
            out.append(text)
    return out


def _extract_catalogue(payload: Mapping[str, Any]) -> dict[str, Any]:
    existing = payload.get("discovery_catalogue")
    if isinstance(existing, Mapping) and isinstance(existing.get("tracks"), list):
        return dict(existing)
    try:
        from prepare_soundcharts_snapshot import _build_discovery_catalogue

        built = _build_discovery_catalogue(payload)
    except (ImportError, AttributeError, RuntimeError, TypeError, ValueError) as exc:
        raise BrowseCatalogueError("Could not build discovery catalogue") from exc
    if not isinstance(built, dict):
        raise BrowseCatalogueError("Discovery catalogue builder returned a non-object")
    return built


def _normalise_catalogue(catalogue: Mapping[str, Any]) -> dict[str, Any]:
    track_schema = [
        str(name)
        for name in catalogue.get("track_schema", [])
        if str(name) not in FORBIDDEN_SCHEMA_FIELDS
    ]
    artist_schema = [
        str(name)
        for name in catalogue.get("artist_schema", [])
        if str(name) not in FORBIDDEN_SCHEMA_FIELDS
    ]
    playlist_schema = [str(name) for name in catalogue.get("playlist_schema", [])]
    tracks = [
        _record(row, track_schema)
        for row in catalogue.get("tracks", [])
        if isinstance(catalogue.get("tracks"), list)
    ]
    artists = [
        _record(row, artist_schema)
        for row in catalogue.get("artists", [])
        if isinstance(catalogue.get("artists"), list)
    ]
    for track in tracks:
        if "artists" in track:
            track["artists"] = _clean_nested_artists(track.get("artists"))
    return {
        "version": int(_finite_number(catalogue.get("version")) or VERSION),
        "generated_at": str(catalogue.get("generated_at") or ""),
        "track_schema": track_schema,
        "artist_schema": artist_schema,
        "playlist_schema": playlist_schema,
        "track_records": [row for row in tracks if _row_key(row, TRACK_KEY_FIELDS)],
        "artist_records": [row for row in artists if _row_key(row, ARTIST_KEY_FIELDS)],
    }


def _read_protected_review_cohorts(path: Path) -> list[dict[str, Any]]:
    """Materialize immutable review cohorts without adding them to browse.

    This is an audit/recovery lane. Exact IDs remain available to later
    classification jobs, but the lane never grants instrumental, AI, rights,
    A&R or contact eligibility.
    """
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BrowseCatalogueError(f"{path} contains invalid JSON") from exc
    raw_cohorts = manifest.get("cohorts") if isinstance(manifest, Mapping) else None
    if not isinstance(raw_cohorts, list):
        raise BrowseCatalogueError(f"{path} does not contain a cohorts list")

    cohorts: list[dict[str, Any]] = []
    for definition in raw_cohorts:
        if not isinstance(definition, Mapping):
            continue
        cohort_id = str(definition.get("id") or "").strip()
        source_name = str(definition.get("source_snapshot") or "").strip()
        if not cohort_id or not source_name:
            raise BrowseCatalogueError(
                f"{path} has a protected cohort without id/source_snapshot"
            )
        source_path = path.parent / source_name
        if not source_path.exists():
            raise BrowseCatalogueError(
                f"Protected review source does not exist: {source_path}"
            )
        source_payload = _read_payload(source_path, SOUNDCHARTS_PREFIX)
        catalogue = _normalise_catalogue(_extract_catalogue(source_payload))
        genre = str(definition.get("primary_genre") or "").strip()
        minimum_streams = int(
            _finite_number(definition.get("minimum_lifetime_streams")) or 0
        )
        by_spotify_id: dict[str, dict[str, Any]] = {}
        for row in catalogue["track_records"]:
            spotify_id = str(row.get("spotify_id") or "").strip()
            streams = _finite_number(row.get("streams"))
            if not spotify_id or streams is None or streams < minimum_streams:
                continue
            if genre and str(row.get("primary_genre") or "") != genre:
                continue
            compact = {
                field: row.get(field)
                for field in PROTECTED_REVIEW_TRACK_FIELDS
            }
            previous = by_spotify_id.get(spotify_id)
            if previous is None or streams > float(
                _finite_number(previous.get("streams")) or -1
            ):
                by_spotify_id[spotify_id] = compact

        expected_count = int(
            _finite_number(definition.get("expected_track_count")) or 0
        )
        if expected_count and len(by_spotify_id) != expected_count:
            raise BrowseCatalogueError(
                f"Protected cohort {cohort_id} expected {expected_count} tracks, "
                f"found {len(by_spotify_id)}"
            )
        records = [by_spotify_id[key] for key in sorted(by_spotify_id)]
        cohorts.append({
            "id": cohort_id,
            "label": str(definition.get("label") or cohort_id),
            "source_snapshot": source_name,
            "baseline_generated_at": str(
                source_payload.get("generated_at")
                or catalogue.get("generated_at")
                or ""
            ),
            "review_state": str(
                definition.get("review_state") or "evidence_required"
            ),
            "allow_automatic_active_promotion": False,
            "contactable": False,
            "track_schema": list(PROTECTED_REVIEW_TRACK_FIELDS),
            "tracks": [
                [record.get(field) for field in PROTECTED_REVIEW_TRACK_FIELDS]
                for record in records
            ],
            "spotify_ids": sorted(by_spotify_id),
            "track_count": len(records),
        })
    return cohorts


def _availability_rank(value: Any) -> int:
    return {
        "verified": 0,
        "measured": 1,
        TRUSTED_CATALOGUE_AVAILABILITY: 1,
        "needs_listen": 2,
        "playlist_discovered": 3,
        "catalogue_discovered": 4,
        "discovered": 5,
    }.get(str(value or "").casefold(), 6)


def merge_catalogues(catalogues: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    normalised = [_normalise_catalogue(catalogue) for catalogue in catalogues]
    track_schema = _schema_union(catalogues, "track_schema")
    for field in ("ai_review_required", "opportunity_eligible"):
        if field not in track_schema:
            track_schema.append(field)
    artist_schema = _schema_union(catalogues, "artist_schema")
    playlist_schema = _schema_union(catalogues, "playlist_schema")

    tracks: list[dict[str, Any]] = []
    artists: list[dict[str, Any]] = []
    track_by_spotify: dict[str, int] = {}
    track_by_soundcharts: dict[str, int] = {}
    artist_by_spotify: dict[str, int] = {}
    artist_by_soundcharts: dict[str, int] = {}
    artist_by_name: dict[str, int] = {}

    def upsert_track(row: Mapping[str, Any]) -> None:
        reconciled_row = _reconcile_track_rights(row)
        spotify = str(reconciled_row.get("spotify_id") or "").strip()
        soundcharts = str(reconciled_row.get("soundcharts_uuid") or "").strip()
        index = track_by_spotify.get(spotify) if spotify else None
        if index is None and soundcharts:
            index = track_by_soundcharts.get(soundcharts)
        if index is None:
            index = len(tracks)
            tracks.append(reconciled_row)
        else:
            tracks[index] = _reconcile_track_rights(
                _merge_record(tracks[index], reconciled_row)
            )
        merged = tracks[index]
        spotify = str(merged.get("spotify_id") or "").strip()
        soundcharts = str(merged.get("soundcharts_uuid") or "").strip()
        if spotify:
            track_by_spotify[spotify] = index
        if soundcharts:
            track_by_soundcharts[soundcharts] = index

    def upsert_artist(row: Mapping[str, Any]) -> None:
        spotify = str(row.get("spotify_id") or "").strip()
        soundcharts = str(row.get("soundcharts_uuid") or "").strip()
        name = str(row.get("name") or "").strip().casefold()
        index = artist_by_spotify.get(spotify) if spotify else None
        if index is None and soundcharts:
            index = artist_by_soundcharts.get(soundcharts)
        if index is None and name:
            index = artist_by_name.get(name)
        if index is None:
            index = len(artists)
            artists.append(dict(row))
        else:
            artists[index] = _merge_record(artists[index], row)
        merged = artists[index]
        spotify = str(merged.get("spotify_id") or "").strip()
        soundcharts = str(merged.get("soundcharts_uuid") or "").strip()
        name = str(merged.get("name") or "").strip().casefold()
        if spotify:
            artist_by_spotify[spotify] = index
        if soundcharts:
            artist_by_soundcharts[soundcharts] = index
        if name:
            artist_by_name[name] = index

    for catalogue in normalised:
        for row in catalogue["track_records"]:
            upsert_track(row)
        for row in catalogue["artist_records"]:
            upsert_artist(row)

    tracks.sort(
        key=lambda row: (
            _availability_rank(row.get("availability_status")),
            0 if _finite_number(row.get("streams")) is not None else 1,
            -float(_finite_number(row.get("streams_delta_24h")) or 0),
            -float(_finite_number(row.get("streams")) or 0),
            str(row.get("title") or "").casefold(),
        )
    )
    artists.sort(
        key=lambda row: (
            _availability_rank(row.get("availability_status")),
            -float(_finite_number(row.get("monthly_listeners")) or 0),
            str(row.get("name") or "").casefold(),
        )
    )

    def compact(row: Mapping[str, Any], schema: Sequence[str]) -> list[Any]:
        return [row.get(name) for name in schema]

    counts = {
        "tracks": len(tracks),
        "artists": len(artists),
        "measured_tracks": sum(_finite_number(row.get("streams")) is not None for row in tracks),
        "playlist_tracks": sum(int(_finite_number(row.get("playlist_count")) or 0) > 0 for row in tracks),
        "catalogue_tracks": sum(str(row.get("source_tier") or "") == "playlist_artist_catalogue" for row in tracks),
        "verified_tracks": sum(str(row.get("availability_status") or "") == "verified" for row in tracks),
    }
    generated = max(
        (str(item.get("generated_at") or "") for item in normalised),
        default="",
    )
    return {
        "version": VERSION,
        "generated_at": generated,
        "track_schema": track_schema,
        "artist_schema": artist_schema,
        "playlist_schema": playlist_schema,
        "tracks": [compact(row, track_schema) for row in tracks],
        "artists": [compact(row, artist_schema) for row in artists],
        "counts": counts,
    }


def _row_artist_spotify_ids(row: Mapping[str, Any]) -> set[str]:
    return {
        str(artist.get("spotify_id") or "").strip()
        for artist in _clean_nested_artists(row.get("artists"))
        if str(artist.get("spotify_id") or "").strip()
    }


def _strict_rebaseline_reason(
    row: Mapping[str, Any],
    minimum_streams: int = MIN_TRACK_LIFETIME_STREAMS,
    trusted_internal_spotify_ids: set[str] | frozenset[str] | None = None,
    excluded_artist_spotify_ids: set[str] | frozenset[str] | None = None,
    excluded_track_spotify_ids: set[str] | frozenset[str] | None = None,
) -> str | None:
    """Return the first factual reason an active-row candidate is quarantined."""
    spotify_id = str(row.get("spotify_id") or "").strip()
    if spotify_id and spotify_id in (excluded_track_spotify_ids or set()):
        return "explicit_track_id_exclusion"
    if _row_artist_spotify_ids(row) & set(excluded_artist_spotify_ids or set()):
        return "explicit_artist_id_exclusion"
    streams = _finite_number(row.get("streams"))
    if streams is None:
        return "streams_missing"
    if streams < max(0, minimum_streams):
        return "streams_below_minimum"
    if spotify_id and spotify_id in (trusted_internal_spotify_ids or set()):
        # Exact membership in the label's source spreadsheet is the proof for
        # this inventory lane. A source_tier string alone can never grant it.
        return None
    artists = _clean_nested_artists(row.get("artists"))
    identities = [str(row.get("credit_name") or "").strip().casefold()]
    identities.extend(str(artist.get("name") or "").strip().casefold() for artist in artists)
    if any(identity in PUBLIC_ARTIST_BLACKLIST for identity in identities if identity):
        return "blacklisted_identity"
    if str(row.get("source_tier") or "") not in STRICT_SOURCE_TIERS:
        return "unapproved_source"
    if str(row.get("primary_genre") or "") not in STRICT_GENRES:
        return "genre_out_of_scope"
    if str(row.get("instrumental_status") or "") != "instrumental":
        return "instrumental_unconfirmed"
    if (_finite_number(row.get("genre_confidence")) or 0) < MIN_STRICT_CONFIDENCE:
        return "genre_confidence_low"
    if (_finite_number(row.get("instrumental_confidence")) or 0) < MIN_STRICT_CONFIDENCE:
        return "instrumental_confidence_low"
    ai_risk = _evidence_key(row.get("ai_risk") or "unknown")
    # All Tracks is a research catalogue, not the actionable A&R queue.
    # Unknown AI evidence stays visibly "a verifier" once instrumental/no-
    # lyrics, genre, rights and identities are proven. Explicit high risk still
    # blocks. Opportunities continue to require independently proven low risk.
    if ai_risk in {"high", "elevated", "medium"}:
        return "ai_risk_not_low"
    allowed_ai = LOW_AI_RISKS | REVIEW_AI_RISKS | {
        "to_verify", "a_verifier", "to_classify", "a_classifier"
    }
    if ai_risk not in allowed_ai:
        return "ai_risk_not_low"
    if str(row.get("rights_status") or "") not in STRICT_RIGHTS:
        return "rights_unconfirmed"
    if (_finite_number(row.get("rights_confidence")) or 0) < MIN_STRICT_CONFIDENCE:
        return "rights_confidence_low"
    if not str(row.get("spotify_id") or "").strip() or not str(row.get("soundcharts_uuid") or "").strip():
        return "track_identity_incomplete"
    if not artists:
        return "artist_identity_missing"
    if any(not artist.get("spotify_id") or not artist.get("soundcharts_uuid") for artist in artists):
        return "artist_identity_incomplete"
    credit = str(row.get("credit_name") or "").strip()
    if COMPOSITE_CREDIT.search(credit) and len(artists) < 2:
        return "composite_credit_unresolved"
    return None


def strict_rebase_catalogue(
    catalogues: Sequence[Mapping[str, Any]],
    minimum_streams: int = MIN_TRACK_LIFETIME_STREAMS,
    performance_tracks: Mapping[str, Any] | None = None,
    trusted_internal_spotify_ids: set[str] | frozenset[str] | None = None,
    trusted_internal_streams: Mapping[str, float] | None = None,
    quarantine_details: dict[str, tuple[str, Mapping[str, Any]]] | None = None,
    excluded_artist_spotify_ids: set[str] | frozenset[str] | None = None,
    excluded_track_spotify_ids: set[str] | frozenset[str] | None = None,
) -> tuple[dict[str, Any], dict[str, int], list[str]]:
    """Project trusted internal inventory plus evidenced external discoveries.

    This is intentionally a projection, never a deletion: rejected records are
    counted by reason and remain available in the historical archive.
    """
    merged = merge_catalogues(catalogues)
    normalised = _normalise_catalogue(merged)
    # A broad Soundcharts overlap must not replace the already observed
    # lifetime counter from the approved spreadsheet with an older/lower value.
    # A newer Performance point is applied immediately afterwards and remains
    # authoritative, including for a factual downward correction.
    for row in normalised["track_records"]:
        spotify_id = str(row.get("spotify_id") or "").strip()
        baseline_streams = _finite_number(
            (trusted_internal_streams or {}).get(spotify_id)
        )
        current_streams = _finite_number(row.get("streams"))
        if baseline_streams is not None and (
            current_streams is None or baseline_streams > current_streams
        ):
            row["streams"] = baseline_streams
    _overlay_latest_performance_streams(
        normalised["track_records"], performance_tracks
    )
    quarantine_counts: dict[str, int] = {}
    accepted_tracks: list[dict[str, Any]] = []
    active_artist_keys: set[str] = set()
    for row in normalised["track_records"]:
        reason = _strict_rebaseline_reason(
            row,
            minimum_streams,
            trusted_internal_spotify_ids,
            excluded_artist_spotify_ids,
            excluded_track_spotify_ids,
        )
        if reason:
            quarantine_counts[reason] = quarantine_counts.get(reason, 0) + 1
            spotify_id = str(row.get("spotify_id") or "").strip()
            if quarantine_details is not None and spotify_id:
                quarantine_details[spotify_id] = (reason, dict(row))
            continue
        clean = dict(row)
        clean["artists"] = _clean_nested_artists(clean.get("artists"))
        ai_risk = str(clean.get("ai_risk") or "").strip().casefold()
        clean["ai_review_required"] = ai_risk not in LOW_AI_RISKS
        clean["opportunity_eligible"] = (
            ai_risk in LOW_AI_RISKS
            and str(clean.get("source_tier") or "") != TRUSTED_CATALOGUE_SOURCE_TIER
        )
        accepted_tracks.append(clean)
        for artist in clean["artists"]:
            active_artist_keys.add(_row_key(artist, ARTIST_KEY_FIELDS))

    accepted_artists = [
        dict(row)
        for row in normalised["artist_records"]
        if _row_key(row, ARTIST_KEY_FIELDS) in active_artist_keys
    ]
    # A soundtrack can contain an artist pair not present in the separate
    # artist table. Retain its structured track context rather than fabricate
    # an artist card; the next Soundcharts discography pass fills that record.
    strict = merge_catalogues([
        {
            "version": VERSION,
            "generated_at": normalised["generated_at"],
            "track_schema": normalised["track_schema"],
            "artist_schema": normalised["artist_schema"],
            "playlist_schema": normalised["playlist_schema"],
            "tracks": accepted_tracks,
            "artists": accepted_artists,
        }
    ])
    active_legacy_spotify_ids = sorted({
        str(row.get("spotify_id") or "").strip()
        for row in accepted_tracks
        if str(row.get("spotify_id") or "").strip()
    })
    return strict, dict(sorted(quarantine_counts.items())), active_legacy_spotify_ids


def _browse_track_records(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    catalogue = payload.get("discovery_catalogue")
    if not isinstance(catalogue, Mapping):
        return []
    return [dict(row) for row in _normalise_catalogue(catalogue)["track_records"]]


def _browse_cohort_sets(payload: Mapping[str, Any]) -> dict[str, set[str]]:
    records = _browse_track_records(payload)
    all_ids = {
        str(row.get("spotify_id") or "").strip()
        for row in records
        if str(row.get("spotify_id") or "").strip()
    }
    trusted = {
        str(value or "").strip()
        for value in payload.get("trusted_internal_spotify_ids", [])
        if str(value or "").strip()
    } & all_ids
    dark_ambient = {
        str(row.get("spotify_id") or "").strip()
        for row in records
        if str(row.get("primary_genre") or "").strip().casefold() == "dark_ambient"
        and str(row.get("spotify_id") or "").strip()
    }
    fal_promoted = {
        str(row.get("spotify_id") or "").strip()
        for row in records
        if str(row.get("source_tier") or "").strip().casefold()
        == PROMOTED_FAL_SOURCE_TIER
        and str(row.get("spotify_id") or "").strip()
    }
    return {
        "all": all_ids,
        "trusted_internal": trusted,
        "strict_external": all_ids - trusted,
        "dark_ambient": dark_ambient,
        "fal_promoted": fal_promoted,
    }


def browse_cohort_counts(payload: Mapping[str, Any]) -> dict[str, int]:
    cohorts = _browse_cohort_sets(payload)
    catalogue = payload.get("discovery_catalogue")
    artists = catalogue.get("artists") if isinstance(catalogue, Mapping) else []
    return {
        "tracks": len(cohorts["all"]),
        "artists": len(artists) if isinstance(artists, list) else 0,
        "trusted_internal_tracks": len(cohorts["trusted_internal"]),
        "strict_external_tracks": len(cohorts["strict_external"]),
        "dark_ambient_tracks": len(cohorts["dark_ambient"]),
        "fal_promoted_tracks": len(cohorts["fal_promoted"]),
    }


def _explicit_safe_removal(
    reason: str,
    row: Mapping[str, Any],
) -> bool:
    """Return whether fresh factual evidence explicitly invalidates a row.

    Missing/unknown evidence is never enough to silently remove a published
    identity. Explicit vocal, forbidden-genre, high-AI, major-rights and
    below-floor observations are safe automatic removals and stay counted in
    the transition report.
    """

    if reason in {"streams_below_minimum", "blacklisted_identity"}:
        return True
    if reason == "instrumental_unconfirmed":
        return str(row.get("instrumental_status") or "").strip().casefold() in {
            "vocal",
            "non_instrumental",
            "non-instrumental",
            "non instrumental",
        }
    if reason == "genre_out_of_scope":
        genre = str(row.get("primary_genre") or "").strip().casefold()
        return bool(genre) and genre not in {
            "unknown",
            "unclassified",
            "to_classify",
            "a_classifier",
            "à classifier",
            "other",
            "autre",
        }
    if reason == "ai_risk_not_low":
        return str(row.get("ai_risk") or "").strip().casefold() in {
            "high",
            "elevated",
            "eleve",
            "élevé",
        }
    if reason == "rights_unconfirmed":
        return str(row.get("rights_status") or "").strip().casefold() in {
            "major",
            "mixed",
        }
    return False


def validate_browse_transition(
    previous: Mapping[str, Any],
    candidate: Mapping[str, Any],
    quarantine_details: Mapping[str, tuple[str, Mapping[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Fail closed when a daily rebuild silently loses an approved cohort."""

    previous_cohorts = _browse_cohort_sets(previous)
    candidate_cohorts = _browse_cohort_sets(candidate)
    candidate_records = _browse_track_records(candidate)
    candidate_ids = [
        str(row.get("spotify_id") or "").strip() for row in candidate_records
    ]
    if any(not spotify_id for spotify_id in candidate_ids):
        raise BrowseCatalogueError("Active browse catalogue contains a track without Spotify ID")
    if len(set(candidate_ids)) != len(candidate_ids):
        raise BrowseCatalogueError("Active browse catalogue contains duplicate Spotify track IDs")
    counts = (
        candidate.get("discovery_catalogue", {}).get("counts", {})
        if isinstance(candidate.get("discovery_catalogue"), Mapping)
        else {}
    )
    if int(counts.get("tracks") or 0) != len(candidate_ids):
        raise BrowseCatalogueError("Active browse track count is inconsistent")

    expected_counts = browse_cohort_counts(candidate)
    if candidate.get("cohort_counts") != expected_counts:
        raise BrowseCatalogueError("Active browse cohort counts are inconsistent")
    if int(counts.get("artists") or 0) != expected_counts["artists"]:
        raise BrowseCatalogueError("Active browse artist count is inconsistent")

    archive_key = str(
        (candidate.get("policy") or {}).get("manual_archive_storage_key") or ""
    )
    if archive_key != MANUAL_ARCHIVE_STORAGE_KEY:
        raise BrowseCatalogueError("Manual catalogue archive storage key changed")
    previous_archive_key = str(
        (previous.get("policy") or {}).get("manual_archive_storage_key") or ""
    )
    if previous_archive_key and previous_archive_key != archive_key:
        raise BrowseCatalogueError("Daily rebuild would orphan manual catalogue archives")

    missing = previous_cohorts["all"] - candidate_cohorts["all"]
    approved_removals: dict[str, str] = {}
    unsafe_missing: set[str] = set()
    for spotify_id in missing:
        detail = (quarantine_details or {}).get(spotify_id)
        if detail and _explicit_safe_removal(detail[0], detail[1]):
            approved_removals[spotify_id] = detail[0]
        else:
            unsafe_missing.add(spotify_id)
    if unsafe_missing:
        preview = ", ".join(sorted(unsafe_missing)[:5])
        raise BrowseCatalogueError(
            "Daily browse rebuild would silently remove approved tracks "
            f"({len(unsafe_missing)}; first: {preview})"
        )

    protected_reports: dict[str, dict[str, int]] = {}
    for cohort in ("trusted_internal", "dark_ambient", "fal_promoted"):
        removed = previous_cohorts[cohort] - candidate_cohorts[cohort]
        unsafe = removed - set(approved_removals)
        if unsafe:
            preview = ", ".join(sorted(unsafe)[:5])
            raise BrowseCatalogueError(
                f"Daily browse rebuild would lose protected {cohort} tracks "
                f"({len(unsafe)}; first: {preview})"
            )
        protected_reports[cohort] = {
            "previous": len(previous_cohorts[cohort]),
            "candidate": len(candidate_cohorts[cohort]),
            "explicit_safe_removals": len(removed & set(approved_removals)),
        }

    removal_counts: dict[str, int] = {}
    for reason in approved_removals.values():
        removal_counts[reason] = removal_counts.get(reason, 0) + 1
    return {
        "status": "passed",
        "previous_tracks": len(previous_cohorts["all"]),
        "candidate_tracks": len(candidate_cohorts["all"]),
        "retained_tracks": len(previous_cohorts["all"] & candidate_cohorts["all"]),
        "explicit_safe_removals": dict(sorted(removal_counts.items())),
        "protected_cohorts": protected_reports,
    }


def build_payload(
    sources: Sequence[tuple[Path, Mapping[str, Any]]],
    existing: Mapping[str, Any] | None,
    minimum_tracks: int,
    *,
    strict_rebased: bool = False,
    trusted_catalogue: Mapping[str, Any] | None = None,
    minimum_streams: int = MIN_TRACK_LIFETIME_STREAMS,
    performance: Mapping[str, Any] | None = None,
    exclusions: Mapping[str, frozenset[str] | set[str]] | None = None,
    protected_review_cohorts: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    catalogues: list[Mapping[str, Any]] = []
    if isinstance(existing, Mapping):
        old = existing.get("discovery_catalogue")
        if isinstance(old, Mapping):
            catalogues.append(old)
    for _, payload in sources:
        catalogue = _extract_catalogue(payload)
        if isinstance(catalogue, Mapping):
            catalogues.append(catalogue)
    if isinstance(trusted_catalogue, Mapping):
        catalogues.insert(0, dict(trusted_catalogue))
    if not catalogues:
        raise BrowseCatalogueError("No discovery catalogue source was available")
    quarantine_counts: dict[str, int] = {}
    quarantine_details: dict[str, tuple[str, Mapping[str, Any]]] = {}
    active_legacy_spotify_ids: list[str] = []
    trusted_internal_spotify_ids: set[str] = set()
    trusted_internal_streams: dict[str, float] = {}
    if isinstance(trusted_catalogue, Mapping):
        for row in _normalise_catalogue(trusted_catalogue)["track_records"]:
            spotify_id = str(row.get("spotify_id") or "").strip()
            if not spotify_id:
                continue
            trusted_internal_spotify_ids.add(spotify_id)
            streams = _finite_number(row.get("streams"))
            if streams is not None:
                trusted_internal_streams[spotify_id] = max(
                    streams,
                    trusted_internal_streams.get(spotify_id, streams),
                )
    if strict_rebased:
        performance_tracks = (
            performance.get("tracks")
            if isinstance(performance, Mapping)
            and isinstance(performance.get("tracks"), Mapping)
            else None
        )
        merged, quarantine_counts, active_legacy_spotify_ids = strict_rebase_catalogue(
            catalogues,
            minimum_streams,
            performance_tracks=performance_tracks,
            trusted_internal_spotify_ids=trusted_internal_spotify_ids,
            trusted_internal_streams=trusted_internal_streams,
            quarantine_details=quarantine_details,
            excluded_artist_spotify_ids=(exclusions or {}).get(
                "artist_spotify_ids", frozenset()
            ),
            excluded_track_spotify_ids=(exclusions or {}).get(
                "track_spotify_ids", frozenset()
            ),
        )
    else:
        merged = merge_catalogues(catalogues)
    if int(merged.get("counts", {}).get("tracks") or 0) < max(1, minimum_tracks):
        raise BrowseCatalogueError(
            f"Active catalogue unexpectedly small: {merged.get('counts', {}).get('tracks', 0)} tracks"
        )

    newest_path, newest_payload = max(
        sources,
        key=lambda item: str(item[1].get("generated_at") or item[0].name),
    )
    playlist_discovery = newest_payload.get("playlist_discovery")
    if not isinstance(playlist_discovery, Mapping) and isinstance(existing, Mapping):
        playlist_discovery = existing.get("playlist_discovery")
    instrumental_pool = newest_payload.get("instrumental_pool")
    if not isinstance(instrumental_pool, Mapping) and isinstance(existing, Mapping):
        instrumental_pool = existing.get("instrumental_pool")
    strict_counts = {
        "tracks": len(newest_payload.get("tracks", [])) if isinstance(newest_payload.get("tracks"), list) else 0,
        "artists": len(newest_payload.get("artists", [])) if isinstance(newest_payload.get("artists"), list) else 0,
        "opportunities": len(newest_payload.get("opportunities", [])) if isinstance(newest_payload.get("opportunities"), list) else 0,
    }
    active_trusted_internal_spotify_ids = sorted(
        set(active_legacy_spotify_ids) & trusted_internal_spotify_ids
    )
    active_spotify_ids = set(active_legacy_spotify_ids)
    protected_cohorts: list[dict[str, Any]] = []
    for raw_cohort in protected_review_cohorts or []:
        cohort = dict(raw_cohort)
        cohort_ids = {
            str(value or "").strip()
            for value in cohort.get("spotify_ids", [])
            if str(value or "").strip()
        }
        cohort["active_browse_overlap"] = len(cohort_ids & active_spotify_ids)
        cohort["review_only_tracks"] = len(cohort_ids - active_spotify_ids)
        # This metadata is intentionally invariant even when some exact IDs
        # separately qualify for the trusted internal inventory lane.
        cohort["allow_automatic_active_promotion"] = False
        cohort["contactable"] = False
        protected_cohorts.append(cohort)
    payload = {
        "version": VERSION,
        "source": "soundcharts_browse_catalogue",
        "generated_at": str(newest_payload.get("generated_at") or merged.get("generated_at") or ""),
        "source_snapshot": newest_path.name,
        "policy": {
            "browsing": (
                "trusted_internal_catalogue_plus_strict_soundcharts"
                if strict_rebased and active_trusted_internal_spotify_ids
                else "strict_instrumental_rebased" if strict_rebased else "full"
            ),
            "ar": "strict",
            "contacts": "strict_only",
            "unverified_records_contactable": False,
            "archive": "Spotify_Radar_data.js" if strict_rebased else "",
            "minimum_lifetime_streams": minimum_streams if strict_rebased else None,
            "manual_archive_storage_key": MANUAL_ARCHIVE_STORAGE_KEY,
            "explicit_id_exclusions": bool(
                (exclusions or {}).get("artist_spotify_ids")
                or (exclusions or {}).get("track_spotify_ids")
            ),
        },
        "discovery_catalogue": merged,
        "active_legacy_spotify_ids": active_legacy_spotify_ids,
        "trusted_internal_spotify_ids": active_trusted_internal_spotify_ids,
        "quarantine_counts": quarantine_counts,
        "protected_review_cohorts": protected_cohorts,
        "playlist_discovery": dict(playlist_discovery) if isinstance(playlist_discovery, Mapping) else {},
        "instrumental_pool": dict(instrumental_pool) if isinstance(instrumental_pool, Mapping) else {},
        "strict_snapshot_counts": strict_counts,
    }
    payload["cohort_counts"] = browse_cohort_counts(payload)
    if strict_rebased and isinstance(existing, Mapping):
        payload["transition_guard"] = validate_browse_transition(
            existing,
            payload,
            quarantine_details,
        )
    else:
        payload["transition_guard"] = {
            "status": "bootstrap",
            "previous_tracks": 0,
            "candidate_tracks": payload["cohort_counts"]["tracks"],
            "retained_tracks": 0,
            "explicit_safe_removals": {},
            "protected_cohorts": {},
        }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, action="append", required=True)
    parser.add_argument("--fallback", type=Path, action="append", default=[])
    parser.add_argument("--existing", type=Path)
    parser.add_argument("--output", type=Path, default=Path("Spotify_Browse_Catalogue_data.js"))
    parser.add_argument("--minimum-tracks", type=int, default=10_000)
    parser.add_argument(
        "--minimum-streams",
        type=int,
        default=MIN_TRACK_LIFETIME_STREAMS,
        help="Inclusive lifetime Spotify stream floor for the active strict catalogue.",
    )
    parser.add_argument(
        "--performance",
        type=Path,
        help=(
            "Spotify Performance export whose newest factual stream point is "
            "applied before the active-catalogue threshold."
        ),
    )
    parser.add_argument(
        "--strict-rebased",
        action="store_true",
        help="Build trusted internal catalogue plus fully evidenced Soundcharts discoveries; do not merge the prior browse file.",
    )
    parser.add_argument(
        "--trusted-catalogue",
        type=Path,
        help="CSV export of the trusted internal catalogue for broad browse views only.",
    )
    parser.add_argument(
        "--trusted-artist-seeds",
        type=Path,
        help="Sanitized artist-ID mapping for the trusted catalogue.",
    )
    parser.add_argument(
        "--exclusions",
        type=Path,
        help=(
            "Versioned Spotify artist/track ID exclusions applied before "
            "the trusted internal-catalogue bypass."
        ),
    )
    parser.add_argument(
        "--protected-review-cohorts",
        type=Path,
        help=(
            "Versioned recovery cohorts kept outside the active browse/A&R "
            "projection until their evidence is validated."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_paths: list[Path] = []
    for path in [*args.source, *args.fallback]:
        if path.exists() and path not in source_paths:
            source_paths.append(path)
    if not source_paths:
        raise BrowseCatalogueError("No Soundcharts source file exists")
    sources = [(path, _read_payload(path, SOUNDCHARTS_PREFIX)) for path in source_paths]
    existing = None
    if args.existing and args.existing.exists():
        existing = _read_payload(args.existing, BROWSE_PREFIX)
    trusted_catalogue = None
    if args.trusted_catalogue:
        if not args.trusted_catalogue.exists():
            raise BrowseCatalogueError(f"Trusted catalogue does not exist: {args.trusted_catalogue}")
        trusted_catalogue = _trusted_catalogue_from_csv(args.trusted_catalogue, args.trusted_artist_seeds)
    performance = None
    if args.performance:
        from spotify_performance_store import read_performance_payload

        if not args.performance.exists():
            raise BrowseCatalogueError(
                f"Performance catalogue does not exist: {args.performance}"
            )
        performance = read_performance_payload(args.performance)
    exclusions = None
    if args.exclusions:
        if not args.exclusions.exists():
            raise BrowseCatalogueError(
                f"Exclusion manifest does not exist: {args.exclusions}"
            )
        exclusions = _read_exclusions(args.exclusions)
    protected_review_cohorts = None
    if args.protected_review_cohorts:
        if not args.protected_review_cohorts.exists():
            raise BrowseCatalogueError(
                "Protected review cohort manifest does not exist: "
                f"{args.protected_review_cohorts}"
            )
        protected_review_cohorts = _read_protected_review_cohorts(
            args.protected_review_cohorts
        )
    payload = build_payload(
        sources,
        existing,
        max(1, args.minimum_tracks),
        strict_rebased=args.strict_rebased,
        trusted_catalogue=trusted_catalogue,
        minimum_streams=max(0, args.minimum_streams),
        performance=performance,
        exclusions=exclusions,
        protected_review_cohorts=protected_review_cohorts,
    )
    _write_payload(args.output, payload)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "source_snapshot": payload["source_snapshot"],
                "tracks": payload["discovery_catalogue"]["counts"]["tracks"],
                "artists": payload["discovery_catalogue"]["counts"]["artists"],
                "measured_tracks": payload["discovery_catalogue"]["counts"]["measured_tracks"],
                "cohort_counts": payload["cohort_counts"],
                "transition_guard": payload["transition_guard"],
                "policy": payload["policy"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
