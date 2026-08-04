const SS='1XE_M9pQWn8w2Qu83vV_tv9sEFDFQ13fTePseG6mh1vI';
const KEY='lofiradar2026kx';
const LEARNING_SHEET='🤖 Recommendation Learning';
const LEARNING_VERSION=2;
const LEARNING_HEADERS=[
  'n','valid','updatedAt','title','editedTitle','editedConcept','editedDesc',
  'genreKey','purposeKey','sourceVideoId','sourceWindow','sourceMarketScore',
  'feedbackAffinity','generatorVersion','roadmapDate','roadmapState','publishedVideoId'
];

function doGet(e){
  var p=e&&e.parameter||{},out={ok:false};
  try{
    if(p.k!==KEY){out.err='bad key';return j(out);}
    var ss=SpreadsheetApp.openById(SS);
    if(p.op==='state')return j(readLearningState_(ss));

    // Backwards-compatible writer for the 1,000 curated Sheet concepts.
    var sh=ss.getSheets().filter(function(s){return s.getName().indexOf('Recommendations')>-1;})[0];
    if(!sh){out.err='tab not found';return j(out);}
    var col=sh.getRange('A:A').getValues(),row=-1;
    for(var i=0;i<col.length;i++)if(String(col[i][0])===String(p.n)){row=i+1;break;}
    if(row<0){out.err='reco '+p.n+' not found';return j(out);}
    sh.getRange(row,2).setValue(p.val||'');
    out.ok=true;out.n=p.n;out.val=p.val||'';
  }catch(err){out.err=String(err);}
  return j(out);
}

function doPost(e){
  var out={ok:false};
  try{
    var p=e&&e.parameter||{};
    if(p.k!==KEY){out.err='bad key';return j(out);}
    var body=JSON.parse(e&&e.postData&&e.postData.contents||'{}');
    if(body.op!=='upsert')throw new Error('unsupported operation');
    var action=String(body.action||'');
    if(['decision','edit','roadmap','archive','published'].indexOf(action)<0)throw new Error('unsupported action');
    out=upsertLearning_(SpreadsheetApp.openById(SS),body,action);
  }catch(err){out={ok:false,err:String(err)};}
  return j(out);
}

function ensureLearningSheet_(ss){
  var sh=ss.getSheetByName(LEARNING_SHEET);
  if(!sh){
    sh=ss.insertSheet(LEARNING_SHEET);
    sh.getRange(1,1,1,LEARNING_HEADERS.length).setValues([LEARNING_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,LEARNING_HEADERS.length)
      .setFontWeight('bold').setBackground('#111827').setFontColor('#ffffff');
    sh.hideSheet();
  }
  var current=sh.getRange(1,1,1,LEARNING_HEADERS.length).getValues()[0];
  if(current.join('|')!==LEARNING_HEADERS.join('|'))throw new Error('learning schema mismatch');
  return sh;
}

function upsertLearning_(ss,body,action){
  var n=Number(body.n);
  if(!Number.isSafeInteger(n)||n>=0)throw new Error('invalid generated recommendation id');
  var lock=LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var sh=ensureLearningSheet_(ss),last=sh.getLastRow(),row=-1;
    if(last>1){
      var ids=sh.getRange(2,1,last-1,1).getValues();
      for(var i=0;i<ids.length;i++)if(String(ids[i][0])===String(n)){row=i+2;break;}
    }
    if(row<0){row=Math.max(2,last+1);sh.getRange(row,1).setValue(n);}
    var values=sh.getRange(row,1,1,LEARNING_HEADERS.length).getValues()[0];
    values[0]=n;
    setTextIfPresent_(values,3,body.title,240);
    setTextIfPresent_(values,7,body.genreKey,64);
    setTextIfPresent_(values,8,body.purposeKey,64);
    setTextIfPresent_(values,9,body.sourceVideoId,32);
    setTextIfPresent_(values,10,body.sourceWindow,16);
    setNumberIfPresent_(values,11,body.sourceMarketScore);
    setNumberIfPresent_(values,12,body.feedbackAffinity);
    setNumberIfPresent_(values,13,body.generatorVersion);

    if(action==='decision')values[1]=boundedText_(body.valid,2000);
    if(action==='edit'){
      setTextIfPresent_(values,4,body.editedTitle,240,true);
      setTextIfPresent_(values,5,body.editedConcept,4000,true);
      setTextIfPresent_(values,6,body.editedDesc,12000,true);
    }
    if(action==='roadmap'){
      var roadmapDate=Number(body.roadmapDate);
      if(!Number.isFinite(roadmapDate)||roadmapDate<=0)throw new Error('invalid roadmap date');
      values[14]=Math.round(roadmapDate);values[15]='active';
    }
    if(action==='archive'){
      var archivedRoadmapDate=Number(body.roadmapDate);
      if(Number.isFinite(archivedRoadmapDate)&&archivedRoadmapDate>0)values[14]=Math.round(archivedRoadmapDate);
      values[15]='archived';
    }
    if(action==='published'){
      var videoId=boundedText_(body.publishedVideoId,32);
      if(!/^[\w-]{11}$/.test(videoId))throw new Error('invalid published video id');
      values[16]=videoId;
    }
    values[2]=Date.now();
    sh.getRange(row,1,1,LEARNING_HEADERS.length).setValues([values]);
    SpreadsheetApp.flush();
    return {ok:true,version:LEARNING_VERSION,item:learningItem_(values)};
  }finally{lock.releaseLock();}
}

function readLearningState_(ss){
  var sh=ensureLearningSheet_(ss),last=sh.getLastRow(),items=[];
  if(last>1){
    var rows=sh.getRange(2,1,last-1,LEARNING_HEADERS.length).getValues();
    rows.forEach(function(values){if(values[0]!==''&&values[0]!=null)items.push(learningItem_(values));});
  }
  var updatedAt=items.reduce(function(max,item){return Math.max(max,Number(item.updatedAt)||0);},0);
  return {ok:true,version:LEARNING_VERSION,updatedAt:updatedAt,items:items};
}

function learningItem_(values){
  var item={};
  LEARNING_HEADERS.forEach(function(header,index){
    var value=values[index];
    if(value instanceof Date)value=value.getTime();
    if(value!==''&&value!=null)item[header]=value;
  });
  item.n=Number(item.n);item.updatedAt=Number(item.updatedAt)||0;
  if(item.roadmapDate!=null)item.roadmapDate=Number(item.roadmapDate);
  return item;
}

function setTextIfPresent_(values,index,value,max,allowEmpty){
  if(value===undefined||value===null)return;
  var text=boundedText_(value,max);
  if(text||allowEmpty)values[index]=text;
}

function setNumberIfPresent_(values,index,value){
  if(value===undefined||value===null||value==='')return;
  var number=Number(value);if(Number.isFinite(number))values[index]=number;
}

function boundedText_(value,max){
  return String(value==null?'':value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').slice(0,max);
}

function j(o){
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
