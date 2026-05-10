import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR } from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export interface ClaudeSession {
  sessionId: string;
  pid: number;
  cwd: string;
  createdAt: number;
  lastOutputAt: number;
  isNew: boolean;
}

export interface SendMessageResult {
  response: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  jsonlPath: string | null;
  sessionStatus: 'active' | 'provisioning' | 'degraded';
}

/**
 * Resolve a Claude session JSONL file path by polling project directories
 */
export async function resolveJsonlPath(sessionId: string, timeoutMs = 10_000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
      for (const dir of dirs) {
        const fullPath = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        if (existsSync(fullPath)) return fullPath;
      }
    } catch {}
    await sleep(500);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Terminate a process tree: SIGTERM → wait → SIGKILL
 * Uses negative PID on Unix to signal the entire process group.
 */
export function terminateProcessTree(pid: number): void {
  // Send to entire process group (negative PID on Unix)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Fallback: try single process kill
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }

  // After 3s, SIGKILL if still alive. unref() so it doesn't keep the event loop alive.
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 3000);
  timer.unref();
}

/**
 * Kill all orphan claude subprocesses on startup
 */
export function cleanupOrphanProcesses(): void {
  try {
    // Filter to current user only and exclude our own process
    const uid = process.getuid?.() ?? 0;
    const result = Bun.spawnSync(['pgrep', '-u', String(uid), '-f', 'claude -p.*--output-format json'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    if (result.exitCode === 0) {
      const output = new TextDecoder().decode(result.stdout);
      const pids = output.trim().split('\n')
        .filter(Boolean)
        .map(Number)
        .filter(p => p !== process.pid); // exclude ourselves
      for (const pid of pids) {
        logger.info(`清理孤子进程: ${pid}`);
        terminateProcessTree(pid);
      }
    }
  } catch (err) {
    logger.warn(`清理孤子进程失败: ${err}`);
  }
}

/** Expand ~/ to absolute path */
function expandPath(p: string): string {
  if (p === '~') return process.env.HOME ?? '';
  if (p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(2));
  return p;
}

/** Parse a single JSONL line, returning null if not valid JSON */
function parseJsonlLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract assistant text from a parsed JSONL entry */
function extractAssistantText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'assistant') return null;
  const content = entry.message as Record<string, unknown> | undefined;
  if (!content || !Array.isArray(content.content)) return null;
  const textBlock = (content.content as Array<Record<string, unknown>>).find(b => b.type === 'text');
  return textBlock?.text as string | null;
}

interface SessionLock {
  promise: Promise<void>;
  release: () => void;
}

export class ClaudeSessionManager {
  private activeProcesses = new Map<string, ClaudeSession>();
  private sessionLocks = new Map<string, SessionLock>();
  private runningProcesses = 0;
  private processWaiters: Array<() => void> = [];
  private readonly maxConcurrent: number;

  constructor() {
    this.maxConcurrent = Math.max(1, config.get<number>('runtime.max_concurrent_sessions', 2));
  }

  /**
   * Send a message to a Claude session.
   * Spawns a new process for each call.
   */
  async sendMessage(
    sessionId: string | null,
    text: string,
    cwd: string,
    isNew?: boolean
  ): Promise<SendMessageResult> {
    const lockKey = sessionId ?? '__new__';
    await this.acquireSessionLock(lockKey);

    try {
      await this.acquireSlot();

      try {
        return await this._doSendMessage(sessionId, text, cwd, isNew ?? false);
      } finally {
        this.releaseSlot();
      }
    } finally {
      this.releaseSessionLock(lockKey);
    }
  }

  /** Core message sending logic */
  private async _doSendMessage(
    sessionId: string | null,
    text: string,
    cwd: string,
    isNew: boolean
  ): Promise<SendMessageResult> {
    const claudeBin = config.get<string>('general.claude_bin', 'claude');
    const args: string[] = [claudeBin, '-p', text, '--output-format', 'json'];

    if (sessionId && !isNew) {
      args.push('--resume', sessionId);
    }

    const expandedCwd = expandPath(cwd);
    if (!expandedCwd) {
      return {
        response: 'Error: cwd is empty',
        costUsd: 0,
        durationMs: 0,
        sessionId: sessionId ?? '',
        jsonlPath: null,
        sessionStatus: 'degraded',
      };
    }

    const startTime = Date.now();
    let lastOutputAt = startTime;
    let responseLines: string[] = [];
    let currentSessionId: string | null = null;
    let costUsd = 0;

    const staleTimeout = config.get<number>('runtime.stale_timeout_ms', 5 * 60 * 1000);
    const hardTimeout = config.get<number>('runtime.hard_timeout_ms', 30 * 60 * 1000);

    let proc;
    try {
      proc = Bun.spawn(args, {
        cwd: expandedCwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore', // I4: ignore stderr to prevent backpressure hang
        // C2: Create detached process group for proper process tree killing
        detached: true,
      });
    } catch (err: any) {
      return {
        response: `Failed to start Claude process: ${err.message}`,
        costUsd: 0,
        durationMs: Date.now() - startTime,
        sessionId: sessionId ?? '',
        jsonlPath: null,
        sessionStatus: 'degraded',
      };
    }

    const procPid = proc.pid;

    // C2: Track new sessions with PID as key, update key once session_id is resolved
    const trackKey = sessionId ?? `pid:${procPid}`;
    const session: ClaudeSession = {
      sessionId: sessionId ?? '',
      pid: procPid,
      cwd: expandedCwd,
      createdAt: startTime,
      lastOutputAt: startTime,
      isNew,
    };
    this.activeProcesses.set(trackKey, session);

    // Read stdout line by line
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // I9: readPromise is awaited after exit to ensure stream is fully consumed
    const readPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            responseLines.push(line);
            lastOutputAt = Date.now();
            session.lastOutputAt = lastOutputAt;

            const parsed = parseJsonlLine(line);
            if (!parsed) continue;

            if (parsed.type === 'session_update' && parsed.session_id) {
              currentSessionId = parsed.session_id as string;
              // C2: Update tracking key once session_id is resolved
              if (trackKey.startsWith('pid:')) {
                this.activeProcesses.delete(trackKey);
                session.sessionId = currentSessionId;
                this.activeProcesses.set(currentSessionId, session);
              }
            }
            if (parsed.type === 'result' && parsed.cost_usd !== undefined) {
              costUsd = parsed.cost_usd as number;
            }
          }
        }
      } catch (err) {
        logger.warn(`会话 ${sessionId ?? 'new'} 读取流失败: ${err}`);
      }
    })();

    let exitCode: number | null = null;
    const exitPromise = (async () => {
      exitCode = await proc.exited;
    })();

    const timeoutCheck = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startTime;

      if (elapsed >= hardTimeout) {
        logger.warn(`会话 ${sessionId ?? 'new'} 硬超时 (${hardTimeout}ms)，强制终止`);
        terminateProcessTree(procPid);
        clearInterval(timeoutCheck);
        return;
      }

      if (now - lastOutputAt >= staleTimeout) {
        logger.warn(`会话 ${sessionId ?? 'new'} 空闲超时 (${staleTimeout}ms 无输出)，强制终止`);
        terminateProcessTree(procPid);
        clearInterval(timeoutCheck);
        return;
      }
    }, 1000);

    await Promise.race([exitPromise, sleep(hardTimeout + 5000)]);
    clearInterval(timeoutCheck);

    // I9: Ensure read stream is fully consumed before extracting response
    await readPromise;

    // C3: Only SIGKILL if process is still alive (exitCode is still null)
    if (exitCode === null) {
      try {
        process.kill(procPid, 0);
        process.kill(procPid, 'SIGKILL');
      } catch {
        // already dead
      }
    }

    // Remove from active processes
    this.activeProcesses.delete(trackKey);
    if (currentSessionId && trackKey !== currentSessionId) {
      this.activeProcesses.delete(currentSessionId);
    }

    // I8: Extract response text in a single pass
    const finalResponse = responseLines
      .flatMap(line => {
        const parsed = parseJsonlLine(line);
        if (!parsed) return [line]; // non-JSON line, keep as-is
        const text = extractAssistantText(parsed);
        return text ? [text] : [];
      })
      .join('\n');

    const durationMs = Date.now() - startTime;
    const resolvedSessionId = currentSessionId ?? sessionId ?? '';

    let sessionStatus: 'active' | 'provisioning' | 'degraded' = 'active';
    if (exitCode !== 0 && exitCode !== null) {
      sessionStatus = 'degraded';
    }

    let jsonlPath: string | null = null;
    if (isNew && resolvedSessionId) {
      jsonlPath = await resolveJsonlPath(resolvedSessionId);
    }

    return {
      response: finalResponse,
      costUsd,
      durationMs,
      sessionId: resolvedSessionId,
      jsonlPath,
      sessionStatus,
    };
  }

  /** Acquire per-session lock to prevent concurrent messages to same session */
  private async acquireSessionLock(key: string): Promise<void> {
    const hardTimeout = config.get<number>('runtime.hard_timeout_ms', 30 * 60 * 1000);
    while (true) {
      const existing = this.sessionLocks.get(key);
      if (!existing) break;
      // I4: Add timeout to prevent infinite wait if lock holder crashes
      try {
        await Promise.race([
          existing.promise,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`session lock timeout for ${key}`)), hardTimeout)
          ),
        ]);
      } catch {
        // Timeout — clean up stale lock to prevent future waits
        this.sessionLocks.delete(key);
      }
    }

    let release: (() => void) | null = null;
    const lock: SessionLock = {
      promise: new Promise<void>(resolve => {
        release = resolve;
      }),
      release: release!,
    };
    this.sessionLocks.set(key, lock);
  }

  // S1: Type-safe release
  private releaseSessionLock(key: string): void {
    const lock = this.sessionLocks.get(key);
    if (lock) {
      lock.release();
    }
    this.sessionLocks.delete(key);
  }

  /** Acquire global concurrency slot */
  private async acquireSlot(): Promise<void> {
    while (this.runningProcesses >= this.maxConcurrent) {
      await new Promise<void>(resolve => {
        this.processWaiters.push(resolve);
      });
    }
    this.runningProcesses++;
  }

  private releaseSlot(): void {
    this.runningProcesses--;
    const waiter = this.processWaiters.shift();
    if (waiter) waiter();
  }

  /** List currently tracked active processes/sessions */
  listSessions(): ClaudeSession[] {
    return Array.from(this.activeProcesses.values());
  }

  /** Kill idle sessions that haven't produced output within timeout */
  cleanupIdleSessions(idleTimeoutMs: number): void {
    const now = Date.now();
    const toKill: ClaudeSession[] = [];

    for (const session of this.activeProcesses.values()) {
      if (now - session.lastOutputAt >= idleTimeoutMs) {
        toKill.push(session);
      }
    }

    for (const session of toKill) {
      const key = session.sessionId || `pid:${session.pid}`;
      logger.info(`清理空闲会话: ${key} (PID: ${session.pid})`);
      terminateProcessTree(session.pid);
      this.activeProcesses.delete(key);
      // Also clean session lock to prevent deadlock on next message
      this.sessionLocks.delete(key);
    }
  }
}

export const sessionManager = new ClaudeSessionManager();
