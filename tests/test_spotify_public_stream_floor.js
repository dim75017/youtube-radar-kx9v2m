'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
assert.match(dashboard, /const MIN_TRACK_LIFETIME_STREAMS = 100000;/,
  'the public lifetime-stream floor must stay fixed at 100,000');
assert.match(dashboard, /applyLatestPerformanceCounters\(R,PERF_TRACKS\);[\s\S]*applyMinimumTrackLifetimeFloor\(R\);/,
  'the public floor must run after current cumulative counters are applied');
const preparationStart = dashboard.indexOf('const BROWSE = window.SPOTIFY_BROWSE_CATALOGUE || {};');
const preparationEnd = dashboard.indexOf('/* Soundcharts renvoie parfois', preparationStart);
assert.ok(preparationStart >= 0 && preparationEnd > preparationStart,
  'the final public track preparation must remain independently testable');

const artistRows = [
  ['Below only', 0, '', false, false, 'catalogue', '', 'artist-below'],
  ['At threshold', 0, '', false, false, 'catalogue', '', 'artist-exact'],
  ['Corrected below', 0, '', false, false, 'catalogue', '', 'artist-down'],
  ['Corrected to threshold', 0, '', false, false, 'catalogue', '', 'artist-up'],
  ['Clearly above', 0, '', false, false, 'catalogue', '', 'artist-high'],
];
const legacyRows = [
  [0, 'Below', '2026-07-01', 99_999, 1, 'Low Label', 'legacy-below'],
  [1, 'Exact', '2026-07-02', 100_000, 1, 'Shared Label', 'legacy-exact'],
  [2, 'Corrected down', '2026-07-03', 120_000, 1, 'Down Label', 'legacy-down'],
  [3, 'Corrected up', '2026-07-04', 99_999, 1, 'Shared Label', 'legacy-up'],
  [4, 'High', '2026-07-05', 150_000, 1, 'High Label', 'legacy-high'],
];
const activeLegacyIds = legacyRows.map(row => row[6]);
const discoveryTrackSchema = [
  'soundcharts_uuid', 'spotify_id', 'title', 'credit_name', 'artists', 'release_date',
  'streams', 'rights_status', 'rights_confidence', 'label', 'availability_status',
  'primary_genre', 'genre_confidence', 'instrumental_status', 'instrumental_confidence',
  'ai_risk', 'expansion_status',
];
const discoveryArtistSchema = [
  'soundcharts_uuid', 'spotify_id', 'name', 'monthly_listeners', 'availability_status',
];
const discoveryTracks = [
  {
    soundcharts_uuid: 'browse-track-below', spotify_id: 'browse-below', title: 'Browse below',
    credit_name: 'Browse Below Artist', release_date: '2026-07-06', streams: 99_999,
    rights_status: 'independent_label', rights_confidence: 0.9, label: 'Low Label', availability_status: 'measured',
    primary_genre: 'ambient', genre_confidence: 0.9, instrumental_status: 'instrumental',
    instrumental_confidence: 0.9, ai_risk: 'low', expansion_status: 'eligible',
    artists: [{soundcharts_uuid: 'browse-artist-below', spotify_id: 'browse-artist-below-id', name: 'Browse Below Artist'}],
  },
  {
    soundcharts_uuid: 'browse-track-exact', spotify_id: 'browse-exact', title: 'Browse exact',
    credit_name: 'Browse Exact Artist', release_date: '2026-07-07', streams: 100_000,
    rights_status: 'independent_label', rights_confidence: 0.9, label: 'Shared Label', availability_status: 'measured',
    primary_genre: 'ambient', genre_confidence: 0.9, instrumental_status: 'instrumental',
    instrumental_confidence: 0.9, ai_risk: 'low', expansion_status: 'eligible',
    artists: [{soundcharts_uuid: 'browse-artist-exact', spotify_id: 'browse-artist-exact-id', name: 'Browse Exact Artist'}],
  },
  {
    soundcharts_uuid: 'browse-track-high', spotify_id: 'browse-high', title: 'Browse high',
    credit_name: 'Browse High Artist', release_date: '2026-07-08', streams: 150_000,
    rights_status: 'independent_label', rights_confidence: 0.9, label: 'High Label', availability_status: 'measured',
    primary_genre: 'ambient', genre_confidence: 0.9, instrumental_status: 'instrumental',
    instrumental_confidence: 0.9, ai_risk: 'low', expansion_status: 'eligible',
    artists: [{soundcharts_uuid: 'browse-artist-high', spotify_id: 'browse-artist-high-id', name: 'Browse High Artist'}],
  },
  {
    soundcharts_uuid: 'browse-track-down', spotify_id: 'browse-down', title: 'Browse corrected down',
    credit_name: 'Browse Down Artist', release_date: '2026-07-09', streams: 120_000,
    rights_status: 'independent_label', rights_confidence: 0.9, label: 'Down Label', availability_status: 'measured',
    primary_genre: 'ambient', genre_confidence: 0.9, instrumental_status: 'instrumental',
    instrumental_confidence: 0.9, ai_risk: 'low', expansion_status: 'eligible',
    artists: [{soundcharts_uuid: 'browse-artist-down', spotify_id: 'browse-artist-down-id', name: 'Browse Down Artist'}],
  },
];
const discoveryArtists = [
  {
    soundcharts_uuid: 'browse-artist-below', spotify_id: 'browse-artist-below-id',
    name: 'Browse Below Artist', monthly_listeners: 60_000, availability_status: 'measured',
  },
  {
    soundcharts_uuid: 'browse-artist-exact', spotify_id: 'browse-artist-exact-id',
    name: 'Browse Exact Artist', monthly_listeners: 60_000, availability_status: 'measured',
  },
  {
    soundcharts_uuid: 'browse-artist-high', spotify_id: 'browse-artist-high-id',
    name: 'Browse High Artist', monthly_listeners: 60_000, availability_status: 'measured',
  },
  {
    soundcharts_uuid: 'browse-artist-down', spotify_id: 'browse-artist-down-id',
    name: 'Browse Down Artist', monthly_listeners: 60_000, availability_status: 'measured',
  },
];
const compact = (record, schema) => schema.map(field => record[field] ?? null);

const context = {
  console,
  D: {artists: artistRows, rows: legacyRows, hist: {}},
  MIN_TRACK_LIFETIME_STREAMS: 100_000,
  window: {
    SPOTIFY_BROWSE_CATALOGUE: {
      active_legacy_spotify_ids: activeLegacyIds,
      policy: {
        external_instrumental_evidence_gate: {
          version: 1,
          grandfathered_spotify_ids: discoveryTracks.map(row => row.spotify_id),
        },
      },
      discovery_catalogue: {
        track_schema: discoveryTrackSchema,
        artist_schema: discoveryArtistSchema,
        playlist_schema: [],
        tracks: discoveryTracks.map(row => compact(row, discoveryTrackSchema)),
        artists: discoveryArtists.map(row => compact(row, discoveryArtistSchema)),
      },
    },
    SPOTIFY_PERFORMANCE: {
      tracks: {
        'browse-down': {history: [['2026-07-31', 99_999]]},
      },
    },
  },
  normalizeCounterHistory(points) {
    return Array.isArray(points) ? points : [];
  },
  sanitizeTrackCounterHistory(points) {
    return Array.isArray(points) ? points : [];
  },
};
vm.runInNewContext(
  `${dashboard.slice(preparationStart, preparationEnd)};
   this.publicRows=R;
   this.publicArtists=A;`,
  context,
);

const publicRows = context.publicRows;
const publicIds = Array.from(publicRows, row => row[6]).sort();
assert.deepEqual(publicIds, [
  'browse-exact',
  'browse-high',
], 'all public track sources use the same inclusive 100,000-stream floor after current counters');
for (const hidden of ['legacy-below', 'legacy-down', 'legacy-exact', 'legacy-high', 'legacy-up', 'browse-below', 'browse-down']) {
  assert.equal(publicIds.includes(hidden), false, `${hidden} must stay out of every public projection`);
}
assert.equal(publicIds.includes('browse-down'), false,
  'a current observed counter below 100,000 must fail even if the stored catalogue value was higher');

const aggregateStart = dashboard.indexOf('const AG = A.map');
const aggregateEnd = dashboard.indexOf('/* ---------- module Playlists', aggregateStart);
assert.ok(aggregateStart >= 0 && aggregateEnd > aggregateStart,
  'artist aggregates must remain independently testable');
const aggregateContext = {
  A: context.publicArtists,
  R: publicRows,
  HOT: 1_000_000,
  RATE: 0.003,
  perMonth() { return 0; },
  performanceForRows() {
    return {
      1: {current: null},
      7: {current: null},
      30: {current: null},
    };
  },
};
vm.runInNewContext(
  `${dashboard.slice(aggregateStart, aggregateEnd)};
   this.artistAggregates=withTracks;
   this.totalStreams=totStreams;`,
  aggregateContext,
);
const artistAggregates = aggregateContext.artistAggregates;
assert.equal(artistAggregates.reduce((sum, artist) => sum + artist.n, 0), publicRows.length,
  'artist track counts must be derived from the filtered public rows only');
assert.equal(aggregateContext.totalStreams, 250_000,
  'artist lifetime-stream totals must equal the filtered public track sum');
for (const hiddenArtist of ['Below only', 'Corrected below', 'Browse Below Artist', 'Browse Down Artist']) {
  assert.equal(Array.from(artistAggregates, artist => artist.name).includes(hiddenArtist), false,
    `${hiddenArtist} must not survive through an artist aggregate`);
}

const labelsStart = dashboard.indexOf('const LB_LICENSE_RE');
const labelsEnd = dashboard.indexOf('function labelRowsOf(key)', labelsStart);
assert.ok(labelsStart >= 0 && labelsEnd > labelsStart,
  'active label aggregation must remain independently testable');
const labelContext = {
  R: publicRows,
  RATE: 0.003,
  LB: {rows: []},
  LBrows: [],
  LBmeta: {},
};
vm.runInNewContext(
  `${dashboard.slice(labelsStart, labelsEnd)};
   this.activeLabels=LBrows;
   this.activeLabelMeta=LBmeta;
   this.dreamscapeLabel=labelDisplayName('dreamscape, a division of Kurate Music Ltd.');`,
  labelContext,
);
const labels = Array.from(labelContext.activeLabels, row => Array.from(row));
assert.equal(labelContext.dreamscapeLabel, 'dreamscape');
assert.deepEqual(
  labels.map(row => [row[0], row[2], row[3], row[6]]).sort((a, b) => a[0].localeCompare(b[0])),
  [
    ['high label', 1, 150_000, 1],
    ['shared label', 1, 100_000, 1],
  ],
  'label track, stream and artist aggregates must ignore every sub-floor track',
);
assert.equal(labelContext.activeLabelMeta.tracks_covered, 2,
  'label coverage counts only filtered label-owned public tracks');
assert.equal(labelContext.activeLabelMeta.labels_count, 2,
  'labels represented solely by sub-floor tracks must disappear');

console.log('Spotify public 100k stream floor and derived aggregates: OK');

