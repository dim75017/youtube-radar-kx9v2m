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
        self.assertIn('needs: validate', prepare)
        self.assertIn('--write-tracked-manifest artifacts/youtube-tracked-ids.json', prepare)
        self.assertIn('needs: prepare', scan)
        self.assertIn('--tracked-manifest artifacts/youtube-tracked-ids.json', scan)

    def test_daily_watchdog_retries_only_when_the_paris_snapshot_is_stale(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        gate = workflow.split('  gate:\n', 1)[1].split('  validate:\n', 1)[0]
        self.assertIn("cron: '17 7 * * *'", workflow)
        self.assertIn("cron: '47 19 * * *'", workflow)
        self.assertIn('--check-fresh-today', gate)
        self.assertIn('run_scan=false', gate)

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
