from pathlib import Path
import unittest


class YoutubeWorkflowGuardrailTests(unittest.TestCase):
    def test_discovery_scan_waits_for_view_floor_validation(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        validate = workflow.split('  validate:\n', 1)[1].split('  prepare:\n', 1)[0]
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('tests.test_refresh_youtube_daily', validate)
        self.assertIn('test_youtube_new_video_view_floor.js', validate)
        self.assertIn('test_youtube_daily_view_deltas.js', validate)
        self.assertIn('test_youtube_history_cache_refresh.js', validate)
        self.assertIn('test_youtube_unavailable_quarantine.js', validate)
        self.assertIn('needs: validate', prepare)
        self.assertIn('--write-tracked-manifest artifacts/youtube-tracked-ids.json', prepare)
        self.assertIn('needs: prepare', scan)
        self.assertIn('--tracked-manifest artifacts/youtube-tracked-ids.json', scan)

    def test_recommendation_learning_is_guarded_before_each_scan(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        validate = workflow.split('  validate:\n', 1)[1].split('  prepare:\n', 1)[0]
        for test in (
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
            self.assertIn(test, validate)
        self.assertIn("'assets/js/dashboard-04-recommendations.js'", workflow)
        self.assertIn('tests.test_generate_youtube_recommendation_pool', validate)
        self.assertIn('--recommendation-pool Lofi_Radar_recommendation_pool.js', workflow)
        self.assertIn('git add Lofi_Radar_data.js Lofi_Radar_recommendation_pool.js', workflow)

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
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn('--verify-base-url https://dim75017.github.io/youtube-radar-kx9v2m/', publish)
        self.assertIn('--history-dir video_history', publish)

    def test_feature_branches_do_not_publish_shared_daily_snapshots(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)


if __name__ == '__main__':
    unittest.main()

