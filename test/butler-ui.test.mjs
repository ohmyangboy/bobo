import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('let butlerData='),end=source.indexOf('const ocLabels=',start);
assert.ok(start>=0&&end>start);
// 直接运行页面事件代码，用小 DOM 替身验证引用、草稿和分页状态；不访问真实 API/终端。
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.clientHeight=300;this._top=0;}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=value;}
 removeAttribute(key){delete this.attributes[key];}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 focus(){this.focused=true;}
 get scrollHeight(){return this.children.reduce((sum,node)=>sum+(node.tag==='article'?100:30),0);}
 get scrollTop(){return this._top;}
 set scrollTop(value){this._top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));}
 requestSubmit(){return this.onsubmit({preventDefault(){}});}
}
const message=i=>({id:'m'+i,role:'butler',projectId:'bobo',name:'bobo',text:'第 '+i+' 项构建通过，待验证。',at:Date.now()+i,summaryAt:1,source:'codex'});
function page(messages=Array.from({length:80},(_,i)=>message(i))){
 const nodes={},calls=[],notifications=[];let selection={isCollapsed:true},sequence=0;
 const data={enabled:true,status:'ready',message:'有新进展才更新',budget:{count:0},projects:[{id:'bobo'}],sourceErrors:{},messages};
 const context=vm.createContext({document:{createElement:tag=>new Element(tag)},window:{getSelection:()=>selection},navigator:{clipboard:{writeText:async()=>{}}},crypto:{randomUUID:()=> 'request-'+(++sequence)},$:id=>nodes[id]??=new Element(),guard:fn=>fn,toast:text=>notifications.push(text),switchView:async()=>{},showSettingsPane(){},button:(text,cls,onclick)=>{const e=new Element('button');e.textContent=text;e.className=cls;e.onclick=onclick;return e;},api:async(route,input)=>{calls.push({route,input});return route==='butler'?data:{ok:true};}});
 vm.runInContext(source.slice(start,end),context);
 const run=code=>vm.runInContext(code,context),render=next=>{context.next=next;run('renderButler(next)');};
 render(data);
 return {nodes,calls,data,context,run,render,notifications,setSelection:value=>{selection=value;}};
}
test('消息首屏仅 20 个节点，历史按需加载到 80，AI 修订复用节点且不发出请求',()=>{
 const p=page(),feed=p.nodes['#butlerProjects'];
 assert.equal(feed.children.filter(n=>n.tag==='article').length,20);assert.equal(p.run('butlerMessageNodes.size'),20);assert.equal(feed.scrollTop,feed.scrollHeight-feed.clientHeight);
 feed.scrollTop=0;feed.children[0].onclick();assert.equal(feed.children.filter(n=>n.tag==='article').length,40);
 assert.equal(feed.scrollTop,2000,'加载历史保留原阅读位置');
 feed.children[0].onclick();feed.children[0].onclick();assert.equal(feed.children.length,80);assert.equal(p.run('butlerMessageNodes.size'),80);
 const old=feed.children.at(-1);p.data.messages.at(-1).text='本轮验证完成。';p.render(p.data);
 assert.equal(feed.children.at(-1),old);assert.equal(old.children[1].children.find(n=>n.className==='butler-brief').textContent,'本轮验证完成。');assert.equal(p.calls.length,0);
});
test('浏览历史时新消息提示未读；旧用户消息更新不会拉回底部',()=>{
 const p=page(),feed=p.nodes['#butlerProjects'];feed.scrollTop=0;
 p.data.messages=p.data.messages.slice(1).concat(message(80));p.render(p.data);
 assert.equal(feed.scrollTop,0);assert.equal(p.nodes['#butlerNewMessages'].hidden,false);assert.equal(p.run('butlerUnread'),1);
 p.nodes['#butlerNewMessages'].onclick();assert.equal(feed.scrollTop,feed.scrollHeight-feed.clientHeight);assert.equal(p.run('butlerUnread'),0);
 p.data.messages=p.data.messages.slice(1).concat({...message(81),role:'user',delivery:'sent',text:'继续验证'});p.render(p.data);feed.scrollTop=0;
 p.data.messages[0].text='修订旧摘要。';p.render(p.data);assert.equal(feed.scrollTop,0,'只有新发送的用户消息才自动跟随');
});
test('头像只跳转原对话，气泡可引用选中文字；引用回复发送同一消息 ID',async()=>{
 const p=page([message(1)]),row=p.nodes['#butlerProjects'].children[0],body=row.children[1],brief=body.children.find(n=>n.className==='butler-brief');
 await row.children[0].onclick();assert.equal(p.calls.at(-1).route,'butler/focus');assert.equal(p.calls.at(-1).input.id,'m1');assert.equal(p.run('butlerReplyTo'),null);
 p.setSelection({isCollapsed:false,anchorNode:brief,focusNode:brief,toString:()=> '待验证'});body.onclick();
 assert.equal(p.nodes['#butlerQuoteText'].textContent,'待验证');assert.equal(p.nodes['#butlerReplyText'].focused,true);
 p.nodes['#butlerReplyText'].value='继续验证';p.context.api=async(route,input)=>{p.calls.push({route,input});return route==='butler'?p.data:{status:'sent',target:{name:'bobo',source:'codex'}};};
 await p.nodes['#butlerComposer'].requestSubmit();
 const sent=p.calls.find(c=>c.route==='butler/reply');assert.equal(sent.input.replyTo,'m1');assert.equal(sent.input.quote,'待验证');assert.equal(sent.input.text,'继续验证');
 assert.equal(p.nodes['#butlerReplyText'].value,'');assert.equal(p.nodes['#butlerQuote'].hidden,true);
});
test('原 Agent 指令映射到对应气泡，可以选中引用，展示更新不新增请求',()=>{
 const m={...message(1),request:'发布新版本\n同步 Homebrew tap\n验证下载\n超出的内容省略展示'};
 const p=page([m]),body=p.nodes['#butlerProjects'].children[0].children[1],original=body.children.find(n=>n.className==='butler-original-request');
 assert.equal(original.hidden,false);assert.equal(original.textContent,m.request);assert.equal(p.calls.length,0);
 p.setSelection({isCollapsed:false,anchorNode:original,focusNode:original,toString:()=> '同步 Homebrew tap'});body.onclick();
 assert.equal(p.nodes['#butlerQuoteText'].textContent,'同步 Homebrew tap');assert.equal(p.run('butlerReplyTo.id'),'m1');
 p.data.messages[0].request='补齐原始请求';p.render(p.data);assert.equal(original.textContent,'补齐原始请求');assert.equal(p.calls.length,0);
});
test('直接发送不明确时先选择会话；失败保留草稿，送达不明不能自动重发',async()=>{
 const p=page([message(1)]);p.nodes['#butlerReplyText'].value='继续处理';
 p.context.api=async(route,input)=>{p.calls.push({route,input});return route==='butler'?p.data:{status:'choose',reason:'请选择会话',candidates:[{id:'codex:one',name:'bobo',source:'codex',title:'管家开发'}]};};
 await p.nodes['#butlerComposer'].requestSubmit();assert.equal(p.nodes['#butlerTargets'].hidden,false);assert.equal(p.nodes['#butlerReplyText'].value,'继续处理');
 p.nodes['#butlerTargets'].children[0].onclick();assert.equal(p.calls.length,1,'选中候选不提前提交');
 p.context.api=async(route,input)=>{p.calls.push({route,input});return route==='butler'?p.data:{status:'failed',retryable:false,reason:'送达状态未确认'};};
 await p.nodes['#butlerComposer'].requestSubmit();assert.equal(p.calls.findLast(c=>c.route==='butler/reply').input.targetId,'codex:one');
 assert.equal(p.nodes['#butlerReplyText'].value,'继续处理');assert.equal(p.nodes['#butlerSend'].disabled,true);assert.equal(p.nodes['#butlerRetry'].hidden,false);
 const count=p.calls.length;await p.nodes['#butlerComposer'].requestSubmit();assert.equal(p.calls.length,count,'不确定送达时不重复投递');
 p.nodes['#butlerReplyText'].value='重新修改过的指令';p.nodes['#butlerReplyText'].oninput();assert.equal(p.nodes['#butlerSend'].disabled,false);
});
