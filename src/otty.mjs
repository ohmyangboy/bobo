// 把 bobo 里的 OpenCode 会话跳转到 Otty：Otty 的 opencode 集成会把标签页标题设为 `OC | <会话标题>`，
// 所以优先按标题匹配，其次按目录（目录下只有一个标签页时）；找不到只回报失败，由 terminals.mjs 决定后续（打开 / 换别的终端）。
// 「看过了」也走同一套匹配：Otty 在前台、且当前停留（active）在这个会话的标签页上，才算用户真的看过。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const APP = '/Applications/Otty.app', CLI = APP + '/Contents/MacOS/otty-cli', BUNDLE = 'io.appmakes.otty';
const run = (bin, args) => new Promise(resolve => {
 let out = '';
 const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
 child.stdout.on('data', b => out += b);
 child.on('error', () => resolve({ code: 1, out: '' }));
 child.on('close', code => resolve({ code: code ?? 1, out }));
});
// 会话与标签页的匹配规则（focus 与「看过了」共用）：标题精确匹配 `<前缀><标题>`（OpenCode 是 `OC | `，
// omp 是 `π ` 且运行中前缀后多一个 spinner，Codex 的标签前缀以 Otty 实际显示为准逐个尝试），
// 其次按目录（唯一时），同目录多个再用标题包含关系挑一个。标题比较与 terminals.mjs 的 sameTabTitle 保持一致。
const TITLE_PREFIX={opencode:['OC | '],codex:['CX | ','Codex | ','CDX | '],omp:['π '],claude:['✳ ']};
const titleMatches=(tabTitle,prefix,title)=>{
 const s=String(tabTitle??'');
 if(!prefix)return s===title;
 return s.startsWith(prefix)&&s.slice(prefix.length).replace(/^[^\p{L}\p{N}]+/u,'')===title;
};
export function matchTab(tabs, { title, directory, source = 'opencode' } = {}) {
 const list = tabs || [];
 const prefixes = [...(TITLE_PREFIX[source] || []), ''];
 let target = title ? list.find(t => prefixes.some(p => titleMatches(t.title, p, title))) : null;
 if (!target && directory) {
  const same = list.filter(t => t.cwd === directory);
  target = same.length === 1 ? same[0] : same.find(t => title && String(t.title || '').includes(title)) || null;
 }
 return target || null;
}
// 这些会话里，Otty 当前停留（active）的标签页对应的那些 id。
// focusWindow：多窗口时只认当前聚焦窗口里的标签页（别的窗口选中的标签页用户并没有在看）。
export function viewedIds(sessions, tabs, focusWindow) {
 const active = (tabs || []).filter(t => t.active === true && (!focusWindow || t.window_id === focusWindow));
 return (sessions || []).filter(s => matchTab(active, s)).map(s => s.id);
}
export function createOtty() {
 const openApp = () => { try { spawn('open', [APP], { shell: false, stdio: 'ignore' }).on('error', () => {}); } catch {} };
 const tabs = async () => { try { return JSON.parse((await run(CLI, ['tab', 'list', '--json'])).out)?.data || []; } catch { return []; } };
 const windows = async () => { try { return JSON.parse((await run(CLI, ['window', 'list', '--json'])).out)?.data || []; } catch { return []; } };
 // 前台应用是不是 Otty：不在前台时 active 只代表「窗口内选中」，用户可能根本没在看，不能算看过。
 // lsappinfo 是系统自带的只读命令；拿不到就当作不在前台（头像多留一会儿，比误判成看过安全）。
 const frontmost = async () => {
  const front = (await run('/usr/bin/lsappinfo', ['front'])).out.trim().split('\n')[0];
  return front ? (await run('/usr/bin/lsappinfo', ['info', '-only', 'bundleID', front])).out.includes(BUNDLE) : false;
 };
 // 聚焦指定标签页：匹配规则由 terminals.mjs 统一提供（与「会话归属哪个终端」用同一套），
 // 这样面板上显示成 Otty 的会话一定跳得过去。
 async function focusTab(id) {
  if (!id || !existsSync(CLI)) return { ok: false, reason: 'Otty 未安装' };
  if ((await run(CLI, ['tab', 'focus', id])).code === 0) { openApp(); return { ok: true, tab: id }; }
  return { ok: false, reason: '没有找到对应的 Otty 标签页' };
 }
 // 这些会话里，用户已经看过（Otty 在前台且正停在对应标签页）的 id。
 async function viewed(sessions) {
  if (!sessions?.length || !existsSync(CLI)) return [];
  if (!(await frontmost())) return [];
  const focus = (await windows()).find(w => w.focused === true)?.id;
  return viewedIds(sessions, await tabs(), focus);
 }
 return { focusTab, viewed, tabs, available: () => existsSync(CLI), open: openApp };
}
