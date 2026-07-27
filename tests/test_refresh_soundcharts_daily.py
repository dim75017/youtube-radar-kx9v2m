import datetime as dt
from pathlib import Path
import tempfile
import unittest
import urllib.parse
from types import SimpleNamespace
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
        self.assertEqual(client._auth_generation, 1)
        self.assertEqual(client.quota_remaining, 3999999)
        self.assertEqual(request.call_args.args[1]['x-app-id'], 'app')
        self.assertEqual(request.call_args.args[1]['x-api-key'], 'key')

    def test_expired_oauth_is_renewed_once_and_data_request_is_replayed_with_quota_claim(self):
        client = subject.SoundchartsClient('app', 'key', request_limit=2)
        client.headers = {'Authorization': 'Bearer expired', 'Accept': 'application/json'}
        client.auth_mode = 'oauth_bearer'
        client._auth_generation = 7
        client.quota_remaining = 4_000_000
        data_headers = []

        def fake_request(url, headers, *, before_attempt=None, **_kwargs):
            if url == subject.API_BASE + '/data':
                before_attempt()
                data_headers.append(dict(headers))
                if headers.get('Authorization') == 'Bearer expired':
                    raise subject.SoundchartsHttpError(401)
                return {'ok': True}, {'x-quota-remaining': '3999989'}
            if url == subject.API_BASE + subject.AUTH_PROBE:
                if headers.get('x-app-id'):
                    raise subject.SoundchartsHttpError(401)
                return {'probe': True}, {'x-quota-remaining': '3999990'}
            if url == subject.TOKEN_URL:
                return {'access_token': 'fresh'}, {}
            raise AssertionError(f'unexpected URL: {url}')

        with patch.object(subject, 'request_json', side_effect=fake_request):
            self.assertEqual(client.get('/data'), {'ok': True})

        self.assertEqual(
            [headers.get('Authorization') for headers in data_headers],
            ['Bearer expired', 'Bearer fresh'],
        )
        self.assertEqual(client.requests_claimed, 2)
        self.assertEqual(client._auth_generation, 8)
        self.assertEqual(client.auth_mode, 'oauth_bearer')

    def test_http_403_is_not_reauthenticated_or_replayed(self):
        client = subject.SoundchartsClient('app', 'key', request_limit=2)
        client.headers = {'Authorization': 'Bearer current'}
        client._auth_generation = 1
        client.quota_remaining = 4_000_000

        def forbidden(_url, _headers, *, before_attempt=None, **_kwargs):
            before_attempt()
            raise subject.SoundchartsHttpError(403)

        with (
            patch.object(subject, 'request_json', side_effect=forbidden),
            patch.object(client, '_renew_after_unauthorized') as renew,
        ):
            with self.assertRaises(subject.SoundchartsHttpError) as raised:
                client.get('/forbidden')

        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(client.requests_claimed, 1)
        renew.assert_not_called()

    def test_concurrent_401_responses_trigger_a_single_oauth_renewal(self):
        client = subject.SoundchartsClient('app', 'key', request_limit=4)
        client.headers = {'Authorization': 'Bearer expired'}
        client.auth_mode = 'oauth_bearer'
        client._auth_generation = 3
        client.quota_remaining = 4_000_000
        expired_barrier = subject.threading.Barrier(2)

        def fake_request(url, headers, *, before_attempt=None, **_kwargs):
            before_attempt()
            if headers.get('Authorization') == 'Bearer expired':
                expired_barrier.wait(timeout=2)
                raise subject.SoundchartsHttpError(401)
            return {'path': url}, {}

        def fake_renew_locked():
            client.headers = {'Authorization': 'Bearer fresh'}
            client.auth_mode = 'oauth_bearer'
            client._auth_generation += 1

        with (
            patch.object(subject, 'request_json', side_effect=fake_request),
            patch.object(client, '_authenticate_locked', side_effect=fake_renew_locked) as renew,
        ):
            with subject.concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(client.get, ['/one', '/two']))

        self.assertEqual(len(results), 2)
        self.assertEqual(renew.call_count, 1)
        self.assertEqual(client._auth_generation, 4)
        self.assertEqual(client.requests_claimed, 4)

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

    def test_resource_level_http_statuses_are_non_blocking_unavailable_data(self):
        for status in (400, 404, 410, 422):
            with self.subTest(status=status):
                error = subject.urllib.error.HTTPError(
                    'https://example.invalid/song', status, 'unavailable', {}, None
                )
                with patch.object(subject.urllib.request, 'urlopen', side_effect=error):
                    with self.assertRaises(subject.SoundchartsDataUnavailableError) as raised:
                        subject.request_json('https://example.invalid/song', {}, retries=1)
                self.assertEqual(raised.exception.status, status)

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

    def test_focused_stream_refresh_keeps_the_last_playlist_collection_timestamp(self):
        outcome = subject.Outcome('tracks')
        outcome.usable = 1
        freshness = subject.merge_performance_freshness(
            {
                'playlists_at': '2026-07-24T19:00:45Z',
                'artists_at': '2026-07-24T18:52:28Z',
                'tracks_catalogue_at': '2026-07-23T17:00:00Z',
            },
            {'tracks_at': '2026-07-23T18:00:00Z'},
            {'tracks': outcome},
            '2026-07-24T19:01:00Z',
        )
        self.assertEqual(freshness['tracks_at'], '2026-07-24T19:01:00Z')
        self.assertEqual(freshness['playlists_at'], '2026-07-24T19:00:45Z')
        self.assertEqual(freshness['artists_at'], '2026-07-24T18:52:28Z')
        self.assertEqual(freshness['tracks_catalogue_at'], '2026-07-23T17:00:00Z')

    def test_complete_performance_selection_records_a_dedicated_real_timestamp(self):
        tracks = subject.Outcome('tracks')
        tracks.available = 26880
        tracks.selected = 26880
        tracks.usable = 26800
        tracks.unavailable = 80
        artists = subject.Outcome('artists')
        artists.available = 3348
        artists.selected = 3348
        artists.usable = 3330
        artists.unavailable = 18
        now = '2026-07-27T20:15:00Z'

        freshness = subject.merge_performance_freshness(
            {},
            {},
            {'tracks': tracks, 'artists': artists},
            now,
            include_performance_catalogue=True,
        )

        self.assertEqual(freshness['tracks_catalogue_at'], now)
        self.assertEqual(freshness['artists_catalogue_at'], now)

    def test_failed_complete_selection_does_not_advance_catalogue_freshness(self):
        tracks = subject.Outcome('tracks')
        tracks.available = 26880
        tracks.selected = 26880
        tracks.usable = 26799
        tracks.failures = 1

        freshness = subject.merge_performance_freshness(
            {'tracks_catalogue_at': '2026-07-26T20:15:00Z'},
            {},
            {'tracks': tracks},
            '2026-07-27T20:15:00Z',
            include_performance_catalogue=True,
        )

        self.assertEqual(freshness['tracks_catalogue_at'], '2026-07-26T20:15:00Z')

    def test_unavailable_resources_are_reported_separately_from_blocking_errors(self):
        class MixedClient:
            def get(self, path):
                if path.endswith('/unavailable'):
                    raise subject.SoundchartsDataUnavailableError(404)
                if path.endswith('/failed'):
                    raise subject.SoundchartsHttpError(503)
                return {'ok': True}

        tasks = [
            {'path': '/ok'},
            {'path': '/unavailable'},
            {'path': '/failed'},
        ]
        (
            results,
            requests,
            failures,
            unavailable,
            available,
            selected,
            failure_diagnostics,
            unavailable_diagnostics,
        ) = subject.parallel_collect(MixedClient(), tasks, workers=1, max_requests=10)

        self.assertEqual(len(results), 1)
        self.assertEqual((requests, failures, unavailable, available, selected), (3, 1, 1, 3, 3))
        self.assertEqual(
            failure_diagnostics,
            [{'type': 'SoundchartsHttpError', 'status': 503, 'count': 1}],
        )
        self.assertEqual(
            unavailable_diagnostics,
            [{'type': 'SoundchartsDataUnavailableError', 'status': 404, 'count': 1}],
        )

    def test_complete_catalogue_request_error_aborts_before_export_write(self):
        args = SimpleNamespace(
            mode='tracks',
            max_requests=10,
            workers=1,
            history_days=90,
            include_performance_catalogue=True,
            soundcharts=Path('unused-soundcharts.js'),
            performance=Path('unused-performance.js'),
            playlists=Path('unused-playlists.js'),
            history_dir=Path('unused-history'),
        )
        client = SimpleNamespace(
            auth_mode='api_headers',
            quota_remaining=4_000_000,
            authenticate=lambda: None,
            require_quota_reserve=lambda: None,
        )
        failed = subject.Outcome('tracks')
        failed.requests = failed.available = failed.selected = 2
        failed.usable = 1
        failed.failures = 1
        failed.failure_diagnostics = [
            {'type': 'SoundchartsHttpError', 'status': 503, 'count': 1}
        ]

        with (
            patch.object(subject, 'parse_args', return_value=args),
            patch.object(subject, 'SoundchartsClient', return_value=client),
            patch.object(subject, 'read_js_payload', return_value={}),
            patch.object(subject, 'read_performance_payload', return_value={'tracks': {}, 'artists': {}, 'playlists': {}}),
            patch.object(subject, 'refresh_tracks', return_value=failed),
            patch.object(subject, 'write_js_payload') as write_export,
        ):
            with self.assertRaisesRegex(subject.SoundchartsError, 'previous public exports were kept'):
                subject.main()

        write_export.assert_not_called()

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

    def test_full_track_refresh_updates_performance_only_uuid_without_promoting_it(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id', 'title']},
            'tracks': [['strict-uuid', 'strict-track', 'Strict Track']],
        }
        performance = {
            'tracks': {
                'strict-track': {'soundcharts_uuid': 'strict-uuid', 'history': []},
                'history-track': {
                    'soundcharts_uuid': 'history-only-uuid',
                    'history': [['2026-07-19', 190]],
                },
            },
            'artists': {},
            'playlists': {},
        }
        response = {
            'items': [
                {
                    'date': '2026-07-20',
                    'plots': [
                        {'identifier': 'strict-track', 'value': 100},
                        {'identifier': 'history-track', 'value': 200},
                    ],
                },
                {
                    'date': '2026-07-21',
                    'plots': [
                        {'identifier': 'strict-track', 'value': 135},
                        {'identifier': 'history-track', 'value': 240},
                    ],
                },
            ]
        }
        client = FakeClient(response)

        outcome = subject.refresh_tracks(
            payload,
            performance,
            client,
            1,
            10,
            95,
            include_performance_catalogue=True,
        )

        self.assertEqual(outcome.usable, 2)
        self.assertEqual(len(payload['tracks']), 1)
        self.assertNotIn(
            'history-only-uuid',
            [subject.field(row, payload['schemas']['tracks'], 'soundcharts_uuid') for row in payload['tracks']],
        )
        self.assertEqual(
            performance['tracks']['history-track']['history'],
            [['2026-07-19', 190], ['2026-07-20', 200], ['2026-07-21', 240]],
        )
        self.assertTrue(any(item.get('performance_only') for item in outcome.items))
        self.assertIn('/api/v2/song/strict-uuid/audience/spotify?', client.paths[0])
        self.assertIn('/api/v2/song/history-only-uuid/audience/spotify?', client.paths[1])

    def test_full_track_refresh_prioritizes_strict_rows_before_performance_only_history(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [['strict-uuid', 'strict-track']],
        }
        performance = {
            'tracks': {
                'history-track': {
                    'soundcharts_uuid': 'history-only-uuid',
                    'history': [['2026-07-19', 190]],
                },
            }
        }
        response = {
            'items': [
                {'date': '2026-07-21', 'plots': [{'identifier': 'strict-track', 'value': 135}]},
            ]
        }
        client = FakeClient(response)

        outcome = subject.refresh_tracks(
            payload,
            performance,
            client,
            1,
            1,
            95,
            include_performance_catalogue=True,
        )

        self.assertEqual(outcome.requests, 1)
        self.assertIn('/api/v2/song/strict-uuid/audience/spotify?', client.paths[0])
        self.assertEqual(
            performance['tracks']['history-track']['history'],
            [['2026-07-19', 190]],
        )

    def test_full_track_refresh_keeps_spotify_aliases_that_share_a_soundcharts_uuid(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [],
        }
        performance = {
            'tracks': {
                'alias-a': {'soundcharts_uuid': 'shared-uuid', 'history': []},
                'alias-b': {'soundcharts_uuid': 'shared-uuid', 'history': []},
            }
        }
        response = {
            'items': [
                {
                    'date': '2026-07-27',
                    'plots': [
                        {'identifier': 'alias-a', 'value': 110},
                        {'identifier': 'alias-b', 'value': 220},
                    ],
                },
            ]
        }
        client = FakeClient(response)

        outcome = subject.refresh_tracks(
            payload,
            performance,
            client,
            1,
            10,
            95,
            include_performance_catalogue=True,
        )

        self.assertEqual(outcome.available, 2)
        self.assertEqual(outcome.selected, 2)
        self.assertEqual(outcome.requests, 1)
        self.assertEqual(outcome.usable, 2)
        self.assertEqual(len(client.paths), 1)
        self.assertEqual(performance['tracks']['alias-a']['history'], [['2026-07-27', 110]])
        self.assertEqual(performance['tracks']['alias-b']['history'], [['2026-07-27', 220]])

    def test_strict_spotify_id_wins_over_stale_performance_uuid(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [['approved-uuid', 'same-spotify-id']],
        }
        performance = {
            'tracks': {
                'same-spotify-id': {
                    'soundcharts_uuid': 'stale-uuid',
                    'history': [['2026-07-20', 100]],
                },
            }
        }
        response = {
            'items': [
                {
                    'date': '2026-07-21',
                    'plots': [{'identifier': 'same-spotify-id', 'value': 135}],
                },
            ]
        }
        client = FakeClient(response)

        outcome = subject.refresh_tracks(
            payload,
            performance,
            client,
            1,
            10,
            95,
            include_performance_catalogue=True,
        )

        self.assertEqual((outcome.available, outcome.selected, outcome.requests, outcome.usable), (1, 1, 1, 1))
        self.assertEqual(len(client.paths), 1)
        self.assertIn('/api/v2/song/approved-uuid/audience/spotify?', client.paths[0])
        self.assertNotIn('stale-uuid', client.paths[0])
        self.assertEqual(performance['tracks']['same-spotify-id']['soundcharts_uuid'], 'approved-uuid')
        self.assertEqual(
            performance['tracks']['same-spotify-id']['history'],
            [['2026-07-20', 100], ['2026-07-21', 135]],
        )

    def test_full_artist_refresh_updates_performance_only_uuid_without_promoting_it(self):
        payload = {
            'schemas': {'artists': ['soundcharts_uuid', 'spotify_id', 'name']},
            'artists': [['strict-artist-uuid', 'strict-artist', 'Strict Artist']],
        }
        performance = {
            'tracks': {},
            'artists': {
                'strict-artist': {'soundcharts_uuid': 'strict-artist-uuid', 'history': []},
                'history-artist': {
                    'soundcharts_uuid': 'history-only-artist-uuid',
                    'history': [['2026-07-20', 90]],
                },
            },
            'playlists': {},
        }
        response = {
            'object': {
                'streaming': [
                    {'platform': 'spotify', 'value': 125, 'date': '2026-07-21'}
                ]
            }
        }
        client = FakeClient(response)

        outcome = subject.refresh_artists(
            payload,
            performance,
            client,
            1,
            10,
            include_performance_catalogue=True,
        )

        self.assertEqual(outcome.usable, 2)
        self.assertEqual(len(payload['artists']), 1)
        self.assertNotIn(
            'history-only-artist-uuid',
            [subject.field(row, payload['schemas']['artists'], 'soundcharts_uuid') for row in payload['artists']],
        )
        self.assertEqual(
            performance['artists']['history-artist']['history'],
            [['2026-07-20', 90], ['2026-07-21', 125]],
        )
        self.assertTrue(any(item.get('performance_only') for item in outcome.items))
        self.assertEqual(
            client.paths,
            [
                '/api/v2/artist/strict-artist-uuid/current/stats',
                '/api/v2/artist/history-only-artist-uuid/current/stats',
            ],
        )

    def test_refresh_playlists_preserves_the_soundcharts_cover_url(self):
        playlists = {
            'cols': ['id', 'followers'],
            'rows': [['playlist-1', 100]],
        }
        response = {'object': {'latestSubscriberCount': 125, 'imageUrl': 'https://assets.test/playlist.jpg'}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'playlists.js'
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            client = FakeClient(response)
            outcome = subject.refresh_playlists(path, {'playlists': {}}, client, 1, 10)
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)
        self.assertEqual(outcome.usable, 1)
        self.assertEqual(client.paths, ['/api/v2.8/playlist/by-platform/spotify/playlist-1'])
        self.assertEqual(subject.field(refreshed['rows'][0], refreshed['cols'], 'image_url'), 'https://assets.test/playlist.jpg')

    def test_refresh_playlists_merges_discovery_baseline_into_daily_history(self):
        playlists = {
            'cols': ['id', 'followers', 'last_seen'],
            'rows': [['playlist-1', 100, '2026-07-17']],
            'hist': {'playlist-1': [['2026-07-17', 100]]},
        }
        performance = {'playlists': {'playlist-1': {'history': [['2026-07-23', 120]]}}}
        response = {'object': {'latestSubscriberCount': 125}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'playlists.js'
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            outcome = subject.refresh_playlists(path, performance, FakeClient(response), 1, 10)
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)
        expected = [['2026-07-17', 100], ['2026-07-23', 120], [subject.utc_today().isoformat(), 125]]
        self.assertEqual(performance['playlists']['playlist-1']['history'], expected)
        self.assertEqual(refreshed['hist']['playlist-1'], expected)
        self.assertEqual(subject.field(refreshed['rows'][0], refreshed['cols'], 'last_seen'), subject.utc_today().isoformat())
        self.assertEqual(refreshed['meta']['history_points_added_this_run'], 1)
        self.assertEqual(outcome.usable, 1)

    def test_refresh_playlists_prioritizes_the_dashboard_visible_subset(self):
        playlists = {
            'cols': ['id', 'followers', 'big10k'],
            'rows': [['backlog', 10, 0], ['visible', 100, 1]],
        }
        response = {'object': {'latestSubscriberCount': 125}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'playlists.js'
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            client = FakeClient(response)
            outcome = subject.refresh_playlists(path, {'playlists': {}}, client, 1, 1)
        self.assertEqual(outcome.usable, 1)
        self.assertEqual(client.paths, ['/api/v2.8/playlist/by-platform/spotify/visible'])

    def test_refresh_playlists_accepts_a_cover_when_followers_are_not_available(self):
        playlists = {'cols': ['id', 'followers'], 'rows': [['playlist-1', 100]]}
        response = {'object': {'imageUrl': 'https://assets.test/playlist.jpg'}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'playlists.js'
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            outcome = subject.refresh_playlists(path, {'playlists': {}}, FakeClient(response), 1, 10)
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)
        self.assertEqual(outcome.usable, 1)
        self.assertEqual(subject.field(refreshed['rows'][0], refreshed['cols'], 'followers'), 100)
        self.assertEqual(subject.field(refreshed['rows'][0], refreshed['cols'], 'image_url'), 'https://assets.test/playlist.jpg')

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
        self.assertIn('performance_artist_data_cap="15000"', workflow)
        self.assertIn('performance_track_data_cap="60000"', workflow)
        self.assertIn('playlist_data_cap="3000"', workflow)
        self.assertIn('independent_playlist_data_cap="2500"', workflow)
        self.assertIn('expansion_data_cap="6000"', workflow)
        self.assertIn('classification_data_cap="8230"', workflow)
        self.assertIn('10#$REQUESTED_MAX_REQUESTS > request_cap', workflow)
        self.assertIn('expansion_limit="2500"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.artist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.performance_artist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.performance_track_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.playlist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.independent_playlist_requests }}"', workflow)
        self.assertIn('--playlist-scope independent', workflow)
        self.assertIn("steps.plan.outputs.scope == 'playlist_covers'", workflow)
        self.assertIn('--mode playlists', workflow)
        self.assertIn('--classification-only', workflow)
        self.assertEqual(workflow.count('--include-performance-catalogue'), 2)
        self.assertIn('performance_catalogue_due', workflow)
        self.assertIn("is_due('tracks_catalogue_at')", workflow)
        self.assertIn("is_due('artists_catalogue_at')", workflow)
        self.assertIn('dt.timedelta(hours=24)', workflow)
        self.assertIn('python discover_soundcharts_playlists.py', workflow)
        self.assertGreaterEqual(workflow.count('--workers 10'), 3)
        self.assertIn("default: 'strict_rebaseline'", workflow)
        self.assertIn("options: [strict_rebaseline, full_sync, dark_ambient, dark_ambient_catalogues, explicit_artists, classification, artists, playlist_covers, smoke]", workflow)
        self.assertIn("Discover every Dark Ambient playlist and their artist catalogues", workflow)
        self.assertIn("--playlist-scope dark_ambient", workflow)
        self.assertIn("Scan explicitly requested Spotify artists and their tracks", workflow)
        self.assertIn("--artist-seeds spotify-explicit-artist-seeds.json", workflow)
        self.assertIn("--summary-key explicit_artist_discovery", workflow)
        self.assertNotIn('legacy_full', workflow)
        self.assertIn(
            "if: github.event_name == 'workflow_dispatch' && steps.plan.outputs.scope == 'smoke'",
            workflow,
        )
        self.assertIn("if: steps.plan.outputs.publish == 'true'", workflow)
        self.assertNotIn("scope == 'legacy_full' || steps.plan.outputs.scope == 'smoke'", workflow)


if __name__ == '__main__':
    unittest.main()
