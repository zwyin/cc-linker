# cc-linker 飞书侧 Attach 之后自动刷新内容卡片设计

**日期：** 2026-06-09
**版本：** v1
**状态：** 已批准（待落地）
**作者：** Claude Code

## 1. 问题陈述

飞书侧 Agent View 当前在 `handleAttach` 成功之后只发一条纯文本确认消息（`📎 已 Attach 到 ...` + status / CWD / 提示），用户没法在手机端"挂着看"被 Attach 的 background session 的实时进展——只能再点 [Peek] 拿静态快照，或者凭印象在脑子里脑补。

希望补齐这一段：Attach 成功后，自动紧跟一条**可交互的会话内容卡片**，**每 10s 自动 patch 一次**该 session 的 status / recentOutput，session 自然 settle 或用户主动干预时停。

复用的现有能力：
- `buildPeekCard`（`src/agent-view/card.ts:170`）— 卡片内容骨架
- `LiveProgressWatcher`（`src/feishu/live-progress.ts`）— 15s/10s polling、in-flight 互斥、patchFailureCount、maxTicks、bot 重启不持久化的全套模板
- `AgentSnapshotFetcher.fetch` + `extractRecentAssistantText`（`src/agent-view/jsonl-peek.ts`）— 状态 + JSONL 末尾助手文本数据源
- `TEMPLATE_HEADER` 的 `update_multi: true` — patch 替换而非 merge 的飞书侧契约
- `handleRefreshPeek`（`manager.ts:269`）— 手动 [Refresh] 按钮的"sync loading 卡 → 1.2s 后 async patch"模式

## 2. 目标与非目标

### 2.1 目标（本版必须支持）

| # | 目标 | 优先级 |
|---|------|--------|
| G1 | Attach 成功后，**紧跟文本确认**额外发一张"会话内容卡"（按钮配置与 Peek 略有差异，见 §3.2） | P0 |
| G2 | 卡片每 10s 自动 patch 一次 status + recentOutput | P0 |
| G3 | 卡片显示 `Last watched HH:MM:SS` 时间戳，区别本次 patch 与上次 patch | P0 |
| G4 | session 从 `busy`/`waiting` 走到 `idle` + `completed: true` 时 patch 最后一次"已结束"卡 + 停 watch | P0 |
| G5 | 用户发任何普通聊天文本 → 立即 patch 一次"已停止观察"卡 + 停 watch，不阻碍 chat 路由 | P0 |
| G6 | 新 Attach 取代旧 watch（静默 stop 旧 watch，不 patch 旧卡） | P0 |
| G7 | Patch 连续失败 ≥ 3 次 → 停 watch（飞书限流 / 卡被删 / 网络异常防御） | P0 |
| G8 | Watch 期间卡片字节超 25KB → **智能截断 recentOutput**（2048→1024→512→256），watch 永不停 | P0 |
| G9 | 卡片提供 [Stop Watching] 按钮（与 [Refresh] 并列），点后 patch 一次"已停止"卡 + 停 | P0 |
| G10 | 同一 openId 同时只能 watch 一个 session（取代式） | P0 |
| G11 | bot 重启时 in-flight watch 自然结束，不持久化（用户那张卡内容停在那一刻） | P1 |
| G12 | Watch 状态生命周期可单元测试 | P0 |

### 2.2 非目标（本版不做）

| # | 不做 | 原因 |
|---|------|------|
| N1 | 卡片多 session 拼接（每个 watch 一张独立卡，不并排） | 飞书 mobile 长卡 scroll 体验差；用户心智是"我现在盯这一条" |
| N2 | `agent_view.watch_interval_ms` 配置项 | 用户已明确不做，先硬编码 10s；后续真有反馈再加 |
| N3 | bot 重启后 watch 续传 | 用户已选最简方案（live-progress.ts 同款） |
| N4 | 新 Attach 取代旧 watch 时给旧卡发文本提示 | 用户已选静默 stop（省 patch 消耗） |
| N5 | 25KB 触顶时降级为"停止 watch" | 用户已选永远不停，做智能截断 |
| N6 | 卡片显示 PID / startedAt / elapsed | 跟 Peek 保持一致是优势，但本版为了截断预算**移除** PID/startedAt/elapsed 三字段（仅保留 status / cwd / recentOutput / waitingFor / Last watched） |
| N7 | Detach 按钮（清 UserManager session entry） | 用户已选不加；"💬 Back to Chat" 已覆盖 |
| N8 | Watch 期间发到该 session 的 reply 走 [Reply] 按钮流程（pending_agent_reply） | pending_agent_reply 与本 watch 完全独立，互不影响（spec §6 显式说明） |
| N9 | `claude agents --json` 失败的兜底 JSONL-only 模式 | `claude agents --json` 失败时整个 patch 跳过（仅 logger.warn），不切到 JSONL-only（避免把 25KB 状态兜底责任复杂化） |

## 3. 设计

### 3.1 整体流程

```
handleAttach(openId, sessionId, shortId, name, cwd)
  │
  ├─ [0] 实时守卫 + [1] CAS 1 清旧 + [2] CAS 2 写新（不变）
  │
  ├─ [3] replyFn('📎 已 Attach 到 `name` ...')           ← 原文本确认保留
  │
  └─ [4] 发首张 attached 卡 + 启动 watch (AttachedWatchers.start) ← 新增
       │
       ├─ 构造 buildAttachedCard (status + cwd + waitingFor + recentOutput)
       ├─ 调 cardReplyFn 发卡 → 拿到 cardMessageId
       ├─ if (size > 25KB) 走智能截断重试（§3.3）
       └─ 调 attachedWatchers.start(openId, { sessionId, shortId, name, cwd, cardMessageId })
              → 构造 watcher + setInterval(10s) → tick()
```

**首次 tick 时机**：setInterval 第一次触发在 start 后 ~10s（`intervalMs`），不是 0。
- 这意味着：handleAttach 发完首张卡后，~10s 才会触发第一次 patch
- 如果用户 Attach 时 session 已经是 `idle+completed`（"刚派发就完成"罕见但可能），首次 tick 会立即 patch final + stop
- 不需要在 handleAttach 末尾做"立即 tick"优化（避免 0-delay 边界 case）

```
handleChat(msg)   [bot.ts:925]
  │
  ├─ [原] if (this.agentView && config.get<boolean>('agent_view.enabled', true)) {
  │        [新] if (this.agentView.attachedWatchers.has(msg.openId)) {
  │          void this.agentView.attachedWatchers.stop(msg.openId, 'user_chat', { patchFinal: true });
  │        }
  │        if (msg.text === '/cancel') { ... }
  │        if (msg.text.startsWith('/')) { ... }
  │        // ... expectedReply / switch 继续
  │      }
  │
  └─ [原] 继续 streaming 流程
```

**关键**：hook 必须放在 `if (this.agentView && config.get(...))` 块**内**、`/cancel` 检查**前**——
- 在块内：避免 `this.agentView` 为 null 时 NPE（部署未启用 agentView 的场景）
- 在 `/cancel` 前：所有进入的消息（含 `/cancel` 自身、slash 命令）都停 watch
- 用 `void` 标 fire-and-forget,避免 TypeScript "floating promise" 警告

```
handleAttach 再次触发（同一 openId）
  │
  ├─ [新] if (this.attachedWatchers.has(openId)) {
  │        this.attachedWatchers.stop(openId, 'superseded');
  │        // 不 patch 旧卡（per Q5 = B）
  │      }
  │
  └─ [原] 走完 handleAttach + start 新 watcher
```

### 3.2 卡片内容与按钮

复用 `buildPeekCard` 的渲染骨架，但**新建 `buildAttachedCard(opts)`**，不污染 Peek：

```typescript
export function buildAttachedCard(opts: {
  name: string;
  status: AgentSessionStatus;
  completed?: boolean;
  waitingFor?: string;
  shortId: string;
  sessionId: string;
  cwd: string;
  recentOutput: string;
  outputFormat: 'markdown' | 'terminal';
  lastWatchedAt: string;     // 'HH:MM:SS' 本次 patch 时间
}): string
```

**实现约束**：
- 必须用 `...TEMPLATE_HEADER`（含 `update_multi: true`，同 buildPeekCard）
- header title：`📡 Watching · \`${name}\``
- header template：`blue`
- 状态字段行：`Status: 处理中 (busy)\n等待原因: ...\nCWD: ~/Git/trae-data`（waitingFor 非空才显示）
- Recent output 块：与 Peek 同 markdown / terminal 分流（`outputFormat === 'terminal'` 时包 code-block + "原始终端片段"警示）
- 末尾："Last watched 12:34:56"
- 按钮（4 个）：[🔄 Refresh] [Stop Watching] [Reply] [Stop session]
  - `refresh: true`（一直显示）
  - `stop_watching: true`（一直显示，新增 tag: `agent_view_stop_watching`）
  - `reply: status === 'waiting'`
  - `stop: status === 'busy'`
  - 不显示 [Attach]（已经 attach 了）

- 字段裁剪（vs buildPeekCard）：**移除** `pid` / `startedAt` / `Recent output` 之外的 dev 信息，**新增** `Last watched HH:MM:SS`
  - 按钮（4 个）：[🔄 Refresh] [Stop Watching] [Reply] [Stop session]

`buildAttachedCard` 内置 25KB 智能截断（§3.3）。

### 3.3 25KB 智能截断策略

`buildAttachedCard` 内部：

```
rawRecentOutput = extractRecentAssistantText(jsonlPath, peekMaxBytes=2048)
  ↓
buildCard(rawRecentOutput)  →  size = bytes(JSON.stringify(card))
  ↓
if (size <= 25KB) return card
  ↓
for budget in [1024, 512, 256]:
    truncated = truncate(rawRecentOutput, budget)  // 复用 jsonl-peek.ts:108 truncate()
    card = buildCard(truncated)
    if (bytes(card) <= 25KB) return card
  ↓
// 终极兜底:不显示 recentOutput
return buildCard('⚠️ 内容过大, 请点 [Peek] 查看完整')
```

关键约束：
- `truncate()`（`jsonl-peek.ts:108`）按段落边界切，已实现
- 截断仅影响"显示什么"，不改变 `peekMaxBytes` 全局配置
- Watch 永远不停（per Q6）
- 截断在 `buildAttachedCard` 函数体内，watcher 调一次拿一次，无状态

### 3.4 状态机

```
[no watch]
   │
   │ handleAttach 成功 (Q1 文本 + 卡)
   ↓
[watching]   openId → AttachedCardWatcher
   │            state: cardMessageId, sessionId, shortId, name, cwd
   │            interval: setInterval(10s)
   │            tickCount, patchFailureCount
   │
   ├─ session snapshot.status === 'idle' && completed === true
   │    → patch final 卡 (buildAttachedCard, header title 改为 "✅ 已结束 · `name`")
   │    → stop('idle_settled')
   │
   ├─ 用户发任何文本 (Q3 = B)
   │    → patch final 卡 (title "🔌 Watch stopped · 收到新消息")
   │    → stop('user_chat')
   │
   ├─ 新 handleAttach (Q5 = B)
   │    → 静默 stop('superseded'),不 patch 旧卡
   │
   ├─ 用户点 [Stop Watching]
   │    → patch final 卡 (title "🔌 Watch stopped")
   │    → stop('user_stop')
   │
   ├─ patchFn 失败 ≥ 3 次 (Q 隐含 G7)
   │    → stop('patch_failed'),不 patch（patch 失败说明卡可能已删）
   │
   └─ tickCount ≥ maxTicks=800 (= 8000s ≈ 2.2h)
        → stop('max_ticks'),patch final 卡
```

### 3.5 关键代码骨架

**新文件**：`src/agent-view/attached-card-watcher.ts`

镜像 `LiveProgressWatcher`（`live-progress.ts:99-234`）的 setInterval / inFlightTick / patchFailureCount / maxTicks / onStop identity-check 模式。**关键约束**：`cardMessageId` 由调用方（manager）在构造 watcher 之前**同步拿到**（`cardReplyFn` 返回值），不放在 deps 里等 start 后设置（参考 live-progress.ts:71 的 `cardMessageId` 字段位置）。

```typescript
export interface AttachedWatchDeps {
  openId: string;
  sessionId: string;
  shortId: string;
  name: string;
  cwd: string;
  cardMessageId: string;        // 调用方已拿到,start 时已存在
  patchFn: (messageId: string, card: string) => Promise<any>;
  config: AttachedWatchConfig;
  /**
   * 解析 recentOutput(三层:own JSONL → parent JSONL → claude logs 退化)
   * 由 manager 注入 this.resolvePeekContent 绑定
   */
  resolveContent: (shortId: string, maxChars: number) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>;
  onStop: (openId: string, reason: string, watcher: AttachedCardWatcher) => void;
}

export interface AttachedWatchConfig {
  intervalMs: number;
  maxTicks: number;
  maxPatchFailures: number;
}

export const DEFAULT_ATTACHED_WATCH_CONFIG: AttachedWatchConfig = {
  intervalMs: 10_000,
  maxTicks: 800,
  maxPatchFailures: 3,
};

export class AttachedCardWatcher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private patchFailureCount = 0;
  private stopped = false;
  private startedAt = Date.now();
  private inFlightTick: Promise<void> | null = null;

  constructor(private deps: AttachedWatchDeps) {}

  start(): void {
    // cardMessageId 已在 deps 里,直接启 setInterval
    this.intervalHandle = setInterval(
      () => {
        if (this.inFlightTick) return;  // skip overlap,同 live-progress.ts:115
        this.inFlightTick = this.tick()
          .catch(err => logger.error(`AttachedCardWatcher tick error: ${err}`))
          .finally(() => { this.inFlightTick = null; });
      },
      this.deps.config.intervalMs,
    );
    logger.info(
      `AttachedCardWatcher start: openId=${this.deps.openId}, ` +
      `sessionId=${this.deps.sessionId}, cardMessageId=${this.deps.cardMessageId}`,
    );
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;
    // 1) snapshot = AgentSnapshotFetcher.fetch()
    //    失败 → logger.warn;return(不 patch,不停)
    // 2) session = snapshot.sessions.find(...)
    //    不在 → patch 错误卡 + stop('session_gone')
    // 3) if (status === 'idle' && completed) → final patch + stop('idle_settled')
    // 4) content = await this.deps.resolveContent(this.deps.shortId, 2048)
    // 5) card = buildAttachedCard({...content, lastWatchedAt: now.toLocaleTimeString()})
    // 6) await this.deps.patchFn(this.deps.cardMessageId, card)
    //    失败 → patchFailureCount++;≥ maxPatchFailures → stop('patch_failed')
    // 7) if (tickCount >= maxTicks) → final patch + stop('max_ticks')
  }

  async stop(reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
    // 镜像 LiveProgressWatcher.stop:
    // - clearInterval
    // - if (opts.patchFinal) patch final 卡(reason 决定 title)
    // - logger.info
    // - onStop callback
    // - await withTimeout(inFlightTick, 5000)
  }
}
```

**`AttachedWatchers` 管理器**（同文件）

```typescript
export class AttachedWatchers {
  private watchers = new Map<string, AttachedCardWatcher>();

  // 注入的依赖:patchFn / resolveContent(无 cardMessageId,无 cardReplyFn —
  // cardReply 由 manager.handleAttach 在 start 前完成)
  constructor(
    private patchFn: (messageId: string, card: string) => Promise<any>,
    private resolveContentFn: (shortId: string, maxChars: number) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>,
    private config: AttachedWatchConfig = DEFAULT_ATTACHED_WATCH_CONFIG,
  ) {}

  has(openId: string): boolean { return this.watchers.has(openId); }

  /**
   * 取代式启动:openId 已有旧 watcher 时静默 stop,再启新的。
   * cardMessageId 由调用方在调此方法前拿到(buildAttachedCard + cardReplyFn)。
   */
  async start(openId: string, opts: {
    sessionId: string; shortId: string; name: string; cwd: string; cardMessageId: string;
  }): Promise<void> {
    if (this.watchers.has(openId)) {
      await this.watchers.get(openId)!.stop('superseded', { patchFinal: false });
      this.watchers.delete(openId);
    }
    const watcher = new AttachedCardWatcher({
      openId,
      sessionId: opts.sessionId,
      shortId: opts.shortId,
      name: opts.name,
      cwd: opts.cwd,
      cardMessageId: opts.cardMessageId,
      patchFn: this.patchFn,
      config: this.config,
      resolveContent: this.resolveContentFn,
      onStop: (oid, reason, w) => {
        // identity check:避免慢 in-flight tick 完成后被旧 watcher clobber
        if (this.watchers.get(oid) === w) this.watchers.delete(oid);
      },
    });
    this.watchers.set(openId, watcher);
    watcher.start();
  }

  async stop(openId: string, reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
    const w = this.watchers.get(openId);
    if (w) {
      await w.stop(reason, opts);
      // 注意:onStop 回调里会 delete,但只在 identity check 命中时
      // 显式再 delete 一次保险(双重清理幂等)
      this.watchers.delete(openId);
    }
  }

  /** bot shutdown 时清空所有 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.values()].map(w => w.stop('shutdown')));
  }
}
```

**`AgentViewManager` 改动**（`src/agent-view/manager.ts`）

- 字段新增 `readonly attachedWatchers: AttachedWatchers`
- 构造函数末尾：
  ```typescript
  this.attachedWatchers = new AttachedWatchers(
    deps.patchFn,
    (shortId, maxChars) => this.resolvePeekContent(shortId, maxChars),  // 绑 manager 方法
  );
  ```
- `handleAttach` 末尾**插入新代码**（在 `await this.deps.replyFn('📎 已 Attach ...')` 之后、`return null;` 之前）：
  ```typescript
  // 1) 声明 peekMaxBytes（与 handlePeek / _doRefreshPeek 同款）
  const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
  // 2) 构造首张 attached 卡 + 拿到 cardMessageId
  const peek = await this.resolvePeekContent(_shortId, peekMaxBytes);
  const initialCard = buildAttachedCard({
    name: session.name, status: session.status, completed: session.completed,
    waitingFor: session.waitingFor, shortId: _shortId, sessionId,
    cwd, recentOutput: peek.text ?? '(无可用输出)',
    outputFormat: peek.format, lastWatchedAt: new Date().toLocaleTimeString(),
  });
  // 3) 走 sendOrFallback 拿到 cardMessageId（>25KB 自动 text fallback）
  const cardMessageId = await this.sendOrFallback(
    initialCard,
    { openId },
    `📡 Watching · \`${session.name}\` · /agents 查看`,
    openId,
  );
  if (cardMessageId) {
    await this.attachedWatchers.start(openId, {
      sessionId, shortId: _shortId, name: session.name, cwd, cardMessageId,
    });
  }
  ```
  **位置约束**：必须在 `await this.deps.replyFn('📎 已 Attach ...')` **之后**（Q1 文本在前、卡在后），`return null;` **之前**。
  **参数重命名**：把原函数签名的 `_shortId` / `_name` 去掉下划线（`_shortId` → `shortId`、`_name` → `name`），因新代码使用了它们。
- 新增 `handleStopWatching(openId)`（卡片 [Stop Watching] 按钮 handler，**不需 messageId 参数**）：
  ```typescript
  async handleStopWatching(openId: string): Promise<null> {
    await this.attachedWatchers.stop(openId, 'user_stop', { patchFinal: true });
    return null;
  }
  ```
  messageId 不需要——patchFinal 走 watcher 自己的 cardMessageId（在 deps.cardMessageId 里）。
- `AgentViewDeps` 接口**不变**（`cardReplyFn` / `patchFn` 已存在,`resolvePeekContent` 是 manager 内部方法,不需要暴露为 dep）

**`bot.ts` 改动**（`src/feishu/bot.ts`）

- `handleChat`（bot.ts:925）开头新增一段：
  ```typescript
  if (this.agentView.attachedWatchers.has(msg.openId)) {
    void this.agentView.attachedWatchers.stop(msg.openId, 'user_chat', { patchFinal: true });
  }
  ```
  fire-and-forget，不 await，不影响 chat 路由
- `handleCardAction`（bot.ts:460, switch 在 532）新增 `case 'agent_view_stop_watching'`：
  ```typescript
  // 加在 'agent_view_bg_conflict_cancel' case 之后、default 之前
  case 'agent_view_stop_watching':
    await this.agentView.handleStopWatching(openId);
    return null;
  ```
- `FeishuBot.shutdown()`（bot.ts:407 已存在，stop liveWatchers）扩展为也调 `agentView.attachedWatchers.stopAll()`：
  ```typescript
  async shutdown(): Promise<void> {
    const watchers = Array.from(this.liveWatchers.values());
    this.liveWatchers.clear();
    if (this.agentView) {
      await this.agentView.attachedWatchers.stopAll();  // 新增一行
    }
    await Promise.all(watchers.map(w => w.stop('bot_shutdown')));
  }
  ```
  顺序：先停 attached（可能有 in-flight patch 在飞），再停 liveWatchers（同样）。不严格串行（都 fire-and-forget），但 `await Promise.all` 保险。

**`action.ts` 改动**（`src/agent-view/action.ts`）

```typescript
export type AgentViewValue =
  | ... // 现有 12 个（Peek/Attach/Stop 系列 + bg-conflict 系列）
  | { tag: 'agent_view_stop_watching' };  // 新增,无字段
```

`isAgentViewValue` 的 switch 不需要新增 case（default 接受 unknown tag）。

### 3.6 数据流（一次 tick）

```
tick() 触发 (setInterval 10s)
  │
  ├─ snapshot = AgentSnapshotFetcher.fetch()
  │     └─ 失败 → logger.warn;不 patch;不 stop(G9 静默恢复)
  │
  ├─ session = snapshot.sessions.find(s => s.sessionId === this.sessionId)
  │     └─ 不在 → patch final 卡 "⚠️ session 已不存在" + stop('session_gone')
  │
  ├─ if (status === 'idle' && completed) → patch final 卡 "✅ 已结束" + stop('idle_settled')
  │
  ├─ content = await this.deps.resolveContent(this.shortId, peekMaxBytes=2048)
  │     └─ 三层:own JSONL → parent JSONL → claude logs 退化
  │
  ├─ card = buildAttachedCard({ ... content.text, outputFormat: content.format, lastWatchedAt: now.toLocaleTimeString() })
  │     └─ 内含 §3.3 智能截断
  │
  └─ await this.deps.patchFn(this.deps.cardMessageId, card)
        ├─ 成功 → patchFailureCount = 0
        └─ 失败 → patchFailureCount++;≥ 3 → stop('patch_failed')
```

### 3.7 错误处理表

| 场景 | 行为 | 何时触发 |
|------|------|---------|
| `claude agents --json` 失败 | 跳过本次 patch，logger.warn，**不 stop** | tick 路径 |
| session 不在 snapshot | patch 一次错误卡 + stop('session_gone') | tick 路径 |
| session idle + completed | patch final 卡 + stop('idle_settled') | tick 路径 |
| JSONL 读失败（三层都 miss） | recentOutput = '(无可用输出)'，patch 照常 | tick 路径 |
| patchFn 失败 | patchFailureCount++；≥ 3 → stop('patch_failed')，不 patch | tick 路径 |
| maxTicks 到 | patch final 卡 + stop('max_ticks') | tick 路径 |
| 用户发文本 | patch final 卡 (chat) + stop('user_chat') | bot.ts handleChat 入口 |
| 新 Attach 取代旧 | 静默 stop('superseded')，不 patch 旧卡 | handleAttach 入口 |
| 用户点 [Stop Watching] | patch final 卡 + stop('user_stop') | handleCardAction 路径 |
| 卡片 25KB 触顶 | 智能截断（永不触发 stop） | buildAttachedCard 内部 |
| bot 重启 | 全部 in-flight watch 丢失，旧卡内容停在那一刻（per Q4 = C） | bot 启动 |

### 3.8 并发与安全

- 同一 openId 同时只能有一个 watcher（取代式，§3.1 流程图）
- inFlightTick mutex：setInterval 触发时若上一 tick 未完，跳过本次（mirror live-progress.ts:115）
- onStop identity check：旧 watcher 完成时检查 `this.watchers.get(openId) === self`，避免 clobber（mirror live-progress.ts:79 注释）
- 飞书 QPS：单用户 6 patch/min（10s 节奏），单 bot 假设单用户部署，QPS 远低于 100/min 限制
- patchFailureCount 防御：连续 3 次失败立即 stop，避免无效 patch 消耗
- 关闭/重启：`stopAll()` 显式收尾，每个 watcher `withTimeout(inFlightTick, 5000)`

## 4. 配置

**本版不新增任何 config key**（per Q7）。

硬编码：
- `intervalMs = 10_000`（`DEFAULT_ATTACHED_WATCH_CONFIG.intervalMs`）
- `maxTicks = 800`（= 8000s ≈ 2.2h）
- `maxPatchFailures = 3`
- `peekMaxBytes = 2048`（复用 `agent_view.peek_max_bytes`）

## 5. 关键文件变更

| 文件 | 变更 |
|------|------|
| `src/agent-view/attached-card-watcher.ts` | **新增** ~250 行（watcher + AttachedWatchers 管理器） |
| `src/agent-view/card.ts` | 新增 `buildAttachedCard` builder (~60 行) |
| `src/agent-view/action.ts` | 新增 `agent_view_stop_watching` tag (~5 行) |
| `src/agent-view/manager.ts` | 字段 `attachedWatchers`、构造、handleAttach 末尾、handleStopWatching (~30 行 diff) |
| `src/feishu/bot.ts` | handleChat 入口 hook、handleCardAction 新 case (~15 行 diff) |
| `tests/unit/agent-view/attached-card-watcher.test.ts` | **新增** ~250 行 |
| `tests/unit/agent-view/card.test.ts` | 新增 `buildAttachedCard` 渲染 case + 25KB 截断 case (~80 行) |
| `tests/unit/agent-view/manager.test.ts` | 新增 handleAttach 末尾 startWatch 调用、handleStopWatching ~50 行 |
| `tests/unit/feishu/bot-cardaction-attached-watch.test.ts` | 新增 [Stop Watching] action dispatch ~30 行 |

## 6. 与现有 expectedReply 流程的关系

`expectedReply`（reply 等待状态）和 `attachedWatchers`（attach 观察状态）**完全独立**：

- `expectedReply` 是用户主动 [Reply] 后，提示"请发消息"的状态；`attachedWatchers` 是 attach 后的自动 patch 状态
- 两者都占 user-mapping 的 `type` 字段，但**不会同时存在**：
  - [Reply] 路径（`handleReplyRequest`）做 CAS 前会清掉 `last_attached_watch` 类的 entry（与 v2.2.x 清 `last_agent_list_card` 同款）
  - [Attach] 路径（`handleAttach`）做 CAS 时不主动清 `pending_agent_reply`（由 `wasPendingReply` 决定清不清，见 `manager.ts:467-481`）
- 状态转换：Attach 期间用户点 [Reply] → 走 `handleReplyRequest`，清 last_attached_watch + 发等待卡；本次 watch 仍继续 patch **attached 卡**（独立）
- 状态转换：pending_agent_reply 期间用户再 Attach → 走 `handleAttach`，清旧 session entry；expectedReply 也由 `wasPendingReply` 路径清掉

**结论：互不干扰，spec 不需要新增协调代码。**

## 7. 风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | patch 期间飞书 throttle 抖动，导致 patch 顺序混乱 | patch 走 `update_multi: true`（沿用 TEMPLATE_HEADER）+ patchFailureCount 3 次阈值 |
| R2 | user-mapping 中 `type: 'session'` 状态机错乱（用户 [Stop Watching] 后 entry 还在） | Stop Watching **不动** user-mapping，只停 watch timer；要脱离 Attach 走现有 [💬 Back to Chat] / `/agents` |
| R3 | handleChat hook 加在入口，message 反序列化前调用，throw 会让 chat 失败 | fire-and-forget + 内部 try/catch（已在 `_doStopAndSend` 等多处的成熟模式） |
| R4 | buildAttachedCard 25KB 截断时 truncate() 自身 bytes 越界 | truncate() 已实现（`jsonl-peek.ts:108`），单测覆盖；新增三层 retry 已能 cover 95% 场景 |
| R5 | 同一用户短时间多次 Attach / Detach 抖动 | 取代式实现（§3.5 AttachedWatchers.start）；每次新 start 前静默 stop 旧的 |
| R6 | 飞书 mobile 端 scroll 走后 patch 仍跑 | patch 频率低（6/min）+ patchFailureCount 3 次 → 飞书删卡后 patch 必失败，3 次后 stop，资源不浪费 |
| R7 | watch 卡内容 25KB 触顶时，截断后用户看不到想看的关键信息 | Recent output 本身是"最后一条 assistant 文本"（已是最关键内容），截断按段落边界；终极 fallback "请点 [Peek] 查看完整" 给明确逃生口 |
| R8 | patch 飞书 API 在并发场景下被限流 | 单用户部署假设下 6/min 远低于限制；多用户叠加由 patchFailureCount 自动 stop 兜底 |

## 8. 单元测试

`tests/agent-view/attached-card-watcher.test.ts` 必须覆盖：

1. **start 路径**
   - start 第一次 patch 成功，返回 cardMessageId
   - start 卡片 > 25KB 时走 1024 budget 重试成功
   - start 卡片 < 25KB 直接返回
2. **tick 路径**
   - 正常 tick：snapshot 拿到 + JSONL 读到 → patch 调用 1 次
   - snapshot 失败 → patch 跳过 1 次，不 stop
   - session 不在 snapshot → patch 错误卡 + stop('session_gone')
   - session idle + completed → patch final + stop('idle_settled')
   - JSONL 三层都 miss → recentOutput = '(无可用输出)'
3. **stop 路径**
   - 用户发文本 stop('user_chat', patchFinal=true) → patch final 1 次
   - 用户发文本 stop('user_chat', patchFinal=false) → 不 patch
   - 取代式 stop('superseded', patchFinal=false) → 不 patch
   - patchFinal 卡 title 符合 §3.2 模板
4. **错误恢复**
   - patchFn 失败 1 次：patchFailureCount=1，不 stop
   - patchFn 失败 3 次：stop('patch_failed')
   - patchFn 失败 3 次后第 4 次 tick 不再 patch
5. **并发**
   - inFlightTick mutex：setInterval 触发时上一 tick 未完，跳过
6. **生命周期**
   - maxTicks=800 后 stop('max_ticks')
   - onStop callback identity check：旧 watcher stop 时若 map 已被新 watcher 替换，**不删除**新 watcher
7. **buildAttachedCard 渲染**（在 card.test.ts）
   - 4 种 status label 正确（busy / waiting / idle / unknown）
   - waitingFor 显示条件
   - 4 按钮根据 status 显隐
   - Last watched 时间戳格式
   - 25KB 智能截断：recentOutput 2048 bytes → 1024 → 512 → 256 → 终极 fallback
   - 不显示 pid / startedAt（与 Peek 区别）
8. **handleAttach 集成**（在 manager.test.ts）
   - handleAttach 成功后 attachedWatchers.has(openId) === true
   - handleAttach 前 attachedWatchers 已有 → 旧 stop('superseded') 被调
9. **handleChat 集成**（在 bot.test.ts 或新文件）
   - handleChat 入口：attachedWatchers 有 → stop('user_chat') 被调
   - handleChat 入口：attachedWatchers 无 → 不调用 stop

预估：~22 case，~600 行

## 9. 验收 / DoD

- [ ] `bun run typecheck` 通过
- [ ] `bun test tests/agent-view/attached-card-watcher.test.ts` 全 pass
- [ ] `bun test tests/agent-view/card.test.ts` 全 pass（新增 case）
- [ ] `bun test` 全 pass（不破坏其他模块）
- [ ] 手动验收脚本：
  1. 终端 `claude --bg "test 1: sleep 30 && echo done"` 派发一条
  2. 飞书发 `/agents` → 看到列表卡
  3. 飞书点 [Attach] → 看到 "📎 已 Attach" 文本 + 紧跟一张可交互卡
  4. 等待 10s，patch 触发，卡片内容更新（status / recentOutput）
  5. 终端 `cat ~/.claude/projects/.../<uuid>.jsonl | tail` 写新内容（模拟 claude 输出），10s 内飞书卡更新
  6. 等待 session 自然完成，飞书卡 patch final "✅ 已结束" + watch 停
  7. 重新派发一条，Attach 后飞书发"hello" → 飞书卡 patch "🔌 Watch stopped" + 收到 chat 回复
  8. 重新派发两条，Attach A → 飞书看到 A 卡；接着 Attach B → A 卡静默停（不 patch），B 卡出现
  9. Attach 后点 [Stop Watching] → 飞书卡 patch "🔌 Watch stopped"
  10. 终端 `rm` JSONL 后 Attach，watch 启动后 ~30s 内 patch 失败 3 次 → 静默 stop（per R6/R7 防御）
  11. 极端长 output（写 30KB markdown 到 JSONL）→ 卡片正常 patch（智能截断）
  12. bot 重启（启动 dev start）→ 旧卡停在那一刻，无 patch

## 10. 落地步骤（给 writing-plans）

1. 创建 `src/agent-view/attached-card-watcher.ts`（watcher + 管理器，mirror live-progress.ts）
2. 扩展 `src/agent-view/card.ts` 新增 `buildAttachedCard`
3. 扩展 `src/agent-view/action.ts` 新增 tag
4. 扩展 `src/agent-view/manager.ts` 接入 watcher + handleStopWatching
5. 扩展 `src/feishu/bot.ts` handleChat hook + handleCardAction case
6. 新增 `tests/agent-view/attached-card-watcher.test.ts`
7. 扩展 `tests/agent-view/card.test.ts` + `manager.test.ts` + 新增 bot dispatch 测试
8. `bun run typecheck && bun test` 全绿
9. 手动验收脚本 12 步全过

不在范围（defer）：detach 按钮（N7）、watch_interval_ms 配置（N2）、bot 重启续传（N3）、智能 JSONL-only 兜底（N9）。
