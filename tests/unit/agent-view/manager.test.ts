import { beforeEach, describe, expect, test, mock, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

// Mock node:child_process for handlePeek/handleRefreshPeek (T15).
// Plan pattern from snapshot-fetcher.test.ts: re-export real module + override
// execFile. handlePeek uses `await import('node:child_process')` and then
// `promisify(cp.execFile)`, so the mock's execFile must accept the
// (cmd, args, cb) signature and call cb(err, stdout, stderr).
//
// Critical: Node's real execFile exposes `util.promisify.custom` which returns
// `{stdout, stderr}`. Without it, `promisify(execFile)` falls back to the
// generic single-value form, so `result.stdout` is undefined and the call site
// throws. We attach the same symbol so the test mirrors production behavior.
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
      opts?: any,
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
  return {
    ...real,
    execFile: execFileMock,
  };
});

let tmpDir: string;

// Snapshot of the original fetch — restored in afterAll so other test files
// don't see our mocks bleed over (Bun shares the module registry).
const origFetch = AgentSnapshotFetcher.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-mgr-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, cb) => {
    cb(null, '', '');
  });
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetch;
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

function makeMgrWithSpies() {
  const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const cardReplyFn = mock(async (_card: string, _opts: any) => 'om_list_card_001');
  const patchFn = mock(async (_messageId: string, _card: string) => null);
  const replyFn = mock(async (_text: string, _opts: any) => null);
  const mgr = new AgentViewManager({
    userManager,
    replyFn,
    cardReplyFn,
    patchFn,
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
  });
  return { mgr, userManager, cardReplyFn, patchFn, replyFn };
}

describe('AgentViewManager skeleton', () => {
  test('constructs with defaults', () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    expect(mgr.expectedReply).toBeDefined();
    expect(mgr.shouldRefresh()).toBe(true);
  });

  test('shouldRefresh debounces', () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    expect(mgr.shouldRefresh()).toBe(true);
    expect(mgr.shouldRefresh()).toBe(false);
  });
});

describe('handleList', () => {
  test('sends list card on success and saves cardMessageId', async () => {
    const { mgr, userManager, cardReplyFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy, waiting],
    }));

    await mgr.handleList('ou_test_1');

    // 列表卡通过 cardReplyFn 发出,包含两个组(busy + waiting)
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    const groupHeaders = sentCard.elements.filter(
      (e: any) => e.tag === 'markdown' && /（|处理中|等待|空闲/.test(e.content || ''),
    );
    expect(groupHeaders.length).toBeGreaterThanOrEqual(2);

    // cardMessageId 已保存到 user-mapping
    const entry = userManager.getEntry('ou_test_1');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('last_agent_list_card');
    expect(entry?.cardMessageId).toBe('om_list_card_001');
  });

  test('sends empty card when no background sessions', async () => {
    const { mgr, userManager, cardReplyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [],
    }));

    await mgr.handleList('ou_test_2');

    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // 空状态卡 header 是 grey 模板
    expect(sentCard.header.template).toBe('grey');
    // 不应写入 last_agent_list_card entry(空卡不需要 refresh 持久化)
    expect(userManager.getEntry('ou_test_2')).toBeUndefined();
  });

  test('sends error card on fetch failure', async () => {
    const { mgr, cardReplyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: false,
      reason: 'Claude daemon not running',
    }));

    await mgr.handleList('ou_test_3');

    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // 错误卡 template=red
    expect(sentCard.header.template).toBe('red');
    expect(sentCard.elements[0].content).toContain('daemon not running');
  });

  test('caps sessions to 10 in list card (spec §6.1)', async () => {
    const { mgr, cardReplyFn } = makeMgrWithSpies();
    const manySessions = Array.from({ length: 25 }, (_, i) =>
      makeBusySession({
        sessionId: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
        name: `task-${i}`,
      }),
    );
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: manySessions,
    }));

    await mgr.handleList('ou_test_cap');

    // 列表卡只显示前 10 个 — 计数每个 session 行的 markdown 数
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // session 行 markdown 数(emoji + name 标识)
    const sessionRows = sentCard.elements.filter(
      (e: any) => e.tag === 'markdown' && /✽|✋|⏹/.test(e.content || ''),
    );
    expect(sessionRows).toHaveLength(10);
  });

  test('exceeds 25KB triggers text fallback (no card sent)', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    // 构造大量超长 session 让 buildListCard 超过 25KB
    const huge = Array.from({ length: 10 }, (_, i) =>
      makeBusySession({
        sessionId: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
        name: 'x'.repeat(3000) + `-${i}`, // 每个 3KB+,10 个 > 30KB
        cwd: '/very/very/very/long/path/' + 'y'.repeat(200) + '/' + i,
      }),
    );
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: huge,
    }));

    await mgr.handleList('ou_test_big');

    expect(cardReplyFn).not.toHaveBeenCalled();
    expect(replyFn).toHaveBeenCalledTimes(1);
    const fallback = replyFn.mock.calls[0][0] as string;
    expect(fallback).toContain('Agent View');
    expect(fallback).toContain('10 sessions');
  });
});

describe('handleRefreshList', () => {
  test('patches same card with fresh data when messageId matches', async () => {
    const { mgr, userManager, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 1) 先 handleList 建立 last_agent_list_card entry
    const busy = makeBusySession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy],
    }));
    await mgr.handleList('ou_test_4');
    const entry = userManager.getEntry('ou_test_4');
    expect(entry?.cardMessageId).toBe('om_list_card_001');
    expect(cardReplyFn).toHaveBeenCalledTimes(1);

    // 2) 然后 handleRefreshList 用同样的 messageId
    // 关键:handleList 内部把 mock 调成 busy,refresh 期间不变
    await mgr.handleRefreshList('ou_test_4', 'om_list_card_001');

    // patchFn 收到 1 次调用,messageId 匹配
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0][0]).toBe('om_list_card_001');
    const patched = JSON.parse(patchFn.mock.calls[0][1] as string);
    // 应该有 Refresh 按钮(action with agent_view_refresh_list value)
    const hasRefreshBtn = patched.elements.some(
      (e: any) =>
        e.tag === 'action' &&
        e.actions.some((a: any) => a.value?.tag === 'agent_view_refresh_list'),
    );
    expect(hasRefreshBtn).toBe(true);
  });

  test('falls back to handleList when messageId does not match stored entry', async () => {
    const { mgr, userManager, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 先建立 entry
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [makeBusySession()],
    }));
    await mgr.handleList('ou_test_5');
    expect(userManager.getEntry('ou_test_5')?.cardMessageId).toBe('om_list_card_001');

    // 用过期的 messageId 调用 refresh
    cardReplyFn.mockClear();
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_5', 'om_OLD_MESSAGE_ID');

    // 校验失败:应转去 handleList(cardReplyFn 被调),patchFn 不被调
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    expect(patchFn).not.toHaveBeenCalled();
    // 新卡 messageId 替换了旧 entry
    expect(userManager.getEntry('ou_test_5')?.cardMessageId).toBe('om_list_card_001');
  });

  test('no-op when shouldRefresh returns false (debounce)', async () => {
    const { mgr, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 建立 entry
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [makeBusySession()],
    }));
    await mgr.handleList('ou_test_6');
    expect(cardReplyFn).toHaveBeenCalledTimes(1);

    // 第一次 refresh:shouldRefresh=true,会发 patch
    cardReplyFn.mockClear();
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_6', 'om_list_card_001');
    expect(patchFn).toHaveBeenCalledTimes(1);

    // 紧接着第二次 refresh:shouldRefresh=false,无操作
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_6', 'om_list_card_001');
    expect(patchFn).not.toHaveBeenCalled();
  });
});

describe('handlePeek', () => {
  test('builds peek card with session info and stripped log output', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    // ANSI-tagged log output; stripAnsi should remove escape sequences
    const rawLog = [
      '\x1b[32mready\x1b[0m',
      'thinking...',
      '\x1b[1;33mabout to ask user\x1b[0m',
    ].join('\n');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, rawLog, '');
    });

    const shortId = waiting.sessionId.slice(0, 8);
    await mgr.handlePeek('ou_peek_1', shortId, waiting.sessionId, waiting.cwd);

    // cardReplyFn was called exactly once with a peek card
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // Peek card header references the session name
    expect(sentCard.header.title.content).toContain('waiting-task');
    // waitingFor appears in markdown body
    const bodyText = sentCard.elements.map((e: any) => e.content || '').join('\n');
    expect(bodyText).toContain('awaiting user reply');
    // ANSI escapes were stripped from the recent output
    const codeBlock = sentCard.elements.find((e: any) => /Recent output/.test(e.content || ''));
    expect(codeBlock).toBeDefined();
    expect(codeBlock.content).not.toContain('\x1b[');
    expect(codeBlock.content).toContain('ready');
    expect(codeBlock.content).toContain('thinking...');
    // reply button is shown (waiting status) and stop is hidden
    const actions = sentCard.elements.flatMap((e: any) =>
      e.tag === 'action' ? e.actions : [],
    );
    const tags = actions.map((a: any) => a.value?.tag);
    expect(tags).toContain('agent_view_reply_request');
    expect(tags).not.toContain('agent_view_stop');
    // replyFn was not called (we have a session)
    expect(replyFn).not.toHaveBeenCalled();
  });

  test('falls back to replyFn with "会话已不存在" when session is gone', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [], // session vanished
    }));

    await mgr.handlePeek('ou_peek_gone', 'shortid', 'missing-session', '/tmp/whatever');

    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('会话已不存在');
    expect(cardReplyFn).not.toHaveBeenCalled();
  });

  test('honors CC_LINKER_AGENT_VIEW_PEEK_LINES / PEEK_MAX_BYTES env vars', async () => {
    // Save and override config
    const origPeekLines = (config as any).data.agent_view.peek_lines;
    const origPeekMaxBytes = (config as any).data.agent_view.peek_max_bytes;
    (config as any).data.agent_view.peek_lines = 3;
    (config as any).data.agent_view.peek_max_bytes = 100;

    try {
      const { mgr, cardReplyFn } = makeMgrWithSpies();
      const waiting = makeWaitingSession();
      (AgentSnapshotFetcher as any).fetch = mock(async () => ({
        ok: true,
        sessions: [waiting],
      }));
      // 50 行,每行 50 字符
      const rawLog = Array.from({ length: 50 }, (_, i) =>
        `line-${String(i).padStart(2, '0')}-${'a'.repeat(50)}`,
      ).join('\n');
      execFileMock.mockImplementation((_cmd, _args, cb) => {
        cb(null, rawLog, '');
      });

      const shortId = waiting.sessionId.slice(0, 8);
      await mgr.handlePeek('ou_peek_cfg', shortId, waiting.sessionId, waiting.cwd);

      const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
      const codeBlock = sentCard.elements.find((e: any) => /Recent output/.test(e.content || ''));
      const codeText = (codeBlock.content.match(/```\n([\s\S]*?)\n```/) || ['', ''])[1];
      // 行数 <= 3(取后 3 行)
      const lines = codeText.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(3);
      // 总字节 <= 100(truncateBytes)
      const bytes = new TextEncoder().encode(codeText).length;
      expect(bytes).toBeLessThanOrEqual(100);
    } finally {
      // Restore
      (config as any).data.agent_view.peek_lines = origPeekLines;
      (config as any).data.agent_view.peek_max_bytes = origPeekMaxBytes;
    }
  });
});

describe('handleRefreshPeek', () => {
  test('patches peek card with fresh logs when session still exists', async () => {
    const { mgr, cardReplyFn, patchFn, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    const rawLog = '\x1b[36m[refreshed]\x1b[0m line-A\nline-B';
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, rawLog, '');
    });

    const shortId = waiting.sessionId.slice(0, 8);
    await mgr.handleRefreshPeek('ou_rpeek_1', shortId, waiting.sessionId, 'om_peek_001');

    // patchFn called once with the right messageId; cardReplyFn NOT called
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0][0]).toBe('om_peek_001');
    expect(cardReplyFn).not.toHaveBeenCalled();
    expect(replyFn).not.toHaveBeenCalled();

    const sentCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    // Header still references the session name
    expect(sentCard.header.title.content).toContain('waiting-task');
    // Recent output (stripped) appears in the body
    const bodyText = sentCard.elements.map((e: any) => e.content || '').join('\n');
    expect(bodyText).toContain('[refreshed]');
    expect(bodyText).not.toContain('\x1b[');
  });

  test('no-ops when messageId is missing', async () => {
    const { mgr, patchFn, cardReplyFn } = makeMgrWithSpies();
    await mgr.handleRefreshPeek('ou_rpeek_noop', 'shortid', 'session', undefined);
    expect(patchFn).not.toHaveBeenCalled();
    expect(cardReplyFn).not.toHaveBeenCalled();
  });

  test('patches an error card when session has disappeared', async () => {
    const { mgr, patchFn, cardReplyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [],
    }));

    await mgr.handleRefreshPeek('ou_rpeek_gone', 'shortid', 'missing', 'om_peek_002');

    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0][0]).toBe('om_peek_002');
    const sentCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    // Error card template=red with "会话已不存在" header
    expect(sentCard.header.template).toBe('red');
    expect(sentCard.header.title.content).toContain('会话已不存在');
    expect(cardReplyFn).not.toHaveBeenCalled();
  });
});

describe('handleBackToChat', () => {
  test('sends exit text via replyFn and does not touch cards', async () => {
    const { mgr, replyFn, cardReplyFn, patchFn } = makeMgrWithSpies();
    await mgr.handleBackToChat('ou_back_1');
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('已退出 Agent View');
    expect(cardReplyFn).not.toHaveBeenCalled();
    expect(patchFn).not.toHaveBeenCalled();
  });

  test('clears any pending expectedReply before replying', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    // Seed a pending_agent_reply so the user was mid-reply
    await mgr.expectedReply.set('ou_back_pending', {
      shortId: waiting.sessionId.slice(0, 8),
      sessionId: waiting.sessionId,
      cwd: waiting.cwd,
    });
    expect(userManager.getEntry('ou_back_pending')?.type).toBe('pending_agent_reply');

    await mgr.handleBackToChat('ou_back_pending');

    // expectedReply 已被清掉(无论是否之前有 pending,都安全 clear)
    expect(mgr.expectedReply.get('ou_back_pending')).toBeUndefined();
    expect(userManager.getEntry('ou_back_pending')).toBeUndefined();
    // replyFn 仍然发了退出文本
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('已退出 Agent View');
  });
});

describe('handleReplyRequest (Step A)', () => {
  test('rejects when status is not waiting', async () => {
    const { mgr, replyFn, patchFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy],
    }));

    await mgr.handleReplyRequest('ou_rr_busy', busy.sessionId.slice(0, 8), busy.sessionId, busy.cwd);

    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('不是 waiting');
    // No card patched and no expectedReply set
    expect(patchFn).not.toHaveBeenCalled();
    expect(mgr.expectedReply.get('ou_rr_busy')).toBeUndefined();
  });

  test('sets expectedReply and patches the list card on success', async () => {
    const { mgr, userManager, replyFn, patchFn, cardReplyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    // Seed a last_agent_list_card entry so handleReplyRequest patches it.
    await mgr.handleList('ou_rr_ok');
    const listEntry = userManager.getEntry('ou_rr_ok');
    expect(listEntry?.type).toBe('last_agent_list_card');
    patchFn.mockClear();
    cardReplyFn.mockClear();
    replyFn.mockClear();

    await mgr.handleReplyRequest('ou_rr_ok', waiting.sessionId.slice(0, 8), waiting.sessionId, waiting.cwd);

    // expectedReply set
    const info = mgr.expectedReply.get('ou_rr_ok');
    expect(info).toBeDefined();
    expect(info?.sessionId).toBe(waiting.sessionId);
    expect(info?.cwd).toBe(waiting.cwd);
    // List card patched first with a waiting card (yellow template)
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0][0]).toBe('om_list_card_001');
    const patched = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(patched.header.template).toBe('yellow');
    // Prompt text sent
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('回复会话');

    // Clean up timer
    await mgr.expectedReply.clear('ou_rr_ok');
  });
});

describe('handleReply (Step B)', () => {
  test('no-op when no expectedReply pending', async () => {
    const { mgr } = makeMgrWithSpies();
    const runSpy = mock(async () => ({ result: {}, handler: {}, cardMessageId: '' }));
    mgr.deps.runChatSDK = runSpy as any;
    await mgr.handleReply('ou_reply_nop', 'hello');
    expect(runSpy).not.toHaveBeenCalled();
  });

  test('clears expectedReply after runChatSDK success', async () => {
    const { mgr, userManager } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    await mgr.expectedReply.set('ou_reply_ok', {
      shortId: waiting.sessionId.slice(0, 8),
      sessionId: waiting.sessionId,
      cwd: waiting.cwd,
    });
    const runSpy = mock(async () => ({ result: {}, handler: {}, cardMessageId: '' }));
    mgr.deps.runChatSDK = runSpy as any;

    await mgr.handleReply('ou_reply_ok', 'hello back');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect((runSpy.mock.calls[0][0] as any).promptText).toBe('hello back');
    expect(mgr.expectedReply.get('ou_reply_ok')).toBeUndefined();
    expect(userManager.getEntry('ou_reply_ok')).toBeUndefined();
  });

  test('clears expectedReply even when runChatSDK throws (try/finally)', async () => {
    const { mgr, userManager } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    await mgr.expectedReply.set('ou_reply_err', {
      shortId: waiting.sessionId.slice(0, 8),
      sessionId: waiting.sessionId,
      cwd: waiting.cwd,
    });
    mgr.deps.runChatSDK = (async () => {
      throw new Error('runChatSDK boom');
    }) as any;

    // handleReply should swallow downstream errors so the user is not stuck;
    // either way the expectedReply slot must be cleared.
    let caught: any;
    try {
      await mgr.handleReply('ou_reply_err', 'kaboom');
    } catch (err) {
      caught = err;
    }
    // The try/finally re-throws; what matters is the slot was cleared.
    expect(mgr.expectedReply.get('ou_reply_err')).toBeUndefined();
    expect(userManager.getEntry('ou_reply_err')).toBeUndefined();
    // We accept either swallowed or rethrown — assert behavior matches code: rethrows.
    expect(caught?.message).toBe('runChatSDK boom');
  });
});

describe('handleCancelReply', () => {
  test('clears expectedReply and sends confirmation', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    await mgr.expectedReply.set('ou_cancel', {
      shortId: waiting.sessionId.slice(0, 8),
      sessionId: waiting.sessionId,
      cwd: waiting.cwd,
    });
    expect(userManager.getEntry('ou_cancel')?.type).toBe('pending_agent_reply');

    await mgr.handleCancelReply('ou_cancel');

    expect(mgr.expectedReply.get('ou_cancel')).toBeUndefined();
    expect(userManager.getEntry('ou_cancel')).toBeUndefined();
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('已取消等待');
  });

  test('silent when nothing is pending (no spam "已取消" reply)', async () => {
    const { mgr, replyFn } = makeMgrWithSpies();
    // No expectedReply set for this openId
    expect(mgr.expectedReply.get('ou_cancel_nop')).toBeUndefined();

    await mgr.handleCancelReply('ou_cancel_nop');

    // replyFn 未被调 — 用户没要求取消任何东西
    expect(replyFn).not.toHaveBeenCalled();
  });
});

describe('handleStop (T20)', () => {
  test('sends a stop confirm card via cardReplyFn', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    const shortId = busy.sessionId.slice(0, 8);

    const result = await mgr.handleStop('ou_stop_1', shortId, busy.sessionId, busy.name);

    // cardReplyFn was called with a stop-confirm card (red template, has
    // agent_view_stop_confirm button) and returns the new messageId
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    expect(sentCard.header.template).toBe('red');
    expect(sentCard.header.title.content).toContain(busy.name);
    const actions = sentCard.elements.flatMap((e: any) =>
      e.tag === 'action' ? e.actions : [],
    );
    const tags = actions.map((a: any) => a.value?.tag);
    expect(tags).toContain('agent_view_stop_confirm');
    // 确认按钮要带 shortId + sessionId
    const confirmBtn = actions.find(
      (a: any) => a.value?.tag === 'agent_view_stop_confirm',
    );
    expect(confirmBtn.value.shortId).toBe(shortId);
    expect(confirmBtn.value.sessionId).toBe(busy.sessionId);
    // replyFn 没被调(确认卡是独立卡)
    expect(replyFn).not.toHaveBeenCalled();
    // 返回值是 cardMessageId
    expect(result).toBe('om_list_card_001');
  });
});

describe('handleStopConfirm (T21)', () => {
  test('calls execFile with claude stop <shortId>, sleeps 1s, replies + refreshes list', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    const shortId = busy.sessionId.slice(0, 8);

    // Mock fetch to return one session so handleList is a happy path
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy],
    }));
    // Capture execFile invocations
    const calls: Array<{ cmd: string; args: string[] }> = [];
    execFileMock.mockImplementation((cmd, args, cb) => {
      calls.push({ cmd, args });
      cb(null, '', '');
    });

    await mgr.handleStopConfirm('ou_stop_c_1', shortId, busy.sessionId);

    // execFile('claude', ['stop', shortId]) was called
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual(['stop', shortId]);
    // replyFn 发出 ✅ 已停止 <shortId>
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('已停止');
    expect(replyFn.mock.calls[0][0]).toContain(shortId);
    // cardReplyFn 被调(由 handleList 内部发列表卡)
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
  });

  test('replies with ❌ on execFile error and does not call handleList', async () => {
    const { mgr, cardReplyFn, replyFn } = makeMgrWithSpies();
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(new Error('claude binary not found'), '', 'not found');
    });

    await mgr.handleStopConfirm('ou_stop_c_err', 'shortid', 'session');

    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('Stop 失败');
    expect(replyFn.mock.calls[0][0]).toContain('claude binary not found');
    // 没有触发 handleList(cardReplyFn 不被调)
    expect(cardReplyFn).not.toHaveBeenCalled();
  });
});

describe('handleAttach (T22 — two-step CAS)', () => {
  test('attaches a fresh user (no prior entry) and writes a session entry', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy],
    }));

    await mgr.handleAttach('ou_attach_1', busy.sessionId, busy.sessionId.slice(0, 8), busy.name, busy.cwd);

    // 写入了 session entry
    const entry = userManager.getEntry('ou_attach_1');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('session');
    expect(entry?.sessionUuid).toBe(busy.sessionId);
    expect(entry?.cwd).toBe(busy.cwd);
    // 回复里含 "已 Attach 到" + busy name
    expect(replyFn).toHaveBeenCalledTimes(1);
    const replyText = replyFn.mock.calls[0][0] as string;
    expect(replyText).toContain('已 Attach 到');
    expect(replyText).toContain(busy.name);
    expect(replyText).toContain('Status: busy');
    expect(replyText).toContain('正在处理中'); // busy 状态警告
  });

  test('two-step CAS: clears old entry FIRST, then writes new session entry', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();

    // Seed an old session entry that we'll replace
    await userManager.compareAndSwap('ou_attach_swap', null, {
      type: 'session',
      sessionUuid: 'old-session-uuid',
      createdAt: new Date().toISOString(),
    });
    const oldEntry = userManager.getEntry('ou_attach_swap');
    expect(oldEntry?.type).toBe('session');
    expect(oldEntry?.sessionUuid).toBe('old-session-uuid');

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    await mgr.handleAttach('ou_attach_swap', waiting.sessionId, waiting.sessionId.slice(0, 8), waiting.name, waiting.cwd);

    // New session entry is in place
    const newEntry = userManager.getEntry('ou_attach_swap');
    expect(newEntry?.type).toBe('session');
    expect(newEntry?.sessionUuid).toBe(waiting.sessionId);
    expect(newEntry?.cwd).toBe(waiting.cwd);
    // waiting 状态:含 "等待原因"
    const replyText = replyFn.mock.calls[0][0] as string;
    expect(replyText).toContain('等待原因');
    expect(replyText).toContain(waiting.waitingFor);
  });

  test('preserves defaultProvider from old entry when swapping', async () => {
    const { mgr, userManager } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    // Seed an old entry WITH defaultProvider
    await userManager.compareAndSwap('ou_attach_dp', null, {
      type: 'session',
      sessionUuid: 'old-session-uuid',
      createdAt: new Date().toISOString(),
      defaultProvider: 'sonnet',
    });

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    await mgr.handleAttach('ou_attach_dp', waiting.sessionId, waiting.sessionId.slice(0, 8), waiting.name, waiting.cwd);

    const newEntry = userManager.getEntry('ou_attach_dp');
    expect(newEntry?.defaultProvider).toBe('sonnet');
  });

  test('replies "会话已不存在" when target session is not in snapshot', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [], // no sessions
    }));

    await mgr.handleAttach('ou_attach_gone', 'missing-session', 'shortid', 'whatever', '/tmp');

    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('会话已不存在');
    // 没有写 entry
    expect(userManager.getEntry('ou_attach_gone')).toBeUndefined();
  });

  test('replies "状态冲突" when first CAS fails (concurrent modification)', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();

    // Seed old entry
    await userManager.compareAndSwap('ou_attach_cas_fail', null, {
      type: 'session',
      sessionUuid: 'old-session-uuid',
      createdAt: new Date().toISOString(),
    });

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    // 模拟并发:在 handleAttach 的 CAS 1 之前,外部已经改了 entry
    // 用一个 spy 替换 getEntry 让它在 handleAttach 调用时返回"过期的" entry
    // 简化:直接 inject 一个 stale snapshot — 跳过复杂 mock
    // 我们改用:第一次 getEntry 返回老 entry,handleAttach CAS 1 调用前 mutate
    let firstGetEntry = true;
    const origGetEntry = userManager.getEntry.bind(userManager);
    userManager.getEntry = (openId: string) => {
      if (firstGetEntry && openId === 'ou_attach_cas_fail') {
        firstGetEntry = false;
        // 返回被外部 mutate 过的 entry(handleAttach 拿到这个去 CAS 会失败)
        const e = origGetEntry(openId);
        if (e) {
          // 模拟外部在 handleAttach 调 getEntry 之后立即把 entry CAS 改了
          // 我们用 setTimeout 在下一个 tick 改
          setTimeout(() => {
            // 同步 mutate:直接把 oldEntry.casToken 改掉(CAS token 是 entriesMatch 的字段之一)
            // — 但更可靠的是:我们直接让 compareAndSwap 失败(改 expected)
            // 这里用更直接的方式:替换 getEntry 的二次调用,让它在 compareAndSwap 内部
            // 看到的 current 不匹配 expected。
            void e; // unused — see below
          }, 0);
        }
        return e;
      }
      return origGetEntry(openId);
    };
    // 更直接地:把 handleAttach 内部的 CAS 1 失败通过重写 compareAndSwap 来模拟
    let casCallCount = 0;
    const origCas = userManager.compareAndSwap.bind(userManager);
    userManager.compareAndSwap = async (...args: any[]): Promise<boolean> => {
      casCallCount++;
      if (casCallCount === 1) {
        // CAS 1 (clear old entry) 失败:模拟外部已抢先改了
        return false;
      }
      return origCas(...args);
    };

    await mgr.handleAttach('ou_attach_cas_fail', waiting.sessionId, waiting.sessionId.slice(0, 8), waiting.name, waiting.cwd);

    // 第一次 CAS 失败时,应发 "状态冲突"
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('状态冲突');
    // entry 仍然是旧的(没有被清掉)
    const entry = userManager.getEntry('ou_attach_cas_fail');
    expect(entry?.sessionUuid).toBe('old-session-uuid');

    // restore
    userManager.getEntry = origGetEntry;
    userManager.compareAndSwap = origCas;
  });

  test('replies "状态冲突" when second CAS (write new) fails', async () => {
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    // Seed an old entry so CAS 1 is invoked
    await userManager.compareAndSwap('ou_attach_cas2', null, {
      type: 'session',
      sessionUuid: 'old-session-uuid',
      createdAt: new Date().toISOString(),
    });

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    // Mock:第一次 CAS 成功(清空),第二次 CAS 失败(写新 entry 失败)
    let casCallCount = 0;
    const origCas = userManager.compareAndSwap.bind(userManager);
    userManager.compareAndSwap = async (...args: any[]): Promise<boolean> => {
      casCallCount++;
      if (casCallCount === 2) return false;
      return origCas(...args);
    };

    await mgr.handleAttach('ou_attach_cas2', waiting.sessionId, waiting.sessionId.slice(0, 8), waiting.name, waiting.cwd);

    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('状态冲突');
    // entry 不应该是 session(第一次清空后第二次 CAS 失败,没写回)
    const entry = userManager.getEntry('ou_attach_cas2');
    expect(entry?.type).not.toBe('session');

    userManager.compareAndSwap = origCas;
  });

  // v2.2 修正:expectedReply.clear() 不再无条件早于 CAS 1/CAS 2
  test('v2.2: preserves expectedReply on CAS 1 failure when old entry was a SESSION (not pending_agent_reply)', async () => {
    // 关键:旧 entry 是普通 session,不是 pending_agent_reply
    // 旧逻辑会在 CAS 1 之前无条件 expectedReply.clear() — 这里不应该有 pending reply 被清掉
    // 新逻辑:仅当 oldEntry.type === 'pending_agent_reply' 时才 clear
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();

    // Seed a SESSION entry (not pending_agent_reply)
    await userManager.compareAndSwap('ou_attach_v22_preserve', null, {
      type: 'session',
      sessionUuid: 'old-session-uuid',
      createdAt: new Date().toISOString(),
    });

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    // Make CAS 1 fail
    const origCas = userManager.compareAndSwap.bind(userManager);
    userManager.compareAndSwap = async (...args: any[]): Promise<boolean> => {
      return false; // 第一次就失败
    };

    let expectedReplyCleared = false;
    // 由于 oldEntry 不是 pending_agent_reply,expectedReply.clear() 不会做任何事
    // (ExpectedReplyState.clear 检查 current?.type !== 'pending_agent_reply' 直接 return)
    // 这里我们 spy clear 来验证它是否被调用
    const origClear = mgr.expectedReply.clear.bind(mgr.expectedReply);
    mgr.expectedReply.clear = async (...args: any[]): Promise<void> => {
      expectedReplyCleared = true;
      return origClear(...args);
    };

    await mgr.handleAttach(
      'ou_attach_v22_preserve',
      waiting.sessionId,
      waiting.sessionId.slice(0, 8),
      waiting.name,
      waiting.cwd,
    );

    // CAS 1 失败时,expectedReply.clear() 不应该被调用(oldEntry 是 session 不是 pending_agent_reply)
    expect(expectedReplyCleared).toBe(false);
    expect(replyFn).toHaveBeenCalledTimes(1);
    expect(replyFn.mock.calls[0][0]).toContain('状态冲突');

    userManager.compareAndSwap = origCas;
    mgr.expectedReply.clear = origClear;
  });

  test('v2.2: clears expectedReply when old entry IS pending_agent_reply (transition case)', async () => {
    // 当 oldEntry 是 pending_agent_reply,必须先 clear 它才能 CAS 到 session
    // 这是 spec 描述的过渡 case
    const { mgr, userManager, replyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();

    // Seed a pending_agent_reply entry
    await userManager.compareAndSwap('ou_attach_v22_pending', null, {
      type: 'pending_agent_reply',
      sessionUuid: 'old-session-uuid',
      shortId: 's1',
      cwd: '/tmp',
      createdAt: new Date().toISOString(),
      timeoutMs: 300_000,
    });

    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));

    let expectedReplyCleared = false;
    const origClear = mgr.expectedReply.clear.bind(mgr.expectedReply);
    mgr.expectedReply.clear = async (...args: any[]): Promise<void> => {
      expectedReplyCleared = true;
      return origClear(...args);
    };

    await mgr.handleAttach(
      'ou_attach_v22_pending',
      waiting.sessionId,
      waiting.sessionId.slice(0, 8),
      waiting.name,
      waiting.cwd,
    );

    // expectedReply.clear() 必须被调用(它会做自己的 CAS 把 pending_agent_reply 清掉)
    expect(expectedReplyCleared).toBe(true);
    // 写入了 session entry
    const entry = userManager.getEntry('ou_attach_v22_pending');
    expect(entry?.type).toBe('session');
    expect(entry?.sessionUuid).toBe(waiting.sessionId);
    expect(replyFn.mock.calls[0][0]).toContain('已 Attach 到');

    mgr.expectedReply.clear = origClear;
  });
});

describe('resolvePeekContent (v2.2.8 three-tier resolver)', () => {
  // Swap _peekHooks for these tests so we don't touch real ~/.claude/projects /
  // roster.json. Restore in afterEach to keep other tests isolated.
  const origHooks = { ...AgentViewManager._peekHooks };
  beforeEach(() => {
    AgentViewManager._peekHooks = { ...origHooks };
  });

  test('Tier 1 hit: own JSONL has assistant text', async () => {
    const { mgr } = makeMgrWithSpies();
    AgentViewManager._peekHooks.findJsonlForShort = () => '/fake/own.jsonl';
    AgentViewManager._peekHooks.extractRecentAssistantText = (path: string) => {
      if (path === '/fake/own.jsonl') return 'last assistant text';
      return null;
    };
    AgentViewManager._peekHooks.readRoster = () => null;
    AgentViewManager._peekHooks.lookupResumeFromPath = () => null;

    const result = await mgr.resolvePeekContent('shortid1', 1000);
    expect(result.text).toBe('last assistant text');
    expect(result.format).toBe('markdown');
  });

  test('Tier 2 hit: own JSONL empty, parent JSONL has assistant text', async () => {
    const { mgr } = makeMgrWithSpies();
    AgentViewManager._peekHooks.findJsonlForShort = () => '/fake/own.jsonl';
    AgentViewManager._peekHooks.extractRecentAssistantText = (path: string) => {
      if (path === '/fake/parent.jsonl') return 'parent assistant text';
      return null; // own returns null → tier 1 miss
    };
    AgentViewManager._peekHooks.readRoster = () => ({} as any);
    AgentViewManager._peekHooks.lookupResumeFromPath = (_r: any, short: string) =>
      short === 'shortid2' ? '/fake/parent.jsonl' : null;

    const result = await mgr.resolvePeekContent('shortid2', 1000);
    expect(result.text).toBe('parent assistant text');
    expect(result.format).toBe('markdown');
  });

  test('Tier 3 fallback: both JSONL tiers miss, claude logs returns terminal output', async () => {
    const { mgr } = makeMgrWithSpies();
    AgentViewManager._peekHooks.findJsonlForShort = () => null;
    AgentViewManager._peekHooks.extractRecentAssistantText = () => null;
    AgentViewManager._peekHooks.readRoster = () => null;
    AgentViewManager._peekHooks.lookupResumeFromPath = () => null;
    execFileMock.mockImplementation((cmd, args, cb) => {
      if (cmd === 'claude' && args[0] === 'logs') {
        cb(null, '\x1b[32mfallback terminal line\x1b[0m', '');
        return;
      }
      cb(null, '', '');
    });

    const result = await mgr.resolvePeekContent('shortid3', 1000);
    expect(result.text).toContain('fallback terminal line');
    expect(result.text).not.toContain('\x1b[');
    expect(result.format).toBe('terminal');
  });

  test('all tiers miss: returns null text', async () => {
    const { mgr } = makeMgrWithSpies();
    AgentViewManager._peekHooks.findJsonlForShort = () => null;
    AgentViewManager._peekHooks.extractRecentAssistantText = () => null;
    AgentViewManager._peekHooks.readRoster = () => null;
    AgentViewManager._peekHooks.lookupResumeFromPath = () => null;
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(new Error('No job matching'), '', '');
    });

    const result = await mgr.resolvePeekContent('missingid', 1000);
    expect(result.text).toBeNull();
  });

  test('Tier 1 hit short-circuits Tier 2 and Tier 3 (no claude logs exec)', async () => {
    const { mgr } = makeMgrWithSpies();
    AgentViewManager._peekHooks.findJsonlForShort = () => '/fake/own.jsonl';
    AgentViewManager._peekHooks.extractRecentAssistantText = () => 'tier 1 wins';
    let parentLookupCalled = false;
    AgentViewManager._peekHooks.lookupResumeFromPath = () => {
      parentLookupCalled = true;
      return '/should/not/be/queried.jsonl';
    };
    let claudeLogsCalled = false;
    execFileMock.mockImplementation((cmd, args, cb) => {
      if (cmd === 'claude' && args[0] === 'logs') claudeLogsCalled = true;
      cb(null, '', '');
    });

    await mgr.resolvePeekContent('shortid5', 1000);
    expect(parentLookupCalled).toBe(false);
    expect(claudeLogsCalled).toBe(false);
  });
});

describe('buildPeekCard with outputFormat (v2.2.8)', () => {
  test('handlePeek renders markdown when JSONL hit (no code-block wrapping)', async () => {
    const { mgr, cardReplyFn } = makeMgrWithSpies();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    // Force tier 1 markdown hit
    const origHooks = { ...AgentViewManager._peekHooks };
    AgentViewManager._peekHooks.findJsonlForShort = () => '/fake/own.jsonl';
    AgentViewManager._peekHooks.extractRecentAssistantText = () => '**bold** _italic_ text';
    try {
      await mgr.handlePeek('ou_peek_md', waiting.sessionId.slice(0, 8), waiting.sessionId, waiting.cwd);

      const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
      const outBlock = sentCard.elements.find((e: any) => /Recent output/.test(e.content || ''));
      expect(outBlock.content).toContain('**bold** _italic_ text');
      // Critical: markdown branch must NOT wrap in code-block (otherwise emoji render as tofu)
      expect(outBlock.content).not.toContain('```');
      // Critical: must NOT show the "原始终端片段" warning label
      expect(outBlock.content).not.toContain('原始终端片段');
    } finally {
      AgentViewManager._peekHooks = origHooks;
    }
  });
});

describe('handleAttach — v2.2.15 short↔full guard compatibility', () => {
  // v2.2.14 回归:card 给 short, snapshot 里有 full,展开后再比 → 不匹配 → 误报"会话已不存在"。
  // 修复:守卫同时认 short 和 full,正式展开在 CAS 之前。
  test('guard accepts short sessionId when snapshot has full UUID', async () => {
    const { mgr, userManager } = makeMgrWithSpies();
    const fullUuid = '098639ad-9be0-401a-8e1f-3b2eb18cbd50';
    // snapshot returns full UUID
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [
        {
          pid: 0,
          cwd: '/Users/wuyujun',
          kind: 'background',
          startedAt: Date.now() - 1_000_000,
          sessionId: fullUuid,
          name: 'sleep 30 && echo done',
          status: 'idle',
          completed: true,
        },
      ],
    }));
    // user clicks Attach with the short hash (matches the live card)
    await mgr.handleAttach('ou_attach_short2full', '098639ad', '098639ad', 'sleep 30 && echo done', '/Users/wuyujun');

    // UserManager entry must be the full UUID (SDK 拒 short)
    const entry = userManager.getEntry('ou_attach_short2full');
    expect(entry?.type).toBe('session');
    expect((entry as any).sessionUuid).toBe(fullUuid);
  });

  test('guard accepts full sessionId when snapshot has full UUID (no-op)', async () => {
    const { mgr, userManager } = makeMgrWithSpies();
    const fullUuid = 'aaaa1111-2222-3333-4444-555555555555';
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [
        {
          pid: 0,
          cwd: '/x',
          kind: 'background',
          startedAt: 0,
          sessionId: fullUuid,
          name: 'session full',
          status: 'idle',
          completed: true,
        },
      ],
    }));
    await mgr.handleAttach('ou_attach_full', fullUuid, 'aaaa1111', 'session full', '/x');

    const entry = userManager.getEntry('ou_attach_full');
    expect((entry as any).sessionUuid).toBe(fullUuid);
  });

  test('guard refuses when neither short nor full matches snapshot', async () => {
    const { mgr, replyFn, userManager } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [],
    }));
    await mgr.handleAttach('ou_attach_gone', 'ffffffff', 'ffffffff', 'whatever', '/tmp');

    expect(replyFn).toHaveBeenCalled();
    const replyText = replyFn.mock.calls[0][0];
    expect(replyText).toContain('会话已不存在');
    // No entry should be written
    expect(userManager.getEntry('ou_attach_gone')).toBeUndefined();
  });
});

describe('handleStopAndSend (v2.2.18 fire-and-forget card callback)', () => {
  test('returns null immediately to avoid Feishu card action timeout', async () => {
    const { mgr, patchFn } = makeMgrWithSpies();
    // 模拟一个故意 slow 的 runChatSDK(5s)——v2.2.11 行为下 handleStopAndSend 会 await 整个
    // 链,卡 callback >3s 飞书报"目标回调服务超时未响应"。v2.2.18 改 fire-and-forget
    // 后,函数本身在亚秒级内返回,background 异步完成实际工作。
    mgr.deps.runChatSDK = async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { result: { response: 'ok' }, handler: {} as any, cardMessageId: null };
    };
    const t0 = Date.now();
    const result = mgr.handleStopAndSend(
      'ou_stop_send_1',
      'aaaaaaaa',
      'aaaaaaaa-0000-0000-0000-000000000000',
      '/Users/wuyujun',
      'hi',
      'parent-uuid-xxxx-xxxx',
      true,
      'om_msg_xyz',
    );
    const elapsed = Date.now() - t0;
    // v2.2.18: 立即 return null(< 1s),不 await runChatSDK
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(1000);
    // patchFn 被同步调用过一次(ack 卡)
    expect(patchFn).toHaveBeenCalled();
    const patched = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(JSON.stringify(patched)).toContain('已停止');
    expect(JSON.stringify(patched)).toContain('正在发送');
  });
});
