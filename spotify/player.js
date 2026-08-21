'use strict';

/* Spotify Radar inline player
   ---------------------------
   The catalogue only contains Spotify track IDs, not audio masters. Playback
   therefore uses Spotify's official, visible Embed. The Radar never invents
   duration/progress and the primary listening flow stays inside the page. */
(function spotifyRadarPlayerModule(global){
  const doc=global&&global.document;
  const INSTANCES=new Map();
  const DEFAULT_LABELS=Object.freeze({
    player:'Lecteur Spotify intégré',
    loading:'Chargement du lecteur Spotify…',
    unavailable:'Le lecteur Spotify est indisponible',
  });
  let IFRAME_API=null;
  let API_FAILED=false;
  let API_TIMEOUT=null;

  function escapeHtml(value){
    return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function spotifyTrackId(value){
    const id=String(value||'').trim();
    return /^[A-Za-z0-9]{22}$/.test(id)?id:'';
  }
  function spotifyEmbedUrl(id){
    const spotifyId=spotifyTrackId(id);
    return spotifyId?`https://open.spotify.com/embed/track/${encodeURIComponent(spotifyId)}?utm_source=generator&theme=0`:'';
  }
  function cleanClasses(value){
    return String(value||'').split(/\s+/).filter(token=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)).join(' ');
  }
  function labelsFor(options){return Object.assign({},DEFAULT_LABELS,options&&options.labels||{});}
  function iframeHtml(id,title,labels){
    return `<iframe class="spotify-radar-player-embed" src="${escapeHtml(spotifyEmbedUrl(id))}" width="100%" height="152" frameborder="0" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" title="${escapeHtml(labels.player)} · ${escapeHtml(title)}"></iframe>`;
  }
  function html(options={}){
    const id=spotifyTrackId(options.spotifyId||options.id);
    if(!id)return '';
    const title=String(options.title||'Track');
    const labels=labelsFor(options);
    const extra=cleanClasses(options.context||options.extraClass);
    const classes=['spotify-radar-player',options.transportOnly?'spotify-radar-player--transport':'',extra].filter(Boolean).join(' ');
    return `<div class="spotify-radar-player-frame"><section class="${classes}" data-spotify-id="${id}" data-title="${escapeHtml(title)}" data-label-player="${escapeHtml(labels.player)}" data-label-loading="${escapeHtml(labels.loading)}" data-label-unavailable="${escapeHtml(labels.unavailable)}" aria-label="${escapeHtml(labels.player)} · ${escapeHtml(title)}">
      <div class="spotify-radar-player-embed-shell">
        <div class="spotify-radar-player-embed-host" aria-label="${escapeHtml(labels.loading)}"></div>
      </div>
      <span class="spotify-radar-player-status" role="status" aria-live="polite">${escapeHtml(labels.loading)}</span>
    </section></div>`;
  }
  function playerFrom(control){return control&&typeof control.closest==='function'?control.closest('.spotify-radar-player'):control;}
  function setStatus(player,state,text=''){
    if(!player)return;
    player.dataset.state=state;
    const status=player.querySelector('.spotify-radar-player-status');
    if(status)status.textContent=text||(state==='unavailable'?player.dataset.labelUnavailable:state==='loading'?player.dataset.labelLoading:'');
  }
  function directEmbed(player){
    if(!doc||!player||player.dataset.spotifyCleared==='1')return;
    const host=player.querySelector('.spotify-radar-player-embed-host');
    const id=spotifyTrackId(player.dataset.spotifyId);
    if(!host||!id||host.querySelector('iframe'))return;
    host.innerHTML=iframeHtml(id,player.dataset.title||'Track',{player:player.dataset.labelPlayer||DEFAULT_LABELS.player});
    player.dataset.spotifyHydrated='fallback';
    setStatus(player,'ready');
  }
  function recoverPlayer(player,instance){
    if(!doc||!player||INSTANCES.get(player)!==instance)return;
    clearTimeout(instance.readyTimer);
    try{instance.controller&&instance.controller.destroy();}catch(error){}
    INSTANCES.delete(player);
    delete player.dataset.spotifyHydrated;
    const shell=player.querySelector('.spotify-radar-player-embed-shell');
    if(!shell)return;
    const host=doc.createElement('div');
    host.className='spotify-radar-player-embed-host';
    host.setAttribute('aria-label',player.dataset.labelLoading||DEFAULT_LABELS.loading);
    shell.replaceChildren(host);
    directEmbed(player);
  }
  function registerController(player,instance,controller){
    if(!player||!controller||!player.isConnected||INSTANCES.get(player)!==instance){
      try{controller&&controller.destroy();}catch(error){}
      return;
    }
    instance.controller=controller;
    const listen=(name,handler)=>{if(typeof controller.addListener==='function')controller.addListener(name,event=>{if(INSTANCES.get(player)===instance)handler(event);});};
    listen('ready',()=>{
      instance.ready=true;
      clearTimeout(instance.readyTimer);
      setStatus(player,'ready');
      if(instance.pendingPlay){
        instance.pendingPlay=false;
        pauseOthers(player);
        try{controller.play();}catch(error){}
      }
    });
    listen('playback_started',()=>{instance.paused=false;pauseOthers(player);setStatus(player,'playing');});
    listen('playback_update',event=>{
      const data=event&&event.data||{};
      instance.paused=Boolean(data.isPaused);
      setStatus(player,data.isBuffering?'loading':instance.paused?'ready':'playing');
    });
  }
  function hydratePlayer(player){
    if(!player||player.dataset.spotifyCleared==='1'||player.dataset.spotifyHydrated)return;
    const host=player.querySelector('.spotify-radar-player-embed-host');
    const id=spotifyTrackId(player.dataset.spotifyId);
    if(!host||!id)return;
    if(API_FAILED||!IFRAME_API||typeof IFRAME_API.createController!=='function'){
      if(API_FAILED)directEmbed(player);
      return;
    }
    player.dataset.spotifyHydrated='controller';
    const instance={controller:null,ready:false,paused:true,pendingPlay:player.dataset.autoplay==='1',readyTimer:null};
    delete player.dataset.autoplay;
    INSTANCES.set(player,instance);
    try{
      instance.readyTimer=setTimeout(()=>recoverPlayer(player,instance),12000);
      IFRAME_API.createController(host,{uri:`spotify:track:${id}`,width:'100%',height:152},controller=>registerController(player,instance,controller));
    }catch(error){
      clearTimeout(instance.readyTimer);
      INSTANCES.delete(player);
      delete player.dataset.spotifyHydrated;
      directEmbed(player);
    }
  }
  function hydrate(root){
    if(!doc)return;
    const scope=root&&typeof root.querySelectorAll==='function'?root:doc;
    const players=[];
    if(scope.matches&&scope.matches('.spotify-radar-player'))players.push(scope);
    scope.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));
    players.forEach(player=>{delete player.dataset.spotifyCleared;hydratePlayer(player);});
  }
  function pauseOthers(current){
    INSTANCES.forEach((instance,player)=>{
      if(player===current||!instance||!instance.controller||instance.paused)return;
      try{instance.controller.pause();}catch(error){}
      instance.paused=true;
      setStatus(player,'ready');
    });
  }
  function requestPlay(target){
    const player=playerFrom(target);
    if(!player)return;
    const instance=INSTANCES.get(player);
    if(instance&&instance.controller&&instance.ready){
      pauseOthers(player);
      try{instance.controller.togglePlay();}catch(error){}
      return;
    }
    if(instance)instance.pendingPlay=true;
    else player.dataset.autoplay='1';
    hydratePlayer(player);
    const frame=player.querySelector('.spotify-radar-player-embed');
    if(frame&&typeof frame.focus==='function')frame.focus();
  }
  function destroyPlayer(player){
    const instance=INSTANCES.get(player);
    if(instance){
      clearTimeout(instance.readyTimer);
      try{instance.controller&&instance.controller.destroy();}catch(error){}
      INSTANCES.delete(player);
    }
    player.querySelectorAll('iframe[src*="open.spotify.com/embed/"]').forEach(frame=>{frame.src='about:blank';frame.remove();});
    player.dataset.spotifyCleared='1';
    delete player.dataset.spotifyHydrated;
  }
  function clear(root){
    if(!root)return;
    const players=[];
    if(root.matches&&root.matches('.spotify-radar-player'))players.push(root);
    if(root.querySelectorAll)root.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));
    players.forEach(destroyPlayer);
  }
  function setApi(api){
    IFRAME_API=api||null;
    API_FAILED=!IFRAME_API;
    clearTimeout(API_TIMEOUT);
    if(doc)hydrate(doc);
  }
  function start(){
    hydrate(doc);
    API_TIMEOUT=setTimeout(()=>{
      if(IFRAME_API)return;
      API_FAILED=true;
      doc.querySelectorAll('.spotify-radar-player').forEach(directEmbed);
    },7000);
  }

  const api={html,hydrate,clear,toggle:requestPlay,requestPlay,setApi,setCover(){}};
  const previousReady=global.onSpotifyIframeApiReady;
  global.onSpotifyIframeApiReady=apiObject=>{if(typeof previousReady==='function')previousReady(apiObject);setApi(apiObject);};
  global.SpotifyRadarPlayer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign({},api,{__test:{spotifyTrackId,spotifyEmbedUrl,iframeHtml}});
  if(doc){if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();}
})(typeof window!=='undefined'?window:globalThis);
