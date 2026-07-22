'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('spotify/coverage.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

assert.ok(index.indexOf('dashboard.js') < index.indexOf('coverage.js'), 'coverage reporting must run after the dashboard');
assert.match(source, /playlist_discovery_measured/);
assert.match(source, /editorial_artists_total/);
assert.match(source, /catalogue_artists_scanned/);
assert.match(source, /MutationObserver/);
assert.match(source, /candidats à valider sont classés dans Opportunités A&R/);
assert.match(source, /startsWith\('détectée'\)/, 'legacy detected badges must be removed from All tracks');

function element() {
  return {
    textContent: '',
    title: '',
    innerHTML: '',
    dataset: {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentElement() {},
  };
}

const elements = {
  'c-opps': element(),
  'c-art': element(),
  'c-radar': element(),
  'sync-detail-tr': element(),
  view: element(),
};

const document = {
  documentElement: {lang: 'fr'},
  head: {appendChild() {}},
  getElementById(id) { return elements[id] || null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return element(); },
};

const context = {
  console,
  document,
  location: {hash: '#tracks'},
  requestAnimationFrame(callback) { callback(); },
  setTimeout(callback) { callback(); },
  MutationObserver: class { observe() {} },
  R: Array.from({length: 43_265}),
  withTracks: Array.from({length: 1_280}),
  window: {
    SPOTIFY_SOUNDCHARTS: {
      generated_at: '2026-07-22T07:12:22Z',
      tracks: Array.from({length: 2_064}),
      artists: Array.from({length: 1_280}),
      opportunities: Array.from({length: 2_000}),
      playlist_discovery: {
        playlists_scanned: 220,
        unique_playlist_tracks: 16_790,
        unseen_playlist_tracks: 14_732,
        new_playlist_tracks: 450,
        new_catalogue_tracks: 1_200,
        editorial_artists_total: 8_351,
        new_artist_credits: 7_157,
        catalogue_artists_scanned: 250,
      },
      instrumental_pool: {
        measured: 2_140,
        playlist_discovery_measured: 2_135,
        inserted_tracks: 1_207,
      },
      opportunity_scoring: {
        measured_target_tracks: 3_271,
        opportunities: 2_000,
      },
    },
    addEventListener() {},
  },
};

vm.runInNewContext(source, context);

assert.match(elements['c-opps'].title, /43.*265/);
assert.match(elements['c-opps'].title, /3.*271/);
assert.match(elements['c-art'].title, /1.*280/);
assert.match(elements['c-art'].title, /8.*351/);
assert.match(elements['c-radar'].title, /2.*000/);
assert.match(elements['sync-detail-tr'].innerHTML, /220 playlists scannées/);
assert.match(elements['sync-detail-tr'].innerHTML, /16.*790 pistes uniques/);
assert.match(elements['sync-detail-tr'].innerHTML, /2.*135 découvertes mesurées/);

console.log('Spotify discovery coverage reporting: OK');
