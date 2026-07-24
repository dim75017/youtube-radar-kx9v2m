#!/usr/bin/env python3
"""Build the Spotify browsing catalogue.

The Spotify Radar has two intentionally different data contracts:

* ``Toutes les pistes`` / ``Tous les artistes`` are inventory views. They may
  expose discovered, unmeasured and review-pending records with an explicit
  status so the catalogue stays useful and alive.
* ``Opportunités A&R`` and every contact/deal action remain fail-closed and are
  sourced exclusively from the sanitized ``window.SPOTIFY_SOUNDCHARTS`` export.

This script materializes the first contract into a separate public file.  It
also supports an explicit ``--strict-rebased`` migration mode. That mode keeps
the trusted internal catalogue as its own visible source, while Soundcharts
discoveries must pass the strict editorial/instrumental gates. Historical rows
remain preserved in ``Spotify_Radar_data.js`` and Git history as archive.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from prepare_soundcharts_snapshot import PUBLIC_ARTIST_BLACKLIST

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

# These are the accepted Soundcharts paths for the staged rebaseline.  A
# publisher profile may be added only after its playlists have been reviewed
# and declared in the collector configuration.
STRICT_SOURCE_TIERS = {
    "editorial_playlist",
    "playlist_artist_catalogue",
}
STRICT_GENRES = {
    "lofi_hip_hop",
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
    "instrumental_dnb",
}
STRICT_RIGHTS = {"self_released", "independent_label"}
MIN_STRICT_CONFIDENCE = 0.5
COMPOSITE_CREDIT = re.compile(r"(?:\s(?:&|feat\.?|featuring|ft\.?|x|×)\s|,)", re.IGNORECASE)


class BrowseCatalogueError(RuntimeError):
    """Raised when a usable broad catalogue cannot be produced safely."""


TRUSTED_CATALOGUE_SOURCE_TIER = "trusted_internal_catalogue"
TRUSTED_CATALOGUE_AVAILABILITY = "catalogue_trusted"


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


def _spotify_id_from_url(value: Any) -> str:
    match = re.search(r"spotify\.com/track/([A-Za-z0-9]+)", str(value or ""))
    return match.group(1) if match else ""


def _trusted_catalogue_from_csv(path: Path, artist_seeds_path: Path | None) -> dict[str, Any]:
    """Read the internal catalogue without importing contacts or credentials.

    The source is trusted for broad browse views only. It is never an A&R,
    contact or automatic-expansion eligibility signal.
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
    seen_tracks: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for raw in csv.DictReader(handle):
            artist_name = str(raw.get("Artiste") or "").strip()
            title = str(raw.get("Track") or "").strip()
            spotify_id = _spotify_id_from_url(raw.get("Lien Spotify"))
            if not artist_name or not title or not spotify_id or spotify_id in seen_tracks:
                continue
            seen_tracks.add(spotify_id)
            artist_spotify_id = artist_ids.get(artist_name.casefold(), "")
            status = str(raw.get("Statut") or "").strip().casefold()
            rights_status = "self_released" if status == "self-released" else "catalogue_trusted"
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
                "streams": _finite_number(raw.get("Streams")), "streams_delta_24h": None,
                "rights_status": rights_status, "rights_confidence": None,
                "label": str(raw.get("Label / Copyright") or "").strip(),
                "copyright": str(raw.get("Label / Copyright") or "").strip(),
                "primary_genre": "trusted_catalogue", "subgenres": [], "genre_confidence": None,
                "instrumental_status": "trusted_catalogue", "instrumental_confidence": None,
                "ai_risk": "unknown", "availability_status": TRUSTED_CATALOGUE_AVAILABILITY,
                "source_tier": TRUSTED_CATALOGUE_SOURCE_TIER, "metadata_status": "internal_catalogue",
                "image_url": "", "playlist_ids": [], "playlist_names": [], "playlist_count": 0,
                "playlist_best_position": None, "playlist_followers_total": None,
                "playlist_placements": [], "discovered_at": "", "updated_at": "", "review_reasons": [],
            })
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


def _row_key(record: Mapping[str, Any], fields: Sequence[str]) -> str:
    for field in fields:
        value = str(record.get(field) or "").strip()
        if value:
            return f"{field}:{value.casefold() if field == 'name' else value}"
    return ""


def _merge_record(previous: Mapping[str, Any], incoming: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(previous)
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
                        by_key[key] = {**by_key.get(key, {}), **artist}
                merged[field] = list(by_key.values())
            else:
                merged[field] = _merge_unique(merged.get(field), value)
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
        spotify = str(row.get("spotify_id") or "").strip()
        soundcharts = str(row.get("soundcharts_uuid") or "").strip()
        index = track_by_spotify.get(spotify) if spotify else None
        if index is None and soundcharts:
            index = track_by_soundcharts.get(soundcharts)
        if index is None:
            index = len(tracks)
            tracks.append(dict(row))
        else:
            tracks[index] = _merge_record(tracks[index], row)
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


def _strict_rebaseline_reason(row: Mapping[str, Any]) -> str | None:
    """Return the first factual reason an active-row candidate is quarantined."""
    artists = _clean_nested_artists(row.get("artists"))
    identities = [str(row.get("credit_name") or "").strip().casefold()]
    identities.extend(str(artist.get("name") or "").strip().casefold() for artist in artists)
    if any(identity in PUBLIC_ARTIST_BLACKLIST for identity in identities if identity):
        return "blacklisted_identity"
    if str(row.get("source_tier") or "") == TRUSTED_CATALOGUE_SOURCE_TIER:
        return None
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
    if str(row.get("ai_risk") or "") != "low":
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


def strict_rebase_catalogue(catalogues: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], dict[str, int], list[str]]:
    """Project only fully evidenced instrumental rows into the active catalogue.

    This is intentionally a projection, never a deletion: rejected records are
    counted by reason and remain available in the historical archive.
    """
    merged = merge_catalogues(catalogues)
    normalised = _normalise_catalogue(merged)
    quarantine_counts: dict[str, int] = {}
    accepted_tracks: list[dict[str, Any]] = []
    active_artist_keys: set[str] = set()
    for row in normalised["track_records"]:
        reason = _strict_rebaseline_reason(row)
        if reason:
            quarantine_counts[reason] = quarantine_counts.get(reason, 0) + 1
            continue
        clean = dict(row)
        clean["artists"] = _clean_nested_artists(clean.get("artists"))
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


def build_payload(
    sources: Sequence[tuple[Path, Mapping[str, Any]]],
    existing: Mapping[str, Any] | None,
    minimum_tracks: int,
    *,
    strict_rebased: bool = False,
    trusted_catalogue: Mapping[str, Any] | None = None,
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
    active_legacy_spotify_ids: list[str] = []
    if strict_rebased:
        merged, quarantine_counts, active_legacy_spotify_ids = strict_rebase_catalogue(catalogues)
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
    return {
        "version": VERSION,
        "source": "soundcharts_browse_catalogue",
        "generated_at": str(newest_payload.get("generated_at") or merged.get("generated_at") or ""),
        "source_snapshot": newest_path.name,
        "policy": {
            "browsing": "trusted_internal_catalogue_plus_strict_soundcharts" if strict_rebased else "full",
            "ar": "strict",
            "contacts": "strict_only",
            "unverified_records_contactable": False,
            "archive": "Spotify_Radar_data.js" if strict_rebased else "",
        },
        "discovery_catalogue": merged,
        "active_legacy_spotify_ids": active_legacy_spotify_ids,
        "quarantine_counts": quarantine_counts,
        "playlist_discovery": dict(playlist_discovery) if isinstance(playlist_discovery, Mapping) else {},
        "instrumental_pool": dict(instrumental_pool) if isinstance(instrumental_pool, Mapping) else {},
        "strict_snapshot_counts": strict_counts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, action="append", required=True)
    parser.add_argument("--fallback", type=Path, action="append", default=[])
    parser.add_argument("--existing", type=Path)
    parser.add_argument("--output", type=Path, default=Path("Spotify_Browse_Catalogue_data.js"))
    parser.add_argument("--minimum-tracks", type=int, default=10_000)
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
    payload = build_payload(
        sources,
        existing,
        max(1, args.minimum_tracks),
        strict_rebased=args.strict_rebased,
        trusted_catalogue=trusted_catalogue,
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
                "policy": payload["policy"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
