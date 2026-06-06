# Feishu Live Progress Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 切到正在处理的 session 时，持续 15s 一次 patch 概览卡片展示实时进展，同时支持飞书 in-memory 跑和 CLI marker 跑两种场景。

**Architecture:** 纯 setInterval 轮询方案。`doSwitch` 命中 isProcessing=true 时启动 `LiveProgressWatcher`，每 15s 读 JSONL tail 抓 latest preview + 调 CardUpdater.patchCard 更新卡片。停止条件：session 闲 / 用户发新消息 / patch 失败 3 次 / maxTicks 400 (100min) 硬上限。

**Tech Stack:** Bun / TypeScript / Feishu OpenAPI / CardUpdater (现有) / isSessionActive (现有) / scanner/jsonl.ts (扩展)

---

## File Structure

| 路径 | 责任 | 类型 |
|------|------|------|
| `src/feishu/live-progress.ts` | LiveProgressWatcher + isSessionProcessing + extractLivePreview + DEFAULT_LIVE_PROGRESS_CONFIG | 新建 |
| `src/scanner/jsonl.ts` | 加 `parseTailForPreview` export | 扩展 |
| `src/feishu/bot.ts` | 加 `liveWatchers` / `stopLiveWatcher` / `liveConfig` / `shutdown`；改 `doSwitch` / `handleClaimed` / `buildSessionOverviewCard` | 扩展 |
| `src/cli/commands/start.ts` | graceful shutdown 调 `bot.shutdown()` | 扩展 |
| `tests/unit/scanner/jsonl-parse-tail-preview.test.ts` | parseTailForPreview 单测 | 新建 |
| `tests/unit/feishu/live-progress.test.ts` | isSessionProcessing / extractLivePreview / LiveProgressWatcher 单测 | 新建 |
| `tests/integration/feishu-live-progress.test.ts` | 4 个端到端场景 | 新建 |

---

# PR 1: 数据层 + live-progress 模块

## Task 1: parseTailForPreview 单测（红）

**Files:**
- Test: `tests/unit/scanner/jsonl-parse-tail-preview.test.ts`

- [ ] **Step 1: 写测试文件**

```typescript
// tests/unit/scanner/jsonl-parse-tail-preview.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTailForPreview } from '../../../src/scanner/jsonl';

describe('parseTailForPreview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-tail-preview-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts last user prompt and last assistant text from valid JSONL', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '帮我做 X' }, timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '好的，我来帮你' }] }, timestamp: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'sleep 50 && echo done' }] }, timestamp: '2026-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', text: '思考中...' }, { type: 'text', text: '执行 sleep 50' }] }, timestamp: '2026-01-01T00:00:03Z' }),
    ];
    writeFileSync(path, lines.join('\n'));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('sleep 50 && echo done');
    expect(result.lastAssistant).toBe('执行 sleep 50');
  });

  it('handles user content as string (not array)', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '纯字符串内容' } }));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('纯字符串内容');
  });

  it('returns empty object for empty file', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, '');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns empty object for malformed JSONL lines', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, 'not json\n{broken: json\n');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns only lastUser when only user lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '只有一个 user' } }));
    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('只有一个 user');
    expect(result.lastAssistant).toBeUndefined();
  });

  it('returns only lastAssistant when only assistant lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '只有 assistant' }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant).toBe('只有 assistant');
    expect(result.lastUser).toBeUndefined();
  });

  it('truncates long text to 100 chars', () => {
    const path = join(tmpDir, 'session.jsonl');
    const longText = 'x'.repeat(500);
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant?.length).toBe(100);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `bun test tests/unit/scanner/jsonl-parse-tail-preview.test.ts 2>&1 | tail -10`
Expected: FAIL with "parseTailForPreview is not exported" or similar (import 失败)

---

## Task 2: parseTailForPreview 实现（绿）

**Files:**
- Modify: `src/scanner/jsonl.ts` (在文件末尾加 export)

- [ ] **Step 1: 实现函数**

打开 `src/scanner/jsonl.ts`，**在文件最末尾**追加：

```typescript
/**
 * Lightweight JSONL tail reader for live progress cards.
 *
 * Reads only the last 4KB of the file and extracts the most recent
 * user prompt and assistant text. Different from parseTail in that
 * it returns ONLY the preview fields (lastUser, lastAssistant)
 * without scanning the full file or doing 4KB fallback.
 *
 * Used by LiveProgressWatcher.tick() to refresh the overview card
 * every 15s with the latest text content.
 *
 * Returns empty object on error (file missing, corrupt, etc).
 */
export function parseTailForPreview(jsonlPath: string): {
  lastUser?: string;
  lastAssistant?: string;
} {
  let stat: import('fs').Stats;
  try {
    stat = statSync(jsonlPath);
  } catch {
    return {};
  }
  if (stat.size === 0) return {};

  const readSize = Math.min(4096, stat.size);
  const fd = openSync(jsonlPath, 'r');
  const buf = Buffer.alloc(readSize);
  try {
    fd.readSync(buf, 0, readSize, stat.size - readSize);
  } catch {
    closeSync(fd);
    return {};
  }
  closeSync(fd);
  const tail = buf.toString('utf8');
  const lines = tail.split('\n').filter(Boolean);

  let lastUser: string | undefined;
  let lastAssistant: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'user' && !lastUser) {
        const content = entry.message?.content;
        if (typeof content === 'string') {
          lastUser = content.slice(0, 100);
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: any) => b.type === 'text');
          if (textBlock?.text) lastUser = textBlock.text.slice(0, 100);
        }
      } else if (entry.type === 'assistant' && !lastAssistant) {
        const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
        if (textBlock?.text) lastAssistant = textBlock.text.slice(0, 100);
      }
      if (lastUser && lastAssistant) break;
    } catch {
      // 跳过损坏行
    }
  }
  return { lastUser, lastAssistant };
}
```

- [ ] **Step 2: 验证 `statSync` / `openSync` / `closeSync` 已 import**

跑 `grep -n "^import\|statSync\|openSync\|closeSync" src/scanner/jsonl.ts | head -10`

如果 `statSync` / `openSync` / `closeSync` 没在 import 列表里，**在文件顶部 import 块**追加：

```typescript
import { statSync, openSync, closeSync } from 'fs';
```

- [ ] **Step 3: 跑测试，确认通过**

Run: `bun test tests/unit/scanner/jsonl-parse-tail-preview.test.ts 2>&1 | tail -5`
Expected: 7 pass / 0 fail

- [ ] **Step 4: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 干净无错误

- [ ] **Step 5: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-parse-tail-preview.test.ts
git commit -m "feat(scanner): add parseTailForPreview for live progress card"
```

---

## Task 3: live-progress 模块骨架 + 单测（红）

**Files:**
- Create: `src/feishu/live-progress.ts`
- Create: `tests/unit/feishu/live-progress.test.ts`

- [ ] **Step 1: 写测试文件**

```typescript
// tests/unit/feishu/live-progress.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractLivePreview,
  isSessionProcessing,
  LiveProgressWatcher,
  DEFAULT_LIVE_PROGRESS_CONFIG,
} from '../../../src/feishu/live-progress';

describe('extractLivePreview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'live-preview-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty for null jsonlPath', () => {
    expect(extractLivePreview(null)).toEqual({});
  });

  it('returns empty for non-existent file', () => {
    expect(extractLivePreview(join(tmpDir, 'missing.jsonl'))).toEqual({});
  });

  it('extracts from real JSONL', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hello' } }));
    const result = extractLivePreview(path);
    expect(result.lastUser).toBe('hello');
  });
});

describe('isSessionProcessing', () => {
  it('returns true if sessionId is in listSessions (feishu)', async () => {
    const bot = {
      sessionManager: {
        listSessions: () => [{ sessionId: 'feishu-uuid' }],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('feishu-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(true);
  });

  it('returns false if no listSessions match and no cache', async () => {
    const bot = {
      sessionManager: {
        listSessions: () => [],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('cli-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(false);
  });
});

describe('LiveProgressWatcher', () => {
  it('exports DEFAULT_LIVE_PROGRESS_CONFIG with correct values', () => {
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs).toBe(15_000);
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks).toBe(400);
    expect(DEFAULT_LIVE_PROGRESS_CONFIG.maxPatchFailures).toBe(3);
  });

  it('calls onStop when stop() invoked', () => {
    let stopped = false;
    let stopReason = '';
    const w = new LiveProgressWatcher({
      uuid: 'u1',
      openId: 'ou1',
      cardMessageId: 'm1',
      feishuClient: { im: { v1: { message: { patch: async () => ({ code: 0 }) } } } },
      bot: {} as any,
      config: DEFAULT_LIVE_PROGRESS_CONFIG,
      onStop: (_oid, reason) => { stopped = true; stopReason = reason; },
    });
    w.stop('test_reason');
    expect(stopped).toBe(true);
    expect(stopReason).toBe('test_reason');
  });

  it('stop() is idempotent (second call no-op)', () => {
    let callCount = 0;
    const w = new LiveProgressWatcher({
      uuid: 'u1',
      openId: 'ou1',
      cardMessageId: 'm1',
      feishuClient: { im: { v1: { message: { patch: async () => ({ code: 0 }) } } } },
      bot: {} as any,
      config: DEFAULT_LIVE_PROGRESS_CONFIG,
      onStop: () => { callCount++; },
    });
    w.stop('first');
    w.stop('second');
    expect(callCount).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `bun test tests/unit/feishu/live-progress.test.ts 2>&1 | tail -5`
Expected: FAIL — 模块不存在 / 导入失败

---

## Task 4: 实现 live-progress 模块（绿）

**Files:**
- Create: `src/feishu/live-progress.ts`

- [ ] **Step 1: 写模块骨架**

```typescript
// src/feishu/live-progress.ts
/**
 * Live progress card polling module.
 *
 * Drives the "🔄 处理中会话" overview card with 15s patches showing
 * the latest user/assistant text from JSONL tail. See:
 * docs/superpowers/specs/2026-06-06-feishu-live-progress-card-design.md
 */
import { readFileSync, statSync, openSync, closeSync } from 'fs';
import { logger } from '../utils/logger';
import { isSessionActive, SessionActivityCache } from '../utils/session-activity';
import { parseTailForPreview } from '../scanner/jsonl';
import { CardUpdater } from './card-updater';
import type { FeishuBot } from './bot';
import type { SessionEntry } from '../registry/types';

export interface LiveProgressConfig {
  intervalMs: number;
  maxTicks: number;
  maxPatchFailures: number;
}

export const DEFAULT_LIVE_PROGRESS_CONFIG: LiveProgressConfig = {
  intervalMs: 15_000,
  maxTicks: 400,
  maxPatchFailures: 3,
};

/**
 * Read the last user prompt and last assistant text from JSONL tail.
 * Wraps parseTailForPreview with try/catch — never throws.
 */
export function extractLivePreview(jsonlPath: string | null): {
  lastUser?: string;
  lastAssistant?: string;
} {
  if (!jsonlPath) return {};
  try {
    return parseTailForPreview(jsonlPath);
  } catch (err) {
    logger.warn(`extractLivePreview failed: ${jsonlPath}: ${err}`);
    return {};
  }
}

/**
 * Detect if a session is currently processing.
 *
 * Priority:
 * 1. Feishu in-memory activeProcesses (zero latency, authoritative)
 * 2. CLI activity markers + CPU + child + mtime (via isSessionActive)
 */
export async function isSessionProcessing(
  uuid: string,
  entry: Pick<SessionEntry, 'cwd' | 'jsonl_path'>,
  bot: FeishuBot,
): Promise<boolean> {
  // 1) Feishu in-memory
  if (bot.sessionManager.listSessions().some(s => s.sessionId === uuid)) {
    return true;
  }
  // 2) CLI activity detection
  const cache = bot.sessionManager.activityCache ?? new SessionActivityCache();
  const status = await isSessionActive(
    { sessionUuid: uuid, cwd: entry.cwd, jsonl_path: entry.jsonl_path },
    cache,
    'feishu-detects-cli',
  );
  return status.isProcessing && status.confidence !== 'low';
}

export interface WatcherDeps {
  uuid: string;
  openId: string;
  cardMessageId: string;
  feishuClient: any;
  bot: FeishuBot;
  config: LiveProgressConfig;
  onStop: (openId: string, reason: string) => void;
}

export interface LivePreview {
  lastUser?: string;
  lastAssistant?: string;
}

/**
 * Single-card polling watcher. One instance per openId.
 *
 * Lifecycle:
 * - start()  — begins setInterval
 * - tick()   — reads JSONL tail, patches card, checks stop conditions
 * - stop()   — clearInterval, calls onStop callback (idempotent)
 */
export class LiveProgressWatcher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private patchFailureCount = 0;
  private stopped = false;
  private startedAt = Date.now();

  constructor(private deps: WatcherDeps) {}

  start(): void {
    this.intervalHandle = setInterval(
      () => {
        this.tick().catch(err => logger.error(`LiveProgressWatcher tick error: ${err}`));
      },
      this.deps.config.intervalMs,
    );
    logger.info(
      `LiveProgressWatcher start: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `cardMessageId=${this.deps.cardMessageId}, intervalMs=${this.deps.config.intervalMs}`,
    );
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // 1) session 还在吗？
    const entry = this.deps.bot.registry.get(this.deps.uuid);
    if (!entry) {
      this.stop('session_gone');
      return;
    }

    // 2) 读最新 preview
    const live = extractLivePreview(entry.jsonl_path);

    // 3) 重新构建卡片（isRunning=true + 实时标签）
    //    buildSessionOverviewCard 在 PR 2 扩展第 4 参
    const card = this.deps.bot.buildLiveOverviewCard(
      this.deps.uuid, entry, true, live,
    );

    // 4) patch
    try {
      const updater = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
      updater.setCardMessageId(this.deps.cardMessageId);
      await updater.patchCard(card);
      this.patchFailureCount = 0;
    } catch (err) {
      this.patchFailureCount++;
      logger.warn(
        `LiveProgressWatcher patch failed (${this.patchFailureCount}/${this.deps.config.maxPatchFailures}): ` +
        `cardMessageId=${this.deps.cardMessageId}: ${err}`,
      );
      if (this.patchFailureCount >= this.deps.config.maxPatchFailures) {
        this.stop('patch_failed');
        return;
      }
    }

    // 5) maxTicks 硬上限
    if (this.tickCount >= this.deps.config.maxTicks) {
      this.stop('max_ticks');
      return;
    }

    // 6) session 闲下来：发 final + stop
    const stillProcessing = await isSessionProcessing(
      this.deps.uuid, entry, this.deps.bot,
    );
    if (!stillProcessing) {
      const finalCard = this.deps.bot.buildLiveOverviewCard(
        this.deps.uuid, entry, false, live,
      );
      try {
        const updater = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
        updater.setCardMessageId(this.deps.cardMessageId);
        await updater.patchCard(finalCard);
      } catch (err) {
        logger.warn(`LiveProgressWatcher final patch failed: ${err}`);
      }
      this.stop('idle');
    }
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    logger.info(
      `LiveProgressWatcher stop: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
    );
    this.deps.onStop(this.deps.openId, reason);
  }
}
```

> **注**：`this.deps.bot.buildLiveOverviewCard(...)` 在 PR 1 时**还不存在**。本任务用 `as any` 兜底让 TypeScript 编译过；PR 2 会把这个方法加到 `FeishuBot` 上。

- [ ] **Step 2: 跑测试（PR 1 阶段）**

Run: `bun test tests/unit/feishu/live-progress.test.ts 2>&1 | tail -8`
Expected: 部分 pass，tick 相关的 3 个测试会因 `buildLiveOverviewCard` 不存在而 skip / fail — 没关系，PR 1 范围只验证：
- DEFAULT_LIVE_PROGRESS_CONFIG 字段值
- isSessionProcessing 两个分支（listSessions 有 / 无）
- extractLivePreview 三个分支
- LiveProgressWatcher.stop 幂等 + onStop 回调

**如果 typecheck 报错**说 `FeishuBot` 上没 `buildLiveOverviewCard` —— 用 `as any` 已经在 tick() 内部，转译应通过。如果 `bot: FeishuBot` 类型注解卡住，临时把 `deps.bot` 改成 `deps.bot: any` 留 PR 2 改。

- [ ] **Step 3: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: 干净

- [ ] **Step 4: 跑全套单测**

Run: `bun test tests/unit/feishu/live-progress.test.ts tests/unit/scanner/jsonl-parse-tail-preview.test.ts 2>&1 | tail -5`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/feishu/live-progress.ts tests/unit/feishu/live-progress.test.ts
git commit -m "feat(feishu): add live-progress module with watcher + config"
```

---

# PR 2: bot.ts 接入

## Task 5: 扩展 buildSessionOverviewCard 第 4 参数

**Files:**
- Modify: `src/feishu/bot.ts:2284-2310`

- [ ] **Step 1: 跑 baseline 测试，确保现状正常**

Run: `bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -3`
Expected: 全部 pass

- [ ] **Step 2: 改 buildSessionOverviewCard 签名 + 实现**

打开 `src/feishu/bot.ts:2284`，把：

```typescript
function buildSessionOverviewCard(
  uuid: string,
  entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
  isRunning: boolean,
): Record<string, unknown> {
  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${esc(truncateTitleForCard(entry.title))}`;

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔄 已切换会话' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${esc(entry.cwd ?? '-')}\`` },
      ...(entry.last_user_preview ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(entry.last_user_preview)}` }] : []),
      ...(entry.last_assistant_preview ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(entry.last_assistant_preview)}` }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: `📊 ${formatMetaStats(entry)}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}
```

替换为：

```typescript
interface OverviewCardOverrides {
  lastUserPreview?: string;
  lastAssistantPreview?: string;
}

function buildSessionOverviewCard(
  uuid: string,
  entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
  isRunning: boolean,
  overrides: OverviewCardOverrides = {},
): Record<string, unknown> {
  const lastUser = overrides.lastUserPreview ?? entry.last_user_preview;
  const lastAssistant = overrides.lastAssistantPreview ?? entry.last_assistant_preview;
  const liveHint = isRunning ? ' _(实时)_' : '';

  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${esc(truncateTitleForCard(entry.title))}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isRunning ? '🔄 处理中会话' : '🔄 已切换会话' },
      template: isRunning ? 'orange' : 'blue',
    },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}${liveHint}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${esc(entry.cwd ?? '-')}\`` },
      ...(lastUser ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(lastUser)}` }] : []),
      ...(lastAssistant ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(lastAssistant)}${liveHint}` }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: `📊 ${formatMetaStats(entry)}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}
```

- [ ] **Step 3: 跑 typecheck + 现有测试，确认没破坏**

Run: `bun run typecheck 2>&1 | tail -3 && bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -3`
Expected: 全部 pass（向后兼容：第 4 参 default `{}` 旧调用点无影响）

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): buildSessionOverviewCard supports live overrides + orange template"
```

---

## Task 6: 在 FeishuBot 上加 buildLiveOverviewCard + liveConfig + stopLiveWatcher

**Files:**
- Modify: `src/feishu/bot.ts` (在 FeishuBot class 内)

- [ ] **Step 1: 加 import**

在 `src/feishu/bot.ts` 顶部 import 块（与现有 import 一起）加：

```typescript
import { LiveProgressWatcher, isSessionProcessing, extractLivePreview, DEFAULT_LIVE_PROGRESS_CONFIG, type LiveProgressConfig } from './live-progress';
```

- [ ] **Step 2: 加成员字段**

在 FeishuBot 现有 `private lastImageCleanup = 0;` 后面（找 `private lastImageCleanup`）加：

```typescript
  /** Live progress watchers, keyed by openId. One watcher per user. */
  private liveWatchers = new Map<string, LiveProgressWatcher>();

  /** Read live_progress config with defaults. */
  private get liveConfig(): LiveProgressConfig {
    return {
      intervalMs: config.get<number>('feishu_bot.live_progress.interval_ms', DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs),
      maxTicks: config.get<number>('feishu_bot.live_progress.max_ticks', DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks),
      maxPatchFailures: config.get<number>('feishu_bot.live_progress.max_patch_failures', DEFAULT_LIVE_PROGRESS_CONFIG.maxPatchFailures),
    };
  }

  /** Stop the user's live watcher if any. Idempotent. */
  stopLiveWatcher(openId: string, reason: string): void {
    const w = this.liveWatchers.get(openId);
    if (w) {
      w.stop(reason);
      this.liveWatchers.delete(openId);
    }
  }

  /** Build overview card with live data — used by LiveProgressWatcher.tick() */
  buildLiveOverviewCard(
    uuid: string,
    entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
    isRunning: boolean,
    live: { lastUser?: string; lastAssistant?: string },
  ): Record<string, unknown> {
    return buildSessionOverviewCard(uuid, entry, isRunning, {
      lastUserPreview: live.lastUser,
      lastAssistantPreview: live.lastAssistant,
    });
  }

  /** Stop all live watchers — called from graceful shutdown */
  shutdown(): void {
    for (const [openId, watcher] of this.liveWatchers) {
      watcher.stop('bot_shutdown');
    }
    this.liveWatchers.clear();
  }
```

- [ ] **Step 3: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -5`
Expected: 干净

- [ ] **Step 4: 跑现有测试**

Run: `bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -3`
Expected: 全部 pass（还没接 doSwitch，watcher 不会被启动）

- [ ] **Step 5: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): add liveWatchers + stopLiveWatcher + buildLiveOverviewCard on FeishuBot"
```

---

## Task 7: 改造 doSwitch 启动 watcher

**Files:**
- Modify: `src/feishu/bot.ts:2010-2048` (doSwitch 内的 swapped=true 路径)

- [ ] **Step 1: 找到 doSwitch 的 swapped=true 路径**

在 `src/feishu/bot.ts` 搜 `isSessionRunning(uuid)`（约 line 2027），找到这段：

```typescript
    // swapped=true：判断目标 session 是否正在跑 Claude
    const isRunning = this.isSessionRunning(uuid);

    // 发概览卡片
    const card = buildSessionOverviewCard(uuid, session, isRunning);
    const replyId = await this.cardReplyFn(card, { messageId, openId });
```

- [ ] **Step 2: 改成 isSessionProcessing**

把上面 3 行替换为：

```typescript
    // swapped=true：判断目标 session 是否正在处理（飞书 in-memory + CLI marker 统一）
    const isRunning = await isSessionProcessing(uuid, session, this);

    // 发概览卡片
    const card = buildSessionOverviewCard(uuid, session, isRunning);
    const replyId = await this.cardReplyFn(card, { messageId, openId });
```

- [ ] **Step 3: 在 replyId 拿到后启动 watcher**

紧接在 `const replyId = await this.cardReplyFn(card, { ... });` 后、`if (replyId) {` 块内，找到：

```typescript
    if (replyId) {
      if (msg) {
        ...
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
    } else {
```

在 `if (replyId) {` 块**末尾**（`} else {` 之前）加：

```typescript
      // 启动 live watcher（仅 isRunning=true 时）
      if (isRunning) {
        this.stopLiveWatcher(openId, 'new_switch');
        const watcher = new LiveProgressWatcher({
          uuid,
          openId,
          cardMessageId: replyId,
          feishuClient: this.feishuClient,
          bot: this,
          config: this.liveConfig,
          onStop: (oid, _reason) => this.liveWatchers.delete(oid),
        });
        this.liveWatchers.set(openId, watcher);
        watcher.start();
      }
```

- [ ] **Step 4: 跑 typecheck + 现有测试**

Run: `bun run typecheck 2>&1 | tail -3 && bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -5`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): doSwitch starts LiveProgressWatcher when session is processing"
```

---

## Task 8: handleClaimed 入口停止 watcher（用户发新消息）

**Files:**
- Modify: `src/feishu/bot.ts:589-619` (handleClaimed 入口)

- [ ] **Step 1: 找到 handleClaimed 入口**

在 `src/feishu/bot.ts` 搜 `private async handleClaimed`，找到 method 入口：

```typescript
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    if (this.spoolQueue.hasSentDelivery(msg.messageId)) {
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, msg.replyMessageId);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, msg.replyMessageId);
      return;
    }
```

- [ ] **Step 2: 在 busy check 之前插入 stopLiveWatcher 调用**

把上面替换为：

```typescript
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    // 【live progress】用户发新消息（非 command）→ 停止该用户的 live watcher
    // 命令（/list / /status 等）不打断 watcher，因为用户可能切到 session 后想查进展
    const isCommandMsg = (msg.text?.startsWith('/') ?? false) && (msg.text?.length ?? 0) > 1 && (msg.text?.[1] !== ' ');
    if (!isCommandMsg) {
      this.stopLiveWatcher(msg.openId, 'user_new_message');
    }

    if (this.spoolQueue.hasSentDelivery(msg.messageId)) {
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, msg.replyMessageId);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, msg.replyMessageId);
      return;
    }
```

- [ ] **Step 3: 跑 typecheck + 现有测试**

Run: `bun run typecheck 2>&1 | tail -3 && bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -5`
Expected: 全部 pass

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): stop live watcher when user sends new chat message"
```

---

## Task 9: start.ts graceful shutdown 调 bot.shutdown()

**Files:**
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: 找到 gracefulShutdown**

在 `src/cli/commands/start.ts` 搜 `gracefulShutdown`（前台模式）或 `daemonShutdown`（daemon 模式）。两处都需要调 `bot.shutdown()`。

- [ ] **Step 2: 在 shutdown 流程开头加 bot.shutdown()**

打开 `src/cli/commands/start.ts`，找到 `const gracefulShutdown = async (signal: string) => {`（约 line 520），把：

```typescript
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));
    await shutdown(signal);
```

替换为：

```typescript
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));
    try { bot.shutdown(); } catch {}
    await shutdown(signal);
```

找到 `const daemonShutdown = async (signal: string) => {`（约 line 578），同样把：

```typescript
  const daemonShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    await shutdown(signal);
```

替换为：

```typescript
  const daemonShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    try { bot.shutdown(); } catch {}
    await shutdown(signal);
```

- [ ] **Step 3: 跑 typecheck + 现有测试**

Run: `bun run typecheck 2>&1 | tail -3 && bun test tests/unit/feishu/ tests/integration/feishu-concurrent-commands.test.ts 2>&1 | tail -5`
Expected: 全部 pass

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(daemon): stop live watchers on graceful shutdown"
```

---

# 集成测试

## Task 10: 集成测试（4 个场景）

**Files:**
- Create: `tests/integration/feishu-live-progress.test.ts`

- [ ] **Step 1: 写集成测试**

```typescript
// tests/integration/feishu-live-progress.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestBot, type TestBot } from '../helpers/feishu-bot';
import { isSessionProcessing } from '../../src/feishu/live-progress';

describe('Feishu live progress integration', () => {
  let env: TestBot;
  let tmpDir: string;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'live-progress-test-' });
    tmpDir = mkdtempSync(join(tmpdir(), 'live-jsonl-'));
  });

  afterEach(() => {
    env.cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scenario A: doSwitch to running feishu session starts watcher', async () => {
    env.registry.upsert('running-uuid', {
      origin: 'feishu', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Running', message_count: 1, last_message_preview: 'p',
    });

    // Mock listSessions to return this uuid as running
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid', pid: 12345, cwd: '/tmp/proj', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      // Mock cardReplyFn to return a fake message id
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch',
        content: JSON.stringify({ text: '/switch running-uuid' }),
        chat_type: 'p2p', message_type: 'text',
      });

      // Drain queue
      await env.bot.dispatch();

      // 验证：liveWatchers 中有这个 openId 的 watcher
      const watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario B: doSwitch to idle session does NOT start watcher', async () => {
    env.registry.upsert('idle-uuid', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle', message_count: 1, last_message_preview: 'p',
    });

    // Empty listSessions
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_idle',
        content: JSON.stringify({ text: '/switch idle-uuid' }),
        chat_type: 'p2p', message_type: 'text',
      });

      await env.bot.dispatch();

      const watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(false);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario C: user sends new message → watcher stops', async () => {
    // Set up running session
    env.registry.upsert('running-uuid-c', {
      origin: 'feishu', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Running C', message_count: 1, last_message_preview: 'p',
    });
    env.userManager['setSession' + 'Bypass'] = async () => {};  // noop placeholder
    await env.userManager.compareAndSwap(
      'ou_user1', null,
      { type: 'session', sessionUuid: 'running-uuid-c', cwd: '/tmp/proj' },
    );

    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-c', pid: 12345, cwd: '/tmp/proj', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      // First: switch
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_c',
        content: JSON.stringify({ text: '/switch running-uuid-c' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      let watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);

      // Then: send a new chat message
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_new_chat_c',
        content: JSON.stringify({ text: '继续分析' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      // 验证：watcher 已 stop
      watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(false);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario D: continuous /switch A → /switch B → A watcher stops, B starts', async () => {
    // 两个 session
    env.registry.upsert('uuid-a', {
      origin: 'feishu', cwd: '/tmp/a', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'A', message_count: 1, last_message_preview: 'p',
    });
    env.registry.upsert('uuid-b', {
      origin: 'feishu', cwd: '/tmp/b', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'B', message_count: 1, last_message_preview: 'p',
    });

    // 两者都 running
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'uuid-a', pid: 1, cwd: '/tmp/a', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
      { sessionId: 'uuid-b', pid: 2, cwd: '/tmp/b', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      // Switch to A
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_a',
        content: JSON.stringify({ text: '/switch uuid-a' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      let watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);
      const watcherA = watchers.get('ou_user1');
      expect(watcherA.deps.uuid).toBe('uuid-a');

      // Switch to B
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_b',
        content: JSON.stringify({ text: '/switch uuid-b' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      // 验证：A watcher 已 stop（stopped=true），B watcher 是新的
      expect(watcherA.stopped).toBe(true);
      watchers = (env.bot as any).liveWatchers as Map<string, any>;
      const watcherB = watchers.get('ou_user1');
      expect(watcherB).toBeDefined();
      expect(watcherB.deps.uuid).toBe('uuid-b');
      expect(watcherB).not.toBe(watcherA);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('isSessionProcessing: feishu in-memory wins over CLI detection', async () => {
    // 即使 CLI marker 说不活跃，feishu in-memory 命中也算 processing
    const bot = {
      sessionManager: {
        listSessions: () => [{ sessionId: 'mixed-uuid' }],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('mixed-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认全部通过**

Run: `bun test tests/integration/feishu-live-progress.test.ts 2>&1 | tail -10`
Expected: 5 pass / 0 fail

**如果失败**：
- "TypeError: buildLiveOverviewCard is not a function" → 确认 Task 6 步骤 2 已加 `buildLiveOverviewCard` 方法
- "watchers.has is not a function" → `liveWatchers` 是 `Map`，应该 `.has` 没问题
- "userManager['setSession' + 'Bypass']" — 那是 placeholder，删掉它

- [ ] **Step 3: 跑全套测试，确保无回归**

Run: `bun test 2>&1 | tail -5`
Expected: 全部 pass（基线 444 + 新增 5 = 449 / 0 fail）

- [ ] **Step 4: 跑 typecheck**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 干净

- [ ] **Step 5: Commit**

```bash
git add tests/integration/feishu-live-progress.test.ts
git commit -m "test(integration): live progress card scenarios A/B/C/D"
```

---

## Task 11: 全量验证 + 部署

**Files:** 无（只跑命令）

- [ ] **Step 1: 全套单测 + 集成测试**

Run: `bun test 2>&1 | tail -3`
Expected: 0 fail

- [ ] **Step 2: typecheck**

Run: `bun run typecheck 2>&1 | tail -3`
Expected: 干净

- [ ] **Step 3: 部署到生产 daemon**

Run: `bun run deploy 2>&1 | tail -10`
Expected: 显示 "✅ cc-linker 已在后台启动 (PID: ...)"

- [ ] **Step 4: 验证 daemon 状态**

Run: `bun run dev daemon status 2>&1 | head -5`
Expected: "✅ cc-linker 正在运行 (PID: ...)"

- [ ] **Step 5: 手工冒烟（飞书端）**

1. 在飞书发 `sleep 50`（或类似长任务）
2. 在飞书 `/list` 找该 session
3. 切到该 session（`/switch <id>` 或卡片按钮）
4. 观察 15s 内卡片自动刷新，看到 "🤖 最后回复 _(实时)_"
5. 等任务完成，卡片应转为蓝色"已切换会话"模板
6. 再次切到该 session（已闲），不应有 live watcher

- [ ] **Step 6: 手工冒烟（CLI 端）**

1. 在终端跑 `cc-linker ...`（长任务，需有 activity-marker 输出）
2. 飞书 `/list` 找该 session（origin=cli）
3. 切过去 → 观察 15s 卡片自动刷新
4. CLI 任务完成 → 卡片应转蓝色

- [ ] **Step 7: 报告**

按 change-delivery-gate 输出：
- ✅ 修改了哪些文件（src/feishu/{bot,live-progress}.ts, src/scanner/jsonl.ts, src/cli/commands/start.ts, tests/...）
- ✅ 测试结果（449 pass / 0 fail）
- ✅ 部署状态（daemon 新 PID）
- ✅ 手工冒烟通过
