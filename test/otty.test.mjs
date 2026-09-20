import {test} from 'node:test';import assert from 'node:assert/strict';import {matchTab,viewedIds} from '../src/otty.mjs';
// Otty 标签页与会话的匹配：标题精确匹配 `OC | <标题>` 优先，其次按目录（唯一时），同目录多个再用标题包含关系。
test('会话与 Otty 标签页匹配：标题优先、目录兜底',()=>{
 const tabs=[{id:'t1',title:'OC | 任务一',cwd:'/tmp/a'},{id:'t2',title:'别的',cwd:'/tmp/b'},{id:'t3',title:'',cwd:'/tmp/c'}];
 assert.equal(matchTab(tabs,{title:'任务一'})?.id,'t1');
 assert.equal(matchTab(tabs,{title:'没有的标题',directory:'/tmp/c'})?.id,'t3');
 assert.equal(matchTab(tabs,{title:'没有的标题',directory:'/tmp/b'})?.id,'t2');
 assert.equal(matchTab(tabs,{title:'',directory:'/tmp/none'}),null);
 assert.equal(matchTab(undefined,{title:'任务一'}),null);
});
// omp 的 TUI 用 `π <标题>` 命名标签，运行中前缀后面多一个 spinner：跳过非文字字符再精确匹配。
test('omp 标签页：带 spinner 的标题也能匹配',()=>{
 const tabs=[{id:'o1',title:'π ⠼ 修个 bug',cwd:'/tmp/a',window_id:'w1',active:true},{id:'o2',title:'π 别的',cwd:'/tmp/b'}];
 assert.equal(matchTab(tabs,{title:'修个 bug',source:'omp'})?.id,'o1');
 assert.equal(matchTab(tabs,{title:'没有的',directory:'/tmp/b',source:'omp'})?.id,'o2');
 assert.deepEqual(viewedIds([{id:'s1',title:'修个 bug',directory:'/tmp/a'}],tabs),['s1']);
});
// Claude Code 的标签名是 `✳ <标题>`。
test('Claude Code 标签页：✳ 前缀也能匹配',()=>{
 const tabs=[{id:'c1',title:'✳ 修复登录',cwd:'/tmp/a',window_id:'w1',active:true},{id:'c2',title:'别的',cwd:'/tmp/b'}];
 assert.equal(matchTab(tabs,{title:'修复登录',source:'claude'})?.id,'c1');
 assert.equal(matchTab(tabs,{title:'没有的',directory:'/tmp/b',source:'claude'})?.id,'c2');
 assert.deepEqual(viewedIds([{id:'s1',title:'修复登录',directory:'/tmp/a'}],tabs),['s1']);
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
