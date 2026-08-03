#!/usr/bin/env python3
"""Build a deterministic, staging-only FAL seed ledger from approved sources.

The ledger is intentionally separate from the FAL SQLite checkpoint.  It reads
only the current performance catalogue, the public browse catalogue and the
currently active strict Soundcharts snapshot.  It never reads FAL candidates,
so an unreviewed related artist cannot silently become a seed.

No audience floor is applied.  Every resolved Soundcharts artist UUID is kept;
Spotify identities which still lack a UUID are reported as
``resolution_pending`` instead of being dropped or fabricated.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from refresh_soundcharts_daily import SOUNDCHARTS_PREFIX, read_js_payload


LEDGER_VERSION = 2
DEFAULT_OUTPUT = Path("soundcharts-fal-seed-ledger-v2.json")
SOURCE_PRIORITY = {
    "strict_artist": 0,
    "strict_discovery_artist": 1,
    "strict_discovery_track_artist": 2,
    "browse_artist": 3,
    "browse_track_artist": 4,
    "performance_artist": 5,
}


class SeedLedgerError(RuntimeError):
    """A fail-closed ledger validation error."""


@dataclass(frozen=True)
class ArtistObservation:
    soundcharts_uuid: str
    spotify_id: str
    name: str
    monthly_listeners: int | None
    source: str


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def finite_int(value: Any) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if math.isfinite(number) else None


def read_generic_js(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    marker = text.find("=")
    if marker < 0:
        raise SeedLedgerError(f"{path} is not a JavaScript data export")
    try:
        payload = json.loads(text[marker + 1 :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise SeedLedgerError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise SeedLedgerError(f"{path} does not contain an object")
    return payload


def row_record(row: Any, schema: Sequence[str]) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    if not isinstance(row, (list, tuple)):
        return {}
    return {name: row[index] if index < len(row) else None for index, name in enumerate(schema)}


def records(payload: Mapping[str, Any], group: str) -> Iterable[dict[str, Any]]:
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), Mapping) else {}
    schema = schemas.get(group) if isinstance(schemas.get(group), list) else []
    rows = payload.get(group) if isinstance(payload.get(group), list) else []
    for row in rows:
        record = row_record(row, schema)
        if record:
            yield record


def catalogue_records(payload: Mapping[str, Any], group: str) -> Iterable[dict[str, Any]]:
    catalogue = payload.get("discovery_catalogue")
    if not isinstance(catalogue, Mapping):
        return
    schema = catalogue.get(f"{group[:-1]}_schema")
    rows = catalogue.get(group)
    if not isinstance(schema, list) or not isinstance(rows, list):
        return
    for row in rows:
        record = row_record(row, schema)
        if record:
            yield record


def structured_track_artists(record: Mapping[str, Any]) -> Iterable[dict[str, Any]]:
    artists = record.get("artists")
    if isinstance(artists, list):
        for artist in artists:
            if isinstance(artist, Mapping):
                yield dict(artist)
    # Some strict rows predate the structured array but still carry a complete
    # primary artist pair.  Keep that approved identity without inventing one.
    spotify = str(record.get("artist_spotify_id") or "").strip()
    soundcharts = str(record.get("artist_soundcharts_uuid") or "").strip()
    if spotify or soundcharts:
        yield {
            "spotify_id": spotify,
            "soundcharts_uuid": soundcharts,
            "name": record.get("credit_name") or record.get("artist_name") or "",
            "monthly_listeners": record.get("artist_monthly_listeners"),
        }


def observation(record: Mapping[str, Any], source: str) -> ArtistObservation | None:
    uuid = str(record.get("soundcharts_uuid") or record.get("uuid") or "").strip()
    spotify = str(record.get("spotify_id") or record.get("spotifyId") or "").strip()
    if not uuid and not spotify:
        return None
    return ArtistObservation(
        soundcharts_uuid=uuid,
        spotify_id=spotify,
        name=str(record.get("name") or record.get("artist_name") or "").strip(),
        monthly_listeners=finite_int(record.get("monthly_listeners")),
        source=source,
    )


def collect_observations(
    *,
    active: Mapping[str, Any],
    browse: Mapping[str, Any],
    performance: Mapping[str, Any],
) -> list[ArtistObservation]:
    found: list[ArtistObservation] = []

    def add(record: Mapping[str, Any], source: str) -> None:
        item = observation(record, source)
        if item is not None:
            found.append(item)

    for record in records(active, "artists"):
        add(record, "strict_artist")
    for record in catalogue_records(active, "artists"):
        add(record, "strict_discovery_artist")
    for record in catalogue_records(active, "tracks"):
        for artist in structured_track_artists(record):
            add(artist, "strict_discovery_track_artist")

    for record in catalogue_records(browse, "artists"):
        add(record, "browse_artist")
    for record in catalogue_records(browse, "tracks"):
        for artist in structured_track_artists(record):
            add(artist, "browse_track_artist")

    artists = performance.get("artists")
    if isinstance(artists, Mapping):
        for spotify_id, raw in artists.items():
            entry = raw if isinstance(raw, Mapping) else {}
            history = entry.get("monthly_listeners_history") or entry.get("history") or []
            latest = history[-1] if isinstance(history, list) and history else None
            latest_value = (
                latest[1]
                if isinstance(latest, (list, tuple)) and len(latest) > 1
                else latest.get("value") if isinstance(latest, Mapping) else None
            )
            add(
                {
                    "spotify_id": str(spotify_id or ""),
                    "soundcharts_uuid": entry.get("soundcharts_uuid"),
                    "name": entry.get("name"),
                    "monthly_listeners": latest_value,
                },
                "performance_artist",
            )
    return found


def _canonical_hash(artists: Sequence[Mapping[str, Any]], pending: Sequence[Mapping[str, Any]]) -> str:
    """Hash only cohort membership/alias topology, never volatile metrics."""

    body = {
        "artists": [
            [
                str(item.get("soundcharts_uuid") or ""),
                list(item.get("soundcharts_uuid_aliases") or []),
                list(item.get("spotify_id_aliases") or []),
            ]
            for item in artists
        ],
        "resolution_pending": [str(item.get("spotify_id") or "") for item in pending],
    }
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _content_hash(artists: Sequence[Mapping[str, Any]], pending: Sequence[Mapping[str, Any]]) -> str:
    body = {
        "artists": [
            [
                str(item.get("soundcharts_uuid") or ""),
                str(item.get("spotify_id") or ""),
                str(item.get("name") or ""),
                finite_int(item.get("monthly_listeners")),
                list(item.get("sources") or []),
                list(item.get("soundcharts_uuid_aliases") or []),
                list(item.get("spotify_id_aliases") or []),
            ]
            for item in artists
        ],
        "resolution_pending": [
            [str(item.get("spotify_id") or ""), str(item.get("name") or ""), list(item.get("sources") or [])]
            for item in pending
        ],
    }
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_ledger(
    observations: Sequence[ArtistObservation],
    *,
    source_files: Sequence[str] = (),
) -> dict[str, Any]:
    # Soundcharts occasionally exposes several UUIDs for one Spotify profile,
    # and (less frequently) several Spotify IDs for one UUID.  Deduplicating
    # each direction independently is not enough: A<->1, A<->2, B<->2 is one
    # connected identity, not two seeds.  Build the full bipartite alias graph
    # and emit exactly one seed per connected component.
    parents: dict[str, str] = {}

    def find(node: str) -> str:
        parents.setdefault(node, node)
        while parents[node] != node:
            parents[node] = parents[parents[node]]
            node = parents[node]
        return node

    def union(left: str, right: str) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        # Lexical roots make the grouping deterministic regardless of source
        # order.  Canonical UUID selection still uses source priority below.
        first, second = sorted((left_root, right_root))
        parents[second] = first

    distinct_pairs: set[tuple[str, str]] = set()
    spotify_to_uuids: dict[str, set[str]] = {}
    uuid_to_spotify: dict[str, set[str]] = {}

    for item in observations:
        distinct_pairs.add((item.soundcharts_uuid, item.spotify_id))
        uuid_node = f"uuid:{item.soundcharts_uuid}" if item.soundcharts_uuid else ""
        spotify_node = f"spotify:{item.spotify_id}" if item.spotify_id else ""
        if uuid_node:
            find(uuid_node)
        if spotify_node:
            find(spotify_node)
        if uuid_node and spotify_node:
            union(uuid_node, spotify_node)
        if item.spotify_id:
            spotify_to_uuids.setdefault(item.spotify_id, set())
        if item.soundcharts_uuid:
            uuid_to_spotify.setdefault(item.soundcharts_uuid, set())
        if item.soundcharts_uuid and item.spotify_id:
            spotify_to_uuids[item.spotify_id].add(item.soundcharts_uuid)
            uuid_to_spotify[item.soundcharts_uuid].add(item.spotify_id)

    component_observations: dict[str, list[ArtistObservation]] = {}
    for item in observations:
        node = (
            f"uuid:{item.soundcharts_uuid}"
            if item.soundcharts_uuid
            else f"spotify:{item.spotify_id}"
        )
        component_observations.setdefault(find(node), []).append(item)

    artists: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    rejected_uuid_aliases: list[dict[str, Any]] = []
    for component in component_observations.values():
        uuids = sorted({item.soundcharts_uuid for item in component if item.soundcharts_uuid})
        spotify_ids = sorted({item.spotify_id for item in component if item.spotify_id})
        names = sorted(
            (
                (SOURCE_PRIORITY.get(item.source, 99), item.name.casefold(), item.name)
                for item in component
                if item.name
            )
        )
        sources = sorted(
            {item.source for item in component},
            key=lambda value: (SOURCE_PRIORITY.get(value, 99), value),
        )
        if not uuids:
            # A Spotify-only component can contain only one ID because there is
            # no Soundcharts edge through which two Spotify IDs could connect.
            spotify = spotify_ids[0]
            pending.append(
                {
                    "spotify_id": spotify,
                    "name": names[0][2] if names else spotify,
                    "sources": sources,
                    "status": "resolution_pending",
                }
            )
            continue

        paired = sorted(
            (
                SOURCE_PRIORITY.get(item.source, 99),
                item.soundcharts_uuid,
                item.spotify_id,
            )
            for item in component
            if item.soundcharts_uuid and item.spotify_id
        )
        canonical_uuid = paired[0][1] if paired else uuids[0]
        canonical_spotify = ""
        if spotify_ids:
            matching = [pair for pair in paired if pair[1] == canonical_uuid]
            canonical_spotify = (matching[0][2] if matching else paired[0][2]) if paired else spotify_ids[0]
        audience_rows = sorted(
            (
                SOURCE_PRIORITY.get(item.source, 99),
                0 if item.soundcharts_uuid == canonical_uuid else 1,
                -int(item.monthly_listeners),
                int(item.monthly_listeners),
            )
            for item in component
            if item.monthly_listeners is not None
        )
        audience = audience_rows[0][3] if audience_rows else None
        artists.append(
            {
                "soundcharts_uuid": canonical_uuid,
                "spotify_id": canonical_spotify,
                "name": names[0][2] if names else (canonical_spotify or f"soundcharts:{canonical_uuid[:8]}"),
                "monthly_listeners": audience,
                "sources": sources,
                "soundcharts_uuid_aliases": uuids,
                "spotify_id_aliases": spotify_ids,
            }
        )
        rejected = [uuid for uuid in uuids if uuid != canonical_uuid]
        if rejected:
            rejected_uuid_aliases.append(
                {
                    "spotify_ids": spotify_ids,
                    "canonical_uuid": canonical_uuid,
                    "rejected_uuids": rejected,
                }
            )
    artists.sort(key=lambda item: (str(item["soundcharts_uuid"]), str(item["spotify_id"])))
    pending.sort(key=lambda item: str(item["spotify_id"]))
    rejected_uuid_aliases.sort(key=lambda item: str(item["canonical_uuid"]))

    unique_spotify = {item.spotify_id for item in observations if item.spotify_id}
    unique_uuids = {item.soundcharts_uuid for item in observations if item.soundcharts_uuid}
    alias = {
        "raw_observations": len(observations),
        "distinct_identity_pairs": len(distinct_pairs),
        "duplicate_observations": len(observations) - len(distinct_pairs),
        "spotify_ids_with_multiple_uuids": sum(len(values) > 1 for values in spotify_to_uuids.values()),
        "uuids_with_multiple_spotify_ids": sum(len(values) > 1 for values in uuid_to_spotify.values()),
        "rejected_uuid_alias_count": sum(len(item["rejected_uuids"]) for item in rejected_uuid_aliases),
        "connected_identity_components": len(artists) + len(pending),
    }
    ledger_hash = _canonical_hash(artists, pending)
    content_hash = _content_hash(artists, pending)
    return {
        "version": LEDGER_VERSION,
        "cohort": "canonical-accepted-v2",
        "generated_at": utc_now(),
        "staging_only": True,
        "canonical_written": False,
        "policy": {
            "sources": ["performance", "browse_discovery", "active_strict_discovery"],
            "fal_candidates_are_seeds": False,
            "minimum_monthly_listeners": None,
            "deduplication": "soundcharts_uuid_with_spotify_alias_audit",
        },
        "source_files": list(source_files),
        "coverage": {
            "expected_displayed": len(unique_spotify),
            "expected_identity_components": len(artists) + len(pending),
            "unique_spotify_identities": len(unique_spotify),
            "resolved_uuid": len(artists),
            "resolved_source_uuids": len(unique_uuids),
            "resolved_seed_uuids": len(artists),
            "unresolved": len(pending),
            "unresolved_display_identities": len(pending),
            "uuid_only": sum(not item["spotify_id_aliases"] for item in artists),
        },
        "alias_dedup": alias,
        "rejected_uuid_aliases": rejected_uuid_aliases,
        "cohort_hash": ledger_hash,
        "content_hash": content_hash,
        "artists": artists,
        "resolution_pending": pending,
    }


def validate_ledger(ledger: Mapping[str, Any], *, min_resolved: int, max_resolved: int) -> None:
    coverage = ledger.get("coverage") if isinstance(ledger.get("coverage"), Mapping) else {}
    resolved = finite_int(coverage.get("resolved_uuid"))
    artists = ledger.get("artists") if isinstance(ledger.get("artists"), list) else []
    pending = ledger.get("resolution_pending") if isinstance(ledger.get("resolution_pending"), list) else []
    if ledger.get("version") != LEDGER_VERSION or ledger.get("cohort") != "canonical-accepted-v2":
        raise SeedLedgerError("Unsupported or missing FAL seed ledger version")
    if resolved != len(artists):
        raise SeedLedgerError("FAL seed ledger resolved coverage does not match its artist rows")
    if resolved is None or resolved < max(0, min_resolved) or resolved > max(min_resolved, max_resolved):
        raise SeedLedgerError(
            f"Resolved FAL seed cohort outside protected bounds ({resolved}; expected {min_resolved}-{max_resolved})"
        )
    uuids = [str(item.get("soundcharts_uuid") or "") for item in artists if isinstance(item, Mapping)]
    if any(not uuid for uuid in uuids) or len(uuids) != len(set(uuids)):
        raise SeedLedgerError("FAL seed ledger contains a missing or duplicate Soundcharts UUID")
    all_uuid_aliases: list[str] = []
    all_spotify_aliases: list[str] = []
    for item in artists:
        if not isinstance(item, Mapping):
            raise SeedLedgerError("FAL seed ledger contains a malformed artist row")
        uuid_aliases = [str(value or "") for value in item.get("soundcharts_uuid_aliases") or []]
        spotify_aliases = [str(value or "") for value in item.get("spotify_id_aliases") or []]
        if not uuid_aliases or any(not value for value in uuid_aliases):
            raise SeedLedgerError("FAL seed ledger contains an empty UUID alias component")
        if str(item.get("soundcharts_uuid") or "") not in uuid_aliases:
            raise SeedLedgerError("FAL seed ledger canonical UUID is absent from its alias component")
        canonical_spotify = str(item.get("spotify_id") or "")
        if canonical_spotify and canonical_spotify not in spotify_aliases:
            raise SeedLedgerError("FAL seed ledger canonical Spotify ID is absent from its alias component")
        if len(uuid_aliases) != len(set(uuid_aliases)) or len(spotify_aliases) != len(set(spotify_aliases)):
            raise SeedLedgerError("FAL seed ledger contains duplicate aliases inside a component")
        all_uuid_aliases.extend(uuid_aliases)
        all_spotify_aliases.extend(spotify_aliases)
    if len(all_uuid_aliases) != len(set(all_uuid_aliases)):
        raise SeedLedgerError("A Soundcharts UUID appears in more than one FAL identity component")
    if len(all_spotify_aliases) != len(set(all_spotify_aliases)):
        raise SeedLedgerError("A Spotify ID appears in more than one FAL identity component")
    spotify_pending = [str(item.get("spotify_id") or "") for item in pending if isinstance(item, Mapping)]
    if any(not spotify for spotify in spotify_pending) or len(spotify_pending) != len(set(spotify_pending)):
        raise SeedLedgerError("FAL seed ledger contains a missing or duplicate pending Spotify ID")
    if set(spotify_pending) & set(all_spotify_aliases):
        raise SeedLedgerError("A resolved Spotify alias is also marked resolution pending")
    if finite_int(coverage.get("resolved_source_uuids")) != len(all_uuid_aliases):
        raise SeedLedgerError("FAL seed ledger UUID alias coverage does not match its components")
    if finite_int(coverage.get("unique_spotify_identities")) != len(all_spotify_aliases) + len(spotify_pending):
        raise SeedLedgerError("FAL seed ledger Spotify alias coverage does not match its components")
    if finite_int(coverage.get("expected_identity_components")) != len(artists) + len(pending):
        raise SeedLedgerError("FAL seed ledger identity component coverage is inconsistent")
    expected_hash = _canonical_hash(artists, pending)
    if ledger.get("cohort_hash") != expected_hash:
        raise SeedLedgerError("FAL seed ledger hash does not match its deterministic contents")
    expected_content_hash = _content_hash(artists, pending)
    if ledger.get("content_hash") != expected_content_hash:
        raise SeedLedgerError("FAL seed ledger content hash does not match its deterministic contents")


def stabilize_canonical_uuids(
    current: Mapping[str, Any],
    previous: Mapping[str, Any],
) -> dict[str, Any]:
    """Preserve canonical UUIDs already accepted for matching identity components."""

    stabilized = copy.deepcopy(dict(current))
    current_artists = stabilized.get("artists") if isinstance(stabilized.get("artists"), list) else []
    previous_artists = previous.get("artists") if isinstance(previous.get("artists"), list) else []
    previous_by_uuid: dict[str, str] = {}
    previous_by_spotify: dict[str, str] = {}
    for item in previous_artists:
        if not isinstance(item, Mapping):
            raise SeedLedgerError("Previous FAL seed ledger contains a malformed artist row")
        canonical = str(item.get("soundcharts_uuid") or "").strip()
        if not canonical:
            raise SeedLedgerError("Previous FAL seed ledger contains an empty canonical UUID")
        for raw_alias in item.get("soundcharts_uuid_aliases") or []:
            alias = str(raw_alias or "").strip()
            existing = previous_by_uuid.setdefault(alias, canonical)
            if not alias or existing != canonical:
                raise SeedLedgerError("Previous FAL seed ledger has conflicting UUID aliases")
        for raw_spotify in item.get("spotify_id_aliases") or []:
            spotify = str(raw_spotify or "").strip()
            existing = previous_by_spotify.setdefault(spotify, canonical)
            if not spotify or existing != canonical:
                raise SeedLedgerError("Previous FAL seed ledger has conflicting Spotify aliases")

    matched_components = 0
    changed_canonicals = 0
    reused_previous: set[str] = set()
    for item in current_artists:
        if not isinstance(item, dict):
            raise SeedLedgerError("Current FAL seed ledger contains a malformed artist row")
        uuid_aliases = {str(value or "").strip() for value in item.get("soundcharts_uuid_aliases") or []}
        spotify_aliases = {str(value or "").strip() for value in item.get("spotify_id_aliases") or []}
        matches = {
            canonical
            for alias in uuid_aliases
            if alias and (canonical := previous_by_uuid.get(alias))
        }
        matches.update(
            canonical
            for spotify in spotify_aliases
            if spotify and (canonical := previous_by_spotify.get(spotify))
        )
        if not matches:
            continue
        if len(matches) != 1:
            raise SeedLedgerError(
                "Current FAL identity component merges several previously accepted canonical UUIDs"
            )
        stable = next(iter(matches))
        if stable not in uuid_aliases:
            raise SeedLedgerError(
                "Previously accepted canonical UUID disappeared from its current identity component"
            )
        if stable in reused_previous:
            raise SeedLedgerError(
                "A previously accepted canonical UUID appears in several current identity components"
            )
        reused_previous.add(stable)
        matched_components += 1
        if str(item.get("soundcharts_uuid") or "") != stable:
            item["soundcharts_uuid"] = stable
            changed_canonicals += 1

    current_artists.sort(key=lambda item: (str(item["soundcharts_uuid"]), str(item.get("spotify_id") or "")))
    rejected_uuid_aliases = []
    for item in current_artists:
        canonical = str(item.get("soundcharts_uuid") or "")
        rejected = sorted(
            str(value)
            for value in item.get("soundcharts_uuid_aliases") or []
            if str(value) != canonical
        )
        if rejected:
            rejected_uuid_aliases.append(
                {
                    "spotify_ids": list(item.get("spotify_id_aliases") or []),
                    "canonical_uuid": canonical,
                    "rejected_uuids": rejected,
                }
            )
    rejected_uuid_aliases.sort(key=lambda item: str(item["canonical_uuid"]))
    pending = stabilized.get("resolution_pending") if isinstance(stabilized.get("resolution_pending"), list) else []
    stabilized["rejected_uuid_aliases"] = rejected_uuid_aliases
    stabilized["cohort_hash"] = _canonical_hash(current_artists, pending)
    stabilized["content_hash"] = _content_hash(current_artists, pending)
    stabilized["canonical_stability"] = {
        "previous_cohort_hash": str(previous.get("cohort_hash") or ""),
        "matched_components": matched_components,
        "changed_canonicals": changed_canonicals,
        "new_components": len(current_artists) - matched_components,
        "policy": "preserve_previous_canonical_when_identity_matches",
    }
    return stabilized


def transition_bounds(
    previous_resolved: int,
    *,
    min_resolved: int,
    hard_max_resolved: int,
    max_growth_percent: float,
    max_growth_absolute: int,
    max_shrink_percent: float,
) -> tuple[int, int]:
    """Return fail-closed bounds derived from the last accepted seed ledger."""

    values = {
        "previous_resolved": previous_resolved,
        "min_resolved": min_resolved,
        "hard_max_resolved": hard_max_resolved,
        "max_growth_absolute": max_growth_absolute,
    }
    if any(isinstance(value, bool) or not isinstance(value, int) for value in values.values()):
        raise SeedLedgerError("FAL seed transition count limits must be integers")
    if previous_resolved < 1:
        raise SeedLedgerError("Previous accepted FAL seed ledger must contain at least one resolved seed")
    if min_resolved < 0 or hard_max_resolved < min_resolved or max_growth_absolute < 0:
        raise SeedLedgerError("Invalid FAL seed transition count limits")
    percentages = {
        "max_growth_percent": max_growth_percent,
        "max_shrink_percent": max_shrink_percent,
    }
    for name, value in percentages.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise SeedLedgerError(f"{name} must be a finite percentage")
        if float(value) < 0 or (name == "max_shrink_percent" and float(value) > 100):
            raise SeedLedgerError(f"Invalid {name} policy")

    percentage_growth = math.ceil(previous_resolved * float(max_growth_percent) / 100)
    allowed_growth = min(max_growth_absolute, percentage_growth)
    allowed_min = max(
        min_resolved,
        math.floor(previous_resolved * (1 - float(max_shrink_percent) / 100)),
    )
    allowed_max = min(hard_max_resolved, previous_resolved + allowed_growth)
    if allowed_min > allowed_max:
        raise SeedLedgerError(
            "FAL seed transition policy has no valid range "
            f"({allowed_min}-{allowed_max}; previous={previous_resolved})"
        )
    return allowed_min, allowed_max


def validate_ledger_transition(
    previous: Mapping[str, Any],
    current: Mapping[str, Any],
    *,
    min_resolved: int,
    hard_max_resolved: int,
    max_growth_percent: float,
    max_growth_absolute: int,
    max_shrink_percent: float,
    max_unresolved: int,
) -> dict[str, Any]:
    """Validate a new ledger against the last accepted control artifact."""

    if isinstance(max_unresolved, bool) or not isinstance(max_unresolved, int) or max_unresolved < 0:
        raise SeedLedgerError("max_unresolved must be a non-negative integer")
    validate_ledger(previous, min_resolved=1, max_resolved=hard_max_resolved)
    previous_coverage = previous.get("coverage") if isinstance(previous.get("coverage"), Mapping) else {}
    previous_resolved = finite_int(previous_coverage.get("resolved_uuid"))
    if previous_resolved is None:
        raise SeedLedgerError("Previous accepted FAL seed ledger has no resolved coverage")
    allowed_min, allowed_max = transition_bounds(
        previous_resolved,
        min_resolved=min_resolved,
        hard_max_resolved=hard_max_resolved,
        max_growth_percent=max_growth_percent,
        max_growth_absolute=max_growth_absolute,
        max_shrink_percent=max_shrink_percent,
    )
    validate_ledger(current, min_resolved=allowed_min, max_resolved=allowed_max)
    current_coverage = current.get("coverage") if isinstance(current.get("coverage"), Mapping) else {}
    current_resolved = finite_int(current_coverage.get("resolved_uuid"))
    pending = current.get("resolution_pending") if isinstance(current.get("resolution_pending"), list) else []
    unresolved = len(pending)
    reported_unresolved = finite_int(current_coverage.get("unresolved"))
    if reported_unresolved != unresolved:
        raise SeedLedgerError("FAL seed ledger unresolved coverage does not match its pending rows")
    if unresolved > max_unresolved:
        raise SeedLedgerError(
            f"FAL seed ledger has unresolved identities ({unresolved}; maximum {max_unresolved})"
        )
    assert current_resolved is not None
    delta = current_resolved - previous_resolved
    return {
        "previous_resolved": previous_resolved,
        "current_resolved": current_resolved,
        "delta": delta,
        "delta_percent": round(delta * 100 / previous_resolved, 4),
        "allowed_min": allowed_min,
        "allowed_max": allowed_max,
        "unresolved": unresolved,
        "previous_cohort_hash": str(previous.get("cohort_hash") or ""),
        "policy": {
            "minimum_resolved": min_resolved,
            "hard_maximum_resolved": hard_max_resolved,
            "maximum_growth_percent": max_growth_percent,
            "maximum_growth_absolute": max_growth_absolute,
            "maximum_shrink_percent": max_shrink_percent,
            "maximum_unresolved": max_unresolved,
        },
    }


def read_ledger_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SeedLedgerError(f"Invalid previous FAL seed ledger: {path}") from exc
    if not isinstance(payload, dict):
        raise SeedLedgerError(f"Previous FAL seed ledger must contain an object: {path}")
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--active-snapshot", type=Path, required=True)
    parser.add_argument("--browse-catalogue", type=Path, required=True)
    parser.add_argument("--performance", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--previous-ledger", type=Path)
    parser.add_argument("--min-resolved", type=int, default=1)
    parser.add_argument("--max-resolved", type=int, default=10_000)
    parser.add_argument("--max-growth-percent", type=float, default=35)
    parser.add_argument("--max-growth-absolute", type=int, default=2_000)
    parser.add_argument("--max-shrink-percent", type=float, default=20)
    parser.add_argument("--max-unresolved", type=int, default=0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    active = read_js_payload(args.active_snapshot, SOUNDCHARTS_PREFIX)
    browse = read_generic_js(args.browse_catalogue)
    performance = read_generic_js(args.performance)
    observations = collect_observations(active=active, browse=browse, performance=performance)
    ledger = build_ledger(
        observations,
        source_files=[args.active_snapshot.name, args.browse_catalogue.name, args.performance.name],
    )
    if args.previous_ledger is not None:
        previous = read_ledger_json(args.previous_ledger)
        validate_ledger(previous, min_resolved=1, max_resolved=args.max_resolved)
        ledger = stabilize_canonical_uuids(ledger, previous)
        ledger["transition"] = validate_ledger_transition(
            previous,
            ledger,
            min_resolved=args.min_resolved,
            hard_max_resolved=args.max_resolved,
            max_growth_percent=args.max_growth_percent,
            max_growth_absolute=args.max_growth_absolute,
            max_shrink_percent=args.max_shrink_percent,
            max_unresolved=args.max_unresolved,
        )
    else:
        validate_ledger(ledger, min_resolved=args.min_resolved, max_resolved=args.max_resolved)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(ledger, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"seed_ledger": ledger["coverage"], "alias_dedup": ledger["alias_dedup"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
