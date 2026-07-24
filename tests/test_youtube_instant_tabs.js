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
assert.match(helpers, /if\(currentRoute==='ana'\)return \{title:'Analysis',html:anaHTML\(\)\}/,
  'The Analysis view must keep its explicit page title');
assert.match(helpers, /if\(topbar\)topbar\.classList\.remove\('no-view-title'\)/,
  'The Analysis title bar must remain visible');
assert.match(css, /padding:26px 116px 16px 0/,
  'The desktop title bar must reserve room for the language controls');

console.log('YouTube instant navigation guardrails: OK');
