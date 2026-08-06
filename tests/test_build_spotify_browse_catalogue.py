import copy
import tempfile
import unittest

import build_spotify_browse_catalogue as subject
import spotify_rights


TRACK_SCHEMA = [
    "soundcharts_uuid",
    "spotify_id",
    "title",
    "artists",
    "streams",
    "playlist_count",
    "playlist_first_seen_at",
    "playlist_last_seen_at",
    "availability_status",
]
ARTIST_SCHEMA = ["soundcharts_uuid", "spotify_id", "name", "monthly_listeners", "availability_status"]


def catalogue(track_rows, artist_rows):
    return {
        "version": 1,
        "generated_at": "2026-07-22T10:00:00Z",
        "track_schema": TRACK_SCHEMA,
        "artist_schema": ARTIST_SCHEMA,
        "playlist_schema": ["spotify_id", "name", "position", "followers", "first_seen_at", "last_seen_at"],
        "tracks": track_rows,
        "artists": artist_rows,
        "counts": {},
    }


class BrowseCatalogueTests(unittest.TestCase):
    def test_trusted_csv_deduplicates_by_spotify_id_with_maximum_counter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = subject.Path(directory) / "trusted.csv"
            path.write_text(
                "Artiste,Track,Date,Streams,Streams/mois (moy. depuis sortie),Statut,Label / Copyright,Lien Spotify\n"
                "Known Artist,First credit,2026-01-01,90000,0,Self-released,Known Artist,https://open.spotify.com/track/shared123\n"
                "Known Artist,Second credit,2026-01-01,150000,0,Self-released,Known Artist,https://open.spotify.com/intl-en/track/shared123\n",
                encoding="utf-8",
            )

            trusted = subject._trusted_catalogue_from_csv(path, None)
            records = [
                subject._record(row, trusted["track_schema"])
                for row in trusted["tracks"]
            ]

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["spotify_id"], "shared123")
        self.assertEqual(records[0]["streams"], 150_000)

    def test_dreamscape_division_suffix_is_not_part_of_the_label_name(self):
        copyright_text = (
            "C 2024 Harris Cole & Aso, under exclusive license to dreamscape, "
            "a division of Kurate Music Ltd. ; P 2024 Harris Cole & Aso, "
            "under exclusive license to dreamscape, a division of Kurate Music Ltd."
        )

        status, confidence, licensee = spotify_rights.reconcile_rights(
            "self_released",
            "Harris Cole & Aso",
            copyright_text,
            0.9,
        )

        self.assertEqual(licensee, "dreamscape")
        self.assertEqual(spotify_rights.reconciled_label("Harris Cole & Aso", copyright_text), "dreamscape")
        self.assertEqual(status, "independent_label")
        self.assertGreaterEqual(confidence, 0.98)

    def test_merge_preserves_old_rows_and_enriches_matching_rows(self):
        old = catalogue(
            [["track-a", "", "Old title", [{"soundcharts_uuid": "artist-a", "name": "Artist A", "contact_url": "hidden"}], None, 1, "2026-07-01", "2026-07-10", "playlist_discovered"]],
            [["artist-a", "", "Artist A", None, "discovered"]],
        )
        new = catalogue(
            [
                ["track-a", "spotify-a", "New title", [{"soundcharts_uuid": "artist-a", "spotify_id": "spotify-artist-a", "name": "Artist A"}], 1234, 2, "2026-07-03", "2026-07-22", "measured"],
                ["track-b", "spotify-b", "Track B", [], 50, 0, "", "", "measured"],
            ],
            [["artist-a", "spotify-artist-a", "Artist A", 12345, "measured"]],
        )
        merged = subject.merge_catalogues([old, new])
        self.assertGreaterEqual(merged["counts"]["tracks"], 2)
        schema = merged["track_schema"]
        rows = [subject._record(row, schema) for row in merged["tracks"]]
        track_a = next(row for row in rows if row.get("soundcharts_uuid") == "track-a" and row.get("spotify_id") == "spotify-a")
        self.assertEqual(track_a["title"], "New title")
        self.assertEqual(track_a["streams"], 1234)
        self.assertEqual(track_a["playlist_first_seen_at"], "2026-07-01")
        self.assertEqual(track_a["playlist_last_seen_at"], "2026-07-22")
        self.assertNotIn("contact_url", track_a["artists"][0])

    def test_policy_keeps_browsing_full_and_ar_strict(self):
        payload = {
            "generated_at": "2026-07-22T10:00:00Z",
            "tracks": [[1]],
            "artists": [[1]],
            "opportunities": [[1], [2]],
            "discovery_catalogue": catalogue(
                [["track-a", "spotify-a", "Track A", [], 1, 0, "", "", "measured"]],
                [["artist-a", "spotify-artist-a", "Artist A", 10, "measured"]],
            ),
        }
        result = subject.build_payload(
            [(subject.Path("snapshot.js"), payload)],
            None,
            minimum_tracks=1,
        )
        self.assertEqual(result["policy"]["browsing"], "full")
        self.assertEqual(result["policy"]["ar"], "strict")
        self.assertFalse(result["policy"]["unverified_records_contactable"])
        self.assertEqual(result["strict_snapshot_counts"]["opportunities"], 2)

    def test_forbidden_contact_columns_are_removed(self):
        unsafe = copy.deepcopy(catalogue([], []))
        unsafe["artist_schema"].append("contact_email")
        unsafe["artists"] = [["artist-a", "spotify-a", "Artist A", 100, "measured", "secret@example.test"]]
        merged = subject.merge_catalogues([unsafe])
        self.assertNotIn("contact_email", merged["artist_schema"])

    def test_merge_reconciles_exclusive_licence_for_oneheart(self):
        rights_schema = [
            *TRACK_SCHEMA,
            "rights_status",
            "rights_confidence",
            "label",
            "copyright",
        ]
        raw = {
            "soundcharts_uuid": "oneheart-song",
            "spotify_id": "oneheart-track",
            "title": "Snowfall",
            "artists": [{"name": "Øneheart"}],
            "availability_status": "measured",
            "rights_status": "self_released",
            "rights_confidence": 0.9,
            "label": "Øneheart",
            "copyright": (
                "℗ 2026 Øneheart, under exclusive licence "
                "to Dreamscape Records"
            ),
        }
        source = {
            "version": 1,
            "generated_at": "2026-07-28T10:00:00Z",
            "track_schema": rights_schema,
            "artist_schema": ARTIST_SCHEMA,
            "playlist_schema": [],
            "tracks": [[raw.get(field) for field in rights_schema]],
            "artists": [],
        }
        partial = copy.deepcopy(source)
        partial["generated_at"] = "2026-07-28T11:00:00Z"
        partial_record = {
            "soundcharts_uuid": "oneheart-song",
            "spotify_id": "oneheart-track",
            "title": "Snowfall refreshed",
            "availability_status": "measured",
        }
        partial["tracks"] = [
            [partial_record.get(field) for field in rights_schema]
        ]
        merged = subject.merge_catalogues([source, partial])
        record = subject._record(merged["tracks"][0], merged["track_schema"])
        self.assertEqual(record["rights_status"], "independent_label")
        self.assertEqual(record["label"], "Dreamscape Records")
        self.assertGreaterEqual(record["rights_confidence"], 0.98)

    def test_strict_rebaseline_keeps_only_evidenced_instrumental_editorial_rows(self):
        strict_schema = [
            "soundcharts_uuid", "spotify_id", "title", "credit_name", "artists",
            "primary_genre", "genre_confidence", "instrumental_status",
            "instrumental_confidence", "ai_risk", "rights_status",
            "rights_confidence", "source_tier", "streams",
        ]
        artist_schema = ["soundcharts_uuid", "spotify_id", "name"]
        valid_artist = {
            "soundcharts_uuid": "artist-a", "spotify_id": "artist-spotify-a", "name": "Artist A"
        }
        valid = {
            "soundcharts_uuid": "track-a", "spotify_id": "spotify-a", "title": "Instrumental",
            "credit_name": "Artist A", "artists": [valid_artist], "primary_genre": "ambient",
            "genre_confidence": 0.9, "instrumental_status": "instrumental",
            "instrumental_confidence": 0.9, "ai_risk": "low", "rights_status": "self_released",
            "rights_confidence": 0.9, "source_tier": "editorial_playlist", "streams": 100_000,
        }
        independent = {
            **valid, "soundcharts_uuid": "track-independent", "spotify_id": "spotify-independent",
            "source_tier": "independent_playlist",
        }
        below_floor = {
            **valid, "soundcharts_uuid": "track-below", "spotify_id": "spotify-below",
            "streams": 99_999,
        }
        vocal = {**valid, "soundcharts_uuid": "track-b", "spotify_id": "spotify-b", "instrumental_status": "unknown"}
        major = {**valid, "soundcharts_uuid": "track-c", "spotify_id": "spotify-c", "rights_status": "major"}
        composite = {
            **valid, "soundcharts_uuid": "track-d", "spotify_id": "spotify-d",
            "credit_name": "Artist A & Missing", "artists": [valid_artist],
        }
        source_catalogue = {
            "version": 1,
            "generated_at": "2026-07-23T10:00:00Z",
            "track_schema": strict_schema,
            "artist_schema": artist_schema,
            "playlist_schema": [],
            "tracks": [[row.get(name) for name in strict_schema] for row in [valid, independent, below_floor, vocal, major, composite]],
            "artists": [["artist-a", "artist-spotify-a", "Artist A"]],
        }
        strict, reasons, active_ids = subject.strict_rebase_catalogue([source_catalogue])
        records = [subject._record(row, strict["track_schema"]) for row in strict["tracks"]]
        self.assertEqual([row["spotify_id"] for row in records], ["spotify-a", "spotify-independent"])
        self.assertEqual(active_ids, ["spotify-a", "spotify-independent"])
        self.assertEqual(reasons["instrumental_unconfirmed"], 1)
        self.assertEqual(reasons["rights_unconfirmed"], 1)
        self.assertEqual(reasons["composite_credit_unresolved"], 1)
        self.assertEqual(reasons["streams_below_minimum"], 1)

        blacklisted = {**valid, "soundcharts_uuid": "track-e", "spotify_id": "spotify-e", "credit_name": "Corbon Amodio", "artists": [{**valid_artist, "name": "Corbon Amodio"}]}
        _, blacklisted_reasons, _ = subject.strict_rebase_catalogue([
            {**source_catalogue, "tracks": [[row.get(name) for name in strict_schema] for row in [valid, blacklisted]]}
        ])
        self.assertEqual(blacklisted_reasons["blacklisted_identity"], 1)

        payload = {"generated_at": "2026-07-23T10:00:00Z", "discovery_catalogue": source_catalogue}
        result = subject.build_payload(
            [(subject.Path("snapshot.js"), payload)], None, minimum_tracks=1, strict_rebased=True
        )
        self.assertEqual(result["policy"]["browsing"], "strict_instrumental_rebased")
        self.assertEqual(result["policy"]["archive"], "Spotify_Radar_data.js")
        self.assertEqual(result["active_legacy_spotify_ids"], ["spotify-a", "spotify-independent"])

    def test_trusted_catalogue_unknown_and_vocal_rows_are_quarantined(self):
        artist = {
            "soundcharts_uuid": "artist-trusted",
            "spotify_id": "spotify-artist-trusted",
            "name": "Trusted Artist",
        }
        evidenced = {
            "soundcharts_uuid": "track-trusted-valid",
            "spotify_id": "spotify-trusted-valid",
            "title": "Verified instrumental",
            "credit_name": "Trusted Artist",
            "artists": [artist],
            "primary_genre": "ambient",
            "genre_confidence": 0.9,
            "instrumental_status": "instrumental",
            "instrumental_confidence": 0.9,
            "ai_risk": "low",
            "rights_status": "self_released",
            "rights_confidence": 0.9,
            "source_tier": subject.TRUSTED_CATALOGUE_SOURCE_TIER,
            "streams": 100_000,
        }
        unknown = {
            **evidenced,
            "soundcharts_uuid": "track-trusted-unknown",
            "spotify_id": "spotify-trusted-unknown",
            "title": "Unknown evidence",
            "instrumental_status": "unknown",
        }
        vocal = {
            **evidenced,
            "soundcharts_uuid": "track-trusted-vocal",
            "spotify_id": "spotify-trusted-vocal",
            "title": "Known vocal",
            "instrumental_status": "vocal",
        }
        strict_schema = list(evidenced)
        artist_schema = list(artist)
        source_catalogue = {
            "version": 1,
            "generated_at": "2026-08-06T10:00:00Z",
            "track_schema": strict_schema,
            "artist_schema": artist_schema,
            "playlist_schema": [],
            "tracks": [
                [row.get(name) for name in strict_schema]
                for row in [evidenced, unknown, vocal]
            ],
            "artists": [[artist.get(name) for name in artist_schema]],
        }

        strict, reasons, active_ids = subject.strict_rebase_catalogue([source_catalogue])
        records = [
            subject._record(row, strict["track_schema"])
            for row in strict["tracks"]
        ]

        self.assertEqual([row["spotify_id"] for row in records], ["spotify-trusted-valid"])
        self.assertEqual(active_ids, ["spotify-trusted-valid"])
        self.assertEqual(reasons["instrumental_unconfirmed"], 2)

    def test_exact_spreadsheet_ids_use_the_internal_inventory_lane(self):
        artist = {
            "soundcharts_uuid": "",
            "spotify_id": "spotify-artist-known",
            "name": "Known Label Artist",
        }
        schema = [
            "soundcharts_uuid", "spotify_id", "title", "credit_name", "artists",
            "primary_genre", "genre_confidence", "instrumental_status",
            "instrumental_confidence", "ai_risk", "rights_status",
            "rights_confidence", "source_tier", "streams",
        ]
        trusted_unknown = {
            "soundcharts_uuid": "",
            "spotify_id": "spotify-trusted-unknown",
            "title": "Known catalogue track",
            "credit_name": "Known Label Artist",
            "artists": [artist],
            "primary_genre": "trusted_catalogue",
            "genre_confidence": None,
            "instrumental_status": "trusted_catalogue",
            "instrumental_confidence": None,
            "ai_risk": "unknown",
            "rights_status": "catalogue_trusted",
            "rights_confidence": None,
            "source_tier": subject.TRUSTED_CATALOGUE_SOURCE_TIER,
            "streams": 100_000,
        }
        trusted_below = {
            **trusted_unknown,
            "spotify_id": "spotify-trusted-below",
            "title": "Below floor",
            "streams": 99_999,
        }
        spoofed_external = {
            **trusted_unknown,
            "spotify_id": "spotify-spoofed",
            "title": "Spoofed source tier",
        }
        overlapping_lower = {
            **trusted_unknown,
            "soundcharts_uuid": "soundcharts-overlap",
            "title": "Older overlapping row",
            "primary_genre": "pop",
            "source_tier": "independent_playlist",
            "streams": 50_000,
        }
        trusted_catalogue = {
            "version": 1,
            "generated_at": "",
            "track_schema": schema,
            "artist_schema": list(artist),
            "playlist_schema": [],
            "tracks": [
                [row.get(name) for name in schema]
                for row in [trusted_unknown, trusted_below]
            ],
            "artists": [[artist.get(name) for name in artist]],
        }
        external_catalogue = {
            **trusted_catalogue,
            "generated_at": "2026-08-06T10:00:00Z",
            "tracks": [
                [row.get(name) for name in schema]
                for row in [spoofed_external, overlapping_lower]
            ],
            "artists": [],
        }
        payload = {
            "generated_at": "2026-08-06T10:00:00Z",
            "discovery_catalogue": external_catalogue,
        }

        result = subject.build_payload(
            [(subject.Path("snapshot.js"), payload)],
            None,
            minimum_tracks=1,
            strict_rebased=True,
            trusted_catalogue=trusted_catalogue,
        )
        records = [
            subject._record(row, result["discovery_catalogue"]["track_schema"])
            for row in result["discovery_catalogue"]["tracks"]
        ]

        self.assertEqual(
            [row["spotify_id"] for row in records],
            ["spotify-trusted-unknown"],
        )
        self.assertEqual(
            result["trusted_internal_spotify_ids"],
            ["spotify-trusted-unknown"],
        )
        self.assertEqual(
            result["policy"]["browsing"],
            "trusted_internal_catalogue_plus_strict_soundcharts",
        )
        self.assertEqual(result["quarantine_counts"]["streams_below_minimum"], 1)
        self.assertEqual(result["quarantine_counts"]["genre_out_of_scope"], 1)

    def test_trusted_catalogue_cannot_bypass_any_strict_evidence_gate(self):
        valid = {
            "soundcharts_uuid": "track-trusted",
            "spotify_id": "spotify-trusted",
            "title": "Trusted track",
            "credit_name": "Trusted Artist",
            "artists": [{
                "soundcharts_uuid": "artist-trusted",
                "spotify_id": "spotify-artist-trusted",
                "name": "Trusted Artist",
            }],
            "primary_genre": "ambient",
            "genre_confidence": 0.9,
            "instrumental_status": "instrumental",
            "instrumental_confidence": 0.9,
            "ai_risk": "low",
            "rights_status": "self_released",
            "rights_confidence": 0.9,
            "source_tier": subject.TRUSTED_CATALOGUE_SOURCE_TIER,
            "streams": 100_000,
        }
        self.assertIsNone(subject._strict_rebaseline_reason(valid))
        for genre in ("guitar", "instrumental_phonk", "phonk_instrumental", "instrumental_dnb", "dnb_instrumental"):
            with self.subTest(allowed_genre=genre):
                self.assertIsNone(subject._strict_rebaseline_reason({**valid, "primary_genre": genre}))

        rejected = {
            "source": ({**valid, "source_tier": "legacy_import"}, "unapproved_source"),
            "genre": ({**valid, "primary_genre": "trusted_catalogue"}, "genre_out_of_scope"),
            "instrumental": ({**valid, "instrumental_status": "unknown"}, "instrumental_unconfirmed"),
            "genre_confidence": ({**valid, "genre_confidence": None}, "genre_confidence_low"),
            "instrumental_confidence": ({**valid, "instrumental_confidence": None}, "instrumental_confidence_low"),
            "ai": ({**valid, "ai_risk": "unknown"}, "ai_risk_not_low"),
            "rights": ({**valid, "rights_status": "catalogue_trusted"}, "rights_unconfirmed"),
            "rights_confidence": ({**valid, "rights_confidence": None}, "rights_confidence_low"),
            "track_identity": ({**valid, "soundcharts_uuid": ""}, "track_identity_incomplete"),
            "artist_identity": ({**valid, "artists": [{"name": "Trusted Artist"}]}, "artist_identity_incomplete"),
            "streams": ({**valid, "streams": 99_999}, "streams_below_minimum"),
        }
        for gate, (row, expected_reason) in rejected.items():
            with self.subTest(gate=gate):
                self.assertEqual(
                    subject._strict_rebaseline_reason(row),
                    expected_reason,
                )


    def test_performance_crossing_reactivates_only_source_backed_candidate(self):
        strict_schema = [
            "soundcharts_uuid", "spotify_id", "title", "credit_name", "artists",
            "primary_genre", "genre_confidence", "instrumental_status",
            "instrumental_confidence", "ai_risk", "rights_status",
            "rights_confidence", "source_tier", "streams", "streams_source_date",
        ]
        artist_schema = ["soundcharts_uuid", "spotify_id", "name"]
        artist = {
            "soundcharts_uuid": "artist-a",
            "spotify_id": "artist-spotify-a",
            "name": "Artist A",
        }

        def track(uuid, spotify_id, streams):
            return {
                "soundcharts_uuid": uuid,
                "spotify_id": spotify_id,
                "title": spotify_id,
                "credit_name": "Artist A",
                "artists": [artist],
                "primary_genre": "ambient",
                "genre_confidence": 0.9,
                "instrumental_status": "instrumental",
                "instrumental_confidence": 0.9,
                "ai_risk": "low",
                "rights_status": "self_released",
                "rights_confidence": 0.9,
                "source_tier": "editorial_playlist",
                "streams": streams,
                "streams_source_date": "2026-07-30",
            }

        candidate = track("track-candidate", "spotify-candidate", 99_999)
        anchor = track("track-anchor", "spotify-anchor", 120_000)
        source_catalogue = {
            "version": 1,
            "generated_at": "2026-07-31T10:00:00Z",
            "track_schema": strict_schema,
            "artist_schema": artist_schema,
            "playlist_schema": [],
            "tracks": [
                [row.get(name) for name in strict_schema]
                for row in [candidate, anchor]
            ],
            "artists": [["artist-a", "artist-spotify-a", "Artist A"]],
        }
        source = {
            "generated_at": "2026-07-31T10:00:00Z",
            "discovery_catalogue": source_catalogue,
        }
        first = subject.build_payload(
            [(subject.Path("snapshot.js"), source)],
            None,
            minimum_tracks=1,
            strict_rebased=True,
        )
        self.assertEqual(first["active_legacy_spotify_ids"], ["spotify-anchor"])

        performance = {
            "tracks": {
                "spotify-candidate": {
                    "soundcharts_uuid": "track-candidate",
                    "history": [["2026-07-31", 99_999], ["2026-08-01", 100_000]],
                },
                "spotify-anchor": {
                    "soundcharts_uuid": "track-anchor",
                    "history": [["2026-08-01", 99_999]],
                },
                "spotify-orphan": {
                    "soundcharts_uuid": "track-orphan",
                    "history": [["2026-08-01", 200_000]],
                },
            }
        }
        second = subject.build_payload(
            [(subject.Path("snapshot.js"), source)],
            first,
            minimum_tracks=1,
            strict_rebased=True,
            performance=performance,
        )
        self.assertEqual(second["active_legacy_spotify_ids"], ["spotify-candidate"])
        self.assertNotIn("spotify-orphan", second["active_legacy_spotify_ids"])
        schema = second["discovery_catalogue"]["track_schema"]
        records = [
            subject._record(row, schema)
            for row in second["discovery_catalogue"]["tracks"]
        ]
        self.assertEqual(records[0]["streams"], 100_000)


if __name__ == "__main__":
    unittest.main()
