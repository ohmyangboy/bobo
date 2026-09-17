import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAI} from './ai.mjs';
test('AI 配置与生成：系统读取、凭据保护、持久化、响应和失败恢复',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-ai-'));
 let status=200,response={choices:[{message:{content:'中文能力总结'},finish_reason:'stop'}]},received,redirect=false;
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={url:req.url,auth:req.headers.authorization,body:JSON.parse(body)};if(redirect){res.writeHead(302,{Location:'http://127.0.0.1:1/'});res.end();return;}res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const baseUrl='http://127.0.0.1:'+upstream.address().port+'/v1';
 const env={OPENAI_API_KEY:'system-secret',OPENAI_BASE_URL:baseUrl,OPENAI_MODEL:'demo-model'};
 const ai=createAI(home,{env,platform:'linux'});
 try{
  const state=await ai.status();assert.equal(state.keyAvailable,true);assert.equal(state.model,'demo-model');assert.ok(!JSON.stringify(state).includes('system-secret'));
  const result=await ai.generate({mode:'summary',content:'demo skill'});assert.equal(result.text,'中文能力总结');assert.equal(received.auth,'Bearer system-secret');assert.equal(received.url,'/v1/chat/completions');assert.equal(received.body.messages[1].content,'demo skill');assert.match(received.body.messages[0].content,/核心能力/);
  const settings={keySource:'manual',apiKey:'manual-secret',baseUrl,model:'custom-model'};
  const saved=await ai.save(settings);assert.ok(!JSON.stringify(saved).includes('manual-secret'));
  assert.equal((await fs.stat(path.join(home,'.bobo/ai.json'))).mode&0o777,0o600);
  await ai.save({...settings,apiKey:''});
  const restarted=createAI(home,{env:{},platform:'linux'});assert.equal((await restarted.status()).keyAvailable,true);
  response.choices[0].finish_reason='length';assert.equal((await restarted.generate({mode:'translate',content:'original'})).incomplete,true);assert.equal(received.auth,'Bearer manual-secret');assert.match(received.body.messages[0].content,/翻译/);
  status=401;response={error:{message:'provider echoes manual-secret'}};await assert.rejects(ai.generate({mode:'summary',content:'test'}),/API Key 无效/);
  status=429;await assert.rejects(ai.generate({mode:'summary',content:'test'}),/额度不足/);
  status=200;response={};await assert.rejects(ai.generate({mode:'summary',content:'test'}),/未返回文本/);
  redirect=true;await assert.rejects(ai.generate({mode:'summary',content:'test'}),/无法连接/);redirect=false;
  response={choices:[{message:{content:'recovered'}}]};assert.equal((await ai.generate({mode:'summary',content:'test'})).text,'recovered');
  await assert.rejects(ai.save({...settings,baseUrl:'http://example.com/v1'}),/HTTPS/);
  await assert.rejects(ai.save({...settings,baseUrl:'https://secret@example.com/v1'}),/凭据/);
  await assert.rejects(ai.generate({mode:'execute',content:'test'}),/不支持/);
  await assert.rejects(ai.generate({mode:'summary',content:'中'.repeat(60001)}),/180 KB/);
  await ai.save({...settings,clearKey:true});assert.equal((await ai.status()).keyAvailable,false);await assert.rejects(ai.generate({mode:'summary',content:'test'}),/尚未配置/);
  await ai.save({...settings,keySource:'system',apiKey:''});assert.equal((await ai.status()).keyAvailable,true);
  const mac=createAI(home,{env:{},platform:'darwin',launchGet:async name=>name==='OPENAI_API_KEY'?'launch-secret':''});assert.match((await mac.status()).source,/launchctl/);assert.equal((await mac.status()).keyAvailable,true);
 }finally{await new Promise(r=>upstream.close(r));await fs.rm(home,{recursive:true,force:true});}
});

test('zshrc Key：字面量、拒绝命令替换、显式来源和重新读取',async()=>{
 const {parseZshrcKey}=await import('./ai.mjs');
 assert.equal(parseZshrcKey('export OPENAI_API_KEY="test-key" # 注释'),'test-key');
 assert.equal(parseZshrcKey("OPENAI_API_KEY='test-key'"),'test-key');
 assert.equal(parseZshrcKey('OPENAI_API_KEY=test-key'),'test-key');
 assert.equal(parseZshrcKey('# export OPENAI_API_KEY=commented'),undefined);
 assert.equal(parseZshrcKey('export OPENAI_API_KEY="$(touch /tmp/not-executed)"'),undefined);
 assert.equal(parseZshrcKey('export OPENAI_API_KEY="$OTHER_KEY"'),undefined);
 assert.equal(parseZshrcKey('OPENAI_API_KEY=old\nOPENAI_API_KEY="$(command)"'),undefined);
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-zshrc-'));
 try{
  await fs.writeFile(path.join(home,'.zshrc'),'export OPENAI_API_KEY="file-secret"');
  const ai=createAI(home,{env:{OPENAI_API_KEY:'env-secret'},platform:'linux'});
  assert.match((await ai.status()).source,/环境变量/);
  const c=await ai.save({keySource:'zshrc',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash'});
  assert.equal(c.source,'~/.zshrc OPENAI_API_KEY');assert.equal(c.keyAvailable,true);assert.equal(c.keySource,'zshrc');
  assert.ok(!JSON.stringify(c).includes('file-secret'));
  assert.ok(!(await fs.readFile(path.join(home,'.bobo/ai.json'),'utf8')).includes('file-secret'));
  await fs.writeFile(path.join(home,'.zshrc'),'# removed');assert.equal((await ai.status()).keyAvailable,false);
  await ai.save({keySource:'system',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash'});
  await fs.writeFile(path.join(home,'.zshrc'),'OPENAI_API_KEY=fallback');
  assert.equal((await createAI(home,{env:{},platform:'linux'}).status()).source,'~/.zshrc OPENAI_API_KEY');
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
