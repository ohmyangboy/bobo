import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {splitMarkdown} from '../public/markdown.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
// 技能与智能体共用同一套快照、缓存与翻译分批逻辑，只是来源不同：技能按目录快照，智能体是单个 Markdown 文件。
export function createSkillReader({home,ai,resolveSkill}){return createReader({home,ai,resolve:resolveSkill,kind:'skill'});}
export function createAgentReader({home,ai,resolveAgent}){return createReader({home,ai,resolve:resolveAgent,kind:'agent'});}
// Codex 的自定义智能体同样是单个文件（TOML），复用同一套快照/缓存/翻译，只用 prefix 把缓存目录分开。
export function createCodexAgentReader({home,ai,resolveAgent}){return createReader({home,ai,resolve:resolveAgent,kind:'agent',prefix:'codex-agent:'});}
// 全局配置（~/.config/opencode/AGENTS.md、~/.codex/config.toml 等）也是单个文件，行为与智能体一致，
// 只是提示词里称「配置」，并用自己的缓存前缀，避免与同名智能体互相覆盖。
export function createConfigReader({home,ai,resolveConfig}){return createReader({home,ai,resolve:resolveConfig,kind:'agent',prefix:'config:',noun:'配置',subject:'config'});}
function createReader({home,ai,resolve,kind,prefix,noun,subject}){
 const directory=path.join(home,'.bobo','ai-cache'),epochs=new Map(),pending=new Map(),isAgent=kind==='agent';
 const what=noun||(isAgent?'智能体':'技能'),promptSubject=subject||kind;
 let writes=Promise.resolve();
 function writeSerial(fn){const task=writes.then(fn);writes=task.catch(()=>{});return task;}
 // 每个来源一个目录，每个被翻译的文件一份缓存，路径不同互不覆盖。
 // 技能沿用原有目录名（兼容既有缓存）；智能体加前缀，避免与技能 id 落在同一目录。
 const key=id=>isAgent?(prefix??'agent:')+id:id;
 const cachePath=(id,rel)=>path.join(directory,digest(key(id)),digest(rel)+'.json');
 const jobKey=(id,rel)=>key(id)+'\u0000'+rel;
 const epochOf=id=>epochs.get(key(id))||0;
 async function snapshot(id,rel){
  if(isAgent){
   const source=await resolve(id),target=source.path;
   let stat;try{stat=await fs.lstat(target);}catch(e){if(e.code==='ENOENT')fail('文件不存在',404);throw e;}
   if(stat.isSymbolicLink())fail('不允许翻译符号链接',400);
   if(!stat.isFile())fail('必须是普通文件',400);
   if(stat.size>180000)fail('文件超过 180 KB',413);
   const content=await fs.readFile(target,'utf8'),revision=digest(JSON.stringify([target,stat.ino,stat.birthtimeMs,content])),config=await ai.status(),signature=digest(JSON.stringify([revision,config.baseUrl,config.model,'reader-agent-v1',prefix??'agent:']));
   return {id,rel:'AGENT.md',content,revision,signature,blocks:splitMarkdown(content)};
  }
  if(rel===undefined||rel==='')rel='SKILL.md';
  if(typeof rel!=='string')fail('无效文件路径',400);
  const skill=await resolve(id),root=await fs.realpath(skill.path),target=path.resolve(root,rel);
  if(target!==root&&!target.startsWith(root+path.sep))fail('无效文件路径',400);
  let real;try{real=await fs.realpath(target);}catch(e){if(e.code==='ENOENT')fail('文件不存在',404);throw e;}
  if(real!==target)fail('不允许翻译符号链接',400);
  const stat=await fs.lstat(target);if(!stat.isFile())fail(rel+' 必须是普通文件',400);
  if(stat.size>180000)fail(rel+' 超过 180 KB',413);
  const content=await fs.readFile(target,'utf8'),stamps=[];
  async function walk(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name.startsWith('.')||entry.name==='node_modules')continue;const full=path.join(dir,entry.name),st=await fs.lstat(full);stamps.push([path.relative(root,full),st.ino,st.size,st.mtimeMs,st.birthtimeMs]);if(entry.isDirectory())await walk(full);}}
  await walk(root);const st=await fs.stat(root);
  const revision=digest(JSON.stringify([root,st.ino,st.birthtimeMs,rel,content,stamps]));
  const config=await ai.status(),signature=digest(JSON.stringify([revision,config.baseUrl,config.model,'reader-v1']));
  return {id,rel,content,revision,signature,blocks:splitMarkdown(content)};
 }
 async function read(snap){try{const c=JSON.parse(await fs.readFile(cachePath(snap.id,snap.rel),'utf8'));return c.signature===snap.signature?c:{signature:snap.signature};}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {signature:snap.signature};throw e;}}
 async function document(id,rel='SKILL.md'){
  const snap=await snapshot(id,rel),cache=await read(snap),running=pending.get(jobKey(snap.id,snap.rel));
  const fresh=running&&running.signature===snap.signature&&running.epoch===epochOf(id),hasSummary=isAgent||snap.rel==='SKILL.md';
  return {revision:snap.revision,path:snap.rel,blocks:snap.blocks,summary:hasSummary?(fresh&&running.summary?running.summary:cache.summary||null):null,translation:cache.translation||null,pending:running?.mode||null};
 }
 async function invalidate(ids){for(const id of ids)epochs.set(key(id),epochOf(id)+1);await writeSerial(async()=>{for(const id of ids)await fs.rm(path.join(directory,digest(key(id))),{recursive:true,force:true});});}
 async function generate(id,mode,rel='SKILL.md',emit=()=>{}){
  if(typeof rel==='function'){emit=rel;rel='SKILL.md';}
  if(!['summary','translate'].includes(mode))fail('不支持的 AI 操作',400);
  if(mode==='summary'&&!isAgent&&rel!=='SKILL.md')fail('能力总结仅支持 SKILL.md',400);
  const snap=await snapshot(id,rel),cache=await read(snap),field=mode==='summary'?'summary':'translation';
  if(cache[field]?.complete)return {...cache[field],cached:true};
  const pendingKey=jobKey(id,snap.rel);if(pending.has(pendingKey))fail('此文件正在生成，请稍候');
  const epoch=epochOf(id),job={mode,rel:snap.rel,signature:snap.signature,epoch};pending.set(pendingKey,job);
  emit({type:'start',revision:snap.revision});
  async function commit(result){
   const current=await snapshot(id,snap.rel);
   if(epochOf(id)!==epoch||current.signature!==snap.signature)fail(what+'或 AI 配置已变更，请重新生成');
   await writeSerial(async()=>{
   if(epochOf(id)!==epoch)fail(what+'已更新，请重新生成');
   const latest=await read(snap);if(field==='translation'&&latest.translation){result={...result,segments:{...latest.translation.segments,...result.segments}};result.done=Object.keys(result.segments).length;}latest[field]=result;
   await fs.mkdir(path.dirname(cachePath(id,snap.rel)),{recursive:true});const tmp=cachePath(id,snap.rel)+'.'+randomUUID()+'.tmp';
   await fs.writeFile(tmp,JSON.stringify(latest),{mode:0o600});
   if(epochOf(id)!==epoch){await fs.rm(tmp,{force:true});fail(what+'已更新，请重新生成');}
   await fs.rename(tmp,cachePath(id,snap.rel));
   });
  }
  try{
   if(mode==='summary'){
    let text='';
    const r=await ai.generate({mode,content:snap.content,subject:promptSubject,onDelta:delta=>{if(epochOf(id)!==epoch)fail(what+'已更新，请重新生成');text+=delta;job.summary={text,complete:false};emit({type:'summary',delta});}});const result={...r,complete:!r.incomplete,createdAt:new Date().toISOString()};
    if(result.complete)await commit(result);return result;
   }
   const blocks=snap.blocks.filter(b=>!['code','rule'].includes(b.type)),segments={...(cache.translation?.segments||{})};
   const todo=blocks.filter(b=>!segments[b.id]);let model=cache.translation?.model;
   const batches=[];
   while(todo.length){
    const batch=[];let length=0;
    while(todo.length&&batch.length<(batches.length===0&&!Object.keys(segments).length?2:6)&&(length+todo[0].text.length<6500||!batch.length)){const b=todo.shift();batch.push({id:b.id,text:b.text});length+=b.text.length;}
    batches.push(batch);
   }
   let failure;
   async function worker(){
    while(batches.length&&!failure){
     const batch=batches.shift();
     try{
      const r=await ai.generate({mode,content:JSON.stringify(batch),structured:true,subject:promptSubject});model=r.model;
      if(r.incomplete)fail('本批译文被模型截断，已保留完成的段落，请重试',502);
      let translated;try{translated=JSON.parse(r.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));}catch{fail('译文格式不完整，已保留完成的段落，请重试',502);}
      if(!Array.isArray(translated)||translated.length!==batch.length||batch.some(b=>translated.filter(t=>t.id===b.id&&typeof t.text==='string'&&t.text.trim()).length!==1))fail('译文段落不匹配，已保留完成的段落，请重试',502);
      for(const item of translated)segments[item.id]=item.text;
      // 完整状态只在两个 worker 都结束后提交，单批先持久化，支持失败续译。
      const progress={segments:{...segments},complete:false,model,total:blocks.length,done:Object.keys(segments).length,createdAt:new Date().toISOString()};
      await commit(progress);emit({type:'translation',translation:{...progress,segments:{...segments},done:Object.keys(segments).length}});
     }catch(e){failure=e;}
    }
   }
   await Promise.all([worker(),worker()]);if(failure)throw failure;
   const result={segments,complete:true,model:model||(await ai.status()).model,total:blocks.length,done:blocks.length,createdAt:new Date().toISOString()};await commit(result);return result;
  }finally{if(pending.get(pendingKey)===job)pending.delete(pendingKey);}
 }
 return {document,generate,invalidate};
}
