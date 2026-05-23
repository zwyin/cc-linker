import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { RUNTIME_OWNER_LOCK_PATH } from '../utils/paths';
import { CCLinkerError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Owner lock manager.
 * Uses a lock file with PID + timestamp to ensure only one bot process
 * can write state files at a time. CLI write commands check this lock
 * and refuse to proceed if it's held by another process.
 */
export class StateCoordinator {
  private lockPath: string;
  private held = false;

  constructor(lockPath?: string) {
    this.lockPath = lockPath ?? RUNTIME_OWNER_LOCK_PATH;
  }

  /**
   * Try to acquire the owner lock.
   * Returns false if the lock is already held by a live process.
   */
  tryAcquire(): boolean {
    if (this.held) return true;

    // Check existing lock
    if (existsSync(this.lockPath)) {
      try {
        const lockData = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        const pid = lockData.pid as number;

        // Check if the process is still alive
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          // Process is dead
        }

        if (alive) {
          logger.warn(`Owner lock 已被进程 ${pid} 持有`);
          return false;
        }

        // Stale lock — remove it
        logger.info(`清理过期 owner lock (PID ${pid})`);
        unlinkSync(this.lockPath);
      } catch (err) {
        logger.warn(`解析 owner lock 失败: ${err}`);
        unlinkSync(this.lockPath);
      }
    }

    // Acquire lock
    const dir = dirname(this.lockPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const lockData = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const tmp = this.lockPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(lockData, null, 2), { mode: 0o600 });
    // Atomic rename
    try {
      renameSync(tmp, this.lockPath);
    } catch {
      // Another process won the race
      return false;
    }

    this.held = true;
    logger.info(`Owner lock 已获取 (PID ${process.pid})`);
    return true;
  }

  /**
   * Release the owner lock.
   */
  release(): void {
    if (!this.held) return;

    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch (err) {
      logger.warn(`释放 owner lock 失败: ${err}`);
    }

    this.held = false;
    logger.info(`Owner lock 已释放`);
  }

  /**
   * Check if the lock is currently held by a live process.
   * Used by CLI commands to detect if the bot is running.
   */
  static isLocked(lockPath?: string): boolean {
    const path = lockPath ?? RUNTIME_OWNER_LOCK_PATH;
    if (!existsSync(path)) return false;

    try {
      const lockData = JSON.parse(readFileSync(path, 'utf8'));
      const pid = lockData.pid as number;

      try {
        process.kill(pid, 0);
        return true; // process is alive
      } catch {
        return false; // process is dead, lock is stale
      }
    } catch {
      return false; // can't read lock file
    }
  }

  /**
   * Assert that the lock is NOT held (used by CLI write commands).
   * Throws E013 if the bot is running.
   */
  static assertNotRunning(lockPath?: string): void {
    if (StateCoordinator.isLocked(lockPath)) {
      throw new CCLinkerError('E013', 'Bot 进程正在运行，请使用飞书命令操作会话，而非直接 CLI 操作');
    }
  }

  /** Check if this instance currently holds the lock */
  isHeld(): boolean {
    return this.held;
  }
}

export const stateCoordinator = new StateCoordinator();
