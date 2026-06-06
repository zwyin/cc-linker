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
import { AgentViewManager } from '../../src/agent-view/manager';
import { UserManager } from '../../src/feishu/mapping';
import { config } from '../../src/utils/config';
import { AgentSnapshotFetcher } from '../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../src/agent-view/types';

// ── Mock node:child_process so handlePeek / handleStop / handleRefreshPeek
// don't shell out to a real `claude` binary.
import { promisify } from 'node:util';
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

// ── Per-test tempdir + restore snapshot fetcher mock between tests.
let tmpDir: string;
const origFetch = AgentSnapshotFetcher.fetch;

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetch;
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
    const { mgr, userManager, runChatSDK, replyFn } = makeEnv();
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
    // 触发了"请发送文字消息作为回复"
    expect(replyFn).toHaveBeenCalled();
    expect(replyFn.mock.calls.some((c: any[]) => /回复会话/.test(c[0]))).toBe(true);

    // Step 3: 模拟用户发送了回复文字 → handleReply
    replyFn.mockClear();
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
});
