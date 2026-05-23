import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RegistryManager } from '../../src/registry';
import { mkdtempSync, rmSync, existsSync, readdirSync, unlinkSync, lstatSync } from 'fs';
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
    registry.upsert('test-uuid-1', {
      origin: 'cli',
      cwd: '/test',
      title: 'Test Session',
    });

    expect(registry.has('test-uuid-1')).toBe(true);
    expect(registry.get('test-uuid-1')?.title).toBe('Test Session');
    expect(registry.get('test-uuid-1')?.origin).toBe('cli');
  });

  it('upsert updates existing session', async () => {
    registry.upsert('test-uuid-1', { title: 'Original' });
    registry.upsert('test-uuid-1', { title: 'Updated' });

    expect(registry.get('test-uuid-1')?.title).toBe('Updated');
  });

  it('findByPrefix finds unique match', async () => {
    registry.upsert('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec', { title: 'Test' });

    const match = registry.findByPrefix('b21d6d04');
    expect(match).not.toBeNull();
    expect(match![0]).toBe('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec');
  });

  it('findByPrefix returns null on multiple matches', async () => {
    registry.upsert('b21d6d04-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { title: 'A' });
    registry.upsert('b21d6d04-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { title: 'B' });

    const result = registry.findByPrefix('b21d6d04');
    expect(result).toBeNull();
  });

  it('findByPrefix returns null for no match', async () => {
    expect(registry.findByPrefix('nonexistent')).toBeNull();
  });

  it('remove deletes session', async () => {
    registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.remove('test-uuid-1');

    expect(registry.has('test-uuid-1')).toBe(false);
  });

  it('creates backup on save', async () => {
    registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.flush();

    const backupDir = join(tmpDir, 'backups');
    expect(existsSync(backupDir)).toBe(true);

    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('keeps max 3 backups', async () => {
    for (let i = 0; i < 5; i++) {
      registry.upsert(`uuid-${i}`, { title: `Session ${i}` });
      await registry.flush();
    }

    const backupDir = join(tmpDir, 'backups');
    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeLessThanOrEqual(3);
  });

  it('replaces dangling .bak symlink during backup rotation', async () => {
    registry.upsert('uuid-1', { title: 'Session 1' });
    await registry.flush();

    const backupDir = join(tmpDir, 'backups');
    const existingBackup = readdirSync(backupDir).find(f => f.startsWith('registry.'));
    expect(existingBackup).toBeDefined();
    unlinkSync(join(backupDir, existingBackup!));

    registry.upsert('uuid-2', { title: 'Session 2' });
    await registry.flush();

    const bakPath = join(tmpDir, 'registry.json.bak');
    expect(lstatSync(bakPath).isSymbolicLink()).toBe(true);
  });

  it('upsert does not overwrite existing values with undefined', () => {
    registry.upsert('test-uuid-1', {
      origin: 'feishu',
      title: 'Original Title',
      cwd: '/Users/test',
    });

    // Update with partial data - should not clear title
    registry.upsert('test-uuid-1', {
      last_active: '2026-06-01T10:00:00Z',
      message_count: 42,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.title).toBe('Original Title');
    expect(entry?.origin).toBe('feishu');
    expect(entry?.message_count).toBe(42);
    expect(entry?.last_active).toBe('2026-06-01T10:00:00Z');
  });

  it('upsert allows intentional null values (e.g., clearing jsonl_path)', () => {
    registry.upsert('test-uuid-1', {
      origin: 'feishu',
      jsonl_path: '/path/to/file.jsonl',
    });

    // Clear stale mapping by setting to null
    registry.upsert('test-uuid-1', {
      jsonl_path: null,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.jsonl_path).toBeNull();
  });

  it('upsert preserves non-overwritten fields', () => {
    registry.upsert('test-uuid-1', {
      origin: 'cli',
      cwd: '/Users/test/project',
      title: 'My Project',
      message_count: 10,
    });

    // Only update message_count
    registry.upsert('test-uuid-1', {
      message_count: 15,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.title).toBe('My Project');
    expect(entry?.origin).toBe('cli');
    expect(entry?.cwd).toBe('/Users/test/project');
    expect(entry?.message_count).toBe(15);
  });

  it('merges concurrent writes from different managers without losing sessions', async () => {
    const registry1 = new RegistryManager(tmpDir);
    const registry2 = new RegistryManager(tmpDir);

    registry1.upsert('uuid-a', { title: 'Session A' });
    registry2.upsert('uuid-b', { title: 'Session B' });

    await Promise.all([registry1.flush(), registry2.flush()]);

    const finalRegistry = new RegistryManager(tmpDir);
    expect(finalRegistry.get('uuid-a')?.title).toBe('Session A');
    expect(finalRegistry.get('uuid-b')?.title).toBe('Session B');
  });

  it('merges concurrent field updates on the same session', async () => {
    registry.upsert('shared-uuid', {
      title: 'Original',
      cwd: '/Users/test/project',
    });
    await registry.flush();

    const registry1 = new RegistryManager(tmpDir);
    const registry2 = new RegistryManager(tmpDir);

    registry1.upsert('shared-uuid', { message_count: 10 });
    registry2.upsert('shared-uuid', { last_message_preview: 'Latest preview' });

    await Promise.all([registry1.flush(), registry2.flush()]);

    const finalRegistry = new RegistryManager(tmpDir);
    const entry = finalRegistry.get('shared-uuid');
    expect(entry?.title).toBe('Original');
    expect(entry?.message_count).toBe(10);
    expect(entry?.last_message_preview).toBe('Latest preview');
  });
});
