// Grok Build 用户智能体（~/.grok/agents/*.md）的解析与模板。服务端与测试共用。
// 只取界面要的顶层字段；多行 description（> / |）折成一段，其余嵌套留给原文编辑。
import { agentIdOK, parseAgent } from './agent-format.js';
export { agentIdOK };
function unquote(v){return /^(['"]).*\1$/.test(v)?v.slice(1,-1):v;}
function foldedDescription(block){
 const lines=block.split(/\r?\n/),i=lines.findIndex(l=>/^description\s*:/.test(l));
 if(i<0)return '';
 const rest=lines[i].replace(/^description\s*:\s*/,'').trim();
 if(rest&&!['>','|','>-','|-'].includes(rest))return unquote(rest);
 const parts=[];
 for(let j=i+1;j<lines.length;j++){
  if(/^\s+\S/.test(lines[j]))parts.push(lines[j].trim());
  else if(!lines[j].trim()){if(parts.length)parts.push('');}
  else break;
 }
 const text=rest.startsWith('|')?parts.join('\n'):parts.join(' ');
 return text.replace(/[ \t]+/g,' ').trim();
}
export function parseGrokAgent(text){
 const parsed=parseAgent(text);
 const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof text==='string'?text:'');
 if(m){
  const desc=foldedDescription(m[1]);
  if(desc)parsed.data.description=desc;
 }
 return parsed;
}
export function grokProblems(id,parsed){
 const {data,has}=parsed,out=[],base=String(id||'').split('/').pop();
 if(!agentIdOK(id))out.push('文件名包含不支持的字符，建议用小写字母、数字和短横线');
 if(!has)out.push('缺少 frontmatter 声明块');
 if(!data.name)out.push('缺少 name，Grok 按这个名字识别智能体');
 else if(data.name!==base)out.push('name 与文件名不一致，Grok 以 name 为准');
 if(!data.description)out.push('缺少 description，模型无法判断何时使用它');
 return out;
}
const yamlText=v=>/[:#"'\n]/.test(v)?'"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"':v;
export function grokTemplate({id,description}){
 const base=String(id||'').split('/').pop();
 const desc=String(description||'').replace(/\s+/g,' ').trim()||'描述这个智能体的用途和适用场景。';
 return `---\nname: ${base}\ndescription: ${yamlText(desc)}\n---\n\n# ${base}\n\n在这里写这个智能体的系统提示词：它的角色、擅长的领域、工作方式和输出要求。\n`;
}
