'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {assertSpotifyLightBootstrap} = require('./spotify_light_bootstrap_contract');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

for (const required of [
  'function spotifyUpdateRows()',
  'function spotifyUpdateColor(when)',
  'function spotifyOldestUpdateTimestamp(...values)',
  'function toggleSpotifyUpdateStatus(event)',
  'Pistes', 'Artistes', 'Playlists', 'Labels'
]) assert.ok(dashboard.includes(required), `Spotify update status is incomplete: ${required}`);
for (const required of ['.btn-spotify-update-status', '.spotify-update-status-panel', '.spotify-update-status-line']) {
  assert.ok(css.includes(required), `Spotify update status styling missing: ${required}`);
}
assert.match(dashboard, /const dated=candidates\.map/,
  'source timestamps are compared rather than using an arbitrary fallback');
assert.match(dashboard, /dated\.sort\(\(a,b\)=>b\.time-a\.time\)\[0\]\.value/,
  'the newest timestamp helper remains available for same-source fallbacks');
assert.match(dashboard, /dated\.sort\(\(a,b\)=>a\.time-b\.time\)\[0\]\.value/,
  'combined page freshness follows the oldest required source');
assert.doesNotMatch(dashboard, /const publishedAt=spotifyUpdateTimestamp\(/,
  'an unrelated fresh file must not set every category timestamp');
assert.doesNotMatch(dashboard, /generated_ts:new Date\(\)\.toISOString\(\)/,
  'client-side label derivation must never manufacture source freshness');
assert.match(dashboard, /const tracksAt=performanceStoreBroken\?null:spotifyOldestUpdateTimestamp\(/);
assert.match(dashboard, /const artistsAt=performanceStoreBroken\?null:spotifyOldestUpdateTimestamp\(/);
assert.match(dashboard, /performanceFreshness\.tracks_catalogue_at\|\|performanceFreshness\.tracks_at/,
  'track freshness prefers the last complete catalogue pass');
assert.match(dashboard, /performanceFreshness\.artists_catalogue_at\|\|performanceFreshness\.artists_at/,
  'artist freshness prefers the last complete catalogue pass');
assert.match(dashboard, /const playlistsAt=spotifyOldestUpdateTimestamp\(/);
assert.match(dashboard, /const labelsAt=tracksAt;/,
  'labels inherit track freshness because their index is derived from active tracks');
assertSpotifyLightBootstrap(index);

const statusStart = dashboard.indexOf('function spotifyUpdateTimestamp');
const statusEnd = dashboard.indexOf('function refreshSpotifyUpdateStatus', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'status helpers must remain testable');
const context = {
  SC: {
    generated_at: '2026-07-27T12:00:00Z',
    freshness: {
      tracks_at: '2026-07-27T12:00:00Z',
      artists_at: '2026-07-27T12:00:00Z',
      instrumental_pool_at: '2026-07-27T12:00:00Z',
      playlist_discovery_at: '2026-07-27T12:00:00Z',
      independent_playlist_discovery_at: '2026-07-27T12:00:00Z',
    },
  },
  BROWSE: {generated_at: '2026-07-27T12:00:00Z'},
  PERF: {
    generated_at: '2026-07-27T12:00:00Z',
    freshness: {
      tracks_at: '2026-07-26T12:00:00Z',
      tracks_catalogue_at: '2026-07-25T12:00:00Z',
      artists_at: '2026-07-26T12:00:00Z',
      artists_catalogue_at: '2026-07-24T12:00:00Z',
      playlists_at: '2026-07-26T12:00:00Z',
    },
  },
  PLmeta: {
    snapshot_ts: '2026-07-20 12:00',
    generated_ts: '2026-07-27 12:00',
  },
  R: Array.from({length: 12}),
  withTracks: Array.from({length: 3}),
  PLrows: Array.from({length: 5}),
  LBrows: Array.from({length: 2}),
  LANG: 'fr',
  T: value => value,
  fmtFull: value => String(value),
  window: {SPOTIFY_PERFORMANCE_STORE_READY: true},
  result: null,
};
vm.runInNewContext(
  `${dashboard.slice(statusStart, statusEnd)}\nresult=spotifyUpdateRows();`,
  context,
);
const byLabel = Object.fromEntries(context.result.map(row => [row.label, row.when]));
assert.equal(byLabel.Pistes, '2026-07-25T12:00:00Z');
assert.equal(byLabel.Artistes, '2026-07-24T12:00:00Z');
assert.equal(byLabel.Playlists, '2026-07-20 12:00');
assert.equal(byLabel.Labels, byLabel.Pistes);

context.window.SPOTIFY_PERFORMANCE_STORE_READY = false;
vm.runInNewContext(
  `${dashboard.slice(statusStart, statusEnd)}\nresult=spotifyUpdateRows();`,
  context,
);
const brokenByLabel = Object.fromEntries(context.result.map(row => [row.label, row]));
assert.equal(brokenByLabel.Pistes.when, null);
assert.equal(brokenByLabel.Pistes.error, true);
assert.equal(brokenByLabel.Artistes.when, null);
assert.equal(brokenByLabel.Artistes.error, true);
assert.equal(brokenByLabel.Labels.when, null);
assert.equal(brokenByLabel.Labels.error, true);
assert.equal(brokenByLabel.Playlists.error, false);
assert.match(brokenByLabel.Pistes.detail, /Historique streams incomplet/);

console.log('Spotify synchronized update status: OK');
