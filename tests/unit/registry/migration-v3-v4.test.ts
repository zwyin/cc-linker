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

  it('v2 input falls back to empty v4 registry (no v2→v3 migration in scope)', () => {
    // PR 1 (migrateV3toV4) only adds a v3→v4 migration path. v2 data has no
    // migration to v4, so load() rejects the file (RegistrySchema requires
    // version: 4) and the catch path falls back to createEmpty(). The legacy
    // session is lost — this is the documented graceful-degradation behavior
    // for v2 inputs. PR 2 / PR 3 may add a v2→v3 migration that would change
    // this assertion.
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
    // legacy-session is lost (graceful degradation)
    expect(manager.sessions).toEqual({});
    expect(manager.sessions['legacy-session']).toBeUndefined();
    // The on-disk file is now an empty v4 registry (createEmpty saved it)
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
    expect(raw.sessions).toEqual({});
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

  it('load() persists the upgraded v4 file to disk (smoke test fix)', () => {
    // PR 1 smoke test failed because load() migrated parsed.version to 4
    // in-memory but never wrote it back to disk. The on-disk file stayed v3
    // until something else triggered a save. Fix: load() must rotate a
    // backup and write the migrated v4 data to disk when migration occurs.
    writeRegistry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Persisted',
        message_count: 7,
        last_message_preview: 'persisted preview',
      },
    });

    new RegistryManager(tmpDir);

    // On-disk file must now be v4 with sessions preserved
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
    expect(raw.sessions['session-1']).toBeDefined();
    expect(raw.sessions['session-1'].last_message_preview).toBe('persisted preview');
    expect(raw.sessions['session-1'].message_count).toBe(7);

    // A backup of the original v3 file must have been rotated
    expect(require('fs').existsSync(join(tmpDir, 'backups'))).toBe(true);
  });

  it('reload() persists v3→v4 migration to disk', async () => {
    // Initial v3 file
    writeRegistry(3, {
      's1': {
        origin: 'cli',
        cwd: '/tmp/reload-test',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Reload Test',
        message_count: 3,
        last_message_preview: 'old',
      },
    });

    // Manager loads v3, migrates to v4, persists
    const m = new RegistryManager(tmpDir);
    expect(m.sessions['s1'].title).toBe('Reload Test');

    // Sanity check: on-disk is now v4 (constructor persisted)
    let raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);

    // Manually re-write v3 to simulate a stale on-disk file
    // (e.g., another process wrote an older version, or disk corruption)
    writeRegistry(3, {
      's1': {
        origin: 'cli',
        cwd: '/tmp/reload-test',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Reload Test',
        message_count: 3,
        last_message_preview: 'old',
      },
    });

    // Sanity check: on-disk is now v3
    raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(3);

    // Reload from a single manager — must migrate and persist v4
    await m.reload();

    // On-disk should now be v4
    raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
    expect(raw.sessions['s1'].title).toBe('Reload Test');
  });
});
