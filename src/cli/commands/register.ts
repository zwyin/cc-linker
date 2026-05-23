import { RegistryManager, type SessionEntry } from '../../registry';
import { OriginSchema } from '../../registry/types';
import { CCLinkerError } from '../../utils/errors';
import { isValidUUID } from '../../utils/validation';

interface RegisterOptions {
  origin?: string;
  cwd?: string;
  dryRun?: boolean;
}

export async function registerSession(
  registry: RegistryManager,
  uuid: string,
  opts: RegisterOptions = {}
): Promise<void> {
  if (!isValidUUID(uuid)) {
    throw new CCLinkerError('E005', `无效的 UUID 格式: ${uuid}`);
  }

  const originResult = OriginSchema.safeParse(opts.origin ?? 'cli');
  if (!originResult.success) {
    throw new CCLinkerError('E005', `无效的 origin 值: ${opts.origin}`);
  }

  const entry: Partial<SessionEntry> = {
    origin: originResult.data,
    cwd: opts.cwd ?? process.cwd(),
    last_active: new Date().toISOString(),
  };

  if (opts.dryRun) {
    console.log(`[dry-run] 将要注册会话:`);
    console.log(`  UUID:   ${uuid}`);
    console.log(`  Origin: ${entry.origin}`);
    console.log(`  CWD:    ${entry.cwd}`);
    if (registry.has(uuid)) {
      console.log(`  注: 该 UUID 已存在，将更新 last_active 字段`);
    }
    return;
  }

  registry.upsert(uuid, entry);
  await registry.flush();
}
