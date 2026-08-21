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
  [0, 'Strict track', '', 90_000, 0, '', 'strict-track'],
  [0, 'Discovery track', '', 80_000, 0, '', 'discovery-track'],
  [0, 'No performance history', '', 177_000, 0, '', 'catalogue-only-track'],
  [0, 'Still below floor', '', 99_999, 0, '', 'below-floor-track'],
];
const performanceTracks = {
  'strict-track': {
    history: [
      ['2026-07-25T10:00:00Z', 99_000],
      ['2026-07-27T09:00:00Z', 99_500],
      ['2026-07-27T18:00:00Z', 100_000],
    ],
  },
  'discovery-track': [
    ['2026-07-26', 110_000],
    ['2026-07-27', 120_000],
  ],
  'performance-only-track': {
    history: [['2026-07-27', 999]],
  },
};
const context = {
  R: rows,
  PERF_TRACKS: performanceTracks,
  MIN_TRACK_LIFETIME_STREAMS: 100_000,
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

assert.equal(rows[0][3], 100_000,
  'a strict catalogue track uses its latest observed cumulative counter');
assert.equal(rows[1][3], 120_000,
  'a discovery catalogue track uses its latest observed cumulative counter');
assert.equal(rows[2][3], 177_000,
  'a catalogue row without history keeps its existing lifetime value');
assert.equal(rows.length, 3,
  'performance-only entries are not promoted and sub-floor rows are removed');
assert.equal(rows.some(row => row[6] === 'performance-only-track'), false,
  'performance-only entries remain outside the catalogue');
assert.equal(rows.some(row => row[6] === 'below-floor-track'), false,
  'a current catalogue counter below 100,000 remains outside public views');
assert.match(index, /dashboard\.js\?v=20260821-web-playback-v2/,
  'the lifetime correction must be cache-busted in production');

console.log('Spotify lifetime counters follow real performance history: OK');

