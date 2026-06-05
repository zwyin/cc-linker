# cc-linker Multi-Model Review Engine 设计

> 版本: v1.0
> 日期: 2026-06-06
> 状态: 待评审
> 作者: Claude (brainstorming session)

---

## 1. 背景与目标

### 1.1 痛点

使用 AI Coding（Claude Code 等）后，开发流程从"写代码 → 人审"变成了多轮自审 + 多模型交叉 Review 的工作流：

```
写 Spec → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写 Plan → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写代码 → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修复 → 再 Review
```

由于 Claude Code 限制，不方便在终端直接切换不同模型（kimi-2.6、qwen3.6-plus、mimo-2.5-pro 等），每次评审都需手动换 settings、重新启动进程。同时，多个模型的交叉 Review 意见如何汇总、是否采纳、是否需要仲裁，缺少一个集中的"裁决 + 流程编排"机制。

### 1.2 目标

在 cc-linker 内置一个 **Review Engine**，把以下能力**自动化 + 可视化 + 可恢复**：

1. **多模型交叉 Review 编排**：驱动"工作模型 → 外部 Review 模型 → 裁决 → 修复"的完整流水线
2. **层次化裁决机制**：工作模型自评 → 外部 Review → 工作模型评判意见 → 仲裁 → 人工兜底
3. **三阶段支持**：Spec / Plan / Code，每个阶段可配置不同的提示词、护栏、Review 模型组合
4. **Web IDE**：本地 2×2 网格 + 状态条，可视化多会话并行
5. **可恢复状态机**：每次 Review 是一个有状态的、跨进程崩溃可恢复的工作流

### 1.3 非目标

- 不替代现有 `/new` `/list` `/switch` `/model` 等飞书命令
- 不修改 `ProviderManager` 已有逻辑
- 不修改 `ClaudeSessionManager` 签名（仅复用其接口）
- 不做云端协同 / 团队共享（仍是单机单用户）
- 不做飞书 IDE 集成（Phase 2 再考虑）

---

## 2. 架构总览

### 2.1 集成方式

**同进程嵌入**：Review Engine 是 cc-linker 主进程的一个新子系统，与现有模块共享内存、配置、日志。

```
cc-linker 主进程
├── 已有模块（不动）
│   ├── cli/
│   ├── feishu/
│   ├── proxy/  ← ClaudeSessionManager
│   ├── queue/
│   ├── registry/
│   ├── scanner/
│   ├── runtime/
│   └── utils/  ← ProviderManager, paths, config
│
└── 新增 review/
    ├── engine.ts            # 状态机驱动核心
    ├── pipeline-store.ts    # 持久化
    ├── profile.ts           # ReviewProfile 加载
    ├── phase-detect.ts      # 自动识别阶段
    ├── work-model.ts        # Work Model 会话封装
    ├── review-models.ts     # 多 Review Model 并联
    ├── arbiter.ts           # 仲裁会话
    ├── prompt-template.ts   # 提示词模板替换
    ├── cost-tracker.ts      # 护栏（max_rounds）
    ├── ide-server.ts        # HTTP 服务（端口 9821）
    ├── ide-static/          # Web IDE 前端
    ├── report.ts            # 报告生成
    └── reconciler.ts        # 启动自愈
```

### 2.2 启动方式

```bash
cc-linker start              # 启动飞书 Bot + 现有 CLI
cc-linker review-server      # 启动 Review Engine + IDE
# 或合并：
cc-linker start --with-review  # 同一进程启动两者
```

默认 IDE 端口 9821，监听 `127.0.0.1`，浏览器打开 `http://localhost:9821` 即可。

### 2.3 与现有模块的边界

| 现有模块 | 复用方式 |
|---------|---------|
| `ProviderManager.resolve(alias)` | 选择模型时调用，获取 `settingsPath` |
| `ClaudeSessionManager.sendMessage(sid, text, cwd, isNew, settingsPath)` | 启动 Claude 进程（已是 SDK 模式默认） |
| `Registry.upsert(session)` | 每次产出的 Spec/Plan/Code 写为 session entry（新增 `artifact_type` 字段） |
| Spool 设计思想 | PipelineStore 完全照搬：pending/running/human_pending/done/failed 目录 + 原子写 + 启动 reconcile |
| `Config` | 扩展 `[review]` 段：IDE 端口、默认 profile、人工决策超时 |
| `logger` | ReviewEngine 自己的日志文件 `~/.cc-linker/review-engine.log` |

---

## 3. Review 状态机

### 3.1 状态机总览

整个状态机由 **两条循环**组成，共享"评判 → 修复"主干。

```
┌──────────────────────────────────────────────────────────────┐
│              初始循环（Produce 之后）                          │
│                                                              │
│   [Produce]                                                  │
│       ↓                                                      │
│   [R1: Self-Review]                                          │
│       ↓ (无论 0 issues / 有 issues)                          │
│   [R2: Self-Review]                                          │
│       ↓ (无论 0 issues / 有 issues)                          │
│   [1st External Review]   ← 强制外审，避免工作模型误判        │
│       ↓                                                      │
│   → 共享主干：Judge → Fix | Arbiter → Human                   │
│       ↓                                                      │
│   [Fix]                                                      │
│       ↓                                                      │
│   → 进入修复后内循环                                          │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│           修复后内循环（每次 Fix 之后走，可重复）                │
│                                                              │
│   [R1: Self-Review]                                          │
│      ├─ 0 issues → DONE ✓                                    │
│      └─ 有 issues ↓                                          │
│   [R2: Self-Review]                                          │
│      ├─ 0 issues → DONE ✓     (R2 收敛 = 直接 DONE)          │
│      └─ 有 issues ↓                                          │
│   [External Review (第 N 轮)]                                 │
│       ↓                                                      │
│   → 回到共享主干：Judge → Fix | Arbiter → Human               │
│       ↓                                                      │
│   [Fix]                                                      │
│       ↓                                                      │
│   → 回到本循环顶部（R1 重新开始）                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 关键设计差异

| 场景 | 行为 | 理由 |
|------|------|------|
| **初始循环 R1/R2 收敛** | → 强制走外审 | 工作模型第一次产出，可能误判，必须外部验证 |
| **修复后内循环 R1/R2 收敛** | → DONE | 已经过外审验证过的工作，修复后清零即收尾 |
| **修复后内循环 R2 不收敛** | → 重新外审 | 修复未完全解决问题，需要外部视角 |

### 3.3 共享主干

```
[任意外审完成] → 拿到 review opinions
        ↓
[Work: Judge review opinions]   ← 工作模型决定是否采纳
   ├─ 接受 → [Fix]
   └─ 分歧大 ↓
[Arbiter: Adjudicate]            ← 独立第三方
        ↓
[Work: Judge arbiter opinion]
   ├─ 接受 → [Fix]
   └─ 仍分歧大 ↓
[HUMAN: Decide]                  ← 人工兜底（逃生通道，永远可达）
        ↓
[Fix]
```

### 3.4 状态枚举

```typescript
type ReviewState =
  // === Produce 阶段 ===
  | { kind: 'PRODUCING';  round: number }
  // === 自查阶段（带 cycle 区分）===
  | { kind: 'SELF_REVIEW_R1'; round: number; cycle: 'initial' | 'postfix'; issues: Issue[] }
  | { kind: 'SELF_REVIEW_R2'; round: number; cycle: 'initial' | 'postfix'; issues: Issue[] }
  // === 外审 ===
  | { kind: 'EXTERNAL_REVIEW'; round: number; cycle: 'initial' | 'postfix'; roundIndex: number; opinions: ReviewOpinion[] }
  // === 评判 ===
  | { kind: 'JUDGE_BY_WORK';  round: number; opinions: ReviewOpinion[]; verdict?: 'accept' | 'partial' | 'reject' }
  // === 仲裁 + 二次评判 ===
  | { kind: 'ARBITRATION';    round: number; workVerdict: string; reviewOpinions: ReviewOpinion[] }
  | { kind: 'JUDGE_ARBITER';  round: number; arbiterOpinion: string; verdict?: 'accept' | 'partial' | 'reject' }
  // === 人工兜底（逃生通道）===
  | { kind: 'HUMAN_DECIDE';   round: number; pending: ArbitrationContext }
  // === 修复（免费）===
  | { kind: 'FIXING';         round: number; acceptedIssues: Issue[] }
  // === 终态 ===
  | { kind: 'DONE';           round: number; finalArtifact: string; totalCost: number; issueTrail: Issue[] }
  | { kind: 'FAILED';         round: number; reason: string; totalCost: number }
  | { kind: 'ABORTED';        round: number; reason: string; abortedBefore?: string };
```

### 3.5 max_rounds 计数规则

#### 三类状态

| 类别 | 状态 | 计入 round？ |
|------|------|------------|
| **计数（消耗 budget）** | `SELF_REVIEW_R1` | ✅ +1 |
| | `SELF_REVIEW_R2` | ✅ +1 |
| | `EXTERNAL_REVIEW`（无论 1 个还是 N 个并联模型） | ✅ +1 |
| | `JUDGE_BY_WORK` | ✅ +1 |
| | `ARBITRATION` | ✅ +1 |
| | `JUDGE_ARBITER` | ✅ +1 |
| **免费** | `PRODUCING` | ❌ |
| | `FIXING` | ❌ |
| | `DONE` / `FAILED` / `ABORTED` | ❌ |
| **逃生通道（永远可达）** | `HUMAN_DECIDE` | ❌ |

#### 默认值与 per-phase 覆盖

| 阶段 | 默认 max_rounds | 理由 |
|------|----------------|------|
| Spec | 8 | 较简单，1-2 个 postfix 迭代足够 |
| Plan | 10 | 中等复杂度 |
| Code | 15 | 复杂，允许多轮 |
| **全局默认（未识别阶段时）** | **12** | 覆盖"含仲裁 + 1-2 个 postfix"的典型复杂场景 |

#### 实现伪代码

```typescript
const COUNTED_STATES = new Set<ReviewState['kind']>([
  'SELF_REVIEW_R1', 'SELF_REVIEW_R2', 'EXTERNAL_REVIEW',
  'JUDGE_BY_WORK', 'ARBITRATION', 'JUDGE_ARBITER',
]);

function transition(current: ReviewState, event: Event, maxRounds: number): ReviewState {
  const next = computeNextState(current, event);

  // 逃生通道：永远允许
  if (next.kind === 'HUMAN_DECIDE') {
    return { ...next, round: current.round };
  }

  // 免费状态：保留 round
  if (!COUNTED_STATES.has(next.kind)) {
    return { ...next, round: current.round };
  }

  // 计数状态：先检查再递增
  const nextRound = current.round + 1;
  if (nextRound > maxRounds) {
    return {
      kind: 'ABORTED',
      reason: 'max_rounds_exceeded',
      round: current.round,
      abortedBefore: next.kind,
    };
  }

  return { ...next, round: nextRound };
}
```

---

## 4. 组件与数据流

### 4.1 数据流（一次完整流水线）

```
用户操作 (IDE / CLI)
    │ 1. POST /api/pipelines { task, input, profile }
    ▼
IdeServer → ReviewEngine.start(pipelineId)
    │
    │ 2. ReviewEngine 初始化 PipelineState，原子写入 store
    │ 3. 调 PhaseDetector.detect(input) → 'spec' | 'plan' | 'code'
    │ 4. ReviewEngine.step() 推进状态机
    │
    ▼
┌─ State Machine Driver Loop ──────────────────────────────────┐
│  while (state.kind !== 'DONE' | 'FAILED' | 'ABORTED') {       │
│    state = await transition(state, event, max_rounds);        │
│    pipelineStore.save(pipelineId, state);   // 每次落盘       │
│    ideServer.broadcast(pipelineId, state);  // SSE 推送       │
│  }                                                            │
└───────────────────────────────────────────────────────────────┘
    │
    │ 5. 调对应 Session 执行具体动作
    ▼
┌─ Session Pool ────────────────────────────────────────────────┐
│  WorkModelSession     (ProviderManager 选 work provider)     │
│  ReviewModelPool      (ProviderManager 选 review providers) │
│  ArbiterSession       (ProviderManager 选 arbiter provider) │
│  HumanDecision        (IdeServer 转发给浏览器，HUMAN 决策)    │
└───────────────────────────────────────────────────────────────┘
    │
    │ 6. ClaudeSessionManager.sendMessage(...)  ← 复用 cc-linker
    │ 7. 拿到文本/JSON 输出 → 解析为 Issue / ReviewOpinion
    ▼
返回给 ReviewEngine → 触发下一个状态转换

并行: SSE 实时把 state 变更推送到 IDE 浏览器
并行: CLI 子命令 cc-linker review status <id> 可查询
```

### 4.2 持久化：PipelineStore

目录结构：

```
~/.cc-linker/review-pipelines/
├── pending/         # 已创建但未开始
├── running/         # 正在跑
├── human_pending/   # 等待人工决策
├── done/            # 已完成
├── failed/          # 失败
└── aborted/         # 用户中止或 max_rounds 触发
```

每个 JSON 文件（PipelineRecord）：

```typescript
interface PipelineRecord {
  pipelineId: string;          // ULID
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;        // 若用户从飞书发起
  state: ReviewState;          // 状态机当前状态
  input: {
    rawInput: string;          // 任务描述 / 文件路径 / git ref
    phase: 'spec' | 'plan' | 'code';
    profile: string;           // profile 名
  };
  history: Array<{
    cycle: 'initial' | 'postfix' | 'arbitration' | 'human';
    round: number;
    role: 'work' | 'review' | 'arbiter' | 'human';
    providerAlias: string;
    input: string;
    output: string;
    costUsd: number;
    durationMs: number;
    issues?: Issue[];
    verdict?: 'accept' | 'partial' | 'reject';
  }>;
  totalCostUsd: number;
}
```

**关键不变量**：
- 每次状态变更 → 原子写 `running/<id>.json`（先 `.tmp` 再 `rename`）
- 进入终态 → 原子移到 `done/failed/aborted/`
- 启动时 Reconciler：扫描 `running/` + `human_pending/`，恢复到内存中的 active set

### 4.3 配置：ReviewProfile

存储位置：`~/.cc-linker/review-profiles/*.toml`

```toml
# 默认 profile
[meta]
name = "default"
description = "通用默认：sonnet 工作 + kimi/qwen 双 Review + opus 仲裁"

[work]
provider = "claude-sonnet-4"

[review]
mode = "parallel"              # parallel | single
providers = ["kimi-2.6", "qwen3.6-plus"]

[arbiter]
provider = "claude-opus-4"
trigger_on = "disagree_significantly"

[guards]
max_rounds = 12               # 默认值（per-phase 可覆盖）

# --- 工作模型提示词模板（per-phase）---
[work.prompts.spec]
system = """
你正在编写一份功能 Spec。结构：
1. 背景与目标
2. 用户故事
3. 边界与异常
4. 验收标准
5. 依赖与约束
"""

# --- Review 模型提示词模板（per-phase）---
[review.prompts.code]
system = """
你正在 Review 一段代码变更。请从以下维度评审：
1. 正确性：是否存在 bug、边界遗漏、空指针
2. 性能：是否有 N+1、不必要的循环、低效的数据结构
3. 安全：注入、越权、未验证输入
4. 可测性：关键路径是否可测
5. 命名与可读性

请输出结构化 JSON：
{ issues: [{ severity: 'critical'|'high'|'medium'|'low', category, location, description, suggestion }] }
"""

[review.prompts.spec]
system = """
你正在 Review 一份需求 Spec。请从以下维度评审：
1. 完整性：边界、异常路径、错误处理是否覆盖
2. 验收标准：是否可验证、可测试
3. 用户故事：是否清晰、价值明确
4. 依赖与约束：是否识别了外部依赖、性能/安全/合规约束

请输出结构化 JSON：
{ issues: [...] }
"""

[review.prompts.plan]
system = """
你正在 Review 一份实施计划。请从以下维度评审：
1. 可行性：技术选型是否合理、是否有未识别风险
2. 任务拆解：粒度是否合理、依赖关系是否明确
3. 里程碑：可衡量、可交付
4. 测试策略：是否定义了验收口径

请输出结构化 JSON：
{ issues: [...] }
"""

# --- per-phase 覆盖 ---
[phase_overrides.spec]
review.mode = "single"
review.providers = ["claude-opus-4"]
guards.max_rounds = 8

[phase_overrides.code]
review.mode = "parallel"
review.providers = ["kimi-2.6", "qwen3.6-plus", "mimo-2.5-pro"]
guards.max_rounds = 15
```

**模板占位符**：`${artifact}`、`${issues_so_far}`、`${prior_review_opinions}` 等，ReviewEngine 在调用前替换。

### 4.4 自动阶段识别（PhaseDetector）

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
  
  // 启发式 4: LLM 分类（兜底）
  return await llmClassify(input.rawInput);
}
```

**用户可在 IDE 上手动覆盖**自动识别的结果（IDE 上方有 phase selector）。

---

## 5. Web IDE 布局

### 5.1 总体布局（基线 A：2×2 网格 + 状态条）

```
┌────────────────────────────────────────────────────────────────────┐
│ [cc-linker Review IDE]   Pipeline: a3f7b2d1   Phase: [Code▼]      │  ← 顶栏
│ Cost: $0.42   Round: 3 / max 15   ⏱ 12:34                         │
├────────────────────────────────────────────────────────────────────┤
│ [Task Input] 帮我修一个 NPE bug in auth.ts ...  [▶ Start] [⏸ Pause] │
├─────────────────┬─────────────────┬─────────────────┬─────────────┤
│ 🔧 Work         │ 👁 Review A     │ 👁 Review B     │ ⚖ Arbiter   │
│ sonnet-4        │ kimi-2.6        │ qwen3.6-plus    │ opus-4      │
│                 │                 │                 │             │
│ [streaming...]  │ [streaming...]  │ [thinking...]   │ idle        │
│                 │                 │                 │             │
│ ▾ R1 Self-Review│ ▾ issue 1: NPE  │ ▾ issue 2:      │             │
│                 │   line 42       │   input not     │             │
│                 │                 │   validated     │             │
├─────────────────┴─────────────────┴─────────────────┴─────────────┤
│ ●─●─●─●─●─○─○─○  Initial: Prod→R1→R2→ExtRev→Judge→[Arbiter→Judge→Human]
│                  Postfix: Fix→R1→R2→(ExtRev)→...                   │  ← 状态条
├────────────────────────────────────────────────────────────────────┤
│ Timeline: [12:30] Work 生产 v1  [12:31] R1 (3 issues)  [12:32] R2 (1 issue)
│          [12:33] ExtRev kimi+  [12:34] Judge by Work  ...          │  ← 时间线
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 关键 UI 元素

#### 5.2.1 顶栏（Toolbar）
- Pipeline ID + 阶段选择器（用户可覆盖自动识别）
- 实时费用 / 轮次 / 耗时
- 启动/暂停/中止/导出报告按钮

#### 5.2.2 输入区
- 单行 input：任务描述 / 文件路径 / git ref
- 自动调用 `PhaseDetector`，用户可手动改 phase

#### 5.2.3 2×2 网格（4 个 Pane）

| Pane | 角色 | 显示内容 |
|------|------|----------|
| 左上 Work | 工作模型会话 | 产出文本 + Self-Review 折叠区 + Judge 推理过程 |
| 右上 Review A | 第 1 个 Review 模型 | streaming 文本 + Issue 列表（按 severity 着色） |
| 左下 Review B | 第 2 个 Review 模型 | 同上 |
| 右下 Arbiter | 仲裁模型 | 触发时显示分析（默认 idle） |

每个 Pane 有自己的折叠/展开、全屏模式（点击放大到全屏）。

#### 5.2.4 状态条（底部）
**水平进度条 + 状态机节点标签**：
- 实心圆 = 已完成
- 空心圆 = 未来
- 闪烁圆 = 当前正在跑
- 红色 = 失败 / 转人工

**关键交互**：
- 鼠标悬停节点 → 显示该步骤的费用/耗时
- 点击节点 → 滚动到 Timeline 对应条目

#### 5.2.5 时间线（最底部，可折叠）
按时间倒序列出所有事件，最新在最上：
- 模型响应（可点击展开看完整 streaming）
- 状态转换
- 人工决策
- 错误/警告

### 5.3 Web UI 技术栈

- **前端**：单页 vanilla HTML + JS（**零依赖**）
- **后端**：cc-linker 内置 HTTP server（`Bun.serve`），端口 9821
- **实时通信**：Server-Sent Events（SSE）单向推送 state 变更
- **数据 API**：
  - `POST /api/pipelines` — 启动新 pipeline
  - `GET /api/pipelines/<id>` — 查询状态
  - `POST /api/pipelines/<id>/pause` | `/resume` | `/abort`
  - `POST /api/pipelines/<id>/human-decision` — 人工决策
  - `GET /api/pipelines/<id>/report` — 下载报告
  - `GET /api/profiles` — 列出可用 profile
  - `GET /api/providers` — 列出可用 model（复用 ProviderManager）
  - `GET /events` — SSE 流

### 5.4 IDE 与状态机的协作

```
Browser (IDE)                    Bun.serve (port 9821)                 ReviewEngine
     │                                   │                                   │
     │ POST /api/pipelines               │                                   │
     │ { task, input, profile }          │                                   │
     │ ─────────────────────────────────► │                                   │
     │                                   │ ReviewEngine.start(...)            │
     │                                   │ ─────────────────────────────────►│
     │ 201 { pipelineId }                │                                   │
     │ ◄───────────────────────────────── │                                   │
     │                                   │                                   │
     │ GET /events?pipelineId=X          │                                   │
     │ ─────────────────────────────────► │ │
     │                                   │ state 变更                       │
     │ SSE: state_change { ... }         │ ◄─────────────────────────────────│
     │ ◄───────────────────────────────── │                                   │
     │ (持续推送...)                      │                                   │
     │                                   │                                   │
     │ POST /api/pipelines/<id>/         │                                   │
     │   human-decision { accept: [...] } │                                   │
     │ ─────────────────────────────────► │                                   │
     │                                   │ resume pipeline                   │
     │                                   │ ─────────────────────────────────►│
```

### 5.5 飞书集成（Phase 2，可选）

加一个 `/review` 命令（无 `/bridge` 前缀）：
- 飞书发 `/review <任务描述>` → 启动 pipeline
- 关键事件（外审完成、人工决策请求、流水线完成）推送到飞书
- 但飞书不适合多栏对比，主要作用是"轻量启动 + 通知"

---

## 6. 错误处理

| 错误类别 | 触发场景 | 处理方式 |
|---------|---------|----------|
| **Provider 不可用** | 模型 provider alias 不存在 / network 错误 | 流水线立即转 `ABORTED`，IDE 提示"模型 X 不可用，请检查 ~/.claude/providers/" |
| **Claude 进程启动失败** | SDK 启动报错 | 记录到 PipelineRecord.history；该 Pane 变红；状态保持 `running`，ReviewEngine 决定是否重试（默认重试 1 次） |
| **Claude 进程超时** | hard_timeout 触发 | 同上；max_rounds 计数器 +1 |
| **JSON 解析失败** | Review Model 返回的不是合法 Issue 列表 | 把整个 raw response 存为一条 "parse_failed" 事件；该轮 Review 视为 0 意见；log warn |
| **Issue 数过多** | 某轮 Review 返回 50+ issues | 自动按 severity 截断到 top 10 + 提示用户"还有 N 条未列出" |
| **磁盘写入失败** | PipelineStore 原子写失败 | 立即停止状态机推进；状态保持在内存；IDE 弹错误；用户重试 |
| **进程崩溃** | cc-linker 主进程 SIGKILL | 启动时 Reconciler 扫描 `running/` 目录，恢复所有 pipeline，幂等推进 |
| **人工决策超时** | `HUMAN_DECIDE` 状态下用户 24h 未响应 | 流水线自动 `ABORTED`（reason: "human_decision_timeout"）；启动时提示用户"有 N 个 pipeline 在等你的决策" |
| **max_rounds 达到** | 计数器到上限 | 流水线自动 `ABORTED`（reason: "max_rounds_exceeded"）；生成报告时高亮"未收敛问题" |

### 6.1 持久化恢复（Reconciler）

启动时执行：

```typescript
async function reconcile(): Promise<void> {
  // 1. running/ 中所有未到终态的 pipeline
  for (const file of listDir('running/')) {
    const record = readJson(file);
    if (record.state.kind in ['DONE', 'FAILED', 'ABORTED']) {
      // 状态已是终态但还停在 running/，移到对应终态目录
      moveToTerminal(file, record);
      continue;
    }
    
    // 2. 重启时把 pipeline 加回内存中的 active set
    engine.continuePipeline(record);
    
    // 3. Idempotent 推进：从当前 state.kind 继续
    //    - 如果是 PRODUCING：重新调 work model
    //    - 如果是 EXTERNAL_REVIEW 且 opinions 已收齐：跳过，直接进 JUDGE
    //    - 如果是 JUDGE 且 verdict 已记录：跳过，进下一状态
  }
  
  // 4. human_pending/ 中所有 pipeline：发 IDE 通知
  for (const file of listDir('human_pending/')) {
    const record = readJson(file);
    ideServer.notifyHumanPending(record);
  }
}
```

**幂等性保证**：
- 每个状态转换的"完成"事件是 idempotent 的（带 unique event id）
- 推进时检测"当前状态是否需要执行"，已完成的步骤不重复执行
- 通过 PipelineRecord.history 判断哪些步骤已完成

### 6.2 配置文件的容错

- ReviewProfile.toml 解析失败 → 启动时报警，IDE 显示"profile X 加载失败，使用 default"
- 缺字段 → 用默认值补齐 + log warn
- Provider alias 引用了不存在的模型 → IDE 启动时校验，禁用该 profile

### 6.3 安全考量

- IDE HTTP server 监听 `127.0.0.1`（**不绑 0.0.0.0**，避免局域网访问）
- 不需要 token 认证（仅本机访问）；但提供 `config.review.ide.token` 可选配置，启用后 IDE 打开需输入 token
- SSE 不暴露敏感的 Provider API key（key 在 settings.json，不在 pipeline record）
- PipelineRecord 的 history 中**不存**完整 prompt 内容（仅存 hash + 长度），避免磁盘泄露长 prompt 里的业务信息
- 临时文件目录权限 `0o700`

---

## 7. 测试策略

| 层级 | 覆盖 | 工具 |
|------|------|------|
| **单元测试** | 状态机转换函数、PhaseDetector、PromptTemplate 替换、Issue/ReviewOpinion 解析、max_rounds 计数 | `bun:test` |
| **集成测试** | ReviewEngine + PipelineStore + 假 Session（mock ClaudeSessionManager） | `bun:test` + fixtures |
| **持久化测试** | Reconciler 在不同崩溃点下的恢复行为 | 用真实 PipelineStore + 假 Session |
| **E2E 测试** | 启动 IDE → 在浏览器中走完一个 mini pipeline → 验证产出的 PipelineRecord | `bun:test` + JSDOM + fetch mock（不真调 Claude） |
| **手工 QA** | 用真实 Claude / kimi / qwen 跑 Spec/Plan/Code 三阶段各一遍 | gstack `/browse` + `/qa` |

### 7.1 关键状态机测试场景

1. R1 收敛（initial）→ 走外审
2. R1 不收敛 → R2 收敛 → 走外审
3. R1/R2 不收敛 → 走外审
4. Judge accept → Fix → Post-fix R1 收敛 → DONE
5. Judge reject → Arbiter → Judge accept → Fix → DONE
6. Judge reject → Arbiter → Judge reject → Human → Fix → DONE
7. Post-fix R1/R2 不收敛 → 重新外审 → loop
8. max_rounds 触发 → ABORTED
9. 进程崩溃 → Reconciler 恢复 → 幂等推进
10. Provider 不可用 → ABORTED
11. HUMAN_DECIDE 在 max_rounds 满时仍可达
12. 并联多 Review Model 时，1 轮 = 1 round（不是 N 轮）

---

## 8. 实现分阶段

### Phase 1：MVP（最小可用）
- 状态机核心 + PipelineStore
- 单 Review Model（不并联）
- IDE 基础布局（2×2 + 状态条 + 时间线）
- ReviewProfile 加载
- PhaseDetector 启发式
- 启动/暂停/中止
- Reconciler

### Phase 2：体验优化
- 并联多 Review Model
- Per-phase 提示词模板
- Per-phase max_rounds
- 飞书 `/review` 命令（轻量启动 + 通知）
- 报告生成（Markdown / JSON）
- 人工决策超时配置

### Phase 3：进阶（可选）
- LLM 分类（PhaseDetector 启发式 4）
- 配置热更新
- Pipeline 并行（一个 IDE 同时跑多个 pipeline）
- Token 预算（与 max_rounds 并列的软约束）

---

## 9. 评审 Checklist

- [ ] 状态机转换是否覆盖所有设计路径？
- [ ] max_rounds 计数规则是否与三类状态（计数/免费/逃生）一致？
- [ ] PipelineStore 6 目录设计是否能覆盖所有状态？
- [ ] Reconciler 幂等性是否被 history 充分保证？
- [ ] ReviewProfile per-phase 覆盖机制是否清晰？
- [ ] IDE 2×2 布局是否满足"多会话协调 + 集中控制"的需求？
- [ ] 默认 max_rounds 12 + per-phase 覆盖（Spec 8, Plan 10, Code 15）是否合理？
- [ ] 错误处理是否能覆盖常见故障（Provider 不可用、JSON 解析失败、进程崩溃）？
- [ ] 安全考量（127.0.0.1、PipelineRecord 不存完整 prompt）是否充分？
