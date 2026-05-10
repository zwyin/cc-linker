import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SpoolQueue } from '../../../src/queue/spool';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SpoolQueue', () => {
  let tmpDir: string;
  let spool: SpoolQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-test-'));
    spool = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueues a message', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const, sessionUuid: 'uuid-1' },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(spool.enqueue(msg)).toBe(true);
    expect(spool.queueSize()).toBe(1);
  });

  it('rejects duplicate message (idempotency)', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(spool.enqueue(msg)).toBe(true);
    expect(spool.enqueue(msg)).toBe(false); // duplicate
  });

  it('claims and processes a message', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    const claimed = spool.claimNext('uuid-1');

    expect(claimed).not.toBeNull();
    expect(claimed?.messageId).toBe('msg-1');
    expect(claimed?.status).toBe('processing');
    expect(spool.queueSize()).toBe(1); // still in processing
  });

  it('marks message as done', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    spool.claimNext('uuid-1');
    spool.markDone('msg-1', 'uuid-1', 'reply-123');

    expect(spool.queueSize()).toBe(0);
    const done = spool.listPending(); // pending should be empty
    expect(done).toHaveLength(0);
  });

  it('marks message as failed', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    spool.claimNext('uuid-1');
    spool.markFailed('msg-1', 'uuid-1', 'test error');

    expect(spool.queueSize()).toBe(0);
  });

  it('recovers processing messages on startup', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Simulate a crashed processing message
    const path = join(spool['processingDir'], `uuid-1:msg-1.json`);
    writeFileSync(path, JSON.stringify(msg));

    const recovered = spool.recoverProcessing();
    expect(recovered).toBe(1);
    expect(spool.queueSize()).toBe(1); // back to pending
  });

  it('listPending returns sorted messages', () => {
    const msgs = [
      { messageId: 'msg-2', openId: 'ou_user1', text: 'second', target: { type: 'session' as const }, serialKey: 'uuid-1', status: 'pending' as const, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      { messageId: 'msg-1', openId: 'ou_user1', text: 'first', target: { type: 'session' as const }, serialKey: 'uuid-1', status: 'pending' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ];

    spool.enqueue(msgs[0]);
    spool.enqueue(msgs[1]);

    const pending = spool.listPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].messageId).toBe('msg-1');
    expect(pending[1].messageId).toBe('msg-2');
  });

  it('recordDelivery is idempotent (preserves createdAt)', () => {
    spool.recordDelivery('msg-1', 'sending', 'uuid-1');
    const d1 = spool.getDelivery('msg-1');
    expect(d1?.status).toBe('sending');
    expect(d1?.createdAt).toBeDefined();

    const createdBefore = d1!.createdAt;

    // Update to sent
    spool.recordDelivery('msg-1', 'sent', 'uuid-1');
    const d2 = spool.getDelivery('msg-1');
    expect(d2?.status).toBe('sent');
    expect(d2?.createdAt).toBe(createdBefore); // preserved
  });
});
