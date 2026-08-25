'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const recommendations = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const poolSource = fs.readFileSync('Lofi_Radar_recommendation_pool.js', 'utf8');

const overlayStart = recommendations.indexOf("const GENERATED_RECO_DECISIONS_KEY=");
const overlayEnd = recommendations.indexOf('function recommendationEdits()', overlayStart);
assert.ok(overlayStart >= 0 && overlayEnd > overlayStart, 'generated recommendation overlay helpers must remain available');

const legacyVariant = {
  n: -2000000000001,
  title: 'Legacy generic V1 variant',
  valid: '',
  _generated: true,
  _continuousVariant: true,
  _continuousGeneratorVersion: 1,
};
const stored = new Map([
  ['lofi_radar_generated_reco_decisions_v1', JSON.stringify({
    '-1000000002': {value: 'X', updatedAt: 2},
  })],
  ['lofi_radar_reco_variants_v1', JSON.stringify({
    version: 1,
    cursor: 3001,
    active: [legacyVariant],
    decided: {[String(legacyVariant.n)]: Object.assign({}, legacyVariant, {valid: '-'})},
  })],
]);
const storage = {
  getItem(key) { return stored.get(key) || null; },
  setItem(key, value) { stored.set(key, value); },
};
const overlayContext = {
  Date,
  JSON,
  String,
  Object,
  Array,
  Set,
  localStorage: storage,
  normalizedRecommendationTitle(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  window: {
    LOFI_RECOMMENDATION_POOL: {
      items: [
        {n: -1000000001, title: 'Fresh measured idea', valid: '', _generated: true},
        {n: -1000000002, title: 'Previously accepted measured idea', valid: '', _generated: true},
      ],
    },
  },
};
vm.runInNewContext(`${recommendations.slice(overlayStart, overlayEnd)}
  this.mergePool = mergeGeneratedRecommendationPool;
  this.saveDecision = saveGeneratedRecommendationDecision;
  this.variantState = continuousRecommendationVariantState;`, overlayContext);

const migratedState = overlayContext.variantState();
assert.equal(migratedState.version, 2, 'the quality contract invalidates the legacy V1 generator state');
assert.equal(migratedState.cursor, 0, 'the obsolete infinite-variant cursor is discarded');
assert.deepEqual(Array.from(migratedState.active), [], 'pending V1 variants are never restored');
assert.deepEqual(Object.keys(migratedState.decided), [], 'decided V1 variants do not re-enter the candidate pool');

const data = {recos: [{n: 1, title: 'Curated Sheet idea', valid: ''}]};
overlayContext.mergePool(data);
assert.equal(data.recos.length, 3, 'the measured overlay extends rather than replaces curated Sheet ideas');
assert.equal(data.recos.find(row => row.n === -1000000002).valid, 'X',
  'a measured generated idea keeps its local decision across reloads');
assert.ok(!data.recos.some(row => row.n === legacyVariant.n),
  'an obsolete V1 continuous variant is not merged back into recommendations');
overlayContext.saveDecision(-1000000001, '-');
assert.equal(JSON.parse(stored.get('lofi_radar_generated_reco_decisions_v1'))['-1000000001'].value, '-',
  'new generated decisions remain available as an offline fallback');
assert.equal(JSON.parse(stored.get('lofi_radar_shared_reco_queue_v1'))[0].valid, '-',
  'new generated decisions are queued for the shared team state');

assert.match(recommendations, /if\(rec\._generated\)saveGeneratedRecommendationDecision\(rec\.n,val,rec\);\s*else writeValid\(n,val,btn\);/,
  'generated IDs are never sent blindly to the legacy Sheet row writer');
assert.match(recommendations, /const persistence=rec\._generated\s*\?saveGeneratedRecommendationDecision\(rec\.n,val,rec\)/,
  'comments on generated ideas enter the shared queue instead of the legacy Sheet writer');
assert.match(recommendations, /op=state&k=/,
  'the dashboard reads the central generated-recommendation state');
assert.match(recommendations, /method:'POST'.*Content-Type':'text\/plain;charset=utf-8'/s,
  'shared mutations use the Apps Script text POST contract without a CORS preflight');
assert.match(recommendations, /CONTINUOUS_RECO_VARIANT_VERSION=2/,
  'the legacy V1 variant payload is explicitly versioned out');
assert.match(recommendations, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v4'/,
  'full-history anti-repetition uses the v4 rotation namespace');
assert.ok(
  helpers.indexOf('mergeGeneratedRecommendationPool(d)') < helpers.indexOf('applyRecommendationEdits(d)'),
  'generated ideas are merged before shared or offline title and description edits are applied',
);
assert.doesNotMatch(helpers, /await\s+loadSharedRecommendationState\(/,
  'Apps Script availability never blocks catalogue loading or the first dashboard paint');
assert.match(helpers, /Promise\.resolve\(loadSharedRecommendationState\(\)\)\.catch\(\(\)=>\{\}\)/,
  'the cached shared state is hydrated immediately while the network refresh runs in the background');
assert.match(index, /Lofi_Radar_recommendation_pool\.js\?payload=/,
  'the browser fetches the measured reservoir without a stale cache');

const sandbox = {window: {}};
vm.runInNewContext(poolSource, sandbox);
const pool = sandbox.window.LOFI_RECOMMENDATION_POOL;
assert.ok(pool && Array.isArray(pool.items) && pool.items.length > 0,
  'the current measured reservoir is available without assuming an infinite size');
assert.equal(new Set(pool.items.map(row => row.n)).size, pool.items.length);
assert.equal(new Set(pool.items.map(row => row.title.toLowerCase())).size, pool.items.length);
assert.ok(pool.items.every(row => !row._continuousVariant),
  'the published reservoir contains measured concepts, not browser-fabricated filler');

const rotationStart = recommendations.indexOf('const RECO_DAILY_LIMIT=50;');
const rotationEnd = recommendations.indexOf('function ensureRecommendationPerformanceHistory()', rotationStart);
assert.ok(rotationStart >= 0 && rotationEnd > rotationStart, 'quality-aware rotation helpers must remain available');

const measuredSeeds = [
  {
    n: -1000000101, valid: '', score: 88, scoreAdj: 88, genre: 'Lofi', perso: 'Lofi Girl',
    title: 'Rainy Library · Deep Focus', concept: 'A measured lofi direction.',
    noteData: 'EXACT EVIDENCE A · 12.3 M views · 420 k views/month.',
    _generated: true, _generatorVersion: 4, _sourceVideoId: 'measuredA01', _sourceMarketScore: 91.25,
  },
  {
    n: -1000000102, valid: '', score: 88, scoreAdj: 88, genre: 'Ambient', perso: 'Lofi Girl',
    title: 'Silent Orbit · Slow Down', concept: 'A measured ambient direction.',
    noteData: 'EXACT EVIDENCE B · 8.1 M views · 300 k views/month.',
    _generated: true, _generatorVersion: 4, _sourceVideoId: 'measuredB02', _sourceMarketScore: 86.5,
  },
  {
    n: -1000000103, valid: '', score: 86, scoreAdj: 86, genre: 'Piano', perso: 'Lofi Girl',
    title: 'First Snow · Reading Flow', concept: 'A measured piano direction.',
    noteData: 'EXACT EVIDENCE C · 5.4 M views · 210 k views/month.',
    _generated: true, _generatorVersion: 4, _sourceVideoId: 'measuredC03', _sourceMarketScore: 82.75,
  },
];
const roadmapPending = {
  n: 77, valid: '', score: 70, genre: 'Lofi', perso: 'Lofi Girl',
  title: 'Roadmap pending title', concept: 'rainy focus format',
};
const roadmapRefused = {
  n: 78, valid: '-', score: 70, genre: 'Jazz', perso: 'Lofi Girl',
  title: 'Roadmap refused title', concept: 'late jazz format',
};
const acceptedTitle = {
  n: 79, valid: 'X', score: 70, genre: 'Ambient', perso: 'Lofi Girl',
  title: 'Explicitly accepted title', concept: 'ambient focus format',
};
let rotationNow = Date.parse('2026-08-04T10:00:00Z');
class RotationDate extends Date {
  constructor(...args) { super(...(args.length ? args : [rotationNow])); }
  static now() { return rotationNow; }
}
const preservedDecisionState = JSON.stringify({sentinel: {value: 'X'}});
const preservedEditState = JSON.stringify({sentinel: {title: 'Edited title'}});
const preservedRoadmapState = JSON.stringify([{key: 'sentinel-roadmap'}]);
const rotationStored = new Map([
  ['lofi_radar_generated_reco_decisions_v1', preservedDecisionState],
  ['lofi_radar_recommendation_edits_v1', preservedEditState],
  ['lofi_radar_roadmap_archive_v3', preservedRoadmapState],
  ['lofi_radar_reco_rotation_v4', '{}'],
]);
const rotationContext = {
  DATA: {recos: [roadmapPending, roadmapRefused, acceptedTitle].map(row => Object.assign({}, row))},
  LANG: 'fr',
  Date: RotationDate,
  Intl,
  Set,
  Map,
  Object,
  Number,
  String,
  Math,
  JSON,
  Array,
  localStorage: {
    getItem(key) { return rotationStored.get(key) || null; },
    setItem(key, value) { rotationStored.set(key, value); },
  },
  window: {LOFI_RECOMMENDATION_POOL: {
    schema: 3, version: 4, buildId: 'build-a', ledgerRevision: 'ledger-a', modelRevision: 'model-a', sourceT: 1,
    items: measuredSeeds.map(row => Object.assign({}, row)),
  }},
  normalizedRecommendationTitle(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  persoCategory(value) { return value || 'Sans personnage'; },
  isValidated(value) { return /^x(?=$|\s|[,;:\-])/i.test(String(value || '').trim()); },
  isRefused(value) { return /^-/.test(String(value || '').trim()); },
  recommendationRoadmapEntry(row) {
    row = [roadmapPending, roadmapRefused].find(item => item.n === Number(row && row.n));
    return row ? {recoN: row.n, title: row.title} : null;
  },
  scheduledRows() { return [roadmapPending, roadmapRefused].map(row => ({recoN: row.n, title: row.title})); },
  anaRows() { return []; },
  rerenderRecos() {},
};
vm.runInNewContext(`${recommendations.slice(overlayStart, overlayEnd)}
  ${recommendations.slice(rotationStart, rotationEnd)}
  this.mergePoolForTest = mergeGeneratedRecommendationPool;
  this.dailySetForTest = dailyRecommendationSet;
  this.refreshForTest = refreshDailyRecommendations;
  this.profileForTest = recoProfile;
  this.generateForTest = generateContinuousRecommendationVariants;
  this.seenForTest = recoSeenIds;
  this.rememberForTest = rememberRecoIds;
  this.invalidateForTest = invalidateRecommendationDerivedData;
  this.dayForTest = recoDayKey;
  this.consumedLimitForTest = RECO_CONSUMED_LIMIT;`, rotationContext);
rotationContext.mergePoolForTest(rotationContext.DATA);

const reprojectedSeed = Object.assign({}, rotationContext.window.LOFI_RECOMMENDATION_POOL.items[0], {
  title: 'Rainy Pages · Deep Focus',
  score: 93,
});
rotationContext.window.LOFI_RECOMMENDATION_POOL.items[0] = reprojectedSeed;
rotationContext.mergePoolForTest(rotationContext.DATA);
const reprojectedRow = rotationContext.DATA.recos.find(row => row.n === reprojectedSeed.n);
assert.equal(reprojectedRow.title, reprojectedSeed.title,
  'a no-store pool refresh updates an existing generated row with the same stable ID');
assert.equal(reprojectedRow.score, 93,
  'the in-memory recommendation projection receives the refreshed evidence score');

const firstProfile = rotationContext.profileForTest();
assert.equal(firstProfile.feedbackGenre.lofi, undefined,
  'a Roadmap placement without an explicit title decision is neutral');
assert.equal(firstProfile.feedbackGenre.jazz, -8,
  'a Roadmap placement never overrides an explicit title refusal');
assert.equal(firstProfile.feedbackGenre.ambient, 6,
  'only an explicit title validation supplies positive feedback');
const firstBatch = Array.from(rotationContext.dailySetForTest());
assert.equal(firstBatch.length, measuredSeeds.length,
  'the batch stays short when only three measured qualified concepts remain');
assert.ok(firstBatch.every(row => !row._continuousVariant),
  'the browser never generates continuous filler to reach 50 cards');
assert.deepEqual(Array.from(rotationContext.generateForTest(50, firstProfile, '2026-07-28', {}, {})), [],
  'continuous browser generation is disabled even when explicitly requested');

const today = rotationContext.dayForTest();
assert.equal(JSON.parse(rotationStored.get('lofi_radar_reco_rotation_v4'))[today].length, measuredSeeds.length,
  'the v4 rotation stores only the measured active batch');

rotationContext.refreshForTest({stopPropagation() {}});
const afterRefresh = Array.from(rotationContext.dailySetForTest());
assert.equal(afterRefresh.length, 0,
  'same-day refresh returns no filler once the qualified measured reservoir is exhausted');
const consumedAfterRefresh = JSON.parse(rotationStored.get('lofi_radar_reco_rotation_v4'))._consumed;
assert.deepEqual([...consumedAfterRefresh].sort((a, b) => a - b), measuredSeeds.map(row => row.n).sort((a, b) => a - b),
  'every idea explicitly discarded by Refresh enters the durable consumed ledger');
assert.equal(rotationStored.get('lofi_radar_generated_reco_decisions_v1'), preservedDecisionState,
  'refresh does not alter recommendation decisions');
assert.equal(rotationStored.get('lofi_radar_recommendation_edits_v1'), preservedEditState,
  'refresh does not alter recommendation edits');
assert.equal(rotationStored.get('lofi_radar_roadmap_archive_v3'), preservedRoadmapState,
  'refresh does not alter Roadmap state');

const appendedSeeds = [
  {
    n: -1000000104, valid: '', score: 91, scoreAdj: 91, genre: 'Jazz', perso: 'Lofi Girl',
    title: 'Night Tram Â· Quiet Study', concept: 'A newly appended measured direction.',
    noteData: 'EXACT EVIDENCE D Â· 4.8 M views Â· 190 k views/month.',
    _generated: true, _generatorVersion: 4, _sourceVideoId: 'measuredD04', _sourceMarketScore: 84.5,
  },
  {
    n: -1000000105, valid: '', score: 89, scoreAdj: 89, genre: 'Ambient', perso: 'Lofi Girl',
    title: 'Moss Observatory Â· Calm Work', concept: 'Another newly appended measured direction.',
    noteData: 'EXACT EVIDENCE E Â· 3.9 M views Â· 175 k views/month.',
    _generated: true, _generatorVersion: 4, _sourceVideoId: 'measuredE05', _sourceMarketScore: 83.25,
  },
];
rotationContext.window.LOFI_RECOMMENDATION_POOL.items.push(...appendedSeeds.map(row => Object.assign({}, row)));
rotationContext.window.LOFI_RECOMMENDATION_POOL.buildId = 'build-b';
rotationContext.window.LOFI_RECOMMENDATION_POOL.ledgerRevision = 'ledger-b';
rotationContext.mergePoolForTest(rotationContext.DATA);
rotationContext.invalidateForTest();
rotationNow = Date.parse('2026-08-05T10:00:00Z');
const nextDayBatch = Array.from(rotationContext.dailySetForTest());
assert.deepEqual(nextDayBatch.map(row => row.n).sort((a, b) => a - b), appendedSeeds.map(row => row.n).sort((a, b) => a - b),
  'a new day and a new pool revision expose only newly appended stock, never refresh-discarded IDs');
const nextDayHistory = JSON.parse(rotationStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(nextDayHistory._pool.buildId, 'build-b');
assert.equal(nextDayHistory._pool.ledgerRevision, 'ledger-b');
assert.deepEqual([...nextDayHistory._consumed].sort((a, b) => a - b), measuredSeeds.map(row => row.n).sort((a, b) => a - b),
  'buildId and ledgerRevision are diagnostic metadata and never reset consumed stable IDs');

const staleSeen = rotationContext.seenForTest({
  _seen: [1, 2, 3],
  _recent: {day: '1900-01-01', ids: [4, 5, 6]},
});
assert.deepEqual(Array.from(staleSeen).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6],
  'legacy permanent and stale-day refresh entries migrate without becoming repeatable');
const boundedHistory = {_seen: Array.from({length: 5000}, (_, index) => index + 1)};
rotationContext.rememberForTest(boundedHistory, Array.from({length: rotationContext.consumedLimitForTest + 5}, (_, index) => 10000 + index));
assert.equal(boundedHistory._consumed.length, rotationContext.consumedLimitForTest,
  'the durable consumed ledger uses a large explicit FIFO bound');
assert.equal(boundedHistory._consumed.at(-1), 10000 + rotationContext.consumedLimitForTest + 4);
assert.ok(!Object.hasOwn(boundedHistory, '_seen'),
  'the old permanent anti-repeat ledger is migrated to the current shape');
assert.ok(!Object.hasOwn(boundedHistory, '_recent'),
  'the former day-scoped refresh memory is migrated to the durable ledger');

console.log('YouTube measured recommendation pool and durable no-repeat rotation: OK');
