from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-soundcharts.yml"
BROWSE_WORKFLOW = ROOT / ".github" / "workflows" / "refresh-spotify-browse-catalogue.yml"


class SoundchartsWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_private_staged_snapshot_uses_git_blob_proof_only(self):
        self.assertNotIn("Wait for staged snapshot to be live and green", self.workflow)
        self.assertNotIn('public_verified="false"', self.workflow)
        self.assertNotIn('$PUBLIC_BASE_URL/$SNAPSHOT_NAME', self.workflow)
        verify = self.workflow.index("Verify dated snapshot exists on main")
        activate = self.workflow.index("Activate snapshot only after remote validation")
        self.assertLess(verify, activate)
        section = self.workflow[verify:activate]
        self.assertIn('remote_blob="$(git rev-parse "$STAGED_SHA:$SNAPSHOT_NAME")"', section)
        self.assertIn('test "$local_blob" = "$remote_blob"', section)
        self.assertIn('git merge-base --is-ancestor "$STAGED_SHA" origin/main', section)

    def test_private_stage_does_not_trigger_the_browse_rebuilder(self):
        browse_workflow = BROWSE_WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("Spotify_Soundcharts_data_*", browse_workflow)

    def test_activation_rebases_a_benign_later_main_commit(self):
        self.assertIn('git stash push --include-untracked -m "soundcharts-activation-rebase"', self.workflow)
        self.assertIn('if [[ "$stashed_changes" == "true" ]]; then', self.workflow)
        self.assertIn("git stash pop", self.workflow)
        self.assertIn("git rebase origin/main", self.workflow)
        self.assertIn('staged_blob="$(git rev-parse "$STAGED_SHA:$SNAPSHOT_NAME")"', self.workflow)
        self.assertIn('test "$local_blob" = "$staged_blob"', self.workflow)
        self.assertIn('test "$current_snapshot" = "$OLD_SNAPSHOT"', self.workflow)
        self.assertIn('git show origin/main:Spotify_Browse_Catalogue_data.js', self.workflow)
        self.assertIn('test "$remote_current" = "$OLD_SNAPSHOT"', self.workflow)
        self.assertIn("git rebase --autostash origin/main", self.workflow)

    def test_only_final_runtime_commit_waits_for_pages(self):
        stage = self.workflow[
            self.workflow.index("Publish validated dated snapshot first") :
            self.workflow.index("Publish refreshed playlist covers")
        ]
        self.assertNotIn("trigger_pages_deployment.py", stage)
        activation = self.workflow[self.workflow.index("Activate snapshot only after remote validation") :]
        self.assertIn("trigger_pages_deployment.py", activation)
        self.assertIn("--wait-for-completion", activation)
        self.assertIn("--run-timeout 1800", activation)

    def test_playlist_cover_scope_skips_snapshot_staging_and_activation(self):
        for step_name in (
            "Publish validated dated snapshot first",
            "Verify dated snapshot exists on main",
            "Persist Soundcharts bootstrap state outside Git",
            "Activate snapshot only after remote validation",
        ):
            start = self.workflow.index(f"- name: {step_name}")
            section = self.workflow[start : start + 600]
            self.assertIn("steps.prepared.outputs.name != ''", section)
        playlist = self.workflow.index("Publish refreshed playlist covers")
        self.assertIn(
            "steps.plan.outputs.scope == 'playlist_covers'",
            self.workflow[playlist : playlist + 300],
        )

    def test_track_catchup_is_marked_for_post_run_watchdog_validation(self):
        self.assertIn('echo "track_catchup=$track_catchup" >> "$GITHUB_OUTPUT"', self.workflow)
        self.assertIn("PUBLIC_TRACK_CATCHUP: ${{ steps.plan.outputs.track_catchup }}", self.workflow)
        self.assertIn("catchup_args+=(--public-track-catchup)", self.workflow)

    def test_compact_runtime_is_rebuilt_before_its_contract_tests(self):
        build = self.workflow.index("node build_spotify_instant_runtime.js")
        contract = self.workflow.index("node tests/test_spotify_instant_runtime.js")
        self.assertLess(build, contract)

    def test_public_snapshot_is_compared_with_the_current_approved_snapshot(self):
        prepare = self.workflow.index("Prepare public-safe dated snapshot")
        validate = self.workflow.index("Validate generated business outputs")
        section = self.workflow[prepare:validate]
        self.assertIn('--previous "${{ steps.snapshot.outputs.old }}"', section)

    def test_compact_catalogue_owns_the_active_snapshot_pointer(self):
        candidate = self.workflow[
            self.workflow.index("Create an isolated Soundcharts candidate") :
            self.workflow.index("Verify Soundcharts authentication and response contracts")
        ]
        self.assertIn("prepare_soundcharts_snapshot.py browse-source", candidate)
        self.assertIn("Spotify_Browse_Catalogue_data.js", candidate)
        activation = self.workflow[
            self.workflow.index("Activate snapshot only after remote validation") :
        ]
        self.assertNotIn("prepare_soundcharts_snapshot.py activate", activation)

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

    def test_pending_validated_snapshot_blocks_paid_recollection(self):
        storage = self.workflow.index("Validate and shard performance storage before paid collection")
        pending = self.workflow.index("Refuse paid recollection while a validated snapshot awaits recovery")
        first_paid = self.workflow.index("Refresh mapped artist audience only when explicitly requested")
        self.assertLess(storage, pending)
        self.assertLess(pending, first_paid)
        section = self.workflow[pending:first_paid]
        self.assertIn("prepare_soundcharts_snapshot.py browse-source", section)
        self.assertIn("git ls-tree --name-only HEAD", section)
        self.assertIn("Recover its checkpoint before spending more API calls", section)

    def test_performance_shard_creations_and_deletions_are_published(self):
        self.assertIn("git add -A --", self.workflow)
        self.assertIn("Spotify_Performance_tracks", self.workflow)

    def test_quota_bounded_maintenance_runs_daily_without_cancelling_a_live_run(self):
        self.assertIn("- cron: '17 10 * * *'", self.workflow)
        self.assertIn('scope="maintenance"', self.workflow)
        self.assertIn('expansion_requests="0"', self.workflow)
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
            "Classify new direct and playlist tracks in every catalogue refresh"
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

    def test_daily_rebaseline_classifies_new_candidates_before_rebuild(self):
        self.assertIn('daily_classification_data_cap="1500"', self.workflow)
        self.assertIn(
            "if: steps.plan.outputs.scope == 'strict_rebaseline' || "
            "steps.plan.outputs.scope == 'full_sync'",
            self.workflow[
                self.workflow.index(
                    "Classify new direct and playlist tracks in every catalogue refresh"
                ) : self.workflow.index("Expand and measure the target instrumental pool")
            ],
        )
        self.assertIn(
            '--max-requests "${{ steps.plan.outputs.classification_requests }}"',
            self.workflow,
        )

    def test_maintenance_never_repeats_completed_discovery_or_pool_scans(self):
        paid_lanes = (
            (
                "Refresh playlist follower history every 24 hours",
                "Refresh published playlist covers from Soundcharts",
            ),
            (
                "Discover tracks and artist catalogues from editorial playlists",
                "Discover a rotating batch of independent background playlists",
            ),
            (
                "Discover a rotating batch of independent background playlists",
                "Discover every Dark Ambient playlist and their artist catalogues",
            ),
            (
                "Classify new direct and playlist tracks in every catalogue refresh",
                "Expand and measure the target instrumental pool",
            ),
            (
                "Expand and measure the target instrumental pool",
                "Refresh the complete performance artist catalogue every week",
            ),
        )
        for start_name, end_name in paid_lanes:
            section = self.workflow[
                self.workflow.index(start_name) : self.workflow.index(end_name)
            ]
            self.assertNotIn("scope == 'maintenance'", section, start_name)

    def test_full_sync_refreshes_each_dashboard_source_and_daily_playlist_followers(self):
        self.assertIn("full_sync", self.workflow)
        self.assertIn("Refresh adaptive priority and rotating track coverage every 24 hours", self.workflow)
        self.assertIn("Refresh the complete performance artist catalogue every week", self.workflow)
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
        self.assertIn("--performance Spotify_Performance_data.js", section[rebuild:stage])
        self.assertIn("--exclusions spotify-catalogue-exclusions.json", section[rebuild:stage])
        self.assertIn(
            "--protected-review-cohorts spotify-protected-review-cohorts.json",
            section[rebuild:stage],
        )
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

    def test_scheduled_maintenance_fits_the_developer_plan(self):
        self.assertIn('performance_catalogue_due="false"', self.workflow)
        self.assertIn('scope="maintenance"', self.workflow)
        self.assertIn('performance_artist_data_cap="12000"', self.workflow)
        self.assertIn('performance_track_data_cap="6000"', self.workflow)
        self.assertIn('track_catchup_data_cap="24000"', self.workflow)
        self.assertIn('maintenance|track_catchup|artists', self.workflow)
        self.assertIn('if [[ "$scope" == "track_catchup" ]]', self.workflow)
        self.assertIn('performance_artists_due="false"', self.workflow)
        self.assertIn('full_sync_track_data_cap="35000"', self.workflow)
        self.assertIn("dt.timedelta(hours=156)", self.workflow)
        self.assertIn('playlist_data_cap="3000"', self.workflow)
        self.assertIn('"$FRESHNESS_GATE" == "true"', self.workflow)
        self.assertIn('performance_tracks_due="true"', self.workflow)
        self.assertIn(
            "steps.plan.outputs.scope == 'maintenance' && "
            "steps.plan.outputs.performance_artists_due == 'true'",
            self.workflow,
        )
        self.assertIn(
            "steps.plan.outputs.scope == 'maintenance' && "
            "steps.plan.outputs.performance_tracks_due == 'true'",
            self.workflow,
        )
        maintenance_start = self.workflow.index('if [[ "$scope" == "maintenance" ]]')
        strict_watchdog = self.workflow.index(
            'elif [[ "${{ github.event_name }}" == "workflow_dispatch"',
            maintenance_start,
        )
        maintenance_plan = self.workflow[maintenance_start:strict_watchdog]
        self.assertNotIn("spotify_followers", maintenance_plan)
        self.assertIn('expansion_requests="0"', self.workflow)
        self.assertEqual(self.workflow.count("--include-performance-catalogue"), 2)
        self.assertIn("--browse-catalogue Spotify_Browse_Catalogue_data.js", self.workflow)
        self.assertIn('performance_track_data_cap="$REQUESTED_MAX_REQUESTS"', self.workflow)
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
