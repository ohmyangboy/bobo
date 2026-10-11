import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createButler,validateBriefs,briefText,compactSentence} from '../src/butler.mjs';

const epoch=Date.now(),observation=(id,at,extra={})=>({id,source:'codex',sessionId:'session-one',directory:'/tmp/project',at,title:'修复导出',prompt:'修复导出',reply:'构建通过，待真机验证',status:'complete',...extra});
async function fixture(t,{initial=[],...options}={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-butler-'));
 const context={home,now:epoch,rows:initial,calls:[],key:true,error:null,response:p=>({id:p.id,summary:p.observations[0].result})};
 const butler=createButler({home,now:()=>context.now,batchMs:100,resolveProject:async directory=>({id:path.basename(directory),name:path.basename(directory),directory}),sources:{scan:async()=>({observations:context.rows,errors:{}})},ai:{status:async()=>({keyAvailable:context.key}),summarizeWork:async({projects})=>{
  context.calls.push(structuredClone(projects));if(context.error)throw context.error;return {projects:await Promise.all(projects.map(p=>context.response(p)))};
 }},...options});
 t.after(async()=>{await butler.stop();await fs.rm(home,{recursive:true,force:true});});
 await butler.load();await butler.saveSettings({enabled:true});await butler.run();
 return {context,butler};
}
test('按需摘要：首次只展示历史摘录；多轮覆盖旧近况，不累计待办',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('history',epoch-1000)]});
 assert.equal(c.calls.length,0);assert.equal(b.snapshot().lead.text,'构建通过，待真机验证。');assert.equal(b.snapshot().lead.summaryAt,0);
 c.now+=150;c.rows.push(observation('new',c.now,{reply:'导出功能已修复，构建通过，待真机验证'}));c.response=p=>({id:p.id,summary:'构建通过，待真机验证。'});await b.run();
 assert.equal(c.calls.length,1);assert.match(b.detail().projects[0].text,/构建通过.*真机验证/);
 const sent=c.calls[0][0];assert.equal(sent.observations.length,1);assert.equal(sent.observations[0].id,'new');assert.equal(sent.previous,undefined);
 await b.run();assert.equal(c.calls.length,1,'没有内容变化不再次调用');
 c.now+=150;c.rows.push(observation('next',c.now,{source:'claude',sessionId:'session-two',reply:'按钮布局已调整'}));
 c.response=p=>({id:p.id,summary:'按钮布局已调整。'});await b.run();
 assert.equal(c.calls.length,2);assert.equal(b.detail().projects.length,1);assert.deepEqual(b.detail().projects[0].facts.pending,[]);assert.doesNotMatch(b.snapshot().lead.text,/构建|真机/);
 const file=path.join(c.home,'.bobo/butler/state.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.version,2);assert.ok(Object.keys(saved.observations).length<=2);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 await b.stop();const restart=createButler({home:c.home,now:()=>c.now,sources:{scan:async()=>({observations:c.rows})},ai:{status:async()=>({keyAvailable:true}),summarizeWork:async()=>{assert.fail('重启不能重复付费');}}});t.after(()=>restart.stop());await restart.run();assert.match(restart.snapshot().lead.text,/按钮布局/);
});
test('消息按进展追加，AI 只修订同一条气泡；历史消息保留原会话归属',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('history',epoch-1000)]});
 const historical=b.snapshot().messages[0];assert.equal(historical.role,'butler');assert.equal(historical.summaryAt,0);
 assert.equal(historical.request,'修复导出');
 c.now+=150;c.rows=[observation('new',c.now,{source:'claude',sessionId:'session-two',title:'调整布局',reply:'布局完成。下一步验证真机。'})];
 c.response=p=>({id:p.id,summary:'布局已调整，待真机验证。'});await b.run();
 const messages=b.snapshot().messages;
 assert.equal(messages.length,2);assert.equal(messages[0].id,historical.id);assert.equal(messages[1].text,'布局已调整，待真机验证。');assert.ok(messages[1].summaryAt);
 assert.equal(b.message(historical.id).sessionId,'session-one');assert.equal(b.message(messages[1].id).sessionId,'session-two');
 assert.deepEqual(b.targets().map(t=>t.id),['claude:session-two','codex:session-one']);
 assert.doesNotMatch(JSON.stringify(messages),/session-one|session-two|directory/);
 assert.equal(c.calls[0][0].observations.length,1);assert.equal(c.calls[0][0].observations[0].id,'new');assert.equal(c.calls[0][0].messages,undefined);
 await b.run();assert.equal(b.snapshot().messages.length,2);assert.equal(c.calls.length,1);
});
test('历史气泡补齐原会话指令，最新轮之前的气泡也映射；不重放历史摘要',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('old',epoch-1000)]});
 const old=b.message(b.snapshot().messages[0].id);
 c.now+=150;c.rows.push(observation('new',c.now,{prompt:'验证新布局',reply:'布局已验证'}));await b.run();await b.stop();
 const file=path.join(c.home,'.bobo/butler/state.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
 delete saved.messages.find(m=>m.id===old.id).request;await fs.writeFile(file,JSON.stringify(saved));
 const restarted=createButler({home:c.home,now:()=>c.now,sources:{scan:async()=>({observations:c.rows})},resolveProject:async()=>({id:'project',name:'project',directory:'/tmp/project'}),ai:{status:async()=>({keyAvailable:true}),summarizeWork:async()=>{assert.fail('补齐指令不能重新调用 AI');}}});
 t.after(()=>restarted.stop());await restarted.run();assert.equal(restarted.message(old.id).request,'修复导出');assert.equal(restarted.snapshot().messages.length,2);
});
test('补齐已存在消息的会话标题，不追加气泡或重新请求 AI',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('history',epoch-1000,{title:''})]});
 const id=b.snapshot().messages[0].id;assert.equal(b.message(id).title,'');
 c.rows[0].title='实现 bobo 管家任务摘要';await b.run();
 assert.equal(b.message(id).title,c.rows[0].title);assert.equal(b.snapshot().messages.length,1);assert.equal(c.calls.length,0);
});
test('历史最多 80 条且仅保留 7 天；重复扫描不补回被淘汰的气泡，关闭后重启也清理',async t=>{
 const {context:c,butler:b}=await fixture(t);c.key=false;
 for(let i=0;i<82;i++){c.now++;c.rows=[observation('round-'+i,c.now,{reply:'本轮完成第 '+i+' 项调整'})];await b.run();}
 const messages=b.snapshot().messages;assert.equal(messages.length,80);assert.match(messages[0].text,/第 2 项/);assert.match(messages.at(-1).text,/第 81 项/);assert.equal(c.calls.length,0);
 const file=path.join(c.home,'.bobo/butler/state.json'),saved=await fs.readFile(file,'utf8');
 await b.run();assert.equal(await fs.readFile(file,'utf8'),saved,'没有新进展不重写或补回旧消息');
 assert.equal(JSON.parse(saved).messages.length,80);assert.ok(Object.keys(JSON.parse(saved).observations).length<=2);
 await b.saveSettings({enabled:false});await b.stop();c.now+=8*86400000;
 const restart=createButler({home:c.home,now:()=>c.now});t.after(()=>restart.stop());await restart.load();
 assert.deepEqual(restart.snapshot().messages,[]);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).messages,[]);
 assert.throws(()=>restart.message(messages[0].id),/过期/);
});
test('回复回执按请求去重，送达不明不自动重发，确定未发送可原样重试',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('history',epoch-1)]});
 const original=b.snapshot().messages[0],target=b.targets()[0],content='请继续处理\n并验证结果。保留这段完整指令。';let attempts=0;
 const input={requestId:'request-success',replyTo:original.id,quote:'构建通过',text:content,target,deliver:async()=>{attempts++;}};
 assert.equal((await b.appendReply(input)).status,'sent');assert.equal((await b.appendReply(input)).status,'sent');assert.equal(attempts,1);
 assert.equal(b.snapshot().messages.at(-1).text,'请继续处理。');assert.equal(b.detail().messages.at(-1).text,content);
 const unknown={...input,requestId:'request-unknown',deliver:async()=>{attempts++;throw Error('连接中断');}};
 const failure=await b.appendReply(unknown);assert.equal(failure.status,'failed');assert.equal(failure.retryable,false);
 await b.appendReply(unknown);assert.equal(attempts,2,'送达不明的请求不能再次执行');
 const retry={...input,requestId:'request-retry',deliver:async()=>{attempts++;throw Object.assign(Error('会话未打开'),{status:409});}};
 assert.equal((await b.appendReply(retry)).retryable,true);
 const permission={...input,requestId:'request-permission',deliver:async()=>{throw Object.assign(Error('Otty 未开启程序输入'),{status:409,action:'enable-otty-input'});}};
 assert.equal((await b.appendReply(permission)).action,'enable-otty-input');
 const enabled=await b.appendReply({...permission,deliver:async()=>{}});
 assert.equal(enabled.status,'sent');assert.equal(enabled.action,undefined);
 await b.appendReply({...permission,deliver:()=>assert.fail('成功后的开启重试不能重复发送')});
 await assert.rejects(()=>b.appendReply({...retry,text:'改变了内容'}),/内容已变化/);
 await assert.rejects(()=>b.appendReply({...retry,attachmentIds:['different-image']}),/内容已变化/);
 assert.equal((await b.appendReply({...retry,deliver:input.deliver})).status,'sent');assert.equal(attempts,4);
 assert.equal(b.detail().messages.filter(m=>m.id==='reply-request-retry').length,1);
 assert.equal(c.calls.length,0,'引用和发送不调用摘要模型');
 await b.stop();const restart=createButler({home:c.home,now:()=>c.now});t.after(()=>restart.stop());await restart.load();
 assert.equal((await restart.appendReply({...input,deliver:()=>assert.fail('重启后不能重复投递')})).status,'sent');
});
test('连续新进展只取每项目最新一轮；多个项目按更新时间展示，流不包含目录',async t=>{
 const {context:c,butler:b}=await fixture(t);
 c.now+=150;c.rows=Array.from({length:12},(_,i)=>observation('turn-'+i,c.now-12+i,{reply:'第 '+i+' 轮进展'}));
 c.rows.push(observation('blog',c.now,{directory:'/tmp/blog',reply:'博客发布完成'}),observation('lives',c.now-5,{directory:'/tmp/lives',reply:'导出问题已修复'}));await b.run();
 assert.equal(c.calls.length,1);assert.equal(c.calls[0].length,3);assert.deepEqual(c.calls[0].find(p=>p.id==='project').observations.map(o=>o.id),['turn-11']);
 const snapshot=b.snapshot();assert.deepEqual(snapshot.recentProjects.map(p=>p.id),['blog','project','lives']);assert.equal(snapshot.lead.id,'blog');assert.doesNotMatch(JSON.stringify(snapshot),/directory|session-one/);
 c.now+=150;await b.run();assert.equal(c.calls.length,1,'未选中的旧轮次不再回放');
 const file=path.join(c.home,'.bobo/butler/state.json'),before=await fs.readFile(file,'utf8');await b.run();assert.equal(await fs.readFile(file,'utf8'),before,'重复扫描不反复写入历史记录');
});
test('运行中、工具活动、标题/时间变化和相同结果不产生新摘要',async t=>{
 const {context:c,butler:b}=await fixture(t);
 c.now+=150;c.rows=[observation('one',c.now,{reply:'',status:'working'})];await b.run();assert.equal(c.calls.length,0);
 c.rows[0]={...c.rows[0],at:c.now+1,title:'另一个标题'};await b.run();assert.equal(c.calls.length,0);
 c.rows[0]={...c.rows[0],reply:'已经修复导出',status:'complete',at:c.now+2};await b.run();assert.equal(c.calls.length,1);
 c.now+=150;c.rows[0]={...c.rows[0],at:c.now,title:'重命名',status:'interrupted'};await b.run();assert.equal(c.calls.length,1,'状态变了但发送内容没变，不重复付费');
 c.rows=[observation('same-result',c.now+1,{reply:'已经修复导出'})];await b.run();assert.equal(c.calls.length,1,'另一轮同样内容复用本机结果');
 c.rows=[];c.now+=40*60000;await b.run();assert.equal(b.detail().projects.length,1);
 c.now+=8*86400000;await b.run();assert.equal(b.detail().projects.length,0);
 c.now+=23*86400000;await b.run();const saved=JSON.parse(await fs.readFile(path.join(c.home,'.bobo/butler/state.json'),'utf8'));assert.deepEqual(saved.projects,{});assert.deepEqual(saved.observations,{});
});
test('dsh 等时记录优先展示最后一轮，不把上一轮结果误当最新进展',async t=>{
 const {context:c,butler:b}=await fixture(t,{initial:[observation('previous',epoch-100,{source:'dsh',reply:'上一轮完成'}),observation('current',epoch-100,{source:'dsh',prompt:'最新一轮请求',reply:'',status:'working'})]});
 assert.match(b.snapshot().lead.text,/最新一轮请求/);assert.equal(c.calls.length,0);
 c.now+=150;c.rows=c.rows.map(o=>o.id==='current'?{...o,at:c.now,reply:'本轮修改通过',status:'complete'}:o);await b.run();
 assert.equal(c.calls.length,1);assert.equal(c.calls[0][0].observations[0].id,'current');assert.match(b.snapshot().lead.text,/本轮修改通过/);
});
test('失败不自动循环付费；手动重试只重试失败的最新进展',async t=>{
 const {context:c,butler:b}=await fixture(t);c.now+=150;c.rows=[observation('new',c.now)];c.error=Object.assign(Error('无效格式'),{status:502});await b.run();
 assert.equal(c.calls.length,1);assert.equal(b.snapshot().status,'error');assert.match(b.snapshot().message,/手动重试/);
 c.now+=86400000;await b.run();await b.run();assert.equal(c.calls.length,1);
 c.error=null;await b.refresh();await b.run();assert.equal(c.calls.length,2);assert.ok(b.detail().projects[0].summaryAt);
 c.now+=150;await b.refresh();await b.run();assert.equal(c.calls.length,2,'手动检查不能重做成功摘要');
});
test('短窗口只保留最新进展，超过旧每日 40 项仍按需更新',async t=>{
 const {context:c,butler:b}=await fixture(t);
 c.now+=150;c.rows=[observation('first',c.now)];await b.run();assert.equal(c.calls.length,1);
 c.now+=10;c.rows.push(observation('second',c.now,{reply:'第二轮'}));await b.run();assert.equal(c.calls.length,1);assert.equal(b.snapshot().status,'queued');
 c.now+=150;c.rows.push(observation('third',c.now,{reply:'第三轮'}));await b.run();assert.equal(c.calls.length,2);assert.equal(c.calls[1][0].observations[0].id,'third');
 for(let i=4;i<=45;i++){c.now+=150;c.rows=[observation('round-'+i,c.now,{reply:'第 '+i+' 轮完成'})];await b.run();}
 assert.equal(c.calls.length,44);assert.equal(b.detail().budget.count,44);assert.equal(b.detail().budget.limit,undefined);assert.equal(b.snapshot().status,'ready');
 await b.run();assert.equal(c.calls.length,44,'取消限额仍不重复总结');
 c.now+=86400000;await b.run();assert.equal(c.calls.length,44);assert.equal(b.detail().budget.count,0);
});
test('缺少 Key 不请求；关闭取消摘要，重新开启不回放关闭期间的历史',async t=>{
 const {context:c,butler:b}=await fixture(t);c.now+=150;c.rows=[observation('new',c.now)];c.key=false;await b.run();assert.equal(c.calls.length,0);assert.match(b.snapshot().message,/Key/);
 c.key=true;let finish;c.response=p=>new Promise(resolve=>{finish=()=>resolve({id:p.id,summary:'构建完成。'});});
 const run=b.run();while(!finish)await new Promise(r=>setTimeout(r,5));await b.saveSettings({enabled:false});finish();await run;assert.equal(b.detail().projects[0].summaryAt,0);
 c.now+=150;c.rows.push(observation('offline',c.now));await b.run();assert.equal(c.calls.length,1);
 await b.saveSettings({enabled:true});await b.run();assert.equal(c.calls.length,1,'关闭期间进展只在本机展示');
});
test('长消息缩短至 1.5 KB，不发送旧待办、历史对话或代码块',async t=>{
 const {context:c,butler:b}=await fixture(t);
 for(let i=0;i<4;i++){
  c.now+=150;c.rows.push(observation('long-'+i,c.now,{prompt:'新的工作请求'.repeat(100),reply:'第 '+i+' 轮进展：'+'新的结果已写入'.repeat(500)}));
  c.response=p=>({id:p.id,summary:'第 '+i+' 轮完成，待处理本轮问题。'});await b.run();
  const input=c.calls.at(-1)[0];assert.ok(Buffer.byteLength(JSON.stringify(input))<=1536);assert.equal(input.observations.length,1);assert.equal(input.previous,undefined);
 }
 assert.equal(b.detail().projects[0].text,'第 3 轮完成，待处理本轮问题。');assert.doesNotMatch(b.detail().projects[0].text,/第 [012]/);
});
test('旧累计记录迁移后不自动回放，不补收旧额度；随后只总结新进展',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-butler-migrate-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.bobo/butler'),{recursive:true});
 const old={...observation('old',epoch-1000),projectId:'project',signature:'old'},recent={...observation('recent',epoch-100,{reply:'最新版已发布'}),projectId:'project',signature:'recent'};
 await fs.writeFile(path.join(home,'.bobo/butler/state.json'),JSON.stringify({version:1,enabled:true,projects:{project:{id:'project',name:'project',directory:'/tmp/project',updatedAt:recent.at,summaryAt:epoch-20,facts:{done:[],pending:[{text:'旧待办',evidence:['old']}],next:[]}}},observations:{old,recent},processed:{},budget:{day:'',count:0},lastBatch:0}));
 let calls=0,now=epoch,rows=[];const b=createButler({home,now:()=>now,batchMs:1,resolveProject:async directory=>({id:'project',name:'project',directory}),sources:{scan:async()=>({observations:rows})},ai:{status:async()=>({keyAvailable:true}),summarizeWork:async({projects})=>{calls++;return {projects:projects.map(p=>({id:p.id,summary:'新的验收进展。'}))};}}});t.after(()=>b.stop());
 await b.run();assert.equal(calls,0);assert.match(b.snapshot().lead.text,/最新版已发布/);assert.doesNotMatch(b.snapshot().lead.text,/旧待办/);
 now+=150;rows=[observation('next',now,{reply:'新的验收进展'})];await b.run();assert.equal(calls,1);assert.match(b.snapshot().lead.text,/新的验收进展/);
});
test('简短 JSON 校验：项目错配和无效字段拒绝，超长文本本机截短',()=>{
 const inputs=[{id:'project',observations:[{id:'new'}]}];
 const brief=validateBriefs([{id:'project',summary:'甲'.repeat(50)}],inputs)[0];assert.equal([...brief.summary].length,40);assert.ok(brief.summary.endsWith('…'));assert.deepEqual(brief.evidence,['new']);
 assert.throws(()=>validateBriefs([{id:'invented',summary:'完成'}],inputs),/项目不匹配/);
 assert.throws(()=>validateBriefs([{id:'project',summary:[]}],inputs),/条目无效/);
 assert.throws(()=>validateBriefs([{id:'project',summary:'  '}],inputs),/条目无效/);
});

test('一句话近况：压短 Markdown 摘录，保留版本号和计划语气，兼容已有摘要',()=>{
 assert.equal(compactSentence('已改好，并更新到本机 **bobo**：\n- 每分钟检查本机记录\n- 仅总结最新进展'),'已改好，并更新到本机 bobo。');
 assert.equal(compactSentence('已支持，并发布 v0.1.6，Homebrew tap 已同步。\n- 图片排版已保留。'),'已支持，并发布 v0.1.6，Homebrew tap 已同步。');
 assert.equal(compactSentence('本轮进展：\n- [构建通过](https://example.com)，待真机验证。之后再发布。'),'构建通过，待真机验证。');
 assert.equal(compactSentence('计划修复导出。\n尚未开始。'),'计划修复导出。');
 assert.equal(compactSentence('Build passed. Deployment is pending.'),'Build passed。');
 assert.equal(compactSentence('```sh\nrm -rf example\n```\n- 构建已通过。'),'构建已通过。');
 assert.equal(briefText({facts:{done:[{text:'构建通过'}],pending:[{text:'真机验证'}],next:[{text:'发布'}]}}),'构建通过，待真机验证。');
 const long=compactSentence('🛠️'.repeat(50));assert.ok([...long].length<=40);assert.ok(!long.includes('\uFFFD'));
 assert.equal(compactSentence(long),long,'重复展示不能丢掉截短标记');
});

test('已有成功摘要只改变展示，旧多段文案不重新计费',async t=>{
 const {context:c,butler:b}=await fixture(t);c.now+=150;c.rows=[observation('new',c.now)];await b.run();await b.stop();
 const file=path.join(c.home,'.bobo/butler/state.json'),state=JSON.parse(await fs.readFile(file,'utf8')),project=state.projects.project;
 delete project.summary;project.facts={done:[{text:'构建通过',evidence:['new']}],pending:[{text:'真机验证',evidence:['new']}],next:[{text:'发布',evidence:['new']}]};await fs.writeFile(file,JSON.stringify(state));
 const before=await fs.readFile(file,'utf8');
 const restart=createButler({home:c.home,now:()=>c.now,sources:{scan:async()=>({observations:c.rows})},ai:{status:async()=>({keyAvailable:true}),summarizeWork:async()=>assert.fail('旧摘要改版不能重新计费')}});t.after(()=>restart.stop());
 await restart.run();assert.equal(restart.snapshot().lead.text,'构建通过，待真机验证。');assert.equal(await fs.readFile(file,'utf8'),before,'展示缩短不改写旧摘要');
 await restart.refresh();await restart.run();assert.equal(restart.snapshot().lead.text,'构建通过，待真机验证。');
});

