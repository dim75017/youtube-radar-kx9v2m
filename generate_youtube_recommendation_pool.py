#!/usr/bin/env python3
"""Build an expandable recommendation reservoir from measured YouTube rows.

The curated Google Sheet remains authoritative for the original concepts and
their shared decisions.  This overlay adds fresh, deterministic ideas derived
from the daily instrumental discovery corpus; it never replaces Sheet rows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from pathlib import Path


POOL_PREFIX = "window.LOFI_RECOMMENDATION_POOL="
GENERATOR_VERSION = 1
MAX_SOURCE_ROWS = 5_000
VARIANTS_PER_SOURCE = 2
DEFAULT_MAX_ITEMS = 3_000


PROFILES = {
    "lofi": {
        "genre": "🎧 Lofi",
        "persona": "Lofi Girl",
        "style": "Lofi instrumental, texture organique, rythme doux, sans voix",
        "settings": ["Rainy Library", "Midnight Train", "Sunset Rooftop", "Quiet Bookshop", "Window Seat", "Blue Hour Bedroom", "Night Bus", "Morning Café", "Autumn Courtyard", "Snowy Apartment", "Harbour Lights", "Hidden Garden"],
    },
    "ambient": {
        "genre": "🌌 Ambient",
        "persona": "Lofi Girl",
        "style": "Ambient instrumental, nappes lentes, espace large, sans voix",
        "settings": ["Moonlit Observatory", "Deep Space Drift", "Foggy Valley", "Polar Night", "Distant Lighthouse", "Cloud Temple", "Underwater Archive", "Silent Orbit", "Mountain Shelter", "Desert at Dusk", "Frozen Lake", "Empty Museum"],
    },
    "nature": {
        "genre": "🌿 Nature",
        "persona": "Lofi Girl",
        "style": "Paysage sonore naturel, field recordings doux, aucune voix",
        "settings": ["Cedar Forest Rain", "Ocean at Midnight", "Cabin Thunderstorm", "Alpine Stream", "Summer Night Crickets", "Coastal Fog", "Bamboo Rain", "Distant Waterfall", "Wind in the Pines", "Lake at Dawn", "Soft Fireplace", "Winter Window"],
    },
    "jazz": {
        "genre": "🎷 Jazz",
        "persona": "Lofi Girl",
        "style": "Jazz instrumental feutré, piano, contrebasse et batterie légère",
        "settings": ["After Hours Café", "Blue Hour Lounge", "Rainy Jazz Bar", "Sunday Bookstore", "Rooftop at Midnight", "Quiet Hotel Lobby", "Paris Side Street", "Late Train Lounge", "Autumn Coffee Shop", "Vinyl Room", "Harbour Club", "Empty Theatre"],
    },
    "piano": {
        "genre": "🎹 Piano",
        "persona": "Lofi Girl",
        "style": "Piano instrumental intime, dynamique douce, réverbération naturelle",
        "settings": ["Piano by the Window", "First Snow", "Empty Conservatory", "Dawn Practice Room", "Quiet Sunday", "Moonlit Hall", "Letters at Midnight", "Garden Piano", "Old Family House", "Winter Recital", "Rain on the Roof", "Sunrise Studio"],
    },
    "classical": {
        "genre": "🎻 Classique",
        "persona": "Lofi Girl",
        "style": "Classique instrumental calme, ensemble de chambre, sans voix",
        "settings": ["Candlelit Chamber", "Old Library Sonata", "Winter Conservatory", "Garden Quartet", "Moonlight Study", "Quiet Palace", "Morning Prelude", "Velvet Theatre", "Autumn Nocturne", "Museum After Dark", "Riverside Adagio", "Distant Ballroom"],
    },
    "guitar": {
        "genre": "🎸 Guitare",
        "persona": "Lofi Girl",
        "style": "Guitare acoustique instrumentale, fingerstyle doux, sans voix",
        "settings": ["Seaside Guitar", "Campfire Morning", "Open Window Fingerstyle", "Quiet Countryside", "Summer Porch", "Mountain Cabin", "Mediterranean Dusk", "Forest Clearing", "Sunday Balcony", "Golden Hour Guitar", "Coastal Road", "Rainy Cottage"],
    },
    "house": {
        "genre": "🏠 Chill house",
        "persona": "Synthwave Boy",
        "style": "House instrumentale mélodique, groove doux, sans topline vocale",
        "settings": ["Coastal Drive", "Poolside Sunset", "Night Flight", "Island Morning", "City Lights", "Desert Road", "Ocean Terrace", "Blue Lagoon", "Rooftop Sunrise", "Summer Tram", "Harbour Drive", "Palm Shadow"],
    },
    "dnb": {
        "genre": "🥁 Drum & Bass",
        "persona": "Synthwave Boy",
        "style": "Drum & Bass instrumentale, atmosphérique, mélodique, sans voix",
        "settings": ["Neon Rain", "Night Metro", "Forest Breaks", "Orbital Station", "City After Midnight", "Liquid Horizon", "Underground Garden", "Distant Megacity", "Morning Commute", "Glass Tunnel", "Cloud Runner", "Moonlit Highway"],
    },
    "synthwave": {
        "genre": "🌆 Synthwave",
        "persona": "Synthwave Boy",
        "style": "Synthwave instrumental, textures analogiques, sans voix",
        "settings": ["Neon Boulevard", "Midnight Arcade", "Satellite Motel", "Last Train Home", "Electric Sunset", "Rainy Megacity", "Night Highway", "Analog Dreams", "Distant Colony", "Empty Mall", "City of Glass", "Retro Spaceport"],
    },
}

ATMOSPHERES = ["Soft", "Warm", "Dreamy", "Quiet", "Slow", "Deep", "Gentle", "Velvet", "Hazy", "Calm", "Distant", "Nocturnal"]
PURPOSES = {
    "sleep": ["Deep Sleep", "Night Rest", "Slow Down", "Sleep Session"],
    "study": ["Deep Focus", "Study Session", "Quiet Work", "Reading Focus"],
    "reading": ["Reading Session", "Writing Flow", "Quiet Pages", "Book Hour"],
    "season": ["Seasonal Escape", "Slow Afternoon", "Cozy Hours", "Weather Study"],
    "fantasy": ["Fantasy Focus", "Worldbuilding", "Distant Realms", "Story Session"],
    "relax": ["Slow Living", "Calm Session", "Reset & Breathe", "Peaceful Background"],
}


def _stable_int(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def _normal(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _profile_key(row: dict) -> str | None:
    value = " ".join(str(row.get(key) or "") for key in ("genre", "cluster", "title", "kw")).casefold()
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
    if re.search(r"nature|rain|forest|ocean|river|thunder|fireplace|white noise", value):
        return "nature"
    if re.search(r"lofi|lo-fi|chillhop|hip hop", value):
        return "lofi"
    if re.search(r"ambient|sleep|meditation|focus", value):
        return "ambient"
    return None


def _purpose_key(row: dict) -> str:
    value = " ".join(str(row.get(key) or "") for key in ("cluster", "title", "kw")).casefold()
    if re.search(r"sleep|night|insomnia|bedtime", value):
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


def _market_value(row: dict) -> float:
    views = max(0.0, float(row.get("views") or 0))
    vpm = max(0.0, float(row.get("vpm") or 0))
    age = row.get("ageM")
    age_bonus = 1.15 if isinstance(age, (int, float)) and age <= 3 else 1.08 if isinstance(age, (int, float)) and age <= 6 else 1.0
    return (math.log10(views + 10) * 9 + math.log10(vpm + 10) * 14) * age_bonus


def _format_metric(value: object) -> str:
    number = float(value or 0)
    if number >= 1_000_000:
        return f"{number / 1_000_000:.1f} M"
    if number >= 1_000:
        return f"{number / 1_000:.0f} k"
    return f"{number:.0f}"


def _source_rows(data: dict) -> list[dict]:
    by_video: dict[str, dict] = {}
    for bucket in ("all", "trends", "news"):
        for row in data.get(bucket) or []:
            video_id = str(row.get("vid") or "").strip()
            if not video_id or not row.get("title") or _profile_key(row) is None:
                continue
            current = by_video.get(video_id)
            if current is None or _market_value(row) > _market_value(current):
                by_video[video_id] = row
    return sorted(by_video.values(), key=_market_value, reverse=True)[:MAX_SOURCE_ROWS]


def generate_recommendation_pool(data: dict, *, max_items: int | None = None) -> list[dict]:
    sources = _source_rows(data)
    if not sources:
        return []
    target = max_items if max_items is not None else DEFAULT_MAX_ITEMS
    rows: list[dict] = []
    used_titles: set[str] = set()
    used_ids: set[int] = set()
    source_count = len(sources)
    for rank, source in enumerate(sources):
        profile_key = _profile_key(source)
        if profile_key is None:
            continue
        profile = PROFILES[profile_key]
        purpose_key = _purpose_key(source)
        purposes = PURPOSES[purpose_key]
        evidence = _market_value(source)
        percentile = 1 - rank / max(source_count - 1, 1)
        score = max(68, min(96, round(68 + percentile * 28)))
        for variant in range(VARIANTS_PER_SOURCE):
            seed = f"{source.get('vid')}|{variant}|{GENERATOR_VERSION}"
            hashed = _stable_int(seed)
            setting = profile["settings"][(hashed // 7) % len(profile["settings"])]
            atmosphere = ATMOSPHERES[(hashed // 31) % len(ATMOSPHERES)]
            purpose = purposes[(hashed // 127) % len(purposes)]
            forms = [
                f"{atmosphere} {setting} · {purpose}",
                f"{purpose} in a {atmosphere} {setting}",
                f"{setting} | {atmosphere} {purpose}",
            ]
            title = forms[(hashed // 521) % len(forms)]
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
                f"Direction {profile['genre'].split(' ', 1)[-1]} {atmosphere.casefold()} autour de « {setting} », "
                f"pensée pour {purpose.casefold()}. Concept créé depuis le corpus instrumental quotidien et à affiner avant production."
            )
            rows.append({
                "n": reco_id,
                "valid": "",
                "pot": "A - Fort" if score >= 88 else "B - Solide" if score >= 78 else "C - À tester",
                "score": score,
                "scoreAdj": score,
                "genre": profile["genre"],
                "niche": str(source.get("cluster") or purpose).strip(),
                "perso": profile["persona"],
                "title": title,
                "concept": concept,
                "scene": f"{setting}, ambiance {atmosphere.casefold()}, mouvement lent et composition lisible en miniature.",
                "style": profile["style"],
                "dur": duration,
                "desc": "",
                "kw": str(source.get("kw") or "").strip(),
                "noteData": f"Signal mesuré : « {source_title} » · {views} vues · {vpm} vues/mois.",
                "launch": "Réserve évolutive",
                "conf": max(65, min(94, round(65 + percentile * 29))),
                "status": "À valider",
                "recoClaude": "Générée depuis le radar quotidien",
                "recal": "Classée avec les performances récentes et les décisions de l’équipe",
                "_generated": True,
                "_sourceVideoId": source.get("vid"),
                "_sourceMarketScore": round(evidence, 4),
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
