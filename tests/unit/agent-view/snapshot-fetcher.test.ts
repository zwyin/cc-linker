import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AgentSnapshotFetcher, _jobStateHooks } from '../../../src/agent-view/snapshot-fetcher';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';

// ── Mock child_process execFile (smoke test only — return value discarded) ──
const execFileSyncMock = mock((_cmd: string, _args: string[]): string => '');
const execFileMock = mock(
  (_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, '[]', '');  // smoke test default: success with empty array
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

// ── readClaimedSources swap (via _jobStateHooks, not mock.module — the latter
//    would pollute daemon-log-reader.test.ts via Bun's irrevocable module mocks) ──
const readClaimedSourcesMock = mock((_h: number): Map<string, any> => new Map());

// ── Save / restore _jobStateHooks ──
const origReadAll = _jobStateHooks.readAllJobStates;
const origDerive = _jobStateHooks.deriveNameFromJsonl;
const origReadClaimed = _jobStateHooks.readClaimedSources;
const origDaemonCheck = DaemonProbe.check;

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    // VersionGuard's check
    if (cmd === 'claude' && args[0] === '--version') return '2.1.163 (Claude Code)';
    return '';
  });
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '[]', ''));
  readClaimedSourcesMock.mockReset();
  readClaimedSourcesMock.mockImplementation(() => new Map());
  _jobStateHooks.readClaimedSources = readClaimedSourcesMock;

  // DaemonProbe defaults to true (roster.json exists). Tests override per case.
  (DaemonProbe as any).check = () => true;
});

afterEach(() => {
  _jobStateHooks.readAllJobStates = origReadAll;
  _jobStateHooks.deriveNameFromJsonl = origDerive;
  _jobStateHooks.readClaimedSources = origReadClaimed;
  (DaemonProbe as any).check = origDaemonCheck;
});

function mockJobs(envs: any[]) {
  _jobStateHooks.readAllJobStates = mock(() => envs);
}

function makeEnv(stateOverride: any): any {
  // Derive short from the resumeSessionId's first 8 chars so the prefix-step's
  // `envs.find(e => e.short === s.sessionId.slice(0, 8))` matches.
  const resumeId = stateOverride.resumeSessionId ?? 'aaaaaaaa-1111-1111-1111-111111111111';
  const short = resumeId.slice(0, 8);
  return {
    short,
    path: '/x',
    mtimeMs: 100,
    readAt: 200,
    state: {
      state: 'running',
      detail: null, needs: null, inFlight: null,
      linkScanPath: null, linkScanOffset: 0,
      name: 'a session', nameSource: 'auto',
      intent: 'do x', resumeSessionId: resumeId,
      daemonShort: short, template: 'bg',
      respawnFlags: [], cliVersion: '2.1.163', cwd: '/work',
      ...stateOverride,
    },
  };
}

// ── Guards (version / daemon / smoke) ──

describe('AgentSnapshotFetcher.fetch — guards', () => {
  test('returns ok=false when version < 2.1.139', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.100 (Claude Code)');
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
  });

  test('returns ok=false when daemon not running', async () => {
    (DaemonProbe as any).check = () => false;
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('daemon');
  });

  test('returns ok=false when smoke test fails (claude not installed)', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) =>
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('smoke test failed');
  });

  test('empty jobs dir → ok with empty sessions', async () => {
    mockJobs([]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessions).toEqual([]);
  });
});

// ── Mapping (state.json → AgentSession[]) ──

describe('AgentSnapshotFetcher.fetch — state.json mapping', () => {
  test('blocked envelope → waiting session with waitingFor + detail + linkScanPath', async () => {
    mockJobs([makeEnv({
      state: 'blocked',
      needs: '是否继续？', detail: '是否继续？',
      linkScanPath: '/path.jsonl', name: 'timer test',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].status).toBe('waiting');
    expect(r.sessions[0].waitingFor).toBe('是否继续？');
    expect(r.sessions[0].detail).toBe('是否继续？');
    expect(r.sessions[0].linkScanPath).toBe('/path.jsonl');
    expect(r.sessions[0].name).toBe('timer test');  // no prefix on waiting
  });

  test('running / working → busy', async () => {
    mockJobs([
      makeEnv({ state: 'running', name: 'r1', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'working', name: 'w1', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(2);
    expect(r.sessions.every(s => s.status === 'busy')).toBe(true);
  });

  test('done → idle + completed=true + ✅ prefix', async () => {
    mockJobs([makeEnv({ state: 'done', name: 'shell command exec' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('✅ shell command exec');
  });

  test('stopped → idle + completed=true + 🛑 prefix', async () => {
    mockJobs([makeEnv({ state: 'stopped', name: 'bash loop' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('🛑 bash loop');
  });

  // 回归:Claude CLI 把 settled-with-error 标为 'failed',前 v2.3 落到 unknown 被 drop。
  // 修法:跟 done/stopped 并列映射,UI 加 ❌ prefix 跟 TUI 视觉一致。
  test('failed → idle + completed=true + ❌ prefix (not silently dropped)', async () => {
    mockJobs([makeEnv({ state: 'failed', name: 'network timeout task' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('❌ network timeout task');
  });

  test('unknown state → filtered out + warn logged once (v2.3.1)', async () => {
    // Spy on logger.warn
    const { logger } = require('../../../src/utils/logger');
    const origWarn = logger.warn;
    const warnCalls: string[] = [];
    logger.warn = (msg: string) => { warnCalls.push(msg); };
    try {
      mockJobs([
        makeEnv({ state: 'future_paused', name: 'mystery1', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
        makeEnv({ state: 'experimental', name: 'mystery2', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      ]);
      const r = await AgentSnapshotFetcher.fetch();
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.sessions.length).toBe(0);  // both filtered
      // 1 warn 聚合通知,含两种 unknown state 值
      const agentViewWarn = warnCalls.find(m => m.includes('[agent-view]'));
      expect(agentViewWarn).toBeDefined();
      expect(agentViewWarn).toContain('dropped 2 session');
      expect(agentViewWarn).toContain('future_paused');
      expect(agentViewWarn).toContain('experimental');
    } finally {
      logger.warn = origWarn;
    }
  });

  test('no warn when all states known', async () => {
    const { logger } = require('../../../src/utils/logger');
    const origWarn = logger.warn;
    const warnCalls: string[] = [];
    logger.warn = (msg: string) => { warnCalls.push(msg); };
    try {
      mockJobs([makeEnv({ state: 'running', name: 'r', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' })]);
      await AgentSnapshotFetcher.fetch();
      const agentViewWarn = warnCalls.find(m => m.includes('[agent-view] dropped'));
      expect(agentViewWarn).toBeUndefined();
    } finally {
      logger.warn = origWarn;
    }
  });

  test('mixed envelopes preserve all states with right prefix', async () => {
    mockJobs([
      makeEnv({ state: 'running', name: 'r', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'blocked', needs: 'q', name: 'b', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      makeEnv({ state: 'done', name: 'd', resumeSessionId: 'aaaaaaa3-3333-3333-3333-333333333333' }),
      makeEnv({ state: 'stopped', name: 's', resumeSessionId: 'aaaaaaa4-4444-4444-4444-444444444444' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(4);
    const byShort = Object.fromEntries(r.sessions.map(s => [s.sessionId.slice(0, 8), s]));
    expect(byShort['aaaaaaa1'].status).toBe('busy');
    expect(byShort['aaaaaaa1'].name).toBe('r');  // running, no prefix
    expect(byShort['aaaaaaa2'].status).toBe('waiting');
    expect(byShort['aaaaaaa2'].waitingFor).toBe('q');
    expect(byShort['aaaaaaa3'].status).toBe('idle');
    expect(byShort['aaaaaaa3'].name).toBe('✅ d');
    expect(byShort['aaaaaaa4'].status).toBe('idle');
    expect(byShort['aaaaaaa4'].name).toBe('🛑 s');
  });

  // 三种终态(done/stopped/failed)在同一快照里共存,prefix 各不冲突
  test('three terminal states (done/stopped/failed) coexist with distinct prefixes', async () => {
    mockJobs([
      makeEnv({ state: 'done', name: 'success', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'stopped', name: 'killed', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      makeEnv({ state: 'failed', name: 'errored', resumeSessionId: 'aaaaaaa3-3333-3333-3333-333333333333' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(3);
    const byShort = Object.fromEntries(r.sessions.map(s => [s.sessionId.slice(0, 8), s]));
    expect(byShort['aaaaaaa1'].name).toBe('✅ success');
    expect(byShort['aaaaaaa2'].name).toBe('🛑 killed');
    expect(byShort['aaaaaaa3'].name).toBe('❌ errored');
  });
});

// ── Source attribution (roster + daemon.log claimedSources tail) ──

describe('AgentSnapshotFetcher.fetch — source attribution', () => {
  test('filterUserDispatched drops spare sub-agent sessions (from claimedSources)', async () => {
    mockJobs([
      makeEnv({ state: 'done', name: 'real task', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'done', name: 'spare sub', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
    ]);
    readClaimedSourcesMock.mockImplementation(() => new Map([
      ['aaaaaaa1', 'slash'],
      ['aaaaaaa2', 'spare'],  // spare is filtered out by filterUserDispatched
    ]));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].name).toBe('✅ real task');
  });

  test('source defaults to "unknown" when neither roster nor claimedSources knows', async () => {
    mockJobs([makeEnv({ state: 'running', name: 'lonely', resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].source).toBe('unknown');
  });
});

// ── Cold-path name fallback (state.json.name null → deriveNameFromJsonl) ──

describe('AgentSnapshotFetcher.fetch — cold-path name fallback', () => {
  test('state.json.name null → uses deriveNameFromJsonl', async () => {
    mockJobs([makeEnv({
      state: 'done', name: null,  // null name triggers fallback
      resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    })]);
    _jobStateHooks.deriveNameFromJsonl = mock(() => ({
      name: 'derived from jsonl',
      sessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    }));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    // ✅ prefix preserved + derived name
    expect(r.sessions[0].name).toBe('✅ derived from jsonl');
  });

  // 冷路径 + failed 状态:state.json.name 为空 + state=failed 时,
  // 仍要保留 ❌ prefix 不能被吃成派生裸名
  test('cold-path name fallback preserves ❌ prefix for failed state', async () => {
    mockJobs([makeEnv({
      state: 'failed', name: null,
      resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    })]);
    _jobStateHooks.deriveNameFromJsonl = mock(() => ({
      name: 'derived failure',
      sessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    }));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].name).toBe('❌ derived failure');
  });

  test('state.json.name present → no fallback invocation', async () => {
    mockJobs([makeEnv({ state: 'running', name: 'authoritative',
                       resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' })]);
    const deriveSpy = mock(() => null);
    _jobStateHooks.deriveNameFromJsonl = deriveSpy;
    await AgentSnapshotFetcher.fetch();
    expect(deriveSpy).not.toHaveBeenCalled();
  });
});
