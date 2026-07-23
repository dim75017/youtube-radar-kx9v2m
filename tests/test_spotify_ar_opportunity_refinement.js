'use strict';

const fs = require('fs');
const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const start = source.indexOf('function renderRadar(){');
const end = source.indexOf('\nfunction renderWatch(){', start);
if (start < 0 || end < 0) throw new Error('renderRadar function was not found');
const renderRadar = source.slice(start, end);

for (const removed of ['Découverte quotidienne par playlists éditoriales', '<div class="ar-data-note">', 'data-radar-filter="distribution"', 'data-radar-filter="label_advance"', 'data-radar-filter="catalog_acquisition"', 'data-radar-filter="verified"', 'data-radar-filter="needs_listen"', 'data-radar-filter="contactable"']) {
  if (renderRadar.includes(removed)) throw new Error(`Removed A&R UI element is still rendered: ${removed}`);
}
for (const required of ['id="radar-genre"', 'id="radar-sort"', 'sentinel(filtered.length-rows.length)', 'attachInfinite(']) {
  if (!renderRadar.includes(required)) throw new Error(`Expected A&R control is missing: ${required}`);
}
for (const required of ['imageUrl:String(scValue(row,schema,\'image_url\')||\'\')', 'function arArtistLinksHtml(opportunity){', 'ar-detail-reason-icon', 'grid-template-columns:repeat(4,minmax(0,1fr))']) {
  if (!(source + css).includes(required)) throw new Error(`Expected A&R refinement is missing: ${required}`);
}
if (renderRadar.includes('ar-player-shell')) throw new Error('The card-list Spotify player must not render');

console.log('Spotify A&R opportunity refinement guardrails passed');
