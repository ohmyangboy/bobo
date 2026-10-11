// Otty 的连接层：标签页 / 窗口 / pane、聚焦，以及用户主动发送的 Agent 输入。
// 会话与标签页的匹配（含各 Agent 的标题前缀）与「看过了」的判断都在 terminals.mjs 里（那套 matchTab 同时决定
// 「会话归属哪个终端」），这里不再复制一份，避免两边前缀表各改各的。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const APP = '/Applications/Otty.app', CLI = APP + '/Contents/MacOS/otty-cli';
const run = (bin, args, input) => new Promise(resolve => {
 let out = '', err = '', settled = false, timer;
 const child = spawn(bin, args, { shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
 if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
 const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
 timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: 1, out, err }); }, 5000);
 child.stdout.on('data', b => out += b);
 child.stderr.on('data', b => { err = (err + b).slice(-4096); });
 child.on('error', () => finish({ code: 1, out: '' }));
 child.on('close', code => finish({ code: code ?? 1, out, err }));
});
export function createOtty({exec=run,exists=existsSync,open}={}) {
 const openApp = open || (() => { try { spawn('open', [APP], { shell: false, stdio: 'ignore' }).on('error', () => {}); } catch {} });
 const list = async kind => { try { return JSON.parse((await exec(CLI, [kind, 'list', '--json'])).out)?.data || []; } catch { return []; } };
 const tabs = () => list('tab'), windows = () => list('window'), panes = () => list('pane');
 // 聚焦指定标签页：匹配规则由 terminals.mjs 统一提供（与「会话归属哪个终端」用同一套），
 // 这样面板上显示成 Otty 的会话一定跳得过去。
 async function focusTab(id) {
  if (!id || !exists(CLI)) return { ok: false, reason: 'Otty 未安装' };
  if ((await exec(CLI, ['tab', 'focus', id])).code === 0) { openApp(); return { ok: true, tab: id }; }
  return { ok: false, reason: '没有找到对应的 Otty 标签页' };
 }
 async function sendBytes(pane, input) {
  const result = await exec(CLI, ['pane', 'send-text', '--pane', pane, '--stdin', '--no-escape', '--raw-newlines', '--json'], input);
  let data; try { data = JSON.parse(result.out); } catch {}
  if(result.code!==0&&/send-text is disabled|ipc-allow-send-keys/i.test(result.err||''))throw Object.assign(Error('Otty 未开启程序输入，指令尚未发送'),{status:409,action:'enable-otty-input'});
  if(result.code!==0&&/No pane matched selector/i.test(result.err||''))throw Object.assign(Error('原 Otty 会话已关闭或变化；指令尚未发送'),{status:409});
  if (result.code !== 0 || data?.ok !== true) throw Error('未确认指令送达，请先打开原会话查看；草稿已保留');
 }
 async function submit(pane,text){
  // 文本走 stdin，避免出现在进程参数中；多行作为一次粘贴，最后再提交。
  await sendBytes(pane,'\x1b[200~'+text+'\x1b[201~\r');
 }
 async function checkInput(pane){
  // 空输入只检查运行中的 IPC 权限，不粘贴、不按回车，不改变会话内容。
  try{await sendBytes(pane,'');}
  catch(error){throw Object.assign(Error('Otty 输入权限尚未就绪：'+error.message),{status:409,action:'enable-otty-input'});}
 }
 async function enableInput() {
  const fail=message=>{throw Object.assign(Error(message),{status:409,action:'enable-otty-input'});};
  if(!exists(CLI))fail('未找到 Otty，请先安装并打开 Otty');
  // 只由用户点击「开启并重试」触发，固定写入本机配置并重载，不接受任意配置键。
  const configured=await exec(CLI,['config','set','ipc-allow-send-keys','true','--local','--json']);
  let saved;try{saved=JSON.parse(configured.out);}catch{}
  if(configured.code!==0||saved?.ok!==true)fail('未能写入 Otty 程序输入配置，请重试');
  // 1.5.4 的 set --reload 可返回成功但 IPC 仍沿用旧值，必须单独重载并检查回执。
  const reloaded=await exec(CLI,['config','reload','--json']);
  let live;try{live=JSON.parse(reloaded.out);}catch{}
  if(reloaded.code!==0||live?.ok!==true)fail('配置已写入，但 Otty 未完成重载，请确认 Otty 正在运行后重试');
  const checked=await exec(CLI,['config','get','ipc-allow-send-keys','--json']);
  let result;try{result=JSON.parse(checked.out);}catch{}
  if(checked.code!==0||result?.ok!==true||![true,'true'].includes(result?.data?.value))fail('Otty 程序输入尚未生效，请重试');
  return {ok:true};
 }
 async function focusPane(pane) {
  if(!pane||!exists(CLI))return {ok:false,reason:'Otty 未安装'};
  const result=await exec(CLI,['pane','focus','--pane',pane,'--json']);let data;try{data=JSON.parse(result.out);}catch{}
  if(result.code===0&&data?.ok===true){openApp();return {ok:true,pane};}
  return {ok:false,reason:'没有找到原会话的 Otty pane'};
 }
 return { focusTab, focusPane, tabs, windows, panes, submit, checkInput, enableInput, available: () => exists(CLI), open: openApp };
}
