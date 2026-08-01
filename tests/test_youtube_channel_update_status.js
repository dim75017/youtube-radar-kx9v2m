const fs=require('fs');
const assert=require('assert');
const vm=require('vm');
const helpers=fs.readFileSync('assets/js/dashboard-02-helpers.js','utf8');
const index=fs.readFileSync('index.html','utf8');
for(const required of [
  "row(channelT,'Channels','Chaînes'",
  "'channels')",
  "row(studioT,'YouTube Studio','YouTube Studio'",
  "' · Couverture partielle : '",
  "' · Partial coverage: '",
  "'ours')",
  "'Automatic monitoring'",
  'function updateStatusColor(item)',
  "item.key==='channels'&&item.when",
  "return 'var(--green)';"
]) if(!helpers.includes(required)) throw new Error('YouTube channel healthy-state handling missing: '+required);

const fresh=Date.now()-60*60*1000;
const context={
  window:{LOFI_DATA:{videoMetricsT:fresh,videoMetrics:{tracked:3273,updated:3267}}},
  DATA:{hist:null,liveHourly:null,liveHist:null},
  CHAN:{hist:null},
  LANG:'fr',
  maxHistTime:()=>null,
  fmtInt:value=>Number(value).toLocaleString('fr-FR')
};
vm.createContext(context);
const statusStart=helpers.indexOf('function scanDotColor(ms)');
const statusEnd=helpers.indexOf('function refreshUpdateStatus()',statusStart);
assert.ok(statusStart>=0&&statusEnd>statusStart,'YouTube status functions must remain testable');
vm.runInContext(helpers.slice(statusStart,statusEnd)+';this.statusLines=updateStatusLines();this.statusColor=updateStatusColor;',context);
const radar=context.statusLines.find(item=>item.key==='radar');
const ours=context.statusLines.find(item=>item.key==='ours');
assert.equal(radar.partial,true,'Radar keeps its incomplete coverage metadata');
assert.match(radar.detail,/Couverture partielle\s*:\s*3[\s\u202f]267 \/ 3[\s\u202f]273/,'Radar exposes its exact partial coverage');
assert.equal(context.statusColor(radar),'var(--green)','A fresh accepted Radar scan stays green despite partial coverage');
assert.equal(ours.partial,false,'Our videos never inherits global Radar coverage');
assert.doesNotMatch(ours.detail,/Couverture partielle|3[\s\u202f]267 \/ 3[\s\u202f]273/,'Our videos does not display Radar coverage');
assert.equal(context.statusColor(ours),'var(--green)','A fresh Our videos scan is green');
assert.equal(context.statusColor({key:'radar',when:Date.now()-30*60*60*1000,partial:true}),'var(--amber)','A scan older than 26 hours remains amber');
assert.equal(context.statusColor({key:'radar',when:null,partial:false}),'var(--dim)','A missing scan timestamp remains neutral');
if(!index.includes('dashboard-02-helpers.js?v=20260801-youtube-history-paris-v1')) throw new Error('YouTube status cache version is stale');
if(!index.includes("Lofi_Radar_studio.js?payload='+Date.now()")) throw new Error('YouTube Studio snapshot must bypass the browser cache');
console.log('youtube channel update status: ok');

