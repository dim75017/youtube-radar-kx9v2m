from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "backfill-public-spotify-track-identities.yml"


class SoundchartsPublicIdentityWorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_is_manual_and_shares_paid_soundcharts_lock(self):
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertNotIn("schedule:", self.workflow)
        self.assertIn(
            "group: refresh-soundcharts-ar-collection-${{ github.ref }}",
            self.workflow,
        )
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_request_and_quota_guards_are_explicit(self):
        self.assertIn("ABSOLUTE_MAX_REQUESTS: '22000'", self.workflow)
        self.assertIn("MIN_QUOTA_RESERVE: '1400000'", self.workflow)
        self.assertIn("attempts including retries (1-22000)", self.workflow)
        self.assertIn("--quota-reserve \"$MIN_QUOTA_RESERVE\"", self.workflow)

    def test_private_state_is_encrypted_and_never_committed(self):
        self.assertIn("FAL_STAGING_ARTIFACT_KEY is required", self.workflow)
        self.assertIn("openssl enc -aes-256-cbc -pbkdf2 -iter 600000", self.workflow)
        self.assertIn("ENCRYPTED_STATE_HMAC", self.workflow)
        self.assertIn("hmac.new(key, context + encrypted", self.workflow)
        self.assertIn(
            "soundcharts-public-track-identity-state-v1-encrypted", self.workflow
        )
        publish = self.workflow.split(
            "- name: Publish only validated performance files", 1
        )[1]
        self.assertIn(
            "git add -A -- Spotify_Performance_data.js Spotify_Performance_tracks",
            publish,
        )
        self.assertNotIn("$STATE_DB", publish)
        self.assertNotIn("$BACKFILL_REPORT", publish)

    def test_checkpoint_is_authenticated_before_decryption_and_checked(self):
        restore = self.workflow.split(
            "- name: Restore newest encrypted checkpoint when available", 1
        )[1].split("- name: Record canonical files", 1)[0]
        self.assertIn("hmac.compare_digest", restore)
        self.assertIn("*.tar.gz.enc.hmac", restore)
        self.assertLess(
            restore.index("hmac.compare_digest"), restore.index("openssl enc -d")
        )
        self.assertIn('connection.execute("PRAGMA quick_check")', restore)
        self.assertLess(
            self.workflow.index("PRAGMA quick_check"),
            self.workflow.index(
                "- name: Resolve exact identities and backfill performance only"
            ),
        )

    def test_timeout_preserves_a_verified_checkpoint_and_interruption_report(self):
        backfill = self.workflow.split(
            "- name: Resolve exact identities and backfill performance only", 1
        )[1].split("- name: Verify fail-closed publication boundary", 1)[0]
        self.assertIn("continue-on-error: true", backfill)
        self.assertIn("timeout --signal=INT --kill-after=45s 300m", backfill)
        checkpoint = self.workflow.split(
            "- name: Verify and authenticate resumable checkpoint", 1
        )[1].split("- name: Persist encrypted checkpoint", 1)[0]
        self.assertIn("if: always()", checkpoint)
        self.assertIn("PRAGMA quick_check", checkpoint)
        self.assertIn('"interrupted": interrupted', checkpoint)
        self.assertIn('"backfill_outcome": backfill_outcome', checkpoint)
        state_upload = self.workflow.split(
            "- name: Persist encrypted checkpoint", 1
        )[1].split("- name: Upload aggregate report only", 1)[0]
        self.assertIn("if: always()", state_upload)
        self.assertIn("${{ env.ENCRYPTED_STATE_HMAC }}", state_upload)

    def test_publication_requires_successful_backfill_verification_and_upload(self):
        publish_header = self.workflow.split(
            "- name: Publish only validated performance files", 1
        )[1].split("env:", 1)[0]
        self.assertIn("steps.backfill.outcome == 'success'", publish_header)
        self.assertIn("steps.verify.outcome == 'success'", publish_header)
        self.assertIn("steps.state_upload.outcome == 'success'", publish_header)
        self.assertIn(
            "Surface failure after preserving the checkpoint", self.workflow
        )

    def test_canonical_catalogue_hashes_are_verified(self):
        self.assertIn("Spotify_Soundcharts_data.js", self.workflow)
        self.assertIn("Spotify_Browse_Catalogue_data.js", self.workflow)
        self.assertIn("sha256sum -c", self.workflow)
        self.assertIn('report.get("canonical_written") is not False', self.workflow)
        self.assertIn(
            'report.get("browse_catalogue_written") is not False', self.workflow
        )

    def test_only_exact_identity_collector_is_called(self):
        self.assertIn("backfill_public_spotify_track_identities.py", self.workflow)
        self.assertIn("--apply-performance", self.workflow)
        self.assertNotIn("prepare_soundcharts_snapshot.py activate", self.workflow)
        self.assertNotIn("build_spotify_browse_catalogue.py", self.workflow)


if __name__ == "__main__":
    unittest.main()
