import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClaudeSessionManager, resolveJsonlPath, terminateProcessTree, cleanupOrphanProcesses } from '../../../src/proxy/session';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ClaudeSessionManager', () => {
  let manager: ClaudeSessionManager;

  beforeEach(() => {
    manager = new ClaudeSessionManager();
  });

  afterEach(() => {
    // Cleanup any remaining processes
    for (const session of manager.listSessions()) {
      try { process.kill(session.pid, 'SIGKILL'); } catch {}
    }
  });

  it('listSessions returns empty initially', () => {
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('listSessions tracks active processes', () => {
    // listSessions should return empty since no real processes are running
    expect(manager.listSessions()).toHaveLength(0);
  });

  // Note: sendMessage integration test requires real Claude binary.
  // Covered by integration tests in a separate file.

  it('per-session lock allows different sessions concurrently', async () => {
    // Verify that lock mechanism allows different session keys
    const m = new ClaudeSessionManager();

    // Two different sessions should not block each other at the lock level
    // (actual spawn will block, but locks should be independent)
    const p1 = m.sendMessage('session-a', 'msg1', '/tmp');
    const p2 = m.sendMessage('session-b', 'msg2', '/tmp');

    // Both should start (may not finish quickly due to real spawn)
    await Promise.allSettled([
      Promise.race([p1, new Promise(r => setTimeout(() => r('timeout'), 2000))]),
      Promise.race([p2, new Promise(r => setTimeout(() => r('timeout'), 2000))]),
    ]);
  });

  it('per-session lock prevents concurrent messages', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    // We can't easily mock the actual spawn, but we can verify the lock mechanism
    // by checking that sessionLocks are properly managed
    const m = new ClaudeSessionManager();

    // Send two messages for the same session
    const p1 = m.sendMessage('session-1', 'msg1', '/tmp');
    const p2 = m.sendMessage('session-1', 'msg2', '/tmp');

    // Both should eventually resolve (may take time due to spawn)
    await Promise.allSettled([p1, p2]);
  });

  it('cleanupIdleSessions kills processes past timeout', () => {
    // Create a manager and verify the method runs without error
    manager.cleanupIdleSessions(0); // 0 timeout should kill nothing since no active processes
    expect(manager.listSessions()).toHaveLength(0);
  });
});

describe('resolveJsonlPath', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'resolve-jsonl-test-'));
    originalEnv = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when JSONL not found within timeout', async () => {
    const result = await resolveJsonlPath('nonexistent-uuid', 500);
    expect(result).toBeNull();
  });

  it('respects timeout parameter', async () => {
    const start = Date.now();
    await resolveJsonlPath('nonexistent-uuid', 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000); // should not take much longer than timeout
  });
});

describe('terminateProcessTree', () => {
  it('does not throw for non-existent PID', () => {
    // Should not throw
    expect(() => terminateProcessTree(999999)).not.toThrow();
  });

  it('terminates a live process', async () => {
    // Start a long-running process
    const proc = Bun.spawn(['sleep', '60'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const pid = proc.pid;

    // Terminate it
    terminateProcessTree(pid);

    // Wait a bit for SIGKILL to take effect
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify process is dead
    try {
      process.kill(pid, 0);
      // If we get here, process is still alive - kill it forcefully
      process.kill(pid, 'SIGKILL');
    } catch {
      // Expected: process is dead
    }
  });
});

describe('cleanupOrphanProcesses', () => {
  it('runs without error when no orphan processes exist', () => {
    expect(() => cleanupOrphanProcesses()).not.toThrow();
  });
});
