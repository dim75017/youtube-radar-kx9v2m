"""Daily YouTube Radar refresh: discovery, current metrics and history.

The workflow runs this collector in deterministic shards, uploads one JSON
artifact per shard, then calls the same script with ``--merge-dir``.  Only the
merge phase writes the public snapshot, so partial scans never look fresh.
"""
from __future__ import annotations

import argparse
import atexit
import concurrent.futures
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from generate_youtube_recommendation_pool import POOL_PREFIX, write_recommendation_pool

ROOT = Path(__file__).resolve().parent
DEFAULT_SNAPSHOT = ROOT / "Lofi_Radar_data.js"
DEFAULT_AVATARS = ROOT / "Lofi_Radar_new_channel_avatars.js"
DEFAULT_HISTORY_DIR = ROOT / "video_history"
DEFAULT_RECOMMENDATION_POOL = ROOT / "Lofi_Radar_recommendation_pool.js"
RADAR_TIMEZONE_NAME = "Europe/Paris"
RADAR_TIMEZONE = ZoneInfo(RADAR_TIMEZONE_NAME)
DAILY_VIEW_HISTORY_START_MS = int(datetime(2026, 7, 20, tzinfo=RADAR_TIMEZONE).timestamp() * 1000)
SHEET_EXPORT = (
    "https://docs.google.com/spreadsheets/d/"
    "1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI/export?format=xlsx"
)

MIN_SECONDS = 20 * 60
MIN_ALL_VIEWS = 1_000_000
MIN_TREND_VIEWS = 500_000
MAX_TREND_AGE_MONTHS = 12
MIN_NEWS_VIEWS = 100_000
MIN_NEWS_VPM = 10_000
MAX_NEWS_AGE_MONTHS = 3
MAX_NEWS_ROWS = 1_000
MIN_KIDS_VIEWS = 100_000
MIN_KIDS_VPM = 5_000
SEARCH_RESULTS = int(os.environ.get("RADAR_SEARCH_RESULTS", "10"))
KIDS_SEARCH_RESULTS = int(os.environ.get("RADAR_KIDS_SEARCH_RESULTS", "50"))
KIDS_BOOTSTRAP_SEARCH_RESULTS = int(os.environ.get("RADAR_KIDS_BOOTSTRAP_RESULTS", "100"))
MAX_KIDS_SEARCH_CALLS = 80
KIDS_DOM_PAGE_LOAD_TIMEOUT_MS = int(os.environ.get("RADAR_KIDS_DOM_PAGE_TIMEOUT_MS", "15000"))
KIDS_DOM_SCRIPT_TIMEOUT_MS = int(os.environ.get("RADAR_KIDS_DOM_SCRIPT_TIMEOUT_MS", "5000"))
KIDS_DOM_HTTP_TIMEOUT_SECONDS = int(os.environ.get("RADAR_KIDS_DOM_HTTP_TIMEOUT_SECONDS", "20"))
KIDS_DOM_MARKER_WAIT_SECONDS = float(os.environ.get("RADAR_KIDS_DOM_MARKER_WAIT_SECONDS", "8"))
TRACK_WORKERS = int(os.environ.get("RADAR_TRACK_WORKERS", "12"))
SEARCH_WORKERS = int(os.environ.get("RADAR_SEARCH_WORKERS", "4"))
MIN_TRACK_RATIO = 0.90
MIN_PUBLISH_TRACK_RATIO = 0.99
MIN_KIDS_QUERY_RATIO = 0.95
HISTORY_RETENTION_DAYS = 400
OWN_CHANNEL_HANDLES = ("@LofiGirl",)
OWN_UPLOADS_PER_CHANNEL = 50
THREAD = threading.local()
YOUTUBE_API_RETRIES = int(os.environ.get("RADAR_YOUTUBE_API_RETRIES", "1"))

# Genre words such as "hip hop" are intentionally not rejected: this is an
# instrumental long-form radar.  We reject explicit vocal/performance signals.
VOCAL = re.compile(
    r"\b(?:lyrics?|lyric\s+video|official\s+(?:music\s+)?video|music\s+video|"
    r"vocals?|vocal\s+(?:mix|edit|version)|singer|singing|sung|rap(?:ping)?|"
    r"feat(?:uring)?\.?|ft\.?|acap+ella|a\s+cappella|live\s+performance|concert|"
    r"sing[ -]?along|karaoke|story\s*time|storytelling|bedtime\s+story|spoken|"
    r"voice[ -]?over|voices?|choir|choral|humming|mantra|narrat(?:ion|ed|or)|"
    r"podcast|guided|affirmations?|chanting|asmr)\b",
    re.I,
)
KIDS_AMBIGUOUS = re.compile(r"\b(?:songs?|nursery\s+rhymes?|lullab(?:y|ies))\b", re.I)
KIDS_STRONG_INSTRUMENTAL = re.compile(
    r"\b(?:instrumental|no\s+(?:lyrics?|vocals?)|without\s+vocals?|music\s+box|"
    r"piano|classical|ambient|soundscape|lofi|lo[ -]?fi|jazz|bossa|guitar|"
    r"chill\s+house|drum\s+(?:and|&)\s+bass|dnb|synthwave|background\s+music|"
    r"sleep\s+music|study\s+music|focus\s+music|relaxing\s+music|"
    r"calming\s+music|soothing\s+music)\b",
    re.I,
)
KIDS_EXPLICIT_INSTRUMENTAL = re.compile(
    r"\b(?:instrumental|no\s+(?:lyrics?|vocals?|voices?)|without\s+(?:lyrics?|vocals?|voices?)|music\s+box)\b",
    re.I,
)
NEGATED_VOCAL = re.compile(
    r"\b(?:no|without)\s+(?:lyrics?|vocals?|voices?)\b",
    re.I,
)
VIDEO_ID = re.compile(r"^[\w-]{11}$")
CHANNEL_ID = re.compile(r"^UC[\w-]{22}$")
ISO_DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)
WATCH_LENGTH_SECONDS = re.compile(r'"lengthSeconds"\s*:\s*"(?P<seconds>\d+)"')
DEFERRED_GENRE = re.compile(r"\bphonk\b", re.I)

KIDS_QUERY_EXCLUSIONS = (
    "-singalong -karaoke -storytime -storytelling "
    "-spoken -podcast -guided -affirmations -chanting -asmr"
)
KIDS_QUERY_SPECS = (
    ("baby sleep music instrumental", "Baby sleep", "Relaxation / meditation"),
    ("newborn sleep music instrumental", "Baby sleep", "Relaxation / meditation"),
    ("infant sleep music instrumental", "Baby sleep", "Relaxation / meditation"),
    ("toddler sleep music instrumental", "Baby sleep", "Relaxation / meditation"),
    ("kids bedtime music instrumental", "Baby sleep", "Relaxation / meditation"),
    ("nap time music for kids instrumental", "Baby sleep", "Relaxation / meditation"),
    ("instrumental lullabies for babies", "Baby sleep", "Relaxation / meditation"),
    ("baby music box no vocals", "Baby sleep", "Relaxation / meditation"),
    ("piano lullabies for babies instrumental", "Piano", "Relaxation / meditation"),
    ("calming music for babies instrumental", "Baby sleep", "Relaxation / meditation"),
    ("soothing baby music no lyrics", "Baby sleep", "Relaxation / meditation"),
    ("baby sensory music instrumental", "Kids background", "Relaxation / meditation"),
    ("relaxing music for toddlers instrumental", "Baby sleep", "Relaxation / meditation"),
    ("calm down music for kids instrumental", "Kids background", "Relaxation / meditation"),
    ("kids study music instrumental", "Kids focus", "Study / focus / work"),
    ("homework music for kids no lyrics", "Kids focus", "Study / focus / work"),
    ("focus music for children instrumental", "Kids focus", "Study / focus / work"),
    ("classroom background music instrumental", "Kids focus", "Study / focus / work"),
    ("preschool quiet time music instrumental", "Kids focus", "Study / focus / work"),
    ("playtime music for kids instrumental", "Kids background", "Relaxation / meditation"),
    ("daycare background music instrumental", "Kids background", "Relaxation / meditation"),
    ("Montessori music for children instrumental", "Kids background", "Study / focus / work"),
    ("reading music for kids instrumental", "Kids focus", "Study / focus / work"),
    ("drawing music for kids instrumental", "Kids focus", "Study / focus / work"),
    ("kids yoga music instrumental", "Kids background", "Relaxation / meditation"),
    ("baby lofi sleep music instrumental", "Lofi / chillhop", "Relaxation / meditation"),
    ("kids lofi study beats instrumental", "Lofi / chillhop", "Study / focus / work"),
    ("jazz for babies instrumental", "Jazz", "Relaxation / meditation"),
    ("classical music for babies instrumental", "Classical", "Relaxation / meditation"),
    ("piano music for babies instrumental", "Piano", "Relaxation / meditation"),
    ("ambient music for babies sleep instrumental", "Ambient", "Relaxation / meditation"),
    ("baby sleep music 8 hours instrumental", "Baby sleep", "Relaxation / meditation"),
    ("baby sleep music all night no vocals", "Baby sleep", "Relaxation / meditation"),
    ("toddler bedtime music 3 hours instrumental", "Baby sleep", "Relaxation / meditation"),
    ("kids study music 1 hour instrumental", "Kids focus", "Study / focus / work"),
    ("bossa nova for babies instrumental", "Jazz", "Relaxation / meditation"),
    ("guitar music for babies instrumental", "Guitar", "Relaxation / meditation"),
    ("chill house for kids instrumental", "Chill house", "Relaxation / meditation"),
    ("drum and bass for kids instrumental", "Drum & Bass", "Gaming / night drive"),
    ("synthwave for kids instrumental", "Synthwave", "Gaming / night drive"),
)
KIDS_DOM_POSITIVE_CANARIES = ("L1Y-GbKA0PM", "qXcMNBQnQMM")
KIDS_DOM_NEGATIVE_CANARY = "dQw4w9WgXcQ"

_KIDS_DOM_VALIDATOR = None
_KIDS_DOM_VALIDATOR_LOCK = threading.Lock()


def is_deferred_row(row: dict) -> bool:
    """Phonk is paused in the YouTube roadmap and must not re-enter the radar."""
    fields = ("genre", "title", "kw", "disc", "niche", "concept", "scene", "style", "channel")
    return bool(DEFERRED_GENRE.search(" ".join(str(row.get(field) or "") for field in fields)))


def prune_deferred_rows(data: dict) -> set[str]:
    """Remove paused genres from public buckets and return their video IDs."""
    dropped: set[str] = set()
    for bucket in ("all", "trends", "news", "ours", "kids"):
        visible = []
        for row in list(data.get(bucket) or []):
            if is_deferred_row(row):
                video_id = str(row.get("vid") or "")
                if VIDEO_ID.match(video_id):
                    dropped.add(video_id)
                continue
            visible.append(row)
        data[bucket] = visible
    for bucket in ("recos", "roadmap", "lives"):
        data[bucket] = [
            row for row in (data.get(bucket) or [])
            if not is_deferred_row(row) and str(row.get("vid") or "") not in dropped
        ]
    for bucket in ("hist", "liveHist", "liveHourly"):
        history = data.get(bucket)
        if isinstance(history, dict):
            for video_id in dropped:
                history.pop(video_id, None)
    return dropped


def prune_news_below_view_floor(data: dict) -> int:
    """Keep daily discoveries only once they reach the public view floor."""
    rows = list(data.get("news") or [])
    data["news"] = [
        row for row in rows if int(row.get("views") or 0) >= MIN_NEWS_VIEWS
    ]
    return len(rows) - len(data["news"])


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def atomic_write_text(path: Path, content: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def youtube_api_json(url: str, *, timeout: int = 30) -> dict:
    """Read JSON with one bounded retry for transient API failures."""
    for attempt in range(YOUTUBE_API_RETRIES + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                error_payload = json.loads(exc.read().decode("utf-8", "ignore"))
                reasons = {
                    str(item.get("reason") or "")
                    for item in ((error_payload.get("error") or {}).get("errors") or [])
                }
            except (ValueError, AttributeError):
                reasons = set()
            retryable = (
                exc.code == 429
                or exc.code >= 500
                or "rateLimitExceeded" in reasons
            ) and "quotaExceeded" not in reasons
            if not retryable or attempt >= YOUTUBE_API_RETRIES:
                raise
            retry_after = str((exc.headers or {}).get("Retry-After") or "")
            try:
                delay = max(float(retry_after), 0.5)
            except ValueError:
                delay = 1.0 + attempt * 0.75
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError):
            if attempt >= YOUTUBE_API_RETRIES:
                raise
            time.sleep(1.0 + attempt * 0.75)
    raise RuntimeError("YouTube API retry loop exhausted")


def parse_snapshot_text(raw: str) -> dict:
    return json.loads(re.sub(r"^window\.LOFI_DATA=", "", raw).rstrip(";\n"))


def read_snapshot(path: Path) -> dict:
    return parse_snapshot_text(path.read_text(encoding="utf-8"))


def write_snapshot(path: Path, payload: dict) -> None:
    atomic_write_text(
        path,
        "window.LOFI_DATA="
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";",
    )


def split_keywords(value: object) -> list[str]:
    return [part.strip() for part in re.split(r"\s*;\s*|[\r\n]+", str(value or "")) if part.strip()]


def stable_shard(value: str, shards: int) -> int:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % shards


def to_ms(info: dict) -> int | None:
    stamp = info.get("timestamp") or info.get("release_timestamp")
    if isinstance(stamp, (int, float)):
        return int(stamp * 1000)
    date = str(info.get("upload_date") or "")
    try:
        return int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def parse_iso_duration(value: str | None) -> float | None:
    match = ISO_DURATION.match(value or "")
    if not match:
        return None
    parts = {key: int(number or 0) for key, number in match.groupdict().items()}
    return float(
        parts["days"] * 86400
        + parts["hours"] * 3600
        + parts["minutes"] * 60
        + parts["seconds"]
    )


def parse_watch_duration(value: str) -> float | None:
    """Read YouTube's public lengthSeconds value without guessing a duration."""
    match = WATCH_LENGTH_SECONDS.search(value or "")
    if not match:
        return None
    seconds = int(match.group("seconds"))
    return float(seconds) if seconds > 0 else None


def fetch_public_duration(video_id: str) -> float | None:
    request = urllib.request.Request(
        f"https://www.youtube.com/watch?v={video_id}",
        headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return parse_watch_duration(response.read().decode("utf-8", "ignore"))


def owned_genre_from_title(title: object) -> str:
    """Classify only explicit genre words in an official upload title."""
    text = re.sub(r"[-_]", " ", str(title or "").casefold())
    if re.search(r"\b(?:halloween)\b", text) and re.search(r"\b(?:lofi|lo fi|chillhop)\b", text):
        return "Halloween Lofi"
    if re.search(r"\b(?:christmas|xmas)\b", text) and re.search(r"\b(?:lofi|lo fi|chillhop)\b", text):
        return "Christmas Lofi"
    rules = (
        (r"\b(?:lofi|lo fi|chillhop)\b", "Lofi / chillhop"),
        (r"\b(?:synthwave|retrowave|outrun)\b", "Synthwave"),
        (r"\b(?:drum and bass|drum bass|dnb|liquid jungle)\b", "Drum & Bass"),
        (r"\b(?:chill house|lofi house|lo fi house|deep house|ambient house|downtempo house)\b", "Chill house"),
        (r"\b(?:jazz|jazzhop|bossa)\b", "Jazz"),
        (r"\b(?:classical|baroque)\b", "Classical"),
        (r"\b(?:guitar|acoustic|fingerstyle)\b", "Guitar"),
        (r"\b(?:piano)\b", "Piano"),
        (r"\b(?:ambient|soundscape)\b", "Ambient"),
    )
    return next((label for pattern, label in rules if re.search(pattern, text)), "")


def kids_genre_from_metadata(row: dict) -> str:
    text = " ".join(
        str(row.get(key) or "")
        for key in ("title", "_scanDescription", "_scanTags")
    )
    explicit = owned_genre_from_title(text)
    if explicit:
        return explicit
    if re.search(r"\bmusic\s+box\b", text, re.I):
        return "Piano"
    return "Other / multi-genre"


def add_owned_metadata(row: dict) -> None:
    if not row.get("genre"):
        genre = owned_genre_from_title(row.get("title"))
        if genre:
            row["genre"] = genre
            row["genreSource"] = "title_explicit"


def age_months(published_ms: int | None, now_ms: int) -> float | None:
    if not published_ms:
        return None
    return max((now_ms - published_ms) / 2_629_746_000, 0.1)


def cluster_for(title: str, fallback: str = "") -> str:
    text = title.lower()
    if any(word in text for word in ("baby", "sleep", "bedtime", "lullaby", "nap time", "all night")):
        return "Sleep / night"
    if any(word in text for word in ("work", "focus", "study", "coding", "office")):
        return "Study / focus / work"
    if any(word in text for word in ("drive", "car", "night", "drift", "gym", "gaming")):
        return "Gaming / night drive"
    return fallback or "Relaxation / meditation"


def is_instrumental(info: dict) -> bool:
    duration = info.get("duration")
    if not isinstance(duration, (int, float)) or duration < MIN_SECONDS:
        return False
    text = " ".join(str(info.get(key) or "") for key in ("title", "description", "channel", "uploader"))
    return not has_vocal_signal(text)


def has_vocal_signal(text: str) -> bool:
    return bool(VOCAL.search(NEGATED_VOCAL.sub("", text or "")))


def is_kids_instrumental(row: dict) -> bool:
    """Fail closed for Kids: long-form, no vocal signals and clear instrumental metadata."""
    duration_hours = row.get("durH")
    if not isinstance(duration_hours, (int, float)) or duration_hours * 3600 < MIN_SECONDS:
        return False
    content_text = " ".join(
        str(row.get(key) or "")
        for key in ("title", "_scanDescription", "_scanTags")
    )
    negative_text = content_text + " " + str(row.get("channel") or "")
    if has_vocal_signal(negative_text):
        return False
    strong = bool(KIDS_STRONG_INSTRUMENTAL.search(content_text))
    explicit = bool(KIDS_EXPLICIT_INSTRUMENTAL.search(content_text))
    if KIDS_AMBIGUOUS.search(content_text) and not explicit:
        return False
    return strong and explicit


def is_kids_marker_href(href: object) -> bool:
    """Recognize only YouTube's two rendered Family Options destinations."""
    try:
        parsed = urllib.parse.urlparse(str(href or ""))
    except ValueError:
        return False
    host = (parsed.hostname or "").casefold()
    if parsed.scheme != "https":
        return False
    if host == "ytkids.app.goo.gl":
        return True
    return (
        host in {"youtube.com", "www.youtube.com"}
        and parsed.path == "/myfamily/"
        and parsed.fragment == "mf-compare"
    )


class KidsDomCanaryError(RuntimeError):
    """The rendered Family Options signal is not trustworthy in this process."""


class KidsDomProbeError(RuntimeError):
    """A rendered watch page could not produce a trustworthy yes/no answer."""


class ChromeWebDriverClient:
    """Minimal standard-library W3C WebDriver client; never reads page source."""

    _MARKER_SCRIPT = r"""
const expectedVideoId = arguments[0];
const visible = element => {
  if (!element || !element.isConnected || !element.getClientRects().length) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' &&
         style.visibility !== 'collapse' && Number(style.opacity || 1) > 0 &&
         element.getAttribute('aria-hidden') !== 'true';
};
const locationUrl = new URL(document.location.href);
if (locationUrl.hostname === 'consent.youtube.com' ||
    document.querySelector('ytd-consent-bump-v2-lightbox, form[action*="consent"], iframe[src*="recaptcha"], #captcha')) {
  return 'blocked';
}
if (locationUrl.pathname !== '/watch' || locationUrl.searchParams.get('v') !== expectedVideoId) {
  return 'loading';
}
const watch = document.querySelector('ytd-watch-flexy');
if (!watch || watch.getAttribute('video-id') !== expectedVideoId) return 'loading';
const marker = href => {
  try {
    const url = new URL(href, document.baseURI);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'ytkids.app.goo.gl' ||
      ((host === 'youtube.com' || host === 'www.youtube.com') &&
       url.pathname === '/myfamily/' && url.hash === '#mf-compare'));
  } catch (_) {
    return false;
  }
};
return Array.from(document.querySelectorAll('yt-video-metadata-carousel-view-model'))
  .some(card => visible(card) && Array.from(card.querySelectorAll('a[href]'))
    .some(link => marker(link.href))) ? 'marker' : 'ready';
"""

    def __init__(self) -> None:
        self.process: subprocess.Popen | None = None
        self.base_url = ""
        self.session_id = ""
        self._start()

    @staticmethod
    def _driver_path() -> str:
        configured = os.environ.get("CHROMEWEBDRIVER", "").strip()
        if configured:
            resolved = shutil.which(configured)
            if resolved:
                return resolved
            path = Path(configured).expanduser()
            if path.is_dir():
                for name in ("chromedriver", "chromedriver.exe"):
                    child = path / name
                    if child.is_file():
                        return str(child)
            if path.is_file():
                return str(path)
            raise RuntimeError(f"CHROMEWEBDRIVER does not exist: {configured}")
        resolved = shutil.which("chromedriver") or shutil.which("chromedriver.exe")
        if not resolved:
            raise RuntimeError("ChromeDriver not found via CHROMEWEBDRIVER or PATH")
        return resolved

    def _request(self, method: str, path: str, payload: dict | None = None) -> object:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            with urllib.request.urlopen(
                request, timeout=KIDS_DOM_HTTP_TIMEOUT_SECONDS
            ) as response:
                document = json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"WebDriver HTTP {exc.code}: {detail}") from exc
        if not isinstance(document, dict) or "value" not in document:
            raise RuntimeError("Malformed WebDriver response")
        value = document["value"]
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(
                f"WebDriver {value.get('error')}: {value.get('message') or 'unknown error'}"
            )
        return value

    def _start(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}"
        self.process = subprocess.Popen(
            [self._driver_path(), f"--port={port}", "--allowed-origins=*"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"ChromeDriver exited with code {self.process.returncode}")
            try:
                self._request("GET", "/status")
                break
            except Exception:
                time.sleep(0.1)
        else:
            self.close()
            raise RuntimeError("ChromeDriver did not become ready within 10 seconds")
        value = self._request("POST", "/session", {
            "capabilities": {
                "alwaysMatch": {
                    "browserName": "chrome",
                    "pageLoadStrategy": "eager",
                    "goog:chromeOptions": {
                        "args": [
                            "--headless=new",
                            "--disable-gpu",
                            "--disable-dev-shm-usage",
                            "--mute-audio",
                            "--no-sandbox",
                            "--autoplay-policy=user-gesture-required",
                            "--lang=en-US",
                            "--window-size=1280,900",
                        ]
                    },
                }
            }
        })
        if not isinstance(value, dict) or not value.get("sessionId"):
            self.close()
            raise RuntimeError("ChromeDriver did not return a session ID")
        self.session_id = str(value["sessionId"])
        self._request("POST", f"/session/{self.session_id}/timeouts", {
            "implicit": 0,
            "pageLoad": KIDS_DOM_PAGE_LOAD_TIMEOUT_MS,
            "script": KIDS_DOM_SCRIPT_TIMEOUT_MS,
        })

    def has_family_options_marker(self, video_id: str) -> bool:
        if not VIDEO_ID.fullmatch(video_id):
            return False
        base = f"/session/{self.session_id}"
        self._request("POST", base + "/url", {
            "url": f"https://www.youtube.com/watch?v={video_id}&hl=en"
        })
        started = time.monotonic()
        deadline = started + min(max(KIDS_DOM_MARKER_WAIT_SECONDS, 5), 8)
        last_state = "loading"
        while time.monotonic() < deadline:
            last_state = self._request("POST", base + "/execute/sync", {
                "script": self._MARKER_SCRIPT,
                "args": [video_id],
            })
            if last_state == "marker":
                return True
            if last_state == "blocked":
                raise KidsDomProbeError("YouTube watch page is blocked by consent or captcha")
            if last_state not in {"loading", "ready"}:
                raise KidsDomProbeError(f"Unexpected rendered watch-page state: {last_state!r}")
            if last_state == "ready" and time.monotonic() - started >= 5:
                return False
            time.sleep(0.25)
        if last_state == "ready":
            return False
        raise KidsDomProbeError("YouTube watch page did not load the expected video in time")

    def close(self) -> None:
        if self.session_id:
            try:
                self._request("DELETE", f"/session/{self.session_id}")
            except Exception:
                pass
            self.session_id = ""
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.process = None


class KidsDomValidator:
    """Serialize one Chrome session and fail all Kids queries if canaries drift."""

    def __init__(self, client: object | None = None) -> None:
        self._client = client
        self._lock = threading.Lock()
        self._canaries_checked = False
        self._canary_error = ""

    def _get_client(self) -> object:
        if self._client is None:
            self._client = ChromeWebDriverClient()
        return self._client

    def _probe(self, video_id: str) -> bool:
        return self._get_client().has_family_options_marker(video_id) is True

    def _check_canaries(self) -> None:
        if self._canaries_checked:
            if self._canary_error:
                raise KidsDomCanaryError(self._canary_error)
            return
        self._canaries_checked = True
        try:
            positives = {video_id: self._probe(video_id) for video_id in KIDS_DOM_POSITIVE_CANARIES}
            negative = self._probe(KIDS_DOM_NEGATIVE_CANARY)
            if not all(positives.values()) or negative:
                raise RuntimeError(
                    f"positive={positives}, negative={negative}"
                )
        except Exception as exc:
            self._canary_error = f"Kids DOM canaries failed closed: {type(exc).__name__}: {exc}"
            raise KidsDomCanaryError(self._canary_error) from exc

    def ensure_canaries(self) -> None:
        """Validate the rendered Kids signal even when a search has no candidates."""
        with self._lock:
            self._check_canaries()

    def is_made_for_kids(self, video_id: str) -> bool:
        with self._lock:
            self._check_canaries()
            try:
                return self._probe(video_id)
            except KidsDomProbeError:
                raise
            except Exception as exc:
                raise KidsDomProbeError(
                    f"Kids DOM verification failed for {video_id}: {type(exc).__name__}: {exc}"
                ) from exc

    def close(self) -> None:
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None


def kids_dom_validator() -> KidsDomValidator:
    global _KIDS_DOM_VALIDATOR
    with _KIDS_DOM_VALIDATOR_LOCK:
        if _KIDS_DOM_VALIDATOR is None:
            _KIDS_DOM_VALIDATOR = KidsDomValidator()
            atexit.register(_KIDS_DOM_VALIDATOR.close)
        return _KIDS_DOM_VALIDATOR


def ydl():
    if not hasattr(THREAD, "ydl"):
        import yt_dlp

        THREAD.ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "playlistend": SEARCH_RESULTS,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "ignore_no_formats_error": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.ydl


def search_ydl():
    if not hasattr(THREAD, "search_ydl"):
        import yt_dlp

        THREAD.search_ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": True,
                "playlistend": SEARCH_RESULTS,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.search_ydl


def kids_search_ydl(result_limit: int):
    """Flat yt-dlp search reader with an explicit Kids top-N cap."""
    import yt_dlp

    readers = getattr(THREAD, "kids_search_ydl", None)
    if readers is None:
        readers = {}
        THREAD.kids_search_ydl = readers
    if result_limit not in readers:
        readers[result_limit] = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": True,
                "playlistend": result_limit,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "cachedir": False,
                "geo_bypass_country": "US",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return readers[result_limit]


def owned_ydl():
    """Use a dedicated playlist reader so the official channel is not capped at 10 uploads."""
    if not hasattr(THREAD, "owned_ydl"):
        import yt_dlp

        THREAD.owned_ydl = yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": True,
                "playlistend": OWN_UPLOADS_PER_CHANNEL,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                "ignoreerrors": True,
                "cachedir": False,
                "geo_bypass_country": "FR",
                "extractor_args": {"youtube": {"lang": ["en"], "player_client": ["web"]}},
            }
        )
    return THREAD.owned_ydl


def info_to_row(info: dict, now_ms: int, *, genre: str = "", cluster: str = "", query: str = "") -> dict | None:
    video_id = str(info.get("id") or "")
    views = info.get("view_count")
    duration = info.get("duration")
    if not VIDEO_ID.match(video_id) or not isinstance(views, (int, float)):
        return None
    published = to_ms(info)
    age = age_months(published, now_ms)
    row = {
        "title": str(info.get("title") or "").strip(),
        "vid": video_id,
        "url": info.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
        "views": int(views),
        "channel": info.get("channel") or info.get("uploader") or "Unknown channel",
        "chUrl": info.get("channel_url") or info.get("uploader_url") or "",
    }
    channel_id = str(info.get("channel_id") or "")
    if CHANNEL_ID.match(channel_id):
        row["channelId"] = channel_id
    followers = info.get("channel_follower_count")
    if isinstance(followers, (int, float)) and followers > 0:
        row["subs"] = int(followers)
    if isinstance(duration, (int, float)):
        row["durH"] = float(duration) / 3600
    if published:
        row["pub"] = published
    if age is not None:
        row["ageM"] = age
        row["vpm"] = int(views) / age
    if genre:
        row["genre"] = genre
        row["cluster"] = cluster_for(row["title"], cluster)
    if query:
        row["kw"] = query
        row["kwCount"] = 1
        row["pattern"] = "Daily keyword scan"
        row["added"] = now_ms
    return row


def fetch_one_video(video_id: str, now_ms: int) -> dict | None:
    info = ydl().extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    return info_to_row(info or {}, now_ms)


def fetch_search(spec: dict, now_ms: int) -> tuple[list[dict], int, int]:
    # Current yt-dlp releases no longer expose ``ytsearchdate``.  Use the
    # actual YouTube "This month" search filter; known catalogue videos are
    # refreshed separately by ID, while this pass discovers new uploads.
    search_url = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote_plus(spec["query"])
        + "&sp=EgIIBA%3D%3D"
    )
    info = search_ydl().extract_info(search_url, download=False) or {}
    entries = [item for item in (info.get("entries") or []) if item]
    if not entries:
        raise RuntimeError("YouTube returned no raw search results")
    rows: list[dict] = []
    enriched = 0
    for rank, item in enumerate(entries, start=1):
        video_id = str(item.get("id") or "")
        if not VIDEO_ID.match(video_id):
            continue
        try:
            full = ydl().extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            ) or {}
        except Exception:
            continue
        if not full:
            continue
        enriched += 1
        if not is_instrumental(full):
            continue
        row = info_to_row(
            full,
            now_ms,
            genre=spec["genre"],
            cluster=spec["cluster"],
            query=spec["query"],
        )
        if row:
            row["rank"] = rank
            row["audiences"] = ["youtube"]
            rows.append(row)
    if enriched / len(entries) < 0.50:
        raise RuntimeError(f"Only {enriched}/{len(entries)} search results could be enriched")
    return rows, len(entries), enriched


def fetch_api_rows(
    video_ids: list[str],
    now_ms: int,
    key: str,
    *,
    include_scan_text: bool = False,
) -> dict[str, dict]:
    """Fast official metrics path when a YOUTUBE_API_KEY secret is present."""
    out: dict[str, dict] = {}
    for start in range(0, len(video_ids), 50):
        batch = video_ids[start : start + 50]
        query = urllib.parse.urlencode({
            "part": "snippet,contentDetails,statistics,status",
            "id": ",".join(batch),
            "key": key,
        })
        payload = youtube_api_json(
            "https://www.googleapis.com/youtube/v3/videos?" + query,
            timeout=30,
        )
        for item in payload.get("items") or []:
            snippet = item.get("snippet") or {}
            statistics = item.get("statistics") or {}
            duration = parse_iso_duration((item.get("contentDetails") or {}).get("duration"))
            try:
                published = int(
                    datetime.fromisoformat(snippet["publishedAt"].replace("Z", "+00:00")).timestamp()
                    * 1000
                )
                views = int(statistics["viewCount"])
            except (KeyError, TypeError, ValueError):
                continue
            age = age_months(published, now_ms)
            video_id = item.get("id")
            row = {
                "title": snippet.get("title") or "",
                "vid": video_id,
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "views": views,
                "pub": published,
                "ageM": age,
                "vpm": views / age if age else None,
                "channel": snippet.get("channelTitle") or "Unknown channel",
                "chUrl": f"https://www.youtube.com/channel/{snippet.get('channelId', '')}",
                "channelId": snippet.get("channelId") or "",
            }
            made_for_kids = (item.get("status") or {}).get("madeForKids")
            if isinstance(made_for_kids, bool):
                row["madeForKids"] = made_for_kids
            if duration is not None:
                row["durH"] = duration / 3600
            if include_scan_text:
                row["_scanDescription"] = snippet.get("description") or ""
                row["_scanTags"] = " ".join(snippet.get("tags") or [])
                row["_liveBroadcastContent"] = snippet.get("liveBroadcastContent") or "none"
            out[video_id] = row
    return out


def fetch_kids_search(spec: dict, now_ms: int, key: str) -> tuple[list[dict], int, int]:
    """Search the top long-form Kids candidates and validate every row officially."""
    if not key:
        raise RuntimeError("Kids discovery requires YOUTUBE_API_KEY")
    video_ids: list[str] = []
    ranks: dict[str, int] = {}
    page_token = ""
    result_limit = int(spec.get("searchResults") or KIDS_SEARCH_RESULTS)
    pages = 0
    max_pages = max(1, (result_limit + 49) // 50)
    while len(video_ids) < result_limit and pages < max_pages:
        pages += 1
        params: dict[str, object] = {
            "part": "snippet",
            "q": spec["query"] + " " + KIDS_QUERY_EXCLUSIONS,
            "type": "video",
            "order": "viewCount",
            "videoDuration": "long",
            "safeSearch": "strict",
            "relevanceLanguage": "en",
            "regionCode": "US",
            "maxResults": min(50, result_limit - len(video_ids)),
            "key": key,
        }
        if page_token:
            params["pageToken"] = page_token
        payload = youtube_api_payload("search", params)
        for item in payload.get("items") or []:
            video_id = str((item.get("id") or {}).get("videoId") or "")
            if VIDEO_ID.match(video_id) and video_id not in ranks:
                ranks[video_id] = len(video_ids) + 1
                video_ids.append(video_id)
                if len(video_ids) >= result_limit:
                    break
        page_token = str(payload.get("nextPageToken") or "")
        if not page_token or not payload.get("items"):
            break
    if not video_ids:
        raise RuntimeError("YouTube Data API returned no Kids search results")

    official = fetch_api_rows(
        video_ids,
        now_ms,
        key,
        include_scan_text=True,
    )
    rows: list[dict] = []
    for video_id in video_ids:
        row = official.get(video_id)
        if (
            not row
            or row.get("madeForKids") is not True
            or row.get("_liveBroadcastContent") != "none"
            or not is_kids_instrumental(row)
        ):
            continue
        row = dict(row)
        row["genre"] = kids_genre_from_metadata(row)
        row["cluster"] = cluster_for(row.get("title") or "", spec["cluster"])
        row["kw"] = spec["query"]
        row["kwCount"] = 1
        row["pattern"] = "Daily Kids keyword scan"
        row["added"] = now_ms
        row["rank"] = ranks[video_id]
        row["audiences"] = ["kids"]
        row.pop("_scanDescription", None)
        row.pop("_scanTags", None)
        row.pop("_liveBroadcastContent", None)
        rows.append(row)
    return rows, len(video_ids), len(official)


def is_kids_flat_candidate(info: dict) -> bool:
    """Cheap strict gate before any full extraction or rendered-page visit."""
    video_id = str(info.get("id") or "")
    title = str(info.get("title") or "").strip()
    duration = info.get("duration")
    views = info.get("view_count")
    live_status = str(info.get("live_status") or "").casefold()
    if (
        not VIDEO_ID.fullmatch(video_id)
        or not title
        or not isinstance(duration, (int, float))
        or duration < MIN_SECONDS
        or not isinstance(views, (int, float))
        or views < MIN_KIDS_VIEWS
        or info.get("is_live") is True
        or live_status in {"is_live", "is_upcoming", "post_live", "was_live"}
    ):
        return False
    title_only = {"title": title, "durH": float(duration) / 3600}
    return is_kids_instrumental(title_only)


def fetch_kids_search_ydl(spec: dict, now_ms: int) -> tuple[list[dict], int, int]:
    """No-key Kids fallback: flat search, strict enrichment, then rendered DOM truth."""
    result_limit = int(spec.get("searchResults") or KIDS_SEARCH_RESULTS)
    search = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote_plus(spec["query"] + " " + KIDS_QUERY_EXCLUSIONS)
        + "&sp=CAMSAhgC"
    )
    info = kids_search_ydl(result_limit).extract_info(search, download=False) or {}
    entries = [item for item in (info.get("entries") or []) if item]
    if not entries:
        raise RuntimeError("yt-dlp returned no raw Kids search results")
    prefiltered = [item for item in entries if is_kids_flat_candidate(item)]
    ranks = {str(item.get("id")): rank for rank, item in enumerate(entries, start=1)}
    validator = kids_dom_validator()
    validator.ensure_canaries()
    rows: list[dict] = []
    enriched = 0
    enrichment_attempts = 0
    enrichment_failures = 0
    for item in prefiltered:
        video_id = str(item.get("id") or "")
        if not validator.is_made_for_kids(video_id):
            continue
        enrichment_attempts += 1
        try:
            full = ydl().extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            ) or {}
        except Exception as exc:
            enrichment_failures += 1
            print(
                f"WARN Kids enrichment {video_id}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            continue
        if not full:
            enrichment_failures += 1
            continue
        enriched += 1
        if not is_kids_flat_candidate(full):
            continue
        row = info_to_row(full, now_ms)
        if not row:
            continue
        row["_scanDescription"] = str(full.get("description") or "")
        tags = full.get("tags") or []
        row["_scanTags"] = " ".join(str(value) for value in tags) if isinstance(tags, list) else str(tags)
        if (
            not is_kids_instrumental(row)
            or int(row.get("views") or 0) < MIN_KIDS_VIEWS
            or not isinstance(row.get("vpm"), (int, float))
            or float(row["vpm"]) < MIN_KIDS_VPM
        ):
            continue
        row["madeForKids"] = True
        row["madeForKidsSource"] = "youtube_family_options_ui"
        row["genre"] = kids_genre_from_metadata(row)
        row["cluster"] = cluster_for(row.get("title") or "", spec["cluster"])
        row["kw"] = spec["query"]
        row["kwCount"] = 1
        row["pattern"] = "Daily Kids keyword scan"
        row["added"] = now_ms
        row["rank"] = ranks[video_id]
        row["audiences"] = ["kids"]
        row.pop("_scanDescription", None)
        row.pop("_scanTags", None)
        rows.append(row)
    if enrichment_failures and (
        enrichment_failures >= 2 or enrichment_failures == enrichment_attempts
    ):
        raise RuntimeError(
            f"Kids enrichment failed closed for {enrichment_failures}/"
            f"{enrichment_attempts} DOM-positive candidates"
        )
    return rows, len(entries), enriched


def youtube_api_payload(path: str, params: dict[str, object]) -> dict:
    """Load one YouTube Data API response without exposing the API key in logs."""
    query = urllib.parse.urlencode(params)
    return youtube_api_json(
        "https://www.googleapis.com/youtube/v3/" + path + "?" + query,
        timeout=30,
    )


def fetch_owned_upload_ids(api_key: str) -> list[str]:
    """Return recent public uploads from the official Lofi Girl channel(s)."""
    ids: list[str] = []
    for handle in OWN_CHANNEL_HANDLES:
        channels = youtube_api_payload(
            "channels",
            {"part": "contentDetails", "forHandle": handle, "key": api_key},
        ).get("items") or []
        if not channels:
            raise RuntimeError(f"Official channel lookup returned no channel for {handle}")
        uploads = ((channels[0].get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
        if not uploads:
            raise RuntimeError(f"Official channel {handle} has no uploads playlist")
        page_token = ""
        while len(ids) < OWN_UPLOADS_PER_CHANNEL:
            params: dict[str, object] = {
                "part": "contentDetails",
                "playlistId": uploads,
                "maxResults": min(50, OWN_UPLOADS_PER_CHANNEL - len(ids)),
                "key": api_key,
            }
            if page_token:
                params["pageToken"] = page_token
            payload = youtube_api_payload("playlistItems", params)
            ids.extend(
                str((item.get("contentDetails") or {}).get("videoId") or "")
                for item in payload.get("items") or []
            )
            page_token = str(payload.get("nextPageToken") or "")
            if not page_token:
                break
    return list(dict.fromkeys(video_id for video_id in ids if VIDEO_ID.match(video_id)))


def fetch_owned_api_rows(now_ms: int, api_key: str) -> dict[str, dict]:
    """Refresh recent official uploads so Analyse cannot miss a new release."""
    rows = fetch_api_rows(fetch_owned_upload_ids(api_key), now_ms, api_key)
    if not rows:
        raise RuntimeError("Official Lofi Girl upload scan returned no usable videos")
    for row in rows.values():
        add_owned_metadata(row)
        row["source"] = "Official Lofi Girl daily scan"
    return rows


def fetch_owned_ydl_rows(now_ms: int) -> dict[str, dict]:
    """Fallback when the repository has no YouTube API secret configured."""
    info = owned_ydl().extract_info("https://www.youtube.com/@LofiGirl/videos", download=False) or {}
    ids = [
        str(item.get("id") or "")
        for item in info.get("entries") or []
        if item and VIDEO_ID.match(str(item.get("id") or ""))
    ]
    if not ids:
        raise RuntimeError("Official Lofi Girl channel returned no recent uploads")
    rows: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=TRACK_WORKERS) as pool:
        future_to_id = {pool.submit(fetch_one_video, video_id, now_ms): video_id for video_id in ids}
        for future in concurrent.futures.as_completed(future_to_id):
            row = future.result()
            if row:
                add_owned_metadata(row)
                row["source"] = "Official Lofi Girl daily scan"
                rows[row["vid"]] = row
    if not rows:
        raise RuntimeError("Official Lofi Girl upload scan returned no usable videos")
    # yt-dlp occasionally returns a valid counter without a duration. Keep the
    # newest upload complete by reading YouTube's public lengthSeconds field.
    latest = next((rows[video_id] for video_id in ids if video_id in rows), None)
    if latest and not isinstance(latest.get("durH"), (int, float)):
        try:
            duration = fetch_public_duration(latest["vid"])
            if duration is not None:
                latest["durH"] = duration / 3600
                latest["durationSource"] = "youtube_public_length"
        except Exception as exc:
            print(
                f"WARN official duration {latest['vid']}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
    return rows


def query_specs(payload: dict, *, include_kids: bool = True) -> list[dict]:
    votes: dict[str, dict[str, Counter]] = defaultdict(lambda: {"genre": Counter(), "cluster": Counter()})
    for bucket in ("all", "trends", "news"):
        for row in payload.get("d", {}).get(bucket, []):
            if is_deferred_row(row):
                continue
            for query in split_keywords(row.get("kw")):
                votes[query]["genre"][str(row.get("genre") or "Other")] += 1
                votes[query]["cluster"][str(row.get("cluster") or "Relaxation / meditation")] += 1
    regular = [
        {
            "query": query,
            "genre": data["genre"].most_common(1)[0][0],
            "cluster": data["cluster"].most_common(1)[0][0],
            "audience": "youtube",
        }
        for query, data in sorted(votes.items())
    ]
    if not include_kids:
        return regular
    kids_bootstrapped = bool(payload.get("d", {}).get("kids")) or int(
        (payload.get("videoMetrics") or {}).get("kids_queries") or 0
    ) >= len(KIDS_QUERY_SPECS)
    kids_result_limit = KIDS_SEARCH_RESULTS if kids_bootstrapped else KIDS_BOOTSTRAP_SEARCH_RESULTS
    search_calls = len(KIDS_QUERY_SPECS) * max(1, (kids_result_limit + 49) // 50)
    if search_calls > MAX_KIDS_SEARCH_CALLS:
        raise RuntimeError(
            f"Kids search budget exceeded: {search_calls}>{MAX_KIDS_SEARCH_CALLS} calls"
        )
    kids = [
        {
            "query": query,
            "genre": genre,
            "cluster": cluster,
            "audience": "kids",
            "searchResults": kids_result_limit,
        }
        for query, genre, cluster in KIDS_QUERY_SPECS
    ]
    return regular + kids


SHEET_VIDEO_TAB_FRAGMENTS = ("All Videos", "Trends", "News", "Our Videos")
SHEET_VIDEO_URL = re.compile(
    r"(?:watch\?v=|/vi/|youtu\.be/|/embed/|/shorts/)([\w-]{11})",
    re.I,
)


def sheet_cell_video_id(cell: object) -> str | None:
    """Read a YouTube ID from a raw ID, hyperlink target or HYPERLINK formula."""
    hyperlink = getattr(cell, "hyperlink", None)
    candidates = (
        getattr(cell, "value", None),
        getattr(hyperlink, "target", None) if hyperlink else None,
    )
    for candidate in candidates:
        text = str(candidate or "").strip()
        if VIDEO_ID.fullmatch(text):
            return text
        match = SHEET_VIDEO_URL.search(text)
        if match:
            return match.group(1)
    return None


def sheet_video_ids() -> set[str]:
    """Load every video ID that the live dashboard can display from the Sheet."""
    try:
        from openpyxl import load_workbook

        with urllib.request.urlopen(SHEET_EXPORT, timeout=45) as response:
            workbook = load_workbook(io.BytesIO(response.read()), read_only=True, data_only=False)
        titles = [
            name
            for name in workbook.sheetnames
            if any(fragment in name for fragment in SHEET_VIDEO_TAB_FRAGMENTS)
        ]
        if not any("Our Videos" in name for name in titles):
            raise RuntimeError("Our Videos tab is missing from the radar Sheet")
        ids: set[str] = set()
        for title in titles:
            max_col = 1 if "Our Videos" in title else 2
            for row in workbook[title].iter_rows(min_row=1, max_col=max_col):
                for cell in row:
                    video_id = sheet_cell_video_id(cell)
                    if video_id:
                        ids.add(video_id)
                        break
        if not ids:
            raise RuntimeError("No dashboard video ID found in the radar Sheet")
        return ids
    except Exception as exc:
        raise RuntimeError(
            f"Could not load the canonical dashboard video list: {type(exc).__name__}: {exc}"
        ) from exc


def tracked_ids(payload: dict) -> list[str]:
    unavailable = {
        str(video_id)
        for video_id in ((payload.get("videoMetrics") or {}).get("unavailable_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    ids = {
        str(row.get("vid"))
        for bucket in ("all", "trends", "news", "ours", "kids")
        for row in payload.get("d", {}).get(bucket, [])
        if not is_deferred_row(row)
        if VIDEO_ID.match(str(row.get("vid") or ""))
    }
    ids.update(sheet_video_ids())
    return sorted(ids - unavailable)


def write_tracked_manifest(snapshot: Path, output: Path) -> dict:
    """Resolve the canonical tracked set once for every parallel scan shard."""
    payload = read_snapshot(snapshot)
    ids = tracked_ids(payload)
    if not ids:
        raise RuntimeError("Canonical tracked-video manifest is empty")
    manifest = {
        "version": 1,
        "generated_ms": utc_now_ms(),
        "snapshot_metrics_ms": int(payload.get("videoMetricsT") or 0),
        "ids": ids,
        "quarantine_ids": sorted({
            str(video_id)
            for video_id in ((payload.get("videoMetrics") or {}).get("unavailable_ids") or [])
            if VIDEO_ID.match(str(video_id or ""))
        }),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(output, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"tracked_manifest": len(ids), "output": str(output)}))
    return manifest


def read_tracked_manifest(path: Path) -> list[str]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    ids = [str(video_id) for video_id in (manifest.get("ids") or []) if VIDEO_ID.match(str(video_id or ""))]
    if int(manifest.get("version") or 0) != 1 or not ids:
        raise RuntimeError(f"Invalid or empty tracked-video manifest: {path}")
    if len(ids) != len(set(ids)):
        raise RuntimeError(f"Duplicate IDs in tracked-video manifest: {path}")
    return sorted(ids)


def read_quarantine_manifest(path: Path) -> list[str]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    return sorted({
        str(video_id)
        for video_id in (manifest.get("quarantine_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    })


def merge_keyword_rows(rows: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    keywords: dict[str, set[str]] = defaultdict(set)
    ranks: dict[str, list[int]] = defaultdict(list)
    audiences: dict[str, set[str]] = defaultdict(set)
    kids_status: dict[str, list[bool]] = defaultdict(list)
    kids_sources: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        video_id = row["vid"]
        old = by_id.get(video_id)
        if not old or int(row.get("views") or 0) >= int(old.get("views") or 0):
            by_id[video_id] = dict(row)
        keywords[video_id].update(split_keywords(row.get("kw")))
        audiences[video_id].update(
            str(value).lower()
            for value in (row.get("audiences") or [])
            if str(value).lower() in {"youtube", "kids"}
        )
        if isinstance(row.get("madeForKids"), bool):
            kids_status[video_id].append(row["madeForKids"])
        if row.get("madeForKids") is True and row.get("madeForKidsSource"):
            kids_sources[video_id].add(str(row["madeForKidsSource"]))
        if isinstance(row.get("rank"), (int, float)):
            ranks[video_id].append(int(row["rank"]))
    for video_id, row in by_id.items():
        if keywords[video_id]:
            row["kw"] = "; ".join(sorted(keywords[video_id], key=str.lower))
            row["kwCount"] = len(keywords[video_id])
        if ranks[video_id]:
            row["rank"] = min(ranks[video_id])
        if audiences[video_id]:
            row["audiences"] = sorted(audiences[video_id], key=("youtube", "kids").index)
        if True in kids_status[video_id]:
            row["madeForKids"] = True
            if kids_sources[video_id]:
                row["madeForKidsSource"] = sorted(kids_sources[video_id])[0]
        elif False in kids_status[video_id]:
            row["madeForKids"] = False
    return list(by_id.values())


def preserve_audience_classification(winner: dict, other: dict | None) -> dict:
    """Keep official Kids truth and discovery provenance when one fresher row wins."""
    if not other:
        return winner
    merged = dict(winner)
    statuses = [
        value
        for value in (winner.get("madeForKids"), other.get("madeForKids"))
        if isinstance(value, bool)
    ]
    if True in statuses:
        merged["madeForKids"] = True
        for source_row in (winner, other):
            if source_row.get("madeForKids") is True and source_row.get("madeForKidsSource"):
                merged["madeForKidsSource"] = source_row["madeForKidsSource"]
                break
    elif False in statuses:
        merged["madeForKids"] = False
    audiences = {
        str(value).lower()
        for row in (winner, other)
        for value in (row.get("audiences") or [])
        if str(value).lower() in {"youtube", "kids"}
    }
    if audiences:
        merged["audiences"] = sorted(audiences, key=("youtube", "kids").index)
    return merged


def fetch_discovery_spec(spec: dict, now_ms: int, api_key: str) -> tuple[list[dict], int, int]:
    if spec.get("audience") == "kids":
        if api_key:
            return fetch_kids_search(spec, now_ms, api_key)
        return fetch_kids_search_ydl(spec, now_ms)
    return fetch_search(spec, now_ms)


def run_shard(
    snapshot: Path,
    output: Path,
    shard: int,
    shards: int,
    tracked_manifest: Path | None = None,
) -> dict:
    payload = read_snapshot(snapshot)
    now_ms = utc_now_ms()
    all_tracked_ids = read_tracked_manifest(tracked_manifest) if tracked_manifest else tracked_ids(payload)
    all_quarantine_ids = (
        read_quarantine_manifest(tracked_manifest)
        if tracked_manifest
        else [
            str(video_id)
            for video_id in ((payload.get("videoMetrics") or {}).get("unavailable_ids") or [])
            if VIDEO_ID.match(str(video_id or ""))
        ]
    )
    ids = [video_id for video_id in all_tracked_ids if stable_shard(video_id, shards) == shard]
    quarantine_ids = [
        video_id for video_id in all_quarantine_ids if stable_shard(video_id, shards) == shard
    ]
    lookup_ids = sorted(set(ids) | set(quarantine_ids))
    fresh: dict[str, dict] = {}
    track_failed = 0
    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    specs = [
        spec
        for spec in query_specs(payload, include_kids=True)
        if stable_shard(spec["query"], shards) == shard
    ]
    owned_fresh: dict[str, dict] = {}
    owned_ok = True
    live_audiences: dict[str, dict] = {}
    # Official-upload discovery is useful, but it must never erase a day of
    # factual counters for the already tracked cohort.
    if shard == 0:
        try:
            owned_fresh = fetch_owned_api_rows(now_ms, api_key) if api_key else fetch_owned_ydl_rows(now_ms)
            fresh.update(owned_fresh)
        except Exception as exc:
            owned_ok = False
            print(f"WARN official-upload discovery: {type(exc).__name__}: {exc}", file=sys.stderr)
        if api_key:
            live_ids = sorted({
                str(row.get("vid") or "")
                for row in payload.get("d", {}).get("lives", [])
                if VIDEO_ID.match(str(row.get("vid") or ""))
            })
            if live_ids:
                try:
                    live_rows = fetch_api_rows(live_ids, now_ms, api_key)
                    live_audiences = {
                        video_id: {
                            "madeForKids": row["madeForKids"],
                            "audiences": ["kids"] if row["madeForKids"] else ["youtube"],
                        }
                        for video_id, row in live_rows.items()
                        if isinstance(row.get("madeForKids"), bool)
                    }
                except Exception as exc:
                    print(
                        f"WARN livestream audience refresh: {type(exc).__name__}: {exc}",
                        file=sys.stderr,
                    )
    if api_key:
        try:
            fresh.update(fetch_api_rows(lookup_ids, now_ms, api_key))
        except Exception as exc:
            raise RuntimeError(f"YouTube Data API metrics failed closed: {type(exc).__name__}: {exc}") from exc
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=TRACK_WORKERS) as pool:
            future_to_id = {
                pool.submit(fetch_one_video, video_id, now_ms): video_id for video_id in lookup_ids
            }
            for future in concurrent.futures.as_completed(future_to_id):
                video_id = future_to_id[future]
                try:
                    row = future.result()
                    if row:
                        fresh[video_id] = row
                    else:
                        track_failed += 1
                except Exception as exc:
                    track_failed += 1
                    print(f"WARN tracked {video_id}: {type(exc).__name__}: {exc}", file=sys.stderr)

    tracked_fresh_ids = sorted(set(ids) & set(fresh))
    tracked_failed_ids = sorted(set(ids) - set(tracked_fresh_ids))
    tracked_unavailable_ids = tracked_failed_ids if api_key else []
    tracked_recovered_ids = sorted(set(quarantine_ids) & set(fresh))
    if tracked_failed_ids:
        print(
            f"WARN shard {shard}: {len(tracked_failed_ids)} tracked IDs missing: "
            + ", ".join(tracked_failed_ids[:24]),
            file=sys.stderr,
        )

    candidates: list[dict] = []
    query_failed = 0
    query_raw = 0
    query_enriched = 0
    kids_queries_total = sum(1 for spec in specs if spec.get("audience") == "kids")
    kids_query_failed = 0
    kids_results_examined = 0
    kids_candidates_kept = 0
    # A canary failure is not an ordinary partial keyword miss: without a
    # trustworthy rendered signal, no Kids classification may be published.
    if kids_queries_total and not api_key:
        kids_dom_validator().ensure_canaries()
    with concurrent.futures.ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as pool:
        future_to_spec = {
            pool.submit(fetch_discovery_spec, spec, now_ms, api_key): spec
            for spec in specs
        }
        for future in concurrent.futures.as_completed(future_to_spec):
            spec = future_to_spec[future]
            try:
                rows, raw_count, enriched_count = future.result()
                query_raw += raw_count
                query_enriched += enriched_count
                if spec.get("audience") == "kids":
                    kids_results_examined += raw_count
                    kids_candidates_kept += len(rows)
                candidates.extend(rows)
                for row in rows:
                    previous = fresh.get(row["vid"])
                    if not previous or int(row.get("views") or 0) >= int(previous.get("views") or 0):
                        fresh[row["vid"]] = preserve_audience_classification(row, previous)
                    else:
                        fresh[row["vid"]] = preserve_audience_classification(previous, row)
            except Exception as exc:
                query_failed += 1
                if spec.get("audience") == "kids":
                    kids_query_failed += 1
                print(f"WARN query {spec['query']}: {type(exc).__name__}: {exc}", file=sys.stderr)

    track_ok = len(tracked_fresh_ids)
    query_ok = len(specs) - query_failed
    if ids and track_ok / len(ids) < MIN_TRACK_RATIO:
        raise RuntimeError(f"Shard {shard}: only {track_ok}/{len(ids)} tracked videos refreshed")
    if query_ok < len(specs):
        print(
            f"WARN shard {shard}: discovery is partial at {query_ok}/{len(specs)} keyword searches",
            file=sys.stderr,
        )

    artifact = {
        "version": 1,
        "generated_at": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
        "generated_ms": now_ms,
        "shard": shard,
        "shards": shards,
        "tracked_total": len(ids),
        "tracked_ok": track_ok,
        "queries_total": len(specs),
        "queries_ok": query_ok,
        "queries_raw": query_raw,
        "queries_enriched": query_enriched,
        "kids_queries_total": kids_queries_total,
        "kids_queries_ok": kids_queries_total - kids_query_failed,
        "kids_results_examined": kids_results_examined,
        "kids_candidates_kept": kids_candidates_kept,
        "owned_ok": owned_ok,
        "tracked_ids": ids,
        "tracked_fresh_ids": tracked_fresh_ids,
        "tracked_failed_ids": tracked_failed_ids,
        "tracked_unavailable_ids": tracked_unavailable_ids,
        "tracked_recovered_ids": tracked_recovered_ids,
        "owned_fresh": list(owned_fresh.values()),
        "live_audiences": live_audiences,
        "fresh": list(fresh.values()),
        "candidates": merge_keyword_rows(candidates),
    }
    atomic_write_text(output, json.dumps(artifact, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({key: artifact[key] for key in ("shard", "tracked_total", "tracked_ok", "queries_total", "queries_ok")}))
    return artifact


def update_row(existing: dict, fresh: dict, now_ms: int) -> None:
    for key in (
        "title", "url", "durH", "durationSource", "views", "pub", "channel",
        "chUrl", "channelId", "subs", "madeForKidsSource",
    ):
        if fresh.get(key) not in (None, ""):
            existing[key] = fresh[key]
    if isinstance(fresh.get("madeForKids"), bool):
        existing["madeForKids"] = fresh["madeForKids"]
    if isinstance(fresh.get("audiences"), list):
        existing["audiences"] = list(dict.fromkeys(
            str(value).lower()
            for value in fresh["audiences"]
            if str(value).lower() in {"youtube", "kids"}
        ))
    if not str(existing.get("genre") or "").strip() and fresh.get("genre"):
        existing["genre"] = fresh["genre"]
        if fresh.get("genreSource"):
            existing["genreSource"] = fresh["genreSource"]
    published = existing.get("pub")
    views = existing.get("views")
    age = age_months(int(published), now_ms) if isinstance(published, (int, float)) else None
    if age is not None:
        existing["ageM"] = age
        if isinstance(views, (int, float)):
            existing["vpm"] = views / age


def merge_discovery_fields(existing: dict, discovered: dict) -> None:
    keywords = set(split_keywords(existing.get("kw")))
    keywords.update(split_keywords(discovered.get("kw")))
    if keywords:
        existing["kw"] = "; ".join(sorted(keywords, key=str.lower))
        existing["kwCount"] = len(keywords)
    ranks = [
        int(value)
        for value in (existing.get("rank"), discovered.get("rank"))
        if isinstance(value, (int, float)) and value > 0
    ]
    if ranks:
        existing["rank"] = min(ranks)
    audiences = {
        str(value).lower()
        for row in (existing, discovered)
        for value in (row.get("audiences") or [])
        if str(value).lower() in {"youtube", "kids"}
    }
    if audiences:
        existing["audiences"] = sorted(audiences, key=("youtube", "kids").index)
    if discovered.get("madeForKids") is True or existing.get("madeForKids") is True:
        existing["madeForKids"] = True
        if discovered.get("madeForKidsSource"):
            existing["madeForKidsSource"] = discovered["madeForKidsSource"]
    elif isinstance(discovered.get("madeForKids"), bool):
        existing["madeForKids"] = discovered["madeForKids"]


def history_day_key(timestamp_ms: int) -> str:
    """Return the dashboard's business day for a UTC timestamp."""
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).astimezone(RADAR_TIMEZONE).date().isoformat()


def normalize_daily_points(points: list, now_ms: int) -> list[list[int]]:
    by_day: dict[object, list[int]] = {}
    for point in points or []:
        if isinstance(point, list) and len(point) >= 2:
            try:
                parsed = [int(point[0]), int(point[1])]
                day = history_day_key(parsed[0])
                if day not in by_day or parsed[0] >= by_day[day][0]:
                    by_day[day] = parsed
            except (TypeError, ValueError):
                pass
    cutoff = max(now_ms - HISTORY_RETENTION_DAYS * 86400000, DAILY_VIEW_HISTORY_START_MS)
    return sorted(
        (point for point in by_day.values() if point[0] >= cutoff),
        key=lambda point: point[0],
    )


def append_daily_point(points: list, now_ms: int, views: int) -> list[list[int]]:
    return normalize_daily_points(list(points or []) + [[now_ms, int(views)]], now_ms)


def history_shard_name(video_id: str) -> str:
    return f"{ord(video_id[0]):02x}.json"


def update_history_shards(
    history_dir: Path,
    desired_ids: set[str],
    fresh: dict[str, dict],
    legacy: dict,
    now_ms: int,
) -> tuple[int, int]:
    """Update bounded, lazy-loaded history shards outside the main snapshot."""
    history_dir.mkdir(parents=True, exist_ok=True)
    names = {history_shard_name(video_id) for video_id in desired_ids}
    names.update(history_shard_name(video_id) for video_id in legacy if VIDEO_ID.match(video_id))
    names.update(path.name for path in history_dir.glob("*.json"))
    total_ids = 0
    written = 0
    for name in sorted(names):
        path = history_dir / name
        current = {}
        if path.exists():
            try:
                current = (json.loads(path.read_text(encoding="utf-8")).get("d") or {})
            except (OSError, ValueError, AttributeError):
                current = {}
        updated: dict[str, list[list[int]]] = {}
        candidate_ids = set(current) | {
            video_id for video_id in desired_ids if history_shard_name(video_id) == name
        }
        for video_id in candidate_ids:
            # Never erase a measured history merely because a transient source
            # stopped returning its ID. Only desired IDs receive a new point.
            points = list(current.get(video_id) or [])
            if video_id in desired_ids:
                points += list(legacy.get(video_id) or [])
            row = fresh.get(video_id)
            if video_id in desired_ids and row and isinstance(row.get("views"), (int, float)):
                points.append([now_ms, int(row["views"])])
            clean = normalize_daily_points(points, now_ms)
            if clean:
                updated[video_id] = clean
        total_ids += len(updated)
        rendered = json.dumps(
            {"version": 1, "updated": now_ms, "d": updated},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        previous = path.read_text(encoding="utf-8") if path.exists() else None
        if previous != rendered:
            atomic_write_text(path, rendered)
            written += 1
    return total_ids, written


def validate_history_refresh(
    history_dir: Path,
    expected_views: dict[str, int],
    now_ms: int,
) -> int:
    """Fail the publication if a refreshed counter did not reach daily history."""
    expected_day = history_day_key(now_ms)
    missing: list[str] = []
    for video_id, views in sorted(expected_views.items()):
        path = history_dir / history_shard_name(video_id)
        try:
            points = (json.loads(path.read_text(encoding="utf-8")).get("d") or {}).get(video_id) or []
        except (OSError, ValueError, AttributeError):
            points = []
        day_points = [
            point
            for point in points
            if isinstance(point, list)
            and len(point) >= 2
            and history_day_key(int(point[0])) == expected_day
        ]
        if not day_points or int(day_points[-1][1]) != int(views):
            missing.append(video_id)
    if missing:
        sample = ", ".join(missing[:8])
        raise RuntimeError(
            f"History refresh rejected for {len(missing)}/{len(expected_views)} videos "
            f"on {expected_day} ({sample})"
        )
    return len(expected_views)


def write_avatar_overlay(payload: dict, path: Path) -> int:
    channels: dict[str, str] = {}
    aliases: dict[str, str] = {}
    for bucket in ("all", "trends", "news", "kids"):
        for row in payload.get("d", {}).get(bucket, []):
            channel_url = str(row.get("chUrl") or "")
            id_match = re.search(r"/channel/(UC[\w-]+)", channel_url)
            handle_match = re.search(r"youtube\.com/@([^/?#]+)", channel_url, re.I)
            channel_id = str(row.get("channelId") or (id_match.group(1) if id_match else ""))
            handle = "@" + handle_match.group(1) if handle_match else ""
            if CHANNEL_ID.match(channel_id):
                channels[channel_id] = f"https://unavatar.io/youtube/{channel_id}?fallback=false"
                if handle:
                    aliases[handle] = channel_id
            elif handle:
                channels[handle] = f"https://unavatar.io/youtube/{handle}?fallback=false"
    rendered = (
        "/* Channel logos refreshed automatically alongside the daily YouTube radar. */\n"
        "window.YT_CHANNEL_AVATARS=window.YT_CHANNEL_AVATARS||{channels:{},videos:{}};\n"
        "window.YT_CHANNEL_AVATARS.channels=window.YT_CHANNEL_AVATARS.channels||{};\n"
        "window.YT_CHANNEL_AVATARS.aliases=window.YT_CHANNEL_AVATARS.aliases||{};\n"
        "(()=>{const atlas=window.YT_CHANNEL_AVATARS,fresh="
        + json.dumps(channels, ensure_ascii=False, separators=(",", ":"))
        + ";Object.keys(fresh).forEach(key=>{if(!atlas.channels[key])atlas.channels[key]=fresh[key];});"
        "Object.assign(atlas.aliases,"
        + json.dumps(aliases, ensure_ascii=False, separators=(",", ":"))
        + ");})();\n"
    )
    atomic_write_text(path, rendered)
    return len(channels)


def merge_artifacts(
    snapshot: Path,
    avatars: Path,
    merge_dir: Path,
    expected_shards: int,
    history_dir: Path | None = None,
    recommendation_pool: Path | None = None,
    generate_recommendations: bool = True,
    require_kids: bool = False,
) -> dict:
    files = sorted(merge_dir.rglob("youtube-shard-*.json"))
    artifacts = [json.loads(path.read_text(encoding="utf-8")) for path in files]
    seen_shards = {int(artifact["shard"]) for artifact in artifacts}
    if seen_shards != set(range(expected_shards)):
        raise RuntimeError(f"Expected shards 0..{expected_shards - 1}, got {sorted(seen_shards)}")
    if any(int(artifact.get("shards", -1)) != expected_shards for artifact in artifacts):
        raise RuntimeError("Shard-count mismatch in artifacts")

    tracked_total = sum(int(a.get("tracked_total", 0)) for a in artifacts)
    tracked_ok = sum(int(a.get("tracked_ok", 0)) for a in artifacts)
    queries_total = sum(int(a.get("queries_total", 0)) for a in artifacts)
    queries_ok = sum(int(a.get("queries_ok", 0)) for a in artifacts)
    queries_raw = sum(int(a.get("queries_raw", 0)) for a in artifacts)
    queries_enriched = sum(int(a.get("queries_enriched", 0)) for a in artifacts)
    kids_queries_total = sum(int(a.get("kids_queries_total", 0)) for a in artifacts)
    kids_queries_ok = sum(int(a.get("kids_queries_ok", 0)) for a in artifacts)
    kids_results_examined = sum(int(a.get("kids_results_examined", 0)) for a in artifacts)
    kids_candidates_kept = sum(int(a.get("kids_candidates_kept", 0)) for a in artifacts)
    if require_kids:
        expected_kids_queries = len(KIDS_QUERY_SPECS)
        if kids_queries_total != expected_kids_queries:
            raise RuntimeError(
                f"Merge rejected: expected {expected_kids_queries} Kids queries, "
                f"got {kids_queries_total}"
            )
        if kids_queries_ok / kids_queries_total < MIN_KIDS_QUERY_RATIO:
            raise RuntimeError(
                f"Merge rejected: only {kids_queries_ok}/{kids_queries_total} Kids queries succeeded"
            )
    if not tracked_total or tracked_ok / tracked_total < MIN_PUBLISH_TRACK_RATIO:
        raise RuntimeError(f"Merge rejected: {tracked_ok}/{tracked_total} tracked videos refreshed")
    owned_ok = all(bool(artifact.get("owned_ok", True)) for artifact in artifacts)
    tracked_fresh_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_fresh_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    tracked_failed_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_failed_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    if len(tracked_fresh_ids) != tracked_ok:
        raise RuntimeError(
            f"Merge rejected: {tracked_ok} refreshed counters but "
            f"{len(tracked_fresh_ids)} traceable refreshed IDs"
        )
    expected_failed = tracked_total - tracked_ok
    if len(tracked_failed_ids) != expected_failed or tracked_failed_ids & tracked_fresh_ids:
        raise RuntimeError(
            f"Merge rejected: {expected_failed} missing counters but "
            f"{len(tracked_failed_ids)} traceable missing IDs"
        )

    payload = read_snapshot(snapshot)
    previous_unavailable_ids = {
        str(video_id)
        for video_id in ((payload.get("videoMetrics") or {}).get("unavailable_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    previous_missing_ids = {
        str(video_id)
        for video_id in ((payload.get("videoMetrics") or {}).get("missing_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    newly_unavailable_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_unavailable_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    # The official Data API can authoritatively quarantine an omission in one
    # pass.  The public yt-dlp fallback is deliberately more conservative: an
    # ID must be absent from two consecutive complete scans before it leaves
    # the active denominator.  Quarantined IDs remain recovery probes.
    newly_unavailable_ids.update(tracked_failed_ids & previous_missing_ids)
    recovered_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_recovered_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    confirmed_recovered_ids = recovered_ids & previous_unavailable_ids
    unavailable_ids = sorted(
        (previous_unavailable_ids | newly_unavailable_ids) - confirmed_recovered_ids
    )
    unavailable_set = set(unavailable_ids)
    newly_quarantined_active_ids = tracked_failed_ids & unavailable_set
    active_tracked_total = (
        tracked_total
        - len(newly_quarantined_active_ids)
        + len(confirmed_recovered_ids)
    )
    active_updated_total = len(tracked_fresh_ids | confirmed_recovered_ids)
    if active_tracked_total < active_updated_total:
        raise RuntimeError(
            f"Merge rejected: {active_updated_total} refreshed videos exceed "
            f"the {active_tracked_total} active tracked videos"
        )
    missing_ids = sorted(tracked_failed_ids - unavailable_set)
    data = payload.setdefault("d", {})
    prune_deferred_rows(data)
    legacy_history = data.pop("hist", {})
    now_ms = max(int(a.get("generated_ms", 0)) for a in artifacts) or utc_now_ms()
    fresh: dict[str, dict] = {}
    owned_fresh: dict[str, dict] = {}
    candidates: list[dict] = []
    for artifact in artifacts:
        candidates.extend(artifact.get("candidates") or [])
        for row in artifact.get("fresh") or []:
            video_id = row.get("vid")
            if not VIDEO_ID.match(str(video_id or "")):
                continue
            previous = fresh.get(video_id)
            if not previous or int(row.get("views") or 0) >= int(previous.get("views") or 0):
                fresh[video_id] = preserve_audience_classification(row, previous)
            else:
                fresh[video_id] = preserve_audience_classification(previous, row)
        for row in artifact.get("owned_fresh") or []:
            video_id = row.get("vid")
            if VIDEO_ID.match(str(video_id or "")):
                owned_fresh[video_id] = row

    for bucket in ("all", "trends", "news", "kids"):
        for row in data.setdefault(bucket, []):
            current = fresh.get(row.get("vid"))
            if current:
                update_row(row, current, now_ms)
    data["kids"] = [
        row
        for row in data["kids"]
        if row.get("madeForKids") is True
        and int(row.get("views") or 0) >= MIN_KIDS_VIEWS
        and float(row.get("vpm") or 0) >= MIN_KIDS_VPM
    ]
    removed_low_view_news = prune_news_below_view_floor(data)

    live_audiences: dict[str, dict] = {}
    for artifact in artifacts:
        live_audiences.update(artifact.get("live_audiences") or {})
    for row in data.setdefault("lives", []):
        audience = live_audiences.get(str(row.get("vid") or ""))
        if audience:
            row.update(audience)

    by_ours = {row.get("vid"): row for row in data.setdefault("ours", [])}
    inserted_ours = 0
    for row in owned_fresh.values():
        current = by_ours.get(row["vid"])
        if current:
            update_row(current, row, now_ms)
            current["source"] = row.get("source") or current.get("source")
        else:
            added = dict(row)
            data["ours"].append(added)
            by_ours[added["vid"]] = added
            inserted_ours += 1
    data["ours"].sort(key=lambda row: row.get("pub") or 0, reverse=True)

    by_all = {row.get("vid"): row for row in data["all"]}
    by_trends = {row.get("vid"): row for row in data["trends"]}
    by_news = {row.get("vid"): row for row in data["news"]}
    by_kids = {row.get("vid"): row for row in data["kids"]}
    inserted_all = 0
    inserted_trends = 0
    inserted_news = 0
    inserted_kids = 0
    for row in merge_keyword_rows(candidates):
        if is_deferred_row(row):
            continue
        views = int(row.get("views") or 0)
        age = row.get("ageM")
        for current in (
            by_all.get(row["vid"]),
            by_trends.get(row["vid"]),
            by_news.get(row["vid"]),
            by_kids.get(row["vid"]),
        ):
            if current:
                merge_discovery_fields(current, row)
        audiences = {
            str(value).lower()
            for value in (row.get("audiences") or ["youtube"])
            if str(value).lower() in {"youtube", "kids"}
        }
        is_youtube = "youtube" in audiences
        is_kids = "kids" in audiences and row.get("madeForKids") is True
        if (
            is_kids
            and views >= MIN_KIDS_VIEWS
            and float(row.get("vpm") or 0) >= MIN_KIDS_VPM
            and row["vid"] not in by_kids
        ):
            added = dict(row)
            data["kids"].append(added)
            by_kids[row["vid"]] = added
            inserted_kids += 1
        if is_youtube and views >= MIN_ALL_VIEWS and row["vid"] not in by_all:
            data["all"].append(row)
            by_all[row["vid"]] = row
            inserted_all += 1
        if (
            is_youtube
            and views >= MIN_TREND_VIEWS
            and isinstance(age, (int, float))
            and age <= MAX_TREND_AGE_MONTHS
            and row["vid"] not in by_trends
        ):
            data["trends"].append(dict(row))
            by_trends[row["vid"]] = row
            inserted_trends += 1
        if (
            is_youtube
            and views >= MIN_NEWS_VIEWS
            and isinstance(age, (int, float))
            and age <= MAX_NEWS_AGE_MONTHS
            and (row.get("vpm") or 0) >= MIN_NEWS_VPM
            and row["vid"] not in by_news
        ):
            discovered = dict(row)
            discovered["disc"] = row.get("kw") or ""
            discovered["days"] = 1
            discovered["why"] = (
                "Discovered by the daily recent-video scan; "
                f"{views:,} views at {age:.1f} months "
                f"({int(row.get('vpm') or 0):,} views/month)."
            )
            data["news"].append(discovered)
            by_news[row["vid"]] = discovered
            inserted_news += 1

    for row in data["news"]:
        if isinstance(row.get("added"), (int, float)):
            row["days"] = max(1, int((now_ms - row["added"]) / 86400000) + 1)

    data["trends"] = [
        row
        for row in data["trends"]
        if int(row.get("views") or 0) >= MIN_TREND_VIEWS
        and isinstance(row.get("ageM"), (int, float))
        and row["ageM"] <= MAX_TREND_AGE_MONTHS
    ]
    for bucket in ("all", "trends", "news", "kids"):
        data[bucket].sort(key=lambda row: row.get("vpm") or 0, reverse=True)
    if len(data["news"]) > MAX_NEWS_ROWS:
        data["news"] = sorted(
            data["news"], key=lambda row: row.get("added") or 0, reverse=True
        )[:MAX_NEWS_ROWS]
    prune_deferred_rows(data)

    desired_ids = {
        str(video_id)
        for artifact in artifacts
        for video_id in (artifact.get("tracked_ids") or [])
        if VIDEO_ID.match(str(video_id or ""))
    }
    desired_ids.update(
        str(row.get("vid"))
        for bucket in ("all", "trends", "news", "ours", "kids")
        for row in data[bucket]
        if VIDEO_ID.match(str(row.get("vid") or ""))
    )
    desired_ids.update(confirmed_recovered_ids)
    resolved_history_dir = history_dir or snapshot.parent / "video_history"
    history_ids, history_files = update_history_shards(
        resolved_history_dir,
        desired_ids,
        fresh,
        legacy_history,
        now_ms,
    )
    refreshed_history_ids = tracked_fresh_ids | confirmed_recovered_ids
    expected_history_views = {
        video_id: int(fresh[video_id]["views"])
        for video_id in refreshed_history_ids
        if video_id in fresh and isinstance(fresh[video_id].get("views"), (int, float))
    }
    if len(expected_history_views) != active_updated_total:
        raise RuntimeError(
            f"Merge rejected: {active_updated_total} refreshed videos but "
            f"{len(expected_history_views)} usable history values"
        )
    history_updated = validate_history_refresh(resolved_history_dir, expected_history_views, now_ms)
    history_day = history_day_key(now_ms)

    payload["t"] = now_ms
    payload["videoMetricsT"] = now_ms
    payload["videoMetrics"] = {
        "tracked": active_tracked_total,
        "updated": active_updated_total,
        "keywords": queries_total,
        "keywords_ok": queries_ok,
        "discovery_partial": queries_ok < queries_total or not owned_ok,
        "owned_discovery_ok": owned_ok,
        "search_results": queries_raw,
        "search_results_enriched": queries_enriched,
        "kids_queries": kids_queries_total,
        "kids_queries_ok": kids_queries_ok,
        "kids_results_examined": kids_results_examined,
        "kids_candidates_kept": kids_candidates_kept,
        "history_updated": history_updated,
        "history_day": history_day,
        "day_timezone": RADAR_TIMEZONE_NAME,
        "partial": active_updated_total < active_tracked_total,
        "unavailable_ids": unavailable_ids,
        "missing_ids": missing_ids,
    }
    payload["videoHistory"] = {
        "layout": "video_history/{first_char_hex}.json",
        "retention_days": HISTORY_RETENTION_DAYS,
        "updated": now_ms,
        "day": history_day,
        "day_timezone": RADAR_TIMEZONE_NAME,
    }
    avatar_count = write_avatar_overlay(payload, avatars)
    write_snapshot(snapshot, payload)
    pool_payload = None
    if generate_recommendations:
        pool_data = dict(data)
        pool_data["videoMetricsT"] = now_ms
        pool_payload = write_recommendation_pool(
            pool_data,
            recommendation_pool or snapshot.parent / DEFAULT_RECOMMENDATION_POOL.name,
            generated_ms=now_ms,
        )
    summary = {
        "tracked": active_tracked_total,
        "updated": active_updated_total,
        "keywords": queries_total,
        "keywords_ok": queries_ok,
        "discovery_partial": queries_ok < queries_total or not owned_ok,
        "history_ids": history_ids,
        "history_files": history_files,
        "history_updated": history_updated,
        "history_day": history_day,
        "unavailable": len(unavailable_ids),
        "missing": len(missing_ids),
        "all_added": inserted_all,
        "trends_added": inserted_trends,
        "news_added": inserted_news,
        "kids_added": inserted_kids,
        "kids_queries": kids_queries_total,
        "kids_queries_ok": kids_queries_ok,
        "kids_results_examined": kids_results_examined,
        "kids_candidates_kept": kids_candidates_kept,
        "news_removed_below_view_floor": removed_low_view_news,
        "ours_added": inserted_ours,
        "avatars": avatar_count,
        "recommendations_generated": len(pool_payload["items"]) if pool_payload else None,
        "timestamp": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def snapshot_freshness(snapshot: Path, now_ms: int | None = None) -> dict:
    """Return a machine-readable daily health decision for the watchdog cron."""
    payload = read_snapshot(snapshot)
    metrics = payload.get("videoMetrics") or {}
    stamp = int(payload.get("videoMetricsT") or 0)
    now_ms = int(now_ms or utc_now_ms())
    tracked = int(metrics.get("tracked") or 0)
    updated = int(metrics.get("updated") or 0)
    keywords = int(metrics.get("keywords") or 0)
    keywords_ok = int(metrics.get("keywords_ok") or 0)
    history_updated = int(metrics.get("history_updated") or 0)
    same_day = bool(stamp) and history_day_key(stamp) == history_day_key(now_ms)
    fresh = (
        same_day
        and tracked > 0
        and updated == tracked
        and history_updated == updated
        and not bool(metrics.get("partial"))
        and metrics.get("history_day") == history_day_key(stamp)
        and metrics.get("day_timezone") == RADAR_TIMEZONE_NAME
    )
    return {
        "fresh": fresh,
        "today": history_day_key(now_ms),
        "snapshot_day": history_day_key(stamp) if stamp else None,
        "tracked": tracked,
        "updated": updated,
        "keywords": keywords,
        "keywords_ok": keywords_ok,
        "history_updated": history_updated,
    }


def verify_publication(
    base_url: str,
    snapshot: Path,
    history_dir: Path,
    timeout_seconds: int = 900,
    interval_seconds: int = 15,
    recommendation_pool: Path | None = None,
    require_recommendation_pool: bool = True,
) -> dict:
    """Wait until Pages serves the factual snapshot/history and optional ideas."""
    local = read_snapshot(snapshot)
    expected = int(local.get("videoMetricsT") or 0)
    if not expected:
        raise RuntimeError("Local snapshot has no validated videoMetricsT")
    shards = sorted(history_dir.glob("*.json"))
    if not shards:
        raise RuntimeError("Local history directory has no shards")
    local_history: dict[str, dict] = {}
    for shard in shards:
        document = json.loads(shard.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or not isinstance(document.get("d"), dict):
            raise RuntimeError(f"Local history shard {shard.name} is malformed")
        local_history[shard.name] = document
    expected_history_updated = int((local.get("videoMetrics") or {}).get("history_updated") or 0)
    local_latest_count = sum(
        1
        for document in local_history.values()
        for points in document["d"].values()
        if isinstance(points, list) and points and isinstance(points[-1], list) and len(points[-1]) >= 2
    )
    if expected_history_updated <= 0 or local_latest_count < expected_history_updated:
        raise RuntimeError(
            f"Local factual history is incomplete at {local_latest_count}/{expected_history_updated}"
        )
    local_pool_path = recommendation_pool or snapshot.parent / DEFAULT_RECOMMENDATION_POOL.name
    if require_recommendation_pool and not local_pool_path.exists():
        raise RuntimeError("Local renewable recommendation pool is missing")
    root = base_url.rstrip("/") + "/"
    deadline = time.monotonic() + max(timeout_seconds, 1)
    last_error = "not attempted"
    while time.monotonic() < deadline:
        cache_buster = urllib.parse.urlencode({"expected": expected, "attempt": int(time.time())})
        try:
            with urllib.request.urlopen(root + "Lofi_Radar_data.js?" + cache_buster, timeout=30) as response:
                remote = parse_snapshot_text(response.read().decode("utf-8"))
            remote_stamp = int(remote.get("videoMetricsT") or 0)
            if remote_stamp < expected:
                last_error = f"served snapshot={remote_stamp}, expected={expected}"
                time.sleep(max(interval_seconds, 1))
                continue
            pool_count = None
            if require_recommendation_pool:
                with urllib.request.urlopen(
                    root + DEFAULT_RECOMMENDATION_POOL.name + "?" + cache_buster,
                    timeout=30,
                ) as response:
                    pool_raw = response.read().decode("utf-8").strip()
                if not pool_raw.startswith(POOL_PREFIX):
                    raise RuntimeError("served recommendation pool is malformed")
                remote_pool = json.loads(pool_raw[len(POOL_PREFIX):].rstrip(";\n "))
                pool_stamp = int(remote_pool.get("sourceT") or 0)
                pool_count = len(remote_pool.get("items") or [])
                if pool_stamp < expected or pool_count <= 1_000:
                    last_error = f"served recommendation pool={pool_count}@{pool_stamp}, expected >1000@{expected}"
                    time.sleep(max(interval_seconds, 1))
                    continue
            stale_shards: list[str] = []
            history_stamps: list[int] = []
            verified_points = 0
            for shard in shards:
                with urllib.request.urlopen(
                    root + "video_history/" + shard.name + "?" + cache_buster,
                    timeout=30,
                ) as response:
                    remote_history = json.load(response) or {}
                history_stamp = int(remote_history.get("updated") or 0)
                history_stamps.append(history_stamp)
                if history_stamp < expected:
                    stale_shards.append(shard.name)
                    continue
                remote_rows = remote_history.get("d") if isinstance(remote_history, dict) else None
                if not isinstance(remote_rows, dict):
                    stale_shards.append(shard.name)
                    continue
                for video_id, local_points in local_history[shard.name]["d"].items():
                    if not isinstance(local_points, list) or not local_points:
                        continue
                    local_point = local_points[-1]
                    remote_points = remote_rows.get(video_id)
                    if not isinstance(local_point, list) or len(local_point) < 2 or not isinstance(remote_points, list) or not remote_points:
                        stale_shards.append(shard.name)
                        break
                    remote_point = remote_points[-1]
                    if (
                        not isinstance(remote_point, list)
                        or len(remote_point) < 2
                        or int(remote_point[0]) < int(local_point[0])
                        or (
                            int(remote_point[0]) == int(local_point[0])
                            and int(remote_point[1]) != int(local_point[1])
                        )
                    ):
                        stale_shards.append(shard.name)
                        break
                    verified_points += 1
            if not stale_shards:
                result = {
                    "published": True,
                    "expected": expected,
                    "snapshot": remote_stamp,
                    "history_min": min(history_stamps),
                    "history_shards": len(history_stamps),
                    "history_points": verified_points,
                    "recommendations": pool_count,
                }
                print(json.dumps(result))
                return result
            last_error = f"{len(stale_shards)}/{len(shards)} stale history shards: {', '.join(stale_shards[:8])}"
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(max(interval_seconds, 1))
    raise RuntimeError(f"GitHub Pages did not publish the validated YouTube refresh: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--avatars", type=Path, default=DEFAULT_AVATARS)
    parser.add_argument("--history-dir", type=Path, default=DEFAULT_HISTORY_DIR)
    parser.add_argument("--recommendation-pool", type=Path, default=DEFAULT_RECOMMENDATION_POOL)
    parser.add_argument("--skip-recommendation-pool", action="store_true")
    parser.add_argument("--require-kids", action="store_true")
    parser.add_argument("--shard", type=int)
    parser.add_argument("--shards", type=int, default=10)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--merge-dir", type=Path)
    parser.add_argument("--tracked-manifest", type=Path)
    parser.add_argument("--write-tracked-manifest", type=Path)
    parser.add_argument("--check-fresh-today", action="store_true")
    parser.add_argument("--verify-base-url")
    parser.add_argument("--verify-core-only", action="store_true")
    parser.add_argument("--verify-timeout", type=int, default=900)
    parser.add_argument("--verify-interval", type=int, default=15)
    args = parser.parse_args()
    if args.write_tracked_manifest:
        write_tracked_manifest(args.snapshot, args.write_tracked_manifest)
        return
    if args.check_fresh_today:
        health = snapshot_freshness(args.snapshot)
        print(json.dumps(health))
        raise SystemExit(0 if health["fresh"] else 1)
    if args.verify_base_url:
        verify_publication(
            args.verify_base_url,
            args.snapshot,
            args.history_dir,
            args.verify_timeout,
            args.verify_interval,
            args.recommendation_pool,
            not args.verify_core_only,
        )
        return
    if args.merge_dir:
        merge_artifacts(
            args.snapshot,
            args.avatars,
            args.merge_dir,
            args.shards,
            args.history_dir,
            args.recommendation_pool,
            not args.skip_recommendation_pool,
            args.require_kids,
        )
        return
    if args.shard is None or args.output is None:
        parser.error("collector mode requires --shard and --output")
    if args.shard < 0 or args.shard >= args.shards:
        parser.error("--shard must be in [0, --shards)")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run_shard(args.snapshot, args.output, args.shard, args.shards, args.tracked_manifest)


if __name__ == "__main__":
    main()
