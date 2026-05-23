import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR } from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { StreamParser, StreamChunk, ResultChunk } from './stream-parser';

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
  error?: string;
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
    // Anchor to start of command line to avoid matching user message content
    const result = Bun.spawnSync(['pgrep', '-u', String(uid), '-f', '^claude -p.*--output-format json'], {
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

interface ClaudeJsonOutput {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  errors?: string[];
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
    isNew?: boolean,
    lockKey?: string,
  ): Promise<SendMessageResult> {
    const resolvedLockKey = lockKey ?? sessionId ?? '__new__';
    await this.acquireSessionLock(resolvedLockKey);

    try {
      await this.acquireSlot();

      try {
        return await this._doSendMessage(sessionId, text, cwd, isNew ?? false);
      } finally {
        this.releaseSlot();
      }
    } finally {
      this.releaseSessionLock(resolvedLockKey);
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

    // Resolve full path to Claude binary to avoid PATH issues in daemon/env
    const resolvedBin = Bun.which(args[0]);
    if (!resolvedBin) {
      const currentPath = process.env.PATH ?? '(未设置)';
      return {
        response: `Claude CLI 未找到: "${args[0]}" 不在 PATH 中。当前 PATH: ${currentPath.slice(0, 500)}`,
        costUsd: 0,
        durationMs: 0,
        sessionId: sessionId ?? '',
        jsonlPath: null,
        sessionStatus: 'degraded',
      };
    }
    args[0] = resolvedBin;

    const startTime = Date.now();
    let lastOutputAt = startTime;
    let stdoutText = '';
    let stderrText = '';

    const staleTimeout = config.get<number>('runtime.stale_timeout_ms', 5 * 60 * 1000);
    const hardTimeout = config.get<number>('runtime.hard_timeout_ms', 30 * 60 * 1000);

    let proc;
    try {
      proc = Bun.spawn(args, {
        cwd: expandedCwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // C2: Create detached process group for proper process tree killing
        detached: true,
      });
    } catch (err: any) {
      const isENOENT = err.code === 'ENOENT' || err.message?.includes('ENOENT');
      let diag = `Failed to start Claude process: ${err.message}`;
      if (isENOENT) {
        try {
          const f = Bun.file(args[0]);
          const exists = await f.exists();
          const stat = exists ? await f.stat() : null;
          const isSym = stat && (stat as any).mode !== undefined ? ((stat.mode ?? 0) & 0o170000) === 0o120000 : false;
          diag += ` [诊断: path=${args[0]}, exists=${exists}`;
          if (stat) {
            diag += `, size=${stat.size}, mode=${(stat.mode ?? 0).toString(8)}`;
          }
          diag += `, cwd=${expandedCwd}, PATH=${(process.env.PATH ?? '').slice(0, 200)}]`;
        } catch (derr: any) {
          diag += ` [诊断失败: ${derr.message}]`;
        }
        diag += ' (提示: 请确认 Claude CLI 已安装，或在 config.toml 中设置 general.claude_bin 为正确路径)';
      }
      return {
        response: diag,
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

    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    const readStream = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      onChunk: (chunk: string) => void,
    ) => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          onChunk(chunk);
          lastOutputAt = Date.now();
          session.lastOutputAt = lastOutputAt;
        }
      } catch (err) {
        logger.warn(`会话 ${sessionId ?? 'new'} 读取流失败: ${err}`);
      }
    };

    const readPromise = Promise.all([
      readStream(stdoutReader, (chunk) => { stdoutText += chunk; }),
      readStream(stderrReader, (chunk) => { stderrText += chunk; }),
    ]);

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

    const durationMs = Date.now() - startTime;
    let parsed: ClaudeJsonOutput | null = null;

    try {
      parsed = JSON.parse(stdoutText.trim()) as ClaudeJsonOutput;
    } catch {
      parsed = null;
    }

    const resolvedSessionId = parsed?.session_id ?? sessionId ?? '';
    const finalResponse = parsed?.result?.trim() || '';
    const baseError = parsed?.errors?.join('; ') || stderrText.trim();
    const hasExecutionError = Boolean(parsed?.is_error) || (exitCode !== 0 && exitCode !== null);

    let jsonlPath: string | null = null;
    let sessionStatus: 'active' | 'provisioning' | 'degraded' = hasExecutionError ? 'degraded' : 'active';

    if (isNew && resolvedSessionId) {
      jsonlPath = await resolveJsonlPath(resolvedSessionId);
      if (!jsonlPath && sessionStatus === 'active') {
        sessionStatus = 'provisioning';
      }
    }

    let error: string | undefined;
    if (hasExecutionError) {
      error = baseError || 'unknown_error';
    } else if (isNew && !resolvedSessionId) {
      const stdoutPreview = stdoutText.trim().slice(0, 300);
      const stderrPreview = stderrText.trim().slice(0, 300);
      error = `Claude 未返回 session_id。exitCode=${exitCode}, stdout=${stdoutPreview || '(空)'}, stderr=${stderrPreview || '(空)'}`;
    }

    return {
      response: finalResponse || (hasExecutionError ? `Claude 执行失败: ${baseError || '未知错误'}` : '(空回复)'),
      costUsd: parsed?.total_cost_usd ?? 0,
      durationMs: parsed?.duration_ms ?? durationMs,
      sessionId: resolvedSessionId,
      jsonlPath,
      sessionStatus,
      error,
    };
  }

  /**
   * Send a message to a Claude session with streaming output.
   * Uses --output-format stream-json and calls onProgress for each chunk.
   */
  async sendStreamingMessage(
    sessionId: string | null,
    text: string,
    cwd: string,
    onProgress: (chunk: StreamChunk) => void,
    isNew?: boolean,
    lockKey?: string,
  ): Promise<SendMessageResult> {
    const resolvedLockKey = lockKey ?? sessionId ?? '__new__';
    await this.acquireSessionLock(resolvedLockKey);

    try {
      await this.acquireSlot();

      try {
        return await this._doStreamingMessage(sessionId, text, cwd, onProgress, isNew ?? false);
      } finally {
        this.releaseSlot();
      }
    } finally {
      this.releaseSessionLock(resolvedLockKey);
    }
  }

  /** Core streaming message sending logic */
  private async _doStreamingMessage(
    sessionId: string | null,
    text: string,
    cwd: string,
    onProgress: (chunk: StreamChunk) => void,
    isNew: boolean,
  ): Promise<SendMessageResult> {
    const claudeBin = config.get<string>('general.claude_bin', 'claude');
    const args: string[] = [claudeBin, '--print', '-p', text, '--output-format', 'stream-json', '--verbose'];

    if (sessionId && !isNew) {
      args.push('--resume', sessionId);
    }

    const expandedCwd = expandPath(cwd);
    if (!expandedCwd) return this._errorResult('cwd is empty', sessionId);

    const resolvedBin = Bun.which(args[0]);
    if (!resolvedBin) return this._errorResult(`Claude CLI 未找到: "${args[0]}" 不在 PATH 中`, sessionId);
    args[0] = resolvedBin;

    const startTime = Date.now();
    let lastOutputAt = startTime;
    let stderrText = '';

    const staleTimeout = config.get<number>('runtime.stale_timeout_ms', 5 * 60 * 1000);
    const hardTimeout = config.get<number>('runtime.hard_timeout_ms', 30 * 60 * 1000);

    let proc;
    try {
      proc = Bun.spawn(args, {
        cwd: expandedCwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });
    } catch (err: any) {
      return this._errorResult(`Failed to start Claude process: ${err.message}`, sessionId);
    }

    const procPid = proc.pid;
    const trackKey = sessionId ?? `pid:${procPid}`;
    this.activeProcesses.set(trackKey, {
      sessionId: sessionId ?? '',
      pid: procPid,
      cwd: expandedCwd,
      createdAt: startTime,
      lastOutputAt: startTime,
      isNew,
    });

    const parser = new StreamParser();
    const decoder = new TextDecoder();
    let stdoutBuffer = '';
    let lastResult: ResultChunk | null = null;

    const stdoutPromise = (async () => {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          lastOutputAt = Date.now();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const parsed = parser.parseLine(line);
            if (parsed) {
              if (parsed.type === 'result') lastResult = parsed as ResultChunk;
              else onProgress(parsed);
            }
          }
        }
        // Handle remaining buffer
        if (stdoutBuffer.trim()) {
          const parsed = parser.parseLine(stdoutBuffer);
          if (parsed) {
            if (parsed.type === 'result') lastResult = parsed as ResultChunk;
            else onProgress(parsed);
          }
        }
      } catch (err) {
        logger.warn(`Stream: read失败: ${err}`);
      }
    })();

    const stderrPromise = (async () => {
      const reader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrText += decoder.decode(value, { stream: true });
          lastOutputAt = Date.now();
        }
      } catch (err) {
        logger.warn(`Stream: stderr 读取失败: ${err}`);
      }
    })();

    let exitCode: number | null = null;
    const exitPromise = (async () => { exitCode = await proc.exited; })();

    const timeoutCheck = setInterval(() => {
      const now = Date.now();
      if (now - startTime >= hardTimeout || now - lastOutputAt >= staleTimeout) {
        terminateProcessTree(procPid);
        clearInterval(timeoutCheck);
      }
    }, 1000);

    await Promise.race([exitPromise, stdoutPromise, stderrPromise, sleep(hardTimeout + 5000)]);
    clearInterval(timeoutCheck);
    await Promise.allSettled([stdoutPromise, stderrPromise]);

    if (exitCode === null) {
      try { process.kill(procPid, 'SIGKILL'); } catch {}
    }
    this.activeProcesses.delete(trackKey);

    const durationMs = Date.now() - startTime;
    return this._buildStreamingResult(lastResult, exitCode, stderrText, sessionId, startTime, durationMs, isNew);
  }

  private _errorResult(message: string, sessionId: string | null): SendMessageResult {
    return {
      response: message,
      costUsd: 0,
      durationMs: 0,
      sessionId: sessionId ?? '',
      jsonlPath: null,
      sessionStatus: 'degraded',
    };
  }

  private async _buildStreamingResult(
    lastResult: ResultChunk | null,
    exitCode: number | null,
    stderrText: string,
    sessionId: string | null,
    startTime: number,
    durationMs: number,
    isNew: boolean,
  ): Promise<SendMessageResult> {
    let response = '';
    let resolvedSessionId = sessionId ?? '';
    let costUsd = 0;
    let hasError = false;
    let baseError = '';

    if (lastResult) {
      response = lastResult.result ?? '';
      resolvedSessionId = lastResult.session_id || resolvedSessionId;
      costUsd = lastResult.total_cost_usd ?? 0;
      hasError = Boolean(lastResult.is_error) || lastResult.subtype !== 'success';
      baseError = lastResult.errors?.join('; ') ?? '';
    }

    if (!response && exitCode !== 0) {
      response = `Claude 执行失败: ${baseError || stderrText.trim() || '未知错误'}`;
      hasError = true;
    }
    if (!response) response = '(空回复)';

    let jsonlPath: string | null = null;
    let sessionStatus: 'active' | 'provisioning' | 'degraded' = hasError ? 'degraded' : 'active';

    if (isNew && resolvedSessionId) {
      jsonlPath = await resolveJsonlPath(resolvedSessionId);
      if (!jsonlPath && sessionStatus === 'active') sessionStatus = 'provisioning';
    }

    return {
      response,
      costUsd,
      durationMs: lastResult?.duration_ms ?? durationMs,
      sessionId: resolvedSessionId,
      jsonlPath,
      sessionStatus,
      error: hasError ? (baseError || 'unknown_error') : undefined,
    };
  }

  /** Acquire per-session lock to prevent concurrent messages to same session */
  private async acquireSessionLock(key: string): Promise<void> {
    const lockTimeout = config.get<number>('runtime.session_lock_timeout_ms', 10 * 60 * 1000);
    while (true) {
      const existing = this.sessionLocks.get(key);
      if (!existing) break;
      // I4: Add timeout to prevent infinite wait if lock holder crashes
      try {
        await Promise.race([
          existing.promise,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`session lock timeout for ${key}`)), lockTimeout)
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
