'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf('const RECO_DAILY_LIMIT=25;');
const end = source.indexOf('function recoCardHTML(r,i){', start);
assert.ok(start >= 0 && end > start, 'daily recommendation helpers must remain available');

const recos = Array.from({length: 42}, (_, index) => ({
  n: index + 1,
  title: `Concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: index % 3 ? 'Girl' : 'Boy',
  concept: index % 2 ? 'rainy room focus' : 'quiet forest focus',
  score: 80 - index,
  valid: index === 40 ? 'X' : index === 41 ? '-' : ''
}));
const storage = {
  value: JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]}),
  getItem(){ return this.value; },
  setItem(_, value){ this.value = value; }
};
const context = {
  DATA: {recos},
  LANG: 'fr',
  Date,
  Intl,
  Set,
  Object,
  Number,
  String,
  Math,
  JSON,
  localStorage: storage,
  persoCategory: value => value || 'Unknown',
  isValidated: value => /^X/.test(value || ''),
  isRefused: value => /^-/.test(value || ''),
  anaRows: () => [{ageM: 1, pctCh: 92, reco: recos[29], st: {ctr: 6.5, awp: 48}}]
};
vm.runInNewContext(`${source.slice(start, end)}; this.dailyRecommendationSet = dailyRecommendationSet;`, context);

const daily = context.dailyRecommendationSet();
assert.equal(daily.length, 25, 'the active list is limited to 25 concepts');
assert.ok(daily.every(r => !/^X|^-/.test(r.valid || '')), 'validated and refused concepts are excluded');
assert.ok(daily.every(r => r.n > 10), 'concepts shown in the prior rotation are not repeated when enough candidates remain');
assert.ok(daily.every(r => Array.isArray(r._dailyReasons) && r._dailyReasons.length >= 2), 'every concept exposes selection reasons');
assert.ok(daily.some(r => r._dailyReasons.some(reason => /Signal chaîne récent/.test(reason))), 'recent channel performance contributes an explainable signal');
assert.match(source, /anaRows\(\).*ageM.*<=3/, 'the ranking uses videos from the last 90 days');
assert.match(source, /RECO_DAILY_LIMIT=25/, 'the 25-item cap remains explicit');

console.log('YouTube daily recommendations: OK');
