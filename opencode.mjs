// 监听本机 OpenCode 服务的事件流（GET /api/event），维护各会话状态，
// 并在「需要你回答 / 运行结束 / 运行终止」时提醒。服务地址与密码来自
// ~/.local/state/opencode/service.json，服务重启后端口会变，所以每次重连都重读。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 会话状态：working 正在跑、waiting 等你回答、idle 已结束、error 已终止（失败或打断）。
export const stateLabels={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
const sounds={question:'Ping.aiff',done:'Glass.aiff',error:'Basso.aiff'};
// 刘海面板显示在哪块屏幕：auto 跟随当前使用的应用（由原生判定），builtin 内置刘海屏，main 主屏。
const displayModes=['auto','builtin','main'];

export function createOpenCode({home}){
 const dataDir=path.join(home,'.bobo'),settingsFile=path.join(dataDir,'opencode.json');
 const sessions=new Map(),listeners=new Set();
 let settings={notify:true,sound:true,notch:true,hideWhenIdle:false,autoExpand:true,rows:3,menubar:false,movable:false,display:'auto'},connected=false,closed=false,controller=null,retryTimer=null;
 let noticeSeq=0,notice=null;
 const emit=()=>{for(const l of listeners){try{l();}catch{}}};
 // 清理超过一天的旧会话，避免状态列表无限增长（正在跑或等回答的保留）。
 function prune(){for(const [id,s] of sessions)if(s.state!=='working'&&s.state!=='waiting'&&Date.now()-s.at>86400000)sessions.delete(id);}
 // 列表顺序按「最近一次状态变更」倒序：任何会话状态一变（开始运行 / 等你回答 / 结束 / 终止）就排到最前，
 // 工具调用、文本输出这类活动事件不刷新 changedAt，列表不会来回跳。changeSeq 让同一毫秒内的变更也有稳定先后。
 let changeSeq=0;
 // bump：新任务（session.inbox.enqueued）即使状态还是「运行中」也算一次变更——用户刚发的要浮到最上面。
 function update(id,patch={}){
  if(!id)return null;
  const prev=sessions.get(id)||{id,state:'idle',at:Date.now()};
  const next={...prev,...patch};
  next.at=patch.at||Date.now();
  delete next.bump;
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
  return [...sessions.values()].filter(s=>(s.state==='idle'||s.state==='error')&&!s.acked).map(s=>({id:s.id,title:s.title||'',directory:s.directory||''}));
 }
 function snapshot(){
  return {connected,settings,notice,states:Object.entries(stateLabels).map(([key,label])=>({key,label})),
   sessions:[...sessions.values()].sort((a,b)=>(b.changedAt-a.changedAt)||(b.changeSeq-a.changeSeq)).slice(0,30).map(({changedAt,changeSeq,...s})=>({...s,order:changedAt*1000+(changeSeq%1000),source:'opencode',acked:s.acked===true,label:stateLabels[s.state]||s.state}))};
 }
 // 订阅状态变化（HTTP 流式响应用它推送）：返回取消函数。
 function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
 async function loadSettings(){
  try{const raw=JSON.parse(await fs.readFile(settingsFile,'utf8'));for(const k of ['notify','sound','notch','hideWhenIdle','autoExpand','menubar','movable'])if(typeof raw?.[k]==='boolean')settings[k]=raw[k];if(displayModes.includes(raw?.display))settings.display=raw.display;if(Number.isFinite(raw?.rows))settings.rows=Math.max(1,Math.min(8,Math.round(raw.rows)));}catch{}
  return settings;
 }
 async function saveSettings(patch){
  settings={notify:patch.notify!==false,sound:patch.sound!==false,notch:patch.notch!==false,
   hideWhenIdle:patch.hideWhenIdle===true,autoExpand:patch.autoExpand!==false,menubar:patch.menubar===true,movable:patch.movable===true,
   display:displayModes.includes(patch.display)?patch.display:'auto',
   rows:Math.max(1,Math.min(8,Number(patch.rows)||3))};
  try{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(settingsFile,JSON.stringify(settings));}catch{}
  emit();return settings;
 }
 // 提醒：声音在服务端用 afplay 播放（浏览器场景也有效）；系统通知交给原生 app 发
 // （放进快照的 notice 字段），这样通知归属 bobo、图标也是 bobo，点击不会再打开脚本编辑器。
 function remind(kind,title,message){
  if(settings.sound){
   const sound=sounds[kind];
   if(sound)try{spawn('afplay',['/System/Library/Sounds/'+sound],{stdio:'ignore',shell:false}).on('error',()=>{});}catch{}
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
 const idleTimers=new Map();
 function cancelIdle(id){const timer=idleTimers.get(id);if(timer){clearTimeout(timer);idleTimers.delete(id);}}
 // 挂起「结束/终止」，安静 delay 毫秒没有活动事件才落定并提醒（见 handle 里的说明）。
 function settle(id,patch,kind,delay){
  cancelIdle(id);
  idleTimers.set(id,setTimeout(()=>{
   idleTimers.delete(id);
   const s=update(id,{...patch,detail:''});
   if(kind==='done')remind('done','运行结束',s?.title||s?.name||id);
   else remind('error','运行终止',s?.title||s?.name||id);
  },delay));
 }
 // 首次连接时读一次已有会话，补上标题与目录；之后靠事件流增量更新。
 async function hydrate(service){
  try{
   const body=await request(service,'/api/session?limit=20');
   let changed=false;
   for(const s of body?.data||[]){
    if(sessions.has(s.id))continue;
    const dir=s.location?.directory||'',seen=s.time?.updated||Date.now();
    // 历史会话没有状态变更时间，用最后活动时间当近似值，接上事件流后的真实变更会覆盖它。
    // 头像按「看过了」处理（bobo 启动前就结束的会话不该堆一屏头像），之后的状态变更会重新置为未查看。
    sessions.set(s.id,{id:s.id,state:'idle',title:s.title||'',directory:dir,name:path.basename(dir)||s.title||s.id,at:seen,changedAt:seen,changeSeq:++changeSeq,acked:true});
    changed=true;
   }
   if(changed)emit();
   // 服务或 bobo 刚重启时，正在跑的会话不能被列表写成「已结束」：用活跃会话校正（不改排序时间）。
   const active=await request(service,'/api/session/active').catch(()=>null);
   const running=Object.keys(active?.data||{});
   if(running.length){
    for(const id of running){
     const cur=sessions.get(id)||{id,at:Date.now(),changedAt:Date.now(),changeSeq:++changeSeq};
     sessions.set(id,{...cur,state:'working'});
    }
    emit();
   }
  }catch{}
 }
 function handle(ev){
  const type=ev?.type||'',data=ev?.data||{},dir=ev?.location?.directory||'';
  const id=data.sessionID||data.form?.sessionID||'';
  const name=dir?path.basename(dir):'';
  if(type==='session.created'){
   const info=data.info||{},newID=info.id||id;
   if(!newID)return;
   const newDir=info.directory||info.location?.directory||dir,prev=sessions.get(newID);
   update(newID,{state:prev?.state||'idle',directory:newDir,name:newDir?path.basename(newDir):prev?.name||'',title:info.title||prev?.title||''});
   return;
  }
  if(type==='session.renamed'&&id){update(id,{title:data.title||''});return;}

  // 活动事件：说明这个会话还在跑，取消挂起的「结束」判定。
  if(ACTIVE.has(type)&&id){
   cancelIdle(id);
   const cur=sessions.get(id);
   if(type==='session.inbox.enqueued'){
    const text=(data.item?.payload?.text||'').replace(/\s+/g,' ').trim();
    update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name,title:text.slice(0,60),prompt:text.slice(0,120),bump:true});
   }else if(!cur||cur.state!=='working'){
    if(!cur||cur.state!=='waiting')update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name});
   }
   return;
  }

  if(type.startsWith('session.execution.')){
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
   if(st==='busy'||st==='retry'){cancelIdle(id);update(id,{state:'working',directory:dir||cur?.directory||'',name:cur?.name||name});}
   else if(st==='idle')settle(id,{state:'idle',directory:dir||cur?.directory||'',name:cur?.name||name},'done',1200);
   return;
  }
  if(type==='session.idle'&&id){settle(id,{state:'idle'},'done',1200);return;}

  if(type==='form.created'&&data.form){
   const f=data.form,question=f.fields?.[0];
   cancelIdle(f.sessionID);
   const s=update(f.sessionID,{state:'waiting',directory:dir,name,detail:question?.title||f.title||'需要你回答'});
   remind('question','需要你回答',(s?.name||'')+(question?.title?' · '+question.title:''));
   return;
  }
  if((type==='form.replied'||type==='form.cancelled')&&id){cancelIdle(id);update(id,{state:'working',detail:''});return;}
  if((type==='permission.asked'||type==='permission.v2.asked')&&id){
   cancelIdle(id);
   const s=update(id,{state:'waiting',directory:dir,name,detail:'等待权限确认'});
   remind('question','等待权限确认',s?.name||id);
  }
 }
 // 长连接事件流：断线后重连；OpenCode 没在跑时安静等待。
 async function connect(){
  if(closed)return;
  const service=await openService();
  if(!service){connected=false;emit();retryTimer=setTimeout(connect,5000);return;}
  controller=new AbortController();
  try{
   const res=await fetch(new URL('/api/event',service.origin),{headers:{...service.headers,accept:'text/event-stream'},signal:controller.signal});
   if(!res.ok)throw Error('OpenCode 事件流返回 '+res.status);
   connected=true;emit();void hydrate(service);
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
  }catch(e){if(!closed&&e.name!=='AbortError')connected=false,emit();}
  if(closed)return;
  connected=false;emit();
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
  stop(){closed=true;clearTimeout(retryTimer);controller?.abort();for(const timer of idleTimers.values())clearTimeout(timer);idleTimers.clear();listeners.clear();},
 };
}
