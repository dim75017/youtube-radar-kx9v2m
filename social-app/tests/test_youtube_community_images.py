from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from enrich_youtube_community_images import candidate_images


class YouTubeCommunityImageTests(unittest.TestCase):
    def test_keeps_post_images_and_discards_the_channel_avatar(self) -> None:
        page = '''https://yt3.ggpht.com/_BSh2VVvVMzqBoKyWbQnyC35X=s76
        https://yt3.ggpht.com/post-image=s1024-c-fcrop64=1,00000000ffffffff-rw-nd-v1'''
        self.assertEqual(
            candidate_images(page),
            ["https://yt3.ggpht.com/post-image=s1024-c-fcrop64=1,00000000ffffffff-rw-nd-v1"],
        )


if __name__ == "__main__":
    unittest.main()
