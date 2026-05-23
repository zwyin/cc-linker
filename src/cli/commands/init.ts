import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { StateCoordinator } from '../../runtime/state-coordinator';

export async function init(registry: RegistryManager): Promise<void> {
  // 运行时拒绝写入
  StateCoordinator.assertNotRunning();

  const isFresh = Object.keys(registry.sessions).length === 0;
  if (isFresh) {
    console.log(chalk.green(`✅ Created ${registry.path}`));
  } else {
    console.log(chalk.cyan(`📁 Registry exists at ${registry.path}, will refresh`));
  }

  console.log(chalk.blue('🔍 Scanning for existing sessions...'));
  await syncBeforeCommand(registry, undefined, undefined, false, true);

  const sessions = Object.values(registry.sessions);
  const feishu = sessions.filter(s => s.origin === 'feishu').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(`   Found ${feishu} feishu sessions`);
  console.log(`   Found ${cli} Claude Code sessions`);
  console.log(chalk.green(`✅ Registered ${sessions.length} sessions total`));

  console.log('\nNext steps:');
  console.log('  1. Run \'cc-link start\' to launch the Feishu bot');
  console.log('  2. Run \'cc-link list\' to view all sessions');
  console.log('  3. Run \'cc-link resume\' to resume a session');
}
