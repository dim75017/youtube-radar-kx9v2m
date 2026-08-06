'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const start = dashboard.indexOf('function discoveryArray');
const end = dashboard.indexOf('function discoveryArtistKey', start);
assert.ok(start >= 0 && end > start, 'the public discovery projection must remain independently testable');

const trackSchema = [
  'spotify_id', 'soundcharts_uuid', 'title', 'credit_name', 'artists', 'streams',
  'primary_genre', 'genre_confidence', 'instrumental_status', 'instrumental_confidence',
  'ai_risk', 'rights_status', 'rights_confidence', 'expansion_status',
];
const artistSchema = ['name', 'spotify_id', 'soundcharts_uuid'];
const artist = (suffix, complete = true) => ({
  name: `Artist ${suffix}`,
  spotify_id: `artist-spotify-${suffix}`,
  soundcharts_uuid: complete ? `artist-soundcharts-${suffix}` : '',
});
const track = (id, overrides = {}) => ({
  spotify_id: id,
  soundcharts_uuid: `soundcharts-${id}`,
  title: `Track ${id}`,
  credit_name: `Artist ${id}`,
  artists: [artist(id)],
  streams: 200_000,
  primary_genre: 'ambient',
  genre_confidence: 0.9,
  instrumental_status: 'instrumental',
  instrumental_confidence: 0.9,
  ai_risk: 'low',
  rights_status: 'self_released',
  rights_confidence: 0.9,
  expansion_status: 'eligible',
  ...overrides,
});
const compact = (record, schema) => schema.map(field => record[field] ?? null);

const safe = track('safe');
const duplicate = track('safe', {title: 'Duplicate safe row'});
const vocal = track('vocal', {instrumental_status: 'vocal'});
const unknown = track('unknown', {instrumental_status: 'unknown'});
const aiUnknown = track('ai-unknown', {ai_risk: 'unknown'});
const major = track('major', {rights_status: 'major'});
const rightsUnknown = track('rights-unknown', {rights_confidence: null});
const incomplete = track('incomplete', {artists: [artist('incomplete', false)]});
const trusted = track('trusted', {
  soundcharts_uuid: '',
  credit_name: 'Powfu',
  artists: [{name: 'Powfu', spotify_id: 'artist-spotify-trusted', soundcharts_uuid: ''}],
  primary_genre: 'trusted_catalogue',
  genre_confidence: null,
  instrumental_status: 'vocal',
  instrumental_confidence: null,
  ai_risk: 'unknown',
  expansion_status: '',
});
const trustedExact = {...trusted, spotify_id: 'trusted-exact', title: 'Trusted exact', streams: 100_000};
const trustedBelow = {...trusted, spotify_id: 'trusted-below', title: 'Trusted below', streams: 99_999};
const highStreams = track('high-streams', {streams: 500_000_000});
const phonkAlias = track('phonk-alias', {primary_genre: 'instrumental_phonk'});
const dnbAlias = track('dnb-alias', {primary_genre: 'instrumental_dnb'});
const browse = {
  trusted_internal_spotify_ids: ['trusted', 'trusted-exact', 'trusted-below'],
  discovery_catalogue: {
    track_schema: trackSchema,
    artist_schema: artistSchema,
    playlist_schema: [],
    tracks: [safe, duplicate, vocal, unknown, aiUnknown, major, rightsUnknown, incomplete, trusted, trustedExact, trustedBelow, highStreams, phonkAlias, dnbAlias].map(row => compact(row, trackSchema)),
    artists: [
      artist('safe'), artist('vocal'), artist('unknown'), artist('ai-unknown'), artist('incomplete'),
      {name: 'Powfu', spotify_id: 'artist-spotify-trusted', soundcharts_uuid: ''},
      artist('high-streams'), artist('phonk-alias'), artist('dnb-alias'),
    ].map(row => compact(row, artistSchema)),
  },
};
const publicRows = [safe, vocal, unknown, trusted, trustedExact, trustedBelow].map(row => [0, row.title, '', row.streams, 0, '', row.spotify_id]);
const context = {
  BROWSE: browse,
  R: publicRows,
  TRUSTED_INTERNAL_SPOTIFY_IDS: new Set(browse.trusted_internal_spotify_ids),
  SC_ALLOWED_GENRES: new Set(['ambient', 'instrumental_phonk', 'instrumental_dnb']),
  MIN_TRACK_LIFETIME_STREAMS: 100_000,
  SC_MAX_TRACK_STREAMS: 250_000_000,
  isGeneralArtistQuarantined(name) { return String(name || '').toLowerCase() === 'powfu'; },
};
vm.runInNewContext(
  `${dashboard.slice(start, end)};
   this.strictTracks=DISCOVERY_TRACKS;
   this.strictArtists=DISCOVERY_ARTISTS;
   this.retainedRows=R;`,
  context,
);

assert.deepEqual(
  Array.from(context.strictTracks, row => row.spotify_id),
  ['safe', 'trusted', 'trusted-exact', 'high-streams', 'phonk-alias', 'dnb-alias'],
  'only an exact spreadsheet ID may bypass external instrumental evidence gates',
);
assert.equal(context.strictTracks[0].title, 'Track safe',
  'a duplicate Spotify ID must be represented only once');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'high-streams'), true,
  'the public gate must not impose an upper lifetime-stream ceiling');
assert.deepEqual(
  Array.from(context.strictArtists, row => row.spotify_id),
  ['artist-spotify-safe', 'artist-spotify-trusted', 'artist-spotify-high-streams', 'artist-spotify-phonk-alias', 'artist-spotify-dnb-alias'],
  'public artists must come from accepted strict tracks or the exact internal cohort',
);
assert.deepEqual(
  Array.from(context.retainedRows, row => row[6]),
  ['safe', 'trusted', 'trusted-exact'],
  'legacy public rows must survive only when accepted by the strict or internal projection',
);
assert.equal(context.strictTracks.some(row => row.spotify_id === 'trusted-below'), false,
  'the internal inventory lane must still enforce the inclusive 100k stream floor');

assert.doesNotMatch(
  dashboard.slice(dashboard.indexOf('const DISCOVERY_CATALOGUE'), dashboard.indexOf('const RAW_DISCOVERY_TRACKS')),
  /STRICT_DISCOVERY|SC\.discovery_catalogue|flatMap/,
  'the public discovery catalogue must not concatenate rotating review data',
);
assert.match(dashboard, /'phonk_instrumental','instrumental_phonk','dnb_instrumental','instrumental_dnb'/,
  'the public taxonomy must accept both builder and historical instrumental genre codes');

console.log('Spotify strict public projection: OK');
