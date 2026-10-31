import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUsage,defaultBalanceDisplay,deepseekSnapshot,formatDecimal,normalizeBalanceDisplay} from '../src/usage.mjs';

const NOW=Date.parse('2026-10-21T12:00:00Z');
const rawBody={is_available:true,balance_infos:[
 {currency:'CNY',total_balance:'110.000000000000000001',granted_balance:'10.000000000000000001',topped_up_balance:'100.00'},
 {currency:'USD',total_balance:'0.125',granted_balance:'0.100',topped_up_balance:'0.025'},
]};
const response=(value,status=200)=>({status,ok:status>=200&&status<300,json:async()=>value});
const row=snapshot=>snapshot.providers.find(p=>p.id==='deepseek');
async function fixture(t,settings={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-deepseek-display-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 await fs.mkdir(path.join(home,'.bobo'),{recursive:true});
 await fs.writeFile(path.join(home,'.bobo/usage.json'),JSON.stringify({
  enabled:{codex:false,claude:false,'opencode-go':false,agy:false},
  keys:{deepseek:'private-official-fixture'},
  keyTargets:{deepseek:'https://api.deepseek.com/user/balance'},
  ...settings,
 }));
 return home;
}
const create=home=>createUsage({home,now:()=>NOW,env:{},fetchImpl:async()=>response(rawBody)});

test('两位小数用十进制字符串四舍五入，不丢大额精度',()=>{
 assert.equal(formatDecimal('110.000000000000000001',2),'110.00');
 assert.equal(formatDecimal('0.125',2),'0.13');
 assert.equal(formatDecimal('0.004',2),'0.00');
 assert.equal(formatDecimal('0.005',2),'0.01');
 assert.equal(formatDecimal('9007199254740993.123456789',2),'9007199254740993.12');
 assert.equal(formatDecimal('001.2',2),'1.20');
 assert.equal(formatDecimal('-0.001',2),'0.00');
 assert.equal(formatDecimal('12',2),'12.00');
 for(const value of ['','abc','1e2','.5','1.','-'])assert.equal(formatDecimal(value,2),null);
});

test('余额显示默认：余额模式、人民币、100 元分母，金额原始字符串保留',()=>{
 assert.deepEqual(defaultBalanceDisplay(),{mode:'balance',currency:'CNY',denominator:'100.00'});
 assert.deepEqual(normalizeBalanceDisplay({mode:'percent',currency:'USD',denominator:'50.5'}),{mode:'percent',currency:'USD',denominator:'50.50'});
 assert.deepEqual(normalizeBalanceDisplay({mode:'bad',currency:'EUR',denominator:'0'}),{mode:'balance',currency:'CNY',denominator:'100.00'});
 const snap=deepseekSnapshot(rawBody,NOW);
 assert.equal(snap.balances[0].total,'110.000000000000000001');
});

test('DeepSeek 余额视图：余额模式给两位小数金额，占比模式按分母算剩余百分比',async t=>{
 const home=await fixture(t),usage=create(home);t.after(()=>usage.stop());
 let deepseek=row(await usage.refresh());
 assert.deepEqual(deepseek.balanceView,{mode:'balance',currency:'CNY',denominator:'100.00',total:'110.000000000000000001',amountText:'110.00',percent:100,percentText:'100.00'});
 let hits=0;usage.subscribe(()=>hits++);
 let state=usage.setBalanceDisplay({mode:'percent'});
 deepseek=row(state);
 assert.equal(deepseek.balanceView.mode,'percent');assert.equal(deepseek.balanceView.percent,100);
 assert.equal(hits,1,'只改显示也要推送给刘海');
 state=usage.setBalanceDisplay({currency:'USD',denominator:'0.25'});
 deepseek=row(state);
 assert.equal(deepseek.balanceView.currency,'USD');
 assert.equal(deepseek.balanceView.total,'0.125');
 assert.equal(deepseek.balanceView.amountText,'0.13');
 assert.equal(deepseek.balanceView.percent,50);
 assert.equal(deepseek.balanceView.percentText,'50.00');
 assert.equal(hits,2);
 await usage.stop();
});

test('DeepSeek 余额显示设置保存到 usage.json，重启后恢复；非法值在改状态前拒绝',async t=>{
 const home=await fixture(t),usage=create(home);t.after(()=>usage.stop());
 await usage.refresh();
 for(const input of [{mode:'circle'},{currency:'EUR'},{denominator:'0'},{denominator:'-1'},{denominator:'abc'},{denominator:'1e2'},{denominator:'10.001'},{denominator:''}]){
  await assert.rejects(async()=>usage.setBalanceDisplay(input),e=>e.status===400);
 }
 assert.deepEqual(row(usage.snapshot()).balanceView,{mode:'balance',currency:'CNY',denominator:'100.00',total:'110.000000000000000001',amountText:'110.00',percent:100,percentText:'100.00'});
 usage.setBalanceDisplay({mode:'percent',currency:'USD',denominator:'50'});
 await usage.stop();
 const saved=JSON.parse(await fs.readFile(path.join(home,'.bobo/usage.json'),'utf8'));
 assert.deepEqual(saved.balance,{mode:'percent',currency:'USD',denominator:'50.00'});
 const again=create(home);t.after(()=>again.stop());
 const deepseek=row(await again.refresh());
 assert.deepEqual(deepseek.balanceView,{mode:'percent',currency:'USD',denominator:'50.00',total:'0.125',amountText:'0.13',percent:0.25,percentText:'0.25'});
 await again.stop();
});

test('DeepSeek 所选币种不存在时退回接口返回的第一格；失败时沿用上次余额按新设置重算',async t=>{
 const home=await fixture(t,{balance:{mode:'percent',currency:'USD',denominator:'100.00'}});
 let fail=false,calls=0,clock=NOW;
 const usage=createUsage({home,now:()=>clock,env:{},fetchImpl:async()=>{calls++;if(fail)return response({error:'down'},503);return response({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.345',granted_balance:'0',topped_up_balance:'12.345'}]});}});
 t.after(()=>usage.stop());
 let deepseek=row(await usage.refresh());
 assert.equal(deepseek.balanceView.currency,'CNY');
 assert.equal(deepseek.balanceView.amountText,'12.35');
 assert.equal(deepseek.balanceView.percent,12.35);
 fail=true;
 clock+=180000; // 越过 60 秒硬下限，让下一次强制刷新真的打网络
 usage.setBalanceDisplay({currency:'USD',denominator:'20'});
 deepseek=row(await usage.refresh(true));
 assert.equal(calls,2);
 assert.equal(deepseek.available,true);
 assert.equal(deepseek.stale,true);
 assert.equal(deepseek.balanceView.currency,'CNY','所选 USD 缺失时仍用 CNY');
 assert.equal(deepseek.balanceView.amountText,'12.35');
 assert.equal(deepseek.balanceView.percent,61.73);
 await usage.stop();
});
