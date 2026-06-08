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

  test('maxTicks reached: stop max_ticks', async () => {
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
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'max_ticks', watcher);
  });
});
