'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { assertSpotifyLightBootstrap } = require('./spotify_light_bootstrap_contract');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const spotifyIndex = read('spotify/index.html');
const rootIndex = read('index.html');
const socialSource = read('social-app/app/SocialOS.tsx');
const instantRuntime = read('spotify/instant.js');
const instantSource = read('Spotify_Instant_data.js');
const catalogueSource = read('Spotify_Catalogue_data.js');

assertSpotifyLightBootstrap(spotifyIndex);
assert.match(rootIndex, /Spotify_Instant_data\.js\?v=[A-Za-z0-9._-]+/,
  'the YouTube shell must prefetch the compact Spotify snapshot');
assert.doesNotMatch(rootIndex, /Spotify_Soundcharts_data_[^'"\s]+/,
  'cross-platform navigation must not prefetch a historical Spotify payload');
const youtubeSpotifyHref = rootIndex.match(/href="(spotify\/\?app=[A-Za-z0-9._-]+#opportunities)"/);
const socialsSpotifyHref = socialSource.match(/href="(\.\.\/spotify\/\?app=[A-Za-z0-9._-]+#opportunities)"/);
const selfSpotifyHref = spotifyIndex.match(/href="(\.\/\?app=[A-Za-z0-9._-]+#opportunities)"/);
assert.ok(youtubeSpotifyHref, 'the YouTube switch must open Spotify directly on Opportunities');
assert.ok(socialsSpotifyHref, 'the Socials switch must open Spotify directly on Opportunities');
assert.ok(selfSpotifyHref, 'the Spotify switch itself must return to Opportunities');
const routeSuffix = youtubeSpotifyHref[1].slice('spotify/'.length);
assert.equal(socialsSpotifyHref[1].slice('../spotify/'.length), routeSuffix,
  'YouTube and Socials must use the exact same versioned Spotify route');
assert.equal(selfSpotifyHref[1].slice('./'.length), routeSuffix,
  'the Spotify self-link must use the exact same versioned route');
assert.ok(rootIndex.includes(`"urls":["spotify/${routeSuffix}","social/"]`),
  'YouTube prerender must target the same versioned Opportunities URL as its button');
assert.ok(read('social-app/preview/index.html').includes(`/youtube-radar-kx9v2m/spotify/${routeSuffix}`),
  'Socials prerender must target the same versioned Opportunities URL as its button');
assert.match(instantRuntime, /view:routeToView\[initialRoute\]\|\|'radar'/,
  'an unqualified Spotify URL must default to Opportunities');
assert.match(instantRuntime, /if\(!validViews\.has\(state\.view\)\)state\.view='radar'/,
  'an invalid Spotify route must fail safe to Opportunities');
assert.match(instantRuntime, /window\.addEventListener\('hashchange'/,
  'same-document Spotify navigation must update the rendered section immediately');
assert.match(instantRuntime, /opportunities:'radar'/,
  'the canonical Opportunities route must resolve to the Opportunities view');
assert.match(instantRuntime, /tracks:'opps'/,
  'the explicit Tracks route must remain available without becoming the default');
assert.match(spotifyIndex, /data-v="radar" class="active" data-fr="Opportunités"/,
  'Opportunities must already be active in the initial HTML to avoid a flash of Tracks');
assert.equal((spotifyIndex.match(/class="active"/g) || []).length, 1,
  'only Opportunities may be active before the lightweight runtime starts');

function evaluate(source, globalName) {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { timeout: 5_000 });
  return context.window[globalName];
}

const instant = evaluate(instantSource, 'SPOTIFY_INSTANT');
const catalogue = evaluate(catalogueSource, 'SPOTIFY_CATALOGUE');
for (const payload of [instant, catalogue]) {
  assert.equal(payload.version, 2);
  assert.match(payload.source_hash, /^[a-f0-9]{16}$/);
  assert.ok(payload.schemas && Array.isArray(payload.schemas.tracks));
  assert.ok(payload.counts.tracks >= 1_000);
  assert.ok(payload.counts.artists >= 100);
  assert.ok(payload.counts.playlists >= 100);
  assert.ok(payload.counts.labels >= 100);
}

assert.equal(JSON.stringify(instant.counts), JSON.stringify(catalogue.counts),
  'first paint and hydrated catalogue must describe the same source snapshot');
assert.equal(instant.source_hash, catalogue.source_hash);
assert.ok(instant.tracks.length <= 160 && instant.tracks.length > 0);
assert.ok(instant.radar.length <= 160 && instant.radar.length > 0);
assert.ok(instant.artists.length <= 100 && instant.artists.length > 0);
assert.ok(instant.playlists.length <= 100 && instant.playlists.length > 0);
assert.ok(instant.labels.length <= 100 && instant.labels.length > 0);
assert.equal(catalogue.tracks.length, catalogue.counts.tracks);
assert.equal(catalogue.artists.length, catalogue.counts.artists);
assert.equal(catalogue.playlists.length, catalogue.counts.playlists);
assert.equal(catalogue.labels.length, catalogue.counts.labels);
assert.equal(catalogue.radar.length, catalogue.counts.opportunities);
assert.ok(fs.statSync(path.join(root, 'Spotify_Catalogue_data.js')).size <= 8_000_000,
  'the complete compact catalogue must remain below 8 MB uncompressed');

const criticalFiles = [
  'spotify/index.html',
  'Spotify_Instant_data.js',
  'spotify/instant.js',
  'spotify/instant.css',
  'spotify/dashboard.css',
  'assets/css/radar-foundation.css',
];
const criticalBuffers = criticalFiles.map(relative => fs.readFileSync(path.join(root, relative)));
const criticalRawBytes = criticalBuffers.reduce((total, buffer) => total + buffer.length, 0);
const criticalGzipBytes = criticalBuffers.reduce((total, buffer) => total + zlib.gzipSync(buffer, { level: 9 }).length, 0);
assert.ok(criticalRawBytes <= 350_000,
  `Spotify first-party critical path exceeded 350 KB raw: ${criticalRawBytes}`);
assert.ok(criticalGzipBytes <= 100_000,
  `Spotify first-party critical path exceeded 100 KB gzip: ${criticalGzipBytes}`);
assert.doesNotMatch(instantRuntime, /requestIdleCallback\(hydrate|setTimeout\(hydrate/,
  'the full catalogue must only load after a search or Load more interaction');

console.log(`Spotify instant runtime: ${catalogue.counts.tracks} tracks; ${criticalRawBytes} B raw / ${criticalGzipBytes} B gzip critical path`);
