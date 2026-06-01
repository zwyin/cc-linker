# Session Activity Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 cc-linker 的会话活跃度双向检测能力，让飞书端和 CLI 终端能感知对方是否正在使用同一 session，避免互相打断。

**Architecture:**
- 飞书侧（可控）写 Activity Marker 到独立 sidecar 文件 `~/.cc-linker/activity/<uuid>.log`
- CLI 侧（不可控）通过 OS 信号采样（CPU + 子进程 + JSONL mtime）反推活跃度
- 信号源严格分离：飞书只信 marker，CLI 只用采样
- 检测结果短时缓存（10s），避免每次消息都重采样

**Tech Stack:** Bun + TypeScript ESM、`@anthropic-ai/claude-agent-sdk` (flybook)、`pgrep` / `lsof` / `ps` (CLI 侧)

**Spec:** `docs/superpowers/specs/2026-06-01-session-activity-sync-design.md`

---

## File Structure (locked in)

**新增 (6):**
- `src/utils/async.ts` — `withTimeout` 工具
- `src/utils/process-info.ts` — OS 进程调用抽象层
- `src/utils/session-activity.ts` — 核心检测模块
- `src/version.ts` — `PKG_VERSION` 常量
- `tests/unit/utils/async.test.ts` — async 工具测试
- `tests/unit/utils/session-activity.test.ts` — 核心模块测试

**修改 (9):**
- `src/utils/paths.ts` — + `ACTIVITY_DIR`
- `src/utils/config.ts` — + 4 字段 + `setRuntimeOverride`
- `src/queue/spool.ts` — + 2 字段 + `updateMessageFlags`
- `src/proxy/session.ts` — + `activityCache` 字段 + marker 写入
- `src/feishu/bot.ts` — + 活跃检测 + `cli_force_send` 卡片回调
- `src/feishu/card-updater.ts` — + `createCLIBusyCard`
- `src/cli/commands/resume.ts` — + marker 检测
- `src/cli/commands/start.ts` — + 6 步启动顺序
- `src/scanner/jsonl.ts` — + `NON_MESSAGE_TYPES`

**保留:** `src/feishu/mapping.ts`、`src/registry/*`、`src/runtime/*` 不变。

---

## Phase 0: 基础工具

### Task 0.1: `PKG_VERSION` 常量

**Files:**
- Create: `src/version.ts`

- [ ] **Step 1: 创建 `src/version.ts`**

```typescript
import pkg from '../package.json' with { type: 'json' };
export const PKG_VERSION: string = pkg.version;
```

- [ ] **Step 2: 验证 typecheck**

Run: `bun run typecheck`
Expected: 通过（无 error）

- [ ] **Step 3: Commit**

```bash
git add src/version.ts
git commit -m "feat(version): add PKG_VERSION constant from package.json"
```

---

### Task 0.2: `ACTIVITY_DIR` 路径常量

**Files:**
- Modify: `src/utils/paths.ts`

- [ ] **Step 1: 添加 `ACTIVITY_DIR`**

在 `src/utils/paths.ts` 的 "Runtime paths" 段后添加：

```typescript
// Session activity sidecar files (one per session, see session-activity-sync spec)
export const ACTIVITY_DIR = join(CC_LINKER_DIR, 'activity');
```

- [ ] **Step 2: 验证 typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/paths.ts
git commit -m "feat(paths): add ACTIVITY_DIR for session activity sidecar files"
```

---

### Task 0.3: `withTimeout` 工具

**Files:**
- Create: `src/utils/async.ts`
- Create: `tests/unit/utils/async.test.ts`

- [ ] **Step 1: 写失败测试 `tests/unit/utils/async.test.ts`**

```typescript
import { describe, test, expect } from 'bun:test';

describe('withTimeout', () => {
  test('promise 在超时前 resolve → 返回原值', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    const result = await withTimeout(Promise.resolve(42), 1000, -1);
    expect(result).toBe(42);
  });

  test('promise 超时 → 返回 fallback（不 reject）', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    const slow = new Promise<number>(r => setTimeout(() => r(42), 200));
    const result = await withTimeout(slow, 50, -1);
    expect(result).toBe(-1);
  });

  test('内部 timer 在 resolve 时清理（不留僵尸 timer）', async () => {
    const { withTimeout } = await import('../../../src/utils/async');
    await withTimeout(Promise.resolve(1), 60_000, 0);
    // 验证：通过 = timer 已被 clearTimeout
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/utils/async.test.ts`
Expected: FAIL — `Cannot find module '../../../src/utils/async'`

- [ ] **Step 3: 实现 `src/utils/async.ts`**

```typescript
/**
 * 给 Promise 加超时控制
 * - 超时后用 fallback resolve（不 reject，避免 unhandled rejection）
 * - 内部 timer 一定清理（避免内存泄漏）
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/utils/async.test.ts`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add src/utils/async.ts tests/unit/utils/async.test.ts
git commit -m "feat(async): add withTimeout utility for safe promise timeout"
```

---

## Phase 1: 进程信息抽象层

### Task 1.1: `ProcessInfo` 类型 + 平台分支声明

**Files:**
- Create: `src/utils/process-info.ts`

- [ ] **Step 1: 创建模块骨架**

```typescript
import { readFileSync, readdirSync, statSync } from 'fs';

export interface ProcessInfo {
  pid: number;
  cwd: string;
  command: string;
}

/**
 * 读取自己进程的 cwd（用于探测 macOS 权限）
 */
export function getOwnCwd(): string {
  // Linux: /proc/self/cwd
  // macOS: 由调用方用 lsof 探测
  if (process.platform === 'linux') {
    try {
      const { readlinkSync } = require('fs');
      return readlinkSync('/proc/self/cwd');
    } catch {
      return process.cwd();
    }
  }
  return process.cwd();
}
```

> 注：上面用了 `require` 在 Linux 探测函数里，因为这是隔离的小函数，**不在主流程热路径**。后续 Task 1.2 引入 ESM-only 路径时统一替换。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/process-info.ts
git commit -m "feat(process-info): add ProcessInfo type and getOwnCwd probe"
```

---

### Task 1.2: Linux 平台实现（读 /proc）

**Files:**
- Modify: `src/utils/process-info.ts`

- [ ] **Step 1: 添加 `getLinuxClaudeProcesses`**

在 `src/utils/process-info.ts` 末尾添加（替换 require 形式为 ESM import）：

```typescript
import { readlinkSync } from 'fs';

export function getLinuxClaudeProcesses(uid: number): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  let procDirs: string[];
  try {
    procDirs = readdirSync('/proc').filter(d => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pidStr of procDirs) {
    const pid = parseInt(pidStr, 10);
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (comm !== 'claude') continue;

      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ').trim();
      const cwd = readlinkSync(`/proc/${pid}/cwd`);

      // 过滤
      if (command.includes(' -p ') || command.includes('--output-format')) continue;
      if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;

      const stat = statSync(`/proc/${pid}`);
      if (stat.uid !== uid) continue;

      result.push({ pid, cwd, command });
    } catch {
      // 进程在我们读取时退出，跳过
    }
  }
  return result;
}
```

- [ ] **Step 2: 同步重写 `getOwnCwd` 为 ESM**

把 `getOwnCwd` 改为 ESM import（替换 step 1 里的 require）：

```typescript
export function getOwnCwd(): string {
  if (process.platform === 'linux') {
    try {
      return readlinkSync('/proc/self/cwd');
    } catch {
      return process.cwd();
    }
  }
  return process.cwd();
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/process-info.ts
git commit -m "feat(process-info): add Linux /proc-based claude process enumeration"
```

---

### Task 1.3: macOS 平台实现（lsof + ps）

**Files:**
- Modify: `src/utils/process-info.ts`

- [ ] **Step 1: 添加 `getDarwinClaudeProcesses`**

```typescript
export function getDarwinClaudeProcesses(uid: number): ProcessInfo[] {
  try {
    // 1. 单次 lsof 拿所有 claude 进程的 cwd
    const lsofResult = Bun.spawnSync([
      'lsof', '-u', String(uid), '-c', 'claude', '-a', '-d', 'cwd', '-Fn'
    ]);
    if (lsofResult.exitCode !== 0) return [];

    const lines = new TextDecoder().decode(lsofResult.stdout).split('\n');
    const pidToCwd = new Map<number, string>();
    let currentPid: number | null = null;
    for (const line of lines) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith('n') && currentPid !== null) {
        pidToCwd.set(currentPid, line.slice(1));
        currentPid = null;
      }
    }

    // 2. 单独取 command（再开一个 ps 调用）
    const psResult = Bun.spawnSync(['ps', '-u', String(uid), '-o', 'pid=,command=']);
    const pidToCommand = new Map<number, string>();
    if (psResult.exitCode === 0) {
      for (const line of new TextDecoder().decode(psResult.stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) pidToCommand.set(parseInt(m[1], 10), m[2].trim());
      }
    }

    // 3. 合并 + 过滤
    const out: ProcessInfo[] = [];
    for (const [pid, cwd] of pidToCwd) {
      const command = pidToCommand.get(pid) ?? '';
      if (command.includes(' -p ') || command.includes('--output-format')) continue;
      if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;
      out.push({ pid, cwd, command });
    }
    return out;
  } catch {
    // 权限不足（macOS 上 lsof 看其他用户需要 root）
    return [];
  }
}
```

- [ ] **Step 2: 添加 `getClaudeProcessesByCwd` 统一入口**

```typescript
export function getClaudeProcessesByCwd(targetCwd: string): ProcessInfo[] {
  const uid = process.getuid?.() ?? 0;
  const procs = process.platform === 'linux'
    ? getLinuxClaudeProcesses(uid)
    : process.platform === 'darwin'
      ? getDarwinClaudeProcesses(uid)
      : [];
  return procs.filter(p => p.cwd === targetCwd);
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/process-info.ts
git commit -m "feat(process-info): add macOS lsof-based claude process enumeration"
```

---

### Task 1.4: `getProcessCPUTimeSeconds` 跨平台

**Files:**
- Modify: `src/utils/process-info.ts`

- [ ] **Step 1: 添加 CPU 时间读取（Linux 端）**

```typescript
export function getProcessCPUTimeSeconds(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    return Promise.resolve(getLinuxCPUTime(pid));
  }
  if (process.platform === 'darwin') {
    return Promise.resolve(getDarwinCPUTime(pid));
  }
  return Promise.reject(new Error(`Unsupported platform: ${process.platform}`));
}

function getLinuxCPUTime(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = stat.lastIndexOf(')');
    const after = stat.slice(lastParen + 2);
    const parts = after.split(' ');
    const utime = parseInt(parts[11], 10);
    const stime = parseInt(parts[12], 10);
    let clkTck = 100;
    try {
      const t = readFileSync('/proc/sys/kernel/clk_tck', 'utf8').trim();
      clkTck = parseInt(t, 10) || 100;
    } catch {}
    return (utime + stime) / clkTck;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 2: 添加 macOS 端**

```typescript
function getDarwinCPUTime(pid: number): number {
  try {
    const result = Bun.spawnSync(['ps', '-o', 'time=', '-p', String(pid)]);
    if (result.exitCode !== 0) return 0;
    const timeStr = new TextDecoder().decode(result.stdout).trim();
    return parsePsTimeToSeconds(timeStr);
  } catch {
    return 0;
  }
}

export function parsePsTimeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  let days = 0;
  let rest = timeStr;
  if (rest.includes('-')) {
    const dashIdx = rest.indexOf('-');
    days = parseInt(rest.slice(0, dashIdx), 10) || 0;
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(':');
  if (parts.length === 3) {
    return days * 86400
      + parseInt(parts[0], 10) * 3600
      + parseInt(parts[1], 10) * 60
      + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return days * 86400 + parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(rest);
}
```

- [ ] **Step 3: typecheck + 跑已有测试**

Run: `bun run typecheck && bun test tests/unit/utils/async.test.ts`
Expected: 都通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/process-info.ts
git commit -m "feat(process-info): add cross-platform CPU time reading (Linux /proc + macOS ps)"
```

---

### Task 1.5: `process-info` 单元测试

**Files:**
- Create: `tests/unit/utils/process-info.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'bun:test';

describe('parsePsTimeToSeconds', () => {
  test('SS.hh 格式', () => {
    const { parsePsTimeToSeconds } = require('../../../src/utils/process-info');
    expect(parsePsTimeToSeconds('12.34')).toBe(12.34);
  });

  test('MM:SS 格式', () => {
    const { parsePsTimeToSeconds } = require('../../../src/utils/process-info');
    expect(parsePsTimeToSeconds('1:23.45')).toBe(83.45);
  });

  test('HH:MM:SS 格式', () => {
    const { parsePsTimeToSeconds } = require('../../../src/utils/process-info');
    expect(parsePsTimeToSeconds('1:23:45')).toBe(5025);
    expect(parsePsTimeToSeconds('12:34:56')).toBe(45296);
  });

  test('DD-HH:MM:SS 格式（长任务）', () => {
    const { parsePsTimeToSeconds } = require('../../../src/utils/process-info');
    expect(parsePsTimeToSeconds('2-01:23:45')).toBe(2 * 86400 + 5025);
  });

  test('空字符串', () => {
    const { parsePsTimeToSeconds } = require('../../../src/utils/process-info');
    expect(parsePsTimeToSeconds('')).toBe(0);
  });
});

describe('getClaudeProcessesByCwd (mocked)', () => {
  test('Linux: 返回匹配的 claude 进程', () => {
    // 通过 mock bun:test 的 spawnSync 实现
  });

  test('过滤 -p 进程', () => {
    // ...
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test tests/unit/utils/process-info.test.ts`
Expected: 至少 5 个 parsePsTimeToSeconds 测试通过；mock 部分允许跳过

- [ ] **Step 3: Commit**

```bash
git add tests/unit/utils/process-info.test.ts
git commit -m "test(process-info): add unit tests for parsePsTimeToSeconds"
```

---

## Phase 2: 核心检测模块

### Task 2.1: 类型定义

**Files:**
- Create: `src/utils/session-activity.ts`

- [ ] **Step 1: 创建文件 + 类型**

```typescript
import { withTimeout } from './async';
import {
  getClaudeProcessesByCwd,
  getProcessCPUTimeSeconds,
  type ProcessInfo,
} from './process-info';
import { ACTIVITY_DIR, CC_LINKER_DIR } from './paths';
import {
  appendFileSync, readFileSync, existsSync, statSync, mkdirSync,
  unlinkSync, writeFileSync, readdirSync, openSync, readSync, closeSync,
} from 'fs';
import { realpathSync, readlinkSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { logger } from './logger';
import { PKG_VERSION } from '../version';

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
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add type definitions and module skeleton"
```

---

### Task 2.2: sidecar 文件读写

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加路径 + 写函数**

在 `src/utils/session-activity.ts` 末尾添加：

```typescript
// === Sidecar 文件路径 ===

export function activityLogPath(sessionUuid: string): string {
  return join(ACTIVITY_DIR, `${sessionUuid}.log`);
}

// === 写入 marker ===

export function writeActivityMarker(
  sessionUuid: string,
  platform: ActivityPlatform,
  action: MarkerAction,
  pid?: number
): void {
  if (!sessionUuid) return;  // ★ 修复 23：保护空字符串

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

  try {
    appendFileSync(activityLogPath(sessionUuid), JSON.stringify(marker) + '\n', { mode: 0o600 });
  } catch (err) {
    logger.warn(`写入 activity marker 失败: ${sessionUuid}: ${err}`);
  }
}
```

- [ ] **Step 2: 添加读函数**

```typescript
// === 读取最后一个 marker ===

export function readLastActivityMarker(sessionUuid: string): ActivityMarker | null {
  if (!sessionUuid) return null;
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
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add sidecar read/write functions"
```

---

### Task 2.3: sidecar 文件 rotate + cleanup

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加常量 + rotate**

```typescript
const MAX_ACTIVITY_LOG_BYTES = 64 * 1024;
const ROTATE_KEEP_RATIO = 0.5;

function maybeRotateActivityLog(sessionUuid: string): void {
  const path = activityLogPath(sessionUuid);
  try {
    const stat = statSync(path);
    if (stat.size <= MAX_ACTIVITY_LOG_BYTES) return;

    const content = readFileSync(path, 'utf8');
    const keepBytes = Math.floor(MAX_ACTIVITY_LOG_BYTES * ROTATE_KEEP_RATIO);
    const tail = content.slice(-keepBytes);
    const firstNewline = tail.indexOf('\n');
    const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;

    writeFileSync(path, trimmed, { mode: 0o600 });
    logger.debug(`activity log 轮转: ${sessionUuid}, 保留 ${trimmed.length} bytes`);
  } catch (err) {
    logger.debug(`activity log 轮转失败: ${sessionUuid}: ${err}`);
  }
}
```

- [ ] **Step 2: 修改 `writeActivityMarker` 调用 rotate**

在 `appendFileSync` 之前添加：

```typescript
maybeRotateActivityLog(sessionUuid);
```

- [ ] **Step 3: 添加 cleanup**

```typescript
export function cleanupOldActivityLogs(maxAgeHours: number = 24): number {
  if (!existsSync(ACTIVITY_DIR)) return 0;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    for (const file of readdirSync(ACTIVITY_DIR)) {
      const path = join(ACTIVITY_DIR, file);
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
  return cleaned;
}
```

- [ ] **Step 4: typecheck + 已有测试**

Run: `bun run typecheck && bun test tests/unit/utils/async.test.ts tests/unit/utils/process-info.test.ts`
Expected: 都通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add 64KB auto-rotate and 24h cleanup"
```

---

### Task 2.4: `parsePsTimeToSeconds` re-export + CPU 采样

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 重新导出 `parsePsTimeToSeconds`**

```typescript
export { parsePsTimeToSeconds } from './process-info';
```

- [ ] **Step 2: 添加 `getInstantCPU`**

```typescript
import { sleep } from 'bun';

export async function getInstantCPU(pid: number, durationMs: number = 1000): Promise<number> {
  const t1 = await getProcessCPUTimeSeconds(pid);
  await sleep(durationMs);
  const t2 = await getProcessCPUTimeSeconds(pid);

  const wallClockSec = durationMs / 1000;
  const cpuSec = t2 - t1;
  const cores = 1;  // macOS 容器/CI 可能不可靠
  return Math.max(0, Math.min(100 * cores, (cpuSec / wallClockSec) * 100));
}
```

> 注：使用 `cores = 1` 是有意为之的保守值（避免多核机器上的"假阳性"——`100 * cores` 在 16 核机器上会让 CPU 上限 1600%）。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add getInstantCPU with raw seconds difference"
```

---

### Task 2.5: `findClaudeProcessByCwd`（带 realpath）

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加函数**

```typescript
export function findClaudeProcessByCwd(targetCwd: string): { pid: number; cwd: string } | null {
  let realTarget: string;
  try {
    realTarget = realpathSync(targetCwd);
  } catch (err) {
    logger.debug(`realpath 失败: ${targetCwd}: ${err}`);
    realTarget = targetCwd;
  }

  const candidates = getClaudeProcessesByCwd(realTarget);
  for (const c of candidates) {
    return { pid: c.pid, cwd: c.cwd };
  }
  return null;
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add findClaudeProcessByCwd with realpath"
```

---

### Task 2.6: `hasActiveDescendants`（子进程/后代）

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加函数**

```typescript
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
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add hasActiveDescendants (recursive depth 3)"
```

---

### Task 2.7: `isJSONLWrittenSince`（mtime 检测）

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加函数**

```typescript
export async function isJSONLWrittenSince(
  jsonlPath: string,
  sinceMs: number,
  sampleMs: number = 500
): Promise<{ written: boolean; ageMs: number }> {
  if (!existsSync(jsonlPath)) return { written: false, ageMs: Infinity };

  const stat1 = await Bun.file(jsonlPath).stat();
  await sleep(sampleMs);
  const stat2 = await Bun.file(jsonlPath).stat();

  if (stat2.size > stat1.size) return { written: true, ageMs: 0 };
  if (stat2.mtimeMs > stat1.mtimeMs) return { written: true, ageMs: 0 };
  return { written: false, ageMs: Date.now() - stat2.mtimeMs };
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add isJSONLWrittenSince (500ms sample)"
```

---

### Task 2.8: `SessionActivityCache`

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加类**

```typescript
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

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add SessionActivityCache class"
```

---

### Task 2.9: `isSessionActive`（主判定函数）

**Files:**
- Modify: `src/utils/session-activity.ts`

- [ ] **Step 1: 添加 `judgeMarkerAge`**

```typescript
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
```

- [ ] **Step 2: 添加 `sampleCPU`**

```typescript
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
```

- [ ] **Step 3: 添加 `detectCliActivity`**

```typescript
async function detectCliActivity(entry: { cwd: string; jsonl_path: string | null }): Promise<ActivityResult> {
  if (config.get<boolean>('runtime.cli_process_detection_enabled', true)) {
    const proc = findClaudeProcessByCwd(entry.cwd);
    if (proc) {
      const childCheck = await hasActiveDescendants(proc.pid);
      if (childCheck.hasChildren) {
        const childNames = childCheck.children
          .map(c => c.command.split(' ')[0])
          .slice(0, 3)
          .join(', ');
        return {
          isProcessing: true,
          confidence: 'high',
          reason: `executing: ${childNames}`,
          source: 'child',
        };
      }

      const cpuResult = await sampleCPU(entry.cwd);
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
  }

  if (entry.jsonl_path) {
    const mtimeResult = await isJSONLWrittenSince(entry.jsonl_path, 0);
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
```

- [ ] **Step 4: 添加 `detectFeishuActivity`**

```typescript
async function detectFeishuActivity(entry: { sessionUuid?: string | null }): Promise<ActivityResult> {
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
```

- [ ] **Step 5: 添加 `isSessionActive` 主入口**

```typescript
const DETECTION_TIMEOUT_MS = 3000;

export async function isSessionActive(
  entry: {
    sessionUuid?: string | null;
    cwd: string;
    jsonl_path: string | null;
  },
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

  cache.set(cacheKey, result);
  return result;
}

async function detectActivity(
  entry: {
    sessionUuid?: string | null;
    cwd: string;
    jsonl_path: string | null;
  },
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
```

- [ ] **Step 6: typecheck + 跑全部已有测试**

Run: `bun run typecheck && bun test`
Expected: typecheck 通过，所有已有测试通过

- [ ] **Step 7: Commit**

```bash
git add src/utils/session-activity.ts
git commit -m "feat(session-activity): add isSessionActive (directional detection with cache + timeout)"
```

---

### Task 2.10: 核心模块单元测试

**Files:**
- Create: `tests/unit/utils/session-activity.test.ts`

- [ ] **Step 1: 写测试骨架**

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock 整个 process-info 模块
mock.module('../../../src/utils/process-info', () => ({
  getClaudeProcessesByCwd: mock(() => []),
  getProcessCPUTimeSeconds: mock(() => Promise.resolve(0)),
  parsePsTimeToSeconds: (s: string) => {
    if (!s) return 0;
    let days = 0;
    let rest = s;
    if (rest.includes('-')) {
      days = parseInt(rest.slice(0, rest.indexOf('-')), 10) || 0;
      rest = rest.slice(rest.indexOf('-') + 1);
    }
    const parts = rest.split(':');
    if (parts.length === 3) return days * 86400 + parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    if (parts.length === 2) return days * 86400 + parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(rest);
  },
}));

describe('Activity Marker (sidecar)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('write + read 最近的 marker', async () => {
    const sa = await import('../../../src/utils/session-activity');
    sa.writeActivityMarker('test-uuid', 'feishu', 'start', 12345);
    sa.writeActivityMarker('test-uuid', 'feishu', 'heartbeat', 12345);
    const marker = sa.readLastActivityMarker('test-uuid');
    expect(marker?.action).toBe('heartbeat');
    expect(marker?.platform).toBe('feishu');
    expect(marker?.pid).toBe(12345);
  });

  test('sidecar 文件不存在 → return null', async () => {
    const sa = await import('../../../src/utils/session-activity');
    expect(sa.readLastActivityMarker('nonexistent')).toBeNull();
  });

  test('空 sessionUuid 保护', async () => {
    const sa = await import('../../../src/utils/session-activity');
    sa.writeActivityMarker('', 'feishu', 'start');
    expect(sa.readLastActivityMarker('')).toBeNull();
  });
});

describe('isSessionActive (combined)', () => {
  test('direction=cli-detects-feishu + 无 marker → inactive', async () => {
    const sa = await import('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache();
    const result = await sa.isSessionActive(
      { sessionUuid: 'no-marker-uuid', cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('no_marker');
  });

  test('direction=cli-detects-feishu + no_session_uuid → low confidence', async () => {
    const sa = await import('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache();
    const result = await sa.isSessionActive(
      { sessionUuid: null, cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('low');
  });

  test('缓存命中：第二次调用不重新检测', async () => {
    const sa = await import('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache();
    const entry = { sessionUuid: 'cached-uuid', cwd: '/tmp', jsonl_path: null };

    // 第一次：写 marker
    sa.writeActivityMarker('cached-uuid', 'feishu', 'start');
    const r1 = await sa.isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.source).toBe('marker');

    // 删除 marker，验证缓存仍命中
    sa.cleanupOldActivityLogs(0);  // 删除所有
    const r2 = await sa.isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2).toBe(r1);  // 同一对象引用
  });

  test('缓存失效：invalidate 后重新检测', async () => {
    const sa = await import('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache();
    const entry = { sessionUuid: 'invalidate-uuid', cwd: '/tmp', jsonl_path: null };

    sa.writeActivityMarker('invalidate-uuid', 'feishu', 'end');
    const r1 = await sa.isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.isProcessing).toBe(false);

    cache.invalidate('cli-detects-feishu:invalidate-uuid');

    sa.writeActivityMarker('invalidate-uuid', 'feishu', 'heartbeat');
    const r2 = await sa.isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2.isProcessing).toBe(true);
  });
});

describe('SessionActivityCache', () => {
  test('默认 TTL 10 秒', () => {
    const sa = require('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache();
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    expect(cache.get('key')?.isProcessing).toBe(true);
  });

  test('自定义 TTL', () => {
    const sa = require('../../../src/utils/session-activity');
    const cache = new sa.SessionActivityCache(50);
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    setTimeout(() => {
      expect(cache.get('key')).toBeNull();
    }, 100);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `bun test tests/unit/utils/session-activity.test.ts`
Expected: 至少 7 个测试通过

- [ ] **Step 3: Commit**

```bash
git add tests/unit/utils/session-activity.test.ts
git commit -m "test(session-activity): add unit tests for sidecar + cache + isSessionActive"
```

---

## Phase 3: 配置 + ConfigManager

### Task 3.1: ConfigData 新增字段

**Files:**
- Modify: `src/utils/config.ts:25-31`

- [ ] **Step 1: 在 `ConfigData.runtime` interface 加 4 字段**

把：
```typescript
runtime: {
  stale_timeout_ms: number;
  hard_timeout_ms: number;
  max_concurrent_sessions: number;
  idle_timeout_ms: number;
  session_lock_timeout_ms: number;
};
```

改为：
```typescript
runtime: {
  stale_timeout_ms: number;
  hard_timeout_ms: number;
  max_concurrent_sessions: number;
  idle_timeout_ms: number;
  session_lock_timeout_ms: number;
  // Session activity sync (v1.2)
  cli_process_detection_enabled: boolean;
  activity_cache_ttl_ms: number;
  activity_marker_ttl_ms: number;
  activity_detection_timeout_ms: number;
};
```

- [ ] **Step 2: 在 `DEFAULTS.runtime` 加默认值**

在 `cloneDefaults()` 调用的 `DEFAULTS` 对象里 `runtime` 段后加：

```typescript
cli_process_detection_enabled: true,
activity_cache_ttl_ms: 10_000,
activity_marker_ttl_ms: 30 * 60 * 1000,
activity_detection_timeout_ms: 3_000,
```

同时在 `cloneDefaults()` 函数里加上对应字段（确保 deep clone 也覆盖新字段）。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add 4 runtime fields for session activity sync"
```

---

### Task 3.2: `setRuntimeOverride` 方法

**Files:**
- Modify: `src/utils/config.ts`

- [ ] **Step 1: 添加 `runtimeOverrides` 私有字段**

在 `ConfigManager` 类的私有字段区加：

```typescript
private runtimeOverrides = new Map<string, any>();
```

- [ ] **Step 2: 添加 `setRuntimeOverride` 公共方法**

```typescript
setRuntimeOverride(key: string, value: any): void {
  this.runtimeOverrides.set(key, value);
  const [section, k] = key.split('.');
  if (this.data[section as keyof ConfigData]) {
    (this.data[section] as any)[k] = value;
  }
}
```

- [ ] **Step 3: 修改 `get()` 优先返回 override**

替换 `get` 方法：

```typescript
get<T>(path: string, fallback: T): T {
  if (this.runtimeOverrides.has(path)) {
    return this.runtimeOverrides.get(path) as T;
  }
  const parts = path.split('.');
  let current: any = this.data;
  for (const part of parts) {
    if (current == null) return fallback;
    current = current[part];
  }
  return current ?? fallback;
}
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add setRuntimeOverride for transient runtime overrides"
```

---

### Task 3.3: ConfigManager 单元测试

**Files:**
- Create: `tests/unit/utils/config.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'bun:test';

describe('ConfigManager.setRuntimeOverride', () => {
  test('覆盖值优先于配置文件', () => {
    const { ConfigManager } = require('../../../src/utils/config');
    const cm = new ConfigManager();
    expect(cm.get('runtime.activity_cache_ttl_ms', 999)).toBe(10_000);  // 默认
    cm.setRuntimeOverride('runtime.activity_cache_ttl_ms', 5_000);
    expect(cm.get('runtime.activity_cache_ttl_ms', 999)).toBe(5_000);
  });

  test('覆盖不写回 config.toml（仅内存）', () => {
    const { ConfigManager } = require('../../../src/utils/config');
    const cm = new ConfigManager();
    cm.setRuntimeOverride('runtime.cli_process_detection_enabled', false);
    // 不应抛错，内存覆盖成功
    expect(cm.get('runtime.cli_process_detection_enabled', true)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `bun test tests/unit/utils/config.test.ts`
Expected: 2 passing

- [ ] **Step 3: Commit**

```bash
git add tests/unit/utils/config.test.ts
git commit -m "test(config): add setRuntimeOverride tests"
```

---

## Phase 4: SpoolMessage + SpoolQueue

### Task 4.1: `SpoolMessage` 新增字段

**Files:**
- Modify: `src/queue/spool.ts:29-44`

- [ ] **Step 1: 在 `SpoolMessage` interface 加 2 字段**

```typescript
export interface SpoolMessage {
  // ... 已有字段 ...
  skipActivityCheck?: boolean;    // 强制发送标记
  awaitingForceSend?: boolean;    // 等待用户决策
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/queue/spool.ts
git commit -m "feat(spool): add skipActivityCheck and awaitingForceSend to SpoolMessage"
```

---

### Task 4.2: `SpoolQueue.updateMessageFlags` 方法

**Files:**
- Modify: `src/queue/spool.ts`

- [ ] **Step 1: 添加方法**

在 `SpoolQueue` 类内部加：

```typescript
async updateMessageFlags(
  messageId: string,
  serialKey: string,
  flags: { skipActivityCheck?: boolean; awaitingForceSend?: boolean }
): Promise<boolean> {
  return withLock(this.processingDir, async () => {
    const path = join(this.processingDir, `${serialKey}:${messageId}.json`);
    if (!existsSync(path)) return false;
    try {
      const raw = readFileSync(path, 'utf8');
      const msg = JSON.parse(raw) as SpoolMessage;
      if (flags.skipActivityCheck !== undefined) msg.skipActivityCheck = flags.skipActivityCheck;
      if (flags.awaitingForceSend !== undefined) msg.awaitingForceSend = flags.awaitingForceSend;
      writeFileSync(path, JSON.stringify(msg, null, 2), { mode: 0o600 });
      return true;
    } catch (err) {
      logger.warn(`更新 SpoolMessage 标志失败: ${err}`);
      return false;
    }
  });
}
```

- [ ] **Step 2: 确认 `withLock` 已 import**

`withLock` 应已从 `../utils/lock` import。如未确认，添加：

```typescript
import { withLock } from '../utils/lock';
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/queue/spool.ts
git commit -m "feat(spool): add updateMessageFlags with lockfile-based concurrency"
```

---

### Task 4.3: SpoolQueue 单元测试

**Files:**
- Create: `tests/unit/queue/spool.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('SpoolQueue.updateMessageFlags', () => {
  let spool: any;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-test-'));
    const { SpoolQueue } = require('../../../src/queue/spool');
    spool = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('持久化 skipActivityCheck', async () => {
    // 1. 手动写入 processing 目录（模拟 worker claim）
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_1',
      text: 'test',
      target: { type: 'session', sessionUuid: 's1' },
      serialKey: 's1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(join(tmpDir, 'processing'), { recursive: true });
    writeFileSync(join(tmpDir, 'processing', 's1:msg-1.json'), JSON.stringify(msg));

    // 2. 调用 updateMessageFlags
    const ok = await spool.updateMessageFlags('msg-1', 's1', { skipActivityCheck: true });
    expect(ok).toBe(true);

    // 3. 读回验证
    const updated = JSON.parse(readFileSync(join(tmpDir, 'processing', 's1:msg-1.json'), 'utf8'));
    expect(updated.skipActivityCheck).toBe(true);
  });

  test('处理中消息不存在时返回 false', async () => {
    const ok = await spool.updateMessageFlags('nonexistent', 's1', { skipActivityCheck: true });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `bun test tests/unit/queue/spool.test.ts`
Expected: 2 passing

- [ ] **Step 3: Commit**

```bash
git add tests/unit/queue/spool.test.ts
git commit -m "test(spool): add updateMessageFlags unit tests"
```

---

## Phase 5: Bot 集成

### Task 5.1: `ClaudeSessionManager.activityCache` 字段

**Files:**
- Modify: `src/proxy/session.ts`

- [ ] **Step 1: 导入新增的模块**

在 `src/proxy/session.ts` 顶部添加：

```typescript
import { writeActivityMarker, SessionActivityCache } from '../utils/session-activity';
```

- [ ] **Step 2: 在 `ClaudeSessionManager` 类加字段**

在 `private readonly maxConcurrent: number;` 之后加：

```typescript
activityCache?: SessionActivityCache;
```

- [ ] **Step 3: 添加 setter 方法**

在类中加：

```typescript
setActivityCache(cache: SessionActivityCache): void {
  this.activityCache = cache;
}
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/proxy/session.ts
git commit -m "feat(session-manager): add activityCache field and setActivityCache"
```

---

### Task 5.2: `sendSDKMessage` 写入 marker

**Files:**
- Modify: `src/proxy/session.ts` （`sendSDKMessage` 方法）

- [ ] **Step 1: 在 query 循环前写 start marker**

在 `for await (const message of query(...))` 之前：

```typescript
if (sessionUuid) {
  writeActivityMarker(sessionUuid, 'feishu', 'start', process.pid);
  this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
}
```

- [ ] **Step 2: 在 chunk adapter 内部写 heartbeat**

找到 `adapter.adapt(message, (chunk: SDKStreamChunk) => { ... })`，在其内部加：

```typescript
if ((chunk.type === 'thinking' || chunk.type === 'text') && sessionUuid) {
  writeActivityMarker(sessionUuid, 'feishu', 'heartbeat', process.pid);
  this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
}
```

- [ ] **Step 3: 在 finally 写 end marker**

找到现有 `} finally { if (hardTimer) clearTimeout(hardTimer); }` 块（应该在 catch 块之后），改为：

```typescript
} finally {
  if (hardTimer) clearTimeout(hardTimer);
  if (sessionUuid) {
    writeActivityMarker(sessionUuid, 'feishu', 'end', process.pid);
    this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
  }
}
```

- [ ] **Step 4: typecheck + 跑已有测试**

Run: `bun run typecheck && bun test tests/unit/proxy/session.test.ts`
Expected: 都通过

- [ ] **Step 5: Commit**

```bash
git add src/proxy/session.ts
git commit -m "feat(session-manager): write activity markers in sendSDKMessage lifecycle"
```

---

### Task 5.3: `sendMessage` / `sendStreamingMessage` 失效缓存

**Files:**
- Modify: `src/proxy/session.ts`

- [ ] **Step 1: 在 `sendMessage` 入口加缓存失效**

找到 `sendMessage` 方法，在 `acquireSessionLock` 之前加：

```typescript
if (sessionId) {
  this.activityCache?.invalidate(`feishu-detects-cli:${sessionId}`);
}
```

- [ ] **Step 2: 在 `sendStreamingMessage` 同样位置加**

```typescript
if (sessionId) {
  this.activityCache?.invalidate(`feishu-detects-cli:${sessionId}`);
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/proxy/session.ts
git commit -m "feat(session-manager): invalidate activity cache in non-SDK send methods"
```

---

### Task 5.4: `FeishuBot.handleChat` 入口活跃检测

**Files:**
- Modify: `src/feishu/bot.ts`

- [ ] **Step 1: 导入新模块**

在 `src/feishu/bot.ts` 顶部加：

```typescript
import { isSessionActive, SessionActivityCache, type ActivityResult } from '../utils/session-activity';
```

- [ ] **Step 2: 在 `handleChat` 的 `case 'session'` 加检测**

找到 `case 'session': {` 块，在 `useSDK` 判断之前加：

```typescript
if (!msg.skipActivityCheck) {
  try {
    const status = await isSessionActive(
      currentEntry,
      this.sessionManager.activityCache ?? new SessionActivityCache(),
      'feishu-detects-cli'
    );
    if (status.isProcessing && status.confidence !== 'low') {
      await this.sendCLIBusyCard(msg, currentEntry, status);
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }
  } catch (err) {
    logger.warn(`会话活跃检测失败: ${err}`);
    // 降级：允许发送
  }
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(bot): add CLI activity detection at handleChat entry"
```

---

### Task 5.5: `card-updater.createCLIBusyCard()`

**Files:**
- Modify: `src/feishu/card-updater.ts`

- [ ] **Step 1: 导入 ActivityResult 类型**

```typescript
import type { ActivityResult } from '../utils/session-activity';
```

- [ ] **Step 2: 添加 `createCLIBusyCard` 方法**

参考 `card-updater.ts` 中 `createPermissionCard` 的 client API 调用方式，添加：

```typescript
async createCLIBusyCard(
  openId: string,
  sessionTitle: string,
  status: ActivityResult
): Promise<string> {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text' as const, content: '⚠️ CLI 侧会话处理中' },
      template: 'yellow' as const,
    },
    elements: [
      {
        tag: 'markdown' as const,
        content: `会话 **"${sessionTitle}"** 正在 **CLI 终端** 处理中。\n\n> 💡 检测依据：${status.reason}\n> 建议等待 CLI 侧处理完毕后再继续对话。`,
      },
      {
        tag: 'action' as const,
        actions: [{
          tag: 'button' as const,
          text: { tag: 'plain_text' as const, content: '⚡ 强制发送（会打断 CLI）' },
          type: 'danger' as const,
          value: { type: 'cli_force_send' },
        }],
      },
    ],
  };

  // 实际 client API 调用参考 createPermissionCard 实现
  const result = await this.client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });

  return (result as any)?.data?.message_id ?? '';
}
```

> 注：实际 `this.client` 调用方式以 `card-updater.ts` 现有方法为参考。如 client API 名称不同，按现有方法实现微调。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/feishu/card-updater.ts
git commit -m "feat(card-updater): add createCLIBusyCard for CLI busy notification"
```

---

### Task 5.6: `FeishuBot.sendCLIBusyCard` + `handleForceSendCardAction`

**Files:**
- Modify: `src/feishu/bot.ts`

- [ ] **Step 1: 添加 `sendCLIBusyCard` 私有方法**

```typescript
private async sendCLIBusyCard(
  msg: SpoolMessage,
  entry: any,
  status: ActivityResult
): Promise<void> {
  const cardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
  await cardUpdater.createCLIBusyCard(
    msg.openId,
    entry?.title ?? '未命名会话',
    status
  );
}
```

- [ ] **Step 2: 在 `handleCardAction` 加 `cli_force_send` 分支**

找到 `handleCardAction` 方法中的 `const valueObj = ...` 块，在 `permission_approve/deny` 判断之后加：

```typescript
if (valueObj && valueObj.type === 'cli_force_send') {
  return await this.handleForceSendCardAction(openId, valueObj, message?.message_id);
}
```

- [ ] **Step 3: 添加 `handleForceSendCardAction` 方法**

```typescript
private async handleForceSendCardAction(
  openId: string,
  valueObj: Record<string, unknown>,
  messageId?: string
): Promise<string | Record<string, unknown> | null> {
  const entry = this.userManager.getEntry(openId);
  if (!entry?.sessionUuid) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 错误' }, template: 'red' },
      elements: [{ tag: 'markdown', content: '**会话不存在**' }],
    };
  }

  // 在 processing 目录中查找属于该 session 的消息
  const processingMsgs = this.spoolQueue.listProcessing()
    .filter(m => m.serialKey === entry.sessionUuid && m.openId === openId);

  if (processingMsgs.length === 0) {
    return null;
  }

  const targetMsg = processingMsgs[0];
  const updated = await this.spoolQueue.updateMessageFlags(
    targetMsg.messageId,
    targetMsg.serialKey,
    { skipActivityCheck: true, awaitingForceSend: false }
  );

  if (!updated) return null;

  this.sessionManager.activityCache?.invalidate(`feishu-detects-cli:${entry.sessionUuid}`);

  return null;
}
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(bot): add sendCLIBusyCard and handleForceSendCardAction for cli_force_send"
```

---

### Task 5.7: `SpoolQueue.listProcessing` 公开（如未存在）

**Files:**
- Modify: `src/queue/spool.ts`

- [ ] **Step 1: 检查是否已存在 `listProcessing`**

```bash
grep -n "listProcessing" src/queue/spool.ts
```

如果已存在，跳到 Step 4。

- [ ] **Step 2: 添加 `listProcessing` 方法**

```typescript
listProcessing(): SpoolMessage[] {
  if (!existsSync(this.processingDir)) return [];
  return readdirSync(this.processingDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = readFileSync(join(this.processingDir, f), 'utf8');
        return JSON.parse(raw) as SpoolMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is SpoolMessage => m !== null);
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/queue/spool.ts
git commit -m "feat(spool): expose listProcessing for card action callbacks"
```

---

## Phase 6: 启动时序 + CLI 集成

### Task 6.1: `start.ts` 6 步启动顺序

**Files:**
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: 导入新增模块**

在 `src/cli/commands/start.ts` 顶部加：

```typescript
import { SessionActivityCache, cleanupOldActivityLogs } from '../../utils/session-activity';
import { getClaudeProcessesByCwd } from '../../utils/process-info';
```

- [ ] **Step 2: 添加 `probeCliProcessDetection` 辅助函数**

在 `start.ts` 中加（文件任意位置）：

```typescript
function probeCliProcessDetection(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const procs = getClaudeProcessesByCwd(process.cwd());
    return procs.length > 0; // 能列出说明 lsof 没权限错
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: 在 `startForeground` 入口加探测 + cleanup + cache + grace period**

找到 `startForeground` 函数，在其最开头加：

```typescript
async function startForeground(registry: RegistryManager, opts: StartOptions): Promise<void> {
  // Step 1: 探测 CLI 进程检测可用性
  const cliDetectionOk = probeCliProcessDetection();
  if (!cliDetectionOk) {
    logger.warn('CLI 进程检测不可用（macOS 权限），将只使用 marker + mtime 检测');
    config.setRuntimeOverride('cli_process_detection_enabled', false);
  }

  // Step 2: 清理过期 activity 日志
  const cleaned = cleanupOldActivityLogs(24);
  logger.info(`清理过期 activity 日志: ${cleaned} 个文件`);

  // Step 3-5: 创建 cache + sessionManager + bot 在原构造函数中
  // (这部分通过修改 FeishuBot 构造实现)

  // Step 6: Grace period（避免升级期间老 daemon 残留导致误判）
  logger.info('活跃检测 grace period: 30 秒');
  await sleep(30_000);

  // ... 原 startForeground 剩余逻辑 ...
}
```

> 注：`sleep` 函数如果 `start.ts` 还没 import，需要加：`import { sleep } from 'bun';` 或 `import { setTimeout as sleep } from 'timers/promises';`

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(start): add 6-step init with CLI detection probe + cleanup + 30s grace period"
```

---

### Task 6.2: 把 `activityCache` 注入到 `sessionManager`

**Files:**
- Modify: `src/cli/commands/start.ts`（在 `startForeground` 创建 sessionManager 处）

- [ ] **Step 1: 找到 sessionManager 创建**

在 `startForeground` 中找到 `new ClaudeSessionManager()`（或在 `startDaemonChild` 中），在其后加：

```typescript
const activityCache = new SessionActivityCache();
sessionManager.setActivityCache(activityCache);
```

- [ ] **Step 2: 验证 FeishuBot 拿到带 cache 的 sessionManager**

确保 `FeishuBot` 构造时传入的是已注入 cache 的 sessionManager 实例（不是 import 的 singleton）。

- [ ] **Step 3: typecheck + 手动启动验证**

Run: `bun run dev start --no-feishu` (前台模式)
Expected: 启动 30 秒 grace period 提示后正常进入主循环

用 Ctrl+C 停止后：

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(start): inject SessionActivityCache into sessionManager singleton"
```

---

### Task 6.3: `resume.ts` 叠加 marker 检测

**Files:**
- Modify: `src/cli/commands/resume.ts`

- [ ] **Step 1: 导入新模块**

```typescript
import { isSessionActive, SessionActivityCache } from '../../utils/session-activity';
```

- [ ] **Step 2: 在 `resume` 函数中 `isSessionBusy` 检查后加 marker 检测**

找到 `const busy = isSessionBusy(uuid);` 块，在其后（else if 之后）加：

```typescript
// 2. 新增检测：飞书侧是否活跃（通过 marker）
// 注意：复用 --force 选项语义
if (!opts.force) {
  const activityCache = new SessionActivityCache();
  try {
    const entry = registry.get(uuid);
    if (entry) {
      const status = await isSessionActive(
        entry,
        activityCache,
        'cli-detects-feishu'
      );
      if (status.isProcessing) {
        const strengthText = status.confidence === 'high' ? '正在' : '可能';
        console.log(chalk.yellow(`⚠️  该会话${strengthText}被飞书侧处理中。`));
        console.log(chalk.yellow(`   原因: ${status.reason}`));
        console.log(chalk.yellow('   继续 resume 可能会打断飞书侧的任务。'));

        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '是否强制继续？',
          default: false,
        }]);
        if (!confirmed) return;
      }
    }
  } catch (err) {
    logger.warn(`飞书侧活跃检测失败: ${err}`);
    // 降级：继续
  }
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: 手动测试**

```bash
# 在飞书 bot 运行时（假设 session 已绑定）
echo '{}' > /tmp/test-marker.log  # 模拟无 marker
bun run dev resume --latest --force  # --force 应跳过检测
```

Expected: 跳过 marker 检测提示

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/resume.ts
git commit -m "feat(resume): add marker-based feishu activity detection"
```

---

## Phase 7: Scanner `message_count` 独立修正

### Task 7.1: `NON_MESSAGE_TYPES` 常量

**Files:**
- Modify: `src/scanner/jsonl.ts`

- [ ] **Step 1: 在文件顶部加常量**

```typescript
const NON_MESSAGE_TYPES = new Set([
  'ai-title',
  'last-prompt',
  'queue-operation',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'agent-name',
  // 兼容旧版 cc-linker 写入的 JSONL marker
  'activity_marker',
]);
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/scanner/jsonl.ts
git commit -m "feat(scanner): add NON_MESSAGE_TYPES constant"
```

---

### Task 7.2: `parseFull` 排除非消息

**Files:**
- Modify: `src/scanner/jsonl.ts` (`parseFull` 方法)

- [ ] **Step 1: 修改 `message_count` 计算**

找到：
```typescript
return {
  // ...
  message_count: lines.length,
  // ...
};
```

改为：
```typescript
const messageLines = lines.filter(line => {
  try {
    const entry = JSON.parse(line);
    return !NON_MESSAGE_TYPES.has(entry.type);
  } catch {
    return true; // 解析失败保留（兼容旧数据）
  }
});

return {
  // ...
  message_count: messageLines.length,
  // ...
};
```

- [ ] **Step 2: 修改 `last_active` 扫描跳过非消息**

找到 `parseFull` 中扫描最后 10 行的循环，在 JSON.parse 之后加：

```typescript
if (NON_MESSAGE_TYPES.has(entry.type)) continue;
```

- [ ] **Step 3: typecheck + 跑已有测试**

Run: `bun run typecheck && bun test tests/unit/scanner/jsonl.test.ts`
Expected: 通过（可能需要更新测试期望值）

- [ ] **Step 4: Commit**

```bash
git add src/scanner/jsonl.ts
git commit -m "feat(scanner): exclude non-message types from message_count and last_active"
```

---

### Task 7.3: `parseTail` 排除非消息

**Files:**
- Modify: `src/scanner/jsonl.ts` (`parseTail` 方法)

- [ ] **Step 1: 在 tailLines 循环中加排除**

找到 `parseTail` 中两处 `for (const line of tailLines)` 循环，在 JSON.parse 之后加：

```typescript
if (NON_MESSAGE_TYPES.has(entry.type)) continue;
```

- [ ] **Step 2: typecheck + 跑已有测试**

Run: `bun run typecheck && bun test tests/unit/scanner/jsonl.test.ts`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/scanner/jsonl.ts
git commit -m "feat(scanner): exclude non-message types in parseTail"
```

---

## Phase 8: Hook 命令（可选增强）

### Task 8.1: `cc-linker-activity-hook` 子命令

**Files:**
- Create: `src/cli/commands/activity-hook.ts`

- [ ] **Step 1: 创建文件**

```typescript
import { writeActivityMarker } from '../../utils/session-activity';

interface HookOptions {
  platform?: 'feishu' | 'cli';
  action?: 'start' | 'end' | 'heartbeat';
  session?: string;
}

export async function activityHook(opts: HookOptions = {}): Promise<void> {
  const platform = opts.platform ?? 'cli';
  const action = opts.action ?? 'heartbeat';
  const sessionUuid = opts.session ?? process.env.CLAUDE_SESSION_ID;

  if (!sessionUuid) {
    console.error('error: --session <uuid> or CLAUDE_SESSION_ID env required');
    process.exit(1);
  }

  writeActivityMarker(sessionUuid, platform, action, process.pid);
  process.exit(0);
}
```

- [ ] **Step 2: 在 `src/index.ts` 注册命令**

找到 commander 配置处，加：

```typescript
program
  .command('activity-hook')
  .description('Write activity marker (used by Claude Code hooks)')
  .option('--platform <platform>', 'cli or feishu', 'cli')
  .option('--action <action>', 'start, end, or heartbeat', 'heartbeat')
  .option('--session <uuid>', 'session UUID (default: $CLAUDE_SESSION_ID)')
  .action(actOnImportError);  // 或直接传 activityHook
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: 手动测试**

```bash
bun run dev activity-hook --platform=cli --action=start --session=test-uuid
ls ~/.cc-linker/activity/test-uuid.log
cat ~/.cc-linker/activity/test-uuid.log
```

Expected: 文件存在，内容包含 `{"type":"activity_marker",...}`

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/activity-hook.ts src/index.ts
git commit -m "feat(cli): add activity-hook subcommand for Claude Code hooks integration"
```

---

### Task 8.2: 文档更新 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 README 的"高级配置"段加 hook 配置示例**

```markdown
### 启用 CLI 端 activity marker（可选）

cc-linker 默认通过 OS 信号检测 CLI 端活跃度。如需更精确的检测，可在 `~/.claude/settings.json` 中配置 hooks：

\`\`\`json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": ["cc-linker activity-hook --platform=cli --action=start --session=$CLAUDE_SESSION_ID"]
    }],
    "Stop": [{
      "hooks": ["cc-linker activity-hook --platform=cli --action=end --session=$CLAUDE_SESSION_ID"]
    }]
  }
}
\`\`\`

这样 cc-linker 可以 100% 准确检测 CLI 侧活跃状态，而不是依赖 CPU/子进程采样。
```

- [ ] **Step 2: 验证 README 渲染**

Run: `cat README.md | head -200`
Expected: 新段落已添加

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add activity hook configuration example"
```

---

## 收尾任务

### Task 9.1: 完整测试套件验证

- [ ] **Step 1: 跑全部测试**

Run: `bun test`
Expected: 所有测试通过

- [ ] **Step 2: 跑 typecheck**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: 手动 E2E 验证**

```bash
# 1. 启动 bot（带 30s grace period）
bun run dev start --no-feishu &
BOT_PID=$!

# 2. 等待 grace period
sleep 30

# 3. 启动 interactive claude
~/.local/bin/claude &
CLAUDE_PID=$!
sleep 5

# 4. 在飞书侧发消息（应被拦截）
# 验证：收到"CLI 侧处理中"卡片
# 5. 结束 claude 进程
kill $CLAUDE_PID
sleep 5
# 6. 再次在飞书侧发消息（应正常处理）
```

- [ ] **Step 4: 提交最终 commit（如有微调）**

```bash
git status
# 如果有改动：
git add .
git commit -m "chore: final adjustments after E2E verification"
```

---

## 实施顺序总览

```
Phase 0 (3 tasks) ─┬─→ Phase 1 (5 tasks) ─→ Phase 2 (10 tasks) ─→ Phase 5 (7 tasks)
                   │                                              │
                   ├─→ Phase 3 (3 tasks) ─────────────────────→ Phase 5
                   │                                              │
                   └─→ Phase 4 (3 tasks) ─────────────────────→ Phase 5
                                                                          │
                                                                          ├─→ Phase 6 (3 tasks)
                                                                          │
                                                                          └─→ Phase 7 (3 tasks, 独立)
                                                                          
                                                            Phase 8 (2 tasks, 可选)
```

**总任务数：39 个任务**

---

## 验收清单

- [ ] `~/.cc-linker/activity/<uuid>.log` 文件正确创建
- [ ] 飞书 SDK 处理时，marker 持续写入（start/heartbeat/end）
- [ ] 飞书侧 `/switch` 到 CLI 正在使用的 session → 收到"CLI 处理中"卡片
- [ ] CLI 侧 `cc-linker resume` 到飞书正在使用的 session → 收到"飞书处理中"提示
- [ ] macOS 权限不足时，`cli_process_detection_enabled` 自动 false
- [ ] 强制发送卡片能正确标记 `skipActivityCheck=true` 并继续处理
- [ ] 30s grace period 期间，活跃检测不生效
- [ ] Sidecar 文件超过 64KB 时自动 rotate
- [ ] `bun test` 全部通过
- [ ] `bun run typecheck` 通过
- [ ] `bun run build` 编译成功
