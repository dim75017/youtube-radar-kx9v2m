'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const evaluate = (relative, globalName) => {
  const context = {window: {}};
  vm.createContext(context);
  vm.runInContext(read(relative), context, {filename: relative, timeout: 30_000});
  return context.window[globalName];
};

const index = read('spotify/index.html');
const instantRuntime = read('spotify/instant.js');
const followerWorkflow = read('.github/workflows/refresh-playlist-followers.yml');
const postBuildWorkflows = [
  '.github/workflows/refresh-soundcharts.yml',
  '.github/workflows/refresh-spotify-browse-catalogue.yml',
  '.github/workflows/deploy-pages.yml',
].map(relative => [relative, read(relative)]);
const analyticsPath = path.join(root, 'spotify', 'playlist-analytics.js');

assert.ok(fs.existsSync(analyticsPath),
  'the visible lightweight Spotify runtime must have a dedicated playlist analytics renderer');
const analyticsRuntime = read('spotify/playlist-analytics.js');

// Playlist history stays off the critical path, then loads from the canonical
// source only after a user opens a playlist.
assert.doesNotMatch(index, /playlist-analytics\.js|Spotify_Playlist_Analytics_data\.js|Spotify_Playlists_canonical_data\.js/,
  'playlist analytics and follower history must remain lazy on first paint');
assert.match(instantRuntime, /let playlistAnalyticsPromise=null/,
  'the lightweight runtime must cache one lazy playlist-analytics request');
assert.match(instantRuntime, /function loadPlaylistAnalytics\(\)/,
  'the visible playlist tab must be able to load its analytics renderer');
assert.match(instantRuntime, /window\.SpotifyPlaylistAnalytics/,
  'the lazy loader must resolve the playlist analytics module');
assert.match(instantRuntime, /async function openPlaylist\(id\)/,
  'clicking a visible playlist must have an internal detail action');
assert.match(instantRuntime, /analyticsModule\.open\(/,
  'the internal playlist action must delegate to the analytics renderer');
assert.match(instantRuntime, /spotifyId:id/,
  'the analytical renderer must receive the exact playlist selected by the user');
assert.match(instantRuntime, /data-open-playlist/,
  'playlist names must expose an explicit internal detail target');
assert.match(instantRuntime, /closest\('\[data-open-playlist\]'\)/,
  'the visible runtime must handle playlist detail clicks');

const playlistListStart = instantRuntime.indexOf('function renderPlaylists()');
const playlistListEnd = instantRuntime.indexOf('\n  function renderLabels()', playlistListStart);
assert.ok(playlistListStart >= 0 && playlistListEnd > playlistListStart,
  'the rendered playlist list must remain independently testable');
const playlistList = instantRuntime.slice(playlistListStart, playlistListEnd);
for (const field of ['growth24', 'growth7', 'growth30', 'Fit score']) {
  assert.ok(playlistList.includes(field), `the playlist table must restore its ${field} analytical control`);
}
assert.doesNotMatch(playlistList, /href="https:\/\/open\.spotify\.com\/playlist\//,
  'a playlist name click must no longer eject the user from Lofi Radar');
assert.match(playlistList, /data-open-playlist/,
  'playlist rows must open the internal analytical card');

assert.match(analyticsRuntime, /window\.SpotifyPlaylistAnalytics|global\.SpotifyPlaylistAnalytics/,
  'the lazy module must expose the browser API expected by the visible runtime');
assert.match(analyticsRuntime, /Spotify_Playlist_Analytics_data\.js/,
  'playlist detail must hydrate the dedicated source-backed follower-history payload');
assert.match(analyticsRuntime, /SPOTIFY_PLAYLIST_ANALYTICS/,
  'the renderer must resolve the dedicated playlist analytics global');
assert.doesNotMatch(analyticsRuntime, /Spotify_Playlists(?:_canonical)?_data\.js/,
  'playlist detail must never parse the 12,938-row build input or use the stale legacy export');
assert.match(analyticsRuntime, /Date\.now\(\)/,
  'opening a playlist must not reuse yesterday\'s canonical snapshot from a long browser cache');
assert.match(analyticsRuntime, /class="playlist-kpis"/,
  'playlist detail must expose its follower KPI section');
assert.match(analyticsRuntime, /data-playlist-chart/,
  'playlist detail must expose a real follower-history graph');
assert.match(analyticsRuntime, /class="analytics-section playlist-variations"/,
  'playlist detail must expose its latest real consecutive-day variations');
for (const days of [1, 7, 30]) {
  assert.match(analyticsRuntime, new RegExp(`counterWindow\\([^,]+,\\s*${days}\\)`),
    `playlist detail must calculate the exact ${days}-day follower window`);
}
for (const field of ['first_seen', 'last_seen', 'history']) {
  assert.ok(analyticsRuntime.includes(field), `playlist detail is missing the ${field} analytical field`);
}
assert.match(analyticsRuntime, /https:\/\/open\.spotify\.com\/playlist\//,
  'the external Spotify URL may remain only as a secondary CTA inside the detail card');
assert.doesNotMatch(analyticsRuntime, /<iframe|open\.spotify\.com\/embed/i,
  'playlist analytics must stay native to the Radar instead of embedding Spotify');
assert.match(analyticsRuntime, /data-close-modal/,
  'the analytical card must close through the existing internal modal control');

const subject = require('../spotify/playlist-analytics.js').__test;
assert.ok(subject && typeof subject.normalizeCounterHistory === 'function' &&
  typeof subject.counterWindow === 'function' && typeof subject.dailyChanges === 'function',
  'playlist analytics must expose its history helpers for regression tests');

assert.deepEqual(subject.normalizeCounterHistory([
  ['2026-07-03', 130],
  ['2026-07-01', 100],
  ['2026-07-02', null],
  ['2026-07-02', ''],
  ['2026-07-04', false],
  ['not-a-day', 999],
  ['2026-07-03', 140],
  {date: '2026-07-05', value: 150},
]), [
  ['2026-07-01', 100],
  ['2026-07-03', 140],
  ['2026-07-05', 150],
], 'playlist history must exclude missing counters, validate dates, deduplicate days, and stay sorted');

const completeHistory = [
  ['2026-06-01', 100],
  ['2026-07-01', 400],
  ['2026-07-17', 600],
  ['2026-07-24', 700],
  ['2026-07-29', 760],
  ['2026-07-30', 780],
  ['2026-07-31', 800],
];
for (const [days, current, previous] of [[1, 20, 20], [7, 100, 100], [30, 400, 300]]) {
  const window = subject.counterWindow(completeHistory, days);
  assert.equal(window.current, current, `${days}-day growth must use the exact D-${days} point`);
  assert.equal(window.previous, previous, `${days}-day comparison must use the exact D-${days * 2} point`);
  assert.equal(window.currentReady, true);
  assert.equal(window.comparisonReady, true);
}
const gappedWindow = subject.counterWindow([
  ['2026-07-29', 760],
  ['2026-07-31', 800],
], 1);
assert.equal(gappedWindow.current, null,
  'a missing D-1 observation must never be interpolated into a fake 24-hour delta');
assert.equal(gappedWindow.currentReady, false);
assert.deepEqual(subject.dailyChanges([
  ['2026-07-28', 740],
  ['2026-07-29', 760],
  ['2026-07-31', 800],
  ['2026-08-01', 805],
]), [['2026-07-29', 20], ['2026-08-01', 5]],
'latest variations must use only consecutive observed days and preserve gaps');

// The historical discovery export remains a useful baseline, but the live
// canonical model must preserve it and add genuine daily observations.
const legacy = evaluate('Spotify_Playlists_data.js', 'SPOTIFY_PLAYLISTS');
const canonical = evaluate('Spotify_Playlists_canonical_data.js', 'SPOTIFY_PLAYLISTS');
const analytics = evaluate('Spotify_Playlist_Analytics_data.js', 'SPOTIFY_PLAYLIST_ANALYTICS');
const catalogue = evaluate('Spotify_Catalogue_data.js', 'SPOTIFY_CATALOGUE');
assert.ok(legacy && canonical && Array.isArray(canonical.rows) && canonical.hist,
  'the playlist data model must expose rows and follower histories');
const column = Object.fromEntries(canonical.cols.map((name, index) => [name, index]));
for (const required of ['id', 'followers', 'first_seen', 'last_seen', 'big10k']) {
  assert.ok(Number.isInteger(column[required]), `canonical playlist model is missing ${required}`);
}
const canonicalIds = new Set(canonical.rows.map(row => row[column.id]));
const legacyIdIndex = legacy.cols.indexOf('id');
assert.equal(canonicalIds.size, canonical.rows.length, 'canonical playlist IDs must stay unique');
assert.ok(legacy.rows.every(row => canonicalIds.has(row[legacyIdIndex])),
  'daily analytics must not drop a playlist from the discovery baseline');
for (const [playlistId, points] of Object.entries(legacy.hist || {})) {
  assert.ok(Array.isArray(canonical.hist[playlistId]) && canonical.hist[playlistId].length >= points.length,
    `canonical history must preserve the legacy baseline for ${playlistId}`);
}

const visible = canonical.rows.filter(row => row[column.big10k] === true || row[column.big10k] === 1 || row[column.big10k] === '1');
assert.ok(visible.length > 0, 'the daily follower cohort must contain visible playlists');
assert.ok(visible.every(row => Array.isArray(canonical.hist[row[column.id]]) && canonical.hist[row[column.id]].length > 0),
  'every visible playlist must have a real source-backed follower history');
assert.ok(visible.some(row => canonical.hist[row[column.id]].length >= 3),
  'the canonical model must contain a genuine multi-day series that can draw a graph');
for (const row of visible) {
  const points = canonical.hist[row[column.id]];
  const days = points.map(point => point[0]);
  assert.equal(new Set(days).size, days.length, `history days must be unique for ${row[column.id]}`);
  assert.deepEqual(days, days.slice().sort(), `history days must be sorted for ${row[column.id]}`);
  assert.ok(points.every(point => Number.isFinite(Number(point[1])) && Number(point[1]) >= 0),
    `history counters must be finite and non-negative for ${row[column.id]}`);
}

const status = canonical.meta && canonical.meta.playlist_followers_status;
assert.ok(status && /^\d{4}-\d{2}-\d{2}$/.test(status.day),
  'canonical metadata must declare the measured Paris follower day');
assert.equal(status.scope, 'dashboard');
assert.equal(status.expected, visible.length,
  'daily coverage must target every playlist visible in the dashboard');
assert.equal(status.updated + status.missing, status.expected,
  'daily coverage counts must reconcile exactly');
assert.equal(status.complete, status.expected > 0 && status.missing === 0,
  'freshness may be complete only when no visible playlist is missing');
assert.equal(status.complete, true, 'the published analytical cohort must be complete');
assert.equal(status.updated, status.expected, 'every visible playlist must have the published scan day');
assert.equal(status.missing, 0, 'the published analytical cohort cannot omit a visible playlist');
assert.ok(status.expected >= 554, 'the daily analytical cohort must never regress below the verified 554 playlists');

assert.equal(analytics.version, 1);
assert.equal(analytics.generated_at, canonical.meta.generated_ts,
  'dedicated analytics generation time must stay tied to its canonical source snapshot');
assert.equal(JSON.stringify(analytics.status), JSON.stringify(status),
  'dedicated scan freshness must equal the canonical source without inventing a newer date');
assert.deepEqual(Array.from(analytics.cols), [
  'id', 'name', 'owner', 'curatorCat', 'followers', 'tracks', 'first_seen',
  'last_seen', 'genre', 'use_case', 'fit', 'estDate', 'estConf', 'image_url',
], 'the dedicated payload must expose every playlist-detail field and nothing unrelated');
assert.equal(analytics.rows.length, visible.length,
  'the dedicated payload must contain the exact visible playlist cohort');
assert.equal(Object.keys(analytics.hist || {}).length, visible.length,
  'the dedicated payload must contain one real history per visible playlist');
const analyticsColumn = Object.fromEntries(analytics.cols.map((name, index) => [name, index]));
const analyticsIds = new Set(analytics.rows.map(row => row[analyticsColumn.id]));
assert.equal(analyticsIds.size, visible.length, 'dedicated playlist IDs must stay unique');
const canonicalById = new Map(canonical.rows.map(row => [row[column.id], row]));
for (const row of analytics.rows) {
  const playlistId = row[analyticsColumn.id];
  const sourceRow = canonicalById.get(playlistId);
  assert.ok(sourceRow, `dedicated row ${playlistId} must come from the canonical model`);
  for (const field of analytics.cols) {
    assert.equal(
      JSON.stringify(row[analyticsColumn[field]]),
      JSON.stringify(sourceRow[column[field]]),
      `dedicated ${field} for ${playlistId} must equal its canonical source`,
    );
  }
}
for (const row of visible) {
  const playlistId = row[column.id];
  assert.ok(analyticsIds.has(playlistId), `dedicated analytics must include visible playlist ${playlistId}`);
  assert.equal(
    JSON.stringify(analytics.hist[playlistId]),
    JSON.stringify(canonical.hist[playlistId]),
    `dedicated history for ${playlistId} must equal the canonical source point for point`,
  );
}

const compactColumn = Object.fromEntries(catalogue.schemas.playlists.map((name, index) => [name, index]));
for (const field of ['growth_24h', 'growth_7d', 'growth_30d']) {
  assert.ok(Number.isInteger(compactColumn[field]), `the public playlist table is missing ${field}`);
}
const compactById = new Map(catalogue.playlists.map(row => [row[compactColumn.spotify_id], row]));
for (const row of visible) {
  const playlistId = row[column.id];
  const compactRow = compactById.get(playlistId);
  assert.ok(compactRow, `the public playlist table must include ${playlistId}`);
  for (const [days, field] of [[1, 'growth_24h'], [7, 'growth_7d'], [30, 'growth_30d']]) {
    assert.equal(
      compactRow[compactColumn[field]],
      subject.counterWindow(canonical.hist[playlistId], days).current,
      `${field} must equal the exact observed canonical window for ${playlistId}`,
    );
  }
}
assert.ok(fs.statSync(path.join(root, 'Spotify_Playlist_Analytics_data.js')).size <= 1_000_000,
  'the lazy analytical cohort must remain bounded instead of regrowing into the raw 12,938-row export');

// Hosted schedules own the daily scan. They measure the Paris-day cohort,
// publish every real point, then alert if the cohort remains incomplete.
const crons = [...followerWorkflow.matchAll(/cron:\s*['"]?([^'"\n]+)/g)].map(match => match[1].trim());
assert.ok(crons.length >= 2, 'playlist followers need a hosted primary pass and a same-day catch-up');
assert.match(followerWorkflow, /ZoneInfo\(['"]Europe\/Paris['"]\)/,
  'daily follower dates must use the Europe/Paris calendar');
const coverageBefore = followerWorkflow.indexOf("id: coverage_before");
const refresh = followerWorkflow.indexOf('Refresh every playlist published in the dashboard');
const coverageAfter = followerWorkflow.indexOf('Measure coverage after collection');
const buildProjection = followerWorkflow.indexOf('Build the lazy playlist analytics payload');
const publish = followerWorkflow.indexOf('Publish follower history independently');
const strictCoverage = followerWorkflow.indexOf('Require 100 percent daily follower coverage');
assert.ok(coverageBefore >= 0 && coverageBefore < refresh && refresh < coverageAfter &&
  coverageAfter < buildProjection && buildProjection < publish && publish < strictCoverage,
  'daily scan must measure, refresh, remeasure, publish real points, then enforce complete coverage');
assert.match(followerWorkflow, /--mode playlists[\s\S]{0,300}--playlist-scope dashboard[\s\S]{0,300}--playlists Spotify_Playlists_canonical_data\.js/,
  'the hosted scan must refresh the complete visible canonical playlist cohort');
assert.match(followerWorkflow, /playlist_follower_daily_status\.py[\s\S]{0,300}--require-complete/,
  'an incomplete daily scan must remain visibly failed and due for catch-up');
assert.match(followerWorkflow, /build_spotify_playlist_analytics\.py[\s\S]{0,300}--output Spotify_Playlist_Analytics_data\.js/,
  'every real daily scan must rebuild the dedicated playlist analytics payload');
const publicationSection = followerWorkflow.slice(publish, strictCoverage);
assert.match(publicationSection, /git add[^\n]+Spotify_Playlist_Analytics_data\.js/,
  'the source-backed analytics payload must publish with the same daily follower commit');
assert.doesNotMatch(followerWorkflow, /test_spotify_playlist_analytics_runtime/,
  'the source-data scan must stay independent from the derived UI/catalogue build');
for (const [relative, workflow] of postBuildWorkflows) {
  assert.match(workflow, /node tests\/test_spotify_playlist_analytics_runtime\.js/,
    `${relative} must validate playlist analytics after its UI/data build`);
}

console.log(`Spotify playlist analytics runtime: ${visible.length} daily playlists, ${Object.keys(canonical.hist).length} histories`);
