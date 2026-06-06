import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-mgr-'));
  (config as any).data.feishu_bot.owner_open_id = '';
});

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
