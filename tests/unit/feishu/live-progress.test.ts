// tests/unit/feishu/live-progress.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractLivePreview,
  isSessionProcessing,
  LiveProgressWatcher,
  DEFAULT_LIVE_PROGRESS_CONFIG,
} from '../../../src/feishu/live-progress';

describe('extractLivePreview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'live-preview-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty for null jsonlPath', () => {
    expect(extractLivePreview(null)).toEqual({});
  });

  it('returns empty for non-existent file', () => {
    expect(extractLivePreview(join(tmpDir, 'missing.jsonl'))).toEqual({});
  });

  it('extracts from real JSONL', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hello' } }));
    const result = extractLivePreview(path);
    expect(result.lastUser).toBe('hello');
  });
});

describe('isSessionProcessing', () => {
  it('returns true if sessionId is in listSessions (feishu)', async () => {
    const bot = {
      sessionManager: {
        listSessions: () => [{ sessionId: 'feishu-uuid' }],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('feishu-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(true);
  });

  it('returns false if no listSessions match and no cache', async () => {
    const bot = {
      sessionManager: {
        listSessions: () => [],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('cli-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(false);
  });
});

describe('LiveProgressWatcher', () => {
  it('exports DEFAULT_LIVE_PROGRESS_CONFIG with correct values', () => {
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs).toBe(10_000);
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks).toBe(400);
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxPatchFailures).toBe(3);
  });

  it('calls onStop when stop() invoked', () => {
    let stopped = false;
    let stopReason = '';
    const w = new LiveProgressWatcher({
      uuid: 'u1',
      openId: 'ou1',
      cardMessageId: 'm1',
      feishuClient: { im: { v1: { message: { patch: async () => ({ code: 0 }) } } } },
      bot: {} as any,
      config: DEFAULT_LIVE_PROGRESS_CONFIG,
      onStop: (_oid, reason, _watcher) => { stopped = true; stopReason = reason; },
    });
    w.stop('test_reason');
    expect(stopped).toBe(true);
    expect(stopReason).toBe('test_reason');
  });

  it('stop() is idempotent (second call no-op)', () => {
    let callCount = 0;
    const w = new LiveProgressWatcher({
      uuid: 'u1',
      openId: 'ou1',
      cardMessageId: 'm1',
      feishuClient: { im: { v1: { message: { patch: async () => ({ code: 0 }) } } } },
      bot: {} as any,
      config: DEFAULT_LIVE_PROGRESS_CONFIG,
      onStop: () => { callCount++; },
    });
    w.stop('first');
    w.stop('second');
    expect(callCount).toBe(1);
  });
});
