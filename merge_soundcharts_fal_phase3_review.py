#!/usr/bin/env python3
"""Merge Phase-3 evidence into the private Phase-2 FAL review manifest.

This is a fail-closed projection, not a promotion step.  Phase 2 remains the
authority for track facts and identity.  Only the explicitly allowlisted
Phase-3 evidence fields may be overlaid, negative evidence cannot be
downgraded, and every human/source approval field remains pending.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from build_soundcharts_fal_review_manifest import (
    BUCKET_ORDER,
    blocking_fields as review_blocking_fields,
    classify_review_bucket,
    finite_number,
    forbidden_genres_detected as review_forbidden_genres_detected,
    stable_digest,
)
from expand_soundcharts_instrumental_pool import (
    SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
)


MERGE_VERSION = 1
MANIFEST_VERSION = 1
PHASE3_VERSION = 1
DEFAULT_MINIMUM_STREAMS = 100_000
ADVANCED_REVIEW_BUCKET = "ai_review_required"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_ID_RE = re.compile(r"^[1-9][0-9]*$")
SPOTIFY_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")
ARTIST_PROVIDER_IDENTITY_CONTRACT = "soundcharts_artist_identifiers_default_v1"

IDENTITY_FIELDS = ("track_uuid", "candidate_uuid", "spotify_id", "isrc")
MANUAL_FIELD_DEFAULTS: dict[str, Any] = {
    "source_approved_for_publication": False,
    "review_decision": "pending",
    "reviewer": "",
    "reviewed_at": "",
    "review_sources": [],
    "review_notes": "",
}
RECORD_DIGEST_EXCLUDED_FIELDS = frozenset(
    {
        "review_decision",
        "reviewer",
        "reviewed_at",
        "review_sources",
        "review_notes",
        "record_digest",
    }
)

# Phase 3 may change only evidence/provenance or operational evidence status.
# Everything else remains an exact Phase-2 fact.
PHASE3_EVIDENCE_OVERLAY_FIELDS = frozenset(
    {
        "source_evidence",
        "rights_status",
        "rights_confidence",
        "label",
        "copyright",
        "no_lyrics",
        "ai_risk",
        "artist_spotify_id",
        "artist_identity_status",
        "instrumental_status",
        "phase3_detail_status",
        "phase3_artist_identity_source",
        "phase3_artist_identity_contract",
        "phase3_artist_identity_observed_at",
        "phase3_decision",
        "evidence_updated_at",
        "source_contract",
    }
)
DERIVED_RECORD_FIELDS = frozenset(
    {
        "identity_status",
        "forbidden_genres_detected",
        "blocking_fields",
        "review_bucket",
        "review_reason",
        "record_digest",
    }
)
SOURCE_EVIDENCE_OVERLAY_FIELDS = frozenset(
    {
        "source",
        "source_contract",
        "evidence_updated_at",
        "instrumental",
        "vocal",
        "genres",
        "ai_risk",
        "rights_status",
        "rights_confidence",
        "rights_basis",
        "no_lyrics",
    }
)
PHASE3_GUARDRAIL_ADDITIONS: dict[str, Any] = {
    "source_approval_remains_manual": True,
    "human_review_remains_manual": True,
    "ai_risk_never_inferred": True,
    "no_lyrics_never_inferred_from_instrumentalness": True,
    "audience_size_and_career_stage_never_block": True,
    "canonical_promotion_implemented": False,
}

RIGHTS_RANK = {
    "unknown": 0,
    "self_released": 1,
    "independent_label": 2,
    "other_label": 3,
    "mixed": 4,
    "major": 5,
}
NEGATIVE_RIGHTS = {"other_label", "mixed", "major"}
AI_LOW = {"low", "faible"}
AI_HIGH = {"high", "elevated", "eleve", "élevé"}
PHASE3_DETAIL_STATUSES = {
    "",
    "pending",
    "retry",
    "inflight",
    "complete_cache",
    "complete_provider",
    "unavailable",
    "request_failed",
}
ARTIST_IDENTITY_SOURCES = {
    "",
    "phase1_candidates_exact_spotify_id",
    "soundcharts_bootstrap_cache",
    "soundcharts_artist_identifiers",
    "soundcharts_artist_identifiers_tiebreak",
    "soundcharts_artist_identifiers_conflict",
    "soundcharts_artist_identifiers_collision",
    "cache_or_cross_source_identity_conflict",
}
PROVIDER_ARTIST_IDENTITY_SOURCES = {
    "soundcharts_artist_identifiers",
    "soundcharts_artist_identifiers_tiebreak",
}
COMPLETE_ARTIST_IDENTITY_SOURCES = {
    "phase1_candidates_exact_spotify_id",
    "soundcharts_bootstrap_cache",
    *PROVIDER_ARTIST_IDENTITY_SOURCES,
}
CONFLICT_ARTIST_IDENTITY_SOURCES = {
    "soundcharts_artist_identifiers_conflict",
    "soundcharts_artist_identifiers_collision",
    "cache_or_cross_source_identity_conflict",
}


class FalPhase3ReviewMergeError(RuntimeError):
    """Raised when Phase-2/Phase-3 review inputs cannot be merged safely."""


# Short compatibility alias for callers that use the operation name.
FalReviewMergeError = FalPhase3ReviewMergeError


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise FalPhase3ReviewMergeError(f"{label} is missing: {path.resolve()}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FalPhase3ReviewMergeError(f"{label} is not valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise FalPhase3ReviewMergeError(f"{label} must be a JSON object")
    return dict(payload)


def record_digest(record: Mapping[str, Any]) -> str:
    """Use the existing review-manifest digest contract."""

    return stable_digest(
        {
            key: value
            for key, value in record.items()
            if key not in RECORD_DIGEST_EXCLUDED_FIELDS
        }
    )


def _require_sha256(value: Any, label: str, *, allow_empty: bool = False) -> str:
    clean = str(value or "")
    if allow_empty and not clean:
        return ""
    if not SHA256_RE.fullmatch(clean):
        raise FalPhase3ReviewMergeError(f"{label} must be an exact SHA-256")
    return clean


def _require_artifact_id(value: Any, label: str) -> str:
    clean = str(value or "")
    if not ARTIFACT_ID_RE.fullmatch(clean):
        raise FalPhase3ReviewMergeError(
            f"{label} must be a positive decimal artifact ID"
        )
    return clean


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise FalPhase3ReviewMergeError(f"{label} must be an object")
    return dict(value)


def _nonnegative_count(payload: Mapping[str, Any], key: str, label: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise FalPhase3ReviewMergeError(f"{label} {key} must be an integer")
    if value < 0:
        raise FalPhase3ReviewMergeError(f"{label} {key} cannot be negative")
    return value


def _rows(payload: Mapping[str, Any], label: str) -> list[dict[str, Any]]:
    raw_rows = payload.get("tracks")
    if not isinstance(raw_rows, list):
        raise FalPhase3ReviewMergeError(f"{label} must contain a track list")
    rows: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_rows):
        if not isinstance(raw, Mapping):
            raise FalPhase3ReviewMergeError(
                f"{label} row {index} must be an object"
            )
        rows.append(dict(raw))
    return rows


def validate_manifest_digests(
    manifest: Mapping[str, Any], label: str
) -> list[dict[str, Any]]:
    """Verify every row digest and the ordered manifest digest."""

    rows = _rows(manifest, label)
    digests: list[str] = []
    for index, row in enumerate(rows):
        supplied = _require_sha256(
            row.get("record_digest"), f"{label} row {index} record_digest"
        )
        expected = record_digest(row)
        if supplied != expected:
            raise FalPhase3ReviewMergeError(
                f"{label} row {index} has a stale record digest"
            )
        digests.append(supplied)
    supplied_manifest = _require_sha256(
        manifest.get("records_digest"), f"{label} records_digest"
    )
    expected_manifest = stable_digest(digests)
    if supplied_manifest != expected_manifest:
        raise FalPhase3ReviewMergeError(f"{label} has a stale records digest")
    summary = _mapping(manifest.get("summary"), f"{label} summary")
    try:
        summary_tracks = int(summary.get("tracks"))
    except (TypeError, ValueError) as exc:
        raise FalPhase3ReviewMergeError(
            f"{label} summary has no exact track count"
        ) from exc
    if summary_tracks != len(rows):
        raise FalPhase3ReviewMergeError(
            f"{label} summary track count differs from its rows"
        )
    return rows


def _validate_private_flags(
    payload: Mapping[str, Any], label: str, *, require_promotion_flag: bool
) -> None:
    if payload.get("staging_only") is not True:
        raise FalPhase3ReviewMergeError(f"{label} is not private staging")
    if payload.get("canonical_written") is not False:
        raise FalPhase3ReviewMergeError(f"{label} reports a canonical write")
    if payload.get("dashboard_written") is not False:
        raise FalPhase3ReviewMergeError(f"{label} reports a dashboard write")
    if require_promotion_flag and payload.get("promotion_executed") is not False:
        raise FalPhase3ReviewMergeError(f"{label} reports an automatic promotion")


def _validate_manual_fields(record: Mapping[str, Any], label: str) -> None:
    for key, expected in MANUAL_FIELD_DEFAULTS.items():
        if key not in record or record.get(key) != expected:
            raise FalPhase3ReviewMergeError(
                f"{label} cannot set manual field {key}; it must remain {expected!r}"
            )


def _identity_tuple(record: Mapping[str, Any], label: str) -> tuple[str, str, str, str]:
    values: list[str] = []
    for key in IDENTITY_FIELDS:
        value = record.get(key)
        if not isinstance(value, str):
            raise FalPhase3ReviewMergeError(f"{label} identity field {key} must be text")
        values.append(value)
    if not values[0].strip() or not values[1].strip():
        raise FalPhase3ReviewMergeError(
            f"{label} requires non-empty track_uuid and candidate_uuid"
        )
    return values[0], values[1], values[2], values[3]


def _identity_index(
    rows: Sequence[Mapping[str, Any]], label: str
) -> dict[tuple[str, str, str, str], dict[str, Any]]:
    indexed: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    seen_track_uuids: set[str] = set()
    for index, row in enumerate(rows):
        identity = _identity_tuple(row, f"{label} row {index}")
        if identity in indexed:
            raise FalPhase3ReviewMergeError(
                f"{label} contains a duplicate identity tuple: {identity!r}"
            )
        if identity[0] in seen_track_uuids:
            raise FalPhase3ReviewMergeError(
                f"{label} contains duplicate track_uuid {identity[0]}"
            )
        seen_track_uuids.add(identity[0])
        indexed[identity] = dict(row)
    return indexed


def _validate_spotify_identity(record: Mapping[str, Any], label: str) -> None:
    spotify_id = str(record.get("spotify_id") or "")
    status = str(record.get("spotify_identity_status") or "").strip().casefold()
    if status == "exact" and not SPOTIFY_ID_RE.fullmatch(spotify_id):
        raise FalPhase3ReviewMergeError(
            f"{label} claims an exact Spotify track identity without an exact ID"
        )


def _validate_phase2_manifest(
    manifest: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    if int(manifest.get("version") or 0) != MANIFEST_VERSION:
        raise FalPhase3ReviewMergeError("Phase-2 manifest version must be 1")
    _validate_private_flags(manifest, "Phase-2 manifest", require_promotion_flag=False)
    if int(manifest.get("minimum_lifetime_streams") or 0) != DEFAULT_MINIMUM_STREAMS:
        raise FalPhase3ReviewMergeError("Phase-2 manifest lost the inclusive 100k floor")
    source = _mapping(manifest.get("source"), "Phase-2 manifest source")
    if source.get("kind") != "soundcharts_fal_phase2_private_staging":
        raise FalPhase3ReviewMergeError("Phase-2 manifest source kind is unsupported")
    if not str(source.get("phase2_report_generated_at") or "").strip():
        raise FalPhase3ReviewMergeError("Phase-2 report generation lineage is missing")
    try:
        if int(source.get("phase2_report_version")) <= 0:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise FalPhase3ReviewMergeError("Phase-2 report version lineage is missing") from exc
    _require_sha256(source.get("phase2_state_sha256"), "Phase-2 state lineage")
    _require_sha256(source.get("phase2_report_sha256"), "Phase-2 report lineage")
    checkpoint = _mapping(
        source.get("phase2_source_checkpoint"), "Phase-2 source checkpoint"
    )
    _require_artifact_id(
        checkpoint.get("phase1_source_id"), "Phase-2 source checkpoint phase1_source_id"
    )
    for index, row in enumerate(rows):
        _validate_manual_fields(row, f"Phase-2 row {index}")
        _validate_spotify_identity(row, f"Phase-2 row {index}")
    return source


def _validate_phase3_manifest(
    phase2: Mapping[str, Any],
    phase3: Mapping[str, Any],
    phase2_source: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if int(phase3.get("version") or 0) != MANIFEST_VERSION:
        raise FalPhase3ReviewMergeError("Phase-3 manifest version must be 1")
    _validate_private_flags(phase3, "Phase-3 manifest", require_promotion_flag=True)
    if int(phase3.get("minimum_lifetime_streams") or 0) != DEFAULT_MINIMUM_STREAMS:
        raise FalPhase3ReviewMergeError("Phase-3 manifest lost the inclusive 100k floor")

    allowed_top_level_changes = {
        "generated_at",
        "status",
        "promotion_executed",
        "source",
        "guardrails",
        "summary",
        "records_digest",
        "track_schema",
        "tracks",
    }
    missing = set(phase2).difference(phase3)
    if missing:
        raise FalPhase3ReviewMergeError(
            f"Phase-3 manifest removed Phase-2 top-level fields: {sorted(missing)}"
        )
    unexpected = set(phase3).difference(phase2).difference(allowed_top_level_changes)
    if unexpected:
        raise FalPhase3ReviewMergeError(
            f"Phase-3 manifest added unsupported top-level fields: {sorted(unexpected)}"
        )
    for key in set(phase2).intersection(phase3).difference(allowed_top_level_changes):
        if phase3.get(key) != phase2.get(key):
            raise FalPhase3ReviewMergeError(
                f"Phase-3 manifest mutated authoritative Phase-2 field {key}"
            )

    source = _mapping(phase3.get("source"), "Phase-3 manifest source")
    for key, expected in phase2_source.items():
        if source.get(key) != expected:
            raise FalPhase3ReviewMergeError(
                f"Phase-3 manifest source mutated Phase-2 lineage field {key}"
            )
    unexpected_source = set(source).difference(phase2_source).difference(
        {"phase3_state_version"}
    )
    if unexpected_source:
        raise FalPhase3ReviewMergeError(
            "Phase-3 manifest source has unsupported lineage fields: "
            f"{sorted(unexpected_source)}"
        )
    if int(source.get("phase3_state_version") or 0) != PHASE3_VERSION:
        raise FalPhase3ReviewMergeError("Phase-3 state version lineage must be 1")

    phase2_guardrails = _mapping(phase2.get("guardrails"), "Phase-2 guardrails")
    phase3_guardrails = _mapping(phase3.get("guardrails"), "Phase-3 guardrails")
    for key, expected in phase2_guardrails.items():
        if phase3_guardrails.get(key) != expected:
            raise FalPhase3ReviewMergeError(
                f"Phase-3 manifest mutated Phase-2 guardrail {key}"
            )
    unexpected_guardrails = set(phase3_guardrails).difference(phase2_guardrails).difference(
        PHASE3_GUARDRAIL_ADDITIONS
    )
    if unexpected_guardrails:
        raise FalPhase3ReviewMergeError(
            f"Phase-3 manifest added unsupported guardrails: {sorted(unexpected_guardrails)}"
        )
    for key, expected in PHASE3_GUARDRAIL_ADDITIONS.items():
        if phase3_guardrails.get(key) != expected:
            raise FalPhase3ReviewMergeError(f"Phase-3 guardrail {key} is not enforced")

    for index, row in enumerate(rows):
        _validate_manual_fields(row, f"Phase-3 row {index}")
        _validate_spotify_identity(row, f"Phase-3 row {index}")
    return source


def _validate_phase3_report(
    report: Mapping[str, Any],
    *,
    phase2_source: Mapping[str, Any],
    phase2_manifest_sha256: str,
    phase3_manifest_sha256: str,
    phase3_records_digest: str,
    phase3_row_count: int,
    phase3_priority_track_count: int,
    phase3_priority_artist_count: int,
    phase3_artist_complete: int,
    phase3_track_complete: int,
) -> dict[str, Any]:
    if int(report.get("version") or 0) != PHASE3_VERSION:
        raise FalPhase3ReviewMergeError("Phase-3 report version must be 1")
    _validate_private_flags(report, "Phase-3 report", require_promotion_flag=True)
    if report.get("row_level_data_uploaded_unencrypted") is not False:
        raise FalPhase3ReviewMergeError("Phase-3 report permits unencrypted row data")
    if report.get("evidence_complete") is not False:
        raise FalPhase3ReviewMergeError(
            "Phase-3 report must not claim that human evidence is complete"
        )
    if int(report.get("minimum_lifetime_streams") or 0) != DEFAULT_MINIMUM_STREAMS:
        raise FalPhase3ReviewMergeError("Phase-3 report lost the inclusive 100k floor")

    source = _mapping(report.get("source"), "Phase-3 report source")
    if source.get("kind") != "soundcharts_fal_phase2_private_review_manifest":
        raise FalPhase3ReviewMergeError("Phase-3 report source kind is unsupported")
    phase2_artifact_id = _require_artifact_id(
        source.get("phase2_source_artifact_id"), "Phase-3 Phase-2 artifact lineage"
    )
    phase1_artifact_id = _require_artifact_id(
        source.get("phase1_source_artifact_id"), "Phase-3 Phase-1 artifact lineage"
    )
    checkpoint = _mapping(
        phase2_source.get("phase2_source_checkpoint"), "Phase-2 source checkpoint"
    )
    if phase1_artifact_id != str(checkpoint.get("phase1_source_id") or ""):
        raise FalPhase3ReviewMergeError(
            "Phase-3 report Phase-1 artifact does not match the Phase-2 checkpoint"
        )
    if not phase2_artifact_id:
        raise FalPhase3ReviewMergeError("Phase-3 Phase-2 artifact lineage is empty")

    expected_hashes = {
        "phase2_state_sha256": phase2_source.get("phase2_state_sha256"),
        "phase2_report_sha256": phase2_source.get("phase2_report_sha256"),
        "review_manifest_sha256": phase2_manifest_sha256,
        "enriched_manifest_sha256": phase3_manifest_sha256,
        "enriched_manifest_records_digest": phase3_records_digest,
    }
    for key, expected in expected_hashes.items():
        supplied = _require_sha256(source.get(key), f"Phase-3 report source {key}")
        if supplied != str(expected or ""):
            raise FalPhase3ReviewMergeError(
                f"Phase-3 report source binding mismatch: {key}"
            )
    _require_sha256(source.get("phase1_state_sha256"), "Phase-3 Phase-1 state lineage")
    # An empty before-hash is a legitimate first-run sentinel, but the key is
    # required.  The after-hash always binds the encrypted resumable state.
    if "state_sha256_before" not in source:
        raise FalPhase3ReviewMergeError("Phase-3 state before-hash is missing")
    _require_sha256(
        source.get("state_sha256_before"),
        "Phase-3 state before-hash",
        allow_empty=True,
    )
    _require_sha256(source.get("state_sha256_after"), "Phase-3 state after-hash")
    try:
        bound_row_count = int(source.get("enriched_manifest_row_count"))
    except (TypeError, ValueError) as exc:
        raise FalPhase3ReviewMergeError(
            "Phase-3 report enriched manifest row count is missing"
        ) from exc
    if bound_row_count != int(phase3_row_count):
        raise FalPhase3ReviewMergeError(
            "Phase-3 report enriched manifest row count does not match"
        )

    cache_artifact = str(source.get("cache_source_artifact_id") or "")
    cache_hash = str(source.get("cache_sha256") or "")
    if bool(cache_artifact) != bool(cache_hash):
        raise FalPhase3ReviewMergeError(
            "Phase-3 cache artifact ID and SHA-256 must be supplied together"
        )
    if cache_artifact:
        _require_artifact_id(cache_artifact, "Phase-3 cache artifact lineage")
        _require_sha256(cache_hash, "Phase-3 cache SHA-256 lineage")
    elif "cache_source_artifact_id" not in source or "cache_sha256" not in source:
        raise FalPhase3ReviewMergeError("Phase-3 cache lineage keys are missing")

    policy = _mapping(report.get("policy"), "Phase-3 report policy")
    required_policy = {
        "source_approval_remains_manual": True,
        "human_review_remains_manual": True,
        "automatic_promotion": False,
        "no_lyrics_requires_explicit_source_field": True,
        "ai_risk_never_inferred": True,
        "cache_track_terminal_contract": SOUNDCHARTS_SONG_EVIDENCE_CONTRACT,
        "cache_track_terminal_requires_timestamp": True,
        "cache_artist_terminal_requires_exact_id_and_identifiers_fetched_at": True,
        "cache_artifact_id_and_sha256_required": True,
        "phase1_artist_identity_join_before_network": True,
        "cross_source_identity_requires_live_provider_tiebreak": True,
        "artist_identifier_query_spotify_only_default": True,
        "provider_verified_never_tiebreaks": True,
        "provider_tiebreak_requires_unique_default_or_single_filtered_identity": True,
        "provider_tiebreak_must_match_phase1_or_cache": True,
        "audience_size_and_career_stage_never_block": True,
    }
    for key, expected in required_policy.items():
        if policy.get(key) != expected:
            raise FalPhase3ReviewMergeError(
                f"Phase-3 report policy mismatch: {key}"
            )

    coverage = _mapping(report.get("coverage"), "Phase-3 report coverage")
    priority_artists = _nonnegative_count(
        coverage, "priority_artists", "Phase-3 report coverage"
    )
    artist_complete = _nonnegative_count(
        coverage, "artist_identity_complete", "Phase-3 report coverage"
    )
    artist_unresolved = _nonnegative_count(
        coverage, "artist_state_unresolved", "Phase-3 report coverage"
    )
    priority_tracks = _nonnegative_count(
        coverage, "priority_tracks", "Phase-3 report coverage"
    )
    track_complete = _nonnegative_count(
        coverage, "track_evidence_complete", "Phase-3 report coverage"
    )
    track_technical_complete = _nonnegative_count(
        coverage, "track_state_technical_complete", "Phase-3 report coverage"
    )
    track_unresolved = _nonnegative_count(
        coverage, "track_state_unresolved", "Phase-3 report coverage"
    )
    if priority_tracks != phase3_priority_track_count:
        raise FalPhase3ReviewMergeError(
            "Phase-3 priority track count differs from its Phase-2 advanced scope"
        )
    if priority_artists != phase3_priority_artist_count:
        raise FalPhase3ReviewMergeError(
            "Phase-3 priority artist count differs from its Phase-2 advanced scope"
        )
    if artist_complete != phase3_artist_complete:
        raise FalPhase3ReviewMergeError(
            "Phase-3 artist completion count disagrees with its manifest rows"
        )
    if track_complete != phase3_track_complete:
        raise FalPhase3ReviewMergeError(
            "Phase-3 track completion count disagrees with its manifest rows"
        )
    if artist_complete > priority_artists or artist_unresolved != (
        priority_artists - artist_complete
    ):
        raise FalPhase3ReviewMergeError(
            "Phase-3 artist state counts are arithmetically inconsistent"
        )
    if track_complete > priority_tracks or track_unresolved != (
        priority_tracks - track_complete
    ):
        raise FalPhase3ReviewMergeError(
            "Phase-3 track state counts are arithmetically inconsistent"
        )
    if track_technical_complete != track_complete:
        raise FalPhase3ReviewMergeError(
            "Phase-3 technical track count disagrees with track evidence completion"
        )

    requests = _mapping(report.get("requests"), "Phase-3 report requests")
    active = _nonnegative_count(
        requests, "active_remaining", "Phase-3 report requests"
    )
    terminal = _nonnegative_count(
        requests, "terminal_unresolved", "Phase-3 report requests"
    )
    state_unresolved = _nonnegative_count(
        requests, "state_unresolved", "Phase-3 report requests"
    )
    if state_unresolved != artist_unresolved + track_unresolved:
        raise FalPhase3ReviewMergeError(
            "Phase-3 state_unresolved disagrees with coverage deltas"
        )
    if report.get("request_queue_exhausted") is not (active == 0):
        raise FalPhase3ReviewMergeError(
            "Phase-3 queue exhaustion flag disagrees with active requests"
        )
    technical_complete = (
        active == 0 and terminal == 0 and state_unresolved == 0
    )
    if report.get("technical_complete") is not technical_complete:
        raise FalPhase3ReviewMergeError(
            "Phase-3 technical_complete flag disagrees with unresolved technical state"
        )
    if report.get("complete") is not technical_complete:
        raise FalPhase3ReviewMergeError(
            "Phase-3 completion flag disagrees with unresolved technical state"
        )
    return source


def _normalise_ai(value: Any) -> str:
    token = str(value or "unknown").strip().casefold()
    if token in AI_HIGH:
        return "high"
    if token in AI_LOW:
        return "low"
    return "unknown"


def _normalise_rights(value: Any) -> str:
    token = str(value or "unknown").strip().casefold().replace("-", "_").replace(" ", "_")
    return token if token in RIGHTS_RANK else "unknown"


def _select_rights_evidence(
    candidates: Sequence[tuple[str, float | None, str]],
) -> tuple[str, float | None, str]:
    """Select the riskiest status without detaching another status' confidence."""

    normalised = [
        (_normalise_rights(status), confidence, str(basis or ""))
        for status, confidence, basis in candidates
    ]
    selected_status = max(
        (status for status, _, _ in normalised), key=lambda status: RIGHTS_RANK[status]
    )
    matching = [item for item in normalised if item[0] == selected_status]
    finite = [confidence for _, confidence, _ in matching if confidence is not None]
    selected_confidence = max(finite) if finite else None
    selected_basis = next(
        (basis for _, confidence, basis in matching if basis and confidence == selected_confidence),
        next((basis for _, _, basis in matching if basis), ""),
    )
    return selected_status, selected_confidence, selected_basis


def _bool_or_none(value: Any, label: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise FalPhase3ReviewMergeError(f"{label} must be boolean or null")
    return value


def _genres(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise FalPhase3ReviewMergeError(f"{label} must be a list")
    genres: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise FalPhase3ReviewMergeError(f"{label} must contain only text values")
        clean = item.strip()
        if clean and clean not in genres:
            genres.append(clean)
    return genres


def _valid_timestamp(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _phase3_manifest_technical_counts(
    rows: Sequence[Mapping[str, Any]],
) -> tuple[int, int, int]:
    """Derive artist and track completion from the hash-bound row content."""

    artists: dict[str, tuple[str, str, str, str, str]] = {}
    track_complete = 0
    for index, row in enumerate(rows):
        candidate_uuid = str(row.get("candidate_uuid") or "").strip()
        artist_snapshot = (
            str(row.get("artist_spotify_id") or "").strip(),
            str(row.get("artist_identity_status") or "pending").strip(),
            str(row.get("phase3_artist_identity_source") or "").strip(),
            str(row.get("phase3_artist_identity_contract") or "").strip(),
            str(row.get("phase3_artist_identity_observed_at") or "").strip(),
        )
        previous = artists.setdefault(candidate_uuid, artist_snapshot)
        if previous != artist_snapshot:
            raise FalPhase3ReviewMergeError(
                f"Phase-3 manifest has inconsistent artist identity rows for {candidate_uuid}"
            )
        if (
            str(row.get("phase3_detail_status") or "").strip()
            in {"complete_cache", "complete_provider"}
            and str(row.get("source_contract") or "").strip()
            == SOUNDCHARTS_SONG_EVIDENCE_CONTRACT
            and _valid_timestamp(row.get("evidence_updated_at"))
        ):
            track_complete += 1

    artist_complete = 0
    for artist_id, status, source, identity_contract, observed_at in artists.values():
        if (
            status == "complete"
            and SPOTIFY_ID_RE.fullmatch(artist_id)
            and source in COMPLETE_ARTIST_IDENTITY_SOURCES
            and (
                source not in PROVIDER_ARTIST_IDENTITY_SOURCES
                or (
                    identity_contract == ARTIST_PROVIDER_IDENTITY_CONTRACT
                    and _valid_timestamp(observed_at)
                )
            )
            and (
                source in PROVIDER_ARTIST_IDENTITY_SOURCES
                or (not identity_contract and not observed_at)
            )
        ):
            artist_complete += 1
    return len(artists), artist_complete, track_complete


def _validate_evidence_changes(
    phase2_evidence: Mapping[str, Any],
    phase3_evidence: Mapping[str, Any],
    label: str,
) -> set[str]:
    changed: set[str] = set()
    missing = set(phase2_evidence).difference(phase3_evidence)
    for key in set(phase2_evidence).union(phase3_evidence):
        if key in missing or phase2_evidence.get(key) != phase3_evidence.get(key):
            changed.add(key)
    unsupported = changed.difference(SOURCE_EVIDENCE_OVERLAY_FIELDS)
    if unsupported:
        raise FalPhase3ReviewMergeError(
            f"{label} mutated non-allowlisted source evidence: {sorted(unsupported)}"
        )
    for key in ("instrumental", "vocal", "no_lyrics"):
        if key in phase3_evidence:
            _bool_or_none(phase3_evidence.get(key), f"{label} source_evidence.{key}")
    if "genres" in phase3_evidence:
        _genres(phase3_evidence.get("genres"), f"{label} source_evidence.genres")
    if "rights_confidence" in phase3_evidence:
        confidence = finite_number(phase3_evidence.get("rights_confidence"))
        if phase3_evidence.get("rights_confidence") is not None and (
            confidence is None or not 0 <= confidence <= 1
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} source_evidence.rights_confidence must be between 0 and 1"
            )
    for key in ("source", "source_contract", "evidence_updated_at", "rights_basis"):
        if key in phase3_evidence and not isinstance(phase3_evidence.get(key), str):
            raise FalPhase3ReviewMergeError(
                f"{label} source_evidence.{key} must be text"
            )
    return changed


def _phase3_evidence_is_receivable(
    phase2_evidence: Mapping[str, Any],
    phase3_evidence: Mapping[str, Any],
    phase3_record: Mapping[str, Any],
    changed: set[str],
    label: str,
) -> bool:
    top_contract = str(phase3_record.get("source_contract") or "").strip()
    top_timestamp = str(phase3_record.get("evidence_updated_at") or "").strip()
    nested_contract_changed = "source_contract" in changed
    nested_timestamp_changed = "evidence_updated_at" in changed
    nested_contract = str(phase3_evidence.get("source_contract") or "").strip()
    nested_timestamp = str(phase3_evidence.get("evidence_updated_at") or "").strip()

    if top_contract or top_timestamp or nested_contract_changed or nested_timestamp_changed:
        if top_contract != nested_contract or top_timestamp != nested_timestamp:
            raise FalPhase3ReviewMergeError(
                f"{label} has inconsistent top-level and nested evidence provenance"
            )
    if top_contract == SOUNDCHARTS_SONG_EVIDENCE_CONTRACT:
        if not _valid_timestamp(top_timestamp):
            raise FalPhase3ReviewMergeError(
                f"{label} claims the current evidence contract without a valid timestamp"
            )
        return True
    # Empty or legacy provenance is intentionally non-receivable.  It may
    # still contribute negative evidence below, but never a positive approval.
    return False


def _merge_boolean_risk(
    old: bool | None, new: bool | None, *, negative: bool, receivable: bool
) -> bool | None:
    if old is negative or new is negative:
        return negative
    if old is not None:
        return old
    if receivable:
        return new
    return None


def _merge_source_evidence(
    phase2_evidence: Mapping[str, Any],
    phase3_evidence: Mapping[str, Any],
    *,
    receivable: bool,
) -> dict[str, Any]:
    merged = copy.deepcopy(dict(phase2_evidence))

    old_instrumental = _bool_or_none(
        phase2_evidence.get("instrumental"), "Phase-2 source_evidence.instrumental"
    )
    new_instrumental = _bool_or_none(
        phase3_evidence.get("instrumental"), "Phase-3 source_evidence.instrumental"
    )
    instrumental = _merge_boolean_risk(
        old_instrumental, new_instrumental, negative=False, receivable=receivable
    )
    if "instrumental" in phase2_evidence or "instrumental" in phase3_evidence:
        merged["instrumental"] = instrumental

    old_vocal = _bool_or_none(
        phase2_evidence.get("vocal"), "Phase-2 source_evidence.vocal"
    )
    new_vocal = _bool_or_none(
        phase3_evidence.get("vocal"), "Phase-3 source_evidence.vocal"
    )
    vocal = _merge_boolean_risk(
        old_vocal, new_vocal, negative=True, receivable=receivable
    )
    if "vocal" in phase2_evidence or "vocal" in phase3_evidence:
        merged["vocal"] = vocal

    old_genres = _genres(phase2_evidence.get("genres"), "Phase-2 source_evidence.genres")
    new_genres = _genres(phase3_evidence.get("genres"), "Phase-3 source_evidence.genres")
    # Extra genres can only add review context/forbidden blockers; they never
    # upgrade the authoritative Phase-2 genre_status.
    merged_genres = list(dict.fromkeys([*old_genres, *new_genres]))
    if "genres" in phase2_evidence or "genres" in phase3_evidence:
        merged["genres"] = merged_genres

    old_ai = _normalise_ai(phase2_evidence.get("ai_risk"))
    new_ai = _normalise_ai(phase3_evidence.get("ai_risk"))
    if "high" in {old_ai, new_ai}:
        merged["ai_risk"] = "high"
    elif old_ai == "low" or (receivable and new_ai == "low"):
        merged["ai_risk"] = "low"
    elif "ai_risk" in phase2_evidence or "ai_risk" in phase3_evidence:
        merged["ai_risk"] = "unknown"

    old_rights = _normalise_rights(phase2_evidence.get("rights_status"))
    new_rights = _normalise_rights(phase3_evidence.get("rights_status"))
    eligible_new_rights = new_rights if receivable or new_rights in NEGATIVE_RIGHTS else "unknown"
    selected_rights, selected_confidence, selected_basis = _select_rights_evidence(
        [
            (
                old_rights,
                finite_number(phase2_evidence.get("rights_confidence")),
                str(phase2_evidence.get("rights_basis") or ""),
            ),
            (
                eligible_new_rights,
                finite_number(phase3_evidence.get("rights_confidence"))
                if receivable or eligible_new_rights in NEGATIVE_RIGHTS
                else None,
                str(phase3_evidence.get("rights_basis") or "")
                if receivable or eligible_new_rights in NEGATIVE_RIGHTS
                else "",
            ),
        ]
    )
    if "rights_status" in phase2_evidence or "rights_status" in phase3_evidence:
        merged["rights_status"] = selected_rights
        merged["rights_confidence"] = selected_confidence
        if selected_basis:
            merged["rights_basis"] = selected_basis

    explicit_negative = vocal is True or instrumental is False
    old_no_lyrics = phase2_evidence.get("no_lyrics") is True or old_vocal is False
    new_no_lyrics = phase3_evidence.get("no_lyrics") is True or new_vocal is False
    if explicit_negative:
        merged["no_lyrics"] = False
    elif old_no_lyrics or (receivable and new_no_lyrics):
        merged["no_lyrics"] = True
    elif "no_lyrics" in phase2_evidence or "no_lyrics" in phase3_evidence:
        merged["no_lyrics"] = False

    if receivable:
        for key in ("source", "source_contract", "evidence_updated_at"):
            value = phase3_evidence.get(key)
            if value not in (None, ""):
                merged[key] = value
    return merged


def _ensure_authoritative_fields(
    phase2: Mapping[str, Any], phase3: Mapping[str, Any], label: str
) -> None:
    allowed = (
        set(PHASE3_EVIDENCE_OVERLAY_FIELDS)
        | set(DERIVED_RECORD_FIELDS)
        | set(MANUAL_FIELD_DEFAULTS)
    )
    for key in set(phase2).union(phase3):
        if key in allowed:
            continue
        if key not in phase2 or key not in phase3 or phase2.get(key) != phase3.get(key):
            raise FalPhase3ReviewMergeError(
                f"{label} mutated authoritative Phase-2 field {key}"
            )


def _validate_phase3_claims(
    phase2: Mapping[str, Any],
    phase3: Mapping[str, Any],
    phase3_evidence: Mapping[str, Any],
    *,
    receivable: bool,
    label: str,
) -> None:
    p3_ai = _normalise_ai(phase3.get("ai_risk"))
    if phase3.get("ai_risk") != phase2.get("ai_risk"):
        if p3_ai == "unknown" or _normalise_ai(phase3_evidence.get("ai_risk")) != p3_ai:
            raise FalPhase3ReviewMergeError(f"{label} has an unsupported top-level AI claim")

    p3_rights = _normalise_rights(phase3.get("rights_status"))
    if phase3.get("rights_status") != phase2.get("rights_status"):
        if (
            p3_rights == "unknown"
            or _normalise_rights(phase3_evidence.get("rights_status")) != p3_rights
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} has an unsupported top-level rights claim"
            )
    if phase3.get("rights_confidence") != phase2.get("rights_confidence"):
        top_confidence = finite_number(phase3.get("rights_confidence"))
        nested_confidence = finite_number(phase3_evidence.get("rights_confidence"))
        if top_confidence is None or top_confidence != nested_confidence:
            raise FalPhase3ReviewMergeError(
                f"{label} rights confidence is not evidence-backed"
            )

    if phase3.get("no_lyrics") is True:
        explicit = (
            phase3_evidence.get("no_lyrics") is True
            or phase3_evidence.get("vocal") is False
        )
        if not explicit or not receivable:
            # Legacy/unproven positives are ignored by the projection, but a
            # top-level boolean claim must never masquerade as receivable.
            if phase3.get("source_contract") == SOUNDCHARTS_SONG_EVIDENCE_CONTRACT:
                raise FalPhase3ReviewMergeError(
                    f"{label} no_lyrics claim lacks explicit receivable evidence"
                )

    if phase3.get("instrumental_status") != phase2.get("instrumental_status"):
        if str(phase3.get("instrumental_status") or "").casefold() != "vocal":
            raise FalPhase3ReviewMergeError(
                f"{label} cannot auto-upgrade instrumental_status"
            )
        if not (
            phase3_evidence.get("vocal") is True
            or phase3_evidence.get("instrumental") is False
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} vocal status lacks explicit negative evidence"
            )


def _explicit_artist_spotify_ids(record: Mapping[str, Any]) -> set[str]:
    candidates: list[Any] = [record.get("artist_spotify_id")]
    artist_ids = record.get("artist_spotify_ids")
    if isinstance(artist_ids, Sequence) and not isinstance(
        artist_ids, (str, bytes, bytearray)
    ):
        candidates.extend(artist_ids)
    artists = record.get("artists")
    if isinstance(artists, Sequence) and not isinstance(
        artists, (str, bytes, bytearray)
    ):
        for artist in artists:
            if isinstance(artist, Mapping):
                candidates.append(artist.get("spotify_id"))
    return {
        str(value).strip()
        for value in candidates
        if SPOTIFY_ID_RE.fullmatch(str(value or "").strip())
    }


def _merge_artist_identity(
    merged: dict[str, Any], phase3: Mapping[str, Any], label: str
) -> None:
    if not any(
        key in phase3
        for key in (
            "artist_spotify_id",
            "artist_identity_status",
            "phase3_artist_identity_source",
            "phase3_artist_identity_contract",
            "phase3_artist_identity_observed_at",
        )
    ):
        return
    artist_id = str(phase3.get("artist_spotify_id") or "").strip()
    status = str(phase3.get("artist_identity_status") or "pending").strip()
    source = str(phase3.get("phase3_artist_identity_source") or "").strip()
    identity_contract = str(
        phase3.get("phase3_artist_identity_contract") or ""
    ).strip()
    identity_observed_at = str(
        phase3.get("phase3_artist_identity_observed_at") or ""
    ).strip()
    authoritative_ids = _explicit_artist_spotify_ids(merged)
    if len(authoritative_ids) > 1:
        raise FalPhase3ReviewMergeError(
            f"{label} has conflicting authoritative Phase-2 artist Spotify IDs"
        )
    authoritative_id = next(iter(authoritative_ids), "")
    if authoritative_id and artist_id and artist_id != authoritative_id:
        raise FalPhase3ReviewMergeError(
            f"{label} Phase-3 artist Spotify ID conflicts with Phase-2 identity"
        )
    if source not in ARTIST_IDENTITY_SOURCES:
        raise FalPhase3ReviewMergeError(f"{label} has an unsupported artist identity source")
    if source in CONFLICT_ARTIST_IDENTITY_SOURCES and (
        status == "complete" or artist_id
    ):
        raise FalPhase3ReviewMergeError(
            f"{label} conflict artist identity source cannot be complete"
        )
    if source in PROVIDER_ARTIST_IDENTITY_SOURCES:
        if status == "complete" and (
            identity_contract != ARTIST_PROVIDER_IDENTITY_CONTRACT
            or not _valid_timestamp(identity_observed_at)
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} provider artist identity lacks its exact contract/provenance"
            )
        if status != "complete" and (identity_contract or identity_observed_at):
            raise FalPhase3ReviewMergeError(
                f"{label} incomplete provider artist identity carries terminal provenance"
            )
    elif identity_contract or identity_observed_at:
        raise FalPhase3ReviewMergeError(
            f"{label} non-provider artist identity carries provider provenance"
        )
    if status == "complete":
        if (
            not SPOTIFY_ID_RE.fullmatch(artist_id)
            or source not in COMPLETE_ARTIST_IDENTITY_SOURCES
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} complete artist identity lacks an exact sourced Spotify ID"
            )
    elif artist_id:
        raise FalPhase3ReviewMergeError(
            f"{label} non-complete artist identity cannot carry a Spotify ID"
        )
    if authoritative_id and not artist_id:
        # A pending Phase-3 lookup cannot erase an already exact Phase-2 ID.
        return
    merged["artist_spotify_id"] = artist_id
    merged["artist_identity_status"] = status
    merged["phase3_artist_identity_source"] = source
    merged["phase3_artist_identity_contract"] = identity_contract
    merged["phase3_artist_identity_observed_at"] = identity_observed_at


def merge_record(
    phase2: Mapping[str, Any], phase3: Mapping[str, Any], *, index: int
) -> dict[str, Any]:
    label = f"Phase-3 row {index} ({phase2.get('track_uuid')})"
    _validate_manual_fields(phase2, f"Phase-2 row {index}")
    _validate_manual_fields(phase3, label)
    _ensure_authoritative_fields(phase2, phase3, label)

    phase2_evidence = _mapping(
        phase2.get("source_evidence"), f"Phase-2 row {index} source_evidence"
    )
    phase3_evidence = _mapping(
        phase3.get("source_evidence"), f"{label} source_evidence"
    )
    changed = _validate_evidence_changes(phase2_evidence, phase3_evidence, label)
    receivable = _phase3_evidence_is_receivable(
        phase2_evidence, phase3_evidence, phase3, changed, label
    )
    _validate_phase3_claims(
        phase2,
        phase3,
        phase3_evidence,
        receivable=receivable,
        label=label,
    )

    merged = copy.deepcopy(dict(phase2))
    merged_evidence = _merge_source_evidence(
        phase2_evidence, phase3_evidence, receivable=receivable
    )
    merged["source_evidence"] = merged_evidence

    for key in ("phase3_detail_status", "phase3_artist_identity_source"):
        if key in phase3:
            merged[key] = phase3.get(key)
    detail_status = str(merged.get("phase3_detail_status") or "")
    if detail_status not in PHASE3_DETAIL_STATUSES:
        raise FalPhase3ReviewMergeError(f"{label} has an unsupported detail status")
    phase3_decision = str(phase3.get("phase3_decision") or "")
    if phase3_decision:
        if phase3_decision != "blocked_explicit_vocal":
            raise FalPhase3ReviewMergeError(f"{label} has an unsupported Phase-3 decision")
        if not (
            merged_evidence.get("vocal") is True
            or merged_evidence.get("instrumental") is False
        ):
            raise FalPhase3ReviewMergeError(
                f"{label} blocked decision lacks sticky negative evidence"
            )
        merged["phase3_decision"] = phase3_decision

    merged["evidence_updated_at"] = (
        str(phase3.get("evidence_updated_at") or "") if receivable else ""
    )
    merged["source_contract"] = (
        str(phase3.get("source_contract") or "") if receivable else ""
    )

    for key in ("label", "copyright"):
        value = str(phase3.get(key) or "").strip()
        if receivable and value:
            merged[key] = value

    old_ai = _normalise_ai(phase2.get("ai_risk"))
    new_ai = _normalise_ai(phase3.get("ai_risk"))
    evidence_ai = _normalise_ai(merged_evidence.get("ai_risk"))
    if "high" in {old_ai, new_ai, evidence_ai}:
        merged["ai_risk"] = "high"
    elif old_ai == "low" or (receivable and "low" in {new_ai, evidence_ai}):
        merged["ai_risk"] = "low"
    else:
        merged["ai_risk"] = "unknown"

    old_rights = _normalise_rights(phase2.get("rights_status"))
    new_rights = _normalise_rights(phase3.get("rights_status"))
    evidence_rights = _normalise_rights(merged_evidence.get("rights_status"))
    rights_candidates = [
        (
            old_rights,
            finite_number(phase2.get("rights_confidence")),
            str((phase2.get("source_evidence") or {}).get("rights_basis") or "")
            if isinstance(phase2.get("source_evidence"), Mapping)
            else "",
        ),
        (
            evidence_rights,
            finite_number(merged_evidence.get("rights_confidence")),
            str(merged_evidence.get("rights_basis") or ""),
        ),
    ]
    if receivable or new_rights in NEGATIVE_RIGHTS:
        rights_candidates.append(
            (
                new_rights,
                finite_number(phase3.get("rights_confidence")),
                str(phase3_evidence.get("rights_basis") or ""),
            )
        )
    selected_rights, selected_confidence, _ = _select_rights_evidence(
        rights_candidates
    )
    merged["rights_status"] = selected_rights
    merged["rights_confidence"] = selected_confidence

    explicit_negative = (
        merged_evidence.get("vocal") is True
        or merged_evidence.get("instrumental") is False
    )
    if explicit_negative:
        merged["instrumental_status"] = "vocal"
        merged["no_lyrics"] = False
        merged["phase3_decision"] = "blocked_explicit_vocal"
    else:
        if merged_evidence.get("no_lyrics") is True or merged_evidence.get("vocal") is False:
            merged["no_lyrics"] = True
        elif "no_lyrics" in phase2 or "no_lyrics" in phase3:
            merged["no_lyrics"] = False

    _merge_artist_identity(merged, phase3, label)
    merged["identity_status"] = (
        "track_and_artist_complete"
        if str(merged.get("spotify_identity_status") or "").casefold() == "exact"
        and str(merged.get("artist_identity_status") or "").casefold() == "complete"
        and not merged.get("duplicate_spotify_id")
        and not merged.get("duplicate_isrc")
        else "incomplete"
    )

    genres = _genres(merged.get("genres"), f"{label} genres")
    evidence_genres = _genres(
        merged_evidence.get("genres"), f"{label} merged source_evidence.genres"
    )
    merged["forbidden_genres_detected"] = review_forbidden_genres_detected(
        list(dict.fromkeys([*genres, *evidence_genres]))
    )
    for key, expected in MANUAL_FIELD_DEFAULTS.items():
        merged[key] = copy.deepcopy(expected)
    merged["blocking_fields"] = review_blocking_fields(merged)
    merged["review_bucket"], merged["review_reason"] = classify_review_bucket(merged)
    if _normalise_rights(merged.get("rights_status")) in {"major", "mixed"}:
        merged["review_bucket"] = "blocked"
        merged["review_reason"] = "explicit_blocking_rights_evidence"
    merged["record_digest"] = record_digest(merged)
    return merged


def _sort_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
    try:
        streams = int(record.get("streams_total") or 0)
    except (TypeError, ValueError):
        streams = 0
    try:
        source_count = int(record.get("source_count") or 0)
    except (TypeError, ValueError):
        source_count = 0
    try:
        best_rank = int(record.get("best_rank") or 10**9)
    except (TypeError, ValueError):
        best_rank = 10**9
    return (
        BUCKET_ORDER.get(str(record.get("review_bucket") or "blocked"), 10**9),
        -streams,
        -source_count,
        best_rank,
        str(record.get("track_uuid") or ""),
    )


def _summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    bucket_counts = Counter(str(row.get("review_bucket") or "blocked") for row in rows)
    decision_counts = Counter(str(row.get("phase2_decision") or "") for row in rows)
    artists_by_bucket = {
        bucket: len(
            {
                str(row.get("candidate_uuid") or "")
                for row in rows
                if row.get("review_bucket") == bucket and row.get("candidate_uuid")
            }
        )
        for bucket in BUCKET_ORDER
    }
    return {
        "tracks": len(rows),
        "artists": len(
            {str(row.get("candidate_uuid")) for row in rows if row.get("candidate_uuid")}
        ),
        "by_bucket": {
            bucket: int(bucket_counts.get(bucket, 0)) for bucket in BUCKET_ORDER
        },
        "artists_by_bucket": artists_by_bucket,
        "by_phase2_decision": dict(sorted(decision_counts.items())),
        "next_operational_batch": {
            "bucket": "ai_review_required",
            "tracks": int(bucket_counts.get("ai_review_required", 0)),
            "artists": int(artists_by_bucket.get("ai_review_required", 0)),
            "reason": "remaining_evidence_and_manual_approvals_require_review",
        },
    }


def merge_manifests(
    phase2_manifest: Mapping[str, Any],
    phase3_manifest: Mapping[str, Any],
    phase3_report: Mapping[str, Any],
    *,
    phase2_manifest_sha256: str,
    phase3_manifest_sha256: str,
    phase3_report_sha256: str,
) -> dict[str, Any]:
    """Validate the full lineage and return one private merged projection."""

    _require_sha256(phase2_manifest_sha256, "Phase-2 manifest file binding")
    _require_sha256(phase3_manifest_sha256, "Phase-3 manifest file binding")
    _require_sha256(phase3_report_sha256, "Phase-3 report file binding")

    phase2_rows = validate_manifest_digests(phase2_manifest, "Phase-2 manifest")
    phase3_rows = validate_manifest_digests(phase3_manifest, "Phase-3 manifest")
    phase2_source = _validate_phase2_manifest(
        phase2_manifest, phase2_rows
    )
    phase3_source = _validate_phase3_manifest(
        phase2_manifest,
        phase3_manifest,
        phase2_source,
        phase3_rows,
    )
    phase2_index = _identity_index(phase2_rows, "Phase-2 manifest")
    phase3_index = _identity_index(phase3_rows, "Phase-3 manifest")
    if set(phase2_index) != set(phase3_index):
        missing = len(set(phase2_index).difference(phase3_index))
        added = len(set(phase3_index).difference(phase2_index))
        raise FalPhase3ReviewMergeError(
            "Phase-2/Phase-3 identity tuple unions differ "
            f"(missing={missing}, added={added})"
        )

    priority_phase3_rows = [
        phase3_index[identity]
        for identity, phase2_row in phase2_index.items()
        if str(phase2_row.get("review_bucket") or "")
        == ADVANCED_REVIEW_BUCKET
    ]
    (
        phase3_priority_artist_count,
        phase3_artist_complete,
        phase3_track_complete,
    ) = _phase3_manifest_technical_counts(priority_phase3_rows)
    report_source = _validate_phase3_report(
        phase3_report,
        phase2_source=phase2_source,
        phase2_manifest_sha256=phase2_manifest_sha256,
        phase3_manifest_sha256=phase3_manifest_sha256,
        phase3_records_digest=str(phase3_manifest.get("records_digest") or ""),
        phase3_row_count=len(phase3_rows),
        phase3_priority_track_count=len(priority_phase3_rows),
        phase3_priority_artist_count=phase3_priority_artist_count,
        phase3_artist_complete=phase3_artist_complete,
        phase3_track_complete=phase3_track_complete,
    )

    merged_rows = [
        merge_record(phase2_row, phase3_index[identity], index=index)
        for index, (identity, phase2_row) in enumerate(phase2_index.items())
    ]
    merged_rows.sort(key=_sort_key)
    records_digest = stable_digest([row["record_digest"] for row in merged_rows])

    output = copy.deepcopy(dict(phase2_manifest))
    output["generated_at"] = utc_now()
    output["status"] = "phase3_private_evidence_merged_human_review_required"
    output["staging_only"] = True
    output["canonical_written"] = False
    output["dashboard_written"] = False
    output["promotion_executed"] = False
    output_source = copy.deepcopy(dict(phase2_source))
    output_source["phase3_state_version"] = int(
        phase3_source.get("phase3_state_version") or PHASE3_VERSION
    )
    output_source["merge"] = {
        "version": MERGE_VERSION,
        "kind": "soundcharts_fal_phase3_private_review_projection",
        "phase2_manifest_sha256": phase2_manifest_sha256,
        "phase2_manifest_records_digest": str(
            phase2_manifest.get("records_digest") or ""
        ),
        "phase3_manifest_sha256": phase3_manifest_sha256,
        "phase3_manifest_records_digest": str(
            phase3_manifest.get("records_digest") or ""
        ),
        "phase3_report_sha256": phase3_report_sha256,
        "phase3_run_id": str(phase3_report.get("run_id") or ""),
        "phase2_source_artifact_id": str(
            report_source.get("phase2_source_artifact_id") or ""
        ),
        "phase1_source_artifact_id": str(
            report_source.get("phase1_source_artifact_id") or ""
        ),
        "phase1_state_sha256": str(report_source.get("phase1_state_sha256") or ""),
        "phase3_state_sha256_after": str(
            report_source.get("state_sha256_after") or ""
        ),
        "cache_source_artifact_id": str(
            report_source.get("cache_source_artifact_id") or ""
        ),
        "cache_sha256": str(report_source.get("cache_sha256") or ""),
    }
    output["source"] = output_source
    guardrails = copy.deepcopy(dict(phase2_manifest.get("guardrails") or {}))
    guardrails.update(PHASE3_GUARDRAIL_ADDITIONS)
    guardrails.update(
        {
            "phase2_authoritative_fields_preserved": True,
            "phase3_evidence_overlay_allowlisted": True,
            "phase3_positive_evidence_requires_current_contract_and_timestamp": True,
            "negative_evidence_is_sticky": True,
            "identity_tuple_union_is_exact": True,
            "manual_review_fields_unchanged": True,
            "no_canonical_or_dashboard_write": True,
        }
    )
    output["guardrails"] = guardrails
    output["summary"] = _summary(merged_rows)
    output["records_digest"] = records_digest
    output["track_schema"] = list(merged_rows[0]) if merged_rows else []
    output["tracks"] = merged_rows
    validate_manifest_digests(output, "Merged Phase-3 review manifest")
    return output


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase2-manifest", type=Path, required=True)
    parser.add_argument("--phase3-manifest", type=Path, required=True)
    parser.add_argument("--phase3-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    inputs = {
        args.phase2_manifest.resolve(),
        args.phase3_manifest.resolve(),
        args.phase3_report.resolve(),
    }
    if args.output.resolve() in inputs:
        raise FalPhase3ReviewMergeError("Output cannot overwrite a source artifact")

    phase2 = load_json_object(args.phase2_manifest, "Phase-2 review manifest")
    phase3 = load_json_object(args.phase3_manifest, "Phase-3 enriched manifest")
    report = load_json_object(args.phase3_report, "Phase-3 report")
    merged = merge_manifests(
        phase2,
        phase3,
        report,
        phase2_manifest_sha256=file_sha256(args.phase2_manifest),
        phase3_manifest_sha256=file_sha256(args.phase3_manifest),
        phase3_report_sha256=file_sha256(args.phase3_report),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": merged["status"],
                "tracks": merged["summary"]["tracks"],
                "records_digest": merged["records_digest"],
                "output": str(args.output),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
