#!/usr/bin/env python3
"""Merge a user-authorized, signed-in YouTube Posts scroll into the snapshot.

The browser export contains only fields visibly rendered on the official
@LofiGirl Posts page. It never contains cookies, tokens, Studio analytics, or
private counters. The import is append-only and keeps missing values as null.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import collect_public_history as collector
except ImportError:
    # This importer only reuses the collector's pure normalization/validation
    # helpers. It does not need yt-dlp or any network extractor.
    sys.modules.pop("collect_public_history", None)
    yt_dlp = types.ModuleType("yt_dlp")
    yt_dlp.YoutubeDL = object
    yt_dlp.version = types.SimpleNamespace(__version__="browser-import")
    extractor = types.ModuleType("yt_dlp.extractor")
    youtube = types.ModuleType("yt_dlp.extractor.youtube")
    youtube.YoutubeTabIE = object
    utils = types.ModuleType("yt_dlp.utils")
    utils.parse_count = lambda value: None
    sys.modules.update(
        {
            "yt_dlp": yt_dlp,
            "yt_dlp.extractor": extractor,
            "yt_dlp.extractor.youtube": youtube,
            "yt_dlp.utils": utils,
        }
    )
    import collect_public_history as collector


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = ROOT / "data" / "public-history.json"
EXPECTED_URL = "https://www.youtube.com/@LofiGirl/posts"
POST_ID_PATTERN = re.compile(r"Ug[A-Za-z0-9_-]+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Importe le scroll propriétaire autorisé de l’onglet Posts Lofi Girl."
    )
    parser.add_argument("export", type=Path, help="Export JSON créé depuis le navigateur.")
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=DEFAULT_SNAPSHOT,
        help="Snapshot à enrichir (défaut : data/public-history.json).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    export_path = args.export if args.export.is_absolute() else ROOT / args.export
    snapshot_path = (
        args.snapshot if args.snapshot.is_absolute() else ROOT / args.snapshot
    )
    export = load_export(export_path)
    snapshot = collector.load_existing_snapshot(snapshot_path)
    imported_at = export["exportedAt"]

    posts_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for post in collector.load_existing_posts(snapshot):
        seeded = collector.seed_existing_observation_timestamps(
            post, snapshot.get("generatedAt")
        )
        posts_by_key[(seeded["platform"], seeded["externalId"])] = seeded

    accepted = 0
    ignored = 0
    for item in export["posts"]:
        normalized = normalize_exported_post(item, imported_at)
        if normalized is None:
            ignored += 1
            continue
        normalized = collector.mark_post_observed(normalized, imported_at)
        key = (normalized["platform"], normalized["externalId"])
        current = posts_by_key.get(key)
        posts_by_key[key] = (
            normalized if current is None else collector.merge_posts(current, normalized)
        )
        accepted += 1

    posts = collector.sort_posts(posts_by_key.values())
    coverage = merge_coverage(
        snapshot["coverage"],
        posts,
        export,
        accepted=accepted,
        ignored=ignored,
    )
    generated_at = max(snapshot["generatedAt"], imported_at)
    result = {"generatedAt": generated_at, "coverage": coverage, "posts": posts}
    collector.validate_snapshot(result, "all")
    write_atomic(snapshot_path, result)
    collector.print_summary(result, snapshot_path)
    print(
        f"Import navigateur : {accepted} post(s) Communauté accepté(s), "
        f"{ignored} pièce(s) jointe(s) hors périmètre ignorée(s)."
    )
    return 0


def load_export(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"export navigateur illisible : {path}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("l’export navigateur doit être un objet JSON")
    if payload.get("accountUrl") != EXPECTED_URL:
        raise RuntimeError("l’export ne provient pas de l’onglet Posts officiel Lofi Girl")
    if payload.get("channelHandle") != "@LofiGirl":
        raise RuntimeError("le handle de l’export navigateur n’est pas @LofiGirl")
    if payload.get("endReached") is not True:
        raise RuntimeError("le bas de l’onglet Posts n’a pas été atteint et vérifié")
    exported_at = payload.get("exportedAt")
    try:
        datetime.fromisoformat(str(exported_at).replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("exportedAt invalide") from error
    posts = payload.get("posts")
    if not isinstance(posts, list) or not posts:
        raise RuntimeError("l’export navigateur ne contient aucun post")
    declared_count = payload.get("renderedPostCount")
    if declared_count != len(posts):
        raise RuntimeError(
            f"compteur navigateur incohérent : {declared_count} annoncé(s), {len(posts)} exporté(s)"
        )
    return payload


def normalize_exported_post(
    item: Any, imported_at: str
) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        raise RuntimeError("un post de l’export navigateur n’est pas un objet")
    external_id = collector.clean_text(item.get("externalId"))
    if not external_id or not POST_ID_PATTERN.fullmatch(external_id):
        raise RuntimeError(f"identifiant de post YouTube invalide : {external_id}")
    text = collector.clean_text(item.get("text"))
    published_label = collector.clean_text(item.get("publishedLabel"))
    image_urls = valid_image_urls(item.get("imageUrls"))
    poll_choices = [
        choice
        for value in (item.get("pollChoices") or [])
        if (choice := collector.clean_text(value))
    ]
    attachment_kind = collector.clean_text(item.get("attachmentKind")) or "none"

    if len(poll_choices) >= 2:
        post_format = "community_poll"
    elif image_urls or attachment_kind == "image":
        post_format = "community_image"
    elif attachment_kind in {"none", "text"}:
        post_format = "community_text"
    else:
        # Community shares of long videos stay outside the product scope.
        return None

    likes = parse_public_count(item.get("likesLabel"))
    comments = parse_public_count(item.get("commentsLabel"))
    poll_votes = parse_public_count(item.get("pollVotesLabel"))
    metric_sources: dict[str, str] = {}
    if likes is not None:
        metric_sources["likes"] = "YouTube Posts rendered like count"
    if comments is not None:
        metric_sources["comments"] = "YouTube Posts rendered comment count"
    if poll_votes is not None:
        metric_sources["pollVotes"] = "YouTube Posts rendered poll vote count"

    return {
        "platform": "youtube",
        "externalId": external_id,
        "url": f"https://www.youtube.com/post/{external_id}",
        "title": text[:160] if text else None,
        "text": text,
        "format": post_format,
        "thumbnailUrl": image_urls[0] if image_urls else None,
        "publishedAt": approximate_published_at(published_label, imported_at),
        "views": None,
        "likes": likes,
        "comments": comments,
        "shares": None,
        "saves": None,
        "raw": {
            "collector": "authorized signed-in YouTube Posts scroll",
            "collectorVersion": "browser-v1",
            "collectionScopes": ["community", "owner-visible-scroll"],
            "publishedAtPrecision": "approximate" if published_label else None,
            "publicPublishedLabel": published_label,
            "communityImageCount": max(1, len(image_urls)) if post_format == "community_image" else 0,
            "pollChoices": poll_choices,
            "pollVotes": poll_votes,
            "metricSources": metric_sources,
        },
    }


def parse_public_count(value: Any) -> int | None:
    text = collector.clean_text(value)
    if not text:
        return None
    parsed = collector.parse_count(text)
    if isinstance(parsed, int) and parsed >= 0:
        return parsed
    match = re.search(r"([0-9][0-9\s.,]*)(?:\s*([kKmM]))?", text)
    if not match:
        return None
    raw_number = match.group(1).replace("\u202f", "").replace(" ", "")
    suffix = (match.group(2) or "").lower()
    if suffix:
        raw_number = raw_number.replace(",", ".")
        try:
            number = float(raw_number)
        except ValueError:
            return None
        return int(number * (1_000 if suffix == "k" else 1_000_000))
    digits = re.sub(r"\D", "", raw_number)
    return int(digits) if digits else None


def approximate_published_at(label: str | None, observed_at: str) -> str | None:
    if not label:
        return None
    observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    normalized = label.casefold().replace("’", "'")
    patterns = (
        (r"(?:il y a\s+)?(\d+|un|une)\s*minute", "minutes"),
        (r"(?:il y a\s+)?(\d+|un|une)\s*heure", "hours"),
        (r"(?:il y a\s+)?(\d+|un|une)\s*jour", "days"),
        (r"(?:il y a\s+)?(\d+|un|une)\s*semaine", "weeks"),
        (r"(?:il y a\s+)?(\d+|un|une)\s*mois", "months"),
        (r"(?:il y a\s+)?(\d+|un|une)\s*(?:an|année)", "years"),
        (r"(\d+|one)\s*minute", "minutes"),
        (r"(\d+|one)\s*hour", "hours"),
        (r"(\d+|one)\s*day", "days"),
        (r"(\d+|one)\s*week", "weeks"),
        (r"(\d+|one)\s*month", "months"),
        (r"(\d+|one)\s*year", "years"),
    )
    for pattern, unit in patterns:
        match = re.search(pattern, normalized)
        if not match:
            continue
        count = 1 if match.group(1) in {"un", "une", "one"} else int(match.group(1))
        delta = {
            "minutes": timedelta(minutes=count),
            "hours": timedelta(hours=count),
            "days": timedelta(days=count),
            "weeks": timedelta(weeks=count),
            "months": timedelta(days=30 * count),
            "years": timedelta(days=365 * count),
        }[unit]
        return (observed - delta).astimezone(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
    return None


def valid_image_urls(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    allowed_hosts = (
        "https://yt3.ggpht.com/",
        "https://yt3.googleusercontent.com/",
        "https://i.ytimg.com/",
        "https://lh3.googleusercontent.com/",
    )
    unique: list[str] = []
    for item in value:
        url = collector.clean_text(item)
        if url and url.startswith(allowed_hosts) and url not in unique:
            unique.append(url)
    return unique


def merge_coverage(
    existing: list[dict[str, Any]],
    posts: list[dict[str, Any]],
    export: dict[str, Any],
    *,
    accepted: int,
    ignored: int,
) -> list[dict[str, Any]]:
    youtube_posts = [post for post in posts if post["platform"] == "youtube"]
    dated = sorted(
        post["publishedAt"]
        for post in youtube_posts
        if post.get("publishedAt") is not None
    )
    previous = next(
        (item for item in existing if item.get("platform") == "youtube"), {}
    )
    limitations = list(previous.get("limitations") or [])
    limitations.extend(
        [
            f"Scroll propriétaire autorisé arrivé au bas de l’onglet Posts après {export['renderedPostCount']} cartes rendues.",
            f"{accepted} posts Communauté visibles ont été fusionnés ; {ignored} partage(s) de vidéo longue ou pièce(s) jointe(s) hors périmètre ont été ignoré(s).",
            "Cette couverture certifie la fin de la liste visible dans la session au moment du relevé, pas les contenus supprimés, privés, archivés ou réservés aux membres.",
        ]
    )
    youtube_coverage = {
        "platform": "youtube",
        "accountUrl": "https://www.youtube.com/@LofiGirl",
        "scope": "shorts + community posts",
        "status": "limited",
        "itemCount": len(youtube_posts),
        "oldestPublishedAt": dated[0] if dated else None,
        "newestPublishedAt": dated[-1] if dated else None,
        "limitations": list(dict.fromkeys(limitations)),
    }
    return [
        youtube_coverage if item.get("platform") == "youtube" else item
        for item in existing
    ]


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
