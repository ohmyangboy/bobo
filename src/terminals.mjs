// 多终端跳转：按顺序试 Otty → Ghostty → Terminal.app，谁先匹配到会话就跳谁；都没匹配到就激活正在运行的那个（都不在跑就打开第一个装了的）。
// Codex 桌面版（Codex.app / ChatGPT.app，bundle id com.openai.codex）不算终端：它的界面支持线程级深链
// `codex://threads/<会话 id>`，直接切到那个线程——app 里跑的会话优先走它，CLI 会话在终端里一个标签页
// 都没匹配到、而 app 又在跑时也退到这里（比激活一个空终端有用）。
// Otty 走自带的 otty-cli；Ghostty 与 Terminal.app 走 AppleScript（osascript，首次会触发 macOS 自动化权限授权）。
// bobo 的会话只有目录与标题（没有 tty）：Ghostty 按工作目录匹配，Terminal 按 custom title（OpenCode 集成写成 `OC | <标题>`，
// omp 写成 `π <标题>`），都退到「标题 / 目录名包含」兜底；只有终端在前台、且正停在对应标签页时才算用户「看过了」。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createOtty } from './otty.mjs';

const GHOSTTY_APP = '/Applications/Ghostty.app', GHOSTTY_BUNDLE = 'com.mitchellh.ghostty';
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app', TERMINAL_BUNDLE = 'com.apple.Terminal';
const CODEX_APP = 'Codex App', CODEX_APP_BUNDLE = 'com.openai.codex';
const OSASCRIPT = '/usr/bin/osascript', LSAPPINFO = '/usr/bin/lsappinfo', OPEN = '/usr/bin/open';
// 列表输出用 ASCII 单元分隔符（0x1f）分隔字段、换行分隔记录：标题里基本不可能出现，避免撞分隔符。
const SEP = '\u001f';
// 标签名前缀：OpenCode 集成按 `OC | <会话标题>` 命名标签，omp 的 TUI 用 `π <标题>`
// （运行中前缀后多一个 spinner，见 sameTabTitle），Claude Code 用 `✳ <标题>`，
// Codex 的以实际显示为准逐个尝试。
const TITLE_PREFIX = { opencode: ['OC | '], codex: ['CX | ', 'Codex | ', 'CDX | '], omp: ['π '], claude: ['✳ '] };

const run = (bin, args) => new Promise(resolve => {
 let out = '';
 const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
 child.stdout.on('data', b => out += b);
 child.on('error', () => resolve({ code: 1, out: '' }));
 child.on('close', code => resolve({ code: code ?? 1, out }));
});
const openApp = app => { try { spawn('open', [app], { shell: false, stdio: 'ignore' }).on('error', () => {}); } catch {} };

// AppleScript 字符串字面量转义（反斜杠与双引号）。
export function escapeAppleScript(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
// 目录归一化：去空白与结尾斜杠；macOS 上 /tmp 与 /private/tmp、/var 与 /private/var 是同一处。
export function samePath(a, b) {
 const norm = p => { const s = String(p ?? '').trim().replace(/\/+$/, ''); return s || '/'; };
 const strip = s => s.replace(/^\/(?:private|System\/Volumes\/Data)\//, '/');
 const x = norm(a), y = norm(b);
 return x === y || (x !== '/' && y !== '/' && strip(x) === strip(y));
}
// 会话的目录名（会话自带 name 时优先）。
export function folderName(directory, name) {
 const n = String(name ?? '').trim();
 if (n) return n;
 const d = String(directory ?? '').trim().replace(/\/+$/, '');
 return d ? d.split('/').pop() : '';
}
// 标签标题与会话标题的比较：`<前缀><标题>` 相等。omp 运行中会在前缀后多一个 spinner（`π ⠼ <标题>`），
// 前缀后先把一段非文字字符去掉再比较；前缀为空时就是标题完全相等。
export function sameTabTitle(tabTitle, prefix, title) {
 const s = String(tabTitle ?? '');
 if (!prefix) return s === title;
 return s.startsWith(prefix) && s.slice(prefix.length).replace(/^[^\p{L}\p{N}]+/u, '') === title;
}
// 标签页与会话的匹配（Ghostty / Terminal / Otty 共用）：
// 1) 工作目录精确相等（Ghostty / Otty 才有 cwd）  2) 标题等于 `<前缀><会话标题>`  3) 标题包含会话标题
// 4) 同目录下标题包含目录名（会话还没拿到标题时靠它认人）  5) 同目录只剩一个标签页  6) 标题包含目录名（strict 时不做）。
export function matchTab(tabs, { title, directory, name, source = 'opencode' } = {}, { strict = false } = {}) {
 const list = (tabs || []).filter(Boolean), t = String(title ?? '').trim(), base = folderName(directory, name);
 const prefixes = [...(TITLE_PREFIX[source] || []), ''];
 const exact = x => t && prefixes.some(p => sameTabTitle(x.title, p, t));
 if (directory) {
  const same = list.filter(x => x.cwd && samePath(x.cwd, directory));
  if (same.length) return same.find(exact) || same.find(x => t && String(x.title || '').includes(t)) || same.find(x => base && String(x.title || '').includes(base)) || same[0];
 }
 if (t) {
  const hit = list.find(exact);
  if (hit) return hit;
  const contains = list.find(x => String(x.title || '').includes(t));
  if (contains) return contains;
 }
 if (strict) return null;
 return (base && list.find(x => String(x.title || '').includes(base))) || null;
}
// 当前聚焦的标签页命中了哪些会话（strict：只认目录精确或标题命中会话标题，避免同名目录误判成「看过了」）。
export function viewedIds(sessions, tabs) { return (sessions || []).filter(s => matchTab(tabs, s, { strict: true })).map(s => s.id); }
// 会话归属的终端：按适配器优先级（Otty → Ghostty → Terminal.app），第一个列到匹配标签页的终端就是归属。
// groups：`[{name, tabs}]`，按优先级排好；一个终端都没有时返回空对象（会话显示不出归属）。
export function locateSessions(sessions, groups) {
 const out = {};
 for (const g of groups || []) for (const s of sessions || []) {
  if (out[s.id] || !s?.id) continue;
  if (matchTab(g.tabs, s)) out[s.id] = g.name;
 }
 return out;
}

// Codex app 的线程深链：`codex://threads/<会话 id>`（会话 id 就是 rollout 与 app 数据库里的线程 id）。
export function codexThreadUrl(id) {
 const s = String(id ?? '').trim().replace(/^codex:/, '');
 return s ? 'codex://threads/' + encodeURIComponent(s) : '';
}
// app 里跑的会话（rollout 的 session_meta 记了 originator=Codex Desktop 等）归属 Codex app：
// 只有 app 正在跑时才算归属，点击会走线程深链而不是找终端标签页。
export function locateAppSessions(sessions, running) {
 const out = {};
 if (!running?.has?.(CODEX_APP_BUNDLE)) return out;
 for (const s of sessions || []) if (s?.id && s.app === true) out[s.id] = CODEX_APP;
 return out;
}

const lines = text => String(text ?? '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
// Ghostty：每行 `id<SEP>name<SEP>working directory`。
export function parseGhosttyTabs(text) {
 return lines(text).map(l => { const [id, title, cwd] = l.split(SEP); return { id: (id || '').trim(), title: (title || '').trim(), cwd: (cwd || '').trim() }; });
}
// Terminal.app：每行 `windowId<SEP>tab序号<SEP>tty<SEP>custom title`。
export function parseTerminalTabs(text) {
 return lines(text).map(l => { const [w, i, tty, title] = l.split(SEP); return { window: Number(w), index: Number(i), tty: (tty || '').trim(), title: (title || '').trim() }; });
}
// Terminal.app 前台窗口选中的那个标签页：`tty<SEP>custom title`。
export function parseTerminalActive(text) {
 const l = lines(text)[0]; if (!l) return null;
 const [tty, title] = l.split(SEP);
 return { tty: (tty || '').trim(), title: (title || '').trim() };
}

export function ghosttyListScript() { return `tell application "Ghostty"
 set sep to (ASCII character 31)
 set out to ""
 repeat with t in terminals
  try
   set out to out & (id of t) & sep & (name of t) & sep & (working directory of t) & (ASCII character 10)
  end try
 end repeat
 return out
end tell`; }
export function ghosttyActiveScript() { return `tell application "Ghostty"
 set sep to (ASCII character 31)
 try
  set t to focused terminal of selected tab of front window
  return (id of t) & sep & (name of t) & sep & (working directory of t)
 end try
 return ""
end tell`; }
// 先按 id 精确定位；旧版 Ghostty 不支持 id 定位时退回按工作目录找（Ghostty 官方示例的写法）。
export function ghosttyFocusScript({ id, directory } = {}) { return `tell application "Ghostty"
 try
  focus (terminal id "${escapeAppleScript(id)}")
  activate
  return "true"
 end try
 try
  set ms to (every terminal whose working directory is "${escapeAppleScript(directory)}")
  if (count of ms) > 0 then
   focus (item 1 of ms)
   activate
   return "true"
  end if
 end try
 activate
 return "false"
end tell`; }

export function terminalListScript() { return `tell application "Terminal"
 set sep to (ASCII character 31)
 set out to ""
 repeat with w in windows
  try
   repeat with i from 1 to (count of tabs of w)
    try
     set t to tab i of w
     set out to out & ((id of w) as text) & sep & (i as text) & sep & (tty of t) & sep & (custom title of t) & (ASCII character 10)
    end try
   end repeat
  end try
 end repeat
 return out
end tell`; }
export function terminalActiveScript() { return `tell application "Terminal"
 set sep to (ASCII character 31)
 try
  set t to selected tab of front window
  return (tty of t) & sep & (custom title of t)
 end try
 return ""
end tell`; }
// Terminal.app 没有 cwd 属性，只能按窗口 id + 标签页序号（列表里的顺序）定位后选中，并顺带取消最小化、提到最前。
export function terminalFocusScript({ window: win, index } = {}) { return `tell application "Terminal"
 try
  set w to (first window whose id is ${Number(win)})
 on error
  return "false"
 end try
 try
  if miniaturized of w then set miniaturized of w to false
 end try
 set selected tab of w to tab ${Number(index)} of w
 set index of w to 1
 activate
 return "true"
end tell`; }

// 前台应用的 bundleID；前台应用没有 bundleID（比如调试版可执行文件）时返回空串。
async function frontBundle() {
 const front = (await run(LSAPPINFO, ['front'])).out.trim().split('\n')[0];
 if (!front) return '';
 return (await run(LSAPPINFO, ['info', '-only', 'bundleID', front])).out.match(/bundleID="([^"]+)"/)?.[1] || '';
}
// 正在运行的应用的 bundleID 集合（判断某个终端是否开着）。
async function runningBundles() { return new Set([...(await run(LSAPPINFO, ['list'])).out.matchAll(/bundleID="([^"]+)"/g)].map(m => m[1])); }

export function createTerminals() {
 const otty = createOtty();
 const ghostty = {
  name: 'Ghostty', bundle: GHOSTTY_BUNDLE,
  available: () => existsSync(GHOSTTY_APP),
  open: () => openApp(GHOSTTY_APP),
  tabs: async () => parseGhosttyTabs((await run(OSASCRIPT, ['-e', ghosttyListScript()])).out),
  async focus({ title, directory, name, source } = {}) {
   const tabs = parseGhosttyTabs((await run(OSASCRIPT, ['-e', ghosttyListScript()])).out);
   const target = matchTab(tabs, { title, directory, name, source });
   if (!target) return { ok: false };
   const r = await run(OSASCRIPT, ['-e', ghosttyFocusScript({ id: target.id, directory })]);
   return r.out.includes('true') ? { ok: true, title: target.title } : { ok: false };
  },
  async viewed(sessions) {
   if (!sessions?.length || await frontBundle() !== GHOSTTY_BUNDLE) return [];
   const tab = parseGhosttyTabs((await run(OSASCRIPT, ['-e', ghosttyActiveScript()])).out)[0];
   return tab ? viewedIds(sessions, [tab]) : [];
  },
 };
 const terminal = {
  name: 'Terminal', bundle: TERMINAL_BUNDLE,
  available: () => existsSync(TERMINAL_APP),
  open: () => openApp(TERMINAL_APP),
  tabs: async () => parseTerminalTabs((await run(OSASCRIPT, ['-e', terminalListScript()])).out),
  async focus({ title, directory, name, source } = {}) {
   const tabs = parseTerminalTabs((await run(OSASCRIPT, ['-e', terminalListScript()])).out);
   const target = matchTab(tabs, { title, directory, name, source });
   if (!target) return { ok: false };
   const r = await run(OSASCRIPT, ['-e', terminalFocusScript(target)]);
   return r.out.includes('true') ? { ok: true, title: target.title } : { ok: false };
  },
  async viewed(sessions) {
   if (!sessions?.length || await frontBundle() !== TERMINAL_BUNDLE) return [];
   const tab = parseTerminalActive((await run(OSASCRIPT, ['-e', terminalActiveScript()])).out);
   return tab ? viewedIds(sessions, [tab]) : [];
  },
 };
 const adapters = [
  { name: 'Otty', bundle: 'io.appmakes.otty', available: () => otty.available(), open: () => otty.open(),
   // 用下面这套 matchTab 匹配 Otty 标签页：与「会话归属哪个终端」同一套规则，显示成 Otty 的会话一定跳得过去。
   focus: async o => { const target = matchTab(await otty.tabs(), o); return target?.id ? otty.focusTab(target.id) : { ok: false }; },
   viewed: s => otty.viewed(s), tabs: () => otty.tabs() },
  ghostty, terminal,
 ];
 // 打开 Codex app 里的某个线程（`codex://threads/<id>`）：app 不在跑也会被 open 拉起；
 // app 没装 / 装不上时 open 返回非 0，交给上层继续找终端标签页。
 async function focusApp({ id, sessionId } = {}) {
  const url = codexThreadUrl(sessionId || id);
  if (!url) return { ok: false, reason: '缺少会话 id' };
  const r = await run(OPEN, [url]);
  return r.code === 0 ? { ok: true, app: CODEX_APP, url } : { ok: false, reason: '没有找到 Codex 桌面版' };
 }
 // 只对「装了的、且正在运行」的终端尝试跳转（会话在哪个终端，那个终端就一定开着）；都没匹配到再激活正在运行的那个。
 async function focus(opts = {}) {
  const running = await runningBundles();
  // Codex app 里跑的会话（rollout 的 originator 是 Desktop / source 是 vscode、appserver）直接跳线程深链，不找终端。
  if (opts.app === true) { const r = await focusApp(opts); if (r.ok) return r; }
  for (const a of adapters) {
   if (!a.available() || !running.has(a.bundle)) continue;
   const r = await a.focus(opts);
   if (r?.ok) return r;
  }
  // Codex 会话在终端里一个标签页都没匹配到、而 app 开着：多半是 app 里跑的（同一条 rollout 也可能记成 codex-tui），
  // 带用户去 app 看比激活一个空终端有用；app 打不开再退回原来的兜底。
  if (opts.source === 'codex' && running.has(CODEX_APP_BUNDLE)) { const r = await focusApp(opts); if (r.ok) return r; }
  const target = adapters.find(a => a.available() && running.has(a.bundle)) || adapters.find(a => a.available());
  if (!target) return { ok: false, reason: '没有可用的终端' };
  target.open();
  return { ok: false, reason: `没有找到对应的 ${target.name} 标签页` };
 }
 // 只有在前台的那个终端才可能「正停在会话的标签页上」，各适配器自己判断前台，这里合并。
 async function viewed(sessions) {
  if (!sessions?.length) return [];
  const ids = new Set();
  for (const a of adapters) { if (a.available()) for (const id of await a.viewed(sessions)) ids.add(id); }
  return [...ids];
 }
 // 会话归属：只扫正在运行的终端（不为了看一眼归属就把没开的终端拉起来），返回 `{会话 id: 终端名}`；
 // app 里跑的会话归属 Codex app（点击走线程深链），剩下的再按终端标签页匹配。
 async function locate(sessions) {
  if (!sessions?.length) return {};
  const running = await runningBundles(), groups = [], app = locateAppSessions(sessions, running);
  for (const a of adapters) { if (a.available() && running.has(a.bundle)) groups.push({ name: a.name, tabs: await a.tabs() }); }
  return { ...app, ...locateSessions(sessions.filter(s => !app[s.id]), groups) };
 }
 return { focus, focusApp, viewed, locate, available: () => adapters.some(a => a.available()) };
}
