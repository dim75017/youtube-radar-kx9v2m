'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');

function sourceBetween(startToken, endToken) {
  const start = dashboard.indexOf(startToken);
  const end = dashboard.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0, `Missing source token: ${startToken}`);
  assert.ok(end > start, `Missing source boundary: ${endToken}`);
  return dashboard.slice(start, end);
}

const tabsSource = sourceBetween('const AR_STAGE_TABS=[', 'function arListGet(');
const stages = [...tabsSource.matchAll(/\{key:'([^']+)'/g)].map(match => match[1]);
assert.deepEqual(stages, ['to_contact', 'contacted', 'negotiating', 'validated', 'refused'],
  'Selection must expose the five negotiation tabs in workflow order.');

const renderSource = sourceBetween('function renderArList(){', 'function renderWatch(){');
assert.match(renderSource, /role="tablist"/, 'The five stages must render as top-level tabs.');
assert.match(renderSource, /arArtistStage\(arArtistStatus\(group\.artist\.key\)\)/,
  'Derived follow-ups must be counted and filtered through their parent stage.');

const stateSource = sourceBetween("const AR_LIST_STORAGE=", 'function arListEntry(');
const storage = new Map();
const opportunities = {
  track_a: {artistKey: 'artist:one'},
  track_b: {artistKey: 'artist:one'},
  track_c: {artistKey: 'artist:two'},
};
const context = {
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  arSelectionOpportunityById(id) { return opportunities[id] || null; },
  arSelectionPrimaryArtist(opportunity) { return {key: opportunity.artistKey}; },
  arFollowUpDate() { return '2099-01-08'; },
  arSyncListCount() {},
  document: {getElementById() { return null; }},
  Date,
  JSON,
  Number,
  Object,
  String,
};
vm.createContext(context);
vm.runInContext(stateSource, context);

storage.set('spotify_ar_outreach_artists_v1', JSON.stringify({
  'artist:one': {status: 'closed', dealClosedAt: '2025-01-01T00:00:00.000Z'},
}));
assert.equal(vm.runInContext("arArtistStatus('artist:one')", context), 'validated',
  'Legacy closed artist state must migrate to the Validé stage.');

const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
storage.set('spotify_ar_outreach_artists_v1', JSON.stringify({
  'artist:one': {status: 'contacted', contactedAt: eightDaysAgo},
}));
assert.equal(vm.runInContext("arArtistStatus('artist:one')", context), 'follow_up',
  'An artist contacted at least seven days ago must surface a follow-up state.');
assert.equal(vm.runInContext("arArtistStage(arArtistStatus('artist:one'))", context), 'contacted',
  'A follow-up stays inside the Contacté tab.');

storage.set('spotify_ar_outreach_artists_v1', JSON.stringify({
  'artist:one': {status: 'to_contact'},
  'artist:two': {status: 'to_contact'},
}));
storage.set('spotify_ar_outreach_list_v1', JSON.stringify({
  track_a: {status: 'to_contact'},
  track_b: {status: 'to_contact'},
  track_c: {status: 'to_contact'},
}));

function savedArtists() {
  return JSON.parse(storage.get('spotify_ar_outreach_artists_v1'));
}
function savedTracks() {
  return JSON.parse(storage.get('spotify_ar_outreach_list_v1'));
}
function assertArtistAndTracks(status) {
  assert.equal(savedArtists()['artist:one'].status, status, `Artist must move to ${status}.`);
  assert.equal(savedTracks().track_a.status, status, `First selected track must move to ${status}.`);
  assert.equal(savedTracks().track_b.status, status, `Second selected track must move to ${status}.`);
  assert.equal(savedTracks().track_c.status, 'to_contact', 'Another artist must remain untouched.');
}

vm.runInContext("arMarkArtistContacted('artist:one')", context);
assertArtistAndTracks('contacted');
assert.equal(savedArtists()['artist:one'].nextFollowUp, '2099-01-08',
  'Contact confirmation must schedule the seven-day follow-up.');
vm.runInContext("arStartArtistNegotiation('artist:one')", context);
assertArtistAndTracks('negotiating');
vm.runInContext("arValidateArtist('artist:one')", context);
assertArtistAndTracks('validated');
vm.runInContext("arRefuseArtist('artist:one')", context);
assertArtistAndTracks('refused');
vm.runInContext("arResetArtistStatus('artist:one')", context);
assertArtistAndTracks('to_contact');

const summarySource = sourceBetween('function arSelectionContactSummaryHtml(opportunity){', 'function arContactSourceLabel(');
assert.doesNotMatch(summarySource, /href=|mailto:|ar-contact-method/,
  'Selection cards must contain only a discreet contact-research summary.');
const cardSource = sourceBetween('function arSelectionArtistCardHtml(group){', 'function arSelectionEconomics(group){');
assert.match(cardSource, /arSelectionContactSummaryHtml\(contactOpportunity\)/,
  'Selection cards must show the compact research state.');
assert.doesNotMatch(cardSource, /arSelectionContactPanelHtml|mailto:|ar-contact-method/,
  'Contact coordinates must not pollute Selection cards.');

const composerSource = sourceBetween('function openArOutreach(spotifyId){', 'function arSelectionPrimaryArtist(opportunity){');
assert.match(composerSource, /arSelectionContactPanelHtml\(opportunity\)/,
  'Full public contact coordinates must live inside Préparer le message.');
assert.match(composerSource, /id="ar-mark-contacted">✓ Message envoyé/,
  'The composer must require an explicit Message envoyé confirmation.');

const mailHandler = composerSource.slice(
  composerSource.indexOf("const openMail="),
  composerSource.indexOf("const mark=")
);
assert.match(mailHandler, /window\.location\.href=`mailto:/,
  'The mail button must only hand the draft to the user mail client.');
assert.doesNotMatch(mailHandler, /arMarkArtistContacted|arSetArtistStatus/,
  'Opening a mailto link must never change the negotiation status automatically.');

const confirmationHandler = composerSource.slice(composerSource.indexOf("const mark="));
assert.match(confirmationHandler, /arMarkArtistContacted\(artistKey\)/,
  'Message envoyé confirmation must move the artist and every selected track to Contacté.');
assert.match(confirmationHandler, /S\.arListStage='contacted'/,
  'After confirmation the UI must switch to the Contacté tab.');

console.log('spotify selection contact state machine: OK');
