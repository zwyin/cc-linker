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

// v2.2.4: snapshot-fetcher 内部还会调 readCompletedSessions() 读 ~/.claude/daemon.log。
// 这会让 tests 拉进真实机器上的 completed 列表,污染 fixture 断言。
// 显式 mock 掉,默认返回空 Map。子测试需要时可以覆盖。
const readCompletedSessionsMock = mock(
  (_withinHours: number): Map<string, any> => new Map(),
);
mock.module('../../../src/agent-view/daemon-log-reader', () => ({
  readCompletedSessions: readCompletedSessionsMock,
}));

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
  readCompletedSessionsMock.mockReset();
  readCompletedSessionsMock.mockImplementation(() => new Map());
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

  test('v2.2.4: merges completed sessions from daemon.log into the snapshot', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    // 1 done session not in --json, 1 done session overlapping (active in --json)
    readCompletedSessionsMock.mockImplementation(
      () =>
        new Map([
          ['aaaa1111', { short: 'aaaa1111', settledAt: 1000, status: 'done' }],
          ['uuid-1', { short: 'uuid-1', settledAt: 2000, status: 'done' }],
        ]),
    );

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2 from busy.json + 1 new from daemon.log (overlap 'uuid-1__' is skipped — shortId match)
      expect(result.sessions).toHaveLength(3);
      // The new completed session should be marked completed:true
      const completed = result.sessions.find(s => s.sessionId === 'aaaa1111');
      expect(completed).toBeDefined();
      expect(completed?.completed).toBe(true);
      expect(completed?.name).toContain('✅');
    }
  });

  test('v2.2.4: skipped "killed" sessions from daemon.log', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    // Killed should NOT be surfaced
    readCompletedSessionsMock.mockImplementation(
      () => new Map([['deadbeef', { short: 'deadbeef', settledAt: 1000, status: 'killed' }]]),
    );

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the 2 from busy.json
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.some(s => s.sessionId === 'deadbeef')).toBe(false);
    }
  });
});
