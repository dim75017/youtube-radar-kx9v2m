'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const playerPath = path.join(root, 'spotify', 'player.js');
const playerSource = fs.readFileSync(playerPath, 'utf8');
const playerCss = fs.readFileSync(path.join(root, 'spotify', 'player.css'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'spotify', 'dashboard.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'spotify', 'index.html'), 'utf8');
const previewDataSource = fs.readFileSync(path.join(root, 'Spotify_Preview_Audio_data.js'), 'utf8');

const previewContext = {window: {}};
vm.runInNewContext(previewDataSource, previewContext, {filename: 'Spotify_Preview_Audio_data.js'});
const previewData = previewContext.window.SPOTIFY_PREVIEW_AUDIO;
assert.ok(previewData && previewData.hashes, 'the generated Spotify preview map is valid JavaScript data');
const previewEntries = Object.entries(previewData.hashes);
assert.ok(previewEntries.length > 0, 'the preview map contains playable catalogue tracks');
assert.equal(previewData.available_tracks, previewEntries.length, 'the preview map availability count matches its hashes');
for (const [id, hash] of previewEntries) {
  assert.match(id, /^[A-Za-z0-9]{22}$/, 'preview map keys are Spotify track IDs');
  assert.match(hash, /^[a-f0-9]{40}$/, 'preview map values are immutable Spotify CDN hashes');
}
assert.doesNotMatch(previewDataSource, /https:\/\/p\.scdn\.co\/mp3-preview\/|access_token|client_id|Authorization\s*:/i,
  'the preview map embeds only hashes, never full URLs or credentials');

const spotifyId = previewEntries[0][0];
const previewHash = previewEntries[0][1];
const unavailableId = 'ZZZZZZZZZZZZZZZZZZZZZZ';
delete previewData.hashes[unavailableId];

function makeControl(initial = {}) {
  const listeners = new Map();
  return Object.assign({
    dataset: {},
    attributes: new Map(),
    value: '',
    textContent: '',
    disabled: false,
    title: '',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      if (listeners.has(type)) listeners.get(type).delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({type, target: this});
    },
    listenerCount(type) {
      return (listeners.get(type) || new Set()).size;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  }, initial);
}

const toggleControl = makeControl();
const glyph = makeControl();
const status = makeControl();
const currentTime = makeControl();
const duration = makeControl();
const seek = makeControl({value: '0', disabled: true});
const volume = makeControl({value: '72'});
const volumeToggle = makeControl();
const canvasContext = {
  globalAlpha: 1,
  fillStyle: '',
  setTransform() {},
  clearRect() {},
  fillRect() {},
};
const canvas = makeControl({
  clientWidth: 420,
  clientHeight: 38,
  width: 0,
  height: 0,
  getContext() { return canvasContext; },
});
const controls = new Map([
  ['.spotify-radar-player-toggle', toggleControl],
  ['.spotify-radar-player-glyph', glyph],
  ['.spotify-radar-player-status', status],
  ['.spotify-radar-player-current', currentTime],
  ['.spotify-radar-player-duration', duration],
  ['.spotify-radar-player-seek', seek],
  ['.spotify-radar-player-volume-range', volume],
  ['.spotify-radar-player-volume-toggle', volumeToggle],
  ['.spotify-radar-player-wave canvas', canvas],
]);
const fakePlayer = {
  dataset: {
    spotifyId,
    title: 'Night Walk',
    previewAvailable: '1',
    labelPlay: 'Lire',
    labelPause: 'Pause',
    labelLoading: 'Chargement',
    labelBuffering: 'Buffering',
    labelReady: 'Prêt',
    labelPaused: 'En pause',
    labelEnded: 'Terminé',
    labelUnavailable: 'Indisponible',
    labelAutoplay: 'Autoplay bloqué',
  },
  attributes: new Map(),
  isConnected: true,
  matches(selector) { return selector === '.spotify-radar-player'; },
  closest(selector) { return selector === '.spotify-radar-player' ? this : null; },
  querySelector(selector) { return controls.get(selector) || null; },
  setAttribute(name, value) { this.attributes.set(name, String(value)); },
  removeAttribute(name) { this.attributes.delete(name); },
};
for (const control of controls.values()) {
  control.closest = selector => selector === '.spotify-radar-player' ? fakePlayer : null;
}

const fakeDocument = {
  readyState: 'complete',
  querySelectorAll(selector) {
    return selector === '.spotify-radar-player' ? [fakePlayer] : [];
  },
  createElement() {
    throw new Error('the custom player must use Audio rather than a hidden DOM engine');
  },
};

let audioConstructions = 0;
class FakeAudio {
  constructor() {
    audioConstructions += 1;
    this.listeners = new Map();
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.duration = 30;
    this.currentTime = 0;
    this.volume = 1;
    this.preload = '';
    this._src = '';
    this.playCount = 0;
    this.pauseCount = 0;
  }
  get src() { return this._src; }
  set src(value) { this._src = String(value); }
  get currentSrc() { return this._src; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({type, target: this});
  }
  load() {
    this.error = null;
    this.ended = false;
    this.paused = true;
    this.dispatch('loadstart');
    this.dispatch('loadedmetadata');
  }
  play() {
    this.playCount += 1;
    this.error = null;
    this.ended = false;
    this.paused = false;
    this.dispatch('play');
    this.dispatch('playing');
    return Promise.resolve();
  }
  pause() {
    this.pauseCount += 1;
    if (this.paused) return;
    this.paused = true;
    this.dispatch('pause');
  }
}

const storedVolume = new Map();
const originalGlobals = {
  Audio: global.Audio,
  document: global.document,
  localStorage: global.localStorage,
  open: global.open,
  previewData: global.SPOTIFY_PREVIEW_AUDIO,
  player: global.SpotifyRadarPlayer,
};
let externalOpenCount = 0;
global.Audio = FakeAudio;
global.document = fakeDocument;
global.localStorage = {
  getItem(key) { return storedVolume.has(key) ? storedVolume.get(key) : null; },
  setItem(key, value) { storedVolume.set(String(key), String(value)); },
};
global.open = () => {
  externalOpenCount += 1;
  throw new Error('Play must never open an external page');
};
global.SPOTIFY_PREVIEW_AUDIO = previewData;
delete require.cache[require.resolve(playerPath)];
const player = require(playerPath);

function restoreGlobal(name, value) {
  if (value === undefined) delete global[name];
  else global[name] = value;
}

(async () => {
  try {
    assert.deepEqual(
      Object.keys(player).sort(),
      ['__test', 'clear', 'html', 'hydrate', 'mute', 'requestPlay', 'scrubSeek', 'seek', 'setCover', 'setVolume', 'toggle'].sort(),
      'the shared custom player exposes only its native transport API and test helpers',
    );
    assert.equal(audioConstructions, 0, 'the shared HTMLAudio engine is lazy');
    assert.equal(player.__test.previewHash(spotifyId), previewHash);
    assert.equal(player.__test.previewUrlForTrack(spotifyId), 'https://p.scdn.co/mp3-preview/' + previewHash);
    assert.equal(player.__test.previewUrlForTrack(unavailableId), '');
    assert.equal(player.__test.formatTimeMs(0), '0:00');
    assert.equal(player.__test.formatTimeMs(154321), '2:34');
    assert.equal(player.__test.mediaDurationMs({duration: 30}), 30000);
    assert.equal(player.__test.mediaPositionMs({currentTime: 12.5}), 12500);

    const baseOptions = {
      spotifyId,
      title: 'Night < Walk',
      artist: 'Lofi & Friends',
      artwork: 'https://i.scdn.co/image/cover',
      extraClass: 'track-modal-player',
    };
    const fullMarkup = player.html(baseOptions);
    const transportMarkup = player.html(Object.assign({}, baseOptions, {transportOnly: true}));
    const unavailableMarkup = player.html({spotifyId: unavailableId, title: 'No preview'});
    assert.equal(player.html({spotifyId: 'not-a-spotify-id'}), '', 'invalid Spotify IDs cannot render a broken player');
    assert.match(fullMarkup, /class="[^"]*spotify-radar-player[^"]*track-modal-player[^"]*"/);
    assert.match(fullMarkup, /spotify-radar-player-main[\s\S]*spotify-radar-player-cover[\s\S]*Night &lt; Walk[\s\S]*Lofi &amp; Friends/,
      'the full transport includes safely escaped track identity');
    assert.match(transportMarkup, /spotify-radar-player--transport/);
    assert.doesNotMatch(transportMarkup, /spotify-radar-player-(?:main|cover|copy)/,
      'the modal transport does not duplicate artwork, title, or artist');
    assert.match(fullMarkup, /data-preview-available="1"[\s\S]*data-state="ready"/,
      'mapped previews render as ready without login');
    assert.match(unavailableMarkup, /data-preview-available="0"[\s\S]*data-state="unavailable"[\s\S]*aria-disabled="true" disabled/,
      'missing previews are honestly disabled');

    for (const [name, markup] of [['full', fullMarkup], ['transport', transportMarkup]]) {
      assert.match(markup, /<button class="spotify-radar-player-toggle"[^>]*SpotifyRadarPlayer\.toggle\(this\)/,
        name + ' player has an in-Radar Play/Pause button');
      assert.match(markup, /spotify-radar-player-current[\s\S]*spotify-radar-player-wave[\s\S]*spotify-radar-player-seek[\s\S]*spotify-radar-player-duration/,
        name + ' player exposes native progress and seek controls');
      assert.match(markup, /spotify-radar-player-volume-toggle[\s\S]*spotify-radar-player-volume-range/,
        name + ' player exposes real mute and volume controls');
      assert.doesNotMatch(markup, /<iframe\b|<audio\b|spotify-radar-player-embed|spotify-radar-player-settings/i,
        name + ' player has no embed, hidden DOM player, or obsolete settings tab');
      const anchors = markup.match(/<a\b[^>]*>/g) || [];
      assert.equal(anchors.length, 1, name + ' player exposes only a separate Spotify attribution');
      assert.match(anchors[0], /class="spotify-radar-player-attribution"/);
      assert.doesNotMatch(markup.match(/<button class="spotify-radar-player-toggle"[^>]*>/)[0], /href=|target=|open\.spotify/i,
        name + ' Play control cannot navigate to Spotify');
    }

    assert.equal(seek.listenerCount('input'), 1, 'hydration wires live seek preview');
    assert.equal(seek.listenerCount('change'), 1, 'hydration wires committed seeking');
    assert.equal(volume.listenerCount('input'), 1, 'hydration wires the volume slider');
    assert.equal(fakePlayer.dataset.state, 'ready', 'hydration recognizes a mapped preview');

    assert.equal(await player.requestPlay(fakePlayer), true);
    const audio = player.__test.getAudio();
    assert.ok(audio instanceof FakeAudio, 'Play creates a native HTMLAudio engine');
    assert.equal(audioConstructions, 1, 'all transports share one native HTMLAudio engine');
    assert.equal(audio.src, 'https://p.scdn.co/mp3-preview/' + previewHash);
    assert.equal(audio.preload, 'metadata');
    assert.equal(audio.playCount, 1);
    assert.equal(fakePlayer.dataset.state, 'playing');
    assert.equal(toggleControl.getAttribute('aria-pressed'), 'true');
    assert.equal(glyph.dataset.icon, 'pause');
    assert.equal(seek.disabled, false, 'metadata enables seeking for the active preview');
    assert.equal(duration.textContent, '0:30');
    assert.equal(externalOpenCount, 0, 'Play stays inside the Radar');

    seek.value = '500';
    assert.equal(player.seek(seek), true);
    assert.equal(audio.currentTime, 15, 'seek writes the native audio currentTime');
    assert.equal(currentTime.textContent, '0:15');
    seek.value = '250';
    player.scrubSeek(seek);
    assert.equal(currentTime.textContent, '0:07', 'scrubbing previews the selected position');

    player.setVolume(0.35);
    assert.equal(audio.volume, 0.35, 'volume writes the native audio volume');
    assert.equal(volume.value, '35');
    player.mute();
    assert.equal(audio.volume, 0, 'mute silences native audio');
    assert.equal(volumeToggle.dataset.muted, '1');
    player.mute();
    assert.equal(audio.volume, 0.35, 'unmute restores the last audible level');

    audio.dispatch('waiting');
    assert.equal(fakePlayer.dataset.state, 'buffering');
    audio.dispatch('playing');
    assert.equal(fakePlayer.dataset.state, 'playing');
    assert.equal(await player.toggle(fakePlayer), true);
    assert.equal(audio.paused, true);
    assert.equal(fakePlayer.dataset.state, 'paused', 'Pause has a distinct visible state');
    assert.equal(externalOpenCount, 0, 'Pause also stays inside the Radar');

    assert.equal(await player.requestPlay(fakePlayer), true);
    audio.currentTime = 30;
    audio.paused = true;
    audio.ended = true;
    audio.dispatch('ended');
    assert.equal(fakePlayer.dataset.state, 'ended', 'the ended event exposes a replay state');
    assert.equal(await player.requestPlay(fakePlayer), true);
    assert.equal(audio.currentTime, 0, 'replaying an ended preview starts from zero');
    assert.equal(audioConstructions, 1, 'replays do not create competing audio engines');

    audio.error = {code: 4};
    audio.dispatch('error');
    assert.equal(fakePlayer.dataset.state, 'unavailable', 'native media errors are visible');
    assert.equal(externalOpenCount, 0, 'no audio state opens Spotify');
    player.clear();
  } finally {
    restoreGlobal('Audio', originalGlobals.Audio);
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('open', originalGlobals.open);
    restoreGlobal('SPOTIFY_PREVIEW_AUDIO', originalGlobals.previewData);
    restoreGlobal('SpotifyRadarPlayer', originalGlobals.player);
    delete require.cache[require.resolve(playerPath)];
  }

  assert.match(playerSource, /function ensureAudio\(\)[\s\S]*AUDIO=new global\.Audio\(\)/,
    'the custom transport is backed by native HTMLAudio');
  for (const eventName of ['loadstart', 'loadedmetadata', 'durationchange', 'timeupdate', 'play', 'playing', 'waiting', 'stalled', 'pause', 'ended', 'error', 'abort']) {
    assert.match(playerSource, new RegExp("audio\\.addEventListener\\('" + eventName + "'"),
      'the native ' + eventName + ' state is handled');
  }
  assert.match(playerSource, /function seek\(control\)[\s\S]*audio\.currentTime=position\/1000/,
    'seek controls native currentTime');
  assert.match(playerSource, /function setVolume\(value\)[\s\S]*AUDIO\.volume=next/,
    'volume controls native audio');
  assert.doesNotMatch(playerSource, /SpotifyRadarAuth|Spotify\.Player|onSpotifyWebPlaybackSDKReady|\/v1\/me\/player|window\.open|global\.open|location\.(?:assign|replace)/,
    'the player has no OAuth, Web Playback SDK, transfer, or external Play path');
  assert.doesNotMatch(playerSource, /<iframe\b|\/embed\//i, 'the player never mounts a Spotify iframe');

  assert.match(playerCss, /spotify-radar-player\{[\s\S]*display:grid!important[\s\S]*background:linear-gradient/);
  assert.match(playerCss, /spotify-radar-player--transport\{[\s\S]*grid-template-areas:"toggle timeline volume source"/);
  assert.match(playerCss, /spotify-radar-player-wave canvas/);
  assert.match(playerCss, /spotify-radar-player-volume-range/);
  assert.match(playerCss, /spotify-radar-player-attribution[\s\S]*grid-area:source/);
  assert.doesNotMatch(playerCss, /spotify-radar-auth|spotify-radar-player-(?:embed|engine)|iframe/,
    'the stylesheet contains no login or embed surface');

  assert.match(
    dashboard,
    /spotifyTrackPlayerHtml\(\s*r\[6\]\s*,\s*r\[1\]\s*,\s*A\[r\[0\]\]\[0\]\s*,\s*r\[8\]\s*,\s*'track-modal-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
    'track detail uses the shared native preview transport',
  );
  assert.match(
    dashboard,
    /spotifyTrackPlayerHtml\(\s*spotifyId\s*,\s*opportunity\.title\s*,\s*opportunity\.credit\s*,\s*arTrackCoverUrl\(opportunity\)\s*,\s*'ar-opportunity-player'\s*,\s*\{\s*transportOnly\s*:\s*true\s*\}\s*\)/,
    'A&R detail uses the shared native preview transport',
  );
  const playerFallback = dashboard.slice(
    dashboard.indexOf('function spotifyTrackPlayerHtml('),
    dashboard.indexOf('function hydrateSpotifyRadarPlayerCovers('),
  );
  assert.doesNotMatch(playerFallback, /<iframe\b|\/embed\/|window\.open|target="_blank"/i,
    'the dashboard fallback cannot restore an embed or external Play action');
  const playArTrack = dashboard.slice(
    dashboard.indexOf('function playArTrack(spotifyId){'),
    dashboard.indexOf('function arClusters()', dashboard.indexOf('function playArTrack(spotifyId){')),
  );
  assert.match(playArTrack, /SpotifyRadarPlayer\.requestPlay/);
  assert.doesNotMatch(playArTrack, /window\.open|location\.|target="_blank"|open\.spotify\.com/,
    'A&R row Play never leaves the Radar');

  const previewScriptIndex = index.indexOf('../Spotify_Preview_Audio_data.js?v=20260821-custom-preview-v1');
  const playerScriptIndex = index.indexOf('player.js?v=20260821-custom-preview-v1');
  const dashboardScriptIndex = index.indexOf('dashboard.js?v=20260821-custom-preview-v1');
  assert.ok(previewScriptIndex >= 0 && playerScriptIndex > previewScriptIndex && dashboardScriptIndex > playerScriptIndex,
    'preview data, custom player, then dashboard load in dependency order');
  assert.doesNotMatch(index, /auth\.js|sdk\.scdn\.co\/spotify-player\.js|open\.spotify\.com\/embed\/iframe-api/i,
    'the page loads neither auth, Web Playback SDK, nor Spotify iframe API');

  console.log('Spotify custom anonymous HTMLAudio preview player: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
