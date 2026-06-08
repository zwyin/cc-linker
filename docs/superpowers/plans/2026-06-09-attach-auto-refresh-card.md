# Attach 之后自动刷新内容卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach 成功后,飞书侧紧跟一条可交互的"会话内容卡",每 10s 自动 patch status + recentOutput,支持 idle 自然停、用户发文本停、点 [Stop Watching] 停、新 Attach 取代式停、25KB 智能截断保证 watch 永不停。

**Architecture:** 镜像 `LiveProgressWatcher`（`src/feishu/live-progress.ts`）的 setInterval / inFlightTick mutex / patchFailureCount / maxTicks 模式。新增 `AttachedCardWatcher`（单 openId 单卡）和 `AttachedWatchers`（manager 管理的 map），由 `AgentViewManager.handleAttach` 末尾触发。bot.ts `handleChat` 入口 hook 拦截用户文本、`handleCardAction` 派发新按钮、`shutdown()` 收尾。

**Tech Stack:** Bun / TypeScript / Feishu OpenAPI / AgentSnapshotFetcher（现有）/ extractRecentAssistantText（现有）/ LiveProgressWatcher 设计模式

**Spec:** `docs/superpowers/specs/2026-06-09-attach-auto-refresh-card-design.md` (commit 739cae1)

---

## File Structure

| 路径 | 责任 | 类型 |
|------|------|------|
| `src/agent-view/attached-card-watcher.ts` | `AttachedCardWatcher` 类 + `AttachedWatchers` 管理器 + `AttachedWatchConfig` + 默认值常量 | 新建 |
| `src/agent-view/card.ts` | `buildAttachedCard` 函数（含 25KB 智能截断） | 扩展 |
| `src/agent-view/action.ts` | `AgentViewValue` 联合加 `agent_view_stop_watching` tag | 扩展 |
| `src/agent-view/manager.ts` | 字段 `attachedWatchers`、构造、handleAttach 末尾发卡 + start watch、handleStopWatching 新方法 | 扩展 |
| `src/feishu/bot.ts` | `handleChat` 入口 hook（user_chat stop）、`handleCardAction` switch 新 case、`shutdown` 调 `attachedWatchers.stopAll()` | 扩展 |
| `tests/unit/agent-view/attached-card-watcher.test.ts` | `AttachedCardWatcher` + `AttachedWatchers` 全套单测 | 新建 |
| `tests/unit/agent-view/card.test.ts` | `buildAttachedCard` 渲染 + 25KB 智能截断测试 | 扩展 |
| `tests/unit/agent-view/manager.test.ts` | (保持不变,Task 7 改成新建 `manager-attached-watch.test.ts`) | - |
| `tests/unit/feishu/bot-cardaction-attached-watch.test.ts` | handleCardAction 'agent_view_stop_watching' dispatch 测试 | 新建 |
| `tests/unit/feishu/bot-handlechat-watch-stop.test.ts` | handleChat 入口 watch stop hook 测试 | 新建 |

**测试根路径**：`tests/unit/`（注意不是 `tests/`）— 实际仓库布局是 `tests/unit/agent-view/`。

---

# PR 1: Card Builder + Watcher + Manager 集成

## Task 1: 加 `agent_view_stop_watching` action tag

**Files:**
- Modify: `src/agent-view/action.ts:12-42`

- [ ] **Step 1: 在 `AgentViewValue` 联合末尾加新 tag**

打开 `src/agent-view/action.ts`,找到第 42 行 `| { tag: 'agent_view_bg_conflict_cancel' };`,在 `;` 前加:

```typescript
  | { tag: 'agent_view_stop_watching' };
```

- [ ] **Step 2: 验证 typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/agent-view/action.ts
git commit -m "feat(agent-view): 加 agent_view_stop_watching action tag"
```

---

## Task 2: 加 `buildAttachedCard` 渲染函数

**Files:**
- Modify: `src/agent-view/card.ts:1-10` (imports) 和末尾追加新函数
- Modify: `src/agent-view/card.ts:298-322` (buildErrorCard 是 `...TEMPLATE_HEADER` 模式的参考)

- [ ] **Step 1: 写测试** — 在 `tests/unit/agent-view/card.test.ts` **顶部**的 import 块加 `buildAttachedCard`:

打开 `tests/unit/agent-view/card.test.ts`,找到文件顶部 `import { ... } from '../../../src/agent-view/card';`,改为:

```typescript
import {
  buildListCard,
  buildPeekCard,
  buildErrorCard,
  buildEmptyCard,
  buildWaitingCard,
  buildStopConfirmCard,
  buildBgConflictCard,
  buildAttachedCard,  // 新增
} from '../../../src/agent-view/card';
```

然后**在文件末尾**追加:

```typescript
describe('buildAttachedCard', () => {
  const baseOpts = {
    name: 'sleep 30',
    status: 'busy' as const,
    shortId: 'abc12345',
    sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
    cwd: '/Users/wuyujun/Git/trae-data',
    recentOutput: '执行 sleep 30 中',
    outputFormat: 'markdown' as const,
    lastWatchedAt: '12:34:56',
  };

  test('renders header with name and Watching prefix', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    expect(card.header.title.content).toBe('📡 Watching · `sleep 30`');
    expect(card.header.template).toBe('blue');
    // 必须有 update_multi: true 避免飞书 merge 渲染
    expect(card.config.update_multi).toBe(true);
  });

  test('shows status line with cwd but hides pid/startedAt', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    const markdownTexts = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(markdownTexts).toContain('Status: 处理中 (busy)');
    expect(markdownTexts).toContain('CWD: ~/Git/trae-data');
    // 不应包含 Peek 卡的 PID / Started 字样
    expect(markdownTexts).not.toContain('PID:');
    expect(markdownTexts).not.toContain('Started');
  });

  test('waiting status shows waitingFor', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, status: 'waiting', waitingFor: 'input needed' }),
    );
    const text = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(text).toContain('等待原因: input needed');
  });

  test('waiting status hides waitingFor line when undefined', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, status: 'waiting' }));
    const text = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(text).not.toContain('等待原因:');
  });

  test('shows 4 buttons when status is busy: refresh / stop_watching / stop', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toContain('agent_view_refresh_peek');
    expect(tags).toContain('agent_view_stop_watching');
    expect(tags).toContain('agent_view_stop');
    expect(tags).not.toContain('agent_view_attach'); // 已 attach 不再显示
  });

  test('waiting status shows reply button (not stop)', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, status: 'waiting', waitingFor: 'input' }),
    );
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toContain('agent_view_reply_request');
    expect(tags).not.toContain('agent_view_stop');
  });

  test('idle status shows only refresh + stop_watching', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, status: 'idle' }));
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toEqual(
      expect.arrayContaining(['agent_view_refresh_peek', 'agent_view_stop_watching']),
    );
    expect(tags).not.toContain('agent_view_stop');
    expect(tags).not.toContain('agent_view_reply_request');
  });

  test('shows Last watched timestamp at end', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, lastWatchedAt: '23:59:59' }));
    const lastMarkdown = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .pop();
    expect(lastMarkdown.content).toBe('Last watched 23:59:59');
  });

  test('terminal outputFormat wraps in code-block with warning', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, outputFormat: 'terminal' }),
    );
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).toContain('原始终端片段');
    expect(recentBlock.content).toContain('```');
  });

  test('markdown outputFormat does not wrap in code-block', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, outputFormat: 'markdown' }),
    );
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).not.toContain('```');
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/card.test.ts -t buildAttachedCard`
Expected: FAIL, "buildAttachedCard is not exported from ...card"

- [ ] **Step 3: 实现 `buildAttachedCard` (基础版,不含截断)**

打开 `src/agent-view/card.ts`,在文件末尾追加:

```typescript
// src/agent-view/card.ts 末尾

/**
 * 内部渲染器:无截断,纯字符串拼接。Task 3 会在此基础上加截断 wrapper。
 * @internal
 */
function renderAttachedCardJson(opts: {
  name: string;
  status: AgentSessionStatus;
  completed?: boolean;
  waitingFor?: string;
  shortId: string;
  sessionId: string;
  cwd: string;
  recentOutput: string;
  outputFormat: 'markdown' | 'terminal';
  lastWatchedAt: string;
}): string {
  const statusLabel =
    opts.status === 'busy' ? '处理中'
    : opts.status === 'waiting' ? '等待输入'
    : opts.status === 'idle' ? (opts.completed ? '已完成' : '空闲')
    : '未知';

  const recentBlock =
    opts.outputFormat === 'terminal'
      ? `**Recent output** _(原始终端片段,可能含格式残留)_\n\`\`\`\n${opts.recentOutput}\n\`\`\``
      : `**Recent output**\n\n${opts.recentOutput}`;

  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `Status: ${statusLabel} (${opts.status})` +
        (opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : '') +
        `\nCWD: ${truncateCwd(opts.cwd)}`,
    },
    { tag: 'markdown', content: recentBlock },
    { tag: 'markdown', content: `Last watched ${opts.lastWatchedAt}` },
  ];

  const actions: any[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 Refresh' },
      value: {
        tag: 'agent_view_refresh_peek',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
      },
      type: 'default',
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🛑 Stop Watching' },
      value: { tag: 'agent_view_stop_watching' },
      type: 'default',
    },
  ];
  if (opts.status === 'waiting') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Reply' },
      value: {
        tag: 'agent_view_reply_request',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
      },
      type: 'primary',
    });
  }
  if (opts.status === 'busy') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Stop session' },
      value: {
        tag: 'agent_view_stop',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
        name: opts.name,
      },
      type: 'danger',
    });
  }
  elements.push({ tag: 'action', actions });

  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `📡 Watching · \`${opts.name}\`` },
      template: 'blue',
    },
    elements,
  });
}

/**
 * Attached 卡:Attach 成功后,bot 自动紧跟发的可交互卡 + 10s 自动 patch。
 *
 * 与 buildPeekCard 的差异:
 * - 移除 pid / startedAt(elapsed 由 "Last watched" 时间戳代替)
 * - 按钮组:[Refresh] [Stop Watching] [Reply] [Stop session](按 status 显隐)
 * - header title:`📡 Watching · \`name\``(蓝色)
 *
 * 25KB 截断在 Task 3 加 wrapper。
 */
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
  lastWatchedAt: string;
}): string {
  return renderAttachedCardJson(opts);
}
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/card.test.ts -t buildAttachedCard`
Expected: 10 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): buildAttachedCard 渲染函数 + 10 个测试"
```

---

## Task 3: 加 25KB 智能截断 helper

**Files:**
- Modify: `src/agent-view/card.ts` (在 buildAttachedCard 之后追加)
- Modify: `tests/unit/agent-view/card.test.ts` (追加测试)

- [ ] **Step 1: 写测试**

在 `tests/unit/agent-view/card.test.ts` 末尾追加:

```typescript
describe('buildAttachedCard 25KB smart truncation', () => {
  // 构造一个固定大小的 recentOutput,让 buildAttachedCard 序列化后超 25KB
  // recentOutput 占大头,所以我们用 massive content
  const bigOpts = {
    name: 'big',
    status: 'busy' as const,
    shortId: 'big12345',
    sessionId: 'big12345-9be0-4d5e-8b3f-1234567890ab',
    cwd: '/x',
    outputFormat: 'markdown' as const,
    lastWatchedAt: '00:00:00',
  };

  test('recentOutput under 2KB: card built without truncation', () => {
    const out = 'x'.repeat(1500); // < 2048
    const card = JSON.parse(buildAttachedCard({ ...bigOpts, recentOutput: out }));
    // 包含原始内容(没被截断到 1024)
    expect(card.elements.some((e: any) =>
      e.tag === 'markdown' && e.content.includes('x'.repeat(1500))
    )).toBe(true);
  });

  test('recentOutput over 25KB: progressive truncation brings it under 25KB', () => {
    const out = 'y'.repeat(30_000); // 远超 2KB,会触发截断链
    const cardJson = buildAttachedCard({ ...bigOpts, recentOutput: out });
    const card = JSON.parse(cardJson);
    const cardBytes = new TextEncoder().encode(cardJson).length;
    expect(cardBytes).toBeLessThanOrEqual(25_000);
    // 截断后内容必然少于 30_000(至少 256 字符)
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content.length).toBeLessThan(30_000);
  });

  test('extremely large recentOutput: falls back to warning message', () => {
    // 30KB 中文 + 控制字符,即使 256 截断都放不下整个 markdown wrapper 时
    // 走终极 fallback
    // 但实际上 256 字符的 markdown wrapper 远小于 25KB,这条主要防回归
    const out = 'z'.repeat(100_000);
    const card = JSON.parse(buildAttachedCard({ ...bigOpts, recentOutput: out }));
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    // 应有 截断标记 或 fallback
    const isTruncated = recentBlock.content.length < 100_000;
    expect(isTruncated).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/card.test.ts -t "buildAttachedCard 25KB"`
Expected: FAIL, "cardBytes expected to be <= 25000" 或类似

- [ ] **Step 3: 实现 25KB 智能截断 helper** (在 `renderAttachedCardJson` 之上,**关键:不调 buildAttachedCard,避免无限递归**)

打开 `src/agent-view/card.ts`,在 `renderAttachedCardJson` 函数定义**之上**追加:

```typescript
/** 25KB 卡片上限(同 MAX_CARD_BYTES in manager.ts) */
const MAX_ATTACH_CARD_BYTES = 25_000;
/** 智能截断的 recentOutput 字符预算档位 */
const ATTACH_RECENT_BUDGETS = [2048, 1024, 512, 256];

/**
 * 智能截断 recentOutput,保证最终卡片 ≤ 25KB。
 * 优先级:2048 → 1024 → 512 → 256 字符。每档调 renderAttachedCardJson + 测 bytes。
 * 全部超 25KB 时降级为警告文字。
 *
 * **关键:调 renderAttachedCardJson,不调 buildAttachedCard —— 后者会再调本函数,无限递归**
 * @internal
 */
function truncateRecentForCard(
  opts: Parameters<typeof renderAttachedCardJson>[0],
  rawRecentOutput: string,
): string {
  for (const budget of ATTACH_RECENT_BUDGETS) {
    const truncated =
      rawRecentOutput.length <= budget
        ? rawRecentOutput
        : rawRecentOutput.slice(0, budget);
    const cardJson = renderAttachedCardJson({ ...opts, recentOutput: truncated });
    if (new TextEncoder().encode(cardJson).length <= MAX_ATTACH_CARD_BYTES) {
      return truncated;
    }
  }
  return '⚠️ 内容过大, 请点 [Peek] 查看完整';
}
```

然后**改 `buildAttachedCard`** 让它走截断 wrapper。把:

```typescript
export function buildAttachedCard(opts: {...}): string {
  return renderAttachedCardJson(opts);
}
```

改为:

```typescript
export function buildAttachedCard(opts: {...}): string {
  const truncated = truncateRecentForCard(opts, opts.recentOutput);
  return renderAttachedCardJson({ ...opts, recentOutput: truncated });
}
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/card.test.ts -t "buildAttachedCard"`
Expected: 13 pass, 0 fail (10 渲染 + 3 截断)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): buildAttachedCard 25KB 智能截断"
```

---

## Task 4: 创建 `AttachedCardWatcher` skeleton + 生命周期测试

**Files:**
- Create: `src/agent-view/attached-card-watcher.ts`
- Create: `tests/unit/agent-view/attached-card-watcher.test.ts`

- [ ] **Step 1: 写测试文件**

创建 `tests/unit/agent-view/attached-card-watcher.test.ts`:

```typescript
// tests/unit/agent-view/attached-card-watcher.test.ts
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  AttachedCardWatcher,
  AttachedWatchers,
  DEFAULT_ATTACHED_WATCH_CONFIG,
} from '../../../src/agent-view/attached-card-watcher';

describe('DEFAULT_ATTACHED_WATCH_CONFIG', () => {
  test('default values match spec', () => {
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.intervalMs).toBe(10_000);
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxTicks).toBe(800);
    expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxPatchFailures).toBe(3);
  });
});

describe('AttachedCardWatcher lifecycle', () => {
  let patchFn: ReturnType<typeof mock>;
  let onStop: ReturnType<typeof mock>;
  let resolveContent: ReturnType<typeof mock>;

  beforeEach(() => {
    patchFn = mock(async () => ({}));
    onStop = mock();
    resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
  });

  afterEach(() => {
    // noop
  });

  test('start() initiates setInterval; stop() clears it', () => {
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    watcher.start();
    expect(onStop).not.toHaveBeenCalled();
    watcher.stop('test');
    expect(onStop).toHaveBeenCalledWith('ou_test', 'test', watcher);
  });

  test('stop() is idempotent', () => {
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    watcher.start();
    watcher.stop('first');
    watcher.stop('second');
    // onStop 只调一次
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts`
Expected: FAIL, "Cannot find module '../../../src/agent-view/attached-card-watcher'"

- [ ] **Step 3: 实现 skeleton**

创建 `src/agent-view/attached-card-watcher.ts`:

```typescript
// src/agent-view/attached-card-watcher.ts
/**
 * Attached Card Watcher — 镜像 LiveProgressWatcher (src/feishu/live-progress.ts)
 * 的 setInterval / inFlightTick / patchFailureCount 模式。
 *
 * 单一职责:每 intervalMs 调一次 tick(),拉最新 snapshot + recentOutput,
 * patch 飞书卡;达到停止条件(idle / user_chat / superseded / user_stop /
 * patch_failed / max_ticks)时清理 setInterval 并 onStop 回调。
 */
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/async';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { buildAttachedCard } from './card';
import type { FetchResult } from './snapshot-fetcher';

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

export interface AttachedWatchDeps {
  openId: string;
  sessionId: string;
  shortId: string;
  name: string;
  cwd: string;
  cardMessageId: string;
  patchFn: (messageId: string, card: string) => Promise<any>;
  config: AttachedWatchConfig;
  /**
   * 三层 JSONL 解析(tier 1 own / tier 2 parent / tier 3 claude logs 退化),
   * 由 manager 注入 this.resolvePeekContent 绑定。
   */
  resolveContent: (
    shortId: string,
    maxChars: number,
  ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>;
  onStop: (openId: string, reason: string, watcher: AttachedCardWatcher) => void;
}

export class AttachedCardWatcher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private patchFailureCount = 0;
  private stopped = false;
  private startedAt = Date.now();
  private inFlightTick: Promise<void> | null = null;

  constructor(private readonly deps: AttachedWatchDeps) {}

  start(): void {
    this.intervalHandle = setInterval(
      () => {
        // skip overlap, 同 live-progress.ts:115
        if (this.inFlightTick) return;
        this.inFlightTick = this.tick()
          .catch(err => logger.error(`AttachedCardWatcher tick error: ${err}`))
          .finally(() => {
            this.inFlightTick = null;
          });
      },
      this.deps.config.intervalMs,
    );
    logger.info(
      `AttachedCardWatcher start: openId=${this.deps.openId}, ` +
      `sessionId=${this.deps.sessionId}, cardMessageId=${this.deps.cardMessageId}, ` +
      `intervalMs=${this.deps.config.intervalMs}`,
    );
  }

  async stop(reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    logger.info(
      `AttachedCardWatcher stop: openId=${this.deps.openId}, ` +
      `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
    );
    this.deps.onStop(this.deps.openId, reason, this);
    // 等待 in-flight tick 完成(最多 5s, 避免 SIGTERM 截断 patchFn)
    if (this.inFlightTick) {
      await withTimeout(this.inFlightTick, 5000, undefined as void | undefined);
    }
  }

  // tick() 在 Task 5 实现
  async tick(): Promise<void> {
    // 占位,实际实现在 Task 5
  }
}

/**
 * AttachedWatchers 管理器(per AgentViewManager 实例一个)
 */
export class AttachedWatchers {
  private watchers = new Map<string, AttachedCardWatcher>();

  constructor(
    private readonly patchFn: (messageId: string, card: string) => Promise<any>,
    private readonly resolveContentFn: (
      shortId: string,
      maxChars: number,
    ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>,
    private readonly config: AttachedWatchConfig = DEFAULT_ATTACHED_WATCH_CONFIG,
  ) {}

  has(openId: string): boolean {
    return this.watchers.has(openId);
  }

  /**
   * 取代式启动:openId 已有旧 watcher 时静默 stop,再启新的。
   * cardMessageId 由调用方在调此方法前拿到(buildAttachedCard + cardReplyFn)。
   */
  async start(
    openId: string,
    opts: {
      sessionId: string;
      shortId: string;
      name: string;
      cwd: string;
      cardMessageId: string;
    },
  ): Promise<void> {
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
      // 双重清理:onStop 已 delete 一次(若 identity check 命中),这里再保险
      this.watchers.delete(openId);
    }
  }

  /** bot shutdown 时清空所有 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.values()].map(w => w.stop('shutdown')));
  }
}
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts`
Expected: 3 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/attached-card-watcher.ts tests/unit/agent-view/attached-card-watcher.test.ts
git commit -m "feat(agent-view): AttachedCardWatcher + AttachedWatchers skeleton + lifecycle tests"
```

---

## Task 5: 实现 `AttachedCardWatcher.tick()`

**Files:**
- Modify: `src/agent-view/attached-card-watcher.ts` (替换占位 tick)
- Modify: `tests/unit/agent-view/attached-card-watcher.test.ts` (加 tick 测试)

- [ ] **Step 1: 写测试**

在 `tests/unit/agent-view/attached-card-watcher.test.ts` 末尾追加:

```typescript
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

describe('AttachedCardWatcher.tick()', () => {
  let patchFn: ReturnType<typeof mock>;
  let onStop: ReturnType<typeof mock>;
  let resolveContent: ReturnType<typeof mock>;
  let fetchSpy: ReturnType<typeof spyOn>;

  const makeSession = (status: AgentSession['status'], completed = false): AgentSession => ({
    pid: 1234,
    cwd: '/tmp',
    kind: 'background',
    startedAt: Date.now() - 5000,
    sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
    name: 'test',
    status,
    source: 'slash',
    completed,
  });

  beforeEach(() => {
    patchFn = mock(async () => ({}));
    onStop = mock();
    resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
    fetchSpy = spyOn(AgentSnapshotFetcher, 'fetch');
  });

  test('happy path: snapshot busy + content -> patchFn called once', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('snapshot failure: skip patch, do not stop', async () => {
    fetchSpy.mockResolvedValue({ ok: false, reason: 'daemon not running' });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  test('session gone: patch final error card + stop', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('ou_test', 'session_gone', watcher);
  });

  test('session idle + completed: patch final + stop idle_settled', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', true)] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('ou_test', 'idle_settled', watcher);
  });

  test('session idle but NOT completed (active idle): keep watching', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('idle', false)] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('JSONL miss: recentOutput = "(无可用输出)" + patch 照常', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    resolveContent.mockResolvedValue({ text: null, format: 'markdown' });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    const card = JSON.parse(patchFn.mock.calls[0][1] as string);
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).toContain('无可用输出');
  });

  test('patchFn failure 1 time: patchFailureCount=1, no stop', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    patchFn.mockRejectedValue(new Error('network'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('patchFn failure 3 times: stop patch_failed', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    patchFn.mockRejectedValue(new Error('network'));
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50, maxPatchFailures: 3 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'patch_failed', watcher);
  });

  test('maxTicks reached: stop max_ticks', async () => {
    fetchSpy.mockResolvedValue({ ok: true, sessions: [makeSession('busy')] });
    const watcher = new AttachedCardWatcher({
      openId: 'ou_test',
      sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
      shortId: 'abc12345',
      name: 'test',
      cwd: '/tmp',
      cardMessageId: 'om_test',
      patchFn,
      config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50, maxTicks: 2 },
      resolveContent,
      onStop,
    });
    await watcher.tick();
    await watcher.tick();
    expect(onStop).toHaveBeenCalledWith('ou_test', 'max_ticks', watcher);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts -t "AttachedCardWatcher.tick"`
Expected: 9 FAIL, "tick() not implemented" or 0 patches called

- [ ] **Step 3: 实现 `tick()`**

打开 `src/agent-view/attached-card-watcher.ts`,找到 `// tick() 在 Task 5 实现` 注释,替换为:

```typescript
  async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // 1) snapshot
    const result: FetchResult = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      logger.warn(`AttachedCardWatcher tick snapshot failed: ${result.reason}`);
      return; // 不 patch, 不 stop(spec §3.7)
    }

    // 2) 找 session
    const session = result.sessions.find(s => s.sessionId === this.deps.sessionId);
    if (!session) {
      // session 已不存在:patch final + stop
      const card = buildAttachedCard({
        name: this.deps.name,
        status: 'unknown',
        shortId: this.deps.shortId,
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        recentOutput: '⚠️ session 已不存在',
        outputFormat: 'markdown',
        lastWatchedAt: new Date().toLocaleTimeString(),
      });
      await this.deps.patchFn(this.deps.cardMessageId, card);
      await this.stop('session_gone');
      return;
    }

    // 3) idle + completed: final + stop
    if (session.status === 'idle' && session.completed) {
      const content = await this.deps.resolveContent(this.deps.shortId, 2048);
      const card = buildAttachedCard({
        name: this.deps.name,
        status: session.status,
        completed: session.completed,
        waitingFor: session.waitingFor,
        shortId: this.deps.shortId,
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        recentOutput: content.text ?? '(无可用输出)',
        outputFormat: content.format,
        lastWatchedAt: new Date().toLocaleTimeString(),
      });
      await this.deps.patchFn(this.deps.cardMessageId, card);
      await this.stop('idle_settled');
      return;
    }

    // 4) 拉 recentOutput
    const content = await this.deps.resolveContent(this.deps.shortId, 2048);

    // 5) build card(内含 25KB 智能截断)
    const card = buildAttachedCard({
      name: this.deps.name,
      status: session.status,
      completed: session.completed,
      waitingFor: session.waitingFor,
      shortId: this.deps.shortId,
      sessionId: this.deps.sessionId,
      cwd: this.deps.cwd,
      recentOutput: content.text ?? '(无可用输出)',
      outputFormat: content.format,
      lastWatchedAt: new Date().toLocaleTimeString(),
    });

    // 6) patch + 失败计数
    try {
      await this.deps.patchFn(this.deps.cardMessageId, card);
      this.patchFailureCount = 0;
    } catch (err: any) {
      this.patchFailureCount++;
      logger.warn(
        `AttachedCardWatcher patch failed (${this.patchFailureCount}/${this.deps.config.maxPatchFailures}): ` +
        `cardMessageId=${this.deps.cardMessageId}: ${err?.message ?? err}`,
      );
      if (this.patchFailureCount >= this.deps.config.maxPatchFailures) {
        await this.stop('patch_failed');
        return;
      }
    }

    // 7) maxTicks
    if (this.tickCount >= this.deps.config.maxTicks) {
      await this.stop('max_ticks');
    }
  }
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts`
Expected: 12 pass, 0 fail (3 lifecycle + 9 tick)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/attached-card-watcher.ts tests/unit/agent-view/attached-card-watcher.test.ts
git commit -m "feat(agent-view): AttachedCardWatcher.tick() with snapshot + patch + failure tracking"
```

---

## Task 6: 实现 `AttachedWatchers` 取代式 + 并发测试

**Files:**
- Modify: `tests/unit/agent-view/attached-card-watcher.test.ts` (加测试)

- [ ] **Step 1: 写测试**

在 `tests/unit/agent-view/attached-card-watcher.test.ts` 末尾追加:

```typescript
describe('AttachedWatchers manager', () => {
  let patchFn: ReturnType<typeof mock>;
  let resolveContent: ReturnType<typeof mock>;

  beforeEach(() => {
    patchFn = mock(async () => ({}));
    resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
  });

  test('start adds watcher to map; has() returns true', async () => {
    const mgr = new AttachedWatchers(patchFn, resolveContent, {
      ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50,
    });
    expect(mgr.has('ou_a')).toBe(false);
    await mgr.start('ou_a', {
      sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
    });
    expect(mgr.has('ou_a')).toBe(true);
    await mgr.stopAll();
  });

  test('start supersedes old watcher (old stop, new starts)', async () => {
    const mgr = new AttachedWatchers(patchFn, resolveContent, {
      ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50,
    });
    await mgr.start('ou_a', {
      sessionId: 's1', shortId: 's1short', name: 'n1', cwd: '/tmp', cardMessageId: 'om1',
    });
    const oldWatcher = (mgr as any).watchers.get('ou_a');
    await mgr.start('ou_a', {
      sessionId: 's2', shortId: 's2short', name: 'n2', cwd: '/tmp', cardMessageId: 'om2',
    });
    const newWatcher = (mgr as any).watchers.get('ou_a');
    expect(newWatcher).not.toBe(oldWatcher);
    expect((oldWatcher as any).stopped).toBe(true);
    expect((newWatcher as any).stopped).toBe(false);
    await mgr.stopAll();
  });

  test('stop: removes from map', async () => {
    const mgr = new AttachedWatchers(patchFn, resolveContent, {
      ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50,
    });
    await mgr.start('ou_a', {
      sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
    });
    await mgr.stop('ou_a', 'user_stop');
    expect(mgr.has('ou_a')).toBe(false);
  });

  test('stop on missing openId: no-op', async () => {
    const mgr = new AttachedWatchers(patchFn, resolveContent);
    await mgr.stop('nonexistent', 'test'); // 不应 throw
  });

  test('identity check: old watcher onStop does not delete new watcher', async () => {
    const mgr = new AttachedWatchers(patchFn, resolveContent, {
      ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 50,
    });
    await mgr.start('ou_a', {
      sessionId: 's1', shortId: 's1short', name: 'n1', cwd: '/tmp', cardMessageId: 'om1',
    });
    const oldWatcher = (mgr as any).watchers.get('ou_a');
    // 取代式 start
    await mgr.start('ou_a', {
      sessionId: 's2', shortId: 's2short', name: 'n2', cwd: '/tmp', cardMessageId: 'om2',
    });
    // 此时手动调 oldWatcher 的 onStop(模拟慢 in-flight tick 完成)
    oldWatcher.deps.onStop('ou_a', 'superseded', oldWatcher);
    // 验证 map 里的新 watcher 没被删
    expect(mgr.has('ou_a')).toBe(true);
    const current = (mgr as any).watchers.get('ou_a');
    expect(current).not.toBe(oldWatcher);
    await mgr.stopAll();
  });

  test('inFlightTick mutex: setInterval skips if previous still running', async () => {
    // 构造一个慢 patchFn,模拟 tick 阻塞
    let resolvePatch: () => void = () => {};
    const slowPatch = mock(async () => {
      return new Promise<void>(r => { resolvePatch = r; });
    });
    const mgr = new AttachedWatchers(slowPatch as any, resolveContent, {
      ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs: 10, maxTicks: 1000,
    });
    // stub AgentSnapshotFetcher(用项目通用 pattern 而非 spyOn,避免 spy 泄漏)
    const origFetch = AgentSnapshotFetcher.fetch;
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [{
        pid: 1, cwd: '/tmp', kind: 'background', startedAt: Date.now(),
        sessionId: 's1', name: 'n', status: 'busy', source: 'slash',
      }],
    }));
    try {
      await mgr.start('ou_a', {
        sessionId: 's1', shortId: 's1short', name: 'n', cwd: '/tmp', cardMessageId: 'om1',
      });
      // 等 ~30ms 让多次 interval 触发
      await new Promise(r => setTimeout(r, 30));
      // 此时 patch 只被调 1 次(inFlightTick mutex 跳过后续)
      expect(slowPatch).toHaveBeenCalledTimes(1);
      // resolve in-flight patch
      resolvePatch();
    } finally {
      (AgentSnapshotFetcher as any).fetch = origFetch;
      await mgr.stopAll();
    }
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts -t "AttachedWatchers manager"`
Expected: 6 FAIL, identity check 之类的会失败

- [ ] **Step 3: 调试/修复 `AttachedWatchers`**

大多数测试应该已经过(`AttachedWatchers` 在 Task 4 已经实现)。最可能失败的是 **identity check 测试**(我们已经在 Task 4 实现了 onStop 回调里的 identity check,但需要验证逻辑正确) 和 **inFlightTick mutex 测试** (依赖 AgentSnapshotFetcher spy).

如果 inFlightTick mutex 测试失败:说明 `setInterval` 触发时,`inFlightTick` 没正确互斥。检查 `start()` 方法,确认 `if (this.inFlightTick) return` 在 setInterval 回调里。

如果 identity check 失败:说明 `(mgr as any).watchers.get(oid) === w` 判断不对。

修复后跑测试直到全过。

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/attached-card-watcher.test.ts`
Expected: 18 pass, 0 fail (3 lifecycle + 9 tick + 6 manager)

- [ ] **Step 5: Commit**

```bash
git add tests/unit/agent-view/attached-card-watcher.test.ts
git commit -m "test(agent-view): AttachedWatchers manager + 取代式 + 并发测试"
```

---

## Task 7: `AgentViewManager` 集成 `AttachedWatchers` + `handleStopWatching`

**Files:**
- Modify: `src/agent-view/manager.ts:1-12` (imports) + line 35-44 (constructor) + handleAttach 末尾 + 新方法
- Create: `tests/unit/agent-view/manager-attached-watch.test.ts`

- [ ] **Step 1: 写 manager 测试** — 创建 `tests/unit/agent-view/manager-attached-watch.test.ts`:

```typescript
// tests/unit/agent-view/manager-attached-watch.test.ts
import { beforeEach, describe, expect, test, mock, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

// Mock child_process (handlePeek 退化路径会 import 它)
import { promisify } from 'node:util';
const execFileMock = Object.assign(
  mock((_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, '', '');
  }),
  {
    [promisify.custom]: (cmd: string, args: string[]) =>
      new Promise((resolve, reject) => {
        execFileMock(cmd, args, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      }),
  },
);
mock.module('node:child_process', () => ({
  ...require('node:child_process'),
  execFile: execFileMock,
}));

let tmpDir: string;
let userManager: UserManager;
let manager: AgentViewManager;
let cardReplies: Array<{ card: string; opts: any }>;
let textReplies: Array<{ text: string; opts: any }>;
let patches: Array<{ messageId: string; card: string }>;
const origFetcherFetch = AgentSnapshotFetcher.fetch;

const sampleSession: AgentSession = {
  pid: 1234,
  cwd: '/Users/test/proj',
  kind: 'background',
  startedAt: Date.now() - 10000,
  sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
  name: 'sleep 30',
  status: 'busy',
  source: 'slash',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mgr-attach-watch-'));
  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  cardReplies = [];
  textReplies = [];
  patches = [];
  manager = new AgentViewManager({
    userManager,
    replyFn: async (text, opts) => { textReplies.push({ text, opts }); return 'msg_text'; },
    cardReplyFn: async (card, opts) => { cardReplies.push({ card, opts }); return 'om_card'; },
    patchFn: async (messageId, card) => { patches.push({ messageId, card }); return {}; },
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({
    ok: true,
    sessions: [sampleSession],
  }));
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetcherFetch;
});

describe('AgentViewManager attached watch integration', () => {
  test('handleAttach success starts an attached watch', async () => {
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    expect(manager.attachedWatchers.has('ou_test')).toBe(true);
    // 验证有 cardReply 调(发首张 attached 卡)
    expect(cardReplies).toHaveLength(1);
  });

  test('handleAttach with existing watch: old stop superseded, new starts', async () => {
    // 第一次
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    const firstWatchers = (manager.attachedWatchers as any).watchers.get('ou_test');
    // 第二次(模拟同一用户 Attach 另一个 session)
    const secondSession: AgentSession = { ...sampleSession, sessionId: 'second-uuid', name: 'task2' };
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true, sessions: [secondSession],
    }));
    await manager.handleAttach(
      'ou_test', secondSession.sessionId, 'sec22222', 'task2', '/Users/test/proj',
    );
    const secondWatchers = (manager.attachedWatchers as any).watchers.get('ou_test');
    expect(firstWatchers.stopped).toBe(true);
    expect(secondWatchers).not.toBe(firstWatchers);
    expect(secondWatchers.stopped).toBe(false);
  });

  test('handleStopWatching: stops attached watch', async () => {
    await manager.handleAttach(
      'ou_test', sampleSession.sessionId, 'abc12345', 'sleep 30', '/Users/test/proj',
    );
    expect(manager.attachedWatchers.has('ou_test')).toBe(true);
    await manager.handleStopWatching('ou_test');
    expect(manager.attachedWatchers.has('ou_test')).toBe(false);
  });

  test('handleStopWatching on no watch: no-op', async () => {
    await manager.handleStopWatching('ou_unknown'); // 不应 throw
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/agent-view/manager-attached-watch.test.ts`
Expected: FAIL, "manager.attachedWatchers is undefined" 或类似

- [ ] **Step 3: 实现 `AgentViewManager` 改动**

打开 `src/agent-view/manager.ts`:

**Step 3a**:在 `import` 段(line 1-12)加入新依赖:

```typescript
import { AttachedWatchers } from './attached-card-watcher';
import { buildAttachedCard } from './card';
```

**Step 3b**:在类字段区(line 35-37 附近,`readonly expectedReply: ExpectedReplyState;` 之后)加新字段:

```typescript
  readonly attachedWatchers: AttachedWatchers;
```

**Step 3c**:修改构造函数(line 39-44):

```typescript
  constructor(public deps: AgentViewDeps) {
    this.expectedReply = new ExpectedReplyState(
      deps.userManager,
      deps.expectedReplyTimeoutMs ?? 300_000
    );
    this.attachedWatchers = new AttachedWatchers(
      deps.patchFn,
      (shortId, maxChars) => this.resolvePeekContent(shortId, maxChars),
    );
  }
```

**Step 3d**:把 `handleAttach` 的参数 `_shortId` 和 `_name` 改成 `shortId` 和 `name`(去下划线),并修函数体内所有引用:

找到 `async handleAttach(` 那一段,把:
```typescript
  async handleAttach(
    openId: string,
    sessionId: string,
    _shortId: string,
    _name: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
```

改成:
```typescript
  async handleAttach(
    openId: string,
    sessionId: string,
    shortId: string,
    name: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
```

然后全文搜索替换:
- `_shortId` → `shortId`(可能有 5-6 处)
- `_name` → `name`(可能有 1-2 处)

**Step 3e**:在 `handleAttach` 末尾(line 519-525 区域),在 `await this.deps.replyFn('📎 已 Attach ...')` 之后、**原 `return null;` 之前**,插入新代码(**不要写自己的 `return null;` 或 `}`**——原 `return null;` 和函数收尾的 `}` 保留):

```typescript
    // === 新增:Attach 后自动启动 watch + 发首张 attached 卡 ===
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
    const initialCard = buildAttachedCard({
      name: session.name, status: session.status, completed: session.completed,
      waitingFor: session.waitingFor, shortId, sessionId,
      cwd, recentOutput: peek.text ?? '(无可用输出)',
      outputFormat: peek.format, lastWatchedAt: new Date().toLocaleTimeString(),
    });
    const cardMessageId = await this.sendOrFallback(
      initialCard,
      { openId },
      `📡 Watching · \`${session.name}\` · /agents 查看`,
      openId,
    );
    if (cardMessageId) {
      await this.attachedWatchers.start(openId, {
        sessionId, shortId, name: session.name, cwd, cardMessageId,
      });
    }
    // ↓ 下面原 `return null;` + `}` 保留不动
```

最终 `handleAttach` 末尾应该长这样(以确认结构):

```typescript
    await this.deps.replyFn(
      `📎 已 Attach 到 \`${session.name}\`${warning}${waitingInfo}\n` +
        `Status: ${session.status} · CWD: ${cwd}\n` +
        `💡 提示:发 /new 创建新会话,或 /agents 返回列表。${bgWorkerNotice}`,
      { openId },
    );
    // === 新增的 watch + 卡代码(上面)===
    if (cardMessageId) {
      await this.attachedWatchers.start(openId, {...});
    }
    return null;   // ← 原 return null,保留
  }               // ← 原 },保留
```

**Step 3f**:在 `handleBackToChat` 之后(line 866 附近)加新方法:

```typescript
  /** [Stop Watching] 按钮 handler */
  async handleStopWatching(openId: string): Promise<null> {
    await this.attachedWatchers.stop(openId, 'user_stop', { patchFinal: true });
    return null;
  }
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/agent-view/manager-attached-watch.test.ts`
Expected: 4 pass, 0 fail

- [ ] **Step 5: 跑 typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager-attached-watch.test.ts
git commit -m "feat(agent-view): AgentViewManager 集成 AttachedWatchers + handleStopWatching"
```

---

# PR 2: Bot 集成(handleChat hook + handleCardAction + shutdown)

## Task 8: `bot.ts` `handleChat` 入口 hook

**Files:**
- Modify: `src/feishu/bot.ts:925-963` (handleChat 开头的 agentView 块)
- Create: `tests/unit/feishu/bot-handlechat-watch-stop.test.ts`

- [ ] **Step 1: 写测试** — 创建 `tests/unit/feishu/bot-handlechat-watch-stop.test.ts`:

```typescript
// tests/unit/feishu/bot-handlechat-watch-stop.test.ts
import { beforeEach, describe, expect, test, mock, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { SpoolMessage } from '../../../src/queue/spool';

let tmpDir: string;
let bot: FeishuBot;
let agentView: AgentViewManager;
let userManager: UserManager;
let attachedWatchers: { has: any; stop: any };

const origFetcherFetch = AgentSnapshotFetcher.fetch;

function makeMsg(over: Partial<SpoolMessage> = {}): SpoolMessage {
  return {
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    openId: 'ou_watch_test',
    text: 'hello',
    target: { type: 'no_target' },
    serialKey: 'sk-1',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bot-watch-stop-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
  const spoolQueue = new SpoolQueue(tmpDir);
  const registry = new RegistryManager(tmpDir);
  const sessionManager = new ClaudeSessionManager();
  agentView = new AgentViewManager({
    userManager,
    replyFn: async () => 'msg',
    cardReplyFn: async () => 'om',
    patchFn: async () => ({}),
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  // 注入一个 mock attachedWatchers
  attachedWatchers = {
    has: mock(() => false),
    stop: mock(async () => {}),
  };
  (agentView as any).attachedWatchers = attachedWatchers;
  bot = new FeishuBot({
    userManager, listSnapshotManager, spoolQueue, registry, sessionManager,
  });
  bot.setAgentView(agentView);
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({ ok: true, sessions: [] }));
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetcherFetch;
});

describe('FeishuBot.handleChat watch stop hook', () => {
  test('with active watch: stops watch on user text', async () => {
    attachedWatchers.has.mockReturnValue(true);
    await bot.handleChat(makeMsg({ text: 'hello' }));
    // 不 await,但要等 microtask flush
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).toHaveBeenCalledWith(
      'ou_watch_test', 'user_chat', { patchFinal: true },
    );
  });

  test('with no watch: no stop call', async () => {
    attachedWatchers.has.mockReturnValue(false);
    await bot.handleChat(makeMsg({ text: 'hello' }));
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).not.toHaveBeenCalled();
  });

  test('with /cancel: also stops watch', async () => {
    attachedWatchers.has.mockReturnValue(true);
    // /cancel 会走 handleCancelReply,但 stop hook 必须在它之前
    await bot.handleChat(makeMsg({ text: '/cancel' }));
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).toHaveBeenCalledWith(
      'ou_watch_test', 'user_chat', { patchFinal: true },
    );
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/feishu/bot-handlechat-watch-stop.test.ts`
Expected: FAIL, "attachedWatchers.stop not called"

- [ ] **Step 3: 改 `bot.ts` `handleChat`**

打开 `src/feishu/bot.ts`,找到 line 925 附近 `private async handleChat(msg: SpoolMessage): Promise<void> {`,在 line 931 `if (this.agentView && config.get<boolean>('agent_view.enabled', true)) {` 之后、`if (msg.text === '/cancel')` 之前,加:

```typescript
      // 新增:任何进入 handleChat 的消息都停掉当前 attached watch
      if (this.agentView.attachedWatchers.has(msg.openId)) {
        void this.agentView.attachedWatchers.stop(msg.openId, 'user_chat', { patchFinal: true });
      }
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/feishu/bot-handlechat-watch-stop.test.ts`
Expected: 3 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot-handlechat-watch-stop.test.ts
git commit -m "feat(feishu): handleChat 入口 hook 停 attached watch"
```

---

## Task 9: `bot.ts` `handleCardAction` 新 case

**Files:**
- Modify: `src/feishu/bot.ts:577-581` (handleCardAction switch)
- Create: `tests/unit/feishu/bot-cardaction-attached-watch.test.ts`

- [ ] **Step 1: 写测试** — 创建 `tests/unit/feishu/bot-cardaction-attached-watch.test.ts`:

```typescript
// tests/unit/feishu/bot-cardaction-attached-watch.test.ts
import { beforeEach, describe, expect, test, mock } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';

let bot: FeishuBot;
let agentView: AgentViewManager;
let handleStopWatchingCalls: string[];
const origFetcherFetch = AgentSnapshotFetcher.fetch;

beforeEach(() => {
  (config as any).data.feishu_bot.owner_open_id = '';
  bot = new FeishuBot({} as any);
  const userManager = new UserManager('/tmp/test-user-mapping-' + Math.random() + '.json');
  agentView = new AgentViewManager({
    userManager,
    replyFn: async () => 'msg',
    cardReplyFn: async () => 'om',
    patchFn: async () => ({}),
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  handleStopWatchingCalls = [];
  (agentView as any).handleStopWatching = async (openId: string) => {
    handleStopWatchingCalls.push(openId);
    return null;
  };
  bot.setAgentView(agentView);
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({ ok: true, sessions: [] }));
});

describe('FeishuBot.handleCardAction agent_view_stop_watching', () => {
  test('dispatches to manager.handleStopWatching', async () => {
    const result = await bot.handleCardAction({
      open_id: 'ou_test',
      action: { tag: 'agent_view_stop_watching', value: { tag: 'agent_view_stop_watching' } },
      message: { message_id: 'om_test' },
    } as any);
    expect(handleStopWatchingCalls).toEqual(['ou_test']);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `bun test tests/unit/feishu/bot-cardaction-attached-watch.test.ts`
Expected: FAIL, "case 'agent_view_stop_watching' is not handled"

- [ ] **Step 3: 加新 case**

打开 `src/feishu/bot.ts`,找到 line 577-578:

```typescript
        case 'agent_view_bg_conflict_cancel':
          return await this.agentView.handleBgConflictCancel(openId, messageId);
```

在 `default: return null;` 之前(line 579)插入:

```typescript
        case 'agent_view_stop_watching':
          await this.agentView.handleStopWatching(openId);
          return null;
```

- [ ] **Step 4: 跑测试,确认 pass**

Run: `bun test tests/unit/feishu/bot-cardaction-attached-watch.test.ts`
Expected: 1 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot-cardaction-attached-watch.test.ts
git commit -m "feat(feishu): handleCardAction 加 agent_view_stop_watching case"
```

---

## Task 10: `bot.ts` `shutdown` 集成

**Files:**
- Modify: `src/feishu/bot.ts:407-411` (shutdown 方法)

- [ ] **Step 1: 改 `shutdown`**

打开 `src/feishu/bot.ts`,找到 line 407-411:

```typescript
  async shutdown(): Promise<void> {
    const watchers = Array.from(this.liveWatchers.values());
    this.liveWatchers.clear();
    await Promise.all(watchers.map(w => w.stop('bot_shutdown')));
  }
```

改为:

```typescript
  async shutdown(): Promise<void> {
    const watchers = Array.from(this.liveWatchers.values());
    this.liveWatchers.clear();
    // 新增:也停 agentView 的 attached watchers
    if (this.agentView) {
      await this.agentView.attachedWatchers.stopAll();
    }
    await Promise.all(watchers.map(w => w.stop('bot_shutdown')));
  }
```

- [ ] **Step 2: 跑现有 bot shutdown 测试,确认不破坏**

Run: `bun test tests/unit/feishu/`
Expected: 所有现有测试 pass,0 fail

- [ ] **Step 3: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): shutdown 集成 agentView.attachedWatchers.stopAll"
```

---

# PR 3: 收尾 + 验收

## Task 11: 整体回归 + typecheck

**Files:**
- (no file changes, just verification)

- [ ] **Step 1: 跑 typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 2: 跑全部测试**

Run: `bun test`
Expected: 全部 pass(720+ tests,实际数字看 spec 落地后)

- [ ] **Step 3: 跑 coverage(可选,验证覆盖率)**

Run: `bun test --coverage tests/unit/agent-view/`
Expected: attached-card-watcher.ts / card.ts (buildAttachedCard) 覆盖率 > 80%

- [ ] **Step 4: Commit coverage(如果做了)**

```bash
git add coverage/
git commit -m "chore: coverage report for attached watch feature" || true
```

---

## Task 12: 手动 e2e 验收(spec §9 12 步)

**Files:**
- (no code changes)

- [ ] **Step 1: 启动 bot**

Run: `bun run dev start`
Expected: 启动成功,无 error

- [ ] **Step 2: 跑 spec §9 验收脚本 12 步**

按 `docs/superpowers/specs/2026-06-09-attach-auto-refresh-card-design.md` §9 的 12 步手动跑:

1. 终端 `claude --bg "test 1: sleep 30 && echo done"`
2. 飞书发 `/agents` → 看到列表卡
3. 飞书点 [Attach] → 看到 "📎 已 Attach" 文本 + 紧跟一张可交互卡
4. 等 10s,patch 触发,卡片内容更新
5. 终端 `cat ~/.claude/projects/.../<uuid>.jsonl | tail` 写新内容,10s 内飞书卡更新
6. 等 session 自然完成,飞书卡 patch final "✅ 已结束" + watch 停
7. 重新派发,Attach 后飞书发"hello" → 飞书卡 patch "🔌 Watch stopped" + 收到 chat 回复
8. 派发两条,Attach A → 看到 A 卡;接着 Attach B → A 卡静默停,B 卡出现
9. Attach 后点 [Stop Watching] → 飞书卡 patch "🔌 Watch stopped"
10. 终端 `rm` JSONL 后 Attach,~30s 内 patch 失败 3 次 → 静默 stop
11. 极端长 output(写 30KB markdown 到 JSONL)→ 卡片正常 patch(智能截断)
12. bot 重启 → 旧卡停在那一刻,无 patch

每一步期望结果都对应到 `tests/unit/` 里的测试用例。**任何一步失败,回对应 task 修代码**。

- [ ] **Step 3: 验收完成, 写总结**

把 12 步结果贴到 `docs/superpowers/specs/2026-06-09-attach-auto-refresh-card-design.md` 末尾作为 §11 "验收记录"。

Commit:
```bash
git add docs/superpowers/specs/2026-06-09-attach-auto-refresh-card-design.md
git commit -m "docs(agent-view): 12 步手动验收通过"
```

---

## 落地后建议 PR 拆分

| PR | 包含 Task | 目的 |
|----|----------|------|
| **PR 1** | Tasks 1-7 | Card builder + Watcher + Manager 集成(可独立 review,无 bot 改动) |
| **PR 2** | Tasks 8-10 | Bot 集成(handleChat hook + handleCardAction + shutdown) |
| **PR 3** | Tasks 11-12 | 验收 + 文档(可跟 PR 2 合并) |

不在范围(defer):detach 按钮(N7)、watch_interval_ms 配置(N2)、bot 重启续传(N3)、智能 JSONL-only 兜底(N9)。
