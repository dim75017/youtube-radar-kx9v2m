import unittest

from soundcharts_fal_artist_gate import (
    BLOCKED,
    ELIGIBLE,
    REVIEW,
    decide_artist_gate,
    parse_artist_gate_response,
)


class SoundchartsFalArtistGateTests(unittest.TestCase):
    def test_parses_official_artist_shape_and_root_subgenres(self):
        evidence = parse_artist_gate_response(
            {
                "type": "artist",
                "object": {
                    "name": "  Night   Field  ",
                    "careerStage": "mid_level",
                    "genres": [
                        {"root": "Electronic", "sub": ["Ambient", "Dark Ambient"]},
                        {"root": "Electronic", "sub": ["dark ambient"]},
                    ],
                },
            }
        )

        self.assertEqual(evidence["name"], "Night Field")
        self.assertEqual(evidence["careerStage"], "mid_level")
        self.assertEqual(evidence["genres"]["root"], ["Electronic"])
        self.assertEqual(evidence["genres"]["sub"], ["Ambient", "Dark Ambient"])

    def test_parses_documented_string_genres_and_sidecar_subgenres(self):
        evidence = parse_artist_gate_response(
            {
                "object": {
                    "name": "Keys",
                    "genres": ["Classical", "Piano"],
                    "subGenres": ["Neo-Classical"],
                }
            }
        )

        self.assertEqual(evidence["genres"]["root"], ["Classical", "Piano"])
        self.assertEqual(evidence["genres"]["sub"], ["Neo-Classical"])
        self.assertEqual(decide_artist_gate(evidence), (ELIGIBLE, "target_genre_evidence"))

    def test_accepts_already_grouped_root_and_subgenre_arrays(self):
        evidence = parse_artist_gate_response(
            {
                "data": {
                    "name": "Still Water",
                    "genres": {"root": ["Electronic", "Ambient"], "sub": ["Dark Ambient"]},
                }
            }
        )

        self.assertEqual(evidence["genres"]["root"], ["Electronic", "Ambient"])
        self.assertEqual(evidence["genres"]["sub"], ["Dark Ambient"])
        self.assertEqual(decide_artist_gate(evidence), (ELIGIBLE, "target_genre_evidence"))

    def test_superstar_is_judged_by_genre_not_audience_size(self):
        target = parse_artist_gate_response(
            {"object": {"name": "Large Artist", "careerStage": "Superstar", "genres": ["Ambient"]}}
        )
        unknown = parse_artist_gate_response(
            {"object": {"name": "Large Unknown", "careerStage": "Superstar"}}
        )

        self.assertEqual(decide_artist_gate(target), (ELIGIBLE, "target_genre_evidence"))
        self.assertEqual(decide_artist_gate(unknown), (REVIEW, "genre_unknown"))

    def test_vocal_and_out_of_scope_evidence_are_blocked(self):
        vocal = parse_artist_gate_response(
            {"object": {"name": "Singer", "genres": [{"root": "Jazz", "sub": ["Vocal Jazz"]}]}}
        )
        out_of_scope = parse_artist_gate_response(
            {"object": {"name": "Band", "genres": ["Ambient Pop"]}}
        )

        self.assertEqual(decide_artist_gate(vocal), (BLOCKED, "vocal_genre_evidence"))
        self.assertEqual(
            decide_artist_gate(out_of_scope),
            (BLOCKED, "out_of_scope_genre_evidence"),
        )

    def test_unknown_and_unclassified_genres_stay_in_review(self):
        empty = parse_artist_gate_response({"object": {"name": "Unknown"}})
        unclassified = parse_artist_gate_response(
            {"object": {"name": "Unknown style", "genres": ["Electronic"]}}
        )

        self.assertEqual(decide_artist_gate(empty), (REVIEW, "genre_unknown"))
        self.assertEqual(decide_artist_gate(unclassified), (REVIEW, "genre_unclassified"))

    def test_ai_fields_are_ignored_and_never_inferred(self):
        evidence = parse_artist_gate_response(
            {
                "object": {
                    "name": "Quiet",
                    "genres": ["Ambient"],
                    "aiRisk": "low",
                    "isAiGenerated": False,
                }
            }
        )

        self.assertNotIn("ai_risk", evidence)
        self.assertNotIn("aiRisk", evidence)
        self.assertNotIn("instrumental", evidence)
        self.assertEqual(decide_artist_gate(evidence), (ELIGIBLE, "target_genre_evidence"))

    def test_malformed_payload_fails_closed_to_review(self):
        evidence = parse_artist_gate_response(None)
        self.assertEqual(
            evidence,
            {"name": "", "careerStage": "", "genres": {"root": [], "sub": []}},
        )
        self.assertEqual(decide_artist_gate(evidence), (REVIEW, "genre_unknown"))


if __name__ == "__main__":
    unittest.main()
