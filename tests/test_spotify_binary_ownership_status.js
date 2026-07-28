'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const ownershipStart = dashboard.indexOf('const SELF_RELEASE_RIGHTS=');
const ownershipEnd = dashboard.indexOf('\nfunction mergeFullDiscoveryCatalogue()', ownershipStart);
const statusStart = dashboard.indexOf('function trackStatusHtml(track)');
const statusEnd = dashboard.indexOf('\nfunction discoveryStatusMatches', statusStart);
const artistsStart = dashboard.indexOf('function renderArtists(){');
const artistsEnd = dashboard.indexOf('\nfunction renderNew(){', artistsStart);

assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart, 'ownership helpers must remain available');
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'track status renderer must remain available');
assert.ok(artistsStart >= 0 && artistsEnd > artistsStart, 'artist renderer must remain available');

const context = {result: null};
vm.createContext(context);
vm.runInContext(`
  ${dashboard.slice(ownershipStart, ownershipEnd)}
  const esc = value => String(value);
  ${dashboard.slice(statusStart, statusEnd)}
  const indie = [0,'Track','',0,0,'Artist','track-indie'];
  indie.discoveryMeta = {rights:'self_released',label:'Artist',copyright:'© Artist'};
  const licensed = [0,'Track','',0,0,'Artist','track-label'];
  licensed.discoveryMeta = {rights:'self_released',label:'Artist',copyright:'℗ Artist, under exclusive licence to Real Label'};
  const labelled = [0,'Track','',0,1,'','track-labelled'];
  const stagingLicensed = [0,'Track','',0,0,'Artist','track-staging-label'];
  stagingLicensed.scRightsMeta = {rights_status:'self_released',label:'Artist',copyright:'exclusively licensed to Staging Label'};
  const licensedFrom = [0,'Track','',0,0,'John Lee','track-license-from'];
  licensedFrom.scRightsMeta = {rights_status:'self_released',label:'',copyright:'\u00a9 2022 Amen Worldwide (under exclusive license from John Lee)'};
  labelled.discoveryMeta = {rights:'independent_label',label:'Real Label',copyright:'℗ Real Label'};
  result = {
    indie: trackStatusHtml(indie),
    licensed: trackStatusHtml(licensed),
    labelled: trackStatusHtml(labelled),
    stagingLicensed: trackStatusHtml(stagingLicensed),
    licensedFrom: trackStatusHtml(licensedFrom),
    licensedFlag: (syncTrackOwnershipFlag(licensed), licensed[4])
  };
`, context);

assert.equal(context.result.indie, '<span class="badge self">Indie</span>');
assert.equal(context.result.licensed, '<span class="badge other">Label (Real Label)</span>');
assert.equal(context.result.labelled, '<span class="badge other">Label (Real Label)</span>');
assert.equal(context.result.stagingLicensed, '<span class="badge other">Label (Staging Label)</span>');
assert.equal(context.result.licensedFrom, '<span class="badge other">Label (Amen Worldwide)</span>');
assert.equal(context.result.licensedFlag, 1, 'exclusive licences must always override the self-release flag');

const statusSource = dashboard.slice(statusStart, statusEnd);
for (const forbidden of ['Mesurée', 'Playlist éditoriale', 'Catalogue artiste', 'Droits à vérifier', 'Label indépendant', 'Major']) {
  assert.doesNotMatch(statusSource, new RegExp(forbidden), `track badges must not expose ${forbidden}`);
}
assert.doesNotMatch(dashboard, /function discoveryAvailabilityInfo\(/, 'provenance badge helper must be removed');
assert.match(dashboard, /R\.forEach\(track=>syncTrackOwnershipFlag\(track\)\)/,
  'the whole in-memory catalogue must be normalised before artist aggregation');

const artists = dashboard.slice(artistsStart, artistsEnd);
assert.match(artists, /S\.aseg==='all' \|\| artistOwnershipKey\(g\)===S\.aseg/);
assert.match(artists, /<option value="indie"/);
assert.match(artists, /<option value="label"/);
assert.doesNotMatch(artists, /\$\{segBadge\(g\)\}<small>/,
  'the artist status cell must contain only the Indie or Label badge');
for (const obsolete of ['value="top"', 'value="reg"', 'value="occ"', 'value="ext"']) {
  assert.doesNotMatch(artists, new RegExp(obsolete), `obsolete artist status filter remains: ${obsolete}`);
}

console.log('spotify binary ownership statuses: OK');
