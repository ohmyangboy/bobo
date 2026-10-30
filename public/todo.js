// macOS EventKit 数据只走原生桥；浏览器模式不伪造事项或请求权限。
const buckets=['today','week','later'],titles={later:'事务',week:'近七',today:'今日'};
export function installTodoPage(doc=document,host=window){
 const $=s=>doc.querySelector(s),bridge=host.webkit?.messageHandlers?.boboTodo;
 let snapshot=null,pending=false,listKey='',boardKey='',selectedID=null,editingID=null,option=null;
 const send=body=>{if(bridge)bridge.postMessage(body);};
 const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 const show=selector=>{const el=$(selector);if(!el.open)el.showModal();};
 const close=selector=>$(selector).close();
 const items=()=>snapshot?.columns?.flatMap(c=>c.items)||[];
 const ready=()=>!!bridge&&snapshot?.enabled&&snapshot?.authorization==='allowed';
 function localDate(value=new Date()){
  return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
 }
 function dateFor(bucket){const date=new Date();if(bucket==='week')date.setDate(date.getDate()+1);return bucket==='later'?'':localDate(date);}
 function alarmLocal(text){const date=new Date(text);return !text||Number.isNaN(date.getTime())?'':`${localDate(date)}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}`;}
 function showItem(id){
  const item=items().find(item=>item.id===id);if(!item)return;
  selectedID=id;$('#todoDetailTitle').textContent=item.title;$('#todoDetailList').textContent=item.list;
  $('#todoDetailDate').textContent=[item.completed?'已完成':'',item.dateText,({1:'高优先级',5:'中优先级',9:'低优先级'})[item.priority]].filter(Boolean).join(' · ');
  $('#todoDetailNotes').textContent=item.notes||'';$('#todoDetailURL').textContent=item.url||'';
  $('#todoDetailEdit').disabled=item.editable===false;$('#todoDetailComplete').disabled=item.editable===false;
  $('#todoDetailComplete').textContent=item.completed?'标记未完成':'标记完成';show('#todoDetail');
 }
 function syncTime(){
  $('#todoTime').disabled=!$('#todoDate').value;
  if(!$('#todoDate').value)$('#todoTime').value='';
  syncOptions();
 }
 function syncCreate(){$('#todoCreate').disabled=pending||!snapshot?.lists?.length||!$('#todoTitle').value.trim();}
 function syncOptions(){
  const date=$('#todoDate').value;
  $('#todoDateLabel').textContent=date?(date===localDate()?'今天':date.slice(5).replace('-','/')):'';
  for(const name of ['Date','Alarm','Organize','URL']){
   $('#todo'+name+'Panel').hidden=option!==name;
   const toggle=$('#todo'+name+'Toggle');toggle.setAttribute('aria-expanded',String(option===name));
   toggle.setAttribute('data-active',String(name==='Date'?!!date:name==='Alarm'?!!$('#todoAlarm').value:name==='URL'?!!$('#todoURL').value:Number($('#todoPriority').value)>0));
  }
 }
 function openCreate(bucket='later',title='',item=null){
  if(!ready()||pending)return;
  editingID=item?.id||null;$('#todoBucket').value=buckets.includes(bucket)?bucket:'later';$('#todoTitle').value=item?.title??title;
  $('#todoDate').value=item?.date??dateFor(bucket);$('#todoTime').value=item?.time||'';
  $('#todoNotes').value=item?.notes||'';$('#todoURL').value=item?.url||'';$('#todoPriority').value=String(item?.priority||0);$('#todoAlarm').value=alarmLocal(item?.alarm);
  if(item)$('#todoList').value=item.listID;
  $('#todoComposerHeading').textContent=item?'编辑提醒事项':'新提醒事项';$('#todoCreate').textContent=item?'保存':'创建';
  $('#todoSaveStatus').textContent='';option=null;syncTime();syncCreate();close('#todoDetail');show('#todoComposer');$('#todoTitle').focus();
 }
 function renderBoard(data){
  const key=JSON.stringify(data?.columns||[]);if(key===boardKey)return;boardKey=key;
  const board=$('#todoBoard'),scrolls=new Map(Array.from(board.children,c=>[c.dataset.bucket,c.querySelector('.todo-items')?.scrollTop||0]));
  board.replaceChildren(...buckets.map(bucket=>{
   const rows=data?.columns?.find(c=>c.bucket===bucket)?.items||[],section=node('section','todo-column');section.dataset.bucket=bucket;
   const head=node('div','todo-column-head'),heading=node('h3','',titles[bucket]),add=node('button','todo-icon-button','＋');
   add.type='button';add.setAttribute('aria-label',`新增到${titles[bucket]}`);add.onclick=()=>openCreate(bucket);
   head.append(heading,node('span','todo-count',String(rows.length)),add);section.append(head);
   if(!rows.length){
    const empty=node('div','todo-empty'),mark=node('img');mark.src='/icon.png';mark.alt='';empty.append(mark,node('span','','暂无事项'));section.append(empty);
   }else{
    const list=node('div','todo-items');list.tabIndex=0;list.setAttribute('aria-label',`${titles[bucket]}事项，可滚动`);
    for(const item of rows){
     const card=node('div',`todo-item${item.completed?' is-completed':''}`),copy=node('button','todo-item-copy'),check=node('button','todo-check',item.completed?'✓':'');
     copy.type=check.type='button';check.disabled=item.editable===false;check.setAttribute('aria-label',`${item.completed?'标记未完成':'完成'}：${item.title}`);
     check.onclick=()=>send({action:'complete',id:item.id,completed:!item.completed});
     copy.title=`${item.title} · ${item.list}；在 bobo 中查看`;
     copy.append(node('span','todo-title',item.title),node('small',item.overdue?'todo-overdue':'',`${item.dateText} · ${item.list}`));
     copy.onclick=()=>showItem(item.id);card.append(check,copy);list.append(card);
    }
    section.append(list);
   }
   return section;
  }));
  for(const section of board.children){const list=section.querySelector('.todo-items');if(list)list.scrollTop=scrolls.get(section.dataset.bucket)||0;}
 }
 function render(data){
  snapshot=data;
  const allowed=data?.authorization==='allowed',enabled=!!data?.enabled,loading=!!data?.loading,connected=ready();
  $('#todoStatus').textContent=!bridge?'请在 macOS bobo App 中连接本机提醒事项':data?.error||({notDetermined:'连接提醒事项',denied:'请在系统设置 → 隐私与安全性 → 提醒事项中允许 bobo',restricted:'提醒事项访问受系统限制'}[data?.authorization])||(enabled?(loading?'正在同步…':`${items().filter(item=>!item.completed).length} 项待办`):'Todo 已关闭');
  $('#todoConnect').hidden=!bridge||allowed||data?.authorization==='restricted';$('#todoConnect').disabled=loading;
  $('#todoPermissionSettings').hidden=!bridge||!['denied','restricted'].includes(data?.authorization);
  $('#todoEnabled').checked=enabled;$('#todoEnabled').disabled=!bridge||!allowed;
  $('#todoShowCompleted').checked=!!data?.showCompleted;$('#todoShowCompleted').disabled=!connected;
  $('#todoOpen').disabled=!bridge;$('#todoRefresh').disabled=!bridge||loading;$('#todoNew').disabled=!connected;
  $('#todoForm').hidden=!connected;$('#todoQuickForm').hidden=!connected;$('#todoBoard').hidden=!connected;
  if(!connected){close('#todoComposer');close('#todoDetail');selectedID=editingID=null;}
  const lists=data?.lists||[],key=JSON.stringify(lists);
  if(key!==listKey){
   listKey=key;const select=$('#todoList'),old=select.value;
   select.replaceChildren(...lists.map(list=>{const option=node('option','',list.title);option.value=list.id;return option;}));
   select.value=lists.some(list=>list.id===old)?old:lists.some(list=>list.id===data?.defaultList)?data.defaultList:lists[0]?.id||'';
  }
  syncCreate();$('#todoCancel').disabled=pending;
  $('#todoCreate').textContent=pending?'保存中…':editingID?'保存':'创建';
  $('#todoListHint').textContent=lists.length?'':'没有可写列表，请先在系统提醒事项中创建列表。';
  if(connected)renderBoard(data);
  if(selectedID&&$('#todoDetail').open){if(items().some(item=>item.id===selectedID))showItem(selectedID);else close('#todoDetail');}
  const status=doc.querySelector('[data-side-status="todo"]');
  if(status){status.querySelector('.notch-dot').dataset.state=allowed&&enabled?'idle':'';status.querySelector('b').textContent=!bridge?'需 macOS App':enabled?(allowed?'已连接':'待授权'):'未连接';}
 }
 host.__boboTodoReceive=render;host.__boboTodoOpen=showItem;
 host.__boboTodoCreated=saved=>{
  pending=false;
  if(saved){for(const id of ['Title','Date','Time','Notes','URL','Alarm'])$('#todo'+id).value='';$('#todoPriority').value='0';$('#todoQuickTitle').value='';editingID=null;selectedID=null;close('#todoComposer');}
  else $('#todoSaveStatus').textContent=snapshot?.error||'保存失败，输入已保留';
  render(snapshot);
 };
 $('#todoConnect').onclick=()=>send({action:'connect'});$('#todoPermissionSettings').onclick=()=>send({action:'settings'});
 $('#todoEnabled').onchange=event=>send({action:'enabled',enabled:event.target.checked});
 $('#todoShowCompleted').onchange=event=>send({action:'showCompleted',show:event.target.checked});
 $('#todoOpen').onclick=()=>send({action:'openSystem'});$('#todoRefresh').onclick=()=>send({action:'get'});
 $('#todoNew').onclick=()=>openCreate();$('#todoCancel').onclick=()=>{if(!pending)close('#todoComposer');};
 $('#todoComposer').oncancel=event=>{if(pending)event.preventDefault();};
 $('#todoDate').onchange=syncTime;
 $('#todoTitle').oninput=syncCreate;
 for(const name of ['Date','Alarm','Organize','URL'])$('#todo'+name+'Toggle').onclick=()=>{option=option===name?null:name;syncOptions();};
 for(const name of ['Alarm','Priority','URL'])$('#todo'+name).onchange=syncOptions;
 for(const [field,panel] of [['Date','Date'],['Time','Date'],['Alarm','Alarm'],['List','Organize'],['URL','URL']])$('#todo'+field).oninvalid=()=>{option=panel;syncOptions();};
 $('#todoDetailClose').onclick=()=>{selectedID=null;close('#todoDetail');};$('#todoDetailSystem').onclick=()=>send({action:'openSystem',id:selectedID});
 $('#todoDetailEdit').onclick=()=>{const item=items().find(item=>item.id===selectedID);if(item&&item.editable!==false)openCreate('later','',item);};
 $('#todoDetailComplete').onclick=()=>{const item=items().find(item=>item.id===selectedID);if(item)send({action:'complete',id:item.id,completed:!item.completed});};
 $('#todoQuickForm').onsubmit=event=>{event.preventDefault();openCreate($('#todoQuickBucket').value,$('#todoQuickTitle').value);};
 $('#todoForm').onsubmit=event=>{
  event.preventDefault();if(pending||!ready())return;
  const title=$('#todoTitle').value.trim();if(!title)return;
  const alarmValue=$('#todoAlarm').value,alarm=alarmValue?new Date(alarmValue):null;
  if(alarm&&Number.isNaN(alarm.getTime())){$('#todoSaveStatus').textContent='提醒时间无效';return;}
  pending=true;$('#todoSaveStatus').textContent='';render(snapshot);
  const body={action:editingID?'update':'create',title,date:$('#todoDate').value,time:$('#todoTime').value,listID:$('#todoList').value,bucket:$('#todoDate').value?$('#todoBucket').value:'later',notes:$('#todoNotes').value,url:$('#todoURL').value,priority:Number($('#todoPriority').value)||0,alarm:alarm?.toISOString()||''};
  if(editingID)body.id=editingID;send(body);
 };
 render(null);send({action:'get'});
 return {refresh(){send({action:'get'});}};
}
