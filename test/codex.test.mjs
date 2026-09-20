import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createCodex,isDesktopOrigin} from '../src/codex.mjs';
// Codex 会话：从 ~/.codex/sessions 的 rollout 文件推导状态（task_started / task_complete / turn_aborted），
// 结束 / 终止挂起一秒多再提醒，且有新活动时撤销；结束未查看的会话列给 server.mjs 去轮询 Otty。
test('Codex 会话：从 rollout 推导状态、挂起提醒与已查看',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-codex-'));
 const pad=n=>String(n).padStart(2,'0'),now=new Date();
 const dir=path.join(home,'.codex','sessions',String(now.getFullYear()),pad(now.getMonth()+1),pad(now.getDate()));
 await fs.mkdir(dir,{recursive:true});
 const sid='01a0ad32-fb86-7a43-a881-c021410576ca',file=path.join(dir,'rollout-2026-09-17T10-29-54-'+sid+'.jsonl');
 // 会话开始时间：Codex 写在 session_meta.payload.timestamp 里（外层 timestamp 是写入时刻）。
 const startedIso='2026-09-17T02:29:54.000Z';
 const meta={timestamp:new Date().toISOString(),type:'session_meta',payload:{session_id:sid,id:sid,cwd:'/tmp/proj',timestamp:startedIso}};
 const ev=(type,extra={})=>({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,...extra}});
 const write=lines=>fs.writeFile(file,lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
 await write([meta,ev('task_started'),ev('token_count')]);
 await fs.writeFile(path.join(home,'.codex','session_index.jsonl'),JSON.stringify({id:sid,thread_name:'修个 bug'})+'\n');
 const reminders=[];
 const client=createCodex({home,remind:(kind,title,message)=>reminders.push([kind,title,message]),interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'没有发现 Codex 会话');
  let s=sessions()[0];
  assert.equal(s.id,'codex:'+sid);
  assert.equal(s.state,'working');
  assert.equal(s.title,'修个 bug');
  assert.equal(s.directory,'/tmp/proj');
  assert.equal(s.source,'codex');
  assert.equal(s.app,false);
  assert.equal(s.acked,false);
  assert.equal(s.startedAt,Date.parse(startedIso),'开始时间应取 session_meta 的 timestamp');
  assert.ok(s.order>0,'会话应带排序键');
  // 只改 session_index 里的标题（rollout 文件没动）也要跟上：解析缓存命中不能把这次刷新吞掉，
  // 否则标题会一直停在空值上，点会话也匹配不到终端标签页。
  await fs.writeFile(path.join(home,'.codex','session_index.jsonl'),JSON.stringify({id:sid,thread_name:'改个名字'})+'\n');
  assert.ok(await until(()=>sessions()[0]?.title==='改个名字'),'标题没有跟着 session_index 刷新');
  assert.equal(sessions()[0].state,'working');
  // 结束：挂起确认后落定 idle 并提醒一次。
  await write([meta,ev('task_started'),ev('task_complete')]);
  assert.ok(await until(()=>sessions()[0].state==='idle'),'没有进入已结束：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.length===1),'没有「运行结束」提醒');
  assert.deepEqual(reminders[0].slice(0,2),['done','运行结束']);
  // 结束且未查看的会话交给 server.mjs；看过（Otty 命中）后清空。
  assert.deepEqual(client.unviewed().map(x=>x.id),['codex:'+sid]);
  assert.equal(client.acknowledge('codex:'+sid),true);
  assert.equal(sessions().length,0,'已看过的结束会话应从列表收起');
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('codex:'+sid),false);
  // 新 prompt 重新进入运行中，会话重新出现并重新变成未查看。
  await write([meta,ev('task_started'),ev('task_complete'),ev('task_started')]);
  assert.ok(await until(()=>sessions()[0]?.state==='working'),'没有重新进入运行中：'+(sessions()[0]?.state));
  assert.equal(sessions()[0].acked,false);
  // 终止：挂起后提醒 error。
  await write([meta,ev('task_started'),ev('turn_aborted')]);
  assert.ok(await until(()=>sessions()[0].state==='error'),'没有进入已终止：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.some(r=>r[0]==='error')),'没有「运行终止」提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
// Codex 子 agent：rollout 的 session_meta 里 thread_source=subagent（或 source.subagent），
// 这类文件不上面板，只有父会话自己的线程照常显示——不然一次任务会多出一串重复的 bobo 头像。
test('Codex 子 agent 的 rollout 不上面板',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-codex-child-'));
 const pad=n=>String(n).padStart(2,'0'),now=new Date();
 const dir=path.join(home,'.codex','sessions',String(now.getFullYear()),pad(now.getMonth()+1),pad(now.getDate()));
 await fs.mkdir(dir,{recursive:true});
 const parent='01a0ad32-fb86-7a43-a881-c021410576ca',childA='019f7fac-9668-71f1-b039-3e33bdcf9313',childB='019f7fea-5bd8-7012-80f3-ab87fe079fac';
 const meta=payload=>({timestamp:new Date().toISOString(),type:'session_meta',payload});
 const ev=(type,extra={})=>({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,...extra}});
 const write=(name,lines)=>fs.writeFile(path.join(dir,'rollout-2026-09-17T10-29-54-'+name+'.jsonl'),lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
 await write(parent,[meta({session_id:parent,id:parent,cwd:'/tmp/proj',source:'cli',thread_source:'user'}),ev('task_started')]);
 // 两种子 agent 标记各来一份：source.subagent（带 parent_thread_id）与只有 thread_source。
 await write(childA,[meta({session_id:childA,id:childA,cwd:'/tmp/proj',source:{subagent:{thread_spawn:{parent_thread_id:parent,depth:1}}},thread_source:'subagent'}),ev('task_started')]);
 await write(childB,[meta({session_id:childB,id:childB,cwd:'/tmp/proj',thread_source:'subagent'}),ev('task_started'),ev('task_complete')]);
 // 长元数据把标记推到旧 HEAD 之外；source 的属性顺序也不能影响过滤。
 for(const [i,source] of [{subagent:{},other:true},{other:true,subagent:{}},'subagent'].entries()){
  const id='019f7fea-5bd8-7012-80f3-ab87fe079fa'+i;
  await write(id,[meta({id,cwd:'/tmp/proj',base_instructions:{text:'长'.repeat(40000)},source}),ev('task_started')]);
 }
 const empty='019f7fea-5bd8-7012-80f3-ab87fe079fa9';
 await write(empty,[meta({id:empty,cwd:'/tmp/proj',source:'cli',thread_source:'user'})]);
 const client=createCodex({home,interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'只该出现父会话：'+JSON.stringify(sessions().map(s=>s.id)));
  assert.equal(sessions()[0].id,'codex:'+parent);
  // 子会话继续跑也不该冒出来（它们每轮都被重新扫到）。
  await write(childA,[meta({session_id:childA,id:childA,cwd:'/tmp/proj',source:{subagent:{}},thread_source:'subagent'}),ev('task_started'),ev('token_count')]);
  await new Promise(r=>setTimeout(r,200));
  assert.equal(sessions().length,1,'子 agent 不该被收录：'+JSON.stringify(sessions().map(s=>s.id)));
  assert.deepEqual(client.unviewed(),[]);
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
// Codex app 会话：与 CLI 共用同一份 sessions，靠 session_meta 的 originator / source 区分——
// app 侧写 `Codex Desktop`、`codex_work_desktop` 或 source=vscode / appserver，点会话时跳 `codex://threads/<id>`。
test('Codex app 会话：originator / source 识别，会话带上 app 标记',async()=>{
 assert.equal(isDesktopOrigin({originator:'Codex Desktop',source:'vscode'}),true);
 assert.equal(isDesktopOrigin({originator:'codex_work_desktop'}),true);
 assert.equal(isDesktopOrigin({source:'appserver'}),true);
 assert.equal(isDesktopOrigin({originator:'codex-tui',source:'cli'}),false);
 assert.equal(isDesktopOrigin({originator:'codex_cli_rs',source:'cli'}),false);
 assert.equal(isDesktopOrigin({originator:'codex-tui',source:{subagent:{}}}),false);
 assert.equal(isDesktopOrigin({}),false);
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-codex-app-'));
 const pad=n=>String(n).padStart(2,'0'),now=new Date();
 const dir=path.join(home,'.codex','sessions',String(now.getFullYear()),pad(now.getMonth()+1),pad(now.getDate()));
 await fs.mkdir(dir,{recursive:true});
 const appId='01a07b1a-863c-73c1-ae29-9a929ce3bc57',cliId='01a0bc96-985c-7160-bb79-12f6d5d52d18';
 const meta=payload=>({timestamp:new Date().toISOString(),type:'session_meta',payload});
 const ev=type=>({timestamp:new Date().toISOString(),type:'event_msg',payload:{type}});
 const write=(id,payload)=>fs.writeFile(path.join(dir,'rollout-2026-09-17T10-29-54-'+id+'.jsonl'),[meta(payload),ev('task_started')].map(l=>JSON.stringify(l)).join('\n')+'\n');
 await write(appId,{session_id:appId,id:appId,cwd:'/tmp/app',originator:'Codex Desktop',source:'vscode'});
 await write(cliId,{session_id:cliId,id:cliId,cwd:'/tmp/cli',originator:'codex-tui',source:'cli'});
 const client=createCodex({home,interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===2),'两个会话都该出现：'+JSON.stringify(sessions().map(s=>s.id)));
  assert.equal(sessions().find(s=>s.id==='codex:'+appId)?.app,true);
  assert.equal(sessions().find(s=>s.id==='codex:'+cliId)?.app,false);
  assert.equal(client.appSession('codex:'+appId),true);
  assert.equal(client.appSession('codex:'+cliId),false);
  assert.equal(client.appSession('codex:不存在的会话'),false);
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
