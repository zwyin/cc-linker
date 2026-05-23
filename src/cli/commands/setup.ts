import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import inquirer from 'inquirer';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { CLAUDE_SETTINGS_PATH } from '../../utils/paths';
import {
  getTenantToken,
  getBotName,
  captureOpenId as captureOpenIdSdk,
  isDaemonRunning,
  loadExistingConfig,
  saveConfig,
} from './init-feishu';

/** Check if Claude Code hook is already installed */
function isHookInstalled(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    if (!Array.isArray(settings.hooks?.SessionStart)) return false;
    return settings.hooks.SessionStart.some((matcher: any) =>
      matcher?.hooks?.some((h: any) => h?.command?.includes('cc-linker'))
    );
  } catch {
    return false;
  }
}

interface SetupOptions {
  skipFeishu?: boolean;
  skipHook?: boolean;
}

/** Result returned by the Feishu wizard for the summary display */
interface FeishuWizardResult {
  configured: boolean;
  appId: string;
  started: boolean;
  autoStart: boolean;
}

export async function setup(registry: RegistryManager, opts: SetupOptions = {}): Promise<void> {
  // Calculate total steps dynamically
  const totalSteps = opts.skipFeishu ? 2 : 3;

  console.log(chalk.blue('═══════════════════════════════════════════'));
  console.log(chalk.blue('  cc-linker 一键配置向导'));
  console.log(chalk.blue('═══════════════════════════════════════════\n'));

  console.log(chalk.gray('本向导将引导你完成以下配置：'));
  console.log(chalk.gray('  1. 初始化会话注册表'));
  console.log(chalk.gray('  2. 安装 Claude Code 自动注册钩子'));
  if (!opts.skipFeishu) {
    console.log(chalk.gray('  3. 配置飞书 Bot（App ID + App Secret + 开机自启）'));
  }
  console.log('');

  // ===== Step 1: Initialize registry =====
  console.log(chalk.cyan(`── Step 1/${totalSteps} ── 初始化会话注册表`));

  const isFresh = Object.keys(registry.sessions).length === 0;
  console.log(chalk.gray(isFresh ? '  创建 registry...' : '  刷新现有 registry...'));

  await syncBeforeCommand(registry, undefined, undefined, false, true);

  const sessionCount = Object.keys(registry.sessions).length;
  console.log(chalk.green(`  ✅ 已注册 ${sessionCount} 个会话`));
  console.log('');

  // ===== Step 2: Install hook =====
  let hookInstalled = false;
  if (!opts.skipHook) {
    console.log(chalk.cyan(`── Step 2/${totalSteps} ── 安装 Claude Code 钩子`));

    if (isHookInstalled()) {
      console.log(chalk.green('  ✅ Hook 已安装，跳过'));
      hookInstalled = true;
    } else {
      console.log(chalk.gray('  安装 SessionStart 钩子...'));
      try {
        const { hookInstall } = await import('./hook');
        hookInstall();
        hookInstalled = true;
      } catch (err) {
        console.log(chalk.red(`  ❌ Hook 安装失败: ${err}`));
        console.log(chalk.yellow('  提示：你可以稍后手动执行 cc-linker hook install'));
      }
    }
    console.log('');
  }

  // ===== Step 3: Feishu Bot setup (optional) =====
  let feishuResult: FeishuWizardResult = { configured: false, appId: '', started: false, autoStart: false };

  if (!opts.skipFeishu) {
    console.log(chalk.cyan(`── Step 3/${totalSteps} ── 配置飞书 Bot`));
    console.log('');

    const existingConfig = loadExistingConfig();
    const existingAppId = existingConfig.feishu_bot?.app_id ?? '';
    const existingAppSecret = existingConfig.feishu_bot?.app_secret ?? '';

    if (existingAppId && existingAppSecret) {
      console.log(chalk.gray('  检测到已有飞书配置:'));
      console.log(chalk.gray(`    App ID: ${existingAppId.slice(0, 6)}****`));

      const { reconfigure } = await inquirer.prompt([{
        type: 'confirm',
        name: 'reconfigure',
        message: '是否重新配置飞书 Bot？',
        default: false,
      }]);

      if (!reconfigure) {
        feishuResult = { configured: true, appId: existingAppId, started: isDaemonRunning(), autoStart: false };
        console.log(chalk.green('  ✅ 使用现有飞书配置'));
      } else {
        feishuResult = await runFeishuWizard();
      }
    } else {
      const { setupFeishu } = await inquirer.prompt([{
        type: 'confirm',
        name: 'setupFeishu',
        message: '是否配置飞书 Bot？（跳过则仅保留终端侧功能）',
        default: true,
      }]);

      if (setupFeishu) {
        feishuResult = await runFeishuWizard();
      } else {
        console.log(chalk.gray('  跳过飞书配置'));
      }
    }
    console.log('');
  }

  // ===== Summary =====
  printSummary(sessionCount, hookInstalled, feishuResult);
}

async function runFeishuWizard(): Promise<FeishuWizardResult> {
  const result: FeishuWizardResult = { configured: false, appId: '', started: false, autoStart: false };

  // Check if daemon is already running
  let skipCapture = false;
  if (isDaemonRunning()) {
    console.log(chalk.yellow('  ⚠️ 检测到 Bot 服务正在后台运行'));
    console.log(chalk.gray('   飞书 WebSocket 同一 App ID 只能有一个连接在线'));
    console.log('');

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '请选择处理方式:',
      choices: [
        { name: '停止现有服务，继续配置（推荐）', value: 'stop' },
        { name: '手动输入 owner_open_id（跳过消息捕获）', value: 'manual' },
        { name: '取消', value: 'cancel' },
      ],
      default: 'stop',
    }]);

    if (action === 'cancel') return result;
    if (action === 'stop') {
      const { stop } = await import('./start');
      await stop();
      console.log(chalk.gray('  等待飞书服务端释放连接...'));
      await new Promise(r => setTimeout(r, 3000));
      console.log(chalk.green('  ✅ 已停止现有服务'));
    } else {
      skipCapture = true;
    }
  }

  // Print permission guide before asking for credentials
  printPermissionGuide();

  // Step 1: Get app_id
  const { appId } = await inquirer.prompt([{
    type: 'input',
    name: 'appId',
    message: '飞书 App ID:',
    validate: (v: string) => v.trim() ? true : 'App ID 不能为空',
  }]);

  // Step 2: Get app_secret
  const { appSecret } = await inquirer.prompt([{
    type: 'input',
    name: 'appSecret',
    message: '飞书 App Secret:',
    validate: (v: string) => v.trim() ? true : 'App Secret 不能为空',
  }]);

  // Step 3: Verify credentials
  console.log(chalk.gray('  验证凭据...'));
  const token = await getTenantToken(appId.trim(), appSecret.trim());
  if (!token) {
    console.log(chalk.red('  ❌ 凭据无效，请检查 App ID 和 App Secret'));
    console.log(chalk.yellow('  请确认：'));
    console.log(chalk.yellow('  1. 飞书开放平台 → 你的应用 → 凭证与基础信息'));
    console.log(chalk.yellow('  2. 确认已开启下方列出的所有必要权限'));
    process.exit(1);
  }

  const botName = await getBotName(token);
  console.log(chalk.green(`  ✅ 凭据有效${botName ? `（Bot: ${botName}）` : ''}`));
  result.appId = appId.trim();

  // Step 4: Capture open_id
  let openId: string | null = null;
  if (skipCapture) {
    const { manualId } = await inquirer.prompt([{
      type: 'input',
      name: 'manualId',
      message: '请输入 owner_open_id（在飞书发送 /whoami 可获取）:',
      validate: (v: string) => v.trim() ? true : 'open_id 不能为空',
    }]);
    openId = manualId.trim();
    console.log(chalk.green(`  ✅ owner_open_id: ${openId}`));
  } else {
    console.log(chalk.cyan('  请在飞书中给 Bot 发一条任意消息...'));
    console.log(chalk.gray('  （等待最多 120 秒）'));

    try {
      openId = await captureOpenIdSdk(appId.trim(), appSecret.trim());
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️ 消息捕获失败: ${err}`));
    }

    if (!openId) {
      console.log(chalk.yellow('  ⚠️ 未获取到 open_id'));
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: '是否跳过 owner_open_id 配置？（跳过后任何人都能使用此 Bot）',
        default: false,
      }]);
      if (!proceed) return result;
    } else {
      console.log(chalk.green(`  ✅ 获取到 open_id: ${openId}`));
    }
  }

  // Step 5: Save config
  const { defaultCwd } = await inquirer.prompt([{
    type: 'input',
    name: 'defaultCwd',
    message: '默认工作目录（/new 未指定路径时使用）:',
    default: process.env.HOME || '~/Git',
  }]);

  const existing = loadExistingConfig();
  existing.feishu_bot = {
    app_id: appId.trim(),
    app_secret: appSecret.trim(),
    ...(openId ? { owner_open_id: openId } : {}),
    ...(defaultCwd.trim() ? { default_cwd: defaultCwd.trim() } : {}),
  };
  if (!existing.general) existing.general = { log_level: 'info' };
  saveConfig(existing);

  console.log(chalk.green('  ✅ 飞书配置已保存'));
  result.configured = true;
  console.log('');

  // Step 6: Start bot
  const { startNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'startNow',
    message: '是否现在启动 Bot 服务？',
    default: true,
  }]);

  if (startNow) {
    console.log(chalk.cyan('  启动 Bot 服务...'));
    const { spawnSync } = await import('child_process');
    const { join } = await import('path');
    const { existsSync } = await import('fs');

    // Detect cc-linker executable (supports compiled binary + dev mode)
    let exePath = 'cc-linker';
    const argv0 = process.argv[0];
    if (argv0.endsWith('cc-linker')) {
      exePath = argv0;
    } else {
      const distPath = join(process.cwd(), 'dist', 'cc-linker');
      if (existsSync(distPath)) exePath = distPath;
    }

    const cmdResult = spawnSync(exePath, ['start', '--daemon'], { stdio: 'inherit' });
    result.started = cmdResult.status === 0;
    if (result.started) {
      console.log(chalk.green('  ✅ Bot 已启动'));
    } else {
      console.log(chalk.yellow('  ⚠️ 自动启动失败，请手动执行: cc-linker start --daemon'));
    }
  }

  // Step 7: Auto-start
  const { autoStart } = await inquirer.prompt([{
    type: 'confirm',
    name: 'autoStart',
    message: '是否配置开机自动启动？',
    default: true,
  }]);

  if (autoStart) {
    console.log(chalk.cyan('  配置开机自启...'));
    const { installDaemon } = await import('./daemon');
    await installDaemon();
    result.autoStart = true;
  }

  console.log('');
  return result;
}

function printPermissionGuide(): void {
  console.log(chalk.yellow('  ═══════════════════════════════════════════'));
  console.log(chalk.yellow('  📋 飞书开放平台权限配置指南'));
  console.log(chalk.yellow('  ═══════════════════════════════════════════'));
  console.log('');
  console.log(chalk.gray('  访问飞书开放平台 https://open.feishu.cn/app → 你的应用'));
  console.log('');
  console.log(chalk.cyan('  必需权限（应用自建）:'));
  console.log(chalk.green('    im:message:readonly        获取与发送单聊、群组消息'));
  console.log(chalk.green('    im:message                 读取、发送、撤回用户消息'));
  console.log(chalk.green('    im:message:send_as_bot     以应用身份发送消息'));
  console.log(chalk.green('    im:chat:readonly           获取群组信息'));
  console.log(chalk.green('    contact:user.base:readonly 获取通讯录用户基本信息'));
  console.log('');
  console.log(chalk.cyan('  必需事件订阅:'));
  console.log(chalk.green('    im.message.receive_v1      接收用户发给 Bot 的消息'));
  console.log(chalk.green('    im.chat.member.bot.added_v1  Bot 被邀请进群时触发（可选）'));
  console.log('');
  console.log(chalk.cyan('  必需配置:'));
  console.log(chalk.green('    ✅ 启用 Bot 能力（应用功能 → 机器人）'));
  console.log(chalk.green('    ✅ 开启 WebSocket 模式（事件订阅 → 配置订阅方式）'));
  console.log(chalk.green('    ✅ 发布应用版本（版本管理与发布 → 创建版本）'));
  console.log('');
  console.log(chalk.gray('  提示: 配置完成后，记得在「版本管理与发布」中'));
  console.log(chalk.gray('  创建并上线一个新版本，否则权限不会生效。'));
  console.log('');
}

function printSummary(sessionCount: number, hookInstalled: boolean, feishu: FeishuWizardResult): void {
  console.log(chalk.green('═══════════════════════════════════════════'));
  console.log(chalk.green('  ✅ 配置完成！'));
  console.log(chalk.green('═══════════════════════════════════════════'));
  console.log('');

  console.log(chalk.gray(`  会话注册表:  ✅ 已初始化 (${sessionCount} 个会话)`));
  console.log(chalk.gray(`  Claude Code 钩子: ${hookInstalled ? '✅ 已安装' : '⏸️  未安装'}`));

  if (feishu.configured) {
    console.log(chalk.gray(`  飞书 Bot:     ✅ 已配置 (App ID: ${feishu.appId.slice(0, 6)}****)`));
    console.log(chalk.gray(`  Bot 运行:     ${feishu.started ? '✅ 运行中' : '⏸️  未启动 (cc-linker start --daemon)'}`));
  } else {
    console.log(chalk.gray('  飞书 Bot:     ⏸️  未配置（终端侧功能已就绪）'));
  }
  console.log('');

  console.log(chalk.cyan('  常用命令:'));
  console.log(chalk.white('    cc-linker list              — 查看会话'));
  console.log(chalk.white('    cc-linker resume <ID>       — 恢复会话到终端'));
  console.log(chalk.white('    cc-linker daemon status     — 查看 Bot 状态'));
  console.log(chalk.white('    cc-linker daemon uninstall  — 移除开机自启'));
  console.log(chalk.white('    cc-linker stop              — 停止 Bot 服务'));
  console.log('');

  if (feishu.configured) {
    console.log(chalk.cyan('  飞书端可用命令:'));
    console.log(chalk.white('    /list                — 列出会话'));
    console.log(chalk.white('    /new [路径] -- 提示  — 创建新会话'));
    console.log(chalk.white('    /switch <序号>       — 切换会话'));
    console.log(chalk.white('    /model               — 管理模型'));
    console.log(chalk.white('    /status              — 查看状态'));
    console.log('');
  }
}
