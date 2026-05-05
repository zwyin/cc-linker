import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CCConnectScanner } from '../../../src/scanner/cc-connect';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CCConnectScanner', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-connect-scanner-test-'));
    registry = new RegistryManager(tmpDir);

    // Create mock cc-connect sessions directory
    const sessionsDir = join(tmpDir, '.cc-connect', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    copyFileSync(
      join(__dirname, '../../fixtures/cc-connect-session.json'),
      join(sessionsDir, 'claude-code-feishu_test.json')
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans cc-connect sessions and returns UUIDs', async () => {
    const scanner = new CCConnectScanner(registry, tmpDir);
    const { uuids, sids } = await scanner.scan();

    expect(uuids.size).toBe(2);
    expect(uuids.has('028037a3-a7c1-4d07-85c1-28b31af19284')).toBe(true);
    expect(uuids.has('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec')).toBe(true);
    expect(sids.size).toBe(2);
  });

  it('registers sessions in registry', async () => {
    const scanner = new CCConnectScanner(registry, tmpDir);
    await scanner.scan();

    expect(registry.has('028037a3-a7c1-4d07-85c1-28b31af19284')).toBe(true);
    const entry = registry.get('028037a3-a7c1-4d07-85c1-28b31af19284');
    expect(entry?.origin).toBe('cc-connect');
    expect(entry?.cc_connect_session_id).toBe('s1');
    expect(entry?.platform).toBe('feishu');
  });

  it('detects platform from filename', async () => {
    const scanner = new CCConnectScanner(registry, tmpDir);
    await scanner.scan();

    const entry = registry.get('028037a3-a7c1-4d07-85c1-28b31af19284');
    expect(entry?.platform).toBe('feishu');
  });

  it('returns empty sets when directory does not exist', async () => {
    const scanner = new CCConnectScanner(registry, '/nonexistent');
    const { uuids, sids } = await scanner.scan();

    expect(uuids.size).toBe(0);
    expect(sids.size).toBe(0);
  });

  it('cleans stale mappings without downgrading origin or ownership', async () => {
    registry.upsert('stale-uuid', {
      origin: 'cc-connect',
      source: 'feishu:ou_secret',
      platform: 'feishu',
      owner: 'feishu:ou_secret',
      owner_user_key: 'feishu:oc_xxx:ou_secret',
      cc_connect_session_id: 'stale-sid',
      cc_connect_session_file: '/tmp/feishu-main.json',
      visibility: 'private',
      title: 'Secret Session',
    });

    const scanner = new CCConnectScanner(registry, tmpDir);
    await scanner.scan();

    const entry = registry.get('stale-uuid');
    expect(entry?.origin).toBe('cc-connect');
    expect(entry?.platform).toBe('feishu');
    expect(entry?.owner).toBe('feishu:ou_secret');
    expect(entry?.owner_user_key).toBe('feishu:oc_xxx:ou_secret');
    expect(entry?.visibility).toBe('private');
    expect(entry?.cc_connect_session_id).toBeNull();
    expect(entry?.cc_connect_session_file).toBeNull();
  });
});
