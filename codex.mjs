// 「通知岛」的 Codex CLI 数据层。Codex 没有像 OpenCode 那样的事件流服务，窗口也不写状态文件，
// 但它会把每个会话的完整过程追加写入 ~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl，
// 其中 event_msg 的 task_started / task_complete / turn_aborted 标出一轮的开始与结束。
// 这里只轮询最近两天的会话文件（按 mtime + size 判断是否变化，只读文件头尾）推导会话状态，不写任何 Codex 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

// 与 opencode.mjs 一致的状态：working 正在跑、waiting 等你回答、idle 已结束、error 已终止。
const WAITING=new Set(['exec_approval_request','apply_patch_approval_request','request_user_input','request_permissions']);
const HEAD=65536,TAIL=131072;          // 只读文件头尾：头部拿 session_meta，尾部拿最后一轮事件
const SCAN_MS=30*60*1000;              // 只关心最近 30 分钟有写入的会话文件
const STALE_MS=15*60*1000;             // 最后活动超过这么久还停在「运行中」的，按结束处理（Codex 可能被杀掉）
const KEEP_MS=30*60*1000;              // 结束 / 终止的会话保留这么久，够用户去终端看一眼
const POLL_MS=2000;

async function readChunk(file,start,length){
 const fh=await fs.open(file,'r');
 try{const buf=Buffer.alloc(length);const {bytesRead}=await fh.read(buf,0,length,start);return buf.subarray(0,bytesRead).toString('utf8');}
 finally{await fh.close();}
}
const dayDirs=(nowMs)=>{
 const out=[],d=new Date(nowMs);
 for(let i=0;i<2;i++){
  const t=new Date(d.getTime()-i*86400000);
  out.push([String(t.getFullYear()),String(t.getMonth()+1).padStart(2,'0'),String(t.getDate()).padStart(2,'0')]);
 }
 return out;
};
// 从尾部事件流推导这一轮的状态；找不到决定性事件时，靠文件是否还在活跃写入兜底。
function deriveState(lines){
 let state=null,lastAt=0;
 for(const line of lines){
  if(!line)continue;
  let ev;try{ev=JSON.parse(line);}catch{continue;}
  if(ev.timestamp){const t=Date.parse(ev.timestamp);if(Number.isFinite(t))lastAt=Math.max(lastAt,t);}
  if(ev.type!=='event_msg')continue;
  const type=ev.payload?.type;
  if(type==='task_started')state='working';
  else if(type==='task_complete')state='idle';
  else if(type==='turn_aborted')state='error';
  else if(WAITING.has(type))state='waiting';
 }
 return {state,lastAt};
}

export function createCodex({home,remind=()=>{},interval=POLL_MS}={}){
 const root=path.join(home,'.codex','sessions'),indexFile=path.join(home,'.codex','session_index.jsonl');
 const sessions=new Map(),listeners=new Set(),cache=new Map(),doneTimers=new Map();
 let closed=true,seq=0,timer=null,names=new Map(),signature='';
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.acked]));
 function snapshot(){
  return {sessions:[...sessions.values()].map(({changedAt,changeSeq,lastAt,...s})=>({...s,order:s.order??0,label:['working','waiting','idle','error'].includes(s.state)?({working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'})[s.state]:s.state}))};
 }
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 function cancelDone(id){const t=doneTimers.get(id);if(t){clearTimeout(t);doneTimers.delete(id);}}
 // 结束 / 终止先挂起一秒多再提醒（Codex 也可能在收尾后继续写入），有新事件就撤销。
 function settle(id,kind,title){
  cancelDone(id);
  doneTimers.set(id,setTimeout(()=>{doneTimers.delete(id);remind(kind,kind==='done'?'运行结束':'运行终止',title||id);},1500));
 }
 function update(id,patch){
  const prev=sessions.get(id);
  const base=prev||{id,state:'idle',at:0,changedAt:Date.now(),changeSeq:++seq,acked:false};
  const next={...base,...patch};
  const changed=patch.state&&patch.state!==base.state;
  if(!prev){
   // 首次发现：bobo 启动前就已经结束 / 终止的会话按「看过」处理，不堆一屏头像；运行中的仍算未查看。
   next.changedAt=patch.at||base.changedAt;next.changeSeq=++seq;next.acked=next.state==='idle'||next.state==='error';
  }else if(changed){next.changedAt=patch.at||Date.now();next.changeSeq=++seq;next.acked=false;}
  next.order=next.changedAt*1000+(next.changeSeq%1000);
  sessions.set(id,next);
  if(changed){if(next.state==='idle')settle(id,'done',next.title);else if(next.state==='error')settle(id,'error',next.title);else cancelDone(id);}
 }
 function remove(id){cancelDone(id);sessions.delete(id);}
 async function readNames(){
  const map=new Map();
  try{const text=await fs.readFile(indexFile,'utf8');
   for(const line of text.split('\n')){if(!line.trim())continue;try{const o=JSON.parse(line);if(o?.id)map.set(o.id,o.thread_name||o.title||'');}catch{}}
  }catch{}
  names=map;
  return map;
 }
 async function scanFile(file){
  const st=await fs.stat(file).catch(()=>null);if(!st)return null;
  if(!st.isFile())return null;
  const cached=cache.get(file);
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached.parsed;
  const head=await readChunk(file,0,Math.min(HEAD,st.size)).catch(()=>'');
  const first=head.split('\n')[0]||'';
  const sid=(/"session_id"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(first)||/rollout-[^/]*-([0-9a-fA-F-]{36})\.jsonl$/.exec(file)||[])[1];
  const cwd=(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(first)||[])[1]?.replace(/\\\//g,'/')||'';
  if(!sid)return null;
  const tail=await readChunk(file,Math.max(0,st.size-TAIL),Math.min(TAIL,st.size)).catch(()=>'');
  const lines=tail.split('\n');if(st.size>TAIL)lines.shift();
  const {state:rawState,lastAt}=deriveState(lines);
  const state=rawState||(st.mtimeMs>Date.now()-3*60*1000?'working':'idle');
  const parsed={sid,cwd,state,lastAt:lastAt||st.mtimeMs,mtimeMs:st.mtimeMs,size:st.size};
  cache.set(file,parsed);
  return parsed;
 }
 async function poll(){
  if(closed)return;
  await readNames();
  const seen=new Set();
  for(const parts of dayDirs(Date.now())){
   const dir=path.join(root,...parts);
   const entries=await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]);
   for(const e of entries){
    if(!e.isFile()||!e.name.startsWith('rollout-')||!e.name.endsWith('.jsonl'))continue;
    const file=path.join(dir,e.name);
    const st=await fs.stat(file).catch(()=>null);
    if(!st||Date.now()-st.mtimeMs>SCAN_MS)continue;
    const parsed=await scanFile(file);
    if(!parsed)continue;
    const id='codex:'+parsed.sid;seen.add(id);
    const title=names.get(parsed.sid)||'',dirName=parsed.cwd?path.basename(parsed.cwd):'Codex';
    let state=parsed.state;
    if(state==='working'&&Date.now()-parsed.lastAt>STALE_MS)state='idle';
    update(id,{source:'codex',state,title,directory:parsed.cwd,name:dirName,at:parsed.lastAt,
     sessionId:parsed.sid});
   }
  }
  // 没再出现的会话：结束 / 终止的留一小段时间，其余立刻清掉，避免历史会话堆在面板上。
  for(const [id,s] of sessions){
   if(seen.has(id))continue;
   if((s.state==='idle'||s.state==='error')&&Date.now()-s.at<KEEP_MS)continue;
   remove(id);
  }
  // 解析缓存跟着过期文件一起清理，避免长时间运行后无限增长。
  for(const [file,p] of cache)if(Date.now()-p.mtimeMs>SCAN_MS*2)cache.delete(file);
  // 只有会话集合 / 状态 / 标题 / 已查看标记真的变了才推送，活动时间的变化不打扰订阅者。
  const sig=signatureOf();
  if(sig!==signature){signature=sig;emit();}
 }
 async function tick(){try{await poll();}catch{}finally{if(!closed){timer=setTimeout(tick,interval);timer.unref?.();}}}
 // 用户已在终端看过这个会话（点会话行跳 Otty 成功，或 Otty 正停在对应标签页）时置位。
 function acknowledge(id){
  const cur=sessions.get(id);
  if(!cur||cur.acked)return false;
  sessions.set(id,{...cur,acked:true});signature=signatureOf();emit();
  return true;
 }
 function unviewed(){
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||'',source:'codex'}));
 }
 return {
  snapshot,subscribe,acknowledge,unviewed,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);listeners.clear();},
 };
}
