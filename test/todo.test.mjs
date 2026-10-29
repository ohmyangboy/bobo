import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installTodoPage} from '../public/todo.js';

class Element{
 constructor(){this.children=[];this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.dataset={};this.checked=false;}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
 querySelector(){return this.label??=new Element();}
}
function page(native=true){
 const nodes=new Map(),sent=[];
 const doc={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);},createElement(){return new Element();}};
 const host=native?{webkit:{messageHandlers:{boboTodo:{postMessage(body){sent.push(body);}}}}}:{};
 const controller=installTodoPage(doc,host);
 return {nodes,host,sent,controller,$:selector=>doc.querySelector(selector)};
}
const data=()=>({enabled:true,authorization:'allowed',lists:[{id:'inbox',title:'收件箱'}],defaultList:'inbox',columns:[{bucket:'today',items:[{id:'real-id',title:'<img src=x onerror=alert(1)>',dateText:'今天',list:'收件箱'}]},{bucket:'later',items:[]},{bucket:'week',items:[]}]});
test('Todo 浏览器模式明确提示原生 App，不能伪造连接或发送写入',()=>{
 const p=page(false);
 assert.match(p.$('#todoStatus').textContent,/macOS bobo App/);
 assert.equal(p.$('#todoForm').hidden,true);assert.equal(p.$('#todoOpen').disabled,true);assert.equal(p.$('#todoConnect').hidden,true);
 p.$('#todoConnect').onclick();assert.deepEqual(p.sent,[]);
});
test('Todo 原生桥：三列固定顺序、标题作为文本、点击携带原始提醒 ID',()=>{
 const p=page();assert.deepEqual(p.sent,[{action:'get'}]);
 p.host.__boboTodoReceive(data());
 assert.deepEqual(p.$('#todoBoard').children.map(c=>c.dataset.bucket),['later','week','today']);
 const item=p.$('#todoBoard').children[2].children[1];
 assert.equal(item.children[0].textContent,'<img src=x onerror=alert(1)>');
 item.onclick();assert.deepEqual(p.sent.at(-1),{action:'open',id:'real-id'});
 p.$('#todoEnabled').onchange({target:{checked:false}});assert.deepEqual(p.sent.at(-1),{action:'enabled',enabled:false});
});
test('Todo 写回：提交去重、失败保留输入、成功清空，原生列表与日期完整传递',()=>{
 const p=page();p.host.__boboTodoReceive(data());
 p.$('#todoTitle').value='  真实待办  ';p.$('#todoDate').value='2026-10-30';
 const submit=()=>p.$('#todoForm').onsubmit({preventDefault(){}});
 submit();submit();
 assert.deepEqual(p.sent.filter(s=>s.action==='create'),[{action:'create',title:'真实待办',date:'2026-10-30',listID:'inbox'}]);
 p.host.__boboTodoCreated(false);assert.equal(p.$('#todoTitle').value,'  真实待办  ');assert.equal(p.$('#todoCreate').disabled,false);
 submit();p.host.__boboTodoCreated(true);
 assert.equal(p.$('#todoTitle').value,'');assert.equal(p.$('#todoDate').value,'');assert.match(p.$('#todoSaveStatus').textContent,/已保存/);
});
test('Todo 拒绝权限和关闭状态：提示恢复路径，隐藏数据与新增表单',()=>{
 const p=page();p.host.__boboTodoReceive({enabled:true,authorization:'denied',columns:[]});
 assert.equal(p.$('#todoPermissionSettings').hidden,false);assert.equal(p.$('#todoBoard').hidden,true);assert.equal(p.$('#todoForm').hidden,true);
 assert.match(p.$('#todoStatus').textContent,/隐私与安全性/);
 p.host.__boboTodoReceive({...data(),enabled:false});assert.equal(p.$('#todoForm').hidden,true);assert.equal(p.$('#todoBoard').hidden,true);
});
