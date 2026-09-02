import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import data_freshness_watchdog as subject
import spotify_performance_store


def write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def valid_spotify_track_policy(
    *,
    today: date = date(2026, 7, 29),
    public_entities: int = 700,
    selected_entities: int = 100,
    stale_source_entities: int = 0,
) -> dict:
    daily_bucket = today.toordinal() % 7
    expected_per_bucket = public_entities // 7
    remainder = public_entities % 7
    rotation_coverage = {}
    for bucket in range(7):
        expected = expected_per_bucket + (1 if bucket < remainder else 0)
        rotation_coverage[str(bucket)] = {
            "expected_requests": expected,
            "selected_requests": expected if bucket == daily_bucket else 0,
        }
    weekly_due = rotation_coverage[str(daily_bucket)]["expected_requests"]
    selected_requests = weekly_due
    return {
        "version": 3,
        "selection_mode": "adaptive_daily",
        "request_cap": 6000,
        "expected_requests": public_entities,
        "selected_requests": selected_requests,
        "missing_requests": public_entities - selected_requests,
        "daily_rotation_bucket": daily_bucket,
        "rotation_bucket_count": 7,
        "weekly_due_requests": weekly_due,
        "weekly_selected_requests": weekly_due,
        "weekly_missing": 0,
        "weekly_missing_requests": 0,
        "rotation_coverage": rotation_coverage,
        "reason_coverage": {
            "published_public": {
                "expected_requests": public_entities,
                "selected_requests": selected_requests,
                "missing_requests": public_entities - selected_requests,
            }
        },
        "published_public_entity_coverage": {
            "public_entities": public_entities,
            "resolvable_entities": public_entities,
            "unresolved_entities": 0,
            "selected_entities": selected_entities,
            "missing_selected_entities": public_entities - selected_entities,
            "source_age_limit_days": 7,
            "stale_source_entities": stale_source_entities,
            "freshness_cutoff": (today - timedelta(days=7)).isoformat(),
        },
    }


def write_youtube_fixture(
    root: Path,
    *,
    stamp: int,
    day: str,
    card_views: int = 100,
    history_views: int | None = None,
    history_stamp: int | None = None,
    card_rows_expected: int = 2,
    card_rows_updated: int = 2,
    sheet_ours_expected: int = 1,
    sheet_ours_updated: int = 1,
    analysis_rows_expected: int = 1,
    analysis_rows_updated: int = 1,
    tracked: int = 1,
    updated: int = 1,
    history_updated: int = 1,
    partial: bool = False,
    day_timezone: str = "Europe/Paris",
    kids_day: str | None = None,
    kids_stamp: int | None = None,
    kids_discovery_day: str | None = None,
    kids_discovery_stamp: int | None = None,
    kids_discovery_queries_ok: int = subject.YOUTUBE_KIDS_EXPECTED_QUERIES,
    kids_discovery_results: int = subject.YOUTUBE_KIDS_MIN_RESULTS_EXAMINED,
    kids_discovery_candidates: int = 1,
    kids_discovery_lanes_completed: int = subject.YOUTUBE_KIDS_EXPECTED_SEARCH_LANES,
    kids_discovery_complete: bool = True,
    kids_discovery_digest: str | None = None,
) -> None:
    kids_day = kids_day or day
    kids_stamp = kids_stamp or stamp
    kids_discovery_day = kids_discovery_day or day
    kids_discovery_stamp = kids_discovery_stamp or stamp
    history_views = card_views if history_views is None else history_views
    history_stamp = history_stamp or stamp
    standard_id = "abcDEF12345"
    kids_id = "kidDEF12345"
    payload = {
        "d": {
            "all": [{"vid": standard_id, "views": card_views}],
            "trends": [],
            "news": [],
            "ours": [],
            "kids": [{"vid": kids_id, "views": 50}],
        },
        "videoMetricsT": stamp,
        "videoMetrics": {
            "tracked": tracked,
            "updated": updated,
            "history_updated": history_updated,
            "history_day": day,
            "day_timezone": day_timezone,
            "partial": partial,
            "unavailable_ids": [],
            "card_rows_expected": card_rows_expected,
            "card_rows_updated": card_rows_updated,
            "sheet_ours_expected": sheet_ours_expected,
            "sheet_ours_updated": sheet_ours_updated,
            "analysis_rows_expected": analysis_rows_expected,
            "analysis_rows_updated": analysis_rows_updated,
        },
        "kidsMetricsT": kids_stamp,
        "kidsDiscoveryT": kids_discovery_stamp,
        "kidsMetrics": {
            "tracked": 1,
            "updated": 1,
            "history_updated": 1,
            "history_day": kids_day,
            "day": kids_day,
            "day_timezone": "Europe/Paris",
            "partial": False,
            "discovery_day": kids_discovery_day,
            "discovery_queries": subject.YOUTUBE_KIDS_EXPECTED_QUERIES,
            "discovery_queries_ok": kids_discovery_queries_ok,
            "discovery_results_examined": kids_discovery_results,
            "discovery_candidates_kept": kids_discovery_candidates,
            "discovery_search_lanes_expected": subject.YOUTUBE_KIDS_EXPECTED_SEARCH_LANES,
            "discovery_search_lanes_completed": kids_discovery_lanes_completed,
            "discovery_tracked": 1,
            "discovery_ids_digest": (
                kids_discovery_digest
                or subject.youtube_kids_cohort_digest([kids_id])
            ),
            "discovery_complete": kids_discovery_complete,
        },
    }
    write(root / "Lofi_Radar_data.js", f"window.LOFI_DATA={json.dumps(payload)};")
    histories = {
        standard_id: [[history_stamp, history_views]],
        kids_id: [[kids_stamp, 50]],
    }
    by_shard: dict[str, dict[str, list[list[int]]]] = {}
    for video_id, points in histories.items():
        shard = f"{ord(video_id[0]):02x}.json"
        by_shard.setdefault(shard, {})[video_id] = points
    for shard, rows in by_shard.items():
        write(root / "video_history" / shard, json.dumps({"version": 1, "d": rows}))


class DataFreshnessWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        write(
            self.root / "spotify/index.html",
            '<script src="../Spotify_Soundcharts_data_20260729T060000Z.js"></script>',
        )
        write(
            self.root / "Spotify_Browse_Catalogue_data.js",
            'window.SPOTIFY_BROWSE_CATALOGUE={"generated_at":"2026-07-29T06:00:00Z",'
            '"source_snapshot":"Spotify_Soundcharts_data_20260729T060000Z.js"};',
        )
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            {
                "tracks": {},
                "artists": {},
                "playlists": {},
                "freshness": {
                    "tracks_catalogue_at": "2026-07-29T06:00:00Z",
                    "artists_catalogue_at": "2026-07-29T06:00:00Z",
                    "playlists_at": "2026-07-29T06:00:00Z",
                },
                "maintenance_coverage": {
                    "tracks": {
                        "policy": valid_spotify_track_policy()
                    }
                },
            },
            shard_count=1,
        )
        write(
            self.root / "Spotify_Playlists_canonical_data.js",
            'window.SPOTIFY_PLAYLISTS={"meta":{"playlist_followers_status":{"day":"2026-07-29",'
            '"expected":554,"updated":554,"complete":true,"observed_at":"2026-07-29T06:00:00Z"}}};',
        )
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(self.root, stamp=stamp, day="2026-07-29")
        write(
            self.root / "Lofi_Radar_recommendation_pool.js",
            f'window.LOFI_RECOMMENDATION_POOL={{"schema":3,"version":{subject.GENERATOR_VERSION},'
            f'"sourceT":{stamp},"feedbackT":{stamp},"buildId":"build-current",'
            '"ledgerRevision":"ledger-current","ledger":{"total":0,"pending":0,"appended":0},"items":[]};',
        )
        write(
            self.root / "youtube_recommendation_ledger/manifest.json",
            json.dumps(
                {
                    "schema": 1,
                    "generatorVersion": subject.GENERATOR_VERSION,
                    "sourceT": stamp,
                    "updatedAt": "2026-07-29T06:00:00Z",
                    "count": 0,
                    "revision": "ledger-current",
                    "shards": [],
                }
            ),
        )
        write(self.root / "Lofi_Radar_chx.js", f'window.CHX={{"t":{stamp},"lg":{{}}}};')

    def tearDown(self):
        self.temp.cleanup()

    def test_all_current_sources_are_healthy_after_their_paris_deadlines(self):
        now = datetime(2026, 7, 29, 11, tzinfo=timezone.utc)
        rows = subject.assess(self.root, now)
        self.assertTrue(all(not row.due for row in rows), [(row.target, row.reason) for row in rows])

    def test_youtube_and_spotify_become_due_by_paris_day_not_runner_timezone(self):
        write(
            self.root / "Lofi_Radar_data.js",
            'window.LOFI_DATA={"videoMetricsT":1785196800000,"videoMetrics":{"tracked":100,"updated":100,'
            '"history_updated":100,"history_day":"2026-07-28","day_timezone":"Europe/Paris",'
            '"partial":false}};',
        )
        write(
            self.root / "Spotify_Performance_data.js",
            'window.SPOTIFY_PERFORMANCE={"tracks":{},"freshness":{"tracks_catalogue_at":"2026-07-28T21:00:00Z",'
            '"artists_catalogue_at":"2026-07-28T21:00:00Z","playlists_at":"2026-07-28T21:00:00Z"}};',
        )
        write(
            self.root / "Spotify_Browse_Catalogue_data.js",
            'window.SPOTIFY_BROWSE_CATALOGUE={"generated_at":"2026-07-28T21:00:00Z",'
            '"source_snapshot":"Spotify_Soundcharts_data_20260729T060000Z.js"};',
        )
        now = datetime(2026, 7, 29, 12, 30, tzinfo=timezone.utc)  # 14:30 Paris
        rows = {row.target: row for row in subject.assess(self.root, now)}
        self.assertTrue(rows["youtube_radar"].due)
        self.assertTrue(rows["spotify_core"].due)

    def test_spotify_core_waits_for_the_late_source_day_before_alerting(self):
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            {
                "tracks": {},
                "artists": {},
                "playlists": {},
                "freshness": {
                    "tracks_catalogue_at": "2026-07-28T21:00:00Z",
                    "artists_catalogue_at": "2026-07-28T21:00:00Z",
                    "playlists_at": "2026-07-28T21:00:00Z",
                },
                "maintenance_coverage": {
                    "tracks": {
                        "policy": valid_spotify_track_policy()
                    }
                },
            },
            shard_count=1,
        )
        before_deadline = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, 30, tzinfo=timezone.utc),  # 13:30 Paris
            ["spotify_core"],
        )[0]
        self.assertFalse(before_deadline.due)

    def test_spotify_core_dispatch_contract_is_bounded_developer_maintenance(self):
        self.assertEqual(
            subject.TARGETS["spotify_core"].inputs,
            {
                "scope": "maintenance",
                "max_requests": "6000",
                "freshness_gate": "true",
            },
        )

    def test_spotify_policy_allows_mandatory_rows_inside_the_daily_rotation_bucket(self):
        policy = valid_spotify_track_policy()
        daily_bucket = str(policy["daily_rotation_bucket"])
        policy["rotation_coverage"][daily_bucket]["expected_requests"] += 5
        policy["rotation_coverage"][daily_bucket]["selected_requests"] += 5
        policy["expected_requests"] += 5
        policy["selected_requests"] += 5

        self.assertIsNone(subject.spotify_track_policy_problem(policy, 6000))

    def test_spotify_core_allows_artists_to_age_for_180_hours(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["freshness"]["artists_catalogue_at"] = "2026-07-22T00:00:00Z"
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertFalse(row.due, row.reason)
        self.assertIn("artists are 179h old", row.reason)

    def test_spotify_core_retries_after_artist_age_exceeds_180_hours(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["freshness"]["artists_catalogue_at"] = "2026-07-21T21:59:59Z"
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("older than 180 hours", row.reason)

    def test_spotify_core_retries_when_track_catalogue_exceeds_36_hours(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["freshness"]["tracks_catalogue_at"] = "2026-07-27T22:59:59Z"
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("older than 36 hours", row.reason)

    def test_missing_performance_shard_is_never_reported_green(self):
        performance = {
            "tracks": {"track-1": {"history": [["2026-07-29", 100]]}},
            "artists": {},
            "playlists": {},
            "freshness": {
                "tracks_catalogue_at": "2026-07-29T06:00:00Z",
                "artists_catalogue_at": "2026-07-29T06:00:00Z",
                "playlists_at": "2026-07-29T06:00:00Z",
            },
        }
        path = self.root / "Spotify_Performance_data.js"
        spotify_performance_store.write_performance_payload(path, performance, shard_count=1)
        descriptor = spotify_performance_store._read_root(path)["track_shards"]["shards"][0]
        (self.root / descriptor["path"]).unlink()

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("store invalid", row.reason)

    def test_spotify_core_requires_explicit_public_track_scheduling_proof(self):
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            {
                "tracks": {},
                "artists": {},
                "playlists": {},
                "freshness": {
                    "tracks_catalogue_at": "2026-07-29T06:00:00Z",
                    "artists_catalogue_at": "2026-07-29T06:00:00Z",
                    "playlists_at": "2026-07-29T06:00:00Z",
                },
            },
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("maintenance policy", row.reason)

    def test_spotify_core_accepts_partial_daily_public_selection_with_weekly_rotation(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        policy = valid_spotify_track_policy(
            public_entities=700,
            selected_entities=100,
        )
        # Public priorities may consume the daily cap before the explicit
        # weekly lane; source-age proof still demonstrates weekly coverage.
        policy["weekly_selected_requests"] = 0
        policy["weekly_missing"] = policy["weekly_due_requests"]
        policy["weekly_missing_requests"] = policy["weekly_due_requests"]
        performance["maintenance_coverage"]["tracks"]["policy"] = policy
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertFalse(row.due, row.reason)
        self.assertIn("weekly rotation selected 100/700", row.reason)

    def test_spotify_core_retries_when_too_many_public_histories_are_over_seven_days_old(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["maintenance_coverage"]["tracks"]["policy"] = valid_spotify_track_policy(
            public_entities=1000,
            selected_entities=143,
            stale_source_entities=11,
        )
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("989/1000", row.reason)

    def test_spotify_core_accepts_ten_stale_public_histories_at_the_floor(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["maintenance_coverage"]["tracks"]["policy"] = valid_spotify_track_policy(
            public_entities=100,
            selected_entities=15,
            stale_source_entities=10,
        )
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertFalse(row.due, row.reason)

    def test_spotify_core_accepts_one_percent_stale_for_a_larger_public_cohort(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        performance["maintenance_coverage"]["tracks"]["policy"] = valid_spotify_track_policy(
            public_entities=2100,
            selected_entities=300,
            stale_source_entities=21,
        )
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertFalse(row.due, row.reason)

    def test_spotify_core_rejects_a_policy_without_any_selection(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        policy = valid_spotify_track_policy()
        policy["selected_requests"] = 0
        policy["missing_requests"] = policy["expected_requests"]
        for bucket in policy["rotation_coverage"].values():
            bucket["selected_requests"] = 0
        policy["weekly_selected_requests"] = 0
        policy["weekly_missing"] = policy["weekly_due_requests"]
        policy["weekly_missing_requests"] = policy["weekly_due_requests"]
        policy["reason_coverage"]["published_public"]["selected_requests"] = 0
        policy["reason_coverage"]["published_public"]["missing_requests"] = policy[
            "reason_coverage"
        ]["published_public"]["expected_requests"]
        policy["published_public_entity_coverage"]["selected_entities"] = 0
        policy["published_public_entity_coverage"]["missing_selected_entities"] = policy[
            "published_public_entity_coverage"
        ]["resolvable_entities"]
        performance["maintenance_coverage"]["tracks"]["policy"] = policy
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("no bounded selection", row.reason)

    def test_spotify_core_requires_explicit_seven_day_source_age_proof(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        entities = performance["maintenance_coverage"]["tracks"]["policy"][
            "published_public_entity_coverage"
        ]
        entities.pop("stale_source_entities")
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("seven-day", row.reason)

    def test_spotify_core_rejects_an_empty_public_cohort(self):
        performance = spotify_performance_store.read_performance_payload(
            self.root / "Spotify_Performance_data.js"
        )
        policy = valid_spotify_track_policy(
            public_entities=7,
            selected_entities=1,
        )
        policy["published_public_entity_coverage"].update(
            {
                "public_entities": 0,
                "resolvable_entities": 0,
                "unresolved_entities": 0,
                "selected_entities": 0,
                "missing_selected_entities": 0,
            }
        )
        performance["maintenance_coverage"]["tracks"]["policy"] = policy
        spotify_performance_store.write_performance_payload(
            self.root / "Spotify_Performance_data.js",
            performance,
            shard_count=1,
        )

        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]

        self.assertTrue(row.due)
        self.assertIn("unexpectedly empty", row.reason)

    def test_legacy_monolith_is_due_for_storage_migration(self):
        write(
            self.root / "Spotify_Performance_data.js",
            'window.SPOTIFY_PERFORMANCE={"tracks":{},"freshness":{'
            '"tracks_catalogue_at":"2026-07-29T06:00:00Z",'
            '"artists_catalogue_at":"2026-07-29T06:00:00Z"}};',
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_core"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("not sharded", row.reason)

    def test_collector_cron_requires_today_even_before_the_watchdog_grace_deadline(self):
        stamp = int(datetime(2026, 7, 28, 12, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-28",
        )
        now = datetime(2026, 7, 29, 7, 17, tzinfo=timezone.utc)  # 09:17 Paris
        normal = subject.assess(self.root, now, ["youtube_radar"])[0]
        scheduled = subject.assess(self.root, now, ["youtube_radar"], ignore_deadline=True)[0]
        self.assertFalse(normal.due)
        self.assertTrue(scheduled.due)

    def test_partial_youtube_coverage_is_retried_even_above_ninety_nine_percent(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            tracked=3271,
            updated=3264,
            history_updated=3264,
            partial=True,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("3264/3271", row.reason)

    def test_youtube_card_rows_must_all_be_updated(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            card_rows_expected=2,
            card_rows_updated=1,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("1/2", row.reason)

    def test_youtube_canonical_our_videos_must_all_be_updated(self):
        stamp = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            sheet_ours_expected=83,
            sheet_ours_updated=82,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 8, 13, 12, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("Our Videos coverage is only 82/83", row.reason)

    def test_youtube_visible_analysis_cohort_must_all_be_updated(self):
        stamp = int(datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            sheet_ours_expected=79,
            sheet_ours_updated=79,
            analysis_rows_expected=83,
            analysis_rows_updated=82,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 8, 13, 12, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("visible Analyse coverage is only 82/83", row.reason)

    def test_youtube_kids_must_have_a_fresh_daily_observation(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        kids_stamp = int(datetime(2026, 7, 28, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            kids_day="2026-07-28",
            kids_stamp=kids_stamp,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("YouTube Kids", row.reason)

    def test_youtube_kids_discovery_has_its_own_current_complete_proof(self):
        stamp = int(datetime(2026, 8, 13, 11, 37, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
        )
        row = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertFalse(row.due, row.reason)
        self.assertIn("40/40", row.reason)

    def test_fresh_kids_counters_do_not_mask_stale_kids_discovery(self):
        counter_stamp = int(
            datetime(2026, 8, 13, 8, tzinfo=timezone.utc).timestamp() * 1000
        )
        discovery_stamp = int(
            datetime(2026, 8, 12, 11, 37, tzinfo=timezone.utc).timestamp() * 1000
        )
        write_youtube_fixture(
            self.root,
            stamp=counter_stamp,
            day="2026-08-13",
            kids_stamp=counter_stamp,
            kids_day="2026-08-13",
            kids_discovery_stamp=discovery_stamp,
            kids_discovery_day="2026-08-12",
        )
        row = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("Paris day 2026-08-13", row.reason)

    def test_youtube_kids_discovery_rejects_incomplete_queries_and_zero_yield(self):
        stamp = int(datetime(2026, 8, 13, 11, 37, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            kids_discovery_queries_ok=39,
        )
        incomplete = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(incomplete.due)
        self.assertIn("39/40", incomplete.reason)

        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            kids_discovery_candidates=0,
        )
        zero_yield = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(zero_yield.due)
        self.assertIn("yield/coverage is insufficient", zero_yield.reason)

        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            kids_discovery_results=subject.YOUTUBE_KIDS_MIN_RESULTS_EXAMINED - 1,
        )
        shallow = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(shallow.due)
        self.assertIn("minimum results", shallow.reason)

        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            kids_discovery_lanes_completed=79,
        )
        lanes = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(lanes.due)
        self.assertIn("79/80", lanes.reason)

    def test_youtube_kids_discovery_rejects_a_divergent_cohort_digest(self):
        stamp = int(datetime(2026, 8, 13, 11, 37, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-08-13",
            kids_discovery_digest="0" * 64,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 8, 13, 14, tzinfo=timezone.utc),
            ["youtube_kids"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("digest diverges", row.reason)

    def test_youtube_card_views_must_match_the_latest_history_point(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            card_views=100,
            history_views=101,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("card views and latest history disagree", row.reason)

    def test_youtube_card_history_must_include_the_declared_day(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        old_history_stamp = int(datetime(2026, 7, 28, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            history_stamp=old_history_stamp,
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("latest history day diverge", row.reason)

    def test_fail_if_due_turns_the_publication_guard_into_a_nonzero_exit(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            card_rows_expected=2,
            card_rows_updated=1,
        )
        with redirect_stdout(io.StringIO()):
            code = subject.main(
                [
                    "--root",
                    str(self.root),
                    "--target",
                    "youtube_radar",
                    "--now",
                    "2026-07-29T11:00:00Z",
                    "--scheduled-check",
                    "--fail-if-due",
                ]
            )
        self.assertEqual(code, 1)

    def test_recommendations_follow_the_exact_factual_source_without_a_size_floor(self):
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_recommendations"],
        )[0]
        self.assertFalse(row.due)
        self.assertIn("build-current", row.reason)

    def test_recommendations_are_due_when_the_factual_source_moves(self):
        stamp = int(datetime(2026, 7, 29, 7, tzinfo=timezone.utc).timestamp() * 1000)
        write(
            self.root / "Lofi_Radar_data.js",
            f'window.LOFI_DATA={{"videoMetricsT":{stamp},"videoMetrics":{{"tracked":100,"updated":100,'
            '"history_updated":100,"history_day":"2026-07-29","day_timezone":"Europe/Paris",'
            '"partial":false}}};',
        )
        row = subject.assess(self.root, datetime(2026, 7, 29, 11, tzinfo=timezone.utc), ["youtube_recommendations"])[0]
        self.assertTrue(row.due)
        self.assertIn("factual source", row.reason)

    def test_recommendations_are_due_on_generator_or_ledger_mismatch(self):
        pool = self.root / "Lofi_Radar_recommendation_pool.js"
        raw = pool.read_text(encoding="utf-8")
        current = f'"version":{subject.GENERATOR_VERSION}'
        self.assertIn(current, raw)
        pool.write_text(raw.replace(current, '"version":2'), encoding="utf-8")
        version = subject.assess(self.root, datetime(2026, 7, 29, 11, tzinfo=timezone.utc), ["youtube_recommendations"])[0]
        self.assertTrue(version.due)
        self.assertIn("generator version", version.reason)

        pool.write_text(raw.replace('"ledgerRevision":"ledger-current"', '"ledgerRevision":"ledger-old"'), encoding="utf-8")
        revision = subject.assess(self.root, datetime(2026, 7, 29, 11, tzinfo=timezone.utc), ["youtube_recommendations"])[0]
        self.assertTrue(revision.due)
        self.assertIn("revisions differ", revision.reason)

    def test_malformed_recommendation_metadata_is_due_instead_of_crashing(self):
        pool = self.root / "Lofi_Radar_recommendation_pool.js"
        raw = pool.read_text(encoding="utf-8")
        current = f'"version":{subject.GENERATOR_VERSION}'
        self.assertIn(current, raw)
        pool.write_text(raw.replace(current, '"version":"broken"'), encoding="utf-8")
        row = subject.assess(self.root, datetime(2026, 7, 29, 11, tzinfo=timezone.utc), ["youtube_recommendations"])[0]
        self.assertTrue(row.due)
        self.assertIn("invalid recommendation state", row.reason)

    def test_recommendations_are_due_when_the_six_hour_refresh_stops(self):
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 16, tzinfo=timezone.utc),
            ["youtube_recommendations"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("older than nine hours", row.reason)

    def test_youtube_history_count_and_timezone_must_match_the_complete_scan(self):
        stamp = int(datetime(2026, 7, 29, 6, tzinfo=timezone.utc).timestamp() * 1000)
        write_youtube_fixture(
            self.root,
            stamp=stamp,
            day="2026-07-29",
            tracked=100,
            updated=100,
            history_updated=99,
            day_timezone="UTC",
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["youtube_radar"],
        )[0]
        self.assertTrue(row.due)
        self.assertIn("99/100", row.reason)

    def test_playlist_followers_require_the_complete_visible_cohort(self):
        write(
            self.root / "Spotify_Playlists_canonical_data.js",
            'window.SPOTIFY_PLAYLISTS={"meta":{"playlist_followers_status":{"day":"2026-07-29",'
            '"expected":554,"updated":553,"complete":false,"observed_at":"2026-07-29T06:00:00Z"}}};',
        )
        row = subject.assess(self.root, datetime(2026, 7, 29, 9, tzinfo=timezone.utc), ["spotify_followers"])[0]
        self.assertTrue(row.due)
        self.assertIn("553/554", row.reason)

    def test_browse_catalogue_is_due_when_it_does_not_match_the_active_snapshot(self):
        write(
            self.root / "Spotify_Browse_Catalogue_data.js",
            'window.SPOTIFY_BROWSE_CATALOGUE={"generated_at":"2026-07-29T06:00:00Z",'
            '"source_snapshot":"Spotify_Soundcharts_data_20260728T060000Z.js"};',
        )
        row = subject.assess(self.root, datetime(2026, 7, 29, 9, tzinfo=timezone.utc), ["spotify_browse"])[0]
        self.assertTrue(row.due)
        self.assertIn("active snapshot", row.reason)

    def test_stale_browse_does_not_trigger_the_expensive_spotify_core_collector(self):
        write(
            self.root / "Spotify_Browse_Catalogue_data.js",
            'window.SPOTIFY_BROWSE_CATALOGUE={"generated_at":"2026-07-20T06:00:00Z",'
            '"source_snapshot":"Spotify_Soundcharts_data_20260720T060000Z.js"};',
        )
        now = datetime(2026, 7, 29, 11, tzinfo=timezone.utc)
        core = subject.assess(self.root, now, ["spotify_core"])[0]
        browse = subject.assess(self.root, now, ["spotify_browse"])[0]
        self.assertFalse(core.due)
        self.assertTrue(browse.due)

    def test_playlist_follower_freshness_uses_only_the_canonical_file(self):
        write(
            self.root / "Spotify_Playlists_data.js",
            'window.SPOTIFY_PLAYLISTS={"meta":{"playlist_followers_status":{"day":"2026-07-20",'
            '"expected":554,"updated":0,"complete":false}}};',
        )
        row = subject.assess(
            self.root,
            datetime(2026, 7, 29, 11, tzinfo=timezone.utc),
            ["spotify_followers"],
        )[0]
        self.assertFalse(row.due)
        self.assertIn("554/554", row.reason)

    def test_active_run_and_cooldown_prevent_duplicate_dispatches(self):
        status = subject.Freshness(
            target="youtube_radar",
            workflow="refresh-instrumental-radar.yml",
            due=True,
            reason="stale",
            observed_at=None,
            cooldown_minutes=45,
            inputs={"force": "false"},
        )
        now = datetime(2026, 7, 29, 12, tzinfo=timezone.utc)
        active = [{"event": "workflow_dispatch", "status": "in_progress", "created_at": "2026-07-29T11:50:00Z"}]
        self.assertEqual(subject.dispatch_decision(status, active, now)[1], "active run already exists")
        push = [{"event": "push", "status": "queued", "created_at": "2026-07-29T11:55:00Z"}]
        self.assertEqual(subject.dispatch_decision(status, push, now)[1], "active run already exists")
        chained = [{"event": "workflow_run", "status": "in_progress", "created_at": "2026-07-29T11:55:00Z"}]
        self.assertEqual(subject.dispatch_decision(status, chained, now)[1], "active run already exists")
        recent = [{"event": "schedule", "status": "completed", "created_at": "2026-07-29T11:40:00Z"}]
        self.assertIn("cooldown", subject.dispatch_decision(status, recent, now)[1])
        old = [{"event": "schedule", "status": "completed", "created_at": "2026-07-29T10:00:00Z"}]
        self.assertTrue(subject.dispatch_decision(status, old, now)[0])

    def test_local_only_kids_never_calls_github_and_other_repairs_continue(self):
        now = datetime(2026, 9, 2, 7, tzinfo=timezone.utc)
        kids = subject.freshness_row(subject.TARGETS["youtube_kids"], True, "stale local Kids proof", None)
        standard = subject.Freshness(
            target="youtube_radar",
            workflow="refresh-instrumental-radar.yml",
            due=True,
            reason="stale",
            observed_at=None,
            cooldown_minutes=45,
            inputs={"force": "false"},
        )

        class RecordingClient:
            def __init__(self):
                self.runs_calls = []
                self.dispatch_calls = []

            def runs(self, workflow):
                self.runs_calls.append(workflow)
                return []

            def dispatch(self, workflow, inputs):
                self.dispatch_calls.append((workflow, inputs))

        client = RecordingClient()
        results = subject.dispatch_due([kids, standard], client, now)

        self.assertFalse(subject.TARGETS["youtube_kids"].dispatchable)
        self.assertEqual(client.runs_calls, ["refresh-instrumental-radar.yml"])
        self.assertEqual(client.dispatch_calls, [("refresh-instrumental-radar.yml", {"force": "false"})])
        self.assertFalse(results[0]["dispatched"])
        self.assertEqual(results[0]["decision"], "local-only target")
        self.assertTrue(results[1]["dispatched"])

    def test_failed_disabled_dispatch_does_not_block_later_repairs(self):
        now = datetime(2026, 9, 2, 7, tzinfo=timezone.utc)
        disabled = subject.Freshness(
            target="spotify_core",
            workflow="disabled.yml",
            due=True,
            reason="stale",
            observed_at=None,
            cooldown_minutes=30,
            inputs={},
        )
        standard = subject.Freshness(
            target="youtube_radar",
            workflow="refresh-instrumental-radar.yml",
            due=True,
            reason="stale",
            observed_at=None,
            cooldown_minutes=45,
            inputs={"force": "false"},
        )

        class DisabledThenHealthyClient:
            def __init__(self):
                self.dispatch_calls = []

            def runs(self, workflow):
                return []

            def dispatch(self, workflow, inputs):
                self.dispatch_calls.append(workflow)
                if workflow == "disabled.yml":
                    raise RuntimeError("HTTP 422: workflow is disabled")

        client = DisabledThenHealthyClient()
        results = subject.dispatch_due([disabled, standard], client, now)

        self.assertEqual(client.dispatch_calls, ["disabled.yml", "refresh-instrumental-radar.yml"])
        self.assertFalse(results[0]["dispatched"])
        self.assertIn("HTTP 422", results[0]["decision"])
        self.assertTrue(results[1]["dispatched"])

    def test_three_collection_attempts_in_six_hours_stop_a_retry_storm(self):
        status = subject.Freshness(
            target="spotify_followers",
            workflow="refresh-playlist-followers.yml",
            due=True,
            reason="stale",
            observed_at=None,
            cooldown_minutes=30,
            inputs={},
        )
        now = datetime(2026, 7, 29, 12, tzinfo=timezone.utc)
        runs = [
            {"event": "workflow_dispatch", "status": "completed", "created_at": f"2026-07-29T0{hour}:00:00Z"}
            for hour in (7, 8, 9)
        ]
        allowed, reason = subject.dispatch_decision(status, runs, now)
        self.assertFalse(allowed)
        self.assertIn("retry ceiling", reason)

    def test_soundcharts_source_lag_allows_only_one_bounded_repair(self):
        status = subject.Freshness(
            target="spotify_core",
            workflow="refresh-soundcharts.yml",
            due=True,
            reason="public Spotify histories are current for only 80/100",
            observed_at=None,
            cooldown_minutes=30,
            inputs={"max_requests": "6000"},
        )
        now = datetime(2026, 7, 29, 12, tzinfo=timezone.utc)
        runs = [
            {
                "event": "schedule",
                "status": "completed",
                "created_at": "2026-07-29T10:00:00Z",
            },
            {
                "event": "workflow_dispatch",
                "status": "completed",
                "created_at": "2026-07-29T11:00:00Z",
            },
        ]

        allowed, reason = subject.dispatch_decision(status, runs, now)

        self.assertFalse(allowed)
        self.assertIn("2 collection attempts", reason)


class DataFreshnessWorkflowGuardrailTests(unittest.TestCase):
    def test_watchdog_has_stable_redundant_triggers_and_write_scope_only_for_actions(self):
        workflow = Path(".github/workflows/data-freshness-watchdog.yml").read_text(encoding="utf-8")
        self.assertIn("cron: '23,53 * * * *'", workflow)
        self.assertIn("workflow_run:", workflow)
        self.assertIn("repository_dispatch:", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("actions: write", workflow)
        self.assertIn("contents: read", workflow)
        self.assertNotIn("SOUNDCHARTS_CLIENT_SECRET", workflow)
        self.assertIn("data_freshness_watchdog.py --dispatch", workflow)
        self.assertIn("Refresh YouTube recommendations", workflow)
        self.assertIn("Refresh YouTube Kids radar", workflow)
        self.assertIn("youtube_recommendation_ledger/manifest.json", workflow)
        source = Path("data_freshness_watchdog.py").read_text(encoding="utf-8")
        self.assertIn('"youtube_recommendations": Target(', source)
        self.assertIn('"refresh-youtube-recommendations.yml"', source)
        self.assertIn('"youtube_kids": Target(', source)
        self.assertIn('"refresh-youtube-kids.yml"', source)

    def test_collectors_recheck_freshness_before_expensive_work(self):
        expected = {
            "refresh-instrumental-radar.yml": "--target youtube_radar",
            "refresh-youtube-kids.yml": "--target youtube_kids",
            "refresh-soundcharts.yml": "--target spotify_core",
            "refresh-spotify-browse-catalogue.yml": "--target spotify_browse",
            "refresh-channel-radar.yml": "--target youtube_channels",
        }
        for name, target in expected.items():
            workflow = Path(".github/workflows", name).read_text(encoding="utf-8")
            self.assertIn(target, workflow, name)
            self.assertRegex(workflow, r"needs: gate[\s\S]{0,100}if: needs\.gate\.outputs\.", name)
            if name != "refresh-spotify-browse-catalogue.yml":
                self.assertIn("--scheduled-check", workflow, name)
        followers = Path(".github/workflows/refresh-playlist-followers.yml").read_text(encoding="utf-8")
        self.assertIn("Measure today's visible playlist coverage", followers)
        self.assertIn("steps.coverage_before.outputs.complete != 'true'", followers)


if __name__ == "__main__":
    unittest.main()

