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
const spotifyUrl = `https://open.spotify.com/track/${spotifyId}?locale=en`;
const markup = player.html({
  spotifyId,
  title: 'Night < Walk',
  artist: 'Lofi & Friends',
  artwork: 'https://i.scdn.co/image/cover',
  extraClass: 'track-modal-player',
  transportOnly: true,
});

function elementWithClass(source, tag, className) {
  const expression = new RegExp(`<${tag}\\b(?=[^>]*class="[^"]*\\b${className}\\b[^"]*")[^>]*>[\\s\\S]*?<\\/${tag}>`, 'i');
  return source.match(expression)?.[0] || '';
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\{([^}]+)\\}`))?.[1] || '';
}

assert.equal(player.html({spotifyId: 'not-a-spotify-id', title: 'Invalid'}), '', 'invalid Spotify IDs must not render a broken player');
assert.match(markup, /class="[^"]*spotify-radar-player--transport[^"]*"/, 'detail modals use an explicit transport-only layout');
assert.match(markup, /aria-label="Lecteur Spotify · Night &lt; Walk"/, 'the transport remains labelled with the escaped track title');
assert.doesNotMatch(markup, /spotify-radar-player-(?:main|cover|copy)/, 'transport-only markup never duplicates the modal cover, title or artist');

// The safe player never embeds Spotify. It opens the canonical track page,
// where Spotify controls authentication and full-track availability.
for (const source of [playerSource, markup]) {
  assert.doesNotMatch(source, /<iframe\b|spotify-radar-player-engine|createController|onSpotifyIframeApiReady|IFRAME_API/, 'no hidden Spotify iframe/API engine may survive');
}
assert.doesNotMatch(index, /open\.spotify\.com\/embed\/iframe-api\/v1/, 'the removed Spotify IFrame API SDK must not be loaded');

const playLink = elementWithClass(markup, 'a', 'spotify-radar-player-play');
assert.ok(playLink, 'the player exposes a real Play link');
assert.match(playLink, new RegExp(`href="${spotifyUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), 'Play opens the canonical Spotify track URL');
assert.match(playLink, /target="_blank"/, 'Play opens Spotify without replacing the Radar');
assert.match(playLink, /rel="noopener"/, 'the external Play link is isolated from the Radar window');
assert.match(playLink, /titre entier dans Spotify/i, 'Play explicitly says that the complete title is opened in Spotify');
assert.doesNotMatch(playLink, /preview|30\s*(?:s|sec|secondes?)/i, 'Play is never presented as another 30-second preview');

const playRule = cssRule(playerCss, '.spotify-radar-player-play');
const playWidth = Number(playRule.match(/(?:width|inline-size|min-width):([\d.]+)px/)?.[1]);
const playHeight = Number(playRule.match(/(?:height|block-size|min-height):([\d.]+)px/)?.[1]);
assert.ok(playWidth >= 52 && playHeight >= 52, 'the primary Play target stays at least 52 × 52 px');

// The waveform is visual texture only. Without playback telemetry there must
// be no fabricated clock, duration, percentage or progress accessibility API.
assert.doesNotMatch(markup, /<time\b|spotify-radar-player-(?:current|duration)|role="progressbar"|aria-value(?:min|max|now|text)/, 'no fake playback time or progress is rendered');
assert.doesNotMatch(playerSource, /playback_update|playback_started|normalizePlaybackUpdate|controller\.(?:play|pause|togglePlay|seek)\s*\(/, 'no dead playback-controller behavior remains');
const waveform = elementWithClass(markup, 'div', 'spotify-radar-player-wave');
assert.ok(waveform, 'the decorative waveform remains visible');
assert.match(waveform, /aria-hidden="true"/, 'the decorative waveform is hidden from assistive technology');
assert.doesNotMatch(waveform, /role=|aria-value/, 'the waveform never impersonates real progress');

const shareButton = elementWithClass(markup, 'button', 'spotify-radar-player-share');
assert.ok(shareButton, 'sharing remains available');
assert.match(shareButton, /data-url="https:\/\/open\.spotify\.com\/track\/1234567890123456789012\?locale=en"/);
assert.match(shareButton, /SpotifyRadarPlayer\.share\(this\)/, 'the existing share action remains wired');
const spotifyAttribution = elementWithClass(markup, 'a', 'spotify-radar-player-open');
assert.ok(spotifyAttribution, 'Spotify attribution remains visible');
assert.match(spotifyAttribution, /href="https:\/\/open\.spotify\.com\/track\/1234567890123456789012\?locale=en"/);
assert.match(spotifyAttribution, /(?:aria-label|title)="Ouvrir sur Spotify/, 'the attribution names Spotify explicitly');

for (const fakeControl of ['volume', 'download', 'like', 'favorite', 'heart', 'seek']) {
  assert.doesNotMatch(markup, new RegExp(`spotify-radar-player-${fakeControl}`, 'i'), `the player must not fake unsupported ${fakeControl} controls`);
}

assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*r\[6\]\s*,\s*r\[1\]\s*,\s*A\[r\[0\]\]\[0\]\s*,\s*r\[8\]\s*,\s*'track-modal-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'track detail modal explicitly requests transport-only markup',
);
assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*spotifyId\s*,\s*opportunity\.title\s*,\s*opportunity\.credit\s*,\s*arTrackCoverUrl\(opportunity\)\s*,\s*'ar-opportunity-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'A&R detail modal explicitly requests transport-only markup',
);

const openTrackSource = dashboard.slice(dashboard.indexOf('function openTrack(tid)'), dashboard.indexOf('function openTrackFromCatalogueRow'));
assert.match(openTrackSource, /class="tcov"[^>]*r\[8\]/, 'track detail header keeps the real track artwork');
assert.match(openTrackSource, /<h3>\$\{esc\(r\[1\]\)\}<\/h3>/, 'track detail header keeps the track title');
const openArOpportunitySource = dashboard.slice(dashboard.indexOf('function openArOpportunity(spotifyId)'), dashboard.indexOf('function sortTriangleIndicator'));
assert.match(openArOpportunitySource, /arTrackCoverUrl\(opportunity\)/, 'A&R detail header resolves the real track artwork');
assert.match(openArOpportunitySource, /<h3>\$\{esc\(opportunity\.title\)\}<\/h3>/, 'A&R detail header keeps the track title');
assert.match(openArOpportunitySource, /(?:background-image|<img)[\s\S]{0,240}coverUrl|coverUrl[\s\S]{0,240}(?:background-image|<img)/, 'A&R detail header renders its resolved artwork');

assert.match(playerCss, /@container \(max-width:720px\)/, 'the player retains a compact/mobile breakpoint');
assert.match(playerCss, /@container \(max-width:720px\)\{[\s\S]*?\.spotify-radar-player--transport\{/, 'transport-only controls receive a dedicated mobile layout');
assert.match(index, /player\.css\?v=20260820-custom-player-v2/);
assert.match(index, /player\.js\?v=20260820-custom-player-v2/);
assert.match(index, /dashboard\.js\?v=20260820-custom-player-v2/);
assert.ok(index.indexOf('player.js?v=20260820-custom-player-v2') < index.indexOf('dashboard.js?v=20260820-custom-player-v2'), 'the shared player loads before dashboard callsites');

console.log('Spotify external full-track transport and modal integration: OK');
