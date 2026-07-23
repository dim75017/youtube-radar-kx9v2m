'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

assert.match(dashboard, /radarSortDir:-1/);
assert.match(dashboard, /function arOpportunitySortDefaultDir\(sort\)/);
assert.match(dashboard, /S\.radarSort===next\?\(S\.radarSortDir===1\?-1:1\):arOpportunitySortDefaultDir\(next\)/);
assert.match(dashboard, /class=\"ar-sort-indicator\"/);
assert.match(dashboard, /<b>↑<\/b><b>↓<\/b>/);
assert.match(dashboard, /<section class=\"ar-filter-section\"/);
assert.match(css, /\.ar-filter-section\{/);
assert.match(css, /\.ar-columnbar button\.asc \.ar-sort-indicator/);
assert.match(index, /dashboard\.js\?v=20260723-opportunity-sort-bar-v1/);

console.log('spotify opportunity sorting bar: OK');
