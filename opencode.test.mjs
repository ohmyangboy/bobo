import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createOpenCode} from './opencode.mjs';
// 通知岛排序：会话按「最近一次状态变更」倒序，任何状态变更都顶到最前，工具调用等活动事件不重排；
// 结束 / 终止的会话带 acked=false，用户在终端看过（acknowledge）才置位。
test('会话列表按最近状态变更排序，活动事件不重排',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-opencode-'));let stream=null,calls=0;
 const service=http.createServer((req,res)=>{
  calls++;
  if(req.url.startsWith('/api/session/active')){res.setHeader('Content-Type','application/json');return res.end('{"data":{}}');}
  if(req.url.startsWith('/api/session?')){res.setHeader('Content-Type','application/json');return res.end('{"data":[]}');}
  if(req.url==='/api/event'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': ok\n\n');stream=res;return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const push=ev=>stream.write('data: '+JSON.stringify(ev)+'\n\n');
 const inbox=(id,text)=>({type:'session.inbox.enqueued',data:{sessionID:id,item:{payload:{text}}},location:{directory:'/tmp/'+id}});
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return fn();};
 const sessions=()=>client.snapshot().sessions,ids=()=>sessions().map(s=>s.id).join(),state=id=>sessions().find(s=>s.id===id)?.state;
 let client;
 try{
  await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
  await fs.writeFile(path.join(home,'.bobo/opencode.json'),'{"notify":false,"sound":false}');
  await fs.mkdir(path.join(home,'.local/state/opencode'),{recursive:true});
  await fs.writeFile(path.join(home,'.local/state/opencode/service.json'),JSON.stringify({url:'http://127.0.0.1:'+service.address().port,password:'test'}));
  client=createOpenCode({home});
  client.start();
  assert.ok(await until(()=>client.snapshot().connected&&stream),'事件流没有连上');
  // 按顺序发 1、2、3：最新开始的最上面。
  push(inbox('s1','任务一'));push(inbox('s2','任务二'));push(inbox('s3','任务三'));
  assert.ok(await until(()=>ids()==='s3,s2,s1'),'最新开始的没有排最上面：'+ids());
  // 工具调用、改名等活动事件不改变顺序。
  push({type:'session.step.started',data:{sessionID:'s1'}});
  push({type:'session.tool.called',data:{sessionID:'s1'}});
  push({type:'session.renamed',data:{sessionID:'s1',title:'改个名'}});
  await new Promise(r=>setTimeout(r,150));
  assert.equal(ids(),'s3,s2,s1','活动事件不该重排');
  // 状态变更（哪怕是「等你回答」）都顶到最前。
  push({type:'form.created',data:{form:{sessionID:'s1',fields:[{title:'要部署吗'}]}},location:{directory:'/tmp/s1'}});
  assert.ok(await until(()=>ids()==='s1,s3,s2'),'等你回答没有顶到最前：'+ids());
  assert.equal(state('s2'),'working');
  // 结束：挂起确认后落定，也要顶到最前，并且是「还没看过」。
  push({type:'session.execution.succeeded',data:{sessionID:'s2'}});
  assert.ok(await until(()=>ids()==='s2,s1,s3',3000),'结束的会话没有顶到最前：'+ids());
  assert.equal(state('s2'),'idle');
  assert.equal(sessions().find(s=>s.id==='s2').acked,false);
  // 还没看过的结束会话列给 server.mjs 轮询 Otty（unviewed 只含结束 / 终止且未查看的）。
  assert.deepEqual(client.unviewed(),[{id:'s2',title:'任务二',directory:'/tmp/s2'}]);
  // 看过终端（点击会话跳 Otty 成功）后才算已查看，重复标记返回 false。
  assert.equal(client.acknowledge('s2'),true);
  assert.equal(sessions().find(s=>s.id==='s2').acked,true);
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('s2'),false);
  assert.equal(client.acknowledge('不存在'),false);
  // 状态再变（新 prompt）会重新变成未查看，并把会话顶到最前。
  push(inbox('s3','继续跑'));
  assert.ok(await until(()=>ids()==='s3,s2,s1'),'新 prompt 没有顶到最前：'+ids());
  assert.equal(sessions().find(s=>s.id==='s3').acked,false);
  assert.equal(sessions().find(s=>s.id==='s2').acked,true,'顺序变化不该丢掉已查看标记');
  // 内部排序字段不对外输出。
  for(const s of sessions())assert.ok(!('changedAt' in s)&&!('changeSeq' in s),'内部排序字段不该出现在快照里');
  assert.ok(calls>=3,'连接后应读取会话列表与活跃会话');
 }finally{
  client?.stop();await new Promise(r=>service.close(r));await fs.rm(home,{recursive:true,force:true});
 }
});
