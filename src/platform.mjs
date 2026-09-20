// 平台适配层：把各模块里的系统调用收拢到一处，darwin 保持原有行为，win32 走新增分支。
// 约定：子进程一律数组参数 + shell:false；没有实现的场景抛 userFacing 错误或静默降级，由调用方决定。
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

export const platform=process.platform,isMac=platform==='darwin',isWin=platform==='win32';

const fire=(cmd,args)=>{try{spawn(cmd,args,{shell:false,stdio:'ignore'}).on('error',()=>{});}catch{}};
function run(cmd,args,timeout=300000,env){
 return new Promise(resolve=>{
  const child=spawn(cmd,args,{shell:false,env,stdio:['ignore','pipe','pipe']});
  let stdout='',output='';const collect=b=>{output=(output+b).slice(-200000);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',b=>{stdout+=b;collect(b);});
  child.stderr.on('data',collect);
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  child.on('error',e=>{clearTimeout(timer);resolve({code:127,output:e.message,stdout:''});});
  child.on('close',code=>{clearTimeout(timer);resolve({code:code??1,output:output.trim(),stdout:stdout.trim()});});
 });
}

// ---- 打开文件 / 目录 / 链接 ----
// macOS 用 open，Windows 用 explorer（资源管理器 / 默认程序），其它平台用 xdg-open。
export function openTarget(target){
 if(isWin)return fire('explorer.exe',[target]);
 fire(isMac?'open':'xdg-open',[target]);
}
// 打开 URL：Windows 上 explorer 打不开网址，用 rundll32 的 FileProtocolHandler。
export function openUrl(url){
 if(isWin)return fire('rundll32.exe',['url.dll,FileProtocolHandler',url]);
 fire(isMac?'open':'xdg-open',[url]);
}

// ---- 目录链接 ----
// POSIX 用符号链接（relative 时路径短、技能目录整体可搬迁）；Windows 只能用 junction
// （免管理员权限，但只支持目录且必须绝对路径）。
export async function linkDir(target,link,{relative=true}={}){
 await fs.mkdir(path.dirname(link),{recursive:true});
 if(isWin)return fs.symlink(target,link,'junction');
 const dest=relative?path.relative(path.dirname(link),target)||target:target;
 return fs.symlink(dest,link);
}
// 删除目录链接：Windows 的 junction 要用 rmdir（unlink 会报 EPERM），其余用 unlink。
export async function removeLink(link){
 if(!isWin)return fs.unlink(link);
 try{return await fs.rmdir(link);}catch{return fs.unlink(link);}
}

// ---- 提示音 ----
// macOS 播 /System/Library/Sounds 下的系统音；Windows 没有同名音效，按共享音名映射到 SystemSounds。
const winSounds={question:'Asterisk',done:'Asterisk',error:'Hand',Ping:'Beep',Glass:'Asterisk',Basso:'Hand'};
export function playSound(name){
 const file=String(name||'').trim();
 if(!file)return;
 if(isWin){
  const mapped=winSounds[file.replace(/\.aiff?$/i,'')]||'Asterisk';
  return fire('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',`[System.Media.SystemSounds]::${mapped}.Play()`]);
 }
 if(!isMac)return;
 fire('afplay',['/System/Library/Sounds/'+file]);
}

// ---- 系统通知 ----
// macOS 走 osascript；Windows 用托盘气泡（临时 PowerShell 进程，显示完自动退出）。
// 有 Tauri 壳时通知由壳负责（tauri-plugin-notification），这里是无壳 / 浏览器场景的降级。
const asQuote=s=>'"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
const psQuote=s=>"'" +String(s).replace(/'/g,"''")+"'";
export function notify(title,message){
 const text=String(message||'');
 if(isWin){
  const script='Add-Type -AssemblyName System.Windows.Forms;'
   +'$n=New-Object System.Windows.Forms.NotifyIcon;'
   +'$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;'
   +`$n.ShowBalloonTip(6000,${psQuote(title)},${psQuote(text)},[System.Windows.Forms.ToolTipIcon]::Info);`
   +'Start-Sleep -Milliseconds 7000;$n.Dispose()';
  return fire('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',script]);
 }
 if(!isMac)return;
 fire('osascript',['-e',`display notification ${asQuote(text)} with title ${asQuote(title)}`]);
}

// ---- 系统文件夹选择器 ----
// macOS 用 osascript 的 choose folder（不依赖 Finder，免自动化授权）；Windows 用 PowerShell 的
// FolderBrowserDialog（Windows PowerShell 5.1 默认 STA，正是 WinForms 弹窗需要的）。
// 返回 {path} 或 {cancelled:true}；失败抛带 userFacing 的错误，由调用方转成用户可读提示。
export async function pickFolder({env}={}){
 if(isMac){
  const r=await run('osascript',['-e','POSIX path of (choose folder with prompt "选择要关联的技能目录（可在弹窗里新建文件夹）")'],900000,env);
  if(r.code===0){const p=r.stdout.replace(/\/+$/,'');return {path:p||'/'};}
  if(/User canceled|-128/.test(r.output))return {cancelled:true};
  throw Object.assign(Error(r.output||'无法打开文件夹选择器'),{userFacing:true});
 }
 if(isWin){
  const script='[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
   +'Add-Type -AssemblyName System.Windows.Forms;'
   +'$d=New-Object System.Windows.Forms.FolderBrowserDialog;'
   +'$d.Description="选择要关联的技能目录（可在弹窗里新建文件夹）";'
   +'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}';
  const r=await run('powershell.exe',['-NoProfile','-STA','-Command',script],900000,env);
  if(r.code===0){const p=r.stdout.trim();return p?{path:p}:{cancelled:true};}
  throw Object.assign(Error(r.output||'无法打开文件夹选择器'),{userFacing:true});
 }
 throw Object.assign(Error('系统文件夹选择器仅支持 macOS 与 Windows，请手动输入路径'),{userFacing:true});
}
