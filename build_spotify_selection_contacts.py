#!/usr/bin/env python3
"""Build the public-contact directory used only by Spotify Selection.

The exporter never guesses a profile or an e-mail address. It publishes only
public URLs returned by Soundcharts or explicit, source-backed overrides.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any, Mapping


PREFIX = "window.SPOTIFY_SELECTION_CONTACTS="
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}", re.I)
PLATFORM_PRIORITY = {
    "email": -1,
    "website": 0,
    "instagram": 1,
    "bandcamp": 2,
    "soundcloud": 3,
    "tiktok": 4,
    "youtube": 5,
    "facebook": 6,
    "twitter": 7,
    "x": 7,
}


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    value = json.loads(path.read_text(encoding="utf-8"))
    return value


def safe_url(value: Any) -> str:
    raw = str(value or "").strip()
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return ""
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        return ""
    hostname = parsed.hostname.casefold()
    if hostname == "localhost" or hostname.endswith(".local"):
        return ""
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
    ):
        return ""
    return raw


def safe_email(value: Any) -> str:
    raw = str(value or "").strip().casefold()
    return raw if EMAIL_RE.fullmatch(raw) else ""


def canonical_url_key(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    host = str(parsed.hostname or "").casefold().removeprefix("www.")
    path = (parsed.path.rstrip("/") or "/").casefold()
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{host}{path}{query}"


def platform_from_url(value: str) -> str:
    host = urllib.parse.urlparse(value).netloc.casefold()
    if "instagram." in host:
        return "instagram"
    if "bandcamp." in host:
        return "bandcamp"
    if "soundcloud." in host:
        return "soundcloud"
    if "youtube." in host or "youtu.be" in host:
        return "youtube"
    if "tiktok." in host:
        return "tiktok"
    if "facebook." in host:
        return "facebook"
    if "twitter." in host or host.endswith("x.com"):
        return "x"
    return "website"


def priority_rows(payload: Any) -> list[Mapping[str, Any]]:
    if isinstance(payload, Mapping):
        payload = payload.get("artists")
    return [row for row in payload if isinstance(row, Mapping)] if isinstance(payload, list) else []


def override_map(payload: Any) -> dict[str, Mapping[str, Any]]:
    rows = priority_rows(payload)
    return {
        str(row.get("spotify_id") or "").strip(): row
        for row in rows
        if str(row.get("spotify_id") or "").strip()
    }


def public_channels(entry: Mapping[str, Any], override: Mapping[str, Any]) -> list[dict[str, str]]:
    channels: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    excluded = {
        canonical_url_key(clean)
        for value in override.get("exclude_urls", [])
        if (clean := safe_url(value))
    }

    def add(platform: Any, url: Any) -> None:
        clean = safe_url(url)
        if not clean or canonical_url_key(clean) in excluded:
            return
        code = str(platform or "").strip().casefold() or platform_from_url(clean)
        key = (code, canonical_url_key(clean))
        if key in seen:
            return
        seen.add(key)
        channels.append({"platform": code, "url": clean})

    override_is_sourced = any(safe_url(value) for value in override.get("sources_checked", []))
    override_channels = override.get("channels") if override_is_sourced else []
    for source in (entry.get("public_contacts"), override_channels):
        for row in source if isinstance(source, list) else []:
            if isinstance(row, Mapping):
                add(row.get("platform"), row.get("url"))
    add(entry.get("contact_platform"), entry.get("contact_url"))
    if override_is_sourced:
        add(override.get("contact_platform"), override.get("contact_url"))
    channels.sort(key=lambda row: (PLATFORM_PRIORITY.get(row["platform"], 50), row["url"].casefold()))
    return channels


def build_directory(cache: Mapping[str, Any], priorities: Any, overrides: Any) -> dict[str, Any]:
    priority_by_spotify = {
        str(row.get("spotify_id") or "").strip(): row
        for row in priority_rows(priorities)
        if str(row.get("spotify_id") or "").strip()
    }
    overrides_by_spotify = override_map(overrides)
    raw_artists = cache.get("artists") if isinstance(cache.get("artists"), Mapping) else {}
    artists: dict[str, dict[str, Any]] = {}

    def make_record(
        spotify_id: str,
        soundcharts_uuid: str,
        raw: Mapping[str, Any],
        priority: Mapping[str, Any],
        override: Mapping[str, Any],
    ) -> dict[str, Any]:
        channels = public_channels(raw, override)
        research = raw.get("contact_research") if isinstance(raw.get("contact_research"), Mapping) else {}
        sources: list[str] = []
        for value in list(research.get("sources_checked") or []) + list(override.get("sources_checked") or []):
            clean = safe_url(value)
            if clean and clean not in sources:
                sources.append(clean)
        override_email = safe_email(override.get("email")) if sources else ""
        email = override_email or safe_email(raw.get("email") or raw.get("public_email"))
        contact_checks = [
            str(value)
            for value in (override.get("checked_at"), research.get("checked_at"))
            if value
        ]
        checked_at = max(contact_checks, default=str(raw.get("identifiers_fetched_at") or ""))
        forced_status = str(override.get("scan_status") or "").strip()
        if email:
            scan_status = "email_found"
        elif channels:
            scan_status = "public_channel_found"
        elif forced_status in {"no_public_contact_found", "pending"}:
            scan_status = forced_status
        elif research.get("checked_at"):
            scan_status = "no_public_contact_found"
        else:
            scan_status = "pending"
        return {
            "spotify_id": spotify_id,
            "soundcharts_uuid": str(soundcharts_uuid),
            "name": str(override.get("name") or priority.get("name") or raw.get("name") or "").strip(),
            "email": email,
            "channels": channels,
            "scan_status": scan_status,
            "checked_at": checked_at,
            "sources_checked": sources,
            "priority": spotify_id in priority_by_spotify,
            "source": "verified_override" if override else "soundcharts_public_identifiers",
        }

    def add_record(record: dict[str, Any]) -> None:
        spotify_id = record["spotify_id"]
        artists[spotify_id] = record

    for soundcharts_uuid, raw in raw_artists.items():
        if not isinstance(raw, Mapping):
            continue
        spotify_id = str(raw.get("spotify_id") or "").strip()
        if not spotify_id:
            continue
        priority = priority_by_spotify.get(spotify_id, {})
        override = overrides_by_spotify.get(spotify_id, {})
        add_record(make_record(spotify_id, str(soundcharts_uuid), raw, priority, override))

    # A newly selected artist must be visible as pending even if the restored
    # cache does not contain it yet. The seed only identifies the dossier; it
    # never fabricates a contact channel.
    for spotify_id, priority in priority_by_spotify.items():
        if spotify_id in artists:
            continue
        soundcharts_uuid = str(priority.get("soundcharts_uuid") or "").strip()
        raw = raw_artists.get(soundcharts_uuid, {}) if soundcharts_uuid else {}
        raw = raw if isinstance(raw, Mapping) else {}
        override = overrides_by_spotify.get(spotify_id, {})
        add_record(make_record(spotify_id, soundcharts_uuid, raw, priority, override))

    records = list(artists.values())
    stats = {
        "artists": len(records),
        "with_email": sum(bool(record["email"]) for record in records),
        "with_public_channel": sum(bool(record["channels"]) for record in records),
        "without_public_contact": sum(record["scan_status"] == "no_public_contact_found" for record in records),
        "priority_artists": sum(bool(record["priority"]) for record in records),
    }
    updated_markers = [
        str(source.get("updated_at") or "")
        for source in (cache, priorities, overrides)
        if isinstance(source, Mapping)
    ]

    return {
        "version": 1,
        "generated_at": max(updated_markers, default=""),
        "source": "Soundcharts public artist identifiers and explicitly published professional contacts",
        "stats": stats,
        "artists": artists,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--priority-artists", type=Path, required=True)
    parser.add_argument("--overrides", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cache = load_json(args.cache, {})
    if not isinstance(cache, Mapping):
        raise ValueError("Soundcharts cache must be an object")
    result = build_directory(cache, load_json(args.priority_artists, {}), load_json(args.overrides, {}))
    args.output.write_text(PREFIX + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(json.dumps(result["stats"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
