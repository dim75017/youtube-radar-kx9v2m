from pathlib import Path
import unittest


class YoutubeWorkflowGuardrailTests(unittest.TestCase):
    def test_feature_branches_do_not_publish_shared_daily_snapshots(self):
        workflow = Path('.github/workflows/refresh-instrumental-radar.yml').read_text(encoding='utf-8')
        publish = workflow.split('  publish:\n', 1)[1]
        self.assertIn("if: github.ref == 'refs/heads/main'", publish)
        self.assertIn('needs: scan', publish)


if __name__ == '__main__':
    unittest.main()
