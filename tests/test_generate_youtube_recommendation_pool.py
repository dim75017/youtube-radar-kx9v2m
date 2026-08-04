from collections import Counter
import json
import re
import tempfile
import unittest
from pathlib import Path

from generate_youtube_recommendation_pool import (
    GENERATOR_VERSION,
    POOL_PREFIX,
    SCORING_VERSION,
    _legacy_recommendation_id,
    _potential_for_score,
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
                    "views": 100_000 + index * 25_000,
                    "vpm": 30_000 + index * 2_500,
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
        self.assertTrue(all(row["_generatorVersion"] == 2 for row in first))
        self.assertEqual(SCORING_VERSION, 4)
        self.assertTrue(all(row["_scoringVersion"] == SCORING_VERSION for row in first))
        self.assertTrue(all(row["_sourceWindow"] in {"0-3m", "3-6m", "6-12m"} for row in first))
        self.assertTrue(all(0 <= row["_sourceAgeM"] <= 12 for row in first))
        self.assertTrue(all(row["_settingKey"] and row["_settingKey"] == row["_settingKey"].casefold() for row in first))
        self.assertTrue(all(row["_genreKey"] and row["_purposeKey"] for row in first))
        self.assertLessEqual(max(Counter(row["_sourceVideoId"] for row in first).values()), 3)
        self.assertTrue(all(not re.search(r"\b([a-z]+)\s+\1\b", row["title"].casefold()) for row in first))
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
            self.assertEqual(decoded["version"], GENERATOR_VERSION)
            self.assertEqual(decoded["items"], payload["items"])
            self.assertGreater(len(decoded["items"]), 0)

    def test_explicit_lofi_genre_wins_over_rain_and_nature_keywords(self):
        data = {
            "all": [{
                "vid": "lofirain001",
                "title": "Rainy forest lofi beats to study to",
                "genre": "Lofi / chillhop",
                "cluster": "Study / focus / work",
                "views": 750_000,
                "vpm": 220_000,
                "ageM": 1.2,
                "kw": "rain ambience; forest sounds; white noise; lofi rain",
            }],
            "recos": [],
        }
        rows = generate_recommendation_pool(data)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["_genreKey"] == "lofi" for row in rows))
        self.assertTrue(all("Lofi" in row["genre"] for row in rows))
        self.assertTrue(all(row["_purposeKey"] == "study" for row in rows))
        self.assertTrue(all(row["_sourceWindow"] == "0-3m" for row in rows))
        self.assertEqual(sum("_legacyN" in row for row in rows), 2)
        self.assertEqual(
            {row["_legacyN"] for row in rows if "_legacyN" in row},
            {_legacy_recommendation_id("lofirain001", 0), _legacy_recommendation_id("lofirain001", 1)},
        )

    def test_current_pool_excludes_old_sources_without_letting_age_override_market_strength(self):
        rows = [
            {"vid": "recent00001", "title": "Recent lofi focus", "genre": "Lofi", "cluster": "Study", "views": 150_000, "vpm": 50_000, "ageM": 2},
            {"vid": "middle00001", "title": "Recent ambient focus", "genre": "Ambient", "cluster": "Study", "views": 900_000, "vpm": 250_000, "ageM": 5},
            {"vid": "later000001", "title": "Recent piano focus", "genre": "Piano", "cluster": "Study", "views": 9_000_000, "vpm": 900_000, "ageM": 9},
            {"vid": "stale000001", "title": "Old jazz focus", "genre": "Jazz", "cluster": "Study", "views": 900_000_000, "vpm": 9_000_000, "ageM": 13},
        ]
        generated = generate_recommendation_pool({"all": rows, "recos": []})
        self.assertNotIn("stale000001", {row["_sourceVideoId"] for row in generated})
        windows = list(dict.fromkeys(row["_sourceWindow"] for row in generated))
        self.assertEqual(windows, ["0-3m", "3-6m", "6-12m"])
        scores = {
            window: [row["score"] for row in generated if row["_sourceWindow"] == window]
            for window in windows
        }
        self.assertGreater(min(scores["6-12m"]), max(scores["3-6m"]))
        self.assertGreater(min(scores["3-6m"]), max(scores["0-3m"]))

    def test_score_to_potential_contract_includes_a_rare_s_tier(self):
        self.assertTrue(_potential_for_score(94).startswith("A"))
        self.assertTrue(_potential_for_score(95).startswith("S"))
        rows = generate_recommendation_pool(self.source_data(), max_items=1300)
        tiers = Counter(row["pot"][0] for row in rows)
        self.assertTrue({"S", "A", "B", "C"}.issubset(tiers))
        self.assertLess(tiers["S"], tiers["A"])

    def test_absolute_evidence_floor_prevents_relative_false_positives(self):
        weak_recent = {
            "vid": "weakrecent1",
            "title": "Weak recent lofi source",
            "genre": "Lofi",
            "cluster": "Study",
            "views": 5_000,
            "vpm": 1_000,
            "ageM": 1,
        }
        self.assertEqual(generate_recommendation_pool({"all": [weak_recent], "recos": []}), [])

        marginal_recent = dict(weak_recent, vid="marginal001", views=100_000, vpm=30_000)
        marginal_rows = generate_recommendation_pool({"all": [marginal_recent], "recos": []})
        self.assertTrue(marginal_rows)
        self.assertTrue(all(not row["pot"].startswith("S") for row in marginal_rows))
        self.assertTrue(all(row["score"] < 88 for row in marginal_rows))

    def test_shared_feedback_profile_changes_seed_ranking_but_stays_bounded(self):
        sources = [
            {"vid": "ambient001", "title": "Ambient study session", "genre": "Ambient", "cluster": "Study", "views": 500_000, "vpm": 100_000, "ageM": 2},
            {"vid": "lofi0000001", "title": "Lofi study session", "genre": "Lofi", "cluster": "Study", "views": 500_000, "vpm": 100_000, "ageM": 2},
        ]
        decisions = [
            *({"valid": "x", "genre": "Lofi", "title": f"Accepted lofi study {index}", "niche": "Study"} for index in range(8)),
            *({"valid": "-", "genre": "Ambient", "title": f"Refused ambient study {index}", "niche": "Study"} for index in range(8)),
        ]
        generated = generate_recommendation_pool({"all": sources, "recos": decisions})
        self.assertEqual(generated[0]["_sourceVideoId"], "lofi0000001")
        lofi = next(row for row in generated if row["_sourceVideoId"] == "lofi0000001")
        ambient = next(row for row in generated if row["_sourceVideoId"] == "ambient001")
        self.assertGreater(lofi["_feedbackAffinity"], 0)
        self.assertLess(ambient["_feedbackAffinity"], 0)
        self.assertTrue(all(-1 <= row["_feedbackAffinity"] <= 1 for row in generated))

    def test_unknown_or_unidentified_rows_are_not_forced_into_a_genre(self):
        data = {"all": [{"vid": "abcdefghijk", "title": "Unclassified source", "genre": "", "cluster": ""}]}
        self.assertEqual(generate_recommendation_pool(data), [])


if __name__ == "__main__":
    unittest.main()
