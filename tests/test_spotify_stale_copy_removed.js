const fs=require('fs');
const root=process.cwd();
const dashboard=fs.readFileSync(root+'/spotify/dashboard.js','utf8');
const coverage=fs.readFileSync(root+'/spotify/coverage.js','utf8');
const index=fs.readFileSync(root+'/spotify/index.html','utf8');
for(const forbidden of ['Scan incomplet, pause sécurité Spotify','Scan incomplete, Spotify safety pause'])
  if(dashboard.includes(forbidden))throw new Error('Obsolete safety-pause copy still present: '+forbidden);
if(!coverage.includes('function removeCategorySummaries()'))throw new Error('Category summary cleanup missing');
if(coverage.includes("ensureSummary('tracks', text.tracks())"))throw new Error('Track category description is still injected');
if(coverage.includes("ensureSummary('artists', text.artists())"))throw new Error('Artist category description is still injected');
if(!index.includes('dashboard.js?v=20260724-opportunity-search-v1'))throw new Error('Dashboard cache version is stale');
if(!index.includes('coverage.js?v=20260723-stale-copy-cleanup-v1'))throw new Error('Coverage cache version is stale');
console.log('spotify stale category copy cleanup: ok');
