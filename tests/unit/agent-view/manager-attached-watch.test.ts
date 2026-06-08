import { beforeEach, describe, expect, test, mock, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

// Mock child_process (handlePeek 退化路径会 import 它)
import { promisify } from 'node:util';
const execFileMock = Object.assign(
  mock((_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, '', '');
  }),
  {
    [promisify.custom]: (cmd: string, args: string[]) =>
      new Promise((resolve, reject) => {
        execFileMock(cmd, args, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      }),
  },
);
mock.module('node:child_process', () => ({
  ...require('node:child_process'),
  execFile: execFileMock,
}));

let tmpDir: string;
let userManager: UserManager;
let manager: AgentViewManager;
let cardReplies: Array<{ card: string; opts: any }>;
let textReplies: Array<{ text: string; opts: any }>;
let patches: Array<{ messageId: string; card: string }>;
const origFetcherFetch = AgentSnapshotFetcher.fetch;

const sampleSession: AgentSession = {
  pid: 1234,
  cwd: '/Users/test/proj',
  kind: 'background',
  startedAt: Date.now() - 10000,
  sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
  name: 'sleep 30',
  status: 'busy',
  source: 'slash',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mgr-attach-watch-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  cardReplies = [];
  textReplies = [];
  patches = [];
  manager = new AgentViewManager({
    userManager,
    replyFn: async (text, opts) => { textReplies.push({ text, opts }); return 'msg_text'; },
    cardReplyFn: async (card, opts) => { cardReplies.push({ card, opts }); return 'om_card'; },
    patchFn: async (messageId, card) => { patches.push({ messageId, card }); return {}; },
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({
    ok: true,
    sessions: [sampleSession],
  }));
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetcherFetch;
});

describe('AgentViewManager attached watch integration', () => {
  test('handleAttach success starts an attached watch', async () => {
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    expect(manager.attachedWatchers.has('ou_test')).toBe(true);
    // 验证有 cardReply 调(发首张 attached 卡)
    expect(cardReplies).toHaveLength(1);
  });

  test('handleAttach with existing watch: old stop superseded, new starts', async () => {
    // 第一次
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    const firstWatchers = (manager.attachedWatchers as any).watchers.get('ou_test');
    // 第二次(模拟同一用户 Attach 另一个 session)
    const secondSession: AgentSession = { ...sampleSession, sessionId: 'second-uuid', name: 'task2' };
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true, sessions: [secondSession],
    }));
    await manager.handleAttach(
      'ou_test', secondSession.sessionId, 'sec22222', 'task2', '/Users/test/proj',
    );
    const secondWatchers = (manager.attachedWatchers as any).watchers.get('ou_test');
    expect(firstWatchers.stopped).toBe(true);
    expect(secondWatchers).not.toBe(firstWatchers);
    expect(secondWatchers.stopped).toBe(false);
  });

  test('handleStopWatching: stops attached watch', async () => {
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    expect(manager.attachedWatchers.has('ou_test')).toBe(true);
    await manager.handleStopWatching('ou_test');
    expect(manager.attachedWatchers.has('ou_test')).toBe(false);
  });

  test('handleStopWatching on no watch: no-op', async () => {
    await manager.handleStopWatching('ou_unknown'); // 不应 throw
  });
});
