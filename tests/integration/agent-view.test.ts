// tests/integration/agent-view.test.ts
// End-to-end Agent View integration tests.
// All `claude` CLI calls are mocked via mock.module('node:child_process')
// (same pattern as tests/unit/agent-view/manager.test.ts).
// AgentSnapshotFetcher.fetch is patched directly to return synthesized
// sessions — no real `claude agents --json` invocation.

import { beforeEach, describe, expect, test, mock, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'node:util';
import { config } from '../../src/utils/config';
import type { AgentSession } from '../../src/agent-view/types';

// ── Mock node:child_process so handlePeek / handleStop / handleRefreshPeek
// don't shell out to a real `claude` binary.
const execFileMock = Object.assign(
  mock(
    (
      _cmd: string,
      _args: string[],
      cb: (err: any, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
    },
  ),
  {
    [promisify.custom]: (
      cmd: string,
      args: string[],
      _opts?: any,
    ): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        execFileMock(cmd, args, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      }),
  },
);

mock.module('node:child_process', () => {
  const real = require('node:child_process');
  return { ...real, execFile: execFileMock };
});

// v2.2.1: 不 mock roster-source。Integration test 走真 readRoster,
// 通过把 HOME 指向带 controlled roster.json 的 tmpdir 来注入测试数据。
// mock.module 已被移除,避免它拦截真函数。

// Source imports — placed AFTER the mock.module calls above so the mocks
// intercept when snapshot-fetcher pulls in roster-source via destructure.
import { AgentViewManager } from '../../src/agent-view/manager';
import { UserManager } from '../../src/feishu/mapping';
import { AgentSnapshotFetcher, _jobStateHooks } from '../../src/agent-view/snapshot-fetcher';

// ── Per-test tempdir + restore snapshot fetcher mock between tests.
let tmpDir: string;
const origFetch = AgentSnapshotFetcher.fetch;

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetch;
});

// v2.2.1: 必须在每个 test 前重置 AgentSnapshotFetcher.fetch,
// 否则之前 test 里 (AgentSnapshotFetcher as any).fetch = mock(...) 的 override
// 会泄漏到下一个 test,影响 mock.execFile 的期望(只对真 fetch 路径生效)。
const origReadAllJobStates = _jobStateHooks.readAllJobStates;
beforeEach(() => {
  (AgentSnapshotFetcher as any).fetch = origFetch;
  execFileMock.mockReset();
  // smoke test 默认成功(空 JSON 即可,fetch 不再 trust 它的内容)
  execFileMock.mockImplementation((_cmd: string, _args: string[], cb: any) => cb(null, '[]', ''));
  _jobStateHooks.readAllJobStates = origReadAllJobStates;
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeBusySession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1234,
    cwd: '/tmp/proj',
    kind: 'background',
    startedAt: Date.now() - 60_000,
    sessionId: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    name: 'busy-task',
    status: 'busy',
    ...over,
  };
}

function makeWaitingSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1235,
    cwd: '/tmp/proj',
    kind: 'background',
    startedAt: Date.now() - 30_000,
    sessionId: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
    name: 'waiting-task',
    status: 'waiting',
    waitingFor: 'awaiting user reply',
    ...over,
  };
}

function makeIdleSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1236,
    cwd: '/tmp/proj',
    kind: 'background',
    startedAt: Date.now() - 90_000,
    sessionId: 'cccccccc-3333-3333-3333-cccccccccccc',
    name: 'idle-task',
    status: 'idle',
    ...over,
  };
}

function makeEnv() {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-int-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const cardReplyFn = mock(async (_card: string, _opts: any) => 'om_card_001');
  const patchFn = mock(async (_messageId: string, _card: string) => null);
  const replyFn = mock(async (_text: string, _opts: any) => null);
  const runChatSDK = mock(async () => ({ result: {}, handler: {}, cardMessageId: '' }));
  const mgr = new AgentViewManager({
    userManager,
    replyFn,
    cardReplyFn,
    patchFn,
    runChatSDK: runChatSDK as any,
  });
  return { mgr, userManager, cardReplyFn, patchFn, replyFn, runChatSDK };
}

describe('Agent View end-to-end', () => {
  test('list shows mixed groups (busy + waiting + idle)', async () => {
    const { mgr, cardReplyFn } = makeEnv();
    const busy = makeBusySession();
    const waiting = makeWaitingSession();
    const idle = makeIdleSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy, waiting, idle],
    }));

    await mgr.handleList('ou_e2e_list');

    // 卡片通过 cardReplyFn 发出
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const card = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // 三个 group header(busy/waiting/idle)都要出现
    const mdContents = (card.elements as any[])
      .filter(e => e.tag === 'markdown')
      .map(e => e.content)
      .join('\n');
    expect(mdContents).toMatch(/处理中/);
    expect(mdContents).toMatch(/等待输入/);
    expect(mdContents).toMatch(/空闲/);
    // 三个 session 名称都要出现
    expect(mdContents).toContain('busy-task');
    expect(mdContents).toContain('waiting-task');
    expect(mdContents).toContain('idle-task');
  });

  test('reply happy path: waiting → reply text → runChatSDK invoked → expectedReply cleared', async () => {
    const { mgr, userManager, runChatSDK, replyFn, cardReplyFn } = makeEnv();
    const waiting = makeWaitingSession();

    // 第一次 fetch(handleList 用)返回 list
    // 后续 fetch(handleReplyRequest / handleReply 的 status guard)都返回 waiting
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    // Step 1: 触发 list,生成 last_agent_list_card entry
    await mgr.handleList('ou_e2e_reply');
    expect(userManager.getEntry('ou_e2e_reply')?.type).toBe('last_agent_list_card');

    // Step 2: 模拟用户点 [Reply] → handleReplyRequest
    replyFn.mockClear();
    runChatSDK.mockClear();
    await mgr.handleReplyRequest(
      'ou_e2e_reply',
      waiting.sessionId.slice(0, 8),
      waiting.sessionId,
      waiting.cwd,
    );

    // expectedReply 已设置
    const info = mgr.expectedReply.get('ou_e2e_reply');
    expect(info).toBeDefined();
    expect(info?.sessionId).toBe(waiting.sessionId);
    // v2.3.13:Reply prompt 从纯文本升级到交互卡(cardReplyFn),含 session 名 / 等待原因 /
    // Peek 内容 / [❌ 取消等待] 按钮 — 用户不用回去翻 list 才能看到 AI 上一句问的啥。
    expect(cardReplyFn).toHaveBeenCalled();
    expect(
      cardReplyFn.mock.calls.some((c: any[]) =>
        /回复 ·|waiting-task|agent_view_cancel_reply/.test(JSON.stringify(c[0])),
      ),
    ).toBe(true);

    // Step 3: 模拟用户发送了回复文字 → handleReply
    replyFn.mockClear();
    cardReplyFn.mockClear();
    runChatSDK.mockClear();
    await mgr.handleReply('ou_e2e_reply', '这是我的回复');

    // runChatSDK 被调用,promptText 正确
    expect(runChatSDK).toHaveBeenCalledTimes(1);
    const callArg = runChatSDK.mock.calls[0][0] as any;
    expect(callArg.promptText).toBe('这是我的回复');
    expect(callArg.sessionUuid).toBe(waiting.sessionId);
    expect(callArg.isNew).toBe(false);

    // expectedReply 已被清除(try/finally 保证)
    expect(mgr.expectedReply.get('ou_e2e_reply')).toBeUndefined();
    expect(userManager.getEntry('ou_e2e_reply')).toBeUndefined();
  });

  test('reply rejected when status changed to busy (Step B re-guard)', async () => {
    const { mgr, userManager, runChatSDK, replyFn } = makeEnv();
    const waiting = makeWaitingSession();

    // 模拟时间线:Step A 时 session 还是 waiting;Step B 时已切到 busy。
    // fetch 调用序列:
    //   1. handleList → waiting
    //   2. handleReplyRequest (Step A 的 status guard) → waiting(否则会拒绝)
    //   3. handleReply (Step B 的 status guard) → busy(应拒绝)
    let fetchCall = 0;
    (AgentSnapshotFetcher as any).fetch = mock(async () => {
      fetchCall++;
      if (fetchCall <= 2) {
        return { ok: true, sessions: [waiting] };
      }
      // 第三次及之后:session 已切到 busy
      return { ok: true, sessions: [{ ...waiting, status: 'busy' }] };
    });

    // 触发 list
    await mgr.handleList('ou_e2e_busy');
    expect(userManager.getEntry('ou_e2e_busy')?.type).toBe('last_agent_list_card');

    // Step A: 模拟用户点 [Reply]
    replyFn.mockClear();
    runChatSDK.mockClear();
    await mgr.handleReplyRequest(
      'ou_e2e_busy',
      waiting.sessionId.slice(0, 8),
      waiting.sessionId,
      waiting.cwd,
    );
    // expectedReply 已设置
    expect(mgr.expectedReply.get('ou_e2e_busy')).toBeDefined();

    // Step B: 此时 session 已变成 busy,handleReply 应拒绝(Step B re-guard)
    replyFn.mockClear();
    runChatSDK.mockClear();
    await mgr.handleReply('ou_e2e_busy', '迟到的回复');

    // runChatSDK 不应被调用
    expect(runChatSDK).not.toHaveBeenCalled();
    // 应当回复"无法 reply"
    expect(replyFn).toHaveBeenCalled();
    expect(replyFn.mock.calls.some((c: any[]) => /已切换到 busy/.test(c[0]))).toBe(true);

    // expectedReply 仍被清理(try/finally)
    expect(mgr.expectedReply.get('ou_e2e_busy')).toBeUndefined();
    expect(userManager.getEntry('ou_e2e_busy')).toBeUndefined();
  });

  test('v2.2.2 (v2.3 adapted): only sub-agents (spare) are filtered; slash and fleet are kept (TUI parity)', async () => {
    // v2.3:数据源切到 state.json,roster 仍是 source 标签兜底。
    // 喂 3 个 envelope + 真 roster.json(slash/spare/fleet 各一)→ 验证只 spare 被过滤。
    const fakeHome = mkdtempSync(join(tmpdir(), 'agent-view-int-roster-'));
    const rosterDir = join(fakeHome, '.claude', 'daemon');
    require('fs').mkdirSync(rosterDir, { recursive: true });
    require('fs').writeFileSync(join(rosterDir, 'roster.json'), JSON.stringify({
      proto: 1,
      updatedAt: 0,
      workers: {
        slash000: { pid: 1, sessionId: 'slash000-1111-2222-3333-444444444444', cwd: '/a', startedAt: 0,
          dispatch: { source: 'slash' } },
        spare000: { pid: 2, sessionId: 'spare000-1111-2222-3333-444444444444', cwd: '/a', startedAt: 0,
          dispatch: { source: 'spare' } },
        fleet000: { pid: 3, sessionId: 'fleet000-1111-2222-3333-444444444444', cwd: '/a', startedAt: 0,
          dispatch: { source: 'fleet' } },
      },
    }));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;

    _jobStateHooks.readAllJobStates = mock(() => [
      { short: 'slash000', path: '/x', mtimeMs: 1000, readAt: 1000,
        state: { state: 'running', detail: null, needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'user-dispatched-task', nameSource: 'auto',
          resumeSessionId: 'slash000-1111-2222-3333-444444444444', cwd: '/a' } },
      { short: 'spare000', path: '/x', mtimeMs: 1000, readAt: 1000,
        state: { state: 'running', detail: null, needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'sub-agent-spare', nameSource: 'auto',
          resumeSessionId: 'spare000-1111-2222-3333-444444444444', cwd: '/a' } },
      { short: 'fleet000', path: '/x', mtimeMs: 1000, readAt: 1000,
        state: { state: 'running', detail: null, needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'daemon-internal-fleet', nameSource: 'auto',
          resumeSessionId: 'fleet000-1111-2222-3333-444444444444', cwd: '/a' } },
    ]) as any;

    try {
      const { mgr, cardReplyFn } = makeEnv();
      await mgr.handleList('ou_e2e_subagent_filter');

      expect(cardReplyFn).toHaveBeenCalledTimes(1);
      const card = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
      const md = (card.elements as any[])
        .filter(e => e.tag === 'markdown')
        .map(e => e.content)
        .join('\n');
      // v2.2.2:slash + fleet 都要展示,只 spare 被过滤
      expect(md).toContain('user-dispatched-task');
      expect(md).toContain('daemon-internal-fleet');
      expect(md).not.toContain('sub-agent-spare');
      // v2.3 tooltip:数据源改成 state.json
      expect(md).toContain('state.json');
    } finally {
      process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test('v2.2.1 (v2.3 adapted): when roster is unreadable, all sessions are kept (graceful degradation)', async () => {
    // 模拟 daemon 跑着但 roster.json 损坏:文件存在(DaemonProbe pass)
    // 但 JSON.parse 失败(readRoster 返回 null)
    // filterUserDispatched 保留所有 source='unknown' session
    const fakeHome = mkdtempSync(join(tmpdir(), 'agent-view-int-noroster-'));
    const rosterDir = join(fakeHome, '.claude', 'daemon');
    require('fs').mkdirSync(rosterDir, { recursive: true });
    // 写一个会让 JSON.parse 失败的内容(空文件 / 非法 JSON)
    require('fs').writeFileSync(join(rosterDir, 'roster.json'), '', 'utf8');
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;

    _jobStateHooks.readAllJobStates = mock(() => [
      { short: 'uuidaaaa', path: '/x', mtimeMs: 1000, readAt: 1000,
        state: { state: 'running', detail: null, needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'task-a', nameSource: 'auto',
          resumeSessionId: 'uuidaaaa-1111-2222-3333-333333333333', cwd: '/a' } },
      { short: 'uuidbbbb', path: '/x', mtimeMs: 2000, readAt: 2000,
        state: { state: 'done', detail: 'finished', needs: null, inFlight: null,
          linkScanPath: '/p.jsonl', linkScanOffset: 0,
          name: 'task-b', nameSource: 'auto',
          resumeSessionId: 'uuidbbbb-1111-2222-3333-333333333333', cwd: '/a' } },
    ]) as any;

    try {
      const { mgr, cardReplyFn } = makeEnv();
      await mgr.handleList('ou_e2e_no_roster');

      const card = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
      const md = (card.elements as any[])
        .filter(e => e.tag === 'markdown')
        .map(e => e.content)
        .join('\n');
      expect(md).toContain('task-a');
      expect(md).toContain('task-b');  // ✅ prefix added for done
    } finally {
      process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
