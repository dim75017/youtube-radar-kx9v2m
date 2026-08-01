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

const rightsStart = source.indexOf('function arReleaseTypeLabel');
const rightsEnd = source.indexOf('function arPlaylistPreviewHtml', rightsStart);
assert.ok(rightsStart >= 0 && rightsEnd > rightsStart, 'A&R self-release and rights helpers must remain defined');
const rightsContext = {
  arNullableNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  },
  hasExclusiveLicenseText(...values) {
    return values.some(value => /exclusive\s+licen[cs]e/i.test(String(value || '')));
  },
  conciseLicenseeName(value) {
    return String(value || '').replace(/\s*,\s*(?:an?\s+)?division\s+of\b.*$/i, '').trim();
  },
  arOpportunityRows() { return rightsContext.rows; },
  esc(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  },
  rows: [],
};
vm.runInNewContext(`${source.slice(rightsStart, rightsEnd)}; this.isSelfRelease=arIsSelfReleaseOpportunity; this.radarRows=arRadarOpportunityRows; this.creditDetails=arRightsCreditDetails; this.rightsHtml=arRightsCreditsHtml;`, rightsContext);
const selfRelease = {rights: 'self_released', rightsConfidence: 0.9, label: 'Artist Imprint', labels: [], copyright: '2026 Artist Imprint', distributor: ''};
assert.equal(rightsContext.isSelfRelease(selfRelease), true);
for (const rejected of [
  {...selfRelease, rights: 'independent_label'},
  {...selfRelease, rights: 'indie'},
  {...selfRelease, rights: 'unknown'},
  {...selfRelease, rightsConfidence: 0.74},
  {...selfRelease, copyright: '2026 Artist, under exclusive license to Real Label'},
]) {
  assert.equal(rightsContext.isSelfRelease(rejected), false);
}
rightsContext.rows = [selfRelease, {...selfRelease, rights: 'independent_label'}];
assert.equal(rightsContext.radarRows().length, 1, 'The Opportunity projection must retain only strict self-releases');
const untyped = rightsContext.creditDetails(selfRelease);
assert.equal(untyped.copyright, '');
assert.equal(untyped.phonographic, '');
assert.equal(untyped.raw, '2026 Artist Imprint');
assert.equal(untyped.sourceTyped, false);
const typed = rightsContext.creditDetails({...selfRelease, copyright: '© 2025 Writer (P) 2026 Artist'});
assert.equal(typed.copyright, '2025 Writer');
assert.equal(typed.phonographic, '2026 Artist');
const mojibakeName = rightsContext.creditDetails({...selfRelease, copyright: '2024 Milo RydÃ©n'});
assert.equal(mojibakeName.sourceTyped, false);
assert.equal(mojibakeName.copyright, '');
assert.equal(mojibakeName.phonographic, '');
const mojibakePhonographic = rightsContext.creditDetails({...selfRelease, copyright: 'â„— 2024 Artist'});
assert.equal(mojibakePhonographic.phonographic, '2024 Artist');
assert.match(rightsContext.rightsHtml({...selfRelease, copyright: 'â„— 2024 Artist'}), /℗ 2024 Artist/);
const renderedRights = rightsContext.rightsHtml({...selfRelease, copyright: '<rights>', label: '<label>', credit: 'must-not-leak'});
assert.match(renderedRights, /&lt;rights&gt;/);
assert.match(renderedRights, /&lt;label&gt;/);
assert.doesNotMatch(renderedRights, /must-not-leak/);
const dreamscapeRights = rightsContext.rightsHtml({...selfRelease, label: 'dreamscape, a division of Kurate Music Ltd.'});
assert.match(dreamscapeRights, /<strong>dreamscape<\/strong>/);
assert.doesNotMatch(dreamscapeRights, /Kurate Music/);
const emptyRights = rightsContext.rightsHtml({...selfRelease, copyright: '', label: '', credit: 'must-not-leak'});
assert.match(emptyRights, /—/);
assert.doesNotMatch(emptyRights, /must-not-leak/);

const listenersStart = source.indexOf('function monthlyListenersMetricCardHtml');
const listenersEnd = source.indexOf('function periodMetricLabel', listenersStart);
assert.ok(listenersStart >= 0 && listenersEnd > listenersStart, 'Monthly listener performance card helper must remain defined');
const listenersContext = {T: value => value, fmtFullMetric: value => value == null ? '—' : new Intl.NumberFormat('fr-FR').format(value)};
vm.runInNewContext(`${source.slice(listenersStart, listenersEnd)}; this.listenersCard=monthlyListenersMetricCardHtml;`, listenersContext);
assert.match(listenersContext.listenersCard(123456), /123(?:\u202f|\s)456/);
assert.match(listenersContext.listenersCard(null), />—</);
assert.doesNotMatch(listenersContext.listenersCard(null), />0</);

assert.match(source, /arOpportunityMatchesSearch\(opportunity,S\.radarQ\)/);
assert.match(source, /if\(!arIsSelfReleaseOpportunity\(opportunity\)\) return false/);
assert.match(source, /if\(S\.radarFilter==='contactable'\) return arIsContactable\(opportunity\)/);
// The contactable filter is enforced in arOpportunityFiltered above. Do not
// couple this policy check to a removed UI-only aggregate variable.
assert.match(source, /if\(!arContactEligible\(opportunity\)\) return/);
assert.match(source, /arOpportunityTotal\(item\)>=MIN_TRACK_LIFETIME_STREAMS/,
  'sub-100k tracks must not re-enter the public Opportunity view');
assert.match(source, /arHasCompleteStructuredArtists\(item\.artists\)/);
assert.match(source, /!isGeneralArtistQuarantined\(item\.credit,true\)/);
assert.match(source, /!item\.artists\.some\(artist=>isGeneralArtistQuarantined/);
for (const quarantined of [
  'bruno mars', 'justin bieber', 'michael jackson', 'shakira', 'lady gaga',
  'pitbull', 'david guetta', 'calvin harris', 'dua lipa', 'kendrick lamar',
  'black eyed peas', 'sean paul', 'jennifer lopez', 'ellie goulding',
  'metallica', 'a$ap rocky', 'powfu', 'sarcastic sounds', 'rxseboy',
  'corbon amodio',
]) {
  assert.ok(source.includes(`'${quarantined}'`), `${quarantined} must remain quarantined`);
}

console.log('dashboard opportunity guardrails: OK');
