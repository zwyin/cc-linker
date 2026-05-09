import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEST_UUID_CLI = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_UUID_CLI_2 = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

describe('Acceptance Tests', () => {
  let tmpDir: string;
  let env: Record<string, string>;
  let ccBridgeDir: string;
  let claudeDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-acceptance-'));
    ccBridgeDir = join(tmpDir, '.cc-bridge');
    claudeDir = join(tmpDir, '.claude');
    projectDir = join(claudeDir, 'projects', '-Users-test-project');

    mkdirSync(projectDir, { recursive: true });

    const cliJsonl = [
      JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/Users/test/backend', sessionId: TEST_UUID_CLI, timestamp: '2026-05-03T08:00:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '设计数据库 schema' }, uuid: 'u3', timestamp: '2026-05-03T08:01:00Z', entrypoint: 'cli', cwd: '/Users/test/backend', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来设计数据库 schema' }] }, uuid: 'u4', timestamp: '2026-05-03T08:01:05Z', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'ai-title', aiTitle: '数据库迁移方案', sessionId: TEST_UUID_CLI }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '设计数据库 schema', leafUuid: 'u4', sessionId: TEST_UUID_CLI }),
    ].join('\n');
    writeFileSync(join(projectDir, `${TEST_UUID_CLI}.jsonl`), cliJsonl);

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

  function run(args: string): { stdout: string; exitCode: number } {
    try {
      const stdout = execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-bridge/.claude/worktrees/round1-infra',
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
    });
  });

  describe('2. 初始化验收', () => {
    it('首次初始化创建 registry 并扫描所有会话', () => {
      const output = runOk('init');
      expect(output).toContain('Created');
      expect(output).toContain('Scanning');
      expect(output).toContain('Claude Code sessions');
      expect(output).toContain('Registered');
      expect(existsSync(join(ccBridgeDir, 'registry.json'))).toBe(true);
      expect(existsSync(join(ccBridgeDir, 'backups'))).toBe(true);
    });

    it('首次初始化做全量扫描', () => {
      const cachePath = join(ccBridgeDir, 'scan_cache.json');
      mkdirSync(ccBridgeDir, { recursive: true });
      if (existsSync(cachePath)) rmSync(cachePath);

      const output = runOk('init');
      expect(output).toContain('Found 2 Claude Code sessions');
      expect(output).toContain('Registered 2 sessions total');
    });

    it('重复初始化不丢失数据', () => {
      runOk('init');
      const output = runOk('init');
      expect(output).toContain('Registry exists');
      expect(output).toContain('will refresh');
      expect(output).toContain('Registered 2 sessions total');
    });

    it('registry.json 格式正确', () => {
      runOk('init');
      const registry = JSON.parse(readFileSync(join(ccBridgeDir, 'registry.json'), 'utf8'));
      expect(registry.version).toBe(2);
      expect(registry.updated_at).toBeDefined();
      expect(registry.sessions).toBeDefined();
      expect(Object.keys(registry.sessions).length).toBe(2);
    });
  });

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
      expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
    });

    it('卸载 Hook 并验证状态', () => {
      const claudeSettingsDir = join(tmpDir, '.claude');
      mkdirSync(claudeSettingsDir, { recursive: true });
      writeFileSync(join(claudeSettingsDir, 'settings.json'), JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'cc-bridge hook session-start', timeout: 10 }] }],
        },
      }, null, 2));

      const uninstallOutput = runOk('hook uninstall');
      expect(uninstallOutput).toContain('Hook 已卸载');

      const settings = JSON.parse(readFileSync(join(claudeSettingsDir, 'settings.json'), 'utf8'));
      expect(settings.hooks?.SessionStart).toBeUndefined();
    });
  });

  describe('4. 核心命令验收', () => {
    beforeEach(() => { runOk('init'); });

    describe('4.1 list', () => {
      it('默认列表显示所有会话', () => {
        const output = runOk('list');
        expect(output).toContain('数据库迁移方案');
        expect(output).toContain('前端组件重构');
      });

      it('--origin cli 只显示终端会话', () => {
        const output = runOk('list --origin cli');
        expect(output).toContain('数据库迁移方案');
      });

      it('--format json 输出 JSON', () => {
        const output = runOk('list --format json');
        const sessions = JSON.parse(output);
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBe(2);
      });

      it('--format csv 输出 CSV', () => {
        const output = runOk('list --format csv');
        expect(output).toContain('ref,uuid,title,origin');
        const lines = output.split('\n').filter(Boolean);
        expect(lines.length).toBe(3);
      });
    });

    describe('4.2 show', () => {
      it('显示完整会话信息', () => {
        const output = runOk(`show ${TEST_UUID_CLI.slice(0, 8)}`);
        expect(output).toContain('UUID:');
        expect(output).toContain('标题:');
        expect(output).toContain('数据库迁移方案');
        expect(output).toContain('终端');
      });
    });

    describe('4.3 resume', () => {
      it('--dry-run 只显示命令不执行', () => {
        const output = runOk(`resume ${TEST_UUID_CLI.slice(0, 8)} --dry-run`);
        expect(output).toContain('将执行');
        expect(output).toContain('claude --resume');
      });

      it('不存在的会话报错 E002', () => {
        const { stdout } = runFail('resume 00000000');
        expect(stdout).toContain('E002');
        expect(stdout).toContain('未找到');
      });
    });

    describe('4.4 sync', () => {
      it('--scan 只扫描不写入', () => {
        const output = runOk('sync --scan');
        expect(output).toContain('Scan complete');
      });
    });

    describe('4.5 search', () => {
      it('搜索标题', () => {
        const output = runOk('search "数据库"');
        expect(output).toContain('数据库迁移方案');
      });

      it('无匹配时显示友好提示', () => {
        const output = runOk('search "不存在的关键词xyz"');
        expect(output).toContain('未找到');
      });
    });

    describe('4.6 export', () => {
      it('导出为 Markdown', () => {
        const outputFile = join(tmpDir, 'export.md');
        runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format markdown --output ${outputFile}`);
        expect(existsSync(outputFile)).toBe(true);
        const content = readFileSync(outputFile, 'utf8');
        expect(content).toContain('数据库迁移方案');
      });

      it('导出为 JSON', () => {
        const outputFile = join(tmpDir, 'export.json');
        runOk(`export ${TEST_UUID_CLI.slice(0, 8)} --format json --output ${outputFile}`);
        const data = JSON.parse(readFileSync(outputFile, 'utf8'));
        expect(Array.isArray(data.messages)).toBe(true);
      });
    });

    describe('4.7 clean', () => {
      it('--dry-run 预览清理', () => {
        rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
        const output = runOk('clean --dry-run');
        expect(output).toContain('将清理');
      });

      it('清理 JSONL 不存在的会话', () => {
        rmSync(join(projectDir, `${TEST_UUID_CLI_2}.jsonl`));
        runOk('clean');
        const listOutput = runOk('list');
        expect(listOutput).not.toContain(TEST_UUID_CLI_2.slice(0, 8));
      });
    });

    describe('4.8 status', () => {
      it('显示完整状态信息', () => {
        const output = runOk('status');
        expect(output).toContain('cc-bridge Status');
        expect(output).toContain('Total sessions:');
      });
    });
  });

  describe('5. 错误处理验收', () => {
    beforeEach(() => { runOk('init'); });

    it('resume 不存在的会话报错 E002', () => {
      const { stdout } = runFail('resume 00000000');
      expect(stdout).toContain('E002');
      expect(stdout).toContain('未找到');
    });

    it('错误信息包含修复建议', () => {
      const { stdout } = runFail('resume 00000000');
      expect(stdout).toContain('建议');
    });
  });

  describe('6. 性能验收', () => {
    it('init 全量扫描在 5 秒内完成', () => {
      const start = Date.now();
      runOk('init');
      expect(Date.now() - start).toBeLessThan(5000);
    });

    it('list 在 1 秒内完成', () => {
      runOk('init');
      const start = Date.now();
      runOk('list');
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });

  describe('7. 边界情况验收', () => {
    beforeEach(() => { runOk('init'); });

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
      rmSync(jsonlPath);
      runFail(`resume ${TEST_UUID_CLI_2.slice(0, 8)}`);
      writeFileSync(jsonlPath, content);
      runOk('sync');
      const listOutput = runOk('list');
      expect(listOutput).toContain(TEST_UUID_CLI_2.slice(0, 8));
    });

    it('--no-sync 跳过自动同步', () => {
      const newUuid = 'f0e1d2c3-b4a5-6789-0fed-cba987654321';
      writeFileSync(join(projectDir, `${newUuid}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: '新会话', sessionId: newUuid }));
      const noSyncOutput = runOk('list --no-sync');
      expect(noSyncOutput).not.toContain(newUuid.slice(0, 8));
      const syncOutput = runOk('list');
      expect(syncOutput).toContain(newUuid.slice(0, 8));
    });
  });
});
