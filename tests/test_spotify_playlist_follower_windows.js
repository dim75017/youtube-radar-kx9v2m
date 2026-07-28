'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const start = dashboard.indexOf('function normalizeCounterHistory(raw)');
const end = dashboard.indexOf('function aggregateWindowForRows(rows,days)', start);

assert.ok(start >= 0 && end > start, 'playlist counter-window helpers must remain available');

const context = {};
vm.createContext(context);
vm.runInContext(
  `${dashboard.slice(start, end)}\n` +
    'globalThis.normalizeCounterHistory = normalizeCounterHistory;\n' +
    'globalThis.counterWindow = counterWindow;',
  context,
);

const {normalizeCounterHistory, counterWindow} = context;

const playlistHistorySource = dashboard.slice(
  dashboard.indexOf('function plHistory(r)'),
  dashboard.indexOf('function playlistWindow(r,days)'),
);
assert.doesNotMatch(
  playlistHistorySource,
  /PLmeta|snapshot_ts/,
  'a global snapshot timestamp must not manufacture an observation for an unrefreshed playlist',
);

// Missing counters are unknown, never numeric zero. Number(null) and Number('')
// both equal zero in JavaScript, so this protects against an easy false delta.
assert.deepEqual(
  Array.from(normalizeCounterHistory([
    ['2026-07-27', 740],
    ['2026-07-28', null],
    ['2026-07-29', ''],
    ['2026-07-30', undefined],
    ['2026-07-31', 800],
  ]), point => Array.from(point)),
  [['2026-07-27', 740], ['2026-07-31', 800]],
  'null, empty and undefined follower counters must not be coerced to zero',
);

const baselineOnly = counterWindow([['2026-07-31', 800]], 1);
assert.equal(baselineOnly.current, null, 'T0 alone must not manufacture a zero 24h delta');
assert.equal(baselineOnly.currentReady, false);

const missingExactBaseline = counterWindow([
  ['2026-07-29', 760],
  ['2026-07-31', 800],
], 1);
assert.equal(missingExactBaseline.current, null, 'a missing D-1 point must not be interpolated');
assert.equal(missingExactBaseline.currentReady, false);

const completeHistory = [
  ['2026-06-01', 100],
  ['2026-07-01', 400],
  ['2026-07-17', 600],
  ['2026-07-24', 700],
  ['2026-07-29', 760],
  ['2026-07-30', 780],
  ['2026-07-31', 800],
];

const day = counterWindow(completeHistory, 1);
assert.equal(day.current, 20);
assert.equal(day.previous, 20);
assert.equal(day.currentReady, true);
assert.equal(day.comparisonReady, true);

const week = counterWindow(completeHistory, 7);
assert.equal(week.current, 100);
assert.equal(week.previous, 100);
assert.equal(week.currentReady, true);
assert.equal(week.comparisonReady, true);

const month = counterWindow(completeHistory, 30);
assert.equal(month.current, 400);
assert.equal(month.previous, 300);
assert.equal(month.currentReady, true);
assert.equal(month.comparisonReady, true);

console.log('spotify playlist follower windows: OK');
