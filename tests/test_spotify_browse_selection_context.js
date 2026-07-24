'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

for (const required of [
  'function arSelectionOpportunityIdsForArtist(artist)',
  'function arOpenArtistContextMenu(artistIndex,clientX,clientY)',
  'function arOpenSelectionContextMenu(spotifyIds,clientX,clientY,options={})',
  'function arCatalogueSelectionOpportunity(spotifyId)',
  'function arSelectionOpportunityById(spotifyId)',
  'arStructuredArtistIds(opportunity).has(spotifyId)',
  'arSelectionEligible(opportunity.spotifyId)',
  'data-ar-browse-track=',
  'data-ar-browse-artist=',
  'arOpenContextMenu(node.dataset.arBrowseTrack,event.clientX,event.clientY)',
  'arOpenArtistContextMenu(node.dataset.arBrowseArtist,event.clientX,event.clientY)',
]) {
  assert.ok(dashboard.includes(required), `Missing browse-to-selection action: ${required}`);
}

assert.match(dashboard, /else if\(S\.view==='radar'\)renderRadar\(\);\s*else render\(\);/, 'Adding from browse views must stay on the current view');
assert.match(dashboard, /return Boolean\(arSelectionOpportunityById\(spotifyId\)\);/, 'Any visible catalogue track can be retained in Selection');
assert.match(dashboard, /Object\.keys\(saved\)\.map\(id=>\(\{opportunity:arSelectionOpportunityById\(id\)/, 'Catalogue tracks persist visibly in Selection');
assert.match(index, /data-v="radar" data-fr="Opportunités"/, 'The opportunities label must be simplified');
assert.match(index, /data-v="ar-list" data-fr="Sélection"/, 'The selection label must be simplified');
assert.doesNotMatch(index, /data-v="radar" data-fr="Opportunités A&R"/, 'The legacy opportunities label must be removed');
assert.doesNotMatch(index, /data-v="ar-list" data-fr="Sélection A&R"/, 'The legacy selection label must be removed');

console.log('Spotify browse context selection: OK');
