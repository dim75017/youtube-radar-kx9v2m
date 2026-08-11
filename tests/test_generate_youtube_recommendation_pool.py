from collections import Counter
import json
import random
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from generate_youtube_recommendation_pool import (
    BROWSER_SCHEMA_VERSION,
    GENERATOR_VERSION,
    JS_SAFE_INTEGER,
    POOL_PREFIX,
    SCORING_VERSION,
    TITLE_RECIPE_VERSION,
    _apply_feedback,
    _build_id,
    _concept_family,
    _feedback_affinity,
    _ledger_record,
    _legacy_recommendation_id,
    _potential_for_score,
    _published_performance_profile,
    _rehydrate_presentation,
    _source_has_explicit_vocals,
    generate_recommendation_pool,
    load_feedback,
    load_recommendation_ledger,
    read_recommendation_pool,
    read_snapshot,
    sync_recommendation_reservoir,
    validate_recommendation_reservoir,
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

    def write_snapshot(self, path: Path, data: dict) -> None:
        payload = {
            "t": int(data.get("videoMetricsT") or 0),
            "videoMetricsT": int(data.get("videoMetricsT") or 0),
            "d": {key: value for key, value in data.items() if key != "videoMetricsT"},
        }
        path.write_text(
            "window.LOFI_DATA=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
            encoding="utf-8",
        )

    def legacy_items(self, data: dict, count=3) -> list[dict]:
        items = []
        for index, source in enumerate(data["all"][:count]):
            items.append({
                "n": -(1_000_000_100 + index),
                "valid": "",
                "pot": "B - Solide",
                "score": 82,
                "scoreAdj": 82,
                "genre": source["genre"],
                "niche": source["cluster"],
                "perso": "Lofi Girl",
                "title": f"Legacy measured recommendation {index}",
                "concept": f"Legacy concept {index}",
                "scene": f"Legacy setting {index}",
                "style": "Instrumental, sans voix",
                "dur": "3h",
                "desc": "",
                "kw": source["kw"],
                "noteData": f"Signal mesuré : « {source['title']} ».",
                "_generated": True,
                "_sourceVideoId": source["vid"],
                "_sourceMarketScore": 100 + index,
                "_sourceAgeM": source["ageM"],
                "_sourceWindow": "0-3m",
                "_genreKey": "lofi" if index == 0 else "ambient",
                "_purposeKey": "study",
                "_settingKey": f"legacy setting {index}",
                "_scoringVersion": 4,
                "_legacyN": -(1_500_000_100 + index),
                "_generatorVersion": 2,
            })
        return items

    def write_legacy_pool(self, path: Path, items: list[dict], source_t=123456) -> None:
        payload = {"t": 987654, "sourceT": source_t, "version": 2, "items": items}
        path.write_text(
            POOL_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
            encoding="utf-8",
        )

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
        title_families = Counter(row["_titleFamily"] for row in first)
        self.assertGreaterEqual(len(title_families), 150)
        self.assertEqual({row["_titlePatternIndex"] for row in first}, set(range(12)))
        self.assertLessEqual(max(title_families.values()) / len(first), 0.04)
        self.assertTrue(all(row["_conceptFamily"] == _concept_family(row) for row in first))
        source_titles = {row["title"] for row in data["all"]}
        self.assertTrue(all(row["title"] not in source_titles for row in first))
        self.assertTrue(all(row["_generated"] for row in first))
        self.assertEqual(GENERATOR_VERSION, 3)
        self.assertTrue(all(row["_generatorVersion"] == GENERATOR_VERSION for row in first))
        self.assertEqual(SCORING_VERSION, 4)
        self.assertTrue(all(row["_scoringVersion"] == SCORING_VERSION for row in first))
        self.assertTrue(all(row["_sourceWindow"] in {"0-3m", "3-6m", "6-12m"} for row in first))
        self.assertTrue(all(0 <= row["_sourceAgeM"] <= 12 for row in first))
        self.assertTrue(all(row["_settingKey"] and row["_settingKey"] == row["_settingKey"].casefold() for row in first))
        self.assertTrue(all(row["_genreKey"] and row["_purposeKey"] for row in first))
        self.assertLessEqual(max(Counter(row["_sourceVideoId"] for row in first).values()), 8)
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
            self.assertEqual(decoded["schema"], BROWSER_SCHEMA_VERSION)
            self.assertEqual(decoded["titleRecipeVersion"], TITLE_RECIPE_VERSION)
            self.assertEqual(decoded["buildId"], payload["buildId"])
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
        self.assertGreaterEqual(len(rows), 3)
        self.assertLessEqual(len(rows), 8)
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
        self.assertTrue({"S", "A", "B"}.issubset(tiers))
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

    def test_explicit_human_vocal_sources_are_blocked_without_broad_false_positives(self):
        base = {
            "vid": "vocal-source",
            "genre": "Jazz",
            "cluster": "Study",
            "views": 900_000,
            "vpm": 120_000,
            "ageM": 2,
        }
        for title in (
            "13 Cozy Vocal Jazz Tunes",
            "Jazz with female vocals",
            "Lyrics and singing for late nights",
            "Guided meditation with narration",
        ):
            row = dict(base, title=title)
            self.assertTrue(_source_has_explicit_vocals(row), title)
            self.assertEqual(generate_recommendation_pool({"all": [row], "recos": []}), [])
        for title in (
            "Jazz without vocals for study",
            "Tibetan singing bowls for sleep",
            "Forest birds singing at dawn",
            "Instrumental jazz tunes for study",
        ):
            row = dict(base, vid=f"safe-{len(title)}", title=title)
            self.assertFalse(_source_has_explicit_vocals(row), title)
            self.assertTrue(generate_recommendation_pool({"all": [row], "recos": []}), title)

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

    def test_v3_generation_is_input_order_independent_and_uses_safe_stable_ids(self):
        data = self.source_data(320)
        shuffled = dict(data)
        shuffled["all"] = list(data["all"])
        random.Random(42).shuffle(shuffled["all"])
        first = generate_recommendation_pool(data, max_items=700)
        second = generate_recommendation_pool(shuffled, max_items=700)
        self.assertEqual(
            [(row["n"], row["title"], row["_ideaKey"]) for row in first],
            [(row["n"], row["title"], row["_ideaKey"]) for row in second],
        )
        self.assertTrue(all(abs(row["n"]) <= JS_SAFE_INTEGER for row in first))
        self.assertTrue(all(row["_generatorVersion"] == 3 for row in first))
        self.assertTrue(all(row["_recipeVersion"] == 1 for row in first))

    def test_title_recipe_rehydrates_existing_items_without_changing_stable_ids(self):
        original = generate_recommendation_pool(self.source_data(40), max_items=80)
        with mock.patch(
            "generate_youtube_recommendation_pool.TITLE_RECIPE_VERSION",
            TITLE_RECIPE_VERSION + 1,
        ):
            rehydrated = [_rehydrate_presentation(row) for row in original]
        self.assertEqual([row["n"] for row in rehydrated], [row["n"] for row in original])
        self.assertEqual([row["_ideaKey"] for row in rehydrated], [row["_ideaKey"] for row in original])
        self.assertTrue(any(after["title"] != before["title"] for before, after in zip(original, rehydrated)))
        base = {
            "sourceT": 123,
            "feedbackT": 456,
            "ledgerRevision": "stable-ledger",
            "items": original,
            "titleRecipeVersion": TITLE_RECIPE_VERSION,
        }
        rotated = dict(base, titleRecipeVersion=TITLE_RECIPE_VERSION + 1)
        self.assertNotEqual(_build_id(base), _build_id(rotated))

    def test_stable_id_collision_fails_closed_instead_of_becoming_order_dependent(self):
        with mock.patch("generate_youtube_recommendation_pool._stable_int", return_value=1):
            with self.assertRaisesRegex(ValueError, "collision"):
                generate_recommendation_pool(self.source_data(2), max_items=10)

    def test_bootstrap_preserves_every_v2_item_losslessly(self):
        data = self.source_data(20)
        legacy = self.legacy_items(data)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot = root / "snapshot.js"
            output = root / "pool.js"
            ledger = root / "ledger"
            self.write_snapshot(snapshot, data)
            self.write_legacy_pool(output, legacy)
            payload = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                bootstrap_pool=output,
                generated_ms=1_800_000_000_000,
                browser_limit=20,
                reserve_low_water=0,
                reserve_high_water=0,
            )
            entries = load_recommendation_ledger(ledger)
            self.assertEqual([entry["item"] for entry in entries], legacy)
            self.assertEqual([row["n"] for row in payload["items"]], [row["n"] for row in legacy])
            self.assertTrue(all(row["_conceptFamily"] for row in payload["items"]))
            self.assertTrue(all(row["_titleFamily"] for row in payload["items"]))
            self.assertTrue(all(row["_titleRecipeVersion"] == TITLE_RECIPE_VERSION for row in payload["items"]))
            self.assertTrue(any(row["title"] != old["title"] for row, old in zip(payload["items"], legacy)))
            self.assertEqual([entry["ideaKey"] for entry in entries], [f"legacy:v2:{row['n']}" for row in legacy])
            self.assertTrue(all(entry["generatorVersion"] == 2 for entry in entries))
            validation = validate_recommendation_reservoir(snapshot, output, ledger, browser_limit=20)
            self.assertEqual(validation["recommendations"], len(legacy))

    def test_bootstrap_drops_a_legacy_item_when_its_source_is_explicitly_vocal(self):
        data = self.source_data(20)
        data["all"][0]["title"] = "13 Cozy Vocal Jazz Tunes"
        legacy = self.legacy_items(data)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "pool.js"
            ledger = root / "ledger"
            self.write_legacy_pool(output, legacy)
            payload = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                bootstrap_pool=output,
                generated_ms=1_800_000_000_000,
                browser_limit=20,
                reserve_low_water=0,
                reserve_high_water=0,
            )
            blocked_id = legacy[0]["n"]
            self.assertNotIn(blocked_id, {entry["n"] for entry in load_recommendation_ledger(ledger)})
            self.assertNotIn(blocked_id, {row["n"] for row in payload["items"]})

    def test_ledger_is_idempotent_then_only_appends_new_jsonl_records(self):
        data = self.source_data(80)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "pool.js"
            ledger = root / "ledger"
            first = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_000_000,
                browser_limit=30,
                reserve_low_water=1,
                reserve_high_water=40,
            )
            shard = next((ledger / "shards").glob("*.jsonl"))
            original = shard.read_bytes()
            second = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_001_000,
                browser_limit=30,
                reserve_low_water=1,
                reserve_high_water=40,
            )
            self.assertEqual(second["ledger"]["appended"], 0)
            self.assertEqual(shard.read_bytes(), original)
            third = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_002_000,
                browser_limit=30,
                reserve_low_water=50,
                reserve_high_water=80,
            )
            grown = shard.read_bytes()
            self.assertGreater(third["ledger"]["appended"], 0)
            self.assertTrue(grown.startswith(original))
            self.assertEqual(first["items"], second["items"])

    def test_ledger_grows_beyond_legacy_cap_while_browser_projection_stays_compact(self):
        data = self.source_data(900)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot = root / "snapshot.js"
            output = root / "pool.js"
            ledger = root / "ledger"
            self.write_snapshot(snapshot, data)
            payload = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_000_000,
                browser_limit=75,
                reserve_low_water=1,
                reserve_high_water=3_100,
            )
            self.assertGreater(payload["ledger"]["total"], 3_000)
            self.assertEqual(len(payload["items"]), 75)
            self.assertEqual(len(load_recommendation_ledger(ledger)), payload["ledger"]["total"])
            validate_recommendation_reservoir(snapshot, output, ledger, browser_limit=75)

    def test_central_feedback_decision_removes_the_whole_concept_family_but_keeps_history(self):
        data = self.source_data(80)
        for status in ("refused", "validated"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                output = root / "pool.js"
                ledger = root / "ledger"
                initial = sync_recommendation_reservoir(
                    data,
                    output,
                    ledger,
                    generated_ms=1_800_000_000_000,
                    browser_limit=40,
                    reserve_low_water=1,
                    reserve_high_water=40,
                )
                original_entries = load_recommendation_ledger(ledger)
                decided_id = initial["items"][0]["n"]
                decided_family = initial["items"][0]["_conceptFamily"]
                family_ids = {
                    int(entry["n"])
                    for entry in original_entries
                    if _concept_family(entry["item"]) == decided_family
                }
                self.assertGreaterEqual(len(family_ids), 2)
                feedback_path = root / "feedback.json"
                feedback_path.write_text(json.dumps({
                    "t": 1_800_000_010_000,
                    "decisions": [{"n": decided_id, "status": status, "updatedAt": 1_800_000_010_000}],
                }), encoding="utf-8")
                refreshed = sync_recommendation_reservoir(
                    data,
                    output,
                    ledger,
                    feedback=load_feedback(feedback_path),
                    generated_ms=1_800_000_011_000,
                    browser_limit=40,
                    reserve_low_water=0,
                    reserve_high_water=0,
                )
                current_entries = load_recommendation_ledger(ledger)
                self.assertEqual(refreshed["feedbackT"], 1_800_000_010_000)
                self.assertFalse(any(row["_conceptFamily"] == decided_family for row in refreshed["items"]))
                self.assertEqual(
                    refreshed["ledger"]["pending"],
                    initial["ledger"]["pending"] - len(family_ids),
                )
                self.assertEqual({int(entry["n"]) for entry in current_entries}, {int(entry["n"]) for entry in original_entries})
                self.assertTrue(family_ids.issubset({int(entry["n"]) for entry in current_entries}))

    def test_edited_title_overrides_the_rehydrated_recipe_without_mutating_the_ledger(self):
        data = self.source_data(80)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "pool.js"
            ledger = root / "ledger"
            initial = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_000_000,
                browser_limit=40,
                reserve_low_water=1,
                reserve_high_water=40,
            )
            edited_id = initial["items"][0]["n"]
            original_entries = load_recommendation_ledger(ledger)
            stored_title = next(entry["item"]["title"] for entry in original_entries if entry["n"] == edited_id)
            feedback_path = root / "feedback.json"
            feedback_path.write_text(json.dumps({
                "t": 1_800_000_010_000,
                "decisions": [{
                    "n": edited_id,
                    "editedTitle": "A Distinct Team-Edited Title",
                    "updatedAt": 1_800_000_010_000,
                }],
            }), encoding="utf-8")
            refreshed = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                feedback=load_feedback(feedback_path),
                generated_ms=1_800_000_011_000,
                browser_limit=40,
                reserve_low_water=0,
                reserve_high_water=0,
            )
            edited = next(row for row in refreshed["items"] if row["n"] == edited_id)
            self.assertEqual(edited["title"], "A Distinct Team-Edited Title")
            self.assertTrue(edited["_titleFamily"].startswith("edited|"))
            self.assertEqual(
                next(entry["item"]["title"] for entry in load_recommendation_ledger(ledger) if entry["n"] == edited_id),
                stored_title,
            )

    def test_weak_sources_leave_an_empty_truthful_ledger_instead_of_filler(self):
        data = {
            "all": [{
                "vid": "weak-source",
                "title": "Weak instrumental source",
                "genre": "Lofi",
                "cluster": "Study",
                "views": 5_000,
                "vpm": 1_000,
                "ageM": 1,
            }],
            "recos": [],
            "videoMetricsT": 123456,
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snapshot = root / "snapshot.js"
            output = root / "pool.js"
            ledger = root / "ledger"
            self.write_snapshot(snapshot, data)
            payload = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_000_000,
                browser_limit=50,
                reserve_low_water=10,
                reserve_high_water=50,
            )
            self.assertEqual(payload["items"], [])
            self.assertEqual(payload["ledger"]["total"], 0)
            validate_recommendation_reservoir(snapshot, output, ledger, browser_limit=50)

    def test_shared_edit_contract_accepts_edited_desc(self):
        updated = _apply_feedback(
            {"n": -1, "title": "Original", "desc": "Old description"},
            {"n": -1, "editedDesc": "Team-edited description", "updatedAt": 44},
        )
        self.assertEqual(updated["desc"], "Team-edited description")
        self.assertEqual(updated["_sharedFeedbackT"], 44)

    def test_published_outcome_uses_only_exact_observed_history_with_recency_weights(self):
        item = {
            "n": -3_000_000_000_111,
            "title": "Measured Lofi Study",
            "genre": "Lofi",
            "niche": "Study",
            "_genreKey": "lofi",
            "_purposeKey": "study",
            "_settingKey": "library",
            "_sourceVideoId": "market-source",
            "_generatorVersion": 3,
        }
        entry = _ledger_record(item, None, created_ms=1, source_t=1)
        end = 1_800_000_000_000
        start = end - 86_400_000
        history = {
            f"owned-{index}": [[start, 10_000], [end, 10_000 + (index + 1) * 1_000]]
            for index in range(6)
        }
        feedback = {"rows": [{"n": item["n"], "status": "published", "publishedVideoId": "owned-5"}]}

        def profile_for_age(age):
            ours = [
                {"vid": f"owned-{index}", "ageM": age if index == 5 else 1}
                for index in range(6)
            ]
            return _published_performance_profile({"ours": ours}, [entry], feedback, history)

        recent = _feedback_affinity({"publishedPerformance": profile_for_age(1)}, "lofi", "study")
        middle = _feedback_affinity({"publishedPerformance": profile_for_age(4)}, "lofi", "study")
        older = _feedback_affinity({"publishedPerformance": profile_for_age(8)}, "lofi", "study")
        self.assertGreater(recent, middle)
        self.assertGreater(middle, older)
        self.assertGreater(older, 0)
        self.assertEqual(
            _published_performance_profile({"ours": [{"vid": "owned-5", "ageM": 1}]}, [entry], feedback, {}),
            {"genre": {}, "purpose": {}, "combo": {}},
        )
        duplicate_ours = [{"vid": f"owned-{index}", "ageM": 1} for index in range(6)] + [{"vid": "owned-5", "ageM": 1}]
        duplicate_profile = _published_performance_profile({"ours": duplicate_ours}, [entry], feedback, history)
        self.assertEqual(duplicate_profile, {"genre": {}, "purpose": {}, "combo": {}})

    def test_unknown_or_unidentified_rows_are_not_forced_into_a_genre(self):
        data = {"all": [{"vid": "abcdefghijk", "title": "Unclassified source", "genre": "", "cluster": ""}]}
        self.assertEqual(generate_recommendation_pool(data), [])

    def test_checked_in_real_pool_contains_no_explicit_vocal_source(self):
        root = Path(__file__).resolve().parents[1]
        data = read_snapshot(root / "Lofi_Radar_data.js")
        blocked = {
            str(row.get("vid"))
            for bucket in ("all", "trends", "news")
            for row in data.get(bucket) or []
            if row.get("vid") and _source_has_explicit_vocals(row)
        }
        pool = read_recommendation_pool(root / "Lofi_Radar_recommendation_pool.js")
        self.assertNotIn("lMxC0LCCO70", {row.get("_sourceVideoId") for row in pool.get("items") or []})
        self.assertFalse(blocked.intersection(
            str(row.get("_sourceVideoId")) for row in pool.get("items") or [] if row.get("_sourceVideoId")
        ))
        ledger = load_recommendation_ledger(root / "youtube_recommendation_ledger")
        ledger_sources = {
            str(source_id)
            for entry in ledger
            for source_id in (
                list(entry.get("sourceVideoIds") or [])
                + [((entry.get("item") or {}).get("_sourceVideoId"))]
            )
            if source_id
        }
        self.assertNotIn("lMxC0LCCO70", ledger_sources)
        self.assertFalse(blocked.intersection(ledger_sources))


if __name__ == "__main__":
    unittest.main()
