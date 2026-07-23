'use strict';

const fs = require('fs');
const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const start = source.indexOf('function renderRadar(){');
const end = source.indexOf('\nfunction renderWatch(){', start);
if (start < 0 || end < 0) throw new Error('renderRadar function was not found');
const renderRadar = source.slice(start, end);

const forbidden = [
  'ar-coverage-strip',
  'ar-kpi-actions',
  'ar-kpi-action',
  'id="radar-q"',
  "getElementById('radar-q')",
  "keepFocus('radar-q')",
  'Découverte quotidienne par playlists éditoriales',
  '<div class="ar-data-note">',
  'data-radar-filter="distribution"',
  'data-radar-filter="label_advance"',
  'data-radar-filter="catalog_acquisition"',
  'data-radar-filter="verified"',
  'data-radar-filter="needs_listen"',
  'data-radar-filter="contactable"',
];
for (const token of forbidden) {
  if (renderRadar.includes(token)) throw new Error(`Removed A&R UI token is still rendered: ${token}`);
}

for (const required of [
  'id="radar-genre"',
  'id="radar-sort"',
  'id="radar-limit"',
]) {
  if (!renderRadar.includes(required)) throw new Error(`Expected streamlined A&R UI token is missing: ${required}`);
}

console.log('Spotify A&R UI guardrails passed');
