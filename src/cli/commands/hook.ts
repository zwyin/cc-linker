import { readFileSync, writeFileSync, existsSync } from 'fs';
import chalk from 'chalk';
import { CLAUDE_SETTINGS_PATH, HOOK_LOG_PATH } from '../../utils/paths';

// Claude Code hook 格式：SessionStart 是 matcher 数组，每个 matcher 包含 hooks 数组
interface HookMatcher {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
    statusMessage?: string;
  }>;
}

function isHookInstalled(sessionStart: unknown): boolean {
  if (!Array.isArray(sessionStart)) return false;
  return sessionStart.some((matcher: any) => {
    if (!matcher?.hooks) return false;
    return matcher.hooks.some((h: any) => h?.command?.includes('cc-link') || h?.command?.includes('cc-bridge'));
  });
}

export function hookInstall(): void {
  let settings: any = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    // Backup original before modifying
    const backupPath = CLAUDE_SETTINGS_PATH + '.bak';
    writeFileSync(backupPath, readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'), { mode: 0o600 });
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch (err) {
      console.error(chalk.red(`settings.json 解析失败: ${err}`));
      console.error('请检查 ~/.claude/settings.json 格式是否正确');
      process.exit(1);
    }
  }

  if (isHookInstalled(settings.hooks?.SessionStart)) {
    console.log(chalk.green('Hook 已安装'));
    return;
  }

  settings.hooks = settings.hooks ?? {};

  // Claude Code 要求的格式：SessionStart 是 matcher 数组
  const ccBridgeMatcher: HookMatcher = {
    matcher: 'startup|resume|clear|compact',
    hooks: [
      {
        type: 'command',
        command: 'cc-link hook session-start',
        timeout: 10,
      },
    ],
  };

  if (!Array.isArray(settings.hooks.SessionStart)) {
    settings.hooks.SessionStart = [];
  }

  // 检查是否已有 hook（cc-link 或 cc-bridge）
  const existingIndex = settings.hooks.SessionStart.findIndex((m: any) =>
    m?.hooks?.some((h: any) => h?.command?.includes('cc-link') || h?.command?.includes('cc-bridge'))
  );

  if (existingIndex === -1) {
    settings.hooks.SessionStart.push(ccBridgeMatcher);
  }

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });

  console.log(chalk.green('Hook 安装成功'));
  console.log(`已添加到 ${CLAUDE_SETTINGS_PATH}:`);
  console.log(JSON.stringify({ hooks: { SessionStart: [ccBridgeMatcher] } }, null, 2));
}

export function hookUninstall(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(chalk.yellow('未找到 settings.json'));
    return;
  }

  let settings: any;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch (err) {
    console.error(chalk.red(`settings.json 解析失败: ${err}`));
    console.error('请检查 ~/.claude/settings.json 格式是否正确');
    process.exit(1);
  }

  if (isHookInstalled(settings.hooks?.SessionStart)) {
    if (Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter((m: any) => {
        if (!m?.hooks) return true;
        // 移除包含 cc-link 或 cc-bridge 的 matcher
        return !m.hooks.some((h: any) => h?.command?.includes('cc-link') || h?.command?.includes('cc-bridge'));
      });
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

  let settings: any;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch (err) {
    console.error(chalk.red(`settings.json 解析失败: ${err}`));
    console.error('请检查 ~/.claude/settings.json 格式是否正确');
    process.exit(1);
  }
  const installed = isHookInstalled(settings.hooks?.SessionStart);

  console.log(`Hook 状态: ${installed ? chalk.green('已安装') : chalk.red('未安装')}`);

  if (existsSync(HOOK_LOG_PATH)) {
    const logs = readFileSync(HOOK_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const recent = logs.slice(-5);
    console.log('\n最近日志:');
    recent.forEach(l => console.log(`  ${l}`));
  }
}

export { hookSessionStart } from '../../hook/session-start';
