# 飞书并发命令 PR 3: overview 卡片 + list 标记 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在飞书侧点击"切换"时收到 overview 卡片（含最后提问 + 最后回复 + 元信息 + 🔴 运行中标记），`/list` 卡片在每条 session 标题前加 🔴 标记——**修复痛点 B"切换看不到进展"**。

**Architecture:** 新增 `buildSessionOverviewCard(uuid, entry, isRunning)` 纯函数构造交互卡片。`doSwitch` 改造为：swapped=true → 调 `isSessionRunning` 检查目标 session 是否在跑 → 发卡片（或 text 降级）；swapped=false → 发"切换失败"消息。`buildListCard` 加 `runningUuids: Set<string>` 参数，`doCardList` 内部从 `sessionManager.listSessions()` 计算并传入。text 降级路径同步加 `[运行中]` 标记保持 UX 一致。

**Tech Stack:** Bun + TypeScript + `bun:test`（复用现有 bot.test.ts 模式）。PR 1（schema + scanner preview）必须先合，PR 2（serialKey）独立但建议在 PR 3 前合。

**Spec:** `docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md` 改动 3-4 + §1 组件 4-6 + §7 集成测试

**Prerequisite:** PR 1（schema v4 + scanner preview 字段）已合——overview 卡片需要 `last_user_preview` / `last_assistant_preview` 字段。PR 2（serialKey）独立。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/feishu/bot.ts` | **修改**:加 `buildSessionOverviewCard` 函数 + 本地 `esc()` helper（PR 2 review 移除了）+ `isSessionRunning` 方法 + 改 `doSwitch` + 改 `buildListCard`（加 🔴 + AI 末条）+ 改 `doCardList` + **修 doCardList `msg!` 预存在 bug** |
| `tests/unit/feishu/bot-do-switch.test.ts` | **新增**:6 个 doSwitch 行为测试（**无 `config.load()`**） |
| `tests/unit/feishu/bot-do-card-list.test.ts` | **新增**:5 个 doCardList 行为测试（**无 `config.load()`**） |
| `tests/integration/feishu-concurrent-commands.test.ts` | **新增**:2 个集成测试（**无 `config.load()`**） |
| `tests/unit/feishu/bot.test.ts` | **修改**:line 620 测试改 cardReplies 断言 |

---

## Task 1: 写 failing test 给 doSwitch 发 overview 卡片

**Files:**
- Create: `tests/unit/feishu/bot-do-switch.test.ts`

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/feishu/bot-do-switch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';

describe('FeishuBot doSwitch overview card', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let textReplies: Array<{ text: string; openId?: string; messageId?: string }>;
  let cardReplies: Array<{ card: any; openId?: string; messageId?: string }>;
  let bot: FeishuBot;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-doswitch-test-'));

    // 不要用 config.load() —— 该方法不存在（参考 tests/unit/feishu/bot-serial-key.test.ts:13-14）。
    // 路径通过构造函数显式传入 tmpDir 子路径,config 用全局默认值。

    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    spoolQueue = new SpoolQueue(tmpDir);
    registry = new RegistryManager(tmpDir);
    sessionManager = new ClaudeSessionManager();

    textReplies = [];
    cardReplies = [];

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn: async (text, opts) => {
        textReplies.push({ text, openId: opts?.openId, messageId: opts?.messageId });
        return 'reply-id-' + textReplies.length;
      },
      cardReplyFn: async (card, opts) => {
        cardReplies.push({ card, openId: opts?.openId, messageId: opts?.messageId });
        return 'card-id-' + cardReplies.length;
      },
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('doSwitch sends overview card when session is found and swapped', async () => {
    // 准备 session
    registry.upsert('test-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Test Session',
      message_count: 5,
      last_message_preview: 'old preview',
      last_user_preview: 'How do I parse JSON?',
      last_assistant_preview: 'Use JSON.parse()',
    });

    // 直接调 doSwitch（通过 card action 路径）
    const result = await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'test-uuid-1234' },
      message: { message_id: 'msg-test-1' },
    });

    // 验证：发了 1 张卡片
    expect(cardReplies.length).toBe(1);
    expect(textReplies.length).toBe(0);

    // 卡片 header 应包含 "已切换会话"
    const card = cardReplies[0].card;
    expect(card.header.title.content).toContain('已切换会话');

    // 卡片 elements 应包含 last_user_preview 和 last_assistant_preview
    const allContent = JSON.stringify(card.elements);
    expect(allContent).toContain('How do I parse JSON');
    expect(allContent).toContain('Use JSON.parse');
  });

  it('doSwitch sends error text when session is not found', async () => {
    const result = await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'nonexistent-uuid' },
      message: { message_id: 'msg-test-2' },
    });

    // 验证：发 text 消息（不卡片）
    expect(textReplies.length).toBe(1);
    expect(cardReplies.length).toBe(0);
    expect(textReplies[0].text).toContain('未找到');
  });

  it('overview card includes running indicator when target session is active', async () => {
    registry.upsert('active-uuid-5678', {
      origin: 'feishu',
      cwd: '/tmp/active',
      project_name: 'active',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Active Session',
      message_count: 10,
      last_message_preview: 'current',
    });

    // 模拟 listSessions 返回这个 session（在跑）
    // 通过 spy 拦截 listSessions 调用
    const originalListSessions = sessionManager.listSessions.bind(sessionManager);
    (sessionManager as any).listSessions = () => [
      { sessionId: 'active-uuid-5678', pid: 12345, cwd: '/tmp/active', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'active-uuid-5678' },
        message: { message_id: 'msg-test-3' },
      });
    } finally {
      (sessionManager as any).listSessions = originalListSessions;
    }

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    expect(allContent).toContain('🔴');  // running mark
    expect(allContent).toContain('处理中');
  });

  it('overview card text fallback includes key info when cardReplyFn returns null', async () => {
    registry.upsert('test-uuid-fallback', {
      origin: 'cli',
      cwd: '/tmp/fb',
      project_name: 'fb',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Fallback Test',
      message_count: 3,
      last_message_preview: 'old',
      last_user_preview: 'fallback user prompt',
      last_assistant_preview: 'fallback assistant reply',
    });

    // 临时让 cardReplyFn 返回 null
    const originalCardFn = bot['cardReplyFn'];
    (bot as any).cardReplyFn = async () => null;

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'test-uuid-fallback' },
        message: { message_id: 'msg-test-4' },
      });
    } finally {
      (bot as any).cardReplyFn = originalCardFn;
    }

    // 验证：发 text 消息（卡片失败降级）
    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('已切换到');
    expect(textReplies[0].text).toContain('fallback user prompt');
    expect(textReplies[0].text).toContain('fallback assistant reply');
  });

  it('overview card escapes < and > in previews', async () => {
    registry.upsert('escape-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/escape',
      project_name: 'esc',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Escape Test',
      message_count: 1,
      last_message_preview: 'old',
      last_user_preview: 'What does <script> do?',
      last_assistant_preview: '> It runs JavaScript <code>',
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'escape-uuid-1234' },
      message: { message_id: 'msg-test-5' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    // < > 必须被转义（防止 markdown 注入）
    expect(allContent).toContain('&lt;script&gt;');
    expect(allContent).toContain('&lt;code&gt;');
    // 原字符不应直接出现
    expect(allContent).not.toContain('<script>');
  });

  // ===== 【review 必加】补充测试覆盖盲区 =====

  it('doSwitch sends failure text when CAS swap fails (swapped=false)', async () => {
    // 准备 session
    registry.upsert('swapfail-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/swapfail',
      project_name: 'sf',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Swap Fail Session',
      message_count: 1,
      last_message_preview: 'preview',
      last_user_preview: 'should not appear',
      last_assistant_preview: 'should not appear',
    });

    // 强制 userManager.compareAndSwap 返回 false（模拟并发冲突）
    const originalCompareAndSwap = userManager.compareAndSwap.bind(userManager);
    (userManager as any).compareAndSwap = async () => false;

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'swapfail-uuid-1234' },
        message: { message_id: 'msg-test-swapfail' },
      });
    } finally {
      (userManager as any).compareAndSwap = originalCompareAndSwap;
    }

    // 验证：发"切换失败"消息（绝不卡片，避免误导用户以为切换成功）
    expect(textReplies.length).toBe(1);
    expect(cardReplies.length).toBe(0);
    expect(textReplies[0].text).toBe('⚠️ 切换失败，会话可能已被修改');
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-switch.test.ts`
Expected: 6 个测试全失败——当前 `doSwitch` 仍发 text 消息（`✅ 已切换到会话 xxx`），不发卡片。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/feishu/bot-do-switch.test.ts
git commit -m "test(bot): add doSwitch overview card test suite (red)"
```

---

## Task 2: 实现 buildSessionOverviewCard + isSessionRunning

**Files:**
- Modify: `src/feishu/bot.ts`（在 `buildListCard` 函数闭合之后追加新函数 + 在 `doResume` 之前追加 `isSessionRunning` 私有方法 + 在文件底部追加本地 `esc()` helper）

**【前置确认 / review 必读】**：
- `esc()` 在 `bot.ts` 中**当前不存在**——PR 2 的 code review（commit `098ba82 refactor(bot): drop unused esc() helper`）主动移除了它（YAGNI）。**必须在本 Task 重新定义**，否则 `buildSessionOverviewCard` 内的 `esc(entry.last_user_preview)` / `esc(entry.last_assistant_preview)` 引用会导致 typecheck 失败。
- `preview()` 在 `bot.ts:2295` 已存在（顶层函数），`buildSessionOverviewCard` 不需要重新定义。
- `formatTimeAgo()` / `formatOrigin()` 都是顶层函数，已存在。

- [ ] **Step 1: 在 buildListCard 函数闭合之后插入 buildSessionOverviewCard**

`buildListCard` 当前在 `bot.ts:2137-2171` 范围。**关键**：插入位置是 `buildListCard` 的**闭合 `}` 之后**（约 line 2171），**不是 line 2137**——在 2137 之后插入会进入 `buildListCard` 内部。

在 `buildListCard` 函数闭合 `}` 之后插入:

```typescript
/** Build an overview card for the user to see session progress after switch. */
function buildSessionOverviewCard(
  uuid: string,
  entry: { title?: string | null; cwd?: string; message_count: number; last_active: string; last_user_preview?: string; last_assistant_preview?: string },
  isRunning: boolean,
): Record<string, unknown> {
  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${entry.title ?? 'Untitled'}`;

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔄 已切换会话' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${entry.cwd ?? '-'}\`` },
      ...(entry.last_user_preview ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(entry.last_user_preview)}` }] : []),
      ...(entry.last_assistant_preview ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(entry.last_assistant_preview)}` }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: `📊 ${entry.message_count} 条消息${entry.last_active ? ' · ' + formatTimeAgo(entry.last_active) : ''}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}
```

- [ ] **Step 2: 在 bot.ts 底部追加本地 `esc()` helper（review 必加）**

`esc()` 被 `buildSessionOverviewCard` 引用，但 `bot.ts` 当前没有此函数（PR 2 review 已移除）。在 `bot.ts` 底部、与 `preview()` / `buildSessionTitle()` 同区域（即 file 末尾的顶层函数区，约 line 2295-2370 之后）追加:

```typescript
/** Escape < and > in markdown content to prevent injection.
 *  Local copy — card-updater.ts:448 也有同名私有实现。
 *  后续如出现第三处调用，应考虑抽到 src/feishu/markdown-escape.ts 共享（PR 2 评审意见）。
 */
function esc(text: string): string {
  return text.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
}
```

- [ ] **Step 3: 加 isSessionRunning 私有方法**

在 `doResume` 方法之前（当前 `doResume` 在 `bot.ts:2099-2107`）插入新方法。**注意位置**：插入到 `doResume`（即 `private async doResume(openId: string, uuid: string, messageId?: string): Promise<string> {` 之前）:

```typescript
  /** Check if a session is currently being processed by Claude (in active processes). */
  private isSessionRunning(uuid: string): boolean {
    return this.sessionManager.listSessions().some(s => s.sessionId === uuid);
  }
```

- [ ] **Step 4: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过（`esc()` 已 Step 2 定义）。

- [ ] **Step 5: 跑测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-switch.test.ts`
Expected: 6 个测试**仍然全失败**——doSwitch 还没改用 buildSessionOverviewCard。

- [ ] **Step 6: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): add buildSessionOverviewCard + isSessionRunning + local esc()"
```

---

## Task 3: 改造 doSwitch 走 overview 卡片

**Files:**
- Modify: `src/feishu/bot.ts:1931-1958`（doSwitch 完整重写，**注：原计划标注的 1897-1924 是过时的行号**，实际位置请按代码 anchor 定位）

- [ ] **Step 1: 替换 doSwitch 实现**

定位方法：在编辑器中搜索 `private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage): Promise<string> {`（约 line 1931）。把整个 `doSwitch` 方法（直到下一个 `private async doSelectModel` 之前，约 line 1958）替换为:

```typescript
  private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage): Promise<string> {
    const session = this.registry.get(uuid);
    if (!session) {
      const reply = '未找到对应会话，请先执行 /list。';
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return reply;
    }

    const currentEntry = this.userManager.getEntry(openId);
    const swapped = await this.userManager.compareAndSwap(
      openId,
      currentEntry ?? null,
      {
        ...currentEntry,
        type: 'session',
        sessionUuid: uuid,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd: session.cwd,
      },
    );

    // swapped=false 时发"切换失败"消息（不发 overview 卡片，避免误导用户）
    if (!swapped) {
      const failReply = '⚠️ 切换失败，会话可能已被修改';
      if (msg) await this.replyAndFinalize(msg, failReply);
      else await this.replyFn(failReply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return 'failed';
    }

    // swapped=true：判断目标 session 是否正在跑 Claude
    const isRunning = this.isSessionRunning(uuid);

    // 发概览卡片
    const card = buildSessionOverviewCard(uuid, session, isRunning);
    const replyId = await this.cardReplyFn(card, { messageId, openId });

    if (replyId) {
      if (msg) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
    } else {
      // 降级到 text
      const reply = `✅ 已切换到 ${uuid.slice(0, 8)}\n💬 最后提问：${session.last_user_preview ?? '无'}\n🤖 最后回复：${session.last_assistant_preview ?? '无'}\n📊 ${session.message_count} 条消息${session.last_active ? ' · ' + formatTimeAgo(session.last_active) : ''}`;
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');  // 【review 必加】补回 recordReceipt,避免 card action 路径同 messageId 重复入队
    }
    return 'switched';
  }
```

- [ ] **Step 2: 跑测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-switch.test.ts`
Expected: 6 个测试全过。

- [ ] **Step 3: 跑现有 bot.test.ts 看 line 620 是否失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot.test.ts 2>&1 | head -100`
Expected: `handleCardAction routes switch with UUID` 测试**会失败**（line 620），因为原断言 `expect(textReplies[0]).toContain('已切换到会话')` 不再成立（现在发卡片不是 text）。

- [ ] **Step 4: 记录 bot.test.ts:620 失败**

先**不要修复**——这是 Task 5 的工作。继续。

- [ ] **Step 5: Commit doSwitch 改造**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): doSwitch sends overview card with running marker + text fallback"
```

---

## Task 4: 写 failing test 给 buildListCard + doCardList running 标记

**Files:**
- Create: `tests/unit/feishu/bot-do-card-list.test.ts`（新文件，与 bot-do-switch.test.ts 并列）

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/feishu/bot-do-card-list.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';

describe('FeishuBot doCardList running marker', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let textReplies: Array<{ text: string; openId?: string }>;
  let cardReplies: Array<{ card: any; openId?: string }>;
  let bot: FeishuBot;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-list-test-'));

    // 不要用 config.load() —— 该方法不存在（参考 tests/unit/feishu/bot-serial-key.test.ts:13-14）。
    // 路径通过构造函数显式传入 tmpDir 子路径,config 用全局默认值。

    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    spoolQueue = new SpoolQueue(tmpDir);
    registry = new RegistryManager(tmpDir);
    sessionManager = new ClaudeSessionManager();

    textReplies = [];
    cardReplies = [];

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn: async (text, opts) => {
        textReplies.push({ text, openId: opts?.openId });
        return 'reply-id-' + textReplies.length;
      },
      cardReplyFn: async (card, opts) => {
        cardReplies.push({ card, openId: opts?.openId });
        return 'card-id-' + cardReplies.length;
      },
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list card shows 🔴 mark for running sessions', async () => {
    registry.upsert('running-uuid-1', {
      origin: 'cli',
      cwd: '/tmp/running',
      project_name: 'running',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Running Session',
      message_count: 3,
      last_message_preview: 'preview',
    });
    registry.upsert('idle-uuid-2', {
      origin: 'cli',
      cwd: '/tmp/idle',
      project_name: 'idle',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Idle Session',
      message_count: 1,
      last_message_preview: 'idle preview',
    });

    // 模拟 running-uuid-1 正在跑
    (sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-1', pid: 12345, cwd: '/tmp/running', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-1' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    expect(allContent).toContain('🔴 Running Session');
    expect(allContent).toContain('Idle Session');
    // Idle session 不应有 🔴
    expect(allContent).not.toContain('🔴 Idle Session');
  });

  it('list card text fallback shows [运行中] for running sessions', async () => {
    registry.upsert('running-uuid-3', {
      origin: 'cli',
      cwd: '/tmp/r3',
      project_name: 'r3',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Running Three',
      message_count: 5,
      last_message_preview: 'p',
    });

    (sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-3', pid: 999, cwd: '/tmp/r3', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    // 让 cardReplyFn 返回 null 触发 text fallback
    (bot as any).cardReplyFn = async () => null;

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-2' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('[运行中]');
    expect(textReplies[0].text).toContain('Running Three');
  });

  // ===== 【review 必加】补充测试覆盖盲区 =====

  it('list card shows no 🔴 mark when listSessions is empty (negative case)', async () => {
    // 准备 2 个 sessions
    registry.upsert('idle-a', {
      origin: 'cli', cwd: '/tmp/a', project_name: 'a', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle A', message_count: 1, last_message_preview: 'p',
    });
    registry.upsert('idle-b', {
      origin: 'cli', cwd: '/tmp/b', project_name: 'b', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle B', message_count: 1, last_message_preview: 'p',
    });

    // listSessions 返回空 → 没有 session 应该被标 🔴
    (sessionManager as any).listSessions = () => [];

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-empty' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    expect(allContent).not.toContain('🔴');
    // 标题应存在
    expect(allContent).toContain('Idle A');
    expect(allContent).toContain('Idle B');
  });

  it('list card displays AI 末条 preview when last_assistant_preview exists', async () => {
    registry.upsert('preview-uuid-1', {
      origin: 'cli', cwd: '/tmp/p', project_name: 'p', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Preview Session', message_count: 1, last_message_preview: 'p',
      last_assistant_preview: 'This is a test assistant response that should appear in the list card',
    });

    (sessionManager as any).listSessions = () => [];

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-preview' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    // 🤖 标记 + 60 字符截断版的 AI 末条
    expect(allContent).toContain('🤖');
    expect(allContent).toContain('This is a test assistant response that should appear');
  });

  it('runningUuids filters out empty sessionId from spawning sessions', async () => {
    // 准备一个真实存在的 session
    registry.upsert('real-uuid-filter', {
      origin: 'cli', cwd: '/tmp/rf', project_name: 'rf', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Real Filter Session', message_count: 1, last_message_preview: 'p',
    });

    // mock: 一个空 sessionId（新 session 正在 spawn，sessionId 还没解析）+ 一个真实 sessionId
    // plan 中 doCardList 用 .filter(Boolean) 过滤空 sessionId，避免误把 '' 加进 runningUuids Set
    (sessionManager as any).listSessions = () => [
      { sessionId: '', pid: 111, cwd: '/tmp/spawning', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: true },
      { sessionId: 'real-uuid-filter', pid: 222, cwd: '/tmp/rf', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-filter' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    // 真实 session 应该有 🔴
    expect(allContent).toContain('🔴 Real Filter Session');
    // 因为 registry 中没有 '' 这个 uuid，所以空 sessionId 不会出现在卡片中（这是间接验证 filter 工作）
    // 但更重要的是：没有任何 "🔴" 误标到不存在的 session 上
    const runningMatches = allContent.match(/🔴/g) ?? [];
    expect(runningMatches.length).toBe(1);  // 只有 real-uuid-filter 一个 🔴
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-card-list.test.ts`
Expected: 5 个测试全失败——当前 `buildListCard` 不接受 `runningUuids` 参数，`doCardList` 也没计算 runningUuids。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/feishu/bot-do-card-list.test.ts
git commit -m "test(bot): add doCardList running marker tests (red)"
```

---

## Task 5: 改 buildListCard 接受 runningUuids + doCardList 计算并传入

**Files:**
- Modify: `src/feishu/bot.ts:2137-2171`（buildListCard 签名加 runningUuids + 渲染循环加 🔴 标记 + AI 末条）—— **注：原计划标注的 2104-2137 是过时行号**，按代码 anchor 定位
- Modify: `src/feishu/bot.ts:1839-1888`（doCardList 计算 runningUuids 并传入 + text 降级加 [运行中]）—— **注：原计划标注的 1805-1854 是过时行号**

**【review 必加】**：原计划遗漏了**设计文档 §6 改动 4 要求的 AI 末条显示**——`🤖 ${preview(entry.last_assistant_preview, 60)}`。本次同步实现，保持 list 卡片信息密度与设计文档一致。

- [ ] **Step 1: 改 buildListCard 签名**

定位方法：搜索 `function buildListCard(sessions: Array<[string, { title?: string; origin: string; message_count: number; last_active: string; status?: string; project_name?: string; cwd?: string }]>, total: number, hasMore: boolean)`（约 line 2138）。把函数签名改为:

```typescript
function buildListCard(
  sessions: Array<[string, { title?: string; origin: string; message_count: number; last_active: string; status?: string; project_name?: string; cwd?: string; last_assistant_preview?: string }]>,
  total: number,
  hasMore: boolean,
  runningUuids: Set<string>,
): Record<string, unknown> {
```

- [ ] **Step 2: 改 buildListCard 渲染循环（🔴 标记 + AI 末条）**

定位方法：搜索 `for (const [uuid, entry] of sessions) {`（约 line 2144）。把整个循环体（到 `if (index < sessions.length) {` 之前）改为:

```typescript
    for (const [uuid, entry] of sessions) {
      const index = sessions.findIndex(s => s[0] === uuid) + 1;
      const runningMark = runningUuids.has(uuid) ? '🔴 ' : '';
      const aiPreviewLine = entry.last_assistant_preview
        ? `\n🤖 ${preview(entry.last_assistant_preview, 60)}`
        : '';
      elements.push({
        tag: 'markdown',
        content: `**${index}. ${runningMark}${entry.title ?? 'Untitled'}**\nID: \`${uuid.slice(0, 8)}\` | ${entry.message_count}条 | ${formatTimeAgo(entry.last_active)} | ${formatOrigin(entry.origin, entry.status)} | ${entry.project_name ?? ''}\n📁 \`${entry.cwd ?? '-'}\`${aiPreviewLine}`,
      });
```

**注意**：`preview()` 是 `bot.ts` 顶层函数（约 line 2295），与 `buildListCard` 同模块，无需 import。

- [ ] **Step 3: 改 doCardList 计算 runningUuids 并传入 buildListCard**

定位方法：搜索 `const card = buildListCard(`（在 `doCardList` 内部，约 line 1856）。把这段 buildListCard 调用改为:

```typescript
    const runningUuids = new Set(
      this.sessionManager.listSessions()
        .map(s => s.sessionId)
        .filter((id): id is string => Boolean(id))
    );

    const card = buildListCard(
      sessions as Array<[string, { title?: string; origin: string; message_count: number; last_active: string; status?: string; project_name?: string; cwd?: string; last_assistant_preview?: string }]>,
      allSessions.length,
      hasMore,
      runningUuids,
    );
    const replyId = await this.cardReplyFn(card, { messageId, openId });
```

- [ ] **Step 4: 改 doCardList text 降级路径加 [运行中] 标记**

定位方法：搜索 `// Fallback to text`（在 `doCardList` 内部，约 line 1871）。把 text 分支的循环体改为:

```typescript
    } else {
      // Fallback to text（卡片与 text 必须展示相同的运行中状态，保持 UX 一致）
      const lines = [`📋 我的会话（最近 ${sessions.length} 个，共 ${allSessions.length} 个）`, ''];
      for (const [index, [uuid, session]] of sessions.entries()) {
        const providerTag = session.lastKnownProvider
          ? ` [${session.lastKnownProvider}]`
          : '';
        const runningTag = runningUuids.has(uuid) ? ' [运行中]' : '';
        lines.push(`${index + 1}. ${session.title ?? 'Untitled'}${providerTag}${runningTag}`);
        lines.push(`   ID: ${uuid.slice(0, 8)}`);
        lines.push(`   ${formatOrigin(session.origin, session.status)} | ${session.message_count}条 | ${formatTimeAgo(session.last_active)} | ${session.project_name ?? basename(session.cwd)}`);
        lines.push('');
      }
```

- [ ] **Step 4.5: 修 doCardList text fallback 的 `msg!` 预存在 bug（review 必加）**

**【背景】**：`bot.ts:1886` 当前有 `await this.replyAndFinalize(msg!, lines.join('\n'));` —— `msg!` 是非空断言,但 msg 在 card action 路径（`handleCardAction` 调用 `doCardList(openId, messageId)`）上是 undefined，运行时会在 `replyTo` 内部 `msg.messageId` 抛 `Cannot read property 'messageId' of undefined`。

**【影响 Task 4 测试 2】**："list card text fallback shows [运行中]" 测试会强制 cardReplyFn 返回 null + 走 card action 路径，**当前代码会在该测试中崩溃**。必须在 Task 5 一并修掉，否则测试永远跑不到断言。

定位方法：搜索 `await this.replyAndFinalize(msg!, lines.join('\n'));`（在 `doCardList` 的 `// Fallback to text` 分支末尾）。把这段替换为：

```typescript
      if (msg) {
        await this.replyAndFinalize(msg, lines.join('\n'));
      } else {
        // card action 路径（msg=undefined）—— replyFn + recordReceipt，与 doSwitch text fallback 一致
        await this.replyFn(lines.join('\n'), { messageId, openId, requestUuid: uniqueUuid() });
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
```

**【与 doSwitch 对照】**：plan Task 3 的新版 doSwitch 在 text fallback 已正确使用 `if (msg)` 分支（line 416-422）。doCardList 应同步，保持 doSwitch / doCardList 的对称性。

- [ ] **Step 5: 跑测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-card-list.test.ts`
Expected: 5 个测试全过（**前提：Step 4.5 的 `msg!` 修复已合**）。

- [ ] **Step 6: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): buildListCard/doCardList show running marker + text fallback consistency"
```

---

## Task 6: 更新现有 bot.test.ts:620 测试

**Files:**
- Modify: `tests/unit/feishu/bot.test.ts:620-638`

- [ ] **Step 1: 改 line 620 测试断言**

修改 `tests/unit/feishu/bot.test.ts:620-638` 的整个 `it()` 块:

把:
```typescript
  it('handleCardAction routes switch with UUID', async () => {
    registry.upsert('test-session-uuid', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Test Session',
      message_count: 5,
      last_active: new Date().toISOString(),
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'test-session-uuid' },
      message: { message_id: 'msg-card-3' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('已切换到会话');
  });
```

改为:
```typescript
  it('handleCardAction routes switch with UUID sends overview card', async () => {
    registry.upsert('test-session-uuid', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Test Session',
      message_count: 5,
      last_active: new Date().toISOString(),
      last_user_preview: 'test user prompt',
      last_assistant_preview: 'test assistant reply',
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'test-session-uuid' },
      message: { message_id: 'msg-card-3' },
    });

    // 改造后：doSwitch 发 overview 卡片，不再发 text 消息
    expect(textReplies.length).toBe(0);
    expect(cardReplies.length).toBe(1);
    expect(cardReplies[0].card.header.title.content).toContain('已切换会话');
  });
```

**注意**：`bot.test.ts:620` 测试在 `describe('FeishuBot cards', ...)` 块内（line 548 起始），该 describe 块的 beforeEach **已经声明了 `cardReplies` 和 `cardReplyFn`**（line 550 / 572-575 / 590）。**不需要新增任何声明**。原计划此处"很可能没有声明 cardReplies"是基于错误假设的提示，可直接忽略。

**唯一约束**：line 620 测试的 `textReplies` 是 `string[]`（裸字符串数组），`cardReplies` 是 `Record<string, unknown>[]`（对象数组）。**断言用 `cardReplies[0].card.header...`**（属性访问），不要用 `textReplies[0]` 那种字符串 `.toContain()`。上面代码片段已正确处理。

- [ ] **Step 2: 跑 bot.test.ts**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot.test.ts`
Expected: line 620 测试通过，**所有其他测试也通过**。

- [ ] **Step 3: 跑 doCardList + doSwitch 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-do-switch.test.ts tests/unit/feishu/bot-do-card-list.test.ts`
Expected: 11 个新测试全过（6 doSwitch + 5 doCardList）。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/feishu/bot.test.ts
git commit -m "test(bot): update handleCardAction switch test to assert overview card"
```

---

## Task 7: 集成测试（MUST）

**Files:**
- Create: `tests/integration/feishu-concurrent-commands.test.ts`（新文件，集成测试）

- [ ] **Step 1: 写集成测试**

新建 `tests/integration/feishu-concurrent-commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../src/feishu/bot';
import { UserManager } from '../../src/feishu/mapping';
import { ListSnapshotManager } from '../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../src/queue/spool';
import { RegistryManager } from '../../src/registry/registry';
import { ClaudeSessionManager } from '../../src/proxy/session';

/**
 * 集成测试：模拟真实并发场景。
 * 不依赖飞书网络，用 mock 飞书 client。
 */
describe('Feishu concurrent commands integration', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let bot: FeishuBot;
  let textReplies: any[];
  let cardReplies: any[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'integration-test-'));

    // 不要用 config.load() —— 该方法不存在（参考 tests/unit/feishu/bot-serial-key.test.ts:13-14）。
    // 路径通过构造函数显式传入 tmpDir 子路径,config 用全局默认值。

    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    spoolQueue = new SpoolQueue(tmpDir);
    registry = new RegistryManager(tmpDir);
    sessionManager = new ClaudeSessionManager();

    textReplies = [];
    cardReplies = [];

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn: async (text, opts) => {
        textReplies.push({ text, openId: opts?.openId });
        return 'r' + textReplies.length;
      },
      cardReplyFn: async (card, opts) => {
        cardReplies.push({ card, openId: opts?.openId });
        return 'c' + cardReplies.length;
      },
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 辅助：让 dispatch 跑一轮
  async function dispatchOnce(): Promise<void> {
    // bot.dispatch() 是内部方法——通过 onMessage + 直接调 dispatch 模拟
    // 实际集成需要直接调内部方法
    await (bot as any).dispatch();
  }

  it('scenario A: /list works independently of /new -- prompt', async () => {
    // 准备：注册一个 session，让 /list 有内容
    registry.upsert('existing-session-1', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Existing', message_count: 1, last_message_preview: 'p',
    });

    // 发送 /new -- prompt
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_1',
      content: JSON.stringify({ text: '/new -- hello' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 发送 /list
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_list_1',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 验证：两条消息都入队，serialKey 不同
    const pending = readdirSync(join(tmpDir, 'pending'));
    const newFile = pending.find(f => f.includes('om_new_1'));
    const listFile = pending.find(f => f.includes('om_list_1'));
    expect(newFile).toMatch(/^cmd:ou_user1:om_new_1:/);
    expect(listFile).toMatch(/^cmd:ou_user1:om_list_1:/);
    expect(newFile).not.toBe(listFile);
  });

  it('scenario E: three /list commands queued independently', async () => {
    for (let i = 1; i <= 3; i++) {
      await bot.onMessage({
        open_id: 'ou_user1', message_id: `om_list_${i}`,
        content: JSON.stringify({ text: '/list' }),
        chat_type: 'p2p', message_type: 'text',
      });
    }

    const pending = readdirSync(join(tmpDir, 'pending'));
    expect(pending.length).toBe(3);
    // 三个不同的 cmd: serialKey
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_1:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_2:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_3:')).length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑集成测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/integration/feishu-concurrent-commands.test.ts`
Expected: 2 个集成测试全过。

- [ ] **Step 3: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/integration/feishu-concurrent-commands.test.ts
git commit -m "test(integration): add concurrent commands scenarios A and E"
```

---

## Task 8: 全量测试验证

- [ ] **Step 1: 跑全量单元 + 集成测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test`
Expected: 全过。

- [ ] **Step 2: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 跑测试覆盖率**

Run: `cd /cd-linker && bun test --coverage` 替换为 `cd /Users/wuyujun/Git/cc-linker && bun test --coverage`
Expected: bot.ts 覆盖率 ≥ 75%（doSwitch + doCardList + buildSessionOverviewCard + buildListCard 全部覆盖）。

- [ ] **Step 4: 手动 smoke test**

启动 daemon，飞书侧验证：
1. 启动一个 streaming session（用 `/new -- hello` 触发长任务）
2. 在 streaming 中发送 `/list` → 应立即返回列表卡片，含 🔴 标记
3. 点击列表中的"切换"按钮 → 应收到 overview 卡片，含最后提问 + 最后回复 + 🔴

- [ ] **Step 5: 验证无破坏后无 commit**

此 task 无代码修改。

---

## Task 9: Commit 全部 + 创建 PR

- [ ] **Step 1: 检查 git status**

Run: `cd /Users/wuyujun/Git/cc-linker && git status`
Expected: 干净。

- [ ] **Step 2: 推送到远端并创建 PR**

```bash
cd /Users/wuyujun/Git/cc-linker
git push origin <branch-name>
gh pr create --base master --title "feat(feishu): session overview card + list running marker" --body "$(cat <<'EOF'
## 概述
PR 3 of 3: 飞书侧 `doSwitch` 发 overview 卡片（含最后提问 + 最后回复 + 🔴 运行中），`doCardList` 在每条 session 标题前加 🔴 标记——**修复"切换看不到进展"的痛点 B**。

## 范围
- src/feishu/bot.ts: 加 `buildSessionOverviewCard` + `isSessionRunning` + 改 `doSwitch` + 改 `buildListCard` + 改 `doCardList`
- tests/unit/feishu/bot-do-switch.test.ts: 6 个新测试（原 5 + swapped=false 补充）
- tests/unit/feishu/bot-do-card-list.test.ts: 5 个新测试（原 2 + 空 listSessions / AI 末条 / 空 sessionId 过滤）
- tests/unit/feishu/bot.test.ts: 更新 line 620 测试断言
- tests/integration/feishu-concurrent-commands.test.ts: 2 个集成测试（场景 A、E）

## 工作原理
- `doSwitch`:
  - swapped=false → 发"切换失败"消息（不发卡片）
  - swapped=true → 调 `isSessionRunning(uuid)` → 发 overview 卡片
  - 卡片 API 失败 → 降级 text（含 preview）
- `doCardList`:
  - 从 `sessionManager.listSessions()` 计算 `runningUuids` Set
  - 卡片渲染时标题前加 🔴
  - text 降级路径同步加 `[运行中]`

## 测试
- 13 个新测试（6 doSwitch: 原 5 + swapped=false 补充 / 5 doCardList: 原 2 + 空 listSessions / AI 末条 / 空 sessionId 过滤 / 2 集成）
- 1 个现有测试更新（bot.test.ts:620）
- 现有测试 100% 不破坏

## 风险
- 行为变化：doSwitch 输出从 text 变 card（现有 line 620 测试已更新）
- 回滚简单：git revert，doSwitch 恢复到发 text 消息
- 依赖 PR 1（schema v4 + preview 字段）已合

## 部署
- 上线后立即生效
- 关键监控：`overview.card.sent` 应有日活用户级调用量
- 冒烟测试：streaming 中点切换 → 看到 overview 卡片 + 🔴

## 3 PR 全景回顾
- **PR 1**: schema v3→4 + scanner preview + cache schemaVersion
- **PR 2**: bot.ts serialKey 改造（解决 command 阻塞）
- **PR 3**（本 PR）: overview 卡片 + list 运行中标记（解决切换看不到进展）
EOF
)"
```

- [ ] **Step 3: 等 CI 通过后合并**

---

## Self-Review Checklist

执行时逐项检查：

- [ ] Task 1 测试文件 setup **未**用 `config.load()`（该方法不存在）；路径通过构造函数显式传 tmpDir
- [ ] Task 1 测试文件中 messageId 全部满足 `/^[a-zA-Z0-9_-]+$/`（PR 2 校验白名单），如 `om_list_1` / `msg-test-1` 都符合
- [ ] Task 1 **新增 swapped=false 测试**：mock `userManager.compareAndSwap = async () => false`，断言 `textReplies[0].text === '⚠️ 切换失败，会话可能已被修改'` + `cardReplies.length === 0`
- [ ] Task 2 `buildSessionOverviewCard` 接收 uuid 是因为 SessionEntry 没有 sessionId 字段（uuid 来自 registry key）
- [ ] Task 2 `esc()` 本地定义已添加（PR 2 已合但**移除了** `esc()`，必须在本 PR 重新定义）
- [ ] Task 2 `esc()` 插入位置：在 `bot.ts` 底部与 `preview()` / `buildSessionTitle()` 同区域（`buildSessionOverviewCard` 之前不可见 `esc`，会报"Cannot find name 'esc'"）
- [ ] Task 2 `buildSessionOverviewCard` 插入位置：在 `buildListCard` 函数**闭合 `}` 之后**（约 line 2171），**不是 line 2137 之后**
- [ ] Task 2 `isSessionRunning` 插入位置：在 `doResume` 方法之前（`private async doResume(openId: string, uuid: string, ...)` 锚点定位）
- [ ] Task 3 doSwitch swapped=false 路径**不**发卡片
- [ ] Task 3 doSwitch text 降级包含 last_user_preview / last_assistant_preview
- [ ] Task 3 doSwitch text 降级（msg=undefined 路径）末尾**补回** `this.spoolQueue.recordReceipt(messageId ?? '')`，避免 card action 路径同 messageId 重复入队（**review 必加**）
- [ ] Task 3 doSwitch 位置：搜索 `private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage)` 锚点（约 line 1931），原计划标注的 1897-1924 是过时行号
- [ ] Task 4 测试断言 `🔴 Running Session`（带空格），不是 `🔴Running`
- [ ] Task 4 **新增 3 个测试**：
  - "listSessions 为空时无 🔴 标记"（negative case）
  - "list 卡片显示 AI 末条 preview"（验证 `🤖 ${preview(...)}` 渲染）
  - "runningUuids 过滤空 sessionId"（mock listSessions 返回 `sessionId: ''`，断言不误标）
- [ ] Task 5 buildListCard 签名变更后，调用方都更新
- [ ] Task 5 buildListCard 渲染循环加 `🤖 ${preview(entry.last_assistant_preview, 60)}`（设计文档 §6 改动 4 要求，原计划遗漏，**review 必加**）
- [ ] Task 5 doCardList text 降级加 `[运行中]` 标记（与卡片一致）
- [ ] Task 5 所有 bot.ts 行号按代码 anchor 定位（`function buildListCard(` / `for (const [uuid, entry] of sessions)` / `// Fallback to text` / `private async doCardList(`），原计划标注的行号全部过时
- [ ] Task 5 **【P0 必改】** Step 4.5：修 `bot.ts:1886` 的 `msg!` 预存在 bug → 显式 `if (msg)` 分支 + 走 `replyFn + recordReceipt`。**不改此步，Task 4 测试 2（text fallback）会崩溃**
- [ ] Task 6 bot.test.ts:620 改为断言 `cardReplies` 而非 `textReplies`
- [ ] Task 6 bot.test.ts 中 `cardReplies` 数组和 `cardReplyFn` **已存在**（describe `'FeishuBot cards'` 块 line 548-592），**不需要新增**
- [ ] Task 7 集成测试 **未**用 `config.load()`
- [ ] Task 7 集成测试 5 个场景中至少 A、E 跑通
- [ ] Task 8 全量测试不破坏
- [ ] Task 9 PR body 描述 3 PR 全景 + 注明 doSwitch return 值从 reply 字符串改为 'failed'/'switched'

---

## 工作量估算

| Task | 范围 | 预计时间 |
|------|------|---------|
| Task 1 | doSwitch 失败测试（无 `config.load()`）+ swapped=false 补充测试 | 20 分钟 |
| Task 2 | buildSessionOverviewCard + `esc()` helper + isSessionRunning | 20 分钟 |
| Task 3 | doSwitch 改造（含 text fallback 补回 recordReceipt） | 12 分钟 |
| Task 4 | doCardList 失败测试（无 `config.load()`）+ 3 个补充测试 | 18 分钟 |
| Task 5 | buildListCard（🔴 + AI 末条）+ doCardList 改造 + **Step 4.5 修 `msg!` bug** | 30 分钟 |
| Task 6 | 更新 bot.test.ts:620 | 10 分钟 |
| Task 7 | 集成测试（无 `config.load()`） | 15 分钟 |
| Task 8 | 全量测试验证 | 10 分钟 |
| Task 9 | PR 创建 | 10 分钟 |
| **总计** | - | **~2 小时 25 分钟**（不含 review 反馈循环） |

---

## 3 PR 全部完成清单

合并顺序：
- [ ] PR 1 合 → staging 观察 1 天（`last_user_preview.hit_rate` 应 > 90%）
- [ ] PR 2 合 → 立即生效（`cmd.queue.wait_ms` 应从无上限降到 < 100ms）
- [ ] PR 3 合 → 立即生效（`overview.card.sent` 应有日活级调用量）

3 PR 全合并后：
- 痛点 A 修复：streaming 中可并发发命令
- 痛点 B 修复：切换时看到最后问答 + 运行中标记
- 数据层独立可回滚（PR 1 revert 不影响飞书侧）
- UI 层独立可回滚（PR 3 revert 保留 PR 1+2 的并发修复）
