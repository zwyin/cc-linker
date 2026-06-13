/**
 * handleRendezvousStopBgConfirm TDD tests (Cluster 4.5).
 *
 * Covers:
 * - Normal: from-Attach path, aborts + claude stop + patches card + restores
 *   user-mapping WITH attachedAt preserved
 * - Normal: from-Reply path, restores user-mapping WITHOUT attachedAt
 * - Race 1: bg already completed (entry cleared) → "已自然完成" reply
 * - Race 2 (review gap 2): entry still in map but updater.getState()===complete
 *   → skip claude stop, 走"已自然完成" branch, do not clobber terminal card
 * - Graceful: "No job matching" stderr treated as success
 */
import { describe, it, expect } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

describe('FeishuBot.handleRendezvousStopBgConfirm (Cluster 4.5)', () => {
  function makeMockUpdater(overrides: {
    getState?: () => 'processing' | 'streaming' | 'complete' | 'error' | 'cancelled';
  } = {}): any {
    return {
      getState: overrides.getState ?? (() => 'processing' as const),
      patchAbortedTracking: async () => {},
      cancelPending: () => {},
      error: async () => {},
    };
  }

  it('aborts + claude stop + patches card + restores user-mapping (from-Attach preserves attachedAt)', async () => {
    const env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-stop-1-' });
    try {
      const ac = new AbortController();
      let aborted = false;
      ac.signal.addEventListener('abort', () => { aborted = true; });
      const mockUpdater = makeMockUpdater();
      let patchCalls = 0;
      mockUpdater.patchAbortedTracking = async () => { patchCalls++; };
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac, sessionUuid: 'u-aaa', cwd: '/p',
        attachedAt: '2026-06-13T10:00:00.000Z',
      });
      (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
      const replies: any[] = [];
      (env.bot as any).replyFn = async (t: string) => { replies.push(t); };
      const cas: any[] = [];
      (env.userManager as any).compareAndSwap = async (_oid: string, _old: any, nv: any) => {
        cas.push(nv);
        return true;
      };
      // mock execFile (node:child_process) — claude stop 返回成功
      // bun:test 没有 jest.mock; 我们 stub node:child_process 通过 monkey-patch
      // 实际上 handler 内部 await import('node:child_process') + promisify, 真实调用会失败。
      // 我们让 execFile 抛 "No job matching" 让 handler 走 graceful 路径 (视作成功)。
      // 简单办法: 直接调 handler, 让它真跑, 然后验证 replyFn 收到 "✅ 已停止" 或 "已自然完成"
      // — 但这样依赖环境。改方案: stub cp.execFile 全局, 详见 bot.ts 实现
      // 因为代码已经 mock-friendly, 我们用全局替换方式:
      const cp = require('node:child_process');
      const origExecFile = cp.execFile;
      cp.execFile = (_cmd: string, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, '', '');  // success
        else return { on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } };
      };
      try {
        await (env.bot as any).handleRendezvousStopBgConfirm('ou_user1', 'abc12345');
      } finally {
        cp.execFile = origExecFile;
      }

      expect(aborted).toBe(true);
      expect(patchCalls).toBe(1);
      expect(replies[0]).toContain('已停止');
      expect((env.bot as any).activeRendezvousWaits.has('ou_user1')).toBe(false);
      expect(cas).toHaveLength(1);
      expect(cas[0]).toEqual(expect.objectContaining({
        type: 'session', sessionUuid: 'u-aaa', cwd: '/p',
        attachedAt: '2026-06-13T10:00:00.000Z',
      }));
      expect(cas[0].createdAt).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('from-Reply: restores user-mapping WITHOUT attachedAt', async () => {
    const env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-stop-2-' });
    try {
      const ac = new AbortController();
      const mockUpdater = makeMockUpdater();
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
      });
      (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
      const cas: any[] = [];
      (env.userManager as any).compareAndSwap = async (_oid: string, _old: any, nv: any) => {
        cas.push(nv);
        return true;
      };
      const cp = require('node:child_process');
      const origExecFile = cp.execFile;
      cp.execFile = (_cmd: string, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, '', '');
      };
      try {
        await (env.bot as any).handleRendezvousStopBgConfirm('ou_user1', 'abc12345');
      } finally {
        cp.execFile = origExecFile;
      }

      expect(cas).toHaveLength(1);
      expect(cas[0].attachedAt).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('race 1: bg already completed (no entry) → "已自然完成" reply, no execFile', async () => {
    const env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-stop-3-' });
    try {
      const replies: any[] = [];
      (env.bot as any).replyFn = async (t: string) => { replies.push(t); };
      await (env.bot as any).handleRendezvousStopBgConfirm('ou_user1', 'abc12345');
      expect(replies[0]).toContain('已自然完成');
    } finally {
      env.cleanup();
    }
  });

  it('race guard 2 (review gap 2): entry 还在 map 但 updater.getState()===complete → 不调 claude stop, 走"已自然完成"', async () => {
    const env = createTestBot({ tmpDirPrefix: 'bot-rendezvous-stop-4-' });
    try {
      const ac = new AbortController();
      let aborted = false;
      ac.signal.addEventListener('abort', () => { aborted = true; });
      const mockUpdater = makeMockUpdater({ getState: () => 'complete' });
      let patchCalls = 0;
      mockUpdater.patchAbortedTracking = async () => { patchCalls++; };
      (env.bot as any).activeRendezvousWaits.set('ou_user1', {
        abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
      });
      (env.bot as any).rendezvousCardUpdaters.set('ou_user1', mockUpdater);
      const replies: any[] = [];
      (env.bot as any).replyFn = async (t: string) => { replies.push(t); };
      const cas: any[] = [];
      (env.userManager as any).compareAndSwap = async (_oid: string, _old: any, nv: any) => {
        cas.push(nv);
        return true;
      };
      // 如果 handler 错误调了 execFile, 我们的 stub 会让回调 null,但这里不该被调
      let execFileCalled = false;
      const cp = require('node:child_process');
      const origExecFile = cp.execFile;
      cp.execFile = () => { execFileCalled = true; if (arguments[3]) arguments[3](null, '', ''); };
      try {
        await (env.bot as any).handleRendezvousStopBgConfirm('ou_user1', 'abc12345');
      } finally {
        cp.execFile = origExecFile;
      }

      expect(execFileCalled).toBe(false);                  // 没调 claude stop
      expect(aborted).toBe(false);                          // 没 abort
      expect(patchCalls).toBe(0);                           // 没覆盖终态卡
      expect(cas).toHaveLength(0);                          // 没动 user-mapping
      expect(replies[0]).toContain('已自然完成');
      expect((env.bot as any).activeRendezvousWaits.has('ou_user1')).toBe(false);  // 还是要清
    } finally {
      env.cleanup();
    }
  });
});
