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
  casToken?: string; // I3: Unique CAS token to prevent ABA race (auto-generated)
  cwd?: string; // I4: Working directory for new sessions (set by /bridge new)
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string; // User's default model alias (user-level config)
}

export interface UserMapping {
  version: number;
  ownerOpenId?: string;
  entries: Record<string, MappingEntry>;
}

const DEFAULT_MAPPING: UserMapping = {
  version: 0,
  entries: {},
};

export const PENDING_CLAIMED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type ClaimPendingResult =
  | { status: 'claimed'; entry: MappingEntry; version: number }
  | { status: 'creating'; entry: MappingEntry; version: number }
  | { status: 'no_pending'; entry: MappingEntry | null; version: number }
  | { status: 'unauthorized'; version: number };

export class UserManager {
  private mappingPath: string;
  private initialized = false;

  constructor(mappingPath?: string) {
    this.mappingPath = mappingPath ?? USER_MAPPING_PATH;
  }

  /** Lazy file initialization to avoid constructor throw on import */
  private ensureFile(): void {
    if (this.initialized) return;
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping(DEFAULT_MAPPING);
    }
    this.initialized = true;
  }

  private loadMapping(): UserMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as UserMapping;
    } catch (err) {
      if (existsSync(this.mappingPath)) {
        logger.warn(`user-mapping 解析失败: ${err}`);
      }
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
    this.ensureFile();
    const mapping = this.loadMapping();
    return mapping.entries[openId];
  }

  getVersion(): number {
    this.ensureFile();
    return this.loadMapping().version;
  }

  /**
   * Compare-And-Swap: atomically update an openId's entry.
   */
  async compareAndSwap(
    openId: string,
    expected: MappingEntry | null,
    newValue: MappingEntry | null
  ): Promise<boolean> {
    // C1: Owner validation before acquiring lock (fast reject)
    if (!this.validateOwner(openId)) {
      return false;
    }

    let result = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      // Validate expected value
      if (!entriesMatch(current, expected)) {
        result = false;
        return;
      }

      // Apply the swap
      if (newValue) {
        // I3: Auto-generate CAS token if not provided
        if (!newValue.casToken) {
          newValue.casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
        mapping.entries[openId] = {
          ...newValue,
          lastActiveAt: newValue.lastActiveAt ?? new Date().toISOString(),
        };
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

  async claimPendingNewSession(openId: string, messageId: string): Promise<ClaimPendingResult> {
    if (!this.validateOwner(openId)) {
      return { status: 'unauthorized', version: this.getVersion() };
    }

    let outcome: ClaimPendingResult = { status: 'no_pending', entry: null, version: this.getVersion() };

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      if (!current || (current.type !== 'pending_new_session' && current.type !== 'pending_new_session_claimed')) {
        outcome = { status: 'no_pending', entry: current, version: mapping.version };
        return;
      }

      if (current.type === 'pending_new_session_claimed') {
        outcome = { status: 'creating', entry: current, version: mapping.version };
        return;
      }

      const now = new Date().toISOString();
      const claimedEntry: MappingEntry = {
        ...current,
        type: 'pending_new_session_claimed',
        claimedByMessageId: messageId,
        claimedAt: now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };

      mapping.entries[openId] = claimedEntry;
      mapping.version++;
      this.saveMapping(mapping);
      outcome = { status: 'claimed', entry: claimedEntry, version: mapping.version };
    });

    return outcome;
  }

  async rollbackClaim(openId: string, messageId: string): Promise<boolean> {
    let rolledBack = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId];
      if (!current || current.type !== 'pending_new_session_claimed') {
        return;
      }
      if (current.claimedByMessageId !== messageId) {
        return;
      }

      mapping.entries[openId] = {
        ...current,
        type: 'pending_new_session',
        sessionUuid: null,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedByMessageId: undefined,
        claimedAt: undefined,
      };
      mapping.version++;
      this.saveMapping(mapping);
      rolledBack = true;
    });

    return rolledBack;
  }

  async bindSessionToClaim(openId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean> {
    let bound = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId];
      if (!current) {
        return;
      }

      const claimMatches =
        current.type === 'pending_new_session_claimed' &&
        current.claimedByMessageId === messageId;

      if (!claimMatches) {
        return;
      }

      mapping.entries[openId] = {
        ...current,
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: current.createdAt,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
      bound = true;
    });

    return bound;
  }

  /**
   * Roll back timed-out pending_new_session_claimed entries.
   */
  async rollbackTimedOutClaims(): Promise<number> {
    let rolledBack = 0;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = Date.now();

      for (const [openId, entry] of Object.entries(mapping.entries)) {
        if (entry.type === 'pending_new_session_claimed') {
          // I5: Guard against missing claimedAt
          if (!entry.claimedAt) continue;
          const elapsed = now - new Date(entry.claimedAt).getTime();
          if (isNaN(elapsed)) continue;
          if (elapsed >= PENDING_CLAIMED_TIMEOUT_MS) {
            logger.info(`回滚超时 claim: ${openId} (超时 ${Math.round(elapsed / 1000)}s)`);
            entry.type = 'pending_new_session';
            delete entry.claimedByMessageId;
            delete entry.claimedAt;
            // I3: Generate new CAS token on rollback
            entry.casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            rolledBack++;
          }
        }
      }

      // I1: Single version increment for all rolled-back entries
      if (rolledBack > 0) {
        mapping.version++;
        this.saveMapping(mapping);
      }
    });

    return rolledBack;
  }

  /** Validate if an openId matches the configured owner */
  validateOwner(openId: string): boolean {
    const ownerOpenId = config.get<string>('feishu_bot.owner_open_id', '');
    if (!ownerOpenId) return true;
    return openId === ownerOpenId;
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
  if ((a.cwd ?? '') !== (b.cwd ?? '')) return false;
  // I3: Compare CAS token — treat both undefined/empty as matching (backward compat)
  const tokenA = a.casToken || '';
  const tokenB = b.casToken || '';
  if (tokenA !== tokenB) return false;
  // For claimed entries, also verify claimedBy and claimedAt
  if (a.type === 'pending_new_session_claimed' && b.type === 'pending_new_session_claimed') {
    if (a.claimedByMessageId !== b.claimedByMessageId) return false;
    if ((a.claimedAt ?? '') !== (b.claimedAt ?? '')) return false;
  }
  // Note: defaultProvider is intentionally NOT compared — it's a user preference, not session state
  return true;
}

export const userManager = new UserManager();
