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
// 元数据可携带长指令，不能在 64 KB 处截断后按普通会话收录。会话开始时间取 payload.timestamp
// （Codex 自己记的会话创建时间），外层 timestamp 是这条 meta 写入的时刻，作为兜底。
async function readMeta(file,size){
 let length=Math.min(HEAD,size);
 while(true){
  const head=await readChunk(file,0,length),end=head.indexOf('\n');
  if(end>=0||length===size){
   try{const ev=JSON.parse(end>=0?head.slice(0,end):head);return ev.type==='session_meta'?{payload:ev.payload,timestamp:ev.timestamp,bytes:Buffer.byteLength(end>=0?head.slice(0,end+1):head)}:null;}catch{return null;}
  }
  if(length>=4*1024*1024)return null;
  length=Math.min(length*2,size,4*1024*1024);
 }
}
// 这一轮是不是 Codex 桌面版（Codex app / ChatGPT.app，bundle id com.openai.codex）跑的：与 CLI 共用
// 同一份 ~/.codex/sessions，靠 session_meta 的 originator / source 区分——app 侧写 `Codex Desktop`、
// `codex_work_desktop` 或 source=vscode / appserver，CLI 侧写 `codex-tui`、`codex_cli_rs`、source=cli / exec。
// 这份 meta 只在会话头写一次，记的是**线程的出身**，不是「现在谁在跑它」：CLI `codex resume` 一个 app 里起的
// 线程时会接着往同一份 rollout 追加，头部照旧是 Codex Desktop。所以这个标记在通知岛里只是「优先跳 app」的
// 提示（真在终端里跑着、标签标题带着线程名时点一下还是回终端，见 terminals.mjs 的 focus），不能当作「一定不是终端」。
export function isDesktopOrigin(meta){
 const m=meta||{},origin=String(m.originator||'').toLowerCase();
 const source=typeof m.source==='string'?m.source.toLowerCase():'';
 return origin.includes('desktop')||source==='vscode'||source==='appserver';
}
function isSubagent(meta){
 return meta.thread_source==='subagent'||meta.source==='subagent'
  ||(meta.source&&typeof meta.source==='object'&&Object.hasOwn(meta.source,'subagent'))
  ||(meta.thread_source&&typeof meta.thread_source==='object'&&Object.hasOwn(meta.thread_source,'subagent'));
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
 let closed=true,seq=0,timer=null,names=new Map(),indexStamp='',signature='';
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.acked]));
 function snapshot(){
  // 已结束 / 已终止且用户已经看过（点会话行或终端里停过）的会话不再列出：点击即收起，避免残留。
  return {sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).map(({changedAt,changeSeq,lastAt,...s})=>({...s,order:s.order??0,label:['working','waiting','idle','error'].includes(s.state)?({working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'})[s.state]:s.state}))};
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
  // 首次发现（bobo 启动前就存在）的会话不算状态变更：这类会话按「看过」处理，不该补一声提醒。
  const changed=!!prev&&patch.state&&patch.state!==base.state;
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
  const st=await fs.stat(indexFile).catch(()=>null);
  const stamp=st?`${st.mtimeMs}:${st.size}`:'';
  if(stamp===indexStamp)return names;
  const map=new Map();
  try{
   const text=await fs.readFile(indexFile,'utf8');
   for(const line of text.split('\n')){if(!line.trim())continue;try{const o=JSON.parse(line);if(o?.id)map.set(o.id,o.thread_name||o.title||'');}catch{}}
  }catch{}
  names=map;indexStamp=stamp;
  return map;
 }
 async function scanFile(file,knownStat=null){
  const st=knownStat||await fs.stat(file).catch(()=>null);if(!st)return null;
  if(!st.isFile())return null;
  const cached=cache.get(file);
  // 命中缓存时直接返回解析结果：会话文件没变但 session_index 里的标题变了，poll 仍要按名字刷新标题，
  // 返回空会让这次扫描被当成「没看到这个文件」，运行中的会话还会被当成过期清掉。
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached;
  const meta=await readMeta(file,st.size).catch(()=>null);
  if(!meta?.payload)return null;
  const sid=meta.payload.session_id||meta.payload.id;
  if(typeof sid!=='string'||!sid)return null;
  // 明确是子会话时也清掉此前状态与延迟提醒，不让已结束的缓存残留。
  if(isSubagent(meta.payload)){remove('codex:'+sid);cache.delete(file);return null;}
  const cwd=typeof meta.payload.cwd==='string'?meta.payload.cwd:'';
  // 仅创建元数据不代表任务开始，不能按 mtime 误报成运行中。
  if(meta.bytes>=st.size)return null;
  const tail=await readChunk(file,Math.max(0,st.size-TAIL),Math.min(TAIL,st.size)).catch(()=>'');
  const lines=tail.split('\n');if(st.size>TAIL)lines.shift();
  const {state:rawState,lastAt}=deriveState(lines);
  const state=rawState||(st.mtimeMs>Date.now()-3*60*1000?'working':'idle');
  // 计时：会话开始时间（session_meta 里的 timestamp），认不出来时退回文件创建 / 修改时间。
  const startedAt=Date.parse(meta.payload.timestamp||meta.timestamp||'')||st.birthtimeMs||st.mtimeMs;
  const parsed={sid,cwd,state,lastAt:lastAt||st.mtimeMs,startedAt,mtimeMs:st.mtimeMs,size:st.size,app:isDesktopOrigin(meta.payload)};
  cache.set(file,parsed);
  return parsed;
 }
 async function poll(){
  if(closed)return;
  await readNames();
  const seen=new Set(),newest=new Map(),earliest=new Map();
  // 同一个会话可能有不止一份 rollout 文件：Codex 桌面版 rollover / fork 时会新写一份
  // `<原会话id>_<新会话id>.jsonl`，里面的 session_meta.session_id 仍是原 id，而老文件停在旧状态
  // （一份是 turn_aborted、另一份是 task_complete）。逐个文件 update 会让同一个会话每轮轮询在
  // 两种状态间来回翻，「结束 / 终止」提醒跟着每一轮响一次（2 秒一声）。只让最新写入的那份决定
  // 状态，其余文件只用来算开始时间与「会话还在」；开始时间取同组里最早的一份，计时才对得上整个线程。
  for(const parts of dayDirs(Date.now())){
   const dir=path.join(root,...parts);
   const entries=await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]);
   for(const e of entries){
    if(!e.isFile()||!e.name.startsWith('rollout-')||!e.name.endsWith('.jsonl'))continue;
    const file=path.join(dir,e.name);
    const st=await fs.stat(file).catch(()=>null);
    if(!st||Date.now()-st.mtimeMs>SCAN_MS)continue;
    const parsed=await scanFile(file,st);
    if(!parsed)continue;
    const id='codex:'+parsed.sid;seen.add(id);
    const win=newest.get(id);
    if(!win||parsed.mtimeMs>win.mtimeMs||(parsed.mtimeMs===win.mtimeMs&&parsed.lastAt>win.lastAt))newest.set(id,parsed);
    if(!earliest.has(id)||parsed.startedAt<earliest.get(id))earliest.set(id,parsed.startedAt);
   }
  }
  for(const [id,parsed] of newest){
   const title=names.get(parsed.sid)||'',dirName=parsed.cwd?path.basename(parsed.cwd):'Codex';
   let state=parsed.state;
   if(state==='working'&&Date.now()-parsed.lastAt>STALE_MS)state='idle';
   update(id,{source:'codex',state,title,directory:parsed.cwd,name:dirName,at:parsed.lastAt,
    sessionId:parsed.sid,app:parsed.app,startedAt:earliest.get(id)||parsed.startedAt});
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
 // 这个会话的 rollout 头部记着 Codex 桌面版（线程出身，见 isDesktopOrigin）：点会话时优先回 app 的线程深链，
 // 但终端里真有标题命中的标签页、或 app 没在跑时还是走终端（见 terminals.mjs 的 focus）。
 function appSession(id){return sessions.get(id)?.app===true;}
 return {
  snapshot,subscribe,acknowledge,unviewed,appSession,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);listeners.clear();},
 };
}
