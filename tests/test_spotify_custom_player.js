'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const playerPath = path.join(root, 'spotify', 'player.js');
const playerSource = fs.readFileSync(playerPath, 'utf8');
const playerCss = fs.readFileSync(path.join(root, 'spotify', 'player.css'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'spotify', 'dashboard.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'spotify', 'index.html'), 'utf8');
const player = require(playerPath);

const spotifyId = '1234567890123456789012';
const embedUrl = `https://open.spotify.com/embed/track/${spotifyId}?utm_source=generator&amp;theme=0`;
const markup = player.html({
  spotifyId,
  title: 'Night < Walk',
  artist: 'Lofi & Friends',
  artwork: 'https://i.scdn.co/image/cover',
  extraClass: 'track-modal-player',
  transportOnly: true,
});
const fallbackIframe = player.__test.iframeHtml(spotifyId, 'Night < Walk', {player:'Lecteur Spotify intégré'});

assert.equal(player.html({spotifyId: 'not-a-spotify-id', title: 'Invalid'}), '', 'invalid Spotify IDs must not render a broken player');
assert.match(markup, /class="[^"]*spotify-radar-player--transport[^"]*"/, 'detail modals retain their explicit transport-only context');
assert.match(markup, /aria-label="Lecteur Spotify intégré · Night &lt; Walk"/, 'the player remains labelled with the escaped title');
assert.doesNotMatch(markup, /spotify-radar-player-(?:main|cover|copy|wave|current|duration|play|open|share)/, 'the Radar does not duplicate Spotify metadata or fake native controls');
assert.doesNotMatch(markup, /<a\b|target="_blank"|open\.spotify\.com\/track\//, 'the primary listening surface never navigates away from the Radar');

assert.match(markup, /spotify-radar-player-embed-shell[\s\S]*spotify-radar-player-embed-host/, 'the API replacement target stays inside a stable visible shell');
assert.match(playerSource, /createController\(host,\{uri:`spotify:track:\$\{id\}`,width:'100%',height:152\}/, 'the official controller is created at its supported full width and height');
assert.doesNotMatch(playerSource, /createController\(player\.querySelector\('\.spotify-radar-player-embed-shell'/, 'the stable shell itself must never be replaced');
assert.match(playerSource, /requestPlay\(target\)[\s\S]*controller\.togglePlay\(\)/, 'row Play actions control the in-page embed');
assert.match(playerSource, /readyTimer=setTimeout\(\(\)=>recoverPlayer\(player,instance\),12000\)/, 'each controller has a bounded recovery path');
assert.match(playerSource, /function recoverPlayer\(player,instance\)[\s\S]*replaceChildren\(host\)[\s\S]*directEmbed\(player\)/, 'a stalled controller falls back to a fresh visible official Embed');
assert.doesNotMatch(playerSource, /global\.open\(|window\.open\(/, 'the shared player never opens Spotify in another tab');

assert.match(fallbackIframe, new RegExp(embedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the fallback uses the exact official track embed');
assert.match(fallbackIframe, /width="100%" height="152"/, 'the official embed uses the no-scroll 152px layout');
assert.match(fallbackIframe, /allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"/, 'encrypted-media permission is preserved for full-track-capable playback');
assert.match(fallbackIframe, /allowfullscreen/, 'the official embed keeps its complete permission set');
assert.match(fallbackIframe, /loading="lazy"/, 'offscreen embeds remain lazy');
assert.doesNotMatch(fallbackIframe, /preview|30\s*(?:s|sec|secondes?)/i, 'the Radar never labels the player as a 30-second preview');

assert.match(playerCss, /spotify-radar-player-embed-shell\{[\s\S]*height:152px;[\s\S]*overflow:hidden/, 'the visible Embed shell has the official height and clips accidental overflow');
assert.match(playerCss, /spotify-radar-player-embed-shell>iframe[\s\S]*height:152px!important/, 'the API-generated iframe cannot fall back to the former 80px scrolling box');
assert.doesNotMatch(playerCss, /height:80px/, 'the legacy undersized iframe rule is gone');
assert.doesNotMatch(markup, /<time\b|role="progressbar"|aria-value(?:min|max|now|text)/, 'no fabricated time or progress is rendered');

assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*r\[6\]\s*,\s*r\[1\]\s*,\s*A\[r\[0\]\]\[0\]\s*,\s*r\[8\]\s*,\s*'track-modal-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'track detail modal uses the shared inline player',
);
assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*spotifyId\s*,\s*opportunity\.title\s*,\s*opportunity\.credit\s*,\s*arTrackCoverUrl\(opportunity\)\s*,\s*'ar-opportunity-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'A&R detail modal uses the shared inline player',
);
const playArTrack = dashboard.slice(dashboard.indexOf('function playArTrack(spotifyId)'), dashboard.indexOf('function arClusters()', dashboard.indexOf('function playArTrack(spotifyId)')));
assert.doesNotMatch(playArTrack, /window\.open|target="_blank"/, 'A&R row Play never leaves the Radar');
assert.match(playArTrack, /SpotifyRadarPlayer\.requestPlay/, 'A&R row Play targets the embedded player');

const openTrackSource = dashboard.slice(dashboard.indexOf('function openTrack(tid)'), dashboard.indexOf('function openTrackFromCatalogueRow'));
assert.match(openTrackSource, /class="tcov"[^>]*r\[8\]/, 'track detail header keeps the real artwork above the player');
const openArOpportunitySource = dashboard.slice(dashboard.indexOf('function openArOpportunity(spotifyId)'), dashboard.indexOf('function sortTriangleIndicator'));
assert.match(openArOpportunitySource, /arTrackCoverUrl\(opportunity\)/, 'A&R detail header keeps the resolved artwork above the player');

assert.match(index, /player\.css\?v=20260821-inline-player-v3/);
assert.match(index, /player\.js\?v=20260821-inline-player-v3/);
assert.match(index, /dashboard\.js\?v=20260821-inline-player-v3/);
assert.match(index, /https:\/\/open\.spotify\.com\/embed\/iframe-api\/v1/, 'the official Spotify IFrame API is loaded');
assert.ok(index.indexOf('player.js?v=20260821-inline-player-v3') < index.indexOf('dashboard.js?v=20260821-inline-player-v3'), 'the player loads before dashboard callsites');

console.log('Spotify official inline Embed and modal integration: OK');
