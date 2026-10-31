import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAI} from '../src/ai.mjs';
import {createAIUsage,parseAIUsage} from '../src/ai-usage.mjs';
import {estimateAICost} from '../src/ai-pricing.mjs';
test('实际 usage：缓存输入与思考输出不重复累加，未知用量不估算',()=>{
 assert.deepEqual(parseAIUsage({prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:80,completion_tokens_details:{reasoning_tokens:5}}),{input:100,output:20,total:120,cachedInput:80,cacheKnown:true,reasoning:5});
 assert.equal(parseAIUsage({prompt_tokens:'100',completion_tokens:20}),null);
 assert.equal(parseAIUsage(undefined),null);
 assert.equal(parseAIUsage({input_tokens:30,output_tokens:10,input_tokens_details:{cached_tokens:20}}).total,40);
 assert.equal(parseAIUsage({prompt_tokens:30,completion_tokens:10}).cacheKnown,false);
 assert.equal(parseAIUsage({prompt_tokens:30,completion_tokens:10,prompt_cache_hit_tokens:0}).cacheKnown,true);
});
test('管家、总结、分批流式翻译分开记账，并发、持久化与跨天统计',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-tokens-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));let now=Date.now(),received=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);received.push(body);
  const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:60};
  if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'翻译完成'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n');}
  else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:body.max_tokens?JSON.stringify({projects:[{id:'p',summary:'修复完成。'}]}):'总结完成'},finish_reason:'stop'}],usage}));}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const options={now:()=>now,platform:'linux',env:{OPENAI_API_KEY:'test-key',OPENAI_MODEL:'deepseek-v4-flash',OPENAI_BASE_URL:'http://127.0.0.1:'+server.address().port}},ai=createAI(home,options);
 await ai.generate({mode:'summary',content:'fixture'});
 await Promise.all([ai.generate({mode:'translate',content:'part one',onDelta:()=>{}}),ai.generate({mode:'translate',content:'part two',onDelta:()=>{}})]);
 const brief=await ai.summarizeWork({projects:[{id:'p',name:'demo',observations:[{id:'latest',request:'修复',result:'完成'}]}]});assert.deepEqual(brief.projects,[{id:'p',summary:'修复完成。'}]);
 const usage=await ai.usage(),feature=id=>usage.features.find(f=>f.id===id);
 assert.equal(feature('skill:summary').total,120);assert.equal(feature('skill:translate').total,240);assert.equal(feature('butler').total,120);assert.equal(usage.total.total,480);assert.equal(usage.total.cachedInput,240);assert.equal(usage.total.cacheRate,0.6);assert.equal(usage.total.cachePartial,false);assert.equal(usage.total.unpricedRequests,4,'本机 mock 即使使用 DeepSeek 模型名也不能按官方价格估算');
 assert.ok(received.filter(r=>r.stream).every(r=>r.stream_options.include_usage));assert.equal(received.at(-1).max_tokens,128);assert.deepEqual(received.at(-1).thinking,{type:'disabled'});assert.match(received.at(-1).messages[0].content,/一句话.*40字/);
 assert.equal(feature('butler').lastRequest.cacheRate,0.6);assert.equal(feature('butler').lastRequest.input,100);assert.equal(feature('butler').lastRequest.costCnyMin,null);
 assert.equal((await fs.stat(path.join(home,'.bobo/ai-usage.json'))).mode&0o777,0o600);assert.doesNotMatch(await fs.readFile(path.join(home,'.bobo/ai-usage.json'),'utf8'),/test-key|fixture|part one/);
 const restart=createAI(home,options);assert.equal((await restart.usage()).total.total,480);now+=86400000;assert.equal((await restart.usage()).today.total,0);assert.equal((await restart.usage()).total.total,480);
});
test('官方费用：按命中/未命中/输出分别计价，时区、别名与节假日不明时给出区间',()=>{
 const usage=parseAIUsage({prompt_tokens:1000000,completion_tokens:500000,prompt_cache_hit_tokens:800000});
 const metadata={model:'deepseek-v4-flash',baseUrl:'https://api.deepseek.com',at:Date.parse('2026-10-10T09:00:00Z')};
 assert.deepEqual(estimateAICost(usage,metadata),{min:2.216,max:2.216});
 assert.deepEqual(estimateAICost(usage,{...metadata,at:Date.parse('2026-10-12T01:30:00Z')}),{min:2.216,max:4.432},'按北京时间判断工作日高峰，节假日不明不声称实际单价');
 assert.deepEqual(estimateAICost(usage,{...metadata,at:Date.parse('2026-10-12T04:00:00Z')}),{min:2.216,max:2.216});
 assert.deepEqual(estimateAICost(usage,{...metadata,model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1'}),{min:2.216,max:2.216});
 assert.deepEqual(estimateAICost(usage,{...metadata,model:'deepseek-v4-pro'}),{min:7.77,max:7.77});
 assert.deepEqual(estimateAICost(parseAIUsage({prompt_tokens:1000000,completion_tokens:500000}),metadata),{min:2.02,max:3});
 for(const override of [{model:'unknown'},{model:'constructor'},{baseUrl:'https://gateway.example.invalid/v1'},{baseUrl:'https://api.deepseek.com.evil.invalid'},{baseUrl:'http://127.0.0.1:14380'},{at:undefined},{at:1e100}])assert.equal(estimateAICost(usage,{...metadata,...override}),null);
 assert.equal(estimateAICost(null,metadata),null);
});
test('缓存缺失不伪造 0%：部分记录显示下限，费用合计持久化并兼容旧版用量',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-cost-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const now=Date.parse('2026-10-10T09:00:00Z');
 const store=createAIUsage(home,{now:()=>now}),metadata={baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash',at:now};
 await store.record('skill:summary',{prompt_tokens:100,completion_tokens:20});
 let value=await store.snapshot();assert.equal(value.total.cacheRate,null);assert.equal(value.total.pricedRequests,0);
 await store.record('butler',{prompt_tokens:1000000,completion_tokens:500000,prompt_cache_hit_tokens:800000},metadata);
 value=await store.snapshot();assert.equal(value.total.cachePartial,true);assert.equal(value.total.cacheRate,800000/1000100);assert.equal(value.total.costCnyMin,2.216);assert.equal(value.today.costCnyMax,2.216);assert.equal(value.total.unpricedRequests,1);
 assert.deepEqual(await createAIUsage(home,{now:()=>now}).snapshot(),value);
 const legacy={version:1,since:now,features:{butler:{requests:5,measured:5,unmeasured:0,input:11161,output:1945,total:13106,cachedInput:2432,reasoning:0}},days:{}};
 await fs.writeFile(path.join(home,'.bobo/ai-usage.json'),JSON.stringify(legacy));
 const migrated=createAIUsage(home,{now:()=>now});value=await migrated.snapshot();assert.equal(value.total.total,13106);assert.equal(value.total.cacheRate,2432/11161);assert.equal(value.total.cachePartial,true);assert.equal(value.total.unpricedRequests,5);assert.equal(value.total.costCnyMax,0,'旧请求不能套用当前配置追溯费用');
 await migrated.record('butler',{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:80},metadata);
 value=await migrated.snapshot();assert.equal(value.total.total,13226);assert.equal(value.total.pricedRequests,1);assert.equal(value.total.unpricedRequests,5);assert.equal(value.today.cachePartial,false);assert.equal(JSON.parse(await fs.readFile(path.join(home,'.bobo/ai-usage.json'),'utf8')).version,3);
 const latest=value.features.find(f=>f.id==='butler').lastRequest;assert.equal(latest.cacheRate,0.8);assert.equal(latest.input,100);assert.equal(latest.cachedInput,80);assert.ok(latest.costCnyMin>0);
 assert.deepEqual((await createAIUsage(home,{now:()=>now}).snapshot()).features.find(f=>f.id==='butler').lastRequest,latest);
});
test('缓存读取不增加请求，未提供 usage 的请求单独标注',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-unmeasured-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const store=createAIUsage(home);
 await store.record('skill:summary',null);const first=await store.snapshot();assert.equal(first.total.requests,1);assert.equal(first.total.unmeasured,1);assert.equal(first.total.total,0);
 assert.deepEqual(await store.snapshot(),first);
 await Promise.all([store.record('butler',{prompt_tokens:1,completion_tokens:2}),store.record('skill:translate',{prompt_tokens:3,completion_tokens:4})]);assert.equal((await store.snapshot()).total.total,10);
});
test('失败请求也记账：HTTP 错误标未知，已返回 usage 的无效摘要仍累计',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-failed-tokens-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));let first=true;
 const server=http.createServer(async(req,res)=>{for await(const chunk of req){}if(first){first=false;res.statusCode=429;res.end();}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'invalid json'}}],usage:{prompt_tokens:30,completion_tokens:10}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const ai=createAI(home,{platform:'linux',env:{OPENAI_API_KEY:'test-key',OPENAI_BASE_URL:'http://127.0.0.1:'+server.address().port}});
 await assert.rejects(ai.generate({mode:'summary',content:'fixture'}),/请求受限/);
 await assert.rejects(ai.summarizeWork({projects:[{id:'p',observations:[]}]}),/格式无效/);
 const usage=await ai.usage();assert.equal(usage.total.requests,2);assert.equal(usage.total.unmeasured,1);assert.equal(usage.total.total,40);assert.equal(usage.features.find(f=>f.id==='butler').total,40);
});
