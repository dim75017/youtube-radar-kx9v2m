'use strict';

/* Spotify Radar preview player
   -----------------------------
   The Radar owns the complete transport UI. A single native HTMLAudio element
   plays the 30-second preview whose immutable Spotify CDN hash is present in
   window.SPOTIFY_PREVIEW_AUDIO. The primary Play action never opens Spotify. */
(function spotifyRadarPlayerModule(global){
  const doc=global&&global.document;
  const PLAYERS=new Set();
  const PLAYER_CLEANUPS=new Map();
  const RESIZE_OBSERVERS=new Map();
  const PREVIEW_BASE_URL='https://p.scdn.co/mp3-preview/';
  const PREVIEW_DURATION_MS=30000;
  const VOLUME_SUPPORTED=supportsNativeVolume();
  const DEFAULT_LABELS=Object.freeze({
    player:'Lecteur Radar · extrait 30 s',
    play:'Lire l’extrait', pause:'Mettre en pause', loading:'Chargement de l’extrait…',
    buffering:'Mise en mémoire de l’extrait…', ready:'Extrait de 30 secondes prêt',
    paused:'Extrait en pause', ended:'Extrait terminé · relancer',
    unavailable:'Extrait de 30 secondes indisponible', error:'Impossible de lire cet extrait. Réessayez.',
    autoplay:'Le navigateur a bloqué la lecture. Cliquez à nouveau sur Lire.',
    progress:'Progression de l’extrait', volume:'Volume', mute:'Couper le son',
    unmute:'Rétablir le son', source:'Voir le titre sur Spotify', clip:'Extrait audio de 30 secondes',
  });

  let AUDIO=null;
  let ACTIVE_TRACK_ID='';
  let ACTIVE_PREVIEW_URL='';
  let ACTIVE_INTENT=0;
  let PENDING_PLAYER=null;
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
  function safeArtwork(value){
    const url=String(value||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  }
  function cleanClasses(value){
    return String(value||'').split(/\s+/).filter(token=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)).join(' ');
  }
  function clamp(value,min,max){return Math.min(max,Math.max(min,Number(value)||0));}
  function supportsNativeVolume(){
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
  function previewHash(value){
    const id=spotifyTrackId(value),catalogue=global&&global.SPOTIFY_PREVIEW_AUDIO,hashes=catalogue&&catalogue.hashes;
    const hash=id&&hashes&&Object.prototype.hasOwnProperty.call(hashes,id)?String(hashes[id]||'').trim():'';
    return /^[a-f0-9]{40}$/i.test(hash)?hash.toLowerCase():'';
  }
  function previewUrlForTrack(value){
    const hash=previewHash(value);
    return hash?`${PREVIEW_BASE_URL}${hash}`:'';
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
    const extra=cleanClasses(options.context||options.extraClass),transportOnly=Boolean(options.transportOnly),available=Boolean(previewUrlForTrack(id));
    const classes=['spotify-radar-player',transportOnly?'spotify-radar-player--transport':'',VOLUME_SUPPORTED?'':'spotify-radar-player--no-volume',extra].filter(Boolean).join(' ');
    const identity=transportOnly?'':`<div class="spotify-radar-player-main">${coverHtml(id,artwork)}<span class="spotify-radar-player-copy"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(artist)}">${escapeHtml(artist)}</small></span></div>`;
    const volume=VOLUME_SUPPORTED?`<div class="spotify-radar-player-volume">
        <button type="button" class="spotify-radar-player-volume-toggle" onclick="SpotifyRadarPlayer.mute(this)" aria-label="${escapeHtml(labels.mute)}" title="${escapeHtml(labels.mute)}">${icon('volume')}</button>
        <input class="spotify-radar-player-volume-range" type="range" min="0" max="100" value="${Math.round(CURRENT_VOLUME*100)}" step="1" aria-label="${escapeHtml(labels.volume)}">
      </div>`:'';
    const initialState=available?'ready':'unavailable',initialStatus=available?labels.ready:labels.unavailable;
    return `<div class="spotify-radar-player-frame"><section class="${classes}" data-spotify-id="${id}" data-title="${escapeHtml(title)}" data-artist="${escapeHtml(artist)}" data-preview-available="${available?'1':'0'}" data-state="${initialState}" data-label-play="${escapeHtml(labels.play)}" data-label-pause="${escapeHtml(labels.pause)}" data-label-loading="${escapeHtml(labels.loading)}" data-label-buffering="${escapeHtml(labels.buffering)}" data-label-ready="${escapeHtml(labels.ready)}" data-label-paused="${escapeHtml(labels.paused)}" data-label-ended="${escapeHtml(labels.ended)}" data-label-unavailable="${escapeHtml(labels.unavailable)}" data-label-error="${escapeHtml(labels.error)}" data-label-autoplay="${escapeHtml(labels.autoplay)}" aria-label="${escapeHtml(labels.player)} · ${escapeHtml(title)}">
      ${identity}
      <button class="spotify-radar-player-toggle" type="button" onclick="SpotifyRadarPlayer.toggle(this)" aria-label="${escapeHtml(labels.play)} · ${escapeHtml(title)}" aria-pressed="false" aria-disabled="${available?'false':'true'}"${available?'':' disabled'}><span class="spotify-radar-player-glyph" data-icon="play" aria-hidden="true"></span></button>
      <div class="spotify-radar-player-timeline">
        <time class="spotify-radar-player-current">0:00</time>
        <div class="spotify-radar-player-wave"><canvas aria-hidden="true"></canvas><input class="spotify-radar-player-seek" type="range" min="0" max="1000" value="0" step="1" disabled aria-label="${escapeHtml(labels.progress)} · ${escapeHtml(title)}" aria-valuetext="0:00 / ${available?'0:30':'--:--'}"></div>
        <time class="spotify-radar-player-duration">${available?'0:30':'--:--'}</time>
      </div>
      ${volume}
      <a class="spotify-radar-player-attribution" href="${escapeHtml(spotifyUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(labels.source)} · ${escapeHtml(title)}" title="${escapeHtml(labels.source)}">${icon('spotify')}</a>
      <span class="spotify-radar-player-status" role="status" aria-live="polite">${escapeHtml(initialStatus)}</span>
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
    const playing=state==='playing',loading=state==='loading'||state==='buffering';
    const button=player.querySelector('.spotify-radar-player-toggle'),glyph=player.querySelector('.spotify-radar-player-glyph');
    const status=player.querySelector('.spotify-radar-player-status'),title=player.dataset.title||'Track';
    const unavailableWithoutSource=state==='unavailable'&&player.dataset.previewAvailable==='0';
    if(button){
      button.disabled=unavailableWithoutSource;
      button.setAttribute('aria-disabled',unavailableWithoutSource?'true':'false');
      button.setAttribute('aria-pressed',playing?'true':'false');
      button.setAttribute('aria-label',`${playerLabel(player,playing?'labelPause':'labelPlay',playing?'Mettre en pause':'Lire l’extrait')} · ${title}`);
    }
    if(loading)player.setAttribute('aria-busy','true');else player.removeAttribute('aria-busy');
    if(glyph)glyph.dataset.icon=playing?'pause':loading?'loading':'play';
    if(status){
      let fallback=DEFAULT_LABELS.ready;
      if(state==='unavailable')fallback=playerLabel(player,'labelUnavailable',DEFAULT_LABELS.unavailable);
      else if(state==='error')fallback=playerLabel(player,'labelError',DEFAULT_LABELS.error);
      else if(state==='autoplay-blocked')fallback=playerLabel(player,'labelAutoplay',DEFAULT_LABELS.autoplay);
      else if(state==='loading')fallback=playerLabel(player,'labelLoading',DEFAULT_LABELS.loading);
      else if(state==='buffering')fallback=playerLabel(player,'labelBuffering',DEFAULT_LABELS.buffering);
      else if(state==='paused')fallback=playerLabel(player,'labelPaused',DEFAULT_LABELS.paused);
      else if(state==='ended')fallback=playerLabel(player,'labelEnded',DEFAULT_LABELS.ended);
      else fallback=playerLabel(player,'labelReady',DEFAULT_LABELS.ready);
      status.textContent=text||fallback;
    }
  }
  function setActiveUiState(state,text=''){playersForTrack(ACTIVE_TRACK_ID).forEach(player=>setUiState(player,state,text));}
  function setActiveError(){playersForTrack(ACTIVE_TRACK_ID).forEach(player=>setUiState(player,'unavailable',playerLabel(player,'labelError',DEFAULT_LABELS.error)));}
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
    });
    context.globalAlpha=1;
  }
  function mediaDurationMs(audio=AUDIO){
    const duration=Number(audio&&audio.duration);
    return Number.isFinite(duration)&&duration>0?duration*1000:0;
  }
  function mediaPositionMs(audio=AUDIO){
    const position=Number(audio&&audio.currentTime);
    return Number.isFinite(position)&&position>=0?position*1000:0;
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
      seek.disabled=!(duration&&player.dataset.spotifyId===ACTIVE_TRACK_ID&&AUDIO&&mediaDurationMs(AUDIO)>0&&player.dataset.previewAvailable==='1');
      seek.setAttribute('aria-valuetext',`${formatTimeMs(position)} / ${duration?formatTimeMs(duration):'--:--'}`);
    }
  }
  function syncActiveTimeline(){
    const duration=mediaDurationMs(),position=mediaPositionMs();
    playersForTrack(ACTIVE_TRACK_ID).forEach(player=>updateTimeline(player,position,duration));
  }
  function stopTicker(){if(TICK_TIMER){clearInterval(TICK_TIMER);TICK_TIMER=null;}}
  function startTicker(){
    stopTicker();
    if(!AUDIO||AUDIO.paused||AUDIO.ended)return;
    TICK_TIMER=setInterval(()=>{
      if(!AUDIO||AUDIO.paused||AUDIO.ended){stopTicker();return;}
      syncActiveTimeline();
    },250);
  }
  function updateVolumeUi(){
    PLAYERS.forEach(player=>{
      const range=player.querySelector('.spotify-radar-player-volume-range'),button=player.querySelector('.spotify-radar-player-volume-toggle');
      if(range)range.value=String(Math.round(CURRENT_VOLUME*100));
      if(button){
        const muted=CURRENT_VOLUME<=.001;button.dataset.muted=muted?'1':'0';
        button.setAttribute('aria-label',muted?DEFAULT_LABELS.unmute:DEFAULT_LABELS.mute);
        button.title=muted?DEFAULT_LABELS.unmute:DEFAULT_LABELS.mute;
      }
    });
  }
  function audioMatchesActive(audio=AUDIO){
    if(!audio||!ACTIVE_PREVIEW_URL)return false;
    const source=String(audio.src||audio.currentSrc||'');
    return !source||source===ACTIVE_PREVIEW_URL;
  }
  function bindAudioEvents(audio){
    if(!audio||typeof audio.addEventListener!=='function')return;
    const active=callback=>()=>{if(audio===AUDIO&&audioMatchesActive(audio)&&ACTIVE_TRACK_ID)callback();};
    audio.addEventListener('loadstart',active(()=>{stopTicker();playersForTrack(ACTIVE_TRACK_ID).forEach(player=>updateTimeline(player,0,PREVIEW_DURATION_MS));setActiveUiState('loading');}));
    audio.addEventListener('loadedmetadata',active(()=>{syncActiveTimeline();setActiveUiState(audio.paused?'ready':'buffering');}));
    audio.addEventListener('durationchange',active(syncActiveTimeline));
    audio.addEventListener('timeupdate',active(syncActiveTimeline));
    audio.addEventListener('play',active(()=>setActiveUiState('buffering')));
    audio.addEventListener('playing',active(()=>{PENDING_PLAYER=null;syncActiveTimeline();setActiveUiState('playing');startTicker();}));
    audio.addEventListener('waiting',active(()=>{if(!audio.paused)setActiveUiState('buffering');}));
    audio.addEventListener('stalled',active(()=>{if(!audio.paused)setActiveUiState('buffering');}));
    audio.addEventListener('pause',active(()=>{if(!audio.paused||audio.ended)return;stopTicker();syncActiveTimeline();setActiveUiState('paused');}));
    audio.addEventListener('ended',active(()=>{stopTicker();syncActiveTimeline();setActiveUiState('ended');}));
    audio.addEventListener('error',active(()=>{stopTicker();syncActiveTimeline();setActiveError();}));
    audio.addEventListener('abort',active(()=>{if(audio.error){stopTicker();setActiveError();}}));
  }
  function ensureAudio(){
    if(AUDIO)return AUDIO;
    try{
      if(global&&typeof global.Audio==='function')AUDIO=new global.Audio();
      else if(doc&&typeof doc.createElement==='function')AUDIO=doc.createElement('audio');
    }catch(error){AUDIO=null;}
    if(!AUDIO)return null;
    try{AUDIO.preload='metadata';AUDIO.volume=CURRENT_VOLUME;}catch(error){}
    bindAudioEvents(AUDIO);return AUDIO;
  }
  function refreshAvailabilityState(player){
    if(!player)return;
    const id=spotifyTrackId(player.dataset&&player.dataset.spotifyId),url=previewUrlForTrack(id),available=Boolean(url);
    player.dataset.previewAvailable=available?'1':'0';
    if(id===ACTIVE_TRACK_ID&&AUDIO&&audioMatchesActive()){
      updateTimeline(player,mediaPositionMs(),mediaDurationMs());
      if(AUDIO.error)setUiState(player,'unavailable',playerLabel(player,'labelError',DEFAULT_LABELS.error));
      else if(!AUDIO.paused&&!AUDIO.ended)setUiState(player,'playing');
      else if(AUDIO.ended)setUiState(player,'ended');
      else if(mediaPositionMs(AUDIO)>0)setUiState(player,'paused');
      else setUiState(player,'ready');
      return;
    }
    updateTimeline(player,0,available?PREVIEW_DURATION_MS:0);setUiState(player,available?'ready':'unavailable');
  }
  function handlePlayFailure(intent,error){
    if(intent!==ACTIVE_INTENT)return false;
    stopTicker();PENDING_PLAYER=null;
    const name=String(error&&error.name||''),message=String(error&&error.message||'');
    if(name==='NotAllowedError'||/not.?allowed|user gesture|autoplay/i.test(message))setActiveUiState('autoplay-blocked');
    else setActiveError();
    return false;
  }
  function playActive(player,intent){
    if(!AUDIO||intent!==ACTIVE_INTENT)return Promise.resolve(false);
    setActiveUiState('buffering');
    let result;
    try{result=AUDIO.play();}catch(error){return Promise.resolve(handlePlayFailure(intent,error));}
    return Promise.resolve(result).then(()=>{
      if(intent!==ACTIVE_INTENT)return false;
      PENDING_PLAYER=null;
      if(!AUDIO.paused){setActiveUiState('playing');startTicker();}
      return true;
    }).catch(error=>handlePlayFailure(intent,error));
  }
  function requestPlay(target){
    const player=playerFrom(target)||target,id=spotifyTrackId(player&&player.dataset&&player.dataset.spotifyId);
    if(!player||!id)return Promise.resolve(false);
    const url=previewUrlForTrack(id),intent=++ACTIVE_INTENT;
    if(!url){
      player.dataset.previewAvailable='0';setUiState(player,'unavailable');
      if(PENDING_PLAYER===player)PENDING_PLAYER=null;
      return Promise.resolve(false);
    }
    const audio=ensureAudio();
    if(!audio){player.dataset.previewAvailable='1';setUiState(player,'unavailable',playerLabel(player,'labelError',DEFAULT_LABELS.error));return Promise.resolve(false);}
    player.dataset.previewAvailable='1';PENDING_PLAYER=player;
    const sameTrack=ACTIVE_TRACK_ID===id&&ACTIVE_PREVIEW_URL===url&&audioMatchesActive(audio);
    if(sameTrack&&!audio.error){
      if(!audio.paused&&!audio.ended){
        try{audio.pause();}catch(error){}
        stopTicker();syncActiveTimeline();setActiveUiState('paused');PENDING_PLAYER=null;
        return Promise.resolve(true);
      }
      if(audio.ended||(mediaDurationMs(audio)&&mediaPositionMs(audio)>=mediaDurationMs(audio))){
        try{audio.currentTime=0;}catch(error){}
        syncActiveTimeline();
      }
      return playActive(player,intent);
    }
    const previousId=ACTIVE_TRACK_ID;
    try{if(!audio.paused)audio.pause();}catch(error){}
    stopTicker();ACTIVE_TRACK_ID=id;ACTIVE_PREVIEW_URL=url;
    if(previousId&&previousId!==id){
      playersForTrack(previousId).forEach(previous=>{updateTimeline(previous,0,0);refreshAvailabilityState(previous);});
    }
    playersForTrack(id).forEach(current=>{current.dataset.previewAvailable='1';updateTimeline(current,0,PREVIEW_DURATION_MS);setUiState(current,'loading');});
    try{
      audio.src=url;audio.preload='metadata';audio.volume=CURRENT_VOLUME;
      if(typeof audio.load==='function')audio.load();
    }catch(error){return Promise.resolve(handlePlayFailure(intent,error));}
    return playActive(player,intent);
  }
  function toggle(control){return requestPlay(playerFrom(control)||control);}
  function seek(control){
    const player=playerFrom(control),audio=AUDIO;
    if(!player||!audio||player.dataset.spotifyId!==ACTIVE_TRACK_ID)return false;
    const duration=mediaDurationMs(audio);if(!duration)return false;
    const position=clamp(control.value,0,1000)/1000*duration;control.dataset.previewing='';
    try{audio.currentTime=position/1000;}catch(error){syncActiveTimeline();return false;}
    syncActiveTimeline();return true;
  }
  function scrubSeek(control){
    const player=playerFrom(control);if(!player)return;
    const duration=Number(player.dataset.durationMs)||0;if(!duration)return;
    control.dataset.previewing='1';updateTimeline(player,clamp(control.value,0,1000)/1000*duration,duration,{preserveSeek:true,fromScrub:true});
  }
  function setVolume(value){
    if(!VOLUME_SUPPORTED)return;
    const next=clamp(value,0,1);CURRENT_VOLUME=next;if(next>.001)LAST_AUDIBLE_VOLUME=next;
    storeVolume(next);if(AUDIO){try{AUDIO.volume=next;}catch(error){}}updateVolumeUi();
  }
  function mute(){setVolume(CURRENT_VOLUME>.001?0:LAST_AUDIBLE_VOLUME||.72);}
  function bindPlayer(player){
    if(!player||player.dataset.spotifyPlayerBound==='1')return;
    player.dataset.spotifyPlayerBound='1';PLAYERS.add(player);
    const cleanups=[];
    const seekInput=player.querySelector('.spotify-radar-player-seek');
    if(seekInput){
      const onInput=()=>scrubSeek(seekInput),onChange=()=>seek(seekInput);
      seekInput.addEventListener('input',onInput);seekInput.addEventListener('change',onChange);
      cleanups.push(()=>{seekInput.removeEventListener('input',onInput);seekInput.removeEventListener('change',onChange);});
    }
    const volume=player.querySelector('.spotify-radar-player-volume-range');
    if(volume){
      const onInput=()=>setVolume(Number(volume.value)/100);volume.addEventListener('input',onInput);
      cleanups.push(()=>volume.removeEventListener('input',onInput));
    }
    drawWave(player,0);updateVolumeUi();refreshAvailabilityState(player);
    if(player.dataset.spotifyId===ACTIVE_TRACK_ID&&AUDIO&&!AUDIO.paused)startTicker();
    const canvas=player.querySelector('.spotify-radar-player-wave canvas');
    if(canvas&&typeof global.ResizeObserver==='function'){
      const observer=new global.ResizeObserver(()=>{const duration=Number(player.dataset.durationMs)||0,position=Number(player.dataset.positionMs)||0;drawWave(player,duration?position/duration:0);});
      observer.observe(canvas);RESIZE_OBSERVERS.set(player,observer);
    }
    PLAYER_CLEANUPS.set(player,()=>cleanups.forEach(cleanup=>{try{cleanup();}catch(error){}}));
  }
  function hydrate(root){
    if(!doc)return;
    const scope=root&&typeof root.querySelectorAll==='function'?root:doc,players=[];
    if(scope.matches&&scope.matches('.spotify-radar-player'))players.push(scope);
    scope.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));players.forEach(bindPlayer);
  }
  function clear(root){
    let removedActiveControl=false,invalidatedIntent=false;
    [...PLAYERS].forEach(player=>{
      if(root&&player!==root&&!(typeof root.contains==='function'&&root.contains(player)))return;
      if(player.dataset.spotifyId===ACTIVE_TRACK_ID)removedActiveControl=true;
      if(PENDING_PLAYER===player){PENDING_PLAYER=null;invalidatedIntent=true;}
      const cleanup=PLAYER_CLEANUPS.get(player);if(cleanup)cleanup();PLAYER_CLEANUPS.delete(player);
      const observer=RESIZE_OBSERVERS.get(player);
      if(observer){try{observer.disconnect();}catch(error){}RESIZE_OBSERVERS.delete(player);}
      PLAYERS.delete(player);delete player.dataset.spotifyPlayerBound;
    });
    if(invalidatedIntent)ACTIVE_INTENT+=1;
    if(removedActiveControl&&ACTIVE_TRACK_ID&&!playersForTrack(ACTIVE_TRACK_ID).length){
      ACTIVE_INTENT+=1;PENDING_PLAYER=null;stopTicker();
      if(AUDIO&&!AUDIO.paused){try{AUDIO.pause();}catch(error){}}
    }
    if(!PLAYERS.size)stopTicker();
  }
  function setCover(player,url){
    const cover=player&&player.querySelector&&player.querySelector('.spotify-radar-player-cover'),artwork=safeArtwork(url);
    if(!cover||!artwork||cover.querySelector('img')||!doc)return;
    const image=doc.createElement('img');image.src=artwork;image.alt='';image.loading='lazy';
    image.onerror=()=>{image.remove();cover.classList.remove('has-cover');};cover.prepend(image);cover.classList.add('has-cover');
  }

  const api={html,hydrate,clear,toggle,requestPlay,seek,scrubSeek,setVolume,mute,setCover};
  global.SpotifyRadarPlayer=api;
  if(typeof module!=='undefined'&&module.exports){
    module.exports=Object.assign({},api,{__test:{spotifyTrackId,spotifyTrackUrl,previewHash,previewUrlForTrack,formatTimeMs,waveHeights,mediaDurationMs,mediaPositionMs,getAudio:()=>AUDIO}});
  }
  if(doc){
    const start=()=>hydrate(doc);
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }
})(typeof window!=='undefined'?window:globalThis);
