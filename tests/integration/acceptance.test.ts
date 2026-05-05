import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEST_UUID_CLI = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_UUID_CC = 'b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec';
const TEST_UUID_CLI_2 = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

describe('Acceptance Tests', () => {
  let tmpDir: string;
  let env: Record<string, string>;
  let ccBridgeDir: string;
  let claudeDir: string;
  let ccConnectDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-acceptance-'));
    ccBridgeDir = join(tmpDir, '.cc-bridge');
    claudeDir = join(tmpDir, '.claude');
    ccConnectDir = join(tmpDir, '.cc-connect', 'sessions');
    projectDir = join(claudeDir, 'projects', '-Users-test-project');

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(ccConnectDir, { recursive: true });

    // Create cc-connect session file
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

    // Create JSONL for second CLI session
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
      CC_BRIDGE_NO_RESTART: '1',
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): { stdout: string; exitCode: number } {
    try {
      const stdout = execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-bridge',
        env,
        encoding: 'utf8',
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || err.stderr || err.message, exitCode: err.status || 1 };
    }
  }

  function runOk(args: string): string {
    const { stdout, exitCode } = run(args);
    expect(exitCode).toBe(0);
    return stdout;
  }

  function runFail(args: string): { stdout: string; exitCode: number } {
    const result = run(args);
    expect(result.exitCode).not.toBe(0);
    return result;
  }

  // ==========================================================================
  // 一、安装验收
  // ==========================================================================

  describe('1. 安装验收', () => {
    it('CLI 帮助信息显示完整', () => {
      const output = runOk('--help');
      expect(output).toContain('cc-bridge');
      expect(output).toContain('init');
      expect(output).toContain('list');
      expect(output).toContain('resume');
      expect(output).toContain('show');
      expect(output).toContain('sync');
      expect(output).toContain('status');
      expect(output).toContain('hook');
      expect(output).toContain('export');
      expect(output).toContain('search');
      expect(output).toContain('clean');
      expect(output).toContain('feishu-cmd');
    });
  });

  // ==========================================================================
  // 二、初始化验收
  // ==========================================================================

  describe('2. 初始化验收', () => {
    it('首次初始化创建 registry 并扫描所有会话', () => {
      const output = runOk('init');
      expect(output).toContain('Created');
      expect(output).toContain('Scanning');
      expect(output).toContain('cc-connect sessions');
      expect(output).toContain('Claude Code sessions');
      expect(output).toContain('Registered');
      expect(existsSync(join(ccBridgeDir, 'registry.json'))).toBe(true);
      expect(existsSync(join(ccBridgeDir, 'backups'))).toBe(true);
    });

    it('P2 修复：首次初始化做全量扫描', () => {
      // 清空缓存，确保首次扫描
      const cachePath = join(ccBridgeDir, 'scan_cache.json');
      mkdirSync(ccBridgeDir, { recursive: true });
      if (existsSync(cachePath)) rmSync(cachePath);

      const output = runOk('init');
      // 应找到所有会话（1 cc-connect + 2 CLI）
      expect(output).toContain('Found 1 cc-connect sessions');
      expect(output).toContain('Found 2 Claude Code sessions');
      expect(output).toContain('Registered 3 sessions total');
    });

    it('重复初始化不丢失数据', () => {
      runOk('init');
      const output = runOk('init');
      expect(output).toContain('Registry exists');
      expect(output).toContain('will refresh');
      // 会话数量应保持一致
      expect(output).toContain('Registered 3 sessions total');
    });

    it('registry.json 格式正确', () => {
      runOk('init');
      const registry = JSON.parse(readFileSync(join(ccBridgeDir, 'registry.json'), 'utf8'));
      expect(registry.version).toBe(1);
      expect(registry.updated_at).toBeDefined();
      expect(registry.sessions).toBeDefined();
      expect(Object.keys(registry.sessions).length).toBe(3);
    });
  });

  // ==========================================================================
  // 三、Hook 验收
  // ==========================================================================

  describe('3. Hook 验收', () => {
    it('安装 Hook 并验证状态', () => {
      const claudeSettingsDir = join(tmpDir, '.claude');
      mkdirSync(claudeSettingsDir, { recursive: true });
      writeFileSync(join(claudeSettingsDir, 'settings.json'), JSON.stringify({}, null, 2));

      const installOutput = runOk('hook install');
      expect(installOutput).toContain('Hook 安装成功');

      const statusOutput = runOk('hook status');
      expect(statusOutput).toContain('已安装');

      const settings = JSON.parse(readFileSync(join(claudeSettingsDir, 'settings.json'), 'utf8'));
      // 新格式：SessionStart 是 matcher 数组
      expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
      const matcher = settings.hooks.SessionStart[0];
      expect(matcher.matcher).toContain('startup');
      expect(matcher.hooks[0].command).toContain('cc-bridge');
    });

    it('卸载 Hook 并验证状态', () => {
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

      const uninstallOutput = runOk('hook uninstall');
      expect(uninstallOutput).toContain('Hook 已卸载');

      const statusOutput = runOk('hook status');
      expect(statusOutput).toContain('未安装');
    });
  });

  // ==========================================================================
  // 四、核心命令验收
  // ==========================================================================

  describe('4. 核心命令验收', () => {
    beforeEach(() => {
      runOk('init');
    });

    // --- list ---

    describe('4.1 list', () => {
      it('默认列表显示所有会话', () => {
        const output = runOk('list');
        expect(output).toContain('API 认证模块设计');
        expect(output).toContain('数据库迁移方案');
        expect(output).toContain('前端组件重构');
      });

      it('--origin cli 只显示终端会话', () => {
        const output = runOk('list --origin cli');
        expect(output).toContain('数据库迁移方案');
        expect(output).toContain('前端组件重构');
        expect(output).not.toContain('API 认证模块设计');
      });

      it('--origin cc-connect 只显示飞书会话', () => {
        const output = runOk('list --origin cc-connect');
        expect(output).toContain('API 认证模块设计');
        expect(output).not.toContain('数据库迁移方案');
      });

      it('--project 按项目过滤', () => {
        const output = runOk('list --project backend');
        expect(output).toContain('数据库迁移方案');
      });

      it('--limit 限制显示数量', () => {
        const output = runOk('list --limit 2');
        const lines = output.split('\n').filter(l => l.includes('│') && !l.includes('─') && !l.includes('Ref'));
        expect(lines.length).toBeLessThanOrEqual(2);
      });

      it('--format json 输出 JSON', () => {
        const output = runOk('list --format json');
        const sessions = JSON.parse(output);
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBe(3);
        expect(sessions[0]).toHaveProperty('ref');
        expect(sessions[0]).toHaveProperty('uuid');
        expect(sessions[0]).toHaveProperty('title');
      });

      it('--format csv 输出 CSV', () => {
        const output = runOk('list --format csv');
        expect(output).toContain('ref,uuid,title,origin');
        const lines = output.split('\n').filter(Boolean);
        expect(lines.length).toBe(4); // header + 3 sessions
      });

      it('--archived 显示归档会话', () => {
        const output = runOk('list --archived');
        // 测试数据中没有归档会话
        expect(output).toContain('没有找到会话');
      });
    });

    // --- show ---

    describe('4.2 show', () => {
      it('显示完整会话信息', () => {
        const output = runOk(`show ${TEST_UUID_CLI.slice(0, 8)}`);
        expect(output).toContain('UUID:');
        expect(output).toContain('标题:');
        expect(output).toContain('来源:');
        expect(output).toContain('项目:');
        expect(output).toContain('工作目录:');
        expect(output).toContain('状态:');
        expect(output).toContain('创建时间:');
        expect(output).toContain('最后活跃:');
        expect(output).toContain('消息数:');
        expect(output).toContain('JSONL 文件:');
        expect(output).toContain('数据库迁移方案');
        expect(output).toContain('终端');
      });

      it('提供恢复命令提示', () => {
        const output = runOk(`show ${TEST_UUID_CLI.slice(0, 8)}`);
        expect(output).toContain('cc-bridge resume');
      });
    });

    // --- resume ---

    describe('4.3 resume', () => {
      it('--dry-run 只显示命令不执行', () => {
        const output = runOk(`resume ${TEST_UUID_CLI.slice(0, 8)} --dry-run`);
        expect(output).toContain('将执行');
        expect(output).toContain('claude --resume');
        expect(output).toContain(TEST_UUID_CLI);
      });

      it('--latest 恢复最近会话', () => {
        const output = runOk('resume --latest --no-confirm --dry-run');
        expect(output).toContain('将执行');
      });

      it('不存在的会话报错 E002', () => {
        const { stdout } = runFail('resume 00000000');
        expect(stdout).toContain('E002');
        expect(stdout).toContain('未找到');
      });
    });

    // --- sync ---

    describe('4.4 sync', () => {
      it('--scan 只扫描不写入', () => {
        const output = runOk('sync --scan');
        expect(output).toContain('Scan complete');
        expect(output).not.toContain('New sessions registered');
      });

      it('--force 全量扫描', () => {
        const output = runOk('sync --force');
        expect(output).toContain('Sync complete');
      });

      it('普通同步更新 registry', () => {
        const output = runOk('sync');
        expect(output).toContain('Sync complete');
      });
    });

    // --- search ---

    describe('4.5 search', () => {
      it('搜索标题', () => {
        const output = runOk('search "数据库"');
        expect(output).toContain('找到');
        expect(output).toContain('数据库迁移方案');
      });

      it('--in-title 只搜索标题', () => {
        const output = runOk('search "数据库" --in-title');
        expect(output).toContain('数据库迁移方案');
      });

      it('无匹配时显示友好提示', () => {
        const output = runOk('search "不存在的关键词xyz"');
        expect(output).toContain('未找到');
      });

      it('P1 修复：--limit 显示总匹配数提示', () => {
        // 添加多个匹配 "test" 的会话
        for (let i = 0; i < 3; i++) {
          const uuid = `e0e0e0e${i}-0000-4000-8000-00000000000${i}`;
          writeFileSync(join(projectDir, `${uuid}.jsonl`), [
            JSON.stringify({ type: 'ai-title', aiTitle: `test session ${i}`, sessionId: uuid }),
          ].join('\n'));
        }
        runOk('sync');

        const output = runOk('search "test" --limit 2');
        expect(output).toContain('找到');
        expect(output).toContain('显示前 2 个');
        expect(output).toContain('--limit');
      });
    });

    // --- export ---

    describe('4.6 export', () => {
      it('导出为 Markdown', () => {
        const outputFile = join(tmpDir, 'export.md');
        runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format markdown --output ${outputFile}`);
        expect(existsSync(outputFile)).toBe(true);
        const content = readFileSync(outputFile, 'utf8');
        expect(content).toContain('# 数据库迁移方案');
        expect(content).toContain('Session:');
        expect(content).toContain('**User**');
        expect(content).toContain('**Assistant**');
      });

      it('导出为 JSON', () => {
        const outputFile = join(tmpDir, 'export.json');
        runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format json --output ${outputFile}`);
        const data = JSON.parse(readFileSync(outputFile, 'utf8'));
        expect(data.session).toContain(TEST_UUID_CLI.slice(0, 8));
        expect(data.title).toContain('数据库迁移方案');
        expect(Array.isArray(data.messages)).toBe(true);
      });

      it('导出为纯文本', () => {
        const outputFile = join(tmpDir, 'export.txt');
        runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format text --output ${outputFile}`);
        const content = readFileSync(outputFile, 'utf8');
        expect(content).toContain('User:');
        expect(content).toContain('Assistant:');
      });

      it('--max-messages 限制消息数', () => {
        const outputFile = join(tmpDir, 'export-limited.json');
        const output = runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format json --output ${outputFile} --max-messages 1`);
        expect(output).toContain('1 条消息');
        const data = JSON.parse(readFileSync(outputFile, 'utf8'));
        expect(data.messages.length).toBe(1);
      });
    });

    // --- clean ---

    describe('4.7 clean', () => {
      it('--dry-run 预览清理', () => {
        rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
        const output = runOk('clean --dry-run');
        expect(output).toContain('将清理');
        expect(output).toContain(TEST_UUID_CLI_2.slice(0, 8));
        expect(output).toContain('dry run');
      });

      it('P3 修复：有 cc-connect 映射的会话不被清理', () => {
        // cc-connect 会话的 JSONL 存在，不应被清理
        const output = runOk('clean --dry-run');
        expect(output).toContain('没有需要清理的会话');
      });

      it('清理 JSONL 不存在且无 cc-connect 映射的会话', () => {
        rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
        const output = runOk('clean');
        expect(output).toContain('已清理');
        // 验证已清理
        const listOutput = runOk('list');
        expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
      });
    });

    // --- status ---

    describe('4.8 status', () => {
      it('显示完整状态信息', () => {
        const output = runOk('status');
        expect(output).toContain('cc-bridge Status');
        expect(output).toContain('Registry:');
        expect(output).toContain('Last modified:');
        expect(output).toContain('Total sessions:');
        expect(output).toContain('From CLI:');
        expect(output).toContain('From cc-connect:');
        expect(output).toContain('Active:');
        expect(output).toContain('Scanners:');
        expect(output).toContain('cc-connect scanner:');
        expect(output).toContain('Claude Code hook:');
      });
    });
  });

  // ==========================================================================
  // 五、飞书集成验收
  // ==========================================================================

  describe('5. 飞书集成验收', () => {
    beforeEach(() => {
      runOk('init');
    });

    it('无 caller 时自动检测或报错 E019', () => {
      const { stdout, exitCode } = run('feishu-cmd list');
      // 自动检测会从 cc-connect session 文件中找到调用者
      // 如果没有 session 文件，会报错 E019
      const hasCaller = stdout.includes('我的会话') || stdout.includes('缺少调用者身份');
      expect(hasCaller).toBe(true);
    });

    it('有 caller 时 list 显示会话列表', () => {
      const output = runOk('feishu-cmd list --caller feishu:oc_xxx:ou_user1');
      expect(output).toContain('我的会话');
      expect(output).toContain('API 认证模块设计');
      expect(output).toContain('数据库迁移方案'); // CLI 会话对所有用户可见
    });

    it('飞书 status 显示状态', () => {
      const output = runOk('feishu-cmd status --caller feishu:oc_xxx:ou_user1');
      expect(output).toContain('cc-bridge 状态');
      expect(output).toContain('注册会话');
    });

    it('飞书 resume 显示恢复命令', () => {
      const output = runOk(`feishu-cmd resume ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1`);
      expect(output).toContain('cc-bridge resume');
      expect(output).toContain('claude --resume');
      expect(output).toContain(TEST_UUID_CLI);
    });

    it('switch 无 --confirm 时要求确认', () => {
      const output = runOk(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1`);
      expect(output).toContain('--confirm');
    });

    it('switch 有 --confirm 时创建映射', () => {
      const output = runOk(`feishu-cmd switch ${TEST_UUID_CLI.slice(0, 8)} --caller feishu:oc_xxx:ou_user1 --confirm`);
      expect(output).toContain('已切换到');
      expect(output).toContain('已创建 cc-connect 映射');
    });

    it('未知子命令报错 E005', () => {
      const { stdout } = runFail('feishu-cmd unknown');
      expect(stdout).toContain('E005');
      expect(stdout).toContain('未知子命令');
    });
  });

  // ==========================================================================
  // 六、错误处理验收
  // ==========================================================================

  describe('6. 错误处理验收', () => {
    beforeEach(() => {
      runOk('init');
    });

    it('resume 不存在的会话报错 E002', () => {
      const { stdout } = runFail('resume 00000000');
      expect(stdout).toContain('E002');
      expect(stdout).toContain('未找到');
    });

    it('show 不存在的会话报错 E002', () => {
      const { stdout } = runFail('show 00000000');
      expect(stdout).toContain('E002');
      expect(stdout).toContain('未找到');
    });

    it('feishu-cmd list 无 caller 自动检测或报错 E019', () => {
      const { stdout, exitCode } = run('feishu-cmd list');
      // 自动检测会从 cc-connect session 文件中找到调用者
      // 如果没有 session 文件，会报错 E019
      const hasCaller = stdout.includes('我的会话') || stdout.includes('缺少调用者身份');
      expect(hasCaller).toBe(true);
    });

    it('feishu-cmd 未知子命令报错 E005', () => {
      const { stdout } = runFail('feishu-cmd unknown');
      expect(stdout).toContain('E005');
    });

    it('search 无匹配时显示友好提示', () => {
      const output = runOk('search "不存在的关键词xyz"');
      expect(output).toContain('未找到');
    });

    it('错误信息包含修复建议', () => {
      const { stdout } = runFail('resume 00000000');
      expect(stdout).toContain('建议');
      expect(stdout).toContain('cc-bridge sync');
    });
  });

  // ==========================================================================
  // 七、性能验收
  // ==========================================================================

  describe('7. 性能验收', () => {
    it('init 全量扫描在 5 秒内完成', () => {
      const start = Date.now();
      runOk('init');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });

    it('list 在 1 秒内完成', () => {
      runOk('init');
      const start = Date.now();
      runOk('list');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it('search 在 1 秒内完成', () => {
      runOk('init');
      const start = Date.now();
      runOk('search "数据库"');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it('status 在 1 秒内完成', () => {
      runOk('init');
      const start = Date.now();
      runOk('status');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ==========================================================================
  // 八、边界情况验收
  // ==========================================================================

  describe('8. 边界情况验收', () => {
    beforeEach(() => {
      runOk('init');
    });

    it('JSONL 文件不存在时 resume 标记为 corrupted', () => {
      rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
      const { stdout } = runFail(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
      expect(stdout).toContain('JSONL 文件不存在');
      expect(stdout).toContain('corrupted');
    });

    it('corrupted 会话不在默认 list 中显示', () => {
      rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
      runFail(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
      const listOutput = runOk('list');
      expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
    });

    it('corrupted 会话在 --archived 中显示', () => {
      rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
      runFail(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
      const listOutput = runOk('list --archived');
      expect(listOutput).toContain(TEST_UUID_CLI_2.slice(0, 8));
    });

    it('JSONL 恢复后 corrupted 状态自动重置', () => {
      const jsonlPath = join(projectDir, `${TEST_UUID_CLI_2}.jsonl`);
      const content = readFileSync(jsonlPath, 'utf8');

      // 删除并标记 corrupted
      rmSync(jsonlPath);
      runFail(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);

      // 恢复文件
      writeFileSync(jsonlPath, content);

      // sync 应恢复 active 状态
      runOk('sync');
      const listOutput = runOk('list');
      expect(listOutput).toContain(TEST_UUID_CLI_2.slice(0, 8));
    });

    it('--no-sync 跳过自动同步', () => {
      // 添加新 JSONL 文件
      const newUuid = 'f0e1d2c3-b4a5-6789-0fed-cba987654321';
      const newJsonl = [
        JSON.stringify({ type: 'ai-title', aiTitle: '新会话', sessionId: newUuid }),
      ].join('\n');
      writeFileSync(join(projectDir, `${newUuid}.jsonl`), newJsonl);

      // --no-sync 不应发现新会话
      const noSyncOutput = runOk('list --no-sync');
      expect(noSyncOutput).not.toContain(newUuid.slice(0, 8));

      // 不带 --no-sync 应发现新会话
      const syncOutput = runOk('list');
      expect(syncOutput).toContain(newUuid.slice(0, 8));
    });
  });
});
