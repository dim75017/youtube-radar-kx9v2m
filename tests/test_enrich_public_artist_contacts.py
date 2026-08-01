import json
import tempfile
import unittest
from pathlib import Path

import enrich_public_artist_contacts as subject


class PublicArtistContactEnrichmentTests(unittest.TestCase):
    def test_only_keeps_explicit_business_email(self):
        page = '<p>Personal: jane@example.org</p><p>For booking: booking@artist.test</p>'
        self.assertEqual(subject.business_emails(page), ['booking@artist.test'])

    def test_enrichment_is_limited_to_strict_verified_artist(self):
        artist_schema = ['soundcharts_uuid', 'name', 'contact_url', 'public_contacts']
        opportunity_schema = ['opportunity_status', 'instrumental_status', 'ai_risk', 'rights_status', 'artists']
        payload = {
            'schemas': {'artists': artist_schema, 'opportunities': opportunity_schema},
            'artists': [['artist-1', 'Quiet Artist', 'https://artist.test/contact', []]],
            'opportunities': [['verified', 'instrumental', 'low', 'self_released', [{'soundcharts_uuid': 'artist-1'}]]],
        }
        old_fetch = subject.fetch_html
        subject.fetch_html = lambda url: '<a href="mailto:contact@artist.test">Business contact</a>'
        try:
            summary = subject.enrich(payload, {'artists': {}}, 10, 4)
        finally:
            subject.fetch_html = old_fetch
        self.assertEqual(summary, {'artists_checked': 1, 'emails_found': 1})
        schema = payload['schemas']['artists']
        row = payload['artists'][0]
        self.assertEqual(row[schema.index('email')], 'contact@artist.test')
        self.assertEqual(row[schema.index('contact_research')]['result'], 'email_found')

    def test_non_verified_artist_is_never_fetched(self):
        artist_schema = ['soundcharts_uuid', 'spotify_id', 'contact_url', 'public_contacts']
        opportunity_schema = ['opportunity_status', 'instrumental_status', 'ai_risk', 'rights_status', 'artists']
        payload = {
            'schemas': {'artists': artist_schema, 'opportunities': opportunity_schema},
            'artists': [['artist-1', 'spotify-1', 'https://artist.test/contact', []]],
            'opportunities': [['needs_listen', 'instrumental', 'low', 'self_released', [{'soundcharts_uuid': 'artist-1'}]]],
        }
        self.assertEqual(subject.enrich(payload, {'artists': {}}, 10, 4), {'artists_checked': 0, 'emails_found': 0})

    def test_selected_artist_is_prioritised_without_weakening_automatic_eligibility(self):
        artist_schema = ['soundcharts_uuid', 'spotify_id', 'contact_url', 'public_contacts']
        opportunity_schema = ['opportunity_status', 'instrumental_status', 'ai_risk', 'rights_status', 'artists']
        payload = {
            'schemas': {'artists': artist_schema, 'opportunities': opportunity_schema},
            'artists': [['artist-1', 'spotify-1', 'https://artist.test/contact', []]],
            'opportunities': [['needs_listen', 'unknown', 'unknown', 'unknown', [{'soundcharts_uuid': 'artist-1'}]]],
        }
        old_fetch = subject.fetch_html
        subject.fetch_html = lambda url: '<a href="mailto:booking@artist.test">Booking</a>'
        try:
            summary = subject.enrich(payload, {'artists': {}}, 10, 4, {'spotify-1'})
        finally:
            subject.fetch_html = old_fetch
        self.assertEqual(summary, {'artists_checked': 1, 'emails_found': 1})
        row = payload['artists'][0]
        self.assertEqual(row[payload['schemas']['artists'].index('email')], 'booking@artist.test')

    def test_strict_catalogue_candidate_is_scanned_before_opportunity_promotion(self):
        artist_schema = ['soundcharts_uuid', 'spotify_id', 'contact_url', 'public_contacts']
        track_schema = [
            'instrumental_status', 'instrumental_confidence', 'ai_risk',
            'rights_status', 'primary_genre', 'genre_confidence', 'artists',
        ]
        payload = {
            'schemas': {'artists': artist_schema, 'tracks': track_schema, 'opportunities': []},
            'artists': [['artist-1', 'spotify-1', 'https://artist.test/contact', []]],
            'tracks': [[
                'instrumental', 0.9, 'low', 'self_released', 'ambient', 0.9,
                [{'soundcharts_uuid': 'artist-1', 'role': 'main'}],
            ]],
            'opportunities': [],
        }
        old_fetch = subject.fetch_html
        subject.fetch_html = lambda url: '<a href="mailto:booking@artist.test">Booking</a>'
        try:
            summary = subject.enrich(payload, {'artists': {}}, 10, 4)
        finally:
            subject.fetch_html = old_fetch
        self.assertEqual(summary, {'artists_checked': 1, 'emails_found': 1})
        row = payload['artists'][0]
        self.assertEqual(row[payload['schemas']['artists'].index('email')], 'booking@artist.test')

    def test_selected_seed_uses_soundcharts_uuid_when_snapshot_has_no_spotify_id(self):
        artist_schema = ['soundcharts_uuid', 'contact_url', 'public_contacts', 'contact_research']
        payload = {
            'schemas': {'artists': artist_schema, 'opportunities': []},
            'artists': [['artist-1', '', [], None]],
            'opportunities': [],
        }
        summary = subject.enrich(payload, {'artists': {}}, 10, 4, set(), {'artist-1'})
        self.assertEqual(summary, {'artists_checked': 1, 'emails_found': 0})
        research = payload['artists'][0][artist_schema.index('contact_research')]
        self.assertEqual(research['result'], 'no_known_public_profile')

    def test_selected_artist_is_rechecked_but_non_selected_research_is_cached(self):
        artist_schema = ['soundcharts_uuid', 'spotify_id', 'contact_url', 'public_contacts', 'contact_research']
        payload = {
            'schemas': {'artists': artist_schema, 'opportunities': []},
            'artists': [
                ['selected', 'spotify-selected', 'https://selected.test', [], {'checked_at': '2026-07-27T00:00:00Z'}],
                ['other', 'spotify-other', 'https://other.test', [], {'checked_at': '2026-07-27T00:00:00Z'}],
            ],
            'opportunities': [],
        }
        visited = []
        old_fetch = subject.fetch_html
        subject.fetch_html = lambda url: visited.append(url) or ''
        try:
            summary = subject.enrich(payload, {'artists': {}}, 10, 4, {'spotify-selected'}, set())
        finally:
            subject.fetch_html = old_fetch
        self.assertEqual(summary, {'artists_checked': 1, 'emails_found': 0})
        self.assertEqual(visited, ['https://selected.test'])

    def test_selection_seed_file_reads_both_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'seeds.json'
            path.write_text(json.dumps({'artists': [{'spotify_id': 'spotify-1', 'soundcharts_uuid': 'uuid-1'}]}), encoding='utf-8')
            self.assertEqual(subject.selected_artist_ids(path), ({'spotify-1'}, {'uuid-1'}))


if __name__ == '__main__':
    unittest.main()
