import {test} from 'node:test';import assert from 'node:assert/strict';
import {
 createNetwork,isVirtualInterface,interfaceKind,parsePingTime,parseNetstat,parseProcNetDev,
 parseDefaultRoute,parseRouteInterface,parseHardwarePorts,latencyLevel,rateLevel,
} from '../src/network.mjs';

// 纯函数：macOS 的 ping 输出（成功行有 time=，超时只有统计行）。
test('延迟：ping 输出解析与三档尺度',()=>{
 assert.equal(parsePingTime('64 bytes from 1.1.1.1: icmp_seq=0 ttl=52 time=262.726 ms'),262.726);
 assert.equal(parsePingTime('64 bytes from 1.1.1.1: icmp_seq=0 ttl=52 time<1 ms'),1);
 assert.equal(parsePingTime('Request timeout for icmp_seq 0'),null);
 assert.equal(parsePingTime('--- 1.1.1.1 ping statistics ---\n1 packets transmitted, 0 packets received'),null);
 assert.equal(parsePingTime(''),null);
 // 阈值：< 60ms 正常、< 200ms 偏慢、≥ 200ms 很差；没有读数（探测失败）没有等级。
 assert.equal(latencyLevel(12),'ok');assert.equal(latencyLevel(59.9),'ok');
 assert.equal(latencyLevel(60),'warn');assert.equal(latencyLevel(199),'warn');
 assert.equal(latencyLevel(200),'low');assert.equal(latencyLevel(1200),'low');
 assert.equal(latencyLevel(null),null);assert.equal(latencyLevel(NaN),null);
});
// 纯函数：下载 / 上传的四档尺度（空闲 / 正常 / 繁忙 / 接近跑满）。
test('流量：四档尺度',()=>{
 assert.equal(rateLevel(0),'idle');assert.equal(rateLevel(64*1024-1),'idle');
 assert.equal(rateLevel(64*1024),'ok');assert.equal(rateLevel(4*1024*1024-1),'ok');
 assert.equal(rateLevel(4*1024*1024),'warn');assert.equal(rateLevel(64*1024*1024-1),'warn');
 assert.equal(rateLevel(64*1024*1024),'low');assert.equal(rateLevel(200*1024*1024),'low');
});
// 纯函数：网卡字节数解析（macOS 的 netstat 与 Linux 的 /proc/net/dev）。
test('网卡：两种计数器输出解析',()=>{
 const mac=`Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0        1500  <Link#11>   82:79:6c:81:06:74 35966987     0 34313215692 30135463     0 25821342145     0
en0        1500  fe80::14a2: fe80:b::14a2:e49c 35966987     - 34313215692 30135463     - 25821342145     -
utun5      1380  <Link#21>                           32     0       4516       28     0       3245     0`;
 assert.deepEqual(parseNetstat(mac,'en0'),{download:34313215692,upload:25821342145});
 assert.deepEqual(parseNetstat(mac,'utun5'),{download:4516,upload:3245});
 assert.equal(parseNetstat(mac,'en9'),null);
 const linux=`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234       5    0    0    0     0          0         0     1234       5    0    0    0     0       0          0
  wlan0: 987654321 1000 0 0 0 0 0 0 123456789 900 0 0 0 0 0 0`;
 assert.deepEqual(parseProcNetDev(linux,'wlan0'),{download:987654321,upload:123456789});
 assert.deepEqual(parseProcNetDev(linux,'lo'),{download:1234,upload:1234});
 assert.equal(parseProcNetDev(linux,'eth0'),null);
});
// 纯函数：默认路由与接口清单（macOS 的 route / networksetup、Linux 的 /proc/net/route）。
test('网卡：默认路由与接口类型',()=>{
 assert.equal(parseRouteInterface('   route to: default\n    gateway: 172.20.10.1\n  interface: en0\n'),'en0');
 assert.equal(parseRouteInterface('route: writing to routing socket'),null);
 assert.equal(parseDefaultRoute('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0102A8C0\t0003\n'),'eth0');
 assert.equal(parseDefaultRoute('Iface\tDestination\tGateway\n'),null);
 const ports=parseHardwarePorts(`Hardware Port: Ethernet Adapter (en3)
Device: en3
Ethernet Address: f2:00:b3:a2:30:61

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 7c:3b:2d:95:31:0f
`);
 assert.equal(ports.en0.kind,'wifi');assert.equal(ports.en0.label,'Wi-Fi');
 assert.equal(ports.en3.kind,'ethernet');
 assert.equal(interfaceKind('wlan0'),'wifi');assert.equal(interfaceKind('eth0'),'ethernet');
 assert.equal(interfaceKind('en0','Thunderbolt Bridge'),'ethernet');
 assert.equal(interfaceKind('xyz0'),'other');
 // 虚拟接口：VPN / 隧道 / 无线直连 / 桥接 / 热点都算，物理网卡不算。
 for(const name of ['utun1500','ipsec0','ppp0','tun0','tap0','gif0','stf0','wg0','awdl0','llw0','bridge0','ap1',''])assert.equal(isVirtualInterface(name),true,name);
 for(const name of ['en0','eth0','wlan0','en5'])assert.equal(isVirtualInterface(name),false,name);
});

// 可注入的采样环境：route 指到 en0、netstat 计数器逐次给出、ping 输出可指定。
function harness({route='en0',ports=true,counters=[{download:1000,upload:2000},{download:1000+4*1024*1024,upload:2000+128*1024}],ping='time=25.4 ms',failPing=false,failCounters=false,list}={}){
 let nowMs=1_000_000,counterCalls=0,pingCalls=0;
 const interfaces=()=>list||{
  lo0:[{family:'IPv4',address:'127.0.0.1',internal:true}],
  en0:[{family:'IPv4',address:'192.168.1.2',internal:false}],
  utun0:[{family:'IPv4',address:'10.8.0.2',internal:false}],
  awdl0:[{family:'IPv6',address:'fe80::1',internal:false}],
 };
 const env={
  now:()=>nowMs,
  interfaces,
  exec:async(file,args)=>{
   if(file.includes('networksetup')){if(!ports)throw Error('no networksetup');return 'Hardware Port: Wi-Fi\nDevice: en0\n';}
   if(file.includes('route'))return '   route to: default\n  interface: '+route+'\n';
   if(file.includes('netstat')){
    if(failCounters)throw Error('netstat 退出码 1');
    const c=counters[Math.min(counterCalls,counters.length-1)];counterCalls++;
    return `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 <Link#11> 82:79:6c:81:06:74 10 0 ${c.download} 20 0 ${c.upload} 0`;
   }
   if(file.includes('ping')){pingCalls++;if(failPing)throw Error('ping 退出码 2');return ping;}
   throw Error('未知命令 '+file);
  },
 };
 return {env,advance(ms=2000){nowMs+=ms;},pingCalls:()=>pingCalls};
}
test('网络快照：接口、延迟与两跳之间算出的速率',async()=>{
 const h=harness();
 const net=createNetwork({...h.env,tcp:async()=>null});
 const first=await net.refresh(true);
 assert.equal(first.available,true);
 assert.deepEqual(first.interface,{name:'en0',address:'192.168.1.2',kind:'wifi',label:'Wi-Fi'});
 assert.deepEqual(first.latency,{ms:25.4,level:'ok',source:'icmp',host:'1.1.1.1',at:1_000_000});
 assert.equal(first.online,true);
 // 首跳只立基线：还没有速率可言。
 assert.deepEqual(first.download,{bytesPerSec:0,level:'idle'});
 h.advance();
 const second=await net.refresh(false);
 assert.equal(second.download.bytesPerSec,2*1024*1024);   // 2 秒里多了 4 MB
 assert.equal(second.download.level,'ok');
 assert.equal(second.upload.bytesPerSec,64*1024);assert.equal(second.upload.level,'ok');
 // 累计流量只累加观察到的增量（首跳只立基线）。
 assert.deepEqual(second.totals.download,4*1024*1024);assert.equal(second.totals.upload,128*1024);
 // 延迟每 3 跳才探一次：第二跳不重探，读数保持。
 assert.equal(h.pingCalls(),1);
 assert.equal(second.latency.ms,25.4);
});
test('网络快照：只在可见数值变化时推送',async()=>{
 const h=harness();
 const net=createNetwork({...h.env,tcp:async()=>null});
 let pushes=0;net.subscribe(()=>{pushes++;});
 await net.refresh(true);                              // 首帧：有接口与延迟 → 推一次
 assert.equal(pushes,1);
 h.advance();await net.refresh(false);                 // 速率从 0 变成 2 MB/s → 推
 assert.equal(pushes,2);
 h.advance();await net.refresh(false);                 // 计数器没再走 → 速率回到 0 → 推
 assert.equal(pushes,3);
 h.advance();await net.refresh(false);                 // 速率、延迟都没变 → 不推
 assert.equal(pushes,3);
});
test('网络快照：VPN 主接口退回物理网卡，接口换了重立基线',async()=>{
 const h=harness({route:'utun0'});
 const net=createNetwork({...h.env,tcp:async()=>null});
 const s=await net.refresh(true);
 assert.equal(s.interface.name,'en0');                 // route 指到 utun0，仍统计物理网卡
 assert.equal(s.interface.kind,'wifi');
 const h2=harness({route:'utun0',counters:[{download:0,upload:0},{download:999999,upload:999999}]});
 const net2=createNetwork({...h2.env,tcp:async()=>null});
 const a=await net2.refresh(true);
 assert.deepEqual(a.download,{bytesPerSec:0,level:'idle'});
 h2.advance();
 const b=await net2.refresh(false);                    // 同一接口的第二跳照常算
 assert.equal(b.download.bytesPerSec,999999/2);
});
test('网络快照：ICMP 失败退回 TCP，两个都没响应就是断网',async()=>{
 const h=harness({failPing:true});
 let tcpCalls=0;
 const net=createNetwork({...h.env,tcp:async()=>{tcpCalls++;return 12.5;}});
 const s=await net.refresh(true);
 assert.equal(tcpCalls,1);
 assert.equal(s.latency.source,'tcp');assert.equal(s.latency.ms,12.5);assert.equal(s.latency.level,'ok');
 assert.equal(s.online,true);
 // TCP 也连不上：online=false、没有延迟读数，接口信息照常。
 const dead=createNetwork({...harness({failPing:true}).env,tcp:async()=>null});
 const d=await dead.refresh(true);
 assert.equal(d.online,false);assert.equal(d.latency,null);
 assert.equal(d.interface.name,'en0');assert.equal(d.available,true);
});
test('网络快照：计数器读取失败给出说明，恢复后继续',async()=>{
 const h=harness({failCounters:true});
 const net=createNetwork({...h.env,tcp:async()=>null});
 const s=await net.refresh(true);
 assert.match(s.error,/读取网卡计数器失败/);
 assert.equal(s.available,true);
 // 下一跳重新解析接口（resolveNext）后计数器恢复，错误随即消失。
 const ok=createNetwork({...harness().env,tcp:async()=>null});
 await ok.refresh(true);await ok.refresh(false);
 assert.equal(ok.snapshot().error,null);
});
test('网络快照：非 macOS / Linux 平台直接说明不支持',async()=>{
 let calls=0;
 const net=createNetwork({platform:'win32',exec:async()=>{calls++;return '';}});
 const s=await net.refresh(true);
 assert.equal(s.available,false);
 assert.match(s.error,/支持 macOS 与 Linux/);
 assert.equal(s.interface,null);assert.equal(s.online,null);
 assert.equal(calls,0);
});
test('网络快照：没有物理网卡时不装作有数据',async()=>{
 const list={lo0:[{family:'IPv4',address:'127.0.0.1',internal:true}],utun0:[{family:'IPv4',address:'10.8.0.2',internal:false}]};
 const net=createNetwork({...harness({list}).env,tcp:async()=>null});
 const s=await net.refresh(true);
 assert.equal(s.interface,null);
 assert.match(s.error,/没有找到可用的网络接口/);
 // 没有接口能统计流量，但延迟探测照常进行：有延迟读数时整体仍算「有数据」。
 assert.equal(s.latency.ms,25.4);
 assert.equal(s.available,true);
 assert.deepEqual(s.download,{bytesPerSec:0,level:'idle'});
});
