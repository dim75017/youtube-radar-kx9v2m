import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import refresh_youtube_daily as radar


class DailyHistoryTests(unittest.TestCase):
    def test_rerun_replaces_same_utc_day(self):
        day = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        later = day + 4 * 3600000
        points = radar.append_daily_point([[day, 100]], later, 125)
        self.assertEqual(points, [[later, 125]])

    def test_merge_updates_existing_video_and_adds_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            payload = {
                "t": 1,
                "d": {
                    "all": [{"vid": "abcdefghijk", "title": "Old", "views": 100, "pub": 1700000000000, "kw": "focus music"}],
                    "trends": [],
                    "news": [],
                    "recos": [],
                    "roadmap": [],
                },
            }
            radar.write_snapshot(snapshot, payload)
            generated = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            artifact = {
                "version": 1,
                "generated_ms": generated,
                "shard": 0,
                "shards": 1,
                "tracked_total": 1,
                "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"],
                "tracked_fresh_ids": ["abcdefghijk"],
                "queries_total": 1,
                "queries_ok": 1,
                "queries_raw": 10,
                "queries_enriched": 10,
                "fresh": [{
                    "vid": "abcdefghijk",
                    "title": "Fresh",
                    "views": 150,
                    "pub": 1700000000000,
                    "chUrl": "https://www.youtube.com/@FocusChannel",
                    "channelId": "UC1234567890123456789012",
                }],
                "candidates": [],
            }
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            summary = radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
            history = json.loads((root / "video_history" / "61.json").read_text(encoding="utf-8"))
            self.assertEqual(merged["d"]["all"][0]["views"], 150)
            self.assertEqual(merged["d"]["all"][0]["title"], "Fresh")
            self.assertEqual(merged["d"]["all"][0]["channelId"], "UC1234567890123456789012")
            self.assertNotIn("hist", merged["d"])
            self.assertEqual(history["d"]["abcdefghijk"], [[generated, 150]])
            self.assertEqual(merged["videoMetricsT"], generated)
            self.assertEqual(merged["videoMetrics"]["search_results"], 10)
            self.assertEqual(merged["videoMetrics"]["search_results_enriched"], 10)
            self.assertEqual(summary["updated"], 1)

    def test_daily_history_keeps_latest_point_per_paris_day(self):
        morning = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        evening = morning + 10 * 3600000
        next_day = morning + 24 * 3600000
        points = radar.normalize_daily_points(
            [[morning, 100], [evening, 125], [next_day, 140]], next_day
        )
        self.assertEqual(points, [[evening, 125], [next_day, 140]])

    def test_scans_on_both_sides_of_paris_midnight_are_not_deduplicated(self):
        july_27_paris = int(datetime(2026, 7, 27, 16, 7, tzinfo=timezone.utc).timestamp() * 1000)
        july_28_paris = int(datetime(2026, 7, 27, 23, 49, tzinfo=timezone.utc).timestamp() * 1000)
        points = radar.normalize_daily_points(
            [[july_27_paris, 100], [july_28_paris, 125]],
            july_28_paris,
        )
        self.assertEqual(points, [[july_27_paris, 100], [july_28_paris, 125]])
        self.assertEqual(radar.history_day_key(july_27_paris), "2026-07-27")
        self.assertEqual(radar.history_day_key(july_28_paris), "2026-07-28")

    def test_daily_history_drops_points_before_20_july_2026(self):
        before = int(datetime(2026, 7, 19, 20, tzinfo=timezone.utc).timestamp() * 1000)
        start = int(datetime(2026, 7, 20, 20, tzinfo=timezone.utc).timestamp() * 1000)
        next_day = start + 86400000
        points = radar.normalize_daily_points([[before, 100], [start, 120], [next_day, 150]], next_day)
        self.assertEqual(points, [[start, 120], [next_day, 150]])

    def test_history_is_not_erased_when_a_source_temporarily_omits_an_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            history_dir = Path(tmp)
            stamp = int(datetime(2026, 7, 27, 16, tzinfo=timezone.utc).timestamp() * 1000)
            path = history_dir / "61.json"
            path.write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {"abcdefghijk": [[stamp, 100]]}}),
                encoding="utf-8",
            )
            radar.update_history_shards(history_dir, set(), {}, {}, stamp + 3600000)
            history = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(history["d"]["abcdefghijk"], [[stamp, 100]])

    def test_canonical_owned_video_sheet_fails_closed(self):
        with patch.object(radar.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertRaisesRegex(RuntimeError, "canonical dashboard video list"):
                radar.sheet_video_ids()

    def test_sheet_manifest_includes_every_video_tab_visible_in_the_dashboard(self):
        from openpyxl import Workbook

        workbook = Workbook()
        all_videos = workbook.active
        all_videos.title = "All Videos"
        all_videos["A2"] = '=IMAGE("https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg")'
        trends = workbook.create_sheet("Trends")
        trends["A2"] = '=HYPERLINK("https://youtu.be/zyxwvutsrqp","Thumb")'
        news = workbook.create_sheet("News")
        news["B2"] = '=HYPERLINK("https://www.youtube.com/shorts/mnopqrstuvw","News")'
        ours = workbook.create_sheet("Our Videos")
        ours["A2"] = "12345678901"
        payload = io.BytesIO()
        workbook.save(payload)
        payload.seek(0)

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        with patch.object(radar.urllib.request, "urlopen", return_value=Response(payload.read())):
            ids = radar.sheet_video_ids()
        self.assertEqual(
            ids,
            {"abcdefghijk", "zyxwvutsrqp", "mnopqrstuvw", "12345678901"},
        )

    def test_one_canonical_manifest_is_reused_by_all_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            manifest_path = root / "artifacts" / "tracked.json"
            radar.write_snapshot(snapshot, {"videoMetricsT": 123, "d": {}})
            with patch.object(radar, "tracked_ids", return_value=["abcdefghijk", "zyxwvutsrqp"]) as tracked:
                manifest = radar.write_tracked_manifest(snapshot, manifest_path)
            loaded = radar.read_tracked_manifest(manifest_path)
        tracked.assert_called_once()
        self.assertEqual(manifest["ids"], ["abcdefghijk", "zyxwvutsrqp"])
        self.assertEqual(loaded, ["abcdefghijk", "zyxwvutsrqp"])

    def test_publicly_unavailable_ids_are_quarantined_but_kept_as_recovery_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            manifest_path = root / "artifacts" / "tracked.json"
            radar.write_snapshot(snapshot, {
                "videoMetricsT": 123,
                "videoMetrics": {"unavailable_ids": ["abcdefghijk"]},
                "d": {
                    "all": [
                        {"vid": "abcdefghijk", "title": "Unavailable"},
                        {"vid": "zyxwvutsrqp", "title": "Public"},
                    ],
                },
            })
            with patch.object(radar, "sheet_video_ids", return_value={"abcdefghijk", "zyxwvutsrqp"}):
                manifest = radar.write_tracked_manifest(snapshot, manifest_path)
            active = radar.read_tracked_manifest(manifest_path)
            probes = radar.read_quarantine_manifest(manifest_path)
        self.assertEqual(manifest["ids"], ["zyxwvutsrqp"])
        self.assertEqual(active, ["zyxwvutsrqp"])
        self.assertEqual(probes, ["abcdefghijk"])

    def test_missing_subscriber_count_does_not_become_zero(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        row = radar.info_to_row(
            {
                "id": "abcdefghijk",
                "title": "Focus mix",
                "view_count": 100,
                "duration": 3600,
                "upload_date": "20260719",
            },
            now,
        )
        self.assertNotIn("subs", row)

    def test_video_info_preserves_channel_id_for_avatar_lookup(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        row = radar.info_to_row(
            {
                "id": "abcdefghijk",
                "title": "Focus mix",
                "view_count": 100,
                "duration": 3600,
                "upload_date": "20260719",
                "channel_id": "UC1234567890123456789012",
                "channel_url": "https://www.youtube.com/@FocusChannel",
            },
            now,
        )
        self.assertEqual(row["channelId"], "UC1234567890123456789012")

    def test_public_watch_duration_uses_real_length_seconds(self):
        self.assertEqual(
            radar.parse_watch_duration('{"videoDetails":{"lengthSeconds":"3661"}}'),
            3661.0,
        )
        self.assertIsNone(radar.parse_watch_duration('{"videoDetails":{}}'))

    def test_owned_genre_is_inferred_only_from_explicit_title_words(self):
        self.assertEqual(
            radar.owned_genre_from_title("summer lofi - chill beats to relax to"),
            "Lofi / chillhop",
        )
        self.assertEqual(radar.owned_genre_from_title("Deep Focus"), "")

    def test_update_row_backfills_genre_without_overwriting_curated_genre(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
        empty = {"vid": "abcdefghijk"}
        radar.update_row(
            empty,
            {"genre": "Lofi / chillhop", "genreSource": "title_explicit"},
            now,
        )
        self.assertEqual(empty["genre"], "Lofi / chillhop")
        self.assertEqual(empty["genreSource"], "title_explicit")

        curated = {"vid": "abcdefghijk", "genre": "Ambient"}
        radar.update_row(
            curated,
            {"genre": "Lofi / chillhop", "genreSource": "title_explicit"},
            now,
        )
        self.assertEqual(curated["genre"], "Ambient")

    def test_official_upload_lookup_uses_the_channel_uploads_playlist(self):
        responses = iter([
            {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": "UUofficial"}}}]},
            {"items": [{"contentDetails": {"videoId": "abcdefghijk"}}]},
        ])
        with patch.object(radar, "youtube_api_payload", side_effect=lambda *args: next(responses)) as api:
            ids = radar.fetch_owned_upload_ids("test-key")
        self.assertEqual(ids, ["abcdefghijk"])
        self.assertEqual(api.call_args_list[0].args[0], "channels")
        self.assertEqual(api.call_args_list[1].args[0], "playlistItems")

    def test_official_upload_fallback_uses_the_public_channel_videos_page(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)

        class Channel:
            def extract_info(self, url, download=False):
                self.url = url
                return {"entries": [{"id": "abcdefghijk"}]}

        channel = Channel()
        with patch.object(radar, "owned_ydl", return_value=channel), patch.object(
            radar,
            "fetch_one_video",
            return_value={
                "vid": "abcdefghijk",
                "title": "summer lofi - chill beats to relax to",
                "views": 100,
            },
        ), patch.object(radar, "fetch_public_duration", return_value=3661.0) as duration:
            rows = radar.fetch_owned_ydl_rows(now)
        self.assertEqual(channel.url, "https://www.youtube.com/@LofiGirl/videos")
        self.assertEqual(rows["abcdefghijk"]["source"], "Official Lofi Girl daily scan")
        self.assertEqual(rows["abcdefghijk"]["genre"], "Lofi / chillhop")
        self.assertAlmostEqual(rows["abcdefghijk"]["durH"], 3661 / 3600)
        duration.assert_called_once_with("abcdefghijk")

    def test_merge_inserts_official_upload_into_analysis_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            radar.write_snapshot(snapshot, {"t": 1, "d": {"all": [{"vid": "abcdefghijk", "views": 100, "pub": 1700000000000}], "trends": [], "news": [], "ours": [], "recos": [], "roadmap": []}})
            generated = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)
            tracked = {"vid": "abcdefghijk", "title": "Tracked", "views": 101, "pub": 1700000000000}
            owned = {"vid": "zyxwvutsrqp", "title": "New Lofi Girl upload", "views": 200, "pub": generated, "durH": 1.0, "source": "Official Lofi Girl daily scan"}
            artifact = {"version": 1, "generated_ms": generated, "shard": 0, "shards": 1, "tracked_total": 1, "tracked_ok": 1, "tracked_ids": ["abcdefghijk"], "tracked_fresh_ids": ["abcdefghijk"], "queries_total": 1, "queries_ok": 1, "queries_raw": 1, "queries_enriched": 1, "fresh": [tracked, owned], "owned_fresh": [owned], "candidates": []}
            (shards / "youtube-shard-0.json").write_text(json.dumps(artifact), encoding="utf-8")
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
            self.assertEqual(merged["d"]["ours"][0]["vid"], "zyxwvutsrqp")
            history = json.loads((root / "video_history" / "7a.json").read_text(encoding="utf-8"))
            self.assertEqual(history["d"]["zyxwvutsrqp"], [[generated, 200]])

    def test_avatar_overlay_links_handle_to_channel_id_without_overwriting_atlas(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "avatars.js"
            count = radar.write_avatar_overlay(
                {
                    "d": {
                        "all": [{
                            "chUrl": "https://www.youtube.com/@FocusChannel",
                            "channelId": "UC1234567890123456789012",
                        }],
                        "trends": [],
                        "news": [],
                    }
                },
                output,
            )
            rendered = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn('"@FocusChannel":"UC1234567890123456789012"', rendered)
        self.assertIn("if(!atlas.channels[key])", rendered)

    def test_recent_search_uses_month_filter_and_enriches_results(self):
        now = int(datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000)

        class FlatSearch:
            url = None

            def extract_info(self, url, download=False):
                self.url = url
                return {"entries": [{"id": "abcdefghijk"}]}

        class FullVideo:
            def extract_info(self, url, download=False):
                return {
                    "id": "abcdefghijk",
                    "title": "Long focus mix",
                    "view_count": 20_000,
                    "duration": 3600,
                    "upload_date": "20260719",
                    "channel": "Focus Channel",
                }

        flat = FlatSearch()
        with patch.object(radar, "search_ydl", return_value=flat), patch.object(
            radar, "ydl", return_value=FullVideo()
        ):
            rows, raw, enriched = radar.fetch_search(
                {"query": "focus music", "genre": "Ambient", "cluster": "Focus"}, now
            )
        self.assertIn("sp=EgIIBA%3D%3D", flat.url)
        self.assertEqual((raw, enriched, len(rows)), (1, 1, 1))
        self.assertEqual(rows[0]["rank"], 1)
        self.assertEqual(rows[0]["added"], now)

    def test_news_view_floor_is_100k_and_prunes_legacy_rows(self):
        data = {
            "news": [
                {"vid": "abcdefghijk", "views": 99_999},
                {"vid": "zyxwvutsrqp", "views": 100_000},
                {"vid": "mnopqrstuvw", "views": 250_000},
            ]
        }
        removed = radar.prune_news_below_view_floor(data)
        self.assertEqual(radar.MIN_NEWS_VIEWS, 100_000)
        self.assertEqual(removed, 1)
        self.assertEqual(
            [row["vid"] for row in data["news"]],
            ["zyxwvutsrqp", "mnopqrstuvw"],
        )

    def test_merge_rejects_99999_views_and_accepts_100000(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "Lofi_Radar_data.js"
            avatars = root / "avatars.js"
            shards = root / "shards"
            shards.mkdir()
            generated = int(
                datetime(2026, 7, 20, 8, tzinfo=timezone.utc).timestamp() * 1000
            )
            radar.write_snapshot(
                snapshot,
                {
                    "t": 1,
                    "d": {
                        "all": [{"vid": "abcdefghijk", "views": 1_000_000}],
                        "trends": [],
                        "news": [],
                        "ours": [],
                        "recos": [],
                        "roadmap": [],
                    },
                },
            )
            artifact = {
                "version": 1,
                "generated_ms": generated,
                "shard": 0,
                "shards": 1,
                "tracked_total": 1,
                "tracked_ok": 1,
                "tracked_ids": ["abcdefghijk"],
                "tracked_fresh_ids": ["abcdefghijk"],
                "queries_total": 1,
                "queries_ok": 1,
                "queries_raw": 2,
                "queries_enriched": 2,
                "fresh": [{"vid": "abcdefghijk", "views": 1_000_001}],
                "candidates": [
                    {
                        "vid": "zyxwvutsrqp",
                        "title": "Below floor",
                        "views": 99_999,
                        "ageM": 1,
                        "vpm": 99_999,
                        "kw": "focus music",
                    },
                    {
                        "vid": "mnopqrstuvw",
                        "title": "At floor",
                        "views": 100_000,
                        "ageM": 1,
                        "vpm": 100_000,
                        "kw": "focus music",
                    },
                ],
            }
            (shards / "youtube-shard-0.json").write_text(
                json.dumps(artifact), encoding="utf-8"
            )
            radar.merge_artifacts(snapshot, avatars, shards, 1)
            merged = radar.read_snapshot(snapshot)
        self.assertEqual(
            [row["vid"] for row in merged["d"]["news"]],
            ["mnopqrstuvw"],
        )

    def test_watchdog_requires_today_history_and_publish_thresholds(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "snapshot.js"
            stamp = int(datetime(2026, 7, 28, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {
                "videoMetricsT": stamp,
                "videoMetrics": {
                    "tracked": 1000,
                    "updated": 1000,
                    "keywords": 100,
                    "keywords_ok": 100,
                    "history_updated": 1000,
                    "history_day": "2026-07-28",
                    "day_timezone": "Europe/Paris",
                    "partial": False,
                },
                "d": {},
            })
            healthy = radar.snapshot_freshness(snapshot, stamp + 3600000)
            stale = radar.snapshot_freshness(snapshot, stamp + 24 * 3600000)
            partial_payload = radar.read_snapshot(snapshot)
            partial_payload["videoMetrics"].update({"updated": 999, "history_updated": 999, "partial": True})
            radar.write_snapshot(snapshot, partial_payload)
            partial = radar.snapshot_freshness(snapshot, stamp + 3600000)
        self.assertTrue(healthy["fresh"])
        self.assertFalse(stale["fresh"])
        self.assertFalse(partial["fresh"])

    def test_pages_verifier_requires_both_snapshot_and_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot.js"
            history_dir = root / "video_history"
            history_dir.mkdir()
            stamp = int(datetime(2026, 7, 28, 8, tzinfo=timezone.utc).timestamp() * 1000)
            radar.write_snapshot(snapshot, {"videoMetricsT": stamp, "d": {}})
            pool = root / "Lofi_Radar_recommendation_pool.js"
            pool.write_text(
                radar.POOL_PREFIX + json.dumps({"sourceT": stamp, "items": [{}] * 1001}) + ";\n",
                encoding="utf-8",
            )
            (history_dir / "61.json").write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {}}),
                encoding="utf-8",
            )
            (history_dir / "62.json").write_text(
                json.dumps({"version": 1, "updated": stamp, "d": {}}),
                encoding="utf-8",
            )

            class Response(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    self.close()

            responses = iter([
                Response(snapshot.read_bytes()),
                Response(pool.read_bytes()),
                Response((history_dir / "61.json").read_bytes()),
                Response((history_dir / "62.json").read_bytes()),
            ])
            with patch.object(radar.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: next(responses)):
                result = radar.verify_publication(
                    "https://example.test/radar/",
                    snapshot,
                    history_dir,
                    timeout_seconds=1,
                    interval_seconds=1,
                )
        self.assertTrue(result["published"])
        self.assertEqual(result["recommendations"], 1001)
        self.assertEqual(result["snapshot"], stamp)
        self.assertEqual(result["history_min"], stamp)
        self.assertEqual(result["history_shards"], 2)


if __name__ == "__main__":
    unittest.main()

