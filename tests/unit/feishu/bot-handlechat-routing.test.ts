import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SpoolMessage } from '../../../src/queue/spool';
import type { AgentSession } from '../../../src/agent-view/types';

// Mock node:child_process for any handlers that may use execFile
// (handleStop / handleStopConfirm). Keeps tests hermetic.
import { promisify } from 'node:util';
const execFileMock = Object.assign(
  mock((_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, '', '');
  }),
  {
    [promisify.custom]: (
      cmd: string,
      args: string[],
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

let tmpDir: string;
let bot: FeishuBot;
let userManager: UserManager;
let agentView: AgentViewManager;
let textReplies: string[];

// Track calls to handleCommand, handleReply, handleCancelReply on agentView
let handleCommandCalls: SpoolMessage[] = [];
let handleReplyCalls: Array<{ openId: string; text: string }> = [];
let handleCancelReplyCalls: string[] = [];

// Snapshot of the original AgentSnapshotFetcher.fetch — tests below overwrite
// it via `(AgentSnapshotFetcher as any).fetch = mock(...)`. Restore in afterAll
// so the override does not leak into later test files in the same `bun test`
// run (e.g. snapshot-fetcher.test.ts) which depend on the real implementation.
const origFetcherFetch = AgentSnapshotFetcher.fetch;

function makeSpoolMessage(over: Partial<SpoolMessage> = {}): SpoolMessage {
  return {
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    openId: 'ou_routing_1',
    text: '',
    target: { type: 'no_target' },
    serialKey: 'sk-1',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bot-routing-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  textReplies = [];
  handleCommandCalls = [];
  handleReplyCalls = [];
  handleCancelReplyCalls = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));

  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
  const spoolQueue = new SpoolQueue(tmpDir);
  const registry = new RegistryManager(tmpDir);
  const sessionManager = new ClaudeSessionManager();

  agentView = new AgentViewManager({
    userManager,
    replyFn: async (text, _opts) => {
      textReplies.push(text);
      return 'reply-id';
    },
    cardReplyFn: async () => 'card-id',
    patchFn: async () => null,
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
  });
  // Spy on routing targets
  agentView.handleReply = mock(async (openId: string, text: string) => {
    handleReplyCalls.push({ openId, text });
  }) as any;
  agentView.handleCancelReply = mock(async (openId: string) => {
    handleCancelReplyCalls.push(openId);
  }) as any;

  bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    sessionManager,
    replyFn: async (text, _opts) => {
      textReplies.push(text);
      return 'reply-id';
    },
    cardReplyFn: async () => 'card-id',
    patchFn: async () => null,
  });

  // Wire agentView
  (bot as any).setAgentView?.(agentView);
  // Defensive fallback: directly assign in case setAgentView is named differently
  (bot as any).agentView = agentView;

  // Spy on handleCommand to verify routing
  bot.handleCommand = mock(async (msg: SpoolMessage) => {
    handleCommandCalls.push(msg);
  }) as any;
});

describe('FeishuBot.handleChat routing with expectedReply (T23)', () => {
  test('/cancel routes to handleCancelReply (no other path)', async () => {
    const msg = makeSpoolMessage({ text: '/cancel' });
    await (bot as any).handleChat(msg);

    expect(handleCancelReplyCalls).toEqual(['ou_routing_1']);
    // No command dispatch, no reply
    expect(handleCommandCalls).toHaveLength(0);
    expect(handleReplyCalls).toHaveLength(0);
  });

  test('plain text routes to handleReply when expectedReply is active', async () => {
    // Seed an expectedReply by calling the internal state directly
    const waiting: AgentSession = {
      pid: 1234,
      cwd: '/tmp/proj',
      kind: 'background',
      startedAt: Date.now() - 30_000,
      sessionId: 'cccccccc-3333-3333-3333-cccccccccccc',
      name: 'waiting-task',
      status: 'waiting',
      waitingFor: 'awaiting user reply',
    };
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [waiting],
    }));
    await agentView.expectedReply.set('ou_routing_1', {
      shortId: waiting.sessionId.slice(0, 8),
      sessionId: waiting.sessionId,
      cwd: waiting.cwd,
    });

    const msg = makeSpoolMessage({ text: 'this is my reply text' });
    await (bot as any).handleChat(msg);

    expect(handleReplyCalls).toEqual([
      { openId: 'ou_routing_1', text: 'this is my reply text' },
    ]);
    // No command dispatch
    expect(handleCommandCalls).toHaveLength(0);
    // Cleanup
    await agentView.expectedReply.clear('ou_routing_1');
  });

  test('/help does NOT consume expectedReply (read-only command)', async () => {
    // Seed an expectedReply
    await agentView.expectedReply.set('ou_routing_1', {
      shortId: 'shortid',
      sessionId: 'session-uuid',
      cwd: '/tmp/proj',
    });
    expect(agentView.expectedReply.get('ou_routing_1')).toBeDefined();

    const msg = makeSpoolMessage({ text: '/help' });
    await (bot as any).handleChat(msg);

    // handleCommand was called (routing goes through to /help dispatch)
    expect(handleCommandCalls).toHaveLength(1);
    expect(handleCommandCalls[0].text).toBe('/help');
    // The expectedReply is still set (read-only command doesn't consume it)
    expect(agentView.expectedReply.get('ou_routing_1')).toBeDefined();
    // No "已自动取消" message was sent
    expect(textReplies.some((t) => t.includes('已自动取消'))).toBe(false);
    // Cleanup
    await agentView.expectedReply.clear('ou_routing_1');
  });

  test('/status does NOT consume expectedReply (read-only command)', async () => {
    await agentView.expectedReply.set('ou_routing_1', {
      shortId: 'shortid',
      sessionId: 'session-uuid',
      cwd: '/tmp/proj',
    });

    const msg = makeSpoolMessage({ text: '/status' });
    await (bot as any).handleChat(msg);

    // handleCommand routed through
    expect(handleCommandCalls).toHaveLength(1);
    // expectedReply still set
    expect(agentView.expectedReply.get('ou_routing_1')).toBeDefined();
    // No auto-cancel message
    expect(textReplies.some((t) => t.includes('已自动取消'))).toBe(false);
    // Cleanup
    await agentView.expectedReply.clear('ou_routing_1');
  });

  test('/new DOES clear expectedReply (write command)', async () => {
    // Seed an expectedReply
    await agentView.expectedReply.set('ou_routing_1', {
      shortId: 'shortid',
      sessionId: 'session-uuid',
      cwd: '/tmp/proj',
    });
    expect(agentView.expectedReply.get('ou_routing_1')).toBeDefined();

    const msg = makeSpoolMessage({ text: '/new /tmp/proj' });
    await (bot as any).handleChat(msg);

    // expectedReply is cleared (write command consumes it)
    expect(agentView.expectedReply.get('ou_routing_1')).toBeUndefined();
    // Auto-cancel message was sent
    expect(textReplies.some((t) => t.includes('已自动取消'))).toBe(true);
    expect(textReplies.some((t) => t.includes('/new'))).toBe(true);
  });

  test('/list (write command) clears expectedReply and routes to handleCommand', async () => {
    await agentView.expectedReply.set('ou_routing_1', {
      shortId: 'shortid',
      sessionId: 'session-uuid',
      cwd: '/tmp/proj',
    });

    const msg = makeSpoolMessage({ text: '/list' });
    await (bot as any).handleChat(msg);

    expect(agentView.expectedReply.get('ou_routing_1')).toBeUndefined();
    expect(textReplies.some((t) => t.includes('已自动取消'))).toBe(true);
  });

  test('plain text without expectedReply falls through to original switch (no_target branch)', async () => {
    // No expectedReply set; plain text → handleChat's switch → no_target → replyAndFinalize
    const msg = makeSpoolMessage({ text: 'just chatting', target: { type: 'no_target' } });
    await (bot as any).handleChat(msg);

    // Should reach the original switch, which for no_target replies with the
    // "请先执行以下任一命令" guidance
    expect(handleReplyCalls).toHaveLength(0);
    expect(textReplies.some((t) => t.includes('请先执行'))).toBe(true);
  });

  test('routing is a no-op when agentView is disabled', async () => {
    // Disable agentView
    (bot as any).agentView = undefined;

    // Even with /cancel, the check `if (this.agentView)` short-circuits
    // and the original switch runs. Plain text with no_target → help text.
    const msg = makeSpoolMessage({ text: 'hi', target: { type: 'no_target' } });
    await (bot as any).handleChat(msg);

    expect(handleReplyCalls).toHaveLength(0);
    expect(textReplies.some((t) => t.includes('请先执行'))).toBe(true);
  });

  test('v2.2: routing is a no-op when agent_view.enabled=false', async () => {
    // v2.2 修正:config 禁用时,即使 agentView 存在,也不进 Agent View 分支
    (config as any).data.agent_view.enabled = false;
    try {
      // /cancel 应当不进入 handleCancelReply
      const cancelMsg = makeSpoolMessage({ text: '/cancel' });
      await (bot as any).handleChat(cancelMsg);
      expect(handleCancelReplyCalls).toHaveLength(0);

      // 普通文本有 expectedReply 时:不进入 handleReply
      // 由于没有真实的 expectedReply 状态,默认走原 switch (no_target → help)
      const plainMsg = makeSpoolMessage({ text: 'hi', target: { type: 'no_target' } });
      await (bot as any).handleChat(plainMsg);
      expect(handleReplyCalls).toHaveLength(0);
    } finally {
      (config as any).data.agent_view.enabled = true;
    }
  });
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetcherFetch;
});
