import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.textContent='';this.value='';this.disabled=false;this.dataset={};this.style={};this.classList={toggle(){}};}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
}
const flatten=node=>node.textContent+' '+node.children.map(flatten).join(' ');
function page(){
 const nodes={},tables=[new Element()],notes=[new Element()],details=[new Element(),new Element()],segs={};
 const context=vm.createContext({document:{activeElement:null,createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('text'),{textContent:text}),querySelectorAll:selector=>({'[data-deepseek-ledger-rows]':tables,'[data-deepseek-ledger-note]':notes,'[data-deepseek-ledger-detail]':details}[selector]||[])},api:async()=>context.value,$:selector=>nodes[selector]??=new Element(),setSeg:(id,value)=>{segs[id]=value;},usageLevel:value=>value>=50?'ok':value>=20?'warn':'low',Date});
 const from=source.indexOf('function deepseekBalanceCard('),to=source.indexOf('function usageCard(',from);assert.ok(from>0&&to>from);vm.runInContext(source.slice(from,to),context);
 return {nodes,tables,notes,details,segs,run:(code,value)=>{context.value=value;return vm.runInContext(code,context);}};
}
test('余额分别展示原始十进制金额，不画百分比或把充值余额称为累计充值',()=>{
 const p=page();
 p.run('renderDeepSeekBalance(value)',{keySource:'manual',isAvailable:false,lastSuccessfulAt:1234567890000,stale:true,error:'HTTP 429',balances:[{currency:'CNY',total:'9007199254740993.123456789',granted:'0.000000001',toppedUp:'9007199254740993.123456788'},{currency:'USD',total:'0.01',granted:'0.00',toppedUp:'0.01'}]});
 const cards=p.nodes['#usageDeepseekBalances'];assert.equal(cards.children.length,2);assert.match(flatten(cards),/CNY 9007199254740993\.123456789/);assert.match(flatten(cards),/USD 0\.01/);assert.doesNotMatch(flatten(cards),/%|累计|已用/);
 assert.match(p.nodes['#usageDeepseekNote'].textContent,/余额不足.*最近成功.*已过期.*HTTP 429/);assert.equal(p.nodes['#usageDeepseekKeyClear'].disabled,false);assert.doesNotMatch(p.nodes['#usageDeepseekKeyStatus'].textContent,/尾号/);
});
test('占比模式显示两位小数余额、分母与百分比，并同步刘海设置控件',()=>{
 const p=page(),provider={available:true,enabled:true,isAvailable:true,stale:false,balances:[{currency:'CNY',total:'12.345',granted:'2.00',toppedUp:'10.345'},{currency:'USD',total:'0.125',granted:'0.10',toppedUp:'0.025'}],balanceView:{mode:'percent',currency:'CNY',denominator:'100.00',total:'12.345',amountText:'12.35',percent:12.35,percentText:'12.35'}};
 p.run('renderDeepSeekBalance(value)',provider);
 const cards=p.nodes['#usageDeepseekBalances'],text=flatten(cards);
 assert.equal(cards.children.length,3,'一张占比卡 + 两种币种的余额卡');
 assert.match(text,/余额占比/);assert.match(text,/12\.35%/);assert.match(text,/余额 ¥12\.35/);assert.match(text,/分母 ¥100\.00/);
 assert.equal(p.segs.deepseekDisplaySegs,'percent');assert.equal(p.segs.deepseekCurrencySegs,'CNY');
 assert.equal(p.nodes['#deepseekDenominator'].value,'100.00');assert.equal(p.nodes['#deepseekDenominator'].disabled,false);
 assert.match(p.nodes['#usageDeepseekNote'].textContent,/刘海：占比 12\.35%（分母 ¥100\.00）/);
 p.run('renderDeepSeekBalance(value)',{...provider,balanceView:{...provider.balanceView,mode:'balance'}});
 assert.equal(p.segs.deepseekDisplaySegs,'balance');assert.equal(p.nodes['#deepseekDenominator'].disabled,true);assert.match(p.nodes['#usageDeepseekNote'].textContent,/刘海：余额 ¥12\.35（上方横排两位小数）/);
});
test('未知用量显示破折号，分日模型及请求价格版本可见，部分合计明确范围',()=>{
 const p=page(),unknown={requests:1,measured:0,unmeasured:1,input:null,output:null,total:null,costCnyMin:null,costCnyMax:null,pricedRequests:0,unpricedRequests:1,pricingVersions:[]};
 p.run('renderDeepSeekLedger(value)',{since:1234567890000,timezone:'Asia/Shanghai',total:unknown,models:[{model:'deepseek-flash',...unknown}],days:[{day:'2026-10-21',models:[{model:'deepseek-flash',...unknown}]}]});
 let text=flatten(p.tables[0]);assert.match(text,/2026-10-21 \/ deepseek-flash/);assert.match(text,/用量未知/);assert.match(text,/—/);assert.doesNotMatch(text,/¥0/);assert.match(p.notes[0].textContent,/仅统计 bobo.*官方 DeepSeek.*本地缓存.*Asia\/Shanghai/);assert.match(p.details[0].textContent,/不是官方全账户账单/);
 const known={...unknown,requests:2,measured:1,input:100,output:20,total:120,costCnyMin:0.001,costCnyMax:0.002,pricedRequests:1,pricingVersions:['deepseek-cny-2026-10-21']};
 p.run('renderDeepSeekLedger(value)',{total:known,models:[{model:'deepseek-flash',...known}],days:[{day:'2026-10-21',models:[{model:'deepseek-flash',...known}]}]});
 text=flatten(p.tables[0]);assert.match(text,/已知部分/);assert.match(text,/¥0\.0010–¥0\.0020/);assert.match(text,/deepseek-cny-2026-10-21/);
});
test('余额 Key 表单显式指定 DeepSeek，初始无凭据时只提示用户配置',()=>{
 const p=page();p.run('renderDeepSeekBalance(value)',{available:false,reason:'请填写官方 Key',balances:[],isAvailable:null,lastSuccessfulAt:null,stale:false});assert.equal(p.nodes['#usageDeepseekKeyClear'].disabled,true);assert.match(flatten(p.nodes['#usageDeepseekBalances']),/请填写官方 Key/);
 const from=source.indexOf("$('#usageDeepseekKeyForm').onsubmit"),to=source.indexOf('// Claude Code：手动 Token',from),form=source.slice(from,to);assert.match(form,/id:'deepseek',key/);assert.match(form,/id:'deepseek',clear:true/);assert.doesNotMatch(form,/aiKey|OPENAI|keyHint/);
});

test('实际用量加载把持久化失败警告传到两个 DeepSeek 用量分栏，恢复后清除',async()=>{
 const p=page(),from=source.indexOf('async function loadAIUsage(){'),to=source.indexOf("$('#aiUsageRefresh').onclick",from);assert.ok(from>0&&to>from);p.run(source.slice(from,to));
 const total={requests:1,measured:1,unmeasured:0,input:8,output:2,total:10,cachedInput:0,cacheRate:0,cachePartial:false,reasoning:0,pricedRequests:1,unpricedRequests:0,costCnyMin:0.0001,costCnyMax:0.0001};
 const data={features:[],total,today:total,since:1234567890000,pricing:{source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',updatedAt:'2026-10-21'},deepseek:{total,days:[],models:[]},error:'用量记录保存失败；本次运行的统计尚未落盘'};
 await p.run('loadAIUsage()',data);
 assert.equal(p.details.length,2);for(const detail of p.details)assert.match(detail.textContent,/⚠ 用量记录保存失败；本次运行的统计尚未落盘/);
 assert.match(flatten(p.tables[0]),/接入后合计/);assert.match(flatten(p.tables[0]),/10/,'保存失败仍显示已观察的内存统计，并明确警告');
 await p.run('loadAIUsage()',{...data,error:''});for(const detail of p.details)assert.doesNotMatch(detail.textContent,/保存失败|尚未落盘/);
});
