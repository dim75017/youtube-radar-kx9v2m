from pathlib import Path
import unittest


class YoutubeWorkflowGuardrailTests(unittest.TestCase):
    def test_daily_facts_wait_only_for_collection_integrity(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        validate = workflow.split('  validate:\n', 1)[1].split('  validate_recommendations:\n', 1)[0]
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('tests.test_refresh_youtube_daily', validate)
        self.assertIn('test_youtube_daily_view_deltas.js', validate)
        self.assertIn('test_youtube_analytics_scale_cache.js', validate)
        self.assertIn('test_youtube_history_cache_refresh.js', validate)
        self.assertIn('test_youtube_unavailable_quarantine.js', validate)
        self.assertNotIn('test_generate_youtube_recommendation_pool', validate)
        self.assertNotIn('test_youtube_new_video_view_floor.js', validate)
        self.assertNotIn('test_youtube_recommendation_', validate)
        self.assertNotIn('test_youtube_channel_update_status.js', validate)
        self.assertIn('needs: gate', prepare)
        self.assertNotIn('needs: validate', prepare)
        self.assertIn("github.event_name != 'pull_request'", validate)
        self.assertIn('--write-tracked-manifest artifacts/youtube-tracked-ids.json', prepare)
        self.assertIn('needs: prepare', scan)
        self.assertIn('--tracked-manifest artifacts/youtube-tracked-ids.json', scan)

    def test_recommendation_learning_is_visible_but_never_blocks_daily_facts(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        validate = workflow.split('  validate:\n', 1)[1].split('  validate_recommendations:\n', 1)[0]
        recommendation_validation = workflow.split('  validate_recommendations:\n', 1)[1].split('  prepare:\n', 1)[0]
        for test in (
            'test_youtube_new_video_view_floor.js',
            'test_youtube_channel_update_status.js',
            'test_youtube_age_normalized_analysis.js',
            'test_youtube_daily_recommendations.js',
            'test_youtube_recommendation_actions.js',
            'test_youtube_recommendation_edits.js',
            'test_youtube_recommendation_status_tabs.js',
            'test_youtube_recommendation_continuous_pool.js',
            'test_youtube_recommendation_quality.js',
            'test_youtube_recommendation_real_snapshot.js',
            'test_youtube_recommendation_historical_acceptance_snapshot.js',
            'test_youtube_recommendation_roadmap_precedence.js',
            'test_youtube_recommendation_decision_animation.js',
            'test_recommendation_validated_archive.js',
            'test_roadmap_context_actions.js',
            'test_roadmap_slot_scheduling.js',
        ):
            self.assertIn(test, recommendation_validation)
        self.assertIn("'assets/js/dashboard-04-recommendations.js'", workflow)
        self.assertIn('tests.test_generate_youtube_recommendation_pool', recommendation_validation)
        self.assertNotIn('tests.test_generate_youtube_recommendation_pool', validate)
        self.assertIn("continue-on-error: ${{ github.event_name != 'pull_request' }}", recommendation_validation)
        self.assertIn("valid: ${{ steps.recommendation_tests.outcome == 'success' }}", recommendation_validation)
        self.assertIn('needs: gate', workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0])
        self.assertIn('--output Lofi_Radar_recommendation_pool.js', workflow)

    def test_ui_and_recommendation_pushes_cannot_start_production_scans(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        push = workflow.split('  push:\n', 1)[1].split('  pull_request:\n', 1)[0]
        self.assertIn('branches: [main]', push)
        self.assertIn("'refresh_youtube_daily.py'", push)
        self.assertNotIn('dashboard-04-recommendations.js', push)
        self.assertNotIn('test_youtube_recommendation_', push)
        self.assertNotIn('generate_youtube_recommendation_pool.py', push)

    def test_pull_requests_always_validate_without_scanning(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        self.assertIn('$EVENT_NAME" = "pull_request', gate)
        self.assertIn("github.ref == 'refs/heads/main'", prepare)
        self.assertIn("refresh-youtube-radar-pr-{0}", workflow)

    def test_pull_request_code_has_read_only_permissions(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        global_permissions = workflow.split('permissions:\n', 1)[1].split('concurrency:\n', 1)[0]
        publish = workflow.split('  publish:\n', 1)[1].split('  publish_recommendations:\n', 1)[0]
        recommendation_publish = workflow.split('  publish_recommendations:\n', 1)[1]
        self.assertIn('contents: read', global_permissions)
        self.assertIn('contents: write', publish)
        self.assertIn('contents: write', recommendation_publish)

    def test_daily_watchdog_retries_only_when_the_paris_snapshot_is_stale(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        self.assertIn("cron: '17 7 * * *'", workflow)
        self.assertIn("cron: '47 19 * * *'", workflow)
        self.assertIn('data_freshness_watchdog.py', gate)
        self.assertIn('--target youtube_radar', gate)
        self.assertIn('steps.freshness.outputs.due', gate)
        self.assertIn('FORCE: ${{ inputs.force }}', gate)

    def test_publication_is_verified_on_pages_after_the_push(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        publish = workflow.split('  publish:\n', 1)[1].split('  publish_recommendations:\n', 1)[0]
        recommendation_publish = workflow.split('  publish_recommendations:\n', 1)[1]
        self.assertIn('--verify-base-url https://dim75017.github.io/youtube-radar-kx9v2m/', publish)
        self.assertIn('--history-dir video_history', publish)
        self.assertIn('--skip-recommendation-pool', publish)
        self.assertIn('--verify-core-only', publish)
        core_commit = publish.split('Commit factual catalogue and daily analytics first', 1)[1].split('Verify GitHub Pages serves the factual snapshot and history', 1)[0]
        self.assertIn('git add Lofi_Radar_data.js Lofi_Radar_new_channel_avatars.js video_history', core_commit)
        self.assertNotIn('Lofi_Radar_recommendation_pool.js', core_commit)
        self.assertNotIn('generate_youtube_recommendation_pool.py', publish)
        self.assertIn('needs: [publish, validate_recommendations]', recommendation_publish)
        self.assertIn("needs.validate_recommendations.outputs.valid == 'true'", recommendation_publish)
        self.assertIn('continue-on-error: true', recommendation_publish)
        self.assertIn('generate_youtube_recommendation_pool.py', recommendation_publish)
        self.assertIn('git pull --ff-only origin main', recommendation_publish)
        self.assertNotIn('git pull --rebase', recommendation_publish)

    def test_feature_branches_do_not_scan_or_publish_shared_daily_snapshots(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        publish = workflow.split('  publish:\n', 1)[1].split('  publish_recommendations:\n', 1)[0]
        self.assertIn("if: github.ref == 'refs/heads/main'", prepare)
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)


if __name__ == '__main__':
    unittest.main()

