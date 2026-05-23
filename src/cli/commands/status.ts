import chalk from 'chalk';
import { readFileSync, existsSync, statSync } from 'fs';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { CLAUDE_SETTINGS_PATH, RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => !s.status || s.status === 'active').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromFeishu = sessions.filter(s => s.origin === 'feishu').length;
  const archivedOrCorrupted = sessions.filter(s => s.status === 'archived' || s.status === 'corrupted' || s.status === 'degraded' || s.status === 'provisioning').length;

  console.log(chalk.bold('cc-link Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${registry.path}`);

  if (existsSync(registry.path)) {
    const stat = statSync(registry.path);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From Feishu:    ${fromFeishu}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Other states:   ${archivedOrCorrupted}`);

  // Runtime 状态
  console.log('\nRuntime:');
  const hasLock = existsSync(RUNTIME_OWNER_LOCK_PATH);
  console.log(`  Owner lock:     ${hasLock ? chalk.green('active') : 'none'}`);

  let hookInstalled = false;
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      const sessionStart = settings.hooks?.SessionStart;
      if (Array.isArray(sessionStart)) {
        hookInstalled = sessionStart.some((matcher: any) =>
          matcher?.hooks?.some((h: any) => h?.command?.includes('cc-link'))
        );
      }
    } catch {}
  }
  console.log(`  Claude Code hook:   ${hookInstalled ? chalk.green('installed') : chalk.red('not installed')}`);

  // Commands 列表
  console.log('\nCommands:');
  console.log('  cc-link start      Launch Feishu bot');
  console.log('  cc-link list       List all sessions');
  console.log('  cc-link resume     Resume a session');
  console.log('  cc-link sync       Sync sessions');
}
