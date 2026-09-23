// 网络：延迟 / 下载 / 上传三项。只读本机网卡计数器、只做本机探测（ICMP ping，失败退回 TCP 握手），
// 不请求任何第三方接口、不写任何文件。网卡字节数按 2 秒窗口的差值算速率（macOS 走 netstat、Linux 读
// /proc/net/dev），延迟每 3 跳探一次；采样在服务端常驻进行（刘海胶囊要实时值），网页与面板只读这份快照，
// 只有可见数值变化时才推送。
import os from 'node:os';
import fs from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';

const pingBin='/sbin/ping',routeBin='/sbin/route',netstatBin='/usr/sbin/netstat',networksetupBin='/usr/sbin/networksetup';
const procNetDev='/proc/net/dev',procRoute='/proc/net/route';
const tickMs=2000,latencyEvery=3,interfaceEvery=30;   // 2 秒一跳；延迟每 3 跳（约 6 秒）；接口每 30 跳（约 60 秒）
const pingTimeoutMs=1500,tcpTimeoutMs=1500;
// 尺度（等级由服务端定，网页与刘海按同一套阈值上色）：
// 延迟：< 60ms 正常 / < 200ms 偏慢 / ≥ 200ms 很差；探测没响应按「断网」处理（online=false）。
const latencyWarnMs=60,latencyLowMs=200;
// 下载 / 上传：< 64 KB/s 空闲（给后台心跳留的余量）、< 4 MB/s 正常、< 64 MB/s 繁忙、
// ≥ 64 MB/s 视为接近跑满（千兆网卡约 125 MB/s）。
const rateIdle=64*1024,rateWarn=4*1024*1024,rateLow=64*1024*1024;
// 虚拟接口（VPN / 隧道 / 无线直连 / 桥接 / 热点）：它们不是「线上流量」的那块物理网卡，
// 主接口落在这些上时退回物理接口——否则 VPN 场景下统计到的只是隧道里的那一部分。
const virtualPrefixes=['utun','ipsec','ppp','tun','tap','gif','stf','wg','awdl','llw','bridge','ap'];
const round1=v=>Math.round(v*10)/10;
const describe=(e,prefix)=>e?.userFacing?e.message:prefix+(e?.message||e);
// 子进程统一入口：数组参数 + shell:false，输出只收 stdout，退出码非 0 视为失败（与 devices.mjs 一致）。
function run(file,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{shell:false,stdio:['ignore','pipe','ignore']});
  let out='';child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{out=(out+s).slice(0,200000);});
  const timer=setTimeout(()=>child.kill('SIGTERM'),5000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error(file+' 退出码 '+code));});
 });
}

export function isVirtualInterface(name){
 const n=String(name||'');
 return !n||virtualPrefixes.some(p=>n.startsWith(p));
}
// 接口类型：优先用 macOS 的 Hardware Port 名称判断，其次按接口名前缀（Linux 的 wl* / en* / eth*）。
export function interfaceKind(name,port=''){
 const p=String(port||'');
 if(/wi-?fi|airport/i.test(p))return 'wifi';
 if(/ethernet|lan|thunderbolt/i.test(p))return 'ethernet';
 const n=String(name||'');
 if(/^wl/.test(n))return 'wifi';
 if(/^(en|eth)/.test(n))return 'ethernet';
 return 'other';
}
// ping 的输出（macOS / Linux 都用 time=12.3 ms；超时时没有这一行）。
export function parsePingTime(text){
 const m=/time[=<]([\d.]+)\s*ms/.exec(String(text));
 return m?Number(m[1]):null;
}
// netstat -ibn -I <iface> 的行：Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll。
// 地址列为空时（`<Link#N>` 行常见）字段少一个，按列数区分；同一个接口还有 IPv6 / 地址行，
// 取第一行数值齐全的即可（Ierrs / Coll 可能是「-」）。
export function parseNetstat(text,iface){
 for(const line of String(text).split('\n')){
  const f=line.trim().split(/\s+/);
  if(f.length<10||f[0]!==iface)continue;
  const i=f.length>=11?6:5,o=f.length>=11?9:8;
  if(!/^\d+$/.test(f[i])||!/^\d+$/.test(f[o]))continue;
  return {download:Number(f[i]),upload:Number(f[o])};
 }
 return null;
}
// Linux /proc/net/dev：`en0: rx_bytes ... tx_bytes ...`（16 个数字，接收第 1 个、发送第 9 个）。
export function parseProcNetDev(text,iface){
 for(const line of String(text).split('\n')){
  const i=line.indexOf(':');
  if(i<0||line.slice(0,i).trim()!==iface)continue;
  const f=line.slice(i+1).trim().split(/\s+/).map(Number);
  if(f.length<10||f.some(v=>!Number.isFinite(v)))continue;
  return {download:f[0],upload:f[8]};
 }
 return null;
}
// Linux /proc/net/route：目标 00000000 的那行就是默认路由，第一列是接口名。
export function parseDefaultRoute(text){
 for(const line of String(text).split('\n').slice(1)){
  const f=line.trim().split(/\s+/);
  if(f.length>=3&&f[1]==='00000000')return f[0];
 }
 return null;
}
// macOS 的默认路由（`route -n get default`）打印 `interface: en0`。
export function parseRouteInterface(text){
 const m=/^\s*interface:\s*(\S+)/m.exec(String(text));
 return m?m[1]:null;
}
// networksetup -listallhardwareports：`Hardware Port: Wi-Fi` 后面跟一行 `Device: en0`。
export function parseHardwarePorts(text){
 const ports={};let label='';
 for(const line of String(text).split('\n')){
  const p=/^\s*Hardware Port:\s*(.+?)\s*$/.exec(line);
  if(p){label=p[1];continue;}
  const d=/^\s*Device:\s*(\S+)\s*$/.exec(line);
  if(d&&label)ports[d[1]]={label,kind:interfaceKind(d[1],label)};
 }
 return ports;
}
export function latencyLevel(ms){
 if(!Number.isFinite(ms))return null;
 return ms>=latencyLowMs?'low':ms>=latencyWarnMs?'warn':'ok';
}
export function rateLevel(bytesPerSec){
 const v=Number(bytesPerSec)||0;
 return v>=rateLow?'low':v>=rateWarn?'warn':v>=rateIdle?'ok':'idle';
}
// TCP 兜底探测：到 host:port 的三次握手往返（某些网络封 ICMP 时用它，不需要额外权限、不起子进程）。
export function tcpProbe(host,port,timeout=tcpTimeoutMs){
 return new Promise(resolve=>{
  const started=process.hrtime.bigint();
  let done=false;
  const socket=net.connect({host,port:Number(port)||443});
  const finish=ms=>{if(done)return;done=true;socket.destroy();resolve(ms);};
  socket.setTimeout(timeout);
  socket.on('connect',()=>finish(Number(process.hrtime.bigint()-started)/1e6));
  socket.on('timeout',()=>finish(null));
  socket.on('error',()=>finish(null));
 });
}

export function createNetwork({now=Date.now,exec=run,readFile=fs.readFile,interfaces=os.networkInterfaces,platform=process.platform,host='1.1.1.1',port=443,probe=null,tcp=tcpProbe}={}){
 const isMac=platform==='darwin',isLinux=platform==='linux',supported=isMac||isLinux;
 let iface=null,latency=null,online=null,rate={download:0,upload:0},totals={download:0,upload:0,since:now()},prev=null,updatedAt=0,errors={},signature='',state=null,listeners=new Set(),timer=null,ticks=0,busy=null,closed=false,resolveNext=false;
 // 延迟探测：先 ICMP ping（默认主机与 Stats 一致是 1.1.1.1），没有响应再退回 TCP 握手。
 const probeFn=probe||(async()=>{
  const args=isMac?['-c','1','-W',String(pingTimeoutMs),'-t',String(Math.ceil(pingTimeoutMs/1000)),host]:['-c','1','-W',String(Math.ceil(pingTimeoutMs/1000)),host];
  let ms=null;
  try{ms=parsePingTime(await exec(pingBin,args));}catch{}
  if(Number.isFinite(ms))return {ms,source:'icmp'};
  const tcpMs=await tcp(host,port,tcpTimeoutMs);
  return Number.isFinite(tcpMs)?{ms:tcpMs,source:'tcp'}:null;
 });
 const snapshot=()=>({
  available:supported&&(Boolean(iface)||latency!==null),
  updatedAt,online,
  interface:iface,
  latency,
  download:{bytesPerSec:round1(rate.download),level:rateLevel(rate.download)},
  upload:{bytesPerSec:round1(rate.upload),level:rateLevel(rate.upload)},
  totals:{download:totals.download,upload:totals.upload,since:totals.since},
  error:Object.values(errors).filter(Boolean).join('；')||null,
 });
 const emit=()=>{for(const listener of listeners){try{listener();}catch{}}};
 // 去重只看「看得见的变化」：延迟取整毫秒、速率按 1 KB/s 取整、接口与等级变化；updatedAt 与累计流量不参与。
 const bucket=v=>Math.round((Number(v)||0)/1024)*1024;
 const signatureOf=s=>JSON.stringify([s.available,s.error,s.online,s.interface?s.interface.name:null,s.interface?s.interface.kind:null,s.interface?s.interface.address:null,
  s.latency?[s.latency.level,Math.round(s.latency.ms),s.latency.source]:null,s.download&&[s.download.level,bucket(s.download.bytesPerSec)],s.upload&&[s.upload.level,bucket(s.upload.bytesPerSec)]]);
 function commit(){
  const next=snapshot(),key=signatureOf(next);
  if(key===signature)return state=next;
  signature=key;state=next;emit();
  return state;
 }
 // 用哪块网卡：默认路由指到的接口是物理接口就直接用；指到 VPN / 隧道时退回第一块有 IPv4 的物理网卡
 // （en* / eth* 优先），拿不到任何候选就置空、下一跳重新解析。
 async function resolve(){
  try{
   const ports=isMac?parseHardwarePorts(await exec(networksetupBin,['-listallhardwareports']).catch(()=>'')):{};
   let name=null;
   try{name=isMac?parseRouteInterface(await exec(routeBin,['-n','get','default'])):parseDefaultRoute(await readFile(procRoute,'utf8'));}catch{}
   const physical=[];
   for(const [n,addrs] of Object.entries(interfaces()||{})){
    if(n==='lo0'||n==='lo'||isVirtualInterface(n))continue;
    const usable=(addrs||[]).filter(a=>!a.internal);
    if(!usable.length)continue;
    // IPv4 优先（IPv6-only 的网络也能统计，只是地址列显示 IPv6）。
    const v4=usable.find(a=>a.family==='IPv4');
    const port=ports[n];
    physical.push({name:n,address:(v4||usable[0]).address,kind:port?.kind||interfaceKind(n),label:port?.label||'',rank:v4?0:1});
   }
   physical.sort((a,b)=>a.rank-b.rank||((/^(en|eth)/.test(b.name)?1:0)-(/^(en|eth)/.test(a.name)?1:0)));
   const chosen=physical.find(p=>p.name===name)||physical[0]||null;
   if(chosen?.name!==iface?.name){prev=null;rate={download:0,upload:0};}
   // rank 只用于排序，不进快照。
   iface=chosen?{name:chosen.name,address:chosen.address,kind:chosen.kind,label:chosen.label}:null;
   if(chosen)delete errors.interface;else if(supported)errors.interface='没有找到可用的网络接口';
  }catch(e){errors.interface=describe(e,'解析网络接口失败：');}
 }
 // 网卡字节数：两次采样的差值除以间隔（接口换了或计数器回绕时只重立基线，不算负速率）。
 async function sampleCounters(){
  if(!iface)return;
  try{
   const counters=isMac?parseNetstat(await exec(netstatBin,['-ibn','-I',iface.name]),iface.name):parseProcNetDev(await readFile(procNetDev,'utf8'),iface.name);
   if(!counters){errors.counters='读取网卡计数器失败：'+iface.name;resolveNext=true;return;}
   const at=now();
   if(prev&&prev.iface===iface.name&&at>prev.at){
    const dt=(at-prev.at)/1000;
    const download=Math.max(0,counters.download-prev.counters.download),upload=Math.max(0,counters.upload-prev.counters.upload);
    rate={download:download/dt,upload:upload/dt};
    totals={...totals,download:totals.download+download,upload:totals.upload+upload};
   }
   prev={iface:iface.name,at,counters};
   delete errors.counters;
  }catch(e){errors.counters=describe(e,'读取网卡计数器失败：');resolveNext=true;}
 }
 async function sampleLatency(){
  try{
   const r=await probeFn();
   if(r&&Number.isFinite(r.ms)){latency={ms:round1(r.ms),level:latencyLevel(r.ms),source:r.source||'icmp',host,at:now()};online=true;}
   else{latency=null;online=false;}
  }catch{latency=null;online=false;}
 }
 async function tick(all=false){
  updatedAt=now();ticks++;
  if(!supported){errors.sample='网络监控目前支持 macOS 与 Linux';return commit();}
  try{
   if(!iface||resolveNext||ticks%interfaceEvery===1){resolveNext=false;await resolve();}
   const jobs=[sampleCounters()];
   if(all||ticks%latencyEvery===1)jobs.push(sampleLatency());
   await Promise.all(jobs);
  }catch(e){errors.sample=describe(e,'读取网络信息失败：');}
  return commit();
 }
 async function refresh(all=true){
  if(closed)return snapshot();
  if(busy){
   if(!all)return busy;
   while(busy)await busy.catch(()=>{});
   if(closed)return snapshot();
  }
  busy=(async()=>{try{await tick(all);}catch(e){errors.sample=describe(e,'读取网络信息失败：');}finally{busy=null;}return snapshot();})();
  return busy;
 }
 return {
  snapshot:()=>state||snapshot(),
  refresh,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  start(){closed=false;void refresh(true);timer=setInterval(()=>{void refresh(false);},tickMs);timer.unref?.();},
  stop(){closed=true;if(timer)clearInterval(timer);timer=null;listeners.clear();},
 };
}
