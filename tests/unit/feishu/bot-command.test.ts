import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import type { SpoolMessage } from '../../../src/queue/spool';

describe('FeishuBot.handleCommand /agents case', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'bot-command-test-' });
  });

  afterEach(() => {
    env.cleanup();
  });

  /**
   * Build a minimal SpoolMessage that handleCommand can parse.
   * Only `text`, `openId`, `messageId` are read by the /agents branch.
   */
  const buildMsg = (text: string): SpoolMessage => ({
    messageId: 'msg-agents-1',
    openId: 'ou_test_user',
    text,
    serialKey: `cmd:ou_test_user:msg-agents-1`,
    target: { type: 'no_target' },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  test('dispatches to agentView.handleList when agentView is set', async () => {
    // Arrange: install a mock agentView manager.
    // setAgentView mutates mgr.deps.runChatSDK, so the mock must expose a deps object.
    const calls: { openId: string; messageId: string }[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleList: async (openId: string, messageId?: string) => {
        calls.push({ openId, messageId: messageId ?? '' });
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    // Act: handle the /agents command
    await env.bot.handleCommand(buildMsg('/agents'));

    // Assert: handleList was called with the right args
    expect(calls).toEqual([{ openId: 'ou_test_user', messageId: 'msg-agents-1' }]);
    // And no text reply was sent (handleList owns the reply)
    expect(env.textReplies.length).toBe(0);
  });

  test('returns friendly error when agentView is undefined', async () => {
    // Arrange: do NOT set agentView — it should be undefined
    // (createTestBot does not install one by default)

    // Act: handle the /agents command
    await env.bot.handleCommand(buildMsg('/agents'));

    // Assert: a friendly text reply was sent
    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe('Agent View 未启用(检查 config.toml [agent_view].enabled)');
    expect(env.textReplies[0].openId).toBe('ou_test_user');
    expect(env.textReplies[0].messageId).toBe('msg-agents-1');
  });

  test('does not interfere with the /help case', async () => {
    // Sanity check: the new case was inserted in a place that does not
    // break the other cases (specifically /help, which sits at the top).
    await env.bot.handleCommand(buildMsg('/help'));
    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toContain('/help');
    expect(env.textReplies[0].text).toContain('/agents');
  });
});
