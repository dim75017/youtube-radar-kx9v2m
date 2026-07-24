'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

for (const required of [
  'function spotifyUpdateRows()',
  'function spotifyUpdateColor(when)',
  'function toggleSpotifyUpdateStatus(event)',
  'Pistes', 'Artistes', 'Playlists', 'Labels'
]) assert.ok(dashboard.includes(required), `Spotify update status is incomplete: ${required}`);
for (const required of ['.btn-spotify-update-status', '.spotify-update-status-panel', '.spotify-update-status-line']) {
  assert.ok(css.includes(required), `Spotify update status styling missing: ${required}`);
}
assert.match(dashboard, /const dated=candidates\.map/,
  'published timestamps are compared rather than using an arbitrary fallback');
assert.match(dashboard, /dated\.sort\(\(a,b\)=>b\.time-a\.time\)\[0\]\.value/,
  'the newest real timestamp is selected');
assert.match(dashboard, /const publishedAt=spotifyUpdateTimestamp\(/,
  'the panel derives one timestamp for the published radar');
for (const category of ['tracksAt','artistsAt','playlistsAt','labelsAt']) {
  assert.match(dashboard, new RegExp(`const ${category}=publishedAt;`),
    `${category} must use the common published snapshot timestamp`);
}
assert.match(index, /dashboard\.js\?v=20260724-selection-layout-v1/,
  'the browser receives the new status script');

console.log('Spotify synchronized update status: OK');
