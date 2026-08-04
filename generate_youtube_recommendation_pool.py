#!/usr/bin/env python3
"""Build an expandable recommendation reservoir from measured YouTube rows.

The curated Google Sheet remains authoritative for the original concepts and
their shared decisions.  This overlay adds fresh, deterministic ideas derived
from the daily instrumental discovery corpus; it never replaces Sheet rows.
"""

from __future__ import annotations

import argparse
import bisect
from collections import Counter, defaultdict
import hashlib
import json
import math
import re
import time
from pathlib import Path


POOL_PREFIX = "window.LOFI_RECOMMENDATION_POOL="
GENERATOR_VERSION = 2
MAX_SOURCE_ROWS = 5_000
VARIANTS_PER_SOURCE = 3
DEFAULT_MAX_ITEMS = 3_000
CURRENT_SOURCE_MAX_AGE_MONTHS = 12.0
SOURCE_WINDOW_ORDER = {"0-3m": 0, "3-6m": 1, "6-12m": 2}
FEEDBACK_MARKET_WEIGHT = 18.0
SCORING_VERSION = 4
MIN_SOURCE_VIEWS = 100_000
MIN_SOURCE_VPM = 30_000
SOURCE_SCORE_FLOOR = 68
SOURCE_SCORE_SPAN = 27
SOURCE_WINDOW_RECENCY_BONUS = {"0-3m": 2, "3-6m": 1, "6-12m": 0}


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
    ),
    "study": (
        "{setting} · {atmosphere} {format} for Focus",
        "{atmosphere} {setting} · Study Session",
        "{setting} · Deep Focus with {format}",
    ),
    "reading": (
        "{setting} · {atmosphere} {format} for Reading",
        "{atmosphere} {setting} · Reading Session",
        "{setting} · Quiet Pages with {format}",
    ),
    "season": (
        "{atmosphere} {setting} · {format}",
        "{setting} · Seasonal {format} Session",
        "{setting} · {atmosphere} Slow Afternoon",
    ),
    "fantasy": (
        "{setting} · {atmosphere} {format} Journey",
        "{atmosphere} {setting} · Worldbuilding Session",
        "{setting} · Distant Realms with {format}",
    ),
    "relax": (
        "{setting} · {atmosphere} {format} for Relaxation",
        "{atmosphere} {setting} · Slow Living",
        "{setting} · Calm Background {format}",
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
    # Only topic and use-case participate. Persona and repeated boilerplate are
    # deliberately excluded from the generator profile.
    return max(-1.0, min(1.0, genre * 0.55 + purpose * 0.30 + combo * 0.15))


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
    )[:MAX_SOURCE_ROWS]


def _pick_atmosphere(setting: str, hashed: int) -> str:
    setting_tokens = set(re.findall(r"[a-z]+", _normal(setting)))
    start = (hashed // 31) % len(ATMOSPHERES)
    for offset in range(len(ATMOSPHERES)):
        candidate = ATMOSPHERES[(start + offset) % len(ATMOSPHERES)]
        if _normal(candidate) not in setting_tokens:
            return candidate
    return ATMOSPHERES[start]


def _coherent_title(profile: dict, purpose_key: str, setting: str, atmosphere: str, variant: int, hashed: int) -> str:
    patterns = TITLE_PATTERNS[purpose_key]
    pattern = patterns[(variant + (hashed // 521)) % len(patterns)]
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


def generate_recommendation_pool(data: dict, *, max_items: int | None = None) -> list[dict]:
    feedback_profile = _build_feedback_profile(data)
    sources = _source_rows(data, feedback_profile)
    if not sources:
        return []
    target = max_items if max_items is not None else DEFAULT_MAX_ITEMS
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
        for variant in range(VARIANTS_PER_SOURCE):
            seed = f"{source.get('vid')}|{variant}|{GENERATOR_VERSION}"
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
                "_generatorVersion": GENERATOR_VERSION,
            })
            if len(rows) >= target:
                return rows
    return rows


def write_recommendation_pool(data: dict, output: Path, *, generated_ms: int | None = None, max_items: int | None = None) -> dict:
    items = generate_recommendation_pool(data, max_items=max_items)
    payload = {
        "t": int(generated_ms or time.time() * 1000),
        "sourceT": int(data.get("videoMetricsT") or 0),
        "version": GENERATOR_VERSION,
        "items": items,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = POOL_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(output)
    return payload


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
    parser.add_argument("--max-items", type=int)
    args = parser.parse_args()
    payload = write_recommendation_pool(read_snapshot(args.snapshot), args.output, max_items=args.max_items)
    print(json.dumps({"recommendations": len(payload["items"]), "output": str(args.output), "sourceT": payload["sourceT"]}))


if __name__ == "__main__":
    main()
