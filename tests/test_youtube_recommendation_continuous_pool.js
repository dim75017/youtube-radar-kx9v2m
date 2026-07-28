'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const recommendations = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const poolSource = fs.readFileSync('Lofi_Radar_recommendation_pool.js', 'utf8');

const start = recommendations.indexOf("const GENERATED_RECO_DECISIONS_KEY=");
const end = recommendations.indexOf('function recommendationEdits()', start);
assert.ok(start >= 0 && end > start, 'generated recommendation overlay helpers must remain available');

const stored = new Map([
  ['lofi_radar_generated_reco_decisions_v1', JSON.stringify({
    '-1000000002': {value: 'X', updatedAt: 2},
  })],
]);
const context = {
  Date,
  JSON,
  String,
  Object,
  Array,
  Set,
  localStorage: {
    getItem(key){ return stored.get(key) || null; },
    setItem(key, value){ stored.set(key, value); },
  },
  normalizedRecommendationTitle(value){ return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  window: {
    LOFI_RECOMMENDATION_POOL: {
      items: [
        {n: -1000000001, title: 'Fresh evolving idea', valid: '', _generated: true},
        {n: -1000000002, title: 'Previously accepted evolving idea', valid: '', _generated: true},
      ],
    },
  },
};
vm.runInNewContext(`${recommendations.slice(start, end)}
  this.mergePool=mergeGeneratedRecommendationPool;
  this.saveDecision=saveGeneratedRecommendationDecision;`, context);

const data = {recos: [{n: 1, title: 'Curated Sheet idea', valid: ''}]};
context.mergePool(data);
assert.equal(data.recos.length, 3, 'the evolving overlay extends rather than replaces curated Sheet ideas');
assert.equal(data.recos.find(row => row.n === -1000000002).valid, 'X',
  'a generated idea keeps its local decision across live-data reloads');
context.saveDecision(-1000000001, '-');
assert.equal(JSON.parse(stored.get('lofi_radar_generated_reco_decisions_v1'))['-1000000001'].value, '-',
  'new generated decisions are retained on the current device');

assert.match(recommendations, /if\(rec\._generated\)saveGeneratedRecommendationDecision\(rec\.n,val,rec\);\s*else writeValid\(n,val,btn\);/,
  'generated IDs are never sent blindly to the legacy Sheet row writer');
assert.match(recommendations, /const persistence=rec\._generated\s*\?\(saveGeneratedRecommendationDecision\(rec\.n,val,rec\),Promise\.resolve\(\{ok:true\}\)\)/,
  'comments on generated ideas use local persistence instead of the legacy Sheet writer');
assert.match(recommendations, /function recoSeenIds\(/);
assert.match(recommendations, /history\._seen=\[\.\.\.seen\]\.slice\(-25000\)/,
  'the anti-repeat ledger spans far more than a two-week rotation');
assert.doesNotMatch(recommendations, /if\(pool\.length<RECO_DAILY_LIMIT\)pool=candidates/,
  'refresh never silently falls back to already-seen ideas');
assert.match(recommendations, /const placedActive=activeRoadmapIds\.has\(Number\(r\.n\)\)\|\|activeRoadmapTitles\.has/);
assert.match(recommendations, /const feedback=placedActive\?4:\(isRefused/,
  'an active Roadmap placement overrides even a stale refusal as positive learning feedback');
assert.ok(
  helpers.indexOf("mergeGeneratedRecommendationPool(d)") < helpers.indexOf("applyRecommendationEdits(d)"),
  'generated ideas are merged before local title and description edits are applied',
);
assert.match(index, /Lofi_Radar_recommendation_pool\.js\?payload=/,
  'the browser fetches the renewable pool without a stale cache');

const sandbox = {window: {}};
vm.runInNewContext(poolSource, sandbox);
const pool = sandbox.window.LOFI_RECOMMENDATION_POOL;
assert.ok(pool && pool.items.length > 1000,
  'the current renewable reservoir demonstrably exceeds the legacy 1,000-row catalogue');
assert.equal(new Set(pool.items.map(row => row.n)).size, pool.items.length);
assert.equal(new Set(pool.items.map(row => row.title.toLowerCase())).size, pool.items.length);

const rotationStart = recommendations.indexOf('const RECO_DAILY_LIMIT=50;');
const rotationEnd = recommendations.indexOf('function ensureRecommendationPerformanceHistory()', rotationStart);
assert.ok(rotationStart >= 0 && rotationEnd > rotationStart,
  'continuous rotation helpers must remain available');

const measuredSeeds = [
  {
    n: -1000000101, valid: '', score: 88, scoreAdj: 88, genre: 'Lofi', perso: 'Lofi Girl',
    title: 'Rainy Library · Deep Focus', concept: 'A measured lofi direction.', scene: 'Rainy library.',
    noteData: 'EXACT EVIDENCE A · 12.3 M views · 420 k views/month.',
    _generated: true, _sourceVideoId: 'measuredA01', _sourceMarketScore: 91.25,
  },
  {
    n: -1000000102, valid: '', score: 88, scoreAdj: 88, genre: 'Ambient', perso: 'Lofi Girl',
    title: 'Silent Orbit · Slow Down', concept: 'A measured ambient direction.', scene: 'Silent orbit.',
    noteData: 'EXACT EVIDENCE B · 8.1 M views · 300 k views/month.',
    _generated: true, _sourceVideoId: 'measuredB02', _sourceMarketScore: 86.5,
  },
  {
    n: -1000000103, valid: '', score: 86, scoreAdj: 86, genre: 'Piano', perso: 'Lofi Girl',
    title: 'First Snow · Reading Flow', concept: 'A measured piano direction.', scene: 'First snow.',
    noteData: 'EXACT EVIDENCE C · 5.4 M views · 210 k views/month.',
    _generated: true, _sourceVideoId: 'measuredC03', _sourceMarketScore: 82.75,
  },
];
const roadmapWinner = {
  n: 77, valid: '-', score: 70, genre: 'Lofi', perso: 'Lofi Girl',
  title: 'Roadmap learning winner', concept: 'rainy focus format',
};
const dayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date());
const part = type => dayParts.find(item => item.type === type).value;
const today = `${part('year')}-${part('month')}-${part('day')}`;
const unboundedStored = new Map([
  ['lofi_radar_reco_rotation_v1', JSON.stringify({_seen: measuredSeeds.map(row => row.n)})],
  ['lofi_radar_generated_reco_decisions_v1', '{}'],
]);
const unboundedStorage = {
  getItem(key){ return unboundedStored.get(key) || null; },
  setItem(key, value){ unboundedStored.set(key, value); },
};
function makeUnboundedContext(){
  const ctx = {
    DATA: {recos: [Object.assign({}, roadmapWinner)]},
    LANG: 'fr', Date, Intl, Set, Map, Object, Number, String, Math, JSON,
    localStorage: unboundedStorage,
    window: {LOFI_RECOMMENDATION_POOL: {items: measuredSeeds.map(row => Object.assign({}, row))}},
    normalizedRecommendationTitle(value){ return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
    persoCategory(value){ return value || 'Sans personnage'; },
    isValidated(value){ return /^x(?=$|\s|[,;:\-])/i.test(String(value || '').trim()); },
    isRefused(value){ return /^-/.test(String(value || '').trim()); },
    recommendationRoadmapEntry(row){ return Number(row && row.n) === 77 ? {recoN: 77, title: roadmapWinner.title} : null; },
    scheduledRows(){ return [{recoN: 77, title: roadmapWinner.title}]; },
    anaRows(){ return []; },
    rerenderRecos(){},
  };
  vm.runInNewContext(`${recommendations.slice(start, end)}
    ${recommendations.slice(rotationStart, rotationEnd)}
    this.mergePoolForTest=mergeGeneratedRecommendationPool;
    this.dailySetForTest=dailyRecommendationSet;
    this.refreshForTest=refreshDailyRecommendations;
    this.profileForTest=recoProfile;
    this.saveDecisionForTest=saveGeneratedRecommendationDecision;
    this.buildVariantForTest=buildContinuousRecommendationVariant;`, ctx);
  ctx.mergePoolForTest(ctx.DATA);
  return ctx;
}

const firstContext = makeUnboundedContext();
const firstProfile = firstContext.profileForTest();
assert.ok(firstProfile.genre.Lofi > 0,
  'an active Roadmap placement wins over a stale refusal and remains positive learning feedback');
let currentBatch = Array.from(firstContext.dailySetForTest());
assert.equal(currentBatch.length, 50, 'measured seeds can fill a complete on-demand batch after the static pool is exhausted');
assert.ok(currentBatch.every(row => row._continuousVariant), 'the overflow batch contains deterministic continuous variants');
assert.equal(currentBatch[0]._variantSeedN, measuredSeeds[0].n,
  'existing learned feedback participates in seed ranking before variants are selected');
const exactEvidence = new Set(measuredSeeds.map(row => row.noteData));
assert.ok(currentBatch.every(row => exactEvidence.has(row.noteData)),
  'every browser variant keeps an exact measured evidence string from its source seed');
assert.ok(currentBatch.every(row => measuredSeeds.some(seed => seed._sourceVideoId === row._sourceVideoId && seed.noteData === row.noteData)),
  'source video identity and evidence always travel together without synthetic metrics');

const deterministicA = firstContext.buildVariantForTest(measuredSeeds[0], 4242, new Set());
const deterministicB = firstContext.buildVariantForTest(measuredSeeds[0], 4242, new Set());
assert.equal(deterministicA.n, deterministicB.n);
assert.equal(deterministicA.title, deterministicB.title);
assert.equal(deterministicA.concept, deterministicB.concept);
assert.equal(deterministicA.noteData, measuredSeeds[0].noteData,
  'deterministic creativity never rewrites the measured proof');

const deliveredIds = new Set();
const deliveredTitles = new Set();
for (let round = 0; round < 61; round += 1) {
  assert.equal(currentBatch.length, 50, `round ${round + 1} stays complete`);
  for (const row of currentBatch) {
    assert.ok(!deliveredIds.has(row.n), `variant ${row.n} must never repeat`);
    assert.ok(!deliveredTitles.has(row.title.toLowerCase()), `variant title must never repeat: ${row.title}`);
    deliveredIds.add(row.n);
    deliveredTitles.add(row.title.toLowerCase());
  }
  if (round < 60) {
    firstContext.refreshForTest({stopPropagation(){}});
    currentBatch = Array.from(firstContext.dailySetForTest());
  }
}
assert.ok(deliveredIds.size > 3000,
  'New ideas demonstrably continues beyond the previous 3,000-item static overlay');

const activeIds = currentBatch.map(row => row.n);
const activeTitles = currentBatch.map(row => row.title);
const reloadedContext = makeUnboundedContext();
const reloadedBatch = Array.from(reloadedContext.dailySetForTest());
assert.deepEqual(reloadedBatch.map(row => row.n), activeIds,
  'the complete active batch survives a browser reload');
assert.deepEqual(reloadedBatch.map(row => row.title), activeTitles,
  'reload reconstructs the exact same deterministic variants, not lookalikes');

const acceptedVariant = reloadedBatch[0];
reloadedContext.saveDecisionForTest(acceptedVariant.n, 'X', acceptedVariant);
const decisionReload = makeUnboundedContext();
const persistedVariant = decisionReload.DATA.recos.find(row => Number(row.n) === Number(acceptedVariant.n));
assert.ok(persistedVariant, 'a decided continuous variant is materialized after reload');
assert.equal(persistedVariant.valid, 'X', 'its decision survives reload without a legacy Sheet row');
const savedVariantState = JSON.parse(unboundedStored.get('lofi_radar_reco_variants_v1'));
assert.ok(savedVariantState.cursor > 3000, 'the monotonic cursor preserves anti-repeat without a finite catalogue ceiling');
assert.equal(JSON.parse(unboundedStored.get('lofi_radar_reco_rotation_v1'))[today].length, 50,
  'the active rotation remains a focused 50-item work queue');

console.log('YouTube continuous recommendation pool: OK');
