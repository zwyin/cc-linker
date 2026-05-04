import { readFileSync, writeFileSync, existsSync } from 'fs';
import chalk from 'chalk';
import { CLAUDE_SETTINGS_PATH, HOOK_LOG_PATH } from '../../utils/paths';

export function hookInstall(): void {
  let settings: any = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    // Backup original before modifying
    const backupPath = CLAUDE_SETTINGS_PATH + '.bak';
    writeFileSync(backupPath, readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  }

  if (settings.hooks?.SessionStart?.includes('cc-bridge')) {
    console.log(chalk.green('Hook 已安装'));
    return;
  }

  settings.hooks = settings.hooks ?? {};

  // Handle SessionStart as array (Claude Code format)
  if (Array.isArray(settings.hooks.SessionStart)) {
    settings.hooks.SessionStart.push('cc-bridge hook session-start');
  } else if (typeof settings.hooks.SessionStart === 'string' && settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [settings.hooks.SessionStart, 'cc-bridge hook session-start'];
  } else {
    settings.hooks.SessionStart = 'cc-bridge hook session-start';
  }

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });

  console.log(chalk.green('Hook 安装成功'));
  console.log(`已添加到 ${CLAUDE_SETTINGS_PATH}:`);
  console.log('  "hooks": { "SessionStart": "cc-bridge hook session-start" }');
}

export function hookUninstall(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(chalk.yellow('未找到 settings.json'));
    return;
  }

  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  if (settings.hooks?.SessionStart?.includes('cc-bridge')) {
    if (Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
        (h: string) => !h.includes('cc-bridge')
      );
      if (settings.hooks.SessionStart.length === 0) {
        delete settings.hooks.SessionStart;
      }
    } else {
      delete settings.hooks.SessionStart;
    }
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
    console.log(chalk.green('Hook 已卸载'));
  } else {
    console.log(chalk.yellow('Hook 未安装'));
  }
}

export function hookStatus(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(chalk.red('未找到 settings.json'));
    return;
  }

  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  const installed = settings.hooks?.SessionStart?.includes('cc-bridge');

  console.log(`Hook 状态: ${installed ? chalk.green('已安装') : chalk.red('未安装')}`);

  if (existsSync(HOOK_LOG_PATH)) {
    const logs = readFileSync(HOOK_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const recent = logs.slice(-5);
    console.log('\n最近日志:');
    recent.forEach(l => console.log(`  ${l}`));
  }
}

export { hookSessionStart } from '../../hook/session-start';
