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

const cardStart = source.indexOf('function arOpportunityCard(');
const cardEnd = source.indexOf('\nfunction arScoreLine', cardStart);
if (cardStart < 0 || cardEnd < 0) throw new Error('A&R opportunity card function was not found');
const card = source.slice(cardStart, cardEnd);
for (const removed of ['ar-score-confidence', 'ar-open-detail', 'Pourquoi ?']) {
  if (card.includes(removed)) throw new Error(`Removed A&R score control is still rendered: ${removed}`);
}
for (const required of ['arTrackCoverUrl(opportunity)', 'Auditeurs/mois', 'arContactHtml(opportunity,true)']) {
  if (!card.includes(required)) throw new Error(`A&R card data is missing: ${required}`);
}
for (const required of ['function hydrateArTrackCovers()', 'function arPublicContactChannels(', 'E-mail public à enrichir', 'public_contacts']) {
  if (!source.includes(required)) throw new Error(`A&R public-contact UI is missing: ${required}`);
}

console.log('Spotify A&R UI guardrails passed');
