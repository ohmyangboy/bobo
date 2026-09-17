import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAgent, agentProblems, agentIdOK, setAgentDisabled, agentTemplate } from './public/agent-format.js';
import { pruneBackups } from './backups.mjs';

// OpenCode V2 的全局智能体目录：目录里每个 .md 文件定义一个 agent，文件名（相对路径）就是 ID，
// frontmatter 与正文分别是配置与系统提示词。这里只负责文件本身，不接触 opencode.json 里的 agents 字段。
export function createAgents({home,fail}){
 const root=path.join(home,'.config','opencode','agents'),backups=path.join(home,'.bobo','backups');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const label=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-agent-';
 // ID 一律映射到 agents 目录里的 .md 文件；agentIdOK 已排除绝对路径、.. 与隐藏目录。
 function target(id){
  if(!agentIdOK(id))fail('无效的智能体 ID：只能使用小写字母、数字和短横线，目录用 / 分隔');
  return path.join(root,id+'.md');
 }
// 备份单个定义文件，并与技能备份共用「最近 3 份」的配额（超出淘汰最旧）。
 async function backup(abs,op){
  const dest=path.join(backups,label()+op);
  await fs.mkdir(dest,{recursive:true});
  const name=path.basename(abs);await fs.copyFile(abs,path.join(dest,name));
  await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify([{original:abs,backup:name}],null,2));
  await pruneBackups(backups);
  return dest;
 }
 async function scan(dir,prefix,out){
  for(const e of (await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])).sort((a,b)=>a.name.localeCompare(b.name))){
   if(e.name.startsWith('.')||e.name==='node_modules')continue;
   const abs=path.join(dir,e.name),rel=prefix?prefix+'/'+e.name:e.name;
   if(e.isDirectory()){await scan(abs,rel,out);continue;}
   if(!e.name.endsWith('.md'))continue;
   const st=await fs.lstat(abs).catch(()=>null);if(!st)continue;
   const text=await fs.readFile(abs,'utf8').catch(()=>null);
   const id=rel.slice(0,-3),parsed=parseAgent(text??'');
   out.push({id,file:rel,path:abs,link:st.isSymbolicLink(),size:st.size,mtime:st.mtime.toISOString(),
    nameField:parsed.data.name||'',description:parsed.data.description||'',mode:parsed.data.mode||'',model:parsed.data.model||'',color:parsed.data.color||'',
    disabled:parsed.data.disabled===true,hidden:parsed.data.hidden===true,hasFrontmatter:parsed.has,problems:agentProblems(id,parsed)});
  }
 }
 async function list(){
  const out=[];
  await scan(root,'',out);
  return {root,agents:out};
 }
 async function file(id){
  const abs=target(id);let b;
  try{b=await fs.readFile(abs);}catch(e){if(e.code==='ENOENT')fail('智能体不存在，请刷新',404);throw e;}
  if(b.length>1000000)fail('文件超过 1 MB，请在 Finder 中打开');
  return {id,file:id+'.md',path:abs,content:b.toString('utf8'),version:hash(b)};
 }
 async function save({id,content,version}={}){
  if(typeof content!=='string'||content.length>1000000)fail('文件内容无效');
  const abs=target(id),st=await fs.lstat(abs).catch(()=>null);
  if(!st)fail('智能体不存在，请刷新',404);
  if(st.isSymbolicLink())fail('不能编辑符号链接');
  if(version!==hash(Buffer.from(await fs.readFile(abs))))fail('文件已被其他程序修改，请重新打开',409);
  const saved=await backup(abs,'edit');
  await fs.writeFile(abs,content);
  return {ok:true,backup:saved,version:hash(Buffer.from(content))};
 }
 async function create(o={}){
  const id=String(o.id||'').trim();
  if(!agentIdOK(id))fail('ID 只能包含小写字母、数字和短横线，目录用 / 分隔');
  const abs=target(id);
  if(await fs.lstat(abs).catch(()=>null))fail('同名智能体已存在',409);
  await fs.mkdir(path.dirname(abs),{recursive:true});
  await fs.writeFile(abs,agentTemplate({id,description:o.description,mode:o.mode,color:o.color}));
  return {ok:true,id,file:id+'.md',path:abs};
 }
 async function rename({id,next}={}){
  const from=target(id),to=target(typeof next==='string'?next.trim():'');
  if(from===to)fail('新 ID 与当前相同');
  const st=await fs.lstat(from).catch(()=>null);
  if(!st)fail('智能体不存在，请刷新',404);
  if(st.isSymbolicLink())fail('不能移动符号链接');
  if(await fs.lstat(to).catch(()=>null))fail('目标 ID 已存在',409);
  await fs.mkdir(path.dirname(to),{recursive:true});
  await backup(from,'rename');
  await fs.rename(from,to);
  return {ok:true,id:next,file:next+'.md',path:to};
 }
 async function remove({id}={}){
  const abs=target(id),st=await fs.lstat(abs).catch(()=>null);
  if(!st)fail('智能体不存在，请刷新',404);
  if(st.isSymbolicLink())await fs.unlink(abs);
  else{await backup(abs,'delete');await fs.unlink(abs);}
  return {ok:true};
 }
 async function toggle({id,enabled}={}){
  const abs=target(id),st=await fs.lstat(abs).catch(()=>null);
  if(!st)fail('智能体不存在，请刷新',404);
  if(st.isSymbolicLink())fail('不能修改符号链接');
  const old=await fs.readFile(abs,'utf8'),text=setAgentDisabled(old,!enabled);
  if(text!==old){await backup(abs,'toggle');await fs.writeFile(abs,text);}
  return {ok:true,id,enabled:!!enabled,version:hash(Buffer.from(text))};
 }
 return {root,list,file,save,create,rename,remove,toggle};
}
