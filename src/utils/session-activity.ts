import { withTimeout } from './async';
import { isSafeId } from './safe-id';
import {
  getClaudeProcessesByCwd,
  getDarwinClaudeProcesses,
  getLinuxClaudeProcesses,
  getProcessCPUTimeSeconds,
  type ProcessInfo,
} from './process-info';
import { ACTIVITY_DIR } from './paths';
import {
  appendFileSync, readFileSync, existsSync, statSync, mkdirSync,
  unlinkSync, writeFileSync, readdirSync, openSync, readSync, closeSync,
  realpathSync, readlinkSync,
} from 'fs';
import { join } from 'path';
import { config } from './config';
import { logger } from './logger';
import { PKG_VERSION } from '../version';

export { parsePsTimeToSeconds } from './process-info';

// === 类型定义 ===

export type ActivityConfidence = 'high' | 'medium' | 'low';
export type ActivitySource = 'marker' | 'cpu' | 'child' | 'mtime' | 'none';
export type ActivityPlatform = 'feishu' | 'cli';
export type MarkerAction = 'start' | 'end' | 'heartbeat';

export interface ActivityResult {
  isProcessing: boolean;
  confidence: ActivityConfidence;
  reason: string;
  source: ActivitySource;
}

export interface ActivityMarker {
  type: 'activity_marker';
  uuid: string;
  platform: ActivityPlatform;
  action: MarkerAction;
  timestamp: string;
  pid?: number;
  version: string;
}

export interface ChildResult {
  hasChildren: boolean;
  children: Array<{ pid: number; command: string }>;
}

export type DetectionDirection =
  | 'feishu-detects-cli'
  | 'cli-detects-feishu';

export interface ActivityEntry {
  sessionUuid?: string | null;
  cwd: string;
  jsonl_path: string | null;
}

// === Rotate 阈值 ===

// Validate sessionUuid to prevent path traversal in activityLogPath.
// Uses src/utils/safe-id.ts isSafeId() which also gates messageId/openId
// in bot.ts — single source of truth. Length cap 80 is the cmd: serialKey
// composition limit (cmd: + 80 + : + 80 + : + 80 + .json = 251 ≤ NAME_MAX 255).

// Track sessionUuids we've already warned about (to avoid log spam from
// per-chunk heartbeat calls)
const warnedSessionUuids = new Set<string>();

const MAX_ACTIVITY_LOG_BYTES = 64 * 1024;
const ROTATE_KEEP_RATIO = 0.5;
// Minimum time between rotations per session (30s). Caps IO cost on long
// streaming sessions while still preventing unbounded log growth. This is
// a best-effort cap, not a hard limit — the file can still grow past
// MAX_ACTIVITY_LOG_BYTES between rotations.
const MIN_ROTATE_INTERVAL_MS = 30_000;
// Track last rotation timestamp per session
const lastRotationAt = new Map<string, number>();

// === Sidecar 文件路径 ===

export function activityLogPath(sessionUuid: string): string {
  // Validate to prevent path traversal: sessionUuid must be a UUID.
  // Throw on invalid input rather than silently using a sanitized version,
  // because callers depend on the path being predictable for a given sessionUuid.
  if (!isSafeId(sessionUuid)) {
    throw new Error(`Invalid sessionUuid: ${JSON.stringify(sessionUuid)}`);
  }
  return join(ACTIVITY_DIR, `${sessionUuid}.log`);
}

// === 写入 marker ===

export function writeActivityMarker(
  sessionUuid: string,
  platform: ActivityPlatform,
  action: MarkerAction,
  pid?: number
): void {
  if (!sessionUuid) return;  // ★ 保护空字符串

  // Validate sessionUuid format to prevent path traversal
  if (!isSafeId(sessionUuid)) {
    if (!warnedSessionUuids.has(sessionUuid)) {
      warnedSessionUuids.add(sessionUuid);
      logger.warn(
        `writeActivityMarker: invalid sessionUuid ${JSON.stringify(sessionUuid)} ` +
        `(this is logged once per sessionUuid; subsequent calls will be silent)`
      );
    }
    return;
  }

  try {
    mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // 目录已存在
  }

  const marker: ActivityMarker = {
    type: 'activity_marker',
    uuid: `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform,
    action,
    timestamp: new Date().toISOString(),
    pid,
    version: PKG_VERSION,
  };

  // Rotate (best-effort, never throws - has its own try/catch internally)
  maybeRotateActivityLog(sessionUuid);

  // Write the new marker (separated from rotate so write failure doesn't
  // happen after file was already truncated by rotate)
  try {
    appendFileSync(activityLogPath(sessionUuid), JSON.stringify(marker) + '\n', { mode: 0o600 });
  } catch (err) {
    logger.warn(`写入 activity marker 失败: ${sessionUuid}: ${err}`);
  }
}

// === 读取最后一个 marker ===

export function readLastActivityMarker(sessionUuid: string): ActivityMarker | null {
  if (!sessionUuid) return null;

  // Validate sessionUuid format to prevent path traversal
  if (!isSafeId(sessionUuid)) {
    if (!warnedSessionUuids.has(sessionUuid)) {
      warnedSessionUuids.add(sessionUuid);
      logger.warn(
        `readLastActivityMarker: invalid sessionUuid ${JSON.stringify(sessionUuid)} ` +
        `(this is logged once per sessionUuid; subsequent calls will be silent)`
      );
    }
    return null;
  }

  const path = activityLogPath(sessionUuid);
  if (!existsSync(path)) return null;

  try {
    const stat = statSync(path);
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, stat.size - readSize);
      const tail = buffer.toString('utf8');
      const lines = tail.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'activity_marker') {
            return entry as ActivityMarker;
          }
        } catch {
          // 跳过解析失败行
        }
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    logger.warn(`读取 activity marker 失败: ${sessionUuid}: ${err}`);
    return null;
  }
}

// === Rotate + Cleanup ===

function maybeRotateActivityLog(sessionUuid: string): void {
  const path = activityLogPath(sessionUuid);
  try {
    const stat = statSync(path);
    if (stat.size <= MAX_ACTIVITY_LOG_BYTES) return;

    // Time-window guard: cap rotation frequency to avoid IO storm on long sessions.
    // A 30-min session with ~200B heartbeats per streaming chunk = thousands of writes
    // = hundreds of rotations at 64KB threshold. Without this guard, on slow disks
    // we'd do hundreds of read+write cycles = significant event-loop blocking.
    const lastRotation = lastRotationAt.get(sessionUuid) ?? 0;
    const now = Date.now();
    if (now - lastRotation < MIN_ROTATE_INTERVAL_MS) return;

    const content = readFileSync(path, 'utf8');
    const keepBytes = Math.floor(MAX_ACTIVITY_LOG_BYTES * ROTATE_KEEP_RATIO);
    const tail = content.slice(-keepBytes);
    const firstNewline = tail.indexOf('\n');
    const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;

    writeFileSync(path, trimmed, { mode: 0o600 });
    lastRotationAt.set(sessionUuid, now);
    logger.debug(`activity log 轮转: ${sessionUuid}, 保留 ${trimmed.length} bytes`);
  } catch (err) {
    logger.debug(`activity log 轮转失败: ${sessionUuid}: ${err}`);
  }
}

export function cleanupOldActivityLogs(maxAgeHours: number = 24, targetDir?: string): number {
  const dir = targetDir ?? ACTIVITY_DIR;
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        const stat = statSync(path);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(path);
          cleaned++;
        }
      } catch {}
    }
  } catch (err) {
    logger.warn(`清理 activity 日志失败: ${err}`);
  }

  // Prune stale lastRotationAt entries (>60s old) — the rotate throttle
  // won't fire for at least 30s after the last rotation, so anything older
  // than 2x that window is safe to drop. Prevents unbounded growth in
  // long-running bots that rotate many sessions over their lifetime.
  const rotationCutoff = Date.now() - MIN_ROTATE_INTERVAL_MS * 2;
  for (const [sessionUuid, ts] of lastRotationAt) {
    if (ts < rotationCutoff) {
      lastRotationAt.delete(sessionUuid);
    }
  }

  // Cap warnedSessionUuids to prevent pathological growth. In normal
  // operation this set is bounded by the number of distinct invalid UUIDs
  // the process has ever seen (typically tiny), but a misbehaving caller
  // could spray unique values forever. Keep the most recent 500.
  if (warnedSessionUuids.size > 1000) {
    // Map/Set preserve insertion order, so slice(-N) gives the newest N.
    const toKeep = Array.from(warnedSessionUuids).slice(-500);
    warnedSessionUuids.clear();
    for (const id of toKeep) warnedSessionUuids.add(id);
  }

  return cleaned;
}

// === CPU 采样 ===

// 不从 bun 导入 sleep，使用 setTimeout Promise 包装（与 session.ts:50 一致）
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function getInstantCPU(pid: number, durationMs: number = 1000): Promise<number> {
  const t1 = await getProcessCPUTimeSeconds(pid);
  await sleep(durationMs);
  const t2 = await getProcessCPUTimeSeconds(pid);

  const wallClockSec = durationMs / 1000;
  const cpuSec = t2 - t1;
  const cores = 1;  // macOS 容器/CI 可能不可靠
  return Math.max(0, Math.min(100 * cores, (cpuSec / wallClockSec) * 100));
}

export function findClaudeProcessByCwd(targetCwd: string): { pid: number; cwd: string } | null {
  let realTarget: string;
  try {
    realTarget = realpathSync(targetCwd);
  } catch (err) {
    logger.debug(`realpath 失败: ${targetCwd}: ${err}`);
    realTarget = targetCwd;
  }

  const candidates = getClaudeProcessesByCwd(realTarget);
  if (candidates.length === 0) {
    const fallback = getClaudeProcessesByCwd(targetCwd);
    if (fallback.length === 0) return null;
    return { pid: fallback[0].pid, cwd: fallback[0].cwd };
  }

  // 优先选择"纯交互式"进程（command 是 claude 或 claude --resume）
  // 避免选择 claude agents / background 进程（这些已在 process-info 中过滤，但双重保险）
  const interactive = candidates.find(c => {
    const cmd = c.command.trim();
    return cmd === 'claude' || cmd.startsWith('claude --resume');
  });
  if (interactive) {
    return { pid: interactive.pid, cwd: interactive.cwd };
  }

  return { pid: candidates[0].pid, cwd: candidates[0].cwd };
}

// === 子进程检测（递归深度 3） ===

export async function hasActiveChildProcesses(pid: number): Promise<ChildResult> {
  try {
    const result = Bun.spawnSync(['pgrep', '-P', String(pid)]);
    if (result.exitCode !== 0) {
      return { hasChildren: false, children: [] };
    }

    const childPids = new TextDecoder().decode(result.stdout)
      .split('\n').filter(Boolean).map(Number);

    const children = childPids
      .map(childPid => ({ pid: childPid, command: getProcessCommand(childPid) }))
      .filter(child =>
        !child.command.includes('shell-snapshot') &&
        !child.command.includes('zsh -c source') &&
        // 排除 MCP servers（长期运行，不是用户任务）
        !child.command.includes('/mcp/') &&
        !child.command.includes('minimax-coding-plan-mcp') &&
        // 排除 macOS caffeinate（系统唤醒工具）
        !child.command.startsWith('caffeinate') &&
        child.command.trim() !== ''
      );

    return { hasChildren: children.length > 0, children };
  } catch (err) {
    logger.debug(`子进程检测失败: pid=${pid}: ${err}`);
    return { hasChildren: false, children: [] };
  }
}

function getProcessCommand(pid: number): string {
  try {
    const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command=']);
    return new TextDecoder().decode(result.stdout).trim();
  } catch (err) {
    logger.debug(`获取进程命令失败: pid=${pid}: ${err}`);
    return '';
  }
}

export async function hasActiveDescendants(rootPid: number, depth: number = 3): Promise<ChildResult> {
  const all: Array<{ pid: number; command: string }> = [];
  const visited = new Set<number>([rootPid]);

  async function walk(pid: number, currentDepth: number) {
    if (currentDepth > depth) return;
    const result = await hasActiveChildProcesses(pid);
    for (const child of result.children) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      all.push(child);
      await walk(child.pid, currentDepth + 1);
    }
  }

  await walk(rootPid, 0);
  return { hasChildren: all.length > 0, children: all };
}

// === mtime 二次采样（JSONL 写入检测） ===

export async function isJSONLWrittenSince(
  jsonlPath: string,
  sampleMs: number = 500
): Promise<{ written: boolean; ageMs: number }> {
  if (!existsSync(jsonlPath)) return { written: false, ageMs: Infinity };

  const stat1 = await Bun.file(jsonlPath).stat();
  await sleep(sampleMs);
  const stat2 = await Bun.file(jsonlPath).stat();

  // 同时检查 size 增长和 mtime 变化（应对 truncate/replace 场景）
  if (stat2.size > stat1.size) return { written: true, ageMs: 0 };
  if (stat2.mtimeMs > stat1.mtimeMs) return { written: true, ageMs: 0 };
  return { written: false, ageMs: Date.now() - stat2.mtimeMs };
}

export class SessionActivityCache {
  private cache = new Map<string, { result: ActivityResult; expiresAt: number }>();
  private readonly TTL_MS: number;

  constructor(ttlMs?: number) {
    this.TTL_MS = ttlMs ?? config.get<number>('runtime.activity_cache_ttl_ms', 10_000);
  }

  get(key: string): ActivityResult | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
    this.cache.delete(key);
    return null;
  }

  set(key: string, result: ActivityResult): void {
    this.cache.set(key, { result, expiresAt: Date.now() + this.TTL_MS });
  }

  /**
   * 主动失效缓存。SDK 收到新 chunk 时调用，确保下一次检测拿到最新状态。
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

// === Marker 年龄判定 ===

function judgeMarkerAge(ageMs: number): { active: boolean; confidence: ActivityConfidence } {
  if (ageMs < 3 * 60 * 1000) {
    return { active: true, confidence: 'high' };
  }
  if (ageMs < 10 * 60 * 1000) {
    return { active: true, confidence: 'medium' };
  }
  const ttl = config.get<number>('runtime.activity_marker_ttl_ms', 30 * 60 * 1000);
  if (ageMs < ttl) {
    return { active: true, confidence: 'low' };
  }
  return { active: false, confidence: 'high' };
}

// === CPU 采样 ===

export interface CpuResult {
  isProcessing: boolean;
  confidence: ActivityConfidence;
  cpuPercent: number;
  reason: string;
}

export async function sampleCPU(cwd: string, timeoutMs: number = 3000): Promise<CpuResult> {
  return withTimeout(
    sampleCPUImpl(cwd),
    timeoutMs,
    { isProcessing: false, confidence: 'low' as ActivityConfidence, cpuPercent: 0, reason: 'sample_timeout' }
  );
}

async function sampleCPUImpl(cwd: string): Promise<CpuResult> {
  const proc = findClaudeProcessByCwd(cwd);
  if (!proc) {
    return { isProcessing: false, confidence: 'high', cpuPercent: 0, reason: 'no_process' };
  }

  const cpuPercent = await getInstantCPU(proc.pid, 1000);

  if (cpuPercent > 10) {
    return { isProcessing: true, confidence: 'high', cpuPercent, reason: `cpu_${cpuPercent.toFixed(1)}%` };
  }
  if (cpuPercent > 2) {
    return { isProcessing: true, confidence: 'medium', cpuPercent, reason: `cpu_${cpuPercent.toFixed(1)}%` };
  }
  return { isProcessing: false, confidence: 'high', cpuPercent, reason: `cpu_idle_${cpuPercent.toFixed(1)}%` };
}

// === 方向性检测 ===

async function detectCliActivity(entry: ActivityEntry): Promise<ActivityResult> {
  if (config.get<boolean>('runtime.cli_process_detection_enabled', true)) {
    const proc = findClaudeProcessByCwd(entry.cwd);
    if (proc) {
      logger.info(`[activity] Found claude process pid=${proc.pid} in ${entry.cwd}`);
      const childCheck = await hasActiveDescendants(proc.pid);
      if (childCheck.hasChildren) {
        const childNames = childCheck.children
          .map(c => c.command.split(' ')[0])
          .slice(0, 3)
          .join(', ');
        logger.info(`[activity] pid=${proc.pid} has children: ${childNames}`);
        return {
          isProcessing: true,
          confidence: 'high',
          reason: `executing: ${childNames}`,
          source: 'child',
        };
      }

      const cpuResult = await sampleCPU(entry.cwd);
      logger.info(`[activity] pid=${proc.pid} CPU=${cpuResult.cpuPercent.toFixed(1)}%`);
      if (cpuResult.isProcessing) {
        return {
          isProcessing: true,
          confidence: cpuResult.confidence,
          reason: cpuResult.reason,
          source: 'cpu',
        };
      }

      return {
        isProcessing: false,
        confidence: 'high',
        reason: 'cli_process_idle',
        source: 'cpu',
      };
    }

    // Fallback: 精确 cwd 匹配找不到进程时，全局搜索所有未被排除的 claude 进程的后代，
    // 查找用户任务子进程（bash/sleep/sh/zsh 等）。这覆盖 Claude Code CLI 的 background/daemon
    // 场景：用户任务子进程可能在 --bg-pty-host（cwd 在 /private/tmp）下运行。
    logger.info(`[activity] No claude process in ${entry.cwd}, scanning all claude processes for user tasks`);
    const uid = process.getuid?.() ?? 0;
    const allProcs = process.platform === 'linux'
      ? getLinuxClaudeProcesses(uid)
      : process.platform === 'darwin'
        ? getDarwinClaudeProcesses(uid)
        : [];
    for (const p of allProcs) {
      const childCheck = await hasActiveDescendants(p.pid);
      const userTasks = childCheck.children.filter(c => {
        const cmd = c.command.toLowerCase();
        return cmd.includes('bash') || cmd.includes('sh ') || cmd.includes('zsh') || cmd.includes('sleep');
      });
      if (userTasks.length > 0) {
        const taskNames = userTasks
          .map(c => c.command.split(' ')[0])
          .slice(0, 3)
          .join(', ');
        logger.info(`[activity] Found user tasks under pid=${p.pid}: ${taskNames}`);
        return {
          isProcessing: true,
          confidence: 'medium',
          reason: `executing: ${taskNames}`,
          source: 'child',
        };
      }
    }
  }

  if (entry.jsonl_path) {
    const mtimeResult = await isJSONLWrittenSince(entry.jsonl_path);
    if (mtimeResult.written) {
      return {
        isProcessing: true,
        confidence: 'medium',
        reason: 'jsonl_writing',
        source: 'mtime',
      };
    }
  }

  return { isProcessing: false, confidence: 'medium', reason: 'no_signals', source: 'none' };
}

async function detectFeishuActivity(entry: ActivityEntry): Promise<ActivityResult> {
  if (!entry.sessionUuid) {
    return { isProcessing: false, confidence: 'low', reason: 'no_session_uuid', source: 'none' };
  }

  const marker = readLastActivityMarker(entry.sessionUuid);
  if (!marker) {
    return { isProcessing: false, confidence: 'medium', reason: 'no_marker', source: 'none' };
  }

  if (marker.action === 'end') {
    return { isProcessing: false, confidence: 'high', reason: 'marker_end', source: 'marker' };
  }

  const ageMs = Date.now() - new Date(marker.timestamp).getTime();
  const judgment = judgeMarkerAge(ageMs);
  return {
    isProcessing: judgment.active,
    confidence: judgment.confidence,
    reason: judgment.active
      ? `marker_${marker.action}_${Math.floor(ageMs / 1000)}s_ago`
      : `marker_stale_${Math.floor(ageMs / 1000)}s_ago`,
    source: 'marker',
  };
}

// === 主入口 ===

const DETECTION_TIMEOUT_MS = 3000;

export async function isSessionActive(
  entry: ActivityEntry,
  cache: SessionActivityCache,
  direction: DetectionDirection,
  timeoutMs: number = DETECTION_TIMEOUT_MS
): Promise<ActivityResult> {
  const cacheKey = `${direction}:${entry.sessionUuid ?? entry.cwd}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = await withTimeout(
    detectActivity(entry, direction),
    timeoutMs,
    { isProcessing: false, confidence: 'low' as ActivityConfidence, reason: 'detection_timeout', source: 'none' as ActivitySource }
  );

  // Don't cache timeout-fallbacks: they signal "we don't know", not "definitely not active".
  // Caching would cause up to 10s of false negatives (next message goes through without re-checking).
  if (result.reason !== 'detection_timeout') {
    cache.set(cacheKey, result);
  }
  return result;
}

async function detectActivity(
  entry: ActivityEntry,
  direction: DetectionDirection
): Promise<ActivityResult> {
  if (direction === 'feishu-detects-cli') {
    return detectCliActivity(entry);
  }
  if (direction === 'cli-detects-feishu') {
    return detectFeishuActivity(entry);
  }
  return { isProcessing: false, confidence: 'low', reason: 'unknown_direction', source: 'none' };
}
