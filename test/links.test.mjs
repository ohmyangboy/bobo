import {test} from 'node:test';import assert from 'node:assert/strict';
import {
 createLinks,SERVICES,signalOf,levelOf,healthOf,purityOf,parseTrace,parseGeo,parseProxycheck,
 parseIpapi,curlError,proxyFromEnv,curlConfig,
} from '../src/links.mjs';

// 纯函数：信号格（首字节 ≤ 150/350/700 ms 四到两格，其余成功请求一格，失败零格）与等级。
test('线路：延迟信号的四档尺度',()=>{
 assert.equal(signalOf(120),4);assert.equal(signalOf(150),4);
 assert.equal(signalOf(151),3);assert.equal(signalOf(350),3);
 assert.equal(signalOf(351),2);assert.equal(signalOf(700),2);
 assert.equal(signalOf(701),1);assert.equal(signalOf(1500),1);
 assert.equal(signalOf(1501),1);assert.equal(signalOf(6000),1);assert.equal(signalOf(0),4);assert.equal(signalOf(null),0);assert.equal(signalOf(NaN),0);
 assert.equal(levelOf(4),'ok');assert.equal(levelOf(3),'ok');
 assert.equal(levelOf(2),'warn');assert.equal(levelOf(1),'low');assert.equal(levelOf(0),'low');
});
// 纯函数：一句话结论（不可达 / 很差 / 偏慢 / 需留意 / 通畅）。
test('线路：健康结论',()=>{
 assert.deepEqual(healthOf({ok:false,level:'low'}),{health:'low',healthText:'不可达'});
 assert.deepEqual(healthOf({ok:true,level:'low'}),{health:'low',healthText:'很差'});
 assert.deepEqual(healthOf({ok:true,level:'warn'}),{health:'warn',healthText:'偏慢'});
 assert.deepEqual(healthOf({ok:true,level:'ok',info:{grade:'dirty'}}),{health:'warn',healthText:'需留意'});
 assert.deepEqual(healthOf({ok:true,level:'ok',info:{grade:'clean'}}),{health:'ok',healthText:'通畅'});
});
// 纯函数：出口 IP 的类型与等级（proxycheck 优先，ip-api 兜底）。
test('线路：出口类型与纯净度',()=>{
 // 用户这台机器的实测形态：VPN + 风控 66 → 不纯净。
 const vpn=purityOf({proxycheck:{type:'VPN',risk:66,provider:'Akari Networks',country:'Singapore'}});
 assert.equal(vpn.type,'vpn');assert.equal(vpn.typeText,'VPN');assert.equal(vpn.risk,66);
 assert.equal(vpn.grade,'dirty');assert.equal(vpn.level,'low');assert.equal(vpn.source,'proxycheck.io');
 assert.equal(vpn.provider,'Akari Networks');
 // 有代理标记但风控低：算「一般」。
 assert.equal(purityOf({proxycheck:{type:'VPN',risk:20}}).grade,'ok');
 // 住宅 + 低风控：纯净；机房 + 高风控：不纯净；Tor 一律不纯净。
 assert.equal(purityOf({proxycheck:{type:'Residential',risk:5}}).grade,'clean');
 assert.equal(purityOf({proxycheck:{type:'Hosting',risk:45}}).grade,'dirty');
 assert.equal(purityOf({proxycheck:{type:'Tor',risk:10}}).grade,'dirty');
 assert.equal(purityOf({proxycheck:{type:'Hosting',risk:20}}).grade,'ok');
 // 香港普通宽带那种「Business + 风控 0」：商用网络、纯净（真实出口里常见）。
 const biz=purityOf({proxycheck:{type:'Business',risk:0,proxy:'no'}});
 assert.equal(biz.type,'business');assert.equal(biz.typeText,'商用网络');assert.equal(biz.grade,'clean');
 // 风控 ≥ 70 一律不纯净，即便类型认不出。
 assert.equal(purityOf({proxycheck:{type:'Business',risk:88}}).grade,'dirty');
 // 只有 ip-api（IPv4）：代理 / 机房标记按标记算，无标记保持类型未确认。
 const proxy=purityOf({ipapi:{proxy:true,hosting:false,mobile:false,country:'Singapore'}});
 assert.equal(proxy.type,'proxy');assert.equal(proxy.source,'ip-api.com');assert.equal(proxy.level,'warn');
 assert.equal(purityOf({ipapi:{proxy:false,hosting:true}}).type,'hosting');
 assert.equal(purityOf({ipapi:{proxy:false,hosting:true}}).typeShort,'机房');
 assert.equal(purityOf({proxycheck:{type:'VPN',risk:66}}).typeShort,'VPN');
 assert.equal(purityOf({ipapi:{proxy:false,hosting:false,mobile:false}}).typeShort,'未确认');
 assert.equal(purityOf({ipapi:{proxy:false,hosting:false,mobile:false}}).type,'unknown');
 assert.equal(purityOf({ipapi:{proxy:false,hosting:false,mobile:true}}).type,'mobile');
 // 什么都没查到时不算任何类型（页面不显示标签）。
 const none=purityOf({});
 assert.equal(none.type,'unknown');assert.equal(none.source,'');assert.equal(none.risk,null);
});
// 纯函数：Cloudflare trace、api.ip.sb、两家风控接口的解析。
test('线路：响应解析',()=>{
 assert.deepEqual(parseTrace('fl=abc\nh=chatgpt.com\nip=2407:cdc0:d002::1\nloc=SG\ncolo=SIN'),{ip:'2407:cdc0:d002::1',loc:'SG',colo:'SIN'});
 assert.deepEqual(parseTrace(''),{ip:'',loc:'',colo:''});
 const geo=parseGeo('{"ip":"188.253.121.80","country":"Singapore","city":"Singapore","asn":38136,"asn_organization":"Akari Networks","isp":"Akari"}');
 assert.deepEqual(geo,{ip:'188.253.121.80',country:'Singapore',city:'Singapore',asn:'AS38136',provider:'Akari Networks'});
 assert.equal(parseGeo('not json'),null);
 assert.deepEqual(parseProxycheck('1.2.3.4','{"status":"ok","1.2.3.4":{"risk":66,"proxy":"yes","type":"VPN"}}'),{risk:66,proxy:'yes',type:'VPN'});
 assert.equal(parseProxycheck('1.2.3.4','{"status":"denied"}'),null);
 assert.ok(parseIpapi('{"status":"success","proxy":true}'));
 assert.equal(parseIpapi('{"status":"fail","message":"reserved range"}'),null);
});
// 纯函数：curl 错误码换人话、环境变量代理、curl 配置（直连与经代理两种）。
test('线路：curl 错误、环境代理与配置',()=>{
 assert.equal(curlError(Error('curl: (28) Operation timed out after 6002 milliseconds')),'超时');
 assert.equal(curlError(Error('curl: (7) Failed to connect to 127.0.0.1 port 7890')),'连不上');
 assert.equal(curlError(Error('curl: (35) error:0A000126')),'TLS 握手失败');
 assert.equal(curlError(Error('curl: (60) SSL certificate problem')),'证书校验失败');
 assert.equal(curlError(Error('curl 退出码 3')),'请求失败');
 assert.equal(proxyFromEnv({HTTPS_PROXY:'http://127.0.0.1:7890'}),'http://127.0.0.1:7890');
 assert.equal(proxyFromEnv({https_proxy:'socks5://127.0.0.1:1080/'}),'socks5://127.0.0.1:1080');
 assert.equal(proxyFromEnv({HTTPS_PROXY:'ftp://127.0.0.1:21'}),'');
 assert.equal(proxyFromEnv({HTTPS_PROXY:'不是地址'}),'');
 assert.equal(proxyFromEnv({}),'');
 const direct=curlConfig({url:'https://example.com/',proxy:''});
 assert.match(direct,/^proxy = ""$/m);assert.match(direct,/^noproxy = "\*"$/m);
 const proxied=curlConfig({url:'https://example.com/',proxy:'http://127.0.0.1:7890'});
 assert.match(proxied,/^proxy = "http:\/\/127\.0\.0\.1:7890"$/m);assert.match(proxied,/^noproxy = ""$/m);
 assert.match(proxied,/^write-out = /m);assert.match(proxied,/^user-agent = "bobo"$/m);
});

// 可注入的探测环境：scutil 给系统代理，curl 按「url + 直连 / 代理」查表，未列出的当作连不上。
const geoBody=(ip,country,city,asn,org)=>JSON.stringify({ip,country,city,asn,asn_organization:org});
const traceBody=ip=>`fl=abc\nh=example\nip=${ip}\nloc=SG\ncolo=SIN\ntls=TLSv1.3`;
function harness({scutil='HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n',http={}}={}){
 let nowMs=1_000_000;
 const calls=[];
 const table={...http};
 const exec=async(file,args,input='',_timeout)=>{
  if(file.includes('scutil')){if(!scutil)throw Error('scutil 退出码 1');return scutil;}
  const url=/^url = "(.+)"$/m.exec(input)?.[1]||'';
  const proxy=/^proxy = "(.*)"$/m.exec(input)?.[1]||'';
  const via=proxy?'proxy':'direct';
  calls.push({url,proxy,via});
  const row=table[`${url}|${via}`];
  if(!row)throw Error(`curl: (7) Failed to connect to ${url}`);
  if(row instanceof Error)throw row;
  return `${row.body}\n${row.meta}`;
 };
 return {exec,track:calls,advance(ms){nowMs+=ms;},now:()=>nowMs};
}
// 一台「典型中国 + 本地代理」的机器：直连出口是家宽、代理出口是新加坡 VPN 节点；
// Codex / Claude / OpenCode 走 Cloudflare 回显真实出口，DeepSeek / Google 没有回显。
function typical(){
 return harness({http:{
  'https://api.ip.sb/geoip|direct':{body:geoBody('203.0.113.7','China','Shanghai',4134,'Chinanet'),meta:'200 0.120 0.100'},
  'https://api.ip.sb/geoip|proxy':{body:geoBody('188.253.121.80','Singapore','Singapore',38136,'Akari Networks'),meta:'200 0.380 0.300'},
  'https://chatgpt.com/cdn-cgi/trace|proxy':{body:traceBody('2407:cdc0:d002::1'),meta:'200 0.379 0.308'},
  'https://api.anthropic.com/cdn-cgi/trace|proxy':{body:traceBody('188.253.121.80'),meta:'200 0.199 0.150'},
  'https://opencode.ai/cdn-cgi/trace|proxy':{body:traceBody('112.120.123.178'),meta:'200 1.170 0.863'},
  'https://api.deepseek.com/|proxy':{body:'{"error":"missing key"}',meta:'401 0.150 0.045'},
  'https://generativelanguage.googleapis.com/generate_204|proxy':{body:'',meta:'204 0.448 0.350'},
  'https://proxycheck.io/v2/203.0.113.7?vpn=1&risk=1&asn=1|proxy':{body:'{"status":"ok","203.0.113.7":{"type":"Residential","risk":5,"provider":"Chinanet","country":"China"}}',meta:'200 0.200 0.180'},
  'https://proxycheck.io/v2/188.253.121.80?vpn=1&risk=1&asn=1|proxy':{body:'{"status":"ok","188.253.121.80":{"type":"VPN","risk":66,"provider":"Akari Networks","country":"Singapore"}}',meta:'200 0.210 0.190'},
  'https://proxycheck.io/v2/2407:cdc0:d002::1?vpn=1&risk=1&asn=1|proxy':{body:'{"status":"ok","2407:cdc0:d002::1":{"type":"VPN","risk":66}}',meta:'200 0.205 0.185'},
  // OpenCode 的出口 proxycheck 拒绝（免费额度用完）：退回 ip-api 的代理标记。
  'https://proxycheck.io/v2/112.120.123.178?vpn=1&risk=1&asn=1|proxy':{body:'{"status":"denied","message":"quota"}',meta:'200 0.220 0.200'},
  'http://ip-api.com/json/203.0.113.7?fields=status,message,country,regionName,city,isp,org,as,mobile,proxy,hosting|proxy':{body:'{"status":"success","country":"China","city":"Shanghai","isp":"Chinanet","proxy":false,"hosting":false,"mobile":false}',meta:'200 0.260 0.240'},
  'http://ip-api.com/json/188.253.121.80?fields=status,message,country,regionName,city,isp,org,as,mobile,proxy,hosting|proxy':{body:'{"status":"success","country":"Singapore","isp":"Akari Networks","proxy":true,"hosting":false,"mobile":false}',meta:'200 0.262 0.242'},
  'http://ip-api.com/json/112.120.123.178?fields=status,message,country,regionName,city,isp,org,as,mobile,proxy,hosting|proxy':{body:'{"status":"success","country":"Hong Kong","isp":"HKT","proxy":true,"hosting":false,"mobile":false}',meta:'200 0.268 0.246'},
 }});
}
test('线路：一次检测给出出口与服务两类线路',async()=>{
 const h=typical();
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 const first=links.refresh(true);
 assert.equal(first.checking,true);assert.equal(first.rows.length,0);   // 探测在后台跑，先回「检测中」
 await links.whenIdle();
 const s=links.snapshot();
 assert.equal(s.checking,false);assert.equal(s.proxy,'http://127.0.0.1:7890');assert.equal(s.error,'');
 assert.equal(s.rows.length,2+SERVICES.length);
 // 直连出口：家宽、120 ms（四格），类型由 proxycheck 判为住宅 / 家宽。
 const direct=s.rows[0];
 assert.equal(direct.id,'direct');assert.equal(direct.kind,'exit');assert.equal(direct.name,'系统出口');
 assert.equal(direct.ip,'203.0.113.7');assert.equal(direct.country,'China');assert.equal(direct.asn,'AS4134');
 assert.equal(direct.ms,120);assert.equal(direct.bars,4);assert.equal(direct.level,'ok');
 assert.equal(direct.info.type,'residential');assert.equal(direct.info.source,'proxycheck.io');assert.equal(direct.healthText,'通畅');
 // 代理出口：VPN + 风控 66 → 不纯净；380 ms 掉到两格。
 const via=s.rows[1];
 assert.equal(via.id,'proxy');assert.equal(via.name,'代理出口');assert.equal(via.proxy,'http://127.0.0.1:7890');
 assert.equal(via.ip,'188.253.121.80');assert.equal(via.ms,380);assert.equal(via.bars,2);assert.equal(via.level,'warn');
 assert.equal(via.info.type,'vpn');assert.equal(via.info.risk,66);assert.equal(via.info.grade,'dirty');
 assert.equal(via.info.provider,'Akari Networks');assert.equal(via.healthText,'偏慢');
 // 服务行：顺序跟随线路清单；Cloudflare 三条回显各自真实出口，其余标线路出口。
 const byId=Object.fromEntries(s.rows.map(r=>[r.id,r]));
 assert.deepEqual(SERVICES.map(x=>x.id),['codex','claude','opencode','deepseek','agy']);
 assert.equal(byId.codex.ip,'2407:cdc0:d002::1');assert.equal(byId.codex.ipSource,'trace');assert.equal(byId.codex.colo,'SIN');
 assert.equal(byId.codex.ms,379);assert.equal(byId.codex.bars,2);assert.equal(byId.codex.healthText,'偏慢');
 // Claude 的出口与代理出口相同、延迟 199 ms：速度正常但出口不纯净 → 需留意。
 assert.equal(byId.claude.ip,'188.253.121.80');assert.equal(byId.claude.ms,199);assert.equal(byId.claude.bars,3);
 assert.equal(byId.claude.info.grade,'dirty');assert.equal(byId.claude.healthText,'需留意');
 // OpenCode 经另一个香港节点（proxycheck 拒绝后由 ip-api 的代理标记兜底），1.17 s → 很差。
 assert.equal(byId.opencode.ip,'112.120.123.178');assert.equal(byId.opencode.ms,1170);assert.equal(byId.opencode.bars,1);
 assert.equal(byId.opencode.info.type,'proxy');assert.equal(byId.opencode.info.source,'ip-api.com');assert.equal(byId.opencode.healthText,'很差');
 // 没有 trace 回显的服务：出口标为线路出口（这里走的是代理）。
 assert.equal(byId.deepseek.ipSource,'route');assert.equal(byId.deepseek.ip,'188.253.121.80');
 assert.equal(byId.deepseek.host,'api.deepseek.com');assert.equal(byId.deepseek.status,401);assert.equal(byId.deepseek.healthText,'需留意');
 assert.equal(byId.agy.bars,2);assert.equal(byId.agy.status,204);assert.equal(byId.agy.healthText,'偏慢');
});
test('线路：结果按新鲜度复用，出口类型按 IP 缓存',async()=>{
 const h=typical();
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 links.refresh(true);await links.whenIdle();
 const probes=h.track.filter(c=>!c.url.includes('proxycheck')&&!c.url.includes('ip-api')).length;
 const lookups=h.track.filter(c=>c.url.includes('proxycheck')).length;
 assert.equal(lookups,4);   // 四个不同出口各查一次（Claude / DeepSeek / agy 与代理出口同 IP，命中缓存）
 // 一分钟内再问：整份快照原样返回，不发任何请求。
 const at=links.snapshot().updatedAt;
 links.refresh();assert.equal(links.snapshot().updatedAt,at);
 assert.equal(h.track.length,probes+lookups+1);   // 仅主接口失败的 IP 查一次兜底
 // 刚过新鲜期：重测延迟，但出口类型的缓存还在（3 小时）。
 h.advance(61000);links.refresh();await links.whenIdle();
 assert.ok(h.track.filter(c=>!c.url.includes('proxycheck')&&!c.url.includes('ip-api')).length>probes);
 assert.equal(h.track.filter(c=>c.url.includes('proxycheck')).length,lookups);
 // 手动「检测线路」：出口类型也重查一遍（同一 IP 至少隔一分钟，护住免费额度）。
 h.advance(61000);links.refresh(true);await links.whenIdle();
 assert.equal(h.track.filter(c=>c.url.includes('proxycheck')).length,lookups+4);
});
test('线路：没有回显的服务退回线路出口，直连探测失败时如实标注',async()=>{
 const only=harness({http:{
  // chatgpt 可达；其余全部连不上（含直连出口）。
  'https://chatgpt.com/cdn-cgi/trace|proxy':{body:traceBody('188.253.121.80'),meta:'200 0.300 0.250'},
 }});
 const links=createLinks({platform:'darwin',exec:only.exec,now:only.now,env:{}});
 links.refresh(true);await links.whenIdle();
 const s=links.snapshot();
 const direct=s.rows[0],codex=s.rows.find(r=>r.id==='codex'),deepseek=s.rows.find(r=>r.id==='deepseek');
 assert.equal(direct.ok,false);assert.equal(direct.ip,'');assert.equal(direct.bars,0);
 assert.equal(direct.error,'连不上');assert.equal(direct.healthText,'不可达');
 assert.equal(codex.ok,true);assert.equal(codex.ip,'188.253.121.80');assert.equal(codex.ipSource,'trace');
 assert.equal(deepseek.ok,false);assert.equal(deepseek.ipSource,'');   // 出口也测不到时不硬给 IP
 assert.equal(s.error,'');                                             // 还有线路通着，不算整体失败
});
test('线路：会话来源映射到它走的那条线路',async()=>{
 const h=typical();
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 assert.equal(links.linkFor('codex'),'');   // 还没探测过：没有线路可给，面板行上不画指示
 links.refresh(true);await links.whenIdle();
 assert.deepEqual(SERVICES.find(s=>s.id==='opencode').agents,['opencode','omp']);
 for(const [source,id] of [['codex','codex'],['claude','claude'],['opencode','opencode'],['omp','opencode'],['dsh','deepseek'],['agy','agy']])assert.equal(links.linkFor(source),id,source);
 // 没映射到的来源退回出口线路：有系统代理就是代理出口，没有就是直连出口。
 assert.equal(links.linkFor('unknown'),'proxy');
 assert.equal(links.linkFor(''),'proxy');
 const plain=harness({scutil:'',http:{'https://api.ip.sb/geoip|direct':{body:geoBody('203.0.113.7','China','Shanghai',4134,'Chinanet'),meta:'200 0.120 0.100'}}});
 const solo=createLinks({platform:'darwin',exec:plain.exec,now:plain.now,env:{}});
 solo.refresh(true);await solo.whenIdle();
 assert.equal(solo.linkFor('unknown'),'direct');
});
test('线路：常驻探测按周期跑，测试环境不碰真实网络',async()=>{
 const h=typical();
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 let pushes=0;links.subscribe(()=>{pushes++;});
 links.start({intervalMs:15,firstMs:5});
 await new Promise(r=>setTimeout(r,60));
 links.stop();
 const calls=h.track.length;
 assert.ok(calls>0);                // 首跳探测跑过
 assert.ok(pushes>0);               // 探测完成后通知了订阅者（状态流据此推给刘海面板）
 await new Promise(r=>setTimeout(r,40));
 assert.equal(h.track.length,calls);   // stop 之后不再探测
 // 测试环境（BOBO_HOME / 临时 HOME）里 start() 不生效，不会去连真实网络。
 const quiet=typical();
 const idle=createLinks({platform:'darwin',exec:quiet.exec,now:quiet.now,env:{BOBO_HOME:'/tmp/bobo-test'}});
 idle.start({intervalMs:5,firstMs:5});
 await new Promise(r=>setTimeout(r,40));
 idle.stop();
 assert.equal(quiet.track.length,0);
});
test('线路：折叠常驻不自动探测，展开才探测，折叠后保留缓存',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const h=typical();let active=false;
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{},shouldCheck:()=>active});
 try{
  links.start({intervalMs:15,firstMs:5});
  t.mock.timers.tick(60);assert.equal(h.track.length,0);
  active=true;t.mock.timers.tick(15);await links.whenIdle();
  assert.ok(h.track.length>0);assert.ok(links.snapshot().rows.length>0);
  const count=h.track.length;
  active=false;h.advance(61000);t.mock.timers.tick(60);
  assert.equal(h.track.length,count);assert.ok(links.snapshot().rows.length>0);
 }finally{links.stop();t.mock.timers.reset();}
});
test('线路：经代理时全部走代理，没有系统代理就只有直连出口',async()=>{
 // 环境变量兜底：scutil 读不到时代理来自 HTTPS_PROXY。
 const h=typical();
 const links=createLinks({platform:'linux',exec:h.exec,now:h.now,env:{HTTPS_PROXY:'http://127.0.0.1:7890'}});
 links.refresh(true);await links.whenIdle();
 assert.equal(links.snapshot().proxy,'http://127.0.0.1:7890');
 assert.equal(links.snapshot().rows.length,2+SERVICES.length);
 // 完全没有代理：只有一条直连出口，服务也走直连（表里只有直连的响应）。
 const plain=harness({scutil:'',http:{
  'https://api.ip.sb/geoip|direct':{body:geoBody('203.0.113.7','China','Shanghai',4134,'Chinanet'),meta:'200 0.120 0.100'},
  'https://chatgpt.com/cdn-cgi/trace|direct':{body:traceBody('203.0.113.7'),meta:'200 0.230 0.200'},
  'https://api.deepseek.com/|direct':{body:'',meta:'401 0.100 0.080'},
  'https://proxycheck.io/v2/203.0.113.7?vpn=1&risk=1&asn=1|direct':{body:'{"status":"ok","203.0.113.7":{"type":"Residential","risk":8}}',meta:'200 0.2 0.2'},
  'http://ip-api.com/json/203.0.113.7?fields=status,message,country,regionName,city,isp,org,as,mobile,proxy,hosting|direct':{body:'{"status":"success","proxy":false,"hosting":false,"mobile":false}',meta:'200 0.2 0.2'},
 }});
 const solo=createLinks({platform:'darwin',exec:plain.exec,now:plain.now,env:{}});
 solo.refresh(true);await solo.whenIdle();
 const rows=solo.snapshot().rows;
 assert.equal(solo.snapshot().proxy,'');
 assert.equal(rows.filter(r=>r.kind==='exit').length,1);
 assert.equal(rows[0].id,'direct');assert.equal(rows[0].via,'direct');
 const codex=rows.find(r=>r.id==='codex');
 assert.equal(codex.via,'direct');assert.equal(codex.ip,'203.0.113.7');assert.equal(codex.ipSource,'trace');
});

test('线路：缺失风控保持未知，识别代理标记并使用风险边界',()=>{
 for(const risk of [null,undefined,''])assert.equal(purityOf({proxycheck:{type:'Business',risk}}).risk,null);
 assert.equal(purityOf({ipapi:{proxy:false,hosting:false,mobile:false}}).grade,'unknown');
 assert.equal(purityOf({proxycheck:{type:'Business',risk:34}}).grade,'ok');
 assert.equal(purityOf({proxycheck:{type:'Business',risk:67}}).grade,'dirty');
 assert.equal(purityOf({proxycheck:{proxy:'yes',risk:20}}).type,'proxy');
 assert.equal(healthOf({info:{grade:'ok'}}).healthText,'需留意');
});
test('线路：慢请求保留一格，拒绝与限流及服务错误不算健康',async()=>{
 for(const status of [403,429,503]){
  const h=harness({http:{'https://chatgpt.com/cdn-cgi/trace|proxy':{body:'denied',meta:`${status} 2.100 0.300`}}});
  const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
  links.refresh(true);await links.whenIdle();
  const row=links.snapshot().rows.find(r=>r.id==='codex');
  assert.equal(row.ok,false);assert.equal(row.bars,0);assert.equal(row.status,status);
  assert.equal(row.healthText,{403:'访问受限',429:'请求限流',503:'服务异常'}[status]);
  assert.match(row.error,new RegExp(String(status)));
 }
 const h=harness({http:{'https://chatgpt.com/cdn-cgi/trace|proxy':{body:traceBody('1.2.3.4'),meta:'200 2.100 0.300'}}});
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 links.refresh(true);await links.whenIdle();
 assert.equal(links.snapshot().rows.find(r=>r.id==='codex').bars,1);
});
test('线路：并发同出口只查一次，失败查询一分钟后可重试',async()=>{
 const h=harness({http:{
  'https://chatgpt.com/cdn-cgi/trace|proxy':{body:traceBody('1.2.3.4'),meta:'200 0.100 0.050'},
  'https://api.anthropic.com/cdn-cgi/trace|proxy':{body:traceBody('1.2.3.4'),meta:'200 0.100 0.050'},
 }});
 const links=createLinks({platform:'darwin',exec:h.exec,now:h.now,env:{}});
 links.refresh(true);await links.whenIdle();
 const count=()=>h.track.filter(c=>c.url.includes('proxycheck')).length;
 assert.equal(count(),2); // 一次代理请求失败，再试直连；两个服务共享这次查询。
 h.advance(61000);links.refresh();await links.whenIdle();
 assert.equal(count(),4);
});
