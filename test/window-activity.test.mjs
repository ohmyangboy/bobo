import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// 用实际页面函数验证 WKWebView orderOut 后 document.hidden 仍为 false 的情况。
// 不启动浏览器 / 服务，不读取真实 HOME；DOM、请求和定时器只用假实现。
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
function slice(start,end){
 const from=source.indexOf(start),to=source.indexOf(end,from);
 assert.ok(from>=0&&to>from,`找不到页面切片：${start}`);
 return source.slice(from,to);
}
function page(pane='cpu',api=async()=>({checking:false,rows:[]})){
 let seq=0,requests=0;
 const timers=new Map(),listeners=new Map(),workspace={hidden:false},classes=new Set();
 const context=vm.createContext({
  window:{},document:{hidden:false,body:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}},addEventListener:(name,fn)=>listeners.set(name,fn)},
  $:()=>workspace,
  setInterval(fn,delay){const id=++seq;timers.set(id,{fn,delay});return id;},
  setTimeout(fn,delay){const id=++seq;timers.set(id,{fn,delay});return id;},
  clearInterval:id=>timers.delete(id),clearTimeout:id=>timers.delete(id),
  api:(...args)=>{requests++;return api(...args);},
  startAppPolling(){},stopAppPolling(){},islandClose(){},usageClose(){},
  loadDevice(){},loadProcesses(){},renderLinks(){},
 });
 vm.runInContext(`
  let islandView='device',devicePane=${JSON.stringify(pane)};
  let deviceTimer=null,processTimer=null,processSortSeen='',linksTimer=null,linksFollowup=null,linksLoading=false,linksData=null;
  function processSort(){return devicePane==='memory'?'memory':'cpu';}
 `+slice('let windowActive=true,','// 终端归属只在通知岛打开时扫描：')+
 slice('function syncProcessPolling(){',"document.addEventListener('visibilitychange',syncProcessPolling);")+
 slice('function syncLinksPolling(){','// IPv6 太长')+
 slice('function openDevice(){','// 右下角的悬浮「刷新设备」')+
 source.match(/document\.addEventListener\('visibilitychange',\(\)=>setWindowActive\(.*\)\);/)[0],context);
 return {context,timers,listeners,workspace,classes,run:code=>vm.runInContext(code,context),requests:()=>requests};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('窗口省电：原生隐藏时 document.hidden 未变，也停止设备与进程轮询；恢复后重新启动',()=>{
 const p=page();p.run('openDevice()');assert.equal(p.timers.size,2);
 p.context.window.__boboSetWindowActive(false);
 assert.equal(p.context.document.hidden,false);assert.equal(p.timers.size,0);
 assert.equal(p.classes.has('window-inactive'),true);
 // WKWebView 的可见性事件不能覆盖原生的后台状态，也不能让切分栏启动轮询。
 p.listeners.get('visibilitychange')();p.run('openDevice();syncProcessPolling();syncLinksPolling()');
 assert.equal(p.timers.size,0);
 p.context.window.__boboSetWindowActive(true);assert.equal(p.timers.size,2);
 assert.equal(p.classes.has('window-inactive'),false);
 p.context.window.__boboSetWindowActive(false);assert.equal(p.timers.size,0);
});
test('窗口省电：页面仍被浏览器判为隐藏时，原生恢复不会启动轮询',()=>{
 const p=page();p.context.document.hidden=true;
 p.context.window.__boboSetWindowActive(false);p.context.window.__boboSetWindowActive(true);
 assert.equal(p.timers.size,0);
 p.context.document.hidden=false;p.listeners.get('visibilitychange')();assert.equal(p.timers.size,2);
});
test('窗口省电：网络请求在隐藏后完成，不会重新挂线路 followup；恢复时照常检测',async()=>{
 let resolve;
 const p=page('network',()=>new Promise(r=>{resolve=r;}));
 p.run('openDevice()');assert.equal(p.requests(),1);assert.equal(p.timers.size,2);
 p.context.window.__boboSetWindowActive(false);assert.equal(p.timers.size,0);
 resolve({checking:true,rows:[]});await settle();assert.equal(p.timers.size,0);
 p.context.window.__boboSetWindowActive(true);assert.equal(p.requests(),2);assert.equal(p.timers.size,2);
 resolve({checking:true,rows:[]});await settle();assert.equal(p.timers.size,3);
 p.context.window.__boboSetWindowActive(false);assert.equal(p.timers.size,0);
});
