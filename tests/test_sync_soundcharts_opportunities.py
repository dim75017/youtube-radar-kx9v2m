import copy
import tempfile
import unittest
from pathlib import Path

import sync_soundcharts_opportunities as subject


OPPORTUNITY_SCHEMA = [
    "opportunity_status",
    "spotify_id",
    "soundcharts_uuid",
    "title",
    "credit_name",
    "artists",
    "release_date",
    "primary_genre",
    "subgenres",
    "genre_confidence",
    "instrumental_status",
    "instrumental_confidence",
    "ai_risk",
    "ai_risk_score",
    "rights_status",
    "label",
    "labels",
    "copyright",
    "distributor",
    "streams",
    "streams_source_date",
    "streams_observed_at",
    "streams_delta_24h",
    "delta_previous_source_date",
    "delta_previous_observed_at",
    "delta_window_hours",
    "editorial_placement_count",
    "editorial_best_position",
    "editorial_followers_total",
    "editorial_followers_known_count",
    "editorial_top_playlist",
    "editorial_first_seen_at",
    "editorial_last_seen_at",
    "roster_relationship",
    "score",
    "score_momentum",
    "score_editorial",
    "score_traction",
    "score_recency",
    "score_relationship",
    "score_confidence",
    "reason_codes",
    "reasons",
    "metadata_updated_at",
]


def opportunity_row(spotify_id="track-1"):
    values = {
        "opportunity_status": "verified",
        "spotify_id": spotify_id,
        "soundcharts_uuid": "song-uuid",
        "title": "Quiet Track",
        "credit_name": "Quiet Artist",
        "artists": [{"spotify_id": "artist-1", "soundcharts_uuid": "artist-uuid", "name": "Quiet Artist", "role": "main"}],
        "release_date": "2026-07-01",
        "primary_genre": "ambient",
        "subgenres": [],
        "genre_confidence": 0.9,
        "instrumental_status": "instrumental",
        "instrumental_confidence": 1,
        "ai_risk": "low",
        "ai_risk_score": 0,
        "rights_status": "self_released",
        "label": "Quiet Artist",
        "labels": [],
        "copyright": "2026 Quiet Artist",
        "distributor": "Independent",
        "editorial_placement_count": 2,
        "editorial_best_position": 20,
        "editorial_top_playlist": {"name": "Goodnight Mix", "spotify_id": "playlist-1"},
        "score": 20,
        "score_momentum": 0,
        "score_editorial": 7,
        "score_traction": 0,
        "score_recency": 12,
        "score_relationship": 0,
        "score_confidence": 0.8,
        "reason_codes": ["instrumental_verified", "self_released_confirmed"],
        "reasons": ["Instrumental confirmé.", "Self-release confirmé."],
    }
    return [values.get(name) for name in OPPORTUNITY_SCHEMA]


def seed_payload():
    return {
        "schemas": {"opportunities": copy.deepcopy(OPPORTUNITY_SCHEMA)},
        "opportunities": [opportunity_row()],
        "opportunity_scoring": {"version": "strict-test"},
    }


def current_payload():
    return {
        "generated_at": "2026-07-21T12:00:00Z",
        "schemas": {
            "tracks": [
                "spotify_id",
                "title",
                "streams",
                "delta",
                "source_date",
                "observed_at",
                "metadata_updated_at",
                "soundcharts_uuid",
                "previous_source_date",
            ]
        },
        "tracks": [["track-1", "Quiet Track", 135, 35, "2026-07-21", "2026-07-21T12:00:00Z", "2026-07-20T10:00:00Z", "song-uuid", "2026-07-20"]],
    }


def performance_payload(history=None):
    return {
        "generated_at": "2026-07-21T12:00:00Z",
        "tracks": {
            "track-1": {
                "history": history or [["2026-07-20", 100], ["2026-07-21", 135]],
                "observed_at": "2026-07-21T12:00:00Z",
            }
        },
    }


class OpportunitySyncTests(unittest.TestCase):
    def test_restores_reviewed_seed_and_refreshes_daily_metrics(self):
        current = current_payload()
        summary = subject.synchronize_opportunities(
            current,
            seed_payload(),
            performance_payload(),
            seed_name="strict-seed.js",
        )
        schema = current["schemas"]["opportunities"]
        row = current["opportunities"][0]
        self.assertTrue(summary["restored_from_seed"])
        self.assertEqual(summary["opportunities"], 1)
        self.assertEqual(summary["metrics_populated"], 1)
        self.assertEqual(summary["daily_deltas_populated"], 1)
        self.assertEqual(subject.field(row, schema, "streams"), 135)
        self.assertEqual(subject.field(row, schema, "streams_source_date"), "2026-07-21")
        self.assertEqual(subject.field(row, schema, "streams_delta_24h"), 35)
        self.assertEqual(subject.field(row, schema, "delta_previous_source_date"), "2026-07-20")
        self.assertEqual(subject.field(row, schema, "delta_window_hours"), 24)
        self.assertEqual(subject.field(row, schema, "editorial_top_playlist"), "Goodnight Mix")
        self.assertGreater(subject.field(row, schema, "score_momentum"), 0)
        self.assertGreater(subject.field(row, schema, "score_traction"), 0)
        self.assertEqual(current["opportunity_scoring"]["version"], "strict-test")
        self.assertIn("streams_24h_positive", subject.field(row, schema, "reason_codes"))
        self.assertIn("streams_observed", subject.field(row, schema, "reason_codes"))

    def test_existing_opportunity_identity_and_rights_are_preserved(self):
        current = current_payload()
        existing_seed = seed_payload()
        current["schemas"]["opportunities"] = copy.deepcopy(OPPORTUNITY_SCHEMA)
        current["opportunities"] = [opportunity_row()]
        schema = current["schemas"]["opportunities"]
        row = current["opportunities"][0]
        subject.set_field(row, schema, "rights_status", "independent_label")
        subject.set_field(row, schema, "credit_name", "Reviewed Identity")

        summary = subject.synchronize_opportunities(
            current,
            existing_seed,
            performance_payload(),
            seed_name="strict-seed.js",
        )
        self.assertFalse(summary["restored_from_seed"])
        self.assertEqual(subject.field(row, schema, "rights_status"), "independent_label")
        self.assertEqual(subject.field(row, schema, "credit_name"), "Reviewed Identity")

    def test_nonconsecutive_history_does_not_invent_a_24_hour_delta(self):
        current = current_payload()
        current["tracks"][0][3] = 35
        current["tracks"][0][8] = "2026-07-19"
        subject.synchronize_opportunities(
            current,
            seed_payload(),
            performance_payload([["2026-07-19", 100], ["2026-07-21", 135]]),
            seed_name="strict-seed.js",
        )
        schema = current["schemas"]["opportunities"]
        row = current["opportunities"][0]
        self.assertIsNone(subject.field(row, schema, "streams_delta_24h"))
        self.assertIsNone(subject.field(row, schema, "delta_previous_source_date"))
        self.assertIsNone(subject.field(row, schema, "delta_window_hours"))

    def test_missing_joinable_metric_is_rejected(self):
        current = current_payload()
        current["tracks"] = []
        with self.assertRaises(subject.OpportunitySyncError):
            subject.synchronize_opportunities(
                current,
                seed_payload(),
                {"tracks": {}},
                seed_name="strict-seed.js",
            )

    def test_js_payload_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.js"
            payload = {"opportunities": [["track-1"]]}
            subject.write_js_payload(path, payload, subject.SOUNDCHARTS_PREFIX)
            self.assertEqual(subject.read_js_payload(path, subject.SOUNDCHARTS_PREFIX), payload)


if __name__ == "__main__":
    unittest.main()
