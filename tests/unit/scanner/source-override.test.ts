import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { RegistryManager } from '../../../src/registry';
import { CCConnectScanner } from '../../../src/scanner/cc-connect';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('JSONLScanner - source field override fix', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  const CC_UUID = 'cccc1111-2222-3333-4444-555566667777';
  const CLI_UUID = 'aaaa1111-2222-3333-4444-555566667777';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-source-test-'));
    registry = new RegistryManager(tmpDir);

    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    const ccJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli', cwd: '/Users/test/project', sessionId: CC_UUID, timestamp: '2026-05-03T09:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi from feishu' }, uuid: 'u1', timestamp: '2026-05-03T09:01:00Z', sessionId: CC_UUID }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, uuid: 'u2', timestamp: '2026-05-03T09:01:05Z', sessionId: CC_UUID }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Feishu Session', sessionId: CC_UUID }),
    ].join('\n');
    writeFileSync(join(projectDir, `${CC_UUID}.jsonl`), ccJsonl);

    const cliJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/backend', sessionId: CLI_UUID, timestamp: '2026-05-03T10:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi from cli' }, uuid: 'u3', timestamp: '2026-05-03T10:01:00Z', sessionId: CLI_UUID }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLI response' }] }, uuid: 'u4', timestamp: '2026-05-03T10:01:05Z', sessionId: CLI_UUID }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'CLI Session', sessionId: CLI_UUID }),
    ].join('\n');
    writeFileSync(join(projectDir, `${CLI_UUID}.jsonl`), cliJsonl);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves source field set by cc-connect scanner for cc-connect sessions', () => {
    // Simulate the correct scan order: cc-connect scanner first
    const ccScanner = new CCConnectScanner(registry, tmpDir);
    const { uuids } = ccScanner.scan();

    // cc-connect scanner sets source to the user key
    const ccEntry = registry.get(CC_UUID);
    // Note: CC_UUID may not be in cc-connect fixture, so set manually
    registry.upsert(CC_UUID, {
      origin: 'cc-connect',
      source: 'feishu:oc_chat1:ou_user1',
      cc_connect_session_id: 's1',
    });

    // Now JSONL scanner runs
    const scanner = new JSONLScanner(registry, uuids, new Map(), join(tmpDir, '.claude'));
    scanner.scan();

    // cc-connect session should retain its source from cc-connect scanner
    const entry = registry.get(CC_UUID);
    expect(entry?.source).toBe('feishu:oc_chat1:ou_user1');
    expect(entry?.origin).toBe('cc-connect');
  });

  it('sets source to "terminal" for new CLI sessions', () => {
    const scanner = new JSONLScanner(registry, new Set(), new Map(), join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(CLI_UUID);
    expect(entry?.source).toBe('terminal');
    expect(entry?.origin).toBe('cli');
  });

  it('does not overwrite source when cc-connect session gets JSONL metadata', () => {
    // First: cc-connect scanner registers the session
    registry.upsert(CC_UUID, {
      origin: 'cc-connect',
      source: 'feishu:oc_chat1:ou_user1',
      cc_connect_session_id: 's1',
    });

    // JSONL scanner discovers the file and adds metadata
    const scanner = new JSONLScanner(
      registry,
      new Set([CC_UUID]),
      new Map(),
      join(tmpDir, '.claude')
    );
    scanner.scan();

    const entry = registry.get(CC_UUID);
    // source should NOT be overwritten to 'terminal'
    expect(entry?.source).toBe('feishu:oc_chat1:ou_user1');
    // Other metadata should be updated
    expect(entry?.title).toBe('Feishu Session');
    expect(entry?.cwd).toBe('/Users/test/project');
  });
});

describe('JSONLScanner - created_at and project_dir extraction', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-meta-test-'));
    registry = new RegistryManager(tmpDir);

    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/project', sessionId: 'meta-test-1234', timestamp: '2026-06-01T08:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' }, uuid: 'u1', timestamp: '2026-06-01T08:01:00Z', sessionId: 'meta-test-1234' }),
    ].join('\n');
    writeFileSync(join(projectDir, 'meta-test-1234.jsonl'), jsonl);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts created_at from earliest timestamp', () => {
    const scanner = new JSONLScanner(registry, new Set(), new Map(), join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get('meta-test-1234');
    expect(entry?.created_at).toBeDefined();
    expect(entry?.created_at).toBe('2026-06-01T08:00:00Z');
  });

  it('extracts project_dir from JSONL path', () => {
    const scanner = new JSONLScanner(registry, new Set(), new Map(), join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get('meta-test-1234');
    expect(entry?.project_dir).toBe('-Users-test-project');
  });
});

describe('JSONLScanner - origin detection', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  const SDK_UUID = 'sdk-session-1234-5678-9abc-def012345678';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-origin-test-'));
    registry = new RegistryManager(tmpDir);

    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    // JSONL with sdk-cli entrypoint
    const sdkJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli', cwd: '/Users/test/sdk', sessionId: SDK_UUID, timestamp: '2026-05-03T09:00:00Z' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'SDK Session', sessionId: SDK_UUID }),
    ].join('\n');
    writeFileSync(join(projectDir, `${SDK_UUID}.jsonl`), sdkJsonl);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects cc-connect origin from entrypoint=sdk-cli', () => {
    const scanner = new JSONLScanner(registry, new Set(), new Map(), join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(SDK_UUID);
    expect(entry?.origin).toBe('cc-connect');
  });

  it('detects cc-connect origin from ccConnectUuids even without entrypoint', () => {
    // Create a session without entrypoint but in ccConnectUuids
    const uuidNoEntrypoint = 'noentry-1234-5678-9abc-def012345678';
    const noEntryJsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' }, uuid: 'u1', timestamp: '2026-05-03T09:01:00Z', sessionId: uuidNoEntrypoint }),
    ].join('\n');
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    writeFileSync(join(projectDir, `${uuidNoEntrypoint}.jsonl`), noEntryJsonl);

    const scanner = new JSONLScanner(
      registry,
      new Set([uuidNoEntrypoint]),
      new Map(),
      join(tmpDir, '.claude')
    );
    scanner.scan();

    const entry = registry.get(uuidNoEntrypoint);
    expect(entry?.origin).toBe('cc-connect');
  });
});