import datetime as dt
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import import_youtube_studio_export as subject


def decode_snapshot(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith(subject.OUTPUT_PREFIX):
        raise AssertionError("missing STUDIO_DATA prefix")
    return json.loads(raw[len(subject.OUTPUT_PREFIX) :].strip().removesuffix(";"))


class YoutubeStudioImportTests(unittest.TestCase):
    def test_zip_import_keeps_only_complete_measured_rows_and_preserves_leading_dash_id(self):
        table = "\n".join(
            [
                "Rapport YouTube Studio 365 jours",
                "Contenu;Vues;Impressions;Taux de clics par impression (%);Durée moyenne de visionnage;Pourcentage moyen regardé (%)",
                " -Abc_def12X ;1\u202f234;12\u202f345;6,58 %;1:11:11,270;14,82 %",
                "UJs6__K7gSY;0;0;0 %;0:00;0 %",
                "incomplete1;99;100;;0:30;20 %",
                "Total;1\u202f333;12\u202f445;6,00 %;1:00;15 %",
            ]
        )
        fixed_scan = dt.datetime(2026, 7, 28, 16, 30, tzinfo=dt.timezone.utc)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "studio.zip"
            output = root / "studio.js"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("notes.csv", "Name,Value\nperiod,365 days\n")
                bundle.writestr("export/Informations relatives aux tableaux.csv", table.encode("utf-8-sig"))
            payload = subject.import_studio_export(
                archive,
                output,
                dt.date(2026, 7, 27),
                scan_at=fixed_scan,
            )
            written = decode_snapshot(output)

        self.assertEqual(payload, written)
        self.assertEqual(payload["t"], 1_785_256_200_000)
        self.assertEqual(payload["label"], "365 days · as of 27 Jul 2026")
        self.assertEqual(payload["dataThrough"], "2026-07-27")
        self.assertEqual(payload["scanAt"], "2026-07-28T16:30:00Z")
        self.assertEqual(set(payload["d"]), {"-Abc_def12X", "UJs6__K7gSY"})
        self.assertEqual(
            payload["d"]["-Abc_def12X"],
            {"views": 1234, "imp": 12345, "ctr": 6.58, "awtMs": 4_271_270, "awp": 14.82},
        )
        self.assertEqual(
            payload["d"]["UJs6__K7gSY"],
            {"views": 0, "imp": 0, "ctr": 0.0, "awtMs": 0, "awp": 0.0},
        )
        self.assertEqual(
            payload["coverage"],
            {
                "sourceFile": "export/Informations relatives aux tableaux.csv",
                "sourceRows": 3,
                "completeRows": 2,
                "includedVideos": 2,
                "incompleteRows": 1,
                "invalidRows": 0,
                "totalRowsIgnored": 1,
                "duplicateRows": 0,
            },
        )

    def test_direct_english_csv_supports_grouped_counts_and_cli_requires_explicit_paths(self):
        csv_text = "\n".join(
            [
                "Content,Views,Impressions,Impressions click-through rate (%),Average view duration,Average percentage viewed (%)",
                '8b3fqIBrNW0,"1,438,625","20,896,765",4.34%,47:08.743,19.25%',
                "missing0001,10,100,2.5%,,11%",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "Table data.csv"
            output = root / "result.js"
            source.write_text(csv_text, encoding="utf-8")
            exit_code = subject.main(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--data-through",
                    "2026-07-27",
                ]
            )
            payload = decode_snapshot(output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            payload["d"],
            {
                "8b3fqIBrNW0": {
                    "views": 1_438_625,
                    "imp": 20_896_765,
                    "ctr": 4.34,
                    "awtMs": 2_828_743,
                    "awp": 19.25,
                }
            },
        )
        self.assertEqual(payload["coverage"]["incompleteRows"], 1)

    def test_export_without_a_complete_row_is_rejected_before_output(self):
        csv_text = "\n".join(
            [
                "Content,Views,Impressions,Impressions click-through rate (%),Average view duration,Average percentage viewed (%)",
                "UJs6__K7gSY,100,1000,,1:00,20%",
                "Total,100,1000,5%,1:00,20%",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "Table data.csv"
            output = root / "result.js"
            source.write_text(csv_text, encoding="utf-8")
            with self.assertRaises(subject.StudioImportError):
                subject.import_studio_export(source, output, dt.date(2026, 7, 27))
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
