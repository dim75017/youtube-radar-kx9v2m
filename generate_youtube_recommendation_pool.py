#!/usr/bin/env python3
"""Build a rolling recommendation reservoir from measured YouTube rows.

The curated Google Sheet remains authoritative for the original concepts and
their shared decisions. This overlay adds fresh, deterministic ideas derived
from the daily instrumental discovery corpus; it never replaces Sheet rows.

The browser only receives a bounded working set. Every generated idea is also
written once to an append-only JSONL ledger, so qualified new sources can keep
expanding the reservoir without making the public payload grow forever.
"""

from __future__ import annotations

import argparse
import bisect
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen


POOL_PREFIX = "window.LOFI_RECOMMENDATION_POOL="
GENERATOR_VERSION = 3
LEDGER_SCHEMA_VERSION = 1
BROWSER_SCHEMA_VERSION = 3
RECIPE_VERSION = 1
TITLE_RECIPE_VERSION = 2
V3_VARIANTS_PER_SOURCE = 8
LEGACY_VARIANTS_PER_SOURCE = 3
LEGACY_DEFAULT_MAX_ITEMS = 3_000
DEFAULT_BROWSER_POOL_LIMIT = 2_500
DEFAULT_RESERVE_LOW_WATER = 1_500
DEFAULT_RESERVE_HIGH_WATER = 3_500
DEFAULT_LEDGER_DIR = Path("youtube_recommendation_ledger")
JS_SAFE_INTEGER = 9_007_199_254_740_991
V3_ID_BASE = 3_000_000_000_000
V3_ID_SPAN = 4_000_000_000_000
CURRENT_SOURCE_MAX_AGE_MONTHS = 12.0
SOURCE_WINDOW_ORDER = {"0-3m": 0, "3-6m": 1, "6-12m": 2}
FEEDBACK_MARKET_WEIGHT = 18.0
SCORING_VERSION = 4
MIN_SOURCE_VIEWS = 100_000
MIN_SOURCE_VPM = 30_000
SOURCE_SCORE_FLOOR = 68
SOURCE_SCORE_SPAN = 27
SOURCE_WINDOW_RECENCY_BONUS = {"0-3m": 2, "3-6m": 1, "6-12m": 0}
PUBLISHED_WINDOW_WEIGHTS = {"0-3m": 1.0, "3-6m": 0.45, "6-12m": 0.20}


PROFILES = {
    "lofi": {
        "genre": "🎧 Lofi",
        "persona": "Lofi Girl",
        "format": "Lofi Beats",
        "style": "Lofi instrumental, texture organique, rythme doux, sans voix",
        "settings": ["Rainy Library", "Midnight Train", "Sunset Rooftop", "Quiet Bookshop", "Window Seat", "Blue Hour Bedroom", "Night Bus", "Morning Café", "Autumn Courtyard", "Snowy Apartment", "Harbour Lights", "Hidden Garden"],
    },
    "ambient": {
        "genre": "🌌 Ambient",
        "persona": "Lofi Girl",
        "format": "Ambient Soundscape",
        "style": "Ambient instrumental, nappes lentes, espace large, sans voix",
        "settings": ["Moonlit Observatory", "Deep Space Drift", "Foggy Valley", "Polar Night", "Distant Lighthouse", "Cloud Temple", "Underwater Archive", "Silent Orbit", "Mountain Shelter", "Desert at Dusk", "Frozen Lake", "Empty Museum"],
    },
    "nature": {
        "genre": "🌿 Nature",
        "persona": "Lofi Girl",
        "format": "Nature Sounds",
        "style": "Paysage sonore naturel, field recordings doux, aucune voix",
        "settings": ["Cedar Forest Rain", "Ocean at Midnight", "Cabin Thunderstorm", "Alpine Stream", "Summer Night Crickets", "Coastal Fog", "Bamboo Rain", "Distant Waterfall", "Wind in the Pines", "Lake at Dawn", "Soft Fireplace", "Winter Window"],
    },
    "jazz": {
        "genre": "🎷 Jazz",
        "persona": "Lofi Girl",
        "format": "Instrumental Jazz",
        "style": "Jazz instrumental feutré, piano, contrebasse et batterie légère",
        "settings": ["After Hours Café", "Blue Hour Lounge", "Rainy Jazz Bar", "Sunday Bookstore", "Rooftop at Midnight", "Quiet Hotel Lobby", "Paris Side Street", "Late Train Lounge", "Autumn Coffee Shop", "Vinyl Room", "Harbour Club", "Empty Theatre"],
    },
    "piano": {
        "genre": "🎹 Piano",
        "persona": "Lofi Girl",
        "format": "Solo Piano",
        "style": "Piano instrumental intime, dynamique douce, réverbération naturelle",
        "settings": ["Piano by the Window", "First Snow", "Empty Conservatory", "Dawn Practice Room", "Quiet Sunday", "Moonlit Hall", "Letters at Midnight", "Garden Piano", "Old Family House", "Winter Recital", "Rain on the Roof", "Sunrise Studio"],
    },
    "classical": {
        "genre": "🎻 Classique",
        "persona": "Lofi Girl",
        "format": "Chamber Music",
        "style": "Classique instrumental calme, ensemble de chambre, sans voix",
        "settings": ["Candlelit Chamber", "Old Library Sonata", "Winter Conservatory", "Garden Quartet", "Moonlight Study", "Quiet Palace", "Morning Prelude", "Velvet Theatre", "Autumn Nocturne", "Museum After Dark", "Riverside Adagio", "Distant Ballroom"],
    },
    "guitar": {
        "genre": "🎸 Guitare",
        "persona": "Lofi Girl",
        "format": "Fingerstyle Guitar",
        "style": "Guitare acoustique instrumentale, fingerstyle doux, sans voix",
        "settings": ["Seaside Guitar", "Campfire Morning", "Open Window Fingerstyle", "Quiet Countryside", "Summer Porch", "Mountain Cabin", "Mediterranean Dusk", "Forest Clearing", "Sunday Balcony", "Golden Hour Guitar", "Coastal Road", "Rainy Cottage"],
    },
    "house": {
        "genre": "🏠 Chill house",
        "persona": "Synthwave Boy",
        "format": "Melodic House",
        "style": "House instrumentale mélodique, groove doux, sans topline vocale",
        "settings": ["Coastal Drive", "Poolside Sunset", "Night Flight", "Island Morning", "City Lights", "Desert Road", "Ocean Terrace", "Blue Lagoon", "Rooftop Sunrise", "Summer Tram", "Harbour Drive", "Palm Shadow"],
    },
    "dnb": {
        "genre": "🥁 Drum & Bass",
        "persona": "Synthwave Boy",
        "format": "Atmospheric Drum & Bass",
        "style": "Drum & Bass instrumentale, atmosphérique, mélodique, sans voix",
        "settings": ["Neon Rain", "Night Metro", "Forest Breaks", "Orbital Station", "City After Midnight", "Liquid Horizon", "Underground Garden", "Distant Megacity", "Morning Commute", "Glass Tunnel", "Cloud Runner", "Moonlit Highway"],
    },
    "synthwave": {
        "genre": "🌆 Synthwave",
        "persona": "Synthwave Boy",
        "format": "Instrumental Synthwave",
        "style": "Synthwave instrumental, textures analogiques, sans voix",
        "settings": ["Neon Boulevard", "Midnight Arcade", "Satellite Motel", "Last Train Home", "Electric Sunset", "Rainy Megacity", "Night Highway", "Analog Dreams", "Distant Colony", "Empty Mall", "City of Glass", "Retro Spaceport"],
    },
}

ATMOSPHERES = ["Soft", "Warm", "Dreamy", "Serene", "Gentle", "Velvet", "Hazy", "Calm", "Nocturnal", "Airy", "Restful", "Mellow"]
ATMOSPHERE_FR = {
    "Soft": "douce",
    "Warm": "chaleureuse",
    "Dreamy": "onirique",
    "Serene": "sereine",
    "Gentle": "apaisante",
    "Velvet": "feutrée",
    "Hazy": "brumeuse",
    "Calm": "calme",
    "Nocturnal": "nocturne",
    "Airy": "aérée",
    "Restful": "reposante",
    "Mellow": "douce et posée",
}
PURPOSE_FR = {
    "sleep": "le sommeil",
    "study": "la concentration",
    "reading": "la lecture",
    "season": "un moment saisonnier",
    "fantasy": "l'immersion et le worldbuilding",
    "relax": "la détente",
}
TITLE_PATTERNS = {
    "sleep": (
        "{setting} · {atmosphere} {format} for Sleep",
        "{atmosphere} {setting} · Night Rest",
        "{setting} · {format} for Deep Rest",
        "{setting}, Lights Out · {atmosphere} {format}",
        "Drift Off with {setting} · {format}",
        "{setting} After Midnight · Sleep with {format}",
        "Close Your Eyes · {atmosphere} {format} with {setting}",
        "{format} for a Quiet Night · {setting}",
        "{setting} · A Long Night of {format}",
        "Sleep Through the Night · {format} at {setting}",
        "{atmosphere} Dreams · {format} with {setting}",
        "When {setting} Goes Quiet · {format} for Sleep",
    ),
    "study": (
        "{setting} · {atmosphere} {format} for Focus",
        "{atmosphere} {setting} · Study Session",
        "{setting} · Deep Focus with {format}",
        "Lock In with {setting} · {format}",
        "One More Chapter · {format} with {setting}",
        "{setting}, No Distractions · {atmosphere} {format}",
        "Deep Work Starts Here · {setting} {format}",
        "{format} for a Productive Day · {setting}",
        "Focus Until It Clicks · {setting} {format}",
        "{setting} · A Clear-Mind {format} Session",
        "Work in Silence · {atmosphere} {format} with {setting}",
        "{setting} on Repeat · {format} for Focus",
    ),
    "reading": (
        "{setting} · {atmosphere} {format} for Reading",
        "{atmosphere} {setting} · Reading Session",
        "{setting} · Quiet Pages with {format}",
        "Read Until Late · {format} with {setting}",
        "{setting}, One More Page · {atmosphere} {format}",
        "A Book and {setting} · {format}",
        "Turn the Page · {setting} {format}",
        "{format} for an Unhurried Read · {setting}",
        "Lost in a Book · {atmosphere} {format} with {setting}",
        "{setting} · Stories, Silence and {format}",
        "Read by the Window · {format} from {setting}",
        "{atmosphere} Chapters · {format} with {setting}",
    ),
    "season": (
        "{atmosphere} {setting} · {format}",
        "{setting} · Seasonal {format} Session",
        "{setting} · {atmosphere} Slow Afternoon",
        "This Season at {setting} · {format}",
        "{setting}, Changing Weather · {atmosphere} {format}",
        "A Seasonal Escape · {format} with {setting}",
        "{setting} · The Sound of the Season",
        "Stay In Today · {setting} {format}",
        "{atmosphere} Days with {setting} · {format}",
        "{setting} in Full Colour · {format}",
        "Slow Weather · {format} with {setting}",
        "{setting} · A New-Season {format} Mix",
    ),
    "fantasy": (
        "{setting} · {atmosphere} {format} Journey",
        "{atmosphere} {setting} · Worldbuilding Session",
        "{setting} · Distant Realms with {format}",
        "Enter {setting} · {atmosphere} {format}",
        "Beyond {setting} · A {format} Adventure",
        "{setting}, Another Realm · {format}",
        "The Road to {setting} · {atmosphere} {format}",
        "{format} for Imaginary Worlds · {setting}",
        "Lost Beyond {setting} · {format}",
        "{setting} · Soundtrack for a Hidden Realm",
        "Open the Map · {atmosphere} {format} with {setting}",
        "Legends of {setting} · {format}",
    ),
    "relax": (
        "{setting} · {atmosphere} {format} for Relaxation",
        "{atmosphere} {setting} · Slow Living",
        "{setting} · Calm Background {format}",
        "Take It Easy with {setting} · {format}",
        "Nothing Urgent · {atmosphere} {format} with {setting}",
        "{setting}, Let the Day Slow Down · {format}",
        "A Quiet Hour · {setting} {format}",
        "Unwind at Your Own Pace · {format} with {setting}",
        "{setting} · Leave the Noise Outside",
        "Pause Here · {atmosphere} {format} with {setting}",
        "{format} for Doing Nothing · {setting}",
        "{setting} at Ease · {format}",
    ),
}

def _stable_int(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def _normal(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _genre_profile_key(value: object) -> str | None:
    """Map a declared source genre without letting keywords override it."""
    value = _normal(value)
    if re.search(r"drum\s*&?\s*bass|drum and bass|\bdnb\b|liquid jungle", value):
        return "dnb"
    if re.search(r"chill house|lofi house|deep house|melodic house", value):
        return "house"
    if re.search(r"synthwave|retrowave|chillwave|outrun", value):
        return "synthwave"
    if re.search(r"classical|classique|baroque|orchestra|chamber", value):
        return "classical"
    if re.search(r"guitar|acoustic|fingerstyle", value):
        return "guitar"
    if re.search(r"jazz|bossa", value):
        return "jazz"
    if re.search(r"piano", value):
        return "piano"
    if re.search(r"lofi|lo-fi|chillhop|hip hop", value):
        return "lofi"
    if re.search(r"nature|soundscape|white noise", value):
        return "nature"
    if re.search(r"ambient", value):
        return "ambient"
    return None


def _profile_key(row: dict) -> str | None:
    explicit = _genre_profile_key(row.get("genre"))
    if explicit:
        return explicit

    # Fallback only when the source did not declare a usable genre. Lofi is
    # checked before weather words so a title such as "lofi rain" stays lofi.
    value = " ".join(str(row.get(key) or "") for key in ("cluster", "niche", "title", "kw")).casefold()
    if re.search(r"lofi|lo-fi|chillhop|hip hop", value):
        return "lofi"
    if re.search(r"drum\s*&?\s*bass|drum and bass|\bdnb\b|liquid jungle", value):
        return "dnb"
    if re.search(r"chill house|lofi house|deep house|melodic house", value):
        return "house"
    if re.search(r"synthwave|retrowave|chillwave|outrun", value):
        return "synthwave"
    if re.search(r"classical|classique|baroque|orchestra|chamber", value):
        return "classical"
    if re.search(r"jazz|bossa", value):
        return "jazz"
    if re.search(r"guitar|acoustic|fingerstyle", value):
        return "guitar"
    if re.search(r"piano", value):
        return "piano"
    if re.search(r"nature|rain|forest|ocean|river|thunder|fireplace|white noise", value):
        return "nature"
    if re.search(r"ambient|sleep|meditation|focus", value):
        return "ambient"
    return None


def _purpose_key(row: dict) -> str:
    declared = " ".join(str(row.get(key) or "") for key in ("cluster", "niche")).casefold()
    if re.search(r"sleep|sommeil|bedtime", declared):
        return "sleep"
    if re.search(r"read|write|book|library", declared):
        return "reading"
    if re.search(r"study|focus|work|concentr|productiv", declared):
        return "study"
    if re.search(r"season|winter|summer|autumn|fall|spring|christmas|halloween", declared):
        return "season"
    if re.search(r"fantasy|medieval|worldbuild", declared):
        return "fantasy"
    if re.search(r"relax|meditation|coffee|jazz|gaming|night drive", declared):
        return "relax"

    value = " ".join(str(row.get(key) or "") for key in ("title", "kw")).casefold()
    if re.search(r"night drive", value):
        return "relax"
    if re.search(r"sleep|insomnia|bedtime|fall asleep|deep rest", value):
        return "sleep"
    if re.search(r"read|write|book|library", value):
        return "reading"
    if re.search(r"study|focus|work|concentr|productiv", value):
        return "study"
    if re.search(r"winter|summer|autumn|fall|spring|christmas|halloween|rain|snow", value):
        return "season"
    if re.search(r"fantasy|medieval|space|world|dream|dystop", value):
        return "fantasy"
    return "relax"


def _source_age_months(row: dict) -> float | None:
    try:
        age = float(row.get("ageM"))
    except (TypeError, ValueError):
        return None
    return age if math.isfinite(age) and age >= 0 else None


def _source_window(row: dict) -> str | None:
    age = _source_age_months(row)
    if age is None or age > CURRENT_SOURCE_MAX_AGE_MONTHS:
        return None
    if age <= 3:
        return "0-3m"
    if age <= 6:
        return "3-6m"
    return "6-12m"


def _market_value(row: dict) -> float:
    views = max(0.0, float(row.get("views") or 0))
    vpm = max(0.0, float(row.get("vpm") or 0))
    return math.log10(views + 10) * 9 + math.log10(vpm + 10) * 14


def _decision_signal(value: object) -> int:
    value = str(value or "").strip()
    if re.match(r"^x(?=$|\s|[,;:\-\u00b7])", value, re.IGNORECASE):
        return 1
    if re.match(r"^-\s*(?:$|\u00b7)", value):
        return -1
    return 0


def _bounded_preference(counter: Counter) -> float:
    positive = float(counter.get(1, 0))
    negative = float(counter.get(-1, 0))
    evidence = positive + negative
    if not evidence:
        return 0.0
    # Bayesian neutral mass plus a support factor prevents a tiny unanimous
    # sample from outranking a stable preference learned across many reviews.
    value = (positive - negative) / (evidence + 8.0)
    value *= min(1.0, evidence / 12.0)
    return max(-1.0, min(1.0, value))


def _build_feedback_profile(data: dict) -> dict:
    counts = {
        "genre": defaultdict(Counter),
        "purpose": defaultdict(Counter),
        "combo": defaultdict(Counter),
    }
    for row in data.get("recos") or []:
        signal = _decision_signal(row.get("valid"))
        if not signal:
            continue
        genre_key = _profile_key(row)
        purpose_key = _purpose_key(row)
        if genre_key:
            counts["genre"][genre_key][signal] += 1
            counts["combo"][(genre_key, purpose_key)][signal] += 1
        counts["purpose"][purpose_key][signal] += 1
    return {
        dimension: {key: _bounded_preference(counter) for key, counter in values.items()}
        for dimension, values in counts.items()
    }


def _feedback_affinity(profile: dict, genre_key: str, purpose_key: str) -> float:
    genre = float(profile.get("genre", {}).get(genre_key, 0.0))
    purpose = float(profile.get("purpose", {}).get(purpose_key, 0.0))
    combo = float(profile.get("combo", {}).get((genre_key, purpose_key), 0.0))
    performance = profile.get("publishedPerformance", {})
    perf_genre = float(performance.get("genre", {}).get(genre_key, 0.0))
    perf_purpose = float(performance.get("purpose", {}).get(purpose_key, 0.0))
    perf_combo = float(performance.get("combo", {}).get((genre_key, purpose_key), 0.0))
    # Only topic and use-case participate. Persona and repeated boilerplate are
    # deliberately excluded. Published outcomes refine, but never erase, the
    # team's explicit decisions.
    decision_value = genre * 0.55 + purpose * 0.30 + combo * 0.15
    performance_value = perf_genre * 0.55 + perf_purpose * 0.30 + perf_combo * 0.15
    return max(-1.0, min(1.0, decision_value + performance_value * 0.45))


def _source_rank_value(row: dict, feedback_profile: dict) -> float:
    genre_key = _profile_key(row)
    if genre_key is None:
        return -math.inf
    purpose_key = _purpose_key(row)
    return _market_value(row) + _feedback_affinity(feedback_profile, genre_key, purpose_key) * FEEDBACK_MARKET_WEIGHT


def _format_metric(value: object) -> str:
    number = float(value or 0)
    if number >= 1_000_000:
        return f"{number / 1_000_000:.1f} M"
    if number >= 1_000:
        return f"{number / 1_000:.0f} k"
    return f"{number:.0f}"


def _source_has_explicit_vocals(row: dict) -> bool:
    """Reject only explicit human-voice evidence, not broad musical words."""
    text = _normal(" ".join(str(row.get(key) or "") for key in ("title", "genre")))
    if not text:
        return False
    # These phrases explicitly describe a voice-free version. Singing bowls
    # and birdsong are sound sources rather than lyrical human vocals.
    if re.search(r"\b(?:no|without)\s+vocals?\b|\bvocals?\s+removed\b", text):
        return False
    text = re.sub(r"\bsinging\s+bowls?\b|\bbirds?\s+singing\b|\bsinging\s+birds?\b", " ", text)
    return bool(re.search(
        r"\b(?:vocal|vocals|lyric|lyrics|singer|singing|sung|voiceover|narration|narrated)\b"
        r"|\bspoken\s+word\b|\bguided\s+meditation\b|\bwith\s+(?:female\s+|male\s+)?vocals?\b",
        text,
    ))


def _source_rows(data: dict, feedback_profile: dict) -> list[dict]:
    by_video: dict[str, dict] = {}
    for bucket in ("all", "trends", "news"):
        for row in data.get(bucket) or []:
            video_id = str(row.get("vid") or "").strip()
            views = max(0.0, float(row.get("views") or 0))
            vpm = max(0.0, float(row.get("vpm") or 0))
            if (
                not video_id
                or not row.get("title")
                or _source_has_explicit_vocals(row)
                or _profile_key(row) is None
                or _source_window(row) is None
                or views < MIN_SOURCE_VIEWS
                or vpm < MIN_SOURCE_VPM
            ):
                continue
            current = by_video.get(video_id)
            if current is None or _source_rank_value(row, feedback_profile) > _source_rank_value(current, feedback_profile):
                by_video[video_id] = row
    return sorted(
        by_video.values(),
        key=lambda row: (
            SOURCE_WINDOW_ORDER[_source_window(row)],
            -_source_rank_value(row, feedback_profile),
            str(row.get("vid") or ""),
        ),
    )


def _pick_atmosphere(setting: str, hashed: int) -> str:
    setting_tokens = set(re.findall(r"[a-z]+", _normal(setting)))
    start = (hashed // 31) % len(ATMOSPHERES)
    for offset in range(len(ATMOSPHERES)):
        candidate = ATMOSPHERES[(start + offset) % len(ATMOSPHERES)]
        if _normal(candidate) not in setting_tokens:
            return candidate
    return ATMOSPHERES[start]


def _title_pattern_index(purpose_key: str, variant: int, hashed: int) -> int:
    patterns = TITLE_PATTERNS[purpose_key]
    return (int(variant) * 5 + (hashed // 521)) % len(patterns)


def _coherent_title(profile: dict, purpose_key: str, setting: str, atmosphere: str, variant: int, hashed: int) -> str:
    pattern = TITLE_PATTERNS[purpose_key][_title_pattern_index(purpose_key, variant, hashed)]
    return pattern.format(setting=setting, atmosphere=atmosphere, format=profile["format"])

def _percentile(sorted_values: list[float], value: float) -> float:
    if len(sorted_values) <= 1:
        return 0.5
    rank = bisect.bisect_right(sorted_values, value) - 1
    raw = max(0.0, min(1.0, rank / (len(sorted_values) - 1)))
    # A tiny niche must not manufacture an elite percentile. Pull small
    # cohorts toward neutral until they contain enough comparable evidence.
    support = min(1.0, (len(sorted_values) - 1) / 19.0)
    return 0.5 + (raw - 0.5) * support


def _source_score_context(sources: list[dict]) -> dict:
    values = {
        str(source.get("vid") or ""): _market_value(source)
        for source in sources
    }
    by_genre: dict[str, list[float]] = defaultdict(list)
    for source in sources:
        genre_key = _profile_key(source)
        if genre_key is not None:
            by_genre[genre_key].append(values[str(source.get("vid") or "")])
    return {
        "values": values,
        "global": sorted(values.values()),
        "by_genre": {genre: sorted(rows) for genre, rows in by_genre.items()},
    }


def _absolute_source_strength(source: dict) -> float:
    views = max(1.0, float(source.get("views") or 0))
    vpm = max(1.0, float(source.get("vpm") or 0))
    views_strength = (math.log10(views) - math.log10(MIN_SOURCE_VIEWS)) / (
        math.log10(10_000_000) - math.log10(MIN_SOURCE_VIEWS)
    )
    velocity_strength = (math.log10(vpm) - math.log10(MIN_SOURCE_VPM)) / (
        math.log10(1_000_000) - math.log10(MIN_SOURCE_VPM)
    )
    views_strength = max(0.0, min(1.0, views_strength))
    velocity_strength = max(0.0, min(1.0, velocity_strength))
    return views_strength * 0.35 + velocity_strength * 0.65


def _source_score(source: dict, context: dict) -> tuple[int, float]:
    video_id = str(source.get("vid") or "")
    value = float(context["values"][video_id])
    global_percentile = _percentile(context["global"], value)
    genre_values = context["by_genre"].get(_profile_key(source)) or context["global"]
    genre_percentile = _percentile(genre_values, value)
    relative_strength = global_percentile * 0.70 + genre_percentile * 0.30
    # Absolute views and velocity remain authoritative. Relative rank refines
    # comparisons across the catalogue but can never turn a tiny cohort into S.
    strength = _absolute_source_strength(source) * 0.65 + relative_strength * 0.35
    recency_bonus = SOURCE_WINDOW_RECENCY_BONUS[_source_window(source)]
    score = round(SOURCE_SCORE_FLOOR + strength * SOURCE_SCORE_SPAN + recency_bonus)
    return max(SOURCE_SCORE_FLOOR, min(99, score)), strength


def _potential_for_score(score: int) -> str:
    if score >= 95:
        return "S - Rente potentielle"
    if score >= 88:
        return "A - Fort"
    if score >= 78:
        return "B - Solide"
    return "C - À tester"


def _legacy_recommendation_id(source_video_id: object, variant: int) -> int:
    legacy_hash = _stable_int(f"{source_video_id}|{variant}|1")
    return -(1_000_000_000 + legacy_hash % 1_000_000_000)


def _legacy_generate_recommendation_pool_v2(data: dict, *, max_items: int | None = None) -> list[dict]:
    feedback_profile = _build_feedback_profile(data)
    sources = _source_rows(data, feedback_profile)
    if not sources:
        return []
    target = max_items if max_items is not None else LEGACY_DEFAULT_MAX_ITEMS
    if target <= 0:
        return []
    rows: list[dict] = []
    used_titles: set[str] = set()
    used_ids: set[int] = set()
    score_context = _source_score_context(sources)
    for source in sources:
        profile_key = _profile_key(source)
        if profile_key is None:
            continue
        profile = PROFILES[profile_key]
        purpose_key = _purpose_key(source)
        source_window = _source_window(source)
        source_age = _source_age_months(source)
        if source_window is None or source_age is None:
            continue
        score, percentile = _source_score(source, score_context)
        evidence = _market_value(source)
        feedback_affinity = _feedback_affinity(feedback_profile, profile_key, purpose_key)
        for variant in range(LEGACY_VARIANTS_PER_SOURCE):
            seed = f"{source.get('vid')}|{variant}|2"
            hashed = _stable_int(seed)
            setting = profile["settings"][(hashed // 7) % len(profile["settings"])]
            atmosphere = _pick_atmosphere(setting, hashed)
            title = _coherent_title(profile, purpose_key, setting, atmosphere, variant, hashed)
            normalized = _normal(title)
            if normalized in used_titles:
                continue
            used_titles.add(normalized)
            reco_id = -(1_000_000_000 + hashed % 1_000_000_000)
            while reco_id in used_ids:
                reco_id -= 1
            used_ids.add(reco_id)
            duration = "8h" if purpose_key == "sleep" else "3h" if purpose_key in {"study", "reading"} else "2h"
            views = _format_metric(source.get("views"))
            vpm = _format_metric(source.get("vpm"))
            source_title = re.sub(r"\s+", " ", str(source.get("title") or "")).strip()
            concept = (
                f"Direction {profile['genre'].split(' ', 1)[-1]} autour de « {setting} », "
                f"conçue pour {PURPOSE_FR[purpose_key]}. L'angle vient d'un signal mesuré "
                f"dans la fenêtre {source_window} et reste à valider éditorialement avant production."
            )
            rows.append({
                "n": reco_id,
                "valid": "",
                "pot": _potential_for_score(score),
                "score": score,
                "scoreAdj": score,
                "genre": profile["genre"],
                "niche": str(source.get("cluster") or source.get("niche") or purpose_key.title()).strip(),
                "perso": profile["persona"],
                "title": title,
                "concept": concept,
                "scene": f"{setting}, ambiance {ATMOSPHERE_FR[atmosphere]}, mouvement lisible et composition claire en miniature.",
                "style": profile["style"],
                "dur": duration,
                "desc": "",
                "kw": str(source.get("kw") or "").strip(),
                "noteData": f"Signal mesuré : « {source_title} » · {views} vues · {vpm} vues/mois.",
                "launch": "Réserve évolutive",
                "conf": max(68, min(92, round(68 + percentile * 24))),
                "status": "À valider",
                "recoClaude": "Générée depuis le radar quotidien",
                "recal": "Classée avec les performances récentes et les décisions de l’équipe",
                "_generated": True,
                "_sourceVideoId": source.get("vid"),
                "_sourceMarketScore": round(evidence, 4),
                "_sourceAgeM": round(source_age, 4),
                "_sourceWindow": source_window,
                "_genreKey": profile_key,
                "_purposeKey": purpose_key,
                "_settingKey": _normal(setting),
                "_feedbackAffinity": round(feedback_affinity, 4),
                "_scoringVersion": SCORING_VERSION,
                **({"_legacyN": _legacy_recommendation_id(source.get("vid"), variant)} if variant < 2 else {}),
                "_generatorVersion": 2,
            })
            if len(rows) >= target:
                return rows
    return rows


def _legacy_write_recommendation_pool_v2(data: dict, output: Path, *, generated_ms: int | None = None, max_items: int | None = None) -> dict:
    items = _legacy_generate_recommendation_pool_v2(data, max_items=max_items)
    payload = {
        "t": int(generated_ms or time.time() * 1000),
        "sourceT": int(data.get("videoMetricsT") or 0),
        "version": 2,
        "items": items,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = POOL_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(output)
    return payload


def _title_fingerprint(value: object) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or "")).casefold()
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def _semantic_fingerprint(item: dict) -> str:
    return "|".join((
        _normal(item.get("_genreKey") or item.get("genre")),
        _normal(item.get("_purposeKey") or item.get("niche")),
        _normal(item.get("_settingKey")),
        _normal(item.get("dur")),
        _title_fingerprint(item.get("title")),
    ))


def _concept_family(item: dict) -> str:
    explicit = str(item.get("_conceptFamily") or "").strip()
    if explicit:
        return explicit
    genre_key = _normal(item.get("_genreKey") or _profile_key(item) or item.get("genre"))
    purpose_key = _normal(item.get("_purposeKey") or _purpose_key(item))
    setting_key = _normal(item.get("_settingKey"))
    if not genre_key or not purpose_key or not setting_key:
        return ""
    return "|".join((genre_key, purpose_key, setting_key))


def _canonical_setting(profile: dict, value: object) -> str:
    setting_key = _normal(value)
    for setting in profile.get("settings") or []:
        if _normal(setting) == setting_key:
            return setting
    return re.sub(r"\s+", " ", str(value or "")).strip().title()


def _title_family(profile: dict, purpose_key: str, pattern_index: int) -> str:
    pattern = TITLE_PATTERNS[purpose_key][pattern_index]
    skeleton = pattern.format(
        setting="{setting}",
        atmosphere="{atmosphere}",
        format=profile["format"],
    )
    return "|".join((purpose_key, _title_fingerprint(skeleton)))


def _rehydrate_presentation(item: dict) -> dict:
    """Overlay the current title recipe without mutating append-only ledger rows."""
    updated = dict(item)
    updated["_conceptFamily"] = _concept_family(updated)
    if not updated.get("_generated"):
        return updated
    profile_key = _profile_key(updated)
    purpose_key = _purpose_key(updated)
    setting = ""
    if profile_key in PROFILES:
        setting = _canonical_setting(PROFILES[profile_key], updated.get("_settingKey"))
    if profile_key not in PROFILES or purpose_key not in TITLE_PATTERNS or not setting:
        updated["_titleRecipeVersion"] = TITLE_RECIPE_VERSION
        updated["_titleFamily"] = "legacy|" + _title_fingerprint(updated.get("title"))
        return updated
    identity = str(updated.get("_ideaKey") or f"id:{updated.get('n')}")
    hashed = _stable_int(f"title:v{TITLE_RECIPE_VERSION}|{identity}")
    try:
        variant = int(updated.get("_recipeIndex"))
    except (TypeError, ValueError):
        variant = abs(int(updated.get("n") or hashed)) % V3_VARIANTS_PER_SOURCE
    profile = PROFILES[profile_key]
    atmosphere = _pick_atmosphere(setting, hashed)
    pattern_index = _title_pattern_index(purpose_key, variant, hashed)
    updated["title"] = _coherent_title(
        profile,
        purpose_key,
        setting,
        atmosphere,
        variant,
        hashed,
    )
    updated["_titleRecipeVersion"] = TITLE_RECIPE_VERSION
    updated["_titlePatternIndex"] = pattern_index
    updated["_titleFamily"] = _title_family(profile, purpose_key, pattern_index)
    return updated

def _idea_key(source: dict, variant: int) -> str:
    return "|".join((
        f"g{GENERATOR_VERSION}",
        f"r{RECIPE_VERSION}",
        str(source.get("vid") or ""),
        str(_profile_key(source) or ""),
        _purpose_key(source),
        str(variant),
    ))


def _v3_recommendation_id(idea_key: str) -> int:
    value = -(V3_ID_BASE + _stable_int(idea_key) % V3_ID_SPAN)
    if abs(value) > JS_SAFE_INTEGER:
        raise ValueError(f"recommendation id exceeds JavaScript safe integer: {value}")
    return value


def _build_v3_item(
    source: dict,
    variant: int,
    feedback_profile: dict,
    score_context: dict,
) -> dict | None:
    profile_key = _profile_key(source)
    source_window = _source_window(source)
    source_age = _source_age_months(source)
    if profile_key is None or source_window is None or source_age is None:
        return None
    profile = PROFILES[profile_key]
    purpose_key = _purpose_key(source)
    idea_key = _idea_key(source, variant)
    hashed = _stable_int(idea_key)
    setting = profile["settings"][(hashed // 7) % len(profile["settings"])]
    atmosphere = _pick_atmosphere(setting, hashed)
    title = _coherent_title(profile, purpose_key, setting, atmosphere, variant, hashed)
    score, strength = _source_score(source, score_context)
    evidence = _market_value(source)
    feedback_affinity = _feedback_affinity(feedback_profile, profile_key, purpose_key)
    duration = "8h" if purpose_key == "sleep" else "3h" if purpose_key in {"study", "reading"} else "2h"
    views = _format_metric(source.get("views"))
    vpm = _format_metric(source.get("vpm"))
    source_title = re.sub(r"\s+", " ", str(source.get("title") or "")).strip()
    concept = (
        f"Direction {profile['genre'].split(' ', 1)[-1]} autour de « {setting} », "
        f"conçue pour {PURPOSE_FR[purpose_key]}. L'angle vient d'un signal mesuré "
        f"dans la fenêtre {source_window} et reste à valider éditorialement avant production."
    )
    item = {
        "n": _v3_recommendation_id(idea_key),
        "valid": "",
        "pot": _potential_for_score(score),
        "score": score,
        "scoreAdj": score,
        "genre": profile["genre"],
        "niche": str(source.get("cluster") or source.get("niche") or purpose_key.title()).strip(),
        "perso": profile["persona"],
        "title": title,
        "concept": concept,
        "scene": f"{setting}, ambiance {ATMOSPHERE_FR[atmosphere]}, mouvement lisible et composition claire en miniature.",
        "style": profile["style"],
        "dur": duration,
        "desc": "",
        "kw": str(source.get("kw") or "").strip(),
        "noteData": f"Signal mesuré : « {source_title} » · {views} vues · {vpm} vues/mois.",
        "launch": "Réserve évolutive",
        "conf": max(68, min(92, round(68 + strength * 24))),
        "status": "À valider",
        "recoClaude": "Générée depuis le radar quotidien",
        "recal": "Classée avec les performances récentes et les décisions de l’équipe",
        "_generated": True,
        "_sourceVideoId": source.get("vid"),
        "_sourceMarketScore": round(evidence, 4),
        "_sourceAgeM": round(source_age, 4),
        "_sourceWindow": source_window,
        "_genreKey": profile_key,
        "_purposeKey": purpose_key,
        "_settingKey": _normal(setting),
        "_feedbackAffinity": round(feedback_affinity, 4),
        "_scoringVersion": SCORING_VERSION,
        "_ideaKey": idea_key,
        "_recipeVersion": RECIPE_VERSION,
        "_recipeIndex": variant,
        "_generatorVersion": GENERATOR_VERSION,
    }
    if variant < 2:
        item["_legacyN"] = _legacy_recommendation_id(source.get("vid"), variant)
    return _rehydrate_presentation(item)


def _v3_candidates(data: dict, feedback_profile: dict) -> list[tuple[dict, dict]]:
    sources = _source_rows(data, feedback_profile)
    if not sources:
        return []
    score_context = _source_score_context(sources)
    rows: list[tuple[dict, dict]] = []
    for source in sources:
        for variant in range(V3_VARIANTS_PER_SOURCE):
            item = _build_v3_item(source, variant, feedback_profile, score_context)
            if item is not None:
                rows.append((item, source))
    return rows


def generate_recommendation_pool(data: dict, *, max_items: int | None = None) -> list[dict]:
    """Pure deterministic V3 generation used by tests and one-shot callers."""
    target = DEFAULT_BROWSER_POOL_LIMIT if max_items is None else max(0, int(max_items))
    if target <= 0:
        return []
    feedback_profile = _build_feedback_profile(data)
    rows: list[dict] = []
    used_titles: set[str] = set()
    used_semantics: set[str] = set()
    used_ids: dict[int, str] = {}
    for item, _source in _v3_candidates(data, feedback_profile):
        title_key = _title_fingerprint(item.get("title"))
        semantic_key = _semantic_fingerprint(item)
        idea_key = str(item.get("_ideaKey") or "")
        reco_id = int(item["n"])
        if reco_id in used_ids and used_ids[reco_id] != idea_key:
            raise ValueError(f"stable recommendation id collision: {reco_id}")
        if title_key in used_titles or semantic_key in used_semantics:
            continue
        used_ids[reco_id] = idea_key
        used_titles.add(title_key)
        used_semantics.add(semantic_key)
        rows.append(item)
        if len(rows) >= target:
            break
    return rows


def _decode_json_or_assignment(raw: str) -> object:
    value = raw.strip()
    if not value:
        return {}
    if value[0] not in "[{":
        equals = value.find("=")
        if equals < 0:
            raise ValueError("unsupported JSON or JavaScript assignment")
        value = value[equals + 1:].strip()
    return json.loads(value.rstrip(";\n "))


def read_recommendation_pool(path: Path) -> dict:
    payload = _decode_json_or_assignment(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"invalid recommendation pool: {path}")
    return payload


def _feedback_rows(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("items", "decisions", "rows"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    nested = payload.get("d")
    if isinstance(nested, dict):
        return _feedback_rows(nested)
    if payload and all(isinstance(row, dict) for row in payload.values()):
        rows = []
        for key, row in payload.items():
            copied = dict(row)
            copied.setdefault("n", key)
            rows.append(copied)
        return rows
    return []


def load_feedback(reference: str | Path | None) -> dict:
    if reference is None or not str(reference).strip():
        return {"t": 0, "rows": []}
    location = str(reference).strip()
    if re.match(r"^https?://", location, re.IGNORECASE):
        request = Request(location, headers={"User-Agent": "Lofi-Radar-Recommendation-Ledger/3"})
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    else:
        raw = Path(location).read_text(encoding="utf-8")
    payload = _decode_json_or_assignment(raw)
    timestamp = 0
    if isinstance(payload, dict):
        timestamp = int(payload.get("t") or payload.get("updatedAt") or payload.get("sourceT") or 0)
    return {"t": timestamp, "rows": _feedback_rows(payload)}


def _feedback_valid(row: dict | None) -> str:
    if not row:
        return ""
    explicit = str(row.get("valid") or "").strip()
    if _decision_signal(explicit):
        return explicit
    status = _normal(row.get("status") or row.get("decision") or row.get("value"))
    if status in {"accepted", "accept", "validated", "valid", "roadmap", "published", "x"}:
        return "X"
    if status in {"refused", "rejected", "reject", "archived", "archive", "-"}:
        return "-"
    return ""


def _feedback_map(feedback: dict) -> dict[int, dict]:
    rows: dict[int, dict] = {}
    for row in feedback.get("rows") or []:
        try:
            reco_id = int(row.get("n"))
        except (TypeError, ValueError):
            continue
        current = rows.get(reco_id)
        current_t = int((current or {}).get("updatedAt") or 0)
        row_t = int(row.get("updatedAt") or row.get("t") or 0)
        if current is None or row_t >= current_t:
            rows[reco_id] = dict(row)
    return rows


def _apply_feedback(item: dict, decision: dict | None) -> dict:
    if not decision:
        return dict(item)
    updated = dict(item)
    valid = _feedback_valid(decision)
    if valid:
        updated["valid"] = valid
    edits = decision.get("edits") if isinstance(decision.get("edits"), dict) else {}
    direct_edits = {
        "title": decision.get("editedTitle"),
        "desc": decision.get("editedDesc") or decision.get("editedDescription"),
        "concept": decision.get("editedConcept"),
    }
    for key in ("title", "desc", "concept", "scene", "style", "dur", "kw"):
        value = edits.get(key, direct_edits.get(key))
        if value is not None and str(value).strip():
            updated[key] = str(value).strip()
            if key == "title":
                updated["_titleFamily"] = "edited|" + _title_fingerprint(updated[key])
    updated["_sharedFeedbackT"] = int(decision.get("updatedAt") or decision.get("t") or 0)
    return updated


def load_video_history(history_dir: Path | None) -> dict[str, list[list[float]]]:
    if history_dir is None or not history_dir.exists():
        return {}
    history: dict[str, list[list[float]]] = {}
    for shard in sorted(history_dir.glob("*.json")):
        payload = json.loads(shard.read_text(encoding="utf-8"))
        rows = payload.get("d") if isinstance(payload, dict) else None
        if not isinstance(rows, dict):
            continue
        for video_id, points in rows.items():
            if video_id in history:
                raise ValueError(f"duplicate video history for {video_id}")
            if isinstance(points, list):
                history[str(video_id)] = points
    return history


def _observed_recent_vpm(points: object) -> float | None:
    clean = []
    for point in points if isinstance(points, list) else []:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            timestamp = float(point[0])
            views = float(point[1])
        except (TypeError, ValueError):
            continue
        if math.isfinite(timestamp) and math.isfinite(views):
            clean.append((timestamp, views))
    clean.sort()
    if len(clean) < 2:
        return None
    end = clean[-1]
    cutoff = end[0] - 30.44 * 86_400_000
    candidates = [point for point in clean[:-1] if point[0] >= cutoff]
    start = candidates[0] if candidates else clean[-2]
    elapsed_days = (end[0] - start[0]) / 86_400_000
    delta = end[1] - start[1]
    if elapsed_days <= 0 or delta < 0:
        return None
    return delta / elapsed_days * 30.44


def _published_window(age_months: object) -> str | None:
    try:
        age = float(age_months)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(age) or age < 0 or age > 12:
        return None
    if age <= 3:
        return "0-3m"
    if age <= 6:
        return "3-6m"
    return "6-12m"


def _published_performance_signals(data: dict, history: dict[str, list[list[float]]]) -> dict[str, float]:
    observed = []
    for row in data.get("ours") or []:
        video_id = str(row.get("vid") or "")
        window = _published_window(row.get("ageM"))
        velocity = _observed_recent_vpm(history.get(video_id))
        if video_id and window and velocity is not None:
            observed.append((video_id, window, velocity))
    values = sorted(row[2] for row in observed)
    if len(values) < 5:
        return {}
    signals = {}
    for video_id, window, velocity in observed:
        percentile = _percentile(values, velocity)
        signals[video_id] = (percentile - 0.5) * 2 * PUBLISHED_WINDOW_WEIGHTS[window]
    return signals


def _published_performance_profile(
    data: dict,
    entries: list[dict],
    feedback: dict,
    history: dict[str, list[list[float]]],
) -> dict:
    signals = _published_performance_signals(data, history)
    if not signals:
        return {"genre": {}, "purpose": {}, "combo": {}}
    owned_counts = Counter(str(row.get("vid") or "") for row in data.get("ours") or [] if row.get("vid"))
    entries_by_id = {int(entry["n"]): entry for entry in entries}
    buckets = {"genre": defaultdict(list), "purpose": defaultdict(list), "combo": defaultdict(list)}
    for decision in feedback.get("rows") or []:
        published_video_id = str(decision.get("publishedVideoId") or "").strip()
        if not published_video_id or owned_counts[published_video_id] != 1 or published_video_id not in signals:
            continue
        try:
            entry = entries_by_id.get(int(decision.get("n")))
        except (TypeError, ValueError):
            entry = None
        if not entry:
            continue
        item = entry.get("item") or {}
        genre_key = _profile_key(item)
        purpose_key = _purpose_key(item)
        if genre_key is None:
            continue
        value = signals[published_video_id]
        buckets["genre"][genre_key].append(value)
        buckets["purpose"][purpose_key].append(value)
        buckets["combo"][(genre_key, purpose_key)].append(value)
    return {
        dimension: {key: max(-1.0, min(1.0, sum(values) / len(values))) for key, values in rows.items()}
        for dimension, rows in buckets.items()
    }


def _feedback_profile_with_ledger(
    data: dict,
    entries: list[dict],
    feedback: dict,
    history: dict[str, list[list[float]]] | None = None,
) -> dict:
    decision_map = _feedback_map(feedback)
    rows = list(data.get("recos") or [])
    for entry in entries:
        item = entry.get("item") or {}
        try:
            decision = decision_map.get(int(item.get("n")))
        except (TypeError, ValueError):
            decision = None
        if decision and _feedback_valid(decision):
            rows.append(_apply_feedback(item, decision))
    profile = _build_feedback_profile({"recos": rows})
    profile["publishedPerformance"] = _published_performance_profile(data, entries, feedback, history or {})
    return profile


def _ledger_record(item: dict, source: dict | None, *, created_ms: int, source_t: int, legacy: bool = False) -> dict:
    idea_key = str(item.get("_ideaKey") or f"legacy:v2:{item.get('n')}")
    source_ids = [str(item.get("_sourceVideoId"))] if item.get("_sourceVideoId") else []
    source_snapshot = {
        "vid": str(item.get("_sourceVideoId") or ""),
        "title": str((source or {}).get("title") or ""),
        "views": int(float((source or {}).get("views") or 0)),
        "vpm": round(float((source or {}).get("vpm") or 0), 4),
        "ageM": item.get("_sourceAgeM"),
        "window": item.get("_sourceWindow"),
    }
    return {
        "schema": LEDGER_SCHEMA_VERSION,
        "ideaKey": idea_key,
        "n": int(item["n"]),
        "createdAt": int(created_ms),
        "sourceT": int(source_t),
        "generatorVersion": int(item.get("_generatorVersion") or (2 if legacy else GENERATOR_VERSION)),
        "recipeVersion": int(item.get("_recipeVersion") or 0),
        "sourceVideoIds": source_ids,
        "sourceSnapshot": source_snapshot,
        "titleFingerprint": _title_fingerprint(item.get("title")),
        "semanticFingerprint": _semantic_fingerprint(item),
        "conceptFingerprint": _concept_family(item),
        "item": dict(item),
    }


def _ledger_shards(ledger_dir: Path) -> list[Path]:
    return sorted((ledger_dir / "shards").glob("*.jsonl")) if (ledger_dir / "shards").exists() else []


def load_recommendation_ledger(ledger_dir: Path) -> list[dict]:
    entries: list[dict] = []
    ids: dict[int, str] = {}
    keys: set[str] = set()
    for shard in _ledger_shards(ledger_dir):
        for line_number, line in enumerate(shard.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid ledger line {shard}:{line_number}") from exc
            if not isinstance(entry, dict) or not isinstance(entry.get("item"), dict):
                raise ValueError(f"invalid ledger entry {shard}:{line_number}")
            idea_key = str(entry.get("ideaKey") or "")
            reco_id = int(entry.get("n"))
            if not idea_key or reco_id != int(entry["item"].get("n")):
                raise ValueError(f"inconsistent ledger entry {shard}:{line_number}")
            if abs(reco_id) > JS_SAFE_INTEGER:
                raise ValueError(f"unsafe recommendation id {reco_id}")
            if idea_key in keys:
                raise ValueError(f"duplicate ledger idea key {idea_key}")
            if reco_id in ids and ids[reco_id] != idea_key:
                raise ValueError(f"stable recommendation id collision: {reco_id}")
            keys.add(idea_key)
            ids[reco_id] = idea_key
            entries.append(entry)
    return entries


def _append_ledger_records(ledger_dir: Path, records: list[dict], generated_ms: int) -> Path | None:
    if not records:
        return None
    month = datetime.fromtimestamp(generated_ms / 1000, timezone.utc).strftime("%Y-%m")
    shard = ledger_dir / "shards" / f"{month}.jsonl"
    shard.parent.mkdir(parents=True, exist_ok=True)
    with shard.open("a", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return shard


def _ledger_revision(shards: list[dict]) -> str:
    canonical = json.dumps(
        [{"path": row["path"], "count": row["count"], "sha256": row["sha256"]} for row in shards],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def write_ledger_manifest(ledger_dir: Path, *, generated_ms: int, source_t: int) -> dict:
    shards = []
    total = 0
    for shard in _ledger_shards(ledger_dir):
        raw = shard.read_bytes()
        count = sum(1 for line in raw.splitlines() if line.strip())
        total += count
        shards.append({
            "path": shard.relative_to(ledger_dir).as_posix(),
            "count": count,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
    manifest = {
        "schema": LEDGER_SCHEMA_VERSION,
        "generatorVersion": GENERATOR_VERSION,
        "updatedAt": int(generated_ms),
        "sourceT": int(source_t),
        "count": total,
        "shards": shards,
        "revision": _ledger_revision(shards),
    }
    ledger_dir.mkdir(parents=True, exist_ok=True)
    target = ledger_dir / "manifest.json"
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)
    return manifest


def bootstrap_legacy_pool(
    pool_path: Path,
    ledger_dir: Path,
    *,
    generated_ms: int,
    blocked_source_ids: set[str] | None = None,
) -> list[dict]:
    if load_recommendation_ledger(ledger_dir) or not pool_path.exists():
        return []
    payload = read_recommendation_pool(pool_path)
    source_t = int(payload.get("sourceT") or 0)
    created_ms = int(payload.get("t") or generated_ms)
    records = []
    for raw in payload.get("items") or []:
        if not isinstance(raw, dict) or raw.get("n") is None or not raw.get("title"):
            raise ValueError("legacy recommendation pool contains an invalid item")
        if str(raw.get("_sourceVideoId") or "") in (blocked_source_ids or set()):
            continue
        records.append(_ledger_record(dict(raw), None, created_ms=created_ms, source_t=source_t, legacy=True))
    _append_ledger_records(ledger_dir, records, generated_ms)
    return records


def _current_entry(entry: dict, current_sources: set[str]) -> bool:
    source_ids = [str(value) for value in entry.get("sourceVideoIds") or [] if value]
    return bool(source_ids and any(value in current_sources for value in source_ids))


def _selected_sources(data: dict, items: list[dict]) -> dict[str, dict]:
    wanted = {str(item.get("_sourceVideoId")) for item in items if item.get("_sourceVideoId")}
    sources: dict[str, dict] = {}
    for bucket in ("all", "trends", "news"):
        for row in data.get(bucket) or []:
            video_id = str(row.get("vid") or "")
            if video_id not in wanted or video_id in sources:
                continue
            sources[video_id] = {
                "title": str(row.get("title") or ""),
                "views": int(float(row.get("views") or 0)),
                "vpm": round(float(row.get("vpm") or 0), 4),
                "ageM": round(float(row.get("ageM") or 0), 4),
                "window": _source_window(row),
            }
    return sources


def _build_id(payload: dict) -> str:
    identity = {
        "sourceT": int(payload.get("sourceT") or 0),
        "feedbackT": int(payload.get("feedbackT") or 0),
        "ledgerRevision": str(payload.get("ledgerRevision") or ""),
        "ids": [int(row.get("n")) for row in payload.get("items") or []],
    }
    # Legacy checked-in payloads remain verifiable until the next refresh. Every
    # newly written payload includes this field, so a title recipe change always
    # invalidates browser caches even though recommendation IDs stay stable.
    if "titleRecipeVersion" in payload:
        identity["titleRecipeVersion"] = int(payload.get("titleRecipeVersion") or 0)
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]

def _write_pool_payload(payload: dict, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = POOL_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(output)


def sync_recommendation_reservoir(
    data: dict,
    output: Path,
    ledger_dir: Path,
    *,
    bootstrap_pool: Path | None = None,
    feedback: dict | None = None,
    history: dict[str, list[list[float]]] | None = None,
    generated_ms: int | None = None,
    browser_limit: int = DEFAULT_BROWSER_POOL_LIMIT,
    reserve_low_water: int = DEFAULT_RESERVE_LOW_WATER,
    reserve_high_water: int = DEFAULT_RESERVE_HIGH_WATER,
) -> dict:
    generated_ms = int(generated_ms or time.time() * 1000)
    source_t = int(data.get("videoMetricsT") or 0)
    feedback = feedback or {"t": 0, "rows": []}
    browser_limit = max(0, int(browser_limit))
    reserve_low_water = max(0, int(reserve_low_water))
    reserve_high_water = max(reserve_low_water, int(reserve_high_water))
    blocked_source_ids = {
        str(row.get("vid"))
        for bucket in ("all", "trends", "news")
        for row in data.get(bucket) or []
        if row.get("vid") and _source_has_explicit_vocals(row)
    }
    bootstrap_legacy_pool(
        bootstrap_pool or output,
        ledger_dir,
        generated_ms=generated_ms,
        blocked_source_ids=blocked_source_ids,
    )
    entries = load_recommendation_ledger(ledger_dir)
    feedback_profile = _feedback_profile_with_ledger(data, entries, feedback, history)
    current_sources_rows = _source_rows(data, feedback_profile)
    current_sources = {str(row.get("vid")) for row in current_sources_rows}
    decisions = _feedback_map(feedback)
    resolved_families = {
        str(entry.get("conceptFingerprint") or _concept_family(entry["item"]))
        for entry in entries
        if _feedback_valid(decisions.get(int(entry["n"])))
        and (entry.get("conceptFingerprint") or _concept_family(entry["item"]))
    }
    pending_entries = [
        entry for entry in entries
        if _current_entry(entry, current_sources)
        and not _feedback_valid(decisions.get(int(entry["n"])))
        and (
            not (entry.get("conceptFingerprint") or _concept_family(entry["item"]))
            or str(entry.get("conceptFingerprint") or _concept_family(entry["item"])) not in resolved_families
        )
    ]
    appended: list[dict] = []
    if len(pending_entries) < reserve_low_water:
        used_keys = {str(entry["ideaKey"]) for entry in entries}
        used_ids = {int(entry["n"]): str(entry["ideaKey"]) for entry in entries}
        used_titles = {_title_fingerprint(_rehydrate_presentation(entry["item"]).get("title")) for entry in entries}
        used_semantics = {_semantic_fingerprint(_rehydrate_presentation(entry["item"])) for entry in entries}
        for item, source in _v3_candidates(data, feedback_profile):
            idea_key = str(item["_ideaKey"])
            reco_id = int(item["n"])
            title_key = _title_fingerprint(item.get("title"))
            semantic_key = _semantic_fingerprint(item)
            concept_family = _concept_family(item)
            if concept_family and concept_family in resolved_families:
                continue
            if idea_key in used_keys:
                continue
            if reco_id in used_ids and used_ids[reco_id] != idea_key:
                raise ValueError(f"stable recommendation id collision: {reco_id}")
            if title_key in used_titles or semantic_key in used_semantics:
                continue
            record = _ledger_record(item, source, created_ms=generated_ms, source_t=source_t)
            appended.append(record)
            used_keys.add(idea_key)
            used_ids[reco_id] = idea_key
            used_titles.add(title_key)
            used_semantics.add(semantic_key)
            if len(pending_entries) + len(appended) >= reserve_high_water:
                break
        _append_ledger_records(ledger_dir, appended, generated_ms)
        if appended:
            entries.extend(appended)
            pending_entries.extend(appended)
    manifest = write_ledger_manifest(ledger_dir, generated_ms=generated_ms, source_t=source_t)
    selected: list[dict] = []
    selected_titles: set[str] = set()
    for entry in pending_entries:
        item = _apply_feedback(_rehydrate_presentation(entry["item"]), decisions.get(int(entry["n"])))
        title_key = _title_fingerprint(item.get("title"))
        if title_key in selected_titles:
            continue
        selected_titles.add(title_key)
        selected.append(item)
        if len(selected) >= browser_limit:
            break
    payload = {
        "schema": BROWSER_SCHEMA_VERSION,
        "t": generated_ms,
        "sourceT": source_t,
        "feedbackT": int(feedback.get("t") or 0),
        "version": GENERATOR_VERSION,
        "titleRecipeVersion": TITLE_RECIPE_VERSION,
        "ledgerRevision": manifest["revision"],
        "ledger": {
            "total": len(entries),
            "pending": len(pending_entries),
            "appended": len(appended),
        },
        "sources": _selected_sources(data, selected),
        "items": selected,
    }
    payload["buildId"] = _build_id(payload)
    _write_pool_payload(payload, output)
    return payload


def write_recommendation_pool(
    data: dict,
    output: Path,
    *,
    generated_ms: int | None = None,
    max_items: int | None = None,
    ledger_dir: Path | None = None,
    bootstrap_pool: Path | None = None,
    feedback: dict | None = None,
    history: dict[str, list[list[float]]] | None = None,
    reserve_low_water: int = DEFAULT_RESERVE_LOW_WATER,
    reserve_high_water: int = DEFAULT_RESERVE_HIGH_WATER,
) -> dict:
    if ledger_dir is not None:
        return sync_recommendation_reservoir(
            data,
            output,
            ledger_dir,
            bootstrap_pool=bootstrap_pool,
            feedback=feedback,
            history=history,
            generated_ms=generated_ms,
            browser_limit=DEFAULT_BROWSER_POOL_LIMIT if max_items is None else max_items,
            reserve_low_water=reserve_low_water,
            reserve_high_water=reserve_high_water,
        )
    items = generate_recommendation_pool(data, max_items=max_items)
    payload = {
        "schema": BROWSER_SCHEMA_VERSION,
        "t": int(generated_ms or time.time() * 1000),
        "sourceT": int(data.get("videoMetricsT") or 0),
        "feedbackT": 0,
        "version": GENERATOR_VERSION,
        "titleRecipeVersion": TITLE_RECIPE_VERSION,
        "ledgerRevision": "",
        "ledger": {"total": len(items), "pending": len(items), "appended": len(items)},
        "sources": _selected_sources(data, items),
        "items": items,
    }
    payload["buildId"] = _build_id(payload)
    _write_pool_payload(payload, output)
    return payload


def validate_ledger_manifest(ledger_dir: Path) -> tuple[dict, list[dict]]:
    manifest_path = ledger_dir / "manifest.json"
    if not manifest_path.exists():
        raise ValueError(f"missing recommendation ledger manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = load_recommendation_ledger(ledger_dir)
    actual_shards = []
    for shard in _ledger_shards(ledger_dir):
        raw = shard.read_bytes()
        actual_shards.append({
            "path": shard.relative_to(ledger_dir).as_posix(),
            "count": sum(1 for line in raw.splitlines() if line.strip()),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
    if manifest.get("shards") != actual_shards:
        raise ValueError("recommendation ledger manifest does not match its shards")
    if int(manifest.get("count", -1)) != len(entries):
        raise ValueError("recommendation ledger manifest count is invalid")
    if str(manifest.get("revision") or "") != _ledger_revision(actual_shards):
        raise ValueError("recommendation ledger revision is invalid")
    return manifest, entries


def validate_recommendation_reservoir(
    snapshot: Path,
    output: Path,
    ledger_dir: Path,
    *,
    browser_limit: int = DEFAULT_BROWSER_POOL_LIMIT,
) -> dict:
    data = read_snapshot(snapshot)
    payload = read_recommendation_pool(output)
    manifest, entries = validate_ledger_manifest(ledger_dir)
    if int(payload.get("schema") or 0) != BROWSER_SCHEMA_VERSION or int(payload.get("version") or 0) != GENERATOR_VERSION:
        raise ValueError("recommendation browser pool schema is invalid")
    if int(payload.get("sourceT") or 0) != int(data.get("videoMetricsT") or 0):
        raise ValueError("recommendation browser pool is stale relative to the snapshot")
    if str(payload.get("ledgerRevision") or "") != str(manifest.get("revision") or ""):
        raise ValueError("recommendation browser pool and ledger revisions differ")
    if str(payload.get("buildId") or "") != _build_id(payload):
        raise ValueError("recommendation browser pool build id is invalid")
    items = payload.get("items") or []
    if not isinstance(items, list) or len(items) > int(browser_limit):
        raise ValueError("recommendation browser pool exceeds its configured bound")
    ledger_ids = {int(entry["n"]) for entry in entries}
    ids: set[int] = set()
    titles: set[str] = set()
    for item in items:
        reco_id = int(item.get("n"))
        title = _title_fingerprint(item.get("title"))
        if abs(reco_id) > JS_SAFE_INTEGER or reco_id in ids:
            raise ValueError(f"invalid or duplicate recommendation id {reco_id}")
        if not title or title in titles:
            raise ValueError(f"invalid or duplicate recommendation title {item.get('title')}")
        if reco_id not in ledger_ids:
            raise ValueError(f"browser recommendation is absent from ledger: {reco_id}")
        if item.get("_continuousVariant"):
            raise ValueError("browser-fabricated recommendation reached the server pool")
        if int(item.get("_generatorVersion") or 0) >= GENERATOR_VERSION:
            if not item.get("_ideaKey") or not item.get("_sourceVideoId") or not item.get("noteData"):
                raise ValueError(f"V3 recommendation lacks provenance: {reco_id}")
        ids.add(reco_id)
        titles.add(title)
    return {
        "recommendations": len(items),
        "ledger": len(entries),
        "sourceT": int(payload.get("sourceT") or 0),
        "buildId": str(payload.get("buildId") or ""),
        "ledgerRevision": str(payload.get("ledgerRevision") or ""),
    }


def verify_published_reservoir(
    base_url: str,
    output: Path,
    ledger_dir: Path,
    *,
    timeout: int = 900,
    interval: int = 15,
) -> dict:
    local_pool = read_recommendation_pool(output)
    local_manifest = json.loads((ledger_dir / "manifest.json").read_text(encoding="utf-8"))
    pool_url = urljoin(base_url.rstrip("/") + "/", output.name)
    manifest_url = urljoin(base_url.rstrip("/") + "/", f"{ledger_dir.name}/manifest.json")
    deadline = time.monotonic() + max(1, int(timeout))
    last_error = ""
    while time.monotonic() <= deadline:
        nonce = int(time.time() * 1000)
        try:
            with urlopen(Request(f"{pool_url}?verify={nonce}", headers={"Cache-Control": "no-cache"}), timeout=30) as response:
                remote_pool = _decode_json_or_assignment(response.read().decode("utf-8"))
            with urlopen(Request(f"{manifest_url}?verify={nonce}", headers={"Cache-Control": "no-cache"}), timeout=30) as response:
                remote_manifest = json.loads(response.read().decode("utf-8"))
            if (
                isinstance(remote_pool, dict)
                and remote_pool.get("buildId") == local_pool.get("buildId")
                and remote_pool.get("sourceT") == local_pool.get("sourceT")
                and remote_pool.get("ledgerRevision") == local_pool.get("ledgerRevision")
                and remote_manifest.get("revision") == local_manifest.get("revision")
                and remote_manifest.get("count") == local_manifest.get("count")
            ):
                return {
                    "verified": True,
                    "buildId": local_pool.get("buildId"),
                    "ledgerRevision": local_manifest.get("revision"),
                }
            last_error = "Pages still serves a different recommendation build"
        except Exception as exc:
            last_error = str(exc)
        if time.monotonic() + interval > deadline:
            break
        time.sleep(max(1, int(interval)))
    raise TimeoutError(f"recommendation Pages verification failed: {last_error}")


def read_snapshot(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith("window.LOFI_DATA="):
        raise ValueError("unsupported YouTube snapshot")
    payload = json.loads(raw[len("window.LOFI_DATA="):].rstrip(";\n "))
    data = dict(payload.get("d") or {})
    data["videoMetricsT"] = int(payload.get("videoMetricsT") or payload.get("t") or 0)
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=Path("Lofi_Radar_data.js"))
    parser.add_argument("--output", type=Path, default=Path("Lofi_Radar_recommendation_pool.js"))
    parser.add_argument("--ledger-dir", type=Path, default=DEFAULT_LEDGER_DIR)
    parser.add_argument("--bootstrap-pool", type=Path)
    parser.add_argument("--feedback")
    parser.add_argument("--history-dir", type=Path, default=Path("video_history"))
    parser.add_argument("--browser-limit", type=int, default=DEFAULT_BROWSER_POOL_LIMIT)
    parser.add_argument("--reserve-low-water", type=int, default=DEFAULT_RESERVE_LOW_WATER)
    parser.add_argument("--reserve-high-water", type=int, default=DEFAULT_RESERVE_HIGH_WATER)
    parser.add_argument("--max-items", type=int)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--verify-base-url")
    parser.add_argument("--verify-timeout", type=int, default=900)
    parser.add_argument("--verify-interval", type=int, default=15)
    args = parser.parse_args()
    browser_limit = args.max_items if args.max_items is not None else args.browser_limit
    if not args.validate_only:
        write_recommendation_pool(
            read_snapshot(args.snapshot),
            args.output,
            max_items=browser_limit,
            ledger_dir=args.ledger_dir,
            bootstrap_pool=args.bootstrap_pool or args.output,
            feedback=load_feedback(args.feedback),
            history=load_video_history(args.history_dir),
            reserve_low_water=args.reserve_low_water,
            reserve_high_water=args.reserve_high_water,
        )
    validation = validate_recommendation_reservoir(
        args.snapshot,
        args.output,
        args.ledger_dir,
        browser_limit=browser_limit,
    )
    if args.verify_base_url:
        validation["pages"] = verify_published_reservoir(
            args.verify_base_url,
            args.output,
            args.ledger_dir,
            timeout=args.verify_timeout,
            interval=args.verify_interval,
        )
    validation["output"] = str(args.output)
    print(json.dumps(validation, ensure_ascii=False))


if __name__ == "__main__":
    main()
