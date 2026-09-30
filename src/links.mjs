// 服务线路：给「设备 → 网络」分栏用的一组按需探测——每个 AI 服务与出口的延迟信号，
// 以及出口 IP 的类型 / 风控值（类似 ping0.cc 的部分能力），用来评估各 Agent 走的网络链路健不健康。
//
// 每条线路只发很小的 HTTPS 请求：不发模型请求、不带任何凭据、不改任何配置。
// 延迟取 curl 的首字节时间（经系统代理时测的就是经代理的整条路）；Cloudflare 前沿的
// 服务（Codex / Claude Code / OpenCode Go）用 /cdn-cgi/trace 原样回显「该服务实际看到的出口 IP」，
// 其余服务（DeepSeek / Google）没有这个回显，标出线路出口即可。出口 IP 的类型与风控值
// 按 IP 查 proxycheck.io，失败退回 ip-api.com（只支持 IPv4）；查询优先走系统代理、连不上再试直连。
//
// 探测有两种触发：网页停在「设备 → 网络」分栏时由页面来拉（打开时一次、之后每 60 秒、手动「检测线路」强制），
// 以及服务端 start() 的常驻定期探测（刘海面板常开、只订阅状态流，会话行右侧要显示各线路健康；2 分钟一跳，
// 测试环境不生效）。结果只放内存：延迟新鲜 60 秒、出口类型按 IP 缓存 3 小时、同一 IP 一分钟内不重复查
// （护住免费接口的额度），不写任何文件。
import { spawn } from 'node:child_process';
import os from 'node:os';
import { isIP } from 'node:net';
import { macHTTPSProxy } from './usage.mjs';

// 线路清单：名称、服务域名、探测地址。Cloudflare 前沿的用 /cdn-cgi/trace（顺带回显出口 IP），
// 其余用最小路径（401 / 204 也算通）。agents 是走这条线路的会话来源（通知岛面板的会话行右侧
// 按它取线路健康；没列进来的来源退回出口线路）。加一条线路只需在下面加一行；图标由页面按 id 映射。
export const SERVICES = [
 { id: 'codex', name: 'Codex', host: 'chatgpt.com', trace: 'https://chatgpt.com/cdn-cgi/trace', agents: ['codex'] },
 { id: 'claude', name: 'Claude Code', host: 'api.anthropic.com', trace: 'https://api.anthropic.com/cdn-cgi/trace', agents: ['claude'] },
 // OpenCode 与 omp 默认都走 OpenCode Go（本机两家的 models 都是 opencode-go/*）。
 { id: 'opencode', name: 'OpenCode Go', host: 'opencode.ai', trace: 'https://opencode.ai/cdn-cgi/trace', agents: ['opencode', 'omp'] },
 { id: 'deepseek', name: 'DeepSeek', host: 'api.deepseek.com', url: 'https://api.deepseek.com/', agents: ['dsh'] },
 { id: 'agy', name: 'Antigravity', host: 'generativelanguage.googleapis.com', show: 'googleapis.com', url: 'https://generativelanguage.googleapis.com/generate_204', agents: ['agy'] },
];

const probeTimeoutMs = 6000, lookupTimeoutMs = 4000, scutilTimeoutMs = 1500, execTimeoutMs = 12000;
// 出口类型按 IP 缓存 3 小时：面板常驻探测时同一 IP 不会被反复查，proxycheck 免费额度（100 次/天）
// 才守得住——换节点 / 换代理时出口 IP 变了就是新的键，会立刻查一次；手动「检测线路」也绕过缓存重查。
const checkTtlMs = 60000, purityTtlMs = 3 * 60 * 60000, purityMinMs = 60000, purityCacheMax = 64;
// 常驻探测的节奏：刘海面板常开着，2 分钟一跳就够表示「当前」延迟；网页停在「设备 → 网络」时
// 由页面按 60 秒的 checkTtlMs 自己拉，比这一跳更密。
const tickMs = 120000, firstTickMs = 5000;
// 信号格：首字节 ≤ 150 ms 四格、≤ 350 三格、≤ 700 两格，其余成功请求一格；失败零格。
const barMs = [150, 350, 700];
// 类型文字与等级：网页用长文案（typeText），面板用短文案（typeShort）；等级由 purityOf 的 grade 映射。
const typeText = { vpn: 'VPN', proxy: '代理', tor: 'Tor', hosting: '机房', mobile: '移动网络', residential: '住宅 / 家宽', business: '商用网络', unknown: '未确认' };
const typeShort = { vpn: 'VPN', proxy: '代理', tor: 'Tor', hosting: '机房', mobile: '移动', residential: '家宽', business: '商用', unknown: '未确认' };
const gradeLevel = { clean: 'ok', ok: 'warn', dirty: 'low', unknown: 'idle' };

export function signalOf(ms) {
 const v = Number(ms);
 if (ms === null || ms === undefined || ms === '' || !Number.isFinite(v) || v < 0) return 0;
 const i = barMs.findIndex(limit => v <= limit);
 return i < 0 ? 1 : 4 - i;
}
export function levelOf(bars) { return bars >= 3 ? 'ok' : bars === 2 ? 'warn' : 'low'; }
// 一句话结论：不通是「不可达」、很慢是「很差」、偏慢是「偏慢」、速度正常但出口被打上代理 / 机房的
// 标记是「需留意」（这类 IP 容易被厂商风控 / 限流），其余「通畅」。
export function healthOf({ ok = true, status = 0, level = 'ok', info = null } = {}) {
 if (status === 429) return { health: 'warn', healthText: '请求限流' };
 if (status === 403 || status === 407) return { health: 'low', healthText: '访问受限' };
 if (status >= 500) return { health: 'low', healthText: '服务异常' };
 if (!ok) return { health: 'low', healthText: '不可达' };
 if (level === 'low') return { health: 'low', healthText: '很差' };
 if (level === 'warn') return { health: 'warn', healthText: '偏慢' };
 if (info?.grade === 'dirty' || info?.grade === 'ok') return { health: 'warn', healthText: '需留意' };
 return { health: 'ok', healthText: '通畅' };
}
// 出口 IP 的类型、风控值与等级。proxycheck 的类型 + 风控值优先，ip-api 的 proxy / hosting / mobile
// 标记兜底（IPv4）；按 proxycheck 的 34 / 67 风险边界分档，缺失值保持未知。
// ip-api 未标记并不能证明是家宽，也不能推导风控值。
export function purityOf({ proxycheck = null, ipapi = null } = {}) {
 const pc = proxycheck && typeof proxycheck === 'object' ? proxycheck : null;
 const ia = ipapi && typeof ipapi === 'object' ? ipapi : null;
 const raw = String(pc?.type || '').toLowerCase();
 let type = 'unknown';
 if (raw.includes('tor')) type = 'tor';
 else if (raw.includes('vpn')) type = 'vpn';
 else if (raw.includes('proxy')) type = 'proxy';
 else if (raw.includes('host')) type = 'hosting';
 else if (raw.includes('wireless') || raw.includes('mobile')) type = 'mobile';
 else if (raw.includes('residential') || raw.includes('isp')) type = 'residential';
 else if (raw.includes('business')) type = 'business';
 if (type === 'unknown' && (pc?.proxy === 'yes' || pc?.proxy === true)) type = 'proxy';
 if (type === 'unknown') {
  if (ia?.hosting === true) type = 'hosting';
  else if (ia?.proxy === true) type = 'proxy';
  else if (ia?.mobile === true) type = 'mobile';
 }
 const risk = pc?.risk !== null && pc?.risk !== undefined && pc?.risk !== '' && Number.isFinite(Number(pc.risk)) ? Math.max(0, Math.min(100, Math.round(Number(pc.risk)))) : null;
 const flagged = type === 'tor' || type === 'vpn' || type === 'proxy' || type === 'hosting';
 let grade = pc || ia ? 'ok' : 'unknown';
 if (type === 'tor' || risk !== null && risk > 66 || flagged && risk !== null && risk >= 34) grade = 'dirty';
 else if (!flagged && risk !== null && risk < 34 && ['residential', 'business', 'mobile'].includes(type)) grade = 'clean';
 else if (type === 'unknown' && risk === null) grade = 'unknown';
 return {
  type, typeText: typeText[type], typeShort: typeShort[type], level: gradeLevel[grade], risk, grade,
  source: pc ? 'proxycheck.io' : ia ? 'ip-api.com' : '',
  provider: String(pc?.provider || pc?.organisation || ia?.isp || ia?.org || ''),
  country: String(pc?.country || ia?.country || ''),
 };
}
// /cdn-cgi/trace 的正文是每行 key=value（ip / loc / colo …）。
export function parseTrace(text) {
 const out = {};
 for (const line of String(text || '').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
 }
 return { ip: out.ip || '', loc: out.loc || '', colo: out.colo || '' };
}
export function parseGeo(text) {
 try {
  const j = JSON.parse(text);
  return { ip: String(j.ip || ''), country: String(j.country || ''), city: String(j.city || ''), asn: j.asn ? 'AS' + j.asn : '', provider: String(j.asn_organization || j.organization || j.isp || '') };
 } catch { return null; }
}
export function parseProxycheck(ip, text) {
 try {
  const j = JSON.parse(text);
  const row = j?.status === 'ok' ? j[String(ip)] : null;
  return row && typeof row === 'object' ? row : null;
 } catch { return null; }
}
export function parseIpapi(text) {
 try {
  const j = JSON.parse(text);
  return j?.status === 'success' ? j : null;
 } catch { return null; }
}
// curl 的错误码换成人话（配合 -m 超时与 --show-error）。
const curlErrors = { 6: '域名解析失败', 7: '连不上', 28: '超时', 35: 'TLS 握手失败', 56: '连接被重置', 60: '证书校验失败' };
export function curlError(e) {
 const m = /\((\d+)\)/.exec(e?.message || '');
 return curlErrors[Number(m?.[1])] || '请求失败';
}
// HTTPS_PROXY / https_proxy（Finder 启动的应用通常没有，从终端启动时才有）；只认 http(s) 与 socks。
export function proxyFromEnv(env = {}) {
 const v = String(env.HTTPS_PROXY || env.https_proxy || '').trim();
 if (!v) return '';
 try {
  const u = new URL(v);
  if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(u.protocol)) return '';
  return (u.protocol + '//' + u.host + (u.pathname === '/' ? '' : u.pathname)).replace(/\/$/, '');
 } catch { return ''; }
}
// curl 走配置文件（--config -）而不是命令行参数：经代理时也不在进程列表里暴露代理地址。
const quote = v => '"' + String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '') + '"';
export function curlConfig({ url, proxy = '', timeoutMs = probeTimeoutMs }) {
 return [
  `url = ${quote(url)}`,
  proxy ? `proxy = ${quote(proxy)}` : 'proxy = ""',
  proxy ? 'noproxy = ""' : 'noproxy = "*"',
  'silent', 'show-error',
  `max-time = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
  'max-redirs = 0',
  'user-agent = "bobo"',
  'write-out = "\\n%{http_code} %{time_starttransfer} %{time_appconnect}"',
 ].join('\n') + '\n';
}
// 出口 / 探测返回的 IP 必须是纯 IP（v6 里的冒号原样进 URL，比百分号编码更稳）：认不出就不查。
const ipLike = v => isIP(String(v || '')) !== 0;

// 子进程统一入口（与 network.mjs / devices.mjs 一致）：数组参数 + shell:false，只收 stdout，
// 退出码非 0 视为失败；input 用于 --config - 的标准输入。
function run(file, args, input = '', timeoutMs = execTimeoutMs) {
 return new Promise((resolve, reject) => {
  const child = spawn(file, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', done = false;
  const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', s => { out = (out + s).slice(0, 200000); });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { err = (err + s).slice(-4000); });
  child.on('error', e => finish(reject, e));
  child.on('close', code => code === 0 ? finish(resolve, out) : finish(reject, Error(err.trim() || `${file} 退出码 ${code}`)));
  try { child.stdin.end(input); } catch {}
 });
}
// 并行任务的并发上限：一次检测最多十几个小请求，限 4 条同时跑，别一下推开一屏子进程。
async function pool(tasks, limit = 4) {
 const out = new Array(tasks.length);
 let next = 0;
 const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
 await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
 return out;
}

export function createLinks({ home = '', env = process.env, platform = process.platform, exec = run, now = Date.now, shouldCheck = () => true } = {}) {
 const curlBin = platform === 'darwin' ? '/usr/bin/curl' : platform === 'win32' ? 'curl.exe' : 'curl';
 // 系统 HTTPS 代理优先（与「用量」一致，macOS 走 scutil），没有再看环境变量；都认不出就是直连。
 async function detectProxy() {
  try {
   if (platform === 'darwin') {
    const out = await exec('/usr/sbin/scutil', ['--proxy'], '', scutilTimeoutMs);
    const p = macHTTPSProxy(out);
    if (p) return p;
   }
  } catch {}
  return proxyFromEnv(env);
 }
 async function httpProbe({ url, proxy = '', timeoutMs = probeTimeoutMs }) {
  try {
   const out = await exec(curlBin, ['--config', '-'], curlConfig({ url, proxy, timeoutMs }), execTimeoutMs);
   const nl = out.lastIndexOf('\n');
   const m = /^(\d{3}) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(nl < 0 ? '' : out.slice(nl + 1).trim());
   if (!m) throw Error('curl 输出无法解析');
   const status = Number(m[1]);
   const ok = status >= 200 && status < 500 && ![403, 407, 429].includes(status);
   return { ok, status, ms: Math.round(Number(m[2]) * 1000), tlsMs: Math.round(Number(m[3]) * 1000), body: nl < 0 ? '' : out.slice(0, nl), error: ok ? '' : status === 429 ? '请求限流（HTTP 429）' : status === 403 ? '访问被拒绝（HTTP 403）' : `HTTP ${status}` };
  } catch (e) { return { ok: false, status: 0, ms: null, tlsMs: null, body: '', error: curlError(e) }; }
 }
 // 先走优先路线（有代理时是代理，否则直连），连不上再试另一条。
 async function fetchText({ url, proxy = '', timeoutMs = lookupTimeoutMs }) {
  let last = null;
  for (const p of proxy ? [proxy, ''] : ['']) {
   const r = await httpProbe({ url, proxy: p, timeoutMs });
   if (r.ok) return r;
   last = r;
  }
  return last;
 }
 // 出口 IP 的类型 / 风控：按 IP 缓存；proxycheck 主、ip-api（仅 IPv4）副。
 const purityCache = new Map();
 const purityPending = new Map();
 async function lookupPurity(ip, proxy, force) {
  if (!ipLike(ip)) return null;
  const hit = purityCache.get(ip);
  const ttl = hit?.info.source ? purityTtlMs : purityMinMs;
  if (hit && (!force || now() - hit.at < purityMinMs) && now() - hit.at < ttl) return { ...hit.info, at: hit.at, cached: true };
  if (purityPending.has(ip)) return purityPending.get(ip);
  const task = (async () => {
   const query = async (url, parse) => {
    const r = await fetchText({ url, proxy });
    return r?.ok ? parse(r.body) : null;
   };
   const pc = await query(`https://proxycheck.io/v2/${ip}?vpn=1&risk=1&asn=1`, body => parseProxycheck(ip, body));
   // 只有主接口查不到才走兜底，避免多发一次查询。
   const ia = !pc && !ip.includes(':') ? await query(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,org,as,mobile,proxy,hosting`, parseIpapi) : null;
   const info = { ...purityOf({ proxycheck: pc, ipapi: ia }), at: now() };
   purityCache.set(ip, { at: info.at, info });
   for (const key of purityCache.keys()) { if (purityCache.size <= purityCacheMax) break; purityCache.delete(key); }
   return { ...info, cached: false };
  })();
  purityPending.set(ip, task);
  try { return await task; } finally { purityPending.delete(ip); }
 }

 // 出口行：直连出口与（配了系统代理时的）代理出口，探测 api.ip.sb 拿出口 IP 与归属。
 // 探测走这条线路自己（proxy）；出口 IP 的类型 / 风控查询统一走 lookupProxy——数据按 IP 查、
 // 与查询路线无关，固定用系统代理（有的话）更不容易因直连被挡而查不到。
 async function exitRow({ id, name, proxy, lookupProxy, force }) {
  const r = await httpProbe({ url: 'https://api.ip.sb/geoip', proxy });
  const geo = r.ok ? parseGeo(r.body) : null;
  if (r.ok && !ipLike(geo?.ip)) { r.ok = false; r.error = '出口 IP 响应无效'; }
  const info = geo?.ip ? await lookupPurity(geo.ip, lookupProxy, force) : null;
  const bars = r.ok ? signalOf(r.ms) : 0;
  const level = r.ok ? levelOf(bars) : 'low';
  const { health, healthText } = healthOf({ ok: r.ok, status: r.status, level, info });
  return {
   id, kind: 'exit', name, via: proxy ? 'proxy' : 'direct', proxy: proxy || '',
   ok: r.ok, status: r.status, ms: r.ms, tlsMs: r.tlsMs, bars, level, health, healthText,
   ip: geo?.ip || '', country: geo?.country || '', city: geo?.city || '', provider: geo?.provider || '', asn: geo?.asn || '',
   ipSource: '', info: info?.source ? info : null, error: r.error || '', checkedAt: now(),
  };
 }
 // 服务行：延迟 + （Cloudflare 前沿的）该服务实际看到的出口 IP；没有回显的服务标线路出口。
 async function serviceRow(service, proxy, exitIps, lookupProxy, force) {
  const r = await httpProbe({ url: service.trace || service.url, proxy });
  const trace = r.ok && service.trace ? parseTrace(r.body) : null;
  const ip = trace?.ip || exitIps[proxy ? 'proxy' : 'direct'] || '';
  const info = ip ? await lookupPurity(ip, lookupProxy, force) : null;
  const bars = r.ok ? signalOf(r.ms) : 0;
  const level = r.ok ? levelOf(bars) : 'low';
  const { health, healthText } = healthOf({ ok: r.ok, status: r.status, level, info });
  return {
   id: service.id, kind: 'service', name: service.name, host: service.host, show: service.show || service.host, via: proxy ? 'proxy' : 'direct', proxy: proxy || '',
   ok: r.ok, status: r.status, ms: r.ms, tlsMs: r.tlsMs, bars, level, health, healthText,
   ip, ipSource: trace?.ip ? 'trace' : ip ? 'route' : '', colo: trace?.colo || '', loc: trace?.loc || '',
   country: info?.country || '', city: '', provider: info?.provider || '', asn: '',
   info: info?.source ? info : null, error: r.error || '', checkedAt: now(),
   agents: service.agents || [],
  };
 }
 let state = { available: true, updatedAt: 0, checking: false, proxy: '', rows: [], error: '' };
 let busy = null;
 const listeners = new Set();
 const emit = () => { for (const listener of listeners) { try { listener(); } catch {} } };
 const snapshot = () => ({ ...state, rows: state.rows.map(r => ({ ...r })) });
 async function runCheck(force) {
  state = { ...state, checking: true, error: '' };
  try {
   const proxy = await detectProxy();
   const exitIps = {};
   // 直连出口永远测；有系统代理时再测一条代理出口（两条的延迟与出口都能对比）。
   const [direct, via] = await Promise.all([
    exitRow({ id: 'direct', name: '系统出口', proxy: '', lookupProxy: proxy, force }),
    proxy ? exitRow({ id: 'proxy', name: '代理出口', proxy, lookupProxy: proxy, force }) : null,
   ]);
   exitIps.direct = direct.ip;
   if (via) exitIps.proxy = via.ip;
   const services = await pool(SERVICES.map(s => async () => serviceRow(s, proxy, exitIps, proxy, force)), 4);
   const rows = [direct, ...(via ? [via] : []), ...services];
   state = { available: true, updatedAt: now(), checking: false, proxy, rows, error: rows.every(r => !r.ok) ? '所有线路都探测失败' : '' };
  } catch (e) {
   state = { ...state, checking: false, error: '探测线路失败：' + (e?.message || e) };
  }
  emit();
 }
 function refresh(force = false) {
  if (!busy && state.updatedAt && now() - state.updatedAt < checkTtlMs && !force) return snapshot();
  if (!busy) busy = runCheck(Boolean(force)).finally(() => { busy = null; });
  return snapshot();
 }
 // 一条会话来源走的那条线路（通知岛面板的会话行右侧据此取线路健康）：按 SERVICES 的 agents 映射找，
 // 没映射到或那一行还没探到时退回出口线路（有代理走代理出口，否则直连出口）；都还没有就是空串。
 function linkFor(source) {
  const id = SERVICES.find(s => (s.agents || []).includes(String(source || '')))?.id;
  if (id && state.rows.some(r => r.id === id)) return id;
  const fallback = state.rows.find(r => r.kind === 'exit' && r.id === 'proxy') || state.rows.find(r => r.kind === 'exit');
  return fallback?.id || '';
 }
 let timer = null, firstTimer = null;
 // 常驻定期探测：刘海面板常开、只订阅状态流，不会像网页那样主动来拉，所以这里替它保持新鲜
 // （延迟 2 分钟一跳；出口类型的查询仍按 3 小时的 IP 缓存走）。测试环境（临时 HOME / BOBO_HOME）
 // 不去碰真实网络，start() 直接不生效。
 function start({ intervalMs = tickMs, firstMs = Math.min(firstTickMs, intervalMs) } = {}) {
  if (timer || env.BOBO_HOME || String(home || '').startsWith(os.tmpdir())) return;
  const check = () => { if (shouldCheck()) refresh(); };
  timer = setInterval(check, intervalMs);
  timer.unref?.();
  firstTimer = setTimeout(check, firstMs);
  firstTimer.unref?.();
 }
 function stop() {
  if (timer) clearInterval(timer); timer = null;
  if (firstTimer) clearTimeout(firstTimer); firstTimer = null;
 }
 return {
  snapshot, refresh, whenIdle: () => busy || Promise.resolve(), linkFor, start, stop,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
 };
}
