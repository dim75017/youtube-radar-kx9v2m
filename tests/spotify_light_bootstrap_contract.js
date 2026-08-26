'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const instantRuntime = fs.readFileSync(path.join(root, 'spotify', 'instant.js'), 'utf8');

const HEAVY_BOOTSTRAP_ASSETS = [
  'Spotify_Radar_data.js',
  'Spotify_Labels_data.js',
  'Spotify_Playlist_Covers_data.js',
  'Spotify_Playlists_canonical_data.js',
  'Spotify_Soundcharts_data_',
  'Spotify_Browse_Catalogue_data.js',
  'Spotify_Selection_Contacts_data.js',
  'Spotify_Performance_data.js',
  'Spotify_Preview_Audio_data.js',
  'Spotify_Performance_loader.js',
  'player.js',
  'dashboard.js',
  'coverage.js',
];

function assertSpotifyLightBootstrap(index) {
  const scriptSources = Array.from(
    index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi),
    match => match[1],
  );
  assert.equal(scriptSources.length, 2,
    `Spotify first paint must execute exactly two scripts, found: ${scriptSources.join(', ')}`);
  assert.match(scriptSources[0], /^\.\.\/Spotify_Instant_data\.js\?v=[A-Za-z0-9._-]+$/,
    'the compact first-paint snapshot must load first with a stable cache-busted URL');
  assert.match(scriptSources[1], /^instant\.js\?v=[A-Za-z0-9._-]+$/,
    'the lightweight renderer must load immediately after the compact snapshot');
  assert.match(index, /<link\s+rel="preload"\s+as="script"\s+href="\.\.\/Spotify_Instant_data\.js\?v=[A-Za-z0-9._-]+">/,
    'the only first-paint data payload must be preloaded');

  for (const asset of HEAVY_BOOTSTRAP_ASSETS) {
    assert.equal(index.includes(asset), false,
      `${asset} must stay out of the Spotify critical rendering path`);
    assert.equal(instantRuntime.includes(asset), false,
      `${asset} must not be reintroduced by the lightweight renderer`);
  }

  assert.match(instantRuntime, /window\.SPOTIFY_LIGHT_RUNTIME_READY=true/,
    'the lightweight renderer must expose an explicit interactive-ready signal');
  assert.doesNotMatch(instantRuntime, /requestIdleCallback\(hydrate|setTimeout\(hydrate/,
    'the complete catalogue must never hydrate automatically, including during prerender');
  assert.doesNotMatch(index, /Spotify_Catalogue_data\.js/,
    'the complete catalogue must stay outside the initial document');
  assert.doesNotMatch(index, /track-analytics\.js|player\.js/,
    'track analytics and audio transport must remain lazy assets');
  assert.match(instantRuntime, /function loadTrackAnalytics\(\)/,
    'the lightweight renderer must expose the user-triggered analytics loader');
  assert.match(instantRuntime, /function loadTrackAnalytics\(\)\{return loadAnalytics\('Track'\);\}/,
    'opening a track must use the shared lazy analytical renderer loader');
  assert.match(instantRuntime, /\$\{name\}-analytics\.js\?v=/,
    'lazy analytical renderers must use stable versioned URLs');

  const instantDataBytes = fs.statSync(path.join(root, 'Spotify_Instant_data.js')).size;
  const instantRuntimeBytes = fs.statSync(path.join(root, 'spotify', 'instant.js')).size;
  const criticalJavaScriptBytes = instantDataBytes + instantRuntimeBytes;
  assert.ok(instantDataBytes <= 200_000,
    `Spotify first-paint data budget exceeded: ${instantDataBytes} bytes > 200000`);
  // Dashboard is now the first view and renders from the same compact snapshot,
  // without a third request or catalogue hydration. Keep its complete renderer
  // inside a measured 65 kB envelope while the combined JavaScript cap stays strict.
  assert.ok(instantRuntimeBytes <= 65_000,
    `Spotify lightweight runtime budget exceeded: ${instantRuntimeBytes} bytes > 65000`);
  assert.ok(criticalJavaScriptBytes <= 225_000,
    `Spotify critical JavaScript budget exceeded: ${criticalJavaScriptBytes} bytes > 225000`);
}

module.exports = { assertSpotifyLightBootstrap };
