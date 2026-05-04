import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'fs';
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
});
