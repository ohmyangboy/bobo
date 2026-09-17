import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createUsage} from './usage.mjs';
// 每日历史按本地日历分桶，测试固定 UTC，让「天」的断言在任何时区都稳定。
process.env.TZ='UTC';
// 与 CodexBar 的 OpenCodeGoLocalUsageReader 测试同一基准：2026-03-06T12:00:00Z。
const NOW=1772798400000;
const openCodeDir=home=>path.join(home,'.local/share/opencode');
const makeHome=()=>fs.mkdtemp(path.join(os.tmpdir(),'bobo-usage-'));
const cleanup=home=>fs.rm(home,{recursive:true,force:true});
const at=(base,deltaMs)=>base+deltaMs;
const provider=(snapshot,id)=>snapshot.providers.find(p=>p.id===id);
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
  // 写盘是异步的：等到文件里就是当前选择（而不是更早那一次），避免和下一次切换赛跑。
  const readSettings=async()=>JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  const waitProvider=want=>waitFor(async()=>{const r=await readSettings();if(r.provider!==want)throw Error('设置还没写到 '+want);return r;});
  const saved=await waitProvider('codex');
  assert.equal(saved.provider,'codex');
  // 新进程读同一份设置：选中的 provider 会被记住。
  usage.selectProvider('opencode-go');
  await waitProvider('opencode-go');
  const again=createUsage({home,now:()=>NOW,env:{},fetchImpl:async()=>fakeFetch(codexBody())});
  try{assert.equal((await again.refresh()).selected,'opencode-go');}
  finally{await again.stop();}
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
  const bad=await usage.setKey('sk-bad');
  assert.equal(bad.ok,false);assert.match(bad.message,/登录|401|拒绝/);
  const good=await usage.setKey('sk-manual-abcd');
  assert.equal(good.ok,true);assert.match(good.message,/已保存并验证/);
  assert.equal(auths.at(-1),'Bearer sk-manual-abcd');
  let local=provider(good.snapshot,'opencode-go');
  assert.equal(local.keySource,'manual');assert.equal(local.keyHint,'abcd');
  const saved=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
  assert.equal(saved.keys['opencode-go'],'sk-manual-abcd');
  assert.equal((await fs.stat(path.join(home,'.bobo/usage.json'))).mode&0o777,0o600,'Key 文件必须只有当前用户可读写');
  // 开关：关掉当前显示的那家时会自动换到另一家，循环也只在开启的来源里走。
  s=usage.selectProvider('codex');assert.equal(s.selected,'codex');
  s=usage.setEnabled('codex',false);
  assert.equal(provider(s,'codex').enabled,false);assert.equal(s.selected,'opencode-go','关掉当前来源后自动换一家');
  assert.equal(usage.cycleProvider().selected,'opencode-go','只剩一家开启时不循环');
  s=usage.setEnabled('codex',true);
  assert.equal(usage.cycleProvider().selected,'codex','重新开启后可以切回去');
  // 清除手动 Key 后回退到环境变量。
  s=await usage.clearKey();
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
