from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from generate_youtube_recommendation_pool import (
    DAILY_RECOMMENDATION_SCORE_FLOOR,
    load_recommendation_ledger,
    read_snapshot,
    sync_recommendation_reservoir,
)


ROOT = Path(__file__).resolve().parents[1]
DAY_MS = 86_400_000


class PerpetualRecommendationReservoirTests(unittest.TestCase):
    """End-to-end contracts for the autonomous, never-repeating idea supply."""

    @classmethod
    def setUpClass(cls) -> None:
        # The checked-in snapshot is the smallest honest fixture for this
        # contract: it contains competitor signals, our own videos, measured
        # performance and the editorial decisions already collected by the UI.
        cls.data = read_snapshot(ROOT / "Lofi_Radar_data.js")
        cls.day_one = int(datetime(2028, 1, 15, 10, tzinfo=timezone.utc).timestamp() * 1000)

    def sync(self, root: Path, *, generated_ms: int, feedback: dict | None = None, high_water: int = 150) -> dict:
        return sync_recommendation_reservoir(
            self.data,
            root / "pool.js",
            root / "ledger",
            feedback=feedback,
            generated_ms=generated_ms,
            browser_limit=high_water,
            reserve_low_water=50,
            reserve_high_water=high_water,
        )

    def test_identical_snapshot_generates_a_new_qualified_append_only_cohort_each_day(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = self.sync(root, generated_ms=self.day_one)
            first_entries = load_recommendation_ledger(root / "ledger")

            self.assertGreaterEqual(
                sum(int(entry["item"].get("score") or 0) >= DAILY_RECOMMENDATION_SCORE_FLOOR for entry in first_entries),
                50,
                "the first autonomous cohort must contain at least 50 review-worthy ideas",
            )

            # A refresh within the same Paris day is deterministic and
            # idempotent even when the exact generation timestamp differs.
            same_day = self.sync(root, generated_ms=self.day_one + 6 * 60 * 60 * 1000)
            same_day_entries = load_recommendation_ledger(root / "ledger")
            self.assertEqual(same_day["ledger"]["appended"], 0)
            self.assertEqual(
                [(row["n"], row["title"]) for row in same_day["items"]],
                [(row["n"], row["title"]) for row in first["items"]],
                "same inputs and the same daily generation epoch must reproduce the same projection",
            )
            self.assertEqual(same_day_entries, first_entries)

            following_day = self.sync(root, generated_ms=self.day_one + DAY_MS)
            following_entries = load_recommendation_ledger(root / "ledger")
            new_entries = following_entries[len(first_entries):]
            qualified_new = [
                entry for entry in new_entries
                if int(entry["item"].get("score") or 0) >= DAILY_RECOMMENDATION_SCORE_FLOOR
            ]

            self.assertGreaterEqual(
                len(qualified_new),
                50,
                "an unchanged market snapshot must still yield at least 50 genuinely new qualified ideas the next day",
            )
            self.assertGreaterEqual(following_day["ledger"]["appended"], len(qualified_new))
            self.assertEqual(
                following_entries[:len(first_entries)],
                first_entries,
                "daily generation may only append to the durable idea ledger",
            )

            previous = {
                field: {str(entry.get(field) or "") for entry in first_entries}
                for field in ("titleFingerprint", "semanticFingerprint", "conceptFingerprint")
            }
            for field in previous:
                current = [str(entry.get(field) or "") for entry in qualified_new]
                self.assertTrue(all(current), f"every generated idea must persist {field}")
                self.assertEqual(len(current), len(set(current)), f"the new cohort contains duplicate {field} values")
                self.assertTrue(
                    previous[field].isdisjoint(current),
                    f"the next daily cohort repeats a historical {field}",
                )

    def test_central_acceptance_and_refusal_retrain_the_projection_without_rewriting_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            initial = self.sync(root, generated_ms=self.day_one, high_water=500)
            original_entries = load_recommendation_ledger(root / "ledger")

            accepted = [
                row for row in initial["items"]
                if row.get("_genreKey") == "lofi" and row.get("_purposeKey") == "study"
            ][:8]
            refused = [
                row for row in initial["items"]
                if row.get("_genreKey") == "nature" and row.get("_purposeKey") == "sleep"
            ][:8]
            self.assertEqual(len(accepted), 8, "the real fixture must expose enough accepted-learning examples")
            self.assertEqual(len(refused), 8, "the real fixture must expose enough refusal-learning examples")

            feedback_t = self.day_one + 60_000
            feedback = {
                "t": feedback_t,
                "rows": [
                    *(
                        {"n": row["n"], "status": "validated", "updatedAt": feedback_t}
                        for row in accepted
                    ),
                    *(
                        {"n": row["n"], "status": "refused", "updatedAt": feedback_t}
                        for row in refused
                    ),
                ],
            }
            refreshed = self.sync(
                root,
                generated_ms=self.day_one + 2 * 60 * 60 * 1000,
                feedback=feedback,
                high_water=500,
            )

            # Decisions affect the active model, not the audit trail.
            refreshed_entries = load_recommendation_ledger(root / "ledger")
            self.assertEqual(
                refreshed_entries[:len(original_entries)],
                original_entries,
                "learning may append newly eligible hypotheses but cannot rewrite past ledger records",
            )
            decided_ids = {int(row["n"]) for row in accepted + refused}
            decided_families = {str(row.get("_conceptFamily") or "") for row in accepted + refused}
            self.assertTrue(all(int(row["n"]) not in decided_ids for row in refreshed["items"]))
            self.assertTrue(all(str(row.get("_conceptFamily") or "") not in decided_families for row in refreshed["items"]))

            # Accepted and refused siblings continue to teach ranking and
            # packaging in opposite directions. Existing historical feedback
            # may prevent a whole combo from being hard-blocked, so compare the
            # model signal itself instead of assuming an empty genre bucket.
            initial_affinity = {int(row["n"]): float(row.get("_feedbackAffinity") or 0) for row in initial["items"]}
            accepted_siblings = [
                row for row in refreshed["items"]
                if row.get("_genreKey") == "lofi" and row.get("_purposeKey") == "study"
                and int(row["n"]) in initial_affinity
            ]
            refused_siblings = [
                row for row in refreshed["items"]
                if row.get("_genreKey") == "nature" and row.get("_purposeKey") == "sleep"
                and int(row["n"]) in initial_affinity
            ]
            self.assertTrue(accepted_siblings and refused_siblings)
            self.assertGreater(
                sum(float(row.get("_feedbackAffinity") or 0) - initial_affinity[int(row["n"])] for row in accepted_siblings),
                0,
                "validated ideas must increase the learned affinity of their remaining siblings",
            )
            self.assertLess(
                sum(float(row.get("_feedbackAffinity") or 0) - initial_affinity[int(row["n"])] for row in refused_siblings),
                0,
                "refused ideas must decrease the learned affinity of their remaining siblings",
            )


if __name__ == "__main__":
    unittest.main()
