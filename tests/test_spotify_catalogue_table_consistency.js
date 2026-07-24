'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const dashboard = fs.readFileSync('spotify/dashboard.js','utf8');
const css = fs.readFileSync('spotify/dashboard.css','utf8');

for(const scope of ['tracks','artists','playlists','labels']){
  const attribute={tracks:'data-k',artists:'data-asort',playlists:'data-plsort',labels:'data-lbsort'}[scope];
  assert.match(dashboard,new RegExp(`${attribute}=`),`Missing sortable ${scope} column headers`);
}
for(const token of ['.catalogue-sortbar','.catalogue-table-wrap','.catalogue-table tbody tr','.catalogue-status']){
  assert.ok(css.includes(token),`Missing compact catalogue style: ${token}`);
}
assert.match(css,/\.catalogue-table tbody tr\{height:68px/,'Catalogue rows must match the compact Opportunity row height');
assert.match(css,/\.catalogue-table \.cov\{width:48px;height:48px/,'Catalogue covers must match the Opportunity cover size');
assert.match(dashboard,/const label=count===0\?'🎵 Genre : tous'/,'Track and artist genre filters must expose a clear emoji');
assert.doesNotMatch(dashboard,/Taxonomie \$\{esc\(GENRE_TAXONOMY\.version\)\}/,'The taxonomy footer must stay hidden from the genre dropdown');
assert.doesNotMatch(dashboard,/Autre \/ à définir/,'Unknown genres must use À classifier rather than an ambiguous catch-all');
assert.match(dashboard,/`Label\$\{labelSuffix\}`/,'Label release types must include the actual label when available');
const tracks=dashboard.slice(dashboard.indexOf('function renderOpps(){'),dashboard.indexOf('function renderArtists(){'));
const artists=dashboard.slice(dashboard.indexOf('function renderArtists(){'),dashboard.indexOf('function renderNew(){'));
const playlists=dashboard.slice(dashboard.indexOf('function renderPlaylists(){'),dashboard.indexOf('function labelPerformance('));
const labels=dashboard.slice(dashboard.indexOf('function renderLabels(){'),dashboard.indexOf('function spotifyUpdateRows(){'));
assert.doesNotMatch(tracks,/Genre principal/,'Track table must not show the verbose genre/instrumental stack');
assert.doesNotMatch(artists,/Genre principal/,'Artist table must not show the verbose genre/instrumental stack');
for(const [name,section] of [['tracks',tracks],['artists',artists],['playlists',playlists],['labels',labels]]){
  assert.doesNotMatch(section,/class="viewtoggle"/,`${name} must stay in the list view without a grid/list switch`);
  assert.doesNotMatch(section,/data-(?:o|a|pl|lb)mode=/,`${name} must not expose an alternate grid mode`);
}
for(const column of ['data-plsort="usage"','data-plsort="created"','data-plsort="recent"']) assert.ok(!playlists.includes(column),`Playlist column must be removed: ${column}`);
assert.match(dashboard,/const pct=w\.comparisonReady\?signedPct\(w\.pct\):'';/,'Playlist comparisons must use the compact percentage only');

console.log('spotify catalogue tables consistency: ok');
