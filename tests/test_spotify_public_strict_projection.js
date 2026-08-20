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
  'ai_review_required', 'opportunity_eligible', 'soundcharts_evidence_contract',
  'source_evidence',
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
  ai_review_required: false,
  opportunity_eligible: true,
  rights_status: 'self_released',
  rights_confidence: 0.9,
  expansion_status: 'eligible',
  soundcharts_evidence_contract: 'soundcharts_song_v2.25_evidence_v3',
  source_evidence: {
    source_contract: 'soundcharts_song_v2.25_evidence_v3',
    instrumental: true,
    vocal: false,
  },
  ...overrides,
});
const compact = (record, schema) => schema.map(field => record[field] ?? null);

const safe = track('safe');
const duplicate = track('safe', {title: 'Duplicate safe row'});
const vocal = track('vocal', {instrumental_status: 'vocal'});
const unknown = track('unknown', {instrumental_status: 'unknown'});
const missingEvidence = track('missing-evidence', {
  soundcharts_evidence_contract: null,
  source_evidence: null,
});
const scoreOnly = track('score-only', {
  source_evidence: {instrumentalness: 0.99, instrumental: true, vocal: null},
});
const legacyV2Evidence = track('legacy-v2-evidence', {
  soundcharts_evidence_contract: 'soundcharts_song_v2.25_evidence_v2',
  source_evidence: {
    source_contract: 'soundcharts_song_v2.25_evidence_v2',
    instrumental: true,
    vocal: false,
  },
});
const legacyExternal = track('legacy-external', {
  soundcharts_evidence_contract: null,
  source_evidence: null,
});
const aiUnknown = track('ai-unknown', {
  ai_risk: 'unknown',
  ai_review_required: true,
  opportunity_eligible: false,
});
const aiUnknownUnmarked = track('ai-unknown-unmarked', {
  ai_risk: 'unknown',
  ai_review_required: false,
  opportunity_eligible: false,
});
const aiReview = track('ai-review', {
  ai_risk: 'à vérifier',
  ai_review_required: true,
  opportunity_eligible: false,
  expansion_status: 'review',
});
const aiHigh = track('ai-high', {
  ai_risk: 'high',
  ai_review_required: true,
  opportunity_eligible: false,
});
const reviewExpansionLow = track('review-expansion-low', {expansion_status: 'review'});
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
  soundcharts_evidence_contract: null,
  source_evidence: null,
});
const trustedExact = {...trusted, spotify_id: 'trusted-exact', title: 'Trusted exact', streams: 100_000};
const trustedBelow = {...trusted, spotify_id: 'trusted-below', title: 'Trusted below', streams: 99_999};
const highStreams = track('high-streams', {streams: 500_000_000});
const phonkAlias = track('phonk-alias', {primary_genre: 'instrumental_phonk'});
const dnbAlias = track('dnb-alias', {primary_genre: 'instrumental_dnb'});
const browse = {
  policy: {
    external_instrumental_evidence_gate: {
      version: 1,
      grandfathered_spotify_ids: ['legacy-external'],
    },
  },
  trusted_internal_spotify_ids: ['trusted', 'trusted-exact', 'trusted-below'],
  discovery_catalogue: {
    track_schema: trackSchema,
    artist_schema: artistSchema,
    playlist_schema: [],
    tracks: [safe, duplicate, vocal, unknown, missingEvidence, scoreOnly, legacyV2Evidence,
      legacyExternal,
      aiUnknown, aiUnknownUnmarked, aiReview, aiHigh,
      reviewExpansionLow, major, rightsUnknown, incomplete, trusted, trustedExact, trustedBelow,
      highStreams, phonkAlias, dnbAlias].map(row => compact(row, trackSchema)),
    artists: [
      artist('safe'), artist('vocal'), artist('unknown'), artist('missing-evidence'),
      artist('score-only'), artist('legacy-v2-evidence'), artist('legacy-external'), artist('ai-unknown'),
      artist('ai-unknown-unmarked'), artist('ai-review'), artist('ai-high'),
      artist('review-expansion-low'), artist('incomplete'),
      {name: 'Powfu', spotify_id: 'artist-spotify-trusted', soundcharts_uuid: ''},
      artist('high-streams'), artist('phonk-alias'), artist('dnb-alias'),
    ].map(row => compact(row, artistSchema)),
  },
};
const publicRows = [safe, {...safe, title: 'Duplicate legacy safe'}, vocal, unknown,
  missingEvidence, scoreOnly, legacyExternal, trusted, trustedExact, trustedBelow]
  .map(row => [0, row.title, '', row.streams, 0, '', row.spotify_id]);
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
  ['safe', 'legacy-external', 'ai-unknown', 'ai-review', 'review-expansion-low', 'trusted', 'trusted-exact',
    'high-streams', 'phonk-alias', 'dnb-alias'],
  'only an exact spreadsheet ID may bypass external instrumental evidence gates',
);
assert.equal(context.strictTracks[0].title, 'Track safe',
  'a duplicate Spotify ID must be represented only once');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'high-streams'), true,
  'the public gate must not impose an upper lifetime-stream ceiling');
assert.deepEqual(
  Array.from(context.strictArtists, row => row.spotify_id),
  ['artist-spotify-safe', 'artist-spotify-legacy-external', 'artist-spotify-ai-unknown', 'artist-spotify-ai-review',
    'artist-spotify-review-expansion-low', 'artist-spotify-trusted',
    'artist-spotify-high-streams', 'artist-spotify-phonk-alias', 'artist-spotify-dnb-alias'],
  'public artists must come from accepted strict tracks or the exact internal cohort',
);
assert.deepEqual(
  Array.from(context.retainedRows, row => row[6]),
  ['safe', 'legacy-external', 'trusted', 'trusted-exact'],
  'legacy public rows must survive once per Spotify ID when accepted by the strict or internal projection',
);
assert.equal(context.strictTracks.some(row => row.spotify_id === 'trusted-below'), false,
  'the internal inventory lane must still enforce the inclusive 100k stream floor');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'ai-unknown-unmarked'), false,
  'an old or unmarked unknown-AI row must not bypass the canonical review marker');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'ai-high'), false,
  'explicit high AI risk must stay outside All Tracks and All Artists');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'missing-evidence'), false,
  'a new external row without source evidence must stay outside the public UI');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'score-only'), false,
  'instrumentalness or instrumental=true without explicit no-lyrics evidence is insufficient');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'legacy-v2-evidence'), false,
  'the v2 contract can contain score-derived booleans and must never be publication evidence');
assert.equal(context.strictTracks.some(row => row.spotify_id === 'legacy-external'), true,
  'the exact transition grandfather list preserves the reviewed historical external catalogue');

const classificationStart = dashboard.indexOf('function classificationFromEntry');
const classificationEnd = dashboard.indexOf('function trackClassification', classificationStart);
assert.ok(classificationStart >= 0 && classificationEnd > classificationStart,
  'the public classification formatter must remain independently testable');
const classificationContext = {
  NON_MUSICAL_GENRE_MARKERS: new Set(),
  UNCLASSIFIED_GENRE: 'À classifier',
};
vm.runInNewContext(
  `${dashboard.slice(classificationStart, classificationEnd)};
   this.classificationFromEntry=classificationFromEntry;`,
  classificationContext,
);
assert.equal(classificationContext.classificationFromEntry({ai_risk: 'unknown'}).aiRisk, 'à vérifier',
  'canonical AI-review entries must be labelled « À vérifier » in Analytics profiles');

const arEligibleStart = dashboard.indexOf('function arHasCompleteStructuredArtists');
const arEligibleEnd = dashboard.indexOf('function arOpportunityRows', arEligibleStart);
assert.ok(arEligibleStart >= 0 && arEligibleEnd > arEligibleStart,
  'the opportunity evidence gate must remain independently testable');
const arContext = {SC_ALLOWED_GENRES: new Set(['ambient'])};
vm.runInNewContext(
  `${dashboard.slice(arEligibleStart, arEligibleEnd)};
   this.arContactEligible=arContactEligible;`,
  arContext,
);
const opportunity = {
  status: 'verified',
  genre: 'ambient',
  genreConfidence: 0.9,
  instrumental: 'instrumental',
  instrumentalConfidence: 0.9,
  rights: 'self_released',
  artists: [artist('opportunity')],
};
assert.equal(arContext.arContactEligible({...opportunity, aiRisk: 'low'}), true,
  'a fully evidenced low-AI opportunity remains eligible');
assert.equal(arContext.arContactEligible({...opportunity, aiRisk: 'unknown'}), false,
  'AI-review inventory must never leak into Opportunities');
assert.equal(arContext.arContactEligible({...opportunity, aiRisk: 'high'}), false,
  'high-AI rows must never become Opportunities');

assert.doesNotMatch(
  dashboard.slice(dashboard.indexOf('const DISCOVERY_CATALOGUE'), dashboard.indexOf('const RAW_DISCOVERY_TRACKS')),
  /STRICT_DISCOVERY|SC\.discovery_catalogue|flatMap/,
  'the public discovery catalogue must not concatenate rotating review data',
);
assert.match(dashboard, /'phonk_instrumental','instrumental_phonk','dnb_instrumental','instrumental_dnb'/,
  'the public taxonomy must accept both builder and historical instrumental genre codes');

console.log('Spotify strict public projection: OK');
