# cc-linker Multi-Model Review Engine v2 设计

**日期：** 2026-06-13
**版本：** v2（基于 v1 2026-06-06 重新设计）
**状态：** 待评审
**作者：** Claude Code（brainstorming session + Agent View 复用分析）

## 修订记录

| 版本 | 日期 | 关键变更 |
|---|---|---|
| v1 | 2026-06-06 | 初版，13 个新模块全栈自建（`src/review/` 子目录） |
| v2 | 2026-06-13 | **复用 Agent View 已有能力**：<br>1) **§2 复用层** —— 0 行新代码复用 `AgentSnapshotFetcher` / `resolvePeekContent` / `runChatSDK` + `ExpectedReplyState` / `claude stop` / `~/.claude/providers/*.json` / `state.json`<br>2) **§2 新建层** —— 13 个模块缩到 7 个（`engine.ts` / `pipeline-store.ts` / `profile.ts` / `phase-detect.ts` / `adapter.ts` / `ide-server.ts` / `ide-static/` + `reconciler.ts`）<br>3) **§3 架构** —— 启动方式改为 `cc-linker review run <task>` 一次性跑（不挂飞书），不再默认随 `cc-linker start` 启动<br>4) **§4 数据流** —— bg session 是事实（4 个 pane 都起真 bg session，出现在 `~/.claude/jobs/`）；work session 是长生命周期（resume 跨多轮），review/arbiter session 是一次性<br>5) **§5 状态机** —— 新增 `pane` 字段标识当前活跃 pane；EXTERNAL_REVIEW 改为 `panes[]` 数组；JUDGE_BY_WORK 复用 `ExpectedReplyState` 注入 reply<br>6) **§6 PipelineStore** —— 新增 `PaneRegistry` 跨状态机追踪 work session shortId；`inputDigest`/`outputDigest` sha256 替代完整 prompt 存储<br>7) **§7 Reconciler** —— pane bg session 丢失时**直接 FAILED 不重试**（保守策略，避免从不可信状态恢复导致产物污染）<br>8) **§8 Phase 1 电脑端 UX** —— CLI 主输出 + 单 HTML 页（端口 9821）为辅；4 张 pane 卡片 + 状态条 + 时间线（不做完整 2×2 网格）；`--no-ide` 纯终端模式；HUMAN_DECIDE 简化为 `cc-linker review decide` CLI 命令<br>9) **§10 错误处理** —— Provider 不可用在 profile.load 阶段 fail fast；单 review pane 失败走 degraded 模式（0 opinions 推进）；bg session 启动后立即 'failed' 视为 FAILED<br>10) **§11 测试** —— 新增 4 个 v2 关键场景：profile 加载阶段 provider 缺失 / 1 review pane 启动失败 / bg session 启动后失败 / HUMAN_DECIDE CLI 决策<br>11) **§12 路线** —— Phase 1 = MVP（核心引擎 + CLI + 简版 IDE，4-6 周）；Phase 2 = 体验优化（完整 2×2 + 飞书 `/review` + 报告，+3-4 周）；Phase 3 = 进阶（LLM 分类 / 热更新 / 多 pipeline 并行，+2-3 周）<br>12) **§13 评审 Checklist** —— v1 9 条全部保留 + v2 新增 8 条<br>13) **§14 关键风险** —— 5 条 v2 新识别：bg session resume 链断裂 / provider 改 / polling 慢 / Reconciler 抢锁 / CLI + IDE 都无连接器 |

## 1. 问题陈述

使用 AI Coding（Claude Code 等）后，开发流程从"写代码 → 人审"变成了多轮自审 + 多模型交叉 Review 的工作流：

```
写 Spec → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写 Plan → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写代码 → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修复 → 再 Review
```

由于 Claude Code 限制，不方便在终端直接切换不同模型（kimi-2.6、qwen3.6-plus、mimo-2.5-pro 等），每次评审都需手动换 settings、重新启动进程。同时，多个模型的交叉 Review 意见如何汇总、是否采纳、是否需要仲裁，缺少一个集中的"裁决 + 流程编排"机制。

v1 spec（2026-06-06）已经设计了一个完整的 Review Engine 解决方案（13 个新模块全栈自建）。v2 重新设计的目标是：**深度复用 Agent View 已有基础设施**，将新建模块从 13 个缩到 7 个，工作量减少 40-50%，且 Phase 1 能更快落地。

## 2. 目标与非目标

### 2.1 目标（本版必须支持）

| # | 目标 | 优先级 |
|---|------|--------|
| G1 | 多模型交叉 Review 编排：驱动"工作模型 → 外部 Review 模型 → 裁决 → 修复"的完整流水线 | P0 |
| G2 | 层次化裁决机制：工作模型自评 → 外部 Review → 工作模型评判意见 → 仲裁 → 人工兜底 | P0 |
| G3 | 三阶段支持：Spec / Plan / Code，每个阶段可配置不同的提示词、护栏、Review 模型组合 | P0 |
| G4 | 电脑端便利：CLI 主输出 + 单 HTML 页（端口 9821）实时看 4 个 pane 状态 | P0（Phase 1） |
| G5 | 可恢复状态机：每次 Review 是一个有状态的、跨进程崩溃可恢复的工作流 | P0 |
| G6 | **深度复用 Agent View**：复用 `AgentSnapshotFetcher` / `resolvePeekContent` / `runChatSDK` / `ExpectedReplyState` / `claude stop` 已有能力，0 行重复代码 | P0 |
| G7 | 4 个 bg session 自动出现在 `~/.claude/jobs/<short>/state.json`，飞书 `/agents` 列表**免费**看到（Phase 2 飞书集成） | P1 |

### 2.2 非目标

- 不替代现有 `/new` `/list` `/switch` `/model` 等飞书命令
- 不修改 `ProviderManager` 已有逻辑
- 不修改 `ClaudeSessionManager` 签名（仅复用其接口）
- 不修改 `AgentViewManager` 任何代码（v2 设计 0 侵入 Agent View）
- 不做云端协同 / 团队共享（仍是单机单用户）
- 不做完整 2×2 网格 IDE（Phase 1 简版，Phase 2 升级）
- 不修改 `~/.claude/providers/*.json` 任何内容（只读取）

## 3. 架构总览

### 3.1 复用层（0 行新代码）

| 能力 | 复用什么 |
|------|---------|
| 读 pane 状态（name / status / cwd / intent） | `AgentSnapshotFetcher.fetch()` 读 `~/.claude/jobs/<short>/state.json` |
| 偷看 pane 输出（markdown 原文） | `manager.resolvePeekContent(shortId, maxChars)` 三级降级 |
| 注入 reply 到 work session | `ClaudeSessionManager.sendMessage` + `ExpectedReplyState` CAS |
| Stop 任意 pane | `claude stop <short>` |
| Provider 切换（多模型） | `~/.claude/providers/*.json`（已存在：kimi / qwen3.6 / mimo 等） |
| Session 状态权威 | `~/.claude/jobs/<short>/state.json`（CLI 维护） |
| 飞书 /agents 列表（Phase 2 bonus） | 4 个 pane 自动出现，无需任何适配代码 |

### 3.2 新建层（7 个模块，全部在 `src/review/`）

```
src/review/
├── engine.ts            # 状态机驱动（10 状态：PRODUCING / SELF_REVIEW_R1 / SELF_REVIEW_R2 / EXTERNAL_REVIEW / JUDGE_BY_WORK / ARBITRATION / JUDGE_ARBITER / HUMAN_DECIDE / FIXING / DONE|FAILED|ABORTED）
├── pipeline-store.ts    # 持久化：~/.cc-linker/review-pipelines/{pending,running,human_pending,done,failed,aborted}/
├── profile.ts           # ReviewProfile TOML 加载 + per-phase 深度 merge + provider 校验
├── phase-detect.ts      # 启发式：file path → git ref → 关键词 → 抛 PhaseUnknownError
├── adapter.ts           # ReviewSessionAdapter：把 ClaudeSessionManager.sendMessage 包装成"启动 bg session + 等到 waiting/done"统一接口
├── ide-server.ts        # Bun.serve 9821 + SSE：POST /api/pipelines、GET /api/pipelines/<id>、GET /events?pipelineId=<id>
├── ide-static/          # 单文件 vanilla HTML + 内联 JS（4 张 pane 卡片 + 状态条 + 时间线）
└── reconciler.ts        # 启动扫描 running/ + human_pending/ 恢复 in-memory active set + pane 丢失检测
```

### 3.3 CLI 入口（1 个新命令）

```
src/cli/commands/review.ts
├── review run <task>     [--phase spec|plan|code] [--profile default] [--max-rounds N] [--no-ide]
├── review status <id>
├── review abort <id>
├── review report <id>    [--format md|json] [--out <file>]
└── review decide <id>    --accept-all | --accept "1,3" | --reject-all    # HUMAN_DECIDE 接收
```

### 3.4 启动方式

| 命令 | 行为 |
|------|------|
| `cc-linker review run <task>` | 一次性跑 pipeline（最常用，Phase 1 主力入口） |
| `cc-linker review status <id>` | 查询已存在 pipeline 状态 + 接 SSE 重连 |
| `cc-linker review-server` | 长驻 Review Engine + IDE（不挂飞书），类似 `cc-linker start` 但只跑 review |
| `cc-linker start` | **不**启动 Review Engine（避免给所有用户加重负担），Review Engine 按需启动 |

### 3.5 与现有模块的边界

| 现有模块 | 复用方式 | 新增代码 |
|---------|---------|---------|
| `ProviderManager.resolve(alias)` | profile 加载时调一次 | 0 |
| `ClaudeSessionManager.sendMessage` | adapter 内部调 | 0 |
| `AgentSnapshotFetcher.fetch()` | engine / adapter / ide-server 都调 | 0 |
| `manager.resolvePeekContent` | IDE server 拉 pane 详情时调 | 0 |
| `ExpectedReplyState` | JUDGE_BY_WORK / JUDGE_ARBITER 阶段复用 | 0 |
| `claude stop <short>` | adapter 清理 pane 时调 | 0 |
| Spool 设计思想 | PipelineStore 完全照搬 6 目录 + 原子写 + Reconciler | 80%（持久化范式） |
| `Config` | 扩展 `[review]` 段：IDE 端口、默认 profile、人工决策超时 | 5% |
| `logger` | ReviewEngine 自己的日志 `~/.cc-linker/review-engine.log` | 0 |

## 4. 数据流

### 4.1 一次完整 pipeline 的事件序列

```
时间轴  组件                  动作
─────  ─────────────────     ─────────────────────────────────────────
T0    用户                   cc-linker review run "帮我修 NPE in auth.ts"
T1    CLI                    调 engine.start({ task, phase: 'code', profile: 'default' })
T2    Engine                 调 phase-detect.detect(...) → 'code'
T3    Engine                 调 profile.load('default') → merged profile（包含 provider 校验）
T4    Engine                 调 adapter.startSession({ role: 'work', provider: 'sonnet', prompt: '...NPE in auth.ts', isNew: true })
T5    Adapter                调 ClaudeSessionManager.sendMessage(prompt, cwd, true, settingsPath)
T6    CLI (Claude)           spawn bg session, 写 ~/.claude/jobs/<short1>/state.json, return shortId
T7    Adapter                返回 { shortId: 'abc12345', sessionId: '<uuid>' }
T8    Engine                 写 PipelineRecord 到 running/<pipelineId>.json（panes.work = {shortId, sessionId, ...}）
T9    Engine                 SSE 广播给 IDE：state=PRODUCING, panes=[{role:'work', shortId:'abc12345', status:'busy'}]
T10   CLI (Claude work)      ...处理中... → 输出 "已修 NPE in auth.ts line 42"
T11   CLI (Claude work)      state.json.state: 'running' → 'done'（CLI 维护）
T12   Adapter.poll(work)     detect state.json.state == 'done' → emit 'work_produced'
T13   Engine                 transition: PRODUCING → SELF_REVIEW_R1
T14   Engine                 调 adapter.startSession({ role: 'work', prompt: 'review 你的产出...', isNew: false, sessionId: <existing> })
T15   Adapter                ClaudeSessionManager.sendMessage 走 --resume <sessionId> 续接
T16   Engine                 SSE 广播：state=SELF_REVIEW_R1, panes=[{role:'work', status:'busy'}, ...]
T17   ...                    R1 收敛 → 走 R2 → R2 不收敛
T18   Engine                 transition: SELF_REVIEW_R2 → EXTERNAL_REVIEW (round++)
T19   Engine                 Promise.all([
                              adapter.startSession({ role: 'review-A', provider: 'kimi', prompt: '...review...', isNew: true }),
                              adapter.startSession({ role: 'review-B', provider: 'qwen3.6', prompt: '...review...', isNew: true }),
                            ])
T20   Adapter × 2            同时起 2 个 bg session，shortId2/3
T21   Engine                 SSE 广播：state=EXTERNAL_REVIEW, panes=[{work:done}, {review-A:busy}, {review-B:busy}, {arbiter:idle}]
T22   CLI × 2                ...并行 review...
T23   Adapter.poll × 2       两个都 done → emit 'external_opinions_ready'
T24   Engine                 transition: EXTERNAL_REVIEW → JUDGE_BY_WORK (round++)
T25   Engine                 调 adapter.injectReply({ shortId: 'abc12345' (work), prompt: 'judge 两条意见...' })
T26   Adapter                ExpectedReplyState.set(...) → 调 ClaudeSessionManager.sendMessage 走 --resume <work-sessionId>
T27   CLI (Claude work)      处理中
T28   Adapter.poll(work)     done → emit 'work_verdict: partial'
T29   Engine                 transition: JUDGE_BY_WORK → FIXING
T30   Engine                 调 adapter.startSession({ role: 'work', prompt: 'fix 接受的意见...', isNew: false, sessionId: <existing> })
T31   ...                    fix 完成 → 转回 SELF_REVIEW_R1 (cycle: 'postfix')
T32   ...                    循环直到 R1/R2 收敛 → DONE
T33   Engine                 写 PipelineRecord 到 done/，SSE 广播 state=DONE + 最终产物
T34   CLI                    输出报告路径
```

### 4.2 bg session 之间如何"传递内容"

**关键设计**：bg session 是事实，**不**维护中间产物对象。

| 角色 | 生命周期 | 启动方式 |
|------|---------|---------|
| `work` | **长生命周期**：跨 R1/R2/JUDGE/FIX/postfix 全部复用 | 第一次 `isNew: true`；后续 `isNew: false` + `--resume <sessionId>` |
| `review-A` / `review-B` / ... | **轮次性**：每轮 EXTERNAL_REVIEW 起新 session | 永远 `isNew: true`（不传 --resume） |
| `arbiter` | **轮次性**：每次 ARBITRATION 起新 session | 永远 `isNew: true` |

**实现位置**：`adapter.ts` 的 `startSession` 内部根据 `role` 决定：
- `role: 'work'` → 有 `panes.work.sessionId` 就 `ClaudeSessionManager.sendMessage(prompt, cwd, false, settingsPath)`（自动 --resume）；无就 `true` 启动新 session
- `role: 'review' | 'arbiter'` → 永远 `true`，不起 resume

### 4.3 判定"work 产出完成" / "review 收齐"

**不**自己 parse 进程 stdout，**只**看 `~/.claude/jobs/<short>/state.json.state`：

| state 值 | 含义 |
|---------|------|
| `running` / `working` | 还在跑 |
| `done` | 已完成（看 `detail` 字段判断成功/失败） |
| `blocked` | 等用户输入 |
| `stopped` | 被 stop |
| 其他（forward-compat） | 视为 unknown，记录 warning |

**实现位置**：`adapter.poll(shortId, timeoutMs)` 包装 `readJobState` 轮询（500ms 一次），超时抛 `PollTimeoutError`。

### 4.4 并发控制

| 并发维度 | 谁决定 | 怎么控 |
|---------|--------|--------|
| Pipeline 之间 | PipelineStore 的 `running/` 目录 | 默认 1 个同时跑（profile 可配 `max_concurrent_pipelines`） |
| Pipeline 内的 4 个 pane | 状态机驱动 | R1/R2 串行（同 work session resume）；EXTERNAL_REVIEW 轮次内 review-A/B Promise.all 并行；ARBITER 串行在 EXTERNAL 之后 |
| Polling 频率 | adapter 内部 | 500ms 一次（state.json 写盘 100-200ms 一次，500ms 是合理平衡） |

### 4.5 SSE 协议

```typescript
// EventSource 收到的事件
type SSEMessage =
  | { type: 'state_change', pipelineId, state: ReviewState, panes: PaneStatus[] }
  | { type: 'cost_update', pipelineId, totalCostUsd, roundCostUsd }
  | { type: 'log_append', pipelineId, ts, level, msg }
  | { type: 'artifact', pipelineId, role, shortId, contentType: 'markdown' | 'diff' | 'json', content }
  | { type: 'done', pipelineId, totalCostUsd, durationMs };

interface PaneStatus {
  role: 'work' | 'review-A' | 'review-B' | 'arbiter';
  shortId: string;
  sessionId: string;
  provider: string;
  status: 'busy' | 'waiting' | 'idle' | 'done' | 'stopped' | 'failed' | 'unknown';
  recentOutput?: string;
  costUsd: number;
  durationMs: number;
}
```

Pane 状态直接从 `AgentSnapshotFetcher.fetch()` 的结果投影过来，**不**自己维护 pane 状态（避免和 CLI 撕裂）。

## 5. 状态机

### 5.1 ReviewState 枚举

```typescript
type ReviewState =
  // === Produce 阶段 ===
  | { kind: 'PRODUCING';         pipelineId; round: number; pane: 'work' }
  // === 自查阶段（带 cycle 区分）===
  | { kind: 'SELF_REVIEW_R1';    pipelineId; round: number; cycle: 'initial' | 'postfix'; pane: 'work' }
  | { kind: 'SELF_REVIEW_R2';    pipelineId; round: number; cycle: 'initial' | 'postfix'; pane: 'work' }
  // === 外审（可能并行 N 个 pane）===
  | { kind: 'EXTERNAL_REVIEW';   pipelineId; round: number; cycle: 'initial' | 'postfix';
                                  panes: { role: 'review-A' | 'review-B' | ...; shortId: string }[] }
  // === 评判（复用 ExpectedReplyState 注入 work session）===
  | { kind: 'JUDGE_BY_WORK';     pipelineId; round: number; pane: 'work' }
  // === 仲裁 + 二次评判 ===
  | { kind: 'ARBITRATION';       pipelineId; round: number; pane: 'arbiter' }
  | { kind: 'JUDGE_ARBITER';     pipelineId; round: number; pane: 'work' }
  // === 人工兜底（逃生通道）===
  | { kind: 'HUMAN_DECIDE';      pipelineId; round: number; pending: ArbitrationContext }
  // === 修复（免费，复用 work session resume）===
  | { kind: 'FIXING';            pipelineId; round: number; pane: 'work' }
  // === 终态 ===
  | { kind: 'DONE';              pipelineId; round: number; totalCostUsd; issueTrail }
  | { kind: 'FAILED';            pipelineId; round: number; reason; totalCostUsd }
  | { kind: 'ABORTED';           pipelineId; round: number; reason; abortedBefore };
```

**v2 相对 v1 的 3 个关键调整**：
1. **`pane` 字段**：每个状态标注"当前活跃 pane"，方便 IDE 直接高亮 + Adapter 知道调哪个 session
2. **EXTERNAL_REVIEW 改为 `panes: [...]`**：明确支持 N 个并行 review model，IDE 渲染时画 N 个 pane
3. **JUDGE_BY_WORK / JUDGE_ARBITER 复用 ExpectedReplyState**：把"评判"当成 work session 的一次 reply 注入，**不**起新 session（v1 是新 session，浪费）

### 5.2 max_rounds 计数规则

| 类别 | 状态 | 计入 round？ |
|------|------|------------|
| **计数** | `SELF_REVIEW_R1` / `R2` / `EXTERNAL_REVIEW` / `JUDGE_BY_WORK` / `ARBITRATION` / `JUDGE_ARBITER` | ✅ +1 |
| **免费** | `PRODUCING` / `FIXING` / `DONE` / `FAILED` / `ABORTED` | ❌ |
| **逃生** | `HUMAN_DECIDE` | ❌（永远可达） |

**默认值**：Spec=8, Plan=10, Code=15, 全局默认=12。

### 5.3 状态转换图（v2 简版）

```
                    ┌──────────────┐
                    │  PRODUCING   │ ← work session 长生命周期第 1 次启动
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │ SELF_REVIEW_R1│ ← 同 work session resume
                    └──────┬───────┘
                           ↓ (issues: 0)
                           ↓ (issues: N) ↓
                    ┌──────────────┐
                    │ SELF_REVIEW_R2│ ← 同 work session resume
                    └──────┬───────┘
                           ↓ (issues: 0 → DONE)
                           ↓ (issues: N) ↓
                    ┌──────────────┐
              ┌────│EXTERNAL_REVIEW│ ← Promise.all 起 N 个 review session
              │    └──────┬───────┘
              │           ↓ opinions 收齐
              │    ┌──────────────┐
              │    │ JUDGE_BY_WORK│ ← 把 opinions 注入 work session（reply via ExpectedReplyState）
              │    └──────┬───────┘
              │           ↓ verdict: 'accept' → FIXING
              │           ↓ verdict: 'reject' / 'partial'
              │    ┌──────────────┐
              │    │  ARBITRATION │ ← 起 arbiter session
              │    └──────┬───────┘
              │           ↓ arbiter opinion
              │    ┌──────────────┐
              │    │JUDGE_ARBITER │ ← 把 arbiter opinion 注入 work session
              │    └──────┬───────┘
              │           ↓ verdict: 'accept' → FIXING
              │           ↓ verdict: 'reject' → HUMAN_DECIDE
              │    ┌──────────────┐
              │    │ HUMAN_DECIDE │ ← CLI `cc-linker review decide`
              │    └──────┬───────┘
              │           ↓ decision
              │           ↓
              │    ┌──────────────┐
              └────│    FIXING    │ ← 同 work session resume
                   └──────┬───────┘
                          ↓
                   ┌──────────────┐
                   │SELF_REVIEW_R1│ ← cycle: 'postfix'
                   │  (postfix)   │
                   └──────┬───────┘
                          ↓
                    (回到 SELF_REVIEW_R2 → EXTERNAL_REVIEW 循环)
```

## 6. PipelineStore & Reconciler

### 6.1 PipelineRecord 数据结构

```typescript
interface PipelineRecord {
  pipelineId: string;           // ULID
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;         // Phase 2 飞书集成用
  state: ReviewState;           // 当前状态
  input: {
    rawInput: string;           // 任务描述 / 文件路径 / git ref
    phase: 'spec' | 'plan' | 'code' | 'unknown';
    profile: string;
    maxRounds: number;          // 实际生效的 max_rounds
  };
  panes: PaneRegistry;          // v2 新增：跨多状态机持续追踪 4 个 pane 的 shortId
  history: HistoryEvent[];      // v2 微调：每条 history 带 pane shortId
  totalCostUsd: number;
}

interface PaneRegistry {
  work?: { shortId: string; sessionId: string; provider: string; startedAt: string };
  reviews: { role: 'review-A' | 'review-B' | ...; shortId: string; sessionId: string;
             provider: string; round: number; cycle: 'initial' | 'postfix' }[];
  arbiter?: { shortId: string; sessionId: string; provider: string; round: number };
}

interface HistoryEvent {
  ts: string;
  fromState: ReviewState['kind'] | null;
  toState: ReviewState['kind'];
  round: number;
  role: 'work' | 'review' | 'arbiter' | 'human';
  paneShortId?: string;         // v2 新增：哪个 session 跑了这一步
  providerAlias?: string;
  inputDigest: string;          // sha256 of input text（前 16 字符），不存原始 prompt
  outputDigest: string;
  outputSizeBytes: number;
  costUsd: number;
  durationMs: number;
  issues?: Issue[];
  verdict?: 'accept' | 'partial' | 'reject';
}
```

**v2 相对 v1 的 3 个关键调整**：
1. **`panes: PaneRegistry`**：跨多状态机持续追踪 4 个 pane 的 shortId，**关键**：work session 的 shortId 跨 R1/R2/JUDGE/FIX 复用，必须能查到"当前 round 用的还是不是同一个 shortId"
2. **`paneShortId` 字段**（每条 history）：诊断用，复盘时知道哪条 review 意见来自哪个 session
3. **`inputDigest` / `outputDigest`**：v1 spec 说"不存完整 prompt 避免泄露"，v2 直接用 sha256 替代

### 6.2 6 目录持久化

```
~/.cc-linker/review-pipelines/
├── pending/         # 已创建但未开始
├── running/         # 正在跑
├── human_pending/   # 等待人工决策
├── done/            # 已完成
├── failed/          # 失败
└── aborted/         # 用户中止或 max_rounds 触发
```

**原子写规则**：
```typescript
async function saveRunning(record: PipelineRecord): Promise<void> {
  const path = `~/.cc-linker/review-pipelines/running/${record.pipelineId}.json`;
  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(record, null, 2));
  await rename(tmpPath, path);   // 原子 rename
}

async function moveToTerminal(record: PipelineRecord): Promise<void> {
  const srcPath = `~/.cc-linker/review-pipelines/running/${record.pipelineId}.json`;
  const destDir = `~/.cc-linker/review-pipelines/${terminalDir(record.state.kind)}/`;
  const destPath = `${destDir}${record.pipelineId}.json`;
  await rename(srcPath, destPath);
}
```

### 6.3 幂等性保证（v2 强化）

```typescript
async function transition(pipeline: PipelineRecord, event: EngineEvent): Promise<void> {
  // 1. 读 history last event
  const lastEvent = pipeline.history[pipeline.history.length - 1];

  // 2. 如果 lastEvent.toState 已经是目标 state，幂等返回
  if (lastEvent && lastEvent.toState === computeNextState(pipeline.state, event).kind) {
    logger.info(`[engine] pipeline ${pipeline.pipelineId} 已在 ${lastEvent.toState}，幂等跳过`);
    return;
  }

  // 3. 否则正常推进
  const nextState = computeNextState(pipeline.state, event);
  const newEvent: HistoryEvent = { ... };
  await pipelineStore.appendHistory(pipeline.pipelineId, newEvent);
  pipeline.state = nextState;
  pipeline.history.push(newEvent);
  await pipelineStore.saveRunning(pipeline);
  await ideServer.broadcast(pipeline.pipelineId, { type: 'state_change', state: nextState });
}
```

**幂等的 3 道防线**：
1. **History 去重**：`lastEvent.toState === 目标 state` → 跳过
2. **State machine 转换函数本身幂等**：纯函数，相同 input 永远相同 output
3. **Polling 间隔去重**：adapter.poll 500ms 一次，但只在 state 变化时 emit 事件（避免事件洪水）

### 6.4 Reconciler（启动恢复）

```typescript
export async function reconcile(): Promise<void> {
  const store = new PipelineStore();
  const fetcher = new AgentSnapshotFetcher();
  const adapter = new ReviewSessionAdapter();

  // 1. 扫描 running/ 中所有未到终态的 pipeline
  for (const record of await store.listRunning()) {
    if (isTerminal(record.state.kind)) {
      // 状态已是终态但还停在 running/，移到对应终态目录
      await store.moveToTerminal(record);
      continue;
    }

    // 2. 验证 pane bg session 是否还活着
    const liveShortIds = (await fetcher.fetch())?.sessions.map(s => s.sessionId.slice(0, 8)) ?? [];
    const deadPanes = findDeadPanes(record.panes, liveShortIds);
    if (deadPanes.length > 0) {
      logger.warn(`[reconciler] pipeline ${record.pipelineId} 有 ${deadPanes.length} 个 pane 已消失: ${deadPanes.join(', ')}`);
      // v2 选：FAILED（reason: 'pane_session_lost_on_restart'），避免从不可信状态恢复
      record.state = { kind: 'FAILED', round: record.state.round, reason: 'pane_session_lost_on_restart', totalCostUsd: record.totalCostUsd };
      await store.saveAndMoveToTerminal(record);
      continue;
    }

    // 3. 加回内存中的 active set
    engine.continuePipeline(record);

    // 4. 幂等推进：从当前 state.kind 继续
    //    - 如果是 EXTERNAL_REVIEW 且 review 已收齐（panes 都在 done）：跳过，直接进 JUDGE
    //    - 如果是 HUMAN_DECIDE：发 IDE 通知
    //    - 如果是 FIXING 等异步状态：继续轮询
  }

  // 5. human_pending/ 中所有 pipeline：发 IDE 通知
  for (const record of await store.listHumanPending()) {
    await ideServer.notifyHumanPending(record);
  }
}
```

**Reconciler 关键决策**：

| 场景 | 行为 | 理由 |
|------|------|------|
| running/ 中 pipeline + 所有 pane 都还活着 | 继续推进 | 幂等恢复 |
| running/ 中 pipeline + 部分 pane 已消失 | **直接 FAILED**（不重试） | bg session 是 CLI 维护的，状态机无法重建；从不可信状态恢复会导致后续 review 错乱 |
| running/ 中 pipeline + 全部 pane 已消失 | FAILED | 同上 |
| human_pending/ 中 pipeline | 发 IDE 通知，不主动推进 | 等用户决策；超时由 `HUMAN_DECIDE_TIMEOUT` 配置控制（默认 24h） |

**为什么不"自动重试丢失的 pane"？** v2 选**保守**——一旦 bg session 丢失就 FAILED，用户从终端报告里看产物 + 决定是否重跑整条 pipeline。这避免了"自动恢复"导致"产物污染"的灾难。

### 6.5 并发控制

```typescript
async function acquirePipelineSlot(profile: ReviewProfile): Promise<boolean> {
  const maxConcurrent = profile.guards.max_concurrent_pipelines ?? 1;
  const running = await store.listRunning();
  if (running.length >= maxConcurrent) return false;
  return true;
}
```

**默认 1 个 pipeline 同时跑**（避免 token 用量爆炸），profile 可配 `guards.max_concurrent_pipelines = 3`。

## 7. ReviewProfile

### 7.1 存储位置

`~/.cc-linker/review-profiles/<name>.toml`

### 7.2 完整配置示例

```toml
[meta]
name = "default"
description = "通用默认：sonnet 工作 + kimi/qwen 双 Review + opus 仲裁"

[work]
provider = "claude-sonnet-4"   # ← 直接映射到 ~/.claude/providers/<name>.json

[review]
mode = "parallel"
providers = ["kimi-for-coding", "bailian-qwen3.6"]   # ← 数组决定 EXTERNAL_REVIEW 几个 pane

[arbiter]
provider = "claude-opus-4"
trigger_on = "disagree_significantly"  # reject | disagree_significantly | low_acceptance

[guards]
max_rounds = 12
max_concurrent_pipelines = 1   # v2 新增：默认 1

[prompts.work.produce.system]
template = """
你正在编写一份 {phase}。
{task}
"""

[prompts.work.judge.system]
template = """
工作产物：
{artifact}
待评判意见：
{opinions}
请输出 JSON: { verdict: 'accept' | 'partial' | 'reject', accepted_issues: [...] }
"""

[prompts.review.code.system]
template = """
你正在 Review 一段代码变更。
{artifact}
请输出 JSON: { issues: [{ severity, category, location, description, suggestion }] }
"""

[phase_overrides.code]
review.providers = ["kimi-for-coding", "bailian-qwen3.6", "xiaomi-mimo"]   # 完全替换
guards.max_rounds = 15
```

### 7.3 per-phase 深度 merge 规则

照搬 v1 spec §4.3：
- 标量字段（string/number/bool）：phase 值完全覆盖 top-level
- 数组字段（providers）：phase 值完全替换 top-level 数组（不追加）
- table 字段（prompts）：phase 的子表与 top-level 子表深度 merge

### 7.4 Provider 字段 → settingsPath 映射

```typescript
async function resolveSettingsPath(provider: string): Promise<string> {
  const home = process.env.HOME!;
  const path = `${home}/.claude/providers/${provider}.json`;
  if (!existsSync(path)) throw new ProfileError(`provider ${provider} 未在 ~/.claude/providers/ 找到`);
  return path;
}
```

**关键不变量**：
- `~/.cc-linker/review-profiles/*.toml` —— 用户编辑
- `~/.claude/providers/*.json` —— 用户已配置（kimi / qwen3.6 / mimo 等已存在）
- Review Engine **不**修改 providers，只**读取**

## 8. Phase 1 电脑端 UX

### 8.1 终端入口：CLI（核心使用方式）

```bash
# 1. 一次性跑 pipeline（最常用）
cc-linker review run "帮我修 NPE in auth.ts" \
    --phase code \
    --profile default

# 跑起来后 CLI 输出：
# ✓ Pipeline 启动: 01HXYZK9...
#   Phase: code (max_rounds: 15)
#   Profile: default (work=sonnet-4, review=[kimi, qwen3.6], arbiter=opus-4)
#
# 🌐 IDE: http://localhost:9821/?id=01HXYZK9... (浏览器打开看实时状态)
#
#   [10:23:45] PRODUCING              work=abc12345 (sonnet-4)        ⏱  2.3s   $0.012
#   [10:23:52] SELF_REVIEW_R1         work=abc12345 (sonnet-4)        ⏱  1.8s   $0.008
#   [10:24:01] SELF_REVIEW_R2         work=abc12345 (sonnet-4)        ⏱  2.1s   $0.009
#   [10:24:15] EXTERNAL_REVIEW        review-A=def67890 (kimi)        ⏱  4.2s   $0.018
#                                    review-B=ghi11111 (qwen3.6)     ⏱  4.0s   $0.017
#   [10:24:35] JUDGE_BY_WORK          work=abc12345 (sonnet-4)        ⏱  3.5s   $0.014
#   [10:24:48] FIXING                 work=abc12345 (sonnet-4)        ⏱  4.8s   $0.020
#   [10:25:01] SELF_REVIEW_R1 (postfix) work=abc12345 (sonnet-4)      ⏱  0.0s   -
#
# ⏳ 等待中... (Ctrl-C 中止后可重连: cc-linker review status 01HXYZK9...)

# 2. 查询状态
cc-linker review status 01HXYZK9...
# 输出: 表格形式 + 实时费用 + 当前状态 + 各 pane shortId

# 3. 中止
cc-linker review abort 01HXYZK9...
# 写 ABORTED 到 store + 调 claude stop <shortId> 清理 4 个 pane

# 4. 报告
cc-linker review report 01HXYZK9...
# 输出 Markdown 报告到 stdout（或 --out <file> 写文件）

# 5. HUMAN_DECIDE 决策
cc-linker review decide 01HXYZK9... --accept-all
cc-linker review decide 01HXYZK9... --accept "1,3"
cc-linker review decide 01HXYZK9... --reject-all
```

**CLI 输出的关键设计**：
- **彩色 ANSI**：当前状态高亮（青色=进行中、绿色=完成、红色=失败/中止）
- **时间戳前缀**：每行带时间，方便回看
- **省 token**：状态变更才输出（不是 500ms 刷一次）
- **Ctrl-C 友好**：用户 Ctrl-C 后 pipeline 在后台继续跑，重连用 `review status <id>`

### 8.2 IDE 入口：单 HTML 页（实时可视化）

**Phase 1 形态**：**单文件 HTML + 内联 vanilla JS + SSE**，零依赖、零构建。

```
打开浏览器 → http://localhost:9821/?id=01HXYZK9... → 自动 SSE 订阅

┌──────────────────────────────────────────────────────────────────────┐
│ cc-linker Review IDE   │  01HXYZK9...  │  Phase: code  │  ● running  │
├──────────────────────────────────────────────────────────────────────┤
│ Round: 3 / 15  │  Cost: $0.42  │  ⏱ 12:34  │  State: EXTERNAL_REVIEW│
├────────────────────┬────────────────────┬────────────────────┬────────┤
│ 🔧 Work (sonnet)   │ 👁 Review-A (kimi) │ 👁 Review-B (qwen) │ ⚖ Arbiter│
│                    │                    │                    │   idle  │
│ Status: done       │ Status: busy       │ Status: busy       │         │
│ Round: 3           │ Round: 3           │ Round: 3           │         │
│ Cost: $0.10        │ Cost: $0.05        │ Cost: $0.07        │         │
│                    │                    │                    │         │
│ ┌────────────────┐ │ ┌────────────────┐ │ ┌────────────────┐ │         │
│ │ R1: 0 issues   │ │ │ issue 1 (high) │ │ │ issue 1 (med)  │ │         │
│ │ R2: 0 issues   │ │ │   line 42      │ │ │   line 51      │ │         │
│ │                │ │ │   NPE          │ │ │   no input     │ │         │
│ │ ▾ recent output│ │ │   validation   │ │ │   validation   │ │         │
│ │  Fixed NPE in  │ │ │ ▾ thinking...  │ │ │ ▾ thinking...  │ │         │
│ │  auth.ts:42    │ │ │                │ │ │                │ │         │
│ └────────────────┘ │ └────────────────┘ │ └────────────────┘ │         │
├────────────────────┴────────────────────┴────────────────────┴────────┤
│ ●─●─●─●─●─○─○─○─○  Initial: Prod→R1→R2→ExtRev→Judge→[Arbiter→Judge→Human]│
│                  Postfix: Fix→R1→R2→(ExtRev)→...                         │
├──────────────────────────────────────────────────────────────────────┤
│ Timeline:  [12:30] Work 生产 v1    [12:31] R1 (3 issues)               │
│           [12:32] R2 (1 issue)    [12:33] ExtRev kimi+qwen             │
│           [12:34] Judge by Work  ...  [click any to expand]            │
└──────────────────────────────────────────────────────────────────────┘
```

**Phase 1 vs Phase 2 的简化决策**：

| 功能 | Phase 1（v2） | Phase 2 |
|------|--------------|---------|
| 4 张 pane 卡片 | ✅ | ✅ 升级为完整 2×2 网格 |
| 状态条 | ✅ 简单 9 节点 | ✅ 完整 13 节点 + 闪烁 |
| 时间线 | ✅ 折叠列表 | ✅ 完整可展开 |
| Pane 全屏模式 | ❌ 点开看 JSON 原始数据 | ✅ 模态框 |
| 报告导出 | ❌ CLI `review report` | ✅ 浏览器内下载 |
| 人工决策 UI | ❌ CLI `review decide` | ✅ 浏览器内按钮 |
| 多 pipeline 并行 | ❌ 一次 1 个 | ✅ 列表 + 切换 |

### 8.3 IDE 与 CLI 的协作（Phase 1）

```
用户        终端 CLI                  IDE 浏览器         Adapter/Engine
 │             │                          │                    │
 │ review run  │                          │                    │
 ├────────────►│ start pipeline           │                    │
 │             ├─────────────────────────┼───────────────────►│
 │             │                          │                    │ 起 4 pane
 │             │                          │ ◄──────────────────┤
 │             │ 输出 URL                 │  state=PRODUCING  │
 │ ◄───────────┤                          │                    │
 │  打开浏览器  │                          │                    │
 ├─────────────┼──────────►               │                    │
 │             │                          │ 打开 HTML          │
 │             │                          │ SSE 订阅           │
 │             │                          ├───────────────────►│
 │             │                          │ 实时状态           │
 │             │                          │ ◄──────────────────┤
 │             │ 输出实时进度             │                    │
 │ ◄───────────┤                          │                    │
 │             │                          │                    │
 │ Ctrl-C 退出 │                          │ 浏览器继续看        │
 │             │                          │                    │ pipeline 跑
 │             │                          │                    │ 着
 │             │                          │                    │
 │ review      │                          │                    │
 │ status      │                          │                    │
 ├────────────►│ 重新查询 + 接 SSE        │                    │
 │ ◄───────────┤                          │                    │
```

**关键设计**：
- **CLI Ctrl-C 退出后，pipeline 继续跑**（不影响 IDE）
- **IDE 关闭后，pipeline 继续跑**（不影响 CLI 重连）
- **CLI 和 IDE 是同一 pipeline 的两个观察者**，都通过 SSE 订阅同一个 `pipelineId`

### 8.4 无浏览器 fallback（CLI-only 模式）

```bash
# 用户不想开浏览器，纯终端用：
cc-linker review run --no-ide "帮我修 NPE"

# 输出更密集（包含每个 pane 的 recent output 摘要）：
# [10:23:45] PRODUCING              work=abc12345 (sonnet-4)        ⏱  2.3s   $0.012
#   ↳ recent: 正在分析 auth.ts 第 42 行的 NPE...
# [10:23:52] SELF_REVIEW_R1         work=abc12345 (sonnet-4)        ⏱  1.8s   $0.008
#   ↳ recent: 检查 0 issues，继续 R2
# [10:24:01] SELF_REVIEW_R2         work=abc12345 (sonnet-4)        ⏱  2.1s   $0.009
#   ↳ recent: 0 issues, 走外审
```

`--no-ide` 模式下**不**起 HTTP server，纯 CLI 输出。所有 4 个 pane 的 recent output 折叠成 1 行（避免刷屏）。

### 8.5 错误时的 UX

| 错误 | 终端输出 | IDE 输出 |
|------|---------|---------|
| Provider 找不到 | ❌ `provider 'kimi-2.6' 不在 ~/.claude/providers/` + 退出码 1 | 同步红屏 + 不起 SSE |
| bg session 启动失败 | ❌ `work session 启动失败: <err>` + 标记 FAILED | 红屏 + 状态条变红 |
| 进程崩溃 | ⚠️ `pipeline 仍在跑，PID xxx，重启用 cc-linker review status <id>` | 浏览器可继续看 |
| Review 返回 50+ issues | 自动截断到 top 10 + 终端告警 | Pane 卡片显示 "+N more" |
| HUMAN_DECIDE 超时 | 自动 ABORTED + 终端输出 `human_decision_timeout` | 状态条变红 + 通知 |

## 9. PhaseDetector

```typescript
function detect(input: { rawInput: string; filePath?: string; gitRef?: string }): 'spec' | 'plan' | 'code' {
  // 启发式 1: 文件路径
  if (input.filePath) {
    if (/\.(ts|js|py|go|rs|java|swift|c|cpp|h)$/.test(input.filePath)) return 'code';
    if (input.filePath.includes('docs/') || input.filePath.includes('specs/')) return 'spec';
    if (input.filePath.includes('plans/') || input.filePath.includes('design/')) return 'plan';
  }

  // 启发式 2: git ref
  if (input.gitRef) return 'code';

  // 启发式 3: 文本内容关键词
  const text = input.rawInput.toLowerCase();
  if (text.match(/(requirements?|user stor(y|ies)|acceptance criteria)/)) return 'spec';
  if (text.match(/(architecture|task breakdown|milestone|dependencies?)/)) return 'plan';
  if (text.match(/(implement|fix|debug|optimize|refactor)/)) return 'code';

  // 启发式 4: LLM 分类（Phase 3 才实现，Phase 1 抛 "phase_unknown" 由用户手动选择）
  if (config.review.phaseDetect.llmFallback) {
    return await llmClassify(input.rawInput);
  }
  throw new PhaseUnknownError(rawInput);
}
```

**用户可在 CLI / IDE 上手动覆盖**自动识别的结果：
```bash
cc-linker review run "..." --phase code   # 显式指定
cc-linker review run "..."   # 自动识别失败抛 PhaseUnknownError，提示用 --phase 指定
```

## 10. 错误处理

### 10.1 错误分类

| 错误类别 | v2 触发场景 | v2 调整 |
|---------|-----------|---------|
| **Provider 不可用** | 模型 provider alias 不存在 | **Profile 加载阶段 fail fast**（v1 是 pipeline 跑起来才检测，v2 在 `profile.load` 就验证所有 provider 存在） |
| **Claude 进程启动失败** | SDK 启动报错 | **不重试**（v1 默认重试 1 次；v2 不重试，因为 ClaudeSessionManager.sendMessage 内部已有重试，重复重试是浪费） |
| **bg session 启动后立即失败** | n/a | **v2 新增**：state.json.state 出现 'failed' detail='启动失败' → 标记 FAILED |
| **bg session 消失** | n/a | **v2 新增**：Reconciler 启动时检测，running/ 中 pipeline + pane 消失 → FAILED `pane_session_lost_on_restart` |
| **Claude 进程超时** | hard_timeout | **保留**：max_rounds 计数器 +1 |
| **JSON 解析失败** | Review Model 返回非合法 Issue | **保留**：把 raw response 存为 `parse_failed` 事件；该轮 Review 视为 0 意见 |
| **Issue 数过多** | 50+ issues | **保留**：自动按 severity 截断到 top 10 + 提示"还有 N 条未列出" |
| **磁盘写入失败** | PipelineStore 原子写失败 | **保留**：立即停止状态机推进；状态保留在内存；终端输出 ❌ + 提示重试 |
| **进程崩溃** | cc-linker SIGKILL | **保留**：Reconciler 扫描 running/ 恢复 |
| **人工决策超时** | HUMAN_DECIDE 24h 未响应 | **保留**：自动 ABORTED `human_decision_timeout`；启动时提示 |
| **max_rounds 达到** | 计数器到上限 | **保留**：自动 ABORTED `max_rounds_exceeded` |
| **SSE 客户端断连** | n/a | **v2 新增**：IDE 关闭浏览器时，server 清理 EventSource 引用，不影响 pipeline |

### 10.2 Graceful degradation vs fail fast

| 错误 | 处理 | 理由 |
|------|------|------|
| 单个 review pane 启动失败 | **降级**：用 0 opinions 推进到 JUDGE（标记 `degraded: true`） | 不要让 1 个 review 失败整条 pipeline |
| Work pane 启动失败 | **Fail fast**：标记 FAILED | 没有 work pane 整条 pipeline 没法继续 |
| Arbiter pane 启动失败 | **降级**：跳过 ARBITRATION，直接进 HUMAN_DECIDE | arbiter 是 fallback 路径 |
| Profile 加载失败 | **Fail fast**：CLI 立即退出码 1 | 错误配置不该跑 pipeline |
| Provider 配置文件 schema 错 | **Fail fast**：profile.load 验证 JSON schema | 错配置会污染整轮 review |

### 10.3 retry 策略

```typescript
async function startSession(opts: StartSessionOptions): Promise<SessionHandle> {
  // Layer 1: ClaudeSessionManager 内部已有 1 次重试（SDK 启动失败）
  // Layer 2: adapter 不再重试，直接把错误 throw 给 engine
  // 理由：避免 retry 风暴 + 状态机需要明确知道"哪一步失败"
  return await sessionManager.sendMessage(opts.prompt, opts.cwd, opts.isNew, opts.settingsPath);
}
```

### 10.4 HUMAN_DECIDE 接收方式（Phase 1 简化）

**v1 spec** 说"走 IDE/CLI 接收"，v2 Phase 1 简化为：

```bash
# 1. pipeline 进入 HUMAN_DECIDE 后，CLI 输出：
#   ⏸️ Pipeline 01HXYZK9... 等待人工决策
#   Issue 1: <description>  (Review A 提出)
#   Issue 2: <description>  (Review B 提出)
#   Work verdict: reject
#   Arbiter verdict: reject
#
#   选项:
#     a) 接受所有 issue → 修复: cc-linker review decide 01HXYZK9... --accept-all
#     b) 接受子集       → 修复: cc-linker review decide 01HXYZK9... --accept "1,3"
#     c) 拒绝所有      → 中止: cc-linker review decide 01HXYZK9... --reject-all
#     d) 推迟          → 等你: 什么都不做，超时后自动 ABORTED

# 2. 用户决策后，pipeline 自动继续
```

**Phase 2** 才做 IDE 内按钮（飞书 / 浏览器）。

## 11. 测试策略

### 11.1 测试分层

| 层级 | v2 覆盖 | 工具 |
|------|---------|------|
| **单元测试** | 状态机转换函数、Profile 加载 + per-phase merge、PhaseDetector 启发式、prompt 模板替换、Issue/ReviewOpinion 解析、max_rounds 计数、panes Registry 追踪 | `bun:test` + 纯函数 fixture |
| **集成测试** | Adapter（mock ClaudeSessionManager）+ Engine（mock Adapter）+ PipelineStore（真写盘）+ IDE server（fetch + 内存 SSE 订阅） | `bun:test` + fixtures |
| **持久化测试** | Reconciler 在不同崩溃点下的恢复行为（running/ 中有 pane 消失、human_pending/ 中有 pipeline 等） | 真 PipelineStore + mock Adapter |
| **E2E 测试** | CLI `cc-linker review run <fixture task>` → 走完一个 mini pipeline → 验证产出的 PipelineRecord | `bun:test` + 真实 claude CLI + 真 provider |
| **手工 QA** | gstack `/qa` + `/browse` | gstack skills |

### 11.2 关键测试场景

**v1 的 12 个场景**全部保留，**v2 新增 4 个**：

1. **Profile 加载阶段 provider 缺失** → 立即 fail fast，**不**起任何 bg session
2. **EXTERNAL_REVIEW 轮中 1 个 review pane 启动失败** → degraded 模式，用 0 opinions 推进
3. **bg session 启动后立即 'failed'**（state.json 出现 failed 状态）→ 标记 FAILED + 原因
4. **HUMAN_DECIDE 接收 `cc-linker review decide <id> --accept-all`** → pipeline 继续到 FIXING

### 11.3 单测覆盖目标

| 模块 | 行覆盖率目标 | 关键场景 |
|------|------------|---------|
| `engine.ts` | 90%+ | 状态机所有转换路径 |
| `adapter.ts` | 85%+ | startSession 成功 / 失败 / 注入 reply / poll state.json |
| `profile.ts` | 95%+ | TOML 解析 + per-phase 深度 merge + provider 校验 |
| `pipeline-store.ts` | 90%+ | 6 目录原子写 + 移动到终态 |
| `reconciler.ts` | 85%+ | running/ + human_pending/ 恢复 + pane 丢失检测 |
| `phase-detect.ts` | 90%+ | file path / git ref / 关键词 / PhaseUnknown |
| `ide-server.ts` | 75%+ | POST /api/pipelines + GET /events SSE + 鉴权 |

### 11.4 关键 E2E 场景（Phase 1 必须通过）

```bash
# Scenario 1: Mini spec pipeline (R1 收敛 → 外审 → 0 issues → DONE)
cc-linker review run "写一个 hello world 函数的 spec" --phase spec --profile default
# 期望: ≤ 30s 跑完，PipelineRecord.state.kind == 'DONE'

# Scenario 2: Mini plan pipeline (R1 不收敛 → R2 收敛 → 外审 → 1 issue → fix → DONE)
cc-linker review run "设计一个 todo list 的实现 plan" --phase plan --profile default
# 期望: ≤ 60s 跑完，PipelineRecord.history 含 5+ 条 events

# Scenario 3: Ctrl-C 退出 + 重连
cc-linker review run "long task" --phase code &
PIPELINE_ID=...
sleep 2
kill %1
cc-linker review status $PIPELINE_ID
# 期望: 状态正确显示，pipeline 在后台继续跑
```

## 12. 分阶段路线

### 12.1 Phase 1：MVP（4-6 周）—— 核心引擎 + CLI + 简版 IDE

| Week | 任务 | 交付 | 验收 |
|------|------|------|------|
| W1 | T1 Profile 加载 + provider 校验 | `profile.ts` + 单元测试 + fixture | TOML 解析 / per-phase merge / provider 存在性校验 100% |
| W1 | T2 PipelineStore + Reconciler | `pipeline-store.ts` + `reconciler.ts` + 集成测试 | 6 目录原子写 / 移动到终态 / 启动恢复 / pane 丢失检测 |
| W2 | T3 PhaseDetector | `phase-detect.ts` + 单元测试 | 4 个启发式 + PhaseUnknownError |
| W2 | T4 Adapter | `adapter.ts` + 集成测试（mock ClaudeSessionManager） | startSession / poll / injectReply / stop 4 个 API |
| W3-W4 | T5 Engine 状态机（基础） | `engine.ts` + 12 个状态转换单测 | PRODUCING / SELF_REVIEW_R1 / R2 / EXTERNAL_REVIEW / JUDGE_BY_WORK / FIXING / DONE / FAILED / ABORTED 9 状态 |
| W4 | T6 Engine 状态机（扩展） | + 集成测试 | ARBITRATION / JUDGE_ARBITER / HUMAN_DECIDE |
| W5 | T7 CLI 命令 | `src/cli/commands/review.ts` + E2E 测试 | run / status / abort / report / decide 5 个命令 |
| W5-W6 | T8 IDE server + HTML 页 | `ide-server.ts` + `ide-static/index.html` + E2E | Bun.serve 9821 + SSE + 单 HTML 页 + 4 pane 卡片 + 状态条 + 时间线 |

**Phase 1 验收**：
- ✅ `cc-linker review run <task>` 端到端跑通 3 个 mini pipeline（spec / plan / code 各 1）
- ✅ IDE 浏览器能实时看 4 pane 状态变化
- ✅ Ctrl-C 退出 + `review status` 重连
- ✅ 进程崩溃后启动 Reconciler 恢复
- ✅ 12 个状态机单测 + 8 个 E2E 测试全过

### 12.2 Phase 2：体验优化（+3-4 周）

| 任务 | 交付 |
|------|------|
| 完整 2×2 网格 + Pane 全屏模式 | `ide-static/index.html` 升级 |
| 飞书 `/review` 命令（轻量启动 + 关键事件通知） | `src/feishu/commands/review.ts` + 通知 dispatcher |
| 报告生成（Markdown + JSON） | `review-report.ts` + CLI `review report --format md\|json` |
| Per-phase 提示词模板加载 | `prompts.<role>.<phase>.system` 模板引擎 |
| Per-phase max_rounds + providers 覆盖完善 | E2E |
| 人工决策超时配置 + IDE 通知 | `HUMAN_DECIDE_TIMEOUT` + IDE 闪烁 |
| IDE 内的"接受 issue / 拒绝 / 推迟"按钮 | 飞书卡按钮 + 浏览器按钮双通道 |

**Phase 2 验收**：
- ✅ 飞书侧 `/review <task>` 一键启动
- ✅ 报告可下载到本地
- ✅ 3 个 phase 都能跑 1 遍真实 provider（kimi / qwen3.6 / mimo）
- ✅ HUMAN_DECIDE 在 IDE / 飞书两侧都能决策

### 12.3 Phase 3：进阶（+2-3 周，按需）

| 任务 | 价值 |
|------|------|
| LLM 分类 fallback（PhaseDetector 启发式 4） | 长任务描述识别更准 |
| 配置热更新（修改 profile 无需重启） | 调参体验 |
| Pipeline 并行（一个 IDE 同时跑多个 pipeline） | 对比不同 profile |
| Token 预算（与 max_rounds 并列的软约束） | 成本控制 |
| Review 意见去重（多 model 提了同一 issue） | 减少噪声 |

### 12.4 Phase 1 任务依赖图

```
T1 Profile ─────────┐
                     ↓
T3 PhaseDetect ────→ T5 Engine (基础 9 状态)
T2 PipelineStore ───┤        ↓
                     │   T6 Engine (扩展 3 状态)
T4 Adapter ──────────┘        ↓
                              ├─→ T7 CLI
                              └─→ T8 IDE server
                                       ↓
                                  E2E 测试
```

**并行机会**：
- T1 / T2 / T3 / T4 都可并行（无依赖）
- T5 依赖 T1+T2+T3+T4 全部
- T7 / T8 可并行（互不依赖，都依赖 T5+T6）

## 13. 评审 Checklist

### 13.1 v1 9 条（全部保留）

- [ ] 状态机转换是否覆盖所有设计路径？
- [ ] max_rounds 计数规则是否与三类状态（计数/免费/逃生）一致？
- [ ] PipelineStore 6 目录设计是否能覆盖所有状态？
- [ ] Reconciler 幂等性是否被 history 充分保证？
- [ ] ReviewProfile per-phase 覆盖机制是否清晰？
- [ ] IDE 4 张 pane 卡片是否满足"多会话协调 + 集中控制"的需求？
- [ ] 默认 max_rounds 12 + per-phase 覆盖（Spec 8, Plan 10, Code 15）是否合理？
- [ ] 错误处理是否能覆盖常见故障（Provider 不可用、JSON 解析失败、进程崩溃）？
- [ ] 安全考量（127.0.0.1、PipelineRecord 不存完整 prompt）是否充分？

### 13.2 v2 新增 8 条

- [ ] `panes: PaneRegistry` 跨状态机持续追踪 work session shortId 是否足够？
- [ ] bg session 生命周期策略（work 长生命周期、review/arbiter 一次性）是否清晰？
- [ ] Polling state.json（不 parse stdout）作为判定方式是否稳定？
- [ ] Provider 加载阶段 fail fast vs pipeline 跑起来才检测，哪种更好？
- [ ] 单个 review pane 失败走 degraded 模式（用 0 opinions 推进）是否对？
- [ ] Reconciler 检测到 pane 丢失时**直接 FAILED 不重试**的保守策略是否对？
- [ ] CLI 主输出 + 浏览器为辅的电脑端 UX 是否符合"方便使用能用"的目标？
- [ ] HUMAN_DECIDE 在 Phase 1 简化为 `review decide` CLI 命令（不是 IDE 按钮）是否够用？

## 14. 关键风险（v2 新增识别）

| 风险 | 影响 | 缓解 |
|------|------|------|
| **bg session resume 链断裂** | work session 跨多轮时如果 shortId 变化（CLI 内部可能 restart），整条 pipeline 错乱 | Adapter 在每次 resume 前验证 shortId 仍存在；不存在则 FAILED `work_session_resume_lost` |
| **Provider settingsPath 改了** | 用户跑 pipeline 途中改了 `~/.claude/providers/*.json`，导致后续 review 走错模型 | PipelineRecord.input 锁住 `provider` 字段 + 启动时复制 settingsPath 到 `~/.cc-linker/review-pipelines/running/<id>/providers/`（snapshot） |
| **Polling 500ms 太慢** | 用户看 IDE 时 pane 状态变化有 0.5s 延迟 | Phase 1 接受；Phase 2 用 file watcher (chokidar) 监听 `state.json` mtime 触发 |
| **状态机 driver 循环 + Reconciler 抢同一个 pipeline** | Reconciler 恢复时 engine 也在跑，可能双重写 | Reconciler 加 `~/.cc-linker/review-pipelines/reconciler.lock` 文件锁；engine 启动前等锁释放 |
| **CLI Ctrl-C 退出 + IDE 关闭 + 没有任何连接器** | pipeline 跑着但没人看 | 启动时如果 `--no-ide`，engine 启动 daemon 化（`process.daemon()` 或 `setsid`） |

## 15. 文档链接

- **v1 spec**：`docs/superpowers/specs/2026-06-06-multi-model-review-engine-design.md`（保留作历史参考）
- **v2 spec（本文件）**：`docs/superpowers/specs/2026-06-13-multi-model-review-engine-v2-design.md`
- **v2 plan（待写）**：`docs/superpowers/plans/2026-06-13-multi-model-review-engine-v2-plan.md`（由 writing-plans skill 输出）
- **复用的 Agent View spec**：`docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`
