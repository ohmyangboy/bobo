// 「通知岛」的 omp（Oh My Pi）数据层。omp 没有事件流服务，但会把每个会话追加写入
// ~/.omp/agent/sessions/<目录编码>/<时间>_<会话ID>.jsonl：第一行是定宽标题槽（改标题原地重写），
// header 记录会话 id 与 cwd；流式文本要等整条消息完成才落盘，所以尾部 entry 能稳定标出状态——
// assistant 不带工具调用地收尾算「已结束」，session_exit 记录退出（kind 区分正常与信号 / 崩溃），
// user / toolResult / tool_execution_start 说明还在跑；工具调用迟迟没开始执行（等批准）与 ask 工具算「等你回答」。
// 这里只轮询最近 30 分钟有写入的会话文件（只读头尾）推导状态，不写任何 omp 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

const HEAD=8192,TAIL=262144;   // 只读文件头尾：头部拿标题槽与 cwd，尾部拿最近的 entry
const SCAN_MS=30*60*1000;      // 只关心最近 30 分钟有写入的会话文件
const STALE_MS=15*60*1000;     // 最后活动超过这么久还停在「运行中」的，按结束处理（omp 可能被杀掉）
const KEEP_MS=30*60*1000;      // 结束 / 终止的会话保留这么久，够用户去终端看一眼
const WAIT_MS=2000;            // 给出工具调用后超过这么久还没开始执行，视为在等你批准
const ASK_TOOLS=new Set(['ask']);
const MISS_LIMIT=3;            // 连续这么多轮扫不到才认为会话真的消失（omp 会原子重写文件，瞬间读不到很正常）
const POLL_MS=2000;
const LABELS={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};

async function readChunk(file,start,length){
 const fh=await fs.open(file,'r');
 try{const buf=Buffer.alloc(length);const {bytesRead}=await fh.read(buf,0,length,start);return buf.subarray(0,bytesRead).toString('utf8');}
 finally{await fh.close();}
}
// 文件头两行：第一行是标题槽（旧格式可能没有，第一行直接是 header），第二行才是会话 header。
// header 里的 timestamp 是会话开始时间；旧版本没写时退回文件名里的时间（<时间>_<会话ID>.jsonl）。
function parseHead(head){
 let title='',header=null;
 for(const line of head.split('\n').slice(0,2)){
  if(!line)continue;
  let o;try{o=JSON.parse(line);}catch{continue;}
  if(o.type==='title'&&typeof o.title==='string')title=o.title;
  else if(o.type==='session')header=o;
 }
 return {title,header};
}
// 文件名时间戳 `2026-09-20T01-02-08-305Z` 不是标准 ISO，转成可解析的形式（没有就返回 0）。
export function stampFromName(name){
 const m=/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name||'');
 return m?Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`):0;
}
// 从尾部 entry 倒着找第一条决定性记录：session_exit（退出）、tool_execution_start（工具）、
// message（user / toolResult 在跑，assistant 收尾算结束或给出工具调用后在等批准）。
// 找不到决定性记录（比如新会话只有 header 与 model_change）时返回 null，由文件活跃度兜底。
export function deriveState(lines,now=Date.now()){
 for(let i=lines.length-1;i>=0;i--){
  const line=lines[i];if(!line)continue;
  let o;try{o=JSON.parse(line);}catch{continue;}
  const at=Date.parse(o.timestamp)||0;
  if(o.type==='custom'){
   if(o.customType==='session_exit')return {state:o.data?.kind==='normal'?'idle':'error',at};
   if(o.customType==='tool_execution_start')return {state:ASK_TOOLS.has(o.data?.toolName)?'waiting':'working',at};
   continue;   // user_todo_edit 等过程性记录继续往前找
  }
  if(o.type!=='message')continue;
  const m=o.message||{},role=m.role||'';
  if(role==='user'||role==='toolResult'||role==='bashExecution'||role==='pythonExecution')return {state:'working',at};
  if(role==='assistant'){
   const calls=Array.isArray(m.content)&&m.content.some(c=>c&&c.type==='toolCall');
   return {state:calls?(at&&now-at>WAIT_MS?'waiting':'working'):'idle',at};
  }
 }
 return {state:null,at:0};
}

export function createOmp({home,agentDir,remind=()=>{},interval=POLL_MS}={}){
 const root=path.join(agentDir||process.env.PI_CODING_AGENT_DIR||path.join(home,'.omp','agent'),'sessions');
 const sessions=new Map(),listeners=new Set(),cache=new Map(),doneTimers=new Map();
 let closed=true,seq=0,timer=null,signature='';
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.acked]));
 function snapshot(){
  // 已结束 / 已终止且用户已经看过（点会话行或终端里停过）的会话不再列出：点击即收起，避免残留。
  return {sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).map(({changedAt,changeSeq,lastAt,miss,...s})=>({...s,order:s.order??0,label:LABELS[s.state]||s.state}))};
 }
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 function cancelDone(id){const t=doneTimers.get(id);if(t){clearTimeout(t);doneTimers.delete(id);}}
 // 结束 / 终止先挂起一秒多再提醒（omp 也可能在收尾后继续写入），有新事件就撤销。
 function settle(id,kind,title){
  cancelDone(id);
  doneTimers.set(id,setTimeout(()=>{doneTimers.delete(id);remind(kind,kind==='done'?'运行结束':'运行终止',title||id);},1500));
 }
 function update(id,patch){
  const prev=sessions.get(id);
  const base=prev||{id,state:'idle',at:0,changedAt:Date.now(),changeSeq:++seq,acked:false};
  const next={...base,...patch,miss:0};
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
 async function scanFile(file){
  const st=await fs.stat(file).catch(()=>null);if(!st||!st.isFile())return null;
  const cached=cache.get(file);
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached;
  const head=await readChunk(file,0,Math.min(HEAD,st.size)).catch(()=>'');
  const {title,header}=parseHead(head);
  if(!header?.id)return null;
  const cwd=typeof header.cwd==='string'?header.cwd:'';
  const tail=await readChunk(file,Math.max(0,st.size-TAIL),Math.min(TAIL,st.size)).catch(()=>'');
  const lines=tail.split('\n');if(st.size>TAIL)lines.shift();
  const {state:rawState,lastAt}=deriveState(lines);
  const state=rawState||(st.mtimeMs>Date.now()-3*60*1000?'working':'idle');
  // 计时：会话开始时间（header.timestamp），旧文件没有就退回文件名里的时间与文件时间。
  const startedAt=Date.parse(header.timestamp||'')||stampFromName(path.basename(file))||st.birthtimeMs||st.mtimeMs;
  const parsed={sid:header.id,cwd,title:title||header.title||'',state,lastAt:lastAt||st.mtimeMs,startedAt,mtimeMs:st.mtimeMs,size:st.size};
  cache.set(file,parsed);
  return parsed;
 }
 async function poll(){
  if(closed)return;
  const seen=new Set();
  for(const bucket of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])){
   if(!bucket.isDirectory()||bucket.name.startsWith('.'))continue;
   const dir=path.join(root,bucket.name);
   for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
    if(!e.isFile()||e.name.startsWith('.')||!e.name.endsWith('.jsonl'))continue;
    const file=path.join(dir,e.name);
    const st=await fs.stat(file).catch(()=>null);
    if(!st||Date.now()-st.mtimeMs>SCAN_MS)continue;
    const parsed=await scanFile(file);
    // 文件在但暂时解析不出来（omp 会原子重写文件）：沿用上一轮的会话，不当作它消失了。
    if(!parsed){const prev=cache.get(file);if(prev)seen.add('omp:'+prev.sid);continue;}
    const id='omp:'+parsed.sid;seen.add(id);
    let state=parsed.state;
    if(state==='working'&&Date.now()-parsed.lastAt>STALE_MS)state='idle';
    update(id,{source:'omp',state,title:parsed.title,directory:parsed.cwd,name:parsed.cwd?path.basename(parsed.cwd):'omp',at:parsed.lastAt,sessionId:parsed.sid,startedAt:parsed.startedAt});
   }
  }
  // 没再出现的会话：连续几轮都扫不到才认为真的消失了（见 MISS_LIMIT，文件重写瞬间读不到很正常）；
  // 结束 / 终止的再留一小段时间，够用户去终端看一眼，其余清掉，避免历史会话堆在面板上。
  for(const [id,s] of sessions){
   if(seen.has(id)){if(s.miss)sessions.set(id,{...s,miss:0});continue;}
   const miss=(s.miss||0)+1;
   if(miss<=MISS_LIMIT){sessions.set(id,{...s,miss});continue;}
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
 // 用户已在终端看过这个会话（点会话行跳终端成功，或终端正停在对应标签页）时置位。
 function acknowledge(id){
  const cur=sessions.get(id);
  if(!cur||cur.acked)return false;
  sessions.set(id,{...cur,acked:true});signature=signatureOf();emit();
  return true;
 }
 function unviewed(){
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||'',source:'omp'}));
 }
 return {
  snapshot,subscribe,acknowledge,unviewed,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);listeners.clear();},
 };
}
