import http from 'node:http';
import {createSkillReader,createAgentReader,createCodexAgentReader,createConfigReader} from './reader-ai.mjs';
import { createAI } from './ai.mjs';
import { createSources } from './sources.mjs';
import { createSkills, parseSkill } from './skills.mjs';
import { createAgents } from './agents.mjs';
import { createCodexAgents } from './codex-agents.mjs';
import { createConfigs } from './configs.mjs';
import { createOpenCode } from './opencode.mjs';
import { createCodex } from './codex.mjs';
import { createOmp } from './omp.mjs';
import { createClaude } from './claude.mjs';
import { createDsh } from './dsh.mjs';
import { createAgy } from './agy.mjs';
import { createUsage } from './usage.mjs';
import { createDevices } from './devices.mjs';
import { createTerminals } from './terminals.mjs';
import { createBrowser } from './browser.mjs';
import { createUpdate } from './update.mjs';
import { pruneBackups } from './backups.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openTarget, openUrl } from './platform.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.join(here,'..');
const home=process.env.BOBO_HOME||os.homedir();
const ai=createAI(home);
const reader=createSkillReader({home,ai,resolveSkill:skill});
const port=Number(process.env.PORT||4318), token=randomBytes(24).toString('hex');
const env={...process.env,HOME:home,NO_COLOR:'1',CI:'1'};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const sources=createSources({home,env,fail});
// 技能：本机直接管理 ~/.agents/skills 与各 Agent 目录，不再调用 npx skills。
const skills=createSkills({home,env,fail});
const agents=createAgents({home,fail});
const agentReader=createAgentReader({home,ai,resolveAgent:id=>agents.file(id)});
// Codex CLI 的自定义智能体同样是单个定义文件，只是格式为 TOML；读写与 AI 缓存都和 OpenCode 智能体分开。
const codexAgents=createCodexAgents({home,fail});
const codexReader=createCodexAgentReader({home,ai,resolveAgent:id=>codexAgents.file(id)});
// 全局配置（OpenCode 的 AGENTS.md / opencode.json(c) / cli.json，Codex 的 AGENTS.md / config.toml）：
// 与智能体同样的单文件读写与 AI 缓存，只是条目由白名单决定，不走目录扫描。
const configs=createConfigs({home,env,fail});
const configReader=createConfigReader({home,ai,resolveConfig:id=>configs.entity(id)});
// 点击会话时跳到对应终端（Otty / Ghostty / Terminal.app，见 terminals.mjs）；也用来判断会话结束后用户看过终端没有。
const terminals=createTerminals();
// 把用户带到已经打开的网页（dsh 的 web 界面）：先切到浏览器里已有的那个标签，找不到才新开。
const browser=createBrowser();
// 应用内更新（见 update.mjs）：启动后静默检查、自动下载暂存，设置页一键重启安装。
// 版本号读 package.json，安装位置从启动路径推导；源码运行时 canUpdate 为 false。
const update=createUpdate({home});
await update.load();
update.start();
// 监听本机 OpenCode 的事件流，状态变化推送给网页与刘海面板。
const opencode=createOpenCode({home});
opencode.start();
// Codex CLI 没有事件流服务，改为轮询 ~/.codex/sessions 推导会话状态；提醒复用通知岛的开关与音效。
const codex=createCodex({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
codex.start();
// omp（Oh My Pi）同样没有事件流服务，轮询 ~/.omp/agent/sessions 的会话文件；提醒同一条通道。
const omp=createOmp({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
omp.start();
// Claude Code 的实时状态读 ~/.claude/sessions 的注册表（status: idle / busy / waiting），标题读会话日志；
// 提醒同样走通知岛通道。
const claude=createClaude({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
claude.start();
// DeepSeek Harness（dsh）读 ~/.dsh/storages/session_projcache 的投影缓存；提醒同样走通知岛通道。
const dsh=createDsh({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
dsh.start();
// Google Antigravity（agy）读 ~/.gemini/antigravity-cli/conversation_summaries.db；提醒同样走通知岛通道。
const agy=createAgy({home,remind:(kind,title,message)=>opencode.remind(kind,title,message)});
agy.start();
// 六个 Agent 的会话合成一份列表：各自模块给出 order（按最近一次状态变更），这里统一倒序后截断。
function sessionsMerged(){return [...opencode.snapshot().sessions,...codex.snapshot().sessions,...omp.snapshot().sessions,...claude.snapshot().sessions,...dsh.snapshot().sessions,...agy.snapshot().sessions].sort((a,b)=>(b.order??0)-(a.order??0)).slice(0,40);}
// dsh 通常是 web profile：界面是本地页面 127.0.0.1:3080（dsh 默认端口）。点 dsh 会话时能连上就直接把页面打开
// ——前端没有会话级深链，只能打开首页让用户在页面里自己选；连不上（例如跑的是 tui profile）再照常找终端标签页。
const dshWebUrl='http://127.0.0.1:'+(Number(process.env.DSH_WEB_PORT)||3080)+'/';
async function dshWebAlive(){
 try{await fetch(dshWebUrl,{method:'HEAD',signal:AbortSignal.timeout(400)});return true;}
 catch{return false;}
}
// 终端归属按需扫描：网页打开通知岛 / 刘海面板展开时 POST /api/terminals/watch 续期（10 秒），期间每 3 秒扫一次
// 「正在运行」的终端标签页，把每个会话归属的终端并进状态流；没人看后自然过期停止，不常驻子进程。
let terminalWatchUntil=0, sessionTerminals={};
async function scanTerminals(){const rows=sessionsMerged();sessionTerminals=rows.length?await terminals.locate(rows):{};}
setInterval(()=>{if(Date.now()<terminalWatchUntil)scanTerminals().catch(()=>{});},3000);
// 状态流与 /api/opencode 共用的快照：OpenCode 的设置 / 连接 / 通知 + 合并后的会话（带终端归属）+ 各来源信息。
function islandSnapshot(){return {...opencode.snapshot(),sessions:sessionsMerged().map(s=>({...s,terminal:sessionTerminals[s.id]})),codex:codex.snapshot(),omp:omp.snapshot(),claude:claude.snapshot(),dsh:dsh.snapshot(),agy:agy.snapshot()};}
// 结束 / 终止的头像要留到用户看过终端才收起：对应终端在前台且正停在那个标签页时算已查看；
// 手动切标签页与点会话行跳过去（/api/opencode/focus）命中同一套匹配。
async function ackViewed(){for(const id of await terminals.viewed([...opencode.unviewed(),...codex.unviewed(),...omp.unviewed(),...claude.unviewed(),...dsh.unviewed(),...agy.unviewed()])){if(!opencode.acknowledge(id)&&!codex.acknowledge(id)&&!omp.acknowledge(id)&&!claude.acknowledge(id)&&!dsh.acknowledge(id))agy.acknowledge(id);}}
setInterval(()=>{ackViewed().catch(()=>{});},3000);
// 用量：Codex（chatgpt.com）与 OpenCode Go（官方接口 / 本机估算）的额度，随事件流一起推给刘海面板。
// 额度重置提醒走通知岛的统一通道（remind 受通知岛的系统通知 / 提示音开关控制）。
const usage=createUsage({home,notify:(kind,title,message)=>opencode.remind(kind,title,message)});
usage.start();
// 设备：CPU / 内存 / 磁盘三个指标，常驻采样（刘海胶囊要实时值），随事件流一起推给刘海面板。
const devices=createDevices();
devices.start();
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
async function list(force=false){
 if(!force&&catalogTime>Date.now()-30000)return catalog;
 const rows=await skills.scan();
 const previous=catalog,roots=await sources.roots(),covered=new Set();
 catalog=rows.map(r=>{
  covered.add(r.path);
  const row={...r,id:hash(r.path).slice(0,20)};
  return row;
 });
 for(const row of catalog){
  const real=await fs.realpath(row.path).catch(()=>null);
  if(real)covered.add(real);
  const root=real&&roots.find(x=>real===x.path||real.startsWith(x.path+path.sep));
  if(root)row.mine={root:root.path,name:root.name||path.basename(root.path),repo:root.repo||null,mineStatus:'linked'};
 }
 // 本地优先：源目录里的技能只要没被扫到就补上（未链接、名称冲突，或已链接但 SKILL.md 不符合收录规则）。
 for(const root of roots){
  let entries=[];try{entries=await sources.entries(root.path,new Set(root.disabled||[]));}catch{continue;}
  for(const e of entries){
   const real=await fs.realpath(e.path).catch(()=>e.path);
   if(covered.has(e.path)||covered.has(real))continue;
   let parsed=null;try{parsed=parseSkill(await fs.readFile(path.join(e.path,'SKILL.md'),'utf8'));}catch{}
   catalog.push({name:e.name,path:e.path,agents:[],source:null,description:parsed?.description||'',id:hash(e.path).slice(0,20),mine:{root:root.path,name:root.name||path.basename(root.path),repo:root.repo||null,mineStatus:e.status}});
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
// 命令参数只来自界面按钮（不再有自由输入的终端），这里做校验与统一，不支持 -p 等项目级参数。
function normalize(args){
 if(!Array.isArray(args)||!args.length||args.some(a=>typeof a!=='string'||a.length>2000||/[\x00-\x1f]/.test(a)))fail('命令参数无效');
 args=[...args];if(args[0]==='skills')args.shift();
 const verb=args[0];if(!['list','add','remove','update','init'].includes(verb))fail('支持 list、add、remove、update、init');
 if(args.includes('-p')||args.includes('--project'))fail('此界面管理全局技能，请使用 -g');
 if(verb==='add'){if(!args.slice(1).some(a=>!a.startsWith('-')))fail('请输入技能来源');skills.parseSource(args[1]);}
 if(verb==='remove'&&!args.slice(1).some(a=>!a.startsWith('-'))&&!args.includes('--all'))fail('请输入要删除的技能名称');
 if(verb==='init'&&(args.length!==2||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(args[1])))fail('技能名称只能包含小写字母、数字和短横线');
 return args;
}
// 去掉 -g / -y 之类的开关，只留命令与操作对象。
const operands=args=>args.slice(1).filter(a=>!a.startsWith('-'));
const flagValue=(args,name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
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
   if(req.method==='GET'&&url.pathname==='/api/configs/providers')return json(await configs.providers());
   if(req.method==='GET'&&url.pathname==='/api/configs')return json(await configs.list(url.searchParams.get('provider')));
   if(req.method==='GET'&&url.pathname==='/api/configs/file')return json(await configs.read(url.searchParams.get('provider'),url.searchParams.get('key')));
   if(req.method==='GET'&&url.pathname==='/api/ai/config/document')return json(await configReader.document(url.searchParams.get('id')));
   if(req.method==='GET'&&url.pathname==='/api/job')return json(job);
   if(req.method==='GET'&&url.pathname==='/api/opencode')return json(islandSnapshot());
   if(req.method==='GET'&&url.pathname==='/api/usage')return json(url.searchParams.has('refresh')?await usage.refresh():usage.snapshot());
   // 设备：CPU / 内存 / 磁盘。服务端常驻采样，这里读缓存；网页每 2 秒拉一次，刘海面板走状态流。
   if(req.method==='GET'&&url.pathname==='/api/devices')return json(url.searchParams.has('refresh')?await devices.refresh():devices.snapshot());
   // 进程列表：按需采样（不进常驻 tick 与状态流），只在网页停在 CPU / 内存分栏时拉取。
   if(req.method==='GET'&&url.pathname==='/api/devices/processes')return json(await devices.processes({limit:url.searchParams.get('limit'),sort:url.searchParams.get('sort')}));
    // 应用信息与更新状态：版本号来自 package.json；canUpdate 只有当服务跑在 .app 里才为 true。
    if(req.method==='GET'&&url.pathname==='/api/app')return json(update.snapshot());
    if(req.method==='GET'&&url.pathname==='/api/update')return json(update.snapshot());
   // 状态流：先推一次当前快照，之后每次变化推一份新快照（体积小，前端直接整份替换）。
   // 用量与设备也挂在同一份快照里（`usage` / `device` 字段），刘海面板不用另外轮询。
   if(req.method==='GET'&&url.pathname==='/api/opencode/stream'){
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send=()=>{if(!res.destroyed)res.write(JSON.stringify({...islandSnapshot(),usage:usage.snapshot(),device:devices.snapshot()})+'\n');};
    send();
    const stop=opencode.subscribe(send),stopUsage=usage.subscribe(send),stopCodex=codex.subscribe(send),stopOmp=omp.subscribe(send),stopClaude=claude.subscribe(send),stopDsh=dsh.subscribe(send),stopAgy=agy.subscribe(send),stopDevices=devices.subscribe(send);
    const close=()=>{stop();stopUsage();stopCodex();stopOmp();stopClaude();stopDsh();stopAgy();stopDevices();};
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
   // 额度圆环显示哪一档窗口：{id} 让这一家在它自己的窗口之间循环（5 小时 / 本周 / 账单月…），选择保存在 usage.json。
   if(url.pathname==='/api/usage/range')return json(usage.cycleRange(b.id));
   // 来源启停：关掉的来源不参与刘海胶囊的切换循环。
   if(url.pathname==='/api/usage/enabled')return json(usage.setEnabled(b.id,b.enabled));
   // 额度重置提醒开关：Codex 的额度窗口回到 100% 时提醒（系统通知 + 提示音）。
   if(url.pathname==='/api/usage/reset-notify')return json(usage.setNotifyReset(b.enabled));
   // 手动填写 / 清除 OpenCode Go 的 API Key（保存前先调一次接口验证）。
   if(url.pathname==='/api/usage/key')return json(b.clear?{ok:true,message:'已清除手动 Key，改回读取本机登录',snapshot:await usage.clearKey()}:await usage.setKey(b.key));
    // 应用内更新：手动检查（总是真的请求）与一键重启安装（脚本等应用退出后替换并重开）。
    if(url.pathname==='/api/update/check')return json(await update.check());
    if(url.pathname==='/api/update/install')return json(await update.install());
   // 点会话跳到对应终端（Otty / Ghostty / Terminal.app）或 Codex 桌面版：真的切到了那个标签页 / 线程才算「已查看」，
   // 结束/终止的头像才会消失。Codex app 里跑的会话（rollout 里 originator 是 Desktop）直接跳 `codex://threads/<id>` 深链。
   if(url.pathname==='/api/opencode/focus'){
    const id=String(b.id||''),source=id.startsWith('codex:')?'codex':id.startsWith('omp:')?'omp':id.startsWith('claude:')?'claude':id.startsWith('dsh:')?'dsh':id.startsWith('agy:')?'agy':'opencode';
    // dsh 的 web 界面在跑就把用户带过去：先切到浏览器里已经打开的那个标签（不新开），没有才打开。
    if(source==='dsh'&&await dshWebAlive()){
     const r=await browser.focus(dshWebUrl);
     if(b.id)dsh.acknowledge(b.id);
     return json({ok:true,url:dshWebUrl,...r});
    }
    const r=await terminals.focus({...b,source,app:source==='codex'&&codex.appSession(id)});
    // 点会话行就当作「处理过了」：终端页可能已经关掉、跳不过去，也照样标记已查看，
    // 已结束 / 已终止的会话因此从列表与头像里收起，不会一直残留。
    if(b.id){if(source==='codex')codex.acknowledge(b.id);else if(source==='omp')omp.acknowledge(b.id);else if(source==='claude')claude.acknowledge(b.id);else if(source==='dsh')dsh.acknowledge(b.id);else if(source==='agy')agy.acknowledge(b.id);else opencode.acknowledge(b.id);}
    return json(r);
   }
   // 终端归属按需扫描的续期：网页打开通知岛 / 刘海面板展开时每几秒调一次，服务端据此决定要不要扫。
   if(url.pathname==='/api/terminals/watch'){terminalWatchUntil=Date.now()+10000;return json({ok:true});}
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
   // 全局配置的保存：与智能体一样先备份、校验版本；改完失效对应的 AI 缓存。
   if(url.pathname==='/api/configs/save')return json(await mutate(async()=>{const r=await configs.save(b);await configReader.invalidate([b.provider+':'+b.key]);return r;}));
   if(url.pathname==='/api/ai/generate'||url.pathname==='/api/ai/agent/generate'||url.pathname==='/api/ai/codex/generate'||url.pathname==='/api/ai/config/generate'){
    const configMode=url.pathname==='/api/ai/config/generate',codexMode=url.pathname==='/api/ai/codex/generate',agentMode=url.pathname==='/api/ai/agent/generate',engine=configMode?configReader:codexMode?codexReader:agentMode?agentReader:reader,rel=(configMode||codexMode||agentMode)?undefined:relPath(b.path);
    if(busy)fail('技能正在修改，请完成后再生成',409);
    if(!b.stream)return json(await engine.generate(b.id,b.mode,rel));
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
    const emit=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
    try{const result=await engine.generate(b.id,b.mode,rel,emit);emit({type:'done',result});}catch(e){emit({type:'error',message:e.message});}finally{res.end();}return;
   }
   if(url.pathname==='/api/open'){
    if(b.agent){await fs.mkdir(agents.root,{recursive:true});openTarget(agents.root);return json({ok:true,path:agents.root});}
    if(b.codexAgent){await fs.mkdir(codexAgents.root,{recursive:true});openTarget(codexAgents.root);return json({ok:true,path:codexAgents.root});}
    if(b.config){const dir=configs.dir(b.config);if(!(await fs.lstat(dir).catch(()=>null)))fail('配置目录不存在：'+dir,404);openTarget(dir);return json({ok:true,path:dir});}
    if(b.url){let target;try{target=new URL(b.url);}catch{fail('无效链接');}if(!['http:','https:'].includes(target.protocol))fail('无效链接');openUrl(target.href);return json({ok:true});}
    if(b.dir){const list=await sources.roots();const real=await fs.realpath(b.dir).catch(()=>null);if(!real||!list.some(r=>r.path===real))fail('该目录尚未添加',404);openTarget(real);return json({ok:true,path:real});}
    if(b.group){const group=(await list()).filter(s=>(s.source?.split('/')[0]||'local')===b.group);
     if(!group.length)fail('该分组没有技能',404);
     const parts=group.map(s=>s.path.split(path.sep)),first=parts[0];let i=0;
     for(;i<first.length;i++)if(!parts.every(p=>p[i]===first[i]))break;
     const dir=first.slice(0,i).join(path.sep)||path.parse(group[0].path).root;let real;
     try{real=await fs.realpath(dir);}catch{fail('目录不存在，请刷新后重试');}
     const realHome=await fs.realpath(home);
     if(real===realHome||!real.startsWith(realHome+path.sep))fail('该分组没有统一的技能目录');
     openTarget(real);return json({ok:true,path:real});
    }
    const s=await skill(b.id);openTarget(s.path);return json({ok:true});
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
    busy=true;job={args,output:'',running:true,code:null,backup:null};const active=job;
    (async()=>{
     const emit=s=>{active.output=(active.output+s).slice(-1000000);};
     try{
      emit('执行：'+args.filter(a=>a!=='--all').join(' ')+'\n');
      if(['add','update'].includes(args[0])){emit('正在备份现有技能…\n');active.backup=await backup(await list(true),'cli');emit('备份：'+active.backup+'\n');}
      const names=operands(args);
      if(['add','remove','update'].includes(args[0]))await reader.invalidate(catalog.filter(s=>args[0]==='add'||!names.length||names.includes(s.name)).map(s=>s.id));
      if(args[0]==='list'){
       const rows=await list(true);
       emit(rows.length?rows.map(r=>r.name+'  '+r.path+'\n  Agent：'+(r.agents.length?r.agents.join('、'):'未链接')+'  来源：'+(r.source||'本地')).join('\n')+'\n':'还没有安装全局技能。\n');
      }else if(args[0]==='init'){
       const r=await skills.init(args[1]);
       emit('已创建 '+r.path+'\n');
       emit('已链接到 '+(r.report.linked.length+r.report.kept.length)+' 个 Agent'+(r.report.conflicts.length?'，跳过同名冲突：'+r.report.conflicts.join('、'):'')+'\n');
      }else if(args[0]==='add'){
       const r=await skills.add({source:args[1],skill:flagValue(args,'--skill')},emit);
       emit('完成：安装了 '+r.installed.map(i=>i.name).join('、')+'\n');
      }else if(args[0]==='update'){
       const r=await skills.update(names,emit);
       if(!r.updated.length&&!r.unchanged.length&&!r.skipped.length&&!r.failed.length)emit('没有可更新的技能（没有来源记录的技能无法更新）。\n');
       else emit('更新 '+r.updated.length+' 个'+(r.unchanged.length?'，已是最新 '+r.unchanged.length+' 个':'')+(r.skipped.length?'，跳过 '+r.skipped.length+' 个':'')+'\n');
       for(const s of r.skipped)emit('跳过 '+s.name+'：'+s.note+'\n');
       for(const f of r.failed)emit('失败 '+f.name+'：'+f.error+'\n');
       if(r.failed.length)throw Error('有 '+r.failed.length+' 个技能更新失败');
      }else if(args[0]==='remove'){
       const all=args.includes('--all'),rows=groupTargets||await list();
       const targets=all?rows:rows.filter(s=>names.includes(s.name));
       if(!targets.length)throw Error('没有找到要删除的技能');
       for(const t of targets){
        if(t.mine){await sources.removeSkill(t.mine.root,path.basename(t.path));emit('已删除我的技能：'+t.path+'\n');continue;}
        const r=await skills.remove(t.name);
        emit('已删除 '+t.name+'（清理 '+r.removed.length+' 个 Agent 链接）\n');
       }
      }
      active.code=0;
     }catch(e){emit('\n'+e.message);active.code=1;}finally{active.running=false;busy=false;catalogTime=0;}
    })();
    return json({ok:true});
   }fail('不存在的接口：'+req.method+' '+url.pathname,404);
  }
  const assets={'/stream.js':['stream.js','text/javascript'],'/markdown.js':['markdown.js','text/javascript'],'/agent-format.js':['agent-format.js','text/javascript'],'/codex-format.js':['codex-format.js','text/javascript'],'/icon.png':['icon.png','image/png'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],
   // 通知岛面板：独立的小页面，给桌面壳的透明悬浮窗用（浏览器访问也正常）。
   '/panel.html':['panel.html','text/html'],'/panel.css':['panel.css','text/css'],'/panel.js':['panel.js','text/javascript']};
  const asset=assets[url.pathname];if(!asset)fail('Not found',404);
  // 图片按二进制读取且不声明 charset；文本资源按 UTF-8 读取并声明 charset。
  const isText=/^(text\/|application\/(javascript|json))/.test(asset[1]);
  let data=await fs.readFile(path.join(root,'public',asset[0]),isText?'utf8':undefined);
  // 页面里注入 token 与当前版本：版本号首屏就是对的，不用等 /api/app 回来。
  if(url.pathname==='/'||url.pathname==='/panel.html')data=data.replace('__TOKEN__',token).replace('__VERSION__',update.snapshot().version);
  res.writeHead(200,{'Content-Type':asset[1]+(isText?'; charset=utf-8':''),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(data);
 }catch(e){json({error:e.code==='ENOENT'?'文件不存在':e.message},e.status||500);}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被使用，请打开现有页面或更换 PORT。':e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{console.log('bobo → http://127.0.0.1:'+port);if(process.argv.includes('--open'))openUrl('http://127.0.0.1:'+port);});
