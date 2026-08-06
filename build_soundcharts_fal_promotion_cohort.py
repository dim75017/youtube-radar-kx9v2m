#!/usr/bin/env python3
"""Build an encrypted-only, fail-closed FAL promotion candidate cohort.

This command compares exact Spotify track identifiers from the private FAL
review manifest with the current browse catalogue.  It does not write a
canonical or dashboard file.  A row is exported only when every required
piece of evidence is explicit; absent or ambiguous values remain excluded.
The resulting private cohort still requires Dim's explicit validation before
any later canonical promotion.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from scan_soundcharts_fal_phase1 import FORBIDDEN_GENRES


COHORT_VERSION = 1
DEFAULT_MIN_STREAMS = 100_000
SPOTIFY_TRACK_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")
APPROVED_RIGHTS = {"self released", "independent label"}
APPROVED_AI = {"low", "faible"}
REVIEW_AI = {"", "unknown", "a verifier", "at verify", "pending", "review required"}
BLOCKED_AI = {"high", "elevated", "eleve", "critical", "fort"}
APPROVED_REVIEW = {"approved", "approve", "validated", "valide"}
APPROVED_NON_SUPERSTAR = {
    "not superstar",
    "non superstar",
    "not a superstar",
    "not_superstar",
    "non_superstar",
}
APPROVED_NO_LYRICS = {
    "no lyrics",
    "no lyric",
    "lyrics free",
    "instrumental no lyrics",
    "no vocals",
    "non vocal",
    "non-vocal",
}
UNAPPROVED_SOURCE_MARKERS = {
    "unknown",
    "unverified",
    "private",
    "staging",
    "pending",
    "soundcharts fal phase2 private",
}
FORBIDDEN_AGGREGATE_KEYS = {
    "tracks",
    "rows",
    "records",
    "candidate_ids",
    "spotify_ids",
    "track_ids",
    "artist_ids",
    "names",
    "titles",
}


class FalPromotionError(RuntimeError):
    """Raised when a promotion audit cannot be proven safe."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def normalise_label(value: Any) -> str:
    raw = unicodedata.normalize("NFKD", str(value or "").strip().casefold())
    ascii_value = "".join(char for char in raw if not unicodedata.combining(char))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", ascii_value).split())


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def stable_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise FalPromotionError(f"{label} is missing: {path.resolve()}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FalPromotionError(f"{label} is not valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise FalPromotionError(f"{label} is not a JSON object")
    return dict(payload)


def validate_review_manifest(
    manifest: Mapping[str, Any], minimum_streams: int
) -> list[dict[str, Any]]:
    if manifest.get("staging_only") is not True:
        raise FalPromotionError("FAL review manifest is not staging-only")
    if manifest.get("canonical_written") is not False:
        raise FalPromotionError("FAL review manifest indicates a canonical write")
    if manifest.get("dashboard_written") is not False:
        raise FalPromotionError("FAL review manifest indicates a dashboard write")
    if int(manifest.get("minimum_lifetime_streams") or 0) != int(minimum_streams):
        raise FalPromotionError("FAL review manifest uses a different stream floor")
    raw_tracks = manifest.get("tracks")
    if not isinstance(raw_tracks, Sequence) or isinstance(
        raw_tracks, (str, bytes, bytearray)
    ):
        raise FalPromotionError("FAL review manifest lacks a track list")
    tracks: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_tracks):
        if not isinstance(raw, Mapping):
            raise FalPromotionError(f"FAL review row {index} is not an object")
        tracks.append(dict(raw))
    summary = manifest.get("summary")
    if isinstance(summary, Mapping) and "tracks" in summary:
        if int(summary.get("tracks") or 0) != len(tracks):
            raise FalPromotionError("FAL review manifest summary count is inconsistent")
    return tracks


def _parse_catalogue_assignment(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FalPromotionError(f"Canonical browse catalogue is missing: {path.resolve()}")
    text = path.read_text(encoding="utf-8-sig").strip()
    prefix = "window.SPOTIFY_BROWSE_CATALOGUE="
    if not text.startswith(prefix):
        raise FalPromotionError("Canonical browse catalogue has an unexpected assignment")
    raw = text[len(prefix) :].strip()
    if raw.endswith(";"):
        raw = raw[:-1].rstrip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FalPromotionError("Canonical browse catalogue is not valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise FalPromotionError("Canonical browse catalogue payload is not an object")
    return dict(payload)


def _exact_spotify_id(value: Any) -> str:
    clean = str(value or "").strip()
    return clean if SPOTIFY_TRACK_ID_RE.fullmatch(clean) else ""


def canonical_spotify_ids(payload: Mapping[str, Any]) -> tuple[set[str], dict[str, int]]:
    policy = payload.get("policy")
    policy = policy if isinstance(policy, Mapping) else {}
    floor = int(policy.get("minimum_lifetime_streams") or 0)
    if floor != DEFAULT_MIN_STREAMS:
        raise FalPromotionError("Canonical browse catalogue does not use the 100k floor")

    identifiers: set[str] = set()
    invalid_nonempty = 0
    source_counts: dict[str, int] = {}

    for key in ("active_legacy_spotify_ids", "trusted_internal_spotify_ids"):
        raw_values = payload.get(key)
        if not isinstance(raw_values, Sequence) or isinstance(
            raw_values, (str, bytes, bytearray)
        ):
            raise FalPromotionError(f"Canonical browse catalogue lacks {key}")
        valid_from_source: set[str] = set()
        for value in raw_values:
            clean = _exact_spotify_id(value)
            if clean:
                valid_from_source.add(clean)
            elif str(value or "").strip():
                invalid_nonempty += 1
        identifiers.update(valid_from_source)
        source_counts[key] = len(valid_from_source)

    discovery = payload.get("discovery_catalogue")
    if not isinstance(discovery, Mapping):
        raise FalPromotionError("Canonical browse catalogue lacks discovery_catalogue")
    schema = discovery.get("track_schema")
    rows = discovery.get("tracks")
    if not isinstance(schema, Sequence) or isinstance(schema, (str, bytes, bytearray)):
        raise FalPromotionError("Canonical discovery track schema is missing")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        raise FalPromotionError("Canonical discovery tracks are missing")
    try:
        spotify_index = [str(value) for value in schema].index("spotify_id")
    except ValueError as exc:
        raise FalPromotionError("Canonical discovery schema lacks spotify_id") from exc
    discovery_ids: set[str] = set()
    for row in rows:
        value: Any = None
        if isinstance(row, Mapping):
            value = row.get("spotify_id")
        elif isinstance(row, Sequence) and not isinstance(row, (str, bytes, bytearray)):
            if spotify_index >= len(row):
                raise FalPromotionError("Canonical discovery row is shorter than its schema")
            value = row[spotify_index]
        else:
            raise FalPromotionError("Canonical discovery track row is malformed")
        clean = _exact_spotify_id(value)
        if clean:
            discovery_ids.add(clean)
        elif str(value or "").strip():
            invalid_nonempty += 1
    if invalid_nonempty:
        raise FalPromotionError(
            f"Canonical browse catalogue contains {invalid_nonempty} invalid Spotify IDs"
        )
    identifiers.update(discovery_ids)
    source_counts["discovery_catalogue"] = len(discovery_ids)
    if not identifiers:
        raise FalPromotionError("Canonical browse catalogue contains no exact Spotify IDs")
    source_counts["unique_union"] = len(identifiers)
    return identifiers, source_counts


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return []


def _review_sources(record: Mapping[str, Any]) -> list[str]:
    return [str(value).strip() for value in _sequence(record.get("review_sources")) if str(value).strip()]


def _explicit_artist_spotify_ids(record: Mapping[str, Any]) -> list[str]:
    candidates: list[Any] = []
    candidates.append(record.get("artist_spotify_id"))
    candidates.extend(_sequence(record.get("artist_spotify_ids")))
    for artist in _sequence(record.get("artists")):
        if isinstance(artist, Mapping):
            candidates.append(artist.get("spotify_id"))
    return sorted({_exact_spotify_id(value) for value in candidates if _exact_spotify_id(value)})


def _explicit_no_lyrics(record: Mapping[str, Any]) -> bool:
    evidence = _mapping(record.get("source_evidence"))
    for source in (record, evidence):
        if source.get("no_lyrics") is True:
            return True
        if source.get("has_lyrics") is False or source.get("vocal") is False:
            return True
        for key in ("lyrics_status", "vocal_status", "no_lyrics_status"):
            if normalise_label(source.get(key)) in APPROVED_NO_LYRICS:
                return True
    return False


def _explicit_non_superstar(record: Mapping[str, Any]) -> bool:
    evidence = _mapping(record.get("source_evidence"))
    for source in (record, evidence):
        if source.get("is_superstar") is False:
            return True
        if normalise_label(source.get("superstar_status")) in {
            normalise_label(value) for value in APPROVED_NON_SUPERSTAR
        }:
            return True
    return False


def _evidence_genres(record: Mapping[str, Any]) -> list[str]:
    genres = _sequence(record.get("genres"))
    evidence = _mapping(record.get("source_evidence"))
    evidence_genres = evidence.get("genres")
    if isinstance(evidence_genres, Mapping):
        genres.extend(_sequence(evidence_genres.get("root")))
        genres.extend(_sequence(evidence_genres.get("sub")))
    else:
        genres.extend(_sequence(evidence_genres))
    return sorted({str(value).strip() for value in genres if str(value).strip()})


def _forbidden_genres(genres: Sequence[str]) -> list[str]:
    detected: set[str] = set()
    normalized_genres = [f" {normalise_label(value)} " for value in genres]
    for marker in FORBIDDEN_GENRES:
        clean = normalise_label(marker)
        if clean and any(f" {clean} " in genre for genre in normalized_genres):
            detected.add(str(marker))
    return sorted(detected)


def _explicit_instrumental(record: Mapping[str, Any]) -> bool:
    if normalise_label(record.get("instrumental_status")) != "instrumental":
        return False
    evidence = _mapping(record.get("source_evidence"))
    if evidence.get("instrumental") is True:
        return True
    if normalise_label(evidence.get("instrumental_status")) == "instrumental":
        return True
    return bool(_review_sources(record))


def _ai_assessment(record: Mapping[str, Any]) -> str:
    """Return low, review_required, or blocked without inventing an AI verdict.

    The browse catalogue may retain an explicitly instrumental/no-lyrics track
    while AI remains unknown, but that row must stay out of Opportunities.
    """

    status = normalise_label(record.get("ai_risk"))
    evidence = _mapping(record.get("source_evidence"))
    evidence_status = normalise_label(evidence.get("ai_risk"))
    if status in BLOCKED_AI or evidence_status in BLOCKED_AI:
        return "blocked"
    if status in APPROVED_AI and (
        evidence_status in APPROVED_AI or bool(_review_sources(record))
    ):
        return "low"
    if status in REVIEW_AI and evidence_status in REVIEW_AI:
        return "review_required"
    return "review_required"


def _explicit_rights(record: Mapping[str, Any]) -> bool:
    if normalise_label(record.get("rights_status")) not in APPROVED_RIGHTS:
        return False
    confidence = finite_number(record.get("rights_confidence"))
    if confidence is None or confidence < 0.5:
        return False
    evidence = _mapping(record.get("source_evidence"))
    return normalise_label(evidence.get("rights_status")) in APPROVED_RIGHTS or bool(
        _review_sources(record)
    )


def _approved_source(record: Mapping[str, Any]) -> bool:
    if record.get("source_approved_for_publication") is not True:
        return False
    tier = normalise_label(record.get("source_tier"))
    if not tier or any(marker in tier for marker in UNAPPROVED_SOURCE_MARKERS):
        return False
    return bool(_mapping(record.get("source_evidence")) or _review_sources(record))


def _human_review_complete(record: Mapping[str, Any]) -> bool:
    if normalise_label(record.get("review_decision")) not in APPROVED_REVIEW:
        return False
    if not str(record.get("reviewer") or "").strip():
        return False
    if not str(record.get("reviewed_at") or "").strip():
        return False
    return bool(_review_sources(record))


def blocking_fields(
    record: Mapping[str, Any],
    *,
    canonical_ids: set[str],
    spotify_counts: Counter[str],
    isrc_counts: Counter[str],
    track_uuid_counts: Counter[str],
    minimum_streams: int,
) -> list[str]:
    blocked: list[str] = []
    spotify_id = _exact_spotify_id(record.get("spotify_id"))
    if not spotify_id or normalise_label(record.get("spotify_identity_status")) != "exact":
        blocked.append("spotify_id")
    elif spotify_id in canonical_ids:
        blocked.append("canonical_duplicate_spotify_id")
    if spotify_id and spotify_counts[spotify_id] > 1:
        blocked.append("duplicate_spotify_id")

    isrc = str(record.get("isrc") or "").strip().upper()
    if isrc and isrc_counts[isrc] > 1:
        blocked.append("duplicate_isrc")
    track_uuid = str(record.get("track_uuid") or "").strip()
    if not track_uuid or track_uuid_counts[track_uuid] > 1:
        blocked.append("track_uuid")

    streams = finite_number(record.get("streams_total"))
    if streams is None or streams < minimum_streams:
        blocked.append("streams_total")
    if not _explicit_instrumental(record):
        blocked.append("instrumental_evidence")
    if normalise_label(record.get("genre_status")) != "in scope":
        blocked.append("genre_evidence")
    genres = _evidence_genres(record)
    if not genres:
        blocked.append("genre_source_evidence")
    if record.get("forbidden_genres_detected") or _forbidden_genres(genres):
        blocked.append("genre_conflict")
    if not _explicit_no_lyrics(record):
        blocked.append("no_lyrics_evidence")
    if not _explicit_non_superstar(record):
        blocked.append("non_superstar_evidence")
    if _ai_assessment(record) == "blocked":
        blocked.append("ai_high_risk")
    if normalise_label(record.get("release_window_status")) != "within window":
        blocked.append("release_window")

    if normalise_label(record.get("artist_identity_status")) != "complete":
        blocked.append("artist_identity")
    if not _explicit_artist_spotify_ids(record):
        blocked.append("artist_spotify_id")
    if not _explicit_rights(record):
        blocked.append("rights_evidence")
    if not _approved_source(record):
        blocked.append("source_approval")
    if not _human_review_complete(record):
        blocked.append("human_review")

    phase2_decision = normalise_label(record.get("phase2_decision"))
    if phase2_decision.startswith("blocked") or phase2_decision.startswith("duplicate"):
        blocked.append("phase2_decision")
    if normalise_label(record.get("review_bucket")) == "blocked":
        blocked.append("review_bucket")
    return sorted(set(blocked))


def _private_candidate(record: Mapping[str, Any], blockers: Sequence[str]) -> dict[str, Any]:
    if blockers:
        raise FalPromotionError("A blocked row cannot enter the private candidate cohort")
    keep = {
        "track_uuid",
        "spotify_id",
        "isrc",
        "title",
        "credit_name",
        "release_date",
        "streams_total",
        "streams_source_date",
        "candidate_uuid",
        "candidate_name",
        "artist_spotify_id",
        "artist_spotify_ids",
        "artists",
        "instrumental_status",
        "genre_status",
        "genres",
        "ai_risk",
        "rights_status",
        "rights_confidence",
        "source_tier",
        "source_approved_for_publication",
        "source_evidence",
        "review_decision",
        "reviewer",
        "reviewed_at",
        "review_sources",
        "review_notes",
        "record_digest",
    }
    candidate = {key: record.get(key) for key in sorted(keep) if key in record}
    candidate["blocking_fields"] = []
    candidate["canonical_duplicate_spotify_id"] = False
    candidate["ai_review_required"] = _ai_assessment(record) != "low"
    candidate["opportunity_eligible"] = _ai_assessment(record) == "low"
    candidate["explicit_dim_promotion_validation_required"] = True
    candidate["candidate_digest"] = stable_digest(candidate)
    return candidate


def _assert_aggregate_only(value: Any, path: str = "summary") -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            clean = normalise_label(key).replace(" ", "_")
            if clean in FORBIDDEN_AGGREGATE_KEYS:
                raise FalPromotionError(f"Aggregate report contains row-level key: {path}.{key}")
            _assert_aggregate_only(nested, f"{path}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        raise FalPromotionError(f"Aggregate report contains a list at {path}")


def build_cohort(
    manifest: Mapping[str, Any],
    canonical: Mapping[str, Any],
    *,
    minimum_streams: int = DEFAULT_MIN_STREAMS,
    source_manifest_sha256: str = "",
    canonical_sha256: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    if int(minimum_streams) != DEFAULT_MIN_STREAMS:
        raise FalPromotionError(
            f"FAL promotion floor must remain {DEFAULT_MIN_STREAMS} streams"
        )
    tracks = validate_review_manifest(manifest, minimum_streams)
    canonical_ids, canonical_counts = canonical_spotify_ids(canonical)

    spotify_counts: Counter[str] = Counter(
        spotify_id
        for record in tracks
        if (spotify_id := _exact_spotify_id(record.get("spotify_id")))
    )
    isrc_counts: Counter[str] = Counter(
        isrc
        for record in tracks
        if (isrc := str(record.get("isrc") or "").strip().upper())
    )
    track_uuid_counts: Counter[str] = Counter(
        track_uuid
        for record in tracks
        if (track_uuid := str(record.get("track_uuid") or "").strip())
    )

    blockers_by_track: list[list[str]] = []
    candidates: list[dict[str, Any]] = []
    blocker_counts: Counter[str] = Counter()
    canonical_duplicate_rows = 0
    exact_identity_rows = 0
    for record in tracks:
        if _exact_spotify_id(record.get("spotify_id")) and normalise_label(
            record.get("spotify_identity_status")
        ) == "exact":
            exact_identity_rows += 1
        blockers = blocking_fields(
            record,
            canonical_ids=canonical_ids,
            spotify_counts=spotify_counts,
            isrc_counts=isrc_counts,
            track_uuid_counts=track_uuid_counts,
            minimum_streams=minimum_streams,
        )
        blockers_by_track.append(blockers)
        blocker_counts.update(blockers)
        if "canonical_duplicate_spotify_id" in blockers:
            canonical_duplicate_rows += 1
        if not blockers:
            candidates.append(_private_candidate(record, blockers))

    candidates.sort(
        key=lambda record: (
            -int(finite_number(record.get("streams_total")) or 0),
            str(record.get("spotify_id") or ""),
        )
    )
    candidate_artists = {
        identifier
        for record in candidates
        for identifier in _explicit_artist_spotify_ids(record)
    }
    evidence_blockers = {
        "instrumental_evidence",
        "genre_evidence",
        "genre_source_evidence",
        "genre_conflict",
        "no_lyrics_evidence",
        "non_superstar_evidence",
        "artist_identity",
        "artist_spotify_id",
        "rights_evidence",
        "source_approval",
    }
    unknown_or_unproven_rows = sum(
        1 for blockers in blockers_by_track if evidence_blockers.intersection(blockers)
    )
    ai_review_required_candidates = sum(
        1 for record in candidates if record.get("ai_review_required") is True
    )
    opportunity_candidates = sum(
        1 for record in candidates if record.get("opportunity_eligible") is True
    )
    candidate_digest = stable_digest(
        [record["candidate_digest"] for record in candidates]
    )
    canonical_ids_digest = stable_digest(sorted(canonical_ids))
    generated_at = utc_now()
    cohort = {
        "version": COHORT_VERSION,
        "generated_at": generated_at,
        "status": "awaiting_explicit_dim_validation",
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "promotion_executed": False,
        "minimum_lifetime_streams": int(minimum_streams),
        "source": {
            "kind": "soundcharts_fal_private_review_manifest",
            "manifest_sha256": source_manifest_sha256,
            "manifest_records_digest": str(manifest.get("records_digest") or ""),
            "canonical_browse_sha256": canonical_sha256,
            "canonical_spotify_ids_digest": canonical_ids_digest,
        },
        "canonical_comparison": {
            "complete": True,
            "method": "exact_spotify_track_id_only",
            "fuzzy_matching_used": False,
            "canonical_unique_spotify_ids": len(canonical_ids),
            "canonical_source_counts": canonical_counts,
            "canonical_duplicate_rows_excluded": canonical_duplicate_rows,
        },
        "guardrails": {
            "unknown_evidence_excluded": True,
            "instrumental_evidence_required": True,
            "genre_evidence_required": True,
            "no_lyrics_evidence_required": True,
            "non_superstar_evidence_required": True,
            "ai_high_risk_excluded": True,
            "ai_unknown_catalogue_only_and_marked_for_review": True,
            "low_ai_risk_required_for_opportunities": True,
            "rights_evidence_required": True,
            "approved_source_required": True,
            "human_review_required": True,
            "explicit_dim_validation_required_before_canonical_promotion": True,
            "canonical_promotion_implemented": False,
        },
        "summary": {
            "input_tracks": len(tracks),
            "exact_spotify_identity_rows": exact_identity_rows,
            "canonical_duplicate_rows": canonical_duplicate_rows,
            "unknown_or_unproven_rows": unknown_or_unproven_rows,
            "blocked_rows": len(tracks) - len(candidates),
            "promotion_candidate_tracks": len(candidates),
            "promotion_candidate_artists": len(candidate_artists),
            "ai_review_required_candidate_tracks": ai_review_required_candidates,
            "opportunity_candidate_tracks": opportunity_candidates,
            "blocking_field_counts": dict(sorted(blocker_counts.items())),
        },
        "candidate_records_digest": candidate_digest,
        "tracks": candidates,
    }
    summary = {
        "version": COHORT_VERSION,
        "generated_at": generated_at,
        "status": cohort["status"],
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "promotion_executed": False,
        "row_level_data_uploaded": False,
        "minimum_lifetime_streams": int(minimum_streams),
        "source_manifest_sha256": source_manifest_sha256,
        "source_manifest_records_digest": str(manifest.get("records_digest") or ""),
        "canonical_browse_sha256": canonical_sha256,
        "canonical_spotify_ids_digest": canonical_ids_digest,
        "canonical_comparison_complete": True,
        "canonical_comparison_method": "exact_spotify_track_id_only",
        "canonical_unique_spotify_id_count": len(canonical_ids),
        "input_track_count": len(tracks),
        "exact_spotify_identity_row_count": exact_identity_rows,
        "canonical_duplicate_row_count": canonical_duplicate_rows,
        "unknown_or_unproven_row_count": unknown_or_unproven_rows,
        "blocked_row_count": len(tracks) - len(candidates),
        "promotion_candidate_track_count": len(candidates),
        "promotion_candidate_artist_count": len(candidate_artists),
        "ai_review_required_candidate_track_count": ai_review_required_candidates,
        "opportunity_candidate_track_count": opportunity_candidates,
        "blocking_field_counts": dict(sorted(blocker_counts.items())),
        "candidate_records_digest": candidate_digest,
        "explicit_dim_validation_required": True,
        "canonical_promotion_implemented": False,
    }
    _assert_aggregate_only(summary)
    return cohort, summary


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-manifest", type=Path, required=True)
    parser.add_argument("--canonical", type=Path, required=True)
    parser.add_argument("--private-cohort-out", type=Path, required=True)
    parser.add_argument("--summary-out", type=Path, required=True)
    parser.add_argument("--minimum-streams", type=int, default=DEFAULT_MIN_STREAMS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = load_json_object(args.review_manifest, "FAL review manifest")
    canonical = _parse_catalogue_assignment(args.canonical)
    cohort, summary = build_cohort(
        manifest,
        canonical,
        minimum_streams=args.minimum_streams,
        source_manifest_sha256=sha256_file(args.review_manifest),
        canonical_sha256=sha256_file(args.canonical),
    )
    args.private_cohort_out.parent.mkdir(parents=True, exist_ok=True)
    args.summary_out.parent.mkdir(parents=True, exist_ok=True)
    args.private_cohort_out.write_text(
        json.dumps(cohort, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    args.summary_out.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
