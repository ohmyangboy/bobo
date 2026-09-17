// 同一份分段规则用于服务端翻译与浏览器排版，段落 ID 不由模型决定。
export function splitMarkdown(text){
 const lines=text.replace(/\r\n/g,'\n').split('\n'),blocks=[];
 let i=0;
 const push=(type,start,end,extra={})=>blocks.push({id:'p'+blocks.length,type,text:lines.slice(start,end).join('\n'),...extra});
 if(lines[0]==='---'){const end=lines.indexOf('---',1);if(end>=0){push('metadata',0,end+1);i=end+1;}}
 while(i<lines.length){
  if(!lines[i].trim()){i++;continue;}
  const start=i,fence=lines[i].match(/^\s*(`{3,}|~{3,})/);
  if(fence){i++;while(i<lines.length&&!new RegExp('^\\s*'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(lines[i]))i++;if(i<lines.length)i++;push('code',start,i);continue;}
  if(/^ {4}|^\t/.test(lines[i])){while(i<lines.length&&(/^( {4}|\t)/.test(lines[i])||!lines[i].trim()))i++;push('code',start,i);continue;}
  if(/^#{1,6}\s/.test(lines[i])){push('heading',i,++i);continue;}
  if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[i])){push('rule',i,++i);continue;}
  if(i+1<lines.length&&/^\s*(=+|-+)\s*$/.test(lines[i+1])){i+=2;push('heading',start,i);continue;}
  while(i<lines.length&&lines[i].trim()){
   if(i>start&&(/^#{1,6}\s|^\s*(`{3,}|~{3,})/.test(lines[i])))break;
   i++;
  }
  push(/^\s*>/.test(lines[start])?'quote':/^\s*(?:[-+*]|\d+[.)])\s/.test(lines[start])?'list':lines[start].includes('|')&&lines[start+1]?.match(/\|?\s*:?-{3,}/)?'table':'paragraph',start,i);
 }
 return blocks;
}

function inline(text){
 const fragment=document.createDocumentFragment();
 const pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
 let start=0;
 for(const m of text.matchAll(pattern)){
  fragment.append(document.createTextNode(text.slice(start,m.index)));
  let node;
  if(m[0].startsWith('`')){node=document.createElement('code');node.textContent=m[0].slice(1,-1);}
  else if(m[0].startsWith('**')){node=document.createElement('strong');node.textContent=m[0].slice(2,-2);}
  else if(m[0].startsWith('*')){node=document.createElement('em');node.textContent=m[0].slice(1,-1);}
  else{const link=m[0].match(/^\[([^\]]+)\]\((.+)\)$/);node=document.createElement(/^https?:\/\//i.test(link[2])?'a':'span');node.textContent=link[1];if(node.tagName==='A'){node.href=link[2];node.target='_blank';node.rel='noopener noreferrer';}else node.title=link[2];}
  fragment.append(node);start=m.index+m[0].length;
 }
 fragment.append(document.createTextNode(text.slice(start)));return fragment;
}
// frontmatter 解析为键值行：顶层 `key: value` 一行，缩进的列表 / 映射作为上一行的续行（保留缩进），供阅读视图渲染成表格。
export function frontmatterRows(text){
 const rows=[];let current=null;
 for(const raw of String(text||'').replace(/\r\n/g,'\n').split('\n')){
  const line=raw.trimEnd();
  if(!line.trim()||/^\s*---\s*$/.test(line)||/^\s*#/.test(line))continue;
  const top=/^([^\s:#][^:]*?)\s*:(.*)$/.exec(line);
  if(top&&!/^\s/.test(line)&&!/^[-*]\s/.test(line)){current={key:top[1].trim(),value:top[2].trim()};rows.push(current);continue;}
  if(current)current.value+=(current.value?'\n':'')+line;
  else rows.push({key:'',value:line.trim()});
 }
 return rows;
}
export function renderFrontmatter(text){
 const table=document.createElement('table'),body=document.createElement('tbody');
 for(const row of frontmatterRows(text)){
  const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');
  th.textContent=row.key||'—';
  if(row.value.includes('\n')){const pre=document.createElement('pre');pre.textContent=row.value;td.append(pre);}
  else td.textContent=row.value||'—';
  tr.append(th,td);body.append(tr);
 }
 table.append(body);return table;
}
export function renderBlock(block){
 const {type,text}=block;let node;
 if(type==='metadata'){node=document.createElement('div');node.className='frontmatter-table';node.append(renderFrontmatter(text));}
 else if(type==='code'){node=document.createElement('pre');const code=document.createElement('code');code.textContent=text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n/,'').replace(/\n\s*(`{3,}|~{3,})\s*$/,'');node.append(code);}
 else if(type==='heading'){const prefix=text.match(/^(#{1,6})\s/);node=document.createElement('h'+(prefix?prefix[1].length:text.split('\n')[1]?.startsWith('=')?1:2));node.append(inline(prefix?text.replace(/^#{1,6}\s+/,''):text.split('\n')[0]));}
 else if(type==='rule'){node=document.createElement('hr');}
 else if(type==='list'){node=document.createElement(/^\s*\d/.test(text)?'ol':'ul');let li;for(const line of text.split('\n')){if(/^\s*(?:[-+*]|\d+[.)])\s/.test(line)){li=document.createElement('li');li.append(inline(line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/,'')));node.append(li);}else if(li){li.append(document.createTextNode('\n'),inline(line));}}}
 else if(type==='table'){node=document.createElement('div');node.className='table-scroll';const table=document.createElement('table');text.split('\n').filter((_,i)=>i!==1).forEach((line,i)=>{const tr=document.createElement('tr');for(const cell of line.replace(/^\||\|$/g,'').split('|')){const td=document.createElement(i===0?'th':'td');td.append(inline(cell.trim()));tr.append(td);}table.append(tr);});node.append(table);}
 else{node=document.createElement(type==='quote'?'blockquote':'p');node.append(inline(type==='quote'?text.replace(/^\s*>\s?/gm,''):text));}
 return node;
}
export function renderMarkdown(container,text){container.replaceChildren(...splitMarkdown(text).map(renderBlock));}
