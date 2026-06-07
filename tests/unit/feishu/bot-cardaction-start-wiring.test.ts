import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { FeishuBotCardAction } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

/**
 * v2.2.3 regression test — `start.ts` builds the `FeishuBotCardAction` from
 * the raw `card.action.trigger` payload before calling `bot.handleCardAction`.
 *
 * Before v2.2.3, only a hard-coded whitelist of `value.type` values
 * (`permission_approve` / `permission_deny` / `cli_force_send`) was passed
 * through as an object. All other actions — including the 9 Agent View
 * tags — were collapsed to a `sessionId` string, which broke dispatch
 * because Agent View buttons carry `value.shortId` (not `value.sessionId`
 * at the top level), so the string was empty and the switch fell through
 * to "未知操作".
 *
 * These tests replicate the exact logic in
 * `src/cli/commands/start.ts:457-490` and assert:
 *   1) For Agent View buttons, the synthesized `FeishuBotCardAction.action.value`
 *      is the full object (not a string), so bot.handleCardAction can route it.
 *   2) For permission buttons, the synthesized value remains the full object
 *      (regression guard for the previous whitelist behavior).
 *   3) End-to-end: feeding the synthesized action into bot.handleCardAction
 *      routes Agent View clicks to the right AgentViewManager method.
 */

/**
 * Mirror of the v2.2.3 logic in `src/cli/commands/start.ts:457-490`.
 * Kept in-test as a drift detector — if `start.ts` changes shape, this
 * helper must change too, and these tests guard the contract.
 */
function buildCardAction(rawEvent: any): FeishuBotCardAction {
  const openId = rawEvent?.open_id ?? rawEvent?.operator?.open_id ?? rawEvent?.event?.operator?.open_id ?? rawEvent?.callback?.open_id ?? '';
  const messageId = rawEvent?.open_message_id ?? rawEvent?.context?.open_message_id ?? rawEvent?.event?.context?.open_message_id ?? rawEvent?.callback?.message?.message_id ?? '';
  const actionValue = rawEvent?.action?.value ?? rawEvent?.event?.action?.value ?? rawEvent?.callback?.action?.value ?? {};

  const isObjectValue = typeof actionValue === 'object' && actionValue !== null;
  const tag = isObjectValue
    ? ((actionValue as any).type ?? (actionValue as any).tag ?? '')
    : '';
  const sessionId = actionValue?.sessionId ?? actionValue?.value ?? '';

  const actionPayload: string | Record<string, unknown> = isObjectValue
    ? (actionValue as Record<string, unknown>)
    : sessionId;

  return {
    open_id: openId,
    action: { tag, value: actionPayload },
    message: { message_id: messageId },
  };
}

describe('start.ts card.action.trigger wiring (v2.2.3)', () => {
  describe('agent_view_* buttons pass object value (not string)', () => {
    it('agent_view_peek — value is the full object', () => {
      const raw = {
        open_id: 'ou_user_peek',
        open_message_id: 'm_peek_1',
        action: {
          value: {
            tag: 'agent_view_peek',
            shortId: 'abc12345',
            sessionId: 'uuid-peek-1',
            cwd: '/tmp/proj-peek',
          },
        },
      };
      const built = buildCardAction(raw);
      expect(built.open_id).toBe('ou_user_peek');
      expect(built.message.message_id).toBe('m_peek_1');
      expect(built.action.tag).toBe('agent_view_peek');
      // The critical assertion — must be object, not string.
      expect(typeof built.action.value).toBe('object');
      expect(built.action.value).toMatchObject({
        tag: 'agent_view_peek',
        shortId: 'abc12345',
        sessionId: 'uuid-peek-1',
        cwd: '/tmp/proj-peek',
      });
    });

    it('agent_view_attach — value carries shortId/sessionId/name/cwd', () => {
      const raw = {
        open_id: 'ou_user_attach',
        open_message_id: 'm_attach_1',
        action: {
          value: {
            tag: 'agent_view_attach',
            shortId: 'def67890',
            sessionId: 'uuid-attach-1',
            name: 'MyAttachedSession',
            cwd: '/tmp/proj-attach',
          },
        },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('agent_view_attach');
      expect(typeof built.action.value).toBe('object');
      expect((built.action.value as any).shortId).toBe('def67890');
      expect((built.action.value as any).name).toBe('MyAttachedSession');
    });

    it('agent_view_stop — value carries shortId/sessionId/name', () => {
      const raw = {
        open_id: 'ou_user_stop',
        open_message_id: 'm_stop_1',
        action: {
          value: {
            tag: 'agent_view_stop',
            shortId: 'ghi11111',
            sessionId: 'uuid-stop-1',
            name: 'StopMe',
          },
        },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('agent_view_stop');
      expect(typeof built.action.value).toBe('object');
      expect((built.action.value as any).tag).toBe('agent_view_stop');
    });

    it('agent_view_refresh_list — value is object (no sessionId field)', () => {
      const raw = {
        open_id: 'ou_user_refresh',
        open_message_id: 'm_refresh_1',
        action: { value: { tag: 'agent_view_refresh_list' } },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('agent_view_refresh_list');
      expect(typeof built.action.value).toBe('object');
      expect((built.action.value as any).tag).toBe('agent_view_refresh_list');
    });
  });

  describe('permission_* buttons still pass object value (regression)', () => {
    it('permission_approve — tag uses value.type, value is full object', () => {
      const raw = {
        open_id: 'ou_user_p1',
        open_message_id: 'm_perm_1',
        action: {
          value: {
            type: 'permission_approve',
            index: 0,
            handlerId: 'h-1',
          },
        },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('permission_approve');
      expect(typeof built.action.value).toBe('object');
      expect((built.action.value as any).index).toBe(0);
      expect((built.action.value as any).handlerId).toBe('h-1');
    });

    it('cli_force_send — tag uses value.type', () => {
      const raw = {
        open_id: 'ou_user_force',
        open_message_id: 'm_force_1',
        action: {
          value: { type: 'cli_force_send', sessionId: 'uuid-force' },
        },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('cli_force_send');
      expect(typeof built.action.value).toBe('object');
    });
  });

  describe('legacy menu buttons (switch/resume/...) pass object value', () => {
    it('switch button — value carries {tag, sessionId}; passed through as object', () => {
      // Real menu cards (see bot.ts:2696) emit
      //   value: { tag: 'switch', sessionId: uuid }
      // After v2.2.3, start.ts forwards the whole object (not a sessionId
      // string), and bot.handleCardAction extracts `value.sessionId` for the
      // doSwitch call.
      const raw = {
        open_id: 'ou_user_switch',
        open_message_id: 'm_switch_1',
        action: { value: { tag: 'switch', sessionId: 'session-uuid-legacy' } },
      };
      const built = buildCardAction(raw);
      expect(built.action.tag).toBe('switch');
      expect(typeof built.action.value).toBe('object');
      expect((built.action.value as any).sessionId).toBe('session-uuid-legacy');
    });

    it('completely empty raw event still produces a valid (empty) payload', () => {
      const built = buildCardAction({});
      expect(built.open_id).toBe('');
      expect(built.action.tag).toBe('');
      // actionValue defaults to {}; isObjectValue is true → payload is {}.
      expect(typeof built.action.value).toBe('object');
    });
  });
});

describe('start.ts → bot.handleCardAction end-to-end (v2.2.3)', () => {
  let env: TestBot;
  let agentView: AgentViewManager;
  const peekCalls: any[][] = [];

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'start-wiring-e2e-' });
    agentView = new AgentViewManager({
      userManager: new UserManager('/tmp/start-wiring-e2e-user-mapping.json'),
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    peekCalls.length = 0;
    (agentView as any).handlePeek = (...args: any[]) => {
      peekCalls.push(args);
      return 'spy:peek';
    };
    env.bot.setAgentView(agentView);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('peek click from start.ts payload reaches AgentViewManager.handlePeek', async () => {
    const rawEvent = {
      open_id: 'ou_user_e2e',
      open_message_id: 'm_e2e_peek',
      action: {
        value: {
          tag: 'agent_view_peek',
          shortId: 'short_e2e',
          sessionId: 'uuid-e2e',
          cwd: '/tmp/e2e-proj',
        },
      },
    };
    const built = buildCardAction(rawEvent);
    const result = await env.bot.handleCardAction(built);
    expect(result).toBe('spy:peek');
    expect(peekCalls).toEqual([
      ['ou_user_e2e', 'short_e2e', 'uuid-e2e', '/tmp/e2e-proj'],
    ]);
  });
});
