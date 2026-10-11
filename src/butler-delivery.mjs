import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createOtty} from './otty.mjs';
import {samePath} from './terminals.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const controls=/[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const sources={codex:'codex',claude:'claude',claudecode:'claude',opencode:'opencode',omp:'omp',ohmypi:'omp',deepseek:'dsh',dsh:'dsh',antigravity:'agy',agy:'agy'};
const agentSource=agent=>sources[String(agent||'').toLowerCase().replace(/[^a-z]/g,'')];
const plainTitle=text=>String(text||'').replace(/^[^\p{L}\p{N}]+/u,'').replace(/^π[\s>]+/u,'').replace(/^(?:CX|CDX|Codex|OC|AGY|Antigravity)\s*\|\s*/i,'').replace(/^[^\p{L}\p{N}]+/u,'').trim();

export function matchReplyPane(panes,target){
 const candidates=(panes||[]).filter(p=>p.id&&agentSource(p.agent)===target.source);
 const exact=candidates.filter(p=>p.agent_session_id&&String(p.agent_session_id).replace(new RegExp('^'+target.source+':'),'')===target.sessionId);
 if(exact.length===1)return exact[0];
 if(exact.length>1)return null;
 // 未上报会话 ID 的终端只允许“Agent + 工作目录 + 完整标题”唯一匹配，不按目录猜测。
 const title=plainTitle(target.title),folder=path.basename(target.directory||'');
 if(!title)return null;
 const matches=candidates.filter(p=>{
  if(p.agent_session_id||!samePath(p.cwd,target.directory))return false;
  return [p.title,p.process].some(value=>{
   let label=plainTitle(value);
   if(folder&&label.endsWith(' | '+folder))label=label.slice(0,-folder.length-3).trim();
   return label===title;
  });
 });
 return matches.length===1?matches[0]:null;
}

export function routeInstruction(text,targets){
 const normalize=s=>String(s||'').normalize('NFKC').toLowerCase();
 const content=normalize(text),includes=name=>{
  name=normalize(name);if(name.length<2)return false;
  if(/^[a-z0-9_-]+$/.test(name))return new RegExp('(?<![a-z0-9_])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![a-z0-9_])','i').test(content);
  return content.includes(name);
 };
 const titles=targets.filter(t=>t.title&&includes(t.title));if(titles.length===1)return {target:titles[0]};
 let matches=targets.filter(t=>includes(t.name));
 if(!matches.length){
  const aliases=t=>/blog/i.test(t.name)?['博客']:/rss/i.test(t.name)?['rss','阅读器']:/^bobo$/i.test(t.name)?['管家','通知岛']:[];
  matches=targets.filter(t=>aliases(t).some(includes));
 }
 if(matches.length>1){const byAgent=matches.filter(t=>includes(t.source)||includes(t.source==='dsh'?'DeepSeek':t.source==='agy'?'Antigravity':t.source==='claude'?'Claude':''));if(byAgent.length)matches=byAgent;}
 if(matches.length===1)return {target:matches[0]};
 if(!matches.length&&targets.length===1)return {target:targets[0]};
 return {candidates:matches.length?matches:targets,reason:'请选择这条指令要发回的会话'};
}

export function validateInstruction(input,message){
 const attachments=validateImages(input?.attachments);
 if(typeof input?.text!=='string'||(!input.text.trim()&&!attachments.length)||input.text.length>4096)fail('请输入 1–4096 字的新指令，或粘贴图片');
 const text=input.text.replace(/\r\n?/g,'\n').trim()||(attachments.length?'请查看附图。':'');
 if(controls.test(text))fail('指令包含无效控制字符');
 let quote='';
 if(message){
  if(message.role!=='butler')fail('请选择一条 bobo 消息进行引用');
  quote=input.quote??message.text;
  if(typeof quote!=='string'||!quote.trim()||![message.text,message.request].some(value=>value?.includes(quote.trim())))fail('引用内容已变化，请重新选择');
  quote=quote.trim();
  if(controls.test(quote))fail('引用包含无效控制字符，请重新选择');
 }
 return {text,quote,attachments,attachmentIds:attachments.map(a=>a.id),prompt:quote?'以下是 bobo 的进展摘录，仅作为背景：\n> '+quote.replace(/\n/g,'\n> ')+'\n\n我的新指令：\n'+text:text};
}

// 客户端统一转 PNG；只接收图片内容，不允许客户端指定落盘路径。
export function validateImages(input=[]){
 if(!Array.isArray(input)||input.length>4)fail('最多添加 4 张图片');
 return input.map(image=>{
  if(image?.mimeType!=='image/png'||typeof image.data!=='string'||image.data.length>5592408||! /^[A-Za-z0-9+/]+={0,2}$/.test(image.data))fail('图片必须是 4 MB 以内的 PNG');
  const data=Buffer.from(image.data,'base64');
  if(data.length>4*1024*1024||data.length<45||data.toString('base64')!==image.data||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||data.toString('ascii',12,16)!=='IHDR'||data.subarray(-12).toString('hex')!=='0000000049454e44ae426082')fail('图片数据无效');
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if(!width||!height||width>16384||height>16384||width*height>40000000)fail('图片尺寸过大');
  return {id:createHash('sha256').update(data).digest('hex'),data};
 });
}

export function createButlerDelivery({otty=createOtty(),sessionState=()=>null,enabled=true,home=os.homedir()}={}){
 async function focus(target){
  if(!enabled||!otty.available())return null;
  const pane=matchReplyPane(await otty.panes(),target);
  return pane?otty.focusPane(pane.id):null;
 }
 async function send(target,prompt,attachments=[]){
  if(!enabled||!otty.available())fail('直接发送暂支持 Otty 中的原会话；请打开原会话并使用已保留的草稿',409);
  if(sessionState(target)==='waiting')fail('原会话正在等待你回答，请先点头像处理后再发送',409);
  const pane=matchReplyPane(await otty.panes(),target);
  if(!pane)fail('没有唯一匹配的原 Agent 会话；请点头像打开会话，草稿已保留',409);
  if(/permission|waiting|approval/i.test(pane.agent_state||''))fail('原会话正在等待你回答，请先处理后再发送',409);
  if(attachments.length){
   const dir=path.join(home,'.bobo','butler','attachments');
   await fs.mkdir(dir,{recursive:true,mode:0o700});
   const files=[];
   for(const image of attachments){
    const file=path.join(dir,image.id+'.png');
    await fs.writeFile(file,image.data,{mode:0o600});files.push(file);
   }
   // 原会话是本机 CLI：图片持久化后随指令传本机路径，由 Agent 的看图工具读取。
   prompt+='\n\n附图（本机 PNG，请使用看图工具打开以下文件）：\n'+files.map((file,i)=>`[图片 ${i+1}] ${JSON.stringify(file)}`).join('\n');
  }
  await otty.submit(pane.id,prompt);
  return {ok:true};
 }
 async function enableInput(target){
  if(!enabled)fail('隔离环境不修改真实 Otty 配置',409);
  const pane=matchReplyPane(await otty.panes(),target);
  if(!pane)fail('没有唯一匹配的原 Agent 会话，草稿已保留',409);
  await otty.enableInput();
  await otty.checkInput(pane.id);
  return {ok:true};
 }
 return {send,focus,enableInput};
}
