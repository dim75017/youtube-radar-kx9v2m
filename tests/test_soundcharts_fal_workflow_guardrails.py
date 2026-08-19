from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "scan-soundcharts-fal-phase1.yml"
MAIN_WORKFLOW = ROOT / ".github" / "workflows" / "refresh-soundcharts.yml"


class SoundchartsFalWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.main_workflow = MAIN_WORKFLOW.read_text(encoding="utf-8")

    def test_manual_start_and_cloud_resume_are_enabled(self):
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("- cron: '23 9 * * *'", self.workflow)
        self.assertIn("branches: [main]", self.workflow)
        self.assertIn("'build_soundcharts_fal_seed_ledger.py'", self.workflow)
        self.assertNotIn("*/2", self.workflow)
        self.assertIn("default: '40000'", self.workflow)
        self.assertIn('max_requests="${REQUESTED_MAX_REQUESTS:-40000}"', self.workflow)
        self.assertIn("timeout-minutes: 360", self.workflow)
        self.assertIn("timeout-minutes: 270", self.workflow)

    def test_soundcharts_collectors_share_one_serial_lock(self):
        expected = "group: refresh-soundcharts-ar-collection-${{ github.ref }}"
        self.assertIn(expected, self.workflow)
        self.assertIn("|| 'collection'", self.main_workflow)
        self.assertIn("-${{ github.ref }}", self.main_workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_checkpoint_is_private_separate_and_durable(self):
        self.assertIn("actions: write", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        self.assertNotIn("${{ runner.temp }}", self.workflow)
        self.assertIn(
            'echo "STATE_DIR=$RUNNER_TEMP/soundcharts-fal-phase1" >> "$GITHUB_ENV"',
            self.workflow,
        )
        self.assertIn('mkdir -p "$RUNNER_TEMP/soundcharts-fal-phase1"', self.workflow)
        self.assertIn(
            'echo "STATE_DB=$RUNNER_TEMP/soundcharts-fal-phase1/soundcharts-fal-phase1-staging-v2.sqlite3" >> "$GITHUB_ENV"',
            self.workflow,
        )
        self.assertIn(
            'echo "REPORT_JSON=$RUNNER_TEMP/soundcharts-fal-phase1/soundcharts-fal-phase1-report-v2.json" >> "$GITHUB_ENV"',
            self.workflow,
        )
        self.assertIn(
            'echo "SEED_LEDGER=$RUNNER_TEMP/soundcharts-fal-current-seed-ledger-v2.json" >> "$GITHUB_ENV"',
            self.workflow,
        )
        self.assertNotIn(
            'SEED_LEDGER=$RUNNER_TEMP/soundcharts-fal-phase1/',
            self.workflow,
        )
        self.assertIn("soundcharts-fal-phase1-staging-v2.sqlite3", self.workflow)
        self.assertIn("STATE_ARTIFACT: soundcharts-fal-phase1-state-v2", self.workflow)
        self.assertIn("LEGACY_STATE_ARTIFACT: soundcharts-fal-phase1-state", self.workflow)
        self.assertIn("Restore v2 or migrate the newest private v1 FAL checkpoint", self.workflow)
        self.assertIn('latest_v1="$(latest_artifact "$LEGACY_STATE_ARTIFACT")"', self.workflow)
        self.assertIn("A newer legacy v1 checkpoint exists", self.workflow)
        self.assertIn("PRAGMA quick_check", self.workflow)
        state_upload = self.workflow.index("Persist the private resumable FAL staging state")
        control_upload = self.workflow.index("Persist the small FAL completion control")
        report_upload = self.workflow.index("Preserve the immutable FAL phase-1 run report")
        upload_section = self.workflow[state_upload:report_upload]
        state_section = self.workflow[state_upload:control_upload]
        control_section = self.workflow[control_upload:report_upload]
        self.assertNotIn("${{ env.SEED_LEDGER }}", state_section)
        self.assertIn("${{ env.SEED_LEDGER }}", control_section)
        self.assertIn("always() &&", upload_section)
        self.assertIn("steps.restore_state.outcome == 'success'", upload_section)
        self.assertEqual(upload_section.count("steps.completion.outcome == 'success'"), 2)
        self.assertIn("retention-days: 90", self.workflow[state_upload:])
        self.assertIn("Keep only the two newest mutable FAL state artifacts", self.workflow)
        self.assertIn("| .[2:][] | .id", self.workflow)

    def test_completed_state_stops_before_secrets_or_authentication(self):
        dry_run = self.workflow.index("Inspect or initialize staging without Soundcharts authentication")
        completion = self.workflow.index("Stop when phase 1 is already complete")
        authenticated = self.workflow.index("Resume Fans Also Like and discovered discographies in staging")
        self.assertLess(dry_run, completion)
        self.assertLess(completion, authenticated)
        self.assertIn("--dry-run", self.workflow[dry_run:completion])
        self.assertIn('report.get("complete") is True', self.workflow[completion:authenticated])
        self.assertIn("checkpoint_scope == \"main_performer_v1\"", self.workflow[completion:authenticated])
        self.assertIn('file:{sys.argv[3]}?mode=ro', self.workflow[completion:authenticated])
        auth_section = self.workflow[authenticated:]
        self.assertIn("if: steps.completion.outputs.complete != 'true'", auth_section)
        self.assertIn("SOUNDCHARTS_CLIENT_ID", auth_section)
        self.assertNotIn("SOUNDCHARTS_CLIENT_ID", self.workflow[:authenticated])

    def test_full_seed_cohort_and_protected_quota_reserve_are_explicit(self):
        self.assertIn("MIN_RESOLVED_SEEDS: '4500'", self.workflow)
        self.assertIn("EMERGENCY_MAX_RESOLVED_SEEDS: '20000'", self.workflow)
        self.assertNotIn("HARD_MAX_RESOLVED_SEEDS", self.workflow)
        self.assertIn("MAX_SEED_GROWTH_PERCENT: '35'", self.workflow)
        self.assertIn("MAX_SEED_GROWTH_ABSOLUTE: '2000'", self.workflow)
        self.assertIn("MAX_SEED_SHRINK_PERCENT: '20'", self.workflow)
        self.assertIn("MAX_UNRESOLVED_SEEDS: '0'", self.workflow)
        self.assertIn("QUOTA_RESERVE: '500000'", self.workflow)
        self.assertIn("MAINTENANCE_DAILY_REQUESTS: '60000'", self.workflow)
        self.assertRegex(self.workflow, r"--max-seeds\s+[\"']?\$EMERGENCY_MAX_RESOLVED_SEEDS")
        self.assertEqual(
            self.workflow.count('--min-seed-guard "${{ steps.seed_transition.outputs.min_resolved }}"'),
            2,
        )
        self.assertEqual(
            self.workflow.count('--max-seed-guard "${{ steps.seed_transition.outputs.max_resolved }}"'),
            2,
        )
        self.assertRegex(self.workflow, r"--quota-reserve\s+[\"']?\$QUOTA_RESERVE")
        self.assertRegex(self.workflow, r"--maintenance-daily-requests\s+[\"']?\$MAINTENANCE_DAILY_REQUESTS")
        self.assertIn("COHORT_SNAPSHOT: Spotify_Soundcharts_data_20260721T181420Z.js", self.workflow)
        self.assertIn("prepare_soundcharts_snapshot.py current --index spotify/index.html", self.workflow)
        self.assertIn('--seed-snapshot "$COHORT_SNAPSHOT"', self.workflow)
        self.assertIn('--seed-ledger "$SEED_LEDGER"', self.workflow)
        self.assertIn("build_soundcharts_fal_seed_ledger.py", self.workflow)
        self.assertIn('--active-snapshot "${{ steps.active_snapshot.outputs.path }}"', self.workflow)
        self.assertIn('--previous-ledger "$PREVIOUS_SEED_LEDGER"', self.workflow)
        self.assertIn('--max-resolved "$EMERGENCY_MAX_RESOLVED_SEEDS"', self.workflow)
        self.assertIn('--max-growth-percent "$MAX_SEED_GROWTH_PERCENT"', self.workflow)
        self.assertIn('--max-growth-absolute "$MAX_SEED_GROWTH_ABSOLUTE"', self.workflow)
        self.assertIn('--max-shrink-percent "$MAX_SEED_SHRINK_PERCENT"', self.workflow)
        self.assertIn('--max-unresolved "$MAX_UNRESOLVED_SEEDS"', self.workflow)
        self.assertNotIn("--seed-snapshot Spotify_Soundcharts_data.js", self.workflow)
        self.assertIn("--browse-catalogue Spotify_Browse_Catalogue_data.js", self.workflow)
        self.assertIn("--performance Spotify_Performance_data.js", self.workflow)
        self.assertIn("--legacy-snapshot Spotify_Soundcharts_data.js", self.workflow)
        self.assertIn('report.get("seed_ledger")', self.workflow)
        self.assertIn("if not minimum <= resolved <= maximum", self.workflow)
        self.assertNotIn("--seed-min-audience 50000", self.workflow)
        self.assertEqual(self.workflow.count("--candidate-min-audience 50000"), 2)
        self.assertNotIn("--seed-max-audience", self.workflow)
        self.assertNotIn("--candidate-max-audience", self.workflow)

    def test_large_checkpoint_upload_uses_balanced_compression(self):
        state = self.workflow.index("Persist the private resumable FAL staging state")
        report = self.workflow.index("Preserve the immutable FAL phase-1 run report")
        self.assertIn("compression-level: 6", self.workflow[state:report])

    def test_completed_unchanged_scan_skips_large_restore_and_upload(self):
        previous_control = self.workflow.index("Restore the previous small FAL completion control")
        build = self.workflow.index("Build the deterministic canonical accepted seed ledger")
        control = self.workflow.index("Skip the huge checkpoint when completed coverage is unchanged")
        restore = self.workflow.index("Restore v2 or migrate the newest private v1 FAL checkpoint")
        upload = self.workflow.index("Persist the private resumable FAL staging state")
        report = self.workflow.index("Preserve the immutable FAL phase-1 run report")
        self.assertLess(previous_control, build)
        self.assertLess(build, control)
        self.assertLess(control, restore)
        self.assertIn("soundcharts-fal-phase1-control-v2", self.workflow)
        self.assertIn("current.get(\"cohort_hash\") == previous.get(\"cohort_hash\")", self.workflow)
        self.assertIn(
            'report.get("discographies", {}).get("scope_version") == "main_performer_v1"',
            self.workflow,
        )
        self.assertIn("skipped the multi-GB state download", self.workflow)
        self.assertIn("validate_report_seed_ledger(report, current)", self.workflow[control:restore])
        self.assertIn("Completion control report is stale", self.workflow[control:restore])
        self.assertIn("if: steps.completion_control.outputs.no_op != 'true'", self.workflow[restore:])
        self.assertIn("steps.completion_control.outputs.no_op != 'true'", self.workflow[upload:report])
        self.assertIn("steps.completion_control.outputs.no_op == 'true'", self.workflow[upload:report])
        completion = self.workflow.index("Stop when phase 1 is already complete")
        authenticated = self.workflow.index("Resume Fans Also Like and discovered discographies in staging")
        completion_section = self.workflow[completion:authenticated]
        self.assertIn("CHECKPOINT_NO_OP: ${{ steps.completion_control.outputs.no_op }}", completion_section)
        self.assertIn('if checkpoint_no_op:', completion_section)
        self.assertIn('report.get("discographies")', completion_section)
        self.assertIn('current_ledger = json.loads(Path(sys.argv[4])', completion_section)
        self.assertIn("require_generation_match=not checkpoint_no_op", completion_section)
        self.assertNotIn("queue: max", self.workflow)

    def test_seed_transition_is_validated_before_state_restore_or_authentication(self):
        previous_control = self.workflow.index("Restore the previous small FAL completion control")
        build = self.workflow.index("Build the deterministic canonical accepted seed ledger")
        restore = self.workflow.index("Restore v2 or migrate the newest private v1 FAL checkpoint")
        authenticated = self.workflow.index("Resume Fans Also Like and discovered discographies in staging")
        self.assertLess(previous_control, build)
        self.assertLess(build, restore)
        self.assertLess(build, authenticated)
        transition = self.workflow[build:restore]
        self.assertIn('transition = ledger.get("transition") or {}', transition)
        self.assertIn('output.write(f"min_resolved={minimum}\\n")', transition)
        self.assertIn('output.write(f"max_resolved={maximum}\\n")', transition)
        previous = self.workflow[previous_control:build]
        self.assertIn("refusing to establish a silent seed baseline", previous)
        self.assertIn("refusing an unaudited ledger transition", previous)
        self.assertIn("Using validated FAL completion control artifact", previous)
        self.assertIn("Ignoring inconsistent FAL completion control artifact", previous)
        self.assertIn("find \"$control_dir\" -type f -name '*seed-ledger-v2.json'", previous)
        self.assertIn("validate_report_seed_ledger(report, ledger, require_generation_match=False)", previous)
        self.assertIn("reverse | .[] | [.id, .created_at, .archive_download_url]", previous)

    def test_no_canonical_publication_or_repository_write_is_possible(self):
        forbidden = (
            "git add",
            "git commit",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
            "Spotify_Playlists_canonical_data.js",
        )
        for token in forbidden:
            self.assertNotIn(token, self.workflow)
        self.assertIn("Verify the scan remained staging-only", self.workflow)
        self.assertIn("git status --porcelain", self.workflow)

    def test_report_and_state_are_uploaded_even_after_a_failed_batch(self):
        scan = self.workflow.index("Resume Fans Also Like and discovered discographies in staging")
        state = self.workflow.index("Persist the private resumable FAL staging state")
        report = self.workflow.index("Preserve the immutable FAL phase-1 run report")
        section = self.workflow[scan:]
        self.assertLess(scan, state)
        self.assertLess(state, report)
        self.assertGreaterEqual(section.count("if: always()"), 3)
        self.assertIn("runner_error", section)
        self.assertIn("soundcharts-fal-phase1-report-${{ github.run_id }}-${{ github.run_attempt }}", section)

    def test_request_input_is_bounded_before_the_authenticated_step(self):
        plan = self.workflow.index("Validate bounded request plan")
        auth = self.workflow.index("Resume Fans Also Like and discovered discographies in staging")
        self.assertLess(plan, auth)
        section = self.workflow[plan:auth]
        self.assertIn("10#$max_requests > 40000", section)
        self.assertRegex(section, re.compile(r"max_requests must be an integer between 1 and 40000"))

    def test_exact_artifact_jq_programs_never_embed_shell_continuations(self):
        workflows = (
            "scan-soundcharts-fal-phase2.yml",
            "backfill-soundcharts-fal-spotify-ids.yml",
            "enrich-soundcharts-fal-phase3.yml",
            "audit-soundcharts-fal-promotion.yml",
        )
        for name in workflows:
            text = (ROOT / ".github" / "workflows" / name).read_text(
                encoding="utf-8"
            ).replace("\r\n", "\n")
            with self.subTest(workflow=name):
                self.assertNotIn(")] | \\\n", text)


if __name__ == "__main__":
    unittest.main()
