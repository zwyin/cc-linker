// tests/integration/agent-view-job-state.test.ts
//
// v2.3 canary 集成测试:验证从 state.json 直读的 waiting session
// 在 /agents 列表卡上一定出现 Reply 按钮 + needs 副标题。
// 这是整个 state.json refactor 是否成功的端到端 sanity 检查。

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../src/agent-view/manager';
import { UserManager } from '../../src/feishu/mapping';
import { DaemonProbe } from '../../src/agent-view/daemon-probe';
import { _jobStateHooks } from '../../src/agent-view/snapshot-fetcher';

// Mock execFile (smoke test 默认成功)
import { promisify } from 'node:util';
const execFileSyncMock = mock((cmd: string, args: string[]): string => {
  if (cmd === 'claude' && args[0] === '--version') return '2.1.163 (Claude Code)';
  return '';
});
const execFileMock: any = mock(
  (_cmd: string, _args: string[], cb: (e: any, o: string, s: string) => void) =>
    cb(null, '[]', '')
);
(execFileMock as any)[promisify.custom] = (cmd: string, args: string[]) =>
  new Promise((resolve, reject) => {
    execFileMock(cmd, args, (e: any, out: string, _err: string) => {
      if (e) reject(e);
      else resolve({ stdout: out, stderr: '' });
    });
  });
mock.module('node:child_process', () => {
  const real = require('node:child_process');
  return { ...real, execFileSync: execFileSyncMock, execFile: execFileMock };
});

// readClaimedSources defaults to empty Map via _jobStateHooks swap (no mock.module
// — that would pollute daemon-log-reader.test.ts via Bun's irrevocable module mocks)
const origReadAll = _jobStateHooks.readAllJobStates;
const origReadClaimed = _jobStateHooks.readClaimedSources;
const origDaemonCheck = DaemonProbe.check;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'canary-'));
  (DaemonProbe as any).check = () => true;
  _jobStateHooks.readClaimedSources = (() => new Map()) as any;
});

afterEach(() => {
  _jobStateHooks.readAllJobStates = origReadAll;
  _jobStateHooks.readClaimedSources = origReadClaimed;
  (DaemonProbe as any).check = origDaemonCheck;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Agent View canary: waiting session shows Reply button', () => {
  test('blocked state.json → list card includes Reply button with reply_request tag + needs subtitle', async () => {
    // 喂一个 blocked envelope —— 这是用户飞书截图里的 `timer command response` 同形场景
    _jobStateHooks.readAllJobStates = mock(() => [{
      short: '3a41fe73',
      path: '/fake/state.json',
      mtimeMs: Date.now(),
      readAt: Date.now(),
      state: {
        state: 'blocked',
        tempo: 'blocked',
        detail: '是否继续？',
        needs: '是否继续？',
        inFlight: null,
        linkScanPath: '/some/path.jsonl',
        linkScanOffset: 0,
        name: 'timer command response',
        nameSource: 'auto',
        intent: 'sleep 30 && echo done',
        resumeSessionId: '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b',
        daemonShort: '3a41fe73',
        template: 'bg',
        respawnFlags: [],
        cliVersion: '2.1.163',
        cwd: '/Users/x',
      },
    }]);

    // capture 飞书卡内容
    const captured: { card?: string } = {};
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async (card: string) => {
        captured.card = card;
        return 'om_canary_1';
      },
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });

    await mgr.handleList('ou_canary');

    expect(captured.card).toBeDefined();
    const flat = captured.card!;

    // 1. 卡上必须出现 session name
    expect(flat).toContain('timer command response');

    // 2. 卡上必须出现 needs 副标题(❓ 是否继续？)
    expect(flat).toContain('是否继续？');

    // 3. 卡上必须出现 Reply 按钮的 action value
    expect(flat).toContain('agent_view_reply_request');

    // 4. footer 必须提到 state.json(数据源切换的可见证据)
    expect(flat).toContain('state.json');
    expect(flat).not.toContain('claude agents --json 提供');

    // 5. waiting 组在 busy/idle/completed 之前 — 验证 v2.3 新组顺序
    //    通过查找 "等待输入" header 应出现在卡 elements 数组靠前位置
    const parsed = JSON.parse(flat);
    const elements = parsed.elements as Array<any>;
    const headerTexts: string[] = elements
      .map(e => e.content)
      .filter(c => typeof c === 'string' && c.startsWith('**'));
    expect(headerTexts[0]).toContain('等待输入');
  });

  test('mixed states: waiting first, then busy with detail, completed with ✅ prefix', async () => {
    _jobStateHooks.readAllJobStates = mock(() => [
      {
        short: 'b1b1b1b1', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'running', detail: '正在打包 npm', needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'Publish latest npm package', nameSource: 'auto',
          intent: '请你发布一个最新的 npm 正式包',
          resumeSessionId: 'b1b1b1b1-1111-1111-1111-111111111111',
        },
      },
      {
        short: 'b2b2b2b2', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'blocked', detail: '继续吗?', needs: '继续吗?', inFlight: null,
          linkScanPath: '/p.jsonl', linkScanOffset: 0,
          name: 'reply needed', nameSource: 'auto',
          resumeSessionId: 'b2b2b2b2-2222-2222-2222-222222222222',
        },
      },
      {
        short: 'c3c3c3c3', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'done', detail: 'task completed', needs: null, inFlight: null,
          linkScanPath: '/q.jsonl', linkScanOffset: 0,
          name: 'finished task', nameSource: 'auto',
          resumeSessionId: 'c3c3c3c3-3333-3333-3333-333333333333',
        },
      },
    ]);

    const captured: { card?: string } = {};
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async (card: string) => { captured.card = card; return 'om_m'; },
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });

    await mgr.handleList('ou_mixed');

    const flat = captured.card!;
    // 三种状态都要看到
    expect(flat).toContain('reply needed');         // waiting
    expect(flat).toContain('Publish latest npm');   // busy
    expect(flat).toContain('✅ finished task');     // done w/ ✅ prefix

    // 顺序:waiting < busy < completed (waiting 在最前)
    expect(flat.indexOf('reply needed')).toBeLessThan(flat.indexOf('Publish latest npm'));
    expect(flat.indexOf('Publish latest npm')).toBeLessThan(flat.indexOf('finished task'));

    // 每个状态的 detail 副标题都出现
    expect(flat).toContain('继续吗?');
    expect(flat).toContain('正在打包 npm');
    expect(flat).toContain('task completed');
  });

  // 回归测试:Claude CLI 把 settled-with-error 标为 state='failed',TUI 显示为 Completed
  // 但 v2.3 的 jobStateToSession 没这个 case → 落到 default → status='unknown' →
  // snapshot-fetcher 静默 drop。修法:加 case 'failed' → idle+completed=true,
  // 列表卡前加 ❌ prefix 区分 ✅ (done) 和 🛑 (stopped)。
  test('failed state: appears in completed group with ❌ prefix (not silently dropped)', async () => {
    _jobStateHooks.readAllJobStates = mock(() => [
      {
        short: '3f36dac1', path: '/x', mtimeMs: Date.now() - 3 * 86400_000, readAt: Date.now(),
        state: {
          state: 'failed',
          tempo: 'idle',
          detail: '任务失败:网络超时',
          needs: null,
          inFlight: null,
          linkScanPath: '/p.jsonl',
          linkScanOffset: 0,
          name: 'AI Coding Lines统计方法讨论',
          nameSource: 'auto',
          intent: '统计 AI 编辑代码行数',
          resumeSessionId: '3f36dac1-fd1e-4c12-b952-08aec0db636b',
          daemonShort: '3f36dac1',
          template: 'bg',
          respawnFlags: [],
          cliVersion: '2.1.163',
          cwd: '/Users/x',
        },
      },
    ]);

    const captured: { card?: string } = {};
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async (card: string) => { captured.card = card; return 'om_failed'; },
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });

    await mgr.handleList('ou_failed');

    const flat = captured.card!;
    // 关键断言 1: session 名字带 ❌ prefix(用户能区分 done/failed)
    expect(flat).toContain('❌ AI Coding Lines统计方法讨论');
    // 关键断言 2: 进 "已完成" 组(不丢)
    expect(flat).toContain('已完成');
    // 关键断言 3: detail 副标题出现
    expect(flat).toContain('任务失败:网络超时');
  });

  // 三种终态(done/stopped/failed)视觉区分,跟 TUI 一致
  test('three terminal states get distinct emoji prefixes (✅ 🛑 ❌)', async () => {
    _jobStateHooks.readAllJobStates = mock(() => [
      {
        short: 'a1a1a1a1', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'done', detail: 'ok', needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'success task', nameSource: 'auto',
          resumeSessionId: 'a1a1a1a1-1111-1111-1111-111111111111',
        },
      },
      {
        short: 'b2b2b2b2', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'stopped', detail: 'killed', needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'killed task', nameSource: 'auto',
          resumeSessionId: 'b2b2b2b2-2222-2222-2222-222222222222',
        },
      },
      {
        short: 'c3c3c3c3', path: '/x', mtimeMs: Date.now(), readAt: Date.now(),
        state: {
          state: 'failed', detail: 'err', needs: null, inFlight: null,
          linkScanPath: null, linkScanOffset: 0,
          name: 'errored task', nameSource: 'auto',
          resumeSessionId: 'c3c3c3c3-3333-3333-3333-333333333333',
        },
      },
    ]);

    const captured: { card?: string } = {};
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async (card: string) => { captured.card = card; return 'om_terminal'; },
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });

    await mgr.handleList('ou_terminal');

    const flat = captured.card!;
    expect(flat).toContain('✅ success task');
    expect(flat).toContain('🛑 killed task');
    expect(flat).toContain('❌ errored task');
  });
});
