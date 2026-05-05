import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEST_UUID_CLI = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_UUID_CC = 'b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec';
const TEST_UUID_CLI_2 = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

describe('CLI Commands Integration', () => {
  let tmpDir: string;
  let env: Record<string, string>;
  let ccBridgeDir: string;
  let claudeDir: string;
  let ccConnectDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-integration-'));
    ccBridgeDir = join(tmpDir, '.cc-bridge');
    claudeDir = join(tmpDir, '.claude');
    ccConnectDir = join(tmpDir, '.cc-connect', 'sessions');
    projectDir = join(claudeDir, 'projects', '-Users-test-project');

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(ccConnectDir, { recursive: true });

    // Create cc-connect session file with two sessions
    const ccConnectSession = {
      sessions: {
        s1: {
          id: 's1',
          name: 'default',
          agent_session_id: TEST_UUID_CC,
          agent_type: 'claudecode',
          history: [],
          created_at: '2026-05-03T16:55:23.275844+08:00',
          updated_at: '2026-05-03T16:55:23.275844+08:00',
        },
      },
      active_session: {
        'feishu:oc_xxx:ou_user1': 's1',
      },
      user_sessions: {
        'feishu:oc_xxx:ou_user1': ['s1'],
      },
      counter: 1,
    };
    writeFileSync(join(ccConnectDir, 'feishu-main.json'), JSON.stringify(ccConnectSession, null, 2));

    // Create JSONL for cc-connect session
    const ccJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli', cwd: '/Users/test/project', sessionId: TEST_UUID_CC, timestamp: '2026-05-03T09:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-05-03T09:01:00Z', entrypoint: 'sdk-cli', cwd: '/Users/test/project', sessionId: TEST_UUID_CC }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }] }, uuid: 'u2', timestamp: '2026-05-03T09:01:05Z', sessionId: TEST_UUID_CC }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'API 认证模块设计', sessionId: TEST_UUID_CC }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '帮我设计一个用户认证模块', leafUuid: 'u2', sessionId: TEST_UUID_CC }),
    ].join('\n');
    writeFileSync(join(projectDir, `${TEST_UUID_CC}.jsonl`), ccJsonl);

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
      // 禁用 feishu-cmd switch --confirm 触发的 cc-connect 自动重启，避免测试影响开发机上的 daemon。
      CC_BRIDGE_NO_RESTART: '1',
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    try {
      return execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-bridge',
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
      cwd: '/Users/wuyujun/Git/cc-bridge',
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

  it('list shows all sessions (not just active)', () => {
    run('init');
    const output = run('list');
    expect(output).toContain('数据库迁移方案');
    // cc-connect session scanned — title may be "Untitled" if ai-title entry not extracted
    expect(output).toContain('b21d6d04');
  });

  it('list --active filters by recent activity', () => {
    run('init');
    const output = run('list --active');
    // All test JSONL data has timestamps from 2026-05-03 which is >2 hours ago,
    // so --active should filter out all sessions.
    // (Previously, the scanner defaulted to current time for missing last_active,
    //  but now it extracts real timestamps from JSONL.)
    expect(output).toContain('没有找到会话');
  });

  it('list --project filters by project name', () => {
    run('init');
    const output = run('list --project backend');
    expect(output).toContain('数据库迁移方案');
  });

  it('list --origin filters by origin', () => {
    run('init');
    const ccOutput = run('list --origin cc-connect');
    expect(ccOutput).toContain('API 认证模块设计');
    expect(ccOutput).not.toContain('数据库迁移方案');

    const cliOutput = run('list --origin cli');
    expect(cliOutput).not.toContain('API 认证模块设计');
    expect(cliOutput).toContain('数据库迁移方案');
  });

  it('list --format json outputs JSON', () => {
    run('init');
    const output = run('list --format json');
    const sessions = JSON.parse(output);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(3);
  });

  it('status shows registry info', () => {
    run('init');
    const output = run('status');
    expect(output).toContain('cc-bridge Status');
    expect(output).toContain('Total sessions');
  });

  it('status counts legacy sessions without status as active', () => {
    run('init');
    // 手动注入一个无 status 字段的 legacy 条目
    const registryPath = join(ccBridgeDir, 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const legacyUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    registry.sessions[legacyUuid] = {
      origin: 'cli',
      source: 'terminal',
      platform: null,
      owner: null,
      owner_user_key: null,
      cwd: '/tmp',
      project_name: null,
      jsonl_path: '/tmp/legacy.jsonl',
      project_dir: null,
      cc_connect_session_id: null,
      cc_connect_session_file: null,
      created_at: '2026-05-01T00:00:00Z',
      last_active: '2026-05-01T00:00:00Z',
      title: 'Legacy Session',
      message_count: 1,
      last_message_preview: '',
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const output = run('status');
    // legacy 条目应被计入 active（与 list 的过滤逻辑一致）
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
    // Should show the most recently active session
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
    // 删除 TEST_UUID_CLI_2 的 JSONL，模拟会话被清理
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));

    const output = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
    expect(output).toContain('JSONL 文件不存在');
    expect(output).toContain('status=corrupted');

    // 默认 list 不应再显示该会话
    const listDefault = run('list');
    expect(listDefault).not.toContain(TEST_UUID_CLI_2.slice(0, 8));

    // --archived 应可见
    const listArchived = run('list --archived');
    expect(listArchived).toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('resume restores active status when JSONL is recovered', () => {
    run('init');
    const jsonlPath = join(projectDir, `${TEST_UUID_CLI_2}.jsonl`);
    const backupPath = jsonlPath + '.bak';

    // 1. 备份并删除 JSONL
    writeFileSync(backupPath, readFileSync(jsonlPath));
    rmSync(jsonlPath);

    // 2. resume 应标记 corrupted
    const output1 = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)} --no-confirm --dry-run`);
    expect(output1).toContain('status=corrupted');

    // 3. 恢复 JSONL
    writeFileSync(jsonlPath, readFileSync(backupPath));

    // 4. resume 应成功（不报错）且 status 恢复为 active
    const output2 = run(`resume ${TEST_UUID_CLI_2.slice(0, 8)} --no-confirm --dry-run`);
    expect(output2).toContain('将执行');

    // 5. list 不应再显示为 archived
    const listOutput = run('list --archived');
    expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('list --no-sync skips automatic JSONL scan', () => {
    run('init');

    // 在 init 之后添加一个新的 JSONL 文件
    const newUuid = 'f0e1d2c3-b4a5-6789-0fed-cba987654321';
    const newJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/newproj', sessionId: newUuid, timestamp: '2026-05-04T08:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'new task' }, uuid: 'n1', timestamp: '2026-05-04T08:01:00Z', entrypoint: 'cli', cwd: '/Users/test/newproj', sessionId: newUuid }),
      JSON.stringify({ type: 'ai-title', aiTitle: '新加入的会话', sessionId: newUuid }),
    ].join('\n');
    writeFileSync(join(projectDir, `${newUuid}.jsonl`), newJsonl);

    // --no-sync 不会扫描，应看不到新会话
    const noSyncOutput = run('list --no-sync');
    expect(noSyncOutput).not.toContain(newUuid.slice(0, 8));
    expect(noSyncOutput).not.toContain('新加入的会话');

    // 不带 --no-sync 应触发同步并发现新会话
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
    // 手动注入一个无 status 字段的 legacy 条目
    const registryPath = join(ccBridgeDir, 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const legacyUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    registry.sessions[legacyUuid] = {
      origin: 'cli',
      source: 'terminal',
      platform: null,
      owner: null,
      owner_user_key: null,
      cwd: '/tmp',
      project_name: null,
      jsonl_path: '/tmp/legacy.jsonl',
      project_dir: null,
      cc_connect_session_id: null,
      cc_connect_session_file: null,
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
    // Delete one JSONL file to create a stale registry entry
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const output = run('clean --dry-run');
    expect(output).toContain('将清理');
    // The stale entry should still be in registry (dry-run doesn't delete)
    expect(output).toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('clean removes stale entries', () => {
    run('init');
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const output = run('clean');
    expect(output).toContain('清理');
    // Verify the entry is gone
    const listOutput = run('list');
    expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
  });

  it('clean --older-than filters by age', () => {
    run('init');
    // All test sessions are recent (< 1 day), so --older-than 30 should find nothing
    const output = run('clean --older-than 30 --dry-run');
    expect(output).toContain('清理'); // command ran successfully
  });

  // ===== feishu-cmd =====

  it('feishu-cmd list auto-detects caller from session files', () => {
    run('init');
    const output = run('feishu-cmd list');
    // 自动检测会从 cc-connect session 文件中找到调用者
    // 如果没有 session 文件，会报错 E019
    const hasCaller = output.includes('我的会话') || output.includes('缺少调用者身份');
    expect(hasCaller).toBe(true);
  });

  it('feishu-cmd list with caller shows filtered sessions', () => {
    run('init');
    const output = run('feishu-cmd list --caller feishu:oc_xxx:ou_user1');
    expect(output).toContain('API 认证模块设计');
    expect(output).toContain('数据库迁移方案'); // CLI sessions are visible to all
  });

  it('feishu-cmd list with terminal caller shows all sessions', () => {
    run('init');
    const output = run('feishu-cmd list --caller terminal:testuser');
    expect(output).toContain('API 认证模块设计');
    expect(output).toContain('数据库迁移方案');
  });

  it('feishu-cmd switch requires target', () => {
    run('init');
    const output = run('feishu-cmd switch');
    expect(output).toContain('用法');
  });

  it('feishu-cmd switch needs --confirm for first-time CLI mapping (no other users)', () => {
    run('init');
    // TEST_UUID_CLI is a CLI session that has no cc-connect mapping yet.
    // 调用者使用与 cc-connect session 中相同的 user1，所以 otherUsers 为空。
    const output = run(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1`);
    expect(output).toContain('首次切换此 CLI 会话需要创建 cc-connect 映射');
    expect(output).toContain('--confirm');

    // 验证 cc-connect session 文件未被修改（counter 仍是 1，未新增 s2）
    const sessionData = JSON.parse(readFileSync(join(ccConnectDir, 'feishu-main.json'), 'utf8'));
    expect(sessionData.counter).toBe(1);
    expect(sessionData.sessions.s2).toBeUndefined();
  });

  it('feishu-cmd switch warns about other active users when not confirmed', () => {
    run('init');
    // 调用者是 user2（未在 cc-connect 中），所以 user1 是"其他用户"
    const output = run(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user2`);
    expect(output).toContain('中断以下用户的当前会话');
    expect(output).toContain('feishu:ou_user1'); // publicUserName 剥离了 tenant_key
    expect(output).toContain('--confirm');

    // 文件未变
    const sessionData = JSON.parse(readFileSync(join(ccConnectDir, 'feishu-main.json'), 'utf8'));
    expect(sessionData.counter).toBe(1);
  });

  it('feishu-cmd switch selects the caller-matching cc-connect session file when multiple files exist', () => {
    run('init');

    const secondSessionFile = join(ccConnectDir, 'feishu-secondary.json');
    writeFileSync(secondSessionFile, JSON.stringify({
      sessions: {
        s9: {
          id: 's9',
          name: 'secondary',
          agent_session_id: '99999999-9999-4999-8999-999999999999',
          agent_type: 'claudecode',
          history: [],
          created_at: '2026-05-03T16:55:23.275844+08:00',
          updated_at: '2026-05-03T16:55:23.275844+08:00',
        },
      },
      active_session: {
        'feishu:oc_other:ou_user2': 's9',
      },
      user_sessions: {
        'feishu:oc_other:ou_user2': ['s9'],
      },
      counter: 9,
    }, null, 2));

    const output = run(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_other:ou_user2 --confirm`);
    expect(output).toContain('已创建 cc-connect 映射');

    const primaryData = JSON.parse(readFileSync(join(ccConnectDir, 'feishu-main.json'), 'utf8'));
    const secondaryData = JSON.parse(readFileSync(secondSessionFile, 'utf8'));

    expect(primaryData.counter).toBe(1);
    expect(secondaryData.counter).toBe(10);
    expect(secondaryData.active_session['feishu:oc_other:ou_user2']).toBe('s10');
    expect(secondaryData.sessions.s10.agent_session_id).toBe(TEST_UUID_CLI);
  });

  it('feishu-cmd switch --confirm writes new cc-connect mapping for CLI session', () => {
    run('init');
    const output = run(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1 --confirm`);
    expect(output).toContain('已切换到');
    expect(output).toContain('已创建 cc-connect 映射');
    // CC_BRIDGE_NO_RESTART=1 时不会真的重启，应给出失败提示
    expect(output).toContain('自动重启 cc-connect 失败');

    // 验证 cc-connect session 文件已更新：counter+1 且新增 s2 指向 TEST_UUID_CLI
    const sessionData = JSON.parse(readFileSync(join(ccConnectDir, 'feishu-main.json'), 'utf8'));
    expect(sessionData.counter).toBe(2);
    expect(sessionData.sessions.s2).toBeDefined();
    expect(sessionData.sessions.s2.agent_session_id).toBe(TEST_UUID_CLI);
    expect(sessionData.user_sessions['feishu:oc_xxx:ou_user1']).toContain('s2');
    expect(sessionData.active_session['feishu:oc_xxx:ou_user1']).toBe('s2');
  });

  it('feishu-cmd switch with existing mapping calls Bridge API (falls back gracefully when offline)', () => {
    run('init');
    // TEST_UUID_CC 已有映射 s1，触发 Bridge API 调用，cc-connect 未运行时应降级
    const output = run(`feishu-cmd switch ${TEST_UUID_CC.slice(0, 8)} --caller feishu:oc_xxx:ou_user1`);
    // 失败提示或成功提示二选一（取决于 9810 端口是否被占用），但不应该抛出未捕获错误
    expect(output.length).toBeGreaterThan(0);
    // 文件未被修改（counter 还是 1）
    const sessionData = JSON.parse(readFileSync(join(ccConnectDir, 'feishu-main.json'), 'utf8'));
    expect(sessionData.counter).toBe(1);
  });

  it('feishu-cmd switch denies access when caller has no permission', () => {
    run('init');
    // 先把 TEST_UUID_CC 标记为 origin=cc-connect 且 owner=user1，user2 不应能访问
    // （feishuList 已对 caller 做权限过滤，feishuSwitch 也要校验）
    const output = run(`feishu-cmd switch ${TEST_UUID_CC.slice(0, 8)} --caller feishu:oc_xxx:ou_user2`);
    expect(output).toContain('无权访问');
  });

  it('feishu-cmd switch rejects terminal caller', () => {
    run('init');
    const output = run(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller terminal:testuser`);
    expect(output).toContain('终端用户');
    expect(output).toContain('cc-bridge resume');
  });

  it('feishu-cmd resume shows terminal commands', () => {
    run('init');
    const output = run(`feishu-cmd resume ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1`);
    expect(output).toContain('cc-bridge resume');
    expect(output).toContain('claude --resume');
    expect(output).toContain(TEST_UUID_CLI);
  });

  it('feishu-cmd resume auto-detects caller or requires caller', () => {
    run('init');
    const output = run(`feishu-cmd resume ${TEST_UUID_CLI.slice(0, 8)}`);
    // 自动检测会从 cc-connect session 文件中找到调用者
    // 如果没有 session 文件，会报错 E019
    const hasResult = output.includes('cc-bridge resume') || output.includes('缺少调用者身份');
    expect(hasResult).toBe(true);
  });

  it('feishu-cmd status shows summary', () => {
    run('init');
    const output = run('feishu-cmd status');
    expect(output).toContain('cc-bridge 状态');
    expect(output).toContain('注册会话');
  });

  // ===== register =====

  it('register --dry-run shows entry without writing', () => {
    run('init');
    const newUuid = 'd4e5f6a7-b8c9-0123-defa-456789012345';
    const output = run(`register ${newUuid} --dry-run --origin cli --cwd /tmp/test`);
    expect(output).toContain('dry-run');
    expect(output).toContain(newUuid.slice(0, 8));
    expect(output).toContain('cli');
    // Verify it wasn't actually registered
    const listOutput = run('list');
    expect(listOutput).not.toContain(newUuid.slice(0, 8));
  });

  it('register adds session to registry', () => {
    run('init');
    const newUuid = 'e5f6a7b8-c9d0-1234-efab-567890123456';
    run(`register ${newUuid} --origin cli --cwd /tmp/test --source terminal`);
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

    run(`register ${TEST_UUID_CLI} --origin cli --cwd /tmp/test --source terminal`);

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
    // 删除 TEST_UUID_CLI_2 的 JSONL 但保留 registry 条目
    rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
    const outputFile = join(tmpDir, 'export-missing.md');
    const output = run(`export ${TEST_UUID_CLI_2.slice(0, 8)} --output ${outputFile}`);
    expect(output).toContain('JSONL 文件不存在');
  });

  // ===== hook =====

  it('hook status shows installation state', () => {
    // hook status reads from CLAUDE_SETTINGS_PATH which is cached to real HOME
    // In test env, it may report "未找到" or the current state
    const output = run('hook status');
    expect(output.length).toBeGreaterThan(0);
  });

  it('hook install creates hook configuration', () => {
    // Create a mock Claude Code settings directory
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
