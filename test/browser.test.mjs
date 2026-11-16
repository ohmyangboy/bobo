import {test} from 'node:test';import assert from 'node:assert/strict';
import {chromiumFocusScript,safariFocusScript,chromiumActiveTabScript,safariActiveTabScript,matchUrlSession,escapeAppleScript} from '../src/browser.mjs';
// 浏览器聚焦：按标签 URL 找已经打开的那个页面（带 / 不带尾斜杠都算），命中就切过去，不新开标签。
test('浏览器聚焦脚本：按 URL 找已打开的标签',()=>{
 const g=chromiumFocusScript('Google Chrome','http://127.0.0.1:3080/');
 assert.ok(g.includes('tell application "Google Chrome"'));
 assert.ok(g.includes('set u to "http://127.0.0.1:3080/"'));
 assert.ok(g.includes('set b to "http://127.0.0.1:3080"'),'不带尾斜杠的候选也要比较');
 assert.ok(g.includes('set active tab index of w to ti'));
 assert.ok(g.includes('set index of w to 1'),'把窗口提到最前');
 assert.ok(g.lastIndexOf('return "false"')>g.indexOf('return "true"'),'没找到才返回 false');
 const s=safariFocusScript('http://x/');
 assert.ok(s.includes('tell application "Safari"'));
 assert.ok(s.includes('set current tab of w to tab ti of w'),'Safari 用 current tab 选中');
});
// URL / 应用名里的引号与反斜杠必须转义，否则 AppleScript 会语法错误。
test('浏览器聚焦脚本：转义',()=>{
 assert.equal(escapeAppleScript('a"b\\c'),'a\\"b\\\\c');
 const s=safariFocusScript('http://x/"?a=1');
 assert.ok(s.includes('http://x/\\"?a=1'));
});
test('浏览器活动标签读取脚本',()=>{
 const c=chromiumActiveTabScript('Google Chrome');
 assert.ok(c.includes('tell application "Google Chrome"'));
 assert.ok(c.includes('URL of active tab of front window'));
 assert.ok(c.includes('title of active tab of front window'));
 const s=safariActiveTabScript();
 assert.ok(s.includes('tell application "Safari"'));
 assert.ok(s.includes('URL of current tab of front window'));
});
test('浏览器 URL 匹配会话：ChatGPT / Claude / T3 / DeepSeek 多会话精确匹配',()=>{
 const sessions=[
  {id:'codex:01a07b1a-863c-73c1-ae29-9a929ce3bc57',sessionId:'01a07b1a-863c-73c1-ae29-9a929ce3bc57',title:'ChatGPT 会话一'},
  {id:'codex:01a07b1a-863c-73c1-ae29-9a929ce3bc58',sessionId:'01a07b1a-863c-73c1-ae29-9a929ce3bc58',title:'ChatGPT 会话二'},
  {id:'claude:c-12345',sessionId:'c-12345',title:'Claude 任务'},
  {id:'t3:ea98a9f6-5d33-4d3d-98d4-f942be89b2ee',sessionId:'ea98a9f6-5d33-4d3d-98d4-f942be89b2ee',title:'T3 任务'},
  {id:'dsh:d-1',source:'dsh',title:'DeepSeek 会话'},
 ];
 // 多个 ChatGPT 会话中，精准匹配正在看的那一条
 assert.equal(matchUrlSession(sessions,'https://chatgpt.com/c/01a07b1a-863c-73c1-ae29-9a929ce3bc57'),'codex:01a07b1a-863c-73c1-ae29-9a929ce3bc57');
 assert.equal(matchUrlSession(sessions,'https://chatgpt.com/c/01a07b1a-863c-73c1-ae29-9a929ce3bc58'),'codex:01a07b1a-863c-73c1-ae29-9a929ce3bc58');
 assert.equal(matchUrlSession(sessions,'https://claude.ai/chat/c-12345'),'claude:c-12345');
 assert.equal(matchUrlSession(sessions,'http://127.0.0.1:3773/#/threads/ea98a9f6-5d33-4d3d-98d4-f942be89b2ee'),'t3:ea98a9f6-5d33-4d3d-98d4-f942be89b2ee');
 assert.equal(matchUrlSession(sessions,'http://localhost:5200/'),'dsh:d-1');
 // 网页标题命中
 assert.equal(matchUrlSession(sessions,'https://example.com/','T3 任务 · Workspace'),'t3:ea98a9f6-5d33-4d3d-98d4-f942be89b2ee');
 // 无关网页不命中
 assert.equal(matchUrlSession(sessions,'https://github.com/'),null);
 assert.equal(matchUrlSession([], 'https://chatgpt.com/'),null);
 assert.equal(matchUrlSession(sessions, ''),null);
});
