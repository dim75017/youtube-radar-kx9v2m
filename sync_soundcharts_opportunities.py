#!/usr/bin/env python3
"""Build Spotify Radar's actionable A&R shortlist from measured Soundcharts tracks.

Unlike the legacy bridge, this module does not restore a fixed 30-track allow-list.
It recomputes opportunities after every licensed Soundcharts refresh from:

* target-genre classification and instrumental/AI evidence;
* exact 24h, 7d and 30d Spotify stream windows;
* acceleration versus the previous seven-day window;
* self-release / independent rights evidence;
* artist audience, superstar exclusion and contactability;
* preserved editorial-placement evidence when available.

The result intentionally separates distribution, label/advance and catalogue-
acquisition leads.  Major/mixed rights and superstars are excluded rather than
quietly ranked below independent prospects.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Mapping


SOUNDCHARTS_PREFIX = "window.SPOTIFY_SOUNDCHARTS="
PERFORMANCE_PREFIX = "window.SPOTIFY_PERFORMANCE="
RADAR_PREFIX = "window.SPOTIFY_RADAR="

TARGET_GENRES = frozenset(
    {
        "lofi_hip_hop",
        "guitar",
        "nature",
        "jazz_jazzhop",
        "classical",
        "ambient",
        "piano",
        "halloween_lofi",
        "christmas_lofi",
        "dark_ambient",
        "phonk_instrumental",
        "dnb_instrumental",
        "synthwave",
        "sleep",
        "meditation",
        "soundscape",
        "other_instrumental",
    }
)

OPPORTUNITY_SCHEMA = [
    "opportunity_status",
    "spotify_id",
    "soundcharts_uuid",
    "title",
    "credit_name",
    "artists",
    "release_date",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "rights_status",
    "label",
    "labels",
    "copyright",
    "distributor",
    "streams",
    "streams_source_date",
    "streams_observed_at",
    "streams_delta_24h",
    "delta_previous_source_date",
    "delta_previous_observed_at",
    "delta_window_hours",
    "editorial_placement_count",
    "editorial_best_position",
    "editorial_followers_total",
    "editorial_followers_known_count",
    "editorial_top_playlist",
    "editorial_first_seen_at",
    "editorial_last_seen_at",
    "roster_relationship",
    "score",
    "score_momentum",
    "score_editorial",
    "score_traction",
    "score_recency",
    "score_relationship",
    "score_confidence",
    "reason_codes",
    "reasons",
    "metadata_updated_at",
    "deal_type",
    "deal_priority",
    "artist_monthly_listeners",
    "artist_spotify_id",
    "artist_soundcharts_uuid",
    "contact_email",
    "contact_url",
    "contact_platform",
    "contact_status",
    "streams_7d",
    "streams_30d",
    "streams_previous_7d",
    "acceleration_7d",
    "growth_pct_7d",
    "velocity_per_listener",
    "release_age_days",
    "rights_confidence",
    "classification_status",
    "selection_tier",
    "source_tier",
]


class OpportunitySyncError(RuntimeError):
    """Raised when the dynamic opportunity engine cannot produce safe output."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def read_js_payload(path: Path, prefix: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise OpportunitySyncError(f"{path} does not start with {prefix[:-1]}")
    try:
        payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
    except json.JSONDecodeError as exc:
        raise OpportunitySyncError(f"{path} contains invalid JSON") from exc
    if not isinstance(payload, dict):
        raise OpportunitySyncError(f"{path} does not contain an object payload")
    return payload


def write_js_payload(path: Path, payload: dict[str, Any], prefix: str) -> None:
    path.write_text(prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def index_of(schema: list[str], name: str) -> int | None:
    try:
        return schema.index(name)
    except ValueError:
        return None


def field(row: Any, schema: list[str], name: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(name)
    index = index_of(schema, name)
    return row[index] if index is not None and isinstance(row, list) and index < len(row) else None


def finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return value
    return None


def normalize_day(value: Any) -> str | None:
    day = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(day).isoformat()
    except ValueError:
        return None


def normalize_name(value: Any) -> str:
    value = re.sub(r"[^0-9a-z]+", " ", str(value or "").casefold())
    return re.sub(r"\s+", " ", value).strip()


def normalize_history(raw: Any) -> list[list[Any]]:
    daily: dict[str, int] = {}
    if not isinstance(raw, list):
        return []
    for point in raw:
        if isinstance(point, list) and len(point) >= 2:
            raw_day, raw_value = point[0], point[1]
        elif isinstance(point, Mapping):
            raw_day, raw_value = point.get("date"), point.get("value")
        else:
            continue
        day = normalize_day(raw_day)
        value = finite_number(raw_value)
        if day and value is not None:
            daily[day] = int(value)
    return [[day, daily[day]] for day in sorted(daily)]


def exact_window(history: list[list[Any]], days: int) -> int | None:
    if not history:
        return None
    latest_day, latest_value = str(history[-1][0]), int(history[-1][1])
    by_day = {str(point[0]): int(point[1]) for point in history}
    baseline = (dt.date.fromisoformat(latest_day) - dt.timedelta(days=days)).isoformat()
    return latest_value - by_day[baseline] if baseline in by_day else None


def previous_window(history: list[list[Any]], days: int) -> int | None:
    if not history:
        return None
    latest = dt.date.fromisoformat(str(history[-1][0]))
    by_day = {str(point[0]): int(point[1]) for point in history}
    end = (latest - dt.timedelta(days=days)).isoformat()
    start = (latest - dt.timedelta(days=days * 2)).isoformat()
    return by_day[end] - by_day[start] if end in by_day and start in by_day else None


def release_age_days(value: Any) -> int | None:
    day = normalize_day(value)
    if not day:
        return None
    return max(0, (utc_today() - dt.date.fromisoformat(day)).days)


def editorial_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    editorial = payload.get("editorial") if isinstance(payload.get("editorial"), dict) else {}
    schema = editorial.get("track_schema") if isinstance(editorial.get("track_schema"), list) else []
    rows = editorial.get("tracks") if isinstance(editorial.get("tracks"), list) else []
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        uuid = str(field(row, schema, "soundcharts_uuid") or "")
        if not uuid:
            continue
        out[uuid] = {
            "soundcharts_uuid": uuid,
            "title": str(field(row, schema, "name") or ""),
            "credit_name": str(field(row, schema, "artist") or ""),
            "release_date": str(field(row, schema, "release_date") or ""),
            "primary_genre": str(field(row, schema, "primary_genre") or ""),
            "subgenres": list(field(row, schema, "subgenres") or [])
            if isinstance(field(row, schema, "subgenres"), list)
            else [],
            "genre_confidence": finite_number(field(row, schema, "genre_confidence")),
            "instrumental_status": str(field(row, schema, "instrumental_status") or "unknown").casefold(),
            "instrumental_confidence": finite_number(field(row, schema, "instrumental_confidence")),
            "ai_risk": str(field(row, schema, "ai_risk") or "unknown").casefold(),
            "ai_risk_score": finite_number(field(row, schema, "ai_risk_score")),
            "expansion_status": str(field(row, schema, "expansion_status") or "review").casefold(),
            "metadata_updated_at": str(field(row, schema, "updated_at") or ""),
        }
    return out


def row_dict(row: Any, schema: list[str]) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    return {name: row[index] if isinstance(row, list) and index < len(row) else None for index, name in enumerate(schema)}


def existing_opportunity_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    schema = payload.get("schemas", {}).get("opportunities", []) if isinstance(payload.get("schemas"), dict) else []
    rows = payload.get("opportunities") if isinstance(payload.get("opportunities"), list) else []
    return {
        str(field(row, schema, "spotify_id")): row_dict(row, schema)
        for row in rows
        if field(row, schema, "spotify_id")
    }


def legacy_contacts(payload: dict[str, Any] | None) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    by_spotify: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    if not isinstance(payload, dict):
        return by_spotify, by_name
    for row in payload.get("artists", []) if isinstance(payload.get("artists"), list) else []:
        if not isinstance(row, list) or not row:
            continue
        name = str(row[0] or "")
        spotify_id = str(row[7] or "") if len(row) > 7 else ""
        email = str(row[9] or "") if len(row) > 9 else ""
        url = str(row[10] or "") if len(row) > 10 else ""
        value = {"name": name, "spotify_id": spotify_id, "email": email, "url": url}
        if spotify_id:
            by_spotify[spotify_id] = value
        if name:
            by_name[normalize_name(name)] = value
    return by_spotify, by_name


def artist_maps(payload: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    schema = payload.get("schemas", {}).get("artists", []) if isinstance(payload.get("schemas"), dict) else []
    rows = payload.get("artists") if isinstance(payload.get("artists"), list) else []
    by_uuid: dict[str, dict[str, Any]] = {}
    by_spotify: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = row_dict(row, schema)
        uuid = str(item.get("soundcharts_uuid") or "")
        spotify_id = str(item.get("spotify_id") or "")
        name = str(item.get("name") or "")
        if uuid:
            by_uuid[uuid] = item
        if spotify_id:
            by_spotify[spotify_id] = item
        if name:
            by_name[normalize_name(name)] = item
    return by_uuid, by_spotify, by_name


def main_artists(track: dict[str, Any], preserved: dict[str, Any]) -> list[dict[str, Any]]:
    structured = track.get("artists")
    if not isinstance(structured, list) or not structured:
        structured = preserved.get("artists") if isinstance(preserved.get("artists"), list) else []
    out = [dict(item) for item in structured if isinstance(item, Mapping)]
    out.sort(key=lambda item: (0 if str(item.get("role") or "") == "main" else 1, str(item.get("name") or "")))
    return out


def resolve_artist_context(
    track: dict[str, Any],
    preserved: dict[str, Any],
    by_uuid: dict[str, dict[str, Any]],
    by_spotify: dict[str, dict[str, Any]],
    contacts_by_spotify: dict[str, dict[str, str]],
) -> dict[str, Any]:
    structured = main_artists(track, preserved)
    resolved: list[dict[str, Any]] = []
    for item in structured:
        uuid = str(item.get("soundcharts_uuid") or "")
        spotify_id = str(item.get("spotify_id") or "")
        name = str(item.get("name") or "")
        # Identity resolution must start from a structured provider ID.  A
        # display name is context only and can never join a collaborator to a
        # Soundcharts/Spotify identity.
        artist = (by_uuid.get(uuid) if uuid else None) or (by_spotify.get(spotify_id) if spotify_id else None) or {}
        artist_spotify = str(artist.get("spotify_id") or spotify_id)
        artist_uuid = str(artist.get("soundcharts_uuid") or uuid)
        artist_name = str(artist.get("name") or name)
        listeners = finite_number(artist.get("monthly_listeners"))
        contact = contacts_by_spotify.get(artist_spotify) or {}
        email = str(contact.get("email") or "")
        url = str(contact.get("url") or artist.get("contact_url") or "")
        platform = str(artist.get("contact_platform") or ("email" if email else ""))
        resolved.append(
            {
                "spotify_id": artist_spotify,
                "soundcharts_uuid": artist_uuid,
                "name": artist_name,
                "role": str(item.get("role") or "unknown"),
                "monthly_listeners": int(listeners) if listeners is not None else None,
                "email": email,
                "url": url,
                "contact_platform": platform,
            }
        )
    listeners_values = [item["monthly_listeners"] for item in resolved if item.get("monthly_listeners") is not None]
    primary = resolved[0] if resolved else {}
    email = next((item["email"] for item in resolved if item.get("email")), "")
    url = next((item["url"] for item in resolved if item.get("url")), "")
    platform = next((item["contact_platform"] for item in resolved if item.get("contact_platform")), "")
    identity_complete = bool(resolved) and all(
        str(item.get("spotify_id") or "").strip() and str(item.get("soundcharts_uuid") or "").strip()
        for item in resolved
    )
    return {
        "artists": resolved,
        "identity_complete": identity_complete,
        "monthly_listeners": max(listeners_values) if listeners_values else None,
        "primary_spotify_id": primary.get("spotify_id") or "",
        "primary_soundcharts_uuid": primary.get("soundcharts_uuid") or "",
        "contact_email": email,
        "contact_url": url,
        "contact_platform": platform,
        "contact_status": "ready" if email else ("social" if url else "enrich"),
    }


def classification_for(track: dict[str, Any], editorial: dict[str, Any], preserved: dict[str, Any]) -> dict[str, Any]:
    genre = str(track.get("primary_genre") or editorial.get("primary_genre") or preserved.get("primary_genre") or "")
    subgenres = track.get("subgenres") or editorial.get("subgenres") or preserved.get("subgenres") or []
    genre_confidence = finite_number(
        track.get("genre_confidence")
        if track.get("genre_confidence") is not None
        else editorial.get("genre_confidence")
        if editorial.get("genre_confidence") is not None
        else preserved.get("genre_confidence")
    )
    instrumental = str(
        track.get("instrumental_status")
        or editorial.get("instrumental_status")
        or preserved.get("instrumental_status")
        or "unknown"
    ).casefold()
    instrumental_confidence = finite_number(
        track.get("instrumental_confidence")
        if track.get("instrumental_confidence") is not None
        else editorial.get("instrumental_confidence")
        if editorial.get("instrumental_confidence") is not None
        else preserved.get("instrumental_confidence")
    )
    ai_risk = str(track.get("ai_risk") or editorial.get("ai_risk") or preserved.get("ai_risk") or "unknown").casefold()
    ai_score = finite_number(
        track.get("ai_risk_score")
        if track.get("ai_risk_score") is not None
        else editorial.get("ai_risk_score")
        if editorial.get("ai_risk_score") is not None
        else preserved.get("ai_risk_score")
    )
    expansion = str(track.get("expansion_status") or editorial.get("expansion_status") or "review").casefold()
    verified = (
        genre in TARGET_GENRES
        and (genre_confidence or 0) >= 0.5
        and instrumental == "instrumental"
        and (instrumental_confidence or 0) >= 0.5
        and ai_risk in {"low", "faible"}
    )
    needs_listen = (
        genre in TARGET_GENRES
        and (genre_confidence or 0) >= 0.5
        and ai_risk in {"low", "faible"}
        and expansion in {"eligible", "review"}
        and not verified
    )
    return {
        "genre": genre,
        "subgenres": list(subgenres) if isinstance(subgenres, list) else [],
        "genre_confidence": float(genre_confidence) if genre_confidence is not None else None,
        "instrumental": instrumental,
        "instrumental_confidence": float(instrumental_confidence) if instrumental_confidence is not None else None,
        "ai_risk": ai_risk,
        "ai_risk_score": ai_score,
        "expansion_status": expansion,
        "status": "verified" if verified else ("needs_listen" if needs_listen else "excluded"),
    }


def metric_snapshot(track: dict[str, Any], performance_entry: Any) -> dict[str, Any]:
    entry = performance_entry if isinstance(performance_entry, dict) else {}
    history = normalize_history(entry.get("history"))
    total = int(history[-1][1]) if history else finite_number(track.get("streams"))
    source_date = str(history[-1][0]) if history else normalize_day(track.get("source_date"))
    d1 = exact_window(history, 1)
    if d1 is None:
        candidate_delta = finite_number(track.get("delta"))
        previous = normalize_day(track.get("previous_source_date"))
        if source_date and previous == (dt.date.fromisoformat(source_date) - dt.timedelta(days=1)).isoformat():
            d1 = int(candidate_delta) if candidate_delta is not None else None
    d7 = exact_window(history, 7)
    d30 = exact_window(history, 30)
    previous7 = previous_window(history, 7)
    acceleration = d7 - previous7 if d7 is not None and previous7 is not None else None
    growth_pct = acceleration / previous7 * 100 if acceleration is not None and previous7 and previous7 > 0 else None
    return {
        "history": history,
        "total": int(total) if total is not None else None,
        "source_date": source_date,
        "observed_at": entry.get("observed_at") or track.get("observed_at"),
        "d1": d1,
        "d7": d7,
        "d30": d30,
        "previous7": previous7,
        "acceleration7": acceleration,
        "growth_pct7": growth_pct,
    }


def logarithmic_score(value: int | float | None, thresholds: list[tuple[float, int]]) -> int:
    if value is None:
        return 0
    result = 0
    for threshold, score in thresholds:
        if value >= threshold:
            result = score
    return result


def score_candidate(
    metrics: dict[str, Any],
    classification: dict[str, Any],
    rights: str,
    rights_confidence: float,
    listeners: int | None,
    age_days: int | None,
    contact_status: str,
    preserved: dict[str, Any],
) -> dict[str, Any]:
    d1 = metrics["d1"]
    d7 = metrics["d7"]
    d30 = metrics["d30"]
    acceleration = metrics["acceleration7"]
    growth_pct = metrics["growth_pct7"]
    total = metrics["total"]

    momentum = max(
        logarithmic_score(d1, [(50, 6), (250, 10), (1_000, 16), (5_000, 22), (25_000, 28), (100_000, 35)]),
        logarithmic_score(d7, [(500, 5), (2_500, 9), (10_000, 14), (50_000, 20), (250_000, 27), (1_000_000, 32)]),
    )
    if acceleration is not None and acceleration > 0:
        momentum = min(35, momentum + (3 if (growth_pct or 0) >= 25 else 1))

    playlist_count = int(finite_number(preserved.get("editorial_placement_count")) or 0)
    best_position = finite_number(preserved.get("editorial_best_position"))
    playlist_followers = finite_number(preserved.get("editorial_followers_total"))
    fit = 10 if classification["status"] == "verified" else 5
    if (classification.get("genre_confidence") or 0) >= 0.8:
        fit += 2
    if playlist_count >= 2 or (best_position is not None and best_position <= 30):
        fit += 4
    if playlist_followers is not None and playlist_followers >= 100_000:
        fit += 4
    editorial_score = min(20, fit)

    traction = logarithmic_score(
        total,
        [(10_000, 4), (50_000, 7), (250_000, 11), (1_000_000, 16), (5_000_000, 20), (25_000_000, 23)],
    )
    traction += logarithmic_score(d30, [(2_000, 1), (10_000, 2), (50_000, 3), (250_000, 4)],)
    traction = min(25, traction)

    recency = 4
    if age_days is not None:
        if age_days <= 90:
            recency = 15
        elif age_days <= 180:
            recency = 13
        elif age_days <= 365:
            recency = 10
        elif age_days <= 1_095:
            recency = 7
        else:
            recency = 4

    relationship = 5 if contact_status == "ready" else (3 if contact_status == "social" else 0)
    rights_bonus = 0
    if rights == "self_released":
        rights_bonus = 10
    elif rights == "independent_label":
        rights_bonus = 6
    elif rights == "unknown" and rights_confidence >= 0.5:
        rights_bonus = 3
    # Rights evidence is essential, but score components must keep the dashboard's
    # documented 35/20/25/15/5 shape. Fold it into editorial/traction confidence.
    editorial_score = min(20, editorial_score + min(5, rights_bonus // 2))
    traction = min(25, traction + min(4, rights_bonus // 3))

    listener_fit = 0
    if listeners is not None:
        if 5_000 <= listeners <= 1_000_000:
            listener_fit = 4
        elif 1_000 <= listeners <= 2_000_000:
            listener_fit = 2
    momentum = min(35, momentum + listener_fit)

    score = min(100, momentum + editorial_score + traction + recency + relationship)
    completeness = [
        metrics["total"] is not None,
        metrics["d1"] is not None,
        metrics["d7"] is not None,
        classification["status"] == "verified",
        rights in {"self_released", "independent_label"},
        listeners is not None,
        contact_status in {"ready", "social"},
    ]
    confidence = round(sum(completeness) / len(completeness), 3)
    return {
        "score": score,
        "momentum": momentum,
        "editorial": editorial_score,
        "traction": traction,
        "recency": recency,
        "relationship": relationship,
        "confidence": confidence,
    }


def choose_deal_type(
    rights: str,
    age_days: int | None,
    metrics: dict[str, Any],
    classification_status: str,
) -> str | None:
    d1 = metrics["d1"] or 0
    d7 = metrics["d7"] or 0
    d30 = metrics["d30"] or 0
    total = metrics["total"] or 0
    acceleration = metrics["acceleration7"] or 0
    if rights in {"major", "mixed", "other_label"}:
        return None
    if classification_status not in {"verified", "needs_listen"}:
        return None
    if d1 <= 0 and d7 <= 0 and d30 <= 0:
        return None
    if rights == "unknown":
        return "rights_review" if d1 >= 500 or d7 >= 5_000 or d30 >= 20_000 else None
    if age_days is not None and age_days <= 365 and rights == "self_released" and (d1 >= 100 or d7 >= 1_000):
        return "distribution"
    if age_days is not None and age_days <= 1_095 and rights in {"self_released", "independent_label"}:
        if total >= 100_000 and (d7 >= 2_500 or d30 >= 10_000 or acceleration > 0):
            return "label_advance"
    if rights in {"self_released", "independent_label"} and total >= 250_000 and d30 >= 5_000:
        return "catalog_acquisition"
    if rights == "self_released" and (d1 >= 50 or d7 >= 500):
        return "distribution"
    return None


def reason_pairs(
    deal_type: str,
    metrics: dict[str, Any],
    classification: dict[str, Any],
    rights: str,
    listeners: int | None,
    contact_status: str,
    age_days: int | None,
) -> tuple[list[str], list[str]]:
    pairs: list[tuple[str, str]] = []
    if metrics["d1"] is not None:
        sign = "+" if metrics["d1"] > 0 else ""
        pairs.append(("streams_24h", f"{sign}{metrics['d1']:,} streams Spotify sur 24 h.".replace(",", " ")))
    if metrics["d7"] is not None:
        pairs.append(("streams_7d", f"{metrics['d7']:,} streams sur 7 jours.".replace(",", " ")))
    if metrics["acceleration7"] is not None and metrics["acceleration7"] > 0:
        pct = f" ({metrics['growth_pct7']:+.1f} %)" if metrics["growth_pct7"] is not None else ""
        pairs.append(("acceleration_7d", f"Accélération de {metrics['acceleration7']:,} streams vs les 7 jours précédents{pct}.".replace(",", " ")))
    pairs.append((f"deal_{deal_type}", {
        "distribution": "Self-release récente adaptée à une proposition de distribution.",
        "label_advance": "Traction suffisante pour étudier une avance / offre label.",
        "catalog_acquisition": "Catalogue installé avec flux récurrent, candidat au rachat.",
        "rights_review": "Performance intéressante, droits à confirmer avant prise de contact.",
    }[deal_type]))
    pairs.append(("target_genre", f"Genre cible {classification['genre']}, confiance {round((classification.get('genre_confidence') or 0)*100)} %."))
    if classification["status"] == "verified":
        pairs.append(("instrumental_verified", "Instrumental confirmé par la classification Soundcharts."))
    else:
        pairs.append(("instrumental_needs_listen", "Caractère instrumental à valider par écoute."))
    pairs.append((f"rights_{rights}", {
        "self_released": "Droits compatibles : self-release détectée.",
        "independent_label": "Label indépendant détecté ; structure de deal à vérifier.",
        "unknown": "Propriété des droits non confirmée.",
    }.get(rights, "Droits à vérifier.")))
    if listeners is not None:
        pairs.append(("artist_audience", f"Artiste à {listeners:,} auditeurs mensuels Spotify.".replace(",", " ")))
    if age_days is not None:
        pairs.append(("release_age", f"Sortie il y a {age_days} jours."))
    if contact_status == "ready":
        pairs.append(("contact_ready", "E-mail de contact déjà disponible."))
    elif contact_status == "social":
        pairs.append(("contact_social", "Canal social / site disponible pour l'approche."))
    return [code for code, _ in pairs], [reason for _, reason in pairs]


def opportunity_row(values: dict[str, Any]) -> list[Any]:
    return [values.get(name) for name in OPPORTUNITY_SCHEMA]


def generate_opportunities(
    current: dict[str, Any],
    performance: dict[str, Any],
    legacy: dict[str, Any] | None = None,
    *,
    max_artist_listeners: int = 5_000_000,
    max_track_streams: int = 250_000_000,
    max_opportunities: int = 2_000,
    minimum_score: int = 20,
) -> dict[str, Any]:
    schemas = current.setdefault("schemas", {})
    if not isinstance(schemas, dict):
        raise OpportunitySyncError("Soundcharts schemas must be an object")
    track_schema = schemas.get("tracks") if isinstance(schemas.get("tracks"), list) else []
    tracks = current.get("tracks") if isinstance(current.get("tracks"), list) else []
    if not track_schema or not tracks:
        raise OpportunitySyncError("Current Soundcharts track export is empty")

    editorial = editorial_map(current)
    preserved_by_id = existing_opportunity_map(current)
    artist_by_uuid, artist_by_spotify, _ = artist_maps(current)
    contacts_by_spotify, _ = legacy_contacts(legacy)
    performance_tracks = performance.get("tracks") if isinstance(performance.get("tracks"), dict) else {}

    candidates: list[dict[str, Any]] = []
    excluded = {
        "major_or_mixed": 0,
        "superstar": 0,
        "classification": 0,
        "identity": 0,
        "no_metric": 0,
        "weak_signal": 0,
    }
    measured_target_tracks = 0
    independent_tracks = 0
    rights_review_tracks = 0

    for raw_row in tracks:
        track = row_dict(raw_row, track_schema)
        spotify_id = str(track.get("spotify_id") or "")
        uuid = str(track.get("soundcharts_uuid") or "")
        if not spotify_id or not uuid:
            continue
        preserved = preserved_by_id.get(spotify_id, {})
        classification = classification_for(track, editorial.get(uuid, {}), preserved)
        if classification["status"] == "excluded":
            excluded["classification"] += 1
            continue
        measured_target_tracks += 1

        rights = str(track.get("rights_status") or preserved.get("rights_status") or "unknown").casefold()
        rights_confidence = float(finite_number(track.get("rights_confidence")) or 0.25)
        if rights in {"major", "mixed", "other_label"}:
            excluded["major_or_mixed"] += 1
            continue
        independent_tracks += int(rights in {"self_released", "independent_label"})
        rights_review_tracks += int(rights == "unknown")

        metrics = metric_snapshot(track, performance_tracks.get(spotify_id))
        if metrics["total"] is None or not any(metrics[key] is not None for key in ("d1", "d7", "d30")):
            excluded["no_metric"] += 1
            continue

        context = resolve_artist_context(
            track,
            preserved,
            artist_by_uuid,
            artist_by_spotify,
            contacts_by_spotify,
        )
        if not context["identity_complete"]:
            excluded["identity"] += 1
            continue

        # A public contact is actionable only for a fully verified,
        # instrumental, low-AI-risk track with independent rights.  Review
        # rows stay useful for human listening/rights checks, but never expose
        # or score a contact channel.
        contact_allowed = (
            classification["status"] == "verified"
            and classification["instrumental"] == "instrumental"
            and classification["ai_risk"] == "low"
            and rights in {"self_released", "independent_label"}
        )
        if not contact_allowed:
            context["contact_email"] = ""
            context["contact_url"] = ""
            context["contact_platform"] = ""
            context["contact_status"] = "blocked"
        listeners = context["monthly_listeners"]
        if (listeners is not None and listeners > max_artist_listeners) or (metrics["total"] or 0) > max_track_streams:
            excluded["superstar"] += 1
            continue

        age = release_age_days(track.get("release_date") or editorial.get(uuid, {}).get("release_date"))
        deal_type = choose_deal_type(rights, age, metrics, classification["status"])
        if not deal_type:
            excluded["weak_signal"] += 1
            continue

        scores = score_candidate(
            metrics,
            classification,
            rights,
            rights_confidence,
            listeners,
            age,
            context["contact_status"],
            preserved,
        )
        if scores["score"] < minimum_score:
            excluded["weak_signal"] += 1
            continue

        reason_codes, reasons = reason_pairs(
            deal_type,
            metrics,
            classification,
            rights,
            listeners,
            context["contact_status"],
            age,
        )
        velocity_per_listener = (
            metrics["d30"] / listeners
            if metrics["d30"] is not None and listeners is not None and listeners > 0
            else None
        )
        playlist_top = preserved.get("editorial_top_playlist")
        if isinstance(playlist_top, dict):
            playlist_top = playlist_top.get("name") or playlist_top.get("spotify_id") or ""
        values = {
            "opportunity_status": classification["status"],
            "spotify_id": spotify_id,
            "soundcharts_uuid": uuid,
            "title": str(track.get("title") or editorial.get(uuid, {}).get("title") or "Titre non renseigné"),
            "credit_name": str(track.get("artist") or editorial.get(uuid, {}).get("credit_name") or "Artiste non renseigné"),
            "artists": context["artists"],
            "release_date": str(track.get("release_date") or editorial.get(uuid, {}).get("release_date") or ""),
            "primary_genre": classification["genre"],
            "subgenres": classification["subgenres"],
            "genre_confidence": classification["genre_confidence"],
            "instrumental_status": classification["instrumental"],
            "instrumental_confidence": classification["instrumental_confidence"],
            "ai_risk": classification["ai_risk"],
            "ai_risk_score": classification["ai_risk_score"],
            "rights_status": rights,
            "label": str(track.get("label") or preserved.get("label") or ""),
            "labels": preserved.get("labels") if isinstance(preserved.get("labels"), list) else [],
            "copyright": str(track.get("copyright") or preserved.get("copyright") or ""),
            "distributor": str(track.get("distributor") or preserved.get("distributor") or ""),
            "streams": metrics["total"],
            "streams_source_date": metrics["source_date"],
            "streams_observed_at": metrics["observed_at"],
            "streams_delta_24h": metrics["d1"],
            "delta_previous_source_date": (
                (dt.date.fromisoformat(metrics["source_date"]) - dt.timedelta(days=1)).isoformat()
                if metrics["source_date"] and metrics["d1"] is not None
                else None
            ),
            "delta_previous_observed_at": None,
            "delta_window_hours": 24 if metrics["d1"] is not None else None,
            "editorial_placement_count": int(finite_number(preserved.get("editorial_placement_count")) or 0),
            "editorial_best_position": finite_number(preserved.get("editorial_best_position")),
            "editorial_followers_total": finite_number(preserved.get("editorial_followers_total")),
            "editorial_followers_known_count": int(finite_number(preserved.get("editorial_followers_known_count")) or 0),
            "editorial_top_playlist": str(playlist_top or ""),
            "editorial_first_seen_at": preserved.get("editorial_first_seen_at"),
            "editorial_last_seen_at": preserved.get("editorial_last_seen_at"),
            "roster_relationship": preserved.get("roster_relationship") or {"status": "unknown", "artists": []},
            "score": scores["score"],
            "score_momentum": scores["momentum"],
            "score_editorial": scores["editorial"],
            "score_traction": scores["traction"],
            "score_recency": scores["recency"],
            "score_relationship": scores["relationship"],
            "score_confidence": scores["confidence"],
            "reason_codes": reason_codes,
            "reasons": reasons,
            "metadata_updated_at": track.get("metadata_updated_at") or editorial.get(uuid, {}).get("metadata_updated_at"),
            "deal_type": deal_type,
            "deal_priority": scores["score"],
            "artist_monthly_listeners": listeners,
            "artist_spotify_id": context["primary_spotify_id"],
            "artist_soundcharts_uuid": context["primary_soundcharts_uuid"],
            "contact_email": context["contact_email"],
            "contact_url": context["contact_url"],
            "contact_platform": context["contact_platform"],
            "contact_status": context["contact_status"],
            "streams_7d": metrics["d7"],
            "streams_30d": metrics["d30"],
            "streams_previous_7d": metrics["previous7"],
            "acceleration_7d": metrics["acceleration7"],
            "growth_pct_7d": round(metrics["growth_pct7"], 3) if metrics["growth_pct7"] is not None else None,
            "velocity_per_listener": round(velocity_per_listener, 6) if velocity_per_listener is not None else None,
            "release_age_days": age,
            "rights_confidence": rights_confidence,
            "classification_status": classification["status"],
            "selection_tier": "priority" if scores["score"] >= 60 else ("watch" if scores["score"] >= 40 else "review"),
            "source_tier": str(track.get("source_tier") or "soundcharts_measured"),
        }
        candidates.append(values)

    # The same Spotify recording may be exposed through more than one Soundcharts
    # alias/credit. Keep exactly one commercial lead per Spotify track ID. Prefer
    # the strongest score, then the richest identity/contact evidence.
    deduplicated: dict[str, dict[str, Any]] = {}
    for item in candidates:
        key = str(item["spotify_id"])
        previous = deduplicated.get(key)
        quality = (
            int(item["score"]),
            1 if item.get("contact_status") == "ready" else 0,
            1 if item.get("artist_soundcharts_uuid") else 0,
            int(item["streams_delta_24h"]) if item.get("streams_delta_24h") is not None else -10**18,
        )
        previous_quality = (
            int(previous["score"]),
            1 if previous.get("contact_status") == "ready" else 0,
            1 if previous.get("artist_soundcharts_uuid") else 0,
            int(previous["streams_delta_24h"]) if previous.get("streams_delta_24h") is not None else -10**18,
        ) if previous else None
        if previous is None or quality > previous_quality:
            deduplicated[key] = item
    candidates = list(deduplicated.values())

    deal_order = {"distribution": 0, "label_advance": 1, "catalog_acquisition": 2, "rights_review": 3}
    candidates.sort(
        key=lambda item: (
            -int(item["score"]),
            deal_order.get(str(item["deal_type"]), 9),
            -(int(item["streams_delta_24h"]) if item["streams_delta_24h"] is not None else -10**18),
            str(item["title"]),
        )
    )
    selected = candidates[: max(1, max_opportunities)]
    if not selected:
        raise OpportunitySyncError("No actionable independent opportunity survived the configured gates")

    schemas["opportunities"] = list(OPPORTUNITY_SCHEMA)
    current["opportunities"] = [opportunity_row(item) for item in selected]
    now = utc_now()
    deal_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    contact_counts: dict[str, int] = {}
    for item in selected:
        deal_counts[item["deal_type"]] = deal_counts.get(item["deal_type"], 0) + 1
        status_counts[item["opportunity_status"]] = status_counts.get(item["opportunity_status"], 0) + 1
        contact_counts[item["contact_status"]] = contact_counts.get(item["contact_status"], 0) + 1

    pool_summary = current.get("instrumental_pool") if isinstance(current.get("instrumental_pool"), dict) else {}
    discography = current.get("coverage", {}).get("discography", {}) if isinstance(current.get("coverage"), dict) else {}
    scoring = {
        "version": "2026-07-dynamic-ar-v1",
        "generated_at": now,
        "catalog_total": int(discography.get("total") or pool_summary.get("catalog_total") or 0) if isinstance(discography, dict) else 0,
        "measured_target_tracks": measured_target_tracks,
        "independent_tracks": independent_tracks,
        "rights_review_tracks": rights_review_tracks,
        "candidates_before_limit": len(candidates),
        "opportunities": len(selected),
        "deal_types": deal_counts,
        "classification": status_counts,
        "contacts": contact_counts,
        "excluded": excluded,
        "thresholds": {
            "max_artist_monthly_listeners": max_artist_listeners,
            "max_track_streams": max_track_streams,
            "minimum_score": minimum_score,
            "allowed_rights": ["self_released", "independent_label", "unknown_review"],
            "excluded_rights": ["major", "mixed", "other_label"],
        },
        "score_components": {
            "momentum_and_acceleration": 35,
            "genre_editorial_and_rights_fit": 20,
            "traction": 25,
            "recency_or_catalog_stability": 15,
            "contactability": 5,
        },
        "no_extrapolation": True,
    }
    current["opportunity_scoring"] = scoring
    current["opportunity_sync"] = {
        "status": "success",
        "finished_at": now,
        "mode": "dynamic_full_measured_pool",
        "opportunities": len(selected),
        "deal_types": deal_counts,
        "latest_source_date": max((str(item["streams_source_date"] or "") for item in selected), default=""),
        "metric_source": "Spotify_Performance_data.js + Soundcharts instrumental pool",
    }
    freshness = current.setdefault("freshness", {})
    if isinstance(freshness, dict):
        freshness["opportunities_at"] = now
    return current["opportunity_sync"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soundcharts", type=Path, default=Path("Spotify_Soundcharts_data.js"))
    parser.add_argument("--performance", type=Path, default=Path("Spotify_Performance_data.js"))
    parser.add_argument("--radar", type=Path, default=Path("Spotify_Radar_data.js"))
    parser.add_argument("--max-artist-listeners", type=int, default=5_000_000)
    parser.add_argument("--max-track-streams", type=int, default=250_000_000)
    parser.add_argument("--max-opportunities", type=int, default=2_000)
    parser.add_argument("--minimum-score", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    current = read_js_payload(args.soundcharts, SOUNDCHARTS_PREFIX)
    performance = read_js_payload(args.performance, PERFORMANCE_PREFIX)
    legacy = read_js_payload(args.radar, RADAR_PREFIX) if args.radar.exists() else None
    summary = generate_opportunities(
        current,
        performance,
        legacy,
        max_artist_listeners=args.max_artist_listeners,
        max_track_streams=args.max_track_streams,
        max_opportunities=args.max_opportunities,
        minimum_score=args.minimum_score,
    )
    write_js_payload(args.soundcharts, current, SOUNDCHARTS_PREFIX)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
