import {test} from 'node:test';import assert from 'node:assert/strict';
import {createDevices,parsePs,parseWinProcesses} from '../src/devices.mjs';
// 全部注入假实现：不读真实系统、不起子进程、不依赖平台。
const TOTAL=25769803776;   // 24 GiB
const VM_STAT=`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4092.
"Translation faults":                     2877916097.
Pages active:                                 383515.
Pages inactive:                               381470.
Pages speculative:                              1110.
Pages wired down:                             187495.
Pages purgeable:                                   4.
Pages stored in compressor:                  1099015.
Pages occupied by compressor:                 578506.
`;
const STATFS={bsize:4096,blocks:120699413,bfree:16610491,bavail:16610491};
const cpu=(user,idle)=>({model:'Apple M2',times:{user,nice:0,sys:0,idle,irq:0}});
const cpuSet=(user,idle,cores=1)=>Array.from({length:cores},()=>cpu(user,idle));
// 假 ps 输出：cpu 最高的 otty 内存不大、mds_stores 反过来（用来区分两种排序）；路径用于验证 basename；
// 200 是本机服务（测试里当 selfPid）、300 是 bobo.app，两者都应被钉在列表最前。
const PS=`    300   0.5   1.5  307200 02:00:00 /Applications/bobo.app/Contents/MacOS/Bobo
    100  45.3   0.8  204800 03:12:00 /Applications/Otty.app/Contents/MacOS/otty
    400   1.0  30.0 8388608 05:00 /usr/sbin/mds_stores
    200   3.1  12.5 4194304 01-02:03:04 /usr/local/bin/node
      1   0.0   0.3   12288 12:34 /sbin/launchd
`;
// 可注入的采样环境：now 手动前进，cpus 逐次给出快照，exec 按命令返回假输出。
function harness({vmStat=VM_STAT,pressure='1',failMemory=false,disk=STATFS,failDisk=false,ps=PS,failPs=false}={}){
 let nowMs=1_000_000,list=cpuSet(1000,9000),psCalls=0;
 const env={
  now:()=>nowMs,
  cpus:()=>list.map(c=>({...c,times:{...c.times}})),
  loadavg:()=>[4,3.8,4.4],
  totalmem:()=>TOTAL,
  freemem:()=>100,
  statfs:()=>failDisk?Promise.reject(Error('boom')):Promise.resolve(disk),
  exec:async(file,args)=>{
   if(file.includes('vm_stat')){if(failMemory)throw Error('no vm_stat');return vmStat;}
   if(args.includes('kern.memorystatus_vm_pressure_level'))return pressure+'\n';
   if(file.includes('ps')){psCalls++;if(failPs)throw Error('ps 退出码 1');return ps;}
   throw Error('未知命令 '+file);
  },
 };
 return {env,advance(ms=2000){nowMs+=ms;},setCpus(next){list=next;},psCalls:()=>psCalls};
}
test('CPU：首跳只立基线，第二跳按时间差算占用并给出等级',async()=>{
 const h=harness();
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 h.setCpus(cpuSet(1000,9000));
 const first=await devices.refresh();
 assert.equal(first.available,false);assert.equal(first.cpu,null);
 // 2 秒里每核增加 2000 tick，其中 idle 只增加 1000 → 占用 50%。
 h.setCpus(cpuSet(2000,10000,4));
 const second=await devices.refresh();
 assert.equal(second.available,true);
 assert.equal(second.cpu.usage,50);assert.equal(second.cpu.cores,4);assert.equal(second.cpu.model,'Apple M2');
 assert.deepEqual(second.cpu.load,[4,3.8,4.4]);assert.equal(second.cpu.level,'warn');
});
test('内存：按 vm_stat 的页统计算已用 / 缓存 / 可用，压力等级来自内核',async()=>{
 const h=harness({pressure:'2'});
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 await devices.refresh();
 const s=await devices.refresh();
 const m=s.memory;
 assert.equal(m.total,TOTAL);
 // 已用 =（383515 活跃 + 187495 联动 + 578506 压缩占用 − 4 可回收）× 16384。
 assert.equal(m.used,(383515+187495+578506-4)*16384);
 assert.equal(m.cached,381470*16384);
 assert.equal(m.free,(4092+1110)*16384);
 assert.equal(m.wired,187495*16384);assert.equal(m.compressed,578506*16384);
 assert.equal(m.pressure,2);assert.equal(m.pressureLabel,'警告');
 assert.equal(m.usedPercent,73.1);
 // 73% 本身只是 warn，内核压力警告也是 warn；压力紧张（4）时直接变 low。
 assert.equal(m.level,'warn');
 const critical=createDevices({...harness({pressure:'4'}).env,cpus:()=>h.env.cpus()});
 await critical.refresh();await critical.refresh();
 assert.equal(critical.snapshot().memory.level,'low');
});
test('磁盘：statfs 换算成容器容量与可用空间',async()=>{
 const h=harness();
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 await devices.refresh();await devices.refresh();
 const d=devices.snapshot().disk;
 assert.equal(d.total,120699413*4096);
 assert.equal(d.free,16610491*4096);
 assert.equal(d.used,d.total-d.free);
 assert.equal(d.mount,'/');assert.equal(d.level,'warn');
});
test('强制刷新撞上常驻跳时不复用旧结果，会补一次全量采样（磁盘拿最新值）',async()=>{
 // 第一次采样拿到磁盘 A；随后常驻跳（不采磁盘）还在跑时点手动刷新，必须等它收尾再全量采一次，
 // 而不是把那一跳的快照直接返回。旧的 busy 复用逻辑会让磁盘继续停在 A。
 const diskB={bsize:4096,blocks:100000000,bfree:10000000,bavail:10000000};
 let calls=0;
 const h=harness();
 const devices=createDevices({...h.env,statfs:()=>{calls++;return Promise.resolve(calls===1?STATFS:diskB);},cpus:()=>h.env.cpus()});
 await devices.refresh(false);                       // 第 1 跳就采磁盘（ticks%30===1）
 assert.equal(devices.snapshot().disk.total,STATFS.blocks*STATFS.bsize);
 h.advance(2000);
 const routine=devices.refresh(false);               // 第 2 跳只采 CPU：正在跑
 const forced=devices.refresh(true);                 // 手动刷新不能跟着这一跳走
 await routine;
 const s=await forced;
 assert.equal(calls,2);assert.equal(s.disk.total,diskB.blocks*diskB.bsize);
});
test('只在可见数值变化时推送，空闲时不刷流',async()=>{
 const h=harness();
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 let pushes=0;devices.subscribe(()=>{pushes++;});
 await devices.refresh();                       // 首帧：状态从空变成有内存 / 磁盘 → 推一次
 h.setCpus(cpuSet(2000,10000,4));               // idle 增加 1000 / 总增加 2000 → 占用 50%
 await devices.refresh();                       // 占用率出现，可见变化 → 再推一次
 assert.equal(pushes,2);
 await devices.refresh();                       // 同样的数值（占用仍 50%、内存 / 磁盘没变）→ 不推
 assert.equal(pushes,2);
 h.setCpus(cpuSet(4500,10500,4));               // idle 只增加 500 / 总增加 3000 → 占用 83.3%
 await devices.refresh();
 assert.equal(pushes,3);
 assert.equal(devices.snapshot().cpu.level,'low');
});
test('内存读取失败时保留错误说明，CPU 与磁盘照常可用',async()=>{
 const h=harness({failMemory:true});
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 await devices.refresh();
 h.setCpus(cpuSet(2000,10000,4));
 const s=await devices.refresh();
 assert.equal(s.cpu.usage,50);
 assert.equal(s.memory,null);
 assert.match(s.error,/读取内存失败/);
 assert.equal(s.disk.level,'warn');
});
test('非 macOS 平台用 os.freemem 兜底，不落子进程',async()=>{
 let calls=0;
 const h=harness();
 const devices=createDevices({...h.env,platform:'linux',exec:()=>{calls++;return Promise.resolve('');},cpus:()=>h.env.cpus()});
 await devices.refresh();
 const m=devices.snapshot().memory;
 assert.equal(m.used,TOTAL-100);assert.equal(m.cached,0);assert.equal(m.pressure,0);
 assert.equal(calls,0);
});
test('进程：解析 ps 输出，取 basename 并把 RSS 换算成字节',()=>{
 const rows=parsePs(PS);
 assert.equal(rows.length,5);
 const otty=rows.find(r=>r.pid===100),node=rows.find(r=>r.pid===200),app=rows.find(r=>r.pid===300);
 assert.deepEqual(otty,{pid:100,name:'otty',cpu:45.3,memoryPercent:0.8,memory:204800*1024,elapsed:'03:12:00'});
 assert.equal(node.name,'node');assert.equal(node.memory,4194304*1024);assert.equal(node.elapsed,'01-02:03:04');
 assert.equal(app.name,'Bobo');   // 真实可执行文件是 Bobo，标记 self 时按大小写不敏感匹配
 assert.equal(parsePs('').length,0);assert.equal(parsePs('  PID  %CPU COMMAND\n').length,0);
});
// 假 CIM 输出：_Total / Idle 已在 PowerShell 侧过滤；"chrome#1" 是同名进程的重名后缀；
// 内存 400 / 150 字节配合 totalmem 1000 换算成 40% / 15%。
const WIN_PS=JSON.stringify([
 {Name:'node',IDProcess:200,PercentProcessorTime:12,WorkingSetPrivate:400},
 {Name:'chrome#1',IDProcess:300,PercentProcessorTime:30,WorkingSetPrivate:150},
]);
test('进程：解析 Windows 的 CIM 输出，去掉重名后缀并换算内存占比',()=>{
 const rows=parseWinProcesses(WIN_PS,1000);
 assert.equal(rows.length,2);
 assert.deepEqual(rows.find(r=>r.pid===200),{pid:200,name:'node',cpu:12,memoryPercent:40,memory:400,elapsed:''});
 assert.equal(rows.find(r=>r.pid===300).name,'chrome');
 assert.equal(parseWinProcesses('').length,0);
 assert.equal(parseWinProcesses('not json').length,0);
 // 单个进程时 ConvertTo-Json 返回对象而不是数组，也要能解析。
 assert.equal(parseWinProcesses(JSON.stringify({Name:'node',IDProcess:9,PercentProcessorTime:1,WorkingSetPrivate:10}),1000).length,1);
});
test('进程：Windows 平台走 PowerShell 分支，排序与 mac 一致',async()=>{
 const h=harness(),calls=[];
 const devices=createDevices({...h.env,platform:'win32',totalmem:()=>1000,exec:async file=>{calls.push(file);return WIN_PS;},cpus:()=>h.env.cpus()});
 const byCpu=await devices.processes({sort:'cpu'});
 assert.equal(calls.length,1);assert.match(calls[0],/powershell/);
 assert.deepEqual(byCpu.processes.map(p=>p.pid),[300,200]);
 const byMemory=await devices.processes({sort:'memory'});
 assert.deepEqual(byMemory.processes.map(p=>p.pid),[200,300]);
 assert.equal(byMemory.processes[0].memoryPercent,40);
 assert.equal(calls.length,1);   // 1.5 秒内复用同一份缓存，不重复落子进程
});
test('进程：按 CPU / 内存排序、截断，并在 1.5 秒内复用同一份缓存',async()=>{
 const h=harness();
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus(),selfPid:200});
 const byCpu=await devices.processes({sort:'cpu'});
 // bobo 自己的服务（200，selfPid）与应用（300，名为 bobo）钉在最前，其余按 CPU 占用排序。
 assert.deepEqual(byCpu.processes.map(p=>p.pid),[200,300,100,400,1]);
 assert.equal(byCpu.processes[0].self,true);assert.equal(byCpu.processes[1].self,true);
 assert.equal(byCpu.count,5);assert.equal(byCpu.error,null);
 const byMemory=await devices.processes({sort:'memory'});
 assert.deepEqual(byMemory.processes.map(p=>p.pid),[200,300,400,100,1]);
 assert.equal(h.psCalls(),1);                        // 两次调用命中同一份缓存，只落一次 ps
 const limited=await devices.processes({limit:2,sort:'cpu'});
 assert.deepEqual(limited.processes.map(p=>p.pid),[200,300,100,400]);   // 钉住的两条不占前 15 条的名额
 assert.equal(limited.count,5);
 assert.equal(h.psCalls(),1);
 h.advance(2000);
 await devices.processes({sort:'cpu'});
 assert.equal(h.psCalls(),2);                        // 缓存过期后重新采样
});
test('进程：读取失败只回错误说明，设备快照照常；非 macOS 直接说明不支持',async()=>{
 const h=harness({failPs:true});
 const devices=createDevices({...h.env,cpus:()=>h.env.cpus()});
 const r=await devices.processes();
 assert.deepEqual(r.processes,[]);assert.match(r.error,/读取进程失败/);
 await devices.refresh();h.setCpus(cpuSet(2000,10000,4));await devices.refresh();
 assert.equal(devices.snapshot().available,true);
 let calls=0;
 const other=createDevices({...h.env,platform:'linux',exec:()=>{calls++;return Promise.resolve('');},cpus:()=>h.env.cpus()});
 const r2=await other.processes();
 assert.deepEqual(r2.processes,[]);assert.match(r2.error,/支持 macOS 与 Windows/);assert.equal(calls,0);
});
