// 设备：CPU / 内存 / 磁盘三个指标。只读本机、不写任何文件、不联网。
// CPU 用 os.cpus() 的累计时间差算占用（2 秒窗口），另读 os.loadavg() 的 1/5/15 分钟负载；
// 内存解析 /usr/bin/vm_stat 的页统计（已用 = 活跃 + 联动 + 压缩占用 − 可回收，缓存单独列出，
// 口径接近「活动监视器」），压力等级读 kern.memorystatus_vm_pressure_level（1 正常 / 2 警告 / 4 紧张，
// 与活动监视器的内存压力图同源）；磁盘用 fs.statfs('/')（APFS 容器级，与 Finder 显示的可用空间一致）。
// 采样在服务端常驻进行（刘海胶囊要实时值），网页只读这份快照；只有可见数值变化时才推送。
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawn} from 'node:child_process';

const vmStatBin='/usr/bin/vm_stat',sysctlBin='/usr/sbin/sysctl';
const psBin='/bin/ps',psColumns='pid=,pcpu=,pmem=,rss=,etime=,comm=';
const tickMs=2000,memoryEvery=3,diskEvery=30;   // 2 秒一跳；内存每 3 跳（约 6 秒）、磁盘每 30 跳（约 60 秒）
// 进程列表：不进常驻采样，只在网页停在「设备」的 CPU / 内存分栏时按需拉取（见 app.js 的 processTimer）。
// 结果缓存 1.5 秒，多开页面或重复请求时复用同一份，避免反复 fork ps。
const processCacheMs=1500,processLimitMax=50,processLimitDefault=15;
const pressureLabels={1:'正常',2:'警告',4:'紧张'};
const round1=v=>Math.round(v*10)/10;
const baseName=p=>{const s=String(p),i=Math.max(s.lastIndexOf('/'),s.lastIndexOf('\\'));return i<0?s:s.slice(i+1)||s;};
const clampPercent=v=>Math.min(100,Math.max(0,round1(v)));
const userError=message=>Object.assign(Error(message),{userFacing:true});
const describe=(e,prefix)=>e?.userFacing?e.message:prefix+(e?.message||e);
// 等级 ok / warn / low，与网页「设备」里的进度条和刘海指示同一套阈值。
const levelOf=(percent,warn,low)=>percent>=low?'low':percent>=warn?'warn':'ok';
const cpuLevel=usage=>levelOf(usage,50,80);
// 内存等级以百分比为基础，内核的内存压力只会把它抬高（压力警告至少橙、紧张直接红）。
function memoryLevel(percent,pressure){
 const base=levelOf(percent,70,85);
 if(pressure>=4)return 'low';
 if(pressure>=2)return base==='ok'?'warn':base;
 return base;
}
// 子进程统一入口：数组参数 + shell:false，输出只收 stdout，退出码非 0 视为失败。
function run(file,args){
 return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{shell:false,stdio:['ignore','pipe','ignore']});
  let out='';child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{out=(out+s).slice(0,200000);});
  const timer=setTimeout(()=>child.kill('SIGTERM'),5000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error(file+' 退出码 '+code));});
 });
}
// vm_stat 的输出形如「Pages free: 4092.」；首行带页大小，错误行（带引号的 Translation faults 等）不以 Pages 开头。
function parseVMStat(text){
 const pageSize=Number(text.match(/page size of (\d+) bytes/)?.[1])||16384,pages={};
 for(const m of text.matchAll(/^Pages ([^:]+):\s+(\d+)\./gm))pages[m[1]]=Number(m[2]);
 const page=name=>pages[name]||0;
 const active=page('active'),wired=page('wired down'),compressed=page('occupied by compressor'),purgeable=page('purgeable');
 return {
  pageSize,active,wired,compressed,purgeable,inactive:page('inactive'),
  free:page('free')+page('speculative'),
  used:Math.max(0,active+wired+compressed-purgeable)*pageSize,
 };
}
// ps 的输出行：pid pcpu pmem rss(KB) etime comm。comm 是最后一列（完整路径，可能带空格），
// 这里取 basename 展示；内存换算成字节，与内存 / 磁盘字段口径一致。
export function parsePs(text){
 const rows=[];
 for(const line of String(text).split('\n')){
  const m=line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
  if(!m)continue;
  rows.push({pid:Number(m[1]),name:baseName(m[6]),cpu:Number(m[2]),memoryPercent:Number(m[3]),memory:Number(m[4])*1024,elapsed:m[5]});
 }
 return rows;
}
// Windows 的进程快照：Win32_PerfFormattedData_PerfProc_Process 的 PercentProcessorTime 是即时占用率
// （多核时会超过 100），WorkingSetPrivate 是私有工作集字节数；_Total 与 Idle 是伪进程，丢掉。
// 进程名可能带 "#1" 这样的重名后缀，展示时去掉。
const winProcessScript='[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
 +'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property Name,IDProcess,PercentProcessorTime,WorkingSetPrivate | '
 +'Where-Object{$_.Name -notin @("_Total","Idle")} | '
 +'Select-Object Name,IDProcess,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json -Compress';
export function parseWinProcesses(text,total=0){
 const raw=String(text||'').trim();if(!raw)return [];
 let rows;try{rows=JSON.parse(raw);}catch{return [];}
 if(!Array.isArray(rows))rows=rows?[rows]:[];
 return rows.map(r=>{
  const memory=Number(r.WorkingSetPrivate)||0;
  return {pid:Number(r.IDProcess)||0,name:String(r.Name||'').replace(/#\d+$/,''),cpu:round1(Number(r.PercentProcessorTime)||0),memoryPercent:total?clampPercent(memory/total*100):0,memory,elapsed:''};
 }).filter(r=>r.pid>0);
}
// 磁盘、内存的字节数换算成 GiB / GB 由前端与原生各自格式化，这里只回字节数。
function parseStatfs(s){
 const total=s.blocks*s.bsize,free=(s.bavail||s.bfree)*s.bsize;
 return {total,free,used:Math.max(0,total-free)};
}
// CPU 的累计时间：两次采样的差值给出这段时间的占用率（首跳没有基线，返回 null）。
function readTicks(cpus){const list=cpus();return {ticks:list.map(c=>{const t=c.times;return {total:t.user+t.nice+t.sys+t.idle+t.irq,idle:t.idle};}),cores:list.length,model:list[0]?.model||''};}
function cpuUsage(prev,next){
 let total=0,idle=0;const perCore=[];
 for(let i=0;i<Math.min(prev.length,next.length);i++){
  const delta=next[i].total-prev[i].total,idleDelta=next[i].idle-prev[i].idle;
  total+=delta;idle+=idleDelta;
  if(delta>0)perCore.push(clampPercent((1-idleDelta/delta)*100));
 }
 if(total<=0)return null;
 return {usage:clampPercent((1-idle/total)*100),perCore};
}

export function createDevices({now=Date.now,cpus=os.cpus,loadavg=os.loadavg,totalmem=os.totalmem,freemem=os.freemem,statfs=fs.statfs,exec=run,platform=process.platform,selfPid=process.pid}={}){
 let cpu=null,memory=null,disk=null,prevTicks=null,updatedAt=0,errors={},signature='',state=null,listeners=new Set(),timer=null,ticks=0,busy=null,closed=false,processCache=null,processBusy=null;
 const isMac=platform==='darwin',isWin=platform==='win32';
 // 磁盘看哪个挂载点：macOS / Linux 是根分区，Windows 是系统盘（statfs 在三个平台都可用）。
 const diskMount=isWin?(process.env.SystemDrive||'C:')+'\\':'/';
 const snapshot=()=>({available:cpu!==null,updatedAt,cpu,memory,disk,error:Object.values(errors).filter(Boolean).join('；')||null});
 const emit=()=>{for(const listener of listeners){try{listener();}catch{}}};
 // 去重只看「看得见的变化」：CPU 按 5% 粒度（空闲时停在 0% 附近，流上就不会每 2 秒刷一次），
 // 内存与磁盘按 0.1%，再加上各自的等级；updatedAt 只是采样时间，不参与比较。
 const visible=v=>v===null||v===undefined?null:Math.round(v*20)/20;
 const signatureOf=s=>JSON.stringify([s.available,s.error,s.cpu?[visible(s.cpu.usage),s.cpu.level,s.cpu.cores,s.cpu.load]:null,s.memory?[s.memory.usedPercent,s.memory.pressure,s.memory.level]:null,s.disk?[s.disk.usedPercent,s.disk.level]:null]);
 function commit(){
  const next=snapshot(),key=signatureOf(next);
  if(key===signature)return state=next;
  signature=key;state=next;emit();
  return state;
 }
 function cpuSample(){
  const {ticks:list,cores,model}=readTicks(cpus);
  const usage=prevTicks?cpuUsage(prevTicks,list):null;
  prevTicks=list;
  if(usage===null)return;   // 首跳只立基线，占用率要等下一个采样点
  cpu={usage:usage.usage,perCore:usage.perCore,cores,model,load:loadavg().slice(0,3).map(v=>Math.round(v*100)/100),level:cpuLevel(usage.usage)};
 }
 // macOS 走 vm_stat（os.freemem 只报 free 页，几乎永远是 0，不能用）；Windows / Linux 用 os.freemem，
 // Windows 上它返回真实可用内存，可以直接用；内存压力只有 macOS 有，其它平台记 0。
 async function memorySample(){
  try{
   if(!isMac){
    const total=totalmem(),free=Math.max(0,freemem());
    const used=Math.max(0,total-free),percent=clampPercent(total?used/total*100:0);
    memory={total,used,cached:0,free,wired:0,compressed:0,pressure:0,pressureLabel:'',usedPercent:percent,level:memoryLevel(percent,0)};
    delete errors.memory;return;
   }
   const [stat,level]=await Promise.all([exec(vmStatBin,[]),exec(sysctlBin,['-n','kern.memorystatus_vm_pressure_level']).catch(()=>'')]);
   const page=parseVMStat(stat),total=totalmem();
   const used=Math.min(total,page.used),percent=clampPercent(total?used/total*100:0),pressure=Number(String(level).trim())||0;
   memory={total,used,cached:page.inactive*page.pageSize,free:page.free*page.pageSize,wired:page.wired*page.pageSize,compressed:page.compressed*page.pageSize,pressure,pressureLabel:pressureLabels[pressure]||'',usedPercent:percent,level:memoryLevel(percent,pressure)};
   delete errors.memory;
  }catch(e){errors.memory=describe(e,'读取内存失败：');}
 }
 async function diskSample(){
  try{
   const {total,free,used}=parseStatfs(await statfs(diskMount)),percent=clampPercent(total?used/total*100:0);
   disk={mount:diskMount,total,used,free,usedPercent:percent,level:levelOf(percent,80,90)};
   delete errors.disk;
  }catch(e){errors.disk=describe(e,'读取磁盘失败：');}
 }
 // 进程列表按需采样：macOS 一次 ps、Windows 一次 CIM 查询给出全部进程，结果缓存 1.5 秒
 // （多开页面 / 重复请求只落一次子进程）；排序与截断在 JS 里做，不依赖各自的排序语义。
 // 不进常驻 tick，也不进状态流。bobo 自己的进程（服务进程 + bobo.app）标记 self，钉在列表最前。
 const processSorts={cpu:(a,b)=>b.cpu-a.cpu||a.pid-b.pid,memory:(a,b)=>b.memory-a.memory||a.pid-b.pid};
 const markSelf=r=>(r.pid===selfPid||/^bobo$/i.test(r.name))?{...r,self:true}:r;
 async function processes({limit=processLimitDefault,sort='cpu'}={}){
  if(!isMac&&!isWin)return {updatedAt:0,count:0,processes:[],error:'进程列表目前支持 macOS 与 Windows'};
  const take=Math.min(processLimitMax,Math.max(1,Number(limit)||processLimitDefault)),order=processSorts[sort]||processSorts.cpu;
  let cache=processCache;
  if(!cache||now()-cache.at>=processCacheMs){
   if(!processBusy)processBusy=(async()=>{
    try{
     const rows=isWin
      ?parseWinProcesses(await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',winProcessScript]),totalmem())
      :parsePs(await exec(psBin,['-Ao',psColumns]));
     return {at:now(),rows:rows.map(markSelf),error:null};
    }
    catch(e){return {at:now(),rows:[],error:describe(e,'读取进程失败：')};}
    finally{processBusy=null;}
   })();
   cache=processCache=await processBusy;
  }
  const ordered=[...cache.rows].sort(order);
  // bobo 自己的进程固定在列表最前（服务进程在前），不参与排序与前 15 条截断，方便随时看它占了多少。
  const pinned=ordered.filter(r=>r.self).sort((a,b)=>(a.pid===selfPid?0:1)-(b.pid===selfPid?0:1));
  const rest=ordered.filter(r=>!r.self).slice(0,take);
  return {updatedAt:cache.at,count:cache.rows.length,processes:[...pinned,...rest],error:cache.error};
 }
 // 一次采样：CPU 每跳都算，内存与磁盘按跳数分摊（少落子进程）。
 async function tick(all=false){
  updatedAt=now();ticks++;
  const jobs=[Promise.resolve().then(cpuSample)];
  if(all||ticks%memoryEvery===1)jobs.push(memorySample());
  if(all||ticks%diskEvery===1)jobs.push(diskSample());
  await Promise.all(jobs);
  return commit();
 }
 async function refresh(all=true){
  if(closed)return snapshot();
  if(busy){
   if(!all)return busy;
   // 手动强制刷新（网页「刷新设备」、通知岛明细卡弹出）撞上常驻跳时，等它收尾再补一次全量采样：
   // 直接复用那一跳的快照的话，磁盘 / 内存可能还是几十秒前的旧值。
   while(busy)await busy.catch(()=>{});
   if(closed)return snapshot();
  }
  busy=(async()=>{try{await tick(all);}catch(e){errors.sample=describe(e,'读取设备信息失败：');}finally{busy=null;}return snapshot();})();
  return busy;
 }
 return {
  snapshot:()=>state||snapshot(),
  processes,
  refresh,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  start(){closed=false;void refresh(true);timer=setInterval(()=>{void refresh(false);},tickMs);timer.unref?.();},
  stop(){closed=true;if(timer)clearInterval(timer);timer=null;listeners.clear();},
 };
}
