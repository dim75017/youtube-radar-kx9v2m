'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const spotify = fs.readFileSync('spotify/dashboard.js', 'utf8');
const spotifyNav = fs.readFileSync('spotify/index.html', 'utf8');
const youtubeNav = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

for (const token of ['AR_LIST_STORAGE', 'function arAddToList(', 'function renderArList(', 'function openArOutreach(', 'function arOutreachDraft(', 'function arMarkContacted(']) {
  assert.ok(spotify.includes(token), `Missing A&R outreach workflow component: ${token}`);
}
for (const token of ['function arAddManyToList(', 'function arToggleSelection(', 'data-ar-select=', "addEventListener('contextmenu'", 'function arOpenContextMenu(', 'if(arListHas(opportunity.spotifyId)) return false;']) {
  assert.ok(spotify.includes(token), `Missing A&R selection workflow component: ${token}`);
}
assert.doesNotMatch(spotify, /id="ar-select-all"/, 'The A&R bulk select-all control must be removed');
assert.match(spotify, /arOpenContextMenu\(card\.dataset\.arCard,event\.clientX,event\.clientY\)/, 'The context menu must open at the click position');
assert.match(spotify, /playlists\.map\(\(playlist,index\)=>/, 'Every editorial playlist must render in the A&R card');
assert.match(spotify, /function arEditorialPlaylistTooltip\(/, 'Each editorial playlist needs a detailed hover tooltip');
assert.match(spotify, /ar-opp-metric release/, 'A&R cards must show the release date with the stream metrics');
assert.match(spotify, /ar-editorial-cover-link/, 'Editorial playlist covers must be rendered as direct links');
assert.match(spotify, /function arOpenEditorialPopover\(/, 'Editorial playlist icons must open a compact popover');
assert.match(spotify, /arOpenEditorialPopover\(this\)/, 'The compact popover must open beside the clicked editorial icon');
const editorialCard = spotify.slice(spotify.indexOf('function arEditorialCardHtml'), spotify.indexOf('const AR_PLAYLIST_COVER_CACHE'));
assert.doesNotMatch(editorialCard, /ar-editorial-names/, 'Editorial playlist names stay out of the compact card');
assert.doesNotMatch(spotify, /ar-list-toggle/, 'Selection now uses checkboxes and bulk actions, not a redundant card button');
assert.match(spotify, /arContactEligible\(opportunity\)/, 'Outreach must retain strict contact eligibility');
assert.match(spotify, /function arSelectionEligible\(spotifyId\)/, 'Selection must reuse the strict A&R eligibility gate');
assert.match(spotify, /arOpportunityRows\(\)\.some\(item=>item\.spotifyId===id\)&&arSelectionEligible\(id\)/, 'Bulk selection must reject non-verified tracks');
assert.match(spotify, /filter\(item=>item\.opportunity&&arContactEligible\(item\.opportunity\)\)/, 'The outreach selection must hide legacy non-verified entries');
assert.match(spotify, /mailto:\$\{encodeURIComponent\(currentEmail\)\}/, 'The mail client handoff must remain user initiated');
assert.match(spotify, /aucun e-mail n’est envoyé/i, 'The UI must not imply automatic sending');
assert.match(spotify, /cdn\.simpleicons\.org/, 'Detail contacts must use platform logos rather than emoji');
assert.match(spotify, /function arPromptArtistCompanions\(spotifyId\)/, 'Adding a track must offer other eligible tracks from the same structured artist');
assert.match(spotify, /function arOutreachDrafts\(opportunity\)/, 'Message preparation exposes multiple draft proposals');
assert.match(spotify, /Préparer un message/, 'Selection cards expose a message-preparation action');
assert.doesNotMatch(spotify, /E-mail public à enrichir|E-mail à enrichir/, 'No email-enrichment placeholder is shown to the user');
const cardStart = spotify.indexOf('function arOpportunityCard(');
const cardEnd = spotify.indexOf('\nfunction arScoreLine', cardStart);
assert.doesNotMatch(spotify.slice(cardStart, cardEnd), /arContactHtml\(opportunity,true\)/, 'Card previews must not render contact platforms');
assert.doesNotMatch(spotifyNav, /data-v="watch"/, 'Spotify watchlist navigation must be removed');
assert.match(spotifyNav, /data-v="ar-list" data-fr="Sélection A&R"><span class="emo">⭐<\/span>Sélection A&R/, 'A&R list must be renamed as the star selection');
assert.match(spotifyNav, /data-v="opps" class="active" data-fr="Pistes"><span class="emo">🎶<\/span>Pistes/, 'Spotify navigation uses the compact tracks label');
assert.match(spotifyNav, /data-v="artists" data-fr="Artistes"><span class="emo">🎸<\/span>Artistes/, 'Spotify navigation uses the compact artists label');
assert.match(spotifyNav, /data-v="playlists" data-fr="Playlists"><span class="emo">📻<\/span>Playlists/, 'Spotify navigation uses the compact playlists label');
assert.match(spotifyNav, /data-v="labels" data-fr="Labels"><span class="emo">🏷️<\/span>Labels/, 'Spotify navigation uses the compact labels label');
assert.doesNotMatch(spotifyNav, /Ma liste A&R/, 'The previous A&R list naming must be removed');
assert.doesNotMatch(youtubeNav, /id:'watch'/, 'YouTube watchlist navigation must be removed');

console.log('A&R outreach workflow and watchlist removal: OK');
