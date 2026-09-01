#!/usr/bin/env python3
"""Collect a reproducible public-history snapshot for Lofi Girl social accounts.

The collector intentionally uses only public profile/listing pages. It does not
read browser cookies, API keys, OAuth tokens, or private analytics. Missing
fields remain null, and TikTok thumbnails are intentionally omitted because the
public URLs returned by the platform are signed and expire.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
YTDLP_VENDOR = ROOT / "work" / "ytdeps"
DEFAULT_OUTPUT = ROOT / "data" / "public-history.json"

if not YTDLP_VENDOR.is_dir():
    raise SystemExit(
        "yt-dlp est absent de work/ytdeps. Prépare cette dépendance avant la collecte."
    )
sys.path.insert(0, str(YTDLP_VENDOR))

from yt_dlp import YoutubeDL, version as yt_dlp_version  # noqa: E402
from yt_dlp.extractor.youtube import YoutubeTabIE  # noqa: E402
from yt_dlp.utils import parse_count  # noqa: E402


YOUTUBE_CHANNEL_ID = "UCSJ4gkVC6NrvII8umztf0Ow"
TIKTOK_HANDLE = "lofigirl"

SOURCES = (
    {
        "platform": "youtube",
        "scope": "shorts",
        "accountUrl": "https://www.youtube.com/@LofiGirl/shorts",
    },
    {
        "platform": "youtube",
        "scope": "community",
        "accountUrl": "https://www.youtube.com/@LofiGirl/community",
    },
    {
        "platform": "tiktok",
        "scope": "profile",
        "accountUrl": "https://www.tiktok.com/@lofigirl",
    },
)

STATIC_COVERAGE = (
    {
        "platform": "instagram",
        "accountUrl": "https://www.instagram.com/lofigirl/",
        "scope": "historical catalog",
        "status": "unavailable",
        "itemCount": 0,
        "oldestPublishedAt": None,
        "newestPublishedAt": None,
        "limitations": [
            "La page officielle déclare 1 673 publications au relevé du 4 août 2026.",
            "Le catalogue historique n’est pas récupérable de façon reproductible sans authentification et autorisations Meta.",
            "Aucun post ni aucune métrique Instagram ne sont ajoutés à ce snapshot pour éviter de simuler une couverture inexistante.",
        ],
    },
    {
        "platform": "x",
        "accountUrl": "https://x.com/lofigirl",
        "scope": "historical backfill",
        "status": "limited",
        "itemCount": 0,
        "oldestPublishedAt": None,
        "newestPublishedAt": None,
        "limitations": [
            "Le snapshot récent du rendu serveur public est collecté par le scanner temps réel et doit être fusionné séparément.",
            "Un historique complet et reproductible exige l’API X ou une archive de compte autorisée.",
            "Aucun post X n’est dupliqué dans ce backfill historique.",
        ],
    },
)

BASE_LIMITATIONS = {
    "youtube": [
        "Périmètre volontairement limité aux Shorts et aux posts Communauté publics de la chaîne ; les vidéos longues et les lives sont exclus.",
        "Inventaire issu des onglets publics de la chaîne, sans YouTube Studio ni Analytics propriétaire.",
        "Les contenus privés, supprimés, réservés aux membres ou non listés ne sont pas accessibles.",
        "Les dates YouTube sont approximées par yt-dlp depuis les libellés relatifs des onglets publics.",
        "Les listes publiques exposent les vues des Shorts et les likes des posts Communauté, mais pas de façon fiable les commentaires, partages, sauvegardes, impressions, rétention ou abonnements générés.",
        "Les commentaires publiés par le compte Lofi Girl sont ajoutés lorsqu’un export propriétaire autorisé est disponible ; chaque commentaire conserve son lien YouTube public.",
        "Le tableau posts est dédupliqué par identifiant public YouTube.",
    ],
    "tiktok": [
        "Inventaire limité à ce que le profil public TikTok livre à yt-dlp au moment de la collecte ; l’exhaustivité historique n’est pas garantie.",
        "TikTok peut réduire ou bloquer la pagination publique sans préavis.",
        "Les miniatures TikTok sont volontairement omises car leurs URL publiques sont signées et expirent.",
        "Les métriques et dates absentes de la réponse publique restent nulles.",
    ],
}

SENSITIVE_KEY_PATTERN = re.compile(
    r"(?:cookie|authorization|access[_-]?token|refresh[_-]?token|password|secret)",
    re.IGNORECASE,
)
SIGNED_TIKTOK_PATTERN = re.compile(
    r"(?:x-signature|x-expires|x-bogus|signature=|token=)", re.IGNORECASE
)
METRIC_FIELDS = ("views", "likes", "comments", "shares", "saves")
PROFILE_ONLY_COVERAGE_PLATFORMS = {"instagram", "tiktok"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collecte l’historique public YouTube et TikTok de Lofi Girl."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Chemin du snapshot JSON (défaut: data/public-history.json).",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=0,
        help="Limite par source pour un contrôle rapide ; 0 collecte toute la pagination publique.",
    )
    parser.add_argument(
        "--platform",
        choices=("all", "youtube", "tiktok"),
        default="all",
        help="Restreint la collecte à une plateforme.",
    )
    args = parser.parse_args()
    if args.max_items < 0:
        parser.error("--max-items doit être positif ou nul.")
    return args


def main() -> int:
    args = parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    collected_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    selected_sources = [
        source
        for source in SOURCES
        if args.platform == "all" or source["platform"] == args.platform
    ]
    selected_platforms = {source["platform"] for source in selected_sources}

    existing_snapshot = load_existing_snapshot(output)
    posts_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    existing_posts = load_existing_posts(existing_snapshot)
    for post in existing_posts:
        preserved_post = (
            seed_existing_observation_timestamps(
                post, existing_snapshot.get("generatedAt")
            )
            if post["platform"] in selected_platforms
            and post_counts_toward_coverage(post)
            else json.loads(json.dumps(post, ensure_ascii=False))
        )
        posts_by_key[(post["platform"], post["externalId"])] = preserved_post
    existing_keys = {
        key
        for key, post in posts_by_key.items()
        if key[0] in selected_platforms and post_counts_toward_coverage(post)
    }
    observed_keys: set[tuple[str, str]] = set()
    source_coverages: list[dict[str, Any]] = []

    for source in selected_sources:
        scope_posts, source_coverage = collect_source(source, args.max_items)
        source_coverages.append(source_coverage)
        for post in scope_posts:
            post = mark_post_observed(post, collected_at)
            key = (post["platform"], post["externalId"])
            observed_keys.add(key)
            current = posts_by_key.get(key)
            posts_by_key[key] = post if current is None else merge_posts(current, post)

    posts = sort_posts(posts_by_key.values())
    coverage = aggregate_coverage(
        source_coverages, posts, args.platform, limited_by_argument=bool(args.max_items)
    )
    coverage = merge_coverage_with_existing(
        coverage,
        existing_snapshot,
        selected_platforms,
        preserve_unselected=args.platform != "all",
    )
    preserved_only: dict[str, int] = {}
    for platform, _external_id in existing_keys - observed_keys:
        preserved_only[platform] = preserved_only.get(platform, 0) + 1
    for item in coverage:
        preserved_count = preserved_only.get(item["platform"], 0)
        if preserved_count:
            item["limitations"].append(
                f"Snapshot cumulatif append-only : {preserved_count} contenu(s) observé(s) lors de relevés antérieurs sont conservés même s’ils ne figurent plus dans la fenêtre publique courante."
            )
    snapshot = {
        "generatedAt": collected_at,
        "coverage": coverage,
        "posts": posts,
    }
    validate_snapshot(snapshot, args.platform)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.tmp")
    temporary.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(output)

    print_summary(snapshot, output)
    return 0


def load_existing_snapshot(output: Path) -> dict[str, Any]:
    """Charge le snapshot sans transformer une corruption en historique vide."""
    if not output.is_file():
        return {"coverage": [], "posts": []}
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"snapshot existant illisible, collecte interrompue sans écriture : {output}"
        ) from error
    if not isinstance(payload, dict):
        raise RuntimeError("le snapshot existant doit être un objet JSON")
    if not isinstance(payload.get("generatedAt"), str) or not payload["generatedAt"]:
        raise RuntimeError("le snapshot existant doit contenir generatedAt")
    posts = payload.get("posts")
    coverage = payload.get("coverage")
    if not isinstance(posts, list) or not isinstance(coverage, list):
        raise RuntimeError(
            "le snapshot existant doit contenir les tableaux posts et coverage"
        )
    for index, post in enumerate(posts):
        if (
            not isinstance(post, dict)
            or not isinstance(post.get("platform"), str)
            or not isinstance(post.get("externalId"), str)
            or not post["externalId"]
            or not isinstance(post.get("raw"), dict)
        ):
            raise RuntimeError(f"post existant invalide à l'index {index}")
    for index, item in enumerate(coverage):
        if not isinstance(item, dict) or not isinstance(item.get("platform"), str):
            raise RuntimeError(f"couverture existante invalide à l'index {index}")
    return payload


def load_existing_posts(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Conserve toutes les plateformes lors d'une collecte partielle append-only."""
    return list(snapshot["posts"])


def seed_existing_observation_timestamps(
    post: dict[str, Any], fallback: Any
) -> dict[str, Any]:
    """Migre un ancien snapshot sans faire paraître ses posts comme rescannés.

    Les valeurs déjà versionnées ont bien été observées à la date de génération
    du snapshot. On les conserve donc comme premier point réel, sans prétendre
    qu'il s'agit des métriques au lancement du contenu.
    """
    seeded = dict(post)
    raw = dict(post.get("raw") or {})
    if isinstance(fallback, str) and fallback:
        if not isinstance(raw.get("firstObservedAt"), str):
            raw["firstObservedAt"] = fallback
        if not isinstance(raw.get("lastObservedAt"), str):
            raw["lastObservedAt"] = fallback
    seeded["raw"] = raw
    history = normalize_metric_history(raw.get("metricHistory"))
    if not history and isinstance(fallback, str) and fallback:
        history = [metric_history_point(seeded, fallback)]
    raw["metricHistory"] = history
    return seeded


def mark_post_observed(post: dict[str, Any], observed_at: str) -> dict[str, Any]:
    """Horodate uniquement les contenus effectivement vus pendant ce relevé."""
    observed = dict(post)
    raw = dict(post.get("raw") or {})
    if not isinstance(raw.get("firstObservedAt"), str):
        raw["firstObservedAt"] = observed_at
    raw["lastObservedAt"] = observed_at
    observed["raw"] = raw
    raw["metricHistory"] = merge_metric_histories(
        raw.get("metricHistory"),
        [metric_history_point(observed, observed_at)],
    )
    return observed


def metric_history_point(post: dict[str, Any], captured_at: str) -> dict[str, Any]:
    """Crée un relevé factuel ; les signaux absents restent explicitement nuls."""
    raw = post.get("raw") if isinstance(post.get("raw"), dict) else {}
    point: dict[str, Any] = {
        "capturedAt": captured_at,
        **{field: nonnegative_int(post.get(field)) for field in METRIC_FIELDS},
        "pollVotes": nonnegative_int(raw.get("pollVotes")),
    }
    source = clean_text(raw.get("collector"))
    if source:
        point["source"] = source
    return point


def normalize_metric_history(value: Any) -> list[dict[str, Any]]:
    """Valide et déduplique une série sans transformer une corruption en vide."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise RuntimeError("metricHistory doit être un tableau")

    by_captured_at: dict[str, dict[str, Any]] = {}
    for entry in value:
        if not isinstance(entry, dict):
            raise RuntimeError("un point metricHistory n'est pas un objet")
        captured_at = entry.get("capturedAt")
        if not isinstance(captured_at, str) or not captured_at:
            raise RuntimeError("un point metricHistory n'a pas de capturedAt")
        current = by_captured_at.get(captured_at, {"capturedAt": captured_at})
        for field in (*METRIC_FIELDS, "pollVotes"):
            incoming = entry.get(field)
            if incoming is not None:
                current[field] = incoming
            elif field not in current:
                current[field] = None
        source = entry.get("source")
        if isinstance(source, str) and source:
            current["source"] = source
        by_captured_at[captured_at] = current
    return [by_captured_at[key] for key in sorted(by_captured_at)]


def merge_metric_histories(*values: Any) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for value in values:
        merged.extend(normalize_metric_history(value))
    return normalize_metric_history(merged)


def merge_coverage_with_existing(
    current: list[dict[str, Any]],
    existing_snapshot: dict[str, Any],
    selected_platforms: set[str],
    *,
    preserve_unselected: bool,
) -> list[dict[str, Any]]:
    """Remplace la couverture collectée sans effacer les autres plateformes."""
    merged = json.loads(json.dumps(current, ensure_ascii=False))
    if preserve_unselected:
        merged.extend(
            json.loads(
                json.dumps(
                    [
                        item
                        for item in existing_snapshot["coverage"]
                        if item["platform"] not in selected_platforms
                    ],
                    ensure_ascii=False,
                )
            )
        )
    return merged


def collect_source(
    source: dict[str, str], max_items: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    platform = source["platform"]
    scope = source["scope"]
    if platform == "youtube" and scope == "community":
        return collect_youtube_community(source, max_items)

    limitations = list(BASE_LIMITATIONS[platform])
    options = ydl_options(platform)
    if max_items:
        options["playlistend"] = max_items
        limitations.append(
            f"Collecte volontairement limitée à {max_items} éléments par source pour ce snapshot."
        )

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(source["accountUrl"], download=False)
        if not isinstance(info, dict):
            raise RuntimeError("la source n’a renvoyé aucune liste publique")
        verify_account(source, info)

        entries = list(flatten_entries(info.get("entries")))
        normalized = [
            post
            for entry in entries
            if (post := normalize_entry(platform, scope, entry)) is not None
        ]
        normalized = deduplicate_scope(normalized)

        if len(normalized) < len(entries):
            limitations.append(
                f"{len(entries) - len(normalized)} entrée(s) sans identifiant public exploitable ont été ignorées."
            )
        status = "available" if normalized else "empty"
        return normalized, coverage_record(source, status, normalized, limitations)
    except Exception as error:  # yt-dlp exposes several extractor-specific errors
        limitations.append(f"Collecte indisponible : {clean_error(error)}")
        return [], coverage_record(source, "unavailable", [], limitations)


def ydl_options(platform: str) -> dict[str, Any]:
    options: dict[str, Any] = {
        "skip_download": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "quiet": True,
        "no_warnings": True,
        "cachedir": False,
        "socket_timeout": 25,
        "retries": 2,
        "fragment_retries": 0,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/127.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    }
    if platform == "youtube":
        options["extractor_args"] = {
            "youtubetab": {"approximate_date": [""]}
        }
    return options


class YoutubeCommunityPostIE(YoutubeTabIE):
    """Expose public Community post renderers through yt-dlp pagination."""

    def _post_thread_entries(self, post_thread_renderer: dict[str, Any]):
        post = (
            ((post_thread_renderer.get("post") or {}).get("backstagePostRenderer"))
            or {}
        )
        if post.get("postId"):
            yield post


def collect_youtube_community(
    source: dict[str, str], max_items: int
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    limitations = list(BASE_LIMITATIONS["youtube"])
    limitations.append(
        "Les posts Communauté sont lus via la pagination publique interne de YouTube, car l’API Data v3 ne fournit pas de ressource Community Post."
    )
    if max_items:
        limitations.append(
            f"Collecte volontairement limitée à {max_items} éléments pour ce snapshot."
        )

    try:
        options = ydl_options("youtube")
        with YoutubeDL(options) as ydl:
            extractor = YoutubeCommunityPostIE(ydl)
            data, ytcfg = extractor._extract_data(
                source["accountUrl"], f"{YOUTUBE_CHANNEL_ID} community"
            )
            tabs = extractor._extract_tab_renderers(data)
            selected_tab = extractor._extract_selected_tab(tabs)
            tab_identifier = clean_text(selected_tab.get("tabIdentifier"))
            tab_title = clean_text(selected_tab.get("title"))
            if tab_identifier != "FEcommunity_page" and (
                not tab_title or "community" not in tab_title.casefold()
            ):
                raise RuntimeError(
                    f"onglet YouTube inattendu ({tab_identifier or tab_title or 'inconnu'})"
                )

            renderers = extractor._entries(
                selected_tab,
                f"{YOUTUBE_CHANNEL_ID} community",
                ytcfg,
                extractor._extract_delegated_session_id(ytcfg, data),
                extractor._extract_visitor_data(data, ytcfg),
            )
            normalized: list[dict[str, Any]] = []
            unsupported = 0
            for renderer in renderers:
                post = normalize_community_post(extractor, renderer)
                if post is None:
                    unsupported += 1
                else:
                    normalized.append(post)
                if max_items and len(normalized) >= max_items:
                    break

        normalized = deduplicate_scope(normalized)
        if unsupported:
            limitations.append(
                f"{unsupported} post(s) Communauté avec un format public non pris en charge ont été ignorés."
            )
        if normalized:
            format_counts: dict[str, int] = {}
            for post in normalized:
                post_format = post["format"]
                format_counts[post_format] = format_counts.get(post_format, 0) + 1
            limitations.append(
                "Formats Communauté récupérés : "
                + ", ".join(
                    f"{post_format}={count}"
                    for post_format, count in sorted(format_counts.items())
                )
                + "."
            )
            dated = sorted(
                post["publishedAt"]
                for post in normalized
                if post.get("publishedAt") is not None
            )
            limitations.append(
                f"La pagination publique s’est arrêtée après {len(normalized)} posts Communauté"
                + (f", le plus ancien étant daté approximativement du {dated[0]}" if dated else "")
                + " ; cela ne certifie pas l’absence de posts plus anciens."
            )
        status = "limited" if normalized else "empty"
        return normalized, coverage_record(source, status, normalized, limitations)
    except Exception as error:
        limitations.append(f"Collecte indisponible : {clean_error(error)}")
        return [], coverage_record(source, "unavailable", [], limitations)


def flatten_entries(entries: Any) -> Iterable[dict[str, Any]]:
    if entries is None:
        return
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        nested = entry.get("entries")
        if nested is not None:
            yield from flatten_entries(nested)
        else:
            yield entry


def verify_account(source: dict[str, str], info: dict[str, Any]) -> None:
    platform = source["platform"]
    if platform == "youtube":
        observed = first_text(
            info.get("channel_id"),
            info.get("uploader_id"),
            info.get("playlist_uploader_id"),
        )
        if observed and observed.startswith("UC") and observed != YOUTUBE_CHANNEL_ID:
            raise RuntimeError(
                f"identité YouTube inattendue ({observed}, attendu {YOUTUBE_CHANNEL_ID})"
            )
        return

    identity_evidence = [
        first_text(info.get("uploader_id"), info.get("channel_id")),
        clean_text(info.get("title")),
        first_text(info.get("webpage_url"), info.get("original_url")),
    ]
    normalized_evidence = [value.lower().lstrip("@") for value in identity_evidence if value]
    if normalized_evidence and not any("lofigirl" in value for value in normalized_evidence):
        raise RuntimeError(
            f"identité TikTok inattendue ({identity_evidence[0] or identity_evidence[1]}, attendu @{TIKTOK_HANDLE})"
        )


def normalize_community_post(
    extractor: YoutubeCommunityPostIE, renderer: dict[str, Any]
) -> dict[str, Any] | None:
    external_id = clean_text(renderer.get("postId"))
    if not external_id or not re.fullmatch(r"Ug[A-Za-z0-9_-]+", external_id):
        return None

    author_channel_id = first_text(
        (((renderer.get("authorEndpoint") or {}).get("profileCardCommand") or {}).get(
            "profileOwnerExternalChannelId"
        )),
        next(
            (
                (((run.get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get(
                    "browseId"
                ))
                for run in ((renderer.get("authorText") or {}).get("runs") or [])
                if isinstance(run, dict)
            ),
            None,
        ),
    )
    if author_channel_id and author_channel_id != YOUTUBE_CHANNEL_ID:
        raise RuntimeError(
            f"auteur Communauté inattendu ({author_channel_id}, attendu {YOUTUBE_CHANNEL_ID})"
        )

    attachment = renderer.get("backstageAttachment") or {}
    if not isinstance(attachment, dict):
        return None
    poll_renderer = attachment.get("pollRenderer")
    has_image = bool(
        attachment.get("backstageImageRenderer")
        or attachment.get("postMultiImageRenderer")
    )
    if isinstance(poll_renderer, dict):
        post_format = "community_poll"
    elif has_image:
        post_format = "community_image"
    elif not attachment:
        post_format = "community_text"
    else:
        # A Community post containing an attached long video is deliberately
        # not reclassified as a social post in this product scope.
        return None

    text = renderer_text(renderer.get("contentText"))
    published_label = renderer_text(renderer.get("publishedTimeText"))
    timestamp = (
        extractor._parse_time_text(published_label, report_failure=False)
        if published_label
        else None
    )
    published_at = (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
        if isinstance(timestamp, (int, float)) and timestamp > 0
        else None
    )

    likes = public_count(renderer.get("voteCount"))
    poll_choices = (
        [
            choice_text
            for choice in poll_renderer.get("choices") or []
            if isinstance(choice, dict)
            and (choice_text := renderer_text(choice.get("text"))) is not None
        ]
        if isinstance(poll_renderer, dict)
        else []
    )
    poll_votes = (
        public_count(poll_renderer.get("totalVotes"))
        if isinstance(poll_renderer, dict)
        else None
    )
    thumbnail_url, image_count = community_thumbnail(attachment)
    metric_sources = (
        {"likes": "YouTube Community voteCount public"} if likes is not None else {}
    )

    return {
        "platform": "youtube",
        "externalId": external_id,
        "url": f"https://www.youtube.com/post/{external_id}",
        "title": text[:160] if text else None,
        "text": text,
        "format": post_format,
        "thumbnailUrl": thumbnail_url,
        "publishedAt": published_at,
        "views": None,
        "likes": likes,
        "comments": None,
        "shares": None,
        "saves": None,
        "raw": {
            "collector": "yt-dlp YouTube public browse pagination",
            "collectorVersion": yt_dlp_version.__version__,
            "collectionScopes": ["community"],
            "publishedAtPrecision": "approximate" if published_at else None,
            "publicPublishedLabel": published_label,
            "communityImageCount": image_count,
            "pollChoices": poll_choices,
            "pollVotes": poll_votes,
            "metricSources": metric_sources,
        },
    }


def renderer_text(value: Any) -> str | None:
    if isinstance(value, str):
        return clean_text(value)
    if not isinstance(value, dict):
        return None
    simple_text = clean_text(value.get("simpleText"))
    if simple_text:
        return simple_text
    runs = value.get("runs")
    if not isinstance(runs, list):
        return None
    return clean_text(
        "".join(
            str(run.get("text") or "") for run in runs if isinstance(run, dict)
        )
    )


def public_count(value: Any) -> int | None:
    text = renderer_text(value)
    if not text and isinstance(value, dict):
        text = clean_text(
            (((value.get("accessibility") or {}).get("accessibilityData") or {}).get(
                "label"
            ))
        )
    parsed = parse_count(text) if text else None
    return parsed if isinstance(parsed, int) and parsed >= 0 else None


def community_thumbnail(attachment: dict[str, Any]) -> tuple[str | None, int]:
    image_renderers: list[dict[str, Any]] = []
    single_image = attachment.get("backstageImageRenderer")
    if isinstance(single_image, dict):
        image_renderers.append(single_image)
    multi_image = attachment.get("postMultiImageRenderer")
    if isinstance(multi_image, dict):
        for item in multi_image.get("images") or []:
            image_renderer = (
                item.get("backstageImageRenderer") if isinstance(item, dict) else None
            )
            if isinstance(image_renderer, dict):
                image_renderers.append(image_renderer)

    candidates: list[tuple[int, str]] = []
    for image_renderer in image_renderers:
        thumbnails = (image_renderer.get("image") or {}).get("thumbnails") or []
        for thumbnail in thumbnails:
            if not isinstance(thumbnail, dict):
                continue
            url = clean_text(thumbnail.get("url"))
            if not url:
                continue
            if url.startswith("//"):
                url = f"https:{url}"
            if not url.startswith("https://"):
                continue
            width = nonnegative_int(thumbnail.get("width")) or 0
            height = nonnegative_int(thumbnail.get("height")) or 0
            candidates.append((width * height, url))
    thumbnail_url = max(candidates, default=(0, None))[1]
    return thumbnail_url, len(image_renderers)


def normalize_entry(
    platform: str, scope: str, entry: dict[str, Any]
) -> dict[str, Any] | None:
    external_id = entry_id(platform, entry)
    if not external_id:
        return None

    availability = clean_text(entry.get("availability"))
    title = clean_text(entry.get("title"))
    if availability in {"private", "subscriber_only", "needs_auth"}:
        return None
    if title and title.casefold() in {"[private video]", "[deleted video]"}:
        return None

    description = clean_text(entry.get("description"))
    if platform == "youtube":
        if scope != "shorts":
            return None
        url = f"https://www.youtube.com/shorts/{external_id}"
        thumbnail_url = f"https://i.ytimg.com/vi/{external_id}/hqdefault.jpg"
        post_format = "short"
    else:
        url = f"https://www.tiktok.com/@{TIKTOK_HANDLE}/video/{external_id}"
        # Never persist TikTok CDN thumbnails: they include expiring signatures.
        thumbnail_url = None
        post_format = "video"

    published_at = entry_datetime(entry)
    views = nonnegative_int(entry.get("view_count"))
    likes = nonnegative_int(entry.get("like_count"))
    comments = nonnegative_int(entry.get("comment_count"))
    shares = nonnegative_int(
        entry.get("repost_count")
        if entry.get("repost_count") is not None
        else entry.get("share_count")
    )
    saves = nonnegative_int(
        entry.get("save_count")
        if entry.get("save_count") is not None
        else entry.get("collect_count")
    )
    metric_sources: dict[str, str] = {}
    if views is not None:
        metric_sources["views"] = "yt-dlp view_count"
    if likes is not None:
        metric_sources["likes"] = "yt-dlp like_count"
    if comments is not None:
        metric_sources["comments"] = "yt-dlp comment_count"
    if shares is not None:
        metric_sources["shares"] = "yt-dlp repost_count/share_count"
    if saves is not None:
        metric_sources["saves"] = (
            "yt-dlp save_count, normalisé depuis TikTok collectCount public"
            if platform == "tiktok"
            else "yt-dlp save_count/collect_count"
        )
    post = {
        "platform": platform,
        "externalId": external_id,
        "url": url,
        "title": title,
        "text": description or (title if platform == "tiktok" else None),
        "format": post_format,
        "thumbnailUrl": thumbnail_url,
        "publishedAt": published_at,
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "saves": saves,
        "raw": {
            "collector": "yt-dlp",
            "collectorVersion": yt_dlp_version.__version__,
            "collectionScopes": [scope],
            "durationSeconds": nonnegative_number(entry.get("duration")),
            "publishedAtPrecision": (
                "exact"
                if platform == "tiktok" or entry.get("release_timestamp") is not None
                else "approximate"
            )
            if published_at is not None
            else None,
            "liveStatus": clean_text(entry.get("live_status")),
            "availability": availability,
            "metricSources": metric_sources,
        },
    }
    return post


def entry_id(platform: str, entry: dict[str, Any]) -> str | None:
    value = clean_text(entry.get("id"))
    if value:
        if platform == "youtube" and re.fullmatch(r"[A-Za-z0-9_-]{6,20}", value):
            return value
        if platform == "tiktok" and value.isdigit():
            return value

    url = first_text(entry.get("webpage_url"), entry.get("url")) or ""
    pattern = (
        r"(?:v=|shorts/|youtu\.be/)([A-Za-z0-9_-]{6,20})"
        if platform == "youtube"
        else r"/video/(\d+)"
    )
    match = re.search(pattern, url)
    return match.group(1) if match else None


def entry_datetime(entry: dict[str, Any]) -> str | None:
    for key in ("release_timestamp", "timestamp", "modified_timestamp"):
        value = entry.get(key)
        if isinstance(value, (int, float)) and value > 0:
            try:
                return (
                    datetime.fromtimestamp(value, tz=timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
            except (OverflowError, OSError, ValueError):
                pass

    upload_date = clean_text(entry.get("upload_date"))
    if upload_date and re.fullmatch(r"\d{8}", upload_date):
        try:
            return (
                datetime.strptime(upload_date, "%Y%m%d")
                .replace(tzinfo=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except ValueError:
            return None
    return None


def deduplicate_scope(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for post in posts:
        key = (post["platform"], post["externalId"])
        unique[key] = post if key not in unique else merge_posts(unique[key], post)
    return list(unique.values())


def merge_posts(
    current: dict[str, Any], incoming: dict[str, Any]
) -> dict[str, Any]:
    merged = dict(current)
    for field in (
        "title",
        "text",
        "thumbnailUrl",
        "publishedAt",
        "views",
        "likes",
        "comments",
        "shares",
        "saves",
    ):
        current_value = merged.get(field)
        incoming_value = incoming.get(field)
        if current_value is None:
            merged[field] = incoming_value
        elif (
            field in {"views", "likes", "comments", "shares", "saves"}
            and isinstance(current_value, (int, float))
            and isinstance(incoming_value, (int, float))
        ):
            merged[field] = max(current_value, incoming_value)

    format_priority = {
        "community_text": 0,
        "community_image": 1,
        "community_poll": 2,
        "short": 3,
    }
    if format_priority.get(incoming["format"], 0) > format_priority.get(
        merged["format"], 0
    ):
        merged["format"] = incoming["format"]
        merged["url"] = incoming["url"]

    raw = dict(merged.get("raw") or {})
    incoming_raw = incoming.get("raw") or {}
    scopes = set(raw.get("collectionScopes") or [])
    scopes.update(incoming_raw.get("collectionScopes") or [])
    raw["collectionScopes"] = sorted(scopes)
    for key in (
        "collector",
        "collectorVersion",
        "durationSeconds",
        "publishedAtPrecision",
        "liveStatus",
        "availability",
        "publicPublishedLabel",
        "communityImageCount",
        "pollChoices",
    ):
        if raw.get(key) is None and incoming_raw.get(key) is not None:
            raw[key] = incoming_raw[key]
    metric_sources = raw.get("metricSources")
    incoming_metric_sources = incoming_raw.get("metricSources")
    if isinstance(metric_sources, dict) or isinstance(incoming_metric_sources, dict):
        merged_metric_sources = (
            dict(metric_sources) if isinstance(metric_sources, dict) else {}
        )
        if isinstance(incoming_metric_sources, dict):
            merged_metric_sources.update(incoming_metric_sources)
        raw["metricSources"] = merged_metric_sources
    raw["metricHistory"] = merge_metric_histories(
        raw.get("metricHistory"),
        incoming_raw.get("metricHistory"),
    )
    first_observed_values = [
        value
        for value in (
            raw.get("firstObservedAt"),
            incoming_raw.get("firstObservedAt"),
        )
        if isinstance(value, str) and value
    ]
    last_observed_values = [
        value
        for value in (
            raw.get("lastObservedAt"),
            incoming_raw.get("lastObservedAt"),
        )
        if isinstance(value, str) and value
    ]
    if first_observed_values:
        raw["firstObservedAt"] = min(first_observed_values)
    if last_observed_values:
        raw["lastObservedAt"] = max(last_observed_values)
    current_poll_votes = nonnegative_int(raw.get("pollVotes"))
    incoming_poll_votes = nonnegative_int(incoming_raw.get("pollVotes"))
    if current_poll_votes is None:
        raw["pollVotes"] = incoming_poll_votes
    elif incoming_poll_votes is not None:
        raw["pollVotes"] = max(current_poll_votes, incoming_poll_votes)
    merged["raw"] = raw
    return merged


def coverage_record(
    source: dict[str, str],
    status: str,
    posts: list[dict[str, Any]],
    limitations: list[str],
) -> dict[str, Any]:
    dates = sorted(
        post["publishedAt"] for post in posts if post.get("publishedAt") is not None
    )
    return {
        "platform": source["platform"],
        "accountUrl": source["accountUrl"],
        "scope": source["scope"],
        "status": status,
        "itemCount": len(posts),
        "oldestPublishedAt": dates[0] if dates else None,
        "newestPublishedAt": dates[-1] if dates else None,
        "limitations": limitations,
    }


def aggregate_coverage(
    source_coverages: list[dict[str, Any]],
    posts: list[dict[str, Any]],
    platform_filter: str,
    *,
    limited_by_argument: bool,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []

    youtube_sources = [
        item for item in source_coverages if item["platform"] == "youtube"
    ]
    if youtube_sources:
        youtube_posts = [post for post in posts if post["platform"] == "youtube"]
        limitations = list(BASE_LIMITATIONS["youtube"])
        for item in youtube_sources:
            for limitation in item["limitations"]:
                if limitation not in limitations:
                    limitations.append(limitation)
        youtube_dated = sum(
            1 for post in youtube_posts if post.get("publishedAt") is not None
        )
        youtube_with_views = sum(
            1 for post in youtube_posts if post.get("views") is not None
        )
        youtube_with_likes = sum(
            1 for post in youtube_posts if post.get("likes") is not None
        )
        if youtube_dated < len(youtube_posts):
            limitations.append(
                f"Une date est exposée pour {youtube_dated}/{len(youtube_posts)} contenus ; les bornes oldest/newest portent uniquement sur ce sous-ensemble daté."
            )
        if youtube_with_views < len(youtube_posts):
            limitations.append(
                f"Un compteur de vues est exposé pour {youtube_with_views}/{len(youtube_posts)} contenus ; les autres valeurs restent nulles."
            )
        if youtube_with_likes < len(youtube_posts):
            limitations.append(
                f"Un compteur de likes est exposé pour {youtube_with_likes}/{len(youtube_posts)} contenus ; les autres valeurs restent nulles."
            )
        statuses = {item["status"] for item in youtube_sources}
        status = (
            "complete-public-profile"
            if statuses == {"available"} and not limited_by_argument
            else "partial-public-profile"
            if youtube_posts
            else "unavailable"
        )
        result.append(
            aggregate_platform_record(
                platform="youtube",
                account_url="https://www.youtube.com/@LofiGirl",
                scope="shorts + community posts + commentaires publiés par le compte lorsqu’un export autorisé est disponible",
                status=status,
                posts=youtube_posts,
                limitations=limitations,
            )
        )

    tiktok_sources = [
        item for item in source_coverages if item["platform"] == "tiktok"
    ]
    if tiktok_sources:
        tiktok_posts = [
            post
            for post in posts
            if post["platform"] == "tiktok" and post_counts_toward_coverage(post)
        ]
        source = tiktok_sources[0]
        status = (
            "complete-public-profile"
            if source["status"] == "available" and not limited_by_argument
            else "partial-public-profile"
            if tiktok_posts
            else "unavailable"
        )
        result.append(
            aggregate_platform_record(
                platform="tiktok",
                account_url="https://www.tiktok.com/@lofigirl",
                scope="profile",
                status=status,
                posts=tiktok_posts,
                limitations=source["limitations"],
            )
        )

    if platform_filter == "all":
        result.extend(json.loads(json.dumps(STATIC_COVERAGE, ensure_ascii=False)))
    return result


def aggregate_platform_record(
    *,
    platform: str,
    account_url: str,
    scope: str,
    status: str,
    posts: list[dict[str, Any]],
    limitations: list[str],
) -> dict[str, Any]:
    dates = sorted(
        post["publishedAt"] for post in posts if post.get("publishedAt") is not None
    )
    return {
        "platform": platform,
        "accountUrl": account_url,
        "scope": scope,
        "status": status,
        "itemCount": len(posts),
        "oldestPublishedAt": dates[0] if dates else None,
        "newestPublishedAt": dates[-1] if dates else None,
        "limitations": list(dict.fromkeys(limitations)),
    }


def post_counts_toward_coverage(post: dict[str, Any]) -> bool:
    """Indique si une ligne appartient à l'inventaire couvert par le profil.

    Les commentaires Instagram et TikTok publiés par Lofi Girl sont conservés
    dans le snapshot pour le module Commentaires, mais leurs cibles ne sont pas
    des publications des profils Lofi Girl. Ils ne doivent donc pas gonfler la
    couverture des catalogues Instagram/TikTok.

    Les couvertures YouTube et X incluent explicitement les commentaires ou
    réponses dans leur périmètre certifié actuel ; elles conservent donc leur
    sémantique existante.
    """
    return not (
        post.get("platform") in PROFILE_ONLY_COVERAGE_PLATFORMS
        and post.get("format") == "comment"
    )


def sort_posts(posts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    values = list(posts)
    dated = sorted(
        (post for post in values if post.get("publishedAt")),
        key=lambda post: (post["publishedAt"], post["platform"], post["externalId"]),
        reverse=True,
    )
    undated = sorted(
        (post for post in values if not post.get("publishedAt")),
        key=lambda post: (post["platform"], post["externalId"]),
    )
    return dated + undated


def validate_snapshot(snapshot: dict[str, Any], platform_filter: str) -> None:
    official_account_urls = {
        "youtube": "https://www.youtube.com/@LofiGirl",
        "tiktok": "https://www.tiktok.com/@lofigirl",
        "instagram": "https://www.instagram.com/lofigirl/",
        "x": "https://x.com/lofigirl",
    }
    required_platforms = (
        {"youtube", "tiktok", "instagram", "x"}
        if platform_filter == "all"
        else {platform_filter}
    )
    coverage_platforms: set[str] = set()
    for item in snapshot["coverage"]:
        platform = item.get("platform") if isinstance(item, dict) else None
        if platform not in official_account_urls:
            raise RuntimeError(f"plateforme de couverture inattendue : {platform}")
        if platform in coverage_platforms:
            raise RuntimeError(f"couverture dupliquée : {platform}")
        coverage_platforms.add(platform)
        if item.get("accountUrl") != official_account_urls[platform]:
            raise RuntimeError(f"compte officiel incorrect pour {platform}")
        item_count = item.get("itemCount")
        if isinstance(item_count, bool) or not isinstance(item_count, int) or item_count < 0:
            raise RuntimeError(f"compteur de couverture invalide pour {platform}")
    if not required_platforms.issubset(coverage_platforms):
        raise RuntimeError("la couverture ne contient pas toutes les plateformes requises")

    keys: set[tuple[str, str]] = set()
    coverage_post_counts: dict[str, int] = {}
    for post in snapshot["posts"]:
        if not isinstance(post, dict):
            raise RuntimeError("un post du snapshot n'est pas un objet")
        for field in ("platform", "externalId", "url", "format", "raw"):
            if field not in post:
                raise RuntimeError(f"champ obligatoire absent du post : {field}")
        if (
            not isinstance(post["externalId"], str)
            or not post["externalId"]
            or not isinstance(post["url"], str)
            or not post["url"]
            or not isinstance(post["format"], str)
            or not isinstance(post["raw"], dict)
        ):
            raise RuntimeError(f"post mal formé : {post.get('externalId')}")
        key = (post["platform"], post["externalId"])
        if key in keys:
            raise RuntimeError(f"doublon après normalisation : {key}")
        keys.add(key)
        if post_counts_toward_coverage(post):
            coverage_post_counts[post["platform"]] = (
                coverage_post_counts.get(post["platform"], 0) + 1
            )
        for metric in ("views", "likes", "comments", "shares", "saves"):
            value = post.get(metric)
            if value is not None and nonnegative_number(value) is None:
                raise RuntimeError(f"métrique {metric} invalide pour {key}")
        metric_history = post["raw"].get("metricHistory")
        if metric_history is not None:
            normalized_history = normalize_metric_history(metric_history)
            if len(normalized_history) != len(metric_history):
                raise RuntimeError(f"metricHistory dupliqué pour {key}")
            for point in normalized_history:
                for metric in (*METRIC_FIELDS, "pollVotes"):
                    value = point.get(metric)
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value < 0
                    ):
                        raise RuntimeError(
                            f"métrique historique {metric} invalide pour {key}"
                        )
        poll_votes = post["raw"].get("pollVotes")
        if poll_votes is not None and (
            isinstance(poll_votes, bool)
            or not isinstance(poll_votes, int)
            or poll_votes < 0
        ):
            raise RuntimeError(f"nombre de votes invalide pour {key}")
        if post["format"] == "community_poll":
            poll_choices = post["raw"].get("pollChoices")
            if not isinstance(poll_choices, list) or len(poll_choices) < 2:
                raise RuntimeError(f"choix de sondage invalides pour {key}")
        if (
            post["platform"] == "tiktok"
            and post["format"] != "comment"
            and post["thumbnailUrl"] is not None
        ):
            raise RuntimeError("une miniature TikTok signée a été conservée")
        if post["platform"] == "youtube" and post["format"] not in {
            "short",
            "community_image",
            "community_poll",
            "community_text",
            "comment",
        }:
            raise RuntimeError(
                f"format YouTube hors périmètre : {post['format']} ({post['externalId']})"
            )
        if (
            post["platform"] == "youtube"
            and post["format"] != "comment"
            and "/watch" in post["url"]
        ):
            raise RuntimeError(
                f"URL vidéo longue YouTube hors périmètre : {post['url']}"
            )
        if post["platform"] not in official_account_urls:
            raise RuntimeError(f"plateforme inattendue : {post['platform']}")

    for item in snapshot["coverage"]:
        expected_count = coverage_post_counts.get(item["platform"], 0)
        if item["itemCount"] != expected_count:
            raise RuntimeError(
                f"couverture incohérente pour {item['platform']} : "
                f"{item['itemCount']} annoncé(s), {expected_count} post(s) présent(s)"
            )

    for post in snapshot["posts"]:
        if (
            post["platform"] == "tiktok"
            and post["format"] != "comment"
            and SIGNED_TIKTOK_PATTERN.search(json.dumps(post, ensure_ascii=False))
        ):
            raise RuntimeError(
                "un contenu de profil TikTok contient une URL ou un paramètre signé"
            )
        if any(SENSITIVE_KEY_PATTERN.search(str(key)) for key in post["raw"]):
            raise RuntimeError("le snapshot contient une clé potentiellement sensible")


def print_summary(snapshot: dict[str, Any], output: Path) -> None:
    totals: dict[str, int] = {}
    for post in snapshot["posts"]:
        totals[post["platform"]] = totals.get(post["platform"], 0) + 1
    coverage_summary = ", ".join(
        f"{item['platform']}:{item['scope']}={item['itemCount']} ({item['status']})"
        for item in snapshot["coverage"]
    )
    print(f"Snapshot écrit : {output}")
    print(f"Posts uniques : {len(snapshot['posts'])} · {totals}")
    print(f"Couverture : {coverage_summary}")


def clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized or None


def first_text(*values: Any) -> str | None:
    for value in values:
        text = clean_text(value)
        if text:
            return text
    return None


def nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    return None


def nonnegative_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return int(value) if float(value).is_integer() else round(float(value), 3)
    return None


def clean_error(error: Exception) -> str:
    message = " ".join(str(error).split())
    return message[:300] if message else error.__class__.__name__


if __name__ == "__main__":
    raise SystemExit(main())
