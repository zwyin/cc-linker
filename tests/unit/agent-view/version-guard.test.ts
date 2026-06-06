import { describe, test, expect, mock } from 'bun:test';
import { VersionGuard } from '../../../src/agent-view/version-guard';

// Mock node:child_process via bun's mock.module.
// Plan template's `(cp as any).execFileSync = ...` does not work in Bun ESM
// (module namespace bindings are read-only).
const execFileSyncMock = mock((_cmd: string, _args: string[], _opts: unknown) => '');

mock.module('node:child_process', () => {
  // Re-export all real bindings, then override execFileSync.
  // The unused import is intentional — the real module is loaded for sibling
  // helpers (exec, spawn, etc.) if any test code needs them later.
  const real = require('node:child_process');
  return {
    ...real,
    execFileSync: execFileSyncMock,
  };
});

describe('VersionGuard.check', () => {
  test('returns ok=true for version >= 2.1.139', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163 (Claude Code)\n');
    const result = await VersionGuard.check();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('2.1.163');
  });

  test('returns ok=false for version < 2.1.139', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.100\n');
    const result = await VersionGuard.check();
    expect(result.ok).toBe(false);
    expect(result.version).toBe('2.1.100');
    expect(result.reason).toContain('2.1.139');
  });

  test('returns ok=false when claude not found (ENOENT)', async () => {
    execFileSyncMock.mockImplementation(() => {
      const e: any = new Error('spawn claude ENOENT');
      e.code = 'ENOENT';
      throw e;
    });
    const result = await VersionGuard.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not installed');
  });
});
