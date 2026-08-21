'use strict';

/* Spotify Radar full-track player
   --------------------------------
   The Radar renders its own transport and uses Spotify's Web Playback SDK for
   licensed, full-track playback. It never mounts a Spotify Embed iframe and
   never turns the primary Play action into an external Spotify link.

   Spotify requires a Premium account and a public application Client ID. The
   Client ID is configured once in the Radar; OAuth uses Authorization Code
   with PKCE, while access/refresh tokens remain in sessionStorage (auth.js). */
(function spotifyRadarPlayerModule(global){
  const doc=global&&global.document;
  const PLAYERS=new Set();
  const RESIZE_OBSERVERS=new Map();
  const SDK_WAITERS=[];
  const DEVICE_WAITERS=[];
  const VOLUME_SUPPORTED=supportsSdkVolume();
  const DEFAULT_LABELS=Object.freeze({
    player:'Lecteur Radar · Spotify Premium',
    play:'Lire', pause:'Pause', loading:'Connexion au lecteur Spotify…', buffering:'Chargement du titre…',
    ready:'Prêt à écouter', setup:'Configurer Spotify Premium pour écouter le titre entier',
    connect:'Connecter Spotify Premium pour écouter le titre entier',
    premium:'Un compte Spotify Premium est requis pour la lecture intégrale',
    unavailable:'Lecture intégrale momentanément indisponible', progress:'Progression du titre',
    volume:'Volume', mute:'Couper le son', unmute:'Rétablir le son', source:'Source Spotify', settings:'Configurer Spotify Premium',
  });
  let SDK_PLAYER=null;
  let SDK_DEVICE_ID='';
  let SDK_CONNECT_PROMISE=null;
  let SDK_LOAD_TIMEOUT=null;
  let ACTIVE_TRACK_ID='';
  let ACTIVE_BASELINE=null;
  let ACTIVE_INTENT=0;
  let PENDING_PLAYER=null;
  let AUTH_PROMISE=null;
  let AUTH_RECOVERY_PROMISE=null;
  let TICK_TIMER=null;
  let CURRENT_VOLUME=readStoredVolume();
  let LAST_AUDIBLE_VOLUME=CURRENT_VOLUME>0?CURRENT_VOLUME:.72;

  function escapeHtml(value){
    return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function spotifyTrackId(value){
    const id=String(value||'').trim();
    return /^[A-Za-z0-9]{22}$/.test(id)?id:'';
  }
  function spotifyTrackUrl(value){
    const id=spotifyTrackId(value);
    return id?`https://open.spotify.com/track/${encodeURIComponent(id)}?locale=en`:'';
  }
  function trackIdFromUri(value){
    const match=String(value||'').match(/^spotify:track:([A-Za-z0-9]{22})$/);
    return match?match[1]:'';
  }
  function safeArtwork(value){
    const url=String(value||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  }
  function cleanClasses(value){
    return String(value||'').split(/\s+/).filter(token=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)).join(' ');
  }
  function clamp(value,min,max){return Math.min(max,Math.max(min,Number(value)||0));}
  function supportsSdkVolume(){
    const navigator=global&&global.navigator||{},agent=String(navigator.userAgent||''),platform=String(navigator.platform||'');
    const ios=/iPad|iPhone|iPod/i.test(agent)||(platform==='MacIntel'&&Number(navigator.maxTouchPoints)>1);
    return !ios;
  }
  function formatTimeMs(milliseconds){
    const value=Number(milliseconds);
    if(!Number.isFinite(value)||value<0)return '--:--';
    const total=Math.floor(value/1000),minutes=Math.floor(total/60),seconds=total%60;
    return `${minutes}:${String(seconds).padStart(2,'0')}`;
  }
  function waveHeights(seed,count=128){
    let hash=7;
    for(const character of String(seed||''))hash=((hash*31)+character.charCodeAt(0))>>>0;
    return Array.from({length:Math.max(1,Number(count)||1)},(_,index)=>{
      const position=count>1?index/(count-1):0;
      const detail=Math.abs(Math.sin((index+hash)*.613))*.44+Math.abs(Math.sin((index+hash)*.173+1.4))*.31;
      const envelope=.65+Math.abs(Math.sin((index+hash)*.041+.8))*.35;
      const tail=position>.9?Math.max(.14,(1-position)/.1):1;
      return Math.max(.18,Math.min(1,(.27+detail)*envelope*tail));
    });
  }
  function labelsFor(options){return Object.assign({},DEFAULT_LABELS,options&&options.labels||{});}
  function authProvider(){return global&&global.SpotifyRadarAuth||null;}
  function authClientId(){
    const auth=authProvider();
    try{return auth&&typeof auth.clientId==='function'?String(auth.clientId()||'').trim():'';}catch(error){return '';}
  }
  function authConnected(){
    const auth=authProvider();
    try{return Boolean(auth&&typeof auth.isConnected==='function'&&auth.isConnected());}catch(error){return false;}
  }
  function readStoredVolume(){
    try{
      const value=Number(global.localStorage&&global.localStorage.getItem('lofiRadarSpotifyVolume'));
      return Number.isFinite(value)?clamp(value,0,1):.72;
    }catch(error){return .72;}
  }
  function storeVolume(value){
    try{if(global.localStorage)global.localStorage.setItem('lofiRadarSpotifyVolume',String(clamp(value,0,1)));}catch(error){}
  }
  function icon(kind){
    if(kind==='volume')return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.8 8.5H3.5v7h3.3L11 19V5Z"/><path class="volume-wave" d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.5a7.8 7.8 0 0 1 0 11"/><path class="volume-cut" d="m15.5 9 5 6m0-6-5 6"/></svg>';
    if(kind==='spotify')return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.31-1.76-8.8-.96a.625.625 0 1 1-.28-1.22c3.82-.87 7.09-.5 9.73 1.11.29.18.39.56.21.86Zm1.23-2.74a.78.78 0 0 1-1.08.26c-2.69-1.65-6.79-2.13-9.97-1.17a.782.782 0 1 1-.45-1.5c3.64-1.1 8.16-.56 11.24 1.32.37.23.48.71.26 1.09Zm.1-2.86C14.7 8.9 9.36 8.72 6.28 9.65a.94.94 0 1 1-.54-1.8c3.54-1.07 9.44-.86 13.14 1.33a.94.94 0 0 1-.96 1.64Z"/></svg>';
    if(kind==='settings')return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3.7 9.4 2h5.2l.7 1.7 1.7 1 1.8-.3 2.6 4.5-1.1 1.5v2l1.1 1.5-2.6 4.5-1.8-.3-1.7 1-.7 1.7H9.4l-.7-1.7-1.7-1-1.8.3-2.6-4.5 1.1-1.5v-2L2.6 8.9l2.6-4.5 1.8.3 1.7-1Z"/><circle cx="12" cy="11.4" r="3"/></svg>';
    return '';
  }
  function coverHtml(id,artwork){
    return artwork
      ?`<span class="spotify-radar-player-cover has-cover"><img src="${escapeHtml(artwork)}" alt="" loading="lazy" onerror="this.remove();this.parentNode.classList.remove('has-cover')"><span aria-hidden="true">♫</span></span>`
      :`<span class="spotify-radar-player-cover" data-spotify-player-cover-id="${id}"><span aria-hidden="true">♫</span></span>`;
  }
  function html(options={}){
    const id=spotifyTrackId(options.spotifyId||options.id);
    if(!id)return '';
    const title=String(options.title||'Track'),artist=String(options.artist||'Artiste non renseigné');
    const artwork=safeArtwork(options.artwork||options.cover),labels=labelsFor(options),spotifyUrl=spotifyTrackUrl(id);
    const extra=cleanClasses(options.context||options.extraClass),transportOnly=Boolean(options.transportOnly);
    const classes=['spotify-radar-player',transportOnly?'spotify-radar-player--transport':'',VOLUME_SUPPORTED?'':'spotify-radar-player--no-volume',extra].filter(Boolean).join(' ');
    const identity=transportOnly?'':`<div class="spotify-radar-player-main">${coverHtml(id,artwork)}<span class="spotify-radar-player-copy"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(artist)}">${escapeHtml(artist)}</small></span></div>`;
    const volume=VOLUME_SUPPORTED?`<div class="spotify-radar-player-volume">
        <button type="button" class="spotify-radar-player-volume-toggle" onclick="SpotifyRadarPlayer.mute(this)" aria-label="${escapeHtml(labels.mute)}" title="${escapeHtml(labels.mute)}">${icon('volume')}</button>
        <input class="spotify-radar-player-volume-range" type="range" min="0" max="100" value="${Math.round(CURRENT_VOLUME*100)}" step="1" aria-label="${escapeHtml(labels.volume)}">
      </div>`:'';
    return `<div class="spotify-radar-player-frame"><section class="${classes}" data-spotify-id="${id}" data-title="${escapeHtml(title)}" data-state="disconnected" data-label-play="${escapeHtml(labels.play)}" data-label-pause="${escapeHtml(labels.pause)}" data-label-loading="${escapeHtml(labels.loading)}" data-label-buffering="${escapeHtml(labels.buffering)}" data-label-ready="${escapeHtml(labels.ready)}" data-label-setup="${escapeHtml(labels.setup)}" data-label-connect="${escapeHtml(labels.connect)}" data-label-premium="${escapeHtml(labels.premium)}" data-label-unavailable="${escapeHtml(labels.unavailable)}" aria-label="${escapeHtml(labels.player)} · ${escapeHtml(title)}">
      ${identity}
      <button class="spotify-radar-player-toggle" type="button" onclick="SpotifyRadarPlayer.toggle(this)" aria-label="${escapeHtml(labels.play)} · ${escapeHtml(title)}" aria-pressed="false"><span class="spotify-radar-player-glyph" data-icon="play" aria-hidden="true"></span></button>
      <div class="spotify-radar-player-timeline">
        <time class="spotify-radar-player-current">0:00</time>
        <div class="spotify-radar-player-wave"><canvas aria-hidden="true"></canvas><input class="spotify-radar-player-seek" type="range" min="0" max="1000" value="0" step="1" disabled aria-label="${escapeHtml(labels.progress)} · ${escapeHtml(title)}" aria-valuetext="0:00 / --:--"></div>
        <time class="spotify-radar-player-duration">--:--</time>
      </div>
      ${volume}
      <a class="spotify-radar-player-attribution" href="${escapeHtml(spotifyUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(labels.source)} · ${escapeHtml(title)}" title="${escapeHtml(labels.source)}">${icon('spotify')}</a>
      <button type="button" class="spotify-radar-player-settings" onclick="SpotifyRadarPlayer.configure(this)" aria-label="${escapeHtml(labels.settings)}" title="${escapeHtml(labels.settings)}">${icon('settings')}</button>
      <span class="spotify-radar-player-status" role="status" aria-live="polite">${escapeHtml(labels.connect)}</span>
    </section></div>`;
  }
  function playerFrom(control){
    if(!control)return null;
    if(control.matches&&control.matches('.spotify-radar-player'))return control;
    return typeof control.closest==='function'?control.closest('.spotify-radar-player'):null;
  }
  function playerLabel(player,key,fallback){return player&&player.dataset&&player.dataset[key]||fallback;}
  function playersForTrack(id){return [...PLAYERS].filter(player=>player&&player.isConnected!==false&&player.dataset.spotifyId===id);}
  function setUiState(player,state,text=''){
    if(!player)return;
    player.dataset.state=state;
    const playing=state==='playing',loading=['loading','buffering','connecting'].includes(state);
    const button=player.querySelector('.spotify-radar-player-toggle'),glyph=player.querySelector('.spotify-radar-player-glyph');
    const status=player.querySelector('.spotify-radar-player-status'),title=player.dataset.title||'Track';
    if(button){
      button.setAttribute('aria-pressed',playing?'true':'false');
      button.setAttribute('aria-label',`${playerLabel(player,playing?'labelPause':'labelPlay',playing?'Pause':'Lire')} · ${title}`);
    }
    if(glyph)glyph.dataset.icon=playing?'pause':loading?'loading':'play';
    if(status){
      let fallback=DEFAULT_LABELS.ready;
      if(state==='needs-setup')fallback=playerLabel(player,'labelSetup',DEFAULT_LABELS.setup);
      else if(state==='disconnected')fallback=playerLabel(player,'labelConnect',DEFAULT_LABELS.connect);
      else if(state==='premium-required')fallback=playerLabel(player,'labelPremium',DEFAULT_LABELS.premium);
      else if(state==='unavailable')fallback=playerLabel(player,'labelUnavailable',DEFAULT_LABELS.unavailable);
      else if(state==='loading'||state==='connecting')fallback=playerLabel(player,'labelLoading',DEFAULT_LABELS.loading);
      else if(state==='buffering')fallback=playerLabel(player,'labelBuffering',DEFAULT_LABELS.buffering);
      else fallback=playerLabel(player,'labelReady',DEFAULT_LABELS.ready);
      status.textContent=text||fallback;
    }
  }
  function drawWave(player,progress=0){
    const canvas=player&&player.querySelector&&player.querySelector('.spotify-radar-player-wave canvas');
    if(!canvas||typeof canvas.getContext!=='function')return;
    const width=canvas.clientWidth||420,height=canvas.clientHeight||38,ratio=Math.min(Number(global.devicePixelRatio)||1,2);
    const targetWidth=Math.max(1,Math.round(width*ratio)),targetHeight=Math.max(1,Math.round(height*ratio));
    if(canvas.width!==targetWidth)canvas.width=targetWidth;if(canvas.height!==targetHeight)canvas.height=targetHeight;
    const context=canvas.getContext('2d');if(!context)return;
    context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
    const pitch=3.55,barWidth=1.35,count=Math.max(1,Math.floor(width/pitch));
    const heights=waveHeights(player.dataset.spotifyId,count),played=Math.round(clamp(progress,0,1)*count);
    let base='#626b80',accent='#1ed760';
    if(typeof global.getComputedStyle==='function'){
      const style=global.getComputedStyle(canvas);base=style.color||base;accent=style.getPropertyValue('--spotify-player-accent').trim()||accent;
    }
    heights.forEach((amplitude,index)=>{
      const barHeight=Math.max(3,Math.round(height*amplitude));context.globalAlpha=index<played?1:.28;context.fillStyle=index<played?accent:base;
      context.fillRect(Math.round(index*pitch),Math.round((height-barHeight)/2),barWidth,barHeight);
    });context.globalAlpha=1;
  }
  function updateTimeline(player,positionMs,durationMs,options={}){
    if(!player)return;
    const seek=player.querySelector('.spotify-radar-player-seek');
    if(seek&&seek.dataset.previewing==='1'&&!options.fromScrub)return;
    const duration=Number(durationMs)>0?Number(durationMs):0,position=duration?clamp(positionMs,0,duration):Math.max(0,Number(positionMs)||0);
    const current=player.querySelector('.spotify-radar-player-current'),total=player.querySelector('.spotify-radar-player-duration');
    if(current)current.textContent=formatTimeMs(position);if(total)total.textContent=duration?formatTimeMs(duration):'--:--';
    player.dataset.positionMs=String(Math.round(position));player.dataset.durationMs=duration?String(Math.round(duration)):'';
    drawWave(player,duration?position/duration:0);
    if(seek&&!options.preserveSeek){
      seek.value=duration?String(Math.round(position/duration*1000)):'0';
      const seekingDisallowed=options.seekingDisallowed===true||Boolean(player.dataset.spotifyId===ACTIVE_TRACK_ID&&ACTIVE_BASELINE&&ACTIVE_BASELINE.seekingDisallowed);
      seek.disabled=!(duration&&player.dataset.spotifyId===ACTIVE_TRACK_ID&&SDK_PLAYER&&SDK_DEVICE_ID&&!seekingDisallowed);
      seek.setAttribute('aria-valuetext',`${formatTimeMs(position)} / ${duration?formatTimeMs(duration):'--:--'}`);
    }
  }
  function normalizeSdkState(state){
    if(!state||typeof state!=='object')return null;
    const current=state.track_window&&state.track_window.current_track||{};
    const id=spotifyTrackId(current.id)||trackIdFromUri(current.uri||state.uri||''),durationMs=Number(state.duration||current.duration_ms)||0;
    const positionMs=clamp(state.position||0,0,durationMs||Number.MAX_SAFE_INTEGER);
    return {id,durationMs,positionMs,paused:Boolean(state.paused),loading:Boolean(state.loading),seekingDisallowed:Boolean(state.disallows&&state.disallows.seeking),timestamp:Date.now()};
  }
  function stopTicker(){if(TICK_TIMER){clearInterval(TICK_TIMER);TICK_TIMER=null;}}
  function startTicker(){
    stopTicker();if(!ACTIVE_BASELINE||ACTIVE_BASELINE.paused||!ACTIVE_BASELINE.durationMs)return;
    TICK_TIMER=setInterval(()=>{
      if(!ACTIVE_BASELINE||ACTIVE_BASELINE.paused){stopTicker();return;}
      const position=Math.min(ACTIVE_BASELINE.durationMs,ACTIVE_BASELINE.positionMs+(Date.now()-ACTIVE_BASELINE.timestamp));
      playersForTrack(ACTIVE_TRACK_ID).forEach(player=>updateTimeline(player,position,ACTIVE_BASELINE.durationMs));
      if(position>=ACTIVE_BASELINE.durationMs)stopTicker();
    },250);
  }
  function handleSdkState(state){
    const snapshot=normalizeSdkState(state);
    if(!snapshot||!snapshot.id){
      freezePlayback('ready');ACTIVE_TRACK_ID='';ACTIVE_BASELINE=null;PLAYERS.forEach(refreshConnectionState);return;
    }
    const previousId=ACTIVE_TRACK_ID;ACTIVE_TRACK_ID=snapshot.id;ACTIVE_BASELINE=snapshot;
    PLAYERS.forEach(player=>{
      if(player.dataset.spotifyId===snapshot.id){updateTimeline(player,snapshot.positionMs,snapshot.durationMs);setUiState(player,snapshot.loading?'buffering':snapshot.paused?'ready':'playing');}
      else if(player.dataset.spotifyId===previousId||['playing','buffering','loading'].includes(player.dataset.state)){updateTimeline(player,0,Number(player.dataset.durationMs)||0);refreshConnectionState(player);}
    });
    if(snapshot.paused)stopTicker();else startTicker();
  }
  function updateVolumeUi(){
    PLAYERS.forEach(player=>{
      const range=player.querySelector('.spotify-radar-player-volume-range'),button=player.querySelector('.spotify-radar-player-volume-toggle');
      if(range)range.value=String(Math.round(CURRENT_VOLUME*100));
      if(button){const muted=CURRENT_VOLUME<=.001;button.dataset.muted=muted?'1':'0';button.setAttribute('aria-label',muted?DEFAULT_LABELS.unmute:DEFAULT_LABELS.mute);button.title=muted?DEFAULT_LABELS.unmute:DEFAULT_LABELS.mute;}
    });
  }
  function refreshConnectionState(player){
    if(!player)return;
    if(!authClientId()){setUiState(player,'needs-setup');return;}
    if(!authConnected()){setUiState(player,'disconnected');return;}
    setUiState(player,'ready');
  }
  function resolveSdkWaiters(){while(SDK_WAITERS.length){const waiter=SDK_WAITERS.shift();clearTimeout(waiter.timer);waiter.resolve(global.Spotify);}}
  function rejectDeviceWaiters(error){while(DEVICE_WAITERS.length){const waiter=DEVICE_WAITERS.shift();clearTimeout(waiter.timer);waiter.reject(error);}}
  function resolveDeviceWaiters(deviceId){while(DEVICE_WAITERS.length){const waiter=DEVICE_WAITERS.shift();clearTimeout(waiter.timer);waiter.resolve(deviceId);}}
  function waitForSdk(){
    if(global.Spotify&&typeof global.Spotify.Player==='function')return Promise.resolve(global.Spotify);
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,timer:null};waiter.timer=setTimeout(()=>{const index=SDK_WAITERS.indexOf(waiter);if(index>=0)SDK_WAITERS.splice(index,1);reject(new Error('spotify_sdk_timeout'));},12000);SDK_WAITERS.push(waiter);
    });
  }
  function waitForDevice(){
    if(SDK_DEVICE_ID)return Promise.resolve(SDK_DEVICE_ID);
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,timer:null};waiter.timer=setTimeout(()=>{const index=DEVICE_WAITERS.indexOf(waiter);if(index>=0)DEVICE_WAITERS.splice(index,1);reject(new Error('spotify_device_timeout'));},15000);DEVICE_WAITERS.push(waiter);
    });
  }
  async function accessToken(options){
    const auth=authProvider();if(!auth||typeof auth.accessToken!=='function')throw new Error('spotify_auth_unavailable');
    const token=await auth.accessToken(options);if(!token)throw new Error('spotify_auth_required');return token;
  }
  function broadcastError(state,message){PLAYERS.forEach(player=>setUiState(player,state,message));}
  function freezePlayback(state,message){
    stopTicker();
    if(ACTIVE_BASELINE){
      const elapsed=ACTIVE_BASELINE.paused?0:Math.max(0,Date.now()-ACTIVE_BASELINE.timestamp);
      ACTIVE_BASELINE.positionMs=clamp(ACTIVE_BASELINE.positionMs+elapsed,0,ACTIVE_BASELINE.durationMs||Number.MAX_SAFE_INTEGER);
      ACTIVE_BASELINE.paused=true;ACTIVE_BASELINE.loading=false;ACTIVE_BASELINE.timestamp=Date.now();
      playersForTrack(ACTIVE_TRACK_ID).forEach(player=>updateTimeline(player,ACTIVE_BASELINE.positionMs,ACTIVE_BASELINE.durationMs));
    }
    broadcastError(state,message);
  }
  function recoverAuthentication(message){
    SDK_DEVICE_ID='';freezePlayback('disconnected',message||DEFAULT_LABELS.connect);ACTIVE_BASELINE=null;
    rejectDeviceWaiters(new Error(message||'spotify_authentication_error'));
    if(SDK_PLAYER&&typeof SDK_PLAYER.disconnect==='function'){try{Promise.resolve(SDK_PLAYER.disconnect()).catch(()=>{});}catch(error){}}
    const auth=authProvider();if(!auth||typeof auth.accessToken!=='function')return;
    if(!AUTH_RECOVERY_PROMISE){
      AUTH_RECOVERY_PROMISE=Promise.resolve(auth.accessToken({forceRefresh:true})).then(token=>{
        if(!token)throw new Error('spotify_auth_required');
        PLAYERS.forEach(refreshConnectionState);
        const pending=PENDING_PLAYER||playersForTrack(ACTIVE_TRACK_ID)[0];if(pending)requestPlay(pending);
      }).catch(()=>{
        try{if(typeof auth.disconnect==='function')auth.disconnect();}catch(error){}
        broadcastError('disconnected',DEFAULT_LABELS.connect);
      }).finally(()=>{AUTH_RECOVERY_PROMISE=null;});
    }
  }
  function prepareSdkPlayer(){
    if(SDK_PLAYER||!global.Spotify||typeof global.Spotify.Player!=='function')return SDK_PLAYER;
    SDK_PLAYER=new global.Spotify.Player({name:'Lofi Radar',volume:CURRENT_VOLUME,getOAuthToken:callback=>{accessToken().then(token=>callback(token)).catch(()=>{callback('');broadcastError('disconnected');});}});
    SDK_PLAYER.addListener('ready',event=>{SDK_DEVICE_ID=String(event&&event.device_id||'');if(SDK_DEVICE_ID)resolveDeviceWaiters(SDK_DEVICE_ID);});
    SDK_PLAYER.addListener('not_ready',event=>{if(!event||!event.device_id||event.device_id===SDK_DEVICE_ID){SDK_DEVICE_ID='';freezePlayback('unavailable','Connexion au lecteur Spotify interrompue');}});
    SDK_PLAYER.addListener('player_state_changed',handleSdkState);
    SDK_PLAYER.addListener('autoplay_failed',()=>{freezePlayback('autoplay-blocked','Le navigateur a bloqué le démarrage. Cliquez à nouveau sur Play.');});
    SDK_PLAYER.addListener('initialization_error',event=>{const message=event&&event.message||DEFAULT_LABELS.unavailable;SDK_DEVICE_ID='';rejectDeviceWaiters(new Error(message));freezePlayback('unavailable',message);ACTIVE_BASELINE=null;});
    SDK_PLAYER.addListener('authentication_error',event=>{recoverAuthentication(event&&event.message||DEFAULT_LABELS.connect);});
    SDK_PLAYER.addListener('account_error',event=>{const message=event&&event.message||DEFAULT_LABELS.premium;SDK_DEVICE_ID='';rejectDeviceWaiters(new Error(message));freezePlayback('premium-required',DEFAULT_LABELS.premium);ACTIVE_BASELINE=null;});
    SDK_PLAYER.addListener('playback_error',event=>{freezePlayback('unavailable',event&&event.message||DEFAULT_LABELS.unavailable);ACTIVE_BASELINE=null;});
    return SDK_PLAYER;
  }
  async function ensureDevice(){
    await waitForSdk();prepareSdkPlayer();if(SDK_DEVICE_ID)return SDK_DEVICE_ID;
    if(!SDK_CONNECT_PROMISE){SDK_CONNECT_PROMISE=(async()=>{const connected=await SDK_PLAYER.connect();if(!connected)throw new Error('spotify_sdk_connection_failed');return waitForDevice();})().finally(()=>{SDK_CONNECT_PROMISE=null;});}
    return SDK_CONNECT_PROMISE;
  }
  async function webApiPlay(id,deviceId,token,fetchImpl){
    const spotifyId=spotifyTrackId(id),device=String(deviceId||'').trim(),bearer=String(token||'').trim(),request=fetchImpl||global.fetch;
    if(!spotifyId||!device||!bearer||typeof request!=='function')throw new Error('spotify_playback_request_invalid');
    const response=await request(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device)}`,{method:'PUT',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({uris:[`spotify:track:${spotifyId}`]})});
    if(response&&response.ok)return true;
    let detail='';try{const payload=await response.json();detail=payload&&payload.error&&(payload.error.message||payload.error.reason)||'';}catch(error){}
    const failure=new Error(detail||`spotify_playback_http_${response&&response.status||0}`);failure.status=Number(response&&response.status)||0;throw failure;
  }
  async function requestAuthorization(player){
    const auth=authProvider();
    if(!authClientId()){openConfiguration(player);return false;}
    if(authConnected()){try{await accessToken();return true;}catch(error){}}
    if(!auth||typeof auth.begin!=='function'){openConfiguration(player);return false;}
    setUiState(player,'connecting');
    if(!AUTH_PROMISE){AUTH_PROMISE=(async()=>{await auth.begin({popup:true});await accessToken();return true;})().finally(()=>{AUTH_PROMISE=null;});}
    try{return await AUTH_PROMISE;}catch(error){if(String(error&&error.message||'').includes('popup'))setUiState(player,'disconnected','Connexion Spotify annulée');else setUiState(player,'disconnected');return false;}
  }
  async function startTrack(player,intent){
    if(!player||intent!==ACTIVE_INTENT)return;
    const id=spotifyTrackId(player.dataset.spotifyId);if(!id)return;
    const authorized=await requestAuthorization(player);if(!authorized||intent!==ACTIVE_INTENT)return;
    setUiState(player,'connecting');
    try{
      const device=await ensureDevice();if(intent!==ACTIVE_INTENT)return;
      let token=await accessToken();
      try{await webApiPlay(id,device,token);}catch(error){if(error&&error.status===401){token=await accessToken({forceRefresh:true});await webApiPlay(id,device,token);}else throw error;}
      if(intent!==ACTIVE_INTENT)return;ACTIVE_TRACK_ID=id;ACTIVE_BASELINE=null;PENDING_PLAYER=null;setUiState(player,'buffering');
    }catch(error){
      const status=Number(error&&error.status)||0,message=String(error&&error.message||'');
      if(status===401||/auth|token/i.test(message))setUiState(player,'disconnected');
      else if(status===403)setUiState(player,'premium-required');
      else setUiState(player,'unavailable',DEFAULT_LABELS.unavailable);
    }
  }
  function requestPlay(target){
    const player=playerFrom(target)||target;if(!player||!spotifyTrackId(player.dataset&&player.dataset.spotifyId))return;
    PENDING_PLAYER=player;const intent=++ACTIVE_INTENT;
    if(SDK_PLAYER&&typeof SDK_PLAYER.activateElement==='function'){try{SDK_PLAYER.activateElement();}catch(error){}}
    if(SDK_PLAYER&&SDK_DEVICE_ID&&ACTIVE_TRACK_ID===player.dataset.spotifyId&&ACTIVE_BASELINE){setUiState(player,'buffering');Promise.resolve(SDK_PLAYER.togglePlay()).catch(()=>setUiState(player,'unavailable'));return;}
    setUiState(player,authClientId()?'connecting':'needs-setup');startTrack(player,intent);
  }
  function toggle(control){requestPlay(playerFrom(control)||control);}
  function seek(control){
    const player=playerFrom(control);if(!player||!SDK_PLAYER||player.dataset.spotifyId!==ACTIVE_TRACK_ID)return;
    if(ACTIVE_BASELINE&&ACTIVE_BASELINE.seekingDisallowed)return;
    const duration=Number(player.dataset.durationMs)||0;if(!duration)return;
    const position=Math.round(clamp(control.value,0,1000)/1000*duration);control.dataset.previewing='';
    Promise.resolve(SDK_PLAYER.seek(position)).then(()=>{if(ACTIVE_BASELINE){ACTIVE_BASELINE.positionMs=position;ACTIVE_BASELINE.timestamp=Date.now();}playersForTrack(ACTIVE_TRACK_ID).forEach(item=>updateTimeline(item,position,duration));}).catch(()=>setUiState(player,'unavailable'));
  }
  function scrubSeek(control){
    const player=playerFrom(control);if(!player)return;const duration=Number(player.dataset.durationMs)||0;if(!duration)return;
    control.dataset.previewing='1';updateTimeline(player,clamp(control.value,0,1000)/1000*duration,duration,{preserveSeek:true,fromScrub:true});
  }
  function setVolume(value){
    if(!VOLUME_SUPPORTED)return;
    const previous=CURRENT_VOLUME,next=clamp(value,0,1);CURRENT_VOLUME=next;if(next>.001)LAST_AUDIBLE_VOLUME=next;storeVolume(next);updateVolumeUi();
    if(SDK_PLAYER&&typeof SDK_PLAYER.setVolume==='function')Promise.resolve(SDK_PLAYER.setVolume(next)).catch(async()=>{
      let actual=previous;
      try{if(typeof SDK_PLAYER.getVolume==='function')actual=clamp(await SDK_PLAYER.getVolume(),0,1);}catch(error){}
      CURRENT_VOLUME=actual;if(actual>.001)LAST_AUDIBLE_VOLUME=actual;storeVolume(actual);updateVolumeUi();
    });
  }
  function mute(){setVolume(CURRENT_VOLUME>.001?0:LAST_AUDIBLE_VOLUME||.72);}
  function openConfiguration(target){
    if(!doc)return;
    const player=playerFrom(target)||target;PENDING_PLAYER=player||PENDING_PLAYER;
    let modal=doc.getElementById('spotify-radar-auth-modal');
    if(modal){if(typeof modal._spotifyClose==='function')modal._spotifyClose({restoreFocus:false});else modal.remove();}
    const focusReturn=doc.activeElement;
    const auth=authProvider();let redirect='';
    try{redirect=auth&&typeof auth.redirectUri==='function'?auth.redirectUri():new URL('callback.html',global.location.href).href;}catch(error){}
    modal=doc.createElement('div');modal.id='spotify-radar-auth-modal';modal.className='spotify-radar-auth-modal';
    modal.innerHTML=`<section class="spotify-radar-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="spotify-radar-auth-title">
      <button type="button" class="spotify-radar-auth-close" aria-label="Fermer">×</button><div class="spotify-radar-auth-mark" aria-hidden="true">♫</div>
      <p class="spotify-radar-auth-kicker">LECTURE INTÉGRALE</p><h3 id="spotify-radar-auth-title">Connecter Spotify Premium</h3>
      <p class="spotify-radar-auth-intro">Le Radar utilise le Web Playback officiel pour lire les titres entiers ici, avec notre player. Aucun encart de préécoute et aucun Client Secret.</p>
      <form class="spotify-radar-auth-form">
        <label>Client ID public Spotify<input id="spotify-radar-client-id" inputmode="text" autocomplete="off" spellcheck="false" value="${escapeHtml(authClientId())}" placeholder="Ex. 0123456789abcdef…" required></label>
        <label>Redirect URI à ajouter dans l’app Spotify<div class="spotify-radar-auth-copy-row"><input id="spotify-radar-redirect-uri" value="${escapeHtml(redirect)}" readonly><button type="button" data-copy-redirect>Copier</button></div></label>
        <p class="spotify-radar-auth-help">Dans <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify Developer Dashboard</a>, créez une app Web Playback, ajoutez exactement cette Redirect URI, puis collez son Client ID ci-dessus. Le compte utilisé doit être Premium.</p>
        <p class="spotify-radar-auth-error" role="alert"></p>
        <div class="spotify-radar-auth-actions"><button type="submit" class="spotify-radar-auth-primary">Enregistrer et connecter</button>${authConnected()?'<button type="button" class="spotify-radar-auth-disconnect">Déconnecter ce compte</button>':''}</div>
      </form>
    </section>`;
    doc.body.appendChild(modal);
    const inerted=[...doc.body.children].filter(node=>node!==modal&&!node.hasAttribute('inert'));
    inerted.forEach(node=>node.setAttribute('inert',''));
    let closed=false;
    const focusables=()=>[...modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(node=>!node.hidden&&node.getAttribute('aria-hidden')!=='true');
    const close=(options={})=>{
      if(closed)return;closed=true;doc.removeEventListener('keydown',onModalKeydown,true);inerted.forEach(node=>node.removeAttribute('inert'));modal.remove();
      if(options.restoreFocus!==false&&focusReturn&&typeof focusReturn.focus==='function'&&focusReturn.isConnected!==false)focusReturn.focus();
    };
    const onModalKeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
      if(event.key!=='Tab')return;
      const nodes=focusables();if(!nodes.length){event.preventDefault();return;}
      const first=nodes[0],last=nodes[nodes.length-1],active=doc.activeElement;
      if(event.shiftKey&&(active===first||!modal.contains(active))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(active===last||!modal.contains(active))){event.preventDefault();first.focus();}
    };
    modal._spotifyClose=close;doc.addEventListener('keydown',onModalKeydown,true);
    modal.addEventListener('click',event=>{if(event.target===modal)close();});modal.querySelector('.spotify-radar-auth-close').addEventListener('click',()=>close());
    modal.querySelector('[data-copy-redirect]').addEventListener('click',async event=>{try{await global.navigator.clipboard.writeText(redirect);event.currentTarget.textContent='Copié';}catch(error){if(typeof global.prompt==='function')global.prompt('Copier la Redirect URI :',redirect);}});
    const disconnect=modal.querySelector('.spotify-radar-auth-disconnect');
    if(disconnect)disconnect.addEventListener('click',()=>{try{if(auth&&typeof auth.disconnect==='function')auth.disconnect();}catch(error){}if(SDK_PLAYER){try{SDK_PLAYER.disconnect();}catch(error){}}SDK_DEVICE_ID='';ACTIVE_TRACK_ID='';ACTIVE_BASELINE=null;stopTicker();close();PLAYERS.forEach(refreshConnectionState);});
    modal.querySelector('form').addEventListener('submit',event=>{
      event.preventDefault();const value=modal.querySelector('#spotify-radar-client-id').value.trim(),errorNode=modal.querySelector('.spotify-radar-auth-error');
      if(!/^[A-Za-z0-9]{16,32}$/.test(value)){errorNode.textContent='Le Client ID Spotify doit contenir entre 16 et 32 caractères.';return;}
      if(!auth||typeof auth.configure!=='function'){errorNode.textContent='Le module de connexion Spotify est indisponible.';return;}
      try{auth.configure(value);close();PLAYERS.forEach(refreshConnectionState);const pending=PENDING_PLAYER;if(pending)requestPlay(pending);}catch(error){errorNode.textContent='Impossible d’enregistrer ce Client ID.';}
    });
    const input=modal.querySelector('#spotify-radar-client-id');if(input)input.focus();
  }
  function configure(control){openConfiguration(control);}
  function bindPlayer(player){
    if(!player||player.dataset.spotifyPlayerBound==='1')return;
    player.dataset.spotifyPlayerBound='1';PLAYERS.add(player);
    const seekInput=player.querySelector('.spotify-radar-player-seek');if(seekInput){seekInput.addEventListener('input',()=>scrubSeek(seekInput));seekInput.addEventListener('change',()=>seek(seekInput));}
    const volume=player.querySelector('.spotify-radar-player-volume-range');if(volume)volume.addEventListener('input',()=>setVolume(Number(volume.value)/100));
    drawWave(player,0);updateVolumeUi();refreshConnectionState(player);
    if(ACTIVE_BASELINE&&player.dataset.spotifyId===ACTIVE_TRACK_ID){
      const position=ACTIVE_BASELINE.paused?ACTIVE_BASELINE.positionMs:Math.min(ACTIVE_BASELINE.durationMs,ACTIVE_BASELINE.positionMs+(Date.now()-ACTIVE_BASELINE.timestamp));
      updateTimeline(player,position,ACTIVE_BASELINE.durationMs);
      setUiState(player,ACTIVE_BASELINE.loading?'buffering':ACTIVE_BASELINE.paused?'ready':'playing');
      if(!ACTIVE_BASELINE.paused)startTicker();
    }
    const canvas=player.querySelector('.spotify-radar-player-wave canvas');
    if(canvas&&typeof global.ResizeObserver==='function'){const observer=new global.ResizeObserver(()=>{const duration=Number(player.dataset.durationMs)||0,position=Number(player.dataset.positionMs)||0;drawWave(player,duration?position/duration:0);});observer.observe(canvas);RESIZE_OBSERVERS.set(player,observer);}
  }
  function hydrate(root){
    if(!doc)return;const scope=root&&typeof root.querySelectorAll==='function'?root:doc,players=[];
    if(scope.matches&&scope.matches('.spotify-radar-player'))players.push(scope);scope.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));players.forEach(bindPlayer);
    if(global.Spotify&&typeof global.Spotify.Player==='function')prepareSdkPlayer();
  }
  function clear(root){
    let removedActiveControl=false;
    [...PLAYERS].forEach(player=>{
      if(root&&player!==root&&!(typeof root.contains==='function'&&root.contains(player)))return;
      if(player.dataset.spotifyId===ACTIVE_TRACK_ID)removedActiveControl=true;
      const observer=RESIZE_OBSERVERS.get(player);
      if(observer){try{observer.disconnect();}catch(error){}RESIZE_OBSERVERS.delete(player);}
      PLAYERS.delete(player);delete player.dataset.spotifyPlayerBound;
      if(PENDING_PLAYER===player)PENDING_PLAYER=null;
    });
    if(removedActiveControl&&ACTIVE_TRACK_ID&&!playersForTrack(ACTIVE_TRACK_ID).length){
      stopTicker();
      if(ACTIVE_BASELINE){
        const elapsed=ACTIVE_BASELINE.paused?0:Math.max(0,Date.now()-ACTIVE_BASELINE.timestamp);
        ACTIVE_BASELINE.positionMs=clamp(ACTIVE_BASELINE.positionMs+elapsed,0,ACTIVE_BASELINE.durationMs||Number.MAX_SAFE_INTEGER);
        ACTIVE_BASELINE.paused=true;ACTIVE_BASELINE.loading=false;ACTIVE_BASELINE.timestamp=Date.now();
      }
      if(SDK_PLAYER&&typeof SDK_PLAYER.pause==='function')Promise.resolve(SDK_PLAYER.pause()).catch(()=>{});
    }
    if(!PLAYERS.size)stopTicker();
  }
  function setCover(player,url){
    const cover=player&&player.querySelector&&player.querySelector('.spotify-radar-player-cover'),artwork=safeArtwork(url);if(!cover||!artwork||cover.querySelector('img')||!doc)return;
    const image=doc.createElement('img');image.src=artwork;image.alt='';image.loading='lazy';image.onerror=()=>{image.remove();cover.classList.remove('has-cover');};cover.prepend(image);cover.classList.add('has-cover');
  }
  function resumeAfterAuthentication(){PLAYERS.forEach(refreshConnectionState);const pending=PENDING_PLAYER;if(pending)requestPlay(pending);}
  function sdkReady(){clearTimeout(SDK_LOAD_TIMEOUT);resolveSdkWaiters();prepareSdkPlayer();}

  const api={html,hydrate,clear,toggle,requestPlay,seek,scrubSeek,setVolume,mute,configure,setCover};
  const previousSdkReady=global.onSpotifyWebPlaybackSDKReady;
  global.onSpotifyWebPlaybackSDKReady=()=>{if(typeof previousSdkReady==='function')previousSdkReady();sdkReady();};
  if(global.addEventListener)global.addEventListener('message',event=>{if(global.location&&event.origin!==global.location.origin)return;if(event.data&&event.data.type==='spotify-radar-auth-complete')resumeAfterAuthentication();});
  global.SpotifyRadarPlayer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign({},api,{__test:{spotifyTrackId,spotifyTrackUrl,trackIdFromUri,formatTimeMs,waveHeights,normalizeSdkState,webApiPlay}});
  if(doc){
    const start=()=>{hydrate(doc);SDK_LOAD_TIMEOUT=setTimeout(()=>{if(!SDK_PLAYER&&authConnected())broadcastError('unavailable','Le module Spotify ne répond pas. Rechargez la page.');},15000);};
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }
})(typeof window!=='undefined'?window:globalThis);
