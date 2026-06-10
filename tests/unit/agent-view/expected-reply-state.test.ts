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
  test('set fails ONLY when existing entry is pending_new_session_claimed (real "other end busy")', async () => {
    // v2.3.12:`pending_new_session_claimed` 是唯一真"另一端在跑"的状态 —— bot 正在
    // spawn 新 session 的 Claude 进程,binding callback (bindSessionToClaim) 会回写
    // 这条 entry。这时清掉它会让 SDK 收尾找不到目标 entry,sessionUuid 永远悬空。
    // 其他类型(session / pending_new_session / transient)都是用户自己的状态,
    // 用户点 [Reply] 即显式 override 意图,允许自动清。
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'pending_new_session_claimed',
      sessionUuid: null,
      cwd: '/x',
      createdAt: new Date().toISOString(),
      claimedByMessageId: 'om_claim_1',
      claimedAt: new Date().toISOString(),
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

  test('v2.3.12: set auto-clears DIFFERENT-session session entry (user attached to A, clicks Reply on B)', async () => {
    // 真实复现 (2026-06-10):用户先 Attach session A → user-mapping 是
    // { type:'session', sessionUuid:A }。然后 /agents 看列表点 Reply session B → 之前
    // 智能 CAS 抛 "existing entry is 'session' for a different session",用户看到红色
    // ⚠️ 误以为冲突。其实意图很明确 — 用户主动要切到 B,旧 attach 应当被踢掉。
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: 'uuid-A', cwd: '/a',
      createdAt: new Date().toISOString(), casToken: 'old-token',
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await state.set('open1', { shortId: 'sB', sessionId: 'uuid-B', cwd: '/b' });
    expect(state.get('open1')?.shortId).toBe('sB');
    expect((userManager.getEntry('open1') as any)?.sessionUuid).toBe('uuid-B');
  });

  test('v2.3.12: set auto-clears pending_new_session entry (user pasted /new, then clicks Reply 改变主意)', async () => {
    // /bridge new 没带 prompt → user-mapping 是 pending_new_session,等下一条 message。
    // 没有任何 in-flight 异步工作 (区别于 claimed),用户点 Reply 改主意 — 安全自动清。
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'pending_new_session',
      sessionUuid: null,
      cwd: '/x',
      createdAt: new Date().toISOString(),
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' });
    expect(state.get('open1')?.shortId).toBe('s1');
    expect(userManager.getEntry('open1')?.type).toBe('pending_agent_reply');
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
