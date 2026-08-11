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
    this.finalizeDailyRecommendationHistoryProfile = finalizeDailyRecommendationHistoryProfile;
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
  _conceptFamily: `concept-family-${index + 1}`,
  _titleFamily: index < 60 ? 'dominant-title-family' : `title-family-${index + 1}`,
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
assert.equal(new Set(daily.map(row => row._titleFamily)).size, 50,
  'the first pass admits only one recommendation per title family when enough families exist');
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

// A refusal removes exactly the reviewed card from the finite daily queue.
// Reserve candidates remain untouched until the explicit New ideas action.
const decidedId = daily[0].n;
const retainedIds = new Set(daily.slice(1).map(row => row.n));
recos.find(r => r.n === decidedId).valid = '-';
const afterRefusal = context.dailyRecommendationSet();
assert.equal(afterRefusal.length, 49,
  'a refusal immediately reduces a full daily queue from 50 to 49');
assert.ok(!afterRefusal.some(row => row.n === decidedId), 'a refused idea leaves the active queue');
assert.deepEqual(new Set(afterRefusal.map(row => row.n)), retainedIds,
  'no unseen reserve candidate replaces a refused card implicitly');
assert.equal(context.activeDailyRecommendationCount(), 49,
  'the navigation badge and the visible queue share the reduced count');
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

const legacyS = Object.assign({}, objectiveS, {n: 9001, _scoringVersion: undefined});
const legacyTierStored = new Map([
  ['lofi_radar_reco_rotation_v3', JSON.stringify({[tierDayKey]: [legacyS.n]})],
]);
const legacyTierContext = makeContext([legacyS, ...negativePeers], legacyTierStored, []);
const legacyTierBatch = legacyTierContext.dailyRecommendationSet();
assert.ok(legacyTierBatch[0]._dailyScore < 95, 'the same negative feedback demotes the legacy idea');
assert.ok(!String(legacyTierBatch[0].pot).startsWith('S'),
  'an uncalibrated legacy S label cannot return after V4 launches');
assert.equal(legacyTierBatch[0].scoreAdj, Math.round(legacyTierBatch[0]._dailyScore),
  'legacy visible score and tier stay aligned with adaptive evidence');

const previousIds = new Set(daily.map(row => row.n));
context.refreshDailyRecommendations({stopPropagation() {}});
const refreshed = context.dailyRecommendationSet();
assert.equal(refreshed.length, 50, 'refresh can still load a full batch when 50 qualified unseen ideas exist');
assert.ok(refreshed.every(row => !previousIds.has(row.n)),
  'refresh avoids the current batch while enough qualified unseen concepts remain');
assert.equal(context.rerenderCount(), 1, 'refresh rerenders the recommendation workspace immediately');

// A stored 50-card queue with 29 decisions remains a finite 21-card queue.
// It must not silently draw 29 new candidates from the reserve.
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
const remainingQueue = regressionContext.dailyRecommendationSet();
assert.equal(remainingQueue.length, 21, '29 decisions reduce the stored 50-card queue to 21');
assert.deepEqual(Array.from(remainingQueue, row => row.n), originalQueue.slice(29),
  'the 21 still-pending cards retain their exact order without replacements');
const persistedRegression = JSON.parse(regressionStored.get('lofi_radar_reco_rotation_v3'));
assert.deepEqual(persistedRegression[todayKey], originalQueue,
  'the original finite lot remains stored until an explicit refresh');
assert.equal(regressionStored.get('lofi_radar_generated_reco_decisions_v1'), decisionSentinel,
  'rendering the reduced queue never rewrites the generated-decision store');
const lazyHistory = {[todayKey]: originalQueue.slice()};
assert.equal(regressionContext.finalizeDailyRecommendationHistoryProfile(lazyHistory, todayKey), false,
  'late performance history does not rebuild a queue after review has started');
assert.deepEqual(lazyHistory[todayKey], originalQueue,
  'late performance history preserves every identity in the reviewed daily lot');

const untouchedRecos = Array.from({length: 50}, (_, index) => ({
  n: 6000 + index,
  title: `Untouched lazy concept ${index + 1}`,
  genre: 'Lofi',
  perso: 'Lofi Girl',
  score: 90,
  valid: '',
  _titleFamily: `untouched-title-${index}`,
}));
const untouchedQueue = untouchedRecos.map(row => row.n);
const untouchedStored = new Map([['lofi_radar_reco_rotation_v3', JSON.stringify({[todayKey]: untouchedQueue})]]);
const untouchedContext = makeContext(untouchedRecos, untouchedStored, []);
const untouchedHistory = JSON.parse(untouchedStored.get('lofi_radar_reco_rotation_v3'));
assert.equal(untouchedContext.finalizeDailyRecommendationHistoryProfile(untouchedHistory, todayKey), false,
  'late performance history never replaces an untouched existing lot');
assert.deepEqual(untouchedHistory[todayKey], untouchedQueue,
  'all untouched queue IDs remain stable after lazy performance history');
assert.equal(untouchedContext.dailyRecommendationSet().length, 50,
  'the untouched lot remains fully visible');

const missingIdQueue = [6999, ...untouchedQueue.slice(1)];
const missingStored = new Map([['lofi_radar_reco_rotation_v3', JSON.stringify({[todayKey]: missingIdQueue})]]);
const missingContext = makeContext(untouchedRecos.slice(1), missingStored, []);
const missingHistory = JSON.parse(missingStored.get('lofi_radar_reco_rotation_v3'));
assert.equal(missingContext.finalizeDailyRecommendationHistoryProfile(missingHistory, todayKey), false,
  'a stored ID absent from DATA prevents lazy history from recreating the lot');
assert.deepEqual(missingHistory[todayKey], missingIdQueue,
  'the missing resolved identity remains recorded in the finite lot');
assert.equal(missingContext.dailyRecommendationSet().length, 49,
  'one absent stored ID reduces the visible queue instead of triggering a replacement');

const refreshedQueue = untouchedQueue.slice().reverse();
const refreshRaceStored = new Map([['lofi_radar_reco_rotation_v3', JSON.stringify({
  [todayKey]: refreshedQueue,
  _consumed: Array.from({length: 50}, (_, index) => 5900 + index),
})]]);
const refreshRaceContext = makeContext(untouchedRecos, refreshRaceStored, []);
const refreshRaceHistory = JSON.parse(refreshRaceStored.get('lofi_radar_reco_rotation_v3'));
assert.equal(refreshRaceContext.finalizeDailyRecommendationHistoryProfile(refreshRaceHistory, todayKey), false,
  'lazy history cannot overwrite a lot just created by New ideas');
assert.deepEqual(refreshRaceHistory[todayKey], refreshedQueue,
  'the refreshed queue order survives the lazy-history race');
assert.deepEqual(Array.from(refreshRaceContext.dailyRecommendationSet(), row => row.n), refreshedQueue,
  'the refreshed queue remains the visible lot after lazy history completes');

// The quality floor is authoritative. When only a few ideas clear it, the
// engine deliberately returns fewer than 50 instead of adding weak filler.
const sparseRecos = Array.from({length: 68}, (_, index) => ({
  n: 1000 + index,
  title: `Sparse concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: index < 8 ? 90 : 10,
  valid: '',
  _titleFamily: 'single-small-pool-family',
}));
const sparseContext = makeContext(sparseRecos, new Map(), []);
const sparseDaily = sparseContext.dailyRecommendationSet();
assert.equal(sparseDaily.length, 8,
  'the score threshold is allowed to produce a batch smaller than 50');
assert.ok(sparseDaily.every(row => row.score === 90),
  'no below-threshold recommendation is used as filler');
assert.ok(sparseDaily.every(row => row._titleFamily === 'single-small-pool-family'),
  'the title-family cap relaxes progressively instead of shrinking a small qualified pool');

const emptyStored = new Map([['lofi_radar_reco_rotation_v3', JSON.stringify({[todayKey]: []})]]);
const emptyContext = makeContext(regressionRecos, emptyStored, []);
assert.equal(emptyContext.dailyRecommendationSet().length, 0,
  'an explicitly stored empty daily queue stays empty until New ideas is clicked');

const familyRecos = Array.from({length: 130}, (_, index) => ({
  n: 4000 + index,
  title: `Family guard concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: index < 2 ? 99 - index : 90,
  valid: '',
  _conceptFamily: index < 2 ? 'shared-concept-family' : `safe-concept-family-${index}`,
  _titleFamily: `family-guard-title-${index}`,
}));
const familyContext = makeContext(familyRecos, new Map(), []);
const familyInitial = familyContext.dailyRecommendationSet();
assert.ok(familyInitial.some(row => row.n === 4000) && familyInitial.some(row => row.n === 4001),
  'the fixture begins with two pending sisters from the same concept family');
familyRecos[0].valid = '-';
const familyAfterRefusal = familyContext.dailyRecommendationSet();
assert.ok(!familyAfterRefusal.some(row => row._conceptFamily === 'shared-concept-family'),
  'a refusal immediately removes pending sisters from the same concept family');
familyContext.refreshDailyRecommendations({stopPropagation() {}});
const familyAfterRefresh = familyContext.dailyRecommendationSet();
assert.ok(!familyAfterRefresh.some(row => row._conceptFamily === 'shared-concept-family'),
  'New ideas cannot serve a sister of a refused concept before the backend refresh');

console.log('YouTube daily recommendations: OK');
