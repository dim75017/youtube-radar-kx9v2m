'use strict';

const fs = require('fs');
const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const start = source.indexOf('function renderRadar(){');
const end = source.indexOf('\nfunction renderWatch(){', start);
if (start < 0 || end < 0) throw new Error('renderRadar function was not found');
const renderRadar = source.slice(start, end);

const forbidden = [
  'ar-coverage-strip',
  'ar-kpi-actions',
  'ar-kpi-action',
  '<div class="ar-bulkbar">',
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
  'arGenreSelectHtml(genres)',
  'id="radar-q"',
  "getElementById('radar-q')",
  "keepFocus('radar-q')",
  'data-ar-sort',
  'sentinel(filtered.length-rows.length)',
  'attachInfinite(',
]) {
  if (!renderRadar.includes(required)) throw new Error(`Expected streamlined A&R UI token is missing: ${required}`);
}
for (const required of ["['score','Note']", "['artist','Artiste']", "['recent','Sortie']", "['genre','Genre']", "['streams','Streams total']", "['streams30','30 jours']", "['streams7','7 jours']", "['momentum','24 heures']", "['listeners','Auditeurs/mois']", "['editorial','Éditoriales']"]) {
  if (!source.includes(required)) throw new Error(`Expected A&R sort button is missing: ${required}`);
}
for (const required of ['ar-selection-float', 'id="ar-add-selected"', "arAddManyToList(arSelectedIds())"]) {
  if (!renderRadar.includes(required)) throw new Error(`A&R bulk-selection action is missing: ${required}`);
}
if (renderRadar.includes('id="radar-sort"')) throw new Error('A&R sort must use the clickable sort bar, not a dropdown');

const cardStart = source.indexOf('function arOpportunityCard(');
const cardEnd = source.indexOf('\nfunction arScoreLine', cardStart);
if (cardStart < 0 || cardEnd < 0) throw new Error('A&R opportunity card function was not found');
const card = source.slice(cardStart, cardEnd);
for (const removed of ['ar-score-confidence', 'ar-open-detail', 'Pourquoi ?']) {
  if (card.includes(removed)) throw new Error(`Removed A&R score control is still rendered: ${removed}`);
}
for (const required of ['arTrackCoverUrl(opportunity)', 'ar-release-card', 'ar-opp-metric listeners', 'arEditorialCardHtml(opportunity)', 'arGenreVisual(opportunity.genre)']) {
  if (!card.includes(required)) throw new Error(`A&R card data is missing: ${required}`);
}
for (const required of [
  '.ar-columnbar{display:grid',
  '.ar-opportunity-card{grid-template-columns:46px 46px',
  '.ar-opp-metrics{display:contents}',
  '.ar-opp-metric .l{display:none}',
]) {
  if (!css.includes(required)) throw new Error(`A&R genre/editorial alignment is missing: ${required}`);
}
const filteredStart = source.indexOf('function arOpportunityFiltered(all){');
const filteredEnd = source.indexOf('\nfunction arOpportunityCard', filteredStart);
if (filteredStart < 0 || filteredEnd < 0) throw new Error('A&R sorting function was not found');
const filtered = source.slice(filteredStart, filteredEnd);
for (const required of [
  "S.radarSort==='artist'",
  "S.radarSort==='genre'",
  "S.radarSort==='streams3'",
  "S.radarSort==='streams6'",
  "S.radarSort==='streams30'",
  "S.radarSort==='streams7'",
  'arOpportunityMetric(b,3)',
  'arOpportunityMetric(b,6)',
  'const direction=S.radarSortDir===1?1:-1;',
  'const number=(left,right)=>',
  'rows.sort(compare);',
]) {
  if (!filtered.includes(required)) throw new Error(`Expected A&R sort behavior is missing: ${required}`);
}
if (!source.includes('function arOpportunitySortDefaultDir(sort)')) throw new Error('A&R sort direction helper is missing');
const detailStart = source.indexOf('function openArOpportunity(spotifyId){');
const detailEnd = source.indexOf('\nfunction renderRadar(){', detailStart);
if (detailStart < 0 || detailEnd < 0) throw new Error('A&R opportunity detail function was not found');
const detail = source.slice(detailStart, detailEnd);
for (const required of ['<div class="l">Genre</div>', 'arOpportunityPlayerHtml(opportunity)', 'arDetailEditorialPlaylistsHtml(opportunity)', 'arReleaseTypeLabel(opportunity)', 'tgrid ar-detail-facts']) {
  if (!detail.includes(required)) throw new Error(`A&R detail fact is missing: ${required}`);
}
if (!source.includes("spotifyTrackEmbedHtml(spotifyId,opportunity.title,'ar-opportunity-player')")) throw new Error('A&R detail player must use the embedded Spotify player.');
for (const removed of ['arOpportunityCoverPlayerHtml(opportunity)', 'Pourquoi cette musique est dans la liste', "reasonsSection.querySelector('h4')", 'ar-detail-facts ar-detail-reasons']) {
  if (detail.includes(removed)) throw new Error(`A&R detail must not retain the old player/reasons UI: ${removed}`);
}
if (!source.includes('function arDetailEditorialPlaylistsHtml(opportunity)')) throw new Error('A&R detail must render editorial playlists with their own compact cards');
for (const removed of ['Score track', 'E-mail professionnel & plateformes', 'Label / distributeur']) {
  if (detail.includes(removed)) throw new Error(`Removed A&R detail block is still rendered: ${removed}`);
}
const closeStart = source.indexOf('function closeArModal(){');
const closeEnd = source.indexOf('\nfunction openArMessage', closeStart);
const close = source.slice(closeStart, closeEnd);
for (const required of ["iframe[src*=\"open.spotify.com/embed/\"]", "player.src='about:blank'", 'player.remove()']) {
  if (!close.includes(required)) throw new Error(`Closing the A&R modal must stop the embedded player: ${required}`);
}
const identity = card.indexOf('class="ar-opp-main"');
const metrics = card.indexOf('class="ar-opp-metrics"');
const score = card.indexOf('class="ar-score-box"');
const release = card.indexOf('class="ar-release-card"');
const genre = card.indexOf('class="ar-genre-card"');
const editorials = card.indexOf('arEditorialCardHtml(opportunity)');
if (!(score < identity && identity < release && release < genre && genre < metrics && metrics < editorials)) {
  throw new Error('A&R card must read score, identity, release, genre, metrics, then editorials');
}
if (renderRadar.includes("arWorkspaceTabs('radar')") || renderRadar.includes('musiques instrumentales')) {
  throw new Error('A&R opportunity header must not render redundant workspace tabs or subtitle');
}
if (!renderRadar.includes('<h2>Opportunités</h2>')) throw new Error('Opportunity header is missing');
if (!renderRadar.includes('arColumnBarHtml()') || renderRadar.includes('arSortBarHtml()')) throw new Error('A&R sorting must use the integrated column bar');
if (card.includes('À valider à l’écoute')) throw new Error('Needs-listen must not be shown as a card badge');
if (card.includes('arContactHtml(opportunity,true)')) throw new Error('Platform contacts must stay in the detail sheet, not the A&R card preview');
for (const label of ['<div class="l">Sortie</div>', '<div class="l">Streams total</div>', '<div class="l">30 jours</div>', '<div class="l">7 jours</div>', '<div class="l">24 heures</div>', '<div class="l">Auditeurs/mois</div>']) {
  if (card.includes(label)) throw new Error(`A&R card metric label must live only in the column bar: ${label}`);
}
if (!renderRadar.includes('page-head ar-radar-head') || renderRadar.includes('ar-filter-spacer') || !renderRadar.includes('ar-filterbar-simple') || renderRadar.includes('ar-filter-section')) throw new Error('A&R keeps only the compact genre filter under the title');
const editorialCard = source.slice(source.indexOf('function arEditorialCardHtml'), source.indexOf('const AR_PLAYLIST_COVER_CACHE'));
if (editorialCard.includes('${fmtFull(count)}')) throw new Error('Editorial placement count must not occupy the right edge of cards');
for (const required of ['function hydrateArTrackCovers()', 'function arPublicContactChannels(', 'arOutreachDrafts(', 'public_contacts']) {
  if (!source.includes(required)) throw new Error(`A&R public-contact UI is missing: ${required}`);
}
if (source.includes('E-mail public à enrichir') || source.includes('E-mail à enrichir')) throw new Error('A&R must not display email-enrichment placeholders');

console.log('Spotify A&R UI guardrails passed');
