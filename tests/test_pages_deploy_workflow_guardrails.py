import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = (ROOT / ".github/workflows/deploy-pages.yml").read_text(encoding="utf-8")


class PagesDeployWorkflowGuardrailsTests(unittest.TestCase):
    def test_deploy_is_explicit_coalesced_and_does_not_write_git(self):
        self.assertIn("workflow_dispatch:", DEPLOY)
        self.assertRegex(DEPLOY, r"push:\s+branches: \[main\]")
        self.assertIn("group: github-pages-production", DEPLOY)
        self.assertIn("cancel-in-progress: true", DEPLOY)
        self.assertNotIn("git push", DEPLOY)
        self.assertNotIn("trigger_pages_deployment.py", DEPLOY)

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
        self.assertIn("timeout: 2700000", DEPLOY)

    def test_dispatch_never_deploys_a_non_main_revision(self):
        self.assertIn('git merge-base --is-ancestor "$REQUESTED_SHA" origin/main', DEPLOY)
        self.assertIn("ref: main", DEPLOY)
        self.assertIn("fetch-depth: 0", DEPLOY)

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
