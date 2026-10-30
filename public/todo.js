// macOS EventKit 数据只走原生桥；浏览器模式不伪造事项或请求权限。
const buckets=['today','week','later'],titles={later:'事务',week:'近七',today:'今日'};
export function installTodoPage(doc=document,host=window){
 const $=s=>doc.querySelector(s),bridge=host.webkit?.messageHandlers?.boboTodo;
 let snapshot=null,pending=false,listKey='',boardKey='',selectedID=null,editingID=null,option=null,composerMotion=null,optionMotion=null,inlineContext=null,editBaseline='',afterSave=null,newDraft=null;
 const rowNodes=new Map(),composerHome=$('#todoInputContent'),formFields=['Title','Date','Time','Notes','URL','Priority','Alarm','List'];
 const send=body=>{if(bridge)bridge.postMessage(body);};
 const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 const show=selector=>{const el=$(selector);if(!el.open)el.showModal();};
 const close=(selector,animated=true)=>{if(selector==='#todoComposer')moveComposer(false,animated);else $(selector).close();};
 const items=()=>snapshot?.columns?.flatMap(c=>c.items)||[];
 const ready=()=>!!bridge&&snapshot?.enabled&&snapshot?.authorization==='allowed';
 const reducedMotion=()=>!!host.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 // 参考 magpie：快起步、缓收尾；只动输入区，不牵动列表和窗口几何。
 function moveComposer(open,animated=true){
  if(!open&&!inlineContext)rememberNewDraft();
  if(!open&&inlineContext){restoreInline();editingID=null;editBaseline='';}
  const el=$('#todoComposer'),shell=$('#todoInputShell');composerMotion?.cancel();composerMotion=null;if(shell.style)shell.style.overflow='';
  optionMotion?.cancel();optionMotion=null;if(el.style)el.style.overflow='';
  $('#todoSettings').open=false;$('#todoCancel').hidden=!open;
  if(!open&&el.hidden){$('#todoQuickForm').hidden=!bridge;return;}
  const before=shell.getBoundingClientRect?.();
  el.hidden=!open;$('#todoQuickForm').hidden=open||!bridge;
  if(!animated||reducedMotion()||!shell.animate)return;
  const after=shell.getBoundingClientRect?.();
  if(shell.style)shell.style.overflow='hidden';
  const motion=shell.animate([{width:(before?.width||260)+'px',height:(before?.height||44)+'px'},{width:(after?.width||(open?380:260))+'px',height:(after?.height||(open?126:44))+'px'}],{duration:open?180:120,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});composerMotion=motion;
  const end=()=>{if(composerMotion===motion){composerMotion=null;if(shell.style)shell.style.overflow='';motion.cancel();}};motion.finished.then(end,end);
 }
 function emptyContent(){return ['Title','Notes','URL'].every(id=>!$('#todo'+id).value.trim());}
 function editSignature(){return JSON.stringify(formFields.map(id=>$('#todo'+id).value));}
 function rememberNewDraft(){if(!inlineContext&&!editingID&&!$('#todoComposer').hidden)newDraft=emptyContent()?null:{bucket:$('#todoBucket').value,values:Object.fromEntries(formFields.map(id=>[id,$('#todo'+id).value]))};}
 function restoreInline(){
  if(!inlineContext)return;
  inlineContext.copy.hidden=false;inlineContext.row.className=inlineContext.row.className.replace(' is-editing','');
  composerHome.append($('#todoComposer'));$('#todoComposer').className='todo-inline-composer';inlineContext=null;
 }
 function mountInline(binding){
  composerMotion?.cancel();composerMotion=null;if($('#todoInputShell').style)$('#todoInputShell').style.overflow='';
  inlineContext=binding;binding.copy.hidden=true;binding.row.className+=' is-editing';
  $('#todoComposer').className='todo-inline-composer todo-inline-row';binding.row.append($('#todoComposer'));
  $('#todoComposer').hidden=false;$('#todoQuickForm').hidden=!bridge;$('#todoCancel').hidden=false;
 }
 function leaveInline(next){
  if(pending)return;
  if(inlineContext&&editSignature()!==editBaseline){afterSave=next;$('#todoForm').requestSubmit();if(!pending)afterSave=null;return;}
  close('#todoComposer',false);editingID=null;next();
 }
 function openItem(id){
  if(!ready()||pending||inlineContext?.id===id)return;
  if(inlineContext){leaveInline(()=>openItem(id));return;}
  const item=items().find(item=>item.id===id),binding=rowNodes.get(id);if(!item||!binding)return;
  if(item.editable===false){showItem(id);return;}
  openCreate(binding.bucket,'',item);mountInline(binding);editBaseline=editSignature();
  binding.row.scrollIntoView?.({block:'nearest'});$('#todoTitle').focus();
 }
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
 function syncCreate(){const remove=inlineContext&&emptyContent();$('#todoCreate').disabled=pending||!snapshot?.lists?.length||(!$('#todoTitle').value.trim()&&!remove);$('#todoCreate').setAttribute('aria-label',remove?'删除空白事项':editingID?'保存提醒事项':'添加提醒事项');}
 function syncOptions(){
  const composer=$('#todoComposer'),before=!composer.hidden?composer.getBoundingClientRect?.().height:0;
  if(optionMotion){optionMotion.cancel();optionMotion=null;composer.style.overflow='';}
  const date=$('#todoDate').value;
  $('#todoDateLabel').textContent=date?(date===localDate()?'今天':date.slice(5).replace('-','/')):'';
  for(const name of ['Date','Alarm','Notes','Organize','URL']){
   $('#todo'+name+'Panel').hidden=option!==name;
   const toggle=$('#todo'+name+'Toggle');toggle.setAttribute('aria-expanded',String(option===name));
   toggle.setAttribute('data-active',String(name==='Date'?!!date:name==='Alarm'?!!$('#todoAlarm').value:name==='URL'?!!$('#todoURL').value:name==='Notes'?!!$('#todoNotes').value:Number($('#todoPriority').value)>0));
  }
  const after=before?composer.getBoundingClientRect?.().height:0;
  if(before&&after&&Math.abs(before-after)>0.5&&composer.animate&&!reducedMotion()){
   optionMotion?.cancel();composer.style.overflow='hidden';
   const motion=composer.animate([{height:before+'px'},{height:after+'px'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});optionMotion=motion;
   const end=()=>{if(optionMotion===motion){optionMotion=null;composer.style.overflow='';}};motion.finished.then(end,end);
  }
 }
 function openCreate(bucket='today',title='',item=null,resume=false){
  if(!ready()||pending)return;
  if(!item&&inlineContext){leaveInline(()=>openCreate(bucket,title,null,resume));return;}
  rememberNewDraft();const saved=!item&&resume?newDraft:null;if(!item&&!resume)newDraft=null;
  bucket=buckets.includes(bucket)?bucket:'today';
  editingID=item?.id||null;$('#todoBucket').value=bucket;$('#todoTitle').value=item?.title??title;
  $('#todoDate').value=item?.date??dateFor(bucket);$('#todoTime').value=item?.time||'';
  $('#todoNotes').value=item?.notes||'';$('#todoURL').value=item?.url||'';$('#todoPriority').value=String(item?.priority||0);$('#todoAlarm').value=alarmLocal(item?.alarm);
  $('#todoList').value=item?.listID||'';$('#todoTitle').required=!item;
  if(saved){for(const id of formFields)$('#todo'+id).value=saved.values[id];$('#todoBucket').value=saved.bucket;if(title)$('#todoTitle').value=title;}
  $('#todoComposerHeading').textContent=item?'编辑提醒事项':'新增提醒事项';$('#todoCreate').textContent='⏎';$('#todoCreate').setAttribute('aria-label',item?'保存提醒事项':'添加提醒事项');
  $('#todoSaveStatus').textContent='';option=null;syncTime();syncCreate();close('#todoDetail');
  if(item){$('#todoComposer').hidden=false;$('#todoSettings').open=false;}else{moveComposer(true);$('#todoTitle').focus();}
 }
 function renderBoard(data){
  const key=JSON.stringify(data?.columns||[]);if(key===boardKey)return;boardKey=key;
  const board=$('#todoBoard'),scrolls=new Map(Array.from(board.children,c=>[c.dataset.bucket,c.querySelector('.todo-items')?.scrollTop||0]));
  const active=inlineContext?.id,focus=doc.activeElement,restoreFocus=!!(active&&$('#todoComposer').contains?.(focus));
  if(active)restoreInline();rowNodes.clear();
  board.replaceChildren(...buckets.map(bucket=>{
   const rows=data?.columns?.find(c=>c.bucket===bucket)?.items||[],section=node('section','todo-column');section.dataset.bucket=bucket;
   const head=node('div','todo-column-head'),heading=node('h3','',titles[bucket]),add=node('button','todo-icon-button','＋');
   add.type='button';add.setAttribute('aria-label',`新增到${titles[bucket]}`);add.onclick=()=>openCreate(bucket);
   head.append(heading,node('span','todo-count',String(rows.length)),add);section.append(head);
   if(!rows.length){
    const empty=node('div','todo-empty');empty.append(node('span','','暂无事项'));section.append(empty);
   }else{
    const list=node('div','todo-items');list.tabIndex=0;list.setAttribute('aria-label',`${titles[bucket]}事项，可滚动`);
    for(const item of rows){
     const card=node('div',`todo-item${item.completed?' is-completed':''}`),copy=node('button','todo-item-copy'),check=node('button','todo-check',item.completed?'✓':'');
     copy.type=check.type='button';check.disabled=item.editable===false;check.setAttribute('aria-label',`${item.completed?'标记未完成':'完成'}：${item.title}`);
     check.onclick=()=>{const complete=()=>send({action:'complete',id:item.id,completed:!item.completed});if(inlineContext?.id===item.id)leaveInline(complete);else complete();};
     copy.title=`${item.title} · ${item.list}；${item.editable===false?"在 tobo 中查看":"点击原位编辑"}`;
     copy.append(node('span','todo-title',item.title));
     if(item.dateText&&!['今天','未设日期'].includes(item.dateText))copy.append(node('small',item.overdue?'todo-overdue':'',item.dateText));
     copy.onclick=()=>openItem(item.id);card.append(check,copy);list.append(card);rowNodes.set(item.id,{id:item.id,row:card,copy,bucket});
    }
    section.append(list);
   }
   return section;
  }));
  for(const section of board.children){const list=section.querySelector('.todo-items');if(list)list.scrollTop=scrolls.get(section.dataset.bucket)||0;}
  if(active){const binding=rowNodes.get(active);if(binding)mountInline(binding);else{close('#todoComposer',false);editingID=null;}}
  if(restoreFocus&&inlineContext)focus.focus({preventScroll:true});
 }
 function render(data){
  snapshot=data;
  const allowed=data?.authorization==='allowed',enabled=!!data?.enabled,loading=!!data?.loading,connected=ready();
  $('#todoStatus').textContent=!bridge?'请在 macOS bobo App 中连接本机提醒事项':data?.error||({notDetermined:'连接提醒事项',denied:'请在系统设置 → 隐私与安全性 → 提醒事项中允许 bobo',restricted:'提醒事项访问受系统限制'}[data?.authorization])||(enabled?(loading?'正在同步…':`${items().filter(item=>!item.completed).length} 项待办`):'tobo 已关闭');
  $('#todoConnect').hidden=!bridge||allowed||data?.authorization==='restricted';$('#todoConnect').disabled=loading;
  $('#todoPermissionSettings').hidden=!bridge||!['denied','restricted'].includes(data?.authorization);
  $('#todoEnabled').checked=enabled;$('#todoEnabled').disabled=!bridge||!allowed;
  $('#todoShowCompleted').checked=!!data?.showCompleted;$('#todoShowCompleted').disabled=!connected;
  $('#todoOpen').disabled=!bridge;$('#todoOpenTobo').disabled=!bridge;$('#todoRefresh').disabled=!bridge||loading;$('#todoNew').disabled=!connected;
  $('#todoForm').hidden=!connected;$('#todoQuickForm').hidden=!bridge||(!inlineContext&&!$('#todoComposer').hidden);$('#todoInputShell').hidden=!bridge;$('#todoQuickTitle').disabled=!connected;$('#todoBoard').hidden=!connected;
  if(!connected){close('#todoComposer',false);close('#todoDetail');selectedID=editingID=null;}
  const lists=data?.lists||[],key=JSON.stringify(lists);
  if(key!==listKey){
   listKey=key;const select=$('#todoList'),old=select.value;
   const automatic=node('option','','系统默认');automatic.value='';
   select.replaceChildren(automatic,...lists.map(list=>{const option=node('option','',list.title);option.value=list.id;return option;}));
   select.value=lists.some(list=>list.id===old)?old:'';
  }
  syncCreate();$('#todoCancel').disabled=pending;
  $('#todoCreate').textContent=pending?'…':'⏎';$('#todoCreate').setAttribute('aria-label',pending?'保存中':inlineContext&&emptyContent()?'删除空白事项':editingID?'保存提醒事项':'添加提醒事项');
  $('#todoListHint').textContent=lists.length?'':'没有可写列表，请先在系统提醒事项中创建列表。';
  if(connected)renderBoard(data);
  if(selectedID&&$('#todoDetail').open){if(items().some(item=>item.id===selectedID))showItem(selectedID);else close('#todoDetail');}
  const status=doc.querySelector('[data-side-status="todo"]');
  if(status){status.querySelector('.notch-dot').dataset.state=allowed&&enabled?'idle':'';status.querySelector('b').textContent=!bridge?'需 macOS App':enabled?(allowed?'已连接':'待授权'):'未连接';}
 }
 host.__boboTodoReceive=render;host.__boboTodoOpen=openItem;
 host.__boboTodoCreated=saved=>{
  pending=false;const next=afterSave;afterSave=null;
  if(saved){for(const id of ['Title','Date','Time','Notes','URL','Alarm'])$('#todo'+id).value='';$('#todoPriority').value='0';$('#todoQuickTitle').value='';editingID=null;selectedID=null;close('#todoComposer');}
  else $('#todoSaveStatus').textContent=snapshot?.error||'保存失败，输入已保留';
  render(snapshot);if(saved&&next)next();
 };
 $('#todoConnect').onclick=()=>send({action:'connect'});$('#todoPermissionSettings').onclick=()=>send({action:'settings'});
 $('#todoEnabled').onchange=event=>send({action:'enabled',enabled:event.target.checked});
 $('#todoShowCompleted').onchange=event=>send({action:'showCompleted',show:event.target.checked});
 $('#todoOpen').onclick=()=>{const id=inlineContext?.id;const open=()=>send(id?{action:'openSystem',id}:{action:'openSystem'});if(inlineContext)leaveInline(open);else open();};$('#todoRefresh').onclick=()=>send({action:'get'});
 $('#todoOpenTobo').onclick=()=>{$('#todoSettings').open=false;send({action:'openTobo'});};
 $('#todoNew').onclick=()=>openCreate();$('#todoCancel').onclick=()=>{if(inlineContext)leaveInline(()=>{});else if(!pending)close('#todoComposer');};
 $('#todoComposer').onkeydown=event=>{if(event.key==='Escape'&&!pending)close('#todoComposer');};
 $('#todoDate').onchange=syncTime;
 for(const id of ['Title','Notes','URL'])$('#todo'+id).oninput=syncCreate;
 for(const name of ['Date','Alarm','Notes','Organize','URL'])$('#todo'+name+'Toggle').onclick=()=>{option=option===name?null:name;syncOptions();};
 for(const name of ['Alarm','Priority','URL','Notes'])$('#todo'+name).onchange=syncOptions;
 for(const [field,panel] of [['Date','Date'],['Time','Date'],['Alarm','Alarm'],['List','Organize'],['URL','URL']])$('#todo'+field).oninvalid=()=>{option=panel;syncOptions();};
 $('#todoDetailClose').onclick=()=>{selectedID=null;close('#todoDetail');};$('#todoDetailSystem').onclick=()=>send({action:'openSystem',id:selectedID});
 $('#todoDetailEdit').onclick=()=>{const item=items().find(item=>item.id===selectedID);if(item&&item.editable!==false)openItem(item.id);};
 $('#todoDetailComplete').onclick=()=>{const item=items().find(item=>item.id===selectedID);if(item)send({action:'complete',id:item.id,completed:!item.completed});};
 $('#todoQuickTitle').onfocus=()=>openCreate($('#todoQuickBucket').value,$('#todoQuickTitle').value,null,true);
 $('#todoQuickForm').onsubmit=event=>{event.preventDefault();const title=$('#todoQuickTitle').value;openCreate($('#todoQuickBucket').value,title,null,true);if(title.trim())$('#todoForm').requestSubmit();};
 $('#todoForm').onsubmit=event=>{
  event.preventDefault();if(pending||!ready())return;
  const title=$('#todoTitle').value.trim();
  if(editingID&&emptyContent()){pending=true;$('#todoSaveStatus').textContent='';render(snapshot);send({action:'remove',id:editingID});return;}
  if(!title){if(editingID)$('#todoSaveStatus').textContent='请填写标题，或清空备注和链接以删除事项';return;}
  const alarmValue=$('#todoAlarm').value,alarm=alarmValue?new Date(alarmValue):null;
  if(alarm&&Number.isNaN(alarm.getTime())){$('#todoSaveStatus').textContent='提醒时间无效';return;}
  pending=true;$('#todoSaveStatus').textContent='';render(snapshot);
  const body={action:editingID?'update':'create',title,date:$('#todoDate').value,time:$('#todoTime').value,listID:$('#todoList').value,bucket:$('#todoDate').value?$('#todoBucket').value:'later',notes:$('#todoNotes').value,url:$('#todoURL').value,priority:Number($('#todoPriority').value)||0,alarm:alarm?.toISOString()||''};
  if(editingID)body.id=editingID;send(body);
 };
 doc.addEventListener?.('click',event=>{
  const target=event.target;
  if(pending||$('#todoSettings').contains?.(target)||target?.closest?.('.todo-item,.todo-input-shell'))return;
  if(inlineContext){if(!inlineContext.row.contains?.(target))leaveInline(()=>{});}
  else if(!$('#todoComposer').hidden&&!$('#todoInputShell').contains?.(target))close('#todoComposer');
 });
 render(null);send({action:'get'});
 return {refresh(){send({action:'get'});}};
}
