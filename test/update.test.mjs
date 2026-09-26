import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {compareVersions,parseVersion,releaseCandidate,appBundlePath,plistValue,relaunchScript,createUpdate,readPackage,repoUrl,bundleId} from '../src/update.mjs';

// 当前版本从 package.json 读（版本唯一真源），测试里的「新版本」永远比它大一个 patch。
const currentVersion=(await readPackage()).version;
const nextVersion=currentVersion.replace(/\.(\d+)$/,(_,n)=>'.'+(Number(n)+1));
// 发布流的 exec 替身：ditto 解压出 Info.plist，codesign 返回签名诊断（可按需改签名团队 / 让校验失败）。
const makeExec=({team='LGKLTGNTY2',valid=true,version=nextVersion}={})=>async(file,args)=>{
 if(file==='ditto'){
  const app=path.join(args[3],'bobo.app');
  await fs.mkdir(path.join(app,'Contents'),{recursive:true});
  await fs.writeFile(path.join(app,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>'+version+'</string>');
  return '';
 }
 if(file==='codesign'){
  if(args[0]==='--verify'){if(!valid)throw Error('invalid signature');return 'valid';}
  return 'Authority=Developer ID Application: Yonghao Yang ('+team+')\nTeamIdentifier='+team;
 }
 throw Error('未预期的命令：'+file+' '+args.join(' '));
};

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

test('自动检查：窗口恢复遵守五分钟间隔，手动检查仍立即请求',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 let clock=Date.parse('2026-09-26T00:00:00Z'),calls=0;
 const update=createUpdate({home,now:()=>clock,argv1:path.join(home,'Applications/bobo.app/Contents/Resources/src/server.mjs'),fetchImpl:async()=>{
  calls++;
  return {status:200,ok:true,json:async()=>({tag_name:'v'+currentVersion,draft:false,prerelease:false,assets:[]})};
 }});
 try{
  await update.load();
  await update.check({auto:true});assert.equal(calls,1,'首次自动检查立即执行');
  clock+=4*60*1000;
  await update.check({auto:true});assert.equal(calls,1,'短时间内重复打开窗口不重复请求');
  clock+=60*1000;
  await update.check({auto:true});assert.equal(calls,2,'五分钟后重新检查');
  await update.check();assert.equal(calls,3,'用户点击按钮不受自动间隔限制');
 }finally{update.stop();await fs.rm(home,{recursive:true,force:true});}
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
 assert.match(script,/APP_PID="\$5"/);
 assert.match(script,/osascript -e 'tell application id "local\.bobo\.app" to quit'/);
 assert.match(script,/kill -TERM "\$APP_PID"/);
 assert.match(script,/kill -9 "\$APP_PID"/);
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
  const release={tag_name:'v'+nextVersion,html_url:repoUrl+'/releases/tag/v'+nextVersion,body:'更新说明',published_at:'2026-09-20T00:00:00Z',draft:false,prerelease:false,
   assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/bobo.app.zip',digest:'sha256:'+sha,size:zip.length}]};
  const urls=[];
  const fetchImpl=async url=>{
   urls.push(String(url));
   if(String(url).includes('/releases/latest'))return {status:200,ok:true,json:async()=>release};
   return {status:200,ok:true,body:(async function*(){yield zip;})()};
  };
  const exec=makeExec();
  const spawned=[];
  const spawnImpl=(file,args,opts)=>{spawned.push({file,args,opts});return {unref(){}};};
  const appDir=path.join(home,'Applications/bobo.app');
  const update=createUpdate({home,fetchImpl,exec,spawnImpl,argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await update.load();
  const initial=update.snapshot();
  assert.equal(initial.canUpdate,true);
  assert.equal(initial.version,currentVersion);
  assert.equal(initial.state.kind,'idle');
  await update.check();
  for(let i=0;i<300&&update.snapshot().state.kind!=='ready';i++)await new Promise(r=>setTimeout(r,10));
  const ready=update.snapshot().state;
  assert.equal(ready.kind,'ready');
  assert.equal(ready.release.version,nextVersion);
  assert.equal(ready.progress,1);
  assert.deepEqual(urls,[
   'https://api.github.com/repos/ohmyangboy/bobo/releases/latest',
   'https://example.com/bobo.app.zip',
  ]);
  const manifest=JSON.parse(await fs.readFile(path.join(home,'.bobo/updates/staged.json'),'utf8'));
  assert.equal(manifest.version,nextVersion);
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
   String(process.ppid),
  ]);
  assert.equal(spawned[0].opts.detached,true);
  const script=await fs.readFile(spawned[0].args[0],'utf8');
  assert.match(script,/local\.bobo\.app/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('更新包签名校验：不是预期开发者或签名无效时拒绝安装',async()=>{
 for(const exec of [makeExec({team:'BADSIGN'}),makeExec({valid:false})]){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
  try{
   const zip=Buffer.alloc(1024*1024+16,9);
   const sha=createHash('sha256').update(zip).digest('hex');
   const release={tag_name:'v'+nextVersion,html_url:repoUrl+'/releases/tag/v'+nextVersion,body:'',draft:false,prerelease:false,
    assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/bobo.app.zip',digest:'sha256:'+sha,size:zip.length}]};
   const fetchImpl=async url=>String(url).includes('/releases/latest')
    ?{status:200,ok:true,json:async()=>release}
    :{status:200,ok:true,body:(async function*(){yield zip;})()};
   const appDir=path.join(home,'Applications/bobo.app');
   const update=createUpdate({home,fetchImpl,exec,spawnImpl:()=>({unref(){}}),argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
   await update.load();
   await update.check();
   for(let i=0;i<300&&!['ready','failed'].includes(update.snapshot().state.kind);i++)await new Promise(r=>setTimeout(r,10));
   const state=update.snapshot().state;
   assert.equal(state.kind,'failed');
   assert.match(state.message,/签名/);
  }finally{await fs.rm(home,{recursive:true,force:true});}
 }
});

test('重启安装前校验暂存包：已被清理时拒绝并给出可重试状态',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 try{
  const zip=Buffer.alloc(1024*1024+16,3);
  const sha=createHash('sha256').update(zip).digest('hex');
  const release={tag_name:'v'+nextVersion,html_url:repoUrl+'/releases/tag/v'+nextVersion,body:'',draft:false,prerelease:false,
   assets:[{name:'bobo.app.zip',browser_download_url:'https://example.com/bobo.app.zip',digest:'sha256:'+sha,size:zip.length}]};
  const fetchImpl=async url=>String(url).includes('/releases/latest')
   ?{status:200,ok:true,json:async()=>release}
   :{status:200,ok:true,body:(async function*(){yield zip;})()};
  const appDir=path.join(home,'Applications/bobo.app');
  const spawned=[];
  const update=createUpdate({home,fetchImpl,exec:makeExec(),spawnImpl:(file,args,opts)=>{spawned.push({file,args,opts});return {unref(){}};},argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await update.load();
  await update.check();
  for(let i=0;i<300&&update.snapshot().state.kind!=='ready';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(update.snapshot().state.kind,'ready');
  // 模拟系统清理掉暂存目录后再点重启：应拒绝安装并给出可重试的失败状态，而不是卡在「正在重启」。
  await fs.rm(path.join(home,'.bobo/updates/staged'),{recursive:true,force:true});
  await assert.rejects(update.install(),/更新包已不存在/);
  assert.equal(spawned.length,0);
  assert.equal(update.snapshot().state.kind,'failed');
  assert.match(update.snapshot().state.message,/更新包已不存在/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('断点恢复：重启后暂存仍在且版本更新时直接标记可安装',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-update-'));
 try{
  const appDir=path.join(home,'Applications/bobo.app');
  const stagedApp=path.join(home,'.bobo/updates/staged/bobo.app');
  await fs.mkdir(path.join(stagedApp,'Contents'),{recursive:true});
  await fs.writeFile(path.join(stagedApp,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>'+nextVersion+'</string>');
  await fs.writeFile(path.join(home,'.bobo/updates/staged.json'),JSON.stringify({version:nextVersion,url:'https://example.com/bobo.app.zip',size:2*1024*1024,sha256:'b'.repeat(64),notes:'说明',htmlUrl:repoUrl+'/releases/tag/v'+nextVersion,publishedAt:'2026-09-20T00:00:00Z'}));
  const update=createUpdate({home,fetchImpl:async()=>{throw Error('不该联网');},exec:async()=>'',spawnImpl:()=>({unref(){}}),argv1:path.join(appDir,'Contents/Resources/src/server.mjs')});
  await update.load();
  const state=update.snapshot().state;
  assert.equal(state.kind,'ready');
  assert.equal(state.resumed,true);
  assert.equal(state.release.version,nextVersion);
  // 暂存版本不比当前新时清掉残留。
  await fs.writeFile(path.join(home,'.bobo/updates/staged.json'),JSON.stringify({version:'0.0.1',url:'x',size:1,sha256:'c'.repeat(64)}));
  await fs.writeFile(path.join(stagedApp,'Contents/Info.plist'),'<key>CFBundleIdentifier</key><string>'+bundleId+'</string><key>CFBundleShortVersionString</key><string>0.0.1</string>');
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
  assert.equal(update.snapshot().version,currentVersion);
  const after=await update.check();
  assert.equal(after.state.kind,'failed');
  assert.match(after.state.message,/检查更新失败/);
  await assert.rejects(update.install(),/没有已下载好的更新|无法应用内更新/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('版本真源：读到的 package.json 版本就是 package.json 的 version',async()=>{
 const pkg=await readPackage();
 // 正式版是 x.y.z；beta 轮次带预发布后缀（1.3.0-beta.1），语义化版本比较照样认（见 parseVersion）。
 assert.match(pkg.version,/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
