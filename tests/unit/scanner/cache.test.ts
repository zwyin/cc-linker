import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCache, saveCache } from '../../../src/scanner/cache';

describe('scan_cache schemaVersion', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'));
    cachePath = join(tmpDir, 'scan_cache.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty Map when cache file missing', () => {
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('returns empty Map for v3 format cache (no meta.schemaVersion)', () => {
    writeFileSync(cachePath, JSON.stringify({
      '/path/to/file.jsonl': 1234567890,
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('returns empty Map for v3 format cache (meta.schemaVersion: 3)', () => {
    writeFileSync(cachePath, JSON.stringify({
      meta: { schemaVersion: 3 },
      cache: { '/path/to/file.jsonl': 1234567890 },
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('loads v4 format cache normally', () => {
    writeFileSync(cachePath, JSON.stringify({
      meta: { schemaVersion: 4 },
      cache: { '/path/to/file.jsonl': 1234567890 },
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(1);
    expect(cache.get('/path/to/file.jsonl')).toBe(1234567890);
  });

  it('returns empty Map for corrupted cache JSON', () => {
    writeFileSync(cachePath, '{ invalid json');
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('saveCache writes v4 format with meta.schemaVersion: 4', () => {
    const cache = new Map<string, number>();
    cache.set('/path/a.jsonl', 1000);
    cache.set('/path/b.jsonl', 2000);

    saveCache(cache, cachePath);

    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(raw.meta.schemaVersion).toBe(4);
    expect(raw.cache['/path/a.jsonl']).toBe(1000);
    expect(raw.cache['/path/b.jsonl']).toBe(2000);
  });

  it('round-trip: saveCache → loadCache preserves entries', () => {
    const cache = new Map<string, number>();
    cache.set('/x.jsonl', 999);

    saveCache(cache, cachePath);
    const loaded = loadCache(cachePath);

    expect(loaded.get('/x.jsonl')).toBe(999);
  });
});
