from pathlib import Path
import unittest


class YoutubeWorkflowGuardrailTests(unittest.TestCase):
    def test_discovery_scan_waits_for_view_floor_validation(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        validate = workflow.split('  validate:\n', 1)[1].split('  scan:\n', 1)[0]
        scan = workflow.split('  scan:\n', 1)[1].split('  publish:\n', 1)[0]
        self.assertIn('tests.test_refresh_youtube_daily', validate)
        self.assertIn('test_youtube_new_video_view_floor.js', validate)
        self.assertIn('needs: validate', scan)

    def test_feature_branches_do_not_publish_shared_daily_snapshots(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)


if __name__ == '__main__':
    unittest.main()
