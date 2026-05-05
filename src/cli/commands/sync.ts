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

  const beforeKeys = new Set(Object.keys(registry.sessions));

  if (opts.clean) {
    const toClean: string[] = [];
    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (!existsSync(entry.jsonl_path)) {
        toClean.push(uuid);
      }
    }
    if (toClean.length > 0) {
      await registry.removeBatch(toClean);
    }
    console.log(`   Cleaned ${toClean.length} invalid sessions`);
  }

  // --scan: only scan and report, skip writing to registry
  if (opts.scan) {
    await syncBeforeCommand(registry, undefined, undefined, true, opts.force);
  } else {
    console.log('   Scanning cc-connect sessions...');
    await syncBeforeCommand(registry, undefined, undefined, false, opts.force);
  }

  const sessions = Object.values(registry.sessions);
  const afterKeys = new Set(Object.keys(registry.sessions));
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  const newSessions = [...afterKeys].filter(k => !beforeKeys.has(k)).length;
  const updatedSessions = [...afterKeys].filter(k => beforeKeys.has(k)).length;
  const removedSessions = [...beforeKeys].filter(k => !afterKeys.has(k)).length;

  console.log(`   Found ${ccConnect} cc-connect sessions, ${cli} Claude Code sessions`);
  if (!opts.scan) {
    console.log(`   New sessions registered: ${newSessions}`);
    console.log(`   Sessions updated: ${updatedSessions}`);
  }
  if (opts.clean) console.log(`   Sessions cleaned: ${removedSessions}`);

  const label = opts.scan ? 'Scan' : 'Sync';
  console.log(chalk.green(`✅ ${label} complete. Total registered: ${sessions.length}`));
}
