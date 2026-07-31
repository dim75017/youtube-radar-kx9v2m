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

    def test_preflight_budget_respects_local_cap_and_server_reserve(self):
        client = subject.SoundchartsClient('app', 'key', request_limit=100)
        client.quota_remaining = subject.MIN_SERVER_QUOTA_RESERVE + 80
        self.assertEqual(client.available_request_budget(200), 80)
        client.requests_claimed = 35
        self.assertEqual(client.available_request_budget(200), 65)

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

    def test_successful_adaptive_partial_pass_advances_daily_maintenance_timestamp(self):
        tracks = subject.Outcome('tracks')
        tracks.available = 100_000
        tracks.selected = 60_000
        tracks.usable = 59_900
        tracks.policy = {'selection_mode': 'adaptive_daily'}
        now = '2026-07-29T20:15:00Z'

        freshness = subject.merge_performance_freshness(
            {'tracks_catalogue_at': '2026-07-28T20:15:00Z'},
            {},
            {'tracks': tracks},
            now,
            include_performance_catalogue=True,
        )

        self.assertEqual(freshness['tracks_catalogue_at'], now)

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


    def test_full_track_refresh_enrols_source_backed_discovery_candidate(self):
        payload = {
            'schemas': {'tracks': ['soundcharts_uuid', 'spotify_id']},
            'tracks': [],
            'discovery_catalogue': {
                'track_schema': ['soundcharts_uuid', 'spotify_id'],
                'tracks': [['waiting-uuid', 'waiting-track']],
            },
        }
        performance = {'tracks': {}, 'artists': {}, 'playlists': {}}
        response = {
            'items': [
                {
                    'date': '2026-08-01',
                    'plots': [{'identifier': 'waiting-track', 'value': 99_900}],
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

        self.assertEqual((outcome.available, outcome.usable), (1, 1))
        self.assertEqual(payload['tracks'], [])
        self.assertEqual(
            performance['tracks']['waiting-track']['history'],
            [['2026-08-01', 99_900]],
        )
        self.assertTrue(outcome.items[0]['performance_only'])
        self.assertIn('/api/v2/song/waiting-uuid/audience/spotify?', client.paths[0])

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
        self.assertEqual(
            outcome.coverage(),
            {
                'expected': 2,
                'scanned': 1,
                'usable': 1,
                'missing': 1,
                'not_scanned': 1,
                'scanned_without_usable_data': 0,
            },
        )
        self.assertEqual(outcome.policy['selection_mode'], 'adaptive_daily')

    def test_track_plan_prioritizes_server_selection_opportunities_recent_and_new(self):
        today = dt.date(2026, 7, 29)
        tasks = [
            {
                'uuid': f'uuid-{index}',
                'targets': [{'spotify_id': f'track-{index}', 'row': None}],
            }
            for index in range(6)
        ]
        store = {
            f'track-{index}': {
                'history': [
                    ['2026-07-15', 100 + index],
                    ['2026-07-22', 200 + index],
                    ['2026-07-29', 350 + index],
                ],
                'observed_at': '2026-07-29T00:00:00Z',
            }
            for index in range(6)
        }
        store['track-3']['history'] = [['2026-07-29', 100]]
        metadata = {
            'track-0': {
                'artist_spotify_ids': {'selected-artist'},
                'artist_soundcharts_uuids': set(),
            },
            'track-1': {
                'artist_spotify_ids': set(),
                'artist_soundcharts_uuids': set(),
                'opportunity': True,
            },
            'track-2': {
                'artist_spotify_ids': set(),
                'artist_soundcharts_uuids': set(),
                'release_date': dt.date(2026, 7, 20),
            },
        }

        selected, policy = subject.plan_track_maintenance(
            tasks,
            store,
            metadata,
            4,
            today=today,
            priority_artist_ids={'selected-artist'},
        )

        self.assertEqual({task['uuid'] for task in selected}, {'uuid-0', 'uuid-1', 'uuid-2', 'uuid-3'})
        self.assertEqual(policy['selected_requests'], 4)
        self.assertEqual(policy['missing_requests'], 2)
        self.assertEqual(policy['reason_coverage']['selection_or_negotiation']['missing_requests'], 0)
        self.assertEqual(policy['reason_coverage']['opportunity']['missing_requests'], 0)
        self.assertEqual(policy['reason_coverage']['release_90d']['missing_requests'], 0)
        self.assertEqual(policy['reason_coverage']['needs_two_true_points']['missing_requests'], 0)


    def test_track_plan_prioritizes_candidates_approaching_public_threshold(self):
        today = dt.date(2026, 8, 1)
        tasks = [
            {'uuid': 'near-uuid', 'targets': [{'spotify_id': 'near-track', 'row': None}]},
            {'uuid': 'far-uuid', 'targets': [{'spotify_id': 'far-track', 'row': None}]},
        ]
        store = {
            'near-track': {
                'history': [['2026-07-25', 98_500], ['2026-08-01', 99_000]],
                'observed_at': '2026-08-01T00:00:00Z',
            },
            'far-track': {
                'history': [['2026-07-25', 49_500], ['2026-08-01', 50_000]],
                'observed_at': '2026-08-01T00:00:00Z',
            },
        }

        selected, policy = subject.plan_track_maintenance(
            tasks,
            store,
            {},
            1,
            today=today,
        )

        self.assertEqual([task['uuid'] for task in selected], ['near-uuid'])
        self.assertEqual(
            policy['reason_coverage']['threshold_promotion_watch']['selected_requests'],
            1,
        )

    def test_track_rotation_bucket_is_stable_and_bounded(self):
        first = subject.stable_rotation_bucket('spotify-track-id')
        self.assertEqual(first, subject.stable_rotation_bucket('spotify-track-id'))
        self.assertGreaterEqual(first, 0)
        self.assertLess(first, subject.TRACK_ROTATION_BUCKETS)

    def test_seven_day_rotation_covers_every_nonmandatory_profile_within_capacity(self):
        per_day_cap = 10
        keys_by_bucket = {bucket: [] for bucket in range(subject.TRACK_ROTATION_BUCKETS)}
        candidate = 0
        while any(len(keys) < per_day_cap for keys in keys_by_bucket.values()):
            key = f'balanced-{candidate}'
            bucket = subject.stable_rotation_bucket(key)
            if len(keys_by_bucket[bucket]) < per_day_cap:
                keys_by_bucket[bucket].append(key)
            candidate += 1
        keys = [key for bucket_keys in keys_by_bucket.values() for key in bucket_keys]
        tasks = [
            {'uuid': key, 'targets': [{'spotify_id': key, 'row': None}]}
            for key in keys
        ]
        store = {
            key: {
                'history': [['2026-01-01', 100], ['2026-01-02', 110]],
                'observed_at': '2026-01-02T00:00:00Z',
            }
            for key in keys
        }
        start = dt.date(2026, 7, 27)
        seen = set()
        for offset in range(subject.TRACK_ROTATION_BUCKETS):
            selected, policy = subject.plan_track_maintenance(
                tasks,
                store,
                {},
                per_day_cap,
                today=start + dt.timedelta(days=offset),
            )
            seen.update(task['uuid'] for task in selected)
            self.assertEqual(policy['weekly_due_requests'], per_day_cap)
            self.assertEqual(policy['weekly_missing'], 0)
            self.assertEqual(policy['weekly_missing_requests'], 0)

        self.assertEqual(seen, set(keys))

    def test_overloaded_rotation_bucket_ages_missed_profiles_to_the_front(self):
        bucket = 4
        keys = []
        candidate = 0
        while len(keys) < 3:
            key = f'overloaded-{candidate}'
            if subject.stable_rotation_bucket(key) == bucket:
                keys.append(key)
            candidate += 1
        tasks = [
            {'uuid': key, 'targets': [{'spotify_id': key, 'row': None}]}
            for key in keys
        ]
        store = {
            key: {
                'history': [['2026-01-01', 100], ['2026-01-02', 110]],
                'observed_at': f'2026-01-0{index + 1}T00:00:00Z',
            }
            for index, key in enumerate(keys)
        }
        today = dt.date(2026, 7, 27)
        while today.toordinal() % subject.TRACK_ROTATION_BUCKETS != bucket:
            today += dt.timedelta(days=1)

        first, first_policy = subject.plan_track_maintenance(
            tasks, store, {}, 2, today=today
        )
        first_ids = {task['uuid'] for task in first}
        missed = set(keys) - first_ids
        self.assertEqual(first_policy['weekly_missing_requests'], 1)
        for spotify_id in first_ids:
            store[spotify_id]['maintenance_last_attempt_at'] = today.isoformat() + 'T12:00:00Z'

        second, second_policy = subject.plan_track_maintenance(
            tasks, store, {}, 2, today=today + dt.timedelta(days=7)
        )
        self.assertTrue(missed.issubset({task['uuid'] for task in second}))
        self.assertEqual(second_policy['weekly_missing_requests'], 1)

    def test_missing_priority_artist_file_is_a_safe_empty_cohort(self):
        self.assertEqual(
            subject.read_priority_artist_references(Path('does-not-exist.json')),
            (set(), set()),
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
        fixed_day = dt.date(2026, 7, 31)
        with tempfile.TemporaryDirectory() as directory, patch.object(
            subject, 'paris_today', return_value=fixed_day
        ):
            path = Path(directory) / 'playlists.js'
            subject.write_js_payload(path, playlists, subject.PLAYLISTS_PREFIX)
            outcome = subject.refresh_playlists(path, performance, FakeClient(response), 1, 10)
            refreshed = subject.read_js_payload(path, subject.PLAYLISTS_PREFIX)
        expected = [['2026-07-17', 100], ['2026-07-23', 120], [fixed_day.isoformat(), 125]]
        self.assertEqual(performance['playlists']['playlist-1']['history'], expected)
        self.assertEqual(refreshed['hist']['playlist-1'], expected)
        self.assertEqual(subject.field(refreshed['rows'][0], refreshed['cols'], 'last_seen'), fixed_day.isoformat())
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

    def test_js_payload_write_failure_preserves_previous_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'performance.js'
            original = {'source': 'soundcharts_daily', 'tracks': {'track-1': {'history': [['2026-07-21', 1]]}}}
            subject.write_js_payload(path, original, subject.PERFORMANCE_PREFIX)

            with patch.object(Path, 'replace', side_effect=OSError('simulated replace failure')):
                with self.assertRaisesRegex(subject.SoundchartsError, 'atomically persist'):
                    subject.write_js_payload(
                        path,
                        {'source': 'soundcharts_daily', 'tracks': {'track-1': {'history': [['2026-07-22', 2]]}}},
                        subject.PERFORMANCE_PREFIX,
                    )

            self.assertEqual(subject.read_performance_payload(path)['tracks'], original['tracks'])
            self.assertFalse(path.with_name(path.name + '.tmp').exists())

    def test_hot_history_pruning_archives_every_removed_point_without_duplicates(self):
        start = dt.date(2026, 1, 1)
        original = [[(start + dt.timedelta(days=index)).isoformat(), index] for index in range(66)]
        performance = {'tracks': {'track-1': {'history': list(original)}}}

        archived = subject.prune_track_histories_to_hot_window(performance, keep_days=61)
        self.assertEqual(len(archived['track-1']), 5)
        self.assertEqual(len(performance['tracks']['track-1']['history']), 61)

        with tempfile.TemporaryDirectory() as directory:
            history_dir = Path(directory)
            first = subject.write_track_history_archive(history_dir, archived)
            second = subject.write_track_history_archive(history_dir, archived)
            self.assertEqual(first['status'], 'archived')
            self.assertEqual(second['status'], 'archived')
            restored = []
            for path in sorted((history_dir / 'archive').glob('tracks-*.json.gz')):
                with subject.gzip.open(path, 'rt', encoding='utf-8') as handle:
                    restored.extend(subject.json.load(handle)['tracks'].get('track-1', []))

        combined = subject.normalize_history(restored + performance['tracks']['track-1']['history'])
        self.assertEqual(combined, original)

    def test_storage_mode_migrates_legacy_history_before_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'Spotify_Performance_data.js'
            subject.write_js_payload(
                root,
                {
                    'tracks': {
                        'track-1': {
                            'soundcharts_uuid': 'uuid-1',
                            'history': [['2026-07-30', 100], ['2026-07-31', 120]],
                        }
                    },
                    'artists': {},
                    'playlists': {},
                },
                subject.PERFORMANCE_PREFIX,
            )
            args = SimpleNamespace(
                mode='storage',
                performance=root,
                history_dir=Path(directory) / 'history',
            )
            with (
                patch.object(subject, 'parse_args', return_value=args),
                patch.object(subject, 'SoundchartsClient') as client,
            ):
                self.assertEqual(subject.main(), 0)

            client.assert_not_called()
            hydrated = subject.read_performance_payload(root)
            self.assertEqual(
                hydrated['tracks']['track-1']['history'],
                [['2026-07-30', 100], ['2026-07-31', 120]],
            )
            self.assertTrue((Path(directory) / 'Spotify_Performance_tracks').is_dir())

    def test_existing_malformed_history_archive_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            history_dir = Path(directory)
            archive_dir = history_dir / 'archive'
            archive_dir.mkdir()
            path = archive_dir / 'tracks-2026-01.json.gz'
            with subject.gzip.open(path, 'wt', encoding='utf-8') as handle:
                subject.json.dump({'month': '2026-01', 'tracks': []}, handle)
            before = path.read_bytes()

            with self.assertRaisesRegex(subject.SoundchartsError, 'invalid track history archive'):
                subject.write_track_history_archive(
                    history_dir,
                    {'track-1': [['2026-01-01', 1]]},
                )

            self.assertEqual(path.read_bytes(), before)

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
        self.assertIn('performance_track_data_cap="35000"', workflow)
        self.assertIn('playlist_data_cap="3000"', workflow)
        self.assertIn('independent_playlist_data_cap="2500"', workflow)
        self.assertIn('expansion_data_cap="6000"', workflow)
        self.assertIn('classification_data_cap="8230"', workflow)
        self.assertIn('10#$REQUESTED_MAX_REQUESTS > request_cap', workflow)
        self.assertIn('expansion_limit="2500"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.artist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.performance_artist_requests }}"', workflow)
        self.assertIn('--max-requests "${{ steps.plan.outputs.performance_track_requests }}"', workflow)
        self.assertIn('--priority-artists spotify-selection-artist-seeds.json', workflow)
        self.assertIn('deterministic seven-day rotation', workflow)
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
