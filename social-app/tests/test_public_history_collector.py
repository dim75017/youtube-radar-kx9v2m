from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR_PATH = ROOT / "scripts" / "collect_public_history.py"


def load_collector():
    yt_dlp = types.ModuleType("yt_dlp")
    yt_dlp.YoutubeDL = object
    yt_dlp.version = types.SimpleNamespace(__version__="test")
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
    spec = importlib.util.spec_from_file_location("collect_public_history", COLLECTOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("impossible de charger le collecteur")
    module = importlib.util.module_from_spec(spec)
    # Le collecteur vérifie la présence du dossier vendor avant ses imports.
    # Les dépendances sont simulées ici afin que les tests de fusion restent
    # exécutables localement sans téléchargement réseau.
    with patch.object(Path, "is_dir", return_value=True):
        spec.loader.exec_module(module)
    return module


class CollectorAppendOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = load_collector()

    def test_partial_collection_preserves_other_platforms_and_coverage(self):
        existing = {
            "coverage": [
                {
                    "platform": "youtube",
                    "accountUrl": "https://www.youtube.com/@LofiGirl",
                    "itemCount": 1,
                },
                {
                    "platform": "tiktok",
                    "accountUrl": "https://www.tiktok.com/@lofigirl",
                    "itemCount": 1,
                },
            ],
            "posts": [
                {"platform": "youtube", "externalId": "yt", "raw": {}},
                {"platform": "tiktok", "externalId": "tt", "raw": {}},
            ],
        }

        posts = self.collector.load_existing_posts(existing)
        coverage = self.collector.merge_coverage_with_existing(
            [{"platform": "youtube", "itemCount": 2}],
            existing,
            {"youtube"},
            preserve_unselected=True,
        )

        self.assertEqual({post["platform"] for post in posts}, {"youtube", "tiktok"})
        self.assertEqual(
            {item["platform"] for item in coverage}, {"youtube", "tiktok"}
        )
        self.assertEqual(
            next(item for item in coverage if item["platform"] == "tiktok")[
                "itemCount"
            ],
            1,
        )

    def test_profile_coverage_excludes_instagram_and_tiktok_authored_comments(self):
        for platform in ("instagram", "tiktok"):
            with self.subTest(platform=platform):
                self.assertTrue(
                    self.collector.post_counts_toward_coverage(
                        {"platform": platform, "format": "video"}
                    )
                )
                self.assertFalse(
                    self.collector.post_counts_toward_coverage(
                        {"platform": platform, "format": "comment"}
                    )
                )

        for platform in ("youtube", "x"):
            with self.subTest(platform=platform):
                self.assertTrue(
                    self.collector.post_counts_toward_coverage(
                        {"platform": platform, "format": "comment"}
                    )
                )

    def test_tiktok_coverage_uses_profile_videos_not_authored_comments(self):
        posts = [
            {
                "platform": "tiktok",
                "externalId": "123",
                "format": "video",
                "publishedAt": "2026-08-01T10:00:00Z",
            },
            {
                "platform": "tiktok",
                "externalId": "comment:456",
                "format": "comment",
                "publishedAt": "2026-08-02T10:00:00Z",
            },
        ]
        source_coverage = {
            "platform": "tiktok",
            "accountUrl": "https://www.tiktok.com/@lofigirl",
            "scope": "profile",
            "status": "available",
            "itemCount": 1,
            "oldestPublishedAt": "2026-08-01T10:00:00Z",
            "newestPublishedAt": "2026-08-01T10:00:00Z",
            "limitations": [],
        }

        coverage = self.collector.aggregate_coverage(
            [source_coverage],
            posts,
            "tiktok",
            limited_by_argument=False,
        )

        self.assertEqual(coverage[0]["itemCount"], 1)
        self.assertEqual(coverage[0]["oldestPublishedAt"], "2026-08-01T10:00:00Z")
        self.assertEqual(coverage[0]["newestPublishedAt"], "2026-08-01T10:00:00Z")

    def test_real_snapshot_survives_partial_youtube_and_tiktok_collections(self):
        source_snapshot = json.loads(
            (ROOT / "data" / "public-history.json").read_text(encoding="utf-8")
        )
        original_coverage = {
            item["platform"]: item for item in source_snapshot["coverage"]
        }
        original_post_keys = {
            (post["platform"], post["externalId"])
            for post in source_snapshot["posts"]
        }
        original_posts = {
            (post["platform"], post["externalId"]): post
            for post in source_snapshot["posts"]
        }

        for platform in ("youtube", "tiktok"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "public-history.json"
                output.write_text(
                    json.dumps(source_snapshot, ensure_ascii=False), encoding="utf-8"
                )

                def fake_collect(source, _max_items):
                    return [], self.collector.coverage_record(
                        source, "empty", [], ["fixture de collecte partielle"]
                    )

                args = SimpleNamespace(output=output, max_items=0, platform=platform)
                with (
                    patch.object(self.collector, "parse_args", return_value=args),
                    patch.object(self.collector, "collect_source", side_effect=fake_collect),
                ):
                    self.assertEqual(self.collector.main(), 0)

                result = json.loads(output.read_text(encoding="utf-8"))
                result_coverage = {
                    item["platform"]: item for item in result["coverage"]
                }
                result_post_keys = {
                    (post["platform"], post["externalId"])
                    for post in result["posts"]
                }
                result_posts = {
                    (post["platform"], post["externalId"]): post
                    for post in result["posts"]
                }

                self.assertEqual(result_post_keys, original_post_keys)
                for preserved_platform in {"youtube", "tiktok", "instagram", "x"} - {
                    platform
                }:
                    self.assertEqual(
                        result_coverage[preserved_platform],
                        original_coverage[preserved_platform],
                    )
                    self.assertEqual(
                        {
                            key: post
                            for key, post in result_posts.items()
                            if key[0] == preserved_platform
                        },
                        {
                            key: post
                            for key, post in original_posts.items()
                            if key[0] == preserved_platform
                        },
                    )
                if platform == "tiktok":
                    self.assertEqual(
                        {
                            key: post
                            for key, post in result_posts.items()
                            if key[0] == "tiktok" and post["format"] == "comment"
                        },
                        {
                            key: post
                            for key, post in original_posts.items()
                            if key[0] == "tiktok" and post["format"] == "comment"
                        },
                    )
                self.assertEqual(result_coverage["instagram"]["itemCount"], 1685)
                self.assertEqual(
                    result_coverage["tiktok"]["itemCount"],
                    original_coverage["tiktok"]["itemCount"],
                )
                self.collector.validate_snapshot(result, platform)

    def test_versioned_snapshot_passes_strict_validation(self):
        snapshot = json.loads(
            (ROOT / "data" / "public-history.json").read_text(encoding="utf-8")
        )
        self.collector.validate_snapshot(snapshot, "all")

    def test_corrupt_existing_snapshot_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.json"
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "sans écriture"):
                self.collector.load_existing_snapshot(path)

    def test_preserved_posts_keep_their_previous_observation_time(self):
        old_time = "2026-08-01T10:00:00Z"
        new_time = "2026-08-04T10:00:00Z"
        old_post = self.collector.seed_existing_observation_timestamps(
            {
                "platform": "tiktok",
                "externalId": "old",
                "views": 12,
                "likes": 3,
                "raw": {"collector": "test-collector"},
            },
            old_time,
        )
        observed_post = self.collector.mark_post_observed(
            {
                "platform": "youtube",
                "externalId": "seen",
                "views": 20,
                "raw": {"collector": "test-collector"},
            },
            new_time,
        )

        self.assertEqual(old_post["raw"]["lastObservedAt"], old_time)
        self.assertEqual(
            old_post["raw"]["metricHistory"],
            [
                {
                    "capturedAt": old_time,
                    "views": 12,
                    "likes": 3,
                    "comments": None,
                    "shares": None,
                    "saves": None,
                    "pollVotes": None,
                    "source": "test-collector",
                }
            ],
        )
        self.assertEqual(observed_post["raw"]["firstObservedAt"], new_time)
        self.assertEqual(observed_post["raw"]["lastObservedAt"], new_time)
        self.assertEqual(observed_post["raw"]["metricHistory"][0]["views"], 20)

    def test_metric_history_accumulates_exact_observations_and_deduplicates(self):
        first_time = "2026-08-04T10:00:00Z"
        second_time = "2026-08-04T16:00:00Z"
        base = {
            "platform": "tiktok",
            "externalId": "video",
            "format": "video",
            "url": "https://www.tiktok.com/@lofigirl/video/123",
            "views": 100,
            "likes": 10,
            "comments": 1,
            "shares": 2,
            "saves": 3,
            "raw": {"collector": "test-collector"},
        }
        first = self.collector.mark_post_observed(base, first_time)
        second = self.collector.mark_post_observed(
            {**base, "views": 160, "likes": 18}, second_time
        )

        merged = self.collector.merge_posts(first, second)
        merged_again = self.collector.merge_posts(merged, second)
        history = merged_again["raw"]["metricHistory"]

        self.assertEqual([point["capturedAt"] for point in history], [first_time, second_time])
        self.assertEqual([point["views"] for point in history], [100, 160])
        self.assertEqual(merged_again["views"], 160)

    def test_metric_sources_are_merged_key_by_key(self):
        current = {
            "platform": "youtube",
            "externalId": "one",
            "format": "short",
            "url": "https://www.youtube.com/shorts/one",
            "views": 10,
            "likes": None,
            "raw": {
                "collectionScopes": ["shorts"],
                "metricSources": {"views": "listing"},
            },
        }
        incoming = {
            **current,
            "likes": 5,
            "raw": {
                "collectionScopes": ["shorts"],
                "metricSources": {"likes": "video-api"},
            },
        }

        merged = self.collector.merge_posts(current, incoming)

        self.assertEqual(
            merged["raw"]["metricSources"],
            {"views": "listing", "likes": "video-api"},
        )

    def test_validation_rejects_negative_poll_votes_and_false_coverage(self):
        poll = {
            "platform": "youtube",
            "externalId": "poll",
            "url": "https://www.youtube.com/post/poll",
            "format": "community_poll",
            "thumbnailUrl": None,
            "views": None,
            "likes": 1,
            "comments": None,
            "shares": None,
            "saves": None,
            "raw": {"pollVotes": -5, "pollChoices": ["A", "B"]},
        }
        snapshot = {
            "coverage": [
                {
                    "platform": "youtube",
                    "accountUrl": "https://www.youtube.com/@LofiGirl",
                    "itemCount": 1,
                }
            ],
            "posts": [poll],
        }
        with self.assertRaisesRegex(RuntimeError, "votes invalide"):
            self.collector.validate_snapshot(snapshot, "youtube")

        snapshot["posts"][0]["raw"]["pollVotes"] = 5
        snapshot["posts"][0]["raw"]["metricHistory"] = [
            {
                "capturedAt": "2026-08-04T10:00:00Z",
                "views": -1,
            }
        ]
        with self.assertRaisesRegex(RuntimeError, "historique views invalide"):
            self.collector.validate_snapshot(snapshot, "youtube")

        del snapshot["posts"][0]["raw"]["metricHistory"]
        snapshot["coverage"][0]["itemCount"] = 999
        with self.assertRaisesRegex(RuntimeError, "couverture incohérente"):
            self.collector.validate_snapshot(snapshot, "youtube")


if __name__ == "__main__":
    unittest.main()
