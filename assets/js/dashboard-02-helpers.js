/* ================= HELPERS ================= */
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function stripCopyLead(s){return (s||'').replace(/^\s*copy the packaging logic\s*:\s*/i,'');}
function fmtN(x){
  if(x==null||isNaN(x))return '—';
  if(x>=1e9)return (x/1e9).toFixed(1).replace(/\.0$/,'')+'B';
  if(x>=1e6)return (x/1e6).toFixed(1).replace(/\.0$/,'')+'M';
  if(x>=1e3)return (x/1e3).toFixed(x>=1e5?0:1).replace(/\.0$/,'')+'k';
  return String(Math.round(x));
}
function fmtInt(x){return x==null?'—':Math.round(x).toLocaleString('en-US');}
function fmtDur(h){
  if(h==null)return '—';
  if(h<1)return Math.round(h*60)+' min';
  const H=Math.floor(h),M=Math.round((h-H)*60);
  return M?H+'h'+String(M).padStart(2,'0'):H+'h';
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(ms){if(!ms)return '—';const d=new Date(ms);return MONTHS[d.getMonth()]+' '+d.getFullYear();}
function fmtDT(ms){if(!ms)return '—';const d=new Date(ms);return d.getDate()+' '+MONTHS[d.getMonth()]+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function fmtDateFull(ms){if(!ms)return '—';const d=new Date(ms);return d.getDate()+' '+MONTHS[d.getMonth()]+' '+d.getFullYear();}
function fmtDateTimeShort(ms){if(!ms)return '—';const d=new Date(ms);const p=n=>String(n).padStart(2,'0');return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+', '+p(d.getHours())+':'+p(d.getMinutes());}
function fmtAge(m){if(m==null)return '—';return m<1?'<1 mo':(m<12?m.toFixed(1).replace(/\.0$/,'')+' mo':(m/12).toFixed(1).replace(/\.0$/,'')+' yr');}
function thumb(vid,q){return vid?('https://i.ytimg.com/vi/'+vid+'/'+(q||'mqdefault')+'.jpg'):'';}

const GENRE_COLORS=[
  [/m[eé]ditation|fr[eé]quence/i,'#5eead4'],
  [/d[eé]tente|\bspa\b/i,'#34d399'],
  [/ambiance|cin[eé]mat/i,'#67e8f9'],
  [/b[eé]b[eé]|berceuse|lullab/i,'#fca5a5'],
  [/bgm|caf[eé]/i,'#fcd34d'],
  [/sommeil/i,'#7dd3fc'],
  [/[eé]tude/i,'#86efac'],
  [/drum & bass|drum and bass|dnb|jungle/i,'#60a5fa'],
  [/phonk/i,'#f472b6'],
  [/house/i,'#6ee7b7'],
  [/dark/i,'#818cf8'],
  [/christmas|noël|noel/i,'#fb7185'],
  [/halloween/i,'#f97316'],
  [/guitar|guitare/i,'#fdba74'],
  [/jazz|bossa/i,'#fbbf24'],
  [/piano/i,'#f9a8d4'],
  [/classi/i,'#fda4af'],
  [/synth|retro/i,'#e879f9'],
  [/meditation|wellness/i,'#5eead4'],
  [/focus|study|étude/i,'#86efac'],
  [/ambient sleep/i,'#7dd3fc'],
  [/^sleep$|sleep &|sommeil/i,'#7dd3fc'],
  [/nature/i,'#6ee7b7'],
  [/ambient/i,'#67e8f9'],
  [/electro/i,'#38bdf8'],
  [/lofi|chillhop/i,'#a78bfa'],
];
function gcolor(g){
  if(!g)return '#9ca3af';
  for(const [re,c] of GENRE_COLORS){if(re.test(g))return c;}
  return '#9ca3af';
}
const GENRE_EMOJI=[
  [/m[eé]ditation|fr[eé]quence/i,'🧘'],
  [/d[eé]tente|\bspa\b/i,'🧖'],
  [/ambiance|cin[eé]mat/i,'🎬'],
  [/b[eé]b[eé]|berceuse|lullab/i,'👶'],
  [/bgm|caf[eé]/i,'☕'],
  [/sommeil/i,'😴'],
  [/[eé]tude/i,'📚'],
  [/house/i,'🪩'],
  [/dark/i,'🌑'],
  [/christmas|noël|noel/i,'🎄'],
  [/halloween/i,'🎃'],
  [/guitar|guitare/i,'🎸'],
  [/jazz|bossa/i,'🎷'],
  [/piano/i,'🎹'],
  [/classi/i,'🎻'],
  [/synth|retro/i,'🌆'],
  [/electro/i,'🎛️'],
  [/nature/i,'🌿'],
  [/ambient/i,'💤'],
  [/lofi|chillhop/i,'🎧'],
];
function genreEmoji(g){
  if(!g)return '🎵';
  for(const [re,e] of GENRE_EMOJI){if(re.test(g))return e;}
  return '🎵';
}
const TIER_EMOJI={S:'🔴',A:'🟠',B:'🟡',C:'🟢'};
function tierEmoji(p){return p?(TIER_EMOJI[p[0].toUpperCase()]||'⚪'):'⚪';}
const PERSO_EMOJI=[
  [/lofi girl/i,'👧'],
  [/synthwave boy/i,'🕺'],
  [/m[eè]re/i,'👩'],
  [/p[eè]re|papa/i,'👨'],
  [/prof/i,'👩‍🏫'],
  [/chat/i,'🐱'],
  [/chien/i,'🐶'],
  [/emma/i,'🙋‍♀️'],
  [/tiago/i,'🙋‍♂️'],
  [/boy/i,'👦'],
  [/sans personnage|d[eé]terminer/i,'❓'],
];
function personaEmoji(p){
  if(!p)return '🎭';
  for(const [re,e] of PERSO_EMOJI){if(re.test(p))return e;}
  return '🎭';
}
const PERSO_CATEGORIES=[
  [/synthwave boy/i,'Synthwave Boy'],
  [/lofi girl/i,'Lofi Girl'],
  [/p[eè]re|papa/i,'Père'],
  [/m[eè]re/i,'Mère'],
  [/tiago/i,'Tiago'],
  [/chat|chien/i,'Chat / Chien'],
];
function persoCategory(p){
  if(!p)return 'Sans personnage';
  for(const [re,c] of PERSO_CATEGORIES){if(re.test(p))return c;}
  return 'Sans personnage';
}
const PERSO_ORDER=['Lofi Girl','Synthwave Boy','Mère','Père','Sans personnage','Tiago','Chat / Chien'];
const PERIOD_EMOJI={'3m':'🟢','6m':'🟡','12m':'🟠','all':'🔴'};
function gtag(g,extra,emo){
  if(!g)return '';
  const c=gcolor(g);
  const lead=extra?'':(emo?genreEmoji(g)+' ':'<span class="dot" style="background:'+c+'"></span>');
  return '<span class="tag" style="background:'+c+'1f;color:'+c+';border:1px solid '+c+'45">'+lead+esc(g)+'</span>';
}
function ghosttag(t){return t?'<span class="tag ghost">'+esc(t)+'</span>':'';}
/* ---- custom rounded dropdown (native <select> popups can't be styled) ---- */
function jsq(s){return "'"+String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";}
let XDD_ID=0;
function xddToggle(id,ev){
  if(ev)ev.stopPropagation();
  document.querySelectorAll('.xdd.open').forEach(x=>{if(x.id!==id)x.classList.remove('open');});
  const el=document.getElementById(id);if(el)el.classList.toggle('open');
}
document.addEventListener('click',function(){document.querySelectorAll('.xdd.open').forEach(x=>x.classList.remove('open'));});
function xdd(btnCls,btnHtml,opts){
  const id='xdd'+(++XDD_ID);
  return '<div class="xdd" id="'+id+'">'+
    '<button type="button" class="ctl '+btnCls+' xdd-btn" onclick="xddToggle(\''+id+'\',event)"><span class="xdd-label">'+btnHtml+'</span><span class="xdd-car">▾</span></button>'+
    '<div class="xdd-list">'+opts.map(o=>'<div class="xdd-opt'+(o.sel?' sel':'')+'" onclick="'+o.onclick.replace(/"/g,'&quot;')+';xddToggle(\''+id+'\')">'+o.label+'</div>').join('')+'</div></div>';
}
function median(arr){const a=arr.filter(x=>x!=null).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
const VIDEO_HIST_WINDOWS={h24:86400000,d7:7*86400000,d30:30*86400000,all:null};
let VIDEO_HIST_PERIOD='d7';
function videoHistCopy(){
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  return fr?{
    title:'📊 Performance du scan',note:'Données réelles, sans extrapolation',
    h24:'24 dernières heures',d7:'7 derniers jours',d30:'30 derniers jours',all:'Tout',
    gained:'vues gagnées',building:'Historique en cours',previous:'vs période précédente',
    measured:'mesuré sur ',hours:' h',days:' j',perHour:'/h',perDay:'/j',
    chart:'Historique des vues',dailyChart:'Vues gagnées par jour',dailySince:'mesurées à partir du 20 juillet 2026'
  }:{
    title:'📊 Scan performance',note:'Measured data · no extrapolation',
    h24:'Last 24 hours',d7:'Last 7 days',d30:'Last 30 days',all:'All history',
    gained:'views gained',building:'History building up',previous:'vs previous period',
    measured:'measured over ',hours:' h',days:' d',perHour:'/h',perDay:'/day',
    chart:'View history',dailyChart:'Views gained per day',dailySince:'measured from 20 July 2026'
  };
}
function cleanVideoHist(pts){
  return (pts||[]).filter(p=>Array.isArray(p)&&isFinite(p[0])&&isFinite(p[1])).map(p=>[+p[0],+p[1]]).sort((a,b)=>a[0]-b[0]);
}
const VIDEO_DAILY_VIEW_HISTORY_START=Date.UTC(2026,6,20);
function dailyViewDeltas(pts){
  const byDay=new Map();
  cleanVideoHist(pts).forEach(point=>{
    if(point[0]<VIDEO_DAILY_VIEW_HISTORY_START)return;
    const day=new Date(point[0]).toLocaleDateString('en-CA',{timeZone:'Europe/Paris'});
    const previous=byDay.get(day);
    if(!previous||point[0]>=previous[0])byDay.set(day,point);
  });
  const days=[...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const out=[];
  for(let i=1;i<days.length;i++){
    const [previousDay,previous]=days[i-1], [day,current]=days[i];
    if(Date.parse(day+'T00:00:00Z')-Date.parse(previousDay+'T00:00:00Z')!==86400000)continue;
    const delta=current[1]-previous[1];
    if(delta>=0)out.push([current[0],delta]);
  }
  return out;
}
function histPointAtOrBefore(pts,t){
  let found=null;
  for(const p of pts){if(p[0]>t)break;found=p;}
  return found;
}
function videoHistMetric(pts,windowMs){
  const a=cleanVideoHist(pts);if(a.length<2)return null;
  const end=a[a.length-1],target=end[0]-windowMs;
  const base=histPointAtOrBefore(a,target);
  const maxGap=Math.min(windowMs*.15,36*3600000);
  if(!base||target-base[0]>maxGap)return null;
  const covered=end[0]-base[0],delta=end[1]-base[1];
  if(covered<windowMs*.85||delta<0)return null;
  const older=histPointAtOrBefore(a,end[0]-2*windowMs);
  let previous=null;
  if(older&&base[0]-(end[0]-2*windowMs)<=maxGap){
    const d=base[1]-older[1];if(d>=0)previous=d;
  }
  const pct=previous!=null&&previous>0?(delta-previous)/previous*100:null;
  return {delta,covered,previous,pct,scans:a.filter(p=>p[0]>=base[0]).length};
}
function videoHistSlice(pts,key){
  const a=cleanVideoHist(pts),ms=VIDEO_HIST_WINDOWS[key];
  if(!a.length||!ms)return a;
  const start=a[a.length-1][0]-ms;
  const before=histPointAtOrBefore(a,start);
  const out=a.filter(p=>p[0]>=start);
  if(before&&(!out.length||out[0][0]!==before[0]))out.unshift(before);
  return out;
}
function videoHistMetricCard(key,pts){
  const c=videoHistCopy(),m=videoHistMetric(pts,VIDEO_HIST_WINDOWS[key]);
  if(!m)return '<div class="vha-card na"><span>'+esc(c[key])+'</span><b>—</b><small>'+esc(c.building)+'</small><em>'+esc(c.note)+'</em></div>';
  const units=key==='h24'?c.perHour:c.perDay;
  const rate=m.delta/(key==='h24'?m.covered/3600000:m.covered/86400000);
  let trend='';let klass='';
  if(m.pct!=null){
    const sign=m.pct>0?'+':'';trend=sign+Math.round(m.pct)+'% '+c.previous;
    klass=m.pct>4?'up':m.pct<-4?'down':'flat';
  }else trend=c.measured+(key==='h24'?Math.round(m.covered/3600000)+c.hours:Math.round(m.covered/86400000)+c.days);
  return '<div class="vha-card '+klass+'"><span>'+esc(c[key])+'</span><b>+'+fmtN(m.delta)+'</b><small>'+esc(c.gained)+' · '+fmtN(rate)+esc(units)+'</small><em>'+esc(trend)+'</em></div>';
}
function videoHistoryAnalytics(pts){
  const c=videoHistCopy(),all=cleanVideoHist(pts),key=VIDEO_HIST_WINDOWS.hasOwnProperty(VIDEO_HIST_PERIOD)?VIDEO_HIST_PERIOD:'d7';
  const active=videoHistSlice(all,key);
  return '<div class="vha-grid">'+videoHistMetricCard('h24',all)+videoHistMetricCard('d7',all)+videoHistMetricCard('d30',all)+'</div>'+
    '<div class="vha-controls">'+['h24','d7','d30','all'].map(k=>'<button class="'+(key===k?'on':'')+'" onclick="setVideoHistoryPeriod(\''+k+'\')">'+esc(c[k])+'</button>').join('')+'</div>'+
    '<div class="hist-meta">'+esc(c.dailyChart)+' · '+esc(c.dailySince)+'</div>'+histChart(dailyViewDeltas(active),'daily-views',false);
}
function setVideoHistoryPeriod(key){
  if(!VIDEO_HIST_WINDOWS.hasOwnProperty(key))return;
  VIDEO_HIST_PERIOD=key;
  const current=window._openVideoDrawer;
  if(current)openDrawer(current.kind,current.v,true);
}
function histChart(pts,unit,showMeta){
  const u=unit||'views';
  if(!pts||pts.length===0)return '<div class="hist-empty">Tracking just started — the curve appears from the 2nd scan. 📡</div>';
  if(pts.length===1)return '<div class="hist-empty">1 scan recorded ('+fmtDateFull(pts[0][0])+' · '+fmtInt(pts[0][1])+' '+u+') — the curve appears from the 2nd scan. 📡</div>';
  const W=560,H=150,P=10;
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
  const x0=Math.min.apply(null,xs),x1=Math.max.apply(null,xs);
  // Each analytics curve uses its own observed range: the lowest point sits
  // at the bottom and the highest point at the top, making small changes
  // readable for both video views and concurrent livestream viewers.
  const actualMin=Math.min.apply(null,ys),actualMax=Math.max.apply(null,ys);
  const flatRange=actualMin===actualMax;
  const y0=flatRange?actualMin-1:actualMin,y1=flatRange?actualMax+1:actualMax;
  const X=t=>P+(W-2*P)*(x1===x0?0.5:(t-x0)/(x1-x0));
  const Y=v=>H-P-(H-2*P)*((v-y0)/(y1-y0));
  const line=pts.map((p,i)=>(i?'L':'M')+X(p[0]).toFixed(1)+' '+Y(p[1]).toFixed(1)).join(' ');
  const area=line+' L'+X(x1).toFixed(1)+' '+(H-P)+' L'+X(x0).toFixed(1)+' '+(H-P)+' Z';
  const dailyViews=u==='daily-views';
  const days=Math.max((x1-x0)/86400000,0.5);
  const perDay=(pts[pts.length-1][1]-pts[0][1])/days;
  const meta=u==='viewers'
    ? 'Peak <b>'+fmtN(Math.max.apply(null,ys))+'</b> · latest <b>'+fmtN(pts[pts.length-1][1])+'</b> concurrent viewers · '+pts.length+' scans'
    : dailyViews
      ? '<b>'+fmtN(ys.reduce((sum,value)=>sum+value,0))+'</b> views gained · '+pts.length+' measured days · '+fmtDateFull(x0)+' → '+fmtDateFull(x1)
      : '<b>+'+fmtN(perDay)+'</b> '+u+'/day measured · '+pts.length+' scans · '+fmtDateFull(x0)+' → '+fmtDateFull(x1);
  const hid='h'+(++HIST_SEQ);
  HIST_REG[hid]={pts,unit:dailyViews?'views gained':u,W,H,P,x0,x1,y0,y1};
  return (showMeta===false?'':'<div class="hist-meta">'+meta+'</div>')+
    '<div class="hist-wrap" data-hid="'+hid+'">'+
    '<svg class="hist-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<path d="'+area+'" fill="rgba(255,0,51,.14)"/>'+
    '<path d="'+line+'" fill="none" stroke="#ff5272" stroke-width="2"/>'+
    pts.map(p=>'<circle cx="'+X(p[0]).toFixed(1)+'" cy="'+Y(p[1]).toFixed(1)+'" r="'+(u==='viewers'?3.4:2.6)+'" fill="#ff5272"/>').join('')+
    '</svg>'+
    '<div class="hist-guide"></div><div class="hist-dot"></div><div class="hist-tip"></div>'+
    '</div>'+
    '<div class="hist-axis"><span>'+fmtN(actualMin)+'</span><span>'+fmtN(actualMax)+'</span></div>';
}
let HIST_SEQ=0;const HIST_REG={};
document.addEventListener('mousemove',e=>{
  const w=e.target.closest?e.target.closest('.hist-wrap'):null;
  document.querySelectorAll('.hist-wrap.hov').forEach(x=>{if(x!==w)x.classList.remove('hov');});
  if(!w)return;
  const o=HIST_REG[w.dataset.hid];if(!o)return;
  const r=w.getBoundingClientRect();
  const fx=(e.clientX-r.left)/r.width;                       // 0..1 across
  const t=o.x0+(o.x1-o.x0)*Math.min(1,Math.max(0,(fx*o.W-o.P)/(o.W-2*o.P)));
  let best=o.pts[0];for(const p of o.pts)if(Math.abs(p[0]-t)<Math.abs(best[0]-t))best=p;
  const px=(o.P+(o.W-2*o.P)*(o.x1===o.x0?0.5:(best[0]-o.x0)/(o.x1-o.x0)))/o.W*r.width;
  const py=(o.H-o.P-(o.H-2*o.P)*((best[1]-o.y0)/(o.y1-o.y0)))/o.H*r.height;
  w.classList.add('hov');
  const tip=w.querySelector('.hist-tip'),gd=w.querySelector('.hist-guide'),dt=w.querySelector('.hist-dot');
  tip.innerHTML='<b>'+fmtInt(best[1])+'</b> '+esc(o.unit)+'<br><span>'+(o.unit==='viewers'?fmtDT(best[0]):fmtDateFull(best[0]))+'</span>';
  gd.style.left=px+'px';dt.style.left=px+'px';dt.style.top=py+'px';
  const tw=tip.offsetWidth;
  tip.style.left=Math.min(Math.max(px-tw/2,4),r.width-tw-4)+'px';
  tip.style.top=(py<46?py+14:py-tip.offsetHeight-12)+'px';
});
function timeAgo(ms){
  const s=(Date.now()-ms)/1000;
  if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';
}
function maxHistTime(hist){
  let m=null;
  if(!hist)return null;
  for(const k in hist){
    const a=hist[k];
    if(a&&a.length){const t=a[a.length-1][0];if(m==null||t>m)m=t;}
  }
  return m;
}
function scanDotColor(ms){
  if(ms==null)return 'var(--dim)';
  const h=(Date.now()-ms)/3600000;
  if(h<26)return 'var(--green)';
  if(h<72)return 'var(--amber)';
  return 'var(--red)';
}
function lastScanText(){
  if(!DATA)return '';
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  // Only a validated metrics timestamp or a real history point proves that
  // video counters were refreshed.  A discovery-only snapshot must not make
  // stale analytics look fresh.
  const vT=Math.max(maxHistTime(DATA.hist)||0,Number(window.LOFI_DATA&&window.LOFI_DATA.videoMetricsT)||0)||null;
  const lT=maxHistTime(DATA.liveHourly)||maxHistTime(DATA.liveHist);
  const parts=[];
  const line=(ms,emo,labelEn,labelFr,descEn,descFr)=>{
    const title=fr?'Scan '+labelFr:labelEn+' scan';
    const updated=fr?'Dernière mise à jour : '+fmtDateTimeShort(ms):'Last updated: '+fmtDateTimeShort(ms);
    const desc=fr?descFr:descEn;
    const tip=title+'. '+updated+'. '+desc;
    return '<div class="sync-line" tabindex="0" aria-label="'+esc(tip)+'"><span class="sync-line-dot" style="background:'+scanDotColor(ms)+'"></span>'+emo+' '+fmtDateTimeShort(ms)+'<span class="sync-micro"><b>'+esc(title)+'</b>'+esc(updated)+'<br>'+esc(desc)+'</span></div>';
  };
  if(vT!=null)parts.push(line(vT,'🎬','Videos','Vidéos','Refreshes the video catalog, views and stats.','Actualise le catalogue de vidéos, leurs vues et statistiques.'));
  if(lT!=null)parts.push(line(lT,'📡','Streams','Streams','Refreshes live streams and viewer counts.','Actualise les streams en direct et le nombre de spectateurs.'));
  return parts.join('');
}

/* ================= STATE ================= */
let DATA=null, SYNCED=null, route='dashboard';
const VIEW_CACHE=new Map();
let VIEW_WARMUP_TOKEN=0;
function setRadarData(d){
  DATA=d;mergeLoadedVideoHistoryIntoData(DATA);
  VIEW_CACHE.clear();VIEW_WARMUP_TOKEN++;
  if(typeof _anaCache!=='undefined'){_anaCache=null;_anaT=0;}
  if(typeof scheduleViewWarmup==='function')scheduleViewWarmup();
}
const VS={
  all:{q:'',genre:'',sort:'vpm',mode:'grid',limit:60},
  trends:{q:'',genre:'',sort:'vpm',mode:'grid',limit:60},
  news:{q:'',genre:'',sort:'added',mode:'grid',limit:60},
  mix:{q:'',genre:'',sort:'vpm',mode:'grid',limit:60,age:'3m'}
};
const RS={q:'',genre:'',pot:'',perso:'',val:'',sort:'scoreAdj',mode:'grid',limit:80};
const RM={src:'',genre:'',year:'',mode:'cal',cal:null,view:'year'};
const LS={q:'',sort:'now',mode:'grid',limit:60};
const CS={q:'',niche:'',sort:'subs',mode:'table',limit:150};
const CHAN_URL='https://docs.google.com/spreadsheets/d/1jDbcryjTDbRsW4Uw6OP_SYwgvbPoLQu_KcSWqC3Dfoc/export?format=xlsx';
const CHAN_CACHE='lofiradar_chan_v1';
let CHAN=null, CHAN_ERR=null, CHAN_T=null;

/* ================= BOOT / SYNC ================= */
function setSync(state,txt){
  const d=document.getElementById('sync-dot'),row=d&&d.closest('.sync-row');
  const detailed=typeof txt==='string'&&txt.includes('class="sync-line"');
  if(row)row.classList.toggle('detailed',detailed);
  if(d)d.className='sync-dot '+state;
  document.getElementById('sync-txt').innerHTML=(typeof LANG!=='undefined'&&LANG==='fr'&&typeof frz==='function')?frz(txt):txt;
}
async function fetchData(){
  const res=await fetch(XLSX_URL,{redirect:'follow'});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const buf=await res.arrayBuffer();
  const wb=XLSX.read(buf,{type:'array',cellDates:false});
  const d=parseWorkbook(wb);
  mergeExtensionSnapshot(d);
  if(!d.all.length&&!d.trends.length)throw new Error('Parsed 0 rows — sheet structure may have changed');
  return d;
}
/* The Sheet keeps the curated catalogue and older history. The validated
   daily snapshot supplies current counters, new discoveries and new history
   points. Merge both sources by video ID without touching livestream data. */
function mergeExtensionSnapshot(d){
  const snap=window.LOFI_DATA&&window.LOFI_DATA.d;if(!snap)return;
  ['all','trends','news'].forEach(key=>{
    const into=d[key]||(d[key]=[]),byId=new Map(into.map(r=>[r.vid,r]));
    (snap[key]||[]).forEach(row=>{
      const current=byId.get(row.vid);
      if(current)Object.assign(current,row);
      else{const added=Object.assign({},row);into.push(added);byId.set(row.vid,added);}
    });
    into.sort((a,b)=>(b.vpm||0)-(a.vpm||0));
  });
  const hist=d.hist||(d.hist={});
  Object.entries(snap.hist||{}).forEach(([vid,points])=>{
    hist[vid]=mergeDailyVideoHistory(hist[vid],points);
  });
}
function mergeDailyVideoHistory(left,right){
  const byDay=new Map();
  (left||[]).concat(right||[]).forEach(p=>{
    if(!Array.isArray(p)||!isFinite(p[0])||!isFinite(p[1]))return;
    const point=[+p[0],+p[1]],day=Math.floor(point[0]/86400000),old=byDay.get(day);
    if(!old||point[0]>=old[0])byDay.set(day,point);
  });
  return [...byDay.values()].sort((a,b)=>a[0]-b[0]);
}
const VIDEO_HISTORY_SHARDS=new Map(),VIDEO_HISTORY_PENDING=new Map(),VIDEO_HISTORY_ERRORS=new Map();
function videoHistoryKey(vid){return vid&&vid.charCodeAt(0).toString(16).padStart(2,'0');}
function mergeHistoryShardIntoData(shard,d){
  if(!d||!shard||!shard.d)return;
  d.hist=d.hist||{};
  Object.entries(shard.d).forEach(([vid,points])=>{d.hist[vid]=mergeDailyVideoHistory(d.hist[vid],points);});
}
function mergeLoadedVideoHistoryIntoData(d){
  VIDEO_HISTORY_SHARDS.forEach(shard=>mergeHistoryShardIntoData(shard,d));
}
function videoHistoryReady(vid){return VIDEO_HISTORY_SHARDS.has(videoHistoryKey(vid));}
function videoHistoryBusy(vid){return VIDEO_HISTORY_PENDING.has(videoHistoryKey(vid));}
function videoHistoryError(vid){return VIDEO_HISTORY_ERRORS.get(videoHistoryKey(vid))||'';}
async function loadVideoHistoryShard(key){
  if(VIDEO_HISTORY_SHARDS.has(key))return VIDEO_HISTORY_SHARDS.get(key);
  if(VIDEO_HISTORY_PENDING.has(key))return VIDEO_HISTORY_PENDING.get(key);
  const pending=fetch('video_history/'+key+'.json?payload='+Date.now(),{cache:'no-store'})
    .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(shard=>{
      if(!shard||typeof shard.d!=='object')throw new Error('Invalid history shard');
      VIDEO_HISTORY_SHARDS.set(key,shard);VIDEO_HISTORY_ERRORS.delete(key);return shard;
    })
    .catch(e=>{VIDEO_HISTORY_ERRORS.set(key,e.message||'History unavailable');throw e;})
    .finally(()=>VIDEO_HISTORY_PENDING.delete(key));
  VIDEO_HISTORY_PENDING.set(key,pending);return pending;
}
async function ensureVideoHistory(vid){
  if(!vid)return false;
  const key=videoHistoryKey(vid);
  try{
    const shard=await loadVideoHistoryShard(key);
    mergeHistoryShardIntoData(shard,DATA);
    if(typeof _anaCache!=='undefined'){_anaCache=null;_anaT=0;}
    const current=window._openVideoDrawer;
    if(current&&current.v&&current.v.vid===vid)openDrawer(current.kind,current.v,true,true);
    if(window._openAnaVid===vid&&route==='ana'){
      render();const i=(window._page_ana||[]).findIndex(v=>v.vid===vid);if(i>=0)openAnaIdx(i,true);
    }
    return true;
  }catch(e){
    const current=window._openVideoDrawer;
    if(current&&current.v&&current.v.vid===vid)openDrawer(current.kind,current.v,true,true);
    if(window._openAnaVid===vid&&route==='ana'){
      const i=(window._page_ana||[]).findIndex(v=>v.vid===vid);if(i>=0)openAnaIdx(i,true);
    }
    return false;
  }
}
function retryVideoHistory(vid){
  const key=videoHistoryKey(vid);VIDEO_HISTORY_ERRORS.delete(key);VIDEO_HISTORY_SHARDS.delete(key);
  const current=window._openVideoDrawer;
  if(current&&current.v&&current.v.vid===vid)openDrawer(current.kind,current.v,true,true);
  if(window._openAnaVid===vid){const i=(window._page_ana||[]).findIndex(v=>v.vid===vid);if(i>=0)openAnaIdx(i,true);}
  ensureVideoHistory(vid);
}
function videoHistoryPanel(vid,points,label){
  const daily=()=>dailyViewDeltas(points||null);
  if(!vid)return label?'<div class="k">📈 '+esc(videoHistCopy().dailyChart)+'</div>'+histChart(daily(),'daily-views'):videoHistoryAnalytics(points||null);
  if(videoHistoryError(vid))return '<div class="hist-empty">Daily history unavailable. <button class="load-more" onclick="retryVideoHistory('+jsq(vid)+')">Retry</button></div>';
  if(!videoHistoryReady(vid))return '<div class="hist-empty">Loading daily history…</div>';
  return label?'<div class="k">📈 '+esc(videoHistCopy().dailyChart)+'</div>'+histChart(daily(),'daily-views'):videoHistoryAnalytics(points||null);
}
function clearLegacyVideoCaches(){
  try{localStorage.removeItem('lofiradar_v3');localStorage.removeItem(CACHE_KEY);}catch(e){}
}
function saveCache(){
  // The static snapshot is already the fallback; do not duplicate its growing
  // catalogue/history in the small localStorage quota.
  clearLegacyVideoCaches();
}
function loadCache(){
  clearLegacyVideoCaches();return null;
}
async function refresh(){
  const btn=document.getElementById('btn-refresh');btn.classList.add('spinning');
  setSync('load','Syncing…');
  try{
    const d=await fetchData();
    setRadarData(d);SYNCED=Date.now();saveCache(d);
    setSync('',lastScanText()||'Live · synced '+timeAgo(SYNCED));
    renderNav();render();
  }catch(e){
    setSync('err','Sync failed<br>'+esc(e.message));
    if(!DATA)showError(e);
  }
  btn.classList.remove('spinning');
}
function showError(e){
  document.getElementById('loader').classList.add('hide');
  let h='<div class="err-box"><h3>No data available</h3><p>'+esc(e.message)+
    '<br><br>Keep <b>Lofi_Radar_data.js</b> next to this file (daily snapshot), or open the page from a web server for live sync.</p>'+
    '<button class="load-more" onclick="boot()">Retry</button></div>';
  if(typeof LANG!=='undefined'&&LANG==='fr'&&typeof frz==='function')h=frz(h);
  document.getElementById('view').innerHTML=h;
}
function parseChanWb(wb){
  const ws=sheetByName(wb,'Audit');
  if(!ws)throw new Error('Audit tab not found');
  let hr=-1;
  for(let r=0;r<12;r++){const x=cv(ws,r,0);if(x&&/^cha[iî]ne$/i.test(String(x).trim())){hr=r;break;}}
  if(hr<0)throw new Error('Audit header not found');
  const chans=[];const end=lastRow(ws);
  for(let r=hr+1;r<=end;r++){
    const name=str(cv(ws,r,0));if(!name)continue;
    chans.push({
      name:name, niche:str(cv(ws,r,1)), url:str(cv(ws,r,2)), country:str(cv(ws,r,3)),
      subs:num(cv(ws,r,4)), views:num(cv(ws,r,5)), nvid:num(cv(ws,r,6)), avgVid:num(cv(ws,r,7)),
      created:toMs(cv(ws,r,8)), ageY:num(cv(ws,r,9)), viewsYr:num(cv(ws,r,10)),
      lastUp:toMs(cv(ws,r,11)), avg10:num(cv(ws,r,12)), upMo:num(cv(ws,r,13)), status:str(cv(ws,r,14))
    });
  }
  const hist={};
  const hs=sheetByName(wb,'Channel History');
  if(hs){
    const e2=lastRow(hs);
    for(let r=1;r<=e2;r++){
      const u=normUrl(str(cv(hs,r,0)));if(!u)continue;
      const t=toMs(cv(hs,r,1));if(t==null)continue;
      (hist[u]=hist[u]||[]).push([t,num(cv(hs,r,2)),num(cv(hs,r,3))]);
    }
    Object.values(hist).forEach(a=>a.sort((x,y)=>x[0]-y[0]));
  }
  const X=(window.CHX&&window.CHX.d)||{};
  const XH=(window.CHX&&window.CHX.hist)||{};
  chans.forEach(c=>{
    const key=((c.url.match(/(@[\w.-]+)/)||c.url.match(/channel\/(UC[\w-]{22})/)||[])[1]||'').toLowerCase();
    const x=X[key]||X[key.replace(/^@/,'')]||X['@'+key];
    if(x){
      if(x.av)c.av=x.av;
      if(x.s!=null)c.subs=x.s;
      if(Number.isFinite(Number(x.sm))&&Number(x.sm)!==0)c.subsMo=Math.round(Number(x.sm));
      if(x.v!=null)c.views=x.v;
      if(x.n!=null)c.nvid=x.n;
      if(x.cr)c.created=toMs(x.cr);
      if(x.lu)c.lastUp=toMs(x.lu);
      if(c.created)c.ageY=+(((Date.now()-c.created)/31557600000).toFixed(1));
      if(c.views!=null&&c.ageY>0.2)c.viewsYr=Math.round(c.views/c.ageY);
      if(c.views!=null&&c.nvid)c.avgVid=Math.round(c.views/c.nvid);
    }
    const extraHist=XH[key]||XH[key.replace(/^@/,'')]||XH['@'+key];
    if(extraHist&&extraHist.length){
      const u=normUrl(c.url),byTime=new Map();
      (hist[u]||[]).concat(extraHist).forEach(p=>{if(Array.isArray(p)&&isFinite(p[0]))byTime.set(+p[0],[+p[0],num(p[1]),num(p[2])]);});
      hist[u]=[...byTime.values()].sort((a,b)=>a[0]-b[0]);
    }
  });
  const lg=(window.CHX&&window.CHX.lg)||{};
  const lgUrl=normUrl('https://www.youtube.com/@LofiGirl');
  const lgExtra=XH.lofigirl||XH['@lofigirl']||[];
  if(lgExtra.length){
    const byTime=new Map();
    (hist[lgUrl]||[]).concat(lgExtra).forEach(p=>{
      if(Array.isArray(p)&&isFinite(p[0]))byTime.set(+p[0],[+p[0],num(p[1]),num(p[2])]);
    });
    hist[lgUrl]=[...byTime.values()].sort((a,b)=>a[0]-b[0]);
  }
  const lgCreated=Date.UTC(2015,2,18),lgViews=lg.v||2639469149;
  const lgAge=+(((Date.now()-lgCreated)/31557600000).toFixed(1));
  chans.unshift({
    name:'Lofi Girl',niche:'Lofi / Chillhop',url:'https://www.youtube.com/@LofiGirl',country:'France',
    subs:lg.s||15813038,views:lgViews,nvid:lg.n||427,avgVid:Math.round(lgViews/(lg.n||427)),
    created:lgCreated,ageY:lgAge,viewsYr:Math.round(lgViews/lgAge),lastUp:lg.lu?toMs(lg.lu):null,
    avg10:null,upMo:null,status:'Actif',ours:true,av:lg.av||null
  });
  return {channels:chans,hist:hist};
}
function sbmFor(c){
  if(!window.SBM||!c.name||window.SBM[c.name]==null)return null;
  const value=Number(window.SBM[c.name]);
  return Number.isFinite(value)&&Math.round(value)!==0?Math.round(value):null;
}
function fmtSubsMo(v){
  if(v==null||!Number.isFinite(Number(v))||Math.round(Number(v))===0)return '—';
  if(v<0)return '-'+fmtN(-v);
  return '+'+fmtN(v);
}
function sbmColor(v){
  if(v==null)return 'var(--text)';
  if(v<0)return '#f87171';
  if(v<10000)return '#fb923c';
  if(v<50000)return '#fbbf24';
  return '#34d399';
}
function smoothedSubscriberGrowth(points,maxDays){
  const byMonth=new Map();
  (points||[]).forEach(point=>{
    if(!Array.isArray(point)||!Number.isFinite(Number(point[0])))return;
    const subscribers=Number(point[1]),timestamp=Number(point[0]);
    if(!Number.isFinite(subscribers)||subscribers<=0)return;
    const month=new Date(timestamp).toISOString().slice(0,7),previous=byMonth.get(month);
    if(!previous||timestamp>=previous[0])byMonth.set(month,[timestamp,subscribers]);
  });
  const series=[...byMonth.values()].sort((a,b)=>a[0]-b[0]);
  if(series.length<2)return null;
  const end=series[series.length-1];
  const selected=maxDays==null?series:series.filter(point=>end[0]-point[0]<=maxDays*86400000);
  if(selected.length<2)return null;
  const first=selected[0],last=selected[selected.length-1],days=(last[0]-first[0])/86400000;
  if(days<20)return null;
  const value=Math.round((last[1]-first[1])/(days/30.4375));
  return value===0?null:value;
}
function chanSubsMo(c){
  const direct=Number(c.subsMo);
  if(Number.isFinite(direct)&&Math.round(direct)!==0)return Math.round(direct);
  const history=CHAN&&CHAN.hist?(CHAN.hist[normUrl(c.url)]||[]):[];
  // Preferred method: smooth the most recent 12 months. Rounded subscriber
  // plateaus fall through to the complete retained curve, then Social Blade.
  const recent=smoothedSubscriberGrowth(history,366);
  if(recent!=null)return recent;
  const allTime=smoothedSubscriberGrowth(history,null);
  if(allTime!=null)return allTime;
  return sbmFor(c);
}
function normUrl(u){return String(u||'').toLowerCase().replace(/\/+$/,'');}
async function loadChan(){
  try{
    const res=await fetch(CHAN_URL,{redirect:'follow'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const wb=XLSX.read(await res.arrayBuffer(),{type:'array',cellDates:false});
    CHAN=parseChanWb(wb);CHAN_T=Date.now();CHAN_ERR=null;
    try{localStorage.setItem(CHAN_CACHE,JSON.stringify({t:CHAN_T,c:{channels:CHAN.channels,hist:CHAN.hist}}));}catch(e){}
  }catch(e){
    try{
      const raw=localStorage.getItem(CHAN_CACHE);
      if(raw){const o=JSON.parse(raw);CHAN=o.c;CHAN_T=o.t;CHAN_ERR=null;}
      else CHAN_ERR=e.message;
    }catch(e2){CHAN_ERR=e.message;}
  }
  VIEW_CACHE.clear();VIEW_WARMUP_TOKEN++;
  renderNav();
  render(); // re-render la vue courante : les badges AI dépendent des données Channels
}
async function boot(){
  if(typeof LANG!=='undefined'){
    const lm=document.getElementById('loader-msg');
    if(lm)lm.textContent=LANG==='fr'?'Synchronisation avec YouTube · Veille…':'Synchronizing YouTube · Scan…';
  }
  const hs=(location.hash||'').slice(1);
  if(hs&&VIEWS.some(v=>v.id===hs))route=hs;
  loadChan();
  if(window.__radarDataReady){try{await window.__radarDataReady;}catch(e){}}
  const cache=loadCache();
  const snap=(window.LOFI_DATA&&window.LOFI_DATA.d)?window.LOFI_DATA:null;
  let best=null,src='';
  if(cache&&(!snap||cache.t>=snap.t)){best=cache;src='cache';}
  else if(snap){best=snap;src='snap';}
  if(best){
    normalizeExpandedGenre(best.d.all);normalizeExpandedGenre(best.d.trends);normalizeExpandedGenre(best.d.news);normalizeExpandedGenre(best.d.ours);enrichRecos(best.d.recos);
    setRadarData(best.d);SYNCED=best.t;
    document.getElementById('loader').classList.add('hide');
    setSync('load',(src==='snap'?'Daily snapshot · ':'Cached · ')+'trying live sync…');
    renderNav();render();
    try{const d=await fetchData();setRadarData(d);SYNCED=Date.now();saveCache(d);setSync('',lastScanText()||'Live · synced just now');renderNav();render();}
    catch(e){setSync('','Daily snapshot · '+fmtDateFull(best.t)+'<br>(live sync unavailable from a local file)');}
  }else{
    document.getElementById('loader-msg').textContent=(typeof LANG!=='undefined'&&LANG==='fr')?'Téléchargement des données en direct depuis Google Sheets…':'Downloading live data from Google Sheets…';
    try{
      const d=await fetchData();setRadarData(d);SYNCED=Date.now();saveCache(d);
      document.getElementById('loader').classList.add('hide');
      setSync('',lastScanText()||'Live · synced just now');
      renderNav();render();
    }catch(e){showError(e);setSync('err','No data');}
  }
}

/* ================= NAV / ROUTER ================= */
const VIEWS=[
  {id:'dashboard',label:'Dashboard',emo:'📊',cnt:()=>''},
  {id:'mix',label:'Videos',emo:'🎬',cnt:()=>DATA?fmtN(mixRows().length):''},
  {id:'live',label:'Livestreams',emo:'📺',cnt:()=>DATA&&DATA.lives?String(DATA.lives.length):''},
  {id:'chan',label:'Channels',emo:'📡',cnt:()=>CHAN?String(CHAN.channels.length):''},
  {id:'recos',label:'Recommendations',emo:'💡',cnt:()=>DATA?String(activeDailyRecommendationCount()):''},
  {id:'roadmap',label:'Roadmap',emo:'🗓️',cnt:()=>DATA?String(DATA.roadmap.length):''},
  {id:'ana',label:'Analysis',emo:'🔬',cnt:()=>DATA&&DATA.ours?String(DATA.ours.filter(v=>v.pub&&(v.durH==null||v.durH>=0.15)).length):''},
  {id:'kw',label:'Keywords',emo:'🔎',small:1,cnt:()=>''}
];
function renderNav(){
  const _frnav=v=>(typeof LANG!=='undefined'&&LANG==='fr'&&typeof FR_NAV!=='undefined'&&FR_NAV[v])?FR_NAV[v]:v;
  document.getElementById('nav').innerHTML=
    '<div class="nav-label">Workspace</div>'+
    VIEWS.map(v=>'<button class="'+(route===v.id?'active':'')+(v.small?' nsmall':'')+'" onclick="go(\''+v.id+'\')"><span class="emo">'+v.emo+'</span><span class="lbl">'+_frnav(v.label)+'</span><span class="count">'+v.cnt()+'</span></button>').join('');
}
function go(r){route=r;try{history.replaceState(null,'','#'+r);}catch(e){}renderNav();render({preferCache:true});window.scrollTo({top:0});
  const sb=document.getElementById('sidebar'),vl=document.getElementById('side-veil');
  if(sb)sb.classList.remove('open');if(vl)vl.classList.remove('show');
}
function viewMarkupForRoute(currentRoute){
  if(currentRoute==='dashboard')return {title:(typeof LANG!=='undefined'&&LANG==='fr')?'Tableau de bord':'Dashboard',html:dashHTML()};
  if(currentRoute==='mix')return {title:'Videos <span class="pill">DAILY SCAN</span>',html:videosHTML('mix')};
  if(currentRoute==='recos')return {title:'Recommendations',html:recosHTML()};
  if(currentRoute==='roadmap')return {title:'Roadmap',html:roadmapHTML()};
  if(currentRoute==='ana')return {title:'',html:anaHTML()};
  if(currentRoute==='live')return {title:'Livestreams <span class="pill">HOURLY SCAN</span>',html:livesHTML()};
  if(currentRoute==='chan')return {title:'Channels <span class="pill">MONTHLY SCAN</span>',html:chanHTML()};
  if(currentRoute==='kw')return {title:'Keywords',html:kwHTML()};
  return {title:'',html:''};
}
function viewCacheKey(currentRoute){return currentRoute+'|'+(typeof LANG!=='undefined'?LANG:'en');}
function viewMarkupWithLanguage(currentRoute){
  const output=viewMarkupForRoute(currentRoute);
  if(typeof LANG!=='undefined'&&LANG==='fr'&&typeof frz==='function')return {title:frz(output.title),html:frz(output.html)};
  return output;
}
function scheduleViewWarmup(){
  if(!DATA)return;
  const token=++VIEW_WARMUP_TOKEN;
  const pending=['dashboard','mix','recos','roadmap','live','chan','kw'].filter(item=>item!==route);
  const warm=()=>{
    if(token!==VIEW_WARMUP_TOKEN||!pending.length)return;
    const current=pending.shift(),key=viewCacheKey(current);
    if(!VIEW_CACHE.has(key))VIEW_CACHE.set(key,viewMarkupWithLanguage(current));
    if(pending.length){
      if('requestIdleCallback' in window)window.requestIdleCallback(warm,{timeout:180});
      else setTimeout(warm,0);
    }
  };
  if('requestIdleCallback' in window)window.requestIdleCallback(warm,{timeout:180});
  else setTimeout(warm,0);
}
function render(options){
  if(!DATA)return;
  if(route==='watch'){route='dashboard';try{history.replaceState(null,'','#dashboard');}catch(e){}renderNav();}
  const t=document.getElementById('view-title'),s=document.getElementById('view-sub'),el=document.getElementById('view');
  const topbar=t&&t.closest('.topbar');
  closeDrawer();
  s.textContent='';
  if(route==='all'||route==='trends'||route==='news'){route='mix';renderNav();render(options);return;}
  const key=viewCacheKey(route),cached=options&&options.preferCache?VIEW_CACHE.get(key):null;
  if(cached){t.innerHTML=cached.title;el.innerHTML=cached.html;i18nView({skipContent:true});}
  else{
    const output=viewMarkupForRoute(route);t.innerHTML=output.title;el.innerHTML=output.html;i18nView();
    VIEW_CACHE.set(key,{title:t.innerHTML,html:el.innerHTML});
  }
  if(topbar)topbar.classList.toggle('no-view-title',route==='ana');
  armAutoLoad();fillLikes();if(route==='ana')fillAnaLikes();
}

/* ================= DASHBOARD ================= */
function dashHTML(){
  const A=DATA.all,T=DATA.trends,N=DATA.news,R=DATA.recos,RD=DATA.roadmap;
  const channels=new Set(A.map(v=>v.channel)).size;
  const L=DATA.lives||[];
  const liveTotal=L.length?L.map(v=>liveNow(v.vid)).filter(x=>x!=null).reduce((s,x)=>s+x,0):null;
  const kpi=(lbl,val,sub,c)=>'<div class="kpi" style="--kc:'+c+'"><div class="k-lbl">'+lbl+'</div><div class="k-val">'+val+'</div><div class="k-sub">'+sub+'</div></div>';
  let h='<div class="kpis">'+
    kpi('Videos audited',fmtInt(A.length),'≥1M views · all time','#ff0033')+
    kpi('Trending now',fmtInt(T.length),'<12 months · ≥500k views','#fbbf24')+
    kpi('Unique channels',fmtInt(channels),'competitive landscape','#f9a8d4')+
    kpi('Livestreams',fmtInt(L.length),liveTotal!=null?fmtN(liveTotal)+' watching right now':'live scan pending','#f87171')+
    kpi('Channels audited',CHAN?fmtInt(CHAN.channels.length):'…',CHAN?fmtN(CHAN.channels.reduce((s,c)=>s+(c.subs||0),0))+' combined subscribers':'loading audit Sheet…','#38bdf8')+
  '</div>';

  const gcount={};A.forEach(v=>{if(v.genre)gcount[v.genre]=(gcount[v.genre]||0)+1;});
  const gsorted=Object.entries(gcount).sort((a,b)=>b[1]-a[1]);
  const gmax=gsorted.length?gsorted[0][1]:1;
  const vel={};T.forEach(v=>{if(v.genre)(vel[v.genre]=vel[v.genre]||[]).push(v.vpm||0);});
  const vsorted=Object.entries(vel).map(([k,a])=>[k,median(a)||0]).sort((a,b)=>b[1]-a[1]);
  const vmax=vsorted.length?vsorted[0][1]:1;
  const vbars=(rows,max,colorFn,fmt)=>'<div class="vchart">'+rows.map(([k,n])=>{
    const c=colorFn(k);
    return '<div class="vcol" title="'+esc(k)+' — '+fmtInt(n)+'"><span class="vval">'+(fmt?fmtN(n):fmtInt(n))+'</span>'+
      '<div class="vbar" style="--f:'+(n/max)+';background:linear-gradient(180deg,'+c+','+c+'99)"></div>'+
      '<span class="vlbl">'+esc(String(k).split('/')[0].trim())+'</span></div>';
  }).join('')+'</div>';
  const chartp=(t,sub,body)=>'<div class="panel chartp"><h3>'+t+'</h3><div class="psub">'+sub+'</div>'+body+'</div>';
  h+='<div class="dash-grid">'+
    chartp('Genre distribution','Number of audited videos per genre · full history, ≥1M views',vbars(gsorted,gmax,gcolor))+
    chartp('Velocity by genre','Median views/month per genre · videos from the last 12 months',vbars(vsorted,vmax,gcolor,true))+
  '</div>';

  const hot=[...T].sort((a,b)=>(b.vpm||0)-(a.vpm||0)).slice(0,5);
  const latest=[...N].sort((a,b)=>(b.added||0)-(a.added||0)).slice(0,5);
  const today=Date.now()-86400000*2;
  const coming=RD.filter(r=>r.date&&r.date>=today).sort((a,b)=>a.date-b.date).slice(0,7);
  const mini=(v,statHTML,kind)=>'<div class="mini-item" onclick="openVid(\''+kind+'\','+JSON.stringify(v.vid||v.title).replace(/"/g,'&quot;')+')">'+
    '<img loading="lazy" src="'+thumb(v.vid)+'" onerror="this.style.visibility=\'hidden\'">'+
    '<div style="min-width:0"><div class="mi-t">'+esc(v.title)+'</div><div class="mi-s">'+statHTML+'</div></div></div>';
  h+='<div class="dash-3">'+
    '<div class="panel"><h3>🔥 Hot right now<span class="link" onclick="VS.mix.age=\'12m\';VS.mix.sort=\'vpm\';go(\'mix\')">View all →</span></h3><div class="psub">Fastest-growing videos published in the last 12 months</div><div class="mini-list">'+
      hot.map(v=>mini(v,'<b>'+fmtN(v.vpm)+'/mo</b><span>'+esc(v.channel)+'</span>','trends')).join('')+'</div></div>'+
    '<div class="panel"><h3>📰 Latest discoveries<span class="link" onclick="VS.mix.age=\'3m\';VS.mix.sort=\'added\';go(\'mix\')">View all →</span></h3><div class="psub">New videos the YouTube algorithm just started pushing · daily scan</div><div class="mini-list">'+
      (latest.length?latest.map(v=>mini(v,'<b>'+fmtN(v.views)+' views</b><span>'+fmtAge(v.ageM)+' old</span>','news')).join(''):'<div class="empty">No discoveries yet</div>')+'</div></div>'+
    '<div class="panel"><h3>🗓️ Coming up<span class="link" onclick="go(\'roadmap\')">Full roadmap →</span></h3><div class="psub">Next planned releases · synced with Monday & rotation proposals</div>'+
      coming.map(r=>{const d=new Date(r.date);return '<div class="rm-mini" style="--gc:'+gcolor(r.genre)+'"><div class="d">'+d.getDate()+' '+MONTHS[d.getMonth()]+'</div><div class="t">'+esc(r.title)+'</div>'+gtag(r.genre,1)+'</div>';}).join('')+'</div>'+
  '</div>';
  const topLives=[...L].sort((a,b)=>(liveNow(b.vid)||0)-(liveNow(a.vid)||0)).slice(0,5);
  window._dash_lives=topLives;
  const topCh=CHAN?[...CHAN.channels].sort((a,b)=>(b.subs||0)-(a.subs||0)).slice(0,5):[];
  window._dash_chans=topCh;
  h+='<div class="dash-2">'+
    '<div class="panel"><h3>📡 Top livestreams<span class="link" onclick="go(\'live\')">View all →</span></h3><div class="psub">Most-watched 24/7 streams on the scan keywords · viewers at last scan</div><div class="mini-list">'+
      (topLives.length?topLives.map((v,i)=>'<div class="mini-item" onclick="openDashLive('+i+')"><img loading="lazy" src="'+thumb(v.vid)+'" onerror="this.style.visibility=\'hidden\'"><div style="min-width:0"><div class="mi-t">'+esc(v.title)+'</div><div class="mi-s"><b>🔴 '+fmtN(liveNow(v.vid))+' watching</b><span>'+esc(v.channel)+'</span></div></div></div>').join(''):'<div class="empty">Live scan pending</div>')+'</div></div>'+
    '<div class="panel"><h3>📺 Top channels<span class="link" onclick="go(\'chan\')">View all →</span></h3><div class="psub">Biggest channels in the competitive audit'+(CHAN?' · '+fmtInt(CHAN.channels.length)+' tracked':'')+'</div><div class="mini-list">'+
      (topCh.length?topCh.map((c,i)=>'<div class="mini-item" onclick="openDashChan('+i+')">'+chAva(c,48)+'<div style="min-width:0"><div class="mi-t">'+esc(c.name)+'</div><div class="mi-s"><b>'+fmtN(c.subs)+' subs</b><span>'+esc(c.niche)+'</span></div></div></div>').join(''):'<div class="empty">Loading the channel audit…</div>')+'</div></div>'+
  '</div>';
  return h;
}
