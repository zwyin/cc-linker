import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { jobStateToSession, listJobShorts, readAllJobStates, readJobState } from '../../../src/agent-view/job-state';

const FIX = join(import.meta.dir, '../../fixtures/job-state');

describe('readJobState', () => {
  test('parses blocked fixture into envelope', async () => {
    const env = await readJobState('01-blocked-timer', FIX);
    expect(env).not.toBeNull();
    expect(env!.short).toBe('01-blocked-timer');
    expect(env!.state.state).toBe('blocked');
    expect(env!.state.needs).toBe('是否继续？');
    expect(env!.state.name).toBe('timer command response');
    expect(env!.state.linkScanPath).toContain('.jsonl');
    expect(env!.mtimeMs).toBeGreaterThan(0);
  });

  test('returns null for missing file', async () => {
    expect(await readJobState('does-not-exist', FIX)).toBeNull();
  });

  test('returns null for malformed JSON (after one race retry)', async () => {
    // 注意:fixture 是真实坏文件,retry 也会失败 → 2 次都挂,最终 null
    expect(await readJobState('neg-bad-json', FIX)).toBeNull();
  });

  test('returns null for wrong shape (missing state field)', async () => {
    expect(await readJobState('neg-wrong-shape', FIX)).toBeNull();
  });

  test('accepts unknown state value (forward compat)', async () => {
    const env = await readJobState('neg-unknown-state', FIX);
    expect(env).not.toBeNull();
    expect(env!.state.state).toBe('hypothetical_future_state');
  });
});

describe('listJobShorts', () => {
  test('lists all fixture filenames (without .json extension)', () => {
    const shorts = listJobShorts(FIX);
    // 应该包含 01..15 + neg-*,不包含 README.md
    expect(shorts).toContain('01-blocked-timer');
    expect(shorts).toContain('15-stopped-unnamed');
    expect(shorts).toContain('neg-bad-json');
    expect(shorts).not.toContain('README');
    expect(shorts.length).toBeGreaterThanOrEqual(18);
  });

  test('returns [] when jobs dir does not exist', () => {
    expect(listJobShorts('/tmp/definitely-not-a-dir-xyz-12345')).toEqual([]);
  });
});

describe('readAllJobStates', () => {
  test('parses all fixtures, drops malformed ones silently', async () => {
    const envs = await readAllJobStates(FIX);
    // 15 个 happy + 1 个 neg-unknown-state(unknown state 是 valid shape)
    // = 16 个 envelope;neg-bad-json + neg-wrong-shape 被丢
    expect(envs.length).toBe(16);
    const states = envs.map(e => e.state.state).sort();
    expect(states).toContain('blocked');
    expect(states).toContain('running');
    expect(states).toContain('working');
    expect(states.filter(s => s === 'done').length).toBe(10);
    expect(states.filter(s => s === 'stopped').length).toBe(2);
  });
});

// v2.3.1: race-retry — 模拟 Claude CLI 撕裂写场景。
// 用一个 tmp 文件:第一次读时给坏 JSON,20ms 后变成好 JSON。
describe('readJobState race retry (v2.3.1)', () => {
  test('first parse fails, retry after 20ms succeeds', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = require('fs');
    const { tmpdir } = require('os');
    const dir = mkdtempSync(join(tmpdir(), 'race-retry-'));
    const f = join(dir, 'racey.json');
    // 先写撕裂 JSON
    writeFileSync(f, '{"state": "running", "this is torn');

    // 20ms 后切到合法 JSON
    setTimeout(() => {
      writeFileSync(f, JSON.stringify({
        state: 'running', detail: null, needs: null, inFlight: null,
        linkScanPath: null, linkScanOffset: 0,
        name: 'recovered after race', nameSource: 'auto',
      }));
    }, 5);  // 5ms < retry 20ms

    try {
      const env = await readJobState('racey', dir);
      expect(env).not.toBeNull();
      expect(env!.state.state).toBe('running');
      expect(env!.state.name).toBe('recovered after race');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jobStateToSession mapping', () => {
  function makeEnv(stateOverride: any): any {
    return {
      short: 'abcdef12',
      path: '/x',
      mtimeMs: 1234,
      readAt: 5678,
      state: {
        state: 'running',
        detail: null, needs: null, inFlight: null,
        linkScanPath: null, linkScanOffset: 0,
        name: 'test session', nameSource: 'auto',
        intent: 'do something', resumeSessionId: 'abcdef12-1234-1234-1234-123456789012',
        daemonShort: 'abcdef12', template: 'bg',
        respawnFlags: [], cliVersion: '2.1.163', cwd: '/tmp/x',
        ...stateOverride,
      },
    };
  }

  test('running → busy', () => {
    const s = jobStateToSession(makeEnv({ state: 'running' }));
    expect(s!.status).toBe('busy');
    expect(s!.completed).toBeUndefined();
  });

  test('working → busy', () => {
    expect(jobStateToSession(makeEnv({ state: 'working' }))!.status).toBe('busy');
  });

  test('blocked → waiting + waitingFor = needs', () => {
    const s = jobStateToSession(makeEnv({ state: 'blocked', needs: '是否继续？' }));
    expect(s!.status).toBe('waiting');
    expect(s!.waitingFor).toBe('是否继续？');
  });

  test('done → idle + completed=true', () => {
    const s = jobStateToSession(makeEnv({ state: 'done' }));
    expect(s!.status).toBe('idle');
    expect(s!.completed).toBe(true);
  });

  test('stopped → idle + completed=true (visible in Completed group)', () => {
    const s = jobStateToSession(makeEnv({ state: 'stopped' }));
    expect(s!.status).toBe('idle');
    expect(s!.completed).toBe(true);
    // 名字前缀 🛑 在 card.ts / snapshot-fetcher 渲染时加,这里只确保 mapping 不丢 session
  });

  // 回归测试:Claude CLI 把 settled-with-error 标为 'failed'(实测 ~/.claude/jobs/*/state.json),
  // v2.3 重构时漏了 — 'failed' 落 default → status='unknown' → snapshot-fetcher 静默 drop。
  // 修法:跟 done/stopped 并列,映射到 idle + completed=true,UI 层加 ❌ prefix。
  test('failed → idle + completed=true (parallel to done/stopped, TUI 也显示 Completed)', () => {
    const s = jobStateToSession(makeEnv({ state: 'failed', detail: '任务失败:网络超时' }));
    expect(s!.status).toBe('idle');
    expect(s!.completed).toBe(true);
    // detail 透传,让列表卡副标题有内容
    expect(s!.detail).toBe('任务失败:网络超时');
  });

  test('unknown state → unknown', () => {
    const s = jobStateToSession(makeEnv({ state: 'hypothetical_future' }));
    expect(s!.status).toBe('unknown');
  });

  test('passes linkScanPath / detail / intent / cwd / name through', () => {
    const s = jobStateToSession(makeEnv({
      state: 'blocked',
      detail: '当前活动',
      needs: 'continue?',
      linkScanPath: '/abs/path.jsonl',
      intent: '原始命令',
      name: '权威名',
      cwd: '/work/dir',
    }));
    expect(s!.detail).toBe('当前活动');
    expect(s!.linkScanPath).toBe('/abs/path.jsonl');
    expect(s!.intent).toBe('原始命令');
    expect(s!.name).toBe('权威名');
    expect(s!.cwd).toBe('/work/dir');
  });

  test('falls back to short for name when state.json.name is null', () => {
    const s = jobStateToSession(makeEnv({ state: 'done', name: null }));
    expect(s!.name).toBe('abcdef12');
  });

  test('v2.3.7: running + needs → waiting (worker 跑着但问用户问题)', () => {
    // Claude CLI 行为:worker 进程在跑(state=running/working),但向用户提了问题
    // (needs 字段被填)—— TUI/claude agents --json 都报 waiting,我们也得报。
    // 这种"伪 busy 实 waiting"在过去是 state=blocked 表达,v2.1.163 把 needs 解耦了。
    const s1 = jobStateToSession(makeEnv({
      state: 'running',
      needs: 'answer: 是否继续执行下一次 date 打印?',
    }));
    expect(s1!.status).toBe('waiting');
    expect(s1!.waitingFor).toBe('answer: 是否继续执行下一次 date 打印?');

    const s2 = jobStateToSession(makeEnv({
      state: 'working',
      needs: '需要更多信息',
    }));
    expect(s2!.status).toBe('waiting');
    expect(s2!.waitingFor).toBe('需要更多信息');
  });

  test('v2.3.7: running + 无 needs → 仍是 busy (不会误判)', () => {
    const s = jobStateToSession(makeEnv({ state: 'running' }));
    expect(s!.status).toBe('busy');
    expect(s!.waitingFor).toBeUndefined();
  });
});
