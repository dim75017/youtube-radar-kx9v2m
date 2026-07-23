/* ================= KEYWORDS ================= */
const KEYWORDS=["8 hours sleep music", "80s synthwave mix", "acoustic guitar for focus", "acoustic guitar for meditate", "acoustic guitar for read", "acoustic guitar for relax", "acoustic guitar for sleep", "acoustic guitar for study", "acoustic guitar for work", "acoustic guitar for write", "acoustic study music", "ADHD focus music", "airplane ambience music", "airplane lofi mix", "ambient for code", "ambient for focus", "ambient for meditate", "ambient for read", "ambient for relax", "ambient for sleep", "ambient for study", "ambient for work", "ambient music", "ambient music 3 hours", "ambient sleep music", "anime lofi", "anime lofi study mix", "asian lofi mix", "autumn ambient mix", "autumn bossa nova mix", "autumn jazz mix", "autumn jazzhop mix", "autumn lofi hip hop mix", "autumn lofi mix", "autumn piano mix", "autumn sleep music mix", "autumn synthwave mix", "balcony ambience music", "balcony lofi mix", "bedroom ambience music", "bedroom lofi mix", "black screen sleep music", "bookstore ambience music", "bookstore lofi mix", "bossa nova cafe", "bossa nova for code", "bossa nova for focus", "bossa nova for meditate", "bossa nova for read", "bossa nova for relax", "bossa nova for sleep", "bossa nova for study", "bossa nova for work", "bossa nova for write", "brown noise sleep", "cafe ambience music", "cafe lofi mix", "calm background music", "calm music for sleep", "castle library ambience music", "chill synthwave", "chillhop essentials mix", "classical music for code", "classical music for focus", "classical music for meditate", "classical music for read", "classical music for reading", "classical music for relax", "classical music for sleep", "classical music for study", "classical music for work", "classical music for write", "classical piano music", "classroom ambience music", "classroom lofi mix", "coding music mix", "coffee shop ambience", "coffee shop ambience music", "coffee shop jazz", "coffee shop lofi", "coffee shop lofi mix", "cozy ambience", "cozy ambient mix", "cozy bedroom ambience", "cozy bossa nova mix", "cozy coffee shop music", "cozy gaming playlist", "cozy jazz mix", "cozy jazzhop mix", "cozy lofi", "cozy lofi hip hop mix", "cozy lofi mix", "cozy piano mix", "cozy playlist", "cozy sleep music mix", "cozy synthwave mix", "cyberpunk ambience", "cyberpunk music mix", "dark academia ambience", "dark academia jazz", "dark academia piano", "dark academia playlist", "dark academia reading music", "dark academia study music", "dark ambient music", "dark synthwave mix", "deep focus music", "deep sleep music", "dreamy lofi mix", "dreamy piano playlist", "emotional piano music", "fantasy ambience for code", "fantasy ambience for focus", "fantasy ambience for meditate", "fantasy ambience for read", "fantasy ambience for relax", "fantasy ambience for sleep", "fantasy ambience for study", "fantasy ambience for work", "fantasy ambience for write", "fantasy ambience music", "fantasy lofi", "fantasy study music", "fireplace ambience", "focus ambient music", "focus music", "foggy ambient mix", "foggy bossa nova mix", "foggy jazz mix", "foggy jazzhop mix", "foggy lofi hip hop mix", "foggy lofi mix", "foggy sleep music mix", "forest ambience", "forest ambience for reading", "forest ambience music", "forest lofi mix", "ghibli lofi", "healing ambient music", "healing sleep music", "japanese garden ambience music", "japanese garden lofi mix", "japanese jazz mix", "japanese lofi mix", "jazz for code", "jazz for focus", "jazz for meditate", "jazz for read", "jazz for relax", "jazz for sleep", "jazz for study", "jazz for studying", "jazz for work", "jazz for write", "jazz mix 1 hour", "jazz piano background", "jazzhop for code", "jazzhop for focus", "jazzhop for meditate", "jazzhop for read", "jazzhop for relax", "jazzhop for sleep", "jazzhop for study", "jazzhop for work", "jazzhop for write", "lake ambience music", "lake lofi mix", "late night ambient mix", "late night bossa nova mix", "late night jazz", "late night jazz mix", "late night jazzhop mix", "late night lofi hip hop mix", "late night lofi mix", "late night piano mix", "late night playlist", "late night sleep music mix", "late night synthwave mix", "library ambience", "library ambience music", "library lofi mix", "library rain ambience", "lofi beats", "lofi chill mix", "lofi focus", "lofi for code", "lofi for focus", "lofi for meditate", "lofi for read", "lofi for relax", "lofi for sleep", "lofi for study", "lofi for work", "lofi for write", "lofi hip hop for code", "lofi hip hop for focus", "lofi hip hop for meditate", "lofi hip hop for read", "lofi hip hop for relax", "lofi hip hop for sleep", "lofi hip hop for study", "lofi hip hop for work", "lofi hip hop for write", "lofi hip hop mix", "lofi jazz", "lofi jazz mix", "lofi mix 1 hour", "lofi mix 3 hours", "lofi rain", "lofi sleep", "lofi study music", "lost in thoughts playlist", "medieval lofi", "medieval lofi for code", "medieval lofi for focus", "medieval lofi for meditate", "medieval lofi for read", "medieval lofi for relax", "medieval lofi for sleep", "medieval lofi for study", "medieval lofi for work", "medieval lofi for write", "medieval music for studying", "medieval tavern ambience", "meditation music", "meditation music 3 hours", "meditation piano", "meditation sleep music", "morning ambient mix", "morning bossa nova mix", "morning jazz mix", "morning jazzhop mix", "morning light playlist", "morning lofi", "morning lofi hip hop mix", "morning lofi mix", "morning piano mix", "morning piano music", "morning sleep music mix", "morning synthwave mix", "music for a quiet heart", "music for adhd focus", "music for chess", "music for cleaning", "music for concentration", "music for cooking", "music for deep work", "music for drawing", "music for gaming", "music for insomnia", "music for journaling", "music for overthinking", "music for painting", "music for plants", "music for productivity", "music for reading books", "music for sleeping 8 hours", "music for slow living", "music for when you feel lost", "music for writing", "music for writing a novel", "music that feels like a warm hug", "music that feels like autumn", "music that feels like midnight", "music that feels like morning light", "music that feels like playlist", "music to make your brain shut up", "nature ambient music", "night bus ambience music", "night bus lofi mix", "night drive mix", "night drive synthwave", "night lofi", "night train ambience", "nostalgic ambient mix", "nostalgic bossa nova mix", "nostalgic jazz mix", "nostalgic jazzhop mix", "nostalgic lofi hip hop mix", "nostalgic lofi mix", "nostalgic piano mix", "nostalgic sleep music mix", "nostalgic synthwave mix", "ocean ambience for sleep", "old books reading playlist", "outrun mix", "peaceful ambient mix", "peaceful bossa nova mix", "peaceful jazz mix", "peaceful jazzhop mix", "peaceful lofi hip hop mix", "peaceful lofi mix", "peaceful piano", "peaceful piano mix", "peaceful playlist", "peaceful sleep music mix", "peaceful synthwave mix", "piano for focus", "piano for meditate", "piano for read", "piano for relax", "piano for sleep", "piano for study", "piano for studying", "piano for work", "piano for write", "piano music", "piano music 1 hour", "piano reading music", "piano sleep music", "playlist for a cozy night", "playlist for a peaceful afternoon", "playlist for a slow morning", "playlist for rainy days", "playlist for reading old books", "playlist for studying at 3am", "pov you are driving through a neon city", "pov you are on a night train", "pov you are reading in a cafe", "pov you are studying in a library", "productivity music", "quiet ambient mix", "quiet bossa nova mix", "quiet jazz mix", "quiet jazzhop mix", "quiet lofi hip hop mix", "quiet lofi mix", "quiet piano mix", "quiet playlist", "quiet sleep music mix", "quiet synthwave mix", "rain ambience", "rain sleep sounds", "rainy ambient mix", "rainy bossa nova mix", "rainy coffee shop ambience", "rainy day playlist", "rainy jazz", "rainy jazz mix", "rainy jazzhop mix", "rainy lofi hip hop mix", "rainy lofi mix", "rainy piano mix", "rainy piano music", "rainy sleep music mix", "rainy synthwave mix", "reading ambience", "reading music", "relaxing guitar music", "relaxing jazz", "relaxing music", "relaxing music for anxiety", "relaxing music for stress relief", "relaxing piano music", "relaxing sleep music", "retro gaming music mix", "retrowave mix", "river ambience music", "river lofi mix", "rooftop ambience music", "rooftop lofi mix", "sad lofi mix", "sci fi ambient music", "seaside ambience music", "seaside lofi mix", "sleep music", "sleep music 8 hours", "sleep music for code", "sleep music for focus", "sleep music for meditate", "sleep music for read", "sleep music for relax", "sleep music for sleep", "sleep music for study", "sleep music for work", "sleep music for write", "smooth jazz mix", "snowy ambient mix", "snowy bossa nova mix", "snowy jazz mix", "snowy jazzhop mix", "snowy lofi hip hop mix", "snowy lofi mix", "snowy piano mix", "snowy sleep music mix", "snowy synthwave mix", "soft piano playlist", "spa music", "space ambient mix", "space ambient music", "space station ambience music", "space synthwave mix", "study music", "study playlist", "summer ambient mix", "summer bossa nova mix", "summer jazz mix", "summer jazzhop mix", "summer lofi", "summer lofi hip hop mix", "summer lofi mix", "summer piano mix", "summer sleep music mix", "summer synthwave mix", "sunrise ambient mix", "sunrise bossa nova mix", "sunrise jazz mix", "sunrise jazzhop mix", "sunrise lofi hip hop mix", "sunrise lofi mix", "sunrise piano mix", "sunrise sleep music mix", "sunrise synthwave mix", "sunset ambient mix", "sunset bossa nova mix", "sunset jazz mix", "sunset jazzhop mix", "sunset lofi hip hop mix", "sunset lofi mix", "sunset piano mix", "sunset sleep music mix", "sunset synthwave mix", "synthwave for focus", "synthwave for meditate", "synthwave for read", "synthwave for relax", "synthwave for sleep", "synthwave for study", "synthwave for work", "synthwave gaming mix", "synthwave mix", "synthwave study music", "tavern ambience music", "train ambience for studying", "train ambience music", "train lofi mix", "university library ambience music", "university library lofi mix", "vaporwave mix", "white noise sleep", "winter ambient mix", "winter bossa nova mix", "winter jazz mix", "winter jazzhop mix", "winter lofi hip hop mix", "winter lofi mix", "winter piano mix", "winter sleep music mix", "winter synthwave mix", "work music", "zen music"];
const INSTRUMENTAL_EXPANSION_KEYWORDS=[
  'chill house instrumental','chill house instrumental mix','lofi house instrumental','lo-fi house instrumental','deep house instrumental','ambient house instrumental','downtempo house instrumental','chill house for work','chill house for study',
  'drum and bass instrumental','drum & bass instrumental','dnb instrumental','liquid drum and bass instrumental','liquid dnb instrumental','chill dnb instrumental','ambient drum and bass','drum and bass for work','liquid dnb for study',
  'phonk instrumental','phonk instrumental mix','instrumental phonk mix','chill phonk instrumental','lofi phonk instrumental','ambient phonk instrumental','drift phonk instrumental','phonk no vocals','phonk no lyrics','phonk for focus instrumental','phonk for work instrumental','phonk for study instrumental',
  'gym music instrumental','gym playlist instrumental','workout music instrumental','workout instrumental mix','fitness music instrumental','training music instrumental','running music instrumental','cardio music instrumental','weightlifting music instrumental','high energy instrumental mix',
  'gaming music instrumental','gaming playlist instrumental','gaming background music instrumental','gameplay music instrumental','electronic gaming mix instrumental','focus gaming music instrumental','chill gaming music instrumental','ambient gaming music instrumental','gaming music long mix','video game music instrumental mix',
  'car music instrumental','car playlist instrumental','driving music instrumental','driving instrumental mix','road trip instrumental mix','night drive instrumental mix','highway music instrumental','late night drive instrumental','car music for driving instrumental','long drive music instrumental'
];
function scanKeywords(){return [...new Set([...KEYWORDS,...INSTRUMENTAL_EXPANSION_KEYWORDS])];}
let KWQ='';
function kwCounts(){
  if(window._kwc)return window._kwc;
  const c={};scanKeywords().forEach(k=>c[k.toLowerCase()]=0);
  const tally=(s,sep)=>{if(!s)return;s.split(sep).forEach(x=>{const k=x.trim().toLowerCase();if(k in c)c[k]++;});};
  DATA.all.forEach(v=>tally(v.kw,';'));
  DATA.news.forEach(v=>tally(v.disc,','));
  window._kwc=c;return c;
}
function kwHTML(){
  const c=kwCounts();
  let list=scanKeywords().map(k=>[k,c[k.toLowerCase()]||0]);
  if(KWQ){const q=KWQ.toLowerCase();list=list.filter(([k])=>k.toLowerCase().includes(q));}
  list.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  let h='<div class="panel" style="margin-bottom:16px"><div class="dw-sec" style="margin:0"><div class="k">🔎 How the radar works</div><div class="v">These '+KEYWORDS.length+' YouTube search queries are scanned on every sync, across all our music niches. Any long instrumental video ranking in the <b>top 100 results</b> of at least one query ends up in All Videos (≥1M views), Trends (<12 months, ≥500k) or News (fresh discoveries). The counter shows how many videos of the radar were found through each query.</div></div></div>';
  h+='<div class="toolbar"><div class="search">'+ICONS.search+'<input placeholder="Filter keywords…" value="'+esc(KWQ)+'" oninput="KWQ=this.value;document.getElementById(\'kw-list\').innerHTML=kwListHTML()"><kbd>/</kbd></div>'+
     '<div class="result-count"><b>'+list.length+'</b> keywords</div></div>';
  h+='<div id="kw-list">'+kwListHTML()+'</div>';
  return h;
}
function kwListHTML(){
  const c=kwCounts();
  let list=scanKeywords().map(k=>[k,c[k.toLowerCase()]||0]);
  if(KWQ){const q=KWQ.toLowerCase();list=list.filter(([k])=>k.toLowerCase().includes(q));}
  list.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  return '<div class="kw-grid">'+list.map(([k,n])=>
    '<div class="kw-item" data-kw="'+esc(k)+'" title="See the radar videos found through this query" onclick="kwGo(this.dataset.kw)">'+
    '<span class="kw-name">'+esc(k)+'</span><span class="kw-n'+(n?'':' zero')+'">'+n+'</span></div>').join('')+'</div>';
}
function kwGo(k){VS.mix.q=k;VS.mix.limit=60;VS.mix.age='all';go('mix');}


/* ================= VIDEO VIEWS ================= */
const SORTS={
  vpm:{lbl:'Velocity (views/mo)',emoji:'🚀',fn:(a,b)=>(b.vpm||0)-(a.vpm||0)},
  views:{lbl:'Total views',emoji:'👀',fn:(a,b)=>(b.views||0)-(a.views||0)},
  newest:{lbl:'Newest first',emoji:'🆕',fn:(a,b)=>(b.pub||0)-(a.pub||0)},
  oldest:{lbl:'Oldest first',emoji:'📜',fn:(a,b)=>(a.pub||0)-(b.pub||0)},
  dur:{lbl:'Duration',emoji:'⏱️',fn:(a,b)=>(b.durH||0)-(a.durH||0)},
  subs:{lbl:'Channel size',emoji:'👥',fn:(a,b)=>(b.subs||0)-(a.subs||0)},
  added:{lbl:'Recently added',emoji:'➕',fn:(a,b)=>(b.added||0)-(a.added||0)}
};
let _mixCache=null,_mixT=0;
function mixRows(){
  if(_mixCache&&_mixT===SYNCED)return _mixCache;
  const m=new Map();
  const add=arr=>(arr||[]).forEach(v=>{
    const k=v.vid||('t:'+v.title);
    const cur=m.get(k);
    if(!cur)m.set(k,Object.assign({},v));
    else{for(const f in v){if(cur[f]==null||cur[f]==='')cur[f]=v[f];}}
  });
  add(DATA.all);add(DATA.trends);add(DATA.news);
  _mixCache=[...m.values()];_mixT=SYNCED;
  return _mixCache;
}
function ageMonths(v){
  if(v.ageM!=null)return v.ageM;
  if(v.pub)return (Date.now()-v.pub)/2629800000;
  return null;
}
const AGES=[['3m','<span class="age-dot" style="background:#4ade80;box-shadow:0 0 9px rgba(74,222,128,.7)"></span>Last 3 months',3],['6m','<span class="age-dot" style="background:#fbbf24;box-shadow:0 0 9px rgba(251,191,36,.7)"></span>Last 6 months',6],['12m','<span class="age-dot" style="background:#fb923c;box-shadow:0 0 9px rgba(251,146,60,.7)"></span>Last 12 months',12],['all','<span class="age-dot" style="background:#f87171;box-shadow:0 0 9px rgba(248,113,113,.7)"></span>All time',null]];
function inAge(v,code){
  if(code==='all')return true;
  const A=AGES.find(a=>a[0]===code);if(!A)return true;
  const lim=A[2];
  const m=ageMonths(v);
  return m!=null&&m<=lim;
}
function filterVids(kind){
  const st=VS[kind];let rows=(kind==='mix')?mixRows():DATA[kind];
  if(kind==='mix'&&st.age!=='all')rows=rows.filter(v=>inAge(v,st.age));
  if(st.genre)rows=rows.filter(v=>v.genre===st.genre);
  if(st.q){const q=st.q.toLowerCase();rows=rows.filter(v=>(v.title+' '+v.channel+' '+(v.kw||'')+' '+(v.disc||'')).toLowerCase().includes(q));}
  return [...rows].sort(SORTS[st.sort].fn);
}
function setAge(a){VS.mix.age=a;VS.mix.limit=60;render();}
function videosHTML(kind){
  const st=VS[kind];
  const all=(kind==='mix')?mixRows():DATA[kind];
  const rows=filterVids(kind);
  let ageSel='';
  if(kind==='mix'){
    const curAge=AGES.find(a=>a[0]===st.age)||AGES[0];
    const curAgeLabel=(PERIOD_EMOJI[st.age]||'⚪')+' '+curAge[1].replace(/<[^>]*>/g,'');
    const ageOpts=AGES.map(a=>{
      const n=a[2]==null?all.length:all.filter(v=>inAge(v,a[0])).length;
      const label=a[1].replace(/<[^>]*>/g,'');
      return {label:(PERIOD_EMOJI[a[0]]||'⚪')+' '+label+' · '+fmtInt(n),sel:st.age===a[0],onclick:'setAge('+jsq(a[0])+')'};
    });
    ageSel=xdd('c-period',curAgeLabel,ageOpts);
  }
  // The genre menu is contextual: its counts always match the selected
  // period, so a genre with all-time videos cannot misleadingly look present
  // in “last 3 / 6 / 12 months”.
  const periodRows=(kind==='mix'&&st.age!=='all')?all.filter(v=>inAge(v,st.age)):all;
  const genres=[...new Set(all.map(v=>v.genre).filter(Boolean))].sort((a,b)=>
    periodRows.filter(v=>v.genre===b).length-periodRows.filter(v=>v.genre===a).length||a.localeCompare(b)
  );
  const sortKeys=kind==='news'?['added','vpm','views','newest','dur']:(kind==='mix'?['vpm','views','newest','oldest','dur','subs','added']:['vpm','views','newest','oldest','dur','subs']);
  const genreOpts=[{label:'🎵 All genres',sel:!st.genre,onclick:'VS.'+kind+'.genre=\'\';VS.'+kind+'.limit=60;render()'}].concat(
    genres.map(g=>({label:genreEmoji(g)+' '+esc(g)+' · '+periodRows.filter(v=>v.genre===g).length,sel:st.genre===g,onclick:'VS.'+kind+'.genre='+jsq(g)+';VS.'+kind+'.limit=60;render()'}))
  );
  const genreLabel=st.genre?(genreEmoji(st.genre)+' '+esc(st.genre)):'🎵 All genres';
  const sortOpts=sortKeys.map(k=>({label:(SORTS[k].emoji||'⚡')+' Sort · '+SORTS[k].lbl,sel:st.sort===k,onclick:'VS.'+kind+'.sort='+jsq(k)+';rerenderList('+jsq(kind)+')'}));
  const sortLabel=(SORTS[st.sort].emoji||'⚡')+' Sort · '+SORTS[st.sort].lbl;
  let h='<div class="toolbar">'+
    '<div class="search">'+ICONS.search+'<input id="q-'+kind+'" placeholder="Search titles, channels, keywords…" value="'+esc(st.q)+'" oninput="VS.'+kind+'.q=this.value;VS.'+kind+'.limit=60;rerenderList(\''+kind+'\')"><kbd>/</kbd></div>'+
    ageSel+
    xdd('c-genre',genreLabel,genreOpts)+
    '<div class="tb-right">'+xdd('c-sort',sortLabel,sortOpts)+
    '<div class="viewtoggle">'+
      '<button class="'+(st.mode==='grid'?'on':'')+'" onclick="VS.'+kind+'.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(st.mode==='table'?'on':'')+'" onclick="VS.'+kind+'.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div></div>'+
  '</div>';
  h+='<div id="list-'+kind+'">'+listHTML(kind,rows)+'</div>';
  return h;
}
function rerenderList(kind){
  const rows=filterVids(kind);
  const el=document.getElementById('list-'+kind);
  if(el)el.innerHTML=listHTML(kind,rows);
  i18nZone(el);armAutoLoad();fillLikes();
}
function listHTML(kind,rows){
  const st=VS[kind];
  const page=rows.slice(0,st.limit);
  if(!rows.length)return '<div class="empty">Nothing matches — try clearing filters.</div>';
  let h;
  if(st.mode==='grid'){
    h='<div class="vgrid">'+page.map((v,i)=>vcardHTML(kind,v,i)).join('')+'</div>';
  }else{
    h='<table class="vtable"><thead><tr><th></th><th>Title</th><th>Views/mo</th><th>Views</th><th>Duration</th><th>Published</th><th>Genre</th><th>Channel</th><th>Subs</th></tr></thead><tbody>'+
      page.map((v,i)=>'<tr class="row" onclick="openIdx(\''+kind+'\','+i+')">'+
        '<td><img class="tthumb" loading="lazy" src="'+thumb(v.vid)+'" onerror="this.style.visibility=\'hidden\'"></td>'+
        '<td class="ttitle">'+esc(v.title)+scanNewBadge(v,true)+'</td>'+
        '<td class="num vpmcell">'+fmtN(v.vpm)+'</td><td class="num">'+fmtN(v.views)+'</td>'+
        '<td class="num">'+fmtDur(v.durH)+'</td><td class="num">'+fmtDate(v.pub)+'</td>'+
        '<td>'+gtag(v.genre)+'</td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(v.channel)+'</td>'+
        '<td class="num">'+fmtN(subsFor(v))+'</td></tr>').join('')+'</tbody></table>';
  }
  if(rows.length>st.limit)h+='<button class="load-more" onclick="VS.'+kind+'.limit+=120;rerenderList(\''+kind+'\')">Loading more · '+fmtInt(rows.length-st.limit)+' remaining</button>';
  window['_page_'+kind]=page;
  return h;
}
function vcardHTML(kind,v,i){
  return '<div class="vcard" onclick="openIdx(\''+kind+'\','+i+')">'+
    '<div class="thumbwrap">'+scanNewBadge(v,false)+'<img loading="lazy" src="'+thumb(v.vid)+'" onerror="this.src=\'https://i.ytimg.com/vi/'+(v.vid||'')+'/hqdefault.jpg\';this.onerror=null;">'+
      (v.vid?'<span class="like-flag" style="display:none" data-likes="'+v.vid+'"></span>':'')+
      (v.durH!=null?'<span class="dur">'+fmtDur(v.durH)+'</span>':'')+'</div>'+
    '<div class="vbody">'+
      '<div class="vtitle">'+esc(v.title)+'</div>'+
      '<div class="vmeta">'+vChanAva(v,17)+'<a href="'+esc(v.chUrl||'#')+'" target="_blank" onclick="event.stopPropagation()">'+esc(v.channel)+'</a><span class="subs">· '+fmtN(subsFor(v))+' subs</span></div>'+
      '<div class="vtags">'+gtag(v.genre,0,true)+'</div>'+
      '<div class="vstats">'+
        '<div class="vstat hl"><b>'+fmtN(v.vpm)+'</b><span>views/mo</span></div>'+
        '<div class="vstat"><b>'+fmtN(v.views)+'</b><span>views</span></div>'+
        '<div class="vstat"><b>'+fmtAge(v.ageM)+'</b><span>age</span></div>'+
        '<div class="vstat"><b>'+fmtDate(v.pub)+'</b><span>published</span></div>'+
      '</div></div></div>';
}

function isScanNew(v){
  const added=Number(v&&v.added),age=ageMonths(v||{});
  const since=Date.now()-added;
  return Number.isFinite(added)&&age!=null&&age>=0&&age<=3&&since>=-10*60000&&since<=7*86400000;
}
function scanNewBadge(v,inline){
  return isScanNew(v)?'<span class="scan-new'+(inline?' inline':'')+'" title="Detected by the daily scan in the last 7 days">NEW</span>':'';
}

/* ================= DRAWER ================= */
function openIdx(kind,i){const v=(window['_page_'+kind]||[])[i];if(v)openDrawer(kind,v);}
function openVid(kind,key){
  const v=DATA[kind].find(x=>x.vid===key||x.title===key);if(v)openDrawer(kind,v);
}
function openDrawer(kind,v,keepHistoryPeriod,historyReload){
  if(!keepHistoryPeriod)VIDEO_HIST_PERIOD='d7';
  window._openVideoDrawer={kind,v};
  if(v.vid&&!videoHistoryReady(v.vid)&&!videoHistoryBusy(v.vid)&&!videoHistoryError(v.vid)&&!historyReload)ensureVideoHistory(v.vid);
  const sec=(k,val,icon)=>val?'<div class="dw-sec"><div class="k">'+(icon||'')+' '+k+'</div><div class="v">'+esc(val)+'</div></div>':'';
  let extra='';
  if(kind==='mix'){
    extra=sec('Why trending / notable',v.why,'🔥')+sec('Lofi Girl suggestion',v.sugg||v.angle,'💡')+sec('What to copy',stripCopyLead(v.copy),'🎯')+sec('Musical direction',v.musical,'🎼')+sec('Visual direction',v.visual,'🎨')+
      sec('Discovery keywords',v.disc,'🔎')+
      (v.rank?sec('Best search rank','#'+Math.round(v.rank),'🏁'):'')+
      (v.added?sec('First seen by the scan',fmtDateFull(v.added),'🗓️'):'')+
      sec('Found via search keywords',v.kw,'🔎')+sec('Title pattern',v.pattern,'✏️');
  }else if(kind==='trends'){
    extra=sec('Why trending',v.why,'🔥')+sec('Lofi Girl suggestion',v.sugg,'💡')+sec('What to copy',stripCopyLead(v.copy),'🎯')+sec('Musical direction',v.musical,'🎼')+sec('Visual direction',v.visual,'🎨');
  }else if(kind==='news'){
    extra=sec('Why notable',v.why,'📌')+sec('Lofi Girl angle',v.angle,'💡')+sec('Discovery keywords',v.disc,'🔎')+
      (v.rank?sec('Best search rank','#'+Math.round(v.rank),'🏁'):'')+
      (v.days?sec('Days surfaced',String(Math.round(v.days)),'📅'):'')+
      (v.added?sec('Added to scan',fmtDateFull(v.added),'🗓️'):'');
  }else{
    extra=sec('Found via search keywords',v.kw,'🔎')+sec('Title pattern',v.pattern,'✏️');
  }
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    (v.vid?'<div class="dw-embed"><iframe src="https://www.youtube.com/embed/'+v.vid+'?rel=0" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>':'')+
    '<div class="dw-body">'+
      '<div class="dw-title"><a href="'+esc(v.url)+'" target="_blank">'+esc(v.title)+'</a></div>'+
      '<div class="dw-sub">'+gtag(v.genre,0,true)+
        '<span class="tag ghost" style="gap:6px">'+vChanAva(v,18)+(v.chUrl?'<a href="'+esc(v.chUrl)+'" target="_blank" style="color:inherit">'+esc(v.channel)+' ↗</a>':esc(v.channel))+'</span>'+
        '<span class="tag ghost">'+fmtN(subsFor(v))+' subs</span>'+likeTag(v.vid)+'</div>'+
      '<div class="dw-stats">'+
        '<div class="dw-stat hl"><b>'+fmtN(v.vpm)+'</b><span>views/mo</span></div>'+
        '<div class="dw-stat"><b>'+fmtN(v.views)+'</b><span>views</span></div>'+
        '<div class="dw-stat"><b>'+fmtDur(v.durH)+'</b><span>duration</span></div>'+
        '<div class="dw-stat"><b>'+fmtAge(v.ageM)+'</b><span>age</span></div>'+
      '</div>'+
      '<div class="dw-sec">'+videoHistoryPanel(v.vid,DATA.hist&&v.vid?DATA.hist[v.vid]:null,false)+'</div>'+
      extra+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  fillLikes();i18nDrawer();
}
function closeDrawer(){
  const dw=document.getElementById('drawer');
  dw.classList.remove('show');
  document.getElementById('backdrop').classList.remove('show');
  window._drawerRecoN=null;window._drawerReopen=null;
  window._openVideoDrawer=null;
  window._openAnaVid=null;
  setTimeout(()=>{if(!dw.classList.contains('show'))dw.innerHTML='';},220);
}
const IO=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){IO.unobserve(e.target);e.target.click();}})},{rootMargin:'600px'});
function armAutoLoad(){document.querySelectorAll('.load-more').forEach(b=>IO.observe(b));}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeDrawer();
  if(e.key==='/'&&!/input|select|textarea/i.test(document.activeElement.tagName)){
    e.preventDefault();const inp=document.querySelector('.search input');if(inp)inp.focus();
  }
});
