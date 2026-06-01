# cc-linker 飞书并发命令与会话概览设计文档

> 日期：2026-06-02
> 范围：飞书侧"处理中可发命令 + 切换会话展示进展"
> 前置：现有 SpoolQueue 串行模型、scanner/JSONL preview、card-updater

## 目标

解决两个飞书侧用户痛点：

1. **痛点 A**：用户在一个 session 处理复杂任务（卡片在 streaming）时，发起 `/list` / `/new` / `/status` 等命令，**长时间无响应**，必须等当前 session 处理完。
2. **痛点 B**：用户在飞书列表/卡片里点击"切换"按钮时，只看到 `✅ 已切换到会话 xxx`，**看不到该会话的进展**（最后问了什么、Claude 回了什么、消息数、状态）。

## 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| command 队列策略 | command 走独立 serialKey `cmd:${openId}` | 改动 1 行即修复根因；不破坏 `acquireSessionLock` 语义 |
| `/new` 内部 Claude lockKey | 保持 `new:${openId}` | 同一 openId 的 new 会话创建仍需互斥，避免映射竞争 |
| 概览卡片形式 | Feishu interactive card | 移动端体感好；可按钮交互；复用现有 `cardReplyFn` |
| 概览内容 | 用户最后提问 80 字符 + AI 最后回复 80 字符 + 元信息 | 信息密度够用；不需实时读完整 JSONL |
| `/list` 中运行中标记 | 读 `ClaudeSessionManager.listSessions()` + `activeWorkers` | 列出所有正在跑 Claude 的 session UUID，命中时显示 🔴 |
| schema 版本 | 3 → 4 | 新增 `last_user_preview` / `last_assistant_preview`，需迁移 |
| scanner 缓存 | 失效本地 JSONL 缓存条目后重扫 | 字段新增，老条目无值，list 显示空即可 |

## 架构

### 改动 1：command 独立 serialKey

```
                       Feishu onMessage
                              │
                              ▼
            ┌─────────────────────────────────┐
            │ isCommand ?                     │
            │   yes → serialKey = "cmd:"+oid  │
            │   no  → resolveChatTarget()     │
            └─────────────────────────────────┘
                              │
                              ▼
                      SpoolQueue.enqueue
                              │
                              ▼
                      SpoolQueue.claimNext
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   cmd:openId 在 processing?        new:openId 在 processing?
        yes → 跳过                       yes → 跳过
        no  → claim                     no  → claim
```

**关键点**：
- `/list` / `/status` / `/model` / `/switch` / `/resume` / `/new`（command 部分）都用 `cmd:openId`。
- 进入 `handleNew` / `createSessionFromPromptSDK` 后，内部 `lockKey` 仍用 `new:openId`（互斥）。
- 用户连续发两个 `/new -- prompt`：第一条用 `cmd:openId` claim 成功 → handleNew 内部用 `new:openId` 拿 Claude lock；处理完释放后，第二条 `cmd:openId` claim 成功 → 又尝试拿 `new:openId` lock，**正常互斥等待**，符合预期。

### 改动 2：scanner 维护 last_user/last_assistant preview

```
JSONLScanner.parseTail(file)
  - 读尾部 4KB（或全量）
  - 倒序遍历最后 10 行
  - 抓 type=assistant 的 text 块 → last_assistant_preview (80 字符)
  - 抓 type=user 的 text 块    → last_user_preview (80 字符)
  - 返回 Partial<SessionEntry>
```

### 改动 3：bot 概览卡片

```
doSwitch(openId, uuid, messageId)
  - registry.get(uuid) → entry
  - 调 buildSessionOverviewCard(entry) → card
  - cardReplyFn(card) → 发送交互卡片
  - 卡片内容：标题 / 用户末问 / AI 末答 / 元信息 / 按钮区
```

### 改动 4：list 卡片显示运行中标记

```
doCardList(openId, messageId)
  - 读 registry.sessions
  - 读 ClaudeSessionManager.listSessions() → runningUuids
  - 读 this.activeWorkers（private，需要 getter）→ activeWorkerKeys
  - 合并：runningSessions = runningUuids ∪ activeWorkerSerialKeys
  - 在 buildListCard 渲染时，命中 runningSessions 的标题前缀加 🔴
```

## 组件

### 1. `src/feishu/bot.ts` —— command serialKey 调整

**位置**：`onMessage` 中 `serialKey` 计算（约 line 206-208）

**修改前**：
```typescript
const serialKey = target.type === 'session' && target.sessionUuid
  ? target.sessionUuid
  : `new:${event.open_id}`;
```

**修改后**：
```typescript
const serialKey = isCommand
  ? `cmd:${event.open_id}`
  : target.type === 'session' && target.sessionUuid
    ? target.sessionUuid
    : `new:${event.open_id}`;
```

**派生改动**：
- `resolveChatTarget` 不变（chat 路径需要 target）。
- `handleCommand` 内部 `createSessionFromPromptSDK` 的 `lockKey` 仍用 `new:${openId}`。
- `claimNext` 实现不变（按 serialKey 文件名前缀判断）。

### 2. `src/registry/types.ts` —— schema v3 → v4

**新增 optional 字段**：
```typescript
export const SessionEntrySchema = z.object({
  // ... 现有字段 ...
  last_user_preview: z.string().optional(),       // 用户最后提问 80 字符
  last_assistant_preview: z.string().optional(),  // AI 最后回复 80 字符
});
```

**Schema version 升 4**：
```typescript
export const RegistrySchema = z.object({
  version: z.literal(4),  // 3 → 4
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
```

**Migration**（`migrateV3toV4`）：
- 必须实现（不能依赖 Zod optional 兜底）：`RegistrySchema.parse()` 会在 `version !== 4` 时直接抛错，被 `load()` 的 catch 走 `restoreFromBackup`，会把磁盘数据丢掉。
- `migrateV3toV4(parsed)` 只做一件事：`parsed.version = 4`。`last_user_preview` / `last_assistant_preview` 缺省为 undefined，由 scanner 第一次重扫时填入。
- 仿照 `migrateV1toV2` 的位置和风格（`registry.ts:13-44`）。

### 3. `src/scanner/jsonl.ts` —— 抓 user + assistant 末条

**位置**：`parseTail`（line 181-243）

**修改**：在原有 `preview` 提取基础上，加 `lastUserPreview`：

```typescript
let lastUserPreview = '';
for (let i = tailLines.length - 1; i >= 0; i--) {
  try {
    const entry = JSON.parse(tailLines[i]);
    if (!lastActive && (entry.type === 'assistant' || entry.type === 'user')) {
      lastActive = entry.timestamp;
    }
    if (entry.type === 'assistant' && !preview) {
      const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
      if (textBlock) preview = textBlock.text.slice(0, 100);
    }
    if (entry.type === 'user' && !lastUserPreview) {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        lastUserPreview = content.slice(0, 100);
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b.type === 'text');
        if (textBlock?.text) lastUserPreview = textBlock.text.slice(0, 100);
      }
    }
  } catch {}
}

return {
  ...(lineCount > 0 ? { message_count: lineCount } : {}),
  ...(lastActive ? { last_active: lastActive } : {}),
  ...(preview ? { last_assistant_preview: preview.slice(0, 80) : undefined } : {}),
  ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) : undefined } : {}),
};
```

**全量扫描**（line 218）部分同样改。

### 4. `src/feishu/bot.ts` —— `buildSessionOverviewCard` 新增

注意：`SessionEntry` 不含 `sessionId` 字段，sessionId 是 registry map 的 key。所以函数签名必须带 `uuid` 参数。

```typescript
function buildSessionOverviewCard(
  uuid: string,
  entry: SessionEntry,
  isRunning: boolean,
): Record<string, unknown> {
  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${entry.title ?? 'Untitled'}`;

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '🔄 已切换会话' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${entry.cwd ?? '-'}\`` },
      ...(entry.last_user_preview ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(entry.last_user_preview)}` }] : []),
      ...(entry.last_assistant_preview ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(entry.last_assistant_preview)}` }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: `📊 ${entry.message_count} 条消息 · ${formatTimeAgo(entry.last_active)} · ${formatOrigin(entry.origin, entry.status)}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}
```

**关于"💬 继续输入"按钮**：用户切完会话后**直接发消息**就在当前活跃 session 里继续，不需要按钮。改成 markdown 提示文字即可（见 elements 第 4 项 `💡 直接发送消息...`），减少误点击。

**调用方**：
- `doSwitch` 替换当前的 text 回复。
- `doSwitch` 内部 `buildSessionOverviewCard(uuid, session, isRunning)` 调用。

### 5. `src/feishu/bot.ts` —— `doSwitch` 改造

```typescript
private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage): Promise<string> {
  const session = this.registry.get(uuid);
  if (!session) { /* ... 同上 ... */ }

  const currentEntry = this.userManager.getEntry(openId);
  const swapped = await this.userManager.compareAndSwap(...);
  if (!swapped) { /* ... 同上 ... */ }

  // 新增：判断目标 session 是否正在跑 Claude
  const isRunning = this.isSessionRunning(uuid);

  // 新增：发概览卡片（uuid 来自入参，不是 session 上的字段）
  const card = buildSessionOverviewCard(uuid, session, isRunning);
  const replyId = await this.cardReplyFn(card, { messageId, openId });

  // 移除：原 text 回复
  // 原 reply "✅ 已切换到会话 xxx" → 改为：不在这里发，doCardList 已经用 cardReplyFn 发了
  if (replyId) {
    if (msg) {
      this.spoolQueue.recordDelivery(...);
      this.spoolQueue.markReplied(...);
      this.spoolQueue.markDone(...);
    } else {
      this.spoolQueue.recordReceipt(messageId ?? '');
    }
  } else {
    // 降级到 text
    const reply = swapped ? `✅ 已切换到 ${uuid.slice(0, 8)}\n💬 最后提问：${session.last_user_preview ?? '无'}\n🤖 最后回复：${session.last_assistant_preview ?? '无'}\n📊 ${session.message_count} 条消息 · ${formatTimeAgo(session.last_active)}` : '...';
    // 同上回复路径
  }
  return swapped ? 'switched' : 'failed';
}

private isSessionRunning(uuid: string): boolean {
  // ClaudeSessionManager 暴露 listSessions()，检查是否有 sessionId === uuid
  return this.sessionManager.listSessions().some(s => s.sessionId === uuid);
}
```

**注意**：`ClaudeSessionManager.listSessions()` 当前返回所有 active process 的 `ClaudeSession`，每个有 `sessionId` 字段（line 890-892）。这能正确判断"目标 session 是不是在跑"。

### 6. `src/feishu/bot.ts` —— `buildListCard` 加运行中标记

```typescript
function buildListCard(
  sessions: Array<[string, SessionEntry]>,
  total: number,
  hasMore: boolean,
  runningUuids: Set<string>,
): Record<string, unknown> {
  // ...
  for (const [uuid, entry] of sessions) {
    const index = ...;
    const runningMark = runningUuids.has(uuid) ? '🔴 ' : '';
    elements.push({
      tag: 'markdown',
      content: `**${index}. ${runningMark}${entry.title ?? 'Untitled'}**\nID: \`${uuid.slice(0, 8)}\` | ${entry.message_count}条 | ${formatTimeAgo(entry.last_active)} | ${formatOrigin(entry.origin, entry.status)} | ${entry.project_name ?? ''}\n📁 \`${entry.cwd ?? '-'}\`${entry.last_assistant_preview ? `\n🤖 ${preview(entry.last_assistant_preview, 60)}` : ''}`,
    });
    // ... action 按钮 ...
  }
}
```

**调用方** `doCardList` 改造：
```typescript
const runningUuids = new Set(
  this.sessionManager.listSessions()
    .map(s => s.sessionId)
    .filter(Boolean)
);
// 注：activeWorkers 是 Set<Promise>，其 serialKey 不直接暴露 — 不需要从 activeWorkers 读
const card = buildListCard(sessions, allSessions.length, hasMore, runningUuids);
```

### 7. 测试

**新增单测** `tests/unit/feishu/bot-serial-key.test.ts`：
- 验证 command 消息的 serialKey 形如 `cmd:openId-xxx`
- 验证非 command session 消息 serialKey 是 sessionUuid
- 验证非 command 无目标消息 serialKey 是 `new:openId`

**新增单测** `tests/unit/scanner/jsonl-preview.test.ts`：
- 给定 JSONL 内容（含 assistant text + user prompt），验证 parseTail 返回 `last_user_preview` / `last_assistant_preview` 各 80 字符
- 验证空文件 / 损坏行不抛错
- 验证只有 user 没有 assistant 时 `last_assistant_preview` 为 undefined

**新增单测** `tests/unit/feishu/bot-do-switch.test.ts`：
- 验证 doSwitch 在 session 正在 listSessions() 中时，isRunning=true
- 验证卡片内容包含 🔴 标记 + last_user_preview + last_assistant_preview
- 验证卡片降级到 text 时包含关键信息

**集成测试**（可选，跑慢）：模拟 5 个场景
- 场景 A：session A streaming → /list 立即返回
- 场景 B：/new -- prompt → /list 立即返回
- 场景 C：/new -- prompt1 → /new -- prompt2 第二条等第一条
- 场景 D：/new（无 prompt）→ /list 立即返回
- 场景 E：连续 /list 三条都快速返回

## 错误处理

| 场景 | 处理 |
|------|------|
| session 找不到 | `doSwitch` 当前已有 fallback 行为：reply "未找到对应会话"，不变 |
| registry v3 升级 v4 | Zod 解析时缺省字段为 undefined，scanner 第一次重扫时填入；不需要主动迁移 |
| scanner 缓存中老条目无 preview | scanner 解析时只有当新值非空才 patch，老 entry 不被覆盖；list 卡片没 preview 时不显示该行 |
| `listSessions()` 返回空（idle） | `runningUuids` 为空集，list 卡片无 🔴 标记 |
| 概览卡片 text 字段含 markdown 特殊字符 | `esc()` 转义 `<` / `>`（已有 helper） |
| `last_user_preview` 包含多行 | preview 逻辑已有 normalize whitespace，按 80 字符截断 |
| serialKey 文件名冲突 | 文件命名规则 `${serialKey}:${messageId}.json`，新 `cmd:` 前缀与现有 `new:` 不会冲突 |
| 老 v3 registry 直接进 v4 bot | Zod 解析失败时 `registry.ts:88` 的 `restoreFromBackup` 兜底 |

## 数据流

### 场景 A：session A streaming 中，用户发 /list

```
T0: WSClient → onMessage({ text: "/list", ... })
    isCommand = true
    serialKey = "cmd:openId"
    spoolQueue.enqueue → pending/

T1: dispatch() 轮询 → claimNext("cmd:openId")
    processing 目录没有 cmd:* → claim 成功 → processing/cmd:openId:msg.json
    activeWorkers 启动 handleClaimed → handleCommand → handleList → doCardList

T2: doCardList 读 registry (syncBeforeCommand) → 列表卡片
    cardReplyFn → 飞书 API 立即发卡片
    markReplied / markDone

T3: 飞书收到新卡片（包含 🔴 标记表示 session A 在跑）
```

### 场景 B：/new -- prompt + /list

```
T0: /new -- prompt 入队 → pending/new:openId:msg1.json
T1: claim → handleNew → createSessionFromPromptSDK
    内调 sendSDKMessage，lockKey = "new:openId"
    acquireSessionLock 成功 → spawn Claude
T2: /list 入队 → pending/cmd:openId:msg2.json
T3: claimOne 遍历 pending:
      - msg1.serialKey = "new:openId" → claimNext("new:openId") → processing 中 → null
      - msg2.serialKey = "cmd:openId" → claimNext("cmd:openId") → 没有 → claim 成功
T4: handleList 并行启动，不等 /new
```

### 场景 C：连续两个 /new -- prompt

```
T0: /new -- p1 → claim 成功 → handleNew → createSessionFromPromptSDK
    sendSDKMessage(lockKey="new:openId") → acquireSessionLock OK → spawn Claude p1
T1: /new -- p2 → claim "cmd:openId" 成功（不是同 serialKey）
    handleNew → createSessionFromPromptSDK
    sendSDKMessage(lockKey="new:openId") → acquireSessionLock BLOCKED（等 p1）
T2: p1 完成 → releaseSessionLock → p2 接着跑
```

## 测试计划

### 单元测试（必须全过）

1. `tests/unit/feishu/bot-serial-key.test.ts`（新）
2. `tests/unit/scanner/jsonl-preview.test.ts`（新）
3. `tests/unit/feishu/bot-do-switch.test.ts`（新）
4. `tests/unit/registry/migration-v3-v4.test.ts`（新）—— 验证 v3 registry 加载后写回为 v4，缺省字段不丢
5. 现有 `tests/unit/scanner/jsonl.test.ts`、`tests/unit/feishu/bot.test.ts` 全过

### 手工验证（开发机）

1. 启动 bot（`bun run dev start`）
2. 场景 A-C 同数据流章节，手动跑一遍
3. 截图发到 `docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md`（可选）

## 影响范围

- 飞书侧用户体验：✅ 修复阻塞，✅ 切换时看到进展
- CLI 侧：零影响（serialKey 计算在 FeishuBot.onMessage 内）
- Scanner：新增两个字段，旧数据不丢
- 兼容性：v3 registry 自动升级 v4，向后兼容
- 性能：scanner 每次 parseTail 多读 1 个字段，O(1) 开销
- 存储：registry.json 每条 entry 多 2 个 80 字符字段，约 +200B/entry

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| command serialKey 改了后有遗漏的串行化点 | 单元测试覆盖 + e2e 场景 C |
| v3 → v4 migration 缺字段导致 Zod 解析失败 | 字段都设 `optional()`，缺省 undefined 即可 |
| list 卡片加运行中标记导致卡片过大 | preview 截断 60 字符（list 用），overview 截断 80 字符 |
| `listSessions()` 不包含 waiting-in-spool 的 session | 这类不算"运行中"，本来就不应该标 🔴 |
| `last_user_preview` 把用户的敏感命令也抓出来 | 已经是 80 字符 preview，没全量；用户自己用飞书发出去的自己能看到 |
| overview 卡片降级到 text 路径里 reply 消息体积过大 | 已有 splitReplyText，兜底路径不再变 |
| `runningUuids` 跟 card title 重复导致 list 卡片字符超限 | list 元素不超 4KB，10 条 + 标记应该没问题；e2e 跑一遍确认 |

## 不做的事（YAGNI）

- 不实现 session 切换后自动 follow streaming 卡片（成本高，需要 CardUpdater 引用计数）
- 不实现 command 历史回放（用户用 /list 自己找）
- 不实现 thinking + tool calls 完整末条（YAGNI，80 字符够用）
- 不实现 schema 真 v3 → v4 数据迁移脚本（Zod optional 兜底）
- 不实现 "running session" 单独的 status 类型（仅在 list 卡片和 switch 卡片用 🔴 标记）
