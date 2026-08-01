'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const start = source.indexOf('const VIDEO_HISTORY_CACHE_TTL_MS');
const end = source.indexOf('async function ensureVideoHistory', start);
assert.ok(start >= 0 && end > start, 'lazy history cache helpers must remain available');

let now = 1_000_000;
class ClockDate extends Date {
  static now() { return now; }
}
let fetches = 0;
const responses = [
  { version: 1, updated: 100, d: { abcdefghijk: [[100, 10]] } },
  { version: 1, updated: 200, d: { abcdefghijk: [[100, 10], [200, 20]] } },
];
const context = {
  Date: ClockDate,
  Map,
  fetch: async () => {
    const shard = responses[Math.min(fetches, responses.length - 1)];
    fetches += 1;
    return { ok: true, json: async () => shard };
  },
  mergeDailyVideoHistory: (left, right) => (left || []).concat(right || []),
};
vm.runInNewContext(`${source.slice(start, end)};
  this.loadVideoHistoryShard = loadVideoHistoryShard;
  this.videoHistoryReady = videoHistoryReady;
  this.videoHistoryError = videoHistoryError;
  this.cacheTtl = VIDEO_HISTORY_CACHE_TTL_MS;`, context);

(async () => {
  const first = await context.loadVideoHistoryShard('61');
  const cached = await context.loadVideoHistoryShard('61');
  assert.equal(fetches, 1, 'a freshly validated shard is reused briefly');
  assert.equal(first.updated, 100);
  assert.equal(cached.updated, 100);
  assert.equal(context.videoHistoryReady('abcdefghijk'), true);

  now += context.cacheTtl + 1;
  assert.equal(context.videoHistoryReady('abcdefghijk'), false,
    'an open tab must stop treating an old in-memory shard as current');
  const refreshed = await context.loadVideoHistoryShard('61');
  assert.equal(fetches, 2, 'an expired shard is fetched again with no-store semantics');
  assert.equal(refreshed.updated, 200);
  assert.equal(context.videoHistoryReady('abcdefghijk'), true);

  assert.match(source, /cache:'no-store'/, 'history revalidation bypasses the HTTP cache');
  assert.match(source, /addEventListener\('visibilitychange',refreshVisibleVideoHistory\)/,
    'returning to a sleeping tab revalidates the visible curve');
  console.log('YouTube history cache refresh: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

