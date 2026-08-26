'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'spotify', 'instant.js'), 'utf8');
const schemas = {
  tracks: ['spotify_id','title','credit_name','release_date','streams','delta_24h','rights_status','label','copyright','genre','image_url','playlist_count','playlist_best_position','playlist_followers_total','opportunity_eligible','artist_spotify_id','updated_at','preview_hash','performance_bucket','performance_available','editorial_placements','instrumental_status','instrumental_confidence','ai_risk','ai_risk_score','genre_confidence','subgenres'],
  artists: ['spotify_id','name','monthly_listeners','genre','image_url','track_count','catalogue_streams','delta_24h','latest_release','ownership_status','lofi_track_count'],
  playlists: ['spotify_id','name','owner','curator_category','followers','tracks','first_seen','last_seen','genre','use_case','fit','image_url','growth_24h','growth_7d','growth_30d','growth_days'],
  labels: ['key','name','tracks','streams','since','artist_count','logo','email'],
};
const track = (id,title,artist,date,streams,rights,genre,artistId,eligible,placements=[]) => [
  id,title,artist,date,streams,100,rights,rights==='self_released'?'':`${artist} Records`,`${artist} copyright`,genre,'',
  placements.length,1,placements.reduce((sum,item)=>sum+item[3],0),eligible,artistId,'2026-08-25','',0,false,placements,
  'instrumental',1,'low',0,.9,[],
];
const tracks = [
  track('t1','Été calme','Alpha','2026-08-15',2_000_000,'self_released','ambient','a1',true,[['p1','Deep Focus',4,20_000,'2026-08-01','2026-08-25']]),
  track('t2','Winter Jazz','Beta','2025-01-01',600_000,'independent_label','jazz_jazzhop','a2',true),
  track('t3','Unknown Piano','Gamma','2026-08-20',50_000,'unknown','piano','a3',false),
];
const artists = [
  ['a1','Alpha',100_000,'ambient','',1,2_000_000,100,'2026-08-15','indie',60],
  ['a2','Beta',50_000,'jazz_jazzhop','',1,600_000,100,'2025-01-01','label',30],
  ['a3','Gamma',10_000,'piano','',1,50_000,100,'2026-08-20','label',0],
];
const playlists = [
  ['p1','Ambient Focus','Spotify','editorial',20_000,40,'2026-01-01','2026-08-25','Ambient','Focus',90,'',20,120,500,30],
  ['p2','Jazz Study','Curator','independent',50_000,70,'2026-01-01','2026-08-25','Jazz / bossa','Study',80,'',-5,-30,-90,30],
];
const payload = {
  version: 3,
  generated_at: '2026-08-25',
  source_hash: 'filter-fixture',
  counts: {tracks:3,artists:3,playlists:2,labels:0,opportunities:2},
  schemas,
  facets: {
    track_genres: [['ambient',1],['jazz_jazzhop',1],['piano',1]],
    track_rights: [['self_released',1],['independent_label',1],['unknown',1]],
    artist_genres: [['ambient',1],['jazz_jazzhop',1],['piano',1]],
    artist_ownership: [['indie',1],['label',2]],
    playlist_genres: [['Ambient',1],['Jazz / bossa',1]],
    playlist_curators: [['editorial',1],['independent',1]],
  },
  analytics: {}, tracks, radar: tracks.filter(row=>row[14]), artists, playlists, labels: [],
};

const elements = new Map();
const viewListeners = {};
const element = extra => Object.assign({
  innerHTML: '', textContent: '', style: {}, dataset: {},
  addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  classList: {toggle() {},add() {},remove() {}},
}, extra);
const view = element({addEventListener(type,handler) { viewListeners[type]=handler; }});
elements.set('view', view);
elements.set('nav', element());
elements.set('track-modal', element({style:{display:'none'}}));
elements.set('tmbox', element());
elements.set('lang-btn', element());
for (const id of ['c-radar','c-opps','c-art','c-pl','c-lb','c-ar-list']) elements.set(id, element());
const storage = {};
let storageBlocked = false;
let appendedMenu = null;
let menuAction = null;
const performance = {now:()=>0,mark() {}};
const windowObject = {
  SPOTIFY_INSTANT: payload,
  __SPOTIFY_FILTER_TEST__: true,
  performance,
  innerWidth: 1280, innerHeight: 720,
  addEventListener() {}, scrollTo() {}, setTimeout(callback) { callback(); },
};
const context = {
  window: windowObject,
  document: {
    documentElement: {lang:'fr',dataset:{}},
    body: {appendChild(menu) { appendedMenu=menu;menu.connected=true; }},
    createElement() {
      menuAction=element({listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});
      const menu=element({
        connected:false,offsetWidth:230,offsetHeight:44,
        setAttribute() {},remove(){this.connected=false;},
        querySelector(selector){return selector==='[data-selection-context-add]'?menuAction:null;},
      });
      Object.defineProperty(menu,'isConnected',{get(){return this.connected;}});
      return menu;
    },
    getElementById: id=>elements.get(id)||null,
    querySelectorAll: ()=>[], querySelector: ()=>null,
    addEventListener() {},
  },
  localStorage: {getItem:key=>storage[key]||null,setItem:(key,value)=>{if(storageBlocked)throw new Error('storage blocked');storage[key]=String(value);}},
  location: {hash:'#opportunities',pathname:'/spotify/',search:''},
  history: {replaceState() {}},
  performance,
  Node: {TEXT_NODE:3},
  Intl, Date, Set, Map, Promise, console,
};
vm.createContext(context);
vm.runInContext(source, context, {filename:'spotify/instant.js',timeout:5_000});
const api = windowObject.SPOTIFY_FILTER_TEST_API;
assert.ok(api, 'the filter test API must be exposed only for the isolated runtime fixture');

const renderView = name => { api.state.view=name;api.render();return view.innerHTML; };
const dashboard = renderView('dashboard');
assert.match(dashboard,/Tableau de bord/);
assert.match(dashboard,/fast-dashboard-kpis/);
assert.match(dashboard,/Opportunités/);
assert.match(dashboard,/Signaux les plus rapides/);
assert.match(dashboard,/Pipeline A&amp;R/);
assert.match(dashboard,/Genres classifiés/);
assert.match(dashboard,/Indépendance/);
assert.match(dashboard,/Veille playlists/);
assert.match(dashboard,/data-dashboard-view="radar"/);
assert.match(dashboard,/data-dashboard-view="opps"/);
assert.match(dashboard,/data-dashboard-view="artists"/);
assert.match(dashboard,/data-dashboard-view="playlists"/);
assert.doesNotMatch(dashboard,/NaN|undefined/,'dashboard metrics must never expose fabricated or missing JavaScript values');
assert.equal(api.state.view,'dashboard');
const dashboardTarget={dataset:{dashboardView:'playlists'},closest(selector){return selector==='[data-dashboard-view]'?this:null;}};
viewListeners.click({target:dashboardTarget});
assert.equal(api.state.view,'playlists','dashboard shortcuts must open the related Spotify tab');

api.state.view = 'opps';
api.state.query = 'ete alpha';
assert.match(renderView('opps'), /Été calme/);
assert.doesNotMatch(view.innerHTML, /Winter Jazz/);
api.state.query = '';
api.state.filters.opps.genres.add('ambient');
assert.match(renderView('opps'), /Été calme/);
assert.doesNotMatch(view.innerHTML, /Winter Jazz/);
api.state.filters.opps.genres.clear();
api.state.filters.opps.period = '30';
assert.match(renderView('opps'), /Été calme/);
assert.match(view.innerHTML, /Unknown Piano/);
assert.doesNotMatch(view.innerHTML, /Winter Jazz/);
api.state.filters.opps.period = 'all';
api.state.filters.opps.rights = 'self';
assert.match(renderView('opps'), /Été calme/);
assert.doesNotMatch(view.innerHTML, /Winter Jazz|Unknown Piano/);
api.state.filters.opps.rights = 'all';
api.state.filters.opps.min = 1_000_000;
assert.match(renderView('opps'), /Été calme/);
assert.doesNotMatch(view.innerHTML, /Winter Jazz|Unknown Piano/);
api.state.filters.opps.min = 0;
api.state.filters.opps.relation = 'reg';
assert.match(renderView('opps'), /Winter Jazz/);
assert.doesNotMatch(view.innerHTML, /Été calme|Unknown Piano/);
api.clearFilters('opps');
assert.match(renderView('opps'), /Été calme/);
assert.match(view.innerHTML, /Winter Jazz/);
assert.match(view.innerHTML, /Unknown Piano/);

api.state.query = '';
api.state.filters.artists.genres.add('ambient');
assert.match(renderView('artists'), /Alpha/);
assert.doesNotMatch(view.innerHTML, /Beta|Gamma/);
api.state.filters.artists.genres.clear();
api.state.filters.artists.ownership = 'label';
assert.doesNotMatch(renderView('artists'), /Alpha/);
assert.match(view.innerHTML, /Beta/);
assert.match(view.innerHTML, /Gamma/);

api.state.filters.playlists.curator = 'editorial';
assert.match(renderView('playlists'), /Ambient Focus/);
assert.match(view.innerHTML, />24 h<\/th>/, 'playlist table must restore its 24-hour analytics column');
assert.match(view.innerHTML, />7 j<\/th>/, 'playlist table must restore its 7-day analytics column');
assert.match(view.innerHTML, />30 j<\/th>/, 'playlist table must restore its 30-day analytics column');
assert.match(view.innerHTML, />Fit<\/th>/, 'playlist table must restore its fit-score column');
assert.doesNotMatch(view.innerHTML, /Jazz Study/);
api.state.filters.playlists.curator = 'all';
api.state.filters.playlists.genre = 'Jazz / bossa';
assert.match(renderView('playlists'), /Jazz Study/);
assert.doesNotMatch(view.innerHTML, /Ambient Focus/);

api.state.filters.radar.genre = 'jazz_jazzhop';
assert.match(renderView('radar'), /Winter Jazz/);
assert.doesNotMatch(view.innerHTML, /Été calme/);

api.selectionSet({
  t1:{status:'contacted'},t2:{status:'follow_up'},t3:{status:'refused'},
});
api.state.filters.selection.stage = 'contacted';
assert.match(renderView('ar-list'), /Été calme/);
assert.match(view.innerHTML, /Winter Jazz/);
assert.doesNotMatch(view.innerHTML, /Unknown Piano/);
api.state.filters.selection.stage = 'refused';
assert.match(renderView('ar-list'), /Unknown Piano/);
assert.doesNotMatch(view.innerHTML, /Été calme|Winter Jazz/);

api.selectionSet({});
api.state.view='radar';
const plusTarget={dataset:{selectionAdd:'t1'},closest(selector){return selector==='[data-selection-add]'?this:null;}};
viewListeners.click({target:plusTarget,stopPropagation(){}});
assert.equal(api.selectionHas('t1'),true,'the visible + button must add the track');
assert.equal(api.selectionGet().t1.status,'to_contact');
assert.ok(api.selectionGet().t1.addedAt,'the instant runtime must retain the legacy addedAt field');
assert.equal(api.selectionGet().t1.note,'');
assert.ok(JSON.parse(storage.spotify_ar_outreach_artists_v1)['spotify:a1'],'adding a track must keep the legacy artist selection ledger compatible');
viewListeners.click({target:plusTarget,stopPropagation(){}});
assert.equal(api.selectionHas('t1'),true,'clicking the + action twice must be idempotent, never remove the track');

const removeTarget={dataset:{selectionRemove:'t1'},closest(selector){return selector==='[data-selection-remove]'?this:null;}};
viewListeners.click({target:removeTarget,stopPropagation(){}});
assert.equal(api.selectionHas('t1'),false,'only the explicit remove action may delete a selected track');

storageBlocked=true;
const blockedTarget={dataset:{selectionAdd:'t2'},closest(selector){return selector==='[data-selection-add]'?this:null;}};
viewListeners.click({target:blockedTarget,stopPropagation(){}});
assert.equal(api.selectionHas('t2'),true,'the + button must still work in memory when browser storage is unavailable');
assert.equal(context.document.documentElement.dataset.spotifySelectionStorage,'memory');
storageBlocked=false;

api.selectionSet({});
let contextPrevented=false;
const contextRow={dataset:{trackId:'t3'}};
const contextTarget={closest(selector){
  if(selector==='tr[data-track-id]')return contextRow;
  return null;
}};
viewListeners.contextmenu({target:contextTarget,clientX:300,clientY:220,preventDefault(){contextPrevented=true;}});
assert.equal(contextPrevented,true,'right-clicking a track row must replace the native menu');
assert.ok(appendedMenu&&appendedMenu.isConnected,'right-clicking a track must open the custom selection menu');
assert.equal(typeof menuAction.listeners.click,'function','the context menu must expose an add action');
menuAction.listeners.click({stopPropagation(){}});
assert.equal(api.selectionHas('t3'),true,'the context-menu action must add the track to Selection');

assert.equal(api.rightsKey('major'), 'label');
assert.equal(api.rightsKey('unknown'), 'unknown');
assert.equal(api.relationKey(51), 'top');
assert.equal(api.relationKey(25), 'reg');
assert.equal(api.relationKey(1), 'occ');
assert.equal(api.relationKey(0), 'ext');
assert.equal(api.ageDays('2026-08-15'), 10);
assert.equal(api.matchesQuery('ete deep', ['Été calme','Deep Focus']), true);
assert.equal(api.number(null), null, 'missing metrics must stay missing');
assert.equal(api.number(''), null, 'empty metrics must stay missing');
assert.equal(api.compact(null), '—', 'missing metrics must render as an em dash, never as a fabricated zero');
assert.doesNotMatch(source, /if\(state\.query\|\|state\.shown>100\)render\(\)/, 'catalogue hydration must not trigger a second render behind its caller');

const evaluate = (file, globalName) => {
  const sandbox = {window:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox,{filename:file,timeout:30_000});
  return sandbox.window[globalName];
};
const instant = evaluate('Spotify_Instant_data.js','SPOTIFY_INSTANT');
const catalogue = evaluate('Spotify_Catalogue_data.js','SPOTIFY_CATALOGUE');
const relations = evaluate('Spotify_Lofi_Relations_data.js','SPOTIFY_LOFI_RELATIONS');
assert.equal(relations.version,1);
assert.ok(Object.keys(relations.artists).length>=400,'the compact relation index must cover the known Lofi artist ledger');
assert.ok(instant.tracks.length<=100&&instant.radar.length<=100,'the filter facets must not enlarge the first-paint row snapshot');
assert.ok(catalogue.schemas.artists.includes('ownership_status'));
assert.ok(catalogue.schemas.artists.includes('lofi_track_count'));
const facetCases = [
  ['track_genres','tracks','genre'],['track_rights','tracks','rights_status'],
  ['artist_genres','artists','genre'],['artist_ownership','artists','ownership_status'],
  ['playlist_genres','playlists','genre'],['playlist_curators','playlists','curator_category'],
];
for (const [facetName,collection,field] of facetCases) {
  const index=catalogue.schemas[collection].indexOf(field),counts=new Map();
  for(const row of catalogue[collection]){const value=String(row[index]||'').trim();if(value)counts.set(value,(counts.get(value)||0)+1);}
  const expected=[...counts].sort((a,b)=>a[0].localeCompare(b[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(catalogue.facets[facetName])),expected,`${facetName} must describe the complete catalogue exactly`);
  assert.deepEqual(JSON.parse(JSON.stringify(instant.facets[facetName])),expected,`${facetName} must be complete on first paint`);
}
const artistIndex=Object.fromEntries(catalogue.schemas.artists.map((field,index)=>[field,index]));
const trackIndex=Object.fromEntries(catalogue.schemas.tracks.map((field,index)=>[field,index]));
const tracksByArtist=new Map();
for(const row of catalogue.tracks){const id=row[trackIndex.artist_spotify_id];if(!tracksByArtist.has(id))tracksByArtist.set(id,[]);tracksByArtist.get(id).push(row);}
for(const artist of catalogue.artists){
  assert.ok(['indie','label'].includes(artist[artistIndex.ownership_status]));
  assert.ok(Number(artist[artistIndex.lofi_track_count])>=0);
  assert.equal(Number(artist[artistIndex.lofi_track_count]),Number(relations.artists[artist[artistIndex.spotify_id]]||0),'catalogue relation counts must come from the compact relation index');
  if(artist[artistIndex.ownership_status]==='indie')assert.ok((tracksByArtist.get(artist[artistIndex.spotify_id])||[]).every(row=>row[trackIndex.rights_status]==='self_released'),'an Indie artist must be entirely self-released');
}
const playlistIndex=Object.fromEntries(catalogue.schemas.playlists.map((field,index)=>[field,index]));
assert.ok(catalogue.playlists.some(row=>row[playlistIndex.growth_30d]===null),'missing playlist growth must remain null instead of becoming a fabricated zero');

const instantCss = fs.readFileSync(path.join(root,'spotify','instant.css'),'utf8');
assert.match(
  instantCss,
  /\.fast-toolbar\{[^}]*display:grid;[^}]*grid-template-columns:minmax\(210px,280px\) minmax\(0,1fr\) auto auto/,
  'the desktop toolbar must reserve columns for search, filters, runtime state, and right-aligned sorting',
);
assert.match(instantCss,/\.fast-search\{[^}]*grid-column:1;grid-row:1/,'search must stay first and leftmost');
assert.match(instantCss,/\.fast-filters\{[^}]*grid-column:2;grid-row:1/,'desktop filters must share the search row');
assert.match(instantCss,/\.fast-runtime-state\{[^}]*grid-column:3;grid-row:1/,'runtime state must stay between filters and sorting');
assert.match(instantCss,/\.fast-sort\{[^}]*grid-column:4;grid-row:1;justify-self:end/,'sorting must stay at the far right');
assert.doesNotMatch(instantCss,/\.fast-filters\{[^}]*order:4/,'filters must not be forced onto a second desktop row');
assert.doesNotMatch(instantCss,/\.fast-filters\{[^}]*flex:1 0 100%/,'filters must not reserve a full toolbar row on desktop');

console.log('Spotify instant catalogue filters: OK');
