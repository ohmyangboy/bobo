import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createDsh,readProjection} from '../src/dsh.mjs';
// DeepSeek Harness（dsh）会话：状态来自 ~/.dsh/storages/session_projcache/sessions/<会话ID>.json 的投影缓存——
// turnBoundary.openTurnStartSeq / sessionStats.openStep 非空是运行中，notification.last.reason 给出上一轮的结局，
// plan.wanted 非空表示在等你批准计划；标题取 title.val、目录取 identity.cwd。
const proj=(o={})=>({version:7,record:{identity:{formatVersion:3,createdAt:o.createdAt===undefined?1700000000000:o.createdAt,cwd:o.cwd||'/tmp/proj'},rows:{
 title:{ver:1,seq:1,val:o.title===undefined?'修个 bug':o.title},
 turnBoundary:{ver:2,seq:1,val:{openTurnStartSeq:o.open===undefined?null:o.open,lastTurn:1}},
 sessionStats:{ver:1,seq:1,val:{openStep:o.step===undefined?null:o.step,lastTurn:1,pendingCalls:{}}},
 notification:{ver:1,seq:1,val:{openTurn:null,last:o.reason?{turn:1,reason:o.reason,body:'收尾说明'}:null}},
 plan:{ver:3,seq:1,val:{active:false,wanted:o.wanted===undefined?null:o.wanted,running:null}},
 sessionListMetadata:{ver:1,seq:1,val:{blank:false,lastPromptAt:Date.now()}},
 turnOutline:{ver:2,seq:1,val:{turns:[{turn:1,seq:1,prompt:'修个 bug 的原始提问',response:'好了'}]}},
}}});
test('dsh：从投影缓存推导状态',()=>{
 let r=readProjection(proj({open:12}),{mtimeMs:1000});
 assert.equal(r.state,'working');assert.equal(r.title,'修个 bug');assert.equal(r.directory,'/tmp/proj');assert.equal(r.at,1000);
 assert.equal(r.startedAt,1700000000000,'开始时间取 identity.createdAt');
 assert.equal(readProjection(proj({createdAt:0}),{mtimeMs:1000}).startedAt,0,'旧投影没有 createdAt 时为 0');
 assert.equal(readProjection(proj({step:7}),{mtimeMs:1000}).state,'working');
 assert.equal(readProjection(proj({open:12,wanted:{kind:'plan'}}),{mtimeMs:1000}).state,'waiting');
 assert.equal(readProjection(proj({wanted:{kind:'plan'}}),{mtimeMs:1000}).state,'idle','没有跑起来的 turn 就不算等你');
 assert.equal(readProjection(proj({reason:'completed'}),{mtimeMs:1000}).state,'idle');
 assert.equal(readProjection(proj({reason:'aborted'}),{mtimeMs:1000}).state,'error');
 assert.equal(readProjection(proj({reason:'interrupted'}),{mtimeMs:1000}).state,'error');
 assert.equal(readProjection(proj({title:''}),{mtimeMs:1000}).title,'修个 bug 的原始提问','没标题时退回最后一轮 prompt');
 assert.equal(readProjection(undefined,{mtimeMs:5000}).state,'idle');
});
test('dsh 会话：运行中 / 等计划批准 / 结束 / 终止、挂起提醒与已查看',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-dsh-'));
 const dir=path.join(home,'.dsh','storages','session_projcache','sessions');
 await fs.mkdir(dir,{recursive:true});
 const sid='3c1fa191-a1d0-4b66-b3f4-6c46d87c2d5f',file=path.join(dir,'session-'+sid+'.json');
 const write=o=>fs.writeFile(file,JSON.stringify(proj(o)));
 await write({open:12});
 const reminders=[];
 const client=createDsh({home,dshHome:path.join(home,'.dsh'),remind:(kind,title,message)=>reminders.push([kind,title,message]),interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'没有发现 dsh 会话');
  const s=sessions()[0];
  assert.equal(s.id,'dsh:'+sid);
  assert.equal(s.state,'working');
  assert.equal(s.title,'修个 bug');
  assert.equal(s.directory,'/tmp/proj');
  assert.equal(s.source,'dsh');
  assert.equal(s.acked,false);
  assert.equal(s.startedAt,1700000000000);
  assert.ok(s.order>0,'会话应带排序键');
  // 模型请求进入 plan 模式：算「等你回答」，挂起 0.8 秒后提醒。
  await write({open:12,wanted:{kind:'plan'}});
  assert.ok(await until(()=>sessions()[0].state==='waiting'),'没有进入等你回答：'+sessions()[0].state);
  assert.equal(sessions()[0].detail,'等待批准计划');
  assert.ok(await until(()=>reminders.some(r=>r[0]==='question')),'没有「需要你回答」提醒');
  // 批准后继续跑，再正常结束：提醒「运行结束」。
  await write({open:12});
  assert.ok(await until(()=>sessions()[0].state==='working'),'没有回到运行中');
  await write({reason:'completed'});
  assert.ok(await until(()=>sessions()[0].state==='idle'),'没有进入已结束：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.some(r=>r[0]==='done')),'没有「运行结束」提醒');
  // 结束且未查看的会话交给 server.mjs；看过（终端命中或点击）后从列表收起。
  assert.deepEqual(client.unviewed().map(x=>x.id),['dsh:'+sid]);
  assert.equal(client.acknowledge('dsh:'+sid),true);
  assert.equal(sessions().length,0,'已看过的结束会话应从列表收起');
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('dsh:'+sid),false);
  // 新任务重新进入运行中；被中断则落定成已终止并提醒。
  await write({open:13});
  assert.ok(await until(()=>sessions()[0]?.state==='working'),'没有重新进入运行中：'+(sessions()[0]?.state));
  await write({reason:'interrupted'});
  assert.ok(await until(()=>sessions()[0]?.state==='error'),'没有进入已终止：'+(sessions()[0]?.state));
  assert.ok(await until(()=>reminders.some(r=>r[0]==='error')),'没有「运行终止」提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
