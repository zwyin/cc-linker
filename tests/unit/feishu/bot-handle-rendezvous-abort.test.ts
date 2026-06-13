/**
 * handleRendezvousAbortWait TDD tests (Cluster 4.3, plan v3 with review fixes).
 *
 * Covers:
 * - from-Reply path: aborts, restores user-mapping WITHOUT attachedAt, patches card
 * - from-Attach path: aborts, restores user-mapping WITH attachedAt preserved
 * - race guard (review gap 2): when updater.getState() === 'complete'/'error'/'cancelled',
 *   skip abort + patch + user-mapping CAS to avoid clobbering terminal card
 * - idempotent: no-op when openId not in map
 *
 * These tests test the handler logic in isolation, not via the full
 * handleCardAction dispatch path. dispatch routing is in bot-cardaction.test.ts.
 */
import { describe, it, expect } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import type { CardUpdater } from '../../../src/feishu/card-updater';

function makeMockCardUpdater(overrides: {
  getState?: () => 'processing' | 'streaming' | 'complete' | 'error' | 'cancelled';
} = {}): any {
  // Cast to CardUpdater-shaped mock; only getState/patchAbortedTracking/cancelPending are touched
  return {
    getState: overrides.getState ?? (() => 'processing' as const),
    patchAbortedTracking: (..._args: any[]) => Promise.resolve(),
    cancelPending: () => {},
  };
}

describe('FeishuBot.handleRendezvousAbortWait (Cluster 4.3)', () => {
  let env: TestBot;
  beforeEachInner();
  function beforeEachInner() {
    env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-abort-' });
  }

  it('from-Reply: aborts, restores user-mapping WITHOUT attachedAt, patches card', async () => {
    env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-abort-1-' });
    try {
      const ac = new AbortController();
      let aborted = false;
      ac.signal.addEventListener('abort', () => { aborted = true; });
      const mockUpdater = makeMockCardUpdater();
      const patchedBodies: any[] = [];
      mockUpdater.patchAbortedTracking = async (opts: any) => {
        patchedBodies.push(opts);
      };
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac,
        sessionUuid: 'uuid-aaa',
        cwd: '/p',
        attachedAt: undefined,  // from-Reply
      });
      (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
      const cas: Array<{ old: any; nv: any }> = [];
      (env.userManager as any).compareAndSwap = async (_oid: string, old: any, nv: any) => {
        cas.push({ old, nv });
        return true;
      };

      await (env.bot as any).handleRendezvousAbortWait('ou_user1');

      expect(aborted).toBe(true);
      expect(patchedBodies).toHaveLength(1);
      // from-Reply 路径, body 提到 bg-conflict (不带 "已保留 Attach 状态")
      expect(patchedBodies[0].body).toContain('bg-conflict');
      expect(patchedBodies[0].body).not.toContain('已保留 Attach');
      expect(patchedBodies[0].headerTitle).toBe('🔙 已停止跟踪');
      expect(patchedBodies[0].headerTemplate).toBe('grey');
      expect((env.bot as any).activeRendezvousWaits.has('ou_user1')).toBe(false);
      expect(cas).toHaveLength(1);
      expect(cas[0].nv).toEqual(expect.objectContaining({
        type: 'session',
        sessionUuid: 'uuid-aaa',
        cwd: '/p',
      }));
      expect(cas[0].nv.attachedAt).toBeUndefined();
      // review gap 3: 不写 createdAt (MappingEntry 无此字段)
      expect(cas[0].nv.createdAt).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('from-Attach: aborts, restores user-mapping WITH attachedAt preserved', async () => {
    env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-abort-2-' });
    try {
      const ac = new AbortController();
      const mockUpdater = makeMockCardUpdater();
      const patchedBodies: any[] = [];
      mockUpdater.patchAbortedTracking = async (opts: any) => {
        patchedBodies.push(opts);
      };
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac,
        sessionUuid: 'uuid-aaa',
        cwd: '/p',
        attachedAt: '2026-06-13T10:00:00.000Z',  // from-Attach
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
      // from-Attach 路径, body 提到 "已保留 Attach 状态"
      expect(patchedBodies[0].body).toContain('已保留 Attach');
    } finally {
      env.cleanup();
    }
  });

  it('race guard (review gap 2): bg already complete → no-op, 不 abort 不 patch 不 CAS', async () => {
    env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-abort-3-' });
    try {
      const ac = new AbortController();
      let aborted = false;
      ac.signal.addEventListener('abort', () => { aborted = true; });
      // 关键: getState() 返回 'complete' 模拟 bg 已先收尾
      const mockUpdater = makeMockCardUpdater({ getState: () => 'complete' });
      let patchCalls = 0;
      mockUpdater.patchAbortedTracking = async () => { patchCalls++; };
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac, sessionUuid: 'u', cwd: '/', attachedAt: undefined,
      });
      (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
      const cas: any[] = [];
      (env.userManager as any).compareAndSwap = async (_oid: string, _old: any, nv: any) => {
        cas.push(nv);
        return true;
      };

      const r = await (env.bot as any).handleRendezvousAbortWait('ou_user1');

      expect(r).toBeNull();
      expect(aborted).toBe(false);                    // 不 abort
      expect(patchCalls).toBe(0);                      // 不 patch 覆盖终态卡
      expect(cas).toHaveLength(0);                     // 不动 user-mapping
      // 不清 maps — 让 runStreamingRendezvousReply 终态块自己清
      expect((env.bot as any).activeRendezvousWaits.has('ou_user1')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('idempotent: no-op when openId not in map', async () => {
    env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-abort-4-' });
    try {
      const r = await (env.bot as any).handleRendezvousAbortWait('ou_nonexistent');
      expect(r).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});
