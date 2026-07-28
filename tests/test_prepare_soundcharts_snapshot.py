import copy
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import prepare_soundcharts_snapshot as subject


ARTIST_SCHEMA = ["spotify_id", "name", "soundcharts_uuid", "monthly_listeners"]
FAL_SCHEMA = [
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "monthly_listeners",
    "qualifies",
    "rights_status",
]
TRACK_SCHEMA = [
    "spotify_id",
    "artist",
    "title",
    "soundcharts_uuid",
    "artists",
    "rights_status",
    "instrumental_status",
    "streams",
    "primary_genre",
    "genre_confidence",
    "instrumental_confidence",
    "ai_risk",
    "expansion_status",
    "rights_confidence",
]
OPPORTUNITY_SCHEMA = [
    "opportunity_status",
    "spotify_id",
    "soundcharts_uuid",
    "title",
    "credit_name",
    "artists",
    "rights_status",
    "instrumental_status",
    "instrumental_confidence",
    "primary_genre",
    "genre_confidence",
    "ai_risk",
    "deal_type",
    "contact_status",
    "contact_email",
    "contact_url",
]
EDITORIAL_ARTIST_SCHEMA = [
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "monthly_listeners",
    "primary_genre",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "expansion_status",
]
EDITORIAL_TRACK_SCHEMA = [
    "soundcharts_uuid",
    "spotify_id",
    "name",
    "artist",
    "primary_genre",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "expansion_status",
]


def collaborator(name, spotify_id, soundcharts_uuid):
    return {
        "name": name,
        "spotify_id": spotify_id,
        "soundcharts_uuid": soundcharts_uuid,
        "role": "main",
    }


def track(spotify_id, credit, artists, soundcharts_uuid=None):
    return [
        spotify_id,
        credit,
        f"Track {spotify_id}",
        soundcharts_uuid or f"song-{spotify_id}",
        artists,
        "self_released",
        "instrumental",
        100_000,
        "ambient",
        0.9,
        0.9,
        "low",
        "eligible",
        0.9,
    ]


def opportunity(
    spotify_id,
    credit,
    artists,
    rights="self_released",
    status="verified",
    contact_status="social",
    contact_email="",
    contact_url="https://example.test/quiet",
):
    return [
        status,
        spotify_id,
        f"song-{spotify_id}",
        f"Opportunity {spotify_id}",
        credit,
        artists,
        rights,
        "instrumental",
        0.9,
        "ambient",
        0.9,
        "low",
        "distribution",
        contact_status,
        contact_email,
        contact_url,
    ]


def minimal_payload():
    valid_artist = collaborator("Quiet Keys", "artist-valid", "uuid-valid")
    return {
        "version": 1,
        "schemas": {
            "artists": ARTIST_SCHEMA,
            "fal": FAL_SCHEMA,
            "tracks": TRACK_SCHEMA,
            "opportunities": OPPORTUNITY_SCHEMA,
        },
        "coverage": {
            "artists": {"exported": 1},
            "fal": {"candidates": 1, "resolved": 1, "exported": 1},
            "tracks": {"exported": 1},
        },
        "artists": [["artist-valid", "Quiet Keys", "uuid-valid", 50_000]],
        "fal": [["uuid-valid", "artist-valid", "Quiet Keys", 50_000, 1, "self_released"]],
        "editorial": {
            "artist_schema": EDITORIAL_ARTIST_SCHEMA,
            "track_schema": EDITORIAL_TRACK_SCHEMA,
            "artists": [[
                "uuid-valid",
                "artist-valid",
                "Quiet Keys",
                50_000,
                "ambient",
                0.9,
                "instrumental",
                0.9,
                "low",
                "eligible",
            ]],
            "tracks": [[
                "song-track-valid",
                "track-valid",
                "Quiet Track",
                "Quiet Keys",
                "ambient",
                0.9,
                "instrumental",
                0.9,
                "low",
                "eligible",
            ]],
        },
        "tracks": [track("track-valid", "Quiet Keys", [valid_artist])],
        "opportunities": [
            opportunity("track-valid", "Quiet Keys", [valid_artist])
        ],
        "opportunity_scoring": {
            "opportunities": 1,
            "deal_types": {"distribution": 1},
            "classification": {"verified": 1},
            "contacts": {"social": 1},
        },
        "opportunity_sync": {
            "opportunities": 1,
            "deal_types": {"distribution": 1},
        },
    }


def wrapped(payload):
    return (
        subject.SOUNDCHARTS_PREFIX
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )


class PrepareSoundchartsSnapshotTests(unittest.TestCase):
    def test_sanitize_reconciles_exclusive_license_across_public_collections(self):
        payload = minimal_payload()
        license_text = (
            "℗ 2026 Øneheart, under exclusive license "
            "to Dreamscape Records"
        )

        track_schema = list(payload["schemas"]["tracks"])
        payload["schemas"]["tracks"] = track_schema
        track_schema.extend(["label", "copyright"])
        payload["tracks"][0].extend(["Øneheart", license_text])

        opportunity_schema = list(payload["schemas"]["opportunities"])
        payload["schemas"]["opportunities"] = opportunity_schema
        opportunity_schema.extend(["rights_confidence", "label", "copyright"])
        payload["opportunities"][0].extend([0.9, "Øneheart", license_text])

        editorial_schema = list(payload["editorial"]["track_schema"])
        payload["editorial"]["track_schema"] = editorial_schema
        editorial_schema.extend(
            ["rights_status", "rights_confidence", "label", "copyright"]
        )
        payload["editorial"]["tracks"][0].extend(
            ["self_released", 0.9, "Øneheart", license_text]
        )

        payload["discovery_catalogue"] = subject._build_discovery_catalogue(
            payload
        )
        sanitized, report = subject.sanitize_payload(payload)

        collections = [
            (sanitized["tracks"], sanitized["schemas"]["tracks"]),
            (
                sanitized["opportunities"],
                sanitized["schemas"]["opportunities"],
            ),
            (
                sanitized["editorial"]["tracks"],
                sanitized["editorial"]["track_schema"],
            ),
            (
                sanitized["discovery_catalogue"]["tracks"],
                sanitized["discovery_catalogue"]["track_schema"],
            ),
        ]
        for rows, schema in collections:
            with self.subTest(schema=schema):
                self.assertEqual(
                    rows[0][schema.index("rights_status")],
                    "independent_label",
                )
                self.assertEqual(
                    rows[0][schema.index("label")],
                    "Dreamscape Records",
                )
                self.assertGreaterEqual(
                    rows[0][schema.index("rights_confidence")],
                    0.98,
                )
        self.assertGreaterEqual(report["rights_rows_reconciled"], 4)

    def test_sanitize_preserves_a_more_complete_existing_discovery_catalogue(self):
        payload = minimal_payload()
        first_pass, _ = subject.sanitize_payload(payload)
        existing = copy.deepcopy(first_pass["discovery_catalogue"])
        track_schema = existing["track_schema"]
        artist_schema = existing["artist_schema"]
        extra_track = {field: None for field in track_schema}
        extra_track.update(
            {
                "soundcharts_uuid": "existing-song-uuid",
                "spotify_id": "existing-track",
                "title": "Existing discovery",
                "credit_name": "Existing Artist",
                "availability_status": "playlist_discovered",
            }
        )
        extra_artist = {field: None for field in artist_schema}
        extra_artist.update(
            {
                "soundcharts_uuid": "existing-artist-uuid",
                "spotify_id": "existing-artist",
                "name": "Existing Artist",
                "availability_status": "discovered",
            }
        )
        existing["tracks"].append(
            [extra_track.get(field) for field in track_schema]
        )
        existing["artists"].append(
            [extra_artist.get(field) for field in artist_schema]
        )
        payload["discovery_catalogue"] = existing

        sanitized, _ = subject.sanitize_payload(payload)

        catalogue = sanitized["discovery_catalogue"]
        spotify_index = catalogue["track_schema"].index("spotify_id")
        self.assertIn(
            "existing-track", [row[spotify_index] for row in catalogue["tracks"]]
        )
        self.assertEqual(catalogue["counts"]["tracks"], 2)

    def test_discovery_merge_preserves_existing_rows_and_enriches_stable_matches(self):
        existing = {
            "version": 1,
            "generated_at": "2026-07-25T00:00:00Z",
            "track_schema": [
                "soundcharts_uuid",
                "spotify_id",
                "title",
                "legacy_note",
                "streams",
                "primary_genre",
                "instrumental_status",
                "expansion_status",
            ],
            "artist_schema": [
                "soundcharts_uuid",
                "spotify_id",
                "name",
                "legacy_note",
            ],
            "playlist_schema": ["spotify_id", "name"],
            "tracks": [
                [
                    "song-one",
                    "track-one",
                    "Old title",
                    "keep-one",
                    100,
                    "ambient",
                    "instrumental",
                    "eligible",
                ],
                [
                    "song-two",
                    "",
                    "Second title",
                    "keep-two",
                    200,
                    "piano",
                    "instrumental",
                    "eligible",
                ],
            ],
            "artists": [
                ["artist-one", "spotify-artist-one", "Old artist", "keep-artist"],
                ["artist-two", "spotify-artist-two", "Preserved artist", "keep-two"],
            ],
        }
        rebuilt = {
            "version": 2,
            "generated_at": "2026-07-27T00:00:00Z",
            "track_schema": [
                "spotify_id",
                "soundcharts_uuid",
                "title",
                "streams",
                "primary_genre",
                "instrumental_status",
                "expansion_status",
            ],
            "artist_schema": [
                "spotify_id",
                "soundcharts_uuid",
                "name",
                "monthly_listeners",
            ],
            "playlist_schema": ["name", "spotify_id", "followers"],
            "tracks": [
                [
                    "track-one",
                    "song-one",
                    "Fresh title",
                    150,
                    "other_instrumental",
                    "unknown",
                    "review",
                ],
                [
                    "track-two",
                    "song-two",
                    "Second fresh title",
                    250,
                    "dark_ambient",
                    "instrumental",
                    "verified",
                ],
                [
                    "track-three",
                    "song-three",
                    "New title",
                    300,
                    "ambient",
                    "instrumental",
                    "eligible",
                ],
            ],
            "artists": [
                ["spotify-artist-one", "artist-one", "Fresh artist", 12_000],
                ["spotify-artist-three", "artist-three", "New artist", 8_000],
            ],
        }

        merged = subject._preserve_more_complete_discovery_catalogue(
            {
                "generated_at": "2026-07-27T00:00:00Z",
                "discovery_catalogue": existing,
            },
            rebuilt,
        )

        tracks = [
            subject._mapping_from_row(row, merged["track_schema"])
            for row in merged["tracks"]
        ]
        artists = [
            subject._mapping_from_row(row, merged["artist_schema"])
            for row in merged["artists"]
        ]
        by_uuid = {record["soundcharts_uuid"]: record for record in tracks}
        artist_by_uuid = {
            record["soundcharts_uuid"]: record for record in artists
        }

        self.assertEqual(len(tracks), 3)
        self.assertEqual(by_uuid["song-one"]["title"], "Fresh title")
        self.assertEqual(by_uuid["song-one"]["legacy_note"], "keep-one")
        self.assertEqual(by_uuid["song-one"]["primary_genre"], "ambient")
        self.assertEqual(
            by_uuid["song-one"]["instrumental_status"], "instrumental"
        )
        self.assertEqual(by_uuid["song-one"]["expansion_status"], "eligible")
        self.assertEqual(by_uuid["song-two"]["spotify_id"], "track-two")
        self.assertEqual(by_uuid["song-two"]["legacy_note"], "keep-two")
        self.assertEqual(len(artists), 3)
        self.assertEqual(artist_by_uuid["artist-one"]["name"], "Fresh artist")
        self.assertEqual(
            artist_by_uuid["artist-one"]["legacy_note"], "keep-artist"
        )
        self.assertIn("artist-two", artist_by_uuid)
        self.assertEqual(merged["counts"]["tracks"], 3)
        self.assertEqual(merged["counts"]["artists"], 3)

    def test_discovery_merge_keeps_new_rows_for_explicit_growth_validation(self):
        track_schema = ["soundcharts_uuid", "spotify_id", "title"]
        existing = {
            "track_schema": track_schema,
            "artist_schema": ["soundcharts_uuid", "spotify_id", "name"],
            "playlist_schema": [],
            "tracks": [
                [f"old-song-{index}", f"old-track-{index}", f"Old {index}"]
                for index in range(4)
            ],
            "artists": [],
        }
        rebuilt = {
            "track_schema": track_schema,
            "artist_schema": existing["artist_schema"],
            "playlist_schema": [],
            "tracks": [
                ["old-song-0", "old-track-0", "Refreshed old"],
                *[
                    [f"new-song-{index}", f"new-track-{index}", f"New {index}"]
                    for index in range(4)
                ],
            ],
            "artists": [],
        }

        with patch.object(subject, "MAX_AUTO_DISCOVERY_GROWTH_RATIO", 1.25), patch.object(
            subject, "MAX_AUTO_DISCOVERY_GROWTH_ROWS", 1
        ):
            merged = subject._preserve_more_complete_discovery_catalogue(
                {"discovery_catalogue": existing}, rebuilt
            )

        spotify_index = merged["track_schema"].index("spotify_id")
        track_ids = [row[spotify_index] for row in merged["tracks"]]
        self.assertEqual(len(track_ids), 8)
        self.assertTrue(
            {f"old-track-{index}" for index in range(4)}.issubset(track_ids)
        )
        self.assertEqual(
            [track_id for track_id in track_ids if track_id.startswith("new-track-")],
            [f"new-track-{index}" for index in range(4)],
        )
        with patch.object(subject, "MAX_AUTO_DISCOVERY_GROWTH_RATIO", 1.25), patch.object(
            subject, "MAX_AUTO_DISCOVERY_GROWTH_ROWS", 1
        ), self.assertRaisesRegex(
            subject.SnapshotValidationError, "grew too quickly"
        ):
            subject.validate_snapshot_transition(
                {"discovery_catalogue": existing},
                {"discovery_catalogue": merged},
            )

    def test_discovery_catalogue_keeps_unclassified_editorial_rows(self):
        payload = minimal_payload()
        payload["editorial"]["artists"].append([
            "uuid-listen-first",
            "",
            "Listen First",
            None,
            "other_instrumental",
            None,
            "unknown",
            None,
            "unknown",
            "review",
        ])
        payload["editorial"]["tracks"].append([
            "song-listen-first",
            "",
            "Unclassified playlist discovery",
            "Listen First",
            "other_instrumental",
            None,
            "unknown",
            None,
            "unknown",
            "review",
        ])

        sanitized, _ = subject.sanitize_payload(payload)

        schema = sanitized["discovery_catalogue"]["track_schema"]
        titles = [row[schema.index("title")] for row in sanitized["discovery_catalogue"]["tracks"]]
        self.assertIn("Unclassified playlist discovery", titles)
        self.assertEqual(sanitized["discovery_catalogue"]["counts"]["tracks"], 2)

    def test_prepare_uses_utc_dated_name_and_leaves_source_and_index_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "spotify").mkdir()
            source = root / "Spotify_Soundcharts_data.js"
            index = root / "spotify" / "index.html"
            source.write_text(wrapped(minimal_payload()), encoding="utf-8")
            index.write_text(
                "<script src='../Spotify_Soundcharts_data.js'></script>\n",
                encoding="utf-8",
            )
            source_before = source.read_bytes()
            index_before = index.read_bytes()

            result = subject.prepare_snapshot(
                source,
                output_dir=root,
                previous=source,
                now=dt.datetime(2026, 7, 21, 17, 31, 46, tzinfo=dt.timezone.utc),
            )

            self.assertEqual(
                result.output.name,
                "Spotify_Soundcharts_data_20260721T173146Z.js",
            )
            self.assertTrue(result.output.is_file())
            self.assertEqual(source.read_bytes(), source_before)
            self.assertEqual(index.read_bytes(), index_before)
            self.assertTrue(
                result.output.read_text(encoding="utf-8").startswith(
                    subject.SOUNDCHARTS_PREFIX
                )
            )
            self.assertIn("transition_quarantine", result.report)

    def test_prepare_rejects_an_unsafe_transition_before_writing(self):
        previous = minimal_payload()
        candidate = minimal_payload()
        valid_artist = collaborator("Quiet Keys", "artist-valid", "uuid-valid")
        for index in range(2, 12):
            spotify_id = f"track-{index}"
            previous["tracks"].append(
                track(spotify_id, "Quiet Keys", [valid_artist])
            )
            previous["opportunities"].append(
                opportunity(spotify_id, "Quiet Keys", [valid_artist])
            )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "candidate.js"
            old = root / "previous.js"
            source.write_text(wrapped(candidate), encoding="utf-8")
            old.write_text(wrapped(previous), encoding="utf-8")
            timestamp = dt.datetime(2026, 7, 27, 18, 30, tzinfo=dt.timezone.utc)

            with self.assertRaisesRegex(
                subject.SnapshotValidationError, "retained only"
            ):
                subject.prepare_snapshot(
                    source,
                    output_dir=root,
                    previous=old,
                    now=timestamp,
                )

            self.assertFalse((root / subject.snapshot_filename(timestamp)).exists())

    def test_purge_cascades_blacklisted_identity_and_keeps_valid_instrumental(self):
        payload = minimal_payload()
        justin = collaborator("Justin Bieber", "artist-banned", "uuid-banned")
        alias = collaborator("J. B. Alias", "artist-banned", "uuid-banned")
        valid = collaborator("Quiet Keys", "artist-valid", "uuid-valid")
        incomplete_guest = collaborator("Guest", "guest-id", "")

        payload["artists"] += [
            ["artist-banned", "Justin Bieber", "uuid-banned"],
            ["artist-banned", "J. B. Alias", "uuid-banned"],
            ["", "Lil Baby, Gunna, Drake", "uuid-fake-composite"],
        ]
        payload["fal"] += [["uuid-banned", "artist-banned", "J. B. Alias"]]
        payload["editorial"]["artists"] += [
            ["uuid-banned", "artist-banned", "J. B. Alias"]
        ]
        payload["editorial"]["tracks"] += [
            ["song-banned", "track-banned", "Vocal Track", "Justin Bieber"]
        ]
        payload["tracks"] += [
            track("track-banned", "J. B. Alias", [alias]),
            track("track-composite", "Quiet Keys & Guest", [valid, incomplete_guest]),
            # Even a simple unresolved row is quarantine-only in a public snapshot.
            track("track-simple-unresolved", "Solo Unknown", None),
        ]
        payload["opportunities"] += [
            opportunity("opp-banned", "J. B. Alias", [alias]),
            opportunity("opp-incomplete", "Quiet Keys & Guest", [valid, incomplete_guest]),
            opportunity("opp-major", "Quiet Keys", [valid], rights="major"),
        ]
        payload["coverage"]["artists"]["exported"] = 4
        payload["coverage"]["fal"].update(
            {"candidates": 2, "resolved": 2, "exported": 2}
        )
        payload["coverage"]["tracks"]["exported"] = 4

        sanitized, report = subject.sanitize_payload(payload)

        artist_names = [row[1] for row in sanitized["artists"]]
        self.assertEqual(artist_names, ["Quiet Keys"])
        self.assertEqual([row[2] for row in sanitized["fal"]], ["Quiet Keys"])
        self.assertEqual(
            [row[2] for row in sanitized["editorial"]["artists"]],
            ["Quiet Keys"],
        )
        self.assertEqual(
            [row[2] for row in sanitized["editorial"]["tracks"]],
            ["Quiet Track"],
        )
        self.assertEqual(
            [row[0] for row in sanitized["tracks"]],
            ["track-valid"],
        )
        self.assertEqual(
            [row[1] for row in sanitized["opportunities"]],
            ["track-valid"],
        )
        self.assertEqual(
            sanitized["coverage"]["artists"]["exported"], 1
        )
        self.assertEqual(sanitized["coverage"]["fal"]["exported"], 1)
        self.assertEqual(sanitized["coverage"]["tracks"]["exported"], 1)
        self.assertEqual(sanitized["opportunity_scoring"]["opportunities"], 1)
        self.assertEqual(
            report["track_removal_reasons"][
                "composite_credit_without_complete_ids"
            ],
            1,
        )
        self.assertEqual(
            report["opportunity_removal_reasons"]["incomplete_collaborators"],
            1,
        )
        subject.validate_payload(sanitized)

    def test_catalog_fal_resolved_count_is_not_replaced_by_export_size(self):
        payload = minimal_payload()
        payload["coverage"]["fal"]["resolved"] = 16_540

        sanitized, _ = subject.sanitize_payload(payload)

        self.assertEqual(sanitized["coverage"]["fal"]["resolved"], 16_540)

    def test_validation_rejects_incomplete_opportunity_ids(self):
        payload = minimal_payload()
        payload["opportunities"].append(
            opportunity(
                "bad-opportunity",
                "Quiet Keys",
                [collaborator("Quiet Keys", "artist-valid", "")],
            )
        )
        with self.assertRaisesRegex(
            subject.SnapshotValidationError, "incomplete collaborator IDs"
        ):
            subject.validate_payload(payload)

        sanitized, report = subject.sanitize_payload(payload)
        self.assertEqual(
            [row[1] for row in sanitized["opportunities"]], ["track-valid"]
        )
        self.assertEqual(
            report["opportunity_removal_reasons"]["incomplete_collaborators"],
            1,
        )

    def test_general_collections_are_strict_size_bounded_and_id_linked(self):
        payload = minimal_payload()
        composite = collaborator(
            "Sam & Dave", "artist-composite", "uuid-composite"
        )
        oversized = collaborator("Large Ambient", "artist-large", "uuid-large")
        payload["artists"] += [
            ["artist-composite", "Sam & Dave", "uuid-composite", 75_000],
            ["artist-large", "Large Ambient", "uuid-large", 5_000_001],
        ]
        payload["tracks"] += [
            track("track-composite-identity", "Sam & Dave", [composite]),
            track("track-large", "Large Ambient", [oversized]),
            track(
                "track-vocal",
                "Quiet Keys",
                [collaborator("Quiet Keys", "artist-valid", "uuid-valid")],
            ),
            track(
                "track-major",
                "Quiet Keys",
                [collaborator("Quiet Keys", "artist-valid", "uuid-valid")],
            ),
        ]
        payload["tracks"][-2][TRACK_SCHEMA.index("instrumental_status")] = "unknown"
        payload["tracks"][-2][TRACK_SCHEMA.index("expansion_status")] = "review"
        payload["tracks"][-1][TRACK_SCHEMA.index("rights_status")] = "major"
        payload["fal"] += [
            ["uuid-large", "artist-large", "Large Ambient", 5_000_001, 1, "self_released"],
            ["uuid-valid", "wrong-spotify-id", "Quiet Keys", 50_000, 1, "self_released"],
        ]

        sanitized, report = subject.sanitize_payload(payload)

        self.assertEqual(
            [row[0] for row in sanitized["tracks"]],
            ["track-valid", "track-composite-identity"],
        )
        self.assertEqual(
            [row[1] for row in sanitized["artists"]],
            ["Quiet Keys", "Sam & Dave"],
        )
        self.assertEqual([row[2] for row in sanitized["fal"]], ["Quiet Keys"])
        self.assertEqual(
            report["track_removal_reasons"]["artist_size_unknown_or_too_large"],
            1,
        )
        self.assertEqual(
            report["track_removal_reasons"]["classification_not_strict"],
            1,
        )
        self.assertEqual(
            report["track_removal_reasons"]["rights_not_self_or_indie"],
            1,
        )
        subject.validate_payload(sanitized)

    def test_validation_rejects_gates_and_loader_rejects_wrong_prefix(self):
        payload = minimal_payload()
        payload["category"] = "Gates"
        with self.assertRaisesRegex(subject.SnapshotValidationError, "Gates"):
            subject.validate_payload(payload)

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bad.js"
            path.write_text("window.WRONG={};\n", encoding="utf-8")
            with self.assertRaisesRegex(subject.SnapshotValidationError, "does not start"):
                subject.load_payload(path)

    def test_blacklist_name_match_is_exact_for_structured_identity(self):
        payload = minimal_payload()
        drake_hughes = collaborator(
            "Drake Hughes", "artist-drake-hughes", "uuid-drake-hughes"
        )
        payload["artists"].append(
            ["artist-drake-hughes", "Drake Hughes", "uuid-drake-hughes", 2_500]
        )
        payload["tracks"].append(
            track("track-drake-hughes", "Drake Hughes", [drake_hughes])
        )
        payload["opportunities"].append(
            opportunity("opp-drake-hughes", "Drake Hughes", [drake_hughes])
        )

        sanitized, _ = subject.sanitize_payload(payload)

        self.assertIn("Drake Hughes", [row[1] for row in sanitized["artists"]])
        self.assertIn(
            "track-drake-hughes", [row[0] for row in sanitized["tracks"]]
        )
        self.assertIn(
            "opp-drake-hughes", [row[1] for row in sanitized["opportunities"]]
        )
        subject.validate_payload(sanitized)

    def test_reviewed_vocal_artist_is_quarantined_from_public_snapshot(self):
        payload = minimal_payload()
        corbon = collaborator(
            "Corbon Amodio", "artist-corbon", "uuid-corbon"
        )
        payload["artists"].append(
            ["artist-corbon", "Corbon Amodio", "uuid-corbon", 2_500]
        )
        payload["tracks"].append(
            track("track-corbon", "Corbon Amodio", [corbon])
        )
        payload["opportunities"].append(
            opportunity("opp-corbon", "Corbon Amodio", [corbon])
        )

        sanitized, report = subject.sanitize_payload(payload)

        self.assertNotIn("Corbon Amodio", [row[1] for row in sanitized["artists"]])
        self.assertNotIn("track-corbon", [row[0] for row in sanitized["tracks"]])
        self.assertNotIn("opp-corbon", [row[1] for row in sanitized["opportunities"]])
        self.assertNotIn(
            "corbon amodio",
            json.dumps(sanitized["discovery_catalogue"]).casefold(),
        )
        self.assertGreater(report["track_removal_reasons"]["blacklisted_identity"], 0)
        subject.validate_payload(sanitized)

    def test_opportunity_validation_rejects_empty_duplicate_status_and_ai_risk(self):
        empty = minimal_payload()
        empty["opportunities"] = []
        with self.assertRaisesRegex(subject.SnapshotValidationError, "must not be empty"):
            subject.validate_payload(empty)

        duplicate = minimal_payload()
        duplicate["opportunities"].append(duplicate["opportunities"][0].copy())
        with self.assertRaisesRegex(subject.SnapshotValidationError, "duplicate Spotify"):
            subject.validate_payload(duplicate)

        invalid_status = minimal_payload()
        invalid_status["opportunities"][0][
            OPPORTUNITY_SCHEMA.index("opportunity_status")
        ] = "candidate"
        with self.assertRaisesRegex(subject.SnapshotValidationError, "status must"):
            subject.validate_payload(invalid_status)

        invalid_ai = minimal_payload()
        invalid_ai["opportunities"][0][OPPORTUNITY_SCHEMA.index("ai_risk")] = "high"
        with self.assertRaisesRegex(subject.SnapshotValidationError, "classification"):
            subject.validate_payload(invalid_ai)

    def test_invalid_verified_classification_downgrades_and_scrubs_contacts(self):
        payload = minimal_payload()
        artist = collaborator("Review Artist", "review-artist", "review-uuid")
        invalid = [
            opportunity("review-genre", "Review Artist", [artist]),
            opportunity("review-vocal", "Review Artist", [artist]),
            opportunity("review-ai", "Review Artist", [artist]),
        ]
        invalid[0][OPPORTUNITY_SCHEMA.index("primary_genre")] = "pop"
        invalid[1][OPPORTUNITY_SCHEMA.index("instrumental_status")] = "unknown"
        invalid[1][OPPORTUNITY_SCHEMA.index("instrumental_confidence")] = 0
        invalid[2][OPPORTUNITY_SCHEMA.index("ai_risk")] = "high"
        payload["opportunities"].extend(invalid)

        with self.assertRaisesRegex(
            subject.SnapshotValidationError, "verified.*classification"
        ):
            subject.validate_payload(payload)

        sanitized, report = subject.sanitize_payload(payload)
        by_id = {row[1]: row for row in sanitized["opportunities"]}
        for spotify_id in ("review-genre", "review-vocal", "review-ai"):
            row = by_id[spotify_id]
            self.assertEqual(
                row[OPPORTUNITY_SCHEMA.index("opportunity_status")],
                "needs_listen",
            )
            self.assertEqual(
                row[OPPORTUNITY_SCHEMA.index("contact_status")], "blocked"
            )
            self.assertFalse(row[OPPORTUNITY_SCHEMA.index("contact_email")])
            self.assertFalse(row[OPPORTUNITY_SCHEMA.index("contact_url")])
        self.assertEqual(report["opportunities_downgraded_to_needs_listen"], 3)
        self.assertEqual(len(sanitized["opportunities"]), 4)
        subject.validate_payload(sanitized)

    def test_public_general_and_editorial_collections_must_not_be_empty(self):
        cases = [
            ("artists", lambda payload: payload.update(artists=[])),
            ("tracks", lambda payload: payload.update(tracks=[])),
            (
                "editorial.artists",
                lambda payload: payload["editorial"].update(artists=[]),
            ),
            (
                "editorial.tracks",
                lambda payload: payload["editorial"].update(tracks=[]),
            ),
        ]
        for label, mutate in cases:
            with self.subTest(collection=label):
                payload = minimal_payload()
                mutate(payload)
                with self.assertRaisesRegex(
                    subject.SnapshotValidationError, "must be present and non-empty"
                ):
                    subject.validate_payload(payload)

    def test_editorial_track_pair_is_completed_then_compared_exactly(self):
        missing_spotify = minimal_payload()
        missing_spotify["editorial"]["tracks"][0][
            EDITORIAL_TRACK_SCHEMA.index("spotify_id")
        ] = ""

        sanitized, report = subject.sanitize_payload(missing_spotify)
        self.assertEqual(
            sanitized["editorial"]["tracks"][0][
                EDITORIAL_TRACK_SCHEMA.index("spotify_id")
            ],
            "track-valid",
        )
        self.assertEqual(report["editorial_track_spotify_ids_completed"], 1)

        mismatched = minimal_payload()
        mismatched_row = copy.deepcopy(mismatched["editorial"]["tracks"][0])
        mismatched_row[EDITORIAL_TRACK_SCHEMA.index("spotify_id")] = "wrong-track"
        mismatched["editorial"]["tracks"].append(mismatched_row)

        sanitized, report = subject.sanitize_payload(mismatched)
        self.assertEqual(len(sanitized["editorial"]["tracks"]), 1)
        self.assertEqual(
            report["editorial_track_removal_reasons"][
                "not_linked_to_strict_track"
            ],
            1,
        )

        direct_mismatch = minimal_payload()
        direct_mismatch["editorial"]["tracks"][0][
            EDITORIAL_TRACK_SCHEMA.index("spotify_id")
        ] = "wrong-track"
        with self.assertRaisesRegex(
            subject.SnapshotValidationError, "strict linked public track"
        ):
            subject.validate_payload(direct_mismatch)

    def test_needs_listen_unknown_rights_contacts_are_scrubbed_fail_closed(self):
        payload = minimal_payload()
        review_artist = collaborator("Review Artist", "review-artist", "review-uuid")
        review_artist.update(
            {
                "email": "public@example.test",
                "url": "https://example.test/review",
                "contact_platform": "site",
            }
        )
        payload["opportunities"].append(
            opportunity(
                "review-track",
                "Review Artist",
                [review_artist],
                rights="unknown",
                status="needs_listen",
                contact_status="ready",
                contact_email="public@example.test",
                contact_url="https://example.test/review",
            )
        )

        sanitized, report = subject.sanitize_payload(payload)
        review = next(row for row in sanitized["opportunities"] if row[1] == "review-track")
        self.assertEqual(
            review[OPPORTUNITY_SCHEMA.index("contact_status")], "blocked"
        )
        self.assertFalse(review[OPPORTUNITY_SCHEMA.index("contact_email")])
        self.assertFalse(review[OPPORTUNITY_SCHEMA.index("contact_url")])
        self.assertFalse(review[OPPORTUNITY_SCHEMA.index("artists")][0]["email"])
        self.assertFalse(review[OPPORTUNITY_SCHEMA.index("artists")][0]["url"])
        self.assertEqual(report["opportunity_contacts_scrubbed"], 1)
        subject.validate_payload(sanitized)

    def test_unscrubbable_noncontactable_opportunity_is_quarantined(self):
        payload = minimal_payload()
        # A legacy immutable row cannot be rewritten in-place.  It must be
        # removed rather than making the entire dated snapshot fail or
        # exposing a contact on a non-contactable opportunity.
        payload["opportunities"].append(
            tuple(
                opportunity(
                    "legacy-unsafe-contact",
                    "Legacy Contact",
                    [collaborator("Legacy Contact", "legacy-artist", "legacy-uuid")],
                    rights="unknown",
                    status="needs_listen",
                    contact_status="ready",
                    contact_email="public@example.test",
                )
            )
        )

        sanitized, report = subject.sanitize_payload(payload)

        self.assertEqual(len(sanitized["opportunities"]), 1)
        self.assertEqual(
            report["opportunity_removal_reasons"]["unscrubbable_contact"], 1
        )
        subject.validate_payload(sanitized)

    def test_empty_public_contacts_do_not_quarantine_a_scrubbed_opportunity(self):
        payload = minimal_payload()
        review_artist = collaborator(
            "Review Artist", "review-artist", "review-artist-uuid"
        )
        review_artist["public_contacts"] = [
            {"platform": "instagram", "url": "https://example.test/review"}
        ]
        payload["opportunities"].append(
            opportunity(
                "review-track",
                "Review Artist",
                [review_artist],
                rights="unknown",
                status="needs_listen",
                contact_status="ready",
                contact_url="https://example.test/review",
            )
        )

        sanitized, report = subject.sanitize_payload(payload)

        by_id = {row[1]: row for row in sanitized["opportunities"]}
        self.assertIn("review-track", by_id)
        review = by_id["review-track"]
        self.assertEqual(
            review[OPPORTUNITY_SCHEMA.index("contact_status")], "blocked"
        )
        self.assertFalse(review[OPPORTUNITY_SCHEMA.index("contact_url")])
        self.assertEqual(review[OPPORTUNITY_SCHEMA.index("artists")][0]["public_contacts"], [])
        self.assertEqual(
            report["opportunity_removal_reasons"].get("unscrubbable_contact", 0),
            0,
        )
        subject.validate_payload(sanitized)

    def test_activate_is_strict_cas_and_preserves_old_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spotify = root / "spotify"
            spotify.mkdir()
            old_name = "Spotify_Soundcharts_data_20260720T010000Z.js"
            new_name = "Spotify_Soundcharts_data_20260721T173146Z.js"
            old_export = root / old_name
            new_export = root / new_name
            old_export.write_text(wrapped(minimal_payload()), encoding="utf-8")
            new_export.write_text(wrapped(minimal_payload()), encoding="utf-8")
            index = spotify / "index.html"
            index.write_text(
                "<script>const urls=['../"
                + old_name
                + "?payload='+stamp];</script>\n",
                encoding="utf-8",
            )

            self.assertEqual(subject.current_snapshot_name(index), old_name)

            activated = subject.activate_snapshot(
                index, expected_old=old_name, new=new_name
            )

            self.assertEqual(activated, new_export.resolve())
            self.assertIn(new_name, index.read_text(encoding="utf-8"))
            self.assertNotIn(old_name, index.read_text(encoding="utf-8"))
            self.assertTrue(old_export.is_file(), "activation must retain old export")

            with self.assertRaisesRegex(
                subject.CompareAndSwapError, "pointer changed"
            ):
                subject.activate_snapshot(
                    index, expected_old=old_name, new=new_name
                )
            self.assertTrue(old_export.is_file())

    def test_activate_refuses_missing_new_file_without_touching_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spotify = root / "spotify"
            spotify.mkdir()
            old_name = "Spotify_Soundcharts_data.js"
            new_name = "Spotify_Soundcharts_data_20260721T173146Z.js"
            (root / old_name).write_text(wrapped(minimal_payload()), encoding="utf-8")
            index = spotify / "index.html"
            index.write_text(
                f"<script src='../{old_name}'></script>\n", encoding="utf-8"
            )
            before = index.read_bytes()

            with self.assertRaisesRegex(subject.CompareAndSwapError, "new export is missing"):
                subject.activate_snapshot(
                    index, expected_old=old_name, new=new_name
                )
            self.assertEqual(index.read_bytes(), before)

    def test_transition_rejects_a_truncated_strict_catalogue(self):
        previous = minimal_payload()
        candidate = minimal_payload()
        valid_artist = collaborator("Quiet Keys", "artist-valid", "uuid-valid")
        for index in range(2, 12):
            spotify_id = f"track-{index}"
            previous["tracks"].append(
                track(spotify_id, "Quiet Keys", [valid_artist])
            )
            previous["opportunities"].append(
                opportunity(spotify_id, "Quiet Keys", [valid_artist])
            )

        with self.assertRaisesRegex(
            subject.SnapshotValidationError, "retained only"
        ):
            subject.validate_snapshot_transition(previous, candidate)

    def test_transition_rejects_unclassified_high_stream_addition(self):
        previous = minimal_payload()
        candidate = minimal_payload()
        schema = [
            "soundcharts_uuid",
            "spotify_id",
            "streams",
            "instrumental_status",
            "instrumental_confidence",
        ]
        previous["discovery_catalogue"] = {
            "track_schema": schema,
            "tracks": [["old-song", "old-track", 1_000_000, "unknown", None]],
        }
        candidate["discovery_catalogue"] = {
            "track_schema": schema,
            "tracks": [
                ["old-song", "old-track", 1_000_000, "unknown", None],
                ["new-song", "new-track", 500_000_000, "unknown", None],
            ],
        }

        with self.assertRaisesRegex(
            subject.SnapshotValidationError,
            "lacks verified instrumental evidence",
        ):
            subject.validate_snapshot_transition(previous, candidate)

    def test_unclassified_discovery_additions_stay_outside_public_catalogue(self):
        schema = [
            "soundcharts_uuid",
            "spotify_id",
            "artists",
            "artist_soundcharts_uuids",
            "streams",
            "instrumental_status",
            "instrumental_confidence",
            "playlist_count",
            "source_tier",
            "availability_status",
        ]
        artist_schema = ["soundcharts_uuid", "spotify_id", "name"]
        previous = {
            "discovery_catalogue": {
                "track_schema": schema,
                "artist_schema": artist_schema,
                "tracks": [["old-song", "old-track", [], ["old-artist"], 1_000, "unknown", None, 1, "independent_playlist", "needs_listen"]],
                "artists": [["old-artist", "old-artist-spotify", "Old Artist"]],
            }
        }
        candidate = {
            "discovery_catalogue": {
                "track_schema": schema,
                "artist_schema": artist_schema,
                "tracks": [
                    *copy.deepcopy(previous["discovery_catalogue"]["tracks"]),
                    ["unsafe-song", "unsafe-track", [], ["unsafe-artist"], 500_000_000, "unknown", None, 1, "independent_playlist", "needs_listen"],
                    ["safe-song", "safe-track", [], ["safe-artist"], 2_000, "instrumental", 0.9, 1, "editorial_playlist", "verified"],
                ],
                "artists": [
                    *copy.deepcopy(previous["discovery_catalogue"]["artists"]),
                    ["unsafe-artist", "unsafe-artist-spotify", "Unsafe Artist"],
                    ["safe-artist", "safe-artist-spotify", "Safe Artist"],
                ],
            }
        }

        removed = subject.quarantine_unapproved_discovery_additions(
            previous, candidate
        )
        retained_track_ids = {
            row[1] for row in candidate["discovery_catalogue"]["tracks"]
        }
        retained_artist_ids = {
            row[1] for row in candidate["discovery_catalogue"]["artists"]
        }

        self.assertEqual(removed, {"tracks": 1, "artists": 1})
        self.assertEqual(retained_track_ids, {"old-track", "safe-track"})
        self.assertEqual(
            retained_artist_ids, {"old-artist-spotify", "safe-artist-spotify"}
        )

    def test_previously_approved_track_reclassified_as_vocal_is_quarantined(self):
        schema = [
            "soundcharts_uuid",
            "spotify_id",
            "instrumental_status",
            "instrumental_confidence",
        ]
        previous = {
            "discovery_catalogue": {
                "track_schema": schema,
                "artist_schema": ["soundcharts_uuid", "spotify_id", "name"],
                "tracks": [["old-song", "old-track", "instrumental", 0.9]],
                "artists": [],
            }
        }
        candidate = copy.deepcopy(previous)
        candidate["discovery_catalogue"]["tracks"][0][2] = "vocal"

        removed = subject.quarantine_unapproved_discovery_additions(
            previous, candidate
        )

        self.assertEqual(removed, {"tracks": 1, "artists": 0})
        self.assertEqual(candidate["discovery_catalogue"]["tracks"], [])
        self.assertEqual(candidate["discovery_catalogue"]["counts"]["tracks"], 0)

    def test_transition_rejects_discovery_catalogue_collapse(self):
        previous = minimal_payload()
        candidate = minimal_payload()
        schema = ["soundcharts_uuid", "spotify_id"]
        previous["discovery_catalogue"] = {
            "track_schema": schema,
            "tracks": [
                [f"song-{index}", f"track-{index}"] for index in range(10)
            ],
        }
        candidate["discovery_catalogue"] = {
            "track_schema": schema,
            "tracks": [["song-0", "track-0"]],
        }

        with self.assertRaisesRegex(
            subject.SnapshotValidationError,
            "discovery_catalogue retained only",
        ):
            subject.validate_snapshot_transition(previous, candidate)


if __name__ == "__main__":
    unittest.main()
