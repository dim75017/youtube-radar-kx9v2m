from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-soundcharts.yml"


class SoundchartsWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_pages_wait_covers_slow_deployments(self):
        self.assertIn("timeout-minutes: 45", self.workflow)
        self.assertIn("for poll in $(seq 1 160); do", self.workflow)
        self.assertIn('if [[ "$poll" == "160" ]]; then', self.workflow)
        self.assertIn("sleep 15", self.workflow)
        self.assertIn("for poll in $(seq 1 12); do", self.workflow)

    def test_superseded_pages_deployment_relies_on_public_bytes(self):
        self.assertIn('public_verified="false"', self.workflow)
        self.assertIn('if [[ "$public_sha256" == "$local_sha256" ]]', self.workflow)
        self.assertNotIn('"$deployment_state" == "inactive"', self.workflow)
        self.assertNotIn('actions_state=', self.workflow)
        self.assertIn('waiting for a superseding deployment', self.workflow)
        self.assertNotIn('Pages failed for staged SHA', self.workflow)

    def test_activation_rebases_a_benign_later_main_commit(self):
        self.assertIn('git stash push --include-untracked -m "soundcharts-activation-rebase"', self.workflow)
        self.assertIn('if [[ "$stashed_changes" == "true" ]]; then', self.workflow)
        self.assertIn("git stash pop", self.workflow)
        self.assertIn("git rebase origin/main", self.workflow)
        self.assertIn('staged_blob="$(git rev-parse "$STAGED_SHA:$SNAPSHOT_NAME")"', self.workflow)
        self.assertIn('test "$local_blob" = "$staged_blob"', self.workflow)

    def test_live_bytes_are_still_required_before_activation(self):
        wait = self.workflow.index("Wait for staged snapshot to be live and green")
        hash_check = self.workflow.index('if [[ "$public_sha256" == "$local_sha256" ]]')
        activate = self.workflow.index("Activate snapshot only after remote validation")
        self.assertLess(wait, hash_check)
        self.assertLess(hash_check, activate)

    def test_bootstrap_runs_every_five_minutes_without_cancelling_a_live_run(self):
        self.assertIn("- cron: '2-57/5 * * * *'", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_classification_rebuilds_the_non_public_playlist_pool_first(self):
        discovery_condition = (
            "if: steps.plan.outputs.scope == 'strict_rebaseline' || "
            "steps.plan.outputs.scope == 'classification'"
        )
        editorial = self.workflow.index(
            "Discover tracks and artist catalogues from editorial playlists"
        )
        independent = self.workflow.index(
            "Discover a rotating batch of independent background playlists"
        )
        classify = self.workflow.index(
            "Classify pending playlist tracks from exact Soundcharts song genres"
        )
        self.assertIn(discovery_condition, self.workflow[editorial:independent])
        self.assertIn(discovery_condition, self.workflow[independent:classify])
        self.assertLess(editorial, classify)
        self.assertLess(independent, classify)


if __name__ == "__main__":
    unittest.main()
