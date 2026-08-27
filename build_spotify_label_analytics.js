#!/usr/bin/env node
'use strict';

/* Build the lazy label-analytics payload used by Spotify Radar.
   The public catalogue already contains the active track rows. This file adds
   only truthful, exact performance windows and aggregated daily flows so the
   heavy private performance monolith never reaches the browser. */

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const ROOT=__dirname;
const DEFAULT_CATALOGUE=path.join(ROOT,'Spotify_Catalogue_data.js');
const DEFAULT_LABELS=path.join(ROOT,'Spotify_Labels_data.js');
const DEFAULT_PERFORMANCE=path.join(ROOT,'Spotify_Performance_data.js');
const DEFAULT_OUTPUT=path.join(ROOT,'Spotify_Label_Analytics_data.js');
const OUTPUT_PREFIX='window.SPOTIFY_LABEL_ANALYTICS=';
const HISTORY_DAYS=365;

function argument(name,fallback){
  const index=process.argv.indexOf(name);
  return index>=0&&process.argv[index+1]?path.resolve(process.argv[index+1]):fallback;
}

function loadWindowExport(sourcePath,globalName){
  const context={window:{}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath,'utf8'),context,{filename:sourcePath,timeout:60_000});
  const value=context.window[globalName];
  if(!value||typeof value!=='object')throw new Error(`${sourcePath} did not expose window.${globalName}`);
  return value;
}

const finite=value=>{
  if(value==null||typeof value==='boolean'||String(value).trim()==='')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const text=value=>value==null?'':String(value);
const schemaIndex=fields=>Object.fromEntries((Array.isArray(fields)?fields:[]).map((field,index)=>[field,index]));
const value=(row,index,name)=>Array.isArray(row)&&Number.isInteger(index[name])?row[index[name]]:null;

const LICENSE_RE=/(?:under\s+(?:an?\s+)?|on\s+)?exclusive\s+licen[cs]e\s+(?:to|with|from)\s+(.+?)(?:\s*[;.]|$)/i;
const LICENSED_TO_RE=/licen[cs]ed\s+to\s+(.+?)(?:\s*[;.]|$)/i;
const YEAR_STRIP_RE=/^[©℗()pcPC\s]*\d{4}\s*/;

function labelDisplayName(input){
  const raw=text(input).trim();
  if(!raw)return '';
  const match=LICENSE_RE.exec(raw)||LICENSED_TO_RE.exec(raw);
  const extracted=match
    ?match[1].trim().replace(/\.$/,'')
    :raw.split(';')[0].trim().replace(YEAR_STRIP_RE,'').trim();
  return extracted
    .replace(/\s*,\s*(?:an?\s+)?division\s+of\b.*$/i,'')
    .replace(/[.,]+$/,'')
    .trim();
}

function labelKeyOf(input){
  const name=labelDisplayName(input);
  return name
    ?name.toLowerCase().normalize('NFKD').replace(/(?![\uFE00-\uFE0F])\p{M}/gu,'').replace(/\s+/g,' ').trim()
    :'';
}

function normalizeHistory(raw){
  const daily=new Map();
  for(const point of Array.isArray(raw)?raw:[]){
    const day=text(Array.isArray(point)?point[0]:point&&point.date).slice(0,10);
    const amount=finite(Array.isArray(point)?point[1]:point&&point.value);
    const parsed=new Date(`${day}T00:00:00Z`);
    if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&amount!=null&&amount>=0&&
        Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===day){
      daily.set(day,amount);
    }
  }
  return [...daily.entries()].sort((left,right)=>left[0].localeCompare(right[0]));
}

function shiftDay(day,offset){
  const parsed=new Date(`${day}T00:00:00Z`);
  if(!Number.isFinite(parsed.getTime()))return '';
  parsed.setUTCDate(parsed.getUTCDate()+offset);
  return parsed.toISOString().slice(0,10);
}

function dayGap(left,right){
  return Math.round((new Date(`${right}T00:00:00Z`)-new Date(`${left}T00:00:00Z`))/86_400_000);
}

// A window is valid only when the exact D-N baseline exists. The comparison
// additionally requires D-2N. No missing counter is ever treated as zero.
function counterWindow(raw,days){
  const points=normalizeHistory(raw);
  const empty={days,current:null,previous:null,comparisonCurrent:null,change:null,pct:null,currentReady:false,comparisonReady:false,points:points.length};
  if(!points.length)return empty;
  const latest=points[points.length-1],byDay=new Map(points);
  const baselineDay=shiftDay(latest[0],-days),comparisonDay=shiftDay(latest[0],-2*days);
  if(!byDay.has(baselineDay))return {...empty,latestDate:latest[0],baselineDay};
  const current=latest[1]-byDay.get(baselineDay);
  if(!byDay.has(comparisonDay))return {...empty,latestDate:latest[0],baselineDay,comparisonDay,current,currentReady:true};
  const previous=byDay.get(baselineDay)-byDay.get(comparisonDay);
  const change=current-previous;
  return {
    days,current,previous,comparisonCurrent:current,change,
    pct:previous>0?change/previous*100:null,currentReady:true,comparisonReady:true,
    points:points.length,latestDate:latest[0],baselineDay,comparisonDay,
  };
}

function dailyFlow(raw){
  const points=normalizeHistory(raw),result=[];
  for(let index=1;index<points.length;index+=1){
    if(dayGap(points[index-1][0],points[index][0])!==1)continue;
    result.push([points[index][0],points[index][1]-points[index-1][1]]);
  }
  return result;
}

function aggregateWindow(trackEntries,days){
  let current=0,currentCount=0,comparableCurrent=0,previous=0,comparisonCount=0;
  for(const entry of trackEntries){
    const window=entry.windows[days];
    if(window.currentReady){current+=window.current;currentCount+=1;}
    if(window.comparisonReady){comparableCurrent+=window.current;previous+=window.previous;comparisonCount+=1;}
  }
  const total=trackEntries.length,change=comparableCurrent-previous;
  return [
    currentCount?current:null,
    comparisonCount?previous:null,
    comparisonCount?comparableCurrent:null,
    comparisonCount?change:null,
    comparisonCount&&previous>0?change/previous*100:null,
    currentCount,comparisonCount,total,
  ];
}

function aggregateDaily(trackEntries){
  const sums=new Map(),coverage=new Map();
  for(const entry of trackEntries){
    for(const point of dailyFlow(entry.history)){
      sums.set(point[0],(sums.get(point[0])||0)+point[1]);
      coverage.set(point[0],(coverage.get(point[0])||0)+1);
    }
  }
  return [...sums.entries()]
    .sort((left,right)=>left[0].localeCompare(right[0]))
    .slice(-HISTORY_DAYS)
    .map(([day,streams])=>[day,streams,coverage.get(day)||0]);
}

function sha256(paths){
  const hash=crypto.createHash('sha256');
  for(const sourcePath of paths)hash.update(fs.readFileSync(sourcePath));
  return hash.digest('hex');
}

function buildPayload(catalogue,labels,performance,options={}){
  const trackFields=catalogue&&catalogue.schemas&&catalogue.schemas.tracks;
  const labelFields=labels&&labels.cols;
  if(!Array.isArray(trackFields)||!Array.isArray(catalogue.tracks))throw new Error('Compact Spotify catalogue is missing tracks');
  if(!Array.isArray(labelFields)||!Array.isArray(labels.rows))throw new Error('Spotify label catalogue is missing labels');
  const tracksPerformance=performance&&performance.tracks&&typeof performance.tracks==='object'?performance.tracks:{};
  const t=schemaIndex(trackFields),l=schemaIndex(labelFields);
  for(const required of ['spotify_id','credit_name','release_date','streams','label','copyright']){
    if(!Number.isInteger(t[required]))throw new Error(`Track schema is missing ${required}`);
  }
  for(const required of ['key','name'])if(!Number.isInteger(l[required]))throw new Error(`Label schema is missing ${required}`);

  const groups=new Map();
  for(const row of catalogue.tracks){
    if(!Array.isArray(row))continue;
    const labelSource=text(value(row,t,'label')).trim()||text(value(row,t,'copyright')).trim();
    const key=labelKeyOf(labelSource);
    const spotifyId=text(value(row,t,'spotify_id')).trim();
    if(!key||!spotifyId)continue;
    let group=groups.get(key);
    if(!group){
      group={key,name:labelDisplayName(labelSource)||key,rows:[],artists:new Set(),streams:0,since:''};
      groups.set(key,group);
    }
    group.rows.push(row);
    const artist=text(value(row,t,'credit_name')).trim();
    if(artist)group.artists.add(artist.toLocaleLowerCase('en'));
    const streams=finite(value(row,t,'streams'));
    if(streams!=null&&streams>0)group.streams+=streams;
    const release=text(value(row,t,'release_date')).slice(0,10);
    if(/^\d{4}-\d{2}-\d{2}$/.test(release)&&(!group.since||release<group.since))group.since=release;
  }

  const aliases={};
  let matchedLabels=0;
  for(const row of labels.rows){
    if(!Array.isArray(row))continue;
    const rawKey=text(value(row,l,'key')).trim();
    const name=text(value(row,l,'name')).trim();
    const candidates=[labelKeyOf(rawKey),labelKeyOf(name)].filter(Boolean);
    const groupKey=candidates.find(candidate=>groups.has(candidate));
    if(!groupKey)continue;
    matchedLabels+=1;
    if(rawKey)aliases[rawKey]=groupKey;
    for(const candidate of candidates)if(!aliases[candidate])aliases[candidate]=groupKey;
  }

  const groupRows={};
  const trackWindows={};
  let tracksWithHistory=0,dataThrough='';
  for(const [key,group] of [...groups.entries()].sort((left,right)=>left[0].localeCompare(right[0]))){
    const entries=[];
    for(const row of group.rows){
      const spotifyId=text(value(row,t,'spotify_id')).trim();
      const rawEntry=tracksPerformance[spotifyId]&&typeof tracksPerformance[spotifyId]==='object'?tracksPerformance[spotifyId]:{};
      const history=normalizeHistory(rawEntry.history);
      const windows={1:counterWindow(history,1),7:counterWindow(history,7),30:counterWindow(history,30)};
      if(history.length){tracksWithHistory+=1;dataThrough=[dataThrough,history[history.length-1][0]].sort().pop();}
      entries.push({spotifyId,history,windows});
      trackWindows[spotifyId]=[
        windows[1].currentReady?windows[1].current:null,
        windows[7].currentReady?windows[7].current:null,
        windows[30].currentReady?windows[30].current:null,
      ];
    }
    groupRows[key]=[
      group.name,group.rows.length,group.artists.size,Math.round(group.streams),group.since,
      aggregateWindow(entries,1),aggregateWindow(entries,7),aggregateWindow(entries,30),aggregateDaily(entries),
    ];
  }

  const minimumGroups=Number(options.minimumGroups)||0;
  if(groups.size<minimumGroups)throw new Error(`Refusing incomplete label analytics: ${groups.size} active labels`);
  return {
    version:1,
    generated_at:text(performance.generated_at||performance.generated_ts||performance.snapshot_ts),
    data_through:dataThrough,
    source_hash:text(options.sourceHash),
    history_days:HISTORY_DAYS,
    revenue_rate_eur:0.0035,
    group_schema:['name','tracks','artists','streams','since','window_1d','window_7d','window_30d','daily'],
    window_schema:['current','previous','comparison_current','change','pct','current_count','comparison_count','total'],
    daily_schema:['day','streams','coverage'],
    track_window_schema:['1d','7d','30d'],
    aliases,
    groups:groupRows,
    track_windows:trackWindows,
    status:{
      labels_total:labels.rows.length,labels_matched:matchedLabels,
      active_groups:groups.size,active_tracks:[...groups.values()].reduce((sum,group)=>sum+group.rows.length,0),
      tracks_with_history:tracksWithHistory,
    },
  };
}

function atomicWrite(target,content){
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=`${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary,content,'utf8');
  fs.renameSync(temporary,target);
}

function buildFile(options={}){
  const cataloguePath=options.cataloguePath||DEFAULT_CATALOGUE;
  const labelsPath=options.labelsPath||DEFAULT_LABELS;
  const performancePath=options.performancePath||DEFAULT_PERFORMANCE;
  const outputPath=options.outputPath||DEFAULT_OUTPUT;
  const catalogue=loadWindowExport(cataloguePath,'SPOTIFY_CATALOGUE');
  const labels=loadWindowExport(labelsPath,'SPOTIFY_LABELS');
  const performance=loadWindowExport(performancePath,'SPOTIFY_PERFORMANCE');
  const payload=buildPayload(catalogue,labels,performance,{
    minimumGroups:options.minimumGroups==null?100:options.minimumGroups,
    sourceHash:sha256([cataloguePath,labelsPath,performancePath]),
  });
  const serialized=JSON.stringify(payload);
  if(Buffer.byteLength(serialized)>15_000_000)throw new Error('Label analytics payload exceeds 15 MB');
  atomicWrite(outputPath,`${OUTPUT_PREFIX}${serialized};\n`);
  return {
    output:outputPath,bytes:Buffer.byteLength(serialized),data_through:payload.data_through,...payload.status,
  };
}

function main(){
  const result=buildFile({
    cataloguePath:argument('--catalogue',DEFAULT_CATALOGUE),
    labelsPath:argument('--labels',DEFAULT_LABELS),
    performancePath:argument('--performance',DEFAULT_PERFORMANCE),
    outputPath:argument('--output',DEFAULT_OUTPUT),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if(require.main===module)main();
else module.exports={
  buildFile,buildPayload,labelDisplayName,labelKeyOf,normalizeHistory,counterWindow,dailyFlow,aggregateWindow,
};

