# 飞书并发命令 PR 2: bot.ts serialKey 改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/list` / `/new` / `/status` / `/listdir` 等命令走独立 serialKey `cmd:${openId}:${messageId}`，实现"session A streaming 中可并发发命令"的痛点 A 修复。

**Architecture:** `onMessage` 中 `isCommand` 时直接生成 `cmd:` 前缀的 serialKey（不读 target），与 `new:` / sessionUuid 路径互不干扰。messageId 加白名单校验作为 defense-in-depth（飞书 messageId 理论不含 `:` `/`，但加校验保证 spool 文件名永远形如 `${serialKey}:${messageId}.json`）。bot.ts 新增本地 `esc()` helper（避免扩大 card-updater 公开 API）。

**Tech Stack:** Bun + TypeScript + `bun:test`（复用现有 bot.test.ts 模式）

**Spec:** `docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md` 改动 1 + §1 组件 1 + 风险与缓解 messageId 行 + §1.1 messageId 白名单

**Prerequisite:** PR 1 已合（schema v4 + scanner preview 字段），但本 PR 不强依赖 PR 1 字段——`serialKey` 改造是独立的逻辑层改动。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/feishu/bot.ts` | **修改**:`onMessage` 加 messageId 校验 + serialKey 改造（isCommand 走 cmd:）+ 文件底部加本地 `esc()` |
| `tests/unit/feishu/bot-serial-key.test.ts` | **新增**:4 个 messageId 校验测试 + 5 个 serialKey 行为测试 |
| `tests/unit/queue/spool-concurrency.test.ts` | **新增**:SpoolQueue 真实并发测试（PR 2 痛点 A 的核心保证） |

---

## Task 1: 写 failing test 给 messageId 校验

**Files:**
- Create: `tests/unit/feishu/bot-serial-key.test.ts`

- [ ] **Step 0: 验证 PR 1 已合并（前置条件）**

PR 2 弱依赖 PR 1 schema v4 字段（不读新字段，但 staging 验证需要 PR 1 提供的 `last_user_preview`）。执行前先确认：

```bash
cd /Users/wuyujun/Git/cc-linker
git log --oneline -1 master
# 应包含 PR 1 的 merge commit（关键词 "schema v3 to v4" 或 "registry v4"）
```

如果 PR 1 未合，**停下来**等 PR 1 合并后再开始。

- [ ] **Step 0.5: 验证现有测试无非法 messageId 字符**

新白名单 `/^[a-zA-Z0-9_-]+$/` 会拒绝所有含 `:` `/` 的 messageId。验证现有测试不会受影响：

```bash
cd /Users/wuyujun/Git/cc-linker
grep -rE "message_id:\s*['\"][^'\"]*[:/][^'\"]*['\"]" tests/
# 预期：无输出（现有测试 messageId 都是 msg-1 / msg-card-1 等）
```

如果有输出，**修复该测试**（把非法字符改成 `_` 或 `-`），不能改新代码的兼容性。

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/feishu/bot-serial-key.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';

// 复用 bot.test.ts:42-48 的 setup 模式：(config as any).data.* 直接 mutation
// 不要用 config.load() —— 该方法不存在
describe('FeishuBot serialKey and messageId validation', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let textReplies: Array<{ text: string; openId?: string; messageId?: string }>;
  let cardReplies: Array<{ card: any; openId?: string; messageId?: string }>;
  let bot: FeishuBot;
  let originalMaxPending: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-serialkey-test-'));

    // 复用 bot.test.ts:42-48 的 config mutation 模式（owner_open_id='' 允许所有 openId 通过 validateOwner）
    originalMaxPending = (config as any).data.queue.max_pending;
    (config as any).data.feishu_bot.owner_open_id = '';
    (config as any).data.feishu_bot.default_cwd = '';
    (config as any).data.security.allowed_roots = [];
    (config as any).data.security.denied_roots = [];
    (config as any).data.stream.enabled = false;
    (config as any).data.sdk.enabled = false;

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
    (config as any).data.queue.max_pending = originalMaxPending;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====== messageId 校验 ======

  it('rejects message with invalid messageId (contains colon)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad:id',  // 包含 : 字符
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('消息格式异常');
    // 拒绝入队：pending 目录应该是空的
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId (contains slash)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om/bad/id',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('消息格式异常');
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId regardless of content type (non-command)', async () => {
    // boundary case：messageId 校验在 isCommand 之前就生效
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad',  // 包含 : 字符
      content: JSON.stringify({ text: 'hello' }),  // 非 command
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('消息格式异常');
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('accepts valid alphanumeric+underscore+hyphen messageId', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_valid_123-abc',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // 没有"消息格式异常"回复
    expect(textReplies.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-serial-key.test.ts`
Expected: 4 个测试全失败——当前 bot.ts 没有 messageId 校验逻辑，所有消息都被接受。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/feishu/bot-serial-key.test.ts
git commit -m "test(bot): add messageId validation + serialKey test suite (red)"
```

---

## Task 2: 实现 messageId 白名单校验

**Files:**
- Modify: `src/feishu/bot.ts:146-149`（在 hasReceipt 之后加 messageId 校验）

- [ ] **Step 1: 在 onMessage 中加 messageId 白名单**

修改 `src/feishu/bot.ts:146-149` 之后插入新代码（在 `if (!this.userManager.validateOwner(...))` 之后、`if (this.spoolQueue.hasReceipt(...))` 之后、文本提取之前）:

```typescript
    // messageId 白名单校验：defense-in-depth，防止特殊字符打乱 spool 文件名 ${serialKey}:${messageId}.json 的双 : 结构
    if (!/^[a-zA-Z0-9_-]+$/.test(event.message_id)) {
      logger.warn(`消息 ID 格式异常，拒绝入队: ${event.message_id}`);
      await this.replyFn('消息格式异常，请重试或联系管理员。', {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }
```

具体插入位置：在 `bot.ts:149` 之后（`hasReceipt` 检查之后），`bot.ts:151` 之前（`let text = '';` 之前）。

- [ ] **Step 2: 跑测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-serial-key.test.ts`
Expected: 4 个 messageId 校验测试全过。

- [ ] **Step 3: 跑现有 bot.test.ts 确保不破坏**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot.test.ts`
Expected: 全过。现有测试的 messageId 形如 `'msg-1'` / `'msg-card-1'` / `'msg-list-1'` 都是合法字符。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): validate messageId against /^[a-zA-Z0-9_-]+$/ whitelist"
```

---

## Task 3: 写 failing test 给 cmd: serialKey 行为

**Files:**
- Modify: `tests/unit/feishu/bot-serial-key.test.ts`（追加测试）

- [ ] **Step 1: 追加 5 个 serialKey 行为测试**

在 `tests/unit/feishu/bot-serial-key.test.ts` 末尾（最后一个 `it()` 之后、`describe` 闭合之前）追加:

```typescript
  // ====== cmd: serialKey 行为 ======

  it('command message uses cmd:openId:msgId serialKey', async () => {
    // 触发 onMessage 后，让 worker claim 一条消息检查 serialKey
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // 检查 spool pending 目录中的文件名
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_001'));
    expect(matchFile).toBeDefined();
    // 文件名格式: cmd:openId:msgId:msgId.json
    expect(matchFile).toMatch(/^cmd:ou_user1:om_msg_001:om_msg_001\.json$/);
  });

  it('non-command session message uses sessionUuid as serialKey', async () => {
    // 先设置 user mapping 指向一个 session
    // 注意：compareAndSwap 内部会调 validateOwner，依赖 feishu_bot.owner_open_id = ''
    // （已在 beforeEach 设置为 ''）
    await userManager.compareAndSwap('ou_user1', null, {
      type: 'session',
      sessionUuid: 'sess-abc-123',
      cwd: '/tmp/proj',
      createdAt: new Date().toISOString(),
    });

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_002',
      content: JSON.stringify({ text: '继续工作' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_002'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^sess-abc-123:om_msg_002\.json$/);
  });

  it('non-command no-target message uses new:openId serialKey', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_003',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_003'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^new:ou_user1:om_msg_003\.json$/);
  });

  it('/listdir command also uses cmd: serialKey (not /list whitelist only)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_listdir',
      content: JSON.stringify({ text: '/listdir' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_listdir'));
    expect(matchFile).toBeDefined();
    // /listdir 也走 cmd: 路径（按 isCommand 标志，不按白名单）
    expect(matchFile).toMatch(/^cmd:ou_user1:om_msg_listdir:om_msg_listdir\.json$/);
  });

  it('two different messageId commands have independent serialKeys', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_a',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_b',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const fileA = pendingFiles.find(f => f.includes('om_cmd_a'));
    const fileB = pendingFiles.find(f => f.includes('om_cmd_b'));

    expect(fileA).toBeDefined();
    expect(fileB).toBeDefined();
    // 两个 serialKey 完全不同
    expect(fileA).not.toBe(fileB);
    expect(fileA).toMatch(/^cmd:ou_user1:om_cmd_a:/);
    expect(fileB).toMatch(/^cmd:ou_user1:om_cmd_b:/);
  });
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-serial-key.test.ts`
Expected: 5 个 serialKey 测试全失败——当前代码用 `target.type === 'session' ? sessionUuid : new:openId`，command 也会落入 `new:openId` 分支，文件名是 `new:ou_user1:om_msg_001.json` 而非 `cmd:ou_user1:om_msg_001:om_msg_001.json`。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/feishu/bot-serial-key.test.ts
git commit -m "test(bot): add cmd: serialKey behavior tests (red)"
```

---

## Task 4: 实现 isCommand 走 cmd: serialKey

**Files:**
- Modify: `src/feishu/bot.ts:220-222`（serialKey 计算）

- [ ] **Step 1: 改 serialKey 计算加 isCommand 分支**

修改 `src/feishu/bot.ts:220-222`:

把:
```typescript
    const serialKey = target.type === 'session' && target.sessionUuid
      ? target.sessionUuid
      : `new:${event.open_id}`;
```

改为:
```typescript
    // command 走独立 serialKey（每个 messageId 独立），避免被 session streaming 阻塞
    // 注意：必须用 isCommand 标志，不按命令白名单——/listdir / 未来新增命令都自动覆盖
    const serialKey = isCommand
      ? `cmd:${event.open_id}:${event.message_id}`
      : target.type === 'session' && target.sessionUuid
        ? target.sessionUuid
        : `new:${event.open_id}`;
```

- [ ] **Step 2: 跑测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot-serial-key.test.ts`
Expected: 9 个测试（4 messageId 校验 + 5 serialKey 行为）全过。

- [ ] **Step 3: 跑现有 bot.test.ts 确保不破坏**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/bot.test.ts`
Expected: 全过。现有测试中 command 消息的 serialKey 之前是 `new:openId`，**不会**触发任何断言失败（现有测试主要测 textReplies / cardReplies 内容，不测文件名）。

**但要警惕**：现有测试如果 dispatch 跑到了 `claimNext` 检查 processing 目录，新代码下 command 走 `cmd:` 路径，**可能改变 dispatch 行为**。如果发现现有测试失败，**修复该测试**（不是改新代码）——新行为是正确的，测试需要适配。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): command messages use independent cmd:openId:msgId serialKey"
```

---

## Task 5: 添加本地 esc() helper

**Files:**
- Modify: `src/feishu/bot.ts:2266-2268`（在 buildSessionTitle 之后追加 esc）

- [ ] **Step 1: 添加 esc() 本地定义**

修改 `src/feishu/bot.ts:2266-2268` 之后追加:

```typescript
function esc(text: string): string {
  return text.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
}
```

**为什么不需要测试**：esc() 是 1 行纯函数，行为可由 manual 验证（`<` → `&lt;`、`>` → `&gt;`），加测试是 over-spec。esc() 在 PR 3 才会被 buildSessionOverviewCard 使用，PR 3 会通过 bot-do-switch.test.ts 间接覆盖。

- [ ] **Step 2: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 跑所有相关测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/`
Expected: bot.test.ts + bot-serial-key.test.ts + card-updater.test.ts + mapping.test.ts + activity.test.ts + image.test.ts 全过。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/feishu/bot.ts
git commit -m "feat(bot): add local esc() helper for markdown escape"
```

---

## Task 6: 全量测试验证

**Files:**
- 无代码修改

- [ ] **Step 1: 跑全量单元测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test`
Expected: 全过。如有失败，定位是 PR 2 引起的，修复。

- [ ] **Step 2: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 跑测试覆盖率**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test --coverage`
Expected 覆盖目标：
- `bot.ts:onMessage` 入口校验段（line 132-149）覆盖率 ≥ 90%（messageId 校验、validateOwner、hasReceipt 全覆盖）
- `bot.ts:onMessage` serialKey 计算段（line 215-222）覆盖率 ≥ 90%（isCommand / target / 三个 serialKey 分支全覆盖）
- `bot.ts` 中新增的 `esc()` 覆盖率不强制（PR 3 会用到）

- [ ] **Step 4: 手动 smoke test（仅本地 dev 环境）**

> ⚠️ **本步骤仅在本地 dev 环境执行**。staging 由 SRE 跑，CI 跳过。

启动 daemon:
```bash
cd /Users/wuyujun/Git/cc-linker
bun run dev start
```

在飞书侧：
1. 发送 `/list` → 收到列表卡片（验证 cmd serialKey 工作）
2. 立即发送 `/status` → 也立即返回（验证两条 cmd 不互相阻塞）
3. 发送 `/listdir` → 也走 cmd 路径，收到目录浏览卡片（验证 isCommand 标志而非白名单）
4. 发送 `hello`（非 command）→ 走 chat 路径（可能因没 session 收到"当前没有活跃会话"——这是正常行为）

- [ ] **Step 5: 验证无破坏后无 commit**

此 task 无代码修改。

---

## Task 7: SpoolQueue 真实并发集成测试（验证 command 真正并行）

> **为什么独立成 Task**：Task 1-5 的单元测试只验证 serialKey **字符串**正确，不能证明两个 command 真的能并行 claim。痛点 A 的核心是"session A streaming → /list 立即返回"，必须用真实 SpoolQueue 验证 `claimNext` 的并发语义。

**Files:**
- Create: `tests/unit/queue/spool-concurrency.test.ts`

- [ ] **Step 1: 创建集成测试文件**

新建 `tests/unit/queue/spool-concurrency.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpoolQueue, SpoolMessage } from '../../../src/queue/spool';
import { config } from '../../../src/utils/config';

describe('SpoolQueue concurrency with cmd: serialKey (PR 2 pain point A core guarantee)', () => {
  let tmpDir: string;
  let spoolQueue: SpoolQueue;
  let originalMaxPending: number;

  function makeMsg(messageId: string, serialKey: string, text: string): SpoolMessage {
    return {
      messageId,
      openId: 'ou_user1',
      text,
      target: { type: 'no_target' as const, openId: 'ou_user1' },
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-concurrency-test-'));
    originalMaxPending = (config as any).data.queue.max_pending;
    (config as any).data.queue.max_pending = 100;
    spoolQueue = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 场景 A：两个不同 messageId 的 command 都能 claim（核心保证）
  it('two cmd: messages with different messageIds can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_msg_001', 'cmd:ou_user1:om_msg_001', '/list'));
    spoolQueue.enqueue(makeMsg('om_msg_002', 'cmd:ou_user1:om_msg_002', '/status'));

    // claim 第一条 → 成功
    const claimed1 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_001');
    expect(claimed1).not.toBeNull();
    expect(claimed1?.messageId).toBe('om_msg_001');

    // claim 第二条 → 也成功（不同 serialKey 不被 processing 中的第一条阻塞）
    const claimed2 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_002');
    expect(claimed2).not.toBeNull();
    expect(claimed2?.messageId).toBe('om_msg_002');
  });

  // 场景 A 变体：session streaming + /list 并行（痛点 A 的真实场景）
  it('session streaming (sessionUuid serialKey) + cmd: /list can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_session_msg', 'sess-abc-123', '继续工作'));
    spoolQueue.enqueue(makeMsg('om_list_msg', 'cmd:ou_user1:om_list_msg', '/list'));

    // session 消息被 claim，模拟正在 streaming
    const sessionClaimed = await spoolQueue.claimNext('sess-abc-123');
    expect(sessionClaimed).not.toBeNull();

    // /list 立即 claim 成功（不被 session processing 阻塞）
    const listClaimed = await spoolQueue.claimNext('cmd:ou_user1:om_list_msg');
    expect(listClaimed).not.toBeNull();
    expect(listClaimed?.text).toBe('/list');
  });

  // 场景 E：连续三条 /list 都快速返回
  it('three /list commands with different messageIds all claim successfully', async () => {
    spoolQueue.enqueue(makeMsg('om_list_1', 'cmd:ou_user1:om_list_1', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_2', 'cmd:ou_user1:om_list_2', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_3', 'cmd:ou_user1:om_list_3', '/list'));

    const c1 = await spoolQueue.claimNext('cmd:ou_user1:om_list_1');
    const c2 = await spoolQueue.claimNext('cmd:ou_user1:om_list_2');
    const c3 = await spoolQueue.claimNext('cmd:ou_user1:om_list_3');

    expect(c1?.messageId).toBe('om_list_1');
    expect(c2?.messageId).toBe('om_list_2');
    expect(c3?.messageId).toBe('om_list_3');
  });

  // 反向：相同 serialKey（同 messageId）第二条被阻塞
  it('same serialKey (same messageId) blocks second claim correctly', async () => {
    spoolQueue.enqueue(makeMsg('om_dup', 'cmd:ou_user1:om_dup', '/list'));

    const first = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(first).not.toBeNull();

    // 没有第二条同 serialKey 的消息 → claimNext 返回 null
    const second = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(second).toBeNull();
  });

  // 边界：old `new:openId` serialKey 仍正常工作（向后兼容非 command 路径）
  it('new:openId serialKey (non-command path) still works as before', async () => {
    spoolQueue.enqueue(makeMsg('om_chat_1', 'new:ou_user1', 'hello'));

    const claimed = await spoolQueue.claimNext('new:ou_user1');
    expect(claimed).not.toBeNull();
    expect(claimed?.text).toBe('hello');
  });
});
```

- [ ] **Step 2: 跑集成测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/queue/spool-concurrency.test.ts`
Expected: 5 个测试全过。**这 5 个测试不依赖 PR 2 的 bot.ts 改动**——它们直接验证 SpoolQueue 在 `cmd:` / `sessionUuid` / `new:openId` 三种 serialKey 下的并发语义，确保 Task 4 的 serialKey 改造**有真实并发支撑**（不只是字符串拼接对）。

- [ ] **Step 3: 跑全量测试再确认**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test`
Expected: 全过。集成测试 + 单元测试 + 现有测试一起跑，确认无破坏。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/queue/spool-concurrency.test.ts
git commit -m "test(spool): add concurrency tests for cmd:/sessionUuid/new: serialKey"
```

---

## Task 8: Commit 全部 + 创建 PR

- [ ] **Step 1: 检查 git status**

Run: `cd /Users/wuyujun/Git/cc-linker && git status`
Expected: 干净。

- [ ] **Step 2: 推送到远端并创建 PR**

```bash
cd /Users/wuyujun/Git/cc-linker
git checkout -b feat/pr2-cmd-serial-key
git push -u origin feat/pr2-cmd-serial-key
gh pr create --base master --title "feat(feishu): command messages use independent cmd: serialKey" --body "$(cat <<'EOF'
## 概述
PR 2 of 3: 飞书侧 command 消息（/list / /new / /status / /listdir 等）走独立 serialKey `cmd:${openId}:${messageId}`，**修复"session streaming 中无法发命令"的痛点 A**。

## 范围
- src/feishu/bot.ts:onMessage: 加 messageId 白名单校验 + 改 serialKey 计算
- src/feishu/bot.ts: 加本地 esc() helper（PR 3 用）
- tests/unit/feishu/bot-serial-key.test.ts: 9 个新测试（4 messageId + 5 serialKey）
- tests/unit/queue/spool-concurrency.test.ts: 5 个 SpoolQueue 真实并发集成测试

## 工作原理
- isCommand 时直接生成 `cmd:` 前缀 serialKey
- 不同 messageId → 不同 serialKey → SpoolQueue claimNext 的 `startsWith(serialKey+":")` 匹配不上 → **真正并行**
- 内部 lockKey (`new:${openId}`) 仍用于互斥 Claude 进程，行为不变
- messageId 白名单 `/^[a-zA-Z0-9_-]+$/` 作为 defense-in-depth，防止特殊字符打乱 spool 文件名结构

## 测试
- 9 个 bot serialKey 单元测试全过
- 5 个 SpoolQueue 真实并发集成测试全过（场景 A 痛点 A 核心保证）
- 现有 bot.test.ts 全过（不破坏）
- 现有 spool 单元测试全过

## 风险
- 行为变化：飞书侧 command 消息**不再被 session streaming 阻塞**
- 回滚简单：git revert，老 serialKey `new:openId` 行为恢复
- 不影响 schema（PR 1 已合）、不影响 overview 卡片（PR 3）

## 部署
- 上线后立即生效
- 关键监控：`cmd.queue.wait_ms` P95 应该从无上限降到 < 100ms
- 冒烟测试：streaming 中发 /list 立即返回

## 后续
- PR 3: bot.ts overview 卡片 + list 运行中标记（解决"切换看不到进展"痛点 B）
EOF
)"
```

- [ ] **Step 3: 等 CI 通过后合并**

如有 CI，等所有 check 通过后 merge squash。

---

## Self-Review Checklist

执行时逐项检查：

- [ ] Task 1 Step 0: 验证 PR 1 已合并（`git log --oneline -1 master`）
- [ ] Task 1 Step 0.5: 验证现有测试无非法 messageId 字符（`grep -rE "message_id:\s*['\"][^'\"]*[:/][^'\"]*['\"]" tests/`）
- [ ] Task 1 测试文件中 `config` 用 `(config as any).data.*` mutation 模式（与 bot.test.ts:42-48 一致），**不**用 `config.load()`
- [ ] Task 1 4 个 messageId 校验测试覆盖：含 `:`、含 `/`、非 command + 含 `:`、合法字符
- [ ] Task 1 3 个 messageId 校验失败测试都断言 "拒绝入队"（`readdirSync(pendingDir)` 长度 = 0）
- [ ] Task 2 messageId 校验正则 `/^[a-zA-Z0-9_-]+$/` 严格匹配
- [ ] Task 2 拒绝时 reply "消息格式异常"，**不**入队
- [ ] Task 3 测试文件顶部 import `readdirSync` from 'fs'，**不**在 test body 中用 `require('fs')`
- [ ] Task 4 serialKey 改造**不**影响非 command 路径（session 消息仍用 sessionUuid）
- [ ] Task 4 /listdir / 未来新增命令自动覆盖（不依赖白名单）
- [ ] Task 5 esc() 加在 `preview()` / `buildSessionTitle()` 同区域（bot.ts 底部）
- [ ] Task 6 全量测试不破坏，覆盖率目标：bot.ts:onMessage 入口校验段 ≥ 90%、serialKey 计算段 ≥ 90%
- [ ] Task 6 Step 4 手动 smoke test 标注 "仅本地 dev 环境"
- [ ] Task 7 SpoolQueue 集成测试覆盖 5 个并发场景（痛点 A 核心保证）
- [ ] Task 8 PR body 描述 3 PR 全景，branch name 明确为 `feat/pr2-cmd-serial-key`

---

## 工作量估算

| Task | 范围 | 预计时间 |
|------|------|---------|
| Task 1 | messageId 失败测试（含 Step 0/0.5 前置） | 15 分钟 |
| Task 2 | messageId 校验实现 | 5 分钟 |
| Task 3 | serialKey 失败测试 | 15 分钟 |
| Task 4 | serialKey 改造 | 5 分钟 |
| Task 5 | esc() helper | 2 分钟 |
| Task 6 | 全量测试验证 | 10 分钟 |
| Task 7 | SpoolQueue 真实并发集成测试（新增） | 20 分钟 |
| Task 8 | PR 创建 | 10 分钟 |
| **总计** | - | **~80 分钟**（不含 review 反馈循环） |

---

## 下一步

PR 2 合并后写 PR 3 计划（`2026-06-02-feishu-concurrent-commands-pr3-overview-card.md`），覆盖：
- `buildSessionOverviewCard` + `isSessionRunning` 新增（使用 PR 2 新增的 `esc()` helper）
- `doSwitch` 改造（swapped=false + overview card + text 降级）
- `buildListCard` 加 `runningUuids` 参数
- `doCardList` 计算 runningUuids + text 降级加 `[运行中]`
- 测试: `tests/unit/feishu/bot-do-switch.test.ts` + 更新 `tests/unit/feishu/bot.test.ts:620`
