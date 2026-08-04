'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf("const RECO_EDIT_STORAGE_KEY=");
const end = source.indexOf("const CONTINUOUS_RECO_VARIANTS_KEY=", start);
assert.ok(start >= 0 && end > start, 'publication-link helpers must remain extractable');

const stored = new Map();
const timers = [];
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
  DATA: {recos: [
    {n: -1, title: 'Explicit recommendation', genre: 'Lofi', _generated: true},
    {n: -2, title: 'Shared linked', genre: 'Ambient', _generated: true},
    {n: -3, title: 'Exact unique', genre: 'Piano', _generated: true},
    {n: -4, title: 'Duplicate title', genre: 'Jazz', _generated: true},
    {n: -5, title: 'Duplicate title', genre: 'Jazz', _generated: true},
  ]},
  localStorage: {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
  },
  window: {
    LOFI_RECOMMENDATION_POOL: {items: [
      {n: -6, title: 'Internal pool title', genre: 'Classical', _generated: true},
    ]},
    addEventListener() {},
  },
  setTimeout(fn, delay) { timers.push({fn, delay}); return timers.length; },
  clearTimeout() {},
  normalizedRecommendationTitle(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  },
  acceptedRoadmapRows() {
    return [{recoN: -6, title: 'Roadmap exact'}];
  },
};

vm.runInNewContext(`
  const WRITE_URL='https://example.test/exec';
  const WRITE_KEY='test-key';
  let SCHED_LOCAL=[];
  ${source.slice(start, end)}
  this.replaceShared=replaceSharedRecommendationState;
  this.linkPublished=publishedRecommendationLink;
  this.readQueue=sharedRecommendationQueue;
`, context);

context.replaceShared({version: 2, updatedAt: 10, items: [
  {n: -2, title: 'Shared linked', publishedVideoId: 'shared00001', updatedAt: 10},
]}, true);

const explicit = context.linkPublished({vid: 'explicit001', title: 'Anything else', recoN: -1});
assert.equal(explicit.n, -1, 'an explicit Our Videos recoN link has first priority');
assert.equal(explicit.source, 'our-videos-recoN');

const shared = context.linkPublished({vid: 'shared00001', title: 'Unrelated title'});
assert.equal(shared.n, -2, 'a centrally stored publishedVideoId is used before title matching');
assert.equal(shared.source, 'shared-published-id');

const exactVideo = {vid: 'unique00001', title: '  Exact   unique  '};
const exact = context.linkPublished(exactVideo);
assert.equal(exact.n, -3, 'a unique exact normalized title can link a published video');
assert.equal(exact.source, 'exact-unique-title');
assert.equal(exactVideo.recoN, -3, 'an exact match is retained on the in-memory Our Videos row');
context.linkPublished(exactVideo);

assert.equal(context.linkPublished({vid: 'duplicate01', title: 'Duplicate title'}), null,
  'an ambiguous exact title is never linked');
assert.equal(context.linkPublished({vid: 'near0000000', title: 'Exact unique!'}), null,
  'a merely similar title is never linked');

const roadmap = context.linkPublished({vid: 'roadmap0001', title: 'Roadmap exact'});
assert.equal(roadmap.n, -6, 'an exact Roadmap title can resolve an item still present only in the generated pool');
assert.equal(roadmap.source, 'exact-unique-title');

const publishedMutations = context.readQueue().filter(item => item.action === 'published');
assert.deepEqual(publishedMutations.map(item => item.n).sort((a, b) => a - b), [-6, -3, -1],
  'only explicit or unambiguous generated links are queued for shared publication storage');
assert.equal(publishedMutations.filter(item => item.n === -3).length, 1,
  'the same publication link is queued only once');

console.log('YouTube published-video recommendation linking: OK');
