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
  '[3,7,90]',
  'function showSparkTooltip(dot,event)',
  'data-value="${esc(sparklineValueLabel(p[1],unit))}"'
]) if(!dashboard.includes(required)) throw new Error('Missing artist discography/history behaviour: '+required);

if(dashboard.includes('function artistRows(i){ return R.filter(r=>r[0]===i && r[4]===0)'))
  throw new Error('Artist modal still limits the discography to primary self-release rows');
for(const required of ['.spark-tooltip','.analytics-window','.ck:disabled'])
  if(!css.includes(required)) throw new Error('Missing chart or acquisition control styling: '+required);
if(!index.includes('dashboard.js?v=20260724-opportunity-layout-v1'))
  throw new Error('Dashboard cache version is stale');

console.log('spotify artist full discography and history controls: ok');
