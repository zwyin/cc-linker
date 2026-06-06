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
  test('set fails when existing entry has different type', async () => {
    const userManager = new UserManager(tmpMapping);
    await userManager.compareAndSwap('open1', null, {
      type: 'session', sessionUuid: 'u', cwd: '/x', createdAt: new Date().toISOString(),
    });
    const state = new ExpectedReplyState(userManager, 300_000);
    await expect(state.set('open1', { shortId: 's1', sessionId: 'u1', cwd: '/a' }))
      .rejects.toThrow();
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
