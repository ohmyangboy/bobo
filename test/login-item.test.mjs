import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLoginItem,parseLoginItemSnapshot} from '../src/login-item.mjs';
const run=promisify(execFile);
const snapshot=status=>({supported:status!=='notFound',enabled:status==='enabled',registered:['enabled','requiresApproval'].includes(status),requiresApproval:status==='requiresApproval',status,reason:status==='requiresApproval'?'需要在系统设置中允许 bobo':'系统状态：'+status});

test('登录项：系统快照严格校验，区分已开启与等待允许',()=>{
 for(const status of ['enabled','notRegistered','requiresApproval','notFound'])assert.deepEqual(parseLoginItemSnapshot(JSON.stringify(snapshot(status))),snapshot(status));
 for(const value of [null,{},snapshot('unknown'),{...snapshot('enabled'),enabled:false},{...snapshot('requiresApproval'),registered:false},{...snapshot('notFound'),supported:true}])assert.throws(()=>parseLoginItemSnapshot(JSON.stringify(value)));
});

test('登录项：源码、非 macOS 与隔离环境不执行真实系统命令',async()=>{
 let calls=0;
 for(const options of [{platform:'linux',argv1:'/Applications/bobo.app/Contents/Resources/src/server.mjs',exec:async()=>{calls++;}},{platform:'darwin',argv1:'/source/src/server.mjs',exec:async()=>{calls++;}},{platform:'darwin',argv1:'/Applications/bobo.app/Contents/Resources/src/server.mjs',isolated:true}]){
  const service=createLoginItem(options);
  assert.equal((await service.snapshot()).supported,false);
  await assert.rejects(service.save({enabled:true}),e=>e.status===400);
 }
 assert.equal(calls,0);
});

test('登录项：固定可执行路径和参数，拒绝无效参数与并发修改，失败后可重试',async()=>{
 let state='notRegistered',broken=false,hold=null;const calls=[];
 const service=createLoginItem({platform:'darwin',argv1:'/Applications/bobo test.app/Contents/Resources/src/server.mjs',isolated:true,exec:async(file,args)=>{
  calls.push({file,args});if(broken)throw Error('fixture');if(hold)return await hold;
  if(args[1]==='enable')state='enabled';if(args[1]==='disable')state='notRegistered';
  return {stdout:JSON.stringify(snapshot(state))};
 }});
 assert.equal((await service.snapshot()).enabled,false);
 assert.equal((await service.save({enabled:true})).enabled,true);
 assert.equal(calls[1].file,'/Applications/bobo test.app/Contents/MacOS/Bobo');
 assert.deepEqual(calls[1].args,['--login-item','enable']);
 assert.equal((await service.save({enabled:false})).registered,false);
 await service.save({openSettings:true});assert.deepEqual(calls.at(-1).args,['--login-item','settings']);
 for(const input of [null,[],{},'enable',{enabled:1},{enabled:true,extra:true},{openSettings:false},{enabled:true,openSettings:true}])await assert.rejects(service.save(input),e=>e.status===400);
 broken=true;await assert.rejects(service.save({enabled:true}),/登录项操作失败/);broken=false;
 let release;hold=new Promise(resolve=>{release=resolve;});
 const pending=service.save({enabled:true});await assert.rejects(service.save({enabled:false}),e=>e.status===409);
 release({stdout:JSON.stringify(snapshot('requiresApproval'))});assert.equal((await pending).requiresApproval,true);
 hold=null;assert.equal((await service.save({enabled:false})).enabled,false);
});

// 运行实际页面的开关与请求函数，用内存 DOM 验证待允许状态、失败回滚和迟到响应。
test('通用设置：系统登录项开关、待允许入口与失败状态保持一致',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 class Element {
  children=[];attributes={};hidden=false;disabled=false;
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  querySelector(selector){return this.children.find(node=>selector==='input'?node.type==='checkbox':node.className===selector.slice(1))||null;}
  setAttribute(key,value){this.attributes[key]=value;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
 }
 const nodes=new Map(['rowLaunchAtLogin','launchAtLoginNote','launchAtLoginSettings'].map(key=>['#'+key,new Element()]));
 const calls=[];let state='notRegistered',broken=false,readLater=null,releaseRead;
 const listeners=new Map();
 const context=vm.createContext({window:{addEventListener:(name,fn)=>listeners.set(name,fn)},islandView:'settings',settingsPane:'general',document:{createElement:()=>new Element()},$:key=>nodes.get(key),toast(){},guard:fn=>fn,api:async(route,body)=>{
  calls.push({route,body});if(broken)throw Error('保存失败 fixture');
  if(!body&&readLater)return readLater;
  if(body?.enabled===true)state='requiresApproval';if(body?.enabled===false)state='notRegistered';
  return snapshot(state);
 }});
 const toggle=source.match(/^function toggleSwitch\(.*$/m)[0];
 const start=source.indexOf('// bobo 自身的登录项由 macOS 管理'),end=source.indexOf('// 更新入口在右上角',start);
 assert.ok(start>=0&&end>start);vm.runInContext(toggle+'\n'+source.slice(start,end),context);
 const input=()=>nodes.get('#rowLaunchAtLogin').querySelector('.switch').querySelector('input');
 assert.equal(input().disabled,true);
 await vm.runInContext('loadLoginItemSettings()',context);assert.equal(input().disabled,false);
 input().checked=true;await input().onchange();
 assert.equal(input().checked,true);assert.equal(nodes.get('#launchAtLoginSettings').hidden,false);
 assert.match(nodes.get('#launchAtLoginNote').textContent,/需要/);
 await nodes.get('#launchAtLoginSettings').onclick();assert.equal(calls.at(-1).body.openSettings,true);
 state='enabled';listeners.get('focus')();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes.get('#launchAtLoginSettings').hidden,true,'从系统设置回来后应更新授权状态');
 broken=true;input().checked=false;await input().onchange();
 assert.equal(input().checked,true);assert.match(nodes.get('#launchAtLoginNote').textContent,/保存失败/);broken=false;
 readLater=new Promise(resolve=>{releaseRead=resolve;});
 const stale=vm.runInContext('loadLoginItemSettings()',context);
 input().checked=false;await input().onchange();
 releaseRead(snapshot('enabled'));await stale;
 assert.equal(input().checked,false,'保存后迟到的旧查询不能重新开启开关');
});

test('通用设置入口：登录项与外观、awake 设置分别放置',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const settings=html.slice(html.indexOf('id="settingsWorkspace"'));
 assert.match(settings,/data-settings-pane="general" aria-pressed="true"/);
 assert.match(settings,/<section class="settings-pane" data-pane="general">/);
 assert.match(settings,/id="rowLaunchAtLogin"/);
 assert.match(settings,/<section class="settings-pane" data-pane="appearance" hidden>/);
 assert.equal((html.match(/id="rowLaunchAtLogin"/g)||[]).length,1);
});

test('通用设置：原生窗口从系统设置恢复时重新读取登录项',async()=>{
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const from=source.indexOf('let windowActive=true,'),to=source.indexOf('// 终端归属只在通知岛打开时扫描：',from);
 let reads=0;
 const context=vm.createContext({window:{},document:{hidden:false,body:{classList:{toggle(){}}}},islandView:'settings',settingsPane:'general',loadLoginItemSettings(){reads++;},startAppPolling(){},stopAppPolling(){},islandClose(){},usageClose(){},deviceClose(){},syncProcessPolling(){}});
 vm.runInContext(source.slice(from,to),context);
 context.window.__boboSetWindowActive(false);assert.equal(reads,0);
 context.window.__boboSetWindowActive(true);assert.equal(reads,1);
 context.islandView='agents';context.window.__boboSetWindowActive(false);context.window.__boboSetWindowActive(true);
 assert.equal(reads,1,'其它页面恢复时不启动登录项查询');
});

test('登录项 Swift：注入系统接口验证幂等、待允许和失败，不修改真实登录项', {skip:process.platform!=='darwin',timeout:60000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-login-item-'));
 try{
  const main=path.join(dir,'probe.swift'),binary=path.join(dir,'probe');
  await fs.writeFile(main,`import Foundation
@main enum Probe {
 static func main() throws {
  var state = BoboLoginState.notRegistered, registered = 0, unregistered = 0, opened = 0
  var fail = false
  var env = BoboLoginEnvironment()
  env.status = { state }
  env.register = { if fail { throw NSError(domain: "fixture", code: 1) }; registered += 1; state = .enabled }
  env.unregister = { unregistered += 1; state = .notRegistered }
  env.openSettings = { opened += 1 }
  let initial = try BoboLoginItem.perform("status", environment: env)
  precondition(!initial.enabled && !initial.registered && initial.supported)
  _ = try BoboLoginItem.perform("enable", environment: env)
  _ = try BoboLoginItem.perform("enable", environment: env)
  precondition(registered == 1)
  _ = try BoboLoginItem.perform("disable", environment: env)
  _ = try BoboLoginItem.perform("disable", environment: env)
  precondition(unregistered == 1)
  state = .requiresApproval
  let waiting = try BoboLoginItem.perform("enable", environment: env)
  precondition(waiting.registered && waiting.requiresApproval && !waiting.enabled && registered == 1)
  _ = try BoboLoginItem.perform("settings", environment: env)
  precondition(opened == 1)
  _ = try BoboLoginItem.perform("disable", environment: env)
  precondition(unregistered == 2)
  fail = true
  do { _ = try BoboLoginItem.perform("enable", environment: env); fatalError() } catch {}
  precondition(state == .notRegistered)
  let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(waiting)) as! [String: Any]
  precondition(json["requiresApproval"] as? Bool == true)
  state = .notFound
  precondition(!BoboLoginSnapshot(state).supported)
  precondition(BoboLoginItem.runIfRequested([]) == nil)
  print("登录项核心验证通过")
 }
}`);
  await run('/usr/bin/xcrun',['swiftc',path.resolve('macos/LoginItem.swift'),main,'-o',binary,'-framework','ServiceManagement'],{timeout:45000,maxBuffer:1024*1024});
  assert.match((await run(binary,[],{timeout:5000})).stdout,/验证通过/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
