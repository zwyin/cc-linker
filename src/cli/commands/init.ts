import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';

export async function init(registry: RegistryManager): Promise<void> {
  // RegistryManager 构造时已创建空 registry 文件，所以靠 sessions 数量判断是否首次
  const isFresh = Object.keys(registry.sessions).length === 0;
  if (isFresh) {
    console.log(chalk.green(`✅ Created ${registry.path}`));
  } else {
    console.log(chalk.cyan(`📁 Registry exists at ${registry.path}, will refresh`));
  }

  console.log(chalk.blue('🔍 Scanning for existing sessions...'));
  // init 总是做全量扫描，忽略 scan_cache.json 中的增量缓存
  await syncBeforeCommand(registry, undefined, undefined, false, true);

  const sessions = Object.values(registry.sessions);
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(`   Found ${ccConnect} cc-connect sessions`);
  console.log(`   Found ${cli} Claude Code sessions`);
  console.log(chalk.green(`✅ Registered ${sessions.length} sessions total`));

  console.log('\nNext steps:');
  console.log('  1. Run \'cc-bridge hook install\' to install Claude Code hook');
  console.log('  2. Run \'cc-bridge list\' to view all sessions');
  console.log('  3. Run \'cc-bridge resume\' to resume a session');
}
