import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThread, deriveState, linkSource, t3ThreadUrl, isSubagent, latestRun, createT3 } from '../src/t3.mjs';

const now = Date.parse('2026-11-10T01:20:00Z');
const thread = (extra = {}) => ({
  thread_id: 'f21ac8fc-0553-45a6-82b6-28943673aec1',
  title: '支持 T3 Code 会话',
  default_provider: 'opencode',
  created_at: '2026-11-10T01:17:33.545Z',
  updated_at: '2026-11-10T01:19:50.000Z',
  workspace_root: '/Users/dev/bobo',
  payload_json: JSON.stringify({ lineage: { parentThreadId: null, relationshipToParent: null }, worktreePath: null }),
  ...extra,
});
const run = (status, ordinal = 1) => ({ status, ordinal, requested_at: '2026-11-10T01:19:40.000Z', completed_at: status === 'running' || status === 'waiting' ? null : '2026-11-10T01:19:50.000Z' });

test('T3 会话状态：运行、提问、批准、结束、终止与子代理', () => {
  const working = parseThread(thread(), { runs: [run('running')], now });
  assert.equal(working.id, 't3:f21ac8fc-0553-45a6-82b6-28943673aec1');
  assert.equal(working.state, 'working');
  assert.equal(working.directory, '/Users/dev/bobo');
  assert.equal(working.linkSource, 'opencode');
  assert.equal(working.startedAt, Date.parse('2026-11-10T01:17:33.545Z'));

  const asking = parseThread(thread(), { runs: [run('waiting')], requests: [{ kind: 'user_input', status: 'pending', created_at: '2026-11-10T01:19:55.000Z' }], now });
  assert.equal(asking.state, 'waiting');
  assert.equal(asking.detail, '等你回答');

  const approval = parseThread(thread(), { runs: [run('running')], requests: [{ kind: 'command', status: 'pending' }], now });
  assert.equal(approval.state, 'waiting');
  assert.equal(approval.detail, '等待批准');
  assert.equal(deriveState(run('waiting'), [{ kind: 'auth_refresh', status: 'pending' }]), 'working');

  assert.equal(parseThread(thread(), { runs: [run('completed', 2), run('running', 1)], now }).state, 'idle');
  assert.equal(parseThread(thread(), { runs: [run('failed')], now }).state, 'error');
  assert.equal(parseThread(thread(), { runs: [run('interrupted')], now }).state, 'error');
  assert.equal(latestRun([run('completed', 1), run('running', 3)]).ordinal, 3);

  const child = parseThread(thread({ payload_json: JSON.stringify({ lineage: { relationshipToParent: 'subagent' } }) }), { runs: [run('running')], now });
  assert.equal(child, null);
  assert.equal(isSubagent({ lineage: { relationshipToParent: 'fork' } }), false);

  const worktree = parseThread(thread({ payload_json: JSON.stringify({ worktreePath: '/tmp/wt', lineage: {} }) }), { runs: [run('running')], now });
  assert.equal(worktree.directory, '/tmp/wt');
  assert.equal(worktree.name, 'wt');
});

test('T3 深链与来源线路', () => {
  assert.equal(t3ThreadUrl('env-1', 'thread-1'), 't3code://threads/env-1/thread-1');
  assert.equal(t3ThreadUrl('env 1', 't3:a/b'), 't3code://threads/env%201/a%2Fb');
  assert.equal(t3ThreadUrl('', 'thread-1'), '');
  assert.equal(linkSource('claudeAgent'), 'claude');
  assert.equal(linkSource('codex'), 'codex');
  assert.equal(linkSource('cursor'), '');
});

test('超过 15 分钟仍停在运行中的按结束处理，过期会话不进列表', () => {
  const stale = parseThread(thread({ updated_at: '2026-11-10T01:00:00.000Z' }), { runs: [{ status: 'running', ordinal: 1, requested_at: '2026-11-10T01:00:00.000Z' }], now });
  assert.equal(stale.state, 'idle');
});

test('createT3 只收录近期父会话，结束后点击收起', async () => {
  let bundle = { environmentId: 'env-1', threads: [{ ...thread(), runs: [run('running')], requests: [] }] };
  const t3 = createT3({ home: '/tmp/unused', load: async () => bundle, now: () => now, interval: 1e9 });
  await t3.refresh();
  assert.equal(t3.snapshot().sessions.length, 1);
  assert.equal(t3.snapshot().sessions[0].environmentId, 'env-1');
  assert.equal(t3.snapshot().sessions[0].state, 'working');
  bundle = { environmentId: 'env-1', threads: [{ ...thread(), runs: [run('completed')], requests: [] }] };
  await t3.refresh();
  assert.equal(t3.snapshot().sessions[0].state, 'idle');
  assert.equal(t3.acknowledge('t3:f21ac8fc-0553-45a6-82b6-28943673aec1'), true);
  assert.equal(t3.snapshot().sessions.length, 0);
  t3.stop();
});
