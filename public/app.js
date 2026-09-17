import {responseLines} from './stream.js';
import {splitMarkdown,renderBlock,renderMarkdown} from './markdown.js';
if(new URLSearchParams(location.search).has('app'))document.body.classList.add('app');
const $=s=>document.querySelector(s), token=$('meta[name=token]').content;
// 外观：默认跟随系统（prefers-color-scheme 随系统即时切换），也可固定浅色 / 深色；手动选择保存在本机，不改动系统设置。
const themeKey='bobo-theme',legacyThemeKey='skills-theme',themes=['system','light','dark'];
let theme='system';try{const stored=localStorage.getItem(themeKey)??localStorage.getItem(legacyThemeKey);if(themes.includes(stored))theme=stored;}catch{}
function applyTheme(){document.documentElement.dataset.theme=theme==='system'?'':theme;for(const b of document.querySelectorAll('[data-theme-value]'))b.setAttribute('aria-pressed',String(b.dataset.themeValue===theme));}
for(const b of document.querySelectorAll('[data-theme-value]'))b.onclick=()=>{theme=b.dataset.themeValue;try{localStorage.setItem(themeKey,theme);}catch{}applyTheme();};
applyTheme();
// 当前一级视图：技能 / 智能体 / 通知岛。顶栏全局操作按它收敛（见 style.css）。
document.body.dataset.view='skills';
let skills=[],selected=null,current=null,original='',version=null,loading=false,selectionRun=0,folder=null,mineRoots=[];
async function api(url,data){const r=await fetch('/api/'+url,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const b=await r.json();if(!r.ok)throw Error(b.error);return b;}
let toastTimer;function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5000);}
function dirty(){return current&&$('#editor').value!==original;}
function leave(){return !dirty()||confirm('当前文件尚未保存，放弃修改？');}
function guard(fn){return async(...args)=>{try{await fn(...args);}catch(e){toast(e.message);}};}
function button(text,cls,fn){const b=document.createElement('button');b.textContent=text;b.className=cls;b.onclick=guard(fn);return b;}
// 启停开关：macOS 观感的开关控件；请求失败时回滚到原状态并提示。
function toggleSwitch(on,label,fn){const wrap=document.createElement('label');wrap.className='switch';wrap.title=label;const input=document.createElement('input');input.type='checkbox';input.checked=on;input.setAttribute('role','switch');input.setAttribute('aria-label',label);const track=document.createElement('span');track.className='switch-track';wrap.append(input,track);input.onchange=async()=>{input.disabled=true;try{await fn(input.checked);}catch(e){input.checked=!input.checked;toast(e.message);}finally{input.disabled=false;}};return wrap;}
const groupState = new Map();
const groupNames = {mattpocock:'Matt Pocock',emilkowalski:'Emil Kowalski',anthropics:'Anthropic',chromedevtools:'Chrome DevTools','vercel-labs':'Vercel','skills.volces.com':'火山引擎',local:'本地技能'};
function groupLabel(key) { return groupNames[key] || key; }
function skillGroup(skill) {
 if(skill?.mine)return {key:'mine:'+skill.mine.root,label:'我的 · '+(skill.mine.name||skill.mine.root.split('/').pop()),mine:skill.mine};
 const owner = skill.source?.split('/')[0] || 'local';
 return {key:owner,label:groupLabel(owner)};
}
function sourceAddress(s){
 const fallback=(!s?.sourceType||s.sourceType==='github')&&/^[\w.-]+\/[\w.-]+$/.test(s?.source||'')?'https://github.com/'+s.source:'';
 try{const u=new URL(s?.sourceUrl||fallback);if(!['http:','https:'].includes(u.protocol))return '';if(u.pathname.endsWith('.git'))u.pathname=u.pathname.slice(0,-4);return u.href;}catch{return '';}
}
function addressOf(s){return s?.mine?.repo?'https://github.com/'+s.mine.repo:sourceAddress(s);}
// 「我的技能」的启用状态：linked 已链接 / disabled 已停用 / missing 未链接 / conflict 名称冲突。
function linkLabel(s){
 if(!s?.mine)return null;
 if(s.mine.mineStatus==='conflict')return '未启用：~/.agents/skills 已有同名技能';
 if(s.mine.mineStatus==='disabled')return '已停用：不会出现在 Agent 的技能列表里';
 if(s.mine.mineStatus==='missing')return '未启用：尚未链接到 ~/.agents/skills';
 return '已链接到 ~/.agents/skills';
}
function render() {
 const q=$('#search').value.toLowerCase();
 const rows=skills.filter(s=>[s.name,s.description,s.source,skillGroup(s).label].join(' ').toLowerCase().includes(q));
 $('#count').textContent=`${rows.length} / ${skills.length}`;
 $('#skills').replaceChildren();
 const groups=new Map();
 for(const s of rows){const g=skillGroup(s);if(!groups.has(g.key))groups.set(g.key,{...g,skills:[]});groups.get(g.key).skills.push(s);}
 const priority={mattpocock:0,emilkowalski:1,local:99};
 const rank=g=>g.mine?-1:(priority[g.key]??10);
 // 已链接的目录即使暂时没有技能，也保留在侧边栏，点进去可以新建或重新同步。
 if(!q)for(const r of mineRoots){const key='mine:'+r.path;if(!groups.has(key))groups.set(key,{key,mine:{root:r.path,name:r.name||r.path.split('/').pop(),repo:r.repo||null},label:'我的 · '+(r.name||r.path.split('/').pop()),skills:[]});}
 for(const g of [...groups.values()].sort((a,b)=>rank(a)-rank(b)||a.label.localeCompare(b.label))){
  const section=document.createElement('details');section.className='skill-group'+(folder===g.key?' folder-active':'');section.dataset.group=g.key;if(g.mine)section.dataset.mine='1';
  section.open=q.length>0||(groupState.get(g.key)??g.key===folder);
  const summary=document.createElement('summary');
  // 点击分组行的任意位置（三角、名称、空白）都同时做两件事：选中该分组并切换展开/收起。
  const activate=()=>openFolder(g.key,!section.open);
  const toggle=document.createElement('button');toggle.type='button';toggle.className='group-toggle';toggle.textContent='▸';toggle.title='选中该分组并展开或收起';toggle.setAttribute('aria-label','展开或收起分组');toggle.setAttribute('aria-expanded',String(section.open));
  toggle.onclick=e=>{e.preventDefault();e.stopPropagation();activate();};
  section.ontoggle=()=>{toggle.setAttribute('aria-expanded',String(section.open));if(!q)groupState.set(g.key,section.open);};
  const label=document.createElement('button');label.className='group-label';label.textContent=g.label;
  label.onclick=e=>{e.preventDefault();e.stopPropagation();activate();};
  summary.onclick=e=>{e.preventDefault();activate();};
  const count=document.createElement('span');count.className='group-count';count.textContent=g.skills.length;
  summary.append(toggle,label,count);section.append(summary);
  const items=document.createElement('div');items.className='group-items';
  for(const s of g.skills.sort((a,b)=>a.name.localeCompare(b.name))){
   const b=button('',`skill-item ${selected?.id===s.id?'selected':''}`,()=>choose(s));
   b.title=s.description||s.name;const strong=document.createElement('strong');strong.textContent=s.name;b.append(strong);
   if(s.mine&&s.mine.mineStatus&&s.mine.mineStatus!=='linked'){const tag=document.createElement('span');tag.className='badge'+(s.mine.mineStatus==='conflict'?' conflict':'');tag.textContent=s.mine.mineStatus==='conflict'?'冲突':s.mine.mineStatus==='disabled'?'已停用':'未启用';b.append(tag);}
   items.append(b);
  }
  section.append(items);$('#skills').append(section);
 }
 if(!rows.length){const p=document.createElement('p');p.textContent='没有匹配的技能';p.className='muted';$('#skills').append(p);}
}
function folderRows(){return skills.filter(s=>skillGroup(s).key===folder);}
function mineRootFor(key){
 const root=typeof key==='string'&&key.startsWith('mine:')?key.slice(5):null;
 if(!root)return null;
 const r=mineRoots.find(x=>x.path===root);
 return {root,name:r?.name||root.split('/').pop(),repo:r?.repo||null};
}
// 目录信息优先取技能自带的 mine 字段，空目录也能靠 mineRoots 拿到名称。
function folderInfo(){
 const rows=folderRows();
 if(rows.length)return skillGroup(rows[0]);
 const mine=mineRootFor(folder);
 return mine?{key:folder,label:'我的 · '+mine.name,mine}:{key:folder,label:folder};
}
function folderMine(){return folderInfo().mine||null;}
function showFolderView(){$('#empty').hidden=true;$('#detail').hidden=true;$('#folder').hidden=false;}
function showDetailView(){$('#empty').hidden=true;$('#folder').hidden=true;$('#detail').hidden=false;}
function markFolder(key){for(const el of document.querySelectorAll('#skills .skill-group'))el.classList.toggle('folder-active',el.dataset.group===key);}
// 选中某个分组并显示它的文件夹视图；open 决定选中后该分组是展开还是收起（点已展开的分组就收起来）。
function openFolder(key,open=true){
 if(!leave())return;
 folder=key;selected=null;current=null;selectionRun++;
 groupState.set(key,open);showFolderView();render();renderFolder();
}
function updateFolderActions(){
 const mine=folderMine();
 $('#folderUpdate').hidden=!!mine;$('#folderRelink').hidden=!mine;$('#folderSync').hidden=!mine;$('#folderNew').hidden=!mine;$('#folderManage').hidden=!mine;
 $('#folderSync').textContent=mine?.repo?'推送更新':'同步到 GitHub';
}
function renderFolder(){
 const rows=folderRows().sort((a,b)=>a.name.localeCompare(b.name));
 const mine=folderMine();
 $('#folderName').textContent=folderInfo().label;
 $('#folderMeta').textContent=rows.length+' 个技能'+(mine?' · '+mine.root:'');
 $('#folderRemove').disabled=!rows.length;
 $('#folderUpdate').disabled=!rows.some(s=>s.source);
 updateFolderActions();
 $('#folderSkills').replaceChildren();
 for(const s of rows){
  const cell=document.createElement('div');cell.className='folder-skill-cell';
  const card=button('','folder-skill'+(selected?.id===s.id?' selected':''),()=>choose(s));
  card.title=s.description||s.name;const strong=document.createElement('strong');strong.textContent=s.name;
  const small=document.createElement('small');small.textContent=s.description||s.source||'本地技能';
  card.append(strong,small);cell.append(card);
  // 「我的技能」按需启停：停用只删除 ~/.agents/skills 里的链接，源文件保留。
  if(mine&&s.mine){
   const on=s.mine.mineStatus==='linked';
   card.classList.add('has-switch');
   cell.append(toggleSwitch(on,(on?'停用 ':'启用 ')+s.name,async enabled=>{
    await api('sources/toggle',{path:s.mine.root,name:s.name,enabled});
    await refresh(true);
    toast(s.name+(enabled?' 已启用':' 已停用'));
   }));
  }
  $('#folderSkills').append(cell);
 }
 const unlinked=mine?rows.filter(s=>s.mine?.mineStatus&&s.mine.mineStatus!=='linked'&&s.mine.mineStatus!=='disabled'):[];
 if(unlinked.length){
  const p=document.createElement('p');p.className='folder-warning';
  p.textContent='未启用 '+unlinked.length+' 个：'+unlinked.map(s=>s.name+(s.mine.mineStatus==='conflict'?'（与 ~/.agents/skills 里的同名技能冲突）':'')).join('、')+'。点「重新链接」重试；冲突需要先重命名或删除同名技能。';
  $('#folderSkills').append(p);
 }
 const paused=mine?rows.filter(s=>s.mine?.mineStatus==='disabled'):[];
 if(paused.length){
  const p=document.createElement('p');p.className='folder-note';
  p.textContent='已停用 '+paused.length+' 个：'+paused.map(s=>s.name).join('、')+'。打开卡片右上角的开关恢复链接，源文件不受影响。';
  $('#folderSkills').append(p);
 }
 if(!rows.length){const p=document.createElement('p');p.textContent='此文件夹下没有技能';p.className='muted';$('#folderSkills').append(p);}
}
async function refresh(force=false,initial=false){try{const snapshot=initial?await api('startup'):null;skills=snapshot?snapshot.skills:await api('skills'+(force?'?refresh=1':''));try{mineRoots=await api('sources/roots');}catch{}$('#syncMine').hidden=!mineRoots.length;if(snapshot?.cached)setTimeout(()=>guard(()=>refresh(true))(),0);render();if(selected&&!skills.some(s=>s.id===selected.id)){selected=null;current=null;if(!(folder&&!$('#folder').hidden)){$('#detail').hidden=true;$('#empty').hidden=false;}}else if(selected){selected=skills.find(s=>s.id===selected.id);}if(folder&&!$('#folder').hidden)renderFolder();}catch(e){$('#count').textContent='加载失败';throw e;}}
async function choose(s){if(!leave())return;const run=++selectionRun;selected=s;folder=skillGroup(s).key;showDetailView();markFolder(folder);$('#backToFolder').hidden=false;$('#backToFolder').textContent='← 返回 '+folderInfo().label;$('#reader').scrollTop=0;groupState.set(folder,true);current=null;$('#name').textContent=s.name;$('#origin').textContent=s.mine?('我的技能 · '+(s.mine.repo||'未同步 GitHub')):(s.source||'本地技能');$('#description').textContent=s.description||'此技能暂未提供描述。';$('#location').textContent=s.mine?s.mine.root+'（'+linkLabel(s)+'）':s.path;$('#agents').textContent=s.mine?linkLabel(s):'Agent：'+s.agents.join('、');$('#updateOne').disabled=!s.source||!!s.mine;const address=addressOf(s);$('#sourceLink').hidden=!address;$('#sourceLink').textContent=address.includes('github.com')?'GitHub':'来源';readerData=null;readerSkill=s.id;readerFile=null;bilingual=false;summaryExpanded=false;$('#summaryStatus').hidden=true;setView('read');render();try{const files=await api('tree?id='+s.id);if(run!==selectionRun)return;renderTree(files,true);}catch(e){if(run!==selectionRun)return;renderTree([],true,e.message);}await openFile('SKILL.md',true);}
// 文件树：把平铺路径还原成目录层级，文件夹行可点击展开/折叠。默认全部收起，只自动展开当前文件所在的目录。
const openDirs=new Set();
function buildTree(files){
 const root={dirs:new Map(),files:[]};
 for(const f of files){
  const parts=f.path.split('/');let node=root;
  for(const name of parts.slice(0,-1)){
   if(!node.dirs.has(name))node.dirs.set(name,{dirs:new Map(),files:[]});
   node=node.dirs.get(name);
  }
  node.files.push({name:parts.at(-1),path:f.path});
 }
 return root;
}
function treeRow(name,path,isDir,depth){
 const row=document.createElement('button');row.type='button';row.className='file'+(isDir?' dir':'');row.dataset.path=path;row.title=path;row.style.setProperty('--depth',depth);
 if(isDir){const caret=document.createElement('span');caret.className='caret';const label=document.createElement('span');label.className='label';label.textContent=name;row.append(caret,label);}
 else{row.textContent=name;row.classList.toggle('selected',current===path);}
 return row;
}
function drawTree(parent,node,depth,prefix){
 for(const [name,child] of [...node.dirs].sort((a,b)=>a[0].localeCompare(b[0]))){
  const path=prefix?prefix+'/'+name:name,row=treeRow(name,path,true,depth),kids=document.createElement('div');kids.className='tree-kids';
  const open=openDirs.has(path);kids.hidden=!open;row.setAttribute('aria-expanded',String(open));
  row.onclick=()=>{const next=!openDirs.has(path);if(next)openDirs.add(path);else openDirs.delete(path);kids.hidden=!next;row.setAttribute('aria-expanded',String(next));};
  drawTree(kids,child,depth+1,path);parent.append(row,kids);
 }
 const rank=f=>f.name==='SKILL.md'?0:1;
 for(const f of [...node.files].sort((a,b)=>rank(a)-rank(b)||a.name.localeCompare(b.name))){
  const row=treeRow(f.name,f.path,false,depth);row.onclick=guard(()=>openFile(f.path));parent.append(row);
 }
}
function renderTree(files,reset=false,error){
 if(reset)openDirs.clear();
 if(current)expandDirs(current);
 const tree=$('#tree');tree.replaceChildren();
 if(error){const p=document.createElement('p');p.className='muted';p.textContent=error;tree.append(p);return;}
 drawTree(tree,buildTree(files),0,'');
}
// 展开某个文件的全部上级目录，保证它一定可见（当前文件、刚新建的文件）。
function expandDirs(file){const parts=file.split('/');for(let i=1;i<parts.length;i++)openDirs.add(parts.slice(0,i).join('/'));}
async function openFile(file,skip=false){if(!skip&&!leave())return;const id=selected.id,run=++selectionRun;$('#editor').value='';$('#editor').disabled=true;$('#save').disabled=true;current=null;try{const f=await api('file?id='+id+'&path='+encodeURIComponent(file));if(run!==selectionRun)return;current=file;original=f.content;version=f.version;$('#filename').textContent=file;$('#editor').value=f.content;$('#editor').disabled=false;$('#dirty').textContent='';$('#fileInfo').textContent=f.content.split('\n').length+' 行';$('#deleteFile').disabled=file==='SKILL.md';for(const b of $('#tree').querySelectorAll('.file:not(.dir)'))b.classList.toggle('selected',b.dataset.path===file);await loadReader(id,file,readerSkill!==id||readerFile!==file||!readerData);}catch(e){if(run===selectionRun){$('#filename').textContent=file;$('#editor').value=e.message;renderReader();}throw e;}}
$('#editor').oninput=()=>{$('#save').disabled=!dirty();$('#dirty').textContent=dirty()?'未保存':'';};
$('#save').onclick=guard(async()=>{if(!current)return;const content=$('#editor').value;const r=await api('file',{id:selected.id,path:current,content,version});original=content;version=r.version;$('#editor').oninput();await loadReader(selected.id,current,true);toast('已保存，原文件已备份');});
$('#search').oninput=render;$('#finder').onclick=guard(()=>api('open',{id:selected.id}));$('#sourceLink').onclick=guard(()=>{const u=addressOf(selected);if(u)return api('open',{url:u});});
$('#backToFolder').onclick=()=>{if(folder)openFolder(folder);};
$('#folderRefresh').onclick=guard(async()=>{await refresh(true);if(folder&&!$('#folder').hidden){renderFolder();markFolder(folder);}});
$('#folderFinder').onclick=guard(()=>{const mine=folderMine();return mine?api('open',{dir:mine.root}):api('open',{group:folder});});
$('#folderRelink').onclick=guard(async()=>{const mine=folderMine();if(!mine)return;const rep=await api('sources/link',{path:mine.root});await refresh(true);toast(rep.linked.length||rep.removed.length?'已链接 '+rep.linked.length+' 个、清理 '+rep.removed.length+' 个':'链接已是最新');});
$('#folderSync').onclick=guard(async()=>{const mine=folderMine();if(!mine)return;await openSync(mine.root);});
$('#folderNew').onclick=guard(async()=>{const mine=folderMine();if(!mine)return;await createMineSkill(mine.root);});
$('#folderUpdate').onclick=guard(async()=>{if(folderMine())return;const rows=folderRows();if(!rows.length)return;if(!confirm('更新「'+folderInfo().label+'」下的全部 '+rows.length+' 个技能？本地修改会先备份。'))return;await execute(['update',...rows.map(s=>s.name),'-g'],folder);});
$('#folderRemove').onclick=guard(async()=>{
 const rows=folderRows();if(!rows.length)return;const mine=folderMine();
 if(mine){
  if(!confirm('确定删除「'+folderInfo().label+'」下的全部 '+rows.length+' 个技能？源目录里的文件将被永久删除。\n\n'+rows.map(s=>s.name).join('、')))return;
  for(const s of rows)await api('sources/delete',{path:mine.root,name:s.name});
  folder=null;selected=null;current=null;$('#empty').hidden=false;$('#detail').hidden=true;$('#folder').hidden=true;await refresh(true);render();toast('已删除 '+rows.length+' 个技能');
  return;
 }
 if(!confirm('确定删除「'+folderInfo().label+'」下的全部 '+rows.length+' 个技能？此操作直接删除、不进行备份。\n\n'+rows.map(s=>s.name).join('、')))return;
 await execute(['remove',...rows.map(s=>s.name),'-g'],folder);
});
// 命令行面板：默认收起，右下角的小凸起按钮点击展开或折叠。
// 由按钮/命令自动拉起的（auto）在结束后自动收起；用户手动拉起的保持展开，不自动收起。
let consoleTimer,consoleAuto=false,consoleSuppressClose=false;
function setConsole(open,auto=false){clearTimeout(consoleTimer);consoleAuto=open&&auto;$('#console').classList.toggle('open',open);const h=$('#consoleHandle');h.setAttribute('aria-expanded',String(open));h.textContent=(open?'⌄':'⌃')+' 命令行';}
// 命令触发时展开：已经在展开状态（多为用户手动打开）就不改动，避免把手动面板变成自动收起。
// 同时忽略「触发本次打开的那一下点击」，免得它顺着冒泡被下面的外部点击监听立刻收掉。
function showConsole(){consoleSuppressClose=true;setTimeout(()=>{consoleSuppressClose=false;},0);if(!$('#console').classList.contains('open'))setConsole(true,true);}
$('#consoleHandle').onclick=()=>{const open=$('#console').classList.contains('open');setConsole(!open);if(!open)$('#command').focus();};$('#closeConsole').onclick=()=>setConsole(false);
// 点击面板和右下角开关以外的任意地方收起面板。
document.addEventListener('click',e=>{if(consoleSuppressClose||!$('#console').classList.contains('open'))return;if(e.target.closest?.('#console')||e.target.closest?.('#consoleHandle'))return;setConsole(false);});
// 「更多」菜单：选中任一项、点击面板以外或按 Esc 都收起。
// 点击某个 summary 时跳过它自己，否则会先被这里关掉、再被 details 的默认行为打开。
function closeMenus(except){for(const m of document.querySelectorAll('details.menu[open]'))if(m!==except)m.open=false;}
for(const m of document.querySelectorAll('details.menu'))m.addEventListener('click',e=>{if(e.target.closest('.menu-panel button'))closeMenus();});
document.addEventListener('click',e=>closeMenus(e.target.closest?.('details.menu')));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenus();});
function parse(text){const out=[];let word='',quote=null,active=false;for(const c of text.trim()){if(quote){if(c===quote)quote=null;else word+=c;active=true;}else if(c==='"'||c==="'"){quote=c;active=true;}else if(/\s/.test(c)){if(active){out.push(word);word='';active=false;}}else{word+=c;active=true;}}if(quote)throw Error('引号未闭合');if(active)out.push(word);return out;}
function busyUI(value){loading=value;for(const id of ['run','updateAll','updateOne','remove','submitAdd','folderRemove','folderUpdate','folderFinder','folderRefresh','folderRelink','folderSync','folderNew'])$('#'+id).disabled=value;}
async function execute(args,group){if(loading)throw Error('请等待当前命令完成');if(!leave())return;showConsole();$('#command').value=args.join(' ');await api('command',{args,group});busyUI(true);await poll();}
async function poll(){try{const j=await api('job');if(!j)return;$('#output').textContent=j.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');$('#output').scrollTop=$('#output').scrollHeight;$('#jobStatus').textContent=j.running?'运行中…':j.code===0?'完成':'失败 · 退出码 '+j.code;busyUI(j.running);if(j.running)setTimeout(poll,650);else{await refresh(true);if(selected&&!dirty())await choose(selected);toast(j.code===0?'命令执行完成':'命令失败，请查看输出');if(consoleAuto)consoleTimer=setTimeout(()=>setConsole(false),2000);}}catch(e){busyUI(false);toast(e.message);}}
$('#commandForm').onsubmit=guard(async e=>{e.preventDefault();const args=parse($('#command').value);const verb=args.filter(a=>!['npx','skills'].includes(a))[0];if(verb==='remove'&&!confirm('执行此命令？将直接删除技能，不进行备份。\n\n'+args.join(' ')))return;if(['update','add'].includes(verb)&&!confirm('执行此命令？修改前将备份当前技能。\n\n'+args.join(' ')))return;await execute(args);});
$('#updateAll').onclick=guard(()=>{if(confirm('更新所有全局技能？本地修改会先备份。'))return execute(['update','-g']);});
$('#updateOne').onclick=guard(()=>{if(confirm('更新 '+selected.name+'？本地修改会先备份。'))return execute(['update',selected.name,'-g']);});
async function deleteMineSkill(s){
 if(!confirm('确定删除技能 '+s.name+'？源目录与 ~/.agents/skills 里的链接都会被永久删除。\n\n'+s.mine.root))return;
 await api('sources/delete',{path:s.mine.root,name:s.name});
 await refresh(true);
 if(folder&&folderRows().length)openFolder(folder);
 else{folder=null;selected=null;current=null;$('#detail').hidden=true;$('#folder').hidden=true;$('#empty').hidden=false;render();}
 toast('已删除 '+s.name);
}
$('#remove').onclick=guard(()=>{if(selected.mine)return deleteMineSkill(selected);if(confirm('确定直接删除技能 '+selected.name+' 及其全部文件与 Agent 链接？此操作不进行备份。'))return execute(['remove',selected.name,'-g']);});
$('#add').onclick=()=>$('#addDialog').showModal();$('#cancelAdd').onclick=()=>$('#addDialog').close();
$('#addMode').onchange=()=>{const mode=$('#addMode').value;$('#skillField').hidden=mode!=='add';$('#addHint').hidden=mode!=='add';$('#package').placeholder=mode==='init'?'my-skill':mode==='find'?'例如 react':'mattpocock/skills@code-review';};
$('#addForm').onsubmit=guard(async e=>{e.preventDefault();const mode=$('#addMode').value,value=$('#package').value.trim();if(!value)return;const args=[mode,value];if(mode==='add'&&$('#skillName').value.trim())args.push('--skill',$('#skillName').value.trim());$('#addDialog').close();await execute(args);});
$('#newFile').onclick=guard(async()=>{if(!leave())return;const file=prompt('新文件路径，例如 references/notes.md');if(!file)return;await api('file',{id:selected.id,path:file,content:'',create:true});expandDirs(file);renderTree(await api('tree?id='+selected.id));await openFile(file,true);setView('edit');toast('文件已创建');});
$('#deleteFile').onclick=guard(async()=>{if(!current||!confirm('删除文件 '+current+'？原文件会备份。'))return;await api('file',{id:selected.id,path:current,version,delete:true});current=null;await choose(selected);toast('文件已删除');});
window.addEventListener('beforeunload',e=>{if(dirty()||agentDirty()){e.preventDefault();e.returnValue='';}});window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();if(agentActive){if(agentDirty())$('#agentSave').click();}else if(dirty())$('#save').click();}});


let readerData=null,readerSkill=null,readerFile=null,readerRun=0,view='read',bilingual=false,summaryExpanded=false,contentRenderKey='',summaryRenderKey='',resumeTimer;
const activeAI=new Map();
const activeKey=(id,file)=>id+'\n'+(file||'SKILL.md');
function updateKeyField(){$('#aiManualKey').hidden=$('#aiKeySource').value!=='manual';}
async function loadAISettings(){
 const c=await api('ai/settings');
 $('#aiBaseUrl').value=c.baseUrl;$('#aiModel').value=c.model;$('#aiKeySource').value=c.keySource;
 $('#aiKey').value='';$('#aiKey').placeholder=c.hasSavedKey?'已保存，留空保持不变':'输入 API Key';
 $('#aiClearKey').disabled=!c.hasSavedKey;
 $('#aiKeyStatus').textContent=(c.keyAvailable?'可用：':'未就绪：')+c.source;
 updateKeyField();
}
$('#aiKeySource').onchange=updateKeyField;
async function saveAISettings(clearKey=false){
 const c=await api('ai/settings',{baseUrl:$('#aiBaseUrl').value,model:$('#aiModel').value,keySource:$('#aiKeySource').value,apiKey:$('#aiKey').value,clearKey});
 $('#aiKey').value='';return c;
}
$('#aiSettingsForm').onsubmit=guard(async e=>{e.preventDefault();$('#aiSaveSettings').disabled=true;try{const c=await saveAISettings();toast(c.keyAvailable?'AI 设置已保存':'设置已保存；尚未检测到 Key');}finally{$('#aiSaveSettings').disabled=false;}});
$('#aiClearKey').onclick=guard(async()=>{await saveAISettings(true);await loadAISettings();toast('已清除手动保存的 Key');});

// 「设置」页：左侧分类导航 + 右侧分区卡片。刘海与菜单栏相关的开关已搬到「通知岛」视图（见 renderIslandSettings）。
const settingsPanes=['appearance','ai','about'];
function showSettingsPane(name){
 const next=settingsPanes.includes(name)?name:settingsPanes[0];
 for(const p of document.querySelectorAll('#settingsWorkspace [data-pane]'))p.hidden=p.dataset.pane!==next;
 for(const b of document.querySelectorAll('#settingsWorkspace [data-settings-pane]'))b.setAttribute('aria-pressed',String(b.dataset.settingsPane===next));
}
for(const b of document.querySelectorAll('#settingsWorkspace [data-settings-pane]'))b.onclick=()=>showSettingsPane(b.dataset.settingsPane);

function setView(next){
 view=next;$('#reader').hidden=next!=='read';$('#editor').hidden=next!=='edit';
 $('#readView').setAttribute('aria-pressed',String(next==='read'));$('#editView').setAttribute('aria-pressed',String(next==='edit'));
 $('#save').hidden=next!=='edit';$('#deleteFile').hidden=next!=='edit';
 if(next==='read')renderReader();
}
let readerFrame;
function queueReaderRender(){if(readerFrame)return;readerFrame=requestAnimationFrame(()=>{readerFrame=null;renderReader();});}
// 按段落渲染原文与译文（技能与智能体共用）：metadata 收进折叠块（默认展开，保留用户的折叠状态），可翻译段落上下对照。
function renderPairs(blocks,translation,pending,bilingual,metadataLabel,metadataOpen=true){
 const frag=document.createDocumentFragment();
 for(const block of blocks){
  const pair=document.createElement('section');pair.className='reading-block';pair.dataset.paragraph=block.id;
  if(block.type==='metadata'){
   const details=document.createElement('details');details.className='frontmatter';const label=document.createElement('summary');label.textContent=metadataLabel;details.append(label,renderBlock(block));
   if(bilingual&&translation?.segments[block.id]){const translated=document.createElement('div');translated.className='translated';renderMarkdown(translated,translation.segments[block.id]);details.append(translated);}
   details.open=!!metadataOpen;pair.append(details);
  }else{
   const source=document.createElement('div');source.className='original';source.append(renderBlock(block));pair.append(source);
   if(bilingual&&!['code','rule'].includes(block.type)){
    const translated=document.createElement('div');translated.className='translated';translated.lang='zh-CN';
    if(translation?.segments[block.id])renderMarkdown(translated,translation.segments[block.id]);
    else{translated.classList.add('translation-pending');translated.textContent=pending==='translate'?'翻译中…':'待翻译';}
    pair.append(translated);
   }
  }
  frag.append(pair);
 }
 return frag;
}
function renderReader(){
 const isSkill=current==='SKILL.md',loaded=!!(readerData&&readerFile===current);
 $('#summaryCard').hidden=!isSkill;$('#translationBar').hidden=!current||!bilingual;
 $('#summarize').setAttribute('aria-pressed',String(isSkill&&summaryExpanded));$('#translate').setAttribute('aria-pressed',String(bilingual));
 const blocks=loaded?readerData.blocks:splitMarkdown($('#editor').value);
 const summary=isSkill&&loaded?readerData.summary:null,translation=loaded?readerData.translation:null;
 const pending=activeAI.get(activeKey(selected?.id,current))||(loaded?readerData.pending:null);
 if(isSkill){
  $('#summaryToggle').setAttribute('aria-expanded',String(summaryExpanded));$('#summaryCopy').hidden=!summary;
  $('#summaryHint').textContent=pending==='summary'?'正在总结…':summary?'已保存 · 点击'+(summaryExpanded?'收起':'展开'):'点击生成，快速了解这个技能';
  $('#summaryBody').hidden=!summaryExpanded||!summary;
  if(summary&&summaryRenderKey!==summary.text){renderMarkdown($('#summaryBody'),summary.text);summaryRenderKey=summary.text;}
  $('#summaryCard').classList.toggle('is-loading',pending==='summary');
 }
 $('#translationStatus').textContent=translation?.complete?'上下对照 · 已缓存':pending==='translate'?`正在翻译 · ${translation?.done||0} / ${translation?.total??blocks.filter(b=>!['code','rule'].includes(b.type)).length} 段`:'上下对照 · '+(translation?.done?'已保留 '+translation.done+' 段':'等待生成');
 $('#translationCopy').hidden=!translation?.done;$('#translationRetry').hidden=!!pending||!!translation?.complete;
 const content=$('#readingContent'),nextKey=JSON.stringify([selected?.id,current,blocks,bilingual,bilingual?translation?.segments:null,pending==='translate']);
 if(nextKey===contentRenderKey)return;contentRenderKey=nextKey;
 const scroller=$('#reader'),oldTop=scroller.scrollTop,anchor=[...content.children].find(el=>el.getBoundingClientRect().bottom>scroller.getBoundingClientRect().top),anchorID=anchor?.dataset.paragraph,anchorOffset=anchor?.getBoundingClientRect().top,metadataOpen=content.querySelector('.frontmatter')?.open;
 content.replaceChildren(renderPairs(blocks,translation,pending,bilingual,'技能声明',metadataOpen));
 const restored=[...content.children].find(el=>el.dataset.paragraph===anchorID);
 scroller.scrollTop=restored&&oldTop>0?oldTop+restored.getBoundingClientRect().top-anchorOffset:oldTop;
}
async function loadReader(id,file='SKILL.md',reset=false){
 clearTimeout(resumeTimer);
 const run=++readerRun;if(reset){readerData=null;readerSkill=id;readerFile=file;bilingual=false;summaryExpanded=false;$('#summaryStatus').hidden=true;}
 renderReader();
 try{
  const data=await api('ai/document?id='+encodeURIComponent(id)+'&path='+encodeURIComponent(file));
  if(run!==readerRun||selected?.id!==id||current!==file)return;
  readerData=data;readerSkill=id;readerFile=file;if(reset)summaryExpanded=!!data.summary;renderReader();
  if(data.pending&&!activeAI.has(activeKey(id,file)))resumeTimer=setTimeout(()=>{if(selected?.id===id&&current===file)loadReader(id,file);},1000);
 }catch(e){if(selected?.id===id){if(file==='SKILL.md'){$('#summaryStatus').hidden=false;$('#summaryStatus').textContent=e.message;}else toast(e.message);}}
}
async function startAI(mode){
 const id=selected.id,file=mode==='summary'?'SKILL.md':current;
 if(dirty()){toast('请先保存当前文件，再生成或切换阅读内容');return;}
 if(mode==='summary'&&current!=='SKILL.md'){await openFile('SKILL.md');if(selected?.id!==id||current!=='SKILL.md')return;}
 if(!file)return;
 setView('read');
 if(mode==='summary')summaryExpanded=true;else bilingual=true;
 renderReader();
 const key=activeKey(id,file),loaded=!!(readerData&&readerFile===file);
 if(activeAI.has(key)||(loaded&&readerData.pending))return;
 $('#summaryStatus').hidden=true;
 if(loaded&&(mode==='summary'&&readerData.summary?.complete||mode==='translate'&&readerData.translation?.complete))return;
 activeAI.set(key,mode);renderReader();
 let streamRevision=loaded?readerData.revision:undefined;
 async function generateStream(){
  const response=await fetch('/api/ai/generate',{method:'POST',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:JSON.stringify({id,mode,path:file,stream:true})});
  if(!response.ok)throw Error((await response.json()).error);
  let result;
  for await(const line of responseLines(response)){
   if(!line.trim())continue;const event=JSON.parse(line);
   if(event.type==='error')throw Error(event.message);
   if(event.type==='done'){result=event.result;continue;}
   if(event.type==='start')streamRevision=event.revision;
   if(selected?.id!==id||!readerData||readerFile!==file||readerData.revision!==streamRevision)continue;
   if(event.type==='summary'){readerData.summary={text:(readerData.summary?.complete?'':readerData.summary?.text||'')+event.delta,complete:false};queueReaderRender();}
   if(event.type==='translation'){readerData.translation=event.translation;renderReader();}
  }
  if(!result)throw Error('生成连接中断，请重试');return result;
 }
 try{
  if(mode==='summary'&&loaded&&readerData)readerData.summary=null;
  const r=await generateStream();
  if(selected?.id===id){await loadReader(id,file);if(mode==='summary'&&r.incomplete){$('#summaryStatus').hidden=false;$('#summaryStatus').textContent='摘要被模型截断，请再次点击生成。';}}
 }catch(e){
  if(selected?.id===id){await loadReader(id,file);if(mode==='summary'){$('#summaryStatus').hidden=false;$('#summaryStatus').textContent=e.message;}else toast(e.message);}
  else toast(e.message);
 }finally{activeAI.delete(key);if(selected?.id===id&&readerFile===file&&readerData){readerData.pending=null;renderReader();}}
}
$('#readView').onclick=()=>{if(dirty()){toast('请先保存修改后再阅读');return;}setView('read');};$('#editView').onclick=()=>setView('edit');
$('#summarize').onclick=guard(async()=>{if(current==='SKILL.md'&&readerFile==='SKILL.md'&&readerData?.summary?.complete){summaryExpanded=!summaryExpanded;setView('read');}else await startAI('summary');});
$('#summaryToggle').onclick=guard(()=>{if(current==='SKILL.md'&&readerFile==='SKILL.md'&&readerData?.summary?.complete){summaryExpanded=!summaryExpanded;renderReader();}else return startAI('summary');});
$('#translate').onclick=guard(async()=>{if(bilingual){bilingual=false;renderReader();}else await startAI('translate');});
$('#translationRetry').onclick=guard(()=>startAI('translate'));
$('#summaryCopy').onclick=guard(async()=>{await navigator.clipboard.writeText(readerData.summary.text);toast('已复制总结');});
$('#translationCopy').onclick=guard(async()=>{await navigator.clipboard.writeText(readerData.blocks.map(b=>readerData.translation.segments[b.id]||(['code','rule'].includes(b.type)?b.text:'')).join('\n\n'));toast('已复制译文');});

let mineData=[];
async function loadMine(){mineData=await api('sources');renderMine();}
function mineButton(text,cls,fn){const b=document.createElement('button');b.textContent=text;if(cls)b.className=cls;b.onclick=guard(fn);return b;}
function renderMine(){
 const list=$('#mineList');list.replaceChildren();
 if(!mineData.length){const p=document.createElement('p');p.className='muted';p.textContent='还没有添加目录。在上面输入一个路径即可创建或接入。';list.append(p);return;}
 for(const r of mineData){
  const card=document.createElement('div');card.className='mine-item';
  const head=document.createElement('div');head.className='mine-head';
  const strong=document.createElement('strong');strong.textContent=r.name||r.path.split('/').pop();
  const where=document.createElement('span');where.className='muted';where.textContent=r.path;
  head.append(strong,where);
  const meta=document.createElement('div');meta.className='mine-meta muted';
  const bits=[];
  if(!r.exists)bits.push('目录不存在或已被移动');
  else{
   const linked=r.skills.filter(s=>s.status==='linked').length,conflict=r.skills.filter(s=>s.status==='conflict').length,missing=r.skills.filter(s=>s.status==='missing').length,paused=r.skills.filter(s=>s.status==='disabled').length;
   bits.push(r.skills.length+' 个技能','已链接 '+linked);
   if(paused)bits.push('已停用 '+paused);
   if(conflict)bits.push('名称冲突 '+conflict);
   if(missing)bits.push('未链接 '+missing);
   if(r.git?.repo)bits.push('GitHub '+r.git.repo+(r.git.changes?'（'+r.git.changes+' 个未提交改动）':''));
   else bits.push('未同步到 GitHub');
  }
  meta.textContent=bits.join(' · ');
  const actions=document.createElement('div');actions.className='mine-actions';
  if(r.exists)actions.append(
   mineButton('Finder','',()=>api('open',{dir:r.path})),
   mineButton('重新链接','',async()=>{const rep=await api('sources/link',{path:r.path});await loadMine();await refresh(true);toast(rep.linked.length||rep.removed.length?'已链接 '+rep.linked.length+' 个、清理 '+rep.removed.length+' 个':'链接已是最新');}),
   mineButton('新建技能','',()=>createMineSkill(r.path)),
   mineButton(r.git?.repo?'推送更新':'同步到 GitHub','primary',()=>openSync(r.path)),
  );
  actions.append(mineButton('移除','danger',async()=>{if(!confirm('移除「'+(r.name||r.path)+'」？只删除管理配置和 ~/.agents/skills 里的链接，不会删除目录文件。'))return;await api('sources/remove',{path:r.path});await loadMine();await refresh(true);toast('已移除');}));
  card.append(head,meta,actions);list.append(card);
 }
}
async function createMineSkill(rootPath){
 const name=prompt('新技能名称（只能用小写字母、数字和短横线）');if(!name)return;
 await api('sources/create',{path:rootPath,name});
 await loadMine();await refresh(true);toast('已创建 '+name);
}
$('#folderManage').onclick=guard(async()=>{$('#mineStatus').hidden=true;$('#mineDialog').showModal();await loadMine();});
$('#syncMine').onclick=guard(async()=>{
 if(!mineRoots.length)return;
 if(!confirm('一键同步 '+mineRoots.length+' 个目录？\n\n1. 把目录里已启用的技能链接到 ~/.agents/skills（已停用的保持不变）\n2. 把已连接 GitHub 的目录提交并推送\n\n'+mineRoots.map(r=>r.name||r.path).join('、')))return;
 $('#syncMine').disabled=true;
 try{
  const {results}=await api('sources/sync-all',{});
  const enabled=results.reduce((n,r)=>n+r.linked.length,0);
  const pushed=results.filter(r=>r.pushed);
  const lines=['已启用 '+enabled+' 个技能'+(pushed.length?'，已推送 '+pushed.length+' 个目录到 GitHub':'')];
  for(const r of results){
   if(r.error)lines.push('· '+r.name+'：失败 '+r.error);
   else if(r.conflicts.length)lines.push('· '+r.name+'：'+r.conflicts.length+' 个名称冲突未启用（'+r.conflicts.join('、')+'）');
   else if(r.note)lines.push('· '+r.name+'：'+r.note);
  }
  await refresh(true);
  if($('#mineDialog').open)await loadMine();
  toast(lines.join('\n'));
 }finally{$('#syncMine').disabled=false;}
});
$('#mineClose').onclick=()=>$('#mineDialog').close();
async function addMine(p){
 $('#mineStatus').hidden=false;$('#mineStatus').textContent='正在添加并链接…';
 try{
  const r=await api('sources/add',{path:p});
  $('#minePath').value='';
  $('#mineStatus').textContent='已添加 '+r.path+'，链接 '+r.report.linked.length+' 个技能'+(r.report.conflicts.length?'；'+r.report.conflicts.length+' 个名称冲突未链接：'+r.report.conflicts.join('、'):'');
  await loadMine();await refresh(true);
 }catch(e){$('#mineStatus').textContent=e.message;throw e;}
}
$('#mineAddForm').onsubmit=guard(async e=>{e.preventDefault();const p=$('#minePath').value.trim();if(!p)return;await addMine(p);});
$('#mineBrowse').onclick=guard(async()=>{
 $('#mineStatus').hidden=false;$('#mineStatus').textContent='请在弹出的 Finder 窗口里选择文件夹（可以直接新建）…';
 const r=await api('sources/pick',{});
 if(r.cancelled){$('#mineStatus').textContent='已取消选择';return;}
 await addMine(r.path);
});
let syncTarget=null;
function updateSyncFields(){
 const existing=$('#syncMode').value==='existing';
 $('#syncNameLabel').hidden=existing;$('#syncVisibilityLabel').hidden=existing;$('#syncUrlLabel').hidden=!existing;
}
$('#syncMode').onchange=updateSyncFields;
async function openSync(rootPath){
 await loadMine();
 const r=mineData.find(x=>x.path===rootPath)||{path:rootPath,name:rootPath.split('/').pop(),git:null};
 syncTarget=r;
 $('#syncRepo').value=r.name||'';$('#syncUrl').value=r.git?.origin||'';
 $('#syncHint').textContent=r.git?.repo?'当前远程：'+r.git.repo+'。同步会提交所有改动并推送。':'将初始化 Git 仓库，并用 gh 创建 GitHub 仓库后推送。需要已安装并登录 gh 命令行。';
 $('#syncMode').value=r.git?.repo?'existing':'create';
 updateSyncFields();$('#syncDialog').showModal();
}
$('#syncCancel').onclick=()=>$('#syncDialog').close();
$('#syncForm').onsubmit=guard(async e=>{
 e.preventDefault();if(!syncTarget)return;
 const mode=$('#syncMode').value,submit=$('#syncSubmit');submit.disabled=true;
 try{
  const body={path:syncTarget.path,mode};
  if(mode==='create'){body.repo=$('#syncRepo').value.trim();body.visibility=$('#syncVisibility').value;}
  else body.url=$('#syncUrl').value.trim();
  const r=await api('sources/sync',body);
  $('#syncDialog').close();await loadMine();await refresh(true);
  toast('已同步'+(r.repo?'到 '+r.repo:'')+(r.committed?'':'（没有新的改动）'));
 }finally{submit.disabled=false;}
});

// 智能体：管理 ~/.config/opencode/agents 里的 OpenCode agent 定义（Markdown 文件），与「技能」互相独立。
// 文件即配置：ID 就是文件名，frontmatter 是配置，正文是系统提示词；保存、重命名、删除前都会备份。
let agentActive=false,agentItems=[],agentLoaded=false,agentSel=null,agentOriginal='',agentVersion='',agentRun=0,agentProvider='opencode';
const agentCodex=()=>agentProvider==='codex';
const agentRoute=s=>agentCodex()?'codex/agents'+s:'agents'+s;
function agentDirty(){return !!(agentSel&&$('#agentEditor').value!==agentOriginal);}
function agentLeave(){return !agentDirty()||confirm('智能体定义尚未保存，放弃修改？');}
function agentDirtyUI(){$('#agentSave').disabled=!agentDirty();$('#agentDirty').textContent=agentDirty()?'未保存':'';}
// 来源切换：OpenCode（~/.config/opencode/agents/*.md）与 Codex（~/.codex/agents/*.toml）。
function refreshAgentChrome(){
 const codex=agentCodex();
 $('#agentNew').title=codex?'在 ~/.codex/agents 下新建 Codex 自定义智能体':'在 ~/.config/opencode/agents 下新建智能体定义';
 $('#agentNew').textContent=codex?'＋ 新建 Codex 智能体':'＋ 新建智能体';
 $('#agentSearch').placeholder=codex?'搜索名称、描述、模型…':'搜索名称、描述、模式…';
 $('#agentToggle').hidden=codex;
 $('#agentDialogTitle').textContent=codex?'新建 Codex 智能体':'新建智能体';
 $('#agentDialogHint').textContent=codex?'在 ~/.codex/agents 下创建一个 Codex 自定义智能体（TOML：name / description / developer_instructions）。Codex 以 name 字段识别它，建议两者一致。':'在 ~/.config/opencode/agents 下创建一个 OpenCode 智能体定义（Markdown + frontmatter）。OpenCode 会自动加载新文件，无需重启。';
 $('#agentModeLabel').hidden=codex;$('#agentColorLabel').hidden=codex;
 const id=$('#agentIdInput');id.pattern=codex?'[A-Za-z0-9][A-Za-z0-9_-]*':'[a-z0-9][a-z0-9-]*';
 id.title=codex?'只能使用字母、数字、短横线和下划线':'只能使用小写字母、数字和短横线';
 id.placeholder=codex?'security-reviewer':'reviewer';
}
function setAgentProvider(name){
 if(!['opencode','codex'].includes(name)||name===agentProvider)return;
 if(!agentLeave())return;
 agentProvider=name;agentLoaded=false;agentSel=null;agentOriginal='';
 $('#agentDetail').hidden=true;$('#agentEmpty').hidden=false;
 for(const b of document.querySelectorAll('#agentsWorkspace [data-agent-provider]'))b.setAttribute('aria-pressed',String(b.dataset.agentProvider===name));
 refreshAgentChrome();
 loadAgents().catch(e=>toast(e.message));
}
async function loadAgents(){
 const r=await api(agentRoute(''));
 agentItems=r.agents;agentLoaded=true;
 $('#agentRoot').textContent=(agentCodex()?'Codex · ':'OpenCode · ')+r.root;
 renderAgents();
 if(agentSel){const a=agentItems.find(x=>x.id===agentSel.id);if(a)agentSel=a;else{agentSel=null;$('#agentDetail').hidden=true;$('#agentEmpty').hidden=false;}}
}
function renderAgents(){
 const codex=agentCodex(),q=$('#agentSearch').value.toLowerCase();
 const rows=agentItems.filter(a=>[a.id,a.name,a.description,a.mode,a.model,a.effort,a.sandbox].filter(Boolean).join(' ').toLowerCase().includes(q));
 $('#agentCount').textContent=`${rows.length} / ${agentItems.length}`;
 const list=$('#agentList');list.replaceChildren();
 if(!rows.length){const p=document.createElement('p');p.className='muted';p.textContent=agentItems.length?'没有匹配的智能体':(codex?'还没有 Codex 智能体，点上方「＋ 新建 Codex 智能体」创建。':'还没有智能体，点上方「＋ 新建智能体」创建。');list.append(p);return;}
 for(const a of rows){
  const b=button('',`skill-item ${agentSel?.id===a.id?'selected':''}`,()=>openAgent(a));
  b.title=(codex?a.name:a.id)||a.description||a.id;
  const line=document.createElement('span');line.className='agent-line';
  const dot=document.createElement('i');dot.className='agent-dot';if(/^#[0-9a-fA-F]{6}$/.test(a.color))dot.style.background=a.color;else if(codex)dot.style.background='#10a37f';
  const strong=document.createElement('strong');strong.textContent=codex?(a.name||a.id):a.id;line.append(dot,strong);
  if(!codex&&a.disabled){const tag=document.createElement('span');tag.className='badge';tag.textContent='已停用';line.append(tag);}
  else if(!codex&&a.mode){const tag=document.createElement('span');tag.className='badge';tag.textContent=a.mode;line.append(tag);}
  else if(codex&&a.effort){const tag=document.createElement('span');tag.className='badge';tag.textContent=a.effort;line.append(tag);}
  if(a.problems.length){const tag=document.createElement('span');tag.className='badge conflict';tag.textContent='需检查';tag.title=a.problems.join('\n');line.append(tag);}
  const small=document.createElement('small');small.textContent=a.description||'（未填写 description）';
  b.append(line,small);list.append(b);
 }
}
function fact(k,v,cls=''){
 if(v===undefined||v===null||v==='')return null;
 const d=document.createElement('div');d.className='fact'+cls;
 const kk=document.createElement('span');kk.className='fact-key';kk.textContent=k;
 const vv=document.createElement('span');vv.className='fact-val';vv.textContent=v;
 d.append(kk,vv);return d;
}
function renderAgentFacts(a){
 const box=$('#agentFacts');box.replaceChildren();
 const rows=agentCodex()?[
  ['名称',a.name||'未填写'],['描述',a.description||'未填写'],['模型',a.model||'继承会话'],['思考强度',a.effort||'继承会话'],['沙箱',a.sandbox||'继承会话'],
  ['ID / 文件',a.id+'（'+a.file+'）'],['大小',a.size+' 字节 · '+new Date(a.mtime).toLocaleString()],
 ]:[
  ['状态',a.disabled?'已停用':'已启用'],['模式',a.mode||'未设置'],['模型',a.model||'继承会话'],['颜色',a.color||'未设置'],['描述',a.description||'未填写'],['name 字段',a.nameField?a.nameField+'（V2 不生效，ID 由文件名决定）':''],['文件',a.path],['大小',a.size+' 字节 · '+new Date(a.mtime).toLocaleString()],
 ];
 for(const [k,v] of rows)box.append(fact(k,v));
}
// 智能体的能力总结与翻译：复用技能的段落对齐和缓存机制（/api/ai/agent/*），只是针对单个定义文件。
let agentAIData=null,agentAIFile=null,agentAIRun=0,agentAIBilingual=false,agentAISummaryExpanded=false,agentAISummaryKey='',agentAIResumeTimer;
const agentAIKey=id=>(agentCodex()?'codex-agent:':'agent:')+id+'\nAGENT.md';
function renderAgentReading(){
 if(!agentSel)return;
 const id=agentSel.id,loaded=!!(agentAIData&&agentAIFile===id);
 const blocks=loaded?agentAIData.blocks:splitMarkdown($('#agentEditor').value);
 const summary=loaded?agentAIData.summary:null,translation=loaded?agentAIData.translation:null;
 const pending=activeAI.get(agentAIKey(id))||(loaded?agentAIData.pending:null);
 $('#agentSummaryToggle').setAttribute('aria-expanded',String(agentAISummaryExpanded));$('#agentSummaryCopy').hidden=!summary;
 $('#agentSummaryHint').textContent=pending==='summary'?'正在总结…':summary?'已保存 · 点击'+(agentAISummaryExpanded?'收起':'展开'):'点击生成，快速了解这个智能体';
 $('#agentSummaryBody').hidden=!agentAISummaryExpanded||!summary;
 if(summary&&agentAISummaryKey!==summary.text){renderMarkdown($('#agentSummaryBody'),summary.text);agentAISummaryKey=summary.text;}
 $('#agentSummaryCard').classList.toggle('is-loading',pending==='summary');
 $('#agentSummarize').setAttribute('aria-pressed',String(agentAISummaryExpanded));$('#agentTranslate').setAttribute('aria-pressed',String(agentAIBilingual));
 $('#agentTranslationBar').hidden=!agentAIBilingual;
 $('#agentTranslationStatus').textContent=translation?.complete?'上下对照 · 已缓存':pending==='translate'?`正在翻译 · ${translation?.done||0} / ${translation?.total??blocks.filter(b=>!['code','rule'].includes(b.type)).length} 段`:'上下对照 · '+(translation?.done?'已保留 '+translation.done+' 段':'等待生成');
 $('#agentTranslationCopy').hidden=!translation?.done;$('#agentTranslationRetry').hidden=!!pending||!!translation?.complete;
 const content=$('#agentReading'),scroller=$('#agentReader'),oldTop=scroller.scrollTop,metadataOpen=content.querySelector('.frontmatter')?.open;
 content.replaceChildren(renderPairs(blocks,translation,pending,agentAIBilingual,'定义声明',metadataOpen));
 scroller.scrollTop=oldTop;
}
async function loadAgentAI(id,reset=false){
 clearTimeout(agentAIResumeTimer);
 const run=++agentAIRun;
 if(reset){agentAIData=null;agentAIFile=id;agentAIBilingual=false;agentAISummaryExpanded=false;$('#agentSummaryStatus').hidden=true;}
 renderAgentReading();
 try{
  const data=await api((agentCodex()?'ai/codex/document?id=':'ai/agent/document?id=')+encodeURIComponent(id));
  if(run!==agentAIRun||agentSel?.id!==id)return;
  agentAIData=data;agentAIFile=id;if(reset)agentAISummaryExpanded=!!data.summary;renderAgentReading();
  if(data.pending&&!activeAI.has(agentAIKey(id)))agentAIResumeTimer=setTimeout(()=>{if(agentSel?.id===id)loadAgentAI(id);},1000);
 }catch(e){if(agentSel?.id===id){$('#agentSummaryStatus').hidden=false;$('#agentSummaryStatus').textContent=e.message;}}
}
async function startAgentAI(mode){
 if(!agentSel)return;
 const id=agentSel.id;
 if(agentDirty()){toast('请先保存当前文件，再生成或切换阅读内容');return;}
 setAgentView('read');
 if(mode==='summary')agentAISummaryExpanded=true;else agentAIBilingual=true;
 renderAgentReading();
 const key=agentAIKey(id),loaded=!!(agentAIData&&agentAIFile===id);
 if(activeAI.has(key)||(loaded&&agentAIData.pending))return;
 $('#agentSummaryStatus').hidden=true;
 if(loaded&&(mode==='summary'&&agentAIData.summary?.complete||mode==='translate'&&agentAIData.translation?.complete))return;
 activeAI.set(key,mode);renderAgentReading();
 let streamRevision=loaded?agentAIData.revision:undefined;
 async function generateStream(){
  const response=await fetch(agentCodex()?'/api/ai/codex/generate':'/api/ai/agent/generate',{method:'POST',headers:{'x-bobo-token':token,'Content-Type':'application/json'},body:JSON.stringify({id,mode,stream:true})});
  if(!response.ok)throw Error((await response.json()).error);
  let result;
  for await(const line of responseLines(response)){
   if(!line.trim())continue;const event=JSON.parse(line);
   if(event.type==='error')throw Error(event.message);
   if(event.type==='done'){result=event.result;continue;}
   if(event.type==='start')streamRevision=event.revision;
   if(agentSel?.id!==id||!agentAIData||agentAIData.revision!==streamRevision)continue;
   if(event.type==='summary'){agentAIData.summary={text:(agentAIData.summary?.complete?'':agentAIData.summary?.text||'')+event.delta,complete:false};renderAgentReading();}
   if(event.type==='translation'){agentAIData.translation=event.translation;renderAgentReading();}
  }
  if(!result)throw Error('生成连接中断，请重试');return result;
 }
 try{
  if(mode==='summary'&&loaded&&agentAIData)agentAIData.summary=null;
  const r=await generateStream();
  if(agentSel?.id===id){await loadAgentAI(id);if(mode==='summary'&&r.incomplete){$('#agentSummaryStatus').hidden=false;$('#agentSummaryStatus').textContent='摘要被模型截断，请再次点击生成。';}}
 }catch(e){
  if(agentSel?.id===id){await loadAgentAI(id);if(mode==='summary'){$('#agentSummaryStatus').hidden=false;$('#agentSummaryStatus').textContent=e.message;}else toast(e.message);}
  else toast(e.message);
 }finally{activeAI.delete(key);if(agentSel?.id===id&&agentAIData){agentAIData.pending=null;renderAgentReading();}}
}
async function openAgent(a){
 if(!agentLeave())return;
 const run=++agentRun;agentSel=a;
 $('#agentEmpty').hidden=true;$('#agentDetail').hidden=false;
 $('#agentName').textContent=agentCodex()?(a.name||a.id):a.id;
 $('#agentDescription').textContent=a.description||'此智能体暂未填写 description。';
 $('#agentMeta').textContent=(agentCodex()?[a.id,a.model,a.effort,a.sandbox,a.link?'符号链接':null]:[a.mode||'未设置模式',a.model||null,a.hidden?'已隐藏':null,a.link?'符号链接':null]).filter(Boolean).join(' · ');
 renderAgentFacts(a);
 const problems=$('#agentProblems');
 problems.hidden=!a.problems.length;problems.textContent=a.problems.length?'需要检查：'+a.problems.join('；'):'';
 $('#agentFilename').textContent=a.file;
 try{
  const f=await api(agentRoute('/file?id='+encodeURIComponent(a.id)));
  if(run!==agentRun)return;
  agentOriginal=f.content;agentVersion=f.version;
  $('#agentEditor').value=f.content;
  $('#agentFileInfo').textContent=f.content.split('\n').length+' 行';
  $('#agentReader').scrollTop=0;
  setAgentView('read');agentDirtyUI();
  await loadAgentAI(a.id,true);
 }catch(e){toast(e.message);}
}
function setAgentView(next){
 $('#agentReader').hidden=next!=='read';$('#agentEditor').hidden=next!=='edit';
 $('#agentReadView').setAttribute('aria-pressed',String(next==='read'));$('#agentEditView').setAttribute('aria-pressed',String(next==='edit'));
 $('#agentSave').hidden=next!=='edit';$('#agentSave').disabled=!agentDirty();
 if(next==='read')renderAgentReading();
}
// 五个一级视图：技能 / 智能体 / 通知岛 / 用量 / 设置。切换前先处理未保存的编辑。
// 「设置」是从侧栏左下角打开的临时 tab：打开时出现在 tab 栏，点右侧 × 关闭并回到来源视图。
let settingsBack='skills';
function openSettings(){return switchView('settings');}
function closeSettings(){
 const inSettings=islandView==='settings',back=settingsBack==='settings'?'skills':settingsBack;
 $('#settingsTab').hidden=true;$('#settingsClose').hidden=true;
 return inSettings?switchView(back):null;
}
async function switchView(next){
 if(next===islandView)return;
 if(islandView==='skills'&&!leave())return;
 if(islandView==='agents'&&!agentLeave())return;
 if(next==='settings'){$('#settingsTab').hidden=false;$('#settingsClose').hidden=false;settingsBack=islandView;}
 islandView=next;agentActive=next==='agents';
 document.body.dataset.view=next;
 $('#skillsWorkspace').hidden=next!=='skills';
 $('#agentsWorkspace').hidden=next!=='agents';
 $('#islandWorkspace').hidden=next!=='island';
 $('#usageWorkspace').hidden=next!=='usage';
 $('#settingsWorkspace').hidden=next!=='settings';
 for(const [id,name] of [['#skillsTab','skills'],['#agentsTab','agents'],['#islandTab','island'],['#usageTab','usage'],['#settingsTab','settings']])$(id).setAttribute('aria-pressed',String(next===name));
 if(next==='agents'){if(!agentLoaded)await loadAgents();else renderAgents();}
 if(next==='island')openIsland();else islandClose();
 if(next==='usage')openUsage();else usageClose();
 if(next==='settings')await loadAISettings();
}
async function saveAgent(){
 if(!agentSel)return;
 const content=$('#agentEditor').value;
 const r=await api(agentRoute('/save'),{id:agentSel.id,content,version:agentVersion});
 agentOriginal=content;agentVersion=r.version;agentDirtyUI();
 await loadAgents();
 await loadAgentAI(agentSel.id,true);
 const a=agentItems.find(x=>x.id===agentSel.id);
 if(a){agentSel=a;renderAgentFacts(a);$('#agentDescription').textContent=a.description||'此智能体暂未填写 description。';$('#agentProblems').hidden=!a.problems.length;$('#agentProblems').textContent=a.problems.length?'需要检查：'+a.problems.join('；'):'';}
 toast('已保存，原文件已备份');
}
async function toggleAgent(){
 if(!agentSel||agentCodex())return;
 if(agentDirty()){toast('请先保存修改，再切换启用状态');return;}
 const id=agentSel.id,enable=agentSel.disabled;
 const r=await api('agents/toggle',{id,enabled:enable});
 await loadAgents();
 const a=agentItems.find(x=>x.id===id);
 if(a)await openAgent(a);
 toast(r.enabled?'已启用 '+id:'已停用 '+id+'，OpenCode 不再加载它');
}
async function renameAgent(){
 if(!agentSel)return;
 if(agentDirty()){toast('请先保存修改，再重命名');return;}
 const codex=agentCodex();
 const next=(prompt(codex?'新的文件名（字母、数字、短横线和下划线）。\nCodex 实际以 TOML 里的 name 字段识别智能体，这里只改文件名，需要的话请再编辑 name。':'新的 ID（文件名，小写字母、数字和短横线）。\n重命名会改变 ID，已有会话对旧 ID 的引用将失效。',agentSel.id)||'').trim();
 if(!next||next===agentSel.id)return;
 await api(agentRoute('/rename'),{id:agentSel.id,next});
 await loadAgents();
 const a=agentItems.find(x=>x.id===next);
 if(a)await openAgent(a);
 toast('已重命名为 '+next);
}
async function deleteAgent(){
 if(!agentSel)return;
 const label=agentCodex()?(agentSel.name||agentSel.id):agentSel.id;
 if(!confirm('删除智能体 '+label+'？定义文件会先备份到 ~/.bobo/backups。'))return;
 await api(agentRoute('/delete'),{id:agentSel.id});
 agentSel=null;agentOriginal='';agentVersion='';
 $('#agentEditor').value='';$('#agentDetail').hidden=true;$('#agentEmpty').hidden=false;
 await loadAgents();
 toast('已删除');
}
$('#skillsTab').onclick=guard(()=>switchView('skills'));
$('#agentsTab').onclick=guard(()=>switchView('agents'));
$('#islandTab').onclick=guard(()=>switchView('island'));
$('#usageTab').onclick=guard(()=>switchView('usage'));
$('#settingsTab').onclick=guard(()=>switchView('settings'));
$('#settingsClose').onclick=guard(e=>{e.stopPropagation();return closeSettings();});
// 侧栏左下角的全局设置入口：三个视图各有一个，共用同一段逻辑。
for(const b of document.querySelectorAll('.open-settings'))b.onclick=guard(()=>openSettings());
$('#agentSearch').oninput=renderAgents;
for(const b of document.querySelectorAll('#agentsWorkspace [data-agent-provider]'))b.onclick=guard(()=>setAgentProvider(b.dataset.agentProvider));
refreshAgentChrome();
$('#agentFinder').onclick=guard(()=>api('open',agentCodex()?{codexAgent:true}:{agent:true}));
$('#agentCopy').onclick=guard(async()=>{if(!agentSel)return;const v=agentCodex()?(agentSel.name||agentSel.id):agentSel.id;await navigator.clipboard.writeText(v);toast('已复制 '+(agentCodex()?'name':'ID'));});
$('#agentSave').onclick=guard(saveAgent);
$('#agentToggle').onclick=guard(toggleAgent);
$('#agentRename').onclick=guard(renameAgent);
$('#agentDelete').onclick=guard(deleteAgent);
$('#agentEditor').oninput=agentDirtyUI;
$('#agentReadView').onclick=()=>{if(agentDirty()){toast('请先保存修改后再阅读');return;}setAgentView('read');};
$('#agentEditView').onclick=()=>setAgentView('edit');
$('#agentSummarize').onclick=guard(async()=>{if(agentDirty()){toast('请先保存修改，再生成或切换阅读内容');return;}if(agentAIData?.summary?.complete&&agentAIFile===agentSel?.id){agentAISummaryExpanded=!agentAISummaryExpanded;setAgentView('read');}else await startAgentAI('summary');});
$('#agentSummaryToggle').onclick=guard(()=>{if(agentAIData?.summary?.complete&&agentAIFile===agentSel?.id){agentAISummaryExpanded=!agentAISummaryExpanded;renderAgentReading();}else return startAgentAI('summary');});
$('#agentTranslate').onclick=guard(async()=>{if(agentDirty()){toast('请先保存修改，再翻译');return;}if(agentAIBilingual){agentAIBilingual=false;renderAgentReading();}else await startAgentAI('translate');});
$('#agentTranslationRetry').onclick=guard(()=>startAgentAI('translate'));
$('#agentSummaryCopy').onclick=guard(async()=>{if(!agentAIData?.summary)return;await navigator.clipboard.writeText(agentAIData.summary.text);toast('已复制总结');});
$('#agentTranslationCopy').onclick=guard(async()=>{if(!agentAIData?.translation)return;await navigator.clipboard.writeText(agentAIData.blocks.map(b=>agentAIData.translation.segments[b.id]||(['code','rule'].includes(b.type)?b.text:'')).join('\n\n'));toast('已复制译文');});
$('#agentNew').onclick=()=>{$('#agentForm').reset();refreshAgentChrome();$('#agentDialog').showModal();$('#agentIdInput').focus();};
$('#agentCancel').onclick=()=>$('#agentDialog').close();
$('#agentForm').onsubmit=guard(async e=>{
 e.preventDefault();
 const id=$('#agentIdInput').value.trim();
 const r=await api(agentRoute('/create'),agentCodex()?{id,description:$('#agentDescInput').value}:{id,description:$('#agentDescInput').value,mode:$('#agentModeInput').value,color:$('#agentColorInput').value});
 $('#agentDialog').close();
 await loadAgents();
 const a=agentItems.find(x=>x.id===r.id);
 if(a)await openAgent(a);
 setAgentView('edit');
 toast('已创建 '+id+'，可继续完善定义');
});

// 通知岛：打开视图时订阅状态流，离开时断开；设置项写回 ~/.bobo/opencode.json。
let islandView='skills',islandStream=null,islandReady=false,islandState={sessions:[],settings:{},connected:false};
const ocLabels={working:'运行中',waiting:'等你回答',idle:'已结束',error:'已终止'};
const islandOn=s=>s.state==='working'||s.state==='waiting';
// 单个会话行（OpenCode 与 Codex 共用）：状态点 + 标题/来源 + 状态文字，点击跳到 Otty。
function sessionRow(s){
 const row=document.createElement('div');row.className='oc-item';row.dataset.state=s.state;row.dataset.source=s.source||'opencode';
 row.title=(s.title||s.name||'')+' · 点击跳到 Otty 标签页';
 row.onclick=()=>focusSession(s);
 const dot=document.createElement('span');dot.className='notch-dot';
 const body=document.createElement('div');body.className='oc-body';
 const strong=document.createElement('strong');strong.textContent=s.title||s.name||s.id;
 const small=document.createElement('small');small.textContent=[s.source==='codex'?'Codex':'OpenCode',s.name,s.detail||s.directory].filter(Boolean).join(' · ');
 body.append(strong,small);
 const st=document.createElement('span');st.className='oc-state';st.dataset.state=s.state;st.textContent=ocLabels[s.state]||s.state;
 row.append(dot,body,st);return row;
}
function renderSessionList(listEl,countEl,rows,emptyText){
 countEl.textContent=rows.length?(rows.filter(islandOn).length+' 个进行中 · 共 '+rows.length+' 个'):'';
 listEl.replaceChildren();
 if(!rows.length){const p=document.createElement('p');p.className='muted';p.textContent=emptyText;listEl.append(p);return;}
 for(const s of rows)listEl.append(sessionRow(s));
}
function renderIsland(){
 const {sessions=[],settings={},connected=false}=islandState;
 // 服务端把两个 Agent 的会话合并进 sessions，并按 source 区分；这里分栏展示。
 const oc=sessions.filter(s=>s.source!=='codex'),cx=sessions.filter(s=>s.source==='codex');
 $('#islandNavDot').dataset.state=connected?(oc[0]?.state||'idle'):'';
 $('#islandService').textContent=connected?'事件流已连接，OpenCode 换端口会自动重连':'未检测到正在运行的 OpenCode 服务，启动后会自动连上';
 $('#islandCodexDot').dataset.state=cx[0]?.state||'';
 // 顺序照搬服务端：最近发生状态变更的会话排在最上面（见 opencode.mjs / codex.mjs），这里不再按状态分组。
 renderSessionList($('#islandList'),$('#islandCount'),oc,'还没有会话记录');
 renderSessionList($('#codexList'),$('#codexCount'),cx,'最近没有 Codex 会话；Codex 运行时会自动出现在这里');
 if(!islandReady){islandReady=true;renderIslandSettings();}
}
// 通知岛左侧分类：通知岛设置（提醒 / 刘海面板 / 菜单栏与位置）与 Agent 连接（OpenCode / Codex，含各自会话列表）。
const islandPanes=['remind','notch','menubar','opencode','codex'];
function showIslandPane(name){
 const next=islandPanes.includes(name)?name:islandPanes[0];
 for(const p of document.querySelectorAll('#islandWorkspace [data-island-pane-content]'))p.hidden=p.dataset.islandPaneContent!==next;
 for(const b of document.querySelectorAll('#islandWorkspace [data-island-pane]'))b.setAttribute('aria-pressed',String(b.dataset.islandPane===next));
}
for(const b of document.querySelectorAll('#islandWorkspace [data-island-pane]'))b.onclick=()=>showIslandPane(b.dataset.islandPane);
// 开关沿用与技能启停同一套 switch 控件；每次提交完整设置，后端整体校验。
function islandSwitch(row,key,label,on){
 const cell=$(row);cell.querySelector('.switch')?.remove();
 cell.append(toggleSwitch(on,label,async value=>{
  islandState.settings=await api('opencode/settings',{...islandState.settings,[key]:value});
 }));
}
function renderIslandSettings(){
 const s=islandState.settings;
 islandSwitch('#rowNotify','notify','系统通知',s.notify!==false);
 islandSwitch('#rowSound','sound','提示音',s.sound!==false);
 islandSwitch('#rowNotch','notch','显示刘海面板',s.notch!==false);
 islandSwitch('#rowAutoExpand','autoExpand','需要回答或结束时自动展开',s.autoExpand!==false);
 islandSwitch('#rowHideWhenIdle','hideWhenIdle','没有活跃会话时隐藏',s.hideWhenIdle===true);
 // 刘海面板在哪块屏：默认跟随当前使用的应用（由原生判定），也可以固定到内置刘海屏或主屏。
 const modes=['auto','builtin','main'],select=$('#displaySelect');
 select.value=modes.includes(s.display)?s.display:'auto';
 select.onchange=guard(async()=>{
  islandState.settings=await api('opencode/settings',{...islandState.settings,display:select.value});
  toast('刘海面板显示位置：'+select.selectedOptions[0].textContent);
 });
 islandSwitch('#rowMenubar','menubar','显示状态栏图标',s.menubar===true);
 islandSwitch('#rowMovable','movable','刘海面板可移动',s.movable===true);
 $('#islandRows').value=String(s.rows||3);
}
async function islandLoop(){
 while(islandStream){
  try{
   const r=await fetch('/api/opencode/stream',{headers:{'x-bobo-token':token}});
   if(!r.ok)throw Error('状态流不可用');
   const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
   for(;;){
    const {value,done}=await reader.read();
    buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
    let end;
    while((end=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
     if(line.trim())try{islandState=JSON.parse(line);renderIsland();}catch{}
    }
    if(done)break;
   }
  }catch{}
  if(islandStream)await new Promise(r=>setTimeout(r,1500));
 }
}
function openIsland(){if(islandStream)return;islandStream=true;islandLoop();}
function islandClose(){islandStream=null;}
// 点击会话跳到 Otty 的对应标签页：由 bobo 服务调用 otty-cli 完成匹配与切换。
async function focusSession(s){
 try{await api('opencode/focus',{id:s.id,title:s.title||'',directory:s.directory||'',source:s.source||'opencode'});}catch(e){toast(e.message);}
}
$('#islandRows').onchange=guard(async()=>{islandState.settings=await api('opencode/settings',{...islandState.settings,rows:Number($('#islandRows').value)});});

// 用量：Codex（chatgpt.com 的订阅额度）与 OpenCode Go（本机数据库估算）两家，服务端把结果挂进状态流。
// 打开视图时拉一次最新值，之后每分钟刷新一次；关闭视图就停掉定时器。点击左侧来源会同时切到该分栏，
// 并把刘海胶囊的额度指示也切到这家（POST /api/usage/provider）。
let usageData=null,usageTimer=null;
const usagePanes=['codex','opencode'];
const usageProviderId=pane=>pane==='opencode'?'opencode-go':'codex';
const usagePaneFor=id=>id==='opencode-go'?'opencode':'codex';
const fmtPercent=v=>Number.isInteger(v)?String(v):v.toFixed(1);
// 金额：$0 显示 0；≥ 1 分保留两位（$0.50）；更小的零头保留四位（$0.0027），免得读成 0。
const money=v=>{if(!v)return '$0';return '$'+(v>=0.01?v.toFixed(2):v.toFixed(4));};
// 剩余越少越显眼：绿 / 橙 / 红，与刘海胶囊的环形指示同一套阈值。
const usageLevel=remaining=>remaining>=50?'ok':remaining>=20?'warn':'low';
function resetText(seconds){
 if(!seconds||seconds<=0)return '可重新计算';
 if(seconds<3600)return Math.max(1,Math.round(seconds/60))+' 分钟后重置';
 if(seconds<86400)return Math.floor(seconds/3600)+' 小时 '+Math.round(seconds%3600/60)+' 分后重置';
 return Math.floor(seconds/86400)+' 天后重置';
}
function showUsagePane(name){
 const next=usagePanes.includes(name)?name:usagePanes[0];
 for(const p of document.querySelectorAll('#usageWorkspace [data-usage-pane-content]'))p.hidden=p.dataset.usagePaneContent!==next;
 for(const b of document.querySelectorAll('#usageWorkspace [data-usage-pane]'))b.setAttribute('aria-pressed',String(b.dataset.usagePane===next));
}
for(const b of document.querySelectorAll('#usageWorkspace [data-usage-pane]'))b.onclick=guard(async()=>{
 showUsagePane(b.dataset.usagePane);
 usageData=await api('usage/provider',{id:usageProviderId(b.dataset.usagePane)});
 renderUsage();
});
function usageCard(w){
 const card=document.createElement('div');card.className='usage-card';card.dataset.level=usageLevel(w.remainingPercent);
 const head=document.createElement('div');head.className='usage-card-head';
 const title=document.createElement('span');title.textContent=w.label||'额度窗口';
 const remain=document.createElement('strong');remain.textContent='剩 '+fmtPercent(w.remainingPercent)+'%';
 head.append(title,remain);
 const meter=document.createElement('div');meter.className='meter';
 const fill=document.createElement('i');fill.style.width=Math.min(100,Math.max(0,w.usedPercent))+'%';meter.append(fill);
 const foot=document.createElement('div');foot.className='usage-card-foot';
 const limitTxt=w.limitUSD?'已用 '+money(w.usedUSD)+' / $'+w.limitUSD:'已用 '+fmtPercent(w.usedPercent)+'%';
 const used=document.createElement('span');used.textContent=limitTxt+(w.status&&w.status!=='ok'?' · 已限额':'');
 const reset=document.createElement('span');reset.textContent=resetText(w.resetInSec);
 foot.append(used,reset);
 card.append(head,meter,foot);
 return card;
}
// 每天一行：日期 + 条形 + 费用；模型行用 .model 网格（名称 + 费用 + 次数）。
function usageRow(label,{ratio,text,sub,cls}={}){
 const row=document.createElement('div');row.className='usage-day'+(cls?' '+cls:'');
 const name=document.createElement('span');name.className='name';name.textContent=label;row.append(name);
 if(ratio!==undefined){const bar=document.createElement('span');bar.className='bar';const fill=document.createElement('i');fill.style.width=Math.min(100,Math.max(0,ratio*100))+'%';bar.append(fill);row.append(bar);}
 const val=document.createElement('span');val.className='val';val.textContent=text;row.append(val);
 if(sub){const calls=document.createElement('span');calls.className='calls';calls.textContent=sub;row.append(calls);}
 return row;
}
function renderUsageWindows(selector,p){
 const box=$(selector);box.replaceChildren();
 const empty=text=>{const d=document.createElement('div');d.className='usage-empty';d.textContent=text;box.append(d);};
 if(!p){empty('正在读取…');return;}
 if(!p.available){empty(p.reason||'暂不可用');return;}
 if(!p.windows.length){empty('账号没有返回额度窗口。');return;}
 for(const w of p.windows)box.append(usageCard(w));
}
// 来源启停：只影响刘海胶囊的可选来源与切换循环，数据照常读取。
function usageSwitch(row,label,on,id){
 const cell=$(row);cell.querySelector('.switch')?.remove();
 cell.append(toggleSwitch(on,label,async value=>{usageData=await api('usage/enabled',{id,enabled:value});renderUsage();}));
}
function renderUsage(){
 const data=usageData;
 const byId=id=>data?.providers?.find(p=>p.id===id)||null;
 const codex=byId('codex'),local=byId('opencode-go');
 $('#usageState').textContent=!data?'读取中':data.available?'已连接':'暂不可用';
 $('#usageUpdated').textContent=data?.updatedAt?'更新于 '+new Date(data.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'每分钟刷新';
 $('#usageDotCodex').dataset.state=codex?.available?'idle':'';
 $('#usageDotOpencode').dataset.state=local?.available?'idle':'';
 usageSwitch('#rowUsageCodex','刘海胶囊可切换到此来源',codex?.enabled!==false,'codex');
 usageSwitch('#rowUsageOpencode','刘海胶囊可切换到此来源',local?.enabled!==false,'opencode-go');
 $('#usageKeyStatus').textContent=data?(local?.keySource==='manual'?'手动配置'+(local?.keyHint?'（尾号 '+local.keyHint+'）':''):local?.keySource==='env'?'环境变量 OPENCODE_API_KEY':local?.keySource==='auth'?'opencode 本机登录':'未配置（可退回本机估算）'):'读取中…';
 $('#usageKeyClear').disabled=local?.keySource!=='manual';
 renderUsageWindows('#usageCodexWindows',codex);
 renderUsageWindows('#usageOpencodeWindows',local);
 const codexBits=[];
 if(codex?.plan)codexBits.push('套餐：'+codex.plan);
 if(codex?.credits?.unlimited)codexBits.push('额度无上限（credits unlimited）');
 else if(codex?.credits?.hasCredits||codex?.credits?.balance)codexBits.push('Credits 余额 $'+String(codex.credits.balance));
 if(codex?.available&&!codex.windows.length)codexBits.push('这个套餐目前没有返回窗口额度');
 if(codex?.error)codexBits.push('⚠ '+codex.error);
 $('#usageCodexNote').textContent=codexBits.join('；')||'额度窗口由 ChatGPT 返回，重置时间以服务端为准。';
 // OpenCode Go：百分比来自官方用量接口（权威），每日花费/模型明细来自本机数据库（估算）。
 const keyLabel=local?.keySource==='manual'?'手动填写的 Key':local?.keySource==='env'?'环境变量 OPENCODE_API_KEY':local?.keySource==='auth'?'opencode 本机登录':'未配置';
 const localBits=[local?.source==='api'
  ?'额度百分比与重置时间来自 opencode.ai 用量接口（'+keyLabel+'）'
  :'额度按本机费用估算：5 小时 $12 / 本周 $30 / 账单月 $60，仅供参考'];
 if(local?.source==='api')localBits.push('每日花费与模型汇总来自本机 opencode.db（~/.local/share/opencode），只读、不联网');
 else localBits.push('数据来自 ~/.local/share/opencode/opencode.db 里 opencode-go 的调用费用，只读、不联网；实际额度以 opencode.ai 账单为准');
 if(local?.error)localBits.unshift('⚠ '+local.error);
 $('#usageOpencodeNote').textContent=localBits.join('；');
 // 只有本机数据才有历史：最近 30 天按天汇总 + 按模型汇总。
 const days=$('#usageDays');days.replaceChildren();
 const daily=local?.available?local.daily:[];
 if(!daily.length){const p=document.createElement('div');p.className='usage-day muted';p.textContent='最近 30 天没有用量记录';days.append(p);}
 const maxDay=Math.max(...daily.map(d=>d.costUSD),0);
 for(const d of [...daily].reverse()){
  const time=new Date(d.day+'T00:00:00'),weekday='周'+'日一二三四五六'[time.getDay()];
  days.append(usageRow(d.day.slice(5)+' '+weekday,{ratio:maxDay?d.costUSD/maxDay:0,text:money(d.costUSD)+' · '+d.calls+' 次'}));
 }
 const models=$('#usageModels');models.replaceChildren();
 const rows=local?.available?local.models:[];
 if(!rows.length){const p=document.createElement('div');p.className='usage-day muted';p.textContent='暂无模型用量';models.append(p);}
 for(const m of rows)models.append(usageRow(m.name,{text:money(m.costUSD),sub:m.calls+' 次',cls:'model'}));
}
async function loadUsage(){
 try{
  usageData=await api('usage?refresh=1');
  showUsagePane(usagePaneFor(usageData.selected));
  renderUsage();
 }catch(e){toast(e.message);}
}
$('#usageRefresh').onclick=guard(async()=>{$('#usageRefresh').disabled=true;try{await loadUsage();toast('已刷新额度');}finally{$('#usageRefresh').disabled=false;}});
// 手动 Key：保存前先让服务端调一次接口验证；清除后回退到环境变量 / opencode 本机登录。
$('#usageKeyForm').onsubmit=guard(async e=>{
 e.preventDefault();
 const key=$('#usageKey').value.trim();
 if(!key)return toast('请输入 API Key');
 $('#usageKeySave').disabled=true;
 try{
  const r=await api('usage/key',{key});
  usageData=r.snapshot||await api('usage');renderUsage();
  if(r.ok)$('#usageKey').value='';
  toast(r.message);
 }finally{$('#usageKeySave').disabled=false;}
});
$('#usageKeyClear').onclick=guard(async()=>{
 const r=await api('usage/key',{clear:true});
 usageData=r.snapshot||await api('usage');renderUsage();
 toast(r.message);
});
function openUsage(){if(usageTimer)return;loadUsage();usageTimer=setInterval(()=>guard(loadUsage)(),60000);}
function usageClose(){if(usageTimer){clearInterval(usageTimer);usageTimer=null;}}

guard(async()=>{await refresh(false,true);const first=$('#skills .skill-group');if(first)openFolder(first.dataset.group);const j=await api('job');if(j?.running){showConsole();await poll();}})();
