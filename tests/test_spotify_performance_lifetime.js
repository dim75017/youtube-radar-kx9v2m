'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

const lifetimeStart = dashboard.indexOf('function latestPerformanceTrackCounter');
const lifetimeEnd = dashboard.indexOf('/* Soundcharts renvoie', lifetimeStart);
const normalizeStart = dashboard.indexOf('function normalizeCounterHistory');
const normalizeEnd = dashboard.indexOf('\nfunction shiftDay', normalizeStart);
assert.ok(lifetimeStart >= 0 && lifetimeEnd > lifetimeStart,
  'performance lifetime reconciliation must remain defined');
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart,
  'counter normalization must remain testable');

const rows = [
  [0, 'Strict track', '', 90, 0, '', 'strict-track'],
  [0, 'Discovery track', '', 8, 0, '', 'discovery-track'],
  [0, 'No performance history', '', 77, 0, '', 'catalogue-only-track'],
];
const performanceTracks = {
  'strict-track': {
    history: [
      ['2026-07-25T10:00:00Z', 100],
      ['2026-07-27T09:00:00Z', 140],
      ['2026-07-27T18:00:00Z', 150],
    ],
  },
  'discovery-track': [
    ['2026-07-26', 10],
    ['2026-07-27', 12],
  ],
  'performance-only-track': {
    history: [['2026-07-27', 999]],
  },
};
const context = {
  R: rows,
  PERF_TRACKS: performanceTracks,
  perfHistory(entry){
    if(Array.isArray(entry)) return entry;
    return entry && Array.isArray(entry.history) ? entry.history : [];
  },
};
vm.runInNewContext(
  `${dashboard.slice(normalizeStart, normalizeEnd)}
   ${dashboard.slice(lifetimeStart, lifetimeEnd)}`,
  context,
);

assert.equal(rows[0][3], 150,
  'a strict catalogue track uses its latest observed cumulative counter');
assert.equal(rows[1][3], 12,
  'a discovery catalogue track uses its latest observed cumulative counter');
assert.equal(rows[2][3], 77,
  'a catalogue row without history keeps its existing lifetime value');
assert.equal(rows.length, 3,
  'performance-only entries are not promoted into the rendered catalogue');
assert.equal(rows.some(row => row[6] === 'performance-only-track'), false,
  'performance-only entries remain outside the catalogue');
assert.match(index, /dashboard\.js\?v=20260728-chart-axes-v1/,
  'the lifetime correction must be cache-busted in production');

console.log('Spotify lifetime counters follow real performance history: OK');
