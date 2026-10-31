import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('原生余额保留金额字符串，独立于额度窗口，可用状态为 false 仍可显示余额', {skip:process.platform!=='darwin'},async()=>{
 const source=await fs.readFile(new URL('./Bobo.swift',import.meta.url),'utf8');
 const from=source.indexOf('struct IslandQuotaWindow:'),to=source.indexOf('// 设备快照',from);assert.ok(from>0&&to>from);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-balance-model-'));
 try{
  const file=path.join(dir,'check.swift'),data={available:true,selected:'deepseek',providers:[{id:'deepseek',name:'DeepSeek',available:true,enabled:true,kind:'balance',windows:[],balances:[{currency:'CNY',total:'9007199254740993.123456789',granted:'0.000000001',toppedUp:'9007199254740993.123456788'},{currency:'USD',total:'0.01',granted:'0.00',toppedUp:'0.01'}],balanceView:{mode:'percent',currency:'USD',denominator:'50.00',total:'0.01',amountText:'0.01',percent:0.02,percentText:'0.02'},isAvailable:false,lastSuccessfulAt:1234567890000,stale:true},{id:'codex',available:true,enabled:true,windows:[{key:'session',remainingPercent:75}]}]};
  await fs.writeFile(file,'import Foundation\n'+source.slice(from,to)+'\n'+`
let quota = try JSONDecoder().decode(IslandQuota.self, from: Data(#"${JSON.stringify(data)}"#.utf8))
let balance = quota.providers[0]
precondition(balance.showable && balance.session == nil && balance.displayWindow == nil)
precondition(balance.balances.count == 2 && balance.balances[0].total == "9007199254740993.123456789")
precondition(balance.balances[1].currency == "USD" && balance.balances[1].total == "0.01")
precondition(balance.isAvailable == false && balance.stale && balance.lastSuccessfulAt == 1234567890000)
precondition(balance.balanceMode == "percent" && balance.balancePercent == 0.02)
precondition(balance.balanceAmountText == "0.01" && balance.balanceCurrency == "USD" && balance.balanceSymbol == "$")
precondition(balance.balanceDenominator == "50.00" && balance.hasQuotaIndicator)
let legacy = try JSONDecoder().decode(IslandQuotaProvider.self, from: Data(#"{"id":"deepseek","kind":"balance","balances":[{"currency":"CNY","total":"1.00","granted":"0","toppedUp":"1.00"}]}"#.utf8))
precondition(legacy.balanceMode == "balance" && legacy.balanceAmountText == nil)
precondition(quota.subscriptions.map { $0.id } == ["deepseek", "codex"])
precondition(quota.displayed?.id == "deepseek" && quota.switchable)
precondition(quota.providers[1].displayWindow?.remainingPercent == 75)
`);
  execFileSync('/usr/bin/xcrun',['swift',file],{stdio:'pipe',timeout:60000});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
