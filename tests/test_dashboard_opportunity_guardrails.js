'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardPath = path.join(__dirname, '..', 'spotify', 'dashboard.js');
const source = fs.readFileSync(dashboardPath, 'utf8');
const helperStart = source.indexOf('function arHasCompleteStructuredArtists');
const helperEnd = source.indexOf('function arOpportunityRows', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'A&R guardrail helpers must remain defined');

const context = {
  SC_ALLOWED_GENRES: new Set(['ambient', 'piano']),
};
vm.runInNewContext(`${source.slice(helperStart, helperEnd)}; this.isContactable=arIsContactable;`, context);

const valid = {
  status: 'verified',
  genre: 'ambient',
  genreConfidence: 0.9,
  instrumental: 'instrumental',
  instrumentalConfidence: 0.9,
  aiRisk: 'low',
  rights: 'self_released',
  artists: [{spotify_id: 'artist-spotify', soundcharts_uuid: 'artist-soundcharts'}],
  contactStatus: 'ready',
  contactEmail: 'public@example.test',
  contactUrl: '',
};

assert.equal(context.isContactable(valid), true);
for (const invalid of [
  {...valid, status: 'needs_listen'},
  {...valid, rights: 'unknown'},
  {...valid, aiRisk: 'unknown'},
  {...valid, genre: 'pop'},
  {...valid, genreConfidence: 0.49},
  {...valid, instrumentalConfidence: null},
  {...valid, artists: [{spotify_id: 'artist-spotify', soundcharts_uuid: ''}]},
  {...valid, contactStatus: 'ready', contactEmail: ''},
]) {
  assert.equal(context.isContactable(invalid), false);
}

const searchStart = source.indexOf('function arSearchText');
const searchEnd = source.indexOf('function arOpportunityFiltered', searchStart);
assert.ok(searchStart >= 0 && searchEnd > searchStart, 'A&R search helpers must remain defined');
const searchContext = {};
vm.runInNewContext(
  source.slice(searchStart, searchEnd) + '; this.matches=arOpportunityMatchesSearch;',
  searchContext,
);
const searchable = {
  title: 'Éveil',
  credit: 'Måns Reitz',
  label: 'Score à Score',
  labels: ['Score à Score'],
  artists: [{name: 'Måns Reitz'}],
};
for (const query of ['', 'eveil', 'mans reitz', 'score a score']) {
  assert.equal(searchContext.matches(searchable, query), true);
}
assert.equal(searchContext.matches(searchable, 'absent'), false);

assert.match(source, /arOpportunityMatchesSearch\(opportunity,S\.radarQ\)/);
assert.match(source, /if\(S\.radarFilter==='contactable'\) return arIsContactable\(opportunity\)/);
assert.match(source, /const contactable=all\.filter\(arIsContactable\)/);
assert.match(source, /if\(!arIsContactable\(opportunity\)\) return/);
assert.match(source, /filter\(item=>item\.spotifyId&&item\.title&&arHasCompleteStructuredArtists\(item\.artists\)\)/);
for (const quarantined of [
  'bruno mars', 'justin bieber', 'michael jackson', 'shakira', 'lady gaga',
  'pitbull', 'david guetta', 'calvin harris', 'dua lipa', 'kendrick lamar',
  'black eyed peas', 'sean paul', 'jennifer lopez', 'ellie goulding',
  'metallica', 'a$ap rocky', 'powfu', 'sarcastic sounds', 'rxseboy',
]) {
  assert.ok(source.includes(`'${quarantined}'`), `${quarantined} must remain quarantined`);
}

console.log('dashboard opportunity guardrails: OK');
