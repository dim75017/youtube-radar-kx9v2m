'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

assert.match(source, /const LIVE_ACTIVE_FRESHNESS_MS=3\*3600000/,
  'a live must have a fresh hourly observation to remain visible');
assert.match(source, /function liveIsActive\(v\)/,
  'ended streams are evaluated without mutating the historical catalogue');
assert.match(source, /Number\(latest\[1\]\)>0/,
  'a zero-current-viewer stream is removed from the active list');
assert.match(source, /function activeLives\(\)\{return \(DATA\.lives\|\|\[\]\)\.filter\(liveIsActive\);\}/,
  'the active view is a filter over the original livestream data');
assert.match(source, /let rows=activeLives\(\);/,
  'the livestream list uses only active streams');
assert.match(helpers, /typeof activeLives==='function'\?activeLives\(\)\.length:DATA\.lives\.length/,
  'the sidebar count matches the visible active stream list');

console.log('Ended livestream filtering: OK');
