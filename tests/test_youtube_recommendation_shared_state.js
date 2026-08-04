'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf("const RECO_EDIT_STORAGE_KEY=");
const end = source.indexOf('function legacyFilterRecos(', start);
assert.ok(start >= 0 && end > start, 'shared recommendation state helpers must remain extractable');

const stored = new Map([
  ['lofi_radar_generated_reco_decisions_v1', JSON.stringify({
    '-101': {value: 'X', updatedAt: 20},
    '-102': {value: 'X', updatedAt: 10},
    '-104': {value: 'X', updatedAt: 10},
  })],
  ['lofi_radar_recommendation_edits_v1', JSON.stringify({
    '-101': {title: 'Edited by the team', concept: 'Sharper concept', desc: 'Sharper description', updatedAt: 21},
  })],
]);
const server = new Map([
  ['-101', {n: -101, valid: '', updatedAt: 5}],
  ['-102', {n: -102, valid: '-', updatedAt: 50}],
  ['-104', {n: -104, updatedAt: 60}],
]);
const posts = [];
const timers = [];
const response = payload => ({ok: true, status: 200, async json() { return payload; }});
const context = {
  console,
  Date,
  JSON,
  Map,
  Set,
  Number,
  String,
  Object,
  Array,
  Promise,
  localStorage: {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
  },
  window: {
    LOFI_RECOMMENDATION_POOL: {items: [
      {n: -101, title: 'Measured idea A', genre: 'Lofi', _generated: true, _sourceVideoId: 'sourceA0001'},
      {n: -102, title: 'Measured idea B', genre: 'Ambient', _generated: true, _sourceVideoId: 'sourceB0002'},
      {n: -104, title: 'Measured idea C', genre: 'Piano', _generated: true, _sourceVideoId: 'sourceC0003'},
    ]},
    addEventListener() {},
  },
  setTimeout(fn, delay) { timers.push({fn, delay}); return timers.length; },
  clearTimeout() {},
  normalizedRecommendationTitle(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  isExplicitManualRoadmapPlacement(row) { return !!(row && row.recoN != null); },
  async fetch(url, options = {}) {
    if (!options.method) {
      return response({ok: true, version: 2, updatedAt: 50, items: [...server.values()]});
    }
    const mutation = JSON.parse(options.body);
    posts.push(mutation);
    const current = server.get(String(mutation.n)) || {n: mutation.n};
    const item = {...current, updatedAt: 100 + posts.length, title: mutation.title || current.title};
    if (mutation.action === 'decision') item.valid = mutation.valid;
    if (mutation.action === 'edit') {
      item.editedTitle = mutation.editedTitle;
      item.editedConcept = mutation.editedConcept;
      item.editedDesc = mutation.editedDesc;
    }
    if (mutation.action === 'roadmap') {
      item.roadmapDate = mutation.roadmapDate;
      item.roadmapState = 'active';
    }
    if (mutation.action === 'archive') item.roadmapState = 'archived';
    server.set(String(mutation.n), item);
    return response({ok: true, item});
  },
};

vm.runInNewContext(`
  const WRITE_URL='https://example.test/exec';
  const WRITE_KEY='test-key';
  let SCHED_LOCAL=[{recoN:-101,date:1786000000000,title:'Measured idea A',src:'Recommandation validée (placement manuel)'}];
  ${source.slice(start, end)}
  this.loadShared=loadSharedRecommendationState;
  this.flushShared=flushSharedRecommendationQueue;
  this.readQueue=sharedRecommendationQueue;
  this.effective=sharedRecommendationEffectiveItem;
  this.mergePool=mergeGeneratedRecommendationPool;
  this.queueMutation=queueSharedRecommendationMutation;
`, context);

(async () => {
  await context.loadShared();
  const queued = Array.from(context.readQueue());
  assert.deepEqual(new Set(queued.map(item => item.action)), new Set(['decision', 'edit', 'roadmap']),
    'legacy local generated state is migrated into the shared offline queue');
  await context.queueMutation('edit', {n: 7, title: 'Curated Sheet idea'}, {editedTitle: 'Local only'});
  assert.equal(context.readQueue().length, queued.length,
    'positive curated Sheet IDs never enter the generated-only Apps Script queue');

  const data = {recos: []};
  context.mergePool(data);
  assert.equal(data.recos.find(row => row.n === -101).valid, 'X',
    'a queued offline decision remains optimistic until the shared write completes');
  assert.equal(data.recos.find(row => row.n === -102).valid, '-',
    'a newer central decision overrides a stale device fallback');
  assert.equal(data.recos.find(row => row.n === -104).valid, '',
    'a newer central pending state clears a stale device validation');

  await context.flushShared();
  assert.equal(context.readQueue().length, 0, 'successful shared writes drain the offline queue');
  assert.deepEqual(new Set(posts.map(item => item.action)), new Set(['decision', 'edit', 'roadmap']),
    'decision, edit and Roadmap migration all use the central upsert endpoint');
  assert.equal(context.effective(-101).roadmapState, 'active',
    'the confirmed Roadmap placement is available from central state after synchronization');
  assert.equal(context.effective(-101).editedTitle, 'Edited by the team',
    'the edited recommendation is available from central state after synchronization');
  assert.equal(context.effective(-102).valid, '-',
    'central state remains authoritative for a recommendation without pending mutations');

  console.log('YouTube shared recommendation state, migration and retry queue: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
