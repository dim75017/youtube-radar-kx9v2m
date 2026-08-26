'use strict';

/* Lazy playlist analytics for the lightweight Spotify Radar.
   -----------------------------------------------------------
   The daily follower history is intentionally kept outside the first paint.
   It is fetched only after a playlist is opened, then rendered inside the
   Radar so the main playlist click never sends the user to Spotify. */
(function spotifyPlaylistAnalyticsModule(global){
  const doc=global&&global.document;
  const state={period:30};
  let datasetPromise=null;
  let activeCleanup=null;
  let activeRequest=0;

  const esc=value=>String(value==null?'':value).replace(/[&<>'"]/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;',
  }[char]));
  const finite=value=>{
    if(value==null||typeof value==='boolean'||String(value).trim()==='')return null;
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  };
  const validSpotifyId=value=>/^[A-Za-z0-9]{22}$/.test(String(value||''))?String(value):'';
  const tr=(language,fr,en)=>language==='en'?en:fr;
  const locale=language=>language==='en'?'en-GB':'fr-FR';
  const schemaIndex=fields=>Object.fromEntries((Array.isArray(fields)?fields:[]).map((field,index)=>[field,index]));
  const value=(row,index,name)=>Array.isArray(row)&&Number.isInteger(index[name])?row[index[name]]:null;
  const safeImage=input=>{
    const url=String(input||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  };
  function formatNumber(input,language,compact=false){
    const number=finite(input);
    if(number==null)return '—';
    return new Intl.NumberFormat(locale(language),compact?{
      notation:'compact',maximumFractionDigits:Math.abs(number)>=1e6?1:0,
    }:{maximumFractionDigits:0}).format(Math.round(number));
  }
  function formatSigned(input,language){
    const number=finite(input);
    return number==null?'—':`${number>0?'+':''}${formatNumber(number,language)}`;
  }
  function formatPercent(input,language){
    const number=finite(input);
    if(number==null)return '';
    return `${number>0?'+':''}${new Intl.NumberFormat(locale(language),{maximumFractionDigits:2}).format(number)} %`;
  }
  function formatDate(input,language,withYear=true){
    const day=String(input||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return '—';
    const parsed=new Date(`${day}T12:00:00Z`);
    if(!Number.isFinite(parsed.getTime()))return '—';
    return new Intl.DateTimeFormat(locale(language),{
      day:'2-digit',month:'short',...(withYear?{year:'numeric'}:{}),timeZone:'UTC',
    }).format(parsed);
  }
  function normalizeCounterHistory(raw){
    const daily=new Map();
    for(const point of Array.isArray(raw)?raw:[]){
      const day=String(Array.isArray(point)?point[0]:point&&point.date||'').slice(0,10);
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
    return Math.round((new Date(`${right}T00:00:00Z`)-new Date(`${left}T00:00:00Z`))/864e5);
  }
  // A window is available only when its exact D-N baseline was observed.
  // Missing days are never interpolated and never converted to zero.
  function counterWindow(raw,days){
    const points=normalizeCounterHistory(raw);
    const empty={days,current:null,previous:null,change:null,pct:null,currentReady:false,comparisonReady:false,points:points.length};
    if(!points.length)return empty;
    const latest=points[points.length-1];
    const byDay=new Map(points);
    const baselineDay=shiftDay(latest[0],-days);
    const comparisonDay=shiftDay(latest[0],-2*days);
    const baseline=byDay.get(baselineDay);
    if(baseline==null)return Object.assign(empty,{latestDate:latest[0],baselineDay});
    const current=latest[1]-baseline;
    if(!byDay.has(comparisonDay))return Object.assign(empty,{
      latestDate:latest[0],baselineDay,comparisonDay,current,currentReady:true,
    });
    const previous=baseline-byDay.get(comparisonDay);
    const change=current-previous;
    return {
      days,current,previous,change,pct:previous!==0?change/Math.abs(previous)*100:null,
      currentReady:true,comparisonReady:true,points:points.length,
      latestDate:latest[0],baselineDay,comparisonDay,
    };
  }
  function dailyChanges(raw){
    const points=normalizeCounterHistory(raw),changes=[];
    for(let index=1;index<points.length;index+=1){
      if(dayGap(points[index-1][0],points[index][0])!==1)continue;
      changes.push([points[index][0],points[index][1]-points[index-1][1]]);
    }
    return changes;
  }
  function recentPoints(points,period){
    const normalized=normalizeCounterHistory(points);
    if(!normalized.length||period==='all')return normalized;
    const threshold=shiftDay(normalized[normalized.length-1][0],-(Number(period)-1));
    return normalized.filter(point=>point[0]>=threshold);
  }
  function ensureStyle(version){
    if(!doc||doc.getElementById('spotify-playlist-analytics-style'))return;
    const link=doc.createElement('link');
    link.id='spotify-playlist-analytics-style';link.rel='stylesheet';
    link.href=`playlist-analytics.css?v=${encodeURIComponent(version)}`;
    doc.head.appendChild(link);
  }
  function loadDataset(){
    if(global.SPOTIFY_PLAYLIST_ANALYTICS)return Promise.resolve(global.SPOTIFY_PLAYLIST_ANALYTICS);
    if(datasetPromise)return datasetPromise;
    datasetPromise=new Promise((resolve,reject)=>{
      const script=doc.createElement('script');
      script.id='spotify-playlist-analytics-data';
      // A unique URL prevents yesterday's daily snapshot from surviving in a
      // long browser cache. The payload is still loaded only once per page.
      script.src=`../Spotify_Playlist_Analytics_data.js?analytics=${Date.now()}`;
      script.async=true;
      script.onload=()=>global.SPOTIFY_PLAYLIST_ANALYTICS?resolve(global.SPOTIFY_PLAYLIST_ANALYTICS):reject(new Error('Playlist analytics payload did not initialize'));
      script.onerror=()=>reject(new Error('Playlist analytics payload failed to load'));
      doc.head.appendChild(script);
    }).catch(error=>{datasetPromise=null;throw error;});
    return datasetPromise;
  }
  function chartSegments(points){
    const segments=[];
    for(const point of points){
      const current=segments[segments.length-1];
      if(!current||dayGap(current[current.length-1][0],point[0])!==1)segments.push([point]);
      else current.push(point);
    }
    return segments;
  }
  function chartHtml(raw,period,language){
    const points=recentPoints(raw,period);
    if(points.length<2)return `<div class="playlist-analytics-empty">${esc(tr(language,'Historique quotidien insuffisant pour tracer la courbe.','Not enough daily history to draw the chart.'))}</div>`;
    const width=720,height=210,padX=16,padY=14;
    const values=points.map(point=>point[1]);
    const minimum=Math.min(...values),maximum=Math.max(...values),span=Math.max(1,maximum-minimum);
    const x=index=>padX+(width-padX*2)*(points.length===1?0:index/(points.length-1));
    const y=amount=>padY+(height-padY*2)*(1-(amount-minimum)/span);
    const positioned=points.map((point,index)=>[point[0],point[1],x(index),y(point[1])]);
    const positionsByDay=new Map(positioned.map(point=>[point[0],point]));
    const lines=chartSegments(points).map(segment=>{
      const positionedSegment=segment.map(point=>positionsByDay.get(point[0]));
      if(positionedSegment.length<2)return '';
      const line=positionedSegment.map((point,index)=>`${index?'L':'M'} ${point[2].toFixed(2)} ${point[3].toFixed(2)}`).join(' ');
      const first=positionedSegment[0],last=positionedSegment[positionedSegment.length-1];
      const area=`${line} L ${last[2].toFixed(2)} ${(height-padY).toFixed(2)} L ${first[2].toFixed(2)} ${(height-padY).toFixed(2)} Z`;
      return `<path class="playlist-chart-area" d="${area}"/><path class="playlist-chart-line" d="${line}"/>`;
    }).join('');
    const dots=positioned.map(point=>`<circle class="playlist-chart-point" cx="${point[2].toFixed(2)}" cy="${point[3].toFixed(2)}" r="3.25" data-chart-x="${point[2].toFixed(2)}" data-chart-y="${point[3].toFixed(2)}" data-chart-date="${esc(point[0])}" data-chart-value="${esc(formatNumber(point[1],language))}"/>`).join('');
    const middle=Math.floor((points.length-1)/2);
    const xLabels=[points[0][0],points[middle][0],points[points.length-1][0]];
    const yLabels=maximum===minimum?['',formatNumber(maximum,language),'']:[formatNumber(maximum,language),formatNumber((minimum+maximum)/2,language),formatNumber(minimum,language)];
    return `<div class="playlist-chart-wrap"><div class="playlist-chart-grid"><div class="playlist-chart-y">${yLabels.map(label=>`<span>${esc(label)}</span>`).join('')}</div><div class="playlist-chart-plot"><svg class="playlist-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tr(language,'Historique observé des followers','Observed follower history'))}"><g class="playlist-chart-guides"><line x1="${padX}" y1="${padY}" x2="${width-padX}" y2="${padY}"/><line x1="${padX}" y1="${height/2}" x2="${width-padX}" y2="${height/2}"/><line x1="${padX}" y1="${height-padY}" x2="${width-padX}" y2="${height-padY}"/></g>${lines}${dots}</svg><span class="playlist-chart-guide" hidden></span><span class="playlist-chart-marker" hidden></span><span class="playlist-chart-tooltip" hidden></span></div><div class="playlist-chart-x">${xLabels.map(day=>`<span>${esc(formatDate(day,language,false))}</span>`).join('')}</div></div></div>`;
  }
  function deltaClass(number){return number>0?'positive':number<0?'negative':'neutral';}
  function deltaCard(label,window,language){
    if(!window.currentReady)return `<div class="playlist-kpi" data-playlist-window="${window.days}"><span>${esc(label)}</span><strong>—</strong><small>${esc(tr(language,'Baseline exacte indisponible','Exact baseline unavailable'))}</small></div>`;
    const comparison=window.comparisonReady
      ?`${tr(language,'vs période précédente','vs previous period')} ${formatPercent(window.pct,language)}`
      :tr(language,'Comparaison précédente indisponible','Previous comparison unavailable');
    return `<div class="playlist-kpi ${deltaClass(window.current)}" data-playlist-window="${window.days}"><span>${esc(label)}</span><strong>${esc(formatSigned(window.current,language))}</strong><small>${esc(comparison)}</small></div>`;
  }
  function detailCard(label,content){
    return `<div class="tg"><div class="l">${esc(label)}</div><div class="v playlist-detail-value">${esc(content||'—')}</div></div>`;
  }
  function curatorLabel(category,language){
    if(category==='editorial')return tr(language,'Éditoriale','Editorial');
    if(category==='independent')return tr(language,'Indépendante','Independent');
    return tr(language,'Non déterminé','Undetermined');
  }
  function scanStatusHtml(status,language){
    status=status&&typeof status==='object'?status:{};
    const expected=finite(status.expected),updated=finite(status.updated);
    const complete=status.complete===true&&expected!=null&&updated===expected;
    const label=complete
      ?tr(language,'Scan quotidien complet','Daily scan complete')
      :tr(language,'Scan quotidien incomplet','Daily scan incomplete');
    const counts=expected!=null&&updated!=null?` · ${formatNumber(updated,language)}/${formatNumber(expected,language)}`:'';
    const day=status.day?` · ${formatDate(status.day,language)}`:'';
    return `<div class="playlist-scan-status ${complete?'complete':'incomplete'}"><i></i><span>${esc(label+counts+day)}</span></div>`;
  }
  function bindChart(root,language){
    const svg=root.querySelector('.playlist-chart');
    if(!svg)return;
    const points=[...svg.querySelectorAll('.playlist-chart-point')];
    const plot=svg.closest('.playlist-chart-plot');
    const marker=plot.querySelector('.playlist-chart-marker');
    const guide=plot.querySelector('.playlist-chart-guide');
    const tooltip=plot.querySelector('.playlist-chart-tooltip');
    const hide=()=>{marker.hidden=true;guide.hidden=true;tooltip.hidden=true;};
    const move=event=>{
      if(!points.length)return;
      const rect=svg.getBoundingClientRect();
      const target=(event.clientX-rect.left)/Math.max(1,rect.width)*720;
      const point=points.reduce((best,candidate)=>Math.abs(Number(candidate.dataset.chartX)-target)<Math.abs(Number(best.dataset.chartX)-target)?candidate:best,points[0]);
      const left=Number(point.dataset.chartX)/720*100,top=Number(point.dataset.chartY)/210*100;
      marker.style.left=`${left}%`;marker.style.top=`${top}%`;marker.hidden=false;
      guide.style.left=`${left}%`;guide.hidden=false;
      tooltip.style.left=`${Math.max(13,Math.min(87,left))}%`;tooltip.style.top=`${Math.max(6,top-4)}%`;
      tooltip.textContent=`${formatDate(point.dataset.chartDate,language)} · ${point.dataset.chartValue}`;tooltip.hidden=false;
    };
    svg.addEventListener('pointermove',move);
    svg.addEventListener('pointerleave',hide);
  }
  function render(context){
    const {dataset,spotifyId,language,box}=context;
    const index=schemaIndex(dataset.cols);
    const row=(Array.isArray(dataset.rows)?dataset.rows:[]).find(item=>String(value(item,index,'id'))===spotifyId);
    if(!row)throw new Error('Playlist is missing from the canonical analytics payload');
    const history=normalizeCounterHistory(dataset.hist&&dataset.hist[spotifyId]);
    const lastSeen=String(value(row,index,'last_seen')||'').slice(0,10);
    const followers=finite(value(row,index,'followers'));
    const normalized=normalizeCounterHistory(history);
    const windows={1:counterWindow(normalized,1),7:counterWindow(normalized,7),30:counterWindow(normalized,30)};
    const changes=dailyChanges(normalized).slice(-7).reverse();
    const title=String(value(row,index,'name')||tr(language,'Playlist sans titre','Untitled playlist'));
    const owner=String(value(row,index,'owner')||tr(language,'Curateur non renseigné','Unknown curator'));
    const category=String(value(row,index,'curatorCat')||'');
    const artwork=safeImage(value(row,index,'image_url'));
    const cover=artwork?`<span class="tcov playlist-cover"><img src="${esc(artwork)}" alt="" loading="lazy"></span>`:'<span class="tcov playlist-cover playlist-cover-fallback" aria-hidden="true">♫</span>';
    const periodButtons=[[7,'7 j','7 d'],[30,'30 j','30 d'],['all','Tout','All']].map(([period,fr,en])=>`<button type="button" data-playlist-period="${period}" class="${String(state.period)===String(period)?'on':''}">${esc(tr(language,fr,en))}</button>`).join('');
    box.innerHTML=`<div class="thd">${cover}<div class="playlist-analytics-title"><span class="fast-kicker">${esc(tr(language,'Fiche Analytics','Analytics'))}</span><h3>${esc(title)}</h3><div class="tar playlist-analytics-owner">${esc(owner)} <span class="playlist-curator-badge ${esc(category)}">${esc(curatorLabel(category,language))}</span></div></div><button class="tclose" type="button" data-close-modal aria-label="${esc(tr(language,'Fermer','Close'))}">✕</button></div>${scanStatusHtml(dataset.status,language)}<section class="playlist-kpis" data-playlist-performance aria-label="${esc(tr(language,'Évolution des followers','Follower growth'))}"><div class="playlist-kpi total"><span>${esc(tr(language,'Followers actuels','Current followers'))}</span><strong>${esc(formatNumber(followers,language))}</strong><small>${esc(formatDate(lastSeen,language))}</small></div>${deltaCard(tr(language,'24 heures','24 hours'),windows[1],language)}${deltaCard(tr(language,'7 jours','7 days'),windows[7],language)}${deltaCard(tr(language,'30 jours','30 days'),windows[30],language)}</section><section class="analytics-section playlist-history-section"><h4><span>${esc(tr(language,'Historique quotidien des followers','Daily follower history'))}</span><span class="playlist-periods" role="group" aria-label="${esc(tr(language,'Période du graphique','Chart period'))}">${periodButtons}</span></h4><div data-playlist-chart>${chartHtml(normalized,state.period,language)}</div></section><div class="tgrid playlist-analytics-facts">${detailCard(tr(language,'Pistes','Tracks'),formatNumber(value(row,index,'tracks'),language))}${detailCard(tr(language,'Genre','Genre'),value(row,index,'genre'))}${detailCard(tr(language,'Usage','Use'),value(row,index,'use_case'))}${detailCard('Fit score',formatNumber(value(row,index,'fit'),language))}${detailCard(tr(language,'Première observation','First observed'),formatDate(value(row,index,'first_seen'),language))}${detailCard(tr(language,'Dernière observation','Last observed'),formatDate(lastSeen,language))}${detailCard(tr(language,'Création estimée','Estimated creation'),formatDate(value(row,index,'estDate'),language))}${detailCard(tr(language,'Confiance estimation','Estimate confidence'),value(row,index,'estConf'))}</div><section class="analytics-section playlist-variations" data-playlist-variations><h4>${esc(tr(language,'Derniers mouvements quotidiens','Latest daily movements'))}</h4>${changes.length?`<div class="playlist-change-list">${changes.map(change=>`<div><span>${esc(formatDate(change[0],language))}</span><strong class="${deltaClass(change[1])}">${esc(formatSigned(change[1],language))}</strong></div>`).join('')}</div>`:`<div class="playlist-analytics-empty compact">${esc(tr(language,'Historique consécutif insuffisant.','Not enough consecutive history.'))}</div>`}</section><div class="fast-modal-actions playlist-analytics-actions"><a href="https://open.spotify.com/playlist/${encodeURIComponent(spotifyId)}" target="_blank" rel="noopener">${esc(tr(language,'Ouvrir sur Spotify ↗','Open on Spotify ↗'))}</a></div><div class="tnote">${esc(tr(language,"Les variations utilisent uniquement les snapshots quotidiens réellement observés. Les dates manquantes restent des ruptures et ne sont jamais interpolées.",'Changes use observed daily snapshots only. Missing dates remain gaps and are never interpolated.'))}</div>`;
    bindChart(box,language);
  }
  function bindInteractions(context){
    const controller=typeof AbortController==='function'?new AbortController():null;
    const options=controller?{signal:controller.signal}:undefined;
    const click=event=>{
      const period=event.target.closest('[data-playlist-period]');
      if(!period)return;
      state.period=period.dataset.playlistPeriod==='all'?'all':Number(period.dataset.playlistPeriod);
      render(context);
    };
    context.box.addEventListener('click',click,options);
    activeCleanup=()=>{
      if(controller)controller.abort();
      else context.box.removeEventListener('click',click);
    };
  }
  async function open(options={}){
    if(!doc)throw new Error('Playlist analytics requires a document');
    const request=++activeRequest;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
    const spotifyId=validSpotifyId(options.spotifyId);
    if(!spotifyId)throw new Error('Invalid Spotify playlist identifier');
    const box=options.box||doc.getElementById('tmbox');
    if(!box)throw new Error('Playlist analytics modal body is missing');
    const language=options.language==='en'?'en':'fr';
    ensureStyle(options.assetVersion||'playlist-analytics-v1');
    const dataset=await loadDataset();
    if(request!==activeRequest)return false;
    const context={dataset,spotifyId,language,box};
    box.classList.add('playlist-analytics-box');
    render(context);
    bindInteractions(context);
    return true;
  }
  function close(){
    activeRequest+=1;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
  }

  const api={open,close};
  global.SpotifyPlaylistAnalytics=api;
  if(typeof module!=='undefined'&&module.exports){
    module.exports={...api,__test:{normalizeCounterHistory,counterWindow,dailyChanges,recentPoints,chartSegments}};
  }
})(typeof window!=='undefined'?window:globalThis);
