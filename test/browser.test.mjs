import {test} from 'node:test';import assert from 'node:assert/strict';
import {chromiumFocusScript,safariFocusScript,escapeAppleScript} from '../src/browser.mjs';
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
