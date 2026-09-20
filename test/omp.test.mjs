import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createOmp,deriveState,stampFromName} from '../src/omp.mjs';
// omp 会话：从 ~/.omp/agent/sessions 的 jsonl 头尾推导状态（正文完成才落盘，尾部 entry 能稳定标出状态）。
// 覆盖：运行中 / 已结束 / 等批准 / ask 等回答 / 已终止，以及挂起提醒、已查看与状态回摆。
test('omp：状态推导的纯函数',()=>{
 const now=Date.now(),line=o=>JSON.stringify(o),msg=(role,extra={})=>({type:'message',timestamp:new Date(now-5000).toISOString(),message:{role,...extra}});
 assert.equal(deriveState([line(msg('user'))],now).state,'working');
 assert.equal(deriveState([line(msg('toolResult'))],now).state,'working');
 assert.equal(deriveState([line(msg('assistant',{content:[{type:'text',text:'好了'}]}))],now).state,'idle');
 assert.equal(deriveState([line(msg('assistant',{content:[{type:'toolCall',name:'bash'}]}))],now).state,'waiting');
 assert.equal(deriveState([line(msg('assistant',{content:[{type:'toolCall',name:'bash'}]}))],now-4000).state,'working','刚写出工具调用还在启动工具');
 assert.equal(deriveState([line({type:'custom',customType:'tool_execution_start',timestamp:new Date(now).toISOString(),data:{toolName:'bash'}})],now).state,'working');
 assert.equal(deriveState([line({type:'custom',customType:'tool_execution_start',timestamp:new Date(now).toISOString(),data:{toolName:'ask'}})],now).state,'waiting');
 assert.equal(deriveState([line({type:'custom',customType:'session_exit',timestamp:new Date(now).toISOString(),data:{kind:'normal'}})],now).state,'idle');
 assert.equal(deriveState([line({type:'custom',customType:'session_exit',timestamp:new Date(now).toISOString(),data:{kind:'signal'}})],now).state,'error');
 // 过程性 entry（todo / 标题变更）不影响判断，会继续往前找。
 assert.equal(deriveState([line({type:'custom',customType:'user_todo_edit',timestamp:new Date(now).toISOString(),data:{}}),line(msg('user'))],now).state,'working');
 assert.equal(deriveState([line(msg('user')),'{坏行'],now).state,'working');
 assert.equal(deriveState([],now).state,null);
 // 文件名里的时间戳（旧版 omp 的 header 可能没有 timestamp）：`2026-09-20T01-02-08-305Z` 转成标准 ISO。
 assert.equal(stampFromName('2026-09-20T01-02-08-305Z_01a0bc55-b3b1-74df-aee7-b0d878ec0e19.jsonl'),Date.parse('2026-09-20T01:02:08.305Z'));
 assert.equal(stampFromName('random.jsonl'),0);
 assert.equal(stampFromName(undefined),0);
});
test('omp：文件闪失或暂时解析不出来时不丢会话',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-omp-miss-'));
 const dir=path.join(home,'.omp','agent','sessions','-tmp-proj');
 await fs.mkdir(dir,{recursive:true});
 const sid='01a0b43b-0000-7000-8000-000000000001',file=path.join(dir,'2026-09-18T11-20-00-000Z_'+sid+'.jsonl');
 const lines=[{type:'title',v:1,title:'任务',source:'auto',updatedAt:new Date().toISOString(),pad:' '.repeat(80)},
  {type:'session',version:3,id:sid,timestamp:new Date().toISOString(),cwd:'/tmp/proj'},
  {type:'message',id:'u',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'跑个长任务'}]}}];
 await fs.writeFile(file,lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
 const client=createOmp({home,agentDir:path.join(home,'.omp','agent'),interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'没有发现 omp 会话');
  // 内容损坏（atomically 重写的中间态）：沿用上一轮状态，会话不消失。
  await fs.writeFile(file,'{"type":"title"');
  await new Promise(r=>setTimeout(r,120));
  assert.equal(sessions().length,1,'文件暂时解析失败时不该丢掉会话');
  assert.equal(sessions()[0].state,'working');
  // 文件被短暂移走：给几轮宽限；持续消失才清掉。
  await fs.rm(file);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(sessions().length,1,'文件闪失几轮内不该丢掉会话');
  assert.ok(await until(()=>sessions().length===0),'文件持续不存在时应清掉会话');
  // snapshot 不该把内部的 miss 计数暴露出去。
  await fs.writeFile(file,lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
  assert.ok(await until(()=>sessions().length===1));
  assert.equal('miss' in sessions()[0],false);
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
test('omp 会话：从会话文件推导状态、挂起提醒与已查看',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-omp-'));
 const dir=path.join(home,'.omp','agent','sessions','-tmp-proj');
 await fs.mkdir(dir,{recursive:true});
 const sid='01a0b420-009c-7278-adfe-bbb4d07e9bc3',file=path.join(dir,'2026-09-18T10-46-31-324Z_'+sid+'.jsonl');
 const stamp=ts=>new Date(ts??Date.now()).toISOString();
 const title=t=>({type:'title',v:1,title:t,source:'auto',updatedAt:stamp(),pad:' '.repeat(80)});
 // 会话开始时间记在 header.timestamp 里（文件名前缀也是同一个时间，仅作旧文件的兜底）。
 const startedIso=stamp(Date.now()-60000);
 const header={type:'session',version:3,id:sid,timestamp:startedIso,cwd:'/tmp/proj',title:''};
 const msg=(role,content,ts)=>({type:'message',id:role,parentId:null,timestamp:stamp(ts),message:{role,content}});
 const custom=(customType,data,ts)=>({type:'custom',customType,data,id:customType,parentId:null,timestamp:stamp(ts)});
 const write=lines=>fs.writeFile(file,lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
 const head=title('修个 bug'),hdr=header;
 await write([head,hdr,msg('user',[{type:'text',text:'修个 bug'}])]);
 const reminders=[];
 const client=createOmp({home,agentDir:path.join(home,'.omp','agent'),remind:(kind,t,m)=>reminders.push([kind,t,m]),interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'没有发现 omp 会话');
  let s=sessions()[0];
  assert.equal(s.id,'omp:'+sid);
  assert.equal(s.state,'working');
  assert.equal(s.title,'修个 bug');
  assert.equal(s.directory,'/tmp/proj');
  assert.equal(s.source,'omp');
  assert.equal(s.acked,false);
  assert.equal(s.startedAt,Date.parse(startedIso),'开始时间应取 header.timestamp');
  assert.ok(s.order>0,'会话应带排序键');
  // 回复收尾（assistant 文本）：挂起确认后落定 idle 并提醒一次。
  await write([head,hdr,msg('user',[{type:'text',text:'修个 bug'}]),msg('assistant',[{type:'text',text:'好了'}])]);
  assert.ok(await until(()=>sessions()[0].state==='idle'),'没有进入已结束：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.length===1),'没有「运行结束」提醒');
  assert.deepEqual(reminders[0].slice(0,2),['done','运行结束']);
  // 结束且未查看的会话交给 server.mjs；看过（终端命中）后清空。
  assert.deepEqual(client.unviewed().map(x=>x.id),['omp:'+sid]);
  assert.equal(client.acknowledge('omp:'+sid),true);
  assert.equal(sessions().length,0,'已看过的结束会话应从列表收起');
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('omp:'+sid),false);
  // 新 prompt 重新进入运行中，会话重新出现并重新变成未查看。
  await write([head,hdr,msg('user',[{type:'text',text:'再改一下'}]),msg('assistant',[{type:'text',text:'好了'}]),msg('user',[{type:'text',text:'再来'}])]);
  assert.ok(await until(()=>sessions()[0]?.state==='working'),'没有重新进入运行中：'+(sessions()[0]?.state));
  assert.equal(sessions()[0].acked,false);
  // 给出工具调用后迟迟没有开始执行：算等你批准；执行开始又回到运行中。
  await write([head,hdr,msg('assistant',[{type:'toolCall',name:'bash'}],Date.now()-5000)]);
  assert.ok(await until(()=>sessions()[0].state==='waiting'),'没有进入等你回答：'+sessions()[0].state);
  await write([head,hdr,msg('assistant',[{type:'toolCall',name:'bash'}],Date.now()-5000),custom('tool_execution_start',{toolName:'bash'})]);
  assert.ok(await until(()=>sessions()[0].state==='working'),'工具开始执行后没有回到运行中：'+sessions()[0].state);
  assert.deepEqual(reminders.map(r=>r[0]),['done'],'等回答 / 运行中不该有结束提醒');
  // ask 工具本身就是在等你回答。
  await write([head,hdr,custom('tool_execution_start',{toolName:'ask'})]);
  assert.ok(await until(()=>sessions()[0].state==='waiting'),'ask 工具没有进入等你回答：'+sessions()[0].state);
  // 退出：kind normal 是正常结束，signal / fatal 算终止。
  await write([head,hdr,msg('assistant',[{type:'text',text:'好了'}]),custom('session_exit',{kind:'signal',reason:'sighup'})]);
  assert.ok(await until(()=>sessions()[0].state==='error'),'没有进入已终止：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.some(r=>r[0]==='error')),'没有「运行终止」提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
