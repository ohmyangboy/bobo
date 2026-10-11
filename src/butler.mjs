import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createButlerSources,createProjectResolver,clipBytes,cleanExcerpt} from './butler-sources.mjs';
const DAY=86400000,fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fresh=()=>({version:2,enabled:false,baselined:false,watchSince:0,projects:{},observations:{},messages:[],budget:{day:'',count:0},lastBatch:0});
// 去重的是实际发送的最新进展；状态、时间和标题变化不值得再次付费。
const fingerprint=o=>createHash('sha256').update(JSON.stringify([cleanExcerpt(o.prompt,300),cleanExcerpt(o.reply,1000)])).digest('hex');
const ready=o=>(o.status==='complete'||o.status==='interrupted')&&!!o.reply?.trim();
// 展示层只取一句短消息；已有摘录和摘要无需为了改版重新请求模型。
export function compactSentence(value){
 const plain=String(value||'').replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g,'').replace(/```[\s\S]*?```/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/:codex-file-citation\{[^}]*\}/g,'').replace(/^[ \t]*(?:[-*+]\s+|\d+[.)、]\s+)/gm,'').replace(/[*`#>]/g,'');
 const line=plain.split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!/^(?:摘要|最新进展|本轮进展|更新内容|完成情况|已完成)[：:]?$/.test(s))||'';
 const text=line.split(/[。！？!?]|\.(?=\s|$)/,1)[0].replace(/\s+/g,' ').replace(/[，,；;：:。.\s]+$/g,'');
 if(!text)return '等待新的工作记录。';
 const chars=[...text];
 return chars.length<40?text+(text.endsWith('…')?'':'。'):chars.slice(0,39).join('').replace(/[，,；;：:\s]+$/g,'')+'…';
}
export function briefText(project){
 if(project.summary)return compactSentence(project.summary);
 const facts=project.facts||{},parts=[];
 if(facts.done?.length)parts.push(facts.done.map(f=>f.text).join('、'));
 if(facts.pending?.length)parts.push('待'+facts.pending[0].text);
 if(!parts.length&&facts.next?.length)parts.push(facts.next[0].text);
 return compactSentence(parts.map(s=>s.replace(/[。！？；;]+$/g,'')).join('，')||'暂无明确结果，等待后续进展');
}
export function validateBriefs(result,inputs){
 if(!Array.isArray(result)||result.length!==inputs.length)fail('管家摘要格式无效，可手动重试',502);
 const allowed=new Map(inputs.map(p=>[p.id,p])),seen=new Set();
 return result.map(p=>{
  const input=allowed.get(p?.id);if(!input||seen.has(p.id))fail('管家摘要项目不匹配，可手动重试',502);seen.add(p.id);
  if(typeof p.summary!=='string'||!p.summary.trim())fail('管家摘要条目无效，可手动重试',502);
  return {id:p.id,summary:compactSentence(p.summary),evidence:[input.observations[0].id]};
 });
}
export function createButler({home,ai,sources=createButlerSources({home}),resolveProject=createProjectResolver(),now=Date.now,interval=60000,batchMs=30000}={}){
 const file=path.join(home,'.bobo/butler/state.json'),listeners=new Set();
 let state=fresh(),loaded=null,storageError='',error='',sourceErrors={},revision=0,checking=false,closed=true,timer=null,runPromise=null,saveQueue=Promise.resolve(),generation=0,controller=null;
 async function load(){
  return loaded??=fs.readFile(file,'utf8').then(async text=>{
   const raw=JSON.parse(text);if(![1,2].includes(raw.version)||typeof raw.enabled!=='boolean'||!raw.projects||!raw.observations||!raw.budget)throw Error('格式无效');state={...fresh(),...raw,version:2};
   if(raw.version===1){
    // 从累计摘要迁移为最新进展：旧记录只在本机展示，不继续付费回放积压。
    state.baselined=false;state.watchSince=0;
    for(const p of Object.values(state.projects)){p.facts={done:[],pending:[],next:[]};p.summaryAt=0;delete p.summary;delete p.lastSampleAt;}
   }
   delete state.processed;
   if(!Array.isArray(state.messages))state.messages=[];
   for(const o of Object.values(state.observations))o.signature=fingerprint(o);
   if(trimMessages())await save();
  }).catch(e=>{if(e.code!=='ENOENT')storageError='管家记录无法读取，暂未启用';});
 }
 async function save(){
  if(storageError)fail(storageError,500);
  const task=saveQueue.then(async()=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.chmod(file+'.tmp',0o600);await fs.rename(file+'.tmp',file);});
  saveQueue=task.catch(()=>{});try{await task;}catch{storageError='管家记录保存失败，自动摘要已暂停';fail(storageError,500);}
 }
 function day(){const d=new Date(now());return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function budget(){if(state.budget.day!==day())state.budget={day:day(),count:0};return state.budget;}
 function latestReady(){
  const latest=new Map();for(const o of Object.values(state.observations))if(ready(o)&&o.at>=now()-7*DAY&&(!latest.has(o.projectId)||o.at>=latest.get(o.projectId).at))latest.set(o.projectId,o);
  return [...latest.values()];
 }
 function pending(){return latestReady().filter(o=>o.at>state.watchSince&&state.projects[o.projectId]?.lastProgressSignature!==o.signature);}
 const progressMessageId=o=>createHash('sha256').update(o.projectId+':'+o.signature).digest('hex').slice(0,20);
 function trimMessages(){
  state.messages.sort((a,b)=>a.at-b.at);
  const retained=state.messages.filter(m=>m.at>=now()-7*DAY).slice(-80);
  if(retained.length===state.messages.length)return false;
  state.messages=retained;return true;
 }
 function syncMessages(){
  let changed=false;
  for(const o of latestReady()){
   const p=state.projects[o.projectId],id=progressMessageId(o),old=state.messages.find(m=>m.id===id);
   const summarized=!!p.summaryAt&&p.summarySignature===o.signature;
   const text=summarized?briefText(p):compactSentence(o.reply),summaryAt=summarized?p.summaryAt:0;
   if(old){
    if(old.text!==text||old.summaryAt!==summaryAt){old.text=text;old.summaryAt=summaryAt;changed=true;}
    if(old.source===o.source&&old.sessionId===o.sessionId){
     if(o.prompt&&old.request!==o.prompt){old.request=o.prompt;changed=true;}
     if(o.title&&old.title!==o.title){old.title=o.title;changed=true;}
    }
    continue;
   }
   if(p.lastMessageSignature===o.signature)continue;
   state.messages.push({id,role:'butler',projectId:p.id,name:p.name,text,request:o.prompt||'',at:o.at,summaryAt,source:o.source,sessionId:o.sessionId,title:o.title||'',directory:o.directory});changed=true;
   p.lastMessageSignature=o.signature;
  }
  return trimMessages()||changed;
 }
 function messages(){return state.messages.filter(m=>m.at>=now()-7*DAY).map(({directory,content,sessionId,title,requestId,...m})=>({...m,text:m.role==='user'?compactSentence(content||m.text):m.text}));}
 function message(id){const m=state.messages.find(m=>m.id===id&&m.at>=now()-7*DAY);if(!m)fail('这条消息已过期，请重新选择',404);return {...m};}
 function targets(){
  const rows=new Map();
  for(const o of [...state.messages.filter(m=>m.role==='butler'),...Object.values(state.observations)]){
   if(o.at<now()-7*DAY)continue;
   const id=o.source+':'+o.sessionId,p=state.projects[o.projectId],old=rows.get(id);
   if(p&&(!old||o.at>=old.at))rows.set(id,{id,projectId:p.id,name:p.name,source:o.source,sessionId:o.sessionId,title:o.title||'',directory:o.directory,at:o.at});
  }
  return [...rows.values()].sort((a,b)=>b.at-a.at);
 }
 async function appendReply({requestId,replyTo,quote,text,attachmentIds=[],target,deliver}){
  await load();if(!state.enabled)fail('请先开启管家');
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))fail('发送标识无效');
  const old=state.messages.find(m=>m.requestId===requestId);
  if(old&&!old.retryable)return {status:old.delivery,id:old.id,reason:old.deliveryError||'',action:old.deliveryAction,retryable:false,target:{name:old.name,source:old.source,title:old.title}};
  if(old&&(old.content!==text||old.source!==target.source||old.sessionId!==target.sessionId||old.quote!==(quote||'')||JSON.stringify(old.attachmentIds||[])!==JSON.stringify(attachmentIds)))fail('发送内容已变化，请重新发送',409);
  const m=old||{id:'reply-'+requestId,requestId,role:'user',projectId:target.projectId,name:target.name,text:compactSentence(text),content:text,at:now(),summaryAt:0,source:target.source,sessionId:target.sessionId,title:target.title,directory:target.directory,replyTo:replyTo||null,quote:quote||''};
  m.attachmentIds=attachmentIds;
  m.delivery='sending';m.retryable=false;delete m.deliveryError;delete m.deliveryAction;
  if(!old)state.messages.push(m);trimMessages();await save();emit();
  try{await deliver();m.delivery='sent';}
  catch(e){m.delivery='failed';m.deliveryError=e.message;m.retryable=e.status===409;if(e.action==='enable-otty-input')m.deliveryAction=e.action;}
  syncMessages();await save();emit();
  return {status:m.delivery,id:m.id,reason:m.deliveryError||'',action:m.deliveryAction,retryable:m.retryable,target:{name:m.name,source:m.source,title:m.title}};
 }
 function projects(){
  const queued=new Set(pending().map(o=>o.projectId));
  return Object.values(state.projects).filter(p=>p.updatedAt>=now()-7*DAY).sort((a,b)=>b.updatedAt-a.updatedAt).map(p=>{
   const records=Object.values(state.observations).filter(o=>o.projectId===p.id&&o.at>=now()-7*DAY),sessions=new Map();
   for(const o of records){const key=o.source+':'+o.sessionId,old=sessions.get(key);if(!old||o.at>old.at)sessions.set(key,{source:o.source,sessionId:o.sessionId,title:o.title,at:o.at});}
   const last=records.reverse().sort((a,b)=>b.at-a.at).find(o=>o.prompt||o.reply);
   const preview=last?.reply?compactSentence((ready(last)?'':'进行中：')+last.reply):last?.prompt?compactSentence('正在处理：'+last.prompt):'等待新的工作记录。';
   const summarized=!!p.summaryAt&&last?.signature===p.summarySignature&&ready(last);
   return {id:p.id,name:p.name,directory:p.directory,updatedAt:p.updatedAt,summaryAt:summarized?p.summaryAt:0,text:summarized?briefText(p):preview,facts:summarized?p.facts:{done:[],pending:[],next:[]},sources:[...sessions.values()],pending:queued.has(p.id)};
  });
 }
 function snapshot(){
  const queued=pending().length;
  const status=!state.enabled?'off':storageError||error?'error':checking?'checking':queued?'queued':'ready';
  const minutes=Math.ceil(Math.max(0,state.lastBatch+batchMs-now())/60000);
  const message=storageError||error||(status==='checking'?'正在整理最新进展':status==='queued'?'已读取最新进展，'+(minutes?'约 '+minutes+' 分钟后整理':'等待整理'):state.enabled?'有新完成的进展才更新；历史记录仅在本机展示':'开启后只总结新进展，不回放历史');
  const recentProjects=projects().map(({id,name,text,updatedAt,summaryAt})=>({id,name,text,updatedAt,summaryAt}));
  return {enabled:state.enabled,revision,status,message,lead:recentProjects[0]||null,recentProjects,messages:messages()};
 }
 function detail(){return {...snapshot(),messages:messages().map(m=>m.role==='user'?{...m,text:state.messages.find(s=>s.id===m.id).content||m.text}:m),projects:projects(),budget:{...budget()},sourceErrors};}
 function emit(){revision++;for(const listener of listeners){try{listener();}catch{}}}
 function prune(){
  let changed=false;
  // 每项目只保留最新记录和最新已完成进展（最多两条），不积累对话历史。
  const keep=new Set(),latest=new Map();
  for(const o of Object.values(state.observations))if(o.at>=now()-30*DAY&&(!latest.has(o.projectId)||o.at>=latest.get(o.projectId).at))latest.set(o.projectId,o);
  for(const o of [...latest.values(),...latestReady()])keep.add(o.id);
  for(const id of Object.keys(state.observations))if(!keep.has(id)){delete state.observations[id];changed=true;}
  for(const [id,p] of Object.entries(state.projects))if(p.updatedAt<now()-30*DAY){delete state.projects[id];changed=true;}
  return changed;
 }
 async function ingest(observations){
  let changed=false;const incoming=new Map(),directories=new Map();
  for(const o of observations){
   if(!o.id||!o.directory||!Number.isFinite(o.at)||o.at<now()-7*DAY||(!o.prompt&&!o.reply))continue;
   if(!directories.has(o.directory))directories.set(o.directory,await resolveProject(o.directory));
   const project=directories.get(o.directory);if(!project)continue;
   // 原会话里的指令映射回已有气泡；仅补本机展示信息，不重新总结历史。
   const oldMessage=state.messages.find(m=>m.id===progressMessageId({projectId:project.id,signature:fingerprint(o)})&&m.source===o.source&&m.sessionId===o.sessionId);
   if(oldMessage){
    if(o.prompt&&oldMessage.request!==o.prompt){oldMessage.request=o.prompt;changed=true;}
    if(o.title&&oldMessage.title!==o.title){oldMessage.title=o.title;changed=true;}
   }
   for(const kind of ready(o)?['latest','ready']:['latest']){
    const key=project.id+':'+kind,previous=incoming.get(key);
    if(!previous||o.at>=previous.o.at)incoming.set(key,{o,project});
   }
  }
  // dsh 的各轮可能共享文件时间；先放完成轮，再放真正的最后一轮，保证等时的运行中进展优先展示。
  for(const {o,project} of [...incoming.values()].reverse()){
   const signature=fingerprint(o),old=state.observations[o.id];
   if(old?.signature===signature&&old.status===o.status){if(o.title&&old.title!==o.title){old.title=o.title;changed=true;}continue;}
   if(Object.values(state.observations).some(previous=>previous.projectId===project.id&&previous.at>o.at&&(!ready(o)||ready(previous))))continue;
   const p=state.projects[project.id]??={...project,updatedAt:0,summaryAt:0,facts:{done:[],pending:[],next:[]}};
   state.observations[o.id]={...o,signature,projectId:p.id};p.updatedAt=Math.max(p.updatedAt,o.at);changed=true;
  }
  changed=prune()||changed;
  if(!state.baselined){state.watchSince=now();state.baselined=true;for(const o of latestReady())state.projects[o.projectId].lastProgressSignature=o.signature;changed=true;}
  changed=syncMessages()||changed;
  if(changed){await save();emit();}return changed;
 }
 function pack(project,o){
  // 固定结构和稳定项目名在前，变化的摘录与轮次 ID 在后；不携带旧摘要或旧待办。
  const input={name:clipBytes(project.name,60),observations:[{request:cleanExcerpt(o.prompt,300),result:cleanExcerpt(o.reply,1000),outcome:o.status,id:o.id}],id:project.id};
  for(let limit=900;Buffer.byteLength(JSON.stringify(input))>1536&&limit>=100;limit-=100)input.observations[0].result=cleanExcerpt(o.reply,limit);
  return {input,observation:o};
 }
 async function summarize(){
  const dirty=pending();if(!dirty.length||storageError||now()-state.lastBatch<batchMs)return;
  const configuration=await ai.status();if(!configuration.keyAvailable){error='尚未配置 API Key，请打开 AI 设置';emit();return;}
  const batches=dirty.sort((a,b)=>b.at-a.at).slice(0,3).map(o=>pack(state.projects[o.projectId],o));
  if(!batches.length){error='项目摘要上下文过长，暂未发送';emit();return;}
  const run=generation,budgetDay=budget().day;state.lastBatch=now();budget().count+=batches.length;await save();
  controller=new AbortController();checking=true;error='';emit();
  try{
   const result=await ai.summarizeWork({projects:batches.map(p=>p.input),signal:controller.signal});
   if(run!==generation||!state.enabled)return;
   const briefs=validateBriefs(result.projects,batches.map(p=>p.input));
   for(const brief of briefs){
    const p=state.projects[brief.id],o=batches.find(b=>b.input.id===p.id).observation;
    p.summary=brief.summary;p.facts={done:[],pending:[],next:[]};p.summaryAt=now();p.summarySignature=o.signature;p.lastProgressSignature=o.signature;delete p.failedSignature;
   }
   syncMessages();await save();
  }catch(e){
   if(run===generation){
    error=e.message+'；有新进展再更新，也可手动重试';
    if(e.status===409||e.status===400){if(budget().day===budgetDay)budget().count=Math.max(0,budget().count-batches.length);}
    else for(const b of batches){const p=state.projects[b.input.id];p.lastProgressSignature=b.observation.signature;p.failedSignature=b.observation.signature;}
    await save().catch(()=>{});
   }
  }finally{checking=false;controller=null;emit();}
 }
 async function run(){
  if(runPromise)return runPromise;
  runPromise=(async()=>{
   await load();if(!state.enabled||storageError)return;
   const run=generation;
   try{const data=await sources.scan({since:now()-7*DAY});if(run!==generation||!state.enabled)return;const changed=JSON.stringify(sourceErrors)!==JSON.stringify(data.errors||{});sourceErrors=data.errors||{};if(changed)emit();await ingest(data.observations||[]);await summarize();}
   catch(e){error=e.message;emit();}
  })().finally(()=>{runPromise=null;});return runPromise;
 }
 async function saveSettings(input){
  await load();if(typeof input?.enabled!=='boolean')fail('请选择是否开启管家');if(storageError)fail(storageError,500);
  if(!state.enabled&&input.enabled)state.baselined=false;
  state.enabled=input.enabled;generation++;controller?.abort();error='';await save();emit();if(state.enabled)void run();return detail();
 }
 async function refresh(){await load();if(!state.enabled)fail('请先开启 bobo 管家');if(storageError)fail(storageError,500);for(const p of Object.values(state.projects))if(p.failedSignature===p.lastProgressSignature){delete p.lastProgressSignature;delete p.failedSignature;}error='';await save();void run();return detail();}
 async function tick(){try{await run();}finally{if(!closed){timer=setTimeout(tick,interval);timer.unref?.();}}}
 return {load,snapshot,detail,message,targets,appendReply,saveSettings,refresh,run,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},start(){closed=false;void tick();},async stop(){closed=true;generation++;clearTimeout(timer);controller?.abort();await runPromise;await saveQueue;listeners.clear();}};
}
