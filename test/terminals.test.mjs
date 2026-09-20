import {test} from 'node:test';import assert from 'node:assert/strict';
import {matchTab,viewedIds,locateSessions,locateAppSessions,codexThreadUrl,parseGhosttyTabs,parseTerminalTabs,parseTerminalActive,folderName,samePath,sameTabTitle,escapeAppleScript,ghosttyFocusScript,terminalFocusScript} from '../src/terminals.mjs';
const SEP='\u001f';
// 目录比较：结尾斜杠与 /private 前缀（/tmp、/var 在 macOS 上指向私有目录）都算同一处。
test('目录比较：忽略结尾斜杠与 /private 前缀',()=>{
 assert.equal(samePath('/tmp/a/','/tmp/a'),true);
 assert.equal(samePath('/tmp/a','/private/tmp/a'),true);
 assert.equal(samePath('/var','/private/var'),true);
 assert.equal(samePath('/tmp/a','/tmp/b'),false);
 assert.equal(samePath('','/tmp'),false);
});
// 会话目录名：自带 name 时优先，否则取目录最后一段。
test('目录名：name 优先，其次目录最后一段',()=>{
 assert.equal(folderName('/tmp/proj',''),'proj');
 assert.equal(folderName('/tmp/proj/',''),'proj');
 assert.equal(folderName('/tmp/proj','自定义'),'自定义');
 assert.equal(folderName('',''),'');
});
// AppleScript 转义：反斜杠与双引号。
test('AppleScript 字符串转义',()=>{
 assert.equal(escapeAppleScript('a"b\\c'),'a\\"b\\\\c');
 assert.equal(escapeAppleScript(undefined),'');
});
// 匹配顺序：Ghostty 先按工作目录，再按 `前缀+标题`，再标题包含，最后目录名包含（strict 时不做最后一步）。
test('标签页匹配：目录优先、标题前缀、标题包含',()=>{
 const tabs=[
  {id:'g1',title:'OC | 任务一',cwd:'/tmp/a'},
  {id:'g2',title:'OC | 任务二',cwd:'/tmp/a'},
  {id:'g3',title:'OC | 任务三',cwd:'/tmp/c'},
 ];
 assert.equal(matchTab(tabs,{title:'任务三',directory:'/tmp/c'})?.id,'g3');
 // 同目录多个：目录命中后优先标题相等的那一个。
 assert.equal(matchTab(tabs,{title:'任务二',directory:'/tmp/a'})?.id,'g2');
 // 没有 cwd 的终端（Terminal.app）：按 `OC | 标题` 精确命中。
 assert.equal(matchTab(tabs,{title:'任务一',directory:'/none/where'})?.id,'g1');
 // Codex 前缀也认。
 assert.equal(matchTab([{id:'c1',title:'CX | 修 bug',cwd:''}],{title:'修 bug',source:'codex'})?.id,'c1');
});
// 会话还没拿到标题（session_index 还没写名字）时，同一个目录下靠目录名认人，别跳到同目录的别的会话标签页。
test('标签页匹配：标题为空时同目录按目录名挑',()=>{
 const tabs=[
  {id:'oc',title:'OC | 接入 OMP 识别功能',cwd:'/tmp/bobo'},
  {id:'cx',title:'Respond to greeting | bobo',cwd:'/tmp/bobo'},
 ];
 assert.equal(matchTab(tabs,{title:'',directory:'/tmp/bobo',name:'bobo'})?.id,'cx');
 // 有标题时仍按标题走。
 assert.equal(matchTab(tabs,{title:'接入 OMP 识别功能',directory:'/tmp/bobo',name:'bobo'})?.id,'oc');
});
// omp 的 TUI 用 `π <标题>` 命名标签，运行中前缀后面多一个 spinner（`π ⠼ <标题>`）：跳过非文字字符再比较。
test('标签页匹配：omp 的运行中 spinner',()=>{
 const tabs=[{id:'o1',title:'π ⠼ 修个 bug',cwd:'/tmp/a'},{id:'o2',title:'π 修个 bug',cwd:'/tmp/b'},{id:'o3',title:'π > bobo',cwd:''}];
 assert.equal(matchTab(tabs,{title:'修个 bug',source:'omp'})?.id,'o1');
 assert.equal(matchTab([tabs[1]],{title:'修个 bug',source:'omp'})?.id,'o2');
 assert.equal(sameTabTitle('π ⠼ 修个 bug','π ','修个 bug'),true);
 assert.equal(sameTabTitle('π 修个 bug','π ','修个 bug'),true);
 assert.equal(sameTabTitle('别的标题','π ','修个 bug'),false);
 assert.equal(sameTabTitle('π 修个 bug','', '修个 bug'),false);
 // strict（「看过了」）也认 spinner 前缀。
 assert.deepEqual(viewedIds([{id:'s1',title:'修个 bug',directory:'/tmp/a'}],[{title:'π ⠼ 修个 bug',cwd:''}]),['s1']);
});
// Claude Code 的标签名是 `✳ <标题>`（无标题时是 `✳ Claude Code`）。
test('标签页匹配：Claude Code 的 ✳ 前缀',()=>{
 const tabs=[{id:'c1',title:'✳ 修复登录',cwd:'/tmp/a'},{id:'c2',title:'✳ Claude Code',cwd:''}];
 assert.equal(matchTab(tabs,{title:'修复登录',source:'claude'})?.id,'c1');
 assert.equal(matchTab(tabs,{title:'没有的标题',directory:'/tmp/a',source:'claude'})?.id,'c1');
 assert.deepEqual(viewedIds([{id:'s1',title:'修复登录',directory:'/tmp/a'}],[{title:'✳ 修复登录',cwd:''}]),['s1']);
});
test('标签页匹配：strict 时不再用目录名兜底',()=>{
 const tabs=[{id:'t1',title:'~/code/proj — zsh',cwd:''}];
 assert.equal(matchTab(tabs,{title:'别的标题',directory:'/other/proj'})?.id,'t1');
 assert.equal(matchTab(tabs,{title:'别的标题',directory:'/other/proj'},{strict:true}),null);
});
// 「看过了」只认严格命中：目录精确相等或标题里真的带会话标题，避免同名目录误判。
test('看过终端：strict 匹配',()=>{
 const sessions=[{id:'s1',title:'任务一',directory:'/tmp/a'},{id:'s2',title:'任务二',directory:'/tmp/b'}];
 assert.deepEqual(viewedIds(sessions,[{title:'OC | 任务二',cwd:'/tmp/b'}]),['s2']);
 assert.deepEqual(viewedIds(sessions,[{title:'~/tmp/a',cwd:''}]),[]);
 assert.deepEqual(viewedIds(sessions,[]),[]);
 assert.deepEqual(viewedIds([], [{title:'OC | 任务一',cwd:'/tmp/a'}]),[]);
});
// Ghostty 列表解析：每行 id / 标题 / 工作目录。
test('Ghostty 标签页解析',()=>{
 const text=['g1'+SEP+'OC | 任务一'+SEP+'/tmp/a','g2'+SEP+''+SEP+'/tmp/b',''].join('\n');
 assert.deepEqual(parseGhosttyTabs(text),[
  {id:'g1',title:'OC | 任务一',cwd:'/tmp/a'},
  {id:'g2',title:'',cwd:'/tmp/b'},
 ]);
 assert.deepEqual(parseGhosttyTabs(''),[]);
});
// Terminal.app 列表解析：窗口 id / 标签序号 / tty / custom title。
test('Terminal 标签页解析',()=>{
 const text=['33708'+SEP+'1'+SEP+'/dev/ttys028'+SEP+'OC | 任务一','33708'+SEP+'2'+SEP+'/dev/ttys029'+SEP+''].join('\n');
 assert.deepEqual(parseTerminalTabs(text),[
  {window:33708,index:1,tty:'/dev/ttys028',title:'OC | 任务一'},
  {window:33708,index:2,tty:'/dev/ttys029',title:''},
 ]);
 assert.equal(parseTerminalActive('/dev/ttys028'+SEP+'OC | 任务一')?.title,'OC | 任务一');
 assert.equal(parseTerminalActive(''),null);
});
// 终端归属：按适配器优先级取第一个命中的终端；没有标签页命中的会话不给归属。
test('会话归属：优先取靠前终端的命中结果',()=>{
 const groups=[
  {name:'Otty',tabs:[{title:'OC | 任务一',cwd:'/tmp/a'}]},
  {name:'Ghostty',tabs:[{title:'OC | 任务二',cwd:'/tmp/b'},{title:'OC | 任务三',cwd:'/tmp/c'}]},
  {name:'Terminal',tabs:[{title:'OC | 任务三',cwd:''}]},
 ];
 const sessions=[{id:'s1',title:'任务一',directory:'/tmp/a'},{id:'s2',title:'任务二',directory:'/tmp/b'},{id:'s3',title:'任务三',directory:'/tmp/c'},{id:'s4',title:'任务四',directory:'/tmp/d'}];
 assert.deepEqual(locateSessions(sessions,groups),{s1:'Otty',s2:'Ghostty',s3:'Ghostty'});
 assert.deepEqual(locateSessions(sessions,[]),{});
 assert.deepEqual(locateSessions([],groups),{});
});
// Codex app 会话：归属显示成 Codex App（点击走线程深链），只在 app 正在跑时才算；CLI 会话照旧归终端。
test('Codex app 会话归属与线程深链',()=>{
 const running=new Set(['com.openai.codex']);
 const sessions=[{id:'codex:a',app:true},{id:'codex:b',app:false},{id:'codex:c',app:true}];
 assert.deepEqual(locateAppSessions(sessions,running),{'codex:a':'Codex App','codex:c':'Codex App'});
 assert.deepEqual(locateAppSessions(sessions,new Set(['com.apple.Terminal'])),{});
 assert.deepEqual(locateAppSessions([{id:'codex:a'}],running),{});
 assert.deepEqual(locateAppSessions([],running),{});
 assert.equal(codexThreadUrl('codex:01a07b1a-863c-73c1-ae29-9a929ce3bc57'),'codex://threads/01a07b1a-863c-73c1-ae29-9a929ce3bc57');
 assert.equal(codexThreadUrl(' 01a07b1a-863c-73c1-ae29-9a929ce3bc57 '),'codex://threads/01a07b1a-863c-73c1-ae29-9a929ce3bc57');
 assert.equal(codexThreadUrl('a b'),'codex://threads/a%20b');
 assert.equal(codexThreadUrl(''),'');
 assert.equal(codexThreadUrl(undefined),'');
});
// 聚焦脚本：id / 窗口序号经过转义与数字校验后拼进 AppleScript。
test('聚焦脚本拼接',()=>{
 const g=ghosttyFocusScript({id:'a"b',directory:'/tmp/引号"目录'});
 assert.ok(g.includes('focus (terminal id "a\\"b")'));
 assert.ok(g.includes('working directory is "/tmp/引号\\"目录"'));
 const t=terminalFocusScript({window:33708,index:2});
 assert.ok(t.includes('first window whose id is 33708'));
 assert.ok(t.includes('selected tab of w to tab 2 of w'));
});
