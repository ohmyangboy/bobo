// 「通知岛」的 DeepSeek Harness（dsh，`dsh` 命令 / DSH_HOME 默认 ~/.dsh）数据层。
// dsh 把每个会话的投影缓存写在 ~/.dsh/storages/session_projcache/sessions/<会话ID>.json（version 7）：
//   record.identity.cwd                    会话目录
//   record.rows.title.val                  AI 生成的标题
//   record.rows.turnBoundary.val.openTurnStartSeq  非空 = 有一轮正在跑
//   record.rows.sessionStats.val.openStep          非空 = 有一个 step 正在跑
//   record.rows.notification.val.last.reason       completed / aborted / interrupted（上一轮的结局）
//   record.rows.plan.val.wanted                    非空 = 模型请求进入 plan 模式，等你批准
// 投影缓存只在会话活动时更新，文件本身很小（百 KB 级），这里按 mtime + size 缓存后整份解析。
// 只读，不写任何 dsh 配置。审批与 ask_user 的等待不写投影，因此只把「等计划批准」算「等你回答」。
import fs from 'node:fs/promises';
import path from 'node:path';

const SCAN_MS=30*60*1000;      // 只关心最近 30 分钟有活动的会话
const STALE_MS=15*60*1000;     // 状态超过这么久没更新还停在「运行中」的，按结束处理
const KEEP_MS=30*60*1000;      // 结束 / 终止的会话保留这么久，够用户去终端看一眼
const MISS_LIMIT=3;            // 连续这么多轮扫不到才认为会话真的消失
const POLL_MS=2000;
const LABELS={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
const ERROR_REASONS=new Set(['aborted','interrupted','failed','error','crashed']);

// 从投影缓存里读一次会话：标题、目录、状态、最后活动时间与开始时间。
export function readProjection(d,{mtimeMs=0}={}){
 const rec=d?.record||{},rows=rec?.rows||{},row=k=>rows[k]?.val;
 const identity=rec?.identity||{};
 const stats=row('sessionStats')||{},boundary=row('turnBoundary')||{},notif=row('notification')||{},plan=row('plan')||{};
 const outline=row('turnOutline')||{},turns=Array.isArray(outline.turns)?outline.turns:[];
 const running=boundary.openTurnStartSeq!=null||stats.openStep!=null;
 const reason=notif?.last?.reason;
 const title=String(row('title')||'').trim();
 // 标题缺失（还没生成）时退回最后一轮的 prompt。
 const prompt=String(turns.length?(turns[turns.length-1]?.prompt||''):'').replace(/\s+/g,' ').trim().slice(0,120);
 let state='idle';
 if(running)state=plan?.wanted!=null?'waiting':'working';
 else if(reason&&ERROR_REASONS.has(String(reason)))state='error';
 return {
  state,directory:String(identity.cwd||''),title:title||prompt,
  detail:state==='waiting'?'等待批准计划':'',
  // 会话开始时间（identity.createdAt）给通知岛的计时用；旧投影没有这个字段时为 0，由调用方兜底。
  startedAt:Number(identity.createdAt)||0,
  // 投影缓存每次活动都会重写，mtime 就是最准的「最后活动时间」；lastPromptAt 只在首次发现时兜底。
  at:mtimeMs||Number(row('sessionListMetadata')?.lastPromptAt)||Date.now(),
 };
}

export function createDsh({home,dshHome,remind=()=>{},interval=POLL_MS}={}){
 const root=path.join(dshHome||process.env.DSH_HOME||path.join(home,'.dsh'),'storages','session_projcache','sessions');
 const sessions=new Map(),listeners=new Set(),cache=new Map(),doneTimers=new Map(),askTimers=new Map();
 let closed=true,seq=0,timer=null,signature='';
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const signatureOf=()=>JSON.stringify([...sessions.values()].map(s=>[s.id,s.state,s.title,s.acked]));
 // 已结束 / 已终止且用户已经看过（点会话行或终端里停过）的会话不再列出：点击即收起，避免残留。
 function snapshot(){
  return {sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).map(({changedAt,changeSeq,lastAt,miss,...s})=>({...s,order:s.order??0,label:LABELS[s.state]||s.state}))};
 }
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 function cancelDone(id){const t=doneTimers.get(id);if(t){clearTimeout(t);doneTimers.delete(id);}}
 function cancelAsk(id){const t=askTimers.get(id);if(t){clearTimeout(t);askTimers.delete(id);}}
 // 状态落定时提醒：结束 / 终止挂起一秒多（一轮收尾后可能还有子代理在跑），等回答挂起 0.8 秒；期间状态再变就撤销。
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
 async function poll(){
  if(closed)return;
  const seen=new Set();
  for(const e of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])){
   if(!e.isFile()||e.name.startsWith('.')||!e.name.endsWith('.json'))continue;
   const file=path.join(root,e.name);
   const st=await fs.stat(file).catch(()=>null);
   if(!st||Date.now()-st.mtimeMs>SCAN_MS)continue;
   const sid=e.name.slice(0,-5).replace(/^session-/,'');
   const id='dsh:'+sid;seen.add(id);
   const cached=cache.get(file);
   let parsed=cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size?cached.parsed:null;
   if(!parsed){
    let raw=null;try{raw=JSON.parse(await fs.readFile(file,'utf8'));}
    catch{ // 正在写入的半份文件：沿用上一轮结果，不当作会话消失。
     const prev=cached?.parsed;if(prev)update(id,{state:prev.state,title:prev.title,directory:prev.directory,detail:prev.detail,at:prev.at,sessionId:sid});
     continue;
    }
    parsed={...readProjection(raw,{mtimeMs:st.mtimeMs}),sessionId:sid,mtimeMs:st.mtimeMs,size:st.size};
    cache.set(file,{mtimeMs:st.mtimeMs,size:st.size,parsed});
   }
   const directory=parsed.directory||sessions.get(id)?.directory||'';
   let state=parsed.state;
   if(state==='working'&&Date.now()-parsed.at>STALE_MS)state='idle';
   update(id,{source:'dsh',state,title:parsed.title,directory,name:directory?path.basename(directory):'dsh',detail:parsed.detail,at:parsed.at,sessionId:sid,startedAt:parsed.startedAt||sessions.get(id)?.startedAt||st.birthtimeMs||st.mtimeMs});
  }
  // 没再出现的会话：连续几轮扫不到才认为真的消失了；结束 / 终止的再留一小段时间。
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
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||'',source:'dsh'}));
 }
 return {
  snapshot,subscribe,acknowledge,unviewed,
  start(){closed=false;void tick();},
  stop(){closed=true;clearTimeout(timer);for(const id of [...doneTimers.keys()])cancelDone(id);for(const id of [...askTimers.keys()])cancelAsk(id);listeners.clear();},
 };
}
