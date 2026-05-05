import chalk from 'chalk';
import { readFileSync, existsSync, statSync } from 'fs';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { CLAUDE_SETTINGS_PATH, CC_CONNECT_SESSIONS_DIR } from '../../utils/paths';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => !s.status || s.status === 'active').length;
  const archived = sessions.filter(s => s.status === 'archived').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const archivedOrCorrupted = sessions.filter(s => s.status === 'archived' || s.status === 'corrupted').length;

  console.log(chalk.bold('cc-bridge Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${registry.path}`);

  if (existsSync(registry.path)) {
    const stat = statSync(registry.path);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From cc-connect: ${fromCcConnect}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Archived:       ${archived}`);
  console.log(`  Corrupted:      ${archivedOrCorrupted - archived}`);

  // Scanners 状态
  console.log('\nScanners:');
  const ccConnectEnabled = existsSync(CC_CONNECT_SESSIONS_DIR);
  console.log(`  cc-connect scanner: ${ccConnectEnabled ? chalk.green('enabled') : chalk.red('disabled')}`);

  let hookInstalled = false;
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      const sessionStart = settings.hooks?.SessionStart;
      // 新格式：SessionStart 是 matcher 数组，检查嵌套的 hooks 中是否包含 cc-bridge
      if (Array.isArray(sessionStart)) {
        hookInstalled = sessionStart.some((matcher: any) =>
          matcher?.hooks?.some((h: any) => h?.command?.includes('cc-bridge'))
        );
      }
    } catch {}
  }
  console.log(`  Claude Code hook:   ${hookInstalled ? chalk.green('installed') : chalk.red('not installed')}`);

  // Commands 列表
  console.log('\nCommands:');
  console.log('  cc-bridge list       List all sessions');
  console.log('  cc-bridge resume     Resume a session');
  console.log('  cc-bridge sync       Sync sessions');
  console.log('  cc-bridge hook       Manage hooks');
}
