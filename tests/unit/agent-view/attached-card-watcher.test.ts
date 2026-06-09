// tests/unit/agent-view/attached-card-watcher.test.ts
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  AttachedCardWatcher,
  AttachedWatchers,
  DEFAULT_ATTACHED_WATCH_CONFIG,
} from '../../../src/agent-view/attached-card-watcher';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

describe('DEFAULT_ATTACHED_WATCH_CONFIG', () => {
  test('default values match spec', () => {
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.intervalMs).toBe(10_000);
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxTicks).toBe(800);
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxPatchFailures).toBe(3);
  });
});

describe('AttachedCardWatcher lifecycle', () => {
  let patchFn: ReturnType<typeof mock>;
  let onStop: ReturnType<typeof mock>;
  let resolveContent: ReturnType<typeof mock>;

  beforeEach(() => {
    patchFn = mock(async () => ({}));
    onStop = mock();
    resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
  });

  afterEach(() => {
    // noop
  });

  test('start() initiates setInterval; stop() clears it', () => {
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    watcher.start();
    expect(onStop).not.toHaveBeenCalled();
    watcher.stop('test');
    expect(onStop).toHaveBeenCalledWith('ou_test', 'test', watcher);
  });

  test('stop() is idempotent', () => {
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    watcher.start();
    watcher.stop('first');
    watcher.stop('second');
    // onStop 只调一次
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('AttachedCardWatcher.tick()', () => {
  let patchFn: ReturnType<typeof mock>;
  let onStop: ReturnType<typeof mock>;
  let resolveContent: ReturnType<typeof mock>;
  let fetchSpy: ReturnType<typeof spyOn>;

  const makeSession = (status: AgentSession['status'], completed = false): AgentSession => ({
    pid: 1234,
    cwd: '/tmp',
    kind: 'background',
    startedAt: Date.now() - 5000,
    sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
    name: 'test',
    status,
    source: 'slash',
    completed,
  });

  beforeEach(() => {
    patchFn = mock(async () => ({}));
    onStop = mock();
    resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
    fetchSpy = spyOn(AgentSnapshotFetcher, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore?.();
  });

  test('happy path: snapshot busy + content -> patchFn called once', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('snapshot failure: skip patch, do not stop', async () => {
    fetchSpy.mockResolvedValue({ ok: false, reason: 'daemon not running' });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  test('session gone: patch final error card + stop', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('ou_test', 'session_gone', watcher);
  });

  test('session idle + completed: patch final + stop idle_settled', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', true)] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('ou_test', 'idle_settled', watcher);
  });

  test('session idle but NOT completed (active idle): keep watching', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', false)] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('JSONL miss: recentOutput = "(无可用输出)" + patch 照常', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    resolveContent.mockResolvedValue({ text: null, format: 'markdown' });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    const card = JSON.parse(patchFn.mock.calls[0][1] as string);
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).toContain('无可用输出');
  });

  test('patchFn failure 1 time: patchFailureCount=1, no stop', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    patchFn.mockRejectedValue(new Error('network'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('patchFn failure 3 times: stop patch_failed', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    patchFn.mockRejectedValue(new Error('network'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50, maxPatchFailures: 3 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'patch_failed', watcher);
  });

  test('maxTicks reached: stop max_ticks + final patch with timeout header', async () => {
    // 修 B1:per spec §3.4 max_ticks 也要 patch final 卡
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50, maxTicks: 2 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    // 第 1 个 tick 是普通 patch,第 2 个 tick 触发 max_ticks → regular patch + final patch
    patchFn.mockClear();
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'max_ticks', watcher);
    // 最后一次 patch 是 final card
    expect(patchFn).toHaveBeenCalledTimes(2); // regular + final
    const lastCall = patchFn.mock.calls[patchFn.mock.calls.length - 1];
    const finalCard = JSON.parse(lastCall[1] as string);
    expect(finalCard.header.title.content).toBe('⏱ Watch stopped (timeout)');
  });

  test('session_gone final card has session_gone header', async () => {
    // 修 B2:final card header title per spec §3.4
    fetchSpy.mockResolvedValue({ ok: true, sessions: [] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    const finalCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(finalCard.header.title.content).toBe('❌ Session 已结束');
  });

  test('idle_settled final card has idle_settled header', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', true)] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    const finalCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(finalCard.header.title.content).toBe('✅ 已结束');
  });

  test('user_chat stop with patchFinal uses user_chat header', async () => {
    // 修 B2:bot.handleChat hook 走 user_chat stop
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.start();
    await watcher.tick(); // 触发一次 patch,设置 lastRecentOutput
    patchFn.mockClear();
    await watcher.stop('user_chat', { patchFinal: true });
    expect(patchFn).toHaveBeenCalledTimes(1);
    const finalCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(finalCard.header.title.content).toBe('🔌 Watch stopped · 收到新消息');
  });

  test('user_stop stop with patchFinal uses user_stop header', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.start();
    await watcher.tick();
    patchFn.mockClear();
    await watcher.stop('user_stop', { patchFinal: true });
    const finalCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(finalCard.header.title.content).toBe('🔌 Watch stopped');
  });

  test('superseded stop with patchFinal: PATCH with "Watch replaced" header (UX fix)', async () => {
    // deploy 后用户反馈:re-attach 时老卡没自动刷新,用户看老卡以为坏了。
    // 修复:supersede 时 PATCH 老卡显示 "🔄 Watch replaced" 头,引导用户看新卡
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.start();
    await watcher.tick();
    patchFn.mockClear();
    await watcher.stop('superseded', { patchFinal: true });
    expect(patchFn).toHaveBeenCalledTimes(1);
    const finalCard = JSON.parse(patchFn.mock.calls[0][1] as string);
    expect(finalCard.header.title.content).toBe('🔄 Watch replaced');
  });

  test('shutdown stop with patchFinal: NO patch (process exiting)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.start();
    await watcher.tick();
    patchFn.mockClear();
    await watcher.stop('shutdown', { patchFinal: true });
    expect(patchFn).not.toHaveBeenCalled();
  });

  test('session_gone + final patch fails: still stops (no infinite retry)', async () => {
    // C3 回归:final patch 失败时,watcher 也必须 stop,否则会无限重试直到 max_ticks
    fetchSpy.mockResolvedValue({ ok: true, sessions: [] });
    patchFn.mockRejectedValue(new Error('card deleted by feishu'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    // final patch throw 被吞,stop('session_gone') 仍要调
    expect(onStop).toHaveBeenCalledWith('ou_test', 'session_gone', watcher);
    expect(patchFn).toHaveBeenCalledTimes(1); // 只调 1 次(不会重试)
  });

  test('idle_settled + final patch fails: still stops (no infinite retry)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', true)] });
    patchFn.mockRejectedValue(new Error('card deleted by feishu'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'idle_settled', watcher);
    expect(patchFn).toHaveBeenCalledTimes(1);
  });
});

describe('AttachedWatchers manager', () => {
 let patchFn: ReturnType<typeof mock>;
 let resolveContent: ReturnType<typeof mock>;

 beforeEach(() => {
 patchFn = mock(async () => ({}));
 resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
 });

 test('start adds watcher to map; has() returns true', async () => {
 const mgr = new AttachedWatchers(() => patchFn, resolveContent, {
 ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50,
 });
 expect(mgr.has('ou_a')).toBe(false);
 await mgr.start('ou_a', {
 sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
 });
 expect(mgr.has('ou_a')).toBe(true);
 await mgr.stopAll();
 });

 test('start supersedes old watcher (old stop, new starts)', async () => {
 const mgr = new AttachedWatchers(() => patchFn, resolveContent, {
 ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50,
 });
 await mgr.start('ou_a', {
 sessionId: 's1', shortId: 's1short', name: 'n1', cwd: '/tmp', cardMessageId: 'om1',
 });
 const oldWatcher = (mgr as any).watchers.get('ou_a');
 await mgr.start('ou_a', {
 sessionId: 's2', shortId: 's2short', name: 'n2', cwd: '/tmp', cardMessageId: 'om2',
 });
 const newWatcher = (mgr as any).watchers.get('ou_a');
 expect(newWatcher).not.toBe(oldWatcher);
 expect((oldWatcher as any).stopped).toBe(true);
 expect((newWatcher as any).stopped).toBe(false);
 await mgr.stopAll();
 });

 test('stop: removes from map', async () => {
 const mgr = new AttachedWatchers(() => patchFn, resolveContent, {
 ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50,
 });
 await mgr.start('ou_a', {
 sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
 });
 await mgr.stop('ou_a', 'user_stop');
 expect(mgr.has('ou_a')).toBe(false);
 });

 test('stop on missing openId: no-op', async () => {
 const mgr = new AttachedWatchers(patchFn, resolveContent);
 await mgr.stop('nonexistent', 'test'); // should not throw
 });

 test('identity check: old watcher onStop does not delete new watcher', async () => {
 const mgr = new AttachedWatchers(() => patchFn, resolveContent, {
 ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50,
 });
 await mgr.start('ou_a', {
 sessionId: 's1', shortId: 's1short', name: 'n1', cwd: '/tmp', cardMessageId: 'om1',
 });
 const oldWatcher = (mgr as any).watchers.get('ou_a');
 // supersede-style start
 await mgr.start('ou_a', {
 sessionId: 's2', shortId: 's2short', name: 'n2', cwd: '/tmp', cardMessageId: 'om2',
 });
 // manually invoke oldWatcher.onStop (simulating slow in-flight tick completing)
 oldWatcher.deps.onStop('ou_a', 'superseded', oldWatcher);
 // verify new watcher in map was not deleted
 expect(mgr.has('ou_a')).toBe(true);
 const current = (mgr as any).watchers.get('ou_a');
 expect(current).not.toBe(oldWatcher);
 await mgr.stopAll();
 });

 test('inFlightTick mutex: setInterval skips if previous still running', async () => {
 // construct a slow patchFn that simulates tick blocking
 let resolvePatch: () => void = () => {};
 const slowPatch = mock(async () => {
 return new Promise<void>(r => { resolvePatch = r; });
 });
 const mgr = new AttachedWatchers(() => slowPatch as any, resolveContent, {
 ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:10, maxTicks:1000,
 });
 // stub AgentSnapshotFetcher (project pattern, not spyOn, to avoid spy leakage)
 const origFetch = AgentSnapshotFetcher.fetch;
 (AgentSnapshotFetcher as any).fetch = mock(async () => ({
 ok: true,
 sessions: [{
 pid:1, cwd: '/tmp', kind: 'background', startedAt: Date.now(),
 sessionId: 's1', name: 'n', status: 'busy', source: 'slash',
 }],
 }));
 try {
 await mgr.start('ou_a', {
 sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
 });
 // wait ~30ms so multiple intervals fire
 await new Promise(r => setTimeout(r,30));
 // patch should only be called once (inFlightTick mutex skips subsequent)
 expect(slowPatch).toHaveBeenCalledTimes(1);
 // resolve in-flight patch
 resolvePatch();
 } finally {
 (AgentSnapshotFetcher as any).fetch = origFetch;
 await mgr.stopAll();
 }
 });

  test('修 3:patchFn getter picks up replacement (start.ts:417 后续替换场景)', async () => {
  // 回归测试:2026-06-09 用户报"卡片没刷新"根因。
  // start.ts 把 patchFn 初始化为 no-op,然后 AttachedWatchers 构造时缓存旧值;
  // 之后 start.ts:417 才赋真实 createPatchFn。修复前:AttachedWatchers 永远用
  // no-op,patches 0 发出。修复后:AttachedWatchers 接受 getter,每次取最新。

  // 模拟"构造时 patchFn 是 no-op,稍后被替换"
  const noopPatchFn = mock(async () => null);
  const realPatchFn = mock(async () => ({}));
  let currentPatchFn: typeof noopPatchFn = noopPatchFn;
  const getter = () => currentPatchFn;
  const mgr = new AttachedWatchers(getter, resolveContent, {
  ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50,
  });
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({
  ok: true,
  sessions: [{
  pid:1, cwd: '/tmp', kind: 'background', startedAt: Date.now(),
  sessionId: 's1', name: 'n', status: 'busy', source: 'slash',
  }],
  }));
  const origFetch = AgentSnapshotFetcher.fetch;
  try {
  // 1) 构造时是 no-op:start watcher,但 tick 时调 no-op(0 真实 patch)
  await mgr.start('ou_a', {
  sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
  });
  await new Promise(r => setTimeout(r, 80)); // 等 1-2 tick
  expect(noopPatchFn).toHaveBeenCalled();
  expect(realPatchFn).not.toHaveBeenCalled();
  noopPatchFn.mockClear();
  realPatchFn.mockClear();

  // 2) 替换 patchFn(模拟 start.ts:417 之后)+supersede 启新 watcher
  currentPatchFn = realPatchFn;
  // 模拟 handleAttach 流程:先 stop 旧(因为 superseded),再 start 新
  await mgr.start('ou_a', {
  sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
  });
  await new Promise(r => setTimeout(r, 80)); // 等新 watcher tick
  // 新 watcher 必须用 real patchFn
  expect(realPatchFn).toHaveBeenCalled();
  // no-op 不应该被新 watcher 调
  expect(noopPatchFn.mock.calls.length).toBeLessThanOrEqual(1); // 旧 watcher 可能调了 1 次
  } finally {
  (AgentSnapshotFetcher as any).fetch = origFetch;
  await mgr.stopAll();
  }
 });
});
