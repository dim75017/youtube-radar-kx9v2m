import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"


def dedicated_follower_workflow() -> tuple[Path, str]:
    matches = []
    for path in sorted(WORKFLOW_DIR.glob("*.y*ml")):
        text = path.read_text(encoding="utf-8")
        lower = text.lower()
        if path.name != "refresh-soundcharts.yml" and "--mode playlists" in text and "follower" in lower:
            matches.append((path, text))
    if len(matches) != 1:
        names = ", ".join(path.name for path, _ in matches) or "none"
        raise AssertionError(f"expected one dedicated playlist-follower workflow, found: {names}")
    return matches[0]


class PlaylistFollowerWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path, cls.workflow = dedicated_follower_workflow()

    def test_primary_and_catchup_passes_run_every_day_without_a_local_pc(self):
        crons = re.findall(r"cron:\s*['\"]?([^'\"\n]+)", self.workflow)
        self.assertGreaterEqual(
            len(crons),
            2,
            "the hosted follower collector needs a primary and a catch-up schedule each day",
        )
        self.assertIn("workflow_dispatch:", self.workflow)

    def test_collector_changes_trigger_an_immediate_guarded_verification(self):
        self.assertIn("push:", self.workflow)
        self.assertIn("branches: [main]", self.workflow)
        self.assertIn(".github/workflows/refresh-playlist-followers.yml", self.workflow)
        self.assertIn("build_spotify_playlist_analytics.py", self.workflow)
        self.assertIn("prepare_soundcharts_snapshot.py", self.workflow)

    def test_skip_gate_uses_real_visible_history_for_the_paris_day(self):
        self.assertRegex(self.workflow, r"ZoneInfo\(['\"]Europe/Paris['\"]\)")
        self.assertIn("Spotify_Playlists_canonical_data.js", self.workflow)
        self.assertIn("big10k", self.workflow)
        self.assertRegex(self.workflow, r"\bhist\b")

        gate = min(
            self.workflow.index("Europe/Paris"),
            self.workflow.index("big10k"),
            self.workflow.index("hist"),
        )
        refresh = self.workflow.index("--mode playlists")
        self.assertLess(gate, refresh, "coverage must be measured before deciding whether to collect")
        self.assertRegex(
            self.workflow.lower(),
            r"(?:complete|coverage).{0,80}(?:output|github_output|due|skip)",
            "the measured daily coverage must drive the run/skip decision",
        )

    def test_follower_publication_is_independent_from_catalogue_validation(self):
        for unrelated_gate in (
            "sync_soundcharts_opportunities.py",
            "expand_soundcharts_instrumental_pool.py",
            "classification",
            "instrumental_pool",
            "Activate snapshot only after remote validation",
        ):
            self.assertNotIn(unrelated_gate, self.workflow)

        self.assertIn("Spotify_Playlists_canonical_data.js", self.workflow)
        self.assertIn("Spotify_Performance_data.js", self.workflow)
        self.assertRegex(
            self.workflow,
            r"git\s+add[\s\S]{0,300}Spotify_Playlists_canonical_data\.js",
        )
        self.assertRegex(self.workflow, r"git\s+add[\s\S]{0,300}Spotify_Performance_data\.js")
        self.assertIn("git push", self.workflow)
        self.assertIn("Spotify_Performance_tracks", self.workflow)
        self.assertIn("git add -A --", self.workflow)

    def test_storage_validation_precedes_the_first_follower_api_call(self):
        storage = self.workflow.index("Validate and shard performance storage before paid collection")
        refresh = self.workflow.index("Refresh every playlist published in the dashboard")
        self.assertLess(storage, refresh)
        self.assertIn("--mode storage", self.workflow[storage:refresh])

    def test_canonical_transition_is_validated_before_publication(self):
        validation = self.workflow.index("validate_playlist_snapshot_transition.py")
        publication = self.workflow.index("Publish follower history independently")
        self.assertLess(validation, publication)
        self.assertNotIn("git add Spotify_Playlists_data.js", self.workflow)

    def test_candidate_uses_the_reviewed_compact_catalogue_source(self):
        candidate = self.workflow[
            self.workflow.index("Create isolated read-only Soundcharts candidate") :
            self.workflow.index("Size the request budget from the published cohort")
        ]
        self.assertIn("prepare_soundcharts_snapshot.py browse-source", candidate)
        self.assertIn("Spotify_Browse_Catalogue_data.js", candidate)
        self.assertNotIn("prepare_soundcharts_snapshot.py current --index", candidate)

    def test_partial_real_points_are_published_before_incomplete_coverage_alerts(self):
        publish = self.workflow.index("Publish follower history independently")
        strict_guard = self.workflow.index("Require 100 percent daily follower coverage")
        self.assertLess(
            publish,
            strict_guard,
            "one temporarily missing playlist must not discard every valid daily point",
        )

    def test_request_budget_grows_with_the_visible_cohort(self):
        self.assertIn("steps.coverage_before.outputs.expected", self.workflow)
        self.assertIn("steps.budget.outputs.requests", self.workflow)
        self.assertNotRegex(self.workflow, r"--max-requests\s+600\b")


if __name__ == "__main__":
    unittest.main()
