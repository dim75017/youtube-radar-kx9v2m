'use strict';

/* Lazy track analytics for the lightweight Spotify Radar.
   --------------------------------------------------------
   This module is fetched only when a track is opened. It keeps the compact
   first paint intact, loads one deterministic performance shard, and renders
   the complete analytical card around the Radar-owned 30-second player. */
(function spotifyTrackAnalyticsModule(global){
  const doc=global&&global.document;
  const RATE=0.0035;
  const BUY={
    fx:.875,orchard:.08,costs:.12,decote:.15,multiPlat:.20,publishing:.10,
    splits:[
      {key:'50/50',artist:.50,advance:.30},
      {key:'60/40',artist:.60,advance:.40},
      {key:'70/30',artist:.30,advance:.50},
      {key:'80/20',artist:.20,advance:.60},
      {key:'90/10',artist:.10,advance:.75},
      {key:'100/0',artist:0,advance:1.10},
    ],
  };
  const state={metric:'streams',period:30,split:'90/10',publishing:false,years:2};
  const entryCache=new Map();
  let playerPromise=null;
  let shardQueue=Promise.resolve();
  let activeCleanup=null;
  let activeRequest=0;

  const esc=value=>String(value==null?'':value).replace(/[&<>'"]/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;',
  }[char]));
  const finite=value=>{
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  };
  const safeImage=value=>{
    const url=String(value||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  };
  const validSpotifyId=value=>/^[A-Za-z0-9]{22}$/.test(String(value||''))?String(value):'';
  const langLocale=language=>language==='en'?'en-GB':'fr-FR';
  const tr=(language,fr,en)=>language==='en'?en:fr;
  function schemaIndex(fields){
    return Object.fromEntries((Array.isArray(fields)?fields:[]).map((field,index)=>[field,index]));
  }
  function value(row,index,name){
    return Array.isArray(row)&&Number.isInteger(index[name])?row[index[name]]:null;
  }
  function formatNumber(input,language,compact=false){
    const number=finite(input);
    if(number==null)return '—';
    return new Intl.NumberFormat(langLocale(language),compact?{
      notation:'compact',maximumFractionDigits:Math.abs(number)>=1e6?1:0,
    }:{maximumFractionDigits:0}).format(Math.round(number));
  }
  function formatSigned(input,language,compact=false){
    const number=finite(input);
    if(number==null)return '—';
    return `${number>0?'+':''}${formatNumber(number,language,compact)}`;
  }
  function formatMoney(input,language,currency='USD'){
    const number=finite(input);
    if(number==null)return '—';
    return new Intl.NumberFormat(langLocale(language),{
      style:'currency',currency,maximumFractionDigits:Math.abs(number)>=1000?0:2,
    }).format(number);
  }
  function formatDate(input,language){
    const day=String(input||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return '—';
    const parsed=new Date(`${day}T12:00:00Z`);
    if(!Number.isFinite(parsed.getTime()))return '—';
    return new Intl.DateTimeFormat(langLocale(language),{
      day:'2-digit',month:'short',year:'numeric',timeZone:'UTC',
    }).format(parsed);
  }
  function formatConfidence(input){
    const number=finite(input);
    if(number==null)return '—';
    return `${Math.round((number<=1?number*100:number))}%`;
  }
  function displayGenre(input,language){
    const raw=String(input||'').trim().toLowerCase();
    if(!raw||['trusted_catalogue','catalogue_trusted','trusted_internal_catalogue'].includes(raw)){
      return tr(language,'À classifier','Unclassified');
    }
    return raw.replaceAll('_',' ').replace(/\b\w/g,char=>char.toUpperCase());
  }
  function displayInstrumental(input,language){
    const raw=String(input||'').toLowerCase();
    if(raw==='instrumental'||input===true)return tr(language,'Instrumental','Instrumental');
    if(['vocal','vocals','non instrumental','non_instrumental'].includes(raw)||input===false){
      return tr(language,'Non instrumental','Non-instrumental');
    }
    return tr(language,'À vérifier','To review');
  }
  function aiRisk(input,language){
    const raw=String(input||'').toLowerCase();
    if(['low','faible'].includes(raw))return {className:'ai-low',label:tr(language,'Faible','Low')};
    if(['high','élevé','eleve'].includes(raw))return {className:'ai-high',label:tr(language,'Élevé','High')};
    return {className:'ai-check',label:tr(language,'À vérifier','To review')};
  }

  function normalizeCounterHistory(raw){
    const daily=new Map();
    for(const point of Array.isArray(raw)?raw:[]){
      const day=String(Array.isArray(point)?point[0]:point&&point.date||'').slice(0,10);
      const rawValue=Array.isArray(point)?point[1]:point&&point.value;
      const number=finite(rawValue);
      const parsed=new Date(`${day}T00:00:00Z`);
      if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&number!=null&&number>=0&&
          Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===day){
        daily.set(day,number);
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
    return Math.round((new Date(`${right}T00:00:00Z`)-new Date(`${left}T00:00:00Z`))/864e5);
  }
  // A period exists only when the exact D-N and D-2N counter baselines exist.
  // Missing dates are never interpolated and never presented as zero.
  function counterWindow(raw,days){
    const points=normalizeCounterHistory(raw);
    const empty={days,current:null,previous:null,change:null,pct:null,currentReady:false,comparisonReady:false,points:points.length};
    if(!points.length)return empty;
    const latest=points[points.length-1];
    const byDay=new Map(points);
    const previousDay=shiftDay(latest[0],-days);
    const comparisonDay=shiftDay(latest[0],-2*days);
    if(!byDay.has(previousDay))return Object.assign(empty,{latestDate:latest[0]});
    const current=latest[1]-byDay.get(previousDay);
    if(!byDay.has(comparisonDay))return Object.assign(empty,{latestDate:latest[0],current,currentReady:true});
    const previous=byDay.get(previousDay)-byDay.get(comparisonDay);
    const change=current-previous;
    return {days,current,previous,change,pct:previous>0?change/previous*100:null,currentReady:true,comparisonReady:true,points:points.length,latestDate:latest[0]};
  }
  function dailyFlowSeries(raw){
    const points=normalizeCounterHistory(raw);
    const daily=[];
    for(let index=1;index<points.length;index+=1){
      if(dayGap(points[index-1][0],points[index][0])!==1)continue;
      daily.push([points[index][0],points[index][1]-points[index-1][1]]);
    }
    return daily;
  }
  function recentPoints(points,period){
    if(!points.length||period==='all')return points;
    const threshold=shiftDay(points[points.length-1][0],-(Number(period)-1));
    return points.filter(point=>point[0]>=threshold);
  }

  function ensureStyle(id,href){
    if(!doc||doc.getElementById(id))return;
    const link=doc.createElement('link');
    link.id=id;link.rel='stylesheet';link.href=href;
    doc.head.appendChild(link);
  }
  function ensurePlayer(version){
    ensureStyle('spotify-track-analytics-style',`track-analytics.css?v=${encodeURIComponent(version)}`);
    ensureStyle('spotify-radar-player-style',`player.css?v=${encodeURIComponent(version)}`);
    if(global.SpotifyRadarPlayer)return Promise.resolve(global.SpotifyRadarPlayer);
    if(playerPromise)return playerPromise;
    playerPromise=new Promise((resolve,reject)=>{
      const script=doc.createElement('script');
      script.id='spotify-radar-player-script';
      script.src=`player.js?v=${encodeURIComponent(version)}`;
      script.async=true;
      script.onload=()=>global.SpotifyRadarPlayer?resolve(global.SpotifyRadarPlayer):reject(new Error('Spotify Radar player did not initialize'));
      script.onerror=()=>reject(new Error('Spotify Radar player failed to load'));
      doc.head.appendChild(script);
    }).catch(error=>{playerPromise=null;throw error;});
    return playerPromise;
  }
  function previewRegister(spotifyId,hash){
    const root=global.SPOTIFY_PREVIEW_AUDIO&&typeof global.SPOTIFY_PREVIEW_AUDIO==='object'
      ?global.SPOTIFY_PREVIEW_AUDIO:{version:1,duration_seconds:30,hashes:{}};
    if(!root.hashes||typeof root.hashes!=='object')root.hashes={};
    if(/^[a-f0-9]{40}$/i.test(String(hash||'')))root.hashes[spotifyId]=String(hash).toLowerCase();
    global.SPOTIFY_PREVIEW_AUDIO=root;
  }

  function performanceDescriptor(manifest,bucket){
    if(!manifest||manifest.algorithm!=='sha256_mod'||!Array.isArray(manifest.shards))return null;
    const schema=schemaIndex(manifest.shard_schema);
    const row=manifest.shards.find(item=>Array.isArray(item)&&Number(item[schema.bucket])===Number(bucket));
    if(!row)return null;
    const path=String(row[schema.path]||'');
    const sha256=String(row[schema.sha256]||'');
    if(!/^Spotify_Performance_tracks\/tracks-\d{2}-[a-f0-9]{16}\.js$/i.test(path)||!/^[a-f0-9]{64}$/i.test(sha256))return null;
    return {bucket:Number(bucket),path,sha256};
  }
  function clearShardGlobals(bucket){
    try{
      if(global.SPOTIFY_PERFORMANCE&&global.SPOTIFY_PERFORMANCE.tracks)global.SPOTIFY_PERFORMANCE.tracks={};
      if(global.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED)delete global.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED[bucket];
      delete global.SPOTIFY_PERFORMANCE_TRACK_SHARD;
      delete global.SPOTIFY_PERFORMANCE;
    }catch(error){}
  }
  function cacheEntry(spotifyId,entry){
    entryCache.set(spotifyId,entry||{});
    while(entryCache.size>24)entryCache.delete(entryCache.keys().next().value);
    return entry||{};
  }
  function loadPerformanceEntry(spotifyId,bucket,available,manifest){
    if(entryCache.has(spotifyId))return Promise.resolve(entryCache.get(spotifyId));
    if(!available)return Promise.resolve(cacheEntry(spotifyId,{}));
    const descriptor=performanceDescriptor(manifest,bucket);
    if(!descriptor||!doc)return Promise.resolve(cacheEntry(spotifyId,{}));
    const task=()=>new Promise((resolve,reject)=>{
      const script=doc.createElement('script');
      script.src=`../${descriptor.path}?v=${descriptor.sha256.slice(0,16)}`;
      script.async=true;script.fetchPriority='low';
      script.onload=()=>{
        const shard=global.SPOTIFY_PERFORMANCE_TRACK_SHARD;
        const valid=shard&&Number(shard.bucket)===descriptor.bucket&&shard.tracks&&typeof shard.tracks==='object';
        const entry=valid&&shard.tracks[spotifyId]&&typeof shard.tracks[spotifyId]==='object'?shard.tracks[spotifyId]:{};
        clearShardGlobals(descriptor.bucket);script.remove();resolve(cacheEntry(spotifyId,entry));
      };
      script.onerror=()=>{clearShardGlobals(descriptor.bucket);script.remove();reject(new Error('Spotify performance shard failed to load'));};
      doc.head.appendChild(script);
    });
    const queued=shardQueue.catch(()=>{}).then(task);
    shardQueue=queued.then(()=>undefined,()=>undefined);
    return queued;
  }

  function metricValue(number,language,signed=false){
    if(state.metric==='revenue'){
      const result=formatMoney(finite(number)==null?null:Number(number)*RATE,language,'USD');
      return signed&&finite(number)>0?`+${result}`:result;
    }
    return signed?formatSigned(number,language):formatNumber(number,language);
  }
  function performanceCard(label,windowMetric,language){
    const current=windowMetric.currentReady?metricValue(windowMetric.current,language,true):'—';
    let comparison=tr(language,'Historique exact insuffisant','Insufficient exact history');
    let className='';
    if(windowMetric.comparisonReady){
      className=windowMetric.change>0?'good':windowMetric.change<0?'bad':'';
      const percent=windowMetric.pct==null?'':` · ${windowMetric.pct>0?'+':''}${windowMetric.pct.toFixed(1)}%`;
      comparison=`${tr(language,'vs période précédente','vs previous period')} : ${metricValue(windowMetric.change,language,true)}${percent}`;
    }else if(windowMetric.currentReady){
      comparison=tr(language,'Période mesurée · comparaison indisponible','Measured period · comparison unavailable');
    }
    return `<div class="perf-card"><div class="plabel">${esc(label)}</div><div class="pvalue">${esc(current)}</div><div class="pcompare ${className}">${esc(comparison)}</div></div>`;
  }
  function performanceHtml(context){
    const {row,index,entry,language}=context;
    const history=entry&&entry.history||[];
    const total=finite(value(row,index,'streams'));
    const fallback24=finite(value(row,index,'delta_24h'));
    const windows={1:counterWindow(history,1),7:counterWindow(history,7),30:counterWindow(history,30)};
    if(!windows[1].currentReady&&fallback24!=null){
      windows[1]=Object.assign({},windows[1],{current:fallback24,currentReady:true,source:'catalogue_daily_delta'});
    }
    context.windows=windows;
    const totalLabel=state.metric==='revenue'?tr(language,'Revenus total estimés','Estimated total revenue'):tr(language,'Streams total','Total streams');
    const totalValue=state.metric==='revenue'?formatMoney(total==null?null:total*RATE,language,'USD'):formatNumber(total,language);
    const totalNote=state.metric==='revenue'?tr(language,'Estimation lifetime à 0,0035 $ / stream','Lifetime estimate at $0.0035 / stream'):tr(language,'Compteur lifetime','Lifetime counter');
    const labels={
      30:state.metric==='revenue'?tr(language,'Revenus 30 jours','30-day revenue'):tr(language,'Streams 30 jours','30-day streams'),
      7:state.metric==='revenue'?tr(language,'Revenus 7 jours','7-day revenue'):tr(language,'Streams 7 jours','7-day streams'),
      1:state.metric==='revenue'?tr(language,'Revenus 24 heures','24-hour revenue'):tr(language,'Streams 24 heures','24-hour streams'),
    };
    return `<div class="perf-grid"><div class="perf-card"><div class="plabel">${esc(totalLabel)}</div><div class="pvalue">${esc(totalValue)}</div><div class="pcompare">${esc(totalNote)}</div></div>${performanceCard(labels[30],windows[30],language)}${performanceCard(labels[7],windows[7],language)}${performanceCard(labels[1],windows[1],language)}</div>`;
  }

  function chartValueLabel(value,language){
    return state.metric==='revenue'?formatMoney(Number(value)*RATE,language,'USD'):`${formatSigned(value,language)} streams`;
  }
  function chartAxisLabel(value,language){
    return state.metric==='revenue'?formatMoney(Number(value)*RATE,language,'USD'):formatNumber(value,language,true);
  }
  function sparkline(points,language){
    if(!Array.isArray(points)||points.length<2){
      return `<div class="analytics-note track-analytics-empty">${esc(tr(language,'Historique quotidien insuffisant pour tracer la courbe · aucune extrapolation','Insufficient daily history for a chart · no extrapolation'))}</div>`;
    }
    const width=560,height=120,padding=6;
    const timestamps=points.map(point=>new Date(`${point[0]}T00:00:00Z`).getTime());
    const values=points.map(point=>Number(point[1]));
    const xMin=Math.min(...timestamps),xMax=Math.max(...timestamps),yMin=Math.min(...values),yMax=Math.max(...values);
    const scaleX=input=>padding+(xMax===xMin?0:(input-xMin)/(xMax-xMin))*(width-2*padding);
    const scaleY=input=>height-padding-(yMax===yMin?.5*(height-2*padding):(input-yMin)/(yMax-yMin)*(height-2*padding));
    const path=points.map((point,index)=>`${index?'L':'M'}${scaleX(timestamps[index]).toFixed(1)} ${scaleY(values[index]).toFixed(1)}`).join(' ');
    const middle=Math.floor((points.length-1)/2);
    const axisDates=[points[0][0],points[middle][0],points[points.length-1][0]].map(day=>formatDate(day,language));
    const yMiddle=yMin+(yMax-yMin)/2;
    const yLabels=yMax===yMin?['',chartAxisLabel(yMax,language),'']:[chartAxisLabel(yMax,language),chartAxisLabel(yMiddle,language),chartAxisLabel(yMin,language)];
    const dots=points.map((point,index)=>`<circle class="spark-point" cx="${scaleX(timestamps[index]).toFixed(1)}" cy="${scaleY(values[index]).toFixed(1)}" r="1.25" fill="#4ade80" data-date="${esc(formatDate(point[0],language))}" data-value="${esc(chartValueLabel(point[1],language))}"/>`).join('');
    const aria=tr(language,`Historique du ${axisDates[0]} au ${axisDates[2]}`,`History from ${axisDates[0]} to ${axisDates[2]}`);
    return `<div class="spark-wrap"><div class="spark-chart" role="img" aria-label="${esc(aria)}"><div class="spark-y-axis" aria-hidden="true"><span>${esc(yLabels[0])}</span><span>${esc(yLabels[1])}</span><span>${esc(yLabels[2])}</span></div><div class="spark-plot"><svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="120" preserveAspectRatio="none"><g class="spark-grid" aria-hidden="true"><line x1="${padding}" y1="${padding}" x2="${width-padding}" y2="${padding}"/><line x1="${padding}" y1="${height/2}" x2="${width-padding}" y2="${height/2}"/><line x1="${padding}" y1="${height-padding}" x2="${width-padding}" y2="${height-padding}"/><line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}"/><line x1="${width/2}" y1="${padding}" x2="${width/2}" y2="${height-padding}"/><line x1="${width-padding}" y1="${padding}" x2="${width-padding}" y2="${height-padding}"/></g><path class="spark-area" d="${path} L ${scaleX(xMax)} ${height-padding} L ${scaleX(xMin)} ${height-padding} Z" fill="#4ade80" opacity="0.1"/><path class="spark-line" d="${path}" fill="none" stroke="#4ade80" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg><span class="spark-hover-guide" style="display:none"></span><span class="spark-hover-point" style="display:none;background:#4ade80"></span><div class="spark-tooltip" role="status" aria-live="polite"></div></div><div class="spark-x-axis" aria-hidden="true"><span>${esc(axisDates[0])}</span><span>${esc(axisDates[1])}</span><span>${esc(axisDates[2])}</span></div></div></div>`;
  }
  function showSparkPoint(svg,event){
    const wrap=svg.closest('.spark-wrap');if(!wrap)return;
    const dots=[...svg.querySelectorAll('.spark-point')];
    const tip=wrap.querySelector('.spark-tooltip');
    const marker=wrap.querySelector('.spark-hover-point');
    const guide=wrap.querySelector('.spark-hover-guide');
    if(!dots.length||!tip||!marker)return;
    const rect=svg.getBoundingClientRect();
    const pointer=Math.max(0,Math.min(560,(event.clientX-rect.left)/Math.max(rect.width,1)*560));
    const dot=dots.reduce((best,item)=>Math.abs(Number(item.getAttribute('cx'))-pointer)<Math.abs(Number(best.getAttribute('cx'))-pointer)?item:best,dots[0]);
    const x=Number(dot.getAttribute('cx')),y=Number(dot.getAttribute('cy'));
    const left=x/560*rect.width;
    marker.style.left=`${left}px`;marker.style.top=`${y/120*rect.height}px`;marker.style.display='block';
    if(guide){guide.style.left=`${left}px`;guide.style.display='block';}
    tip.textContent=`${dot.dataset.date} · ${dot.dataset.value}`;
    tip.style.left=`${Math.max(56,Math.min(rect.width-56,left))}px`;
    tip.style.top=`${Math.max(26,y/120*rect.height-10)}px`;
    wrap.classList.add('has-tip');
  }
  function bindSparkline(root){
    const svg=root&&root.querySelector('.spark');if(!svg)return;
    svg.addEventListener('pointerenter',event=>showSparkPoint(svg,event));
    svg.addEventListener('pointermove',event=>showSparkPoint(svg,event));
    svg.addEventListener('pointerleave',()=>{
      const wrap=svg.closest('.spark-wrap');if(!wrap)return;
      wrap.classList.remove('has-tip');
      const marker=wrap.querySelector('.spark-hover-point');if(marker)marker.style.display='none';
      const guide=wrap.querySelector('.spark-hover-guide');if(guide)guide.style.display='none';
    });
  }
  function chartHtml(context){
    const {entry,language}=context;
    const flows=recentPoints(dailyFlowSeries(entry&&entry.history||[]),state.period);
    const title=state.metric==='revenue'?tr(language,'Courbe quotidienne des revenus estimés','Estimated daily revenue'):tr(language,'Courbe quotidienne des streams','Daily stream flow');
    const note=state.metric==='revenue'?tr(language,'Estimation d’après les streams','Estimated from streams'):tr(language,'Flux quotidien, pas compteur lifetime','Daily flow, not lifetime counter');
    const periods=[7,30,90,180,360,'all'];
    const controls=periods.map(period=>{
      const label=period==='all'?tr(language,"Tout l'historique",'All history'):`${period} j`;
      return `<button type="button" class="${state.period===period?'on':''}" data-track-period="${period}">${esc(label)}</button>`;
    }).join('');
    return `<div class="analytics-section track-flow-analytics"><h4><span>${esc(title)} <span class="analytics-note">${esc(note)}</span></span><span class="analytics-window" role="group" aria-label="${esc(tr(language,'Période de la courbe','Chart period'))}">${controls}</span></h4>${sparkline(flows,language)}</div>`;
  }

  function playlistsHtml(context){
    const {row,index,language,minimumFollowers}=context;
    const placements=Array.isArray(value(row,index,'editorial_placements'))?value(row,index,'editorial_placements'):[];
    const eligible=placements.filter(item=>Array.isArray(item)&&finite(item[3])>=minimumFollowers);
    if(!eligible.length)return '';
    const cards=eligible.map(item=>{
      const spotifyId=validSpotifyId(item[0]);
      const name=String(item[1]||spotifyId||tr(language,'Playlist éditoriale','Editorial playlist'));
      const position=finite(item[2]);
      const followers=finite(item[3]);
      const dates=[item[4]?`${tr(language,'depuis','since')} ${formatDate(item[4],language)}`:'',item[5]?`${tr(language,'vu le','seen')} ${formatDate(item[5],language)}`:''].filter(Boolean).join(' · ');
      const content=`<span class="ar-detail-editorial-cover"><span class="ar-playlist-fallback">♫</span></span><span class="ar-detail-editorial-copy"><strong title="${esc(name)}">${esc(name)}</strong><small>${esc(`${formatNumber(followers,language)} followers${position==null?'':` · #${Math.round(position)}`}`)}</small>${dates?`<small>${esc(dates)}</small>`:''}</span>`;
      return spotifyId?`<a class="ar-detail-editorial" href="https://open.spotify.com/playlist/${encodeURIComponent(spotifyId)}?locale=en" target="_blank" rel="noopener">${content}</a>`:`<div class="ar-detail-editorial">${content}</div>`;
    }).join('');
    return `<div class="analytics-section ar-detail-editorials"><h4>${esc(tr(language,'Présence en playlists éditoriales','Editorial playlist presence'))}<span class="analytics-note">${formatNumber(eligible.length,language)} · ≥ ${formatNumber(minimumFollowers,language)} followers</span></h4><div class="ar-detail-editorial-list">${cards}</div></div>`;
  }

  function monthsBetween(releaseDate,lastDay){
    const release=new Date(`${String(releaseDate||'').slice(0,10)}T00:00:00Z`);
    const end=new Date(`${String(lastDay||'').slice(0,10)}T00:00:00Z`);
    if(!Number.isFinite(release.getTime())||!Number.isFinite(end.getTime())||end<release)return null;
    return Math.max((end-release)/864e5/30.4368,1);
  }
  function offerNumbers(context){
    const total=finite(value(context.row,context.index,'streams'));
    const history=normalizeCounterHistory(context.entry&&context.entry.history||[]);
    const lastDay=history.length?history[history.length-1][0]:String(value(context.row,context.index,'updated_at')||'').slice(0,10);
    const months=monthsBetween(value(context.row,context.index,'release_date'),lastDay);
    const monthly=total!=null&&months?Math.max(total/months,0):0;
    const split=BUY.splits.find(item=>item.key===state.split)||BUY.splits[4];
    const projectedUsd=monthly*state.years*12*RATE*(1+BUY.multiPlat);
    const base=projectedUsd*BUY.fx*(1-BUY.orchard)*(1-BUY.costs)*(1-BUY.decote);
    const advance=base*split.advance*(state.publishing?1+BUY.publishing:1);
    const monthlyCaptured=monthly*RATE*(1+BUY.multiPlat)*BUY.fx*(1-BUY.orchard)*(1-BUY.costs)*(1-split.artist);
    return {monthly,advance,monthlyCaptured,payback:monthlyCaptured>0?advance/monthlyCaptured:null};
  }
  function offerHtml(context){
    const {language}=context;
    const numbers=offerNumbers(context);
    const splitButtons=BUY.splits.map(split=>`<button type="button" class="${state.split===split.key?'on':''}" data-offer-split="${split.key}">${split.key}</button>`).join('');
    const years=[1,2,3,4,5].map(year=>`<button type="button" class="${state.years===year?'on':''}" data-offer-years="${year}">${year} ${tr(language,'an','y')}</button>`).join('');
    const payback=numbers.payback==null?'—':`${numbers.payback.toFixed(1)} ${tr(language,'mois','months')}`;
    return `<div class="offer track-offer"><h3>💰 ${esc(tr(language,'Offre suggérée pour cette track','Suggested offer for this track'))}</h3><div class="osub">${esc(tr(language,'Simulation séparée des données Analytics · estimation multi-plateformes','Separate from Analytics · multi-platform estimate'))}</div><div class="pal">${splitButtons}<label class="selall track-publishing"><input type="checkbox" class="ck" data-offer-publishing ${state.publishing?'checked':''}> Publishing +10%</label><span class="payback-horizon"><span>${esc(tr(language,'Horizon de projection','Projection horizon'))}</span>${years}</span></div><div class="ogrid"><div class="ob"><div class="l">${esc(tr(language,'Avance à proposer','Suggested advance'))}</div><div class="v track-offer-green">${numbers.monthly>0?formatMoney(numbers.advance,language,'EUR'):'—'}</div></div><div class="ob"><div class="l">${esc(tr(language,'Revenu capté / mois','Revenue captured / month'))}</div><div class="v track-offer-cyan">${numbers.monthly>0?formatMoney(numbers.monthlyCaptured,language,'EUR'):'—'}</div></div><div class="ob"><div class="l">Payback</div><div class="v">${esc(payback)}</div></div></div></div>`;
  }

  function renderAnalytics(context){
    const metrics=context.box.querySelector('[data-track-performance]');
    const chart=context.box.querySelector('[data-track-chart]');
    const offer=context.box.querySelector('[data-track-offer]');
    if(metrics)metrics.innerHTML=performanceHtml(context);
    if(chart){chart.innerHTML=chartHtml(context);bindSparkline(chart);}
    if(offer)offer.innerHTML=offerHtml(context);
    context.box.querySelectorAll('[data-track-metric]').forEach(button=>button.classList.toggle('on',button.dataset.trackMetric===state.metric));
  }
  function renderShell(context){
    const {row,index,language,box,spotifyId,selected}=context;
    const title=String(value(row,index,'title')||tr(language,'Titre non renseigné','Untitled'));
    const artist=String(value(row,index,'credit_name')||tr(language,'Artiste non renseigné','Unknown artist'));
    const artwork=safeImage(value(row,index,'image_url'));
    const performanceClassification=context.entry&&context.entry.classification||{};
    const genre=value(row,index,'genre')||performanceClassification.genre;
    const instrumental=value(row,index,'instrumental_status')||performanceClassification.instrumental;
    const instrumentalConfidence=value(row,index,'instrumental_confidence')??performanceClassification.instrumental_confidence;
    const risk=aiRisk(value(row,index,'ai_risk')||performanceClassification.ai_risk,language);
    const player=global.SpotifyRadarPlayer.html({
      spotifyId,title,artist,artwork,transportOnly:true,extraClass:'track-analytics-player',
      labels:{
        player:tr(language,'Lecteur Radar · extrait 30 s','Radar player · 30-second preview'),
        play:tr(language,"Lire l'extrait","Play preview"),pause:tr(language,'Mettre en pause','Pause'),
        ready:tr(language,'Extrait de 30 secondes prêt','30-second preview ready'),
        unavailable:tr(language,'Extrait de 30 secondes indisponible','30-second preview unavailable'),
        source:tr(language,'Source Spotify','Spotify source'),
      },
    });
    const cover=artwork?`<span class="tcov has-track-cover"><img src="${esc(artwork)}" alt="" loading="lazy"></span>`:'<span class="tcov track-cover-fallback" aria-hidden="true">♫</span>';
    box.innerHTML=`<div class="thd">${cover}<div class="track-analytics-title"><span class="fast-kicker">${esc(tr(language,'Fiche Analytics','Analytics'))}</span><h3>${esc(title)}</h3><div class="tar track-analytics-artist">${esc(artist)}</div></div><button class="tclose" type="button" data-close-modal aria-label="${esc(tr(language,'Fermer','Close'))}">✕</button></div>${player}<div class="tgrid track-analytics-facts"><div class="tg"><div class="l">${esc(tr(language,'Sortie','Released'))}</div><div class="v">${esc(formatDate(value(row,index,'release_date'),language))}</div></div><div class="tg"><div class="l">Label</div><div class="v track-small-value">${esc(value(row,index,'label')||'—')}</div></div><div class="tg"><div class="l">© / ℗</div><div class="v track-small-value">${esc(value(row,index,'copyright')||'—')}</div></div><div class="tg"><div class="l">${esc(tr(language,'Genre','Genre'))}</div><div class="v track-small-value">${esc(displayGenre(genre,language))}</div></div><div class="tg"><div class="l">${esc(tr(language,'Instrumental','Instrumental'))}</div><div class="v track-small-value">${esc(displayInstrumental(instrumental,language))}${instrumentalConfidence!=null?` · ${esc(formatConfidence(instrumentalConfidence))}`:''}</div></div><div class="tg"><div class="l">${esc(tr(language,'Risque IA','AI risk'))}</div><div class="v"><span class="badge ${risk.className}">${esc(risk.label)}</span></div></div></div><div class="track-analytics-toolbar"><span class="metric-toggle" role="group" aria-label="Streams ou revenus"><button type="button" class="${state.metric==='streams'?'on':''}" data-track-metric="streams">🎧 Streams</button><button type="button" class="${state.metric==='revenue'?'on':''}" data-track-metric="revenue">💶 ${esc(tr(language,'Revenus','Revenue'))}</button></span></div><div data-track-performance><div class="track-analytics-loading">${esc(tr(language,"Chargement de l'historique quotidien…",'Loading daily history…'))}</div></div>${playlistsHtml(context)}<div data-track-chart></div><div data-track-offer></div><div class="fast-modal-actions track-analytics-actions"><button type="button" class="fast-selection-action ${selected?'on':''}" data-select-track="${esc(spotifyId)}">${esc(selected?tr(language,'Retirer de la sélection','Remove from selection'):tr(language,'Ajouter à la sélection','Add to selection'))}</button></div><div class="tnote">${esc(tr(language,"Les fenêtres utilisent seulement l'historique quotidien observé et comparent des périodes de même durée. Aucun jour manquant n'est inventé.",'Windows use observed daily history only and compare equal periods. Missing days are never invented.'))}</div>`;
    global.SpotifyRadarPlayer.hydrate(box);
  }

  function bindInteractions(context){
    const controller=typeof AbortController==='function'?new AbortController():null;
    const options=controller?{signal:controller.signal}:undefined;
    const click=event=>{
      const metric=event.target.closest('[data-track-metric]');
      if(metric){state.metric=metric.dataset.trackMetric==='revenue'?'revenue':'streams';renderAnalytics(context);return;}
      const period=event.target.closest('[data-track-period]');
      if(period){state.period=period.dataset.trackPeriod==='all'?'all':Number(period.dataset.trackPeriod);renderAnalytics(context);return;}
      const split=event.target.closest('[data-offer-split]');
      if(split){state.split=split.dataset.offerSplit;renderAnalytics(context);return;}
      const years=event.target.closest('[data-offer-years]');
      if(years){state.years=Number(years.dataset.offerYears)||2;renderAnalytics(context);}
    };
    const change=event=>{
      if(event.target.matches('[data-offer-publishing]')){state.publishing=event.target.checked;renderAnalytics(context);}
    };
    context.box.addEventListener('click',click,options);
    context.box.addEventListener('change',change,options);
    activeCleanup=()=>{
      if(controller)controller.abort();
      else{context.box.removeEventListener('click',click);context.box.removeEventListener('change',change);}
    };
  }

  async function open(options={}){
    if(!doc)throw new Error('Track analytics requires a document');
    const request=++activeRequest;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
    const box=options.box||doc.getElementById('tmbox');
    if(!box)throw new Error('Track analytics modal body is missing');
    if(global.SpotifyRadarPlayer)global.SpotifyRadarPlayer.clear(box);
    const spotifyId=validSpotifyId(options.spotifyId);
    const index=schemaIndex(options.schema);
    const row=options.row;
    const language=options.language==='en'?'en':'fr';
    const analytics=options.analytics&&options.analytics.performance;
    const previewHash=value(row,index,'preview_hash');
    previewRegister(spotifyId,previewHash);
    await ensurePlayer(options.assetVersion||'track-analytics-v1');
    if(request!==activeRequest)return false;
    const context={
      row,index,language,box,spotifyId,selected:Boolean(options.selected),entry:{},
      minimumFollowers:finite(options.analytics&&options.analytics.editorial_min_followers)||10000,
    };
    box.classList.add('track-analytics-box');
    renderShell(context);
    bindInteractions(context);
    try{
      context.entry=await loadPerformanceEntry(
        spotifyId,
        value(row,index,'performance_bucket'),
        value(row,index,'performance_available')===true,
        analytics,
      );
    }catch(error){
      context.entry={};
      const note=box.querySelector('[data-track-performance]');
      if(note)note.dataset.historyLoadError='true';
    }
    if(request!==activeRequest)return false;
    renderAnalytics(context);
    return true;
  }
  function close(root){
    activeRequest+=1;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
    if(global.SpotifyRadarPlayer&&root)global.SpotifyRadarPlayer.clear(root);
  }

  const api={open,close};
  global.SpotifyTrackAnalytics=api;
  if(typeof module!=='undefined'&&module.exports){
    module.exports={...api,__test:{normalizeCounterHistory,counterWindow,dailyFlowSeries,recentPoints,performanceDescriptor,offerNumbers}};
  }
})(typeof window!=='undefined'?window:globalThis);
