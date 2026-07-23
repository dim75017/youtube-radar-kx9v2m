/* ================= RECOMMENDATIONS ================= */
function validState(v){
  if(!v||v==='')return '';
  if(/^-\s*$/.test(v))return 'no';
  if(/^-\s*·/.test(v))return 'nonote';
  if(/^x\s*$/i.test(v))return 'x';
  if(/^x\s*·/i.test(v))return 'xnote';
  return 'note';
}
function noteOf(v){const m=String(v||'').match(/^[x-]\s*·\s*([\s\S]*)$/i);if(m)return m[1];const s=validState(v);return (s==='note')?String(v):'';}
function isValidated(v){return ['x','xnote'].includes(validState(v));}
function isRefused(v){return ['no','nonote'].includes(validState(v));}
function setValid(n,mode,btn,ev,opts){
  if(ev)ev.stopPropagation();
  clearTimeout(_cmtTimer);
  const rec=DATA.recos.find(x=>x.n===n);if(!rec)return;
  const ta=document.getElementById('cta-dw');
  const note=(window._drawerRecoN===n&&ta)?ta.value.trim():noteOf(rec.valid);
  let val;
  if(mode==='X') val=note?('X · '+note):'X';
  else if(mode==='-') val=note?('- · '+note):'-';
  else val=note||'';
  // UI optimiste : appliquer l'état + ouvrir le popup de placement tout de suite,
  // sans attendre le round-trip Google Apps Script (souvent 3-6s).
  const wasVal=isValidated(rec.valid);
  rec.valid=val;
  saveCache(DATA);
  rerenderRecos();
  if(window._drawerRecoN===n&&document.getElementById('drawer').classList.contains('show')&&window._drawerReopen){
    window._drawerReopen();
  }
  if(!wasVal&&isValidated(val)&&!(opts&&opts.skipSchedulePopup))openSchedulePopup(rec);
  writeValid(n,val,btn);
}
const WRITE_URL='https://script.google.com/macros/s/AKfycbynEewHZzfecwty-E5TV4Otgsxi3ieGy_N5PPYiM7GpPeMVz_5ka1rxY-Y67H3eknto4w/exec';
const WRITE_KEY='lofiradar2026kx';
async function writeValid(n,val,btn){
  try{
    const r=await fetch(WRITE_URL+'?k='+WRITE_KEY+'&n='+encodeURIComponent(n)+'&val='+encodeURIComponent(val));
    const j=await r.json();
    if(!j.ok)throw new Error(j.err||'write failed');
  }catch(e){
    console.error('Sheet write failed for reco '+n,e);
    const fr=typeof LANG!=='undefined'&&LANG==='fr';
    alert(fr
      ?('L\'affichage est à jour, mais la sauvegarde dans le Google Sheet a échoué pour ce changement : '+e.message+'. Réessaie dans un instant.')
      :('The display is up to date, but saving this change to the Google Sheet failed: '+e.message+'. Try again in a moment.'));
  }
}
function toggleValidate(n,btn){
  const rec=DATA.recos.find(x=>x.n===n);if(!rec)return;
  const note=noteOf(rec.valid);
  const isVal=/^x/i.test(String(rec.valid||'').trim());
  const val=isVal?(note||''):(note?'X · '+note:'X');
  writeValid(n,val,btn);
}
function toggleCommentPop(i,ev){
  if(ev)ev.stopPropagation();
  const box=document.getElementById('cpop'+i);if(!box)return;
  const show=box.style.display!=='block';
  box.style.display=show?'block':'none';
  const ta=document.getElementById('cta'+i);if(ta&&show)ta.focus();
}
let _cmtTimer=null;
function autoSaveComment(n){
  clearTimeout(_cmtTimer);
  const stat=document.getElementById('cstat-dw');
  if(stat){stat.textContent='…';stat.style.color='var(--dim)';}
  _cmtTimer=setTimeout(()=>{
    const ta=document.getElementById('cta-dw');if(!ta)return;
    const rec=DATA.recos.find(x=>x.n===n);if(!rec)return;
    const cur=validState(rec.valid);
    const txt=ta.value.trim();
    let val;
    if(cur==='x'||cur==='xnote') val=txt?('X · '+txt):'X';
    else if(cur==='no'||cur==='nonote') val=txt?('- · '+txt):'-';
    else val=txt;
    fetch(WRITE_URL+'?k='+WRITE_KEY+'&n='+encodeURIComponent(n)+'&val='+encodeURIComponent(val))
      .then(r=>r.json()).then(j=>{
        if(!j.ok)throw new Error(j.err||'write failed');
        rec.valid=val;saveCache(DATA);rerenderRecos();
        const fr=typeof LANG!=='undefined'&&LANG==='fr';
        const s=document.getElementById('cstat-dw');
        const okTxt=fr?'✓ Enregistré':'✓ Saved';
        if(s){s.textContent=okTxt;s.style.color='var(--green)';setTimeout(()=>{if(s&&s.textContent===okTxt)s.textContent='';},1600);}
      }).catch(e=>{const fr=typeof LANG!=='undefined'&&LANG==='fr';const s=document.getElementById('cstat-dw');if(s){s.textContent=fr?'⚠ Non enregistré':'⚠ Not saved';s.style.color='var(--red)';}console.error(e);});
  },700);
}
function legacyFilterRecos(){
  let rows=DATA.recos;
  if(RS.genre)rows=rows.filter(r=>(r.genre||'(unset)')===RS.genre);
  if(RS.pot)rows=rows.filter(r=>r.pot&&r.pot.startsWith(RS.pot));
  if(RS.perso)rows=rows.filter(r=>persoCategory(r.perso)===RS.perso);
  if(RS.val==='x')rows=rows.filter(r=>isValidated(r.valid));
  else if(RS.val==='refused')rows=rows.filter(r=>isRefused(r.valid));
  else if(RS.val==='pending')rows=rows.filter(r=>!isValidated(r.valid)&&!isRefused(r.valid));
  if(RS.q){const q=RS.q.toLowerCase();rows=rows.filter(r=>(r.title+' '+r.niche+' '+r.concept+' '+r.perso+' '+r.kw).toLowerCase().includes(q));}
  const sf=RS.sort;
  return [...rows].sort((a,b)=>sf==='n'?(a.n-b.n):(((b[sf]!=null?b[sf]:b.score)||0)-((a[sf]!=null?a[sf]:a.score)||0)));
}
function legacyRecosHTML(){
  const all=DATA.recos;
  const rows=filterRecos();
  const genres=[...new Set(all.map(r=>r.genre||'(unset)'))].sort();
  const persos=PERSO_ORDER.filter(c=>all.some(r=>persoCategory(r.perso)===c));
  const genreOpts=[{label:'🎵 All genres',sel:!RS.genre,onclick:"RS.genre='';RS.limit=80;rerenderRecos()"}].concat(
    genres.map(g=>({label:esc(g)+' · '+all.filter(r=>(r.genre||'(unset)')===g).length,sel:RS.genre===g,onclick:'RS.genre='+jsq(g)+';RS.limit=80;rerenderRecos()'})));
  const genreLabel=RS.genre?esc(RS.genre):'🎵 All genres';
  const potLbls=(typeof LANG!=='undefined'&&LANG==='fr')?{S:'S — Rente potentielle',A:'A — Fort',B:'B — Solide',C:'C — Niche / à tester'}:{S:'S — Steady income',A:'A — Strong',B:'B — Solid',C:'C — Niche / to test'};
  const potOpts=[{label:'⚪ All potential',sel:!RS.pot,onclick:"RS.pot='';rerenderRecos()"}].concat(
    ['S','A','B','C'].map(p=>({label:tierEmoji(p)+' '+potLbls[p],sel:RS.pot===p,onclick:'RS.pot='+jsq(p)+';rerenderRecos()'})));
  const potLabel=RS.pot?(tierEmoji(RS.pot)+' '+potLbls[RS.pot]):'⚪ All potential';
  const charOpts=[{label:'🎭 All characters',sel:!RS.perso,onclick:"RS.perso='';rerenderRecos()"}].concat(
    persos.map(p=>({label:personaEmoji(p)+' '+esc(p),sel:RS.perso===p,onclick:'RS.perso='+jsq(p)+';rerenderRecos()'})));
  const charLabel=RS.perso?(personaEmoji(RS.perso)+' '+esc(RS.perso)):'🎭 All characters';
  const statusOpts=[
    {label:'✅ Validated',sel:RS.val==='x',onclick:"RS.val='x';rerenderRecos()"},
    {label:'⏳ Pending review',sel:RS.val==='pending',onclick:"RS.val='pending';rerenderRecos()"},
    {label:'❌ Refused',sel:RS.val==='refused',onclick:"RS.val='refused';rerenderRecos()"}
  ];
  const statusLabel=RS.val==='x'?'✅ Validated':RS.val==='pending'?'⏳ Pending review':RS.val==='refused'?'❌ Refused':'🗂️ All status';
  const rsSortKeys=[['scoreAdj','⚡','Adjusted score'],['score','🎯','Score'],['conf','🔍','Confidence'],['n','🔢','N°']];
  const sortOpts=rsSortKeys.map(s=>({label:s[1]+' '+s[2],sel:RS.sort===s[0],onclick:'RS.sort='+jsq(s[0])+';rerenderRecos()'}));
  const sortRow=rsSortKeys.find(s=>s[0]===RS.sort)||rsSortKeys[0];
  const sortLabel=sortRow[1]+' '+sortRow[2];
  let h='<div class="toolbar">'+
    '<div class="search">'+ICONS.search+'<input placeholder="Search concepts, titles, niches…" value="'+esc(RS.q)+'" oninput="RS.q=this.value;RS.limit=80;rerenderRecos()"><kbd>/</kbd></div>'+
    '<div class="tb-right">'+
    xdd('c-genre',genreLabel,genreOpts)+
    xdd('c-tier',potLabel,potOpts)+
    xdd('c-char',charLabel,charOpts)+
    xdd('c-status',statusLabel,statusOpts)+
    xdd('c-sort',sortLabel,sortOpts)+
    '<div class="viewtoggle">'+
      '<button class="'+(RS.mode!=='table'?'on':'')+'" onclick="RS.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(RS.mode==='table'?'on':'')+'" onclick="RS.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div>'+
    '</div>'+
  '</div>';
  h+='<div id="reco-list">'+recoListHTML(rows)+'</div>';
  return h;
}
function legacyRerenderRecos(){
  const rows=filterRecos();
  const el=document.getElementById('reco-list');if(el){el.innerHTML=recoListHTML(rows);i18nZone(el);}
  const rc=document.querySelector('.result-count');if(rc)rc.innerHTML='<b>'+fmtInt(rows.length)+'</b> concepts';
  armAutoLoad();
}
/* Daily recommendation rotation: the large source catalogue stays intact; this view exposes 50 actionable ideas. */
const RECO_DAILY_LIMIT=50;
const RECO_ROTATION_KEY='lofi_radar_reco_rotation_v1';
function recoDayKey(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>p.find(x=>x.type===t).value;
  return get('year')+'-'+get('month')+'-'+get('day');
}
function recoHash(v){let h=2166136261;const s=String(v);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function recoTokens(r){
  const stop=new Set(['avec','dans','pour','the','and','from','lofi','music','radio','mix','video','youtube','ambient','chill']);
  return [...new Set((String(r.title||'')+' '+String(r.concept||'')+' '+String(r.niche||'')+' '+String(r.kw||''))
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]{4,}/g)||[])].filter(x=>!stop.has(x)).slice(0,18);
}
function recoRotationHistory(){try{return JSON.parse(localStorage.getItem(RECO_ROTATION_KEY)||'{}')||{};}catch(e){return {};}}
function saveRecoRotation(h){try{localStorage.setItem(RECO_ROTATION_KEY,JSON.stringify(h));}catch(e){}}
function recoAddSignal(map,key,value){if(key)map[key]=(map[key]||0)+value;}
function recoSignal(map,key){return Number(map[key]||0);}
function recoProfile(){
  const p={genre:{},persona:{},token:{},recentGenre:{},feedbackPersona:{},feedbackToken:{},recentVideos:0,feedback:0};
  (DATA.recos||[]).forEach(r=>{
    const feedback=isValidated(r.valid)?3:isRefused(r.valid)?-3:0;if(!feedback)return;
    p.feedback++;recoAddSignal(p.genre,String(r.genre||''),feedback);recoAddSignal(p.persona,persoCategory(r.perso),feedback);
    recoAddSignal(p.feedbackPersona,persoCategory(r.perso),feedback);recoTokens(r).forEach(t=>{recoAddSignal(p.token,t,feedback*.35);recoAddSignal(p.feedbackToken,t,feedback*.35);});
  });
  try{(anaRows()||[]).filter(o=>Number(o.ageM)<=3&&o.reco).forEach(o=>{
    const relative=Number.isFinite(Number(o.pctCh))?Number(o.pctCh)-50:0;
    const ctr=Number(o.st&&o.st.ctr),awp=Number(o.st&&o.st.awp);
    const signal=Math.max(-18,Math.min(18,relative*.22+(Number.isFinite(ctr)?Math.max(-3,Math.min(3,(ctr-4)*.7)):0)+(Number.isFinite(awp)?Math.max(-3,Math.min(3,(awp-35)*.08)):0)));
    if(!signal)return;p.recentVideos++;recoAddSignal(p.genre,String(o.reco.genre||''),signal);recoAddSignal(p.recentGenre,String(o.reco.genre||''),signal);recoAddSignal(p.persona,persoCategory(o.reco.perso),signal*.65);
    recoTokens(o.reco).forEach(t=>recoAddSignal(p.token,t,signal*.18));
  });}catch(e){}
  return p;
}
function recoDailyScore(r,p,day){
  const base=Number(r.scoreAdj!=null?r.scoreAdj:r.score)||0;
  const genre=recoSignal(p.genre,String(r.genre||''));const persona=recoSignal(p.persona,persoCategory(r.perso));
  const terms=recoTokens(r).reduce((sum,t)=>sum+recoSignal(p.token,t),0);const rotation=(recoHash(day+'|'+r.n)%1000)/1000*2.4;
  return base+genre*.9+persona*.55+Math.max(-6,Math.min(6,terms))*.45+rotation;
}
function recoReasons(r,p,day){
  const fr=typeof LANG!=='undefined'&&LANG==='fr',out=[];const base=Math.round(Number(r.scoreAdj!=null?r.scoreAdj:r.score)||0);
  out.push(fr?'Score catalogue '+base:'Catalogue score '+base);
  const genre=recoSignal(p.recentGenre,String(r.genre||''));
  if(Math.abs(genre)>=1.5)out.push((genre>0?(fr?'Signal chaîne récent : ':'Recent channel signal: '):(fr?'Signal à surveiller : ':'Signal to watch: '))+String(r.genre||'—'));
  const feedback=recoTokens(r).reduce((sum,t)=>sum+recoSignal(p.feedbackToken,t),0)+recoSignal(p.feedbackPersona,persoCategory(r.perso));
  if(Math.abs(feedback)>=1.5)out.push(feedback>0?(fr?'Format proche de validations passées':'Close to past validations'):(fr?'Format moins retenu par le passé':'Format less retained in the past'));
  out.push(fr?'Rotation quotidienne':'Daily rotation');return out.slice(0,4);
}
function dailyRecommendationSet(){
  const day=recoDayKey(),history=recoRotationHistory(),profile=recoProfile();
  const candidates=(DATA.recos||[]).filter(r=>!isValidated(r.valid)&&!isRefused(r.valid));
  const decorate=rows=>rows.map(r=>Object.assign({},r,{_dailyScore:recoDailyScore(r,profile,day),_dailyReasons:recoReasons(r,profile,day),_dailyProfile:profile}));
  const todayIds=Array.isArray(history[day])?history[day]:[];
  // A previous version could preserve a larger queue after the daily target
  // was changed. Keep the stored queue stable, but never show more than the
  // current daily limit.
  const activeTodayIds=todayIds.slice(0,RECO_DAILY_LIMIT);
  if(activeTodayIds.length!==todayIds.length){history[day]=activeTodayIds;saveRecoRotation(history);}
  // Keep one stable, finite review queue for the whole day. Decisions remove an
  // idea from this queue instead of instantly filling its place with a new one.
  if(activeTodayIds.length){
    const byId=new Map(candidates.map(r=>[Number(r.n),r]));
    return decorate(activeTodayIds.map(n=>byId.get(Number(n))).filter(Boolean));
  }
  const previous=Object.keys(history).filter(k=>k!==day).sort().slice(-14).flatMap(k=>history[k]||[]);
  let pool=candidates.filter(r=>!new Set(previous).has(r.n));if(pool.length<RECO_DAILY_LIMIT)pool=candidates;
  const picked=[],genres={},personas={};
  while(picked.length<RECO_DAILY_LIMIT&&pool.length){
    const ranked=pool.filter(r=>!picked.includes(r)).map(r=>{const g=String(r.genre||''),p=persoCategory(r.perso);return {r,value:recoDailyScore(r,profile,day)-(genres[g]||0)*3-(personas[p]||0)*1.35};}).sort((a,b)=>b.value-a.value||a.r.n-b.r.n);
    if(!ranked.length)break;const r=ranked[0].r;picked.push(r);const g=String(r.genre||''),p=persoCategory(r.perso);genres[g]=(genres[g]||0)+1;personas[p]=(personas[p]||0)+1;
  }
  history[day]=[...new Set([...(history[day]||[]),...picked.map(r=>r.n)])].slice(-200);Object.keys(history).sort().slice(0,-21).forEach(k=>delete history[k]);saveRecoRotation(history);
  return decorate(picked);
}
function activeDailyRecommendationCount(){return dailyRecommendationSet().length;}
function legacyDailyRecoBrief(rows){
  const fr=typeof LANG!=='undefined'&&LANG==='fr',p=rows[0]&&rows[0]._dailyProfile||{recentVideos:0};
  return '<div class="reco-daily-brief"><div><div class="reco-daily-kicker">'+(fr?'SÉLECTION DU JOUR':'DAILY SELECTION')+' · '+recoDayKey()+'</div><p>'+(fr?'Classement basé sur les 90 derniers jours de la chaîne, les performances comparées à l’âge des vidéos, puis tes validations et refus. Les idées déjà proposées sont mises en rotation.':'Ranking uses the channel’s last 90 days, age-normalized video performance, then your validations and refusals. Previously shown ideas are rotated out.')+'</p></div><div class="reco-daily-stats"><b>'+rows.length+' / '+RECO_DAILY_LIMIT+'</b><span>'+(fr?'idées actives':'active ideas')+'</span><b>'+p.recentVideos+'</b><span>'+(fr?'vidéos récentes analysées':'recent videos analysed')+'</span></div></div>';
}
function dailyRecoBrief(rows){
  const fr=typeof LANG!=='undefined'&&LANG==='fr',p=rows[0]&&rows[0]._dailyProfile||{recentVideos:0};
  const text=p.recentVideos
    ?(fr?'Classement basé sur les 90 derniers jours de la chaîne, les performances comparées à l’âge des vidéos, puis tes validations et refus. Les idées déjà proposées sont mises en rotation.':'Ranking uses the channel’s last 90 days, age-normalized video performance, then your validations and refusals. Previously shown ideas are rotated out.')
    :(fr?'Les données de performance récentes arriveront avec le prochain import YouTube. En attendant, la sélection utilise le score catalogue, tes validations/refus et la rotation anti-répétition.':'Recent performance data will be used after the next YouTube import. Until then, the selection uses the catalogue score, your feedback and anti-repeat rotation.');
  return '<div class="reco-daily-brief"><div><div class="reco-daily-kicker">'+(fr?'SÉLECTION DU JOUR':'DAILY SELECTION')+' · '+recoDayKey()+'</div><p>'+text+'</p></div><div class="reco-daily-stats"><b>'+rows.length+' / '+RECO_DAILY_LIMIT+'</b><span>'+(fr?'idées actives':'active ideas')+'</span><b>'+p.recentVideos+'</b><span>'+(fr?'vidéos récentes analysées':'recent videos analysed')+'</span></div></div>';
}
function dailyRecoListHTML(rows){
  if(!rows.length)return '<div class="empty">'+((typeof LANG!=='undefined'&&LANG==='fr')?'Aucune proposition en attente.':'No proposal awaiting review.')+'</div>';
  window._pageRecos=rows;return '<div class="rgrid2">'+rows.map((r,i)=>recoCardHTML(r,i)).join('')+'</div>';
}
let RECO_ARCHIVE_OPEN=false;
function refusedRecommendationRows(){return (DATA.recos||[]).filter(r=>isRefused(r.valid));}
function recoArchiveControlHTML(){
  const fr=typeof LANG!=='undefined'&&LANG==='fr',count=refusedRecommendationRows().length;
  return '<div class="reco-controlbar">'+
    '<span class="reco-control-label">'+(RECO_ARCHIVE_OPEN?(fr?'Archives':'Archive'):(fr?'En attente':'Awaiting review'))+'</span>'+
    '<button class="reco-archive-btn'+(RECO_ARCHIVE_OPEN?' on':'')+'" onclick="toggleRecoArchive()">🗄️ '+(fr?'Archive':'Archive')+' <b>'+count+'</b></button>'+
  '</div>';
}
function recoArchiveCardHTML(r,i){
  const note=noteOf(r.valid),tierL=r.pot?r.pot[0].toUpperCase():null;
  const tier=tierL?('<span class="rtier tier-'+tierL+'" title="Tier '+tierL+'">'+tierL+'</span>'):'<span class="rtier" style="opacity:.35">-</span>';
  return '<div class="rtile reco-archived" style="--gc:'+gcolor(r.genre)+'" onclick="openRecoIdx('+i+')">'+
    '<div class="rt-head">'+tier+'<div class="rt-title">'+esc(r.title)+'</div></div>'+
    '<div class="rt-tags">'+gtag(r.genre)+(r.dur?ghosttag(r.dur):'')+'</div>'+
    (r.concept?'<div class="rt-desc">'+esc(String(r.concept).slice(0,130))+(String(r.concept).length>130?'...':'')+'</div>':'')+
    (note?'<div class="rt-note">Note: '+esc(note.slice(0,60))+(note.length>60?'...':'')+'</div>':'')+
    '<div class="reco-quick-actions" onclick="event.stopPropagation()"><button class="rbtn reco-restore" onclick="setValid('+r.n+',\'\',this,event)">↩ Restore</button></div>'+
  '</div>';
}
function recoArchiveHTML(){
  const rows=refusedRecommendationRows();window._pageRecos=rows;
  if(!rows.length)return '<div class="empty">'+((typeof LANG!=='undefined'&&LANG==='fr')?'Aucune recommandation archivée.':'No archived recommendations.')+'</div>';
  return '<div class="rgrid2">'+rows.map((r,i)=>recoArchiveCardHTML(r,i)).join('')+'</div>';
}
function recoVisibleHTML(){return RECO_ARCHIVE_OPEN?recoArchiveHTML():dailyRecoListHTML(dailyRecommendationSet());}
function recosHTML(){return recoArchiveControlHTML()+'<div id="reco-list">'+recoVisibleHTML()+'</div>';}
function toggleRecoArchive(){RECO_ARCHIVE_OPEN=!RECO_ARCHIVE_OPEN;rerenderRecos();}
function rerenderRecos(){
  const el=document.getElementById('reco-list'),controls=document.querySelector('.reco-controlbar');
  if(el){el.innerHTML=recoVisibleHTML();i18nZone(el);}
  if(controls){const holder=document.createElement('div');holder.innerHTML=recoArchiveControlHTML();controls.replaceWith(holder.firstChild);}
  if(typeof VIEW_CACHE!=='undefined')VIEW_CACHE.delete(viewCacheKey('recos'));
  if(typeof renderNav==='function')renderNav();
}

function legacyRecoCardHTML(r,i){
    const note=noteOf(r.valid);
    const tierL=r.pot?r.pot[0].toUpperCase():null;
    const tier=tierL?('<span class="rtier tier-'+tierL+'" title="Tier '+tierL+'">'+tierL+'</span>'):'<span class="rtier" style="opacity:.35">—</span>';
    return '<div class="rtile" style="--gc:'+gcolor(r.genre)+'" onclick="openRecoIdx('+i+')">'+
      '<div class="rt-head">'+tier+'<div class="rt-title">'+esc(r.title)+'</div></div>'+
      '<div class="rt-tags">'+gtag(r.genre)+(r.dur?ghosttag(r.dur):'')+'</div>'+
      (r.concept?'<div class="rt-desc">'+esc(String(r.concept).slice(0,130))+(String(r.concept).length>130?'…':'')+'</div>':'')+
      (r.scene?'<div class="rt-scene">🖼️ '+esc(String(r.scene).slice(0,100))+(String(r.scene).length>100?'…':'')+'</div>':'')+
      (note?'<div class="rt-note">💬 '+esc(note.slice(0,60))+(note.length>60?'…':'')+'</div>':'')+
    '</div>';
}
function recoCardHTML(r,i){
  const note=noteOf(r.valid),tierL=r.pot?r.pot[0].toUpperCase():null;
  const tier=tierL?('<span class="rtier tier-'+tierL+'" title="Tier '+tierL+'">'+tierL+'</span>'):'<span class="rtier" style="opacity:.35">-</span>';
  return '<div class="rtile" style="--gc:'+gcolor(r.genre)+'" onclick="openRecoIdx('+i+')">'+
    '<div class="rt-head">'+tier+'<div class="rt-title">'+esc(r.title)+'</div></div>'+
    '<div class="rt-tags">'+gtag(r.genre)+(r.dur?ghosttag(r.dur):'')+'</div>'+
    (r.concept?'<div class="rt-desc">'+esc(String(r.concept).slice(0,130))+(String(r.concept).length>130?'...':'')+'</div>':'')+
    (r.scene?'<div class="rt-scene">Scene: '+esc(String(r.scene).slice(0,100))+(String(r.scene).length>100?'...':'')+'</div>':'')+
    (note?'<div class="rt-note">Note: '+esc(note.slice(0,60))+(note.length>60?'...':'')+'</div>':'')+
    '<div class="reco-quick-actions" onclick="event.stopPropagation()">'+
      '<button class="rbtn rbtn-ko" onclick="setValid('+r.n+',\'-\',this,event)">✕ Refuse</button>'+
      '<button class="rbtn rbtn-ok" onclick="setValid('+r.n+',\'X\',this,event)">✓ Validate</button>'+
    '</div>'+
  '</div>';
}
function recoInfoRows(r){
  return recoRow('Concept',r.concept)+recoRow('Thumbnail scene',r.scene)+recoRow('Music style',r.style)+
    recoRow('Launch format',r.launch)+recoRow('Data note',r.noteData)+recoRow('Reco Claude',r.recoClaude)+
    recoRow('Recalibration',r.recal)+
    (r.conf!=null?recoRow('Confidence',Math.round(r.conf)+' / 100'):'')+(r.status?recoRow('Status',r.status):'');
}
function recoDescKw(r){
  return (r.desc?'<div class="rrow"><div class="k">Description</div><div class="v">'+esc(r.desc)+'<br><button class="copybtn" onclick="copyTxtN(this,'+r.n+',\'desc\')">⧉ Copy description</button></div></div>':'')+
    (r.kw?'<div class="rrow"><div class="k">SEO keywords</div><div class="v" style="color:var(--muted)">'+esc(r.kw)+'<br><button class="copybtn" onclick="copyTxtN(this,'+r.n+',\'kw\')">⧉ Copy keywords</button> <button class="copybtn" onclick="copyTxtN(this,'+r.n+',\'title\')">⧉ Copy title</button></div></div>':'');
}

function recoDetailBody(r,i){
  return recoInfoRows(r)+recoDescKw(r);
}
function copyTxtN(btn,n,field){
  const r=DATA.recos.find(x=>x.n===n);if(!r)return;
  navigator.clipboard.writeText(r[field]||'').then(()=>{
    const old=btn.textContent;btn.textContent='✓ Copied';btn.classList.add('done');
    setTimeout(()=>{btn.textContent=old;btn.classList.remove('done');},1400);
  });
}
function recoActions(r){
  const isVal=isValidated(r.valid), isRef=isRefused(r.valid);
  const actions=isVal
    ?'<span class="rst-done rst-ok" style="flex:1;text-align:center">✅ Validated</span><button class="rst-x" title="Reset to pending" onclick="setValid('+r.n+',\'\',this,event)">✕</button>'
    :isRef
    ?'<span class="rst-done rst-ko" style="flex:1;text-align:center">❌ Refused</span><button class="rst-x" title="Reset to pending" onclick="setValid('+r.n+',\'\',this,event)">✕</button>'
    :'<button class="rbtn rbtn-ko" style="flex:1" onclick="setValid('+r.n+',\'-\',this,event)">✕ Refuse</button><button class="rbtn rbtn-ok" style="flex:1" onclick="setValid('+r.n+',\'X\',this,event)">✓ Validate</button>';
  return '<div class="rt-actions" style="margin:16px 0 12px;gap:12px" onclick="event.stopPropagation()">'+actions+'</div>';
}
function recoCommentBox(r){
  return '<div class="cmt-box" onclick="event.stopPropagation()">'+
    '<div class="k" style="font-size:10.5px;text-transform:uppercase;letter-spacing:1.3px;color:var(--acc2);font-weight:700;margin-bottom:7px">💬 Commentaire</div>'+
    '<textarea id="cta-dw" oninput="autoSaveComment('+r.n+')" placeholder="Your note — ChatGPT reads it at the next scan to recalibrate…">'+esc(noteOf(r.valid))+'</textarea>'+
    '<span id="cstat-dw" style="font-size:11px;color:var(--dim);margin-top:5px;display:inline-block;min-height:14px"></span>'+
  '</div>';
}
function recoReasonsDrawerHTML(r){
  if(!r._dailyReasons||!r._dailyReasons.length)return '';
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  return '<div class="reco-why"><div class="k">'+(fr?'Pourquoi cette proposition aujourd’hui':'Why this proposal today')+'</div><div class="reco-reasons">'+r._dailyReasons.map(x=>'<span class="reco-reason">'+esc(x)+'</span>').join('')+'</div></div>';
}
function openRecoIdx(i){
  const r=(window._pageRecos||[])[i];if(!r)return;
  const tierL=r.pot?r.pot[0].toUpperCase():null;
  window._drawerRecoN=r.n;
  window._drawerReopen=()=>openRecoIdx(i);
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    '<div class="dw-body" style="padding-top:26px">'+
      '<div class="dw-title" style="display:flex;gap:12px;align-items:flex-start">'+(tierL?'<span class="rtier tier-'+tierL+'" style="flex:none;margin-top:2px">'+tierL+'</span>':'')+'<span>'+esc(r.title)+'</span></div>'+
      '<div class="dw-sub">'+gtag(r.genre)+(r.dur?ghosttag(r.dur):'')+(r.scoreAdj!=null?'<span class="tag ghost">score '+Math.round(r.scoreAdj)+'</span>':'')+'</div>'+
      recoActions(r)+
      recoCommentBox(r)+
      recoReasonsDrawerHTML(r)+
      recoInfoRows(r)+
      recoDescKw(r)+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  i18nDrawer();
}
function recoTableHTML(page){
  return '<table class="vtable"><thead><tr><th>#</th><th>Title</th><th>Genre</th><th>Tier</th><th>Character</th><th>Status</th><th>Score</th></tr></thead><tbody>'+
    page.map((r,i)=>{
      const tierL=r.pot?r.pot[0].toUpperCase():null;
      const statusTxt=isValidated(r.valid)?'✅ Validated':isRefused(r.valid)?'❌ Refused':'🟡 Pending';
      return '<tr class="row" onclick="openRecoIdx('+i+')">'+
        '<td class="num">'+r.n+'</td>'+
        '<td class="ttitle">'+esc(r.title)+'</td>'+
        '<td>'+gtag(r.genre)+'</td>'+
        '<td>'+(tierL?'<span class="rtier tier-'+tierL+'">'+tierL+'</span>':'—')+'</td>'+
        '<td>'+esc(persoCategory(r.perso))+'</td>'+
        '<td>'+statusTxt+'</td>'+
        '<td class="num">'+(r.scoreAdj!=null?r.scoreAdj:(r.score!=null?r.score:'—'))+'</td></tr>';
    }).join('')+'</tbody></table>';
}
function recoListHTML(rows){
  if(!rows.length)return '<div class="empty">Nothing matches — try clearing filters.</div>';
  const page=rows.slice(0,RS.limit);
  window._pageRecos=page;
  if(RS.mode==='table'){
    let h=recoTableHTML(page);
    if(rows.length>RS.limit)h+='<button class="load-more" onclick="RS.limit+=120;rerenderRecos()">Loading more · '+fmtInt(rows.length-RS.limit)+' remaining</button>';
    return h;
  }
  const pendRows=page.filter(r=>!isValidated(r.valid)&&!isRefused(r.valid));
  const valRows=page.filter(r=>isValidated(r.valid));
  const refRows=page.filter(r=>isRefused(r.valid));
  const grp=(emoji,label,color,arr,empty)=>
    '<div class="reco-group-h" style="border-bottom-color:'+color+'55"><span style="font-size:16px">'+emoji+'</span><span style="color:'+color+'">'+label+'</span><span class="cnt">'+arr.length+'</span></div>'+
    (arr.length?'<div class="rgrid2">'+arr.map(r=>recoCardHTML(r,page.indexOf(r))).join('')+'</div>':'<div class="empty" style="padding:24px 0">'+empty+'</div>');
  let h='';
  h+=grp('🟡','Pending review','#fbbf24',pendRows,'Nothing waiting for review.');
  h+=grp('✅','Validated','#4ade80',valRows,'No recommendation validated yet.');
  h+=grp('❌','Refused','#fb7185',refRows,'No recommendation refused.');
  if(rows.length>RS.limit)h+='<button class="load-more" onclick="RS.limit+=120;rerenderRecos()">Loading more · '+fmtInt(rows.length-RS.limit)+' remaining</button>';
  return h;
}
function recoRow(k,v){return v?'<div class="rrow"><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>':'';}
function copyTxt(btn,i,field){
  const r=window._pageRecos[i];if(!r)return;
  navigator.clipboard.writeText(r[field]||'').then(()=>{
    const old=btn.textContent;btn.textContent='✓ Copied';btn.classList.add('done');
    setTimeout(()=>{btn.textContent=old;btn.classList.remove('done');},1400);
  });
}

/* ================= ROADMAP ================= */
function roadmapHTML(){
  let rows=scheduledRows();
  rows.sort((a,b)=>a.date-b.date);
  const vt='<div class="viewtoggle">'+
      '<button class="'+(RM.mode!=='cal'?'on':'')+'" onclick="RM.mode=\'table\';render()" title="List">'+ICONS.rows+'</button>'+
      '<button class="'+(RM.mode==='cal'?'on':'')+'" onclick="RM.mode=\'cal\';render()" title="Calendar">'+ICONS.roadmap+'</button></div>';
  window._rm_rows=rows;
  if(RM.mode==='cal')return calHTML(rows,vt);
  return '<div class="toolbar" style="justify-content:flex-end">'+vt+'</div>'+roadmapTableHTML(rows);
}
function roadmapTableHTML(rows){
  if(!rows.length)return '<div class="empty">No releases scheduled.</div>';
  const now=Date.now()-86400000*3;
  return '<table class="vtable"><thead><tr><th>Date</th><th>Title</th><th>Genre</th><th>Duration</th><th>Source</th><th></th></tr></thead><tbody>'+
    rows.map((r,i)=>{
      const d=new Date(r.date);
      const srcClass=/Monday/.test(r.src)?'src-monday':/Nouveau/.test(r.src)?'src-new':'src-rot';
      const past=r.date<now?'opacity:.5':'';
      return '<tr class="row" style="'+past+'" onclick="openRoad('+i+')">'+
        '<td style="white-space:nowrap">'+d.getDate()+' '+MONTHS[d.getMonth()]+' '+d.getFullYear()+'</td>'+
        '<td class="ttitle">'+esc(r.title)+'</td>'+
        '<td>'+gtag(r.genre)+'</td>'+
        '<td class="num">'+esc(r.dur||'—')+'</td>'+
        '<td><span class="tag '+srcClass+'">'+esc((r.src||'').replace(/\s*\(.*\)/,''))+'</span></td>'+
        '<td onclick="event.stopPropagation()"><button class="rm-del-btn" style="margin:0;padding:6px 10px" onclick="deleteRoadmapEntry('+i+',event)">🗑️</button></td></tr>';
    }).join('')+'</tbody></table>';
}
function openRoad(i){
  const r=(window._rm_rows||[])[i];if(!r)return;
  const d=r.date?new Date(r.date):null;
  const nrm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi,' ').trim();
  const reco=nrm(r.title)?DATA.recos.find(x=>nrm(x.title)===nrm(r.title)):null;
  window._drawerRecoN=null;window._drawerReopen=null;
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    '<div class="dw-body" style="padding-top:26px">'+
      '<div class="dw-title">'+esc(r.title)+'</div>'+
      '<div class="dw-sub">'+gtag(r.genre)+ghosttag(r.perso)+(r.dur?ghosttag(r.dur):'')+(r.niche?ghosttag(r.niche):'')+ghosttag((r.src||'').replace(/\s*\(.*\)/,''))+'</div>'+
      '<div class="dw-stats">'+
        '<div class="dw-stat hl"><b>'+(d?d.getDate()+' '+MONTHS[d.getMonth()]:'—')+'</b><span>'+esc(r.jour||'release date')+'</span></div>'+
        '<div class="dw-stat"><b>'+esc(r.dur||'—')+'</b><span>duration</span></div>'+
        (reco?'<div class="dw-stat"><b>'+(reco.scoreAdj!=null?Math.round(reco.scoreAdj):Math.round(reco.score||0))+'</b><span>reco score</span></div>':'')+
        (reco&&reco.pot?'<div class="dw-stat"><b>'+esc(reco.pot[0])+'</b><span>potential</span></div>':'')+
      '</div>'+
      (reco
        ?recoDetailBody(reco,-1)
        :recoRow('Concept',r.concept)+recoRow('Thumbnail scene',r.scene)+recoRow('Music style',r.style)+
         recoRow('Niche',r.niche)+recoRow('Cadence',r.cadence)+recoRow('Seasonal note',r.note))+
      '<div class="rm-detail-actions"><button class="rm-del-btn" onclick="deleteRoadmapEntry('+i+',event)">🗑️ Remove from schedule</button></div>'+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  i18nDrawer();
}
function deleteRoadmapEntry(i,ev){
  if(ev)ev.stopPropagation();
  const r=(window._rm_rows||[])[i];if(!r)return;
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  if(!confirm(fr?('Retirer « '+r.title+' » du planning ?'):('Remove « '+r.title+' » from the schedule?')))return;
  const li=SCHED_LOCAL.findIndex(x=>x.date===r.date&&x.title===r.title);
  const wasLocal=li>=0;
  if(wasLocal){SCHED_LOCAL.splice(li,1);schedSaveLocal();}
  DATA.roadmap=(DATA.roadmap||[]).filter(x=>!(x.date===r.date&&x.title===r.title));
  saveCache(DATA);
  render();
  if(!wasLocal)setTimeout(()=>alert(fr
    ?('Retiré localement. Pense aussi à supprimer « '+r.title+' » dans le Google Sheet / Monday pour que ce soit définitif pour toute l’équipe.')
    :('Removed locally. Also remember to delete « '+r.title+' » in the Google Sheet / Monday so it\'s final for the whole team.')
  ),200);
}
function calShift(d){
  const b=RM.cal?new Date(RM.cal):new Date();
  if(RM.view==='year'){b.setFullYear(b.getFullYear()+d);}else{b.setDate(1);b.setMonth(b.getMonth()+d);}
  RM.cal=b.getTime();render();
}
function calSetView(v){RM.view=v;render();}
function calSetGenre(g){RM.genre=RM.genre===g?'':g;render();}
function calLegendHTML(rows){
  const genres=[...new Set(rows.map(r=>r.genre).filter(Boolean))];
  return '<div class="cal-legend-v">'+genres.map(g=>{
    const on=RM.genre===g,off=RM.genre&&RM.genre!==g;
    return '<button class="'+(on?'on':off?'off':'')+'" onclick="calSetGenre('+jsq(g)+')" title="'+esc(on?'Show all genres':'Show only '+g)+'"><i style="background:'+gcolor(g)+';--lgc:'+gcolor(g)+'66"></i>'+esc(g)+'</button>';
  }).join('')+'</div>';
}
function calHTML(rows,vt){
  const base=RM.cal?new Date(RM.cal):new Date();
  const y=base.getFullYear(),m=base.getMonth();
  rows.forEach((r,ri)=>{r._ri=ri;});
  const toggle='<div class="cal-viewtoggle">'+
      '<button class="'+(RM.view!=='year'?'on':'')+'" onclick="calSetView(\'month\')">Month</button>'+
      '<button class="'+(RM.view==='year'?'on':'')+'" onclick="calSetView(\'year\')">Year</button>'+
    '</div>';
  if(RM.view==='year')return yearCalHTML(rows,y,toggle,vt);
  const MFULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const first=new Date(y,m,1);
  const start=new Date(y,m,1-((first.getDay()+6)%7));
  const today=new Date();today.setHours(0,0,0,0);
  const key=d=>d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();
  const shown=RM.genre?rows.filter(r=>r.genre===RM.genre):rows;
  const byDay={};shown.forEach(r=>{const k=key(new Date(r.date));(byDay[k]=byDay[k]||[]).push(r);});
  const legendV=calLegendHTML(rows);
  let h='<div class="cal-shell"><div class="cal-body">'+
    '<div class="cal-controls">'+toggle+
    '<div class="cal-center"><button class="ctl-btn arrow" onclick="calShift(-1)" title="Previous month">‹</button>'+
    '<div class="cal-month">'+MFULL[m]+' '+y+'</div>'+
    '<button class="ctl-btn arrow" onclick="calShift(1)" title="Next month">›</button></div>'+
    '<div class="cal-navright">'+(vt||'')+'</div></div>';
  h+='<div class="cal"><div class="cal-head">'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x=>'<div>'+x+'</div>').join('')+'</div><div class="cal-grid">';
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);
    const evs=byDay[key(d)]||[];
    h+='<div class="cal-cell'+(d.getMonth()!==m?' out':'')+(d.getTime()===today.getTime()?' today':'')+'">'+
      '<span class="d">'+String(d.getDate()).padStart(2,'0')+'</span><div class="pills">'+
      evs.map(r=>{const c=gcolor(r.genre);
        return '<div class="cal-pill" style="background:'+c+';cursor:pointer" onclick="openRoad('+r._ri+')" title="'+esc(r.title+' — '+(r.genre||'?')+' · '+(r.perso||'')+' · '+(r.src||''))+'">'+esc(r.title)+'</div>';}).join('')+
      '</div></div>';
  }
  h+='</div></div>';
  h+='</div>'+legendV+'</div>';
  return h;
}
function yearCalHTML(rows,y,toggle,vt){
  const MFULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today=new Date();today.setHours(0,0,0,0);
  const key=d=>d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();
  const shown=RM.genre?rows.filter(r=>r.genre===RM.genre):rows;
  const byDay={};shown.forEach(r=>{const k=key(new Date(r.date));(byDay[k]=byDay[k]||[]).push(r);});
  const legendV=calLegendHTML(rows);
  let h='<div class="cal-shell"><div class="cal-body">'+
    '<div class="cal-controls">'+toggle+
    '<div class="cal-center"><button class="ctl-btn arrow" onclick="calShift(-1)" title="Previous year">‹</button>'+
    '<div class="cal-month">'+y+'</div>'+
    '<button class="ctl-btn arrow" onclick="calShift(1)" title="Next year">›</button></div>'+
    '<div class="cal-navright">'+(vt||'')+'</div></div>';
  h+='<div class="year-cal">';
  for(let m=0;m<12;m++){
    const first=new Date(y,m,1);
    const start=new Date(y,m,1-((first.getDay()+6)%7));
    h+='<div class="year-month"><div class="year-month-h">'+MFULL[m]+'</div><div class="year-grid">'+
      ['L','M','M','J','V','S','D'].map(x=>'<div class="year-dow">'+x+'</div>').join('');
    for(let i=0;i<42;i++){
      const d=new Date(start);d.setDate(start.getDate()+i);
      if(i>=35&&d.getMonth()!==m)break;
      const evs=byDay[key(d)]||[];
      const isToday=d.getTime()===today.getTime();
      const evStyle=evs.length?' style="background:'+gcolor(evs[0].genre)+';box-shadow:0 0 12px '+gcolor(evs[0].genre)+'66"':'';
      h+='<div class="year-cell'+(d.getMonth()!==m?' out':'')+(evs.length?' has-event':'')+(isToday?' today':'')+'"'+evStyle+
        (evs.length?' onclick="openRoad('+evs[0]._ri+')" title="'+esc(evs.map(e=>e.title).join(' · '))+'"':'')+'>'+
        d.getDate()+
      '</div>';
    }
    h+='</div></div>';
  }
  h+='</div>';
  h+='</div>'+legendV+'</div>';
  return h;
}

/* ================= SMART SCHEDULING (validate → roadmap proposal) ================= */
const SCHED_RULES={
  lofi:{minGapDays:14,label:'Lofi · 2×/mois'},
  pianoclassic:{minGapDays:63,label:'Piano + Classique · 1×/8–10 semaines'},
  jazz:{minGapDays:49,label:'Jazz · 1×/6–8 semaines'},
  guitarhouse:{minGapDays:180,seasonalMonths:[2,3,4,5,6,7],label:'Guitare / Lofi House · 1–2×/an, priorité mars–août'},
  ambientnature:{minGapDays:30,label:'Ambient + Nature · 1×/mois, en alternance'},
  darkambient:{minGapDays:90,label:'Dark Ambient · 1×/trimestre'},
  halloween:{seasonalMonths:[9],label:'Halloween · fenêtre saisonnière (octobre)'},
  noel:{seasonalMonths:[11],seasonalDayMax:25,label:'Noël · fenêtre saisonnière (décembre)'}
};
function scheduledRows(){
  const seen=new Set();
  return (DATA.roadmap||[]).filter(r=>r.date).concat(SCHED_LOCAL||[]).filter(r=>{
    const key=(r.recoN!=null?'reco:'+r.recoN:'title:'+String(r.title||'').toLowerCase())+'|'+r.date;
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
function schedBucket(r){
  const g=(r.genre||'').toLowerCase(), t=((r.title||'')+' '+(r.concept||'')+' '+(r.style||'')+' '+(r.niche||'')).toLowerCase();
  if(/halloween/.test(g+t))return 'halloween';
  if(/no[eë]l|christmas|xmas/.test(g+t))return 'noel';
  if(/dark ambient/.test(g+t))return 'darkambient';
  if(/lofi|chillhop|hip ?hop/.test(g))return 'lofi';
  if(/piano|classi/.test(g))return 'pianoclassic';
  if(/jazz|bossa/.test(g))return 'jazz';
  if(/guitar|acousti|lofi house|house/.test(g))return 'guitarhouse';
  if(/ambient|nature/.test(g))return 'ambientnature';
  return 'other';
}
function schedIsRain(r){return /pluie|rain|thunder|orage|storm/i.test((r.title||'')+' '+(r.concept||'')+' '+(r.style||''));}
function schedWeekKey(d){const x=new Date(d);const day=(x.getDay()+6)%7;x.setDate(x.getDate()-day);return x.getFullYear()+'-'+x.getMonth()+'-'+x.getDate();}
function suggestRoadmapDate(reco,avoidKeys){
  const bucket=schedBucket(reco);
  const rule=SCHED_RULES[bucket]||{};
  const rain=schedIsRain(reco);
  const rmRows=scheduledRows();
  rmRows.sort((a,b)=>a.date-b.date);
  const usedWeeks=new Set(rmRows.map(r=>schedWeekKey(new Date(r.date))));
  const lastOfBucket=[...rmRows].reverse().find(r=>schedBucket(r)===bucket);
  const lastRain=[...rmRows].reverse().find(r=>schedIsRain(r));
  const today=new Date();today.setHours(0,0,0,0);
  const dayKey=x=>x.getFullYear()+'-'+x.getMonth()+'-'+x.getDate();
  const usedDays=new Set(rmRows.map(r=>dayKey(new Date(r.date))));
  const passes=[
    {allowFriday:false,respectWeeks:true,respectGap:true},
    {allowFriday:true,respectWeeks:true,respectGap:true},
    {allowFriday:true,respectWeeks:true,respectGap:false}
  ];
  for(const pass of passes){
    let d=new Date(today);d.setDate(d.getDate()+3);
    // A recommendation must always receive its next eligible release date.
    // The roadmap is finite, so an eligible weekday will eventually recur;
    // do not turn an arbitrary look-ahead horizon into a validation failure.
    for(;;d=new Date(d.getTime()+86400000)){
      const dow=d.getDay();
      if(dow===0||dow===6)continue;
      if(dow===5&&!pass.allowFriday)continue;
      if(usedDays.has(dayKey(d)))continue;
      if(avoidKeys&&avoidKeys.has(dayKey(d)))continue;
      if(pass.respectWeeks&&usedWeeks.has(schedWeekKey(d)))continue;
      if(rule.seasonalMonths&&!rule.seasonalMonths.includes(d.getMonth()))continue;
      if(rule.seasonalDayMax&&d.getDate()>rule.seasonalDayMax)continue;
      if(pass.respectGap&&rule.minGapDays&&lastOfBucket){
        const gap=(d-lastOfBucket.date)/86400000;
        if(gap<rule.minGapDays)continue;
      }
      if(pass.respectGap&&rain&&lastRain){
        const gap=(d-lastRain.date)/86400000;
        if(gap<21)continue;
      }
      return {date:d,bucket,rule,relaxed:pass!==passes[0]};
    }
  }
}
let SCHED_LOCAL=(()=>{try{return JSON.parse(localStorage.getItem('radar_sched_local')||'[]').map(x=>({...x,date:+x.date}));}catch(e){return [];}})();
function schedSaveLocal(){try{localStorage.setItem('radar_sched_local',JSON.stringify(SCHED_LOCAL));}catch(e){}}
function scheduleRecommendation(reco,sug){
  if(!reco)return null;
  const existing=scheduledRows().find(r=>Number(r.recoN)===Number(reco.n));
  if(existing)return existing;
  const placement=sug||suggestRoadmapDate(reco,new Set());
  if(!placement)return null;
  const d=placement.date;
  const entry={date:+d,jour:['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'][d.getDay()],
    src:'Proposition rotation (à valider)',recoN:reco.n,title:reco.title,genre:reco.genre,perso:reco.perso,dur:reco.dur,
    concept:reco.concept,scene:reco.scene,style:reco.style,niche:reco.niche,cadence:placement.rule.label||'',note:'Ajouté depuis la rotation quotidienne'};
  SCHED_LOCAL.push(entry);
  schedSaveLocal();
  DATA.roadmap=(DATA.roadmap||[]).concat([entry]);
  saveCache(DATA);
  return entry;
}
let SCHED_CUR=null;
function schedDateKey(d){return d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();}
function schedMiniCal(dateHi,rows,previewDate){
  const y=dateHi.getFullYear(),m=dateHi.getMonth();
  const MFULL=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const first=new Date(y,m,1);
  const start=new Date(y,m,1-((first.getDay()+6)%7));
  const byDay={};rows.forEach(r=>{const k=schedDateKey(new Date(r.date));(byDay[k]=byDay[k]||[]).push(r);});
  const selected=previewDate||dateHi;
  let h='<div class="sched-cal-h">'+MFULL[m]+' '+y+'</div><div class="sched-grid">'+
    ['L','M','M','J','V','S','D'].map(x=>'<div class="sched-dow">'+x+'</div>').join('');
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);
    const evs=byDay[schedDateKey(d)]||[];
    const isHi=schedDateKey(d)===schedDateKey(dateHi);
    const isSelected=schedDateKey(d)===schedDateKey(selected);
    const label=(evs.length?evs.length+' release'+(evs.length>1?'s':'')+' planned: '+evs.map(e=>e.title).join(', '):'No release planned')+' — '+d.getDate()+' '+MFULL[d.getMonth()];
    h+='<button type="button" class="sched-cell'+(d.getMonth()!==m?' out':'')+(evs.length?' has-event':'')+(isHi?' proposed':'')+(isSelected?' selected':'')+'" aria-label="'+esc(label)+'" title="'+esc(label)+'" onclick="previewSchedDay('+d.getTime()+')">'+d.getDate()+
      (evs.length&&!isHi?'<span class="dot" style="background:'+gcolor(evs[0].genre)+'"></span>':'')+'</button>';
  }
  h+='</div>';
  return h;
}
function schedNearbyReleases(date,rows){
  const selected=new Date(date);selected.setHours(0,0,0,0);
  const start=+selected-7*86400000,end=+selected+7*86400000;
  const nearby=rows.map(r=>({row:r,date:new Date(r.date)})).filter(x=>+x.date>=start&&+x.date<=end).sort((a,b)=>+a.date-+b.date);
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const fmt=d=>d.toLocaleDateString(fr?'fr-FR':'en-GB',{day:'numeric',month:'short'});
  if(!nearby.length)return '<div class="sched-nearby empty">'+(fr?'Aucune sortie planifiée dans les 7 jours autour de cette date.':'No releases planned within 7 days of this date.')+'</div>';
  return '<div class="sched-nearby"><div class="sched-nearby-h">'+(fr?'Sorties proches':'Nearby releases')+'</div>'+nearby.map(({row,date})=>
    '<div class="sched-nearby-row"><span class="sched-nearby-date">'+fmt(date)+'</span><span class="sched-nearby-title">'+esc(row.title||'Sans titre')+'</span><span class="sched-nearby-genre">'+esc(row.genre||'—')+'</span></div>'
  ).join('')+'</div>';
}
function openSchedulePopup(reco){
  const avoid=new Set();
  const sug=suggestRoadmapDate(reco,avoid);
  if(sug)avoid.add(sug.date.getFullYear()+'-'+sug.date.getMonth()+'-'+sug.date.getDate());
  SCHED_CUR={reco,sug,avoid,previewDate:new Date(sug.date)};
  renderSchedPopup();
  document.getElementById('sched-backdrop').classList.add('show');
  document.getElementById('sched-modal').classList.add('show');
}
function renderSchedPopup(){
  const {reco,sug}=SCHED_CUR||{};
  const el=document.getElementById('sched-modal');
  if(!reco||!sug){
    el.innerHTML='<div class="sched-h">Schedule unavailable</div><div class="sched-sub">Please reopen this recommendation to generate its release date.</div><div class="sched-actions"><button class="sched-btn-cancel" onclick="closeSchedPopup()">Close</button></div>';
    if(typeof LANG!=='undefined'&&LANG==='fr')el.innerHTML=frz(el.innerHTML);
    return;
  }
  const d=sug.date;
  const dowEN=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dowFR=['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const mEN=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const mFR=['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const jour=(fr?dowFR:dowEN)[d.getDay()];
  const MFULL=fr?mFR:mEN;
  const rows=scheduledRows();
  const ruleLabel=sug.rule.label||'General cadence (~1 release/week, free week)';
  let h=
    '<div class="sched-h">✓ « '+esc(reco.title)+' » validated</div>'+
    '<div class="sched-sub">Suggested release date — click a day to see nearby planned releases.</div>'+
    '<div class="sched-rationale">📅 <b>'+jour+' '+d.getDate()+' '+MFULL[d.getMonth()]+' '+d.getFullYear()+'</b><br>'+
      '↳ '+esc(ruleLabel)+(sug.relaxed?' <span style="color:var(--amber)">· relaxed constraint (few open slots)</span>':'')+
      (schedIsRain(reco)?'<br>↳ Spaced out from the last rain/storm concept (≥3 weeks)':'')+
    '</div>'+
    '<div class="sched-cal">'+schedMiniCal(d,rows,SCHED_CUR.previewDate)+'</div>'+
    schedNearbyReleases(SCHED_CUR.previewDate||d,rows)+
    '<div class="sched-actions">'+
      '<button class="sched-btn-alt" onclick="skipSchedDate()">Date suivante</button>'+
      '<button class="sched-btn-ok" onclick="confirmSchedDate()">✓ Confirm date</button>'+
    '</div>'+
    '<div style="display:flex;gap:8px;margin-top:8px">'+
      '<button class="sched-btn-cancel" style="flex:1" onclick="closeSchedPopup()">Not now</button>'+
    '</div>';
  if(fr)h=frz(h);
  el.innerHTML=h;
}
function skipSchedDate(){
  if(!SCHED_CUR)return;
  if(!SCHED_CUR.avoid)SCHED_CUR.avoid=new Set();
  if(SCHED_CUR.sug){const p=SCHED_CUR.sug.date;SCHED_CUR.avoid.add(p.getFullYear()+'-'+p.getMonth()+'-'+p.getDate());}
  const sug=suggestRoadmapDate(SCHED_CUR.reco,SCHED_CUR.avoid);
  if(sug){
    SCHED_CUR.sug=sug;
    SCHED_CUR.previewDate=new Date(sug.date);
    SCHED_CUR.avoid.add(sug.date.getFullYear()+'-'+sug.date.getMonth()+'-'+sug.date.getDate());
  }
  renderSchedPopup();
}
function previewSchedDay(timestamp){
  if(!SCHED_CUR)return;
  SCHED_CUR.previewDate=new Date(Number(timestamp));
  renderSchedPopup();
}
function confirmSchedDate(){
  if(!SCHED_CUR)return;
  const {reco,sug}=SCHED_CUR;
  const entry={date:+sug.date,jour:['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'][sug.date.getDay()],
    src:'Proposition rotation (à valider)',recoN:reco.n,title:reco.title,genre:reco.genre,perso:reco.perso,dur:reco.dur,
    concept:reco.concept,scene:reco.scene,style:reco.style,niche:reco.niche,cadence:sug.rule.label||'',note:'Placé automatiquement via le popup de validation'};
  SCHED_LOCAL.push(entry);
  schedSaveLocal();
  DATA.roadmap=(DATA.roadmap||[]).concat([entry]);
  const el=document.getElementById('sched-modal');
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const MFULL=fr?['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
    :['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d=sug.date;
  let h='<div class="sched-h">✓ Date confirmed</div>'+
    '<div class="sched-confirmed">« '+esc(reco.title)+' » is added on '+d.getDate()+' '+MFULL[d.getMonth()]+' '+d.getFullYear()+' (visible in Roadmap, tagged “to validate”).<br><br>Remember to also report this date in the Google Sheet Roadmap so it persists for the whole team.</div>'+
    '<div class="sched-actions" style="margin-top:14px">'+
      '<button class="sched-btn-ok" onclick="closeSchedPopup();go(\'roadmap\')">Open roadmap</button>'+
      '<button class="sched-btn-cancel" onclick="closeSchedPopup()">Close</button>'+
    '</div>';
  if(fr)h=frz(h);
  el.innerHTML=h;
}
function closeSchedPopup(){
  document.getElementById('sched-backdrop').classList.remove('show');
  document.getElementById('sched-modal').classList.remove('show');
  SCHED_CUR=null;
}

/* ================= ANALYSIS (our videos) ================= */
const GKEYS=[[/lofi|chillhop|hip ?hop/i,'lofi'],[/synth|retro|outrun/i,'synthwave'],[/piano/i,'piano'],[/jazz|bossa/i,'jazz'],[/classi/i,'classical'],[/guitar|acousti/i,'guitar'],[/sleep|sommeil|night/i,'sleep'],[/nature|rain|pluie|forest|ocean/i,'nature'],[/ambient|ambiance/i,'ambient'],[/focus|study|étude/i,'focus'],[/house|electro/i,'electronic'],[/m[eé]ditation|wellness/i,'meditation']];
function genreKey(g){if(!g)return null;for(const p of GKEYS){if(p[0].test(g))return p[1];}return 'other';}
const AS={sort:'date',mode:'grid'};
let _anaCache=null,_anaT=0;
let ANALYSIS_HISTORY_PROMISE=null;
function ensureAnalysisHistory(){
  if(!DATA||ANALYSIS_HISTORY_PROMISE)return;
  const ids=[...new Set((DATA.ours||[]).map(v=>v.vid).filter(Boolean))];
  const missing=ids.filter(vid=>!videoHistoryReady(vid)&&!videoHistoryError(vid));
  if(!missing.length)return;
  ANALYSIS_HISTORY_PROMISE=Promise.all(missing.map(ensureVideoHistory)).finally(()=>{
    ANALYSIS_HISTORY_PROMISE=null;_anaCache=null;_anaT=0;if(route==='ana')render();
  });
}
const ANA_AGE_COHORTS=[
  {id:'launch',max:7,label:'0-7 days'},
  {id:'month',max:30,label:'8-30 days'},
  {id:'quarter',max:90,label:'1-3 months'},
  {id:'half',max:180,label:'3-6 months'},
  {id:'year',max:365,label:'6-12 months'},
  {id:'mature',max:Infinity,label:'12+ months'}
];
function anaAgeDays(v){
  const pub=Number(v&&v.pub);
  return Number.isFinite(pub)&&pub>0?Math.max((Date.now()-pub)/86400000,0):null;
}
function anaAgeCohort(ageDays){
  if(ageDays==null)return null;
  return ANA_AGE_COHORTS.find(c=>ageDays<=c.max)||ANA_AGE_COHORTS[ANA_AGE_COHORTS.length-1];
}
function anaLifetimeVpm(v,ageDays){
  const days=ageDays==null?anaAgeDays(v):ageDays;
  const views=Number(v&&v.views);
  return Number.isFinite(views)&&days!=null&&days>0?views/days*30.44:null;
}
function anaAgeComparable(rows,ageDays,minCount){
  const target=anaAgeCohort(ageDays);
  if(!target)return {rows:[],label:'unknown age',exact:false,sufficient:false};
  const indexed=ANA_AGE_COHORTS.findIndex(c=>c.id===target.id);
  const exact=rows.filter(row=>anaAgeCohort(anaAgeDays(row))?.id===target.id);
  if(exact.length>=minCount)return {rows:exact,label:target.label,exact:true,sufficient:true};
  // Adjacent cohorts are still age-aware. They are used only when the exact
  // cohort is too small to make a meaningful comparison.
  const nearby=rows.filter(row=>{
    const other=anaAgeCohort(anaAgeDays(row));
    const otherIndex=other?ANA_AGE_COHORTS.findIndex(c=>c.id===other.id):-99;
    return Math.abs(otherIndex-indexed)<=1;
  });
  if(nearby.length>=minCount)return {rows:nearby,label:target.label+' (nearby ages)',exact:false,sufficient:true};
  return {rows:exact,label:target.label,exact:true,sufficient:false};
}
function anaRows(){
  if(_anaCache&&_anaT===SYNCED)return _anaCache;
  const out=(DATA.ours||[]).filter(v=>v.pub&&(v.durH==null||v.durH>=0.15)).map(v=>{
    const o=Object.assign({},v);
    o.ageDays=anaAgeDays(v);
    o.ageM=o.ageDays==null?null:o.ageDays/30.44;
    o.ageCohort=anaAgeCohort(o.ageDays);
    const s=(DATA.hist&&DATA.hist[v.vid])||[];
    o.views=s.length?s[s.length-1][1]:Number.isFinite(Number(v.views))?Number(v.views):null;
    o.vpm=anaLifetimeVpm(o,o.ageDays);
    if(s.length>=2){
      const end=s[s.length-1],cut=end[0]-30.44*86400000,recent=s.filter(p=>p[0]>=cut);
      const start=recent.length>=2?recent[0]:s[s.length-2];
      const days=Math.max((end[0]-start[0])/86400000,0.5);
      o.vNow=(end[1]-start[1])/days*30.44;
    }else o.vNow=null;
    const gk=genreKey(v.genre);
    const market=mixRows().filter(x=>genreKey(x.genre)===gk&&anaLifetimeVpm(x)!=null);
    const ageMatched=anaAgeComparable(market,o.ageDays,8);
    const coh=ageMatched.rows;
    o.cohN=coh.length;o.gk=gk;o.cohAgeLabel=ageMatched.label;o.cohAgeExact=ageMatched.exact;
    if(o.vpm!=null&&ageMatched.sufficient){
      const below=coh.filter(x=>anaLifetimeVpm(x)<o.vpm).length;
      o.pct=Math.round(below/coh.length*100);
      const tops=coh.slice().sort((a,b)=>anaLifetimeVpm(b)-anaLifetimeVpm(a)).slice(0,Math.max(3,Math.round(coh.length/4)));
      o.topDur=median(tops.map(x=>x.durH));
      o.cohMed=median(coh.map(x=>anaLifetimeVpm(x)));
    }else{o.pct=null;o.topDur=null;o.cohMed=null;}
    o.verdict=o.ageM<1?'early':(o.pct==null?'early':(o.pct>=70?'over':(o.pct>=40?'inline':'under')));
    o.reco=v.recoN!=null?DATA.recos.find(r=>r.n===v.recoN):null;
    return o;
  });
  const SD=(window.STUDIO_DATA&&window.STUDIO_DATA.d)||{};
  out.forEach(o=>{o.st=SD[o.vid]||null;});
  const CM=window.CMT||{};
  out.forEach(o=>{
    const peers=anaAgeComparable(out.filter(x=>x.vid!==o.vid),o.ageDays,2);
    const comparable=peers.sufficient?peers.rows:[];
    const velocityPeers=comparable.filter(x=>x.vpm!=null);
    o.chAgeLabel=peers.label;o.chAgeExact=peers.exact;o.chN=velocityPeers.length;
    o.chMed=median(velocityPeers.map(x=>x.vpm));
    o.ctrMed=median(comparable.map(x=>x.st?x.st.ctr:null));
    o.awpMed=median(comparable.map(x=>x.st?x.st.awp:null));
    o.awtMed=median(comparable.map(x=>x.st?x.st.awtMs:null));
    o.medViews=median(comparable.map(x=>x.views));
    o.medCmt=median(comparable.map(x=>CM[x.vid]!=null?CM[x.vid]:null));
    o.pctCh=(o.vpm!=null&&velocityPeers.length>=2)?Math.round(velocityPeers.filter(x=>x.vpm<o.vpm).length/velocityPeers.length*100):null;
    o.diags=anaDiags(o);
  });
  _anaCache=out;_anaT=SYNCED;
  return out;
}
function fmtWatch(ms){
  if(ms==null)return '—';
  const s=Math.round(ms/1000),hh=Math.floor(s/3600),mm=Math.floor(s%3600/60),ss=s%60;
  return (hh?hh+':'+String(mm).padStart(2,'0'):mm)+':'+String(ss).padStart(2,'0');
}
function anaDiags(o){
  const d=[];
  if(o.verdict==='early'){d.push('Too young to judge — needs a few more weeks of daily scans.');return d;}
  if(o.pct==null)return d;
  if(o.vNow!=null&&o.vpm!=null){
    if(o.vNow>o.vpm*1.3)d.push('Accelerating: current pace ('+fmtN(o.vNow)+'/mo measured) beats its lifetime average — the algorithm is still pushing it.');
    else if(o.vNow<o.vpm*0.5)d.push('Decelerating: current pace ('+fmtN(o.vNow)+'/mo measured) is well below its lifetime average — the push phase is over.');
  }
  if(o.cohMed!=null&&o.vpm!=null){
    const scope=fmtInt(o.cohN)+' competing '+o.gk+' videos at '+o.cohAgeLabel;
    if(o.vpm<o.cohMed)d.push('Below the genre bar at the same release age: '+fmtN(o.vpm)+' views/mo vs a median of '+fmtN(o.cohMed)+' across '+scope+'.');
    else d.push('Above the genre median at the same release age ('+fmtN(o.cohMed)+' views/mo across '+scope+').');
  }
  if(o.topDur!=null&&o.durH!=null){
    const ratio=o.durH/o.topDur;
    if(ratio<0.45)d.push('Short for the winners’ format: top '+o.gk+' performers run '+fmtDur(o.topDur)+' median, this one is '+fmtDur(o.durH)+' — longer mixes capture sleep/focus watch sessions.');
    else if(ratio>2.5)d.push('Much longer than the winning format ('+fmtDur(o.topDur)+' median for top performers).');
  }
  if(o.st){
    if(o.st.ctr!=null&&o.ctrMed!=null){
      if(o.st.ctr<o.ctrMed*0.75&&o.st.imp>1e6)d.push('Weak packaging: '+o.st.ctr.toFixed(1)+'% CTR vs '+o.ctrMed.toFixed(1)+'% channel median on '+fmtN(o.st.imp)+' impressions \u2014 YouTube showed it, viewers didn\u2019t click. Thumbnail/title are the first suspects.');
      else if(o.st.ctr>o.ctrMed*1.25)d.push('Strong packaging: '+o.st.ctr.toFixed(1)+'% CTR vs '+o.ctrMed.toFixed(1)+'% channel median \u2014 the thumbnail/title pull clicks.');
    }
    if(o.st.awp!=null&&o.awpMed!=null){
      if(o.st.awp<o.awpMed*0.5)d.push('Retention gap: viewers watch '+o.st.awp.toFixed(0)+'% of the video vs '+o.awpMed.toFixed(0)+'% channel median'+((o.durH||0)>=6?' \u2014 partly expected on very long sleep mixes, judge with average duration ('+fmtWatch(o.st.awtMs)+')':' \u2014 the content doesn\u2019t hold the session')+'.');
      else if(o.st.awp>o.awpMed*1.4)d.push('Excellent retention: '+o.st.awp.toFixed(0)+'% average watched vs '+o.awpMed.toFixed(0)+'% channel median.');
    }
    if(o.verdict==='under'&&o.st.ctr!=null&&o.ctrMed!=null&&o.awpMed!=null&&o.st.ctr>=o.ctrMed&&o.st.awp>=o.awpMed)d.push('CTR and retention are both healthy \u2014 the shortfall likely comes from topic demand or impression volume, not execution.');
  }
  if(o.chMed!=null&&o.vpm!=null){
    const r=o.vpm/o.chMed;
    if(r>=1.5)d.push('One of the channel\u2019s strongest releases at this age: \u00d7'+r.toFixed(1)+' the same-age channel median ('+fmtN(o.chMed)+' views/mo).');
    else if(r<=0.5)d.push('Well below the channel\u2019s same-age median ('+fmtN(o.chMed)+' views/mo, this one at \u00d7'+r.toFixed(1)+').');
  }
  if(o.reco&&o.reco.pot){
    const p=o.reco.pot[0];
    if((p==='S'||p==='A')&&o.verdict==='under')d.push('Prediction gap: reco #'+Math.round(o.reco.n)+' was rated '+p+' potential but the video underperforms — packaging (title/thumbnail) is the prime suspect, to confirm with Studio CTR data.');
    if(p==='S'&&o.verdict==='over')d.push('Prediction confirmed: rated S potential and delivering.');
  }
  return d;
}
/* ---- Deep packaging audit: thumbnail colors + title/keyword patterns ---- */
const THUMB_CACHE={};
function analyzeThumb(vid){
  if(THUMB_CACHE[vid])return THUMB_CACHE[vid];
  const p=new Promise(resolve=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    const done=(v)=>resolve(v);
    img.onload=()=>{
      try{
        const W=48,H=27;
        const c=document.createElement('canvas');c.width=W;c.height=H;
        const ctx=c.getContext('2d');
        ctx.drawImage(img,0,0,W,H);
        const data=ctx.getImageData(0,0,W,H).data;
        let sumL=0,sumR=0,sumG=0,sumB=0,n=0;const lums=[];
        for(let i=0;i<data.length;i+=4){
          const r=data[i],g=data[i+1],b=data[i+2];
          const l=0.2126*r+0.7152*g+0.0722*b;
          sumL+=l;sumR+=r;sumG+=g;sumB+=b;lums.push(l);n++;
        }
        const brightness=sumL/n;
        const variance=lums.reduce((s,l)=>s+(l-brightness)*(l-brightness),0)/n;
        done({ok:true,brightness,contrast:Math.sqrt(variance),warmth:(sumR-sumB)/n,r:sumR/n,g:sumG/n,b:sumB/n});
      }catch(e){done({ok:false});}
    };
    img.onerror=()=>done({ok:false});
    img.src=thumb(vid);
  });
  THUMB_CACHE[vid]=p;
  return p;
}
const POWER_WORDS=['sleep','deep','focus','relax','calm','cozy','healing','study','meditation','peaceful','soothing','ambience','ambient','rain','night','morning','stress','anxiety','productivity','warm','dream'];
function titleSignals(title){
  const t=(title||'').toLowerCase();
  return {
    hasDuration:/\d+\s*(h|hr|hour|heures?)\b/.test(t),
    hasNumber:/\d/.test(t),
    hasEmoji:/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(title||''),
    wordCount:(title||'').trim().split(/\s+/).filter(Boolean).length,
    hasSeparator:/[|:]/.test(title||''),
    powerWords:POWER_WORDS.filter(w=>t.includes(w))
  };
}
async function buildDeepAudit(o){
  const out={title:[],thumb:[],kw:[],coh:0};
  const ageMatched=anaAgeComparable(
    mixRows().filter(x=>genreKey(x.genre)===o.gk&&anaLifetimeVpm(x)!=null),
    o.ageDays,
    6
  );
  const coh=(ageMatched.sufficient?ageMatched.rows:[]).sort((a,b)=>anaLifetimeVpm(b)-anaLifetimeVpm(a)).slice(0,6);
  out.coh=coh.length;
  if(!coh.length)return out;
  const [ourThumb,...cohThumbs]=await Promise.all([analyzeThumb(o.vid),...coh.map(c=>analyzeThumb(c.vid))]);
  const okCoh=cohThumbs.filter(c=>c.ok);
  const ourSig=titleSignals(o.title);
  const cohSigs=coh.map(c=>titleSignals(c.title));
  const pctOf=fn=>cohSigs.length?Math.round(cohSigs.filter(fn).length/cohSigs.length*100):null;
  const durPct=pctOf(s=>s.hasDuration);
  if(durPct!=null&&durPct>=60&&!ourSig.hasDuration)
    out.title.push('Le titre n’indique pas de durée (ex. "10 Hours") alors que '+durPct+'% des meilleurs titres '+o.gk+' en affichent une — ça rassure sur la session sommeil/focus et aide le CTR.');
  const pwPct=pctOf(s=>s.powerWords.length>0);
  if(pwPct!=null&&pwPct>=60&&!ourSig.powerWords.length)
    out.title.push('Aucun mot émotionnel/bénéfice (sleep, focus, relax, healing…) dans le titre, alors que '+pwPct+'% des meilleurs titres du genre en utilisent un.');
  const sepPct=pctOf(s=>s.hasSeparator);
  if(sepPct!=null&&sepPct>=60&&!ourSig.hasSeparator)
    out.title.push('Titre en une seule phrase alors que '+sepPct+'% des meilleurs titres du genre utilisent un séparateur ( | ou : ) pour juxtaposer accroche + bénéfice.');
  const avgWords=cohSigs.length?Math.round(cohSigs.reduce((s,x)=>s+x.wordCount,0)/cohSigs.length):null;
  if(avgWords!=null&&Math.abs(ourSig.wordCount-avgWords)>=4)
    out.title.push('Titre '+(ourSig.wordCount<avgWords?'plus court':'plus long')+' ('+ourSig.wordCount+' mots) que la moyenne des meilleurs titres du genre ('+avgWords+' mots).');
  const emojiPct=pctOf(s=>s.hasEmoji);
  if(emojiPct!=null&&emojiPct>=50&&!ourSig.hasEmoji)
    out.title.push('Pas d’emoji dans le titre, alors que '+emojiPct+'% des meilleurs titres du genre en utilisent au moins un pour se détacher dans le fil.');
  if(ourThumb.ok&&okCoh.length>=2){
    const avgB=okCoh.reduce((s,c)=>s+c.brightness,0)/okCoh.length;
    const avgC=okCoh.reduce((s,c)=>s+c.contrast,0)/okCoh.length;
    const avgW=okCoh.reduce((s,c)=>s+c.warmth,0)/okCoh.length;
    if(ourThumb.brightness<avgB*0.6)
      out.thumb.push('Miniature nettement plus sombre ('+Math.round(ourThumb.brightness)+'/255) que la moyenne des meilleures miniatures du genre ('+Math.round(avgB)+'/255) — risque de mal ressortir dans le fil, surtout en dark mode. Essaie un point lumineux net (lune, bougie, lampe) qui contraste avec le fond.');
    else if(ourThumb.brightness>avgB*1.6)
      out.thumb.push('Miniature beaucoup plus claire que la moyenne des meilleures miniatures du genre ('+Math.round(ourThumb.brightness)+' vs '+Math.round(avgB)+'/255) — vérifie qu’elle ne soit pas plate/cramée en petit format mobile.');
    if(ourThumb.contrast<avgC*0.65)
      out.thumb.push('Contraste faible ('+Math.round(ourThumb.contrast)+' vs '+Math.round(avgC)+' en moyenne pour les meilleures miniatures du genre) — le sujet principal risque de ne pas se détacher assez en vignette 120px. Renforce l’opposition sombre/clair autour du sujet.');
    if(Math.abs(avgW)>10&&Math.sign(ourThumb.warmth)!==Math.sign(avgW))
      out.thumb.push('Palette '+(ourThumb.warmth<0?'froide (bleu/nuit)':'chaude (orange/doré)')+' alors que les meilleures miniatures du genre sont plutôt '+(avgW<0?'froides':'chaudes')+' — pas rédhibitoire, mais à tester en priorité si le CTR est faible.');
    if(!out.thumb.length)out.thumb.push('Miniature dans la moyenne (luminosité, contraste, teinte) des meilleures du genre — la composition n’est probablement pas le frein principal.');
  }else if(!ourThumb.ok){
    out.thumb.push('Analyse colorimétrique impossible pour cette miniature (image indisponible) — vérification visuelle manuelle recommandée vs les miniatures les plus vues du genre.');
  }
  /* ---- SEO réel : tags + description scrapés de YouTube ---- */
  const S=window.SEO||{};
  const mine=S[o.vid];
  const cohSeo=Object.values(S).filter(x=>x.who==='coh'&&x.gk===o.gk&&x.kw&&x.kw.length);
  if(mine&&mine.kw&&cohSeo.length>=3){
    const norm=t=>String(t).toLowerCase().trim();
    const mySet=new Set(mine.kw.map(norm));
    // fréquence des tags chez les tops du genre
    const freq={};
    cohSeo.forEach(c=>{ new Set(c.kw.map(norm)).forEach(t=>{freq[t]=(freq[t]||0)+1;}); });
    const half=Math.ceil(cohSeo.length/2);
    const missing=Object.entries(freq)
      .filter(([t,n])=>n>=half&&!mySet.has(t)&&!/lofi girl|chilledcow|lofigirl|chilled cow/.test(t))
      .sort((a,b)=>b[1]-a[1]).slice(0,10);
    if(missing.length)
      out.kw.push('Tags utilisés par les tops '+o.gk+' mais absents de cette vidéo : '+missing.map(([t,n])=>'«'+t+'» ('+n+'/'+cohSeo.length+')').join(', ')+'. Ce sont les ajouts les plus rentables — YouTube s’en sert pour les suggestions «à côté de».');
    // nos tags que personne d'autre n'utilise (hors branding)
    const brandRx=/lofi girl|lofigirl|chilledcow|chilled cow|lofi boy|synthwave boy/;
    const unused=mine.kw.filter(t=>!freq[norm(t)]&&!brandRx.test(norm(t)));
    if(unused.length>=Math.max(4,mine.kw.length*0.5))
      out.kw.push(unused.length+' de nos '+mine.kw.length+' tags ne sont utilisés par aucun top du genre (ex. '+unused.slice(0,5).map(t=>'«'+t+'»').join(', ')+') — pas forcément faux, mais si le CTR/les impressions déçoivent, remplace les moins pertinents par les tags fréquents ci-dessus.');
    const medKw=median(cohSeo.map(c=>c.kw.length));
    if(mine.kw.length<medKw*0.6)
      out.kw.push('Seulement '+mine.kw.length+' tags contre '+Math.round(medKw)+' en médiane chez les tops du genre — il reste de la marge de couverture (variantes «for sleep», «for study», «mix», langue).');
    // description
    const medDl=median(cohSeo.map(c=>c.dl||0));
    if(mine.dl!=null&&medDl&&mine.dl<medDl*0.5)
      out.kw.push('Description courte ('+mine.dl+' caractères vs '+Math.round(medDl)+' en médiane chez les tops) — les descriptions longues avec mots-clés répétés naturellement aident la recherche et les suggestions.');
    const hookLower=(mine.hook||'').toLowerCase();
    const hookHasKw=mine.kw.slice(0,10).some(t=>hookLower.includes(norm(t).split(' ')[0]));
    if(mine.hook&&!hookHasKw)
      out.kw.push('Les 125 premiers caractères de la description (visibles avant «plus») ne contiennent aucun de nos tags principaux — c’est la zone la plus lue par l’algo et par l’utilisateur : reformule le hook avec le mot-clé cible.');
    const tsPct=Math.round(cohSeo.filter(c=>c.ts).length/cohSeo.length*100);
    if(!mine.ts&&tsPct>=60)
      out.kw.push('Pas de tracklist/timestamps dans la description alors que '+tsPct+'% des tops du genre en ont — les chapitres génèrent des «key moments» dans la recherche Google/YouTube.');
    if(!out.kw.length)out.kw.push('Tags et description bien alignés avec les pratiques des tops du genre ('+mine.kw.length+' tags, description '+mine.dl+' caractères) — le SEO n’est probablement pas le frein.');
  }else if(o.reco){
    const kwCount=(o.reco.kw||'').split(',').map(s=>s.trim()).filter(Boolean).length;
    if(!o.reco.kw)out.kw.push('Aucun mot-clé SEO renseigné pour cette sortie — impossible de vérifier le ciblage de recherche au lancement.');
    else out.kw.push(kwCount+' mots-clés SEO renseignés (données de reco, pas de scrape YouTube pour cette vidéo).');
  }else{
    out.kw.push('Pas de données SEO scrapées pour cette vidéo — relance un scan SEO pour l’inclure.');
  }
  return out;
}
/* ---- Proposition d'optimisation concrète, prête à copier ---- */
const OPTIM_REG={};
function benefitFor(t){
  if(/sleep/.test(t))return 'for deep sleep';
  if(/study|focus/.test(t))return 'for study & focus';
  if(/relax/.test(t))return 'to relax';
  if(/meditat/.test(t))return 'for meditation';
  if(/heal/.test(t))return 'for healing & calm';
  return null;
}
function optimWordDiff(oldText,newText){
  const a=(String(oldText||'').match(/\S+\s*/g)||[]),b=(String(newText||'').match(/\S+\s*/g)||[]);
  const norm=x=>x.trim().toLowerCase();
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=norm(a[i])===norm(b[j])?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const ops=[];let i=0,j=0;
  const push=(type,text)=>{const last=ops[ops.length-1];if(last&&last.type===type)last.text+=text;else ops.push({type,text});};
  while(i<a.length&&j<b.length){
    if(norm(a[i])===norm(b[j])){push('keep',b[j]);i++;j++;}
    else if(dp[i+1][j]>=dp[i][j+1]){push('remove',a[i]);i++;}
    else{push('add',b[j]);j++;}
  }
  while(i<a.length)push('remove',a[i++]);
  while(j<b.length)push('add',b[j++]);
  return ops;
}
function optimTextDiffHTML(oldText,newText){
  return '<div class="optim-text">'+optimWordDiff(oldText,newText).map(x=>'<span class="optim-'+x.type+'">'+esc(x.text)+'</span>').join('')+'</div>';
}
function optimChipHTML(text,type){return '<span class="optim-chip optim-'+type+'">'+esc(text)+'</span>';}
function buildOptimProposal(o){
  const S=window.SEO||{};const m=S[o.vid];
  if(!m||!m.kw)return null;
  const norm=t=>String(t).toLowerCase().trim();
  const cohSeo=Object.values(S).filter(x=>x.who==='coh'&&x.gk===o.gk&&x.kw&&x.kw.length);
  if(cohSeo.length<3)return null;
  const freq={};cohSeo.forEach(c=>new Set(c.kw.map(norm)).forEach(t=>freq[t]=(freq[t]||0)+1));
  const half=Math.ceil(cohSeo.length/2);
  const mySet=new Set(m.kw.map(norm));
  const brandRx=/lofi girl|lofigirl|chilledcow|chilled cow|lofi boy/;
  const missing=Object.entries(freq).filter(([t,n])=>n>=half&&!mySet.has(t)&&!brandRx.test(t)).sort((a,b)=>b[1]-a[1]).map(([t])=>t);
  // liste proposée : marque + nos tags avec traction + tags manquants fréquents, plafond 480 caractères (limite YouTube 500)
  const brand=m.kw.filter(t=>brandRx.test(norm(t)));
  const withTraction=m.kw.filter(t=>!brandRx.test(norm(t))&&freq[norm(t)]>=1);
  const noTraction=m.kw.filter(t=>!brandRx.test(norm(t))&&!freq[norm(t)]);
  let tags=[...brand,...missing,...withTraction];
  // compléter avec nos tags sans traction s'il reste de la place
  for(const t of noTraction){if(tags.join(', ').length+t.length+2<=480)tags.push(t);}
  while(tags.join(', ').length>480)tags.pop();
  const dedup=[];const seen=new Set();
  tags.forEach(t=>{if(!seen.has(norm(t))){seen.add(norm(t));dedup.push(t);}});
  const finalSet=new Set(dedup.map(norm));
  const kept=dedup.filter(t=>mySet.has(norm(t)));
  const added=dedup.filter(t=>!mySet.has(norm(t)));
  const removed=m.kw.filter(t=>!finalSet.has(norm(t)));
  // suggestion de titre
  const sig=titleSignals(o.title);
  const cohSigs=cohSeo.map(c=>titleSignals(c.hook||''));
  let titleSug=null;
  const mainKw=missing[0]||null;
  const ben=missing.map(benefitFor).find(Boolean);
  if(ben&&!POWER_WORDS.some(w=>o.title.toLowerCase().includes(w))) titleSug=o.title+' | '+ben;
  else if(mainKw&&!sig.hasSeparator) titleSug=o.title+' | '+mainKw;
  if(!titleSug)titleSug=o.title;
  // hook de description
  let hookSug=null;
  if(missing.length){
    const kws=missing.slice(0,2).join(' · ');
    hookSug=(o.title.replace(/[|:].*$/,'').trim())+' — '+kws+(ben?' '+ben:'')+'. '+(m.hook?'(remplace le début actuel : «'+m.hook.slice(0,60)+'…»)':'');
  }
  // full suggested description: optimized hook + standard Lofi Girl boilerplate
  const cleanT=o.title.replace(/[|:].*$/,'').trim();
  const kwLine=missing.slice(0,4).join(', ');
  const introSug=cleanT+(ben?' — '+ben:'')+'. '+(kwLine?('Perfect '+kwLine+'. '):'')+'Press play, settle in and let it run.';
  const descSug=introSug+'\n\n'+
    '🎼 | Listen on Spotify, Apple music and more →\nhttps://fanlink.tv/[a-completer]\n\n'+
    '🎶 | Tracklist\n[00:00] [Artiste] - [Titre]\n[XX:XX] [Artiste] - [Titre]\n\n'+
    '🌎 | Lofi Girl on all social media → https://link.lofigirl.com/m/Community\n'+
    '🌐 | Our Websites → https://link.lofigirl.com/m/website\n'+
    '👕 | Lofi Girl merch → https://link.lofigirlshop.com/shop\n'+
    '🎮 | Our video games → https://link.lofigirl.com/m/games\n\n'+
    '🙏 Thank you for listening\n❤️ All visuals and music in this video are 100% crafted by talented human artists';
  const p={tags:dedup,tagsStr:dedup.join(', '),kept,added,removed,titleSug,hookSug,descSug,currentHook:m.hook||'',missTop:missing.slice(0,8),needTs:!m.ts};
  OPTIM_REG[o.vid]=p;
  return p;
}
function copyOptim(vid,what,btn){
  const p=OPTIM_REG[vid];if(!p)return;
  const txt=what==='tags'?p.tagsStr:what==='title'?p.titleSug:what==='desc'?p.descSug:p.hookSug;
  navigator.clipboard.writeText(txt||'').then(()=>{const o=btn.textContent;btn.textContent='✓ Copied';setTimeout(()=>btn.textContent=o,1400);});
}
function optimHTML(o,p){
  if(!p)return '';
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  let h='<div class="dw-sec" style="border:1px solid rgba(255,0,51,.35);border-radius:12px;padding:14px;background:rgba(255,0,51,.06)">';
  h+='<div class="k">🛠️ Optimization proposal (ready to paste into Studio)</div><div class="v">';
  h+='<b style="color:var(--acc2)">Suggested keywords ('+p.tags.length+' tags, '+p.tagsStr.length+'/500 characters)</b>:'+
    '<div class="optim-diff">'+p.kept.map(t=>optimChipHTML(t,'keep')).join('')+p.added.map(t=>optimChipHTML(t,'add')).join('')+p.removed.map(t=>optimChipHTML(t,'remove')).join('')+'</div>'+
    '<button class="copybtn" onclick="copyOptim(\''+o.vid+'\',\'tags\',this)">⧉ Copy keywords</button>';
  if(p.titleSug)h+='<br><br><b style="color:var(--acc2)">Suggested title</b>:<div class="optim-text">'+esc(p.titleSug)+'</div><button class="copybtn" onclick="copyOptim(\''+o.vid+'\',\'title\',this)">⧉ Copy title</button>';
  if(p.descSug)h+='<br><br><b style="color:var(--acc2)">Suggested description</b>:<div class="optim-text">'+esc(p.descSug)+'</div><button class="copybtn" onclick="copyOptim(\''+o.vid+'\',\'desc\',this)">⧉ Copy description</button>';
  if(p.needTs)h+='<br><br><b style="color:var(--amber)">⏱ Add the tracklist with timestamps</b> — generates “key moments” in Google/YouTube search.';
  h+='</div></div>';
  if(fr)h=frz(h);
  return h;
}
function deepAuditHTML(a,o){
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const sec=(icon,title,items)=>!items.length?'':'<div class="dw-sec"><div class="k">'+icon+' '+title+'</div><div class="v">'+items.map(x=>'• '+x).join('<br><br>')+'</div></div>';
  if(!a.coh){
    let h0='<div class="dw-sec"><div class="k">🔬 Deep packaging audit</div><div class="v">Not enough comparable videos in this genre for a reliable audit.</div></div>';
    return fr?frz(h0):h0;
  }
  const p=o?buildOptimProposal(o):null;
  let h=sec('🎨','Thumbnail — composition & color',a.thumb)+
    sec('✍️','Title',a.title)+
    sec('🔎','Description & keywords',a.kw)+
    (p?optimHTML(o,p):'');
  if(fr)h=frz(h);
  return h;
}
function vBadge(v){
  return v==='over'?'<span class="verdict v-over">Overperforming</span>':
    v==='inline'?'<span class="verdict v-inline">In line</span>':
    v==='under'?'<span class="verdict v-under">Underperforming</span>':
    '<span class="verdict v-early">Too early</span>';
}
function pcol(p){return p==null?'#94a3b8':p>=70?'#34d399':p>=40?'#fbbf24':'#f87171';}
function vsMed(v,med){
  if(v==null||med==null||!med)return 'var(--text)';
  return v>=med*1.15?'#34d399':(v<=med*0.85?'#f87171':'#fbbf24');
}
function fmtPct(v){return v==null?'—':(v>=10?Math.round(v):v.toFixed(1))+'%';}
function tipText(val,med,fmt,baseline){
  if(val==null||med==null||!med)return '';
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const f=fmt||fmtN;
  const diff=Math.round((val/med-1)*100);
  const rel=diff>0?('+'+diff+'% '+(fr?'au-dessus de la médiane chaîne':'above channel median')):diff<0?(diff+'% '+(fr?'sous la médiane chaîne':'below channel median')):(fr?'dans la médiane chaîne':'at channel median');
  const label=baseline||(fr?'Médiane chaîne : ':'Channel median: ');
  return label+f(med)+'  ·  '+rel;
}
function tipHTML(val,med,fmt,baseline){
  if(val==null||med==null||!med)return '';
  const fr=typeof LANG!=='undefined'&&LANG==='fr';
  const f=fmt||fmtN,diff=Math.round((val/med-1)*100),col=vsMed(val,med);
  const pct=(diff>0?'+':'')+diff+'%';
  const rel=diff>0?(fr?' au-dessus de la médiane chaîne':' above channel median'):
    diff<0?(fr?' sous la médiane chaîne':' below channel median'):(fr?' dans la médiane chaîne':' at channel median');
  const label=baseline||(fr?'Médiane chaîne : ':'Channel median: ');
  return '<span class="metric-tip" style="--tipc:'+col+'">'+esc(label)+esc(f(med))+' · <b>'+pct+'</b>'+rel+'</span>';
}
document.addEventListener('pointerover',e=>{
  const wrap=e.target.closest&&e.target.closest('.vcard.ana-c .tipw');
  if(!wrap||wrap.contains(e.relatedTarget))return;
  const tip=wrap.querySelector('.metric-tip');if(!tip)return;
  tip.style.setProperty('--tip-shift','0px');
  requestAnimationFrame(()=>{
    if(!tip.isConnected)return;
    const r=tip.getBoundingClientRect(),main=document.getElementById('main');
    const left=(main?main.getBoundingClientRect().left:0)+8,right=(document.documentElement.clientWidth||window.innerWidth)-8;
    const shift=r.left<left?left-r.left:r.right>right?right-r.right:0;
    tip.style.setProperty('--tip-shift',shift+'px');
  });
});
function anaStat(val,med,lbl,hl,fmt,baseline){
  const f=fmt||fmtN;
  const tip=tipText(val,med,f,baseline);
  const col=vsMed(val,med);
  return '<div class="vstat'+(hl?' hl':'')+(tip?' tipw':'')+'"'+(tip?' style="--tipc:'+col+'"':'')+'><b style="color:'+col+'">'+f(val)+'</b><span>'+lbl+'</span>'+tipHTML(val,med,f,baseline)+'</div>';
}
function anaProgressBarHTML(o){
  const hasPercentile=Number.isFinite(Number(o&&o.pctCh));
  const width=hasPercentile?Math.max(0,Math.min(100,Number(o.pctCh))):50;
  const color=hasPercentile?pcol(Number(o.pctCh)):'#64748b';
  return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0 10px"><div class="pbar" aria-label="'+(hasPercentile?'Channel performance percentile':'Channel performance comparison pending')+'"><i style="width:'+width+'%;background:'+color+'"></i></div></div>';
}
function anaCardHTML(o,i){
  const cmt=(window.CMT&&window.CMT[o.vid]!=null)?window.CMT[o.vid]:null;
  const ageRef='Same-age channel median ('+o.chAgeLabel+') · ';
  return '<div class="vcard ana-c" onclick="openAnaIdx('+i+')">'+
    '<div class="thumbwrap"><img loading="lazy" src="'+thumb(o.vid)+'" onerror="this.style.visibility=\'hidden\'"></div>'+
    '<div class="vbody">'+
      '<div class="vtitle">'+esc(o.title)+'</div>'+
      '<div class="vtags">'+gtag(o.genre)+(o.durH!=null?ghosttag(fmtDur(o.durH)):'')+(o.pub?'<span class="tag ghost">📅 '+fmtDateFull(o.pub)+'</span>':'')+'</div>'+
      anaProgressBarHTML(o)+
      '<div class="vstats">'+
        anaStat(o.views,o.medViews,'views',true,null,ageRef)+
        anaStat(o.vpm,o.chMed,'views/mo',false,null,ageRef)+
        '<div class="vstat" data-alikesw="'+o.vid+'"><b data-alikes="'+o.vid+'">…</b><span>likes</span></div>'+
        anaStat(cmt,o.medCmt,'comments',false,null,ageRef)+
        (o.st&&o.st.awp!=null?anaStat(o.st.awp,o.awpMed,'avg view',false,fmtPct,ageRef):'')+
      '</div></div></div>';
}
function fillAnaLikes(){
  const rows=window._page_ana||[];if(!rows.length)return;
  const els={};document.querySelectorAll('[data-alikes]').forEach(el=>{els[el.getAttribute('data-alikes')]=el;el.removeAttribute('data-alikes');});
  if(!Object.keys(els).length)return;
  let pending=0;const got={};
  rows.forEach(o=>{pending++;fetchLikes(o.vid,n=>{got[o.vid]=n;if(--pending===0)done();});});
  function done(){
    for(const vid in els){
      const el=els[vid],n=got[vid];
      if(n==null){el.textContent='—';continue;}
      const row=rows.find(o=>o.vid===vid);
      const peers=row?anaAgeComparable(rows.filter(o=>o.vid!==vid&&got[o.vid]!=null),row.ageDays,2):{rows:[],label:'same age'};
      const med=median((peers.sufficient?peers.rows:[]).map(o=>got[o.vid]));
      const col=vsMed(n,med);
      el.textContent=fmtN(n);
      el.style.color=col;
      const tip=tipText(n,med,fmtN,'Same-age channel median ('+peers.label+') · ');
      const wrap=el.closest('[data-alikesw]');
      if(tip&&wrap){wrap.classList.add('tipw');wrap.style.setProperty('--tipc',col);wrap.insertAdjacentHTML('beforeend',tipHTML(n,med,fmtN,'Same-age channel median ('+peers.label+') · '));}
    }
  }
}
function anaHTML(){
  ensureAnalysisHistory();
  const rows=[...anaRows()];
  if(!rows.length)return '<div class="empty">No long-form releases found in the 🎯 Our Videos tab.</div>';
  const sf=AS.sort;
  rows.sort((a,b)=>sf==='date'?(b.pub-a.pub):sf==='pctAsc'?((a.pct==null?101:a.pct)-(b.pct==null?101:b.pct)):sf==='pctDesc'?((b.pct==null?-1:b.pct)-(a.pct==null?-1:a.pct)):(b.views||0)-(a.views||0));
  let h='';
  const asSortKeys=[['date','🆕','Newest first'],['pctAsc','📉','Worst performing'],['pctDesc','📈','Best performing'],['views','👀','Most views']];
  const asSortOpts=asSortKeys.map(s=>({label:s[1]+' '+s[2],sel:sf===s[0],onclick:'AS.sort='+jsq(s[0])+';render()'}));
  const asSortRow=asSortKeys.find(s=>s[0]===sf)||asSortKeys[0];
  h+='<div class="toolbar">'+xdd('c-sort',asSortRow[1]+' '+asSortRow[2],asSortOpts)+
    '<div class="tb-right"><div class="viewtoggle">'+
      '<button class="'+(AS.mode!=='table'?'on':'')+'" onclick="AS.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(AS.mode==='table'?'on':'')+'" onclick="AS.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div></div></div>';
  window._page_ana=rows;
  if(AS.mode==='table'){
    h+=rows.map((o,i)=>{
      return '<div class="ana-card" onclick="openAnaIdx('+i+')">'+
        '<img loading="lazy" src="'+thumb(o.vid)+'" onerror="this.style.visibility=\'hidden\'">'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:600;font-size:13.5px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(o.title)+'</div>'+
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px">'+gtag(o.genre)+ghosttag(o.perso)+(o.durH!=null?ghosttag(fmtDur(o.durH)):'')+'<span class="tag ghost">'+fmtDateFull(o.pub)+'</span>'+(o.st?'<span class="tag ghost" style="color:'+(o.ctrMed&&o.st.ctr<o.ctrMed*0.75?'#f87171':o.ctrMed&&o.st.ctr>o.ctrMed*1.25?'#34d399':'var(--muted)')+'">CTR '+o.st.ctr.toFixed(1)+'%</span><span class="tag ghost" style="color:'+vsMed(o.st.awtMs,o.awtMed)+'">avg view '+fmtWatch(o.st.awtMs)+'</span>':'')+(o.reco?'<span class="tag ghost">reco #'+Math.round(o.reco.n)+(o.reco.pot?' · '+o.reco.pot[0]:'')+'</span>':'')+'</div>'+
          anaProgressBarHTML(o)+
        '</div>'+
        '<div style="text-align:right;flex:none">'+
          '<div style="font-family:Sora;font-size:17px;font-weight:700;color:'+pcol(o.pctCh)+'">'+fmtN(o.views)+'</div>'+
          '<div style="font-size:10.5px;color:'+vsMed(o.vpm,o.chMed)+';margin-bottom:8px;font-weight:600">'+fmtN(o.vpm)+' views/mo</div>'+
        '</div></div>';
    }).join('');
  }else{
    h+='<div class="vgrid">'+rows.map((o,i)=>anaCardHTML(o,i)).join('')+'</div>';
  }
  return h;
}
function openAnaIdx(i,historyReload){
  const o=(window._page_ana||[])[i];if(!o)return;
  window._openAnaVid=o.vid;
  if(!videoHistoryReady(o.vid)&&!videoHistoryBusy(o.vid)&&!videoHistoryError(o.vid)&&!historyReload)ensureVideoHistory(o.vid);
  const sec=(k,val,icon)=>val?'<div class="dw-sec"><div class="k">'+(icon||'')+' '+k+'</div><div class="v">'+val+'</div></div>':'';
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    '<div class="dw-embed"><iframe src="https://www.youtube.com/embed/'+o.vid+'?rel=0" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>'+
    '<div class="dw-body">'+
      '<div class="dw-title"><a href="'+esc(o.url)+'" target="_blank">'+esc(o.title)+'</a></div>'+
      '<div class="dw-sub">'+gtag(o.genre)+ghosttag(o.perso)+vBadge(o.verdict)+likeTag(o.vid)+'</div>'+
      '<div class="dw-stats">'+
        '<div class="dw-stat hl"><b style="color:'+pcol(o.pctCh)+'">'+(o.pctCh==null?'—':o.pctCh+'th')+'</b><span>percentile · channel</span></div>'+
        '<div class="dw-stat"><b style="color:'+pcol(o.pct)+'">'+(o.pct==null?'—':o.pct+'th')+'</b><span>percentile vs market</span></div>'+
        '<div class="dw-stat"><b style="color:'+vsMed(o.vpm,o.chMed)+'">'+fmtN(o.vpm)+'</b><span>views/mo lifetime</span></div>'+
        '<div class="dw-stat"><b style="color:'+vsMed(o.vNow,o.vpm)+'">'+fmtN(o.vNow)+'</b><span>views/mo now</span></div>'+
      '</div>'+
      '<div class="dw-sec"><div class="k">⚖️ Age-matched comparison</div><div class="v">Published '+fmtDateFull(o.pub)+' · '+Math.round(o.ageDays||0)+' days old · market cohort: '+esc(o.cohAgeLabel||'—')+' ('+fmtInt(o.cohN||0)+' videos) · channel cohort: '+esc(o.chAgeLabel||'—')+' ('+fmtInt(o.chN||0)+' videos). Raw totals stay visible; performance colors and percentiles only compare releases at a similar age.</div></div>'+
      (o.st?'<div class="dw-stats" style="margin-top:10px">'+
        '<div class="dw-stat"><b>'+fmtN(o.st.imp)+'</b><span>impressions</span></div>'+
        '<div class="dw-stat"><b style="color:'+vsMed(o.st.ctr,o.ctrMed)+'">'+o.st.ctr.toFixed(1)+'%</b><span>CTR (median '+(o.ctrMed?o.ctrMed.toFixed(1):'—')+'%)</span></div>'+
        '<div class="dw-stat"><b style="color:'+vsMed(o.st.awtMs,o.awtMed)+'">'+fmtWatch(o.st.awtMs)+'</b><span>avg view duration (median '+fmtWatch(o.awtMed)+')</span></div>'+
        '<div class="dw-stat"><b style="color:'+vsMed(o.st.awp,o.awpMed)+'">'+o.st.awp.toFixed(1)+'%</b><span>avg watched (median '+(o.awpMed?o.awpMed.toFixed(0):'—')+'%)</span></div>'+
      '</div>':'')+
      '<div class="dw-sec">'+videoHistoryPanel(o.vid,(DATA.hist&&DATA.hist[o.vid])||null,true)+'</div>'+
      sec('Diagnosis',(o.diags||[]).map(d=>'• '+esc(d)).join('<br>'),'🔬')+
      (o.reco?sec('Linked recommendation','#'+Math.round(o.reco.n)+' · '+esc(o.reco.title)+(o.reco.pot?' · predicted '+esc(o.reco.pot):'')+(o.reco.scoreAdj!=null?' · score '+Math.round(o.reco.scoreAdj):''),'💡'):'')+
      '<div id="deepaudit" class="dw-sec"><div class="k">🔬 Deep audit (thumbnail, title, SEO)</div><div class="v">Analysis in progress <span class="spin-inline"></span></div></div>'+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  fillLikes();i18nDrawer();
  buildDeepAudit(o).then(a=>{
    const el=document.getElementById('deepaudit');
    if(el)el.outerHTML=deepAuditHTML(a,o);
  });
}

/* ================= LIVESTREAMS ================= */
const LIKES={};let LQ=[],LRUN=0;
function fetchLikes(vid,cb){
  if(vid in LIKES){cb(LIKES[vid]);return;}
  LQ.push([vid,cb]);pumpLikes();
}
function pumpLikes(){
  while(LRUN<5&&LQ.length){
    const q=LQ.shift();LRUN++;
    fetch('https://returnyoutubedislikeapi.com/votes?videoId='+q[0])
      .then(r=>r.ok?r.json():null).then(j=>{LIKES[q[0]]=(j&&j.likes!=null)?j.likes:null;})
      .catch(()=>{LIKES[q[0]]=null;})
      .then(()=>{LRUN--;q[1](LIKES[q[0]]);pumpLikes();});
  }
}
function fillLikes(){
  document.querySelectorAll('[data-likes]').forEach(el=>{
    const vid=el.getAttribute('data-likes');el.removeAttribute('data-likes');
    fetchLikes(vid,n=>{if(n!=null){el.innerHTML='👍 '+fmtN(n);el.style.display='';}else el.remove();});
  });
}
function likeTag(vid){return vid?'<span class="tag ghost" style="display:none" data-likes="'+vid+'"></span>':'';}
function liveSeries(vid){
  const a=((DATA.liveHist&&DATA.liveHist[vid])||[]).concat((DATA.liveHourly&&DATA.liveHourly[vid])||[]);
  a.sort((x,y)=>x[0]-y[0]);
  const out=[];let last=null;
  for(const p of a){if(p[0]!==last){out.push(p);last=p[0];}}
  return out;
}
function liveNow(vid){const s=liveSeries(vid);return s.length?s[s.length-1][1]:null;}
function livePeak(vid){const s=liveSeries(vid);return s.length?Math.max.apply(null,s.map(p=>p[1])):null;}
function livePeak24h(vid){const s=liveSeries(vid).filter(p=>p[0]>=Date.now()-86400000);return s.length?Math.max.apply(null,s.map(p=>p[1])):null;}
function isOurs(ch){return /lofi girl|lofi records/i.test(ch||'');}
function filterLives(){
  let rows=DATA.lives||[];
  if(LS.q){const q=LS.q.toLowerCase();rows=rows.filter(v=>(v.title+' '+v.channel+' '+v.disc).toLowerCase().includes(q));}
  const sf=LS.sort;
  return [...rows].sort((a,b)=>{
    if(sf==='now')return (liveNow(b.vid)||0)-(liveNow(a.vid)||0);
    if(sf==='peak')return (livePeak(b.vid)||0)-(livePeak(a.vid)||0);
    if(sf==='started')return (b.started||0)-(a.started||0);
    if(sf==='channel')return String(a.channel).localeCompare(String(b.channel));
    return 0;
  });
}
function livesHTML(){
  const rows=filterLives();const all=DATA.lives||[];
  if(!all.length)return '<div class="empty">No livestream data yet — the 📡 Live Streams tab of the Sheet is empty or missing. It fills up on the next ChatGPT scan.</div>';
  const lsSortKeys=[['now','🔴','Viewers now'],['peak','🚀','Peak viewers'],['started','🆕','Recently started'],['channel','👥','Channel']];
  const lsSortOpts=lsSortKeys.map(s=>({label:s[1]+' Sort · '+s[2],sel:LS.sort===s[0],onclick:'LS.sort='+jsq(s[0])+';rerenderLives()'}));
  const lsSortRow=lsSortKeys.find(s=>s[0]===LS.sort)||lsSortKeys[0];
  let h='<div class="toolbar">'+
    '<div class="search">'+ICONS.search+'<input placeholder="Search streams, channels, keywords…" value="'+esc(LS.q)+'" oninput="LS.q=this.value;LS.limit=60;rerenderLives()"><kbd>/</kbd></div>'+
    '<div class="tb-right">'+xdd('c-sort',lsSortRow[1]+' Sort · '+lsSortRow[2],lsSortOpts)+
    '<div class="viewtoggle">'+
      '<button class="'+(LS.mode==='grid'?'on':'')+'" onclick="LS.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(LS.mode==='table'?'on':'')+'" onclick="LS.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div></div>'+
  '</div>';
  h+='<div id="live-list">'+liveListHTML(rows)+'</div>';
  return h;
}
function liveCardHTML(v,i){
  const now=liveNow(v.vid),peak24=livePeak24h(v.vid),peakAll=livePeak(v.vid);
  const chSubs=subsFor(v);
  return '<div class="vcard" onclick="openLiveIdx('+i+')">'+
    '<div class="thumbwrap"><img loading="lazy" src="'+thumb(v.vid)+'" onerror="if(!this._f){this._f=1;this.src=\'https://i.ytimg.com/vi/'+v.vid+'/hqdefault.jpg\'}else this.style.visibility=\'hidden\'">'+
      '<span class="vpm-flag" style="background:rgba(220,38,38,.94);color:#fff"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff1a1a;box-shadow:0 0 0 0.8px rgba(255,255,255,.9);margin-right:2px"></span> '+fmtN(now)+' watching</span>'+
      '<span class="like-flag" style="display:none" data-likes="'+v.vid+'"></span>'+'</div>'+
    '<div class="vbody">'+
      '<div class="vtitle">'+esc(v.title)+'</div>'+
      '<div class="vmeta">'+vChanAva(v,17)+'<a href="'+esc(v.url)+'" target="_blank" onclick="event.stopPropagation()">'+esc(v.channel)+'</a>'+(chSubs!=null?'<span class="subs">· '+fmtN(chSubs)+' subs</span>':'')+'</div>'+
      '<div class="vstats">'+
        '<div class="vstat hl"><b>'+fmtN(peak24)+'</b><span>peak 24h</span></div>'+
        '<div class="vstat"><b>'+fmtN(peakAll)+'</b><span>peak all-time</span></div>'+
        '<div class="vstat"><b>'+fmtDate(v.started)+'</b><span>started</span></div>'+
      '</div></div></div>';
}
function liveListHTML(rows){
  if(!rows.length)return '<div class="empty">Nothing matches — try clearing the search.</div>';
  const page=rows.slice(0,LS.limit);
  window._page_live=page;
  if(LS.mode==='grid'){
    let g='<div class="vgrid">'+page.map((v,i)=>liveCardHTML(v,i)).join('')+'</div>';
    if(rows.length>LS.limit)g+='<button class="load-more" onclick="LS.limit+=120;rerenderLives()">Loading more · '+fmtInt(rows.length-LS.limit)+' remaining</button>';
    return g;
  }
  let h='<table class="vtable"><thead><tr><th></th><th>Stream</th><th>Channel</th><th>👀 Now</th><th>Peak</th><th>Started</th><th>Discovery keywords</th></tr></thead><tbody>'+
    page.map((v,i)=>{
      const now=liveNow(v.vid),peak=livePeak(v.vid);
      return '<tr class="row" onclick="openLiveIdx('+i+')">'+
      '<td><img class="tthumb" loading="lazy" src="'+thumb(v.vid)+'" onerror="if(!this._f){this._f=1;this.src=\'https://i.ytimg.com/vi/'+v.vid+'/hqdefault.jpg\'}else this.style.visibility=\'hidden\'"></td>'+
      '<td class="ttitle">'+esc(v.title)+'</td>'+
      '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(v.channel)+'</td>'+
      '<td class="num vpmcell">'+fmtN(now)+'</td><td class="num">'+fmtN(peak)+'</td>'+
      '<td class="num">'+fmtDate(v.started)+'</td>'+
      '<td style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11.5px">'+esc(v.disc)+'</td></tr>';
    }).join('')+'</tbody></table>';
  if(rows.length>LS.limit)h+='<button class="load-more" onclick="LS.limit+=120;rerenderLives()">Loading more · '+fmtInt(rows.length-LS.limit)+' remaining</button>';
  return h;
}
function rerenderLives(){
  const rows=filterLives();
  const el=document.getElementById('live-list');
  if(el)el.innerHTML=liveListHTML(rows);
  i18nZone(el);armAutoLoad();fillLikes();
}
function openLiveIdx(i){const v=(window._page_live||[])[i];if(v)openLiveDrawer(v);}
function openLiveDrawer(v){
  const all=liveSeries(v.vid);
  let s=all.filter(p=>p[0]>=Date.now()-7*24*3600000);
  if(s.length<2)s=all;
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    '<div class="dw-embed"><iframe src="https://www.youtube.com/embed/'+v.vid+'?rel=0" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>'+
    '<div class="dw-body">'+
      '<div class="dw-title"><a href="'+esc(v.url)+'" target="_blank">'+esc(v.title)+'</a></div>'+
      '<div class="dw-sub"><span class="tag ghost" style="gap:6px">'+vChanAva(v,18)+esc(v.channel)+'</span><span class="tag ghost">🔴 live</span>'+likeTag(v.vid)+'</div>'+
      '<div class="dw-stats">'+
        '<div class="dw-stat hl"><b>'+fmtN(liveNow(v.vid))+'</b><span>watching now</span></div>'+
        '<div class="dw-stat"><b>'+fmtN(livePeak(v.vid))+'</b><span>peak measured</span></div>'+
        '<div class="dw-stat"><b>'+fmtDate(v.started)+'</b><span>started</span></div>'+
        '<div class="dw-stat"><b>'+s.length+'</b><span>scans</span></div>'+
      '</div>'+
      '<div class="dw-sec"><div class="k">📡 Concurrent viewers · last 7 days</div>'+histChart(s,'viewers')+'</div>'+
      (v.disc?'<div class="dw-sec"><div class="k">🔎 Discovery keywords</div><div class="v">'+esc(v.disc)+'</div></div>':'')+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  fillLikes();i18nDrawer();
}

/* ================= CHANNELS ================= */
function handleOf(u){const m=String(u||'').match(/@([^\/?]+)/);if(m)return '@'+m[1];const m2=String(u||'').match(/channel\/(UC[\w-]+)/);return m2?m2[1]:'';}
function avaFallback(img,handle){
  if(handle&&!img.dataset.fb&&!/unavatar\.io\/youtube\//i.test(img.src||'')){
    img.dataset.fb='1';
    img.onerror=function(){this.remove();};
    img.src='https://unavatar.io/youtube/'+encodeURIComponent(handle)+'?fallback=false';
    return;
  }
  img.remove();
}
function vChanAva(v,size){
  const atlas=window.YT_CHANNEL_AVATARS||{},channels=atlas.channels||{},videos=atlas.videos||{},aliases=atlas.aliases||{};
  const uc=handleOf(v.chUrl||''),explicit=/^UC[\w-]{22}$/.test(String(v.channelId||''))?String(v.channelId):'';
  const channelKey=explicit||aliases[uc]||uc;
  const c=(typeof chanFor==='function'?chanFor(v):null)||null;
  let src=(channelKey&&channels[channelKey])||(uc&&channels[uc])||(v.vid&&videos[v.vid])||'';
  if(!src&&c&&c.av)src='https://yt3.googleusercontent.com/'+c.av;
  const fallbackKey=channelKey||uc;
  if(!src&&fallbackKey)src='https://unavatar.io/youtube/'+encodeURIComponent(fallbackKey)+'?fallback=false';
  if(src){
    src=String(src);
    if(!/^https?:\/\//i.test(src))src=src.replace(/=(?:w|s)\d+.*$/,'')+'=s'+(size*2)+'-c-k-c0x00ffffff-no-rj';
  }
  return '<span class="ch-ava yt-ava" style="width:'+size+'px;height:'+size+'px" title="'+esc(v.channel||'YouTube channel')+'">'+
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9A28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8ZM10 15.2V8.8l5.5 3.2-5.5 3.2Z"/></svg>'+
    (src?'<img loading="lazy" src="'+esc(src)+'" onerror="avaFallback(this,\''+fallbackKey.replace(/'/g,"\\'")+'\')" alt="">':'')+'</span>';
}
function chAva(c,size){
  const col=gcolor(c.niche);
  const hd=handleOf(c.url);
  const atlas=window.YT_CHANNEL_AVATARS||{},channels=atlas.channels||{},aliases=atlas.aliases||{};
  const channelKey=aliases[hd]||hd;
  const src=c.av?('https://yt3.googleusercontent.com/'+c.av+'=s'+(size*2)+'-c-k-c0x00ffffff-no-rj'):(channels[channelKey]||(channelKey?'https://unavatar.io/youtube/'+encodeURIComponent(channelKey)+'?fallback=false':null));
  return '<span class="ch-ava" style="width:'+size+'px;height:'+size+'px;background:'+col+'22;color:'+col+'">'+esc((c.name||'?').charAt(0).toUpperCase())+(src?'<img loading="lazy" src="'+src+'" onerror="avaFallback(this,\''+channelKey.replace(/'/g,"\\'")+'\')">':'')+'</span>';
}
const FLAGS={'Japon':'jp','Norvège':'no','États-Unis':'us','Australie':'au','Italie':'it','Portugal':'pt','Ukraine':'ua','Royaume-Uni':'gb','Danemark':'dk','France':'fr','Corée du Sud':'kr','Suisse':'ch','Lituanie':'lt','Pays-Bas':'nl','Espagne':'es','Slovaquie':'sk','Canada':'ca','Kazakhstan':'kz','Irlande':'ie','Allemagne':'de','Estonie':'ee','Slovénie':'si','Inde':'in','Afrique du Sud':'za','Bulgarie':'bg','Islande':'is','Belgique':'be','Autriche':'at','Suède':'se','Finlande':'fi','Pologne':'pl','Grèce':'gr','Brésil':'br','Mexique':'mx','Indonésie':'id','Vietnam':'vn','Thaïlande':'th','Philippines':'ph','Turquie':'tr','Russie':'ru','Roumanie':'ro','Tchéquie':'cz','République tchèque':'cz','Hongrie':'hu','Nouvelle-Zélande':'nz','Argentine':'ar','Colombie':'co','Chili':'cl','Israël':'il','Taïwan':'tw','Chine':'cn','Hong Kong':'hk','Singapour':'sg','Malaisie':'my','Maroc':'ma','Égypte':'eg','Nigéria':'ng','Pakistan':'pk','Bangladesh':'bd','Sri Lanka':'lk','Népal':'np','Lettonie':'lv','Croatie':'hr','Serbie':'rs','Biélorussie':'by','Géorgie':'ge','Arménie':'am','Azerbaïdjan':'az','Luxembourg':'lu','Norway':'no'};
function flagOf(c){const k=FLAGS[c];return k?'<img class="flg" loading="lazy" src="https://flagcdn.com/20x15/'+k+'.png" alt="">':'';}
function chanSeries(url,idx){
  if(!CHAN||!CHAN.hist)return null;
  const a=CHAN.hist[normUrl(url)];if(!a)return null;
  return a.filter(p=>p[idx]!=null).map(p=>[p[0],p[idx]]);
}
function filterChans(){
  let rows=CHAN.channels;
  if(CS.niche)rows=rows.filter(c=>(c.niche||'(unset)')===CS.niche);
  if(CS.q){const q=CS.q.toLowerCase();rows=rows.filter(c=>(c.name+' '+c.niche+' '+c.country).toLowerCase().includes(q));}
  const sf=CS.sort;
  return [...rows].sort((a,b)=>sf==='name'?String(a.name).localeCompare(String(b.name)):(((b[sf]!=null?b[sf]:0))-((a[sf]!=null?a[sf]:0))));
}
function chanHTML(){
  if(!CHAN){
    return CHAN_ERR
      ? '<div class="err-box"><h3>Channel audit unavailable</h3><p>'+esc(CHAN_ERR)+'<br><br>The channel audit lives in a separate Google Sheet and needs live access — open this page from the hosted link.</p><button class="load-more" onclick="loadChan()">Retry</button></div>'
      : '<div class="empty">Loading the channel audit Sheet… <span class="spin-inline"></span></div>';
  }
  const all=CHAN.channels,rows=filterChans();
  const niches=[...new Set(all.map(c=>c.niche||'(unset)'))].sort((a,b)=>all.filter(c=>(c.niche||'(unset)')===b).length-all.filter(c=>(c.niche||'(unset)')===a).length);
  const nicheOpts=[{label:'🎯 All niches',sel:!CS.niche,onclick:"CS.niche='';CS.limit=150;rerenderChans()"}].concat(
    niches.map(n=>({label:genreEmoji(n)+' '+esc(n)+' · '+all.filter(x=>(x.niche||'(unset)')===n).length,sel:CS.niche===n,onclick:'CS.niche='+jsq(n)+';CS.limit=150;rerenderChans()'})));
  const nicheLabel=CS.niche?(genreEmoji(CS.niche)+' '+esc(CS.niche)):'🎯 All niches';
  const csSortKeys=[['subs','👥','Subscribers'],['viewsYr','👀','Views / year'],['avg10','📊','Avg last 10'],['upMo','⬆️','Uploads / month'],['lastUp','🆕','Last upload'],['name','🔤','Name']];
  const csSortOpts=csSortKeys.map(s=>({label:s[1]+' Sort · '+s[2],sel:CS.sort===s[0],onclick:'CS.sort='+jsq(s[0])+';rerenderChans()'}));
  const csSortRow=csSortKeys.find(s=>s[0]===CS.sort)||csSortKeys[0];
  let h='<div class="toolbar">'+
    '<div class="search">'+ICONS.search+'<input placeholder="Search channels, niches, countries…" value="'+esc(CS.q)+'" oninput="CS.q=this.value;CS.limit=150;rerenderChans()"><kbd>/</kbd></div>'+
    xdd('c-genre',nicheLabel,nicheOpts)+
    '<div class="tb-right">'+xdd('c-sort',csSortRow[1]+' Sort · '+csSortRow[2],csSortOpts)+
    '<div class="viewtoggle">'+
      '<button class="'+(CS.mode==='grid'?'on':'')+'" onclick="CS.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(CS.mode!=='grid'?'on':'')+'" onclick="CS.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div></div>'+
  '</div>';
  h+='<div id="chan-list">'+chanListHTML(rows)+'</div>';
  return h;
}
function chanCardHTML(c,i){
  return '<div class="vcard" onclick="openChanIdx('+i+')">'+
    '<div class="thumbwrap" style="height:auto;aspect-ratio:auto;padding:24px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;background:linear-gradient(160deg,rgba(255,0,51,.12),rgba(255,0,51,.02))">'+
      chAva(c,68)+
      '<div style="text-align:center;max-width:100%"><div class="ttitle" style="white-space:normal">'+esc(c.name)+'</div></div>'+
    '</div>'+
    '<div class="vbody">'+
      '<div class="vtags">'+gtag(c.niche)+(c.country?'<span class="tag ghost">'+flagOf(c.country)+' '+esc(c.country)+'</span>':'')+'</div>'+
      '<div class="vstats">'+
        '<div class="vstat hl"><b>'+fmtN(c.subs)+'</b><span>subs</span></div>'+
        '<div class="vstat"><b style="color:'+sbmColor(chanSubsMo(c))+'">'+fmtSubsMo(chanSubsMo(c))+'</b><span>subs/mo</span></div>'+
        '<div class="vstat"><b>'+fmtN(c.viewsYr)+'</b><span>views/yr</span></div>'+
      '</div></div></div>';
}
function chanListHTML(rows){
  if(!rows.length)return '<div class="empty">Nothing matches — try clearing filters.</div>';
  const page=rows.slice(0,CS.limit);
  window._page_chan=page;
  let h;
  if(CS.mode==='grid'){
    h='<div class="vgrid">'+page.map((c,i)=>chanCardHTML(c,i)).join('')+'</div>';
  }else{
    h='<table class="vtable"><thead><tr><th>Channel</th><th>Niche</th><th>Country</th><th>Subs</th><th>Subs per month</th><th>Total views</th><th>Views per year</th><th>Avg last 10</th><th>Uploads per month</th><th>Last upload</th></tr></thead><tbody>'+
      page.map((c,i)=>'<tr class="row" onclick="openChanIdx('+i+')">'+
        '<td><div style="display:flex;align-items:center;gap:12px">'+chAva(c,64)+'<span class="ttitle">'+esc(c.name)+'</span></div></td>'+
        '<td>'+gtag(c.niche)+'</td>'+
        '<td style="white-space:nowrap">'+flagOf(c.country)+' '+esc(c.country||'—')+'</td>'+
        '<td class="num vpmcell">'+fmtN(c.subs)+'</td>'+
        '<td class="num" style="color:'+sbmColor(chanSubsMo(c))+';font-weight:700">'+fmtSubsMo(chanSubsMo(c))+'</td>'+
        '<td class="num">'+fmtN(c.views)+'</td>'+
        '<td class="num">'+fmtN(c.viewsYr)+'</td><td class="num">'+fmtN(c.avg10)+'</td>'+
        '<td class="num">'+(c.upMo!=null?c.upMo:'—')+'</td><td class="num">'+fmtDateFull(c.lastUp)+'</td></tr>').join('')+'</tbody></table>';
  }
  if(rows.length>CS.limit)h+='<button class="load-more" onclick="CS.limit+=150;rerenderChans()">Loading more · '+fmtInt(rows.length-CS.limit)+' remaining</button>';
  return h;
}
function rerenderChans(){
  const rows=filterChans();
  const el=document.getElementById('chan-list');
  if(el)el.innerHTML=chanListHTML(rows);
  i18nZone(el);armAutoLoad();
}
function openChanIdx(i){const c=(window._page_chan||[])[i];if(c)openChanDrawer(c);}
function openDashLive(i){const v=(window._dash_lives||[])[i];if(v)openLiveDrawer(v);}
function openDashChan(i){const c=(window._dash_chans||[])[i];if(c)openChanDrawer(c);}
function openChanDrawer(c){
  const subsPts=chanSeries(c.url,1),viewsPts=chanSeries(c.url,2);
  document.getElementById('drawer').innerHTML=
    '<button class="dw-close" onclick="closeDrawer()">✕</button>'+
    '<div class="dw-body" style="padding-top:26px">'+
      '<div class="dw-title" style="display:flex;align-items:center;gap:12px">'+chAva(c,72)+'<a href="'+esc(c.url)+'" target="_blank">'+esc(c.name)+' ↗</a></div>'+
      '<div class="dw-sub">'+gtag(c.niche)+ghosttag(c.country)+ghosttag(c.status)+(c.ageY!=null?'<span class="tag ghost">'+c.ageY+' yrs old</span>':'')+'</div>'+
      '<div class="dw-stats">'+
        '<div class="dw-stat hl"><b>'+fmtN(c.subs)+'</b><span>subscribers</span></div>'+
        '<div class="dw-stat"><b style="color:'+sbmColor(chanSubsMo(c))+'">'+fmtSubsMo(chanSubsMo(c))+'</b><span>subs / month</span></div>'+
        '<div class="dw-stat"><b>'+fmtN(c.views)+'</b><span>total views</span></div>'+
        '<div class="dw-stat"><b>'+fmtN(c.viewsYr)+'</b><span>views / year</span></div>'+
      '</div>'+
      '<div class="dw-sec"><div class="k">📚 Catalog</div><div class="v">'+fmtInt(c.nvid)+' videos · '+fmtN(c.avgVid)+' avg views / video · '+(c.upMo!=null?c.upMo+' uploads / month':'cadence unknown')+' · last upload '+fmtDateFull(c.lastUp)+'</div></div>'+
      '<div class="dw-sec"><div class="k">📈 Subscribers</div>'+histChart(subsPts,'subs')+'</div>'+
      '<div class="dw-sec"><div class="k">📈 Total views</div>'+histChart(viewsPts,'views')+'</div>'+
    '</div>';
  document.getElementById('drawer').classList.add('show');
  document.getElementById('backdrop').classList.add('show');
  document.getElementById('drawer').scrollTop=0;
  fillLikes();i18nDrawer();
}


/* ================= WATCHLIST + AI POTENTIAL ================= */
const WLS={tab:'v',mode:'grid'};
function wlGet(){try{return Object.assign({v:[],l:[],c:[]},JSON.parse(localStorage.getItem('radar_wl')||'{}'));}catch(e){return {v:[],l:[],c:[]};}}
function wlSet(w){try{localStorage.setItem('radar_wl',JSON.stringify(w));}catch(e){}}
function wlHas(t,k){return wlGet()[t].includes(k);}
function toggleWatch(t,k,ev){
  if(ev)ev.stopPropagation();
  const w=wlGet();const i=w[t].indexOf(k);
  if(i>=0)w[t].splice(i,1);else w[t].push(k);
  wlSet(w);renderNav();
  if(ev&&ev.target){ev.target.textContent=w[t].includes(k)?'⭐':'☆';ev.target.title=w[t].includes(k)?'Remove from watchlist':'Add to watchlist';}
  if(route==='watch')render();
}
function wlStar(t,k){
  const on=wlHas(t,k);
  return '<button class="wl-star'+(on?' on':'')+'" title="'+(on?'Remove from watchlist':'Add to watchlist')+'" onclick="toggleWatch(\''+t+'\',\''+String(k).replace(/'/g,"\\'")+'\',event)">'+(on?'⭐':'☆')+'</button>';
}
function aiRisk(c){
  if(!c)return 0;
  let s=0;
  const age=c.ageY,up=c.upMo,nv=c.nvid;
  // Cadence industrielle : le signal le plus fort, quel que soit l'âge
  if(up!=null){ if(up>=30)s+=4; else if(up>=20)s+=3; else if(up>=12)s+=2; else if(up>=8)s+=1; }
  // Jeune chaîne
  if(age!=null){ if(age<1)s+=2; else if(age<2.5)s+=1; }
  // Volume total incompatible avec une prod humaine
  if(nv!=null&&age>0.2){ const r=nv/age; if(r>500)s+=3; else if(r>300)s+=2; else if(r>180)s+=1; }
  // Croissance explosive sur chaîne jeune
  if(age!=null&&age<2&&c.viewsYr>20000000)s+=1;
  if(age!=null&&age<1.5&&c.subsMo>25000)s+=1;
  // Ferme à contenu : publie beaucoup mais chaque vidéo fait très peu vs la base d'abonnés
  if(up!=null&&up>=10&&c.avg10!=null&&c.subs>50000&&c.avg10<c.subs*0.008)s+=1;
  // Nom de chaîne qui vend la mèche
  if(/\bA\.?I\.?\b|suno|udio|generated/i.test(c.name||''))s+=3;
  // Chaîne établie de longue date avec cadence humaine : bénéfice du doute
  if(age!=null&&age>=8&&(up==null||up<10)&&(nv==null||age<=0.2||nv/age<200))s-=2;
  return s;
}
function aiBadge(c){
  const s=aiRisk(c);
  if(s>=5)return '<span class="tag" style="background:#f8717122;color:#f87171;border:1px solid #f8717155" title="Industrial output cadence / volume — AI music-visual pipeline almost certain">🤖 AI likely</span>';
  if(s>=3)return '<span class="tag" style="background:#fbbf2422;color:#fbbf24;border:1px solid #fbbf2455" title="Output pace, volume and growth suggest AI-assisted music/visuals">🤖 AI possible</span>';
  return '';
}
function chanByUrl(u){
  if(!CHAN||!u)return null;
  const k=normUrl(u);return CHAN.channels.find(c=>normUrl(c.url)===k)||null;
}
let CHAN_NAMEIX=null,CHAN_NAMEIX_T=null;
function chanByName(n){
  if(!CHAN||!n)return null;
  if(!CHAN_NAMEIX||CHAN_NAMEIX_T!==CHAN_T){
    CHAN_NAMEIX={};CHAN_NAMEIX_T=CHAN_T;
    CHAN.channels.forEach(c=>{CHAN_NAMEIX[String(c.name||'').toLowerCase().replace(/\s+/g,' ').trim()]=c;});
  }
  return CHAN_NAMEIX[String(n).toLowerCase().replace(/\s+/g,' ').trim()]||null;
}
function chanFor(v){return chanByUrl(v.chUrl||'')||chanByName(v.channel)||null;}
let SUBS2_NORM=null;
function subs2For(name){
  if(!window.SUBS2||!name)return null;
  if(!SUBS2_NORM){
    SUBS2_NORM={};
    Object.keys(window.SUBS2).forEach(k=>{SUBS2_NORM[k.toLowerCase().replace(/\s+/g,' ').trim()]=window.SUBS2[k];});
  }
  const v=SUBS2_NORM[String(name).toLowerCase().replace(/\s+/g,' ').trim()];
  return v==null?null:v;
}
function subsFor(v){
  const c=chanFor(v);
  if(c&&c.subs!=null)return c.subs;
  if(v.subs!=null)return v.subs;
  return subs2For(v.channel);
}
function wlVideoTableHTML(rows){
  return '<table class="vtable"><thead><tr><th></th><th>Title</th><th>Views/mo</th><th>Views</th><th>Duration</th><th>Published</th><th>Genre</th><th>Channel</th><th>Subs</th></tr></thead><tbody>'+
    rows.map((v,i)=>'<tr class="row" onclick="openIdx(\'mix\','+i+')">'+
      '<td><img class="tthumb" loading="lazy" src="'+thumb(v.vid)+'" onerror="this.style.visibility=\'hidden\'"></td>'+
      '<td class="ttitle">'+esc(v.title)+'</td>'+
      '<td class="num vpmcell">'+fmtN(v.vpm)+'</td><td class="num">'+fmtN(v.views)+'</td>'+
      '<td class="num">'+fmtDur(v.durH)+'</td><td class="num">'+fmtDate(v.pub)+'</td>'+
      '<td>'+gtag(v.genre)+'</td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(v.channel)+'</td>'+
      '<td class="num">'+fmtN(subsFor(v))+'</td></tr>').join('')+'</tbody></table>';
}
function wlLiveTableHTML(rows){
  return '<table class="vtable"><thead><tr><th></th><th>Stream</th><th>Channel</th><th>👀 Now</th><th>Peak</th><th>Started</th><th>Discovery keywords</th></tr></thead><tbody>'+
    rows.map((v,i)=>{
      const now=liveNow(v.vid),peak=livePeak(v.vid);
      return '<tr class="row" onclick="openLiveIdx('+i+')">'+
      '<td><img class="tthumb" loading="lazy" src="'+thumb(v.vid)+'" onerror="if(!this._f){this._f=1;this.src=\'https://i.ytimg.com/vi/'+v.vid+'/hqdefault.jpg\'}else this.style.visibility=\'hidden\'"></td>'+
      '<td class="ttitle">'+esc(v.title)+'</td>'+
      '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(v.channel)+'</td>'+
      '<td class="num vpmcell">'+fmtN(now)+'</td><td class="num">'+fmtN(peak)+'</td>'+
      '<td class="num">'+fmtDate(v.started)+'</td>'+
      '<td style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11.5px">'+esc(v.disc)+'</td></tr>';
    }).join('')+'</tbody></table>';
}
function watchHTML(){
  const w=wlGet();
  const tabs=[['v','🎬 Videos',w.v.length],['l','📺 Livestreams',w.l.length],['c','📡 Channels',w.c.length]];
  let hh='<div class="toolbar"><div class="seg">'+tabs.map(t=>'<button class="'+(WLS.tab===t[0]?'on':'')+'" onclick="WLS.tab=\''+t[0]+'\';render()">'+t[1]+'<span class="cnt">'+t[2]+'</span></button>').join('')+'</div>'+
    '<div class="tb-right"><div class="viewtoggle">'+
      '<button class="'+(WLS.mode!=='table'?'on':'')+'" onclick="WLS.mode=\'grid\';render()" title="Grid">'+ICONS.grid+'</button>'+
      '<button class="'+(WLS.mode==='table'?'on':'')+'" onclick="WLS.mode=\'table\';render()" title="List">'+ICONS.rows+'</button></div></div>'+
  '</div>';
  if(WLS.tab==='v'){
    const rows=mixRows().filter(x=>x.vid&&w.v.includes(x.vid));
    window._page_mix=rows;
    hh+=!rows.length?'<div class="empty">No pinned videos yet — hit the ☆ on any video card to track it here.</div>':
      (WLS.mode==='table'?wlVideoTableHTML(rows):'<div class="vgrid">'+rows.map((v,i)=>vcardHTML('mix',v,i)).join('')+'</div>');
  }else if(WLS.tab==='l'){
    const rows=(DATA.lives||[]).filter(x=>w.l.includes(x.vid));
    window._page_live=rows;
    hh+=!rows.length?'<div class="empty">No pinned livestreams yet — hit the ☆ on any stream card.</div>':
      (WLS.mode==='table'?wlLiveTableHTML(rows):'<div class="vgrid">'+rows.map((v,i)=>liveCardHTML(v,i)).join('')+'</div>');
  }else{
    const rows=CHAN?CHAN.channels.filter(c=>w.c.includes(normUrl(c.url))):[];
    if(!rows.length)hh+='<div class="empty">No pinned channels yet — hit the ☆ on any channel row.</div>';
    else{
      const prevMode=CS.mode;CS.mode=WLS.mode;
      hh+=chanListHTML(rows);
      CS.mode=prevMode;
    }
  }
  return hh;
}

/* ================= I18N (FR) ================= */
let LANG=localStorage.getItem('radar_lang')||'en';
function mountLangBtn(){
  let b=document.getElementById('lang-btn');
  if(!b){b=document.createElement('div');b.id='lang-btn';b.onclick=toggleLang;document.body.appendChild(b);}
  b.className=LANG==='fr'?'fr':'';
  b.innerHTML='<span class="lg-slide"></span>'+
    '<span class="lg-opt'+(LANG==='en'?' on':'')+'"><img src="https://flagcdn.com/40x30/gb.png" alt="EN"></span>'+
    '<span class="lg-opt'+(LANG==='fr'?' on':'')+'"><img src="https://flagcdn.com/40x30/fr.png" alt="FR"></span>';
  // éléments statiques jamais reconstruits par render() : synchro idempotente sur LANG (pas de replace destructif)
  const mode=LANG==='fr'?'Veille':'Scan';
  const tag=document.querySelector('.logo h1 small');
  if(tag)tag.textContent='YouTube · '+mode;
  document.title='Lofi Radar — YouTube · '+mode;
}
function toggleLang(){
  LANG=LANG==='en'?'fr':'en';
  try{localStorage.setItem('radar_lang',LANG);}catch(e){}
  mountLangBtn();renderNav();render();
}
const FR_LIT=[
['Competitive intelligence across ','Veille concurrentielle sur '],
[' instrumental videos · updated daily by the scan',' vidéos instrumentales · mise à jour quotidienne par le scan'],
['Full competitive audit, trends & fresh discoveries merged · filter by release date to see what’s new','Audit concurrentiel complet, tendances et découvertes fusionnés · filtre par date de sortie pour voir le contenu récent'],
['How each of our long-form releases performed vs the market · full channel history · Shorts excluded','Performance de toutes nos sorties long format vs le marché · historique complet de la chaîne · Shorts exclus'],
['24/7 streams surfacing on the scan keywords · concurrent viewers tracked hourly','Streams 24/7 détectés sur les mots-clés du scan · spectateurs simultanés suivis toutes les heures'],
['Competitive channel audit · subscribers & total views tracked by the weekly scan','Audit des chaînes concurrentes · abonnés et vues totales suivis par le scan hebdomadaire'],
[' original concepts ranked by potential · descriptions & SEO keywords ready to copy',' concepts originaux classés par potentiel · descriptions et mots-clés SEO prêts à copier'],
['Release plan balanced by genre, character and season · synced with Monday','Plan de sorties équilibré par genre, personnage et saison · synchronisé avec Monday'],
['The search corpus scanned on every sync · what feeds All Videos, Trends & News','Le corpus de recherche scanné à chaque synchro · ce qui alimente les vidéos, tendances et découvertes'],
['>Videos audited<','>Vidéos auditées<'],['Your pinned videos, livestreams and channels · stored in this browser','Tes vidéos, livestreams et chaînes épinglés · stockés dans ce navigateur'],['No pinned videos yet — hit the ☆ on any video card to track it here.','Aucune vidéo épinglée, clique sur ☆ sur une carte vidéo pour la suivre ici.'],['No pinned livestreams yet — hit the ☆ on any stream card.','Aucun livestream épinglé, clique sur ☆ sur une carte de stream.'],['No pinned channels yet — hit the ☆ on any channel row.','Aucune chaîne épinglée, clique sur ☆ sur une ligne de chaîne.'],['🤖 AI likely','🤖 IA probable'],['🤖 AI possible','🤖 IA possible'],['>Trending now<','>En tendance<'],['>Unique channels<','>Chaînes uniques<'],['>Livestreams<','>Livestreams<'],['>Channels audited<','>Chaînes auditées<'],
['≥1M views · all time','≥1M vues · tout l’historique'],['<12 months · ≥500k views','<12 mois · ≥500k vues'],['competitive landscape','paysage concurrentiel'],[' watching right now',' spectateurs en ce moment'],[' combined subscribers',' abonnés cumulés'],['live scan pending','scan lives en attente'],['loading audit Sheet…','chargement du Sheet d’audit…'],
['>Genre distribution<','>Répartition par genre<'],['Number of audited videos per genre · full history, ≥1M views','Nombre de vidéos auditées par genre · historique complet, ≥1M vues'],
['>Velocity by genre<','>Vélocité par genre<'],['Median views/month per genre · videos from the last 12 months','Vues/mois médianes par genre · vidéos des 12 derniers mois'],
['🔥 Hot right now','🔥 Ça monte'],['Fastest-growing videos published in the last 12 months','Vidéos à la plus forte croissance publiées ces 12 derniers mois'],
['📰 Latest discoveries','📰 Dernières découvertes'],['New videos the YouTube algorithm just started pushing · daily scan','Nouvelles vidéos que l’algorithme YouTube commence à pousser · scan quotidien'],
['🗓️ Coming up','🗓️ À venir'],['Next planned releases · synced with Monday & rotation proposals','Prochaines sorties prévues · synchro Monday et propositions de rotation'],
['📡 Top livestreams','📡 Top livestreams'],['Most-watched 24/7 streams on the scan keywords · viewers at last scan','Streams 24/7 les plus regardés sur les mots-clés du scan · spectateurs au dernier scan'],
['📺 Top channels','📺 Top chaînes'],['Biggest channels in the competitive audit','Plus grosses chaînes de l’audit concurrentiel'],
['View all →','Tout voir →'],['Full roadmap →','Roadmap complète →'],
['🆕 <1 month','🆕 <1 mois'],['Last 3 months','3 derniers mois'],['Last 6 months','6 derniers mois'],['Last 12 months','12 derniers mois'],['All time','Tout l’historique'],
['Search titles, channels, keywords…','Chercher titres, chaînes, mots-clés…'],['Search streams, channels, keywords…','Chercher streams, chaînes, mots-clés…'],['Search channels, niches, countries…','Chercher chaînes, niches, pays…'],['Search concepts, titles, niches…','Chercher concepts, titres, niches…'],
['All potential','Tout potentiel'],['All characters','Tous les personnages'],['All sources','Toutes les sources'],['All genres','Tous les genres'],
['>Sort · Velocity (views/mo)<','>Tri · Vélocité (vues/mois)<'],['>Sort · Total views<','>Tri · Vues totales<'],['>Sort · Newest first<','>Tri · Plus récentes<'],['>Sort · Oldest first<','>Tri · Plus anciennes<'],['>Sort · Duration<','>Tri · Durée<'],['>Sort · Channel size<','>Tri · Taille de chaîne<'],['>Sort · Recently added<','>Tri · Ajout récent<'],['>Sort · Viewers now<','>Tri · Spectateurs actuels<'],['>Sort · Peak viewers<','>Tri · Pic de spectateurs<'],['>Sort · Recently started<','>Tri · Lancement récent<'],['>Sort · Channel<','>Tri · Chaîne<'],['>Sort · Subscribers<','>Tri · Abonnés<'],['>Sort · Views / year<','>Tri · Vues / an<'],['>Sort · Avg last 10<','>Tri · Moy. 10 dernières<'],['>Sort · Uploads / month<','>Tri · Uploads / mois<'],['>Sort · Last upload<','>Tri · Dernier upload<'],['>Sort · Name<','>Tri · Nom<'],['>Sort · Adjusted score<','>Tri · Score ajusté<'],['>Sort · Score<','>Tri · Score<'],['>Sort · Confidence<','>Tri · Confiance<'],['>Sort · N°<','>Tri · N°<'],['>Sort · Worst percentile first<','>Tri · Pire percentile d’abord<'],['>Sort · Best percentile first<','>Tri · Meilleur percentile d’abord<'],['>Sort · Most views<','>Tri · Plus de vues<'],
['</b> videos<','</b> vidéos<'],['</b> streams<','</b> streams<'],['</b> channels<','</b> chaînes<'],['</b> concepts<','</b> concepts<'],
[' remaining<',' restantes<'],['Loading more · ','Chargement · '],
['>Stream<','>Stream<'],['>👀 Now<','>👀 Actuel<'],['>Peak<','>Pic<'],['>Started<','>Lancé<'],['>Discovery keywords<','>Mots-clés de découverte<'],
['>Channel</th>','>Chaîne</th>'],['>Niche<','>Niche<'],['>Country<','>Pays<'],['>Subs</th>','>Abonnés</th>'],['>Subs per month<','>Abonnés par mois<'],['>Total views<','>Vues totales<'],['>Views per year<','>Vues par an<'],['>Avg last 10<','>Moy. 10 dern.<'],['>Uploads per month<','>Uploads par mois<'],['>Last upload<','>Dernier upload<'],['>Title<','>Titre<'],['>Views/mo<','>Vues/mois<'],['>Views<','>Vues<'],['>Duration<','>Durée<'],['>Published<','>Publiée<'],['>Genre<','>Genre<'],
['>views/mo</span>','>vues/mois</span>'],['>views</span>','>vues</span>'],['>age</span>','>âge</span>'],['>published</span>','>publiée</span>'],['>duration</span>','>durée</span>'],['>watching now</span>','>spectateurs</span>'],['>peak measured</span>','>pic mesuré</span>'],['>peak</span>','>pic</span>'],['>started</span>','>lancé</span>'],['>scans</span>','>scans</span>'],['>subscribers</span>','>abonnés</span>'],['>total views</span>','>vues totales</span>'],['>views / year</span>','>vues / an</span>'],['>avg last 10</span>','>moy. 10 dern.</span>'],['>percentile vs market</span>','>percentile vs marché</span>'],['>percentile · channel</span>','>percentile · chaîne</span>'],['th · channel<','e · chaîne<'],['>avg view duration (median ','>durée moy. de vue (médiane '],['>views/mo lifetime</span>','>vues/mois (vie)</span>'],['>views/mo now</span>','>vues/mois (actuel)</span>'],['>impressions</span>','>impressions</span>'],['>avg view duration</span>','>durée moy. de vue</span>'],['>reco score</span>','>score reco</span>'],['>potential</span>','>potentiel</span>'],['>release date</span>','>date de sortie</span>'],
['age cohort · ','cohorte d’âge · '],['Same-age channel median (','Médiane chaîne à âge équivalent ('],['⚖️ Age-matched comparison','⚖️ Comparaison à âge équivalent'],['Published ','Publiée '],[' days old',' jours'],['market cohort: ','cohorte marché : '],['channel cohort: ','cohorte chaîne : '],[' videos)',' vidéos)'],['Raw totals stay visible; performance colors and percentiles only compare releases at a similar age.','Les totaux bruts restent visibles ; couleurs et percentiles ne comparent que des sorties d’âge proche.'],
[' watching</span>',' spectateurs</span>'],[' watching<',' spectateurs<'],
['>Overperforming<','>Surperforme<'],['>In line<','>Dans la norme<'],['>Underperforming<','>Sous-performe<'],['>Too early<','>Trop tôt<'],
['beating 70% of their genre cohort','au-dessus de 70 % de leur cohorte de genre'],['below 40% of their genre cohort','sous les 40 % de leur cohorte de genre'],['long-form releases · full channel history','sorties long format · historique complet de la chaîne'],['vs competing videos of the same genre','vs les vidéos concurrentes du même genre'],['median views/mo across our releases','vues/mois médianes de nos sorties'],['impressions click-through · YouTube Studio, 365 days','taux de clic des impressions · YouTube Studio, 365 jours'],
['>Videos analysed<','>Vidéos analysées<'],['>Median percentile<','>Percentile médian<'],['>Channel velocity<','>Vélocité chaîne<'],['>Median CTR<','>CTR médian<'],['>Streams tracked<','>Streams suivis<'],['>Channels tracked<','>Chaînes suivies<'],['>Combined subscribers<','>Abonnés cumulés<'],['>Median views / year<','>Vues / an médianes<'],['>Active channels<','>Chaînes actives<'],
['Market benchmark (radar) × YouTube Studio private data (impressions, CTR, retention · 365 days, refreshed on demand)','Benchmark marché (radar) × données privées YouTube Studio (impressions, CTR, rétention · 365 jours, rafraîchies à la demande)'],
['📋 All releases','📋 Toutes les sorties'],[' releases<',' sorties<'],[' release<',' sortie<'],['>Today<','>Aujourd’hui<'],
['📈 View history','📈 Historique des vues'],['📡 Concurrent viewers','📡 Spectateurs simultanés'],['🔬 Diagnosis','🔬 Diagnostic'],['💡 Linked recommendation','💡 Recommandation liée'],['⚖️ Cohort','⚖️ Cohorte'],['📚 Catalog','📚 Catalogue'],['📈 Subscribers','📈 Abonnés'],['📈 Total views','📈 Vues totales'],['🔥 Why trending / notable','🔥 Pourquoi ça tourne'],['🔥 Why trending','🔥 Pourquoi en tendance'],['📌 Why notable','📌 Pourquoi notable'],['💡 Lofi Girl suggestion','💡 Suggestion Lofi Girl'],['💡 Lofi Girl angle','💡 Angle Lofi Girl'],['🎯 What to copy','🎯 À copier'],['🎼 Musical direction','🎼 Direction musicale'],['🎨 Visual direction','🎨 Direction visuelle'],['🔎 Discovery keywords','🔎 Mots-clés de découverte'],['🏁 Best search rank','🏁 Meilleur rang de recherche'],['🗓️ First seen by the scan','🗓️ Première détection'],['🔎 Found via search keywords','🔎 Trouvée via ces recherches'],['✏️ Title pattern','✏️ Structure du titre'],['🎬 Concept','🎬 Concept'],['🖼️ Thumbnail scene','🖼️ Scène de miniature'],['🎼 Music style','🎼 Style musical'],['🔁 Cadence','🔁 Cadence'],['🍂 Seasonal note','🍂 Note saisonnière'],
['✓ Validated · click to undo','✓ Validée · cliquer pour annuler'],['✓ Validate','✓ Valider'],['💾 Save to Sheet','💾 Enregistrer dans le Sheet'],['Your note — ChatGPT reads it at the next scan to recalibrate…','Ta note — ChatGPT la lit au prochain scan pour recalibrer…'],
['>✅ Validated</div>','>✅ Validées</div>'],['>📝 With Dim note</option>','>📝 Avec note Dim</option>'],['>✅ Validated or noted</option>','>✅ Validées ou notées</option>'],['>⏳ Pending review</div>','>⏳ À trier</div>'],['>🎯 All niches</div>','>🎯 Toutes les niches</div>'],
['Nothing matches — try clearing filters.','Aucun résultat, essaie de retirer des filtres.'],['Nothing matches — try clearing the search.','Aucun résultat, essaie de vider la recherche.'],
['Tracking just started — the curve appears from the 2nd scan. 📡','Suivi tout juste lancé, la courbe apparaît dès le 2e scan. 📡'],[' scans · ',' scans · '],['/day measured','/jour mesuré'],['concurrent viewers · ','spectateurs simultanés · '],['>latest<','>dernier<'],
['found on the scan keywords','trouvés sur les mots-clés du scan'],['of our streams surfacing in results','de nos streams dans les résultats'],
['Compared against ','Comparée à '],[' videos on the radar',' vidéos du radar'],[' · median ',' · médiane '],
['uploads / month','uploads / mois'],[' avg views / video',' vues moy. / vidéo'],[' videos · ',' vidéos · '],['cadence unknown','cadence inconnue'],['last upload ','dernier upload '],[' yrs old',' ans'],
['Workspace','Espace de travail'],['Sync now','Synchroniser'],['Open Google Sheet','Ouvrir le Google Sheet'],
['🎬 videos ','🎬 vidéos '],['📡 streams ','📡 streams '],['synced just now','synchro à l’instant'],['Live · synced just now','Live · synchro à l’instant'],['Live · synced ','Live · synchro il y a '],[' min ago',' min'],['h ago','h'],['d ago','j'],['just now','à l’instant'],
['Daily snapshot · ','Snapshot quotidien · '],['trying live sync…','tentative de synchro live…'],
['DAILY SCAN','SCAN QUOTIDIEN'],['OUR VIDEOS','NOS VIDÉOS'],['>LIVE<','>LIVE<'],['HOURLY SCAN','SCAN HORAIRE'],['WEEKLY SCAN','SCAN HEBDOMADAIRE'],
['Connecting…','Connexion…'],['Syncing…','Synchro…'],['Sync failed','Échec de synchro'],['No data','Aucune donnée'],
['Cached · ','Cache · '],['(live sync unavailable from a local file)','(synchro live indisponible depuis un fichier local)'],
['Downloading live data from Google Sheets…','Téléchargement des données en direct depuis Google Sheets…'],
['No data available','Aucune donnée disponible'],
['Keep <b>Lofi_Radar_data.js</b> next to this file (daily snapshot), or open the page from a web server for live sync.','Garde <b>Lofi_Radar_data.js</b> à côté de ce fichier (snapshot quotidien), ou ouvre la page depuis un serveur web pour la synchro live.'],
['>Retry<','>Réessayer<'],
['Schedule unavailable','Planning indisponible'],['Please reopen this recommendation to generate its release date.','Rouvre cette recommandation pour générer sa date de sortie.'],['>Close<','>Fermer<'],
['» validated','» validé'],['Placement proposal for the schedule — let me know if it works for you.','Proposition de placement dans le planning — dis-moi si ça te va.'],
['General cadence (~1 release/week, free week)','Cadence générale (~1 sortie/semaine, semaine libre)'],['relaxed constraint (few open slots)','contrainte assouplie (peu de créneaux libres)'],
['Spaced out from the last rain/storm concept (≥3 weeks)','Espacé du dernier concept pluie/orage (≥3 semaines)'],
['Suggested release date — click a day to see nearby planned releases.','Date de sortie proposée — clique sur un jour pour voir les sorties proches.'],['✓ Confirm date','✓ Confirmer la date'],['Date suivante','Date suivante'],['Nearby releases','Sorties proches'],['No releases planned within 7 days of this date.','Aucune sortie planifiée dans les 7 jours autour de cette date.'],['>Not now<','>Plus tard<'],
['✓ Placed in the schedule','✓ Placé au planning'],['» is added on ','» est ajouté au '],[' (visible in Roadmap, tagged “to validate”).',' (visible dans Roadmap, tag « à valider »).'],
['Remember to also report this date in the Google Sheet Roadmap so it persists for the whole team.','Pense à reporter cette date dans le Google Sheet Roadmap pour que ça persiste pour toute l’équipe.'],
['See in the schedule','Voir dans le planning'],
['>Thumbnail scene<','>Scène de miniature<'],['>Music style<','>Style musical<'],['>Launch format<','>Format de lancement<'],
['>Data note<','>Note data<'],['>Recalibration<','>Recalibrage<'],['>Confidence<','>Confiance<'],['>Status<','>Statut<'],
['>SEO keywords<','>Mots-clés SEO<'],['⧉ Copy description','⧉ Copier la description'],['⧉ Copy keywords','⧉ Copier les mots-clés'],['⧉ Copy title','⧉ Copier le titre'],
['🗑️ Remove from schedule','🗑️ Retirer du planning'],
['✅ Validated','✅ Validé'],['❌ Refused','❌ Refusé'],['title="Reset to pending"','title="Remettre à valider"'],['✓ Validate<','✓ Valider<'],['✕ Refuse<','✕ Refuser<'],
['style="color:#fbbf24">Pending review<','style="color:#fbbf24">À valider<'],['style="color:#4ade80">Validated<','style="color:#4ade80">Validé<'],['style="color:#fb7185">Refused<','style="color:#fb7185">Refusé<'],
['Nothing waiting for review.','Rien en attente de validation.'],['No recommendation validated yet.','Aucune recommandation validée pour l’instant.'],['No recommendation refused.','Aucune recommandation refusée.'],
['>Month<','>Mois<'],['>Year<','>Année<'],
['grey Monday','gris Monday'],['green to produce','vert à produire'],['yellow to validate','jaune à valider'],
['S — Steady income','S — Rente potentielle'],['A — Strong','A — Fort'],['B — Solid','B — Solide'],['C — Niche / to test','C — Niche / à tester'],
['✓ Copied<','✓ Copié<'],
['🛠️ Optimization proposal (ready to paste into Studio)','🛠️ Proposition d’optimisation (prête à coller dans Studio)'],
['Current & kept','Actuels conservés'],['>Added<','>Ajoutés<'],['Removed · excluded from copy','Retirés · exclus de la copie'],
['Suggested keywords (','Mots-clés suggérés ('],['/500 characters)</b>:','/500 caractères)</b> :'],
['⧉ Copy keywords','⧉ Copier les mots-clés'],
['>Suggested title<','>Titre suggéré<'],[' (adds the sought-after benefit):',' (ajoute le bénéfice recherché) :'],
['>Suggested description<','>Description suggérée<'],['⧉ Copy description','⧉ Copier la description'],['⧉ Copy title','⧉ Copier le titre'],
['⏱ Add the tracklist with timestamps','⏱ Ajouter la tracklist avec timestamps'],['</b> — generates “key moments” in Google/YouTube search.','</b> — génère des «key moments» dans la recherche Google/YouTube.'],
['🔬 Deep packaging audit','🔬 Audit approfondi du packaging'],['Not enough comparable videos in this genre for a reliable audit.','Pas assez de vidéos comparables dans ce genre pour un audit fiable.'],
['Thumbnail — composition & color','Thumbnail — composition & couleur'],['>✍️ Title<','>✍️ Titre<'],['Description & keywords','Description & mots-clés'],
['🔬 Deep audit (thumbnail, title, SEO)','🔬 Audit approfondi (miniature, titre, SEO)'],['Analysis in progress','Analyse en cours'],
['>Seasonal note<','>Note saisonnière<']
];
const FR_RX=[
[/Weak packaging: ([\d.,]+)% CTR vs ([\d.,]+)% channel median on ([\w.,]+) impressions — YouTube showed it, viewers didn’t click\. Thumbnail\/title are the first suspects\./g,'Packaging faible : $1 % de CTR vs $2 % de médiane chaîne sur $3 impressions. YouTube l’a montrée, les gens n’ont pas cliqué : miniature/titre premiers suspects.'],
[/Strong packaging: ([\d.,]+)% CTR vs ([\d.,]+)% channel median — the thumbnail\/title pull clicks\./g,'Packaging solide : $1 % de CTR vs $2 % de médiane chaîne, la miniature et le titre font cliquer.'],
[/Retention gap: viewers watch ([\d.,]+)% of the video vs ([\d.,]+)% channel median — partly expected on very long sleep mixes, judge with average duration \(([^)]+)\)\./g,'Rétention en retrait : $1 % de la vidéo regardée vs $2 % de médiane chaîne. En partie normal sur les très longs mixes sommeil, juger sur la durée moyenne ($3).'],
[/Retention gap: viewers watch ([\d.,]+)% of the video vs ([\d.,]+)% channel median — the content doesn’t hold the session\./g,'Rétention en retrait : $1 % de la vidéo regardée vs $2 % de médiane chaîne, le contenu ne retient pas la session.'],
[/Excellent retention: ([\d.,]+)% average watched vs ([\d.,]+)% channel median\./g,'Excellente rétention : $1 % regardés en moyenne vs $2 % de médiane chaîne.'],
[/CTR and retention are both healthy — the shortfall likely comes from topic demand or impression volume, not execution\./g,'CTR et rétention sont sains : le manque vient plutôt de la demande sur le sujet ou du volume d’impressions, pas de l’exécution.'],
[/Below the genre bar: ([\w.,]+) views\/mo vs a median of ([\w.,]+) across ([\w.,\s]+) competing ([\w-]+) videos\./g,'Sous la barre du genre : $1 vues/mois vs une médiane de $2 sur $3 vidéos $4 concurrentes.'],
[/Above the genre median \(([\w.,]+) views\/mo across ([\w.,\s]+) competing ([\w-]+) videos\)\./g,'Au-dessus de la médiane du genre ($1 vues/mois sur $2 vidéos $3 concurrentes).'],
[/Short for the winners’ format: top ([\w-]+) performers run ([\w\s]+) median, this one is ([\w\s]+) — longer mixes capture sleep\/focus watch sessions\./g,'Court pour le format gagnant : le top $1 tourne à $2 en médiane, celle-ci fait $3. Les mixes plus longs captent les sessions sommeil/focus.'],
[/Much longer than the winning format \(([\w\s]+) median for top performers\)\./g,'Bien plus longue que le format gagnant ($1 de médiane chez les tops).'],
[/Crowded niche right now: ([\w.,\s]+) competing ([\w-]+) videos published in the last 6 months\./g,'Niche encombrée : $1 vidéos $2 concurrentes publiées ces 6 derniers mois.'],
[/Prediction gap: reco #(\d+) was rated (\w) potential but the video underperforms — packaging \(title\/thumbnail\) is the prime suspect, to confirm with Studio CTR data\./g,'Écart de prédiction : la reco #$1 était notée $2 mais la vidéo sous-performe. Packaging premier suspect, à confirmer avec le CTR Studio.'],
[/Prediction confirmed: rated S potential and delivering\./g,'Prédiction confirmée : notée S et au rendez-vous.'],
[/Accelerating: current pace \(([\w.,]+)\/mo measured\) beats its lifetime average — the algorithm is still pushing it\./g,'En accélération : le rythme actuel ($1/mois mesuré) dépasse sa moyenne, l’algorithme la pousse encore.'],
[/Decelerating: current pace \(([\w.,]+)\/mo measured\) is well below its lifetime average — the push phase is over\./g,'En décélération : le rythme actuel ($1/mois mesuré) est bien sous sa moyenne, la phase de push est finie.'],
[/One of the channel’s strongest launches: ×([\d.]+) the channel’s median velocity \(([\w.,]+) views\/mo\)\./g,'Un des meilleurs lancements de la chaîne : ×$1 la vélocité médiane ($2 vues/mois).'],
[/Well below the channel’s own median \(([\w.,]+) views\/mo, this one at ×([\d.]+)\) — the audience that usually shows up didn’t\./g,'Bien sous la médiane de la chaîne ($1 vues/mois, celle-ci à ×$2). L’audience habituelle n’est pas venue.'],
[/Too young to judge — needs a few more weeks of daily scans\./g,'Trop récente pour juger, encore quelques semaines de scans quotidiens.'],
[/(\d+) scan(s?) recorded/g,'$1 scan$2 enregistré$2'],
[/the curve appears from the 2nd scan/g,'la courbe apparaît dès le 2e scan'],
[/added (\d+ \w+ \d{4})/g,'ajoutée le $1'],
[/#(\d+) search rank/g,'#$1 en recherche'],
[/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/g,function(m,mo,y){const M={January:'Janvier',February:'Février',March:'Mars',April:'Avril',May:'Mai',June:'Juin',July:'Juillet',August:'Août',September:'Septembre',October:'Octobre',November:'Novembre',December:'Décembre'};return M[mo]+' '+y;}]
];
function frz(s){
  FR_LIT.forEach(p=>{s=s.split(p[0]).join(p[1]);});
  FR_RX.forEach(p=>{s=s.replace(p[0],p[1]);});
  return s;
}
function i18nView(options){
  if(LANG!=='fr')return;
  const ids=options&&options.skipContent?['nav']:['view-title','view-sub','view','nav'];
  ids.forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML=frz(e.innerHTML);});
  const st=document.getElementById('sync-txt');if(st)st.innerHTML=frz(st.innerHTML);
  document.querySelectorAll('.side-foot button,.sheet-link,.nav-label').forEach(e=>{e.innerHTML=frz(e.innerHTML);});
}
function i18nZone(el){if(LANG==='fr'&&el)el.innerHTML=frz(el.innerHTML);}
function i18nDrawer(){if(LANG!=='fr')return;const d=document.getElementById('drawer');d.innerHTML=frz(d.innerHTML);fillLikes();}
const FR_NAV={'Dashboard':'Tableau de bord','Videos':'Vidéos','Analysis':'Analyse','Channels':'Chaînes','Recommendations':'Recommandations','Keywords':'Mots-clés'};

function labelResponsiveTables(root){
  const tables=[];
  if(root&&root.matches&&root.matches('table.vtable'))tables.push(root);
  if(root&&root.querySelectorAll)tables.push(...root.querySelectorAll('table.vtable'));
  tables.forEach(table=>{
    const labels=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row=>{
      [...row.children].forEach((cell,i)=>cell.dataset.label=labels[i]||'');
    });
  });
}
const responsiveTableObserver=new MutationObserver(mutations=>{
  mutations.forEach(m=>m.addedNodes.forEach(node=>{if(node.nodeType===1)labelResponsiveTables(node);}));
});
responsiveTableObserver.observe(document.getElementById('view'),{childList:true,subtree:true});

mountLangBtn();

boot();
