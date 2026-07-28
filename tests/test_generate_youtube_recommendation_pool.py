import json
import tempfile
import unittest
from pathlib import Path

from generate_youtube_recommendation_pool import (
    POOL_PREFIX,
    generate_recommendation_pool,
    write_recommendation_pool,
)


class RecommendationPoolTests(unittest.TestCase):
    def source_data(self, count=900):
        genres = [
            "Lofi / chillhop",
            "Ambient",
            "Nature",
            "Jazz / bossa",
            "Piano",
            "Classical",
            "Guitar / acoustic",
            "Chill house",
            "Drum & Bass",
            "Synthwave / retro",
        ]
        clusters = ["Study / focus / work", "Sleep / night", "Reading / writing", "Fantasy / medieval"]
        rows = []
        for index in range(count):
            rows.append(
                {
                    "vid": f"v{index:010d}",
                    "title": f"Measured instrumental source {index}",
                    "genre": genres[index % len(genres)],
                    "cluster": clusters[index % len(clusters)],
                    "views": 100_000 + index * 1_000,
                    "vpm": 10_000 + index * 25,
                    "ageM": (index % 12) + 1,
                    "kw": f"instrumental focus {index}",
                }
            )
        return {"all": rows, "trends": [], "news": [], "videoMetricsT": 123456}

    def test_pool_is_not_bound_to_the_legacy_thousand_rows(self):
        data = self.source_data()
        first = generate_recommendation_pool(data, max_items=1300)
        second = generate_recommendation_pool(data, max_items=1300)
        self.assertEqual(len(first), 1300)
        self.assertEqual(
            [(row["n"], row["title"]) for row in first],
            [(row["n"], row["title"]) for row in second],
        )
        self.assertEqual(len({row["n"] for row in first}), len(first))
        self.assertEqual(len({row["title"].casefold() for row in first}), len(first))
        source_titles = {row["title"] for row in data["all"]}
        self.assertTrue(all(row["title"] not in source_titles for row in first))
        self.assertTrue(all(row["_generated"] for row in first))
        self.assertTrue(all("Signal mesuré" in row["noteData"] for row in first))

    def test_writer_emits_a_browser_overlay_with_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "pool.js"
            payload = write_recommendation_pool(self.source_data(20), target, generated_ms=987654, max_items=25)
            raw = target.read_text(encoding="utf-8").strip()
            self.assertTrue(raw.startswith(POOL_PREFIX))
            decoded = json.loads(raw[len(POOL_PREFIX):].rstrip(";"))
            self.assertEqual(decoded["t"], 987654)
            self.assertEqual(decoded["sourceT"], 123456)
            self.assertEqual(decoded["items"], payload["items"])
            self.assertGreater(len(decoded["items"]), 0)

    def test_unknown_or_unidentified_rows_are_not_forced_into_a_genre(self):
        data = {"all": [{"vid": "abcdefghijk", "title": "Unclassified source", "genre": "", "cluster": ""}]}
        self.assertEqual(generate_recommendation_pool(data), [])


if __name__ == "__main__":
    unittest.main()
