import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';

interface CleanOptions {
  dryRun?: boolean;
  olderThan?: string;
}

export async function clean(registry: RegistryManager, opts: CleanOptions = {}): Promise<void> {
  const olderThanDays = opts.olderThan ? (() => {
    const n = parseInt(opts.olderThan, 10);
    if (isNaN(n)) throw new CCBridgeError('E005', `无效的天数: ${opts.olderThan}`);
    return n;
  })() : undefined;
  const cutoff = olderThanDays
    ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const toClean: string[] = [];
  const skipped: string[] = [];

  for (const [uuid, entry] of Object.entries(registry.sessions)) {
    const jsonlMissing = !existsSync(entry.jsonl_path);
    const hasCCConnectMapping = !!entry.cc_connect_session_id;

    // JSONL 不存在时：有 cc-connect 映射则保留（sync 会重新注册），无映射则清理
    if (jsonlMissing) {
      if (hasCCConnectMapping) {
        skipped.push(uuid);
        continue;
      }
      toClean.push(uuid);
      continue;
    }

    // Clean if older than threshold
    if (cutoff && entry.last_active < cutoff) {
      toClean.push(uuid);
    }
  }

  if (toClean.length === 0) {
    console.log(chalk.green('没有需要清理的会话'));
    if (skipped.length > 0) {
      console.log(chalk.cyan(`（跳过 ${skipped.length} 个有 cc-connect 映射但 JSONL 缺失的会话）`));
    }
    return;
  }

  console.log(`将清理 ${toClean.length} 个会话:`);
  for (const uuid of toClean) {
    const entry = registry.get(uuid);
    console.log(`  - ${uuid.slice(0, 8)}  ${entry?.title ?? 'Untitled'}`);
  }
  if (skipped.length > 0) {
    console.log(chalk.cyan(`\n跳过 ${skipped.length} 个有 cc-connect 映射但 JSONL 缺失的会话（sync 时会重新注册）`));
  }

  if (opts.dryRun) {
    console.log(chalk.yellow('\n（dry run，未实际删除）'));
    return;
  }

  await registry.removeBatch(toClean);

  console.log(chalk.green(`\n已清理 ${toClean.length} 个会话`));
}
