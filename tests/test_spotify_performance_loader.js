const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'Spotify_Performance_loader.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'spotify', 'index.html'), 'utf8');

function shard(bucket, tracks) {
  return 'window.SPOTIFY_PERFORMANCE_TRACK_SHARD=' + JSON.stringify({version: 1, bucket, tracks}) +
    ';window.SPOTIFY_PERFORMANCE=window.SPOTIFY_PERFORMANCE||{};' +
    'window.SPOTIFY_PERFORMANCE.tracks=window.SPOTIFY_PERFORMANCE.tracks||{};' +
    'Object.assign(window.SPOTIFY_PERFORMANCE.tracks,window.SPOTIFY_PERFORMANCE_TRACK_SHARD.tracks||{});' +
    'window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED=window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED||{};' +
    'window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED[window.SPOTIFY_PERFORMANCE_TRACK_SHARD.bucket]=' +
    'Object.keys(window.SPOTIFY_PERFORMANCE_TRACK_SHARD.tracks||{}).length;';
}

function load({missingBucket = null} = {}) {
  const scripts = {
    '../Spotify_Performance_tracks/tracks-00-a.js?v=aaaaaaaaaaaaaaaa': shard(0, {
      'track-a': {history: [['2026-07-30', 1], ['2026-07-31', 2]]},
    }),
    '../Spotify_Performance_tracks/tracks-01-b.js?v=bbbbbbbbbbbbbbbb': shard(1, {
      'track-b': {history: [['2026-07-30', 5], ['2026-07-31', 8]]},
    }),
  };
  const context = vm.createContext({
    window: {
      SPOTIFY_PERFORMANCE: {
        tracks: {
          'track-a': {history: [['2026-07-31', 2]]},
          'track-b': {history: [['2026-07-31', 8]]},
        },
        freshness: {tracks_catalogue_at: '2026-07-31T10:00:00Z'},
        track_shards: {
          version: 1,
          shard_count: 2,
          tracks_total: 2,
          shards: [
            {bucket: 0, path: 'Spotify_Performance_tracks/tracks-00-a.js', sha256: 'a'.repeat(64), tracks: 1},
            {bucket: 1, path: 'Spotify_Performance_tracks/tracks-01-b.js', sha256: 'b'.repeat(64), tracks: 1},
          ],
        },
      },
    },
  });
  context.document = {
    write(html) {
      const src = html.match(/^<script src="([^"]+)"><\/script>$/);
      if (src) {
        const bucket = src[1].includes('tracks-00-') ? 0 : 1;
        if (bucket !== missingBucket && scripts[src[1]]) vm.runInContext(scripts[src[1]], context);
        return;
      }
      const inline = html.match(/^<script>([\s\S]*)<\/script>$/);
      if (inline) vm.runInContext(inline[1], context);
    },
  };
  vm.runInContext(loader, context);
  return context.window;
}

const complete = load();
assert.strictEqual(complete.SPOTIFY_PERFORMANCE_STORE_READY, true);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(complete.SPOTIFY_PERFORMANCE.tracks['track-a'].history)),
  [['2026-07-30', 1], ['2026-07-31', 2]],
);

const incomplete = load({missingBucket: 1});
assert.strictEqual(incomplete.SPOTIFY_PERFORMANCE_STORE_READY, false);
assert.strictEqual(incomplete.SPOTIFY_PERFORMANCE.freshness.tracks_catalogue_at, null);
assert.match(incomplete.SPOTIFY_PERFORMANCE_STORE_ERROR, /incomplete/i);

assert.ok(
  index.indexOf('Spotify_Performance_loader.js') < index.indexOf('dashboard.js'),
  'the manifest loader must finish before dashboard.js snapshots PERF_TRACKS',
);

console.log('spotify performance loader tests passed');
