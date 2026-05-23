import { RegistryManager } from '../registry';
import { UserManager, ListSnapshotManager } from '../feishu';
import { SpoolQueue } from '../queue/spool';
import { RUNTIME_SESSION_EVENTS_DIR, LIST_SNAPSHOT_PATH, CLAUDE_PROJECTS_DIR } from '../utils/paths';
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
  repairedSessions: number;
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
  eventsDir?: string; // injectable for testing
}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    recoveredProcessing: 0,
    rolledBackClaims: 0,
    mergedEvents: 0,
    expiredSnapshots: 0,
    expiredFiles: 0,
    repairedSessions: 0,
  };

  logger.info('启动协调器开始...');

  // 0. Clean stray .tmp files from crashed atomic writes
  result.expiredFiles += cleanupTmpFiles(opts.spoolQueue.getSpoolDirs());

  // 1. Finalize messages that were already sent to Feishu before a crash.
  result.expiredFiles += opts.spoolQueue.finalizeDeliveredMessages();

  // 2. Recover processing → pending
  result.recoveredProcessing = opts.spoolQueue.recoverProcessing();

  // 3. Roll back timed-out pending_new_session_claimed
  result.rolledBackClaims = await opts.userManager.rollbackTimedOutClaims();

  // 4. Merge session-events into registry
  result.mergedEvents = await mergeSessionEvents(opts.registry, opts.eventsDir);

  // 5. Clean expired snapshots
  result.expiredSnapshots = cleanExpiredSnapshots(opts.listSnapshotManager);

  // 6. Repair provisioning/degraded sessions: try to find missing jsonl_path
  result.repairedSessions = await repairProvisioningSessions(opts.registry);

  // 7. Clean expired spool files
  const cleanup = opts.spoolQueue.cleanup();
  result.expiredFiles += cleanup.cleaned + cleanup.failed + cleanup.receipts + cleanup.deliveries;

  logger.info(
    `启动协调器完成: ` +
    `${result.recoveredProcessing} processing恢复, ` +
    `${result.rolledBackClaims} claims回滚, ` +
    `${result.mergedEvents} events归并, ` +
    `${result.repairedSessions} 会话修复, ` +
    `${result.expiredSnapshots + result.expiredFiles} 过期文件清理`
  );

  return result;
}

/**
 * Merge session discovery events into the registry.
 * Events are written by the session-start hook.
 */
async function mergeSessionEvents(registry: RegistryManager, eventsDir?: string): Promise<number> {
  const dir = eventsDir ?? RUNTIME_SESSION_EVENTS_DIR;
  if (!existsSync(dir)) return 0;

  let merged = 0;

  // S8: Sort events by discoveredAt to ensure chronological processing
  const files: Array<{ file: string; discoveredAt: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
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
    const path = join(dir, file);
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
 * Repair provisioning/degraded sessions by searching for missing jsonl files.
 */
async function repairProvisioningSessions(registry: RegistryManager): Promise<number> {
  let repaired = 0;

  for (const [uuid, entry] of Object.entries(registry.sessions)) {
    const status = entry.status ?? 'active';
    if (status !== 'provisioning' && status !== 'degraded') continue;

    // If jsonl_path exists and file is present, mark as active
    if (entry.jsonl_path && existsSync(entry.jsonl_path)) {
      registry.upsert(uuid, {
        status: 'active',
        pending_jsonl_resolve: false,
        last_error: null,
      });
      repaired++;
      continue;
    }

    // Try to find the jsonl file in projects directory
    const found = findJsonlFile(uuid);
    if (found) {
      registry.upsert(uuid, {
        jsonl_path: found,
        status: 'active',
        pending_jsonl_resolve: false,
        last_error: null,
      });
      repaired++;
    }
  }

  if (repaired > 0) {
    await registry.flush();
    logger.info(`修复 ${repaired} 个 provisioning/degraded 会话`);
  }

  return repaired;
}

function findJsonlFile(uuid: string): string | null {
  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const jsonlPath = join(CLAUDE_PROJECTS_DIR, project, `${uuid}.jsonl`);
      if (existsSync(jsonlPath)) return jsonlPath;
    }
  } catch {}
  return null;
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
