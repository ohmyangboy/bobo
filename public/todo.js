// macOS 的 EventKit 数据只走原生桥；浏览器模式不伪造事项、不请求权限。
export function installTodoPage(doc=document,host=window){
 const $=s=>doc.querySelector(s),bridge=host.webkit?.messageHandlers?.boboTodo;
 let snapshot=null,pending=false,listKey='';
 const send=body=>{if(bridge)bridge.postMessage(body);};
 const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 function render(data){
  snapshot=data;
  const allowed=data?.authorization==='allowed',enabled=!!data?.enabled,loading=!!data?.loading;
  $('#todoStatus').textContent=!bridge?'请在 macOS bobo App 中连接本机提醒事项':data?.error||({notDetermined:'连接后，系统会请求提醒事项权限',denied:'未获授权，请在系统设置 → 隐私与安全性 → 提醒事项中允许 bobo',restricted:'提醒事项访问受系统限制'}[data?.authorization])||(enabled?(loading?'正在同步提醒事项…':`已同步 ${data?.columns?.reduce((sum,c)=>sum+c.items.length,0)||0} 项未完成事项`):'已关闭岛内 Todo；系统提醒事项仍保留');
  $('#todoConnect').hidden=!bridge||allowed||data?.authorization==='restricted';
  $('#todoConnect').disabled=loading;
  $('#todoPermissionSettings').hidden=!bridge||!['denied','restricted'].includes(data?.authorization);
  $('#todoEnabled').checked=enabled;$('#todoEnabled').disabled=!bridge||!allowed;
  $('#todoOpen').disabled=!bridge;$('#todoRefresh').disabled=!bridge||loading;
  $('#todoForm').hidden=!bridge||!allowed||!enabled;
  const lists=data?.lists||[],key=JSON.stringify(lists);
  if(key!==listKey){
   listKey=key;const select=$('#todoList'),old=select.value;
   select.replaceChildren(...lists.map(list=>{const option=node('option','',list.title);option.value=list.id;return option;}));
   select.value=lists.some(list=>list.id===old)?old:lists.some(list=>list.id===data?.defaultList)?data.defaultList:lists[0]?.id||'';
  }
  $('#todoCreate').disabled=pending||!lists.length;
  $('#todoCreate').textContent=pending?'正在保存…':'添加到提醒事项';
  $('#todoListHint').textContent=lists.length?'日期留空归“稍后”；选择日期后可在支持的系统日历中显示。':'没有可写列表，请先在系统提醒事项中创建列表。';
  const board=$('#todoBoard');board.hidden=!allowed||!enabled;
  const titles={later:'稍后',week:'本周',today:'今天'};
  board.replaceChildren(...['later','week','today'].map(bucket=>{
   const column=data?.columns?.find(c=>c.bucket===bucket),items=column?.items||[],section=node('section','todo-column');section.dataset.bucket=bucket;
   const heading=node('h3','',titles[bucket]);heading.append(node('span','todo-count',String(items.length)));section.append(heading);
   if(!items.length)section.append(node('p','todo-empty','暂无事项'));
   for(const item of items){
    const button=node('button','todo-item');button.type='button';button.title=`${item.title} · ${item.list}；在提醒事项中打开`;
    button.append(node('span','todo-title',item.title),node('small',item.overdue?'todo-overdue':'',`${item.dateText} · ${item.list}`));
    button.onclick=()=>send({action:'open',id:item.id});section.append(button);
   }
   return section;
  }));
  const status=doc.querySelector('[data-side-status="todo"]');
  if(status){status.querySelector('.notch-dot').dataset.state=allowed&&enabled?'idle':'';status.querySelector('b').textContent=!bridge?'需 macOS App':enabled?(allowed?'已连接':'待授权'):'未连接';}
 }
 host.__boboTodoReceive=render;
 host.__boboTodoCreated=saved=>{pending=false;if(saved){$('#todoTitle').value='';$('#todoDate').value='';$('#todoSaveStatus').textContent='已保存到系统提醒事项';}else $('#todoSaveStatus').textContent='保存失败，输入已保留';render(snapshot);};
 $('#todoConnect').onclick=()=>send({action:'connect'});
 $('#todoPermissionSettings').onclick=()=>send({action:'settings'});
 $('#todoEnabled').onchange=event=>send({action:'enabled',enabled:event.target.checked});
 $('#todoOpen').onclick=()=>send({action:'open'});
 $('#todoRefresh').onclick=()=>send({action:'get'});
 $('#todoForm').onsubmit=event=>{
  event.preventDefault();if(pending||!bridge||!snapshot?.enabled||snapshot?.authorization!=='allowed')return;
  const title=$('#todoTitle').value.trim();if(!title)return;
  pending=true;$('#todoSaveStatus').textContent='';render(snapshot);
  send({action:'create',title,date:$('#todoDate').value,listID:$('#todoList').value});
 };
 render(null);send({action:'get'});
 return {refresh(){send({action:'get'});}};
}
