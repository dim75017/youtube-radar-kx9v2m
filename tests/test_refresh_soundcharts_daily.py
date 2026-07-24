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

    def test_each_http_attempt_is_counted_before_retrying(self):
        class FakeResponse:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{}'

        claims = []
        with patch.object(
            subject.urllib.request,
            'urlopen',
            side_effect=[subject.urllib.error.URLError('temporary'), FakeResponse()],
        ), patch.object(subject.time, 'sleep'):
            subject.request_json(
                'https://example.invalid/test',
                {},
                retries=2,
                before_attempt=lambda: claims.append(True),
            )
        self.assertEqual(len(claims), 2)

    def test_client_stops_before_consuming_server_quota_reserve(self):
        client = subject.SoundchartsClient('app', 'key')
        client.headers = {'x-app-id': 'app', 'x-api-key': 'key'}
        client.quota_remaining = subject.MIN_SERVER_QUOTA_RESERVE + 1
        attempts = []

        def fake_request(_url, _headers, *, before_attempt=None, **_kwargs):
            before_attempt()
            attempts.append(True)
            return {'ok': True}, {'x-quota-remaining': str(subject.MIN_SERVER_QUOTA_RESERVE)}

        with patch.object(subject, 'request_json', side_effect=fake_request):
            self.assertEqual(client.get('/first'), {'ok': True})
            with self.assertRaises(subject.SoundchartsQuotaReserveError):
                client.get('/blocked')

        self.assertEqual(len(attempts), 1)
        self.assertEqual(client.quota_remaining, subject.MIN_SERVER_QUOTA_RESERVE)

    def test_collection_is_blocked_when_server_quota_header_is_missing(self):
        client = subject.SoundchartsClient('app', 'key')
        with self.assertRaises(subject.SoundchartsQuotaReserveError):
            client.require_quota_reserve()

    def test_client_request_limit_counts_real_attempts(self):
        client = subject.SoundchartsClient('app', 'key', request_limit=1)
        client.headers = {'x-app-id': 'app', 'x-api-key': 'key'}
        client.quota_remaining = 4_000_000
        attempts = []

        def fake_request(_url, _headers, *, before_attempt=None, **_kwargs):
            before_attempt()
            attempts.append(True)
            return {'ok': True}, {}

        with patch.object(subject, 'request_json', side_effect=fake_request):
            client.get('/first')
            with self.assertRaises(subject.SoundchartsRequestLimitError):
                client.get('/blocked')

        self.assertEqual(len(attempts), 1)
        self.assertEqual(client.requests_claimed, 1)

    def test_parallel_collection_cannot_overshoot_quota_reserve(self):
        client = subject.SoundchartsClient('app', 'key')
        client.headers = {'x-app-id': 'app', 'x-api-key': 'key'}
        client.quota_remaining = subject.MIN_SERVER_QUOTA_RESERVE + 3
        attempts = []

        def fake_request(_url, _headers, *, before_attempt=None, **_kwargs):
            before_attempt()
            attempts.append(True)
            return {'ok': True}, {}

        tasks = [{'path': f'/item/{index}'} for index in range(20)]
        with patch.object(subject, 'request_json', side_effect=fake_request):
            with self.assertRaises(subject.SoundchartsQuotaReserveError):
                subject.parallel_collect(client, tasks, workers=10, max_requests=20)

        self.assertEqual(len(attempts), 3)
        self.assertEqual(client.quota_remaining, subject.MIN_SERVER_QUOTA_RESERVE)

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

    def test_workflow_push_and_pull_request_use_non_publishing_smoke(self):
        workflow = (Path(__file__).parents[1] / '.github' / 'workflows' / 'refresh-soundcharts.yml').read_text(
            encoding='utf-8'
        )
        self.assertIn('github.event_name }}" == "pull_request" || "${{ github.event_name }}" == "push"', workflow)
        self.assertIn('scope="ci_smoke"', workflow)
        self.assertIn('expansion_requests="0"', workflow)
        self.assertIn("&& 'ci' || 'collection'", workflow)
        self.assertIn("default: '6000'", workflow)
        self.assertIn('artist_data_cap="350"', workflow)
        self.assertIn('playlist_data_cap="1400"', workflow)
        self.assertIn('independent_playlist_data_cap="2500"', workflow)
        self.assertIn('expansion_data_cap="6000"', workflow)
        self.assertIn('classification_data_cap="8230"', workflow)
        self.assertIn('10#$REQUESTED_MAX_REQUESTS > request_cap', workflow)
        self.assertIn('expansion_limit="2500"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.artist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.playlist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.independent_playlist_requests }}"', workflow)
        self.assertIn('--playlist-scope independent', workflow)
        self.assertIn('--classification-only', workflow)
        self.assertIn('python discover_soundcharts_playlists.py', workflow)
        self.assertGreaterEqual(workflow.count('--workers 10'), 3)
        self.assertIn("default: 'strict_rebaseline'", workflow)
        self.assertIn("options: [strict_rebaseline, classification, artists, smoke]", workflow)
        self.assertNotIn('legacy_full', workflow)
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch' && steps.plan.outputs.scope == 'smoke'",
            workflow,
        )
        self.assertIn("if: steps.plan.outputs.publish == 'true'", workflow)
        self.assertNotIn("scope == 'legacy_full' || steps.plan.outputs.scope == 'smoke'", workflow)


if __name__ == '__main__':
    unittest.main()
