import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('JSONLScanner', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-scanner-test-'));
    registry = new RegistryManager(tmpDir);

    // Create mock Claude projects directory
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });
    copyFileSync(
      join(__dirname, '../../fixtures/sample.jsonl'),
      join(projectDir, 'test-session-1234.jsonl')
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans JSONL files and registers sessions', async () => {
    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    expect(registry.has('test-session-1234')).toBe(true);
    const entry = registry.get('test-session-1234');
    // 自建方案下，JSONLScanner 扫描的均为 CLI 会话
    expect(entry?.origin).toBe('cli');
    expect(entry?.title).toBe('Test Project Setup');
    expect(entry?.cwd).toBe('/Users/test/project');
    expect(entry?.message_count).toBeGreaterThan(0);
  });

  it('skips unchanged files on incremental scan', async () => {
    const cache = new Map<string, number>();
    const scanner = new JSONLScanner(
      registry,
      cache,
      join(tmpDir, '.claude')
    );

    // First scan
    await scanner.scan();
    expect(registry.has('test-session-1234')).toBe(true);

    // Second scan with cache - should skip unchanged files
    const scanner2 = new JSONLScanner(
      registry,
      cache,
      join(tmpDir, '.claude')
    );
    await scanner2.scan();

    // Should still have the entry
    expect(registry.has('test-session-1234')).toBe(true);
  });

  it('returns empty when directory does not exist', async () => {
    const scanner = new JSONLScanner(
      registry,
      new Map(),
      '/nonexistent'
    );
    await scanner.scan();

    expect(Object.keys(registry.sessions).length).toBe(0);
  });

  it('skips files exceeding max size', async () => {
    // Create a JSONL file that's too large (>100MB)
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    const largeFile = join(projectDir, 'large-session.jsonl');

    // Write a 101MB file (just over the limit)
    const chunk = '{"type":"user","message":{"content":"' + 'x'.repeat(1000) + '"},"timestamp":"2026-01-01T00:00:00Z"}\n';
    const chunks = Math.ceil((101 * 1024 * 1024) / chunk.length);
    writeFileSync(largeFile, chunk.repeat(chunks));

    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    // The large file should be skipped (not registered)
    expect(registry.has('large-session')).toBe(false);
    // But the normal-sized file should still be registered
    expect(registry.has('test-session-1234')).toBe(true);
  });

  it('uses the latest tail entry for large-file incremental scans', async () => {
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    const sessionId = 'large-tail-session';
    const largeFile = join(projectDir, `${sessionId}.jsonl`);

    const lines: string[] = [];
    for (let i = 0; i < 120; i++) {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `padding ${i} ${'x'.repeat(80)}` },
        timestamp: `2026-05-03T09:${String(i % 60).padStart(2, '0')}:00Z`,
      }));
    }
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'older assistant tail preview' }] },
      timestamp: '2026-05-03T10:00:00Z',
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'latest assistant tail preview' }] },
      timestamp: '2026-05-03T10:05:00Z',
    }));
    writeFileSync(largeFile, lines.join('\n'));

    registry.upsert(sessionId, {
      title: 'Existing Session',
      cwd: '/Users/test/project',
      jsonl_path: largeFile,
      last_active: '2026-05-03T08:00:00Z',
      last_message_preview: 'old preview',
    });

    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_active).toBe('2026-05-03T10:05:00Z');
    expect(entry?.last_message_preview).toBe('latest assistant tail preview');
  });

  // v0.4.1: parseFull 检测到 JSONL 含 isSidechain:true 条目时设 is_subagent,
  // /list 据此过滤掉 Task tool 派生的 subagent sessions。
  it('marks session as is_subagent when JSONL has isSidechain:true entries', async () => {
    const sessionId = 'subagent-session-aaaa-bbbb-cccc-dddddddddddd';
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-subagent');
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    // 模拟 Task tool 派生的 subagent:user/assistant 条目 isSidechain:true,
    // 顶级 hook/permission entries isSidechain:false。
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'attachment', sessionId, isSidechain: false, timestamp: '2026-05-01T09:00:00Z' }));
    lines.push(JSON.stringify({ type: 'permission-mode', sessionId, isSidechain: false, timestamp: '2026-05-01T09:00:01Z' }));
    lines.push(JSON.stringify({
      type: 'user',
      isSidechain: true,
      parentUuid: 'parent-uuid',
      message: { role: 'user', content: 'do task X' },
      sessionId,
      timestamp: '2026-05-01T09:01:00Z',
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      sessionId,
      timestamp: '2026-05-01T09:02:00Z',
    }));
    writeFileSync(jsonlPath, lines.join('\n'));

    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.is_subagent).toBe(true);
  });

  it('does NOT mark session as subagent when JSONL has no isSidechain:true entries', async () => {
    const sessionId = 'top-level-session-aaaa-bbbb-cccc-dddddddddddd';
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-toplevel');
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    // 模拟用户在终端跑的真实 session —— 没有 isSidechain:true 条目
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'attachment', sessionId, isSidechain: false, timestamp: '2026-05-01T09:00:00Z' }));
    lines.push(JSON.stringify({
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: 'help me with this code' },
      sessionId,
      timestamp: '2026-05-01T09:01:00Z',
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
      sessionId,
      timestamp: '2026-05-01T09:02:00Z',
    }));
    writeFileSync(jsonlPath, lines.join('\n'));

    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    const entry = registry.get(sessionId);
    // 字段不存在 = 老 entry 的语义,等同于 false(/list filter 用 !== true 比较)
    expect(entry?.is_subagent).toBeUndefined();
  });

  // 修复：stub session（JSONL 只有 marker 行，无 user/assistant 消息）的
  // last_active fallback 不应该是 scanner 扫描时刻，而应该是 JSONL 文件本身的 mtime。
  // 之前 `new Date().toISOString()` fallback 导致生产环境 7 个 stub session 全部
  // 显示 "19 分钟前"（scanner 刚启动那一秒），用户报 bug：实际活跃时间是几天前。
  it('uses file mtime as last_active fallback for stub sessions with only marker lines', async () => {
    const sessionId = 'stub-marker-only-session-aaaa-bbbb-cccc-dddddddddddd';
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-stub');
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    // 模拟生产环境真实 stub session：只有 ai-title + agent-name marker，没有 user/assistant。
    writeFileSync(
      jsonlPath,
      JSON.stringify({ type: 'ai-title', aiTitle: 'Review scan performance design', sessionId }) +
        '\n' +
        JSON.stringify({ type: 'agent-name', agentName: 'Review scan performance design', sessionId }) +
        '\n',
    );

    // 把文件 mtime 设到 2 天前（用 UTC 字符串保持测试稳定）
    const twoDaysAgo = new Date('2026-06-10T11:00:00Z');
    utimesSync(jsonlPath, twoDaysAgo, twoDaysAgo);

    const beforeScan = Date.now();
    const scanner = new JSONLScanner(
      registry,
      new Map(),
      join(tmpDir, '.claude'),
    );
    await scanner.scan();
    const afterScan = Date.now();

    const entry = registry.get(sessionId);
    expect(entry).toBeDefined();
    // 关键断言：last_active 必须等于文件 mtime，而不是 scanner 扫描时刻
    expect(entry?.last_active).toBe(twoDaysAgo.toISOString());
    // 显式反断言：绝不能用 scanner 当前时间作为 fallback
    const lastActiveMs = new Date(entry!.last_active!).getTime();
    expect(lastActiveMs).toBeLessThan(beforeScan);
    expect(lastActiveMs).toBeLessThan(afterScan);
    // created_at 同样应该 fallback 到文件 mtime（marker 行没有 timestamp）
    expect(entry?.created_at).toBe(twoDaysAgo.toISOString());
    // message_count 应为 0（marker 都被过滤）
    expect(entry?.message_count).toBe(0);
  });
});
