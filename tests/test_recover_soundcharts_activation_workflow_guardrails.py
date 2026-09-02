from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "recover-soundcharts-activation.yml"


class RecoverSoundchartsActivationWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_is_manual_main_only_and_shares_the_paid_collection_lock(self):
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertNotIn("schedule:", self.workflow)
        self.assertNotIn("pull_request:", self.workflow)
        self.assertIn("if: github.ref == 'refs/heads/main'", self.workflow)
        self.assertIn(
            "group: refresh-soundcharts-ar-collection-${{ github.ref }}",
            self.workflow,
        )
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_uses_only_the_minimum_functional_repository_permissions(self):
        self.assertIn("actions: write", self.workflow)
        self.assertIn("contents: write", self.workflow)
        for forbidden in ("deployments:", "id-token:", "pages:", "packages:"):
            self.assertNotIn(forbidden, self.workflow)

    def test_never_calls_soundcharts_or_any_fal_pipeline(self):
        for forbidden in (
            "SOUNDCHARTS_CLIENT_ID",
            "SOUNDCHARTS_CLIENT_SECRET",
            "refresh_soundcharts_daily.py",
            "expand_soundcharts_instrumental_pool.py",
            "discover_soundcharts_playlists.py",
            "scan_soundcharts_fal",
            "backfill_soundcharts_fal",
        ):
            self.assertNotIn(forbidden, self.workflow)

    def test_downloads_only_the_supplied_failed_run_checkpoint(self):
        self.assertIn("actions/download-artifact@v4", self.workflow)
        self.assertIn(
            "soundcharts-refresh-checkpoint-${{ inputs.source_run_id }}-${{ inputs.source_run_attempt }}",
            self.workflow,
        )
        self.assertIn("run-id: ${{ inputs.source_run_id }}", self.workflow)
        self.assertIn('[[ "$run_status" == "completed" ]]', self.workflow)
        self.assertIn('[[ "$run_conclusion" == "failure" ]]', self.workflow)
        self.assertIn('[[ "$run_branch" == "main" ]]', self.workflow)

    def test_staged_revision_is_verified_from_the_exact_git_blob(self):
        self.assertIn('git merge-base --is-ancestor "$STAGED_SHA" HEAD', self.workflow)
        self.assertIn("^data: stage validated Soundcharts snapshot$", self.workflow)
        self.assertIn('[[ "$latest_stage" == "$STAGED_SHA" ]]', self.workflow)
        self.assertIn('staged_blob="$(git rev-parse "$STAGED_SHA:$SNAPSHOT_NAME")"', self.workflow)
        self.assertIn('[[ "$local_blob" == "$staged_blob" ]]', self.workflow)
        self.assertNotIn("PUBLIC_BASE_URL", self.workflow)
        self.assertNotIn('$PUBLIC_BASE_URL/$SNAPSHOT_NAME', self.workflow)

    def test_activation_is_a_strict_compare_and_swap(self):
        self.assertNotIn("prepare_soundcharts_snapshot.py activate", self.workflow)
        self.assertIn(
            "prepare_soundcharts_snapshot.py browse-source --catalogue Spotify_Browse_Catalogue_data.js",
            self.workflow,
        )
        self.assertIn('[[ "$current" == "$EXPECTED_OLD" ]]', self.workflow)
        publish = self.workflow[self.workflow.index("Commit and publish only the recovered canonical outputs") :]
        self.assertIn('git show origin/main:Spotify_Browse_Catalogue_data.js', publish)
        self.assertIn('[[ "$remote_current" == "$EXPECTED_OLD" ]]', publish)
        self.assertIn("git rebase --autostash origin/main", publish)
        self.assertIn('--source "$SNAPSHOT_NAME"', self.workflow)

    def test_restores_every_checkpoint_output_but_not_the_private_candidate(self):
        restore = self.workflow[
            self.workflow.index("Restore checkpoint outputs without the private candidate") :
            self.workflow.index("Activate, rebuild, and validate the recovered dashboard")
        ]
        for required in (
            "Spotify_Performance_data.js",
            "Spotify_Performance_tracks",
            "Spotify_Playlists_canonical_data.js",
            "Spotify_Selection_Contacts_data.js",
            "soundcharts-history",
            "soundcharts-instrumental-cache.json",
        ):
            self.assertIn(required, restore)
        self.assertNotIn("Spotify_Soundcharts_candidate.js", restore)
        self.assertIn("rsync --archive --delete", restore)

    def test_rebuild_keeps_all_catalogue_and_fal_guards(self):
        build = self.workflow[
            self.workflow.index("python build_spotify_browse_catalogue.py") :
            self.workflow.index("python validate_playlist_snapshot_transition.py")
        ]
        for expected in (
            "--minimum-tracks 10000",
            "--minimum-streams 100000",
            "--performance Spotify_Performance_data.js",
            "--strict-rebased",
            "--trusted-catalogue spotify-catalogue-baseline.csv",
            "--trusted-artist-seeds spotify-catalogue-baseline.json",
            "--exclusions spotify-catalogue-exclusions.json",
            "--protected-review-cohorts spotify-protected-review-cohorts.json",
        ):
            self.assertIn(expected, build)
        self.assertIn('fal_promoted_tracks") or 0) != 0', self.workflow)
        self.assertIn('powfu_id = "6bmlMHgSheBauioMgKv2tn"', self.workflow)

    def test_playlist_transition_bootstrap_and_exact_commit_paths_are_preserved(self):
        self.assertIn('--previous "$PLAYLIST_BASELINE"', self.workflow)
        self.assertIn("name: soundcharts-bootstrap-state", self.workflow)
        self.assertIn("overwrite: true", self.workflow)
        stage = self.workflow[self.workflow.index("git add -A --") :]
        for required in (
            "Spotify_Browse_Catalogue_data.js",
            "Spotify_Playlists_canonical_data.js",
            "Spotify_Playlist_Analytics_data.js",
            "Spotify_Performance_data.js",
            "Spotify_Performance_tracks",
            "Spotify_Instant_data.js",
            "Spotify_Catalogue_data.js",
            "Spotify_Selection_Contacts_data.js",
            "soundcharts-history",
        ):
            self.assertIn(required, stage)
        self.assertNotIn("spotify/index.html", stage)
        self.assertNotIn("soundcharts-instrumental-cache.json", stage)
        self.assertNotIn("Spotify_Soundcharts_candidate.js", stage)

    def test_push_precedes_explicit_pages_dispatch(self):
        push = self.workflow.index("git push origin HEAD:main")
        dispatch = self.workflow.index("trigger_pages_deployment.py")
        self.assertLess(push, dispatch)
        self.assertIn("--sha \"$PUBLISHED_SHA\"", self.workflow)
        self.assertIn("--wait-for-completion", self.workflow)
        self.assertIn("--run-timeout 1800", self.workflow)

    def test_already_active_recovery_retries_pages_without_collection(self):
        marker = "Re-dispatch Pages when the snapshot is already active"
        self.assertIn(marker, self.workflow)
        section = self.workflow[self.workflow.index(marker) :]
        self.assertIn("steps.guard.outputs.already_active == 'true'", section)
        self.assertIn("trigger_pages_deployment.py", section)
        self.assertIn("--wait-for-completion", section)
        self.assertNotIn("refresh_soundcharts_daily.py", section)


if __name__ == "__main__":
    unittest.main()
