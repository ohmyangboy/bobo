import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {createSkills,parseSkill,sanitizeName} from '../src/skills.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const git=(cwd,...args)=>spawnSync('git',args,{cwd,encoding:'utf8'});
const commit=(cwd,message)=>{git(cwd,'add','-A');return git(cwd,'-c','user.email=t@t','-c','user.name=t','commit','-qm',message);};
const write=(dir,name,body)=>fs.mkdir(dir,{recursive:true}).then(()=>fs.writeFile(path.join(dir,name),body));
const skillBody=(name,description)=>`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

// 一个临时 HOME：canonical 里有正常技能、缺 description 的目录、指向别处的「我的技能」链接；
// 另外放两个 Agent 目录（Claude Code 需要链接，Gemini CLI 是通用 Agent、直接读 canonical）。
async function fixture(){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-skills-'));
 const env={...process.env,HOME:home};
 const skills=createSkills({home,env,fail});
 await write(path.join(home,'.agents/skills/alpha'),'SKILL.md',skillBody('alpha','Alpha 技能'));
 await write(path.join(home,'.agents/skills/broken'),'SKILL.md','# 没有 frontmatter\n');
 await write(path.join(home,'.claude'),'keep','');
 await write(path.join(home,'.gemini'),'keep','');
 const outside=path.join(home,'Desktop/my-skills/omega');
 await write(outside,'SKILL.md',skillBody('omega','我的技能'));
 await fs.symlink(outside,path.join(home,'.agents/skills/omega'));
 await fs.writeFile(path.join(home,'.agents/.skill-lock.json'),JSON.stringify({version:3,skills:{alpha:{source:'someone/repo',sourceType:'github',sourceUrl:'https://github.com/someone/repo.git'}}},null,2));
 return {home,env,skills};
}
const clean=home=>fs.rm(home,{recursive:true,force:true});

test('技能库：扫描收录规则、Agent 链接状态与来源',async()=>{
 const {home,env,skills}=await fixture();
 try{
  const rows=await skills.scan();
  // 缺 frontmatter 的目录不收录；「我的技能」链接要收进来（由 server.mjs 标成 mine）。
  assert.deepEqual(rows.map(r=>r.name).sort(),['alpha','omega']);
  const alpha=rows.find(r=>r.name==='alpha');
  assert.equal(alpha.path,path.join(home,'.agents/skills/alpha'));
  // 通用 Agent 直接读 canonical，非通用 Agent 要有链接才算；此时还没链接。
  assert.deepEqual(alpha.agents,['Gemini CLI']);
  assert.equal(alpha.source,'someone/repo');assert.equal(alpha.sourceType,'github');
  // 只检测到已安装的 Agent：没有 ~/.codex 就不该出现 Codex。
  assert.ok(!alpha.agents.includes('Codex'));
  // 非通用 Agent 需要链接：link 之后 Claude Code 目录里会出现相对链接，重新扫描就能看到它。
  const report=await skills.link('alpha',await skills.liveAgents());
  assert.deepEqual(report.linked,['Claude Code']);
  assert.equal(await fs.readlink(path.join(home,'.claude/skills/alpha')),path.join('..','..','.agents','skills','alpha'));
  assert.equal((await fs.lstat(path.join(home,'.gemini/skills/alpha')).catch(()=>null)),null,'通用 Agent 不建链接');
  assert.deepEqual((await skills.scan()).find(r=>r.name==='alpha').agents,['Claude Code','Gemini CLI']);
  assert.deepEqual((await skills.link('alpha',await skills.liveAgents())).kept,['Claude Code']);
  // 同名冲突不覆盖。
  await write(path.join(home,'.claude/skills/broken'),'SKILL.md',skillBody('broken','真的技能'));
  assert.deepEqual((await skills.link('broken',await skills.liveAgents())).conflicts,['Claude Code']);
 }finally{await clean(home);}
});

test('技能库：安装、更新、删除与新建',async()=>{
 const {home,env,skills}=await fixture();
 // 来源仓库：skills/ 下的技能 + 根目录技能 + 缺 description 的目录 + 同名重复。
 const work=path.join(home,'src/work'),remote=path.join(home,'src/remote.git');
 await write(path.join(work,'skills/delta'),'SKILL.md',skillBody('delta','Delta 技能'));
 await write(path.join(work,'epsilon'),'SKILL.md','---\nname: epsilon\ndescription: >-\n  折成\n  一行的描述\n---\n\n# epsilon\n');
 await write(path.join(work,'junk'),'SKILL.md','---\nname: junk\n---\n');
 await write(path.join(work,'skills/delta/deep'),'SKILL.md',skillBody('deep','不应被收录'));
 git(work,'init','-q','-b','main');commit(work,'init');
 git(home,'clone','-q','--bare',work,remote);
 const url='file://'+remote;
 try{
  const added=await skills.add({source:url});
  assert.deepEqual(added.installed.map(i=>i.name).sort(),['delta','epsilon']);
  assert.deepEqual((await fs.readdir(skills.canonicalDir)).sort(),['alpha','broken','delta','epsilon','omega']);
  assert.equal(await fs.readFile(path.join(skills.canonicalDir,'delta/SKILL.md'),'utf8'),skillBody('delta','Delta 技能'));
  const claude=await fs.readdir(path.join(home,'.claude/skills'));
  assert.ok(claude.includes('delta')&&claude.includes('epsilon'),'安装后要链接到 Agent 目录');
  const lock=(await skills.readLock()).skills;
  assert.equal(lock.delta.sourceType,'git');assert.equal(lock.delta.sourceUrl,url);
  assert.equal(lock.delta.skillPath,'skills/delta/SKILL.md');
  assert.match(lock.delta.skillFolderHash,/^[0-9a-f]{40}$/,'git 来源写 tree hash');
  assert.equal(lock.epsilon.skillPath,'epsilon/SKILL.md');
  assert.equal(JSON.parse(await fs.readFile(skills.lockFile,'utf8')).version,3);
  // 只装指定技能；名字大小写不敏感。
  const one=await skills.add({source:url,skill:'DELTA'});
  assert.deepEqual(one.installed.map(i=>i.name),['delta']);
  await assert.rejects(()=>skills.add({source:url,skill:'nope'}),/可选/);
  // 本地目录来源：不经过 git clone。
  const local=path.join(home,'src/local-skills');
  await write(path.join(local,'zeta'),'SKILL.md',skillBody('zeta','本地技能'));
  assert.deepEqual((await skills.add({source:local})).installed.map(i=>i.name),['zeta']);
  assert.equal((await skills.readLock()).skills.zeta.sourceType,'local');
  // 更新：远端没动就是 unchanged，改了才替换并重新链接。
  assert.deepEqual((await skills.update()).updated,[]);
  assert.deepEqual((await skills.update()).unchanged.sort(),['delta','epsilon','zeta']);
  await write(path.join(work,'skills/delta'),'SKILL.md',skillBody('delta','Delta 技能 v2'));
  commit(work,'v2');git(work,'push','-q',remote,'main');
  const updated=await skills.update(['delta']);
  assert.deepEqual(updated.updated,['delta']);assert.deepEqual(updated.unchanged,[]);
  assert.match(await fs.readFile(path.join(skills.canonicalDir,'delta/SKILL.md'),'utf8'),/v2/);
  assert.equal((await skills.update()).updated.length,0,'更新后记录新 hash，不应重复更新');
  // 本地来源的技能按内容比对更新。
  await write(path.join(local,'zeta'),'SKILL.md',skillBody('zeta','本地技能 v2'));
  assert.deepEqual((await skills.update(['zeta'])).updated,['zeta']);
  assert.match(await fs.readFile(path.join(skills.canonicalDir,'zeta/SKILL.md'),'utf8'),/v2/);
  // 新建：名称校验、重复报错、生成模板并链接。
  assert.equal((await skills.init('theta')).report.linked[0],'Claude Code');
  assert.match(await fs.readFile(path.join(skills.canonicalDir,'theta/SKILL.md'),'utf8'),/^description: .+$/m);
  await assert.rejects(()=>skills.init('Theta'),/小写字母/);
  await assert.rejects(()=>skills.init('theta'),/已存在/);
  // 删除：清 canonical、Agent 链接与 lock 记录，按显示名（含大小写）也能删。
  await skills.remove('epsilon');
  assert.equal((await fs.readdir(skills.canonicalDir)).includes('epsilon'),false);
  assert.equal((await fs.readdir(path.join(home,'.claude/skills'))).includes('epsilon'),false);
  assert.equal('epsilon' in (await skills.readLock()).skills,false);
  await assert.rejects(()=>skills.remove('missing'),/不存在/);
  // 「我的技能」的链接不能从这里删掉。
  await assert.rejects(()=>skills.remove('omega'),/我的技能/);
  // 同名「我的技能」也不能被安装覆盖。
  await assert.rejects(()=>skills.add({source:local,skill:'zeta'}).then(async()=>{await fs.rm(path.join(skills.canonicalDir,'zeta'),{recursive:true,force:true});await fs.symlink(path.join(local,'zeta'),path.join(skills.canonicalDir,'zeta'));return skills.add({source:local,skill:'zeta'});}),/我的技能/);
 }finally{await clean(home);}
});

test('技能库：来源写法与 frontmatter 解析',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-parse-'));
 const skills=createSkills({home,env:{HOME:home},fail});
 try{
  assert.deepEqual(skills.parseSource('vercel-labs/agent-skills'),{type:'github',source:'vercel-labs/agent-skills',url:'https://github.com/vercel-labs/agent-skills.git',local:null,ref:null,subpath:null});
  assert.deepEqual(skills.parseSource('https://github.com/owner/repo/tree/main/skills/foo'),{type:'github',source:'owner/repo',url:'https://github.com/owner/repo.git',local:null,ref:'main',subpath:'skills/foo'});
  assert.equal(skills.parseSource('git@github.com:owner/repo.git#dev').ref,'dev');
  assert.equal(skills.parseSource('https://gitlab.com/org/repo.git').type,'git');
  assert.equal(skills.parseSource('/tmp/some/dir').type,'local');
  assert.equal(skills.parseSource('~/skills').local,path.join(home,'skills'));
  assert.throws(()=>skills.parseSource('乱七八糟'),/无法识别/);
  assert.deepEqual(parseSkill(skillBody('a','b')),{name:'a',description:'b',internal:false},'普通 frontmatter');
  assert.equal(parseSkill('---\nname: a\ndescription: |\n  第一行\n  第二行\n---\n').description,'第一行 第二行');
  assert.equal(parseSkill('---\nname: a\ndescription: b\nmetadata:\n  internal: true\n---\n').internal,true);
  assert.equal(parseSkill('# 没有声明块'),null);
  assert.equal(sanitizeName('My Skill!'),'my-skill');
  assert.equal(sanitizeName('---'),'unnamed-skill');
 }finally{await clean(home);}
});
