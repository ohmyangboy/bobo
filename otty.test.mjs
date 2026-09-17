import {test} from 'node:test';import assert from 'node:assert/strict';import {matchTab,viewedIds} from './otty.mjs';
// Otty 标签页与会话的匹配：标题精确匹配 `OC | <标题>` 优先，其次按目录（唯一时），同目录多个再用标题包含关系。
test('会话与 Otty 标签页匹配：标题优先、目录兜底',()=>{
 const tabs=[{id:'t1',title:'OC | 任务一',cwd:'/tmp/a'},{id:'t2',title:'别的',cwd:'/tmp/b'},{id:'t3',title:'',cwd:'/tmp/c'}];
 assert.equal(matchTab(tabs,{title:'任务一'})?.id,'t1');
 assert.equal(matchTab(tabs,{title:'没有的标题',directory:'/tmp/c'})?.id,'t3');
 assert.equal(matchTab(tabs,{title:'没有的标题',directory:'/tmp/b'})?.id,'t2');
 assert.equal(matchTab(tabs,{title:'',directory:'/tmp/none'}),null);
 assert.equal(matchTab(undefined,{title:'任务一'}),null);
});
// 「看过了」只认 Otty 当前停留（active）的标签页：仅选中但没切过去的标签页不算；多窗口时只认聚焦窗口。
test('看过终端：只有 active 的标签页算看过',()=>{
 const tabs=[{id:'t1',title:'OC | 任务一',cwd:'/tmp/a',window_id:'w1',active:false},{id:'t2',title:'OC | 任务二',cwd:'/tmp/b',window_id:'w1',active:true}];
 const sessions=[{id:'s1',title:'任务一',directory:'/tmp/a'},{id:'s2',title:'任务二',directory:'/tmp/b'},{id:'s3',title:'任务三',directory:'/tmp/c'}];
 assert.deepEqual(viewedIds(sessions,tabs),['s2']);
 assert.deepEqual(viewedIds(sessions,[{id:'t1',title:'OC | 任务一',cwd:'/tmp/a',active:false}]),[]);
 assert.deepEqual(viewedIds([],tabs),[]);
 assert.deepEqual(viewedIds(sessions,[]),[]);
 // 聚焦的是别的窗口时，这个窗口里选中的标签页不算看过。
 assert.deepEqual(viewedIds(sessions,tabs,'w2'),[]);
 const other=[{id:'t3',title:'OC | 任务一',cwd:'/tmp/a',window_id:'w2',active:true}];
 assert.deepEqual(viewedIds(sessions,other,'w2'),['s1']);
});
