import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RegistryManager } from '../../src/registry';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RegistryManager', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-registry-test-'));
    registry = new RegistryManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty registry on init', () => {
    expect(registry.sessions).toEqual({});
    expect(existsSync(join(tmpDir, 'registry.json'))).toBe(true);
  });

  it('upsert creates new session', async () => {
    await registry.upsert('test-uuid-1', {
      origin: 'cli',
      source: 'terminal',
      cwd: '/test',
      title: 'Test Session',
    });

    expect(registry.has('test-uuid-1')).toBe(true);
    expect(registry.get('test-uuid-1')?.title).toBe('Test Session');
    expect(registry.get('test-uuid-1')?.origin).toBe('cli');
  });

  it('upsert updates existing session', async () => {
    await registry.upsert('test-uuid-1', { title: 'Original' });
    await registry.upsert('test-uuid-1', { title: 'Updated' });

    expect(registry.get('test-uuid-1')?.title).toBe('Updated');
  });

  it('findByPrefix finds unique match', async () => {
    await registry.upsert('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec', { title: 'Test' });

    const match = registry.findByPrefix('b21d6d04');
    expect(match).not.toBeNull();
    expect(match![0]).toBe('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec');
  });

  it('findByPrefix throws E006 on multiple matches', async () => {
    await registry.upsert('b21d6d04-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { title: 'A' });
    await registry.upsert('b21d6d04-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { title: 'B' });

    try {
      registry.findByPrefix('b21d6d04');
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.code).toBe('E006');
    }
  });

  it('findByPrefix returns null for no match', async () => {
    expect(registry.findByPrefix('nonexistent')).toBeNull();
  });

  it('remove deletes session', async () => {
    await registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.remove('test-uuid-1');

    expect(registry.has('test-uuid-1')).toBe(false);
  });

  it('creates backup on save', async () => {
    await registry.upsert('test-uuid-1', { title: 'Test' });

    const backupDir = join(tmpDir, 'backups');
    expect(existsSync(backupDir)).toBe(true);

    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('keeps max 3 backups', async () => {
    for (let i = 0; i < 5; i++) {
      await registry.upsert(`uuid-${i}`, { title: `Session ${i}` });
    }

    const backupDir = join(tmpDir, 'backups');
    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeLessThanOrEqual(3);
  });
});
