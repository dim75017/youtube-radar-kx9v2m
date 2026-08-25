#!/usr/bin/env python3
"""Conservative integrity checks for cumulative Spotify stream counters.

Soundcharts can occasionally return another recording's lifetime counter for
one Spotify track, or momentarily switch an identity before switching back.
Those discontinuities must never be presented as organic 24 h / 7 d / 30 d
growth. This module keeps source-backed points, removes isolated glitches and
quarantines every unexplained counter rebase. It accepts a large acceleration
only when later observations confirm a comparably large daily velocity.
"""

from __future__ import annotations

import datetime as dt
import math
import statistics
from typing import Any, Mapping, Sequence


MIN_DISCONTINUITY_STREAMS = 1_000_000
MIN_DISCONTINUITY_RATIO = 5.0
LARGE_DISCONTINUITY_STREAMS = 50_000_000
LARGE_DISCONTINUITY_RATIO = 1.5
ISOLATED_ENDPOINT_TOLERANCE = 0.15
ISOLATED_ENDPOINT_ABSOLUTE_TOLERANCE = 250_000
ACCELERATION_CONFIRMATION_FOLLOWUPS = 2
ACCELERATION_MIN_RELATIVE_FLOW = 0.05
ACCELERATION_MIN_ABSOLUTE_FLOW = 100_000
DYNAMIC_DISCONTINUITY_STREAMS = 100_000
DYNAMIC_DISCONTINUITY_MULTIPLIER = 100.0
DYNAMIC_DISCONTINUITY_MAX_MULTIPLIER = 50.0
DYNAMIC_HISTORY_POINTS = 30
DYNAMIC_MIN_PRIOR_FLOWS = 14


def normalize_counter_history(raw: Any) -> list[list[Any]]:
    """Return one finite, non-negative cumulative point per ISO day."""

    daily: dict[str, int | float] = {}
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return []
    for point in raw:
        if not isinstance(point, Sequence) or isinstance(
            point, (str, bytes, bytearray)
        ) or len(point) < 2:
            continue
        day = str(point[0] or "")[:10]
        try:
            dt.date.fromisoformat(day)
        except ValueError:
            continue
        value = point[1]
        if isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(number) or number < 0:
            continue
        daily[day] = int(number) if number.is_integer() else number
    return [[day, daily[day]] for day in sorted(daily)]


def is_counter_discontinuity(previous: Any, current: Any) -> bool:
    """Return whether two cumulative totals are implausibly discontinuous."""

    try:
        before = float(previous)
        after = float(current)
    except (TypeError, ValueError):
        return False
    if (
        not math.isfinite(before)
        or not math.isfinite(after)
        or before <= 0
        or after < 0
        or before == after
    ):
        return False
    shift = abs(after - before)
    ratio = max(before, after) / max(1.0, min(before, after))
    return (
        shift >= MIN_DISCONTINUITY_STREAMS
        and ratio >= MIN_DISCONTINUITY_RATIO
    ) or (
        shift >= LARGE_DISCONTINUITY_STREAMS
        and ratio >= LARGE_DISCONTINUITY_RATIO
    )


def _day_gap(previous: str, current: str) -> int:
    return (dt.date.fromisoformat(current) - dt.date.fromisoformat(previous)).days


def _transition_is_discontinuity(
    points: Sequence[Sequence[Any]],
    index: int,
) -> bool:
    """Combine hard limits with the track's own recent daily velocity."""

    if not 0 < index < len(points):
        return False
    previous, current = points[index - 1], points[index]
    gap = _day_gap(str(previous[0]), str(current[0]))
    if gap not in {1, 2}:
        return False
    if is_counter_discontinuity(previous[1], current[1]):
        return True
    flow = abs(float(current[1]) - float(previous[1])) / gap
    if flow < DYNAMIC_DISCONTINUITY_STREAMS:
        return False

    prior_flows: list[float] = []
    start = max(1, index - DYNAMIC_HISTORY_POINTS)
    for cursor in range(start, index):
        before, after = points[cursor - 1], points[cursor]
        prior_gap = _day_gap(str(before[0]), str(after[0]))
        if prior_gap not in {1, 2}:
            continue
        prior_flows.append(abs(float(after[1]) - float(before[1])) / prior_gap)
    if len(prior_flows) < DYNAMIC_MIN_PRIOR_FLOWS:
        return False
    median_prior = statistics.median(prior_flows)
    return (
        flow >= median_prior * DYNAMIC_DISCONTINUITY_MULTIPLIER
        and flow >= max(prior_flows) * DYNAMIC_DISCONTINUITY_MAX_MULTIPLIER
    )


def _endpoints_agree(previous: float, current: float) -> bool:
    return abs(current - previous) <= max(
        ISOLATED_ENDPOINT_ABSOLUTE_TOLERANCE,
        max(previous, current) * ISOLATED_ENDPOINT_TOLERANCE,
    )


def sanitize_counter_history(raw: Any) -> dict[str, Any]:
    """Return a factual history that cannot turn a counter reset into growth.

    The result contains ``history``, ``status``, ``changed`` and auditable
    ``events``. A sustained acceleration is left untouched. A quiet series
    after a jump is not proof that the new lifetime counter belongs to this
    recording, so it remains quarantined until the collector records an
    explicit identity reset.
    """

    points = normalize_counter_history(raw)
    events: list[dict[str, Any]] = []

    # Remove a one-observation identity glitch bracketed by two agreeing
    # counters.  This handles high-low-high and low-high-low provider flips.
    changed = True
    while changed and len(points) >= 3:
        changed = False
        cleaned: list[list[Any]] = []
        index = 0
        while index < len(points):
            if 0 < index < len(points) - 1:
                previous, current, following = (
                    points[index - 1],
                    points[index],
                    points[index + 1],
                )
                span = _day_gap(previous[0], following[0])
                if (
                    1 <= span <= 3
                    and _transition_is_discontinuity(points, index)
                    and _transition_is_discontinuity(points, index + 1)
                    and _endpoints_agree(float(previous[1]), float(following[1]))
                ):
                    events.append(
                        {
                            "type": "isolated_glitch_removed",
                            "previous": list(previous),
                            "removed": list(current),
                            "following": list(following),
                        }
                    )
                    index += 1
                    changed = True
                    continue
            cleaned.append(points[index])
            index += 1
        points = cleaned

    index = 1
    while index < len(points):
        previous, current = points[index - 1], points[index]
        if not _transition_is_discontinuity(points, index):
            index += 1
            continue

        shift = abs(float(current[1]) - float(previous[1]))
        followup_flows: list[float] = []
        for followup_index in range(index + 1, min(len(points), index + 6)):
            before = points[followup_index - 1]
            after = points[followup_index]
            gap = _day_gap(before[0], after[0])
            if gap not in {1, 2}:
                continue
            followup_flows.append(abs(float(after[1]) - float(before[1])) / gap)

        if len(followup_flows) >= ACCELERATION_CONFIRMATION_FOLLOWUPS:
            median_followup = statistics.median(followup_flows)
            if median_followup > max(
                ACCELERATION_MIN_ABSOLUTE_FLOW,
                shift * ACCELERATION_MIN_RELATIVE_FLOW,
            ):
                # A sustained large follow-up flow is a real acceleration.
                index += 1
                continue

        # A rebase without an explicit identity reset has no factual proof.
        # Keep every new point for audit, but not for public analytics.
        events.append(
            {
                "type": "unconfirmed_discontinuity_quarantined",
                "previous": list(previous),
                "candidate": list(current),
                "quarantined_points": [list(point) for point in points[index:]],
            }
        )
        points = points[:index]
        break

    event_types = {event["type"] for event in events}
    if "unconfirmed_discontinuity_quarantined" in event_types:
        status = "spike_quarantined"
    elif "isolated_glitch_removed" in event_types:
        status = "isolated_glitch_removed"
    else:
        status = "ok"
    return {
        "history": points,
        "status": status,
        "changed": bool(events),
        "events": events,
    }


def latest_counter_point(entry: Any) -> tuple[str, int | float] | None:
    """Return the newest integrity-checked cumulative point for an entry."""

    history = entry.get("history") if isinstance(entry, Mapping) else entry
    sanitized = sanitize_counter_history(history)["history"]
    if not sanitized:
        return None
    return str(sanitized[-1][0]), sanitized[-1][1]


def latest_daily_delta(entry: Any) -> tuple[str, int | float, int | float | None]:
    """Return latest day, total and an exact D-1 delta when it exists."""

    history = entry.get("history") if isinstance(entry, Mapping) else entry
    sanitized = sanitize_counter_history(history)["history"]
    if not sanitized:
        return "", 0, None
    latest_day, latest_total = sanitized[-1]
    previous_day = (dt.date.fromisoformat(latest_day) - dt.timedelta(days=1)).isoformat()
    by_day = {day: value for day, value in sanitized}
    previous_total = by_day.get(previous_day)
    delta = latest_total - previous_total if previous_total is not None else None
    return latest_day, latest_total, delta
