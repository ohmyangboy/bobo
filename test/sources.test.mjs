import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
const node=process.execPath;
test('我的 Skill：目录发现、链接、冲突、删除与 Git 同步',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-mine-')),store=path.join(home,'Desktop/my-skills'),bare=path.join(home,'remote.git');
 await fs.mkdir(path.join(home,'.agents/skills'),{recursive:true});
 const mockGh=path.join(home,'gh');
 await fs.writeFile(mockGh,`#!${node}
import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('gh mock 1.0');process.exit(0);}
if(a[0]==='api'&&a[1]==='user'){console.log('tester');process.exit(0);}
if(a[0]==='repo'&&a[1]==='create'){
 const dir=a[a.indexOf('--source')+1];
 spawnSync('git',['-C',dir,'remote','add','origin',process.env.MOCK_BARE],{stdio:'ignore'});
 const r=spawnSync('git',['-C',dir,'push','-u','origin','main'],{stdio:'ignore'});
 console.log('created');process.exit(r.status??1);
}
console.log('MOCK gh '+JSON.stringify(a));process.exit(0);
`,{mode:0o755});
 await fs.writeFile(path.join(home,'package.json'),'{"type":"module"}');
 const mockOsa=path.join(home,'osascript');
 await fs.writeFile(mockOsa,`#!${node}
import fs from 'node:fs';import path from 'node:path';
const mode=fs.readFileSync(path.join(process.env.HOME,'pick-mode'),'utf8').trim();
if(mode==='cancel'){console.error('execution error: User canceled. (-128)');process.exit(1);}
console.log(mode);
`,{mode:0o755});
 const mockOpen=path.join(home,'open');
 await fs.writeFile(mockOpen,`#!${node}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(home,'open-called'))},process.argv.slice(2).join(' ')+'\\n');
`,{mode:0o755});
 await fs.writeFile(path.join(home,'pick-mode'),'/tmp/picked-store/');
 await new Promise(r=>{const c=spawn('git',['init','--bare',bare],{stdio:'ignore'});c.on('close',r);});
 const port=14320,child=spawn(node,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PATH:home+':'+process.env.PATH,MOCK_BARE:bare,PORT:String(port)},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};

  assert.equal((await req('sources/add',{path:'relative/path'})).status,400);
  // 系统文件夹选择器：返回选中的目录，取消时明确区分。
  assert.deepEqual((await req('sources/pick',{})).data,{path:'/tmp/picked-store'});
  await fs.writeFile(path.join(home,'pick-mode'),'cancel');
  assert.deepEqual((await req('sources/pick',{})).data,{cancelled:true});
  assert.equal((await req('sources/add',{path:'~/.agents/nope'})).status,400);
  assert.equal((await req('sources/add',{path:home})).status,400);
  const added=await req('sources/add',{path:store});assert.equal(added.status,200);assert.equal(added.data.path,await fs.realpath(store));
  assert.equal((await req('sources/add',{path:store})).status,400);
  assert.deepEqual((await req('sources/roots')).data.map(r=>r.path),[await fs.realpath(store)]);
  // 空目录也要能在 Finder 里打开：允许打开已添加的目录，拒绝未添加的。
  assert.equal((await req('open',{dir:store})).status,200);
  assert.equal((await req('open',{dir:path.join(home,'elsewhere')})).status,404);
  let opened='';
  for(let i=0;i<40;i++){opened=await fs.readFile(path.join(home,'open-called'),'utf8').catch(()=>'');if(opened)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(opened.trim(),await fs.realpath(store));
  assert.equal((await req('sources/link',{path:path.join(home,'elsewhere')})).status,404);

  for(const name of ['alpha','beta']){await fs.mkdir(path.join(store,name),{recursive:true});await fs.writeFile(path.join(store,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${name} skill\n---\nHello`);}
  const linked=await req('sources/link',{path:store});assert.deepEqual(linked.data.linked.sort(),['alpha','beta']);
  assert.equal(await fs.realpath(path.join(home,'.agents/skills/alpha')),await fs.realpath(path.join(store,'alpha')));
  const again=await req('sources/link',{path:store});assert.deepEqual(again.data.kept.sort(),['alpha','beta']);

  const rows=(await req('skills?refresh=1')).data;assert.equal(rows.length,2);
  const alpha=rows.find(r=>r.name==='alpha');assert.equal(alpha.mine.root,await fs.realpath(store));assert.equal(alpha.description,'alpha skill');

  await fs.mkdir(path.join(home,'.agents/skills/gamma'),{recursive:true});await fs.writeFile(path.join(home,'.agents/skills/gamma/SKILL.md'),'---\nname: gamma\ndescription: real\n---\n');
  await fs.mkdir(path.join(store,'gamma'),{recursive:true});await fs.writeFile(path.join(store,'gamma/SKILL.md'),'---\nname: gamma\ndescription: mine\n---\n');
  const conflict=await req('sources/link',{path:store});assert.deepEqual(conflict.data.conflicts,['gamma']);assert.equal((await fs.lstat(path.join(home,'.agents/skills/gamma'))).isSymbolicLink(),false);
  // 按需启停：停用只删链接，relink 不复活，启用可恢复；名称冲突不能启用。
  assert.equal((await req('sources/toggle',{path:store,name:'../beta',enabled:false})).status,400);
  assert.equal((await req('sources/toggle',{path:store,name:'beta',enabled:false})).status,200);
  await assert.rejects(()=>fs.lstat(path.join(home,'.agents/skills/beta')));
  assert.equal((await req('sources/roots')).data[0].disabled.includes('beta'),true);
  const paused=await req('sources/link',{path:store});assert.deepEqual(paused.data.kept,['alpha']);assert.deepEqual(paused.data.linked,[]);assert.deepEqual(paused.data.removed,[]);
  await assert.rejects(()=>fs.lstat(path.join(home,'.agents/skills/beta')));
  assert.equal((await req('skills?refresh=1')).data.find(r=>r.name==='beta'&&r.mine).mine.mineStatus,'disabled');
  assert.equal((await req('sources')).data[0].skills.find(s=>s.name==='beta').status,'disabled');
  assert.equal((await req('sources/toggle',{path:store,name:'gamma',enabled:true})).status,400);
  assert.equal((await req('sources/toggle',{path:store,name:'missing',enabled:true})).status,404);
  assert.equal((await req('sources/toggle',{path:store,name:'beta',enabled:true})).status,200);
  assert.equal(await fs.realpath(path.join(home,'.agents/skills/beta')),await fs.realpath(path.join(store,'beta')));
  assert.equal((await req('sources/roots')).data[0].disabled.includes('beta'),false);
  // 本地优先：本地目录里的技能即使没链接上（冲突或还没启用）也要出现在列表里。
  const local=(await req('skills?refresh=1')).data;
  assert.equal(local.filter(r=>r.name==='gamma').length,2);
  const localGamma=local.find(r=>r.name==='gamma'&&r.mine);
  assert.equal(localGamma.mine.mineStatus,'conflict');
  assert.equal(localGamma.path,path.join(await fs.realpath(store),'gamma'));
  await fs.mkdir(path.join(store,'epsilon'),{recursive:true});await fs.writeFile(path.join(store,'epsilon/SKILL.md'),'---\nname: epsilon\ndescription: local only\n---\nHello');
  const withLocal=(await req('skills?refresh=1')).data;
  const eps=withLocal.find(r=>r.name==='epsilon');
  assert.equal(eps.mine.mineStatus,'missing');assert.equal(eps.id.length,20);assert.equal(eps.description,'local only');
  // 已链接但 CLI 因 description 为空而不收录的技能，也要按「已链接」补进列表，不能凭空消失。
  await fs.mkdir(path.join(store,'zeta'),{recursive:true});await fs.writeFile(path.join(store,'zeta/SKILL.md'),'---\nname: zeta\ndescription: \n---\n');
  await fs.symlink(path.join(await fs.realpath(store),'zeta'),path.join(home,'.agents/skills/zeta'));
  const zeta=(await req('skills?refresh=1')).data.find(r=>r.name==='zeta');
  assert.equal(zeta.mine.mineStatus,'linked');

  assert.equal((await req('sources/delete',{path:store,name:'../beta'})).status,400);
  assert.equal((await req('sources/delete',{path:store,name:'missing'})).status,404);
  assert.equal((await req('sources/delete',{path:store,name:'alpha'})).status,200);
  await assert.rejects(()=>fs.access(path.join(store,'alpha')));
  await assert.rejects(()=>fs.lstat(path.join(home,'.agents/skills/alpha')));
  await fs.access(path.join(home,'.agents/skills/gamma'));

  assert.equal((await req('sources/sync',{path:store,mode:'existing',url:'--upload-pack=evil'})).status,400);
  const synced=await req('sources/sync',{path:store,mode:'create',repo:'my-skills',visibility:'private'});
  assert.equal(synced.status,200,synced.data.error);assert.equal(synced.data.committed,true,JSON.stringify(synced.data.steps));assert.match(synced.data.steps.join(' '),/创建私有仓库并推送/);
  const log=await new Promise(resolve=>{const c=spawn('git',['--git-dir',bare,'log','--oneline','main'],{stdio:['ignore','pipe','pipe']});let o='';c.stdout.on('data',d=>o+=d);c.on('close',()=>resolve(o.trim()));});
  assert.match(log,/同步技能/);
  const pushed=await req('sources/sync',{path:store,mode:'existing',url:'file://'+bare});assert.equal(pushed.status,200);assert.equal(pushed.data.committed,false);assert.match(pushed.data.steps.join(' '),/推送/);
  // 一键同步：先启用（补链接）再推送；冲突只报告不覆盖。
  const all=await req('sources/sync-all',{});assert.equal(all.status,200);
  const first=all.data.results[0];
  assert.deepEqual(first.linked,['epsilon']);assert.deepEqual(first.conflicts,['gamma']);assert.equal(first.pushed,true);
  assert.equal(await fs.realpath(path.join(home,'.agents/skills/epsilon')),await fs.realpath(path.join(store,'epsilon')));

  const overview=(await req('sources')).data;assert.equal(overview.length,1);assert.equal(overview[0].exists,true);assert.equal(overview[0].git.initialized,true);assert.equal(overview[0].skills.find(s=>s.name==='beta').status,'linked');assert.equal(overview[0].skills.find(s=>s.name==='gamma').status,'conflict');

  const created=await req('sources/create',{path:store,name:'delta'});assert.equal(created.status,200);
  const deltaMd=await fs.readFile(path.join(store,'delta/SKILL.md'),'utf8');
  assert.match(deltaMd,/name: delta/);assert.match(deltaMd,/^description: .+$/m);
  assert.equal(await fs.realpath(path.join(home,'.agents/skills/delta')),await fs.realpath(path.join(store,'delta')));
  // 新建后必须立刻能在列表里看到（CLI 只收录 description 非空的技能）。
  const afterCreate=(await req('skills?refresh=1')).data;
  assert.ok(afterCreate.some(r=>r.name==='delta'),'新建的技能应出现在列表里');
  assert.equal((await req('sources/create',{path:store,name:'Delta'})).status,400);

  // 命令行 remove 删除「我的技能」时也走同一套逻辑，清理链接而不是留下悬空符号链接。
  await req('skills?refresh=1');
  assert.equal((await req('command',{args:['remove','delta','-g']})).status,200);
  let job;
  for(let i=0;i<100;i++){job=(await req('job')).data;if(!job.running)break;await new Promise(r=>setTimeout(r,30));}
  await assert.rejects(()=>fs.access(path.join(store,'delta')));
  await assert.rejects(()=>fs.lstat(path.join(home,'.agents/skills/delta')));
  assert.match(job.output,/已删除我的技能/);

  // 技能被删除时清理停用名单：重建同名技能默认启用并自动链接。
  assert.equal((await req('sources/create',{path:store,name:'theta'})).status,200);
  assert.equal((await req('sources/toggle',{path:store,name:'theta',enabled:false})).status,200);
  assert.equal((await req('sources/roots')).data[0].disabled.includes('theta'),true);
  assert.equal((await req('sources/delete',{path:store,name:'theta'})).status,200);
  assert.equal((await req('sources/roots')).data[0].disabled.includes('theta'),false);
  assert.equal((await req('sources/create',{path:store,name:'theta'})).status,200);
  assert.equal(await fs.realpath(path.join(home,'.agents/skills/theta')),await fs.realpath(path.join(store,'theta')));

  const removed=await req('sources/remove',{path:store});assert.equal(removed.status,200);
  await assert.rejects(()=>fs.lstat(path.join(home,'.agents/skills/beta')));
  await fs.access(path.join(store,'beta'));
  assert.equal((await req('skills?refresh=1')).data.filter(r=>r.name==='beta').length,0);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
