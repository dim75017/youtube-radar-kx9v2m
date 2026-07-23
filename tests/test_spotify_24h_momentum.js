'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');
const tracksStart = source.indexOf('function renderOpps(){');
const artistsStart = source.indexOf('function renderArtists(){');
const playlistsStart = source.indexOf('function renderPlaylists(){');
const tracks = source.slice(tracksStart, artistsStart);
const artists = source.slice(artistsStart, playlistsStart);

assert.ok(tracksStart >= 0 && artistsStart > tracksStart, 'Tracks renderer must exist');
assert.match(tracks, /streamStackHtml\(w1\.current,false,true\)/, 'Tracks 24h must use a signed momentum value');
assert.match(tracks, /class="num stream-24h"/, 'Tracks 24h table cell must be highlighted');
assert.match(tracks, /Self-release/);
assert.match(tracks, /Autre label/);
for (const removed of ['Mesurées', 'À mesurer', 'À vérifier / écouter', 'Présentes en playlist éditoriale', 'Découvertes via catalogue artiste']) {
  assert.doesNotMatch(tracks, new RegExp(removed), `Obsolete browse filter still rendered: ${removed}`);
}
assert.match(artists, /streamStackHtml\(g\.streams24,false,true\)/, 'Artists 24h must use a signed momentum value');
assert.match(artists, /class="num stream-24h"/, 'Artists 24h table cell must be highlighted');
assert.match(css, /\.stream-24h \.stream-number\{color:var\(--acc2\)\}/);
assert.match(css, /\.buyout-estimate\{font-weight:600;color:var\(--text\)\}/);
assert.match(index, /dashboard\.css\?v=20260723-24h-momentum-v1/);

console.log('spotify 24h momentum UI: OK');
