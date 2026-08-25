from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load_importer():
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
    spec = importlib.util.spec_from_file_location(
        "import_youtube_owner_posts", SCRIPTS / "import_youtube_owner_posts.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("impossible de charger l’import propriétaire")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class YoutubeOwnerImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (ROOT / "work" / "ytdeps").is_dir():
            raise unittest.SkipTest("yt-dlp local absent")
        cls.importer = load_importer()

    def test_normalizes_visible_image_poll_and_text_without_launch_metric(self):
        imported_at = "2026-08-04T12:00:00Z"
        image = self.importer.normalize_exported_post(
            {
                "externalId": "UgkxImage",
                "text": "Fan art du jour",
                "publishedLabel": "il y a 2 jours",
                "likesLabel": "1,4 k J'aime",
                "commentsLabel": "45 commentaires",
                "imageUrls": ["https://yt3.ggpht.com/example=s800"],
                "pollChoices": [],
                "attachmentKind": "image",
            },
            imported_at,
        )
        poll = self.importer.normalize_exported_post(
            {
                "externalId": "UgkxPoll",
                "text": "Pick one",
                "publishedLabel": "il y a 1 an",
                "likesLabel": "900",
                "commentsLabel": None,
                "pollVotesLabel": "12 k votes",
                "imageUrls": [],
                "pollChoices": ["A", "B"],
                "attachmentKind": "poll",
            },
            imported_at,
        )
        text = self.importer.normalize_exported_post(
            {
                "externalId": "UgkxText",
                "text": "Small reminder",
                "publishedLabel": "il y a 3 heures",
                "likesLabel": "12",
                "commentsLabel": "2 commentaires",
                "imageUrls": [],
                "pollChoices": [],
                "attachmentKind": "none",
            },
            imported_at,
        )
        image_without_loaded_thumbnail = self.importer.normalize_exported_post(
            {
                "externalId": "UgkxLazyImage",
                "text": None,
                "publishedLabel": "il y a 3 ans",
                "likesLabel": "131 k",
                "commentsLabel": "703 commentaires",
                "imageUrls": [],
                "pollChoices": [],
                "attachmentKind": "image",
            },
            imported_at,
        )

        self.assertEqual(image["format"], "community_image")
        self.assertEqual(image["likes"], 1400)
        self.assertEqual(image["comments"], 45)
        self.assertEqual(image["publishedAt"], "2026-08-02T12:00:00Z")
        self.assertEqual(poll["format"], "community_poll")
        self.assertEqual(poll["raw"]["pollVotes"], 12000)
        self.assertEqual(text["format"], "community_text")
        self.assertEqual(image_without_loaded_thumbnail["format"], "community_image")
        self.assertEqual(image_without_loaded_thumbnail["raw"]["communityImageCount"], 1)
        self.assertNotIn("launch", str(image).casefold())

    def test_rejects_an_incomplete_or_wrong_account_export(self):
        with tempfile.TemporaryDirectory() as directory:
            export_path = Path(directory) / "export.json"
            export_path.write_text(
                '{"accountUrl":"https://www.youtube.com/@Other/posts",'
                '"channelHandle":"@Other","endReached":false,'
                '"exportedAt":"2026-08-04T12:00:00Z","posts":[]}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "officiel Lofi Girl"):
                self.importer.load_export(export_path)


if __name__ == "__main__":
    unittest.main()
