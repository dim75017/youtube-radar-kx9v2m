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
const baseOptions = {
  spotifyId,
  title: 'Night < Walk',
  artist: 'Lofi & Friends',
  artwork: 'https://i.scdn.co/image/cover',
  extraClass: 'track-modal-player',
};
const fullMarkup = player.html(baseOptions);
const transportMarkup = player.html({...baseOptions, transportOnly: true});

assert.equal(player.html({spotifyId: 'not-a-spotify-id', title: 'Invalid'}), '', 'invalid Spotify IDs must not render a broken player');
assert.match(fullMarkup, /class="[^"]*spotify-radar-player[^"]*track-modal-player[^"]*"/, 'the shared player renders the Radar transport');
assert.match(fullMarkup, /spotify-radar-player-main[\s\S]*spotify-radar-player-cover[\s\S]*Night &lt; Walk[\s\S]*Lofi &amp; Friends/, 'the full transport includes escaped track identity');
assert.match(transportMarkup, /class="[^"]*spotify-radar-player--transport[^"]*"/, 'detail modals retain their compact transport-only context');
assert.doesNotMatch(transportMarkup, /spotify-radar-player-(?:main|cover|copy)/, 'transport-only details do not duplicate the artwork, title, or artist already shown above');
assert.match(transportMarkup, /aria-label="Lecteur Radar · Spotify Premium · Night &lt; Walk"/, 'the compact player remains labelled with the escaped track title');

for (const [name, markup] of [['full', fullMarkup], ['transport-only', transportMarkup]]) {
  assert.match(markup, /spotify-radar-player-toggle[\s\S]*SpotifyRadarPlayer\.toggle\(this\)/, `${name} player has an in-Radar Play/Pause control`);
  assert.match(markup, /spotify-radar-player-timeline[\s\S]*spotify-radar-player-current[\s\S]*spotify-radar-player-wave[\s\S]*spotify-radar-player-seek[\s\S]*spotify-radar-player-duration/, `${name} player exposes its real SDK timeline and seek control`);
  assert.match(markup, /spotify-radar-player-volume-toggle[\s\S]*spotify-radar-player-volume-range/, `${name} player exposes mute and volume controls`);
  assert.match(markup, /spotify-radar-player-settings/, `${name} player exposes Premium setup without replacing Play with a link`);
  assert.doesNotMatch(markup, /<iframe\b|spotify-radar-player-embed|\bpreview\b|\bextrait\b/i, `${name} player contains no Spotify Embed or preview surface`);
  const anchors=markup.match(/<a\b[^>]*>/g)||[];
  assert.equal(anchors.length,1,`${name} player exposes only the required Spotify attribution link`);
  assert.match(anchors[0],new RegExp(`class="spotify-radar-player-attribution"[\\s\\S]*href="https://open\\.spotify\\.com/track/${spotifyId}\\?locale=en"`),`${name} attribution points to the exact track`);
  assert.doesNotMatch(markup, /spotify-radar-player-open|▶\s*(?:Ouvrir|Open|Play)/i, `${name} player has no external playback CTA`);
}

assert.equal(player.__test.formatTimeMs(0), '0:00');
assert.equal(player.__test.formatTimeMs(154321), '2:34');
assert.equal(player.__test.formatTimeMs(Number.NaN), '--:--');
const normalizedState = player.__test.normalizeSdkState({
  track_window:{current_track:{uri:`spotify:track:${spotifyId}`, duration_ms:240000}},
  duration:240000,
  position:65432,
  paused:false,
  loading:true,
  disallows:{seeking:true},
});
assert.equal(normalizedState.id, spotifyId, 'SDK state is tied to the exact playing Spotify track');
assert.equal(normalizedState.durationMs, 240000, 'duration comes from Spotify SDK state');
assert.equal(normalizedState.positionMs, 65432, 'position comes from Spotify SDK state');
assert.equal(normalizedState.paused, false);
assert.equal(normalizedState.loading, true);
assert.equal(normalizedState.seekingDisallowed, true, 'Spotify SDK seek restrictions are preserved');
assert.match(playerSource, /function handleSdkState\(state\)[\s\S]*updateTimeline\(player,snapshot\.positionMs,snapshot\.durationMs\)[\s\S]*setUiState\(player,snapshot\.loading\?'buffering':snapshot\.paused\?'ready':'playing'\)/, 'SDK state drives the visible time, progress, and Play/Pause state');
assert.match(playerSource, /seek\.disabled=!\(duration&&player\.dataset\.spotifyId===ACTIVE_TRACK_ID&&SDK_PLAYER&&SDK_DEVICE_ID&&!seekingDisallowed\)/, 'seek remains disabled until Spotify reports a ready device and real unrestricted duration for the active track');
assert.match(playerSource, /function seek\(control\)[\s\S]*SDK_PLAYER\.seek\(position\)/, 'seek calls the Web Playback SDK with a real millisecond position');
assert.match(playerSource, /function setVolume\(value\)[\s\S]*SDK_PLAYER\.setVolume\(next\)/, 'volume controls the Web Playback SDK rather than a decorative slider');
assert.match(playerSource, /function requestPlay\(target\)[\s\S]*SDK_PLAYER\.activateElement\(\)[\s\S]*SDK_PLAYER\.togglePlay\(\)/, 'Play activates the browser audio element and toggles an already active track in place');

assert.match(playerSource, /new global\.Spotify\.Player\(\{name:'Lofi Radar',volume:CURRENT_VOLUME,getOAuthToken:/, 'the custom transport is backed by Spotify Web Playback SDK');
for (const eventName of ['ready', 'not_ready', 'player_state_changed', 'autoplay_failed', 'initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
  assert.match(playerSource, new RegExp(`SDK_PLAYER\\.addListener\\('${eventName}'`), `the SDK ${eventName} state is handled`);
}
assert.match(playerSource, /account_error[\s\S]*premium-required/, 'non-Premium accounts receive an explicit state');
assert.match(playerSource, /authentication_error[\s\S]*disconnected/, 'expired or invalid authentication returns the player to a reconnectable state');
assert.match(playerSource, /function recoverAuthentication[\s\S]*accessToken\(\{forceRefresh:true\}\)/, 'an SDK authentication failure forces a token refresh before retrying');
assert.match(playerSource, /function freezePlayback[\s\S]*stopTicker\(\)/, 'SDK connection and playback failures freeze the real clock');
assert.match(playerSource, /onSpotifyWebPlaybackSDKReady[\s\S]*sdkReady\(\)/, 'the official SDK readiness callback initializes the custom player');

assert.match(playerCss, /spotify-radar-player\{[\s\S]*display:grid!important[\s\S]*background:linear-gradient/, 'the player keeps the aesthetic Radar transport shell');
assert.match(playerCss, /spotify-radar-player--transport\{[\s\S]*grid-template-areas:"toggle timeline volume source settings"/, 'transport-only mode preserves the real controls and compact attribution without duplicate identity');
assert.match(playerCss, /spotify-radar-player-wave canvas/, 'the custom waveform has a dedicated responsive canvas');
assert.match(playerCss, /spotify-radar-player-volume-range/, 'the real volume control is styled');
assert.match(playerCss, /spotify-radar-player-attribution[\s\S]*grid-area:source/, 'Spotify content keeps a compact, non-primary source attribution');
assert.doesNotMatch(playerCss, /spotify-radar-player-(?:embed|engine)|iframe/, 'the player stylesheet contains no hidden or visible Embed engine');
assert.match(playerSource, /function supportsSdkVolume\(\)[\s\S]*iPad\|iPhone\|iPod[\s\S]*return !ios/, 'unsupported iOS volume controls are not rendered as fake controls');
assert.match(playerSource, /setAttribute\('inert',''\)/, 'the Premium dialog isolates the background');
assert.match(playerSource, /event\.key==='Escape'[\s\S]*stopImmediatePropagation\(\)/, 'the Premium dialog owns Escape');
assert.match(playerSource, /focusReturn\.focus\(\)/, 'the Premium dialog restores focus');
assert.match(playerSource, /removedActiveControl&&ACTIVE_TRACK_ID&&!playersForTrack\(ACTIVE_TRACK_ID\)\.length[\s\S]*SDK_PLAYER\.pause\(\)/, 'removing the last active transport pauses playback instead of leaving uncontrolled audio');
assert.match(playerCss, /@media\(max-width:430px\)\{\.spotify-radar-auth-dialog/, 'the body-level setup dialog uses a viewport media query on mobile');

assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*r\[6\]\s*,\s*r\[1\]\s*,\s*A\[r\[0\]\]\[0\]\s*,\s*r\[8\]\s*,\s*'track-modal-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'track detail modal uses the shared transport-only Web Playback player',
);
assert.match(
  dashboard,
  /spotifyTrackPlayerHtml\(\s*spotifyId\s*,\s*opportunity\.title\s*,\s*opportunity\.credit\s*,\s*arTrackCoverUrl\(opportunity\)\s*,\s*'ar-opportunity-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
  'A&R detail modal uses the shared transport-only Web Playback player',
);
const playerFallback = dashboard.slice(dashboard.indexOf('function spotifyTrackPlayerHtml('), dashboard.indexOf('function hydrateSpotifyRadarPlayerCovers('));
assert.doesNotMatch(playerFallback, /<iframe\b|open\.spotify\.com|\/embed\/|preview|extrait/i, 'the dashboard fallback never restores the former Embed preview');
const openTrack = dashboard.slice(dashboard.indexOf('function openTrack(tid){'), dashboard.indexOf('function openTrackFromCatalogueRow'));
assert.doesNotMatch(openTrack, /Ouvrir sur Spotify|target="_blank"|spotifyTrackUrl\(/, 'track detail no longer exposes a second external playback CTA');
const playArTrack = dashboard.slice(dashboard.indexOf('function playArTrack(spotifyId){'), dashboard.indexOf('function arClusters()', dashboard.indexOf('function playArTrack(spotifyId){')));
assert.doesNotMatch(playArTrack, /window\.open|target="_blank"|open\.spotify\.com/, 'A&R row Play never leaves the Radar');
assert.match(playArTrack, /SpotifyRadarPlayer\.requestPlay/, 'A&R row Play targets the custom Web Playback player');

const authIndex = index.indexOf('auth.js?v=20260821-web-playback-v2');
const playerIndex = index.indexOf('player.js?v=20260821-web-playback-v2');
const dashboardIndex = index.indexOf('dashboard.js?v=20260821-web-playback-v2');
const sdkIndex = index.indexOf('https://sdk.scdn.co/spotify-player.js');
assert.ok(authIndex >= 0 && playerIndex > authIndex && dashboardIndex > playerIndex && sdkIndex > dashboardIndex, 'auth, custom player, dashboard, then Web Playback SDK load in the safe callback order');
assert.doesNotMatch(index, /open\.spotify\.com\/embed\/iframe-api|spotify-radar-player-embed/, 'the obsolete Spotify IFrame API is not loaded');

(async()=>{
  const requests=[];
  const fakeFetch=async(url,options)=>{requests.push({url:String(url),options});return {ok:true};};
  assert.equal(await player.__test.webApiPlay(spotifyId, 'device / 42', 'access-token', fakeFetch), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=device%20%2F%2042', 'play targets the exact SDK device');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer access-token', 'play uses the current OAuth bearer token');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), {uris:[`spotify:track:${spotifyId}`]}, 'play sends only the exact selected track URI');
  await assert.rejects(()=>player.__test.webApiPlay('bad-id', 'device', 'token', fakeFetch), /spotify_playback_request_invalid/);
  console.log('Spotify custom Web Playback player and integration: OK');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
