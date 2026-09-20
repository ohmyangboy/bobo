import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createSkillReader,createAgentReader} from '../src/reader-ai.mjs';import {splitMarkdown,frontmatterRows} from '../public/markdown.js';
test('正文缓存：持久化、续译、来源对齐、更新/删除失效与迟到响应',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'reader-test-')),root=path.join(home,'skill');await fs.mkdir(root);
 const markdown='---\nname: demo\ndescription: Review code\n---\n\n# Demo\n\n'+Array.from({length:12},(_,i)=>'Paragraph '+i).join('\n\n')+'\n\n```js\nconst x = 1;\n```';
 await fs.writeFile(path.join(root,'SKILL.md'),markdown);
 let calls=0,failBatch=false,hold,release,model='test';
 const ai={status:async()=>({baseUrl:'http://localhost',model}),generate:async({mode,content})=>{calls++;if(hold)await hold;if(mode==='summary')return {text:'## 用途\n帮助审查代码',model,incomplete:false};const rows=JSON.parse(content);if(failBatch&&rows.some(r=>r.id==='p6'))throw Error('暂时失败');return {text:JSON.stringify(rows.map(r=>({id:r.id,text:'译文 '+r.text}))),model,incomplete:false};}};
 const resolveSkill=async id=>({id,path:root}),make=()=>createSkillReader({home,ai,resolveSkill});let reader=make();
 try{
  assert.equal((await reader.document('demo')).summary,null);assert.equal(calls,0);
  await reader.generate('demo','summary');reader=make();assert.equal((await reader.document('demo')).summary.complete,true);
  await reader.generate('demo','summary');assert.equal(calls,1,'磁盘缓存避免重复请求');
  failBatch=true;await assert.rejects(reader.generate('demo','translate'),/暂时失败/);let doc=await reader.document('demo');assert.equal(doc.translation.done,2);assert.equal(doc.translation.complete,false);
  failBatch=false;const before=calls;await reader.generate('demo','translate');doc=await reader.document('demo');assert.equal(doc.translation.complete,true);assert.equal(doc.translation.done,14);assert.equal(calls-before,2,'只续译未完成的段落');
  assert.equal(doc.blocks.at(-1).type,'code');assert.equal(doc.translation.segments[doc.blocks.at(-1).id],undefined);assert.equal(doc.translation.segments.p2,'译文 Paragraph 0');
  const cached=calls;await make().generate('demo','translate');assert.equal(calls,cached);
  await fs.writeFile(path.join(root,'reference.md'),'changed');assert.equal((await reader.document('demo')).summary,null,'支持文件变更同样失效');
  await reader.generate('demo','summary');model='other';assert.equal((await reader.document('demo')).summary,null,'模型变更失效');model='test';
  await reader.invalidate(['demo']);assert.equal((await reader.document('demo')).summary,null,'显式更新即使正文不变也失效');
  hold=new Promise(r=>release=r);const request=reader.generate('demo','summary');while((await reader.document('demo')).pending!=='summary')await new Promise(r=>setTimeout(r,5));await reader.invalidate(['demo']);release();await assert.rejects(request,/变更|更新/);hold=null;assert.equal((await reader.document('demo')).summary,null,'迟到响应不能恢复旧缓存');
  await reader.generate('demo','summary');await fs.rm(root,{recursive:true});await fs.mkdir(root);await fs.writeFile(path.join(root,'SKILL.md'),markdown);assert.equal((await reader.document('demo')).summary,null,'同路径重装失效');
 }finally{release?.();await fs.rm(home,{recursive:true,force:true});}
});
test('翻译任意子文件：独立缓存与路径保护',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'reader-subfile-')),root=path.join(home,'skill');await fs.mkdir(path.join(root,'references'),{recursive:true});
 await fs.writeFile(path.join(root,'SKILL.md'),'# Demo\n\nHello');
 await fs.writeFile(path.join(root,'references/notes.md'),'# Notes\n\nAlpha\n\nBeta');
 await fs.symlink(path.join(root,'SKILL.md'),path.join(root,'link.md'));
 const ai={status:async()=>({baseUrl:'local',model:'test'}),generate:async({content})=>{const rows=JSON.parse(content);return {text:JSON.stringify(rows.map(r=>({id:r.id,text:'译文 '+r.text}))),model:'test'};}};
 const reader=createSkillReader({home,ai,resolveSkill:async id=>({id,path:root})});
 try{
  const doc=await reader.document('demo','references/notes.md');
  assert.equal(doc.path,'references/notes.md');assert.equal(doc.summary,null);
  assert.deepEqual(doc.blocks.map(b=>b.text),['# Notes','Alpha','Beta']);
  await reader.generate('demo','translate','references/notes.md');
  const translated=await reader.document('demo','references/notes.md');
  assert.equal(translated.translation.complete,true);assert.equal(translated.translation.segments.p1,'译文 Alpha');
  assert.equal((await reader.document('demo')).translation,null,'子文件译文不写入 SKILL.md 缓存');
  await assert.rejects(reader.generate('demo','summary','references/notes.md'),/仅支持/);
  await assert.rejects(reader.document('demo','../secret.md'),/无效/);
  await assert.rejects(reader.document('demo','link.md'),/符号链接/);
  await reader.generate('demo','translate');assert.equal((await reader.document('demo')).translation.complete,true);
  assert.equal((await reader.document('demo','references/notes.md')).translation.complete,true,'两文件缓存互不影响');
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('智能体 AI：单文件快照、缓存与技能隔离、内容变更与显式失效',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'reader-agent-')),file=path.join(home,'.config/opencode/agents/design-ui-designer.md');
 await fs.mkdir(path.dirname(file),{recursive:true});
 const markdown='---\ndescription: Reviews UI\nmode: subagent\n---\n\n# UI Designer\n\nParagraph A\n\nParagraph B';
 await fs.writeFile(file,markdown);
 let calls=0,subject,model='test';
 const ai={status:async()=>({baseUrl:'local',model}),generate:async({mode,content,subject:s})=>{calls++;subject=s;if(mode==='summary')return {text:'## 用途\n界面设计',model,incomplete:false};const rows=JSON.parse(content);return {text:JSON.stringify(rows.map(r=>({id:r.id,text:'译文 '+r.text}))),model,incomplete:false};}};
 const resolveAgent=async id=>({id,path:file}),reader=createAgentReader({home,ai,resolveAgent});
 try{
  const doc=await reader.document('design-ui-designer');
  assert.equal(doc.path,'AGENT.md');assert.equal(doc.summary,null);assert.equal(calls,0);
  assert.ok(doc.blocks.some(b=>b.type==='metadata'),'frontmatter 作为声明块参与分段');
  await reader.generate('design-ui-designer','summary');assert.equal(subject,'agent');
  assert.equal((await createAgentReader({home,ai,resolveAgent}).document('design-ui-designer')).summary.complete,true,'摘要持久化');
  await reader.generate('design-ui-designer','translate');
  const translated=await reader.document('design-ui-designer');
  assert.equal(translated.translation.complete,true);assert.equal(translated.translation.segments.p1,'译文 # UI Designer');
  // 同名 id 的技能与智能体缓存互不覆盖。
  const skillRoot=path.join(home,'skill');await fs.mkdir(skillRoot);await fs.writeFile(path.join(skillRoot,'SKILL.md'),'# Skill\n\nAlpha');
  await createSkillReader({home,ai,resolveSkill:async id=>({id,path:skillRoot})}).generate('design-ui-designer','summary');
  assert.equal((await reader.document('design-ui-designer')).translation.complete,true,'技能缓存不影响智能体缓存');
  assert.equal((await reader.document('design-ui-designer')).summary.text,'## 用途\n界面设计');
  // 内容变化、显式失效与符号链接保护。
  await fs.writeFile(file,markdown+'\n\nChanged');
  assert.equal((await reader.document('design-ui-designer')).summary,null);
  await reader.generate('design-ui-designer','summary');await reader.invalidate(['design-ui-designer']);
  assert.equal((await reader.document('design-ui-designer')).summary,null,'显式失效即使正文不变也清空');
  const link=path.join(home,'linked.md');await fs.symlink(file,link);
  await assert.rejects(createAgentReader({home,ai,resolveAgent:async id=>({id,path:link})}).document('linked'),/符号链接/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('Markdown 分段保留列表、表格、代码与原文顺序',()=>{
 const text='# 标题\n\nOne\ncontinued\n\n- Item\n- Other\n\n| A | B |\n| --- | --- |\n| x | y |\n\n~~~js\n# code\n\ntext\n~~~\n\nLast';
 const b=splitMarkdown(text);assert.deepEqual(b.map(x=>x.type),['heading','paragraph','list','table','code','paragraph']);assert.match(b[4].text,/# code\n\ntext/);assert.equal(b[5].text,'Last');
});
test('frontmatter 表格行：顶层字段、缩进续行、注释与冒号值',()=>{
 const rows=frontmatterRows('---\nname: easein\ndescription: 解释一个概念\npermissions:\n  - action: edit\n    effect: deny\n# 注释\nurl: https://example.com/a:b\n---\n');
 assert.deepEqual(rows.map(r=>[r.key,r.value]),[
  ['name','easein'],
  ['description','解释一个概念'],
  ['permissions','  - action: edit\n    effect: deny'],
  ['url','https://example.com/a:b'],
 ]);
 assert.deepEqual(frontmatterRows('plain text'),[{key:'',value:'plain text'}]);
 assert.deepEqual(frontmatterRows(''),[]);
});

test('翻译首批较小、两批同时请求、并发缓存不丢段落',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'reader-parallel-'));const root=path.join(home,'skill');await fs.mkdir(root);await fs.writeFile(path.join(root,'SKILL.md'),Array.from({length:16},(_,i)=>'Paragraph '+i).join('\n\n'));
 let active=0,peak=0;const sizes=[],events=[];
 const ai={status:async()=>({baseUrl:'local',model:'test'}),generate:async({content})=>{const rows=JSON.parse(content);sizes.push(rows.length);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,rows[0].id==='p0'?25:5));active--;return {text:JSON.stringify(rows.map(r=>({id:r.id,text:'译文 '+r.id}))),model:'test'};}};
 const reader=createSkillReader({home,ai,resolveSkill:async id=>({id,path:root})});
 try{await reader.generate('demo','translate',e=>events.push(e));assert.equal(sizes[0],2);assert.equal(peak,2);const doc=await reader.document('demo');assert.equal(doc.translation.done,16);assert.equal(doc.translation.complete,true);assert.deepEqual(Object.keys(doc.translation.segments).sort(),doc.blocks.map(b=>b.id).sort());assert.ok(events.filter(e=>e.type==='translation').length>=3);}finally{await fs.rm(home,{recursive:true,force:true});}
});
