# Rendezvous Timeout 2h + 流式卡双按钮 Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 rendezvous reply 的超时从 60s 拉到 2h，并修复"假按钮"问题 — 用 [🔙 不等了] / [🛑 停 bg] 双按钮替换 [🛑 停止处理]，让用户在长程任务里真正能 abort，且 abort 后能正常继续对话（**不论来自 Reply 还是 Attach 路径**）。同时 LiveProgress overview 卡刷新 10s→3s（维持 ~133min 总寿命），rendezvous 流式卡节流硬编码 5s→`stream.throttle_ms` 默认 1.5s。

**Architecture:** rendezvous Phase 2 poll 循环加 AbortSignal；FeishuBot 用 `activeRendezvousWaits: Map<openId, {abort, sessionUuid, cwd, attachedAt}>` + `rendezvousCardUpdaters: Map<openId, CardUpdater>` 跟踪在飞的 wait；CardUpdater 加 `buttons: 'default' | 'rendezvous'` 构造选项 + 新增 `patchAbortedTracking` 方法；新增 3 个 action tag 走 Agent View Stop 同款二步确认；abort/stop_bg 后**条件化恢复 user-mapping**：
- **From-Reply 路径** (`fromAgentViewReply: true`)：handleReply.markSent 已把 user-mapping 清成 null → 必须恢复成 `{type: 'session', sessionUuid, cwd}` 让用户能继续发消息
- **From-Attach 路径** (`fromAttachedChat: true`)：handleChat 没调 markSent，user-mapping 一直是 `{type: 'session', sessionUuid, cwd, attachedAt}` → 恢复时**必须保留 attachedAt**，否则用户下次发消息走 busy-check 而不是 rendezvous（Attach 语义丢）

两条路径用同一个 CardUpdater 实例（`bot.ts:1548-1552` 的 `runStreamingRendezvousReply`），所以按钮渲染只在一处改即可同时覆盖两条入口。

**Tech Stack:** Bun + TypeScript，`bun:test` (含 `mock` API)，飞书 Open Platform interactive cards，标准 `AbortController` / `AbortSignal`，沿用 `CardUpdater` / `RendezvousClient` / `UserManager.compareAndSwap` 现有抽象。

---

## Context

### 为什么改

1. **60s 超时严重低估真实长程任务**。Reply / Attach-chat 触发的 bg turn 经常 multi-file Edit + bash test + WebFetch，几分钟到十几分钟很常见。当前 `rendezvous_timeout_ms = 60_000` 让 95%+ 复杂回合被**误报为"⏱ bg 处理超时"**：
   - 飞书侧 patch 错误卡 → 流式进度全被覆盖
   - bg 在 daemon 里继续跑（`bot.ts:1701-1710` 只 patch 卡片，不调 `claude stop`），但飞书侧没人监听 → bg 真正完成时**没人推送结果**
   - 用户超时后再发消息可能触发 routing 异常
   - 整段体验从"看着 Claude 实时工作"突变为"莫名其妙失败"

2. **[🛑 停止处理] 在两条 rendezvous 路径下都是假按钮**：
   - **From-Reply**（用户 /agents → Reply → 输入文字）：handleReply.markSent 把 user-mapping 清 null → `_stopUserSession.hasTarget = false` → 返"ℹ️ 无需停止 · 当前没有活跃会话"（误导）
   - **From-Attach**（用户 /agents → Attach → 直接发文字）：user-mapping 是 session+attachedAt → `hasTarget = true`，但 `sessionManager.stopSession` 找不到 SDK 进程（rendezvous 没 SDK）→ 返"ℹ️ 无运行中任务"（也误导）
   - 两种情况都**不打断 rendezvous wait**、**不杀 bg**，5s 后 stream patch 又把卡片覆盖回 "💭 处理中"

3. **2h 决定的代价已被理解**。worker slot 最多被占 2h（单人小规模 OK）、daemon 真卡死时反馈延迟 2h（用 [停 bg] 按钮兜底）。bg 真实寿命已被 `runtime.hard_timeout_ms = 3h` 兜底。

### 当前 rendezvous 入口（已合并的 attach-rendezvous PR 后）

两条路径都汇入 `runStreamingRendezvousReply`（`bot.ts:1518`）→ 同一个 CardUpdater（`bot.ts:1550`）：

```
路径 A (From-Reply):
  /agents → Reply → 输入文字
  → handleReply (manager.ts)
    → markSent() 清 user-mapping
    → runChatSDK({fromAgentViewReply: true})
      → tryRendezvousReply
        → runStreamingRendezvousReply ← 创建 CardUpdater

路径 B (From-Attach, v2.4.1 新增):
  /agents → Attach → 直接发文字
  → handleChat (bot.ts:1041)
    → 检查 userEntry.attachedAt
    → runChatSDK({fromAttachedChat: true})
      → tryRendezvousReply (gate at bot.ts:1806)
        → runStreamingRendezvousReply ← 同一个 CardUpdater
```

差异：**markSent 只在路径 A 调** — 这是后面 handler 恢复 user-mapping 时必须分流的根本原因。

### 目标产出

- 95%+ 长 turn 走完正常 "💭→🔧→✅完成" 流程（不论 Reply 还是 Attach 入口）
- 用户在等待期间随时可以 abort（不杀 bg）或停 bg（杀 bg）
- **abort/stop_bg 后 user-mapping 正确恢复**：
  - From-Reply: 恢复成 plain session entry，后续 chat 走 busy-check 路径
  - From-Attach: 保留 attachedAt，后续 chat 仍走 rendezvous 路径
- 流式卡节流统一在 `stream.throttle_ms`（1.5s），LiveProgress 概览卡 3s 刷新

### 不在本 plan 范围

- AttachedCardWatcher tick（保持 10s × 800）
- 进度感知超时（远期）
- `sdk.timeout_ms`（权限按钮超时，与 task 无关）
- `runtime.hard_timeout_ms`（已 3h）
- spool double-finalize：已查 `spool.ts:582-617` `moveMessage`，源文件不在指定 sourceDirs 时 silent no-op → markReplied/markDone 重复调用安全，attached-chat path 外层 + 内层各 mark 一次不会出错

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/utils/config.ts` | `rendezvous_timeout_ms` 默认值 |
| `src/feishu/live-progress.ts` | LiveProgress watcher tick 配置 |
| `src/agent-view/rendezvous-client.ts` | `PollStreamingOptions` 加 `signal?: AbortSignal`；poll 循环检查 abort；`RendezvousFailureReason` 加 `'aborted'` |
| `src/feishu/card-updater.ts` | `CardUpdaterOptions` 加 `buttons` + `setRendezvousShortId` setter + 新 `patchAbortedTracking` 方法；`buildStreamingCard` 按 mode 渲染按钮 |
| `src/agent-view/card.ts` | 新增 `buildRendezvousStopConfirmCard` |
| `src/agent-view/action.ts` | `AgentViewValue` union + `isAgentViewValue` guard 加 3 个新 tag |
| `src/feishu/bot.ts` | 加 `activeRendezvousWaits` (含 attachedAt) + `rendezvousCardUpdaters` maps；shutdown 清理；`runStreamingRendezvousReply` 创建 controller / 注册 (传 attachedAt) / 终态清；CardUpdater 构造改 `buttons: 'rendezvous'` + throttle 配置；旁注释更新；3 个新 handler **（条件化恢复 user-mapping）** + 派发 |
| `tests/unit/feishu/live-progress.test.ts` | 更新断言值 |
| `tests/unit/agent-view/rendezvous-client.test.ts` | 新增 AbortSignal 测试块 |
| `tests/unit/feishu/card-updater.test.ts` | 新增双按钮 + patchAbortedTracking 测试 |
| `tests/unit/agent-view/action.test.ts` | 新增 3 个 tag 的 guard 测试 |
| `tests/unit/agent-view/card.test.ts` | 新增 builder 测试 |
| `tests/unit/feishu/bot-cardaction.test.ts` | 3 个 handler + 派发 + shutdown + aborted-reason + **from-Attach attachedAt 保留** 测试 |

---

## Cluster 0 — Config 默认值调整

### Task 0.1: `rendezvous_timeout_ms` 默认值改 7_200_000

**Files:** `src/utils/config.ts:191`

- [ ] **Step 1: 改默认值 + 注释**

```typescript
// src/utils/config.ts:191
- rendezvous_timeout_ms: 60_000,
+ rendezvous_timeout_ms: 7_200_000,  // 2h — 覆盖复杂长 bg turn; bg 仍由 runtime.hard_timeout_ms (3h) 兜底
```

- [ ] **Step 2: 确认无 fixture 写死旧值**

```bash
grep -rn "rendezvous_timeout_ms\b" /Users/wuyujun/Git/cc-linker/tests
```
Expected: 空（已 grep 验证）

- [ ] **Step 3: typecheck + commit**

```bash
bun run typecheck
git add src/utils/config.ts
git commit -m "chore: bump rendezvous_timeout_ms default to 2h (was 60s)"
```

---

### Task 0.2: `DEFAULT_LIVE_PROGRESS_CONFIG` tick 改 3s × 2667

**Files:** `src/feishu/live-progress.ts:23-27`, `tests/unit/feishu/live-progress.test.ts:65-68`

- [ ] **Step 1: 改 src 默认值**

```typescript
// src/feishu/live-progress.ts:23-27
  export const DEFAULT_LIVE_PROGRESS_CONFIG: LiveProgressConfig = {
-   intervalMs: 10_000,
-   maxTicks: 800,
+   intervalMs: 3_000,
+   maxTicks: 2667,  // 维持 ~133min wall-clock 寿命 (2667 × 3s ≈ 8001s)
    maxPatchFailures: 3,
  };
```

- [ ] **Step 2: 同步测试 fixture**

```typescript
// tests/unit/feishu/live-progress.test.ts:65-68
- expect(DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs).toBe(10_000);
- expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks).toBe(800);
+ expect(DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs).toBe(3_000);
+ expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks).toBe(2667);
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun test tests/unit/feishu/live-progress.test.ts
git add src/feishu/live-progress.ts tests/unit/feishu/live-progress.test.ts
git commit -m "chore: bump LiveProgress tick to 3s × 2667 (keeps ~133min lifetime)"
```

---

## Cluster 1 — Rendezvous client AbortSignal 支持（TDD）

### Task 1.1: `RendezvousFailureReason` 加 `'aborted'`

**Files:** `src/agent-view/rendezvous-client.ts:12-17`

- [ ] **Step 1: 扩展类型**

```typescript
// src/agent-view/rendezvous-client.ts:12-17
  export type RendezvousFailureReason =
    | 'timeout' | 'socket_closed' | 'daemon_error' | 'state_error'
+   | 'aborted'
    ;
```

- [ ] **Step 2: typecheck + commit**

```bash
bun run typecheck
git add src/agent-view/rendezvous-client.ts
git commit -m "feat(rendezvous): add 'aborted' to RendezvousFailureReason"
```

---

### Task 1.2: `PollStreamingOptions` 加 `signal?: AbortSignal` + 循环 check（TDD）

**Files:** `src/agent-view/rendezvous-client.ts:55-75` (interface) + `:257-345` (loop); Test: `tests/unit/agent-view/rendezvous-client.test.ts`

- [ ] **Step 1: 写失败测试（沿用项目 `import { tmpdir } from 'os'` 风格）**

```typescript
// tests/unit/agent-view/rendezvous-client.test.ts — 文件末尾新 describe
describe('RendezvousClient.pollStateJsonStreaming — AbortSignal', () => {
  let jobsDir: string;
  let stateJsonPath: string;

  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), 'rndzv-abort-'));
    stateJsonPath = join(jobsDir, 'state.json');
    writeFileSync(stateJsonPath, JSON.stringify({
      version: 1,
      state: { state: 'running', tempo: 'active', name: 'x', cwd: '/', updatedAt: new Date().toISOString() },
    }));
  });

  test('pre-aborted signal returns reason="aborted" without polling', async () => {
    const ac = new AbortController();
    ac.abort();
    let polled = 0;
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: 'abcd1234', stateJsonPath, timeoutMs: 5_000, pollIntervalMs: 10,
      signal: ac.signal,
      onPoll: async () => { polled++; },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aborted');
    expect(polled).toBe(0);
  });

  test('signal aborted mid-poll exits within one tick', async () => {
    const ac = new AbortController();
    let polled = 0;
    const r = await RendezvousClient.pollStateJsonStreaming({
      short: 'abcd1234', stateJsonPath, timeoutMs: 5_000, pollIntervalMs: 10,
      signal: ac.signal,
      onPoll: async () => { polled++; if (polled === 2) ac.abort(); },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aborted');
    expect(polled).toBeGreaterThanOrEqual(2);
    expect(polled).toBeLessThan(5);
  });
});
```

- [ ] **Step 2: 跑测试 fail**

```bash
bun test tests/unit/agent-view/rendezvous-client.test.ts -t "AbortSignal"
```

- [ ] **Step 3: 加 interface field**

```typescript
// src/agent-view/rendezvous-client.ts:55-75
  export interface PollStreamingOptions {
    short: string;
    stateJsonPath: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
+   /** 可选 AbortSignal。signal.aborted 时 poll 循环立即退出, 返回 { ok: false, reason: 'aborted' }。 */
+   signal?: AbortSignal;
    onPoll: (state: { kind: 'active' | 'blocked-needs' | 'done' | 'stopped' | 'error'; raw: any }) => Promise<'stop' | void> | 'stop' | void;
  }
```

- [ ] **Step 4: loop 加 abort check（loop 头部，覆盖 pre-aborted + sleep-then-abort 两种情形）**

```typescript
// src/agent-view/rendezvous-client.ts:257-345 — pollStateJsonStreaming 内 while
  while (Date.now() - start < timeoutMs) {
+   // Abort 优先于其他终结条件。Loop 头部检查覆盖 pre-aborted (循环还没跑) +
+   // sleep-then-abort (上轮 sleep 期间 abort) 两种情形。
+   if (opts.signal?.aborted) {
+     return { ok: false, reason: 'aborted', durationMs: Date.now() - start, patches };
+   }
    const outcome = await pollStateJsonOnce(opts.short, opts.stateJsonPath);
    // ... 现有逻辑不变 ...
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
```

- [ ] **Step 5: 跑测试 pass + commit**

```bash
bun test tests/unit/agent-view/rendezvous-client.test.ts
git add src/agent-view/rendezvous-client.ts tests/unit/agent-view/rendezvous-client.test.ts
git commit -m "feat(rendezvous): pollStateJsonStreaming accepts AbortSignal"
```

---

## Cluster 2 — CardUpdater 双按钮 + 新终态方法（TDD）

### Task 2.1: 加 `buttons` 构造选项 + `setRendezvousShortId` setter + 按 mode 渲染

**Files:** `src/feishu/card-updater.ts:10-14, 29, 38-48, 269, 492-543`; Test: `tests/unit/feishu/card-updater.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/feishu/card-updater.test.ts — 沿用文件首行 import { test, expect, mock, describe } from 'bun:test'
import { CardUpdater } from '../../../src/feishu/card-updater';

describe('CardUpdater — streaming card button mode', () => {
  const mockClient: any = {
    im: { v1: { message: {
      create: mock(async () => ({ data: { message_id: 'mid-1' } })),
      patch: mock(async () => ({ code: 0 })),
    } } },
  };

  test('default mode renders single [🛑 停止处理] with value.tag="stop"', () => {
    const u = new CardUpdater(mockClient);
    const card: any = (u as any).buildStreamingCard('', '', 0, []);
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(1);
    expect(a.actions[0].text.content).toBe('🛑 停止处理');
    expect(a.actions[0].value).toEqual({ tag: 'stop' });
  });

  test('rendezvous mode renders two buttons with shortId', () => {
    const u = new CardUpdater(mockClient, { buttons: 'rendezvous' });
    (u as any).setRendezvousShortId('abcd1234');
    const card: any = (u as any).buildStreamingCard('', '', 0, []);
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0].text.content).toBe('🔙 不等了');
    expect(a.actions[0].value).toEqual({ tag: 'agent_view_rendezvous_abort_wait' });
    expect(a.actions[1].text.content).toBe('🛑 停 bg');
    expect(a.actions[1].value).toEqual({
      tag: 'agent_view_rendezvous_stop_bg_request', shortId: 'abcd1234',
    });
  });
});
```

- [ ] **Step 2: 跑测试 fail**

```bash
bun test tests/unit/feishu/card-updater.test.ts -t "button mode"
```

- [ ] **Step 3: 扩展 options 接口**

```typescript
// src/feishu/card-updater.ts:10-14
  interface CardUpdaterOptions {
    throttle_ms?: number;
    max_card_bytes?: number;
    show_thinking?: boolean;
+   /** 流式卡按钮模式。'default' = [🛑 停止处理]; 'rendezvous' = [🔙 不等了] + [🛑 停 bg]. */
+   buttons?: 'default' | 'rendezvous';
  }
```

- [ ] **Step 4: 加 fields（`cardMessageId` 附近 ~line 29，与现有 readonly fields 同区块）**

```typescript
// src/feishu/card-updater.ts:29-42
  private cardMessageId: string | null = null;
+ /** v2.x: rendezvous 模式下 [🛑 停 bg] 按钮 value 里塞的 shortId。
+  *  必须在 startProcessing 之前 set, 否则首次渲染时按钮 value.shortId 为空。 */
+ private rendezvousShortId: string | null = null;
  private lastPatchAt = 0;
  // ... 其他现有 fields ...
  private readonly throttleMs: number;
  private readonly maxCardBytes: number;
  private readonly showThinking: boolean;
+ private readonly buttonsMode: 'default' | 'rendezvous';
  private state: CardState = 'processing';
```

- [ ] **Step 5: 构造器赋值（`card-updater.ts:43-48`）**

```typescript
  constructor(client: FeishuClient, options: CardUpdaterOptions = {}) {
    this.client = client;
    this.throttleMs = options.throttle_ms ?? config.get<number>('stream.throttle_ms', 1500);
    this.maxCardBytes = options.max_card_bytes ?? config.get<number>('stream.max_card_bytes', 25000);
    this.showThinking = options.show_thinking ?? config.get<boolean>('stream.show_thinking', true);
+   this.buttonsMode = options.buttons ?? 'default';
  }
```

- [ ] **Step 6: 加 setter（在 `setCardMessageId` 附近 ~line 269）**

```typescript
+ /** v2.x: rendezvous 模式按钮 value.shortId 注入。**必须在 startProcessing 之前调** —
+  *  startProcessing → buildProcessingCard → buildStreamingCard, 首次渲染就读 shortId。 */
+ setRendezvousShortId(short: string): void {
+   this.rendezvousShortId = short;
+ }
```

- [ ] **Step 7: 改 `buildStreamingCard` 按 mode 渲染按钮（`card-updater.ts:527-537`）**

```typescript
-   elements.push({
-     tag: 'action',
-     actions: [{
-       tag: 'button',
-       text: { tag: 'plain_text', content: '🛑 停止处理' },
-       type: 'danger',
-       value: { tag: 'stop' },
-     }],
-   });
+   if (this.buttonsMode === 'rendezvous') {
+     elements.push({
+       tag: 'action',
+       actions: [
+         {
+           tag: 'button',
+           text: { tag: 'plain_text', content: '🔙 不等了' },
+           type: 'default',
+           value: { tag: 'agent_view_rendezvous_abort_wait' },
+         },
+         {
+           tag: 'button',
+           text: { tag: 'plain_text', content: '🛑 停 bg' },
+           type: 'danger',
+           value: { tag: 'agent_view_rendezvous_stop_bg_request', shortId: this.rendezvousShortId ?? '' },
+         },
+       ],
+     });
+   } else {
+     elements.push({
+       tag: 'action',
+       actions: [{
+         tag: 'button',
+         text: { tag: 'plain_text', content: '🛑 停止处理' },
+         type: 'danger',
+         value: { tag: 'stop' },
+       }],
+     });
+   }
```

- [ ] **Step 8: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/card-updater.test.ts
git add src/feishu/card-updater.ts tests/unit/feishu/card-updater.test.ts
git commit -m "feat(card-updater): support rendezvous two-button mode + setRendezvousShortId"
```

---

### Task 2.2: 加 `patchAbortedTracking(opts)` 方法（不复用 cancel）

**Why:** `buildCancelledCard` 硬编码 header "🛑 已取消" + body 后缀 "你可以随时发送新消息继续对话"。[🔙 不等了] 语义是"不等了，bg 继续"，这两个文案都会误导。

**Files:** `src/feishu/card-updater.ts` (加方法 在 `cancel` 附近 ~line 175-179); Test: `tests/unit/feishu/card-updater.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe('CardUpdater.patchAbortedTracking', () => {
  test('emits custom header + body without "随时发送新消息" suffix', async () => {
    const patches: any[] = [];
    const mockClient: any = {
      im: { v1: { message: {
        create: mock(async () => ({ data: { message_id: 'mid-x' } })),
        patch: mock(async (p: any) => { patches.push(JSON.parse(p.data.content)); return { code: 0 }; }),
      } } },
    };
    const u = new CardUpdater(mockClient);
    (u as any).cardMessageId = 'mid-x';

    await u.patchAbortedTracking({
      headerTitle: '🔙 已停止跟踪',
      headerTemplate: 'grey',
      body: 'bg 仍在 daemon 中运行 · /agents 可查看后续',
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].header.title.content).toBe('🔙 已停止跟踪');
    expect(patches[0].header.template).toBe('grey');
    const md = patches[0].elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toBe('bg 仍在 daemon 中运行 · /agents 可查看后续');
    expect(md.content).not.toContain('随时发送新消息');
  });
});
```

- [ ] **Step 2: 跑测试 fail**

```bash
bun test tests/unit/feishu/card-updater.test.ts -t "patchAbortedTracking"
```

- [ ] **Step 3: 实现（放在 `cancel` 之后 ~line 180）**

```typescript
+ /**
+  * v2.x: rendezvous abort/stop 专用终态 patch。比 cancel() 灵活:
+  * - 自定义 header title + template (不再硬编码 "🛑 已取消" grey)
+  * - body 完全可控 (不再硬加 "你可以随时发送新消息继续对话" 后缀)
+  */
+ async patchAbortedTracking(opts: {
+   headerTitle: string;
+   headerTemplate: 'grey' | 'blue' | 'red' | 'green' | 'yellow';
+   body: string;
+ }): Promise<void> {
+   await this.flushPending();
+   await this.patchCard({
+     config: { wide_screen_mode: true, update_multi: true },
+     header: { title: { tag: 'plain_text', content: opts.headerTitle }, template: opts.headerTemplate },
+     elements: [{ tag: 'markdown', content: opts.body }],
+   });
+   this.state = 'cancelled';
+ }
```

- [ ] **Step 4: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/card-updater.test.ts
git add src/feishu/card-updater.ts tests/unit/feishu/card-updater.test.ts
git commit -m "feat(card-updater): add patchAbortedTracking for custom terminal cards"
```

---

## Cluster 3 — Action tag + 确认卡 builder（TDD）

### Task 3.1: `AgentViewValue` union + `isAgentViewValue` 加 3 个新 tag

**Files:** `src/agent-view/action.ts:12-43, 45-90`; Test: `tests/unit/agent-view/action.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe('isAgentViewValue — rendezvous tags', () => {
  test('accepts agent_view_rendezvous_abort_wait without payload', () => {
    expect(isAgentViewValue({ tag: 'agent_view_rendezvous_abort_wait' })).toBe(true);
  });
  test('accepts agent_view_rendezvous_stop_bg_request with shortId', () => {
    expect(isAgentViewValue({ tag: 'agent_view_rendezvous_stop_bg_request', shortId: 'abc12345' })).toBe(true);
  });
  test('rejects agent_view_rendezvous_stop_bg_request without shortId', () => {
    expect(isAgentViewValue({ tag: 'agent_view_rendezvous_stop_bg_request' })).toBe(false);
  });
  test('accepts agent_view_rendezvous_stop_bg_confirm with shortId', () => {
    expect(isAgentViewValue({ tag: 'agent_view_rendezvous_stop_bg_confirm', shortId: 'abc12345' })).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试 fail**

```bash
bun test tests/unit/agent-view/action.test.ts -t "rendezvous tags"
```

- [ ] **Step 3: 扩展 union**

```typescript
// src/agent-view/action.ts:12-43
  export type AgentViewValue =
    // ... 现有 ...
    | { tag: 'agent_view_stop_watching' }
+   | { tag: 'agent_view_rendezvous_abort_wait' }
+   | { tag: 'agent_view_rendezvous_stop_bg_request'; shortId: string }
+   | { tag: 'agent_view_rendezvous_stop_bg_confirm'; shortId: string };
```

- [ ] **Step 4: 扩展 guard（`action.ts:45-90` 现有 switch）**

```typescript
  switch (v.tag) {
    case 'agent_view_refresh_list':
    case 'agent_view_cancel_reply':
    case 'agent_view_back_to_chat':
    case 'agent_view_bg_conflict_cancel':
+   case 'agent_view_rendezvous_abort_wait':
      return true;

    case 'agent_view_refresh_peek':
    case 'agent_view_stop_confirm':
      return str('shortId') && str('sessionId');

+   case 'agent_view_rendezvous_stop_bg_request':
+   case 'agent_view_rendezvous_stop_bg_confirm':
+     return str('shortId');
    // ... 其他现有 case ...
  }
```

- [ ] **Step 5: 跑测试 pass + commit**

```bash
bun test tests/unit/agent-view/action.test.ts
git add src/agent-view/action.ts tests/unit/agent-view/action.test.ts
git commit -m "feat(action): add rendezvous abort-wait / stop-bg tags"
```

---

### Task 3.2: 新增 `buildRendezvousStopConfirmCard` builder（TDD）

**Files:** `src/agent-view/card.ts` (在 `buildStopConfirmCard` ~line 467 之后); Test: `tests/unit/agent-view/card.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { buildRendezvousStopConfirmCard } from '../../../src/agent-view/card';

describe('buildRendezvousStopConfirmCard', () => {
  test('renders red header with shortId + [确认] + [取消] buttons', () => {
    const card = JSON.parse(buildRendezvousStopConfirmCard('abc12345'));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('abc12345');
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0].text.content).toMatch(/确认/);
    expect(a.actions[0].type).toBe('danger');
    expect(a.actions[0].value).toEqual({
      tag: 'agent_view_rendezvous_stop_bg_confirm', shortId: 'abc12345',
    });
    expect(a.actions[1].text.content).toMatch(/取消/);
  });
});
```

- [ ] **Step 2: 跑测试 fail + 实现**

```typescript
// src/agent-view/card.ts — 在 buildStopConfirmCard 之后
export function buildRendezvousStopConfirmCard(shortId: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🔴 确认停止 bg? · \`${shortId}\`` },
      template: 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content:
          'bg 进行中的工作会被中断，已写文件保留。\n\n' +
          '> 💡 如果只想停止跟踪、让 bg 继续跑完，请关闭此卡返回上一卡点 [🔙 不等了]。',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认停止 bg' },
            type: 'danger',
            value: { tag: 'agent_view_rendezvous_stop_bg_confirm', shortId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← 取消' },
            type: 'default',
            value: { tag: 'agent_view_refresh_list' },
          },
        ],
      },
    ],
  });
}
```

- [ ] **Step 3: 跑测试 pass + commit**

```bash
bun test tests/unit/agent-view/card.test.ts
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(card): add buildRendezvousStopConfirmCard"
```

---

## Cluster 4 — Bot 集成：tracking maps + handler + 派发（TDD）

### Task 4.1: 加 `activeRendezvousWaits` (含 attachedAt) + `rendezvousCardUpdaters` + shutdown 清理

**关键改动 vs v2 plan**：`activeRendezvousWaits` value 多一个 `attachedAt: string | undefined` 字段 — 区分入口路径，让 handler 恢复 user-mapping 时能保留 attachedAt（from-Attach）或不带（from-Reply）。

**Files:** `src/feishu/bot.ts:149` 附近 (field declarations), `:412-419` (shutdown)

- [ ] **Step 1: 加 field 声明**

```typescript
// src/feishu/bot.ts:149 附近 (与 liveWatchers 同区块)
+ /**
+  * Active rendezvous reply waits keyed by openId.
+  *
+  * 存 AbortController + 原 session 上下文 (sessionUuid + cwd + attachedAt):
+  *   - abort: handler 用来打断 poll 循环
+  *   - sessionUuid / cwd: 恢复 user-mapping (markSent 在 from-Reply 路径清了)
+  *   - attachedAt: from-Attach 入口时 ≠ undefined; handler 恢复时保留, 让用户后续
+  *     消息仍走 rendezvous 路径 (不保留则降级到 busy-check, Attach 语义丢)
+  *
+  * Serialized per-user by spool's serialKey lock, 同 openId 最多 1 个在飞 wait。
+  */
+ private activeRendezvousWaits = new Map<string, {
+   abort: AbortController;
+   sessionUuid: string;
+   cwd: string;
+   attachedAt: string | undefined;  // from-Attach 路径时填, from-Reply 时 undefined
+ }>();
+
+ /**
+  * CardUpdater instances for active rendezvous waits, keyed by openId.
+  * Handler 用它 patch 流式卡到 abort 终态。
+  */
+ private rendezvousCardUpdaters = new Map<string, CardUpdater>();
```

- [ ] **Step 2: shutdown 清理（`bot.ts:412-419`）**

```typescript
  async shutdown(): Promise<void> {
    const watchers = Array.from(this.liveWatchers.values());
    this.liveWatchers.clear();
    if (this.agentView) {
      await this.agentView.attachedWatchers.stopAll();
    }
+   // Abort 所有在飞 rendezvous waits, 让 poll 循环干净退出
+   for (const entry of this.activeRendezvousWaits.values()) entry.abort.abort();
+   this.activeRendezvousWaits.clear();
+   this.rendezvousCardUpdaters.clear();
    await Promise.all(watchers.map(w => w.stop('bot_shutdown')));
  }
```

- [ ] **Step 3: typecheck + commit**

```bash
bun run typecheck
git add src/feishu/bot.ts
git commit -m "feat(bot): add activeRendezvousWaits (with attachedAt) + rendezvousCardUpdaters"
```

---

### Task 4.2: `runStreamingRendezvousReply` 创建 controller、注册（含 attachedAt 来源识别）

**Files:** `src/feishu/bot.ts:1518` (function start), `:1548-1553` (CardUpdater + startProcessing), `:1567` (poll 调用 signal), `:1571-1572` (旁注释), `:1688-1711` (失败分支), `:1698` (早返回清), `:1717-1724` (终态清)

**新关键点**：`runStreamingRendezvousReply` 需要知道**入口是 From-Reply 还是 From-Attach** — 唯一可靠的来源是从外层 `tryRendezvousReply → runChatSDK` 传进来的 `fromAttachedChat` flag，但 `runStreamingRendezvousReply` 当前不接这个 param。最干净的做法：从 user-mapping 现读 — 在 startProcessing 之前 `this.userManager.getEntry(openId)?.attachedAt`。markSent 已经在 from-Reply 路径把 entry 清成 null 了，所以 getEntry 拿到的 entry 要么 null（from-Reply）要么有 attachedAt（from-Attach）。

- [ ] **Step 0: cwd 字段穿透 3 个签名 + 2 个 call site（review 缺口 1）**

**Why**：`activeRendezvousWaits.set` 需要存 `cwd`（handler 恢复 user-mapping 时要用），但实测 `RendezvousEligibility` 接口（`rendezvous-fallback.ts:12-23`）**没有 `cwd` 字段**，且 `runStreamingRendezvousReply` 签名（`bot.ts:1518-1525`）也没有。需要从 `runChatSDK` 沿调用链一路把 `cwd` 传下来。

**Files:** `src/feishu/bot.ts:1475-1484` (`tryRendezvousReply` 签名), `:1509-1511` (`tryRendezvousReply` → `runStreamingRendezvousReply` call site), `:1518-1525` (`runStreamingRendezvousReply` 签名), `:1827-1829` (`runChatSDK` → `tryRendezvousReply` call site)

**Step 0.1**: 给 `tryRendezvousReply` 签名加 `cwd: string`，解构时一并拿出来：

```typescript
// src/feishu/bot.ts:1475-1484
  private async tryRendezvousReply(params: {
    openId: string;
    sessionUuid: string;
    promptText: string;
+   cwd: string;
    messageId?: string;
  }): Promise<{ ... }> {
-   const { openId, sessionUuid, promptText, messageId } = params;
+   const { openId, sessionUuid, promptText, cwd, messageId } = params;
    // ... 内部调用 runStreamingRendezvousReply 时把 cwd 传下去 (Step 0.4) ...
  }
```

**Step 0.2**: 给 `runStreamingRendezvousReply` 签名加 `cwd: string`：

```typescript
// src/feishu/bot.ts:1518-1525
  private async runStreamingRendezvousReply(params: {
    openId: string;
    sessionUuid: string;
    promptText: string;
+   cwd: string;
    messageId?: string;
    eligibility: Awaited<ReturnType<typeof checkRendezvousEligibility>>;
    timeoutMs: number;
  }): Promise<{ ... }> {
-   const { openId, sessionUuid, promptText, messageId, eligibility, timeoutMs } = params;
+   const { openId, sessionUuid, promptText, cwd, messageId, eligibility, timeoutMs } = params;
    // ... 内部 activeRendezvousWaits.set 时用 cwd (Step 1) ...
  }
```

**Step 0.3**: `runChatSDK` → `tryRendezvousReply` call site 传 cwd（cwd 已经在 runChatSDK 解构的 params 里）：

```typescript
// src/feishu/bot.ts:1827-1829
  const rv = await this.tryRendezvousReply({
    openId, sessionUuid: inputSessionUuid, promptText,
+   cwd,  // inputSessionUuid 解构里已含 cwd (bot.ts:1820)
    messageId,
  });
```

**Step 0.4**: `tryRendezvousReply` → `runStreamingRendezvousReply` call site 传 cwd：

```typescript
// src/feishu/bot.ts:1509-1511
  return await this.runStreamingRendezvousReply({
    openId, sessionUuid, promptText,
+   cwd,
    messageId, eligibility, timeoutMs,
  });
```

**Step 0.5**: typecheck + 跑相关测试 + commit：

```bash
bun run typecheck
bun test tests/unit/feishu/bot-runsdk.test.ts
git add src/feishu/bot.ts
git commit -m "feat(bot): pass cwd through tryRendezvousReply → runStreamingRendezvousReply"
```

- [ ] **Step 1: 在 startProcessing 之前读 attachedAt（用作恢复来源）**

```typescript
// src/feishu/bot.ts:1548-1553 — 修改 CardUpdater 构造前/后
+   // 在 startProcessing 之前读 user-mapping 的 attachedAt:
+   //  - from-Reply 路径: markSent 已清, entry 为 null → attachedAt undefined
+   //  - from-Attach 路径: entry = {type:'session', sessionUuid, attachedAt, ...} → attachedAt 有值
+   // handler abort 后用这个值条件化恢复 user-mapping
+   const entryAtStart = this.userManager.getEntry(openId);
+   const sourceAttachedAt = entryAtStart?.type === 'session' ? entryAtStart.attachedAt : undefined;

-   const cardUpdater = new CardUpdater(this.feishuClient!, {
-     throttle_ms: 5000,  // v2.4.x: 流式 patch 5s 节流
-   });
+   const cardUpdater = new CardUpdater(this.feishuClient!, {
+     throttle_ms: config.get<number>('stream.throttle_ms', 1500),
+     buttons: 'rendezvous',  // 渲染 [🔙 不等了] + [🛑 停 bg] 双按钮
+   });
+   // ⚠️ 必须在 startProcessing 之前 — 否则首帧渲染时 [停 bg] 按钮 value.shortId 为空串
+   cardUpdater.setRendezvousShortId(short);
    await cardUpdater.startProcessing(openId);

+   // 注册 abort + cardUpdater + 原 session 上下文 (cwd 由 Step 0 沿调用链传下来)
+   const ac = new AbortController();
+   this.activeRendezvousWaits.set(openId, {
+     abort: ac,
+     sessionUuid,                                // 从 runStreamingRendezvousReply params
+     cwd,                                        // 来自 runStreamingRendezvousReply params (Step 0 穿透)
+     attachedAt: sourceAttachedAt,
+   });
+   this.rendezvousCardUpdaters.set(openId, cardUpdater);
```

> 注：cwd 字段穿透在 Step 0 已完成。`activeRendezvousWaits.set` 直接用 Step 0 透传下来的 `cwd`，不再走 `eligibility.cwd`（`RendezvousEligibility` 接口无此字段）。

- [ ] **Step 2: 更新旁注释（`bot.ts:1571-1572` 消除"5s 节流"过时说法）**

```typescript
// bot.ts:1571-1572
-     // poll 间隔: 默认 500ms (RendezvousClient 内部), 配合 5s 卡片节流
-     // 形成 1Hz 卡片刷新节奏
+     // poll 间隔: 默认 500ms (RendezvousClient 内部), 配合 stream.throttle_ms
+     // (默认 1.5s) 卡片节流, 形成 ~3 polls/patch (≈1.5s/patch) 节奏
```

- [ ] **Step 3: poll 调用传 signal（`bot.ts:1567`）**

```typescript
    const rendezvousResult = await RendezvousClient.pollStateJsonStreaming({
      short,
      stateJsonPath: eligibility.stateJsonPath!,
      timeoutMs,
+     signal: ac.signal,
      // ... onPoll 不变 ...
    });
```

- [ ] **Step 4: 失败分支加 `aborted` case（`bot.ts:1688-1711`）**

```typescript
    } else {
      if (
        rendezvousResult.reason === 'socket_closed' ||
        rendezvousResult.reason === 'daemon_error'
      ) {
        logger.warn(`rendezvous: reason=${rendezvousResult.reason} → falling back to v2.3.5`);
+       this.activeRendezvousWaits.delete(openId);
+       this.rendezvousCardUpdaters.delete(openId);
        return { handled: false, bgAskedNewQuestion: false, cardMessageId: null };
      }
+     if (rendezvousResult.reason === 'aborted') {
+       // 用户点 [🔙 不等了] 或 [🛑 停 bg] 触发的 abort。终态卡 + user-mapping
+       // 恢复已由 handler 完成, 这里 log + 走收尾, 不发额外的 error 卡覆盖 handler 内容。
+       logger.info(`rendezvous: aborted by user action (openId=${openId})`);
+     } else {
        try {
          const errMsg = rendezvousResult.reason === 'timeout'
            ? `⏱ bg 处理超时（${Math.round(timeoutMs / 1000)}s 内未完成）`
            : `❌ Reply 失败：${rendezvousResult.reason}`;
          await cardUpdater.error(errMsg);
        } catch (err: any) {
          logger.warn(`rendezvous: cardUpdater.error 失败: ${err?.message ?? err}`);
        }
        logger.error(`rendezvous: inject failed reason=${rendezvousResult.reason} (no fallback)`);
+     }
    }
```

- [ ] **Step 5: 终态块清 maps（`bot.ts:1717` cancelPending 之前）**

```typescript
+   // 清 rendezvous tracking maps (idempotent — handler 可能已清, deleted-twice 安全)
+   this.activeRendezvousWaits.delete(openId);
+   this.rendezvousCardUpdaters.delete(openId);
    cardUpdater.cancelPending();
```

- [ ] **Step 6: typecheck + 跑 rendezvous 相关测试 + commit**

```bash
bun run typecheck
bun test tests/unit/agent-view/rendezvous-client.test.ts
git add src/feishu/bot.ts
git commit -m "feat(bot): wire AbortController into runStreamingRendezvousReply + capture attachedAt"
```

---

### Task 4.3: `handleRendezvousAbortWait` handler（TDD）— 条件化恢复 user-mapping

**Files:** `src/feishu/bot.ts` (新方法 在 `runStreamingRendezvousReply` 附近); Test: `tests/unit/feishu/bot-cardaction.test.ts`

**关键：handler 必须做 5 件事**
1. **race 守门**：先查 `updater.getState()`，若已是 `complete`/`error`/`cancelled`，说明 bg 已先收尾，用户点 [🔙 不等了] 晚了 → 直接 no-op return，不覆盖终态卡
2. 调 `controller.abort()` 打断 poll loop
3. patch 卡到 `🔙 已停止跟踪` 终态（用新 `patchAbortedTracking`）
4. **条件化恢复 user-mapping**：
   - 如果 `attachedAt` undefined（from-Reply）：`{type: 'session', sessionUuid, cwd}` 不带 attachedAt
   - 如果 `attachedAt` 有值（from-Attach）：`{type: 'session', sessionUuid, cwd, attachedAt}` 保留原 attachedAt
5. 清两个 maps

- [ ] **Step 1: 写失败测试（同时覆盖 from-Reply / from-Attach / race 守门三条路径）**

```typescript
import { mock } from 'bun:test';

describe('handleRendezvousAbortWait', () => {
  test('from-Reply: aborts, restores user-mapping WITHOUT attachedAt, patches card', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    let aborted = false;
    ac.signal.addEventListener('abort', () => { aborted = true; });
    const mockUpdater: any = {
      // 守门要求 getState() 返回非终态, 默认 'processing' (CardUpdater initial)
      getState: mock(() => 'processing'),
      patchAbortedTracking: mock(async () => {}),
      cancelPending: mock(() => {}),
    };
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,  // from-Reply
    });
    (bot as any).rendezvousCardUpdaters.set('o1', mockUpdater);
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (oid: string, old: any, nv: any) => {
      cas.push({ old, nv }); return true;
    });

    await (bot as any).handleRendezvousAbortWait('o1');

    expect(aborted).toBe(true);
    expect(mockUpdater.patchAbortedTracking.mock.calls).toHaveLength(1);
    expect((bot as any).activeRendezvousWaits.has('o1')).toBe(false);
    expect(cas).toHaveLength(1);
    expect(cas[0].nv).toEqual(expect.objectContaining({
      type: 'session', sessionUuid: 'u-aaa', cwd: '/p',
    }));
    expect(cas[0].nv.attachedAt).toBeUndefined();  // ← 不带 attachedAt
    expect(cas[0].nv.createdAt).toBeUndefined();  // ← review 缺口 3: 不写 createdAt
  });

  test('from-Attach: aborts, restores user-mapping WITH attachedAt preserved', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    const mockUpdater: any = {
      getState: mock(() => 'processing'),
      patchAbortedTracking: mock(async () => {}),
      cancelPending: mock(() => {}),
    };
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p',
      attachedAt: '2026-06-13T10:00:00.000Z',  // from-Attach
    });
    (bot as any).rendezvousCardUpdaters.set('o1', mockUpdater);
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (oid: string, old: any, nv: any) => {
      cas.push(nv); return true;
    });

    await (bot as any).handleRendezvousAbortWait('o1');

    expect(cas[0].attachedAt).toBe('2026-06-13T10:00:00.000Z');  // ← 保留 attachedAt
  });

  test('race guard: bg already complete (updater.getState()===complete) → no-op', async () => {
    // review 缺口 2: bg 恰好在用户点 [🔙 不等了] 之前完成, 终态卡已 patch 成 "✅ 处理完成"。
    // handler 必须识别这个 race, 不能 abort + patch 覆盖成 "🔙 已停止跟踪"。
    const bot = makeBot();
    const ac = new AbortController();
    let aborted = false;
    ac.signal.addEventListener('abort', () => { aborted = true; });
    const mockUpdater: any = {
      // 关键: getState() 返回 'complete', 模拟 bg 已收尾
      getState: mock(() => 'complete'),
      patchAbortedTracking: mock(async () => {}),
      cancelPending: mock(() => {}),
    };
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
    });
    (bot as any).rendezvousCardUpdaters.set('o1', mockUpdater);
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (oid: string, _old: any, nv: any) => {
      cas.push(nv); return true;
    });

    const r = await (bot as any).handleRendezvousAbortWait('o1');

    expect(r).toBeNull();
    expect(aborted).toBe(false);  // ← 不 abort (bg 已走完)
    expect(mockUpdater.patchAbortedTracking.mock.calls).toHaveLength(0);  // ← 不覆盖终态卡
    expect(cas).toHaveLength(0);  // ← 不动 user-mapping
    expect((bot as any).activeRendezvousWaits.has('o1')).toBe(true);  // ← 让终态块自己清
  });

  test('idempotent: no-op when openId not in map', async () => {
    const bot = makeBot();
    const r = await (bot as any).handleRendezvousAbortWait('o-none');
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试 fail**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts -t "handleRendezvousAbortWait"
```

- [ ] **Step 3: 实现**

```typescript
// src/feishu/bot.ts — 在 runStreamingRendezvousReply 附近
/**
 * [🔙 不等了] 按钮处理：
 *   1) **race 守门**: 如果 CardUpdater 已处于终态 (complete/error/cancelled),
 *      用户点 [🔙 不等了] 已晚于 bg 收尾, 不要覆盖终态卡(否则会从 "✅ 处理完成"
 *      被覆盖成 "🔙 已停止跟踪", 误导)。直接 no-op 返回。
 *   2) abort rendezvous poll 循环
 *   3) patch 流式卡到 "🔙 已停止跟踪" 终态 (patchAbortedTracking, 不用 cancel)
 *   4) **条件化恢复 user-mapping**:
 *      - from-Reply (entry.attachedAt undefined): 恢复 plain session entry
 *      - from-Attach (entry.attachedAt 有值): 恢复时保留 attachedAt, 后续仍走 rendezvous
 *   5) 清 maps
 *
 * Idempotent: 重复点 / map 没条目时 no-op
 */
private async handleRendezvousAbortWait(openId: string): Promise<string | null> {
  const entry = this.activeRendezvousWaits.get(openId);
  if (!entry) {
    logger.info(`handleRendezvousAbortWait: no active wait for openId=${openId}`);
    return null;
  }
  // v2.x race 守门 (review 缺口 2): 如果 CardUpdater 已处于终态, 用户点 [🔙 不等了]
  // 已晚于 bg 收尾, 不要覆盖终态卡。"活 < 1.5s (throttle 窗口)" race:
  //   - 用户点 → 飞书 click 入服务端队列
  //   - bg 恰好完成 → 终态 patch 已把 "✅ 处理完成" 写上去
  //   - 旧 buttons 已下卡, 但 click event 还在服务端队列
  //   - handler 跑 → 看到 entry 还在 map (终态块还没清), updater.getState() === 'complete'
  //   - 不 abort, 不 patch, 直接 return null
  const earlyUpdater = this.rendezvousCardUpdaters.get(openId);
  if (earlyUpdater) {
    const earlyState = earlyUpdater.getState();
    if (earlyState === 'complete' || earlyState === 'error' || earlyState === 'cancelled') {
      logger.info(
        `handleRendezvousAbortWait: skipped (terminal state=${earlyState}, openId=${openId}, ` +
        `bg 已先收尾, 不覆盖终态卡)`,
      );
      // 不清 maps — 让 runStreamingRendezvousReply 终态块自己清 (idempotent)
      return null;
    }
  }
  entry.abort.abort();
  const updater = this.rendezvousCardUpdaters.get(openId);
  this.activeRendezvousWaits.delete(openId);
  this.rendezvousCardUpdaters.delete(openId);

  // 恢复 user-mapping (条件化)
  try {
    const current = this.userManager.getEntry(openId);
    const newEntry: any = {
      type: 'session' as const,
      sessionUuid: entry.sessionUuid,
      cwd: entry.cwd,
      // MappingEntry 无 createdAt 字段 (review 缺口 3), 不写
    };
    if (entry.attachedAt) {
      // from-Attach: 保留原 attachedAt, 让用户下次发消息仍走 rendezvous
      newEntry.attachedAt = entry.attachedAt;
    }
    const ok = await this.userManager.compareAndSwap(openId, current, newEntry);
    if (!ok) {
      logger.warn(`handleRendezvousAbortWait: user-mapping CAS failed for ${openId} (stale, harmless)`);
    }
  } catch (err: any) {
    logger.warn(`handleRendezvousAbortWait: restore user-mapping failed: ${err?.message ?? err}`);
  }

  if (updater) {
    try {
      await updater.patchAbortedTracking({
        headerTitle: '🔙 已停止跟踪',
        headerTemplate: 'grey',
        body: entry.attachedAt
          ? 'bg 仍在 daemon 中运行 · 已保留 Attach 状态, 下条消息仍走 rendezvous · /agents 可查看'
          : 'bg 仍在 daemon 中运行 · /agents 可查看后续 · 直接发消息会触发 bg-conflict 确认',
      });
      updater.cancelPending();
    } catch (err: any) {
      logger.warn(`handleRendezvousAbortWait: patch failed: ${err?.message ?? err}`);
    }
  }
  logger.info(`handleRendezvousAbortWait: aborted (openId=${openId}, attached=${!!entry.attachedAt})`);
  return null;
}
```

- [ ] **Step 4: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts
git add src/feishu/bot.ts tests/unit/feishu/bot-cardaction.test.ts
git commit -m "feat(bot): handle rendezvous abort-wait with conditional user-mapping restore"
```

---

### Task 4.4: `handleRendezvousStopBgRequest` handler — 发确认卡（TDD）

**Files:** `src/feishu/bot.ts` (新方法); Test: `tests/unit/feishu/bot-cardaction.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe('handleRendezvousStopBgRequest', () => {
  test('sends confirm card, no abort, no map changes, no user-mapping touch', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u', cwd: '/', attachedAt: undefined,
    });
    const sent: string[] = [];
    (bot as any).cardReplyFn = mock(async (c: string) => { sent.push(c); return 'mid'; });

    await (bot as any).handleRendezvousStopBgRequest('o1', 'abc12345');

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.header.title.content).toContain('abc12345');
    expect(parsed.header.template).toBe('red');
    expect((bot as any).activeRendezvousWaits.has('o1')).toBe(true);  // 未动
    expect(ac.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试 fail + 实现**

```typescript
// src/feishu/bot.ts
/**
 * [🛑 停 bg] 按钮 Step A：弹二次确认卡。
 * 不 abort、不杀 bg、不动 maps、不动 user-mapping —— 用户在确认卡上点
 * [✅ 确认停止 bg] 才真执行 (handleRendezvousStopBgConfirm)。
 */
private async handleRendezvousStopBgRequest(
  openId: string,
  shortId: string,
): Promise<string | null> {
  const { buildRendezvousStopConfirmCard } = await import('../agent-view/card');
  const cardStr = buildRendezvousStopConfirmCard(shortId);
  await this.cardReplyFn(cardStr, { openId });
  return null;
}
```

- [ ] **Step 3: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts
git add src/feishu/bot.ts tests/unit/feishu/bot-cardaction.test.ts
git commit -m "feat(bot): handle rendezvous stop-bg request (Step A confirm card)"
```

---

### Task 4.5: `handleRendezvousStopBgConfirm` handler — 执行 stop + race + 条件化恢复（TDD）

**Files:** `src/feishu/bot.ts` (新方法); Test: `tests/unit/feishu/bot-cardaction.test.ts`

**关键**：与 Task 4.3 一样，**必须条件化保留 attachedAt**。4 个 race 场景全覆盖（包括 review 缺口 2 的窄 race window）。

- [ ] **Step 1: 写失败测试（4 场景 + from-Attach 保留 attachedAt 覆盖）**

```typescript
describe('handleRendezvousStopBgConfirm', () => {
  test('aborts + claude stop + patches card + restores user-mapping (from-Attach preserves attachedAt)', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    let aborted = false;
    ac.signal.addEventListener('abort', () => { aborted = true; });
    const mockUpdater: any = {
      getState: mock(() => 'processing'),  // 守门要求: 非终态
      patchAbortedTracking: mock(async () => {}),
      cancelPending: mock(() => {}),
    };
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p',
      attachedAt: '2026-06-13T10:00:00.000Z',  // from-Attach
    });
    (bot as any).rendezvousCardUpdaters.set('o1', mockUpdater);
    // mock execFile: 见项目现有 mock 风格 (bot-cardaction.test.ts 已有 mock setup 参考)
    const replies: string[] = [];
    (bot as any).replyFn = mock(async (t: string) => { replies.push(t); });
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (_oid: string, _old: any, nv: any) => {
      cas.push(nv); return true;
    });

    await (bot as any).handleRendezvousStopBgConfirm('o1', 'abc12345');

    expect(aborted).toBe(true);
    expect(mockUpdater.patchAbortedTracking.mock.calls).toHaveLength(1);
    expect(replies[0]).toContain('已停止');
    expect((bot as any).activeRendezvousWaits.has('o1')).toBe(false);
    expect(cas).toHaveLength(1);
    expect(cas[0]).toEqual(expect.objectContaining({
      type: 'session', sessionUuid: 'u-aaa', cwd: '/p',
      attachedAt: '2026-06-13T10:00:00.000Z',  // ← 保留
    }));
    expect(cas[0].createdAt).toBeUndefined();  // ← review 缺口 3: 不写 createdAt
  });

  test('from-Reply: restores user-mapping WITHOUT attachedAt', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
    });
    (bot as any).rendezvousCardUpdaters.set('o1', {
      patchAbortedTracking: mock(async () => {}), cancelPending: mock(() => {}),
    });
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (_oid: string, _old: any, nv: any) => {
      cas.push(nv); return true;
    });
    (bot as any).replyFn = mock(async () => {});

    await (bot as any).handleRendezvousStopBgConfirm('o1', 'abc12345');

    expect(cas[0].attachedAt).toBeUndefined();
  });

  test('race: bg already completed (no entry) → 自然完成 reply, no execFile', async () => {
    const bot = makeBot();
    const replies: string[] = [];
    (bot as any).replyFn = mock(async (t: string) => { replies.push(t); });
    await (bot as any).handleRendezvousStopBgConfirm('o1', 'abc12345');
    expect(replies[0]).toContain('已自然完成');
  });

  test('race guard 2 (review 缺口 2): entry 还在 map 但 updater.getState()===complete → 不调 claude stop, 走"已自然完成"', async () => {
    // 窄 race window: bg 恰好在用户点 [✅ 确认] 之前的瞬间刚完成, 终态块还没清 maps
    // (activeRendezvousWaits 仍有 entry, 但 updater 已 patch 成 "✅ 处理完成")。
    // handler 必须识别这个 race, 不能调 claude stop 也不覆盖终态卡。
    const bot = makeBot();
    const ac = new AbortController();
    let aborted = false;
    ac.signal.addEventListener('abort', () => { aborted = true; });
    const mockUpdater: any = {
      getState: mock(() => 'complete'),  // 关键: 终态已设
      patchAbortedTracking: mock(async () => {}),
      cancelPending: mock(() => {}),
    };
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u-aaa', cwd: '/p', attachedAt: undefined,
    });
    (bot as any).rendezvousCardUpdaters.set('o1', mockUpdater);
    const replies: string[] = [];
    (bot as any).replyFn = mock(async (t: string) => { replies.push(t); });
    const cas: any[] = [];
    (bot as any).userManager.compareAndSwap = mock(async (_oid: string, _old: any, nv: any) => {
      cas.push(nv); return true;
    });

    await (bot as any).handleRendezvousStopBgConfirm('o1', 'abc12345');

    expect(aborted).toBe(false);  // ← 不 abort
    expect(mockUpdater.patchAbortedTracking.mock.calls).toHaveLength(0);  // ← 不覆盖终态卡
    expect(cas).toHaveLength(0);  // ← 不动 user-mapping
    expect(replies[0]).toContain('已自然完成');  // ← 走"已自然完成"分支
    expect((bot as any).activeRendezvousWaits.has('o1')).toBe(false);  // ← 还是要清 maps
  });

  test('graceful: "No job matching" stderr treated as success', async () => {
    // mock execFile 抛 stderr 含 "No job matching"
    // 断言 replyFn 文案非 "失败"
  });
});
```

- [ ] **Step 2: 跑测试 fail + 实现**

```typescript
// src/feishu/bot.ts
/**
 * [🛑 停 bg] Step B: 真执行 claude stop + abort wait + 条件化恢复 user-mapping。
 *
 * Race 1: 用户点 [停 bg] → 确认卡发出 → 期间 bg 自然完成 (state=done) → poll 退出 →
 * runStreamingRendezvousReply 终态块已清 activeRendezvousWaits → 用户再点
 * [✅ 确认] 进入此函数时 get() 返 undefined → 走"已自然完成"分支, 不杀 bg。
 *
 * Race 2 (review 缺口 2): bg 在用户点 [✅ 确认] 之前的瞬间刚完成 → handler 进入时
 * entry 还在 map (终态块还没清), 但 updater.getState() === 'complete'。此时不调
 * claude stop (bg 已死了, 调了也是 "No job matching" 兜底), 走"已自然完成"分支。
 *
 * "No job matching" stderr 同 manager.ts:handleStopConfirm — 视为成功。
 */
private async handleRendezvousStopBgConfirm(
  openId: string,
  shortId: string,
): Promise<string | null> {
  const entry = this.activeRendezvousWaits.get(openId);
  if (!entry) {
    await this.replyFn(`✅ \`${shortId}\` 已自然完成，无需停止`, { openId });
    return null;
  }
  // v2.x race 守门 2 (review 缺口 2): bg 在用户点 [✅ 确认] 之前已收尾,
  // 但终态块还没清 maps。检查 CardUpdater 状态避免重复 stop + 覆盖终态卡。
  const earlyUpdater = this.rendezvousCardUpdaters.get(openId);
  if (earlyUpdater) {
    const earlyState = earlyUpdater.getState();
    if (earlyState === 'complete' || earlyState === 'error' || earlyState === 'cancelled') {
      logger.info(
        `handleRendezvousStopBgConfirm: skipped claude stop (terminal state=${earlyState}, ` +
        `openId=${openId}, bg 已先收尾)`,
      );
      this.activeRendezvousWaits.delete(openId);
      this.rendezvousCardUpdaters.delete(openId);
      await this.replyFn(`✅ \`${shortId}\` 已自然完成，无需停止`, { openId });
      return null;
    }
  }
  entry.abort.abort();
  const updater = this.rendezvousCardUpdaters.get(openId);
  this.activeRendezvousWaits.delete(openId);
  this.rendezvousCardUpdaters.delete(openId);

  try {
    const cp = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileP = promisify(cp.execFile);
    try {
      await execFileP('claude', ['stop', shortId], { timeout: 5000 });
    } catch (err: any) {
      const msg = err?.stderr || err?.message || String(err);
      if (!/No job matching/i.test(msg)) throw err;
    }
    await new Promise(r => setTimeout(r, 1000));  // 等 supervisor cleanup

    // 条件化恢复 user-mapping
    try {
      const current = this.userManager.getEntry(openId);
      const newEntry: any = {
        type: 'session' as const,
        sessionUuid: entry.sessionUuid,
        cwd: entry.cwd,
        // MappingEntry 无 createdAt 字段 (review 缺口 3), 不写
      };
      if (entry.attachedAt) newEntry.attachedAt = entry.attachedAt;
      await this.userManager.compareAndSwap(openId, current, newEntry);
    } catch (e: any) {
      logger.warn(`handleRendezvousStopBgConfirm: restore user-mapping failed: ${e?.message ?? e}`);
    }

    await this.replyFn(`✅ 已停止 ${shortId}`, { openId });
    if (updater) {
      try {
        await updater.patchAbortedTracking({
          headerTitle: '🛑 bg 已被终止',
          headerTemplate: 'grey',
          body: `\`${shortId}\` 已停止 · /agents 查看 session 状态`,
        });
        updater.cancelPending();
      } catch (e: any) {
        logger.warn(`handleRendezvousStopBgConfirm: patch failed: ${e?.message ?? e}`);
      }
    }
  } catch (err: any) {
    await this.replyFn(`❌ Stop bg 失败: ${err?.message ?? err}`, { openId });
    if (updater) {
      try { await updater.error(`❌ Stop bg 失败: ${err?.message ?? err}`); } catch { /* swallow */ }
    }
  }
  return null;
}
```

- [ ] **Step 3: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts
git add src/feishu/bot.ts tests/unit/feishu/bot-cardaction.test.ts
git commit -m "feat(bot): handle rendezvous stop-bg confirm with race + conditional restore"
```

---

### Task 4.6: 派发 3 个新 tag

**Important:** 三个 tag 都以 `agent_view_rendezvous_` 开头 → 满足 `isAgentViewValue` 的 `v.tag.startsWith('agent_view_')` 检查 → **走 agent_view switch (`bot.ts:541-593`)**。但 handler 在 `FeishuBot` 上（不是 `AgentViewManager`），所以 case 里调 `this.handleXxx(...)` 而非 `this.agentView.handleXxx(...)`。

**Files:** `src/feishu/bot.ts:541-593`

- [ ] **Step 1: 加 3 个 case（`default` 之前，约 `bot.ts:590`）**

```typescript
        case 'agent_view_stop_watching':
          await this.agentView.handleStopWatching(openId);
          return null;
+       case 'agent_view_rendezvous_abort_wait':
+         // tag 在 agent_view_ 命名空间, 但 handler 在 FeishuBot 上 (需访问 activeRendezvousWaits/userManager)
+         return await this.handleRendezvousAbortWait(openId);
+       case 'agent_view_rendezvous_stop_bg_request':
+         return await this.handleRendezvousStopBgRequest(openId, valueObj.shortId);
+       case 'agent_view_rendezvous_stop_bg_confirm':
+         return await this.handleRendezvousStopBgConfirm(openId, valueObj.shortId);
        default:
          return null;
      }
```

- [ ] **Step 2: typecheck + 跑全套相关测试 + commit**

```bash
bun run typecheck
bun test tests/unit/feishu/bot-cardaction.test.ts tests/unit/agent-view/
git add src/feishu/bot.ts
git commit -m "feat(bot): dispatch rendezvous abort/stop tags via agent_view switch"
```

---

## Cluster 5 — 集成验证 + 补充测试

### Task 5.1: 端到端 dispatch routing 测试

**File:** `tests/unit/feishu/bot-cardaction.test.ts`

- [ ] **Step 1: 模拟完整 card action event → handleCardAction → handler**

```typescript
describe('handleCardAction routing — rendezvous tags', () => {
  test('agent_view_rendezvous_abort_wait routes to handler', async () => {
    const bot = makeBot();
    const ac = new AbortController();
    (bot as any).activeRendezvousWaits.set('o1', {
      abort: ac, sessionUuid: 'u', cwd: '/', attachedAt: undefined,
    });
    (bot as any).rendezvousCardUpdaters.set('o1', {
      patchAbortedTracking: mock(async () => {}), cancelPending: mock(() => {}),
    });
    (bot as any).userManager.compareAndSwap = mock(async () => true);

    await bot.handleCardAction({
      open_id: 'o1',
      action: { value: { tag: 'agent_view_rendezvous_abort_wait' } },
      message: { message_id: 'mid' },
    } as any);

    expect(ac.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts -t "routing"
git commit -m "test(bot): integration test for rendezvous tag dispatch"
```

---

### Task 5.2: `aborted` reason 不发 error 卡测试

**File:** `tests/unit/feishu/bot-cardaction.test.ts` 或 `bot-runsdk.test.ts`

- [ ] **Step 1: 模拟 pollStateJsonStreaming 返 aborted reason → 验证 cardUpdater.error 不被调**

```typescript
test('aborted reason skips cardUpdater.error patch', async () => {
  // 沿用 bot-runsdk.test.ts 测 runChatSDK 的 mock 风格
  // 关键断言: cardUpdater.error.mock.calls.length === 0 when reason === 'aborted'
});
```

- [ ] **Step 2: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-cardaction.test.ts -t "aborted"
git commit -m "test(bot): aborted rendezvous reason does not patch error card"
```

---

### Task 5.3: shutdown 清理测试

**File:** `tests/unit/feishu/bot.test.ts` 或 `bot-production-wiring.test.ts`

- [ ] **Step 1: 写测试**

```typescript
test('shutdown aborts all in-flight rendezvous waits + clears maps', async () => {
  const bot = makeBot();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  (bot as any).activeRendezvousWaits.set('o1', { abort: ac1, sessionUuid: 'u1', cwd: '/a', attachedAt: undefined });
  (bot as any).activeRendezvousWaits.set('o2', { abort: ac2, sessionUuid: 'u2', cwd: '/b', attachedAt: '2026-06-13T00:00:00Z' });
  (bot as any).rendezvousCardUpdaters.set('o1', {});
  (bot as any).rendezvousCardUpdaters.set('o2', {});

  await bot.shutdown();

  expect(ac1.signal.aborted).toBe(true);
  expect(ac2.signal.aborted).toBe(true);
  expect((bot as any).activeRendezvousWaits.size).toBe(0);
  expect((bot as any).rendezvousCardUpdaters.size).toBe(0);
});
```

- [ ] **Step 2: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot.test.ts -t "shutdown"
git commit -m "test(bot): shutdown aborts active rendezvous waits"
```

---

### Task 5.4: From-Attach 路径 attachedAt 保留 + 后续 chat 仍走 rendezvous 测试

**File:** `tests/unit/feishu/bot-handlechat-routing.test.ts`

- [ ] **Step 1: 测试 abort 后用户再发消息仍命中 attached chat 入口**

```typescript
test('from-Attach: after abort, attachedAt preserved → next chat still routes to rendezvous', async () => {
  const bot = makeBot();
  // 1. 模拟 from-Attach rendezvous + abort
  (bot as any).userManager.compareAndSwap('o1', null, {
    type: 'session', sessionUuid: 'u-aaa', cwd: '/p',
    attachedAt: '2026-06-13T10:00:00Z', createdAt: '2026-06-13T10:00:00Z',
  });
  const ac = new AbortController();
  (bot as any).activeRendezvousWaits.set('o1', {
    abort: ac, sessionUuid: 'u-aaa', cwd: '/p',
    attachedAt: '2026-06-13T10:00:00Z',
  });
  (bot as any).rendezvousCardUpdaters.set('o1', {
    patchAbortedTracking: mock(async () => {}), cancelPending: mock(() => {}),
  });
  // 2. abort
  await (bot as any).handleRendezvousAbortWait('o1');

  // 3. 检查 user-mapping 仍带 attachedAt
  const entry = (bot as any).userManager.getEntry('o1');
  expect(entry.type).toBe('session');
  expect(entry.attachedAt).toBe('2026-06-13T10:00:00Z');

  // 4. 模拟用户发新消息进 handleChat — 应命中 attached chat block (bot.ts:1041)
  // (具体 mock 按 bot-handlechat-routing.test.ts 现有 setup 调整)
});
```

- [ ] **Step 2: 跑测试 pass + commit**

```bash
bun test tests/unit/feishu/bot-handlechat-routing.test.ts -t "from-Attach"
git commit -m "test(bot): from-Attach abort preserves attachedAt for next chat"
```

---

### Task 5.5: 全套测试 + typecheck

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun test` — All pass, no regression
- [ ] `bun test --coverage` (可选) — 新增代码 ≥ 80% line coverage

---

### Task 5.6: 手动 E2E 验证清单（提 PR 前自测）

部署 dev 后逐项跑：

**Reply 路径**
- [ ] /agents Attach → bg 进 waiting → [↩️ 回复] → 输入长 prompt → 看到 🔵 卡 + **[🔙 不等了] + [🛑 停 bg]** 双按钮
- [ ] 流式 ~1.5s 刷新一次（验证 throttle）
- [ ] ≥ 2 分钟不出超时错误卡（验证 2h timeout）
- [ ] 点 [🔙 不等了] → 卡 patch 为 **"🔙 已停止跟踪"** + body 提到 bg-conflict（不含 "随时发送" 后缀）→ /agents 看到 session 仍 busy
- [ ] 紧接着发新消息 → 走 **bg-conflict 3 按钮卡**（验证 from-Reply 路径恢复成 plain session entry）

**Attach 路径**
- [ ] /agents Attach（不点 Reply）→ 直接发文字 → 触发 attached chat → 看到 🔵 卡 + 双按钮
- [ ] 点 [🔙 不等了] → 卡 patch 为 **"🔙 已停止跟踪 · 已保留 Attach 状态"**
- [ ] 紧接着再发文字 → **仍命中 attached chat 入口**（rendezvous 卡，不是 bg-conflict）→ 验证 attachedAt 保留

**Stop bg 路径（两条都试）**
- [ ] [🛑 停 bg] → 弹红色确认卡 → [✅ 确认] → 收到 "✅ 已停止 \<short\>" → 卡 patch 为 "🛑 bg 已被终止" → /agents 看到 session 已结束
- [ ] [🛑 停 bg] → 确认期间 bg 自然完成 → [✅ 确认] → 收到 "✅ \<short\> 已自然完成，无需停止"

**普通 SDK chat（验证未回退）**
- [ ] /switch 后直接发消息（非 attach）→ 流式卡仍是**单按钮 [🛑 停止处理]** → 点了正常杀 SDK 进程 → 卡 "✅ 已停止"

**LiveProgress**
- [ ] /list → "🔄 处理中" 卡每 ~3s 刷新一次

---

### Task 5.7: 提 PR

```bash
git push origin <branch>
gh pr create --base master \
  --title "feat(rendezvous): 2h timeout + dual-button abort UX (Reply + Attach paths)" \
  --body "..."
```

PR 描述写明：(1) 60s→2h 动机；(2) 双按钮设计 + 两条路径条件化恢复 user-mapping；(3) Task 5.6 手动验证已过。

---

## 关键风险点（执行工人务必读）

1. **`setRendezvousShortId` 时序**：必须在 `cardUpdater.startProcessing(openId)` **之前**。原因：startProcessing 内部立即调 buildProcessingCard → buildStreamingCard，首次渲染就需要 shortId。错序会让 [🛑 停 bg] 按钮 value.shortId 为空串。

2. **`activeRendezvousWaits` value 必须含 `attachedAt`**（v1/v2 plan 漏掉的核心 bug）。区分 from-Reply / from-Attach 入口，handler 恢复 user-mapping 时条件化保留 attachedAt — 否则 from-Attach 用户 abort 后下次发消息会降级到 busy-check，Attach 语义丢。

3. **abort 后必须恢复 user-mapping**（Task 4.3 + 4.5 都做）：
   - From-Reply: markSent 已清，必须恢复 plain session entry，否则用户被踢回"无活跃会话"
   - From-Attach: entry 未被清，但 handler 主动 set 覆盖，保留 attachedAt
   - 两种都用 `compareAndSwap(current, newEntry)` 防 race

4. **`reason: 'aborted'` 在 bot.ts:1688-1711 不发 error 卡**。终态由 handler 自己 patch。markReplied + markDone 在 :1717-1724 区域仍执行（不在 aborted 分支内）— spool 收尾不能漏。

5. **`patchAbortedTracking` 不复用 `cancel()`**。原因：`buildCancelledCard` 硬编码 header "🛑 已取消" + body 后缀 "你可以随时发送新消息继续对话"，跟 abort 语义冲突。

6. **dispatch case 位置**：三个新 tag 在 **agent_view switch**（bot.ts:541-593），不是 :604 那个非-agent_view switch。但 handler 在 FeishuBot 上（不是 AgentViewManager），所以 case 里调 `this.handleXxx(...)`。

7. **bun:test mock API**：用 `mock(async () => ...)` from `'bun:test'`，不是 `jest.fn()`。assertion 用 `.mock.calls[i][j]`。

8. **测试 import 风格**：`import { tmpdir } from 'os'`（项目约定，非 `'node:os'`）；mock 用 `import { mock } from 'bun:test'`。

9. **spool double-finalize 已验证 benign**：`spool.ts:582-617` `moveMessage` 源文件不存在时 silent return null。attached-chat 外层 + 内层各 markReplied/markDone 一次安全。

10. **cwd 字段穿透（已通过 Task 4.2 Step 0 解决）**：`RendezvousEligibility` 接口（`rendezvous-fallback.ts:12-23`）**没有 `cwd` 字段**，`runStreamingRendezvousReply` 签名（`bot.ts:1518-1525`）也没有。Task 4.2 Step 0 已显式把 `cwd` 沿调用链（`runChatSDK` → `tryRendezvousReply` → `runStreamingRendezvousReply`）穿透 3 个签名 + 2 个 call site。Task 4.2 Step 1 的 `activeRendezvousWaits.set` 直接用 params 透传下来的 `cwd`。**review 缺口 1 已闭环**。

---

## Self-Review

**1. Spec coverage:**
- ✓ 2h 超时 → Task 0.1
- ✓ LiveProgress tick 3s × 2667 → Task 0.2
- ✓ 流式卡节流统一 1.5s → Task 4.2 Step 1
- ✓ AbortSignal 支持 → Cluster 1
- ✓ 双按钮渲染 → Cluster 2 (Task 2.1)
- ✓ 自定义终态 patch → Cluster 2 (Task 2.2)
- ✓ 3 个 action tag + guard → Task 3.1
- ✓ 确认卡 builder → Task 3.2
- ✓ Map 含 attachedAt → Task 4.1
- ✓ **cwd 字段穿透**（review 缺口 1）→ Task 4.2 Step 0
- ✓ 3 个 handler **含条件化 user-mapping 恢复** → Cluster 4 (4.3, 4.5)
- ✓ **race 守门**（review 缺口 2：bg 已收尾时不覆盖终态卡）→ Cluster 4 (4.3, 4.5)
- ✓ **不写 createdAt**（review 缺口 3：MappingEntry 无此字段）→ Cluster 4 (4.3, 4.5)
- ✓ Race 处理 → Task 4.5
- ✓ Shutdown 清理 → Task 4.1 + Task 5.3 测试
- ✓ Dispatch routing test → Task 5.1
- ✓ aborted reason 不发 error → Task 5.2
- ✓ **From-Attach attachedAt 保留 + 后续 chat 仍走 rendezvous** → Task 5.4
- ✓ 旁注释更新 → Task 4.2 Step 2

**2. Placeholder scan:** 无 TODO/TBD。所有代码片段都给了具体 diff；mock 风格统一 bun:test。

**3. Type consistency:**
- `activeRendezvousWaits: Map<string, {abort, sessionUuid, cwd, attachedAt}>` — Task 4.1 declare → Task 4.2 set (四字段) → Task 4.3/4.5 get + 条件化 attachedAt → delete ✓
- `rendezvousCardUpdaters: Map<string, CardUpdater>` — 同上 ✓
- `buttonsMode: 'default' | 'rendezvous'` — Task 2.1 declare ✓
- `patchAbortedTracking({headerTitle, headerTemplate, body})` — Task 2.2 declare → Task 4.3/4.5 同签名调用 ✓
- 三个 tag 名字在 union / guard / builder / handler / dispatch 一致 ✓
- `setRendezvousShortId(short: string)` — Task 2.1 declare → Task 4.2 调，强调时序 ✓
- `attachedAt: string | undefined` 类型在 v2 map / handler / test 一致 ✓
