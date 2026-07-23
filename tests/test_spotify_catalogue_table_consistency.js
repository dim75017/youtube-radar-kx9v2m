'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const dashboard = fs.readFileSync('spotify/dashboard.js','utf8');
const css = fs.readFileSync('spotify/dashboard.css','utf8');

assert.match(dashboard,/function catalogueSortBarHtml\(/,'All catalogue views need the shared sort-bar component');
for(const scope of ['tracks','artists','playlists','labels']){
  assert.match(dashboard,new RegExp(`catalogueSortBarHtml\\('${scope}'`),`Missing ${scope} sort bar`);
  assert.match(dashboard,new RegExp(`data-catalogue-sort=\\"${scope}\\"`),`Missing ${scope} sort interaction`);
}
for(const token of ['.catalogue-sortbar','.catalogue-table-wrap','.catalogue-table tbody tr','.catalogue-status']){
  assert.ok(css.includes(token),`Missing compact catalogue style: ${token}`);
}
const tracks=dashboard.slice(dashboard.indexOf('function renderOpps(){'),dashboard.indexOf('function renderArtists(){'));
const artists=dashboard.slice(dashboard.indexOf('function renderArtists(){'),dashboard.indexOf('function renderNew(){'));
const playlists=dashboard.slice(dashboard.indexOf('function renderPlaylists(){'),dashboard.indexOf('function labelPerformance('));
assert.doesNotMatch(tracks,/Genre principal/,'Track table must not show the verbose genre/instrumental stack');
assert.doesNotMatch(artists,/Genre principal/,'Artist table must not show the verbose genre/instrumental stack');
for(const column of ['data-plsort="usage"','data-plsort="created"','data-plsort="recent"']) assert.ok(!playlists.includes(column),`Playlist column must be removed: ${column}`);
assert.match(dashboard,/comparisonReady\?`\$\{T\('vs période précédente'\)\}.*:'—'/,'Incomplete playlist comparisons must render a dash only');

console.log('spotify catalogue tables consistency: ok');
