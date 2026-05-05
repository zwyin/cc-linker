import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
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
      new Set(),
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    expect(registry.has('test-session-1234')).toBe(true);
    const entry = registry.get('test-session-1234');
    expect(entry?.origin).toBe('cc-connect');
    expect(entry?.title).toBe('Test Project Setup');
    expect(entry?.cwd).toBe('/Users/test/project');
    expect(entry?.message_count).toBeGreaterThan(0);
  });

  it('detects cc-connect origin from ccConnectUuids set', async () => {
    const scanner = new JSONLScanner(
      registry,
      new Set(['test-session-1234']),
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    const entry = registry.get('test-session-1234');
    expect(entry?.origin).toBe('cc-connect');
  });

  it('skips unchanged files on incremental scan', async () => {
    const cache = new Map<string, number>();
    const scanner = new JSONLScanner(
      registry,
      new Set(),
      cache,
      join(tmpDir, '.claude')
    );

    // First scan
    await scanner.scan();
    expect(registry.has('test-session-1234')).toBe(true);

    // Second scan with cache - should skip unchanged files
    const scanner2 = new JSONLScanner(
      registry,
      new Set(),
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
      new Set(),
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
      new Set(),
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
      new Set(),
      new Map(),
      join(tmpDir, '.claude')
    );
    await scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_active).toBe('2026-05-03T10:05:00Z');
    expect(entry?.last_message_preview).toBe('latest assistant tail preview');
  });
});
