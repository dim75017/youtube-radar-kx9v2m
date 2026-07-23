'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const spotify = fs.readFileSync('spotify/dashboard.js', 'utf8');
const spotifyNav = fs.readFileSync('spotify/index.html', 'utf8');
const youtubeNav = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

for (const token of ['AR_LIST_STORAGE', 'function arAddToList(', 'function renderArList(', 'function openArOutreach(', 'function arOutreachDraft(', 'function arMarkContacted(']) {
  assert.ok(spotify.includes(token), `Missing A&R outreach workflow component: ${token}`);
}
for (const token of ['function arAddManyToList(', 'function arToggleSelection(', 'function arSelectVisible(', 'id="ar-select-all"', 'data-ar-select=', "addEventListener('contextmenu'", 'if(arListHas(opportunity.spotifyId)) return false;']) {
  assert.ok(spotify.includes(token), `Missing A&R selection workflow component: ${token}`);
}
assert.match(spotify, /📅 Sortie \$\{esc\(release\)\}/, 'A&R cards must show the release date');
assert.match(spotify, /ar-editorial-cover-link/, 'Editorial playlist covers must be rendered as direct links');
assert.match(spotify, /open\.spotify\.com\/playlist\//, 'Editorial playlist links must open the exact Spotify playlist');
assert.doesNotMatch(spotify, /ar-list-toggle/, 'Selection now uses checkboxes and bulk actions, not a redundant card button');
assert.match(spotify, /arContactEligible\(opportunity\)/, 'Outreach must retain strict contact eligibility');
assert.match(spotify, /function arSelectionEligible\(spotifyId\)/, 'Selection must reuse the strict A&R eligibility gate');
assert.match(spotify, /arOpportunityRows\(\)\.some\(item=>item\.spotifyId===id\)&&arSelectionEligible\(id\)/, 'Bulk selection must reject non-verified tracks');
assert.match(spotify, /rows\.filter\(arContactEligible\)\.map\(item=>item\.spotifyId\)/, 'Select-all must include only contact-eligible tracks');
assert.match(spotify, /filter\(item=>item\.opportunity&&arContactEligible\(item\.opportunity\)\)/, 'The outreach selection must hide legacy non-verified entries');
assert.match(spotify, /mailto:\$\{encodeURIComponent\(currentEmail\)\}/, 'The mail client handoff must remain user initiated');
assert.match(spotify, /aucun e-mail n’est envoyé/i, 'The UI must not imply automatic sending');
assert.match(spotify, /cdn\.simpleicons\.org/, 'Detail contacts must use platform logos rather than emoji');
const cardStart = spotify.indexOf('function arOpportunityCard(');
const cardEnd = spotify.indexOf('\nfunction arScoreLine', cardStart);
assert.doesNotMatch(spotify.slice(cardStart, cardEnd), /arContactHtml\(opportunity,true\)/, 'Card previews must not render contact platforms');
assert.doesNotMatch(spotifyNav, /data-v="watch"/, 'Spotify watchlist navigation must be removed');
assert.match(spotifyNav, /data-v="ar-list" data-fr="Sélection A&R"><span class="emo">⭐<\/span>Sélection A&R/, 'A&R list must be renamed as the star selection');
assert.doesNotMatch(spotifyNav, /Ma liste A&R/, 'The previous A&R list naming must be removed');
assert.doesNotMatch(youtubeNav, /id:'watch'/, 'YouTube watchlist navigation must be removed');

console.log('A&R outreach workflow and watchlist removal: OK');
