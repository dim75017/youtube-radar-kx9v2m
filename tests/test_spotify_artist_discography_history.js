const fs=require('fs');
const root=process.cwd();
const dashboard=fs.readFileSync(root+'/spotify/dashboard.js','utf8');
const css=fs.readFileSync(root+'/spotify/dashboard.css','utf8');
const index=fs.readFileSync(root+'/spotify/index.html','utf8');

for(const required of [
  'function artistDiscographyRows(i)',
  'function artistAcquisitionRows(i)',
  'const rows = artistDiscographyRows(i);',
  'const acquisitionRows = artistAcquisitionRows(i);',
  'function recentDailyPoints(points,days)',
  'function artistFlowWindowControls()',
  '[7,30,90,180,360]',
  "setArtistFlowWindow('all')",
  'function showNearestSparkPoint(svg,event)',
  'function hideNearestSparkPoint(svg)',
  'class="spark-hover-point"',
  'data-value="${esc(sparklineValueLabel(p[1],unit))}"'
]) if(!dashboard.includes(required)) throw new Error('Missing artist discography/history behaviour: '+required);

const artistModal=dashboard.slice(dashboard.indexOf('function renderArtistModal(){'),dashboard.indexOf('\nfunction openTrack',dashboard.indexOf('function renderArtistModal(){')));
const trackModal=dashboard.slice(dashboard.indexOf('function openTrack(tid){'),dashboard.indexOf('\nfunction closeTrack',dashboard.indexOf('function openTrack(tid){')));
if(artistModal.includes('classificationAnalyticsHtml')||trackModal.includes('classificationAnalyticsHtml'))
  throw new Error('Track and artist profiles must not render classification blocks');
if(artistModal.includes('Tracks les plus contributrices')||artistModal.includes('contributorsHtml(allRows,7)'))
  throw new Error('Artist profile must not render a top-contributors panel');
const perfCard=dashboard.slice(dashboard.indexOf('function perfCardHtml('),dashboard.indexOf('\nfunction totalMetricCardHtml',dashboard.indexOf('function perfCardHtml(')));
if(perfCard.includes("T('vs période précédente')")||perfCard.includes("T('Données partielles')"))
  throw new Error('Performance cards must show only a compact percentage delta');

if(dashboard.includes('function artistRows(i){ return R.filter(r=>r[0]===i && r[4]===0)'))
  throw new Error('Artist modal still limits the discography to primary self-release rows');
for(const required of ['.spark-tooltip','.analytics-window','.ck:disabled'])
  if(!css.includes(required)) throw new Error('Missing chart or acquisition control styling: '+required);
if(!index.includes('dashboard.js?v=20260724-playlist-cover-source-v1'))
  throw new Error('Dashboard cache version is stale');

console.log('spotify artist full discography and history controls: ok');
