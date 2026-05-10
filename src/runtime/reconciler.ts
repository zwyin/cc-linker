import { RegistryManager } from '../registry';
import { UserManager, ListSnapshotManager } from '../feishu';
import { SpoolQueue } from '../queue/spool';
import { RUNTIME_SESSION_EVENTS_DIR, LIST_SNAPSHOT_PATH } from '../utils/paths';
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

/** Clean stray .tmp files from crashed atomic writes */
function cleanupTmpFiles(dirs: string[]): number {
  let cleaned = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.tmp')) {
        try {
          unlinkSync(join(dir, file));
          cleaned++;
        } catch {
          // ignore
        }
      }
    }
  }
  return cleaned;
}

export interface ReconcileResult {
  recoveredProcessing: number;
  rolledBackClaims: number;
  mergedEvents: number;
  expiredSnapshots: number;
  expiredFiles: number;
}

/**
 * Startup reconciler: runs after acquiring owner.lock.
 * Recovers from crashes, cleans up stale state, merges events.
 */
export async function startupReconcile(opts: {
  registry: RegistryManager;
  userManager: UserManager;
  listSnapshotManager: ListSnapshotManager;
  spoolQueue: SpoolQueue;
}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    recoveredProcessing: 0,
    rolledBackClaims: 0,
    mergedEvents: 0,
    expiredSnapshots: 0,
    expiredFiles: 0,
  };

  logger.info('启动协调器开始...');

  // 0. Clean stray .tmp files from crashed atomic writes
  const spoolDirs = [
    opts.spoolQueue['pendingDir'],
    opts.spoolQueue['processingDir'],
    opts.spoolQueue['doneDir'],
    opts.spoolQueue['failedDir'],
    opts.spoolQueue['receiptsDir'],
    opts.spoolQueue['deliveriesDir'],
  ];
  result.expiredFiles += cleanupTmpFiles(spoolDirs);

  // 1. Recover processing → pending
  result.recoveredProcessing = opts.spoolQueue.recoverProcessing();

  // 2. Roll back timed-out pending_new_session_claimed
  result.rolledBackClaims = await opts.userManager.rollbackTimedOutClaims();

  // 3. Merge session-events into registry
  result.mergedEvents = await mergeSessionEvents(opts.registry);

  // 4. Clean expired snapshots
  result.expiredSnapshots = cleanExpiredSnapshots(opts.listSnapshotManager);

  // 5. Clean expired spool files
  const cleanup = opts.spoolQueue.cleanup();
  result.expiredFiles = cleanup.cleaned + cleanup.failed + cleanup.receipts + cleanup.deliveries;

  logger.info(
    `启动协调器完成: ` +
    `${result.recoveredProcessing} processing恢复, ` +
    `${result.rolledBackClaims} claims回滚, ` +
    `${result.mergedEvents} events归并, ` +
    `${result.expiredSnapshots + result.expiredFiles} 过期文件清理`
  );

  return result;
}

/**
 * Merge session discovery events into the registry.
 * Events are written by the session-start hook.
 */
async function mergeSessionEvents(registry: RegistryManager): Promise<number> {
  if (!existsSync(RUNTIME_SESSION_EVENTS_DIR)) return 0;

  let merged = 0;

  // S8: Sort events by discoveredAt to ensure chronological processing
  const files: Array<{ file: string; discoveredAt: string }> = [];
  for (const file of readdirSync(RUNTIME_SESSION_EVENTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const path = join(RUNTIME_SESSION_EVENTS_DIR, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const event = JSON.parse(raw) as { sessionId: string; cwd: string; discoveredAt: string };
      files.push({ file, discoveredAt: event.discoveredAt });
    } catch {
      logger.warn(`读取 session event 失败: ${file}`);
    }
  }

  files.sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt));

  for (const { file } of files) {
    const path = join(RUNTIME_SESSION_EVENTS_DIR, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const event = JSON.parse(raw) as { sessionId: string; cwd: string; discoveredAt: string };

      const existing = registry.get(event.sessionId);
      if (!existing) {
        // New session discovery
        registry.upsert(event.sessionId, {
          origin: 'cli',
          cwd: event.cwd,
          created_at: event.discoveredAt,
          last_active: event.discoveredAt,
        });
        merged++;
      } else if (existing.status === 'corrupted') {
        // JSONL was missing before, now we know the session exists
        registry.upsert(event.sessionId, {
          status: 'active',
          cwd: event.cwd,
          last_active: event.discoveredAt,
        });
        merged++;
      }

      // Remove processed event file
      unlinkSync(path);
    } catch (err) {
      logger.warn(`处理 session event 失败: ${file}: ${err}`);
    }
  }

  if (merged > 0) {
    await registry.flush();
  }

  return merged;
}

/**
 * Clean expired list snapshots.
 */
function cleanExpiredSnapshots(listSnapshotManager: ListSnapshotManager): number {
  // Check if file exists first
  if (!existsSync(listSnapshotManager.path)) return 0;

  // File exists — check if expired
  const snapshot = listSnapshotManager.loadSnapshot();
  if (!snapshot) {
    // Expired — clear it
    listSnapshotManager.clearSnapshot();
    return 1;
  }
  // Valid (not expired) — leave it
  return 0;
}
