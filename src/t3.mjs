// 「通知岛」的 T3 Code 会话数据层。
// T3 把线程投影写在 ~/.t3/userdata/statev2.sqlite（T3CODE_HOME 优先，状态在 userdata 下）：
//   orchestration_v2_projection_threads          标题、项目、更新时间；payload_json 里有 lineage / worktreePath
//   orchestration_v2_projection_runs             最新一轮的 status（running / waiting / completed / failed …）
//   orchestration_v2_projection_runtime_requests 待处理的批准或提问（status=pending 才算等你）
//   projection_projects                          工作区目录
// 子代理（lineage.relationshipToParent = subagent）不上面板。只读，不写任何 T3 配置。
import fs from 'node:fs/promises';
import path from 'node:path';

const SCAN_MS = 30 * 60 * 1000;
const STALE_MS = 15 * 60 * 1000;
const KEEP_MS = 30 * 60 * 1000;
const MISS_LIMIT = 3;
const POLL_MS = 2000;
const LABELS = { working: '运行中', waiting: '等你回答', idle: '已结束', error: '已终止' };
const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running']);
const ERROR_RUN = new Set(['failed', 'interrupted', 'cancelled']);
const WAIT_KINDS = new Set(['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission', 'user_input', 'dynamic_tool_call']);
const APPROVAL_KINDS = new Set(['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission', 'dynamic_tool_call']);
const SQLITE_REASON = '当前 Node 运行时读不了 SQLite（需要 Node.js 22.13 及以上），因此读不到 T3 的会话库';

export function parseTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function isSubagent(payload) {
  return payload?.lineage?.relationshipToParent === 'subagent';
}

export function linkSource(provider) {
  const p = String(provider || '').toLowerCase().replace(/[_-]/g, '');
  if (p.includes('codex')) return 'codex';
  if (p.includes('claude')) return 'claude';
  if (p.includes('opencode') || p === 'omp') return 'opencode';
  if (p.includes('antigravity') || p === 'agy') return 'agy';
  if (p.includes('deepseek') || p === 'dsh') return 'dsh';
  return '';
}

// 桌面版线程深链：t3code://threads/<环境 id>/<线程 id>，对应应用内 /<环境>/<线程>。
export function t3ThreadUrl(environmentId, threadId) {
  const env = String(environmentId ?? '').trim();
  const id = String(threadId ?? '').trim().replace(/^t3:/, '');
  if (!env || !id) return '';
  return 't3code://threads/' + encodeURIComponent(env) + '/' + encodeURIComponent(id);
}

export function latestRun(runs) {
  return (runs || []).reduce((best, run) => {
    if (!run) return best;
    if (!best) return run;
    const left = Number(best.ordinal) || 0, right = Number(run.ordinal) || 0;
    if (right !== left) return right > left ? run : best;
    return parseTime(run.requested_at) >= parseTime(best.requested_at) ? run : best;
  }, null);
}

// 纯函数：一轮运行 + 待处理请求 → 通知岛状态。auth_refresh 是 T3 自己在刷新登录，不算等你回答。
export function deriveState(run, requests) {
  const pending = (requests || []).filter(r => r?.status === 'pending');
  const user = pending.filter(r => WAIT_KINDS.has(r.kind));
  const onlyAuth = pending.length > 0 && user.length === 0 && pending.every(r => r.kind === 'auth_refresh');
  if (user.length) return 'waiting';
  const status = run?.status || '';
  if (status === 'waiting' && !onlyAuth) return 'waiting';
  if (ERROR_RUN.has(status)) return 'error';
  if (status === 'completed' || status === 'rolled_back') return 'idle';
  if (ACTIVE_RUN.has(status) || (status === 'waiting' && onlyAuth) || (status && status !== 'idle')) return 'working';
  return 'idle';
}

export function detailOf(state, requests) {
  if (state !== 'waiting') return '';
  const user = (requests || []).find(r => r?.status === 'pending' && r.kind === 'user_input')
    || (requests || []).find(r => r?.status === 'pending' && WAIT_KINDS.has(r.kind));
  if (user && APPROVAL_KINDS.has(user.kind)) return '等待批准';
  return '等你回答';
}

export function parseThread(row, { runs = [], requests = [], now = Date.now(), environmentId = '' } = {}) {
  const payload = parsePayload(row?.payload_json);
  if (!row?.thread_id || row.deleted_at || row.archived_at || isSubagent(payload)) return null;
  const run = latestRun(runs);
  const at = Math.max(parseTime(row.updated_at), parseTime(run?.requested_at), parseTime(run?.completed_at), ...requests.map(r => parseTime(r.created_at)));
  let state = deriveState(run, requests);
  if ((state === 'working' || state === 'waiting') && at && now - at > STALE_MS) state = 'idle';
  const directory = String(payload.worktreePath || row.workspace_root || '').trim();
  const provider = String(row.default_provider || payload.providerInstanceId || '');
  return {
    id: 't3:' + row.thread_id,
    sessionId: String(row.thread_id),
    source: 't3',
    title: String(row.title || payload.title || '').trim() || '未命名会话',
    directory,
    name: directory ? path.basename(directory) : 'T3',
    state,
    detail: detailOf(state, requests),
    startedAt: parseTime(row.created_at) || at || now,
    at: at || now,
    linkSource: linkSource(provider),
    environmentId: String(environmentId || ''),
  };
}

export function createT3({ home, t3Home, env = process.env, remind = () => {}, interval = POLL_MS, now = () => Date.now(), load } = {}) {
  const root = t3Home || env.T3CODE_HOME || path.join(home, '.t3');
  const dbFile = path.join(root, 'userdata', 'statev2.sqlite');
  const envFile = path.join(root, 'userdata', 'environment-id');
  const sessions = new Map(), listeners = new Set(), doneTimers = new Map(), askTimers = new Map();
  let closed = true, seq = 0, timer = null, signature = '', sqlite = null, sqliteMissing = false, environmentId = '', rowsCache = null, dbStamp = '';

  const emit = () => { for (const l of listeners) { try { l(); } catch {} } };
  const signatureOf = () => JSON.stringify([!sqliteMissing, ...[...sessions.values()].map(s => [s.id, s.state, s.title, s.directory, s.detail, s.acked])]);
  function snapshot() {
    return {
      available: !sqliteMissing,
      reason: sqliteMissing ? SQLITE_REASON : '',
      sessions: [...sessions.values()]
        .filter(s => !(s.acked === true && (s.state === 'idle' || s.state === 'error')))
        .map(({ changedAt, changeSeq, lastAt, miss, ...s }) => ({ ...s, order: s.order ?? 0, label: LABELS[s.state] || s.state })),
    };
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function cancelDone(id) { const t = doneTimers.get(id); if (t) { clearTimeout(t); doneTimers.delete(id); } }
  function cancelAsk(id) { const t = askTimers.get(id); if (t) { clearTimeout(t); askTimers.delete(id); } }
  function remindLater(id, kind, title, delay) {
    cancelDone(id); cancelAsk(id);
    doneTimers.set(id, setTimeout(() => { doneTimers.delete(id); remind(kind, kind === 'done' ? '运行结束' : kind === 'error' ? '运行终止' : '需要你回答', title || id); }, delay));
  }
  function update(id, patch) {
    const prev = sessions.get(id);
    const base = prev || { id, state: 'idle', at: 0, changedAt: now(), changeSeq: ++seq, acked: false };
    const next = { ...base, ...patch, miss: 0 };
    const changed = Boolean(patch.state && patch.state !== base.state);
    if (!prev) {
      next.changedAt = patch.at || base.changedAt; next.changeSeq = ++seq; next.acked = next.state === 'idle' || next.state === 'error';
    } else if (changed) { next.changedAt = patch.at || now(); next.changeSeq = ++seq; next.acked = false; }
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

  async function readSqlite() {
    if (sqlite === null) sqlite = import('node:sqlite').then(m => m).catch(() => false);
    const mod = await sqlite;
    sqliteMissing = !mod;
    if (!mod) return { environmentId: '', threads: [] };
    const stampFile = async file => { const st = await fs.stat(file).catch(() => null); return st ? `${st.mtimeMs}:${st.size}` : ''; };
    const nextStamp = (await Promise.all([dbFile, dbFile + '-wal', dbFile + '-shm'].map(stampFile))).join('|');
    if (rowsCache && nextStamp === dbStamp) return rowsCache;
    if (!nextStamp.split('|')[0]) { rowsCache = { environmentId, threads: [] }; dbStamp = nextStamp; return rowsCache; }
    if (!environmentId) environmentId = (await fs.readFile(envFile, 'utf8').catch(() => '')).trim();
    const wal = nextStamp.split('|')[1] !== '';
    const immutable = 'file:' + encodeURI(dbFile).replace(/[?#]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) + '?immutable=1';
    let db;
    try { db = new mod.DatabaseSync(wal ? dbFile : immutable, { readOnly: true, timeout: 250 }); }
    catch { try { db = new mod.DatabaseSync(dbFile, { readOnly: true, timeout: 250 }); } catch { return rowsCache || { environmentId, threads: [] }; } }
    try {
      const since = new Date(now() - SCAN_MS).toISOString();
      const threads = db.prepare(`SELECT t.thread_id, t.project_id, t.title, t.default_provider, t.created_at, t.updated_at, t.archived_at, t.deleted_at, t.payload_json, p.workspace_root
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
          AND (t.updated_at >= ? OR t.thread_id IN (
            SELECT thread_id FROM orchestration_v2_projection_runs
            WHERE status IN ('preparing','queued','starting','running','waiting')))
        ORDER BY t.updated_at DESC LIMIT 40`).all(since);
      const ids = threads.map(t => t.thread_id).filter(Boolean);
      const runs = ids.length ? db.prepare(`SELECT thread_id, status, ordinal, requested_at, completed_at FROM orchestration_v2_projection_runs WHERE thread_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
      const requests = ids.length ? db.prepare(`SELECT thread_id, kind, status, created_at FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending' AND thread_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
      const byThread = id => ({ runs: runs.filter(r => r.thread_id === id), requests: requests.filter(r => r.thread_id === id) });
      rowsCache = { environmentId, threads: threads.map(t => ({ ...t, ...byThread(t.thread_id) })) };
      dbStamp = nextStamp;
      return rowsCache;
    } catch {
      return rowsCache || { environmentId, threads: [] };
    } finally { try { db.close(); } catch {} }
  }

  async function poll() {
    const nowMs = now();
    let bundle = { environmentId: '', threads: [] };
    try { bundle = await (load || readSqlite)(); } catch {}
    const seen = new Set();
    for (const row of bundle.threads || []) {
      const parsed = parseThread(row, { runs: row.runs, requests: row.requests, now: nowMs, environmentId: bundle.environmentId || '' });
      if (!parsed) continue;
      if (parsed.state === 'idle' && nowMs - parsed.at > SCAN_MS) continue;
      seen.add(parsed.id);
      update(parsed.id, parsed);
    }
    for (const [id, s] of sessions) {
      if (seen.has(id)) continue;
      const miss = (s.miss || 0) + 1;
      if (miss <= MISS_LIMIT) { sessions.set(id, { ...s, miss }); continue; }
      if ((s.state === 'idle' || s.state === 'error') && nowMs - s.at < KEEP_MS) continue;
      remove(id);
    }
    const next = signatureOf();
    if (next !== signature) { signature = next; emit(); }
  }

  async function tick() { if (closed) return; try { await poll(); } catch {} if (!closed) { timer = setTimeout(tick, interval); timer.unref?.(); } }
  return {
    start() { if (!closed) return; closed = false; void tick(); },
    stop() { closed = true; if (timer) { clearTimeout(timer); timer = null; } for (const id of sessions.keys()) { cancelDone(id); cancelAsk(id); } },
    snapshot, subscribe,
    refresh: poll,
    get(id) { return sessions.get(id); },
    unviewed() {
      return [...sessions.values()].filter(s => s.acked === false && (s.state === 'idle' || s.state === 'error')).map(s => ({ id: s.id, title: s.title || '', directory: s.directory || '', source: 't3' }));
    },
    acknowledge(id) {
      const s = sessions.get(id);
      if (!s || s.acked === true) return false;
      s.acked = true; cancelDone(id); cancelAsk(id); signature = signatureOf(); emit();
      return true;
    },
  };
}
