const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'assets/js/dashboard-02-helpers.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/dashboard.css'), 'utf8');

assert.match(html, /assets\/css\/dashboard\.css\?v=20260825-genre-bars-v1/);
assert.match(html, /assets\/js\/dashboard-02-helpers\.js\?v=20260825-genre-bars-v1/);
assert.match(js, /Object\.entries\(gcount\)\.sort\(\(a,b\)=>b\[1\]-a\[1\]\)/);
assert.match(js, /const genreBars=gsorted\.map/);
assert.match(js, /--genre-height:'\+Math\.max\(2,n\/gmax\*100\)\+'%/);
assert.match(js, /<section class="panel genre-panel" aria-labelledby="genre-distribution-title" aria-describedby="genre-distribution-description">/);
assert.match(js, /<ol class="genre-chart"/);
assert.match(js, /<li class="genre-bar"/);
assert.match(js, /class="genre-column" aria-hidden="true"/);
assert.match(js, /class="genre-chart-scroll"/);
assert.match(js, /class="genre-chart"/);
assert.doesNotMatch(js, /class="genre-track"/);
assert.doesNotMatch(js, /class="genre-row"/);

assert.match(css, /\.genre-chart-scroll\{[^}]*overflow-x:auto/);
assert.match(css, /\.genre-chart-scroll\{[^}]*overscroll-behavior-inline:contain/);
assert.match(css, /\.genre-chart\{[^}]*display:grid[^}]*grid-template-columns:repeat\(var\(--genre-columns\)/);
assert.match(css, /\.genre-column\{[^}]*align-items:flex-end/);
assert.match(css, /\.genre-column i\{[^}]*height:var\(--genre-height\)/);
assert.match(css, /\.genre-column i\{[^}]*width:min\(42px,70%\)/);
assert.doesNotMatch(css, /\.genre-track\{height:2px/);
assert.match(css, /@media\(forced-colors:active\)\{/);

console.log('YouTube genre distribution uses responsive vertical bars.');
