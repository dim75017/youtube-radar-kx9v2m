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
assert.match(spotify, /ar-release-card/, 'A&R cards must show the release date before the genre column');
assert.match(spotify, /ar-editorial-cover-link/, 'Editorial playlist covers must be rendered as direct links');
assert.match(spotify, /function arOpenEditorialPopover\(/, 'Editorial playlist icons must open a compact popover');
assert.match(spotify, /arOpenEditorialPopover\(this\)/, 'The compact popover must open beside the clicked editorial icon');
assert.match(spotify, /ar-editorial-popover-title/, 'Editorial popovers must show the playlist name prominently');
assert.doesNotMatch(spotify, /open\.spotify\.com\/oembed\?url=\$\{encodeURIComponent\(spotifyPlaylistUrl\(id\)\)\}/, 'Editorial playlist covers must never trigger one Spotify oEmbed request per icon');
const editorialCard = spotify.slice(spotify.indexOf('function arEditorialCardHtml'), spotify.indexOf('const AR_PLAYLIST_COVER_CACHE'));
assert.doesNotMatch(editorialCard, /ar-editorial-names/, 'Editorial playlist names stay out of the compact card');
assert.doesNotMatch(spotify, /ar-list-toggle/, 'Selection now uses checkboxes and bulk actions, not a redundant card button');
assert.match(spotify, /function arCompanionSignalsHtml\(/, 'Artist companion choices must expose stream metrics and editorial placements');
assert.match(spotify, /arOpportunityMetric\(opportunity,1\)/, 'Artist companion choices must expose 24-hour streams');
assert.match(spotify, /arOpportunityMetric\(opportunity,7\)/, 'Artist companion choices must expose 7-day streams');
assert.match(spotify, /arOpportunityMetric\(opportunity,30\)/, 'Artist companion choices must expose 30-day streams');
assert.match(spotify, /arContactEligible\(opportunity\)/, 'Outreach must retain strict contact eligibility');
assert.match(spotify, /function arSelectionEligible\(spotifyId\)/, 'Selection must reuse the strict A&R eligibility gate');
assert.match(spotify, /arOpportunityRows\(\)\.some\(item=>item\.spotifyId===id\)&&arSelectionEligible\(id\)/, 'Bulk selection must reject non-verified tracks');
assert.match(spotify, /filter\(item=>item\.opportunity&&arContactEligible\(item\.opportunity\)\)/, 'The outreach selection must hide legacy non-verified entries');
assert.match(spotify, /mailto:\$\{encodeURIComponent\(currentEmail\)\}/, 'The mail client handoff must remain user initiated');
assert.match(spotify, /aucun e-mail n’est envoyé/i, 'The UI must not imply automatic sending');
assert.match(spotify, /cdn\.simpleicons\.org/, 'Detail contacts must use platform logos rather than emoji');
assert.match(spotify, /function arPromptArtistCompanions\(spotifyId\)/, 'Adding a track must offer other eligible tracks from the same structured artist');
assert.match(spotify, /function arOutreachDrafts\(opportunity\)/, 'Message preparation exposes multiple draft proposals');
assert.match(spotify, /Préparer le message/, 'Selection cards expose a message-preparation action');
assert.match(spotify, /function arSelectionArtistGroups\(/, 'A&R selection must group retained tracks by structured artist');
assert.match(spotify, /function arSelectionArtistCardHtml\(/, 'A&R selection must render an artist-level section');
const selectionTrackStart = spotify.indexOf('function arSelectionTrackHtml');
const selectionTrackEnd = spotify.indexOf('function arOpenSelectionArtistProfile', selectionTrackStart);
const selectionTrack = spotify.slice(selectionTrackStart, selectionTrackEnd);
for (const metric of ['Genre', 'Sortie', 'Streams total', 'Streams 30 jours', 'Streams 7 jours', 'Streams 24 heures']) {
  assert.ok(selectionTrack.includes(metric), `Selection track rows must show ${metric}`);
}
assert.match(spotify, /ar-artist-message/, 'A&R selection must promote the artist message action');
assert.match(spotify, /function arSelectionEconomics\(/, 'Artist-level A&R selection must reuse the economics calculation');
assert.match(spotify, /advance\(monthlyStreams\)/, 'Selection economics must use the same advance calculation as tracks');
assert.match(spotify, /labelMonthly\(monthlyStreams\)/, 'Selection economics must show captured monthly revenue');
assert.match(spotify, /payback\(monthlyStreams\)/, 'Selection economics must show payback using the shared model');
assert.match(spotify, /Même calcul que Pistes et Artistes/, 'Selection economics must state its shared calculation provenance');
const draftStart=spotify.indexOf('function arOutreachDrafts(');
const draftEnd=spotify.indexOf('function arOutreachDraft(',draftStart);
assert.doesNotMatch(spotify.slice(draftStart,draftEnd), /Coût estimé|Revenu \/ mois|Payback/, 'Financial estimates must never be inserted into outreach drafts');
assert.doesNotMatch(spotify, /E-mail public à enrichir|E-mail à enrichir/, 'No email-enrichment placeholder is shown to the user');
const cardStart = spotify.indexOf('function arOpportunityCard(');
const cardEnd = spotify.indexOf('\nfunction arScoreLine', cardStart);
assert.doesNotMatch(spotify.slice(cardStart, cardEnd), /arContactHtml\(opportunity,true\)/, 'Card previews must not render contact platforms');
assert.doesNotMatch(spotifyNav, /data-v="watch"/, 'Spotify watchlist navigation must be removed');
assert.match(spotifyNav, /data-v="ar-list" data-fr="Sélection"><span class="emo">⭐<\/span>Sélection/, 'The star selection uses the simplified label');
assert.match(spotifyNav, /data-v="radar" data-fr="Opportunités"><span class="emo">💎<\/span>Opportunités/, 'The opportunities view uses the simplified label');
assert.match(spotifyNav, /data-v="opps" class="active" data-fr="Pistes"><span class="emo">🎶<\/span>Pistes/, 'Spotify navigation uses the compact tracks label');
assert.match(spotifyNav, /data-v="artists" data-fr="Artistes"><span class="emo">🎸<\/span>Artistes/, 'Spotify navigation uses the compact artists label');
assert.match(spotifyNav, /data-v="playlists" data-fr="Playlists"><span class="emo">📻<\/span>Playlists/, 'Spotify navigation uses the compact playlists label');
assert.match(spotifyNav, /data-v="labels" data-fr="Labels"><span class="emo">🏷️<\/span>Labels/, 'Spotify navigation uses the compact labels label');
assert.doesNotMatch(spotifyNav, /Ma liste A&R/, 'The previous A&R list naming must be removed');
assert.doesNotMatch(spotifyNav, /Sélection A&R/, 'The sidebar must not retain the old A&R selection label');
assert.doesNotMatch(youtubeNav, /id:'watch'/, 'YouTube watchlist navigation must be removed');

assert.match(spotify, /function arOpenSelectionArtistProfile\(/, 'Selection must open the internal artist profile');
assert.match(spotify, /arOpenSelectionArtistProfile\('\$\{esc\(artist\.spotifyId\)\}','\$\{esc\(contactOpportunity\.spotifyId\)\}'\)/, 'Selection must pass structured artist and track ids to its profile action');
assert.match(spotify, /document\.getElementById\('ar-outreach-body'\)\?\.focus\(\)/, 'The prepared message text must receive focus');
assert.match(spotify, /AR_ARTIST_STORAGE/, 'Artist-level outreach state must be stored separately from tracks');
assert.match(spotify, /function arArtistStatus\(/, 'Artist-level status must default from artist state');
assert.match(spotify, /Statut artiste/, 'Selection must expose one status per artist');
assert.doesNotMatch(spotify.slice(spotify.indexOf('function arSelectionTrackHtml'),spotify.indexOf('function arOpenSelectionArtistProfile')), /<label class="ar-selection-track-field">Statut/, 'Track rows must not duplicate the artist status');
assert.match(spotify, /label:'Personnalisé'/, 'Message preparation must offer the expanded set of personalised templates');

console.log('A&R outreach workflow and watchlist removal: OK');
