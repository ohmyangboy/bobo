import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installTodoPage} from '../public/todo.js';

class Element{
 constructor(tag=''){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.dataset={};this.checked=false;this.open=false;this.scrollTop=0;this.attributes={};}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return this.children.find(el=>el.className?.split(' ').includes(selector.slice(1)))||null;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 focus(){this.focused=true;}
}
function page(native=true){
 const nodes=new Map(),sent=[];
 const doc={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);},createElement(tag){return new Element(tag);}};
 const status=doc.querySelector('[data-side-status="todo"]');status.querySelector=selector=>doc.querySelector('status '+selector);
 const host=native?{webkit:{messageHandlers:{boboTodo:{postMessage(body){sent.push(body);}}}}}:{};
 const controller=installTodoPage(doc,host);
 return {nodes,host,sent,controller,$:selector=>doc.querySelector(selector)};
}
const data=()=>({enabled:true,authorization:'allowed',lists:[{id:'inbox',title:'收件箱'}],defaultList:'inbox',columns:[{bucket:'today',items:[{id:'real-id',title:'<img src=x onerror=alert(1)>',dateText:'今天',list:'收件箱',notes:'备注',priority:1,date:'2026-10-30',time:'',listID:'inbox',url:'https://example.com',editable:true}]},{bucket:'later',items:[]},{bucket:'week',items:[]}]});
test('Todo 浏览器模式明确提示原生 App，不能伪造连接或发送写入',()=>{
 const p=page(false);assert.match(p.$('#todoStatus').textContent,/macOS bobo App/);
 assert.equal(p.$('#todoForm').hidden,true);assert.equal(p.$('#todoOpen').disabled,true);assert.equal(p.$('#todoConnect').hidden,true);
 p.$('#todoConnect').onclick();assert.deepEqual(p.sent,[]);
});
test('Todo 三列固定顺序，点击在 bobo 内看详情，只有次要入口调用系统',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 assert.deepEqual(p.$('#todoBoard').children.map(c=>c.dataset.bucket),['today','week','later']);
 const item=p.$('#todoBoard').children[0].children[1].children[0];
 assert.equal(item.children[1].children[0].textContent,'<img src=x onerror=alert(1)>');
 item.children[1].onclick();assert.equal(p.$('#todoDetail').open,true);assert.equal(p.$('#todoDetailNotes').textContent,'备注');
 assert.deepEqual(p.sent,[{action:'get'}]);
 p.$('#todoDetailSystem').onclick();assert.deepEqual(p.sent.at(-1),{action:'openSystem',id:'real-id'});
 p.$('#todoDetailClose').onclick();p.host.__boboTodoOpen('real-id');assert.equal(p.$('#todoDetail').open,true);
});
test('Todo 底部 Return 与各列加号进入对应创建卡片；提交去重、失败保留输入、成功清空',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 p.$('#todoQuickTitle').value='  真实待办  ';p.$('#todoQuickBucket').value='today';
 p.$('#todoQuickForm').onsubmit({preventDefault(){}});
 assert.equal(p.$('#todoComposer').open,true);assert.equal(p.$('#todoBucket').value,'today');assert.equal(p.$('#todoTitle').focused,true);
 p.$('#todoDate').value='2026-10-30';p.$('#todoNotes').value='备注';p.$('#todoURL').value='https://example.com';p.$('#todoTime').value='09:30';p.$('#todoPriority').value='1';
 const submit=()=>p.$('#todoForm').onsubmit({preventDefault(){}});submit();submit();
 assert.deepEqual(p.sent.filter(s=>s.action==='create'),[{action:'create',title:'真实待办',date:'2026-10-30',time:'09:30',listID:'inbox',bucket:'today',notes:'备注',url:'https://example.com',priority:1,alarm:''}]);
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'  真实待办  ');assert.equal(p.$('#todoCreate').disabled,false);assert.equal(p.$('#todoComposer').open,true);
 submit();p.host.__boboTodoCreated(true);assert.equal(p.$('#todoTitle').value,'');assert.equal(p.$('#todoDate').value,'');assert.equal(p.$('#todoNotes').value,'');assert.equal(p.$('#todoComposer').open,false);
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
test('Todo 拒绝权限、关闭或撤权时隐藏数据并关闭详情与创建',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.$('#todoNew').onclick();p.host.__boboTodoOpen('real-id');
 p.host.__boboTodoReceive({enabled:true,authorization:'denied',columns:[]});
 assert.equal(p.$('#todoPermissionSettings').hidden,false);assert.equal(p.$('#todoBoard').hidden,true);assert.equal(p.$('#todoForm').hidden,true);
 assert.equal(p.$('#todoComposer').open,false);assert.equal(p.$('#todoDetail').open,false);assert.match(p.$('#todoStatus').textContent,/隐私与安全性/);
 p.host.__boboTodoReceive({...data(),enabled:false});assert.equal(p.$('#todoBoard').hidden,true);
 p.$('#todoEnabled').onchange({target:{checked:false}});assert.deepEqual(p.sent.at(-1),{action:'enabled',enabled:false});
});

test('Todo 编辑带回系统字段，保存失败保留草稿，完成与已完成切换独立写回',()=>{
 const p=page();p.host.__boboTodoReceive(data());p.host.__boboTodoOpen('real-id');p.$('#todoDetailEdit').onclick();
 assert.equal(p.$('#todoComposer').open,true);assert.equal(p.$('#todoDetail').open,false);
 assert.equal(p.$('#todoDate').value,'2026-10-30');assert.equal(p.$('#todoNotes').value,'备注');assert.equal(p.$('#todoURL').value,'https://example.com');
 p.$('#todoTitle').value='修改标题';p.$('#todoDate').value='';p.$('#todoDate').onchange();
 assert.equal(p.$('#todoTime').disabled,true);
 p.$('#todoForm').onsubmit({preventDefault(){}});
 assert.equal(p.sent.at(-1).action,'update');assert.equal(p.sent.at(-1).id,'real-id');assert.equal(p.sent.at(-1).date,'');
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'修改标题');
 p.$('#todoShowCompleted').onchange({target:{checked:true}});assert.deepEqual(p.sent.at(-1),{action:'showCompleted',show:true});
 const card=p.$('#todoBoard').children[0].children[1].children[0];card.children[0].onclick();
 assert.deepEqual(p.sent.at(-1),{action:'complete',id:'real-id',completed:true});
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
