'use strict';

/* Spotify Radar launch player
   ---------------------------
   Spotify Radar does not own audio masters for every indexed track. This
   component therefore never fakes inline full-length playback, elapsed time
   or audio-derived peaks. Its primary action opens the exact track in Spotify;
   the waveform is a deterministic visual motif, not an audio analysis. */
(function spotifyRadarPlayerModule(global){
  const doc=global&&global.document;
  const OBSERVERS=new Map();
  const DEFAULT_LABELS=Object.freeze({
    player:'Lecteur Spotify',
    play:'Écouter le titre entier dans Spotify',
    note:'Titre entier dans Spotify',
    open:'Ouvrir sur Spotify',
    share:'Partager',
    copied:'Lien copié',
  });

  function escapeHtml(value){
    return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function spotifyTrackId(value){
    const id=String(value||'').trim();
    return /^[A-Za-z0-9]{22}$/.test(id)?id:'';
  }
  function spotifyTrackUrl(id){
    const spotifyId=spotifyTrackId(id);
    return spotifyId?`https://open.spotify.com/track/${encodeURIComponent(spotifyId)}?locale=en`:'';
  }
  function safeArtwork(value){
    const url=String(value||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  }
  function cleanClasses(value){
    return String(value||'').split(/\s+/).filter(token=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)).join(' ');
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
  function labelsFor(options){return Object.assign({},DEFAULT_LABELS,options&&options.labels||{});}
  function icon(kind){
    if(kind==='share') return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="m8.2 10.9 7.6-4.7M8.2 13.1l7.6 4.7"/></svg>';
    return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.31-1.76-8.8-.96a.625.625 0 1 1-.28-1.22c3.82-.87 7.09-.5 9.73 1.11.29.18.39.56.21.86Zm1.23-2.74a.78.78 0 0 1-1.08.26c-2.69-1.65-6.79-2.13-9.97-1.17a.782.782 0 1 1-.45-1.5c3.64-1.1 8.16-.56 11.24 1.32.37.23.48.71.26 1.09Zm.1-2.86C14.7 8.9 9.36 8.72 6.28 9.65a.94.94 0 1 1-.54-1.8c3.54-1.07 9.44-.86 13.14 1.33a.94.94 0 0 1-.96 1.64Z"/></svg>';
  }
  function coverHtml(id,artwork){
    return artwork
      ?`<span class="spotify-radar-player-cover has-cover"><img src="${escapeHtml(artwork)}" alt="" loading="lazy" onerror="this.remove();this.parentNode.classList.remove('has-cover')"><span aria-hidden="true">♫</span></span>`
      :`<span class="spotify-radar-player-cover" data-spotify-player-cover-id="${id}"><span aria-hidden="true">♫</span></span>`;
  }
  function html(options={}){
    const id=spotifyTrackId(options.spotifyId||options.id);
    if(!id) return '';
    const title=String(options.title||'Track');
    const artist=String(options.artist||'Artiste non renseigné');
    const artwork=safeArtwork(options.artwork||options.cover);
    const labels=labelsFor(options);
    const extra=cleanClasses(options.context||options.extraClass);
    const transportOnly=Boolean(options.transportOnly);
    const spotifyUrl=spotifyTrackUrl(id);
    const classes=['spotify-radar-player',transportOnly?'spotify-radar-player--transport':'',extra].filter(Boolean).join(' ');
    const identity=transportOnly?'':`<div class="spotify-radar-player-main">${coverHtml(id,artwork)}<span class="spotify-radar-player-copy"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><small title="${escapeHtml(artist)}">${escapeHtml(artist)}</small></span></div>`;
    return `<div class="spotify-radar-player-frame"><section class="${classes}" data-spotify-id="${id}" data-label-copied="${escapeHtml(labels.copied)}" aria-label="${escapeHtml(labels.player)} · ${escapeHtml(title)}">
      ${identity}
      <a class="spotify-radar-player-play" href="${escapeHtml(spotifyUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(labels.play)} · ${escapeHtml(title)}" title="${escapeHtml(labels.play)}"><span class="spotify-radar-player-glyph" aria-hidden="true"></span></a>
      <div class="spotify-radar-player-timeline">
        <div class="spotify-radar-player-wave" aria-hidden="true"><canvas aria-hidden="true"></canvas></div>
        <span class="spotify-radar-player-note">${escapeHtml(labels.note)}</span>
      </div>
      <div class="spotify-radar-player-actions">
        <button type="button" class="spotify-radar-player-action spotify-radar-player-share" onclick="SpotifyRadarPlayer.share(this)" data-url="${escapeHtml(spotifyUrl)}" data-title="${escapeHtml(title)}" aria-label="${escapeHtml(labels.share)} · ${escapeHtml(title)}" title="${escapeHtml(labels.share)}">${icon('share')}</button>
        <a class="spotify-radar-player-action spotify-radar-player-open" href="${escapeHtml(spotifyUrl)}" target="_blank" rel="noopener" aria-label="${escapeHtml(labels.open)} · ${escapeHtml(title)}" title="${escapeHtml(labels.open)}">${icon('spotify')}</a>
      </div>
      <span class="spotify-radar-player-status" role="status" aria-live="polite"></span>
    </section></div>`;
  }
  function playerFrom(control){return control&&typeof control.closest==='function'?control.closest('.spotify-radar-player'):null;}
  function drawWave(player){
    const canvas=player&&player.querySelector&&player.querySelector('.spotify-radar-player-wave canvas');
    if(!canvas||typeof canvas.getContext!=='function') return;
    const width=canvas.clientWidth||300;
    const height=canvas.clientHeight||34;
    const ratio=Math.min(Number(global.devicePixelRatio)||1,2);
    const targetWidth=Math.max(1,Math.round(width*ratio));
    const targetHeight=Math.max(1,Math.round(height*ratio));
    if(canvas.width!==targetWidth)canvas.width=targetWidth;
    if(canvas.height!==targetHeight)canvas.height=targetHeight;
    const context=canvas.getContext('2d');if(!context)return;
    context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
    const pitch=4.6,barWidth=1.8,count=Math.max(1,Math.floor(width/pitch));
    const heights=waveHeights(player.dataset.spotifyId,count);
    let base='#687188';
    if(typeof global.getComputedStyle==='function'){
      const style=global.getComputedStyle(canvas);
      base=style.color||base;
    }
    heights.forEach((amplitude,index)=>{
      const barHeight=Math.max(3,Math.round(height*amplitude));
      context.globalAlpha=.3+(index%7===0 ? .13 : 0);
      context.fillStyle=base;
      context.fillRect(Math.round(index*pitch),Math.round((height-barHeight)/2),barWidth,barHeight);
    });
    context.globalAlpha=1;
  }
  function hydrate(root){
    if(!doc)return;
    const scope=root&&typeof root.querySelectorAll==='function'?root:doc;
    const players=[];
    if(scope.matches&&scope.matches('.spotify-radar-player'))players.push(scope);
    scope.querySelectorAll('.spotify-radar-player').forEach(player=>players.push(player));
    players.forEach(player=>{
      drawWave(player);
      const canvas=player.querySelector('.spotify-radar-player-wave canvas');
      if(canvas&&!OBSERVERS.has(player)&&typeof global.ResizeObserver==='function'){
        const observer=new global.ResizeObserver(()=>drawWave(player));
        observer.observe(canvas);OBSERVERS.set(player,observer);
      }
    });
  }
  function clear(root){
    OBSERVERS.forEach((observer,player)=>{
      if(root&&player!==root&&!(typeof root.contains==='function'&&root.contains(player)))return;
      try{observer.disconnect();}catch(error){}
      OBSERVERS.delete(player);
    });
  }
  function openTrack(target){
    const player=playerFrom(target)||target;
    const url=spotifyTrackUrl(player&&player.dataset&&player.dataset.spotifyId);
    if(!url)return;
    if(typeof global.open==='function')global.open(url,'_blank','noopener');
  }
  async function share(control){
    const player=playerFrom(control),url=control&&control.dataset&&control.dataset.url,title=control&&control.dataset&&control.dataset.title;
    if(!url)return;
    try{
      if(global.navigator&&typeof global.navigator.share==='function') await global.navigator.share({title,url});
      else if(global.navigator&&global.navigator.clipboard&&typeof global.navigator.clipboard.writeText==='function') await global.navigator.clipboard.writeText(url);
      else throw new Error('clipboard unavailable');
      const status=player&&player.querySelector('.spotify-radar-player-status');
      if(status){status.textContent=player&&player.dataset&&player.dataset.labelCopied||DEFAULT_LABELS.copied;setTimeout(()=>{status.textContent='';},1800);}
    }catch(error){if(typeof global.prompt==='function')global.prompt('Copier le lien Spotify :',url);}
  }
  function setCover(player,url){
    const cover=player&&player.querySelector('.spotify-radar-player-cover');
    const artwork=safeArtwork(url);
    if(!cover||!artwork||cover.querySelector('img')||!doc)return;
    const image=doc.createElement('img');image.src=artwork;image.alt='';image.loading='lazy';
    image.onerror=()=>{image.remove();cover.classList.remove('has-cover');};
    cover.prepend(image);cover.classList.add('has-cover');
  }

  const api={html,hydrate,clear,share,setCover,toggle:openTrack,requestPlay:openTrack};
  global.SpotifyRadarPlayer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign({},api,{__test:{waveHeights,spotifyTrackId,spotifyTrackUrl}});
  if(doc){
    const start=()=>hydrate(doc);
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }
})(typeof window!=='undefined'?window:globalThis);
