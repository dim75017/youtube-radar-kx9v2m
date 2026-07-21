import copy
import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sync_soundcharts_opportunities as subject


TRACK_SCHEMA = [
    "spotify_id",
    "artist",
    "title",
    "release_date",
    "streams",
    "delta",
    "source_date",
    "observed_at",
    "rights_status",
    "status_source",
    "label",
    "copyright",
    "distributor",
    "metadata_status",
    "identifiers_status",
    "metadata_updated_at",
    "soundcharts_uuid",
    "previous_source_date",
    "artists",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "expansion_status",
    "rights_confidence",
    "source_tier",
]

ARTIST_SCHEMA = [
    "spotify_id",
    "name",
    "monthly_listeners",
    "delta",
    "source_date",
    "observed_at",
    "qualifies",
    "fal_in",
    "fal_out",
    "soundcharts_uuid",
    "spotify_followers",
    "contact_url",
    "contact_platform",
    "source_tier",
]


def track_row(
    spotify_id,
    uuid,
    title,
    artist,
    release_date,
    rights,
    artist_spotify,
    artist_uuid,
    genre="ambient",
    instrumental="instrumental",
    listeners=None,
):
    values = {
        "spotify_id": spotify_id,
        "artist": artist,
        "title": title,
        "release_date": release_date,
        "streams": 1_000_000,
        "delta": 1_000,
        "source_date": "2026-07-21",
        "observed_at": "2026-07-21T12:00:00Z",
        "rights_status": rights,
        "status_source": "soundcharts_song_metadata",
        "label": artist if rights == "self_released" else "Indie Label",
        "copyright": f"2026 {artist}",
        "distributor": "Independent",
        "metadata_status": "complete",
        "identifiers_status": "complete",
        "metadata_updated_at": "2026-07-21T12:00:00Z",
        "soundcharts_uuid": uuid,
        "previous_source_date": "2026-07-20",
        "artists": [
            {
                "spotify_id": artist_spotify,
                "soundcharts_uuid": artist_uuid,
                "name": artist,
                "role": "main",
            }
        ],
        "primary_genre": genre,
        "subgenres": ["piano"],
        "genre_confidence": 0.9,
        "instrumental_status": instrumental,
        "instrumental_confidence": 1.0 if instrumental == "instrumental" else 0.0,
        "ai_risk": "low",
        "ai_risk_score": 0,
        "expansion_status": "eligible" if instrumental == "instrumental" else "review",
        "rights_confidence": 0.9 if rights != "unknown" else 0.25,
        "source_tier": "instrumental_editorial_daily",
    }
    return [values.get(name) for name in TRACK_SCHEMA]


def artist_row(spotify_id, uuid, name, listeners, contact_url=""):
    values = {
        "spotify_id": spotify_id,
        "name": name,
        "monthly_listeners": listeners,
        "delta": 100,
        "source_date": "2026-07-21",
        "observed_at": "2026-07-21T12:00:00Z",
        "qualifies": 1,
        "fal_in": 0,
        "fal_out": 0,
        "soundcharts_uuid": uuid,
        "spotify_followers": 1000,
        "contact_url": contact_url,
        "contact_platform": "instagram" if contact_url else "",
        "source_tier": "instrumental_editorial",
    }
    return [values.get(name) for name in ARTIST_SCHEMA]


def history(latest=1_000_000, d1=1_000, d7=20_000, previous7=10_000, d30=80_000):
    # Exact points required by the engine: D, D-1, D-7, D-14, D-30.
    return [
        ["2026-06-21", latest - d30],
        ["2026-07-07", latest - d7 - previous7],
        ["2026-07-14", latest - d7],
        ["2026-07-20", latest - d1],
        ["2026-07-21", latest],
    ]


def base_payload():
    tracks = [
        track_row(
            "track-distribution-01",
            "song-dist",
            "Quiet Rise",
            "Quiet Artist",
            "2026-06-01",
            "self_released",
            "artist-dist-spotify01",
            "artist-dist",
        ),
        track_row(
            "track-catalogue-001",
            "song-cat",
            "Evergreen Sleep",
            "Catalog Artist",
            "2022-01-01",
            "independent_label",
            "artist-cat-spotify001",
            "artist-cat",
        ),
        track_row(
            "track-major-exclude01",
            "song-major",
            "Major Track",
            "Major Artist",
            "2026-05-01",
            "major",
            "artist-major-spotify1",
            "artist-major",
        ),
        track_row(
            "track-superstar-001",
            "song-star",
            "Star Track",
            "Star Artist",
            "2026-05-01",
            "self_released",
            "artist-star-spotify01",
            "artist-star",
        ),
        track_row(
            "track-rights-review1",
            "song-review",
            "Unknown Rights",
            "Mystery Artist",
            "2026-04-01",
            "unknown",
            "artist-review-spotify1",
            "artist-review",
            instrumental="unknown",
        ),
    ]
    artists = [
        artist_row("artist-dist-spotify01", "artist-dist", "Quiet Artist", 120_000),
        artist_row("artist-cat-spotify001", "artist-cat", "Catalog Artist", 450_000, "https://instagram.com/catalog"),
        artist_row("artist-major-spotify1", "artist-major", "Major Artist", 200_000),
        artist_row("artist-star-spotify01", "artist-star", "Star Artist", 12_000_000),
        artist_row("artist-review-spotify1", "artist-review", "Mystery Artist", 80_000),
    ]
    return {
        "coverage": {"discography": {"total": 271713}},
        "schemas": {"tracks": copy.deepcopy(TRACK_SCHEMA), "artists": copy.deepcopy(ARTIST_SCHEMA)},
        "tracks": tracks,
        "artists": artists,
        "editorial": {"track_schema": [], "tracks": []},
    }


def performance_payload():
    return {
        "tracks": {
            "track-distribution-01": {"history": history(1_000_000, 5_000, 35_000, 15_000, 120_000)},
            "track-catalogue-001": {"history": history(8_000_000, 2_000, 20_000, 18_000, 90_000)},
            "track-major-exclude01": {"history": history(2_000_000, 10_000, 80_000, 40_000, 300_000)},
            "track-superstar-001": {"history": history(20_000_000, 20_000, 100_000, 80_000, 500_000)},
            "track-rights-review1": {"history": history(500_000, 2_000, 12_000, 4_000, 40_000)},
        }
    }


def legacy_payload():
    return {
        "artists": [
            ["Quiet Artist", 0, "", 0, 0, "", "", "artist-dist-spotify01", "", "quiet@example.com", ""],
        ]
    }


class OpportunityEngineTests(unittest.TestCase):
    def test_dynamic_engine_creates_separate_deal_types_and_excludes_bad_targets(self):
        current = base_payload()
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)):
            summary = subject.generate_opportunities(current, performance_payload(), legacy_payload())

        schema = current["schemas"]["opportunities"]
        rows = [subject.row_dict(row, schema) for row in current["opportunities"]]
        by_id = {row["spotify_id"]: row for row in rows}
        self.assertEqual(summary["status"], "success")
        self.assertEqual(by_id["track-distribution-01"]["deal_type"], "distribution")
        self.assertEqual(by_id["track-catalogue-001"]["deal_type"], "catalog_acquisition")
        self.assertEqual(by_id["track-rights-review1"]["deal_type"], "rights_review")
        self.assertNotIn("track-major-exclude01", by_id)
        self.assertNotIn("track-superstar-001", by_id)
        self.assertEqual(by_id["track-distribution-01"]["contact_email"], "quiet@example.com")
        self.assertEqual(by_id["track-distribution-01"]["contact_status"], "ready")
        self.assertGreater(by_id["track-distribution-01"]["acceleration_7d"], 0)
        self.assertGreater(by_id["track-distribution-01"]["score"], 40)
        self.assertEqual(current["opportunity_scoring"]["catalog_total"], 271713)
        self.assertGreaterEqual(current["opportunity_scoring"]["excluded"]["major_or_mixed"], 1)
        self.assertGreaterEqual(current["opportunity_scoring"]["excluded"]["superstar"], 1)

    def test_duplicate_spotify_aliases_collapse_to_one_business_lead(self):
        current = base_payload()
        duplicate = copy.deepcopy(current["tracks"][0])
        schema = current["schemas"]["tracks"]
        duplicate[schema.index("soundcharts_uuid")] = "song-dist-alias"
        duplicate[schema.index("title")] = "Quiet Rise - Alias"
        current["tracks"].append(duplicate)
        performance = performance_payload()
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)):
            subject.generate_opportunities(current, performance, legacy_payload())
        schema = current["schemas"]["opportunities"]
        rows = [subject.row_dict(row, schema) for row in current["opportunities"]]
        matching = [row for row in rows if row["spotify_id"] == "track-distribution-01"]
        self.assertEqual(len(matching), 1)

    def test_nonconsecutive_history_never_invents_24h_delta(self):
        track = subject.row_dict(base_payload()["tracks"][0], TRACK_SCHEMA)
        metrics = subject.metric_snapshot(
            track,
            {"history": [["2026-07-19", 100], ["2026-07-21", 200]]},
        )
        # Track fallback is rejected because previous_source_date is D-1 only for
        # the synthetic row's 2026-07-21 source date, while its raw delta would be
        # valid. Change it to a non-consecutive date to assert the gate.
        track["previous_source_date"] = "2026-07-19"
        metrics = subject.metric_snapshot(track, {"history": [["2026-07-19", 100], ["2026-07-21", 200]]})
        self.assertIsNone(metrics["d1"])

    def test_artist_listener_cap_is_configurable(self):
        current = base_payload()
        with patch.object(subject, "utc_today", return_value=dt.date(2026, 7, 21)):
            subject.generate_opportunities(
                current,
                performance_payload(),
                legacy_payload(),
                max_artist_listeners=100_000,
            )
        schema = current["schemas"]["opportunities"]
        ids = {subject.field(row, schema, "spotify_id") for row in current["opportunities"]}
        self.assertNotIn("track-distribution-01", ids)
        self.assertIn("track-rights-review1", ids)

    def test_js_payload_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.js"
            payload = {"opportunities": [["track-1"]]}
            subject.write_js_payload(path, payload, subject.SOUNDCHARTS_PREFIX)
            self.assertEqual(subject.read_js_payload(path, subject.SOUNDCHARTS_PREFIX), payload)


if __name__ == "__main__":
    unittest.main()
