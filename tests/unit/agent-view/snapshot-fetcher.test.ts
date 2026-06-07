import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';

// Mock node:child_process via mock.module (Bun ESM pattern from T5).
// Plan template's `(cp as any).execFileSync = ...` does not work in Bun ESM
// (module namespace bindings are read-only).
const execFileSyncMock = mock((_cmd: string, _args: string[], _opts?: unknown): string => '');
const execFileMock = mock(
  (
    _cmd: string,
    _args: string[],
    cb: (err: any, stdout: string, stderr: string) => void
  ) => {
    cb(null, '', '');
  }
);

mock.module('node:child_process', () => {
  const real = require('node:child_process');
  return {
    ...real,
    execFileSync: execFileSyncMock,
    execFile: execFileMock,
  };
});

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

// Monkey-patch DaemonProbe.check (already-loaded module — can't use mock.module
// after the fact for its bindings inside snapshot-fetcher).
const origProbeCheck = DaemonProbe.check;

// Snapshot the original AgentSnapshotFetcher.fetch so we can restore it before
// each test — earlier test files (e.g. bot-handlechat-routing.test.ts) overwrite
// `AgentSnapshotFetcher.fetch` without restoring it, and that override leaks
// into this file when both run in the same `bun test` invocation.
const origFetch = AgentSnapshotFetcher.fetch;

// v2.2.1: snapshot-fetcher 内部会调 readRoster() 读 ~/.claude/daemon/roster.json。
// 这个测试用 fixture sessionIds("uuid-1", "uuid-2"),通常不匹配本机 roster,
// 此时所有 session 的 source 会变成 'unknown',filterUserDispatched 会保留它们
// (graceful degradation)。所以不需要 mock roster-source。

beforeEach(() => {
  (DaemonProbe as any).check = origProbeCheck;
  (AgentSnapshotFetcher as any).fetch = origFetch;
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
});

afterAll(() => {
  (DaemonProbe as any).check = origProbeCheck;
  (AgentSnapshotFetcher as any).fetch = origFetch;
  mock.restore(); // Restore all mock.module() replacements
});

describe('AgentSnapshotFetcher.fetch', () => {
  test('returns sessions on success', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions).toHaveLength(2);
    }
  });

  test('returns ok=false when version < 2.1.139', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.100\n');

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Requires 2.1.139');
    }
  });

  test('returns ok=false when daemon not running', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => false;

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('daemon');
    }
  });

  test('returns ok=false when JSON parse fails', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, 'invalid json', '');
    });

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('parse');
    }
  });
});
