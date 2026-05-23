#!/usr/bin/env bun
import { Command } from 'commander';
import { RegistryManager } from './registry';
import { syncBeforeCommand } from './scanner';
import { handleError } from './utils/errors';
import { StateCoordinator } from './runtime/state-coordinator';
import { init } from './cli/commands/init';
import { list } from './cli/commands/list';
import { resume } from './cli/commands/resume';
import { show } from './cli/commands/show';
import { sync } from './cli/commands/sync';
import { status } from './cli/commands/status';
import { hookInstall, hookUninstall, hookStatus, hookSessionStart } from './cli/commands/hook';
import { registerSession } from './cli/commands/register';
import { exportSession } from './cli/commands/export';
import { search } from './cli/commands/search';
import { clean } from './cli/commands/clean';
import { start, stop } from './cli/commands/start';
import { initFeishu } from './cli/commands/init-feishu';
import { setup } from './cli/commands/setup';
import { installDaemon, uninstallDaemon, daemonStatus as daemonServiceStatus } from './cli/commands/daemon';

const program = new Command();

program
  .name('cc-linker')
  .description('飞书 ↔ Claude Code CLI 桥接工具')
  .version('0.2.0');

// Helper to run sync before command
async function withSync(fn: (registry: RegistryManager) => Promise<void>, skipSync = false) {
  const registry = new RegistryManager();
  if (!skipSync) {
    await syncBeforeCommand(registry);
  }
  await fn(registry);
}

program
  .command('init')
  .description('初始化 registry 并扫描已有会话')
  .action(() => withSync(async (registry) => {
    await init(registry);
  }, true));

program
  .command('list')
  .description('列出所有可恢复的会话')
  .option('-p, --project <name>', '按项目名过滤')
  .option('-o, --origin <type>', '按来源过滤')
  .option('-a, --active', '只显示最近 2 小时活跃的会话')
  .option('--archived', '显示 archived/corrupted 会话（默认仅显示 active）')
  .option('-f, --format <type>', '输出格式: table/json/csv', 'table')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('-s, --sort <field>', '排序字段', 'last_active')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await list(registry, opts);
  }, !opts.sync));

program
  .command('resume [target]')
  .description('恢复指定会话到 Claude Code CLI')
  .option('-s, --search <query>', '按标题搜索')
  .option('-L, --latest', '恢复最活跃的会话')
  .option('-p, --project <name>', '指定项目')
  .option('-n, --dry-run', '只显示命令，不执行')
  .option('--no-confirm', '跳过 CWD 变更提示')
  .option('--cwd <path>', '手动指定工作目录')
  .option('-f, --force', '跳过 Bot 运行冲突警告')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await resume(registry, target, opts);
  }, !opts.sync));

program
  .command('show <target>')
  .description('查看会话详情')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await show(registry, target);
  }, !opts.sync));

program
  .command('sync')
  .description('手动同步会话')
  .option('--scan', '只扫描，不写入 registry（dry run）')
  .option('--force', '强制刷新')
  .option('--clean', '清理无效记录')
  .action((opts) => withSync(async (registry) => {
    await sync(registry, opts);
  }));

program
  .command('status')
  .description('查看桥接工具状态')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await status(registry);
  }, !opts.sync));

const hookCmd = program.command('hook').description('管理 Claude Code 钩子');
hookCmd.command('install').action(() => hookInstall());
hookCmd.command('uninstall').action(() => hookUninstall());
hookCmd.command('status').action(() => hookStatus());
hookCmd.command('session-start').action(() => hookSessionStart());

program
  .command('register <uuid>')
  .description('注册会话到 registry（内部命令）')
  .option('-o, --origin <type>', '来源', 'cli')
  .option('-c, --cwd <path>', '工作目录')
  .option('-n, --dry-run', '只显示将要注册的条目，不实际写入')
  .action((uuid, opts) => withSync(async (registry) => {
    await registerSession(registry, uuid, opts);
  }, true));

program
  .command('export <target>')
  .description('导出会话为 markdown/text/json')
  .option('-f, --format <type>', '输出格式: markdown/text/json', 'markdown')
  .option('-o, --output <path>', '输出文件')
  .option('--include-thinking', '包含 thinking block')
  .option('--include-tools', '包含工具调用详情')
  .option('--max-messages <n>', '最大消息数')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await exportSession(registry, target, opts);
  }, !opts.sync));

program
  .command('search <query>')
  .description('搜索会话')
  .option('--in-title', '只搜索标题')
  .option('--in-content', '搜索 JSONL 内容（较慢）')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('--no-sync', '跳过自动同步')
  .action((query, opts) => withSync(async (registry) => {
    await search(registry, query, opts);
  }, !opts.sync));

program
  .command('clean')
  .description('清理无效记录')
  .option('--dry-run', '预览')
  .option('--older-than <days>', '清理 N 天前的')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await clean(registry, opts);
  }, !opts.sync));

program
  .command('start')
  .description('启动飞书 Bot 进程')
  .option('-d, --daemon', '后台运行（写入 PID 文件）')
  .action((opts) => withSync(async (registry) => {
    if (!opts.daemon) {
      StateCoordinator.assertNotRunning();
    }
    await start(registry, { daemon: opts.daemon });
  }, true));

program
  .command('stop')
  .description('停止后台运行的 Bot 服务')
  .action(() => stop());

const daemonCmd = program.command('daemon').description('管理后台 Bot 服务（开机自启）');
daemonCmd.command('install').description('配置开机自动启动').action(() => installDaemon());
daemonCmd.command('uninstall').description('移除开机自动启动').action(() => uninstallDaemon());
daemonCmd.command('status').description('查看后台服务状态').action(() => daemonServiceStatus());

program
  .command('setup')
  .description('一键配置向导（初始化 + 安装钩子 + 配置飞书 Bot）')
  .option('--skip-feishu', '跳过飞书 Bot 配置')
  .option('--skip-hook', '跳过 Claude Code 钩子安装')
  .action((opts) => withSync(async (registry) => {
    await setup(registry, opts);
  }, true));

program
  .command('init-feishu')
  .description('交互式配置飞书集成（App ID + App Secret + Owner）')
  .action(() => initFeishu());

// Parse and handle errors
program.parseAsync(process.argv).catch(handleError);
