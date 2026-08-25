import tempfile
import unittest
from pathlib import Path

import prune_pages_artifact as pages_artifact


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = (ROOT / ".github/workflows/deploy-pages.yml").read_text(encoding="utf-8")


class PrunePagesArtifactTests(unittest.TestCase):
    def make_site(self, parent: Path, references: tuple[str, ...]) -> Path:
        site = parent / "_site"
        (site / "spotify").mkdir(parents=True)
        scripts = "\n".join(
            f'<script src="../{name}?v=test"></script>' for name in references
        )
        (site / "spotify" / "index.html").write_text(scripts, encoding="utf-8")
        return site

    def test_keeps_every_active_reference_and_latest_staged_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            site = self.make_site(
                Path(temporary),
                (
                    "Spotify_Soundcharts_data_20260802T080000Z.js",
                    "Spotify_Soundcharts_data_20260803T080000Z.js",
                ),
            )
            names = (
                "Spotify_Soundcharts_data_20260801T080000Z.js",
                "Spotify_Soundcharts_data_20260802T080000Z.js",
                "Spotify_Soundcharts_data_20260803T080000Z.js",
                "Spotify_Soundcharts_data_20260806T120701Z.js",
            )
            for name in names:
                (site / name).write_text(name, encoding="utf-8")
            (site / "Spotify_Soundcharts_data.js").write_text(
                "canonical runtime", encoding="utf-8"
            )
            (site / "application.js").write_text("runtime", encoding="utf-8")

            result = pages_artifact.prune_pages_artifact(site)

            self.assertEqual(
                result.kept_snapshots,
                (
                    "Spotify_Soundcharts_data_20260802T080000Z.js",
                    "Spotify_Soundcharts_data_20260803T080000Z.js",
                    "Spotify_Soundcharts_data_20260806T120701Z.js",
                ),
            )
            self.assertFalse((site / names[0]).exists())
            for name in names[1:]:
                self.assertTrue((site / name).is_file())
            self.assertTrue((site / "Spotify_Soundcharts_data.js").is_file())
            self.assertTrue((site / "application.js").is_file())

    def test_prunes_only_known_private_and_root_non_runtime_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            site = self.make_site(
                Path(temporary),
                ("Spotify_Soundcharts_data_20260805T080000Z.js",),
            )
            (site / "Spotify_Soundcharts_data_20260805T080000Z.js").write_text(
                "active", encoding="utf-8"
            )
            (site / "Spotify_Soundcharts_data_20260806T080000Z.js").write_text(
                "staged", encoding="utf-8"
            )
            (site / "Spotify_Soundcharts_data_20260801T080000Z.js").write_text(
                "old", encoding="utf-8"
            )
            (site / "soundcharts-instrumental-cache.json").write_text(
                "private", encoding="utf-8"
            )
            for directory in (
                "soundcharts-history",
                "sr-prospects",
                "tests",
                "__pycache__",
            ):
                (site / directory).mkdir()
                (site / directory / "private.txt").write_text(
                    "private", encoding="utf-8"
                )
            (site / "collector.py").write_text("private", encoding="utf-8")
            (site / "baseline.csv").write_text("private", encoding="utf-8")
            (site / "runtime.json").write_text("keep", encoding="utf-8")
            (site / "assets").mkdir()
            (site / "assets" / "runtime.py").write_text("keep", encoding="utf-8")

            result = pages_artifact.prune_pages_artifact(site)

            self.assertEqual(
                result.removed_snapshots,
                ("Spotify_Soundcharts_data_20260801T080000Z.js",),
            )
            for name in (
                "soundcharts-instrumental-cache.json",
                "soundcharts-history",
                "sr-prospects",
                "tests",
                "__pycache__",
                "collector.py",
                "baseline.csv",
            ):
                self.assertFalse((site / name).exists(), name)
            self.assertTrue((site / "runtime.json").is_file())
            self.assertTrue((site / "assets" / "runtime.py").is_file())

    def test_path_and_snapshot_validation_fail_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            wrong = parent / "site"
            wrong.mkdir()
            with self.assertRaisesRegex(ValueError, "ending in '_site'"):
                pages_artifact.prune_pages_artifact(wrong)

            site = self.make_site(
                parent,
                ("Spotify_Soundcharts_data_20260805T080000Z.js",),
            )
            private = site / "soundcharts-instrumental-cache.json"
            private.write_text("must survive failed validation", encoding="utf-8")
            (site / "Spotify_Soundcharts_data_20260806T080000Z.js").write_text(
                "staged", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "snapshot is missing"):
                pages_artifact.prune_pages_artifact(site)
            self.assertTrue(private.is_file())

            (site / "spotify" / "index.html").write_text(
                "no snapshot reference", encoding="utf-8"
            )
            (site / "Spotify_Soundcharts_data_20260806T080000Z.js").unlink()
            result = pages_artifact.prune_pages_artifact(site)
            self.assertEqual(result.kept_snapshots, ())
            self.assertFalse(private.exists())

    def test_lightweight_runtime_removes_all_unreferenced_soundcharts_snapshots(self):
        with tempfile.TemporaryDirectory() as temporary:
            site = self.make_site(Path(temporary), ())
            names = (
                "Spotify_Soundcharts_data_20260805T080000Z.js",
                "Spotify_Soundcharts_data_20260806T080000Z.js",
            )
            for name in names:
                (site / name).write_text("unused", encoding="utf-8")

            result = pages_artifact.prune_pages_artifact(site)

            self.assertEqual(result.kept_snapshots, ())
            self.assertEqual(result.removed_snapshots, names)
            for name in names:
                self.assertFalse((site / name).exists())

    def test_workflow_prunes_after_build_and_before_upload(self):
        build = DEPLOY.index("actions/jekyll-build-pages@v1")
        ownership = DEPLOY.index('sudo chown -R "$(id -u):$(id -g)" ./_site')
        prune = DEPLOY.index("python prune_pages_artifact.py --site-dir ./_site")
        upload = DEPLOY.index("actions/upload-pages-artifact@v4")
        self.assertLess(build, ownership)
        self.assertLess(ownership, prune)
        self.assertLess(prune, upload)


if __name__ == "__main__":
    unittest.main()
