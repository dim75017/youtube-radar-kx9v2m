'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

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
  'function arArtistStage(status)',
  'function arSetArtistStatus(artistKey,status)',
  'function arMarkArtistContacted(artistKey)',
  'function arStartArtistNegotiation(artistKey)',
  'function arValidateArtist(artistKey)',
  'function arRefuseArtist(artistKey)',
  'function arResetArtistStatus(artistKey)',
  'hydrateArArtistAvatars()',
  "data-ar-artist-avatar-id",
  '✓ Message envoyé',
  'Passer en négociation',
  '✓ Valider',
  'aria-label="${esc(refuseLabel)}"',
  'aria-label="Retirer ${esc(opportunity.title)} de la sélection"',
]) assert.ok(dashboard.includes(required), `Missing artist-selection workflow token: ${required}`);

for (const required of [
  'function arReleaseTypeLabel(opportunity)',
  "return 'Self-release';",
  "return 'Label';",
]) assert.ok(dashboard.includes(required), `Missing concise release-type token outside Selection: ${required}`);
const selectionTrackStart = dashboard.indexOf('function arSelectionTrackHtml(');
const selectionTrackEnd = dashboard.indexOf('\nfunction arOpenSelectionArtistProfile', selectionTrackStart);
const selectionTrack = dashboard.slice(selectionTrackStart, selectionTrackEnd);
assert.ok(selectionTrackStart >= 0 && selectionTrackEnd > selectionTrackStart, 'Selection track renderer must remain defined.');
assert.ok(!selectionTrack.includes('arReleaseTypeLabel('), 'Selection must not repeat the release type when the workflow already contains only self-releases.');
assert.ok(!selectionTrack.includes('ar-selection-release-type'), 'Selection must not render a redundant Self-release badge.');
assert.ok(!css.includes('.ar-selection-release-type'), 'Removed Selection release-type badge styles must not remain.');
assert.ok(!dashboard.includes('arRightsShortLabel('), 'Legacy verbose release label helper must be removed');

assert.ok(!dashboard.includes("draft_ready:'Brouillon prêt'"), 'Draft ready must not remain an artist status');
assert.match(dashboard, /elapsed>=7\*24\*60\*60\*1000/);
assert.match(dashboard, /if\(stored==='closed'\)return 'validated'/, 'Legacy closed deals must migrate to Validé.');
for (const stage of ['to_contact', 'contacted', 'negotiating', 'validated', 'refused']) {
  assert.match(dashboard, new RegExp(`key:'${stage}'`), `Missing negotiation stage ${stage}`);
}
for (const emoji of ['📭', '📨', '🤝', '✅', '❌']) {
  assert.ok(dashboard.includes(`emoji:'${emoji}'`), `Missing stage emoji ${emoji}`);
}
assert.match(dashboard, /ar-selection-offers/);
assert.match(dashboard, /const PAYBACK_HORIZONS = \[1,2,3,4,5\]/, 'The estimation horizon must offer 1 to 5 years');
assert.match(dashboard, /paybackYears:2/, 'The default estimation horizon must stay at two years');
assert.match(dashboard, /function setPaybackHorizon\(years\)/, 'Tracks and artists must be able to change the estimation horizon');
assert.match(dashboard, /function arSetSelectionYears\(artistKey,years\)/, 'Each A&R artist must retain an independent estimation horizon');
assert.match(dashboard, /arArtistUpdate\(artistKey,\{offerYears:Number\(years\)\}\)/, 'The A&R horizon must be stored on the artist record');
for (const required of ['.ar-selection-offers', '.ar-selection-stage-tabs', '.ar-stage-emoji', '.ar-workflow-action', '.ar-trash-action', '.ar-selection-artist-avatar img']) {
  assert.ok(css.includes(required), `Missing selection workflow style: ${required}`);
}
for (const required of [
  'linear-gradient(135deg,rgba(30,215,96,.13),rgba(34,211,238,.07)',
  'min-height:52px',
  '.ar-artist-selection-head{padding:15px 16px}',
  'background:rgba(251,113,133,.035)',
  '.ar-trash-action:focus-visible',
]) assert.ok(css.includes(required), `Missing refined artist-selection header style: ${required}`);
assert.ok(!css.includes('background:rgba(190,24,93,.82)'), 'Selection trash actions must not use the aggressive solid red background.');
const cardStart = dashboard.indexOf('function arSelectionArtistCardHtml(group){');
const cardEnd = dashboard.indexOf('\nfunction arSelectionEconomics(group){', cardStart);
const card = dashboard.slice(cardStart, cardEnd);
assert.ok(card.includes('openArSelectionEstimate'), 'Each artist card must expose the estimate button.');
assert.ok(card.includes('arSelectionWorkflowActionsHtml(artist.key,status,artist.name)'), 'Artist actions must receive the artist name for an explicit accessible label.');
assert.ok(!card.includes('arSelectionEconomicsHtml(group)'), 'Financial estimates must not render inline in Selection.');
assert.ok(!card.includes('arSelectionStatusHtml'), 'Artist cards must not repeat the top-level workflow status.');
assert.ok(!dashboard.includes('function arSelectionStatusHtml'), 'The redundant per-card status renderer must be removed.');
assert.ok(!dashboard.includes('Suivi de la prise de contact et de la négociation, par artiste.'), 'The redundant Selection subtitle must be removed.');
const modalStart = dashboard.indexOf('function openArSelectionEstimate(artistKey){');
const modalEnd = dashboard.indexOf('\nfunction renderArList(){', modalStart);
const modal = dashboard.slice(modalStart, modalEnd);
assert.ok(modal.includes('arSelectionEconomicsHtml(group)'), 'Financial estimates must render in the dedicated modal.');
assert.ok(modal.includes("document.getElementById('estimate-body')"), 'The estimate modal must target its dedicated body.');
assert.ok(modal.includes("style.display='flex'"), 'The estimate modal must open from the button.');
const composerStart = dashboard.indexOf('function openArOutreach(spotifyId){');
const composerEnd = dashboard.indexOf('\nfunction arSelectionPrimaryArtist(opportunity){', composerStart);
const composer = dashboard.slice(composerStart, composerEnd);
assert.ok(composer.includes('arSelectionEconomicsHtml(group)'), 'Financial estimates must also render inside Préparer le message.');
assert.ok(composer.includes('id="ar-composer-economics"'), 'The composer estimate must have a targeted refresh container.');
assert.match(dashboard, /function arRefreshComposerEconomics\(artistKey\)/, 'Offer changes must refresh the composer estimate without rebuilding the message.');
assert.match(dashboard, /arRefreshComposerEconomics\(artistKey\)/, 'Artist-specific offer and horizon setters must refresh the open composer.');
assert.match(index, /id="estimate-modal"/);
assert.match(index, /id="estimate-body"/);
const paybackStart = dashboard.indexOf('function selectionPaybackTxt(months){');
const paybackEnd = dashboard.indexOf('\nfunction paybackClass(months){', paybackStart);
const context = {T:value=>value};
vm.runInNewContext(dashboard.slice(paybackStart, paybackEnd), context);
assert.equal(context.selectionPaybackTxt(1.9*12), '2 ans', '1.9 years must display as 2 whole years in Selection.');
assert.equal(context.selectionPaybackTxt(2.8*12), '3 ans', '2.8 years must display as 3 whole years in Selection.');
assert.ok(dashboard.slice(dashboard.indexOf('function arSelectionEconomicsHtml(group){'), modalStart).includes('selectionPaybackTxt(economics.payback)'), 'Selection must use the whole-year formatter.');
assert.match(index, /dashboard\.js\?v=20260821-web-playback-v1/);

console.log('spotify selection artist offers/status: OK');
