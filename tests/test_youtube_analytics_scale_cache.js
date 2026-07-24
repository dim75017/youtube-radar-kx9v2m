const fs=require('fs');
const root=process.cwd();
const index=fs.readFileSync(root+'/index.html','utf8');
const helpers=fs.readFileSync(root+'/assets/js/dashboard-02-helpers.js','utf8');
const legacy=fs.readFileSync(root+'/Lofi_Radar.html','utf8');

function requireText(text,needle,label){
  if(!text.includes(needle)) throw new Error(label+': missing '+needle);
}

requireText(index,'dashboard-02-helpers.js?v=20260724-youtube-analysis-title-v2','cache version');
requireText(helpers,"if(currentRoute==='ana')return {title:'Analysis',html:anaHTML()};",'analysis title');
requireText(helpers,"topbar.classList.remove('no-view-title')",'visible analysis header');
for(const text of [helpers,legacy]){
  requireText(text,'const actualMin=Math.min.apply(null,ys),actualMax=Math.max.apply(null,ys);','observed range');
  requireText(text,'const y0=flatRange?actualMin-1:actualMin,y1=flatRange?actualMax+1:actualMax;','bounded y scale');
  requireText(text,'(best[1]-o.y0)/(o.y1-o.y0)','hover scale');
}
console.log('youtube analytics scale cache guard: ok');
