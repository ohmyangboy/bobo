import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUsage,deepseekSnapshot} from '../src/usage.mjs';
const NOW=Date.parse('2026-10-21T12:00:00Z');
const body=(total='110.000000000000000001')=>({is_available:true,balance_infos:[{currency:'CNY',total_balance:total,granted_balance:'10.000000000000000001',topped_up_balance:'100.00'},{currency:'USD',total_balance:'0.125',granted_balance:'0.100',topped_up_balance:'0.025'}]});
const response=(value,status=200)=>({status,ok:status>=200&&status<300,json:async()=>value});
const row=s=>s.providers.find(p=>p.id==='deepseek');
async function fixture(t,settings={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-deepseek-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
 await fs.writeFile(path.join(home,'.bobo/usage.json'),JSON.stringify({enabled:{codex:false,claude:false,'opencode-go':false,agy:false},...settings}));
 return home;
}
test('DeepSeek：金额保持十进制字符串，币种分离，余额不足仍是有效读数',()=>{
 const snap=deepseekSnapshot({...body(),is_available:false},NOW);
 assert.equal(snap.available,true);assert.equal(snap.isAvailable,false);assert.equal(snap.lastSuccessfulAt,NOW);assert.equal(snap.stale,false);assert.deepEqual(snap.windows,[]);
 assert.deepEqual(snap.balances,[{currency:'CNY',total:'110.000000000000000001',granted:'10.000000000000000001',toppedUp:'100.00'},{currency:'USD',total:'0.125',granted:'0.100',toppedUp:'0.025'}]);
 assert.equal(snap.balances[0].total,body().balance_infos[0].total_balance);
 for(const value of [null,{}, {...body(),is_available:'true'},{...body(),balance_infos:[]},{...body(),balance_infos:[{...body().balance_infos[0],total_balance:110}]},{...body(),balance_infos:[{...body().balance_infos[0],total_balance:'1e2'}]},{...body(),balance_infos:[{...body().balance_infos[0],currency:'EUR'}]},{...body(),balance_infos:[body().balance_infos[0],body().balance_infos[0]]}])assert.throws(()=>deepseekSnapshot(value,NOW),/DeepSeek/);
});
test('密钥白名单：未知来源、Codex、Antigravity 在读取设置和网络前拒绝',async t=>{
 const home=await fixture(t);let calls=0;
 const usage=createUsage({home,env:{},fetchImpl:async()=>{calls++;throw Error('不应联网');}});t.after(()=>usage.stop());
 for(const id of ['unknown','codex','agy','constructor','__proto__',null,{},123]){
  assert.equal((await usage.setKey(id,'private-fixture')).ok,false);
  await assert.rejects(usage.clearKey(id),/不支持/);
 }
 assert.equal(calls,0);
 assert.equal(JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8')).keys,undefined);
});
test('DeepSeek：读取 zsh 配置里的 DEEPSEEK_API_KEY，忽略 OPENAI_API_KEY，不复制落盘',async t=>{
 const home=await fixture(t);let calls=[];
 await fs.writeFile(path.join(home,'.zshrc'),'#export DEEPSEEK_API_KEY=commented-out\nexport OPENAI_API_KEY=not-this-one\nexport DEEPSEEK_API_KEY="private-zsh-key" # DeepSeek 官方 Key\n');
 const usage=createUsage({home,env:{},now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return response(body());}});t.after(()=>usage.stop());
 const snap=row(await usage.refresh());
 assert.equal(snap.keySource,'zsh');assert.equal(snap.keyHint,'DEEPSEEK_API_KEY');assert.equal(snap.available,true);
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers.authorization,'Bearer private-zsh-key');
 assert.doesNotMatch(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'),/private-zsh-key/);
});
test('DeepSeek：环境变量 DEEPSEEK_API_KEY 优先于 zsh 配置，手动 Key 优先于两者；OPENAI_API_KEY 不参与',async t=>{
 const home=await fixture(t);let calls=[];
 await fs.writeFile(path.join(home,'.zshrc'),'export DEEPSEEK_API_KEY=zsh-key\n');
 const usage=createUsage({home,env:{DEEPSEEK_API_KEY:'env-key',OPENAI_API_KEY:'env-openai-key'},now:()=>NOW,fetchImpl:async(url,options)=>{calls.push(options.headers.authorization);return response(body());}});t.after(()=>usage.stop());
 const fromEnv=row(await usage.refresh());assert.equal(fromEnv.keySource,'env');assert.equal(fromEnv.keyHint,'DEEPSEEK_API_KEY');assert.equal(calls[0],'Bearer env-key');
 const saved=await usage.setKey('deepseek','manual-key');assert.equal(saved.ok,true);assert.equal(row(saved.snapshot).keySource,'manual');assert.equal(calls.at(-1),'Bearer manual-key');
});
test('DeepSeek：只有 OPENAI_API_KEY 时不读取它',async t=>{
 const home=await fixture(t);let calls=0;
 await fs.writeFile(path.join(home,'.zshrc'),'export OPENAI_API_KEY=not-deepseek\n');
 const usage=createUsage({home,env:{OPENAI_API_KEY:'not-deepseek'},fetchImpl:async()=>{calls++;throw Error('不应联网');}});t.after(()=>usage.stop());
 const snap=row(await usage.refresh());assert.equal(snap.available,false);assert.match(snap.reason,/DEEPSEEK_API_KEY/);assert.equal(calls,0);
});
test('DeepSeek：完全没有 Key 时提示配置 zsh，不联网也不读 AI 设置',async t=>{
 const home=await fixture(t);let calls=0;
 await fs.writeFile(path.join(home,'.bobo/ai.json'),JSON.stringify({baseUrl:'https://gateway.example.invalid',apiKey:'private-existing-key'}));
 const usage=createUsage({home,env:{},fetchImpl:async()=>{calls++;throw Error('不应联网');}});t.after(()=>usage.stop());
 const snap=row(await usage.refresh());assert.equal(snap.available,false);assert.equal(snap.isAvailable,null);assert.equal(snap.lastSuccessfulAt,null);assert.deepEqual(snap.balances,[]);assert.match(snap.reason,/DEEPSEEK_API_KEY/);assert.equal(calls,0);
 assert.doesNotMatch(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'),/private-existing-key/);
});
test('DeepSeek：显式 Key 只去官方固定目标，禁止重定向，验证缓存不重复请求，清除无回退',async t=>{
 const home=await fixture(t);let calls=[];
 const usage=createUsage({home,env:{},now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return response(body());}});t.after(()=>usage.stop());
 const saved=await usage.setKey('deepseek','private-official-fixture');
 assert.equal(saved.ok,true);assert.match(saved.message,/官方余额/);assert.equal(calls.length,1,'验证成功后的刷新沿用同一份读数');
 assert.equal(calls[0].url,'https://api.deepseek.com/user/balance');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.authorization,'Bearer private-official-fixture');assert.ok(calls[0].options.signal);
 const snap=row(saved.snapshot);assert.equal(snap.keySource,'manual');assert.equal(snap.keyHint,'');assert.equal(snap.lastSuccessfulAt,NOW);assert.doesNotMatch(JSON.stringify(saved),/private-official-fixture/);
 const file=path.join(home,'.bobo/usage.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).keys.deepseek,'private-official-fixture');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).keyTargets.deepseek,'https://api.deepseek.com/user/balance');
 assert.equal(row(await usage.clearKey('deepseek')).available,false);assert.equal(calls.length,1);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).keys.deepseek,undefined);
});
test('DeepSeek：网络错误不泄露凭据或落盘，未跟随重定向',async t=>{
 const home=await fixture(t);let calls=0;
 const usage=createUsage({home,env:{},now:()=>NOW,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(options.redirect,'error');throw Error('redirected private-fixture');}});t.after(()=>usage.stop());
 const result=await usage.setKey('deepseek','private-fixture');assert.equal(result.ok,false);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(result),/private-fixture/);assert.match(result.message,/无法连接/);
 assert.equal(JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8')).keys,undefined);
});
test('DeepSeek：401、429、5xx 保留上次余额并标过期，3 分钟缓存和至少 60 秒硬下限',async t=>{
 const home=await fixture(t,{keys:{deepseek:'private-official-fixture'},keyTargets:{deepseek:'https://api.deepseek.com/user/balance'}});let clock=NOW,status=200,calls=0,hits=0;
 const usage=createUsage({home,env:{},now:()=>clock,fetchImpl:async()=>{calls++;return response(body(),status);}});t.after(()=>usage.stop());usage.subscribe(()=>hits++);
 const first=row(await usage.refresh());assert.equal(calls,1);assert.equal(first.stale,false);assert.equal(hits,1);
 clock+=30000;await usage.refresh(true);assert.equal(calls,1);
 clock+=40000;await usage.refresh();assert.equal(calls,1,'自动刷新使用三分钟缓存');
 for(const code of [401,429,503]){
  clock+=180000;status=code;const failed=row(await usage.refresh(true));
  assert.deepEqual(failed.balances,first.balances);assert.equal(failed.available,true);assert.equal(failed.isAvailable,true);assert.equal(failed.lastSuccessfulAt,NOW);assert.equal(failed.stale,true);assert.match(failed.error,/DeepSeek/);
  const before=calls;clock+=30000;await usage.refresh(true);assert.equal(calls,before,'失败时手动刷新也遵守硬下限');
 }
 status=200;clock+=70000;const recovered=row(await usage.refresh(true));assert.equal(recovered.stale,false);assert.equal(recovered.error,null);assert.equal(recovered.lastSuccessfulAt,clock);assert.ok(hits>=5,'金额状态和过期变化通知订阅者');
});
test('DeepSeek：失败退避按 2/4/8/10 分钟，成功后恢复三分钟；币种、可用状态和成功时间参与推送',async t=>{
 const home=await fixture(t,{keys:{deepseek:'private-official-fixture'},keyTargets:{deepseek:'https://api.deepseek.com/user/balance'}});let clock=NOW,calls=0,status=503,value=body(),hits=0;
 const usage=createUsage({home,env:{},now:()=>clock,fetchImpl:async()=>{calls++;return response(value,status);}});t.after(()=>usage.stop());usage.subscribe(()=>hits++);
 await usage.refresh();assert.equal(calls,1);
 for(const delay of [120000,240000,480000,600000]){
  clock+=delay-1;await usage.refresh();const before=calls;clock++;await usage.refresh();assert.equal(calls,before+1);
 }
 status=200;clock+=600000;await usage.refresh();const baseline=hits;
 clock+=179999;await usage.refresh();const before=calls;clock++;await usage.refresh();assert.equal(calls,before+1);assert.equal(hits,baseline+1,'lastSuccessfulAt 变化也会推送');
 value={...body('109.999999999999999999'),is_available:false};clock+=60000;const changed=row(await usage.refresh(true));assert.equal(changed.balances[0].total,'109.999999999999999999');assert.equal(changed.isAvailable,false);assert.equal(hits,baseline+2);
});

test('DeepSeek：旧任意 id 漏洞留下的未绑定 Key 不会发送到官方目标',async t=>{
 for(const keyTargets of [undefined,{deepseek:'https://opencode.ai/zen/go/v1/usage'},{deepseek:'https://api.deepseek.com.evil.invalid/user/balance'}]){
  const home=await fixture(t,{keys:{deepseek:'private-legacy-proxy-key'},keyTargets});let calls=0;
  const usage=createUsage({home,env:{},now:()=>NOW,fetchImpl:async()=>{calls++;throw Error('不应联网');}});t.after(()=>usage.stop());
  const snap=row(await usage.refresh());assert.equal(snap.available,false);assert.equal(snap.keySource,'');assert.equal(calls,0);
  assert.equal(JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8')).keys.deepseek,'private-legacy-proxy-key','未绑定旧配置不自动删除或迁移');
 }
});

test('DeepSeek：配置保存失败不能报告成功或把新 Key 留给后台使用',async t=>{
 const home=await fixture(t);let calls=0;
 await fs.mkdir(path.join(home,'.bobo/usage.json.tmp'));
 const usage=createUsage({home,env:{},now:()=>NOW,fetchImpl:async()=>{calls++;return response(body());}});t.after(()=>usage.stop());
 const result=await usage.setKey('deepseek','private-unsaved-key');assert.equal(result.ok,false);assert.match(result.message,/保存失败/);assert.equal(calls,1);
 assert.equal(row(await usage.refresh()).available,false);assert.equal(calls,1,'未保存的新 Key 不留作后台用途');
 assert.doesNotMatch(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'),/private-unsaved-key/);
});
