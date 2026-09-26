// 应用内更新：检查 GitHub Release → 下载 bobo.app.zip → sha256 校验 → ditto 解压暂存到
// ~/.bobo/updates/staged/ → 一键重启（退出 bobo、替换 app、重新打开）。
// 替换由独立的重启脚本在应用退出后完成：失败保留暂存包与日志，并能回滚旧包。
// 本地开发（不是从 .app 运行）不提供应用内更新，仍走 ./update.sh；v2（Tauri 壳）走自己的更新体系。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const repo='ohmyangboy/bobo',bundleId='local.bobo.app';
// 发布包的签名团队（Developer ID Application: Yonghao Yang）；应用内更新只接受这个团队的签名。
export const teamId='LGKLTGNTY2';
export const repoUrl='https://github.com/'+repo,releasesUrl=repoUrl+'/releases',releaseApi='https://api.github.com/repos/'+repo+'/releases/latest';
const assetName='bobo.app.zip',minAssetSize=1024*1024,checkDelayMs=3000,checkIntervalMs=10*60*1000,autoCheckMinMs=5*60*1000,retryMs=5*60*1000;
const here=path.dirname(fileURLToPath(import.meta.url));
// codesign 的诊断信息走 stderr，这里合并输出，调用方拿到的就是完整文本。
const run=(file,args)=>new Promise((resolve,reject)=>{execFile(file,args,{maxBuffer:1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(String(stdout||'')+String(stderr||'')));});

// package.json 是版本唯一真源：dev 在项目根，App 包与 v2 runtime 都放在模块的上一级。
export async function readPackage(){return JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));}

// 语义化版本：返回 {core:[major,minor,patch],pre:[...]}；认不出来返回 null。
export function parseVersion(value){
 const m=String(value??'').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
 return m?{core:[Number(m[1]),Number(m[2]),Number(m[3])],pre:m[4]?m[4].split('.'):[]}:null;
}
// 返回 >0 表示 candidate 比 current 新；无法解析返回 null（与 lives 的 isVersion 同语义）。
export function compareVersions(candidate,current){
 const a=parseVersion(candidate),b=parseVersion(current);
 if(!a||!b)return null;
 for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return a.core[i]-b.core[i];
 if(!a.pre.length||!b.pre.length)return Number(!a.pre.length)-Number(!b.pre.length);
 for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
  const x=a.pre[i],y=b.pre[i];
  if(x===undefined)return -1;if(y===undefined)return 1;
  if(x===y)continue;
  const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);
  if(xn&&yn)return Number(x)-Number(y);
  if(xn!==yn)return xn?-1:1;
  return x<y?-1:1;
 }
 return 0;
}

// 从 GitHub Release 挑出可安装的候选：正式版、版本比当前新、带 bobo.app.zip 且有 sha256 digest 与大小。
export function releaseCandidate(json,currentVersion){
 if(!json||json.draft===true||json.prerelease===true)return null;
 const version=String(json.tag_name||'').replace(/^v/i,'');
 const comparison=compareVersions(version,currentVersion);
 if(comparison===null||comparison<=0)return null;
 const asset=(Array.isArray(json.assets)?json.assets:[]).find(a=>a&&a.name===assetName);
 if(!asset||typeof asset.browser_download_url!=='string')return null;
 const sha256=String(asset.digest||'').replace(/^sha256:/i,'').trim().toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(sha256))return null;
 if(!Number.isSafeInteger(asset.size)||asset.size<minAssetSize)return null;
 return {
  version,displayVersion:'v'+version,
  notes:typeof json.body==='string'?json.body.trim():'',
  htmlUrl:typeof json.html_url==='string'?json.html_url:releasesUrl,
  publishedAt:typeof json.published_at==='string'?json.published_at:'',
  asset:{url:asset.browser_download_url,size:asset.size,sha256,name:assetName},
 };
}

// 从进程启动路径定位正在运行的 App bundle（/Applications/bobo.app/Contents/Resources/src/server.mjs → /Applications/bobo.app）。
export function appBundlePath(argv1){
 if(typeof argv1!=='string')return null;
 const m=argv1.match(/^(.*?\.app)(?:\/|$)/);
 return m?m[1]:null;
}

// Info.plist 的最小读取：只认 <key>…</key><string>…</string> 这种固定写法。
export function plistValue(text,key){
 const m=String(text).match(new RegExp('<key>'+key+'</key>\\s*<string>([^<]*)</string>'));
 return m?m[1]:null;
}

// 重启安装脚本（纯函数，便于审查与测试）：退出旧应用 → 等 4318 释放 → 替换 → 打开并验证。
// 参数：1=日志 2=目标 app 3=暂存 app 4=更新目录。
export function relaunchScript(){
 return `#!/bin/sh
# bobo 应用内更新：等旧应用退出后替换安装包并重新打开（由 src/update.mjs 生成）。
LOG="$1"; TARGET="$2"; STAGED="$3"; UPDATES="$4"; APP_PID="$5"
log(){ printf '[%s] %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
fail(){ log "失败：$*"; log "暂存的应用保留在 $STAGED，可手动替换"; exit 1; }
[ -d "$STAGED/Contents/MacOS" ] || fail "暂存的应用不完整"
log "=== 开始安装（脚本 $$）target=$TARGET app_pid=$APP_PID ==="

# 1. 退出旧应用：先请它自己退出（能触发 applicationWillTerminate 收尾、停掉本地服务），
#    1 秒内没退就直接 SIGTERM，再等 3 秒不退就 SIGKILL——osascript 受「自动化」权限限制，不能只靠它。
[ -n "$APP_PID" ] || APP_PID="$(pgrep -x Bobo 2>/dev/null | head -1 || true)"
if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
 log "请求应用退出"
 osascript -e 'tell application id "${bundleId}" to quit' >>"$LOG" 2>&1 || true
 COUNT=0
 while kill -0 "$APP_PID" 2>/dev/null && [ "$COUNT" -lt 5 ]; do sleep 0.2; COUNT=$((COUNT+1)); done
 if kill -0 "$APP_PID" 2>/dev/null; then
  log "应用未响应，发送 SIGTERM"
  kill -TERM "$APP_PID" 2>/dev/null || true
  COUNT=0
  while kill -0 "$APP_PID" 2>/dev/null && [ "$COUNT" -lt 15 ]; do sleep 0.2; COUNT=$((COUNT+1)); done
 fi
 if kill -0 "$APP_PID" 2>/dev/null; then
  log "应用仍未退出，发送 SIGKILL"
  kill -9 "$APP_PID" 2>/dev/null || true
 fi
fi

# 2. 等 4318 释放：旧服务必须停，否则新版本会连上旧服务复用旧代码。
COUNT=0
while lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; do
 sleep 0.2; COUNT=$((COUNT+1))
 if [ "$COUNT" -eq 25 ]; then
  PIDS="$(lsof -tiTCP:4318 -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
 fi
 [ "$COUNT" -ge 40 ] && break
done

# 3. 替换：同卷 rename，失败回滚（~/Applications 兜底留给手动处理）。
xattr -cr "$STAGED" 2>>"$LOG" || true
if [ -d "$TARGET" ] && [ ! -w "$(dirname "$TARGET")" ]; then
 fail "没有写入 $TARGET 的权限，请把它移到 /Applications 后重试"
fi
OLD="$TARGET.old-$$"
if [ -d "$TARGET" ]; then
 mv "$TARGET" "$OLD" 2>>"$LOG" || fail "无法移动旧应用"
fi
if mv "$STAGED" "$TARGET" 2>>"$LOG"; then
 log "替换完成"
else
 [ -d "$OLD" ] && mv "$OLD" "$TARGET" 2>>"$LOG"
 fail "替换失败，已回滚旧应用"
fi

# 4. 打开并验证进程。
open "$TARGET" >>"$LOG" 2>&1 || fail "无法打开新应用"
COUNT=0
while [ "$COUNT" -lt 40 ]; do
 sleep 0.2; COUNT=$((COUNT+1))
 pgrep -x Bobo >/dev/null 2>&1 && break
done
if pgrep -x Bobo >/dev/null 2>&1; then
 log "成功：已启动 $TARGET"
 [ -d "$OLD" ] && rm -rf "$OLD" 2>>"$LOG"
 rm -rf "$UPDATES/staged" "$UPDATES/staged.json" "$UPDATES/$assetName" 2>>"$LOG"
 rm -f "$0" 2>/dev/null
 exit 0
fi
fail "已替换但新应用没有启动，请手动打开 $TARGET"
`;
}

export function createUpdate({home,now=Date.now,fetchImpl=fetch,exec=run,spawnImpl=spawn,argv1=process.argv[1]}={}){
 const updatesDir=path.join(home,'.bobo','updates'),stagedDir=path.join(updatesDir,'staged'),stagedApp=path.join(stagedDir,'bobo.app');
 const zipFile=path.join(updatesDir,assetName),manifestFile=path.join(updatesDir,'staged.json'),logFile=path.join(updatesDir,'relaunch.log');
 const appPath=appBundlePath(argv1);
 let version='0.0.0',build='0',canUpdate=false,lastCheck=null,retryNotBefore=0,closing=false;
 let state={kind:'idle'},timer=null,listeners=new Set();
 const emit=()=>{for(const listener of listeners){try{listener();}catch{}}};
 const publicState=()=>({...state});

 // 启动快照：应用信息 + 更新状态；版本读不到时保底 0.0.0（页面照常显示）。
 async function load(){
  try{
   const pkg=await readPackage();
   version=typeof pkg.version==='string'?pkg.version:version;
  }catch{}
  canUpdate=Boolean(appPath);
  // 构建编号在 App 包里读 Info.plist（构建脚本注入）；源码运行时没有。
  if(canUpdate){
   const info=await fs.readFile(path.join(appPath,'Contents/Info.plist'),'utf8').catch(()=>null);
   if(info)build=plistValue(info,'CFBundleVersion')||build;
  }
  // 上次下载好的更新（断点恢复：应用重启时若暂存仍在且版本更新，直接标 ready）。
  if(!canUpdate)return;
  try{
   const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
   const comparison=compareVersions(manifest?.version,version);
   if(comparison===null||comparison<=0)throw Error('stale');
   const info=await fs.readFile(path.join(stagedApp,'Contents/Info.plist'),'utf8').catch(()=>null);
   if(!info||plistValue(info,'CFBundleIdentifier')!==bundleId||plistValue(info,'CFBundleShortVersionString')!==manifest.version)throw Error('invalid');
   state={kind:'ready',release:{version:manifest.version,displayVersion:'v'+manifest.version,notes:manifest.notes||'',htmlUrl:manifest.htmlUrl||releasesUrl,publishedAt:manifest.publishedAt||'',asset:{url:manifest.url,size:manifest.size,sha256:manifest.sha256,name:assetName}},progress:1,resumed:true};
  }catch{await fs.rm(stagedDir,{recursive:true,force:true}).catch(()=>{});await fs.rm(manifestFile,{force:true}).catch(()=>{});}
 }

 // 启动后的静默检查；已暂存好更新就不打扰（等用户重启安装）。
 // 只在从 .app 运行时启用：源码 / 测试环境不自动联网，手动「检查更新」也不受影响（它是独立接口）。
 // 启动 3 秒后查一次，之后每 10 分钟一次；窗口重新打开也会请求检查，但共用 5 分钟间隔。
 function start(){
  if(timer||!canUpdate)return;
  timer=setTimeout(()=>{check({auto:true}).catch(()=>{});timer=setInterval(()=>{check({auto:true}).catch(()=>{});},checkIntervalMs);if(timer.unref)timer.unref();},checkDelayMs);
  if(timer.unref)timer.unref();
 }
 function stop(){if(timer){clearTimeout(timer);clearInterval(timer);timer=null;}}

 // 检查更新。auto（静默轮询）会尊重 1 小时 TTL 与失败退避；手动检查总是真的请求。
 async function check({auto=false}={}){
  if(closing)return snapshot();
  if(state.kind==='checking'||state.kind==='downloading'||state.kind==='installing')return snapshot();
  if(state.kind==='ready')return snapshot();
  const at=now();
  if(auto&&((lastCheck!==null&&at-lastCheck<autoCheckMinMs)||at<retryNotBefore))return snapshot();
  lastCheck=at;
  state={kind:'checking'};emit();
  try{
   const response=await fetchImpl(releaseApi,{headers:{accept:'application/vnd.github+json','user-agent':'bobo-updater'},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(response.status===404){retryNotBefore=0;state={kind:'upToDate',checkedAt:at};emit();return snapshot();}
   if(!response.ok)throw Error('GitHub 返回 '+response.status+(response.status===403?'（接口限流，稍后再试）':''));
   const release=releaseCandidate(await response.json(),version);
   if(!release){retryNotBefore=0;state={kind:'upToDate',checkedAt:at};emit();return snapshot();}
   retryNotBefore=0;
   state={kind:'available',release};emit();
   download(release).catch(()=>{});
  }catch(e){
   retryNotBefore=now()+retryMs;
   state={kind:'failed',message:'检查更新失败：'+(e?.message||e),checkedAt:at};emit();
  }
  return snapshot();
 }

 // 下载 → 校验 → 解压暂存。任何一步失败都保住上一个可用状态（避免重试无从下手）。
 async function download(release){
  if(closing)return;
  state={kind:'downloading',progress:0,release};emit();
  const part=zipFile+'.part';
  try{
   await fs.mkdir(updatesDir,{recursive:true});
   const response=await fetchImpl(release.asset.url,{headers:{accept:'application/octet-stream','user-agent':'bobo-updater'},redirect:'follow',signal:AbortSignal.timeout(180000)});
   if(!response.ok)throw Error('下载返回 '+response.status);
   const total=release.asset.size,hash=createHash('sha256');
   let received=0,lastEmit=0;
   const handle=await fs.open(part,'w');
   try{
    for await(const chunk of response.body){
     hash.update(chunk);received+=chunk.length;await handle.write(chunk);
     const progress=Math.min(1,received/total);
     if(progress-lastEmit>=0.02||progress===1){lastEmit=progress;state={kind:'downloading',progress,release};emit();}
    }
   }finally{await handle.close();}
   if(received!==total)throw Error('下载大小不一致（预期 '+total+' 字节，实际 '+received+'）');
   const digest=hash.digest('hex');
   if(digest!==release.asset.sha256)throw Error('安装包 sha256 校验失败');
   await fs.rename(part,zipFile);
   // 解压到 staged/：ditto 保留 bundle 结构与扩展属性。
   await fs.rm(stagedDir,{recursive:true,force:true});
   await fs.mkdir(stagedDir,{recursive:true});
   await exec('ditto',['-x','-k',zipFile,stagedDir]);
   const info=await fs.readFile(path.join(stagedApp,'Contents/Info.plist'),'utf8').catch(()=>null);
   const stagedVersion=info?plistValue(info,'CFBundleShortVersionString'):null;
   if(!info||plistValue(info,'CFBundleIdentifier')!==bundleId)throw Error('更新包不是 bobo 应用');
   if(stagedVersion!==release.version)throw Error('更新包版本不匹配（预期 '+release.version+'，实际 '+(stagedVersion||'未知')+'）');
   // 代码签名校验：只接受同一开发者（Developer ID）签名且签名有效的更新包。
   const verified=await exec('codesign',['--verify','--deep','--strict',stagedApp]).then(()=>true,()=>false);
   if(!verified)throw Error('更新包的代码签名校验失败');
   const signature=await exec('codesign',['-dv','--verbose=4',stagedApp]).catch(()=> '');
   if(!new RegExp('TeamIdentifier='+teamId).test(String(signature)))throw Error('更新包不是预期的开发者签名，已拒绝安装');
   await fs.writeFile(manifestFile,JSON.stringify({version:release.version,url:release.asset.url,size:release.asset.size,sha256:release.asset.sha256,notes:release.notes,htmlUrl:release.htmlUrl,publishedAt:release.publishedAt,downloadedAt:new Date(now()).toISOString()},null,1));
   state={kind:'ready',release,progress:1};emit();
  }catch(e){
   await fs.rm(part,{force:true}).catch(()=>{});
   state={kind:'failed',message:'更新下载失败：'+(e?.message||e),release,checkedAt:now()};emit();
  }
 }

 // 一键重启安装：写好脚本后交给独立进程执行，应用随即退出（脚本会等它退干净再替换）。
 async function install(){
  if(state.kind!=='ready')throw Object.assign(Error('没有已下载好的更新'),{status:409});
  if(!appPath)throw Object.assign(Error('当前不是从应用包运行，无法应用内更新'),{status:409});
  // 暂存包可能被系统清理：先确认它还在，避免脚本启动后立刻失败、应用卡在「正在重启」。
  const stagedOk=await fs.access(stagedApp).then(()=>true,()=>false);
  if(!stagedOk){
   state={kind:'failed',message:'更新包已不存在，请重新检查更新',checkedAt:now()};emit();
   throw Object.assign(Error('更新包已不存在，请重新检查更新'),{status:409});
  }
  const scriptFile=path.join(updatesDir,'relaunch.sh');
  await fs.mkdir(updatesDir,{recursive:true});
  await fs.writeFile(scriptFile,relaunchScript(),{mode:0o755});
  // 把应用进程号交给脚本：优先请应用自己退出（AppleScript），1 秒内没退就直接 SIGTERM。
  const appPid=process.ppid>1?String(process.ppid):'';
  const child=spawnImpl('/bin/sh',[scriptFile,logFile,appPath,stagedApp,updatesDir,appPid],{detached:true,stdio:'ignore'});
  if(child.unref)child.unref();
  closing=true;
  state={kind:'installing',release:state.release};emit();
  // 看门狗：正常情况下脚本几秒内就让应用退出（进程随之结束）；40 秒还在说明脚本失败，恢复成可重试。
  const watchdog=setTimeout(()=>{
   if(state.kind!=='installing')return;
   closing=false;
   state={kind:'ready',release:state.release,progress:1};emit();
  },40000);
  if(watchdog.unref)watchdog.unref();
  return snapshot();
 }

 function snapshot(){return {version,build,repo,repoUrl,releasesUrl,appPath:canUpdate?appPath:null,canUpdate,state:publicState()};}
 function subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
 return {load,start,stop,check,install,snapshot,subscribe};
}
