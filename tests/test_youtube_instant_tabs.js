'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');

assert.match(helpers, /const VIEW_CACHE=new Map\(\)/,
  'YouTube tabs must retain rendered views for instant return navigation');
assert.match(helpers, /function scheduleViewWarmup\(\)/,
  'YouTube should prewarm common navigation views while idle');
assert.match(helpers, /render\(\{preferCache:true\}\)/,
  'Sidebar navigation must prefer the already-rendered view');
assert.match(helpers, /data-route=/,
  'sidebar buttons identify their route for a lightweight active-state update');
assert.match(helpers, /function updateActiveNavRoute\(\)/,
  'route switches update only the active sidebar state instead of rebuilding all counters');
const goHandler = helpers.slice(helpers.indexOf('function go('), helpers.indexOf('function viewMarkupForRoute('));
assert.doesNotMatch(goHandler, /renderNav\(\)/,
  'ordinary page navigation must not recompute every sidebar counter');
assert.match(helpers, /i18nView\(\{skipContent:true\}\)/,
  'Cached French views must avoid reprocessing the full page HTML');
assert.match(helpers, /if\(currentRoute==='ana'\)return \{title:'Analysis',html:anaHTML\(\)\}/,
  'The Analysis view must keep its explicit page title');
assert.match(helpers, /if\(topbar\)topbar\.classList\.remove\('no-view-title'\)/,
  'The Analysis title bar must remain visible');
assert.match(css, /padding:26px 116px 16px 0/,
  'The desktop title bar must reserve room for the language controls');

const cacheKeyStart = helpers.indexOf('function viewCacheKey(');
const cacheKeyEnd = helpers.indexOf('function viewMarkupWithLanguage(', cacheKeyStart);
assert.ok(cacheKeyStart >= 0 && cacheKeyEnd > cacheKeyStart,
  'the view-cache key helper must remain extractable');
let recommendationDay = '2026-08-24';
const cacheContext = {
  LANG: 'fr',
  recoDayKey: () => recommendationDay,
};
vm.runInNewContext(`${helpers.slice(cacheKeyStart, cacheKeyEnd)};
  this.viewCacheKeyForTest = viewCacheKey;`, cacheContext);
const firstRecommendationKey = cacheContext.viewCacheKeyForTest('recos');
const firstDashboardKey = cacheContext.viewCacheKeyForTest('dashboard');
recommendationDay = '2026-08-25';
assert.notEqual(cacheContext.viewCacheKeyForTest('recos'), firstRecommendationKey,
  'the recommendation view cache expires automatically on the next Paris day');
assert.equal(cacheContext.viewCacheKeyForTest('dashboard'), firstDashboardKey,
  'daily recommendation freshness does not invalidate unrelated cached views');

console.log('YouTube instant navigation guardrails: OK');
