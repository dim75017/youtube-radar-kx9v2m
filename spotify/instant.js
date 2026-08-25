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

  const routeToView={dashboard:'dashboard',overview:'dashboard',opportunities:'radar',radar:'radar',opps:'radar',tracks:'opps','ar-list':'ar-list',artists:'artists',playlists:'playlists',labels:'labels'};
  const viewToRoute={dashboard:'dashboard',opps:'tracks',radar:'opportunities','ar-list':'ar-list',artists:'artists',playlists:'playlists',labels:'labels'};
  const validViews=new Set(Object.values(routeToView));
  const schema={};
  for(const [name,fields] of Object.entries(boot.schemas))schema[name]=Object.fromEntries(fields.map((field,index)=>[field,index]));
  const T=schema.tracks,A=schema.artists,P=schema.playlists,L=schema.labels;
  const AR_LIST_STORAGE='spotify_ar_outreach_list_v1';
  const AR_ARTIST_STORAGE='spotify_ar_outreach_artists_v1';
  const parseStoredObject=raw=>{try{const value=JSON.parse(raw||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch(error){return {};}};
  const readStoredObject=key=>{try{return parseStoredObject(localStorage.getItem(key));}catch(error){return {};}};
  let selectionCache=readStoredObject(AR_LIST_STORAGE);
  let selectionArtistCache=readStoredObject(AR_ARTIST_STORAGE);
  let selectionContextMenu=null;
  let data=boot;
  let fullReady=Boolean(window.SPOTIFY_CATALOGUE);
  let fullPromise=null;
  let refreshWaiting=false;
  let refreshFocus='';
  let trackAnalyticsPromise=null;
  let modalRequest=0;
  let lang='fr';
  try{lang=localStorage.getItem('sr_lang')||'fr';}catch(error){}
  const initialRoute=location.hash.slice(1);
  const state={
    view:routeToView[initialRoute]||'dashboard',
    query:'',shown:100,
    sort:{opps:'streams',radar:'velocity',artists:'streams',playlists:'followers',labels:'streams'},
    filters:{
      radar:{genre:'all'},
      opps:{genres:new Set(),period:'all',rights:'all',min:0,relation:'all'},
      artists:{genres:new Set(),ownership:'all'},
      playlists:{curator:'all',genre:'all'},
      selection:{stage:'to_contact'},
    },
    openFilter:'',
  };
  if(!validViews.has(state.view))state.view='dashboard';

  const words={
    fr:{
      dashboard:'Tableau de bord',opportunities:'Opportunités',selection:'Sélection',tracks:'Pistes',artists:'Artistes',playlists:'Playlists',labels:'Labels',
      allTracks:'Toutes les pistes',allArtists:'Tous les artistes',allPlaylists:'Toutes les playlists',allLabels:'Tous les labels',
      radarTitle:'Opportunités',selectionTitle:'Sélection',search:'Rechercher',artist:'Artiste',track:'Piste',release:'Sortie',
      streams:'Streams',velocity:'24 h',rights:'Droits',genre:'Genre',followers:'Followers',owner:'Propriétaire',catalogue:'Catalogue',
      tracksCount:'pistes',monthlyListeners:'Auditeurs mensuels',latest:'Dernière sortie',growth:'Croissance',since:'Depuis',
      loadMore:'Afficher plus',loadingCatalogue:'Catalogue complet en cours de chargement…',empty:'Aucun résultat.',
      add:'Ajouter à la sélection',remove:'Retirer de la sélection',openSpotify:'Ouvrir dans Spotify',close:'Fermer',
      independent:'Indépendant',label:'Label',unknown:'À confirmer',updated:'Mis à jour',instant:'Interface prête',
      detail:'Détail de la piste',selectedEmpty:'Aucune piste dans la sélection.',selectedHint:'Les opportunités ajoutées au radar apparaissent ici.',
      stage:'Étape',contact:'À contacter',dateAdded:'Ajoutée',sort:'Trier',allData:'catalogue complet',
      all:'Tous',allGenres:'Tous les genres',filterGenre:'Genre',period:'Période',rightsFilter:'Propriété',streamFloor:'Seuil streams',catalogueUnavailable:'Catalogue complet indisponible. Aucun résultat partiel n’est affiché.',
      relation:'Relation Lofi Girl',curator:'Curateur',clearFilters:'Effacer les filtres',last30:'30 jours',last90:'90 jours',last180:'180 jours',last365:'12 mois',allHistory:'Tout l’historique',
      self:'Indie',otherLabel:'Label',unconfirmed:'À confirmer',loyal:'Loyal (>50)',regular:'Regular (25–50)',occasional:'Occasional (1–24)',never:'Jamais',
      editorial:'Éditoriales',independentCurators:'Indépendantes',toContact:'À contacter',contacted:'Contacté',negotiating:'En négociation',validated:'Validé',refused:'Refusé',alreadySelected:'Déjà dans la sélection',
    },
    en:{
      dashboard:'Dashboard',opportunities:'Opportunities',selection:'Selection',tracks:'Tracks',artists:'Artists',playlists:'Playlists',labels:'Labels',
      allTracks:'All tracks',allArtists:'All artists',allPlaylists:'All playlists',allLabels:'All labels',
      radarTitle:'Opportunities',selectionTitle:'Selection',search:'Search',artist:'Artist',track:'Track',release:'Released',
      streams:'Streams',velocity:'24 h',rights:'Rights',genre:'Genre',followers:'Followers',owner:'Owner',catalogue:'Catalogue',
      tracksCount:'tracks',monthlyListeners:'Monthly listeners',latest:'Latest release',growth:'Growth',since:'Since',
      loadMore:'Show more',loadingCatalogue:'Loading the full catalogue…',empty:'No results.',
      add:'Add to selection',remove:'Remove from selection',openSpotify:'Open in Spotify',close:'Close',
      independent:'Independent',label:'Label',unknown:'To confirm',updated:'Updated',instant:'Interface ready',
      detail:'Track detail',selectedEmpty:'No track in the selection.',selectedHint:'Opportunities added from the radar appear here.',
      stage:'Stage',contact:'To contact',dateAdded:'Added',sort:'Sort',allData:'full catalogue',
      all:'All',allGenres:'All genres',filterGenre:'Genre',period:'Period',rightsFilter:'Ownership',streamFloor:'Stream floor',catalogueUnavailable:'The full catalogue is unavailable. No partial result is being shown.',
      relation:'Lofi Girl relation',curator:'Curator',clearFilters:'Clear filters',last30:'30 days',last90:'90 days',last180:'180 days',last365:'12 months',allHistory:'All time',
      self:'Indie',otherLabel:'Label',unconfirmed:'To confirm',loyal:'Loyal (>50)',regular:'Regular (25–50)',occasional:'Occasional (1–24)',never:'Never',
      editorial:'Editorial',independentCurators:'Independent',toContact:'To contact',contacted:'Contacted',negotiating:'Negotiating',validated:'Validated',refused:'Refused',alreadySelected:'Already in selection',
    },
  };
  const w=key=>words[lang][key]||key;
  const esc=value=>String(value==null?'':value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const number=value=>value==null||String(value).trim()===''?null:(Number.isFinite(Number(value))?Number(value):null);
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
  const GENRES=[
    ['lofi_hip_hop','🎧','Lofi hip-hop'],['guitar','🎸',lang==='fr'?'Guitare / acoustic':'Guitar / acoustic'],
    ['halloween_lofi','🎃','Halloween Lofi'],['nature','🌿',lang==='fr'?'Nature / soundscapes':'Nature / soundscapes'],
    ['christmas_lofi','🎄','Christmas Lofi'],['jazz_jazzhop','🎷','Jazz / jazzhop'],['classical','🎻',lang==='fr'?'Classique':'Classical'],
    ['ambient','💤','Ambient'],['piano','🎹','Piano'],['dark_ambient','🌑','Dark ambient'],
    ['phonk_instrumental','🎵','Phonk instrumental'],['dnb_instrumental','🥁','DnB instrumental'],
    ['synthwave','🌌','Synthwave / retro'],['unclassified','🏷️',lang==='fr'?'À classifier':'Unclassified'],
  ];
  const genreKey=value=>{
    const key=normalize(value).replace(/[\s/-]+/g,'_');
    if(!key||['trusted_catalogue','catalogue_trusted','catalogue_trusted_'].includes(key))return 'unclassified';
    if(['acoustic','fingerstyle'].includes(key))return 'guitar';
    if(['jazz','jazzhop'].includes(key))return 'jazz_jazzhop';
    return key;
  };
  const genreText=item=>item[0]==='guitar'?(lang==='fr'?'Guitare / acoustic':'Guitar / acoustic'):item[0]==='classical'?(lang==='fr'?'Classique':'Classical'):item[0]==='unclassified'?(lang==='fr'?'À classifier':'Unclassified'):item[2];
  const genreLabel=value=>{const key=genreKey(value),match=GENRES.find(item=>item[0]===key);return match?`${match[1]} ${genreText(match)}`:genre(value);};
  const facetValues=name=>Array.isArray(boot.facets&&boot.facets[name])?boot.facets[name].map(item=>Array.isArray(item)?item[0]:item):[];
  const genreValues=name=>{
    const available=new Set(facetValues(name).map(genreKey));
    return GENRES.filter(item=>available.has(item[0]));
  };
  const filterSelect=(key,label,options,value)=>`<label class="fast-filter"><span>${esc(label)}</span><select data-fast-filter="${esc(key)}" aria-label="${esc(label)}">${options.map(([option,text])=>`<option value="${esc(option)}" ${String(option)===String(value)?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
  function genreMulti(scope,selected,facet){
    const count=selected.size,label=count?`${w('filterGenre')} · ${count}`:w('allGenres');
    return `<details class="fast-multi" data-fast-multi="${esc(scope)}" ${state.openFilter===scope?'open':''}><summary>${esc(label)}</summary><div class="fast-multi-menu"><label><input type="checkbox" value="" ${count?'':'checked'}> ${esc(w('allGenres'))}</label>${genreValues(facet).map(item=>`<label><input type="checkbox" value="${item[0]}" ${selected.has(item[0])?'checked':''}> ${esc(`${item[1]} ${genreText(item)}`)}</label>`).join('')}</div></details>`;
  }
  const resetButton=active=>active?`<button class="fast-filter-reset" type="button" data-action="clear-filters">× ${esc(w('clearFilters'))}</button>`:'';
  const rightsKey=value=>{
    const key=String(value||'').toLowerCase();
    if(['self_released','self-released','indie'].includes(key))return 'self';
    if(['independent_label','label','major','catalogue_trusted','trusted_catalogue'].includes(key))return 'label';
    return 'unknown';
  };
  const relationKey=value=>{const n=Number(value)||0;return n>50?'top':n>=25?'reg':n>0?'occ':'ext';};
  const referenceDay=Date.parse(`${String(boot.generated_at||'').slice(0,10)}T00:00:00Z`)||Date.now();
  const ageDays=value=>{const parsed=Date.parse(String(value||'').slice(0,10)+'T00:00:00Z');return Number.isFinite(parsed)?Math.max(0,Math.floor((referenceDay-parsed)/86400000)):Infinity;};
  function filtersActive(scope){
    const filter=state.filters[scope];if(!filter)return false;
    return Object.entries(filter).some(([key,value])=>key==='genres'?value.size>0:String(value)!=='all'&&String(value)!=='0');
  }
  function clearFilters(scope){
    if(scope==='radar')state.filters.radar.genre='all';
    if(scope==='opps')state.filters.opps={genres:new Set(),period:'all',rights:'all',min:0,relation:'all'};
    if(scope==='artists')state.filters.artists={genres:new Set(),ownership:'all'};
    if(scope==='playlists')state.filters.playlists={curator:'all',genre:'all'};
    state.shown=100;
  }
  const delta=value=>{
    const n=number(value);if(n==null)return '<span class="fast-delta muted">—</span>';
    const cls=n>0?'up':n<0?'down':'muted';
    return `<span class="fast-delta ${cls}">${n>0?'+':''}${compact(n)}</span>`;
  };
  const image=(url,kind='cover')=>url
    ?`<img class="fast-${kind}" src="${esc(url)}" alt="" loading="lazy" decoding="async" fetchpriority="low">`
    :`<span class="fast-${kind} fast-placeholder" aria-hidden="true">♫</span>`;

  function persistStoredObject(key,value){
    const serialized=JSON.stringify(value);
    try{localStorage.setItem(key,serialized);document.documentElement.dataset.spotifySelectionStorage='persistent';return true;}
    catch(error){document.documentElement.dataset.spotifySelectionStorage='memory';return false;}
  }
  function selectionGet(){return selectionCache;}
  function selectionSet(value){selectionCache=value&&typeof value==='object'&&!Array.isArray(value)?value:{};return persistStoredObject(AR_LIST_STORAGE,selectionCache);}
  function selectionArtistGet(){return selectionArtistCache;}
  function selectionArtistSet(value){selectionArtistCache=value&&typeof value==='object'&&!Array.isArray(value)?value:{};return persistStoredObject(AR_ARTIST_STORAGE,selectionArtistCache);}
  function selectionHas(id){return Boolean(selectionGet()[id]);}
  function storedSelectionStage(entry){
    const key=String(entry&&entry.status||'').trim().toLowerCase();
    if(key==='closed')return 'validated';if(key==='follow_up')return 'contacted';if(key==='negotiation')return 'negotiating';
    return ['to_contact','contacted','negotiating','validated','refused'].includes(key)?key:'to_contact';
  }
  function selectionArtistKey(track){
    const spotifyId=String(track&&track[T.artist_spotify_id]||'').trim();
    const credit=String(track&&track[T.credit_name]||'').trim().toLowerCase();
    return spotifyId?`spotify:${spotifyId}`:(credit?`credit:${credit}`:'');
  }
  function selectionAdd(id){
    const key=String(id||'').trim(),track=findTrack(key);if(!key||!track)return false;
    const items=selectionGet(),artists=selectionArtistGet(),artistKey=selectionArtistKey(track),now=new Date().toISOString();
    const previous=items[key]&&typeof items[key]==='object'?items[key]:{};
    const addedAt=previous.addedAt||previous.selectionAddedAt||now;
    const inheritedStatus=previous.status||storedSelectionStage(artistKey&&artists[artistKey]);
    items[key]=Object.assign({addedAt,status:inheritedStatus,note:'',nextFollowUp:'',contactedAt:'',subject:'',body:''},previous,{
      spotifyId:key,title:track[T.title]||'',artistName:track[T.credit_name]||'',addedAt,selectionAddedAt:addedAt,
    });
    if(artistKey)artists[artistKey]=Object.assign({status:'to_contact',selectionAddedAt:addedAt},artists[artistKey]||{});
    selectionSet(items);selectionArtistSet(artists);updateCounts();render();return true;
  }
  function selectionRemove(id){
    const key=String(id||'').trim(),items=selectionGet();if(!key||!items[key])return false;
    delete items[key];selectionSet(items);updateCounts();render();return true;
  }
  function selectionToggle(id){return selectionHas(id)?selectionRemove(id):selectionAdd(id);}
  function closeSelectionContextMenu(){
    if(selectionContextMenu&&selectionContextMenu.isConnected)selectionContextMenu.remove();
    selectionContextMenu=null;
  }
  function openSelectionContextMenu(id,clientX,clientY){
    const key=String(id||'').trim(),track=findTrack(key);if(!key||!track)return false;
    closeSelectionContextMenu();
    const selected=selectionHas(key),menu=document.createElement('div');
    menu.className='fast-context-menu';menu.setAttribute('role','menu');
    menu.innerHTML=`<button type="button" role="menuitem" data-selection-context-add ${selected?'disabled':''}>${selected?'✓':'⭐'} ${esc(selected?w('alreadySelected'):w('add'))}</button>`;
    document.body.appendChild(menu);
    const width=menu.offsetWidth||230,height=menu.offsetHeight||44;
    menu.style.left=Math.max(8,Math.min(Number(clientX)||0,window.innerWidth-width-8))+'px';
    menu.style.top=Math.max(8,Math.min(Number(clientY)||0,window.innerHeight-height-8))+'px';
    const action=menu.querySelector('[data-selection-context-add]');
    if(action&&!selected)action.addEventListener('click',event=>{event.stopPropagation();closeSelectionContextMenu();selectionAdd(key);});
    selectionContextMenu=menu;
    window.setTimeout(()=>document.addEventListener('click',closeSelectionContextMenu,{once:true}),0);
    return true;
  }

  function source(name){
    if(name==='selection')return [];
    return Array.isArray(data[name])?data[name]:[];
  }
  function findTrack(id){return source('tracks').find(row=>row[T.spotify_id]===id)||source('radar').find(row=>row[T.spotify_id]===id)||boot.tracks.find(row=>row[T.spotify_id]===id)||boot.radar.find(row=>row[T.spotify_id]===id);}
  function normalize(value){return String(value||'').toLocaleLowerCase(lang==='fr'?'fr':'en').normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
  function matchesQuery(query,values){const terms=normalize(query).trim().split(/\s+/).filter(Boolean);if(!terms.length)return true;const haystack=normalize(values.flat(Infinity).join(' '));return terms.every(term=>haystack.includes(term));}
  function includesQuery(values){return matchesQuery(state.query,values);}
  function syncRoute(){
    const route=viewToRoute[state.view]||'tracks';
    try{history.replaceState(null,'',`${location.pathname}${location.search}#${route}`);}catch(error){}
  }

  function toolbar(sortOptions,filters=''){
    const current=state.sort[state.view];
    return `<div class="fast-toolbar">
      <label class="fast-search"><span aria-hidden="true">⌕</span><input id="fast-search" type="search" value="${esc(state.query)}" placeholder="${esc(w('search'))}" autocomplete="off"></label>
      ${filters?`<div class="fast-filters">${filters}</div>`:''}
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
  const facetRows=name=>Array.isArray(boot.facets&&boot.facets[name])?boot.facets[name]:[];
  const facetCount=(name,key)=>{const row=facetRows(name).find(item=>Array.isArray(item)&&String(item[0])===String(key));return row?Number(row[1])||0:0;};
  const percent=(value,total)=>!Number(total)?'0 %':new Intl.NumberFormat(lang==='fr'?'fr-FR':'en-GB',{maximumFractionDigits:1}).format(value/total*100)+' %';
  const dashboardStage=value=>{const key=String(value||'to_contact').trim().toLowerCase();if(key==='closed')return 'validated';if(key==='follow_up')return 'contacted';if(key==='negotiation')return 'negotiating';return ['to_contact','contacted','negotiating','validated','refused'].includes(key)?key:'to_contact';};
  const dashboardWidth=value=>Math.max(0,Math.min(100,Number(value)||0));
  function renderDashboard(){
    const counts=boot.counts||{},fr=lang==='fr';
    const copy=fr?{
      title:'Tableau de bord',subtitle:'Lecture rapide du catalogue, des signaux et du pipeline A&R.',updated:'Snapshot assemblé le',
      opportunities:'Opportunités',tracks:'Pistes',artists:'Artistes',playlists:'Playlists',selection:'Sélection',catalogueShare:'du catalogue',instrumentalCatalogue:'catalogue instrumental public',indieArtists:'artistes indépendants',editorialPlaylists:'playlists éditoriales',validated:'validées',
      signals:'Signaux les plus rapides',signalsHint:'Opportunités classées par progression sur 24 h',measured:'mesure au',seeAll:'Tout voir',streamTotal:'Streams',daily:'24 h',
      pipeline:'Pipeline A&R',pipelineHint:'État de la sélection enregistrée dans ce navigateur',toContact:'À contacter',contacted:'Contacté',negotiating:'En négociation',approved:'Validé',refused:'Refusé',
      genres:'Genres classifiés',genresHint:'Répartition des pistes dont le genre musical est renseigné',classified:'pistes classifiées sur',
      independence:'Indépendance',independenceHint:'Propriété des artistes et des sorties',indie:'Indépendants',labelArtists:'Artistes label',selfReleased:'Autoéditées',indieLabels:'Labels indépendants',reference:'Catalogue de référence',majors:'Majors',unknown:'À confirmer',
      playlistWatch:'Veille playlists',playlistHint:'Curateurs suivis, tous à 10k followers minimum',editorial:'Éditoriales',independentCurators:'Indépendantes',emptySignals:'Aucun signal disponible.',emptySelection:'Aucune piste sélectionnée pour le moment.',openSelection:'Ouvrir la sélection',
    }:{
      title:'Dashboard',subtitle:'A quick read of the catalogue, signals and A&R pipeline.',updated:'Snapshot built on',
      opportunities:'Opportunities',tracks:'Tracks',artists:'Artists',playlists:'Playlists',selection:'Selection',catalogueShare:'of catalogue',instrumentalCatalogue:'public instrumental catalogue',indieArtists:'independent artists',editorialPlaylists:'editorial playlists',validated:'validated',
      signals:'Fastest signals',signalsHint:'Opportunities ranked by 24-hour growth',measured:'measured through',seeAll:'View all',streamTotal:'Streams',daily:'24 h',
      pipeline:'A&R pipeline',pipelineHint:'Status of the selection stored in this browser',toContact:'To contact',contacted:'Contacted',negotiating:'Negotiating',approved:'Validated',refused:'Refused',
      genres:'Classified genres',genresHint:'Distribution of tracks with a musical genre',classified:'classified tracks out of',
      independence:'Independence',independenceHint:'Artist and release ownership',indie:'Independent',labelArtists:'Label artists',selfReleased:'Self-released',indieLabels:'Independent labels',reference:'Reference catalogue',majors:'Majors',unknown:'To confirm',
      playlistWatch:'Playlist watch',playlistHint:'Monitored curators, all with at least 10k followers',editorial:'Editorial',independentCurators:'Independent',emptySignals:'No signal available.',emptySelection:'No track selected yet.',openSelection:'Open selection',
    };
    const selected=Object.values(selectionGet()),stageLabels={to_contact:copy.toContact,contacted:copy.contacted,negotiating:copy.negotiating,validated:copy.approved,refused:copy.refused};
    const stageCounts=Object.fromEntries(Object.keys(stageLabels).map(key=>[key,selected.filter(entry=>dashboardStage(entry&&entry.status)===key).length]));
    const indieArtists=facetCount('artist_ownership','indie'),labelArtists=facetCount('artist_ownership','label');
    const editorialPlaylists=facetCount('playlist_curators','editorial'),independentPlaylists=facetCount('playlist_curators','independent');
    const metric=(target,icon,label,value,sub,tone)=>`<button class="fast-dashboard-kpi ${tone}" type="button" data-dashboard-view="${target}"><span class="fast-dashboard-kpi-icon" aria-hidden="true">${icon}</span><span class="fast-dashboard-kpi-label">${esc(label)}</span><strong>${value}</strong><small>${esc(sub)}</small></button>`;
    const metrics=[
      metric('radar','💎',copy.opportunities,fullNumber(counts.opportunities),`${percent(counts.opportunities,counts.tracks)} ${copy.catalogueShare}`,'signal'),
      metric('opps','🎶',copy.tracks,fullNumber(counts.tracks),copy.instrumentalCatalogue,'catalogue'),
      metric('artists','🎸',copy.artists,fullNumber(counts.artists),`${fullNumber(indieArtists)} ${copy.indieArtists}`,'artists'),
      metric('playlists','📻',copy.playlists,fullNumber(counts.playlists),`${fullNumber(editorialPlaylists)} ${copy.editorialPlaylists}`,'playlists'),
      metric('ar-list','⭐',copy.selection,fullNumber(selected.length),`${fullNumber(stageCounts.validated)} ${copy.validated}`,'selection'),
    ].join('');
    const signals=source('radar').slice().sort((left,right)=>(Number(right[T.delta_24h])||0)-(Number(left[T.delta_24h])||0)).slice(0,6);
    const signalRows=signals.map(row=>{const id=String(row[T.spotify_id]||''),selectedTrack=selectionHas(id);return `<article class="fast-dashboard-signal">${image(row[T.image_url])}<button class="fast-dashboard-signal-main" type="button" data-open-track="${esc(id)}"><strong>${esc(row[T.title]||'—')}</strong><span>${esc(row[T.credit_name]||'—')} · ${esc(genreLabel(row[T.genre]))}</span></button><div class="fast-dashboard-signal-metric"><span>${esc(copy.streamTotal)}</span><strong>${compact(row[T.streams])}</strong></div><div class="fast-dashboard-signal-metric fast-dashboard-signal-delta"><span>${esc(copy.daily)}</span><strong>${delta(row[T.delta_24h])}</strong></div><button type="button" class="fast-select ${selectedTrack?'on':''}" data-selection-add="${esc(id)}" aria-label="${esc(copy.selection)}" ${selectedTrack?'disabled':''}>${selectedTrack?'✓':'＋'}</button></article>`;}).join('');
    const signalFreshness=signals.length&&signals[0][T.updated_at]?` · ${copy.measured} ${date(signals[0][T.updated_at])}`:'';
    const stageMax=Math.max(1,...Object.values(stageCounts));
    const pipelineRows=Object.entries(stageLabels).map(([key,label])=>`<div class="fast-dashboard-progress-row"><div><span>${esc(label)}</span><strong>${fullNumber(stageCounts[key])}</strong></div><i><b style="width:${dashboardWidth(stageCounts[key]/stageMax*100)}%"></b></i></div>`).join('');
    const groupedGenres=new Map();
    for(const item of facetRows('track_genres')){if(!Array.isArray(item))continue;const key=genreKey(item[0]);if(['trusted_catalogue','catalogue_trusted','unclassified'].includes(key))continue;groupedGenres.set(key,(groupedGenres.get(key)||0)+(Number(item[1])||0));}
    const genreRows=[...groupedGenres].sort((a,b)=>b[1]-a[1]).slice(0,7),classifiedTotal=[...groupedGenres.values()].reduce((sum,value)=>sum+value,0),genreMax=Math.max(1,...genreRows.map(item=>item[1]));
    const genreBars=genreRows.map(([key,value])=>`<div class="fast-dashboard-bar-row"><span>${esc(genreLabel(key))}</span><i><b style="width:${dashboardWidth(value/genreMax*100)}%"></b></i><strong>${fullNumber(value)}</strong></div>`).join('');
    const rights=[[copy.selfReleased,facetCount('track_rights','self_released'),'self'],[copy.indieLabels,facetCount('track_rights','independent_label'),'label'],[copy.reference,facetCount('track_rights','catalogue_trusted'),'reference'],[copy.majors,facetCount('track_rights','major'),'major'],[copy.unknown,facetCount('track_rights','unknown'),'unknown']],rightsMax=Math.max(1,...rights.map(item=>item[1]));
    const rightsRows=rights.map(([label,value,tone])=>`<div class="fast-dashboard-bar-row ${tone}"><span>${esc(label)}</span><i><b style="width:${dashboardWidth(value/rightsMax*100)}%"></b></i><strong>${fullNumber(value)}</strong></div>`).join('');
    const artistTotal=Math.max(1,indieArtists+labelArtists),playlistTotal=Math.max(1,editorialPlaylists+independentPlaylists);
    view.innerHTML=`<div class="page-head fast-page-head fast-dashboard-head"><div><h2>${esc(copy.title)}</h2><p>${esc(copy.subtitle)}</p></div><span class="fast-dashboard-fresh"><i></i>${esc(copy.updated)} ${date(boot.generated_at)}</span></div><section class="fast-dashboard-kpis" aria-label="${esc(copy.title)}">${metrics}</section><div class="fast-dashboard-primary"><section class="fast-dashboard-panel"><header><div><h3>${esc(copy.signals)}</h3><p>${esc(copy.signalsHint+signalFreshness)}</p></div><button type="button" data-dashboard-view="radar">${esc(copy.seeAll)} →</button></header>${signalRows||`<div class="fast-dashboard-empty">${esc(copy.emptySignals)}</div>`}</section><section class="fast-dashboard-panel fast-dashboard-pipeline"><header><div><h3>${esc(copy.pipeline)}</h3><p>${esc(copy.pipelineHint)}</p></div><button type="button" data-dashboard-view="ar-list">${esc(copy.openSelection)} →</button></header>${pipelineRows}${selected.length?'':`<div class="fast-dashboard-empty compact">${esc(copy.emptySelection)}</div>`}</section></div><div class="fast-dashboard-secondary"><section class="fast-dashboard-panel"><header><div><h3>${esc(copy.genres)}</h3><p>${esc(copy.genresHint)}</p></div><button type="button" data-dashboard-view="opps">${esc(copy.seeAll)} →</button></header><div class="fast-dashboard-bars">${genreBars}</div><small class="fast-dashboard-note">${fullNumber(classifiedTotal)} ${esc(copy.classified)} ${fullNumber(counts.tracks)}</small></section><section class="fast-dashboard-panel"><header><div><h3>${esc(copy.independence)}</h3><p>${esc(copy.independenceHint)}</p></div><button type="button" data-dashboard-view="artists">${esc(copy.seeAll)} →</button></header><div class="fast-dashboard-split" aria-hidden="true"><i style="width:${dashboardWidth(indieArtists/artistTotal*100)}%"></i><b style="width:${dashboardWidth(labelArtists/artistTotal*100)}%"></b></div><div class="fast-dashboard-legend"><span><i class="indie"></i>${esc(copy.indie)}<strong>${fullNumber(indieArtists)}</strong></span><span><i class="label"></i>${esc(copy.labelArtists)}<strong>${fullNumber(labelArtists)}</strong></span></div><div class="fast-dashboard-bars rights">${rightsRows}</div></section><section class="fast-dashboard-panel"><header><div><h3>${esc(copy.playlistWatch)}</h3><p>${esc(copy.playlistHint)}</p></div><button type="button" data-dashboard-view="playlists">${esc(copy.seeAll)} →</button></header><div class="fast-dashboard-playlist-total"><strong>${fullNumber(counts.playlists)}</strong><span>${esc(copy.playlists)}</span></div><div class="fast-dashboard-split playlists" aria-hidden="true"><i style="width:${dashboardWidth(editorialPlaylists/playlistTotal*100)}%"></i><b style="width:${dashboardWidth(independentPlaylists/playlistTotal*100)}%"></b></div><div class="fast-dashboard-legend"><span><i class="editorial"></i>${esc(copy.editorial)}<strong>${fullNumber(editorialPlaylists)}</strong></span><span><i class="curators"></i>${esc(copy.independentCurators)}<strong>${fullNumber(independentPlaylists)}</strong></span></div></section></div>`;
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
        ${opportunity?`<td class="fast-action-cell"><button type="button" class="fast-select ${selected?'on':''}" data-selection-add="${esc(id)}" aria-label="${esc(selected?w('alreadySelected'):w('add'))}" ${selected?'disabled':''}>${selected?'✓':'＋'}</button></td>`:''}
      </tr>`;
    }).join('');
  }
  function trackTable(rows,opportunity=false){
    return `<div class="fast-table-wrap"><table class="fast-table fast-track-table"><thead><tr><th></th><th>${esc(w('track'))}</th><th>${esc(w('artist'))}</th><th class="num">${esc(w('streams'))}</th><th class="num">${esc(w('velocity'))}</th><th>${esc(w('genre'))}</th><th>${esc(w('release'))}</th><th>${esc(w('rights'))}</th>${opportunity?'<th></th>':''}</tr></thead><tbody>${trackRows(rows,opportunity)}</tbody></table></div>`;
  }

  function trackFilters(opportunity){
    const filter=state.filters[opportunity?'radar':'opps'];
    if(opportunity){
      const options=[['all',`🎼 ${w('allGenres')}`],...genreValues('track_genres').map(item=>[item[0],`${item[1]} ${genreText(item)}`])];
      return filterSelect('genre',w('filterGenre'),options,filter.genre)+resetButton(filtersActive('radar'));
    }
    return genreMulti('opps',filter.genres,'track_genres')+
      filterSelect('period',w('period'),[['30',`🟢 ${w('last30')}`],['90',`🟡 ${w('last90')}`],['180',`🟠 ${w('last180')}`],['365',`🔴 ${w('last365')}`],['all',`🔵 ${w('allHistory')}`]],filter.period)+
      filterSelect('rights',w('rightsFilter'),[['all',`🌍 ${w('all')}`],['self',`🎛️ ${w('self')}`],['label',`🏷️ ${w('otherLabel')}`],['unknown',`❔ ${w('unconfirmed')}`]],filter.rights)+
      filterSelect('min',w('streamFloor'),[['0',`📊 ${w('all')}`],['100000','🔥 ≥ 100k'],['500000','🔥 ≥ 500k'],['1000000','🚀 ≥ 1M'],['5000000','💎 ≥ 5M']],filter.min)+
      filterSelect('relation',w('relation'),[['all',`🎸 ${w('all')}`],['top',`⭐ ${w('loyal')}`],['reg',`🔁 ${w('regular')}`],['occ',`🎲 ${w('occasional')}`],['ext',`🚫 ${w('never')}`]],filter.relation)+
      resetButton(filtersActive('opps'));
  }
  function artistFilters(){
    const filter=state.filters.artists;
    return genreMulti('artists',filter.genres,'artist_genres')+
      filterSelect('ownership',w('rightsFilter'),[['all',`🌍 ${w('all')}`],['indie',`🎛️ ${w('self')}`],['label',`🏷️ ${w('otherLabel')}`]],filter.ownership)+
      resetButton(filtersActive('artists'));
  }
  function playlistFilters(){
    const filter=state.filters.playlists;
    const genres=facetValues('playlist_genres').map(value=>[value,genreLabel(value)]);
    return filterSelect('curator',w('curator'),[['all',`🌍 ${w('all')}`],['editorial',`🏛️ ${w('editorial')}`],['independent',`🌱 ${w('independentCurators')}`]],filter.curator)+
      filterSelect('genre',w('filterGenre'),[['all',`🎼 ${w('allGenres')}`],...genres],filter.genre)+resetButton(filtersActive('playlists'));
  }

  function renderTracks(opportunity=false){
    const scope=opportunity?'radar':'opps',filter=state.filters[scope];
    const artists=new Map(source('artists').map(row=>[row[A.spotify_id],row]));
    let rows=source(opportunity?'radar':'tracks').filter(row=>{
      if(!includesQuery([row[T.title],row[T.credit_name],row[T.genre],row[T.label],row[T.copyright],row[T.editorial_placements]]))return false;
      const key=genreKey(row[T.genre]);
      if(opportunity)return filter.genre==='all'||key===filter.genre;
      if(filter.genres.size&&!filter.genres.has(key))return false;
      if(filter.period!=='all'&&ageDays(row[T.release_date])>Number(filter.period))return false;
      if(filter.rights!=='all'&&rightsKey(row[T.rights_status])!==filter.rights)return false;
      if(Number(filter.min)>0&&(number(row[T.streams])||0)<Number(filter.min))return false;
      const artist=artists.get(row[T.artist_spotify_id]);
      if(filter.relation!=='all'&&relationKey(artist&&artist[A.lofi_track_count])!==filter.relation)return false;
      return true;
    });
    const sort=state.sort[state.view];
    rows=rows.slice().sort((left,right)=>{
      if(sort==='velocity')return (right[T.delta_24h]||0)-(left[T.delta_24h]||0)||(right[T.streams]||0)-(left[T.streams]||0);
      if(sort==='release')return String(right[T.release_date]||'').localeCompare(String(left[T.release_date]||''));
      if(sort==='title')return String(left[T.title]||'').localeCompare(String(right[T.title]||''));
      if(sort==='artist')return String(left[T.credit_name]||'').localeCompare(String(right[T.credit_name]||''));
      if(sort==='genre')return genreLabel(left[T.genre]).localeCompare(genreLabel(right[T.genre]));
      if(sort==='editorial')return (right[T.playlist_count]||0)-(left[T.playlist_count]||0)||(right[T.playlist_followers_total]||0)-(left[T.playlist_followers_total]||0);
      return (right[T.streams]||0)-(left[T.streams]||0);
    });
    const total=fullReady?rows.length:(opportunity?boot.counts.opportunities:boot.counts.tracks);
    const title=opportunity?w('radarTitle'):w('allTracks');
    const description=opportunity
      ?(lang==='fr'?'Pistes instrumentales indépendantes avec un signal vérifié.':'Independent instrumental tracks with a verified signal.')
      :(lang==='fr'?'Catalogue instrumental public, trié par performances.':'Public instrumental catalogue, ranked by performance.');
    view.innerHTML=heading(title,total,description)+toolbar([
      ['streams',w('streams')],['velocity',w('velocity')],['release',w('release')],['title',w('track')],['artist',w('artist')],['genre',w('genre')],['editorial',w('editorial')],
    ],trackFilters(opportunity))+(rows.length?trackTable(rows.slice(0,state.shown),opportunity):`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(fullReady?rows.length:total);
    bindToolbar();
  }

  function renderArtists(){
    const filter=state.filters.artists;
    let rows=source('artists').filter(row=>includesQuery([row[A.name],row[A.genre]])
      &&(!filter.genres.size||filter.genres.has(genreKey(row[A.genre])))
      &&(filter.ownership==='all'||row[A.ownership_status]===filter.ownership));
    const sort=state.sort.artists;
    rows=rows.slice().sort((left,right)=>{
      if(sort==='listeners')return (right[A.monthly_listeners]||0)-(left[A.monthly_listeners]||0);
      if(sort==='velocity')return (right[A.delta_24h]||0)-(left[A.delta_24h]||0);
      if(sort==='latest')return String(right[A.latest_release]||'').localeCompare(String(left[A.latest_release]||''));
      if(sort==='name')return String(left[A.name]||'').localeCompare(String(right[A.name]||''));
      if(sort==='tracks')return (right[A.track_count]||0)-(left[A.track_count]||0);
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
      ['streams',w('streams')],['listeners',w('monthlyListeners')],['velocity',w('velocity')],['tracks',w('tracks')],['latest',w('latest')],['name',w('artist')],
    ],artistFilters())+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('artist'))}</th><th>${esc(w('genre'))}</th><th class="num">${esc(w('catalogue'))}</th><th class="num">${esc(w('velocity'))}</th><th class="num">${esc(w('monthlyListeners'))}</th><th class="num">${esc(w('tracks'))}</th><th>${esc(w('latest'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(fullReady?rows.length:total);
    bindToolbar();
  }

  function renderPlaylists(){
    const filter=state.filters.playlists;
    let rows=source('playlists').filter(row=>includesQuery([row[P.name],row[P.owner],row[P.genre],row[P.use_case]])
      &&(filter.curator==='all'||row[P.curator_category]===filter.curator)
      &&(filter.genre==='all'||row[P.genre]===filter.genre));
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
    ],playlistFilters())+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('playlists'))}</th><th>${esc(w('owner'))}</th><th class="num">${esc(w('followers'))}</th><th class="num">${esc(w('tracks'))}</th><th>${esc(w('genre'))}</th><th>Usage</th><th>${esc(w('updated'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(fullReady?rows.length:total);
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
    ])+(rows.length?`<div class="fast-table-wrap"><table class="fast-table"><thead><tr><th></th><th>${esc(w('labels'))}</th><th class="num">${esc(w('streams'))}</th><th class="num">${esc(w('tracks'))}</th><th class="num">${esc(w('artists'))}</th><th>${esc(w('since'))}</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="fast-empty">${esc(w('empty'))}</div>`)+more(fullReady?rows.length:total);
    bindToolbar();
  }

  const SELECTION_STAGES=[['to_contact','toContact'],['contacted','contacted'],['negotiating','negotiating'],['validated','validated'],['refused','refused']];
  const selectionStage=value=>{const key=String(value||'to_contact');if(key==='follow_up')return 'contacted';if(key==='closed')return 'validated';if(key==='negotiation')return 'negotiating';return SELECTION_STAGES.some(item=>item[0]===key)?key:'to_contact';};
  const selectionStageLabel=value=>w((SELECTION_STAGES.find(item=>item[0]===selectionStage(value))||SELECTION_STAGES[0])[1]);
  function renderSelection(){
    const saved=selectionGet();
    const ids=Object.keys(saved);
    if(!fullReady&&ids.some(id=>!findTrack(id)))loadFullCatalogue().then(()=>render()).catch(showCatalogueError);
    const stage=state.filters.selection.stage;
    const allRows=ids.map(id=>({id,row:findTrack(id),entry:saved[id]})).filter(item=>item.row);
    const counts=Object.fromEntries(SELECTION_STAGES.map(item=>[item[0],allRows.filter(row=>selectionStage(row.entry.status)===item[0]).length]));
    const rows=allRows.filter(item=>selectionStage(item.entry.status)===stage);
    const body=rows.map(({id,row,entry})=>`<article class="fast-selection-card">
      ${image(row[T.image_url])}
      <div><button type="button" class="fast-primary" data-open-track="${esc(id)}">${esc(row[T.title])}</button><p>${esc(row[T.credit_name])} · ${esc(genre(row[T.genre]))}</p></div>
      <div class="fast-selection-metric"><span>${esc(w('streams'))}</span><strong>${compact(row[T.streams])}</strong></div>
      <div class="fast-selection-metric"><span>${esc(w('velocity'))}</span><strong>${delta(row[T.delta_24h])}</strong></div>
      <label class="fast-selection-metric fast-selection-stage"><span>${esc(w('stage'))}</span><select data-selection-status="${esc(id)}">${SELECTION_STAGES.map(([value,key])=>`<option value="${value}" ${selectionStage(entry.status)===value?'selected':''}>${esc(w(key))}</option>`).join('')}</select></label>
      <button type="button" class="fast-remove" data-selection-remove="${esc(id)}" aria-label="${esc(w('remove'))}">×</button>
    </article>`).join('');
    const tabs=`<div class="fast-stage-tabs" role="tablist" aria-label="${esc(w('stage'))}">${SELECTION_STAGES.map(([value,key])=>`<button type="button" role="tab" data-selection-stage="${value}" aria-selected="${stage===value}" class="${stage===value?'on':''}">${esc(w(key))}<span>${fullNumber(counts[value])}</span></button>`).join('')}</div>`;
    view.innerHTML=heading(w('selectionTitle'),allRows.length,w('selectedHint'))+tabs+(rows.length?`<div class="fast-selection-list">${body}</div>`:`<div class="fast-empty"><strong>${esc(w('selectedEmpty'))}</strong><span>${esc(selectionStageLabel(stage))}</span></div>`);
  }

  function render(){
    closeSelectionContextMenu();
    const started=window.performance&&window.performance.now?window.performance.now():Date.now();
    document.documentElement.lang=lang;
    document.querySelectorAll('#nav button').forEach(button=>button.classList.toggle('active',button.dataset.v===state.view));
    if(state.view==='dashboard')renderDashboard();
    else if(state.view==='radar')renderTracks(true);
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

  function showCatalogueError(){refreshWaiting=false;refreshFocus='';view.innerHTML=`<div class="fast-empty"><strong>${esc(w('catalogueUnavailable'))}</strong><span>${esc(w('loadingCatalogue'))}</span></div>`;}
  function refreshWithFull(focusId=''){
    const finish=()=>{const target=refreshFocus;refreshWaiting=false;refreshFocus='';render();if(target){const element=document.getElementById(target);if(element){element.focus();element.setSelectionRange(element.value.length,element.value.length);}}};
    if(focusId)refreshFocus=focusId;
    if(fullReady){finish();return;}
    if(refreshWaiting)return;
    refreshWaiting=true;
    updateRuntimeState('loading');
    loadFullCatalogue().then(finish).catch(showCatalogueError);
  }
  function bindToolbar(){
    const search=document.getElementById('fast-search');
    const sort=document.getElementById('fast-sort');
    if(search){
      search.addEventListener('input',event=>{
        state.query=event.target.value;state.shown=100;
        refreshWithFull('fast-search');
      });
    }
    if(sort)sort.addEventListener('change',event=>{state.sort[state.view]=event.target.value;state.shown=100;refreshWithFull();});
    document.querySelectorAll('[data-fast-filter]').forEach(select=>select.addEventListener('change',event=>{
      const filter=state.filters[state.view];if(!filter)return;
      filter[event.target.dataset.fastFilter]=event.target.dataset.fastFilter==='min'?Number(event.target.value):event.target.value;
      state.shown=100;refreshWithFull();
    }));
    document.querySelectorAll('[data-fast-multi]').forEach(root=>{
      root.addEventListener('toggle',()=>{state.openFilter=root.open?root.dataset.fastMulti:'';});
      root.querySelectorAll('input[type="checkbox"]').forEach(input=>input.addEventListener('change',()=>{
        const selected=state.filters[state.view].genres;
        if(!input.value){if(input.checked)selected.clear();}
        else if(input.checked)selected.add(input.value);else selected.delete(input.value);
        state.openFilter=root.dataset.fastMulti;state.shown=100;refreshWithFull();
      }));
    });
    const reset=document.querySelector('[data-action="clear-filters"]');
    if(reset)reset.addEventListener('click',()=>{clearFilters(state.view);refreshWithFull();});
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
    const labels={dashboard:w('dashboard'),radar:w('opportunities'),'ar-list':w('selection'),opps:w('tracks'),artists:w('artists'),playlists:w('playlists'),labels:w('labels')};
    document.querySelectorAll('#nav button').forEach(button=>{
      const textNode=[...button.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.nodeValue.trim());
      if(textNode)textNode.nodeValue=labels[button.dataset.v]||textNode.nodeValue;
    });
    const navLabel=document.querySelector('.nav-label');if(navLabel)navLabel.textContent=lang==='fr'?'Analyse':'Analysis';
    const langButton=document.getElementById('lang-btn');
    if(langButton){langButton.classList.toggle('fr',lang==='fr');langButton.querySelectorAll('.lg-opt').forEach(option=>option.classList.toggle('on',option.dataset.l===lang));}
  }
  function updateRuntimeState(mode=''){
    const element=document.getElementById('fast-runtime-state');
    if(element)element.textContent=mode==='loading'?w('loadingCatalogue'):(fullReady?w('allData'):w('instant'));
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
        resolve(catalogue);
      };
      script.onerror=()=>reject(new Error('Compact Spotify catalogue failed to load'));
      document.head.appendChild(script);
    }).catch(error=>{console.error(error);fullPromise=null;throw error;});
    return fullPromise;
  }

  nav.addEventListener('click',event=>{
    const button=event.target.closest('button[data-v]');if(!button)return;
    state.view=button.dataset.v;state.query='';state.shown=100;render();window.scrollTo(0,0);
  });
  window.addEventListener('hashchange',()=>{
    const requested=routeToView[location.hash.slice(1)]||'dashboard';
    if(requested===state.view)return;
    state.view=requested;state.query='';state.shown=100;render();window.scrollTo(0,0);
  });
  view.addEventListener('click',event=>{
    const dashboardButton=event.target.closest('[data-dashboard-view]');
    if(dashboardButton){state.view=dashboardButton.dataset.dashboardView;state.query='';state.shown=100;render();window.scrollTo(0,0);return;}
    const stageButton=event.target.closest('[data-selection-stage]');
    if(stageButton){state.filters.selection.stage=stageButton.dataset.selectionStage;render();return;}
    const moreButton=event.target.closest('[data-action="more"]');
    if(moreButton){state.shown+=100;refreshWithFull();return;}
    const addButton=event.target.closest('[data-selection-add]');
    if(addButton){event.stopPropagation();selectionAdd(addButton.dataset.selectionAdd);return;}
    const removeButton=event.target.closest('[data-selection-remove]');
    if(removeButton){event.stopPropagation();selectionRemove(removeButton.dataset.selectionRemove);return;}
    const selectionButton=event.target.closest('[data-select-track]');
    if(selectionButton){event.stopPropagation();selectionToggle(selectionButton.dataset.selectTrack);return;}
    const trackButton=event.target.closest('[data-open-track]');
    if(trackButton){openTrack(trackButton.dataset.openTrack);return;}
  });
  view.addEventListener('contextmenu',event=>{
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;if(!target)return;
    if(target.closest('a,input,select,label,[data-selection-add],[data-selection-remove]'))return;
    const row=target.closest('tr[data-track-id]');if(!row)return;
    event.preventDefault();openSelectionContextMenu(row.dataset.trackId,event.clientX,event.clientY);
  });
  view.addEventListener('change',event=>{
    const status=event.target.closest('[data-selection-status]');if(!status)return;
    const items=selectionGet(),entry=items[status.dataset.selectionStatus];if(!entry)return;
    entry.status=status.value;items[status.dataset.selectionStatus]=entry;selectionSet(items);render();
  });
  document.getElementById('track-modal').addEventListener('click',event=>{
    if(event.target===event.currentTarget||event.target.closest('[data-close-modal]'))closeModal();
    const selectionButton=event.target.closest('[data-select-track]');
    if(selectionButton){selectionToggle(selectionButton.dataset.selectTrack);closeModal();}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeSelectionContextMenu();closeModal();}});
  document.addEventListener('scroll',closeSelectionContextMenu,true);
  window.addEventListener('storage',event=>{
    if(event.key===AR_LIST_STORAGE){selectionCache=parseStoredObject(event.newValue);updateCounts();render();}
    if(event.key===AR_ARTIST_STORAGE)selectionArtistCache=parseStoredObject(event.newValue);
  });
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
  if(window.__SPOTIFY_FILTER_TEST__)window.SPOTIFY_FILTER_TEST_API={state,render,clearFilters,matchesQuery,genreKey,rightsKey,relationKey,ageDays,number,compact,selectionGet,selectionSet,selectionHas,selectionAdd,selectionRemove,openSelectionContextMenu,closeSelectionContextMenu};
  performance.mark&&performance.mark('spotify-radar-interactive');
  window.SPOTIFY_LIGHT_RUNTIME_READY=true;
  document.documentElement.dataset.spotifyReady='true';
  document.documentElement.dataset.spotifyBootMs=(window.performance&&window.performance.now?window.performance.now():0).toFixed(1);
})();
