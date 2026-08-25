#!/usr/bin/env python3
"""Prune known non-runtime payloads from an explicit Jekyll ``_site`` tree."""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


TIMESTAMPED_SNAPSHOT_RE = re.compile(
    r"^Spotify_Soundcharts_data_\d{8}T\d{4,6}Z?"
    r"(?:[._-][A-Za-z0-9._-]+)?\.js$"
)
SNAPSHOT_REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])"
    r"(Spotify_Soundcharts_data_[A-Za-z0-9][A-Za-z0-9._-]*\.js)"
    r"(?![A-Za-z0-9_.-])"
)
PRIVATE_ROOT_FILE_NAMES = {"soundcharts-instrumental-cache.json"}
PRIVATE_ROOT_DIRECTORY_NAMES = {
    "soundcharts-history",
    "sr-prospects",
    "tests",
    "__pycache__",
}
NON_RUNTIME_ROOT_SUFFIXES = {".py", ".csv"}


@dataclass(frozen=True)
class PruneResult:
    kept_snapshots: tuple[str, ...]
    removed_snapshots: tuple[str, ...]
    removed_payloads: tuple[str, ...]


def _validated_site_dir(site_dir: str | Path) -> Path:
    raw = Path(site_dir)
    if raw.name != "_site":
        raise ValueError("site directory must be an explicit path ending in '_site'")
    if raw.is_symlink():
        raise ValueError("site directory must not be a symbolic link")
    try:
        resolved = raw.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ValueError(f"site directory does not exist: {raw}") from exc
    if resolved.name != "_site" or not resolved.is_dir():
        raise ValueError("site directory must resolve to a real '_site' directory")
    return resolved


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _referenced_snapshot_names(index_path: Path) -> set[str]:
    html = index_path.read_text(encoding="utf-8")
    return set(SNAPSHOT_REFERENCE_RE.findall(html))


def prune_pages_artifact(site_dir: str | Path) -> PruneResult:
    """Prune one generated Pages tree without touching the source checkout.

    Every validation is completed before the first deletion. This prevents a
    malformed build from partially pruning its artefact before failing.
    """

    root = _validated_site_dir(site_dir)
    spotify_index = root / "spotify" / "index.html"
    if not spotify_index.is_file() or spotify_index.is_symlink():
        raise ValueError("missing regular _site/spotify/index.html")

    referenced = _referenced_snapshot_names(spotify_index)
    missing_referenced = sorted(
        name
        for name in referenced
        if not (root / name).is_file() or (root / name).is_symlink()
    )
    if missing_referenced:
        raise ValueError(
            "referenced Soundcharts snapshot is missing: "
            + ", ".join(missing_referenced)
        )

    timestamped_paths = sorted(
        (
            path
            for path in root.iterdir()
            if TIMESTAMPED_SNAPSHOT_RE.fullmatch(path.name)
        ),
        key=lambda path: path.name,
    )
    unsafe_snapshots = [
        path.name
        for path in timestamped_paths
        if path.is_symlink() or not path.is_file()
    ]
    if unsafe_snapshots:
        raise ValueError(
            "versioned Soundcharts snapshot is not a regular file: "
            + ", ".join(unsafe_snapshots)
        )
    timestamped = [path.name for path in timestamped_paths]
    if referenced and not timestamped:
        raise ValueError("no versioned Spotify Soundcharts snapshot found in _site")

    # The lightweight Spotify runtime no longer publishes Soundcharts exports.
    # When no public HTML references one, remove every historical snapshot
    # instead of retaining a multi-megabyte file that the browser never uses.
    latest = timestamped[-1] if timestamped else None
    kept_snapshots = referenced | ({latest} if referenced and latest else set())
    removed_snapshots = tuple(
        name for name in timestamped if name not in kept_snapshots
    )

    payload_paths: list[Path] = []
    for name in sorted(PRIVATE_ROOT_FILE_NAMES | PRIVATE_ROOT_DIRECTORY_NAMES):
        path = root / name
        if path.exists() or path.is_symlink():
            payload_paths.append(path)
    for path in root.iterdir():
        if (
            path.name not in PRIVATE_ROOT_FILE_NAMES
            and path.name not in PRIVATE_ROOT_DIRECTORY_NAMES
            and path.suffix.lower() in NON_RUNTIME_ROOT_SUFFIXES
            and (path.is_file() or path.is_symlink())
        ):
            payload_paths.append(path)

    for name in removed_snapshots:
        _remove_path(root / name)
    for path in sorted(payload_paths, key=lambda item: item.name):
        _remove_path(path)

    return PruneResult(
        kept_snapshots=tuple(sorted(kept_snapshots)),
        removed_snapshots=removed_snapshots,
        removed_payloads=tuple(sorted(path.name for path in payload_paths)),
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--site-dir",
        required=True,
        help="Explicit path to the generated _site directory",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        result = prune_pages_artifact(args.site_dir)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"Pages artifact pruning refused: {exc}", file=sys.stderr)
        return 1
    print(
        "Pages artifact pruned: "
        f"kept {len(result.kept_snapshots)} Soundcharts snapshot(s), "
        f"removed {len(result.removed_snapshots)} old snapshot(s) and "
        f"{len(result.removed_payloads)} known non-runtime payload(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
