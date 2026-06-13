/**
 * Cluster 5.1 + 5.2 + 5.3 + 5.4: end-to-end rendezvous dispatch + abort reason + shutdown + attachedAt preservation.
 *
 * Tests that the full handleCardAction → handler chain works:
 * - Card with agent_view_rendezvous_abort_wait → handleRendezvousAbortWait
 * - Card with agent_view_rendezvous_stop_bg_request → handleRendezvousStopBgRequest
 * - Card with agent_view_rendezvous_stop_bg_confirm → handleRendezvousStopBgConfirm
 * - Shutdown aborts in-flight waits
 * - From-Attach abort preserves attachedAt
 */
import { describe, it, expect } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import { AgentViewManager } from '../../../src/agent-view/manager';

/** Minimal agentView stub — just enough so the dispatch guard passes.
 *  3 rendezvous tags have handlers on the bot itself, not on AgentViewManager,
 *  but the dispatch guard still requires this.agentView to be non-null. */
function stubAgentView(): any {
  const stub: any = { attachedWatchers: { stopAll: async () => {} } };
  return stub as AgentViewManager;
}

describe('Cluster 5 — rendezvous dispatch + shutdown + integration', () => {
  describe('5.1 dispatch routing via handleCardAction', () => {
    it('agent_view_rendezvous_abort_wait routes to handleRendezvousAbortWait (aborts AbortController)', async () => {
      const env = createTestBot({ tmpDirPrefix: 'bot-rv-dispatch-1-' });
      try {
        (env.bot as any).agentView = stubAgentView();
        const ac = new AbortController();
        const mockUpdater: any = {
          getState: () => 'processing',
          patchAbortedTracking: async () => {},
          cancelPending: () => {},
        };
        (env.bot as any).activeRendezvousWaits.set('ou_user1', {
          abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
        });
        (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
        (env.userManager as any).compareAndSwap = async () => true;

        await env.bot.handleCardAction({
          open_id: 'ou_user1',
          action: { tag: 'agent_view_rendezvous_abort_wait', value: { tag: 'agent_view_rendezvous_abort_wait' } },
          message: { message_id: 'm_dispatch_1' },
        } as any);

        expect(ac.signal.aborted).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it('agent_view_rendezvous_stop_bg_request routes to handleRendezvousStopBgRequest (sends confirm card)', async () => {
      const env = createTestBot({ tmpDirPrefix: 'bot-rv-dispatch-2-' });
      try {
        (env.bot as any).agentView = stubAgentView();
        (env.bot as any).activeRendezvousWaits.set('ou_user1', {
          abort: new AbortController(), sessionUuid: 'u', cwd: '/', attachedAt: undefined,
        });

        await env.bot.handleCardAction({
          open_id: 'ou_user1',
          action: {
            tag: 'agent_view_rendezvous_stop_bg_request',
            value: { tag: 'agent_view_rendezvous_stop_bg_request', shortId: 'abc12345' },
          },
          message: { message_id: 'm_dispatch_2' },
        } as any);

        expect(env.cardReplies).toHaveLength(1);
        expect(env.cardReplies[0].card.header.title.content).toContain('abc12345');
        expect(env.cardReplies[0].card.header.template).toBe('red');
        // 不该动 maps
        expect((env.bot as any).activeRendezvousWaits.has('ou_user1')).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it('agent_view_rendezvous_stop_bg_confirm routes to handleRendezvousStopBgConfirm', async () => {
      const env = createTestBot({ tmpDirPrefix: 'bot-rv-dispatch-3-' });
      try {
        (env.bot as any).agentView = stubAgentView();
        // 不放 entry → 走"已自然完成" race 1 分支
        await env.bot.handleCardAction({
          open_id: 'ou_user1',
          action: {
            tag: 'agent_view_rendezvous_stop_bg_confirm',
            value: { tag: 'agent_view_rendezvous_stop_bg_confirm', shortId: 'abc12345' },
          },
          message: { message_id: 'm_dispatch_3' },
        } as any);

        // 应有 text reply "已自然完成"
        expect(env.textReplies.length).toBeGreaterThanOrEqual(1);
        expect(env.textReplies[0].text).toContain('已自然完成');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('5.3 shutdown aborts in-flight rendezvous waits', () => {
    it('shutdown aborts all waits + clears both maps', async () => {
      const env = createTestBot({ tmpDirPrefix: 'bot-rv-shutdown-' });
      try {
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        (env.bot as any).activeRendezvousWaits.set('ou_1', {
          abort: ac1, sessionUuid: 'u1', cwd: '/a', attachedAt: undefined,
        });
        (env.bot as any).activeRendezvousWaits.set('ou_2', {
          abort: ac2, sessionUuid: 'u2', cwd: '/b', attachedAt: '2026-06-13T00:00:00Z',
        });
        (env.bot as any).rendezvousCardUpdaters.set('ou_1', { getState: () => 'processing' });
        (env.bot as any).rendezvousCardUpdaters.set('ou_2', { getState: () => 'processing' });

        await env.bot.shutdown();

        expect(ac1.signal.aborted).toBe(true);
        expect(ac2.signal.aborted).toBe(true);
        expect((env.bot as any).activeRendezvousWaits.size).toBe(0);
        expect((env.bot as any).rendezvousCardUpdaters.size).toBe(0);
      } finally {
        env.cleanup();
      }
    });
  });

  describe('5.4 from-Attach abort preserves attachedAt for next chat', () => {
    it('from-Attach abort: attachedAt preserved → handler returns entry with attachedAt', async () => {
      // 这是核心语义保证: abort 后用户再发消息仍走 rendezvous 路径。
      // 我们测的是 abort handler 的输出: 恢复 user-mapping 时 attachedAt 保留。
      const env = createTestBot({ tmpDirPrefix: 'bot-rv-attach-' });
      try {
        const ac = new AbortController();
        const mockUpdater: any = {
          getState: () => 'processing',
          patchAbortedTracking: async () => {},
          cancelPending: () => {},
        };
        (env.bot as any).activeRendezvousWaits.set('ou_user1', {
          abort: ac, sessionUuid: 'u-aaa', cwd: '/p',
          attachedAt: '2026-06-13T10:00:00.000Z',
        });
        (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
        const cas: any[] = [];
        (env.userManager as any).compareAndSwap = async (_oid: string, _old: any, nv: any) => {
          cas.push(nv);
          return true;
        };

        await (env.bot as any).handleRendezvousAbortWait('ou_user1');

        expect(cas).toHaveLength(1);
        expect(cas[0].attachedAt).toBe('2026-06-13T10:00:00.000Z');
        // 不变: type=session, sessionUuid, cwd
        expect(cas[0]).toEqual(expect.objectContaining({
          type: 'session', sessionUuid: 'u-aaa', cwd: '/p',
        }));
      } finally {
        env.cleanup();
      }
    });
  });
});
