import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('管家回复接口：鉴权、原会话绑定、本机分流和失败回执；隔离 HOME 不操作真实终端',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-butler-http-')),at=Date.now();
 await fs.mkdir(path.join(home,'.bobo/butler'),{recursive:true});
 const messages=[{id:'bobo-progress',role:'butler',projectId:'bobo',name:'bobo',text:'构建通过，待验证。',at,summaryAt:at,source:'codex',sessionId:'one',title:'管家开发',directory:'/tmp/bobo'},{id:'blog-progress',role:'butler',projectId:'blog',name:'paper-blog',text:'博客已发布。',at,summaryAt:at,source:'claude',sessionId:'two',title:'发布博客',directory:'/tmp/blog'}];
 const projects=Object.fromEntries(messages.map(m=>[m.projectId,{id:m.projectId,name:m.name,directory:m.directory,updatedAt:at,summaryAt:0,facts:{done:[],pending:[],next:[]}}]));
 await fs.writeFile(path.join(home,'.bobo/butler/state.json'),JSON.stringify({version:2,enabled:true,baselined:true,watchSince:at,projects,observations:{},messages,budget:{day:'',count:0},lastBatch:0}));
 await fs.mkdir(path.join(home,'.codex'),{recursive:true});await fs.writeFile(path.join(home,'.codex/session_index.jsonl'),JSON.stringify({id:'one',thread_name:'管家开发的新标题'})+'\n');
 const port=14335,env={...process.env,BOBO_HOME:home,PORT:String(port)};delete env.ANTIGRAVITY_LS_ADDRESS;delete env.ANTIGRAVITY_CSRF_TOKEN;
 const child=spawn(process.execPath,['../src/server.mjs'],{cwd:import.meta.dirname,env,stdio:'pipe'});
 t.after(async()=>{child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));await fs.rm(home,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('server exit '+c)));});
 const base='http://127.0.0.1:'+port,html=await(await fetch(base)).text(),token=html.match(/name="token" content="([^"]+)/)[1];
 const avatar=await fetch(base+'/bobo-avatar.png');assert.equal(avatar.status,200);assert.equal(avatar.headers.get('Content-Type'),'image/png');assert.ok((await avatar.arrayBuffer()).byteLength>1000);
 const req=async(route,data,extra={})=>{const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{'x-bobo-token':token,'Content-Type':'application/json',...extra},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json()};};
 for(const route of ['butler/reply','butler/focus']){
  assert.equal((await fetch(base+'/api/'+route,{method:'POST',body:'{}'})).status,403);
  assert.equal((await req(route,{}, {Origin:'https://evil.example'})).status,403);
 }
 assert.equal((await req('butler/focus',{id:'expired'})).status,404);
 assert.equal((await req('butler/focus',{id:'bobo-progress'})).data.ok,false);
 const input={requestId:'test-request-one',text:'继续验证',replyTo:'bobo-progress',quote:'待验证'};
 assert.equal((await req('butler/reply',{...input,targetId:'claude:two'})).status,400);
 assert.equal((await req('butler/reply',{...input,quote:'伪造的引用'})).status,400);
 assert.equal((await req('butler/reply',{...input,text:'bad\x1b[201~'})).status,400);
 assert.equal((await req('butler/reply',{...input,attachments:[{path:'/etc/passwd'}]})).status,400);
 assert.equal((await req('butler/reply',{...input,attachments:Array(5).fill({mimeType:'image/png',data:'AA=='})})).status,400);
 const choose=await req('butler/reply',{requestId:'test-choose-one',text:'继续处理'});
 assert.equal(choose.data.status,'choose');assert.deepEqual(choose.data.candidates.map(c=>c.id).sort(),['claude:two','codex:one']);assert.doesNotMatch(JSON.stringify(choose.data),/directory/);
 assert.equal(choose.data.candidates.find(c=>c.id==='codex:one').title,'管家开发的新标题');
 const result=(await req('butler/reply',input)).data;assert.equal(result.status,'failed');assert.equal(result.retryable,true);assert.equal(result.target.source,'codex');assert.match(result.reason,/暂支持 Otty/);
 assert.equal(result.target.title,'管家开发的新标题','已保留的旧消息也查当前原会话标题，不依赖短时活跃列表');
 await req('butler/reply',input);
 const direct=(await req('butler/reply',{requestId:'test-direct-one',text:'继续发布博客'})).data;assert.equal(direct.target.source,'claude');assert.equal(direct.status,'failed');
 const detail=(await req('butler')).data;assert.equal(detail.messages.length,4);assert.equal(detail.messages.filter(m=>m.id==='reply-test-request-one').length,1);assert.equal(detail.messages[2].quote,'待验证');
 assert.equal((await req('ai/usage')).data.total.requests,0);
 const snapshot=(await req('opencode')).data.butler;assert.doesNotMatch(JSON.stringify(snapshot),/"directory"|"sessionId"|"requestId"/);
 const enable=(await req('butler/reply',{...input,requestId:'test-enable-input',enableOttyInput:true})).data;
 assert.equal(enable.status,'failed');assert.equal(enable.retryable,true);assert.match(enable.reason,/隔离环境不修改真实 Otty 配置/);
 await req('butler/settings',{enabled:false});assert.equal((await req('butler/reply',input)).status,400);
});
