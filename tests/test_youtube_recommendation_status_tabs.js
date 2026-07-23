const fs=require('fs');
const root=process.cwd();
const recos=fs.readFileSync(root+'/assets/js/dashboard-04-recommendations.js','utf8');
const css=fs.readFileSync(root+'/assets/css/dashboard.css','utf8');
const index=fs.readFileSync(root+'/index.html','utf8');
for(const required of [
  "let RECO_TAB='pending';",
  'function validatedRecommendationRows()',
  'function setRecoTab(tab)',
  "['pending','validated','archive']",
  "['pending','🟡 '+",
  "['validated','✓ '+",
  "['archive','🗄️ '+"
]) if(!recos.includes(required))throw new Error('Missing recommendation status-tab behavior: '+required);
for(const required of ['.reco-tabbar','.reco-tab.pending','.reco-tab.validated','.reco-tab.archive'])
  if(!css.includes(required))throw new Error('Missing status-tab style: '+required);
if(!index.includes('dashboard-04-recommendations.js?v=20260723-reco-status-tabs-v1'))
  throw new Error('Recommendation script cache version is stale');
console.log('youtube recommendation status tabs: ok');
