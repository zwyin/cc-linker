import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { withLock } from '../../../src/utils/lock';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('withLock', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cc-bridge-lock-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFile = join(tmpDir, 'test.json');
    writeFileSync(testFile, '{"value": 0}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes function and returns result', async () => {
    const result = await withLock(testFile, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('allows atomic write during lock', async () => {
    await withLock(testFile, async () => {
      const tmp = testFile + '.tmp';
      writeFileSync(tmp, '{"value": 1}');
      const { renameSync } = await import('fs');
      renameSync(tmp, testFile);
    });

    const content = JSON.parse(readFileSync(testFile, 'utf8'));
    expect(content.value).toBe(1);
  });

  it('cleans up lock after error', async () => {
    try {
      await withLock(testFile, async () => {
        throw new Error('test error');
      });
    } catch {}

    // Should be able to acquire lock again
    const result = await withLock(testFile, async () => 'success');
    expect(result).toBe('success');
  });
});
