'use strict';

/* Spotify Radar custom player
   ----------------------------
   The visible controls are ours, but playback stays inside Spotify's official
   Embed IFrame API. The waveform is a deterministic progress display,
   not an audio analysis. Spotify does not expose volume control here,
   so this component deliberately does not render a fake one. */
(function spotifyRadarPlayerModule(global){
  const doc=global&&global.document;
  const INSTANCES=new Map();
  const DEFAULT_LABELS=Object.freeze({
    player:'Lecteur Spotify', play:'Lire', pause:'Pause', loading:'Connexion à Spotify…',
    ready:'Prêt à écouter', buffering:'Chargement de la piste…', unavailable:'Lecture Spotify indisponible',
    progress:'Progression de la piste', open:'Ouvrir sur Spotify', share:'Partager', copied:'Lien copié',
  });
  let IFRAME_API=null;
  let DOM_OBSERVER=null;
  let API_TIMEOUT=null;
  let API_FAILED=false;
  let HYDRATION_GENERATION=0;
  let PLAY_INTENT_EPOCH=0;

  function escapeHtml(value){
    return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function spotifyTrackId(value){
    const id=String(value||'').trim();
    return /^[A-Za-z0-9]{22}$/.test(id)?id:'';
  }
  function safeArtwork(value){
    const url=String(value||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  }
  function cleanClasses(value){
    return String(value||'').split(/\s+/).filter(token=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)).join(' ');
  }
  function formatTime(seconds){
    const value=Number(seconds);
    if(!Number.isFinite(value)||value<0) return '--:--';
    const total=Math.floor(value), minutes=Math.floor(total/60), remainder=total%60;
    return `${minutes}:${String(remainder).padStart(2,'0')}`;
  }
  function waveHeights(seed,count=96){
    let hash=7;
    for(const character of String(seed||'')) hash=((hash*31)+character.charCodeAt(0))>>>0;
    return Array.from({length:Math.max(1,Number(count)||1)},(_,index)=>{
      const position=count>1?index/(count-1):0;
      const detail=Math.abs(Math.sin((index+hash)*.613))*.44+Math.abs(Math.sin((index+hash)*.173+1.4))*.31;
      const envelope=.65+Math.abs(Math.sin((index+hash)*.041+.8))*.35;
      const tail=position>.88?Math.max(.14,(1-position)/.12):1;
      return Math.max(.2,Math.min(1,(.29+detail)*envelope*tail));
    });
  }
  function normalizePlaybackUpdate(event){
    const data=event&&event.data&&typeof event.data==='object'?event.data:(event||{});
    const durationMs=Number(data.duration), positionMs=Number(data.position);
    const duration=Number.isFinite(durationMs)&&durationMs>0?durationMs/1000:null;
    const position=Number.isFinite(positionMs)&&positionMs>=0?positionMs/1000:0;
    return {
      duration,
      position:duration==null?position:Math.min(duration,position),
      paused:Boolean(data.isPaused),
      buffering:Boolean(data.isBuffering),
      playingUri:String(data.playingURI||''),
    };
  }
  function labelsFor(options){return Object.assign({},DEFAULT_LABELS,options&&options.labels||{});}
  function icon(kind){
    if(kind==='share') return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="m8.2 10.9 7.6-4.7M8.2 13.1l7.6 4.7"/></svg>';
    return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.31-1.76-8.8-.96a.625.625 0 1 1-.28-1.22c3.82-.87 7.09-.5 9.73 1.11.29.18.39.56.21.86Zm1.23-2.74a.78.78 0 0 1-1.08.26c-2.69-1.65-6.79-2.13-9.97-1.17a.782.782 0 1 1-.45-1.5c3.64-1.1 8.16-.56 11.24 1.32.37.23.48.71.26 1.09Zm.1-2.86C14.7 8.9 9.36 8.72 6.28 9.65a.94.94 0 1 1-.54-1.8c3.54-1.07 9.44-.86 13.14 1.33a.94.94 0 0 1-.96 1.64Z"/></svg>';
  }
  function html(options={}){
    const id=spotifyTrackId(options.spotifyId||options.id);
    if(!id) return '';
    const title=String(options.title||'Track'), artist=String(options.artist||'Artiste non renseigné');
    const artwork=safeArtwork(options.artwork||options.cover), labels=labelsFor(options);
    const extra=cleanClasses(options.context||options.extraClass);
    const spotifyUrl=`https://open.spotify.com/track/${encodeURIComponent(id)}?locale=en`;
    const cover=artwork
      ?`<span class="spotify-radar-player-cover has-cover"><img src="${escapeHtml(artwork)}" alt="" loading="lazy" onerror="this.remove();this.parentNode.classList.remove('has-cover')"><span aria-hidden="true">♫</span></span>`
      :`<span class="spotify-radar-player-cover" data-spotify-player-cover-id="${id}"><span aria-hidden="true">♫</span></span>`;
    return `<div class="spotify-radar-player-frame"><section class="spotify-radar-player${extra?' '+extra:''}" data-spotify-id="${id}" data-state="loading" data-label-play="${escapeHtml(labels.play)}" data-label-pause="${escapeHtml(labels.pause)}" data-label-loading="${escapeHtml(labels.loading)}" data-label-ready="${escapeHtml(labels.ready)}" data-label-buffering="${escapeHtml(labels.buffering)}" data-label-unavailable="${escapeHtml(labels.unavailable)}" data-label-copied="${escapeHtml(labels.copied)}" aria-label="${escapeHtml(labels.player)} · ${escapeHtml(title)}">
      <div class="spotify-radar-player-main">${cover}<span class="spotify-radar-player-copy"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(artist)}">${escapeHtml(artist)}</small></span></div>
      <button class="spotify-radar-player-toggle" type="button" onclick="SpotifyRadarPlayer.toggle(this)" aria-label="${escapeHtml(labels.play)} ${escapeHtml(title)}" aria-pressed="false"><span class="spotify-radar-player-glyph" data-icon="loading" aria-hidden="true"></span></button>
      <div class="spotify-radar-player-timeline">
        <time class="spotify-radar-player-current">0:00</time>
        <div class="spotify-radar-player-wave" role="progressbar" aria-label="${escapeHtml(labels.progress)}" aria-valuemin="0"><canvas aria-hidden="true"></canvas></div>
        <time class="spotify-radar-player-duration">--:--</time>
      </div>
      <div class="spotify-radar-player-actions">
        <button type="button" class="spotify-radar-player-action spotify-radar-player-share" onclick="SpotifyRadarPlayer.share(this)" data-url="${escapeHtml(spotifyUrl)}" data-title="${escapeHtml(title)}" aria-label="${escapeHtml(labels.share)} ${escapeHtml(title)}" title="${escapeHtml(labels.share)}">${icon('share')}</button>
        <a class="spotify-radar-player-action spotify-radar-player-open" href="${escapeHtml(spotifyUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(labels.open)} · ${escapeHtml(title)}" title="${escapeHtml(labels.open)}">${icon('spotify')}</a>
      </div>
      <span class="spotify-radar-player-status" role="status" aria-live="polite">${escapeHtml(labels.loading)}</span>
      <div class="spotify-radar-player-engine" aria-hidden="true"></div>
    </section></div>`;
  }
  function instanceFor(player){return INSTANCES.get(player)||null;}
  function playerFrom(control){return control&&typeof control.closest==='function'?control.closest('.spotify-radar-player'):null;}
  function playerLabel(player,key,fallback){return player&&player.dataset&&player.dataset[key]||fallback;}
  function setStatus(player,state){
    if(!player) return;
    player.dataset.state=state;
    const button=player.querySelector('.spotify-radar-player-toggle');
    const glyph=player.querySelector('.spotify-radar-player-glyph');
    const status=player.querySelector('.spotify-radar-player-status');
    const title=player.querySelector('.spotify-radar-player-copy strong')?.textContent||'Track';
    const playing=state==='playing', buffering=state==='buffering';
    if(button){
      button.setAttribute('aria-pressed',playing?'true':'false');
      button.setAttribute('aria-label',`${playerLabel(player,playing?'labelPause':'labelPlay',playing?'Pause':'Lire')} ${title}`);
    }
    if(glyph) glyph.dataset.icon=playing?'pause':(buffering?'loading':'play');
    if(status){
      const key=state==='unavailable'?'labelUnavailable':state==='buffering'?'labelBuffering':state==='loading'?'labelLoading':'labelReady';
      status.textContent=playerLabel(player,key,DEFAULT_LABELS[key.replace(/^label/,'').toLowerCase()]||DEFAULT_LABELS.ready);
    }
  }
  function drawWave(player,progress=0){
    const canvas=player&&player.querySelector&&player.querySelector('.spotify-radar-player-wave canvas');
    if(!canvas||typeof canvas.getContext!=='function') return;
    const width=canvas.clientWidth||300, height=canvas.clientHeight||34;
    const ratio=Math.min(Number(global.devicePixelRatio)||1,2);
    const targetWidth=Math.max(1,Math.round(width*ratio)), targetHeight=Math.max(1,Math.round(height*ratio));
    if(canvas.width!==targetWidth)canvas.width=targetWidth;
    if(canvas.height!==targetHeight)canvas.height=targetHeight;
    const context=canvas.getContext('2d');if(!context)return;
    context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
    const pitch=4.6, barWidth=1.8, count=Math.max(1,Math.floor(width/pitch));
    const heights=waveHeights(player.dataset.spotifyId,count), played=Math.round(Math.max(0,Math.min(1,Number(progress)||0))*count);
    let base='#586176', accent='#1ed760';
    if(typeof global.getComputedStyle==='function'){
      const style=global.getComputedStyle(canvas);base=style.color||base;accent=style.getPropertyValue('--spotify-player-accent').trim()||accent;
    }
    heights.forEach((amplitude,index)=>{
      const barHeight=Math.max(3,Math.round(height*amplitude));
      context.globalAlpha=index<played?1:.32;context.fillStyle=index<played?accent:base;
      context.fillRect(Math.round(index*pitch),Math.round((height-barHeight)/2),barWidth,barHeight);
    });
    context.globalAlpha=1;
  }
  function updateTimeline(player,state){
    const current=player.querySelector('.spotify-radar-player-current');
    const duration=player.querySelector('.spotify-radar-player-duration');
    const wave=player.querySelector('.spotify-radar-player-wave');
    if(current)current.textContent=formatTime(state.position);
    if(duration)duration.textContent=formatTime(state.duration);
    const progress=state.duration?Math.max(0,Math.min(1,state.position/state.duration)):0;
    drawWave(player,progress);
    if(wave){
      if(state.duration){
        wave.setAttribute('aria-valuemax',String(Math.round(state.duration)));
        wave.setAttribute('aria-valuenow',String(Math.round(state.position)));
        wave.setAttribute('aria-valuetext',`${formatTime(state.position)} / ${formatTime(state.duration)}`);
      }else{
        wave.removeAttribute('aria-valuemax');wave.removeAttribute('aria-valuenow');wave.removeAttribute('aria-valuetext');
      }
    }
  }
  function isCurrentInstance(player,instance){
    return Boolean(player&&instance&&!instance.cancelled&&INSTANCES.get(player)===instance);
  }
  function cancelPendingIntent(player,instance){
    if(instance){instance.pendingPlay=false;instance.playIntentEpoch=0;}
    if(player){delete player._spotifyPlayIntentEpoch;if(player.dataset)delete player.dataset.autoplay;}
  }
  function pauseOtherControllers(current,instances=INSTANCES){
    instances.forEach((instance,player)=>{
      if(player===current||!instance)return;
      cancelPendingIntent(player,instance);
      if(instance.controller&&typeof instance.controller.pause==='function'){
        try{instance.controller.pause();}catch(error){}
        instance.paused=true;setStatus(player,'paused');
      }
    });
  }
  function claimPlayIntent(player){
    const epoch=++PLAY_INTENT_EPOCH;
    pauseOtherControllers(player);
    if(doc&&typeof doc.querySelectorAll==='function')doc.querySelectorAll('.spotify-radar-player').forEach(other=>{
      if(other!==player&&!INSTANCES.has(other))cancelPendingIntent(other,null);
    });
    player._spotifyPlayIntentEpoch=epoch;player.dataset.autoplay='1';
    const instance=instanceFor(player);
    if(instance){instance.pendingPlay=true;instance.playIntentEpoch=epoch;}
    return epoch;
  }
  function registerController(player,instance,controller){
    if(!player||!controller) return;
    if(!player.isConnected||!isCurrentInstance(player,instance)){
      try{controller.destroy();}catch(error){}return;
    }
    instance.controller=controller;
    const engineFrame=player.querySelector('.spotify-radar-player-engine iframe');
    if(engineFrame){engineFrame.tabIndex=-1;engineFrame.setAttribute('aria-hidden','true');}
    const listen=(name,handler)=>{if(typeof controller.addListener==='function')controller.addListener(name,event=>{if(isCurrentInstance(player,instance))handler(event);});};
    listen('ready',()=>{
      instance.ready=true;clearTimeout(instance.readyTimer);setStatus(player,'paused');
      if(instance.pendingPlay&&instance.playIntentEpoch===PLAY_INTENT_EPOCH&&player._spotifyPlayIntentEpoch===PLAY_INTENT_EPOCH){
        instance.pendingPlay=false;delete player.dataset.autoplay;setStatus(player,'loading');
        pauseOtherControllers(player);
        try{
          controller.play();
          instance.playbackStartTimer=setTimeout(()=>{if(isCurrentInstance(player,instance)&&instance.paused)setStatus(player,'paused');},1400);
        }catch(error){setStatus(player,'paused');}
      }else cancelPendingIntent(player,instance);
    });
    listen('playback_started',()=>{
      clearTimeout(instance.playbackStartTimer);
      if(instance.playIntentEpoch!==PLAY_INTENT_EPOCH||player._spotifyPlayIntentEpoch!==PLAY_INTENT_EPOCH){
        try{controller.pause();}catch(error){}instance.paused=true;setStatus(player,'paused');return;
      }
      instance.paused=false;pauseOtherControllers(player);setStatus(player,'playing');
    });
    listen('playback_update',event=>{
      const state=normalizePlaybackUpdate(event);instance.paused=state.paused;
      if(!state.paused&&(instance.playIntentEpoch!==PLAY_INTENT_EPOCH||player._spotifyPlayIntentEpoch!==PLAY_INTENT_EPOCH)){
        try{controller.pause();}catch(error){}state.paused=true;instance.paused=true;
      }
      instance.position=state.position;instance.duration=state.duration;
      instance.progress=state.duration?Math.max(0,Math.min(1,state.position/state.duration)):0;
      updateTimeline(player,state);setStatus(player,state.buffering?'buffering':(state.paused?'paused':'playing'));
    });
    instance.readyTimer=setTimeout(()=>{if(isCurrentInstance(player,instance)&&!instance.ready)setStatus(player,'unavailable');},12000);
  }
  function hydratePlayer(player){
    if(!player||player.dataset.spotifyCleared==='1'||player.dataset.spotifyHydrated==='1') return;
    drawWave(player,0);
    const canvas=player.querySelector('.spotify-radar-player-wave canvas');
    if(canvas&&!player._spotifyWaveObserver&&typeof global.ResizeObserver==='function'){
      const observer=new global.ResizeObserver(()=>drawWave(player,instanceFor(player)?.progress||0));observer.observe(canvas);
      player._spotifyWaveObserver=observer;
    }
    if(API_FAILED&&!IFRAME_API){setStatus(player,'unavailable');return;}
    if(!IFRAME_API||typeof IFRAME_API.createController!=='function') return;
    const id=spotifyTrackId(player.dataset.spotifyId),host=player.querySelector('.spotify-radar-player-engine');
    if(!id||!host){setStatus(player,'unavailable');return;}
    player.dataset.spotifyHydrated='1';
    const generation=++HYDRATION_GENERATION;
    const intentEpoch=Number(player._spotifyPlayIntentEpoch)||0;
    const instance={player,controller:null,paused:true,pendingPlay:player.dataset.autoplay==='1',playIntentEpoch:intentEpoch,ready:false,readyTimer:null,playbackStartTimer:null,generation,cancelled:false,duration:null,position:0};
    INSTANCES.set(player,instance);
    try{IFRAME_API.createController(host,{uri:`spotify:track:${id}`,width:300,height:80},controller=>registerController(player,instance,controller));}
    catch(error){instance.cancelled=true;if(INSTANCES.get(player)===instance)INSTANCES.delete(player);player.dataset.spotifyHydrated='';setStatus(player,'unavailable');}
  }
  function hydrate(root,reactivate=true){
    if(!doc)return;
    const scope=root&&typeof root.querySelectorAll==='function'?root:doc;
    const players=[];
    if(scope.matches&&scope.matches('.spotify-radar-player'))players.push(scope);
    scope.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));
    players.forEach(player=>{if(reactivate)delete player.dataset.spotifyCleared;hydratePlayer(player);});
  }
  function requestPlay(player){
    if(!player)return;
    const epoch=claimPlayIntent(player);
    const instance=instanceFor(player);
    if(instance){instance.pendingPlay=true;instance.playIntentEpoch=epoch;}
    if(instance&&instance.controller&&instance.ready){
      instance.pendingPlay=false;delete player.dataset.autoplay;
      try{instance.controller.play();}catch(error){setStatus(player,'paused');}
    }else hydratePlayer(player);
  }
  function toggle(control){
    const player=playerFrom(control)||control;if(!player)return;
    const instance=instanceFor(player);
    if(!instance||!instance.controller||!instance.ready){
      const epoch=claimPlayIntent(player);if(instance){instance.pendingPlay=true;instance.playIntentEpoch=epoch;}setStatus(player,'loading');hydratePlayer(player);return;
    }
    if(instance.paused){claimPlayIntent(player);instance.pendingPlay=false;delete player.dataset.autoplay;}
    else cancelPendingIntent(player,instance);
    try{instance.controller.togglePlay();}catch(error){setStatus(player,'unavailable');}
  }
  async function share(control){
    const player=playerFrom(control),url=control&&control.dataset&&control.dataset.url,title=control&&control.dataset&&control.dataset.title;
    if(!url)return;
    try{
      if(global.navigator&&typeof global.navigator.share==='function') await global.navigator.share({title,url});
      else if(global.navigator&&global.navigator.clipboard&&typeof global.navigator.clipboard.writeText==='function') await global.navigator.clipboard.writeText(url);
      else throw new Error('clipboard unavailable');
      const status=player&&player.querySelector('.spotify-radar-player-status');
      if(status){status.textContent=playerLabel(player,'labelCopied',DEFAULT_LABELS.copied);player.dataset.shared='1';setTimeout(()=>{player.dataset.shared='';setStatus(player,player.dataset.state||'paused');},1800);}
    }catch(error){if(typeof global.prompt==='function')global.prompt('Copier le lien Spotify :',url);}
  }
  function destroyPlayer(player){
    const instance=instanceFor(player);
    if(instance){
      instance.cancelled=true;cancelPendingIntent(player,instance);clearTimeout(instance.readyTimer);clearTimeout(instance.playbackStartTimer);
      try{instance.controller&&instance.controller.destroy();}catch(error){}
      if(INSTANCES.get(player)===instance)INSTANCES.delete(player);
    }
    if(player&&player._spotifyWaveObserver){try{player._spotifyWaveObserver.disconnect();}catch(error){}delete player._spotifyWaveObserver;}
    if(player&&player.dataset)delete player.dataset.spotifyHydrated;
  }
  function clear(root){
    INSTANCES.forEach((instance,player)=>{
      if(!root||player===root||(typeof root.contains==='function'&&root.contains(player)))destroyPlayer(player);
    });
    if(root&&typeof root.querySelectorAll==='function'){
      const players=[];
      if(root.matches&&root.matches('.spotify-radar-player'))players.push(root);
      root.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));
      players.forEach(player=>{cancelPendingIntent(player,instanceFor(player));player.dataset.spotifyCleared='1';delete player.dataset.spotifyHydrated;});
      root.querySelectorAll('iframe[src*="open.spotify.com/embed/"]').forEach(frame=>{frame.src='about:blank';frame.remove();});
    }
  }
  function prune(){INSTANCES.forEach((instance,player)=>{if(!player.isConnected)destroyPlayer(player);});}
  function destroyTree(node){
    if(!node||node.nodeType!==1)return;
    if(node.matches&&node.matches('.spotify-radar-player'))destroyPlayer(node);
    if(node.querySelectorAll)node.querySelectorAll('.spotify-radar-player').forEach(destroyPlayer);
  }
  function setApi(api){
    IFRAME_API=api||null;API_FAILED=!IFRAME_API;clearTimeout(API_TIMEOUT);
    if(IFRAME_API)hydrate(doc,false);
    else if(doc)doc.querySelectorAll('.spotify-radar-player').forEach(player=>setStatus(player,'unavailable'));
  }
  function observe(){
    if(!doc||!doc.body)return;
    hydrate(doc,false);
    if(typeof global.MutationObserver==='function'&&!DOM_OBSERVER){
      DOM_OBSERVER=new global.MutationObserver(records=>{
        prune();records.forEach(record=>{
          record.removedNodes&&record.removedNodes.forEach(destroyTree);
          record.addedNodes&&record.addedNodes.forEach(node=>{if(node&&node.nodeType===1)hydrate(node);});
        });
      });
      DOM_OBSERVER.observe(doc.body,{childList:true,subtree:true});
    }
    API_TIMEOUT=setTimeout(()=>{if(!IFRAME_API){API_FAILED=true;doc.querySelectorAll('.spotify-radar-player').forEach(player=>setStatus(player,'unavailable'));}},12000);
  }

  const api={html,hydrate,clear,toggle,requestPlay,share,setApi,setCover(player,url){
    const cover=player&&player.querySelector('.spotify-radar-player-cover');const artwork=safeArtwork(url);
    if(!cover||!artwork||cover.querySelector('img'))return;
    const image=doc.createElement('img');image.src=artwork;image.alt='';image.loading='lazy';image.onerror=()=>{image.remove();cover.classList.remove('has-cover');};cover.prepend(image);cover.classList.add('has-cover');
  }};
  const previousReady=global.onSpotifyIframeApiReady;
  global.onSpotifyIframeApiReady=iframeApi=>{if(typeof previousReady==='function')previousReady(iframeApi);setApi(iframeApi);};
  global.SpotifyRadarPlayer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign({},api,{__test:{formatTime,waveHeights,normalizePlaybackUpdate,pauseOtherControllers,spotifyTrackId}});
  if(doc){if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',observe,{once:true});else observe();}
})(typeof window!=='undefined'?window:globalThis);
