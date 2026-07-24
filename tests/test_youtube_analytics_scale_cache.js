const fs=require('fs');
const root=process.cwd();
const index=fs.readFileSync(root+'/index.html','utf8');
const helpers=fs.readFileSync(root+'/assets/js/dashboard-02-helpers.js','utf8');
const legacy=fs.readFileSync(root+'/Lofi_Radar.html','utf8');

function requireText(text,needle,label){
  if(!text.includes(needle)) throw new Error(label+': missing '+needle);
}

requireText(index,'dashboard-02-helpers.js?v=20260724-youtube-zero-baseline-v1','cache version');
requireText(helpers,"if(currentRoute==='ana')return {title:'Analysis',html:anaHTML()};",'analysis title');
requireText(helpers,"topbar.classList.remove('no-view-title')",'visible analysis header');
for(const text of [helpers,legacy]){
  requireText(text,'const y0=0,y1=Math.max(Math.max.apply(null,ys),1);','zero baseline');
  requireText(text,"'<div class=\"hist-axis\"><span>0</span><span>'+fmtN(y1)+'</span></div>'",'axis starts at zero');
  requireText(text,'(best[1]/o.y1)','hover scale');
}
console.log('youtube analytics zero-baseline cache guard: ok');
