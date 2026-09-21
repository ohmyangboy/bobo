import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseWorkspaceDir, parseTimestamp, parseAgySummary, createAgy } from '../src/agy.mjs';

test('parseWorkspaceDir 与 parseTimestamp 基础解析', () => {
 assert.equal(parseWorkspaceDir('["file:///Users/test/project"]'), '/Users/test/project');
 assert.equal(parseWorkspaceDir('["/Users/test/project"]'), '/Users/test/project');
 assert.equal(parseWorkspaceDir(''), '');
 assert.equal(parseWorkspaceDir(null), '');

 assert.equal(parseTimestamp(1720000000000), 1720000000000);
 assert.equal(parseTimestamp('2026-09-21T12:00:00Z'), Date.parse('2026-09-21T12:00:00Z'));
 assert.equal(parseTimestamp('invalid'), 0);
});

test('parseAgySummary 状态推导', () => {
 const now = Date.now();
 // 运行中
 const r1 = parseAgySummary({
  conversation_id: 'conv-1',
  title: '测试任务',
  status: 'CASCADE_RUN_STATUS_RUNNING',
  not_fully_idle: 1,
  killed: 0,
  last_modified_time: now - 5000,
  last_user_input_time: now - 60000,
  workspace_uris: '["file:///Users/dev/test"]'
 }, { nowMs: now });
 assert.equal(r1.id, 'agy:conv-1');
 assert.equal(r1.state, 'working');
 assert.equal(r1.title, '测试任务');
 assert.equal(r1.directory, '/Users/dev/test');

 // 等你回答
 const r2 = parseAgySummary({
  conversation_id: 'conv-2',
  title: '问答任务',
  status: 'CASCADE_RUN_STATUS_RUNNING',
  not_fully_idle: 1,
  killed: 0,
  last_modified_time: now - 1000,
  workspace_uris: '["file:///Users/dev/test"]'
 }, { nowMs: now, transcriptWaiting: true });
 assert.equal(r2.state, 'waiting');
 assert.equal(r2.detail, '等你回答');

 // 已终止
 const r3 = parseAgySummary({
  conversation_id: 'conv-3',
  title: '被杀任务',
  status: 'CASCADE_RUN_STATUS_RUNNING',
  killed: 1,
 }, { nowMs: now });
 assert.equal(r3.state, 'error');

 // 已结束
 const r4 = parseAgySummary({
  conversation_id: 'conv-4',
  title: '完成任务',
  status: 'CASCADE_RUN_STATUS_IDLE',
  not_fully_idle: 0,
  killed: 0,
 }, { nowMs: now });
 assert.equal(r4.state, 'idle');
});

test('createAgy 完整轮询、提醒与 acknowledge', async () => {
 const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bobo-agy-test-'));
 const appDataDir = path.join(tmp, 'antigravity-cli');
 await fs.mkdir(appDataDir, { recursive: true });

 const mod = await import('node:sqlite').catch(() => null);
 if (!mod) return;

 const dbPath = path.join(appDataDir, 'conversation_summaries.db');
 const db = new mod.DatabaseSync(dbPath);
 db.exec(`
  CREATE TABLE conversation_summaries (
   conversation_id TEXT PRIMARY KEY,
   title TEXT,
   preview TEXT,
   status TEXT,
   not_fully_idle INTEGER,
   killed INTEGER,
   last_modified_time TEXT,
   last_user_input_time TEXT,
   workspace_uris TEXT,
   parent_conversation_id TEXT,
   nesting_depth INTEGER
  );
 `);

 const nowIso = new Date().toISOString();
 db.prepare(`
  INSERT INTO conversation_summaries (conversation_id, title, status, not_fully_idle, killed, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth)
  VALUES ('root-1', '主会话', 'CASCADE_RUN_STATUS_RUNNING', 1, 0, ?, '["file:///workspace/demo"]', '', 0),
         ('sub-1', '子会话', 'CASCADE_RUN_STATUS_RUNNING', 1, 0, ?, '["file:///workspace/demo"]', 'root-1', 1);
 `).run(nowIso, nowIso);
 db.close();

 const reminds = [];
 const agy = createAgy({
  home: tmp,
  appDataDir,
  remind: (kind, title, msg) => reminds.push({ kind, title, msg }),
  interval: 100
 });

 agy.start();
 await new Promise(r => setTimeout(r, 250));

 const snap = agy.snapshot();
 // 子会话 sub-1 应该被过滤掉，只收录 root-1
 assert.equal(snap.sessions.length, 1);
 assert.equal(snap.sessions[0].id, 'agy:root-1');
 assert.equal(snap.sessions[0].state, 'working');
 assert.equal(snap.sessions[0].directory, '/workspace/demo');

 // 更新状态为 idle
 const db2 = new mod.DatabaseSync(dbPath);
 db2.prepare(`UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = 'root-1'`).run();
 db2.close();

 await new Promise(r => setTimeout(r, 250));
 const unviewed = agy.unviewed();
 assert.ok(unviewed.includes('agy:root-1'));

 const acked = agy.acknowledge('agy:root-1');
 assert.equal(acked, true);
 // acked 后 snapshot 不再列出已结束的会话
 assert.equal(agy.snapshot().sessions.length, 0);

 agy.stop();
 await fs.rm(tmp, { recursive: true, force: true });
});
