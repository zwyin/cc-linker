# cc-linker scanner preview 质量优化设计文档

> 日期：2026-06-05
> 范围：scanner 抓 assistant 末条算法 + registry 字段长度调整
> 前置：2026-06-02 spec（schema v3→v4 + last_assistant_preview 80 字符）

## 背景

2026-06-02 spec 引入了 `last_assistant_preview` 字段（80 字符 raw），
但用户截图反馈两个问题：

1. **信息密度不足**：80 字符在飞书 blockquote 渲染后只有 1.5 行，
   复杂回复（如 review 决策版）信息密度太高，关键内容被截掉
2. **markdown 噪声**：scanner 直接把原始 markdown 写入 registry，
   飞书卡片对 blockquote 内的 `##` 标题不渲染、对 ```code``` 截在中间

参考截图（飞书实际渲染）：

```
💬 最后提问:
> 推荐路径：内存队列，不上
> git_bridge_queue 表
> --- 同意你的建议，不过请你思考下，
> 这个方案是否会引起 Agent 内存占用
> 的大量膨胀上升，这        ← 截在句中

🤖 最后回复:
> # 完整最终 Review 修改意见（决策版）  ← ## 不渲染
>
> ## 0. 内存膨胀分析                    ← ## 不渲染
>
> ### 0.1 单个 queue item 真实大小     ← ### 不渲染
>
> 看 \`traeScanne                       ← 截在 code span 中
```

## 目标

修复「已切换会话」概览卡片的 last_assistant_preview 展示问题：

1. **可读性**：去除 markdown 结构噪声（标题符号、加粗、代码标记）
2. **完整性**：长度从 80 字符扩到 240 字符（约 3-4 行）
3. **正确性**：抓 assistant 末条时跳过 thinking 块、跳过中间态（text + tool_use）
4. **零回归**：不动 render 端代码、不动 `last_message_preview` 字段

## 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 修复层 | scanner 侧治本 | 用户已选；registry 字段语义更稳，所有用 last_assistant_preview 的地方（list / overview）一次性受益 |
| 长度 | 80 → 240 字符 | 飞书 blockquote 渲染 3-4 行；YAGNI 不加"展开"按钮 |
| markdown 清理 | 标准（去 ##, **, `, ```） | 用户已选；保留标题文字、代码内容、列表 -、链接 [text](url) |
| thinking 块处理 | 跳过整个 message 找前一个有 text 的 | assistant 末条可能只 thinking 没说 final answer |
| 中间态 message | 跳过（有 text 但同时有 tool_use） | model 准备 tool call 不是 final answer |
| schema 版本 | 不变（仍 v4） | 字段语义微变不破坏兼容性，老数据 sync --force 重扫 |
| last_user_preview | **不改** | 截图里 user prompt 也被截但相对信息密度低；YAGNI，本次只动 assistant |
| last_message_preview | **不改** | 100 字符 raw 是 CLI / bot 多处复用，改了会破坏向后兼容 |
| render 端 | **不动** | scanner 输出干净版，render 直接显示；零侵入 |
| 部署方式 | 单 PR | 改动小（仅 scanner + 测试 + 数据迁移），3 个变更文件 |

## 架构

### 改动 1：scanner parseTail 抓 assistant 末条算法

**位置**：`src/scanner/jsonl.ts` `parseTail` 的 tail 4KB 循环（line 263-289）
和 parseFull 的全量循环（line 145-194）

**修改前**：
```typescript
if (entry.type === 'assistant' && !preview) {
  const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
  if (textBlock) preview = textBlock.text.slice(0, 100);
}
```

**修改后**（伪代码，详细实现在下方 §组件）：
```typescript
// 找到 assistant 末条 cleaned text 后写入 preview
// 跳过 thinking-only、跳过 tool_use-only、跳过中间态
// 对 text 做 markdown 清理后截断 240 字符
```

### 改动 2：registry 字段长度文档化

**位置**：`src/registry/types.ts`（JSDoc 注释，不改 zod schema）

```typescript
// 旧注释（80 字符 raw）：
// last_assistant_preview?: z.string().optional(),  // 80 字符 raw markdown

// 新注释（240 字符 cleaned）：
// last_assistant_preview?: z.string().optional(),  // 240 字符，去 ##/**/`/``` 后
```

**Zod schema 不变**（仍 `z.string().optional()`），不破坏 v4 → v4 兼容性。

### 改动 3：sync --force 触发数据迁移

**位置**：用户操作，不改代码

老 v4 数据 last_assistant_preview 是 80 字符 raw markdown，**必须 sync --force 重扫**才能升级。
文档明确说明（spec §"数据迁移"）。

## 组件

### 1. `src/scanner/jsonl.ts` —— 新增 `cleanAssistantText()` 静态方法

```typescript
/**
 * 从 assistant message 数组中提取 cleaned final-answer text
 *
 * 算法（与下方实现严格对应）：
 * 1. 倒序遍历 messages
 * 2. 跳过非 assistant message
 * 3. 跳过 content 不是数组的（防御性，覆盖 string content 形态）
 * 4. 跳过中间态（has tool_use）：model 准备 tool call 不是 final answer
 * 5. 跳过无 text 块的：自然过滤 thinking-only 和 tool_use-only 两种情况
 * 6. 合并该 message 的所有 text 块
 * 7. markdown 清理（standard 级别）
 * 8. 截断 maxLength 字符，按行边界回退
 *
 * 边界处理：
 * - 整个 JSONL 没找到符合的 assistant message → 返回 null
 * - text 块全部为空字符串（异常情况）→ 返回 null
 * - 截断后以 '...' 结尾（与 preview() 行为对齐）
 */
private static cleanAssistantText(
  messages: Array<{ type: string; message?: { content?: unknown } }>,
  maxLength: number = 240,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    // 跳过中间态：有 tool_use 说明 model 还在继续
    const hasToolUse = content.some((b: any) => b?.type === 'tool_use');
    if (hasToolUse) continue;

    // 找所有 text 块
    const textBlocks = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text);
    if (textBlocks.length === 0) continue;

    // 合并 + 清理
    const raw = textBlocks.join('\n');
    const cleaned = JSONLScanner.stripMarkdownNoise(raw);
    const truncated = JSONLScanner.truncateByLine(cleaned, maxLength);

    return truncated;
  }
  return null;
}

/**
 * 清理 markdown 结构化噪声（standard 级别）
 *
 * 规则：
 * - /^#{1,6}\s+/gm → ''        行首标题符号
 * - /\*\*/g        → ''        加粗
 * - /`/g           → ''        行内代码标记 + 代码块边界
 *
 * 保留：
 * - 标题文字本身（去掉 # 但保留字）
 * - 代码内容（去掉 ` 但保留内容）
 * - 列表 - / 1. 符号
 * - 链接 [text](url) 原样
 * - blockquote > 符号
 */
private static stripMarkdownNoise(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')           // 行首 # ## ### ######
    .replace(/\*\*/g, '')                   // 加粗 **
    .replace(/`/g, '');                     // 代码标记 ` ``` (保留内容)
}

/**
 * 截断到 maxLength，按行边界回退
 *
 * 规则：
 * - 如果原文长度 ≤ maxLength，直接返回
 * - 否则按 \n 分割，找到第一个累积长度 ≤ maxLength 的行边界
 * - 截断后追加 '...'（与现有 preview() 行为对齐）
 *
 * 例：
 * - maxLength=240，文本 250 字符无 \n → slice(0, 240) + '...'
 * - maxLength=240，文本 300 字符（10 行，每行 30）在第 9 行结束 → 截到第 9 行 + '...'
 */
private static truncateByLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxLength * 0.5) {
    // 至少保留一半内容才按行截
    return truncated.slice(0, lastNewline) + '...';
  }
  return truncated + '...';
}
```

### 2. `src/scanner/jsonl.ts` —— `parseTail` 改造

**位置**：line 263-289（tail 4KB 循环）

**修改前**（line 269-272）：
```typescript
if (entry.type === 'assistant' && !preview) {
  const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
  if (textBlock) preview = textBlock.text.slice(0, 100);
}
```

**修改后**：
```typescript
// 收集所有 assistant message 进数组（不在循环里直接处理，倒序遍历一次性能更好）
// 抽到循环外：line 263 之前准备 assistantMessages: any[] = []
// 循环里加：
if (entry.type === 'assistant') {
  assistantMessages.push(entry);
}
// lastActive 仍在循环里处理（保持原顺序）

// 循环结束后调用 cleanAssistantText（line 263 之前声明的 assistantMessages）
const cleanedAssistant = JSONLScanner.cleanAssistantText(assistantMessages, 240);
if (cleanedAssistant) preview = cleanedAssistant;
```

**重要**：`tailLines.slice(-10)` 只取最后 10 行，可能漏掉前一个 assistant message。
**兜底（必须）**：如果 tail 4KB 内没找到 cleaned assistant（`cleanAssistantText(assistantMessages) === null`），
**全量重读 fallback 阶段也要再次调用 `cleanAssistantText`**（与现有 `lastUserPreview` fallback 对齐）：

```typescript
// parseTail line 309 附近的 fallback 块内新增：
if (!preview && stat.size > 4096) {  // preview 仍空 → 也尝试 cleanAssistantText
  try {
    const fullContent = readFileSync(filePath, 'utf8');
    const allLines = fullContent.split('\n').filter(Boolean);
    const allAssistantMessages: any[] = [];
    for (const line of allLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant') allAssistantMessages.push(entry);
      } catch {}
    }
    const cleanedFromFull = JSONLScanner.cleanAssistantText(allAssistantMessages, 240);
    if (cleanedFromFull) preview = cleanedFromFull;
  } catch (err) {
    logger.warn(`parseTail cleanAssistantText 全量 fallback 失败: ${filePath}: ${err}`);
  }
}
```

### 3. `src/scanner/jsonl.ts` —— `parseFull` 改造

**位置**：line 145-194（lines 倒序循环）

**修改前**（line 184-189）：
```typescript
if (entry.type === 'assistant' && !preview) {
  const text = JSONLScanner.extractTextContent(entry.message?.content);
  if (text) preview = text.slice(0, 100);
}
```

**修改后**：
```typescript
// 同样收集 assistantMessages
// 循环结束后调 cleanAssistantText
```

注意：parseFull 是全量读（line 132 `readFileSync`），所有 assistant message 都在内存，
无需 fallback。

### 4. `src/scanner/jsonl.ts` —— return 改造

**parseTail return**（line 354-359）：
```typescript
// 修改前：
...(preview ? { last_assistant_preview: preview.slice(0, 80) } : {}),

// 修改后：
...(preview ? { last_assistant_preview: preview.slice(0, 240) } : {}),  // cleanAssistantText 已截断到 240
```

**parseFull return**（line 235-239）：
```typescript
// 修改前：
last_assistant_preview: preview ? preview.slice(0, 80) : undefined,

// 修改后：
last_assistant_preview: preview ?? undefined,  // cleanAssistantText 已处理截断
```

### 5. `src/registry/types.ts` —— JSDoc 更新

```typescript
// SessionEntrySchema 字段注释（不改 zod schema）：
// last_message_preview: 100 字符 raw markdown（CLI / bot 多处复用，保留向后兼容）
// last_assistant_preview: 240 字符 cleaned（去 ##/**/`/``` 后，bot 概览卡片专用）
// last_user_preview: 80 字符 raw user prompt（向后兼容，本 spec 不动）
```

## 数据迁移

### 老 v4 数据 last_assistant_preview = 80 字符 raw

**升级方式**：`cc-linker sync --force` 清空 scan_cache.json，触发 scanner 全量重扫所有 JSONL。

**为什么不需要新 schemaVersion**：
- registry schema 不变（zod schema 没动）
- scan_cache.json 的 `meta.schemaVersion: 4` 不变
- 只是 `last_assistant_preview` 字段含义微变（长度 + 内容清理）
- scanner 写入时直接覆盖老值，无需版本协调

**数据回滚路径**：
- 重扫前备份 `~/.cc-linker/registry.json` → `~/.cc-linker/backups/registry.json.bak`（registry 自动 rotate 3 份）
- 如果新版有问题，`git revert` 后 sync 一次 → scanner 重新抓 80 字符 raw（老算法）

### 自动化建议（YAGNI 列表）

不在本次实现：
- 自动检测老格式 vs 新格式（要新增 registry 字段 `preview_format_version`）
- 增量迁移（`last_assistant_preview` 长度 < 240 时强制重扫）

理由：用户手动 `sync --force` 一次即可，3 个动作（bot stop → sync --force → bot start）。

## 错误处理

| 场景 | 处理 |
|------|------|
| assistant 末条只 thinking | `cleanAssistantText` 跳过这条，遍历前一个 |
| assistant 末条只 tool_use | 同上 |
| assistant 末条 text + tool_use（中间态） | 同上 |
| 整个 JSONL 没 final answer | `cleanAssistantText` 返回 null → `last_assistant_preview` 为 undefined → overview 卡片跳过 🤖 最后回复 |
| text 块内容为空字符串 | extractTextContent 跳过，cleanAssistantText 返回 null |
| 截断后内容 < 50% maxLength | 仍按字符截断（不要强行按行截短） |
| JSONL 损坏 | 现有 try/catch 兜底，不变 |
| 老 cache schemaVersion=4 | 继续工作（用 mtime 检查），但需要 sync --force 触发重扫 |

## 数据流

### 场景：用户切换到一个有 246 条消息的 session

```
T0: 飞书 WSClient → onMessage({ text: "/switch abc-uuid", ... })
    isCommand = true, serialKey = "cmd:openId:msgId"
    spoolQueue.enqueue → pending/

T1: handleClaimed → handleCommand → doSwitch(abc-uuid)
    registry.get("abc-uuid") → entry
    entry.last_assistant_preview = "完整最终 Review 修改意见（决策版）\n\n0. 内存膨胀分析\n\n0.1 单个 queue item 真实大小\n\n看 traeScanner 代码..."  (240 字符)
    buildSessionOverviewCard(abc-uuid, entry, false) → card

T2: card.elements = [
  { tag: 'markdown', content: '**🔄 已切换**...' },
  { tag: 'markdown', content: '**💬 最后提问：**\n> 推荐路径：内存队列，不上 git_bridge_queue 表\n> --- 同意你的建议...' },
  { tag: 'markdown', content: '**🤖 最后回复：**\n> 完整最终 Review 修改意见（决策版）\n\n0. 内存膨胀分析\n\n0.1 单个 queue item 真实大小\n\n看 traeScanner 代码...' },
  ...
]
cardReplyFn → 飞书 API

T3: 飞书渲染：
💬 最后提问:
> 推荐路径：内存队列，不上 git_bridge_queue 表
> --- 同意你的建议，不过请你思考下，
> 这个方案是否会引起 Agent 内存占用
> 的大量膨胀上升，这

🤖 最后回复:
> 完整最终 Review 修改意见（决策版）  ← ## 去掉了
>
> 0. 内存膨胀分析                    ← ## 去掉了
>
> 0.1 单个 queue item 真实大小       ← ### 去掉了
>
> 看 traeScanner 代码...             ← 240 字符内可读
```

## 测试计划

### 单元测试（必加）

**新增** `tests/unit/scanner/jsonl-preview-cleanup.test.ts`：
1. 末条 assistant 只 thinking → 跳过，找前一个有 text 的 message
2. 末条 assistant 只 tool_use → 跳过
3. 末条 assistant 是 text + tool_use 中间态 → 跳过，找前一个纯 text
4. markdown 清理：标题符号（`# `、`## `、`### `）被去掉
5. markdown 清理：加粗 `**` 被去掉，文字保留
6. markdown 清理：行内代码 `` `code` `` 的 `` ` `` 被去掉，内容保留
7. markdown 清理：代码块 ` ``` ` 边界被去掉
8. markdown 清理保留：列表 `-`、链接 `[text](url)`、blockquote `>`
9. 截断 240 字符按行边界：在 `\n` 处截断
10. 截断 240 字符无 `\n`：按字符截断追加 `...`
11. 多个 text 块合并：`[text1, text2]` → `"text1\ntext2"`
12. 整个 JSONL 无 final answer → cleanAssistantText 返回 null
13. 截断后内容 < 50% maxLength → 仍按字符截（不强行按行）

**更新** `tests/unit/scanner/jsonl-preview.test.ts`：
- 现有断言基于 80 字符 raw，改为基于 240 字符 cleaned
- 字段名 / 含义注释更新

### 回归测试（必过）

- `tests/unit/feishu/bot-do-switch.test.ts`：overview 卡片断言 last_assistant_preview 字段值（内容变化但字段存在性不变）
- `tests/unit/feishu/bot-do-card-list.test.ts`：list 卡片 last_assistant_preview 60 字符截断逻辑不变（render 端 preview() 仍工作）
- `tests/unit/scanner/jsonl.test.ts`：parseFull 既有测试数据需更新（80→240）
- `tests/integration/feishu-concurrent-commands.test.ts`：场景 A 的「🔴 标记」断言不涉及 preview 内容

### 集成测试（新增）

**`tests/integration/scanner-preview-migration.test.ts`**：
- 构造 v4 registry，last_assistant_preview 是老的 80 字符 raw 数据
- 跑 scanner sync
- 验证所有 entry 的 last_assistant_preview 被更新为 cleaned 240 字符
- 验证 `##` 等 markdown 符号消失

### 手工验证（必跑）

- 在 staging bot 上跑一次 `cc-linker sync --force`
- jq 检查 5-10 个 session 的 last_assistant_preview，确认无 `##` 符号、长度 100-240 字符
- 飞书侧 `/switch <uuid>`，看 overview 卡片渲染效果
- 截图存到 `docs/superpowers/specs/2026-06-05-feishu-overview-after.png`

## 影响范围

- **registry 字段语义微变**：last_assistant_preview 从"80 字符 raw markdown" → "240 字符 cleaned"
- **registry 文件大小**：每条 entry +160B（80→240 字符），342 个 session = +55KB，可忽略
- **render 端零影响**：buildListCard / buildSessionOverviewCard 不动
- **scanner 性能**：倒序遍历 assistant message 提前 break，99% 情况只读 1-2 条
- **CLI list 输出**：list CLI 仍读 `last_message_preview`（不动），不受影响
- **向后兼容**：老 v4 数据兼容（zod schema 不变），sync --force 后升级

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 误删 markdown 内容（如 `` `code` `` 去 `` ` `` 后 code 拼到普通文字里） | 单元测试覆盖；保留 code 文字是关键 |
| 截断位置仍不在行边界（短内容无 `\n`） | 字符截断 + `...` 是 fallback，不强求按行 |
| assistant 末条无 final text（整段 thinking） | cleanAssistantText 返回 null → registry 字段 undefined → overview 卡片跳过该段 |
| 老 v4 数据未 sync --force | release notes 显式说明（"升级后请跑 sync --force"） |
| 字段语义变化让旧代码误解 | render 端直接显示，零修改；只有 scanner 输出格式变化，调用方都是 render 端 |
| scan_cache 失效机制没用到（schema 没升） | 显式文档说明 `sync --force` 步骤；后续如果升 v5 可同时升 schema |
| markdown 清理误伤列表 `-`（如英文 "test-it" 误判） | 只去行首 `#{1,6}` 和 `**`，列表 `-` 在行中位置不匹配，不会被误删 |

## 不做的事（YAGNI）

- 不加「查看完整回复」按钮（用户已选 A 方案）
- 不动 `last_user_preview`（截图里 user prompt 也被截但相对密度低）
- 不动 `last_message_preview`（向后兼容，CLI 还在用）
- 不升 registry schema 版本（字段语义微变不破坏兼容）
- 不实现自动检测老格式 vs 新格式
- 不动 render 端代码（scanner 输出已干净）
- 不实现 thinking → final answer 的特殊高亮（80→240 字符够用）

## 实施计划

### 单 PR 实施

**PR 4：scanner preview 质量优化**

范围（3 个文件改动）：
- `src/scanner/jsonl.ts`：parseTail + parseFull 改造，新增 cleanAssistantText / stripMarkdownNoise / truncateByLine 静态方法
- `src/registry/types.ts`：JSDoc 注释更新（不改 zod）
- `tests/unit/scanner/jsonl-preview-cleanup.test.ts`：新增 13 个用例
- `tests/unit/scanner/jsonl-preview.test.ts`：现有用例适配 240 字符

**风险**：纯数据层 + 单元测试，**不影响飞书侧任何行为**（render 端不动）。
**回滚**：`git revert` + `sync --force` 重新抓 80 字符 raw（老算法）。
**时间估算**：1 天（含代码 + 测试 + 文档更新）。

### 部署步骤

1. **本机验证**：`bun test` 全过 + `bun run typecheck` exit 0
2. **本地真实数据测试**：
   - `cp ~/.cc-linker/registry.json /tmp/bak`
   - `cc-linker sync --force`
   - `jq '.sessions | to_entries | map(select((.value.last_assistant_preview // "") | contains("##"))) | length' ~/.cc-linker/registry.json` → 应该是 0
3. **staging 部署**：`git pull && cc-linker stop && cc-linker sync --force && cc-linker start --daemon`
4. **冒烟测试**（5 分钟）：飞书侧 `/list` 看几张卡片，确认 🤖 标记后内容干净、长度够

### Staging 验证步骤

**必跑**：
1. 部署 PR 4 → 启动 staging bot
2. `cc-linker sync --force` → 跑完后 jq 检查 `last_assistant_preview` 字段无 `##` 符号
3. 飞书侧对几个不同 session 点"切换" → 截图存档
4. 5 场景回归（spec 2026-06-02 §"数据流"）

**冒烟测试**：
- 场景 1：切换到一个长 markdown 回复的 session → 看到清理后的 240 字符
- 场景 2：切换到一个末条只 thinking 的 session → 看到跳到前一个 final answer
- 场景 3：切换到一个末条 text + tool_use 中间态的 session → 同上
- 场景 4：切换到一个完全没 final answer 的 session → 卡片不显示 🤖 最后回复

### 回滚方案

**紧急回滚**：
```bash
git revert <PR-4-merge-commit>
cc-linker stop
git pull
bun run build
cc-linker start --daemon
# 行为：scanner 改回 80 字符 raw，老 entry 保留 240 字符 cleaned（仍可读，只是不如新算法）
# 完全恢复需要：cc-linker sync --force（重新抓 80 字符 raw）
```

## 上线后监控

**新增埋点**（YAGNI：仅 logger.info，暂不上 metrics 模块）：
- `scanner.clean_assistant.hit` (count) — cleanAssistantText 返回非 null 的次数
- `scanner.clean_assistant.skip_thinking` (count) — 跳过 thinking-only message 的次数
- `scanner.clean_assistant.skip_midway` (count) — 跳过中间态的次数
- `scanner.clean_assistant.miss` (count) — 返回 null（无 final answer）的次数
- `scanner.preview.length_distribution` (histogram) — preview 长度分布（80-120 / 120-160 / 160-200 / 200-240）

**告警**：
- `clean_assistant.miss` 比率 > 50%：可能算法过严，调研
- `preview.length_distribution` P50 < 100：可能 user 大量短回复，调研

## 时间估算

| 任务 | 工作量 |
|------|--------|
| 代码实现（jsonl.ts 3 个方法 + 改造 parseTail/parseFull） | 0.5 天 |
| 单元测试（13 个新用例） | 0.5 天 |
| 集成测试 + 现有测试适配 | 0.2 天 |
| 文档更新（CHANGELOG + commit message） | 0.1 天 |
| staging 验证 + 截图 | 0.2 天 |
| **总计** | **1.5 天** |
