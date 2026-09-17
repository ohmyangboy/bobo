// Codex CLI 自定义智能体（~/.codex/agents/*.toml）的解析与模板：服务端 codex-agents.mjs 与浏览器 app.js 共用。
// Codex 用 TOML 定义，name / description / developer_instructions 为必填，其余（model、model_reasoning_effort、
// sandbox_mode、nickname_candidates 等）可选。这里只解析界面需要的顶层字段，嵌套表原样留在原文编辑。
export function codexIdOK(id){
 return typeof id==='string'&&id.length>0&&id.length<=200&&id.split('/').every(p=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(p));
}
// 解析一段基本字符串（"..."）或字面字符串（'...'）的转义；只处理 TOML 里常见的反斜杠序列。
function unescape(v){
 return v.replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
  .replace(/\\[btnfr"\\]/g,c=>c==='\\n'?'\n':c==='\\t'?'\t':c==='\\r'?'\r':c==='\\b'?'\b':c==='\\f'?'\f':c.slice(1));
}
// 取一行的值部分并剥离注释（注释必须在字符串之外）。
function stripComment(text){
 let out='',quote=null;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quote){out+=c;if(c==='\\'&&quote==='"')out+=text[++i]??'';else if(c===quote)quote=null;}
  else if(c==='"'||c==="'"){quote=c;out+=c;}
  else if(c==='#')break;
  else out+=c;
 }
 return out.trim();
}
// 解析顶层标量字段；多行字符串（""" / '''）与嵌套表都不打断。返回 {data,has,extra}，
// extra 保存没识别成字段的原文（保留），data 里带上常用字段。
export function parseCodexAgent(text){
 const src=typeof text==='string'?text:'',data={};
 let name='',description='',instructions='';
 let has=false,inTable=false;
 const extra=[];
 const lines=src.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  let line=lines[i];
  if(!inTable){
   const key=/^\s*([A-Za-z_][\w.-]*)\s*=\s*([\s\S]*)$/.exec(line);
   if(key){
    has=true;
    const k=key[1];let rest=key[2].trim();
    let value;
    if(rest.startsWith('"""')||rest.startsWith("'''")){
     const q=rest.slice(0,3);rest=rest.slice(3);
     const parts=[];let closed=false;
     const closeIdx=rest.indexOf(q);
     if(closeIdx>=0){parts.push(rest.slice(0,closeIdx));closed=true;}
     else{parts.push(rest);while(++i<lines.length){const idx=lines[i].indexOf(q);if(idx>=0){parts.push(lines[i].slice(0,idx));closed=true;break;}parts.push(lines[i]);}}
     let body=parts.join('\n');
     if(body.startsWith('\n'))body=body.slice(1);
     value=q==='"""'?unescape(body):body;
    }else{
     rest=stripComment(rest);
     if((rest.startsWith('"')&&rest.endsWith('"'))||(rest.startsWith("'")&&rest.endsWith("'")))value=rest[0]==='"'?unescape(rest.slice(1,-1)):rest.slice(1,-1);
     else if(rest==='true')value=true;
     else if(rest==='false')value=false;
     else if(rest.startsWith('[')&&rest.endsWith(']'))value=rest.slice(1,-1).split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(Boolean);
     else value=rest;
    }
    if(k==='name')name=value;else if(k==='description')description=value;else if(k==='developer_instructions')instructions=value;
    else data[k]=value;
    continue;
   }
   const table=/^\s*\[([^\]]+)\]\s*$/.exec(line);
   if(table){inTable=true;continue;}
   if(line.trim())extra.push(line);
  }else if(/^\s*\[/.test(line))continue;
 }
 data.name=name;data.description=description;data.developer_instructions=instructions;
 return {data,has,instructions};
}
const EFFORTS=['minimal','low','medium','high'];
const SANDBOXES=['read-only','workspace-write','danger-full-access'];
// 列表标出：必填缺失、文件名与 name 不一致、枚举值无效、ID 不合法。
export function codexProblems(id,parsed){
 const {data,has}=parsed,out=[];
 if(!codexIdOK(id))out.push('文件名包含不支持的字符，建议用小写字母、数字、短横线和下划线');
 if(!has)out.push('不是有效的 TOML 智能体定义，应包含 name、description、developer_instructions');
 if(!data.name)out.push('缺少 name，Codex 用它识别并唤起这个智能体');
 else if(String(data.name).toLowerCase().replace(/[^a-z0-9]+/g,'')!==id.toLowerCase().replace(/[^a-z0-9]+/g,''))out.push('文件名与 name 不一致（Codex 以 name 为准，建议两者相同）');
 if(!data.description)out.push('缺少 description，Codex 无法判断何时使用它');
 if(!data.developer_instructions)out.push('缺少 developer_instructions，智能体没有行为说明');
 if(data.model_reasoning_effort&&!EFFORTS.includes(data.model_reasoning_effort))out.push('model_reasoning_effort 无效，应为 minimal、low、medium 或 high');
 if(data.sandbox_mode&&!SANDBOXES.includes(data.sandbox_mode))out.push('sandbox_mode 无效，应为 read-only、workspace-write 或 danger-full-access');
 return out;
}
// 生成一份最小可用的自定义智能体定义（三个必填字段）。
export function codexTemplate({id,description}={}){
 const name=String(id||'agent').replace(/\s+/g,'_');
 const desc=String(description||'').replace(/\s+/g,' ').replace(/"/g,'\\"').trim()||'描述这个智能体擅长什么、什么时候该使用它。';
 return `name = "${name}"\ndescription = "${desc}"\n\n# 可选：覆盖模型、思考强度、沙箱与昵称（省略时继承主会话）\n# model = "gpt-5.4"\n# model_reasoning_effort = "medium"\n# sandbox_mode = "read-only"\n\n\ndeveloper_instructions = """\n你是 ${name}。在这里写它的角色、擅长的领域、工作方式、优先级与输出要求。\n只做被指派的任务，完成后简明汇报结果。\n"""\n`;
}
