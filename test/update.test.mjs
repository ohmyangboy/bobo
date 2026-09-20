import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {compareVersions,parseVersion,releaseCandidate,appBundlePath,plistValue,relaunchScript,createUpdate,readPackage,repoUrl,bundleId} from '../src/update.mjs';

test('语义化版本：比较、预发布与无法解析的返回 null',()=>{
 assert.equal(compareVersions('1.2.1','1.2.0'),1);
 assert.equal(compareVersions('1.2.0','1.2.1'),-1);
 assert.equal(compareVersions('v1.2.0','1.2.0'),0);
 assert.equal(compareVersions('2.0.0','1.9.9'),1);
 assert.equal(compareVersions('1.2.0-beta.1','1.2.0'),-1);
 assert.equal(compareVersions('1.2.0','1.2.0-beta.1'),1);
 assert.equal(compareVersions('1.2.0-beta.2','1.2.0-beta.1'),1);
 assert.equal(compareVersions('1.2.0-beta.10','1.2.0-beta.9'),1);
 assert.equal(compareVersions('1.2','1.2.0'),null);
 assert.equal(compareVersions('开发版','1.0.0'),null);
 assert.deepEqual(parseVersion('v1.2.3-beta.4+ci'),{core:[1,2,3],pre:['beta','4']});
});

test('发布候选：只接受正式版、更高版本、带 sha256 的 bobo.app.zip',()=>{
 const base={tag_name:'v1.3.0',html_url:repoUrl+'/releases/tag/v1.3.0',body:'说明',published_at:'2026-09-20T00:00:00Z',draft:false,prerelease:false,
  assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/bobo.app.zip',digest:'sha256:'+'a'.repeat(64),size:2*1024*1024}]};
 const pick=releaseCandidate(base,'1.2.0');
 assert.equal(pick.version,'1.3.0');
 assert.equal(pick.displayVersion,'v1.3.0');
 assert.equal(pick.asset.sha256,'a'.repeat(64));
 assert.equal(pick.notes,'说明');
 assert.equal(releaseCandidate({...base,tag_name:'v1.2.0'},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,tag_name:'v1.1.9'},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,prerelease:true},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,draft:true},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,assets:[{name:'bobo.dmg',browser_download_url:'https://example.com/a',digest:'sha256:'+'a'.repeat(64),size:2*1024*1024}]},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/a',size:2*1024*1024}]},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/a',digest:'sha256:'+'a'.repeat(64),size:10}]},'1.2.0'),null);
 assert.equal(releaseCandidate({...base,tag_name:'最新'},'1.2.0'),null);
});

test('定位 App 与读 plist：只认 .app 路径段',()=>{
 assert.equal(appBundlePath('/Applications/bobo.app/Contents/Resources/src/server.mjs'),'/Applications/bobo.app');
 assert.equal(appBundlePath('/Users/x/bobo/src/server.mjs'),null);
 assert.equal(appBundlePath(undefined),null);
 assert.equal(plistValue('<key>CFBundleIdentifier</key><string>local.bobo.app</string>','CFBundleIdentifier'),'local.bobo.app');
 assert.equal(plistValue('<key>CFBundleIdentifier</key><string>local.bobo.app</string>','CFBundleVersion'),null);
});

test('重启脚本：退出应用、等端口释放、替换并回滚',()=>{
 const script=relaunchScript();
 assert.match(script,/^#!\/bin\/sh/);
 assert.match(script,/osascript -e 'tell application id "local\.bobo\.app" to quit'/);
 assert.match(script,/lsof -nP -iTCP:4318 -sTCP:LISTEN/);
 assert.match(script,/xattr -cr "\$STAGED"/);
 assert.match(script,/mv "\$STAGED" "\$TARGET"/);
 assert.match(script,/mv "\$OLD" "\$TARGET"/);
 assert.match(script,/pgrep -x Bobo/);
});

test('检查到安装全流程：下载校验、解压暂存、生成重启脚本',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 try{
  const zip=Buffer.alloc(1024*1024+16,7);
  const sha=createHash('sha256').update(zip).digest('hex');
  const release={tag_name:'v1.3.0',html_url:repoUrl+'/releases/tag/v1.3.0',body:'更新说明',published_at:'2026-09-20T00:00:00Z',draft:false,prerelease:false,
   assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/bobo.app.zip',digest:'sha256:'+sha,size:zip.length}]};
  const urls=[];
  const fetchImpl=async url=>{
   urls.push(String(url));
   if(String(url).includes('/releases/latest'))return {status:200,ok:true,json:async()=>release};
   return {status:200,ok:true,body:(async function*(){yield zip;})()};
  };
  const exec=async(file,args)=>{
   assert.equal(file,'ditto');
   const app=path.join(args[3],'bobo.app');
   await fs.mkdir(path.join(app,'Contents'),{recursive:true});
   await fs.writeFile(path.join(app,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>1.3.0</string>');
   return '';
  };
  const spawned=[];
  const spawnImpl=(file,args,opts)=>{spawned.push({file,args,opts});return {unref(){}};};
  const appDir=path.join(home,'Applications/bobo.app');
  const update=createUpdate({home,fetchImpl,exec,spawnImpl,argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await update.load();
  const initial=update.snapshot();
  assert.equal(initial.canUpdate,true);
  assert.equal(initial.version,'1.2.0');
  assert.equal(initial.state.kind,'idle');
  await update.check();
  for(let i=0;i<300&&update.snapshot().state.kind!=='ready';i++)await new Promise(r=>setTimeout(r,10));
  const ready=update.snapshot().state;
  assert.equal(ready.kind,'ready');
  assert.equal(ready.release.version,'1.3.0');
  assert.equal(ready.progress,1);
  assert.deepEqual(urls,[
   'https://api.github.com/repos/ohmyangboy/bobo/releases/latest',
   'https://example.com/bobo.app.zip',
  ]);
  const manifest=JSON.parse(await fs.readFile(path.join(home,'.bobo/updates/staged.json'),'utf8'));
  assert.equal(manifest.version,'1.3.0');
  assert.equal(manifest.sha256,sha);
  await update.install();
  assert.equal(update.snapshot().state.kind,'installing');
  assert.equal(spawned.length,1);
  assert.equal(spawned[0].file,'/bin/sh');
  assert.deepEqual(spawned[0].args.slice(1),[
   path.join(home,'.bobo/updates/relaunch.log'),
   appDir,
   path.join(home,'.bobo/updates/staged/bobo.app'),
   path.join(home,'.bobo/updates'),
  ]);
  assert.equal(spawned[0].opts.detached,true);
  const script=await fs.readFile(spawned[0].args[0],'utf8');
  assert.match(script,/local\.bobo\.app/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('断点恢复：重启后暂存仍在且版本更新时直接标记可安装',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 try{
  const appDir=path.join(home,'Applications/bobo.app');
  const stagedApp=path.join(home,'.bobo/updates/staged/bobo.app');
  await fs.mkdir(path.join(stagedApp,'Contents'),{recursive:true});
  await fs.writeFile(path.join(stagedApp,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>1.4.0</string>');
  await fs.writeFile(path.join(home,'.bobo/updates/staged.json'),JSON.stringify({version:'1.4.0',url:'https://example.com/bobo.app.zip',size:2*1024*1024,sha256:'b'.repeat(64),notes:'说明',htmlUrl:repoUrl+'/releases/tag/v1.4.0',publishedAt:'2026-09-20T00:00:00Z'}));
  const update=createUpdate({home,fetchImpl:async()=>{throw Error('不该联网');},exec:async()=>'',spawnImpl:()=>({unref(){}}),argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await update.load();
  const state=update.snapshot().state;
  assert.equal(state.kind,'ready');
  assert.equal(state.resumed,true);
  assert.equal(state.release.version,'1.4.0');
  // 暂存版本不比当前新时清掉残留。
  await fs.writeFile(path.join(home,'.bobo/updates/staged.json'),JSON.stringify({version:'1.2.0',url:'x',size:1,sha256:'c'.repeat(64)}));
  await fs.writeFile(path.join(stagedApp,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>1.2.0</string>');
  const stale=createUpdate({home,fetchImpl:async()=>{throw Error('不该联网');},exec:async()=>'',spawnImpl:()=>({unref(){}}),argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await stale.load();
  assert.equal(stale.snapshot().state.kind,'idle');
  await assert.rejects(fs.access(stagedApp));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('源码运行不提供应用内更新；检查失败进入 failed 并可重试',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 try{
  const update=createUpdate({home,fetchImpl:async()=>{throw Error('连接失败');},exec:async()=>'',spawnImpl:()=>({unref(){}}),argv1:path.join(home,'bobo/src/server.mjs')});
  await update.load();
  assert.equal(update.snapshot().canUpdate,false);
  assert.equal(update.snapshot().version,'1.2.0');
  const after=await update.check();
  assert.equal(after.state.kind,'failed');
  assert.match(after.state.message,/检查更新失败/);
  await assert.rejects(update.install(),/没有已下载好的更新|无法应用内更新/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('版本真源：读到的 package.json 版本就是 package.json 的 version',async()=>{
 const pkg=await readPackage();
 assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
});
