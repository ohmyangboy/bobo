// 用量：两家额度。Codex 读 ~/.codex/auth.json 的 OAuth token，调 chatgpt.com 的
// /backend-api/wham/usage，按 limit_window_seconds 归类窗口（18000 秒 = 5 小时、604800 秒 = 一周，
// 与 CodexBar 的 CodexRateWindowNormalizer 一致）；OpenCode Go 读
// ~/.local/share/opencode/opencode.db 里 opencode-go 的费用，按 CodexBar 的 12 / 30 / 60 美元口径估算。
// Codex 走的是官方账号自己的接口、不改任何凭据；本地库只读（没有 sidecar 时用 immutable 直读，不创建文件）。
import fs from 'node:fs/promises';
import path from 'node:path';

export const limits={session:12,week:30,month:60};
export const providers=[
 {id:'codex',name:'Codex',symbol:'sparkles'},
 {id:'opencode-go',name:'OpenCode Go',symbol:'terminal'},
];
const codexUsageURL='https://chatgpt.com/backend-api/wham/usage';
const opencodeUsageURL='https://opencode.ai/zen/go/v1/usage';
const sessionSeconds=5*3600,weekSeconds=7*86400,dayMs=24*60*60*1000,historyDays=30;
const tickMs=60000,netIntervalMs=180000,netHardMinMs=60000,codexTimeoutMs=10000;
// 读取连续失败时的重试退避：2 / 4 / 8 / 10 分钟（封顶），成功后清零（见 refresh）。
const backoffMaxMs=600000;
// 步骤级费用：取 opencode-go 的助手消息，有 step-finish 分片时按分片累加，否则回退到消息级 cost
// （与 CodexBar 的 message+part 联合查询一致，避免一条消息里的多次调用被合并或漏算）。
const usageSQL=`WITH m AS (
  SELECT id,CAST(COALESCE(json_extract(data,'$.time.created'),time_created) AS INTEGER) createdMs,
         CAST(json_extract(data,'$.cost') AS REAL) cost,
         json_type(data,'$.cost') IN ('integer','real') hasCost,
         COALESCE(json_extract(data,'$.modelID'),'') model
  FROM message
  WHERE json_valid(data) AND json_extract(data,'$.providerID')='opencode-go' AND json_extract(data,'$.role')='assistant'
)
SELECT createdMs,cost,model FROM (
  SELECT CAST(COALESCE(json_extract(p.data,'$.time.created'),m.createdMs) AS INTEGER) createdMs,
         CAST(json_extract(p.data,'$.cost') AS REAL) cost,m.model AS model
  FROM part p JOIN m ON m.id=p.message_id
  WHERE json_valid(p.data) AND json_extract(p.data,'$.type')='step-finish' AND json_type(p.data,'$.cost') IN ('integer','real')
  UNION ALL
  SELECT m.createdMs,m.cost,m.model FROM m WHERE m.hasCost AND NOT EXISTS (
    SELECT 1 FROM part p WHERE p.message_id=m.id AND json_valid(p.data)
      AND json_extract(p.data,'$.type')='step-finish' AND json_type(p.data,'$.cost') IN ('integer','real'))
) WHERE createdMs>0 AND cost>=0;`;
const pad=n=>String(n).padStart(2,'0');
const userError=message=>Object.assign(Error(message),{userFacing:true});
const describe=(e,prefix)=>e?.userFacing?e.message:prefix+(e?.message||e);
// 周窗口固定用 UTC 周（周一开头），与 CodexBar 一致：本地日历周会在周一凌晨产生歧义。
function utcWeek(nowMs){const d=new Date(nowMs),start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-((d.getUTCDay()+6)%7));return {startMs:start,endMs:start+7*dayMs};}
// 账单月：把「最早一条用量记录」的日/时/分/秒当作锚点，取锚点在当前月（或上月）的时刻到下一次同锚点时刻。
function anchorMonth(year,month,anchor){const y=year+Math.floor(month/12),m=((month%12)+12)%12,last=new Date(Date.UTC(y,m+1,0)).getUTCDate();return Date.UTC(y,m,Math.min(anchor.day,last),anchor.hour,anchor.minute,anchor.second,anchor.ms);}
function monthBounds(nowMs,anchorMs){
 const a=new Date(anchorMs),n=new Date(nowMs),anchor={day:a.getUTCDate(),hour:a.getUTCHours(),minute:a.getUTCMinutes(),second:a.getUTCSeconds(),ms:a.getUTCMilliseconds()};
 const year=n.getUTCFullYear();let month=n.getUTCMonth(),start=anchorMonth(year,month,anchor);
 if(start>nowMs)start=anchorMonth(year,--month,anchor);
 return {startMs:start,endMs:anchorMonth(year,month+1,anchor)};
}
// 每日历史按设备本地日历分桶（和 CodexBar 的天键一致），跨时区时「今天」就是用户看到的今天。
const dayKey=ms=>{const d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};
const roundUSD=v=>Math.round(v*10000)/10000;
const round10=v=>Math.round(v*10)/10;
const clampPercent=v=>Math.min(100,Math.max(0,round10(v)));
// base64url 的 JWT 载荷；解析失败一律当作没有（token 可能是不透明的 PAT）。
function jwtPayload(token){
 if(typeof token!=='string')return null;
 const parts=token.split('.');
 if(parts.length!==3||!parts[1])return null;
 try{return JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));}catch{return null;}
}
function jwtAccountId(token){
 const payload=jwtPayload(token);
 if(!payload)return '';
 const direct=typeof payload.chatgpt_account_id==='string'?payload.chatgpt_account_id:'';
 const auth=payload['https://api.openai.com/auth'];
 if(direct)return direct;
 if(auth&&typeof auth.chatgpt_account_id==='string')return auth.chatgpt_account_id;
 const org=Array.isArray(payload.organizations)?payload.organizations.find(o=>typeof o?.id==='string'):null;
 return org?.id||'';
}
const jwtExpiration=token=>{const payload=jwtPayload(token),exp=Number(payload?.exp);return Number.isFinite(exp)?exp:0;};
// Codex 的窗口按 limit_window_seconds 归类；未知长度用出现顺序兜底，保证不丢数据。
const codexWindowKey=w=>{const s=Number(w.limit_window_seconds)||0;return s===sessionSeconds?'session':s===weekSeconds?'week':'other';};
const codexWindowLabel=w=>{const s=Number(w.limit_window_seconds)||0;return s===sessionSeconds?'5 小时滚动':s===weekSeconds?'本周':s>0?Math.round(s/3600)+' 小时窗口':'额度窗口';};
function codexWindow(w,nowMs,key,label){
 const usedPercent=clampPercent(Number(w.used_percent)||0);
 const resetAt=Number(w.reset_at)||0,after=Number(w.reset_after_seconds);
 const resetInSec=Math.max(0,Math.round(Number.isFinite(after)?after:resetAt-Math.floor(nowMs/1000)));
 return {key,label,usedUSD:null,limitUSD:null,usedPercent,remainingPercent:round10(100-usedPercent),resetInSec,resetsAt:resetAt?resetAt*1000:nowMs+resetInSec*1000,status:''};
}
function codexSnapshot(body,nowMs){
 const rate=body?.rate_limit||{},seen=new Set(),windows=[];
 for(const item of [{w:rate.primary_window,fallback:'session'},{w:rate.secondary_window,fallback:'week'}]){
  const w=item.w;
  if(!w||typeof w.used_percent!=='number')continue;
  const known=codexWindowKey(w),key=known!=='other'&&!seen.has(known)?known:(!seen.has(item.fallback)?item.fallback:'other');
  seen.add(key);
  windows.push(codexWindow(w,nowMs,key,codexWindowLabel(w)));
 }
 const credits=body?.credits&&typeof body.credits==='object'?{unlimited:body.credits.unlimited===true,hasCredits:body.credits.has_credits===true,balance:Number(body.credits.balance)||0}:null;
 return {id:'codex',name:'Codex',symbol:'sparkles',available:true,estimated:false,source:'api',keySource:'auth',keyHint:'',plan:typeof body?.plan_type==='string'?body.plan_type:'',credits,windows,error:null,updatedAt:nowMs};
}

export function createUsage({home,now=Date.now,fetchImpl=fetch,env=process.env,notify=null}={}){
 const dataDir=path.join(home,'.bobo'),settingsFile=path.join(dataDir,'usage.json');
 const opencodeDir=path.join(home,'.local/share/opencode'),dbFile=path.join(opencodeDir,'opencode.db'),authFile=path.join(opencodeDir,'auth.json');
 const codexDir=env.CODEX_HOME||path.join(home,'.codex');
 let sqlite=null,selected='',state=empty(),signature='',listeners=new Set(),timer=null,reading=null,closed=false;
 const cache=new Map(),backoff=new Map();
 // 持久化设置（~/.bobo/usage.json）：刘海显示哪家、各来源的启停、手动填的 API Key、额度重置提醒。
 const settings={keys:{},enabled:{},notifyReset:true};
 const isEnabled=id=>settings.enabled[id]!==false;
 function empty(){return {available:false,selected:providers[0].id,providers:providers.map(p=>({id:p.id,name:p.name,symbol:p.symbol,available:false,enabled:true,keySource:'',keyHint:'',reason:'正在读取用量…',windows:[],updatedAt:0})),updatedAt:0};}
 const emit=()=>{for(const listener of listeners){try{listener();}catch{}}};
 async function loadSettings(){
  try{
   const raw=JSON.parse(await fs.readFile(settingsFile,'utf8'));
   if(providers.some(p=>p.id===raw?.provider))selected=raw.provider;
   if(typeof raw?.notifyReset==='boolean')settings.notifyReset=raw.notifyReset;
   for(const p of providers){
    if(typeof raw?.enabled?.[p.id]==='boolean')settings.enabled[p.id]=raw.enabled[p.id];
    const key=raw?.keys?.[p.id];
    if(typeof key==='string'&&key.trim())settings.keys[p.id]=key.trim();
   }
  }catch{}
 }
 // 串行写盘（原子改名，避免半截 JSON）：连点切换时最后一次调用写入的就是当前选择。
 let saving=Promise.resolve();
 function saveSettings(){
  saving=saving.then(async()=>{try{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(settingsFile+'.tmp',JSON.stringify({provider:selected,enabled:settings.enabled,keys:settings.keys,notifyReset:settings.notifyReset},{},1),{mode:0o600});await fs.rename(settingsFile+'.tmp',settingsFile);}catch{}});
  return saving;
 }

 // ---- OpenCode Go：本机数据库（只读） ----
 async function readRows(){
  if(sqlite===null)sqlite=import('node:sqlite').then(m=>m).catch(()=>false);
  const mod=await sqlite;
  if(!mod)throw userError('当前 Node 版本不支持读取 SQLite 用量（需要 Node 22.13 及以上）');
  await fs.access(dbFile);
  const open=file=>new mod.DatabaseSync(file,{readOnly:true,timeout:250});
  const immutable='file:'+encodeURI(dbFile).replace(/[?#]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())+'?immutable=1';
  const sidecars=await Promise.all([dbFile+'-wal',dbFile+'-shm'].map(f=>fs.access(f).then(()=>true,()=>false)));
  let db;
  if(sidecars.some(Boolean))try{db=open(dbFile);}catch{db=open(immutable);}
  else db=open(immutable);
  try{return db.prepare(usageSQL).all();}finally{db.close();}
 }
 // API key：手动填写（~/.bobo/usage.json 的 keys.opencode-go）优先，其次是进程环境变量
 // OPENCODE_API_KEY（CodexBar 的顺序），最后才是 OpenCode CLI 自己的 auth.json（和终端登录共用）。
 async function opencodeKey(){
  if(settings.keys['opencode-go'])return {key:settings.keys['opencode-go'],keySource:'manual'};
  const raw=typeof env.OPENCODE_API_KEY==='string'?env.OPENCODE_API_KEY.trim().replace(/^["']|["']$/g,''):'';
  if(raw)return {key:raw,keySource:'env'};
  try{const auth=JSON.parse(await fs.readFile(authFile,'utf8'));const key=auth?.['opencode-go']?.key;if(typeof key==='string'&&key.trim())return {key:key.trim(),keySource:'auth'};}catch{}
  return {key:'',keySource:''};
 }
 // 官方用量接口（权威）：usage.{rolling,weekly,monthly}.percent 是「已用百分比」（与 CodexBar 的解析一致，
 // 用 rate-limited 状态佐证：100% 已用时才是 rate-limited），resetsAt 是 ISO 时间。
 async function readAPI(key,nowMs){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),codexTimeoutMs);
  let response;
  try{
   response=await fetchImpl(opencodeUsageURL,{headers:{authorization:'Bearer '+key,accept:'application/json','user-agent':'bobo'},redirect:'error',signal:controller.signal});
  }catch(e){throw userError('连接 opencode.ai 失败：'+(e?.cause?.message||e?.message||e));}
  finally{clearTimeout(timeout);}
  if(response.status===401||response.status===403)throw userError('OpenCode 用量接口拒绝了当前登录，请在终端重新 opencode auth login');
  if(!response.ok)throw userError('OpenCode 用量接口返回 '+response.status);
  let body;
  try{body=await response.json();}catch{throw userError('OpenCode 用量接口返回的不是 JSON');}
  const usage=body?.usage||{},windows=[];
  for(const [name,key,label] of [['rolling','session','5 小时滚动'],['weekly','week','本周'],['monthly','month','账单月']]){
   const w=usage[name];
   if(!w||typeof w.percent!=='number')continue;
   const usedPercent=clampPercent(w.percent),resetsAt=Date.parse(w.resetsAt||'')||0;
   const resetInSec=resetsAt?Math.max(0,Math.round((resetsAt-nowMs)/1000)):0;
   windows.push({key,label,usedUSD:null,limitUSD:null,usedPercent,remainingPercent:round10(100-usedPercent),resetInSec,resetsAt:resetsAt||nowMs+resetInSec*1000,status:typeof w.status==='string'?w.status:''});
  }
  if(!windows.length)throw userError('OpenCode 用量接口没有返回窗口数据');
  return windows;
 }
 function localSummary(list,nowMs){
  const week=utcWeek(nowMs),month=monthBounds(nowMs,list.length?Math.min(...list.map(r=>r.createdMs)):nowMs),sessionStart=nowMs-sessionSeconds*1000;
  let sessionCost=0,weekCost=0,monthCost=0,oldestSession=null,total=0;
  const since=new Date(nowMs);since.setDate(since.getDate()-(historyDays-1));
  const sinceStart=new Date(since.getFullYear(),since.getMonth(),since.getDate()).getTime(),daily=new Map(),models=new Map();
  for(const row of list){
   total+=row.cost;
   if(row.createdMs>=sessionStart&&row.createdMs<nowMs){sessionCost+=row.cost;if(oldestSession===null||row.createdMs<oldestSession)oldestSession=row.createdMs;}
   if(row.createdMs>=week.startMs&&row.createdMs<week.endMs)weekCost+=row.cost;
   if(row.createdMs>=month.startMs&&row.createdMs<month.endMs)monthCost+=row.cost;
   if(row.createdMs<sinceStart||row.createdMs>nowMs)continue;
   const key=dayKey(row.createdMs),day=daily.get(key)||{day:key,costUSD:0,calls:0,models:new Set()};
   day.costUSD+=row.cost;day.calls++;day.models.add(row.model.trim()||'未知模型');daily.set(key,day);
   const model=row.model.trim()||'未知模型',bucket=models.get(model)||{name:model,costUSD:0,calls:0};
   bucket.costUSD+=row.cost;bucket.calls++;models.set(model,bucket);
  }
  const win=(key,label,used,limit,resetSeconds)=>{const usedPercent=clampPercent(used/limit*100),reset=Math.max(0,Math.round(resetSeconds));return {key,label,usedUSD:roundUSD(used),limitUSD:limit,usedPercent,remainingPercent:round10(100-usedPercent),resetInSec:reset,resetsAt:nowMs+reset*1000,status:''};};
  return {
   windows:[
    win('session','5 小时滚动',sessionCost,limits.session,oldestSession===null?0:(oldestSession+sessionSeconds*1000-nowMs)/1000),
    win('week','本周',weekCost,limits.week,(week.endMs-nowMs)/1000),
    win('month','账单月',monthCost,limits.month,(month.endMs-nowMs)/1000)],
   daily:[...daily.values()].map(d=>({...d,costUSD:roundUSD(d.costUSD),models:[...d.models].sort()})).sort((a,b)=>a.day<b.day?-1:1),
   models:[...models.values()].map(m=>({...m,costUSD:roundUSD(m.costUSD)})).sort((a,b)=>b.costUSD-a.costUSD),
   totals:{costUSD:roundUSD(total),calls:list.length}};
 }
 const historyOf=local=>local?{daily:local.daily,models:local.models,totals:local.totals}:{daily:[],models:[],totals:{costUSD:0,calls:0}};
 // 接口不可用时的兜底：本机估算（金额窗口，12 / 30 / 60 美元上限），可以带一条说明为什么不走接口。
 function localSnapshot(list,nowMs,hasAuth,error,keySource='',key=''){
  if(!list.length&&!hasAuth)throw userError(error||'未检测到 OpenCode Go 的本机用量');
  return {id:'opencode-go',name:'OpenCode Go',symbol:'terminal',available:true,estimated:true,source:'local',keySource,keyHint:keySource==='manual'&&key?key.slice(-4):'',plan:'',credits:null,limits:{...limits},...localSummary(list,nowMs),error:error||null,updatedAt:nowMs};
 }
 async function readOpenCodeGo(nowMs){
  const {key,keySource}=await opencodeKey();
  let list=null,rowsError='';
  try{list=await readRows();}catch(e){rowsError=describe(e,'');}
  if(key){
   try{
    const windows=await readAPI(key,nowMs);
    return {id:'opencode-go',name:'OpenCode Go',symbol:'terminal',available:true,estimated:false,source:'api',keySource,keyHint:keySource==='manual'?key.slice(-4):'',plan:'',credits:null,windows,...historyOf(list?localSummary(list,nowMs):null),error:null,updatedAt:nowMs};
   }catch(e){
    // 接口失败时退回本机估算，并在界面标出原因（例如网络不通、登录被拒）。
    const note='OpenCode 额度接口失败，改用本机估算：'+(e?.userFacing?e.message:e?.message||e);
    if(list||!rowsError)return localSnapshot(list||[],nowMs,true,note,keySource,key);
    throw userError(note);
   }
  }
  return localSnapshot(list||[],nowMs,false,rowsError||null,'','');
 }

 // ---- Codex：~/.codex/auth.json + chatgpt.com（只读凭据，不刷新、不回写） ----
 async function readCodex(nowMs){
  let raw;
  try{raw=JSON.parse(await fs.readFile(path.join(codexDir,'auth.json'),'utf8'));}
  catch{throw userError('未找到 ~/.codex/auth.json，先在终端运行 codex login 登录');}
  const tokens=raw?.tokens||{},accessToken=typeof tokens.access_token==='string'?tokens.access_token.trim():'';
  if(!accessToken){
   if(typeof raw?.OPENAI_API_KEY==='string'&&raw.OPENAI_API_KEY.trim())throw userError('只检测到 API Key；额度需要 ChatGPT 订阅，先在终端运行 codex login');
   throw userError('~/.codex/auth.json 里没有可用的登录信息');
  }
  const accountId=(typeof tokens.account_id==='string'&&tokens.account_id.trim())||jwtAccountId(tokens.id_token)||jwtAccountId(accessToken);
  const expires=jwtExpiration(accessToken);
  if(expires&&expires*1000+60000<nowMs)throw userError('Codex 登录已过期，在终端运行一次 codex（会自动刷新）或重新 codex login');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),codexTimeoutMs);
  let response;
  try{
   response=await fetchImpl(codexUsageURL,{headers:{authorization:'Bearer '+accessToken,accept:'application/json','user-agent':'bobo',...(accountId?{'chatgpt-account-id':accountId}:{})},redirect:'error',signal:controller.signal});
  }catch(e){throw userError('连接 chatgpt.com 失败：'+(e?.cause?.message||e?.message||e));}
  finally{clearTimeout(timeout);}
  if(response.status===401||response.status===403)throw userError('Codex 登录已失效，请重新运行 codex login');
  if(!response.ok)throw userError('Codex 额度接口返回 '+response.status);
  let body;
  try{body=await response.json();}catch{throw userError('Codex 额度接口返回的不是 JSON');}
  return codexSnapshot(body,nowMs);
 }

 // ---- 刷新与推送 ----
 // 只在「有效数据」变化时推送：倒计时（resetInSec/resetsAt/updatedAt）每分钟都会变，不参与比较。
 const signatureOf=s=>JSON.stringify([s.selected,s.providers.map(p=>[p.id,p.available,p.enabled,p.keySource,p.keyHint,p.reason,p.error,p.plan,p.windows.map(w=>[w.key,w.usedPercent,w.usedUSD,w.status]),p.daily,p.models,p.totals,p.credits])]);
 // 额度重置提醒：Codex 的窗口从「用过」（剩余 < 100%）回到 100% 时提醒一次（5 小时窗口用满后恢复、
 // 周窗口刷新都算）。只在前后两次都是有效读数时比较：服务刚启动、上一次不可用、这次降级都不报。
 // 开关在「用量 → Codex」里（settings.notifyReset），实际投递走通知岛的统一提醒通道（notify）。
 function detectResets(before,after){
  if(!settings.notifyReset||typeof notify!=='function')return;
  const previous=new Map();
  for(const p of before?.providers||[]){
   if(!p.available)continue;
   for(const w of p.windows||[])previous.set(p.id+':'+w.key,w.remainingPercent);
  }
  for(const p of after.providers){
   if(p.id!=='codex'||!p.available)continue;
   for(const w of p.windows||[]){
    const was=previous.get(p.id+':'+w.key);
    if(typeof was==='number'&&was<100&&w.remainingPercent>=100)notify('reset','Codex 额度已重置',(w.label||w.key)+' 回到 100%');
   }
  }
 }
 async function refresh(force=false){
  if(closed)return state;
  if(reading)return reading;
  reading=(async()=>{
   const nowMs=now();
   await loadSettings();
   const results=await Promise.all(providers.map(async p=>{
    const id=p.id,cached=cache.get(id);
    const stamp=snapshot=>{snapshot.enabled=isEnabled(id);return snapshot;};
    if(cached&&nowMs<cached.hardNextAt)return stamp(cached.snapshot);
    if(cached&&!force&&nowMs<cached.nextAt)return stamp(cached.snapshot);
    let snapshot;
    try{snapshot=id==='codex'?await readCodex(nowMs):await readOpenCodeGo(nowMs);}
    catch(e){
     const reason=describe(e,'读取用量失败：');
     snapshot=cached?.snapshot.available?{...cached.snapshot,error:reason,updatedAt:nowMs}:{...p,available:false,reason,error:null,windows:[],keySource:'',keyHint:'',updatedAt:nowMs};
    }
    if(snapshot.error===undefined)snapshot.error=null;
    // 节奏：走网络（Codex / OpenCode 官方接口）3 分钟、最快 60 秒一次；纯本机读数每分钟都可以。
    // 「有 Key 但接口失败、退回本机估算」也算失败：自动重试 2 / 4 / 8 / 10 分钟递增退避（成功后清零），
    // 免得每分钟白试一次打不通的接口；手动强制刷新不受退避限制（网络类最多 60 秒试一次）。
    const api=snapshot.source==='api';
    const degraded=!api&&!!snapshot.error&&!!snapshot.keySource;
    const failed=snapshot.available!==true||degraded;
    let nextAt;
    if(failed){
     const attempts=(backoff.get(id)||0)+1;
     backoff.set(id,attempts);
     nextAt=nowMs+Math.min(tickMs*2**attempts,backoffMaxMs);
    }else{
     backoff.delete(id);
     nextAt=nowMs+(api?netIntervalMs:tickMs);
    }
    const hardNextAt=nowMs+(api||degraded?netHardMinMs:0);
    cache.set(id,{snapshot,nextAt,hardNextAt});
    return stamp(snapshot);
   }));
   const available=results.filter(r=>r.available);
   // 刘海胶囊只在「可用且开启」的来源里选；关掉当前来源时自动换到下一家。
   const selectable=available.filter(r=>r.enabled);
   if(!selectable.some(r=>r.id===selected))selected=selectable[0]?.id||available[0]?.id||providers[0].id;
   const next={available:available.length>0,selected,providers:results,notifyReset:settings.notifyReset,updatedAt:nowMs};
   detectResets(state,next);
   const key=signatureOf(next);
   if(key!==signature){signature=key;state=next;emit();}else state=next;
   return state;
  })();
  try{return await reading;}finally{reading=null;}
 }
 // 刘海胶囊显示哪一家：只能选「可用且开启」的来源（{next:true} 时在这些来源里循环）。
 function selectProvider(id){
  if(!state.providers.some(p=>p.id===id&&p.available&&p.enabled))return state;
  if(selected!==id){selected=id;void saveSettings();state={...state,selected:id};signature=signatureOf(state);emit();}
  return state;
 }
 function cycleProvider(){
  const list=state.providers.filter(p=>p.available&&p.enabled);
  if(list.length<2)return state;
  const index=list.findIndex(p=>p.id===state.selected);
  return selectProvider(list[(index+1)%list.length].id);
 }
 // 来源启停：只影响刘海胶囊的可选项（和切换循环），数据照常读取、页面照常查看。
 function setEnabled(id,enabled){
  const row=state.providers.find(p=>p.id===id);
  if(!row)return state;
  settings.enabled[id]=enabled!==false;void saveSettings();
  const next={...state,providers:state.providers.map(p=>p.id===id?{...p,enabled:settings.enabled[id]}:p)};
  // 关掉当前显示的那家时换到下一家「可用且开启」的来源（selected 与 state.selected 必须一起改）。
  const selectable=next.providers.filter(p=>p.available&&p.enabled);
  if(!selectable.some(p=>p.id===selected))selected=selectable[0]?.id||selected;
  state={...next,selected};
  signature=signatureOf(state);emit();
  return state;
 }
 // 额度重置提醒的开关（Codex 窗口回到 100% 时提醒一次）。
 function setNotifyReset(enabled){
  settings.notifyReset=enabled!==false;
  void saveSettings();
  state={...state,notifyReset:settings.notifyReset};
  emit();
  return state;
 }
 // 手动填写 OpenCode Go 的 API Key：先拿它调一次官方接口验证，通过才保存（文件权限 0600）。
 async function setKey(raw){
  const key=typeof raw==='string'?raw.trim():'';
  if(!key)return {ok:false,message:'请输入 API Key'};
  try{
   const windows=await readAPI(key,now());
   settings.keys['opencode-go']=key;
   await saveSettings();
   cache.delete('opencode-go');   // 换 Key 之后必须真的重新读一次，不能吃旧的缓存
   await refresh(true);
   return {ok:true,message:'已保存并验证：'+windows.map(w=>w.label+' 剩 '+Math.round(w.remainingPercent)+'%').join('、'),snapshot:state};
  }catch(e){return {ok:false,message:e?.userFacing?e.message:'验证失败：'+(e?.message||e)};}
 }
 async function clearKey(){
  delete settings.keys['opencode-go'];
  await saveSettings();
  cache.delete('opencode-go');
  await refresh(true);
  return state;
 }
 return {
  snapshot:()=>state,
  refresh,
  selectProvider,
  cycleProvider,
  setEnabled,
  setNotifyReset,
  setKey,
  clearKey,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  start(){closed=false;void refresh();timer=setInterval(()=>{void refresh();},tickMs);timer.unref?.();},
  stop(){closed=true;if(timer)clearInterval(timer);timer=null;listeners.clear();return saving;},
 };
}
