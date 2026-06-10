import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExpectedReplyState } from '../../../src/agent-view/expected-reply-state';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';

let tmpDir: string;
let tmpMapping: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'expected-reply-'));
  tmpMapping = join(tmpDir, 'user-mapping.json');
  (config as any).data.feishu_bot.owner_open_id = '';
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ExpectedReplyState — basic set/clear', () => {
  test('set writes both in-memory and user-mapping', async () => {
    const userManager = new UserManager(tmpMapping);
    const state = new ExpectedReplyState(userManager, 300_000);
    await state.set('open1', { shortId: 'short1', sessionId: 'uuid-1', cwd: '/a' });
    expect(state.get('open1')?.shortId).toBe('short1');
    const entry = userManager.getEntry('open1');
    expect(entry?.type).toBe('pending_agent_reply');
    expect((entry as any)?.shortId).toBe('short1');
  });

  test('clear removes from both in-memory and user-mapping', async () => {
    const userManager = new UserManager(tmpMapping);
    const state = new ExpectedReplyState(userManager, 300_000);
    await state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    await state.clear('open1');
    expect(state.get('open1')).toBeUndefined();
    expect(userManager.getEntry('open1')).toBeUndefined();
  });
});

describe('ExpectedReplyState — CAS conflict', () => {
  test('set fails when existing entry is a real active session (other end busy)', async () => {
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: 'u', cwd: '/x', createdAt: new Date().toISOString(),
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await expect(state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' }))
      .rejects.toThrow();
  });

  test('v2.3.3: set auto-clears transient last_agent_list_card entry', async () => {
    // 模拟:用户发 /agents → handleList 写了 last_agent_list_card entry →
    // 用户点 Reply → handleReplyRequest 进来前 entry 仍是 last_agent_list_card
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'last_agent_list_card',
      sessionUuid: null,
      createdAt: new Date().toISOString(),
      cardMessageId: 'om_list_1',
      updatedAt: new Date().toISOString(),
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    // 不应该 throw — 智能 CAS 自动清 transient
    await state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    expect(state.get('open1')?.shortId).toBe('s1');
    expect(userManager.getEntry('open1')?.type).toBe('pending_agent_reply');
  });

  test('v2.3.3: set auto-clears stale pending_agent_reply entry (timeout 前重 click)', async () => {
    const userManager = new UserManager(tmpMapping);
    // 模拟一个上一次的 pending_agent_reply(还没 timeout)
    await userManager.compareAndSwap('open1', null, {
      type: 'pending_agent_reply', sessionUuid: 'old', cwd: '/a',
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      timeoutMs: 300_000, shortId: 'olds', casToken: 'old-token',
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await state.set('open1', { shortId: 'newS', sessionId: 'newUuid', cwd: '/b' });
    expect(state.get('open1')?.shortId).toBe('newS');
    expect((userManager.getEntry('open1') as any)?.sessionUuid).toBe('newUuid');
  });

  test('v2.3.3: set auto-clears same-session session entry (user 先 Attach 再点 Reply)', async () => {
    const userManager = new UserManager(tmpMapping);
    // 模拟:用户之前点了 Attach 把 timer session attach 到飞书侧
    const targetUuid = '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b';
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: targetUuid, cwd: '/Users/x',
      createdAt: new Date().toISOString(), casToken: 'old-token',
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    // 用户现在点 Reply 切到 waiting 模式 — 应当自动 detach + set 成功
    await state.set('open1', { shortId: '3a41fe73', sessionId: targetUuid, cwd: '/Users/x' });
    expect(state.get('open1')?.shortId).toBe('3a41fe73');
    expect(userManager.getEntry('open1')?.type).toBe('pending_agent_reply');
  });

  test('v2.3.3: set rejects when existing session entry is for a DIFFERENT session', async () => {
    // 模拟:用户 attach 到 session A,但点 Reply 想 reply session B → 真冲突
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: 'uuid-A', cwd: '/a',
      createdAt: new Date().toISOString(), casToken: 'old-token',
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await expect(state.set('open1', { shortId: 'sB', sessionId: 'uuid-B', cwd: '/b' }))
      .rejects.toThrow(/different session/);
  });
});

describe('ExpectedReplyState — timeout', () => {
  test('auto-clears after timeoutMs via setTimeout', async () => {
    const userManager = new UserManager(tmpMapping);
    const shortState = new ExpectedReplyState(userManager, 100);
    await shortState.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    await new Promise(r => setTimeout(r, 200));
    expect(shortState.get('open1')).toBeUndefined();
    expect(userManager.getEntry('open1')).toBeUndefined();
  });
});

describe('ExpectedReplyState — bot restart recovery (R8)', () => {
  test('restoreExpectedReplyStates: 超时的静默删除,未超时的重建 setTimeout', async () => {
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'pending_agent_reply', sessionUuid: 'uuid-1', cwd: '/a',
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      timeoutMs: 300_000,
      shortId: 'short1',
    });
    await userManager.compareAndSwap('open2', null, {
      type: 'pending_agent_reply', sessionUuid: 'uuid-2', cwd: '/b',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 300_000,
      shortId: 'short2',
    });
    const newState = new ExpectedReplyState(userManager, 300_000);
    await newState.restoreExpectedReplyStates();
    expect(userManager.getEntry('open1')).toBeUndefined();
    expect(newState.get('open2')?.shortId).toBe('short2');
  });
});
