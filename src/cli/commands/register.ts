import { RegistryManager } from '../../registry';
import { OriginSchema } from '../../registry/types';
import { CCBridgeError } from '../../utils/errors';

interface RegisterOptions {
  origin?: string;
  cwd?: string;
  source?: string;
}

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export async function registerSession(
  registry: RegistryManager,
  uuid: string,
  opts: RegisterOptions = {}
): Promise<void> {
  if (!isValidUUID(uuid)) {
    throw new CCBridgeError('E005', `无效的 UUID 格式: ${uuid}`);
  }

  const originResult = OriginSchema.safeParse(opts.origin ?? 'cli');
  if (!originResult.success) {
    throw new CCBridgeError('E005', `无效的 origin 值: ${opts.origin}`);
  }
  await registry.upsert(uuid, {
    origin: originResult.data,
    source: opts.source ?? 'terminal',
    cwd: opts.cwd ?? process.cwd(),
  });
}
