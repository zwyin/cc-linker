import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

/**
 * T13 dispatch test: verify that handleCardAction routes all 9
 * agent_view_* tags to the corresponding AgentViewManager method.
 *
 * The bot-cardaction flow: card.value is an object with a `tag` field
 * matching the AgentViewValue tag. We replace the real handlers with
 * spy methods on a real AgentViewManager instance, drive the bot, and
 * assert each spy fired with the right arguments.
 */
describe('FeishuBot handleCardAction — agent_view_* dispatch (T13)', () => {
  let env: TestBot;
  let spies: { [k: string]: (...args: any[]) => any };
  let agentView: AgentViewManager;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-cardaction-agent-view-',
    });

    // Wire a real AgentViewManager but with spied methods so we can assert
    // dispatch arguments without depending on T14-T22 impls.
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
    };
    agentView = new AgentViewManager({
      userManager: new UserManager('/tmp/agent-view-cardaction-test-user-mapping.json'),
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    // Replace stub methods with spies that capture args.
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

  const cardAction = (openId: string, value: Record<string, unknown>, messageId = 'm_av_1') => ({
    open_id: openId,
    action: { tag: 'agent_view_dummy', value },
    message: { message_id: messageId },
  });

  it('routes agent_view_refresh_list', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', { tag: 'agent_view_refresh_list' }));
    expect(result).toBe('spy:refresh_list');
    expect((agentView as any).handleRefreshListCalls).toEqual([['ou_user1', 'm_av_1']]);
  });

  it('routes agent_view_refresh_peek', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_refresh_peek', shortId: 's1', sessionId: 'uuid-1',
    }));
    expect(result).toBe('spy:refresh_peek');
    expect((agentView as any).handleRefreshPeekCalls).toEqual([
      ['ou_user1', 's1', 'uuid-1', 'm_av_1'],
    ]);
  });

  it('routes agent_view_peek', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_peek', shortId: 's1', sessionId: 'uuid-1', cwd: '/tmp/proj',
    }));
    expect(result).toBe('spy:peek');
    expect((agentView as any).handlePeekCalls).toEqual([
      ['ou_user1', 's1', 'uuid-1', '/tmp/proj'],
    ]);
  });

  it('routes agent_view_attach', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_attach',
      sessionId: 'uuid-1', shortId: 's1', name: 'MySession', cwd: '/tmp/proj',
    }));
    expect(result).toBe('spy:attach');
    expect((agentView as any).handleAttachCalls).toEqual([
      ['ou_user1', 'uuid-1', 's1', 'MySession', '/tmp/proj'],
    ]);
  });

  it('routes agent_view_reply_request', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_reply_request', shortId: 's1', sessionId: 'uuid-1', cwd: '/tmp/proj',
    }));
    // Handler returns void; dispatcher normalises to null.
    expect(result).toBeNull();
    expect((agentView as any).handleReplyRequestCalls).toEqual([
      ['ou_user1', 's1', 'uuid-1', '/tmp/proj', 'm_av_1'],
    ]);
  });

  it('routes agent_view_cancel_reply', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', { tag: 'agent_view_cancel_reply' }, 'm_cancel_1'));
    expect(result).toBeNull();
    expect((agentView as any).handleCancelReplyCalls).toEqual([['ou_user1', 'm_cancel_1']]);
  });

  it('routes agent_view_stop', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_stop', shortId: 's1', sessionId: 'uuid-1', name: 'MySession',
    }));
    expect(result).toBe('spy:stop');
    expect((agentView as any).handleStopCalls).toEqual([
      ['ou_user1', 's1', 'uuid-1', 'MySession'],
    ]);
  });

  it('routes agent_view_stop_confirm', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', {
      tag: 'agent_view_stop_confirm', shortId: 's1', sessionId: 'uuid-1',
    }, 'm_confirm_1'));
    expect(result).toBe('spy:stop_confirm');
    expect((agentView as any).handleStopConfirmCalls).toEqual([
      ['ou_user1', 's1', 'uuid-1', 'm_confirm_1'],
    ]);
  });

  it('routes agent_view_back_to_chat', async () => {
    const result = await env.bot.handleCardAction(cardAction('ou_user1', { tag: 'agent_view_back_to_chat' }));
    expect(result).toBeNull();
    expect((agentView as any).handleBackToChatCalls).toEqual([['ou_user1']]);
  });

  it('returns "Agent View 未启用" when manager not wired', async () => {
    // New env without setAgentView
    const env2 = createTestBot({ tmpDirPrefix: 'bot-cardaction-no-agent-view-' });
    try {
      const reply = await env2.bot.handleCardAction(cardAction('ou_user1', { tag: 'agent_view_refresh_list' }));
      expect(reply).toBe('Agent View 未启用');
    } finally {
      env2.cleanup();
    }
  });
});
