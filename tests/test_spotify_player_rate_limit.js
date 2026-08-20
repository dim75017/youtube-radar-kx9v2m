'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');

assert.match(dashboard, /const SPOTIFY_OEMBED_MAX_CONCURRENCY=2;/, 'Spotify image requests stay tightly bounded');
assert.match(dashboard, /const SPOTIFY_OEMBED_INFLIGHT=new Map\(\);/, 'duplicate in-flight oEmbed requests are coalesced');
assert.match(dashboard, /const SPOTIFY_OEMBED_TIMEOUT_MS=12000;/, 'stalled image requests have a timeout');
assert.match(dashboard, /response\.status===429/, 'Spotify 429 responses trigger a cooldown');
assert.match(dashboard, /response\.headers\.get\('Retry-After'\)/, 'Spotify Retry-After is respected');
assert.match(dashboard, /function pruneSpotifyOembedObservers\(/, 'detached image nodes are pruned');
assert.match(dashboard, /function spotifyThumbnailWhenVisible\(/, 'missing covers are loaded lazily');
assert.match(dashboard, /function mountSpotifyRadarPlayers\(root\)/, 'custom players share one hydration entrypoint');
assert.doesNotMatch(dashboard, /while \(covActive < 8/, 'legacy request bursts are removed');

const brokerStart = dashboard.indexOf('const SPOTIFY_OEMBED_CACHE=');
const brokerEnd = dashboard.indexOf('function arTrackCoverUrl', brokerStart);
assert.ok(brokerStart >= 0 && brokerEnd > brokerStart, 'oEmbed broker source exists');
const brokerSource = dashboard.slice(brokerStart, brokerEnd)
  .replace('const SPOTIFY_OEMBED_MIN_GAP_MS=450;', 'const SPOTIFY_OEMBED_MIN_GAP_MS=5;')
  .replace('const SPOTIFY_OEMBED_TIMEOUT_MS=12000;', 'const SPOTIFY_OEMBED_TIMEOUT_MS=35;')
  .replaceAll('Math.min(120000,Math.max(2000,', 'Math.min(100,Math.max(5,');

function response(status, thumbnail = '', retryAfter = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {get: name => name === 'Retry-After' ? retryAfter : ''},
    json: async () => ({thumbnail_url: thumbnail}),
  };
}

function makeBroker(fetchImpl) {
  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
  }
  const context = {
    AbortController, Date, Map, Math, Number, Promise, RegExp, Set, String, WeakMap,
    clearTimeout, encodeURIComponent, fetch: fetchImpl, IntersectionObserver: FakeIntersectionObserver, setTimeout,
    arSafePublicUrl: value => String(value || ''), observers,
  };
  vm.runInNewContext(`${brokerSource}\nthis.__broker={thumbnail:spotifyOembedThumbnail,whenVisible:spotifyThumbnailWhenVisible,observers};`, context);
  return context.__broker;
}

(async () => {
  let active = 0, maxActive = 0, fetchCount = 0;
  const broker = makeBroker((url, options = {}) => new Promise((resolve, reject) => {
    fetchCount += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const timer = setTimeout(() => { active -= 1; resolve(response(200, `https://i.scdn.co/${fetchCount}.jpg`)); }, 18);
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); active -= 1; reject(new Error('aborted')); }, {once:true});
  }));
  const resources = [
    'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
    'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
    'https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB',
    'https://open.spotify.com/artist/CCCCCCCCCCCCCCCCCCCCCC',
    'https://open.spotify.com/playlist/DDDDDDDDDDDDDDDDDDDDDD',
  ];
  const values = await Promise.all(resources.map(resource => broker.thumbnail(resource)));
  assert.equal(fetchCount, 4, 'two identical requests share one fetch');
  assert.ok(maxActive <= 2, `concurrency must stay <=2, observed ${maxActive}`);
  assert.equal(values[0], values[1], 'deduplicated callers receive the same result');

  let retryCalls = 0;
  const retryBroker = makeBroker(async () => {
    retryCalls += 1;
    return retryCalls === 1 ? response(429, '', '0.001') : response(200, 'https://i.scdn.co/retry.jpg');
  });
  assert.equal(await retryBroker.thumbnail('https://open.spotify.com/track/EEEEEEEEEEEEEEEEEEEEEE'), 'https://i.scdn.co/retry.jpg');
  assert.equal(retryCalls, 2, 'one 429 is retried exactly once');

  let stalledCalls = 0;
  const timeoutBroker = makeBroker((url, options = {}) => {
    stalledCalls += 1;
    if(stalledCalls > 2) return Promise.resolve(response(200, 'https://i.scdn.co/after-timeout.jpg'));
    return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('timeout')), {once:true}));
  });
  const timeoutValues = await Promise.all([
    timeoutBroker.thumbnail('https://open.spotify.com/track/FFFFFFFFFFFFFFFFFFFFFF'),
    timeoutBroker.thumbnail('https://open.spotify.com/track/GGGGGGGGGGGGGGGGGGGGGG'),
    timeoutBroker.thumbnail('https://open.spotify.com/track/HHHHHHHHHHHHHHHHHHHHHH'),
  ]);
  assert.deepEqual(timeoutValues, ['', '', 'https://i.scdn.co/after-timeout.jpg'], 'stalled requests time out without deadlocking the queue');

  const observerBroker = makeBroker(async () => response(200, 'https://i.scdn.co/visible.jpg'));
  const detached = {isConnected:true};
  const current = {isConnected:true};
  observerBroker.whenVisible(detached, resources[0], () => {});
  detached.isConnected = false;
  observerBroker.whenVisible(current, resources[2], () => {});
  const observer = observerBroker.observers[0];
  assert.equal(observer.targets.has(detached), false, 'detached nodes are unobserved on the next render');
  assert.equal(observer.targets.has(current), true, 'the current node remains observed until visible');

  const closeStart = dashboard.indexOf('function closeTrack(){');
  const closeEnd = dashboard.indexOf('\ndocument.addEventListener', closeStart);
  const closeTrack = dashboard.slice(closeStart, closeEnd);
  assert.match(closeTrack, /clearSpotifyPlayers\(modal\)/, 'closing a track destroys the Spotify player controller');
  console.log('Spotify player rate-limit behavior: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });

