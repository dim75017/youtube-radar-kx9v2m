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

assert.ok(!dashboard.includes("draft_ready:'Brouillon prêt'"), 'Draft ready must not remain an artist status');
assert.match(dashboard, /elapsed>=7\*24\*60\*60\*1000/);
assert.match(dashboard, /ar-selection-offers/);
for (const required of ['.ar-selection-offers', '.ar-status-follow_up', '.ar-artist-deal', '.ar-selection-artist-avatar img']) {
  assert.ok(css.includes(required), `Missing selection workflow style: ${required}`);
}
assert.match(index, /dashboard\.js\?v=20260724-selection-artist-offers-status-v1/);

console.log('spotify selection artist offers/status: OK');
