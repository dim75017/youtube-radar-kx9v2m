#!/usr/bin/env python3
"""Split the monolithic dashboard HTML into cacheable CSS/JS assets.

This is a one-shot migration helper used on a feature branch. It preserves the
order and exact contents of every inline classic script in <body>, while leaving
small head bootstrap/speculation scripts untouched.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "index.html"
CSS_DIR = ROOT / "assets" / "css"
JS_DIR = ROOT / "assets" / "js"
CSS_PATH = CSS_DIR / "dashboard.css"

STYLE_RE = re.compile(r"<style(?P<attrs>[^>]*)>(?P<code>.*?)</style>", re.IGNORECASE | re.DOTALL)
SCRIPT_RE = re.compile(r"<script(?P<attrs>[^>]*)>(?P<code>.*?)</script>", re.IGNORECASE | re.DOTALL)
MARKER_RE = re.compile(r"/\*\s*=+\s*([^*\n=]+?)\s*=+\s*\*/")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:48] or "section"


def ensure_single_stylesheet(text: str) -> tuple[str, str]:
    body_match = re.search(r"<body\b", text, re.IGNORECASE)
    if not body_match:
        raise RuntimeError("index.html has no <body> tag")

    matches = [m for m in STYLE_RE.finditer(text) if m.start() < body_match.start()]
    movable = [m for m in matches if not m.group("attrs").strip()]
    if len(movable) != 1:
        raise RuntimeError(f"Expected one plain <style> block in <head>, found {len(movable)}")

    match = movable[0]
    css = match.group("code")
    if css.startswith("\n"):
        css = css[1:]
    css = css.rstrip() + "\n"
    replacement = '<link rel="stylesheet" href="assets/css/dashboard.css">'
    return text[: match.start()] + replacement + text[match.end() :], css


def split_body_scripts(text: str) -> tuple[str, list[tuple[Path, str]]]:
    body_match = re.search(r"<body\b", text, re.IGNORECASE)
    if not body_match:
        raise RuntimeError("index.html has no <body> tag")

    body_start = body_match.start()
    candidates = []
    for match in SCRIPT_RE.finditer(text):
        if match.start() <= body_start:
            continue
        attrs = match.group("attrs").strip()
        if re.search(r"\bsrc\s*=", attrs, re.IGNORECASE):
            continue
        # Leave special/non-classic inline scripts in place. The current page's
        # body scripts are all plain classic scripts, but this protects future
        # JSON/import-map/template blocks from being externalised accidentally.
        if attrs:
            continue
        candidates.append(match)

    if not candidates:
        raise RuntimeError("No plain inline <body> scripts found")

    generated: list[tuple[Path, str]] = []
    replacements: list[tuple[int, int, str]] = []
    used_slugs: dict[str, int] = {}

    for index, match in enumerate(candidates, start=1):
        code = match.group("code")
        marker = MARKER_RE.search(code)
        base_slug = slugify(marker.group(1)) if marker else "section"
        used_slugs[base_slug] = used_slugs.get(base_slug, 0) + 1
        suffix = "" if used_slugs[base_slug] == 1 else f"-{used_slugs[base_slug]}"
        filename = f"dashboard-{index:02d}-{base_slug}{suffix}.js"
        relative = Path("assets") / "js" / filename

        if code.startswith("\n"):
            code = code[1:]
        code = code.rstrip() + "\n"
        generated.append((ROOT / relative, code))
        replacements.append(
            (match.start(), match.end(), f'<script src="{relative.as_posix()}"></script>')
        )

    for start, end, replacement in reversed(replacements):
        text = text[:start] + replacement + text[end:]

    return text, generated


def validate(index_text: str, generated: list[tuple[Path, str]]) -> None:
    body_match = re.search(r"<body\b", index_text, re.IGNORECASE)
    assert body_match
    remaining_inline = [
        m
        for m in SCRIPT_RE.finditer(index_text)
        if m.start() > body_match.start()
        and not re.search(r"\bsrc\s*=", m.group("attrs"), re.IGNORECASE)
        and not m.group("attrs").strip()
    ]
    if remaining_inline:
        raise RuntimeError(f"{len(remaining_inline)} plain inline body script(s) remain")
    if "<style" in index_text.lower():
        raise RuntimeError("An inline <style> block remains")
    if len(generated) < 2:
        raise RuntimeError("Expected multiple JavaScript sections")
    for path, code in generated:
        if not code.strip():
            raise RuntimeError(f"Generated empty asset: {path.relative_to(ROOT)}")
        reference = path.relative_to(ROOT).as_posix()
        if f'src="{reference}"' not in index_text:
            raise RuntimeError(f"Missing HTML reference for {reference}")


def main() -> None:
    original = INDEX.read_text(encoding="utf-8")
    with_css_link, css = ensure_single_stylesheet(original)
    refactored, scripts = split_body_scripts(with_css_link)
    validate(refactored, scripts)

    CSS_DIR.mkdir(parents=True, exist_ok=True)
    JS_DIR.mkdir(parents=True, exist_ok=True)

    # Remove only files generated by an earlier run of this migration helper.
    for old in JS_DIR.glob("dashboard-*.js"):
        old.unlink()

    CSS_PATH.write_text(css, encoding="utf-8", newline="\n")
    for path, code in scripts:
        path.write_text(code, encoding="utf-8", newline="\n")
    INDEX.write_text(refactored, encoding="utf-8", newline="\n")

    old_lines = original.count("\n") + 1
    new_lines = refactored.count("\n") + 1
    print(f"index.html: {old_lines} -> {new_lines} lines")
    print(f"CSS: {CSS_PATH.relative_to(ROOT)} ({css.count(chr(10))} lines)")
    print(f"JavaScript sections: {len(scripts)}")
    for path, code in scripts:
        print(f"  - {path.relative_to(ROOT)} ({code.count(chr(10))} lines)")


if __name__ == "__main__":
    main()
