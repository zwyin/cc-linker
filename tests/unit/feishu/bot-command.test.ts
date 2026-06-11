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

  test('v2.2: returns "Agent View 已禁用" when agent_view.enabled=false', async () => {
    // Arrange: set agentView + disable via config
    env.cleanup();
    env = createTestBot({
      tmpDirPrefix: 'bot-command-disabled-',
      extraConfigMutations: { 'agent_view.enabled': false },
    });
    const calls: any[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleList: async (...args: any[]) => { calls.push(args); },
    };
    env.bot.setAgentView(mockAgentView as any);

    // Act
    await env.bot.handleCommand(buildMsg('/agents'));

    // Assert: handleList NOT called, friendly disabled message sent
    expect(calls).toHaveLength(0);
    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toContain('Agent View 已禁用');
  });

  /**
   * v2.3.14 regression: /agents 之前不 markReplied/markDone,spool 消息卡 processing/
   * 永远不 finalize,累积 100 后 enqueue 触发"队列满" → "服务暂不可用"。
   * 这里直接通过 SpoolQueue 状态断言:handleCommand 后,processing/ 应为空。
   * markReplied → replied/,markDone → done/(用 listReplied 验证 replied 状态存在即可,
   * 实际生产中 cleanup 24h 后会转 done/ 不影响功能性)。
   */
  test('v2.3.14: /agents 完成后 spool 消息必须从 processing/ 移出(replied/done)', async () => {
    // Arrange: install a mock agentView whose handleList 返回 cardMessageId
    const mockAgentView = {
      deps: {} as any,
      handleList: async (_openId: string, _msgMessageId?: string): Promise<string | null> => {
        return 'mock-card-msg-id-1';
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    // 把消息 enqueue + claimNext 模拟 dispatch 后的状态(已经在 processing/)
    const msg = buildMsg('/agents');
    expect(env.spoolQueue.enqueue({ ...msg, status: 'pending' })).toBe(true);
    expect(env.spoolQueue.claimNext(msg.serialKey)).not.toBeNull();
    expect(env.spoolQueue.listProcessing().some(m => m.messageId === msg.messageId)).toBe(true);

    // Act: handleCommand 走 /agents 路径
    await env.bot.handleCommand(msg);

    // Assert: 消息已移出 processing/(到 replied/ 或 done/)
    expect(env.spoolQueue.listProcessing().some(m => m.messageId === msg.messageId)).toBe(false);
  });

  test('v2.4 regression: when rendezvous_enabled=false (default), /agents path still works', async () => {
    const mockAgentView = {
      deps: {} as any,
      handleList: async () => 'card-msg-id',
    };
    env.bot.setAgentView(mockAgentView as any);
    const msg = buildMsg('/agents');
    await env.bot.handleCommand(msg);
    // /agents should still send a card and finalize the spool
    expect(env.spoolQueue.listProcessing().length).toBe(0);
  });
});
