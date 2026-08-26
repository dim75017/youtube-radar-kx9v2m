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
assert.match(index, /window\.__loadRadarLiveData=/,
  'the compact snapshot can be loaded lazily after a non-Livestreams boot');
assert.match(index, /dashboard-02-helpers\.js\?v=20260825-genre-bars-v1/,
  'the helper asset cache key changes with official live discovery');
assert.match(index, /dashboard-04-recommendations\.js\?v=20260826-hydration-v2/,
  'the live rendering asset cache key changes with official live discovery');
assert.match(helpers, /const liveBootstrap=await window\.__radarLiveDataReady/,
  'cold Livestreams waits for the compact asset, not the multi-megabyte radar assets');
assert.match(helpers, /renderNav\(\);render\(\);\s*continueColdLiveBoot\(liveBootstrap\)/,
  'the live cards render before the full snapshots and Sheet sync continue');
assert.match(helpers, /const d=await fetchData\(\)/,
  'the full Google Sheet remains the authoritative background refresh');
assert.match(helpers, /mergeLiveCatalogueRows\(d,live\.lives\|\|\[\]\)/,
  'official streams discovered after the Sheet scan stay in the full dashboard');
assert.match(helpers, /r==='live'.*window\.__loadRadarLiveData/s,
  'navigating to Livestreams after boot loads the official compact catalogue');

const dataContext = { window: {} };
vm.runInNewContext(liveAssetSource, dataContext);
const payload = dataContext.window.LOFI_LIVE_DATA;
assert.ok(payload && payload.d, 'the published compact snapshot is executable');
assert.ok(payload.d.lives.length > 0, 'the compact snapshot has a live catalogue');
assert.equal(Object.keys(payload.d.liveSummary).length, payload.metrics.summarized);
assert.ok(payload.metrics.active > 0, 'the compact snapshot has active first-paint rows');
for(const vid of ['0muHFBSiybw','LTiqKDrjqr4']){
  const row=payload.d.lives.find(item=>item.vid===vid),summary=payload.d.liveSummary[vid];
  assert.ok(row,vid+' is present in the published livestream catalogue');
  assert.equal(row.channelId,'UCSJ4gkVC6NrvII8umztf0Ow',vid+' has the official channel identity');
  assert.equal(row.liveStatus,'is_live',vid+' is verified live');
  assert.ok(summary&&summary.now>0&&summary.active===true,vid+' has a current factual viewer point');
}
assert.equal(payload.metrics.officialExpected,payload.metrics.officialVerified,
  'every discovered official livestream is verified before publication');
assert.ok(Buffer.byteLength(liveAssetSource) < 500_000,
  'the first-paint snapshot stays compact and excludes the full hourly history');

const start = recommendations.indexOf('const LIVE_SNAPSHOT_CACHE');
const end = recommendations.indexOf('function isOurs', start);
assert.ok(start >= 0 && end > start, 'livestream summary helpers remain extractable');
const context = { Map, Date, DATA: null };
vm.runInNewContext(`${recommendations.slice(start, end)};
  this.liveSnapshot=liveSnapshot;this.livePeaks=livePeaks;this.liveIsActive=liveIsActive;
  this.invalidateLiveSnapshotCache=invalidateLiveSnapshotCache;`, context);
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

const historyT=Date.now()-60*60*1000,officialT=Date.now()-5*60*1000;
context.DATA = {
  lives: [{ vid: 'abcdefghijk' }],
  liveHist: { abcdefghijk: [[historyT-1000,900],[historyT,400]] }, liveHourly: {},
  liveSummary: { abcdefghijk: {
    now: 75, latestT: officialT, peak24: 900, peakAll: 900, active: true,
  } },
};
assert.equal(context.liveSnapshot('abcdefghijk').now,75,
  'the newer official observation wins over an existing Sheet history tail');
assert.equal(context.liveSnapshot('abcdefghijk').latestT,officialT);
assert.equal(context.liveIsActive(context.DATA.lives[0]),true,
  'the official active-at-source proof survives the Sheet merge');
assert.equal(context.livePeaks('abcdefghijk').peakAll,900,
  'the official current observation does not discard the factual historical peak');

context.DATA = {
  lives: [{ vid: 'firstpoint1' }], liveHist: {}, liveHourly: {},
  liveSummary: { firstpoint1: {
    now: 12, latestT: officialT, peak24: null, peakAll: null, active: true,
  } },
};
assert.equal(context.livePeaks('firstpoint1').peakAll,null,
  'an explicit unavailable first-point peak is not coerced into a fabricated zero');

context.DATA = {
  lives: [{ vid: 'zeroviewer1' }], liveHist: {}, liveHourly: {},
  liveSummary: { zeroviewer1: {
    now: 0, latestT: officialT, peak24: null, peakAll: null, active: true,
  } },
};
assert.equal(context.liveIsActive(context.DATA.lives[0]),true,
  'an officially verified live with zero current viewers remains visible');

const mergeStart = helpers.indexOf('function mergeLiveCatalogueRows');
const mergeEnd = helpers.indexOf('function mergeExtensionSnapshot', mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, 'live catalogue union helper remains extractable');
const mergeContext = {};
vm.runInNewContext(`${helpers.slice(mergeStart, mergeEnd)};this.mergeLiveCatalogueRows=mergeLiveCatalogueRows;`, mergeContext);
const dashboard = {lives:[{vid:'existing00a',title:'Sheet row'}]};
mergeContext.mergeLiveCatalogueRows(dashboard,[
  {vid:'existing00a',title:'Compact title',audiences:['youtube'],liveStatus:'is_live'},
  {vid:'0muHFBSiybw',title:'summer lofi radio',audiences:['youtube'],liveStatus:'is_live'},
  {vid:'LTiqKDrjqr4',title:'deep sleep music',audiences:['youtube'],liveStatus:'is_live'},
]);
assert.equal(dashboard.lives.length,3,'two new official radios are unioned into the Sheet catalogue');
assert.equal(dashboard.lives.filter(row=>row.vid==='existing00a').length,1,'existing rows are not duplicated');

const extensionContext={window:{LOFI_DATA:null,LOFI_LIVE_DATA:{d:{
  lives:[{vid:'0muHFBSiybw',title:'summer lofi radio'}],
  liveSummary:{'0muHFBSiybw':{now:77,latestT:officialT,peak24:null,peakAll:null,active:true}},
}}}};
vm.runInNewContext(`${helpers.slice(mergeStart,helpers.indexOf('function mergeDailyVideoHistory',mergeStart))}
  this.mergeExtensionSnapshot=mergeExtensionSnapshot;`,extensionContext);
const sheetOnly={lives:[],liveHist:{},liveHourly:{}};
extensionContext.mergeExtensionSnapshot(sheetOnly);
assert.equal(sheetOnly.lives[0].vid,'0muHFBSiybw',
  'the compact official row survives Sheet sync even when the full static snapshot failed');
assert.equal(sheetOnly.liveSummary['0muHFBSiybw'].now,77);

const bootstrapMergeStart = helpers.indexOf('function mergeLiveBootstrapIntoData');
const bootstrapMergeEnd = helpers.indexOf('function coldLiveData', bootstrapMergeStart);
assert.ok(bootstrapMergeStart >= 0 && bootstrapMergeEnd > bootstrapMergeStart,
  'lazy live bootstrap merge remains extractable');
vm.runInNewContext(`${helpers.slice(mergeStart, mergeEnd)}
  ${helpers.slice(bootstrapMergeStart, bootstrapMergeEnd)}
  this.mergeLiveBootstrapIntoData=mergeLiveBootstrapIntoData;`, context);
const lazyT=Date.now()-2*60*60*1000,lazyOfficialT=Date.now()-2*60*1000;
const lazyDashboard={
  lives:[{vid:'lazycache01'}],liveHist:{lazycache01:[[lazyT,21]]},liveHourly:{},liveSummary:{}
};
context.DATA=lazyDashboard;
assert.equal(context.liveSnapshot('lazycache01').now,21,'the Sheet tail is cached before lazy loading');
context.mergeLiveBootstrapIntoData(lazyDashboard,{d:{
  lives:[{vid:'lazycache01',liveStatus:'is_live'}],
  liveSummary:{lazycache01:{now:88,latestT:lazyOfficialT,peak24:100,peakAll:150,active:true}},
}});
assert.equal(context.liveSnapshot('lazycache01').now,88,
  'lazy bootstrap merging invalidates the same-object livestream snapshot cache');

console.log('YouTube cold Livestreams bootstrap: OK');
