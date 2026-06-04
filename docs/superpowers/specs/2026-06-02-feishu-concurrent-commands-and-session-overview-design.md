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
| command 队列策略 | command 走独立 serialKey `cmd:${openId}:${messageId}` | **每个命令独立队列**；不破坏 `acquireSessionLock` 语义；连续 /list 也能并行 |
| `/new` 内部 Claude lockKey | 保持 `new:${openId}` | 同一 openId 的 new 会话创建仍需互斥，避免映射竞争 |
| 概览卡片形式 | Feishu interactive card | 移动端体感好；可按钮交互；复用现有 `cardReplyFn` |
| 概览内容 | 用户最后提问 80 字符 + AI 最后回复 80 字符 + 元信息 | 信息密度够用；不需实时读完整 JSONL |
| `/list` 中运行中标记 | 读 `ClaudeSessionManager.listSessions()`（**不读 activeWorkers**，它是 `Set<Promise>`，serialKey 不暴露） | 列出所有正在跑 Claude 的 session UUID，命中时显示 🔴 |
| schema 版本 | 3 → 4 | 新增 `last_user_preview` / `last_assistant_preview`，**必须实现** `migrateV3toV4`（3 个调用点：`load()` / `reload()` / `readLatestState()`），`emptyRegistry()` 也要升 v4 |
| scanner 缓存 | schema bump 时清空 cache 全量重扫 | 字段新增，老条目无值，list 显示空即可；详见下方 §2.1"scanner 缓存失效机制"——cache meta 加 `schemaVersion`，失配时返回空 Map |
| 大文件 `last_user_preview` 4KB 命中率 | 4KB 找不到时回退全量重读 | 避免复杂对话结构（多 tool_use）下 `last_user_preview` 命中率低导致 overview 卡片显示空 |
| `esc()` helper 位置 | bot.ts 本地定义（与 `preview()` 同区域） | card-updater.ts 的 `esc` 是私有的；为避免扩大 card-updater 公开 API，bot.ts 自定义一份（5 行代码） |
| `doSwitch` swapped=false | 发"切换失败"消息，**不**发 overview 卡片 | 避免误导用户以为切换成功 |
| `doCardList` text 降级 | 同步加 `[运行中]` 标记 | 卡片与 text 必须展示相同的运行中状态 |
| messageId 校验 | onMessage 入口加白名单 `/^[a-zA-Z0-9_-]+$/` | defense-in-depth，防止特殊字符打乱 spool 文件名 `${serialKey}:${messageId}.json` 的双 `:` 结构 |

## 架构

### 改动 1：command 独立 serialKey

```
                       Feishu onMessage
                              │
                              ▼
            ┌──────────────────────────────────────────────┐
            │ isCommand ?                                  │
            │   yes → serialKey = "cmd:"+oid+":"+msgId     │
            │   no  → resolveChatTarget()                  │
            └──────────────────────────────────────────────┘
                              │
                              ▼
                      SpoolQueue.enqueue
                              │
                              ▼
                      SpoolQueue.claimNext
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   cmd:openId:msgId 在 processing?    new:openId 在 processing?
        yes → 跳过                          yes → 跳过
        no  → claim                        no  → claim
```

**关键点**（review 后修正）：
- **`messageId` 必须拼进 serialKey**。`messageId` 是飞书侧全局唯一（来自 `event.message_id`），用它做后缀保证**每个 command 独立**。
- 错误反例：`cmd:${openId}` 会让 `/new -- p1` 和 `/list` 共享同一 serialKey，前者占用 processing 期间后者还是被卡。
- 正确反例：`cmd:${openId}:${msgId}` 让两个 command serialKey 不一样，`claimNext` 的 `startsWith(serialKey+":")` 匹配不上，**真正并行**。
- **所有 `/` 开头且第二字符非空格的命令**（`/list` / `/listdir` / `/status` / `/model` / `/switch` / `/resume` / `/new` / `/whoami` / `/help` / 任何未来新增的 command）都用 `cmd:${openId}:${msgId}`。**判断依据是 `isCommand` 标志，不是命令白名单**（review 必改：原草图列举 8 个命令，遗漏 `/listdir`）。
- 进入 `handleNew` / `createSessionFromPromptSDK` 后，内部 `lockKey` 仍用 `new:${openId}`（互斥 Claude 进程）。
- 用户连续发两个 `/new -- p1` / `/new -- p2`：第一条 `cmd:oid:msg1` claim 成功 → handleNew 内部 `new:oid` 拿 lock；处理完释放后，第二条 `cmd:oid:msg2` claim 成功（不同 serialKey）→ 又尝试 `new:oid` lock，**互斥等待**，符合预期。
- **副作用**：用户连发两次 /list 会**并行处理**（doCardList 是只读，两次结果一致，可接受）。
- 文件名变成 `cmd:openId:msgId:msgId.json`（冗余但无害，spool 文件命名是 `${serialKey}:${messageId}.json`）。

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
  - 读 ClaudeSessionManager.listSessions() → runningUuids  ←【review 必改】只读这一个，不读 activeWorkers
  - 在 buildListCard 渲染时，命中 runningUuids 的标题前缀加 🔴
```

**【review 必改】**：原草图描述的"读 activeWorkers（private，需要 getter）"和"runningSessions = runningUuids ∪ activeWorkerSerialKeys"**与实际改造矛盾**——`activeWorkers` 是 `Set<Promise<void>>`（`bot.ts:87`），里面只存 worker Promise，**没有 serialKey 信息**，无法从中提取"对应哪个 session"。**实际实现只读 `listSessions()`**（详见 §6）。

## 组件

### 1. `src/feishu/bot.ts` —— command serialKey 调整

**位置**：`onMessage` 中 `serialKey` 计算（`bot.ts:220-222`，原文档写"约 line 206-208" 不准——`isCommand` 在 `bot.ts:215` 定义、`target` 在 `bot.ts:216-218` 初始化，`serialKey` 在 220-222 计算）

**修改前**：
```typescript
const serialKey = target.type === 'session' && target.sessionUuid
  ? target.sessionUuid
  : `new:${event.open_id}`;
```

**修改后**：
```typescript
const serialKey = isCommand
  ? `cmd:${event.open_id}:${event.message_id}`  // ← 每个 command 独立
  : target.type === 'session' && target.sessionUuid
    ? target.sessionUuid
    : `new:${event.open_id}`;
```

**派生改动**：
- `resolveChatTarget` 不变（chat 路径需要 target）。**注意：command 路径（`isCommand=true`）不调用 `resolveChatTarget`**，target 设为 `{ type: 'no_target' }`（`bot.ts:216-218`）。
- `handleCommand` 内部 `createSessionFromPromptSDK` / `createSessionFromPromptStreaming` 的 `lockKey` 仍用 `new:${openId}`（在 `sendSDKMessage` / `sendStreamingMessage` 调用处，`bot.ts:1109` / `bot.ts:1278`）。
- `claimNext` 实现不变（按 serialKey 文件名前缀 `cmd:openId:msgId:` 判断）。
- **代码层面的判断依据是 `isCommand`，不是命令白名单**：原草图列举 8 个命令（`/list` / `/status` / `/model` / `/switch` / `/resume` / `/new` / `/whoami` / `/help`），**遗漏了 `/listdir`**（`bot.ts:625-627` `handleListDir`）。修复后所有 `/` 开头且第二字符非空格的文本都用 `cmd:openId:msgId`，包括未来新增命令。

### 2. `src/registry/types.ts` —— schema v3 → v4

**review 后明确**：`last_message_preview` 字段**保留不变**（仍由 scanner 写 assistant 末条 100 字符，被 CLI list、bot.ts:625,709,850 等多处复用）。本次**新增**独立字段，不替换。

**新增 optional 字段**：
```typescript
export const SessionEntrySchema = z.object({
  // ... 现有字段 ...
  last_user_preview: z.string().optional(),       // 用户最后提问 80 字符（新）
  last_assistant_preview: z.string().optional(),  // AI 最后回复 80 字符（新）
  // last_message_preview 保留，被 CLI / bot 多处复用
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

**`emptyRegistry()` 同步升级（review 必改）**：`registry.ts:124-130` 的 `emptyRegistry()` 硬编码 `version: 3`：
```typescript
private emptyRegistry(): Registry {
  return {
    version: 3,  // ← 升 v4 后必须改 4
    updated_at: new Date().toISOString(),
    sessions: {},
  };
}
```
**必须改为 `version: 4`**。否则 `load()` → `parse` 失败 → `restoreFromBackup` 失败 → `createEmpty()` → `emptyRegistry()` 写出去还是 v3，下次启动会再次触发 migrate（虽不致命但浪费一次回环）。

**`migrateV3toV4` 三个调用点（review 必改）**：`migrateV1toV2` 当前在 3 处调用（`registry.ts:87` `load()` / `registry.ts:112` `reload()` / `registry.ts:322` `readLatestState()`），`migrateV3toV4` 必须**同样在 3 处都加**：
```typescript
// load() 中：
migrateV1toV2(parsed);
migrateV3toV4(parsed);  // ← 新增
return RegistrySchema.parse(parsed);

// reload() 中：同上
// readLatestState() 中：同上
```
少了任何一处会导致：写盘 v4、读盘 v3 → 解析失败 → 走 backup restore（如果是 backup 也是 v3 → 又 migrate）。
**`migrateV3toV4` 必须幂等**：
```typescript
function migrateV3toV4(parsed: any): void {
  if (parsed.version === 3) {
    parsed.version = 4;
    // 不主动改 sessions，避免破坏数据
  }
  // parsed.version === 4 时跳过（多次 load 安全）
  // 其他值让 Zod 抛错（异常路径走 restoreFromBackup）
}
```

### 2.1 Scanner 缓存失效机制（review 必改，**生产必现 bug**）

**问题**：`scanner/jsonl.ts:71-74` 的逻辑是：
```typescript
const cachedMtime = this.fileCache.get(filePath);
if (cachedMtime && mtime <= cachedMtime) {
  continue;  // mtime 没变 → 跳过
}
```

**生产风险**：用户升级 cc-linker → schema 升 v4 → 老 session 的 `last_user_preview` / `last_assistant_preview` 是空。**因为 mtime 没变，scanner 永远不重扫这些文件**。用户必须触发新写入（让 mtime 变化）才能看到 preview——与设计意图完全相反。

**解决方案：cache meta 加 schemaVersion**。`src/scanner/cache.ts` 当前结构：
```typescript
export type FileCache = Map<string, number>;
// loadCache 返回 FileCache，saveCache 写入 scan_cache.json
```

**改造为带 schemaVersion 的 cache**：
```typescript
// src/scanner/cache.ts
export type FileCacheMeta = { schemaVersion: number };
export type FileCacheFile = { meta: FileCacheMeta; cache: Array<[string, number]> };

export function loadCache(cachePath?: string): FileCache {
  const raw = readFileSync(cachePath, 'utf8');
  try {
    const parsed = JSON.parse(raw) as FileCacheFile;
    // 关键：schemaVersion 不匹配时返回空 cache
    if (parsed.meta?.schemaVersion !== 4) {
      logger.info(`scan_cache schemaVersion=${parsed.meta?.schemaVersion}，当前要求=4，丢弃 cache 全量重扫`);
      return new Map();
    }
    return new Map(parsed.cache);
  } catch {
    return new Map();
  }
}

export function saveCache(cache: FileCache, cachePath?: string): void {
  const data: FileCacheFile = {
    meta: { schemaVersion: 4 },  // 跟随 schema 版本硬编码或读 registry 的 version
    cache: Array.from(cache.entries()),
  };
  writeFileSync(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
```

**升级效果**：
- 升 v4 后第一次启动 → `loadCache` 看到 `schemaVersion` 缺失/=3 → 返回空 Map → scanner 全量重扫所有 JSONL → 填入 `last_user_preview` / `last_assistant_preview`
- 后续启动 → `schemaVersion === 4` → 正常用 cache

**替代方案（更简单）**：在 `scanner/index.ts` 启动时检测 `~/.cc-linker/registry.json` 的 version 字段，如果是 4 但 cache 仍存在 schemaVersion=3 痕迹，**直接 `unlink` cache 文件**。但这要求 scanner 知道 registry 的 schema 概念，耦合性更高。**推荐 cache 内部自决**。

**测试覆盖**（必加）：
- `tests/unit/scanner/cache.test.ts`：构造 v3 格式 cache → loadCache 返回空 → saveCache 写 v4 格式
- 集成：升 v4 第一次启动后，老 session 的 `last_user_preview` 不为空

### 3. `src/scanner/jsonl.ts` —— 抓 user + assistant 末条

**位置**：`parseTail`（`jsonl.ts:203-267`）和 `parseFull`（`jsonl.ts:113-201`）—— 实际行号以当前代码为准

**review 后补强**（user 消息 content 可能是两种形态）：
- 形态 A：`{"type":"user","message":{"content":"帮我做X"}}`（content 是字符串）
- 形态 B：`{"type":"user","message":{"content":[{"type":"text","text":"帮我做X"}]}}`（content 是数组）

**`last_message_preview` 字段保留**（仍写 assistant 末条 100 字符），向后兼容 CLI list 和 bot 多处使用；本设计**新增** `last_user_preview` / `last_assistant_preview` 两个独立字段（80 字符），互不替代。

**修改**：在原有 `preview` 提取基础上，加 `lastUserPreview`（**两种 content 形态都要覆盖**）：

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
  ...(preview ? { last_message_preview: preview } : {}),  // 【review 必改】必须保留 last_message_preview 写入（向后兼容 CLI / bot 多处）
  ...(preview ? { last_assistant_preview: preview.slice(0, 80) } : {}),  // 新增：截断 80 字符版
  ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) } : {}),  // 新增
};
```

**全量扫描**（`parseFull` 的 line 150-164 循环）部分同样改，**且 return 必须保留 `last_message_preview` 写入同时新增两个字段**（见下方 §3.2）。

### 3.2 `parseFull` return 完整改造（review 必改，原文档含糊）

**问题**：原 §3 含糊说"全量扫描部分同样改"，**没给 parseFull 的具体 return 改造**，会让实现者遗漏 `last_message_preview` 写入（与 #2 同源回归风险）。

**`parseFull` line 148-164 的循环**与 parseTail 大文件分支的小文件分支**同样改**：
- 加 `lastUserPreview` 提取循环（同时覆盖字符串和数组两种 content 形态）
- `lastActive` 和 `preview` 逻辑保持不变
- **【最终 review 必改】`parseFull` 没有 4KB 限制但仍只遍历最后 10 行**（line 150-164），与 parseTail 的小文件分支行为一致。**新 session 的 JSONL 可能在 user prompt 之前有大量 tool_use/tool_result**，10 行可能拿不到 `lastUserPreview`。**修复方式：parseFull 文件已经在内存（`readFileSync` 完整加载），直接在原循环中遍历 `lines` 全量而不是只 `lines.length - 10`**：

```typescript
// parseFull line 148-164 改造
let lastActive: string | null = null;
let preview = '';
let lastUserPreview = '';
for (let i = lines.length - 1; i >= 0; i--) {  // ← 全量遍历（不是 10 行）
  try {
    const entry = JSON.parse(lines[i]);
    if (NON_MESSAGE_TYPES.has(entry.type)) continue;
    if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
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
    // 三个字段都拿到就 break，提升性能
    if (lastActive && preview && lastUserPreview) break;
  } catch {
    // Silently skip malformed JSON lines
  }
}
```

**性能影响**：parseFull 只在首次扫描时调用（line 76-81 `if (!this.registry.has(sessionId))`），频率低；break 早退让 99% 情况下只遍历最后几行就完成。

**`parseFull` return 完整改造**（line 189-200，**必须保留 last_message_preview 写入**）：
```typescript
return {
  origin,
  cwd: cwd ?? (process.env.HOME ?? homedir()),
  project_name: this.inferProjectName(cwd ?? (process.env.HOME ?? homedir())),
  project_dir,
  title,
  message_count: messageLines.length,
  created_at: createdAt ?? new Date().toISOString(),
  last_active: lastActive ?? new Date().toISOString(),
  // 【review 必改】三段并存：last_message_preview 保留（向后兼容），新增 80 字符版
  last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',  // 保留 100 字符
  last_assistant_preview: preview ? preview.slice(0, 80) : undefined,  // 新增 80 字符
  last_user_preview: lastUserPreview ? lastUserPreview.slice(0, 80) : undefined,  // 新增
  status: 'active',
};
```

**数据冗余估算**：每个 entry 多两个 80 字符字段 ≈ +200B/entry，与 §"影响范围" 中的估算一致。

**测试覆盖**（必加）：parseFull 完整流程——给一个 50 行的 JSONL（user prompt 在第 1 行、assistant 回复在第 50 行、中间 48 行是 tool_use/tool_result），验证 return 包含三个字段：`last_message_preview`（100 字符）、`last_assistant_preview`（80 字符）、`last_user_preview`（80 字符）。

### 3.1 大文件 `last_user_preview` 命中率兜底（review 必改）

**问题**：`parseTail` 大文件分支（`jsonl.ts:215-219`）只读尾部 4KB 倒序遍历最后 10 行：
```typescript
const readSize = Math.min(4096, stat.size);
// ... 读 4KB
const tailLines = tail.split('\n').filter(Boolean).slice(-10);
```

**命中率风险**：实际 Claude Code JSONL 一轮完整对话可能含 5-10 条 line（user → assistant(thinking+tool_use) → user(tool_result) → assistant → ...）。如果用户最近一轮有大量 tool_use，**4KB / 10 行内只覆盖到 tool_result，原始 prompt 在 4KB 之外**。表现：overview 卡片显示 "最后提问: （无）"。

**注意**：`last_message_preview`（assistant 末条）命中率相对高，因为 assistant 文本通常在最后几行；但 `last_user_preview` 容易被复杂对话结构挤到 4KB 之外。

**兜底方案（推荐：方案 A 简单可靠）**：在 `parseTail` 大文件分支**找不到 `lastUserPreview` 时回退到 `parseFull`**：
```typescript
// parseTail 内部，大文件分支
let lastUserPreview = '';
for (let i = tailLines.length - 1; i >= 0; i--) {
  try {
    const entry = JSON.parse(tailLines[i]);
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

// 关键：4KB 内找不到 user preview 时，全量重读一次
if (!lastUserPreview && stat.size > 4096) {
  try {
    const fullContent = readFileSync(filePath, 'utf8');
    const allLines = fullContent.split('\n').filter(Boolean);
    for (let i = allLines.length - 1; i >= Math.max(0, allLines.length - 50); i--) {
      try {
        const entry = JSON.parse(allLines[i]);
        if (entry.type === 'user') {
          const content = entry.message?.content;
          if (typeof content === 'string') {
            lastUserPreview = content.slice(0, 100);
            break;
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === 'text');
            if (textBlock?.text) {
              lastUserPreview = textBlock.text.slice(0, 100);
              break;
            }
          }
        }
      } catch {}
    }
  } catch (err) {
    logger.warn(`parseTail 全量 fallback 失败: ${filePath}: ${err}`);
  }
}
```

**性能影响**：仅在大文件 4KB 内找不到 user preview 时才回退（命中率低的极端情况），单次重读 < 1ms，可接受。

**替代方案（备选）**：
- **方案 B**：把 readSize 增大到 16KB / 32KB（覆盖 50-100 行），简单但有持续开销
- **方案 C**：scanner 额外跑一个 `extractLastUserPrompt(filePath)`，独立流程
- **不推荐**：方案 D（无 fallback 接受空 preview）—— 用户体验差，与"修复痛点 B"目标矛盾

**测试覆盖**（必加）：构造 100 行的 JSONL，user prompt 在第 1 行，assistant 回复在第 100 行（中间 50 行是 tool_use/tool_result）—— 验证 `last_user_preview` 仍能提取出第 1 行的 prompt。

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

**关于 `esc()` helper（review 必改）**：当前 `bot.ts` 没有 `esc()` 函数，`esc` 只在 `src/feishu/card-updater.ts:448` 私有定义。`buildSessionOverviewCard` 引用 `esc(entry.last_user_preview)` / `esc(entry.last_assistant_preview)` 会编译失败。**两个解决方案二选一**：
- **方案 A（推荐）**：在 `bot.ts` 文件底部（与 `preview()` / `buildSessionTitle()` 同区域）定义本地版本
  ```typescript
  function esc(text: string): string {
    return text.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
  }
  ```
- **方案 B**：从 `card-updater.ts` export `esc`，bot.ts import（但会扩大 card-updater 的公开 API）

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

  // 【review 必改】swapped=false 时不发 overview 卡片（会误导用户以为切换成功）
  // 改为发"切换失败"消息，保持与改造前一致
  if (!swapped) {
    const failReply = '⚠️ 切换失败，会话可能已被修改';
    if (msg) await this.replyAndFinalize(msg, failReply);
    else await this.replyFn(failReply, { messageId, openId, requestUuid: uniqueUuid() });
    this.spoolQueue.recordReceipt(messageId ?? '');
    return 'failed';
  }

  // swapped=true：判断目标 session 是否正在跑 Claude
  const isRunning = this.isSessionRunning(uuid);

  // 发概览卡片（uuid 来自入参，不是 session 上的字段）
  const card = buildSessionOverviewCard(uuid, session, isRunning);
  const replyId = await this.cardReplyFn(card, { messageId, openId });

  if (replyId) {
    if (msg) {
      this.spoolQueue.recordDelivery(...);
      this.spoolQueue.markReplied(...);
      this.spoolQueue.markDone(...);
    } else {
      this.spoolQueue.recordReceipt(messageId ?? '');
    }
  } else {
    // 降级到 text（卡片 API 失败时）
    const reply = `✅ 已切换到 ${uuid.slice(0, 8)}\n💬 最后提问：${session.last_user_preview ?? '无'}\n🤖 最后回复：${session.last_assistant_preview ?? '无'}\n📊 ${session.message_count} 条消息 · ${formatTimeAgo(session.last_active)}`;
    if (msg) await this.replyAndFinalize(msg, reply);
    else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
  }
  return 'switched';
}

private isSessionRunning(uuid: string): boolean {
  // ClaudeSessionManager 暴露 listSessions()，检查是否有 sessionId === uuid
  return this.sessionManager.listSessions().some(s => s.sessionId === uuid);
}
```

**注意**：`ClaudeSessionManager.listSessions()` 当前返回所有 active process 的 `ClaudeSession`，每个有 `sessionId` 字段（line 890-892）。这能正确判断"目标 session 是不是在跑"。

**关于 swapped=false 路径（review 补强）**：原设计中 `if (!swapped) { /* 同上 */ }` 是占位注释，实际行为未明确。**改造后必须显式处理**：
- swapped=false → 发"切换失败"消息（**绝不**发 overview 卡片，否则用户会误以为切换成功）
- swapped=true → 发 overview 卡片（或 text 降级）

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

**降级 text 路径同步改造（review 必改）**：当前 `doCardList` 在 `cardReplyFn` 返回 null 时降级到纯文本（`bot.ts:1837-1853`），**原降级路径没有运行中标记**——卡片有 🔴，text 没有，UX 不一致。**必须同步加 `[运行中]` 标记**：

```typescript
// 在降级 text 分支内，构造 lines 时
for (const [index, [uuid, session]] of sessions.entries()) {
  const providerTag = session.lastKnownProvider ? ` [${session.lastKnownProvider}]` : '';
  const runningTag = runningUuids.has(uuid) ? ' [运行中]' : '';  // ← 新增
  lines.push(`${index + 1}. ${session.title ?? 'Untitled'}${providerTag}${runningTag}`);
  lines.push(`   ID: ${uuid.slice(0, 8)}`);
  lines.push(`   ${formatOrigin(session.origin, session.status)} | ${session.message_count}条 | ${formatTimeAgo(session.last_active)} | ${session.project_name ?? basename(session.cwd)}`);
  lines.push('');
}
```

**一致性原则**：卡片与 text 降级路径必须展示相同的运行中状态，否则用户看到"卡片说在跑，text 又说没在跑"会困惑。

### 7. 测试

**新增单测** `tests/unit/feishu/bot-serial-key.test.ts`：
- 验证 command 消息的 serialKey 形如 `cmd:openId:msgId`（带 messageId）
- 验证非 command session 消息 serialKey 是 sessionUuid
- 验证非 command 无目标消息 serialKey 是 `new:openId`
- **关键**：验证两个不同 messageId 的 command 不会互相阻塞（通过 SpoolQueue 模拟）

**新增单测** `tests/unit/scanner/jsonl-preview.test.ts`：
- 给定 JSONL 内容（含 assistant text + user prompt），验证 parseTail 返回 `last_user_preview` / `last_assistant_preview` 各 80 字符
- 验证 user content 是字符串形态（形态 A）时正确提取
- 验证 user content 是数组形态（形态 B）时正确提取
- 验证 assistant content 是数组形态时正确提取（已有逻辑）
- 验证空文件 / 损坏行不抛错
- 验证只有 user 没有 assistant 时 `last_assistant_preview` 为 undefined
- 验证 `last_message_preview` 仍然保留（不被本次改动破坏）

**新增单测** `tests/unit/feishu/bot-do-switch.test.ts`：
- 验证 doSwitch 在 session 正在 listSessions() 中时，isRunning=true
- 验证卡片内容包含 🔴 标记 + last_user_preview + last_assistant_preview
- 验证卡片降级到 text 时包含关键信息

**集成测试（MUST，上线前必跑）**：模拟 5 个场景（用真实 SpoolQueue + 真实 mock 飞书 client，不依赖飞书网络）
- 场景 A（MUST）：session A streaming 中 → /list 立即返回（验证 command 独立 serialKey）
- 场景 B（MUST）：/new -- prompt → /list 立即返回（验证 /new 和 /list 并行）
- 场景 C（MUST）：/new -- prompt1 → /new -- prompt2 第二条等第一条（验证内部 `new:openId` lock 互斥）
- 场景 D：/new（无 prompt）→ /list 立即返回
- 场景 E（MUST）：连续 /list 三条都快速返回（验证 worker pool 不会阻塞）

**现有测试更新（必改）**：`tests/unit/feishu/bot.test.ts:620` 的 `handleCardAction routes switch with UUID` 测试**会因 doSwitch 输出从 text 改为 card 而失败**——原断言 `expect(textReplies[0]).toContain('已切换到会话')` 不再成立。**修复方式**：测试改为断言 `expect(cardReplies.length).toBe(1)` + `expect(cardReplies[0].header.title.content).toContain('已切换会话')`。`bot.test.ts:640` 的 `nonexistent session` 测试保持不变（doSwitch 第一行 check session 不存在时仍发 text 消息"未找到"）。`bot.test.ts:979` 的 `select_dir` 不在本次改造范围，保持不变。

## 错误处理

| 场景 | 处理 |
|------|------|
| session 找不到 | `doSwitch` 当前已有 fallback 行为：reply "未找到对应会话"，不变 |
| registry v3 升级 v4 | **必须实现 `migrateV3toV4(parsed)`**（详见 §2 三个调用点）—— 只 bump `parsed.version = 4`，**不依赖 Zod optional 兜底**（Zod 解析失败会走 `restoreFromBackup` 丢数据）。`last_user_preview` / `last_assistant_preview` 缺省为 undefined，由 scanner 第一次重扫时填入 |
| scanner 缓存中老条目无 preview | scanner 解析时只有当新值非空才 patch，老 entry 不被覆盖；list 卡片没 preview 时不显示该行 |
| **scanner 缓存 schemaVersion 失配**（review 必改） | `loadCache` 检测到 `meta.schemaVersion !== 4` 时返回空 Map，scanner 全量重扫所有 JSONL，**填入 `last_user_preview` / `last_assistant_preview`**。这保证 schema 升 v4 后老 session 一次性获得新字段（详见 §2.1） |
| `listSessions()` 返回空（idle） | `runningUuids` 为空集，list 卡片无 🔴 标记 |
| 概览卡片 text 字段含 markdown 特殊字符 | `esc()` 转义 `<` / `>`（**bot.ts 内部新增本地版本**，详见 §4） |
| **messageId 格式异常**（review 风险） | `onMessage` 入口加白名单 `/^[a-zA-Z0-9_-]+$/` 校验，**不符合直接 reply "消息格式异常" 拒绝入队**——保证 spool 文件名永远形如 `${serialKey}:${messageId}.json` 的双 `:` 结构（避免特殊字符打乱 prefix 匹配） |
| `last_user_preview` 包含多行 | preview 逻辑已有 normalize whitespace，按 80 字符截断 |
| serialKey 文件名冲突 | 文件命名规则 `${serialKey}:${messageId}.json`，新 `cmd:` 前缀与现有 `new:` 不会冲突 |
| 老 v3 registry 直接进 v4 bot | Zod 解析失败时 `registry.ts:88` 的 `restoreFromBackup` 兜底 |

## 数据流

### 场景 A：session A streaming 中，用户发 /list

```
T0: WSClient → onMessage({ text: "/list", messageId: "m_list" })
    isCommand = true
    serialKey = "cmd:openId:m_list"
    spoolQueue.enqueue → pending/cmd:openId:m_list:m_list.json

T1: dispatch() 轮询 → claimNext("cmd:openId:m_list")
    processing 目录没有 cmd:openId:m_list:* → claim 成功
    activeWorkers 启动 handleClaimed → handleCommand → handleList → doCardList

T2: doCardList 读 registry (syncBeforeCommand) → 列表卡片
    cardReplyFn → 飞书 API 立即发卡片
    markReplied / markDone

T3: 飞书收到新卡片（包含 🔴 标记表示 session A 在跑）
```

### 场景 B：/new -- prompt + /list

```
T0: /new -- p1 入队 → pending/cmd:openId:m_new1:m_new1.json
T1: claim "cmd:openId:m_new1" → handleNew → createSessionFromPromptSDK
    sendSDKMessage(lockKey="new:openId") → acquireSessionLock 成功 → spawn Claude
T2: /list 入队 → pending/cmd:openId:m_list:m_list.json
T3: claimOne 遍历 pending:
      - msg_new1.serialKey = "cmd:openId:m_new1" → claimNext("cmd:openId:m_new1")
        → 检查 processing 目录是否有 "cmd:openId:m_new1:" 前缀
        → 有 → 返回 null
      - msg_list.serialKey = "cmd:openId:m_list" → claimNext("cmd:openId:m_list")
        → 检查 processing 目录是否有 "cmd:openId:m_list:" 前缀
        → 没有 → claim 成功 ✓
T4: handleList 并行启动，不等 /new
```

### 场景 C：连续两个 /new -- prompt

```
T0: /new -- p1 → claim "cmd:openId:m_new1" 成功 → handleNew → createSessionFromPromptSDK
    sendSDKMessage(lockKey="new:openId") → acquireSessionLock OK → spawn Claude p1
T1: /new -- p2 → claim "cmd:openId:m_new2" 成功（不同 serialKey）
    handleNew → createSessionFromPromptSDK
    sendSDKMessage(lockKey="new:openId") → acquireSessionLock BLOCKED（等 p1）
T2: p1 完成 → releaseSessionLock → p2 接着跑
```

## 测试计划

### 单元测试（必须全过）

1. `tests/unit/feishu/bot-serial-key.test.ts`（新）
2. `tests/unit/scanner/jsonl-preview.test.ts`（新）
3. `tests/unit/feishu/bot-do-switch.test.ts`（新）
4. `tests/unit/registry/migration-v3-v4.test.ts`（新）—— **必覆盖的边界用例**（review 必改）：
   - **v3 → v4 升级**：构造 v3 完整 registry（含所有字段），调 `load()` → 验证内存 version=4，sessions 完整保留
   - **v3 缺字段**：v3 entry 缺 `last_message_preview` → migrate 后保留为 `''`（不丢数据）
   - **v3 缺 optional 字段**：v3 entry 缺 `pending_jsonl_resolve` / `last_error` / `feishu_user_id` / `lastKnownProvider` → migrate 后保留为 undefined
   - **v4 幂等**：构造 v4 registry → 多次 `load()` → version 保持 4，sessions 不变
   - **v3 → v3 backup 链路**：构造 v3 backup → `restoreFromBackup()` → migrate → load 成功
   - **v2 → v1toV2 → v3toV4 完整链路**：构造 v2 registry → load → 验证最终 version=4
   - **空 registry 兜底**：v3 文件不存在 → `createEmpty()` → `emptyRegistry()` 返回 v4（验证 `version: 4` 硬编码正确）
   - **损坏 v3 文件**：JSON parse 失败 → `restoreFromBackup` 失败 → `createEmpty()` → 返回 v4 空 registry（不抛异常）
5. `tests/unit/scanner/cache.test.ts`（新）—— **必覆盖**（review 必改）：
   - 构造 v3 格式 cache（无 `meta.schemaVersion` 字段）→ `loadCache` 返回空 Map
   - 构造 v3 格式 cache（`meta.schemaVersion: 3`）→ `loadCache` 返回空 Map
   - 构造 v4 格式 cache（`meta.schemaVersion: 4`）→ `loadCache` 返回原 Map 内容
   - 损坏 cache JSON → `loadCache` 返回空 Map（不抛）
   - `saveCache` 写出的 JSON 含 `meta.schemaVersion: 4`
6. 现有 `tests/unit/scanner/jsonl.test.ts`、`tests/unit/feishu/bot.test.ts` 全过

### 手工验证（开发机）

1. 启动 bot（`bun run dev start`）
2. 场景 A-C 同数据流章节，手动跑一遍
3. 截图发到 `docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md`（可选）

## 影响范围

- 飞书侧用户体验：✅ 修复阻塞，✅ 切换时看到进展
- CLI 侧：零影响（serialKey 计算在 FeishuBot.onMessage 内）
- Scanner：新增两个字段，旧数据不丢；`last_message_preview` 字段保留不破坏
- 兼容性：v3 registry 必须通过 `migrateV3toV4` 升级 v4（`version` bump）
- 性能：scanner 每次 parseTail 多读 1 个字段，O(1) 开销
- 存储：registry.json 每条 entry 多 2 个 80 字符字段，约 +200B/entry
- 文件系统：spool 目录里会出现 `cmd:openId:msgId:msgId.json` 这种文件名（仅命名冗余，不影响 logic）

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| **command serialKey 用 `cmd:openId` 不带 messageId**（review 发现的初版错误）会让 `/new -- p1` 期间 `/list` 仍被同 serialKey 卡住 | 改用 `cmd:${openId}:${messageId}`，每个 command 独立；单元测试覆盖 5 个并发场景 |
| command serialKey 改了后有遗漏的串行化点 | 单元测试覆盖 + e2e 场景 C |
| v3 → v4 migration 缺函数导致 Zod 解析失败 → 走 `restoreFromBackup` 丢数据 | 实现 `migrateV3toV4(parsed)`：只 bump `parsed.version = 4`，新字段 optional 缺省 undefined |
| list 卡片加运行中标记导致卡片过大 | preview 截断 60 字符（list 用），overview 截断 80 字符 |
| `listSessions()` 不包含 waiting-in-spool 的 session | 这类不算"运行中"，本来就不应该标 🔴 |
| `last_user_preview` 把用户的敏感命令也抓出来 | 已经是 80 字符 preview，没全量；用户自己用飞书发出去的自己能看到 |
| user content 是字符串形态（不是数组）时 preview 抓不到 | scanner 同时覆盖两种 content 形态（review 补强） |
| `last_message_preview` 被破坏 | scanner 同时**保留**对 `last_message_preview` 的写入（不改原逻辑），新字段独立 |
| overview 卡片降级到 text 路径里 reply 消息体积过大 | 已有 splitReplyText，兜底路径不再变 |
| `runningUuids` 跟 card title 重复导致 list 卡片字符超限 | list 元素不超 4KB，10 条 + 标记应该没问题；e2e 跑一遍确认 |
| spool 文件名 `cmd:openId:msgId:msgId.json` 重复了 messageId | 仅文件名冗余，不影响 prefix 匹配逻辑（`startsWith` 仍工作） |
| **messageId 含特殊字符导致文件名解析错乱**（review 风险） | 飞书 messageId 典型格式 `om_xxxxx_xxxxx`（字母数字下划线），理论不含 `:` / `/`，但**作为 defense-in-depth 在 `onMessage` 入口加白名单校验**：不符合 `/^[a-zA-Z0-9_-]+$/` 的 messageId 视为格式异常，直接 reply "消息格式异常" 拒绝入队；保证 spool 文件名永远形如 `${serialKey}:${messageId}.json` 的双 `:` 结构 |

## 不做的事（YAGNI）

- 不实现 session 切换后自动 follow streaming 卡片（成本高，需要 CardUpdater 引用计数）
- 不实现 command 历史回放（用户用 /list 自己找）
- 不实现 thinking + tool calls 完整末条（YAGNI，80 字符够用）
- 不实现 schema 真 v3 → v4 数据迁移脚本（Zod optional 兜底）
- 不实现 "running session" 单独的 status 类型（仅在 list 卡片和 switch 卡片用 🔴 标记）

## 实施计划（PR 拆分、回滚、Staging、监控）

### PR 拆分策略（推荐三 PR 串行）

**PR 1：Schema + Scanner（独立可回滚）**
- 范围：`src/registry/types.ts` / `src/registry/registry.ts`（migrateV3toV4 + emptyRegistry）/ `src/scanner/jsonl.ts`（parseTail + parseFull + 4KB fallback）/ `src/scanner/cache.ts`（schemaVersion）
- 测试：migration-v3-v4.test.ts (7 用例) + cache.test.ts (5 用例) + 更新 jsonl.test.ts
- 风险：纯数据层，**不会影响飞书侧任何行为**（只新增字段，老代码读 v4 registry 时只忽略新字段）
- 部署：可直接合 master，不依赖后续 PR
- 回滚：git revert + 老版本 scanner 仍能读 v3 registry（回滚后 schema version 不降，因为磁盘已是 v4——但 mtime 不变 scanner 跳过，不重写 v3 字段也无影响）

**PR 2：bot.ts serialKey 改造（独立可回滚）**
- 范围：`src/feishu/bot.ts` onMessage serialKey 计算 + messageId 白名单校验 + esc helper
- 测试：bot-serial-key.test.ts + 现有 bot.test.ts 全过
- 风险：command 走独立 serialKey 后，**用户体验即时改善**（不需等 PR 3）；但 PR 2 + PR 1 时 `last_user_preview` 还没生效，overview 卡片数据不全
- 回滚：git revert；老 serialKey `new:openId` 行为恢复，但用户回到原阻塞痛点

**PR 3：bot.ts overview 卡片 + list 标记（独立可回滚）**
- 范围：buildSessionOverviewCard / isSessionRunning / doSwitch 改造 / buildListCard 加 runningMark / doCardList text 降级
- 测试：bot-do-switch.test.ts + 更新 bot.test.ts (PR 1 提到的 620 行)
- 风险：纯 UI 增强，**不影响命令并发行为**（PR 2 已修复）；最坏情况：doSwitch 报错，老的 text 回复兜底
- 回滚：git revert；overview 卡片降级到 text，"已切换到会话 xxx" 行为恢复

**为什么三 PR**：
- 每个 PR 独立可回滚
- 每个 PR 独立可测
- 每个 PR 不阻塞后续 PR
- 紧急时只需 revert PR 3，PR 1 + PR 2 的并发修复保留

### Staging 验证步骤

**必跑**：
1. 部署 PR 1 → 启动 staging bot → 检查 `~/.cc-linker/registry.json` version 字段从 3 升 4
2. 检查 `scan_cache.json` 有 `meta.schemaVersion: 4`
3. 触发 `/list` → 老 session 卡片显示 `last_user_preview` / `last_assistant_preview`（不再为空）
4. 部署 PR 2 → 触发 `/list` while session A streaming → 应**立即返回**（秒级，不等 streaming 完）
5. 部署 PR 3 → 点击"切换" → 应收到 overview 卡片，含最后提问 + 最后回复 + 🔴 标记

**冒烟测试**（5 分钟手动）：
- 场景 A：streaming + /list 立即返回
- 场景 E：连发 3 次 /list 都快速返回
- 切换到一个 streaming session → 看到 🔴 标记

### 回滚方案

**紧急回滚（PR 3 出问题）**：
```bash
git revert <PR-3-merge-commit>
# 重新构建并部署
bun run build && bun run start --daemon
# 行为：overview 卡片消失，回到 "已切换到会话 xxx" text
```

**完全回滚到 v3 行为**（schema 也回滚）：
- 不推荐——磁盘 v4 数据需要特殊处理
- 如必须：revert 所有 PR + 手动 `cat registry.json | jq '.version = 3'`（**会触发老 bug：read v3 schema 解析 v4 data 失败**）
- **结论：v4 升级是单向的，不要回退 schema**

**部分回滚（保留 schema，禁用 overview 卡片）**：
- 通过 `config.toml` 加 `feishu_bot.overview_card_enabled = false` 临时禁用（实现时考虑加这个开关，YAGNI 列表里可挪到 MUST）

### 上线后监控指标

**关键指标**（加到现有 logger 或 metrics 模块）：
1. `cmd.processing.duration_ms` (P50/P95) —— command 处理耗时，应该在 PR 2 后显著下降（不再等 streaming 完）
2. `cmd.queue.wait_ms` (P50/P95) —— command 在 spool 等待 claim 的时间，PR 2 后应 < 100ms
3. `overview.card.sent` (count) —— overview 卡片发送次数，PR 3 后应随用户切换行为增长
4. `last_user_preview.hit_rate` (ratio) —— scanner 提取到 `last_user_preview` 的比例，PR 1 后应 > 90%
5. `scanner.cache.invalidation` (count) —— cache schemaVersion 失配次数，PR 1 上线当天应有一次（清空老 cache）
6. `migration.v3_to_v4.duration_ms` —— 迁移耗时，应 < 1s

**告警阈值**：
- `cmd.queue.wait_ms` P95 > 5s 持续 5min：可能 worker pool 卡死
- `last_user_preview.hit_rate` < 80%：可能 scanner 4KB fallback 没生效
- `migration.v3_to_v4` 报错：立即回滚 PR 1

### 实施时间估算

| PR | 范围 | 工作量 | 风险 |
|----|------|--------|------|
| PR 1 | Schema + Scanner | 1.5 天（含测试） | 低 |
| PR 2 | serialKey 改造 | 0.5 天 | 低 |
| PR 3 | overview 卡片 | 1 天（含测试） | 中 |
| **总计** | - | **3 天** | - |

**注意**：3 天不含 staging 验证和 review 反馈循环。
