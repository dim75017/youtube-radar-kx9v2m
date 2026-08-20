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
const player = require(playerPath);
const pure = player.__test;

const spotifyId = '1234567890123456789012';
const markup = player.html({
  spotifyId,
  title: 'Night < Walk',
  artist: 'Lofi & Friends',
  artwork: 'https://i.scdn.co/image/cover',
  extraClass: 'track-modal-player',
});

assert.match(markup, /<section class="spotify-radar-player track-modal-player"/);
assert.match(markup, /aria-label="Lecteur Spotify · Night &lt; Walk"/);
assert.match(markup, /aria-label="Lire Night &lt; Walk"/);
assert.match(markup, /class="spotify-radar-player-seek"[^>]*type="range"|type="range"[^>]*class="spotify-radar-player-seek"/, 'the waveform exposes a native keyboard/pointer seek range');
assert.match(markup, /class="spotify-radar-player-seek"[^>]*disabled|disabled[^>]*class="spotify-radar-player-seek"/, 'seek stays disabled until Spotify reports a real duration');
assert.match(markup, /class="spotify-radar-player-seek"[^>]*aria-label="Progression de la piste"|aria-label="Progression de la piste"[^>]*class="spotify-radar-player-seek"/, 'the native seek range owns the timeline accessible name');
assert.doesNotMatch(markup, /role="progressbar"/, 'the decorative waveform must not compete with the native slider semantics');
assert.match(markup, /role="status" aria-live="polite"/);
assert.match(markup, /target="_blank" rel="noopener"/);
assert.match(markup, /Night &lt; Walk/);
assert.match(markup, /Lofi &amp; Friends/);
assert.equal(player.html({spotifyId: 'not-a-spotify-id', title: 'Invalid'}), '', 'invalid Spotify IDs must not render a broken player');
for (const fakeControl of ['volume', 'download', 'like', 'favorite', 'heart']) {
  assert.doesNotMatch(markup, new RegExp(`spotify-radar-player-${fakeControl}`, 'i'), `the player must not fake unsupported ${fakeControl} controls`);
}

assert.equal(pure.formatTime(0), '0:00');
assert.equal(pure.formatTime(65.9), '1:05');
assert.equal(pure.formatTime(3599.9), '59:59');
assert.equal(pure.formatTime(-1), '--:--');
assert.equal(pure.formatTime(Number.NaN), '--:--');

assert.deepEqual(
  pure.normalizePlaybackUpdate({data:{duration:215432,position:12654,isPaused:false,isBuffering:true,playingURI:`spotify:track:${spotifyId}`}}),
  {duration:215.432,position:12.654,paused:false,buffering:true,playingUri:`spotify:track:${spotifyId}`},
  'Spotify playback_update milliseconds must become display seconds',
);
assert.deepEqual(
  pure.normalizePlaybackUpdate({duration:1000,position:5000,isPaused:true}),
  {duration:1,position:1,paused:true,buffering:false,playingUri:''},
  'playback position must be clamped to the known duration',
);

const waveA = pure.waveHeights(spotifyId, 64);
const waveARepeat = pure.waveHeights(spotifyId, 64);
const waveB = pure.waveHeights('ABCDEFGHIJKLMNOPQRSTUV', 64);
assert.deepEqual(waveA, waveARepeat, 'the same track always receives the same visual waveform');
assert.notDeepEqual(waveA, waveB, 'different tracks receive distinct waveforms');
assert.equal(waveA.length, 64);
assert.ok(waveA.every(value => value >= .2 && value <= 1), 'wave bars stay inside their visual bounds');

function fakePlayer(title) {
  const button = {attributes:{},setAttribute(name,value){this.attributes[name]=value;}};
  const glyph = {dataset:{}};
  const status = {textContent:''};
  const strong = {textContent:title};
  return {
    dataset:{},button,glyph,status,
    querySelector(selector){
      if(selector === '.spotify-radar-player-toggle') return button;
      if(selector === '.spotify-radar-player-glyph') return glyph;
      if(selector === '.spotify-radar-player-status') return status;
      if(selector === '.spotify-radar-player-copy strong') return strong;
      return null;
    },
  };
}
const current = fakePlayer('Current');
const other = fakePlayer('Other');
let currentPauses = 0;
let otherPauses = 0;
pure.pauseOtherControllers(current, new Map([
  [current, {controller:{pause(){currentPauses += 1;}}}],
  [other, {controller:{pause(){otherPauses += 1;}}}],
]));
assert.equal(currentPauses, 0, 'exclusive playback must not pause the requested player');
assert.equal(otherPauses, 1, 'exclusive playback pauses every other active controller');
assert.equal(other.dataset.state, 'paused');
assert.equal(other.button.attributes['aria-pressed'], 'false');

// Lifecycle behavior: a hydrated controller is destroyed and unregistered when
// its modal/root is cleared, without needing a browser or the live Spotify API.
let destroyCalls = 0;
const controller = {addListener(){},destroy(){destroyCalls += 1;}};
const host = {};
const lifecyclePlayer = {
  dataset:{spotifyId},isConnected:true,_spotifyWaveObserver:null,
  querySelector(selector){
    if(selector === '.spotify-radar-player-wave canvas') return null;
    if(selector === '.spotify-radar-player-engine') return host;
    return null;
  },
};
const emptyDocument = {
  readyState:'loading',body:{},
  addEventListener(){},
  querySelectorAll(){return [];},
};
const lifecycleWindow = {document:emptyDocument};
const lifecycleModule = {exports:{}};
vm.runInNewContext(playerSource, {
  window:lifecycleWindow,module:lifecycleModule,exports:lifecycleModule.exports,
  globalThis:lifecycleWindow,console,Map,Math,Number,Object,Promise,RegExp,String,
  clearTimeout,setTimeout,encodeURIComponent,
});
const lifecycleApi = lifecycleWindow.SpotifyRadarPlayer;
lifecycleApi.setApi({createController(element,options,ready){
  assert.equal(element, host);
  assert.equal(options.uri, `spotify:track:${spotifyId}`);
  ready(controller);
}});
const lifecycleRoot = {
  querySelectorAll(selector){return selector === '.spotify-radar-player' ? [lifecyclePlayer] : [];},
  contains(node){return node === lifecyclePlayer;},
};
lifecycleApi.hydrate(lifecycleRoot);
assert.equal(lifecyclePlayer.dataset.spotifyHydrated, '1');
lifecycleApi.clear(lifecycleRoot);
assert.equal(destroyCalls, 1, 'clearing a modal must destroy its Spotify controller exactly once');
assert.equal(lifecyclePlayer.dataset.spotifyHydrated, undefined, 'clearing resets hydration state for a future remount');

function eventNode(initial={}) {
  const listeners = new Map();
  return Object.assign({
    attributes:{},disabled:false,value:'0',max:'0',textContent:'',dataset:{},
    addEventListener(type,listener){
      const entries=listeners.get(type)||[];entries.push(listener);listeners.set(type,entries);
    },
    dispatch(type){for(const listener of listeners.get(type)||[])listener({type,target:this,currentTarget:this});},
    setAttribute(name,value){this.attributes[name]=String(value);},
    removeAttribute(name){delete this.attributes[name];},
  },initial);
}
function controlledPlayer(id=spotifyId) {
  const nodes={
    toggle:eventNode(),glyph:eventNode(),status:eventNode(),strong:eventNode({textContent:'Controlled track'}),
    current:eventNode({textContent:'0:00'}),duration:eventNode({textContent:'--:--'}),wave:eventNode(),
    seek:eventNode({disabled:true}),host:{},
  };
  const result={
    dataset:{spotifyId:id},isConnected:true,nodes,
    querySelector(selector){
      return ({
        '.spotify-radar-player-wave canvas':null,
        '.spotify-radar-player-engine':nodes.host,
        '.spotify-radar-player-engine iframe':null,
        '.spotify-radar-player-toggle':nodes.toggle,
        '.spotify-radar-player-glyph':nodes.glyph,
        '.spotify-radar-player-status':nodes.status,
        '.spotify-radar-player-copy strong':nodes.strong,
        '.spotify-radar-player-current':nodes.current,
        '.spotify-radar-player-duration':nodes.duration,
        '.spotify-radar-player-wave':nodes.wave,
        '.spotify-radar-player-seek':nodes.seek,
      })[selector]||null;
    },
  };
  return result;
}
function controlledController() {
  const listeners=new Map();
  return {
    destroyCalls:0,playCalls:0,pauseCalls:0,seekCalls:[],
    addListener(type,listener){listeners.set(type,listener);},
    emit(type,data={}){const listener=listeners.get(type);if(listener)listener({data});},
    destroy(){this.destroyCalls+=1;},play(){this.playCalls+=1;},pause(){this.pauseCalls+=1;},
    togglePlay(){},seek(seconds){this.seekCalls.push(seconds);},
  };
}
function controlledHarness() {
  const callbacks=[];
  const harnessDocument={readyState:'loading',body:{},addEventListener(){},querySelectorAll(){return [];}};
  const harnessWindow={document:harnessDocument};
  const harnessModule={exports:{}};
  vm.runInNewContext(playerSource, {
    window:harnessWindow,module:harnessModule,exports:harnessModule.exports,
    globalThis:harnessWindow,console,Map,Math,Number,Object,Promise,RegExp,String,
    clearTimeout,setTimeout,encodeURIComponent,
  });
  const api=harnessWindow.SpotifyRadarPlayer;
  api.setApi({createController(host,options,ready){callbacks.push({host,options,ready});}});
  return {api,callbacks};
}
function playerRoot(...players){
  return {
    querySelectorAll(selector){return selector==='.spotify-radar-player'?players:[];},
    contains(node){return players.includes(node);},
  };
}

// Closing while the SDK itself is still loading must also cancel the pending
// intent. A later global API callback may not hydrate/autoplay the hidden modal;
// reopening explicitly reactivates it.
{
  const waitingPlayer=controlledPlayer(),callbacks=[];
  const waitingDocument={
    readyState:'loading',body:{},addEventListener(){},
    querySelectorAll(selector){return selector==='.spotify-radar-player'?[waitingPlayer]:[];},
  };
  const waitingWindow={document:waitingDocument},waitingModule={exports:{}};
  vm.runInNewContext(playerSource,{
    window:waitingWindow,module:waitingModule,exports:waitingModule.exports,
    globalThis:waitingWindow,console,Map,Math,Number,Object,Promise,RegExp,String,
    clearTimeout,setTimeout,encodeURIComponent,
  });
  const waitingApi=waitingWindow.SpotifyRadarPlayer,waitingRoot=playerRoot(waitingPlayer);
  waitingApi.requestPlay(waitingPlayer);
  waitingApi.clear(waitingRoot);
  waitingApi.setApi({createController(host,options,ready){callbacks.push({host,options,ready});}});
  assert.equal(callbacks.length,0,'a late SDK callback must not hydrate a player in a modal closed before API readiness');
  waitingApi.hydrate(waitingRoot);
  assert.equal(callbacks.length,1,'explicit reopening reactivates the cleared player');
  waitingApi.clear(waitingRoot);
}

// An async createController callback may arrive after its modal was already
// cleared. It must destroy the orphan controller instead of resurrecting it.
{
  const harness=controlledHarness(),latePlayer=controlledPlayer();
  const lateRoot=playerRoot(latePlayer);
  harness.api.hydrate(lateRoot);
  assert.equal(harness.callbacks.length,1);
  harness.api.clear(lateRoot);
  const lateController=controlledController();
  harness.callbacks[0].ready(lateController);
  assert.equal(lateController.destroyCalls,1,'a createController callback arriving after clear is destroyed immediately');
  harness.api.requestPlay(latePlayer);
  assert.equal(lateController.playCalls,0,'a stale callback must never be re-registered as the active instance');
  harness.api.clear(lateRoot);
}

// If two generations resolve backwards, only the latest generation can own the
// DOM player. The old controller is destroyed even though its node is connected.
{
  const harness=controlledHarness(),generationPlayer=controlledPlayer();
  const generationRoot=playerRoot(generationPlayer);
  harness.api.hydrate(generationRoot);
  const firstCallback=harness.callbacks[0];
  harness.api.clear(generationRoot);
  harness.api.hydrate(generationRoot);
  const secondCallback=harness.callbacks[1];
  const currentController=controlledController(),staleController=controlledController();
  secondCallback.ready(currentController);
  firstCallback.ready(staleController);
  assert.equal(staleController.destroyCalls,1,'an older reversed callback is destroyed');
  currentController.emit('ready');
  harness.api.requestPlay(generationPlayer);
  assert.equal(currentController.playCalls,1,'the latest controller generation remains active');
  assert.equal(staleController.playCalls,0,'the older controller never receives playback intents');
  harness.api.clear(generationRoot);
  assert.equal(currentController.destroyCalls,1,'the retained generation is destroyed on final cleanup');
}

// A newer intent cancels pending autoplay on another controller that is still
// loading, preventing both tracks from starting when ready events race.
{
  const harness=controlledHarness(),first=controlledPlayer(),second=controlledPlayer('ABCDEFGHIJKLMNOPQRSTUV');
  const rootForBoth=playerRoot(first,second);
  harness.api.hydrate(rootForBoth);
  const firstController=controlledController(),secondController=controlledController();
  harness.callbacks[0].ready(firstController);harness.callbacks[1].ready(secondController);
  harness.api.requestPlay(first);
  harness.api.requestPlay(second);
  firstController.emit('ready');
  secondController.emit('ready');
  assert.equal(firstController.playCalls,0,'a superseded pending player must not autoplay later');
  assert.equal(secondController.playCalls,1,'only the latest pending intent autoplays');
  harness.api.clear(rootForBoth);
}

// The native range is inert before duration, becomes accessible once Spotify
// reports duration, and forwards both pointer/keyboard-style input values.
{
  const harness=controlledHarness(),seekPlayer=controlledPlayer();
  const seekRoot=playerRoot(seekPlayer),seekController=controlledController();
  harness.api.hydrate(seekRoot);harness.callbacks[0].ready(seekController);
  seekPlayer.nodes.seek.value='14';seekPlayer.nodes.seek.dispatch('input');
  assert.deepEqual(seekController.seekCalls,[],'seek is inert before a real duration');
  seekController.emit('playback_update',{duration:0,position:0,isPaused:true});
  assert.equal(seekPlayer.nodes.seek.disabled,true,'zero/unknown duration keeps seek disabled');
  seekController.emit('playback_update',{duration:215432,position:12654,isPaused:true});
  assert.equal(seekPlayer.nodes.seek.disabled,false,'a real duration enables the seek range');
  assert.equal(Number(seekPlayer.nodes.seek.max),215.432);
  assert.equal(Number(seekPlayer.nodes.seek.value),12.654);
  seekPlayer.nodes.seek.value='42';seekPlayer.nodes.seek.dispatch('input');
  seekPlayer.nodes.seek.value='70';seekPlayer.nodes.seek.dispatch('change');
  assert.deepEqual(seekController.seekCalls,[42,70],'pointer/input and keyboard/change seek in seconds');
  harness.api.clear(seekRoot);
}

for (const required of [
  "spotifyTrackPlayerHtml(r[6],r[1],A[r[0]][0],r[8],'track-modal-player')",
  'arOpportunityPlayerHtml(opportunity)',
  "spotifyTrackPlayerHtml(selectedTrack.spotifyId,selectedTrack.title,selectedTrack.artist,arTrackCoverUrl(selectedTrack),'ar-player')",
  'mountSpotifyRadarPlayers(box)',
  'mountSpotifyRadarPlayers(V)',
  'clearSpotifyPlayers(modal)',
]) assert.ok(dashboard.includes(required), `shared player callsite/lifecycle hook is missing: ${required}`);

assert.match(playerCss, /\.spotify-radar-player\{/);
assert.match(playerCss, /@container \(max-width:720px\)/);
assert.match(playerCss, /@media\(prefers-reduced-motion:reduce\)/);
assert.match(index, /player\.css\?v=20260820-custom-player-v1/);
assert.match(index, /player\.js\?v=20260820-custom-player-v1/);
assert.match(index, /dashboard\.js\?v=20260820-custom-player-v1/);
assert.match(index, /<script src="https:\/\/open\.spotify\.com\/embed\/iframe-api\/v1" async><\/script>/);
assert.ok(index.indexOf('player.js?v=20260820-custom-player-v1') < index.indexOf('dashboard.js?v=20260820-custom-player-v1'), 'the shared player must load before dashboard callsites');
assert.ok(index.indexOf('player.js?v=20260820-custom-player-v1') < index.indexOf('embed/iframe-api/v1'), 'the API callback must exist before the async Spotify SDK can fire');

console.log('Spotify custom player behavior and integration: OK');
