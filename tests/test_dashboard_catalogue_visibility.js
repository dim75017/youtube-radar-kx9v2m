'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'spotify', 'index.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'spotify', 'dashboard.js'), 'utf8');

assert.match(dashboard, /const A = \(D\.artists \|\| \[\]\)\.map/,
  'the historical artist catalogue must remain a browsing source');
assert.match(dashboard, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/,
  'the historical track catalogue must remain visible after its explicit filters');
assert.match(dashboard, /const DISCOVERY_CATALOGUE = SC&&SC\.discovery_catalogue/,
  'the Soundcharts discovery catalogue must be merged into the dashboard');
assert.doesNotMatch(dashboard, /const A = \[\];/,
  'the public catalogue must never be replaced by an empty artist array');
assert.doesNotMatch(dashboard, /const LEGACY_R = \[\];/,
  'the public catalogue must never be replaced by an empty track array');
assert.doesNotMatch(dashboard, /const DISCOVERY_CATALOGUE = \{tracks:\[\],artists:\[\],counts:\{\}\};/,
  'the published Soundcharts discovery catalogue must never be ignored');

const snapshotMatch = index.match(/Spotify_Soundcharts_data_[^?"']+\.js/);
assert.ok(snapshotMatch, 'spotify/index.html must reference an active Soundcharts snapshot');
const snapshotName = snapshotMatch[0];

function readPayload(file, prefix) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(text.startsWith(prefix), `${file} must start with ${prefix}`);
  return JSON.parse(text.slice(prefix.length).trim().replace(/;$/, ''));
}

const radar = readPayload('Spotify_Radar_data.js', 'window.SPOTIFY_RADAR=');
const soundcharts = readPayload(snapshotName, 'window.SPOTIFY_SOUNDCHARTS=');
const catalogue = soundcharts.discovery_catalogue || {};
const discoveryTracks = Array.isArray(catalogue.tracks) ? catalogue.tracks : [];
const discoverySchema = Array.isArray(catalogue.track_schema) ? catalogue.track_schema : [];
const playlistDiscovery = soundcharts.playlist_discovery || {};

assert.ok(Array.isArray(radar.rows) && radar.rows.length >= 40_000,
  `historical catalogue unexpectedly small: ${Array.isArray(radar.rows) ? radar.rows.length : 0}`);
assert.ok(discoveryTracks.length >= 10_000,
  `discovery catalogue unexpectedly small: ${discoveryTracks.length}`);
assert.ok(discoveryTracks.length >= Number(playlistDiscovery.unique_playlist_tracks || 0),
  'every unique editorial-playlist track must be published in discovery_catalogue');

const banned = new Set([
  'powfu','metallica','michael jackson','justin bieber','bruno mars','shakira','lady gaga',
  'pitbull','david guetta','calvin harris','dua lipa','kendrick lamar','black eyed peas',
  'sean paul','jennifer lopez','ellie goulding','bring me the horizon','a$ap rocky','asap rocky',
  'sarcastic sounds','rxseboy','sody',
]);
const composite = value => /[&,]/.test(String(value || '').trim())
  || /(?:^|\s)(?:feat(?:uring)?|ft|x|×)\.?(?:\s|$)/i.test(String(value || '').trim());
const artists = Array.isArray(radar.artists) ? radar.artists : [];
const visibleLegacy = radar.rows.filter(row => {
  const artist = artists[Number(row && row[0])];
  const name = String(artist && artist[0] || '').trim();
  return artist && Number(artist[4] || 0) !== 1
    && name && !banned.has(name.toLowerCase()) && !composite(name);
});

const keys = new Set(visibleLegacy.map(row => String(row && row[6] || '')).filter(Boolean));
const spotifyIndex = discoverySchema.indexOf('spotify_id');
const uuidIndex = discoverySchema.indexOf('soundcharts_uuid');
for (const row of discoveryTracks) {
  const spotifyId = spotifyIndex >= 0 && Array.isArray(row) ? String(row[spotifyIndex] || '') : '';
  const uuid = uuidIndex >= 0 && Array.isArray(row) ? String(row[uuidIndex] || '') : '';
  const key = spotifyId || (uuid ? `soundcharts:${uuid}` : '');
  if (key) keys.add(key);
}

assert.ok(keys.size >= 45_000,
  `estimated browsable catalogue regressed to ${keys.size} unique track keys`);

console.log(JSON.stringify({
  snapshot: snapshotName,
  historical_rows: radar.rows.length,
  visible_legacy_rows: visibleLegacy.length,
  discovery_tracks: discoveryTracks.length,
  estimated_unique_track_keys: keys.size,
}, null, 2));
