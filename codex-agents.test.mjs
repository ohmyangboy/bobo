import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
// Codex 智能体：解析 TOML、增删改、冲突保护、备份与符号链接限制，以及 AI 阅读接口。
test('Codex 智能体：TOML 解析、增删改、冲突保护、备份与符号链接限制',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-codex-agents-')),agentDir=path.join(home,'.codex','agents');
 await fs.mkdir(path.join(agentDir,'team'),{recursive:true});
 await fs.writeFile(path.join(agentDir,'reviewer.toml'),'name = "reviewer"\ndescription = "Reviews changes"\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\n\ndeveloper_instructions = """\nReview code like an owner.\n"""\n');
 await fs.writeFile(path.join(agentDir,'team','nested.toml'),'name = "nested"\ndescription = "Nested agent"\ndeveloper_instructions = """\nDo nested things.\n"""\n');
 await fs.writeFile(path.join(agentDir,'broken.toml'),'name = "broken"\n');
 await fs.writeFile(path.join(home,'outside.toml'),'name = "outside"\ndescription = "Outside"\ndeveloper_instructions = """\nOutside.\n"""\n');
 await fs.symlink(path.join(home,'outside.toml'),path.join(agentDir,'linked.toml'));
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nconst a=process.argv.slice(4);if(a[0]==='list')console.log('[]');else console.log('MOCK');process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14341;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)"/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await fetch(base+'/api/codex/agents')).status,403);
  // 列表：解析 name/description/model/effort/sandbox，子目录成为 ID 前缀，链接与问题都标出来。
  const list=(await req('codex/agents')).data,byId=Object.fromEntries(list.agents.map(a=>[a.id,a]));
  assert.equal(list.root,agentDir);
  assert.deepEqual(Object.keys(byId).sort(),['broken','linked','reviewer','team/nested']);
  assert.equal(byId.reviewer.name,'reviewer');assert.equal(byId.reviewer.model,'gpt-5.4');assert.equal(byId.reviewer.effort,'high');assert.equal(byId.reviewer.sandbox,'read-only');assert.equal(byId.reviewer.hasInstructions,true);
  assert.ok(byId.broken.problems.some(p=>p.includes('description')));
  assert.equal(byId.linked.link,true);
  // 新建：模板里有三个必填字段；重名与非法 ID 被拒绝。
  const created=await req('codex/agents/create',{id:'writer',description:'Writes docs: carefully'});
  assert.equal(created.status,200);
  const text=await fs.readFile(path.join(agentDir,'writer.toml'),'utf8');
  assert.match(text,/^name = "writer"$/m);assert.match(text,/^description = "Writes docs: carefully"$/m);assert.match(text,/^developer_instructions = """$/m);
  assert.equal((await req('codex/agents/create',{id:'writer'})).status,409);
  assert.equal((await req('codex/agents/create',{id:'Bad Name'})).status,400);
  assert.equal((await req('codex/agents/rename',{id:'writer',next:'reviewer'})).status,409);
  // 读取、版本冲突与备份。
  const f=(await req('codex/agents/file?id=reviewer')).data;
  assert.match(f.content,/Review code/);
  assert.equal((await req('codex/agents/save',{id:'reviewer',content:'x',version:'old'})).status,409);
  const saved=await req('codex/agents/save',{id:'reviewer',content:f.content+'\n# more',version:f.version});
  assert.equal(saved.status,200);await fs.access(path.join(saved.data.backup,'manifest.json'));
  await fs.access(path.join(home,'.bobo','backups'));
  // 路径保护与符号链接不可写。
  assert.equal((await req('codex/agents/file?id=../outside')).status,400);
  assert.equal((await req('codex/agents/file?id=linked')).status,200);
  assert.equal((await req('codex/agents/save',{id:'linked',content:'x',version:'y'})).status,400);
  // 重命名会移动文件并先备份；删除前备份，缺失的 ID 返回 404。
  assert.equal((await req('codex/agents/rename',{id:'writer',next:'team/writer'})).status,200);
  await fs.access(path.join(agentDir,'team','writer.toml'));
  await assert.rejects(()=>fs.access(path.join(agentDir,'writer.toml')));
  assert.equal((await req('codex/agents/delete',{id:'team/writer'})).status,200);
  await assert.rejects(()=>fs.access(path.join(agentDir,'team','writer.toml')));
  assert.equal((await req('codex/agents/delete',{id:'missing-one'})).status,404);
  assert.equal((await req('codex/agents/rename',{id:'reviewer',next:'reviewer'})).status,400);
  assert.ok((await fs.readdir(path.join(home,'.bobo','backups'))).length<=3,'技能与智能体共用「最近 3 份」配额');
  // AI 阅读器：文档接口返回分段与空摘要；缺失的 ID 返回 404；Codex 与 OpenCode 的缓存键互不影响。
  const aiDoc=await req('ai/codex/document?id=reviewer');
  assert.equal(aiDoc.status,200);assert.ok(Array.isArray(aiDoc.data.blocks)&&aiDoc.data.blocks.length>0);assert.equal(aiDoc.data.summary,null);
  assert.equal((await req('ai/codex/document?id=missing-one')).status,404);
  assert.equal((await req('ai/codex/generate',{id:'reviewer',mode:'bad'})).status,400);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
