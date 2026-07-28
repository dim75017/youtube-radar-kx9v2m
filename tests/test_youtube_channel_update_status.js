const fs=require('fs');
const helpers=fs.readFileSync('assets/js/dashboard-02-helpers.js','utf8');
const index=fs.readFileSync('index.html','utf8');
for(const required of [
  "row(channelT,'Channels','Chaînes'",
  "'channels')",
  "row(studioT,'YouTube Studio','YouTube Studio'",
  "item&&item.partial",
  "'Automatic monitoring'",
  'function updateStatusColor(item)',
  "item.key==='channels'&&item.when",
  "return 'var(--green)';"
]) if(!helpers.includes(required)) throw new Error('YouTube channel healthy-state handling missing: '+required);
if(!index.includes('dashboard-02-helpers.js?v=20260728-recommendations-learning-v2')) throw new Error('YouTube status cache version is stale');
console.log('youtube channel update status: ok');
