# Session Activity Sync Design

> **版本**: v1.2
> **日期**: 2026-06-01
> **状态**: 已评审（v1.0 → v1.1 → v1.2 三轮迭代），待实现
> **相关**: `docs/session-activity-sync-design.review.md`、`docs/session-activity-sync-design.review2.md`

---

> **本文档为 v1.2 修订版**，针对 v1.0 / v1.1 的关键问题做了修正：
>
> **v1.2（实施就绪度复审后）核心修复**：
> 1. `withTimeout` 抽到 `src/utils/async.ts`（之前未定义）
> 2. `PKG_VERSION` 抽到 `src/version.ts`（之前未定义）
> 3. `ConfigManager.setRuntimeOverride()` 完整定义（之前假设存在）
> 4. `ClaudeSessionManager.activityCache` 字段 + `setActivityCache()` 方法（之前直接引用）
> 5. `cli_force_send` 改在 `value.type` 分支处理（之前 `switch (tag)` 永远不匹配）
> 6. ESM 导入替代 `require('fs')`（项目是 ESM）
> 7. `parsePsTimeToSeconds` 支持 `HH:MM:SS` 和 `DD-HH:MM:SS` 格式
> 8. mtime 采样缩短到 500ms（避免与 CPU 一起 > 3s 超时）
> 9. `findClaudeProcessByCwd` 改用单次 `lsof` 批量获取
> 10. Sidecar 文件 64KB 自动 rotate 保留 50%
> 11. Bot/CLI cache 差异文档明确化
> 12. `SpoolQueue.updateMessageFlags` 新增方法 + lockfile 串行
> 13. 新增 §11 实施顺序、§12 接口变更清单、§13 回滚计划、§14 数据迁移
> 14. `src/utils/process-info.ts` 抽象层（便于测试 mock）
> 15. `start.ts` 显式 6 步启动顺序
> 16. 强制发送完整状态机 + race condition 处理
> 17. `entry.cwd` symlink 处理（`realpathSync`）
> 18. 升级 grace period（30 秒）避免老 daemon 残留
>
> **v1.1 关键改进**（保留）：
> - Activity Marker 改写到 sidecar 文件（`~/.cc-linker/activity/<uuid>.log`），不污染 JSONL
> - 信号源严格分离：飞书侧只信 marker，CLI 侧才用进程/CPU/mtime 采样
> - marker TTL 与 `runtime.hard_timeout_ms` 对齐（默认 30 分钟）
> - 移除无效的 `force_override` marker
> - `message_count` 修正与 marker 系统解耦
> - 跨平台 CPU 采样改用"raw 秒数差值"
>
> **v1.0 原始方案**：见 git history（已废弃）

---

## 1. 问题定义

### 1.1 双向冲突场景

```
场景 A: CLI → 飞书
┌─────────────────────────────────────────────────────────────┐
│  CLI 终端                        手机飞书                     │
│     │                               │                       │
│     │ 启动长任务 "重构项目"          │                       │
│     │ (claude 交互式进程运行中)       │                       │
│     │                               │ /switch <sessionId>   │
│     │                               │ 发送新消息            │
│     │                               │ ↓                     │
│     │                               │ spawn 新进程 resume   │
│     │                               │ ❌ 打断 CLI 任务      │
└─────────────────────────────────────────────────────────────┘

场景 B: 飞书 → CLI
┌─────────────────────────────────────────────────────────────┐
│  CLI 终端                        手机飞书                     │
│     │                               │                       │
│     │                               │ 启动长任务            │
│     │                               │ (SDK query 运行中)    │
│     │ cc-linker resume <id>         │                       │
│     │ ↓                             │                       │
│     │ spawn 新进程 resume           │                       │
│     │ ❌ 打断飞书任务               │                       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 根本原因

- 两个平台独立 spawn Claude 进程
- 进程间无通信机制
- JSONL 是唯一的共享介质，但写入时机不同（回合结束后才落盘）
- 没有"会话锁"或"活跃标记"机制

### 1.3 关键发现：SDK 模式与交互式 CLI 的运行时差异

| 特征 | SDK 模式（飞书） | 交互式 CLI（终端） |
|------|-----------------|-------------------|
| 入口 | `query()` from `@anthropic-ai/claude-agent-sdk` | 用户直接运行 `claude` |
| 进程来源 | SDK 内部 spawn（不在 cc-linker 控制内） | 用户 TTY spawn |
| 进程命令行 | 不固定（SDK 内部实现） | 包含或不包含 `-p` |
| 可控性 | cc-linker **只能控制** marker | cc-linker **只能观察** |
| entrypoint（JSONL） | `"sdk-cli"` | `"cli"` 或无 |
| 实时状态信号 | Activity Marker（主动声明） | 进程 CPU + 子进程 + JSONL mtime（被动采样） |
| 准确度 | 100%（自己声明的） | 高（多重信号交叉验证） |

**核心结论**：
- **飞书侧活跃度**：必须靠主动声明（Activity Marker），不能靠检测"是否有 claude 进程"——因为 SDK 自己也会 spawn claude 子进程
- **CLI 侧活跃度**：可以靠被动采样（CPU + 子进程 + JSONL mtime）
- **两边不能混用检测方法**，否则飞书 SDK 内部进程会被当成"CLI 在用"

> 注：本仓库实际 JSONL entrypoint 值为 `sdk-cli`（见 `tests/fixtures/sample.jsonl:1` 和 `src/utils/jsonl-repair.ts:85`），早期文档误写为 `sdk-ts`，以实测为准。

---

## 2. 设计目标

| 目标 | 优先级 | 说明 |
|------|--------|------|
| 检测对方平台是否正在使用会话 | P0 | 核心需求 |
| 提醒用户等待 | P0 | 避免打断 |
| 支持"强制继续"选项 | P1 | 给用户选择权 |
| 不影响现有使用习惯 | P0 | CLI 用户仍可正常用 `claude` |
| 最小化实现复杂度 | P1 | 快速落地 |
| 跨平台一致行为 | P0 | macOS / Linux 行为对齐 |
| 检测延迟 < 3s | P1 | 不让用户感到卡顿 |
| 检测失败优雅降级 | P0 | 异常时允许发送 |

---

## 3. 核心设计原则

### 3.1 为什么固定时间阈值不行？

固定阈值（如"10 分钟内活跃"）的本质是**用"过去多久有活动"来猜测"现在是否在进行"**——这永远是间接的，必然产生误判。

| 误判类型 | 典型场景 | 原因 |
|---------|---------|------|
| **假阳性**（已完成却误判为活跃） | 回合完成后用户阅读结果 5 分钟 | 回合完成后无新写入，但仍在阈值内 |
| **假阳性**（进程 Idle） | 进程存在但等待用户输入 | `pgrep` 只能检测存在，无法区分状态 |
| **假阴性**（活跃却误判为完成） | 长回合进行中（>10分钟） | 回合进行中 JSONL 不更新，超过阈值 |
| **假阴性**（长思考中） | Claude 纯推理，无工具调用 | 无子进程、无写入、CPU 低 |

### 3.2 改进方向："当前状态采样"

不猜"过去多久"，直接检测"**此刻是否在消耗计算资源**"：

| 采样方式 | 检测什么 | 直接性 | 适用方向 |
|---------|---------|--------|---------|
| Activity Marker | cc-linker 显式声明状态 | ⭐⭐⭐ 直接 | **飞书 → CLI 方向** |
| 进程 CPU 采样 | 进程是否在计算 | ⭐⭐⭐ 直接 | **CLI → 飞书方向** |
| 子进程检测 | 是否有工具/子代理执行 | ⭐⭐⭐ 直接 | **CLI → 飞书方向** |
| JSONL mtime 增长 | 文件是否正在写入 | ⭐⭐☆ 较直接 | 双向辅助 |

### 3.3 信号源严格分离原则

```
┌────────────────────────────────────────────────────────────────┐
│ 飞书侧要检测"CLI 是否在用这个 session"                         │
│   → 只能观察：JSONL mtime 增长 + 进程 CPU/子进程               │
│   → 不能用 pgrep 简单匹配（SDK 内部也有 claude 进程）           │
│   → 必须排除 cc-linker / SDK 启动的进程                       │
├────────────────────────────────────────────────────────────────┤
│ CLI 侧要检测"飞书是否在用这个 session"                         │
│   → 读 Activity Marker（sidecar 文件）                        │
│   → 不需要任何进程检测                                          │
└────────────────────────────────────────────────────────────────┘
```

**这条原则贯穿整个实现**。如果混用，飞书 SDK 处理中时，飞书侧的"检测 CLI 活跃"会把自己内部进程误判为"CLI 在用"，造成自干扰。

---

## 4. 方案设计

### 4.1 优先级 1：Activity Marker（飞书侧，100% 准确）

飞书 SDK `query()` 模式由 cc-linker 主动控制，在关键节点写入 marker。

#### 4.1.1 写入位置：sidecar 文件（不是 JSONL）

```typescript
// ~/.cc-linker/activity/<sessionUuid>.log
// 每行一个 JSON object，按时间顺序追加
```

**为什么用 sidecar 而不写 JSONL**：
- 避免与 Claude Code 进程自身的 JSONL 写入竞争
- 不污染 `message_count` / `last_active` 等 scanner 字段
- 独立可读，独立可清理
- 失败时不影响主流程

#### 4.1.2 Marker 写入/刷新策略

```typescript
// 写入时机 1：sendSDKMessage 开始时
writeActivityMarker(sessionUuid!, 'feishu', 'start', process.pid);

// 写入时机 2：每收到一个 streaming chunk 时（关键改进）
// 替代"固定 2 分钟心跳"——长思考场景下持续保持活跃
function onStreamChunk(chunk: StreamChunk) {
  if (chunk.type === 'thinking' || chunk.type === 'text') {
    writeActivityMarker(sessionUuid!, 'feishu', 'heartbeat', process.pid);
  }
}

// 写入时机 3：sendSDKMessage 结束时（try/finally 保证）
try {
  await this.sessionManager.sendSDKMessage(...);
} finally {
  writeActivityMarker(sessionUuid!, 'feishu', 'end', process.pid);
}
```

**为什么用 streaming chunk 触发 heartbeat 而不是定时器**：
- 长思考场景（10+ 分钟纯推理）下，SDK 仍在运行但无 chunk，2 分钟心跳就够
- 短输出场景下，每个 chunk 都会刷新，**始终保持高置信度活跃**
- 比定时器更精确：真的"在做事"才会刷新

#### 4.1.3 Marker 格式

```json
{"type":"activity_marker","uuid":"am-123","platform":"feishu","action":"start","timestamp":"2026-06-01T10:00:00Z","pid":12345,"version":"0.3.4"}
{"type":"activity_marker","uuid":"am-124","platform":"feishu","action":"heartbeat","timestamp":"2026-06-01T10:02:00Z","pid":12345,"version":"0.3.4"}
{"type":"activity_marker","uuid":"am-125","platform":"feishu","action":"end","timestamp":"2026-06-01T10:05:00Z","pid":12345,"version":"0.3.4"}
```

#### 4.1.4 判定规则

```typescript
const MARKER_TTL_MS = 30 * 60 * 1000; // 与 runtime.hard_timeout_ms 对齐

function judgeMarkerAge(ageMs: number): { active: boolean; confidence: 'high' | 'medium' | 'low' } {
  if (ageMs < 3 * 60 * 1000) {
    return { active: true, confidence: 'high' };       // 3 分钟内：高置信
  }
  if (ageMs < 10 * 60 * 1000) {
    return { active: true, confidence: 'medium' };     // 10 分钟内：中置信
  }
  if (ageMs < MARKER_TTL_MS) {
    return { active: true, confidence: 'low' };        // 30 分钟内：低置信（可能已崩溃未写 end）
  }
  return { active: false, confidence: 'high' };        // 超过 30 分钟：判定不活跃
}
```

**TTL 30 分钟的理由**：`runtime.hard_timeout_ms` 默认 30 分钟，是 cc-linker 允许单次任务的最长时长。如果一个任务跑了 30 分钟还没结束，cc-linker 会主动 kill，不会再有 marker 写入。

#### 4.1.5 Sidecar 文件操作

```typescript
import { appendFileSync, readFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const ACTIVITY_DIR = join(CC_LINKER_DIR, 'activity');

function activityLogPath(sessionUuid: string): string {
  return join(ACTIVITY_DIR, `${sessionUuid}.log`);
}

export function writeActivityMarker(
  sessionUuid: string,
  platform: 'feishu' | 'cli',
  action: 'start' | 'end' | 'heartbeat',
  pid?: number
): void {
  try {
    mkdirSync(ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // 目录已存在或创建失败——后者由后续 write 抛出
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

export function readLastActivityMarker(sessionUuid: string): ActivityMarker | null {
  const path = activityLogPath(sessionUuid);
  if (!existsSync(path)) return null;

  try {
    // 只读最后 4KB（marker 单条约 150B，最多 ~25 条）
    const stat = statSync(path);
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, stat.size - readSize);
      const tail = buffer.toString('utf8');
      const lines = tail.split('\n').filter(Boolean);
      // 从最后一条开始向前找 marker
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

#### 4.1.6 清理与轮转策略

**两阶段管理**：

1. **大文件轮转**（每次写入后检查）：
   - 单文件达到 `MAX_ACTIVITY_LOG_BYTES`（默认 64KB）时，执行 rotate
   - rotate 策略：保留尾部 50%（约 32KB），删除前半部分
   - 这样不会丢失最近的 marker，又避免文件无限增长
   - 极端情况：30 分钟长任务 + 频繁 chunk → 数千行 → rotate 1-2 次可控

2. **过期文件清理**：
   - 每次启动 daemon 时，清理 24 小时前的 activity 文件
   - session 从 registry 移除时（`archive`/`clean`），同步删除对应 activity 文件

```typescript
const MAX_ACTIVITY_LOG_BYTES = 64 * 1024; // 64KB
const ROTATE_KEEP_RATIO = 0.5;

function maybeRotateActivityLog(sessionUuid: string): void {
  const path = activityLogPath(sessionUuid);
  try {
    const stat = statSync(path);
    if (stat.size <= MAX_ACTIVITY_LOG_BYTES) return;

    // 读取文件，保留尾部 50%
    const content = readFileSync(path, 'utf8');
    const keepBytes = Math.floor(MAX_ACTIVITY_LOG_BYTES * ROTATE_KEEP_RATIO);
    const tail = content.slice(-keepBytes);
    // 找到第一个完整行起点
    const firstNewline = tail.indexOf('\n');
    const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;

    writeFileSync(path, trimmed, { mode: 0o600 });
    logger.debug(`activity log 轮转: ${sessionUuid}, 保留 ${trimmed.length} bytes`);
  } catch (err) {
    logger.debug(`activity log 轮转失败: ${sessionUuid}: ${err}`);
  }
}

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

### 4.2 优先级 2：进程 CPU 采样（CLI 侧，高准确率）

交互式 CLI 不受 cc-linker 控制，必须通过 OS 信号采样。

#### 4.2.1 跨平台瞬时 CPU 采样

```typescript
import { sleep } from 'bun';

export async function getInstantCPU(pid: number, durationMs: number = 1000): Promise<number> {
  const t1 = await getProcessCPUTimeSeconds(pid);
  await sleep(durationMs);
  const t2 = await getProcessCPUTimeSeconds(pid);

  // CPU 时间差（秒）/ 墙钟时间差（秒）= CPU 占比
  // 不需要 clock tick 换算，统一用秒
  const wallClockSec = durationMs / 1000;
  const cpuSec = t2 - t1;
  const cores = os.cpus().length;
  return Math.max(0, Math.min(100 * cores, (cpuSec / wallClockSec) * 100));
}

/**
 * 读取进程累计 CPU 时间（用户态 + 系统态），单位：秒
 * 跨平台统一返回 raw 秒数，不再用 ticks
 */
async function getProcessCPUTimeSeconds(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    return getLinuxCPUTime(pid);
  }
  if (process.platform === 'darwin') {
    return getDarwinCPUTime(pid);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

// Linux: /proc/<pid>/stat 第 14、15 列 (utime + stime)
// 字段索引按 man proc: 1=pid, 2=comm(...), 3=state, 4=ppid, ... 14=utime, 15=stime
async function getLinuxCPUTime(pid: number): Promise<number> {
  const stat = await Bun.file(`/proc/${pid}/stat`).text();
  // 注意：comm 可能包含空格和括号，必须从最后一个 ')' 切分
  const lastParen = stat.lastIndexOf(')');
  const after = stat.slice(lastParen + 2); // 跳过 ') '
  const parts = after.split(' ');
  // after 的第 1 个元素对应原 stat 的第 4 个字段（state）
  // utime = 索引 11 (after[11]), stime = 索引 12 (after[12])
  const utime = parseInt(parts[11], 10);
  const stime = parseInt(parts[12], 10);
  // 转换为秒：CLK_TCK 通常 100，但用 sysconf 安全
  const clkTck = parseInt(Bun.file('/proc/sys/kernel/clk_tck')?.text?.() ?? '100', 10) || 100;
  return (utime + stime) / clkTck;
}

// macOS: ps -o time= -p <pid> 返回累计 CPU 时间
// 格式随运行时长变化：SS.hh | MM:SS | HH:MM:SS | DD-HH:MM:SS
async function getDarwinCPUTime(pid: number): Promise<number> {
  const result = Bun.spawnSync(['ps', '-o', 'time=', '-p', String(pid)]);
  if (result.exitCode !== 0) {
    throw new Error(`ps failed for pid ${pid}`);
  }
  const timeStr = new TextDecoder().decode(result.stdout).trim();
  return parsePsTimeToSeconds(timeStr);
}

/**
 * 解析 ps 时间格式为秒
 * - "SS.hh" → 秒.百分秒（CPU < 1 分钟）
 * - "MM:SS" 或 "MM:SS.hh" → 分:秒（CPU < 1 小时）
 * - "HH:MM:SS" 或 "HH:MM:SS.hh" → 时:分:秒（CPU < 1 天）
 * - "DD-HH:MM:SS" → 天-时:分:秒（CPU >= 1 天，长任务场景）
 * - 注意：百分秒位可能不存在（旧版 ps）
 */
export function parsePsTimeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;

  let days = 0;
  let rest = timeStr;

  // 处理 "DD-HH:MM:SS" 格式（天数前缀）
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

**关键修复**（相对 v1.0）：
- v1.0 同时定义了 `getClockTick()` 和 `parseTimeToTicks()`，两者数值（1 vs 100）自相矛盾
- v1.1 统一用**秒**为单位，跨平台不依赖 clock tick

#### 4.2.2 CPU 判定

```typescript
export interface CpuResult {
  isProcessing: boolean;
  confidence: 'high' | 'medium' | 'low';
  cpuPercent: number;
  reason: string;
}

export async function sampleCPU(cwd: string, timeoutMs: number = 3000): Promise<CpuResult> {
  return withTimeout(
    sampleCPUImpl(cwd),
    timeoutMs,
    { isProcessing: false, confidence: 'low', cpuPercent: 0, reason: 'sample_timeout' }
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

### 4.3 优先级 3：子进程检测

```typescript
export interface ChildResult {
  hasChildren: boolean;
  children: Array<{ pid: number; command: string }>;
}

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
      // 过滤掉 shell wrapper
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
```

### 4.4 优先级 4：JSONL mtime 增长检测（双向辅助）

```typescript
export async function isJSONLWrittenSince(
  jsonlPath: string,
  sinceMs: number,
  sampleMs: number = 500  // 缩短到 500ms，与 CPU 采样（1s）一起控制在 1.5s 内
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
```

**为什么仍保留 mtime 检测**：
- SDK 模式回合完成时一次性写大段数据，2 秒采样能捕捉
- CPU 极低（纯推理）+ 无子进程的场景，mtime 是最直接的信号
- 跨平台最简单可靠的检测方式

### 4.5 进程查找（CLI 侧专用）

#### 4.5.1 关键约束

检测 CLI 活跃时，**必须排除**：
1. cc-linker 自己 spawn 的 `claude -p` 进程（`sendMessage` / `sendStreamingMessage`）
2. cc-linker SDK 模式拉起的进程（**虽然不容易识别，但通常有 SDK bundle 特征**）

```typescript
import { realpathSync, readlinkSync } from 'fs';

function findClaudeProcessByCwd(targetCwd: string): { pid: number; cwd: string } | null {
  // 1. 用 realpath 解析 targetCwd（处理 symlink 场景：用户项目用符号链接）
  let realTarget: string;
  try {
    realTarget = realpathSync(targetCwd);
  } catch (err) {
    logger.debug(`realpath 失败: ${targetCwd}: ${err}`);
    realTarget = targetCwd;
  }

  // 2. 一次性获取所有候选 claude 进程及其 cwd（单次 lsof，避免 O(N) 调用）
  const candidates = getAllClaudeProcessesWithCwd();
  if (candidates.length === 0) return null;

  // 3. 二次过滤：排除 cc-linker / SDK 启动的子进程
  const filtered = candidates.filter(c => {
    // 排除所有非交互式调用（含 -p 参数的都是非交互式）
    if (c.command.includes(' -p ')) return false;
    if (c.command.includes('--output-format')) return false;
    // 排除 SDK bundle 路径（SDK 内嵌二进制路径通常包含 sdk 标识）
    if (c.command.includes('/sdk/') || c.command.includes('claude-agent-sdk')) return false;
    return true;
  });

  // 4. 用 cwd 匹配 target（realpath 后比较）
  for (const c of filtered) {
    if (c.cwd === realTarget || c.cwd === targetCwd) {
      return { pid: c.pid, cwd: c.cwd };
    }
  }

  return null;
}

/**
 * 一次性获取当前用户所有 claude 进程的 (pid, cwd, command) 元组
 * 优化点：单次 lsof 调用，避免循环中 N 次 syscall
 */
function getAllClaudeProcessesWithCwd(): Array<{ pid: number; cwd: string; command: string }> {
  const uid = process.getuid?.() ?? 0;

  if (process.platform === 'linux') {
    // Linux: 遍历 /proc 找 comm == "claude" 的进程
    const result: Array<{ pid: number; cwd: string; command: string }> = [];
    const procDirs = readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pidStr of procDirs) {
      const pid = parseInt(pidStr, 10);
      try {
        // 读 comm（短进程名，限制 16 字符）
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (comm !== 'claude') continue;

        // 读命令行（用于 SDK 过滤）
        const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        // 读 cwd 符号链接
        const cwd = readlinkSync(`/proc/${pid}/cwd`);

        // 二次过滤 command
        if (command.includes(' -p ') || command.includes('--output-format')) continue;
        if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;

        // 验证属主（避免匹配其他用户进程）
        const stat = statSync(`/proc/${pid}`);
        if (stat.uid !== uid) continue;

        result.push({ pid, cwd, command });
      } catch (err) {
        // 进程可能在我们读取时退出，跳过
        continue;
      }
    }
    return result;
  }

  if (process.platform === 'darwin') {
    // macOS: 单次 lsof 获取所有 claude 进程的 cwd
    try {
      const result = Bun.spawnSync([
        'lsof', '-u', String(uid), '-c', 'claude', '-a', '-d', 'cwd', '-Fn'
      ]);
      if (result.exitCode !== 0) return [];

      const lines = new TextDecoder().decode(result.stdout).split('\n');
      const pidToCwd = new Map<number, string>();
      let currentPid: number | null = null;
      for (const line of lines) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10);
        } else if (line.startsWith('n') && currentPid !== null) {
          // n 后面是路径，但 lsof 输出可能含空格，用行首 n 判断
          pidToCwd.set(currentPid, line.slice(1));
          currentPid = null;
        }
      }

      // 单独取 command（lsof 一次只能取一个 -d，再开一个 ps 调用更经济）
      const psResult = Bun.spawnSync(['ps', '-u', String(uid), '-o', 'pid=,command=']);
      const pidToCommand = new Map<number, string>();
      if (psResult.exitCode === 0) {
        for (const line of new TextDecoder().decode(psResult.stdout).split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/);
          if (m) pidToCommand.set(parseInt(m[1], 10), m[2].trim());
        }
      }

      const out: Array<{ pid: number; cwd: string; command: string }> = [];
      for (const [pid, cwd] of pidToCwd) {
        const command = pidToCommand.get(pid) ?? '';
        if (command.includes(' -p ') || command.includes('--output-format')) continue;
        if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;
        out.push({ pid, cwd, command });
      }
      return out;
    } catch (err) {
      // 权限不足（macOS 上 lsof 看其他用户需要 root）
      logger.debug(`lsof 失败（可能权限不足）: ${err}`);
      return [];
    }
  }

  return [];
}

/**
 * 单进程 cwd 读取（仅在 process-info 注入层使用，主流程已切到批量）
 * 保留此函数用于探测和单点测试
 */
function getProcessCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch (err) {
      logger.debug(`读取 /proc/${pid}/cwd 失败: ${err}`);
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      const result = Bun.spawnSync(['lsof', '-p', String(pid), '-a', '-d', 'cwd', '-Fn']);
      if (result.exitCode === 0) {
        const output = new TextDecoder().decode(result.stdout);
        const match = output.match(/^n(.+)$/m);
        return match ? match[1] : null;
      }
      return null;
    } catch (err) {
      logger.debug(`lsof 失败: pid=${pid}: ${err}`);
      return null;
    }
  }
  return null;
}
```

**macOS 权限降级路径**（v1.0 缺失）：
- 同用户下 lsof 通常可读（`validate` 通过 `process.kill(pid, 0)`）
- 跨用户/daemon 启动时（如 launchd）可能无权读取
- 降级策略：在 daemon 启动时探测一次，能读就启用 CLI 活跃检测；不能读就**只在飞书侧使用 mtime + marker 检测**
- 配置项 `runtime.cli_process_detection_enabled`（默认 true，daemon 探测失败自动设为 false）

#### 4.5.2 进程组关系（子代理场景）

Claude 启动 sub-agent 时，sub-agent 是原 claude 进程的子进程或孙进程。`pgrep -P <claude_pid>` 只能拿到直接子进程；孙进程需要递归检测。

```typescript
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

### 4.6 组合判定：按方向分流的检测函数

```typescript
export interface ActivityResult {
  isProcessing: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  source: 'marker' | 'cpu' | 'child' | 'mtime' | 'none';
}

const DETECTION_TIMEOUT_MS = 3000;

export async function isSessionActive(
  entry: SessionEntry,
  cache: SessionActivityCache,
  direction: 'feishu-detects-cli' | 'cli-detects-feishu',
  timeoutMs: number = DETECTION_TIMEOUT_MS
): Promise<ActivityResult> {
  const cacheKey = `${direction}:${entry.sessionUuid ?? entry.cwd}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = await withTimeout(
    detectActivity(entry, direction),
    timeoutMs,
    { isProcessing: false, confidence: 'low', reason: 'detection_timeout', source: 'none' }
  );

  cache.set(cacheKey, result);
  return result;
}

async function detectActivity(
  entry: SessionEntry,
  direction: 'feishu-detects-cli' | 'cli-detects-feishu'
): Promise<ActivityResult> {
  // ===== 飞书检测 CLI =====
  // 信号源：CLI 侧的进程 + JSONL 写入
  if (direction === 'feishu-detects-cli') {
    return detectCliActivity(entry);
  }

  // ===== CLI 检测飞书 =====
  // 信号源：飞书侧主动声明的 marker（不需要进程检测）
  if (direction === 'cli-detects-feishu') {
    return detectFeishuActivity(entry);
  }

  return { isProcessing: false, confidence: 'low', reason: 'unknown_direction', source: 'none' };
}

async function detectCliActivity(entry: SessionEntry): Promise<ActivityResult> {
  // 1. 进程 + CPU + 子进程（最直接）
  if (config.get<boolean>('runtime.cli_process_detection_enabled', true)) {
    const proc = findClaudeProcessByCwd(entry.cwd);
    if (proc) {
      // 子进程/后代进程检测（最快信号）
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

      // CPU 采样（次快，1 秒）
      const cpuResult = await sampleCPU(entry.cwd);
      if (cpuResult.isProcessing) {
        return {
          isProcessing: true,
          confidence: cpuResult.confidence,
          reason: cpuResult.reason,
          source: 'cpu',
        };
      }

      // 进程存在但无子进程 + CPU≈0：进程 Idle，高置信不活跃
      return {
        isProcessing: false,
        confidence: 'high',
        reason: 'cli_process_idle',
        source: 'cpu',
      };
    }
  }

  // 2. JSONL mtime 增长（fallback）
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

async function detectFeishuActivity(entry: SessionEntry): Promise<ActivityResult> {
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

### 4.7 检测结果缓存

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
```

**缓存 key 设计**：`${direction}:${sessionUuid}`，避免飞书检测和 CLI 检测的缓存互相干扰。

**主动失效时机**：
- `sendSDKMessage` 收到新 chunk 时：`activityCache.invalidate('cli-detects-feishu:' + sessionUuid)`
- `sendMessage` / `sendStreamingMessage` 启动 / 结束时：同理

### 4.8 用户-facing 行为差异化

| 置信度 | 行为 | 提示示例 |
|--------|------|---------|
| **High** | 强拦截 | "⚠️ CLI 侧正在处理中（CPU 35%，已运行 2 分钟），请等待完成后再发送消息。" |
| **Medium** | 弱拦截 + 确认 | "⚠️ CLI 侧可能还在处理中，建议等待。确定要发送消息吗？" |
| **Low** | 提示但不拦截 | "💡 CLI 侧可能刚完成一回合，如有新进展会通知你。" |
| **None** | 不拦截 | 正常处理 |

---

## 5. 平台-specific 实现

### 5.1 飞书侧（cc-linker bot）

#### 5.1.1 SDK 模式：写入 Activity Marker

**`ClaudeSessionManager` 新增字段**（`src/proxy/session.ts`）：

```typescript
class ClaudeSessionManager {
  // ... 已有字段 ...
  activityCache?: SessionActivityCache;

  constructor() {
    this.maxConcurrent = Math.max(1, config.get<number>('runtime.max_concurrent_sessions', 2));
    // activityCache 由 FeishuBot 构造后注入（见 5.1.2）
  }

  setActivityCache(cache: SessionActivityCache): void {
    this.activityCache = cache;
  }
}
```

**`sendSDKMessage` 改造**：

```typescript
async sendSDKMessage(...): Promise<...> {
  const sessionUuid = sessionId;
  // ... 已有逻辑 ...

  if (sessionUuid) {
    writeActivityMarker(sessionUuid, 'feishu', 'start', process.pid);
    this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
  }

  try {
    for await (const message of query({ prompt: text, options: sdkOptions })) {
      adapter.adapt(message, (chunk) => {
        // 收到 thinking/text chunk 时刷新 marker（关键改进）
        if (chunk.type === 'thinking' || chunk.type === 'text') {
          if (sessionUuid) {
            writeActivityMarker(sessionUuid, 'feishu', 'heartbeat', process.pid);
            this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
          }
        }
        // ... 原有处理 ...
      });
    }
  } finally {
    if (sessionUuid) {
      writeActivityMarker(sessionUuid, 'feishu', 'end', process.pid);
      this.activityCache?.invalidate(`feishu-detects-cli:${sessionUuid}`);
    }
  }
}
```

**`sendMessage` / `sendStreamingMessage`（非 SDK 模式）也需要失效缓存**：

```typescript
async sendMessage(...): Promise<SendMessageResult> {
  // 启动时失效
  if (sessionId) {
    this.activityCache?.invalidate(`feishu-detects-cli:${sessionId}`);
  }
  // ... 原有逻辑 ...
  // finally 中无需失效（结束后由 marker 写入或下次调用决定）
}

async sendStreamingMessage(...): Promise<SendMessageResult> {
  if (sessionId) {
    this.activityCache?.invalidate(`feishu-detects-cli:${sessionId}`);
  }
  // ... 原有逻辑 ...
}
```

> **缓存方向说明**（修复 11）：
> - `feishu-detects-cli:` 缓存：当飞书正在通过 SDK 处理时，CLI 侧 resume 不应被打扰
> - `cli-detects-feishu:` 缓存：当 CLI 正在处理时，飞书发消息应被拦截
> - SDK 启动时（`sendSDKMessage`）→ 现在是飞书在处理 → 失效 `feishu-detects-cli` 缓存（让 CLI 侧下次检测拿到最新）
> - SDK 收到 chunk 时 → 同上

#### 5.1.2 飞书侧检测 CLI 活跃

```typescript
// 在 handleChat 入口
private async handleChat(msg: SpoolMessage): Promise<void> {
  switch (msg.target.type) {
    case 'session': {
      const sessionUuid = msg.target.sessionUuid ?? '';
      const currentEntry = this.registry.get(sessionUuid);

      // 跳过强制发送的消息
      if (!msg.skipActivityCheck) {
        try {
          const status = await isSessionActive(
            currentEntry,
            this.activityCache,
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

      // 原有处理逻辑（SDK / streaming / non-streaming）
      // ...
    }
  }
}
```

#### 5.1.3 处理"强制发送"卡片动作

**`SpoolMessage` 接口扩展**（`src/queue/spool.ts`）：

```typescript
export interface SpoolMessage {
  // ... 已有字段 ...
  skipActivityCheck?: boolean;  // 强制发送标记
  awaitingForceSend?: boolean;  // 检测到活跃，等待用户决策
}
```

> 注意：当前 `SpoolMessage` 持久化到 JSON 文件，新增字段需要同步持久化。需要在 `SpoolQueue` 中确保新增字段被正确读写。

**`SpoolQueue` 新增方法**（`src/queue/spool.ts`）：

```typescript
class SpoolQueue {
  // ... 已有方法 ...

  /** 更新消息持久化字段（包括新加的 skipActivityCheck / awaitingForceSend） */
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
}
```

**`handleCardAction` 正确位置**（`src/feishu/bot.ts:321-391`）：

> ⚠️ **关键修复**：`tag` 永远是 `button`，不能用 `switch (tag)` 区分功能。功能区分在 `value.type`（参考 line 335-345 现有 permission 处理模式）。

```typescript
async handleCardAction(payload: FeishuBotCardAction): Promise<...> {
  // ... 已有解析 openId/tag/value 逻辑 ...

  const valueObj = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>) : null;

  // === 卡片 value.type 分支处理（必须放在 switch (tag) 之前）===

  // 权限卡片（已有）
  if (valueObj && (valueObj.type === 'permission_approve' || valueObj.type === 'permission_deny')) {
    // ... 已有逻辑 ...
  }

  // ★ 新增：强制发送卡片
  if (valueObj && valueObj.type === 'cli_force_send') {
    return await this.handleForceSendCardAction(openId, valueObj, message?.message_id);
  }

  // === 原有 switch (tag) 保持不变 ===
  switch (tag) {
    case 'help': /* ... */
    // ... 其他 case 保持不变 ...
  }
}

/** 强制发送处理（独立方法，便于测试） */
private async handleForceSendCardAction(
  openId: string,
  valueObj: Record<string, unknown>,
  messageId?: string
): Promise<string | Record<string, unknown> | null> {
  const entry = this.userManager.getEntry(openId);
  if (!entry?.sessionUuid) {
    return { /* 错误卡片 */ };
  }

  // 在 processing 目录中查找属于该 session 的消息
  // 重要：消息可能已经在 processing（worker 已 claim），不能用 listPending
  const processingMsgs = this.spoolQueue.listProcessing()
    .filter(m => m.serialKey === entry.sessionUuid && m.openId === openId);

  if (processingMsgs.length === 0) {
    // 消息可能已处理完或被 worker 跳过
    return null;
  }

  const targetMsg = processingMsgs[0];

  // 标记为强制发送（CAS：只在 awaitingForceSend=true 时才允许修改，避免覆盖正常处理）
  const updated = await this.spoolQueue.updateMessageFlags(
    targetMsg.messageId,
    targetMsg.serialKey,
    { skipActivityCheck: true, awaitingForceSend: false }
  );

  if (!updated) {
    return null; // 已被其他路径处理
  }

  // 失效缓存（让 worker 下次 loop 重新检测）
  this.sessionManager.activityCache?.invalidate(`feishu-detects-cli:${entry.sessionUuid}`);

  return null; // 由 worker 在下一轮 loop 中处理
}
```

> **v1.0 中提到的 `force_override` marker 已删除**：写入 marker 没有接收方（CLI 侧不会读），纯属无效动作。

#### 5.1.3.1 强制发送的完整状态机

为避免与 worker 的 race condition，**消息在检测到 CLI 活跃时不立即 markDone**，而是进入 `awaitingForceSend` 状态：

```
用户发消息
   │
   ▼
[pending] ───────────► [processing] ──► worker.handleChat
   │                       │                │
   │                       │                ├─ skipActivityCheck=true → 直接处理
   │                       │                ├─ awaitingForceSend=true → 等待用户决策
   │                       │                └─ 默认 → isSessionActive() 检测
   │                       │                       │
   │                       │                       ├─ inactive → 正常处理
   │                       │                       └─ active (high/medium)
   │                       │                              │
   │                       │                              ├─ 发等待卡片
   │                       │                              ├─ awaitingForceSend=true
   │                       │                              └─ 不动 spool（消息保持 processing）
   │                       │
   │                       └─ 用户点强制发送
   │                              │
   │                              ▼
   │                       updateMessageFlags(skipActivityCheck=true)
   │                              │
   │                              ▼
   │                       worker 下一轮 loop 检测到变更
   │                              │
   │                              ▼
   │                       正常处理（跳过活跃检测）
   │
   └─ 用户不点（30s 后）
          │
          ▼
       超时：worker 重新检测一次，仍活跃则继续等待
              仍不活跃则按 inactive 处理
```

**关键不变量**：
- 等待期间消息**始终在 `processing/`**，不回到 `pending/`
- `awaitingForceSend` 是持久化字段（重启不丢）
- 强制发送和正常处理通过 `skipActivityCheck` 标志互斥
- Worker 在每轮 loop 开头检查 `awaitingForceSend` 状态变化

#### 5.1.4 卡片结构

```typescript
async createCLIBusyCard(
  openId: string,
  sessionTitle: string,
  status: ActivityResult
): Promise<string> {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ CLI 侧会话处理中' },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'markdown',
        content: `会话 **"${sessionTitle}"** 正在 **CLI 终端** 处理中。\n\n> 💡 检测依据：${status.reason}\n> 建议等待 CLI 侧处理完毕后再继续对话。`,
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '⚡ 强制发送（会打断 CLI）' },
          type: 'danger',
          value: { type: 'cli_force_send' },
        }],
      },
    ],
  };
  // ... 发送逻辑 ...
}
```

### 5.2 CLI 侧（cc-linker resume）

`src/cli/commands/resume.ts` 在原有 `isSessionBusy` 检测基础上，**叠加**新的 marker 检测。

> **CLI cache 与 Bot cache 一致性说明**（修复 11）：
> - Bot 是长进程 → `SessionActivityCache` 注入到 `ClaudeSessionManager` 单例 → 跨消息复用
> - CLI `resume` 是短进程（一次性命令）→ 每次执行创建本地 `SessionActivityCache` 实例
> - 这种差异是**有意的**：CLI 命令执行完毕即退出，缓存无需持久；Bot 需要跨多次消息复用

```typescript
export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  // ... 已有逻辑（找 session、状态检查、JSONL 验证）...

  // 1. 现有检测：Bot 是否在处理此 session
  const busy = isSessionBusy(uuid);
  if (busy) {
    if (opts.force) {
      console.log(chalk.yellow(`⚠️ 会话 ${uuid.slice(0, 8)} 正在被 Bot 处理，--force 跳过冲突警告`));
    } else {
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `会话 ${uuid.slice(0, 8)} 正在被 Bot 处理，同时用 CLI 恢复可能导致状态冲突。继续？`,
        default: false,
      }]);
      if (!confirmed) return;
    }
  } else if (StateCoordinator.isLocked()) {
    console.log(chalk.dim('Bot 正在运行，但未处理此会话，可安全恢复'));
  }

  // 2. 新增检测：飞书侧是否活跃（通过 marker）
  // 注意：复用现有 --force 选项语义（与 busy 检查共用），不要重复 prompt
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
      // 降级：继续（不阻止用户）
    }
  }

  // ... 后续 resume 逻辑 ...
}
```

**`--force` 语义统一**（修复 21）：
- `--force` 同时跳过 `isSessionBusy`（已有）和 `marker` 检测（新加）
- 避免用户被问两次确认
- 与现有 `cli_force_send` 卡片按钮语义对齐："我知道会打断，但我还是要"

### 5.3 交互式 CLI 的 Hook 自动标记（可选增强）

```json
// ~/.claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": ["cc-linker-activity-hook --platform=cli --action=start"]
    }],
    "Stop": [{
      "hooks": ["cc-linker-activity-hook --platform=cli --action=end"]
    }]
  }
}
```

实现一个独立 `cc-linker-activity-hook` 命令，接收 `--platform` / `--action` 参数，写入 sidecar 文件。

**优点**：让 CLI 侧也能被飞书侧 100% 准确检测。
**缺点**：需要用户配置。

---

## 6. 与固定阈值方案对比

| 场景 | 固定阈值（10分钟） | 本方案（marker + 实时采样） |
|------|-------------------|----------------------|
| 回合完成，用户阅读结果 5 分钟 | ❌ 误判为活跃 | ✅ CLI 侧：CPU=0% 判定不活跃；飞书侧：marker `end` 判定不活跃 |
| 长回合进行中（5分钟） | ✅ 不误判 | ✅ CLI 侧：CPU>10% 判定活跃；飞书侧：streaming chunk 持续刷新 marker |
| 进程 Idle 但存在 | ❌ 误判为活跃 | ✅ CPU=0% 判定不活跃 |
| 工具执行中（Bash 运行） | ⚠️ 依赖阈值 | ✅ 子进程存在，判定活跃 |
| 飞书 SDK 处理中 | ⚠️ 依赖阈值 | ✅ Marker 直接声明，100% 准确 |
| CLI 侧长推理（>10min） | ❌ 误判为完成 | ✅ TTL 30 分钟 + streaming chunk 持续刷新 |

---

## 7. 实现细节

### 7.1 核心模块

#### 7.1.1 工具函数（`src/utils/async.ts`）

`withTimeout` 在 `src/utils/session-activity.ts` 之外单独抽到 `src/utils/async.ts`（便于其他模块复用）：

```typescript
// src/utils/async.ts
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

#### 7.1.2 版本号常量（`src/version.ts`）

```typescript
// src/version.ts
import pkg from '../package.json' with { type: 'json' };
export const PKG_VERSION: string = pkg.version;
```

#### 7.1.3 进程信息抽象层（`src/utils/process-info.ts`）

为便于测试 mock，把 OS 进程调用抽到独立模块：

```typescript
// src/utils/process-info.ts
export interface ProcessInfo {
  pid: number;
  cwd: string;
  command: string;
}

/** Linux 平台：读 /proc */
export function getLinuxClaudeProcesses(uid: number): ProcessInfo[];

/** macOS 平台：lsof + ps */
export function getDarwinClaudeProcesses(uid: number): ProcessInfo[];

/** 统一入口 */
export function getClaudeProcessesByCwd(targetCwd: string): ProcessInfo[] {
  const uid = process.getuid?.() ?? 0;
  if (process.platform === 'linux') return getLinuxClaudeProcesses(uid);
  if (process.platform === 'darwin') return getDarwinClaudeProcesses(uid);
  return [];
}

/** 单进程 CPU 时间（秒） */
export function getProcessCPUTimeSeconds(pid: number): Promise<number>;
```

> 测试时可以通过 `bun:test` 的 `mock.module` 替换整个 `process-info.ts`，无需操作真实进程。

#### 7.1.4 主模块（`src/utils/session-activity.ts`）

```typescript
import { withTimeout } from './async';
import { getClaudeProcessesByCwd, getProcessCPUTimeSeconds } from './process-info';

// 类型
export interface ActivityResult {
  isProcessing: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  source: 'marker' | 'cpu' | 'child' | 'mtime' | 'none';
}

export interface ActivityMarker {
  type: 'activity_marker';
  uuid: string;
  platform: 'feishu' | 'cli';
  action: 'start' | 'end' | 'heartbeat';
  timestamp: string;
  pid?: number;
  version: string;
}

// Sidecar 文件操作
export function activityLogPath(sessionUuid: string): string;
export function writeActivityMarker(
  sessionUuid: string,
  platform: 'feishu' | 'cli',
  action: 'start' | 'end' | 'heartbeat',
  pid?: number
): void;
export function readLastActivityMarker(sessionUuid: string): ActivityMarker | null;
export function cleanupOldActivityLogs(maxAgeHours?: number): number;
export function maybeRotateActivityLog(sessionUuid: string): void;

// 主判定
export async function isSessionActive(
  entry: SessionEntry,
  cache: SessionActivityCache,
  direction: 'feishu-detects-cli' | 'cli-detects-feishu',
  timeoutMs?: number
): Promise<ActivityResult>;

// CLI 侧信号
export async function getInstantCPU(pid: number, durationMs?: number): Promise<number>;
export async function hasActiveDescendants(rootPid: number, depth?: number): Promise<ChildResult>;
export function findClaudeProcessByCwd(cwd: string): { pid: number; cwd: string } | null;
export async function isJSONLWrittenSince(jsonlPath: string, sinceMs: number, sampleMs?: number): Promise<{ written: boolean; ageMs: number }>;

// 时间解析工具（用于测试）
export function parsePsTimeToSeconds(timeStr: string): number;

// 缓存
export class SessionActivityCache {
  constructor(ttlMs?: number);
  get(key: string): ActivityResult | null;
  set(key: string, result: ActivityResult): void;
  invalidate(key: string): void;
  clear(): void;
}
```

### 7.2 飞书侧提醒卡片

`src/feishu/card-updater.ts` 新增 `createCLIBusyCard()`，参见 5.1.4。

### 7.3 Scanner：`message_count` 修正（与 marker 解耦）

虽然 marker 改写到 sidecar 后不再污染 JSONL，**但 `message_count` 的修正仍应该独立进行**——当前 `parseFull` 用 `lines.length`（`src/scanner/jsonl.ts:173`），会把 `ai-title` / `last-prompt` 等非消息条目算入。

```typescript
// src/scanner/jsonl.ts
const NON_MESSAGE_TYPES = new Set([
  'ai-title',
  'last-prompt',
  'queue-operation',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'agent-name',
  // 'activity_marker' 也加入此集合以兼容旧版 cc-linker 写入的 JSONL marker
  'activity_marker',
]);

private parseFull(filePath: string, sessionId: string): Partial<SessionEntry> {
  // ... 读取文件 ...
  const lines = content.split('\n').filter(Boolean);

  // 排除非消息条目
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
  };
}
```

`last_active` 的扫描（`parseFull` 后半段）也要排除这些类型：

```typescript
// 扫描最后 10 行找 last_active
for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
  try {
    const entry = JSON.parse(lines[i]);
    if (NON_MESSAGE_TYPES.has(entry.type)) continue; // 跳过
    if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
      lastActive = entry.timestamp;
    }
    // ...
  } catch {}
}
```

### 7.4 配置项（合并到 `runtime` 段）

```toml
# ~/.cc-linker/config.toml
[runtime]
# 已有字段...
cli_process_detection_enabled = true   # CLI 进程检测开关（macOS 权限失败时自动置 false）
activity_cache_ttl_ms = 10000          # 活跃检测结果缓存时间
activity_marker_ttl_ms = 1800000       # marker 有效期（默认 30 分钟，与 hard_timeout_ms 对齐）
activity_detection_timeout_ms = 3000   # 单次检测超时
```

`ConfigData` interface 修改（`src/utils/config.ts:25-31`）：

```typescript
runtime: {
  // ... 已有字段 ...
  cli_process_detection_enabled: boolean;
  activity_cache_ttl_ms: number;
  activity_marker_ttl_ms: number;
  activity_detection_timeout_ms: number;
};
```

**`ConfigManager` 新增 `setRuntimeOverride` 方法**（修复 3）：

```typescript
class ConfigManager {
  private data: ConfigData;
  // 记录运行时覆盖的值（不写回 config.toml，重启后失效）
  private runtimeOverrides = new Map<string, any>();

  setRuntimeOverride(key: string, value: any): void {
    this.runtimeOverrides.set(key, value);
    const [section, k] = key.split('.');
    if (this.data[section as keyof ConfigData]) {
      (this.data[section] as any)[k] = value;
    }
  }

  get<T>(path: string, fallback: T): T {
    // 优先返回运行时覆盖
    if (this.runtimeOverrides.has(path)) {
      return this.runtimeOverrides.get(path) as T;
    }
    // 否则走原有逻辑
    const parts = path.split('.');
    let current: any = this.data;
    for (const part of parts) {
      if (current == null) return fallback;
      current = current[part];
    }
    return current ?? fallback;
  }
}
```

> **持久化策略说明**（修复 14）：
> - 运行时覆盖**不写回** `config.toml`
> - daemon 每次启动会重新探测 lsof，失败则再次覆盖 `false`
> - 用户在 `config.toml` 显式设 `false` 等同于"我知道 macOS 没权限，关掉"
> - 用户在 `config.toml` 显式设 `true`，但探测失败 → 实际生效是 `false`（与用户意图相反，但更安全）

### 7.5 启动时序（修复 18）

`src/cli/commands/start.ts` 中，**严格按以下顺序初始化**（修复 18）：

```typescript
async function startForeground(registry: RegistryManager, opts: StartOptions): Promise<void> {
  // Step 1: 探测 CLI 进程检测可用性（必须在创建 FeishuBot 之前）
  const cliDetectionOk = probeCliProcessDetection();
  if (!cliDetectionOk) {
    logger.warn('CLI 进程检测不可用（macOS 权限），将只使用 marker + mtime 检测');
    config.setRuntimeOverride('cli_process_detection_enabled', false);
  }

  // Step 2: 清理过期 activity 日志
  const cleaned = cleanupOldActivityLogs(24);
  logger.info(`清理过期 activity 日志: ${cleaned} 个文件`);

  // Step 3: 创建 SessionActivityCache 单例
  const activityCache = new SessionActivityCache();

  // Step 4: 创建 ClaudeSessionManager 并注入 cache
  const sessionManager = new ClaudeSessionManager();
  sessionManager.setActivityCache(activityCache);

  // Step 5: 创建 FeishuBot（注入 sessionManager）
  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    sessionManager,  // Bot 通过 sessionManager 访问 activityCache
    // ...
  });

  // Step 6: 启动 bot
  await bot.start();
}

async function probeCliProcessDetection(): Promise<boolean> {
  if (process.platform !== 'darwin') return true; // Linux 一定可用

  // macOS: 探测是否能读自己进程的 cwd
  // 用真实 lsof 调用（不是模拟）
  try {
    const procs = getClaudeProcessesByCwd(process.cwd());
    return procs.length > 0; // 能列出（即使列表为空，也说明 lsof 没权限错）
  } catch {
    return false;
  }
}
```

**`pending_new_session_claimed` 状态处理**（修复 15）：

`detectFeishuActivity` 已有 `if (!entry.sessionUuid)` 保护返回 `{ isProcessing: false, confidence: 'low', reason: 'no_session_uuid' }`。

`writeActivityMarker(null!, ...)` 也不会被调用，因为：
- `sendSDKMessage` 接收 `sessionId: string | null`
- `sessionUuid = sessionId` 为 null 时，`if (sessionUuid)` 块不进入
- **但 `sendSDKMessage` 可能在 `sessionId === null`（new session）时被调用**

需要在 `sendSDKMessage` 内增加保护：

```typescript
async sendSDKMessage(...): Promise<...> {
  const sessionUuid = sessionId;
  // ...

  if (sessionUuid) {  // ★ 已有保护
    writeActivityMarker(sessionUuid, 'feishu', 'start', process.pid);
    // ...
  }

  try {
    for await (const message of query(...)) {
      adapter.adapt(message, (chunk) => {
        if (chunk.type === 'thinking' || chunk.type === 'text') {
          if (sessionUuid) {  // ★ 增加 chunk 内的保护
            writeActivityMarker(sessionUuid, 'feishu', 'heartbeat', process.pid);
            // ...
          }
        }
      });
    }
  } finally {
    if (sessionUuid) {  // ★ 已有保护
      writeActivityMarker(sessionUuid, 'feishu', 'end', process.pid);
      // ...
    }
  }
}
```

**入口侧（`handleChat`）的 `pending_new_session_claim` 状态**：

```typescript
case 'new_session_claim': {
  // 此状态下 sessionUuid 尚未确定
  // 不做活跃检测（直接放行），由用户消息产生 SDK 处理后才会有 marker
  const claimResult = await this.userManager.claimPendingNewSession(...);
  // ... 直接进入 SDK/streaming 处理 ...
}
```

> **结论**：`new_session_claim` 状态完全跳过活跃检测。理由：session 还不存在，无从判断"是否在用"。

### 7.6 Daemon 启动时清理旧 Activity 日志

`startForeground` / `startDaemonChild` 中：

```typescript
import { cleanupOldActivityLogs } from '../utils/session-activity';

const cleaned = cleanupOldActivityLogs(24);
logger.info(`清理过期 activity 日志: ${cleaned} 个文件`);
```

---

## 8. 边界情况处理

| 场景 | 处理方案 |
|------|---------|
| Marker 残留（进程崩溃未写 end） | TTL 30 分钟后自动失效 |
| 飞书 SDK 内部进程被当成 CLI 进程 | `findClaudeProcessByCwd` 排除 `-p`/`--output-format`/SDK bundle 路径 |
| macOS `lsof` 权限不足 | 启动探测，失败则禁用 CLI 进程检测，仅用 mtime |
| CPU 采样时进程退出 | 捕获异常，返回"进程不存在" |
| 子代理（sub-agent） | 递归检测后代进程（深度 3） |
| JSONL 被删除 | 跳过 mtime 检测，依赖其他信号 |
| 旧版本 cc-linker | 不识别 marker，但不影响基本功能 |
| 检测超时（>3s） | 返回 `low` 置信度结果，允许发送 |
| 强制发送后用户重复点击 | `cli_force_send` 通过 serialKey + 消息状态避免重复入队 |
| CLI 端走 `claude --resume` 后 cc-linker 没装 hook | 仍然有进程 CPU + mtime 双重检测，仅精度低 |
| `sendSDKMessage` 中途异常 | `try/finally` 保证 `end` marker 写入 |

---

## 9. 测试计划

### 9.1 单元测试

`tests/unit/utils/session-activity.test.ts`：

```typescript
// === 通用 mock 基础（修复 20：mock 策略） ===
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// 替换整个 process-info 模块（避免操作真实进程）
mock.module('../../src/utils/process-info', () => ({
  getClaudeProcessesByCwd: mock(() => []),
  getProcessCPUTimeSeconds: mock(() => Promise.resolve(0)),
}));

describe('Activity Marker (sidecar)', () => {
  let testDir: string;

  beforeEach(() => {
    // 隔离 ACTIVITY_DIR：通过环境变量 CC_LINKER_DIR 注入（CC_LINKER_DIR 是现有常量）
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('write + read 最近的 marker', async () => {
    // 动态 import 确保读到最新模块
    const sa = await import('../../src/utils/session-activity');
    sa.writeActivityMarker('test-uuid', 'feishu', 'start', 12345);
    sa.writeActivityMarker('test-uuid', 'feishu', 'heartbeat', 12345);
    const marker = sa.readLastActivityMarker('test-uuid');
    expect(marker?.action).toBe('heartbeat');
    expect(marker?.platform).toBe('feishu');
  });

  test('end marker 标记为不活跃', async () => { /* 通过 isSessionActive 间接测 */ });
  test('heartbeat 3 分钟内 = high confidence', () => { /* mock Date.now() */ });
  test('heartbeat 30 分钟 + = inactive', () => { /* ... */ });
  test('sidecar 文件不存在 → return null', () => { /* ... */ });
  test('appendFile 失败不抛错（log warning）', () => { /* mock fs.appendFileSync 抛错 */ });
  test('64KB 自动 rotate 保留尾部 50%', () => { /* ... */ });
});

describe('CPU Sampling', () => {
  test('parsePsTimeToSeconds: macOS 各格式', async () => {
    const sa = await import('../../src/utils/session-activity');
    // 单条（< 1 分钟）
    expect(sa.parsePsTimeToSeconds('12.34')).toBe(12.34);
    // MM:SS
    expect(sa.parsePsTimeToSeconds('1:23.45')).toBe(83.45);
    // HH:MM:SS（macOS 实际格式：1 小时 = "1:23:45"）
    expect(sa.parsePsTimeToSeconds('1:23:45')).toBe(5025);
    expect(sa.parsePsTimeToSeconds('12:34:56')).toBe(45296);
    // DD-HH:MM:SS（>= 1 天，长任务场景）
    expect(sa.parsePsTimeToSeconds('2-01:23:45')).toBe(2 * 86400 + 5025);
    // 空
    expect(sa.parsePsTimeToSeconds('')).toBe(0);
  });

  test('Linux: /proc/<pid>/stat 解析（comm 含空格）', () => {
    // mock getProcessCPUTimeSeconds 返回固定值
  });

  test('两次采样差值正确', () => {
    // mock t1=10s, t2=11.5s, wallClock=1s → CPU=150%
  });
});

describe('Process Detection', () => {
  test('findClaudeProcessByCwd 排除 -p 进程', () => { /* mock getClaudeProcessesByCwd 返回带 -p 的进程 */ });
  test('findClaudeProcessByCwd 排除 SDK bundle 路径', () => { /* ... */ });
  test('findClaudeProcessByCwd 处理 symlink（realpath）', () => { /* ... */ });
  test('getClaudeProcessesByCwd macOS 一次 lsof 拿所有', () => { /* ... */ });
  test('hasActiveDescendants 递归到深度 3', () => { /* ... */ });
});

describe('isSessionActive (combined)', () => {
  test('direction=feishu-detects-cli + 无进程 → mtime fallback', () => { /* ... */ });
  test('direction=cli-detects-feishu + marker 活跃 → active', () => { /* ... */ });
  test('direction=feishu-detects-cli + lsof 权限失败 → mtime fallback', () => { /* mock lsof 抛错 */ });
  test('direction=cli-detects-feishu + no_session_uuid → low confidence', () => { /* ... */ });
  test('检测超时（>3s）→ low confidence', () => { /* mock detect 永远不 resolve */ });
  test('缓存命中：第二次调用不执行 detect', () => { /* spy on detect */ });
  test('缓存失效：invalidate 后重新检测', () => { /* ... */ });
  test('缓存 key 区分 direction（飞书/CLI 独立）', () => { /* ... */ });
});

describe('Scanner (decoupled fix)', () => {
  test('ai-title / last-prompt 不计入 message_count', () => { /* ... */ });
  test('activity_marker（旧版 JSONL）不计入 message_count', () => { /* ... */ });
  test('last_active 跳过非消息行', () => { /* ... */ });
});

describe('ConfigManager.setRuntimeOverride', () => {
  test('覆盖值优先于配置文件', () => { /* ... */ });
  test('覆盖不写回 config.toml', () => { /* ... */ });
  test('重启后覆盖失效（仅内存）', () => { /* ... */ });
});

describe('SpoolQueue.updateMessageFlags', () => {
  test('持久化 skipActivityCheck', () => { /* ... */ });
  test('持久化 awaitingForceSend', () => { /* ... */ });
  test('处理中消息不存在时返回 false', () => { /* ... */ });
  test('并发修改通过 lockfile 串行化', () => { /* ... */ });
});
```

> `parsePsTimeToSeconds` 必须 `export`（修复 13），否则测试无法直接 import。

### 9.2 集成测试

**测试 A: CLI → 飞书检测（CPU 采样）**
1. 终端启动 `claude`，发送 `sleep 30 && echo done`（模拟长任务）
2. 手机飞书 `/switch` 到该 session
3. 验证：收到"CLI 处理中"提醒（检测到子进程 Bash 或 CPU>0%）
4. 任务完成后
5. 飞书再次尝试，验证：正常处理（CPU=0%）

**测试 B: 飞书 → CLI 检测（Activity Marker）**
1. 手机飞书发送长任务
2. 终端执行 `cc-linker resume <id>`
3. 验证：收到"飞书处理中"提示（检测到 sidecar marker）
4. 选择"否"
5. 飞书任务完成后（marker `end` 写入），再次 resume，验证：正常

**测试 C: 强制发送**
1. 飞书检测到 CLI 活跃 → 发送"等待"卡片
2. 用户点击"强制发送"
3. 验证：消息正常处理，`skipActivityCheck=true`
4. 飞书侧写入 marker 被检测到（因为 SDK 也会启动进程，但已被 `findClaudeProcessByCwd` 排除）

**测试 D: 超长回合（>10 分钟）**
1. 飞书发送需要 20 分钟的长任务
2. 启动后 5 分钟，CLI 侧尝试 resume
3. 验证：仍提示飞书活跃（streaming chunk 持续刷新 marker）
4. 任务完成后，CLI 侧再次 resume，验证：正常

**测试 E: macOS 权限降级**
1. 模拟 `lsof` 失败（mock）
2. 启动 daemon，验证：`cli_process_detection_enabled` 自动设为 false
3. 飞书检测 CLI 时跳过进程检测，仅用 mtime

---

## 10. 附录

### 10.1 相关文件清单

| 文件 | 说明 | 状态 |
|------|------|------|
| `src/utils/async.ts` | **新增**：`withTimeout` 工具 | 新增 |
| `src/utils/process-info.ts` | **新增**：OS 进程调用抽象层（便于 mock 测试） | 新增 |
| `src/utils/session-activity.ts` | **新增**：核心模块（sidecar 读写、CPU 采样、子进程检测、mtime、缓存） | 新增 |
| `src/version.ts` | **新增**：`PKG_VERSION` 常量 | 新增 |
| `src/proxy/session.ts` | `sendSDKMessage` 内写入 marker；新增 `activityCache` 字段；`setActivityCache()` | 修改 |
| `src/feishu/bot.ts` | `handleChat` 入口检测；`handleCardAction` 新增 `value.type === 'cli_force_send'` 分支；新增 `handleForceSendCardAction` 方法 | 修改 |
| `src/feishu/card-updater.ts` | `createCLIBusyCard()` | 修改 |
| `src/feishu/mapping.ts` | （无修改） | - |
| `src/cli/commands/resume.ts` | 在 `isSessionBusy` 后叠加 marker 检测；复用 `--force` | 修改 |
| `src/scanner/jsonl.ts` | 独立修正 `message_count` / `last_active` 排除非消息类型 | 修改 |
| `src/queue/spool.ts` | `SpoolMessage` 新增 `skipActivityCheck` / `awaitingForceSend`；新增 `updateMessageFlags()` 方法 | 修改 |
| `src/utils/config.ts` | `runtime` 段新增 4 个配置项；新增 `setRuntimeOverride` 方法 | 修改 |
| `src/cli/commands/start.ts` | 启动时探测 CLI 进程检测可用性 + 清理旧 activity 日志 + 创建 SessionActivityCache 并注入 | 修改 |
| `src/utils/paths.ts` | 新增 `ACTIVITY_DIR` 常量 | 修改 |
| `tests/unit/utils/async.test.ts` | **新增**：`withTimeout` 单元测试 | 新增 |
| `tests/unit/utils/session-activity.test.ts` | **新增**：核心模块测试（用 `mock.module` 替换 process-info） | 新增 |

### 10.2 时序图

```
飞书 SDK 会话                     cc-linker bot
    │                                   │
    │ query({ resume: sessionId })      │
    │ ◄───────────────────────────────  │
    │                                   │ writeActivityMarker('start') → sidecar
    │ stream_event delta                │
    │ ◄───────────────────────────────  │
    │                                   │ writeActivityMarker('heartbeat') → sidecar
    │ stream_event delta                │
    │ ◄───────────────────────────────  │
    │ stream_event delta                │ (无新 chunk → 2 分钟内不写 marker)
    │ result                            │
    │ ◄───────────────────────────────  │
    │                                   │ writeActivityMarker('end') → sidecar
    │                                   │ activityCache.invalidate(...)

交互式 CLI 会话                    cc-linker bot（飞书侧）
    │                                   │
    │ 用户发送消息                      │
    │ Claude 开始思考                   │
    │ CPU=35% ────────────────────────► │ findClaudeProcessByCwd → 找到进程
    │                                   │ sampleCPU() → 35%
    │                                   │ 判定：活跃
    │ Bash 子进程启动                   │ hasActiveDescendants() → true
    │                                   │ 判定：活跃（高置信度）
    │ 任务完成                          │
    │ CPU=0% ────────────────────────► │ sampleCPU() → 0%
    │                                   │ 判定：不活跃
```

### 10.3 v1.0 → v1.1 关键改动对照

| 议题 | v1.0 | v1.1 | 原因 |
|------|------|------|------|
| Marker 存储 | 写入 JSONL | sidecar 文件 | 避免与 Claude 写入竞争；不污染 JSONL 字段 |
| Marker 刷新 | 2 分钟定时器 | streaming chunk 触发 + 备用定时器 | 长思考场景保持高置信 |
| Marker TTL | 10 分钟 | 30 分钟 | 与 hard_timeout 对齐 |
| 信号源 | 飞书侧也用 CPU/进程检测 | 飞书侧只用 marker，CLI 侧用进程/CPU/mtime | 避免 SDK 内部进程被误判为"CLI 在用" |
| 强制发送 | 写 `force_override` marker | 加 `skipActivityCheck` 字段直接处理 | 旧方案 marker 无接收方 |
| 进程过滤 | 仅排除 `-p` | 排除 `-p` + `--output-format` + SDK bundle 路径 | SDK 内部进程命令行格式不固定 |
| CPU 计算 | ticks 混用，macOS 错误 | 统一用 raw 秒数 | 修复 macOS 误判 |
| `message_count` 修复 | 依赖 marker 排除 | 独立修正（与 marker 解耦） | 解决 ai-title/last-prompt 同样问题 |
| 配置命名空间 | 新增 `session_sync` 段 | 合并到 `runtime` 段 | 减少 ConfigData interface 改动 |
| `activePlatform` 字段 | 存在但无用途 | 移除 | 简化 |
| macOS 权限降级 | 无 | 启动探测 + 自动禁用 | 防止 lsof 失败时静默错误 |
| 与 `isSessionBusy` 关系 | 未提及 | resume 流程中叠加 | 复用现有检测 |
| 检测超时 | 无 | 3 秒上限 | 避免 worker 阻塞 |
| 子代理支持 | 仅直接子进程 | 递归 3 层 | Claude sub-agent 场景 |

### 10.4 v1.1.1 → v1.2 关键修复对照（实施就绪度复审后）

| # | 类型 | 议题 | v1.1.1 | v1.2 |
|---|------|------|--------|------|
| 1 | 🔴 | `withTimeout` 未定义 | 直接调用 | 抽到 `src/utils/async.ts` |
| 2 | 🔴 | `PKG_VERSION` 未定义 | 直接引用 | 抽到 `src/version.ts` |
| 3 | 🔴 | `setRuntimeOverride` 不存在 | 假设存在 | `ConfigManager` 新增方法 + 覆盖语义 |
| 4 | 🔴 | `ClaudeSessionManager.activityCache` 字段缺失 | `this.activityCache?.x` | 类新增字段 + `setActivityCache()` |
| 5 | 🔴 | `cli_force_send` switch 位置错 | `case 'cli_force_send'` | `if (valueObj.type === 'cli_force_send')` |
| 6 | 🔴 | `require('fs')` 在 ESM 中 | CommonJS require | ESM import |
| 7 | 🔴 | `parsePsTimeToSeconds` 不处理 `hh:MM:SS` / `DD-hh:MM:SS` | 只处理 2 段 | 重写为通用解析 |
| 8 | 🔴 | mtime 2s + CPU 1s > 3s 超时 | 默认 2000ms | 默认 500ms |
| 9 | 🔴 | `findClaudeProcessByCwd` 多次 lsof | 循环调用 | 批量 `lsof -u uid -c claude` |
| 10 | 🔴 | Sidecar 无大小上限 | 无 rotate | 64KB rotate 保留 50% |
| 11 | 🔴 | Bot/CLI cache 设计不一致 | 不明确 | 文档明确说明"差异是有意的" |
| 12 | 🔴 | `updateMessageFlags` 方法缺失 | 假设 `updateProcessingMessage` 接受 | SpoolQueue 新增方法 + lockfile 串行 |
| 13 | 🟡 | `parsePsTimeToSeconds` 未 export | 仅函数声明 | 加 `export` |
| 14 | 🟡 | CLI 探测持久化不明 | 不明确 | 覆盖仅内存 + 文档说明 |
| 15 | 🟡 | `pending_new_session_claimed` 未处理 | 不明确 | 显式说明"new session 完全跳过" |
| 16 | 🟡 | `entry.cwd` 可能是 symlink | 字符串比较 | `realpathSync` 统一解析 |
| 17 | 🟡 | 强制发送 race | 模糊描述 | 完整状态机 + 时序图 |
| 18 | 🟡 | `start.ts` 时序不明 | 散在各处 | 显式 6 步启动顺序 |
| 19 | 🟡 | 模块耦合不明 | 不明确 | `process-info` 抽象层 + 注入链 |
| 20 | 🟡 | 测试 mock 策略不明 | 直接调 OS | `mock.module` 替换 process-info |
| 21 | 🟢 | `--force` 语义重复 | 重复 prompt | 复用同一 flag |
| 22 | 🟢 | `handleCardAction` 返回语义 | 不明确 | 显式说明（null/卡片对象） |
| 23 | 🟢 | `entry.cwd` 空字符串 | 未处理 | detectFeishuActivity 已有保护 |
| 24 | 🟢 | `sendStreamingMessage` 未失效缓存 | 仅 SDK | 三种方法都失效 |
| 25 | 🟢 | 数据迁移计划缺失 | 不明确 | §14 显式说明 |

---

## 11. 实施顺序（修复 A）

**Phase 0: 基础工具**（无依赖，可并行）
- 11.0.1 `src/utils/async.ts` + `withTimeout`（含单元测试）
- 11.0.2 `src/version.ts` + `PKG_VERSION`
- 11.0.3 `src/utils/paths.ts` 新增 `ACTIVITY_DIR`

**Phase 1: 进程信息抽象**（Phase 0 完成）
- 11.1.1 `src/utils/process-info.ts` 完整实现（Linux `/proc` + macOS `lsof`）
- 11.1.2 单元测试（mock `lsof` / `/proc` 输出）

**Phase 2: 核心检测模块**（Phase 0+1 完成）
- 11.2.1 `src/utils/session-activity.ts`：
  - 类型定义（`ActivityResult` / `ActivityMarker`）
  - sidecar 读写（`writeActivityMarker` / `readLastActivityMarker`）
  - rotate 逻辑（`maybeRotateActivityLog`）
  - cleanup 逻辑（`cleanupOldActivityLogs`）
  - CPU 采样（`getInstantCPU` + 平台分支）
  - 进程检测（`findClaudeProcessByCwd` 批量 lsof + realpath）
  - 子进程检测（`hasActiveDescendants`）
  - mtime 检测（`isJSONLWrittenSince`）
  - `isSessionActive` 组合判定（按 direction 分流）
  - `SessionActivityCache`
- 11.2.2 单元测试（覆盖率 > 80%）

**Phase 3: 配置 + ConfigManager**（Phase 0 完成）
- 11.3.1 `ConfigData` 增 4 字段
- 11.3.2 `setRuntimeOverride` 方法
- 11.3.3 单元测试

**Phase 4: SpoolMessage + SpoolQueue**（Phase 0 完成）
- 11.4.1 `SpoolMessage` 增 2 字段
- 11.4.2 `SpoolQueue.updateMessageFlags` 方法
- 11.4.3 单元测试（持久化 + lockfile 串行）

**Phase 5: Bot 集成**（Phase 2+3+4 完成）
- 11.5.1 `ClaudeSessionManager` 新增 `activityCache` 字段 + `setActivityCache()`
- 11.5.2 `sendSDKMessage` 写入 marker（start/chunk/end）
- 11.5.3 `sendMessage` / `sendStreamingMessage` 失效缓存
- 11.5.4 `FeishuBot.handleChat` 入口检测
- 11.5.5 `FeishuBot.handleCardAction` 新增 `value.type === 'cli_force_send'` 分支
- 11.5.6 `FeishuBot.handleForceSendCardAction` 独立方法
- 11.5.7 `card-updater.createCLIBusyCard()`
- 11.5.8 集成测试

**Phase 6: 启动时序 + CLI 集成**（Phase 2+3+4 完成）
- 11.6.1 `start.ts` 6 步启动顺序
- 11.6.2 `resume.ts` 叠加 marker 检测（复用 `--force`）
- 11.6.3 集成测试

**Phase 7: Scanner 独立修正**（独立 phase，可任意时机）
- 11.7.1 `jsonl.ts` 引入 `NON_MESSAGE_TYPES`
- 11.7.2 `parseFull` / `parseTail` 排除非消息
- 11.7.3 单元测试 + 数据迁移验证

**Phase 8: Hook 命令（可选增强）**
- 11.8.1 `cc-linker-activity-hook` 子命令
- 11.8.2 `init-feishu.ts` / `init.ts` 提供配置引导

**依赖图**：

```
Phase 0 (async/version/paths)
  │
  ├─→ Phase 1 (process-info) ─→ Phase 2 (session-activity) ─→ Phase 5 (bot integration)
  │                                                              │
  ├─→ Phase 3 (config) ────────────────────────────────────────→ Phase 5
  │                                                              │
  ├─→ Phase 4 (spool) ─────────────────────────────────────────→ Phase 5
  │                                                              │
  └─→ Phase 7 (scanner, 独立)                                    │
                                                                 │
                                                  Phase 6 (start + CLI)
```

---

## 12. 接口变更清单（修复 B）

### 12.1 新增类型

| 位置 | 类型 | 说明 |
|------|------|------|
| `src/utils/async.ts` | `withTimeout<T>(...)` | Promise 超时控制 |
| `src/utils/process-info.ts` | `ProcessInfo` | 进程元组 |
| `src/utils/session-activity.ts` | `ActivityResult` | 活跃度判定结果 |
| | `ActivityMarker` | marker 结构 |
| | `ChildResult` | 子进程检测结果 |
| | `SessionActivityCache` | 缓存类 |
| | `DetectionDirection` | `'feishu-detects-cli' \| 'cli-detects-feishu'` |

### 12.2 修改现有类型

| 位置 | 类型 | 变更 |
|------|------|------|
| `src/utils/config.ts` | `ConfigData.runtime` | + 4 字段 |
| | `ConfigManager` | + `setRuntimeOverride()`, `runtimeOverrides` Map |
| `src/queue/spool.ts` | `SpoolMessage` | + `skipActivityCheck?`, `awaitingForceSend?` |
| | `SpoolQueue` | + `updateMessageFlags()` 方法 |
| `src/proxy/session.ts` | `ClaudeSessionManager` | + `activityCache?` 字段, `setActivityCache()` 方法 |
| | `sendSDKMessage` | 签名不变，行为增加 marker 写入 |
| `src/feishu/bot.ts` | `FeishuBot` | + `handleForceSendCardAction()` 方法 |
| | `handleCardAction` | 在 valueObj 分支前增加 cli_force_send 处理 |
| `src/utils/paths.ts` | (常量) | + `ACTIVITY_DIR` |

### 12.3 修改现有函数行为

| 位置 | 函数 | 变更 |
|------|------|------|
| `src/cli/commands/start.ts` | `startForeground` | 6 步启动顺序（探查→清理→cache→sessionManager→bot→启动） |
| `src/cli/commands/resume.ts` | `resume` | 在 `isSessionBusy` 后叠加 marker 检测（共用 `--force`） |
| `src/scanner/jsonl.ts` | `parseFull` / `parseTail` | 排除 `NON_MESSAGE_TYPES` |
| `src/utils/config.ts` | `get()` | 优先返回 `runtimeOverrides` |

### 12.4 新增文件

| 路径 | 行数估算 | 说明 |
|------|----------|------|
| `src/utils/async.ts` | ~30 | `withTimeout` |
| `src/utils/process-info.ts` | ~120 | OS 进程抽象 |
| `src/utils/session-activity.ts` | ~400 | 核心模块 |
| `src/version.ts` | ~3 | 版本常量 |
| `tests/unit/utils/async.test.ts` | ~50 | 异步工具测试 |
| `tests/unit/utils/session-activity.test.ts` | ~300 | 核心模块测试 |

### 12.5 受影响但未修改的代码

| 位置 | 说明 |
|------|------|
| `src/feishu/mapping.ts` | 不需要改（活跃检测在更高层） |
| `src/registry/*` | 不需要改（活跃检测不影响 registry 持久化） |
| `src/runtime/*` | 不需要改（state-coordinator 仅关心 daemon 进程） |

---

## 13. 回滚计划（修复 C）

### 13.1 飞书侧回滚（关闭活跃检测）

**一行回退**：`src/feishu/bot.ts:handleChat` 中跳过 `isSessionActive` 调用：

```typescript
// 临时回退：注释掉活跃检测
// if (!msg.skipActivityCheck) {
//   const status = await isSessionActive(...);
//   if (status.isProcessing && ...) { ... }
// }
```

**配置回退**：在 `~/.cc-linker/config.toml` 设置 `cli_process_detection_enabled = false`（不影响 marker 写入，但关闭飞书侧检测）。

### 13.2 CLI 侧回滚

**一行回退**：`src/cli/commands/resume.ts` 中跳过 marker 检测块。

### 13.3 完整回滚（移除整个功能）

按相反顺序执行 Phase 8 → Phase 1：
1. 移除 `FeishuBot.handleForceSendCardAction` + `value.type === 'cli_force_send'` 分支
2. 移除 `handleChat` 入口检测
3. 移除 `ClaudeSessionManager.activityCache` 字段
4. 移除 `sendSDKMessage` / `sendMessage` / `sendStreamingMessage` 中的 marker 写入
5. 移除 `resume.ts` 中的 marker 检测
6. 移除 `start.ts` 6 步启动顺序
7. 移除 `config.ts` 新增字段 + `setRuntimeOverride`
8. 移除 `spool.ts` 新增字段 + `updateMessageFlags`
9. 删除 `src/utils/session-activity.ts` / `src/utils/process-info.ts` / `src/utils/async.ts` / `src/version.ts`
10. 还原 `scanner/jsonl.ts` 的 `parseFull` / `parseTail`（如果 Phase 7 已合入）

**回滚后状态**：等价于当前版本（无活跃检测）。

### 13.4 数据库/状态清理

- `~/.cc-linker/activity/` 目录：可手动 `rm -rf`（无副作用）
- `~/.cc-linker/registry.json`：`message_count` 数值变更（如果 Phase 7 已执行）→ 无自动还原方式
- `~/.cc-linker/user-mapping.json`：不变

---

## 14. 数据迁移（修复 25）

### 14.1 `message_count` 一次性重算

Phase 7 完成后，所有 session 的 `message_count` 会从 `lines.length` 变成 `lines.length - 非消息行数`。

**变化幅度估算**：
- 旧 JSONL 通常含 5-15% 的非消息行（`ai-title`, `last-prompt`, `queue-operation` 等）
- 用户感知：列表里的消息数**下降**（例：100 → 87）
- 这是**预期行为**，不是 bug

**沟通方式**：
- CHANGELOG 标注："重算 message_count，仅排除元数据行"
- 不自动通知用户（数值变化是隐式且良性的）

### 14.2 新增字段的兼容性

| 字段 | 旧数据兼容 | 说明 |
|------|-----------|------|
| `SpoolMessage.skipActivityCheck` | undefined → false | 不持久化时无影响 |
| `SpoolMessage.awaitingForceSend` | undefined → false | 不持久化时无影响 |
| `ConfigData.runtime.{4 字段}` | 默认值 | DEFAULTS 已包含 |
| `ConfigManager.runtimeOverrides` | 空 Map | 每次启动重建 |

**老 bot 进程 + 新代码**：不识别 marker，但 `isSessionActive` 不会报错（read 不到 marker → 返回 inactive）。
**新 bot 进程 + 老代码**：marker 写入 sidecar 不影响老代码路径。

### 14.3 升级步骤

1. **软启动**：
   - 新版本 daemon 启动时，**第一次** `cleanupOldActivityLogs(24)` 不会清理任何文件（首次）
   - `cli_process_detection_enabled` 探测：macOS 失败时 `setRuntimeOverride(false)`
   - 此时如果用户同时在飞书 SDK 处理，CLI 侧 resume 会因为 `isSessionActive` 返回 `inactive`（无 marker）而正常 resume → **可能会打断**（首次升级的特殊场景）

2. **缓解措施**：
   - 升级期间建议用户**先停止飞书 bot**，完成 CLI 侧的升级，再启动 bot
   - 或者：在 `start.ts` 中加一个 `MIGRATION_GRACE_PERIOD`（例如 5 分钟），期间所有活跃检测返回 `inactive`
   - 5 分钟后正常生效

3. **回退**：见 §13。

### 14.4 并发场景

如果用户从老版本直接升级到新版本，**没有 5 分钟的 grace period**：
- 老 daemon 已运行（无活跃检测）
- 升级重启 → 新 daemon 启动 → 立即生效活跃检测
- 期间飞书可能在 SDK 处理（老 daemon 退出前最后的消息）→ 新 daemon 启动后看不到 marker → 误判 inactive
- **罕见但可能**：用户飞书端发消息期间重启 daemon，可能打断

**建议**：在 start.ts 加 30 秒 grace period（不写 marker 时也不检测），让旧 daemon 彻底退出：

```typescript
// start.ts
async function startForeground(...) {
  // ... 6 步启动 ...
  logger.info('活跃检测 grace period: 30 秒（避免升级期间误判）');
  await sleep(30_000);
  // 之后才接受 worker claim
  await bot.start();
}
```
