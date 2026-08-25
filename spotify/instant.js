/* Spotify Radar lightweight public runtime.
   The complete analytical exports remain build inputs; this browser runtime
   only hydrates the compact catalogue and never loads histories at startup. */
(()=>{
  'use strict';

  const boot=window.SPOTIFY_INSTANT;
  const view=document.getElementById('view');
  const nav=document.getElementById('nav');
  if(!boot||!boot.schemas||!view||!nav){
    if(view)view.innerHTML='<p class="instant-load-error">Chargement impossible. Réessayez dans un instant.</p>';
    return;
  }

  const routeToView={opportunities:'radar',radar:'radar',opps:'radar',tracks:'opps','ar-list':'ar-list',artists:'artists',playlists:'playlists',labels:'labels'};
  const viewToRoute={opps:'tracks',radar:'opportunities','ar-list':'ar-list',artists:'artists',playlists:'playlists',labels:'labels'};
  const validViews=new Set(Object.values(routeToView));
  const schema={};
  for(const [name,fields] of Object.entries(boot.schemas))schema[name]=Object.fromEntries(fields.map((field,index)=>[field,index]));
  const T=schema.tracks,A=schema.artists,P=schema.playlists,L=schema.labels;
  const AR_LIST_STORAGE='spotify_ar_outreach_list_v1';
  let data=boot;
  let fullReady=Boolean(window.SPOTIFY_CATALOGUE);
  let fullPromise=null;
  let trackAnalyticsPromise=null;
  let modalRequest=0;
  let lang='fr';
  try{lang=localStorage.getItem('sr_lang')||'fr';}catch(error){}
  const initialRoute=location.hash.slice(1);
  const state={
    view:routeToView[initialRoute]||'radar',
    query:'',shown:100,
    sort:{opps:'streams',radar:'velocity',artists:'streams',playlists:'followers',labels:'streams'},
  };
  if(!validViews.has(state.view))state.view='radar';

  const words={
    fr:{
      opportunities:'Opportunités',selection:'Sélection',tracks:'Pistes',artists:'Artistes',playlists:'Playlists',labels:'Labels',
      allTracks:'Toutes les pistes',allArtists:'Tous les artistes',allPlaylists:'Toutes les playlists',allLabels:'Tous les labels',
      radarTitle:'Opportunités',selectionTitle:'Sélection',search:'Rechercher',artist:'Artiste',track:'Piste',release:'Sortie',
      streams:'Streams',velocity:'24 h',rights:'Droits',genre:'Genre',followers:'Followers',owner:'Propriétaire',catalogue:'Catalogue',
      tracksCount:'pistes',monthlyListeners:'Auditeurs mensuels',latest:'Dernière sortie',growth:'Croissance',since:'Depuis',
      loadMore:'Afficher plus',loadingCatalogue:'Catalogue complet en cours de chargement…',empty:'Aucun résultat.',
      add:'Ajouter à la sélection',remove:'Retirer de la sélection',openSpotify:'Ouvrir dans Spotify',close:'Fermer',
      independent:'Indépendant',label:'Label',unknown:'À confirmer',updated:'Mis à jour',instant:'Interface prête',
      detail:'Détail de la piste',selectedEmpty:'Aucune piste dans la sélection.',selectedHint:'Les opportunités ajoutées au radar apparaissent ici.',
      stage:'Étape',contact:'À contacter',dateAdded:'Ajoutée',sort:'Trier',allData:'catalogue complet',
    },
    en:{
      opportunities:'Opportunities',selection:'Selection',tracks:'Tracks',artists:'Artists',playlists:'Playlists',labels:'Labels',
      allTracks:'All tracks',allArtists:'All artists',allPlaylists:'All playlists',allLabels:'All labels',
      radarTitle:'Opportunities',selectionTitle:'Selection',search:'Search',artist:'Artist',track:'Track',release:'Released',
      streams:'Streams',velocity:'24 h',rights:'Rights',genre:'Genre',followers:'Followers',owner:'Owner',catalogue:'Catalogue',
      tracksCount:'tracks',monthlyListeners:'Monthly listeners',latest:'Latest release',growth:'Growth',since:'Since',
      loadMore:'Show more',loadingCatalogue:'Loading the full catalogue…',empty:'No results.',
      add:'Add to selection',remove:'Remove from selection',openSpotify:'Open in Spotify',close:'Close',
      independent:'Independent',label:'Label',unknown:'To confirm',updated:'Updated',instant:'Interface ready',
      detail:'Track detail',selectedEmpty:'No track in the selection.',selectedHint:'Opportunities added from the radar appear here.',
      stage:'Stage',contact:'To contact',dateAdded:'Added',sort:'Sort',allData:'full catalogue',
    },
  };
  const w=key=>words[lang][key]||key;
  const esc=value=>String(value==null?'':value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const number=value=>Number.isFinite(Number(value))?Number(value):null;
  const compact=value=>{
    const n=number(value);if(n==null)return '—';
    return new Intl.NumberFormat(lang==='fr'?'fr-FR':'en-GB',{notation:'compact',maximumFractionDigits:n>=1e6?1:0}).format(n);
  };
  const fullNumber=value=>{const n=number(value);return n==null?'—':new Intl.NumberFormat(lang==='fr'?'fr-FR':'en-GB').format(Math.round(n));};
  const date=value=>{
    const raw=String(value||'').slice(0,10);if(!raw)return '—';
    const parsed=new Date(`${raw}T12:00:00Z`);if(Number.isNaN(parsed.getTime()))return esc(raw);
    return new Intl.DateTimeFormat(lang==='fr'?'fr-FR':'en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(parsed);
  };
  const genre=value=>{
    const raw=String(value||'').trim().toLowerCase();
    if(!raw)return '—';
    if(['trusted_catalogue','catalogue_trusted'].includes(raw))return lang==='fr'?'Non classé':'Unclassified';
    return raw.replaceAll('_',' ').replace(/\b\w/g,char=>char.toUpperCase());
  };
  const rights=value=>{
    const key=String(value||'').toLowerCase();
    if(['self_released','self-released','indie'].includes(key))return w('independent');
    if(['independent_label','label'].includes(key))return w('label');
    return w('unknown');
  };
  const delta=value=>{
    const n=number(value);if(n==null)return '<span class="fast-delta muted">—</span>';
    const cls=n>0?'up':n<0?'down':'muted';
    return `<span class="fast-delta ${cls}">${n>0?'+':''}${compact(n)}</span>`;
  };
  const image=(url,kind='cover')=>url
    ?`<img class="fast-${kind}" src="${esc(url)}" alt="" loading="lazy" decoding="async" fetchpriority="low">`
    :`<span class="fast-${kind} fast-placeholder" aria-hidden="true">♫</span>`;

  function selectionGet(){
    try{const value=JSON.parse(localStorage.getItem(AR_LIST_STORAGE)||'{}');return value&&typeof value==='object'?value:{};}catch(error){return {};}
  }
  function selectionSet(value){try{localStorage.setItem(AR_LIST_STORAGE,JSON.stringify(value));}catch(error){}}
  function selectionHas(id){return Boolean(selectionGet()[id]);}
  function selectionToggle(id){
    const items=selectionGet();
    if(items[id])delete items[id];
    else{
      const track=findTrack(id);
      items[id]={
        spotifyId:id,
        title:track?track[T.title]:'',
        artistName:track?track[T.credit_name]:'',
        status:'to_contact',
        selectionAddedAt:new Date().toISOString(),
      };
    }
    selectionSet(items);updateCounts();render();
  }

  function source(name){
    if(name==='selection')return [];
    return Array.isArray(data[name])?data[name]:[];
  }
  function findTrack(id){return source('tracks').find(row=>row[T.spotify_id]===id)||source('radar').find(row=>row[T.spotify_id]===id)||boot.tracks.find(row=>row[T.spotify_id]===id)||boot.radar.find(row=>row[T.spotify_id]===id);}
  function normalize(value){return String(value||'').toLocaleLowerCase(lang==='fr'?'fr':'en').normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
  function includesQuery(values){const query=normalize(state.query);return !query||values.some(value=>normalize(value).includes(query));}
  function syncRoute(){
    const route=viewToRoute[state.view]||'tracks';
    try{history.replaceState(null,'',`${location.pathname}${location.search}#${route}`);}catch(error){}
  }

  function toolbar(sortOptions){
    const current=state.sort[state.view];
    return `<div class="fast-toolbar">
      <label class="fast-search"><span aria-hidden="true">⌕</span><input id="fast-search" type="search" value="${esc(state.query)}" placeholder="${esc(w('search'))}" autocomplete="off"></label>
      <label class="fast-sort"><span>${esc(w('sort'))}</span><select id="fast-sort">${sortOptions.map(([value,label])=>`<option value="${esc(value)}" ${current===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>
      <span class="fast-runtime-state" id="fast-runtime-state">${fullReady?esc(w('allData')):esc(w('instant'))}</span>
    </div>`;
  }
  function heading(title,count,description=''){
    return `<div class="page-head fast-page-head"><div><h2>${esc(title)}</h2>${description?`<p>${esc(description)}</p>`:''}</div><span class="fast-total">${fullNumber(count)}</span></div>`;
  }
  function more(total){
    if(state.shown>=total)return '';
    return `<div class="fast-more-wrap"><button class="fast-more" type="button" data-action="more">${esc(w('loadMore'))}<span>${fullNumber(total-state.shown)}</span></button></div>`;
  }
  function coverCell(row){return `<td class="fast-cover-cell">${image(row[T.image_url])}</td>`;}
  function trackRows(rows,opportunity=false){
    return rows.map(row=>{
      const id=row[T.spotify_id];
      const selected=selectionHas(id);
      return `<tr data-track-id="${esc(id)}">
        ${coverCell(row)}
        <td><button class="fast-primary" type="button" data-open-track="${esc(id)}">${esc(row[T.title]||'—')}</button><span class="fast-mobile-meta">${esc(row[T.credit_name]||'—')}</span></td>
        <td class="fast-secondary">${esc(row[T.credit_name]||'—')}</td>
        <td class="num"><strong>${compact(row[T.streams])}</strong></td>
        <td class="num">${delta(row[T.delta_24h])}</td>
        <td>${esc(genre(row[T.genre]))}</td>
        <td class="fast-date">${date(row[T.release_date])}</td>
        <td><span class="fast-rights ${rights(row[T.rights_status])===w('independent')?'indie':''}">${esc(rights(row[T.rights_status]))}</span></td>
        ${opportunity?`<td class="fast-action-cell"><button type="button" class="fast-select ${selected?'on':''}" data-select-track="${esc(id)}" aria-label="${esc(selected?w('remove'):w('add'))}">${selected?'✓':'＋'}</button></td>`:''}
      </tr>`;
    }).join('');
  }
  function trackTable(rows,opportunity=false){
    return `<div class="fast-table-wrap"><table class="fast-table fast-track-table"><thead><tr><th></th><th>${esc(w('track'))}</th><th>${esc(w('artist'))}</th><th class="num">${esc(w('streams'))}</th><th class="num">${esc(w('velocity'))}</th><th>${esc(w('genre'))}</th><th>${esc(w('release'))}</th><th>${esc(w('rights'))}</th>${opportunity?'<th></th>':''}</tr></thead><tbody>${trackRows(rows,opportunity)}</tbody></table></div>`;
  }

  function renderTracks(opportunity=false){
    let rows=source(opportunity?'radar':'tracks').filter(row=>includesQuery([row[T.title],row[T.credit_name],row[T.genre],row[T.label],row[T.copyright]]));
    const sort=state.sort[state.view];
    rows=rows.slice().sort((left,right)=>{
      if(sort==='velocity')return (right[T.delta_24h]||0)-(left[T.delta_24h]||0)||(right[T.streams]||0)-(left[T.streams]||0);
      if(sort==='release')return String(right[T.release_date]||'').localeCompare(String(left[T.release_date]||''));
      if(sort==='title')return String(left[T.title]||'').localeCompare(String(right[T.title]||''));
      return (right[T.streams]||0)-(left[T.streams]||0);
    });
    const total=fullReady?rows.length:(opportunity?boot.counts.opportunities:boot.counts.tracks);
    const title=opportunity?w('radarTitle'):w('allTracks');
    const description=opportunity
      ?(lang==='fr'?'Pistes instrumentales indépendantes avec un signal vérifié.':'Independent instrumental tracks with a verified signal.')
      :(lang==='fr'?'Catalogue instrumental public, trié par performances.':'Public instrumental catalogue, ranked by performance.');
    view.innerHTML=heading(title,total,description)+toolbar([
      ['streams',w('streams')],['velocity',w('velocity')],['release',w('release')],['title',w('track')],
    ])+(rows.length?trackTable(rows.slice(0,state.shown),opportunity):`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(rows.length);
    bindToolbar();
  }

  function renderArtists(){
    let rows=source('artists').filter(row=>includesQuery([row[A.name],row[A.genre]]));
    const sort=state.sort.artists;
    rows=rows.slice().sort((left,right)=>{
      if(sort==='listeners')return (right[A.monthly_listeners]||0)-(left[A.monthly_listeners]||0);
      if(sort==='velocity')return (right[A.delta_24h]||0)-(left[A.delta_24h]||0);
      if(sort==='latest')return String(right[A.latest_release]||'').localeCompare(String(left[A.latest_release]||''));
      if(sort==='name')return String(left[A.name]||'').localeCompare(String(right[A.name]||''));
      return (right[A.catalogue_streams]||0)-(left[A.catalogue_streams]||0);
    });
    const total=fullReady?rows.length:boot.counts.artists;
    const body=rows.slice(0,state.shown).map(row=>`<tr>
      <td class="fast-cover-cell">${image(row[A.image_url],'avatar')}</td>
      <td><a class="fast-primary" href="https://open.spotify.com/artist/${encodeURIComponent(row[A.spotify_id])}" target="_blank" rel="noopener">${esc(row[A.name]||'—')}</a></td>
      <td>${esc(genre(row[A.genre]))}</td>
      <td class="num"><strong>${compact(row[A.catalogue_streams])}</strong></td>
      <td class="num">${delta(row[A.delta_24h])}</td>
      <td class="num">${compact(row[A.monthly_listeners])}</td>
      <td class="num">${fullNumber(row[A.track_count])}</td>
      <td class="fast-date">${date(row[A.latest_release])}</td>
    </tr>`).join('');
    view.innerHTML=heading(w('allArtists'),total)+toolbar([
      ['streams',w('streams')],['listeners',w('monthlyListeners')],['velocity',w('velocity')],['latest',w('latest')],['name',w('artist')],
    ])+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('artist'))}</th><th>${esc(w('genre'))}</th><th class="num">${esc(w('catalogue'))}</th><th class="num">${esc(w('velocity'))}</th><th class="num">${esc(w('monthlyListeners'))}</th><th class="num">${esc(w('tracks'))}</th><th>${esc(w('latest'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(rows.length);
    bindToolbar();
  }

  function renderPlaylists(){
    let rows=source('playlists').filter(row=>includesQuery([row[P.name],row[P.owner],row[P.genre],row[P.use_case]]));
    const sort=state.sort.playlists;
    rows=rows.slice().sort((left,right)=>{
      if(sort==='growth')return (right[P.growth_30d]||0)-(left[P.growth_30d]||0);
      if(sort==='tracks')return (right[P.tracks]||0)-(left[P.tracks]||0);
      if(sort==='name')return String(left[P.name]||'').localeCompare(String(right[P.name]||''));
      return (right[P.followers]||0)-(left[P.followers]||0);
    });
    const total=fullReady?rows.length:boot.counts.playlists;
    const body=rows.slice(0,state.shown).map(row=>`<tr>
      <td class="fast-cover-cell">${image(row[P.image_url])}</td>
      <td><a class="fast-primary" href="https://open.spotify.com/playlist/${encodeURIComponent(row[P.spotify_id])}" target="_blank" rel="noopener">${esc(row[P.name]||'—')}</a></td>
      <td class="fast-secondary">${esc(row[P.owner]||'—')}</td>
      <td class="num"><strong>${compact(row[P.followers])}</strong></td>
      <td class="num">${fullNumber(row[P.tracks])}</td>
      <td>${esc(genre(row[P.genre]))}</td>
      <td>${esc(row[P.use_case]||'—')}</td>
      <td class="fast-date">${date(row[P.last_seen])}</td>
    </tr>`).join('');
    view.innerHTML=heading(w('allPlaylists'),total)+toolbar([
      ['followers',w('followers')],['growth',w('growth')],['tracks',w('tracks')],['name',w('playlists')],
    ])+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('playlists'))}</th><th>${esc(w('owner'))}</th><th class="num">${esc(w('followers'))}</th><th class="num">${esc(w('tracks'))}</th><th>${esc(w('genre'))}</th><th>Usage</th><th>${esc(w('updated'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(rows.length);
    bindToolbar();
  }

  function renderLabels(){
    let rows=source('labels').filter(row=>includesQuery([row[L.name],row[L.email]]));
    const sort=state.sort.labels;
    rows=rows.slice().sort((left,right)=>{
      if(sort==='tracks')return (right[L.tracks]||0)-(left[L.tracks]||0);
      if(sort==='artists')return (right[L.artist_count]||0)-(left[L.artist_count]||0);
      if(sort==='name')return String(left[L.name]||'').localeCompare(String(right[L.name]||''));
      return (right[L.streams]||0)-(left[L.streams]||0);
    });
    const total=fullReady?rows.length:boot.counts.labels;
    const body=rows.slice(0,state.shown).map(row=>`<tr>
      <td class="fast-cover-cell">${image(row[L.logo],'label-logo')}</td>
      <td><span class="fast-primary">${esc(row[L.name]||'—')}</span>${row[L.email]?`<a class="fast-email" href="mailto:${esc(row[L.email])}">${esc(row[L.email])}</a>`:''}</td>
      <td class="num"><strong>${compact(row[L.streams])}</strong></td>
      <td class="num">${fullNumber(row[L.tracks])}</td>
      <td class="num">${fullNumber(row[L.artist_count])}</td>
      <td class="fast-date">${date(row[L.since])}</td>
    </tr>`).join('');
    view.innerHTML=heading(w('allLabels'),total)+toolbar([
      ['streams',w('streams')],['tracks',w('tracks')],['artists',w('artists')],['name',w('labels')],
    ])+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('labels'))}</th><th class="num">${esc(w('streams'))}</th><th class="num">${esc(w('tracks'))}</th><th class="num">${esc(w('artists'))}</th><th>${esc(w('since'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(rows.length);
    bindToolbar();
  }

  function renderSelection(){
    const saved=selectionGet();
    const ids=Object.keys(saved);
    const rows=ids.map(id=>({id,row:findTrack(id),entry:saved[id]})).filter(item=>item.row);
    const body=rows.map(({id,row,entry})=>`<article class="fast-selection-card">
      ${image(row[T.image_url])}
      <div><button type="button" class="fast-primary" data-open-track="${esc(id)}">${esc(row[T.title])}</button><p>${esc(row[T.credit_name])} · ${esc(genre(row[T.genre]))}</p></div>
      <div class="fast-selection-metric"><span>${esc(w('streams'))}</span><strong>${compact(row[T.streams])}</strong></div>
      <div class="fast-selection-metric"><span>${esc(w('velocity'))}</span><strong>${delta(row[T.delta_24h])}</strong></div>
      <div class="fast-selection-metric"><span>${esc(w('stage'))}</span><strong>${esc(entry.status||w('contact'))}</strong></div>
      <button type="button" class="fast-remove" data-select-track="${esc(id)}" aria-label="${esc(w('remove'))}">×</button>
    </article>`).join('');
    view.innerHTML=heading(w('selectionTitle'),rows.length,w('selectedHint'))+(rows.length?`<div class="fast-selection-list">${body}</div>`:`<div class="fast-empty"><strong>${esc(w('selectedEmpty'))}</strong><span>${esc(w('selectedHint'))}</span></div>`);
  }

  function render(){
    const started=window.performance&&window.performance.now?window.performance.now():Date.now();
    document.documentElement.lang=lang;
    document.querySelectorAll('#nav button').forEach(button=>button.classList.toggle('active',button.dataset.v===state.view));
    if(state.view==='radar')renderTracks(true);
    else if(state.view==='opps')renderTracks(false);
    else if(state.view==='artists')renderArtists();
    else if(state.view==='playlists')renderPlaylists();
    else if(state.view==='labels')renderLabels();
    else renderSelection();
    syncRoute();
    updateStaticLanguage();
    const ended=window.performance&&window.performance.now?window.performance.now():Date.now();
    document.documentElement.dataset.spotifyRenderMs=(ended-started).toFixed(1);
  }

  function bindToolbar(){
    const search=document.getElementById('fast-search');
    const sort=document.getElementById('fast-sort');
    if(search){
      search.addEventListener('input',event=>{
        state.query=event.target.value;state.shown=100;
        if(!fullReady)loadFullCatalogue();
        const position=event.target.selectionStart;
        render();
        const replacement=document.getElementById('fast-search');
        if(replacement){replacement.focus();replacement.setSelectionRange(position,position);}
      });
    }
    if(sort)sort.addEventListener('change',event=>{state.sort[state.view]=event.target.value;state.shown=100;render();});
  }

  function loadTrackAnalytics(){
    if(window.SpotifyTrackAnalytics)return Promise.resolve(window.SpotifyTrackAnalytics);
    if(trackAnalyticsPromise)return trackAnalyticsPromise;
    trackAnalyticsPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=`track-analytics.js?v=${encodeURIComponent(boot.source_hash||'track-analytics-v1')}`;
      script.async=true;
      script.onload=()=>window.SpotifyTrackAnalytics?resolve(window.SpotifyTrackAnalytics):reject(new Error('Spotify track analytics did not initialize'));
      script.onerror=()=>reject(new Error('Spotify track analytics failed to load'));
      document.head.appendChild(script);
    }).catch(error=>{trackAnalyticsPromise=null;throw error;});
    return trackAnalyticsPromise;
  }

  async function openTrack(id){
    const initialRow=findTrack(id);if(!initialRow)return;
    const request=++modalRequest;
    const modal=document.getElementById('track-modal');
    const box=document.getElementById('tmbox');
    box.className='tmbox track-analytics-box';
    box.innerHTML=`<button class="fast-modal-close" type="button" data-close-modal aria-label="${esc(w('close'))}">×</button><div class="fast-modal-head">${image(initialRow[T.image_url],'modal-cover')}<div><span class="fast-kicker">${esc(w('detail'))}</span><h3>${esc(initialRow[T.title])}</h3><p>${esc(initialRow[T.credit_name])}</p></div></div><div class="track-analytics-loading">${esc(lang==='fr'?"Chargement de la vue analytique…":'Loading track analytics…')}</div>`;
    modal.style.display='flex';
    try{
      const [catalogue,analyticsModule]=await Promise.all([loadFullCatalogue(),loadTrackAnalytics()]);
      if(request!==modalRequest||modal.style.display==='none')return;
      const fields=catalogue&&catalogue.schemas&&catalogue.schemas.tracks||boot.schemas.tracks;
      const positions=Object.fromEntries(fields.map((field,index)=>[field,index]));
      const rows=[...(catalogue&&Array.isArray(catalogue.tracks)?catalogue.tracks:[]),...(catalogue&&Array.isArray(catalogue.radar)?catalogue.radar:[])];
      const row=rows.find(item=>item[positions.spotify_id]===id)||findTrack(id)||initialRow;
      await analyticsModule.open({
        spotifyId:id,row,schema:fields,box,language:lang,selected:selectionHas(id),
        analytics:catalogue&&catalogue.analytics||boot.analytics,
        assetVersion:boot.source_hash||'track-analytics-v1',
      });
    }catch(error){
      console.error(error);
      if(request!==modalRequest)return;
      box.className='tmbox';
      box.innerHTML=`<button class="fast-modal-close" type="button" data-close-modal aria-label="${esc(w('close'))}">×</button><div class="fast-empty"><strong>${esc(lang==='fr'?"La vue analytique n'a pas pu être chargée.":'Track analytics could not be loaded.')}</strong><span>${esc(lang==='fr'?'Réessaie dans un instant.':'Please try again in a moment.')}</span></div>`;
    }
  }
  function closeModal(){
    modalRequest+=1;
    const modal=document.getElementById('track-modal');
    const box=document.getElementById('tmbox');
    if(window.SpotifyTrackAnalytics)window.SpotifyTrackAnalytics.close(modal);
    if(modal)modal.style.display='none';
    if(box)box.className='tmbox';
  }

  function updateCounts(){
    const counts=boot.counts||{};
    const set=(id,value)=>{const element=document.getElementById(id);if(element)element.textContent=value?compact(value):'';};
    set('c-radar',counts.opportunities);set('c-opps',counts.tracks);set('c-art',counts.artists);set('c-pl',counts.playlists);set('c-lb',counts.labels);set('c-ar-list',Object.keys(selectionGet()).length);
  }
  function updateStaticLanguage(){
    const labels={radar:w('opportunities'),'ar-list':w('selection'),opps:w('tracks'),artists:w('artists'),playlists:w('playlists'),labels:w('labels')};
    document.querySelectorAll('#nav button').forEach(button=>{
      const textNode=[...button.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.nodeValue.trim());
      if(textNode)textNode.nodeValue=labels[button.dataset.v]||textNode.nodeValue;
    });
    const navLabel=document.querySelector('.nav-label');if(navLabel)navLabel.textContent=lang==='fr'?'Analyse':'Analysis';
    const langButton=document.getElementById('lang-btn');
    if(langButton){langButton.classList.toggle('fr',lang==='fr');langButton.querySelectorAll('.lg-opt').forEach(option=>option.classList.toggle('on',option.dataset.l===lang));}
  }
  function updateRuntimeState(){
    const element=document.getElementById('fast-runtime-state');
    if(element)element.textContent=fullReady?w('allData'):w('instant');
  }
  function loadFullCatalogue(){
    if(fullReady){data=window.SPOTIFY_CATALOGUE||data;return Promise.resolve(data);}
    if(fullPromise)return fullPromise;
    const loadStarted=window.performance&&window.performance.now?window.performance.now():Date.now();
    fullPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=`../Spotify_Catalogue_data.js?v=${encodeURIComponent(boot.source_hash||'compact-v2')}`;
      script.async=true;script.fetchPriority='low';
      script.onload=()=>{
        const catalogue=window.SPOTIFY_CATALOGUE;
        if(!catalogue||catalogue.source_hash!==boot.source_hash){reject(new Error('Compact Spotify catalogue version mismatch'));return;}
        data=catalogue;fullReady=true;updateRuntimeState();
        const loadEnded=window.performance&&window.performance.now?window.performance.now():Date.now();
        document.documentElement.dataset.spotifyCatalogueMs=(loadEnded-loadStarted).toFixed(1);
        document.documentElement.dataset.spotifyFullReady='true';
        if(state.query||state.shown>100)render();
        resolve(catalogue);
      };
      script.onerror=()=>reject(new Error('Compact Spotify catalogue failed to load'));
      document.head.appendChild(script);
    }).catch(error=>{console.error(error);fullPromise=null;return boot;});
    return fullPromise;
  }

  nav.addEventListener('click',event=>{
    const button=event.target.closest('button[data-v]');if(!button)return;
    state.view=button.dataset.v;state.query='';state.shown=100;render();window.scrollTo(0,0);
  });
  window.addEventListener('hashchange',()=>{
    const requested=routeToView[location.hash.slice(1)]||'radar';
    if(requested===state.view)return;
    state.view=requested;state.query='';state.shown=100;render();window.scrollTo(0,0);
  });
  view.addEventListener('click',event=>{
    const moreButton=event.target.closest('[data-action="more"]');
    if(moreButton){state.shown+=100;if(!fullReady)loadFullCatalogue();render();return;}
    const selectionButton=event.target.closest('[data-select-track]');
    if(selectionButton){event.stopPropagation();selectionToggle(selectionButton.dataset.selectTrack);return;}
    const trackButton=event.target.closest('[data-open-track]');
    if(trackButton){openTrack(trackButton.dataset.openTrack);return;}
  });
  document.getElementById('track-modal').addEventListener('click',event=>{
    if(event.target===event.currentTarget||event.target.closest('[data-close-modal]'))closeModal();
    const selectionButton=event.target.closest('[data-select-track]');
    if(selectionButton){selectionToggle(selectionButton.dataset.selectTrack);closeModal();}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal();});
  document.getElementById('lang-btn').addEventListener('click',()=>{
    lang=lang==='fr'?'en':'fr';try{localStorage.setItem('sr_lang',lang);}catch(error){}render();
  });
  window.toggleSpotifyUpdateStatus=event=>{
    if(event)event.stopPropagation();
    const button=document.getElementById('btn-spotify-update-status');
    const panel=document.getElementById('spotify-update-status-panel');
    if(!button||!panel)return;
    const open=panel.hidden;
    panel.innerHTML=`<div class="spotify-update-status-head"><span>${lang==='fr'?'État des mises à jour':'Update status'}</span><small>${esc(w('instant'))}</small></div><div class="spotify-update-status-line"><i class="spotify-update-status-dot" style="background:var(--acc2);color:var(--acc2)"></i><div><b>${esc(w('catalogue'))}</b><span>${date(boot.generated_at)} · ${fullNumber(boot.counts.tracks)} ${esc(w('tracksCount'))}</span></div></div>`;
    panel.hidden=!open;button.setAttribute('aria-expanded',String(open));
  };
  document.addEventListener('click',()=>{const panel=document.getElementById('spotify-update-status-panel');if(panel)panel.hidden=true;});

  if(window.SPOTIFY_CATALOGUE){data=window.SPOTIFY_CATALOGUE;fullReady=true;}
  updateCounts();render();
  performance.mark&&performance.mark('spotify-radar-interactive');
  window.SPOTIFY_LIGHT_RUNTIME_READY=true;
  document.documentElement.dataset.spotifyReady='true';
  document.documentElement.dataset.spotifyBootMs=(window.performance&&window.performance.now?window.performance.now():0).toFixed(1);
})();
