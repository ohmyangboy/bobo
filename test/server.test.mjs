import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
test('隔离环境：列表、文件增删改、冲突保护、路径保护、本机更新删除及备份',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-test-')),root=path.join(home,'.agents/skills/demo');await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');await fs.writeFile(path.join(home,'secret.txt'),'private');await fs.symlink(path.join(home,'secret.txt'),path.join(root,'link.txt'));
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14318;const env={...process.env,BOBO_HOME:home,PORT:String(port)};delete env.ANTIGRAVITY_LS_ADDRESS;delete env.ANTIGRAVITY_CSRF_TOKEN;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env,stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data,extra={})=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json',...extra},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await fetch(base+'/api/skills')).status,403);
  assert.equal((await fetch(base+'/api/ai/settings')).status,403);
  assert.equal((await req('ai/settings',null,{Origin:'https://evil.example'})).status,403);
  assert.equal((await req('ai/settings',{keySource:'manual',baseUrl:'http://127.0.0.1:1/v1',model:'test',clearKey:true})).status,200);
  assert.equal((await req('skills',null,{Origin:'https://evil.example'})).status,403);
  // 用量接口：隔离环境里没有 OpenCode 数据库、Codex 登录与 agy 会话，三家都不可用但接口本身要正常。
  const usage=(await req('usage')).data;
  assert.equal(usage.available,false);assert.equal(usage.providers.length,3);assert.equal(usage.providers[0].id,'codex');assert.equal(usage.providers[1].id,'opencode-go');assert.equal(usage.providers[2].id,'agy');
  const island=(await req('opencode')).data;
  assert.ok(island.agy);
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
  // 上一步把 SKILL.md 改成了没有 frontmatter 的内容，恢复成有效技能后才能被列表收录并删除。
  await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');
  await req('skills?refresh=1');
  // 没有来源记录的技能无法更新：任务正常结束并说明原因，不报错。
  assert.equal((await req('command',{args:['update','demo','-g']})).status,200);
  let job;for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}assert.equal(job.code,0);assert.match(job.output,/没有可更新的技能/);assert.ok(job.backup);
  assert.equal((await req('command',{args:['remove','demo','-g']})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/已删除 demo/);assert.equal(job.backup,null);
  await assert.rejects(()=>fs.access(root));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
test('按分组删除与更新：只作用于同一来源的技能，不影响其他来源',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-group-'));
 const roots={alpha:path.join(home,'.agents/skills/alpha'),beta:path.join(home,'.agents/skills/beta'),gamma:path.join(home,'.claude/skills/gamma')};
 for(const [name,root] of Object.entries(roots)){await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\n---\nHello`);}
 // alpha / beta 是本地来源（更新时从来源目录重新复制），gamma 属于另一个来源，分组操作不该碰它。
 const sources={alpha:path.join(home,'src/alpha'),beta:path.join(home,'src/beta')};
 for(const [name,dir] of Object.entries(sources)){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\n---\nHello`);}
 await fs.mkdir(path.join(home,'.agents'),{recursive:true});
 await fs.writeFile(path.join(home,'.agents/.skill-lock.json'),JSON.stringify({version:3,skills:{
  alpha:{source:sources.alpha,sourceType:'local',sourceUrl:sources.alpha,skillPath:'SKILL.md'},
  beta:{source:sources.beta,sourceType:'local',sourceUrl:sources.beta,skillPath:'SKILL.md'},
  gamma:{source:'other/repo',sourceType:'github',sourceUrl:'https://github.com/other/repo.git',skillPath:'gamma/SKILL.md'}
 }},null,2));
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14319;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await req('skills?refresh=1')).data.length,3);
  assert.equal((await req('command',{args:['remove'],group:'missing'})).status,404);
  let job;
  assert.equal((await req('command',{args:['update'],group:'local'})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/已更新 alpha/);assert.match(job.output,/已更新 beta/);assert.ok(job.backup);
  assert.equal((await req('command',{args:['remove'],group:'local'})).status,200);
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0);assert.match(job.output,/已删除 alpha/);assert.match(job.output,/已删除 beta/);
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
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14322;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port)},stdio:'pipe'});
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
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14323;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port)},stdio:'pipe'});
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
test('添加技能：从本地 Git 仓库安装并自动链接到 Agent 目录',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-add-'));
 const work=path.join(home,'src/work');
 await fs.mkdir(path.join(work,'skills/one'),{recursive:true});
 await fs.writeFile(path.join(work,'skills/one/SKILL.md'),'---\nname: one\ndescription: One 技能\n---\n\n# one\n');
 await fs.mkdir(path.join(home,'.claude'),{recursive:true});
 const git=(...args)=>new Promise(resolve=>{const c=spawn('git',args,{cwd:work,stdio:'ignore'});c.on('close',resolve);});
 await git('init','-q','-b','main');await git('add','-A');await git('-c','user.email=t@t','-c','user.name=t','commit','-qm','init');
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14325;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  assert.equal((await req('command',{args:['add','relative/../bad','-g']})).status,400,'无法识别的来源要报错');
  assert.equal((await req('command',{args:['find','react']})).status,400,'社区搜索已移除');
  assert.equal((await req('command',{args:['add',work,'-g']})).status,200);
  let job;for(let i=0;i<200;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0,job.output);assert.match(job.output,/安装 one/);assert.ok(job.backup);
  const rows=(await req('skills?refresh=1')).data;
  const one=rows.find(r=>r.name==='one');
  assert.equal(one.description,'One 技能');assert.equal(one.sourceType,'local');assert.equal(one.source,work);
  assert.equal(one.path,path.join(home,'.agents/skills/one'));
  assert.deepEqual(one.agents,['Claude Code']);
  assert.equal(await fs.readlink(path.join(home,'.claude/skills/one')),path.join('..','..','.agents','skills','one'));
  // 再装一次：同名技能被替换（先备份），不产生第二份。
  assert.equal((await req('command',{args:['add',work,'-g','--skill','one']})).status,200);
  for(let i=0;i<200;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(job.code,0,job.output);
  assert.equal((await fs.readdir(path.join(home,'.agents/skills'))).filter(n=>n==='one').length,1);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
// 列表快照：30 秒 TTL 内不重新扫描（刷新按钮与修改操作除外），读取路径始终用内存快照，
// 不再有「等 CLI」的问题——这里守住「过期才重扫」的约定。
test('列表快照：TTL 内不重扫，refresh 与读取路径按预期工作',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-readpath-')),root=path.join(home,'.agents/skills/demo');
 await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nHello');
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const port=14324;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  const id=(await req('skills?refresh=1')).data[0].id;
  // 磁盘上新加一个技能：TTL 内列表仍用内存快照，refresh 之后才看得到。
  await fs.mkdir(path.join(home,'.agents/skills/late'),{recursive:true});await fs.writeFile(path.join(home,'.agents/skills/late/SKILL.md'),'---\nname: late\ndescription: Late\n---\n');
  assert.equal((await req('skills')).data.length,1);
  const rows2=(await req('skills?refresh=1')).data;assert.equal(rows2.length,2);assert.ok(rows2.some(r=>r.name==='late'));
  // 读取路径（tree / file）直接用快照里的路径。
  const f=(await req('file?id='+id+'&path=SKILL.md')).data;
  assert.equal((await req('file',{id,path:'SKILL.md',content:'saved',version:f.version})).status,200);
  assert.equal((await req('tree?id='+id)).status,200);
  assert.equal((await req('file?id='+id+'&path=SKILL.md')).data.content,'saved');
  // 快照里没有的 id 仍然会刷新一次，找不到才 404。
  assert.equal((await req('tree?id=missing')).status,404);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
