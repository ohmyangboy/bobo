import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createUsage, agySnapshot, macHTTPSProxy, curlUsage, claudeSnapshot, claudeCredentials, keychainDecode, tunnelInterface} from '../src/usage.mjs';
// 每日历史按本地日历分桶，测试固定 UTC，让「天」的断言在任何时区都稳定。
process.env.TZ='UTC';
// 与 CodexBar 的 OpenCodeGoLocalUsageReader 测试同一基准：2026-03-06T12:00:00Z。
const NOW=1772798400000;
const openCodeDir=home=>path.join(home,'.local/share/opencode');
const makeHome=()=>fs.mkdtemp(path.join(os.tmpdir(),'bobo-usage-'));
const cleanup=home=>fs.rm(home,{recursive:true,force:true});
const at=(base,deltaMs)=>base+deltaMs;
const provider=(snapshot,id)=>snapshot.providers.find(p=>p.id===id);
test('Codex：只采用有效的 macOS HTTPS 系统代理',()=>{
 assert.equal(macHTTPSProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890'),'http://127.0.0.1:7890');
 assert.equal(macHTTPSProxy('HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890'),'');
 assert.equal(macHTTPSProxy('HTTPSEnable : 1\nHTTPSProxy : bad/host\nHTTPSPort : 7890'),'');
 assert.equal(macHTTPSProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 0'),'');
});
test('Codex：代理请求能带账号头读取额度响应',async()=>{
 let request=null;
 const proxy=http.createServer((req,res)=>{
  request={url:req.url,authorization:req.headers.authorization,account:req.headers['chatgpt-account-id']};
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({rate_limit:{primary_window:{used_percent:42,limit_window_seconds:18000}}}));
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{
  const {port}=proxy.address();
  const response=await curlUsage(`http://127.0.0.1:${port}`,{'authorization':'Bearer fake-token','chatgpt-account-id':'acct-test'},'http://codex-usage.test/backend-api/wham/usage');
  assert.equal(response.status,200);
  assert.equal((await response.json()).rate_limit.primary_window.used_percent,42);
  assert.deepEqual(request,{url:'http://codex-usage.test/backend-api/wham/usage',authorization:'Bearer fake-token',account:'acct-test'});
 }finally{await new Promise(resolve=>proxy.close(resolve));}
});
// 设置是异步写盘的（原子写 + 串行化），轮询等到它落盘，避免和并发负载抢时间。
async function waitFor(fn,ms=1000){const end=Date.now()+ms;for(;;){try{return await fn();}catch(e){if(Date.now()>end)throw e;await new Promise(r=>setTimeout(r,20));}}}
// 建一个最小可用的 OpenCode 数据库（message + part）；authKey 为 null 时连 auth.json 都不写（纯本机、不联网）。
async function makeHomeWithDb({authKey=null,build}={}){
 const home=await makeHome(),dir=openCodeDir(home);await fs.mkdir(dir,{recursive:true});
 if(authKey)await fs.writeFile(path.join(dir,'auth.json'),JSON.stringify({'opencode-go':{type:'api',key:authKey}}));
 const file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE message(id TEXT PRIMARY KEY, time_created INTEGER, data TEXT)');
 db.exec('CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT)');
 if(build){
  const message=(id,createdMs,cost,{model='deepseek-v4-flash',provider='opencode-go',role='assistant'}={})=>db.prepare('INSERT INTO message(id,time_created,data) VALUES(?,?,?)').run(id,createdMs,JSON.stringify({providerID:provider,role,cost,modelID:model,time:{created:createdMs}}));
  const part=(id,messageID,{type='step-finish',cost,createdMs}={})=>db.prepare('INSERT INTO part(id,message_id,data) VALUES(?,?,?)').run(id,messageID,JSON.stringify({type,...(cost===undefined?{}:{cost}),...(createdMs===undefined?{}:{time:{created:createdMs}})}));
  build({message,part});
 }
 db.close();
 return {home,file};
}
// 写一份 Codex 的 auth.json：access token 用假的 JWT，便于测账号 ID 与过期判断。
const jwt=payload=>Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.sig';
async function writeCodexAuth(home,{accessToken=jwt({exp:Math.floor(NOW/1000)+3600}),accountId='acct-1',refreshToken='r',apiKey=null}={}){
 const dir=path.join(home,'.codex');await fs.mkdir(dir,{recursive:true});
 const tokens={access_token:accessToken,refresh_token:refreshToken,id_token:jwt({}),account_id:accountId};
 await fs.writeFile(path.join(dir,'auth.json'),JSON.stringify(apiKey?{OPENAI_API_KEY:apiKey}:{tokens,auth_mode:'chatgpt',last_refresh:'2026-03-06T00:00:00Z'}));
}
const fakeFetch=(body,{status=200}={})=>({status,ok:status>=200&&status<300,json:async()=>body});
const codexBody=({primary={used_percent:25,limit_window_seconds:18000,reset_after_seconds:3600,reset_at:Math.floor(NOW/1000)+3600},secondary={used_percent:30,limit_window_seconds:604800,reset_after_seconds:86400,reset_at:Math.floor(NOW/1000)+86400},plan='plus'}={})=>({plan_type:plan,rate_limit:{primary_window:primary,secondary_window:secondary},credits:{has_credits:false,unlimited:false,balance:'0'}});
// OpenCode 官方用量接口的形状：percent 是「已用百分比」（0...100），resetsAt 是 ISO 时间。
const opencodeBody=({rolling={status:'ok',percent:23},weekly={status:'ok',percent:11},monthly={status:'rate-limited',percent:100}}={})=>({usage:{
 rolling:{...rolling,resetsAt:new Date(NOW+3600e3).toISOString()},
 weekly:{...weekly,resetsAt:new Date(NOW+86400e3).toISOString()},
 monthly:{...monthly,resetsAt:new Date(NOW+7200e3).toISOString()}}});
// 只对指定地址返回响应：测试里绝不允许真联网（别的地址直接抛错）。
const routeFetch=(pattern,fn,calls)=>async(url,options)=>{if(!pattern.test(String(url)))throw Error('测试没有为该地址准备响应：'+url);calls?.();return fn(url,options);};

test('OpenCode Go：官方用量接口优先（percent 是已用百分比，重置按 resetsAt），历史仍用本机数据',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-test-opencode',build:({message})=>message('m1',at(NOW,-60000),2.0)});
 let calls=0;
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:routeFetch(/opencode\.ai\/zen\/go\/v1\/usage/,async()=>fakeFetch(opencodeBody()),()=>calls++)});
 try{
  const local=provider(await usage.refresh(),'opencode-go');
  assert.equal(calls,1,'配了 key 就该调用官方接口');
  assert.equal(local.available,true);assert.equal(local.source,'api');assert.equal(local.estimated,false);
  const win=key=>local.windows.find(w=>w.key===key);
  assert.equal(win('session').usedPercent,23);assert.equal(win('session').remainingPercent,77);assert.equal(win('session').resetInSec,3600);
  assert.equal(win('session').usedUSD,null);
  assert.equal(win('week').usedPercent,11);assert.equal(win('week').remainingPercent,89);
  assert.equal(win('month').usedPercent,100);assert.equal(win('month').remainingPercent,0);assert.equal(win('month').status,'rate-limited');
  assert.deepEqual(local.windows.map(w=>w.label),['5 小时滚动','本周','账单月']);
  // 成本历史仍然来自本机 opencode.db（接口不提供每日明细）。
  assert.equal(local.totals.costUSD,2);assert.equal(local.daily.length,1);assert.equal(local.models[0].name,'deepseek-v4-flash');
  assert.equal(local.error,null);
 }finally{await usage.stop();await cleanup(home);}
});

test('OpenCode Go：接口失败退回本机估算并标出原因，没有 key 时只用本机估算',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-test-opencode',build:({message})=>message('m1',at(NOW,-60000),3.0)});
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('getaddrinfo ENOTFOUND opencode.ai');}});
 try{
  const local=provider(await usage.refresh(),'opencode-go');
  assert.equal(local.source,'local');assert.equal(local.estimated,true);
  assert.equal(local.windows.find(w=>w.key==='session').usedUSD,3);
  assert.equal(local.windows.find(w=>w.key==='session').usedPercent,25);
  assert.match(local.error,/OpenCode 额度接口失败，改用本机估算/);
 }finally{await usage.stop();await cleanup(home);}
 // 环境变量里的 key（CodexBar 的读取顺序）也算数：没有 auth.json 也能走接口。
 const bare=await makeHome();
 let usedKey='';
 const envKey=createUsage({home:bare,now:()=>NOW,env:{OPENCODE_API_KEY:'"sk-env-key"'},fetchImpl:async(url,options)=>{usedKey=options.headers.authorization;return fakeFetch(opencodeBody());}});
 try{
  const local=provider(await envKey.refresh(),'opencode-go');
  assert.equal(local.source,'api');assert.equal(usedKey,'Bearer sk-env-key','环境变量里的 key 会去掉引号再使用');
 }finally{await envKey.stop();await cleanup(bare);}
});

test('OpenCode Go：本机口径与 CodexBar 一致（5 小时 / UTC 周 / 账单月），没有 key 时不联网',async()=>{
 const {home}=await makeHomeWithDb({build:({message})=>{
  message('m1',Date.parse('2026-03-06T11:00:00.000Z'),3.0);
  message('m2',Date.parse('2026-03-05T12:00:00.000Z'),6.0);
  message('m3',Date.parse('2026-02-25T07:53:16.000Z'),2.0);
 }});
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('不该联网：'+url);}});
 try{
  const s=await usage.refresh(),local=provider(s,'opencode-go');
  assert.equal(s.available,true);assert.equal(s.selected,'opencode-go');
  assert.equal(provider(s,'codex').available,false);assert.match(provider(s,'codex').reason,/codex login/);
  assert.equal(local.source,'local');assert.equal(local.estimated,true);
  assert.deepEqual(local.limits,{session:12,week:30,month:60});
  const win=key=>local.windows.find(w=>w.key===key);
  // 5 小时窗口：只有 11:00 那条（3 美元 / 12 = 25%），重置时间 = 最早一条 + 5 小时。
  assert.equal(win('session').usedUSD,3);assert.equal(win('session').usedPercent,25);assert.equal(win('session').remainingPercent,75);assert.equal(win('session').resetInSec,14400);
  // 周窗口从周一 00:00Z 起：3 + 6 = 9 美元 / 30 = 30%。
  assert.equal(win('week').usedUSD,9);assert.equal(win('week').usedPercent,30);assert.equal(win('week').resetInSec,216000);
  // 账单月按最早一条记录（2 月 25 日 07:53:16）锚定：2 + 6 + 3 = 11 美元 / 60 = 18.3%。
  assert.equal(win('month').usedUSD,11);assert.equal(win('month').usedPercent,18.3);assert.equal(win('month').resetInSec,1626796);
  assert.deepEqual(local.daily.map(d=>[d.day,d.costUSD,d.calls]),[['2026-02-25',2,1],['2026-03-05',6,1],['2026-03-06',3,1]]);
  assert.deepEqual(local.models,[{name:'deepseek-v4-flash',costUSD:11,calls:3}]);
  assert.deepEqual(local.totals,{costUSD:11,calls:3});
 }finally{await usage.stop();await cleanup(home);}
});

test('OpenCode Go：步骤分片费用优先，没有分片的消息回退到消息级费用',async()=>{
 const {home}=await makeHomeWithDb({build:({message,part})=>{
  message('m1',at(NOW,-3600000),9.0);
  part('p1','m1',{cost:1,createdMs:at(NOW,-3600000)});
  part('p2','m1',{cost:2,createdMs:at(NOW,-3500000)});
  message('m2',at(NOW,-7200000),3.0);
  message('m3',at(NOW,-10800000),4.0);
  part('p3','m3',{type:'text'});
 }});
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('不该联网：'+url);}});
 try{
  const local=provider(await usage.refresh(),'opencode-go');
  // 1 + 2（分片）+ 3（消息级）+ 4（非 step-finish 分片，按消息级）= 10。
  assert.equal(local.windows.find(w=>w.key==='session').usedUSD,10);
  assert.equal(local.windows.find(w=>w.key==='session').usedPercent,83.3);
  assert.equal(local.daily.length,1);assert.equal(local.daily[0].calls,4);
  assert.deepEqual(local.totals,{costUSD:10,calls:4});
 }finally{await usage.stop();await cleanup(home);}
});

test('OpenCode Go：没有数据库、没有记录时给出可读原因',async()=>{
 const bare=await makeHome();
 const noDb=createUsage({home:bare,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('不该联网：'+url);}});
 try{
  const local=provider(await noDb.refresh(),'opencode-go');
  assert.equal(local.available,false);assert.match(local.reason,/opencode\.db/);
 }finally{await noDb.stop();await cleanup(bare);}
 // 有库没记录、auth 里也没有 opencode-go：未检测到。
 const {home}=await makeHomeWithDb();
 const none=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('不该联网：'+url);}});
 try{
  const local=provider(await none.refresh(),'opencode-go');
  assert.equal(local.available,false);assert.match(local.reason,/未检测到 OpenCode Go/);
 }finally{await none.stop();await cleanup(home);}
});

test('OpenCode Go：只有授权没有记录时接口返回空也按零用量展示，而不是报不可用',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-test-opencode'});
 let calls=0;
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:routeFetch(/opencode\.ai/,async()=>fakeFetch({usage:{}}),()=>calls++)});
 try{
  const local=provider(await usage.refresh(),'opencode-go');
  assert.equal(calls,1);
  assert.equal(local.available,true);
  for(const key of ['session','week','month'])assert.equal(local.windows.find(w=>w.key===key).remainingPercent,100);
  assert.ok(local.windows.find(w=>w.key==='session').resetsAt>=NOW,'没有记录时也要给下一次重置时间');
  assert.match(local.error,/没有返回窗口数据/);
  assert.deepEqual(local.daily,[]);assert.deepEqual(local.totals,{costUSD:0,calls:0});
 }finally{await usage.stop();await cleanup(home);}
});

test('OpenCode Go：干净关闭的 WAL 库也只读打开，不创建 sidecar',async()=>{
 const home=await makeHome(),dir=openCodeDir(home);await fs.mkdir(dir,{recursive:true});
 const file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE message(id TEXT PRIMARY KEY, time_created INTEGER, data TEXT)');
 db.exec('CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT)');
 db.exec('PRAGMA journal_mode=WAL');
 db.prepare('INSERT INTO message(id,time_created,data) VALUES(?,?,?)').run('m1',at(NOW,-60000),JSON.stringify({providerID:'opencode-go',role:'assistant',cost:6,modelID:'m',time:{created:at(NOW,-60000)}}));
 db.close();
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{throw Error('不该联网：'+url);}});
 try{
  const local=provider(await usage.refresh(),'opencode-go');
  assert.equal(local.available,true);assert.equal(local.windows.find(w=>w.key==='session').usedUSD,6);
  await assert.rejects(fs.access(file+'-wal'));
  await assert.rejects(fs.access(file+'-shm'));
 }finally{await usage.stop();await cleanup(home);}
});

test('Codex：窗口按 limit_window_seconds 归类，主窗口是周窗口时不误判成 5 小时',async()=>{
 const home=await makeHome();await writeCodexAuth(home);
 const body=codexBody({primary:{used_percent:100,limit_window_seconds:604800,reset_after_seconds:191873,reset_at:Math.floor(NOW/1000)+191873},secondary:null,plan:'prolite'});
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async()=>fakeFetch(body)});
 try{
  const s=await usage.refresh(),codex=provider(s,'codex');
  assert.equal(s.available,true);assert.equal(s.selected,'codex','默认选第一家可用的（Codex）');
  assert.equal(codex.source,'api');assert.equal(codex.plan,'prolite');assert.equal(codex.estimated,false);
  assert.equal(codex.windows.length,1);
  assert.equal(codex.windows[0].key,'week');assert.equal(codex.windows[0].label,'本周');
  assert.equal(codex.windows[0].usedPercent,100);assert.equal(codex.windows[0].remainingPercent,0);
  assert.equal(codex.windows[0].resetInSec,191873);
 }finally{await usage.stop();await cleanup(home);}
});

test('Codex：正常读取 5 小时 + 周两个窗口，selected 点击后循环并持久化',async()=>{
 const {home}=await makeHomeWithDb({build:({message})=>message('m1',at(NOW,-60000),1.0)});
 await writeCodexAuth(home);
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{if(!/chatgpt\.com/.test(String(url)))throw Error('不该联网：'+url);return fakeFetch(codexBody());}});
 try{
  let s=await usage.refresh(),codex=provider(s,'codex');
  assert.deepEqual(codex.windows.map(w=>[w.key,w.label,w.usedPercent,w.remainingPercent]),[['session','5 小时滚动',25,75],['week','本周',30,70]]);
  assert.equal(s.selected,'codex');
  s=usage.cycleProvider();
  assert.equal(s.selected,'opencode-go','点击切换');
  s=usage.cycleProvider();
  assert.equal(s.selected,'codex','再点回到 Codex');
  // 写盘是异步的：等到文件里的顺序就是当前顺序（而不是更早那一次），避免和下一次切换赛跑。
  const readSettings=async()=>JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  const waitOrder=want=>waitFor(async()=>{const r=await readSettings();if((r.order||[]).join()!==want)throw Error('顺序还没写到 '+want);return r;});
  const saved=await waitOrder('claude,agy,codex,opencode-go');
  assert.equal(saved.order.join(),'claude,agy,codex,opencode-go','两次点击切换把前两家依次挪到了末尾');
  // 新进程读同一份设置：顺序被记住，折叠胶囊显示顺序里第一个可用的那家。
  usage.selectProvider('opencode-go');
  await waitOrder('opencode-go,claude,agy,codex');
  const again=createUsage({home,now:()=>NOW,env:{},fetchImpl:async()=>fakeFetch(codexBody())});
  try{
   const s2=await again.refresh();
   assert.equal(s2.selected,'opencode-go');
   assert.deepEqual(s2.providers.map(p=>p.id),['opencode-go','claude','agy','codex'],'快照按用户排的顺序返回');
  }finally{await again.stop();}
  // 拖动排序（setOrder）：认不出的 id 忽略、没提到的按默认顺序补在后面；agy 不可用时显示下一个可用的。
  assert.deepEqual(usage.setOrder(['agy','codex']).providers.map(p=>p.id),['agy','codex','claude','opencode-go']);
  assert.equal(usage.snapshot().selected,'codex','顺序里第一家不可用就显示下一家');
  await waitOrder('agy,codex,claude,opencode-go');
  assert.equal(usage.selectProvider('不存在的来源'),usage.snapshot(),'认不出的来源不动任何状态');
 }finally{await usage.stop();await cleanup(home);}
});

test('额度圆环的范围：每家在它自己的窗口之间循环，选择持久化，认不出的范围回退',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-test-opencode',build:({message})=>message('m1',at(NOW,-60000),1.0)});
 await writeCodexAuth(home);
 const fetchImpl=async url=>{const target=String(url);if(/opencode\.ai\/zen\/go\/v1\/usage/.test(target))return fakeFetch(opencodeBody());if(/chatgpt\.com/.test(target))return fakeFetch(codexBody());throw Error('测试没有为该地址准备响应：'+url);};
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl});
 const readSettings=async()=>JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
 try{
  let s=await usage.refresh();
  assert.equal(provider(s,'codex').range,'session','默认显示 5 小时窗口');
  assert.equal(provider(s,'opencode-go').range,'session');
  // 各切各的：OpenCode Go 三档循环（5 小时 → 本周 → 账单月 → 5 小时），Codex 只有两档，互不影响。
  s=usage.cycleRange('opencode-go');assert.equal(provider(s,'opencode-go').range,'week');
  s=usage.cycleRange('codex');assert.equal(provider(s,'codex').range,'week');
  assert.equal(provider(s,'opencode-go').range,'week','切 Codex 不该动 OpenCode Go');
  s=usage.cycleRange('opencode-go');assert.equal(provider(s,'opencode-go').range,'month');
  s=usage.cycleRange('opencode-go');assert.equal(provider(s,'opencode-go').range,'session','三档循环回第一档');
  s=usage.cycleRange('codex');assert.equal(provider(s,'codex').range,'session','两档来回切');
  assert.equal(usage.cycleRange('不存在的来源'),s,'认不出的来源不动任何状态');
  // 写盘：ranges 按来源记，重启后还在（Codex 的切到本周、OpenCode Go 的切到账单月）。
  usage.cycleRange('opencode-go');
  usage.cycleRange('opencode-go');
  usage.cycleRange('codex');
  const saved=await waitFor(async()=>{const r=await readSettings();if(r?.ranges?.['opencode-go']!=='month'||r?.ranges?.codex!=='week')throw Error('范围还没写盘');return r;});
  assert.deepEqual(saved.ranges,{'opencode-go':'month',codex:'week'});
  const again=createUsage({home,now:()=>NOW,env:{},fetchImpl});
  try{
   const s2=await again.refresh();
   assert.equal(provider(s2,'opencode-go').range,'month','重启后记住的范围要读回来');
   assert.equal(provider(s2,'codex').range,'week');
  }finally{await again.stop();}
  // 服务端不再返回记住的那一档时自动回退（按 5 小时 → 第一档的顺序），不会留下一个空范围。
  const shrunk=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{
   if(/opencode\.ai/.test(String(url)))return fakeFetch({usage:{weekly:{status:'ok',percent:11,resetsAt:new Date(NOW+86400e3).toISOString()}}});
   return fakeFetch(codexBody());
  }});
  try{
   const s3=await shrunk.refresh();
   assert.equal(provider(s3,'opencode-go').range,'week','没有记住的那一档就回退到第一档');
   assert.equal(shrunk.cycleRange('opencode-go'),s3,'只有一档时不循环');
  }finally{await shrunk.stop();}
 }finally{await usage.stop();await cleanup(home);}
});

test('Codex：登录过期、API Key、401、网络失败都给出可读原因，且失败不覆盖上一次成功的数据',async()=>{
 // 过期：连请求都不该发。
 const expired=await makeHome();await writeCodexAuth(expired,{accessToken:jwt({exp:Math.floor(NOW/1000)-600})});
 let calls=0;
 const expiredUsage=createUsage({home:expired,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(codexBody());}});
 try{
  const codex=provider(await expiredUsage.refresh(),'codex');
  assert.equal(codex.available,false);assert.match(codex.reason,/已过期/);assert.equal(calls,0);
 }finally{await expiredUsage.stop();await cleanup(expired);}
 // 只有 API Key。
 const apiKey=await makeHome();await writeCodexAuth(apiKey,{apiKey:'sk-test'});
 const apiKeyUsage=createUsage({home:apiKey,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(codexBody());}});
 try{assert.match(provider(await apiKeyUsage.refresh(),'codex').reason,/API Key/);assert.equal(calls,0);}
 finally{await apiKeyUsage.stop();await cleanup(apiKey);}
 // 没有 auth.json。
 const missing=await makeHome();
 const missingUsage=createUsage({home:missing,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(codexBody());}});
 try{assert.match(provider(await missingUsage.refresh(),'codex').reason,/codex login/);assert.equal(calls,0);}
 finally{await missingUsage.stop();await cleanup(missing);}
 // 401 与网络错误：第一次成功，第二次失败时保留上一次的窗口数据并带上 error。
 const home=await makeHome();await writeCodexAuth(home);
 let clock=NOW,respond=true;
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:async url=>{if(!/chatgpt\.com/.test(String(url)))throw Error('不该联网：'+url);if(respond)return fakeFetch(codexBody());throw Error('getaddrinfo ENOTFOUND chatgpt.com');}});
 try{
  assert.equal(provider(await usage.refresh(),'codex').available,true);
  clock+=200000;respond=false;
  const codex=provider(await usage.refresh(true),'codex');
  assert.equal(codex.available,true);assert.match(codex.error,/连接 chatgpt\.com 失败/);
  assert.equal(codex.windows.find(w=>w.key==='session').usedPercent,25,'失败时保留上一次的数据');
  // 401 时不保留旧数据（登录真的失效了）。
  clock+=200000;
  const unauthorized=createUsage({home,now:()=>clock,env:{},fetchImpl:async()=>fakeFetch({}, {status:401})});
  try{assert.match(provider(await unauthorized.refresh(),'codex').reason,/登录已失效/);}
  finally{await unauthorized.stop();}
 }finally{await usage.stop();await cleanup(home);}
});

test('来源开关与手动 Key：关掉的不参与切换，手动 Key 优先于环境变量/本机登录并在保存前验证',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-auth-key',build:({message})=>message('m1',at(NOW,-60000),1.0)});
 await writeCodexAuth(home);
 const auths=[];
 const usage=createUsage({home,now:()=>NOW,env:{OPENCODE_API_KEY:'sk-env-key'},fetchImpl:async(url,options)=>{
  if(/chatgpt\.com/.test(String(url)))return fakeFetch(codexBody());
  const auth=options.headers.authorization;auths.push(auth);
  if(auth==='Bearer sk-bad')return fakeFetch({}, {status:401});
  return fakeFetch(opencodeBody());
 }});
 try{
  let s=await usage.refresh();
  // 有环境变量时用它，而不是 auth.json 里的本机登录。
  assert.equal(auths.at(-1),'Bearer sk-env-key');
  assert.equal(provider(s,'opencode-go').keySource,'env');
  // 手动 Key：保存前验证；保存后优先于环境变量，并把尾号回给界面（不回显完整 Key）。
  const bad=await usage.setKey('opencode-go','sk-bad');
  assert.equal(bad.ok,false);assert.match(bad.message,/登录|401|拒绝/);
  const good=await usage.setKey('opencode-go','sk-manual-abcd');
  assert.equal(good.ok,true);assert.match(good.message,/已保存并验证/);
  assert.equal(auths.at(-1),'Bearer sk-manual-abcd');
  let local=provider(good.snapshot,'opencode-go');
  assert.equal(local.keySource,'manual');assert.equal(local.keyHint,'abcd');
  const saved=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.equal(saved.keys['opencode-go'],'sk-manual-abcd');
  assert.equal((await fs.stat(path.join(home,'.bobo/usage.json'))).mode&0o777,0o600,'Key 文件必须只有当前用户可读写');
  // 开关：关掉当前显示的那家时，顺序里下一家可用的自动顶上来；点击切换也只在开启的来源里走。
  s=usage.selectProvider('codex');assert.equal(s.selected,'codex');
  s=usage.setEnabled('codex',false);
  assert.equal(provider(s,'codex').enabled,false);assert.equal(s.selected,'opencode-go','关掉当前来源后自动换一家');
  assert.equal(usage.cycleProvider().selected,'opencode-go','只剩一家开启时不循环');
  s=usage.setEnabled('codex',true);
  assert.equal(s.selected,'codex','重新开启后顺序里第一家可用的又显示出来');
  assert.equal(usage.cycleProvider().selected,'opencode-go','点击切换轮到顺序里的下一家');
  // 清除手动 Key 后回退到环境变量。
  s=await usage.clearKey('opencode-go');
  local=provider(s,'opencode-go');
  assert.equal(local.keySource,'env');
  const cleared=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.ok(!cleared.keys?.['opencode-go'],'清除后不应还留着手动 Key');
 }finally{await usage.stop();await cleanup(home);}
});

test('数据没变不重复推送，用量变化后推送一次',async()=>{
 const {home,file}=await makeHomeWithDb({build:({message})=>message('m1',at(NOW,-60000),1.0)});
 let body=codexBody();await writeCodexAuth(home);
 let clock=NOW;
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:async url=>{if(!/chatgpt\.com/.test(String(url)))throw Error('不该联网：'+url);return fakeFetch(body);}});
 let hits=0;usage.subscribe(()=>hits++);
 try{
  assert.equal(provider(await usage.refresh(),'opencode-go').windows.find(w=>w.key==='session').usedUSD,1);
  assert.equal(hits,1,'首次读到数据应推送一次');
  await usage.refresh();
  assert.equal(hits,1,'数据没变不应重复推送');
  const db=new DatabaseSync(file);
  db.prepare('INSERT INTO message(id,time_created,data) VALUES(?,?,?)').run('m2',at(NOW,-30000),JSON.stringify({providerID:'opencode-go',role:'assistant',cost:2,modelID:'m',time:{created:at(NOW,-30000)}}));
  db.close();
  clock+=120000;
  assert.equal(provider(await usage.refresh(),'opencode-go').windows.find(w=>w.key==='session').usedUSD,3);
  assert.equal(hits,2,'用量变化应推送');
  // Codex 的窗口变化同样会推送（用不同的 used_percent）。
  body=codexBody({primary:{used_percent:60,limit_window_seconds:18000,reset_after_seconds:3600,reset_at:Math.floor(NOW/1000)+3600}});
  clock+=200000;
  assert.equal(provider(await usage.refresh(true),'codex').windows.find(w=>w.key==='session').usedPercent,60);
  assert.equal(hits,3,'Codex 用量变化应推送');
 }finally{await usage.stop();await cleanup(home);}
});

test('额度重置提醒：Codex 窗口回到 100% 时提醒一次，关掉开关不再提醒',async()=>{
 const home=await makeHome();await writeCodexAuth(home);
 let clock=NOW,primaryUsed=40;
 const notes=[];
 const usage=createUsage({home,now:()=>clock,env:{},notify:(kind,title,message)=>notes.push({kind,title,message}),fetchImpl:async url=>{
  if(!/chatgpt\.com/.test(String(url)))throw Error('不该联网：'+url);
  return fakeFetch(codexBody({primary:{used_percent:primaryUsed,limit_window_seconds:18000,reset_after_seconds:3600,reset_at:Math.floor(clock/1000)+3600}}));
 }});
 const savedNotify=async want=>waitFor(async()=>{const raw=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));if(raw.notifyReset!==want)throw Error('设置还没写到 '+want);return raw;});
 try{
  await usage.refresh();
  assert.equal(notes.length,0,'首次读到数据（没有上一次）不提醒');
  primaryUsed=100;clock+=200000;
  await usage.refresh(true);
  assert.equal(notes.length,0,'用满（剩 0%）本身不提醒');
  primaryUsed=0;clock+=200000;
  await usage.refresh(true);
  assert.equal(notes.length,1,'窗口回到 100% 提醒一次');
  assert.equal(notes[0].kind,'reset');
  assert.match(notes[0].title,/Codex 额度已重置/);
  assert.match(notes[0].message,/5 小时滚动/);
  clock+=200000;
  await usage.refresh(true);
  assert.equal(notes.length,1,'连续两次 100% 不重复提醒');
  // 开关：关掉后不再提醒（refresh 会重读设置文件，所以等它落盘）。
  usage.setNotifyReset(false);
  await savedNotify(false);
  primaryUsed=50;clock+=200000;
  await usage.refresh(true);
  primaryUsed=0;clock+=200000;
  await usage.refresh(true);
  assert.equal(notes.length,1,'关掉开关后不提醒');
  usage.setNotifyReset(true);
  await savedNotify(true);
  primaryUsed=60;clock+=200000;
  await usage.refresh(true);
  primaryUsed=0;clock+=200000;
  await usage.refresh(true);
  assert.equal(notes.length,2,'重新打开后恢复提醒');
 }finally{await usage.stop();await cleanup(home);}
});

test('读取失败后退避：接口降级的自动重试变慢，手动刷新仍可重试，成功后回到正常节奏',async()=>{
 const {home}=await makeHomeWithDb({authKey:'sk-auth-key',build:({message})=>message('m1',at(NOW,-60000),1.0)});
 let clock=NOW,calls=0,respond=false;
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:async url=>{
  if(!/opencode\.ai/.test(String(url)))throw Error('不该联网：'+url);
  calls++;
  if(!respond)throw Error('getaddrinfo ENOTFOUND opencode.ai');
  return fakeFetch(opencodeBody());
 }});
 try{
  // 第一次：接口失败 → 降级到本机估算（本机记录还在）。
  const s=await usage.refresh();
  assert.equal(provider(s,'opencode-go').source,'local');
  assert.equal(calls,1);
  // 60 秒硬下限内：手动刷新也被拦。
  clock+=30e3;
  await usage.refresh(true);
  assert.equal(calls,1,'硬下限内不重复请求');
  // 退避期内（第一次失败后自动节奏 2 分钟）：自动刷新不试接口，手动刷新允许。
  clock+=40e3;
  await usage.refresh();
  assert.equal(calls,1,'退避期内自动刷新不请求');
  await usage.refresh(true);
  assert.equal(calls,2,'手动刷新可以再试');
  // 接口恢复：回到 3 分钟的正常节奏，退避清零。
  respond=true;
  clock+=70e3;
  const ok=await usage.refresh(true);
  assert.equal(provider(ok,'opencode-go').source,'api');
  assert.equal(calls,3);
  clock+=70e3;
  await usage.refresh();
  assert.equal(calls,3,'恢复后仍按 3 分钟节奏，不因为退避清零而立刻重读');
  clock+=120e3;
  await usage.refresh();
  assert.equal(calls,4,'到点后自动刷新一次');
 }finally{await usage.stop();await cleanup(home);}
});

test('Antigravity：配额窗口解析与 Language Server 读取',async()=>{
 const mockBody={
  response:{
   groups:[
    {
     displayName:'Gemini Models',
     buckets:[
      {bucketId:'gemini-5h',displayName:'Five Hour Limit Remaining',window:'5h',remainingFraction:0.8,resetTime:'2026-09-21T18:00:00Z'},
      {bucketId:'gemini-weekly',displayName:'Weekly Limit Remaining',window:'weekly',remainingFraction:0.95,resetTime:'2026-09-28T12:00:00Z'}
     ]
    },
    {
     displayName:'Claude and GPT models',
     buckets:[
      {bucketId:'3p-5h',displayName:'Five Hour Limit Remaining',window:'5h',remainingFraction:1.0,resetTime:'2026-09-21T18:00:00Z'}
     ]
    }
   ]
  }
 };
 const nowMs=Date.parse('2026-09-21T13:00:00Z');
 const snap=agySnapshot(mockBody,nowMs);
 assert.equal(snap.id,'agy');
 assert.equal(snap.available,true);
 assert.equal(snap.windows.length,3);
 const s5h=snap.windows.find(w=>w.key==='session');
 assert.ok(s5h);
 assert.equal(s5h.usedPercent,20);
 assert.equal(s5h.remainingPercent,80);
 assert.equal(s5h.resetInSec,5*3600);
 // status 只做「已限额」标记：没用完是 ok，用完才是 rate-limited（agy 的整句 description 不进来）。
 assert.equal(s5h.status,'ok');
 const exhausted=agySnapshot({groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-5h',window:'5h',remainingFraction:0,resetTime:'2026-09-21T18:00:00Z',description:'You have hit your 5-hour limit.'}]}]},nowMs);
 assert.equal(exhausted.windows[0].status,'rate-limited');

 // 完整 createUsage 流程（本地 Language Server 模拟）
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-agy-usage-'));
 const fetchImpl=async(url,options)=>{
  assert.match(url,/RetrieveUserQuotaSummary/);
  assert.equal(options.headers['x-codeium-csrf-token'],'mock-csrf-token');
  return {ok:true,status:200,json:async()=>mockBody};
 };

 const usage=createUsage({
  home,
  now:()=>nowMs,
  fetchImpl,
  env:{ANTIGRAVITY_LS_ADDRESS:'localhost:63111',ANTIGRAVITY_CSRF_TOKEN:'mock-csrf-token'}
 });

 try{
  const s=await usage.refresh(true);
  const agy=s.providers.find(p=>p.id==='agy');
  assert.ok(agy);
  assert.equal(agy.available,true);
  assert.equal(agy.windows.length,3);
  assert.equal(agy.keySource,'local-server');
 }finally{
  await usage.stop();
  await fs.rm(home,{recursive:true,force:true});
 }
});

test('Antigravity：未检测到 CLI 时精准提示，CLI 命令输出及未登录错误处理',async()=>{
 const nowMs=Date.parse('2026-09-21T13:00:00Z');
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-agy-cli-'));
 try{
  // 1. 未检测到 CLI
  const usageNoCli=createUsage({home,now:()=>nowMs,env:{}});
  try{
   const s=await usageNoCli.refresh(true);
   const agy=s.providers.find(p=>p.id==='agy');
   assert.equal(agy.available,false);
   assert.equal(agy.reason,'未检测到 agy CLI');
  }finally{
   await usageNoCli.stop();
  }

  // 2. 模拟 CLI 成功返回 JSON
  const cliOutput={
   status:'SUCCESS',
   command:{
    name:'usage',
    data:{
     groups:[
      {
       name:'Gemini Models',
       buckets:[
        {id:'gemini-5h',name:'Five Hour Limit Remaining',window:'5h',remaining_fraction:0.1,reset_time:'2026-09-21T17:00:00Z'},
        {id:'gemini-weekly',name:'Weekly Limit Remaining',window:'weekly',remaining_fraction:0.85,reset_time:'2026-09-28T12:00:00Z'}
       ]
      },
      {
       name:'Claude and GPT models',
       buckets:[
        {id:'3p-5h',name:'Five Hour Limit Remaining',window:'5h',remaining_fraction:1.0,reset_time:'2026-09-21T18:00:00Z'},
        {id:'3p-weekly',name:'Weekly Limit Remaining',window:'weekly',remaining_fraction:1.0,reset_time:'2026-09-28T13:00:00Z'}
       ]
      }
     ]
    }
   }
  };

  const fakeBin=path.join(home,'.local/bin/agy');
  await fs.mkdir(path.dirname(fakeBin),{recursive:true});
  await fs.writeFile(fakeBin,'#!/bin/sh\n',{mode:0o755});

  let execCalled=false;
  const mockExecFile=(file,args,options,cb)=>{
   execCalled=true;
   assert.deepEqual(args,['-p','/usage','--output-format','json','--print-timeout','20s']);
   cb(null,JSON.stringify(cliOutput),'');
  };

  const usageWithCli=createUsage({home,now:()=>nowMs,env:{},execFileImpl:mockExecFile});
  try{
   const s=await usageWithCli.refresh(true);
   assert.ok(execCalled);
   const agy=s.providers.find(p=>p.id==='agy');
   assert.equal(agy.available,true);
   assert.equal(agy.keySource,'cli');
   assert.equal(agy.windows.length,4);
   assert.equal(agy.windows[0].key,'session');
   assert.equal(agy.windows[0].label,'Gemini 5 小时额度');
   assert.equal(agy.windows[0].usedPercent,90);
   assert.equal(agy.windows[1].key,'week');
   assert.equal(agy.windows[1].label,'Gemini 周额度');
   assert.equal(agy.windows[2].key,'claude-session');
   assert.equal(agy.windows[2].label,'Claude / GPT 5 小时额度');
   assert.equal(agy.windows[3].key,'claude-week');
   assert.equal(agy.windows[3].label,'Claude / GPT 周额度');
  }finally{
   await usageWithCli.stop();
  }

  // 3. 模拟未登录
  const mockExecLoginRequired=(file,args,options,cb)=>{
   const err=new Error('Command failed');
   err.code=1;
   cb(err,'Please select login method: not logged in','');
  };
  const usageLogin=createUsage({home,now:()=>nowMs,env:{},execFileImpl:mockExecLoginRequired});
  try{
   const s=await usageLogin.refresh(true);
   const agy=s.providers.find(p=>p.id==='agy');
   assert.equal(agy.available,false);
   assert.equal(agy.reason,'未登录 Antigravity，请在终端执行 agy 登录');
  }finally{
   await usageLogin.stop();
  }
 }finally{
  await fs.rm(home,{recursive:true,force:true});
 }
});

// ---- Claude Code ----
// 用量接口的形状：utilization 是「已用百分比」（0–100）、resets_at 是 ISO 时间、金额字段是分。
const claudeBody=({five={utilization:12,resets_at:new Date(NOW+3*3600e3).toISOString()},week={utilization:40,resets_at:new Date(NOW+4*86400e3).toISOString()},opus=null,sonnet=null,limits=null,extra=null}={})=>({five_hour:five,seven_day:week,seven_day_opus:opus,seven_day_sonnet:sonnet,...(limits?{limits}:{}),...(extra?{extra_usage:extra}:{})});
const claudeCred={accessToken:'sk-ant-oat01-test',refreshToken:'sk-ant-ort01-test',expiresAt:NOW+3600e3,scopes:['user:profile','user:inference'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x'};
async function writeClaudeCredentials(home,cred=claudeCred){
 const dir=path.join(home,'.claude');await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:cred}));
}
const claudeFetch=(calls,body=claudeBody())=>async(url,options)=>{
 calls.push({url:String(url),headers:options.headers});
 if(!/api\.anthropic\.com\/api\/oauth\/usage/.test(String(url)))throw Error('不该联网：'+url);
 if(/sk-ant-oat01-bad/.test(String(options.headers.authorization)))return fakeFetch({}, {status:401});
 return fakeFetch(body);
};

test('Claude Code：凭据与窗口解析（含按模型的周额度与额外用量）',()=>{
 assert.deepEqual(claudeCredentials({claudeAiOauth:claudeCred}),
  {accessToken:'sk-ant-oat01-test',scopes:['user:profile','user:inference'],subscriptionType:'max',rateLimitTier:'default_claude_max_20x',expiresAt:NOW+3600e3});
 assert.equal(claudeCredentials({claudeAiOauth:{refreshToken:'x'}}),null,'没有 accessToken 不算登录');
 // 老版本把 expiresAt 存成秒：读进来统一成毫秒。
 assert.equal(claudeCredentials({claudeAiOauth:{accessToken:'a',expiresAt:Math.floor(NOW/1000)}}).expiresAt,Math.floor(NOW/1000)*1000);
 // 钥匙串输出里带换行时 `security -w` 会给十六进制。
 const json=JSON.stringify({claudeAiOauth:claudeCred});
 assert.equal(keychainDecode(Buffer.from(json).toString('hex')),json);
 assert.equal(keychainDecode(json),json);
 assert.equal(keychainDecode('not json'),'not json');

 const snap=claudeSnapshot(claudeBody({
  sonnet:{utilization:8,resets_at:new Date(NOW+86400e3).toISOString()},
  limits:[{kind:'weekly_scoped',percent:75,resets_at:new Date(NOW+86400e3).toISOString(),scope:{model:{display_name:'Fable 5'}}},
          {kind:'weekly_all',percent:40,scope:{model:{display_name:'忽略'}}}],
  extra:{is_enabled:true,monthly_limit:2000,used_credits:1234,utilization:61.7}
 }),NOW);
 assert.equal(snap.id,'claude');assert.equal(snap.available,true);assert.equal(snap.source,'api');
 assert.deepEqual(snap.windows.map(w=>w.key),['session','week','sonnet','week-fable-5','extra']);
 assert.deepEqual(snap.windows.map(w=>w.label),['5 小时滚动','本周','本周 · Sonnet','本周 · Fable 5','额外用量（月度）']);
 const session=snap.windows[0];
 assert.equal(session.usedPercent,12);assert.equal(session.remainingPercent,88);assert.equal(session.resetInSec,3*3600);assert.equal(session.status,'ok');
 assert.equal(snap.windows[1].remainingPercent,60);
 const extra=snap.windows[4];
 assert.equal(extra.usedUSD,12.34);assert.equal(extra.limitUSD,20);assert.equal(extra.usedPercent,61.7);
 // 用满的窗口带「已限额」标记；没有 utilization 的窗口整条丢掉。
 const limited=claudeSnapshot({five_hour:{utilization:100,resets_at:new Date(NOW+600e3).toISOString()},seven_day:{resets_at:new Date(NOW+600e3).toISOString()},extra_usage:{is_enabled:false,monthly_limit:2000,used_credits:1}},NOW);
 assert.equal(limited.windows.length,1);assert.equal(limited.windows[0].remainingPercent,0);assert.equal(limited.windows[0].status,'rate-limited');
});

test('Claude Code：读凭据文件调用量接口（只读、不刷新），套餐与来源都回给界面',async()=>{
 const home=await makeHome();await writeClaudeCredentials(home);
 const calls=[];
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeFetch(calls)});
 try{
  const s=await usage.refresh(),claude=provider(s,'claude');
  assert.equal(calls.length,1);
  assert.equal(calls[0].headers.authorization,'Bearer sk-ant-oat01-test');
  assert.equal(calls[0].headers['anthropic-beta'],'oauth-2025-04-20');
  assert.match(calls[0].headers['user-agent'],/^claude-code\//);
  assert.equal(claude.available,true);assert.equal(claude.keySource,'file');assert.equal(claude.plan,'Max 20x');
  assert.equal(claude.windows.find(w=>w.key==='session').usedPercent,12);
  // 凭据文件保持原样：不刷新 token、不回写（含 refreshToken 等字段）。
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'.claude/.credentials.json'),'utf8')),{claudeAiOauth:claudeCred});
 }finally{await usage.stop();await cleanup(home);}
 // CLAUDE_CONFIG_DIR 指到哪儿就读哪儿；环境变量里的 Token 优先于文件。
 const moved=await makeHome();
 await writeClaudeCredentials(path.join(moved,'cfg'),{...claudeCred,accessToken:'sk-ant-oat01-file'});
 const envCalls=[];
 const envUsage=createUsage({home:moved,now:()=>NOW,env:{CLAUDE_CONFIG_DIR:path.join(moved,'cfg'),CLAUDE_CODE_OAUTH_TOKEN:'sk-ant-oat01-env'},fetchImpl:claudeFetch(envCalls)});
 try{
  const claude=provider(await envUsage.refresh(),'claude');
  assert.equal(claude.keySource,'env');assert.equal(envCalls[0].headers.authorization,'Bearer sk-ant-oat01-env');
 }finally{await envUsage.stop();await cleanup(moved);}
});

test('Claude Code：没有登录 / 登录过期 / 缺 user:profile / 401 / 429 都给可读原因，失败不覆盖上一次数据',async()=>{
 // 没有登录：不联网。
 const bare=await makeHome();
 let calls=0;
 const none=createUsage({home:bare,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(claudeBody());}});
 try{
  const claude=provider(await none.refresh(),'claude');
  assert.equal(claude.available,false);assert.match(claude.reason,/claude/);assert.equal(calls,0);
 }finally{await none.stop();await cleanup(bare);}
 // 登录过期：连请求都不该发（Token 刷新由 Claude Code 自己做）。
 const expired=await makeHome();await writeClaudeCredentials(expired,{...claudeCred,expiresAt:NOW-3600e3});
 const expiredUsage=createUsage({home:expired,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(claudeBody());}});
 try{assert.match(provider(await expiredUsage.refresh(),'claude').reason,/已过期/);assert.equal(calls,0);}
 finally{await expiredUsage.stop();await cleanup(expired);}
 // setup-token 生成的长效 Token 只有推理权限。
 const scoped=await makeHome();await writeClaudeCredentials(scoped,{...claudeCred,scopes:['user:inference']});
 const scopedUsage=createUsage({home:scoped,now:()=>NOW,env:{},fetchImpl:async()=>{calls++;return fakeFetch(claudeBody());}});
 try{assert.match(provider(await scopedUsage.refresh(),'claude').reason,/user:profile/);assert.equal(calls,0);}
 finally{await scopedUsage.stop();await cleanup(scoped);}
 // 401 / 429 / 网络失败：第一次成功，后面失败时保留上一次的窗口并带上 error。
 const home=await makeHome();await writeClaudeCredentials(home);
 let mode='ok',clock=NOW;
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:async url=>{
  if(!/api\.anthropic\.com/.test(String(url)))throw Error('不该联网：'+url);
  if(mode==='401')return fakeFetch({}, {status:401});
  if(mode==='429')return fakeFetch({}, {status:429});
  if(mode==='offline')throw Error('getaddrinfo ENOTFOUND api.anthropic.com');
  return fakeFetch(claudeBody());
 }});
 try{
  assert.equal(provider(await usage.refresh(),'claude').available,true);
  mode='401';clock+=200000;
  const rejected=provider(await usage.refresh(true),'claude');
  assert.match(rejected.error,/拒绝了当前登录/);
  assert.equal(rejected.windows.find(w=>w.key==='session').usedPercent,12,'401 时保留上一次的数据，等用户重新登录');
  // 新进程里没有上一次的数据：直接给原因（不保留旧窗口）。
  const fresh=createUsage({home,now:()=>NOW,env:{},fetchImpl:async url=>{
   if(!/api\.anthropic\.com/.test(String(url)))throw Error('不该联网：'+url);
   return fakeFetch({}, {status:401});
  }});
  try{assert.match(provider(await fresh.refresh(),'claude').reason,/拒绝了当前登录/);}
  finally{await fresh.stop();}
  mode='ok';clock+=200000;
  assert.equal(provider(await usage.refresh(true),'claude').available,true);
  mode='429';clock+=200000;
  const limited=provider(await usage.refresh(true),'claude');
  assert.equal(limited.available,true);assert.match(limited.error,/限制用量接口的频率/);
  assert.equal(limited.windows.find(w=>w.key==='session').usedPercent,12,'限流时保留上一次的数据');
  mode='offline';clock+=200000;
  const offline=provider(await usage.refresh(true),'claude');
  assert.match(offline.error,/连接 api\.anthropic\.com 失败/);
 }finally{await usage.stop();await cleanup(home);}
});

test('Claude Code：手动 Token 先验证再保存，优先于文件登录',async()=>{
 const home=await makeHome();await writeClaudeCredentials(home,{...claudeCred,accessToken:'sk-ant-oat01-file'});
 const calls=[];
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeFetch(calls)});
 try{
  assert.equal(provider(await usage.refresh(),'claude').keySource,'file');
  // 手动 Token：保存前验证；保存后优先于凭据文件，界面只拿到尾号。
  const bad=await usage.setKey('claude','sk-ant-oat01-bad');
  assert.equal(bad.ok,false);
  const good=await usage.setKey('claude','sk-ant-oat01-manual-abcd');
  assert.equal(good.ok,true);assert.match(good.message,/已保存并验证/);
  assert.equal(calls.at(-1).headers.authorization,'Bearer sk-ant-oat01-manual-abcd');
  assert.equal(calls.length,3,'验证用的那份直接进缓存，保存后不再多打一次网络');
  const manual=provider(good.snapshot,'claude');
  assert.equal(manual.keySource,'manual');assert.equal(manual.keyHint,'abcd');
  const saved=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.equal(saved.keys.claude,'sk-ant-oat01-manual-abcd');
  assert.equal((await fs.stat(path.join(home,'.bobo/usage.json'))).mode&0o777,0o600,'Token 文件必须只有当前用户可读写');
  // 清除后回到凭据文件。
  assert.equal(provider(await usage.clearKey('claude'),'claude').keySource,'file');
 }finally{await usage.stop();await cleanup(home);}
});

test('Claude Code：钥匙串要显式读取（点一次）才自动读，读不到时给可读原因',async()=>{
 const keychainJson=JSON.stringify({claudeAiOauth:{...claudeCred,accessToken:'sk-ant-oat01-keychain'}});
 const securityCalls=[];
 const security=(out,error=null)=>(file,args,options,cb)=>{securityCalls.push([file,...args]);cb(error,out,'');};
 // 没有点过「读取钥匙串」时一次都不碰钥匙串（背景里不该莫名弹授权框）。
 const home=await makeHome();
 const guarded=createUsage({home,now:()=>NOW,env:{USER:'tester'},fetchImpl:claudeFetch([]),execFileImpl:security(keychainJson)});
 try{
  const claude=provider(await guarded.refresh(),'claude');
  assert.equal(claude.available,false);assert.match(claude.reason,/未找到 Claude Code 的本机登录/);
  assert.equal(securityCalls.length,0);
 }finally{await guarded.stop();}
 // 显式读取：先按 $USER 找 `Claude Code-credentials`，验证通过后记住允许自动读；Token 只在内存里用，不写盘。
 const calls=[];
 const withKeychain=createUsage({home,now:()=>NOW,env:{USER:'tester'},fetchImpl:claudeFetch(calls),execFileImpl:security(Buffer.from(keychainJson).toString('hex'),null)});
 try{
  const r=await withKeychain.readKeychain('claude');
  assert.equal(r.ok,true);assert.match(r.message,/已读取钥匙串/);
  assert.deepEqual(securityCalls[0],['/usr/bin/security','find-generic-password','-s','Claude Code-credentials','-w','-a','tester']);
  assert.equal(calls.at(-1).headers.authorization,'Bearer sk-ant-oat01-keychain');
  assert.equal(calls.length,1,'验证用的那份直接进缓存，刷新不再多打一次网络');
  const json=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.equal(json.keychain,true,'读成功后记住允许');
  assert.equal(json.keys.claude,undefined,'钥匙串里的 Token 不写盘');
  assert.equal(provider(withKeychain.snapshot(),'claude').keySource,'keychain');
  // 读过之后新进程也自动读钥匙串，不用再点一次。
  const seen=[];
  const again=createUsage({home,now:()=>NOW,env:{USER:'tester'},fetchImpl:claudeFetch(calls),execFileImpl:(file,args,options,cb)=>{seen.push([file,...args]);cb(null,keychainJson,'');}});
  try{
   const claude=provider(await again.refresh(),'claude');
   assert.equal(claude.keySource,'keychain');assert.equal(claude.available,true);
   assert.equal(seen.length,1,'自动读一次');
   assert.equal(provider(await again.clearKey('claude'),'claude').keySource,'keychain','清除手动 Token 不影响钥匙串登录');
  }finally{await again.stop();}
 }finally{await withKeychain.stop();await cleanup(home);}
 // 钥匙串读不到（没授权 / 没有条目）：报可读原因，不写「允许自动读」。
 const denied=await makeHome();
 const deniedCalls=[];
 const deniedUsage=createUsage({home:denied,now:()=>NOW,env:{USER:'tester'},fetchImpl:claudeFetch([]),execFileImpl:(file,args,options,cb)=>{deniedCalls.push([file,...args]);cb(Object.assign(Error('security 退出码 44'),{code:44}),'','');}});
 try{
  const r=await deniedUsage.readKeychain('claude');
  assert.equal(r.ok,false);assert.match(r.message,/钥匙串里没有可用的 Claude Code 登录/);
  const claude=provider(await deniedUsage.refresh(),'claude');
  assert.equal(claude.available,false);assert.match(claude.reason,/未找到 Claude Code 的本机登录/);
  assert.equal(deniedCalls.filter(a=>a.includes('Claude Code-credentials')).length,2,'读不到就不再自动试（等用户再点）：只有刚点的那次按 $USER 与无账号各试一遍');
 }finally{await deniedUsage.stop();await cleanup(denied);}
});

test('Claude Code：手动 Token 会清掉引号与 Bearer 前缀',async()=>{
 const home=await makeHome();
 const calls=[];
 const usage=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeFetch(calls)});
 try{
  const r=await usage.setKey('claude','  "Bearer sk-ant-oat01-manual" ');
  assert.equal(r.ok,true);
  assert.equal(calls.at(-1).headers.authorization,'Bearer sk-ant-oat01-manual');
  const saved=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.equal(saved.keys.claude,'sk-ant-oat01-manual');
 }finally{await usage.stop();await cleanup(home);}
});

// ---- Claude Code 的网络闸门（VPN / 直连） ----
const claudeGateFetch=(calls,{probeOk=true}={})=>async(url,options)=>{
 if(!/api\.anthropic\.com/.test(String(url)))throw Error('不该联网：'+url);
 const auth=options.headers.authorization;
 calls.push(auth?'usage':'probe');
 if(!auth)return probeOk?fakeFetch({}, {status:401}):Promise.reject(Error('连接 api.anthropic.com 失败'));
 return fakeFetch(claudeBody());
};

test('Claude Code：隧道接口判定（utun / tun / ipsec / ppp 算 VPN，物理网卡算直连）',()=>{
 for(const name of ['utun0','utun4','tun0','tap1','ipsec0','ppp0','wg0','gpd0'])assert.equal(tunnelInterface(name),true,name);
 for(const name of ['en0','en5','eth0','bridge100','lo0','awdl0',''])assert.equal(tunnelInterface(name),false,name||'（空）');
});

test('Claude Code：直连时整个跳过（不带登录请求），确认后才发；隧道下先做不带登录的探测',async()=>{
 const home=await makeHome();await writeClaudeCredentials(home);
 // 直连：一次请求都不发，明确告诉界面「需要二次确认」。
 const directCalls=[];
 const direct=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeGateFetch(directCalls),claudeNetwork:async()=>'direct'});
 try{
  const claude=provider(await direct.refresh(),'claude');
  assert.equal(claude.available,false);assert.equal(claude.needsDirectConfirm,true);
  assert.match(claude.reason,/直连/);
  assert.deepEqual(directCalls,[],'直连时不应携带登录发起任何请求');
  // 用户在界面上确认之后（?direct=1）：不再探测，直接带登录请求一次。
  const confirmed=provider(await direct.refresh(true,{claudeDirect:true}),'claude');
  assert.equal(confirmed.available,true);assert.equal(confirmed.needsDirectConfirm,false);
  assert.deepEqual(directCalls,['usage']);
 }finally{await direct.stop();}
 // 隧道：先探测（不带 Authorization），通了才带登录请求；探测结果记一小会儿，连着刷新不重复探测。
 const calls=[];
 let clock=NOW;
 const tunnel=createUsage({home,now:()=>clock,env:{},fetchImpl:claudeGateFetch(calls),claudeNetwork:async()=>'tunnel'});
 try{
  const claude=provider(await tunnel.refresh(),'claude');
  assert.equal(claude.available,true);assert.equal(claude.needsDirectConfirm,false);
  assert.deepEqual(calls,['probe','usage']);
  clock+=200000;
  await tunnel.refresh(true);
  assert.deepEqual(calls,['probe','usage','usage'],'探测结果还在有效期内就不重复探测');
 }finally{await tunnel.stop();}
 // 隧道通了才算数：探测失败就不发登录请求。
 const failCalls=[];
 const tunnelFail=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeGateFetch(failCalls,{probeOk:false}),claudeNetwork:async()=>'tunnel'});
 try{
  const claude=provider(await tunnelFail.refresh(),'claude');
  assert.equal(claude.available,false);assert.match(claude.reason,/claude 站点连不通/);
  assert.deepEqual(failCalls,['probe']);
 }finally{await tunnelFail.stop();}
 // 判定不出（非 macOS / Linux，或本机命令不可用）时不拦：照旧直接请求。
 const unknownCalls=[];
 const unknown=createUsage({home,now:()=>NOW,env:{},fetchImpl:claudeGateFetch(unknownCalls),claudeNetwork:async()=>'unknown'});
 try{
  assert.equal(provider(await unknown.refresh(),'claude').available,true);
  assert.deepEqual(unknownCalls,['usage']);
 }finally{await unknown.stop();}
 await cleanup(home);
});

test('Claude Code：直连时保留上一次的窗口并标出原因，打开「直连时也请求」后自动恢复',async()=>{
 const home=await makeHome();await writeClaudeCredentials(home);
 let route='tunnel',clock=NOW;
 const calls=[];
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:claudeGateFetch(calls),claudeNetwork:async()=>route});
 try{
  const first=provider(await usage.refresh(),'claude');
  assert.equal(first.available,true);assert.equal(first.windows.find(w=>w.key==='session').usedPercent,12);
  route='direct';clock+=200000;
  const skipped=provider(await usage.refresh(true),'claude');
  assert.equal(skipped.available,true);assert.equal(skipped.needsDirectConfirm,true);
  assert.match(skipped.error,/直连/);
  assert.equal(skipped.windows.find(w=>w.key==='session').usedPercent,12,'直连跳过时保留上一次的数据');
  // 打开开关（写进 usage.json）：自动刷新不再拦，也不再问确认。
  usage.setClaudeDirect(true);
  assert.equal(usage.snapshot().claudeDirect,true);
  const saved=await waitFor(async()=>{const r=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));if(r.claudeDirect!==true)throw Error('开关还没写盘');return r;});
  assert.equal(saved.claudeDirect,true);
  clock+=200000;
  const resumed=provider(await usage.refresh(true),'claude');
  assert.equal(resumed.available,true);assert.equal(resumed.needsDirectConfirm,false);
  // 手动 Token 的保存也走同一道闸门：直连时先回 needsDirectConfirm，确认后才验证。
  usage.setClaudeDirect(false);
  clock+=200000;
  const blocked=await usage.setKey('claude','sk-ant-oat01-manual-abcd');
  assert.equal(blocked.ok,false);assert.equal(blocked.needsDirectConfirm,true);
  const ok=await usage.setKey('claude','sk-ant-oat01-manual-abcd',{direct:true});
  assert.equal(ok.ok,true);assert.equal(provider(ok.snapshot,'claude').keySource,'manual');
 }finally{await usage.stop();await cleanup(home);}
});
