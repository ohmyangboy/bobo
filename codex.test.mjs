import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createCodex} from './codex.mjs';
// Codex 会话：从 ~/.codex/sessions 的 rollout 文件推导状态（task_started / task_complete / turn_aborted），
// 结束 / 终止挂起一秒多再提醒，且有新活动时撤销；结束未查看的会话列给 server.mjs 去轮询 Otty。
test('Codex 会话：从 rollout 推导状态、挂起提醒与已查看',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-codex-'));
 const pad=n=>String(n).padStart(2,'0'),now=new Date();
 const dir=path.join(home,'.codex','sessions',String(now.getFullYear()),pad(now.getMonth()+1),pad(now.getDate()));
 await fs.mkdir(dir,{recursive:true});
 const sid='01a0ad32-fb86-7a43-a881-c021410576ca',file=path.join(dir,'rollout-2026-09-17T10-29-54-'+sid+'.jsonl');
 const meta={timestamp:new Date().toISOString(),type:'session_meta',payload:{session_id:sid,id:sid,cwd:'/tmp/proj'}};
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
  assert.equal(s.acked,false);
  assert.ok(s.order>0,'会话应带排序键');
  // 结束：挂起确认后落定 idle 并提醒一次。
  await write([meta,ev('task_started'),ev('task_complete')]);
  assert.ok(await until(()=>sessions()[0].state==='idle'),'没有进入已结束：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.length===1),'没有「运行结束」提醒');
  assert.deepEqual(reminders[0].slice(0,2),['done','运行结束']);
  // 结束且未查看的会话交给 server.mjs；看过（Otty 命中）后清空。
  assert.deepEqual(client.unviewed().map(x=>x.id),['codex:'+sid]);
  assert.equal(client.acknowledge('codex:'+sid),true);
  assert.equal(sessions()[0].acked,true);
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('codex:'+sid),false);
  // 新 prompt 重新进入运行中，并重新变成未查看。
  await write([meta,ev('task_started'),ev('task_complete'),ev('task_started')]);
  assert.ok(await until(()=>sessions()[0].state==='working'),'没有重新进入运行中：'+sessions()[0].state);
  assert.equal(sessions()[0].acked,false);
  // 终止：挂起后提醒 error。
  await write([meta,ev('task_started'),ev('turn_aborted')]);
  assert.ok(await until(()=>sessions()[0].state==='error'),'没有进入已终止：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.some(r=>r[0]==='error')),'没有「运行终止」提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
