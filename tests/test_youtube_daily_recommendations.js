'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf('const RECO_DAILY_LIMIT=50;');
const end = source.indexOf('function recoCardHTML(r,i){', start);
assert.ok(start >= 0 && end > start, 'daily recommendation helpers must remain available');

const recos = Array.from({length: 126}, (_, index) => ({
  n: index + 1,
  title: `Concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: index % 3 ? 'Girl' : 'Boy',
  concept: index % 2 ? 'rainy room focus' : 'quiet forest focus',
  score: 80 - index,
  valid: index === 124 ? 'X' : index === 125 ? '-' : ''
}));
const stored = new Map([
  ['lofi_radar_reco_rotation_v1', JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]})],
  ['lofi_radar_roadmap_archive_v3', '[]'],
]);
const storage = {
  getItem(key){ return stored.get(key) || null; },
  setItem(key, value){ stored.set(key, value); }
};
let rerenders = 0;
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
  rerenderRecos: () => { rerenders += 1; },
  anaRows: () => [
    {ageM: 1, pctCh: 92, reco: recos[29], st: {ctr: 6.5, awp: 48}},
    {ageM: 7, pctCh: 85, genre: 'Ambient', perso: 'Girl', title: 'Forest focus', st: {ctr: 5.5, awp: 44}}
  ]
};
vm.runInNewContext(`${source.slice(start, end)};
  this.dailyRecommendationSet = dailyRecommendationSet;
  this.recoProfile = recoProfile;
  this.refreshDailyRecommendations = refreshDailyRecommendations;
  this.recoPerformanceSignal = recoPerformanceSignal;
  this.recoHorizonWeight = recoHorizonWeight;`, context);
context.rerenderRecos = () => { rerenders += 1; };

const daily = context.dailyRecommendationSet();
assert.equal(daily.length, 50, 'the active list is limited to 50 concepts');
assert.ok(daily.every(r => !/^X|^-/.test(r.valid || '')), 'validated and refused concepts are excluded');
assert.ok(daily.every(r => r.n > 10), 'concepts shown in the prior rotation are not repeated when enough candidates remain');
assert.ok(daily.every(r => Array.isArray(r._dailyReasons) && r._dailyReasons.length >= 2), 'every concept exposes selection reasons');
assert.ok(daily.some(r => r._dailyReasons.some(reason => /Signal chaîne récent/.test(reason))), 'recent channel performance contributes an explainable signal');
assert.equal(context.recoProfile().windows['12m'], 1,
  'an owned video without a linked recommendation contributes over the 12-month horizon');
assert.match(source, /ageMonths<=12/, 'the ranking keeps an explicit 12-month learning horizon');
assert.match(source, /RECO_DAILY_LIMIT=50/, 'the 50-item cap remains explicit');
assert.equal(context.recoHorizonWeight(1).weight, 1.25,
  'videos published in the last 3 months receive the strongest learning weight');
assert.ok(context.recoHorizonWeight(4).weight < context.recoHorizonWeight(1).weight,
  'the 3-6 month horizon contributes less than the latest 3 months');
assert.ok(context.recoHorizonWeight(8).weight < context.recoHorizonWeight(4).weight,
  'the 6-12 month horizon remains useful but secondary');
assert.equal(context.recoHorizonWeight(null), null,
  'a missing publication age never enters the recent-performance window');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: null}), 0,
  'missing performance data is neutral instead of being treated as a failure');
assert.ok(context.recoPerformanceSignal({pctNow: 90, pctCh: 10, st: null}) > 0,
  'recent measured velocity takes priority over lifetime velocity when available');

// A validation is removed from the same fixed daily queue. It must not be
// replaced mid-day and the displayed/navigation count therefore drops live.
recos.find(r => r.n === daily[0].n).valid = 'X';
assert.equal(context.dailyRecommendationSet().length, 49,
  'a decision immediately reduces the active queue instead of refilling it');

const previousIds = new Set(daily.map(row => row.n));
context.refreshDailyRecommendations({stopPropagation() {}});
const refreshed = context.dailyRecommendationSet();
assert.equal(refreshed.length, 50, 'refresh loads one complete next review batch');
assert.ok(refreshed.every(row => !previousIds.has(row.n)),
  'refresh avoids the current batch while enough unseen concepts remain');
assert.equal(rerenders, 1, 'refresh rerenders the recommendation workspace immediately');

console.log('YouTube daily recommendations: OK');
