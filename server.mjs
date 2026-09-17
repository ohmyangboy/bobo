import http from 'node:http';
import {createSkillReader,createAgentReader,createCodexAgentReader} from './reader-ai.mjs';
import { createAI } from './ai.mjs';
import { createSources } from './sources.mjs';
import { createAgents } from './agents.mjs';
import { createCodexAgents } from './codex-agents.mjs';
import { createOpenCode } from './opencode.mjs';
import { createCodex } from './codex.mjs';
import { createUsage } from './usage.mjs';
import { createOtty } from './otty.mjs';
import { pruneBackups } from './backups.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const home=process.env.BOBO_HOME||os.homedir();
const ai=createAI(home);
const reader=createSkillReader({home,ai,resolveSkill:skill});
const port=Number(process.env.PORT||4318), token=randomBytes(24).toString('hex');
const env={...process.env,HOME:home,NO_COLOR:'1',CI:'1'};
const npx=process.env.BOBO_NPX||'npx';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const sources=createSources({home,env,fail});
const agents=createAgents({home,fail});
const agentReader=createAgentReader({home,ai,resolveAgent:id=>agents.file(id)});
// Codex CLI 的自定义智能体同样是单个定义文件，只是格式为 TOML；读写与 AI 缓存都和 OpenCode 智能体分开。
const codexAgents=createCodexAgents({home,fail});
const codexReader=createCodexAgentReader({home,ai,resolveAgent:id=>codexAgents.file(id)});
// 点击会话时把焦点切换到 Otty 里对应的标签页（找不到就打开 Otty）；也用来判断会话结束后用户看过终端没有。
const otty=createOtty();
// 监听本机 OpenCode 的事件流，状态变化推送给网页与刘海面板。
const opencode=createOpenCode({home});
opencode.start();
// Codex CLI 没有事件流服务，改为轮询 ~/.codex/sessions 推导会话状态；提醒复用通知岛的开关与音效。
const codex=createCodex({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
codex.start();
// 两个 Agent 的会话合成一份列表：各自模块给出 order（按最近一次状态变更），这里统一倒序后截断。
function sessionsMerged(){return [...opencode.snapshot().sessions,...codex.snapshot().sessions].sort((a,b)=>(b.order??0)-(a.order??0)).slice(0,40);}
// 状态流与 /api/opencode 共用的快照：OpenCode 的设置 / 连接 / 通知 + 合并后的会话 + Codex 连接信息。
function islandSnapshot(){return {...opencode.snapshot(),sessions:sessionsMerged(),codex:codex.snapshot()};}
// 结束 / 终止的头像要留到用户看过终端才收起：Otty 在前台且正停在那个标签页时算已查看；
// 手动切标签页与点会话行跳过去（/api/opencode/focus）命中同一套匹配。
async function ackViewed(){for(const id of await otty.viewed([...opencode.unviewed(),...codex.unviewed()])){if(!opencode.acknowledge(id))codex.acknowledge(id);}}
setInterval(()=>{ackViewed().catch(()=>{});},3000);
// 用量：从本机 OpenCode 数据库估算 OpenCode Go 的额度（只读，不联网），随事件流一起推给刘海面板。
const usage=createUsage({home});
usage.start();
let catalog=[], catalogTime=0, job=null, busy=false;
const dataDir=path.join(home,'.bobo');
// 改名迁移：把旧的 ~/.skills-manager 里的每一项搬到 ~/.bobo；新目录里已有的项不覆盖。
for(const entry of await fs.readdir(path.join(home,'.skills-manager'),{withFileTypes:true}).catch(()=>[])){
 const from=path.join(home,'.skills-manager',entry.name),to=path.join(dataDir,entry.name);
 if(await fs.access(to).then(()=>true,()=>false))continue;
 try{await fs.mkdir(dataDir,{recursive:true});await fs.rename(from,to);}
 catch(e){console.warn('迁移旧数据 '+entry.name+' 失败：'+e.message);}
}
const catalogFile=path.join(dataDir,'catalog.json');
// 备份保留最近 3 份：启动时先清理一次历史遗留，之后每次创建备份再淘汰最旧的。
await pruneBackups(path.join(dataDir,'backups'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const relPath=v=>typeof v==='string'&&v?v:'SKILL.md';
async function command(args,cwd=home,onData=()=>{}) {
 // CLI 会立即退出；JSON 使用普通文件接收，避免管道尚未排空时被截断。
 const capture=args[0]==='list'&&args.includes('--json');
 const tmp=capture?await fs.mkdtemp(path.join(os.tmpdir(),'skills-json-')):null;
 const outputFile=tmp?await fs.open(path.join(tmp,'output'),'w+'):null;
 return new Promise((resolve,reject)=>{
  const child=spawn(npx,['--yes','skills',...args],{cwd,env,shell:false,stdio:['ignore',outputFile?outputFile.fd:'pipe','pipe']});
  let output='',stdout=''; const collect=b=>{const s=b.toString();output=(output+s).slice(-1000000);onData(s);};
  child.stdout?.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout?.on('data',s=>{stdout+=s;collect(s);});child.stderr.on('data',collect);
  const timer=setTimeout(()=>child.kill('SIGTERM'),600000);
  let spawnError;child.on('error',e=>{spawnError=e;});
  child.on('close',async(code,signal)=>{
   clearTimeout(timer);
   try{
    if(outputFile){await outputFile.close();stdout=await fs.readFile(path.join(tmp,'output'),'utf8');collect(stdout);}
    if(spawnError)reject(spawnError);else resolve({code:code??1,signal,output,stdout});
   }catch(e){reject(e);}finally{if(tmp)await fs.rm(tmp,{recursive:true,force:true});}
  });
 });
}
async function list(force=false){
 if(!force&&catalogTime>Date.now()-30000)return catalog;
 const r=await command(['list','-g','--json']);
 if(r.code!==0)fail(r.output||'无法运行 npx skills',500);
 let rows;try{rows=JSON.parse(r.stdout);}catch(e){fail('Skills CLI 未返回完整 JSON：'+e.message+'；长度 '+r.stdout.length+'；结尾 '+r.stdout.slice(-100),500);}
 const previous=catalog,roots=await sources.roots(),covered=new Set();
 catalog=await Promise.all(rows.map(async r=>{
  let content='';try{content=await fs.readFile(path.join(r.path,'SKILL.md'),'utf8');}catch{}
  const description=content.match(/^description:[ \t]*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g,'')||'';
  const row={...r,id:hash(r.path).slice(0,20),description};
  const real=await fs.realpath(r.path).catch(()=>null);
  if(real)covered.add(real);
  const root=real&&roots.find(x=>real===x.path||real.startsWith(x.path+path.sep));
  if(root)row.mine={root:root.path,name:root.name||path.basename(root.path),repo:root.repo||null,mineStatus:'linked'};
  return row;
 }));
 // 本地优先：源目录里的技能只要 CLI 没列出就补上（未链接、名称冲突，或已链接但 SKILL.md 不符合 CLI 解析规则，例如缺少 description）。
 for(const root of roots){
  let entries=[];try{entries=await sources.entries(root.path,new Set(root.disabled||[]));}catch{continue;}
  for(const e of entries){
   const real=await fs.realpath(e.path).catch(()=>e.path);
   if(covered.has(e.path)||covered.has(real))continue;
   let content='';try{content=await fs.readFile(path.join(e.path,'SKILL.md'),'utf8');}catch{}
   const description=content.match(/^description:[ \t]*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g,'')||'';
   catalog.push({name:e.name,path:e.path,agents:[],source:null,description,id:hash(e.path).slice(0,20),mine:{root:root.path,name:root.name||path.basename(root.path),repo:root.repo||null,mineStatus:e.status}});
  }
 }
 await reader.invalidate(previous.filter(s=>!catalog.some(n=>n.id===s.id)).map(s=>s.id));catalogTime=Date.now();
 try{await fs.mkdir(path.dirname(catalogFile),{recursive:true});await fs.writeFile(catalogFile+'.tmp',JSON.stringify(catalog));await fs.rename(catalogFile+'.tmp',catalogFile);}catch{}
 return catalog;
}
async function startup(){
 if(catalogTime)return {skills:await list(),cached:false};
 try{
  const snapshot=JSON.parse(await fs.readFile(catalogFile,'utf8'));
  if(!Array.isArray(snapshot)||!snapshot.every(s=>typeof s.path==='string'&&typeof s.name==='string'&&Array.isArray(s.agents)))throw Error('无效快照');
  const present=await Promise.all(snapshot.map(async s=>{try{await fs.access(path.join(s.path,'SKILL.md'));return s;}catch{return null;}}));
  catalog=present.filter(Boolean);catalogTime=Date.now();return {skills:catalog,cached:true};
 }catch{return {skills:await list(true),cached:false};}
}
// 读取路径（tree / file / ai/document）优先用内存里的快照：点一次技能不该同步等 CLI，
// 否则会卡住文件树与阅读区；快照里找不到（技能被外部增删）才刷新一次。
async function skill(id){let r=catalog.find(s=>s.id===id);if(!r)r=(await list()).find(s=>s.id===id);if(!r)fail('技能不存在，请刷新',404);return r;}
async function safeFile(s,rel){
 if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||rel.split(/[\\/]/).some(x=>x==='..'||x.startsWith('.')))fail('无效文件路径');
 const root=await fs.realpath(s.path),target=path.resolve(root,rel);
 if(!target.startsWith(root+path.sep))fail('路径超出技能目录');
 let current=root;
 for(const part of rel.split('/')){
  current=path.join(current,part);
  try{const st=await fs.lstat(current);if(st.isSymbolicLink())fail('不允许编辑符号链接');}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return target;
}
async function tree(root,base='',depth=0){
 if(depth>8)return [];
 const out=[];
 for(const e of (await fs.readdir(path.join(root,base),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(e.name.startsWith('.')||e.name==='node_modules')continue;
  const rel=path.join(base,e.name);
  if(e.isDirectory())out.push(...await tree(root,rel,depth+1));
  else if(e.isFile())out.push({path:rel,size:(await fs.stat(path.join(root,rel))).size});
  if(out.length>2000)break;
 }return out;
}
// 创建一份备份（技能目录 + 锁文件）并淘汰最旧的，只保留最近 3 份。
async function backup(skills,label){
 const dest=path.join(home,'.bobo','backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+label);
 await fs.mkdir(dest,{recursive:true});
 const manifest=[];
 for(const s of skills){
  const name=hash(s.path).slice(0,12);await fs.cp(await fs.realpath(s.path),path.join(dest,name),{recursive:true,dereference:false});
  manifest.push({original:s.path,backup:name,agents:s.agents});
 }
 try{await fs.copyFile(path.join(home,'.agents','.skill-lock.json'),path.join(dest,'.skill-lock.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));
 await pruneBackups(path.join(home,'.bobo','backups'));
 return dest;
}
function normalize(args){
 if(!Array.isArray(args)||!args.length||args.some(a=>typeof a!=='string'||a.length>2000||/[\x00-\x1f]/.test(a)))fail('命令参数无效');
 args=[...args];if(args[0]==='npx')args.shift();if(args[0]==='skills')args.shift();
 const verb=args[0];if(!['list','find','add','remove','update','init','--help','--version'].includes(verb))fail('支持 list、find、add、remove、update、init、--help、--version');
 if(args.includes('-p')||args.includes('--project'))fail('此界面管理全局技能，请使用 -g');
 if(['list','add','remove','update'].includes(verb)&&!args.includes('-g')&&!args.includes('--global'))args.push('-g');
 if(['add','remove','update'].includes(verb)&&!args.includes('-y')&&!args.includes('--yes'))args.push('-y');
 if(verb==='find'&&(args.length<2||args[1].startsWith('-')))fail('请输入搜索关键词');
 if(verb==='add'&&(args.length<2||args[1].startsWith('-')))fail('请输入技能来源');
 if(verb==='remove'&&!args.slice(1).some(a=>!a.startsWith('-'))&&!args.includes('--all'))fail('请输入要删除的技能名称');
 if(verb==='init'&&(args.length!==2||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(args[1])))fail('技能名称只能包含小写字母、数字和短横线');
 return args;
}
async function body(req){let text='';for await(const b of req){text+=b;if(text.length>1100000)fail('内容超过 1 MB',413);}return JSON.parse(text||'{}');}
async function mutate(fn){if(busy)fail('另一个操作正在运行',409);busy=true;try{return await fn();}finally{busy=false;}}
// 目录/链接变化会影响技能列表，成功后让快照失效。
const sourcesMutate=fn=>mutate(async()=>{try{return await fn();}finally{catalogTime=0;}});
const server=http.createServer(async(req,res)=>{
 const json=(obj,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
 try{
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))fail('无效 Host',403);
  const url=new URL(req.url,'http://'+req.headers.host);
  if(url.pathname.startsWith('/api/')){
   if(req.headers['x-bobo-token']!==token)fail('请刷新页面后重试',403);
   if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)fail('跨站请求被拒绝',403);
   if(req.method==='GET'&&url.pathname==='/api/startup')return json(await startup());
   if(req.method==='GET'&&url.pathname==='/api/skills')return json(await list(url.searchParams.has('refresh')));
   if(req.method==='GET'&&url.pathname==='/api/sources')return json(await sources.overview());
   if(req.method==='GET'&&url.pathname==='/api/sources/roots')return json(await sources.roots());
   if(req.method==='GET'&&url.pathname==='/api/ai/document')return json(await reader.document(url.searchParams.get('id'),relPath(url.searchParams.get('path'))));
   if(req.method==='GET'&&url.pathname==='/api/ai/agent/document')return json(await agentReader.document(url.searchParams.get('id')));
   if(req.method==='GET'&&url.pathname==='/api/ai/codex/document')return json(await codexReader.document(url.searchParams.get('id')));
   if(req.method==='GET'&&url.pathname==='/api/ai/settings')return json(await ai.status());
   if(req.method==='GET'&&url.pathname==='/api/agents')return json(await agents.list());
   if(req.method==='GET'&&url.pathname==='/api/agents/file')return json(await agents.file(url.searchParams.get('id')));
   if(req.method==='GET'&&url.pathname==='/api/codex/agents')return json(await codexAgents.list());
   if(req.method==='GET'&&url.pathname==='/api/codex/agents/file')return json(await codexAgents.file(url.searchParams.get('id')));
   if(req.method==='GET'&&url.pathname==='/api/job')return json(job);
   if(req.method==='GET'&&url.pathname==='/api/opencode')return json(islandSnapshot());
   if(req.method==='GET'&&url.pathname==='/api/usage')return json(url.searchParams.has('refresh')?await usage.refresh():usage.snapshot());
   // 状态流：先推一次当前快照，之后每次变化推一份新快照（体积小，前端直接整份替换）。
   // 用量也挂在同一份快照里（`usage` 字段），刘海面板不用另外轮询。
   if(req.method==='GET'&&url.pathname==='/api/opencode/stream'){
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send=()=>{if(!res.destroyed)res.write(JSON.stringify({...islandSnapshot(),usage:usage.snapshot()})+'\n');};
    send();
    const stop=opencode.subscribe(send),stopUsage=usage.subscribe(send),stopCodex=codex.subscribe(send);
    const close=()=>{stop();stopUsage();stopCodex();};
    req.on('close',close);res.on('close',close);
    return;
   }
   if(req.method==='GET'&&url.pathname==='/api/tree'){const s=await skill(url.searchParams.get('id'));return json(await tree(s.path));}
   if(req.method==='GET'&&url.pathname==='/api/file'){
    const file=await safeFile(await skill(url.searchParams.get('id')),url.searchParams.get('path'));
    const st=await fs.stat(file);if(st.size>1000000)fail('文件超过 1 MB，请在 Finder 中打开');
    const b=await fs.readFile(file);if(b.includes(0))fail('二进制文件，请在 Finder 中打开');return json({content:b.toString('utf8'),version:hash(b)});
   }
   if(req.method!=='POST')fail('不存在的接口',404);
   const b=await body(req);
   if(url.pathname==='/api/ai/settings')return json(await ai.save(b));
   if(url.pathname==='/api/opencode/settings')return json(await opencode.saveSettings(b));
   // 刘海额度指示显示哪一家：{next:true} 循环切换（只在开启的来源里），或指定 {id}；选择保存在 ~/.bobo/usage.json。
   if(url.pathname==='/api/usage/provider')return json(b.next?usage.cycleProvider():usage.selectProvider(b.id));
   // 来源启停：关掉的来源不参与刘海胶囊的切换循环。
   if(url.pathname==='/api/usage/enabled')return json(usage.setEnabled(b.id,b.enabled));
   // 手动填写 / 清除 OpenCode Go 的 API Key（保存前先调一次接口验证）。
   if(url.pathname==='/api/usage/key')return json(b.clear?{ok:true,message:'已清除手动 Key，改回读取本机登录',snapshot:await usage.clearKey()}:await usage.setKey(b.key));
   // 点会话跳 Otty：真的切到了那个标签页（用户看到了终端）才算「已查看」，结束/终止的头像才会消失。
   if(url.pathname==='/api/opencode/focus'){
    const isCodex=String(b.id||'').startsWith('codex:');
    const r=await otty.focus({...b,source:isCodex?'codex':'opencode'});
    if(r.ok&&b.id){if(isCodex)codex.acknowledge(b.id);else opencode.acknowledge(b.id);}
    return json(r);
   }
   if(url.pathname==='/api/sources/add')return json(await sourcesMutate(()=>sources.add(b)));
   if(url.pathname==='/api/sources/remove')return json(await sourcesMutate(()=>sources.remove(b.path)));
   if(url.pathname==='/api/sources/link')return json(await sourcesMutate(()=>sources.relink(b.path)));
   if(url.pathname==='/api/sources/toggle')return json(await sourcesMutate(()=>sources.setEnabled(b.path,b.name,b.enabled)));
   if(url.pathname==='/api/sources/delete')return json(await sourcesMutate(()=>sources.removeSkill(b.path,b.name)));
   if(url.pathname==='/api/sources/create')return json(await sourcesMutate(()=>sources.createSkill(b.path,b.name,b.description)));
   if(url.pathname==='/api/sources/pick')return json(await sources.pick());
   if(url.pathname==='/api/sources/sync')return json(await mutate(()=>sources.sync(b.path,b)));
   if(url.pathname==='/api/sources/sync-all')return json(await mutate(()=>sources.syncAll()));
   if(url.pathname==='/api/agents/save')return json(await mutate(async()=>{const r=await agents.save(b);await agentReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/agents/create')return json(await mutate(()=>agents.create(b)));
   if(url.pathname==='/api/agents/rename')return json(await mutate(async()=>{const r=await agents.rename(b);await agentReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/agents/delete')return json(await mutate(async()=>{const r=await agents.remove(b);await agentReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/agents/toggle')return json(await mutate(async()=>{const r=await agents.toggle(b);await agentReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/codex/agents/save')return json(await mutate(async()=>{const r=await codexAgents.save(b);await codexReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/codex/agents/create')return json(await mutate(()=>codexAgents.create(b)));
   if(url.pathname==='/api/codex/agents/rename')return json(await mutate(async()=>{const r=await codexAgents.rename(b);await codexReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/codex/agents/delete')return json(await mutate(async()=>{const r=await codexAgents.remove(b);await codexReader.invalidate([b.id]);return r;}));
   if(url.pathname==='/api/ai/generate'||url.pathname==='/api/ai/agent/generate'||url.pathname==='/api/ai/codex/generate'){
    const codexMode=url.pathname==='/api/ai/codex/generate',agentMode=url.pathname==='/api/ai/agent/generate',engine=codexMode?codexReader:agentMode?agentReader:reader,rel=(codexMode||agentMode)?undefined:relPath(b.path);
    if(busy)fail('技能正在修改，请完成后再生成',409);
    if(!b.stream)return json(await engine.generate(b.id,b.mode,rel));
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
    const emit=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
    try{const result=await engine.generate(b.id,b.mode,rel,emit);emit({type:'done',result});}catch(e){emit({type:'error',message:e.message});}finally{res.end();}return;
   }
   if(url.pathname==='/api/open'){
    if(b.agent){await fs.mkdir(agents.root,{recursive:true});spawn('open',[agents.root],{shell:false}).on('error',()=>{});return json({ok:true,path:agents.root});}
    if(b.codexAgent){await fs.mkdir(codexAgents.root,{recursive:true});spawn('open',[codexAgents.root],{shell:false}).on('error',()=>{});return json({ok:true,path:codexAgents.root});}
    if(b.url){let target;try{target=new URL(b.url);}catch{fail('无效链接');}if(!['http:','https:'].includes(target.protocol))fail('无效链接');spawn('open',[target.href],{shell:false}).on('error',()=>{});return json({ok:true});}
    if(b.dir){const list=await sources.roots();const real=await fs.realpath(b.dir).catch(()=>null);if(!real||!list.some(r=>r.path===real))fail('该目录尚未添加',404);spawn('open',[real],{shell:false}).on('error',()=>{});return json({ok:true,path:real});}
    if(b.group){const group=(await list()).filter(s=>(s.source?.split('/')[0]||'local')===b.group);
     if(!group.length)fail('该分组没有技能',404);
     const parts=group.map(s=>s.path.split('/')),first=parts[0];let i=0;
     for(;i<first.length;i++)if(!parts.every(p=>p[i]===first[i]))break;
     const dir=first.slice(0,i).join('/')||'/';let real;
     try{real=await fs.realpath(dir);}catch{fail('目录不存在，请刷新后重试');}
     const realHome=await fs.realpath(home);
     if(real===realHome||!real.startsWith(realHome+path.sep))fail('该分组没有统一的技能目录');
     spawn('open',[real],{shell:false}).on('error',()=>{});return json({ok:true,path:real});
    }
    const s=await skill(b.id);spawn('open',[s.path],{shell:false}).on('error',()=>{});return json({ok:true});
   }
   if(url.pathname==='/api/file')return json(await mutate(async()=>{
    const s=await skill(b.id),file=await safeFile(s,b.path);
    let old=null;try{old=await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(b.create&&old!==null)fail('文件已存在',409);
    if(!b.create&&(old===null||b.version!==hash(old)))fail('文件已被其他程序修改，请重新打开',409);
    if(b.delete&&b.path==='SKILL.md')fail('请使用删除技能按钮删除整个技能');
    const saved=await backup([s],'edit');
    if(b.delete)await fs.unlink(file);
    else{if(typeof b.content!=='string'||b.content.length>1000000)fail('文件内容无效');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,b.content);}
    await reader.invalidate([s.id]);catalogTime=0;return {ok:true,backup:saved,version:b.delete?null:hash(b.content)};
   }));
   if(url.pathname==='/api/command'){
    if(busy)fail('另一个操作正在运行',409);
    let raw=b.args,groupTargets=null;
    if(Array.isArray(raw)&&['remove','update'].includes(raw[0])&&typeof b.group==='string'&&b.group){
     groupTargets=(await list()).filter(s=>(s.source?.split('/')[0]||'local')===b.group);
     if(!groupTargets.length)fail('该分组没有可操作的技能',404);
     raw=[raw[0],...groupTargets.map(s=>s.name),...raw.slice(1).filter(a=>typeof a==='string'&&a.startsWith('-'))];
    }
    const args=normalize(raw);
    if(args[0]==='init'){await fs.mkdir(path.join(home,'.agents/skills'),{recursive:true});try{await fs.lstat(path.join(home,'.agents/skills',args[1]));fail('技能已存在',409);}catch(e){if(e.code!=='ENOENT')throw e;}}
    busy=true;job={args,output:'',running:true,code:null,backup:null};const active=job;
    (async()=>{try{
     if(['add','update'].includes(args[0])){active.output='正在备份现有技能…\n';active.backup=await backup(await list(true),'cli');active.output+='备份：'+active.backup+'\n';}
     const removeTargets=args[0]==='remove'?(groupTargets||(await list()).filter(s=>args.includes('--all')||args.includes(s.name))):[];
     if(['add','remove','update'].includes(args[0]))await reader.invalidate(catalog.filter(s=>args[0]==='add'||args.includes('--all')||!args.slice(1).some(a=>!a.startsWith('-'))||args.includes(s.name)).map(s=>s.id));
     const result=await command(args,args[0]==='init'?path.join(home,'.agents/skills'):home,s=>active.output=(active.output+s).slice(-1000000));active.code=result.code;
     if(args[0]==='remove'){
      const realHome=await fs.realpath(home);
      for(const t of removeTargets){
       try{
        if(t.mine){await sources.removeSkill(t.mine.root,path.basename(t.path));active.output+='已删除我的技能：'+t.path+'\n';continue;}
        const real=await fs.realpath(t.path);
        if(real!==realHome&&real.startsWith(realHome+path.sep)){
         await fs.rm(real,{recursive:true,force:true});
         active.output+='已直接删除技能目录：'+real+'\n';
        }
       }catch(e){if(e.code!=='ENOENT')active.output+='删除目录异常：'+e.message+'\n';}
      }
     }
    }catch(e){active.output+='\n'+e.message;active.code=1;}finally{active.running=false;busy=false;catalogTime=0;}})();
    return json({ok:true});
   }fail('不存在的接口：'+req.method+' '+url.pathname,404);
  }
  const assets={'/stream.js':['stream.js','text/javascript'],'/markdown.js':['markdown.js','text/javascript'],'/agent-format.js':['agent-format.js','text/javascript'],'/codex-format.js':['codex-format.js','text/javascript'],'/icon.png':['icon.png','image/png'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
  const asset=assets[url.pathname];if(!asset)fail('Not found',404);
  // 图片按二进制读取且不声明 charset；文本资源按 UTF-8 读取并声明 charset。
  const isText=/^(text\/|application\/(javascript|json))/.test(asset[1]);
  let data=await fs.readFile(path.join(here,'public',asset[0]),isText?'utf8':undefined);if(url.pathname==='/')data=data.replace('__TOKEN__',token);
  res.writeHead(200,{'Content-Type':asset[1]+(isText?'; charset=utf-8':''),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(data);
 }catch(e){json({error:e.code==='ENOENT'?'文件不存在':e.message},e.status||500);}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被使用，请打开现有页面或更换 PORT。':e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{console.log('bobo → http://127.0.0.1:'+port);if(process.argv.includes('--open'))spawn('open',['http://127.0.0.1:'+port]);});
