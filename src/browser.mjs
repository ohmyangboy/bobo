// 「把用户带到一个已经打开的网页」：优先切到浏览器里已经打开这个 URL 的标签页（不新开），
// 找不到才用系统默认浏览器打开。macOS 走 AppleScript（Chromium 系与 Safari 的标签都能读 URL），
// 其它平台直接 open。只读标签、只切标签，不改浏览器的任何配置。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const OSASCRIPT = '/usr/bin/osascript', LSAPPINFO = '/usr/bin/lsappinfo';
// 支持 `windows`/`tabs`/`URL` 字典的 Chromium 浏览器（Arc 等自成一系的 AppleScript 不支持这组字典，故意不列）。
const CHROMIUM = [['Google Chrome', 'com.google.Chrome'], ['Microsoft Edge', 'com.microsoft.edgemac'], ['Brave Browser', 'com.brave.Browser'], ['Vivaldi', 'com.vivaldi.Vivaldi'], ['Chromium', 'org.chromium.Chromium']];
const SAFARI = [['Safari', 'com.apple.Safari']];

const run = (bin, args) => new Promise(resolve => {
 let out = '';
 const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
 child.stdout.on('data', b => out += b);
 child.on('error', () => resolve({ code: 1, out: '' }));
 child.on('close', code => resolve({ code: code ?? 1, out }));
});
const openUrl = url => { try { spawn('open', [url], { shell: false, stdio: 'ignore' }).on('error', () => {}); } catch {} };

// AppleScript 字符串字面量转义（反斜杠与双引号），与 terminals.mjs 的 escapeAppleScript 一致。
export function escapeAppleScript(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
// Chromium 系：按标签 URL 找（带 / 不带尾斜杠都算），命中就选中那个标签、把窗口提到最前。
export function chromiumFocusScript(app, url) {
 return `tell application "${app}"
 set u to "${escapeAppleScript(url)}"
 set b to "${escapeAppleScript(String(url).replace(/\/+$/, ''))}"
 repeat with wi from 1 to (count of windows)
  set w to window wi
  repeat with ti from 1 to (count of tabs of w)
   set t to (URL of tab ti of w)
   if t is u or t is b then
    set active tab index of w to ti
    set index of w to 1
    activate
    return "true"
   end if
  end repeat
 end repeat
 activate
 return "false"
end tell`;
}
// Safari 的选中是 `current tab`，其余相同。
export function safariFocusScript(url) {
 return `tell application "Safari"
 set u to "${escapeAppleScript(url)}"
 set b to "${escapeAppleScript(String(url).replace(/\/+$/, ''))}"
 repeat with wi from 1 to (count of windows)
  set w to window wi
  repeat with ti from 1 to (count of tabs of w)
   set t to (URL of tab ti of w)
   if t is u or t is b then
    set current tab of w to tab ti of w
    set index of w to 1
    activate
    return "true"
   end if
  end repeat
 end repeat
 activate
 return "false"
end tell`;
}

// 正在运行的应用的 bundleID 集合（只挑真的开着的浏览器，不为看一眼把没开的拉起来）。
async function runningBundles() { return new Set([...(await run(LSAPPINFO, ['list'])).out.matchAll(/bundleID="([^"]+)"/g)].map(m => m[1])); }

export function createBrowser() {
 // 把用户带到 url：先在各浏览器里找已经打开的标签，命中就切过去（focused: true）；
 // 都没有才 `open`（系统默认浏览器；Chromium 系遇到同一个 URL 通常也会复用已有标签）。
 async function focus(url) {
  if (process.platform !== 'darwin' || !existsSync(OSASCRIPT)) { openUrl(url); return { ok: true, focused: false, opened: true }; }
  const running = await runningBundles();
  const adapters = [
   ...CHROMIUM.map(([app, bundle]) => ({ app, bundle, script: () => chromiumFocusScript(app, url) })),
   ...SAFARI.map(([app, bundle]) => ({ app, bundle, script: () => safariFocusScript(url) })),
  ];
  for (const a of adapters) {
   if (!running.has(a.bundle)) continue;
   const r = await run(OSASCRIPT, ['-e', a.script()]);
   if (r.out.includes('true')) return { ok: true, focused: true, app: a.app };
  }
  openUrl(url);
  return { ok: true, focused: false, opened: true };
 }
 return { focus };
}
