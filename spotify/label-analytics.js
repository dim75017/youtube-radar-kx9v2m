'use strict';

/* Lazy label analytics for the lightweight Spotify Radar. The dedicated
   payload contains exact aggregate windows only; track metadata comes from
   the already hydrated public catalogue. */
(function spotifyLabelAnalyticsModule(global){
  const doc=global&&global.document;
  const state={mode:'streams',period:30,artist:'all',sort:'streams'};
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
  const tr=(language,fr,en)=>language==='en'?en:fr;
  const locale=language=>language==='en'?'en-GB':'fr-FR';
  const schemaIndex=fields=>Object.fromEntries((Array.isArray(fields)?fields:[]).map((field,index)=>[field,index]));
  const value=(row,index,name)=>Array.isArray(row)&&Number.isInteger(index[name])?row[index[name]]:null;
  const LICENSE_RE=/(?:under\s+(?:an?\s+)?|on\s+)?exclusive\s+licen[cs]e\s+(?:to|with|from)\s+(.+?)(?:\s*[;.]|$)/i;
  const LICENSED_TO_RE=/licen[cs]ed\s+to\s+(.+?)(?:\s*[;.]|$)/i;
  const YEAR_STRIP_RE=/^[©℗()pcPC\s]*\d{4}\s*/;

  function labelDisplayName(input){
    const raw=String(input||'').trim();
    if(!raw)return '';
    const match=LICENSE_RE.exec(raw)||LICENSED_TO_RE.exec(raw);
    const extracted=match
      ?match[1].trim().replace(/\.$/,'')
      :raw.split(';')[0].trim().replace(YEAR_STRIP_RE,'').trim();
    return extracted.replace(/\s*,\s*(?:an?\s+)?division\s+of\b.*$/i,'').replace(/[.,]+$/,'').trim();
  }
  function labelKeyOf(input){
    const name=labelDisplayName(input);
    return name?name.toLowerCase().normalize('NFKD').replace(/(?![\uFE00-\uFE0F])\p{M}/gu,'').replace(/\s+/g,' ').trim():'';
  }
  function safeImage(input){
    const url=String(input||'').trim();
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/i.test(url)?url:'';
  }
  function formatNumber(input,language,compact=false){
    const number=finite(input);
    if(number==null)return '—';
    return new Intl.NumberFormat(locale(language),compact?{
      notation:'compact',maximumFractionDigits:Math.abs(number)>=1e6?1:0,
    }:{maximumFractionDigits:0}).format(Math.round(number));
  }
  function formatSigned(input,language,compact=false){
    const number=finite(input);
    return number==null?'—':`${number>0?'+':''}${formatNumber(number,language,compact)}`;
  }
  function formatPercent(input,language){
    const number=finite(input);
    if(number==null)return '';
    return `${number>0?'+':''}${new Intl.NumberFormat(locale(language),{maximumFractionDigits:1}).format(number)} %`;
  }
  function formatMoney(input,language){
    const number=finite(input);
    if(number==null)return '—';
    return new Intl.NumberFormat(locale(language),{
      style:'currency',currency:'EUR',maximumFractionDigits:Math.abs(number)<100?2:0,
    }).format(number);
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
  function dayGap(left,right){
    return Math.round((new Date(`${right}T00:00:00Z`)-new Date(`${left}T00:00:00Z`))/86_400_000);
  }
  function metric(input,context,{signed=false,compact=false}={}){
    const number=finite(input);
    if(number==null)return '—';
    if(state.mode==='revenue'){
      const amount=number*context.rate;
      const formatted=formatMoney(amount,context.language);
      return signed&&amount>0?`+${formatted}`:formatted;
    }
    return signed?formatSigned(number,context.language,compact):formatNumber(number,context.language,compact);
  }
  function shiftDay(day,offset){
    const parsed=new Date(`${day}T00:00:00Z`);
    if(!Number.isFinite(parsed.getTime()))return '';
    parsed.setUTCDate(parsed.getUTCDate()+offset);
    return parsed.toISOString().slice(0,10);
  }
  function recentDaily(points,period){
    const normalized=(Array.isArray(points)?points:[]).filter(point=>Array.isArray(point)&&/^\d{4}-\d{2}-\d{2}$/.test(String(point[0]))&&finite(point[1])!=null);
    if(!normalized.length||period==='all')return normalized;
    const threshold=shiftDay(String(normalized[normalized.length-1][0]),-(Number(period)-1));
    return normalized.filter(point=>String(point[0])>=threshold);
  }
  function chartSegments(points){
    const segments=[];
    for(const point of points){
      const last=segments.length?segments[segments.length-1]:null;
      if(!last||dayGap(String(last[last.length-1][0]),String(point[0]))!==1)segments.push([point]);
      else last.push(point);
    }
    return segments;
  }
  function ensureStyle(version){
    if(!doc||doc.getElementById('spotify-label-analytics-style'))return;
    const link=doc.createElement('link');
    link.id='spotify-label-analytics-style';link.rel='stylesheet';
    link.href=`label-analytics.css?v=${encodeURIComponent(version)}`;
    doc.head.appendChild(link);
  }
  function loadDataset(){
    if(global.SPOTIFY_LABEL_ANALYTICS)return Promise.resolve(global.SPOTIFY_LABEL_ANALYTICS);
    if(datasetPromise)return datasetPromise;
    datasetPromise=new Promise((resolve,reject)=>{
      const script=doc.createElement('script');
      script.id='spotify-label-analytics-data';
      script.src=`../Spotify_Label_Analytics_data.js?analytics=${Date.now()}`;
      script.async=true;
      script.onload=()=>global.SPOTIFY_LABEL_ANALYTICS?resolve(global.SPOTIFY_LABEL_ANALYTICS):reject(new Error('Label analytics payload did not initialize'));
      script.onerror=()=>reject(new Error('Label analytics payload failed to load'));
      doc.head.appendChild(script);
    }).catch(error=>{datasetPromise=null;throw error;});
    return datasetPromise;
  }
  function resolveGroupKey(dataset,labelRow,labelIndex){
    const rawKey=String(value(labelRow,labelIndex,'key')||'').trim();
    const name=String(value(labelRow,labelIndex,'name')||'').trim();
    const aliases=dataset.aliases&&typeof dataset.aliases==='object'?dataset.aliases:{};
    const groups=dataset.groups&&typeof dataset.groups==='object'?dataset.groups:{};
    for(const candidate of [rawKey,aliases[rawKey],labelKeyOf(rawKey),labelKeyOf(name)]){
      if(candidate&&groups[candidate])return candidate;
      if(candidate&&aliases[candidate]&&groups[aliases[candidate]])return aliases[candidate];
    }
    return labelKeyOf(rawKey)||labelKeyOf(name);
  }
  function trackGroupKey(row,index){
    return labelKeyOf(value(row,index,'label')||value(row,index,'copyright'));
  }
  function windowObject(raw,index){
    return {
      current:finite(value(raw,index,'current')),
      previous:finite(value(raw,index,'previous')),
      comparisonCurrent:finite(value(raw,index,'comparison_current')),
      change:finite(value(raw,index,'change')),
      pct:finite(value(raw,index,'pct')),
      currentCount:finite(value(raw,index,'current_count'))||0,
      comparisonCount:finite(value(raw,index,'comparison_count'))||0,
      total:finite(value(raw,index,'total'))||0,
    };
  }
  function deltaClass(number){return number>0?'positive':number<0?'negative':'neutral';}
  function performanceCard(label,window,context){
    const ready=window.current!=null;
    const comparison=window.comparisonCurrent!=null&&window.previous!=null;
    const coverage=window.total?`${formatNumber(window.currentCount,context.language)}/${formatNumber(window.total,context.language)} ${tr(context.language,'pistes mesurées','tracks measured')}`:tr(context.language,'Aucune piste mesurée','No measured track');
    const trend=comparison?`${tr(context.language,'vs période précédente','vs previous period')} ${formatPercent(window.pct,context.language)}`:tr(context.language,'Comparaison exacte indisponible','Exact comparison unavailable');
    return `<article class="label-kpi ${ready?deltaClass(window.current):'neutral'}"><span>${esc(label)}</span><strong>${esc(ready?metric(window.current,context,{signed:true,compact:true}):'—')}</strong><small>${esc(ready?trend:tr(context.language,'Baseline exacte indisponible','Exact baseline unavailable'))}</small><em>${esc(coverage)}</em></article>`;
  }
  function chartHtml(raw,context){
    const points=recentDaily(raw,state.period).map(point=>[
      String(point[0]),state.mode==='revenue'?Number(point[1])*context.rate:Number(point[1]),Number(point[2])||0,
    ]);
    if(points.length<2)return `<div class="label-analytics-empty">${esc(tr(context.language,'Historique quotidien insuffisant pour tracer la courbe.','Not enough daily history to draw the chart.'))}</div>`;
    const width=760,height=228,padX=18,padY=16;
    const values=points.map(point=>point[1]);
    const minimum=Math.min(0,...values),maximum=Math.max(0,...values),span=Math.max(1,maximum-minimum);
    const x=index=>padX+(width-padX*2)*(points.length===1?0:index/(points.length-1));
    const y=amount=>padY+(height-padY*2)*(1-(amount-minimum)/span);
    const positioned=points.map((point,index)=>[...point,x(index),y(point[1])]);
    const byDay=new Map(positioned.map(point=>[point[0],point]));
    const paths=chartSegments(points).map(segment=>{
      const segmentPoints=segment.map(point=>byDay.get(point[0]));
      if(segmentPoints.length<2)return '';
      const line=segmentPoints.map((point,index)=>`${index?'L':'M'} ${point[3].toFixed(2)} ${point[4].toFixed(2)}`).join(' ');
      const first=segmentPoints[0],last=segmentPoints[segmentPoints.length-1],zero=y(0);
      const area=`${line} L ${last[3].toFixed(2)} ${zero.toFixed(2)} L ${first[3].toFixed(2)} ${zero.toFixed(2)} Z`;
      return `<path class="label-chart-area" d="${area}"/><path class="label-chart-line" d="${line}"/>`;
    }).join('');
    const dots=positioned.map(point=>`<circle class="label-chart-point" cx="${point[3].toFixed(2)}" cy="${point[4].toFixed(2)}" r="3" data-chart-x="${point[3].toFixed(2)}" data-chart-y="${point[4].toFixed(2)}" data-chart-date="${esc(point[0])}" data-chart-value="${esc(state.mode==='revenue'?formatMoney(point[1],context.language):formatSigned(point[1],context.language))}" data-chart-coverage="${esc(`${point[2]}/${context.totalTracks}`)}"/>`).join('');
    const middle=Math.floor((points.length-1)/2);
    const xLabels=[points[0][0],points[middle][0],points[points.length-1][0]];
    const yLabels=[maximum,(maximum+minimum)/2,minimum].map(number=>state.mode==='revenue'?formatMoney(number,context.language):formatNumber(number,context.language,true));
    return `<div class="label-chart-grid"><div class="label-chart-y">${yLabels.map(label=>`<span>${esc(label)}</span>`).join('')}</div><div class="label-chart-plot"><svg class="label-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tr(context.language,'Gains quotidiens observés','Observed daily gains'))}"><g class="label-chart-guides"><line x1="${padX}" y1="${padY}" x2="${width-padX}" y2="${padY}"/><line x1="${padX}" y1="${height/2}" x2="${width-padX}" y2="${height/2}"/><line x1="${padX}" y1="${height-padY}" x2="${width-padX}" y2="${height-padY}"/></g><line class="label-chart-zero" x1="${padX}" y1="${y(0).toFixed(2)}" x2="${width-padX}" y2="${y(0).toFixed(2)}"/>${paths}${dots}</svg><span class="label-chart-guide" hidden></span><span class="label-chart-marker" hidden></span><span class="label-chart-tooltip" hidden></span></div><div class="label-chart-x">${xLabels.map(day=>`<span>${esc(formatDate(day,context.language,false))}</span>`).join('')}</div></div>`;
  }
  function compositionHtml(rows,index,context){
    const artists=new Map(),genres=new Map();
    for(const row of rows){
      const artist=String(value(row,index,'credit_name')||tr(context.language,'Artiste non renseigné','Unknown artist')).trim();
      const genre=String(value(row,index,'genre')||tr(context.language,'Non classé','Unclassified')).replaceAll('_',' ');
      const streams=Math.max(0,finite(value(row,index,'streams'))||0);
      const artistEntry=artists.get(artist)||{tracks:0,streams:0};
      artistEntry.tracks+=1;artistEntry.streams+=streams;artists.set(artist,artistEntry);
      const genreEntry=genres.get(genre)||{tracks:0,streams:0};
      genreEntry.tracks+=1;genreEntry.streams+=streams;genres.set(genre,genreEntry);
    }
    const topArtists=[...artists.entries()].sort((a,b)=>b[1].streams-a[1].streams).slice(0,6);
    const topGenres=[...genres.entries()].sort((a,b)=>b[1].tracks-a[1].tracks||b[1].streams-a[1].streams).slice(0,6);
    const bars=(items,kind)=>{
      const maximum=Math.max(1,...items.map(item=>kind==='artist'?item[1].streams:item[1].tracks));
      return items.map(([name,entry])=>{
        const measure=kind==='artist'?entry.streams:entry.tracks;
        const label=kind==='artist'?metric(entry.streams,context,{compact:true}):`${formatNumber(entry.tracks,context.language)} ${tr(context.language,'pistes','tracks')}`;
        return `<div class="label-composition-row"><span>${esc(name)}</span><i><b style="width:${Math.max(2,measure/maximum*100).toFixed(2)}%"></b></i><strong>${esc(label)}</strong></div>`;
      }).join('');
    };
    return `<div class="label-composition"><section><h4>${esc(tr(context.language,'Artistes principaux','Top artists'))}</h4>${topArtists.length?bars(topArtists,'artist'):`<div class="label-analytics-empty compact">—</div>`}</section><section><h4>${esc(tr(context.language,'Genres du catalogue','Catalogue genres'))}</h4>${topGenres.length?bars(topGenres,'genre'):`<div class="label-analytics-empty compact">—</div>`}</section></div>`;
  }
  function trackTable(rows,index,context){
    const trackWindows=context.dataset.track_windows&&typeof context.dataset.track_windows==='object'?context.dataset.track_windows:{};
    const artistRows=new Map();
    for(const row of rows){
      const artist=String(value(row,index,'credit_name')||tr(context.language,'Artiste non renseigné','Unknown artist')).trim();
      const entry=artistRows.get(artist)||{tracks:0,streams:0};
      entry.tracks+=1;entry.streams+=Math.max(0,finite(value(row,index,'streams'))||0);artistRows.set(artist,entry);
    }
    const artistOptions=[...artistRows.entries()].sort((a,b)=>b[1].streams-a[1].streams||a[0].localeCompare(b[0]));
    const filtered=state.artist==='all'?rows:rows.filter(row=>String(value(row,index,'credit_name')||'').trim()===state.artist);
    const metricOf=(row,windowIndex)=>{
      const spotifyId=String(value(row,index,'spotify_id')||'');
      const windows=trackWindows[spotifyId];
      return Array.isArray(windows)?finite(windows[windowIndex]):null;
    };
    const sorted=filtered.slice().sort((left,right)=>{
      if(state.sort==='newest')return String(value(right,index,'release_date')||'').localeCompare(String(value(left,index,'release_date')||''));
      const positions={day:0,week:1,month:2};
      if(Object.prototype.hasOwnProperty.call(positions,state.sort))return (metricOf(right,positions[state.sort])??-Infinity)-(metricOf(left,positions[state.sort])??-Infinity);
      return (finite(value(right,index,'streams'))||0)-(finite(value(left,index,'streams'))||0);
    });
    const body=sorted.slice(0,100).map(row=>{
      const id=String(value(row,index,'spotify_id')||'');
      const image=safeImage(value(row,index,'image_url'));
      return `<tr><td>${image?`<img src="${esc(image)}" alt="" loading="lazy" decoding="async">`:'<span aria-hidden="true">♫</span>'}</td><td><button type="button" class="fast-primary" data-label-track="${esc(id)}">${esc(value(row,index,'title')||'—')}</button><small>${esc(value(row,index,'credit_name')||'—')}</small></td><td class="num"><strong>${esc(metric(value(row,index,'streams'),context,{compact:true}))}</strong></td><td class="num">${esc(metric(metricOf(row,2),context,{signed:true,compact:true}))}</td><td class="num">${esc(metric(metricOf(row,1),context,{signed:true,compact:true}))}</td><td class="num">${esc(metric(metricOf(row,0),context,{signed:true,compact:true}))}</td><td>${esc(formatDate(value(row,index,'release_date'),context.language))}</td></tr>`;
    }).join('');
    const more=sorted.length>100?`<p class="label-table-note">${esc(tr(context.language,`100 premières pistes sur ${formatNumber(sorted.length,context.language)}.`,`First 100 of ${formatNumber(sorted.length,context.language)} tracks.`))}</p>`:'';
    return `<section class="label-track-section"><header><h4>${esc(tr(context.language,'Performance par piste','Track performance'))}</h4><div class="label-track-controls"><select data-label-artist aria-label="${esc(tr(context.language,'Filtrer par artiste','Filter by artist'))}"><option value="all">${esc(tr(context.language,'Tous les artistes','All artists'))} (${formatNumber(rows.length,context.language)})</option>${artistOptions.map(([artist,entry])=>`<option value="${esc(artist)}" ${state.artist===artist?'selected':''}>${esc(artist)} · ${formatNumber(entry.tracks,context.language)}</option>`).join('')}</select><select data-label-sort aria-label="${esc(tr(context.language,'Trier les pistes','Sort tracks'))}"><option value="streams" ${state.sort==='streams'?'selected':''}>${esc(tr(context.language,'Streams total','Total streams'))}</option><option value="month" ${state.sort==='month'?'selected':''}>30 ${esc(tr(context.language,'jours','days'))}</option><option value="week" ${state.sort==='week'?'selected':''}>7 ${esc(tr(context.language,'jours','days'))}</option><option value="day" ${state.sort==='day'?'selected':''}>24 h</option><option value="newest" ${state.sort==='newest'?'selected':''}>${esc(tr(context.language,'Sorties récentes','Recent releases'))}</option></select></div></header>${sorted.length?`<div class="label-track-table-wrap"><table class="label-track-table"><thead><tr><th></th><th>${esc(tr(context.language,'Piste','Track'))}</th><th class="num">${esc(state.mode==='revenue'?tr(context.language,'Revenus total','Total revenue'):tr(context.language,'Streams total','Total streams'))}</th><th class="num">30 j</th><th class="num">7 j</th><th class="num">24 h</th><th>${esc(tr(context.language,'Sortie','Release'))}</th></tr></thead><tbody>${body}</tbody></table></div>${more}`:`<div class="label-analytics-empty">${esc(tr(context.language,'Aucune piste pour ce filtre.','No track matches this filter.'))}</div>`}</section>`;
  }
  function bindChart(root,context){
    const svg=root.querySelector('.label-chart');
    if(!svg)return;
    const points=[...svg.querySelectorAll('.label-chart-point')],plot=svg.closest('.label-chart-plot');
    const marker=plot.querySelector('.label-chart-marker'),guide=plot.querySelector('.label-chart-guide'),tooltip=plot.querySelector('.label-chart-tooltip');
    const hide=()=>{marker.hidden=true;guide.hidden=true;tooltip.hidden=true;};
    const move=event=>{
      if(!points.length)return;
      const rect=svg.getBoundingClientRect(),target=(event.clientX-rect.left)/Math.max(1,rect.width)*760;
      const point=points.reduce((best,candidate)=>Math.abs(Number(candidate.dataset.chartX)-target)<Math.abs(Number(best.dataset.chartX)-target)?candidate:best,points[0]);
      const left=Number(point.dataset.chartX)/760*100,top=Number(point.dataset.chartY)/228*100;
      marker.style.left=`${left}%`;marker.style.top=`${top}%`;marker.hidden=false;
      guide.style.left=`${left}%`;guide.hidden=false;
      tooltip.style.left=`${Math.max(14,Math.min(86,left))}%`;tooltip.style.top=`${Math.max(5,top-5)}%`;
      tooltip.textContent=`${formatDate(point.dataset.chartDate,context.language)} · ${point.dataset.chartValue} · ${point.dataset.chartCoverage} ${tr(context.language,'pistes','tracks')}`;tooltip.hidden=false;
    };
    svg.addEventListener('pointermove',move);svg.addEventListener('pointerleave',hide);
  }
  function render(context){
    const {dataset,labelRow,labelIndex,trackIndex,box,language}=context;
    const groupIndex=schemaIndex(dataset.group_schema),windowIndex=schemaIndex(dataset.window_schema);
    const group=dataset.groups&&dataset.groups[context.groupKey];
    const allTracks=context.tracks.filter(row=>trackGroupKey(row,trackIndex)===context.groupKey);
    context.totalTracks=allTracks.length;
    const name=String(value(labelRow,labelIndex,'name')||value(group,groupIndex,'name')||context.groupKey||'—');
    const logo=safeImage(value(labelRow,labelIndex,'logo'));
    const email=String(value(labelRow,labelIndex,'email')||'').trim();
    const cover=logo?`<span class="label-analytics-logo"><img src="${esc(logo)}" alt="" loading="lazy"></span>`:`<span class="label-analytics-logo fallback" aria-hidden="true">${esc((name[0]||'?').toUpperCase())}</span>`;
    const totalStreams=finite(value(group,groupIndex,'streams'))??allTracks.reduce((sum,row)=>sum+Math.max(0,finite(value(row,trackIndex,'streams'))||0),0);
    const totalArtists=finite(value(group,groupIndex,'artists'))??new Set(allTracks.map(row=>String(value(row,trackIndex,'credit_name')||'').trim()).filter(Boolean)).size;
    const since=value(group,groupIndex,'since')||value(labelRow,labelIndex,'since');
    const windows={
      1:windowObject(value(group,groupIndex,'window_1d'),windowIndex),
      7:windowObject(value(group,groupIndex,'window_7d'),windowIndex),
      30:windowObject(value(group,groupIndex,'window_30d'),windowIndex),
    };
    const periods=[[30,'30 j','30 d'],[90,'90 j','90 d'],['all','Tout','All']].map(([period,fr,en])=>`<button type="button" data-label-period="${period}" class="${String(state.period)===String(period)?'on':''}">${esc(tr(language,fr,en))}</button>`).join('');
    const dataDay=dataset.data_through?`${tr(language,'Données mesurées au','Measured through')} ${formatDate(dataset.data_through,language)}`:tr(language,'Historique de performance indisponible','Performance history unavailable');
    box.innerHTML=`<div class="thd label-analytics-head">${cover}<div><span class="fast-kicker">${esc(tr(language,'Fiche Analytics','Analytics'))}</span><h3>${esc(name)}</h3><p>${formatNumber(allTracks.length,language)} ${esc(tr(language,'pistes actives','active tracks'))} · ${formatNumber(totalArtists,language)} ${esc(tr(language,'artistes','artists'))}${since?` · ${esc(tr(language,'depuis','since'))} ${esc(formatDate(since,language))}`:''}</p>${email?`<a href="mailto:${esc(email)}">✉ ${esc(email)}</a>`:''}</div><button class="tclose" type="button" data-close-modal aria-label="${esc(tr(language,'Fermer','Close'))}">✕</button></div><div class="label-analytics-status"><i></i><span>${esc(dataDay)}</span></div><div class="label-mode-toggle" role="group" aria-label="${esc(tr(language,'Métrique','Metric'))}"><button type="button" data-label-mode="streams" class="${state.mode==='streams'?'on':''}">Streams</button><button type="button" data-label-mode="revenue" class="${state.mode==='revenue'?'on':''}">${esc(tr(language,'Revenus estimés','Estimated revenue'))}</button></div><section class="label-kpis"><article class="label-kpi total"><span>${esc(state.mode==='revenue'?tr(language,'Revenus lifetime estimés','Estimated lifetime revenue'):tr(language,'Streams lifetime','Lifetime streams'))}</span><strong>${esc(metric(totalStreams,context,{compact:true}))}</strong><small>${esc(state.mode==='revenue'?tr(language,'Estimation à 0,0035 € / stream','Estimate at €0.0035 / stream'):tr(language,'Catalogue actif','Active catalogue'))}</small><em>${formatNumber(allTracks.length,language)} ${esc(tr(language,'pistes','tracks'))}</em></article>${performanceCard(tr(language,'30 jours','30 days'),windows[30],context)}${performanceCard(tr(language,'7 jours','7 days'),windows[7],context)}${performanceCard(tr(language,'24 heures','24 hours'),windows[1],context)}</section><section class="label-history-section"><header><div><h4>${esc(state.mode==='revenue'?tr(language,'Revenus quotidiens estimés','Estimated daily revenue'):tr(language,'Gains quotidiens de streams','Daily stream gains'))}</h4><p>${esc(tr(language,'Somme des variations réellement observées','Sum of actually observed changes'))}</p></div><span class="label-periods" role="group" aria-label="${esc(tr(language,'Période du graphique','Chart period'))}">${periods}</span></header><div data-label-chart>${chartHtml(value(group,groupIndex,'daily'),context)}</div></section>${compositionHtml(allTracks,trackIndex,context)}${trackTable(allTracks,trackIndex,context)}<div class="label-analytics-note">${esc(tr(language,"Les fenêtres utilisent uniquement des baselines exactes. Les jours manquants restent des ruptures, sans interpolation. La couverture indique combien de pistes disposent des mesures nécessaires. Les revenus sont une estimation à 0,0035 € par stream.",'Windows use exact baselines only. Missing days remain gaps and are never interpolated. Coverage shows how many tracks have the required observations. Revenue is estimated at €0.0035 per stream.'))}</div>`;
    bindChart(box,context);
  }
  function bindInteractions(context){
    const controller=typeof AbortController==='function'?new AbortController():null;
    const options=controller?{signal:controller.signal}:undefined;
    const click=event=>{
      const mode=event.target.closest('[data-label-mode]');
      if(mode){state.mode=mode.dataset.labelMode==='revenue'?'revenue':'streams';render(context);return;}
      const period=event.target.closest('[data-label-period]');
      if(period){state.period=period.dataset.labelPeriod==='all'?'all':Number(period.dataset.labelPeriod);render(context);return;}
      const track=event.target.closest('[data-label-track]');
      if(track&&typeof context.onOpenTrack==='function'){
        const id=track.dataset.labelTrack;close();context.onOpenTrack(id);
      }
    };
    const change=event=>{
      if(event.target.matches('[data-label-artist]')){state.artist=event.target.value;render(context);}
      else if(event.target.matches('[data-label-sort]')){state.sort=event.target.value;render(context);}
    };
    context.box.addEventListener('click',click,options);context.box.addEventListener('change',change,options);
    activeCleanup=()=>{
      if(controller)controller.abort();
      else{context.box.removeEventListener('click',click);context.box.removeEventListener('change',change);}
    };
  }
  async function open(options={}){
    if(!doc)throw new Error('Label analytics requires a document');
    const request=++activeRequest;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
    const box=options.box||doc.getElementById('tmbox');
    if(!box)throw new Error('Label analytics modal body is missing');
    const language=options.language==='en'?'en':'fr';
    const labelSchema=Array.isArray(options.schema)?options.schema:[];
    const trackSchema=Array.isArray(options.trackSchema)?options.trackSchema:[];
    const tracks=Array.isArray(options.tracks)?options.tracks:[];
    if(!Array.isArray(options.row)||!labelSchema.includes('key'))throw new Error('Label analytics row is invalid');
    if(!trackSchema.includes('spotify_id')||!trackSchema.includes('label'))throw new Error('Label analytics track catalogue is invalid');
    ensureStyle(options.assetVersion||'label-analytics-v1');
    const dataset=await loadDataset();
    if(request!==activeRequest)return false;
    const labelIndex=schemaIndex(labelSchema),trackIndex=schemaIndex(trackSchema);
    const groupKey=resolveGroupKey(dataset,options.row,labelIndex);
    const context={
      dataset,labelRow:options.row,labelIndex,tracks,trackIndex,box,language,groupKey,
      rate:finite(dataset.revenue_rate_eur)||0.0035,onOpenTrack:options.onOpenTrack,
    };
    state.artist='all';state.sort='streams';
    box.className='tmbox label-analytics-box';
    render(context);bindInteractions(context);
    return true;
  }
  function close(){
    activeRequest+=1;
    if(activeCleanup){activeCleanup();activeCleanup=null;}
  }

  const api={open,close};
  global.SpotifyLabelAnalytics=api;
  if(typeof module!=='undefined'&&module.exports){
    module.exports={...api,__test:{labelDisplayName,labelKeyOf,recentDaily,chartSegments,resolveGroupKey}};
  }
})(typeof window!=='undefined'?window:globalThis);

