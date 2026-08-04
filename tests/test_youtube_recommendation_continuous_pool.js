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
  'new generated decisions remain retained on the current device');

assert.match(recommendations, /if\(rec\._generated\)saveGeneratedRecommendationDecision\(rec\.n,val,rec\);\s*else writeValid\(n,val,btn\);/,
  'generated IDs are never sent blindly to the legacy Sheet row writer');
assert.match(recommendations, /const persistence=rec\._generated\s*\?\(saveGeneratedRecommendationDecision\(rec\.n,val,rec\),Promise\.resolve\(\{ok:true\}\)\)/,
  'comments on generated ideas use local persistence instead of the legacy Sheet writer');
assert.match(recommendations, /CONTINUOUS_RECO_VARIANT_VERSION=2/,
  'the legacy V1 variant payload is explicitly versioned out');
assert.match(recommendations, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v3'/,
  'evidence-calibrated anti-repetition uses the v3 rotation namespace');
assert.ok(
  helpers.indexOf('mergeGeneratedRecommendationPool(d)') < helpers.indexOf('applyRecommendationEdits(d)'),
  'generated ideas are merged before local title and description edits are applied',
);
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
    _generated: true, _sourceVideoId: 'measuredA01', _sourceMarketScore: 91.25,
  },
  {
    n: -1000000102, valid: '', score: 88, scoreAdj: 88, genre: 'Ambient', perso: 'Lofi Girl',
    title: 'Silent Orbit · Slow Down', concept: 'A measured ambient direction.',
    noteData: 'EXACT EVIDENCE B · 8.1 M views · 300 k views/month.',
    _generated: true, _sourceVideoId: 'measuredB02', _sourceMarketScore: 86.5,
  },
  {
    n: -1000000103, valid: '', score: 86, scoreAdj: 86, genre: 'Piano', perso: 'Lofi Girl',
    title: 'First Snow · Reading Flow', concept: 'A measured piano direction.',
    noteData: 'EXACT EVIDENCE C · 5.4 M views · 210 k views/month.',
    _generated: true, _sourceVideoId: 'measuredC03', _sourceMarketScore: 82.75,
  },
];
const roadmapWinner = {
  n: 77, valid: '-', score: 70, genre: 'Lofi', perso: 'Lofi Girl',
  title: 'Roadmap learning winner', concept: 'rainy focus format',
};
const rotationStored = new Map([
  ['lofi_radar_generated_reco_decisions_v1', '{}'],
  ['lofi_radar_reco_rotation_v3', '{}'],
]);
const rotationContext = {
  DATA: {recos: [Object.assign({}, roadmapWinner)]},
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
  Array,
  localStorage: {
    getItem(key) { return rotationStored.get(key) || null; },
    setItem(key, value) { rotationStored.set(key, value); },
  },
  window: {LOFI_RECOMMENDATION_POOL: {items: measuredSeeds.map(row => Object.assign({}, row))}},
  normalizedRecommendationTitle(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  persoCategory(value) { return value || 'Sans personnage'; },
  isValidated(value) { return /^x(?=$|\s|[,;:\-])/i.test(String(value || '').trim()); },
  isRefused(value) { return /^-/.test(String(value || '').trim()); },
  recommendationRoadmapEntry(row) { return Number(row && row.n) === 77 ? {recoN: 77, title: roadmapWinner.title} : null; },
  scheduledRows() { return [{recoN: 77, title: roadmapWinner.title}]; },
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
  this.rememberForTest = rememberRecoIds;`, rotationContext);
rotationContext.mergePoolForTest(rotationContext.DATA);

const firstProfile = rotationContext.profileForTest();
assert.ok(firstProfile.feedbackGenre.lofi > 0,
  'an active Roadmap placement wins over a stale refusal as positive learning feedback');
const firstBatch = Array.from(rotationContext.dailySetForTest());
assert.equal(firstBatch.length, measuredSeeds.length,
  'the batch stays short when only three measured qualified concepts remain');
assert.ok(firstBatch.every(row => !row._continuousVariant),
  'the browser never generates continuous filler to reach 50 cards');
assert.deepEqual(Array.from(rotationContext.generateForTest(50, firstProfile, '2026-07-28', {}, {})), [],
  'continuous browser generation is disabled even when explicitly requested');

const dayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date());
const part = type => dayParts.find(item => item.type === type).value;
const today = `${part('year')}-${part('month')}-${part('day')}`;
assert.equal(JSON.parse(rotationStored.get('lofi_radar_reco_rotation_v3'))[today].length, measuredSeeds.length,
  'the v3 rotation stores only the measured active batch');

rotationContext.refreshForTest({stopPropagation() {}});
const afterRefresh = Array.from(rotationContext.dailySetForTest());
assert.equal(afterRefresh.length, 0,
  'same-day refresh returns no filler once the qualified measured reservoir is exhausted');

const staleSeen = rotationContext.seenForTest({
  _seen: [1, 2, 3],
  _recent: {day: '1900-01-01', ids: [4, 5, 6]},
});
assert.equal(staleSeen.size, 0,
  'legacy permanent and stale-day anti-repeat entries expire instead of suppressing ideas forever');
const boundedHistory = {_seen: Array.from({length: 5000}, (_, index) => index + 1)};
rotationContext.rememberForTest(boundedHistory, Array.from({length: 1205}, (_, index) => 10000 + index));
assert.equal(boundedHistory._recent.day, today);
assert.equal(boundedHistory._recent.ids.length, 1000,
  'same-day anti-repeat memory is explicitly bounded');
assert.ok(!Object.hasOwn(boundedHistory, '_seen'),
  'the old permanent anti-repeat ledger is removed during migration');

console.log('YouTube measured recommendation pool and bounded rotation: OK');
