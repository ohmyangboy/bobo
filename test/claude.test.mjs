import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createClaude,parseTitle} from '../src/claude.mjs';
// Claude Code 会话：实时状态来自 ~/.claude/sessions/<pid>.json（status = idle / busy / waiting），
// 标题与 cwd 来自 ~/.claude/projects 的会话日志（ai-title / last-prompt）；进程退出即算结束 / 终止。
test('claude：从会话日志尾部取标题',()=>{
 const line=o=>JSON.stringify(o);
 assert.deepEqual(parseTitle([line({type:'last-prompt',lastPrompt:'  修  个 bug '}),line({type:'ai-title',aiTitle:'修复登录'})]),{title:'修复登录',prompt:'修 个 bug'});
 assert.deepEqual(parseTitle([line({type:'last-prompt',lastPrompt:'帮我看看'}),line({type:'user'})]),{title:'',prompt:'帮我看看'});
 assert.deepEqual(parseTitle(['坏行',line({type:'ai-title',aiTitle:'  '})]),{title:'',prompt:''});
 assert.deepEqual(parseTitle([]),{title:'',prompt:''});
});
test('claude 会话：实时状态、等你回答、退出落定与已查看',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-claude-'));
 const sessionsDir=path.join(home,'.claude','sessions'),projDir=path.join(home,'.claude','projects','-tmp-proj');
 await fs.mkdir(sessionsDir,{recursive:true});await fs.mkdir(projDir,{recursive:true});
 const sid='01a0b43b-0000-7000-8000-0000000000ff',pid=process.pid;
 const regFile=path.join(sessionsDir,pid+'.json'),logFile=path.join(projDir,sid+'.jsonl');
 // pid 用测试进程自己：注册表的存活检查要求进程真的在。开始时间也记在注册表里（startedAt）。
 const registryStartedAt=Date.now()-120000;
 const reg=(status,extra={})=>fs.writeFile(regFile,JSON.stringify({pid,sessionId:sid,cwd:'/tmp/proj',kind:'interactive',entrypoint:'cli',name:'proj-8a',status,startedAt:registryStartedAt,statusUpdatedAt:Date.now(),updatedAt:Date.now(),...extra}));
 const log=lines=>fs.writeFile(logFile,lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
 const baseLog=[{type:'user',message:{role:'user',content:'修个 bug'},cwd:'/tmp/proj',sessionId:sid,timestamp:new Date().toISOString()},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'好了'}],stop_reason:'end_turn'},cwd:'/tmp/proj',sessionId:sid},
  {type:'ai-title',aiTitle:'修复登录',sessionId:sid}];
 await reg('busy');await log(baseLog);
 const reminders=[];
 const client=createClaude({home,remind:(kind,title,message)=>reminders.push([kind,title,message]),interval:40});
 client.start();
 const until=async(fn,ms=2500)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,20));}return fn();};
 const sessions=()=>client.snapshot().sessions;
 try{
  assert.ok(await until(()=>sessions().length===1),'没有发现 Claude Code 会话');
  let s=sessions()[0];
  assert.equal(s.id,'claude:'+sid);
  assert.equal(s.state,'working');
  assert.equal(s.title,'修复登录');
  assert.equal(s.directory,'/tmp/proj');
  assert.equal(s.source,'claude');
  assert.equal(s.acked,false);
  assert.equal(s.startedAt,registryStartedAt,'开始时间应取注册表的 startedAt');
  assert.ok(s.order>0,'会话应带排序键');
  // 等你回答：status=waiting + waitingFor，挂起 0.8 秒后提醒一次。
  await reg('waiting',{waitingFor:'permission prompt'});
  assert.ok(await until(()=>sessions()[0].state==='waiting'),'没有进入等你回答：'+sessions()[0].state);
  assert.equal(sessions()[0].detail,'等待权限确认');
  assert.ok(await until(()=>reminders.some(r=>r[0]==='question')),'没有「需要你回答」提醒');
  // 回答后回到运行中，再正常结束：提醒「运行结束」。
  await reg('busy');
  assert.ok(await until(()=>sessions()[0].state==='working'),'没有回到运行中');
  await reg('idle');
  assert.ok(await until(()=>sessions()[0].state==='idle'),'没有进入已结束：'+sessions()[0].state);
  assert.ok(await until(()=>reminders.some(r=>r[0]==='done')),'没有「运行结束」提醒');
  // 结束且未查看的会话交给 server.mjs；看过（终端命中或点击）后从列表收起。
  assert.deepEqual(client.unviewed().map(x=>x.id),['claude:'+sid]);
  assert.equal(client.acknowledge('claude:'+sid),true);
  assert.equal(sessions().length,0,'已看过的结束会话应从列表收起');
  assert.deepEqual(client.unviewed(),[]);
  assert.equal(client.acknowledge('claude:'+sid),false);
  // 新 prompt 重新进入运行中，会话重新出现。
  await reg('busy');
  assert.ok(await until(()=>sessions()[0]?.state==='working'),'没有重新进入运行中：'+(sessions()[0]?.state));
  assert.equal(sessions()[0].acked,false);
  // 运行中直接退出（注册表消失）= 被中断：落定成已终止并提醒。
  await fs.rm(regFile);
  assert.ok(await until(()=>sessions()[0]?.state==='error'),'没有进入已终止：'+(sessions()[0]?.state));
  assert.ok(await until(()=>reminders.some(r=>r[0]==='error')),'没有「运行终止」提醒');
 }finally{client.stop();await fs.rm(home,{recursive:true,force:true});}
});
