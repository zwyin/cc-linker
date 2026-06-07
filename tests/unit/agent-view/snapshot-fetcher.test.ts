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
// v2.2.5: 同时也调 readClaimedSources() 推断 completed session 的 dispatch.source。
// 这会让 tests 拉进真实机器上的 completed 列表 / claimed 事件,污染 fixture 断言。
// 显式 mock 掉,默认返回空 Map。子测试需要时可以覆盖。
const readCompletedSessionsMock = mock(
  (_withinHours: number): Map<string, any> => new Map(),
);
const readClaimedSourcesMock = mock(
  (_withinHours: number): Map<string, any> => new Map(),
);
mock.module('../../../src/agent-view/daemon-log-reader', () => ({
  readCompletedSessions: readCompletedSessionsMock,
  readClaimedSources: readClaimedSourcesMock,
}));

// v2.2.6 + v2.2.7: name-cache 和 JSONL 兜底的真实实现会写 / 读真实文件。
// 不用 mock.module(bun 已知限制:跨文件不可撤销,会污染 name-cache.test.ts /
// jsonl-name.test.ts),改成 swap snapshot-fetcher 暴露的 _nameCacheHooks(普通对象)。
import { _nameCacheHooks } from '../../../src/agent-view/snapshot-fetcher';
const origCaptureNames = _nameCacheHooks.captureNames;
const origLookupName = _nameCacheHooks.lookupName;
const origDeriveNameFromJsonl = _nameCacheHooks.deriveNameFromJsonl;
const captureNamesMock = mock(
  (_sessions: Array<{ sessionId: string; name: string }>, _now?: number, _path?: string) => {},
);
const lookupNameMock = mock((_short: string, _path?: string): string | undefined => undefined);
const deriveNameFromJsonlMock = mock(
  (_short: string): { name: string; sessionId: string } | null => null,
);

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
  readClaimedSourcesMock.mockReset();
  readClaimedSourcesMock.mockImplementation(() => new Map());
  captureNamesMock.mockReset();
  lookupNameMock.mockReset();
  lookupNameMock.mockImplementation(() => undefined);
  deriveNameFromJsonlMock.mockReset();
  deriveNameFromJsonlMock.mockImplementation(() => null);
  // swap the mutable hooks (works across test files where mock.module wouldn't)
  _nameCacheHooks.captureNames = captureNamesMock;
  _nameCacheHooks.lookupName = lookupNameMock;
  _nameCacheHooks.deriveNameFromJsonl = deriveNameFromJsonlMock;
});

afterAll(() => {
  (DaemonProbe as any).check = origProbeCheck;
  (AgentSnapshotFetcher as any).fetch = origFetch;
  _nameCacheHooks.captureNames = origCaptureNames;
  _nameCacheHooks.lookupName = origLookupName;
  _nameCacheHooks.deriveNameFromJsonl = origDeriveNameFromJsonl;
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

  test('v2.2.5: completed spare sessions are filtered out via daemon.log claimed events', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    // 3 completed sessions, all `done`: spare (must drop), slash (keep), fleet (keep)
    readCompletedSessionsMock.mockImplementation(
      () =>
        new Map([
          ['spare001', { short: 'spare001', settledAt: 1000, status: 'done' }],
          ['slash002', { short: 'slash002', settledAt: 2000, status: 'done' }],
          ['fleet003', { short: 'fleet003', settledAt: 3000, status: 'done' }],
        ]),
    );
    readClaimedSourcesMock.mockImplementation(
      () =>
        new Map([
          ['spare001', 'spare'],
          ['slash002', 'slash'],
          ['fleet003', 'fleet'],
        ]),
    );

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2 from busy.json + 2 surviving completed (slash + fleet); spare dropped
      expect(result.sessions).toHaveLength(4);
      expect(result.sessions.some(s => s.sessionId === 'spare001')).toBe(false);
      expect(result.sessions.some(s => s.sessionId === 'slash002')).toBe(true);
      expect(result.sessions.some(s => s.sessionId === 'fleet003')).toBe(true);
    }
  });

  test('v2.2.7: name falls back to short hash when both cache and JSONL miss', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    readCompletedSessionsMock.mockImplementation(
      () => new Map([['d54a475a', { short: 'd54a475a', settledAt: 1000, status: 'done' }]]),
    );
    readClaimedSourcesMock.mockImplementation(() => new Map([['d54a475a', 'slash']]));
    // both fallbacks miss → short hash, no "(logs unavailable)" suffix
    lookupNameMock.mockImplementation(() => undefined);
    deriveNameFromJsonlMock.mockImplementation(() => null);

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      const completed = result.sessions.find(s => s.sessionId === 'd54a475a');
      expect(completed).toBeDefined();
      expect(completed?.name).toBe('✅ d54a475a');
      expect(completed?.completed).toBe(true);
    }
  });

  test('v2.2.6: name-cache hit short-circuits all subsequent fallbacks', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    readCompletedSessionsMock.mockImplementation(
      () => new Map([['timer001', { short: 'timer001', settledAt: 1000, status: 'done' }]]),
    );
    readClaimedSourcesMock.mockImplementation(() => new Map([['timer001', 'fleet']]));
    lookupNameMock.mockImplementation(short =>
      short === 'timer001' ? 'timer command response' : undefined,
    );
    // Even if JSONL would have a wrong answer, cache hit must short-circuit it
    deriveNameFromJsonlMock.mockImplementation(() => ({
      name: 'wrong name from jsonl',
      sessionId: 'timer001-uuid-zzzz',
    }));

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      const completed = result.sessions.find(s => s.sessionId === 'timer001');
      expect(completed?.name).toBe('✅ timer command response');
    }
    // JSONL lookup must NOT have been called when cache hit
    expect(deriveNameFromJsonlMock).not.toHaveBeenCalled();
  });

  test('v2.2.7: JSONL fallback resolves real name and writes it back to cache', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    readCompletedSessionsMock.mockImplementation(
      () => new Map([['3a41fe73', { short: '3a41fe73', settledAt: 1000, status: 'done' }]]),
    );
    readClaimedSourcesMock.mockImplementation(() => new Map([['3a41fe73', 'fleet']]));
    // cache miss → JSONL hit → real name surfaces + cache write-back
    lookupNameMock.mockImplementation(() => undefined);
    deriveNameFromJsonlMock.mockImplementation(short =>
      short === '3a41fe73'
        ? { name: '你的当前模型是？', sessionId: '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b' }
        : null,
    );

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // JSONL hit upgrades sessionId from short hash to full UUID
      const completed = result.sessions.find(s =>
        s.sessionId === '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b',
      );
      expect(completed).toBeDefined();
      expect(completed?.name).toBe('✅ 你的当前模型是？');
      expect(completed?.completed).toBe(true);
    }
    // captureNames must have been called at least twice:
    //  - once for the 2 active sessions from busy.json
    //  - once for the JSONL write-back of 3a41fe73
    expect(captureNamesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The write-back call carries our JSONL-derived entry
    const writebackCall = captureNamesMock.mock.calls.find(call => {
      const arg = call[0] as Array<{ sessionId: string; name: string }>;
      return Array.isArray(arg) && arg.some(s => s.sessionId === '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b');
    });
    expect(writebackCall).toBeDefined();
  });

  test('v2.2.7: `claude logs` is no longer invoked for any completed session', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    let claudeLogsCalled = false;
    execFileMock.mockImplementation((cmd, args, cb) => {
      if (cmd === 'claude' && args[0] === 'logs') {
        claudeLogsCalled = true; // tripwire
      }
      cb(null, raw, '');
    });
    readCompletedSessionsMock.mockImplementation(
      () =>
        new Map([
          ['settle01', { short: 'settle01', settledAt: 1000, status: 'done' }],
          ['settle02', { short: 'settle02', settledAt: 2000, status: 'done' }],
        ]),
    );
    readClaimedSourcesMock.mockImplementation(
      () => new Map([['settle01', 'slash'], ['settle02', 'fleet']]),
    );
    lookupNameMock.mockImplementation(() => undefined);
    deriveNameFromJsonlMock.mockImplementation(() => null);

    await AgentSnapshotFetcher.fetch();

    expect(claudeLogsCalled).toBe(false);
  });

  test('v2.2.6: captureNames is invoked with the parsed active session list', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });

    await AgentSnapshotFetcher.fetch();

    expect(captureNamesMock).toHaveBeenCalled();
    const passed = captureNamesMock.mock.calls[0][0];
    expect(Array.isArray(passed)).toBe(true);
    // busy.json fixture has 2 active sessions; both must reach the cache.
    expect(passed.length).toBe(2);
    for (const s of passed) {
      expect(typeof s.sessionId).toBe('string');
      expect(typeof s.name).toBe('string');
    }
  });

  test('v2.2.5: source inferred from daemon.log when not in roster', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.163\n');
    (DaemonProbe as any).check = () => true;
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, raw, '');
    });
    // roster has no entry for 'fleet088' (typical for completed) — but daemon.log does.
    readCompletedSessionsMock.mockImplementation(
      () => new Map([['fleet088', { short: 'fleet088', settledAt: 1000, status: 'done' }]]),
    );
    readClaimedSourcesMock.mockImplementation(() => new Map([['fleet088', 'fleet']]));

    const result = await AgentSnapshotFetcher.fetch();

    expect(result.ok).toBe(true);
    if (result.ok) {
      const completed = result.sessions.find(s => s.sessionId === 'fleet088');
      expect(completed).toBeDefined();
      expect(completed?.source).toBe('fleet');
    }
  });
});
