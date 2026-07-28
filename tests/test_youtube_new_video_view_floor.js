'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const start = source.indexOf('const MIN_NEW_VIDEO_TOTAL_VIEWS=100000;');
const end = source.indexOf('function setRadarData(d){', start);
assert.ok(start >= 0 && end > start, 'the new-video view floor must stay explicit');

const context = {Number};
vm.runInNewContext(
  `${source.slice(start, end)};this.eligibleNewVideoRows=eligibleNewVideoRows;`,
  context
);

const visible = context.eligibleNewVideoRows([
  {vid: 'below-floor', views: 99_999},
  {vid: 'at-floor', views: 100_000},
  {vid: 'above-floor', views: 350_000},
  {vid: 'missing-views'}
]);
assert.deepEqual(
  Array.from(visible, row => row.vid),
  ['at-floor', 'above-floor'],
  'snapshot and Google Sheet rows below 100k views must stay hidden'
);

const index = fs.readFileSync('index.html', 'utf8');
assert.ok(
  index.includes('dashboard-02-helpers.js?v=20260728-youtube-daily-health-v1'),
  'the browser cache key must change with the new eligibility rule'
);

const legacy = fs.readFileSync('Lofi_Radar.html', 'utf8');
assert.match(
  legacy,
  /const MIN_NEW_VIDEO_TOTAL_VIEWS=100000;[\s\S]*data\.news=data\.news\.filter\(row=>Number\(row&&row\.views\|\|0\)>=MIN_NEW_VIDEO_TOTAL_VIEWS\);/,
  'the directly accessible legacy page must filter its snapshot, Sheet and cache'
);

const snapshotSource = fs.readFileSync('Lofi_Radar_data.js', 'utf8');
const snapshot = JSON.parse(
  snapshotSource.replace(/^window\.LOFI_DATA=/, '').replace(/;\s*$/, '')
);
assert.ok(
  (snapshot.d.news || []).every(row => Number(row.views || 0) >= 100_000),
  'the published snapshot must not retain old discoveries below 100k views'
);

console.log('YouTube new-video 100k view floor: OK');
