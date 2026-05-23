import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';
import { resume } from '../../../src/cli/commands/resume';
import { StateCoordinator } from '../../../src/runtime/state-coordinator';

describe('resume command', () => {
  let tmpDir: string;
  let registry: RegistryManager;
  let originalAssertNotRunning: typeof StateCoordinator.assertNotRunning;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'resume-test-'));
    registry = new RegistryManager(tmpDir);
    // Mock assertNotRunning to avoid interference from real owner.lock
    originalAssertNotRunning = StateCoordinator.assertNotRunning;
    StateCoordinator.assertNotRunning = () => {};
  });

  afterEach(() => {
    StateCoordinator.assertNotRunning = originalAssertNotRunning;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('repairs degraded sessions with an existing jsonl_path before resuming', async () => {
    const cwd = join(tmpDir, 'project');
    mkdirSync(cwd, { recursive: true });
    const jsonlPath = join(tmpDir, 'session.jsonl');
    writeFileSync(jsonlPath, '{}\n');

    registry.upsert('session-uuid-1', {
      origin: 'feishu',
      cwd,
      title: 'Recovered Session',
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      message_count: 1,
      last_message_preview: 'hello',
      jsonl_path: jsonlPath,
      status: 'degraded',
      last_error: 'transient error',
    });
    await registry.flush();

    await resume(registry, 'session-uuid-1', { dryRun: true, confirm: false, force: true });

    const entry = registry.get('session-uuid-1');
    expect(entry?.status).toBe('active');
    expect(entry?.last_error).toBeNull();
    expect(entry?.jsonl_path).toBe(jsonlPath);
  });
});
