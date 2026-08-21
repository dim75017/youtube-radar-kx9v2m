'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');
assert.match(dashboard, /const BROWSE = window\.SPOTIFY_BROWSE_CATALOGUE \|\| \{\};/);
assert.match(dashboard, /const DISCOVERY_CATALOGUE = \(\(\) => \{/);
assert.match(dashboard, /function mergeFullDiscoveryCatalogue\(/);
const matchStart = dashboard.indexOf('function discoveryTrackMatch(');
const matchEnd = dashboard.indexOf('\nfunction mergeFullDiscoveryCatalogue(', matchStart);
assert.ok(matchStart >= 0 && matchEnd > matchStart, 'exact Spotify identity matching must remain independently testable');
const matchContext = {};
vm.runInNewContext(`${dashboard.slice(matchStart, matchEnd)}; this.matchTrack=discoveryTrackMatch; this.applyCounter=applyDiscoveryLifetimeCounter;`, matchContext);
const legacyAlias = [0, 'Legacy alias', '', 200_000, 0, '', 'legacy-spotify-id'];
const exactTrack = [0, 'Exact track', '', 200_000, 0, '', 'exact-spotify-id'];
const aliasIndex = new Map([
  ['legacy-spotify-id', legacyAlias],
  ['soundcharts:shared-uuid', legacyAlias],
]);
assert.equal(matchContext.matchTrack(aliasIndex, 'exact-spotify-id', 'shared-uuid', 'exact-spotify-id'), null,
  'a different Spotify ID must not be swallowed by a shared Soundcharts UUID alias');
aliasIndex.set('exact-spotify-id', exactTrack);
assert.equal(matchContext.matchTrack(aliasIndex, 'exact-spotify-id', 'shared-uuid', 'exact-spotify-id'), exactTrack,
  'an exact Spotify ID match must always win over Soundcharts aliases');
assert.equal(matchContext.matchTrack(aliasIndex, '', 'shared-uuid', 'soundcharts:shared-uuid'), legacyAlias,
  'Soundcharts UUID matching remains available when no Spotify ID exists');
const staleCounterTrack = [0, 'Just crossed the floor', '', 99_999, 0, '', 'crossed-floor'];
matchContext.applyCounter(staleCounterTrack, 100_001);
assert.equal(staleCounterTrack[3], 100_001,
  'the canonical browse counter must replace a positive legacy counter before the 100k floor is applied');
assert.match(dashboard, /normalizeDiscoveryCatalogue\(BROWSE_DISCOVERY\)/);
assert.match(dashboard, /tracks:normalized\.tracks/);
assert.match(dashboard, /function publicDiscoveryTrackEligible\(/);
assert.match(dashboard, /function strictPublicDiscoveryTracks\(/);
assert.doesNotMatch(dashboard, /catalogues\.flatMap|STRICT_DISCOVERY/);
assert.match(dashboard, /mergeFullDiscoveryCatalogue\(\);/);
assert.match(dashboard, /const LEGACY_R = \(D\.rows \|\| \[\]\)\.filter/);
assert.match(dashboard, /Tout le catalogue/);
assert.match(dashboard, /Self-release/);
assert.match(dashboard, /Autre label/);
assert.match(dashboard, /function arEditorialPlaylistEvidenceHtml\(/);
assert.match(dashboard, /function arOpportunityPlayerHtml\(/);
assert.doesNotMatch(dashboard.slice(dashboard.indexOf('function openArOpportunity'), dashboard.indexOf('function arColumnBarHtml')), /Pourquoi cette musique est dans la liste/);
assert.match(dashboard, /arEditorialPlaylistEvidenceHtml\(opportunity\)/);
assert.match(dashboard, /function spotifyTrackPlayerHtml\(/);
assert.match(dashboard, /spotifyTrackPlayerHtml\(r\[6\],r\[1\],A\[r\[0\]\]\[0\],r\[8\],'track-modal-player',\{transportOnly:true\}\)/);
assert.match(dashboard, /window\.SpotifyRadarPlayer\.hydrate\(root\)/);
assert.match(dashboard, /function openTrackFromCatalogueRow\(event,tid\)/);
assert.match(dashboard, /onclick="openTrackFromCatalogueRow\(event,'\$\{r\[6\]\}'\)"/);
assert.match(dashboard, /target\.closest\('a,button,input,select,option,label,\.ar,\.tk,\[data-no-track-open\]'\)/);
assert.match(dashboard, /function trackEditorialEvidenceHtml\(/);
assert.match(dashboard, /trackEditorialEvidenceHtml\(r\)/);
assert.match(dashboard, /function arEditorialPlaylistPanelHtml\(/);
assert.match(dashboard, /return arEditorialPlaylistPanelHtml\(opportunity,/);
assert.match(dashboard, /function arEditorialPlaylistCoverHtml\(/);
assert.match(dashboard, /hydrateArPlaylistCovers\(\);/);
const radarStart = dashboard.indexOf('function renderRadar(){');
const radarEnd = dashboard.indexOf('function renderWatch(){', radarStart);
assert.ok(radarStart >= 0 && radarEnd > radarStart, 'A&R render section must exist');
assert.match(dashboard.slice(radarStart, radarEnd), /id="radar-q"/, 'A&R search bar is available beside the genre filter');
assert.match(coverage, /Catalogue actif/);
assert.match(coverage, /minimumLifetimeStreams = 100000/);
assert.match(index, /Spotify_Browse_Catalogue_data\.js\?payload=/);
assert.match(index, /discovery\.css\?v=20260722-unified-catalogue-v1/);
assert.match(index, /player\.css\?v=20260821-inline-player-v3/);
assert.match(index, /player\.js\?v=20260821-inline-player-v3/);
assert.match(index, /dashboard\.js\?v=20260821-inline-player-v3/);
assert.match(index, /open\.spotify\.com\/embed\/iframe-api\/v1/);
assert.match(dashboard, /const SPOTIFY_WEB_LOCALE='en'/);
assert.match(dashboard, /locale=\$\{SPOTIFY_WEB_LOCALE\}/);
assert.match(dashboard, /function artistTrackClassification\(g\)/);
assert.match(dashboard, /genreSource:'tracks_catalogue'/);
assert.match(index, /coverage\.js\?v=20260801-track-floor-100k-v1/);
console.log('spotify unified catalogue guardrails: OK');
