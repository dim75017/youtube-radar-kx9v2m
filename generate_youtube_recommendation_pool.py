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
GENERATOR_VERSION = 4
LEDGER_SCHEMA_VERSION = 1
BROWSER_SCHEMA_VERSION = 3
RECIPE_VERSION = 2
TITLE_RECIPE_VERSION = 3
CURRENT_VARIANTS_PER_SOURCE = 1
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
SOURCE_WINDOW_ORDER = {"0-3m": 0, "3-6m": 1, "6-12m": 2, "12m+": 3}
FEEDBACK_MARKET_WEIGHT = 18.0
SCORING_VERSION = 5
MIN_SOURCE_VIEWS = 100_000
MIN_SOURCE_VPM = 30_000
SOURCE_SCORE_FLOOR = 68
SOURCE_SCORE_SPAN = 27
SOURCE_FRESHNESS_RANK_WEIGHT = 45.0
PUBLISHED_WINDOW_WEIGHTS = {"0-3m": 1.0, "3-6m": 0.55, "6-12m": 0.28, "12m+": 0.10}


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

# V4 learns which of these broad structures work for each genre. They are
# renderers, not creative premises: the hook always comes from measured market
# evidence, and no renderer invents a place.
TITLE_STYLE_KEYS = ("signature", "use_case", "duration", "pov", "pipe", "series", "direct")
TITLE_GENRE_LABELS = {
    "lofi": ("lofi hip hop", "🎧"),
    "ambient": ("ambient", "🌌"),
    "nature": ("nature sounds", "🌿"),
    "jazz": ("jazz lofi", "🎷"),
    "piano": ("calm piano", "🎹"),
    "classical": ("classical music", "🎻"),
    "guitar": ("acoustic guitar", "🎸"),
    "house": ("chill house", "🏠"),
    "dnb": ("drum & bass", "🥁"),
    "synthwave": ("synthwave", "🌆"),
}
TITLE_PURPOSE_CLAUSES = {
    "lofi": {
        "sleep": "relaxing beats to sleep to",
        "study": "beats to relax/study to",
        "reading": "beats for reading",
        "season": "seasonal beats to chill to",
        "fantasy": "beats for imaginary worlds",
        "relax": "chill beats to relax to",
    },
    "ambient": {
        "sleep": "ambient music for deep sleep", "study": "ambient music for focus",
        "reading": "ambient music for reading", "season": "seasonal ambient mix",
        "fantasy": "ambient music for imaginary worlds", "relax": "ambient music to unwind",
    },
    "nature": {
        "sleep": "cozy ambience to sleep/chill to", "study": "nature sounds for focus",
        "reading": "nature sounds for reading", "season": "cozy nature ambience",
        "fantasy": "nature ambience for imaginary worlds", "relax": "nature ambience to unwind",
    },
    "jazz": {
        "sleep": "soft jazz for late nights", "study": "jazz to work/study to",
        "reading": "jazz for reading", "season": "seasonal jazz mix",
        "fantasy": "jazz for imaginary worlds", "relax": "jazz to relax to",
    },
    "piano": {
        "sleep": "soft piano for deep sleep", "study": "piano music for focus",
        "reading": "piano music for reading", "season": "relaxing piano music",
        "fantasy": "piano for imaginary worlds", "relax": "relaxing piano music",
    },
    "classical": {
        "sleep": "calm strings for deep sleep", "study": "classical music for focus",
        "reading": "classical music for reading", "season": "seasonal classical music",
        "fantasy": "classical music for imaginary worlds", "relax": "classical music to relax to",
    },
    "guitar": {
        "sleep": "soft guitar for deep sleep", "study": "acoustic guitar for focus",
        "reading": "acoustic guitar for reading", "season": "seasonal acoustic guitar",
        "fantasy": "guitar for imaginary worlds", "relax": "acoustic guitar to relax to",
    },
    "synthwave": {
        "sleep": "slow synthwave for late nights", "study": "synthwave music to program to",
        "reading": "synthwave for reading", "season": "seasonal synthwave mix",
        "fantasy": "synthwave for imaginary worlds", "relax": "synthwave to chill/game to",
    },
    "house": {
        "sleep": "slow house for late nights", "study": "chill house for focus",
        "reading": "chill house for reading", "season": "seasonal chill house",
        "fantasy": "house for imaginary worlds", "relax": "chill house to unwind to",
    },
    "dnb": {
        "sleep": "atmospheric drum & bass for late nights", "study": "drum & bass for focus",
        "reading": "liquid drum & bass for reading", "season": "seasonal drum & bass mix",
        "fantasy": "drum & bass for imaginary worlds", "relax": "liquid drum & bass to unwind to",
    },
    "default": {
        "sleep": "music for deep sleep",
        "study": "music for focus",
        "reading": "music for reading",
        "season": "seasonal music",
        "fantasy": "music for imaginary worlds",
        "relax": "music to relax to",
    },
}
TITLE_FALLBACK_HOOKS = {
    "sleep": "Deep Sleep",
    "study": "Deep Focus",
    "reading": "Quiet Reading",
    "season": "Seasonal Mix",
    "fantasy": "Distant Worlds",
    "relax": "Quiet Hours",
}
TITLE_GENRE_FALLBACK_HOOKS = {
    "lofi": "Lofi Mix", "ambient": "Ambient Mix", "nature": "Nature Sounds", "jazz": "Relaxing Jazz",
    "piano": "Peaceful Piano", "classical": "Classical Essentials",
    "guitar": "Relaxing Guitar", "synthwave": "Synthwave Mix",
    "house": "Chill House Mix", "dnb": "Drum & Bass Mix",
}

# Each label is selected only when its expression is present in the measured
# source title. This converts SEO-heavy packaging into a concise premise
# without inventing a location, character or story.
TITLE_MEASURED_THEMES = {
    "nature": (
        (r"\bbrown noise\b", "Brown Noise"),
        (r"\b(?:fan|ventilator)\b", "Fan Sounds"),
        (r"\b(?:airplane|plane|aircraft|jet)\b", "Airplane Cabin Sounds"),
        (r"\bwhite noise\b", "White Noise"),
        (r"\b(?:fireplace|crackling fire|burning logs?)\b", "Crackling Fireplace"),
        (r"(?:\brain\b.*\bthunder\b|\bthunder\b.*\brain\b)", "Rain & Thunder"),
        (r"\brainforest\b", "Rainforest Rain"),
        (r"\b(?:ocean|rolling waves?|sea waves?)\b", "Ocean Waves"),
        (r"(?:\brain\b.*\bforest\b|\bforest\b.*\brain\b)", "Forest Rain"),
        (r"(?:\brain\b.*\bwindow\b|\bwindow\b.*\brain\b)", "Rain on the Window"),
        (r"(?:\brain\b.*\broof\b|\broof\b.*\brain\b)", "Rain on the Roof"),
        (r"\b(?:night rain|rain at night)\b", "Night Rain"),
        (r"(?:\bsummer night\b.*\bcrickets?\b|\bcrickets?\b.*\bsummer night\b)", "Summer Night Crickets"),
        (r"\bcrickets?\b", "Cricket Sounds"),
        (r"\brain(?:storm)?\b", "Rain Sounds"),
        (r"\b(?:river|stream|waterfall)\b", "Flowing Water"),
        (r"\b(?:birds?|birdsong)\b", "Bird Sounds"),
    ),
    "piano": (
        (r"\brain\b", "Piano & Rain"),
        (r"\bwater\b", "Piano & Water Sounds"),
        (r"\bromantic\b", "Romantic Piano"),
        (r"\b(?:summer night|summer)\b", "Summer Piano"),
        (r"\b(?:christmas|holiday)\b", "Christmas Piano"),
        (r"\b(?:soundtracks?|film score)\b", "Piano Soundtracks"),
        (r"\bsleep\b", "Deep Sleep Piano"),
        (r"\bnight\b", "Night Piano"),
        (r"\bmorning\b", "Morning Piano"),
        (r"\bpiano\b", "Peaceful Piano"),
    ),
    "ambient": (
        (r"\b(?:overthinking|anxiety|stress)\b", "Quiet Your Mind"),
        (r"\balpha waves?\b", "Alpha Waves"),
        (r"\bdelta waves?\b", "Delta Waves"),
        (r"\b(?:rain|thunder)\b", "Rain Ambient"),
        (r"\b(?:focus|study|concentration)\b", "Deep Focus"),
        (r"\bwater\b", "Water Meditation"),
        (r"\b(?:zen|meditation)\b", "Meditation Ambient"),
        (r"\b(?:deep sleep|fall asleep|sleep music)\b", "Deep Sleep"),
        (r"\bambient\b", "Ambient Mix"),
    ),
    "jazz": (
        (r"\b(?:bossa|bossa nova)\b", "Bossa Nova"),
        (r"\b(?:rainy|rain)\b", "Rainy Jazz"),
        (r"\bmorning\b", "Morning Jazz"),
        (r"\bcoffee\b", "Coffee Jazz"),
        (r"\bmidnight\b", "Midnight Jazz"),
        (r"\b(?:late night|night)\b", "Night Jazz"),
        (r"\bromantic\b", "Romantic Jazz"),
        (r"\bnoir\b", "Jazz Noir"),
        (r"\bslow jazz\b", "Slow Jazz"),
        (r"\b(?:lounge|bar music)\b", "Jazz Lounge"),
        (r"\b(?:work|study|focus)\b", "Focus Jazz"),
        (r"\bjazz\b", "Relaxing Jazz"),
    ),
    "lofi": (
        (r"\b90'?s\b", "90s Lofi"),
        (r"\b(?:snowfall|snow|winter)\b", "Winter Lofi"),
        (r"\bsummer\b", "Summer Lofi"),
        (r"\b(?:autumn|fall)\b", "Autumn Lofi"),
        (r"\brain\b", "Rainy Lofi"),
        (r"\b(?:sleep|bedtime)\b", "Bedtime Lofi"),
        (r"\b(?:study|focus|work)\b", "Deep Work"),
        (r"\bchill\b", "Chill Lofi"),
        (r"\brelax(?:ing|ed|ation)?\b", "Relaxing Lofi"),
        (r"\blo[ -]?fi\b", "Lofi Mix"),
    ),
    "classical": (
        (r"(?:\bcello\b.*\brain\b|\brain\b.*\bcello\b)", "Cello & Rain"),
        (r"\bcello\b", "Calm Cello"),
        (r"\badagio\b", "Adagio"),
        (r"\bpain to peace\b", "From Pain to Peace"),
        (r"\b(?:indian|bansuri)\b.*\bflute\b|\bflute\b.*\b(?:indian|bansuri)\b", "Indian Flute"),
        (r"\bbaroque\b", "Baroque Essentials"),
        (r"\b(?:soundtracks?|film score)\b", "Classical Soundtracks"),
        (r"\b(?:orchestra|symphony)\b", "Calm Orchestra"),
        (r"\bclassical\b", "Classical Essentials"),
    ),
    "guitar": (
        (r"\bmidnight blues\b", "Midnight Blues"),
        (r"\bblues\b", "Blues Guitar"),
        (r"\bfingerstyle\b", "Fingerstyle Guitar"),
        (r"\bacoustic\b", "Acoustic Guitar"),
        (r"\b(?:sea|ocean|coast)\b", "Seaside Guitar"),
        (r"\bguitar\b", "Relaxing Guitar"),
    ),
    "synthwave": (
        (r"\b(?:coding|programming|program)\b", "Coding Session"),
        (r"(?:\blate night\b.*\b(?:gaming|game)\b|\b(?:gaming|game)\b.*\blate night\b)", "Late Night Gaming"),
        (r"\b(?:gaming|game)\b", "Gaming Synthwave"),
        (r"\b(?:night drive|driving)\b", "Night Drive"),
        (r"\bmidnight\b", "Midnight Synthwave"),
        (r"\bnight\b", "Night Synthwave"),
        (r"\bsynthwave\b", "Synthwave Mix"),
    ),
    "house": (
        (r"\bsummer\b", "Summer House"),
        (r"\bsunset\b", "Sunset House"),
        (r"\bmidnight\b", "Midnight House"),
        (r"\bnight\b", "Night House"),
        (r"\bhouse\b", "Chill House Mix"),
    ),
    "dnb": (
        (r"\bliquid\b", "Liquid Drum & Bass"),
        (r"\batmospheric\b", "Atmospheric Drum & Bass"),
        (r"\b(?:night|midnight)\b", "Night Drum & Bass"),
        (r"\b(?:drum\s*&?\s*bass|dnb)\b", "Drum & Bass Mix"),
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
    if re.search(r"\bnature\b|\bsoundscape\b|\bwhite noise\b", value):
        return "nature"
    if re.search(r"ambient", value):
        return "ambient"
    return None


UNSUPPORTED_EXPLICIT_GENRE_PATTERN = re.compile(
    r"\b(?:pop|trap|rock|metal|techno|trance|edm|reggae|country|afrobeats?|funk|"
    r"native[\s-]+american|shamanic|temple\s+rhythms?|japanese\s+zen|celtic|medieval|"
    r"tavern|fantasy\s+(?:music|ambience)|dungeons?\s*(?:&|and)\s*dragons?|d\s*&\s*d)\b|\br\s*&\s*b\b|"
    r"\b4k\b.{0,50}\b(?:nature|scenic|relaxation)\b.{0,20}\b(?:film|video)\b|"
    r"\b(?:nature|scenic|relaxation)\b.{0,30}\b(?:film|video)\b.{0,20}\b4k\b",
    re.I,
)


def _title_explicit_genre_keys(value: object) -> set[str]:
    """Return only musical lanes explicitly named by a title."""
    title = _normal(value)
    keys = set()
    for pattern, genre_key in (
        (r"drum\s*&?\s*bass|drum and bass|\bdnb\b|liquid jungle", "dnb"),
        (r"chill house|lofi house|deep house|melodic house", "house"),
        (r"synthwave|retrowave|chillwave|outrun", "synthwave"),
        (r"classical|classique|baroque|orchestra|chamber|symphony|cello|violin", "classical"),
        (r"jazz|bossa", "jazz"),
        (r"piano", "piano"),
        (r"guitar|acoustic|fingerstyle|\bblues\b", "guitar"),
        (r"lofi|lo-fi|chillhop|hip hop", "lofi"),
        (
            r"\bnature\s+(?:sounds?|ambience|soundscape|noise|asmr)\b|"
            r"\b(?:white|brown)\s+noise\b|"
            r"\b(?:rain(?:storm)?|thunder|forest|ocean|sea|river|stream|waterfall|waves?|"
            r"fireplace|crickets?|birds?|birdsong|fan|airplane\s+cabin)\b.{0,45}"
            r"\b(?:sounds?|ambience|noise|asmr)\b|"
            r"\b(?:sounds?|ambience|noise|asmr)\b.{0,45}"
            r"\b(?:rain(?:storm)?|thunder|forest|ocean|sea|river|stream|waterfall|waves?|"
            r"fireplace|crickets?|birds?|birdsong|fan|airplane\s+cabin)\b",
            "nature",
        ),
        (r"ambient|soundscape", "ambient"),
    ):
        if re.search(pattern, title, re.I):
            keys.add(genre_key)
    return keys


def _genre_coherence(row: dict) -> int:
    """Score declared/title agreement; unsupported explicit lanes fail closed."""
    title = _normal(row.get("title"))
    if UNSUPPORTED_EXPLICIT_GENRE_PATTERN.search(title):
        return -1
    declared = _genre_profile_key(row.get("genre"))
    title_keys = _title_explicit_genre_keys(title)
    if title_keys:
        return 3 if declared in title_keys else 1
    return 2 if declared else 0


def _profile_key(row: dict) -> str | None:
    verified = str(row.get("_verifiedGenreKey") or "").strip()
    if verified in PROFILES:
        return verified
    if _genre_coherence(row) < 0:
        return None
    explicit = _genre_profile_key(row.get("genre"))
    title_keys = _title_explicit_genre_keys(row.get("title"))
    if row.get("_feedbackEditedTitle"):
        if explicit in title_keys:
            return explicit
        if len(title_keys) == 1:
            return next(iter(title_keys))
        return None
    if explicit and (not title_keys or explicit in title_keys):
        return explicit

    # A scan label cannot rewrite a musical lane explicitly named by the
    # source title. Supported conflicts use the measured title; unsupported
    # lanes were rejected above.
    for genre_key in ("dnb", "house", "synthwave", "classical", "jazz", "piano", "guitar", "lofi", "nature", "ambient"):
        if genre_key in title_keys:
            return genre_key

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
    if re.search(
        r"\bnature\b|\brain\b|\bforest\b|\bocean\b|\briver\b|\bthunder\b|"
        r"\bfireplace\b|\bwhite noise\b",
        value,
    ):
        return "nature"
    if re.search(r"ambient|sleep|meditation|focus", value):
        return "ambient"
    return None


def _purpose_from_text(value: object) -> str | None:
    value = _normal(value)
    if re.search(r"\b(?:sleep|sommeil|bedtime|insomnia|nap)\b|\bfall asleep\b|\bdeep rest\b", value):
        return "sleep"
    if re.search(r"\b(?:read|reading|write|writing|book|library)\b", value):
        return "reading"
    if re.search(r"\b(?:study|focus|work|coding)\b|\b(?:program|concentr|productiv)\w*\b", value):
        return "study"
    if re.search(r"\b(?:season|winter|summer|autumn|fall|spring|christmas|halloween|snow)\b", value):
        return "season"
    if re.search(r"\b(?:fantasy|medieval|dystopian?)\b|\bworldbuild\w*\b|\bdistant world\b", value):
        return "fantasy"
    if re.search(
        r"\b(?:meditation|coffee|jazz|gaming|game|unwind|calm|slow|cozy)\b|\bnight drive\b|"
        r"\b(?:relax|chill|peace)\w*\b",
        value,
    ):
        return "relax"
    return None


def _purpose_key(row: dict) -> str:
    # Once the team edits a title, the final wording is authoritative. Stale
    # generated `_purposeKey`, cluster or niche fields must not relabel it.
    if row.get("_feedbackEditedTitle"):
        edited = _purpose_from_text(row.get("title"))
        return edited or "relax"

    # Public title copy is the measured packaging the user asked us to learn.
    # A stale scan cluster must never turn an explicit Relax/Study title into
    # Sleep (or vice versa). Cluster/niche remain a fallback only when the
    # title itself carries no usable purpose signal.
    title_purpose = _purpose_from_text(row.get("title"))
    if title_purpose:
        return title_purpose

    declared = " ".join(str(row.get(key) or "") for key in ("cluster", "niche"))
    declared_purpose = _purpose_from_text(declared)
    if declared_purpose:
        return declared_purpose

    return _purpose_from_text(row.get("kw")) or "relax"


def _source_age_months(row: dict) -> float | None:
    try:
        age = float(row.get("ageM"))
    except (TypeError, ValueError):
        return None
    return age if math.isfinite(age) and age >= 0 else None


def _source_window(row: dict) -> str | None:
    age = _source_age_months(row)
    if age is None:
        return None
    if age <= 3:
        return "0-3m"
    if age <= 6:
        return "3-6m"
    if age <= 12:
        return "6-12m"
    return "12m+"


def _freshness_weight(age_months: object) -> float:
    """Keep the complete history while making recent evidence more decisive."""
    try:
        age = float(age_months)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(age) or age < 0:
        return 0.0
    # Evidence loses half its freshness weight every twelve months, but an
    # evergreen success is never removed solely because it is old.
    return 2 ** (-age / 12.0)


def _market_value(row: dict) -> float:
    views = max(0.0, float(row.get("views") or 0))
    lifetime_vpm = max(0.0, float(row.get("vpm") or 0))
    recent_vpm = row.get("_recentVpm")
    try:
        recent_vpm = float(recent_vpm)
    except (TypeError, ValueError):
        recent_vpm = math.nan
    vpm = lifetime_vpm
    if math.isfinite(recent_vpm) and recent_vpm >= 0:
        # Current measured momentum leads; lifetime performance keeps an
        # evergreen title from being judged on a single short observation.
        vpm = recent_vpm * 0.70 + lifetime_vpm * 0.30
    return math.log10(views + 10) * 9 + math.log10(vpm + 10) * 14


def _decision_signal(value: object) -> int:
    value = str(value or "").strip()
    if re.match(r"^x(?=$|\s|[,;:\-\u00b7])", value, re.IGNORECASE):
        return 1
    if re.match(r"^-\s*(?:$|\u00b7)", value):
        return -1
    return 0


def _title_style_key(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    lowered = text.casefold()
    if re.match(r"^pov\s*:", lowered):
        return "pov"
    if re.search(r"\b(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)|all night|overnight)\b", lowered):
        return "duration"
    if "|" in text:
        return "pipe"
    if re.search(r"\[[^\]]{2,40}\]", text):
        return "signature"
    if re.search(r"\bbest of\b|\bpart\s+\d+\b|\bvol(?:ume)?\.?\s*\d+\b", lowered):
        return "series"
    if re.search(r"\b(?:to|for)\s+(?:sleep|study|focus|work|read|relax|chill|program|code)", lowered):
        return "use_case"
    return "direct"


def _title_hook(value: object, purpose_key: str = "relax", genre_key: str | None = None) -> str:
    """Extract a concise measured premise without manufacturing a setting."""
    original = re.sub(r"https?://\S+", " ", str(value or ""))
    normalized = _normal(original)
    for pattern, label in TITLE_MEASURED_THEMES.get(genre_key or "", ()):
        if re.search(pattern, normalized, re.I):
            return label
    if genre_key:
        # Generated premises are allowlisted above. An unmapped competitor
        # fragment is never copied: use a truthful neutral genre hook instead.
        return TITLE_GENRE_FALLBACK_HOOKS.get(genre_key) or TITLE_FALLBACK_HOOKS.get(purpose_key, "Quiet Hours")
    text = original
    text = re.sub(r"^\s*pov\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\b\d+(?:\.\d+)?\s*(?:hz|h|hr|hrs|hour|hours)\b", " ", text, flags=re.I)
    text = re.sub(r"\b\d+(?:\.\d+)?\s*minutes?\b", " ", text, flags=re.I)
    text = re.sub(r"\b(?:432|528|741|852|963|999)\s*hz\b", " ", text, flags=re.I)
    text = re.sub(r"\s+by\s+[^|·—–-]+$", " ", text, flags=re.I)
    parts = [part.strip(" -–—·•|:,.\t") for part in re.split(r"\s*[|·•—–]\s*|\s+-\s+", text) if part.strip()]
    if parts:
        # An artist credit on the left of a dash is evidence of a track, not a
        # title premise. The track name on the right remains measured evidence.
        if len(parts) > 1 and (re.search(r"\s+x\s+", parts[0], re.I) or len(parts[0].split()) <= 2):
            text = parts[1]
        else:
            text = parts[0]
    if ":" in text:
        left, right = (part.strip() for part in text.split(":", 1))
        left_is_boilerplate = bool(re.search(
            r"^(?:relaxing|soothing|beautiful|sleep|study|focus|meditation|piano|ambient)"
            r"(?:\s+(?:music|relaxation|piano|sounds?))*$",
            left,
            re.I,
        ))
        text = right if left_is_boilerplate and right else left
    text = re.sub(
        r"\b(?:no ads?|official (?:video|audio)|high quality stereo|remastered|black screen|dark screen|"
        r"fall asleep (?:fast|instantly|immediately)|goodbye insomnia|relieves? stress|reduce anxiety|"
        r"really awesome|epic|super deep|the most beautiful|beautiful|soothing|relaxing)\b",
        " ",
        text,
        flags=re.I,
    )
    text = re.split(
        r"\b(?:music|beats?|sounds?|soundscape|mix|radio)\s+(?:to|for)\b|\b(?:to|for)\s+(?:deep\s+)?(?:sleep|study|focus|work|reading|relaxation)\b",
        text,
        maxsplit=1,
        flags=re.I,
    )[0]
    text = re.sub(r"^[\W_]+|[\W_]+$", "", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text).strip()
    words = text.split()
    if len(words) > 6:
        text = " ".join(words[:6]).rstrip(" ,:;-–—")
    generic = _normal(text)
    if re.search(r"^(?:a playlist|playlist|ultimate|best of|top \d+|compilation|collection)\b", generic):
        return TITLE_GENRE_FALLBACK_HOOKS.get(genre_key) or TITLE_FALLBACK_HOOKS.get(purpose_key, "Quiet Hours")
    if (
        re.search(
            r"\b(?:blade runner|harry potter|hogwarts|hobbit|lord of the rings|polar express|"
            r"skyrim|zora|narnia|jurassic|bluey|samurai|bon iver|st\.? vincent|brain\.fm|"
            r"vagus nerve|healing frequenc(?:y|ies)|autism|mozart effect|cyberpunk|cybernetic|20\d{2})\b",
            generic,
        )
        or re.search(
            r"^(?:the most|the best|you are|you(?:'|’)re|use this|this will|all you need|"
            r"try listening|listen to|of\b|4k\b|idea\s*\d+)\b",
            generic,
        )
        or generic == "dance of life"
        or len(words) <= 1
        or len(words) > 5
    ):
        return TITLE_GENRE_FALLBACK_HOOKS.get(genre_key) or TITLE_FALLBACK_HOOKS.get(purpose_key, "Quiet Hours")
    if not text or generic in {
        "music", "relaxing music", "sleep music", "study music", "lofi", "lofi music",
        "ambient music", "jazz music", "piano music", "nature sounds", "instrumental music",
    }:
        return TITLE_FALLBACK_HOOKS.get(purpose_key, "Quiet Hours")
    return text


def _editorial_concept_key(row: dict) -> str:
    genre_key = _profile_key(row)
    if genre_key is None:
        return ""
    purpose_key = _purpose_key(row)
    # Refusals bind to the reviewed premise, not to a broad generated theme
    # such as every "Deep Work" or every "Rain" title in the same genre.
    hook = _refusal_topic(row, genre_key, purpose_key)
    return "|".join((genre_key, purpose_key, hook)) if hook else ""


def _refusal_topic(row: dict, genre_key: str, purpose_key: str) -> str:
    reviewed = _title_fingerprint(row.get("title"))
    explicit_labels = sorted(
        {
            _title_fingerprint(label)
            for themes in TITLE_MEASURED_THEMES.values()
            for _pattern, label in themes
            if len(_title_fingerprint(label).split()) >= 2
        },
        key=lambda label: (-len(label.split()), -len(label), label),
    )
    for label in explicit_labels:
        if re.search(rf"(?:^|\s){re.escape(label)}(?:$|\s)", reviewed):
            return _canonical_refusal_hook(label)
    raw = _normal(_title_hook(row.get("title"), purpose_key))
    broad_fallbacks = {_normal(value) for value in TITLE_FALLBACK_HOOKS.values()}
    if not raw or raw in broad_fallbacks:
        raw = _normal(_title_hook(row.get("title"), purpose_key, genre_key))
    neutral = broad_fallbacks | {_normal(value) for value in TITLE_GENRE_FALLBACK_HOOKS.values()}
    if raw in neutral:
        # A sanitizer fallback is not evidence that the team rejected the
        # whole generic lane. It becomes a veto only when the reviewed title
        # itself explicitly names that exact multi-word hook (for example
        # "Lofi Mix | ...").
        if len(raw.split()) < 2 or not re.search(rf"(?:^|\s){re.escape(raw)}(?:$|\s)", reviewed):
            return ""
    return _canonical_refusal_hook(raw)


def _canonical_refusal_hook(value: object) -> str:
    # A narrow normalization only: punctuation and editorial suffixes. It
    # catches "Rain Ambient Hybrid" vs "Rain Ambient" but never every Rain.
    value = _title_fingerprint(value)
    value = re.sub(r"\s+(?:hybrid|version|edit|extended)$", "", value).strip()
    # A rejected measured premise must not return after merely dropping a
    # short location suffix (for example "Night Drive in Osaka" -> "Night
    # Drive"). Keep this deliberately narrow: only known multi-word themes
    # followed by `in/at` and at most three plain words are collapsed. A
    # generic one-word signal such as Rain never becomes a global veto.
    for themes in TITLE_MEASURED_THEMES.values():
        for _pattern, label in themes:
            core = _title_fingerprint(label)
            if len(core.split()) < 2:
                continue
            if re.fullmatch(
                rf"{re.escape(core)}\s+(?:in|at)\s+(?:the\s+)?[a-z0-9]+(?:\s+[a-z0-9]+){{0,2}}",
                value,
            ):
                return core
    return value


def _editorial_topic_key(row: dict) -> str:
    genre_key = _profile_key(row)
    if genre_key is None:
        return ""
    purpose_key = _purpose_key(row)
    topic = _refusal_topic(row, genre_key, purpose_key)
    return "|".join((genre_key, topic)) if topic else ""


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


def _effective_feedback_row(raw: dict) -> dict:
    row = dict(raw)
    edits = row.get("edits") if isinstance(row.get("edits"), dict) else {}
    edited_title = row.get("editedTitle") or edits.get("title")
    if edited_title is not None and str(edited_title).strip():
        row["title"] = str(edited_title).strip()
        row["_feedbackEditedTitle"] = True
    return row


def _build_feedback_profile(data: dict) -> dict:
    counts = {
        "genre": defaultdict(Counter),
        "purpose": defaultdict(Counter),
        "combo": defaultdict(Counter),
        "titleStyle": defaultdict(Counter),
    }
    decided_titles: set[str] = set()
    refused_concepts: set[str] = set()
    refused_topics: set[str] = set()
    refused_hooks: set[str] = set()
    accepted_references: dict[str, list[dict]] = defaultdict(list)
    for raw in data.get("recos") or []:
        row = _effective_feedback_row(raw)
        signal = _decision_signal(row.get("valid"))
        if not signal:
            continue
        genre_key = _profile_key(row)
        purpose_key = _purpose_key(row)
        title_style = _title_style_key(row.get("title"))
        title_fingerprint = _title_fingerprint(row.get("title"))
        concept_key = _editorial_concept_key(row)
        if title_fingerprint:
            decided_titles.add(title_fingerprint)
        if genre_key:
            counts["genre"][genre_key][signal] += 1
            counts["combo"][(genre_key, purpose_key)][signal] += 1
            counts["titleStyle"][(genre_key, title_style)][signal] += 1
            if signal > 0:
                accepted_references[genre_key].append(dict(row))
            elif concept_key:
                refused_concepts.add(concept_key)
                topic_key = _editorial_topic_key(row)
                if topic_key:
                    refused_topics.add(topic_key)
                hook = _refusal_topic(row, genre_key, purpose_key)
                if hook:
                    refused_hooks.add(hook)
        counts["purpose"][purpose_key][signal] += 1
    profile = {
        dimension: {key: _bounded_preference(counter) for key, counter in values.items()}
        for dimension, values in counts.items() if dimension != "titleStyle"
    }
    profile["titleStyle"] = {
        # A validation can promote a reusable packaging pattern. A refusal
        # without a structured reason remains an exact title/concept veto and
        # is not generalized into a negative judgement on the whole pattern.
        key: _bounded_preference(Counter({1: counter.get(1, 0)}))
        for key, counter in counts["titleStyle"].items()
    }
    profile["titleStyleCounts"] = {
        key: {"accepted": int(counter.get(1, 0)), "refused": int(counter.get(-1, 0))}
        for key, counter in counts["titleStyle"].items()
    }
    profile["decidedTitles"] = decided_titles
    profile["refusedConcepts"] = refused_concepts
    profile["refusedTopics"] = refused_topics
    profile["refusedHooks"] = refused_hooks
    profile["blockedCombos"] = {
        key for key, counter in counts["combo"].items()
        if int(counter.get(-1, 0)) >= 2 and not int(counter.get(1, 0))
    }
    profile["acceptedReferences"] = dict(accepted_references)
    return profile


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
    # All history stays eligible. Freshness only breaks the old catalogue's
    # structural dominance; a genuinely strong evergreen can still outrank a
    # weak recent video because measured market value remains the main term.
    # This is deliberately a ranking-only term: it gives current evidence a
    # meaningful lead without inflating the recommendation score or S tier.
    freshness = _freshness_weight(row.get("ageM")) * SOURCE_FRESHNESS_RANK_WEIGHT
    return (
        _market_value(row)
        + freshness
        + _feedback_affinity(feedback_profile, genre_key, purpose_key) * FEEDBACK_MARKET_WEIGHT
    )


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


def _source_rows(
    data: dict,
    feedback_profile: dict,
    history: dict[str, list[list[float]]] | None = None,
) -> list[dict]:
    by_video: dict[str, dict] = {}
    for bucket in ("all", "trends", "news"):
        for row in data.get(bucket) or []:
            video_id = str(row.get("vid") or "").strip()
            views = max(0.0, float(row.get("views") or 0))
            candidate = dict(row)
            verified_genre_key = _source_profile_key(candidate)
            if verified_genre_key is not None:
                candidate["_verifiedGenreKey"] = verified_genre_key
            recent_vpm = _observed_recent_vpm((history or {}).get(video_id))
            if recent_vpm is not None:
                candidate["_recentVpm"] = round(recent_vpm, 4)
            vpm = max(0.0, float(candidate.get("vpm") or 0), float(candidate.get("_recentVpm") or 0))
            if (
                not video_id
                or not candidate.get("title")
                or _source_has_explicit_vocals(candidate)
                or verified_genre_key is None
                or _source_window(candidate) is None
                or views < MIN_SOURCE_VIEWS
                or vpm < MIN_SOURCE_VPM
            ):
                continue
            current = by_video.get(video_id)
            candidate_key = (_genre_coherence(candidate), _source_rank_value(candidate, feedback_profile))
            current_key = (
                (_genre_coherence(current), _source_rank_value(current, feedback_profile))
                if current is not None else (-1, -math.inf)
            )
            if candidate_key > current_key:
                by_video[video_id] = candidate
    return sorted(
        by_video.values(),
        key=lambda row: (
            -_source_rank_value(row, feedback_profile),
            -_freshness_weight(row.get("ageM")),
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
    lifetime_vpm = max(1.0, float(source.get("vpm") or 0))
    recent_vpm = source.get("_recentVpm")
    try:
        recent_vpm = float(recent_vpm)
    except (TypeError, ValueError):
        recent_vpm = math.nan
    vpm = lifetime_vpm if not math.isfinite(recent_vpm) else max(1.0, recent_vpm * 0.70 + lifetime_vpm * 0.30)
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
    # Age is a projection/ranking signal only. It must never manufacture a
    # higher objective score, potential or tier for otherwise equal evidence.
    score = round(SOURCE_SCORE_FLOOR + strength * SOURCE_SCORE_SPAN)
    return max(SOURCE_SCORE_FLOOR, min(99, score)), strength


def _potential_for_score(score: int) -> str:
    if score >= 95:
        return "S - Rente potentielle"
    if score >= 88:
        return "A - Fort"
    if score >= 78:
        return "B - Solide"
    return "C - À tester"


def _title_performance_value(row: dict) -> float:
    views = max(0.0, float(row.get("views") or 0))
    vpm = max(0.0, float(row.get("_recentVpm") or row.get("vpm") or 0))
    return math.log10(views + 10) * 0.35 + math.log10(vpm + 10) * 0.65


def _title_model_genre_key(row: dict) -> str | None:
    """Resolve the musical lead used for title learning, including hybrids."""
    title = _normal(row.get("title"))
    if UNSUPPORTED_EXPLICIT_GENRE_PATTERN.search(title):
        return None
    declared = _genre_profile_key(row.get("genre"))
    title_keys = _title_explicit_genre_keys(title)
    if declared in title_keys:
        return declared
    # A hybrid's distinguishing musical lane is more useful for title grammar
    # than the broad Lofi bucket stored on several historical uploads.
    for pattern, genre_key in (
        (r"\bjazz\b|\bbossa\b", "jazz"),
        (r"\bpiano\b", "piano"),
        (r"\bclassical\b|\bclassique\b|\bchamber\b", "classical"),
        (r"\bguitar\b|\bfingerstyle\b", "guitar"),
        (r"\bsynthwave\b|\bretrowave\b", "synthwave"),
        (r"\bambient\b|\bsoundscape\b", "ambient"),
        (r"\bnature sounds?\b|\bwhite noise\b", "nature"),
    ):
        if re.search(pattern, title):
            return genre_key
    # This resolver is used only for official-channel title learning. When an
    # old upload predates genre tagging and exposes no more specific musical
    # lane, Lofi is the honest channel-level fallback.
    return _profile_key(row) or "lofi"


def _title_model(
    data: dict,
    sources: list[dict],
    feedback_profile: dict,
    history: dict[str, list[list[float]]] | None = None,
) -> dict:
    """Learn title structures per genre from market, Lofi Girl and reviews."""
    owned_rows = []
    for raw in data.get("ours") or []:
        if not raw.get("title") or _title_model_genre_key(raw) is None or _source_age_months(raw) is None:
            continue
        row = dict(raw)
        recent_vpm = _observed_recent_vpm((history or {}).get(str(row.get("vid") or "")))
        if recent_vpm is not None:
            row["_recentVpm"] = round(recent_vpm, 4)
        owned_rows.append(row)
    owned_values = sorted(_title_performance_value(row) for row in owned_rows)
    market_values = sorted(_title_performance_value(row) for row in sources)
    owned_values_by_genre: dict[str, list[float]] = defaultdict(list)
    market_values_by_genre: dict[str, list[float]] = defaultdict(list)
    for row in owned_rows:
        owned_values_by_genre[_title_model_genre_key(row)].append(_title_performance_value(row))
    for row in sources:
        genre_key = _profile_key(row)
        if genre_key is not None:
            market_values_by_genre[genre_key].append(_title_performance_value(row))
    owned_values_by_genre = {key: sorted(values) for key, values in owned_values_by_genre.items()}
    market_values_by_genre = {key: sorted(values) for key, values in market_values_by_genre.items()}
    style_scores: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    references: dict[str, dict[str, tuple[float, str, dict]]] = defaultdict(dict)
    genre_observations: dict[str, list[tuple[float, float]]] = defaultdict(list)
    supported_styles: dict[str, set[str]] = defaultdict(set)

    for row in owned_rows:
        genre_key = _title_model_genre_key(row)
        if genre_key is None:
            continue
        style = _title_style_key(row.get("title"))
        comparables = owned_values_by_genre.get(genre_key) or owned_values
        percentile = _percentile(comparables, _title_performance_value(row))
        evidence = percentile * 0.72 + _freshness_weight(row.get("ageM")) * 0.28
        # Published Lofi Girl titles are the main authority for packaging.
        style_scores[genre_key][style] += 1.2 + evidence * 3.8
        supported_styles[genre_key].add(style)
        global_percentile = _percentile(owned_values, _title_performance_value(row))
        observation_weight = 0.35 + _freshness_weight(row.get("ageM")) * 0.65
        genre_observations[genre_key].append((global_percentile, observation_weight))
        current = references[genre_key].get(style)
        if current is None or evidence > current[0]:
            references[genre_key][style] = (evidence, "analyse", row)

    for row in sources:
        genre_key = _profile_key(row)
        if genre_key is None:
            continue
        style = _title_style_key(row.get("title"))
        comparables = market_values_by_genre.get(genre_key) or market_values
        percentile = _percentile(comparables, _title_performance_value(row))
        evidence = percentile * 0.80 + _freshness_weight(row.get("ageM")) * 0.20
        # Market structure is useful, but never outweighs the channel's style.
        style_scores[genre_key][style] += 0.25 + evidence * 0.75
        current = references[genre_key].get(style)
        if current is None:
            references[genre_key][style] = (evidence * 0.25, "market", row)

    for genre_key, rows in feedback_profile.get("acceptedReferences", {}).items():
        for row in rows:
            style = _title_style_key(row.get("title"))
            style_scores[genre_key][style] += 5.0
            supported_styles[genre_key].add(style)
            current = references[genre_key].get(style)
            if current is None or current[0] < 1.1:
                references[genre_key][style] = (1.1, "validated", row)

    model = {}
    all_observations = [observation for rows in genre_observations.values() for observation in rows]
    total_global_weight = sum(weight for _percentile_value, weight in all_observations)
    global_mean = (
        sum(percentile_value * weight for percentile_value, weight in all_observations) / total_global_weight
        if total_global_weight else 0.5
    )
    genres = set(style_scores) | set(TITLE_GENRE_LABELS)
    for genre_key in genres:
        for style in TITLE_STYLE_KEYS:
            counts = feedback_profile.get("titleStyleCounts", {}).get((genre_key, style), {})
            accepted = int(counts.get("accepted", 0))
            # An unexplained refusal vetoes its exact title/concept, not a
            # reusable structure across an entire musical lane. Validations
            # are positive evidence and may promote that structure.
            if accepted:
                style_scores[genre_key][style] += accepted * 4.0
        ranked = sorted(
            TITLE_STYLE_KEYS,
            key=lambda style: (-style_scores[genre_key].get(style, 0.0), TITLE_STYLE_KEYS.index(style)),
        )
        observations = genre_observations.get(genre_key) or []
        total_weight = sum(weight for _percentile_value, weight in observations)
        genre_mean = (
            sum(percentile_value * weight for percentile_value, weight in observations) / total_weight
            if total_weight else global_mean
        )
        support = min(1.0, total_weight / 3.0)
        genre_signal = max(-1.0, min(1.0, (genre_mean - global_mean) * 2 * support))
        model[genre_key] = {
            "styles": ranked,
            "blocked": set(),
            "scores": dict(style_scores[genre_key]),
            "references": {
                style: {"type": reference_type, "row": row}
                for style, (_score, reference_type, row) in references[genre_key].items()
            },
            "supportedStyles": supported_styles.get(genre_key, set()),
            "genreSignal": genre_signal,
        }
    return model


def _style_compatible(style: str, source: dict, purpose_key: str) -> bool:
    source_style = _title_style_key(source.get("title"))
    if style == "pov":
        return source_style == "pov"
    if style == "series":
        return source_style == "series"
    if style == "duration":
        return source_style == "duration" or purpose_key == "sleep" or float(source.get("durH") or 0) >= 3
    return True


def _select_title_style(source: dict, model: dict, genre_key: str, purpose_key: str) -> str | None:
    genre_model = model.get(genre_key) or {}
    ranked = genre_model.get("styles") or TITLE_STYLE_KEYS
    supported = set(genre_model.get("supportedStyles") or ())
    eligible = [
        style for style in ranked
        if style in supported and _style_compatible(style, source, purpose_key)
    ]
    if eligible:
        # Weighted deterministic sampling prevents a tiny score lead from
        # forcing one structure on every proposal while keeping Analyse/X as
        # the only reusable style authorities.
        scores = genre_model.get("scores") or {}
        weights = [max(1, round(math.sqrt(max(0.0, float(scores.get(style) or 0.0))) * 100)) for style in eligible]
        ticket = _stable_int(f"title-style|{source.get('vid')}|{genre_key}") % sum(weights)
        for style, weight in zip(eligible, weights):
            if ticket < weight:
                return style
            ticket -= weight
    source_style = _title_style_key(source.get("title"))
    if _style_compatible(source_style, source, purpose_key):
        return source_style
    for style in ranked:
        if _style_compatible(style, source, purpose_key):
            return style
    return None


def _source_profile_key(row: dict) -> str | None:
    """Require the public source title to confirm its musical scan tag."""
    if _genre_coherence(row) < 0:
        return None
    declared = _genre_profile_key(row.get("genre"))
    title_keys = _title_explicit_genre_keys(row.get("title"))
    if declared and declared in title_keys:
        return declared
    if len(title_keys) == 1:
        return next(iter(title_keys))
    # A scan-only tag is not evidence. Ambiguous or unconfirmed market rows
    # fail closed instead of being converted into Lofi/Ambient/etc.
    return None


def _sentence_case_hook(value: str, lowercase: bool = False) -> str:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    if not value:
        return value
    if lowercase:
        return value.lower()
    return value[0].upper() + value[1:]


def _compose_candidate_title(source: dict, genre_key: str, purpose_key: str, style: str) -> str:
    genre_label, emoji = TITLE_GENRE_LABELS[genre_key]
    hook = _title_hook(source.get("title"), purpose_key, genre_key)
    purpose_clause = TITLE_PURPOSE_CLAUSES.get(genre_key, TITLE_PURPOSE_CLAUSES["default"]).get(
        purpose_key,
        TITLE_PURPOSE_CLAUSES["default"][purpose_key],
    )
    if style == "pov":
        title = f"pov: {_sentence_case_hook(hook, lowercase=True)} {emoji}"
    elif style == "duration":
        source_duration = float(source.get("durH") or 0)
        hours = max(2, min(12, round(source_duration))) if source_duration >= 2 else (8 if purpose_key == "sleep" else 3)
        if genre_key == "nature":
            title = f"{hours} hours of {hook.lower()} {emoji} cozy ambience to sleep/chill to"
        elif genre_key == "ambient":
            title = f"{_sentence_case_hook(hook)} {emoji} {hours} hours of ambient mix"
        elif genre_key == "piano":
            title = f"{_sentence_case_hook(hook)} {emoji} {hours} hours of relaxing piano music"
        elif genre_key == "jazz":
            title = f"{_sentence_case_hook(hook)} {emoji} {hours} hours of relaxing jazz"
        elif genre_key == "synthwave":
            title = f"{_sentence_case_hook(hook)} {emoji} {hours} hours of synthwave music"
        else:
            title = f"{_sentence_case_hook(hook)} {emoji} {hours} hours of {purpose_clause}"
    elif style == "pipe":
        title = f"{_sentence_case_hook(hook)} | {purpose_clause}"
    elif style == "signature":
        title = f"{_sentence_case_hook(hook)} {emoji} [{genre_label}]"
    elif style == "series":
        title = f"{_sentence_case_hook(hook)} {emoji} [{genre_label}]"
    elif style == "use_case":
        title = f"{_sentence_case_hook(hook, lowercase=True)} {emoji} {purpose_clause}"
    else:
        direct_suffix = {
            "nature": "cozy ambience to sleep/chill to" if purpose_key == "sleep" else purpose_clause,
            "piano": "relaxing piano music",
            "ambient": "ambient mix" if purpose_key == "sleep" else purpose_clause,
            "jazz": "[jazz lofi]",
            "classical": "calm classical music",
            "guitar": "relaxing acoustic guitar",
            "house": "chill house mix",
            "dnb": "atmospheric drum & bass mix",
            "synthwave": "synthwave music",
        }.get(genre_key, "")
        hook_tokens = set(_title_fingerprint(hook).split())
        suffix_tokens = set(_title_fingerprint(direct_suffix).split())
        if len(hook_tokens) >= 2 and hook_tokens.issubset(suffix_tokens):
            direct_suffix = ""
        title = f"{_sentence_case_hook(hook)} {emoji}" + (f" {direct_suffix}" if direct_suffix else "")
    title = re.sub(r"\s+", " ", title).strip()
    # Never copy a competitor title verbatim. The fallback remains a known
    # Lofi Girl signature structure and still does not add a setting.
    if _title_fingerprint(title) == _title_fingerprint(source.get("title")):
        title = f"{_sentence_case_hook(hook)} {emoji} [{genre_label}]"
    return title


def _idea_score(
    source_score: int,
    genre_signal: float,
    feedback_affinity: float,
    title_style_affinity: float,
) -> int:
    # Market remains the largest signal; channel fit and explicit decisions
    # can meaningfully promote or demote the actual proposal.
    adjusted = (
        float(source_score)
        + max(-1.0, min(1.0, genre_signal)) * 5.0
        + max(-1.0, min(1.0, feedback_affinity)) * 7.0
        + max(-1.0, min(1.0, title_style_affinity)) * 7.0
    )
    return max(SOURCE_SCORE_FLOOR, min(99, round(adjusted)))


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
        _normal(item.get("_conceptFamily") or item.get("_settingKey")),
        _normal(item.get("dur")),
        _title_fingerprint(item.get("title")),
    ))


def _concept_family(item: dict) -> str:
    explicit = str(item.get("_conceptFamily") or "").strip()
    if explicit:
        return explicit
    genre_key = _normal(item.get("_genreKey") or _profile_key(item) or item.get("genre"))
    purpose_key = _normal(item.get("_purposeKey") or _purpose_key(item))
    topic_key = _normal(item.get("_topicKey") or item.get("_settingKey"))
    if not genre_key or not purpose_key or not topic_key:
        return ""
    return "|".join((genre_key, purpose_key, topic_key))


def _topic_family(item: dict) -> str:
    genre_key = _normal(item.get("_genreKey") or _profile_key(item) or item.get("genre"))
    topic_key = _normal(item.get("_topicKey") or item.get("_settingKey"))
    return "|".join((genre_key, topic_key)) if genre_key and topic_key else ""


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
    if int(updated.get("_generatorVersion") or 0) >= 4:
        updated["_titleRecipeVersion"] = TITLE_RECIPE_VERSION
        if not updated.get("_titleFamily"):
            updated["_titleFamily"] = "v4|" + _title_fingerprint(updated.get("title"))
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
    title_model: dict,
) -> dict | None:
    profile_key = _profile_key(source)
    source_window = _source_window(source)
    source_age = _source_age_months(source)
    if profile_key is None or source_window is None or source_age is None:
        return None
    profile = PROFILES[profile_key]
    purpose_key = _purpose_key(source)
    idea_key = _idea_key(source, variant)
    style = _select_title_style(source, title_model, profile_key, purpose_key)
    if not style:
        return None
    title = _compose_candidate_title(source, profile_key, purpose_key, style)
    topic_key = _normal(_title_hook(source.get("title"), purpose_key, profile_key))
    concept_family = "|".join((profile_key, purpose_key, topic_key)) if topic_key else ""
    topic_family = "|".join((profile_key, topic_key)) if topic_key else ""
    refused_hook = _canonical_refusal_hook(topic_key)
    if (
        not concept_family
        or concept_family in feedback_profile.get("refusedConcepts", set())
        or topic_family in feedback_profile.get("refusedTopics", set())
        or refused_hook in feedback_profile.get("refusedHooks", set())
        or (profile_key, purpose_key) in feedback_profile.get("blockedCombos", set())
    ):
        return None
    if _title_fingerprint(title) in feedback_profile.get("decidedTitles", set()):
        return None
    source_score, strength = _source_score(source, score_context)
    evidence = _market_value(source)
    feedback_affinity = _feedback_affinity(feedback_profile, profile_key, purpose_key)
    title_style_affinity = float(feedback_profile.get("titleStyle", {}).get((profile_key, style), 0.0))
    genre_model = title_model.get(profile_key) or {}
    owned_genre_affinity = float(genre_model.get("genreSignal") or 0.0)
    score = _idea_score(source_score, owned_genre_affinity, feedback_affinity, title_style_affinity)
    duration = "8h" if purpose_key == "sleep" else "3h" if purpose_key in {"study", "reading"} else "2h"
    views = _format_metric(source.get("views"))
    vpm = _format_metric(source.get("_recentVpm") or source.get("vpm"))
    source_title = re.sub(r"\s+", " ", str(source.get("title") or "")).strip()
    reference_evidence = (genre_model.get("references") or {}).get(style) or {}
    reference_type = str(reference_evidence.get("type") or "").strip()
    reference = reference_evidence.get("row") if isinstance(reference_evidence.get("row"), dict) else {}
    reference_title = re.sub(r"\s+", " ", str(reference.get("title") or "")).strip()
    reference_video_id = str(reference.get("vid") or "").strip()
    concept = (
        f"Adapter le signal marché « {source_title} » au langage {profile['genre'].split(' ', 1)[-1]} "
        f"de Lofi Girl, pour {PURPOSE_FR[purpose_key]}. Le sujet vient de la vidéo mesurée ; "
        "aucun lieu n'est ajouté sans preuve dans ce signal."
    )
    note_parts = [f"Signal marché : « {source_title} » · {views} vues · {vpm} vues/mois"]
    if reference_title:
        reference_note = {
            "analyse": f"Structure Analyse : « {reference_title} »",
            "validated": f"Structure validée : « {reference_title} »",
            "market": f"Structure marché : « {reference_title} »",
        }.get(reference_type)
        if reference_note:
            note_parts.append(reference_note)
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
        "scene": "Direction visuelle à définir après validation du titre ; aucun décor ou lieu imposé par le générateur.",
        "style": profile["style"],
        "dur": duration,
        "desc": "",
        # Source keywords are competitor packaging, not measured evidence.
        # Never surface them as copy-ready SEO (they can contain IP names or
        # unsupported health claims even when the generated title is safe).
        "kw": "",
        "noteData": " · ".join(note_parts) + ".",
        "launch": "Hypothèse éditoriale mesurée",
        "conf": max(68, min(92, round(68 + strength * 24))),
        "status": "À valider",
        "recoClaude": "Angle marché rendu dans un style de titre appris sur Lofi Girl",
        "recal": "Marché, performances Analyse par genre et validations/refus explicites",
        "_generated": True,
        "_sourceVideoId": source.get("vid"),
        "_sourceMarketScore": round(evidence, 4),
        "_sourceAgeM": round(source_age, 4),
        "_sourceWindow": source_window,
        "_genreKey": profile_key,
        "_purposeKey": purpose_key,
        "_topicKey": topic_key,
        "_conceptFamily": concept_family,
        "_titleStyleKey": style,
        "_titleFamily": "|".join((profile_key, style)),
        "_titleReference": reference_title,
        "_titleReferenceVideoId": reference_video_id,
        "_titleReferenceType": reference_type,
        "_ownedGenreAffinity": round(owned_genre_affinity, 4),
        "_editorialTitleAffinity": round(title_style_affinity, 4),
        "_sourceRecentVpm": round(float(source.get("_recentVpm")), 4) if source.get("_recentVpm") is not None else None,
        "_feedbackAffinity": round(feedback_affinity, 4),
        "_scoringVersion": SCORING_VERSION,
        "_ideaKey": idea_key,
        "_recipeVersion": RECIPE_VERSION,
        "_recipeIndex": variant,
        "_generatorVersion": GENERATOR_VERSION,
    }
    if reference_type == "analyse" and reference_title:
        item["_ownedTitleReference"] = reference_title
        item["_ownedTitleReferenceVideoId"] = reference_video_id
    return _rehydrate_presentation(item)


def _v3_candidates(
    data: dict,
    feedback_profile: dict,
    history: dict[str, list[list[float]]] | None = None,
) -> list[tuple[dict, dict]]:
    sources = _source_rows(data, feedback_profile, history)
    if not sources:
        return []
    score_context = _source_score_context(sources)
    title_model = _title_model(data, sources, feedback_profile, history)
    rows: list[tuple[dict, dict]] = []
    for source in sources:
        for variant in range(CURRENT_VARIANTS_PER_SOURCE):
            item = _build_v3_item(source, variant, feedback_profile, score_context, title_model)
            if item is not None:
                rows.append((item, source))
    # Keep every evidence-bound source eligible, but present one hypothesis per
    # genre/topic before repeats with another purpose. This improves the active
    # batch without imposing a hard catalogue cut.
    seen_topics: set[str] = set()
    diverse: list[tuple[dict, dict]] = []
    repeats: list[tuple[dict, dict]] = []
    for pair in rows:
        topic = _topic_family(pair[0])
        if topic and topic not in seen_topics:
            seen_topics.add(topic)
            diverse.append(pair)
        else:
            repeats.append(pair)
    return diverse + repeats


def generate_recommendation_pool(
    data: dict,
    *,
    max_items: int | None = None,
    history: dict[str, list[list[float]]] | None = None,
) -> list[dict]:
    """Pure deterministic evidence-led generation used by tests and callers."""
    target = DEFAULT_BROWSER_POOL_LIMIT if max_items is None else max(0, int(max_items))
    if target <= 0:
        return []
    feedback_profile = _build_feedback_profile(data)
    rows: list[dict] = []
    used_titles: set[str] = set()
    used_semantics: set[str] = set()
    used_concepts: set[str] = set()
    used_ids: dict[int, str] = {}
    for item, _source in _v3_candidates(data, feedback_profile, history):
        title_key = _title_fingerprint(item.get("title"))
        semantic_key = _semantic_fingerprint(item)
        concept_key = _concept_family(item)
        idea_key = str(item.get("_ideaKey") or "")
        reco_id = int(item["n"])
        if reco_id in used_ids and used_ids[reco_id] != idea_key:
            raise ValueError(f"stable recommendation id collision: {reco_id}")
        if title_key in used_titles or semantic_key in used_semantics or concept_key in used_concepts:
            continue
        used_ids[reco_id] = idea_key
        used_titles.add(title_key)
        used_semantics.add(semantic_key)
        used_concepts.add(concept_key)
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
        request = Request(location, headers={"User-Agent": "Lofi-Radar-Recommendation-Ledger/4"})
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
    if status in {"accepted", "accept", "validated", "valid", "x"}:
        return "X"
    if status in {"refused", "rejected", "reject", "-"}:
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
                updated["_feedbackEditedTitle"] = True
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
    if not math.isfinite(age) or age < 0:
        return None
    if age <= 3:
        return "0-3m"
    if age <= 6:
        return "3-6m"
    if age <= 12:
        return "6-12m"
    return "12m+"


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
        return {"title": {}, "genre": {}, "purpose": {}, "combo": {}}
    owned_counts = Counter(str(row.get("vid") or "") for row in data.get("ours") or [] if row.get("vid"))
    owned_by_id = {
        str(row.get("vid")): row
        for row in data.get("ours") or []
        if row.get("vid") and owned_counts[str(row.get("vid"))] == 1
    }
    entries_by_id = {int(entry["n"]): entry for entry in entries}
    buckets = {
        "title": defaultdict(list),
        "genre": defaultdict(list),
        "purpose": defaultdict(list),
        "combo": defaultdict(list),
    }
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
        # The linked proposal proves the publication relationship only. The
        # outcome belongs to the real Analyse row, whose actual title, genre
        # and purpose may deliberately contradict the old recommendation.
        owned_row = owned_by_id.get(published_video_id)
        if not owned_row:
            continue
        genre_key = _title_model_genre_key(owned_row)
        purpose_key = _purpose_key(owned_row)
        title_key = _title_fingerprint(owned_row.get("title"))
        if genre_key is None or not title_key:
            continue
        value = signals[published_video_id]
        buckets["title"][title_key].append(value)
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
        "modelRevision": str(payload.get("modelRevision") or ""),
        "ids": [int(row.get("n")) for row in payload.get("items") or []],
    }
    # Legacy checked-in payloads remain verifiable until the next refresh. Every
    # newly written payload includes this field, so a title recipe change always
    # invalidates browser caches even though recommendation IDs stay stable.
    if "titleRecipeVersion" in payload:
        identity["titleRecipeVersion"] = int(payload.get("titleRecipeVersion") or 0)
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def _model_revision(items: list[dict]) -> str:
    evidence = [
        {
            "n": int(item.get("n")),
            "title": str(item.get("title") or ""),
            "score": int(item.get("score") or 0),
            "style": str(item.get("_titleStyleKey") or ""),
            "sourceRecentVpm": item.get("_sourceRecentVpm"),
            "feedback": item.get("_feedbackAffinity"),
            "owned": item.get("_ownedGenreAffinity"),
        }
        for item in items
    ]
    canonical = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

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
    if output.exists():
        previous_feedback_t = int(read_recommendation_pool(output).get("feedbackT") or 0)
        current_feedback_t = int(feedback.get("t") or 0)
        if previous_feedback_t and current_feedback_t < previous_feedback_t:
            raise ValueError("recommendation feedback snapshot regressed; prior pool was preserved")
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
    decisions = _feedback_map(feedback)
    resolved_families = {
        str(entry.get("conceptFingerprint") or _concept_family(entry["item"]))
        for entry in entries
        if _feedback_valid(decisions.get(int(entry["n"])))
        and (entry.get("conceptFingerprint") or _concept_family(entry["item"]))
    }
    all_current_candidates = _v3_candidates(data, feedback_profile, history)
    existing_current_keys = {
        str(entry.get("ideaKey") or "")
        for entry in entries
        if int(entry.get("generatorVersion") or 0) == GENERATOR_VERSION
    }
    ranked_scope = all_current_candidates[:reserve_high_water] if reserve_high_water > 0 else all_current_candidates
    current_candidates: list[tuple[dict, dict]] = []
    for item, source in ranked_scope:
        idea_key = str(item.get("_ideaKey") or "")
        if idea_key in existing_current_keys or reserve_high_water > 0:
            current_candidates.append((item, source))
    pending_candidates: list[tuple[dict, dict]] = []
    pending_keys: set[str] = set()
    pending_titles: set[str] = set()
    pending_semantics: set[str] = set()
    pending_concepts: set[str] = set()
    for item, source in current_candidates:
        idea_key = str(item.get("_ideaKey") or "")
        concept_family = _concept_family(item)
        title_key = _title_fingerprint(item.get("title"))
        semantic_key = _semantic_fingerprint(item)
        if (
            not idea_key
            or idea_key in pending_keys
            or title_key in pending_titles
            or semantic_key in pending_semantics
            or concept_family in pending_concepts
            or _feedback_valid(decisions.get(int(item["n"])))
            or (concept_family and concept_family in resolved_families)
        ):
            continue
        pending_keys.add(idea_key)
        pending_titles.add(title_key)
        pending_semantics.add(semantic_key)
        pending_concepts.add(concept_family)
        pending_candidates.append((item, source))
    appended: list[dict] = []
    used_keys = {str(entry["ideaKey"]) for entry in entries}
    used_ids = {int(entry["n"]): str(entry["ideaKey"]) for entry in entries}
    for item, source in pending_candidates:
        idea_key = str(item["_ideaKey"])
        reco_id = int(item["n"])
        if idea_key in used_keys:
            continue
        if reco_id in used_ids and used_ids[reco_id] != idea_key:
            raise ValueError(f"stable recommendation id collision: {reco_id}")
        record = _ledger_record(item, source, created_ms=generated_ms, source_t=source_t)
        appended.append(record)
        used_keys.add(idea_key)
        used_ids[reco_id] = idea_key
    _append_ledger_records(ledger_dir, appended, generated_ms)
    if appended:
        entries.extend(appended)
    manifest = write_ledger_manifest(ledger_dir, generated_ms=generated_ms, source_t=source_t)
    selected: list[dict] = []
    selected_titles: set[str] = set()
    for current_item, _source in pending_candidates:
        item = _apply_feedback(_rehydrate_presentation(current_item), decisions.get(int(current_item["n"])))
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
        "modelRevision": _model_revision(selected),
        "ledger": {
            "total": len(entries),
            "pending": len(pending_candidates),
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
    items = generate_recommendation_pool(data, max_items=max_items, history=history)
    payload = {
        "schema": BROWSER_SCHEMA_VERSION,
        "t": int(generated_ms or time.time() * 1000),
        "sourceT": int(data.get("videoMetricsT") or 0),
        "feedbackT": 0,
        "version": GENERATOR_VERSION,
        "titleRecipeVersion": TITLE_RECIPE_VERSION,
        "ledgerRevision": "",
        "modelRevision": _model_revision(items),
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
    if str(payload.get("modelRevision") or "") != _model_revision(items):
        raise ValueError("recommendation browser pool model revision is invalid")
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
        if int(item.get("_generatorVersion") or 0) != GENERATOR_VERSION:
            raise ValueError(f"legacy recommendation leaked into the active projection: {reco_id}")
        if not item.get("_ideaKey") or not item.get("_sourceVideoId") or not item.get("noteData"):
            raise ValueError(f"current recommendation lacks provenance: {reco_id}")
        if not item.get("_titleStyleKey") or not item.get("_conceptFamily"):
            raise ValueError(f"current recommendation lacks title-learning evidence: {reco_id}")
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
