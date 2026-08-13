import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = (ROOT / ".github/workflows/deploy-pages.yml").read_text(encoding="utf-8")


class PagesDeployWorkflowGuardrailsTests(unittest.TestCase):
    def test_deploy_is_explicit_coalesced_and_immutable(self):
        self.assertIn("workflow_dispatch:", DEPLOY)
        self.assertRegex(DEPLOY, r"push:\s+branches: \[main\]")
        self.assertIn("group: github-pages-production", DEPLOY)
        self.assertIn("cancel-in-progress: true", DEPLOY)
        self.assertIn("type: string", DEPLOY)
        self.assertIn("default: '0'", DEPLOY)
        self.assertRegex(DEPLOY, r"requested_sha:\s+description:.*\s+required: true")
        self.assertIn('if [[ "$REQUESTED_SHA" != "$RUN_SHA" ]]', DEPLOY)
        self.assertNotIn("git push origin HEAD:main", DEPLOY)
        self.assertNotIn("--allow-empty", DEPLOY)

    def test_minimum_pages_permissions_and_exact_build_actions_are_used(self):
        self.assertIn("contents: read", DEPLOY)
        self.assertIn("pages: write", DEPLOY)
        self.assertIn("id-token: write", DEPLOY)
        for action in (
            "actions/checkout@v4",
            "actions/configure-pages@v5",
            "actions/jekyll-build-pages@v1",
            "actions/upload-pages-artifact@v4",
            "actions/deploy-pages@v5",
        ):
            self.assertIn(action, DEPLOY)

    def test_pages_deploy_uses_the_real_cap_then_renews_the_revision(self):
        self.assertEqual(DEPLOY.count("actions/upload-pages-artifact@v4"), 1)
        self.assertEqual(DEPLOY.count("actions/deploy-pages@v5"), 1)
        self.assertEqual(DEPLOY.count("artifact_name: github-pages"), 1)
        self.assertEqual(DEPLOY.count("timeout: 600000"), 1)
        self.assertEqual(DEPLOY.count("continue-on-error: true"), 1)
        self.assertNotIn("timeout: 2700000", DEPLOY)
        self.assertIn("Mark this Pages attempt as failed", DEPLOY)
        self.assertIn("steps.deployment.outcome == 'failure'", DEPLOY)
        self.assertIn("exit 1", DEPLOY)

    def test_deploy_cancels_only_a_verified_orphan_before_publishing(self):
        self.assertIn("Cancel an orphaned Pages deployment", DEPLOY)
        self.assertIn("cancel_stale_pages_deployments.py", DEPLOY)
        self.assertIn('GITHUB_TOKEN: ${{ github.token }}', DEPLOY)
        self.assertIn('CURRENT_RUN_SHA: ${{ needs.build.outputs.resolved_sha }}', DEPLOY)
        self.assertIn('--exclude-sha "$CURRENT_RUN_SHA"', DEPLOY)
        self.assertLess(
            DEPLOY.index("Cancel an orphaned Pages deployment"),
            DEPLOY.index("uses: actions/deploy-pages@v5"),
        )

    def test_successful_deployment_supplies_the_environment_page_url(self):
        self.assertIn("url: ${{ steps.deployment.outputs.page_url }}", DEPLOY)
        self.assertIn("id: deployment", DEPLOY)
        self.assertIn("deployment_outcome: ${{ steps.deployment.outcome }}", DEPLOY)

    def test_dispatch_never_deploys_a_non_main_revision(self):
        self.assertIn('git merge-base --is-ancestor "$resolved_sha" origin/main', DEPLOY)
        self.assertIn('ref: ${{ github.sha }}', DEPLOY)
        self.assertIn('build_revision: ${{ steps.revision.outputs.sha }}', DEPLOY)
        self.assertIn('if [[ "$REQUESTED_SHA" != "$RUN_SHA" ]]', DEPLOY)
        self.assertIn('if [[ "$RUN_SHA" != "$RESOLVED_SHA" ]]', DEPLOY)
        self.assertIn('ref: ${{ needs.build.outputs.resolved_sha }}', DEPLOY)
        self.assertIn("fetch-depth: 0", DEPLOY)

    def test_youtube_publishers_wait_for_the_exact_pages_run(self):
        for name in (
            "refresh-instrumental-radar.yml",
            "refresh-youtube-recommendations.yml",
        ):
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            with self.subTest(workflow=name):
                self.assertIn("--wait-for-completion", text)
                self.assertIn("--run-timeout 1800", text)
                self.assertIn("timeout-minutes: 55", text)

    def test_every_current_main_publisher_dispatches_pages_after_push(self):
        workflows = {
            "refresh-soundcharts.yml": 3,
            "refresh-spotify-browse-catalogue.yml": 1,
            "refresh-playlist-followers.yml": 1,
            "refresh-instrumental-radar.yml": 1,
            "refresh-channel-radar.yml": 1,
            "refresh-youtube-recommendations.yml": 1,
        }
        for name, minimum_calls in workflows.items():
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            with self.subTest(workflow=name):
                self.assertIn("actions: write", text)
                self.assertGreaterEqual(
                    text.count("trigger_pages_deployment.py"), minimum_calls
                )
                first_push = text.index("git push")
                first_dispatch = text.index("trigger_pages_deployment.py")
                self.assertLess(first_push, first_dispatch)

    def test_soundcharts_staged_snapshot_is_dispatched_before_live_wait(self):
        workflow = (ROOT / ".github/workflows/refresh-soundcharts.yml").read_text(
            encoding="utf-8"
        )
        dispatch = workflow.index("trigger_pages_deployment.py")
        wait = workflow.index("Wait for staged snapshot to be live and green")
        self.assertLess(dispatch, wait)


if __name__ == "__main__":
    unittest.main()
