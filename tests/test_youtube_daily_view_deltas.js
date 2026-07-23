'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const start = source.indexOf('function cleanVideoHist');
const end = source.indexOf('function histPointAtOrBefore', start);
assert.ok(start >= 0 && end > start, 'daily view helpers must remain available');

const context = { Date, Intl, Map, isFinite };
vm.runInNewContext(`${source.slice(start, end)}; this.dailyViewDeltas = dailyViewDeltas;`, context);

const at = (day, views) => [Date.UTC(2026, 6, day, 12), views];
const deltas = context.dailyViewDeltas([
  at(19, 100),
  at(20, 120),
  at(21, 155),
  at(22, 205),
  at(24, 300),
]);

assert.deepEqual(Array.from(deltas, point => Array.from(point)), [at(21, 35), at(22, 50)],
  'the chart starts from 20 July and never invents a value across a missing day');
assert.match(source, /dailyViewDeltas\(active\)/,
  'video drawers chart daily view gains instead of cumulative views');
assert.match(source, /dailyChart/, 'the drawer names the new daily metric');

console.log('YouTube daily view deltas: OK');
