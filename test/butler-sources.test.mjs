import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createButlerSources,createProjectResolver,cleanExcerpt,parseCodexWork,parseDshWork} from '../src/butler-sources.mjs';
const execute=promisify(execFile),now=Date.now(),iso=offset=>new Date(now+offset).toISOString();
const writeLog=async(file,rows)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};
test('Codex 标题从会话索引补齐；日志不变时改名仍更新，已保留旧消息也能按原会话查名',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-work-titles-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const root=path.join(home,'custom-codex'),cwd=path.join(home,'bobo'),index=path.join(root,'session_index.jsonl');
 await fs.mkdir(cwd);
 await writeLog(path.join(root,'sessions/2026/10/10/rollout-one.jsonl'),[
  {type:'session_meta',payload:{session_id:'one',cwd}},
  {type:'event_msg',timestamp:iso(-10),payload:{type:'task_complete',turn_id:'done',last_agent_message:'已实现并更新本机 bobo。'}}
 ]);
 await writeLog(index,[{id:'one',thread_name:'实现 bobo 管家任务摘要'},{id:'old',thread_name:'修复退出全屏后通知栏异常'}]);
 const sources=createButlerSources({home,env:{CODEX_HOME:root},now:()=>now});
 const first=(await sources.scan()).observations[0];assert.equal(first.title,'实现 bobo 管家任务摘要');
 assert.equal((await sources.resolveTarget({source:'codex',sessionId:'old',title:''})).title,'修复退出全屏后通知栏异常');
 await writeLog(index,[{id:'one',thread_name:'继续完善 bobo 管家便捷回复的新标题'}]);
 const next=(await sources.scan()).observations[0];assert.equal(next.title,'继续完善 bobo 管家便捷回复的新标题');assert.equal(next.id,first.id);assert.equal(next.reply,first.reply);
 assert.deepEqual(await sources.resolveTarget({source:'claude',sessionId:'one',title:'Claude 原标题'}),{source:'claude',sessionId:'one',title:'Claude 原标题'});
});
test('六家只读摘录：历史续聊、过滤工具与子代理、分页、半写入恢复',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-work-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const cwd=path.join(home,'project');await fs.mkdir(cwd);
 const codex=path.join(home,'.codex/sessions/2020/01/01/rollout-old.jsonl');
 const meta={type:'session_meta',payload:{session_id:'codex-one',cwd}};
 const event=(type,extra={},offset=0)=>({type:'event_msg',timestamp:iso(offset),payload:{type,...extra}});
 const codexRows=[meta,event('task_started',{turn_id:'turn-a'},-200),event('user_message',{message:'<INSTRUCTIONS>不该发送的规则</INSTRUCTIONS>修复导出'},-150),{type:'response_item',timestamp:iso(-100),payload:{type:'function_call_output',output:'秘密工具日志'}},event('task_complete',{turn_id:'turn-a',last_agent_message:'构建通过，仍待真机验证'},-50)];
 await writeLog(codex,codexRows);
 await writeLog(path.join(home,'.codex/sessions/2026/10/10/rollout-child.jsonl'),[{...meta,payload:{...meta.payload,session_id:'child',source:{subagent:{parent_thread_id:'p'}}}},event('task_complete',{last_agent_message:'子任务'})]);
 await writeLog(path.join(home,'.claude/projects/proj/claude-one.jsonl'),[{type:'queue-operation',sessionId:'claude-one'},{type:'file-history-snapshot'}, {type:'user',uuid:'u1',sessionId:'claude-one',cwd,timestamp:iso(-80),message:{role:'user',content:'调整布局'}},{type:'assistant',timestamp:iso(-40),message:{role:'assistant',content:[{type:'text',text:'布局已调整'},{type:'tool_use',name:'read'}],stop_reason:'tool_use'}},{type:'assistant',timestamp:iso(-20),message:{role:'assistant',content:[{type:'text',text:'布局完成，等待验收'}],stop_reason:'end_turn'}}]);
 await writeLog(path.join(home,'.claude/projects/proj/subagents/agent-child.jsonl'),[{type:'user',sessionId:'child',cwd,message:{role:'user',content:'子代理'}}]);
 // omp 标题槽和元数据必须从文件头拿；长工具输出把它们挤出尾部窗口。
 await writeLog(path.join(home,'.omp/agent/sessions/proj/omp-one.jsonl'),[{type:'title',title:'修复登录'},{type:'session',id:'omp-one',cwd},{type:'message',id:'user-omp',timestamp:iso(-90),message:{role:'user',content:'修复登录'}},{type:'message',message:{role:'toolResult',content:'工具输出'.repeat(80000)}},{type:'message',id:'final-omp',timestamp:iso(-10),message:{role:'assistant',content:[{type:'text',text:'登录已修复'}]}}]);
 const dsh=path.join(home,'.dsh/storages/session_projcache/sessions/session-dsh-one.json');await fs.mkdir(path.dirname(dsh),{recursive:true});
 const projection={record:{identity:{cwd},rows:{title:{val:'修复同步'},turnBoundary:{val:{openTurnStartSeq:null}},turnOutline:{val:{turns:[{turn:1,prompt:'修复同步',response:'同步完成'}]}}}}};
 await fs.writeFile(dsh,JSON.stringify(projection));
 await writeLog(path.join(home,'.gemini/antigravity-cli/brain/agy-one/.system_generated/logs/transcript.jsonl'),[{type:'USER_INPUT',step_index:1,created_at:iso(-100),content:'添加导入'},{type:'GENERIC',content:'不得上传的工具输出'},{type:'PLANNER_RESPONSE',step_index:2,created_at:iso(-30),content:'导入完成'}]);
 let agyStatus='CASCADE_RUN_STATUS_RUNNING',requests=[];
 const row=()=>({conversation_id:'agy-one',workspace_uris:JSON.stringify(['file://'+cwd]),title:'导入',last_modified_time:now,status:agyStatus});
 const service=path.join(home,'.local/state/opencode/service.json');await fs.mkdir(path.dirname(service),{recursive:true});await fs.writeFile(service,JSON.stringify({url:'http://127.0.0.1:12345',password:'test-secret'}));
 const fetchImpl=async(url,options)=>{
  requests.push(String(url));assert.match(options.headers.authorization,/^Basic /);
  if(url.pathname==='/api/session')return {ok:true,json:async()=>url.searchParams.has('cursor')?{data:[{id:'oc-one',title:'缓存',location:{directory:cwd},time:{updated:now}}],cursor:{next:null}}:{data:[{id:'old',time:{updated:now-10*86400000}}],cursor:{next:'page-two'}}};
  return {ok:true,json:async()=>({data:[{id:'oc-u',type:'user',text:'优化缓存',time:{created:now-100}},{id:'oc-a',type:'assistant',content:[{type:'text',text:'缓存完成'}],time:{created:now-50,completed:now-10},finish:'stop'}],cursor:{next:null}})};
 };
 const sources=createButlerSources({home,now:()=>now,fetchImpl,readAgyRows:async()=>[row(),{...row(),conversation_id:'agy-child',parent_conversation_id:'parent'}]});
 let result=await sources.scan();assert.deepEqual(result.errors,{});
 assert.deepEqual(new Set(result.observations.map(o=>o.source)),new Set(['codex','claude','omp','dsh','agy','opencode']));
 assert.equal(result.observations.find(o=>o.source==='agy').status,'working');
 agyStatus='CASCADE_RUN_STATUS_IDLE';result=await sources.scan();assert.equal(result.observations.find(o=>o.source==='agy').status,'complete','库状态变化且 transcript 不变也应收尾');
 const json=JSON.stringify(result.observations);assert.doesNotMatch(json,/不该发送|秘密工具|不得上传|test-secret|子任务|子代理/);
 const first=result.observations.find(o=>o.source==='codex');assert.equal(first.prompt,'修复导出');assert.equal(first.reply,'构建通过，仍待真机验证');assert.equal(first.status,'complete');
 assert.ok(requests.some(url=>url.includes('cursor=page-two')),'不能因第一页都是旧会话而漏掉后页续聊');
 assert.ok(result.observations.find(o=>o.source==='omp')?.reply.includes('登录已修复'));
 await fs.writeFile(dsh,'{"record":');result=await sources.scan();assert.ok(result.errors.dsh);
 await fs.writeFile(dsh,JSON.stringify(projection));result=await sources.scan();assert.ok(result.observations.some(o=>o.source==='dsh'));
 await fs.appendFile(codex,JSON.stringify(event('task_started',{turn_id:'turn-b'},1))+'\n'+JSON.stringify(event('user_message',{message:'继续真机验证'},2))+'\n'+JSON.stringify(event('task_complete',{turn_id:'turn-b',last_agent_message:'真机验证通过'},3)).slice(0,-5));
 result=await sources.scan();assert.equal(result.observations.filter(o=>o.source==='codex'&&o.status==='complete').length,1);
 await fs.appendFile(codex,JSON.stringify(event('task_complete',{turn_id:'turn-b',last_agent_message:'真机验证通过'},3)).slice(-5)+'\n');
 result=await sources.scan();assert.equal(result.observations.filter(o=>o.source==='codex'&&o.status==='complete').length,2);
});
test('同一仓库子目录与 worktree 合并，不同目录同名项目保持独立',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-project-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const repo=path.join(home,'demo'),worktree=path.join(home,'demo-worktree');await fs.mkdir(repo);await fs.mkdir(path.join(repo,'src'));
 await execute('git',['init',repo]);await fs.writeFile(path.join(repo,'one.txt'),'fixture');await execute('git',['-C',repo,'add','one.txt']);await execute('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture']);await execute('git',['-C',repo,'worktree','add','-b','test-worktree',worktree]);
 const resolve=createProjectResolver();const main=await resolve(repo);assert.equal((await resolve(path.join(repo,'src'))).id,main.id);assert.equal((await resolve(worktree)).id,main.id);assert.equal((await resolve(worktree)).name,'demo');
 const other=path.join(home,'other/demo');await fs.mkdir(other,{recursive:true});assert.notEqual((await resolve(other)).id,main.id);assert.equal(await resolve('relative'),null);
});
test('摘录清理和终止：不发送代码凭据，不把一轮中断写成完成',()=>{
 assert.doesNotMatch(cleanExcerpt('结论\n```swift\nlet secret = 1\n```\nBearer abcdefghijklmnop'),/secret|abcdefghijklmnop/);
 assert.doesNotMatch(cleanExcerpt('结论\n```swift\nlet secret = 1'),/secret/);
 const rows=parseCodexWork([{type:'event_msg',timestamp:iso(0),payload:{type:'user_message',message:'修复'}},{type:'event_msg',timestamp:iso(1),payload:{type:'turn_aborted'}}],{payload:{session_id:'s',cwd:'/tmp/p'}},now);assert.equal(rows[0].status,'interrupted');
 assert.equal(parseDshWork({record:{identity:{cwd:'/tmp'},rows:{subagent:{val:{parentSessionId:'parent'}},turnOutline:{val:{turns:[{turn:1,response:'完成'}]}}}}},'c',now).length,0);
 const dsh=parseDshWork({record:{identity:{cwd:'/tmp'},rows:{notification:{val:{last:{reason:'aborted'}}},turnOutline:{val:{turns:Array.from({length:12},(_,turn)=>({turn,prompt:'请求',response:'已有回复'}))}}}}},'c',now);
 assert.equal(dsh.length,8);assert.equal(dsh.at(-1).status,'interrupted');
});
test('Codex 新格式从 response_item 读取请求，与 task 事件合并且不重复计轮',()=>{
 const meta={payload:{session_id:'session',cwd:'/tmp/project'}},event=(type,extra={},offset=0)=>({type:'event_msg',timestamp:iso(offset),payload:{type,...extra}});
 const message=(role,text,offset=0,extra={})=>({type:'response_item',timestamp:iso(offset),payload:{type:'message',role,content:[{type:'input_text',text}],...extra}});
 const rows=parseCodexWork([event('task_started',{turn_id:'one'}),message('user','<INSTRUCTIONS>规则不可发送</INSTRUCTIONS><environment_context>环境不可发送</environment_context>'),message('user','修复导出',1),event('user_message',{message:'修复导出'},2),message('assistant','构建通过，待真机验证',3,{phase:'final'}),event('task_complete',{turn_id:'one',last_agent_message:'构建通过，待真机验证'},4),message('user','继续验证',5),event('task_started',{turn_id:'two'},6),event('task_complete',{turn_id:'two',last_agent_message:'真机验证通过'},7)],meta,now);
 assert.equal(rows.length,2);assert.equal(rows[0].prompt,'修复导出');assert.equal(rows[0].status,'complete');assert.equal(rows[1].prompt,'继续验证');assert.equal(rows[1].reply,'真机验证通过');assert.doesNotMatch(JSON.stringify(rows),/规则不可发送|环境不可发送/);
 const orphan=parseCodexWork([message('user','修复登录'),event('task_complete',{turn_id:'three',last_agent_message:'登录已修复'},1)],meta,now);assert.equal(orphan.length,1);assert.equal(orphan[0].prompt,'修复登录');
 const tail=parseCodexWork([event('task_complete',{turn_id:'four',last_agent_message:'已提交修复'},1)],meta,now);assert.equal(tail[0].reply,'已提交修复');assert.equal(tail[0].status,'complete');
});
