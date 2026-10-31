import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAI} from '../src/ai.mjs';
import {createSkillReader} from '../src/reader-ai.mjs';
import {createAIUsage,parseAIUsage} from '../src/ai-usage.mjs';
import {isOfficialDeepSeek,snapshotAIPrice} from '../src/ai-pricing.mjs';
const at=Date.parse('2026-10-21T12:00:00Z'),usage={prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20,completion_tokens_details:{reasoning_tokens:12}};
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-deepseek-ledger-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));return home;}
const metadata=(requestId,extra={})=>({requestId,baseUrl:'https://api.deepseek.com',model:'deepseek-flash',at,...extra});
test('DeepSeek 台账按请求去重，按日期与模型汇总，未知值保留 null，价格版本随请求保存',async t=>{
 const home=await fixture(t),store=createAIUsage(home,{now:()=>at});
 await Promise.all([store.record('skill:summary',usage,metadata('same')),store.record('skill:summary',usage,metadata('same')),store.record('skill:translate',null,metadata('unknown'))]);
 await store.record('butler',usage,metadata('next-day',{model:'deepseek-v4-pro',at:at+86400000}));
 let value=await store.snapshot();assert.equal(value.total.requests,3);assert.equal(value.deepseek.total.requests,3);assert.equal(value.deepseek.total.unmeasured,1);assert.equal(value.deepseek.total.partial,true);assert.equal(value.deepseek.total.input,200);assert.equal(value.deepseek.total.output,40);assert.equal(value.deepseek.total.reasoning,24);assert.equal(value.deepseek.days.length,2);assert.equal(value.deepseek.models.length,2);assert.equal(value.deepseek.models.find(m=>m.model==='deepseek-flash').requests,2);
 const unknown=value.deepseek.recent.find(r=>r.requestId==='unknown');assert.equal(unknown.usage,null);assert.equal(unknown.estimatedCost,null);assert.equal(unknown.priceVersion,'deepseek-cny-2026-10-21');assert.equal(unknown.price.modelVersion,'DeepSeek-V4.1-Flash-1017');assert.deepEqual(unknown.price.offPeak,{hit:0.02,miss:1,output:4});
 const restart=createAIUsage(home,{now:()=>at});assert.deepEqual(await restart.snapshot(),value);await restart.record('butler',usage,metadata('next-day'));assert.equal((await restart.snapshot()).total.requests,3);
 assert.doesNotMatch(await fs.readFile(path.join(home,'.bobo/ai-usage.json'),'utf8'),/Bearer|apiKey|test-key|document text/);assert.equal((await fs.stat(path.join(home,'.bobo/ai-usage.json'))).mode&0o777,0o600);
});
test('渠道绑定官方目标，不把代理商、OpenCode 同名模型或旧聚合追溯成官方消费',async t=>{
 const home=await fixture(t),store=createAIUsage(home,{now:()=>at});
 for(const [index,baseUrl] of ['https://opencode.ai','https://proxy.invalid/v1','https://api.deepseek.com.evil.invalid','http://api.deepseek.com','https://api.deepseek.com:444','https://api.deepseek.com/other','https://api.deepseek.com?x=1'].entries())await store.record('butler',usage,metadata('proxy'+index,{baseUrl}));
 let value=await store.snapshot();assert.equal(value.total.requests,7);assert.equal(value.deepseek.total.requests,0);assert.equal(value.deepseek.total.input,null);assert.equal(value.deepseek.total.costCnyMin,null);
 await store.record('butler',null,metadata('official-unknown'));value=await store.snapshot();assert.equal(value.deepseek.total.requests,1);assert.equal(value.deepseek.total.total,null);assert.equal(value.deepseek.total.costCnyMax,null);
 assert.ok(isOfficialDeepSeek('https://api.deepseek.com/v1'));assert.equal(isOfficialDeepSeek('https://api.deepseek.com@proxy.invalid'),false);assert.equal(snapshotAIPrice(metadata('x',{model:'constructor'})),null);
 const file=path.join(home,'.bobo/ai-usage.json'),old={version:2,since:1,features:{butler:{requests:3,measured:3,total:200,input:180,output:20}},days:{}};await fs.writeFile(file,JSON.stringify(old));value=await createAIUsage(home,{now:()=>at}).snapshot();assert.equal(value.total.total,200);assert.equal(value.deepseek.total.requests,0);assert.equal(value.deepseek.total.costCnyMin,null);
});
test('usage 缓存命中/未命中一致性，思考 token 属于输出明细',()=>{
 assert.equal(parseAIUsage({...usage,prompt_cache_hit_tokens:101}),null);assert.equal(parseAIUsage({...usage,prompt_cache_miss_tokens:30}),null);assert.equal(parseAIUsage({...usage,prompt_cache_hit_tokens:undefined}).cachedInput,80);assert.equal(parseAIUsage(usage).total,120);
});
test('官方实际请求非流/最后内容块 usage/中断/并发仅在上游记账，不发送真实请求',async t=>{
 const home=await fixture(t);let mode='json',calls=0;
 const ai=createAI(home,{platform:'linux',now:()=>at,env:{OPENAI_API_KEY:'test-key',OPENAI_BASE_URL:'https://api.deepseek.com/v1',OPENAI_MODEL:'deepseek-flash'},fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://api.deepseek.com/v1/chat/completions');assert.equal(options.redirect,'error');
  if(mode==='json')return new Response(JSON.stringify({model:'deepseek-flash',choices:[{message:{content:'完成'},finish_reason:'stop'}],usage}),{headers:{'Content-Type':'application/json'}});
  const terminal={model:'deepseek-flash',choices:[{delta:{},finish_reason:'stop'}],usage};
  const sse='data: '+JSON.stringify({choices:[{delta:{content:'完成'}}]})+'\n\ndata: '+JSON.stringify(terminal)+'\n\n';
  if(mode==='partial')return new Response(sse,{headers:{'Content-Type':'text/event-stream'}});
  if(mode==='broken')return new Response('data: '+JSON.stringify({choices:[{delta:{content:'部分'}}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  return new Response(sse+'data: '+JSON.stringify(terminal)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }});
 await ai.generate({mode:'summary',content:'document text'});mode='sse';await Promise.all([ai.generate({mode:'translate',content:'one',onDelta:()=>{}}),ai.generate({mode:'translate',content:'two',onDelta:()=>{}})]);let value=await ai.usage();assert.equal(value.deepseek.total.requests,3);assert.equal(value.deepseek.total.total,360);assert.equal(calls,3);await ai.usage();assert.equal(calls,3,'读取用量不发模型请求');
 mode='partial';await ai.generate({mode:'summary',content:'document text',onDelta:()=>{}});mode='broken';await assert.rejects(ai.generate({mode:'summary',content:'document text',onDelta:()=>{}}),/提前结束/);value=await ai.usage();assert.equal(value.deepseek.total.requests,5);assert.equal(value.deepseek.total.unmeasured,2);assert.equal(value.deepseek.total.total,360);assert.equal(value.deepseek.recent[0].usage,null);assert.equal(value.deepseek.recent[1].usage,null);assert.equal(value.deepseek.recent[2].usage.total,120);
});

test('Reader 磁盘缓存不记调用，一次分批并发翻译记录多次实际上游请求',async t=>{
 const home=await fixture(t),root=path.join(home,'demo');await fs.mkdir(root);await fs.writeFile(path.join(root,'SKILL.md'),Array.from({length:16},(_,i)=>'Paragraph '+i).join('\n\n'));let calls=0;
 const ai=createAI(home,{platform:'linux',now:()=>at,env:{OPENAI_API_KEY:'test-key',OPENAI_BASE_URL:'https://api.deepseek.com',OPENAI_MODEL:'deepseek-flash'},fetcher:async(url,options)=>{calls++;const request=JSON.parse(options.body),content=request.messages[1].content;let text='摘要';try{text=JSON.stringify(JSON.parse(content).map(row=>({...row,text:'译文 '+row.text})));}catch{}return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}],usage}),{headers:{'Content-Type':'application/json'}});}});
 const make=()=>createSkillReader({home,ai,resolveSkill:async id=>({id,path:root})}),reader=make();
 await reader.generate('demo','summary');assert.equal(calls,1);await make().generate('demo','summary');assert.equal(calls,1);await reader.generate('demo','translate');assert.equal(calls,5);await make().generate('demo','translate');assert.equal(calls,5);const value=await ai.usage();assert.equal(value.deepseek.total.requests,5);assert.equal(value.deepseek.total.total,600);
});
test('损坏的台账不覆盖原文件，继续观察的未知用量有存储错误提示',async t=>{
 const home=await fixture(t),file=path.join(home,'.bobo/ai-usage.json');await fs.mkdir(path.dirname(file));const corrupt=JSON.stringify({version:3,features:{},days:{},deepseek:{since:at,requests:[null]}});await fs.writeFile(file,corrupt);const store=createAIUsage(home,{now:()=>at});await store.record('butler',null,metadata('new'));const value=await store.snapshot();assert.match(value.error,/无法读取/);assert.equal(value.deepseek.total.requests,1);assert.equal(value.deepseek.total.total,null);assert.equal(await fs.readFile(file,'utf8'),corrupt);
});

test('DeepSeek 日期按已保存时区分组，旧数据缺少时区时固定当前时区，非法时区不覆盖',async t=>{
 const home=await fixture(t),file=path.join(home,'.bobo/ai-usage.json'),boundary=Date.parse('2026-10-21T23:30:00Z');await fs.mkdir(path.dirname(file));
 const old={version:3,since:at,features:{},days:{},deepseek:{since:at,timezone:'UTC',requests:[]}};await fs.writeFile(file,JSON.stringify(old));
 let store=createAIUsage(home,{now:()=>boundary,timezone:'Asia/Shanghai'});await store.record('butler',usage,metadata('utc-boundary',{at:boundary}));let value=await store.snapshot();assert.equal(value.deepseek.timezone,'UTC');assert.equal(value.deepseek.days[0].day,'2026-10-21');assert.equal(value.deepseek.recent[0].day,'2026-10-21');assert.equal(value.day,new Date(boundary).getFullYear()+'-'+String(new Date(boundary).getMonth()+1).padStart(2,'0')+'-'+String(new Date(boundary).getDate()).padStart(2,'0'),'原功能聚合仍按本机日期');
 delete old.deepseek.timezone;await fs.writeFile(file,JSON.stringify(old));store=createAIUsage(home,{now:()=>boundary,timezone:'Asia/Shanghai'});await store.record('butler',usage,metadata('legacy-boundary',{at:boundary}));value=await store.snapshot();assert.equal(value.deepseek.timezone,'Asia/Shanghai');assert.equal(value.deepseek.days[0].day,'2026-10-22');
 store=createAIUsage(home,{now:()=>boundary,timezone:'UTC'});await store.record('butler',usage,metadata('restart-boundary',{at:boundary}));value=await store.snapshot();assert.equal(value.deepseek.timezone,'Asia/Shanghai');assert.equal(value.deepseek.days.length,1);assert.equal(value.deepseek.days[0].models[0].requests,2);
 old.deepseek.timezone='invalid/timezone';const corrupt=JSON.stringify(old);await fs.writeFile(file,corrupt);store=createAIUsage(home,{now:()=>boundary,timezone:'UTC'});await store.record('butler',usage,metadata('invalid-zone',{at:boundary}));value=await store.snapshot();assert.match(value.error,/无法读取/);assert.equal(await fs.readFile(file,'utf8'),corrupt);assert.equal(value.deepseek.timezone,'UTC');
});
