from pathlib import Path
import re
import unittest


WORKFLOW = Path(".github/workflows/refresh-youtube-studio.yml")


class YoutubeStudioWorkflowGuardrailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_runs_remotely_twice_daily_and_can_be_dispatched(self):
        self.assertIn("name: Refresh YouTube Studio analytics", self.workflow)
        self.assertGreaterEqual(self.workflow.count("- cron:"), 2)
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("runs-on: ubuntu-latest", self.workflow)
        self.assertNotIn("self-hosted", self.workflow)

    def test_code_changes_run_validation_without_running_the_collector(self):
        self.assertIn("push:", self.workflow)
        self.assertIn("pull_request:", self.workflow)
        for path in (
            ".github/workflows/refresh-youtube-studio.yml",
            "authorize_youtube_studio.py",
            "data_freshness_watchdog.py",
            "refresh_youtube_studio_reporting.py",
            "tests/test_authorize_youtube_studio.py",
            "tests/test_data_freshness_watchdog.py",
            "tests/test_refresh_youtube_studio_reporting.py",
            "tests/test_youtube_studio_workflow_guardrails.py",
        ):
            self.assertIn(f"- '{path}'", self.workflow)
        self.assertIn("needs: gate", self.workflow)
        self.assertIn(
            "if: needs.gate.outputs.run_refresh == 'true'",
            self.workflow,
        )

    def test_freshness_gate_retries_delayed_reports_without_wasting_healthy_runs(self):
        gate = self.workflow.split("name: Check Studio reporting freshness", 1)[1].split(
            "name: Refresh private Studio metrics", 1
        )[0]
        self.assertIn("needs: validate", gate)
        self.assertIn("--target youtube_studio", gate)
        self.assertIn("--scheduled-check", gate)
        self.assertIn('--github-output "$GITHUB_OUTPUT"', gate)
        self.assertIn('${{ steps.freshness.outputs.due }}', gate)
        self.assertIn("FORCE: ${{ inputs.force }}", gate)
        self.assertIn('[[ "$FORCE" == "true" ]]', gate)
        self.assertIn("default: false", self.workflow)

    def test_overlapping_runs_are_serialized_without_cancellation(self):
        self.assertIn("group: refresh-youtube-studio-analytics", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_all_oauth_and_encryption_secrets_are_required_before_collection(self):
        for name in (
            "GOOGLE_OAUTH_CLIENT_ID",
            "GOOGLE_OAUTH_CLIENT_SECRET",
            "YOUTUBE_ANALYTICS_REFRESH_TOKEN",
            "YOUTUBE_STUDIO_STATE_KEY",
        ):
            self.assertIn(f"secrets.{name}", self.workflow)
            self.assertRegex(self.workflow, rf"if \[\[ -z \"\$\{{!required:-\}}\" \]\]")
        self.assertIn("Missing required GitHub Actions secrets", self.workflow)
        self.assertNotIn("continue-on-error:", self.workflow)

    def test_tests_run_before_the_real_collector(self):
        tests = self.workflow.index("python -m unittest")
        refresh = self.workflow.index("python refresh_youtube_studio_reporting.py")
        self.assertLess(tests, refresh)
        self.assertNotIn("pip install", self.workflow)
        self.assertIn("tests.test_authorize_youtube_studio", self.workflow)
        self.assertIn("tests.test_refresh_youtube_studio_reporting", self.workflow)
        self.assertIn("tests.test_youtube_studio_workflow_guardrails", self.workflow)
        self.assertIn("--output Lofi_Radar_studio.js", self.workflow)
        self.assertIn('--state "$STUDIO_STATE_JSON"', self.workflow)
        self.assertIn('--expected-channel-id "$YOUTUBE_CHANNEL_ID"', self.workflow)

    def test_collection_is_locked_to_the_lofi_girl_channel(self):
        self.assertIn(
            "YOUTUBE_CHANNEL_ID: 'UCSJ4gkVC6NrvII8umztf0Ow'",
            self.workflow,
        )

    def test_private_state_is_only_committed_encrypted(self):
        self.assertIn("${{ runner.temp }}/youtube_studio_reporting_state.json", self.workflow)
        self.assertIn("openssl enc -d -aes-256-cbc -pbkdf2", self.workflow)
        self.assertIn("openssl enc -aes-256-cbc -salt -pbkdf2", self.workflow)
        self.assertIn(
            "git add -- Lofi_Radar_studio.js youtube_studio_reporting_state.enc",
            self.workflow,
        )
        self.assertNotRegex(self.workflow, r"git add[^\n]*youtube_studio_reporting_state\.json")
        self.assertNotIn("git add .", self.workflow)
        self.assertNotIn("git add -A", self.workflow)

    def test_first_run_waits_without_replacing_the_manual_snapshot(self):
        self.assertIn("if [[ -f youtube_studio_reporting_state.enc ]]", self.workflow)
        self.assertIn("No encrypted Studio state yet", self.workflow)
        self.assertIn('status not in {"healthy", "waiting_reports"}', self.workflow)
        self.assertIn('state.get("channelId") != expected_channel', self.workflow)
        self.assertIn('sync.get("partial") is not (status == "waiting_reports")', self.workflow)
        self.assertIn("git diff --quiet -- Lofi_Radar_studio.js", self.workflow)
        self.assertIn('if [[ "$state_status" == "waiting_reports" ]]', self.workflow)
        self.assertIn("snapshot_changed=false", self.workflow)
        self.assertIn("YouTube Studio reports pending", self.workflow)
        self.assertIn("manual snapshot was intentionally left untouched", self.workflow)

    def test_pages_verification_is_independent_and_strict(self):
        verify = self.workflow.split("Verify the healthy snapshot on GitHub Pages", 1)[1]
        self.assertIn("Lofi_Radar_studio.js?", verify)
        self.assertIn('"run": os.environ["RUN_SHA"]', verify)
        self.assertIn('sync.get("source") == "youtube-reporting-api"', verify)
        self.assertIn('sync.get("connected") is True', verify)
        self.assertIn('sync.get("status") == "healthy"', verify)
        self.assertIn('sync.get("partial") is False', verify)
        self.assertIn('remote.get("dataThrough") == expected_day', verify)
        self.assertIn("time.monotonic() + 900", verify)
        self.assertNotIn("--verify-base-url", self.workflow)

    def test_pages_verification_only_runs_for_a_new_healthy_snapshot(self):
        self.assertIn(
            "if: steps.result.outputs.snapshot_changed == 'true' && steps.commit.outputs.commit_created == 'true'",
            self.workflow,
        )
        classify = self.workflow.split("Classify refreshed snapshot", 1)[1].split(
            "Commit only the snapshot", 1
        )[0]
        self.assertIn('if [[ "$state_status" != "healthy" ]]', classify)
        self.assertIn('sync.get("source") == "youtube-reporting-api"', classify)
        self.assertIn('sync.get("connected") is True', classify)
        self.assertIn('sync.get("status") == "healthy"', classify)

    def test_commit_scope_is_exactly_snapshot_and_encrypted_state(self):
        match = re.search(r"git add -- ([^\n]+)", self.workflow)
        self.assertIsNotNone(match)
        self.assertEqual(
            match.group(1).split(),
            ["Lofi_Radar_studio.js", "youtube_studio_reporting_state.enc"],
        )


if __name__ == "__main__":
    unittest.main()
