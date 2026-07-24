'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const css = fs.readFileSync('spotify/dashboard.css', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');

for (const split of ['50/50', '60/40', '70/30', '80/20', '90/10', '100/0']) {
  assert.match(dashboard, new RegExp(`k:'${split.replace('/', '\\/')}'`));
}
for (const required of [
  'function arSelectionOffer(artistKey)',
  'function arSetSelectionOffer(artistKey,split)',
  'function arArtistStatus(artistKey)',
  'function arMarkArtistContacted(artistKey)',
  'function arCloseArtistDeal(artistKey)',
  'hydrateArArtistAvatars()',
  "data-ar-artist-avatar-id",
  '✓ Message envoyé',
  '✓ Deal conclu',
]) assert.ok(dashboard.includes(required), `Missing artist-selection workflow token: ${required}`);

for (const required of [
  'function arReleaseTypeLabel(opportunity)',
  "return 'Self-release';",
  "return 'Label';",
  'class="ar-selection-release-type"',
]) assert.ok(dashboard.includes(required), `Missing concise release-type token: ${required}`);
assert.ok(!dashboard.includes('arRightsShortLabel('), 'Legacy verbose release label helper must be removed');

assert.ok(!dashboard.includes("draft_ready:'Brouillon prêt'"), 'Draft ready must not remain an artist status');
assert.match(dashboard, /elapsed>=7\*24\*60\*60\*1000/);
assert.match(dashboard, /ar-selection-offers/);
assert.match(dashboard, /const PAYBACK_HORIZONS = \[1,2,3,4,5\]/, 'The estimation horizon must offer 1 to 5 years');
assert.match(dashboard, /paybackYears:2/, 'The default estimation horizon must stay at two years');
assert.match(dashboard, /function setPaybackHorizon\(years\)/, 'Tracks and artists must be able to change the estimation horizon');
assert.match(dashboard, /function arSetSelectionYears\(artistKey,years\)/, 'Each A&R artist must retain an independent estimation horizon');
assert.match(dashboard, /arArtistUpdate\(artistKey,\{offerYears:Number\(years\)\}\)/, 'The A&R horizon must be stored on the artist record');
for (const required of ['.ar-selection-offers', '.ar-status-follow_up', '.ar-artist-deal', '.ar-selection-artist-avatar img']) {
  assert.ok(css.includes(required), `Missing selection workflow style: ${required}`);
}
for (const required of [
  'linear-gradient(135deg,rgba(30,215,96,.13),rgba(34,211,238,.07)',
  'min-height:52px',
  'grid-template-columns:48px minmax(180px,1fr) minmax(172px,.46fr) 132px minmax(330px,.98fr)',
  'grid-column:5;grid-row:1',
]) assert.ok(css.includes(required), `Missing refined artist-selection header style: ${required}`);
const cardStart = dashboard.indexOf('function arSelectionArtistCardHtml(group){');
const cardEnd = dashboard.indexOf('\nfunction arSelectionEconomics(group){', cardStart);
const card = dashboard.slice(cardStart, cardEnd);
assert.ok(card.includes('arSelectionEconomicsHtml(group)'), 'Each artist card must render its own economics section.');
assert.match(index, /dashboard\.js\?v=20260724-selection-metrics-player-v1/);

console.log('spotify selection artist offers/status: OK');
