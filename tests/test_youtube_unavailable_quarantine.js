'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const start = source.indexOf('function unavailableVideoIds');
const end = source.indexOf('function setRadarData', start);
assert.ok(start >= 0 && end > start, 'unavailable-video filtering helpers must remain available');

const context = {
  Set,
  String,
  Array,
  window: { LOFI_DATA: { videoMetrics: { unavailable_ids: ['gone-video'] } } },
};
vm.runInNewContext(`${source.slice(start, end)};
  this.removeUnavailableVideoRows = removeUnavailableVideoRows;`, context);

const data = {
  all: [{vid: 'public-video'}, {vid: 'gone-video'}],
  trends: [{vid: 'gone-video'}],
  news: [{vid: 'public-video'}],
  ours: [{vid: 'public-video'}],
};
context.removeUnavailableVideoRows(data);
assert.deepEqual(Array.from(data.all, row => row.vid), ['public-video']);
assert.deepEqual(Array.from(data.trends, row => row.vid), []);
assert.deepEqual(Array.from(data.news, row => row.vid), ['public-video']);
assert.deepEqual(Array.from(data.ours, row => row.vid), ['public-video']);
const collector = fs.readFileSync('refresh_youtube_daily.py', 'utf8');
assert.match(collector, /tracked_unavailable_ids/,
  'the collector records authoritative public-API omissions');
assert.match(collector, /tracked_recovered_ids/,
  'quarantined IDs remain recovery probes instead of being forgotten');

console.log('YouTube unavailable-video quarantine: OK');

