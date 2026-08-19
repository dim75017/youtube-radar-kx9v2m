import copy
import unittest

from build_soundcharts_fal_seed_ledger import (
    ArtistObservation,
    SeedLedgerError,
    build_ledger,
    previous_identity_observations,
    stabilize_canonical_uuids,
    transition_bounds,
    validate_ledger,
    validate_ledger_transition,
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

    def test_transition_bounds_accept_the_observed_growth_without_removing_the_hard_cap(self):
        allowed_min, allowed_max = transition_bounds(
            5_616,
            min_resolved=4_500,
            hard_max_resolved=10_000,
            max_growth_percent=35,
            max_growth_absolute=2_000,
            max_shrink_percent=20,
        )

        self.assertEqual((allowed_min, allowed_max), (4_500, 7_582))
        self.assertTrue(allowed_min <= 7_241 <= allowed_max)
        self.assertFalse(allowed_min <= 7_583 <= allowed_max)

    def test_transition_validation_accepts_growth_past_the_legacy_ten_thousand_cap(self):
        def ledger(size):
            return build_ledger(
                [
                    ArtistObservation(
                        f"uuid-{index:05d}",
                        f"spotify-{index:05d}",
                        f"Artist {index}",
                        None,
                        "strict_artist",
                    )
                    for index in range(size)
                ]
            )

        previous = ledger(9_908)
        accepted = ledger(10_665)
        transition = validate_ledger_transition(
            previous,
            accepted,
            min_resolved=4_500,
            hard_max_resolved=20_000,
            max_growth_percent=35,
            max_growth_absolute=2_000,
            max_shrink_percent=20,
            max_unresolved=0,
        )

        self.assertEqual(transition["previous_resolved"], 9_908)
        self.assertEqual(transition["current_resolved"], 10_665)
        self.assertEqual((transition["allowed_min"], transition["allowed_max"]), (7_926, 11_908))

        with self.assertRaises(SeedLedgerError):
            validate_ledger_transition(
                previous,
                ledger(11_909),
                min_resolved=4_500,
                hard_max_resolved=20_000,
                max_growth_percent=35,
                max_growth_absolute=2_000,
                max_shrink_percent=20,
                max_unresolved=0,
            )

    def test_previous_canonical_uuid_wins_when_source_priority_flips(self):
        previous = build_ledger(
            [
                ArtistObservation("uuid-stable", "spotify-one", "Artist", None, "strict_artist"),
                ArtistObservation("uuid-alias", "spotify-one", "Artist", None, "performance_artist"),
            ]
        )
        current = build_ledger(
            [
                ArtistObservation("uuid-stable", "spotify-one", "Artist", None, "performance_artist"),
                ArtistObservation("uuid-alias", "spotify-one", "Artist", None, "strict_artist"),
            ]
        )
        self.assertEqual(previous["artists"][0]["soundcharts_uuid"], "uuid-stable")
        self.assertEqual(current["artists"][0]["soundcharts_uuid"], "uuid-alias")

        stabilized = stabilize_canonical_uuids(current, previous)

        self.assertEqual(stabilized["artists"][0]["soundcharts_uuid"], "uuid-stable")
        self.assertEqual(stabilized["canonical_stability"]["matched_components"], 1)
        self.assertEqual(stabilized["canonical_stability"]["changed_canonicals"], 1)
        self.assertEqual(
            stabilized["rejected_uuid_aliases"],
            [
                {
                    "spotify_ids": ["spotify-one"],
                    "canonical_uuid": "uuid-stable",
                    "rejected_uuids": ["uuid-alias"],
                }
            ],
        )
        validate_ledger(stabilized, min_resolved=1, max_resolved=1)

    def test_canonical_stability_carries_history_but_refuses_ambiguous_components(self):
        previous = build_ledger(
            [
                ArtistObservation("uuid-a", "spotify-a", "Artist A", None, "strict_artist"),
                ArtistObservation("uuid-b", "spotify-b", "Artist B", None, "strict_artist"),
            ]
        )
        missing_canonical = build_ledger(
            [ArtistObservation("uuid-new", "spotify-a", "Artist A", None, "strict_artist")]
        )
        carried = stabilize_canonical_uuids(missing_canonical, previous)
        self.assertEqual(carried["artists"][0]["soundcharts_uuid"], "uuid-a")
        self.assertEqual(
            carried["artists"][0]["soundcharts_uuid_aliases"],
            ["uuid-a", "uuid-new"],
        )
        self.assertEqual(carried["coverage"]["historical_canonical_uuids"], 1)
        self.assertEqual(carried["canonical_stability"]["historical_canonicals_carried_forward"], 1)
        validate_ledger(carried, min_resolved=1, max_resolved=1)

        merged_components = build_ledger(
            [
                ArtistObservation("uuid-a", "spotify-a", "Artist AB", None, "strict_artist"),
                ArtistObservation("uuid-a", "spotify-b", "Artist AB", None, "strict_artist"),
                ArtistObservation("uuid-b", "spotify-b", "Artist AB", None, "strict_artist"),
            ]
        )
        with self.assertRaises(SeedLedgerError):
            stabilize_canonical_uuids(merged_components, previous)

    def test_previous_identity_edges_prevent_an_accepted_component_from_splitting(self):
        previous = build_ledger(
            [
                ArtistObservation("uuid-a", "spotify-a", "Artist", None, "strict_artist"),
                ArtistObservation("uuid-a", "spotify-b", "Artist", None, "strict_artist"),
                ArtistObservation("uuid-b", "spotify-b", "Artist", None, "strict_artist"),
            ]
        )
        current = [
            ArtistObservation("uuid-a", "spotify-a", "Artist", 90_000, "strict_artist"),
            ArtistObservation("uuid-b", "spotify-b", "Artist", 80_000, "performance_artist"),
        ]
        split = build_ledger(current)
        self.assertEqual(len(split["artists"]), 2)

        joined = build_ledger(current + previous_identity_observations(previous))
        stabilized = stabilize_canonical_uuids(joined, previous)

        self.assertEqual(len(stabilized["artists"]), 1)
        self.assertEqual(stabilized["artists"][0]["soundcharts_uuid"], "uuid-a")
        self.assertEqual(stabilized["artists"][0]["soundcharts_uuid_aliases"], ["uuid-a", "uuid-b"])
        self.assertEqual(stabilized["artists"][0]["spotify_id_aliases"], ["spotify-a", "spotify-b"])
        self.assertIn("previous_accepted_identity", stabilized["policy"]["sources"])
        validate_ledger(stabilized, min_resolved=1, max_resolved=1)

    def test_transition_validation_is_audited_and_fail_closed(self):
        previous = build_ledger(
            [
                ArtistObservation(f"uuid-{index:02d}", f"spotify-{index:02d}", f"Artist {index}", None, "strict_artist")
                for index in range(10)
            ]
        )
        accepted = build_ledger(
            [
                ArtistObservation(f"uuid-{index:02d}", f"spotify-{index:02d}", f"Artist {index}", None, "strict_artist")
                for index in range(13)
            ]
        )

        transition = validate_ledger_transition(
            previous,
            accepted,
            min_resolved=1,
            hard_max_resolved=100,
            max_growth_percent=35,
            max_growth_absolute=100,
            max_shrink_percent=20,
            max_unresolved=0,
        )
        self.assertEqual(transition["previous_resolved"], 10)
        self.assertEqual(transition["current_resolved"], 13)
        self.assertEqual(transition["delta"], 3)
        self.assertEqual(transition["allowed_min"], 8)
        self.assertEqual(transition["allowed_max"], 14)
        self.assertEqual(transition["previous_cohort_hash"], previous["cohort_hash"])

        too_large = build_ledger(
            [
                ArtistObservation(f"uuid-{index:02d}", f"spotify-{index:02d}", f"Artist {index}", None, "strict_artist")
                for index in range(15)
            ]
        )
        with self.assertRaises(SeedLedgerError):
            validate_ledger_transition(
                previous,
                too_large,
                min_resolved=1,
                hard_max_resolved=100,
                max_growth_percent=35,
                max_growth_absolute=100,
                max_shrink_percent=20,
                max_unresolved=0,
            )

        unresolved = build_ledger(
            [
                ArtistObservation(f"uuid-{index:02d}", f"spotify-{index:02d}", f"Artist {index}", None, "strict_artist")
                for index in range(10)
            ]
            + [ArtistObservation("", "spotify-pending", "Pending", None, "strict_artist")]
        )
        with self.assertRaises(SeedLedgerError):
            validate_ledger_transition(
                previous,
                unresolved,
                min_resolved=1,
                hard_max_resolved=100,
                max_growth_percent=35,
                max_growth_absolute=100,
                max_shrink_percent=20,
                max_unresolved=0,
            )


if __name__ == "__main__":
    unittest.main()
