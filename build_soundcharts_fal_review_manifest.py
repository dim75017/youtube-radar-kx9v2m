#!/usr/bin/env python3
"""Build a private, fail-closed review manifest from FAL phase-2 staging.

The manifest is an operational review queue, not a catalogue export. It never
changes the phase-2 checkpoint and never writes a canonical/dashboard file.
Missing instrumental, genre, or AI evidence remains an explicit review state.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from scan_soundcharts_fal_phase1 import FORBIDDEN_GENRES


MANIFEST_VERSION = 1
DEFAULT_MIN_STREAMS = 100_000
SPOTIFY_TRACK_ID_RE = re.compile(r"^[0-9A-Za-z]{22}$")
EXPECTED_TABLES = {
    "fal_phase2_artist_gate",
    "fal_phase2_details",
    "fal_phase2_queue",
    "fal_phase2_stream_gate",
}
BUCKET_ORDER = {
    "promotion_ready": 0,
    "identity_conflict_review_required": 1,
    "ai_review_required": 2,
    "genre_conflict_review_required": 3,
    "release_window_review_required": 4,
    "genre_review_required": 5,
    "instrumental_review_required": 6,
    "metadata_review_required": 7,
    "blocked": 8,
}
TSV_FIELDS = (
    "review_bucket",
    "review_reason",
    "track_uuid",
    "spotify_id",
    "detail_spotify_id",
    "stream_spotify_id",
    "spotify_url",
    "spotify_identity_status",
    "isrc",
    "title",
    "credit_name",
    "release_date",
    "release_window_status",
    "streams_total",
    "streams_source_date",
    "candidate_uuid",
    "candidate_name",
    "monthly_listeners",
    "source_count",
    "best_rank",
    "career_stage",
    "instrumental_status",
    "genre_status",
    "ai_risk",
    "rights_status",
    "identity_status",
    "source_approved_for_publication",
    "instrumentalness",
    "speechiness",
    "explicit",
    "language_code",
    "genres",
    "forbidden_genres_detected",
    "duplicate_spotify_id",
    "duplicate_isrc",
    "phase2_decision",
    "blocking_fields",
    "record_digest",
)


class FalReviewError(RuntimeError):
    """Raised when the private checkpoint cannot produce a trustworthy queue."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def normalise_label(value: Any) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def safe_json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    try:
        decoded = json.loads(str(raw or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return dict(decoded) if isinstance(decoded, Mapping) else {}


def safe_genres(evidence: Mapping[str, Any]) -> list[str]:
    raw = evidence.get("genres")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return []
    return sorted({str(value).strip() for value in raw if str(value).strip()})


def phrase_label(value: Any) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", normalise_label(value)).split())


def forbidden_genres_detected(genres: Sequence[str]) -> list[str]:
    detected: set[str] = set()
    for genre in genres:
        clean_genre = f" {phrase_label(genre)} "
        for marker in FORBIDDEN_GENRES:
            clean_marker = phrase_label(marker)
            if clean_marker and f" {clean_marker} " in clean_genre:
                detected.add(str(marker))
    return sorted(detected)


def parse_release_day(value: Any) -> dt.date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return dt.date.fromisoformat(raw[:10])
    except ValueError:
        return None


def release_window_status(
    value: Any,
    *,
    release_cutoff: dt.date,
    release_as_of: dt.date,
) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "missing"
    day = parse_release_day(raw)
    if day is None:
        return "invalid"
    if day < release_cutoff:
        return "before_cutoff"
    if day > release_as_of:
        return "after_as_of"
    return "within_window"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def stable_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def blocking_fields(record: Mapping[str, Any]) -> list[str]:
    blocked: list[str] = []
    if normalise_label(record.get("instrumental_status")) != "instrumental":
        blocked.append("instrumental_status")
    if normalise_label(record.get("genre_status")) != "in_scope":
        blocked.append("genre_status")
    if record.get("forbidden_genres_detected"):
        blocked.append("genre_conflict")
    if normalise_label(record.get("release_window_status")) != "within_window":
        blocked.append("release_window")
    if normalise_label(record.get("ai_risk")) not in {"low", "faible"}:
        blocked.append("ai_risk")
    spotify_identity = normalise_label(record.get("spotify_identity_status"))
    if spotify_identity != "exact":
        blocked.append("spotify_id")
    if spotify_identity in {"mismatch", "invalid"}:
        blocked.append("spotify_identity_conflict")
    if record.get("duplicate_spotify_id") is True:
        blocked.append("duplicate_spotify_id")
    if record.get("duplicate_isrc") is True:
        blocked.append("duplicate_isrc")
    if normalise_label(record.get("artist_identity_status")) != "complete":
        blocked.append("artist_spotify_id")
    if normalise_label(record.get("rights_status")) not in {
        "self_released",
        "independent_label",
    }:
        blocked.append("rights_status")
    if (finite_number(record.get("rights_confidence")) or 0) < 0.5:
        blocked.append("rights_confidence")
    if record.get("source_approved_for_publication") is not True:
        blocked.append("source_tier")
    return blocked


def classify_review_bucket(record: Mapping[str, Any]) -> tuple[str, str]:
    """Return a fail-closed review bucket without inferring missing evidence."""

    decision = normalise_label(record.get("phase2_decision"))
    instrumental = normalise_label(record.get("instrumental_status"))
    genre = normalise_label(record.get("genre_status"))
    ai_risk = normalise_label(record.get("ai_risk"))

    if (
        decision.startswith("blocked")
        or instrumental in {"vocal", "non instrumental", "non-instrumental"}
        or genre == "out_of_scope"
        or ai_risk in {"high", "elevated", "eleve", "élevé"}
    ):
        return "blocked", "explicit_blocking_evidence"
    if (
        normalise_label(record.get("spotify_identity_status")) in {"mismatch", "invalid"}
        or record.get("duplicate_spotify_id") is True
        or record.get("duplicate_isrc") is True
    ):
        return "identity_conflict_review_required", "track_identity_conflict"
    if record.get("forbidden_genres_detected"):
        return "genre_conflict_review_required", "target_and_forbidden_genres_conflict"
    release_status = normalise_label(record.get("release_window_status"))
    if release_status and release_status != "within_window":
        return "release_window_review_required", "release_outside_current_phase2_window"
    if not record.get("blocking_fields"):
        return "promotion_ready", "all_publication_evidence_present"
    if instrumental == "instrumental" and genre == "in_scope":
        return (
            "ai_review_required",
            "instrumental_and_genre_evidenced_remaining_checks_required",
        )
    if instrumental == "instrumental":
        return "genre_review_required", "instrumental_evidenced_genre_unknown"
    if genre == "in_scope":
        return "instrumental_review_required", "genre_evidenced_instrumental_unknown"
    return "metadata_review_required", "instrumental_genre_or_ai_evidence_missing"


def spotify_url(spotify_id: str) -> str:
    clean = str(spotify_id or "").strip()
    return (
        f"https://open.spotify.com/track/{clean}"
        if SPOTIFY_TRACK_ID_RE.fullmatch(clean)
        else ""
    )


def spotify_identity(
    detail_spotify_id: Any,
    stream_spotify_id: Any,
) -> tuple[str, str]:
    detail = str(detail_spotify_id or "").strip()
    stream = str(stream_spotify_id or "").strip()
    if detail and stream and detail != stream:
        return "", "mismatch"
    selected = detail or stream
    if not selected:
        return "", "missing"
    if not SPOTIFY_TRACK_ID_RE.fullmatch(selected):
        return selected, "invalid"
    return selected, "exact"


def open_read_only(path: Path) -> sqlite3.Connection:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FalReviewError(f"Phase-2 state is missing: {resolved}")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    quick_check = connection.execute("PRAGMA quick_check").fetchone()
    if not quick_check or quick_check[0] != "ok":
        connection.close()
        raise FalReviewError(f"Invalid phase-2 SQLite checkpoint: {quick_check!r}")
    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    missing = sorted(EXPECTED_TABLES - tables)
    if missing:
        connection.close()
        raise FalReviewError(f"Phase-2 checkpoint lacks tables: {', '.join(missing)}")
    return connection


def validate_phase2_report(path: Path, minimum_streams: int) -> dict[str, Any]:
    if not path.is_file():
        raise FalReviewError(f"Phase-2 report is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise FalReviewError("Phase-2 report is not a JSON object")
    if payload.get("complete") is not True:
        raise FalReviewError("Phase-2 report is not complete")
    if payload.get("staging_only") is not True:
        raise FalReviewError("Phase-2 report is not marked staging-only")
    if payload.get("canonical_written") is not False:
        raise FalReviewError("Phase-2 report indicates a canonical write")
    if payload.get("dashboard_written") is not False:
        raise FalReviewError("Phase-2 report indicates a dashboard write")
    stream_gate = payload.get("stream_gate")
    stream_gate = stream_gate if isinstance(stream_gate, Mapping) else {}
    if int(stream_gate.get("minimum_streams") or 0) != int(minimum_streams):
        raise FalReviewError("Phase-2 report does not match the requested stream floor")
    if stream_gate.get("missing_or_ambiguous_never_passes") is not True:
        raise FalReviewError("Phase-2 report permits ambiguous stream values")
    return dict(payload)


def build_records(
    connection: sqlite3.Connection,
    *,
    minimum_streams: int,
    release_cutoff: dt.date,
    release_as_of: dt.date,
) -> list[dict[str, Any]]:
    invalid_streams = int(
        connection.execute(
            """SELECT COUNT(*) FROM fal_phase2_stream_gate
                 WHERE gate_status='eligible'
                   AND (streams_total IS NULL OR streams_total<?)""",
            (minimum_streams,),
        ).fetchone()[0]
    )
    if invalid_streams:
        raise FalReviewError(
            f"Eligible stream gate contains {invalid_streams} invalid rows"
        )

    rows = connection.execute(
        """SELECT
             s.track_uuid,s.spotify_id AS stream_spotify_id,s.streams_total,
             s.source_date AS streams_source_date,
             d.spotify_id,d.isrc,d.title,d.credit_name,d.release_date,
             d.instrumental_status,d.ai_risk,d.genre_status,
             d.decision AS phase2_decision,d.reason AS phase2_reason,d.evidence_json,
             q.candidate_uuid,
             a.candidate_name,a.monthly_listeners,a.source_count,a.best_rank,
             a.career_stage,a.gate_status AS artist_gate_status
           FROM fal_phase2_stream_gate AS s
           JOIN fal_phase2_details AS d ON d.track_uuid=s.track_uuid
           JOIN fal_phase2_queue AS q ON q.track_uuid=s.track_uuid
           LEFT JOIN fal_phase2_artist_gate AS a
             ON a.candidate_uuid=q.candidate_uuid
          WHERE s.gate_status='eligible' AND s.streams_total>=?""",
        (minimum_streams,),
    ).fetchall()

    eligible_total = int(
        connection.execute(
            "SELECT COUNT(*) FROM fal_phase2_stream_gate WHERE gate_status='eligible'"
        ).fetchone()[0]
    )
    if len(rows) != eligible_total:
        raise FalReviewError(
            "Every stream-eligible track must have detail and artist queue context "
            f"({len(rows)} of {eligible_total})"
        )

    records: list[dict[str, Any]] = []
    for row in rows:
        evidence = safe_json_object(row["evidence_json"])
        detail_spotify_id = str(row["spotify_id"] or "").strip()
        stream_spotify_id = str(row["stream_spotify_id"] or "").strip()
        spotify_id, spotify_identity_status = spotify_identity(
            detail_spotify_id,
            stream_spotify_id,
        )
        genres = safe_genres(evidence)
        record: dict[str, Any] = {
            "track_uuid": str(row["track_uuid"] or ""),
            "spotify_id": spotify_id,
            "detail_spotify_id": detail_spotify_id,
            "stream_spotify_id": stream_spotify_id,
            "spotify_url": spotify_url(spotify_id),
            "spotify_identity_status": spotify_identity_status,
            "isrc": str(row["isrc"] or "").strip(),
            "title": str(row["title"] or "").strip(),
            "credit_name": str(row["credit_name"] or "").strip(),
            "release_date": str(row["release_date"] or "").strip(),
            "streams_total": int(row["streams_total"]),
            "streams_source_date": str(row["streams_source_date"] or "").strip(),
            "candidate_uuid": str(row["candidate_uuid"] or "").strip(),
            "candidate_name": str(row["candidate_name"] or "").strip(),
            "monthly_listeners": row["monthly_listeners"],
            "source_count": int(row["source_count"] or 0),
            "best_rank": row["best_rank"],
            "career_stage": str(row["career_stage"] or "").strip(),
            "artist_gate_status": str(row["artist_gate_status"] or "").strip(),
            "artist_identity_status": "soundcharts_only",
            "instrumental_status": str(row["instrumental_status"] or "unknown"),
            "genre_status": str(row["genre_status"] or "unknown"),
            "ai_risk": str(row["ai_risk"] or "unknown"),
            "rights_status": "unknown",
            "rights_confidence": None,
            "source_tier": "soundcharts_fal_phase2_private",
            "source_approved_for_publication": False,
            "instrumentalness": finite_number(evidence.get("instrumentalness")),
            "speechiness": finite_number(evidence.get("speechiness")),
            "explicit": evidence.get("explicit")
            if isinstance(evidence.get("explicit"), bool)
            else None,
            "language_code": str(evidence.get("language_code") or "").strip(),
            "genres": genres,
            "forbidden_genres_detected": forbidden_genres_detected(genres),
            "duplicate_spotify_id": False,
            "duplicate_isrc": False,
            "source_evidence": evidence,
            "phase2_decision": str(row["phase2_decision"] or ""),
            "phase2_reason": str(row["phase2_reason"] or ""),
            "review_decision": "pending",
            "reviewer": "",
            "reviewed_at": "",
            "review_sources": [],
            "review_notes": "",
        }
        record["release_window_status"] = release_window_status(
            record["release_date"],
            release_cutoff=release_cutoff,
            release_as_of=release_as_of,
        )
        records.append(record)

    spotify_counts = Counter(
        record["spotify_id"]
        for record in records
        if record["spotify_identity_status"] == "exact" and record["spotify_id"]
    )
    isrc_counts = Counter(
        str(record["isrc"] or "").strip().upper()
        for record in records
        if str(record["isrc"] or "").strip()
    )
    for record in records:
        spotify_id = str(record["spotify_id"] or "")
        normalised_isrc = str(record["isrc"] or "").strip().upper()
        record["duplicate_spotify_id"] = bool(
            spotify_id and spotify_counts.get(spotify_id, 0) > 1
        )
        record["duplicate_isrc"] = bool(
            normalised_isrc and isrc_counts.get(normalised_isrc, 0) > 1
        )
        record["identity_status"] = (
            "track_and_artist_complete"
            if record["spotify_identity_status"] == "exact"
            and record["artist_identity_status"] == "complete"
            and not record["duplicate_spotify_id"]
            and not record["duplicate_isrc"]
            else "incomplete"
        )
        record["blocking_fields"] = blocking_fields(record)
        bucket, reason = classify_review_bucket(record)
        record["review_bucket"] = bucket
        record["review_reason"] = reason
        record["record_digest"] = stable_digest(
            {
                key: value
                for key, value in record.items()
                if key
                not in {
                    "review_decision",
                    "reviewer",
                    "reviewed_at",
                    "review_sources",
                    "review_notes",
                    "record_digest",
                }
            }
        )
        if bucket == "promotion_ready" and record["blocking_fields"]:
            raise FalReviewError("A blocked field entered promotion_ready")

    records.sort(
        key=lambda item: (
            BUCKET_ORDER[item["review_bucket"]],
            -int(item["streams_total"]),
            -int(item["source_count"]),
            int(item["best_rank"] or 10**9),
            item["track_uuid"],
        )
    )
    return records


def build_manifest(
    connection: sqlite3.Connection,
    phase2_report: Mapping[str, Any],
    *,
    minimum_streams: int,
    phase2_state_sha256: str = "",
    phase2_report_sha256: str = "",
) -> dict[str, Any]:
    prefilter = phase2_report.get("prefilter")
    prefilter = prefilter if isinstance(prefilter, Mapping) else {}
    release_cutoff = parse_release_day(prefilter.get("release_cutoff"))
    release_as_of = parse_release_day(prefilter.get("as_of"))
    if release_cutoff is None or release_as_of is None or release_cutoff > release_as_of:
        raise FalReviewError("Phase-2 report has an invalid release window")
    records = build_records(
        connection,
        minimum_streams=minimum_streams,
        release_cutoff=release_cutoff,
        release_as_of=release_as_of,
    )
    bucket_counts = Counter(record["review_bucket"] for record in records)
    decision_counts = Counter(record["phase2_decision"] for record in records)
    artists_by_bucket: dict[str, int] = {}
    for bucket in BUCKET_ORDER:
        artists_by_bucket[bucket] = len(
            {
                record["candidate_uuid"]
                for record in records
                if record["review_bucket"] == bucket and record["candidate_uuid"]
            }
        )
    stream_gate = phase2_report.get("stream_gate")
    stream_gate = stream_gate if isinstance(stream_gate, Mapping) else {}
    status_counts = stream_gate.get("status_counts")
    status_counts = status_counts if isinstance(status_counts, Mapping) else {}
    if "eligible" not in status_counts:
        raise FalReviewError("Phase-2 report is missing the eligible stream count")
    try:
        expected = int(status_counts["eligible"])
    except (TypeError, ValueError) as exc:
        raise FalReviewError("Phase-2 report has an invalid eligible stream count") from exc
    if expected < 0 or expected != len(records):
        raise FalReviewError(
            f"Manifest count differs from the phase-2 report ({len(records)} vs {expected})"
        )

    return {
        "version": MANIFEST_VERSION,
        "generated_at": utc_now(),
        "source": {
            "kind": "soundcharts_fal_phase2_private_staging",
            "phase2_report_generated_at": phase2_report.get("generated_at"),
            "phase2_report_version": phase2_report.get("version"),
            "phase2_source_checkpoint": phase2_report.get("source_checkpoint"),
            "phase2_state_sha256": phase2_state_sha256,
            "phase2_report_sha256": phase2_report_sha256,
        },
        "status": "human_review_required",
        "staging_only": True,
        "canonical_written": False,
        "dashboard_written": False,
        "minimum_lifetime_streams": int(minimum_streams),
        "release_window": {
            "cutoff": release_cutoff.isoformat(),
            "as_of": release_as_of.isoformat(),
            "inclusive": True,
        },
        "summary": {
            "tracks": len(records),
            "artists": len(
                {record["candidate_uuid"] for record in records if record["candidate_uuid"]}
            ),
            "by_bucket": {
                bucket: int(bucket_counts.get(bucket, 0)) for bucket in BUCKET_ORDER
            },
            "artists_by_bucket": artists_by_bucket,
            "by_phase2_decision": dict(sorted(decision_counts.items())),
            "next_operational_batch": {
                "bucket": "ai_review_required",
                "tracks": int(bucket_counts.get("ai_review_required", 0)),
                "artists": artists_by_bucket["ai_review_required"],
                "reason": "instrumental_and_genre_evidence_already_present; identity_ai_rights_and_source_approval_remain",
            },
        },
        "guardrails": {
            "stream_threshold_is_inclusive": True,
            "missing_or_ambiguous_streams_excluded": True,
            "unknown_instrumental_never_promotion_ready": True,
            "unknown_genre_never_promotion_ready": True,
            "unknown_ai_never_promotion_ready": True,
            "no_ai_risk_inference": True,
            "no_canonical_or_dashboard_write": True,
            "identity_rights_and_source_approval_required": True,
            "release_window_enforced_before_first_review_batch": True,
            "spotify_identity_format_mismatch_and_duplicates_fail_closed": True,
        },
        "records_digest": stable_digest(
            [record["record_digest"] for record in records]
        ),
        "track_schema": list(records[0].keys()) if records else [],
        "tracks": records,
    }


def write_tsv(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=TSV_FIELDS, delimiter="\t")
        writer.writeheader()
        for record in records:
            row = {field: record.get(field) for field in TSV_FIELDS}
            row["genres"] = " | ".join(record.get("genres") or [])
            row["forbidden_genres_detected"] = " | ".join(
                record.get("forbidden_genres_detected") or []
            )
            row["blocking_fields"] = " | ".join(record.get("blocking_fields") or [])
            writer.writerow(row)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--phase2-report", type=Path, required=True)
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--tsv-out", type=Path)
    parser.add_argument("--minimum-streams", type=int, default=DEFAULT_MIN_STREAMS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if int(args.minimum_streams) != DEFAULT_MIN_STREAMS:
        raise FalReviewError(
            f"FAL review floor must remain {DEFAULT_MIN_STREAMS} streams"
        )
    phase2_report = validate_phase2_report(args.phase2_report, args.minimum_streams)
    connection = open_read_only(args.state)
    try:
        manifest = build_manifest(
            connection,
            phase2_report,
            minimum_streams=args.minimum_streams,
            phase2_state_sha256=sha256_file(args.state),
            phase2_report_sha256=sha256_file(args.phase2_report),
        )
    finally:
        connection.close()
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if args.tsv_out:
        write_tsv(args.tsv_out, manifest["tracks"])
    print(json.dumps(manifest["summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
