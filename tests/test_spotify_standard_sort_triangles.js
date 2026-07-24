'use strict';

const assert = require('assert');
const fs = require('fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');

assert.match(dashboard, /function sortTriangleIndicator\(active,direction\)/, 'All sortable views must share one triangle renderer.');
assert.match(dashboard, /direction===-1\?'▲':'▼'/, 'Sort controls must show exactly one triangle matching the active direction.');
assert.doesNotMatch(dashboard, /<b>▲<\/b><b>▼<\/b>/, 'Inactive duplicate triangles must not be rendered.');
for (const helper of ['sortArrow', 'artistSortArrow', 'plSortArrow', 'labelSortArrow']) {
  assert.match(dashboard, new RegExp(`function ${helper}\\(k\\)\\{ return sortTriangleIndicator`), `${helper} must use the shared triangles.`);
}
for (const token of [
  "${streamMetricLabel(0)} ${sortArrow(3)}",
  "${streamMetricLabel(0)} ${artistSortArrow('streams')}",
  "${T('Followers total')} ${plSortArrow('followers')}",
  "${streamMetricLabel(0)} ${labelSortArrow('streams')}",
]) assert.ok(dashboard.includes(token), `Missing standard sort triangles: ${token}`);
assert.match(css, /\.sort-triangles\{display:inline-block/, 'Triangle controls need shared visual styling.');

console.log('Spotify standard sort triangles: OK');
