import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installTodoPage} from '../public/todo.js';

class Element{
 constructor(tag=''){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.dataset={};this.checked=false;this.open=false;this.scrollTop=0;this.attributes={};}
 append(...children){for(const child of children){child.remove?.();child.parentNode=this;this.children.push(child);}}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}}
 contains(child){for(let current=child;current;current=current.parentNode)if(current===this)return true;return false;}
 replaceChildren(...children){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...children);}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return this.children.find(el=>el.className?.split(' ').includes(selector.slice(1)))||null;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 focus(){this.focused=true;}
 requestSubmit(){this.onsubmit?.({preventDefault(){}});}
}
function page(native=true){
 const nodes=new Map(),sent=[],events=new Map();
 const doc={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);},createElement(tag){return new Element(tag);},addEventListener(name,callback){events.set(name,callback);}};
 const status=doc.querySelector('[data-side-status="todo"]');status.querySelector=selector=>doc.querySelector('status '+selector);
 const host=native?{webkit:{messageHandlers:{boboTodo:{postMessage(body){sent.push(body);}}}}}:{};
 const controller=installTodoPage(doc,host);
 return {nodes,host,sent,controller,$:selector=>doc.querySelector(selector),clickOutside(){events.get('click')?.({target:new Element()});}};
}
const data=()=>({enabled:true,authorization:'allowed',lists:[{id:'inbox',title:'收件箱'}],defaultList:'inbox',columns:[{bucket:'today',items:[{id:'real-id',title:'<img src=x onerror=alert(1)>',dateText:'今天',list:'收件箱',notes:'备注',priority:1,date:'2026-10-30',time:'',listID:'inbox',url:'https://example.com',editable:true}]},{bucket:'later',items:[]},{bucket:'week',items:[]}]});
test('Todo 浏览器模式明确提示原生 App，不能伪造连接或发送写入',()=>{
 const p=page(false);assert.match(p.$('#todoStatus').textContent,/macOS bobo App/);
 assert.equal(p.$('#todoForm').hidden,true);assert.equal(p.$('#todoOpen').disabled,true);assert.equal(p.$('#todoConnect').hidden,true);
 p.$('#todoConnect').onclick();assert.deepEqual(p.sent,[]);
});
test('tobo 三列固定顺序，点击原位编辑，两个打开入口各自独立',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 assert.deepEqual(p.$('#todoBoard').children.map(c=>c.dataset.bucket),['today','week','later']);
 const item=p.$('#todoBoard').children[0].children[1].children[0];
 assert.equal(item.children[1].children[0].textContent,'<img src=x onerror=alert(1)>');
 item.children[1].onclick();assert.equal(p.$('#todoComposer').hidden,false);assert.equal(p.$('#todoComposer').parentNode,item);assert.equal(p.$('#todoNotes').value,'备注');assert.equal(p.$('#todoDetail').open,false);
 assert.deepEqual(p.sent,[{action:'get'}]);
 p.$('#todoOpenTobo').onclick();assert.deepEqual(p.sent.at(-1),{action:'openTobo'});
 p.$('#todoOpen').onclick();assert.deepEqual(p.sent.at(-1),{action:'openSystem',id:'real-id'});
 p.host.__boboTodoOpen('real-id');assert.equal(p.$('#todoComposer').parentNode,item);
 p.$('#todoCancel').onclick();p.$('#todoOpen').onclick();assert.deepEqual(p.sent.at(-1),{action:'openSystem'});
});
test('Todo 点击原位展开输入；回车提交去重、失败保留输入、成功收缩',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 p.$('#todoQuickTitle').value='  真实待办  ';p.$('#todoQuickBucket').value='today';
 p.$('#todoQuickTitle').onfocus();
 assert.equal(p.$('#todoComposer').hidden,false);assert.equal(p.$('#todoBucket').value,'today');assert.equal(p.$('#todoTitle').focused,true);
 p.$('#todoDate').value='2026-10-30';p.$('#todoNotes').value='备注';p.$('#todoURL').value='https://example.com';p.$('#todoTime').value='09:30';p.$('#todoPriority').value='1';
 const submit=()=>p.$('#todoForm').onsubmit({preventDefault(){}});submit();submit();
 assert.deepEqual(p.sent.filter(s=>s.action==='create'),[{action:'create',title:'真实待办',date:'2026-10-30',time:'09:30',listID:'',bucket:'today',notes:'备注',url:'https://example.com',priority:1,alarm:''}]);
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'  真实待办  ');assert.equal(p.$('#todoCreate').disabled,false);assert.equal(p.$('#todoComposer').hidden,false);
 submit();p.host.__boboTodoCreated(true);assert.equal(p.$('#todoTitle').value,'');assert.equal(p.$('#todoDate').value,'');assert.equal(p.$('#todoNotes').value,'');assert.equal(p.$('#todoComposer').hidden,true);
 for(const [index,bucket] of ['today','week','later'].entries()){
  p.$('#todoBoard').children[index].children[0].children[2].onclick();assert.equal(p.$('#todoBucket').value,bucket);
 }
});
test('Todo 列保留所有任务，刷新不重建未变列表，更新保留列滚动位置',()=>{
 const p=page(),snapshot=data();snapshot.columns[0].items=Array.from({length:40},(_,i)=>({...snapshot.columns[0].items[0],id:String(i)}));
 p.host.__boboTodoReceive(snapshot);const list=p.$('#todoBoard').children[0].children[1];
 assert.equal(list.children.length,40);list.scrollTop=380;
 p.host.__boboTodoReceive({...snapshot,loading:true});assert.equal(p.$('#todoBoard').children[0].children[1],list);
 const next=structuredClone(snapshot);next.columns[0].items.push({id:'new',title:'新增'});p.host.__boboTodoReceive(next);
 assert.equal(p.$('#todoBoard').children[0].children[1].scrollTop,380);assert.equal(p.$('#todoBoard').children[0].children[1].children.length,41);
});
test('tobo 新建默认今日与系统默认列表，不继承上次编辑或新建的项目列表',()=>{
 const p=page(),snapshot=data();snapshot.lists.push({id:'project',title:'项目'});p.host.__boboTodoReceive(snapshot);
 p.host.__boboTodoOpen('real-id');assert.equal(p.$('#todoList').value,'inbox');
 p.$('#todoCancel').onclick();p.$('#todoNew').onclick();
 const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 assert.equal(p.$('#todoBucket').value,'today');assert.equal(p.$('#todoDate').value,today);assert.equal(p.$('#todoList').value,'');
 p.$('#todoList').value='project';p.$('#todoCancel').onclick();p.$('#todoNew').onclick();assert.equal(p.$('#todoList').value,'');
 p.$('#todoTitle').value='默认任务';p.$('#todoForm').onsubmit({preventDefault(){}});
 assert.equal(p.sent.at(-1).bucket,'today');assert.equal(p.sent.at(-1).date,today);assert.equal(p.sent.at(-1).listID,'');
});
test('Todo 快速输入回车直接添加，不需要二次确认；取消后恢复收缩输入',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 assert.equal(p.$('#todoComposer').hidden,true);
 p.$('#todoQuickBucket').value='later';p.$('#todoQuickTitle').value='直接添加';
 p.$('#todoQuickForm').onsubmit({preventDefault(){}});
 assert.equal(p.sent.at(-1).action,'create');assert.equal(p.sent.at(-1).title,'直接添加');assert.equal(p.sent.at(-1).date,'');
 p.host.__boboTodoCreated(true);assert.equal(p.$('#todoComposer').hidden,true);assert.equal(p.$('#todoQuickForm').hidden,false);
 p.$('#todoQuickTitle').onfocus();assert.equal(p.$('#todoComposer').hidden,false);assert.equal(p.$('#todoQuickForm').hidden,true);
 p.$('#todoComposer').onkeydown({key:'Escape'});assert.equal(p.$('#todoComposer').hidden,true);assert.equal(p.$('#todoQuickForm').hidden,false);
});
test('Todo 拒绝权限、关闭或撤权时隐藏数据并关闭详情与创建',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.$('#todoNew').onclick();p.host.__boboTodoOpen('real-id');
 p.host.__boboTodoReceive({enabled:true,authorization:'denied',columns:[]});
 assert.equal(p.$('#todoPermissionSettings').hidden,false);assert.equal(p.$('#todoBoard').hidden,true);assert.equal(p.$('#todoForm').hidden,true);
 assert.equal(p.$('#todoComposer').hidden,true);assert.equal(p.$('#todoDetail').open,false);assert.match(p.$('#todoStatus').textContent,/隐私与安全性/);
 p.host.__boboTodoReceive({...data(),enabled:false});assert.equal(p.$('#todoBoard').hidden,true);
 p.$('#todoEnabled').onchange({target:{checked:false}});assert.deepEqual(p.sent.at(-1),{action:'enabled',enabled:false});
});

test('tobo 番茄专注：独立启动、设置回读与范围校验，浏览器模式禁用原生控制',()=>{
 const p=page();p.host.__boboTodoReceive({...data(),focusSettings:{minutes:45,notify:false}});
 p.host.__boboTodoFocusSettings();assert.equal(p.$('#todoSettings').open,true);assert.equal(p.$('#todoFocusMinutes').focused,true);
 assert.equal(p.$('#todoFocusMinutes').value,'45');assert.equal(p.$('#todoFocusNotify').checked,false);
 p.$('#todoFocusToggle').onclick();assert.deepEqual(p.sent.at(-1),{action:'focusToggle'});
 p.$('#todoFocusMinutes').value='30';p.$('#todoFocusMinutes').onchange();
 assert.deepEqual(p.sent.at(-1),{action:'focusSettings',minutes:30,breakMinutes:5,notify:false,systemNotify:false,sound:false});
 const count=p.sent.length;p.$('#todoFocusMinutes').value='0';p.$('#todoFocusMinutes').onchange();
 assert.equal(p.sent.length,count);assert.equal(p.$('#todoFocusMinutes').value,'45');
 p.host.__boboTodoReceive({...data(),focusSettings:{minutes:30,notify:true},focus:{startedAt:1000,endsAt:2800}});
 assert.equal(p.$('#todoFocusToggle').attributes['aria-pressed'],'true');assert.match(p.$('#todoFocusStatus').textContent,/30 分钟/);
 const browser=page(false);assert.equal(browser.$('#todoFocusToggle').disabled,true);
});

test('tobo 休息默认五分钟，设置回读及校验保存保留其他番茄设置',()=>{
 const p=page();p.host.__boboTodoReceive({...data(),focusSettings:{minutes:25,notify:true}});
 assert.equal(p.$('#todoBreakMinutes').value,'5');assert.equal(p.$('#todoBreakMinutes').disabled,false);
 p.$('#todoBreakMinutes').value='10';p.$('#todoBreakMinutes').onchange();assert.deepEqual(p.sent.at(-1),{action:'focusSettings',minutes:25,breakMinutes:10,notify:true,systemNotify:true,sound:true});
 p.host.__boboTodoReceive({...data(),focusSettings:{minutes:40,breakMinutes:10,notify:false,systemNotify:false,sound:false}});
 assert.equal(p.$('#todoBreakMinutes').value,'10');
 p.$('#todoFocusMinutes').value='30';p.$('#todoFocusMinutes').onchange();assert.deepEqual(p.sent.at(-1),{action:'focusSettings',minutes:30,breakMinutes:10,notify:false,systemNotify:false,sound:false});
 const count=p.sent.length;for(const value of ['0','61','1.5','']){
  p.$('#todoBreakMinutes').value=value;p.$('#todoBreakMinutes').onchange();assert.equal(p.sent.length,count);assert.equal(p.$('#todoBreakMinutes').value,'10');assert.equal(p.$('#todoFocusStatus').textContent,'休息时长应为 1–60 分钟');
 }
 for(const value of ['1','60']){p.$('#todoBreakMinutes').value=value;p.$('#todoBreakMinutes').onchange();assert.equal(p.sent.at(-1).breakMinutes,Number(value));}
 assert.equal(page(false).$('#todoBreakMinutes').disabled,true);
});

test('tobo 番茄区分专注休息暂停，显示今日及累计完成数',()=>{
 const p=page(),settings={minutes:25,breakMinutes:5,notify:true};
 p.host.__boboTodoReceive({...data(),focusSettings:settings});
 assert.equal(p.$('#todoFocusCompleted').textContent,'今日完成 0 个 · 累计完成 0 个');assert.equal(p.$('#todoFocusStop').hidden,true);
 p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:1000,endsAt:2500,phase:'focus',pausedRemaining:null},focusCompletedToday:2,focusCompleted:12});
 assert.match(p.$('#todoFocusStatus').textContent,/正在专注，本轮 25 分钟；结束后休息 5 分钟/);assert.equal(p.$('#todoFocusToggle').attributes['aria-label'],'暂停番茄专注');assert.equal(p.$('#todoFocusCompleted').textContent,'今日完成 2 个 · 累计完成 12 个');assert.equal(p.$('#todoFocusStop').hidden,false);
 p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:2500,endsAt:2800,phase:'rest',pausedRemaining:null}});
 assert.match(p.$('#todoFocusStatus').textContent,/正在休息，本轮 5 分钟；结束后等待手动开始下一轮专注/);assert.equal(p.$('#todoFocusToggle').attributes['aria-label'],'暂停番茄休息');
 p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:2500,endsAt:2800,phase:'rest',pausedRemaining:125}});
 assert.equal(p.$('#todoFocusStatus').textContent,'休息已暂停，剩余 3 分钟');assert.equal(p.$('#todoFocusToggle').attributes['aria-label'],'继续番茄休息');
 p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:1000,endsAt:2500,phase:'focus',pausedRemaining:0}});
 assert.equal(p.$('#todoFocusStatus').textContent,'专注已暂停，剩余 0 分钟');assert.equal(p.$('#todoFocusToggle').attributes['aria-label'],'继续番茄专注');
 p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:2800,endsAt:2800,phase:'ready'}});
 assert.equal(p.$('#todoFocusToggle').attributes['aria-label'],'开始下一轮番茄专注');assert.match(p.$('#todoFocusStatus').textContent,/点击番茄按钮开始下一轮/);
 const count=p.sent.length;p.host.__boboTodoReceive({...data(),focusSettings:settings,focus:{startedAt:2800,endsAt:2800,phase:'ready'}});
 assert.equal(p.sent.length,count,'刷新待开始状态不能自动发送启动请求');
 p.$('#todoFocusToggle').onclick();assert.deepEqual(p.sent.at(-1),{action:'focusToggle'});
});

test('tobo 到点提醒的通知岛、系统通知与声音可独立保存，旧关闭配置保持静默',()=>{
 const p=page();p.host.__boboTodoReceive({...data(),focusSettings:{minutes:25,breakMinutes:5,notify:false}});
 assert.equal(p.$('#todoFocusSystemNotify').checked,false);assert.equal(p.$('#todoFocusSound').checked,false);
 p.$('#todoFocusSystemNotify').checked=true;p.$('#todoFocusSystemNotify').onchange();
 assert.deepEqual(p.sent.at(-1),{action:'focusSettings',minutes:25,breakMinutes:5,notify:false,systemNotify:true,sound:false});
 p.$('#todoFocusSound').checked=true;p.$('#todoFocusSound').onchange();
 assert.deepEqual(p.sent.at(-1),{action:'focusSettings',minutes:25,breakMinutes:5,notify:false,systemNotify:true,sound:true});
 p.host.__boboTodoReceive({...data(),focusSettings:{minutes:25,breakMinutes:5,notify:true,systemNotify:false,sound:true}});
 assert.equal(p.$('#todoFocusNotify').checked,true);assert.equal(p.$('#todoFocusSystemNotify').checked,false);assert.equal(p.$('#todoFocusSound').checked,true);
 const browser=page(false);assert.equal(browser.$('#todoFocusSystemNotify').disabled,true);assert.equal(browser.$('#todoFocusSound').disabled,true);
});

test('tobo 番茄单击暂停继续，右键或明确按钮结束，仅活动时可结束',()=>{
 const p=page();let prevented=0;const context=()=>p.$('#todoFocusToggle').oncontextmenu({preventDefault(){prevented++;}});
 p.host.__boboTodoReceive(data());const count=p.sent.length;context();p.$('#todoFocusStop').onclick();assert.equal(p.sent.length,count);assert.equal(prevented,1);assert.equal(p.$('#todoFocusStop').disabled,true);
 p.host.__boboTodoReceive({...data(),focus:{startedAt:1000,endsAt:2500,phase:'focus',pausedRemaining:null}});
 p.$('#todoFocusToggle').onclick();assert.deepEqual(p.sent.at(-1),{action:'focusToggle'});context();assert.deepEqual(p.sent.at(-1),{action:'focusStop'});assert.equal(prevented,2);
 p.host.__boboTodoReceive({...data(),focus:{startedAt:1000,endsAt:2500,phase:'focus',pausedRemaining:60}});
 p.$('#todoFocusToggle').onclick();assert.deepEqual(p.sent.at(-1),{action:'focusToggle'});assert.equal(p.$('#todoFocusStop').disabled,false);p.$('#todoFocusStop').onclick();assert.deepEqual(p.sent.at(-1),{action:'focusStop'});
 p.host.__boboTodoReceive(data());assert.equal(p.$('#todoFocusStop').hidden,true);
});

test('Todo 编辑带回系统字段，保存失败保留草稿，完成与已完成切换独立写回',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.host.__boboTodoOpen('real-id');
 assert.equal(p.$('#todoComposer').hidden,false);assert.equal(p.$('#todoDetail').open,false);
 assert.equal(p.$('#todoDate').value,'2026-10-30');assert.equal(p.$('#todoNotes').value,'备注');assert.equal(p.$('#todoURL').value,'https://example.com');
 p.$('#todoTitle').value='修改标题';p.$('#todoDate').value='';p.$('#todoDate').onchange();
 assert.equal(p.$('#todoTime').disabled,true);
 p.$('#todoForm').onsubmit({preventDefault(){}});
 assert.equal(p.sent.at(-1).action,'update');assert.equal(p.sent.at(-1).id,'real-id');assert.equal(p.sent.at(-1).date,'');
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'修改标题');
 p.$('#todoShowCompleted').onchange({target:{checked:true}});assert.deepEqual(p.sent.at(-1),{action:'showCompleted',show:true});
 const card=p.$('#todoBoard').children[0].children[1].children[0];card.children[0].onclick();
 assert.equal(p.sent.at(-1).action,'update','完成前先保存行内改动');p.host.__boboTodoCreated(true);
 assert.deepEqual(p.sent.at(-1),{action:'complete',id:'real-id',completed:true});
});
test('tobo 行内切换先保存，失败保留当前行；数据刷新保留草稿，点击空白保存',()=>{
 const p=page(),snapshot=data();snapshot.columns[0].items.push({...snapshot.columns[0].items[0],id:'second',title:'第二项'});p.host.__boboTodoReceive(snapshot);
 const rows=p.$('#todoBoard').children[0].children[1].children;
 rows[0].children[1].onclick();p.$('#todoTitle').value='修改第一项';rows[1].children[1].onclick();
 assert.equal(p.sent.at(-1).action,'update');assert.equal(p.sent.at(-1).id,'real-id');assert.equal(p.$('#todoComposer').parentNode,rows[0]);
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'修改第一项');assert.equal(p.$('#todoComposer').parentNode,rows[0]);
 rows[1].children[1].onclick();p.host.__boboTodoCreated(true);assert.equal(p.$('#todoTitle').value,'第二项');assert.equal(p.$('#todoComposer').parentNode,rows[1]);
 p.$('#todoTitle').value='第二项草稿';const next=structuredClone(snapshot);next.columns[0].items[0].notes='外部更新';p.host.__boboTodoReceive(next);
 assert.equal(p.$('#todoTitle').value,'第二项草稿');assert.equal(p.$('#todoComposer').parentNode,p.$('#todoBoard').children[0].children[1].children[1]);
 p.clickOutside();assert.equal(p.sent.at(-1).id,'second');assert.equal(p.sent.at(-1).title,'第二项草稿');p.host.__boboTodoCreated(true);assert.equal(p.$('#todoComposer').hidden,true);
});
test('tobo 只读事项仅查看，不能进入行内编辑或写回',()=>{
 const p=page(),snapshot=data();snapshot.columns[0].items[0].editable=false;p.host.__boboTodoReceive(snapshot);
 p.host.__boboTodoOpen('real-id');assert.equal(p.$('#todoDetail').open,true);assert.equal(p.$('#todoDetailEdit').disabled,true);assert.equal(p.$('#todoDetailComplete').disabled,true);
 p.$('#todoDetailEdit').onclick();assert.equal(p.$('#todoComposer').hidden,true);assert.deepEqual(p.sent,[{action:'get'}]);
});
test('tobo 清空内容后离开自动删除，失败保留；备注或链接仍在时不删除，新建空白不写入',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.host.__boboTodoOpen('real-id');
 p.$('#todoTitle').value='';p.clickOutside();assert.deepEqual(p.sent,[{action:'get'}]);assert.equal(p.$('#todoComposer').hidden,false);
 p.$('#todoNotes').value='';p.$('#todoURL').value='';p.$('#todoTitle').oninput();assert.equal(p.$('#todoCreate').disabled,false);
 p.clickOutside();assert.deepEqual(p.sent.at(-1),{action:'remove',id:'real-id'});p.host.__boboTodoCreated(false);assert.equal(p.$('#todoComposer').hidden,false);assert.equal(p.$('#todoTitle').value,'');
 p.clickOutside();p.host.__boboTodoCreated(true);assert.equal(p.$('#todoComposer').hidden,true);
 const count=p.sent.length;p.$('#todoNew').onclick();p.$('#todoForm').onsubmit({preventDefault(){}});assert.equal(p.sent.length,count);
 const q=page();q.host.__boboTodoReceive(data());q.host.__boboTodoOpen('real-id');
 for(const id of ['Title','Notes','URL'])q.$('#todo'+id).value='';
 q.$('#todoBoard').children[0].children[1].children[0].children[0].onclick();q.host.__boboTodoCreated(true);
 assert.deepEqual(q.sent,[{action:'get'},{action:'remove',id:'real-id'}],'空白项删除后不能再向已删除事项发送完成请求');
});
test('Todo 创建卡片按需展开设置，切换面板保留字段，清除日期同时清除时间',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.$('#todoNew').onclick();
 assert.equal(p.$('#todoDatePanel').hidden,true);assert.equal(p.$('#todoAlarmPanel').hidden,true);
 p.$('#todoDateToggle').onclick();assert.equal(p.$('#todoDatePanel').hidden,false);
 p.$('#todoDate').value='2026-11-02';p.$('#todoDate').onchange();p.$('#todoTime').value='12:30';
 p.$('#todoAlarmToggle').onclick();assert.equal(p.$('#todoDatePanel').hidden,true);assert.equal(p.$('#todoAlarmPanel').hidden,false);
 p.$('#todoDateToggle').onclick();assert.equal(p.$('#todoTime').value,'12:30');
 p.$('#todoDate').value='';p.$('#todoDate').onchange();assert.equal(p.$('#todoTime').value,'');assert.equal(p.$('#todoTime').disabled,true);
 p.$('#todoURL').oninvalid();assert.equal(p.$('#todoURLPanel').hidden,false);
 p.$('#todoTitle').value='';p.$('#todoTitle').oninput();assert.equal(p.$('#todoCreate').disabled,true);
});
test('tobo 备注按工具栏展开，点击输入外收缩并保留新建草稿',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.$('#todoQuickTitle').onfocus();
 assert.equal(p.$('#todoNotesPanel').hidden,true);p.$('#todoNotesToggle').onclick();assert.equal(p.$('#todoNotesPanel').hidden,false);
 p.$('#todoTitle').value='保留草稿';p.$('#todoNotes').value='备注草稿';p.clickOutside();assert.equal(p.$('#todoComposer').hidden,true);
 p.$('#todoQuickTitle').onfocus();assert.equal(p.$('#todoTitle').value,'保留草稿');assert.equal(p.$('#todoNotes').value,'备注草稿');assert.equal(p.$('#todoNotesPanel').hidden,true);
 assert.deepEqual(p.sent,[{action:'get'}]);
});
test('Todo 短过渡可中断，重新展开不会被旧收起回调隐藏；减少动态效果时立即切换',async()=>{
 const p=page(),motions=[];p.host.__boboTodoReceive(data());
 p.$('#todoInputShell').animate=(frames,options)=>{
  let finish;const motion={finished:new Promise(resolve=>{finish=resolve;}),cancel(){this.cancelled=true;},finish(){finish();},options};motions.push(motion);return motion;
 };
 p.$('#todoNew').onclick();p.$('#todoCancel').onclick();p.$('#todoNew').onclick();
 assert.equal(motions.length,3);assert.ok(motions.every(m=>m.options.duration<=200));
 motions[1].finish();await Promise.resolve();assert.equal(p.$('#todoComposer').hidden,false,'旧的退出动画不能隐藏新打开的输入');
 motions[2].finish();await Promise.resolve();assert.equal(p.$('#todoComposer').hidden,false);
 p.host.matchMedia=()=>({matches:true});p.$('#todoCancel').onclick();
 assert.equal(p.$('#todoComposer').hidden,true);assert.equal(motions.length,3);
});
