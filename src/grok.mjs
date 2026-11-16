// 「通知岛」的 Grok Build 会话数据层。Grok 把每个会话放在
// ~/.grok/sessions/<编码后的目录>/<会话 id>/（GROK_HOME 优先）：
//   summary.json          标题、cwd、开始与最后活动时间
//   events.jsonl          turn_started / turn_ended、phase_changed、permission_*、tool_*
//   subagents/<子会话 id> 子代理，不上面板（子会话自己也会出现在会话树里，按这个名单跳过）
// ~/.grok/active_sessions.json 列出当前打开的会话和 pid。只读，不写任何 Grok 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

const SCAN_MS=30*60*1000;
const STALE_MS=15*60*1000;
const KEEP_MS=30*60*1000;
const MISS_LIMIT=3;
const POLL_MS=2000;
const TAIL=64*1024;
const LABELS={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
const ASK_TOOLS=new Set(['ask_user_question']);
const ERROR_OUTCOME=/cancel|interrupt|error|fail|abort/i;

export function parseEventsTail(text){
 const out=[];
 for(const line of String(text||'').split('\n')){
  if(!line.startsWith('{'))continue;
  try{out.push(JSON.parse(line));}catch{}
 }
 return out;
}
// 从事件尾巴推导一轮的状态。自动批准（立刻 permission_resolved）不算等你回答。
export function deriveEvents(events){
 let turnOpen=false,ended='',permOpen=false,askOpen=false,phase='';
 for(const e of events||[]){
  const type=e?.type;
  if(type==='turn_started'){turnOpen=true;ended='';permOpen=false;askOpen=false;phase='';}
  else if(type==='turn_ended'){turnOpen=false;ended=String(e.outcome||'completed');permOpen=false;askOpen=false;phase='';}
  else if(type==='phase_changed')phase=String(e.phase||'');
  else if(type==='permission_requested')permOpen=true;
  else if(type==='permission_resolved'){permOpen=false;if(phase==='permission_prompt')phase='';}
  else if(type==='tool_started'&&ASK_TOOLS.has(e.tool_name))askOpen=true;
  else if(type==='tool_completed'&&ASK_TOOLS.has(e.tool_name))askOpen=false;
 }
 if(askOpen)return {state:'waiting',detail:'等你回答'};
 if(permOpen||phase==='permission_prompt')return {state:'waiting',detail:'等待批准'};
 if(turnOpen)return {state:'working',detail:''};
 if(ended&&ERROR_OUTCOME.test(ended))return {state:'error',detail:''};
 return {state:'idle',detail:''};
}
export function sessionState(events,{alive=false,now=Date.now(),at=0}={}){
 const derived=deriveEvents(events);
 let state=derived.state;
 if(!alive&&(state==='working'||state==='waiting'))state='error';
 if((state==='working'||state==='waiting')&&at&&now-at>STALE_MS)state='idle';
 return {...derived,state};
}
export function parseSummary(raw){
 const info=raw?.info||{};
 const title=String(raw?.generated_title||raw?.session_summary||raw?.last_turn_summary||'').trim();
 const started=Date.parse(raw?.created_at);
 const at=Date.parse(raw?.last_active_at||raw?.updated_at);
 return {
  title,
  directory:String(info.cwd||'').trim(),
  startedAt:Number.isFinite(started)?started:0,
  at:Number.isFinite(at)?at:0,
 };
}

export function createGrok({home,grokHome,env=process.env,remind=()=>{},interval=POLL_MS,now=()=>Date.now(),alive}={}){
 const root=grokHome||(typeof env.GROK_HOME==='string'&&env.GROK_HOME.trim())||path.join(home,'.grok');
 const sessionsRoot=path.join(root,'sessions');
 const activeFile=path.join(root,'active_sessions.json');
 const sessions=new Map(),listeners=new Set(),cache=new Map(),doneTimers=new Map(),askTimers=new Map();
 let closed=true,seq=0,timer=null,signature='',activeCache=null;
 const pidAlive=alive||(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.detail,s.acked]));
 function snapshot(){
  return {sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).map(({changedAt,changeSeq,lastAt,miss,...s})=>({...s,order:s.order??0,label:LABELS[s.state]||s.state}))};
 }
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 function cancelDone(id){const t=doneTimers.get(id);if(t){clearTimeout(t);doneTimers.delete(id);}}
 function cancelAsk(id){const t=askTimers.get(id);if(t){clearTimeout(t);askTimers.delete(id);}}
 function remindLater(id,kind,title,delay){
  cancelDone(id);cancelAsk(id);
  doneTimers.set(id,setTimeout(()=>{doneTimers.delete(id);remind(kind,kind==='done'?'运行结束':kind==='error'?'运行终止':'需要你回答',title||id);},delay));
 }
 function update(id,patch){
  const prev=sessions.get(id);
  const base=prev||{id,state:'idle',at:0,changedAt:now(),changeSeq:++seq,acked:false};
  const next={...base,...patch,miss:0};
  const changed=Boolean(patch.state&&patch.state!==base.state);
  if(!prev){
   next.changedAt=patch.at||base.changedAt;next.changeSeq=++seq;next.acked=next.state==='idle'||next.state==='error';
  }else if(changed){next.changedAt=patch.at||now();next.changeSeq=++seq;next.acked=false;}
  next.order=next.changedAt*1000+(next.changeSeq%1000);
  sessions.set(id,next);
  if(changed){
   if(next.state==='idle')remindLater(id,'done',next.title,1500);
   else if(next.state==='error')remindLater(id,'error',next.title,1500);
   else if(next.state==='waiting')remindLater(id,'question',((next.name||'')+(next.detail?' · '+next.detail:'')).trim(),800);
   else{cancelDone(id);cancelAsk(id);}
  }
 }
 function remove(id){cancelDone(id);cancelAsk(id);sessions.delete(id);}
 async function readActive(){
  const st=await fs.stat(activeFile).catch(()=>null);
  if(!st){activeCache=null;return new Map();}
  if(activeCache&&activeCache.mtimeMs===st.mtimeMs&&activeCache.size===st.size)return activeCache.map;
  let rows=[];
  try{rows=JSON.parse(await fs.readFile(activeFile,'utf8'));}catch{return activeCache?.map||new Map();}
  const map=new Map();
  for(const row of Array.isArray(rows)?rows:[])if(row?.session_id)map.set(String(row.session_id),row);
  activeCache={mtimeMs:st.mtimeMs,size:st.size,map};
  return map;
 }
 async function tailEvents(file,st){
  const key=file;
  const cached=cache.get(key);
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached.events;
  const fh=await fs.open(file,'r').catch(()=>null);
  if(!fh)return cached?.events||[];
  try{
   const len=Math.min(st.size,TAIL),buf=Buffer.alloc(len);
   await fh.read(buf,0,len,Math.max(0,st.size-len));
   const events=parseEventsTail(buf.toString('utf8'));
   cache.set(key,{mtimeMs:st.mtimeMs,size:st.size,events});
   return events;
  }finally{await fh.close();}
 }
 async function poll(){
  const active=await readActive(),seen=new Set(),children=new Set(),candidates=[];
  for(const group of await fs.readdir(sessionsRoot,{withFileTypes:true}).catch(()=>[])){
   if(!group.isDirectory()||group.name.startsWith('.'))continue;
   const groupDir=path.join(sessionsRoot,group.name);
   for(const ent of await fs.readdir(groupDir,{withFileTypes:true}).catch(()=>[])){
    if(!ent.isDirectory()||ent.name.startsWith('.'))continue;
    const sid=ent.name,dir=path.join(groupDir,sid);
    for(const child of await fs.readdir(path.join(dir,'subagents')).catch(()=>[]))if(!child.startsWith('.'))children.add(child);
    const summaryFile=path.join(dir,'summary.json');
    const st=await fs.stat(summaryFile).catch(()=>null);
    const row=active.get(sid);
    const open=!!row&&pidAlive(Number(row.pid));
    if(!st||(!open&&now()-st.mtimeMs>SCAN_MS))continue;
    candidates.push({sid,dir,summaryFile,st,open,cwd:String(row?.cwd||'')});
   }
  }
  for(const item of candidates){
   if(children.has(item.sid))continue;
   const id='grok:'+item.sid;
   let summary={};
   try{summary=parseSummary(JSON.parse(await fs.readFile(item.summaryFile,'utf8')));}
   catch{if(sessions.has(id)){seen.add(id);sessions.set(id,{...sessions.get(id),miss:0});}continue;}
   seen.add(id);
   const eventsFile=path.join(item.dir,'events.jsonl');
   const evSt=await fs.stat(eventsFile).catch(()=>null);
   const events=evSt?await tailEvents(eventsFile,evSt):[];
   const at=Math.max(summary.at||0,item.st.mtimeMs||0);
   const derived=sessionState(events,{alive:item.open,now:now(),at});
   const directory=summary.directory||item.cwd;
   update(id,{source:'grok',state:derived.state,title:summary.title||'未命名会话',directory,name:directory?path.basename(directory):'Grok',detail:derived.detail,at:at||now(),sessionId:item.sid,startedAt:summary.startedAt||sessions.get(id)?.startedAt||item.st.birthtimeMs||at});
  }
  for(const [id,s] of sessions){
   if(seen.has(id))continue;
   const miss=(s.miss||0)+1;
   if(miss<=MISS_LIMIT){sessions.set(id,{...s,miss});continue;}
   if((s.state==='idle'||s.state==='error')&&now()-s.at<KEEP_MS)continue;
   remove(id);
  }
  const sig=signatureOf();
  if(sig!==signature){signature=sig;emit();}
 }
 async function tick(){try{await poll();}catch{}finally{if(!closed){timer=setTimeout(tick,interval);timer.unref?.();}}}
 function acknowledge(id){
  const cur=sessions.get(id);
  if(!cur||cur.acked)return false;
  sessions.set(id,{...cur,acked:true});signature=signatureOf();emit();
  return true;
 }
 function unviewed(){
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||'',source:'grok'}));
 }
 return {
  snapshot,subscribe,acknowledge,unviewed,refresh:poll,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);for(const id of [...askTimers.keys()])cancelAsk(id);listeners.clear();},
 };
}
