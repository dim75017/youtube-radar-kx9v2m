from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "backfill-soundcharts-fal-spotify-ids.yml"


class SoundchartsFalSpotifyIdWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_runs_only_after_complete_phase2_or_manual_dispatch(self):
        self.assertIn(
            'workflows: ["Scan Soundcharts Fans Also Like phase 2"]', self.workflow
        )
        self.assertIn("github.event.workflow_run.conclusion == 'success'", self.workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", self.workflow)
        self.assertNotIn("  push:", self.workflow)
        self.assertIn("workflow_dispatch:", self.workflow)

    def test_shares_exact_paid_soundcharts_concurrency_lock(self):
        self.assertIn(
            "group: refresh-soundcharts-ar-collection-${{ github.ref }}",
            self.workflow,
        )
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_workflow_run_consumes_only_its_exact_phase2_artifact(self):
        self.assertIn('triggering_phase2_run_id="${{ github.event.workflow_run.id }}"', self.workflow)
        self.assertIn("(.workflow_run.id | tostring) == $run_id", self.workflow)
        self.assertIn('phase2_state_exact="false"', self.workflow)
        self.assertIn("Phase-2 artifact does not belong to the triggering workflow run", self.workflow)
        self.assertIn("PHASE2_CONTROL_ARTIFACT: soundcharts-fal-phase2-control-v5", self.workflow)
        self.assertIn("Triggering Phase-2 run has no exact completion control", self.workflow)
        self.assertIn("Triggering Phase-2 control lacks exact state proof", self.workflow)
        self.assertIn("Restored Phase-2 state does not match the triggering completion control", self.workflow)

    def test_successful_noop_still_uploads_an_exact_encrypted_phase3_handoff(self):
        encrypt = self.workflow.index("Encrypt exact state before artifact storage")
        upload = self.workflow.index("Persist exact encrypted backfill handoff")
        self.assertLess(encrypt, upload)
        section = self.workflow[encrypt:upload]
        self.assertIn("steps.backfill.outcome == 'success'", section)
        self.assertIn("steps.verify.outcome == 'success'", section)
        self.assertNotIn("state_changed == 'true'", section)

    def test_request_cap_and_quota_floor_are_fail_closed(self):
        self.assertIn("ABSOLUTE_MAX_REQUESTS: '15000'", self.workflow)
        self.assertIn("MIN_QUOTA_RESERVE: '1400000'", self.workflow)
        self.assertIn("Maximum Soundcharts attempts including retries (1-15000)", self.workflow)
        self.assertIn("10#$max_requests > 15000", self.workflow)
        self.assertIn('--quota-reserve "$MIN_QUOTA_RESERVE"', self.workflow)
        self.assertIn('--workers "$WORKERS"', self.workflow)
        self.assertIn("claimed\") or 0) > 15000", self.workflow)

    def test_restores_and_preserves_phase2_state_and_completion_report(self):
        self.assertIn("soundcharts-fal-phase2-state-v3", self.workflow)
        self.assertIn("soundcharts-fal-phase2-spotify-id-state-v1-encrypted", self.workflow)
        self.assertIn("soundcharts-fal-phase2-report-v4.json", self.workflow)
        self.assertIn('--phase2-report "$PHASE2_REPORT"', self.workflow)
        self.assertIn('cp "$PHASE2_REPORT" "$bundle/soundcharts-fal-phase2-report-v4.json"', self.workflow)
        state_upload = self.workflow.index("Persist exact encrypted backfill handoff")
        state_section = self.workflow[state_upload:]
        self.assertIn("${{ env.ENCRYPTED_STATE }}", state_section)
        self.assertNotIn("${{ env.PHASE2_DB }}", state_section)
        self.assertNotIn("${{ env.PHASE2_REPORT }}", state_section)
        self.assertIn("steps.encrypt_state.outcome == 'success'", state_section)

    def test_public_repo_artifacts_require_a_dedicated_encryption_key(self):
        key_check = self.workflow.index("Require dedicated staging artifact encryption key")
        paid_call = self.workflow.index("Backfill exact Spotify identities")
        self.assertLess(key_check, paid_call)
        self.assertIn("secrets.FAL_STAGING_ARTIFACT_KEY", self.workflow)
        self.assertIn("FAL_STAGING_ARTIFACT_KEY is required before any Soundcharts call", self.workflow)
        self.assertIn("openssl enc -aes-256-cbc -pbkdf2", self.workflow)
        self.assertNotIn("-pass env:SOUNDCHARTS_CLIENT_SECRET", self.workflow)

    def test_newer_phase2_state_reuses_prior_encrypted_identity_cache(self):
        self.assertIn("phase2_plaintext_source", self.workflow)
        self.assertIn("IDENTITY_CACHE_DB", self.workflow)
        self.assertIn('--identity-cache-state "$IDENTITY_CACHE_DB"', self.workflow)
        self.assertIn("newer phase-2 source wins", self.workflow)

    def test_never_writes_repository_canonical_or_dashboard_data(self):
        self.assertIn("actions: write", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        forbidden = (
            "git add",
            "git commit",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
            "Spotify_Soundcharts_data.js",
            "Spotify_Performance_data.js",
            "Spotify_Radar_data.js",
        )
        for token in forbidden:
            self.assertNotIn(token, self.workflow)
        self.assertIn("canonical_written", self.workflow)
        self.assertIn("dashboard_written", self.workflow)
        self.assertIn('test -z "$(git status --porcelain)"', self.workflow)

    def test_reports_are_aggregate_only_and_raw_responses_are_forbidden(self):
        self.assertIn("raw_responses_persisted", self.workflow)
        self.assertIn("Raw Soundcharts responses were persisted", self.workflow)
        self.assertIn("soundcharts-fal-spotify-id-backfill-report-v1", self.workflow)
        self.assertIn("row_level_data_uploaded", self.workflow)
        upload = self.workflow.index("Upload aggregate review summary only")
        upload_section = self.workflow[upload:self.workflow.index("Keep only the two newest", upload)]
        self.assertIn("${{ env.REVIEW_SUMMARY }}", upload_section)
        self.assertNotIn("soundcharts-fal-review-manifest-v1.json", upload_section)
        self.assertNotIn("soundcharts-fal-review-manifest-v1.tsv", upload_section)
        self.assertIn("retention-days: 90", self.workflow)

    def test_ambiguous_and_duplicate_identities_cannot_be_assigned(self):
        self.assertIn("ambiguous_never_assigned", self.workflow)
        self.assertIn("duplicate_within_phase2_never_assigned", self.workflow)
        self.assertIn("Conflicted identity was assigned", self.workflow)
        self.assertIn("A within-phase-2 duplicate Spotify ID entered resolved staging", self.workflow)
        self.assertIn("canonical_promotion_allowed", self.workflow)

    def test_review_manifest_is_chained_only_after_successful_backfill(self):
        build = self.workflow.index("Chain review builder and keep only aggregate counts")
        upload = self.workflow.index("Upload aggregate review summary only")
        self.assertLess(build, upload)
        section = self.workflow[build:upload]
        self.assertIn("build_soundcharts_fal_review_manifest.py", section)
        self.assertIn('rm -f "$raw_json" "$raw_tsv"', section)
        self.assertIn("steps.backfill.outcome == 'success'", self.workflow[build - 500:build])


if __name__ == "__main__":
    unittest.main()
