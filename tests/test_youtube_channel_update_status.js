const fs=require('fs');
const assert=require('assert');
const vm=require('vm');
const helpers=fs.readFileSync('assets/js/dashboard-02-helpers.js','utf8');
const recommendations=fs.readFileSync('assets/js/dashboard-04-recommendations.js','utf8');
const index=fs.readFileSync('index.html','utf8');
for(const required of [
  "row(channelT,'Channels','Chaînes'",
  "'channels')",
  'function studioReportingMeta()',
  "row(studio.when,'YouTube Studio','YouTube Studio'",
  "youtube-reporting-api",
  'STUDIO_REPORTING_GREEN_MS=3*86400000',
  'STUDIO_REPORTING_AMBER_MS=5*86400000',
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
  fmtInt:value=>Number(value).toLocaleString('fr-FR'),
  fmtDateFull:value=>new Date(value).toISOString().slice(0,10),
  fmtDateTimeShort:value=>new Date(value).toISOString()
};
vm.createContext(context);
const statusStart=helpers.indexOf('function scanDotColor(ms)');
const statusEnd=helpers.indexOf('function refreshUpdateStatus()',statusStart);
assert.ok(statusStart>=0&&statusEnd>statusStart,'YouTube status functions must remain testable');
vm.runInContext(helpers.slice(statusStart,statusEnd)+';this.buildStatusLines=updateStatusLines;this.statusLines=updateStatusLines();this.statusColor=updateStatusColor;this.readStudioMeta=studioReportingMeta;',context);
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

const DAY=86400000;
const isoDayAgo=days=>new Date(Date.now()-days*DAY).toISOString().slice(0,10);
const fakeFreshLegacyT=Date.now()-30*60*1000;
context.window.STUDIO_DATA={
  t:fakeFreshLegacyT,
  label:'365 days · as of old export',
  dataThrough:isoDayAgo(7),
  scanAt:new Date(Date.now()-6*DAY).toISOString(),
  coverage:{sourceFile:'Informations relatives aux tableaux.csv'}
};
const manualStudio=context.buildStatusLines().find(item=>item.key==='studio');
assert.equal(manualStudio.when,manualStudio.dataThroughT,'Studio reporting freshness is driven by dataThrough before the import timestamp');
assert.notEqual(manualStudio.when,fakeFreshLegacyT,'A fresh legacy t value cannot make stale Studio reporting look fresh');
assert.match(manualStudio.detail,/Export manuel YouTube Studio/,'Legacy CSV snapshots are identified honestly as manual exports');
assert.match(manualStudio.detail,/fenêtre glissante de 365 jours/,'The reporting window is derived from the legacy snapshot label');
assert.equal(manualStudio.connected,false,'A manual export is never presented as a live API connection');
assert.equal(context.statusColor(manualStudio),'var(--red)','Studio reporting older than five days is red');

context.window.STUDIO_DATA={
  t:Date.now()-20*DAY,
  dataThrough:isoDayAgo(2),
  windowDays:28,
  windowStart:isoDayAgo(29),
  windowEnd:isoDayAgo(2),
  sync:{
    source:'youtube-reporting-api',connected:true,status:'healthy',
    lastAttemptAt:new Date(Date.now()-45*60*1000).toISOString(),
    lastSuccessAt:new Date(Date.now()-60*60*1000).toISOString()
  }
};
const apiStudio=context.buildStatusLines().find(item=>item.key==='studio');
assert.match(apiStudio.detail,/API YouTube Analytics en lecture seule/,'Reporting API snapshots are identified as API data');
assert.match(apiStudio.detail,/fenêtre glissante de 28 jours/,'The API windowDays value controls the displayed reporting window');
assert.match(apiStudio.timeText,/^Données au /,'The Studio status timestamp is labelled as the data-through date');
assert.equal(context.statusColor(apiStudio),'var(--green)','Studio reporting no older than three days is green');
assert.equal(context.statusColor({key:'studio',when:Date.now()-4*DAY,connected:true}),'var(--amber)','Studio reporting between three and five days is amber');
assert.equal(context.statusColor({key:'studio',when:Date.now()-5.1*DAY,connected:true}),'var(--red)','Studio reporting older than five days is red');
assert.equal(context.statusColor({key:'studio',when:Date.now()-DAY,connected:false}),'var(--red)','A disconnected Reporting API is red even with recent data');

const syncFallbackT=Date.now()-2*60*60*1000;
context.window.STUDIO_DATA={
  t:Date.now(),windowDays:28,
  sync:{source:'youtube-reporting-api',connected:true,status:'waiting_reports',lastSuccessAt:new Date(syncFallbackT).toISOString()}
};
const syncFallback=context.buildStatusLines().find(item=>item.key==='studio');
assert.ok(Math.abs(syncFallback.when-syncFallbackT)<1000,'Studio falls back to the real last successful sync when dataThrough is unavailable');
assert.match(syncFallback.detail,/rapports sont encore en préparation/i,'Waiting Reporting API state stays explicit');
assert.equal(context.statusColor(syncFallback),'var(--amber)','Reports being prepared are amber, never green');
assert.equal(context.statusColor({key:'studio',api:true,connected:true,status:'healthy',when:Date.now(),dataThroughT:null}),'var(--red)','A healthy label without a covered reporting day is rejected');
assert.match(recommendations,/function anaStudioScopeCopy\(\)/,'Analysis must expose the actual Studio reporting scope');
assert.match(recommendations,/studioReportingWindowLabel\(meta,fr\)/,'Analysis must derive its window from Studio snapshot metadata');
assert.doesNotMatch(recommendations,/YouTube Studio, 365 days|YouTube Studio, 365 jours/,'Analysis must not hard-code a 365-day Studio window');
if(!index.includes('dashboard-02-helpers.js?v=20260801-youtube-studio-auto-v1')) throw new Error('YouTube status cache version is stale');
if(!index.includes('dashboard-04-recommendations.js?v=20260801-youtube-studio-auto-v1')) throw new Error('YouTube analysis cache version is stale');
if(!index.includes("Lofi_Radar_studio.js?payload='+Date.now()")) throw new Error('YouTube Studio snapshot must bypass the browser cache');
console.log('youtube channel update status: ok');

