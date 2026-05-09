import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LIST_SNAPSHOT_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export interface ListSnapshot {
  /** OpenId -> session list entries */
  entries: ListSnapshotEntry[];
  /** When this snapshot was created */
  createdAt: string;
  /** Open ID of the user who requested this list */
  openId: string;
}

export interface ListSnapshotEntry {
  index: number;
  uuid: string;
  title: string;
}

const LIST_SNAPSHOT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class ListSnapshotManager {
  private snapshotPath: string;

  constructor(snapshotPath?: string) {
    this.snapshotPath = snapshotPath ?? LIST_SNAPSHOT_PATH;
  }

  private ensureDir(): void {
    const dir = join(this.snapshotPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Save a new list snapshot for a user */
  saveSnapshot(openId: string, entries: ListSnapshotEntry[]): void {
    this.ensureDir();

    const snapshot: ListSnapshot = {
      openId,
      entries,
      createdAt: new Date().toISOString(),
    };

    const tmp = this.snapshotPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    renameSync(tmp, this.snapshotPath);
  }

  /**
   * Load the most recent snapshot and check if it's still valid.
   * Returns null if no snapshot exists or it has expired.
   */
  loadSnapshot(openId?: string): ListSnapshot | null {
    if (!existsSync(this.snapshotPath)) return null;

    try {
      const raw = readFileSync(this.snapshotPath, 'utf8');
      const snapshot = JSON.parse(raw) as ListSnapshot;

      // Check TTL
      const age = Date.now() - new Date(snapshot.createdAt).getTime();
      if (age >= LIST_SNAPSHOT_TTL_MS) {
        logger.debug(`列表快照已过期 (${Math.round(age / 1000)}s)`);
        return null;
      }

      // If openId is provided, validate it matches
      if (openId && snapshot.openId !== openId) {
        return null;
      }

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a numeric index to a session UUID from the current snapshot.
   * Returns null if snapshot is expired or index is out of range.
   */
  resolveIndex(index: number, openId?: string): string | null {
    const snapshot = this.loadSnapshot(openId);
    if (!snapshot) return null;

    const entry = snapshot.entries.find(e => e.index === index);
    return entry?.uuid ?? null;
  }

  /** Delete the current snapshot */
  clearSnapshot(): void {
    try {
      if (existsSync(this.snapshotPath)) {
        // Atomic delete via rename to empty
        writeFileSync(this.snapshotPath, JSON.stringify({ entries: [], createdAt: '', openId: '' }));
      }
    } catch {
      // ignore
    }
  }
}

export const listSnapshotManager = new ListSnapshotManager();
