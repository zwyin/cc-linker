import { RegistryManager } from '../registry';
import { CCConnectScanner } from './cc-connect';
import { JSONLScanner } from './jsonl';
import { loadCache, saveCache, type FileCache } from './cache';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export async function syncBeforeCommand(
  registry: RegistryManager,
  cachePath?: string,
  claudeDir?: string
): Promise<void> {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const cache = loadCache(path);

  logger.debug('开始同步扫描...');

  // Step 1: Scan cc-connect sessions
  const ccScanner = new CCConnectScanner(registry);
  const { uuids } = await ccScanner.scan();
  logger.debug(`cc-connect 扫描完成: ${uuids.size} 个会话`);

  // Step 2: Scan JSONL files
  const jsonlScanner = new JSONLScanner(registry, uuids, cache, claudeDir);
  await jsonlScanner.scan();
  logger.debug(`JSONL 扫描完成`);

  // Save cache
  saveCache(cache, path);
}

export { CCConnectScanner } from './cc-connect';
export { JSONLScanner } from './jsonl';
export { loadCache, saveCache } from './cache';
