'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf('const RECO_DAILY_LIMIT=50;');
const end = source.indexOf('function recoCardHTML(r,i){', start);
assert.ok(start >= 0 && end > start, 'daily recommendation helpers must remain available');

function makeContext(recos, stored, ownedRows) {
  let rerenders = 0;
  const context = {
    DATA: {recos},
    LANG: 'fr',
    Date,
    Intl,
    Set,
    Map,
    Object,
    Number,
    String,
    Math,
    JSON,
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, value); },
    },
    normalizedRecommendationTitle(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    },
    persoCategory: value => value || 'Sans personnage',
    isValidated: value => /^X/.test(value || ''),
    isRefused: value => /^-/.test(value || ''),
    recommendationRoadmapEntry: () => null,
    setActiveContinuousRecommendationVariants: () => {},
    rerenderRecos: () => { rerenders += 1; },
    anaRows: () => ownedRows,
  };
  vm.runInNewContext(`${source.slice(start, end)};
    this.dailyRecommendationSet = dailyRecommendationSet;
    this.recoProfile = recoProfile;
    this.refreshDailyRecommendations = refreshDailyRecommendations;
    this.recoPerformanceSignal = recoPerformanceSignal;
    this.recoHorizonWeight = recoHorizonWeight;`, context);
  context.rerenderRecos = () => { rerenders += 1; };
  context.rerenderCount = () => rerenders;
  return context;
}

// More than 100 pending candidates clear the quality floor, so this fixture
// still verifies the normal full 50-card review batch.
const recos = Array.from({length: 126}, (_, index) => ({
  n: index + 1,
  title: `Concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: index % 3 ? 'Girl' : 'Boy',
  concept: index % 2 ? 'rainy room focus' : 'quiet forest focus',
  score: 88 + (index % 5),
  valid: index === 124 ? 'X' : index === 125 ? '-' : '',
}));
const stored = new Map([
  ['lofi_radar_reco_rotation_v2', JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]})],
  ['lofi_radar_roadmap_archive_v3', '[]'],
]);
const ownedRows = [
  {ageM: 1, pctCh: 92, reco: recos[29], st: {ctr: 6.5, awp: 48}},
  {ageM: 7, pctCh: 85, genre: 'Ambient', perso: 'Girl', title: 'Forest focus', st: {ctr: 5.5, awp: 44}},
];
const context = makeContext(recos, stored, ownedRows);

const daily = context.dailyRecommendationSet();
assert.equal(daily.length, 50, '100+ qualified candidates still produce the normal 50-card batch');
assert.ok(daily.every(r => !/^X|^-/.test(r.valid || '')), 'validated and refused concepts are excluded');
assert.ok(daily.every(r => r.n > 10), 'recently shown concepts are not repeated while enough qualified candidates remain');
assert.ok(daily.every(r => Array.isArray(r._dailyReasons) && r._dailyReasons.length >= 2), 'every concept exposes selection reasons');
assert.ok(daily.some(r => r._dailyReasons.some(reason => /Signal cha|Recent channel signal/.test(reason))), 'recent channel performance contributes an explainable signal');
assert.equal(context.recoProfile().windows['12m'], 1,
  'an owned video without a linked recommendation contributes over the 12-month horizon');
assert.match(source, /ageMonths<=12/, 'the ranking keeps an explicit 12-month learning horizon');
assert.match(source, /RECO_DAILY_LIMIT=50/, '50 remains a maximum, not a filler target');
assert.match(source, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v2'/,
  'the quality-aware rotation uses the v2 storage namespace');
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

// A validation removes the card from the stable queue without manufacturing a
// replacement in the middle of the review session.
recos.find(r => r.n === daily[0].n).valid = 'X';
assert.equal(context.dailyRecommendationSet().length, 49,
  'a decision immediately reduces the active queue instead of refilling it');

const previousIds = new Set(daily.map(row => row.n));
context.refreshDailyRecommendations({stopPropagation() {}});
const refreshed = context.dailyRecommendationSet();
assert.equal(refreshed.length, 50, 'refresh can still load a full batch when 50 qualified unseen ideas exist');
assert.ok(refreshed.every(row => !previousIds.has(row.n)),
  'refresh avoids the current batch while enough qualified unseen concepts remain');
assert.equal(context.rerenderCount(), 1, 'refresh rerenders the recommendation workspace immediately');

// The quality floor is authoritative. When only a few ideas clear it, the
// engine deliberately returns fewer than 50 instead of adding weak filler.
const sparseRecos = Array.from({length: 68}, (_, index) => ({
  n: 1000 + index,
  title: `Sparse concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: index < 8 ? 90 : 10,
  valid: '',
}));
const sparseContext = makeContext(sparseRecos, new Map(), []);
const sparseDaily = sparseContext.dailyRecommendationSet();
assert.equal(sparseDaily.length, 8,
  'the score threshold is allowed to produce a batch smaller than 50');
assert.ok(sparseDaily.every(row => row.score === 90),
  'no below-threshold recommendation is used as filler');

console.log('YouTube daily recommendations: OK');
