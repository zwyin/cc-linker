import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { USER_MAPPING_PATH } from '../utils/paths';
import { config } from '../utils/config';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';

export type MappingEntryType = 'session' | 'pending_new_session' | 'pending_new_session_claimed';

export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  claimedByMessageId?: string; // for pending_new_session_claimed
  claimedAt?: string; // for pending_new_session_claimed
}

export interface UserMapping {
  version: number;
  entries: Record<string, MappingEntry>; // keyed by openId
}

const DEFAULT_MAPPING: UserMapping = {
  version: 0,
  entries: {},
};

const PENDING_CLAIMED_TIMEOUT_MS = 60 * 1000; // 1 minute

export class UserManager {
  private mappingPath: string;

  constructor(mappingPath?: string) {
    this.mappingPath = mappingPath ?? USER_MAPPING_PATH;
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping(DEFAULT_MAPPING);
    }
  }

  private loadMapping(): UserMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as UserMapping;
    } catch {
      return { ...DEFAULT_MAPPING, entries: {} };
    }
  }

  private saveMapping(mapping: UserMapping): void {
    const tmp = this.mappingPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(tmp, this.mappingPath);
  }

  /** Get entry for an openId (non-atomic, for read-only use) */
  getEntry(openId: string): MappingEntry | undefined {
    const mapping = this.loadMapping();
    return mapping.entries[openId];
  }

  /**
   * Compare-And-Swap: atomically update an openId's entry.
   * Must be called inside the file lock internally.
   *
   * @param openId - Feishu user open ID
   * @param expected - Expected current entry (null if creating new)
   * @param newValue - New entry to set (null to delete)
   * @returns true if CAS succeeded
   */
  async compareAndSwap(
    openId: string,
    expected: MappingEntry | null,
    newValue: MappingEntry | null
  ): Promise<boolean> {
    let result = false;

    await withLock(this.mappingPath, async () => {
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      // Validate expected value
      if (!entriesMatch(current, expected)) {
        result = false;
        return;
      }

      // Owner validation
      const ownerUserId = config.get<string>('feishu_bot.owner_user_id', '');
      if (ownerUserId && openId !== ownerUserId) {
        // Configured owner doesn't match this openId
        result = false;
        return;
      }

      // Apply the swap
      if (newValue) {
        mapping.entries[openId] = newValue;
      } else {
        delete mapping.entries[openId];
      }

      // Increment version to prevent ABA
      mapping.version++;

      this.saveMapping(mapping);
      result = true;
    });

    return result;
  }

  /**
   * Roll back timed-out pending_new_session_claimed entries.
   * Called during startup reconciliation.
   */
  async rollbackTimedOutClaims(): Promise<number> {
    let rolledBack = 0;

    await withLock(this.mappingPath, async () => {
      const mapping = this.loadMapping();
      const now = Date.now();

      for (const [openId, entry] of Object.entries(mapping.entries)) {
        if (entry.type === 'pending_new_session_claimed' && entry.claimedAt) {
          const elapsed = now - new Date(entry.claimedAt).getTime();
          if (elapsed >= PENDING_CLAIMED_TIMEOUT_MS) {
            logger.info(`回滚超时 claim: ${openId} (超时 ${Math.round(elapsed / 1000)}s)`);
            // Roll back to pending_new_session (without claimedBy)
            entry.type = 'pending_new_session';
            delete entry.claimedByMessageId;
            delete entry.claimedAt;
            mapping.version++;
            rolledBack++;
          }
        }
      }

      if (rolledBack > 0) {
        this.saveMapping(mapping);
      }
    });

    return rolledBack;
  }

  /** Validate if an openId matches the configured owner */
  validateOwner(openId: string): boolean {
    const ownerUserId = config.get<string>('feishu_bot.owner_user_id', '');
    if (!ownerUserId) return true; // no owner configured, allow all
    return openId === ownerUserId;
  }
}

/** Check if two entries match (for CAS validation) */
function entriesMatch(
  a: MappingEntry | null,
  b: MappingEntry | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.sessionUuid !== b.sessionUuid) return false;
  // For claimed entries, also verify claimedBy
  if (a.type === 'pending_new_session_claimed' && b.type === 'pending_new_session_claimed') {
    if (a.claimedByMessageId !== b.claimedByMessageId) return false;
  }
  return true;
}

export const userManager = new UserManager();
