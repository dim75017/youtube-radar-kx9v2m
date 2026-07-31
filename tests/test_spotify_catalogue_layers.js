'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const index = fs.readFileSync('spotify/index.html', 'utf8');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');
const policy = fs.readFileSync('SPOTIFY_RADAR_POLICY.md', 'utf8');

const activeSnapshotMatch = index.match(/\.\.\/(Spotify_Soundcharts_data_[^?'"\\]+\.js)\?payload=/);
assert.ok(activeSnapshotMatch, 'the active Soundcharts snapshot must be explicit in the page shell');
const activeSnapshot = fs.readFileSync(activeSnapshotMatch[1], 'utf8').toLowerCase();
assert.equal(activeSnapshot.includes('corbon amodio'), false,
  'a manually quarantined vocal artist must never remain in the active public snapshot');

assert.match(index, /Spotify_Browse_Catalogue_data\.js\?payload=/,
  'the broad catalogue must load independently from the strict Soundcharts snapshot');
assert.ok(index.indexOf('Spotify_Browse_Catalogue_data.js') < index.indexOf('dashboard.js'),
  'the broad catalogue must load before the dashboard bundle');
assert.match(dashboard, /const BROWSE = window\.SPOTIFY_BROWSE_CATALOGUE \|\| \{\};/);
assert.match(dashboard, /const A = Array\.from\(D\.artists \|\| \[\],/,
  'historical artists remain a browsing source');
assert.match(dashboard, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/,
  'historical tracks remain a browsing source');
assert.match(dashboard, /BROWSE\.discovery_catalogue/,
  'Soundcharts discovery is read from the separate browsing layer');
assert.doesNotMatch(dashboard, /const A = \[\];/);
assert.doesNotMatch(dashboard, /const LEGACY_R = \[\];/);
assert.doesNotMatch(dashboard, /const DISCOVERY_CATALOGUE = \{tracks:\[\],artists:\[\],counts:\{\}\};/);
assert.match(dashboard, /catalogues\.map\(normalizeDiscoveryCatalogue\)/,
  'each discovery source must be decoded before concatenation');
assert.doesNotMatch(dashboard, /tracks:catalogues\.flatMap\(source=>Array\.isArray\(source\.tracks\)/,
  'raw compact rows must never inherit another source schema');

const helpersStart = dashboard.indexOf('function discoveryArray');
const helpersEnd = dashboard.indexOf('const BROWSE_DISCOVERY', helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart,
  'discovery schema normalizers must remain independently testable');
const mixedCatalogues = [
  {
    track_schema: ['spotify_id','soundcharts_uuid','streams','primary_genre','instrumental_status','playlist_placements'],
    artist_schema: ['name','spotify_id','soundcharts_uuid'],
    playlist_schema: ['spotify_id','name'],
    tracks: [['spotify-a','soundcharts-a',123,'ambient','instrumental',[['playlist-a','Ambient Focus']]]],
    artists: [['Artist A','artist-spotify-a','artist-soundcharts-a']],
  },
  {
    track_schema: ['soundcharts_uuid','spotify_id','primary_genre','streams','instrumental_status','playlist_placements'],
    artist_schema: ['soundcharts_uuid','spotify_id','name'],
    playlist_schema: ['name','spotify_id'],
    tracks: [['soundcharts-b','spotify-b','dark_ambient',456,'instrumental',[['Dark Focus','playlist-b']]]],
    artists: [['artist-soundcharts-b','artist-spotify-b','Artist B']],
  },
];
const schemaContext = {mixedCatalogues, result: null};
vm.runInNewContext(
  `${dashboard.slice(helpersStart, helpersEnd)}
   result=mixedCatalogues.map(normalizeDiscoveryCatalogue);`,
  schemaContext,
);
const normalizedTracks = schemaContext.result.flatMap(source => source.tracks);
const normalizedArtists = schemaContext.result.flatMap(source => source.artists);
assert.deepEqual(
  JSON.parse(JSON.stringify(normalizedTracks.map(track => ({
    spotify_id: track.spotify_id,
    soundcharts_uuid: track.soundcharts_uuid,
    streams: track.streams,
    primary_genre: track.primary_genre,
    instrumental_status: track.instrumental_status,
    playlist_id: track.playlist_placements[0].spotify_id,
  })))),
  [
    {spotify_id:'spotify-a',soundcharts_uuid:'soundcharts-a',streams:123,primary_genre:'ambient',instrumental_status:'instrumental',playlist_id:'playlist-a'},
    {spotify_id:'spotify-b',soundcharts_uuid:'soundcharts-b',streams:456,primary_genre:'dark_ambient',instrumental_status:'instrumental',playlist_id:'playlist-b'},
  ],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(normalizedArtists.map(artist => ({
    name: artist.name,
    spotify_id: artist.spotify_id,
    soundcharts_uuid: artist.soundcharts_uuid,
  })))),
  [
    {name:'Artist A',spotify_id:'artist-spotify-a',soundcharts_uuid:'artist-soundcharts-a'},
    {name:'Artist B',spotify_id:'artist-spotify-b',soundcharts_uuid:'artist-soundcharts-b'},
  ],
);

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
assert.match(coverage, /Catalogue actif/);
assert.match(coverage, /minimumLifetimeStreams = 100000/);

const prefix = 'window.SPOTIFY_BROWSE_CATALOGUE=';
const browseText = fs.readFileSync('Spotify_Browse_Catalogue_data.js', 'utf8');
assert.ok(browseText.startsWith(prefix), 'broad catalogue file must use its dedicated global');
const browse = JSON.parse(browseText.slice(prefix.length).trim().replace(/;$/, ''));
assert.ok([
  'full',
  'strict_instrumental_rebased',
  'trusted_internal_catalogue_plus_strict_soundcharts',
].includes(browse.policy.browsing));
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

