'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
function evaluate(relative,globalName){
  const context={window:{}};
  vm.createContext(context);
  vm.runInContext(read(relative),context,{filename:relative,timeout:60_000});
  return context.window[globalName];
}

const index=read('spotify/index.html');
const instant=read('spotify/instant.js');
const instantBuilder=read('build_spotify_instant_runtime.js');
const soundchartsWorkflow=read('.github/workflows/refresh-soundcharts.yml');
const browseWorkflow=read('.github/workflows/refresh-spotify-browse-catalogue.yml');
const pagesWorkflow=read('.github/workflows/deploy-pages.yml');
const runtimePath=path.join(root,'spotify','label-analytics.js');
const stylePath=path.join(root,'spotify','label-analytics.css');
const payloadPath=path.join(root,'Spotify_Label_Analytics_data.js');

assert.ok(fs.existsSync(runtimePath),'the lightweight Radar must ship a dedicated label analytics renderer');
assert.ok(fs.existsSync(stylePath),'label analytics must use a dedicated lazy visual layer');
assert.ok(fs.existsSync(payloadPath),'the exact label analytics payload must be generated');
assert.doesNotMatch(index,/label-analytics\.(?:js|css)|Spotify_Label_Analytics_data\.js/,
  'label analytics assets must stay off the first paint and load only after a click');
assert.match(instant,/function loadLabelAnalytics\(\)\{return loadAnalytics\('Label'\);\}/,
  'the shared lazy loader must support label analytics');
assert.match(instant,/function openLabel\(key\)/,'visible labels must open inside the Radar');
assert.match(instant,/data-open-label=/,'label rows and names must expose an internal open action');
assert.match(instant,/tr\[data-open-label\]/,'label rows must be keyboard accessible');
assert.match(instant,/SpotifyLabelAnalytics\.close/,'closing the shared modal must clean up label listeners');
assert.match(instant,/onOpenTrack:openTrack/,'label track rows must keep navigation inside the Radar');
assert.match(instantBuilder,/require\('\.\/build_spotify_label_analytics\.js'\)\.buildFile/,
  'the canonical lightweight build must always regenerate label analytics');
assert.ok((soundchartsWorkflow.match(/node build_spotify_instant_runtime\.js/g)||[]).length>=2,
  'every Soundcharts activation path must run the canonical build that owns label analytics');
assert.match(browseWorkflow,/node build_spotify_instant_runtime\.js/,
  'the daily active-catalogue projection must run the canonical label build');
assert.match(pagesWorkflow,/node build_spotify_instant_runtime\.js/,
  'Pages must regenerate label analytics from the exact revision it publishes');
assert.ok(pagesWorkflow.indexOf('node build_spotify_instant_runtime.js')<pagesWorkflow.indexOf('actions/jekyll-build-pages@v1'),
  'the lazy label payload must exist before Jekyll assembles the public site');

const catalogue=evaluate('Spotify_Catalogue_data.js','SPOTIFY_CATALOGUE');
const payload=evaluate('Spotify_Label_Analytics_data.js','SPOTIFY_LABEL_ANALYTICS');
assert.equal(payload.version,1);
assert.ok(payload.status.active_groups>=100,'the label analytics payload cannot be a tiny partial projection');
assert.equal(catalogue.labels.length,payload.status.active_groups,
  'the visible label catalogue and analytics groups must use the same active-track projection');
assert.equal(payload.status.active_tracks,catalogue.tracks.length,
  'every active catalogue track must contribute to exactly one label group');
for(const row of catalogue.labels){
  const key=row[catalogue.schemas.labels.indexOf('key')];
  const groupKey=payload.groups[key]?key:payload.aliases[key];
  assert.ok(groupKey&&payload.groups[groupKey],`visible label is missing analytics: ${key}`);
  assert.ok(payload.groups[groupKey][payload.group_schema.indexOf('tracks')]>0,
    `visible label analytics has no active tracks: ${key}`);
}
assert.ok(fs.statSync(payloadPath).size<15_000_000,'the lazy label payload must remain reasonably bounded');

const builder=require('../build_spotify_label_analytics.js');
assert.equal(builder.labelKeyOf('Columbia Records, a Division of Sony Music Entertainment'),'columbia records');
assert.equal(builder.labelKeyOf('℗ 2026 Smile For Me.'),'smile for me');
const missingWindow=builder.counterWindow([['2026-08-01',100],['2026-08-03',140]],1);
assert.equal(missingWindow.current,null,'a missing exact baseline must never become a fabricated zero');
assert.deepEqual(builder.dailyFlow([['2026-08-01',100],['2026-08-03',140]]),[],
  'daily flow must preserve reporting gaps instead of interpolating them');

const trackSchema=['spotify_id','credit_name','release_date','streams','label','copyright'];
const fixtureCatalogue={schemas:{tracks:trackSchema},tracks:[
  ['aaaaaaaaaaaaaaaaaaaaaa','Artist A','2026-01-01',715,'Columbia Records',''],
  ['bbbbbbbbbbbbbbbbbbbbbb','Artist B','2026-02-01',500,'Columbia Records',''],
]};
const fixtureLabels={cols:['key','name'],rows:[
  ['Columbia Records, a Division of Sony Music Entertainment','Columbia Records, a Division of Sony Music Entertainment'],
]};
const fixturePerformance={generated_at:'2026-07-31T08:00:00Z',tracks:{
  aaaaaaaaaaaaaaaaaaaaaa:{history:[['2026-06-01',100],['2026-07-01',400],['2026-07-29',690],['2026-07-30',700],['2026-07-31',715]]},
  bbbbbbbbbbbbbbbbbbbbbb:{history:[['2026-07-17',425],['2026-07-24',450],['2026-07-31',500]]},
}};
const fixture=builder.buildPayload(fixtureCatalogue,fixtureLabels,fixturePerformance);
assert.equal(fixture.aliases['Columbia Records, a Division of Sony Music Entertainment'],'columbia records',
  'historical division suffixes must resolve to the active label group');
const group=fixture.groups['columbia records'];
const gi=Object.fromEntries(fixture.group_schema.map((field,index)=>[field,index]));
const wi=Object.fromEntries(fixture.window_schema.map((field,index)=>[field,index]));
assert.equal(group[gi.window_1d][wi.current],15);
assert.equal(group[gi.window_1d][wi.current_count],1,
  'aggregate coverage must disclose that only one exact daily baseline exists');
assert.equal(group[gi.window_7d][wi.current],50);
assert.equal(group[gi.window_30d][wi.current],315);
assert.deepEqual(Array.from(group[gi.daily],point=>Array.from(point)),[
  ['2026-07-30',10,1],['2026-07-31',15,1],
], 'only consecutive observed days may enter the label chart');

const moduleApi=require('../spotify/label-analytics.js');
assert.equal(moduleApi.__test.labelKeyOf('Columbia Records, a Division of Sony Music Entertainment'),'columbia records');
assert.deepEqual(moduleApi.__test.recentDaily([
  ['2026-07-01',1,1],['2026-07-31',2,1],
],30),[['2026-07-31',2,1]]);

console.log(`Spotify label analytics contract OK (${catalogue.labels.length} clickable active labels, data through ${payload.data_through||'n/a'}).`);

