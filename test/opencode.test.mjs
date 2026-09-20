import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createOpenCode} from '../src/opencode.mjs';
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
  assert.ok(!sessions().some(s=>s.id==='s2'),'已看过的结束会话应从列表收起');
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('s2'),false);
  assert.equal(client.acknowledge('不存在'),false);
  // 状态再变（新 prompt）会重新变成未查看，并把会话顶到最前；已收起的结束会话不会回来。
  push(inbox('s3','继续跑'));
  assert.ok(await until(()=>ids()==='s3,s1'),'新 prompt 没有顶到最前：'+ids());
  assert.equal(sessions().find(s=>s.id==='s3').acked,false);
  assert.ok(!sessions().some(s=>s.id==='s2'),'看过的结束会话不该再出现');
  // 内部排序字段不对外输出。
  for(const s of sessions())assert.ok(!('changedAt' in s)&&!('changeSeq' in s),'内部排序字段不该出现在快照里');
  assert.ok(calls>=3,'连接后应读取会话列表与活跃会话');
 }finally{
  client?.stop();await new Promise(r=>service.close(r));await fs.rm(home,{recursive:true,force:true});
 }
});
// 权限询问先挂起：auto 模式自动批准（permission.replied）不留「等你回答」也不提醒；
// 真在等你回答才落定成「等待权限确认」并提醒，在终端里回复后立刻恢复「运行中」。
test('权限询问被自动通过后同步回运行中，真等待才提醒',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-opencode-ask-'));let stream=null;
 const service=http.createServer((req,res)=>{
  if(req.url.startsWith('/api/session/active')){res.setHeader('Content-Type','application/json');return res.end('{"data":{}}');}
  if(req.url.startsWith('/api/session?')){res.setHeader('Content-Type','application/json');return res.end('{"data":[]}');}
  if(req.url==='/api/event'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': ok\n\n');stream=res;return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const push=ev=>stream.write('data: '+JSON.stringify(ev)+'\n\n');
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,10));}return fn();};
 const sessions=()=>client.snapshot().sessions,state=id=>sessions().find(s=>s.id===id)?.state;
 let client;
 try{
  await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
  await fs.writeFile(path.join(home,'.bobo/opencode.json'),'{"notify":true,"sound":false}');
  await fs.mkdir(path.join(home,'.local/state/opencode'),{recursive:true});
  await fs.writeFile(path.join(home,'.local/state/opencode/service.json'),JSON.stringify({url:'http://127.0.0.1:'+service.address().port,password:'test'}));
  client=createOpenCode({home});
  client.start();
  assert.ok(await until(()=>client.snapshot().connected&&stream),'事件流没有连上');
  // auto 模式：询问后立刻自动批准，不该留下等待状态，也不该提醒。
  push({type:'session.inbox.enqueued',data:{sessionID:'s1',item:{payload:{text:'跑一下测试'}}},location:{directory:'/tmp/s1'}});
  assert.ok(await until(()=>state('s1')==='working'),'会话没有开始');
  push({type:'permission.asked',data:{id:'per_1',sessionID:'s1',action:'shell',resources:['git push']},location:{directory:'/tmp/s1'}});
  push({type:'permission.replied',data:{sessionID:'s1',requestID:'per_1',reply:'always'},location:{directory:'/tmp/s1'}});
  await new Promise(r=>setTimeout(r,1100));
  assert.equal(state('s1'),'working','自动批准不该留下等待状态');
  assert.equal(client.snapshot().notice,null,'自动批准不该提醒');
  // 挂起期间会话又跑起来了（例如用户在终端里插话）：没有真的停在权限上，不落定等待。
  push({type:'permission.asked',data:{id:'per_3',sessionID:'s3',action:'shell',resources:['ls']},location:{directory:'/tmp/s3'}});
  push({type:'session.inbox.enqueued',data:{sessionID:'s3',item:{payload:{text:'继续'}}},location:{directory:'/tmp/s3'}});
  await new Promise(r=>setTimeout(r,1100));
  assert.equal(state('s3'),'working','挂起期间继续跑就不该落定成等待');
  assert.equal(client.snapshot().notice,null,'插话取消挂起后不该提醒');
  // 真在等你回答：先挂起、到点落定成「等待权限确认」并提醒一次。
  push({type:'permission.asked',data:{id:'per_2',sessionID:'s2',action:'shell',resources:['rm -rf /tmp/x']},location:{directory:'/tmp/s2'}});
  assert.notEqual(state('s2'),'waiting','挂起期间不该提前显示等待');
  assert.ok(await until(()=>state('s2')==='waiting'),'没人回答时应落定成等待');
  assert.equal(sessions().find(s=>s.id==='s2').detail,'等待权限确认');
  assert.equal(client.snapshot().notice?.kind,'question');
  // 在终端里回复（允许 / 拒绝）后立刻恢复「运行中」，内部标记不对外输出。
  push({type:'permission.replied',data:{sessionID:'s2',requestID:'per_2',reply:'once'},location:{directory:'/tmp/s2'}});
  assert.ok(await until(()=>state('s2')==='working'),'回复后应同步回运行中');
  assert.ok(!('ask' in sessions().find(s=>s.id==='s2')),'内部标记不该出现在快照里');
 }finally{
  client?.stop();await new Promise(r=>service.close(r));await fs.rm(home,{recursive:true,force:true});
 }
});
// 子 agent（task 工具派生的子会话）不上面板：会话列表里的 parentID、session.created 的 parentID
// 都要认出来，认出来之后这个 id 的事件一律忽略——列表里已有、跑在活跃表里、后创建的三条路径都覆盖。
test('子 agent 的子会话不上面板',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-opencode-child-'));let stream=null;
 const service=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/api/session/active'))return res.end(JSON.stringify({data:{root1:{type:'running'},child1:{type:'running'},child2:{type:'running'}}}));
  if(req.url==='/api/session/child2')return res.end(JSON.stringify({data:{id:'child2',parentID:'root1'}}));
  if(req.url.startsWith('/api/session/'))return res.end(JSON.stringify({data:{}}));
  if(req.url.startsWith('/api/session?'))return res.end(JSON.stringify({data:[
   {id:'root1',title:'主会话',agent:'build',location:{directory:'/tmp/root1'},time:{created:1700000000000,updated:Date.now()}},
   {id:'child1',parentID:'root1',title:'调查一下',agent:'explore',location:{directory:'/tmp/root1'},time:{updated:Date.now()}},
  ]}));
  if(req.url==='/api/event'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': ok\n\n');stream=res;return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const push=ev=>stream.write('data: '+JSON.stringify(ev)+'\n\n');
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
  // 列表里的子会话（child1）与活跃表里、列表外的子会话（child2）都要挡住；主会话 root1 照常出现在运行中。
  assert.ok(await until(()=>ids()==='root1'),'只有主会话该出现：'+ids());
  assert.equal(state('root1'),'working');
  // 计时：开始时间取会话的 time.created（不是最后活动时间），会话行据此显示「已开多久」。
  assert.equal(sessions()[0].startedAt,1700000000000);
  // 之后新建的子会话：session.created 带 parentID，后续活动事件不能把它又建出来。
  push({type:'session.created',data:{sessionID:'child3',parentID:'root1',location:{directory:'/tmp/root1'}}});
  push({type:'session.inbox.enqueued',data:{sessionID:'child3',item:{payload:{text:'跑个子任务'}}},location:{directory:'/tmp/root1'}});
  push({type:'session.execution.succeeded',data:{sessionID:'child3'},location:{directory:'/tmp/root1'}});
  // 已知子会话的事件尾巴（改名、工具调用、提问）同样不能把它带回来。
  push({type:'session.renamed',data:{sessionID:'child1',title:'改个名'}});
  push({type:'session.tool.called',data:{sessionID:'child1'}});
  push({type:'form.created',data:{form:{sessionID:'child1',fields:[{title:'要部署吗'}]}},location:{directory:'/tmp/root1'}});
  await new Promise(r=>setTimeout(r,200));
  assert.equal(ids(),'root1','子会话不该出现在面板上：'+ids());
  // 新的主会话照常收录，并且排在最上面；session.created 里的 time.created 也要记成开始时间。
  push({type:'session.created',data:{sessionID:'root2',info:{id:'root2',directory:'/tmp/root2',time:{created:1700000000001}}}});
  push({type:'session.inbox.enqueued',data:{sessionID:'root2',item:{payload:{text:'新任务'}}},location:{directory:'/tmp/root2'}});
  assert.ok(await until(()=>ids()==='root2,root1'),'新主会话没有出现：'+ids());
  assert.equal(sessions().find(s=>s.id==='root2').startedAt,1700000000001);
  // 后续活动事件只更新状态，不把计时重置。
  push({type:'session.step.started',data:{sessionID:'root2'}});
  await new Promise(r=>setTimeout(r,120));
  assert.equal(sessions().find(s=>s.id==='root2').startedAt,1700000000001,'活动事件不该重置计时');
 }finally{
  client?.stop();await new Promise(r=>service.close(r));await fs.rm(home,{recursive:true,force:true});
 }
});
