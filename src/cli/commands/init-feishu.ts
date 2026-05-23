import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG_PATH, RUNTIME_PID_FILE } from '../../utils/paths';
import { parse } from '@iarna/toml';
import { homedir, platform } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const IS_MACOS = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

function getMacOSPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.ccbridge.daemon.plist');
}

function getLinuxServicePath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'cc-bridge.service');
}

/** Check if daemon is currently running */
export function isDaemonRunning(): boolean {
  if (!existsSync(RUNTIME_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if auto-start is configured */
function hasAutoStartConfig(): boolean {
  if (IS_MACOS) return existsSync(getMacOSPlistPath());
  if (IS_LINUX) return existsSync(getLinuxServicePath());
  return false;
}

/** Temporarily disable auto-start to prevent immediate restart */
function disableAutoStartTemporarily(): void {
  if (IS_MACOS) {
    const plistPath = getMacOSPlistPath();
    if (existsSync(plistPath)) {
      spawnSync('launchctl', ['unload', plistPath]);
    }
  } else if (IS_LINUX) {
    spawnSync('systemctl', ['--user', 'stop', 'cc-bridge.service']);
  }
}

export async function getTenantToken(appId: string, appSecret: string): Promise<string | null> {
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await resp.json() as any;
    return data.code === 0 ? data.tenant_access_token : null;
  } catch {
    return null;
  }
}

export async function getBotName(token: string): Promise<string | null> {
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    return data.bot?.app_name ?? null;
  } catch {
    return null;
  }
}

export async function captureOpenId(appId: string, appSecret: string): Promise<string | null> {
  const Lark = await import('@larksuiteoapi/node-sdk');
  const { WSClient, EventDispatcher, Domain, LoggerLevel } = Lark;

  return new Promise((resolve) => {
    let settled = false;
    let wsClient: any = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (id: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (wsClient && typeof wsClient.close === 'function') {
        try { wsClient.close(); } catch {}
      }
      resolve(id);
    };

    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const openId = data?.sender?.sender_id?.open_id;
        if (openId) settle(openId);
      },
    });

    wsClient = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
      autoReconnect: false,
      onReady: () => {
        console.log(chalk.green('  ✅ WebSocket 已连接，等待消息...'));
      },
      onError: (err: Error) => {
        console.log(chalk.red(`  ❌ 连接失败: ${err.message}`));
        settle(null);
      },
    });

    wsClient.start({ eventDispatcher });

    // Timeout after 120s
    timer = setTimeout(() => {
      console.log(chalk.yellow('  ⏰ 超时'));
      settle(null);
    }, 120_000);
  });
}

export function loadExistingConfig(): Record<string, any> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}

function formatTomlValue(v: any): string {
  if (Array.isArray(v)) {
    return `[${v.map(item => JSON.stringify(item)).join(', ')}]`;
  }
  if (typeof v === 'object' && v !== null) {
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

export function saveConfig(config: Record<string, any>): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });

  const lines: string[] = [];

  // Write known sections in order
  for (const section of ['general', 'feishu_bot', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
    const values = config[section];
    if (!values || typeof values !== 'object') continue;
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
    lines.push('');
    delete config[section]; // Mark as written
  }

  // Write any remaining sections
  for (const [section, values] of Object.entries(config)) {
    if (typeof values !== 'object' || values === null) continue;
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
    lines.push('');
  }

  writeFileSync(CONFIG_PATH, lines.join('\n'), { mode: 0o600 });
}

export async function initFeishu(): Promise<void> {
  console.log(chalk.blue('=== cc-bridge 飞书配置向导 ===\n'));

  // Check if daemon is already running
  let skipCapture = false;
  if (isDaemonRunning()) {
    console.log(chalk.yellow('⚠️ 检测到 Bot 服务正在后台运行'));
    console.log(chalk.gray('   飞书 WebSocket 同一 App ID 只能有一个连接在线，'));
    console.log(chalk.gray('   同时运行将导致消息捕获失败。\n'));

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

    if (action === 'cancel') {
      console.log(chalk.gray('已取消'));
      process.exit(0);
    } else if (action === 'stop') {
      // If auto-start is configured, disable it first to prevent launchd/systemd
      // from immediately restarting the daemon after we stop it
      if (hasAutoStartConfig()) {
        console.log(chalk.gray('   临时禁用开机自启（防止自动重启）...'));
        disableAutoStartTemporarily();
      }

      const { stop } = await import('./start');
      await stop();

      // Wait for Feishu server to detect connection loss and release the slot
      console.log(chalk.gray('   等待飞书服务端释放连接...'));
      await new Promise(r => setTimeout(r, 3000));

      console.log(chalk.green('✅ 已停止现有服务\n'));
    } else {
      skipCapture = true;
    }
  }

  const existing = loadExistingConfig();
  const feishu = existing.feishu_bot ?? {};

  // Step 1: Get app_id
  const { appId } = await inquirer.prompt([{
    type: 'input',
    name: 'appId',
    message: '飞书 App ID:',
    default: feishu.app_id || undefined,
    validate: (v: string) => v.trim() ? true : 'App ID 不能为空',
  }]);

  // Step 2: Get app_secret
  const { appSecret } = await inquirer.prompt([{
    type: 'input',
    name: 'appSecret',
    message: '飞书 App Secret:',
    default: feishu.app_secret || undefined,
    validate: (v: string) => v.trim() ? true : 'App Secret 不能为空',
  }]);

  // Step 3: Verify credentials and get bot name
  console.log(chalk.gray('\n验证凭据...'));
  const token = await getTenantToken(appId.trim(), appSecret.trim());
  if (!token) {
    console.log(chalk.red('❌ 凭据无效，请检查 App ID 和 App Secret'));
    process.exit(1);
  }
  console.log(chalk.green('✅ 凭据有效'));

  const botName = await getBotName(token);
  if (botName) {
    console.log(chalk.green(`✅ Bot 名称: ${botName}`));
  }

  // Step 4: Capture or input open_id
  let openId: string | null = null;

  if (skipCapture) {
    const { manualId } = await inquirer.prompt([{
      type: 'input',
      name: 'manualId',
      message: '请输入 owner_open_id（在飞书发送 /bridge whoami 可获取）:',
      default: feishu.owner_open_id || undefined,
      validate: (v: string) => v.trim() ? true : 'open_id 不能为空',
    }]);
    openId = manualId.trim();
    console.log(chalk.green(`✅ 使用手动输入的 open_id: ${openId}`));
  } else {
    console.log(chalk.cyan('\n请在飞书中给 Bot 发一条任意消息...'));
    console.log(chalk.gray('（等待最多 120 秒）'));

    openId = await captureOpenId(appId.trim(), appSecret.trim());

    if (!openId) {
      console.log(chalk.yellow('\n⚠️ 未获取到 open_id'));
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: '是否跳过 owner_open_id 配置？（跳过后任何人都能使用此 Bot）',
        default: false,
      }]);

      if (!proceed) {
        console.log(chalk.gray('已取消'));
        process.exit(0);
      }
    } else {
      console.log(chalk.green(`\n✅ 获取到 open_id: ${openId}`));
    }
  }

  // Step 5: Optional default_cwd
  const { defaultCwd } = await inquirer.prompt([{
    type: 'input',
    name: 'defaultCwd',
    message: '默认工作目录（/bridge new 未指定路径时使用）:',
    default: feishu.default_cwd || '~/Git/cc-bridge',
  }]);

  // Step 6: Save config
  existing.feishu_bot = {
    app_id: appId.trim(),
    app_secret: appSecret.trim(),
    ...(openId ? { owner_open_id: openId } : {}),
    ...(defaultCwd.trim() ? { default_cwd: defaultCwd.trim() } : {}),
  };

  if (!existing.general) {
    existing.general = { log_level: 'info' };
  }

  saveConfig(existing);

  console.log(chalk.green(`\n✅ 配置已保存到 ${CONFIG_PATH}`));
  console.log(chalk.cyan('\n配置内容:'));
  console.log(chalk.gray(`  app_id:          ${appId.trim()}`));
  console.log(chalk.gray(`  app_secret:      ${appSecret.trim().slice(0, 4)}****`));
  if (openId) {
    console.log(chalk.gray(`  owner_open_id:   ${openId}`));
  }
  if (defaultCwd.trim()) {
    console.log(chalk.gray(`  default_cwd:     ${defaultCwd.trim()}`));
  }

  // Step 7: Ask to start bot
  const { startNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'startNow',
    message: '是否现在启动 Bot 服务？',
    default: true,
  }]);

  let botStarted = false;

  if (startNow) {
    console.log(chalk.cyan('\n启动 Bot 服务...'));

    // Find the cc-bridge executable
    let exePath = 'cc-bridge';
    const argv0 = process.argv[0];

    // If compiled binary, argv[0] is the binary
    if (argv0.endsWith('cc-bridge')) {
      exePath = argv0;
    } else {
      // Development (bun run): check dist/cc-bridge relative to CWD
      const distPath = join(process.cwd(), 'dist', 'cc-bridge');
      if (existsSync(distPath)) exePath = distPath;
    }

    const result = spawnSync(exePath, ['start', '--daemon'], {
      stdio: 'inherit',
    });
    if (result.status === 0) {
      botStarted = true;
      console.log(chalk.gray('运行 cc-link list 可查看会话'));
    } else {
      console.log(chalk.yellow('⚠️ 自动启动失败，请手动执行: cc-link start --daemon'));
    }
  }

  // Step 8: Ask to configure auto-start
  const { autoStart } = await inquirer.prompt([{
    type: 'confirm',
    name: 'autoStart',
    message: '是否配置开机自动启动？',
    default: true,
  }]);

  if (autoStart) {
    console.log(chalk.cyan('\n配置开机自启...'));
    const { installDaemon } = await import('./daemon');
    await installDaemon();
  }

  // Step 9: Summary
  console.log(chalk.green('\n=== 配置完成 ===\n'));
  console.log(chalk.gray(`  Bot 运行:    ${botStarted ? '已启动' : '未启动'}`));
  console.log(chalk.gray(`  开机自启:    ${autoStart ? '已配置' : '未配置'}`));

  console.log(chalk.cyan('\n常用命令:'));
  console.log(chalk.white('  cc-link list              — 查看会话'));
  console.log(chalk.white('  cc-link daemon status     — 查看服务状态'));
  console.log(chalk.white('  cc-link daemon uninstall  — 移除开机自启'));
  console.log(chalk.white('  cc-link stop              — 停止 Bot 服务'));

  process.exit(0);
}
