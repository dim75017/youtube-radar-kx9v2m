from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "audit-soundcharts-fal-promotion.yml"


class SoundchartsFalPromotionWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_runs_after_exact_spotify_id_backfill_and_can_be_dispatched(self):
        self.assertIn(
            'workflows: ["Backfill Soundcharts FAL Spotify IDs"]', self.workflow
        )
        self.assertIn("github.event.workflow_run.conclusion == 'success'", self.workflow)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", self.workflow)
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("push:", self.workflow)

    def test_is_read_only_and_spends_no_soundcharts_quota(self):
        self.assertIn("actions: read", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        forbidden = (
            "SOUNDCHARTS_CLIENT_ID",
            "SOUNDCHARTS_CLIENT_SECRET",
            "SOUNDCHARTS_API_KEY",
            "refresh_soundcharts",
            "git add",
            "git commit",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
        )
        for token in forbidden:
            self.assertNotIn(token, self.workflow)

    def test_restores_only_the_newest_encrypted_spotify_id_state(self):
        self.assertIn(
            "soundcharts-fal-phase2-spotify-id-state-v1-encrypted", self.workflow
        )
        self.assertIn("sort_by(.created_at) | last", self.workflow)
        self.assertIn("secrets.FAL_STAGING_ARTIFACT_KEY", self.workflow)
        self.assertIn(
            "openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256",
            self.workflow,
        )
        self.assertIn("soundcharts-fal-phase2-state-v3.sqlite3", self.workflow)
        self.assertIn("soundcharts-fal-phase2-report-v4.json", self.workflow)

    def test_compares_against_current_canonical_catalogue_by_exact_id(self):
        build = self.workflow.index(
            "Compare exact IDs and build private promotion candidate cohort"
        )
        verify = self.workflow.index(
            "Verify exact deduplication and fail-closed candidate invariants"
        )
        section = self.workflow[build:verify]
        self.assertIn("build_soundcharts_fal_promotion_cohort.py", section)
        self.assertIn("--canonical Spotify_Browse_Catalogue_data.js", section)
        self.assertIn('--minimum-streams "$MINIMUM_STREAMS"', section)
        self.assertIn("exact_spotify_track_id_only", self.workflow)
        self.assertIn("canonical_duplicate_spotify_id", self.workflow)
        self.assertIn("Candidate cohort contains an invalid or duplicate Spotify ID", self.workflow)

    def test_unknown_evidence_is_fail_closed_except_ai_catalogue_review_lane(self):
        self.assertIn("Blocked evidence entered the promotion candidate cohort", self.workflow)
        self.assertIn("AI-unknown candidate entered Opportunities", self.workflow)
        self.assertIn("ai_review_required", self.workflow)
        self.assertIn("opportunity_eligible", self.workflow)
        self.assertIn("explicit_dim_promotion_validation_required", self.workflow)
        self.assertIn("Explicit Dim validation is no longer required", self.workflow)

    def test_audience_size_and_career_stage_never_block(self):
        self.assertIn("audience_size_and_career_stage_never_block", self.workflow)
        self.assertIn(
            "Audience size or career stage can block the FAL cohort", self.workflow
        )

    def test_private_rows_are_encrypted_and_erased_before_artifact_upload(self):
        encrypt = self.workflow.index("Encrypt private cohort and erase plaintext rows")
        upload_private = self.workflow.index(
            "Upload encrypted private promotion candidates only"
        )
        upload_aggregate = self.workflow.index(
            "Upload aggregate promotion audit report only"
        )
        section = self.workflow[encrypt:upload_private]
        self.assertIn("openssl enc -aes-256-cbc -pbkdf2", section)
        self.assertIn('rm -f "$REVIEW_MANIFEST" "$PRIVATE_COHORT"', section)
        self.assertIn('test ! -e "$PRIVATE_COHORT"', section)

        private_upload = self.workflow[upload_private:upload_aggregate]
        self.assertIn("${{ env.ENCRYPTED_COHORT }}", private_upload)
        self.assertNotIn("${{ env.PRIVATE_COHORT }}", private_upload)
        self.assertNotIn("${{ env.REVIEW_MANIFEST }}", private_upload)

        aggregate_upload = self.workflow[upload_aggregate:]
        self.assertIn("${{ env.PROMOTION_SUMMARY }}", aggregate_upload)
        self.assertIn("${{ env.ENCRYPTION_SUMMARY }}", aggregate_upload)
        self.assertNotIn("${{ env.PRIVATE_COHORT }}", aggregate_upload)
        self.assertNotIn("${{ env.REVIEW_MANIFEST }}", aggregate_upload)

    def test_never_writes_canonical_or_dashboard_files(self):
        self.assertIn("canonical_written", self.workflow)
        self.assertIn("dashboard_written", self.workflow)
        self.assertIn("promotion_executed", self.workflow)
        self.assertIn('test -z "$(git status --porcelain)"', self.workflow)
        forbidden_writes = (
            "Spotify_Browse_Catalogue_data.js >",
            "Spotify_Soundcharts_data.js >",
            "Spotify_Performance_data.js >",
            "Spotify_Radar_data.js >",
        )
        for token in forbidden_writes:
            self.assertNotIn(token, self.workflow)


if __name__ == "__main__":
    unittest.main()
