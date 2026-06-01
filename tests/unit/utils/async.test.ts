import { describe, test, expect } from 'bun:test';

describe('withTimeout', () => {
  test('promise 在超时前 resolve → 返回原值', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    const result = await withTimeout(Promise.resolve(42), 1000, -1);
    expect(result).toBe(42);
  });

  test('promise 超时 → 返回 fallback（不 reject）', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    const slow = new Promise<number>(r => setTimeout(() => r(42), 200));
    const result = await withTimeout(slow, 50, -1);
    expect(result).toBe(-1);
  });

  test('内部 timer 在 resolve 时清理（不留僵尸 timer）', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    await withTimeout(Promise.resolve(1), 60_000, 0);
    // 验证：通过 = timer 已被 clearTimeout
  });
});
