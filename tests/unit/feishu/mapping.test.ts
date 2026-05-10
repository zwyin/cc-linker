import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('UserManager', () => {
  let tmpDir: string;
  let mappingPath: string;
  let userManager: UserManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'user-mapping-test-'));
    mappingPath = join(tmpDir, 'user-mapping.json');
    userManager = new UserManager(mappingPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty mapping file on construction', () => {
    userManager.getEntry("test"); // trigger lazy init
    expect(existsSync(mappingPath)).toBe(true);
    const raw = readFileSync(mappingPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(0);
    expect(data.entries).toEqual({});
  });

  it('getEntry returns undefined for unknown openId', () => {
    expect(userManager.getEntry('unknown_open_id')).toBeUndefined();
  });

  it('compareAndSwap creates new entry', async () => {
    const result = await userManager.compareAndSwap(
      'ou_user1',
      null, // expected: no existing entry
      { type: 'session', sessionUuid: 'uuid-1', createdAt: new Date().toISOString() }
    );

    expect(result).toBe(true);
    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('session');
    expect(entry?.sessionUuid).toBe('uuid-1');
  });

  it('compareAndSwap fails when expected value does not match', async () => {
    // First, create an entry
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      { type: 'session', sessionUuid: 'uuid-1', createdAt: new Date().toISOString() }
    );

    // Now try to CAS with wrong expected value
    const result = await userManager.compareAndSwap(
      'ou_user1',
      { type: 'pending_new_session', sessionUuid: null, createdAt: '' }, // wrong expected
      { type: 'session', sessionUuid: 'uuid-2', createdAt: new Date().toISOString() }
    );

    expect(result).toBe(false);
    // Entry should be unchanged
    const entry = userManager.getEntry('ou_user1');
    expect(entry?.sessionUuid).toBe('uuid-1');
  });

  it('compareAndSwap updates existing entry', async () => {
    // Create
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      { type: 'pending_new_session', sessionUuid: null, createdAt: new Date().toISOString() }
    );

    const current = userManager.getEntry('ou_user1');

    // Swap to claimed
    const result = await userManager.compareAndSwap(
      'ou_user1',
      current,
      {
        type: 'pending_new_session_claimed',
        sessionUuid: 'uuid-1',
        createdAt: current!.createdAt,
        claimedByMessageId: 'msg-123',
        claimedAt: new Date().toISOString(),
      }
    );

    expect(result).toBe(true);
    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session_claimed');
    expect(entry?.claimedByMessageId).toBe('msg-123');
  });

  it('compareAndSwap increments version on success', async () => {
    const m1 = userManager.getEntry('ou_user1');
    expect(m1).toBeUndefined();

    await userManager.compareAndSwap(
      'ou_user1',
      null,
      { type: 'session', sessionUuid: 'uuid-1', createdAt: new Date().toISOString() }
    );

    // Read raw file to check version
    const raw = readFileSync(mappingPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);

    await userManager.compareAndSwap(
      'ou_user1',
      data.entries['ou_user1'],
      { type: 'session', sessionUuid: 'uuid-2', createdAt: new Date().toISOString() }
    );

    const raw2 = readFileSync(mappingPath, 'utf8');
    const data2 = JSON.parse(raw2);
    expect(data2.version).toBe(2);
  });

  it('compareAndSwap deletes entry when newValue is null', async () => {
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      { type: 'session', sessionUuid: 'uuid-1', createdAt: new Date().toISOString() }
    );

    const current = userManager.getEntry('ou_user1');
    const result = await userManager.compareAndSwap('ou_user1', current, null);

    expect(result).toBe(true);
    expect(userManager.getEntry('ou_user1')).toBeUndefined();
  });

  it('rollbackTimedOutClaims rolls back expired claims', async () => {
    const now = new Date();
    const expiredTime = new Date(now.getTime() - 120 * 1000); // 2 minutes ago

    // Create an expired claim
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      {
        type: 'pending_new_session_claimed',
        sessionUuid: 'uuid-1',
        createdAt: expiredTime.toISOString(),
        claimedByMessageId: 'msg-123',
        claimedAt: expiredTime.toISOString(),
      }
    );

    const rolledBack = await userManager.rollbackTimedOutClaims();
    expect(rolledBack).toBe(1);

    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session');
    expect(entry?.claimedByMessageId).toBeUndefined();
    expect(entry?.claimedAt).toBeUndefined();
  });

  it('rollbackTimedOutClaims does not roll back recent claims', async () => {
    const now = new Date();

    await userManager.compareAndSwap(
      'ou_user1',
      null,
      {
        type: 'pending_new_session_claimed',
        sessionUuid: 'uuid-1',
        createdAt: now.toISOString(),
        claimedByMessageId: 'msg-123',
        claimedAt: now.toISOString(),
      }
    );

    const rolledBack = await userManager.rollbackTimedOutClaims();
    expect(rolledBack).toBe(0);

    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session_claimed');
  });

  it('validateOwner returns true when no owner configured', () => {
    expect(userManager.validateOwner('ou_any')).toBe(true);
  });

  it('CAS prevents concurrent updates to same openId', async () => {
    // Create initial entry
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      { type: 'session', sessionUuid: 'uuid-1', createdAt: new Date().toISOString() }
    );

    const entry = userManager.getEntry('ou_user1')!;

    // Two concurrent CAS with same expected value
    const results = await Promise.all([
      userManager.compareAndSwap(
        'ou_user1',
        entry,
        { type: 'session', sessionUuid: 'uuid-A', createdAt: new Date().toISOString() }
      ),
      userManager.compareAndSwap(
        'ou_user1',
        entry,
        { type: 'session', sessionUuid: 'uuid-B', createdAt: new Date().toISOString() }
      ),
    ]);

    // Exactly one should succeed (file lock serializes them)
    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(1);

    const finalEntry = userManager.getEntry('ou_user1');
    expect(finalEntry?.sessionUuid).toBeOneOf(['uuid-A', 'uuid-B']);
  });
});

describe('ListSnapshotManager', () => {
  let tmpDir: string;
  let snapshotPath: string;
  let manager: ListSnapshotManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'list-snapshot-test-'));
    snapshotPath = join(tmpDir, 'list-snapshot.json');
    manager = new ListSnapshotManager(snapshotPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no snapshot exists', () => {
    expect(manager.loadSnapshot()).toBeNull();
  });

  it('saves and loads snapshot', () => {
    manager.saveSnapshot('ou_user1', [
      { index: 1, uuid: 'uuid-1', title: 'Session 1' },
      { index: 2, uuid: 'uuid-2', title: 'Session 2' },
    ]);

    const snapshot = manager.loadSnapshot('ou_user1');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.entries).toHaveLength(2);
    expect(snapshot!.openId).toBe('ou_user1');
  });

  it('resolves index to UUID', () => {
    manager.saveSnapshot('ou_user1', [
      { index: 1, uuid: 'uuid-1', title: 'Session 1' },
      { index: 2, uuid: 'uuid-2', title: 'Session 2' },
    ]);

    expect(manager.resolveIndex(1, 'ou_user1')).toBe('uuid-1');
    expect(manager.resolveIndex(2, 'ou_user1')).toBe('uuid-2');
    expect(manager.resolveIndex(3, 'ou_user1')).toBeNull();
  });

  it('returns null for expired snapshot', () => {
    manager.saveSnapshot('ou_user1', [
      { index: 1, uuid: 'uuid-1', title: 'Session 1' },
    ]);

    // Manually backdate the snapshot
    const raw = readFileSync(snapshotPath, 'utf8');
    const data = JSON.parse(raw);
    data.createdAt = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // 11 minutes ago
    writeFileSync(snapshotPath, JSON.stringify(data, null, 2));

    expect(manager.loadSnapshot()).toBeNull();
    expect(manager.resolveIndex(1)).toBeNull();
  });

  it('returns null when openId does not match', () => {
    manager.saveSnapshot('ou_user1', [
      { index: 1, uuid: 'uuid-1', title: 'Session 1' },
    ]);

    // Different openId should not see the snapshot
    expect(manager.loadSnapshot('ou_user2')).toBeNull();
  });

  it('clearSnapshot removes data', () => {
    manager.saveSnapshot('ou_user1', [
      { index: 1, uuid: 'uuid-1', title: 'Session 1' },
    ]);

    manager.clearSnapshot();

    // After clearing, file should be deleted and loadSnapshot returns null
    expect(manager.loadSnapshot()).toBeNull();
  });
});
