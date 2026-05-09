import { RegistryManager } from '../registry';
import { JSONLScanner } from './jsonl';
import { loadCache, saveCache, type FileCache } from './cache';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export async function syncBeforeCommand(
  registry: RegistryManager,
  cachePath?: string,
  claudeDir?: string,
  skipFlush = false,
  force = false
): Promise<void> {
  const path = cachePath ?? SCAN_CACHE_PATH;
  // --force: 清空缓存，强制全量扫描
  const cache = force ? new Map() : loadCache(path);

  logger.debug('开始同步扫描...');

  const jsonlScanner = new JSONLScanner(registry, cache, claudeDir);
  jsonlScanner.scan();
  logger.debug(`JSONL 扫描完成`);

  // Flush all changes to disk (single lock + backup)
  if (!skipFlush) {
    await registry.flush();
    // Only save cache when registry changes are flushed to disk.
    saveCache(cache, path);
  }
}

export { JSONLScanner } from './jsonl';
export { loadCache, saveCache } from './cache';
