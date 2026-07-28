#!/usr/bin/env python3
"""Shared Spotify release-rights reconciliation helpers.

An explicit exclusive licence is label evidence even when the copyright owner
or provider label repeats the artist name. Keeping this rule in one place
prevents the collector, snapshot sanitizer and browse catalogue from silently
disagreeing about the same release.
"""

from __future__ import annotations

import re
from typing import Any


EXCLUSIVE_LICENSE_RE = re.compile(
    r"\b(?:"
    r"under\s+(?:an?\s+)?exclusive\s+licen[cs]e\s+to|"
    r"exclusively\s+licen[cs]ed\s+to|"
    r"licen[cs]ed\s+exclusively\s+to"
    r")\s+(?P<label>.*?)(?="
    r"\s*(?:[;|]|,?\s*(?:Â)?[©℗]|,?\s*\((?:C|P)\)\s*\d{4}|$)"
    r")",
    re.IGNORECASE,
)
EXCLUSIVE_LICENSE_FROM_RE = re.compile(
    r"\bunder\s+(?:an?\s+)?exclusive\s+licen[cs]e\s+from\b",
    re.IGNORECASE,
)

MAJOR_LABEL_MARKERS = tuple(
    marker.casefold()
    for marker in (
        "Sony Music",
        "Sony Entertainment",
        "Columbia Records",
        "RCA Records",
        "Epic Records",
        "Arista Records",
        "Universal Music",
        "UMG",
        "Republic Records",
        "Interscope",
        "Geffen",
        "Capitol Records",
        "Island Records",
        "Def Jam",
        "Polydor",
        "Virgin Music",
        "EMI",
        "Warner Music",
        "Warner Records",
        "Atlantic Records",
        "Elektra",
        "Parlophone",
        "300 Entertainment",
        "BMG Rights",
    )
)


def exclusive_licensee(*values: Any) -> str:
    """Return the named exclusive licensee, or an empty string."""

    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        match = EXCLUSIVE_LICENSE_RE.search(text)
        if not match:
            continue
        label = re.sub(r"\s+", " ", match.group("label")).strip(" ,.-Â")
        if label:
            return label

    # In "Label X (under exclusive license from Artist Y)", the licensee is
    # the entity immediately before the clause, not Artist Y after "from".
    for value in values:
        text = str(value or "").strip()
        match = EXCLUSIVE_LICENSE_FROM_RE.search(text)
        if not match:
            continue
        prefix = text[: match.start()].rsplit(";", 1)[-1]
        prefix = re.sub(
            r"^(?:\u00c2)?(?:(?:\u00a9|\u2117)\s*|\(?(?:C|P)\)?\s*)?\d{4}\s*",
            "",
            prefix,
            flags=re.IGNORECASE,
        )
        label = re.sub(r"\s+", " ", prefix).strip(" ,.-(\u00c2")
        if label:
            return label
    return ""


def reconcile_rights(
    rights_status: Any,
    label: Any = None,
    copyright_text: Any = None,
    rights_confidence: Any = None,
) -> tuple[str, float | None, str]:
    """Return ``(status, confidence, licensee)`` after evidence reconciliation."""

    current = str(rights_status or "unknown").strip().casefold() or "unknown"
    try:
        confidence = float(rights_confidence) if rights_confidence not in (None, "") else None
    except (TypeError, ValueError):
        confidence = None

    licensee = exclusive_licensee(copyright_text, label)
    if not licensee:
        return current, confidence, ""

    evidence = " ".join((str(label or ""), str(copyright_text or ""), licensee)).casefold()
    status = "major" if any(marker in evidence for marker in MAJOR_LABEL_MARKERS) else "independent_label"
    return status, max(confidence or 0.0, 0.98), licensee


def reconciled_label(label: Any, copyright_text: Any = None) -> str:
    """Prefer the explicit licensee over an artist-owned provider label."""

    return exclusive_licensee(copyright_text, label) or str(label or "").strip()
