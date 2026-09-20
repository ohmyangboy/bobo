// 本机技能库：不依赖任何 CLI，直接按 Agent Skills 的约定读写磁盘。
// 约定（与 vercel-labs/skills 的 skills@1.6.0 保持一致，便于和 npx skills 互换使用）：
// - 技能真身放 ~/.agents/skills/<名称>，各 Agent 的全局技能目录里放指向它的相对符号链接；
// - 来源信息写在 ~/.agents/.skill-lock.json（XDG_STATE_HOME 优先，version 3）；
// - 只有 frontmatter 里 name 与 description 都是非空字符串的 SKILL.md 才算一个技能。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {skillAgents} from './skill-agents.mjs';
import {linkDir,removeLink} from './platform.mjs';

const SKIP_DIRS=['node_modules','.git','dist','build','__pycache__'];
// 仓库里优先查找技能的目录，顺序与 CLI 一致：根目录、skills/ 及其子目录、然后是各家 Agent 的目录。
const PRIORITY_DIRS=['','skills','skills/.curated','skills/.experimental','skills/.system','.agents/skills','.claude/skills','.codex/skills','.opencode/skills'];
const LOCK_VERSION=3;

export function sanitizeName(name){
 return String(name||'').toLowerCase().replace(/[^a-z0-9._]+/g,'-').replace(/^[.\-]+|[.\-]+$/g,'').substring(0,255)||'unnamed-skill';
}
// 只解析收录与分组需要的字段：name、description（含 >- / | 块标量）与 metadata.internal。
export function parseSkill(text){
 const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof text==='string'?text:'');
 if(!m)return null;
 const lines=m[1].split(/\r?\n/),data={};
 for(let i=0;i<lines.length;i++){
  const kv=/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);if(!kv)continue;
  const key=kv[1];let value=kv[2].trim();
  if(!value||/^[>|][+-]?$/.test(value)){const buf=[];
   while(i+1<lines.length&&(!lines[i+1].trim()||/^\s/.test(lines[i+1])))buf.push(lines[++i].trim());
   value=buf.join(' ').trim();
   if(key==='metadata'){data.internal=/^internal\s*:\s*true$/m.test(buf.join('\n').trim());continue;}
  }else if(/^(['"]).*['"]$/.test(value))value=value.slice(1,-1);
  data[key]=value;
 }
 const name=typeof data.name==='string'?data.name.trim():'';
 const description=typeof data.description==='string'?data.description.trim():'';
 return {name,description,internal:data.internal===true};
}
// 技能目录相对某份拷贝的内容指纹：排序后的「相对路径 + 内容」的 sha256，与 CLI 的算法一致。
export async function folderHash(dir){
 const files=[];
 const walk=async current=>{
  for(const e of await fs.readdir(current,{withFileTypes:true})){
   if(e.name==='.git'||e.name==='node_modules')continue;
   const full=path.join(current,e.name);
   if(e.isDirectory())await walk(full);
   else if(e.isFile())files.push({rel:path.relative(dir,full).split(path.sep).join('/'),buf:await fs.readFile(full)});
  }
 };
 await walk(dir);
 files.sort((a,b)=>a.rel.localeCompare(b.rel));
 const hash=createHash('sha256');
 for(const f of files){hash.update(f.rel);hash.update(f.buf);}
 return hash.digest('hex');
}
const inside=(p,parent)=>p===parent||p.startsWith(parent+path.sep);

// git / 子进程调用：参数数组 + shell:false，和 sources.mjs 的写法一致。
const defaultRun=(cmd,args,cwd,env,timeout=600000)=>new Promise(resolve=>{
 const child=spawn(cmd,args,{cwd,env,shell:false,stdio:['ignore','pipe','pipe']});
 let output='',stdout='',failure=null;const collect=b=>{output=(output+b).slice(-200000);};
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',b=>{stdout+=b;collect(b);});child.stderr.on('data',collect);
 const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
 child.on('error',e=>{failure=e;resolve({code:127,output:e.message,stdout:''});});
 child.on('close',code=>{clearTimeout(timer);if(failure)return;resolve({code:code??1,output:output.trim(),stdout:stdout.trim()});});
});

export function createSkills({home,env=process.env,fail,exec}){
 const canonicalDir=path.join(home,'.agents','skills');
 const stateHome=typeof env.XDG_STATE_HOME==='string'&&env.XDG_STATE_HOME.trim()?env.XDG_STATE_HOME.trim():null;
 const lockFile=stateHome?path.join(stateHome,'skills','.skill-lock.json'):path.join(home,'.agents','.skill-lock.json');
 const run=exec||defaultRun;
 const exists=p=>fs.access(p).then(()=>true,()=>false);
 const isDir=p=>fs.stat(p).then(s=>s.isDirectory(),()=>false);
 const hasSkill=p=>fs.access(path.join(p,'SKILL.md')).then(()=>true,()=>false);
 const linkTarget=link=>fs.readlink(link).then(t=>path.resolve(path.dirname(link),t)).catch(()=>null);
 // 比较链接目标与技能目录：两边都取 realpath，避开临时目录本身的符号链接（macOS 的 /var → /private/var）。
 async function sameTarget(link,src){
  const t=await linkTarget(link);if(!t)return false;
  const [rt,rs]=await Promise.all([fs.realpath(t).catch(()=>t),fs.realpath(src).catch(()=>src)]);
  return rt===rs;
 }

 async function readLock(){
  try{
   const parsed=JSON.parse(await fs.readFile(lockFile,'utf8'));
   if(typeof parsed.version!=='number'||!parsed.skills)return {version:LOCK_VERSION,skills:{},dismissed:{}};
   return parsed;
  }catch{return {version:LOCK_VERSION,skills:{},dismissed:{}};}
 }
 async function writeLock(lock){
  await fs.mkdir(path.dirname(lockFile),{recursive:true});
  await fs.writeFile(lockFile+'.tmp',JSON.stringify(lock,null,2));
  await fs.rename(lockFile+'.tmp',lockFile);
 }
 // 写入 / 删除一个技能的来源记录，键是技能目录名（与 CLI 相同）。
 async function recordLock(name,entry){
  const lock=await readLock();
  if(entry===null)delete lock.skills[name];
  else{const now=new Date().toISOString();lock.skills[name]={...entry,installedAt:lock.skills[name]?.installedAt??now,updatedAt:now};}
  await writeLock(lock);
 }
 function lockEntry(lock,name){
  if(lock.skills[name])return {key:name,entry:lock.skills[name]};
  const key=Object.keys(lock.skills).find(k=>sanitizeName(k)===sanitizeName(name));
  return key?{key,entry:lock.skills[key]}:null;
 }
 // 本机装了哪些 Agent：看它自己的目录在不在（通用 Agent 直接读 canonical，不参与链接）。
 async function liveAgents(){
  const all=skillAgents({home,env});
  const out=[];
  for(const a of all)if(a.detect.length&&(await Promise.all(a.detect.map(exists))).some(Boolean))out.push(a);
  return out;
 }
 async function readSkillsIn(dir){
  const out=[];
  for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
   if(e.name.startsWith('.'))continue;
   const full=path.join(dir,e.name);
   if(!await isDir(full)||!await hasSkill(full))continue;
   let parsed=null;try{parsed=parseSkill(await fs.readFile(path.join(full,'SKILL.md'),'utf8'));}catch{}
   if(!parsed||!parsed.name||!parsed.description||parsed.internal)continue;
   out.push({name:parsed.name,description:parsed.description,entry:e.name,path:full});
  }
  return out;
 }
 // 列表：canonical 里的技能 + 各家 Agent 目录里单独存在的技能，并补上 lock 里的来源。
 // 同一份技能可能同时出现在 canonical 与它链接到的 Agent 目录里，按名称合并成一行。
 async function scan(){
  const live=await liveAgents(),rows=[],byName=new Map();
  const addRow=(s,agentNames,pathOverride)=>{
   const key=sanitizeName(s.name),existing=byName.get(key);
   if(existing){for(const n of agentNames)if(!existing.agents.includes(n))existing.agents.push(n);if(!existing.description)existing.description=s.description;return existing;}
   const row={name:s.name,path:pathOverride||s.path,agents:[...new Set(agentNames)],description:s.description,source:null,sourceUrl:null,sourceType:null};
   rows.push(row);byName.set(key,row);return row;
  };
  for(const s of await readSkillsIn(canonicalDir)){
   const names=[];
   for(const a of live)if(a.universal||await exists(path.join(a.dir,s.entry)))names.push(a.name);
   addRow(s,names);
  }
  for(const a of live){
   if(a.universal)continue;
   for(const s of await readSkillsIn(a.dir))addRow(s,[a.name]);
  }
  const lock=await readLock();
  for(const row of rows){const found=lockEntry(lock,row.name);if(found){row.source=found.entry.source??null;row.sourceUrl=found.entry.sourceUrl??null;row.sourceType=found.entry.sourceType??null;}}
  return rows;
 }
 // 把 canonical 里的技能链接到各 Agent 目录（通用 Agent 不需要）。
 async function link(name,live){
  const src=path.join(canonicalDir,name);
  const report={linked:[],kept:[],conflicts:[]};
  for(const a of live){
   if(a.universal)continue;
   const target=path.join(a.dir,name),st=await fs.lstat(target).catch(()=>null);
   if(st){
    if(st.isSymbolicLink()&&await sameTarget(target,src))report.kept.push(a.name);
    else report.conflicts.push(a.name);
    continue;
   }
   try{await linkDir(src,target);report.linked.push(a.name);}
   catch{report.conflicts.push(a.name);}
  }
  return report;
 }
 // 清理指向 canonical 里某个技能的链接（不碰别处的东西）。
 async function unlinkAgents(name){
  const src=path.join(canonicalDir,name),removed=[];
  for(const a of skillAgents({home,env})){
   const target=path.join(a.dir,name),st=await fs.lstat(target).catch(()=>null);
   if(!st?.isSymbolicLink())continue;
   const t=await linkTarget(target);
   if(t&&((await sameTarget(target,src))||inside(t,canonicalDir))){await removeLink(target).catch(()=>{});removed.push(a.name);}
  }
  return removed;
 }

 // ---- 来源解析 ----
 // 支持 owner/repo、GitHub 树链接、任意 git 地址、本地目录。
 function parseSource(input){
  const raw=String(input||'').trim();
  if(!raw)fail('请输入技能来源，例如 owner/repo');
  const local=raw==='~'?home:/^~[/\\]/.test(raw)?path.join(home,raw.slice(2)):/^\.{1,2}[/\\]|^\//.test(raw)?raw:null;
  if(local){const abs=path.resolve(local);return {type:'local',source:abs,url:abs,local:abs,ref:null,subpath:null};}
  const hash=raw.indexOf('#'),base=hash>=0?raw.slice(0,hash):raw,pin=hash>=0?raw.slice(hash+1):null;
  const gh=base.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/i);
  // owner / repo 必须像 GitHub 上的真实名字（owner 不能有点，repo 不能是 . 或 ..）。
  const okRepo=gh&&/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(gh[1])&&/^[A-Za-z0-9_.-]+$/.test(gh[2])&&gh[2]!=='.'&&gh[2]!=='..'&&!gh[2].startsWith('.');
  if(okRepo&&!/^https?:\/\/(?!github\.com)/i.test(base))return {type:'github',source:gh[1]+'/'+gh[2],url:'https://github.com/'+gh[1]+'/'+gh[2]+'.git',local:null,ref:gh[3]||pin||null,subpath:gh[4]||null};
  if(/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(base)&&base.length<500&&!/[\s\x00-\x1f]/.test(base)&&base[0]!=='-')return {type:'git',source:base,url:base,local:null,ref:pin||null,subpath:null};
  fail('无法识别的来源，请用 owner/repo、git 地址或本地目录');
 }
 async function cloneInto(spec,temp,onData){
  if(spec.local)return spec.local;
  const args=['clone','--depth','1',...(spec.ref?['--branch',spec.ref]:[]),'--',spec.url,temp];
  onData('git clone '+spec.url+'\n');
  const r=await run('git',args,home,env);
  if(r.code!==0)fail('拉取失败：'+(r.output.split('\n').filter(Boolean).pop()||spec.url));
  return temp;
 }
 // 技能目录的指纹：git 来源用远端 tree hash（与 CLI / GitHub 一致），其余按内容算。
 async function folderHashOf(root,dir,gitSource){
  if(gitSource){
   const rel=path.relative(root,dir).split(path.sep).join('/');
   const rev=rel?`HEAD:${rel}`:'HEAD^{tree}';
   const r=await run('git',['-C',root,'rev-parse','--verify','--end-of-options',rev],home,env);
   const hash=r.stdout.trim();
   if(/^[0-9a-f]{40}$/i.test(hash))return hash.toLowerCase();
  }
  return folderHash(dir);
 }
 // 在仓库里找技能：优先目录（根、skills/、各 Agent 目录）浅层，找不到再全仓库深挖。
 async function discover(root,subpath){
  const base=subpath?path.join(root,subpath):root;
  if(!await isDir(base))fail('来源里没有这个子目录：'+subpath);
  const dirs=[];
  const walk=async(dir,maxDepth,depth)=>{
   for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
    if(SKIP_DIRS.includes(e.name))continue;
    const child=path.join(dir,e.name);
    if(!await isDir(child))continue;
    if(await hasSkill(child)){dirs.push(child);continue;}
    if(depth<maxDepth)await walk(child,maxDepth,depth+1);
   }
  };
  if(await hasSkill(base))dirs.push(base);
  else{
   for(const prefix of PRIORITY_DIRS){
    const dir=prefix?path.join(base,prefix):base;
    if(await isDir(dir))await walk(dir,prefix?3:1,1);
   }
   if(!dirs.length)await walk(base,5,1);
  }
  const out=[],seen=new Set();
  for(const dir of dirs){
   let parsed=null;try{parsed=parseSkill(await fs.readFile(path.join(dir,'SKILL.md'),'utf8'));}catch{}
   if(!parsed||!parsed.name||!parsed.description||parsed.internal)continue;
   const key=sanitizeName(parsed.name);
   if(seen.has(key))continue;
   seen.add(key);
   out.push({name:parsed.name,description:parsed.description,dir,skillPath:path.relative(root,path.join(dir,'SKILL.md')).split(path.sep).join('/')});
  }
  return out;
 }

 // 安装：拉取来源 → 复制到 canonical → 链接各 Agent → 写 lock。
 async function add({source,skill}={},onData=()=>{}){
  const spec=parseSource(source),temp=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-skills-'));
  try{
   const root=await cloneInto(spec,temp,onData);
   const found=await discover(root,spec.subpath);
   if(!found.length)fail('这个来源里没有找到技能（需要带 name 与 description 的 SKILL.md）');
   let selected=found;
   if(skill){
    const key=String(skill).trim().toLowerCase();
    selected=found.filter(s=>s.name.toLowerCase()===key||path.basename(s.dir).toLowerCase()===key);
    if(!selected.length)fail('来源里没有「'+skill+'」；可选：'+found.map(s=>s.name).join('、'));
   }
   const live=await liveAgents(),installed=[];
   for(const s of selected){
    const name=sanitizeName(s.name),target=path.join(canonicalDir,name),st=await fs.lstat(target).catch(()=>null);
    if(st?.isSymbolicLink()){const real=await fs.realpath(target).catch(()=>null);if(real&&!inside(real,canonicalDir))fail('已经有同名的「我的技能」：'+name+'，请先改名或删除');}
    onData('安装 '+name+'\n');
    await fs.rm(target,{recursive:true,force:true});
    await fs.mkdir(target,{recursive:true});
    await fs.cp(s.dir,target,{recursive:true,dereference:false});
    const report=await link(name,live);
    const entry={source:spec.source,sourceType:spec.type,sourceUrl:spec.url,skillPath:s.skillPath,skillFolderHash:await folderHashOf(root,s.dir,spec.type!=='local')};
    if(spec.ref)entry.ref=spec.ref;
    await recordLock(name,entry);
    const skipped=report.conflicts.length?'（这些 Agent 已有同名技能，跳过：'+report.conflicts.join('、')+'）':'';
    onData('已链接到 '+(report.linked.length+report.kept.length)+' 个 Agent'+skipped+'\n');
    installed.push({name,path:target,report});
   }
   return {installed,found:found.length};
  }finally{await fs.rm(temp,{recursive:true,force:true});}
 }

 // 更新：按 lock 里的来源重新拉取，内容变了才替换并重新链接。
 async function update(names=[],onData=()=>{}){
  const lock=await readLock(),result={updated:[],unchanged:[],skipped:[],failed:[]};
  const wanted=new Set(names.map(n=>sanitizeName(n)));
  const targets=Object.keys(lock.skills).filter(k=>!names.length||wanted.has(sanitizeName(k)));
  if(!targets.length)return result;
  const groups=new Map();
  for(const key of targets){
   const entry=lock.skills[key],url=entry.sourceUrl||entry.source,g=url+'\n'+(entry.ref||'');
   if(!groups.has(g))groups.set(g,[]);groups.get(g).push(key);
  }
  const live=await liveAgents();
  for(const keys of groups.values()){
   const first=lock.skills[keys[0]],temp=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-skills-'));
   try{
    const root=await cloneInto({local:first.sourceType==='local'?path.resolve(home,first.source):null,url:first.sourceUrl||first.source,ref:first.ref||null},temp,onData);
    for(const key of keys){
     const entry=lock.skills[key],dir=entry.skillPath?path.join(root,path.dirname(entry.skillPath)):root;
     if(!await hasSkill(dir)){result.skipped.push({name:key,note:'来源里已经没有这个技能'});continue;}
     const hash=await folderHashOf(root,dir,entry.sourceType!=='local');
     if(hash&&entry.skillFolderHash&&hash===entry.skillFolderHash){result.unchanged.push(key);continue;}
     const target=path.join(canonicalDir,key);
     await fs.rm(target,{recursive:true,force:true});
     await fs.mkdir(target,{recursive:true});
     await fs.cp(dir,target,{recursive:true,dereference:false});
     await link(key,live);
     lock.skills[key]={...entry,skillFolderHash:hash,updatedAt:new Date().toISOString()};
     onData('已更新 '+key+'\n');
     result.updated.push(key);
    }
   }catch(e){result.failed.push({name:keys[0],error:e.message});}
   finally{await fs.rm(temp,{recursive:true,force:true});}
  }
  await writeLock(lock);
  return result;
 }

 // 删除：canonical 目录 + 各 Agent 目录里的同名技能 + lock 记录。
 // 「我的技能」是 canonical 里的链接，交给 sources.mjs，这里拒绝。
 async function remove(name){
  const canonical=path.join(canonicalDir,name);
  let st=await fs.lstat(canonical).catch(()=>null);
  if(st?.isSymbolicLink()){
   const real=await fs.realpath(canonical).catch(()=>null);
   if(real&&!inside(real,canonicalDir))fail('这是「我的技能」，请在对应分组里删除');
  }
  // 技能目录名按 frontmatter name 生成，可能和列表里显示的名称大小写不同，这里按两者都找一遍。
  let entryName=st?name:null;
  if(!entryName){for(const s of await readSkillsIn(canonicalDir))if(s.name===name||s.entry===name){entryName=s.entry;break;}}
  let removed=false;
  if(entryName){await fs.rm(path.join(canonicalDir,entryName),{recursive:true,force:true});removed=true;}
  const links=await unlinkAgents(entryName||name);
  for(const a of skillAgents({home,env})){
   for(const s of await readSkillsIn(a.dir)){
    if(s.name!==name&&s.entry!==name&&s.entry!==entryName)continue;
    // 指向别处的符号链接（可能是别的工具建的）不动，只删真身目录与指向本技能目录的链接。
    const target=await linkTarget(s.path);
    if(target&&!inside(target,canonicalDir))continue;
    await fs.rm(s.path,{recursive:true,force:true});removed=true;
   }
  }
  if(!removed)fail('技能目录不存在',404);
  await recordLock(entryName||name,null);
  return {removed:links};
 }

 // 新建：生成模板 SKILL.md 并链接。description 空着会导致列表看不到，所以给一句默认文案。
 async function init(name){
  if(typeof name!=='string'||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(name))fail('技能名称只能包含小写字母、数字和短横线');
  const dir=path.join(canonicalDir,name);
  if(await fs.lstat(dir).catch(()=>null))fail('技能已存在',409);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: 在这里描述这个技能的用途和使用方式。\n---\n\n# ${name}\n\n在这里描述这个技能的用途和使用方式。\n`);
  const report=await link(name,await liveAgents());
  return {path:dir,report};
 }

 return {canonicalDir,lockFile,scan,add,update,remove,init,link,unlinkAgents,readLock,writeLock,liveAgents,parseSource,discover,folderHash};
}
