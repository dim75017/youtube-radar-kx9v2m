'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

assert.match(dashboard, /const DISCOVERY_CATALOGUE = SC&&SC\.discovery_catalogue/);
assert.match(dashboard, /function mergeFullDiscoveryCatalogue\(/);
assert.match(dashboard, /mergeFullDiscoveryCatalogue\(\);/);
assert.match(dashboard, /Tout le catalogue/);
assert.match(dashboard, /À mesurer/);
assert.match(dashboard, /Présentes en playlist éditoriale/);
assert.match(dashboard, /function arEditorialPlaylistEvidenceHtml\(/);
assert.match(dashboard, /Pourquoi cette musique est dans la liste/);
assert.match(dashboard, /Présence en playlists éditoriales/);
assert.match(dashboard, /firstSeen:/);
assert.match(dashboard, /function spotifyTrackEmbedHtml\(/);
assert.match(dashboard, /spotifyTrackEmbedHtml\(r\[6\],r\[1\],'track-modal-player'\)/);
assert.match(dashboard, /function trackEditorialEvidenceHtml\(/);
assert.match(dashboard, /trackEditorialEvidenceHtml\(r\)/);
assert.match(dashboard, /editorialPlaylists/);
assert.match(dashboard, /playlistNames/);
const radarStart = dashboard.indexOf('function renderRadar(){');
const radarEnd = dashboard.indexOf('function renderWatch(){', radarStart);
assert.ok(radarStart >= 0 && radarEnd > radarStart, 'A&R render section must exist');
assert.doesNotMatch(dashboard.slice(radarStart, radarEnd), /id="radar-q"/, 'A&R search bar stays removed');
assert.doesNotMatch(
  dashboard.slice(dashboard.indexOf('function renderOpps(){'), dashboard.indexOf('function renderArtists(){')),
  /T\('détectée'\)/,
  'Toutes les pistes must not restore the obsolete detected badge',
);
assert.match(coverage, /Catalogue complet disponible/);
assert.match(coverage, /pistes disponibles/);
assert.match(index, /discovery\.css\?v=20260722-full-catalogue-v2/);
assert.match(index, /dashboard\.js\?v=20260722-full-catalogue-v2/);
assert.match(index, /coverage\.js\?v=20260722-full-catalogue-v2/);
console.log('spotify full discovery catalogue guardrails: OK');
