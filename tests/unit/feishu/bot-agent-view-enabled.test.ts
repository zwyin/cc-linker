// tests/unit/feishu/bot-agent-view-enabled.test.ts
// v2.2 修正:config agent_view.enabled 关闭时,
//   - card action 路径静默忽略
//   - /agents 命令显示"已禁用"
//   - handleChat Agent View 分支跳过
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import { SpoolMessage } from '../../../src/queue/spool';

describe('FeishuBot — agent_view.enabled config gate (v2.2)', () => {
  let env: TestBot;
  let agentView: AgentViewManager;
  let spies: { [k: string]: (...args: any[]) => any };

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-agent-view-disabled-',
      extraConfigMutations: {
        'agent_view.enabled': false,
      },
    });
    spies = {
      handleRefreshList: () => 'spy:refresh_list',
      handleRefreshPeek: () => 'spy:refresh_peek',
      handlePeek: () => 'spy:peek',
      handleAttach: () => 'spy:attach',
      handleReplyRequest: () => 'spy:reply_request',
      handleCancelReply: () => 'spy:cancel_reply',
      handleStop: () => 'spy:stop',
      handleStopConfirm: () => 'spy:stop_confirm',
      handleBackToChat: () => 'spy:back_to_chat',
      handleList: () => 'spy:list',
    };
    agentView = new AgentViewManager({
      userManager: new UserManager('/tmp/agent-view-disabled-test-user-mapping.json'),
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    for (const [name, fn] of Object.entries(spies)) {
      const calls: any[][] = [];
      (agentView as any)[name] = (...args: any[]) => {
        calls.push(args);
        return fn(...args);
      };
      (agentView as any)[`${name}Calls`] = calls;
    }
    env.bot.setAgentView(agentView);
  });

  afterEach(() => {
    env.cleanup();
  });

  const cardAction = (tag: string, value: Record<string, unknown> = {}, messageId = 'm_disabled_1') => ({
    open_id: 'ou_user1',
    action: { tag, value: { tag, ...value } },
    message: { message_id: messageId },
  });

  it('card action: agent_view_refresh_list 静默返回 null (enabled=false)', async () => {
    const result = await env.bot.handleCardAction(cardAction('agent_view_refresh_list'));
    expect(result).toBeNull();
    expect((agentView as any).handleRefreshListCalls).toHaveLength(0);
  });

  it('card action: agent_view_peek 静默返回 null (enabled=false)', async () => {
    const result = await env.bot.handleCardAction(
      cardAction('agent_view_peek', { shortId: 's1', sessionId: 'uuid-1', cwd: '/tmp' }),
    );
    expect(result).toBeNull();
    expect((agentView as any).handlePeekCalls).toHaveLength(0);
  });

  it('card action: agent_view_attach 静默返回 null (enabled=false)', async () => {
    const result = await env.bot.handleCardAction(
      cardAction('agent_view_attach', { sessionId: 'uuid-1', shortId: 's1', name: 'X', cwd: '/tmp' }),
    );
    expect(result).toBeNull();
    expect((agentView as any).handleAttachCalls).toHaveLength(0);
  });

  it('card action: agent_view_stop 静默返回 null (enabled=false)', async () => {
    const result = await env.bot.handleCardAction(
      cardAction('agent_view_stop', { shortId: 's1', sessionId: 'uuid-1', name: 'X' }),
    );
    expect(result).toBeNull();
    expect((agentView as any).handleStopCalls).toHaveLength(0);
  });
});
