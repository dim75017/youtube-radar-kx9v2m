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

    def test_missing_secondary_actions_run_is_not_a_blocker(self):
        self.assertIn("CURRENT_RUN_ID: ${{ github.run_id }}", self.workflow)
        self.assertIn('rows=[row for row in rows if str(row.get("id") or "") != current]', self.workflow)
        self.assertIn('"success" if not rows or all(', self.workflow)
        self.assertIn('"$runs_json" "$CURRENT_RUN_ID"', self.workflow)

    def test_live_bytes_are_still_required_before_activation(self):
        wait = self.workflow.index("Wait for staged snapshot to be live and green")
        hash_check = self.workflow.index('if [[ "$public_sha256" == "$local_sha256" ]]')
        activate = self.workflow.index("Activate snapshot only after remote validation")
        self.assertLess(wait, hash_check)
        self.assertLess(hash_check, activate)


if __name__ == "__main__":
    unittest.main()
