import datetime as dt
from pathlib import Path
import tempfile
import unittest
import urllib.parse
from unittest.mock import patch

import refresh_soundcharts_daily as subject


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.paths = []

    def get(self, path):
        self.paths.append(path)
        return self.response


class RefreshSoundchartsTests(unittest.TestCase):
    def test_clean_credential_removes_copy_paste_wrappers(self):
        self.assertEqual(subject.clean_credential('  "client-value"\n'), 'client-value')

    def test_direct_api_headers_are_preferred(self):
        client = subject.SoundchartsClient('app', 'key')
        with patch.object(subject, 'request_json', return_value=({'ok': True}, {'x-quota-remaining': '3999999'})) as request:
            client.authenticate()
        self.assertEqual(client.auth_mode, 'api_headers')
        self.assertEqual(client.quota_remaining, 3999999)
        self.assertEqual(request.call_args.args[1]['x-app-id'], 'app')
        self.assertEqual(request.call_args.args[1]['x-api-key'], 'key')

    def test_artist_current_stats_parser_uses_streaming_spotify_value(self):
        response = {
            'object': {
                'popularity': [{'platform': 'spotify', 'value': 72, 'date': '2026-07-20'}],
                'streaming': [{'platform': 'spotify', 'value': 123456, 'date': '2026-07-21', 'evolution': 456}],
            }
        }
        metric = subject.extract_artist_spotify_metric(response)
        self.assertEqual(metric['value'], 123456)
        self.assertEqual(metric['date'], '2026-07-21')

    def test_song_audience_parser_selects_matching_spotify_identifier(self):
        response = {
            'object': {
                'items': [
                    {'date': '2026-07-20', 'plots': [{'identifier': 'other', 'value': 999}, {'identifier': 'track-1', 'value': 100}]},
                    {'date': '2026-07-21', 'plots': [{'identifier': 'track-1', 'value': 130}]},
                ]
            }
        }
        self.assertEqual(subject.extract_song_audience_points(response, 'track-1'), [['2026-07-20', 100], ['2026-07-21', 130]])

    def test_merge_history_deduplicates_and_keeps_new_value(self):
        merged = subject.merge_history(
            [['2026-07-19', 90], ['2026-07-20', 100]],
            [['2026-07-20', 101], ['2026-07-21', 130]],
        )
        self.assertEqual(merged, [['2026-07-19', 90], ['2026-07-20', 101], ['2026-07-21', 130]])

    def test_refresh_tracks_updates_export_and_browser_history(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id', 'title']},
            'tracks': [['song-uuid', 'track-1', 'Track']],
        }
        performance = {'tracks': {}, 'artists': {}, 'playlists': {}}
        response = {
            'items': [
                {'date': '2026-07-20', 'plots': [{'identifier': 'track-1', 'value': 100}]},
                {'date': '2026-07-21', 'plots': [{'identifier': 'track-1', 'value': 135}]},
            ]
        }
        outcome = subject.refresh_tracks(payload, performance, FakeClient(response), 1, 10, 95)
        schema = payload['schemas']['tracks']
        row = payload['tracks'][0]
        self.assertEqual(outcome.usable, 1)
        self.assertEqual(subject.field(row, schema, 'streams'), 135)
        self.assertEqual(subject.field(row, schema, 'delta'), 35)
        self.assertEqual(subject.field(row, schema, 'source_date'), '2026-07-21')
        self.assertEqual(performance['tracks']['track-1']['history'], [['2026-07-20', 100], ['2026-07-21', 135]])

    def test_http_success_without_metric_is_not_usable(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [['song-uuid', 'track-1']],
        }
        outcome = subject.refresh_tracks(payload, {'tracks': {}}, FakeClient({'items': []}), 1, 10, 95)
        self.assertEqual(outcome.requests, 1)
        self.assertEqual(outcome.usable, 0)
        self.assertFalse(outcome.items[0]['usable'])

    def test_track_history_request_never_exceeds_90_calendar_days(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [['song-uuid', 'track-1']],
        }
        response = {
            'items': [
                {'date': '2026-07-21', 'plots': [{'identifier': 'track-1', 'value': 1}]},
            ]
        }
        client = FakeClient(response)
        with patch.object(subject, 'utc_today', return_value=dt.date(2026, 7, 21)):
            subject.refresh_tracks(payload, {'tracks': {}}, client, 1, 10, 95)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(client.paths[0]).query)
        start = dt.date.fromisoformat(query['startDate'][0])
        end = dt.date.fromisoformat(query['endDate'][0])
        self.assertLessEqual((end - start).days, 89)

    def test_performance_payload_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'performance.js'
            original = {'source': 'soundcharts_daily', 'tracks': {'track-1': {'history': [['2026-07-21', 1]]}}}
            subject.write_js_payload(path, original, subject.PERFORMANCE_PREFIX)
            self.assertEqual(subject.read_performance_payload(path)['tracks'], original['tracks'])


if __name__ == '__main__':
    unittest.main()
