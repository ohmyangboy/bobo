// 「通知岛」的 Google Antigravity（agy，默认 ~/.gemini/antigravity-cli）数据层。
// agy 把所有会话概要维护在 ~/.gemini/antigravity-cli/conversation_summaries.db 的 conversation_summaries 表：
//   conversation_id         会话唯一 ID（UUID）
//   title                   会话标题
//   preview                 会话预览（标题缺失时兜底）
//   status                  CASCADE_RUN_STATUS_RUNNING / CASCADE_RUN_STATUS_IDLE / 空
//   not_fully_idle          1 = 运行中，0 = 空闲
//   killed                  1 = 已被终止
//   last_modified_time      最后更新时间（ISO / SQLite 时间）
//   last_user_input_time    最后一次用户输入时间（用于计算会话开始时间）
//   workspace_uris          工作区 URI 数组（JSON 字符串，例如 ["file:///path/to/project"]）
//   parent_conversation_id  子代理的父会话 ID（非空时代表子代理，不上面板）
//   nesting_depth           子代理的嵌套层级（> 0 同样过滤掉）
// 只读，不写任何 agy 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

const SCAN_MS = 30 * 60 * 1000;      // 只关心最近 30 分钟有活动的会话
const STALE_MS = 15 * 60 * 1000;     // 状态超过 15 分钟没更新还停在运行中的，按结束处理
const MISS_LIMIT = 3;                // 连续 3 轮扫不到才认为会话消失
const POLL_MS = 2000;
const LABELS = { working: '运行中', waiting: '等你回答', idle: '已结束', error: '已终止' };
// agy 的会话库是 SQLite，靠 Node 内置的 node:sqlite 读（22.13 起不再需要 --experimental-sqlite 开关）。
const SQLITE_REASON = '当前 Node 运行时读不了 SQLite（需要 Node 22.13 及以上），因此读不到 agy 的会话库';

// 目录 URI 转换：file:///path/to/dir -> /path/to/dir
export function parseWorkspaceDir(raw) {
 if (!raw) return '';
 try {
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const first = Array.isArray(arr) ? arr[0] : '';
  if (!first) return '';
  if (first.startsWith('file://')) return decodeURIComponent(new URL(first).pathname);
  return String(first);
 } catch {
  return '';
 }
}

// 时间戳解析：支持 ISO 字符串和数字
export function parseTimestamp(val) {
 if (!val) return 0;
 if (typeof val === 'number') return val;
 const ms = Date.parse(val);
 return Number.isFinite(ms) ? ms : 0;
}

// 纯函数：将 SQLite 记录解析为统一的会话对象
export function parseAgySummary(row, { nowMs = Date.now(), transcriptWaiting = false } = {}) {
 const conversationId = String(row.conversation_id || '');
 const title = String(row.title || row.preview || '').trim() || '未命名会话';
 const directory = parseWorkspaceDir(row.workspace_uris);
 const modifiedAt = parseTimestamp(row.last_modified_time) || nowMs;
 const startedAt = parseTimestamp(row.last_user_input_time) || modifiedAt;
 const running = row.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(row.not_fully_idle) === 1;
 const killed = Number(row.killed) === 1;

 let state = 'idle';
 let detail = '';
 if (killed) {
  state = 'error';
 } else if (running) {
  if (nowMs - modifiedAt > STALE_MS) {
   state = 'idle';
  } else if (transcriptWaiting) {
   state = 'waiting';
   detail = '等你回答';
  } else {
   state = 'working';
  }
 }

 return {
  id: 'agy:' + conversationId,
  sessionId: conversationId,
  source: 'agy',
  title,
  directory,
  state,
  detail,
  startedAt,
  at: modifiedAt,
 };
}

export function createAgy({ home, appDataDir, remind = () => {}, interval = POLL_MS } = {}) {
 const baseDir = appDataDir || path.join(home, '.gemini', 'antigravity-cli');
 const dbFile = path.join(baseDir, 'conversation_summaries.db');
 const brainDir = path.join(baseDir, 'brain');

 const sessions = new Map(), listeners = new Set(), doneTimers = new Map(), askTimers = new Map();
 let closed = true, seq = 0, timer = null, sqlite = null, sqliteMissing = false;

 const emit = () => { for (const l of listeners) { try { l(); } catch {} } };

 function snapshot() {
  return {
   // 运行时读不了 SQLite 时把原因说出来：否则界面只会显示「没有会话」，看不出是 Node 版本的问题。
   available: !sqliteMissing,
   reason: sqliteMissing ? SQLITE_REASON : '',
   sessions: [...sessions.values()]
    .filter(s => !(s.acked === true && (s.state === 'idle' || s.state === 'error')))
    .map(({ changedAt, changeSeq, lastAt, miss, ...s }) => ({
     ...s,
     order: s.order ?? 0,
     label: LABELS[s.state] || s.state,
    })),
  };
 }

 function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
 function cancelDone(id) { const t = doneTimers.get(id); if (t) { clearTimeout(t); doneTimers.delete(id); } }
 function cancelAsk(id) { const t = askTimers.get(id); if (t) { clearTimeout(t); askTimers.delete(id); } }

 function remindLater(id, kind, title, delay) {
  cancelDone(id); cancelAsk(id);
  doneTimers.set(id, setTimeout(() => {
   doneTimers.delete(id);
   remind(kind, kind === 'done' ? '运行结束' : kind === 'error' ? '运行终止' : '需要你回答', title || id);
  }, delay));
 }

 function update(id, patch) {
  const prev = sessions.get(id);
  const base = prev || { id, state: 'idle', at: 0, changedAt: Date.now(), changeSeq: ++seq, acked: false };
  const next = { ...base, ...patch, miss: 0 };
  const changed = Boolean(patch.state && patch.state !== base.state);
  if (!prev) {
   next.changedAt = patch.at || base.changedAt;
   next.changeSeq = ++seq;
   next.acked = next.state === 'idle' || next.state === 'error';
  } else if (changed) {
   next.changedAt = patch.at || Date.now();
   next.changeSeq = ++seq;
   next.acked = false;
  }
  next.order = next.changedAt * 1000 + (next.changeSeq % 1000);
  sessions.set(id, next);
  if (changed) {
   if (next.state === 'idle') remindLater(id, 'done', next.title, 1500);
   else if (next.state === 'error') remindLater(id, 'error', next.title, 1500);
   else if (next.state === 'waiting') remindLater(id, 'question', ((next.name || '') + (next.detail ? ' · ' + next.detail : '')).trim(), 800);
   else { cancelDone(id); cancelAsk(id); }
  }
 }

 function remove(id) { cancelDone(id); cancelAsk(id); sessions.delete(id); }

 // 检查会话日志尾部是否在等待用户回答（例如 ask_question 或等待交互）
 async function checkTranscriptWaiting(convId) {
  try {
   const logPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
   const st = await fs.stat(logPath).catch(() => null);
   if (!st || st.size === 0) return false;
   // 读取尾部最多 4KB
   const len = Math.min(st.size, 4096);
   const fh = await fs.open(logPath, 'r');
   const buf = Buffer.alloc(len);
   await fh.read(buf, 0, len, st.size - len);
   await fh.close();
   const text = buf.toString('utf8');
   const lines = text.trim().split('\n').filter(Boolean);
   if (!lines.length) return false;
   const lastLine = lines[lines.length - 1];
   const item = JSON.parse(lastLine);
   // 如果最新一步包含 ask_question 且还没有完成交互
   if (item.type === 'PLANNER_RESPONSE') {
    const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    if (calls.some(c => c.name === 'ask_question')) return true;
   }
  } catch {}
  return false;
 }

 async function readRows() {
  if (sqlite === null) sqlite = import('node:sqlite').then(m => m).catch(() => false);
  const mod = await sqlite;
  sqliteMissing = !mod;
  if (!mod) return [];
  const exists = await fs.access(dbFile).then(() => true, () => false);
  if (!exists) return [];

  const open = file => new mod.DatabaseSync(file, { readOnly: true, timeout: 250 });
  const immutable = 'file:' + encodeURI(dbFile).replace(/[?#]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) + '?immutable=1';
  let db;
  try { db = open(immutable); } catch { try { db = open(dbFile); } catch { return []; } }

  try {
   const sql = `SELECT conversation_id, title, preview, status, not_fully_idle, killed, last_modified_time, last_user_input_time, workspace_uris, parent_conversation_id, nesting_depth
                FROM conversation_summaries
                WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
                  AND (nesting_depth IS NULL OR nesting_depth = 0)
                ORDER BY last_modified_time DESC
                LIMIT 40;`;
   return db.prepare(sql).all();
  } catch {
   return [];
  } finally {
   try { db.close(); } catch {}
  }
 }

 async function poll() {
  if (closed) return;
  const nowMs = Date.now();
  let rows = [];
  try { rows = await readRows(); } catch {}

  const seen = new Set();
  for (const row of rows) {
   const convId = String(row.conversation_id || '');
   if (!convId) continue;
   const modTime = parseTimestamp(row.last_modified_time);
   if (modTime && nowMs - modTime > SCAN_MS) continue;

   const id = 'agy:' + convId;
   seen.add(id);

   let isWaiting = false;
   const isRunning = row.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(row.not_fully_idle) === 1;
   if (isRunning) {
    isWaiting = await checkTranscriptWaiting(convId);
   }

   const parsed = parseAgySummary(row, { nowMs, transcriptWaiting: isWaiting });
   update(id, parsed);
  }

  for (const [id, s] of sessions) {
   if (!seen.has(id)) {
    s.miss = (s.miss || 0) + 1;
    if (s.miss >= MISS_LIMIT) remove(id);
   }
  }
  emit();
 }

 return {
  start() {
   if (!closed) return;
   closed = false;
   poll().catch(() => {});
   timer = setInterval(() => { poll().catch(() => {}); }, interval);
  },
  stop() {
   closed = true;
   if (timer) { clearInterval(timer); timer = null; }
   for (const id of sessions.keys()) { cancelDone(id); cancelAsk(id); }
  },
  snapshot,
  subscribe,
  unviewed() {
   return [...sessions.values()]
    .filter(s => s.acked === false && (s.state === 'idle' || s.state === 'error'))
    .map(s => s.id);
  },
  acknowledge(id) {
   const s = sessions.get(id);
   if (!s || s.acked === true) return false;
   s.acked = true;
   cancelDone(id); cancelAsk(id);
   emit();
   return true;
  },
 };
}
