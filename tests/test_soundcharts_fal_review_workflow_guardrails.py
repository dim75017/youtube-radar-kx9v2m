from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build-soundcharts-fal-review.yml"


class SoundchartsFalReviewWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_runs_after_phase2_and_on_first_main_install(self):
        self.assertIn(
            'workflows: ["Scan Soundcharts Fans Also Like phase 2"]', self.workflow
        )
        self.assertIn("github.event.workflow_run.conclusion == 'success'", self.workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", self.workflow)
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("push:", self.workflow)

    def test_is_read_only_and_spends_no_soundcharts_quota(self):
        self.assertIn("actions: read", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        forbidden = (
            "SOUNDCHARTS_APP_ID",
            "SOUNDCHARTS_API_KEY",
            "refresh_soundcharts",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
            "Spotify_Soundcharts_data.js",
        )
        for token in forbidden:
            self.assertNotIn(token, self.workflow)

    def test_manifest_rows_are_ephemeral_and_only_aggregate_summary_is_uploaded(self):
        self.assertIn("soundcharts-fal-phase2-state-v3", self.workflow)
        self.assertIn("build_soundcharts_fal_review_manifest.py", self.workflow)
        self.assertIn("unknown_ai_never_promotion_ready", self.workflow)
        self.assertIn("records_digest", self.workflow)
        self.assertIn("phase2_state_sha256", self.workflow)
        self.assertIn("canonical_written", self.workflow)
        self.assertIn("dashboard_written", self.workflow)
        self.assertIn("soundcharts-fal-review-summary-v1", self.workflow)
        self.assertIn("source.unlink()", self.workflow)
        self.assertIn(
            'source.with_name("soundcharts-fal-review-manifest-v1.tsv").unlink()',
            self.workflow,
        )
        self.assertNotIn(
            "${{ env.REVIEW_DIR }}/soundcharts-fal-review-manifest-v1.json",
            self.workflow,
        )
        self.assertNotIn(
            "${{ env.REVIEW_DIR }}/soundcharts-fal-review-manifest-v1.tsv",
            self.workflow,
        )
        self.assertIn("retention-days: 90", self.workflow)


if __name__ == "__main__":
    unittest.main()
