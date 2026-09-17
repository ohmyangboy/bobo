import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
test('智能体：解析、增删改、冲突保护、备份与符号链接限制',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-agents-')),agentDir=path.join(home,'.config/opencode/agents');
 await fs.mkdir(path.join(agentDir,'team'),{recursive:true});
 await fs.writeFile(path.join(agentDir,'reviewer.md'),'---\ndescription: Reviews changes\nmode: subagent\ncolor: \'#9B59B6\'\n---\n\nReview code.');
 await fs.writeFile(path.join(agentDir,'team','nested.md'),'---\ndescription: Nested agent\nmode: subagent\n---\nNested.');
 await fs.writeFile(path.join(agentDir,'broken.md'),'没有 frontmatter');
 await fs.writeFile(path.join(home,'outside.md'),'---\ndescription: Outside\n---\nOutside.');
 await fs.symlink(path.join(home,'outside.md'),path.join(agentDir,'linked.md'));
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nconst a=process.argv.slice(4);if(a[0]==='list')console.log('[]');else console.log('MOCK');process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14321;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await fetch(base+'/api/agents')).status,403);
  // 列表：解析 frontmatter、子目录成为 ID 前缀、链接与问题都标出来。
  const list=(await req('agents')).data,byId=Object.fromEntries(list.agents.map(a=>[a.id,a]));
  assert.equal(list.root,agentDir);
  assert.deepEqual(Object.keys(byId).sort(),['broken','linked','reviewer','team/nested']);
  assert.equal(byId.reviewer.mode,'subagent');assert.equal(byId.reviewer.color,'#9B59B6');assert.equal(byId.reviewer.disabled,false);
  assert.ok(byId.broken.problems.length>=2);assert.equal(byId.linked.link,true);
  // 新建：模板保留特殊字符描述；重名与非法 ID 被拒绝。
  const created=await req('agents/create',{id:'writer',description:'Writes docs: carefully',mode:'primary',color:'#123456'});
  assert.equal(created.status,200);
  const text=await fs.readFile(path.join(agentDir,'writer.md'),'utf8');
  assert.ok(text.startsWith('---\ndescription: "Writes docs: carefully"\nmode: primary\ncolor: \'#123456\'\n---'),text);
  assert.equal((await req('agents/create',{id:'writer'})).status,409);
  assert.equal((await req('agents/create',{id:'Bad Name'})).status,400);
  assert.equal((await req('agents/rename',{id:'writer',next:'reviewer'})).status,409);
  // 读取、版本冲突与备份。
  const f=(await req('agents/file?id=reviewer')).data;
  assert.match(f.content,/Review code/);
  assert.equal((await req('agents/save',{id:'reviewer',content:'x',version:'old'})).status,409);
  const saved=await req('agents/save',{id:'reviewer',content:f.content+'\nMore',version:f.version});
  assert.equal(saved.status,200);await fs.access(path.join(saved.data.backup,'manifest.json'));
  await fs.access(path.join(home,'.bobo','backups'));
  // 路径保护与符号链接不可写。
  assert.equal((await req('agents/file?id=../outside')).status,400);
  assert.equal((await req('agents/file?id=linked')).status,200);
  assert.equal((await req('agents/save',{id:'linked',content:'x',version:'y'})).status,400);
  assert.equal((await req('agents/toggle',{id:'linked',enabled:false})).status,400);
  // 停用写 disabled: true，启用时移除。
  assert.equal((await req('agents/toggle',{id:'reviewer',enabled:false})).status,200);
  assert.match(await fs.readFile(path.join(agentDir,'reviewer.md'),'utf8'),/^disabled: true$/m);
  assert.equal((await req('agents/toggle',{id:'reviewer',enabled:true})).status,200);
  assert.doesNotMatch(await fs.readFile(path.join(agentDir,'reviewer.md'),'utf8'),/^disabled: true$/m);
  // 重命名会移动文件并先备份；删除前备份，缺失的 ID 返回 404。
  assert.equal((await req('agents/rename',{id:'writer',next:'team/writer'})).status,200);
  await fs.access(path.join(agentDir,'team','writer.md'));
  await assert.rejects(()=>fs.access(path.join(agentDir,'writer.md')));
  assert.equal((await req('agents/delete',{id:'team/writer'})).status,200);
  await assert.rejects(()=>fs.access(path.join(agentDir,'team','writer.md')));
  assert.equal((await req('agents/delete',{id:'missing-one'})).status,404);
  assert.equal((await req('agents/rename',{id:'reviewer',next:'reviewer'})).status,400);
  assert.ok((await fs.readdir(path.join(home,'.bobo','backups'))).length<=3,'技能与智能体共用「最近 3 份」配额');
  // 接入 AI 阅读器：文档接口返回分段与空摘要；缺失的 ID 返回 404。
  const aiDoc=await req('ai/agent/document?id=reviewer');
  assert.equal(aiDoc.status,200);assert.ok(Array.isArray(aiDoc.data.blocks)&&aiDoc.data.blocks.length>0);assert.equal(aiDoc.data.summary,null);
  assert.equal((await req('ai/agent/document?id=missing-one')).status,404);
  assert.equal((await req('ai/agent/generate',{id:'reviewer',mode:'bad'})).status,400);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
