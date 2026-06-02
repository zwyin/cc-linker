import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock 整个 process-info 模块
mock.module('../../../src/utils/process-info', () => ({
  getClaudeProcessesByCwd: mock(() => []),
  getProcessCPUTimeSeconds: mock(() => Promise.resolve(0)),
  parsePsTimeToSeconds: (s: string) => {
    if (!s) return 0;
    let days = 0;
    let rest = s;
    if (rest.includes('-')) {
      days = parseInt(rest.slice(0, rest.indexOf('-')), 10) || 0;
      rest = rest.slice(rest.indexOf('-') + 1);
    }
    const parts = rest.split(':');
    if (parts.length === 3) return days * 86400 + parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    if (parts.length === 2) return days * 86400 + parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(rest);
  },
}));

// ESM imports
import {
  writeActivityMarker,
  readLastActivityMarker,
  isSessionActive,
  SessionActivityCache,
  cleanupOldActivityLogs,
} from '../../../src/utils/session-activity';

describe('Activity Marker (sidecar)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('write + read 最近的 marker', async () => {
    writeActivityMarker('11111111-1111-1111-1111-111111111111', 'feishu', 'start', 12345);
    writeActivityMarker('11111111-1111-1111-1111-111111111111', 'feishu', 'heartbeat', 12345);
    const marker = readLastActivityMarker('11111111-1111-1111-1111-111111111111');
    expect(marker?.action).toBe('heartbeat');
    expect(marker?.platform).toBe('feishu');
    expect(marker?.pid).toBe(12345);
  });

  test('sidecar 文件不存在 → return null', async () => {
    expect(readLastActivityMarker('nonexistent')).toBeNull();
  });

  test('空 sessionUuid 保护', async () => {
    writeActivityMarker('', 'feishu', 'start');
    expect(readLastActivityMarker('')).toBeNull();
  });
});

describe('isSessionActive (combined)', () => {
  test('direction=cli-detects-feishu + 无 marker → inactive', async () => {
    const cache = new SessionActivityCache();
    const result = await isSessionActive(
      { sessionUuid: '22222222-2222-2222-2222-222222222222', cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('no_marker');
  });

  test('direction=cli-detects-feishu + no_session_uuid → low confidence', async () => {
    const cache = new SessionActivityCache();
    const result = await isSessionActive(
      { sessionUuid: null, cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('low');
  });

  test('缓存命中：第二次调用不重新检测', async () => {
    const cache = new SessionActivityCache();
    const entry = { sessionUuid: '33333333-3333-3333-3333-333333333333', cwd: '/tmp', jsonl_path: null };

    writeActivityMarker('33333333-3333-3333-3333-333333333333', 'feishu', 'start');
    const r1 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.source).toBe('marker');

    cleanupOldActivityLogs(0);  // 删除所有
    const r2 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2).toBe(r1);  // 同一对象引用
  });

  test('缓存失效：invalidate 后重新检测', async () => {
    const cache = new SessionActivityCache();
    const entry = { sessionUuid: '44444444-4444-4444-4444-444444444444', cwd: '/tmp', jsonl_path: null };

    writeActivityMarker('44444444-4444-4444-4444-444444444444', 'feishu', 'end');
    const r1 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.isProcessing).toBe(false);

    cache.invalidate('cli-detects-feishu:44444444-4444-4444-4444-444444444444');

    writeActivityMarker('44444444-4444-4444-4444-444444444444', 'feishu', 'heartbeat');
    const r2 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2.isProcessing).toBe(true);
  });
});

describe('SessionActivityCache', () => {
  test('默认 TTL 10 秒', () => {
    const cache = new SessionActivityCache();
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    expect(cache.get('key')?.isProcessing).toBe(true);
  });

  test('自定义 TTL', async () => {
    const cache = new SessionActivityCache(50);
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(cache.get('key')).toBeNull();
  });
});
