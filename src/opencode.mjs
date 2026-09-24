// 监听本机 OpenCode 服务的事件流（GET /api/event），维护各会话状态，
// 并在「需要你回答 / 运行结束 / 运行终止」时提醒。服务地址与密码来自
// ~/.local/state/opencode/service.json，服务重启后端口会变，所以每次重连都重读。
import fs from 'node:fs/promises';
import path from 'node:path';
import { playSound } from './platform.mjs';

// 会话状态：working 正在跑、waiting 等你回答、idle 已结束、error 已终止（失败或打断）。
export const stateLabels={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
const sounds={question:'Ping.aiff',done:'Glass.aiff',error:'Basso.aiff',reset:'Hero.aiff'};
// 刘海面板显示在哪块屏幕：auto 跟随当前使用的应用（由原生判定），builtin 内置刘海屏，main 主屏。
const displayModes=['auto','builtin','main'];
// 额度查看方式：cycle 点圆环在可用来源之间切换；expand 展开时并排显示各来源。quotaCount 是并排时
// 最多显示几家（3 / 5 / 7），0 = 自适应——原生按屏幕剩余空间算，不越过展开后的中轴线（见 IslandBarGeometry.quotaChips）。
const quotaViews=['cycle','expand'],quotaCounts=[0,3,5,7];

export function createOpenCode({home}){
 const dataDir=path.join(home,'.bobo'),settingsFile=path.join(dataDir,'opencode.json');
 const sessions=new Map(),listeners=new Set();
 // 子 agent 的子会话不上面板：会话列表与 session.created 里的 parentID 标出父子关系（task 工具派生），
 // 认出来就记进 children 长期忽略——子会话跑完常被 OpenCode 删掉，事件尾巴还会飘过来几秒，只跳过创建不够，
 // 之后任何带这个 id 的事件（工具调用、结束、提问）都一律不处理。集合超过上限就丢掉最早记住的一批。
 const children=new Set(),CHILD_LIMIT=300;
 function rememberChild(id){if(!id)return;children.add(id);sessions.delete(id);if(children.size>CHILD_LIMIT)children.delete(children.values().next().value);}
 let settings={notify:true,sound:true,notch:true,hideWhenIdle:false,autoExpand:true,rows:3,menubar:false,movable:false,display:'auto',quotaView:'expand',quotaCount:0},connected=false,closed=false,controller=null,retryTimer=null;
 let noticeSeq=0,notice=null;
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 const setConnected=value=>{if(connected!==value){connected=value;emit();}};
 // 清理超过一天的旧会话，避免状态列表无限增长（正在跑或等回答的保留）。
 function prune(){for(const [id,s] of sessions)if(s.state!=='working'&&s.state!=='waiting'&&Date.now()-s.at>86400000)sessions.delete(id);}
 // 列表顺序按「最近一次状态变更」倒序：任何会话状态一变（开始运行 / 等你回答 / 结束 / 终止）就排到最前，
 // 工具调用、文本输出这类活动事件不刷新 changedAt，列表不会来回跳。changeSeq 让同一毫秒内的变更也有稳定先后。
 let changeSeq=0;
 // bump：新任务（session.inbox.enqueued）即使状态还是「运行中」也算一次变更——用户刚发的要浮到最上面。
 function update(id,patch={}){
  if(!id)return null;
  const now=Date.now();
  const prev=sessions.get(id)||{id,state:'idle',at:now,startedAt:now};
  const next={...prev,...patch};
  next.at=patch.at||now;
  // 计时：会话开始时间只记一次（优先用 OpenCode 的 time.created，认不出来时退回首次见到它的时刻），
  // 之后的活动事件只更新状态，不会把计时重置。通知岛的会话行用它显示「已开多久」。
  next.startedAt=Number(patch.startedAt)||prev.startedAt||next.at;
  delete next.bump;
  if(next.state!=='waiting'){delete next.ask;cancelAsk(id);}
  if(!prev.changedAt||patch.bump===true||(patch.state&&patch.state!==prev.state))next.changedAt=next.at,next.changeSeq=++changeSeq,next.acked=false;
  sessions.delete(id);sessions.set(id,next);prune();emit();
  return next;
 }
 // 用户在终端看过这个会话了（点会话行跳转 Otty）：结束 / 终止后留在刘海上的头像可以消失。
 function acknowledge(id){
  const cur=sessions.get(id);
  if(!cur||cur.acked)return false;
  sessions.set(id,{...cur,acked:true});emit();
  return true;
 }
 // 结束 / 终止且用户还没看过的会话：server.mjs 用它轮询 Otty 当前停留的标签页，命中就调 acknowledge。
 function unviewed(){
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||s.prompt||'',directory:s.directory||''}));
 }
 function snapshot(){
  return {connected,settings,notice,states:Object.entries(stateLabels).map(([key,label])=>({key,label})),
   // 已结束 / 已终止且用户已经看过（点会话行或终端里停过）的会话不再列出：点击即收起，避免残留。
   sessions:[...sessions.values()].filter(s=>!(s.acked===true&&(s.state==='idle'||s.state==='error'))).sort((a,b)=>(b.changedAt-a.changedAt)||(b.changeSeq-a.changeSeq)).slice(0,30).map(({changedAt,changeSeq,ask,...s})=>({...s,title:s.title||s.prompt||'',order:changedAt*1000+(changeSeq%1000),source:'opencode',acked:s.acked===true,label:stateLabels[s.state]||s.state}))};
 }
 // 订阅状态变化（HTTP 流式响应用它推送）：返回取消函数。
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 async function loadSettings(){
  try{const raw=JSON.parse(await fs.readFile(settingsFile,'utf8'));for(const k of ['notify','sound','notch','hideWhenIdle','autoExpand','menubar','movable'])if(typeof raw?.[k]==='boolean')settings[k]=raw[k];if(displayModes.includes(raw?.display))settings.display=raw.display;if(quotaViews.includes(raw?.quotaView))settings.quotaView=raw.quotaView;if(quotaCounts.includes(raw?.quotaCount))settings.quotaCount=raw.quotaCount;if(Number.isFinite(raw?.rows))settings.rows=Math.max(1,Math.min(8,Math.round(raw.rows)));}catch{}
  return settings;
 }
 async function saveSettings(patch){
  settings={notify:patch.notify!==false,sound:patch.sound!==false,notch:patch.notch!==false,
   hideWhenIdle:patch.hideWhenIdle===true,autoExpand:patch.autoExpand!==false,menubar:patch.menubar===true,movable:patch.movable===true,
   display:displayModes.includes(patch.display)?patch.display:'auto',
   quotaView:quotaViews.includes(patch.quotaView)?patch.quotaView:'expand',
   quotaCount:quotaCounts.includes(Number(patch.quotaCount))?Number(patch.quotaCount):0,
   rows:Math.max(1,Math.min(8,Number(patch.rows)||3))};
  try{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(settingsFile,JSON.stringify(settings));}catch{}
  emit();return settings;
 }
 // 提醒：声音在服务端播放（macOS 用 afplay 播系统音，Windows 映射到 SystemSounds，浏览器场景也有效）；
 // 系统通知交给原生 app / 桌面壳发（放进快照的 notice 字段），这样通知归属 bobo、图标也是 bobo。
 function remind(kind,title,message){
  if(settings.sound){
   const sound=sounds[kind];
   if(sound)playSound(sound);
  }
  if(settings.notify){
   notice={seq:++noticeSeq,kind,title,message:message||'',at:Date.now()};
   emit();
  }
 }
 async function openService(){
  const dirs=[process.env.XDG_STATE_HOME&&path.join(process.env.XDG_STATE_HOME,'opencode'),path.join(home,'.local/state/opencode'),path.join(home,'.local/share/opencode')].filter(Boolean);
  for(const dir of dirs){
   try{
    const raw=JSON.parse(await fs.readFile(path.join(dir,'service.json'),'utf8'));
    if(!raw?.url||!raw?.password)continue;
    const url=new URL(raw.url);url.hostname='127.0.0.1';
    return {origin:url.origin,headers:{authorization:'Basic '+Buffer.from('opencode:'+raw.password).toString('base64')}};
   }catch{}
  }
  return null;
 }
 async function request(service,url,options={}){
  const res=await fetch(new URL(url,service.origin),{...options,headers:{...service.headers,...options.headers}});
  if(!res.ok)throw Error('OpenCode 返回 '+res.status);
  return res.json();
 }
 // 重新连上时先读一次已有会话，补上标题与目录；之后靠事件流增量更新。
 const ACTIVE=new Set([
  'session.step.started','session.step.streamed','session.step.ended',
  'session.tool.called','session.tool.progress',
  'session.text.started','session.text.delta','session.reasoning.started','session.reasoning.delta',
  'session.inbox.enqueued','session.inbox.delivered','session.compaction.started',
 ]);
 const idleTimers=new Map(),askTimers=new Map();
 function cancelIdle(id){const timer=idleTimers.get(id);if(timer){clearTimeout(timer);idleTimers.delete(id);}}
 function cancelAsk(id){const timer=askTimers.get(id);if(timer){clearTimeout(timer);askTimers.delete(id);}}
 // 挂起「结束/终止」，安静 delay 毫秒没有活动事件才落定并提醒（见 handle 里的说明）。
 function settle(id,patch,kind,delay){
  cancelIdle(id);
  idleTimers.set(id,setTimeout(()=>{
   idleTimers.delete(id);
   const s=update(id,{...patch,detail:''});
   if(kind==='done')remind('done','运行结束',s?.title||s?.prompt||s?.name||id);
   else remind('error','运行终止',s?.title||s?.prompt||s?.name||id);
  },delay));
 }
 // 权限询问也先挂起一小段：auto 模式会自动批准（permission.replied），这种询问不用你回答，
 // 不该闪一下「等你回答」还弹提醒；真的在等你回答（或你一时没答）才落定并提醒。
 function askPermission(id,patch){
  cancelAsk(id);
  askTimers.set(id,setTimeout(()=>{
   askTimers.delete(id);
   const s=update(id,{...patch,state:'waiting',detail:'等待权限确认',ask:'permission'});
   remind('question','等待权限确认',s?.name||id);
  },800));
 }
 // 首次连接时读一次已有会话，补上标题与目录；之后靠事件流增量更新。
 async function hydrate(service){
  try{
   const body=await request(service,'/api/session?limit=20');
   let changed=false;
   for(const s of body?.data||[]){
    // 已经知道是子会话的直接跳过；列表里带 parentID 的（子 agent）记下来并踢出面板。
    if(s.parentID){if(!children.has(s.id)){rememberChild(s.id);changed=sessions.delete(s.id)||changed;}continue;}
    if(children.has(s.id)||sessions.has(s.id))continue;
    const dir=s.location?.directory||'',seen=s.time?.updated||Date.now();
    // 历史会话没有状态变更时间，用最后活动时间当近似值，接上事件流后的真实变更会覆盖它。
    // 头像按「看过了」处理（bobo 启动前就结束的会话不该堆一屏头像），之后的状态变更会重新置为未查看。
    sessions.set(s.id,{id:s.id,state:'idle',title:s.title||'',directory:dir,name:path.basename(dir)||s.title||s.id,at:seen,changedAt:seen,changeSeq:++changeSeq,acked:true,startedAt:Number(s.time?.created)||seen});
    changed=true;
   }
   if(changed)emit();
   // 服务或 bobo 刚重启时，正在跑的会话不能被列表写成「已结束」：用活跃会话校正（不改排序时间）。
   const active=await request(service,'/api/session/active').catch(()=>null);
   const running=Object.keys(active?.data||{});
   let grew=false;
   for(const id of running){
    const cur=sessions.get(id);
    if(cur){if(cur.state!=='working'){sessions.set(id,{...cur,state:'working'});grew=true;}continue;}
   }
   // 不在列表里的活跃会话（列表有 limit，也可能是子会话）：并发查一次 parentID 再决定收不收。
   const unknown=running.filter(id=>!sessions.has(id)&&!children.has(id));
   const infos=await Promise.all(unknown.map(async id=>{
    const one=await request(service,'/api/session/'+encodeURIComponent(id)).catch(()=>null);
    return {id,parentID:one?.data?.parentID||one?.parentID||'',startedAt:Number(one?.data?.time?.created||one?.time?.created)||0};
   }));
   for(const {id,parentID,startedAt} of infos){
    if(parentID){rememberChild(id);continue;}
    sessions.set(id,{id,at:Date.now(),changedAt:Date.now(),changeSeq:++changeSeq,state:'working',startedAt:startedAt||Date.now()});
    grew=true;
   }
   if(grew)emit();
  }catch{}
 }
 function handle(ev){
  const type=ev?.type||'',data=ev?.data||{},dir=ev?.location?.directory||'';
  const id=data.sessionID||data.form?.sessionID||'';
  const name=dir?path.basename(dir):'';
  if(type==='session.created'){
   const info=data.info||{},newID=info.id||id;
   if(!newID)return;
   // 子 agent 的子会话（parentID 非空）不上面板；V2 把 parentID 直接放在事件里，V1 在 info 里。
   if(data.parentID||info.parentID){rememberChild(newID);return;}
   const newDir=info.directory||info.location?.directory||dir,prev=sessions.get(newID);
   const created=Number(info.time?.created)||0;
   update(newID,{state:prev?.state||'idle',directory:newDir,name:newDir?path.basename(newDir):prev?.name||'',title:info.title||prev?.title||'',...(created?{startedAt:created}:{})});
   return;
  }
  // 已经过滤掉的子会话：它的事件（改名、工具调用、结束、提问……）一律不处理，避免又被建出来。
  if(id&&children.has(id))return;
  if(type==='session.renamed'&&id){update(id,{title:data.title||''});return;}

  // 活动事件：说明这个会话还在跑，取消挂起的「结束」判定。
  if(ACTIVE.has(type)&&id){
   cancelIdle(id);
   const cur=sessions.get(id);
   if(type==='session.inbox.enqueued'){
    const text=(data.item?.payload?.text||'').replace(/\s+/g,' ').trim();
    // 只记 prompt，不覆盖 title：真正用来跳 Otty 的是 OpenCode 的会话标题
    // （Otty 标签名是 `OC | <会话标题>`），把最新提示词写进 title 会让标签匹配失败。
    update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name,prompt:text.slice(0,120),bump:true});
   }else if(!cur||cur.state!=='working'){
    if(!cur||cur.state!=='waiting')update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name});
   }
   return;
  }

  if(type.startsWith('session.execution.')){
   cancelAsk(id);
   const what=type.slice('session.execution.'.length);
   const cur=sessions.get(id);
   const patch={directory:dir||cur?.directory||'',name:cur?.name||name};
   if(what==='started'){cancelIdle(id);update(id,{...patch,state:'working'});return;}
   // 结束与终终止都先挂起：OpenCode 在一次 prompt 里可能还会继续活动（压缩上下文、工具续跑），
   // 安静一小段没有活动事件才真正落定并提醒。这是 Otty 集成插件的教训（见其 plugin 注释）。
   if(what==='succeeded'){settle(id,{...patch,state:'idle'},'done',1200);return;}
   if(what==='failed'||what==='interrupted'){settle(id,{...patch,state:'error'},300);return;}
   return;
  }

  // 若公开流将来提供状态信号，按 busy/idle 处理（CodeIsland 用 session.status 作主信号）。
  if(type==='session.status'&&id){
   const st=data.status?.type||data.status||'';
   const cur=sessions.get(id);
   if(st==='busy'||st==='retry'){cancelIdle(id);cancelAsk(id);update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name});}
   else if(st==='idle'){cancelAsk(id);settle(id,{state:'idle',directory:dir||cur?.directory||'',name:cur?.name||name},'done',1200);}
   return;
  }
  if(type==='session.idle'&&id){settle(id,{state:'idle'},'done',1200);return;}

  if(type==='form.created'&&data.form){
   const f=data.form,question=f.fields?.[0];
   cancelIdle(f.sessionID);cancelAsk(f.sessionID);
   const s=update(f.sessionID,{state:'waiting',directory:dir,name,detail:question?.title||f.title||'需要你回答'});
   remind('question','需要你回答',(s?.name||'')+(question?.title?' · '+question.title:''));
   return;
  }
  if((type==='form.replied'||type==='form.cancelled')&&id){cancelIdle(id);cancelAsk(id);update(id,{state:'working',detail:''});return;}
  if((type==='permission.asked'||type==='permission.v2.asked')&&id){
   cancelIdle(id);
   const cur=sessions.get(id);
   askPermission(id,{directory:dir||cur?.directory||'',name:cur?.name||name});
   return;
  }
  // 权限被回复（auto 模式自动通过，或你在终端里点了允许 / 拒绝）：立刻撤掉「等你回答」，
  // 不用等下一次活动事件或执行结束。
  if((type==='permission.replied'||type==='permission.v2.replied')&&id){
   cancelAsk(id);
   const cur=sessions.get(id);
   if(cur?.state==='waiting'&&cur.ask==='permission')update(id,{state:'working',detail:''});
  }
 }
 // 长连接事件流：断线后重连；OpenCode 没在跑时安静等待。
 async function connect(){
  if(closed)return;
  const service=await openService();
  if(!service){setConnected(false);retryTimer=setTimeout(connect,5000);return;}
  controller=new AbortController();
  try{
   const res=await fetch(new URL('/api/event',service.origin),{headers:{...service.headers,accept:'text/event-stream'},signal:controller.signal});
   if(!res.ok)throw Error('OpenCode 事件流返回 '+res.status);
   setConnected(true);void hydrate(service);
   const decoder=new TextDecoder();let buffer='';
   for await(const chunk of res.body){
    buffer+=decoder.decode(chunk,{stream:true});
    let end;
    while((end=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
     if(!line.startsWith('data:'))continue;
     try{handle(JSON.parse(line.slice(5)));}catch{}
    }
   }
  }catch(e){if(!closed&&e.name!=='AbortError')setConnected(false);}
  if(closed)return;
  setConnected(false);
  retryTimer=setTimeout(connect,2000);
 }
 return {
  settings:()=>settings,
  loadSettings,
  saveSettings,
  acknowledge,
  unviewed,
  snapshot,
  subscribe,
  remind,
  start(){closed=false;void loadSettings().then(connect);},
  stop(){closed=true;clearTimeout(retryTimer);controller?.abort();for(const timer of [...idleTimers.values(),...askTimers.values()])clearTimeout(timer);idleTimers.clear();askTimers.clear();listeners.clear();},
 };
}
