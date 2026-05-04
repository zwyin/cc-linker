import lockfile from 'proper-lockfile';
import { existsSync, writeFileSync } from 'fs';
import { CCBridgeError } from './errors';
import { logger } from './logger';

interface LockOptions {
  retries?: number;
  minTimeout?: number;
}

export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const { retries = 3, minTimeout = 100 } = options;

  // Ensure file exists for lockfile
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '');
  }

  let release: (() => Promise<void>) | null = null;

  try {
    release = await lockfile.lock(filePath, {
      retries: {
        retries,
        factor: 1.5,
        minTimeout,
      },
      lockfilePath: filePath + '.lock',
    });

    return await fn();
  } catch (err: any) {
    if (err.code === 'ELOCKED') {
      throw new CCBridgeError('E007', '注册表被锁，等待超时');
    }
    throw err;
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        logger.warn(`释放锁失败: ${err}`);
      }
    }
  }
}
