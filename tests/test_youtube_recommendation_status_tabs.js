'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const root = process.cwd();
const recos = fs.readFileSync(root + '/assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync(root + '/assets/css/dashboard.css', 'utf8');
const index = fs.readFileSync(root + '/index.html', 'utf8');

const decisionStart = recos.indexOf('function acceptedDecisionNote(');
const decisionEnd = recos.indexOf('function setValid(', decisionStart);
assert.ok(decisionStart >= 0 && decisionEnd > decisionStart,
  'recommendation decision parsing helpers must remain available');
const decisionContext = {String};
vm.runInNewContext(`${recos.slice(decisionStart, decisionEnd)}
  this.validStateForTest=validState;
  this.noteOfForTest=noteOf;`, decisionContext);

const acceptedFixtures = new Map([
  ['X', ''],
  ['x avec une autre miniature', 'avec une autre miniature'],
  ['x, raccourcir le titre', 'raccourcir le titre'],
  ['x mais revoir la description', 'mais revoir la description'],
  ['x: garder le concept', 'garder le concept'],
  ['x - changer la durée', 'changer la durée'],
  ['x · tester en automne', 'tester en automne'],
  ['x Â· forme historique', 'forme historique'],
  ['x commentaire libre', 'commentaire libre'],
]);
for (const [value, note] of acceptedFixtures) {
  assert.match(decisionContext.validStateForTest(value), /^x(?:note)?$/,
    `historical accepted value must remain accepted: ${value}`);
  assert.equal(decisionContext.noteOfForTest(value), note,
    `the accepted suffix must be exposed as its note: ${value}`);
}
for (const value of ['xylophone', 'Xmas playlist', 'excellent concept']) {
  assert.equal(decisionContext.validStateForTest(value), 'note',
    `a free note must not be mistaken for an acceptance: ${value}`);
}

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
assert.match(recos, /function recommendationRoadmapIndex\(\)/,
  'Roadmap membership is indexed once instead of rebuilt for every recommendation');
assert.match(recos, /function recommendationStatusSnapshot\(\)/,
  'the three status lists share one cached classification snapshot');
const tabSwitch = recos.slice(recos.indexOf('function setRecoTab('), recos.indexOf('function rerenderRecos('));
assert.match(tabSwitch, /rerenderRecos\(\{controls:false,nav:false\}\)/,
  'switching a status tab avoids rebuilding the navigation and controls twice');
const rerender = recos.slice(recos.indexOf('function rerenderRecos('), recos.indexOf('function legacyRecoCardHTML('));
assert.doesNotMatch(rerender, /i18nZone\(/,
  'a tab switch localizes markup before its single DOM insertion');

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
assert.match(css, /\.reco-tab\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/,
  'status labels remain geometrically centered even with a count badge');
assert.ok(index.includes('dashboard-04-recommendations.js?v=20260801-youtube-studio-auto-v1'),
  'Recommendation script cache version is stale');

console.log('youtube recommendation status tabs: ok');
