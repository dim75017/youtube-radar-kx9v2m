'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const root = process.cwd();
const recos = fs.readFileSync(root + '/assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync(root + '/assets/css/dashboard.css', 'utf8');
const index = fs.readFileSync(root + '/index.html', 'utf8');

for (const required of [
  "let RECO_TAB='pending';",
  'function validatedRecommendationRows()',
  'function refusedRecommendationRows()',
  'function setRecoTab(tab)',
  "['pending','validated','refused']",
]) {
  assert.ok(recos.includes(required), 'Missing recommendation status-tab behavior: ' + required);
}

const tabs = recos.slice(recos.indexOf('function recoTabControlHTML()'), recos.indexOf('function recoRefusedCardHTML('));
assert.match(tabs, /const counts=\{pending:[^}]+validated:[^}]+refused:/,
  'the control bar counts pending, validated and refused recommendations independently');
assert.match(tabs, /\['pending',/, 'the pending tab remains available');
assert.match(tabs, /\['validated',/, 'the validated tab remains available');
assert.match(tabs, /\['refused',/, 'the refused tab replaces the mixed archive tab');
assert.doesNotMatch(tabs, /\['archive',/, 'the old mixed archive tab must not return');

for (const required of [
  '.reco-tabbar',
  '.reco-tab.pending',
  '.reco-tab.validated',
  '.reco-tab.refused',
  '.reco-refresh-btn',
]) {
  assert.ok(css.includes(required), 'Missing status-tab style: ' + required);
}
assert.doesNotMatch(css, /\.reco-tab\.archive(?:\.|\{|,)/,
  'the old archive-tab styling must not return');
assert.ok(index.includes('dashboard-04-recommendations.js?v=20260728-recommendations-workspace-v1'),
  'Recommendation script cache version is stale');

console.log('youtube recommendation status tabs: ok');
