/* ================= CONFIG ================= */
const SHEET_ID='1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI';
const XLSX_URL='https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/export?format=xlsx';
// Bump when classification rules change: stale browser caches must not keep
// showing videos previously assigned to a genre by a broad keyword match.
const CACHE_KEY='lofiradar_v4';

const ICONS={
 dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
 all:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg>',
 trends:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
 news:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
 recos:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7c.8.6 1 1.6 1 2.3h6c0-.7.2-1.7 1-2.3A7 7 0 0 0 12 2z"/><path d="M9.5 20h5M10.5 22h3"/></svg>',
 roadmap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 9.5h18"/></svg>',
 search:'<span class="emoji-ico">🔍</span>',
 grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
 rows:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
 flame:'<svg width="10" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2s5 4.5 5 9.5c0 1.5-.4 2.7-1 3.7.6-4-2-6.2-2-6.2.2 2.5-1 3.4-2.2 5-1 1.4-1 3-.2 4.5C9 17.6 7 15.5 7 12.5 7 7 12 2 12 2z"/></svg>'
};

/* ================= PARSE ================= */
/*PARSE_START*/
function cellAt(ws,r,c){return ws[XLSX.utils.encode_cell({r:r,c:c})];}
function cv(ws,r,c){const x=cellAt(ws,r,c);return x==null?null:(x.v==null?null:x.v);}
function cf(ws,r,c){const x=cellAt(ws,r,c);return x&&x.f?x.f:null;}
function vidOf(s){if(!s)return null;const m=String(s).match(/(?:watch\?v=|\/vi\/)([\w-]{11})/);return m?m[1]:null;}
function linkOf(s){if(!s)return null;const m=String(s).match(/HYPERLINK\("([^"]+)"/);return m?m[1]:null;}
function toMs(x){
  if(x==null)return null;
  if(x instanceof Date)return x.getTime();
  if(typeof x==='number')return Math.round((x-25569)*86400000);
  const d=new Date(String(x));return isNaN(d)?null:d.getTime();
}
function num(x){if(x==null)return null;if(typeof x==='number')return x;const n=parseFloat(String(x).replace(/[,\s]/g,''));return isNaN(n)?null:n;}
function str(x){return x==null?'':String(x).trim();}
function findHeader(ws,col,label){
  for(let r=0;r<14;r++){const x=cv(ws,r,col);if(x&&String(x).trim().toLowerCase()===label)return r;}
  return -1;
}
function lastRow(ws){return XLSX.utils.decode_range(ws['!ref']).e.r;}
function sheetByName(wb,frag){
  const n=wb.SheetNames.find(s=>s.includes(frag));
  return n?wb.Sheets[n]:null;
}
function parseVideos(ws,kind){
  const hr=findHeader(ws,1,'title');if(hr<0)return[];
  const out=[];const end=lastRow(ws);
  for(let r=hr+1;r<=end;r++){
    const title=str(cv(ws,r,1));if(!title)continue;
    const vid=vidOf(cf(ws,r,1))||vidOf(cf(ws,r,0));
    const o={
      title:title,
      vid:vid,
      url:vid?('https://www.youtube.com/watch?v='+vid):(linkOf(cf(ws,r,1))||('https://www.youtube.com/results?search_query='+encodeURIComponent(title))),
      durH:num(cv(ws,r,2)), views:num(cv(ws,r,3)), vpm:num(cv(ws,r,4)),
      pub:toMs(cv(ws,r,5)), ageM:num(cv(ws,r,6)),
      genre:str(cv(ws,r,7)), cluster:str(cv(ws,r,8)),
      channel:str(cv(ws,r,9)), chUrl:linkOf(cf(ws,r,9)),
      subs:num(cv(ws,r,10))
    };
    if(kind==='all'){o.kw=str(cv(ws,r,11));o.kwCount=num(cv(ws,r,12));o.pattern=str(cv(ws,r,13));}
    else if(kind==='trends'){o.why=str(cv(ws,r,11));o.sugg=str(cv(ws,r,12));o.copy=str(cv(ws,r,13));o.musical=str(cv(ws,r,14));o.visual=str(cv(ws,r,15));}
    else if(kind==='news'){o.disc=str(cv(ws,r,11));o.rank=num(cv(ws,r,12));o.days=num(cv(ws,r,13));o.why=str(cv(ws,r,14));o.angle=str(cv(ws,r,15));o.added=toMs(cv(ws,r,16));}
    out.push(o);
  }
  return out;
}
function _kwPool(r){
  const g=(r.genre||'').toLowerCase(),ni=(r.niche||'').toLowerCase(),pe=(r.perso||'').toLowerCase(),t=(r.title||'').toLowerCase(),gt=g+' '+t;
  const pool=['lofi girl','lofi','lo-fi','chill beats','relaxing music','calm music','chill music','background music','aesthetic music','instrumental music','music to relax to','chill vibes'];
  const add=a=>a.forEach(x=>pool.push(x));
  if(/lofi|chill ?hop|hip ?hop/.test(g)){add(['lofi hip hop','lofi radio','lofi mix','lofi beats','chillhop','study beats','lofi playlist','lofi chill','lofi vibes','beats to relax study to','chill lofi','lofi music','lofi beats to study']);}
  if(/dark ambient/.test(g)){add(['dark ambient','dark atmospheric music','horror ambient','dungeon synth','eerie ambient','ominous soundscape','dark drone']);}
  else if(/ambient/.test(g)){add(['ambient music','sleep ambient','ambient soundscape','atmospheric music','ambient drone','space ambient','cinematic ambient','ethereal ambient','ambient sleep music','calming ambient']);}
  if(/jazz|bossa/.test(g)){add(['jazz music','smooth jazz','jazz cafe','coffee shop jazz','relaxing jazz','jazz piano','bossa nova','night jazz','jazz instrumental','cozy jazz','jazz for work','warm jazz']);}
  if(/piano|classi/.test(g)){add(['piano music','relaxing piano','emotional piano','sleep piano','piano instrumental','soft piano','beautiful piano','calm piano','peaceful piano']);}
  if(/classi/.test(g)){add(['classical music','relaxing classical','classical piano','instrumental classical','baroque music']);}
  if(/nature/.test(g)){add(['nature sounds','rain sounds','forest sounds','ocean sounds','white noise','rain for sleeping','thunderstorm sounds','nature ambience','river sounds','birds singing']);}
  if(/chill house|house/.test(g)){add(['chill house','chill house instrumental','lofi house instrumental','deep house instrumental','melodic house instrumental','downtempo house instrumental']);}
  if(/drum & bass|drum and bass|dnb|jungle/.test(g)){add(['drum and bass instrumental','liquid dnb instrumental','chill dnb instrumental','ambient drum and bass','drum and bass for work']);}
  if(/guitar|acoust/.test(g)){add(['acoustic guitar','guitar music','relaxing guitar','spanish guitar','fingerstyle guitar','soft guitar']);}
  if(/synth|retro|wave|electro/.test(g)){add(['synthwave','retrowave','80s synthwave','cyberpunk music','outrun','synthwave mix','chillwave','electronic music']);}
  if(/rain|storm|pluie|orage/.test(gt)){add(['rain ambience','cozy rain','rainy day','sleep sounds','heavy rain']);}
  if(/sleep|nuit|night|dorm/.test(ni+' '+t)){add(['sleep music','music for sleeping','deep sleep music','insomnia relief','fall asleep fast','sleeping music','bedtime music','8 hours sleep music','music for deep sleep','relaxing sleep music']);}
  if(/stud|focus|work|concentr|travail/.test(ni+' '+t)){add(['study music','music for studying','concentration music','focus music','deep focus music','study session','pomodoro music','productivity music','work music','music for concentration']);}
  if(/relax|spa|detente|détente|calm|medit|d[eé]tente/.test(ni+' '+t)){add(['relaxing music','stress relief music','calm your mind','meditation music','soothing music','anxiety relief','relaxation music','music for relaxation']);}
  if(/gam/.test(ni+' '+t)){add(['gaming music','music for gaming','focus gaming music']);}
  if(/coffee|cafe|café/.test(ni+' '+t)){add(['coffee shop ambience','cafe music','morning coffee music']);}
  if(/christmas|no[eë]l|xmas/.test(gt)){add(['christmas music','christmas lofi','cozy christmas','holiday music','christmas ambience']);}
  if(/halloween/.test(gt)){add(['halloween music','spooky music','halloween ambience','creepy music']);}
  if(/autumn|automne|fall/.test(t)){add(['autumn lofi','cozy autumn','fall vibes','autumn ambience']);}
  if(/summer|[eé]t[eé]/.test(t)){add(['summer lofi','summer vibes','summer chill']);}
  if(/winter|hiver|snow|neige/.test(t)){add(['winter lofi','cozy winter','snow ambience']);}
  if(/lofi girl|synthwave boy/.test(pe)){add(['lofi girl animation','lofi girl study','lofi girl beats']);}
  add(['1 hour','2 hours','8 hours','black screen','no ads','loop','24/7','study and relax','beats to chill to','music to study to']);
  return pool;
}
function buildRecoDesc(r){
  const t=(r.title||'this mix').trim();
  const dur=(r.dur&&/\d/.test(r.dur))?r.dur:'long';
  const ni=(r.niche||'').toLowerCase()+' '+(r.title||'').toLowerCase()+' '+(r.genre||'').toLowerCase();
  let intro;
  if(/sleep|nuit|night|dorm/.test(ni))
    intro='Press play, dim the lights and let '+t+' carry you into deep, restful sleep. This '+dur+' mix was crafted to quiet your mind, slow your breathing and hold the calm of the night in place — no interruptions, just rest.';
  else if(/stud|focus|work|concentr|travail|gam/.test(ni))
    intro='Put on '+t+' and settle into a state of deep focus. This '+dur+' mix keeps the distractions out and the momentum in — made for studying, working or slipping into flow.';
  else if(/relax|spa|medit|calm|detente|détente/.test(ni))
    intro='Take a breath and let '+t+' wash the day away. This '+dur+' mix is here to ease the tension, calm your thoughts and give you a quiet moment that’s entirely yours.';
  else
    intro='Let '+t+' set the mood. This '+dur+' mix is your background for whatever the moment calls for — relaxing, focusing or simply drifting along.';
  return intro+'\n\n'+
  '🎼 | Listen on Spotify, Apple music and more →\nhttps://fanlink.tv/[a-completer]\n\n'+
  '🎶 | Tracklist\n[00:00] [Artiste] - [Titre]\n[XX:XX] [Artiste] - [Titre]\n\n'+
  '🌎 | Lofi Girl on all social media → https://link.lofigirl.com/m/Community\n'+
  '🌐 | Our Websites → https://link.lofigirl.com/m/website\n'+
  '👕 | Lofi Girl merch → https://link.lofigirlshop.com/shop\n'+
  '🎮 | Our video games → https://link.lofigirl.com/m/games\n'+
  '🎭 | Create your lofi avatar now → https://lofigirl.com/generator/\n\n'+
  '🎨 | Art by Lofi Studio\n→ Production: [a completer]\n→ Art Direction & Supervision: [a completer]\n→ BG: [a completer]\n→ Animation: [a completer]\n→ Assist, clean & colour: [a completer]\n→ Compositing: [a completer]\n\n'+
  '🙏 Thank you for listening, I hope you will have a good time here\n'+
  '❤️ All visuals and music in this video are 100% crafted by talented human artists';
}
function sanitizeRecoCredits(desc){
  return String(desc||'')
    .replace(/(→\s*Production\s*:)[^\n]*/gi,'$1 [a completer]')
    .replace(/(→\s*Art Direction\s*&\s*Supervision\s*:)[^\n]*/gi,'$1 [a completer]')
    .replace(/(→\s*(?:BG|Animation|Assist,?\s*clean\s*&\s*colour|Compositing)\s*:)[^\n]*/gi,'$1 [a completer]');
}
function enrichRecos(recos){
  if(!recos)return recos;
  recos.forEach(r=>{
    if(r.desc)r.desc=sanitizeRecoCredits(r.desc);
    if(r.__enr)return;r.__enr=1;
    const have=new Set(),parts=[];
    const push=x=>{const k=String(x).toLowerCase().trim();if(!k||have.has(k))return;have.add(k);parts.push(String(x).trim());};
    String(r.kw||'').split(/[,;\n]+/).forEach(x=>{if(x.trim())push(x);});
    _kwPool(r).forEach(push);
    let out='';
    for(const p of parts){const cand=out?out+', '+p:p;if(cand.length>498)break;out=cand;}
    if(out&&out.length>=(r.kw||'').length)r.kw=out;
    if(!r.desc||r.desc.length<400)r.desc=buildRecoDesc(r);
    r.desc=sanitizeRecoCredits(r.desc);
  });
  return recos;
}
function parseRecos(ws){
  const hr=findHeader(ws,0,'n°');if(hr<0)return[];
  const out=[];const end=lastRow(ws);
  for(let r=hr+1;r<=end;r++){
    const n=num(cv(ws,r,0));if(n==null)continue;
    out.push({
      n:n, valid:str(cv(ws,r,1)), pot:str(cv(ws,r,2)), score:num(cv(ws,r,3)),
      genre:str(cv(ws,r,4)), niche:str(cv(ws,r,5)), perso:str(cv(ws,r,6)),
      title:str(cv(ws,r,7)), concept:str(cv(ws,r,8)), scene:str(cv(ws,r,9)),
      style:str(cv(ws,r,10)), dur:str(cv(ws,r,11)), desc:str(cv(ws,r,12)),
      kw:str(cv(ws,r,13)), noteData:str(cv(ws,r,14)), launch:str(cv(ws,r,15)),
      conf:num(cv(ws,r,16)), status:str(cv(ws,r,17)), recoClaude:str(cv(ws,r,18)),
      scoreAdj:num(cv(ws,r,19)), recal:str(cv(ws,r,20))
    });
  }
  enrichRecos(out);
  return out;
}
function parseRoadmap(ws){
  const hr=findHeader(ws,0,'date');if(hr<0)return[];
  const out=[];const end=lastRow(ws);
  for(let r=hr+1;r<=end;r++){
    const t=str(cv(ws,r,3));if(!t)continue;
    out.push({
      date:toMs(cv(ws,r,0)), jour:str(cv(ws,r,1)), src:str(cv(ws,r,2)), title:t,
      genre:str(cv(ws,r,4)), perso:str(cv(ws,r,5)), dur:str(cv(ws,r,6)),
      concept:str(cv(ws,r,7)), scene:str(cv(ws,r,8)), style:str(cv(ws,r,9)),
      niche:str(cv(ws,r,10)), cadence:str(cv(ws,r,11)), note:str(cv(ws,r,12))
    });
  }
  return out;
}
function parseHist(ws){
  if(!ws)return {};
  const hist={};const end=lastRow(ws);
  for(let r=1;r<=end;r++){
    const id=str(cv(ws,r,0));if(!id||id.length<8)continue;
    const t=toMs(cv(ws,r,1));const v=num(cv(ws,r,2));
    if(t==null||v==null)continue;
    (hist[id]=hist[id]||[]).push([t,v]);
  }
  Object.values(hist).forEach(a=>a.sort((x,y)=>x[0]-y[0]));
  return hist;
}
function parseLives(ws){
  if(!ws)return[];
  const out=[];const end=lastRow(ws);
  for(let r=1;r<=end;r++){
    const id=str(cv(ws,r,0));if(!/^[\w-]{11}$/.test(id))continue;
    out.push({
      vid:id, channel:str(cv(ws,r,1)),
      title:str(cv(ws,r,2)).replace(/\s*\d{4}-\d{2}-\d{2}[ T]?\d{2}:\d{2}(:\d{2})?\s*$/,''),
      url:str(cv(ws,r,3))||('https://www.youtube.com/watch?v='+id),
      started:toMs(cv(ws,r,4)), disc:str(cv(ws,r,5))
    });
  }
  return out;
}
function parseOurs(ws){
  if(!ws)return[];
  const out=[];const end=lastRow(ws);
  for(let r=1;r<=end;r++){
    const id=str(cv(ws,r,0));if(!/^[\w-]{11}$/.test(id))continue;
    out.push({
      vid:id, title:str(cv(ws,r,1)), url:'https://www.youtube.com/watch?v='+id,
      pub:toMs(cv(ws,r,2)), genre:str(cv(ws,r,3)), perso:str(cv(ws,r,4)),
      durH:num(cv(ws,r,5)), recoN:num(cv(ws,r,6)), notes:str(cv(ws,r,7))
    });
  }
  return out;
}
function normalizeExpandedGenre(rows){
  (rows||[]).forEach(v=>{
    // Genre comes from the curated scan classification.  Do not infer it from
    // discovery keywords: terms such as “liquid” or “jungle” also occur in
    // ambient contexts and previously created false Drum & Bass entries.
    if(v.genre==='Drum & Bass')v.genre='Drum & Bass';
    else if(v.genre==='Chill house')v.genre='Chill house';
  });
  return rows;
}
function parseWorkbook(wb){
  const d={
    all:parseVideos(sheetByName(wb,'All Videos'),'all'),
    trends:parseVideos(sheetByName(wb,'Trends'),'trends'),
    news:parseVideos(sheetByName(wb,'News'),'news'),
    recos:parseRecos(sheetByName(wb,'Video Recommendations')),
    roadmap:parseRoadmap(sheetByName(wb,'Roadmap')),
    hist:parseHist(sheetByName(wb,'View History')),
    lives:parseLives(sheetByName(wb,'Live Streams')),
    liveHist:parseHist(sheetByName(wb,'Live History')),
    liveHourly:parseHist(sheetByName(wb,'Live Hourly')),
    ours:parseOurs(sheetByName(wb,'Our Videos'))
  };
  normalizeExpandedGenre(d.all);normalizeExpandedGenre(d.trends);normalizeExpandedGenre(d.news);normalizeExpandedGenre(d.ours);
  return d;
}
/*PARSE_END*/
