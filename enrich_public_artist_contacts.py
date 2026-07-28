#!/usr/bin/env python3
"""Find explicitly published professional e-mails on known official artist pages.

This is deliberately a narrow enrichment pass. It never discovers profiles,
never guesses an address and never contacts anyone. It follows only public
HTTP(S) URLs already returned by Soundcharts for strict, verified A&R artists,
plus artists explicitly placed in the manually curated Selection workflow. That
Selection exception does not promote an artist into automatic A&R results.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping


PREFIX = "window.SPOTIFY_SOUNDCHARTS="
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}", re.I)
BUSINESS_RE = re.compile(r"\b(contact|booking|bookings|management|manager|press|media|business|licen[cs]|label|inquir(?:y|ies)|demo)\b", re.I)
MAX_BYTES = 250_000
USER_AGENT = "LofiRadarContactResearch/1.0 (+https://dim75017.github.io/youtube-radar-kx9v2m/)"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_payload(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith(PREFIX):
        raise ValueError(f"{path} is not a Soundcharts payload")
    value = raw[len(PREFIX):].strip().removesuffix(";")
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("Soundcharts payload must be an object")
    return parsed


def write_payload(path: Path, value: dict[str, Any]) -> None:
    path.write_text(PREFIX + json.dumps(value, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")


def field(row: Any, schema: list[str], name: str) -> Any:
    if isinstance(row, Mapping):
        return row.get(name)
    try:
        return row[schema.index(name)] if isinstance(row, list) else None
    except ValueError:
        return None


def set_field(row: list[Any], schema: list[str], name: str, value: Any) -> None:
    if name not in schema:
        schema.append(name)
        for target in _artist_rows:
            while len(target) < len(schema):
                target.append(None)
    index = schema.index(name)
    while len(row) <= index:
        row.append(None)
    row[index] = value


_artist_rows: list[list[Any]] = []


def is_public_target(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)}
    except OSError:
        return False
    for address in addresses:
        try:
            value = ipaddress.ip_address(address)
        except ValueError:
            return False
        if value.is_private or value.is_loopback or value.is_link_local or value.is_reserved or value.is_multicast:
            return False
    return True


def fetch_html(url: str) -> str:
    if not is_public_target(url):
        return ""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            final_url = response.geturl()
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if not is_public_target(final_url) or "html" not in content_type:
                return ""
            return response.read(MAX_BYTES + 1)[:MAX_BYTES].decode("utf-8", errors="replace")
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return ""


def business_emails(page: str) -> list[str]:
    text = html.unescape(page or "")
    found: list[str] = []
    for match in EMAIL_RE.finditer(text):
        email = match.group(0).lower()
        # Evaluate the element containing the address, rather than a broad
        # page window where an unrelated "booking" label could be nearby.
        start = text.rfind(">", 0, match.start()) + 1
        end = text.find("<", match.end())
        around = text[start:end if end >= 0 else len(text)]
        local = email.split("@", 1)[0]
        if BUSINESS_RE.search(around) or local.startswith(("contact", "booking", "bookings", "mgmt", "management", "press", "hello", "info", "demo", "licensing")):
            if email not in found:
                found.append(email)
    return found


def strict_artist_ids(payload: dict[str, Any]) -> set[str]:
    schemas = payload.get("schemas") if isinstance(payload.get("schemas"), dict) else {}
    schema = schemas.get("opportunities") if isinstance(schemas.get("opportunities"), list) else []
    rows = payload.get("opportunities") if isinstance(payload.get("opportunities"), list) else []
    ids: set[str] = set()
    for row in rows:
        if str(field(row, schema, "opportunity_status") or "").casefold() != "verified":
            continue
        if str(field(row, schema, "instrumental_status") or "").casefold() != "instrumental":
            continue
        if str(field(row, schema, "ai_risk") or "").casefold() != "low":
            continue
        if str(field(row, schema, "rights_status") or "").casefold() not in {"self_released", "independent_label"}:
            continue
        for artist in field(row, schema, "artists") if isinstance(field(row, schema, "artists"), list) else []:
            if isinstance(artist, Mapping) and artist.get("soundcharts_uuid"):
                ids.add(str(artist["soundcharts_uuid"]))
    return ids


def profile_urls(value: Any, fallback: Any, limit: int) -> list[str]:
    urls: list[str] = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, Mapping):
            raw = str(item.get("url") or "").strip()
            if raw and raw not in urls:
                urls.append(raw)
    raw = str(fallback or "").strip()
    if raw and raw not in urls:
        urls.append(raw)
    return urls[:max(0, limit)]


def selected_artist_ids(path: Path | None) -> tuple[set[str], set[str]]:
    if path is None or not path.exists():
        return set(), set()
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("artists") if isinstance(payload, Mapping) else payload
    if not isinstance(rows, list):
        return set(), set()
    spotify_ids = {
        str(row.get("spotify_id") or "").strip()
        for row in rows if isinstance(row, Mapping)
        if str(row.get("spotify_id") or "").strip()
    }
    soundcharts_ids = {
        str(row.get("soundcharts_uuid") or "").strip()
        for row in rows if isinstance(row, Mapping)
        if str(row.get("soundcharts_uuid") or "").strip()
    }
    return spotify_ids, soundcharts_ids


def selected_spotify_ids(path: Path | None) -> set[str]:
    return selected_artist_ids(path)[0]


def enrich(
    payload: dict[str, Any],
    cache: dict[str, Any],
    max_artists: int,
    max_profiles: int,
    priority_spotify_ids: set[str] | None = None,
    priority_soundcharts_ids: set[str] | None = None,
) -> dict[str, int]:
    global _artist_rows
    schemas = payload.setdefault("schemas", {})
    artist_schema = schemas.get("artists") if isinstance(schemas.get("artists"), list) else []
    schemas["artists"] = artist_schema
    raw_rows = payload.get("artists") if isinstance(payload.get("artists"), list) else []
    _artist_rows = [row for row in raw_rows if isinstance(row, list)]
    priority_spotify_ids = priority_spotify_ids or set()
    priority_uuids = set(priority_soundcharts_ids or set()) | {
        str(field(row, artist_schema, "soundcharts_uuid") or "")
        for row in _artist_rows
        if str(field(row, artist_schema, "spotify_id") or "") in priority_spotify_ids
    }
    allowed = strict_artist_ids(payload) | priority_uuids
    cache_artists = cache.setdefault("artists", {}) if isinstance(cache, dict) else {}
    processed = found = 0
    ordered_rows = sorted(
        _artist_rows,
        key=lambda row: 0 if str(field(row, artist_schema, "soundcharts_uuid") or "") in priority_uuids else 1,
    )
    for row in ordered_rows:
        uuid = str(field(row, artist_schema, "soundcharts_uuid") or "")
        if not uuid or uuid not in allowed or processed >= max_artists:
            continue
        existing = str(field(row, artist_schema, "email") or "").strip()
        research = field(row, artist_schema, "contact_research")
        if existing or (
            uuid not in priority_uuids
            and isinstance(research, Mapping)
            and research.get("checked_at")
        ):
            continue
        urls = profile_urls(field(row, artist_schema, "public_contacts"), field(row, artist_schema, "contact_url"), max_profiles)
        processed += 1
        email = ""
        checked: list[str] = []
        for url in urls:
            checked.append(url)
            emails = business_emails(fetch_html(url))
            if emails:
                email = emails[0]
                break
        if email:
            result = "email_found"
        elif checked:
            result = "no_public_business_email"
        else:
            result = "no_known_public_profile"
        record = {"checked_at": now(), "sources_checked": checked, "result": result}
        set_field(row, artist_schema, "contact_research", record)
        cached = cache_artists.setdefault(uuid, {}) if isinstance(cache_artists, dict) else {}
        if isinstance(cached, dict):
            cached["contact_research"] = record
        if email:
            set_field(row, artist_schema, "email", email)
            if isinstance(cached, dict):
                cached["public_email"] = email
            found += 1
    return {"artists_checked": processed, "emails_found": found}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soundcharts", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--max-artists", type=int, default=10)
    parser.add_argument("--max-profiles-per-artist", type=int, default=4)
    parser.add_argument("--priority-artists", type=Path)
    args = parser.parse_args()
    payload = read_payload(args.soundcharts)
    cache = json.loads(args.cache.read_text(encoding="utf-8")) if args.cache.exists() else {}
    priority_spotify_ids, priority_soundcharts_ids = selected_artist_ids(args.priority_artists)
    result = enrich(
        payload,
        cache,
        max(0, args.max_artists),
        max(0, args.max_profiles_per_artist),
        priority_spotify_ids,
        priority_soundcharts_ids,
    )
    write_payload(args.soundcharts, payload)
    args.cache.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
