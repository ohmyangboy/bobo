// 管家只读取对话摘录，不复用通知岛会被 ack/过期过滤的短时列表。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseTimestamp,parseWorkspaceDir} from './agy.mjs';
const exec=promisify(execFile),TAIL=256*1024,DAY=86400000;
const digest=s=>createHash('sha256').update(s).digest('hex').slice(0,20);
export function clipBytes(text,limit){
 const value=String(text||'');if(Buffer.byteLength(value)<=limit)return value;
 let bytes=0,out='';for(const c of value){bytes+=Buffer.byteLength(c);if(bytes>limit)break;out+=c;}return out;
}
export function cleanExcerpt(text,limit=2400){
 let value=String(text||'').replace(/<(?:INSTRUCTIONS|environment_context|system_reminder|system-reminder)>[\s\S]*?<\/(?:INSTRUCTIONS|environment_context|system_reminder|system-reminder)>/gi,'')
  .replace(/^# AGENTS\.md instructions for[^\n]*\n?/gm,'').replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g,'[代码已省略]').replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi,'[凭据已省略]').trim();
 if(Buffer.byteLength(value)>limit){const head=clipBytes(value,Math.floor(limit/2)-12),tail=clipBytes([...value].reverse().join(''),Math.floor(limit/2)-12);value=head+'\n…\n'+[...tail].reverse().join('');}
 return value;
}
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p?.type==='text'||p?.type==='input_text'||p?.type==='output_text').map(p=>p.text||'').join('\n'):'';
const callsIn=content=>Array.isArray(content)&&content.some(p=>['tool_use','toolCall','tool-call','tool_call'].includes(p?.type));
const stamp=(value,fallback=0)=>parseTimestamp(value)||fallback;
const child=meta=>!!(meta?.isSidechain||meta?.parentID||meta?.parentSessionId||meta?.parent_conversation_id||Number(meta?.nesting_depth)>0||meta?.thread_source==='subagent'||meta?.source==='subagent'||meta?.source?.subagent||meta?.thread_source?.subagent);
function observation(source,sessionId,key,meta,turn){
 return {id:digest(source+':'+sessionId+':'+key),source,sessionId,title:clipBytes(meta.title||'',240),directory:meta.directory||'',at:turn.at||meta.at||0,prompt:cleanExcerpt(turn.prompt,700),reply:cleanExcerpt(turn.reply),status:turn.status||'working'};
}
export function parseCodexWork(lines,meta,mtimeMs){
 const payload=meta?.payload||{};if(child(payload))return [];
 const sid=payload.session_id||payload.id;if(!sid)return [];
 const info={directory:payload.cwd||'',title:payload.title||'',at:mtimeMs},turns=new Map();let key='tail',current=null;
 const turn=()=>{if(!turns.has(key))turns.set(key,{prompt:'',reply:'',at:0,status:'working'});return current=turns.get(key);};
 const hasTasks=lines.some(e=>e.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(e.payload?.type));
 const request=(text,at,id)=>{
  const prompt=cleanExcerpt(text);if(!prompt)return;
  if(!current||!hasTasks&&current.prompt&&current.prompt!==prompt){key=id||key;turn();}
  if(current.prompt!==prompt&&!current.prompt.split('\n').includes(prompt))current.prompt=[current.prompt,prompt].filter(Boolean).join('\n');
  current.at=at;
 };
 const finish=(p,at,status)=>{
  const previous=current,previousKey=key;if(p.turn_id)key=p.turn_id;const t=turn();
  if(previous&&previous!==t){t.prompt=t.prompt||previous.prompt;t.reply=t.reply||previous.reply;if(previous.status==='working')turns.delete(previousKey);}
  t.reply=p.last_agent_message||t.reply;t.status=status;t.at=at;current=null;
 };
 for(const ev of lines){
  const p=ev.payload||{},at=stamp(ev.timestamp,mtimeMs);
  if(ev.type==='event_msg'){
   if(p.type==='task_started'){
    const previous=current,previousKey=key;key=p.turn_id||ev.timestamp||key;const t=turn();
    if(previous&&previous!==t&&previous.status==='working'&&!previous.reply){t.prompt=previous.prompt;turns.delete(previousKey);}
   }
   else if(p.type==='user_message')request(p.message,at,p.turn_id||ev.timestamp);
   else if(p.type==='task_complete')finish(p,at,'complete');
   else if(p.type==='turn_aborted')finish(p,at,'interrupted');
   else if(p.type==='agent_message'&&current)current.reply=p.message||current.reply;
  }else if(ev.type==='response_item'&&p.type==='message'){
   if(p.role==='user')request(textOf(p.content),at,p.id||ev.timestamp);
   else if(p.role==='assistant'&&p.phase==='final'){const t=current||turn();t.reply=textOf(p.content);t.at=at;if(!hasTasks){t.status='complete';current=null;}}
  }
 }
 return [...turns].map(([id,t])=>observation('codex',String(sid),id,info,t)).filter(o=>o.prompt||o.reply);
}
export function parseMessageWork(source,lines,meta,mtimeMs){
 if(child(meta)||lines.some(e=>e.isSidechain))return [];
 const sid=meta.sessionId||meta.id;if(!sid)return [];
 const info={directory:meta.cwd||'',title:meta.title||'',at:mtimeMs},turns=[];let t=null;
 for(const ev of lines){
  if(ev.type==='ai-title'){info.title=ev.aiTitle||info.title;continue;}
  if(ev.type==='custom'&&ev.customType==='session_exit'&&t){if(ev.data?.kind!=='normal')t.status='interrupted';continue;}
  const m=ev.message;if(!m||ev.isMeta)continue;
  const at=stamp(ev.timestamp||m.timestamp,mtimeMs),text=textOf(m.content);
  if(m.role==='user'&&text){t={key:ev.uuid||ev.id||ev.timestamp||String(turns.length),prompt:text,reply:'',at,status:'working'};turns.push(t);}
  else if(m.role==='assistant'&&text){
   if(!t){t={key:ev.parentUuid||ev.uuid||ev.id||ev.timestamp||'tail',prompt:'',reply:'',at,status:'working'};turns.push(t);}
   t.reply=text;t.at=at;t.status=callsIn(m.content)||m.stop_reason==='tool_use'?'working':'complete';
  }else if(m.role==='assistant'&&callsIn(m.content)&&t)t.status='working';
 }
 return turns.map(t=>observation(source,String(sid),t.key,info,t));
}
export function parseDshWork(raw,sessionId,mtimeMs){
 // dsh 的投影没有逐轮时间，首次只取最后八轮，避免旧任务全被算成今天的进展。
 const rec=raw?.record||{},rows=rec.rows||{},outline=rows.turnOutline?.val||{},turns=(outline.turns||[]).slice(-8);
 if(child(rec.identity)||child(rows.subagent?.val))return [];
 const open=rows.turnBoundary?.val?.openTurnStartSeq!=null||rows.sessionStats?.val?.openStep!=null;
 const notification=rows.notification?.val?.last;
 return turns.map((t,index)=>observation('dsh',sessionId,t.turn??t.seq??index,{directory:rec.identity?.cwd||'',title:rows.title?.val||'',at:mtimeMs},{prompt:t.prompt,reply:t.response,at:mtimeMs,status:open&&index===turns.length-1?'working':(index===turns.length-1||notification?.turn===t.turn)&&['aborted','interrupted','failed','error','crashed'].includes(notification?.reason)?'interrupted':t.response?'complete':'working'}));
}
export function parseAgyWork(lines,row,mtimeMs){
 if(child(row))return [];
 const info={directory:parseWorkspaceDir(row.workspace_uris),title:row.title||'',at:mtimeMs},turns=[];let t=null;
 for(const ev of lines){
  const at=stamp(ev.created_at,mtimeMs);
  if(ev.type==='USER_INPUT'){t={key:ev.step_index??ev.created_at??turns.length,prompt:ev.content,reply:'',at,status:'working'};turns.push(t);}
  else if(ev.type==='PLANNER_RESPONSE'&&typeof ev.content==='string'){
   if(!t){t={key:ev.step_index??ev.created_at??'tail',prompt:row.preview||'',reply:'',at,status:'working'};turns.push(t);}
   t.reply=ev.content;t.at=at;t.status=Array.isArray(ev.tool_calls)&&ev.tool_calls.length?'working':'complete';
  }
 }
 const last=turns.at(-1);if(last&&(row.status==='CASCADE_RUN_STATUS_RUNNING'||Number(row.not_fully_idle)===1))last.status='working';
 if(last&&Number(row.killed)===1)last.status='interrupted';
 return turns.map(t=>observation('agy',String(row.conversation_id),t.key,info,t));
}
export function parseOpenCodeWork(messages,session){
 if(child(session))return [];
 const info={directory:session.location?.directory||'',title:session.title||'',at:session.time?.updated||0},turns=[];let t=null;
 for(const m of [...messages].sort((a,b)=>(a.time?.created||0)-(b.time?.created||0))){
  const at=m.time?.completed||m.time?.created||info.at;
  if(m.type==='user'){t={key:m.id,prompt:m.text,reply:'',at,status:'working'};turns.push(t);}
  else if(m.type==='assistant'){
   if(!t){t={key:m.id,prompt:'',reply:'',at,status:'working'};turns.push(t);}
   t.reply=textOf(m.content);t.at=at;t.status=m.time?.completed&&m.finish!=='tool-calls'?'complete':'working';
  }else if(m.type==='idle'&&t){t.status=m.outcome==='succeeded'?'complete':'interrupted';t.at=at;}
 }
 return turns.map(t=>observation('opencode',String(session.id),t.key,info,t)).filter(o=>o.prompt||o.reply);
}
async function* logFiles(root,extension,depth=0){
 if(depth>8)return;
 for(const e of await fs.readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
  if(e.name.startsWith('.')||e.name==='subagents')continue;
  const file=path.join(root,e.name);
  if(e.isDirectory())yield* logFiles(file,extension,depth+1);
  else if(e.isFile()&&e.name.endsWith(extension))yield file;
 }
}
async function readLog(file,size){
 const handle=await fs.open(file,'r');
 try{
  let length=Math.min(size,65536),first='',headers=[];
  while(length<=4*1024*1024){const buf=Buffer.alloc(length);await handle.read(buf,0,length,0);const end=buf.indexOf(10);if(end>=0||length===size){first=buf.subarray(0,end>=0?end:length).toString('utf8');headers=buf.toString('utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});break;}length=Math.min(size,length*2);}
  const start=Math.max(0,size-TAIL),tail=Buffer.alloc(Math.min(size,TAIL));const {bytesRead}=await handle.read(tail,0,tail.length,start);
  let text=tail.subarray(0,bytesRead).toString('utf8');if(start)text=text.slice(text.indexOf('\n')+1);
  text=text.slice(0,text.lastIndexOf('\n')+1);
  const lines=text.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  let header;try{header=JSON.parse(first);}catch{header={};}
  return {header,headers,lines};
 }finally{await handle.close();}
}
export function createProjectResolver({execute=exec,now=Date.now}={}){
 const cache=new Map();
 return async directory=>{
  if(!directory||typeof directory!=='string'||!path.isAbsolute(directory))return null;
  const real=await fs.realpath(directory).catch(()=>path.resolve(directory)),cached=cache.get(real);
  if(cached&&now()-cached.at<60*60*1000)return cached.project;
  let identity='dir:'+real,root=real;
  try{const r=await execute('git',['-C',real,'rev-parse','--path-format=absolute','--git-common-dir','--show-toplevel'],{timeout:2000,maxBuffer:16384});const [common,top]=r.stdout.trim().split('\n');if(common&&top){const canonical=await fs.realpath(common).catch(()=>common);identity='git:'+canonical;root=path.basename(canonical)==='.git'?path.dirname(canonical):top;}}catch{}
  const project={id:digest(identity),name:path.basename(root)||root,directory:root};cache.set(real,{project,at:now()});return project;
 };
}
export function createButlerSources({home,env={},now=Date.now,fetchImpl=fetch,readAgyRows}={}){
 const cache=new Map();let sqlite=null,names=new Map(),indexStamp='';
 const roots={codex:path.join(env.CODEX_HOME||path.join(home,'.codex'),'sessions'),claude:path.join(env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'projects'),omp:path.join(env.PI_CODING_AGENT_DIR||path.join(home,'.omp/agent'),'sessions'),dsh:path.join(env.DSH_HOME||path.join(home,'.dsh'),'storages/session_projcache/sessions'),agy:path.join(home,'.gemini/antigravity-cli')};
 async function codexNames(){
  const file=path.join(path.dirname(roots.codex),'session_index.jsonl'),st=await fs.stat(file).catch(()=>null),signature=st?st.mtimeMs+':'+st.size:'';
  if(signature===indexStamp)return names;
  const next=new Map();
  try{for(const line of (await fs.readFile(file,'utf8')).split('\n')){try{const row=JSON.parse(line);if(row.id)next.set(String(row.id),clipBytes(row.thread_name||row.title||'',240));}catch{}}}
  catch{if(st)return names;}
  names=next;indexStamp=signature;return names;
 }
 async function agyRows(){
  if(readAgyRows)return readAgyRows();
  const file=path.join(roots.agy,'conversation_summaries.db');if(!await fs.stat(file).catch(()=>null))return [];
  sqlite??=await import('node:sqlite');
  const wal=await fs.stat(file+'-wal').catch(()=>null),shm=await fs.stat(file+'-shm').catch(()=>null);
  if(wal&&!shm)throw Error('会话库正在切换，将稍后重试');
  const uri=wal?file:'file:'+encodeURI(file).replace(/[?#]/g,c=>'%'+c.charCodeAt(0).toString(16))+'?immutable=1';
  const db=new sqlite.DatabaseSync(uri,{readOnly:true,timeout:250});
  try{return db.prepare("SELECT conversation_id,title,preview,status,not_fully_idle,killed,last_modified_time,workspace_uris,parent_conversation_id,nesting_depth FROM conversation_summaries WHERE (parent_conversation_id IS NULL OR parent_conversation_id='') AND (nesting_depth IS NULL OR nesting_depth=0) ORDER BY last_modified_time DESC").all();}
  finally{db.close();}
 }
 async function cachedLog(file,parse,rows,since,salt=''){
  const st=await fs.stat(file).catch(()=>null);if(!st?.isFile()||st.mtimeMs<since)return;
  const signature=st.mtimeMs+':'+st.size+':'+salt;let saved=cache.get(file);
  if(saved?.signature!==signature){const log=await readLog(file,st.size);saved={signature,rows:parse(log,st),at:st.mtimeMs};cache.set(file,saved);}
  rows.push(...saved.rows.filter(o=>o.at>=since));
 }
 async function scanFiles(source,rows,since){
  const root=roots[source];
  for await(const file of logFiles(root,source==='dsh'?'.json':'.jsonl')){
   if(source==='dsh'){
    const st=await fs.stat(file).catch(()=>null);if(!st||st.mtimeMs<since||st.size>8*1024*1024)continue;
    const signature=st.mtimeMs+':'+st.size;let saved=cache.get(file);
    if(saved?.signature!==signature){const raw=JSON.parse(await fs.readFile(file,'utf8'));saved={signature,rows:parseDshWork(raw,path.basename(file,'.json').replace(/^session-/,''),st.mtimeMs),at:st.mtimeMs};cache.set(file,saved);}rows.push(...saved.rows);
   }else await cachedLog(file,({header,headers,lines},st)=>{
    if(source==='codex')return parseCodexWork(lines,header,st.mtimeMs).map(o=>({...o,fileMtime:st.mtimeMs}));
    const meta=source==='omp'?headers.find(e=>e.type==='session')||lines.find(e=>e.type==='session')||header:headers.find(e=>e.cwd&&e.sessionId)||lines.find(e=>e.cwd&&e.sessionId)||header;
    if(source==='omp')meta.title=headers.find(e=>e.type==='title')?.title||'';
    return parseMessageWork(source,lines,meta,st.mtimeMs);
   },rows,since);
  }
 }
 async function openCode(rows,since){
  const dirs=[env.XDG_STATE_HOME&&path.join(env.XDG_STATE_HOME,'opencode'),path.join(home,'.local/state/opencode'),path.join(home,'.local/share/opencode')].filter(Boolean);let service;
  for(const dir of dirs){try{const data=JSON.parse(await fs.readFile(path.join(dir,'service.json'),'utf8'));if(data.url&&data.password){service=data;break;}}catch{}}
  if(!service)return;
  const origin=new URL(service.url);if(!['http:','https:'].includes(origin.protocol))throw Error('本机 OpenCode 服务地址无效');origin.hostname='127.0.0.1';
  const headers={authorization:'Basic '+Buffer.from('opencode:'+service.password).toString('base64')};
  const request=async route=>{const response=await fetchImpl(new URL(route,origin),{headers,redirect:'error',signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('OpenCode 记录暂时不可读');return response.json();};
  const sessions=[];let cursor;
  const pages=new Set();do{const params=new URLSearchParams({limit:'100',parentID:'null',...(cursor?{cursor}:{order:'desc'})}),body=await request('/api/session?'+params);if(!Array.isArray(body.data))throw Error('OpenCode 会话格式无效');sessions.push(...body.data.filter(s=>s.time?.updated>=since&&!child(s)));cursor=body.cursor?.next;if(cursor&&pages.has(cursor))throw Error('OpenCode 分页游标重复');pages.add(cursor);}while(cursor);
  for(const s of sessions){
   const key='opencode:'+s.id,signature=String(s.time?.updated||0);let saved=cache.get(key);
   if(saved?.signature!==signature){
    const messages=[],pages=new Set();let next;
    do{const params=new URLSearchParams({limit:'50',...(next?{cursor:next}:{order:'desc'})}),body=await request('/api/session/'+encodeURIComponent(s.id)+'/message?'+params);if(!Array.isArray(body.data))throw Error('OpenCode 消息格式无效');messages.push(...body.data.filter(m=>(m.time?.created||0)>=since));next=body.cursor?.next;if(next&&pages.has(next))throw Error('OpenCode 消息分页游标重复');pages.add(next);if(body.data.some(m=>(m.time?.created||0)<since))break;}while(next);
    saved={signature,rows:parseOpenCodeWork(messages,s),at:s.time.updated};cache.set(key,saved);
   }
   rows.push(...saved.rows);
  }
 }
 async function scan({since=now()-7*DAY}={}){
  const rows=[],errors={};
  // 扫描失败保留此前缓存；不会把一次半写入或断线当作记录被删除。
  for(const source of ['codex','claude','omp','dsh','agy','opencode']){
   try{
    if(source==='agy'){for(const row of await agyRows()){const at=stamp(row.last_modified_time);if(at<since||child(row))continue;const file=path.join(roots.agy,'brain',String(row.conversation_id),'.system_generated/logs/transcript.jsonl');await cachedLog(file,({lines},st)=>parseAgyWork(lines,row,st.mtimeMs),rows,since,[row.status,row.not_fully_idle,row.killed].join(':'));}}
    else if(source==='opencode')await openCode(rows,since);
    else await scanFiles(source,rows,since);
   }catch{errors[source]=source==='agy'?'Antigravity 会话库暂时不可读（需要 Node.js 22.13+）':'对话记录暂时不可读，将稍后重试';}
  }
  // Codex rollover 可能把同一会话复制到多份文件，只采用最新写入文件里的轮次。
  const newest=new Map();for(const o of rows)if(o.source==='codex')newest.set(o.sessionId,Math.max(newest.get(o.sessionId)||0,o.fileMtime||0));
  const titles=await codexNames();
  const observations=[...new Map(rows.filter(o=>o.source!=='codex'||o.fileMtime===newest.get(o.sessionId)).map(({fileMtime,...o})=>[o.id,o.source==='codex'?{...o,title:titles.get(o.sessionId)||o.title}:o])).values()];
  for(const [file,value] of cache)if(value.at<now()-30*DAY)cache.delete(file);
  return {observations,errors};
 }
 async function resolveTarget(target){
  if(target.source!=='codex')return target;
  const title=(await codexNames()).get(target.sessionId);
  return title?{...target,title}:target;
 }
 return {scan,resolveTarget};
}
