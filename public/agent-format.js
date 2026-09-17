// OpenCode 智能体定义（~/.config/opencode/agents/*.md）的解析与模板：服务端 agents.mjs 与浏览器 app.js 共用。
// 只解析界面需要的顶层标量字段；permissions 等嵌套结构留在原文编辑，避免过度解析。
export function agentIdOK(id){
 return typeof id==='string'&&id.length>0&&id.length<=200&&id.split('/').every(p=>/^[a-z0-9][a-z0-9-]{0,79}$/.test(p));
}
export function parseAgent(text){
 const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof text==='string'?text:''),data={};
 if(m)for(const line of m[1].split(/\r?\n/)){
  const kv=/^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);if(!kv)continue;
  let v=kv[2].trim();
  if(/^(['"]).*\1$/.test(v))v=v.slice(1,-1);
  else if(v==='true')v=true;else if(v==='false')v=false;
  if(v!=='')data[kv[1]]=v;
 }
 return {data,has:!!m,body:m?text.slice(m[0].length).replace(/^\r?\n/,''):String(text||'')};
}
const MODES=['primary','subagent','all'];
export function agentProblems(id,parsed){
 const {data,has}=parsed,out=[];
 if(!agentIdOK(id))out.push('文件名包含不支持的字符，建议用小写字母、数字和短横线');
 if(!has)out.push('缺少 frontmatter 声明块');
 if(!data.description)out.push('缺少 description，模型无法判断何时使用它');
 if(data.mode&&!MODES.includes(data.mode))out.push('mode 无效，应为 primary、subagent 或 all');
 if(data.color&&!/^#[0-9a-fA-F]{6}$/.test(data.color))out.push('color 不是六位十六进制颜色');
 return out;
}
// 在 frontmatter 里增删 disabled 标记；没有声明块时补一个，正文原样保留。
export function setAgentDisabled(text,disabled){
 const m=/^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(typeof text==='string'?text:'');
 if(!m)return disabled?'---\ndisabled: true\n---\n\n'+text:text;
 const lines=m[2].split(/\r?\n/).filter(l=>!/^disabled\s*:/.test(l));
 while(lines.length&&!lines[lines.length-1].trim())lines.pop();
 if(disabled)lines.push('disabled: true');
 return m[1]+lines.join('\n')+m[3]+text.slice(m[0].length);
}
const yamlText=v=>/[:#"'\n]/.test(v)?'"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"':v;
export function agentTemplate({id,description,mode,color}){
 const desc=String(description||'').replace(/\s+/g,' ').trim()||'描述这个智能体的用途和适用场景。';
 const m=MODES.includes(mode)?mode:'subagent',c=/^#[0-9a-fA-F]{6}$/.test(color||'')?color:'#9B59B6';
 return `---\ndescription: ${yamlText(desc)}\nmode: ${m}\ncolor: '${c}'\n---\n\n# ${id}\n\n在这里写这个智能体的系统提示词：它的角色、擅长的领域、工作方式和输出要求。\n`;
}
