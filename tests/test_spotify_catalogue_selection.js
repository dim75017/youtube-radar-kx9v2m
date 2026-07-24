'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const start = source.indexOf('let AR_OPPORTUNITY_CACHE=null;');
const end = source.indexOf('function arHasCompleteStructuredArtists', start);
assert.ok(start >= 0 && end > start, 'catalogue-selection helpers must remain available');

const context = {
  R: [[0, 'Quiet Waters', '2026-07-01', 123456, 0, 'Independent', 'track-123', '', 'cover.jpg']],
  A: [['Noctivelle', 0, '', false, false, '', 'artist-123']],
  arOpportunityRows: () => [],
};
vm.runInNewContext(`${source.slice(start, end)}; this.fromCatalogue=arCatalogueSelectionOpportunity; this.lookup=arSelectionOpportunityById;`, context);

const selected = context.fromCatalogue('track-123');
assert.equal(selected.title, 'Quiet Waters');
assert.equal(selected.selectionOnly, true);
assert.equal(selected.rights, 'self_released');
assert.equal(context.lookup('track-123').spotifyId, 'track-123');
assert.equal(context.lookup('missing'), null);

console.log('Spotify catalogue selection: OK');
