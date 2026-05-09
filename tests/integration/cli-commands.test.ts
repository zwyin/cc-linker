import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEST_UUID_CLI = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_UUID_CLI_2 = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

describe('CLI Commands Integration', () => {
  let tmpDir: string;
  let env: Record<string, string>;
  let ccBridgeDir: string;
  let claudeDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-integration-'));
    ccBridgeDir = join(tmpDir, '.cc-bridge');
    claudeDir = join(tmpDir, '.claude');
    projectDir = join(claudeDir, 'projects', '-Users-test-project');

    mkdirSync(projectDir, { recursive: true });

    // Create JSONL for CLI session
    const cliJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/backend', sessionId: TEST_UUID_CLI, timestamp: '2026-05-03T08:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '设计数据库 schema' }, uuid: 'u3', timestamp: '2026-05-03T08:01:00Z', entrypoint: 'cli', cwd: '/Users/test/backend', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来设计数据库 schema' }] }, uuid: 'u4', timestamp: '2026-05-03T08:01:05Z', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'ai-title', aiTitle: '数据库迁移方案', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '设计数据库 schema', leafUuid: 'u4', sessionId: TEST_UUID_CLI }),
    ].join('\n');
    writeFileSync(join(projectDir, `${TEST_UUID_CLI}.jsonl`), cliJsonl);

    // Create JSONL for second CLI session (for search/clean tests)
    const cliJsonl2 = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/frontend', sessionId: TEST_UUID_CLI_2, timestamp: '2026-05-03T10:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '重构前端组件' }, uuid: 'u5', timestamp: '2026-05-03T10:01:00Z', entrypoint: 'cli', cwd: '/Users/test/frontend', sessionId: TEST_UUID_CLI_2 }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来重构前端组件' }] }, uuid: 'u6', timestamp: '2026-05-03T10:01:05Z', sessionId: TEST_UUID_CLI_2 }),
      JSON.stringify({ type: 'ai-title', aiTitle: '前端组件重构', sessionId: TEST_UUID_CLI_2 }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '重构前端组件', leafUuid: 'u6', sessionId: TEST_UUID_CLI_2 }),
    ].join('\n');
    writeFileSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`), cliJsonl2);

    env = {
      ...process.env,
      HOME: tmpDir,
      CC_BRIDGE_DIR: ccBridgeDir,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    try {
      return execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-bridge/.claude/worktrees/round1-infra',
        env,
        encoding: 'utf8',
      });
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }

  // ===== 基础命令 =====

  it('init creates registry', () => {
    const output = run('init');
    expect(output).toContain('Created');
    expect(output).toContain('Scanning');
  });

  it('init respects CC_BRIDGE_DIR override', () => {
    const customDir = join(tmpDir, 'custom-registry-dir');
    mkdirSync(customDir, { recursive: true });

    const customEnv = { ...env, CC_BRIDGE_DIR: customDir };
    const output = execSync('bun run src/index.ts init', {
      cwd: '/Users/wuyujun/Git/cc-bridge/.claude/worktrees/round1-infra',
      env: customEnv,
      encoding: 'utf8',
    });

    expect(existsSync(join(customDir, 'registry.json'))).toBe(true);
    expect(output).toContain('Scanning');
  });

  it('init uses general.registry_path from config.toml', () => {
    const customBase = join(tmpDir, 'custom-config-target');
    mkdirSync(customBase, { recursive: true });
    const customRegistryPath = join(customBase, 'nested', 'registry.json');
    mkdirSync(ccBridgeDir, { recursive: true });
    writeFileSync(join(ccBridgeDir, 'config.toml'), `[general]\nregistry_path = "${customRegistryPath}"\n`);

    const output = run('init');

    expect(existsSync(customRegistryPath)).toBe(true);
    expect(output).toContain(customRegistryPath);

    const statusOutput = run('status --no-sync');
    expect(statusOutput).toContain(customRegistryPath);
  });

  it('list shows all sessions', () => {
    run('init');
    const output = run('list');
    expect(output).toContain('数据库迁移方案');
    expect(output).toContain(TEST_UUID_CLI.slice(0, 8));
  });

  it('list --active filters by recent activity', () => {
    run('init');
    const output = run('list --active');
    expect(output).toContain('没有找到会话');
  });

  it('list --project filters by project name', () => {
    run('init');
    const output = run('list --project backend');
    expect(output).toContain('数据库迁移方案');
  });

  it('list --origin filters by origin', () => {
    run('init');
    const cliOutput = run('list --origin cli');
    expect(cliOutput).toContain('数据库迁移方案');
  });

  it('list --format json outputs JSON', () => {
    run('init');
    const output = run('list --format json');
    const sessions = JSON.parse(output);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(2);
  });

  it('status shows registry info', () => {
    run('init');
    const output = run('status');
    expect(output).toContain('cc-bridge Status');
    expect(output).toContain('Total sessions');
  });

  it('status counts legacy sessions without status as active', () => {
    run('init');
    const registryPath = join(ccBridgeDir, 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const legacyUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    registry.sessions[legacyUuid] = {
      origin: 'cli',
      cwd: '/tmp',
      project_name: null,
      jsonl_path: '/tmp/legacy.jsonl',
      project_dir: null,
      created_at: '2026-05-01T00:00:00Z',
      last_active: '2026-05-01T00:00:00Z',
      title: 'Legacy Session',
      message_count: 1,
      last_message_preview: '',
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const output = run('status');
    const activeMatch = output.match(/Active:\s+(\d+)/);
    expect(activeMatch).not.toBeNull();
    expect(parseInt(activeMatch![1], 10)).toBeGreaterThanOrEqual(1);
  });

  it('sync updates registry', () => {
    run('init');
    const output = run('sync');
    expect(output).toContain('Sync complete');
  });

  it('sync --scan does not write to registry', () => {
    run('init');
    const output = run('sync --scan');
    expect(output).toContain('Scan complete');
    expect(output).not.toContain('New sessions registered');
  });

  it('sync --force forces full rescan', () => {
    run('init');
    const output = run('sync --force');
    expect(output).toContain('Sync complete');
  });

  // ===== resume =====

  it('resume --dry-run shows command without executing', () => {
    run('init');
    const output = run(`resume ${TEST_UUID_CLI.slice(0, 8)} --dry-run`);
    expect(output).toContain('将执行');
    expect(output).toContain('claude --resume');
  });

  it('resume --latest recovers the most recent session', () => {
    run('init');
    const output = run('resume --latest --no-confirm --dry-run');
    expect(output).toContain('将执行');
  });

  it('resume --project recovers latest session for a project', () => {
    run('init');
    const output = run('resume --latest --project backend --dry-run');
    expect(output).toContain('claude --resume');
    expect(output).toContain(TEST_UUID_CLI.slice(0, 8));
  });

  it('resume fails when UUID not found', () => {
    run('init');
    const output = run('resume non-existent-uuid');
    expect(output).toContain('未找到');
  });

  it('resume marks session as corrupted when JSONL is missing', () => {
    run('init');
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));

    const output = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
    expect(output).toContain('JSONL 文件不存在');
    expect(output).toContain('status=corrupted');

    const listDefault = run('list');
    expect(listDefault).not.toContain(TEST_UUID_CLI_2.slice(0, 8));

    const listArchived = run('list --archived');
    expect(listArchived).toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('resume restores active status when JSONL is recovered', () => {
    run('init');
    const jsonlPath = join(projectDir, `${TEST_UUID_CLI_2}.jsonl`);
    const backupPath = jsonlPath + '.bak';

    writeFileSync(backupPath, readFileSync(jsonlPath));
    rmSync(jsonlPath);

    const output1 = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)} --no-confirm --dry-run`);
    expect(output1).toContain('status=corrupted');

    writeFileSync(jsonlPath, readFileSync(backupPath));

    const output2 = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)} --no-confirm --dry-run`);
    expect(output2).toContain('将执行');

    const listOutput = run('list --archived');
    expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('list --no-sync skips automatic JSONL scan', () => {
    run('init');

    const newUuid = 'f0e1d2c3-b4a5-6789-0fed-cba987654321';
    const newJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/newproj', sessionId: newUuid, timestamp: '2026-05-04T08:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'new task' }, uuid: 'n1', timestamp: '2026-05-04T08:01:00Z', entrypoint: 'cli', cwd: '/Users/test/newproj', sessionId: newUuid }),
      JSON.stringify({ type: 'ai-title', aiTitle: '新加入的会话', sessionId: newUuid }),
    ].join('\n');
    writeFileSync(join(projectDir, `${newUuid}.jsonl`), newJsonl);

    const noSyncOutput = run('list --no-sync');
    expect(noSyncOutput).not.toContain(newUuid.slice(0, 8));
    expect(noSyncOutput).not.toContain('新加入的会话');

    const syncOutput = run('list');
    expect(syncOutput).toContain(newUuid.slice(0, 8));
    expect(syncOutput).toContain('新加入的会话');
  });

  // ===== show =====

  it('show displays session metadata', () => {
    run('init');
    const output = run(`show ${TEST_UUID_CLI.slice(0, 8)}`);
    expect(output).toContain(TEST_UUID_CLI.slice(0, 8));
    expect(output).toContain('数据库迁移方案');
    expect(output).toContain('JSONL 文件');
    expect(output).toContain('终端');
  });

  it('show fails when UUID not found', () => {
    run('init');
    const output = run('show non-existent-uuid');
    expect(output).toContain('未找到');
  });

  it('show displays active for legacy sessions without status', () => {
    run('init');
    const registryPath = join(ccBridgeDir, 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const legacyUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    registry.sessions[legacyUuid] = {
      origin: 'cli',
      cwd: '/tmp',
      project_name: null,
      jsonl_path: '/tmp/legacy.jsonl',
      project_dir: null,
      created_at: '2026-05-01T00:00:00Z',
      last_active: '2026-05-01T00:00:00Z',
      title: 'Legacy Session',
      message_count: 1,
      last_message_preview: '',
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const output = run(`show ${legacyUuid.slice(0, 8)}`);
    expect(output).toContain('状态:');
    expect(output).not.toContain('undefined');
    expect(output).toContain('active');
  });

  // ===== search =====

  it('search finds sessions by title', () => {
    run('init');
    const output = run('search "数据库"');
    expect(output).toContain('数据库迁移方案');
  });

  it('search --in-title only searches titles', () => {
    run('init');
    const output = run('search "数据库" --in-title');
    expect(output).toContain('数据库迁移方案');
  });

  it('search returns no results for unknown query', () => {
    run('init');
    const output = run('search "xyznonexistent"');
    expect(output).toContain('未找到');
  });

  // ===== clean =====

  it('clean --dry-run shows what would be deleted', () => {
    run('init');
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const output = run('clean --dry-run');
    expect(output).toContain('将清理');
    expect(output).toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('clean removes stale entries', () => {
    run('init');
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const output = run('clean');
    expect(output).toContain('清理');
    const listOutput = run('list');
    expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('clean --older-than filters by age', () => {
    run('init');
    const output = run('clean --older-than 30 --dry-run');
    expect(output).toContain('清理');
  });

  // ===== register =====

  it('register --dry-run shows entry without writing', () => {
    run('init');
    const newUuid = 'd4e5f6a7-b8c9-0123-defa-456789012345';
    const output = run(`register ${newUuid} --dry-run --origin cli --cwd /tmp/test`);
    expect(output).toContain('dry-run');
    expect(output).toContain(newUuid.slice(0, 8));
    expect(output).toContain('cli');
    const listOutput = run('list');
    expect(listOutput).not.toContain(newUuid.slice(0, 8));
  });

  it('register adds session to registry', () => {
    run('init');
    const newUuid = 'e5f6a7b8-c9d0-1234-efab-567890123456';
    run(`register ${newUuid} --origin cli --cwd /tmp/test`);
    const listOutput = run('list');
    expect(listOutput).toContain(newUuid.slice(0, 8));
  });

  it('register refreshes last_active for existing sessions', () => {
    run('init');
    const registryPath = join(ccBridgeDir, 'registry.json');
    const before = JSON.parse(readFileSync(registryPath, 'utf8'));
    const originalLastActive = before.sessions[TEST_UUID_CLI].last_active;

    before.sessions[TEST_UUID_CLI].last_active = '2020-01-01T00:00:00Z';
    writeFileSync(registryPath, JSON.stringify(before, null, 2));

    run(`register ${TEST_UUID_CLI} --origin cli --cwd /tmp/test`);

    const after = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(after.sessions[TEST_UUID_CLI].last_active).not.toBe('2020-01-01T00:00:00Z');
    expect(new Date(after.sessions[TEST_UUID_CLI].last_active).getTime()).toBeGreaterThan(new Date(originalLastActive).getTime());
  });

  it('register fails with invalid UUID', () => {
    run('init');
    const output = run('register not-a-uuid');
    expect(output).toContain('无效的 UUID');
  });

  // ===== export =====

  it('export creates markdown file', () => {
    run('init');
    const outputFile = join(tmpDir, 'export.md');
    const output = run(`export ${TEST_UUID_CLI.slice(0, 8)} --format markdown --output ${outputFile}`);
    expect(output).toContain('导出完成');
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf8');
    expect(content).toContain('数据库迁移方案');
    expect(content).toContain('Session:');
  });

  it('export creates JSON file', () => {
    run('init');
    const outputFile = join(tmpDir, 'export.json');
    const output = run(`export ${TEST_UUID_CLI.slice(0, 8)} --format json --output ${outputFile}`);
    expect(output).toContain('导出完成');
    const data = JSON.parse(readFileSync(outputFile, 'utf8'));
    expect(data.session).toContain(TEST_UUID_CLI.slice(0, 8));
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it('export --max-messages limits output', () => {
    run('init');
    const outputFile = join(tmpDir, 'export-limited.md');
    const output = run(`export ${TEST_UUID_CLI.slice(0, 8)} --output ${outputFile} --max-messages 1`);
    expect(output).toContain('导出完成');
    const content = readFileSync(outputFile, 'utf8');
    expect(content).toContain('Messages:');
  });

  it('export fails gracefully when JSONL is missing', () => {
    run('init');
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const outputFile = join(tmpDir, 'export-missing.md');
    const output = run(`export ${TEST_UUID_CLI_2.slice(0, 8)} --output ${outputFile}`);
    expect(output).toContain('JSONL 文件不存在');
  });

  // ===== hook =====

  it('hook status shows installation state', () => {
    const output = run('hook status');
    expect(output.length).toBeGreaterThan(0);
  });

  it('hook install creates hook configuration', () => {
    const claudeSettingsDir = join(tmpDir, '.claude');
    mkdirSync(claudeSettingsDir, { recursive: true });
    writeFileSync(join(claudeSettingsDir, 'settings.json'), JSON.stringify({}, null, 2));

    const output = run('hook install');
    expect(output).toContain('Hook 安装成功');

    const settings = JSON.parse(readFileSync(join(claudeSettingsDir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it('hook uninstall removes hook configuration', () => {
    const claudeSettingsDir = join(tmpDir, '.claude');
    mkdirSync(claudeSettingsDir, { recursive: true });
    writeFileSync(join(claudeSettingsDir, 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: 'cc-bridge hook session-start', timeout: 10 }],
          },
        ],
      },
    }, null, 2));

    const output = run('hook uninstall');
    expect(output).toContain('Hook 已卸载');

    const settings = JSON.parse(readFileSync(join(claudeSettingsDir, 'settings.json'), 'utf8'));
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });
});
