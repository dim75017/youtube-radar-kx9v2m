#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: expected at least {count} occurrence(s), found {actual}")
    file.write_text(text.replace(old, new, count), encoding="utf-8")


def patch_builder() -> None:
    path = Path("build_spotify_browse_catalogue.py")
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        r"def merge_catalogues\(catalogues: Sequence\[Mapping\[str, Any\]\]\) -> dict\[str, Any\]:\n.*?\n\ndef build_payload\(",
        re.S,
    )
    replacement = '''def merge_catalogues(catalogues: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    normalised = [_normalise_catalogue(catalogue) for catalogue in catalogues]
    track_schema = _schema_union(catalogues, "track_schema")
    artist_schema = _schema_union(catalogues, "artist_schema")
    playlist_schema = _schema_union(catalogues, "playlist_schema")

    tracks: list[dict[str, Any]] = []
    artists: list[dict[str, Any]] = []
    track_by_spotify: dict[str, int] = {}
    track_by_soundcharts: dict[str, int] = {}
    artist_by_spotify: dict[str, int] = {}
    artist_by_soundcharts: dict[str, int] = {}
    artist_by_name: dict[str, int] = {}

    def upsert_track(row: Mapping[str, Any]) -> None:
        spotify = str(row.get("spotify_id") or "").strip()
        soundcharts = str(row.get("soundcharts_uuid") or "").strip()
        index = track_by_spotify.get(spotify) if spotify else None
        if index is None and soundcharts:
            index = track_by_soundcharts.get(soundcharts)
        if index is None:
            index = len(tracks)
            tracks.append(dict(row))
        else:
            tracks[index] = _merge_record(tracks[index], row)
        merged = tracks[index]
        spotify = str(merged.get("spotify_id") or "").strip()
        soundcharts = str(merged.get("soundcharts_uuid") or "").strip()
        if spotify:
            track_by_spotify[spotify] = index
        if soundcharts:
            track_by_soundcharts[soundcharts] = index

    def upsert_artist(row: Mapping[str, Any]) -> None:
        spotify = str(row.get("spotify_id") or "").strip()
        soundcharts = str(row.get("soundcharts_uuid") or "").strip()
        name = str(row.get("name") or "").strip().casefold()
        index = artist_by_spotify.get(spotify) if spotify else None
        if index is None and soundcharts:
            index = artist_by_soundcharts.get(soundcharts)
        if index is None and name:
            index = artist_by_name.get(name)
        if index is None:
            index = len(artists)
            artists.append(dict(row))
        else:
            artists[index] = _merge_record(artists[index], row)
        merged = artists[index]
        spotify = str(merged.get("spotify_id") or "").strip()
        soundcharts = str(merged.get("soundcharts_uuid") or "").strip()
        name = str(merged.get("name") or "").strip().casefold()
        if spotify:
            artist_by_spotify[spotify] = index
        if soundcharts:
            artist_by_soundcharts[soundcharts] = index
        if name:
            artist_by_name[name] = index

    for catalogue in normalised:
        for row in catalogue["track_records"]:
            upsert_track(row)
        for row in catalogue["artist_records"]:
            upsert_artist(row)

    tracks.sort(
        key=lambda row: (
            _availability_rank(row.get("availability_status")),
            0 if _finite_number(row.get("streams")) is not None else 1,
            -float(_finite_number(row.get("streams_delta_24h")) or 0),
            -float(_finite_number(row.get("streams")) or 0),
            str(row.get("title") or "").casefold(),
        )
    )
    artists.sort(
        key=lambda row: (
            _availability_rank(row.get("availability_status")),
            -float(_finite_number(row.get("monthly_listeners")) or 0),
            str(row.get("name") or "").casefold(),
        )
    )

    def compact(row: Mapping[str, Any], schema: Sequence[str]) -> list[Any]:
        return [row.get(name) for name in schema]

    counts = {
        "tracks": len(tracks),
        "artists": len(artists),
        "measured_tracks": sum(_finite_number(row.get("streams")) is not None for row in tracks),
        "playlist_tracks": sum(int(_finite_number(row.get("playlist_count")) or 0) > 0 for row in tracks),
        "catalogue_tracks": sum(str(row.get("source_tier") or "") == "playlist_artist_catalogue" for row in tracks),
        "verified_tracks": sum(str(row.get("availability_status") or "") == "verified" for row in tracks),
    }
    generated = max(
        (str(item.get("generated_at") or "") for item in normalised),
        default="",
    )
    return {
        "version": VERSION,
        "generated_at": generated,
        "track_schema": track_schema,
        "artist_schema": artist_schema,
        "playlist_schema": playlist_schema,
        "tracks": [compact(row, track_schema) for row in tracks],
        "artists": [compact(row, artist_schema) for row in artists],
        "counts": counts,
    }


def build_payload('''
    text, changed = pattern.subn(replacement, text, count=1)
    if changed != 1:
        raise SystemExit(f"builder merge function patch count={changed}")
    path.write_text(text, encoding="utf-8")


def patch_dashboard() -> None:
    replace_exact(
        "spotify/dashboard.js",
        """/* The historical Spotify catalogue is retained as an input for compatible
   history lookups only. It is not a public identity source: general views are
   rebuilt from the strict Soundcharts projection below. */
const A = [];""",
        """/* Two explicit layers share the same interface: broad read-only browsing
   and strict fail-closed A&R. The browsing layer never grants contactability. */
const BROWSE = window.SPOTIFY_BROWSE_CATALOGUE || {};
const A = (D.artists || []).map(artist=>Array.isArray(artist)?artist.slice():artist);""",
    )
    replace_exact(
        "spotify/dashboard.js",
        """/* Legacy rows do not carry the structured artist pairs, instrumental proof,
   AI risk and rights evidence required for public promotion. They stay in the
   source file as quarantined staging and cannot enter either general view. */
const LEGACY_R = [];
/* General views are populated exclusively by the strict Soundcharts merge.
   Needs-listen rows remain available only through SC.opportunities. */
const R = LEGACY_R.map(row=>Array.isArray(row)?row.slice():row);""",
        """/* Historical rows remain browseable inventory, but never become A&R seeds,
   contacts or offers. Explicit retired, mainstream and composite identities
   stay quarantined from the public inventory. */
const LEGACY_R = (D.rows || []).filter(row=>{
  const artist=A[Number(row&&row[0])];
  return artist && Number(artist[4]||0)!==1
    && !isGeneralArtistQuarantined(artist[0]);
});
const R = LEGACY_R.map(row=>Array.isArray(row)?row.slice():row);""",
    )
    replace_exact(
        "spotify/dashboard.js",
        """/* ---------- catalogue Soundcharts complet : découvert d'abord, enrichi ensuite ---------- */
/* Full discovery remains staging-only. Its incomplete/name-only rows can never
   become a public track or artist source, even if a future export carries the
   raw discovery_catalogue payload again. */
const DISCOVERY_CATALOGUE = {tracks:[],artists:[],counts:{}};""",
        """/* ---------- catalogue de navigation : large, explicite, non contactable ---------- */
const BROWSE_DISCOVERY = BROWSE&&BROWSE.discovery_catalogue&&typeof BROWSE.discovery_catalogue==='object'
  ? BROWSE.discovery_catalogue : null;
const STRICT_DISCOVERY = SC&&SC.discovery_catalogue&&typeof SC.discovery_catalogue==='object'
  ? SC.discovery_catalogue : null;
const DISCOVERY_CATALOGUE = BROWSE_DISCOVERY&&Array.isArray(BROWSE_DISCOVERY.tracks)&&BROWSE_DISCOVERY.tracks.length
  ? BROWSE_DISCOVERY
  : (STRICT_DISCOVERY||{tracks:[],artists:[],counts:{}});""",
    )


def patch_coverage() -> None:
    path = Path("spotify/coverage.js")
    text = path.read_text(encoding="utf-8")
    replacements = [
        (
            """  const SC = window.SPOTIFY_SOUNDCHARTS || {};
  const discovery = SC.playlist_discovery || {};
  const pool = SC.instrumental_pool || {};
  const scoring = SC.opportunity_scoring || {};
  const catalogue = SC.discovery_catalogue || {};
  const catalogueCounts = catalogue.counts || {};""",
            """  const SC = window.SPOTIFY_SOUNDCHARTS || {};
  const BROWSE = window.SPOTIFY_BROWSE_CATALOGUE || {};
  const discovery = BROWSE.playlist_discovery || SC.playlist_discovery || {};
  const pool = BROWSE.instrumental_pool || SC.instrumental_pool || {};
  const scoring = SC.opportunity_scoring || {};
  const catalogue = BROWSE.discovery_catalogue || SC.discovery_catalogue || {};
  const catalogueCounts = catalogue.counts || {};""",
        ),
        (
            "return `Sélection publique stricte : ${format(visible)} pistes instrumentales vérifiées avec identités structurées, risque IA faible et droits indépendants.`;",
            "return `Catalogue vivant : ${format(visible)} pistes disponibles, dont ${format(metrics.measuredCatalogueTracks)} déjà mesurées. Les lignes à enrichir restent consultables ; A&R reste strict et séparé.`;",
        ),
        (
            "return `Strict public selection: ${format(visible)} verified instrumental tracks with structured identities, low AI risk and independent rights.`;",
            "return `Living catalogue: ${format(visible)} tracks available, including ${format(metrics.measuredCatalogueTracks)} already measured. Enrichment rows remain browseable; A&R stays strict and separate.`;",
        ),
        (
            "return `${format(visible)} artistes structurés sont consultables dans la sélection instrumentale vérifiée ; les profils incomplets restent en quarantaine.`;",
            "return `${format(visible)} artistes et crédits sont consultables dans le catalogue vivant. Les profils incomplets restent non contactables tant qu’ils ne passent pas les garde-fous A&R.`;",
        ),
        (
            "return `${format(visible)} structured artists are browsable in the verified instrumental selection; incomplete profiles remain quarantined.`;",
            "return `${format(visible)} artists and credits are browseable in the living catalogue. Incomplete profiles remain non-contactable until they pass A&R guardrails.`;",
        ),
        (
            "? `${format(liveTracks())} pistes instrumentales vérifiées`\n        : `${format(liveTracks())} verified instrumental tracks`;",
            "? `${format(liveTracks())} pistes disponibles · ${format(metrics.measuredCatalogueTracks)} mesurées`\n        : `${format(liveTracks())} tracks available · ${format(metrics.measuredCatalogueTracks)} measured`;",
        ),
        (
            "const generated = String(SC.generated_at || (SC.freshness && SC.freshness.tracks_at) || '').slice(0, 19);",
            "const generated = String(BROWSE.generated_at || SC.generated_at || (SC.freshness && SC.freshness.tracks_at) || '').slice(0, 19);",
        ),
        (
            "? `<b>Soundcharts · sélection instrumentale stricte</b><br>${format(liveTracks())} pistes vérifiées · ${format(liveArtists())} artistes structurés<br>${format(metrics.opportunities)} opportunités A&R${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`",
            "? `<b>Soundcharts · catalogue vivant + A&R strict</b><br>${format(liveTracks())} pistes disponibles · ${format(liveArtists())} artistes/crédits<br>${format(metrics.playlistsScanned)} playlists scannées · ${format(metrics.measuredCatalogueTracks)} pistes mesurées<br>${format(metrics.opportunities)} opportunités A&R strictes${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`",
        ),
        (
            ": `<b>Soundcharts · strict instrumental selection</b><br>${format(liveTracks())} verified tracks · ${format(liveArtists())} structured artists<br>${format(metrics.opportunities)} A&R opportunities${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`;",
            ": `<b>Soundcharts · living catalogue + strict A&R</b><br>${format(liveTracks())} tracks available · ${format(liveArtists())} artists/credits<br>${format(metrics.playlistsScanned)} playlists scanned · ${format(metrics.measuredCatalogueTracks)} measured tracks<br>${format(metrics.opportunities)} strict A&R opportunities${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`;",
        ),
    ]
    for old, new in replacements:
        if old not in text:
            raise SystemExit(f"coverage.js missing expected token: {old[:80]}")
        text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")


def patch_index() -> None:
    path = Path("spotify/index.html")
    text = path.read_text(encoding="utf-8")
    if "Spotify_Browse_Catalogue_data.js" not in text:
        text, changed = re.subn(
            r"(\s*'\.\./Spotify_Soundcharts_data_[^']+\.js\?payload='\+stamp,\n)",
            r"\1    '../Spotify_Browse_Catalogue_data.js?payload='+stamp,\n",
            text,
            count=1,
        )
        if changed != 1:
            raise SystemExit("could not insert browsing catalogue script")
    text = re.sub(
        r"20260722-(?:strict-public-v3|full-catalogue-v2|unified-catalogue-v1)",
        "20260722-unified-catalogue-v1",
        text,
    )
    path.write_text(text, encoding="utf-8")


def patch_tests() -> None:
    path = Path("tests/test_dashboard_general_view_guardrails.js")
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        "const identityEnd = source.indexOf('/* Legacy rows do not carry', identityStart);",
        "const identityEnd = source.indexOf('/* Historical rows remain browseable inventory', identityStart);",
    )
    text = text.replace(
        "const legacyStart = source.indexOf('const A = [];');",
        "const legacyStart = source.indexOf('const A = (D.artists || [])');",
    )
    text = text.replace(
        "  [],\n  'legacy rows stay quarantined because they lack the full strict evidence contract',",
        "  ['safe-track'],\n  'legacy browsing keeps safe inventory while quarantining composite, mainstream and retired rows',",
    )
    strict = """assert.match(source, /const A = \[\];/,
  'legacy artist identities are not a public source');
assert.match(source, /const LEGACY_R = \[\];/,
  'legacy catalogue rows remain quarantined');
assert.match(source, /const withTracks = AG\.filter\(g=>g\.n>0/,
  'artists without a linked strict public track remain quarantined');"""
    broad = """assert.match(source, /const A = \(D\.artists \|\| \[\]\)\.map/,
  'historical artists remain a browsing source');
assert.match(source, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/,
  'historical tracks remain a browsing source');
assert.doesNotMatch(source, /const A = \[\];/);
assert.doesNotMatch(source, /const LEGACY_R = \[\];/);"""
    if strict not in text:
        raise SystemExit("general-view test strict block was not found")
    path.write_text(text.replace(strict, broad, 1), encoding="utf-8")

    Path("tests/test_spotify_full_catalogue.js").write_text(
        """'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');
assert.match(dashboard, /const BROWSE = window\.SPOTIFY_BROWSE_CATALOGUE \|\| \{\};/);
assert.match(dashboard, /const DISCOVERY_CATALOGUE = BROWSE_DISCOVERY/);
assert.match(dashboard, /function mergeFullDiscoveryCatalogue\(/);
assert.match(dashboard, /mergeFullDiscoveryCatalogue\(\);/);
assert.match(dashboard, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/);
assert.match(dashboard, /Tout le catalogue/);
assert.match(dashboard, /À mesurer/);
assert.match(dashboard, /Présentes en playlist éditoriale/);
assert.match(dashboard, /function arEditorialPlaylistEvidenceHtml\(/);
assert.match(dashboard, /Pourquoi cette musique est dans la liste/);
assert.match(dashboard, /Présence en playlists éditoriales/);
assert.match(dashboard, /function spotifyTrackEmbedHtml\(/);
assert.match(dashboard, /spotifyTrackEmbedHtml\(r\[6\],r\[1\],'track-modal-player'\)/);
assert.match(dashboard, /function trackEditorialEvidenceHtml\(/);
assert.match(dashboard, /trackEditorialEvidenceHtml\(r\)/);
const radarStart = dashboard.indexOf('function renderRadar(){');
const radarEnd = dashboard.indexOf('function renderWatch(){', radarStart);
assert.ok(radarStart >= 0 && radarEnd > radarStart, 'A&R render section must exist');
assert.doesNotMatch(dashboard.slice(radarStart, radarEnd), /id=\"radar-q\"/, 'A&R search bar stays removed');
assert.match(coverage, /Catalogue vivant/);
assert.match(coverage, /A&R reste strict/);
assert.match(index, /Spotify_Browse_Catalogue_data\.js\?payload=/);
assert.match(index, /discovery\.css\?v=20260722-unified-catalogue-v1/);
assert.match(index, /dashboard\.js\?v=20260722-unified-catalogue-v1/);
assert.match(index, /coverage\.js\?v=20260722-unified-catalogue-v1/);
console.log('spotify unified catalogue guardrails: OK');
""",
        encoding="utf-8",
    )

    Path("tests/test_spotify_coverage_reporting.js").write_text(
        """'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('spotify/coverage.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');
assert.ok(index.indexOf('dashboard.js') < index.indexOf('coverage.js'));
assert.match(source, /SPOTIFY_BROWSE_CATALOGUE/);
assert.match(source, /Catalogue vivant/);
assert.match(source, /A&R reste strict/);
function element(){return {textContent:'',title:'',innerHTML:'',dataset:{},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];},insertAdjacentElement(){}};}
const elements={'c-opps':element(),'c-art':element(),'c-radar':element(),'sync-detail-tr':element(),view:element()};
const document={documentElement:{lang:'fr'},head:{appendChild(){}},getElementById(id){return elements[id]||null;},querySelector(){return null;},querySelectorAll(){return [];},createElement(){return element();}};
const context={console,document,location:{hash:'#tracks'},requestAnimationFrame(cb){cb();},setTimeout(cb){cb();},MutationObserver:class{observe(){}},R:Array.from({length:62832}),withTracks:Array.from({length:8351}),window:{SPOTIFY_SOUNDCHARTS:{generated_at:'2026-07-22T12:00:00Z',opportunities:Array.from({length:2000}),opportunity_scoring:{opportunities:2000}},SPOTIFY_BROWSE_CATALOGUE:{generated_at:'2026-07-22T12:00:00Z',playlist_discovery:{playlists_scanned:220},instrumental_pool:{measured:2968},discovery_catalogue:{counts:{tracks:17998,artists:8351,measured_tracks:2968}}},addEventListener(){}}};
vm.runInNewContext(source,context);
assert.match(elements['c-opps'].title,/62.*832/);
assert.match(elements['c-opps'].title,/pistes disponibles/);
assert.match(elements['c-art'].title,/8.*351/);
assert.match(elements['c-radar'].title,/2.*000/);
assert.match(elements['sync-detail-tr'].innerHTML,/catalogue vivant/);
assert.match(elements['sync-detail-tr'].innerHTML,/220 playlists scannées/);
assert.match(elements['sync-detail-tr'].innerHTML,/2.*968 pistes mesurées/);
assert.match(elements['sync-detail-tr'].innerHTML,/A&R strictes/);
console.log('Spotify unified coverage reporting: OK');
""",
        encoding="utf-8",
    )


def build_initial_catalogue() -> None:
    current = subprocess.check_output(
        ["python", "prepare_soundcharts_snapshot.py", "current", "--index", "spotify/index.html"],
        text=True,
    ).strip()
    command = [
        "python",
        "build_spotify_browse_catalogue.py",
        "--source",
        current,
        "--output",
        "Spotify_Browse_Catalogue_data.js",
        "--minimum-tracks",
        "10000",
    ]
    if Path("Spotify_Browse_Catalogue_data.js").exists():
        command.extend(["--existing", "Spotify_Browse_Catalogue_data.js"])
    fallback = Path("Spotify_Soundcharts_data_20260722T105508Z.js")
    if fallback.exists():
        command.extend(["--fallback", str(fallback)])
    subprocess.run(command, check=True)


def main() -> int:
    patch_builder()
    patch_dashboard()
    patch_coverage()
    patch_index()
    patch_tests()
    build_initial_catalogue()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
