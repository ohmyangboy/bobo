import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {cursorSnapshot,grokSnapshot} from '../src/usage.mjs';

const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
const slice=(start,end)=>{const from=source.indexOf(start),to=source.indexOf(end,from);assert.ok(from>=0&&to>from);return source.slice(from,to);};
test('Cursor / Grok Bot：源码与功能文档不保留旧 CLI 额度路径或文案',async()=>{
 const src=new URL('../src/',import.meta.url),files=(await fs.readdir(src)).filter(name=>name.endsWith('.mjs')).map(name=>new URL(name,src));
 files.push(...['public/app.js','public/index.html','docs/features.md','AGENTS.md','CHANGELOG.md'].map(name=>new URL('../'+name,import.meta.url)));
 for(const file of files)assert.doesNotMatch(await fs.readFile(file,'utf8'),/cli-chat-proxy|GROK_HOME|grok login|grok models|SuperGrok|\.grok\//,file.pathname);
});
class Element{
 constructor(){this.children=[];this.textContent='';this.dataset={};this.style={};this.classList={toggle(){}};}
 append(...children){for(const c of children){if(c.parent)c.remove();c.parent=this;this.children.push(c);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
 replaceChildren(...children){this.children=[];this.append(...children);}
 querySelector(selector){return selector==='.switch'?this.children.find(c=>c.className==='switch'):this.children.find(c=>c.dataset.islandPane===/quota-[\w-]+/.exec(selector)?.[0]);}
 querySelectorAll(){return this.children;}
 setAttribute(key,value){this[key]=value;}
}
const flatten=node=>node.textContent+' '+node.children.map(flatten).join(' ');
function page(providers){
 const nodes={},status={},calls=[],panes=[],buttons=[];
 for(const id of ['cursor','grok']){
  const pane=new Element();pane.dataset.islandPaneContent='quota-'+id;panes.push(pane);
  const button=new Element();button.dataset.islandPane='quota-'+id;buttons.push(button);
 }
 const context=vm.createContext({usageData:{providers,notifyReset:true},usageSidebarOrder:'',usagePaneFor:id=>id==='opencode-go'?'opencode':id,
  $:id=>nodes[id]??=new Element(),setSideStatus:(id,state,text)=>status[id]={state,text},
  document:{body:{dataset:{}},createElement:()=>new Element(),querySelectorAll:selector=>selector.endsWith('[data-island-pane-content]')?panes:selector.endsWith('[data-island-pane]')?buttons:[]},
  requestAnimationFrame:fn=>fn(),providerGlyph:()=>new Element(),observeSeg(){},renderDeepSeekBalance(){},toast(){},
  usageLevel:n=>n>=50?'ok':n>=20?'warn':'low',fmtPercent:String,money:String,resetText:n=>n+' 秒后重置',Date,
  toggleSwitch:(on,label,change)=>Object.assign(new Element(),{className:'switch',on,label,change}),
  api:async(route,body)=>{calls.push({route,body});if(route==='usage/enabled')context.usageData.providers=context.usageData.providers.map(p=>p.id===body.id?{...p,enabled:body.enabled}:p);return context.usageData;}
 });
 vm.runInContext(slice('const islandPanes=','\nfor(const b of document.querySelectorAll(\'#islandWorkspace [data-island-pane]\'))'),context);
 vm.runInContext(slice('const quotaSymbols=','let quotaDragId='),context);
 vm.runInContext(slice('function renderQuotaSide(','\n}\n')+'\n}',context);
 vm.runInContext(slice('function usageCard(','async function loadUsage('),context);
 nodes['#quotaNav']=new Element();nodes['#quotaNav'].append(...buttons);
 return {nodes,status,calls,panes,buttons,context,run:code=>vm.runInContext(code,context)};
}
const snapshots=()=>[
 {...grokSnapshot({usagePercent:5,includedLimitZero:false},1),enabled:true,keySource:'grok-bot'},
 {...cursorSnapshot({planUsage:{autoPercentUsed:12.5,apiPercentUsed:40,totalPercentUsed:20}},1),enabled:true,keySource:'keychain'}
];
test('额度 UI：Cursor / Grok 分栏可导航，窗口与补充明细按真实快照渲染，启停写对应 id',async()=>{
 const p=page(snapshots());p.run('renderUsage();showIslandPane("quota-cursor")');
 assert.equal(p.context.document.body.dataset.islandPane,'quota-cursor');assert.equal(p.context.document.body.dataset.islandKind,'quota');
 assert.equal(p.panes[0].hidden,false);assert.equal(p.panes[1].hidden,true);
 assert.match(flatten(p.nodes['#usageCursorWindows']),/Cursor Models.*剩 87.5%.*Other Models.*剩 60%.*Total.*剩 80%/);
 assert.equal(p.nodes['#usageCursorWindows'].children[2].dataset.aside,'true');
 assert.match(flatten(p.nodes['#usageGrokWindows']),/Grok Bot.*剩 95%/);
 assert.match(p.nodes['#usageCursorNote'].textContent,/钥匙串/);assert.match(p.nodes['#usageGrokNote'].textContent,/Grok Bot 本机登录/);
 assert.match(html,/<h2>Grok Bot<\/h2>/);assert.doesNotMatch(html,/SuperGrok|Grok CLI/);assert.equal(p.nodes['#usageGrokWindows'].children.length,1);
 assert.equal(p.status['quota-grok'].text,'已连接');
 await p.nodes['#rowUsageGrok'].querySelector('.switch').change(false);
 assert.equal(p.calls[0].route,'usage/enabled');assert.equal(p.calls[0].body.id,'grok');assert.equal(p.calls[0].body.enabled,false);assert.equal(p.status['quota-grok'].text,'已关闭');
 await p.nodes['#rowUsageCursor'].querySelector('.switch').change(false);assert.equal(p.calls[1].body.id,'cursor');
 p.run('showIslandPane("quota-grok")');assert.equal(p.panes[1].hidden,false);
});
test('额度 UI：来源图标与侧栏按快照顺序排列，失败原因和上次数据同时可见',async()=>{
 const png=await fs.readFile(new URL('../public/provider-grok.png',import.meta.url));
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a','Grok Bot 头像必须是实际 PNG 资源');
 const rows=snapshots();rows[0].error='网络拒绝';rows[1]={...rows[1],available:false,reason:'请运行 cursor-agent login'};
 const p=page(rows);p.run('renderUsage();renderQuotaOrder(usageData)');
 assert.deepEqual(p.nodes['#quotaNav'].children.map(b=>b.dataset.islandPane),['quota-grok','quota-cursor']);
 assert.deepEqual(p.nodes['#quotaOrderList'].children.map(b=>b.dataset.provider),['grok','cursor']);
 assert.equal(p.nodes['#quotaOrderList'].children[1].dataset.state,'off');
 assert.match(flatten(p.nodes['#usageGrokWindows']),/Grok Bot.*95%/);assert.match(p.nodes['#usageGrokNote'].textContent,/网络拒绝/);
 assert.match(flatten(p.nodes['#usageCursorWindows']),/cursor-agent login/);assert.equal(p.status['quota-cursor'].text,'未连接');
 for(const id of ['cursor','grok']){
  assert.ok(html.includes('data-island-pane="quota-'+id+'" draggable="true"'));
  assert.ok(html.includes('data-island-pane-content="quota-'+id+'"'));
  assert.ok(html.includes('id="provider-'+id+'"'));assert.equal(p.run('quotaSymbols.'+id),id==='grok'?'/provider-grok.png':'provider-'+id);
 }
});
