import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { StateCoordinator } from '../../runtime/state-coordinator';

interface CleanOptions {
  dryRun?: boolean;
  olderThan?: string;
}

export async function clean(registry: RegistryManager, opts: CleanOptions = {}): Promise<void> {
  // 运行时拒绝写入
  StateCoordinator.assertNotRunning();

  const olderThanDays = opts.olderThan ? (() => {
    const n = parseInt(opts.olderThan, 10);
    if (isNaN(n)) throw new CCLinkerError('E005', `无效的天数: ${opts.olderThan}`);
    return n;
  })() : undefined;
  const cutoff = olderThanDays
    ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const toClean: string[] = [];

  for (const [uuid, entry] of Object.entries(registry.sessions)) {
    // JSONL 不存在时清理
    if (entry.jsonl_path && !existsSync(entry.jsonl_path)) {
      toClean.push(uuid);
      continue;
    }

    // 清理超过指定天数的会话
    if (cutoff && entry.last_active < cutoff) {
      toClean.push(uuid);
    }
  }

  if (toClean.length === 0) {
    console.log(chalk.green('没有需要清理的会话'));
    return;
  }

  console.log(`将清理 ${toClean.length} 个会话:`);
  for (const uuid of toClean) {
    const entry = registry.get(uuid);
    console.log(`  - ${uuid.slice(0, 8)}  ${entry?.title ?? 'Untitled'}`);
  }

  if (opts.dryRun) {
    console.log(chalk.yellow('\n（dry run，未实际删除）'));
    return;
  }

  await registry.removeBatch(toClean);

  console.log(chalk.green(`\n已清理 ${toClean.length} 个会话`));
}
