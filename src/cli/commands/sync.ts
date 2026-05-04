import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { existsSync } from 'fs';

interface SyncOptions {
  scan?: boolean;
  force?: boolean;
  clean?: boolean;
}

export async function sync(registry: RegistryManager, opts: SyncOptions): Promise<void> {
  console.log(chalk.blue('🔄 Syncing sessions...'));

  if (opts.clean) {
    let cleaned = 0;
    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (!existsSync(entry.jsonl_path) && entry.origin === 'cli') {
        await registry.remove(uuid);
        cleaned++;
      }
    }
    console.log(`   Cleaned ${cleaned} invalid sessions`);
  }

  if (!opts.scan) {
    await syncBeforeCommand(registry);
  }

  const sessions = Object.values(registry.sessions);
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(chalk.green(`✅ Sync complete. Total registered: ${sessions.length}`));
  console.log(`   From CLI: ${cli}`);
  console.log(`   From cc-connect: ${ccConnect}`);
}
