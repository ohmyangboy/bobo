// Otty 的连接层：只负责跑 otty-cli 拿标签页 / 窗口、聚焦某个标签页、打开应用。
// 会话与标签页的匹配（含各 Agent 的标题前缀）与「看过了」的判断都在 terminals.mjs 里（那套 matchTab 同时决定
// 「会话归属哪个终端」），这里不再复制一份，避免两边前缀表各改各的。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const APP = '/Applications/Otty.app', CLI = APP + '/Contents/MacOS/otty-cli';
const run = (bin, args) => new Promise(resolve => {
 let out = '', settled = false, timer;
 const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
 const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
 timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: 1, out }); }, 5000);
 child.stdout.on('data', b => out += b);
 child.on('error', () => finish({ code: 1, out: '' }));
 child.on('close', code => finish({ code: code ?? 1, out }));
});
export function createOtty() {
 const openApp = () => { try { spawn('open', [APP], { shell: false, stdio: 'ignore' }).on('error', () => {}); } catch {} };
 const tabs = async () => { try { return JSON.parse((await run(CLI, ['tab', 'list', '--json'])).out)?.data || []; } catch { return []; } };
 const windows = async () => { try { return JSON.parse((await run(CLI, ['window', 'list', '--json'])).out)?.data || []; } catch { return []; } };
 // 聚焦指定标签页：匹配规则由 terminals.mjs 统一提供（与「会话归属哪个终端」用同一套），
 // 这样面板上显示成 Otty 的会话一定跳得过去。
 async function focusTab(id) {
  if (!id || !existsSync(CLI)) return { ok: false, reason: 'Otty 未安装' };
  if ((await run(CLI, ['tab', 'focus', id])).code === 0) { openApp(); return { ok: true, tab: id }; }
  return { ok: false, reason: '没有找到对应的 Otty 标签页' };
 }
 return { focusTab, tabs, windows, available: () => existsSync(CLI), open: openApp };
}
