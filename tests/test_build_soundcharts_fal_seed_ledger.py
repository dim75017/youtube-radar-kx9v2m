import copy
import unittest

from build_soundcharts_fal_seed_ledger import (
    ArtistObservation,
    SeedLedgerError,
    build_ledger,
    validate_ledger,
)


class SoundchartsFalSeedLedgerTests(unittest.TestCase):
    def observations(self):
        return [
            ArtistObservation("uuid-alias", "spotify-one", "Artist One old", 90_000, "performance_artist"),
            ArtistObservation("uuid-canonical", "spotify-one", "Artist One", 80_000, "strict_artist"),
            ArtistObservation("uuid-canonical", "spotify-one", "Artist One", 80_000, "browse_artist"),
            ArtistObservation("uuid-only", "", "UUID only", None, "strict_discovery_artist"),
            ArtistObservation("", "spotify-pending", "Pending", 20_000, "performance_artist"),
        ]

    def test_ledger_is_deterministic_deduplicated_and_keeps_resolution_pending(self):
        forward = build_ledger(self.observations(), source_files=["strict.js", "browse.js", "performance.js"])
        reverse = build_ledger(list(reversed(self.observations())), source_files=["strict.js", "browse.js", "performance.js"])

        self.assertEqual(forward["cohort_hash"], reverse["cohort_hash"])
        self.assertEqual(forward["artists"], reverse["artists"])
        self.assertEqual(forward["coverage"]["unique_spotify_identities"], 2)
        self.assertEqual(forward["coverage"]["resolved_source_uuids"], 3)
        self.assertEqual(forward["coverage"]["resolved_seed_uuids"], 2)
        self.assertEqual(forward["coverage"]["unresolved_display_identities"], 1)
        self.assertEqual(forward["coverage"]["uuid_only"], 1)
        self.assertEqual(
            [artist["soundcharts_uuid"] for artist in forward["artists"]],
            ["uuid-canonical", "uuid-only"],
        )
        self.assertEqual(forward["resolution_pending"][0]["status"], "resolution_pending")
        self.assertEqual(forward["alias_dedup"]["rejected_uuid_alias_count"], 1)
        self.assertEqual(
            forward["rejected_uuid_aliases"],
            [
                {
                    "spotify_ids": ["spotify-one"],
                    "canonical_uuid": "uuid-canonical",
                    "rejected_uuids": ["uuid-alias"],
                }
            ],
        )
        canonical = next(item for item in forward["artists"] if item["soundcharts_uuid"] == "uuid-canonical")
        self.assertEqual(canonical["soundcharts_uuid_aliases"], ["uuid-alias", "uuid-canonical"])
        self.assertEqual(canonical["spotify_id_aliases"], ["spotify-one"])
        self.assertFalse(forward["policy"]["fal_candidates_are_seeds"])
        self.assertIsNone(forward["policy"]["minimum_monthly_listeners"])

        metric_refresh = self.observations()
        metric_refresh[1] = ArtistObservation(
            "uuid-canonical", "spotify-one", "Artist One renamed", 123_456, "strict_artist"
        )
        refreshed = build_ledger(metric_refresh)
        self.assertEqual(forward["cohort_hash"], refreshed["cohort_hash"])
        self.assertNotEqual(forward["content_hash"], refreshed["content_hash"])

    def test_transitive_multi_uuid_and_multi_spotify_aliases_form_one_seed(self):
        ledger = build_ledger(
            [
                ArtistObservation("uuid-a", "spotify-1", "One", 90_000, "strict_artist"),
                ArtistObservation("uuid-a", "spotify-2", "One alias", 90_000, "browse_artist"),
                ArtistObservation("uuid-b", "spotify-2", "One alias", 90_000, "performance_artist"),
                ArtistObservation("uuid-b", "spotify-3", "One alias", 90_000, "performance_artist"),
            ]
        )
        self.assertEqual(ledger["coverage"]["resolved_source_uuids"], 2)
        self.assertEqual(ledger["coverage"]["unique_spotify_identities"], 3)
        self.assertEqual(ledger["coverage"]["resolved_seed_uuids"], 1)
        self.assertEqual(ledger["alias_dedup"]["rejected_uuid_alias_count"], 1)
        self.assertEqual(len(ledger["artists"]), 1)
        artist = ledger["artists"][0]
        self.assertEqual(artist["soundcharts_uuid"], "uuid-a")
        self.assertEqual(artist["soundcharts_uuid_aliases"], ["uuid-a", "uuid-b"])
        self.assertEqual(artist["spotify_id_aliases"], ["spotify-1", "spotify-2", "spotify-3"])
        validate_ledger(ledger, min_resolved=1, max_resolved=1)

    def test_validation_is_fail_closed_for_bounds_duplicates_and_hash_changes(self):
        ledger = build_ledger(self.observations())
        validate_ledger(ledger, min_resolved=2, max_resolved=2)

        with self.assertRaises(SeedLedgerError):
            validate_ledger(ledger, min_resolved=3, max_resolved=10)

        tampered = copy.deepcopy(ledger)
        tampered["artists"][0]["name"] = "Tampered"
        with self.assertRaises(SeedLedgerError):
            validate_ledger(tampered, min_resolved=1, max_resolved=10)

        duplicate = copy.deepcopy(ledger)
        duplicate["artists"].append(copy.deepcopy(duplicate["artists"][0]))
        duplicate["coverage"]["resolved_uuid"] += 1
        with self.assertRaises(SeedLedgerError):
            validate_ledger(duplicate, min_resolved=1, max_resolved=10)


if __name__ == "__main__":
    unittest.main()
