'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const index = fs.readFileSync('index.html', 'utf8');
const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const recommendations = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const liveAssetSource = fs.readFileSync('Lofi_Radar_live_data.js', 'utf8');

assert.match(index, /\(location\.hash\|\|''\)\.slice\(1\)==='live'/,
  'the compact asset is requested only on a direct Livestreams load');
assert.match(index, /Lofi_Radar_live_data\.js\?payload=/,
  'the compact live snapshot bypasses stale browser caches');
assert.match(helpers, /const liveBootstrap=await window\.__radarLiveDataReady/,
  'cold Livestreams waits for the compact asset, not the multi-megabyte radar assets');
assert.match(helpers, /renderNav\(\);render\(\);\s*continueColdLiveBoot\(liveBootstrap\)/,
  'the live cards render before the full snapshots and Sheet sync continue');
assert.match(helpers, /const d=await fetchData\(\)/,
  'the full Google Sheet remains the authoritative background refresh');

const dataContext = { window: {} };
vm.runInNewContext(liveAssetSource, dataContext);
const payload = dataContext.window.LOFI_LIVE_DATA;
assert.ok(payload && payload.d, 'the published compact snapshot is executable');
assert.ok(payload.d.lives.length > 0, 'the compact snapshot has a live catalogue');
assert.equal(Object.keys(payload.d.liveSummary).length, payload.metrics.summarized);
assert.ok(payload.metrics.active > 0, 'the compact snapshot has active first-paint rows');
assert.ok(Buffer.byteLength(liveAssetSource) < 500_000,
  'the first-paint snapshot stays compact and excludes the full hourly history');

const start = recommendations.indexOf('const LIVE_SNAPSHOT_CACHE');
const end = recommendations.indexOf('function isOurs', start);
assert.ok(start >= 0 && end > start, 'livestream summary helpers remain extractable');
const context = { Map, Date, DATA: null };
vm.runInNewContext(`${recommendations.slice(start, end)};
  this.liveSnapshot=liveSnapshot;this.liveIsActive=liveIsActive;`, context);
context.DATA = {
  lives: [{ vid: 'abcdefghijk' }], liveHist: {}, liveHourly: {},
  liveSummary: { abcdefghijk: {
    now: 42, latestT: Date.now() - 6 * 3600000, peak24: 60, peakAll: 100, active: true,
  } },
};
assert.equal(context.liveIsActive(context.DATA.lives[0]), true,
  'a recent compact timestamp renders when it was active at snapshot time');
assert.equal(context.liveSnapshot('abcdefghijk').peak24, 60);
context.DATA = {
  lives: [{ vid: 'abcdefghijk' }], liveHist: {}, liveHourly: {},
  liveSummary: { abcdefghijk: {
    now: 42, latestT: Date.now() - 36 * 3600000, peak24: 60, peakAll: 100, active: true,
  } },
};
assert.equal(context.liveIsActive(context.DATA.lives[0]), false,
  'a very old compact timestamp expires instead of remaining active indefinitely');

console.log('YouTube cold Livestreams bootstrap: OK');
