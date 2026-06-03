import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';
import type { SessionEntry } from '../../../src/registry';

describe('migrateV3toV4', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'registry-v3-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRegistry(version: 3 | 4, sessions: Record<string, Partial<SessionEntry>> = {}): void {
    const data = {
      version,
      updated_at: new Date().toISOString(),
      sessions,
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(data, null, 2));
  }

  it('migrates v3 complete registry to v4', () => {
    writeRegistry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: 'proj',
        jsonl_path: '/tmp/proj/.jsonl',
        project_dir: 'proj',
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Test',
        message_count: 5,
        last_message_preview: 'some preview',
      },
    });

    const manager = new RegistryManager(tmpDir);
    const data = manager.sessions;
    expect(data['session-1'].last_message_preview).toBe('some preview');
  });

  it('preserves v3 entry missing optional fields', () => {
    writeRegistry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: null,
        message_count: 0,
        last_message_preview: '',
      },
    });

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['session-1'].title).toBeNull();
    expect(manager.sessions['session-1'].last_message_preview).toBe('');
  });

  it('migrateV3toV4 is idempotent (v3 → v4 → v4 yields same data)', () => {
    // First load: migrates v3 to v4. Second load: re-applies migration, must
    // yield the same sessions (idempotent) without dropping or duplicating data.
    writeRegistry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Idempotent',
        message_count: 5,
        last_message_preview: 'preview',
      },
    });

    const first = new RegistryManager(tmpDir);
    const firstRaw = JSON.stringify(first.sessions['session-1']);
    const firstVersion = first.sessions['session-1'].last_message_preview;

    const second = new RegistryManager(tmpDir);
    const secondRaw = JSON.stringify(second.sessions['session-1']);
    const secondVersion = second.sessions['session-1'].last_message_preview;

    expect(firstVersion).toBe('preview');
    expect(secondVersion).toBe('preview');
    expect(secondRaw).toBe(firstRaw);
  });

  it('handles v2 → v3 → v4 chain (v1toV2 is a no-op for v2 input)', () => {
    const v2 = {
      version: 2,
      updated_at: new Date().toISOString(),
      sessions: {
        'legacy-session': {
          origin: 'cli',
          cwd: '/tmp/legacy',
          project_name: null,
          jsonl_path: null,
          project_dir: null,
          created_at: '2025-01-01T00:00:00Z',
          last_active: '2025-01-02T00:00:00Z',
          title: 'Legacy',
          message_count: 10,
          last_message_preview: 'old preview',
        },
      },
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(v2, null, 2));

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['legacy-session'].title).toBe('Legacy');
    expect(manager.sessions['legacy-session'].last_message_preview).toBe('old preview');
  });

  it('createEmpty returns v4 registry when file missing', () => {
    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    // Verify the on-disk version after createEmpty
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
  });

  it('recovers from corrupted v3 file via createEmpty', () => {
    writeFileSync(join(tmpDir, 'registry.json'), '{ invalid json');

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
  });

  it('v3 → v4 migration does not populate v4-introduced preview fields', () => {
    // The migration only bumps version; it must not invent last_user_preview /
    // last_assistant_preview values. Those are filled in later by the scanner.
    writeRegistry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Test',
        message_count: 5,
        last_message_preview: 'CRITICAL_PREVIEW_TEXT',
      },
    });

    const manager = new RegistryManager(tmpDir);
    const entry = manager.sessions['session-1'];
    expect(entry.last_message_preview).toBe('CRITICAL_PREVIEW_TEXT');
    expect(entry.last_user_preview).toBeUndefined();
    expect(entry.last_assistant_preview).toBeUndefined();
  });
});
