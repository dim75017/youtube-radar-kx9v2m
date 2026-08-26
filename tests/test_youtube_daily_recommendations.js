'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf('const RECO_DAILY_LIMIT=50;');
const end = source.indexOf('function recoCardHTML(r,i){', start);
assert.ok(start >= 0 && end > start, 'daily recommendation helpers must remain available');

const DEFAULT_V4_POOL = {
  schema: 3, version: 4, buildId: 'test-v4', ledgerRevision: 'test-ledger', modelRevision: 'test-model',
  sourceT: 0, feedbackT: 0,
};

function makeContext(recos, stored, ownedRows, pool, dateCtor = Date, sharedHydration = {ready: true}) {
  let rerenders = 0;
  const usesDefaultV4Pool = pool === undefined;
  if (usesDefaultV4Pool) {
    recos.forEach(row => {
      if (!row.valid && row._generatorVersion == null) row._generatorVersion = 4;
    });
    pool = Object.assign({}, DEFAULT_V4_POOL);
  }
  const context = {
    DATA: {recos},
    LANG: 'fr',
    route: 'recos',
    Date: dateCtor,
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
    sharedRecommendationStateHydrated: () => sharedHydration.ready,
    sharedRecommendationStateNetworkReady: () => sharedHydration.networkReady == null ? sharedHydration.ready : sharedHydration.networkReady,
    sharedRecommendationStateRevision: () => sharedHydration.revision || 0,
    sharedRecommendationReviewedIdsSince: ids => (sharedHydration.reviewedIds || []).filter(id => ids.includes(id)),
    setActiveContinuousRecommendationVariants: () => {},
    rerenderRecos: () => { rerenders += 1; },
    anaRows: () => ownedRows,
    window: pool ? {LOFI_RECOMMENDATION_POOL: pool} : {},
  };
  vm.runInNewContext(`${source.slice(start, end)};
    this.dailyRecommendationSet = dailyRecommendationSet;
    this.activeDailyRecommendationCount = activeDailyRecommendationCount;
    this.recoProfile = recoProfile;
    this.recoDailyScore = recoDailyScore;
    this.recoPotentialForScore = recoPotentialForScore;
    this.refreshDailyRecommendations = refreshDailyRecommendations;
    this.finalizeDailyRecommendationHistoryProfile = finalizeDailyRecommendationHistoryProfile;
    this.recoPerformanceSignal = recoPerformanceSignal;
    this.recoHorizonWeight = recoHorizonWeight;
    this.recoSourceRecencyBoost = recoSourceRecencyBoost;
    this.recoVideoFields = recoVideoFields;
    this.recoDayKey = recoDayKey;
    this.recoSeenIds = recoSeenIds;
    this.recoPreviousTopicKeys = recoPreviousTopicKeys;
    this.recoDailyHistoryDays = RECO_DAILY_HISTORY_DAYS;
    this.invalidateRecommendationDerivedData = invalidateRecommendationDerivedData;
    this.handleRecommendationDayRollover = handleRecommendationDayRollover;`, context);
  context.recoGenreKey = context.recoGenreKey || vm.runInNewContext('recoGenreKey', context);
  context.recoPurposeKey = context.recoPurposeKey || vm.runInNewContext('recoPurposeKey', context);
  context.recoNormalizedTopicKey = context.recoNormalizedTopicKey || vm.runInNewContext('recoNormalizedTopicKey', context);
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
  ['lofi_radar_reco_rotation_v4', JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]})],
  ['lofi_radar_roadmap_archive_v3', '[]'],
]);
const ownedRows = [
  {ageM: 1, pctCh: 92, title: 'Published recent lofi focus', genre: 'Lofi', reco: recos[29], st: {ctr: 6.5, awp: 48}},
  {ageM: 7, pctCh: 85, genre: 'Ambient', perso: 'Girl', title: 'Forest focus', st: {ctr: 5.5, awp: 44}},
];
const context = makeContext(recos, stored, ownedRows);

const daily = context.dailyRecommendationSet();
assert.equal(daily.length, 50, '100+ qualified candidates still produce the normal 50-card batch');
assert.ok(daily.every(r => !/^X|^-/.test(r.valid || '')), 'validated and refused concepts are excluded');
assert.ok(daily.every(r => r.n > 10), 'recently shown concepts are not repeated while enough qualified candidates remain');
assert.ok(daily.filter(row => row._titleFamily === 'dominant-title-family').length > 1,
  'a broad genre/style title family does not impose an artificial one-card quota');
assert.ok(daily.every(r => Array.isArray(r._dailyReasons) && r._dailyReasons.length >= 2), 'every concept exposes selection reasons');
assert.ok(daily.some(r => r._dailyReasons.some(reason => /Signal cha|Recent channel signal/.test(reason))), 'recent channel performance contributes an explainable signal');
assert.equal(context.recoProfile().windows['12m'], 1,
  'an owned video without a linked recommendation contributes over the 12-month horizon');
assert.match(source, /ageMonths<=60/, 'the ranking keeps explicit long-tail history buckets');
assert.match(source, /return \{id:'evergreen',weight:/,
  'the ranking has no hard cutoff after the first five years');
assert.match(source, /RECO_DAILY_LIMIT=50/, '50 remains a maximum, not a filler target');
assert.match(source, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v4'/,
  'the full-history learning model resets the rotation in the v4 storage namespace');
assert.equal(context.recoHorizonWeight(1).weight, 1.25,
  'videos published in the last 3 months receive the strongest learning weight');
assert.ok(context.recoHorizonWeight(4).weight < context.recoHorizonWeight(1).weight,
  'the 3-6 month horizon contributes less than the latest 3 months');
assert.ok(context.recoHorizonWeight(8).weight < context.recoHorizonWeight(4).weight,
  'the 6-12 month horizon remains useful but secondary');
assert.ok(context.recoHorizonWeight(18).weight < context.recoHorizonWeight(8).weight,
  'the 12-24 month horizon remains useful with a smaller weight');
assert.ok(context.recoHorizonWeight(36).weight < context.recoHorizonWeight(18).weight,
  'the 24-60 month horizon remains useful with a smaller weight');
assert.ok(context.recoHorizonWeight(72).weight < context.recoHorizonWeight(36).weight,
  'evergreen results remain available with the smallest positive weight');
assert.equal(context.recoHorizonWeight(72).id, 'evergreen',
  'videos older than five years enter the evergreen history bucket');

// An already-open tab must notice the Paris calendar-day boundary and rerender
// without waiting for a navigation or a full page reload.
let rolloverNow = Date.parse('2026-08-25T10:00:00Z');
class RolloverDate extends Date {
  constructor(...args) { super(...(args.length ? args : [rolloverNow])); }
  static now() { return rolloverNow; }
}
const rolloverContext = makeContext([], new Map(), [], undefined, RolloverDate);
assert.equal(rolloverContext.handleRecommendationDayRollover(), false,
  'the first rollover check records the active Paris day without rebuilding the lot');
rolloverNow = Date.parse('2026-08-26T10:00:00Z');
assert.equal(rolloverContext.handleRecommendationDayRollover(), true,
  'returning after the Paris day boundary invalidates and rerenders recommendations');
assert.equal(rolloverContext.rerenderCount(), 1,
  'an open recommendation view receives exactly one rollover rerender');
assert.equal(context.recoHorizonWeight(null), null,
  'a missing publication age never enters performance learning');

// A large, quality-qualified reservoir must produce a complete, stable lot
// for one Paris day, then replace every card on each following day. Reviewed
// or merely surfaced ideas are historical material: they must not return a few
// days later under either the same ID or a cosmetically different title.
let rotationNow = Date.parse('2026-08-24T10:00:00Z');
class RotationDate extends Date {
  constructor(...args) { super(...(args.length ? args : [rotationNow])); }
  static now() { return rotationNow; }
}
const rotationRows = Array.from({length: 400}, (_, index) => ({
  n: 70000 + index,
  title: `Specific daily hook ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  concept: `Measured direction ${index + 1}`,
  score: 90,
  valid: '',
  _generatorVersion: 4,
  _topicKey: `specific topic ${index + 1}`,
  _conceptFamily: `daily|focus|specific topic ${index + 1}`,
  _titleFamily: `daily-title-${index + 1}`,
  _sourceVideoId: `daily-source-${index + 1}`,
}));
const rotationStore = new Map();
const rotationContext = makeContext(rotationRows, rotationStore, [], undefined, RotationDate);
const dailyRows = () => Array.from(rotationContext.dailyRecommendationSet());
const dailyIds = () => dailyRows().map(row => Number(row.n));
const overlap = (left, right) => {
  const rightIds = new Set(right);
  return left.filter(id => rightIds.has(id));
};

const rotationDayOneKey = rotationContext.recoDayKey();
const rotationDayOneRows = dailyRows();
const rotationDayOne = rotationDayOneRows.map(row => Number(row.n));
assert.equal(rotationDayOne.length, 50,
  'a sufficient qualified reservoir produces exactly 50 cards');
assert.deepEqual(dailyIds(), rotationDayOne,
  'the exact 50-card lot remains stable throughout the same Paris day');

rotationNow = Date.parse('2026-08-25T10:00:00Z');
const rotationDayTwoKey = rotationContext.recoDayKey();
const rotationDayTwoRows = dailyRows();
const rotationDayTwo = rotationDayTwoRows.map(row => Number(row.n));
assert.equal(rotationDayTwo.length, 50,
  'the next Paris day still produces a complete 50-card lot');
assert.equal(overlap(rotationDayOne, rotationDayTwo).length, 0,
  'every card changes between consecutive Paris days when the reservoir is sufficient');
const firstTopics = new Set(rotationDayOneRows.map(row => rotationContext.recoNormalizedTopicKey(row)));
assert.ok(rotationDayTwoRows.every(row => !firstTopics.has(rotationContext.recoNormalizedTopicKey(row))),
  'a different stable ID cannot disguise yesterday\'s semantic topic as a new card');
assert.deepEqual(dailyIds(), rotationDayTwo,
  'the replacement lot also remains stable until the next Paris day');
const persistedRotation = JSON.parse(rotationStore.get('lofi_radar_reco_rotation_v4'));
assert.equal(persistedRotation._topics[rotationDayOneKey].length, 50,
  'the first daily lot persists semantic fingerprints for cross-day exclusion');
assert.equal(persistedRotation._topics[rotationDayTwoKey].length, 50,
  'the replacement lot persists its own semantic fingerprints');
assert.ok(rotationContext.recoDailyHistoryDays >= 56,
  'daily recommendation memory retains at least eight full weeks');
const retainedSeenIds = rotationContext.recoSeenIds(persistedRotation, '2026-08-26');
assert.ok(rotationDayOne.every(id => retainedSeenIds.has(id)) && rotationDayTwo.every(id => retainedSeenIds.has(id)),
  'ID exclusion covers every retained historical daily lot, not only yesterday');
const retainedSeenTopics = rotationContext.recoPreviousTopicKeys(persistedRotation, '2026-08-26', rotationRows);
assert.ok([...firstTopics].every(topic => retainedSeenTopics.has(topic)),
  'semantic exclusion covers topics from older retained daily lots');

rotationNow = Date.parse('2026-08-26T10:00:00Z');
const rotationDayThreeRows = dailyRows();
const rotationDayThree = rotationDayThreeRows.map(row => Number(row.n));
assert.equal(rotationDayThree.length, 50,
  'rotation does not exhaust the reservoir after two complete daily lots');
assert.equal(overlap(rotationDayTwo, rotationDayThree).length, 0,
  'zero adjacent-day overlap remains true after the first rollover');
assert.equal(overlap(rotationDayOne, rotationDayThree).length, 0,
  'an older surfaced card cannot return after one intervening day');
const firstTwoTopics = new Set([...rotationDayOneRows, ...rotationDayTwoRows]
  .map(row => rotationContext.recoNormalizedTopicKey(row)));
assert.ok(rotationDayThreeRows.every(row => !firstTwoTopics.has(rotationContext.recoNormalizedTopicKey(row))),
  'an older semantic topic cannot return under a different recommendation ID');

const weekIds = new Set([...rotationDayOne, ...rotationDayTwo, ...rotationDayThree]);
const weekTopics = new Set([...rotationDayOneRows, ...rotationDayTwoRows, ...rotationDayThreeRows]
  .map(row => rotationContext.recoNormalizedTopicKey(row)));
for (const day of [27, 28, 29, 30]) {
  rotationNow = Date.parse(`2026-08-${day}T10:00:00Z`);
  const rows = dailyRows();
  assert.equal(rows.length, 50,
    `the perpetual reservoir keeps a complete lot on 2026-08-${day}`);
  for (const row of rows) {
    assert.ok(!weekIds.has(Number(row.n)),
      `a recommendation ID cannot repeat during the same review week: ${row.n}`);
    const topic = rotationContext.recoNormalizedTopicKey(row);
    assert.ok(!weekTopics.has(topic),
      `a semantic topic cannot repeat during the same review week: ${topic}`);
    weekIds.add(Number(row.n));
    weekTopics.add(topic);
  }
}
assert.equal(weekIds.size, 350,
  'seven Paris days expose 350 different recommendation identities');

// A queue persisted by the former J-1-only client is repaired in place. The
// current day cannot keep an older card merely because it was already stored
// before durable history exclusion shipped.
let durableMigrationNow = Date.parse('2026-08-26T10:00:00Z');
class DurableMigrationDate extends Date {
  constructor(...args) { super(...(args.length ? args : [durableMigrationNow])); }
  static now() { return durableMigrationNow; }
}
const oldPersistedIds = rotationRows.slice(0, 50).map(row => row.n);
const durableMigrationStore = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  '2026-08-24': oldPersistedIds,
  '2026-08-25': rotationRows.slice(50, 100).map(row => row.n),
  '2026-08-26': oldPersistedIds,
})]]);
const durableMigrationContext = makeContext(
  rotationRows.map(row => Object.assign({}, row)),
  durableMigrationStore,
  [],
  undefined,
  DurableMigrationDate,
);
const migratedDurableLot = Array.from(durableMigrationContext.dailyRecommendationSet());
assert.equal(migratedDurableLot.length, 50,
  'a legacy repeated current lot is rebuilt to the complete daily target');
assert.ok(migratedDurableLot.every(row => !oldPersistedIds.includes(Number(row.n))),
  'the rebuilt lot excludes IDs surfaced more than one day ago');

rotationNow = Date.parse('2026-08-24T10:00:00Z');
const freshDayOneContext = makeContext(rotationRows.map(row => Object.assign({}, row)), new Map(), []);
freshDayOneContext.Date = RotationDate;
const freshDayOne = Array.from(freshDayOneContext.dailyRecommendationSet(), row => Number(row.n));
rotationNow = Date.parse('2026-08-25T10:00:00Z');
const freshDayTwoContext = makeContext(rotationRows.map(row => Object.assign({}, row)), new Map(), []);
freshDayTwoContext.Date = RotationDate;
const freshDayTwo = Array.from(freshDayTwoContext.dailyRecommendationSet(), row => Number(row.n));
assert.equal(overlap(freshDayOne, freshDayTwo).length, 0,
  'the deterministic topic windows also change every card when browser history is unavailable');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 1}) > context.recoSourceRecencyBoost({_sourceAgeM: 4}),
  'the 0-3 month source window receives the strongest ranking prior');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 4}) > context.recoSourceRecencyBoost({_sourceAgeM: 8}),
  'the 3-6 month source window outranks the 6-12 month window');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 8}) > context.recoSourceRecencyBoost({_sourceAgeM: 18}),
  'the 6-12 month source window outranks the 12-24 month window');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 18}) > context.recoSourceRecencyBoost({_sourceAgeM: 36}),
  'the 12-24 month source window retains a small advantage over older history');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: null}), 0,
  'missing performance data is neutral instead of being treated as a failure');
assert.ok(context.recoPerformanceSignal({pctNow: 90, pctCh: 10, st: null}) > 0,
  'recent measured velocity takes priority over lifetime velocity when available');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 500, ctr: 20, awp: 95}}), 0,
  'extreme Studio metrics from fewer than 1,000 impressions remain neutral');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 100000, ctr: null, awp: 220}}), 0,
  'an impossible long-form percentage watched cannot influence recommendation scoring');

const migrationRows = [
  {n: 8001, title: 'Old neutral location template', valid: '', score: 99, genre: 'Lofi'},
  {n: 8002, title: 'Old accepted example', valid: 'X', score: 99, genre: 'Lofi'},
  {
    n: -4000000000001, title: 'summer lofi ☀️ chill beats to relax to', valid: '', score: 90,
    genre: 'Lofi', _generated: true, _generatorVersion: 4, _conceptFamily: 'lofi|season|summer',
    _titleFamily: 'lofi|direct', _sourceVideoId: 'market-v4', _scoringVersion: 5,
  },
];
const migrationContext = makeContext(migrationRows, new Map(), [], {
  schema: 3, version: 4, buildId: 'v4-build', ledgerRevision: 'v4-ledger', modelRevision: 'v4-model',
});
assert.deepEqual(Array.from(migrationContext.dailyRecommendationSet(), row => row.n), [-4000000000001],
  'once V4 is present, old neutral proposals stay as audit history but never re-enter the active review batch');
assert.equal(migrationContext.recoProfile().feedbackGenre.lofi, 6,
  'accepted legacy titles remain positive learning evidence during the V4 migration');

const absentPoolStorage = new Map();
const absentPoolContext = makeContext(migrationRows.slice(0, 2), absentPoolStorage, [], null);
assert.deepEqual(Array.from(absentPoolContext.dailyRecommendationSet()), [],
  'a missing or failed pool fetch fails closed instead of reviving an old neutral proposal');
assert.equal(absentPoolStorage.has('lofi_radar_reco_rotation_v4'), false,
  'a failed pool fetch does not persist a fake empty editorial queue');
assert.equal(absentPoolContext.recoProfile().feedbackGenre.lofi, 6,
  'accepted history remains learning evidence when the active pool is unavailable');

const staleV3Rows = [
  {n: -3000000000001, title: 'Stale V3 neutral', valid: '', score: 99, genre: 'Ambient', _generated: true, _generatorVersion: 3},
  {n: -3000000000002, title: 'Stale V3 accepted', valid: 'X', score: 99, genre: 'Jazz', _generated: true, _generatorVersion: 3},
  {n: -3000000000003, title: 'Stale V3 refused', valid: '-', score: 99, genre: 'Piano', _generated: true, _generatorVersion: 3},
];
const staleV3Storage = new Map();
const staleV3Context = makeContext(staleV3Rows, staleV3Storage, [], {
  schema: 3, version: 3, buildId: 'v3-build', ledgerRevision: 'v3-ledger', modelRevision: '',
});
assert.deepEqual(Array.from(staleV3Context.dailyRecommendationSet()), [],
  'a stale V3 pool fails closed instead of exposing its neutral candidates');
assert.equal(staleV3Storage.has('lofi_radar_reco_rotation_v4'), false,
  'a stale V3 pool cannot persist an empty V4 review lot');
assert.equal(staleV3Context.recoProfile().feedbackGenre.jazz, 6,
  'V3 accepted decisions remain positive learning history');
assert.equal(staleV3Context.recoProfile().feedbackGenre.piano, -8,
  'V3 refused decisions remain negative learning history');

const recoveryRows = [{
  n: -3050, title: 'Recovered V4 idea', genre: 'Lofi', score: 90, valid: '',
  _generated: true, _generatorVersion: 4, _sourceVideoId: 'recovery-source',
}];

const staleProjectionRow = {
  n: -3048, title: 'Yesterday generic projection', genre: 'Lofi', score: 99, valid: '',
  _generated: true, _generatorVersion: 4, _sourceVideoId: 'stale-projection-source',
};
const currentProjectionRow = {
  n: -3049, title: 'Current measured projection', genre: 'Ambient', score: 90, valid: '',
  _generated: true, _generatorVersion: 4, _sourceVideoId: 'current-projection-source',
};
const projectionContext = makeContext(
  [staleProjectionRow, currentProjectionRow], new Map(), [],
  Object.assign({}, DEFAULT_V4_POOL, {items: [currentProjectionRow]}),
);
assert.deepEqual(Array.from(projectionContext.dailyRecommendationSet(), row => row.n), [-3049],
  'a background pool refresh cannot revive a neutral row absent from the current server projection');

const recoveryStorage = new Map();
const recoveryContext = makeContext(recoveryRows, recoveryStorage, [], {
  schema: 3, version: 3, buildId: 'failed-v3', ledgerRevision: 'failed-ledger', modelRevision: '',
});
assert.deepEqual(Array.from(recoveryContext.dailyRecommendationSet()), [],
  'the initial stale-pool paint fails closed');
assert.equal(recoveryStorage.has('lofi_radar_reco_rotation_v4'), false,
  'the initial stale-pool paint leaves no empty queue behind');
recoveryContext.window.LOFI_RECOMMENDATION_POOL = {
  schema: 3, version: 4, buildId: 'recovered-v4', ledgerRevision: 'recovered-ledger', modelRevision: 'recovered-model',
};
assert.deepEqual(Array.from(recoveryContext.dailyRecommendationSet(), row => row.n), [-3050],
  'a later V4 identity invalidates the fail-closed cache and becomes reviewable immediately');

const recoveryDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const staleEmptyDecisionSentinel = JSON.stringify({'-3051': {value: 'X'}});
const staleEmptyEditSentinel = JSON.stringify({'-3052': {title: 'Edited title'}});
const staleEmptyRoadmapSentinel = JSON.stringify([{key: 'roadmap-sentinel'}]);
const staleEmptyStorage = new Map([
  ['lofi_radar_reco_rotation_v4', JSON.stringify({
    [recoveryDayKey]: [],
    _pool: {schema: 3, version: 4, buildId: 'old-v4', ledgerRevision: 'old-ledger', modelRevision: 'old-model', sourceT: 1, feedbackT: 1},
    _consumed: [987654],
  })],
  ['lofi_radar_generated_reco_decisions_v1', staleEmptyDecisionSentinel],
  ['lofi_radar_recommendation_edits_v1', staleEmptyEditSentinel],
  ['lofi_radar_roadmap_archive_v3', staleEmptyRoadmapSentinel],
]);
const staleEmptyContext = makeContext(recoveryRows.map(row => Object.assign({}, row)), staleEmptyStorage, [], {
  schema: 3, version: 4, buildId: 'new-v4', ledgerRevision: 'new-ledger', modelRevision: 'new-model', sourceT: 2, feedbackT: 2,
});
assert.deepEqual(Array.from(staleEmptyContext.dailyRecommendationSet(), row => row.n), [-3050],
  'a changed V4 identity repairs an empty queue persisted by an older client');
assert.deepEqual(JSON.parse(staleEmptyStorage.get('lofi_radar_reco_rotation_v4'))._consumed, [987654],
  'repairing a stale empty queue preserves the durable consumed ledger');
assert.equal(staleEmptyStorage.get('lofi_radar_generated_reco_decisions_v1'), staleEmptyDecisionSentinel,
  'repairing rotation never touches explicit recommendation decisions');
assert.equal(staleEmptyStorage.get('lofi_radar_recommendation_edits_v1'), staleEmptyEditSentinel,
  'repairing rotation never touches edited recommendation copy');
assert.equal(staleEmptyStorage.get('lofi_radar_roadmap_archive_v3'), staleEmptyRoadmapSentinel,
  'repairing rotation never touches Roadmap state');

const comboFeedbackRows = [
  ...Array.from({length: 5}, (_, index) => ({
    n: 20000 + index, title: `Refused ambient sleep ${index}`, genre: 'Ambient', _genreKey: 'ambient', _purposeKey: 'sleep', valid: '-',
  })),
  ...Array.from({length: 10}, (_, index) => ({
    n: 20100 + index, title: `Accepted sleep elsewhere ${index}`, genre: index % 2 ? 'Jazz' : 'Piano',
    _genreKey: index % 2 ? 'jazz' : 'piano', _purposeKey: 'sleep', valid: 'X',
  })),
];
const rejectedAmbientSleep = {n: -4201, title: 'Ambient Sleep', genre: 'Ambient', _genreKey: 'ambient', _purposeKey: 'sleep', score: 90, valid: ''};
const safeClassicalSleep = {n: -4202, title: 'Classical Sleep', genre: 'Classical', _genreKey: 'classical', _purposeKey: 'sleep', score: 90, valid: ''};
const comboContext = makeContext([...comboFeedbackRows, rejectedAmbientSleep, safeClassicalSleep], new Map(), []);
const comboProfile = comboContext.recoProfile();
assert.equal(comboProfile.feedbackCombo['ambient|sleep'], -40,
  'five unanimous ambient-sleep refusals are learned as an exact combo');
assert.equal(comboProfile.feedbackPurpose.sleep, 20,
  'sleep remains globally positive after acceptances in other genres');
const comboDay = '2026-08-20';
const rejectedComboScore = comboContext.recoDailyScore(rejectedAmbientSleep, comboProfile, comboDay);
const safeSleepScore = comboContext.recoDailyScore(safeClassicalSleep, comboProfile, comboDay);
assert.ok(rejectedComboScore < 90 && safeSleepScore > 90 && safeSleepScore > rejectedComboScore,
  'the rejected genre×purpose combo dominates locally without condemning sleep in other genres');

const editedFeedbackRow = {
  n: 20500, title: 'Soft Jazz for deep sleep', genre: 'Ambient', valid: 'X',
  niche: 'Study / focus / work', kw: 'productivity coding',
  _genreKey: 'nature', _purposeKey: 'sleep', _titleEdited: true,
};
const editedContext = makeContext([editedFeedbackRow], new Map(), []);
assert.equal(editedContext.recoGenreKey(editedFeedbackRow.genre, editedFeedbackRow), 'jazz',
  'an edited title derives its genre from final copy instead of stale row.genre or generated keys');
assert.equal(editedContext.recoPurposeKey(editedFeedbackRow), 'sleep',
  'an edited title derives its purpose from the final reviewed copy');
const editedProfile = editedContext.recoProfile();
assert.equal(editedProfile.feedbackCombo['jazz|sleep'], 6,
  'feedback from edited copy teaches the final genre×purpose combination');
assert.equal(editedProfile.feedbackCombo['nature|sleep'], undefined,
  'feedback from edited copy never teaches the superseded generated keys');
for(const staleToken of ['study','focus','work','productivity','coding']){
  assert.equal(editedProfile.feedbackToken[staleToken], undefined,
    `edited feedback never learns stale ${staleToken} metadata`);
}
for(const finalToken of ['soft','jazz','deep','sleep']){
  assert.ok(Number(editedProfile.feedbackToken[finalToken])>0,
    `edited feedback learns ${finalToken} from final copy`);
}
const editedSeasonalPiano = {
  title: 'Christmas Piano | soft piano for deep sleep', genre: 'Christmas Lofi',
  _genreKey: 'christmas', _purposeKey: 'season', _titleEdited: true,
};
assert.equal(editedContext.recoGenreKey(editedSeasonalPiano.genre, editedSeasonalPiano), 'piano',
  'an edited seasonal title keeps its explicit musical lane instead of a seasonal wrapper');
const editedGenreFixtures = [
  [{title:'Jazz Noir 🎷 [jazz lofi]',genre:'Jazz',_titleEdited:true},'jazz'],
  [{title:'Cello & Rain | calm strings for deep sleep',genre:'Classical',_titleEdited:true},'classical'],
  [{title:'Fan Sounds | cozy nature ambience',genre:'Nature',_titleEdited:true},'nature'],
  [{title:'Rainstorm Sounds | cozy nature ambience',genre:'Nature',_titleEdited:true},'nature'],
];
for(const [row,expected] of editedGenreFixtures){
  assert.equal(editedContext.recoGenreKey(row.genre,row),expected,
    `edited genre classifier agrees with backend for ${row.title}`);
}
const editedPurposeFixtures = [
  [{title:'Focus Jazz | jazz for reading',_titleEdited:true},'reading'],
  [{title:'synthwave music to program to',_titleEdited:true},'study'],
  [{title:'synthwave to chill/game to',_titleEdited:true},'relax'],
];
for(const [row,expected] of editedPurposeFixtures){
  assert.equal(editedContext.recoPurposeKey(row),expected,
    `edited purpose classifier agrees with backend for ${row.title}`);
}
const editedWithoutGenre = {
  title: 'Quiet Evening', genre: 'Lofi', cluster: 'Study',
  _genreKey: 'jazz', _purposeKey: 'sleep', _titleEdited: true,
};
assert.equal(editedContext.recoGenreKey(editedWithoutGenre.genre, editedWithoutGenre), '',
  'a title-only edit without an explicit genre does not invent a genre change');
assert.equal(editedContext.recoPurposeKey(editedWithoutGenre), 'relax',
  'an edited neutral title uses the backend relax fallback instead of stale Study metadata');

const recencyRankingRows = [
  {n: -4101, title: 'Evergreen exceptional', valid: '', score: 99, genre: 'Ambient', _generatorVersion: 4, _sourceAgeM: 84, _titleFamily: 'evergreen'},
  {n: -4102, title: 'Older slightly stronger', valid: '', score: 92, genre: 'Piano', _generatorVersion: 4, _sourceAgeM: 30, _titleFamily: 'older'},
  {n: -4103, title: 'Recent measured average', valid: '', score: 88, genre: 'Jazz', _generatorVersion: 4, _sourceAgeM: 1, _titleFamily: 'recent'},
];
const recencyRankingBatch = Array.from(makeContext(recencyRankingRows, new Map(), []).dailyRecommendationSet());
assert.deepEqual(recencyRankingBatch.map(row => row.n), [-4101, -4103, -4102],
  'a recent measured source wins a close ranking call, while an exceptional evergreen source can still lead');
assert.deepEqual(recencyRankingBatch.map(row => row.scoreAdj), [99, 88, 92],
  'the separate recency prior never changes objective visible scores or tiers');

const diversityRows = [
  {n: -4301, title: 'Deep Focus Session | rainy lofi', genre: 'Lofi', score: 99, valid: '', _topicKey: 'deep work', _titleFamily: 'lofi|direct', _sourceVideoId: 'd1'},
  {n: -4302, title: 'Deep Focus Session | night lofi', genre: 'Lofi', score: 98, valid: '', _topicKey: 'Deep Work', _titleFamily: 'lofi|direct', _sourceVideoId: 'd2'},
  {n: -4303, title: 'Deep Focus Session | soft lofi', genre: 'Lofi', score: 97, valid: '', _topicKey: 'deep-work music', _titleFamily: 'lofi|direct', _sourceVideoId: 'd3'},
  {n: -4304, title: 'Rainy Coding Beats', genre: 'Lofi', score: 96, valid: '', _topicKey: 'rainy coding', _titleFamily: 'lofi|direct', _sourceVideoId: 'd4'},
  {n: -4305, title: 'Late Night Study', genre: 'Lofi', score: 95, valid: '', _topicKey: 'late night study', _titleFamily: 'lofi|direct', _sourceVideoId: 'd5'},
  {n: -4306, title: 'Quiet Reading Flow', genre: 'Lofi', score: 94, valid: '', _topicKey: 'quiet reading', _titleFamily: 'lofi|direct', _sourceVideoId: 'd6'},
  {n: -4307, title: 'Morning Focus Beats', genre: 'Lofi', score: 93, valid: '', _topicKey: 'morning focus', _titleFamily: 'lofi|direct', _sourceVideoId: 'd7'},
  {n: -4308, title: 'Soft Piano Rest', genre: 'Piano', score: 91, valid: '', _topicKey: 'soft piano rest', _titleFamily: 'piano|direct', _sourceVideoId: 'd8'},
  {n: -4309, title: 'Jazz Evening', genre: 'Jazz', score: 90, valid: '', _topicKey: 'jazz evening', _titleFamily: 'jazz|direct', _sourceVideoId: 'd9'},
];
const diversityBatch = Array.from(makeContext(diversityRows, new Map(), []).dailyRecommendationSet());
const diversityTopFive = diversityBatch.slice(0, 5);
assert.ok(diversityTopFive.filter(row => row.genre === 'Lofi').length >= 4,
  'a strongly ranked genre keeps several distinct concepts instead of being forced into equal style quotas');
assert.equal(diversityTopFive.filter(row => row.title.startsWith('Deep Focus Session')).length, 1,
  'a normalized duplicate topic is strictly limited to one card across the entire batch');
assert.equal(diversityBatch.length, 7,
  'strict topic deduplication removes both duplicate Deep Work variants without imposing genre quotas');
assert.equal(new Set(diversityBatch.map(row => row._topicKey && editedContext.recoNormalizedTopicKey(row))).size, diversityBatch.length,
  'every retained fixture card has a unique normalized global topic');
const storedDuplicateQueue = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [recoveryDayKey]: diversityRows.map(row => row.n), _pool: DEFAULT_V4_POOL,
})]]);
const storedDiversityBatch = Array.from(makeContext(diversityRows.map(row => Object.assign({}, row)), storedDuplicateQueue, []).dailyRecommendationSet());
assert.equal(storedDiversityBatch.length, 7,
  'strict topic uniqueness also repairs a previously stored daily queue, not only a newly ranked batch');
assert.equal(JSON.parse(storedDuplicateQueue.get('lofi_radar_reco_rotation_v4'))[recoveryDayKey].length, 7,
  'the repaired stored queue persists only its unique topic identities');

const publishedVideo = {
  ageM: 2, pctCh: 90, title: 'Published Quasar focus mix', genre: 'Lofi', niche: '',
  reco: {
    title: 'Rejected Nebula sleep proposal', genre: 'Ambient', purpose: 'Sleep', niche: 'Deep sleep', kw: 'instrumental',
    _genreKey: 'ambient', _purposeKey: 'sleep',
  },
};
const publishedContext = makeContext([], new Map(), [publishedVideo]);
const publishedFields = publishedContext.recoVideoFields(publishedVideo);
assert.equal(publishedFields.title, 'Published Quasar focus mix',
  'Analyse always supplies the title that was actually published');
assert.equal(publishedFields.genre, 'Lofi',
  'published Analyse metadata wins over linked recommendation metadata');
assert.equal(publishedFields.niche, '',
  'missing Analyse metadata stays missing instead of being copied from the linked recommendation');
assert.equal(publishedFields._genreKey, undefined,
  'a contradictory linked genre key never enters published-video learning');
assert.equal(publishedFields._purposeKey, undefined,
  'a contradictory linked purpose key never enters published-video learning');
const publishedProfile = publishedContext.recoProfile();
assert.ok(publishedProfile.performanceToken.quasar > 0,
  'performance learning tokenises the actually published title');
assert.equal(publishedProfile.performanceToken.nebula, undefined,
  'performance learning never tokenises the superseded recommendation title');
assert.ok(publishedProfile.performanceGenre.lofi > 0,
  'performance learning classifies the real published genre');
assert.equal(publishedProfile.performanceGenre.ambient, undefined,
  'linked recommendation genre metadata cannot corrupt published-video learning');
assert.ok(publishedProfile.performancePurpose.study > 0,
  'performance learning derives purpose from the real published title');
assert.equal(publishedProfile.performancePurpose.sleep, undefined,
  'linked recommendation purpose metadata cannot corrupt published-video learning');

const fullHistoryProfile = makeContext([], new Map(), [
  {ageM: 2, pctCh: 60, title: 'Recent signal', genre: 'Lofi'},
  {ageM: 5, pctCh: 60, title: 'Half year signal', genre: 'Jazz'},
  {ageM: 10, pctCh: 60, title: 'Annual signal', genre: 'Piano'},
  {ageM: 18, pctCh: 60, title: 'Two year signal', genre: 'Classical'},
  {ageM: 40, pctCh: 60, title: 'Five year signal', genre: 'Guitar'},
  {ageM: 84, pctCh: 60, title: 'Evergreen signal', genre: 'Ambient'},
]).recoProfile();
assert.equal(fullHistoryProfile.recentVideos, 6,
  'all dated owned videos contribute to performance learning');
['3m', '6m', '12m', '24m', '60m', 'evergreen'].forEach(windowId => {
  assert.equal(fullHistoryProfile.windows[windowId], 1, `${windowId} history bucket is represented`);
});

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
  ['lofi_radar_reco_rotation_v4', JSON.stringify({[tierDayKey]: [objectiveS.n]})],
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
  ['lofi_radar_reco_rotation_v4', JSON.stringify({[tierDayKey]: [legacyS.n]})],
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
  'lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: originalQueue}),
], ['lofi_radar_generated_reco_decisions_v1', decisionSentinel]]);
const regressionContext = makeContext(regressionRecos, regressionStored, []);
const remainingQueue = regressionContext.dailyRecommendationSet();
assert.equal(remainingQueue.length, 21, '29 decisions reduce the stored 50-card queue to 21');
assert.deepEqual(Array.from(remainingQueue, row => row.n), originalQueue.slice(29),
  'the 21 still-pending cards retain their exact order without replacements');
const persistedRegression = JSON.parse(regressionStored.get('lofi_radar_reco_rotation_v4'));
assert.deepEqual(persistedRegression[todayKey], originalQueue,
  'the original finite lot remains stored until an explicit refresh');
assert.equal(regressionStored.get('lofi_radar_generated_reco_decisions_v1'), decisionSentinel,
  'rendering the reduced queue never rewrites the generated-decision store');
const lazyHistory = {[todayKey]: originalQueue.slice()};
assert.equal(regressionContext.finalizeDailyRecommendationHistoryProfile(lazyHistory, todayKey), false,
  'late performance history does not rebuild a queue after review has started');
assert.deepEqual(lazyHistory[todayKey], originalQueue,
  'late performance history preserves every identity in the reviewed daily lot');

const legacyHydrationRecos = Array.from({length: 130}, (_, index) => ({
  n: -7000 - index,
  title: `Legacy hydration concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  concept: `Legacy hydration direction ${index + 1}`,
  score: 90,
  valid: index < 28 ? '-' : '',
  _generatorVersion: 4,
  _topicKey: `legacy hydration topic ${index + 1}`,
  _conceptFamily: `legacy-hydration-family-${index + 1}`,
  _titleFamily: `legacy-hydration-title-${index + 1}`,
}));
const legacyHydrationQueue = legacyHydrationRecos.slice(0, 50).map(row => row.n);
const legacyHydrationStore = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [todayKey]: legacyHydrationQueue,
  _pool: Object.assign({}, DEFAULT_V4_POOL, {buildId: 'previous-partial-build'}),
})]]);
const repairedLegacyHydration = makeContext(legacyHydrationRecos, legacyHydrationStore, []).dailyRecommendationSet();
assert.equal(repairedLegacyHydration.length, 50,
  'the deployed migration repairs an already-persisted 22-card hydration remainder');
assert.ok(repairedLegacyHydration.every(row => !row.valid),
  'the migration never reintroduces one of the 28 historical decisions');

// Shared decisions can arrive after the recommendation view has already
// painted. That first, pre-hydration draw is provisional: once the central
// state lands, rebuild it once from the remaining qualified reserve instead
// of freezing the 50-card queue at 22 visible cards. After that one rebuild,
// decisions made during the actual review must retain the finite-queue rule.
const hydrationState = {ready: false, networkReady: false};
const hydrationRecos = Array.from({length: 130}, (_, index) => ({
  n: -8000 - index,
  title: `Hydration race concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  concept: `Hydration race direction ${index + 1}`,
  score: 90,
  valid: '',
  _generatorVersion: 4,
  _topicKey: `hydration topic ${index + 1}`,
  _conceptFamily: `hydration-family-${index + 1}`,
  _titleFamily: `hydration-title-${index + 1}`,
}));
const hydrationStored = new Map();
const hydrationContext = makeContext(
  hydrationRecos,
  hydrationStored,
  [],
  undefined,
  Date,
  hydrationState,
);
const provisionalHydrationBatch = hydrationContext.dailyRecommendationSet();
assert.equal(provisionalHydrationBatch.length, 50,
  'the recommendation view paints a complete provisional batch without waiting for the shared request');
const hydratedVetoIds = new Set(provisionalHydrationBatch.slice(0, 28).map(row => row.n));
hydrationRecos.filter(row => hydratedVetoIds.has(row.n)).forEach(row => { row.valid = '-'; });
hydrationState.ready = true;
hydrationState.networkReady = true;
const finalizedHydrationBatch = hydrationContext.dailyRecommendationSet();
assert.equal(finalizedHydrationBatch.length, 50,
  'the first shared-state hydration replaces a stale 22-card remainder with a complete qualified batch');
assert.ok(finalizedHydrationBatch.every(row => !hydratedVetoIds.has(row.n)),
  'the rebuilt batch excludes every concept vetoed by the hydrated shared state');
const finalizedHydrationIds = Array.from(finalizedHydrationBatch, row => row.n);
hydrationRecos.find(row => row.n === finalizedHydrationIds[0]).valid = 'X';
const afterHydratedDecision = hydrationContext.dailyRecommendationSet();
assert.equal(afterHydratedDecision.length, 49,
  'a genuine decision after hydration reduces the finalized lot without implicit backfill');
assert.deepEqual(
  Array.from(afterHydratedDecision, row => row.n),
  finalizedHydrationIds.slice(1),
  'the remaining finalized cards keep their order after a genuine decision',
);

const inFlightHydrationState = {ready: false, networkReady: false, reviewedIds: []};
const inFlightHydrationRecos = hydrationRecos.map((row, index) => Object.assign({}, row, {
  n: -9000 - index,
  valid: '',
  _topicKey: `in-flight hydration topic ${index + 1}`,
  _conceptFamily: `in-flight-hydration-family-${index + 1}`,
}));
const inFlightHydrationStore = new Map();
const inFlightHydrationContext = makeContext(
  inFlightHydrationRecos,
  inFlightHydrationStore,
  [],
  undefined,
  Date,
  inFlightHydrationState,
);
const inFlightProvisional = inFlightHydrationContext.dailyRecommendationSet();
const reviewedDuringHydration = inFlightProvisional[0].n;
inFlightHydrationState.reviewedIds = [reviewedDuringHydration];
inFlightProvisional.slice(0, 28).forEach(row => {
  inFlightHydrationRecos.find(candidate => candidate.n === row.n).valid = '-';
});
inFlightHydrationState.ready = true;
inFlightHydrationState.networkReady = true;
const inFlightFinalized = inFlightHydrationContext.dailyRecommendationSet();
assert.equal(inFlightFinalized.length, 49,
  'a decision made during hydration is counted once instead of being silently replaced');
const inFlightHistory = JSON.parse(inFlightHydrationStore.get('lofi_radar_reco_rotation_v4'));
assert.ok(inFlightHistory[todayKey].includes(reviewedDuringHydration),
  'the finalized lot keeps an in-flight reviewed ID so Restore can bring it back');
inFlightHydrationRecos.find(row => row.n === reviewedDuringHydration).valid = '';
inFlightHydrationContext.invalidateRecommendationDerivedData();
assert.equal(inFlightHydrationContext.dailyRecommendationSet().length, 50,
  'restoring an in-flight decision returns its original slot without drawing a new candidate');

// A cache/offline fallback is not the same as a confirmed network snapshot.
// Even when the later server revision is newer than the lot (for example due
// to an unrelated mutation), the first successful network response must still
// repair historical exclusions that would otherwise leave only 22 cards.
const delayedNetworkState = {ready: true, networkReady: false, revision: 1000, reviewedIds: []};
const delayedNetworkRecos = hydrationRecos.map((row, index) => Object.assign({}, row, {
  n: -10000 - index,
  valid: '',
  _topicKey: `delayed network topic ${index + 1}`,
  _conceptFamily: `delayed-network-family-${index + 1}`,
}));
const delayedNetworkContext = makeContext(
  delayedNetworkRecos,
  new Map(),
  [],
  undefined,
  Date,
  delayedNetworkState,
);
const cachedFallbackBatch = delayedNetworkContext.dailyRecommendationSet();
cachedFallbackBatch.slice(0, 28).forEach(row => {
  delayedNetworkRecos.find(candidate => candidate.n === row.n).valid = '-';
});
delayedNetworkState.networkReady = true;
delayedNetworkState.revision = Date.now() + 60_000;
const delayedNetworkFinalized = delayedNetworkContext.dailyRecommendationSet();
assert.equal(delayedNetworkFinalized.length, 50,
  'the first late network confirmation repairs 22 cards even when its global revision is newer than the lot');
assert.ok(delayedNetworkFinalized.every(row => !row.valid),
  'the late-network rebuild keeps every historical exclusion out of the repaired lot');

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
const untouchedStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: untouchedQueue})]]);
const untouchedContext = makeContext(untouchedRecos, untouchedStored, []);
const untouchedHistory = JSON.parse(untouchedStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(untouchedContext.finalizeDailyRecommendationHistoryProfile(untouchedHistory, todayKey), false,
  'late performance history never replaces an untouched existing lot');
assert.deepEqual(untouchedHistory[todayKey], untouchedQueue,
  'all untouched queue IDs remain stable after lazy performance history');
assert.equal(untouchedContext.dailyRecommendationSet().length, 50,
  'the untouched lot remains fully visible');

const missingIdQueue = [6999, ...untouchedQueue.slice(1)];
const missingStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: missingIdQueue})]]);
const missingContext = makeContext(untouchedRecos.slice(1), missingStored, []);
const missingHistory = JSON.parse(missingStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(missingContext.finalizeDailyRecommendationHistoryProfile(missingHistory, todayKey), false,
  'a stored ID absent from DATA prevents lazy history from recreating the lot');
assert.deepEqual(missingHistory[todayKey], missingIdQueue,
  'the missing resolved identity remains recorded in the finite lot');
assert.equal(missingContext.dailyRecommendationSet().length, 49,
  'one absent stored ID reduces the visible queue instead of triggering a replacement');

const refreshedQueue = untouchedQueue.slice().reverse();
const refreshRaceStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [todayKey]: refreshedQueue,
  _consumed: Array.from({length: 50}, (_, index) => 5900 + index),
})]]);
const refreshRaceContext = makeContext(untouchedRecos, refreshRaceStored, []);
const refreshRaceHistory = JSON.parse(refreshRaceStored.get('lofi_radar_reco_rotation_v4'));
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
  'a broad shared title family never shrinks a small qualified pool');

const fallbackGateRows = [
  {n: 1801, title: 'Measured specific hook', genre: 'Lofi', score: 90, valid: '', _hookOrigin: 'measured_theme'},
  {n: 1802, title: 'Genre-only synonym', genre: 'Ambient', score: 99, valid: '', _hookOrigin: 'editorial_fallback'},
];
assert.deepEqual(
  Array.from(makeContext(fallbackGateRows, new Map(), []).dailyRecommendationSet(), row => row.n),
  [1801],
  'an editorial fallback stays out of the daily lot even if adaptive signals could lift its score',
);

const emptyStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: [], _pool: DEFAULT_V4_POOL})]]);
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
const familyStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [todayKey]: familyRecos.slice(0, 50).map(row => row.n),
})]]);
const familyContext = makeContext(familyRecos, familyStored, []);
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

const hookRecos = Array.from({length: 130}, (_, index) => ({
  n: 5000 + index,
  title: index < 2 ? (index ? 'Night Jazz | jazz for reading' : 'Night Jazz | jazz to relax to') : `Distinct hook ${index}`,
  genre: index < 2 ? 'Jazz' : 'Lofi',
  perso: 'Lofi Girl',
  score: index < 2 ? 99 - index : 90,
  valid: '',
  _topicKey: index < 2 ? 'night jazz' : `distinct hook ${index}`,
  _purposeKey: index ? 'reading' : 'relax',
  _conceptFamily: index < 2 ? `jazz|${index ? 'reading' : 'relax'}|night jazz` : `safe-hook-family-${index}`,
  _titleFamily: `hook-guard-title-${index}`,
}));
const hookStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [todayKey]: [5000, ...hookRecos.slice(2, 51).map(row => row.n)],
})]]);
const hookContext = makeContext(hookRecos, hookStored, []);
assert.ok(hookContext.dailyRecommendationSet().some(row => row.n === 5000),
  'the fixture initially exposes the strongest variant of a repeated hook');
assert.ok(!hookContext.dailyRecommendationSet().some(row => row.n === 5001),
  'the alternate purpose variant remains available in reserve');
hookRecos[0].valid = '-';
assert.ok(!hookContext.dailyRecommendationSet().some(row => row._topicKey === 'night jazz'),
  'a refusal immediately blocks the same hook across concept families and purposes');
hookContext.refreshDailyRecommendations({stopPropagation() {}});
assert.ok(!hookContext.dailyRecommendationSet().some(row => row._topicKey === 'night jazz'),
  'New ideas cannot revive a globally refused hook before the backend refresh');

console.log('YouTube daily recommendations: OK');
