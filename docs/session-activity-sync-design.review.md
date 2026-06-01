# 方案 Review 问题清单

## 🔴 严重问题（必须修复）

### 1. macOS `ps %cpu` 返回的是平均 CPU，不是瞬时 CPU

**文档位置**：4.2 节 `isProcessingByCPU` 函数

**问题**：
```typescript
samples.push(await getProcessCPU(proc.pid));
// 假设实现是：ps -p <pid> -o %cpu=
```

在 **macOS** 上，`ps -p <pid> -o %cpu=` 返回的是**自进程启动以来的平均 CPU 使用率**，不是瞬时采样值。

**后果**：
- Claude 运行 10 分钟后，即使现在 Idle 等待输入，`%cpu` 仍可能显示 5-10%
- 导致大量假阳性（误判为活跃）

**修复方案**：
```typescript
// 正确的瞬时 CPU 采样：两次读取 CPU 时间，计算差值
async function getInstantCPU(pid: number): Promise<number> {
  const time1 = await getProcessCPUTime(pid);
  await sleep(1000);
  const time2 = await getProcessCPUTime(pid);

  // 计算 1 秒内的 CPU 时间占比
  const ticksPerSec = 100; // Linux: 100Hz, macOS: varies
  const cpuPercent = ((time2 - time1) / ticksPerSec) * 100;

  return Math.min(cpuPercent, 100 * os.cpus().length);
}

// 跨平台读取进程 CPU 时间
async function getProcessCPUTime(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    // Linux: /proc/<pid>/stat 第 14、15 列 (utime + stime)
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const parts = stat.split(' ');
    return parseInt(parts[13]) + parseInt(parts[14]);
  }

  if (process.platform === 'darwin') {
    // macOS: 使用 top 的瞬时采样
    const result = Bun.spawnSync([
      'top', '-pid', String(pid), '-l', '2', '-stats', 'cpu'
    ]);
    const lines = new TextDecoder().decode(result.stdout).split('\n');
    // 取第二次采样结果（第一次是历史平均值）
    const lastLine = lines.filter(l => l.includes(String(pid))).pop();
    // 解析 CPU 列...
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}
```

**或者更简单的方案**：放弃精确的 CPU 百分比，改用**"是否有输出"**来判断：

```typescript
// 更简单的方案：检测 stdout 是否有新输出
async function hasRecentOutput(pid: number, durationMs: number = 3000): Promise<boolean> {
  // 通过 lsof 找到进程的 stdout 管道/pty
  // 检测是否有新数据写入（复杂，不推荐）
}
```

**推荐方案**：使用 `pidstat`（Linux）或 `top -l 2`（macOS）做真正的瞬时采样。

---

### 2. `findClaudeProcessByCwd` 实现缺失且困难

**文档位置**：4.2 节、4.5 节多处使用

**问题**：交互式 `claude` 进程没有 `--cwd` 参数，如何关联到 session 的 cwd？

**当前假设**：
```typescript
const proc = findClaudeProcessByCwd(entry.cwd);
```

**实现难点**：
- `pgrep -f 'claude'` 只能匹配命令行，cwd 不在命令行中
- macOS 没有 `pwdx`（Linux 才有）
- macOS 获取进程 cwd：`lsof -p <pid> | grep cwd`，但需要 root 权限才能查看其他用户的进程

**修复方案**：

```typescript
function findClaudeProcessByCwd(cwd: string): { pid: number; cwd: string } | null {
  // 1. 获取当前用户所有 claude 进程
  const uid = process.getuid?.() ?? 0;
  const result = Bun.spawnSync(['pgrep', '-u', String(uid), '-f', 'claude']);
  if (result.exitCode !== 0) return null;

  const pids = new TextDecoder().decode(result.stdout)
    .split('\n').filter(Boolean).map(Number);

  // 2. 过滤掉 cc-linker 自己 spawn 的进程（带 -p 参数）
  const interactivePids = pids.filter(pid => {
    const cmd = getProcessCommand(pid);
    return !cmd.includes('-p ') && !cmd.includes('--output-format');
  });

  // 3. 获取每个进程的 cwd（平台相关）
  for (const pid of interactivePids) {
    const procCwd = getProcessCwd(pid);
    if (procCwd === cwd) {
      return { pid, cwd: procCwd };
    }
  }

  return null;
}

function getProcessCwd(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      // Linux: /proc/<pid>/cwd 是符号链接
      const { readlinkSync } = require('fs');
      return readlinkSync(`/proc/${pid}/cwd`);
    }

    if (process.platform === 'darwin') {
      // macOS: lsof -p <pid> -a -d cwd -Fn
      const result = Bun.spawnSync(['lsof', '-p', String(pid), '-a', '-d', 'cwd', '-Fn']);
      if (result.exitCode === 0) {
        const output = new TextDecoder().decode(result.stdout);
        const match = output.match(/n(.+)/);
        return match ? match[1] : null;
      }
    }
  } catch {
    // 权限不足或其他错误
  }
  return null;
}
```

**关键限制**：macOS 上 `lsof` 查看其他进程需要 root 权限。如果 cc-linker 和 `claude` 以同一用户运行，通常可以访问。

**替代方案**：如果无法获取 cwd，退化为**只检测是否有任何交互式 claude 进程在运行**（不关联具体 session）。

---

### 3. Activity Marker 写入 JSONL 的时机问题

**文档位置**：4.1 节、5.1 节

**问题**：`writeActivityMarker` 直接 `appendFileSync` 到 JSONL 文件，但 Claude 进程可能同时也在写入。

**后果**：
- 理论上 `appendFileSync` 是原子追加，不会破坏文件结构
- 但如果 Claude 在写入大段数据时，marker 插入中间，Scanner 解析可能混乱

**验证**：`appendFileSync` 在大多数文件系统上是原子的（<4KB 时），但需要确认。

**修复**：无需要修复，append 是原子的。但需要在 Scanner 中忽略 `activity_marker` 类型。

---

## 🟡 中等问题（建议修复）

### 4. 缺少"强制发送"的处理流程

**文档位置**：7.2 节卡片设计、多处提到"强制发送"按钮

**问题**：用户点击"强制发送"后，系统如何处理？

**缺失流程**：
1. 用户点击"强制发送"按钮
2. 飞书发送 `card.action.trigger` 事件
3. bot 收到事件后，需要：
   - 写入 `force_override` marker？
   - 直接处理该用户的消息？
   - 更新卡片状态？

**建议方案**：

```typescript
// 处理强制发送的 card action
private async handleForceSendCardAction(action: FeishuBotCardAction): Promise<void> {
  const { open_id, action: { value } } = action;

  if (value?.type === 'cli_force_send') {
    // 1. 获取用户当前 session
    const entry = this.userManager.getEntry(open_id);
    if (!entry?.sessionUuid) return;

    // 2. 写入 force_override marker（告知 CLI 侧被覆盖）
    const sessionEntry = this.registry.get(entry.sessionUuid);
    if (sessionEntry?.jsonl_path) {
      writeActivityMarker(sessionEntry.jsonl_path, 'feishu', 'force_override');
    }

    // 3. 通知用户
    await this.replyFn('⚡ 已强制发送，CLI 侧任务将被打断。', {
      openId: open_id,
      messageId: action.message.message_id,
    });

    // 4. 将用户的消息重新入队处理
    // TODO: 需要一种机制让 bot 处理这条"强制"消息
  }
}
```

**注意**：这需要 SpoolQueue 支持"强制优先级"消息，或者创建一个特殊的内部消息来触发处理。

---

### 5. 组合判定算法有冗余逻辑

**文档位置**：4.5 节 `isSessionProcessing`

**问题代码**：
```typescript
const cpuResult = await isProcessingByCPU(entry.cwd);
if (cpuResult.confidence === 'high') {
  return cpuResult;  // 返回 high
}
if (cpuResult.confidence === 'medium') {
  return cpuResult;  // 返回 medium
}
```

这两段逻辑可以合并。更重要的是：**当 `cpuResult.isProcessing` 为 true 但 confidence 为 'low' 时，没有处理逻辑**。

**修复**：
```typescript
const cpuResult = await isProcessingByCPU(entry.cwd);
if (cpuResult.isProcessing) {
  return cpuResult; // 直接返回 CPU 检测结果（包含 confidence）
}

// CPU 不活跃
if (!cpuResult.isProcessing && cpuResult.confidence === 'high') {
  return {
    isProcessing: false,
    confidence: 'high',
    reason: 'process idle'
  };
}
```

---

### 6. 检测结果缺少缓存，每次消息都采样会延迟

**文档位置**：5.1 节

**问题**：每次飞书消息都进行 CPU 采样（3 次 × 1 秒 = 3 秒），会延迟消息处理。

**修复**：添加短时缓存（10-30 秒）

```typescript
class SessionActivityCache {
  private cache = new Map<string, { result: ActivityResult; expiresAt: number }>();
  private readonly TTL_MS = 10_000; // 10 秒缓存

  get(sessionId: string): ActivityResult | null {
    const cached = this.cache.get(sessionId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
    return null;
  }

  set(sessionId: string, result: ActivityResult): void {
    this.cache.set(sessionId, { result, expiresAt: Date.now() + this.TTL_MS });
  }
}
```

在 `isSessionProcessing` 中使用：
```typescript
export async function isSessionProcessing(
  entry: SessionEntry,
  cache?: SessionActivityCache
): Promise<ActivityResult> {
  if (cache) {
    const cached = cache.get(entry.sessionUuid);
    if (cached) return cached;
  }

  const result = await doDetect(entry);
  if (cache) cache.set(entry.sessionUuid, result);
  return result;
}
```

---

### 7. 飞书来源的 session 也需要检测 CLI 活跃状态

**文档位置**：4.5 节

**问题**：当前代码只在 `entry.origin === 'cli'` 时检测子进程和 CPU。但如果用户先飞书创建 session，之后 CLI `resume` 了这个 session，此时 `entry.origin === 'feishu'`，但 CLI 侧可能正在使用它。

**修复**：无论 origin 是什么，只要 JSONL 文件存在，都应该检测 CLI 进程状态。

```typescript
// 修改前
if (entry.origin === 'cli') {
  const proc = findClaudeProcessByCwd(entry.cwd);
  // ...
}

// 修改后
// 对任何 session，都检测是否有 CLI 进程在使用
const proc = findClaudeProcessByCwd(entry.cwd);
if (proc) {
  // 检测子进程和 CPU...
}
```

---

## 🟢 轻微问题（可选优化）

### 8. 配置项命名空间冲突

**文档位置**：7.3 节

**问题**：`[session_sync]` 是新命名空间，需要确认不会与现有 `config.toml` 解析冲突。

**当前配置结构**：
```typescript
interface ConfigData {
  general: { ... }
  scanner: { ... }
  feishu_bot: { ... }
  runtime: { ... }
  // ...
}
```

**建议**：将 `session_sync` 放在 `runtime` 命名空间下，或者新建但不冲突。

---

### 9. 心跳写入可能影响 JSONL 大小统计

**文档位置**：4.1 节

**问题**：每 2 分钟写入一次 heartbeat marker，会增加 JSONL 文件大小。虽然单次很小（~150 bytes），但长期运行会累积。

**影响**：Scanner 的 `message_count` 统计会把 marker 也算作一行。

**修复**：在 Scanner 解析时，明确排除 `activity_marker` 类型：

```typescript
// src/scanner/jsonl.ts
private parseFull(filePath: string, sessionId: string): Partial<SessionEntry> {
  // ...
  const lines = content.split('\n').filter(Boolean);

  // 排除 activity_marker 等非消息条目
  const messageLines = lines.filter(line => {
    try {
      const entry = JSON.parse(line);
      return entry.type !== 'activity_marker' &&
             entry.type !== 'queue-operation' &&
             entry.type !== 'last-prompt';
    } catch {
      return true;
    }
  });

  return {
    // ...
    message_count: messageLines.length,
  };
}
```

---

### 10. 文档中缺少错误处理说明

**文档位置**：全局

**问题**：没有说明当检测失败时（如权限不足、进程退出）的降级策略。

**建议添加**：
```typescript
// 错误降级策略
try {
  const result = await isSessionProcessing(entry);
  return result;
} catch (err) {
  logger.warn(`会话活跃检测失败: ${err}`);
  // 降级：允许发送消息（不拦截）
  return { isProcessing: false, confidence: 'low', reason: 'detection_failed' };
}
```

---

## 总结：修改建议优先级

| 优先级 | 问题 | 影响 | v1.1 修复位置 |
|--------|------|------|--------------|
| 🔴 P0 | macOS CPU 采样实现错误 | 方案核心逻辑失效 | §4.2.1：改用 raw 秒数统一算法；解析 `ps -o time=` |
| 🔴 P0 | `findClaudeProcessByCwd` 实现缺失 | 无法关联进程和 session | §4.5.1：完整实现（`pgrep -x claude` + 命令行过滤 + cwd 匹配） |
| 🔴 P0 | Activity Marker 写入 JSONL 存在竞争 | JSONL 解析可能混乱 | §4.1.1：改写 sidecar 文件 `~/.cc-linker/activity/<uuid>.log` |
| 🔴 P0 | JSONL `entrypoint` 假设错误 | 影响过滤逻辑 | §1.3 + 注释：实测为 `sdk-cli`，不是 `sdk-ts` |
| 🔴 P0 | `force_override` marker 没有接收方 | 写入是空动作 | §5.1.3：删除 marker，强制发送走 `skipActivityCheck` |
| 🔴 P0 | marker TTL 10 分钟与 `hard_timeout_ms` 不匹配 | 长思考场景假阴性 | §4.1.4：TTL 30 分钟对齐；§4.1.2：streaming chunk 持续刷新 |
| 🔴 P0 | SDK 内部进程被当成"CLI 在用" | 飞书自干扰 | §3.3 + §4.6：信号源严格分离（飞书只信 marker） |
| 🟡 P1 | "强制发送"处理流程缺失 | 功能不完整 | §5.1.3：`SpoolMessage.skipActivityCheck` + 卡片回调分支 |
| 🟡 P1 | 检测结果缺少缓存 | 每次消息延迟 3 秒 | §4.7：`SessionActivityCache` + invalidate 机制 |
| 🟡 P1 | 飞书来源 session 也需要检测 CLI | 双向检测不完整 | §4.6 + §4.6.1：按 direction 分流的检测函数 |
| 🟡 P1 | `doDetect` 遗漏 JSONL mtime 检测 | 长推理场景假阴性 | §4.6.1：mtime 作为 fallback 信号 |
| 🟡 P1 | 缓存与多 worker 竞争 | 数据不一致 | §4.7：缓存 key = `${direction}:${sessionUuid}` |
| 🟡 P1 | macOS lsof 权限问题 | 进程检测失败 | §4.5.1 + §7.5：启动探测 + 降级路径 |
| 🟡 P1 | resume.ts 已有 `isSessionBusy` 未提及 | 重复实现 | §5.2：明确叠加关系 |
| 🟡 P1 | 强制发送的 SpoolQueue 集成缺失 | 功能不可用 | §5.1.3：详细描述流程 |
| 🟢 P2 | 配置项命名空间冲突 | 静默忽略 | §7.4：合并到 `runtime` 段 |
| 🟢 P2 | `message_count` 修复与 marker 耦合 | 重复修复 | §7.3：解耦，独立进行 |
| 🟢 P2 | 错误降级策略缺失 | 异常时体验差 | §4.6 + §5.1.2：try/catch 降级 + 超时 |
| 🟢 P2 | `activePlatform` 字段无用途 | 类型冗余 | §7.1：移除，仅保留 `source` |
| 🟢 P2 | `isSessionProcessing` 无超时 | worker 可能阻塞 | §4.6 + §4.2.2：3 秒超时 + `withTimeout` |
| 🟢 P2 | `getProcessCwd` catch 吞错 | 调试困难 | §4.5.1：catch 加 `logger.debug` |
| 🟢 P2 | `cli_force_send` 卡片分支未实现 | 功能不完整 | §5.1.3 + §10.1：bot.ts 修改点 |
| 🟢 P2 | macOS `parseTimeToTicks` 与 `getClockTick` 矛盾 | 计算错误 | §4.2.1：移除 ticks，统一用秒 |
| 🟢 P2 | 测试缺 mock 平台信号 | 难以自动化 | §9.1：补充 mock 策略 |

---

## v1.1 修订说明

所有 v1.0 中的 P0/P1/P2 问题已在 `session-activity-sync-design.md` v1.1 中修复。关键架构改动：

1. **sidecar 文件替代 JSONL 写入**：彻底解耦 marker 与 scanner，避免文件竞争
2. **信号源分离原则**：飞书侧只信主动 marker，CLI 侧用被动采样，互不干扰
3. **TTL 与 hard_timeout 对齐**：30 分钟 + streaming chunk 持续刷新
4. **macOS 权限降级路径**：启动探测 + 自动禁用，避免静默失败
5. **强制发送走 `skipActivityCheck`**：替代无效的 `force_override` marker

详见 `session-activity-sync-design.md` §10.3 的 v1.0→v1.1 关键改动对照表。
