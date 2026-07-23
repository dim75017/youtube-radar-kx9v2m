'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');

assert.match(helpers, /const VIEW_CACHE=new Map\(\)/,
  'YouTube tabs must retain rendered views for instant return navigation');
assert.match(helpers, /function scheduleViewWarmup\(\)/,
  'YouTube should prewarm common navigation views while idle');
assert.match(helpers, /render\(\{preferCache:true\}\)/,
  'Sidebar navigation must prefer the already-rendered view');
assert.match(helpers, /i18nView\(\{skipContent:true\}\)/,
  'Cached French views must avoid reprocessing the full page HTML');
assert.match(helpers, /if\(topbar\)topbar\.classList\.toggle\('no-view-title',route==='ana'\)/,
  'The redundant Analysis page title must be removed without disabling its tab');
assert.match(css, /\.topbar\.no-view-title\{display:none\}/,
  'The empty Analysis header must not reserve vertical space');

console.log('YouTube instant navigation guardrails: OK');
