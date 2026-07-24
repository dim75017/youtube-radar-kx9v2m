const fs=require('fs');
const helpers=fs.readFileSync('assets/js/dashboard-02-helpers.js','utf8');
const index=fs.readFileSync('index.html','utf8');
for(const required of [
  "row(channelT,'Channels','Chaînes'",
  "'channels')",
  'function updateStatusColor(item)',
  "item.key==='channels'&&item.when",
  "return 'var(--green)';"
]) if(!helpers.includes(required)) throw new Error('YouTube channel healthy-state handling missing: '+required);
if(!index.includes('dashboard-02-helpers.js?v=20260724-youtube-analysis-title-v2')) throw new Error('YouTube status cache version is stale');
console.log('youtube channel update status: ok');
