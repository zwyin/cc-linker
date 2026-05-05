import { RegistryManager } from '../registry';
import { CCConnectScanner } from './cc-connect';
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

  // Step 1: Scan cc-connect sessions (synchronous, memory-only)
  const ccScanner = new CCConnectScanner(registry);
  const { uuids } = ccScanner.scan();
  logger.debug(`cc-connect 扫描完成: ${uuids.size} 个会话`);

  // Step 2: Scan JSONL files (synchronous, memory-only)
  const jsonlScanner = new JSONLScanner(registry, uuids, cache, claudeDir);
  jsonlScanner.scan();
  logger.debug(`JSONL 扫描完成`);

  // Step 3: Flush all changes to disk (single lock + backup)
  if (!skipFlush) {
    await registry.flush();
    // Only save cache when registry changes are flushed to disk.
    // If skipFlush=true (dry run), don't save cache either — otherwise
    // next scan would skip these files thinking they're already registered.
    saveCache(cache, path);
  }
}

export { CCConnectScanner } from './cc-connect';
export { JSONLScanner } from './jsonl';
export { loadCache, saveCache } from './cache';
