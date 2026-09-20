import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { linkDir, removeLink, pickFolder } from './platform.mjs';
// git / gh 调用统一走这里：参数数组 + shell:false，不经过 shell。
const run=(cmd,args,cwd,env,timeout=300000)=>new Promise(resolve=>{
 const child=spawn(cmd,args,{cwd,env,shell:false,stdio:['ignore','pipe','pipe']});
 let output='',stdout='',failure=null;const collect=b=>{output=(output+b).slice(-200000);};
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',b=>{stdout=(stdout+b).slice(-200000);collect(b);});child.stderr.on('data',collect);
 const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
 child.on('error',e=>{failure=e;resolve({code:127,output:e.message,stdout:''});});
 child.on('close',code=>{clearTimeout(timer);if(failure)return;resolve({code:code??1,output:output.trim(),stdout:stdout.trim()});});
});
const repoOf=url=>String(url||'').match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)?.slice(1).join('/')||null;
const remoteOK=url=>typeof url==='string'&&url.length>3&&url.length<500&&url[0]!=='-'&&!/[\s\x00-\x1f]/.test(url)&&/^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url);

export function createSources({home,env,fail}){
 const configFile=path.join(home,'.bobo','sources.json'),linksDir=path.join(home,'.agents','skills');
 const inside=(p,parent)=>p===parent||p.startsWith(parent+path.sep);
 const isDir=p=>fs.stat(p).then(s=>s.isDirectory(),()=>false);
 const hasSkill=p=>fs.access(path.join(p,'SKILL.md')).then(()=>true,()=>false);
 const linkTarget=link=>fs.readlink(link).then(t=>path.resolve(path.dirname(link),t)).catch(()=>null);
 const expand=v=>{const raw=String(v||'').trim();return raw==='~'?home:/^~[/\\]/.test(raw)?path.join(home,raw.slice(2)):raw;};
 let picking=false;

 async function roots(){
  try{const list=JSON.parse(await fs.readFile(configFile,'utf8'));return Array.isArray(list)?list.filter(s=>s&&typeof s.path==='string'&&path.isAbsolute(s.path)):[];}
  catch{return [];}
 }
 async function save(list){await fs.mkdir(path.dirname(configFile),{recursive:true});await fs.writeFile(configFile+'.tmp',JSON.stringify(list,null,2));await fs.rename(configFile+'.tmp',configFile);}
 async function requireRoot(target){
  const abs=path.resolve(expand(target)),real=await fs.realpath(abs).catch(()=>abs);
  const item=(await roots()).find(r=>r.path===abs||r.path===real);
  if(!item)fail('该目录尚未添加',404);
  if(!await isDir(item.path))fail('目录不存在或已被移动');
  return item.path;
 }
 // 直接子目录 + 目录自身；跳过隐藏目录、node_modules 和指向非目录的链接。
 async function discover(root){
  const out=[];
  if(await hasSkill(root))out.push({name:path.basename(root),dir:root});
  for(const e of (await fs.readdir(root,{withFileTypes:true}).catch(()=>[])).sort((a,b)=>a.name.localeCompare(b.name))){
   if(e.name.startsWith('.')||e.name==='node_modules')continue;
   const dir=path.join(root,e.name);
   if(!await isDir(dir))continue;
   if(await hasSkill(dir))out.push({name:e.name,dir});
  }
  return out;
 }
 async function unlinkUnder(root){
  const removed=[];
  for(const e of await fs.readdir(linksDir,{withFileTypes:true}).catch(()=>[])){
   if(!e.isSymbolicLink())continue;
   const link=path.join(linksDir,e.name),target=await linkTarget(link);
   if(target&&inside(target,root)){await fs.unlink(link);removed.push(e.name);}
  }
  return removed;
 }
 async function gitInfo(root){
  if((await run('git',['rev-parse','--is-inside-work-tree'],root,env)).output!=='true')return {initialized:false,origin:null,repo:null,branch:null,changes:0};
  const origin=(await run('git',['remote','get-url','origin'],root,env)).stdout;
  const branch=(await run('git',['symbolic-ref','--short','HEAD'],root,env)).stdout;
  const dirty=(await run('git',['status','--porcelain'],root,env)).stdout;
  return {initialized:true,origin:origin||null,repo:repoOf(origin),branch:branch||null,changes:dirty?dirty.split('\n').length:0};
 }

 // 目录里的技能 + 它们在 ~/.agents/skills 里的链接状态（linked / disabled / conflict / missing）。
 async function entries(root,off=new Set()){
  const out=[];
  for(const s of await discover(root)){
   const link=path.join(linksDir,s.name),st=await fs.lstat(link).catch(()=>null);
   out.push({name:s.name,path:s.dir,status:st?(st.isSymbolicLink()&&await linkTarget(link)===s.dir?'linked':'conflict'):off.has(s.name)?'disabled':'missing'});
  }
  return out;
 }

 async function overview(){
  const out=[];
  for(const r of await roots()){
   if(!await isDir(r.path)){out.push({...r,exists:false,skills:[]});continue;}
   out.push({...r,exists:true,skills:await entries(r.path,new Set(r.disabled||[])),git:await gitInfo(r.path)});
  }
  return out;
 }

 // 把目录下已启用的技能链接到 ~/.agents/skills，并清理指向本目录的失效链接；停用名单里的技能不动。
 async function relink(target){
  const root=await requireRoot(target),list=await roots(),item=list.find(r=>r.path===root),off=new Set(item?.disabled||[]);
  const all=await discover(root),wanted=new Map();
  for(const s of all)if(!off.has(s.name))wanted.set(s.name,s.dir);
  // 目录里已不存在的技能从停用名单里清掉，避免同名新技能被误停用。
  if(item&&Array.isArray(item.disabled)){
   const kept=item.disabled.filter(n=>all.some(s=>s.name===n));
   if(kept.length!==item.disabled.length){item.disabled=kept;await save(list);}
  }
  await fs.mkdir(linksDir,{recursive:true});
  const report={linked:[],kept:[],conflicts:[],removed:[]};
  for(const e of await fs.readdir(linksDir,{withFileTypes:true})){
   if(!e.isSymbolicLink())continue;
   const link=path.join(linksDir,e.name),t=await linkTarget(link);
   if(!t||!inside(t,root))continue;
   if(wanted.get(e.name)===t&&await isDir(t))continue;
   await removeLink(link);report.removed.push(e.name);
  }
  for(const [name,dir] of wanted){
   const link=path.join(linksDir,name),st=await fs.lstat(link).catch(()=>null);
   if(st){
    if(st.isSymbolicLink()&&await linkTarget(link)===dir){report.kept.push(name);continue;}
    report.conflicts.push(name);continue;
   }
   await linkDir(dir,link,{relative:false});report.linked.push(name);
  }
  return report;
 }

 // 单个技能的按需启停：停用只删除 ~/.agents/skills 里的链接并记入名单，源文件保留。
 async function setEnabled(target,name,enabled){
  const root=await requireRoot(target);
  if(typeof name!=='string'||!name||name.includes('/')||name.startsWith('.'))fail('无效的技能名称');
  const dir=path.join(root,name);
  if(path.dirname(dir)!==root)fail('无效的技能名称');
  const list=await roots(),item=list.find(r=>r.path===root),off=new Set(item?.disabled||[]),link=path.join(linksDir,name);
  if(enabled){
   if(!await isDir(dir))fail('技能目录不存在',404);
   const st=await fs.lstat(link).catch(()=>null);
   if(st){if(!(st.isSymbolicLink()&&await linkTarget(link)===dir))fail('~/.agents/skills 已有同名技能，请先处理冲突');}
   else{await linkDir(dir,link,{relative:false});}
   off.delete(name);
  }else{
   if(await linkTarget(link)===dir)await removeLink(link);
   off.add(name);
  }
  if(item){item.disabled=[...off].sort();item.updatedAt=new Date().toISOString();await save(list);}
  return {ok:true,name,enabled:!!enabled};
 }

 // 用系统文件夹选择器挑目录，避免手输路径（macOS 用 osascript，Windows 用 PowerShell，见 platform.mjs）。
 async function pick(){
  if(picking)fail('文件夹选择器已经打开，请先完成或取消',409);
  picking=true;
  try{
   try{return await pickFolder({env});}
   catch(e){if(e?.userFacing)fail(e.message);throw e;}
  }finally{picking=false;}
 }

 async function add(input){
  const raw=expand(input?.path);
  if(!raw||!path.isAbsolute(raw))fail('请输入绝对路径，例如 ~/Desktop/my-skills');
  const abs=path.resolve(raw);
  if(abs===home)fail('不能使用主目录本身');
  if(inside(abs,path.join(home,'.agents'))||inside(abs,path.join(home,'.bobo')))fail('不能在 .agents 或 .bobo 内添加目录');
  let st=await fs.stat(abs).catch(()=>null);
  if(!st){await fs.mkdir(abs,{recursive:true});st=await fs.stat(abs);}
  if(!st.isDirectory())fail('该路径不是目录');
  const real=await fs.realpath(abs),list=await roots();
  for(const r of list){
   if(r.path===real)fail('该目录已在列表中');
   if(inside(real,r.path)||inside(r.path,real))fail('该目录与「'+(r.name||path.basename(r.path))+'」重叠');
  }
  list.push({path:real,name:path.basename(real),addedAt:new Date().toISOString()});
  await save(list);
  return {path:real,name:path.basename(real),report:await relink(real)};
 }

 // 只移除管理配置与链接，保留目录内容。
 async function remove(target){
  const abs=path.resolve(expand(target)),real=await fs.realpath(abs).catch(()=>abs),list=await roots();
  const item=list.find(r=>r.path===abs||r.path===real);
  if(!item)fail('该目录尚未添加',404);
  await save(list.filter(r=>r.path!==item.path));
  return {ok:true,removed:await unlinkUnder(item.path)};
 }

 async function removeSkill(target,name){
  const root=await requireRoot(target);
  if(typeof name!=='string'||!name||name.includes('/')||name.startsWith('.'))fail('无效的技能名称');
  const dir=path.join(root,name);
  if(dir===root||path.dirname(dir)!==root)fail('无效的技能名称');
  if(!await isDir(dir))fail('技能目录不存在',404);
  const link=path.join(linksDir,name);
  if(await linkTarget(link)===dir)await fs.unlink(link);
  await fs.rm(dir,{recursive:true,force:true});
  const list=await roots(),item=list.find(r=>r.path===root);
  if(item?.disabled?.includes(name)){item.disabled=item.disabled.filter(n=>n!==name);await save(list);}
  return {ok:true};
 }

 async function createSkill(target,name,description){
  const root=await requireRoot(target);
  if(typeof name!=='string'||! /^[a-z0-9][a-z0-9-]{0,79}$/.test(name))fail('技能名称只能包含小写字母、数字和短横线');
  const dir=path.join(root,name);
  if(await fs.lstat(dir).catch(()=>null))fail('技能已存在',409);
  // 同名技能此前被停用过时不沿用旧名单，新建的技能默认启用。
  const list=await roots(),item=list.find(r=>r.path===root);
  if(item?.disabled?.includes(name)){item.disabled=item.disabled.filter(n=>n!==name);await save(list);}
  await fs.mkdir(dir,{recursive:true});
  // CLI 只收录 description 非空的技能，留空会导致新建后列表里看不到，所以空描述也给一句默认文案。
  const desc=String(description||'').replace(/\n/g,' ').trim()||'在这里描述这个技能的用途和使用方式。';
  await fs.writeFile(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n在这里描述这个技能的用途和使用方式。\n`);
  return {path:dir,report:await relink(root)};
 }

 async function sync(target,o={}){
  const root=await requireRoot(target),steps=[],mode=o.mode==='create'?'create':'existing';
  let repo='',url='';
  if(mode==='create'){
   if((await run('gh',['--version'],root,env)).code!==0)fail('未找到 gh 命令行，请先安装并登录 gh，或改用「使用已有远程地址」');
   repo=String(o.repo||'').trim()||path.basename(root);
   if(! /^[\w.-]+(\/[\w.-]+)?$/.test(repo))fail('仓库名只能包含字母、数字、点、短横线和斜杠');
  }else{
   url=String(o.url||'').trim();
   if(!remoteOK(url))fail('请输入有效的远程地址，例如 git@github.com:owner/repo.git');
  }
  const git=async args=>{const r=await run('git',args,root,env);if(r.code!==0)fail(r.output.split('\n').filter(Boolean).pop()||'Git 执行失败');return r.output;};
  let origin=(await run('git',['remote','get-url','origin'],root,env)).stdout;
  if(mode==='create'&&origin)fail('已存在远程 origin：'+origin+'，请改用「使用已有远程地址」');
  if((await run('git',['rev-parse','--is-inside-work-tree'],root,env)).stdout!=='true'){await git(['init','-b','main']);steps.push('初始化 Git 仓库');}
  if(!(await run('git',['config','user.email'],root,env)).stdout){
   const login=(await run('gh',['api','user','--jq','.login'],root,env)).stdout;
   await git(['config','user.email',(login||'bobo')+'@users.noreply.github.com']);
   await git(['config','user.name',login||'bobo']);
   steps.push('设置提交身份');
  }
  await git(['add','-A']);
  const changed=(await run('git',['status','--porcelain'],root,env)).stdout;
  if(changed){await git(['-c','commit.gpgsign=false','commit','-m',String(o.message||'').trim()||('同步技能 '+new Date().toISOString().slice(0,16).replace('T',' '))]);steps.push('提交 '+changed.split('\n').length+' 个改动');}
  const branch=(await run('git',['symbolic-ref','--short','HEAD'],root,env)).stdout||'main';
  if(mode==='create'){
   const r=await run('gh',['repo','create',repo,o.visibility==='public'?'--public':'--private','--source',root,'--remote','origin','--push'],root,env);
   if(r.code!==0)fail(r.output||'gh repo create 失败');
   steps.push('创建'+(o.visibility==='public'?'公开':'私有')+'仓库并推送');
   origin=(await run('git',['remote','get-url','origin'],root,env)).stdout;
  }else{
   if(origin!==url){if(origin)await git(['remote','set-url','origin',url]);else await git(['remote','add','origin',url]);}
   const r=await run('git',['push','-u','origin',branch],root,env);
   if(r.code!==0)fail(r.output||'推送失败');
   steps.push('推送到 '+(repoOf(url)||url));
   origin=url;
  }
  const list=await roots(),item=list.find(r=>r.path===root);
  if(item){item.repo=repoOf(origin);item.branch=branch;item.updatedAt=new Date().toISOString();await save(list);}
  return {ok:true,steps,repo:repoOf(origin),origin,committed:!!changed};
 }

 // 一键同步：先把每个目录的技能链接到 ~/.agents/skills（启用），再推送到已配置的 GitHub 远程。
 async function syncAll(){
  const results=[];
  for(const r of await roots()){
   const name=r.name||path.basename(r.path),item={path:r.path,name,linked:[],conflicts:[],removed:[],pushed:false,repo:null,note:'',error:null};
   try{
    const report=await relink(r.path);
    item.linked=report.linked;item.conflicts=report.conflicts;item.removed=report.removed;
   }catch(e){item.error=e.message;results.push(item);continue;}
   try{
    const git=await gitInfo(r.path);
    if(!git.initialized)item.note='不是 Git 仓库，未推送';
    else if(!git.origin)item.note='未连接远程仓库，未推送';
    else{const res=await sync(r.path,{mode:'existing',url:git.origin});item.pushed=true;item.repo=res.repo;}
   }catch(e){item.error=e.message;}
   results.push(item);
  }
  return {results};
 }

 return {roots,overview,entries,add,remove,relink,setEnabled,removeSkill,createSkill,sync,syncAll,pick};
}
