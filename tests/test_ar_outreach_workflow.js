'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const spotify = fs.readFileSync('spotify/dashboard.js', 'utf8');
const spotifyNav = fs.readFileSync('spotify/index.html', 'utf8');
const youtubeNav = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

for (const token of ['AR_LIST_STORAGE', 'AR_ARTIST_STORAGE', 'AR_STAGE_TABS', 'function arAddToList(', 'function renderArList(', 'function openArOutreach(', 'function arOutreachDraft(', 'function arMarkArtistContacted(', 'function arSelectionContactPanelHtml(']) {
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
assert.match(spotify, /function arSelectionEligible\(spotifyId\)/, 'Selection keeps a dedicated catalogue eligibility check');
assert.match(spotify, /function arCatalogueSelectionOpportunity\(spotifyId\)/, 'Visible catalogue tracks can be converted into selection rows');
assert.match(spotify, /filter\(id=>arSelectionEligible\(id\)\)/, 'Bulk selection accepts every visible catalogue track');
assert.match(spotify, /arSelectionOpportunityById\(id\)/, 'The selection renders catalogue rows even when outreach is not approved');
assert.match(spotify, /mailto:\$\{encodeURIComponent\(currentEmail\)\}/, 'The mail client handoff must remain user initiated');
assert.doesNotMatch(spotify, /Le message reste sous votre contrôle|Aucun message n(?:’|')est envoyé automatiquement/i, 'The removed composer disclaimer must stay removed');
assert.match(spotify, /cdn\.simpleicons\.org/, 'Detail contacts must use platform logos rather than emoji');
assert.match(spotify, /function arPromptArtistCompanions\(spotifyId\)/, 'Adding a track must offer other eligible tracks from the same structured artist');
assert.match(spotify, /function arOutreachDrafts\(opportunity\)/, 'Message preparation exposes multiple draft proposals');
assert.match(spotify, /Préparer le message/, 'Selection cards expose a message-preparation action');
assert.match(spotify, /function arSelectionArtistGroups\(/, 'A&R selection must group retained tracks by structured artist');
assert.match(spotify, /function arSelectionArtistCardHtml\(/, 'A&R selection must render an artist-level section');
const outreachStart=spotify.indexOf('function openArOutreach(spotifyId){');
const outreachEnd=spotify.indexOf('\nfunction arSelectionPrimaryArtist(opportunity){',outreachStart);
const outreachSource=spotify.slice(outreachStart,outreachEnd);
assert.match(outreachSource, /const opportunity=arSelectionOpportunityById\(spotifyId\)/, 'Message preparation must open for catalogue-only Selection tracks');
assert.doesNotMatch(outreachSource, /const opportunity=arOpportunityRows\(\)\.find/, 'Message preparation must not use the restricted Opportunities-only lookup');
assert.match(outreachSource, /id="ar-composer-economics"/, 'Message preparation must expose the individualized internal estimate');
for (const stage of ['to_contact', 'contacted', 'negotiating', 'validated', 'refused']) {
  assert.match(spotify, new RegExp(`key:'${stage}'`), `Selection must expose the ${stage} negotiation tab`);
}
assert.match(spotify, /function arSetArtistStatus\(artistKey,status\)/, 'Selection statuses must transition at artist level');
assert.match(spotify, /function arSyncArtistTrackStatus\(artistKey,status,patch=\{\}\)/, 'Artist transitions must remain synchronized across selected tracks');
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
const contactPayloadIndex=spotifyNav.indexOf('../Spotify_Selection_Contacts_data.js?payload=');
const dashboardScriptIndex=spotifyNav.indexOf('dashboard.js?v=20260728-outreach-composer-v1');
assert.ok(contactPayloadIndex>=0&&dashboardScriptIndex>contactPayloadIndex, 'The Selection contact directory must load before the dashboard logic.');
assert.match(spotify, /window\.SPOTIFY_SELECTION_CONTACTS/, 'Selection must consume its dedicated public-contact directory.');

assert.match(spotify, /function arOpenSelectionArtistProfile\(/, 'Selection must open the internal artist profile');
assert.match(spotify, /arOpenSelectionArtistProfile\('\$\{esc\(artist\.spotifyId\)\}','\$\{esc\(contactOpportunity\.spotifyId\)\}'\)/, 'Selection must pass structured artist and track ids to its profile action');
assert.match(spotify, /document\.getElementById\('ar-outreach-body'\)\?\.focus\(\)/, 'The prepared message text must receive focus');
assert.match(spotify, /AR_ARTIST_STORAGE/, 'Artist-level outreach state must be stored separately from tracks');
assert.match(spotify, /function arArtistStatus\(/, 'Artist-level status must default from artist state');
const artistCardStart=spotify.indexOf('function arSelectionArtistCardHtml(group){');
const artistCardEnd=spotify.indexOf('\nfunction arSelectionEconomics(group){',artistCardStart);
assert.doesNotMatch(spotify.slice(artistCardStart,artistCardEnd), /arSelectionStatusHtml|ar-artist-status/, 'Selection cards must not repeat the active top-level stage.');
assert.doesNotMatch(spotify.slice(spotify.indexOf('function arSelectionTrackHtml'),spotify.indexOf('function arOpenSelectionArtistProfile')), /<label class="ar-selection-track-field">Statut/, 'Track rows must not duplicate the artist status');
assert.match(spotify, /class="ar-remove ar-trash-action"[^>]+aria-label="Retirer /, 'Track removal must use an accessible trash button.');
assert.match(spotify, /label:'Personnalisé'/, 'Message preparation must offer the expanded set of personalised templates');

console.log('A&R outreach workflow and watchlist removal: OK');
