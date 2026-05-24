import chalk from 'chalk';
import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { RUNTIME_PID_FILE, RUNTIME_LOG_FILE } from '../../utils/paths';
import inquirer from 'inquirer';

const HOME = homedir();
const IS_MACOS = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

/** Get the path to the cc-linker executable */
function getExecutablePath(): string {
  // If running from compiled binary, use that path
  const exe = process.argv[0];
  if (exe.endsWith('cc-linker')) return exe;

  // Try to find in PATH via 'which'
  const whichResult = spawnSync('which', ['cc-linker']);
  if (whichResult.status === 0) {
    const found = whichResult.stdout.toString().trim();
    if (found) return found;
  }

  // Common install paths
  const candidates = [
    join(HOME, '.local', 'bin', 'cc-linker'),
    '/usr/local/bin/cc-linker',
    '/opt/homebrew/bin/cc-linker',
    '/usr/bin/cc-linker',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Final fallback: assume 'cc-linker' is in PATH
  return 'cc-linker';
}

/** macOS: ~/Library/LaunchAgents/ */
function getMacOSPlistPath(): string {
  return join(HOME, 'Library', 'LaunchAgents', 'com.cclinker.daemon.plist');
}

/** Linux: ~/.config/systemd/user/ */
function getLinuxServicePath(): string {
  return join(HOME, '.config', 'systemd', 'user', 'cc-linker.service');
}

/** Generate macOS launchd plist */
function generateMacOSPlist(): string {
  const exe = getExecutablePath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cclinker.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${HOME}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_LINKER_DAEMON</key>
    <string>1</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}</string>
  </dict>
</dict>
</plist>`;
}

/** Generate Linux systemd service file */
function generateLinuxService(): string {
  const exe = getExecutablePath();

  return `[Unit]
Description=cc-linker Feishu Bot Daemon
After=network.target

[Service]
Type=simple
ExecStart=${exe} start
ExecStop=${exe} stop
WorkingDirectory=${HOME}
Restart=always
RestartSec=10
PIDFile=${RUNTIME_PID_FILE}
Environment="CC_LINKER_DAEMON=1"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}"

[Install]
WantedBy=default.target`;
}

export async function installDaemon(): Promise<void> {
  console.log(chalk.blue('=== cc-linker 开机自启配置 ===\n'));

  if (IS_MACOS) {
    await installMacOS();
  } else if (IS_LINUX) {
    await installLinux();
  } else {
    console.log(chalk.red(`❌ 不支持的操作系统: ${platform()}`));
    console.log(chalk.gray('   目前支持 macOS (launchd) 和 Linux (systemd)'));
    process.exit(1);
  }
}

async function installMacOS(): Promise<void> {
  const plistPath = getMacOSPlistPath();
  const plistContent = generateMacOSPlist();

  // Check if already installed
  if (existsSync(plistPath)) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: '已存在 launchd 配置，是否覆盖？',
      default: true,
    }]);
    if (!overwrite) {
      console.log(chalk.gray('已取消'));
      return;
    }

    // Stop any running instance and unload existing config before overwriting
    const exe = getExecutablePath();
    spawnSync(exe, ['stop']);
    spawnSync('launchctl', ['stop', 'com.cclinker.daemon']);
    spawnSync('launchctl', ['unload', plistPath]);
  }

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plistContent, { mode: 0o644 });

  // Load the plist
  const loadResult = spawnSync('launchctl', ['load', plistPath]);
  if (loadResult.status !== 0 && !loadResult.stderr.toString().includes('already loaded')) {
    console.log(chalk.yellow(`⚠️ launchctl load 警告: ${loadResult.stderr.toString().trim()}`));
  }

  // Also start immediately
  const startResult = spawnSync('launchctl', ['start', 'com.cclinker.daemon']);
  if (startResult.status !== 0) {
    const err = startResult.stderr.toString().trim();
    if (err) console.log(chalk.yellow(`⚠️ launchctl start 警告: ${err}`));
  }

  console.log(chalk.green('✅ 开机自启已配置'));
  console.log(chalk.cyan(`   配置: ${plistPath}`));
  console.log(chalk.cyan(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.gray('\n操作:'));
  console.log(chalk.gray(`   停止: launchctl stop com.cclinker.daemon`));
  console.log(chalk.gray(`   卸载: cc-linker daemon uninstall`));
  console.log(chalk.gray(`   状态: cc-linker daemon status`));
}

async function installLinux(): Promise<void> {
  const servicePath = getLinuxServicePath();
  const serviceContent = generateLinuxService();

  // Check if already installed
  if (existsSync(servicePath)) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: '已存在 systemd 配置，是否覆盖？',
      default: true,
    }]);
    if (!overwrite) {
      console.log(chalk.gray('已取消'));
      return;
    }

    // Stop any running instance and disable existing service before overwriting
    const exe = getExecutablePath();
    spawnSync(exe, ['stop']);
    spawnSync('systemctl', ['--user', 'stop', 'cc-linker.service']);
    spawnSync('systemctl', ['--user', 'disable', 'cc-linker.service']);
  }

  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, serviceContent, { mode: 0o644 });

  // Reload systemd
  const reloadResult = spawnSync('systemctl', ['--user', 'daemon-reload']);
  if (reloadResult.status !== 0) {
    const err = reloadResult.stderr.toString().trim();
    if (err) console.log(chalk.yellow(`⚠️ systemctl daemon-reload 警告: ${err}`));
  }

  // Enable for autostart
  const enableResult = spawnSync('systemctl', ['--user', 'enable', 'cc-linker.service']);
  if (enableResult.status !== 0) {
    const err = enableResult.stderr.toString().trim();
    if (err) console.log(chalk.yellow(`⚠️ systemctl enable 警告: ${err}`));
  }

  // Start immediately
  const startResult = spawnSync('systemctl', ['--user', 'start', 'cc-linker.service']);
  if (startResult.status !== 0) {
    const err = startResult.stderr.toString().trim();
    if (err) console.log(chalk.yellow(`⚠️ systemctl start 警告: ${err}`));
  }

  console.log(chalk.green('✅ 开机自启已配置'));
  console.log(chalk.cyan(`   配置: ${servicePath}`));
  console.log(chalk.cyan(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.gray('\n操作:'));
  console.log(chalk.gray(`   停止: systemctl --user stop cc-linker.service`));
  console.log(chalk.gray(`   卸载: cc-linker daemon uninstall`));
  console.log(chalk.gray(`   状态: cc-linker daemon status`));
}

export async function uninstallDaemon(): Promise<void> {
  console.log(chalk.blue('=== 卸载开机自启 ===\n'));

  if (IS_MACOS) {
    await uninstallMacOS();
  } else if (IS_LINUX) {
    await uninstallLinux();
  } else {
    console.log(chalk.red(`❌ 不支持的操作系统: ${platform()}`));
    process.exit(1);
  }
}

async function uninstallMacOS(): Promise<void> {
  const plistPath = getMacOSPlistPath();

  if (!existsSync(plistPath)) {
    console.log(chalk.yellow('⚠️ launchd 配置不存在'));
    return;
  }

  // Stop first, then unload
  spawnSync('launchctl', ['stop', 'com.cclinker.daemon']);
  spawnSync('launchctl', ['unload', plistPath]);

  // Remove file
  unlinkSync(plistPath);

  console.log(chalk.green('✅ 开机自启已卸载'));
}

async function uninstallLinux(): Promise<void> {
  const servicePath = getLinuxServicePath();

  if (!existsSync(servicePath)) {
    console.log(chalk.yellow('⚠️ systemd 配置不存在'));
    return;
  }

  // Disable and stop
  spawnSync('systemctl', ['--user', 'disable', 'cc-linker.service']);
  spawnSync('systemctl', ['--user', 'stop', 'cc-linker.service']);
  spawnSync('systemctl', ['--user', 'daemon-reload']);

  // Remove file
  unlinkSync(servicePath);

  console.log(chalk.green('✅ 开机自启已卸载'));
}

export async function daemonStatus(): Promise<void> {
  console.log(chalk.blue('=== cc-linker 服务状态 ===\n'));

  // Check daemon PID
  if (existsSync(RUNTIME_PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
      process.kill(pid, 0);
      console.log(chalk.green(`✅ cc-linker 正在运行 (PID: ${pid})`));
    } catch {
      console.log(chalk.red('❌ cc-linker PID 存在但进程不存在'));
    }
  } else {
    console.log(chalk.yellow('⚠️ cc-linker 未在运行'));
  }

  // Check autostart configuration
  console.log(chalk.cyan('\n开机自启配置:'));

  if (IS_MACOS) {
    const plistPath = getMacOSPlistPath();
    if (existsSync(plistPath)) {
      console.log(chalk.green(`   ✅ launchd 已配置 (${plistPath})`));
    } else {
      console.log(chalk.gray('   ️ 未配置 launchd'));
      console.log(chalk.gray('   执行: cc-linker daemon install'));
    }
  } else if (IS_LINUX) {
    const servicePath = getLinuxServicePath();
    if (existsSync(servicePath)) {
      console.log(chalk.green(`   ✅ systemd 已配置 (${servicePath})`));
    } else {
      console.log(chalk.gray('   ⏸️ 未配置 systemd'));
      console.log(chalk.gray('   执行: cc-linker daemon install'));
    }
  }

  // Show recent logs (tail last 10 lines to avoid loading large files)
  if (existsSync(RUNTIME_LOG_FILE)) {
    try {
      const tailResult = spawnSync('tail', ['-n', '10', RUNTIME_LOG_FILE]);
      if (tailResult.status === 0) {
        const lines = tailResult.stdout.toString().trim().split('\n').filter(Boolean).slice(-5);
        if (lines.length > 0) {
          console.log(chalk.cyan('\n最近日志:'));
          for (const line of lines) {
            console.log(chalk.gray(`   ${line}`));
          }
        }
      }
    } catch {
      // Ignore tail errors
    }
  }
}
