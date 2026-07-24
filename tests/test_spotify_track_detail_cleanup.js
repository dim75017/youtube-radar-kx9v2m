'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '..', 'spotify', 'dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'spotify', 'dashboard.css'), 'utf8');
const trackStart = js.indexOf('function openTrack(tid)');
const trackEnd = js.indexOf('function openTrackFromCatalogueRow', trackStart);
assert.ok(trackStart >= 0 && trackEnd > trackStart, 'track detail renderer must remain available');
const trackDetail = js.slice(trackStart, trackEnd);

assert.doesNotMatch(js, /spotify-centered-toggle/, 'the oversized centered player control must not be rendered');
assert.doesNotMatch(css, /spotify-centered-toggle/, 'the centered player control styles must be removed');
assert.doesNotMatch(trackDetail, /Vélocité réelle|Cadence|Signal performance/, 'track details keep only useful metadata');
assert.match(trackDetail, /T\('Sortie'\)/, 'release date remains visible in track details');
console.log('Spotify track detail cleanup checks passed.');
