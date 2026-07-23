'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const index = fs.readFileSync('spotify/index.html', 'utf8');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');
const policy = fs.readFileSync('SPOTIFY_RADAR_POLICY.md', 'utf8');

assert.match(index, /Spotify_Browse_Catalogue_data\.js\?payload=/,
  'the broad catalogue must load independently from the strict Soundcharts snapshot');
assert.ok(index.indexOf('Spotify_Browse_Catalogue_data.js') < index.indexOf('dashboard.js'),
  'the broad catalogue must load before the dashboard bundle');
assert.match(dashboard, /const BROWSE = window\.SPOTIFY_BROWSE_CATALOGUE \|\| \{\};/);
assert.match(dashboard, /const A = \(D\.artists \|\| \[\]\)\.map/,
  'historical artists remain a browsing source');
assert.match(dashboard, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/,
  'historical tracks remain a browsing source');
assert.match(dashboard, /BROWSE\.discovery_catalogue/,
  'Soundcharts discovery is read from the separate browsing layer');
assert.doesNotMatch(dashboard, /const A = \[\];/);
assert.doesNotMatch(dashboard, /const LEGACY_R = \[\];/);
assert.doesNotMatch(dashboard, /const DISCOVERY_CATALOGUE = \{tracks:\[\],artists:\[\],counts:\{\}\};/);

const arStart = dashboard.indexOf('function arOpportunityRows');
const arEnd = dashboard.indexOf('function arGenreLabel', arStart);
assert.ok(arStart >= 0 && arEnd > arStart, 'the strict A&R opportunity mapper must remain defined');
const arSource = dashboard.slice(arStart, arEnd);
assert.match(arSource, /SC\.opportunities/,
  'A&R remains sourced from the strict Soundcharts opportunity export');
assert.doesNotMatch(arSource, /BROWSE|SPOTIFY_BROWSE_CATALOGUE/,
  'the broad browsing catalogue must never become an A&R opportunity source');
assert.match(dashboard, /function arIsContactable\(/,
  'strict A&R contact guardrails remain defined');
assert.match(policy, /Inventaire de navigation/);
assert.match(policy, /A&R et contacts/);
assert.match(coverage, /Catalogue vivant/);
assert.match(coverage, /A&R reste strict/);

const prefix = 'window.SPOTIFY_BROWSE_CATALOGUE=';
const browseText = fs.readFileSync('Spotify_Browse_Catalogue_data.js', 'utf8');
assert.ok(browseText.startsWith(prefix), 'broad catalogue file must use its dedicated global');
const browse = JSON.parse(browseText.slice(prefix.length).trim().replace(/;$/, ''));
assert.ok(['full', 'strict_instrumental_rebased'].includes(browse.policy.browsing));
assert.equal(browse.policy.ar, 'strict');
assert.equal(browse.policy.unverified_records_contactable, false);
const catalogue = browse.discovery_catalogue || {};
const strictRebased = browse.policy.browsing === 'strict_instrumental_rebased';
assert.ok(Array.isArray(catalogue.tracks) && catalogue.tracks.length >= (strictRebased ? 1 : 10_000),
  `active discovery catalogue unexpectedly small: ${Array.isArray(catalogue.tracks) ? catalogue.tracks.length : 0}`);
assert.ok(Array.isArray(catalogue.artists) && catalogue.artists.length >= (strictRebased ? 1 : 1_000),
  `active discovery artist catalogue unexpectedly small: ${Array.isArray(catalogue.artists) ? catalogue.artists.length : 0}`);
if (strictRebased) {
  assert.equal(browse.policy.archive, 'Spotify_Radar_data.js');
  assert.ok(Array.isArray(browse.active_legacy_spotify_ids));
}
for (const schema of [catalogue.track_schema || [], catalogue.artist_schema || []]) {
  for (const forbidden of ['contact_email', 'contact_url', 'contact_platform', 'email', 'phone']) {
    assert.equal(schema.includes(forbidden), false, `browsing catalogue must not expose ${forbidden}`);
  }
}

const radarPrefix = 'window.SPOTIFY_RADAR=';
const radarText = fs.readFileSync('Spotify_Radar_data.js', 'utf8');
assert.ok(radarText.startsWith(radarPrefix));
const radar = JSON.parse(radarText.slice(radarPrefix.length).trim().replace(/;$/, ''));
assert.ok(Array.isArray(radar.rows) && radar.rows.length >= 40_000,
  `historical browsing catalogue unexpectedly small: ${Array.isArray(radar.rows) ? radar.rows.length : 0}`);

const trackSchema = catalogue.track_schema || [];
const spotifyIndex = trackSchema.indexOf('spotify_id');
const soundchartsIndex = trackSchema.indexOf('soundcharts_uuid');
const keys = new Set(
  radar.rows.map(row => String(row && row[6] || '')).filter(Boolean),
);
for (const row of catalogue.tracks) {
  const spotify = spotifyIndex >= 0 ? String(row[spotifyIndex] || '') : '';
  const soundcharts = soundchartsIndex >= 0 ? String(row[soundchartsIndex] || '') : '';
  if (spotify) keys.add(spotify);
  else if (soundcharts) keys.add(`soundcharts:${soundcharts}`);
}
console.log(JSON.stringify({
  historicalRows: radar.rows.length,
  discoveryTracks: catalogue.tracks.length,
  discoveryArtists: catalogue.artists.length,
  combinedKeys: keys.size,
  strictOpportunities: browse.strict_snapshot_counts && browse.strict_snapshot_counts.opportunities,
}));
assert.ok(keys.size >= 45_000, `combined browsing universe unexpectedly small: ${keys.size}`);

console.log(`Spotify catalogue layers: ${keys.size} browsing keys; A&R stays strict`);
