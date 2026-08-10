const fs=require('fs');
const vm=require('vm');
const root=process.cwd();
const helpers=fs.readFileSync(root+'/assets/js/dashboard-02-helpers.js','utf8');
const keywords=fs.readFileSync(root+'/assets/js/dashboard-03-keywords.js','utf8');
const recos=fs.readFileSync(root+'/assets/js/dashboard-04-recommendations.js','utf8');
const config=fs.readFileSync(root+'/assets/js/dashboard-01-config.js','utf8');
const css=fs.readFileSync(root+'/assets/css/dashboard.css','utf8');

function requireText(text,needle,label){
  if(!text.includes(needle))throw new Error(label+': missing '+needle);
}
function functionSource(text,name){
  const start=text.indexOf('function '+name+'(');
  if(start<0)throw new Error('missing function '+name);
  const brace=text.indexOf('{',start);
  let depth=0,quote='',escape=false;
  for(let i=brace;i<text.length;i++){
    const ch=text[i];
    if(quote){
      if(escape)escape=false;
      else if(ch==='\\')escape=true;
      else if(ch===quote)quote='';
      continue;
    }
    if(ch==='"'||ch==="'"||ch==='\`'){quote=ch;continue;}
    if(ch==='{')depth++;
    if(ch==='}'&&--depth===0)return text.slice(start,i+1);
  }
  throw new Error('unterminated function '+name);
}

const audienceContext={};
vm.runInNewContext(
  functionSource(helpers,'radarAudience')+
  functionSource(helpers,'matchesRadarAudience'),
  audienceContext
);
if(audienceContext.radarAudience({madeForKids:true})!=='kids')throw new Error('official true must be Kids');
for(const row of [{madeForKids:false},{}, {madeForKids:'true'}]){
  if(audienceContext.radarAudience(row)!=='youtube')throw new Error('only boolean true may be Kids');
}

requireText(helpers,"mix:{q:'',genre:'',sort:'views',mode:'grid',limit:60,age:'3m',audience:'youtube'}",'video default');
requireText(helpers,"const LS={q:'',sort:'now',mode:'grid',limit:60,audience:'youtube'}",'live default');
requireText(keywords,"rows=rows.filter(v=>matchesRadarAudience(v,st.audience))",'video audience filter');
requireText(recos,"rows=rows.filter(v=>matchesRadarAudience(v,LS.audience))",'live audience filter');
requireText(keywords,"const audienceRows=kind==='mix'?all.filter(v=>matchesRadarAudience(v,st.audience)):all",'contextual counters');
requireText(helpers,"if(VS.mix.genre&&!available.some(v=>v.genre===VS.mix.genre))VS.mix.genre=''",'genre reset');
requireText(keywords,"const genres=[...new Set(periodRows.map(v=>v.genre).filter(Boolean))]",'period-only genre options');
requireText(keywords,"mixRows().forEach(v=>{tally(v.kw,';');tally(v.disc,',');});",'deduplicated keyword counters');
requireText(helpers,"VS.mix.audience=audience;VS.mix.limit=60",'video limit reset');
requireText(helpers,"LS.audience=audience;LS.limit=60",'live limit reset');
requireText(helpers,'aria-pressed="','audience switch accessibility');
requireText(keywords,'add(DATA.all);add(DATA.trends);add(DATA.news);add(DATA.kids);','Kids bucket');
requireText(config,"audiences:/\\bkids?\\b/i.test(str(cv(ws,r,6)))?['kids']:undefined",'live audience column');
requireText(helpers,"const liveById=new Map((snap.lives||[]).map",'live official status merge');
requireText(css,'.audience-switch{display:flex;flex:0 0 auto;white-space:nowrap','responsive switch');
requireText(recos,"['No active Kids livestreams match this view.','Aucun livestream Kids actif ne correspond à cette vue.']",'Kids empty-state translation');

const videos=functionSource(keywords,'videosHTML');
const genreAt=videos.indexOf("xdd('c-genre'");
const videoSwitchAt=videos.indexOf("audienceSwitchHTML('mix'");
const videoSortAt=videos.indexOf("'<div class=\"tb-right\">'");
if(!(genreAt>=0&&genreAt<videoSwitchAt&&videoSwitchAt<videoSortAt)){
  throw new Error('Videos control order must be genre -> audience -> sort');
}
const lives=functionSource(recos,'livesHTML');
const searchAt=lives.indexOf("'<div class=\"search\">'");
const liveSwitchAt=lives.indexOf("audienceSwitchHTML('live'");
const liveSortAt=lives.indexOf("'<div class=\"tb-right\">'");
if(!(searchAt>=0&&searchAt<liveSwitchAt&&liveSwitchAt<liveSortAt)){
  throw new Error('Livestream control order must be search -> audience -> sort');
}

console.log('youtube Kids switch guard: ok');
