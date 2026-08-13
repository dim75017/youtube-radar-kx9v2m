from pathlib import Path
import unittest


WORKFLOW = Path('.github/workflows/refresh-instrumental-radar.yml')
KIDS_WORKFLOW = Path('.github/workflows/refresh-youtube-kids.yml')


class YoutubeWorkflowGuardrailTests(unittest.TestCase):
    def workflow(self) -> str:
        return WORKFLOW.read_text(encoding='utf-8')

    def kids_workflow(self) -> str:
        return KIDS_WORKFLOW.read_text(encoding='utf-8')

    def test_daily_facts_wait_only_for_collection_integrity(self):
        workflow = self.workflow()
        validate = workflow.split('  validate:\n', 1)[1].split('  prepare:\n', 1)[0]
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('tests.test_refresh_youtube_daily', validate)
        self.assertIn('tests.test_import_youtube_studio_export', validate)
        self.assertIn('tests.test_data_freshness_watchdog', validate)
        self.assertIn('test_youtube_daily_view_deltas.js', validate)
        self.assertIn('test_youtube_analytics_scale_cache.js', validate)
        self.assertIn('test_youtube_history_cache_refresh.js', validate)
        self.assertIn('test_youtube_unavailable_quarantine.js', validate)
        self.assertIn('test_youtube_card_freshness_ui.js', validate)
        self.assertNotIn('test_generate_youtube_recommendation_pool', validate)
        self.assertNotIn('test_youtube_recommendation_', validate)
        self.assertIn('needs: gate', prepare)
        self.assertNotIn('needs: validate', prepare)
        self.assertIn("github.event_name != 'pull_request'", validate)
        self.assertIn('--write-tracked-manifest artifacts/youtube-tracked-ids.json', prepare)
        self.assertIn('needs: prepare', scan)
        self.assertIn('--tracked-manifest artifacts/youtube-tracked-ids.json', scan)

    def test_standard_daily_scan_excludes_kids_scope(self):
        workflow = self.workflow()
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn('--scan-scope standard', prepare)
        self.assertIn('--scan-scope standard', scan)
        self.assertIn('--scan-scope standard', publish)
        self.assertNotIn('--require-kids', scan)
        self.assertNotIn('--require-kids', publish)

    def test_recommendations_have_no_failure_coupling_to_daily_facts(self):
        workflow = self.workflow()
        self.assertNotIn('validate_recommendations:', workflow)
        self.assertNotIn('publish_recommendations:', workflow)
        self.assertNotIn('generate_youtube_recommendation_pool.py', workflow)
        self.assertNotIn('Lofi_Radar_recommendation_pool.js', workflow)
        self.assertTrue(Path('.github/workflows/refresh-youtube-recommendations.yml').exists())

    def test_ui_and_recommendation_pushes_cannot_start_production_scans(self):
        workflow = self.workflow()
        push = workflow.split('  push:\n', 1)[1].split('  pull_request:\n', 1)[0]
        pull_request = workflow.split('  pull_request:\n', 1)[1].split('  workflow_dispatch:\n', 1)[0]
        self.assertIn('branches: [main]', push)
        self.assertIn("'refresh_youtube_daily.py'", push)
        for unrelated in (
            'dashboard-04-recommendations.js',
            'test_youtube_recommendation_',
            'generate_youtube_recommendation_pool.py',
        ):
            self.assertNotIn(unrelated, push)
            self.assertNotIn(unrelated, pull_request)

    def test_pull_requests_always_validate_without_scanning(self):
        workflow = self.workflow()
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        self.assertIn('$EVENT_NAME" = "pull_request', gate)
        self.assertIn("github.ref == 'refs/heads/main'", prepare)
        self.assertIn('refresh-youtube-radar-pr-{0}', workflow)

    def test_pull_request_code_has_read_only_permissions(self):
        workflow = self.workflow()
        global_permissions = workflow.split('permissions:\n', 1)[1].split('concurrency:\n', 1)[0]
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn('contents: read', global_permissions)
        self.assertIn('contents: write', publish)

    def test_daily_watchdog_retries_only_when_the_paris_snapshot_is_stale(self):
        workflow = self.workflow()
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        self.assertIn("cron: '17 7 * * *'", workflow)
        self.assertIn("cron: '47 19 * * *'", workflow)
        self.assertIn('data_freshness_watchdog.py', gate)
        self.assertIn('--target youtube_radar', gate)
        self.assertIn('steps.freshness.outputs.due', gate)
        self.assertIn('FORCE: ${{ inputs.force }}', gate)

    def test_publication_verifies_only_the_factual_snapshot_and_history(self):
        workflow = self.workflow()
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn('--verify-base-url https://dim75017.github.io/youtube-radar-kx9v2m/', publish)
        self.assertIn('--history-dir video_history', publish)
        self.assertIn('--skip-recommendation-pool', publish)
        self.assertIn('--verify-core-only', publish)
        core_commit = publish.split('Commit factual catalogue and daily analytics first', 1)[1].split(
            'Verify GitHub Pages serves the factual snapshot and history', 1
        )[0]
        self.assertIn('git add Lofi_Radar_data.js Lofi_Radar_live_data.js Lofi_Radar_new_channel_avatars.js video_history', core_commit)
        self.assertNotIn('recommendation', core_commit.casefold())

    def test_publication_blocks_incomplete_or_divergent_cards_before_commit(self):
        workflow = self.workflow()
        publish = workflow.split('  publish:\n', 1)[1]
        guard = publish.split('Block incomplete, stale or divergent cards before publication', 1)[1].split(
            'Refresh compact livestream first-paint snapshot', 1
        )[0]
        self.assertIn('data_freshness_watchdog.py', guard)
        self.assertIn('--target youtube_radar', guard)
        self.assertIn('--scheduled-check', guard)
        self.assertIn('--fail-if-due', guard)
        self.assertLess(
            publish.index('Block incomplete, stale or divergent cards before publication'),
            publish.index('Commit factual catalogue and daily analytics first'),
        )

    def test_feature_branches_do_not_scan_or_publish_shared_daily_snapshots(self):
        workflow = self.workflow()
        prepare = workflow.split('  prepare:\n', 1)[1].split('  scan:\n', 1)[0]
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main'", prepare)
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)

    def test_kids_discovery_has_cloud_schedule_and_shared_production_lock(self):
        workflow = self.kids_workflow()
        self.assertIn('name: Refresh YouTube Kids radar', workflow)
        self.assertIn('  push:', workflow)
        self.assertIn("cron: '37 11 * * *'", workflow)
        self.assertIn("cron: '7 20 * * *'", workflow)
        self.assertIn('  workflow_dispatch:', workflow)
        self.assertIn("'refresh-youtube-radar-production'", workflow)
        self.assertIn("format('refresh-youtube-radar-pr-{0}'", workflow)
        self.assertIn('cancel-in-progress: false', workflow)

        watchdog = Path('.github/workflows/data-freshness-watchdog.yml').read_text(
            encoding='utf-8'
        )
        self.assertIn("- 'Refresh YouTube Kids radar'", watchdog)

    def test_kids_gate_and_all_twenty_shards_are_kids_only(self):
        workflow = self.kids_workflow()
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        validate = workflow.split('  validate:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('--target youtube_kids', gate)
        self.assertIn('--scheduled-check', gate)
        self.assertIn('steps.freshness.outputs.due', gate)
        self.assertIn("github.ref == 'refs/heads/main'", scan)
        self.assertIn('needs.gate.outputs.run_scan', scan)
        self.assertIn('needs: [gate, validate]', scan)
        self.assertNotIn('continue-on-error', validate)
        self.assertIn('tests.test_refresh_youtube_daily', validate)
        self.assertIn('tests.test_youtube_kids_discovery', validate)
        self.assertIn('tests.test_data_freshness_watchdog', validate)
        self.assertIn('tests.test_youtube_workflow_guardrails', validate)
        self.assertIn('pip install --disable-pip-version-check openpyxl', validate)
        self.assertIn('max-parallel: 5', scan)
        self.assertIn(
            'shard: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]',
            scan,
        )
        self.assertIn('--scan-scope kids', scan)
        self.assertIn('--shards 20', scan)
        self.assertNotIn('--tracked-manifest', scan)
        self.assertNotIn('YOUTUBE_API_KEY', scan)
        self.assertIn('youtube-kids-shard-${{ matrix.shard }}', scan)

    def test_kids_publication_is_fail_closed_scoped_and_pages_verified(self):
        workflow = self.kids_workflow()
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)
        self.assertIn('pattern: youtube-kids-shard-*', publish)
        self.assertIn('--scan-scope kids', publish)
        self.assertIn('--shards 20', publish)
        self.assertIn('--require-kids', publish)
        self.assertIn('--skip-recommendation-pool', publish)
        self.assertIn('youtube_kids_discovery_proof.py', publish)
        self.assertIn('--stamp', publish)
        self.assertIn('--target youtube_kids', publish)
        self.assertIn('--scheduled-check', publish)
        self.assertIn('--fail-if-due', publish)
        self.assertLess(
            publish.index('Record a source-backed Kids discovery proof'),
            publish.index('Block incomplete or stale Kids discovery before publication'),
        )
        self.assertLess(
            publish.index('Block incomplete or stale Kids discovery before publication'),
            publish.index('Commit factual Kids catalogue and history'),
        )
        commit = publish.split('Commit factual Kids catalogue and history', 1)[1].split(
            'Verify GitHub Pages serves the shared factual snapshot and history', 1
        )[0]
        self.assertIn(
            'git add Lofi_Radar_data.js Lofi_Radar_new_channel_avatars.js video_history',
            commit,
        )
        self.assertNotIn('Lofi_Radar_recommendation_pool.js', commit)
        self.assertIn('--sha "$published_sha"', commit)
        self.assertIn('--wait-for-completion', commit)
        self.assertIn('--verify-core-only', publish)
        self.assertIn('--verify-base-url https://dim75017.github.io/youtube-radar-kx9v2m/', publish)

    def test_kids_pull_requests_validate_without_scanning_or_writes(self):
        workflow = self.kids_workflow()
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        global_permissions = workflow.split('permissions:\n', 1)[1].split(
            '# Serialize', 1
        )[0]
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn('$EVENT_NAME" = "pull_request', gate)
        self.assertIn("github.ref == 'refs/heads/main'", scan)
        self.assertIn('contents: read', global_permissions)
        self.assertIn('contents: write', publish)
        self.assertIn('tests.test_youtube_kids_discovery', workflow)

    def test_standard_counter_refresh_cannot_advance_kids_discovery_marker(self):
        collector = Path('refresh_youtube_daily.py').read_text(encoding='utf-8')
        standard_kids_update = collector.split(
            'if preserved_kids is not None and data.get("kids"):', 1
        )[1].split('payload["t"] = now_ms', 1)[0]
        self.assertIn('payload["kidsMetricsT"] = now_ms', standard_kids_update)
        self.assertNotIn('kidsDiscoveryT', standard_kids_update)


if __name__ == '__main__':
    unittest.main()
