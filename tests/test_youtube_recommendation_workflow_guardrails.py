from pathlib import Path
import unittest


WORKFLOW = Path('.github/workflows/refresh-youtube-recommendations.yml')


class YoutubeRecommendationWorkflowGuardrailTests(unittest.TestCase):
    def setUp(self):
        self.workflow = WORKFLOW.read_text(encoding='utf-8')

    def test_refreshes_shared_feedback_four_times_daily_after_facts_and_on_demand(self):
        self.assertIn("cron: '11 0,6,12,18 * * *'", self.workflow)
        self.assertIn("workflows: ['Refresh YouTube radar']", self.workflow)
        self.assertIn('branches: [main]', self.workflow)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", self.workflow)
        self.assertIn('workflow_dispatch:', self.workflow)
        self.assertIn('cancel-in-progress: false', self.workflow)

    def test_shared_state_endpoint_is_the_generator_feedback_source(self):
        self.assertIn('script.google.com/macros/s/', self.workflow)
        self.assertIn('op=state&k=lofiradar2026kx', self.workflow)
        self.assertIn('--feedback "$FEEDBACK_URL"', self.workflow)

    def test_recommendation_failures_are_never_silenced(self):
        self.assertNotIn('continue-on-error', self.workflow)
        self.assertIn('needs: validate', self.workflow)
        self.assertIn("github.event_name != 'pull_request'", self.workflow)

    def test_candidate_is_generated_and_validated_before_atomic_staging(self):
        publish = self.workflow.split('      - id: publish\n', 1)[1]
        generated = publish.index('--bootstrap-pool Lofi_Radar_recommendation_pool.js')
        validated = publish.index('--validate-only')
        staged = publish.index('git add Lofi_Radar_recommendation_pool.js youtube_recommendation_ledger')
        self.assertLess(generated, validated)
        self.assertLess(validated, staged)
        self.assertIn('--ledger-dir youtube_recommendation_ledger', publish)
        self.assertIn('--history-dir video_history', publish)
        self.assertIn('--browser-limit 2500', publish)
        self.assertIn('--reserve-low-water 1500', publish)
        self.assertIn('--reserve-high-water 3500', publish)

    def test_each_push_retry_regenerates_from_the_latest_main(self):
        publish = self.workflow.split('      - id: publish\n', 1)[1]
        loop = publish.split('for attempt in 1 2 3; do', 1)[1].split('done', 1)[0]
        self.assertLess(loop.index('git restore --source=HEAD'), loop.index('git fetch origin main'))
        self.assertLess(loop.index('git clean -fd -- Lofi_Radar_recommendation_pool.js youtube_recommendation_ledger'), loop.index('git fetch origin main'))
        self.assertLess(loop.index('git fetch origin main'), loop.index('git checkout --detach origin/main'))
        self.assertLess(loop.index('git checkout --detach origin/main'), loop.index('python generate_youtube_recommendation_pool.py'))
        self.assertIn('git push origin HEAD:main', loop)
        self.assertIn('if ! python generate_youtube_recommendation_pool.py', loop)
        self.assertIn('sleep 10; continue', loop)
        self.assertNotIn('git pull --rebase', publish)

    def test_actual_candidate_runs_browser_quality_guards(self):
        publish = self.workflow.split('      - id: publish\n', 1)[1]
        for test in (
            'test_youtube_recommendation_continuous_pool.js',
            'test_youtube_recommendation_quality.js',
            'test_youtube_recommendation_real_snapshot.js',
        ):
            self.assertIn(test, publish)

    def test_shared_state_contract_is_part_of_strict_validation(self):
        validate = self.workflow.split('  validate:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('test_youtube_recommendation_shared_state.js', validate)
        self.assertIn('test_youtube_recommendation_published_link.js', validate)

    def test_open_tab_daily_cache_guard_is_part_of_strict_validation(self):
        validate = self.workflow.split('  validate:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('node tests/test_youtube_instant_tabs.js', validate)
        self.assertGreaterEqual(
            self.workflow.count("- 'tests/test_youtube_instant_tabs.js'"),
            2,
            'push and pull-request path filters must both notice this guardrail',
        )

    def test_pages_verification_compares_the_exact_pool_and_ledger_revision(self):
        verify = self.workflow.split('Verify Pages serves the exact pool and ledger revision', 1)[1]
        self.assertIn('--validate-only', verify)
        self.assertIn('--verify-base-url https://dim75017.github.io/youtube-radar-kx9v2m/', verify)
        self.assertIn('--verify-timeout 900', verify)
        self.assertIn('--verify-interval 15', verify)

    def test_publish_pushes_then_waits_for_pages_before_public_verification(self):
        publish = self.workflow.split('      - id: publish\n', 1)[1]
        push = publish.index('git push origin HEAD:main')
        dispatch = publish.index('python trigger_pages_deployment.py')
        wait = publish.index('--wait-for-completion')
        verify = publish.index('Verify Pages serves the exact pool and ledger revision')
        self.assertLess(push, dispatch)
        self.assertLess(dispatch, wait)
        self.assertLess(wait, verify)
        self.assertIn('--sha "$published_sha"', publish)
        self.assertIn('--run-timeout 1800', publish)

    def test_workflow_is_cheap_and_write_permission_is_publish_only(self):
        global_permissions = self.workflow.split('permissions:\n', 1)[1].split('concurrency:\n', 1)[0]
        validate = self.workflow.split('  validate:\n', 1)[1].split('  publish:\n', 1)[0]
        publish = self.workflow.split('  publish:\n', 1)[1]
        self.assertIn('contents: read', global_permissions)
        self.assertNotIn('contents: write', validate)
        self.assertIn('contents: write', publish)
        self.assertNotIn('--shard', self.workflow)
        self.assertNotIn('yt-dlp', self.workflow)

    def test_generated_outputs_do_not_trigger_a_self_refresh_loop(self):
        push_paths = self.workflow.split('  push:\n', 1)[1].split('  pull_request:\n', 1)[0]
        self.assertNotIn('Lofi_Radar_recommendation_pool.js', push_paths)
        self.assertNotIn('youtube_recommendation_ledger/', push_paths)


if __name__ == '__main__':
    unittest.main()
