'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardPath = path.join(__dirname, '..', 'spotify', 'dashboard.js');
const source = fs.readFileSync(dashboardPath, 'utf8');

const identityStart = source.indexOf('const GENERAL_VIEW_QUARANTINED_ARTISTS');
const identityEnd = source.indexOf('/* Historical rows remain browseable inventory', identityStart);
assert.ok(identityStart >= 0 && identityEnd > identityStart, 'general-view identity helpers must remain defined');

const identityContext = {};
vm.runInNewContext(
  `${source.slice(identityStart, identityEnd)};
   this.isComposite=isCompositeArtistCredit;
   this.isQuarantined=isGeneralArtistQuarantined;`,
  identityContext,
);

for (const composite of [
  'Lil Jon & The East Side Boyz',
  'Sam & Dave',
  'Artist feat. Singer',
  'Artist featuring Singer',
  'Artist ft Singer',
  'Artist x Producer',
  'Artist × Producer',
  'Artist, Producer',
]) {
  assert.equal(identityContext.isComposite(composite), true, `${composite} is a display credit, not an identity`);
  assert.equal(identityContext.isQuarantined(composite), true, `${composite} must stay out of general views`);
  assert.equal(identityContext.isQuarantined(composite, true), false,
    `${composite} may be a canonical provider entity when both structured IDs are present`);
}
for (const individual of ['xander.', 'Max Richter', 'The xx', "D'Angelo", 'A.L.I.S.O.N']) {
  assert.equal(identityContext.isComposite(individual), false, `${individual} must not be treated as a composite credit`);
}
assert.equal(identityContext.isQuarantined('Bruno Mars'), true, 'reviewed mainstream identities stay quarantined');
assert.equal(identityContext.isQuarantined('Bruno Mars', true), true,
  'a complete ID pair never overrides the reviewed mainstream quarantine');

const legacyStart = source.indexOf('const A = (D.artists || [])');
const legacyEnd = source.indexOf('/* Raccord progressif', legacyStart);
const legacyContext = {
  BROWSE: {active_legacy_spotify_ids: ['safe-track']},
  D: {
    artists: [
      ['Solo Artist', 0, 'ok', 1, 0],
      ['Sam & Dave', 0, 'ok', 1, 0],
      ['Bruno Mars', 0, 'ok', 1, 0],
      ['Retired Discovery', 0, 'ok', 1, 1],
    ],
    rows: [
      [0, 'Safe instrumental', '', 10, 0, '', 'safe-track'],
      [1, 'Composite credit', '', 10, 0, '', 'composite-track'],
      [2, 'Mainstream vocal', '', 10, 0, '', 'mainstream-track'],
      [3, 'Retired discovery', '', 10, 0, '', 'retired-track'],
    ],
  },
};
vm.runInNewContext(`${source.slice(legacyStart, legacyEnd)}; this.archiveRows=LEGACY_R; this.visibleRows=R;`, legacyContext);
assert.deepEqual(
  Array.from(legacyContext.archiveRows, row => row[6]),
  ['safe-track'],
  'legacy archive keeps safe inventory while quarantining composite, mainstream and retired rows',
);
assert.deepEqual(
  Array.from(legacyContext.visibleRows, row => row[6]),
  ['safe-track'],
  'active public rows require a current Soundcharts-backed identity pair',
);

const taxonomyStart = source.indexOf('const SC_ALLOWED_GENRES');
const taxonomyEnd = source.indexOf('function scVerifiedOpportunityIndex', taxonomyStart);
const taxonomyContext = {};
vm.runInNewContext(
  `${source.slice(taxonomyStart, taxonomyEnd)};
   this.allowedGenres=SC_ALLOWED_GENRES;
   this.minListeners=SC_MIN_LISTENERS;
   this.maxListeners=SC_MAX_LISTENERS;`,
  taxonomyContext,
);
for (const genre of ['acoustic', 'fingerstyle', 'soundscape']) {
  assert.equal(taxonomyContext.allowedGenres.has(genre), true, `${genre} must remain in the public taxonomy`);
}
assert.equal(taxonomyContext.maxListeners, 5_000_000,
  'dashboard artist ceiling must match the existing Soundcharts pipeline');
assert.equal(taxonomyContext.minListeners, 1_000,
  'dashboard artist floor must match the strict snapshot projection');

const gateStart = source.indexOf('function scHasCompleteStructuredArtists');
const gateEnd = source.indexOf('function scEditorialIndex', gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, 'general-view track gate must remain defined');
const artistSchema = ['spotify_id', 'soundcharts_uuid', 'monthly_listeners', 'name'];
const gateContext = {
  SC: {
    schemas: {artists: artistSchema},
    artists: [
      ['artist-spotify', 'artist-soundcharts', 1_000, 'Solo Artist'],
      ['artist-a-spotify', 'artist-a-soundcharts', 2_000, 'Artist A'],
      ['artist-b-spotify', 'artist-b-soundcharts', 5_000_000, 'Artist B'],
      ['low-audience-spotify', 'low-audience-soundcharts', 999, 'Too Small'],
      ['high-audience-spotify', 'high-audience-soundcharts', 5_000_001, 'Too Large'],
    ],
  },
  SC_ALLOWED_GENRES: taxonomyContext.allowedGenres,
  SC_MIN_LISTENERS: taxonomyContext.minListeners,
  SC_MAX_LISTENERS: taxonomyContext.maxListeners,
  SC_MAX_TRACK_STREAMS: 250_000_000,
  scField(row, schema, name) {
    const index = schema.indexOf(name);
    return index < 0 ? null : row[index];
  },
};
vm.runInNewContext(
  `${source.slice(gateStart, gateEnd)};
   this.isEligible=scGeneralTrackEligible;`,
  gateContext,
);

const schema = [
  'spotify_id', 'soundcharts_uuid', 'primary_genre', 'genre_confidence', 'instrumental_status',
  'instrumental_confidence', 'ai_risk', 'rights_status', 'rights_confidence',
  'expansion_status', 'streams', 'artists',
];
const valid = [
  'track-id', 'track-soundcharts', 'ambient', 0.9, 'instrumental', 0.9, 'low',
  'self_released', 0.9, 'eligible', 1_000_000,
  [{spotify_id: 'artist-spotify', soundcharts_uuid: 'artist-soundcharts', name: 'Solo Artist'}],
];
const changed = (index, value) => {
  const row = valid.slice();
  row[index] = value;
  return row;
};
assert.equal(gateContext.isEligible(valid, schema), true);
assert.equal(gateContext.isEligible(changed(10, 0), schema), true,
  'zero observed streams is a valid factual value');
assert.equal(gateContext.isEligible(changed(10, 250_000_000), schema), true,
  'the explicit stream ceiling is inclusive');
for (const genre of ['acoustic', 'fingerstyle', 'soundscape']) {
  assert.equal(gateContext.isEligible(changed(2, genre), schema), true,
    `${genre} tracks remain eligible when all strict evidence is present`);
}
assert.equal(gateContext.isEligible(changed(11, [
  {spotify_id: 'artist-a-spotify', soundcharts_uuid: 'artist-a-soundcharts', name: 'Artist A'},
  {spotify_id: 'artist-b-spotify', soundcharts_uuid: 'artist-b-soundcharts', name: 'Artist B'},
]), schema), true, 'a collaboration remains eligible when every collaborator has structured IDs');
for (const invalid of [
  changed(0, ''),
  changed(1, ''),
  changed(2, 'pop'),
  changed(3, 0.49),
  changed(4, 'unknown'),
  changed(5, 0.49),
  changed(6, 'unknown'),
  changed(7, 'major'),
  changed(7, 'unknown'),
  changed(8, 0.49),
  changed(9, 'review'),
  changed(10, ''),
  changed(10, 250_000_001),
  changed(11, [{spotify_id: 'artist-spotify', soundcharts_uuid: '', name: 'Solo Artist'}]),
  changed(11, [{spotify_id: 'artist-spotify', soundcharts_uuid: 'unknown-soundcharts', name: 'Solo Artist'}]),
  changed(11, [{spotify_id: 'artist-a-spotify', soundcharts_uuid: 'artist-b-soundcharts', name: 'Crossed Pair'}]),
  changed(11, [{spotify_id: 'low-audience-spotify', soundcharts_uuid: 'low-audience-soundcharts', name: 'Too Small'}]),
  changed(11, [{spotify_id: 'high-audience-spotify', soundcharts_uuid: 'high-audience-soundcharts', name: 'Too Large'}]),
]) {
  assert.equal(gateContext.isEligible(invalid, schema), false);
}

assert.match(source, /const A = \(D\.artists \|\| \[\]\)\.map/,
  'historical artists remain a browsing source');
assert.match(source, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/,
  'historical tracks remain a browsing source');
assert.doesNotMatch(source, /const A = \[\];/);
assert.doesNotMatch(source, /const LEGACY_R = \[\];/);
assert.match(source, /if\(a\[7\]&&!isGeneralArtistQuarantined\(a\[0\]\)\) artistById\.set\(a\[7\],i\)/,
  'a structured ID cannot revive an old malformed display-credit identity');
assert.match(source, /const structuredComplete=Boolean\(String\(id\|\|''\)\.trim\(\)&&String\(meta\.uuid\|\|''\)\.trim\(\)\)/);
assert.match(source, /if\(isGeneralArtistQuarantined\(name,structuredComplete\)\) return -1/);
assert.match(source, /if\(!scGeneralTrackEligible\(row,trackSchema\)\) continue;\s+const existingTrack=trackById\.has\(id\)/,
  'an unsafe Soundcharts row cannot mutate or mark an existing legacy track');
assert.match(source, /&&scHasEligibleSanitizedArtists\(artists\)/,
  'every collaborator pair must belong to the sanitized public artist projection');
assert.match(source, /const sanitizedArtist=scSanitizedArtistPair\(person\);\s+if\(!sanitizedArtist\) continue/,
  'merge must fail closed when a complete pair is absent from SC.artists');
assert.doesNotMatch(source, /structured export membership is the evidence/,
  'a complete pair on the track alone cannot be used as identity evidence');
assert.match(source, /function arOpportunityRows\(/, 'track-first A&R opportunities remain a separate path');
assert.match(source, /const AR_MAX_MONTHLY_LISTENERS = SC_MAX_LISTENERS/,
  'A&R and general views share the explicit pipeline ceiling');

console.log('dashboard general-view guardrails: OK');
