'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const recommendationSource = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const helperSource = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

const editStart = recommendationSource.indexOf("const RECO_EDIT_STORAGE_KEY=");
const editEnd = recommendationSource.indexOf('function legacyFilterRecos(', editStart);
assert.ok(editStart >= 0 && editEnd > editStart,
  'recommendation edit persistence helpers must remain available');

const storageKey = 'lofi_radar_recommendation_edits_v1';
const saved = new Map([
  [storageKey, JSON.stringify({
    7: {
      title: 'Retouched title',
      concept: 'Retouched idea description',
      desc: 'Retouched YouTube description',
      updatedAt: 123,
    },
  })],
]);
const editContext = {
  JSON,
  String,
  Array,
  localStorage: {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
  },
};
vm.runInNewContext(`${recommendationSource.slice(editStart, editEnd)};
  this.readEdits = recommendationEdits;
  this.saveEdits = saveRecommendationEdits;
  this.applyEdits = applyRecommendationEdits;`, editContext);

const data = {
  recos: [
    {n: 7, title: 'Original title', concept: 'Original concept', desc: 'Original description'},
    {n: 8, title: 'Untouched title', concept: 'Untouched concept', desc: 'Untouched description'},
  ],
};
assert.equal(editContext.applyEdits(data), data, 'the edit overlay preserves the loaded data object');
assert.deepEqual(
  {
    title: data.recos[0].title,
    concept: data.recos[0].concept,
    desc: data.recos[0].desc,
    edited: data.recos[0]._locallyEdited,
  },
  {
    title: 'Retouched title',
    concept: 'Retouched idea description',
    desc: 'Retouched YouTube description',
    edited: true,
  },
  'the persisted overlay restores title and both description fields after a reload',
);
assert.equal(data.recos[1].title, 'Untouched title', 'recommendations without an edit remain unchanged');

editContext.saveEdits({9: {title: 'Another title', concept: '', desc: 'Another description'}});
assert.deepEqual(
  JSON.parse(saved.get(storageKey)),
  {9: {title: 'Another title', concept: '', desc: 'Another description'}},
  'recommendation edits are serialized to their dedicated localStorage key',
);

const setDataStart = helperSource.indexOf('function setRadarData(d){');
const setDataEnd = helperSource.indexOf('const VS=', setDataStart);
assert.ok(setDataStart >= 0 && setDataEnd > setDataStart,
  'the central radar-data setter must remain available');
const hookContext = {
  Map,
  hookCalls: 0,
  eligibleNewVideoRows: rows => rows || [],
  removeUnavailableVideoRows: loaded => loaded,
  applyRecommendationEdits: loaded => {
    hookContext.hookCalls += 1;
    loaded.recos[0].title = 'Applied by setRadarData';
  },
  mergeLoadedVideoHistoryIntoData() {},
  scheduleViewWarmup() {},
  refreshUpdateStatus() {},
};
vm.runInNewContext(`
  let DATA=null;
  const VIEW_CACHE=new Map([['stale', true]]);
  let VIEW_WARMUP_TOKEN=0;
  let _anaCache='stale',_anaT=1;
  ${helperSource.slice(setDataStart, setDataEnd)}
  this.runSetRadarData=setRadarData;
  this.readData=()=>DATA;
  this.readCacheSize=()=>VIEW_CACHE.size;
`, hookContext);

const loaded = {news: [], recos: [{n: 7, title: 'Fresh Sheet title'}]};
hookContext.runSetRadarData(loaded);
assert.equal(hookContext.hookCalls, 1, 'setRadarData applies the recommendation edit overlay exactly once');
assert.equal(hookContext.readData().recos[0].title, 'Applied by setRadarData',
  'local edits are applied before the freshly loaded data becomes active');
assert.equal(hookContext.readCacheSize(), 0, 'applying edits still invalidates rendered view caches');

const editorStart = recommendationSource.indexOf('function openRecoEditor(');
const editorEnd = recommendationSource.indexOf('function recoActions(', editorStart);
const editor = recommendationSource.slice(editorStart, editorEnd);
for (const required of [
  'reco-edit-title',
  'reco-edit-concept',
  'reco-edit-desc',
  'function saveRecoEditor(',
  'saveRecommendationEdits(edits)',
]) {
  assert.ok(editor.includes(required), 'Missing recommendation editor behavior: ' + required);
}

console.log('YouTube recommendation edit persistence: OK');
