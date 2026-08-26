'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const videos = fs.readFileSync('assets/js/dashboard-03-keywords.js', 'utf8');
const analysis = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');

const formatStart = helpers.indexOf('function fmtN');
const formatEnd = helpers.indexOf('function fmtDur', formatStart);
const metricStart = helpers.indexOf('function cleanVideoHist');
const metricEnd = helpers.indexOf('function videoHistSlice', metricStart);
assert.ok(formatStart >= 0 && formatEnd > formatStart && metricStart >= 0 && metricEnd > metricStart,
  'fresh YouTube UI metric helpers must remain available');

const RealDate = Date;
const now = Date.parse('2026-08-13T12:00:00Z');
class FixedDate extends RealDate { static now() { return now; } }
const context = {Date: FixedDate, Intl, Map, isFinite, Number, LANG: 'en'};
vm.runInNewContext(`
  const VIDEO_HIST_WINDOWS={h24:86400000,d7:7*86400000,d30:30*86400000,all:null};
  ${helpers.slice(formatStart, formatEnd)}
  ${helpers.slice(metricStart, metricEnd)}
  this.fmtViewsExact=fmtViewsExact;
  this.videoAgeMonths=videoAgeMonths;
  this.videoLatestViews=videoLatestViews;
  this.videoThirtyDayMetric=videoThirtyDayMetric;
  this.videoCardPeriodLabel=videoCardPeriodLabel;
`, context);

const day = 86_400_000;
const fullHistory = Array.from({length: 31}, (_, index) => [now-(30-index)*day, 1_000+index*100]);
const exact = context.videoThirtyDayMetric({pub: now-100*day, views: 999}, fullHistory);
assert.equal(exact.kind, 'exact');
assert.equal(exact.value, 3_000, 'a complete 30-day counter history yields the factual gain');
assert.equal(context.videoLatestViews({views: 999}, fullHistory), 4_000,
  'the latest history counter supersedes the stale row counter');
assert.equal(context.videoCardPeriodLabel(exact), 'last 30 days',
  'a factual 30-day gain gets the short card label');

const partialHistory = fullHistory.slice(-10);
const fallback = context.videoThirtyDayMetric({pub: now-100*day, views: 999}, partialHistory);
assert.equal(fallback.kind, 'lifetime');
assert.match(fallback.label, /lifetime avg\/month/,
  'partial history is never presented as a factual 30-day gain');
assert.ok(Math.abs(fallback.value-(4_000/context.videoAgeMonths({pub: now-100*day}))) < 1e-9,
  'fallback uses the fresh total and dynamic publication age');
assert.equal(context.videoCardPeriodLabel(fallback), 'avg / month',
  'a lifetime fallback stays visibly distinct from factual 30-day performance');
assert.equal(context.fmtN(1_155_896), '1.2M');
assert.equal(context.fmtN(3_283_979), '3.3M');
assert.equal(context.fmtViewsExact(1_234_567), '1,234,567',
  'exact grouped digits remain available for detailed views');

const cardStart = videos.indexOf('function vcardHTML');
const drawerStart = videos.indexOf('function openDrawer');
const drawerEnd = videos.indexOf('function closeDrawer', drawerStart);
const videoCard = videos.slice(cardStart, drawerStart);
assert.match(videoCard, /fmtN\(m\.period\.value\)/,
  'video cards compact the 30-day or fallback value');
assert.match(videoCard, /fmtN\(m\.views\)/,
  'video cards compact total views');
assert.match(videoCard, /videoCardPeriodLabel\(m\.period\)/,
  'video cards use the short, honest period label');
assert.match(videoCard, /fmtDate\(v\.pub\)/,
  'video cards keep only month and year');
assert.doesNotMatch(videoCard, /fmtViewsExact|fmtDateFull|lifetime avg\/month · partial history/,
  'cards no longer expose verbose exact values or fallback copy');
assert.match(videos.slice(cardStart, drawerStart), /fmtAge\(m\.ageM\)/,
  'video cards render age recalculated from publication time');
assert.match(videos.slice(drawerStart, drawerEnd), /fmtViewsExact\(metrics\.views\)/,
  'video detail renders the same exact total');
assert.match(videos.slice(drawerStart, drawerEnd), /fmtDateFull\(v\.pub\)/,
  'video detail renders the complete publication date');

const preloadStart = analysis.indexOf('function ensureAnalysisHistory');
const preloadEnd = analysis.indexOf('const ANA_AGE_COHORTS', preloadStart);
assert.match(analysis.slice(preloadStart, preloadEnd), /preloadVideoHistoryForRows\(DATA\.ours,4\)/,
  'Analysis history shards are fetched through a bounded worker pool');
assert.doesNotMatch(analysis.slice(preloadStart, preloadEnd), /Promise\.all\(missing\.map\(ensureVideoHistory\)\)/,
  'Analysis must not launch one visible-history request per video at once');
assert.match(analysis, /o\.views30=videoThirtyDayMetric\(o,s\)/,
  'Analysis cards derive their 30-day metric from factual history');
const analysisCardStart = analysis.indexOf('function anaCardHTML');
const analysisCardEnd = analysis.indexOf('function fillAnaLikes', analysisCardStart);
const analysisCard = analysis.slice(analysisCardStart, analysisCardEnd);
assert.match(analysisCard, /videoCardPeriodLabel\(o\.views30\)/,
  'Analysis cards use the same short, honest period label');
assert.doesNotMatch(analysisCard, /fmtViewsExact|lifetime avg\/month · partial history/,
  'Analysis cards stay compact');
const analysisListStart = analysis.indexOf('function anaHTML');
const analysisListEnd = analysis.indexOf('function openAnaIdx', analysisListStart);
assert.match(analysis.slice(analysisListStart, analysisListEnd), /fmtN\(o\.views\)/,
  'Analysis list cards compact total views');
assert.match(analysis.slice(analysisListStart, analysisListEnd), /fmtN\(o\.views30\.value\)/,
  'Analysis list cards compact the period value');
const analysisDrawerEnd = analysis.indexOf('function closeAna', analysisListEnd);
assert.match(analysis.slice(analysisListEnd, analysisDrawerEnd), /fmtViewsExact\(o\.views\)/,
  'Analysis detail keeps exact total counters');

const dashboardStart = helpers.indexOf('function dashHTML');
const dashboardEnd = helpers.indexOf('function ', dashboardStart + 12);
const dashboardCards = helpers.slice(dashboardStart, dashboardEnd);
assert.match(dashboardCards, /fmtN\(m\.period\.value\)/,
  'Dashboard mini-cards compact their period value');
assert.match(dashboardCards, /videoCardPeriodLabel\(m\.period\)/,
  'Dashboard mini-cards use the short period label');
assert.match(dashboardCards, /fmtN\(m\.views\)/,
  'Dashboard discovery mini-cards compact total views');

const index = fs.readFileSync('index.html', 'utf8');
for (const [asset, version] of [
  ['dashboard-02-helpers.js', '20260825-genre-bars-v1'],
  ['dashboard-03-keywords.js', '20260813-card-compact-v1'],
  ['dashboard-04-recommendations.js', '20260826-hydration-v1'],
]) {
  assert.ok(index.includes(asset+'?v='+version), asset+' cache version is current');
}

const visibleStart = videos.indexOf('let VISIBLE_VIDEO_HISTORY_PROMISE');
const visibleEnd = videos.indexOf('function videosHTML', visibleStart);
assert.ok(visibleStart >= 0 && visibleEnd > visibleStart,
  'visible Videos history preloader must remain available');
let visibleReady = false;
let visiblePreloads = 0;
let visibleRenders = 0;
let cacheInvalidations = 0;
const visibleContext = {
  route: 'mix',
  window: {requestIdleCallback: callback => callback()},
  videoHistoryReady: () => visibleReady,
  videoHistoryError: () => '',
  preloadVideoHistoryForRows: async (rows, concurrency) => {
    visiblePreloads += 1;
    assert.equal(rows.length, 2, 'only the currently visible page is preloaded');
    assert.equal(concurrency, 4, 'visible history uses the bounded four-worker loader');
    visibleReady = true;
    return 1;
  },
  VIEW_CACHE: {delete: () => { cacheInvalidations += 1; }},
  viewCacheKey: value => value,
  rerenderList: () => { visibleRenders += 1; },
  setTimeout,
};
vm.runInNewContext(`${videos.slice(visibleStart, visibleEnd)};
  this.scheduleVisibleVideoHistory=scheduleVisibleVideoHistory;`, visibleContext);

(async () => {
  const page = [{vid: 'visible-one'}, {vid: 'visible-two'}];
  visibleContext.scheduleVisibleVideoHistory('mix', page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visiblePreloads, 1, 'opening Videos preloads history for the visible cards');
  assert.equal(cacheInvalidations, 1, 'the stale rendered Videos cache is invalidated after hydration');
  assert.equal(visibleRenders, 1, 'the visible list refreshes once after history arrives');

  visibleContext.scheduleVisibleVideoHistory('mix', page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visiblePreloads, 1, 'already hydrated cards do not start another request loop');
  assert.match(helpers, /scheduleVisibleVideoHistory\('mix',window\._page_mix\|\|\[\]\)/,
    'the visible preloader is scheduled after the rendered page is mounted, including cached navigation');
  console.log('YouTube card freshness UI: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
