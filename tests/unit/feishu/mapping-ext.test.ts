import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MappingEntry, MappingEntryType } from '../../../src/feishu/mapping';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';

describe('MappingEntryType extension (Agent View)', () => {
  test('supports pending_agent_reply and last_agent_list_card', () => {
    const types: MappingEntryType[] = [
      'session',
      'pending_new_session',
      'pending_new_session_claimed',
      'pending_agent_reply',
      'last_agent_list_card',
    ];
    expect(types).toHaveLength(5);
  });

  test('pending_agent_reply entry has required Agent View fields', () => {
    const entry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc',
      createdAt: '2026-06-06T00:00:00.000Z',
      cwd: '/Users/wuyujun/Git/cc-linker',
      shortId: '92664deb',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
      casToken: 'test-token',
    };
    expect(entry.type).toBe('pending_agent_reply');
    expect(entry.shortId).toBe('92664deb');
    expect(entry.timeoutMs).toBe(300000);
  });

  test('last_agent_list_card entry has sessionUuid=null', () => {
    const entry: MappingEntry = {
      type: 'last_agent_list_card',
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_xxxxx',
      updatedAt: '2026-06-06T00:00:00.000Z',
      casToken: 'test-token',
    };
    expect(entry.sessionUuid).toBeNull();
    expect(entry.cardMessageId).toBe('om_xxxxx');
  });
});

describe('entriesMatch behavior for new types (via UserManager CAS)', () => {
  let tmpDir: string;
  let tmpMapping: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mapping-cas-'));
    tmpMapping = join(tmpDir, 'user-mapping.json');
    (config as any).data.feishu_bot.owner_open_id = '';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('pending_agent_reply CAS only checks type/sessionUuid/cwd/casToken', async () => {
    const mgr = new UserManager(tmpMapping);
    const initial = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-A',
      cwd: '/path/a',
      createdAt: '2026-06-06T00:00:00.000Z',
      shortId: 'shortA',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
    };
    const cas1 = await mgr.compareAndSwap('open1', null, initial);
    expect(cas1).toBe(true);

    const current = mgr.getEntry('open1')!;
    const casToken = current.casToken!;
    const expected = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-A',
      cwd: '/path/a',
      createdAt: '2026-06-06T00:00:00.000Z',
      shortId: 'shortA',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
      casToken,
    };
    const newValue = {
      ...expected,
      shortId: 'shortA-changed',
      startedAt: '2026-06-06T01:00:00.000Z',
      timeoutMs: 600000,
    };
    const cas2 = await mgr.compareAndSwap('open1', expected, newValue);
    expect(cas2).toBe(true);
    const updated = mgr.getEntry('open1')!;
    expect(updated.shortId).toBe('shortA-changed');
    expect(updated.timeoutMs).toBe(600000);
  });

  test('last_agent_list_card CAS: sessionUuid=null + cwd=null 匹配', async () => {
    const mgr = new UserManager(tmpMapping);
    const entry = {
      type: 'last_agent_list_card' as const,
      sessionUuid: null,
      cwd: undefined,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_123',
      updatedAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open2', null, entry);
    expect(cas1).toBe(true);

    const current = mgr.getEntry('open2')!;
    expect(current.sessionUuid).toBeNull();
    expect(current.cardMessageId).toBe('om_123');
  });

  test('互斥保证: pending_agent_reply → last_agent_list_card type 不等 → CAS 失败', async () => {
    const mgr = new UserManager(tmpMapping);
    const replyEntry = {
      type: 'pending_agent_reply' as const,
      sessionUuid: 'uuid-X',
      cwd: '/x',
      createdAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open3', null, replyEntry);
    expect(cas1).toBe(true);

    // Simulate a concurrent worker that holds stale state of a different type —
    // entriesMatch must reject the type mismatch, so CAS fails.
    const staleExpected = {
      type: 'last_agent_list_card' as const,
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_stale',
    };
    const newListCard = {
      type: 'last_agent_list_card' as const,
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_999',
    };
    const cas2 = await mgr.compareAndSwap('open3', staleExpected, newListCard);
    expect(cas2).toBe(false);

    // The pending_agent_reply entry must remain intact.
    const current = mgr.getEntry('open3')!;
    expect(current.type).toBe('pending_agent_reply');
    expect(current.sessionUuid).toBe('uuid-X');
  });

  test('旧 type 兼容性: pending_new_session CAS 行为不变', async () => {
    const mgr = new UserManager(tmpMapping);
    const entry = {
      type: 'pending_new_session' as const,
      sessionUuid: null,
      cwd: '/old',
      createdAt: '2026-06-06T00:00:00.000Z',
    };
    const cas1 = await mgr.compareAndSwap('open4', null, entry);
    expect(cas1).toBe(true);
  });
});
