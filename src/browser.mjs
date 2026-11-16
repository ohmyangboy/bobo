// 「把用户带到一个已经打开的网页」：优先切到浏览器里已经打开这个 URL 的标签页（不新开），
// 找不到才用系统默认浏览器打开。macOS 走 AppleScript（Chromium 系与 Safari 的标签都能读 URL），
// 其它平台直接 open。只读标签、只切标签，不改浏览器的任何配置。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const OSASCRIPT = '/usr/bin/osascript', LSAPPINFO = '/usr/bin/lsappinfo';
// 支持 `windows`/`tabs`/`URL` 字典的 Chromium 浏览器（Arc 等自成一系的 AppleScript 不支持这组字典，故意不列）。
const CHROMIUM = [['Google Chrome', 'com.google.Chrome'], ['Microsoft Edge', 'com.microsoft.edgemac'], ['Brave Browser', 'com.brave.Browser'], ['Vivaldi', 'com.vivaldi.Vivaldi'], ['Chromium', 'org.chromium.Chromium']];
const SAFARI = [['Safari', 'com.apple.Safari']];

const SEP = '\u001f';
export const BROWSER_BUNDLES = new Set([...CHROMIUM.map(x => x[1]), ...SAFARI.map(x => x[1])]);

const run = (bin, args) => new Promise(resolve => {
 let out = '', settled = false, timer;
 const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
 const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
 timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: 1, out }); }, 2000);
 child.stdout.on('data', b => out += b);
 child.on('error', () => finish({ code: 1, out: '' }));
 child.on('close', code => finish({ code: code ?? 1, out }));
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

// 读取 Chromium 系前台激活标签页的 URL 与标题
export function chromiumActiveTabScript(app) {
 return `tell application "${escapeAppleScript(app)}"
 try
  if (count of windows) > 0 then
   set t to (URL of active tab of front window)
   set ti to (title of active tab of front window)
   return (t as text) & "${SEP}" & (ti as text)
  end if
 end try
 return ""
end tell`;
}

// 读取 Safari 前台激活标签页的 URL 与标题
export function safariActiveTabScript() {
 return `tell application "Safari"
 try
  if (count of windows) > 0 then
   set t to (URL of current tab of front window)
   set ti to (name of current tab of front window)
   return (t as text) & "${SEP}" & (ti as text)
  end if
 end try
 return ""
end tell`;
}

// 纯函数：将浏览器激活标签页的 URL / 标题与会话列表比对，命中返回会话 ID
export function matchUrlSession(sessions, url, title = '') {
 if ((!url && !title) || !sessions?.length) return null;
 const u = String(url || '').trim(), ti = String(title || '').trim();
 for (const s of sessions) {
  if (!s?.id) continue;
  const rawId = s.id.replace(/^[a-z0-9_-]+:/, '');
  if (rawId && u && u.includes(rawId)) return s.id;
  if (s.sessionId && u && u.includes(s.sessionId)) return s.id;
 }
 const chatgpt = u.match(/chatgpt\.com\/(?:g\/[^/]+\/)?c\/([a-zA-Z0-9_-]+)/);
 if (chatgpt) {
  const hit = sessions.find(s => s.id === 'codex:' + chatgpt[1] || s.sessionId === chatgpt[1] || s.id.endsWith(chatgpt[1]));
  if (hit) return hit.id;
 }
 const claude = u.match(/claude\.ai\/chat\/([a-zA-Z0-9_-]+)/);
 if (claude) {
  const hit = sessions.find(s => s.id === 'claude:' + claude[1] || s.sessionId === claude[1] || s.id.endsWith(claude[1]));
  if (hit) return hit.id;
 }
 const t3 = u.match(/(?:threads|t)\/([a-zA-Z0-9_-]+)/);
 if (t3 && (u.includes(':3773') || u.startsWith('t3code:'))) {
  const hit = sessions.find(s => s.id === 't3:' + t3[1] || s.sessionId === t3[1] || s.id.endsWith(t3[1]));
  if (hit) return hit.id;
 }
 if (u.includes(':5200') || (u.includes('deepseek.com') && u.includes('/chat/'))) {
  const hit = sessions.find(s => s.source === 'dsh');
  if (hit) return hit.id;
 }
 if (ti) {
  const hit = sessions.find(s => s.title && (ti === s.title || ti.startsWith(s.title + ' ') || ti.includes(' - ' + s.title) || ti.includes(s.title + ' · ')));
  if (hit) return hit.id;
 }
 return null;
}

// 纯函数：从 unviewed 会话中按 id / threadId / url / title 匹配目标会话
export function findViewedTarget(sessions, query = {}) {
 if (!query || typeof query !== 'object') return '';
 const id = String(query.id || '').trim();
 if (id) return id;
 const threadId = String(query.threadId || query.sessionId || '').trim();
 if (threadId) {
  const hit = (sessions || []).find(s => s.id === threadId || s.id.endsWith(':' + threadId) || s.sessionId === threadId);
  if (hit) return hit.id;
 }
 const url = String(query.url || '').trim();
 if (url) {
  const hit = matchUrlSession(sessions, url, query.title);
  if (hit) return hit;
 }
 const title = String(query.title || '').trim();
 if (title) {
  const hit = (sessions || []).find(s => s.title === title || s.title?.includes(title));
  if (hit) return hit.id;
 }
 return '';
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

 // 获取前台浏览器激活标签页信息（URL 与标题）
 async function activeTab(front) {
  if (process.platform !== 'darwin' || !existsSync(OSASCRIPT) || !front) return null;
  const chromium = CHROMIUM.find(([_, b]) => b === front);
  if (chromium) {
   const r = await run(OSASCRIPT, ['-e', chromiumActiveTabScript(chromium[0])]);
   const [url, title] = r.out.trim().split(SEP);
   return url || title ? { url: url || '', title: title || '', app: chromium[0] } : null;
  }
  if (SAFARI.some(([_, b]) => b === front)) {
   const r = await run(OSASCRIPT, ['-e', safariActiveTabScript()]);
   const [url, title] = r.out.trim().split(SEP);
   return url || title ? { url: url || '', title: title || '', app: 'Safari' } : null;
  }
  return null;
 }

 // 只有当前台是受支持的浏览器时，检查当前激活标签页是否命中未查看会话
 async function viewed(sessions, front = '') {
  if (!sessions?.length || !front) return [];
  if (!BROWSER_BUNDLES.has(front)) return [];
  const tab = await activeTab(front);
  if (!tab) return [];
  const id = matchUrlSession(sessions, tab.url, tab.title);
  return id ? [id] : [];
 }

 return { focus, activeTab, viewed };
}
