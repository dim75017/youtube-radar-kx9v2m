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
  '<div class="ar-bulkbar">',
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
  'sentinel(filtered.length-rows.length)',
  'attachInfinite(',
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
for (const required of ['arTrackCoverUrl(opportunity)', 'Auditeurs/mois', 'arEditorialCardHtml(opportunity)', 'arGenreVisual(opportunity.genre)']) {
  if (!card.includes(required)) throw new Error(`A&R card data is missing: ${required}`);
}
const identity = card.indexOf('class="ar-opp-main"');
const metrics = card.indexOf('class="ar-opp-metrics"');
const score = card.indexOf('class="ar-score-box"');
const genre = card.indexOf('class="ar-genre-card"');
const editorials = card.indexOf('arEditorialCardHtml(opportunity)');
if (!(score < identity && identity < genre && genre < metrics && metrics < editorials)) {
  throw new Error('A&R card must read score, identity, genre, metrics, then editorials');
}
if (renderRadar.includes("arWorkspaceTabs('radar')") || renderRadar.includes('musiques instrumentales')) {
  throw new Error('A&R opportunity header must not render redundant workspace tabs or subtitle');
}
if (!renderRadar.includes('<h2>Opportunités A&R</h2>')) throw new Error('A&R opportunity header is missing');
if (card.includes('À valider à l’écoute')) throw new Error('Needs-listen must not be shown as a card badge');
if (card.includes('arContactHtml(opportunity,true)')) throw new Error('Platform contacts must stay in the detail sheet, not the A&R card preview');
if (!renderRadar.includes('page-head ar-radar-head') || renderRadar.includes('ar-filter-spacer')) throw new Error('A&R filters must sit compactly under the title on the left');
const editorialCard = source.slice(source.indexOf('function arEditorialCardHtml'), source.indexOf('const AR_PLAYLIST_COVER_CACHE'));
if (editorialCard.includes('${fmtFull(count)}')) throw new Error('Editorial placement count must not occupy the right edge of cards');
for (const required of ['function hydrateArTrackCovers()', 'function arPublicContactChannels(', 'E-mail public à enrichir', 'public_contacts']) {
  if (!source.includes(required)) throw new Error(`A&R public-contact UI is missing: ${required}`);
}

console.log('Spotify A&R UI guardrails passed');
