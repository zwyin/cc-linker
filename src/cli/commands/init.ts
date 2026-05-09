import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';

export async function init(registry: RegistryManager): Promise<void> {
  // 运行时拒绝写入
  if (existsSync(RUNTIME_OWNER_LOCK_PATH)) {
    console.log(chalk.yellow('⚠️  Bot 进程正在运行，init 仅执行扫描，不会修改 registry'));
  }

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
  console.log('  1. Run \'cc-bridge start\' to launch the Feishu bot');
  console.log('  2. Run \'cc-bridge list\' to view all sessions');
  console.log('  3. Run \'cc-bridge resume\' to resume a session');
}
