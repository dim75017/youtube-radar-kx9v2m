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
    this.activeDailyRecommendationCount = activeDailyRecommendationCount;
    this.recoProfile = recoProfile;
    this.recoPotentialForScore = recoPotentialForScore;
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
  ['lofi_radar_reco_rotation_v3', JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]})],
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
assert.match(source, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v3'/,
  'the evidence-calibrated rotation uses the v3 storage namespace');
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
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 500, ctr: 20, awp: 95}}), 0,
  'extreme Studio metrics from fewer than 1,000 impressions remain neutral');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 100000, ctr: null, awp: 220}}), 0,
  'an impossible long-form percentage watched cannot influence recommendation scoring');

// A decision keeps the reviewed card out, preserves the other 49 positions and
// pulls one qualified replacement so the active promise remains 50.
const decidedId = daily[0].n;
const retainedIds = new Set(daily.slice(1).map(row => row.n));
recos.find(r => r.n === decidedId).valid = 'X';
const replenished = context.dailyRecommendationSet();
assert.equal(replenished.length, 50,
  'a decision replenishes the active queue while qualified reserve remains');
assert.ok(!replenished.some(row => row.n === decidedId), 'a decided idea is never reintroduced');
assert.ok([...retainedIds].every(id => replenished.some(row => row.n === id)),
  'all still-pending cards retain their place during replenishment');
assert.equal(context.activeDailyRecommendationCount(), 50,
  'the navigation badge and the visible queue share the same replenished count');
assert.equal(context.recoPotentialForScore(94)[0], 'A', '94 remains an A');
assert.equal(context.recoPotentialForScore(95)[0], 'S', '95 is the evidence-backed S threshold');

// Personalisation orders the queue but cannot erase an objective S label.
// Ten refusals sharing the same source/topic deliberately pull this S below
// the adaptive S threshold, while its measured market tier remains visible.
const objectiveS = {
  n: 9000, title: 'Objective S concept', genre: 'Jazz', niche: 'Relaxation',
  perso: 'Girl', concept: 'late night jazz relaxation', score: 95,
  pot: 'S - Rente potentielle', _scoringVersion: 4,
  _sourceVideoId: 'objective-source', valid: '',
};
const negativePeers = Array.from({length: 10}, (_, index) => ({
  n: 9100 + index, title: `Refused peer ${index}`, genre: 'Jazz', niche: 'Relaxation',
  perso: 'Girl', concept: 'late night jazz relaxation', score: 90,
  _sourceVideoId: 'objective-source', valid: '-',
}));
const tierDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const tierStored = new Map([
  ['lofi_radar_reco_rotation_v3', JSON.stringify({[tierDayKey]: [objectiveS.n]})],
]);
const tierContext = makeContext([objectiveS, ...negativePeers], tierStored, []);
const tierBatch = tierContext.dailyRecommendationSet();
assert.equal(tierBatch.length, 1, 'the retained objective S stays in its active queue');
assert.ok(tierBatch[0]._dailyScore < 95, 'negative learned feedback still demotes its adaptive rank');
assert.ok(!String(tierBatch[0]._dailyPotential).startsWith('S'),
  'the internal adaptive tier records that demotion separately');
assert.ok(String(tierBatch[0].pot).startsWith('S'),
  'the visible market-potential tier remains the objective evidence-backed S');
assert.equal(tierBatch[0].scoreAdj, 95,
  'the visible score remains consistent with the objective S tier');

const previousIds = new Set(daily.map(row => row.n));
context.refreshDailyRecommendations({stopPropagation() {}});
const refreshed = context.dailyRecommendationSet();
assert.equal(refreshed.length, 50, 'refresh can still load a full batch when 50 qualified unseen ideas exist');
assert.ok(refreshed.every(row => !previousIds.has(row.n)),
  'refresh avoids the current batch while enough qualified unseen concepts remain');
assert.equal(context.rerenderCount(), 1, 'refresh rerenders the recommendation workspace immediately');

// Production regression: 29 decisions had reduced a stored 50-card queue to
// exactly 21 visible cards. Preserve those 21 and replace only the 29 decided
// positions from qualified, unseen reserve.
const todayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const regressionRecos = Array.from({length: 100}, (_, index) => ({
  n: 2000 + index,
  title: `Regression concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: 90,
  valid: index < 29 ? 'X' : '',
}));
const originalQueue = regressionRecos.slice(0, 50).map(row => row.n);
const decisionSentinel = JSON.stringify({'2029': {value: '-'}});
const regressionStored = new Map([[
  'lofi_radar_reco_rotation_v3', JSON.stringify({[todayKey]: originalQueue}),
], ['lofi_radar_generated_reco_decisions_v1', decisionSentinel]]);
const regressionContext = makeContext(regressionRecos, regressionStored, []);
const repairedQueue = regressionContext.dailyRecommendationSet();
const retainedPending = new Set(originalQueue.slice(29));
assert.equal(repairedQueue.length, 50, 'the 21-card production state is repaired back to 50');
assert.ok([...retainedPending].every(id => repairedQueue.some(row => row.n === id)),
  'all 21 still-pending cards survive the repair');
assert.ok(repairedQueue.every(row => !/^X|^-/.test(row.valid || '')),
  'none of the 29 decided cards can return during repair');
assert.equal(new Set(repairedQueue.map(row => row.n)).size, 50,
  'the repaired queue contains no duplicate idea');
const persistedRegression = JSON.parse(regressionStored.get('lofi_radar_reco_rotation_v3'));
assert.deepEqual(persistedRegression[todayKey], repairedQueue.map(row => row.n),
  'the replenished 50-card order is persisted for the rest of the day');
assert.ok(originalQueue.slice(0, 29).every(id => persistedRegression._recent.ids.includes(id)),
  'all 29 removed IDs remain in the same-day anti-repeat history');
assert.equal(regressionStored.get('lofi_radar_generated_reco_decisions_v1'), decisionSentinel,
  'replenishment never rewrites the generated-decision store');

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
