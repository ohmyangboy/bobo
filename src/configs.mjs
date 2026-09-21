import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pruneBackups } from './backups.mjs';

// Agent 的全局配置白名单。dir 是配置根目录（函数，便于读环境变量），files 是只读写的固定文件，
// file 是相对根目录的路径（可含子目录）；agents 表示这个 Agent 的「子智能体定义」由哪种后端管理
// （opencode / codex / null，没有就是纯配置文件）。新增 Agent 只需在这里加一项。
// 只收录「通知岛」已接入的 harness（OpenCode / Codex / Claude Code / omp / dsh / agy），保持两边一致；
// 其它 Agent 等接入通知岛后再取消注释，不要提前开放。
// 安全约定：只认白名单里的路径，绝不扫描目录，避免把 auth.json / *.credentials.json 之类的凭据暴露出来。
// icon 必须是真实品牌图标（index.html 的内联 SVG 精灵），没有就不放图标，不做首字母占位。
export const GLOBAL_CONFIGS={
 opencode:{label:'OpenCode',icon:'provider-opencode',agents:'opencode',dir:({home})=>path.join(home,'.config','opencode'),files:[
  {file:'AGENTS.md',label:'全局规则',format:'markdown',description:'每次会话都会附加的全局个性化提示词（Markdown）'},
  {file:'opencode.json',label:'主配置',format:'json',description:'模型、权限、MCP、插件等全局配置（JSON）'},
  {file:'opencode.jsonc',label:'主配置（JSONC）',format:'jsonc',description:'带注释的全局配置，与 opencode.json 同时存在时会合并'},
  {file:'cli.json',label:'终端偏好',format:'json',description:'TUI 的主题、快捷键等终端设置（JSON）'},
 ]},
 codex:{label:'Codex',icon:'provider-codex',agents:'codex',dir:({home,env})=>env.CODEX_HOME||path.join(home,'.codex'),files:[
  {file:'AGENTS.md',label:'全局规则',format:'markdown',description:'每次会话都会读取的全局个性化指令（Markdown）'},
  {file:'config.toml',label:'主配置',format:'toml',description:'模型、审批、沙箱、MCP 等全局配置（TOML）'},
 ]},
 claude:{label:'Claude Code',icon:'provider-claude',dir:({home,env})=>env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),files:[
  {file:'CLAUDE.md',label:'全局指令',format:'markdown',description:'每次会话都会加载的用户级指令（Markdown）'},
  {file:'settings.json',label:'主配置',format:'json',description:'模型、权限、环境变量、hooks 等用户级设置（JSON）'},
  {file:'keybindings.json',label:'快捷键',format:'json',description:'键盘快捷键覆盖（JSON）'},
 ]},
 omp:{label:'omp',icon:'provider-omp',dir:({home,env})=>env.PI_CODING_AGENT_DIR||path.join(home,'.omp','agent'),files:[
  {file:'config.yml',label:'主配置',format:'yaml',description:'模型角色、审批、扩展等全局设置（YAML）'},
  {file:'config.yaml',label:'主配置（config.yaml）',format:'yaml',description:'omp 也接受的备用文件名（与 config.yml 二选一）'},
  {file:'PERSONALITY.md',label:'个性',format:'markdown',description:'替换系统提示词里的个性段落（Markdown）'},
 ]},
 dsh:{label:'DeepSeek',icon:'provider-dsh',dir:({home,env})=>env.DSH_HOME||path.join(home,'.dsh'),files:[
  {file:'settings.yaml',label:'主配置',format:'yaml',description:'模型、预设、界面与语言等全局设置（YAML）'},
 ]},
 agy:{label:'Antigravity',icon:'provider-agy',dir:({home,env})=>env.ANTIGRAVITY_CONFIG_DIR||path.join(home,'.gemini'),files:[
  {file:'GEMINI.md',label:'全局指令',format:'markdown',description:'每次会话都会加载的全局个性化提示词（Markdown）'},
  {file:'settings.json',label:'主配置',format:'json',description:'模型、安全、MCP、Hooks 等用户级设置（JSON）'},
  {file:'antigravity-cli/settings.json',label:'CLI 偏好',format:'json',description:'命令行环境权限、工作区信任等设置（JSON）'},
  {file:'config/config.json',label:'全局配置',format:'json',description:'Antigravity 平台级配置（JSON）'},
  {file:'config/hooks.json',label:'Hooks',format:'json',description:'生命周期 Hooks 脚本与触发配置（JSON）'},
  {file:'config/mcp_config.json',label:'MCP 配置',format:'json',description:'全局 MCP 服务器与工具配置（JSON）'},
 ]},
};
// 以下 Agent 还未接入「通知岛」，先不开放（同样的白名单结构，接入后取消注释即可）：
// gemini:{label:'Gemini CLI',icon:null,dir:({home,env})=>env.GEMINI_CONFIG_DIR||path.join(home,'.gemini'),files:[
//  {file:'GEMINI.md',label:'全局指令',format:'markdown',description:'每次会话都会加载的全局上下文（Markdown）'},
//  {file:'settings.json',label:'主配置',format:'json',description:'模型、主题、MCP、工具等用户级设置（JSON）'},
// ]},
// qwen:{label:'Qwen Code',icon:null,dir:({home})=>path.join(home,'.qwen'),files:[
//  {file:'QWEN.md',label:'全局指令',format:'markdown',description:'每次会话都会加载的全局上下文（Markdown）'},
//  {file:'settings.json',label:'主配置',format:'json',description:'模型、主题、MCP 等用户级设置（JSON）'},
// ]},
// droid:{label:'Droid',icon:null,dir:({home})=>path.join(home,'.factory'),files:[
//  {file:'settings.json',label:'主配置',format:'json',description:'Factory Droid 的用户级设置（JSON）'},
// ]},
// copilot:{label:'GitHub Copilot CLI',icon:null,dir:({home})=>path.join(home,'.copilot'),files:[
//  {file:'config.json',label:'主配置',format:'json',description:'Copilot CLI 的用户级设置（JSON）'},
// ]},
// trae:{label:'Trae',icon:null,dir:({home})=>path.join(home,'.trae'),files:[
//  {file:'traecli.yaml',label:'CLI 配置',format:'yaml',description:'Trae CLI 的用户级设置（YAML）'},
//  {file:'user_rules.md',label:'全局规则',format:'markdown',description:'每次会话都会读取的全局规则（Markdown）'},
//  {file:'hooks.json',label:'Hooks',format:'json',description:'Hooks 配置（JSON）'},
// ]},
// qoder:{label:'Qoder',icon:null,dir:({home})=>path.join(home,'.qoder'),files:[
//  {file:'settings.json',label:'主配置',format:'json',description:'Qoder 的用户级设置（JSON）'},
// ]},
// windsurf:{label:'Windsurf',icon:null,dir:({home})=>path.join(home,'.codeium','windsurf'),files:[
//  {file:'memories/global_rules.md',label:'全局规则',format:'markdown',description:'每次会话都会读取的全局规则（Markdown）'},
//  {file:'mcp_config.json',label:'MCP 配置',format:'json',description:'MCP 服务器配置（JSON）'},
// ]},
// cursor:{label:'Cursor',icon:null,dir:({home})=>path.join(home,'.cursor'),files:[
//  {file:'mcp.json',label:'MCP 配置',format:'json',description:'全局 MCP 服务器配置（JSON）'},
// ]},
// continue:{label:'Continue',icon:null,dir:({home})=>path.join(home,'.continue'),files:[
//  {file:'config.yaml',label:'主配置',format:'yaml',description:'模型、上下文与助手配置（YAML）'},
//  {file:'config.json',label:'主配置（旧版）',format:'json',description:'旧版 JSON 配置'},
// ]},
// goose:{label:'Goose',icon:null,dir:({home,env})=>path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'goose'),files:[
//  {file:'config.yaml',label:'主配置',format:'yaml',description:'模型、扩展与密钥配置（YAML）'},
// ]},
// crush:{label:'Crush',icon:null,dir:({home,env})=>path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'crush'),files:[
//  {file:'crush.json',label:'主配置',format:'json',description:'模型、MCP 与权限配置（JSON）'},
// ]},
// amp:{label:'Amp',icon:null,dir:({home,env})=>path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'amp'),files:[
//  {file:'settings.json',label:'主配置',format:'json',description:'Amp 的用户级设置（JSON）'},
// ]},
// zed:{label:'Zed',icon:null,dir:({home,env})=>path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'zed'),files:[
//  {file:'settings.json',label:'主配置',format:'json',description:'编辑器的用户级设置（JSON）'},
// ]},

export function createConfigs({home,env={},fail}){
 const backups=path.join(home,'.bobo','backups');
 const ctx={home,env};
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const label=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-config-';
 function specOf(provider){const spec=GLOBAL_CONFIGS[provider];if(!spec)fail('未知的 Agent 来源');return spec;}
 function dirOf(provider){return specOf(provider).dir(ctx);}
 // provider + file（相对路径）映射到固定目录下的固定文件；两者都必须在白名单里，且路径不能越界。
 function target(provider,key){
  const spec=specOf(provider);
  const file=spec.files.find(f=>f.file===key);if(!file)fail('未知的配置文件');
  const rel=file.file;
  if(path.isAbsolute(rel)||rel.split('/').some(s=>!s||s==='..'||s.startsWith('.')))fail('无效的配置文件路径');
  const dir=spec.dir(ctx);
  return {spec,file,dir,abs:path.join(dir,rel)};
 }
 // 备份单个全局配置文件，与技能 / 智能体备份共用「最近 3 份」的配额。
 async function backupFile(abs){
  const dest=path.join(backups,label()+'edit');
  await fs.mkdir(dest,{recursive:true});
  const name=path.basename(abs);await fs.copyFile(abs,path.join(dest,name));
  await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify([{original:abs,backup:name}],null,2));
  await pruneBackups(backups);
  return dest;
 }
 async function stat(abs){
  const st=await fs.lstat(abs).catch(()=>null);if(!st)return null;
  return {link:st.isSymbolicLink(),size:st.size,mtime:st.mtime.toISOString()};
 }
 // 来源清单：给左栏菜单用。installed = 配置根目录存在，且至少有一份认得出来的配置文件——
 // 只被建过目录（例如 bobo 链接技能时建的 skills 子目录）不算已安装，状态点保持灰色。
 async function providers(){
  const out=[];
  for(const [id,spec] of Object.entries(GLOBAL_CONFIGS)){
   const dir=spec.dir(ctx);
   let installed=false;
   if(await fs.lstat(dir).catch(()=>null))for(const f of spec.files){if(await fs.lstat(path.join(dir,f.file)).catch(()=>null)){installed=true;break;}}
   out.push({id,label:spec.label,icon:spec.icon||null,agents:spec.agents||null,dir,installed});
  }
  return {providers:out};
 }
 async function list(provider){
  const spec=specOf(provider),dir=spec.dir(ctx);
  const dirExists=!!(await fs.lstat(dir).catch(()=>null));
  const files=[];
  for(const f of spec.files){const abs=path.join(dir,f.file),st=await stat(abs);files.push({...f,key:f.file,name:path.basename(f.file),path:abs,exists:!!st,link:st?.link||false,size:st?.size||0,mtime:st?.mtime||null});}
  return {provider,label:spec.label,dir,dirExists,files};
 }
 async function read(provider,key){
  const {file,abs}=target(provider,key);
  const st=await fs.lstat(abs).catch(()=>null);
  const base={provider,key:file.file,file:file.file,name:path.basename(file.file),label:file.label,format:file.format,description:file.description,path:abs};
  if(!st)return {...base,exists:false,link:false,size:0,mtime:null,content:'',version:null};
  if(st.isSymbolicLink())return {...base,exists:true,link:true,size:st.size,mtime:st.mtime.toISOString(),content:'',version:null};
  if(!st.isFile())fail('不是普通文件');
  if(st.size>1000000)fail('文件超过 1 MB，请在 Finder 中打开');
  const b=await fs.readFile(abs);
  return {...base,exists:true,link:false,size:st.size,mtime:st.mtime.toISOString(),content:b.toString('utf8'),version:hash(b)};
 }
 async function save({provider,key,content,version}={}){
  if(typeof content!=='string'||content.length>1000000)fail('文件内容无效');
  const {abs}=target(provider,key);
  const st=await fs.lstat(abs).catch(()=>null);
  let backup=null;
  if(st){
   if(st.isSymbolicLink())fail('不能编辑符号链接');
   const current=hash(await fs.readFile(abs));
   if(version!==current)fail('文件已被其他程序修改，请重新打开',409);
   backup=await backupFile(abs);
  }else if(version)fail('文件不存在或已被删除，请刷新',409);
  await fs.mkdir(path.dirname(abs),{recursive:true});
  await fs.writeFile(abs,content);
  return {ok:true,provider,key,file:path.basename(abs),path:abs,backup,version:hash(Buffer.from(content)),created:!st};
 }
 // 给 AI 阅读管线用的解析：id 形如 "opencode:AGENTS.md"，只返回路径，实际读取交给 reader。
 function entity(id){
  const value=String(id||''),i=value.indexOf(':');
  if(i<0)fail('无效的配置 ID');
  return {path:target(value.slice(0,i),value.slice(i+1)).abs};
 }
 return {providers,list,read,save,entity,dir:dirOf};
}
