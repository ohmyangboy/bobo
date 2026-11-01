import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('OpenCode Go 页面：官方额度不可用时显示原因，花费与模型历史继续展示',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const windows=source.slice(source.indexOf('function renderUsageWindows('),source.indexOf('// 来源启停：',source.indexOf('function renderUsageWindows(')));
 const render=source.slice(source.indexOf('function renderUsage(){'),source.indexOf('async function loadUsage(){'));
 class Element{
  children=[];textContent='';disabled=false;
  replaceChildren(...children){this.children=children;}
  append(...children){this.children.push(...children);}
  querySelector(){return null;}
 }
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const context=vm.createContext({$,document:{createElement:()=>new Element()},
  usageData:{updatedAt:0,providers:[{id:'opencode-go',available:false,source:'api',keySource:'manual',reason:'OpenCode Go 未授权（HTTP 403）',windows:[],historyAvailable:true,
   daily:[{day:'2026-11-01',costUSD:2,calls:1}],models:[{name:'test-model',costUSD:2,calls:1}]}]},
  renderQuotaSide(){},usageSwitch(){},renderDeepSeekBalance(){},toggleSwitch(){return new Element();},
  usageCard(){throw Error('官方额度不可用时不能生成百分比卡片');},
  usageRow:(label,details)=>({label,...details}),money:n=>'$'+n});
 vm.runInContext(windows+'\n'+render+'\nrenderUsage();',context);
 assert.match($('#usageOpencodeWindows').children[0].textContent,/未授权/);
 assert.match($('#usageOpencodeNote').textContent,/不会用本机费用推算/);
 assert.equal($('#usageDays').children.length,1);assert.match($('#usageDays').children[0].text,/\$2/);
 assert.equal($('#usageModels').children[0].label,'test-model');
 assert.equal($('#usageKeyClear').disabled,false,'仍允许清除失效的手动 Key');
});
