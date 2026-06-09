// tests/unit/feishu/patch.test.ts
//
// v2.2.20 设计意图:patchFn 默认 0ms 延迟(立即发)。
// 历史:旧版 start.ts:411-435 写死 1200ms 延迟,源自 permission card
// 路径的"避免 Feishu card action event lock"思路。但 agent-view 的
// patchFn 也会被 6 处 handler 复用,1.2s 延迟让用户点 Refresh 后飞书客户端
// 1.2s 都看不到新内容,叠加 Peek 卡 update_multi:true 出现 revert 现象。
//
// 修复后(commit 73 配套):delayMs 默认 0,permission card 走自己的
// setTimeout 不影响。attach 卡片 10s 自动 patch 立刻发出,无 1.2s 延迟。
//
// 注:createPatchFn 函数注释(start.ts:408)明说"默认 0",但代码里
// 一度保留 = 1200 的 fallback。2026-06-09 修:对齐注释意图,默认改 0。

import { describe, test, expect, mock } from 'bun:test';
import { createPatchFn } from '../../../src/feishu/patch';

const noopLog = () => {};

describe('createPatchFn (v2.2.20: default 0ms delay)', () => {
  test('默认 delayMs=0:patch 立即发出(无 1.2s 延迟,修 2026-06-09 UX bug)', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog);
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    // 默认 0ms,留 50ms 上限给 JS 调度抖动
    expect(elapsed).toBeLessThan(50);
  });

  test('forceImmediate=true 跳过延迟(测试模式加速用)', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { forceImmediate: true });
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    expect(elapsed).toBeLessThan(50);
  });

  test('显式传 delayMs=300:自定义延迟生效', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { delayMs: 300 });
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(400);
  });

  test('feishu 返回非 0 code:记 WARN,返回 null,不发异常', async () => {
    const logMessages: string[] = [];
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => ({
              code: 230020,
              msg: 'card not found',
            })),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, (level, msg) => {
      logMessages.push(`${level}:${msg}`);
    });
    const result = await patchFn('om_gone', '{}');
    expect(result).toBeNull();
    expect(logMessages.some(m => m.startsWith('WARN'))).toBe(true);
  });

  test('feishu 抛异常:记 WARN,返回 null,不冒泡', async () => {
    const logMessages: string[] = [];
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              throw new Error('network down');
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, (level, msg) => {
      logMessages.push(`${level}:${msg}`);
    });
    const result = await patchFn('om_x', '{}');
    expect(result).toBeNull();
    expect(logMessages.some(m => m.includes('network down'))).toBe(true);
  });

  test('payload 正确传给 feishu client(包含 message_id 和 content)', async () => {
    let captured: any = null;
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (payload: any) => {
              captured = payload;
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { forceImmediate: true });
    await patchFn('om_xyz', '{"config":{"wide_screen_mode":true}}');
    expect(captured.path.message_id).toBe('om_xyz');
    expect(captured.data.content).toBe('{"config":{"wide_screen_mode":true}}');
  });
});
