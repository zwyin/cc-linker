import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { RendezvousClient, type StatePatch } from '../../../src/agent-view/rendezvous-client';

describe('RendezvousClient.injectReply', () => {
  let sockPath: string;
  let server: net.Server;
  let receivedLines: string[] = [];

  beforeEach(() => {
    sockPath = join(mkdtempSync(join(tmpdir(), 'rendezvous-test-')), 'daemon.sock');
    receivedLines = [];
    server = net.createServer(c => {
      let serverBuffer = '';
      c.on('data', d => {
        serverBuffer += d.toString('utf8');
        let idx;
        while ((idx = serverBuffer.indexOf('\n')) >= 0) {
          const line = serverBuffer.slice(0, idx);
          serverBuffer = serverBuffer.slice(idx + 1);
          if (!line.trim()) continue;
          receivedLines.push(line);
          const parsed = JSON.parse(line);
          if (parsed.type === 'reply') {
            // Send back a fake state patch: bg started processing
            c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
            // Then send completion
            setTimeout(() => {
              c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'next q?', state: 'blocked' } }) + '\n');
            }, 20);
          }
        }
      });
    });
    server.listen(sockPath);
  });

  afterEach(() => {
    server.close();
    if (sockPath) {
      try { rmSync(join(sockPath, '..'), { recursive: true, force: true }); } catch {}
    }
  });

  test('sends single line JSON and returns new_needs on tempo=blocked+needs', async () => {
    const patches: StatePatch[] = [];
    const result = await RendezvousClient.injectReply({
      short: 'dcb2ec25',
      text: '继续',
      rendezvousSock: sockPath,
      timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('new_needs');
    expect(receivedLines).toHaveLength(1);
    const sent = JSON.parse(receivedLines[0]);
    expect(sent.type).toBe('reply');
    expect(sent.text).toBe('继续');
    expect(patches.length).toBeGreaterThanOrEqual(1);
  });

  test('completes on state=done', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'done', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
  });

  test('user_stopped when state=stopped + detail=killed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'stopped', detail: 'killed', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('user_stopped');
  });

  test('timeouts after 200ms', async () => {
    server.close();
    server = net.createServer(() => { /* never respond */ });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('socket disconnect mid-wait → socket_closed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => c.destroy(), 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('daemon returns error JSON', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'error', message: 'something' }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daemon_error');
  });

  test('handles long text (>10KB)', async () => {
    // Use the default beforeEach server which handles replies properly
    // (with server-side buffering across TCP chunks)
    const longText = 'x'.repeat(15000);
    const r = await RendezvousClient.injectReply({
      short: 's', text: longText, rendezvousSock: sockPath, timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(receivedLines[0]).toContain(longText);
  });

  test('handles unicode text', async () => {
    const r = await RendezvousClient.injectReply({
      short: 's', text: '继续 中文 🚀', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(receivedLines[0]).text).toBe('继续 中文 🚀');
  });

  test('completes on tempo=idle + no needs', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'idle', needs: '' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('idle');
  });

  test('patches collected for debugging', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.patches).toBeDefined();
    expect(r.patches!.length).toBeGreaterThanOrEqual(2);
  });

  test('connection refused → socket_closed', async () => {
    server.close();
    try { rmSync(sockPath); } catch {}
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('onStatePatch callback fires for every patch', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const patches: StatePatch[] = [];
    await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(patches.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * v2.4.x: 真 daemon 协议是 fire-and-forget (ack patch 一次 + 立即 close),
 * 后续 bg 完成走 state.json, 不走 socket。RendezvousClient 必须:
 *   1. 提交阶段: 200ms 内能 write 完且无 ECONNREFUSED → submitted
 *   2. 完成阶段: 轮询 state.json 直到 done/stopped/blocked+needs, 或 timeout
 *
 * 旧测试 mock 是"长连接 + 流式 patch", 在真实 daemon 上会假阴性 socket_closed
 * (close 比 ack patch 先到 race), 用户看到"daemon 已停止"误报。
 */
describe('RendezvousClient.injectReply — fire-and-forget + state.json polling', () => {
  let sockPath: string;
  let server: net.Server;
  let receivedLines: string[] = [];
  let jobsDir: string;
  const SHORT = 'dcb2ec25';

  beforeEach(() => {
    sockPath = join(mkdtempSync(join(tmpdir(), 'rendezvous-faf-')), 'daemon.sock');
    receivedLines = [];
    jobsDir = mkdtempSync(join(tmpdir(), 'rendezvous-faf-jobs-'));
    mkdirSync(join(jobsDir, SHORT), { recursive: true });
  });

  afterEach(() => {
    if (server) { try { server.close(); } catch {} }
    try { rmSync(join(sockPath, '..'), { recursive: true, force: true }); } catch {}
    try { rmSync(jobsDir, { recursive: true, force: true }); } catch {}
  });

  function writeState(state: any) {
    writeFileSync(join(jobsDir, SHORT, 'state.json'), JSON.stringify(state));
  }

  test('真 daemon 行为 (ack+close) + state.json 变 done → 返 ok=true reason=done', async () => {
    // Mock daemon: 收 reply → 回 1 个 ack patch → 立即 close
    // (Probe 2 实测行为,见 docs/qa/2026-06-11-rendezvous-probe-notes.md)
    server = net.createServer(c => {
      c.on('data', () => {
        receivedLines.push('received');
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
        c.end();  // ← 真 daemon 行为: 立刻关
      });
    });
    server.listen(sockPath);

    // 初始 state.json: bg 已 active
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });

    // 50ms 后 bg 跑完, 写 state.json done
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'background command completed successfully', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 50);

    const r = await RendezvousClient.injectReply({
      short: SHORT,
      text: '继续',
      rendezvousSock: sockPath,
      stateJsonPath: jobsDir,  // ← 新选项
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
    expect(receivedLines).toHaveLength(1);  // daemon 确实收到了我们的 reply
  });

  test('stale socket (sock 存在,无 listener) → 返 ok=false reason=socket_closed (真失败)', async () => {
    // 不启动 server, sockPath 就是一个孤儿文件
    // (实际生产中 daemon 死了但 sock 文件没清理, checkRendezvousEligibility 仍会通过)
    const r = await RendezvousClient.injectReply({
      short: SHORT,
      text: '继续',
      rendezvousSock: sockPath,  // 无 listener
      stateJsonPath: jobsDir,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('daemon 接受但 bg 永不结束 → timeoutMs 到期后返 ok=false reason=timeout', async () => {
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
        c.end();
      });
    });
    server.listen(sockPath);

    // state.json 永远是 active
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });

    const r = await RendezvousClient.injectReply({
      short: SHORT,
      text: '继续',
      rendezvousSock: sockPath,
      stateJsonPath: jobsDir,
      timeoutMs: 300,  // 短超时让测试快
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('state.json 变 blocked+needs (新问题) → 返 ok=true reason=new_needs', async () => {
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
        c.end();
      });
    });
    server.listen(sockPath);

    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: '执行哪个?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 50);

    const r = await RendezvousClient.injectReply({
      short: SHORT,
      text: '继续',
      rendezvousSock: sockPath,
      stateJsonPath: jobsDir,
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
  });
});

/**
 * v2.4.x 流式 reply: pollStateJsonStreaming 持续调 onPoll 回调,
 * 让 caller 在 bg 处理期间实时更新卡片。终结时返 RendezvousReplyResult。
 */
describe('RendezvousClient.pollStateJsonStreaming', () => {
  let jobsDir: string;
  const SHORT = 'dcb2ec25';

  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), 'rendezvous-stream-jobs-'));
    mkdirSync(join(jobsDir, SHORT), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(jobsDir, { recursive: true, force: true }); } catch {}
  });

  function writeState(state: any) {
    writeFileSync(join(jobsDir, SHORT, 'state.json'), JSON.stringify(state));
  }

  test('active 期间反复调 onPoll, done 后停 + 返 ok=true reason=done', async () => {
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'done', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 150);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 5000,
      pollIntervalMs: 50,  // 加速测试
      onPoll: (state) => { polls.push(state.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
    expect(polls.length).toBeGreaterThan(1);
    expect(polls[polls.length - 1]).toBe('done');
    // 第一次 poll 是 active
    expect(polls[0]).toBe('active');
  });

  test('blocked+needs 立即触发 onPoll kind=blocked-needs + 返 ok=true reason=new_needs', async () => {
    // v2.4.1: 真实 waiting bg 路径 — supervisor 先切 active 处理注入, 再回 blocked+needs (新问题)。
    // 这正是 v2.4.1 sawActive gate 要保护的场景: 旧 done/blocked 状态是 stale, 必须等 active。
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: '选哪个?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 80);

    const seenKinds: string[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 5000,
      pollIntervalMs: 30,
      onPoll: (state) => { seenKinds.push(state.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
    expect(seenKinds).toContain('blocked-needs');
    // 证明确实经过 active 阶段
    expect(seenKinds[0]).toBe('active');
  });

  test('state.json 一直 active → timeoutMs 到期返 ok=false reason=timeout', async () => {
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });

    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 200,
      pollIntervalMs: 50,
      onPoll: () => {},
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('state.json 缺失 → 立即返 ok=false reason=daemon_error', async () => {
    // 不写 state.json

    let onPollCalled = false;
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 5000,
      pollIntervalMs: 50,
      onPoll: () => { onPollCalled = true; },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daemon_error');
    expect(onPollCalled).toBe(false);
  });

  /**
   * v2.4.1 stale-done race fix:
   *   注入 reply 时 bg 在 done/idle 状态, supervisor 通常 0-1s 内才把
   *   state.json 改成 running。pollStateJsonStreaming 的第一次 poll 可能
   *   仍看到旧 done,如果直接信就会立刻返 reason=done, 0s duration。
   *
   *   sawActive gate: 必须见过一次 active, 才信任后续 terminal state。
   */
  test('stale pre-inject done (前 3 次 poll 是 done) → 跳过, 等到 active, 最终 ok=done', async () => {
    // 初始: stale done (注入前 supervisor 还来不及改)
    writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'stale', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    // 50ms 后 supervisor 改 running (注入后正常反应)
    setTimeout(() => {
      writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 50);
    // 200ms 后 bg 完成
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'real done', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 200);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
    // 证明等到了 active (sawActive=true)
    expect(polls).toContain('active');
    // 证明没在第一次 poll 时就退出
    expect(r.durationMs).toBeGreaterThan(50);
  });

  test('daemon 不反应 (一直 stale done) → 返 ok=false reason=timeout', async () => {
    // supervisor 永远不反应 — state.json 一直 done/idle
    writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'frozen', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });

    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 300,
      pollIntervalMs: 30,
      onPoll: () => {},
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    // 证明从未见过 active (sawActive 一直是 false)
  });

  test('active 第一次 poll 就见到 (无 stale 期) → ok=done 正常', async () => {
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'done', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 100);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
    // 第一次 poll 立即 active
    expect(polls[0]).toBe('active');
    // 不应 timeout
    expect(r.reason).not.toBe('timeout');
  });

  test('starting from blocked-needs (waiting bg) → 等到 active 再接受 blocked-needs', async () => {
    // 模拟 waiting bg: 注入前 supervisor 显示 blocked+needs (旧需求, 已注入下一条)
    // 注入后 supervisor 短暂切 active, 然后又 blocked+needs (新需求)
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'old q?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 60);
    setTimeout(() => {
      writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 120);
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: 'new q?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 180);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
    // 证明了: 跳过前两次 blocked-needs, 等到 active, 再接受后续 blocked-needs
    expect(polls).toContain('active');
    expect(polls).toContain('blocked-needs');
  });
});

/**
 * v2.4.1 done-bg fix (sawStateChange gate):
 *   之前的 sawActive gate 对 done bg 太严格 —— supervisor 把 done 直接转 blocked
 *   (不经 running), sawActive 永远 false, 卡 "处理中 0s" 直到 timeout。
 *   替换为 sawStateChange: 任何 state/tempo 字段变化 vs 首次 poll 即触发。
 *
 *   - done bg: done → blocked (no running phase) → sawStateChange 在 done→blocked 触发
 *   - stopped bg: stopped → running → blocked → sawStateChange 在 stopped→running 触发
 *   - waiting bg: blocked+needs → running → blocked+needs → sawStateChange
 *   - frozen daemon (永不变化): 一直不变 → timeout
 *
 *   同时: skip 阶段 (stale done/stopped) 仍调 onPoll 让 caller 维持 elapsed time。
 */
describe('RendezvousClient.pollStateJsonStreaming - sawStateChange gate (v2.4.1 done-bg fix)', () => {
  let jobsDir: string;
  const SHORT = 'dcb2ec25';

  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), 'rendezvous-statechange-jobs-'));
    mkdirSync(join(jobsDir, SHORT), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(jobsDir, { recursive: true, force: true }); } catch {}
  });

  function writeState(state: any) {
    writeFileSync(join(jobsDir, SHORT, 'state.json'), JSON.stringify(state));
  }

  test('done → blocked (no running phase) → returns new_needs', async () => {
    // Simulate done bg that goes directly to blocked+needs after inject:
    //   poll 1: {state: 'done', tempo: 'idle'}     (stale pre-inject)
    //   poll 2: {state: 'done', tempo: 'idle'}     (still stale)
    //   poll 3: {state: 'blocked', tempo: 'blocked', needs: '?'} (real transition)
    // Expect: result.reason === 'new_needs', result.ok === true
    // (sawStateChange=true at poll 3 because state field changed)
    writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'stale pre-inject', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    // 60ms 后仍 stale
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'still stale', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 60);
    // 120ms 后 supervisor 直接转 blocked+needs (不经 running)
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: 'pick one?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 120);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
    // 证明经历了 done (stale skip) → blocked-needs (real terminal)
    expect(polls).toContain('done');        // 至少一次 stale done
    expect(polls[polls.length - 1]).toBe('blocked-needs');
  });

  test('stopped → running → blocked → returns new_needs', async () => {
    // Same as before — should still work with sawStateChange gate
    //   poll 1: {state: 'stopped', tempo: 'idle'}
    //   poll 2: {state: 'running', tempo: 'active'}
    //   poll 3: {state: 'blocked', tempo: 'blocked', needs: '?'}
    // Expect: result.reason === 'new_needs'
    writeState({ state: 'stopped', tempo: 'idle', needs: '', detail: 'stopped', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 60);
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: 'next?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 150);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
    expect(polls).toContain('stopped');     // stale stopped
    expect(polls).toContain('active');      // supervisor 反应 (sawStateChange 在此触发)
    expect(polls[polls.length - 1]).toBe('blocked-needs');
  });

  test('stays in done forever (daemon not reacting) → timeout', async () => {
    //   poll 1-N: always {state: 'done', tempo: 'idle'} (no change)
    // Expect: result.reason === 'timeout'
    writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'frozen', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    // 永不变化

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 300,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    // 证明 done 是 stale-skip 处理的,不是终态
    // (sawStateChange 一直是 false, 不会触发 classifyPatchFromState)
    expect(polls.length).toBeGreaterThan(0);
  });

  test('first poll shows active immediately → returns normally', async () => {
    //   poll 1: {state: 'running', tempo: 'active'}
    //   poll 2: {state: 'done', tempo: 'idle'}
    // Expect: result.reason === 'done'
    writeState({ state: 'running', tempo: 'active', needs: '', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'done', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 80);

    const polls: any[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { polls.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
    // 第一次 poll 就是 active, sawStateChange 在第二次 poll (state done) 触发
    expect(polls[0]).toBe('active');
    expect(polls[polls.length - 1]).toBe('done');
  });

  test('onPoll fires during pre-state-change skip (for elapsed time update)', async () => {
    // Track how many times onPoll was called
    //   poll 1: {state: 'done', tempo: 'idle'} → onPoll called (skip branch)
    //   poll 2: {state: 'done', tempo: 'idle'} → onPoll called (skip branch)
    //   poll 3: {state: 'blocked', tempo: 'blocked'} → onPoll called (normal terminal)
    //   poll 4: returns
    // Expect: onPoll called ≥ 3 times (skip cases DO trigger onPoll)
    writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'stale1', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    setTimeout(() => {
      writeState({ state: 'done', tempo: 'idle', needs: '', detail: 'stale2', inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 60);
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: 'q?', detail: null, inFlight: null, linkScanPath: null, linkScanOffset: 0, name: null });
    }, 150);

    let pollCount = 0;
    const seenKinds: string[] = [];
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT,
      stateJsonPath: jobsDir,
      timeoutMs: 3000,
      pollIntervalMs: 30,
      onPoll: (s) => { pollCount += 1; seenKinds.push(s.kind); },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBe('new_needs');
    // 关键: skip 阶段 (stale done) 也调 onPoll, 不止终态那一次
    expect(pollCount).toBeGreaterThanOrEqual(3);
    // 证明 skip 阶段的 onPoll 也带上了 stale state 的 kind
    expect(seenKinds).toContain('done');
    expect(seenKinds).toContain('blocked-needs');
  });
});

/**
 * v2.4.x AbortSignal 支持: pollStateJsonStreaming 接受可选 signal,
 * signal.aborted 时立即退出并返回 { ok: false, reason: 'aborted' }。
 * 覆盖 pre-aborted (signal 已 abort, 循环没跑) + mid-poll abort (sleep 期间 abort)。
 */
describe('RendezvousClient.pollStateJsonStreaming — AbortSignal', () => {
  let jobsDir: string;
  const SHORT = 'abcd1234';

  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), 'rndzv-abort-'));
    mkdirSync(join(jobsDir, SHORT), { recursive: true });
    writeFileSync(join(jobsDir, SHORT, 'state.json'), JSON.stringify({
      state: 'running',
      tempo: 'active',
      detail: null,
      needs: '',
      inFlight: null,
      linkScanPath: null,
      linkScanOffset: 0,
      name: 'x',
      cwd: '/',
    }));
  });

  afterEach(() => {
    try { rmSync(jobsDir, { recursive: true, force: true }); } catch {}
  });

  test('pre-aborted signal returns reason="aborted" without polling', async () => {
    const ac = new AbortController();
    ac.abort();
    let polled = 0;
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT, stateJsonPath: jobsDir, timeoutMs: 5_000, pollIntervalMs: 10,
      signal: ac.signal,
      onPoll: async () => { polled++; },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aborted');
    expect(polled).toBe(0);
  });

  test('signal aborted mid-poll exits within one tick', async () => {
    const ac = new AbortController();
    let polled = 0;
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: SHORT, stateJsonPath: jobsDir, timeoutMs: 5_000, pollIntervalMs: 10,
      signal: ac.signal,
      onPoll: async () => { polled++; if (polled === 2) ac.abort(); },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aborted');
    expect(polled).toBeGreaterThanOrEqual(2);
    expect(polled).toBeLessThan(5);
  });
});
