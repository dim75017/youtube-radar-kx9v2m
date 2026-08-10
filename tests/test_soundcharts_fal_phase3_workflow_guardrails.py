import os
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(
    os.environ.get(
        "FAL_PHASE3_WORKFLOW_PATH",
        ROOT / ".github" / "workflows" / "enrich-soundcharts-fal-phase3.yml",
    )
)


class SoundchartsFalPhase3WorkflowGuardrailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def trigger_block(self):
        return self.workflow[
            self.workflow.index("on:") : self.workflow.index("permissions:")
        ]

    def step(self, name):
        marker = f"      - name: {name}"
        start = self.workflow.index(marker)
        next_named = self.workflow.find("\n      - name:", start + len(marker))
        next_uses = self.workflow.find("\n      - uses:", start + len(marker))
        ends = [value for value in (next_named, next_uses) if value >= 0]
        end = min(ends) if ends else len(self.workflow)
        return self.workflow[start:end]

    def named_steps(self):
        starts = [match.start() for match in re.finditer(r"(?m)^      - name: ", self.workflow)]
        sections = []
        for index, start in enumerate(starts):
            end = starts[index + 1] if index + 1 < len(starts) else len(self.workflow)
            sections.append(self.workflow[start:end])
        return sections

    def test_is_manual_only(self):
        triggers = self.trigger_block()
        self.assertRegex(triggers, r"(?m)^  workflow_dispatch:\s*$")
        for forbidden in ("push:", "pull_request:", "schedule:", "workflow_run:"):
            self.assertNotIn(forbidden, triggers)

    def test_shares_the_exact_paid_soundcharts_lock(self):
        self.assertIn(
            "inputs.max_requests == '0'",
            self.workflow,
        )
        self.assertIn(
            "format('soundcharts-fal-phase3-dry-{0}', github.run_id)",
            self.workflow,
        )
        self.assertIn(
            "format('refresh-soundcharts-ar-collection-{0}', github.ref)",
            self.workflow,
        )
        self.assertIn("cancel-in-progress: false", self.workflow)

    def test_zero_is_a_real_dry_run_and_live_calls_are_bounded(self):
        self.assertIn("description: 'Soundcharts data-call cap: 0 dry-run, then 1-4000'", self.workflow)
        self.assertIn("default: '0'", self.workflow)
        self.assertIn("ABSOLUTE_MAX_REQUESTS: '4000'", self.workflow)
        self.assertIn("MIN_QUOTA_RESERVE: '1400000'", self.workflow)
        self.assertIn("10#$max_requests > 4000", self.workflow)
        self.assertIn("max_requests must be an integer between 0 and 4000", self.workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.max_requests }}"', self.workflow)
        self.assertIn('--quota-reserve "$MIN_QUOTA_RESERVE"', self.workflow)

    def test_dry_run_never_receives_soundcharts_credentials(self):
        invocation_steps = [
            section
            for section in self.named_steps()
            if "python enrich_soundcharts_fal_phase3.py" in section
        ]
        self.assertGreaterEqual(len(invocation_steps), 2, "dry-run and live enrichment must be separate steps")

        dry_steps = [
            section
            for section in invocation_steps
            if re.search(r"steps\.plan\.outputs\.max_requests\s*==\s*'0'", section)
        ]
        live_steps = [
            section
            for section in invocation_steps
            if re.search(r"steps\.plan\.outputs\.max_requests\s*!=\s*'0'", section)
        ]
        self.assertEqual(len(dry_steps), 1)
        self.assertEqual(len(live_steps), 1)
        for token in ("SOUNDCHARTS_CLIENT_ID", "SOUNDCHARTS_CLIENT_SECRET"):
            self.assertNotIn(token, dry_steps[0])
            self.assertIn(f"secrets.{token}", live_steps[0])

        credential_steps = [
            section
            for section in self.named_steps()
            if "secrets.SOUNDCHARTS_CLIENT_" in section
        ]
        self.assertEqual(credential_steps, live_steps)

    def test_restores_exact_phase2_and_phase1_artifact_lineage(self):
        restore = self.step(
            "Restore verified phase-2, phase-1, cache and prior phase-3 state"
        )
        self.assertIn(
            "PHASE2_ID_STATE_ARTIFACT: soundcharts-fal-phase2-spotify-id-state-v1-encrypted",
            self.workflow,
        )
        self.assertIn(
            "PHASE1_STATE_ARTIFACT: soundcharts-fal-phase1-state-v2",
            self.workflow,
        )
        for lineage_field in (
            "phase1_artifact_id",
            "phase1_source_id",
        ):
            self.assertGreaterEqual(restore.count(lineage_field), 2)
        self.assertIn("if len(set(values)) != 1", restore)
        self.assertIn(
            'download_exact "$expected_phase1_artifact_id" "$PHASE1_STATE_ARTIFACT"',
            restore,
        )
        self.assertIn('test "$(jq -r \'.name // empty\' "$metadata")" = "$expected_name"', restore)
        self.assertIn('test "$(jq -r \'.expired // true\' "$metadata")" = "false"', restore)

    def test_source_artifact_ids_and_all_source_hashes_are_bound_to_the_report(self):
        restore = self.step(
            "Restore verified phase-2, phase-1, cache and prior phase-3 state"
        )
        for source, path_variable in (
            ("PHASE2_STATE_SHA256", "phase2_db"),
            ("PHASE2_REPORT_SHA256", "phase2_report"),
            ("PHASE1_STATE_SHA256", "phase1_db"),
        ):
            self.assertRegex(
                restore,
                rf'{source.lower()}="\$\(sha256sum "\${path_variable}" \| cut -d\' \' -f1\)"',
            )
            self.assertIn(f'echo "{source}=${{{source.lower()}}}" >> "$GITHUB_ENV"', restore)

        invocation = "\n".join(
            section
            for section in self.named_steps()
            if "python enrich_soundcharts_fal_phase3.py" in section
        )
        required_arguments = {
            '--phase2-source-artifact-id "$PHASE2_SOURCE_ARTIFACT_ID"',
            '--phase1-source-artifact-id "$PHASE1_SOURCE_ARTIFACT_ID"',
            '--phase2-state-sha256 "$PHASE2_STATE_SHA256"',
            '--phase2-report-sha256 "$PHASE2_REPORT_SHA256"',
            '--phase1-state-sha256 "$PHASE1_STATE_SHA256"',
        }
        for argument in required_arguments:
            self.assertIn(argument, invocation)

        verify = self.step("Verify private-only phase-3 invariants")
        for token in (
            "PHASE2_SOURCE_ARTIFACT_ID",
            "PHASE1_SOURCE_ARTIFACT_ID",
            "PHASE2_STATE_SHA256",
            "PHASE2_REPORT_SHA256",
            "PHASE1_STATE_SHA256",
        ):
            self.assertIn(token, verify)

    def test_backfill_contract_is_fully_validated_before_phase3(self):
        restore = self.step(
            "Restore verified phase-2, phase-1, cache and prior phase-3 state"
        )
        for token in (
            '"source_endpoint": "/api/v2/song/{uuid}/audience/spotify"',
            '"identity_source": "numeric plots[].identifier"',
            '"spotify_id_format": "exact_22_character_base62"',
            '"eligible_stream_gate_only": True',
            '"ambiguous_never_assigned": True',
            '"duplicate_within_phase2_never_assigned": True',
            '"raw_responses_persisted": False',
            '"canonical_catalogue_compared": False',
            '"canonical_promotion_allowed": False',
        ):
            self.assertIn(token, restore)
        self.assertIn("Spotify-ID backfill policy mismatch", restore)

    def test_cache_artifact_id_and_sha_are_passed_reported_and_verified(self):
        restore = self.step(
            "Restore verified phase-2, phase-1, cache and prior phase-3 state"
        )
        self.assertIn('cache_sha256="$(sha256sum "$cache_file"', restore)
        self.assertIn('echo "CACHE_SOURCE_ARTIFACT_ID=${cache_artifact_id}"', restore)
        self.assertIn('echo "CACHE_SHA256=${cache_sha256}"', restore)
        invocation = "\n".join(
            section
            for section in self.named_steps()
            if "python enrich_soundcharts_fal_phase3.py" in section
        )
        self.assertGreaterEqual(invocation.count("--cache-source-artifact-id"), 2)
        self.assertGreaterEqual(invocation.count("--cache-sha256"), 2)
        verify = self.step("Verify private-only phase-3 invariants")
        for token in (
            "CACHE_SOURCE_ARTIFACT_ID",
            "CACHE_SHA256",
            '"cache_source_artifact_id"',
            '"cache_sha256"',
            "cache_track_terminal_contract",
            "cache_artist_terminal_requires_exact_id_and_identifiers_fetched_at",
        ):
            self.assertIn(token, verify)

    def test_runtime_quota_report_cannot_cross_or_hide_the_floor(self):
        verify = self.step("Verify private-only phase-3 invariants")
        self.assertIn("if claimed > requested", verify)
        self.assertIn("if claimed > 0 and quota_after is None", verify)
        self.assertIn("if quota_after is not None and int(quota_after) < protected_floor", verify)
        self.assertIn("requested < 0 or requested > 4000", verify)

    def test_repository_and_public_outputs_are_read_only(self):
        self.assertIn("actions: write", self.workflow)
        self.assertIn("contents: read", self.workflow)
        self.assertNotIn("contents: write", self.workflow)
        for forbidden in (
            "git add",
            "git commit",
            "git push",
            "prepare_soundcharts_snapshot.py activate",
            "Spotify_Soundcharts_data.js",
            "Spotify_Performance_data.js",
            "Spotify_Radar_data.js",
        ):
            self.assertNotIn(forbidden, self.workflow)
        self.assertIn("canonical_written", self.workflow)
        self.assertIn("dashboard_written", self.workflow)
        self.assertIn("promotion_executed", self.workflow)
        self.assertIn('test -z "$(git status --porcelain)"', self.workflow)

    def test_private_rows_are_encrypted_and_only_aggregates_are_plaintext(self):
        key_check = self.workflow.index("Require the private staging encryption key")
        restore = self.workflow.index("Restore verified phase-2")
        self.assertLess(key_check, restore)
        self.assertIn("secrets.FAL_STAGING_ARTIFACT_KEY", self.workflow)
        self.assertIn("openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000", self.workflow)
        self.assertIn("openssl enc -aes-256-cbc -pbkdf2 -iter 600000", self.workflow)
        self.assertNotIn("-pass env:SOUNDCHARTS_CLIENT_SECRET", self.workflow)

        private_upload = self.step("Upload encrypted resumable private state only")
        self.assertIn("name: soundcharts-fal-phase3-state-v1-encrypted", private_upload)
        self.assertIn("path: ${{ env.ENCRYPTED_STATE }}", private_upload)
        for plaintext in ("PHASE3_STATE", "ENRICHED_MANIFEST", "REVIEW_MANIFEST"):
            self.assertNotIn(f"env.{plaintext}", private_upload)

        aggregate_upload = self.step("Upload aggregate phase-3 report only")
        self.assertIn("${{ env.PHASE3_REPORT }}", aggregate_upload)
        self.assertIn("${{ env.ENCRYPTION_SUMMARY }}", aggregate_upload)
        for private_name in (
            "ENCRYPTED_STATE",
            "PHASE3_STATE",
            "ENRICHED_MANIFEST",
            "REVIEW_MANIFEST",
            "PHASE1_DB",
            "PHASE2_DB",
        ):
            self.assertNotIn(f"env.{private_name}", aggregate_upload)
        self.assertIn("row_level_data_uploaded_unencrypted", self.workflow)
        self.assertIn('{"tracks", "rows", "records", "spotify_ids", "artist_ids"}', self.workflow)

    def test_runner_temp_hashing_never_uses_hashfiles(self):
        self.assertNotIn("hashFiles(", self.workflow)
        self.assertIn("sha256sum", self.workflow)

    def test_upload_and_purge_chain_only_after_enrichment_and_verification(self):
        enrich = self.workflow.index("Enrich the advanced bucket in private staging")
        verify = self.workflow.index("Verify private-only phase-3 invariants")
        encrypt = self.workflow.index("Encrypt resumable phase-3 state and row-level manifest")
        state_upload = self.workflow.index("Upload encrypted resumable private state only")
        summary_upload = self.workflow.index("Upload aggregate phase-3 report only")
        purge = self.workflow.index("Keep only the two newest encrypted phase-3 states")
        self.assertLess(enrich, verify)
        self.assertLess(verify, encrypt)
        self.assertLess(encrypt, state_upload)
        self.assertLess(state_upload, summary_upload)
        self.assertLess(summary_upload, purge)

        encrypt_step = self.step("Encrypt resumable phase-3 state and row-level manifest")
        self.assertIn("steps.enrich.outcome == 'success'", encrypt_step)
        self.assertIn("steps.verify.outcome == 'success'", encrypt_step)
        self.assertIn("if: steps.encrypt.outcome == 'success'", self.step("Upload encrypted resumable private state only"))
        self.assertIn("if: steps.state_upload.outcome == 'success'", self.step("Upload aggregate phase-3 report only"))
        self.assertIn("if: steps.state_upload.outcome == 'success'", self.step("Keep only the two newest encrypted phase-3 states"))

    def test_verification_failure_has_no_upload_path(self):
        verify = self.step("Verify private-only phase-3 invariants")
        self.assertIn("if: steps.enrich.outcome == 'success'", verify)
        for section in self.named_steps():
            if "uses: actions/upload-artifact@" not in section:
                continue
            self.assertNotIn("always()", section)
            self.assertTrue(
                "steps.encrypt.outcome == 'success'" in section
                or "steps.state_upload.outcome == 'success'" in section
            )
        failure = self.step(
            "Fail closed when enrichment or invariant verification failed"
        )
        self.assertIn("steps.verify.outcome != 'success'", failure)
        self.assertIn("exit 1", failure)


if __name__ == "__main__":
    unittest.main()
