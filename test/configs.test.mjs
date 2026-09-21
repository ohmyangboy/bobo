import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
test('全局配置：白名单、读取、创建、版本冲突、备份、符号链接与 AI 文档',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-configs-')),ocDir=path.join(home,'.config/opencode'),cxDir=path.join(home,'.codex');
 await fs.mkdir(ocDir,{recursive:true});await fs.mkdir(cxDir,{recursive:true});
 await fs.writeFile(path.join(ocDir,'AGENTS.md'),'# 全局规则\n\n保持简洁。');
 await fs.writeFile(path.join(ocDir,'opencode.json'),'{"$schema":"https://opencode.ai/config.json"}');
 await fs.writeFile(path.join(cxDir,'config.toml'),'model = "gpt-5"\n');
 await fs.writeFile(path.join(home,'outside.md'),'# Outside\n');
 await fs.symlink(path.join(home,'outside.md'),path.join(cxDir,'AGENTS.md'));
 // Claude Code 只建目录、还没有配置文件：不算已安装（状态点灰色）。
 // omp / dsh 的配置目录分别由 PI_CODING_AGENT_DIR / DSH_HOME 指定，各预置一份主配置。
 const claudeDir=path.join(home,'.claude'),ompDir=path.join(home,'omp-agent'),dshDir=path.join(home,'.dsh');
 await fs.mkdir(claudeDir,{recursive:true});
 await fs.mkdir(ompDir,{recursive:true});await fs.writeFile(path.join(ompDir,'config.yml'),'modelRoles:\n  default: deepseek\n');
 await fs.mkdir(dshDir,{recursive:true});await fs.writeFile(path.join(dshDir,'settings.yaml'),'locale:\n  preference: zh\n');
 const port=14322;const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env:{...process.env,BOBO_HOME:home,PORT:String(port),PI_CODING_AGENT_DIR:ompDir,DSH_HOME:dshDir},stdio:'pipe'});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
  const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
  const req=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
  // OpenCode：四项核心文件；读到的存在状态与格式正确。
  const oc=(await req('configs?provider=opencode')).data;
  assert.equal(oc.label,'OpenCode');assert.equal(oc.dir,ocDir);
  const ocBy=Object.fromEntries(oc.files.map(f=>[f.key,f]));
  assert.deepEqual(Object.keys(ocBy).sort(),['AGENTS.md','cli.json','opencode.json','opencode.jsonc']);
  assert.equal(ocBy['AGENTS.md'].exists,true);assert.equal(ocBy['AGENTS.md'].format,'markdown');
  assert.equal(ocBy['opencode.json'].exists,true);assert.equal(ocBy['cli.json'].exists,false);
  // Codex：两项，符号链接标出来。
  const cx=(await req('configs?provider=codex')).data;
  assert.deepEqual(cx.files.map(f=>f.key),['AGENTS.md','config.toml']);
  assert.equal(cx.files.find(f=>f.key==='AGENTS.md').link,true);
  assert.equal(cx.files.find(f=>f.key==='config.toml').exists,true);
  // omp / dsh：配置目录来自环境变量，文件清单认得出来。
  const omp=(await req('configs?provider=omp')).data;
  assert.equal(omp.dir,ompDir);assert.deepEqual(omp.files.map(f=>f.key),['config.yml','config.yaml','PERSONALITY.md']);
  assert.equal(omp.files.find(f=>f.key==='config.yml').exists,true);assert.equal(omp.files.find(f=>f.key==='PERSONALITY.md').exists,false);
  const dsh=(await req('configs?provider=dsh')).data;
  assert.equal(dsh.dir,dshDir);assert.deepEqual(dsh.files.map(f=>f.key),['settings.yaml']);assert.equal(dsh.files[0].exists,true);
  const agy=(await req('configs?provider=agy')).data;
  assert.equal(agy.label,'Antigravity');assert.deepEqual(agy.files.map(f=>f.key),['GEMINI.md','settings.json','antigravity-cli/settings.json','config/config.json','config/hooks.json','config/mcp_config.json']);
  // 来源清单：只收录「通知岛」已接入的 harness（OpenCode / Codex / Claude Code / omp / dsh / agy），每个都有真实品牌图标；
  // installed 要求「配置目录 + 至少一份配置文件」同时存在。
  const providers=(await req('configs/providers')).data.providers,provById=Object.fromEntries(providers.map(p=>[p.id,p]));
  assert.deepEqual(providers.map(p=>p.id).sort(),['agy','claude','codex','dsh','omp','opencode']);
  assert.equal(provById.opencode.agents,'opencode');assert.equal(provById.codex.agents,'codex');assert.equal(provById.claude.agents,null);
  assert.equal(provById.opencode.installed,true);assert.equal(provById.opencode.dir,ocDir);
  assert.equal(provById.claude.installed,false,'只有目录、没有配置文件的来源不该亮绿灯');
  for(const p of providers)assert.ok(p.icon,'来源需要真实品牌图标：'+p.id);
  // 未接入通知岛的 Agent 暂时不开放。
  for(const id of ['gemini','qwen','droid','copilot','trae','qoder','windsurf','cursor','continue','goose','crush','amp','zed'])assert.equal(provById[id],undefined,'未接入通知岛的 '+id+' 不该出现');
  // 补上一份配置文件后 Claude Code 才算已安装。
  await fs.writeFile(path.join(claudeDir,'settings.json'),'{}\n');
  const again=(await req('configs/providers')).data.providers;
  assert.equal(again.find(p=>p.id==='claude').installed,true);
  // 非法来源 / 键被拒绝。
  assert.equal((await req('configs?provider=nope')).status,400);
  assert.equal((await req('configs/file?provider=opencode&key=../AGENTS.md')).status,400);
  // 读取：存在的文件带版本，缺失的文件 exists:false 且 version 为空。
  const agentsFile=(await req('configs/file?provider=opencode&key=AGENTS.md')).data;
  assert.equal(agentsFile.exists,true);assert.match(agentsFile.content,/保持简洁/);assert.ok(agentsFile.version);
  const missing=(await req('configs/file?provider=opencode&key=cli.json')).data;
  assert.equal(missing.exists,false);assert.equal(missing.content,'');assert.equal(missing.version,null);
  // 符号链接只读：读取不返回内容，保存被拒绝。
  const linked=(await req('configs/file?provider=codex&key=AGENTS.md')).data;
  assert.equal(linked.exists,true);assert.equal(linked.link,true);assert.equal(linked.content,'');
  assert.equal((await req('configs/save',{provider:'codex',key:'AGENTS.md',content:'x',version:null})).status,400);
  // 版本冲突与正常保存（先备份）。
  assert.equal((await req('configs/save',{provider:'opencode',key:'AGENTS.md',content:'x',version:'old'})).status,409);
  const saved=await req('configs/save',{provider:'opencode',key:'AGENTS.md',content:'# 更新\n',version:agentsFile.version});
  assert.equal(saved.status,200);assert.equal(saved.data.created,false);
  await fs.access(path.join(saved.data.backup,'manifest.json'));
  assert.equal(await fs.readFile(path.join(ocDir,'AGENTS.md'),'utf8'),'# 更新\n');
  // 未创建的文件：version 非空时拒绝，version 为空时创建。
  assert.equal((await req('configs/save',{provider:'opencode',key:'cli.json',content:'{}',version:'x'})).status,409);
  const created=await req('configs/save',{provider:'opencode',key:'cli.json',content:'{}\n',version:null});
  assert.equal(created.status,200);assert.equal(created.data.created,true);
  assert.equal(await fs.readFile(path.join(ocDir,'cli.json'),'utf8'),'{}\n');
  // 接入 AI 阅读器：id 用 provider:key，缺失的 id 404，非法模式 400。
  const aiDoc=(await req('ai/config/document?id='+encodeURIComponent('opencode:AGENTS.md'))).data;
  assert.equal(aiDoc.path,'AGENT.md');assert.ok(Array.isArray(aiDoc.blocks)&&aiDoc.blocks.length>0);assert.equal(aiDoc.summary,null);
  assert.equal((await req('ai/config/document?id='+encodeURIComponent('opencode:cli.json'))).status,200);
  assert.equal((await req('ai/config/document?id='+encodeURIComponent('nope:AGENTS.md'))).status,400);
  assert.equal((await req('ai/config/generate',{id:'opencode:AGENTS.md',mode:'bad'})).status,400);
  // 备份共用「最近 3 份」配额。
  assert.ok((await fs.readdir(path.join(home,'.bobo','backups'))).length<=3,'全局配置与技能、智能体共用配额');
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});}
});
