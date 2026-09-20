// 「通知岛」的 Claude Code 数据层。Claude Code 没有对外的事件流，但有两份可读信号：
// 1) ~/.claude/sessions/<pid>.json 是活跃会话的注册表（进程退出即删），status 取 idle / busy / waiting，
//    waiting 时 waitingFor 说明在等什么（`permission prompt` 权限确认 / `input needed` 要你回答）——实时状态以它为准；
// 2) ~/.claude/projects/<目录编码>/<会话ID>.jsonl 是会话日志：尾部有 ai-title（AI 生成的标题）与 last-prompt，
//    退出后也还在，用来补标题与 cwd。
// 这里只读这两处（jsonl 只读头尾、按 mtime + size 缓存），不写任何 Claude Code 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

const HEAD=65536,TAIL=262144;   // 只读文件头尾：头部拿 cwd，尾部拿 ai-title / last-prompt
const SCAN_MS=30*60*1000;      // 只关心最近 30 分钟有写入的会话日志
const STALE_MS=15*60*1000;     // 状态超过这么久没更新还停在「运行中」的，按结束处理
const KEEP_MS=30*60*1000;      // 结束 / 终止的会话保留这么久，够用户去终端看一眼
const MISS_LIMIT=3;            // 连续这么多轮扫不到才认为会话真的消失（日志重写瞬间读不到很正常）
const POLL_MS=2000;
const LABELS={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
// 注册表 status → 通知岛状态；waitingFor 决定「等你回答」的说明文字。
const STATUS={busy:'working',waiting:'waiting',idle:'idle'};
const WAIT_HINTS={'permission prompt':'等待权限确认','input needed':'需要你回答'};

async function readChunk(file,start,length){
 const fh=await fs.open(file,'r');
 try{const buf=Buffer.alloc(length);const {bytesRead}=await fh.read(buf,0,length,start);return buf.subarray(0,bytesRead).toString('utf8');}
 finally{await fh.close();}
}
// pid 是否还活着：注册表是进程退出即删的，但被 kill -9 时会留残骸，用存活检查兜底。
function alive(pid){
 try{process.kill(pid,0);return true;}catch{return false;}
}
// 会话日志头部：cwd、sessionId（新版本每行都带，旧文件可能只有开头有）与会话开始时间
// （第一条记录的 timestamp；没有就退回文件创建 / 修改时间）。
function parseHead(head){
 const cwd=/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
 const sid=/"sessionId"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(head);
 const stamp=/"timestamp"\s*:\s*"([^"]+)"/.exec(head);
 return {cwd:cwd?cwd[1].replace(/\\\//g,'/'):'',sid:sid?sid[1]:'',startedAt:stamp?Date.parse(stamp[1])||0:0};
}
// 会话日志尾部：取最后一条 ai-title（AI 标题）与 last-prompt（用户最后一句），都没有就空着。
export function parseTitle(lines){
 let title='',prompt='';
 for(let i=lines.length-1;i>=0;i--){
  const line=lines[i];if(!line)continue;
  let o;try{o=JSON.parse(line);}catch{continue;}
  if(!o||typeof o!=='object')continue;
  if(!title&&o.type==='ai-title'&&typeof o.aiTitle==='string'&&o.aiTitle.trim())title=o.aiTitle.trim();
  if(!prompt&&o.type==='last-prompt'&&typeof o.lastPrompt==='string'&&o.lastPrompt.trim())prompt=o.lastPrompt.trim().replace(/\s+/g,' ').slice(0,120);
  if(title&&prompt)break;
 }
 return {title,prompt};
}

export function createClaude({home,remind=()=>{},interval=POLL_MS}={}){
 const sessionsRoot=path.join(home,'.claude','sessions'),projectsRoot=path.join(home,'.claude','projects');
 const sessions=new Map(),listeners=new Set(),cache=new Map(),doneTimers=new Map(),askTimers=new Map();
 let closed=true,seq=0,timer=null,signature='';
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.acked]));
 // 已结束 / 已终止且用户已经看过（点会话行或终端里停过）的会话不再列出：点击即收起，避免残留。
 function snapshot(){
  return {sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).map(({changedAt,changeSeq,lastAt,miss,gone,...s})=>({...s,order:s.order??0,label:LABELS[s.state]||s.state}))};
 }
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 function cancelDone(id){const t=doneTimers.get(id);if(t){clearTimeout(t);doneTimers.delete(id);}}
 function cancelAsk(id){const t=askTimers.get(id);if(t){clearTimeout(t);askTimers.delete(id);}}
 // 状态落定时提醒：结束 / 终止先挂起一秒多（Claude Code 在 Stop 之后可能还有子代理在跑，Otty 的 hook 也踩过这个坑），
 // 进入「等你回答」先挂起 0.8 秒（对话框可能一闪而过）；期间状态再变就撤销。
 function remindLater(id,kind,title,delay){
  cancelDone(id);cancelAsk(id);
  doneTimers.set(id,setTimeout(()=>{doneTimers.delete(id);remind(kind,kind==='done'?'运行结束':kind==='error'?'运行终止':'需要你回答',title||id);},delay));
 }
 function update(id,patch){
  const prev=sessions.get(id);
  const base=prev||{id,state:'idle',at:0,changedAt:Date.now(),changeSeq:++seq,acked:false};
  const next={...base,...patch,miss:0};
  const changed=Boolean(patch.state&&patch.state!==base.state);
  if(!prev){
   // 首次发现：bobo 启动前就已经结束 / 终止的会话按「看过」处理，不堆一屏头像；运行中的仍算未查看。
   next.changedAt=patch.at||base.changedAt;next.changeSeq=++seq;next.acked=next.state==='idle'||next.state==='error';
  }else if(changed){next.changedAt=patch.at||Date.now();next.changeSeq=++seq;next.acked=false;}
  next.order=next.changedAt*1000+(next.changeSeq%1000);
  sessions.set(id,next);
  if(changed){
   if(next.state==='idle')remindLater(id,'done',next.title,1500);
   else if(next.state==='error')remindLater(id,'error',next.title,1500);
   else if(next.state==='waiting')remindLater(id,'question',((next.name||'')+(next.detail?' · '+next.detail:'')).trim(),800);
   else{cancelDone(id);cancelAsk(id);}   // 回到运行中：撤销挂起的提醒
  }
 }
 function remove(id){cancelDone(id);cancelAsk(id);sessions.delete(id);}
 async function scanFile(file){
  const st=await fs.stat(file).catch(()=>null);if(!st||!st.isFile())return null;
  const cached=cache.get(file);
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached;
  const head=await readChunk(file,0,Math.min(HEAD,st.size)).catch(()=>'');
  const tail=await readChunk(file,Math.max(0,st.size-TAIL),Math.min(TAIL,st.size)).catch(()=>'');
  const lines=tail.split('\n');if(st.size>TAIL)lines.shift();
  const {cwd,sid:headSid,startedAt}=parseHead(head);
  const {title,prompt}=parseTitle(lines);
  const sid=(/^([0-9a-fA-F-]{36})\.jsonl$/.exec(path.basename(file))||[])[1]||headSid;
  if(!sid)return null;
  const parsed={sid,cwd,title:title||prompt,startedAt:startedAt||st.birthtimeMs||st.mtimeMs,mtimeMs:st.mtimeMs,size:st.size};
  cache.set(file,parsed);
  return parsed;
 }
 async function poll(){
  if(closed)return;
  // 1) 活跃会话注册表：status 是权威的实时状态。
  const active=new Map();
  for(const e of await fs.readdir(sessionsRoot,{withFileTypes:true}).catch(()=>[])){
   if(!e.isFile()||!e.name.endsWith('.json'))continue;
   let o=null;try{o=JSON.parse(await fs.readFile(path.join(sessionsRoot,e.name),'utf8'));}catch{continue;}
   if(!o||typeof o!=='object'||!o.sessionId||o.kind!=='interactive')continue;
   if(!alive(o.pid))continue;
   active.set(o.sessionId,o);
  }
  // 2) 会话日志：补标题（ai-title / last-prompt）与 cwd，只扫最近有写入的。
  const logs=new Map();
  for(const bucket of await fs.readdir(projectsRoot,{withFileTypes:true}).catch(()=>[])){
   if(!bucket.isDirectory()||bucket.name.startsWith('.'))continue;
   const dir=path.join(projectsRoot,bucket.name);
   for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
    if(!e.isFile()||e.name.startsWith('.')||!e.name.endsWith('.jsonl'))continue;
    const file=path.join(dir,e.name);
    const st=await fs.stat(file).catch(()=>null);
    if(!st||Date.now()-st.mtimeMs>SCAN_MS)continue;
    const parsed=await scanFile(file);
    if(!parsed){const prev=cache.get(file);if(prev)logs.set(prev.sid,{...prev,at:st.mtimeMs});continue;}
    logs.set(parsed.sid,{...parsed,at:st.mtimeMs});
   }
  }
  // 3) 合并：有活跃进程用实时状态（认不出的中间态按运行中处理），进程没了就落定一次——
  //    退出时还在跑 / 等回答算「已终止」，否则算「已结束」；落定过的会话保持状态，等保留期结束。
  const seen=new Set();
  for(const sid of new Set([...active.keys(),...logs.keys()])){
   const id='claude:'+sid,reg=active.get(sid),log=logs.get(sid),prev=sessions.get(id);
   const directory=reg?.cwd||log?.cwd||prev?.directory||'';
   const title=String(log?.title||prev?.title||'').trim()||reg?.name||'';
   const base={source:'claude',directory,name:directory?path.basename(directory):'claude',title,sessionId:sid};
   seen.add(id);
   if(reg){
    let state=STATUS[String(reg.status||'').toLowerCase()]||'working';
    const at=Number(reg.statusUpdatedAt)||Number(reg.updatedAt)||Date.now();
    if(state==='working'&&Date.now()-at>STALE_MS)state='idle';
    const detail=state==='waiting'?(WAIT_HINTS[reg.waitingFor]||String(reg.waitingFor||'').trim()||'需要你回答'):'';
    // 计时：注册表记着会话开始时间（startedAt），比日志首行更准；日志没有或读不到时退回会话日志。
    const startedAt=Number(reg.startedAt)||log?.startedAt||prev?.startedAt||at;
    update(id,{...base,state,detail,at,pid:reg.pid,gone:false,startedAt});
    continue;
   }
   if(prev?.gone)continue;
   const at=log?.at||prev?.at||Date.now();
   const state=prev&&(prev.state==='working'||prev.state==='waiting')?'error':'idle';
   update(id,{...base,state,detail:'',at,gone:true,startedAt:log?.startedAt||prev?.startedAt||at});
  }
  // 4) 没再出现的会话：连续几轮扫不到才认为真的消失了（见 MISS_LIMIT）；结束 / 终止的再留一小段时间。
  for(const [id,s] of sessions){
   if(seen.has(id))continue;
   const miss=(s.miss||0)+1;
   if(miss<=MISS_LIMIT){sessions.set(id,{...s,miss});continue;}
   if((s.state==='idle'||s.state==='error')&&Date.now()-s.at<KEEP_MS)continue;
   remove(id);
  }
  for(const [file,p] of cache)if(Date.now()-p.mtimeMs>SCAN_MS*2)cache.delete(file);
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
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||'',source:'claude'}));
 }
 return {
  snapshot,subscribe,acknowledge,unviewed,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);for(const id of [...askTimers.keys()])cancelAsk(id);listeners.clear();},
 };
}
