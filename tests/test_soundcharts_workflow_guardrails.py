from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-soundcharts.yml"


class SoundchartsWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_pages_wait_covers_slow_deployments(self):
        self.assertIn("timeout-minutes: 45", self.workflow)
        self.assertIn("for poll in $(seq 1 160); do", self.workflow)
        self.assertIn('if [[ "$poll" == "160" ]]; then', self.workflow)
        self.assertIn("sleep 15", self.workflow)
        self.assertIn("for poll in $(seq 1 12); do", self.workflow)

    def test_superseded_pages_deployment_relies_on_public_bytes(self):
        self.assertIn('public_verified="false"', self.workflow)
        self.assertIn('if [[ "$public_sha256" == "$local_sha256" ]]', self.workflow)
        self.assertNotIn('"$deployment_state" == "inactive"', self.workflow)
        self.assertNotIn('actions_state=', self.workflow)
        self.assertIn('waiting for a superseding deployment', self.workflow)
        self.assertNotIn('Pages failed for staged SHA', self.workflow)

    def test_activation_rebases_a_benign_later_main_commit(self):
        self.assertIn('git stash push --include-untracked -m "soundcharts-activation-rebase"', self.workflow)
        self.assertIn('if [[ "$stashed_changes" == "true" ]]; then', self.workflow)
        self.assertIn("git stash pop", self.workflow)
        self.assertIn("git rebase origin/main", self.workflow)
        self.assertIn('staged_blob="$(git rev-parse "$STAGED_SHA:$SNAPSHOT_NAME")"', self.workflow)
        self.assertIn('test "$local_blob" = "$staged_blob"', self.workflow)

    def test_live_bytes_are_still_required_before_activation(self):
        wait = self.workflow.index("Wait for staged snapshot to be live and green")
        hash_check = self.workflow.index('if [[ "$public_sha256" == "$local_sha256" ]]')
        activate = self.workflow.index("Activate snapshot only after remote validation")
        self.assertLess(wait, hash_check)
        self.assertLess(hash_check, activate)

    def test_public_snapshot_is_compared_with_the_current_approved_snapshot(self):
        prepare = self.workflow.index("Prepare public-safe dated snapshot")
        validate = self.workflow.index("Validate generated business outputs")
        section = self.workflow[prepare:validate]
        self.assertIn('--previous "${{ steps.snapshot.outputs.old }}"', section)

    def test_completed_collection_is_checkpointed_before_snapshot_guards(self):
        checkpoint = self.workflow.index(
            "Preserve completed collection before publication guards"
        )
        prepare = self.workflow.index("Prepare public-safe dated snapshot")
        self.assertLess(checkpoint, prepare)
        section = self.workflow[checkpoint:prepare]
        self.assertIn("actions/upload-artifact@v4", section)
        self.assertIn("${{ steps.snapshot.outputs.candidate }}", section)
        self.assertIn("Spotify_Performance_data.js", section)
        self.assertIn("Spotify_Performance_tracks", section)
        self.assertIn("soundcharts-history", section)
        self.assertIn("soundcharts-instrumental-cache.json", section)
        self.assertIn("retention-days: 3", section)

    def test_performance_store_is_validated_before_any_paid_collection(self):
        storage = self.workflow.index("Validate and shard performance storage before paid collection")
        first_paid = min(
            self.workflow.index("Verify Soundcharts authentication and response contracts"),
            self.workflow.index("Refresh mapped artist audience only when explicitly requested"),
            self.workflow.index("Refresh playlist follower history every 24 hours"),
        )
        self.assertLess(storage, first_paid)
        section = self.workflow[storage:first_paid]
        self.assertIn("--mode storage", section)
        self.assertIn("Spotify_Performance_data.js", section)

    def test_performance_shard_creations_and_deletions_are_published(self):
        self.assertIn("git add -A --", self.workflow)
        self.assertIn("Spotify_Performance_tracks", self.workflow)

    def test_complete_sync_runs_daily_without_cancelling_a_live_run(self):
        self.assertIn("- cron: '17 4 * * *'", self.workflow)
        self.assertNotIn("2-57/5", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_classification_rebuilds_the_non_public_playlist_pool_first(self):
        discovery_condition = (
            "if: steps.plan.outputs.scope == 'strict_rebaseline' || "
            "steps.plan.outputs.scope == 'classification'"
        )
        editorial = self.workflow.index(
            "Discover tracks and artist catalogues from editorial playlists"
        )
        independent = self.workflow.index(
            "Discover a rotating batch of independent background playlists"
        )
        classify = self.workflow.index(
            "Classify pending playlist tracks from exact Soundcharts song genres"
        )
        self.assertIn(discovery_condition, self.workflow[editorial:independent])
        self.assertIn(discovery_condition, self.workflow[independent:classify])
        self.assertLess(editorial, classify)
        self.assertLess(independent, classify)

    def test_manual_full_sync_rediscovers_editorial_and_independent_catalogues(self):
        full_sync_discovery_condition = (
            "if: steps.plan.outputs.scope == 'strict_rebaseline' || "
            "steps.plan.outputs.scope == 'classification' || "
            "steps.plan.outputs.scope == 'full_sync'"
        )
        editorial = self.workflow.index(
            "Discover tracks and artist catalogues from editorial playlists"
        )
        independent = self.workflow.index(
            "Discover a rotating batch of independent background playlists"
        )
        classify = self.workflow.index(
            "Classify pending direct and playlist tracks before a full synchronization"
        )
        self.assertIn(
            full_sync_discovery_condition, self.workflow[editorial:independent]
        )
        self.assertIn(
            full_sync_discovery_condition, self.workflow[independent:classify]
        )
        self.assertIn(
            "if os.environ.get('RUN_SCOPE') in {'strict_rebaseline', 'full_sync'}:",
            self.workflow,
        )

    def test_full_sync_refreshes_each_dashboard_source_and_daily_playlist_followers(self):
        self.assertIn("full_sync", self.workflow)
        self.assertIn("Refresh adaptive performance track coverage every 24 hours", self.workflow)
        self.assertIn("Refresh the complete performance artist catalogue every 24 hours", self.workflow)
        self.assertIn("Refresh playlist follower history every 24 hours", self.workflow)
        self.assertIn("playlist_followers_due", self.workflow)
        self.assertIn(
            "Spotify_Playlists_canonical_data.js",
            self.workflow[self.workflow.index("Activate snapshot only after remote validation"):],
        )

    def test_activation_rebuilds_the_visible_catalogue_in_the_same_commit(self):
        activation = self.workflow.index("Activate snapshot only after remote validation")
        section = self.workflow[activation:]
        rebuild = section.index("python build_spotify_browse_catalogue.py")
        stage = section.index("git add")
        self.assertLess(rebuild, stage)
        self.assertIn('--source "$SNAPSHOT_NAME"', section[rebuild:stage])
        self.assertIn("Spotify_Browse_Catalogue_data.js", section[stage:])

    def test_selection_contacts_are_prioritised_built_and_published(self):
        self.assertIn("node tests/test_ar_outreach_workflow.js", self.workflow)
        self.assertIn("node tests/test_spotify_selection_contact_state_machine.js", self.workflow)
        enrich = self.workflow.index("Enrich public professional contacts progressively")
        build = self.workflow.index("Build Selection-only public contact directory")
        recalculate = self.workflow.index("Recalculate actionable A&R opportunities")
        self.assertLess(enrich, build)
        self.assertLess(build, recalculate)
        enrich_section = self.workflow[enrich:build]
        self.assertIn("--priority-artists spotify-selection-artist-seeds.json", enrich_section)
        self.assertIn("--max-artists 100", enrich_section)
        build_section = self.workflow[build:recalculate]
        self.assertIn("python build_spotify_selection_contacts.py", build_section)
        self.assertIn("--overrides spotify-selection-contact-overrides.json", build_section)
        self.assertIn("--output Spotify_Selection_Contacts_data.js", build_section)
        checkpoint = self.workflow.index("Preserve completed collection before publication guards")
        prepare = self.workflow.index("Prepare public-safe dated snapshot")
        self.assertIn("Spotify_Selection_Contacts_data.js", self.workflow[checkpoint:prepare])
        activation = self.workflow.index("Activate snapshot only after remote validation")
        self.assertIn("Spotify_Selection_Contacts_data.js", self.workflow[activation:])

    def test_scheduled_rebaseline_refreshes_complete_performance_catalogue_once_due(self):
        self.assertIn('performance_catalogue_due="false"', self.workflow)
        self.assertIn("is_due('tracks_catalogue_at')", self.workflow)
        self.assertIn("is_due('artists_catalogue_at')", self.workflow)
        self.assertIn("dt.timedelta(hours=24)", self.workflow)
        self.assertIn('performance_artist_data_cap="15000"', self.workflow)
        self.assertIn('performance_track_data_cap="35000"', self.workflow)
        self.assertIn('playlist_data_cap="3000"', self.workflow)
        self.assertIn('"$FRESHNESS_GATE" == "true"', self.workflow)
        self.assertIn('performance_tracks_due="true"', self.workflow)
        self.assertIn('performance_artists_due="true"', self.workflow)
        self.assertIn('--target spotify_followers --print-due', self.workflow)
        self.assertIn(
            "steps.plan.outputs.scope == 'strict_rebaseline' && "
            "steps.plan.outputs.performance_artists_due == 'true'",
            self.workflow,
        )
        self.assertIn(
            "steps.plan.outputs.scope == 'strict_rebaseline' && "
            "steps.plan.outputs.performance_tracks_due == 'true'",
            self.workflow,
        )
        self.assertEqual(self.workflow.count("--include-performance-catalogue"), 2)
        self.assertIn(
            '--max-requests "${{ steps.plan.outputs.performance_artist_requests }}"',
            self.workflow,
        )
        self.assertIn(
            '--max-requests "${{ steps.plan.outputs.performance_track_requests }}"',
            self.workflow,
        )

    def test_public_catalogue_validation_respects_sanitization_and_quarantine(self):
        self.assertNotIn(
            "len(public_discovery_tracks) < unique_playlist_tracks",
            self.workflow,
        )
        self.assertIn(
            "int((public_counts or {}).get('tracks') or 0) != len(public_discovery_tracks)",
            self.workflow,
        )
        self.assertIn(
            "published_playlist_tracks > unique_playlist_tracks",
            self.workflow,
        )


if __name__ == "__main__":
    unittest.main()
