'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const start = source.indexOf('function cleanVideoHist');
const end = source.indexOf('function histPointAtOrBefore', start);
const mergeStart = source.indexOf('function mergeDailyVideoHistory');
const mergeEnd = source.indexOf('const VIDEO_HISTORY_CACHE_TTL_MS', mergeStart);
assert.ok(start >= 0 && end > start, 'daily view helpers must remain available');
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, 'daily history merge helper must remain available');

const context = { Date, Intl, Map, isFinite };
vm.runInNewContext(`${source.slice(start, end)}\n${source.slice(mergeStart, mergeEnd)};
  this.dailyViewDeltas = dailyViewDeltas;
  this.mergeDailyVideoHistory = mergeDailyVideoHistory;
  this.videoHistoryDayKey = videoHistoryDayKey;`, context);

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

const parisMidnightBefore = Date.parse('2026-07-29T10:33:00Z');
const parisMidnightAfter = Date.parse('2026-07-29T22:49:00Z');
assert.equal(context.videoHistoryDayKey(parisMidnightBefore), '2026-07-29');
assert.equal(context.videoHistoryDayKey(parisMidnightAfter), '2026-07-30');
assert.deepEqual(
  Array.from(context.mergeDailyVideoHistory([[parisMidnightBefore, 130]], [[parisMidnightAfter, 180]]), point => Array.from(point)),
  [[parisMidnightBefore, 130], [parisMidnightAfter, 180]],
  'two Paris days inside the same UTC day must both survive the merge',
);

const sameParisDayEarly = Date.parse('2026-07-30T05:00:00Z');
const sameParisDayLate = Date.parse('2026-07-30T17:00:00Z');
assert.deepEqual(
  Array.from(context.mergeDailyVideoHistory([[sameParisDayEarly, 190]], [[sameParisDayLate, 205]]), point => Array.from(point)),
  [[sameParisDayLate, 205]],
  'only the latest factual counter is retained inside one Paris day',
);

const livePoints = [
  [Date.parse('2026-07-28T20:13:00Z'), 100],
  [Date.parse('2026-07-29T10:33:00Z'), 130],
  [Date.parse('2026-07-29T22:49:00Z'), 180],
  [Date.parse('2026-07-31T14:21:00Z'), 220],
  [Date.parse('2026-07-31T23:23:00Z'), 260],
];
const liveMerged = context.mergeDailyVideoHistory(livePoints.slice(0, 2), livePoints.slice(2));
assert.deepEqual(
  Array.from(context.dailyViewDeltas(liveMerged), point => [context.videoHistoryDayKey(point[0]), point[1]]),
  [['2026-07-29', 30], ['2026-07-30', 50], ['2026-07-31', 40], ['2026-08-01', 40]],
  'the live July sequence must reach 1 August without losing Paris-midnight observations',
);

const zeroGain = context.dailyViewDeltas([
  [Date.parse('2026-07-30T12:00:00Z'), 500],
  [Date.parse('2026-07-31T12:00:00Z'), 500],
]);
assert.deepEqual(Array.from(zeroGain, point => Array.from(point)), [[Date.parse('2026-07-31T12:00:00Z'), 0]],
  'a measured zero gain is kept as a factual value');

const negativeCorrection = context.dailyViewDeltas([
  [Date.parse('2026-07-30T12:00:00Z'), 500],
  [Date.parse('2026-07-31T12:00:00Z'), 490],
]);
assert.deepEqual(Array.from(negativeCorrection), [],
  'a counter correction is not converted into an invented gain');

const beforeParisCutoff = Date.parse('2026-07-19T21:59:00Z');
const insideParisCutoff = Date.parse('2026-07-19T22:30:00Z');
const nextParisDay = Date.parse('2026-07-20T22:30:00Z');
assert.equal(context.videoHistoryDayKey(beforeParisCutoff), '2026-07-19');
assert.equal(context.videoHistoryDayKey(insideParisCutoff), '2026-07-20');
assert.deepEqual(
  Array.from(context.dailyViewDeltas([[beforeParisCutoff, 80], [insideParisCutoff, 100], [nextParisDay, 125]]), point => Array.from(point)),
  [[nextParisDay, 25]],
  'the 20 July cutoff starts at Paris midnight, not UTC midnight',
);

assert.match(source, /dailyViewDeltas\(active\)/,
  'video drawers chart daily view gains instead of cumulative views');
assert.match(source, /day=videoHistoryDayKey\(point\[0\]\)/,
  'daily history merging uses the canonical Paris day key');
assert.doesNotMatch(source.slice(mergeStart, mergeEnd), /Math\.floor\(point\[0\]\/86400000\)/,
  'UTC-day deduplication must never return');
assert.match(source, /dailyChart/, 'the drawer names the new daily metric');
assert.match(source, /const y0=0,y1=Math\.max\(Math\.max\.apply\(null,ys\),1\);/,
  'the daily curve keeps the intentional zero baseline');
assert.match(source, /best\[1\]\/o\.y1/,
  'the hover marker must use the same zero-based scale');

console.log('YouTube daily view deltas: OK');

