import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { existsSync, statSync } from 'fs';
import { REGISTRY_PATH } from '../../utils/paths';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => s.status === 'active').length;
  const archived = sessions.filter(s => s.status === 'archived').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;

  console.log(chalk.bold('cc-bridge Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${REGISTRY_PATH}`);

  if (existsSync(REGISTRY_PATH)) {
    const stat = statSync(REGISTRY_PATH);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From cc-connect: ${fromCcConnect}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Archived:       ${archived}`);
}
