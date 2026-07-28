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

assert.match(recommendations, /if\(rec\._generated\)saveGeneratedRecommendationDecision\(rec\.n,val\);\s*else writeValid\(n,val,btn\);/,
  'generated IDs are never sent blindly to the legacy Sheet row writer');
assert.match(recommendations, /function recoSeenIds\(/);
assert.match(recommendations, /history\._seen=\[\.\.\.seen\]\.slice\(-25000\)/,
  'the anti-repeat ledger spans far more than a two-week rotation');
assert.doesNotMatch(recommendations, /if\(pool\.length<RECO_DAILY_LIMIT\)pool=candidates/,
  'refresh never silently falls back to already-seen ideas');
assert.match(recommendations, /const placedActive=activeRoadmapIds\.has\(Number\(r\.n\)\)\|\|activeRoadmapTitles\.has/);
assert.match(recommendations, /placedActive\?4:3/,
  'an active Roadmap placement is a stronger positive learning signal than validation alone');
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

console.log('YouTube continuous recommendation pool: OK');
