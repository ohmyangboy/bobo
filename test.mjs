import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
test('隔离环境：列表、文件增删改、冲突保护、路径保护、CLI 更新及备份',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-test-')),root=path.join(home,'.agents/skills/demo');await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');await fs.writeFile(path.join(home,'secret.txt'),'private');await fs.symlink(path.join(home,'secret.txt'),path.join(root,'link.txt'));
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(4);if(a[0]==='list')console.log(JSON.stringify([{name:'demo',path:path.join(process.env.HOME,'.agents/skills/demo'),agents:['Codex'],source:'test/demo',padding:'x'.repeat(64000)}]));else console.log('MOCK '+JSON.stringify(a));process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14318;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data,extra={})=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json',...extra},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await fetch(base+'/api/skills')).status,403);
  assert.equal((await fetch(base+'/api/ai/settings')).status,403);
  assert.equal((await req('ai/settings',null,{Origin:'https://evil.example'})).status,403);
  assert.equal((await req('ai/settings',{keySource:'manual',baseUrl:'http://127.0.0.1:1/v1',model:'test',clearKey:true})).status,200);
  assert.equal((await req('skills',null,{Origin:'https://evil.example'})).status,403);
  // 用量接口：隔离环境里没有 OpenCode 数据库与 Codex 登录，两家都不可用但接口本身要正常。
  const usage=(await req('usage')).data;
  assert.equal(usage.available,false);assert.equal(usage.providers.length,2);assert.equal(usage.providers[0].id,'codex');assert.equal(usage.providers[1].id,'opencode-go');
  await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
  await fs.writeFile(path.join(home,'.bobo/catalog.json'),JSON.stringify([{name:'cached-demo',path:root,agents:['Codex'],source:'test/demo',id:'cached'}]));
  const startup=(await req('startup')).data;
  assert.equal(startup.cached,true);assert.equal(startup.skills[0].name,'cached-demo');
  // 强制刷新必须替换快照，而不是继续返回旧列表。
  const rows=(await req('skills?refresh=1')).data;assert.equal(rows[0].name,'demo');const id=rows[0].id;
  assert.equal((await req('ai/generate',{id,mode:'summary'})).status,400);
  assert.equal((await req('ai/generate',{id:'missing',mode:'summary'})).status,404);
  const file=(await req('file?id='+id+'&path=SKILL.md')).data;
  assert.equal((await req('file',{id,path:'SKILL.md',content:'updated',version:'old'})).status,409);
  const saved=await req('file',{id,path:'SKILL.md',content:'updated',version:file.version});assert.equal(saved.status,200);assert.equal(await fs.readFile(path.join(root,'SKILL.md'),'utf8'),'updated');assert.equal((await fs.readdir(saved.data.backup)).includes('manifest.json'),true);
  assert.equal((await req('file',{id,path:'notes/test.md',content:'new',create:true})).status,200);
  assert.equal((await req('file',{id,path:'notes/test.md',content:'oops',create:true})).status,409);
  const note=(await req('file?id='+id+'&path=notes/test.md')).data;
  assert.equal((await req('file',{id,path:'notes/test.md',version:note.version,delete:true})).status,200);
  assert.equal((await req('file?id='+id+'&path=../secret.txt')).status,400);
  assert.equal((await req('file?id='+id+'&path=link.txt')).status,400);
 assert.equal((await req('ai/document?id='+id+'&path=../secret.txt')).status,400);
  assert.equal((await req('command',{args:['init','../outside']})).status,400);
  assert.equal((await req('command',{args:['sh','-c','touch bad']})).status,400);
  assert.equal((await req('command',{args:['update','--project']})).status,400);
  assert.equal((await req('command',{args:['update','demo','-g']})).status,200);
  let job;for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}assert.equal(job.code,0);assert.match(job.output,/MOCK \["update","demo","-g","-y"\]/);assert.ok(job.backup);
  assert.equal((await req('command',{args:['remove','demo','-g']})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/MOCK \["remove","demo","-g","-y"\]/);assert.equal(job.backup,null);
  await assert.rejects(()=>fs.access(root));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
test('按分组删除：一次移除同一来源的全部技能，不影响其他来源',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-group-'));
 const roots={alpha:path.join(home,'.agents/skills/alpha'),beta:path.join(home,'.agents/skills/beta'),gamma:path.join(home,'.claude/skills/gamma')};
 for(const [name,root] of Object.entries(roots)){await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\n---\nHello`);}
 const rows=[{name:'alpha',path:roots.alpha,agents:['Codex'],source:'test/demo'},{name:'beta',path:roots.beta,agents:['Claude'],source:'test/demo'},{name:'gamma',path:roots.gamma,agents:['Claude'],source:'other/repo'}];
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(4);if(a[0]==='list')console.log(JSON.stringify(${JSON.stringify(rows)}));else console.log('MOCK '+JSON.stringify(a));process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14319;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await req('skills?refresh=1')).data.length,3);
  assert.equal((await req('command',{args:['remove'],group:'missing'})).status,404);
  let job;
  assert.equal((await req('command',{args:['update'],group:'test'})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/MOCK \["update","alpha","beta","-g","-y"\]/);assert.ok(job.backup);
  assert.equal((await req('command',{args:['remove'],group:'test'})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/MOCK \["remove","alpha","beta","-g","-y"\]/);
  await assert.rejects(()=>fs.access(roots.alpha));await assert.rejects(()=>fs.access(roots.beta));await fs.access(roots.gamma);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
test('改名迁移：旧数据目录逐项搬到 ~/.bobo，新目录已有的项不覆盖',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-migrate-'));
 await fs.mkdir(path.join(home,'.skills-manager/backups'),{recursive:true});
 await fs.mkdir(path.join(home,'.skills-manager/app-backups'),{recursive:true});
 await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
 await fs.writeFile(path.join(home,'.skills-manager/sources.json'),'[{"path":"/tmp/x","name":"x"}]');
 await fs.writeFile(path.join(home,'.skills-manager/ai.json'),'{"old":true}');
 await fs.writeFile(path.join(home,'.skills-manager/backups/demo.txt'),'old backup');
 await fs.writeFile(path.join(home,'.skills-manager/app-backups/note.txt'),'unknown entry');
 await fs.writeFile(path.join(home,'.bobo/ai.json'),'{"new":true}');
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nif(process.argv[4]==='list')console.log('[]');process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14322;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  assert.equal(await fs.readFile(path.join(home,'.bobo/sources.json'),'utf8'),'[{"path":"/tmp/x","name":"x"}]');
  assert.equal(await fs.readFile(path.join(home,'.bobo/ai.json'),'utf8'),'{"new":true}','新目录已有的项不应被覆盖');
  assert.equal(await fs.readFile(path.join(home,'.bobo/backups/demo.txt'),'utf8'),'old backup');
  assert.equal(await fs.readFile(path.join(home,'.bobo/app-backups/note.txt'),'utf8'),'unknown entry','旧目录里的其它条目也要搬走');
  await assert.rejects(()=>fs.access(path.join(home,'.skills-manager/sources.json')));
  await fs.access(path.join(home,'.skills-manager/ai.json'));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
test('备份轮换：只保留最近 3 份，最旧的自动淘汰',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-prune-')),root=path.join(home,'.agents/skills/demo');
 await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nif(process.argv[4]==='list')console.log(JSON.stringify([{name:'demo',path:process.env.HOME+'/.agents/skills/demo',agents:[],source:'test/demo'}]));process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14323;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  const id=(await req('skills?refresh=1')).data[0].id,backups=[];
  for(let i=0;i<4;i++){
   const f=(await req('file?id='+id+'&path=SKILL.md')).data;
   backups.push((await req('file',{id,path:'SKILL.md',content:'version '+i,version:f.version})).data.backup);
   await new Promise(r=>setTimeout(r,15));
  }
  assert.equal((await fs.readdir(path.join(home,'.bobo/backups'))).length,3,'最多保留 3 份');
  await assert.rejects(()=>fs.access(backups[0]),'最旧的备份被淘汰');
  for(const b of backups.slice(1))await fs.access(path.join(b,'manifest.json'));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
// 点技能的读取路径（tree / file）不该同步跑 CLI：保存文件等操作会把 catalog 置为过期，
// 过期后第一次点技能若等 npx，文件树与阅读区会空白（见 server.mjs 的 skill()）。
test('读取路径不触发 CLI：catalog 过期后点技能直接返回',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-readpath-')),root=path.join(home,'.agents/skills/demo');
 await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');
 const calls=path.join(home,'cli-calls');
 const mock=path.join(home,'npx');await fs.writeFile(mock,`#!${process.execPath}\nimport fs from 'node:fs';if(process.argv[4]==='list'){fs.appendFileSync(${JSON.stringify(calls)},'x');console.log(JSON.stringify([{name:'demo',path:process.env.HOME+'/.agents/skills/demo',agents:[],source:'test/demo'}]));}process.exit(0);`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14324;const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,BOBO_NPX:mock,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  const id=(await req('skills?refresh=1')).data[0].id;
  const f=(await req('file?id='+id+'&path=SKILL.md')).data;
  assert.equal((await req('file',{id,path:'SKILL.md',content:'saved',version:f.version})).status,200,'保存后 catalog 失效');
  const before=await fs.readFile(calls,'utf8');
  assert.equal((await req('tree?id='+id)).status,200);
  assert.equal((await req('file?id='+id+'&path=SKILL.md')).data.content,'saved');
  assert.equal(await fs.readFile(calls,'utf8'),before,'读取路径不该再跑 CLI');
  // 快照里没有的 id 仍然会刷新一次，找不到才 404。
  assert.equal((await req('tree?id=missing')).status,404);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
