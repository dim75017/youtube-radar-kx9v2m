"""Pure, evidence-only gate for Soundcharts FAL artist metadata.

The gate deliberately does not infer instrumental status or AI risk from an
artist's genre.  It only uses the artist metadata fields returned by
Soundcharts to reject explicit hazards, prioritise target genres, or keep an
ambiguous artist in review.

Career stage is retained for audit only.  It is deliberately not a ceiling:
large artists are judged by the same explicit genre evidence as every other
candidate.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from scan_soundcharts_fal_phase1 import (
    FORBIDDEN_GENRES,
    TARGET_GENRE_MARKERS,
    VOCAL_RE,
    normalize_text,
)


ELIGIBLE = "eligible"
BLOCKED = "blocked"
REVIEW = "review"


def _artist_object(payload: Any) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        return {}
    obj = payload.get("object")
    if isinstance(obj, Mapping):
        return obj
    data = payload.get("data")
    if isinstance(data, Mapping):
        obj = data.get("object")
        if isinstance(obj, Mapping):
            return obj
        return data
    return payload


def _clean_label(value: Any) -> str:
    return " ".join(value.strip().split()) if isinstance(value, str) else ""


def _labels(value: Any) -> list[str]:
    """Read string labels without recursively consuming unrelated metadata."""

    if isinstance(value, str):
        label = _clean_label(value)
        return [label] if label else []
    if isinstance(value, Mapping):
        for key in ("name", "value", "label", "slug"):
            label = _clean_label(value.get(key))
            if label:
                return [label]
        return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        labels: list[str] = []
        for item in value:
            labels.extend(_labels(item))
        return labels
    return []


def _append_unique(target: list[str], values: Sequence[str]) -> None:
    seen = {normalize_text(value) for value in target}
    for value in values:
        key = normalize_text(value)
        if key and key not in seen:
            target.append(value)
            seen.add(key)


def _parse_genres(obj: Mapping[str, Any]) -> dict[str, list[str]]:
    roots: list[str] = []
    subs: list[str] = []
    raw_genres = obj.get("genres")

    if isinstance(raw_genres, Mapping):
        for key in ("root", "genre", "name", "value"):
            root_values = _labels(raw_genres.get(key))
            if root_values:
                _append_unique(roots, root_values)
                break
        for key in ("sub", "subs", "subGenres", "subgenres"):
            _append_unique(subs, _labels(raw_genres.get(key)))
    elif isinstance(raw_genres, Sequence) and not isinstance(
        raw_genres, (str, bytes, bytearray)
    ):
        for item in raw_genres:
            if isinstance(item, Mapping):
                for key in ("root", "genre", "name", "value"):
                    root_values = _labels(item.get(key))
                    if root_values:
                        _append_unique(roots, root_values)
                        break
                for key in ("sub", "subs", "subGenres", "subgenres"):
                    _append_unique(subs, _labels(item.get(key)))
            else:
                _append_unique(roots, _labels(item))
    else:
        _append_unique(roots, _labels(raw_genres))

    # Some Soundcharts responses expose artist subgenres beside `genres`.
    for key in ("subGenres", "subgenres", "sub_genres"):
        _append_unique(subs, _labels(obj.get(key)))

    return {"root": roots, "sub": subs}


def parse_artist_gate_response(payload: Any) -> dict[str, Any]:
    """Return the small, auditable subset used by the artist gate.

    Unknown or malformed data remains empty.  In particular, AI risk and
    instrumental status are intentionally absent from the returned evidence.
    """

    obj = _artist_object(payload)
    return {
        "name": _clean_label(obj.get("name") or obj.get("artistName")),
        "careerStage": _clean_label(obj.get("careerStage") or obj.get("career_stage")),
        "genres": _parse_genres(obj),
    }


def _genre_values(evidence: Mapping[str, Any]) -> list[str]:
    genres = evidence.get("genres")
    values: list[str] = []
    if isinstance(genres, Mapping):
        _append_unique(values, _labels(genres.get("root")))
        _append_unique(values, _labels(genres.get("sub")))
    else:
        _append_unique(values, _labels(genres))
    return [normalize_text(value) for value in values if normalize_text(value)]


def _contains_phrase(text: str, phrase: str) -> bool:
    return bool(re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", text))


def decide_artist_gate(evidence: Mapping[str, Any] | None) -> tuple[str, str]:
    """Classify explicit artist evidence without inventing missing facts."""

    evidence = evidence if isinstance(evidence, Mapping) else {}
    genres = _genre_values(evidence)
    if any(VOCAL_RE.search(genre) for genre in genres):
        return BLOCKED, "vocal_genre_evidence"

    forbidden = tuple(normalize_text(value) for value in FORBIDDEN_GENRES)
    if any(_contains_phrase(genre, marker) for genre in genres for marker in forbidden):
        return BLOCKED, "out_of_scope_genre_evidence"

    targets = tuple(normalize_text(value) for value in TARGET_GENRE_MARKERS)
    if any(marker in genre for genre in genres for marker in targets):
        return ELIGIBLE, "target_genre_evidence"

    if genres:
        return REVIEW, "genre_unclassified"
    return REVIEW, "genre_unknown"
