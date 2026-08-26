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
    RECIPE_VERSION,
    SCORING_VERSION,
    TITLE_FALLBACK_HOOKS,
    TITLE_GENRE_FALLBACK_HOOKS,
    TITLE_HOOK_VARIANTS,
    TITLE_MEASURED_DETAIL_THEMES,
    TITLE_MEASURED_THEMES,
    TITLE_RECIPE_VERSION,
    _apply_feedback,
    _build_id,
    _build_feedback_profile,
    _concept_family,
    _compose_candidate_title,
    _feedback_affinity,
    _freshness_weight,
    _ledger_record,
    _legacy_recommendation_id,
    _potential_for_score,
    _purpose_key,
    _published_performance_profile,
    _rehydrate_presentation,
    _source_has_explicit_vocals,
    _source_rows,
    _source_profile_key,
    _select_title_style,
    _title_model,
    _title_hook,
    _title_style_key,
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
            genre = genres[index % len(genres)]
            rows.append(
                {
                    "vid": f"v{index:010d}",
                    "title": f"Measured {genre} instrumental source {index}",
                    "genre": genre,
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

    def test_pool_keeps_only_distinct_measured_hypotheses_without_forced_settings(self):
        data = self.source_data()
        first = generate_recommendation_pool(data, max_items=1300)
        second = generate_recommendation_pool(data, max_items=1300)
        self.assertGreater(len(first), 0)
        self.assertLessEqual(len(first), len(data["all"]))
        self.assertEqual(
            [(row["n"], row["title"]) for row in first],
            [(row["n"], row["title"]) for row in second],
        )
        self.assertEqual(len({row["n"] for row in first}), len(first))
        self.assertEqual(len({row["title"].casefold() for row in first}), len(first))
        title_families = Counter(row["_titleFamily"] for row in first)
        self.assertGreaterEqual(len(title_families), len({row["_genreKey"] for row in first}))
        self.assertTrue(all(row["_conceptFamily"] == _concept_family(row) for row in first))
        source_titles = {row["title"] for row in data["all"]}
        self.assertTrue(all(row["title"] not in source_titles for row in first))
        self.assertTrue(all(row["_generated"] for row in first))
        self.assertEqual(GENERATOR_VERSION, 4)
        self.assertTrue(all(row["_generatorVersion"] == GENERATOR_VERSION for row in first))
        self.assertEqual(SCORING_VERSION, 5)
        self.assertTrue(all(row["_scoringVersion"] == SCORING_VERSION for row in first))
        self.assertTrue(all(row["_sourceWindow"] in {"0-3m", "3-6m", "6-12m"} for row in first))
        self.assertTrue(all(0 <= row["_sourceAgeM"] <= 12 for row in first))
        self.assertTrue(all(not row.get("_settingKey") for row in first))
        self.assertTrue(all(row["_topicKey"] and row["_titleStyleKey"] for row in first))
        self.assertTrue(all(row["_genreKey"] and row["_purposeKey"] for row in first))
        self.assertEqual(max(Counter(row["_sourceVideoId"] for row in first).values()), 1)
        self.assertTrue(all(not re.search(r"\b([a-z]+)\s+\1\b", row["title"].casefold()) for row in first))
        self.assertTrue(all("Signal marché" in row["noteData"] for row in first))

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
        self.assertEqual(len(rows), 1)
        self.assertTrue(all(row["_genreKey"] == "lofi" for row in rows))
        self.assertTrue(all("Lofi" in row["genre"] for row in rows))
        self.assertTrue(all(row["_purposeKey"] == "study" for row in rows))
        self.assertTrue(all(row["_sourceWindow"] == "0-3m" for row in rows))
        self.assertNotIn("_legacyN", rows[0])

    def test_all_history_is_eligible_with_freshness_but_evergreen_strength_remains_authoritative(self):
        rows = [
            {"vid": "recent00001", "title": "Summer lofi focus", "genre": "Lofi", "cluster": "Study", "views": 150_000, "vpm": 50_000, "ageM": 2},
            {"vid": "middle00001", "title": "Winter lofi focus", "genre": "Lofi", "cluster": "Study", "views": 150_000, "vpm": 50_000, "ageM": 8},
            {"vid": "stale000001", "title": "Rainy lofi focus", "genre": "Lofi", "cluster": "Study", "views": 150_000, "vpm": 50_000, "ageM": 30},
            {"vid": "strongold01", "title": "90s lofi focus", "genre": "Lofi", "cluster": "Study", "views": 90_000_000, "vpm": 900_000, "ageM": 80},
        ]
        generated = generate_recommendation_pool({"all": rows, "recos": []})
        by_id = {row["_sourceVideoId"]: row for row in generated}
        self.assertEqual(set(by_id), {row["vid"] for row in rows})
        self.assertEqual(by_id["stale000001"]["_sourceWindow"], "12m+")
        self.assertEqual(by_id["recent00001"]["score"], by_id["middle00001"]["score"])
        self.assertEqual(by_id["middle00001"]["score"], by_id["stale000001"]["score"])
        self.assertGreater(by_id["strongold01"]["score"], by_id["recent00001"]["score"])
        ordered_ids = [row["_sourceVideoId"] for row in generated]
        self.assertLess(ordered_ids.index("recent00001"), ordered_ids.index("middle00001"))
        self.assertLess(ordered_ids.index("middle00001"), ordered_ids.index("stale000001"))
        self.assertGreater(_freshness_weight(2), _freshness_weight(8))
        self.assertGreater(_freshness_weight(8), _freshness_weight(30))
        self.assertGreater(_freshness_weight(30), 0)

    def test_source_ranking_keeps_a_recent_floor_without_cutting_strong_evergreen(self):
        recent = [
            {
                "vid": f"recent-{index:03d}", "title": f"Lofi focus session {index}",
                "genre": "Lofi", "cluster": "Study", "views": 300_000,
                "vpm": 60_000, "ageM": 2,
            }
            for index in range(30)
        ]
        evergreen = [
            {
                "vid": f"evergreen-{index:03d}", "title": f"Lofi archive session {index}",
                "genre": "Lofi", "cluster": "Study",
                "views": 100_000_000 if index < 8 else 2_000_000,
                "vpm": 2_000_000 if index < 8 else 200_000,
                "ageM": 48,
            }
            for index in range(70)
        ]
        ranked = _source_rows({"all": evergreen + recent}, {})
        top_50_ids = {row["vid"] for row in ranked[:50]}
        self.assertGreaterEqual(sum(video_id.startswith("recent-") for video_id in top_50_ids), 20)
        self.assertTrue(any(video_id.startswith("evergreen-00") for video_id in top_50_ids))
        self.assertEqual(len(ranked), 100)
        self.assertTrue(any(row["ageM"] > 12 for row in ranked))

    def test_explicit_title_genre_fails_closed_and_duplicate_prefers_coherent_scan(self):
        for index, title in enumerate((
            "Temple Rhythms for focus",
            "Native-American flute ceremony",
            "Dreamy trap beats",
            "Soft pop hits",
            "Japanese Zen for focus",
            "Fantasy Celtic ambience",
            "Medieval tavern for D&D",
            "4K Nature Relaxation Film",
        )):
            row = {
                "vid": f"blocked-{index}", "title": title,
                "genre": "Ambient" if "4K" in title else "Lofi",
                "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
            }
            self.assertEqual(_source_rows({"all": [row]}, {}), [], title)

        conflict = {
            "vid": "genre-conflict", "title": "Calm classical orchestra for reading", "genre": "Lofi",
            "cluster": "Reading", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertEqual(generate_recommendation_pool({"all": [conflict]})[0]["_genreKey"], "classical")

        incoherent = {
            "vid": "duplicate-genre", "title": "Midnight jazz session", "genre": "Lofi",
            "cluster": "Relax", "views": 20_000_000, "vpm": 900_000, "ageM": 2,
        }
        coherent = dict(incoherent, genre="Jazz", views=500_000, vpm=80_000)
        selected = _source_rows({"all": [incoherent], "trends": [coherent]}, {})
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["genre"], "Jazz")
        self.assertEqual(selected[0]["views"], 500_000)

    def test_score_to_potential_contract_includes_a_rare_s_tier(self):
        self.assertTrue(_potential_for_score(94).startswith("A"))
        self.assertTrue(_potential_for_score(95).startswith("S"))
        self.assertTrue(_potential_for_score(87).startswith("B"))

        evidence = {
            "title": "Lofi focus session", "genre": "Lofi", "cluster": "Study",
            "views": 10_000_000, "vpm": 1_000_000,
        }
        recent = generate_recommendation_pool({"all": [dict(evidence, vid="recent-tier", ageM=1)]})[0]
        old = generate_recommendation_pool({"all": [dict(evidence, vid="old-tier", ageM=80)]})[0]
        self.assertEqual(recent["score"], old["score"])
        self.assertEqual(recent["pot"], old["pot"])
        self.assertTrue(recent["pot"].startswith("A"))
        self.assertFalse(recent["pot"].startswith("S"))

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
            "Ambient Tibetan singing bowls for sleep",
            "Ambient forest birds singing at dawn",
            "Instrumental jazz tunes for study",
        ):
            row = dict(
                base,
                vid=f"safe-{len(title)}",
                title=title,
                genre="Ambient" if title.startswith("Ambient") else "Jazz",
            )
            self.assertFalse(_source_has_explicit_vocals(row), title)
            self.assertTrue(generate_recommendation_pool({"all": [row], "recos": []}), title)

    def test_shared_feedback_profile_changes_seed_ranking_but_stays_bounded(self):
        sources = [
            {"vid": "ambient001", "title": "Ambient study session", "genre": "Ambient", "cluster": "Study", "views": 500_000, "vpm": 100_000, "ageM": 2},
            {"vid": "ambient002", "title": "Ambient unwind session", "genre": "Ambient", "cluster": "Relax", "views": 500_000, "vpm": 100_000, "ageM": 2},
            {"vid": "lofi0000001", "title": "Lofi study session", "genre": "Lofi", "cluster": "Study", "views": 500_000, "vpm": 100_000, "ageM": 2},
        ]
        decisions = [
            *({"valid": "x", "genre": "Lofi", "title": f"Accepted lofi study {index}", "niche": "Study"} for index in range(8)),
            *({"valid": "-", "genre": "Ambient", "title": f"Refused ambient study {index}", "niche": "Study"} for index in range(8)),
        ]
        generated = generate_recommendation_pool({"all": sources, "recos": decisions})
        self.assertEqual(generated[0]["_sourceVideoId"], "lofi0000001")
        lofi = next(row for row in generated if row["_sourceVideoId"] == "lofi0000001")
        ambient = next(row for row in generated if row["_sourceVideoId"] == "ambient002")
        self.assertNotIn("ambient001", {row["_sourceVideoId"] for row in generated})
        self.assertGreater(lofi["_feedbackAffinity"], 0)
        self.assertLess(ambient["_feedbackAffinity"], 0)
        self.assertTrue(all(-1 <= row["_feedbackAffinity"] <= 1 for row in generated))

    def test_v4_generation_is_input_order_independent_and_uses_safe_stable_ids(self):
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
        self.assertTrue(all(row["_generatorVersion"] == 4 for row in first))
        self.assertTrue(all(row["_recipeVersion"] == RECIPE_VERSION for row in first))

    def test_model_revision_changes_without_rewriting_stable_v4_ledger_identity(self):
        original = generate_recommendation_pool(self.source_data(40), max_items=80)
        with mock.patch(
            "generate_youtube_recommendation_pool.TITLE_RECIPE_VERSION",
            TITLE_RECIPE_VERSION + 1,
        ):
            rehydrated = [_rehydrate_presentation(row) for row in original]
        self.assertEqual([row["n"] for row in rehydrated], [row["n"] for row in original])
        self.assertEqual([row["_ideaKey"] for row in rehydrated], [row["_ideaKey"] for row in original])
        self.assertEqual([row["title"] for row in rehydrated], [row["title"] for row in original])
        base = {
            "sourceT": 123,
            "feedbackT": 456,
            "ledgerRevision": "stable-ledger",
            "items": original,
            "modelRevision": "model-a",
            "titleRecipeVersion": TITLE_RECIPE_VERSION,
        }
        rotated = dict(base, modelRevision="model-b")
        self.assertNotEqual(_build_id(base), _build_id(rotated))

    def test_stable_id_collision_fails_closed_instead_of_becoming_order_dependent(self):
        with mock.patch("generate_youtube_recommendation_pool._stable_int", return_value=1):
            with self.assertRaisesRegex(ValueError, "collision"):
                generate_recommendation_pool(self.source_data(2), max_items=10)

    def test_bootstrap_preserves_v2_only_as_audit_history_never_active_stock(self):
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
            self.assertEqual(payload["items"], [])
            self.assertEqual([entry["ideaKey"] for entry in entries], [f"legacy:v2:{row['n']}" for row in legacy])
            self.assertTrue(all(entry["generatorVersion"] == 2 for entry in entries))
            validation = validate_recommendation_reservoir(snapshot, output, ledger, browser_limit=20)
            self.assertEqual(validation["recommendations"], 0)

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
                reserve_high_water=5,
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
                reserve_high_water=5,
            )
            self.assertEqual(second["ledger"]["appended"], 0)
            self.assertEqual(shard.read_bytes(), original)
            third = sync_recommendation_reservoir(
                data,
                output,
                ledger,
                generated_ms=1_800_000_002_000,
                browser_limit=30,
                reserve_low_water=6,
                reserve_high_water=20,
            )
            grown = shard.read_bytes()
            self.assertGreater(third["ledger"]["appended"], 0)
            self.assertTrue(grown.startswith(original))
            self.assertEqual(first["items"], second["items"])

    def test_ledger_keeps_one_evidence_bound_row_per_distinct_concept_while_browser_stays_compact(self):
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
            expected = len(generate_recommendation_pool(data, max_items=3_100))
            self.assertGreater(
                payload["ledger"]["total"],
                expected,
                "the perpetual reservoir must materialize more than the former one-expression-per-source baseline",
            )
            self.assertLessEqual(payload["ledger"]["total"], 3_100)
            self.assertEqual(len(payload["items"]), min(75, expected))
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
                self.assertEqual(len(family_ids), 1)
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
            "title": "Old Lofi Study Recommendation",
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
                {
                    "vid": f"owned-{index}",
                    "title": "Midnight Jazz for sleep" if index == 5 else f"Ambient focus session {index}",
                    "genre": "Jazz" if index == 5 else "Ambient",
                    "cluster": "Sleep" if index == 5 else "Study",
                    "ageM": age if index == 5 else 1,
                }
                for index in range(6)
            ]
            return _published_performance_profile({"ours": ours}, [entry], feedback, history)

        recent_profile = profile_for_age(1)
        recent = _feedback_affinity({"publishedPerformance": recent_profile}, "jazz", "sleep")
        middle = _feedback_affinity({"publishedPerformance": profile_for_age(4)}, "jazz", "sleep")
        older = _feedback_affinity({"publishedPerformance": profile_for_age(8)}, "jazz", "sleep")
        self.assertGreater(recent, middle)
        self.assertGreater(middle, older)
        self.assertGreater(older, 0)
        self.assertIn("midnight jazz for sleep", recent_profile["title"])
        self.assertNotIn("old lofi study recommendation", recent_profile["title"])
        self.assertIn("jazz", recent_profile["genre"])
        self.assertNotIn("lofi", recent_profile["genre"])
        self.assertIn("sleep", recent_profile["purpose"])
        self.assertNotIn("study", recent_profile["purpose"])
        self.assertEqual(
            _published_performance_profile({"ours": [{"vid": "owned-5", "title": "Midnight Jazz", "ageM": 1}]}, [entry], feedback, {}),
            {"title": {}, "genre": {}, "purpose": {}, "combo": {}},
        )
        duplicate_ours = [
            {"vid": f"owned-{index}", "title": f"Ambient focus {index}", "genre": "Ambient", "ageM": 1}
            for index in range(6)
        ] + [{"vid": "owned-5", "title": "Midnight Jazz", "genre": "Jazz", "ageM": 1}]
        duplicate_profile = _published_performance_profile({"ours": duplicate_ours}, [entry], feedback, history)
        self.assertEqual(duplicate_profile, {"title": {}, "genre": {}, "purpose": {}, "combo": {}})

    def test_location_is_optional_and_never_invented_without_measured_evidence(self):
        data = {
            "all": [{
                "vid": "market00001", "title": "lofi beats to study and relax",
                "genre": "Lofi", "cluster": "Study", "views": 2_000_000,
                "vpm": 180_000, "ageM": 4,
            }],
            "ours": [{
                "vid": "owned000001", "title": "Deep Work 🎯 [lofi hip hop]",
                "genre": "Lofi", "views": 800_000, "vpm": 160_000, "ageM": 6,
            }],
            "recos": [{
                "valid": "-", "title": "Rainy Library · Quiet Study",
                "genre": "Lofi", "niche": "Study",
            }],
        }
        rows = generate_recommendation_pool(data)
        self.assertEqual(len(rows), 1)
        self.assertFalse(re.search(r"\b(?:library|cafe|café|room|train|city|forest|rooftop)\b", rows[0]["title"], re.I))
        self.assertFalse(rows[0].get("_settingKey"))
        self.assertTrue(rows[0]["_conceptFamily"])
        self.assertIn("aucun décor ou lieu imposé", rows[0]["scene"])

    def test_competitor_seo_and_artist_names_are_rewritten_in_channel_style(self):
        rows = generate_recommendation_pool({
            "all": [
                {
                    "vid": "marketfan001", "title": "REALLY AWESOME FAN SOUND FOR SLEEP | White Noise",
                    "genre": "Nature", "cluster": "Sleep", "views": 4_000_000,
                    "vpm": 300_000, "ageM": 14, "durH": 10,
                },
                {
                    "vid": "marketlofi3", "title": "øneheart x reidenshi - lofi snowfall (1 hour loop)",
                    "genre": "Lofi", "cluster": "Seasons", "views": 3_000_000,
                    "vpm": 250_000, "ageM": 14, "durH": 1,
                },
            ],
            "recos": [],
        })
        by_genre = {row["_genreKey"]: row for row in rows}
        self.assertIn("fan sounds", by_genre["nature"]["title"].casefold())
        self.assertNotRegex(by_genre["nature"]["title"], r"(?i)really awesome|white noise")
        self.assertIn("winter lofi", by_genre["lofi"]["title"].casefold())
        self.assertNotRegex(by_genre["lofi"]["title"], r"(?i)øneheart|reidenshi")

    def test_title_style_is_learned_separately_from_our_winners_by_genre(self):
        data = {
            "all": [
                {"vid": "marketlofi1", "title": "focused lofi beats", "genre": "Lofi", "cluster": "Study", "views": 900_000, "vpm": 120_000, "ageM": 5},
                {"vid": "marketambi1", "title": "deep ambient sleeping sound", "genre": "Ambient", "cluster": "Sleep", "views": 900_000, "vpm": 120_000, "ageM": 5},
            ],
            "ours": [
                {"vid": "ownedlofi01", "title": "1 A.M Study Session 📚 [lofi hip hop]", "views": 20_000_000, "vpm": 500_000, "ageM": 60},
                {"vid": "ownedambi01", "title": "deep sleep music 💤 8 hours of ambient mix", "genre": "Ambient", "views": 700_000, "vpm": 100_000, "ageM": 7},
            ],
            "recos": [],
        }
        rows = {row["_genreKey"]: row for row in generate_recommendation_pool(data)}
        self.assertEqual(rows["lofi"]["_titleStyleKey"], "signature")
        self.assertEqual(rows["ambient"]["_titleStyleKey"], "duration")
        self.assertRegex(rows["lofi"]["title"], r"\[lofi hip hop\]")
        self.assertRegex(rows["ambient"]["title"], r"hours of")
        self.assertEqual(rows["lofi"]["_ownedTitleReferenceVideoId"], "ownedlofi01")
        self.assertEqual(rows["ambient"]["_ownedTitleReferenceVideoId"], "ownedambi01")
        self.assertEqual(rows["lofi"]["_titleReferenceType"], "analyse")
        self.assertEqual(rows["lofi"]["_titleReference"], rows["lofi"]["_ownedTitleReference"])
        self.assertIn("Structure Analyse", rows["lofi"]["noteData"])

    def test_title_reference_provenance_distinguishes_validated_market_and_analyse(self):
        source = {
            "vid": "market-ref-1", "title": "Calm lofi for study", "genre": "Lofi",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 3,
        }
        market = generate_recommendation_pool({"all": [source], "recos": []})[0]
        self.assertEqual(market["_titleReferenceType"], "market")
        self.assertEqual(market["_titleReferenceVideoId"], "market-ref-1")
        self.assertNotIn("_ownedTitleReference", market)
        self.assertIn("Structure marché", market["noteData"])
        self.assertNotIn("Structure Analyse", market["noteData"])

        validated = generate_recommendation_pool({
            "all": [source],
            "recos": [{
                "valid": "X", "title": "Quiet Focus | beats to study to",
                "genre": "Lofi", "niche": "Study",
            }],
        })[0]
        self.assertEqual(validated["_titleReferenceType"], "validated")
        self.assertEqual(validated["_titleReference"], "Quiet Focus | beats to study to")
        self.assertNotIn("_ownedTitleReference", validated)
        self.assertIn("Structure validée", validated["noteData"])
        self.assertNotIn("Structure Analyse", validated["noteData"])

    def test_owned_title_model_uses_observed_recent_history_within_each_genre(self):
        end = 1_800_000_000_000
        start = end - 30 * 86_400_000
        data = {
            "all": [{
                "vid": "marketlofi2", "title": "calm lofi focus beats", "genre": "Lofi",
                "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 4,
            }],
            "ours": [
                {
                    "vid": "ownedsign01", "title": "Deep Work 🎯 [lofi hip hop]",
                    "genre": "Lofi", "views": 10_000_000, "vpm": 400_000, "ageM": 5,
                },
                {
                    "vid": "ownedpipe01", "title": "Quiet Focus | beats to study to",
                    "genre": "Lofi", "views": 500_000, "vpm": 20_000, "ageM": 5,
                },
            ],
            "recos": [],
        }
        without_history = generate_recommendation_pool(data)[0]
        with_history = generate_recommendation_pool(data, history={
            "ownedsign01": [[start, 1_000_000], [end, 1_010_000]],
            "ownedpipe01": [[start, 100_000], [end, 1_100_000]],
        })[0]
        self.assertEqual(without_history["_titleStyleKey"], "signature")
        self.assertEqual(with_history["_titleStyleKey"], "pipe")
        self.assertEqual(with_history["_ownedTitleReferenceVideoId"], "ownedpipe01")

    def test_refusal_vetoes_exact_title_and_concept_without_blocking_the_style(self):
        base_source = {
            "vid": "marketstyle1", "title": "calm lofi for study", "genre": "Lofi",
            "cluster": "Study", "views": 1_000_000, "vpm": 150_000, "ageM": 3,
        }
        refused = generate_recommendation_pool({
            "all": [base_source],
            "recos": [{"valid": "-", "title": "Quiet lofi to sleep to", "genre": "Lofi", "niche": "Sleep"}],
        })
        self.assertTrue(refused)
        self.assertEqual(refused[0]["_titleStyleKey"], "use_case")
        self.assertEqual(refused[0]["_editorialTitleAffinity"], 0)

        exact_refusal = generate_recommendation_pool({
            "all": [base_source],
            "recos": [{
                "valid": "-", "title": refused[0]["title"],
                "genre": refused[0]["genre"], "niche": refused[0]["niche"],
            }],
        })
        self.assertEqual(exact_refusal, [])

        accepted = generate_recommendation_pool({
            "all": [base_source],
            "recos": [{"valid": "X", "title": "Quiet Focus | beats to study to", "genre": "Lofi", "niche": "Study"}],
        })
        self.assertTrue(accepted)
        self.assertEqual(accepted[0]["_titleStyleKey"], "pipe")

    def test_refused_topic_veto_crosses_purpose_and_normalizes_a_light_suffix(self):
        midnight_blues = {
            "vid": "market-blues", "title": "Midnight blues for deep focus", "genre": "Guitar",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertEqual(generate_recommendation_pool({
            "all": [midnight_blues],
            "recos": [{
                "valid": "-", "title": "Midnight Blues 🎸 slow blues after dark",
                "genre": "Guitar", "niche": "Relax",
            }],
        }), [])

        rain_ambient = {
            "vid": "market-rain-ambient", "title": "Rain ambient for focus", "genre": "Ambient",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertEqual(generate_recommendation_pool({
            "all": [rain_ambient],
            "recos": [{
                "valid": "-", "title": "Rain Ambient Hybrid | music dissolved in rain",
                "genre": "Ambient", "niche": "Sleep",
            }],
        }), [])

        nature_rain = {
            "vid": "market-nature-rain", "title": "Rain sounds for focus", "genre": "Nature",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertTrue(generate_recommendation_pool({
            "all": [nature_rain],
            "recos": [{
                "valid": "-", "title": "Rain Ambient Hybrid | music dissolved in rain",
                "genre": "Ambient", "niche": "Sleep",
            }],
        }))

        generic_lofi = {
            "vid": "market-generic-lofi", "title": "Measured lofi instrumental mix", "genre": "Lofi",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertEqual(generate_recommendation_pool({
            "all": [generic_lofi],
            "recos": [{
                "valid": "-", "title": "Lofi Mix | beats to relax/study to",
                "genre": "Lofi", "niche": "Study",
            }],
        }), [])

        night_drive = {
            "vid": "market-night-drive", "title": "Night Drive synthwave mix", "genre": "Synthwave",
            "cluster": "Relax", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
        }
        self.assertEqual(generate_recommendation_pool({
            "all": [night_drive],
            "recos": [{
                "valid": "-", "title": "Night Drive in Osaka 🚗 [lofi hip hop]",
                "genre": "Lofi", "niche": "Relax",
            }],
        }), [])
        self.assertTrue(generate_recommendation_pool({
            "all": [{
                **night_drive, "vid": "market-coding", "title": "Coding synthwave music",
            }],
            "recos": [{
                "valid": "-", "title": "Night Drive in Osaka 🚗 [lofi hip hop]",
                "genre": "Lofi", "niche": "Relax",
            }],
        }))

    def test_edited_feedback_title_overrides_stale_genre_and_purpose_metadata(self):
        old = {
            "n": -42, "valid": "", "title": "Old Lofi Focus", "genre": "Lofi",
            "niche": "Study", "_genreKey": "lofi", "_purposeKey": "study",
        }
        edited = _apply_feedback(old, {
            "n": -42, "status": "validated", "editedTitle": "Soft Jazz for deep sleep",
        })
        profile = _build_feedback_profile({"recos": [edited]})
        self.assertIn("jazz", profile["genre"])
        self.assertNotIn("lofi", profile["genre"])
        self.assertIn("sleep", profile["purpose"])
        self.assertNotIn("study", profile["purpose"])
        self.assertIn(("jazz", "sleep"), profile["combo"])

        direct_profile = _build_feedback_profile({"recos": [{
            **old, "valid": "X", "editedTitle": "Soft Jazz for deep sleep",
        }]})
        self.assertIn(("jazz", "sleep"), direct_profile["combo"])

        neutral = _apply_feedback(old, {
            "n": -42, "status": "validated", "editedTitle": "Quiet Evening",
        })
        neutral_profile = _build_feedback_profile({"recos": [neutral]})
        self.assertEqual(neutral_profile["genre"], {})
        self.assertIn("relax", neutral_profile["purpose"])
        self.assertNotIn("study", neutral_profile["purpose"])

    def test_unsafe_unmapped_competitor_hooks_fall_back_without_copying(self):
        unsafe = (
            "Cozy Cyberpunk Loft", "Chill Cybernetic Terrace", "Dance of Life",
            "Harry Potter at Hogwarts", "Mozart Effect in 432Hz", "Use this for your Vagus Nerve",
            "Idea 22", "you're sitting in Narnia", "Of Celtic Harp Music", "4K Fantasy Fragment",
            "The Hobbit and Lord of the Rings", "Polar Express", "Skyrim and Zora",
            "Bon Iver • St Vincent",
        )
        for index, title in enumerate(unsafe):
            row = {
                "vid": f"unsafe-{index}", "title": f"Ambient • {title}", "genre": "Ambient",
                "cluster": "Relax", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
            }
            generated = generate_recommendation_pool({"all": [row]})
            if "Celtic" in title:
                self.assertEqual(generated, [])
                continue
            self.assertTrue(generated, title)
            self.assertNotIn(title.casefold(), generated[0]["title"].casefold())
            self.assertEqual(generated[0]["_topicFamilyKey"], "ambient mix")
            self.assertIn(generated[0]["_topicKey"], {
                value.casefold() for value in TITLE_HOOK_VARIANTS["Ambient Mix"]
            })

    def test_style_selection_is_deterministically_distributed_over_analyse_supported_styles(self):
        sources = [
            {
                "vid": f"style-source-{index:02d}", "title": f"Measured instrumental angle {index}",
                "genre": "Lofi", "cluster": "Study", "views": 2_000_000 + index,
                "vpm": 200_000, "ageM": 2,
            }
            for index in range(40)
        ]
        ours = [
            {"vid": "own-signature", "title": "Deep Work [lofi hip hop]", "genre": "Lofi", "views": 4_000_000, "vpm": 300_000, "ageM": 3},
            {"vid": "own-pipe", "title": "Quiet Focus | beats to study to", "genre": "Lofi", "views": 3_000_000, "vpm": 250_000, "ageM": 3},
            {"vid": "own-duration", "title": "3 hours of lofi for focus", "genre": "Lofi", "views": 2_000_000, "vpm": 200_000, "ageM": 3},
        ]
        for row in sources:
            row["title"] = "Measured lofi instrumental angle"
        data = {"all": sources, "ours": ours}
        verified_sources = _source_rows(data, {})
        model = _title_model(data, verified_sources, {})
        first = [
            _select_title_style(row, model, "lofi", "study")
            for row in verified_sources
        ]
        second = [
            _select_title_style(row, model, "lofi", "study")
            for row in verified_sources
        ]
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(set(first)), 2)

    def test_owned_genre_affinity_is_global_performance_relative_and_support_weighted(self):
        rows = generate_recommendation_pool({
            "all": [
                {"vid": "market-lofi", "title": "Lofi focus session", "genre": "Lofi", "cluster": "Study", "views": 1_000_000, "vpm": 120_000, "ageM": 2},
                {"vid": "market-ambi", "title": "Ambient sleep soundscape", "genre": "Ambient", "cluster": "Sleep", "views": 1_000_000, "vpm": 120_000, "ageM": 2},
            ],
            "ours": [
                {"vid": "own-lofi-1", "title": "Deep Work [lofi hip hop]", "genre": "Lofi", "views": 20_000_000, "vpm": 600_000, "ageM": 2},
                {"vid": "own-lofi-2", "title": "Lofi study session", "genre": "Lofi", "views": 10_000_000, "vpm": 400_000, "ageM": 4},
                {"vid": "own-ambi-1", "title": "Ambient sleep soundscape", "genre": "Ambient", "views": 250_000, "vpm": 35_000, "ageM": 2},
                {"vid": "own-ambi-2", "title": "Ambient meditation mix", "genre": "Ambient", "views": 150_000, "vpm": 30_000, "ageM": 4},
            ],
            "recos": [],
        })
        by_genre = {row["_genreKey"]: row for row in rows}
        self.assertGreater(by_genre["lofi"]["_ownedGenreAffinity"], 0)
        self.assertLess(by_genre["ambient"]["_ownedGenreAffinity"], 0)
        self.assertGreater(
            by_genre["lofi"]["_ownedGenreAffinity"],
            by_genre["ambient"]["_ownedGenreAffinity"],
        )

    def test_current_projection_relearns_titles_even_when_ledger_appends_nothing(self):
        data = {
            "all": [{"vid": "marketsame01", "title": "measured lofi focus beats", "genre": "Lofi", "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2}],
            "ours": [{"vid": "ownedstyle1", "title": "Deep Work 🎯 [lofi hip hop]", "views": 1_000_000, "vpm": 200_000, "ageM": 3}],
            "recos": [], "videoMetricsT": 123,
        }
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output, ledger = root / "pool.js", root / "ledger"
            first = sync_recommendation_reservoir(data, output, ledger, generated_ms=1000, reserve_high_water=20)
            changed = dict(data)
            changed["ours"] = [{"vid": "ownedstyle1", "title": "Deep Work | beats to study to", "views": 1_100_000, "vpm": 220_000, "ageM": 3}]
            second = sync_recommendation_reservoir(changed, output, ledger, generated_ms=2000, reserve_high_water=20)
            self.assertEqual(second["ledger"]["appended"], 0)
            self.assertEqual(first["items"][0]["n"], second["items"][0]["n"])
            self.assertNotEqual(first["items"][0]["title"], second["items"][0]["title"])
            self.assertNotEqual(first["modelRevision"], second["modelRevision"])

    def test_feedback_snapshot_regression_preserves_the_prior_pool(self):
        data = self.source_data(4)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output, ledger = root / "pool.js", root / "ledger"
            first = sync_recommendation_reservoir(
                data, output, ledger, feedback={"t": 200, "rows": []}, generated_ms=1000, reserve_high_water=10,
            )
            raw = output.read_bytes()
            with self.assertRaisesRegex(ValueError, "feedback snapshot regressed"):
                sync_recommendation_reservoir(
                    data, output, ledger, feedback={"t": 199, "rows": []}, generated_ms=2000, reserve_high_water=10,
                )
            self.assertEqual(output.read_bytes(), raw)
            self.assertEqual(first["feedbackT"], 200)

    def test_unknown_or_unidentified_rows_are_not_forced_into_a_genre(self):
        data = {"all": [{"vid": "abcdefghijk", "title": "Unclassified source", "genre": "", "cluster": ""}]}
        self.assertEqual(generate_recommendation_pool(data), [])

    def test_nature_tokens_are_word_bounded_and_never_match_brain_or_train(self):
        self.assertIsNone(_source_profile_key({
            "title": "Instant Focus Mode - 40Hz Gamma Brainwave Music", "genre": "Nature",
        }))
        self.assertIsNone(_source_profile_key({
            "title": "music to heal you from brain rot", "genre": "Nature",
        }))
        self.assertIsNone(_source_profile_key({
            "title": "Night Train Music", "genre": "Nature",
        }))
        self.assertEqual(_source_profile_key({
            "title": "Night Rain Sounds", "genre": "Nature",
        }), "nature")

    def test_nature_requires_audio_context_not_artist_place_or_fantasy_words(self):
        false_nature = (
            "Chill playlist - Jhene Aiko, H.E.R. and Frank Ocean",
            "Relaxing Italian Music with Ocean View Homes",
            "Focus Like a CEO - Midnight Ocean Penthouse Mix",
            "THE FAIRY RIVER | Magical Fantasy Music & Ambience",
            "Fairy Lands | FANTASY MUSIC in a Magical Forest",
        )
        for title in false_nature:
            with self.subTest(title=title):
                self.assertIsNone(_source_profile_key({"title": title, "genre": "Nature"}))
        self.assertEqual(_source_profile_key({
            "title": "Ocean Waves and Gentle Sea Sounds for Sleep", "genre": "Nature",
        }), "nature")

    def test_generated_v4_never_copies_competitor_keywords(self):
        rows = generate_recommendation_pool({"all": [{
            "vid": "safe-title-unsafe-seo", "title": "Summer lofi instrumental mix", "genre": "Lofi",
            "cluster": "Study", "views": 2_000_000, "vpm": 200_000, "ageM": 2,
            "kw": "ghibli lofi; healing ambient music; music for adhd focus",
        }]})
        self.assertTrue(rows)
        self.assertEqual(rows[0]["kw"], "")

    def test_source_title_purpose_overrides_stale_cluster_but_cluster_remains_fallback(self):
        self.assertEqual(_purpose_key({
            "title": "Calm lofi beats to relax to", "cluster": "Sleep / night",
        }), "relax")
        self.assertEqual(_purpose_key({
            "title": "Jazz for study and focus", "cluster": "Reading / books",
        }), "study")
        self.assertEqual(_purpose_key({
            "title": "Summer lofi chill beats to relax to", "cluster": "Sleep / night",
        }), "season")
        self.assertEqual(_purpose_key({
            "title": "Untitled instrumental", "cluster": "Sleep / night",
        }), "sleep")
        self.assertEqual(_purpose_key({
            "title": "Relaxing Music with Nature Sounds - Waterfall HD", "cluster": "Seasons / moments",
        }), "relax")

    def test_measured_theme_labels_never_add_rain_or_water_without_evidence(self):
        def hook_choices(label):
            return set(TITLE_HOOK_VARIANTS.get(label) or (label,))

        cases = (
            ("Calm cello instrumental for sleep", "sleep", "classical", "Calm Cello"),
            ("Cello with rain for sleep", "sleep", "classical", "Cello & Rain"),
            ("Piano with water sounds", "sleep", "piano", "Piano & Water Sounds"),
            ("Piano and rain sounds", "sleep", "piano", "Piano & Rain"),
            ("Zen meditation ambient", "relax", "ambient", "Meditation Ambient"),
            ("Water meditation ambient", "relax", "ambient", "Water Meditation"),
            ("Coffee shop jazz", "study", "jazz", "Coffee Jazz"),
            ("Jazz for the night", "relax", "jazz", "Night Jazz"),
            ("Midnight jazz", "relax", "jazz", "Midnight Jazz"),
            ("Late at night piano", "study", "piano", "Night Piano"),
            ("Piano for sleep", "sleep", "piano", "Deep Sleep Piano"),
            ("Sunset house mix", "relax", "house", "Sunset House"),
            ("Summer house mix", "relax", "house", "Summer House"),
            ("Cricket sounds", "sleep", "nature", "Cricket Sounds"),
            ("Summer night cricket sounds", "sleep", "nature", "Summer Night Crickets"),
            ("Delta waves ambient", "sleep", "ambient", "Delta Waves"),
            ("Alpha waves ambient", "sleep", "ambient", "Alpha Waves"),
            ("Slow jazz for the evening", "relax", "jazz", "Slow Jazz"),
            ("Jazz noir", "relax", "jazz", "Jazz Noir"),
            ("Atmospheric drum and bass", "relax", "dnb", "Atmospheric Drum & Bass"),
            ("Liquid drum and bass", "relax", "dnb", "Liquid Drum & Bass"),
        )
        for source_title, purpose, genre, measured_family in cases:
            with self.subTest(source_title=source_title):
                self.assertIn(_title_hook(source_title, purpose, genre), hook_choices(measured_family))

        winter = _compose_candidate_title({"title": "winter ambient mix"}, "ambient", "season", "direct")
        self.assertIn("Winter Stillness", winter)
        self.assertRegex(winter, r"(?i)season")
        atmospheric = _compose_candidate_title(
            {"title": "atmospheric drum and bass"}, "dnb", "relax", "direct",
        )
        self.assertTrue(any(hook in atmospheric for hook in hook_choices("Atmospheric Drum & Bass")))
        self.assertRegex(atmospheric, r"(?i)drum & bass")

    def test_generated_hook_never_contradicts_the_declared_use_case(self):
        cases = (
            (
                {"vid": "piano-mixed-use", "title": "Beautiful Piano Music | Relaxing Music for Focus, Sleep & Relaxation"},
                "piano", "sleep", r"(?i)\bfocus\b",
            ),
            (
                {"vid": "jazz-mixed-use", "title": "3:30 a.m. jazzhop mix [Study / Sleep / Homework Music]"},
                "jazz", "sleep", r"(?i)\b(?:focus|work|task|study)\b",
            ),
            (
                {"vid": "lofi-library", "title": "Cozy Library Lofi — Deep Focus to Work, Study & Relax"},
                "lofi", "reading", r"(?i)\b(?:deep work|deadline|focus block)\b",
            ),
        )
        for source, genre, purpose, contradiction in cases:
            with self.subTest(source=source["title"]):
                title = _compose_candidate_title(source, genre, purpose, "direct")
                self.assertNotRegex(title, contradiction)

    def test_relax_fallback_never_invents_a_work_or_reading_hook(self):
        title = _compose_candidate_title(
            {"vid": "generic-relax", "title": "Endless Sunday 😌 [Chillhop / instrumental beats]"},
            "lofi", "relax", "signature",
        )
        self.assertNotRegex(title, r"(?i)\b(?:deadline|focus|work|chapter|reading)\b")

    def test_title_does_not_repeat_the_genre_as_both_hook_and_tail(self):
        cases = (
            ({"vid": "repeat-jazz", "title": "Just One More Drink -- Jazz Noir"}, "jazz", "relax", "jazz"),
            ({"vid": "repeat-lofi", "title": "summer lofi chill beats"}, "lofi", "season", "lofi"),
            ({"vid": "repeat-piano", "title": "Piano and rain sounds"}, "piano", "sleep", "piano"),
            (
                {"vid": "repeat-guitar", "title": "Beautiful Instrumental Music - Best Acoustic Guitar - Best Relaxing Music"},
                "guitar", "relax", "guitar",
            ),
            ({"vid": "repeat-house", "title": "night drive house mix"}, "house", "relax", "house"),
            ({"vid": "repeat-synthwave", "title": "midnight synthwave mix"}, "synthwave", "relax", "synthwave"),
        )
        for source, genre, purpose, genre_word in cases:
            with self.subTest(genre=genre):
                title = _compose_candidate_title(source, genre, purpose, "direct")
                self.assertLessEqual(title.casefold().count(genre_word), 1, title)

    def test_real_snapshot_generation_has_only_allowlisted_hooks_and_verified_genres(self):
        root = Path(__file__).resolve().parents[1]
        data = read_snapshot(root / "Lofi_Radar_data.js")
        rows = generate_recommendation_pool(data, max_items=2_500)
        self.assertGreaterEqual(len(rows), 100)

        allowed_hooks = {
            label.casefold()
            for themes in (*TITLE_MEASURED_DETAIL_THEMES.values(), *TITLE_MEASURED_THEMES.values())
            for _pattern, label in themes
        } | {
            label.casefold()
            for label in (*TITLE_GENRE_FALLBACK_HOOKS.values(), *TITLE_FALLBACK_HOOKS.values())
        } | {
            value.casefold()
            for variants in TITLE_HOOK_VARIANTS.values()
            for value in variants
        }
        self.assertTrue(all(str(row.get("_topicKey") or "").casefold() in allowed_hooks for row in rows))
        self.assertTrue(all(row.get("_topicFamilyKey") for row in rows))
        self.assertTrue(all(row.get("_titleTemplateKey") for row in rows))
        self.assertTrue(all(row.get("_hookOrigin") in {"measured_detail", "measured_theme", "editorial_fallback"} for row in rows))
        self.assertTrue(all(int(row.get("_specificityScore") or 0) >= 2 for row in rows))

        qualified = [row for row in rows if int(row.get("score") or 0) >= 78]
        generic_families = {
            value.casefold() for value in TITLE_GENRE_FALLBACK_HOOKS.values()
        }
        generic_count = sum(
            str(row.get("_topicFamilyKey") or "").casefold() in generic_families
            for row in qualified
        )
        with self.subTest(quality="generic-family-cap"):
            self.assertLessEqual(
                generic_count,
                len(qualified) // 5,
                f"too many qualified titles still come from generic genre-only families: {generic_count}/{len(qualified)}",
            )
        with self.subTest(quality="measured-hook-required"):
            self.assertFalse(
                [row["title"] for row in qualified if row.get("_hookOrigin") == "editorial_fallback"],
                "qualified ideas must have a measured hook instead of an editorial filler premise",
            )
        with self.subTest(quality="reference-purpose"):
            self.assertFalse(
                [
                    (row["title"], row.get("_titleReference"))
                    for row in qualified
                    if row.get("_titleReference")
                    and row.get("_titleReferencePurposeKey") != row.get("_purposeKey")
                ],
                "title references must match both the musical genre and the candidate use case",
            )

        forbidden = re.compile(
            r"(?i)\b(?:hobbit|lord of the rings|polar express|skyrim|zora|bon iver|st\.? vincent|"
            r"harry potter|hogwarts|narnia|jurassic|bluey|samurai|vagus nerve|healing frequency|"
            r"autism|mozart effect|cyberpunk|cybernetic)\b|^(?:of|4k|idea\s*\d+)\b"
        )
        self.assertFalse(any(forbidden.search(f"{row['title']} {row['_topicKey']}") for row in rows))
        self.assertTrue(all(not str(row.get("kw") or "").strip() for row in rows))

        source_by_id = {}
        for bucket in ("all", "trends", "news"):
            for source in data.get(bucket) or []:
                source_by_id.setdefault(str(source.get("vid") or ""), source)
        for row in rows:
            source = source_by_id[str(row["_sourceVideoId"])]
            self.assertEqual(_source_profile_key(source), row["_genreKey"])

        rejected_source_ids = {
            video_id for video_id, source in source_by_id.items()
            if video_id and _source_profile_key(source) is None
        }
        self.assertFalse(rejected_source_ids.intersection(str(row["_sourceVideoId"]) for row in rows))
        if sum(float(source.get("ageM") or 999) <= 12 for source in source_by_id.values()) >= 20:
            self.assertGreaterEqual(sum(float(row["_sourceAgeM"]) <= 12 for row in rows[:50]), 20)

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
