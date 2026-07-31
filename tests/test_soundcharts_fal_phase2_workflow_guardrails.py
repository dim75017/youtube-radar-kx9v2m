from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "scan-soundcharts-fal-phase2.yml"


class SoundchartsFalPhase2WorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_starts_after_successful_main_phase1_and_also_resumes(self):
        self.assertIn('workflows: ["Scan Soundcharts Fans Also Like phase 1"]', self.workflow)
        self.assertIn("types: [completed]", self.workflow)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", self.workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", self.workflow)
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("- cron: '53 8,20 * * *'", self.workflow)
        self.assertIn("Latest phase-1 v2 report is not complete", self.workflow)
        self.assertIn(
            'scope_version != "main_performer_v1"',
            self.workflow,
        )
        self.assertIn(
            "WHERE key='discography_scope_version'",
            self.workflow,
        )
        self.assertIn(
            'scope_marker[0] != "main_performer_v1"',
            self.workflow,
        )

    def test_all_soundcharts_calls_share_the_existing_serial_lock(self):
        self.assertIn(
            "group: refresh-soundcharts-ar-collection-${{ github.ref }}", self.workflow
        )
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_phase1_is_read_only_and_phase2_uses_a_small_separate_state(self):
        self.assertIn("PHASE1_STATE_ARTIFACT: soundcharts-fal-phase1-state-v2", self.workflow)
        self.assertIn("PHASE2_STATE_ARTIFACT: soundcharts-fal-phase2-state-v3", self.workflow)
        self.assertIn("PHASE2_CONTROL_ARTIFACT: soundcharts-fal-phase2-control-v3", self.workflow)
        self.assertIn("soundcharts-fal-phase2-state-v3.sqlite3", self.workflow)
        self.assertIn("soundcharts-fal-phase2-report-v3.json", self.workflow)
        self.assertNotIn("soundcharts-fal-phase2-state-v2", self.workflow)
        self.assertNotIn("soundcharts-fal-phase2-control-v2", self.workflow)
        self.assertNotIn("soundcharts-fal-phase2-report-v2", self.workflow)
        self.assertIn("mode=ro", self.workflow)
        self.assertIn("sha256sum \"$PHASE1_DB\"", self.workflow)
        self.assertIn("test \"$before\" = \"$after\"", self.workflow)
        self.assertNotIn("cp \"$PHASE1_DB\" \"$PHASE2_DB\"", self.workflow)
        self.assertIn("PRAGMA quick_check", self.workflow)

    def test_canary_is_bounded_and_zero_signal_stops_automatic_spend(self):
        self.assertIn("default: '500'", self.workflow)
        self.assertIn("CANARY_MIN_SAMPLE: '500'", self.workflow)
        self.assertIn("ACTIVE_QUEUE_CAP: '5000'", self.workflow)
        self.assertIn("default: '2000'", self.workflow)
        self.assertIn("10#$max_requests > 40000", self.workflow)
        self.assertIn("10#$max_new_queue > 10000", self.workflow)
        self.assertIn("continue_zero_yield", self.workflow)
        self.assertIn("zero_yield_schedule_paused", self.workflow)
        self.assertIn('--max-new-queue "${{ steps.plan.outputs.max_new_queue }}"', self.workflow)
        self.assertIn("artist_gate_active", self.workflow)
        self.assertIn("soundcharts_fal_artist_gate.py", self.workflow)
        self.assertNotIn("detail_pending", self.workflow)

    def test_hard_and_maintenance_reserves_are_explicit(self):
        self.assertIn("QUOTA_RESERVE: '500000'", self.workflow)
        self.assertIn("MAINTENANCE_DAILY_REQUESTS: '60000'", self.workflow)
        self.assertIn("MAINTENANCE_THROUGH: '2026-08-18'", self.workflow)
        self.assertIn('--quota-reserve "$QUOTA_RESERVE"', self.workflow)
        self.assertIn('--maintenance-daily-requests "$MAINTENANCE_DAILY_REQUESTS"', self.workflow)
        self.assertIn('--maintenance-through "$MAINTENANCE_THROUGH"', self.workflow)
        self.assertIn("Maximum Soundcharts attempts including retries", self.workflow)

    def test_no_canonical_dashboard_or_repository_write_is_possible(self):
        self.assertIn("actions: write", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        forbidden = (
            "git add",
            "git commit",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
            "Spotify_Soundcharts_data.js",
            "Spotify_Performance_data.js",
            "Spotify_Radar_data.js",
        )
        for token in forbidden:
            self.assertNotIn(token, self.workflow)
        self.assertIn("Phase 2 attempted a canonical/dashboard write", self.workflow)
        self.assertIn('test -z "$(git status --porcelain)"', self.workflow)

    def test_checkpoint_cannot_be_uploaded_after_failed_restore(self):
        upload = self.workflow.index("Persist the small private resumable phase-2 state")
        self.assertIn(
            "if: always() && steps.checkpoint_guard.outcome == 'success'",
            self.workflow[upload:],
        )
        self.assertIn("if-no-files-found: error", self.workflow[upload:])
        self.assertIn("retention-days: 90", self.workflow[upload:])
        self.assertIn("Keep only the two newest mutable phase-2 state artifacts", self.workflow)
        self.assertIn("| .[2:][] | .id", self.workflow)


if __name__ == "__main__":
    unittest.main()
