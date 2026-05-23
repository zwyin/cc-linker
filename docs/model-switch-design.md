# cc-bridge 飞书端模型切换功能设计方案

> 版本: v1.0
> 日期: 2026-05-23
> 状态: 待评审

---

## 1. 背景与现状分析

### 1.1 本地模型切换现状

用户在本地使用 Claude Code 时，通过以下两种方式切换模型：

**方式一：CC Switch（GUI 工具）**
- CC Switch.app 管理多供应商配置
- 切换时直接覆写 `~/.claude/settings.json`（全局配置）
- 数据库位置：`~/.cc-switch/cc-switch.db`（SQLite）

**方式二：`claude --settings` + Shell 别名**
- 用户手动创建 `~/.claude/providers/<名称>.json`
- 通过 `cc-kimi='claude --settings ~/.claude/providers/kimi-for-coding.json'` 等别名启动
- 实现会话级隔离

### 1.2 cc-bridge 当前行为

```
飞书用户消息 → FeishuBot → ClaudeSessionManager → spawn("claude -p <text> --resume <session>")
```

cc-bridge 在 spawn Claude CLI 时：
- **不传递任何 `--settings` 参数**
- 完全依赖 Claude 的全局配置（即 CC Switch 当前选中的模型）
- 用户无法在飞书端独立选择模型

### 1.3 核心约束

**Claude session 不绑定模型。** Session 文件只保存对话历史，每次 `resume` 时使用的模型由当前的 settings 配置决定。这意味着：

- 同一 session，今天可以用 Kimi，明天可以用 DeepSeek 继续
- 模型选择发生在 **每次 spawn 时**，不是 session 创建时
- 因此「模型」应该是**用户级配置**，不是 session 级绑定

---

## 2. 需求概述

### 2.1 目标

让飞书用户能够方便地选择和管理 AI 模型，体验与本地 `cc-switch` / `cc-kimi` 对齐。

### 2.2 用户故事

| 角色 | 需求 |
|------|------|
| 飞书用户 | 我想查看当前有哪些可用模型，以及当前在用哪个 |
| 飞书用户 | 我想设置一个默认模型，之后所有对话都用它 |
| 飞书用户 | 我想创建新会话时顺便切换到某个模型（一步完成） |
| 飞书用户 | 我想知道每个会话之前是用什么模型聊的 |
| 已有 cc-switch 用户 | 我不想重复配置，飞书端应该自动识别我的模型 |

### 2.3 非目标

- 不支持 session 级别的强制模型绑定（与 Claude 设计冲突）
- 不支持单次消息的临时模型切换（过于复杂，后续可考虑）
- 不替代 CC Switch 的本地功能，而是与其互补

---

## 3. 核心设计原则

| 原则 | 说明 |
|------|------|
| **用户级模型配置** | 模型选择绑定到用户，不绑定到 session。用户改一次，所有会话（新旧）下次恢复时自动生效 |
| **复用本地配置** | 优先复用用户已有的 CC Switch 配置或 providers 配置，零额外配置成本 |
| **向后兼容** | 未设置模型的用户，行为与现在完全一致（跟随 Claude 全局配置） |
| **配置隔离** | 从 CC Switch 自动生成的临时配置必须净化（只保留 env+model），避免覆盖用户全局 hooks/plugins |
| **正交设计** | 模型切换和会话切换是两个独立操作，不互相耦合 |

---

## 4. 术语表

| 术语 | 定义 |
|------|------|
| Provider | 一个模型供应商配置，包含 env 变量和 model 别名 |
| Provider Alias | 供应商短标识，如 `kimi-for-coding`、`deepseek-v4` |
| Default Provider | 用户在飞书端设置的默认模型，保存在 user mapping 中 |
| Auto-providers | 从 CC Switch 数据库自动生成的临时 provider 配置文件 |
| Manual providers | 用户手动创建的 `~/.claude/providers/*.json` |

---

## 5. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       FeishuBot                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ /bridge     │  │ /bridge     │  │ /bridge new         │  │
│  │ model       │  │ model <alias│  │ [--model <alias>]   │  │
│  │ (查看)      │  │ (设置)      │  │                     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │             │
│         └────────────────┴────────────────────┘             │
│                          │                                  │
│                   ProviderManager                           │
│                          │                                  │
│         ┌────────────────┼────────────────┐                │
│         ▼                ▼                ▼                │
│   ┌──────────┐    ┌──────────┐    ┌──────────────┐        │
│   │ ~/.claude│    │ ~/.cc-   │    │ 仅全局配置   │        │
│   │/providers│    │switch/db │    │ (降级)       │        │
│   │(手动优先)│    │(自动生成)│    │              │        │
│   └──────────┘    └──────────┘    └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  ClaudeSessionManager                       │
│                                                             │
│   spawn args: ["claude", "--settings", <path>, ...]         │
│              OR ["claude", ...]  (无 --settings)            │
│                                                             │
│   规则: 用户设置了 defaultProvider → 加 --settings          │
│         未设置 → 不加 --settings (跟随全局)                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 详细设计

### 6.1 配置发现机制（三层 Fallback）

```typescript
// src/utils/providers.ts

export type ProviderSource = 'manual' | 'cc-switch' | 'none';

export interface ProviderConfig {
  alias: string;         // 短标识，如 "kimi-for-coding"
  name: string;          // 显示名称，如 "Kimi For Coding"
  path: string;          // settings 文件绝对路径
  isTemp: boolean;       // 是否自动生成的临时文件
}

export class ProviderManager {
  private providers = new Map<string, ProviderConfig>();
  private source: ProviderSource = 'none';
  private autoProviderDir = join(CC_BRIDGE_DIR, 'auto-providers');

  async scan(): Promise<void> {
    this.providers.clear();

    // Layer 1: 用户手动配置的 providers（最高优先级）
    const manualDir = expandPath('~/.claude/providers');
    if (await dirExists(manualDir)) {
      await this.scanDirectory(manualDir, false);
      this.source = 'manual';
      return;
    }

    // Layer 2: 从 CC Switch 数据库自动生成
    const ccSwitchDb = expandPath('~/.cc-switch/cc-switch.db');
    if (await fileExists(ccSwitchDb)) {
      await this.generateFromCcSwitch(ccSwitchDb);
      await this.scanDirectory(this.autoProviderDir, true);
      this.source = 'cc-switch';
      return;
    }

    // Layer 3: 无可切换模型
    this.source = 'none';
  }
}
```

**发现优先级理由：**

- 手动 providers 优先：用户手动配置了 providers，说明用户有意使用 `claude --settings` 方案，应尊重其配置
- CC Switch 次之：用户没手动配 providers，但有 CC Switch，自动提取其配置
- 降级处理：两者都没有，则不支持切换，跟随 Claude 全局配置

### 6.2 从 CC Switch 自动生成 Providers

**数据来源：** `~/.cc-switch/cc-switch.db` → `providers` 表

**SQL 查询：**

```sql
SELECT id, name, settings_config, is_current
FROM providers
WHERE app_type = 'claude'
ORDER BY sort_index ASC
```

**配置净化：**

CC Switch 的 `settings_config` 包含完整配置（hooks、permissions、plugins 等），如果直接作为 `--settings` 文件，会**完全覆盖**用户全局 `~/.claude/settings.json` 中的对应字段。

这会导致严重问题：例如用户全局配置了 cc-bridge 的 `SessionStart` hook，如果 provider 文件里没有这个 hook，`--settings` 会将其覆盖为空，导致 hook 不执行。

**净化规则：** 只保留 `model` 和 `env` 字段

```typescript
private sanitizeSettingsConfig(raw: string): object {
  const parsed = JSON.parse(raw);
  const env = parsed.env ?? {};

  // 只保留与模型调用相关的 env 变量
  const allowedEnvKeys = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_REASONING_MODEL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'API_TIMEOUT_MS',
  ];

  const filteredEnv: Record<string, string> = {};
  for (const key of allowedEnvKeys) {
    if (env[key] !== undefined) {
      filteredEnv[key] = String(env[key]);
    }
  }

  return {
    model: parsed.model ?? 'opus',
    env: filteredEnv,
  };
}
```

**Alias 生成规则：**

```typescript
private sanitizeName(name: string): string {
  // "Kimi For Coding" → "kimi-for-coding"
  // "Bailian-qwen3.6" → "bailian-qwen3.6"
  // "ByteDance-kimi-k2.6" → "bytedance-kimi-k2-6"
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

**临时文件管理：**

```typescript
private async generateFromCcSwitch(dbPath: string): Promise<void> {
  // 清理旧临时文件
  await rm(this.autoProviderDir, { recursive: true, force: true });
  await mkdir(this.autoProviderDir, { recursive: true, mode: 0o700 });

  // 读取数据库
  const rows = await queryCcSwitchDb(dbPath);

  for (const row of rows) {
    const cleanConfig = this.sanitizeSettingsConfig(row.settings_config);
    const alias = this.sanitizeName(row.name);
    const filePath = join(this.autoProviderDir, `${alias}.json`);
    await writeFile(filePath, JSON.stringify(cleanConfig, null, 2), { mode: 0o600 });
  }
}
```

### 6.3 数据模型变更

#### 6.3.1 User Mapping（`src/feishu/mapping.ts`）

新增 `defaultProvider` 字段，保存用户的默认模型别名。

```typescript
// BEFORE
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string;
  cwd?: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
}

// AFTER
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string;
  cwd?: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string;   // NEW: 用户默认模型别名
}
```

**CAS 比较兼容：** `entriesMatch()` 函数**不比较** `defaultProvider`。

理由：`defaultProvider` 是用户偏好设置，不应该影响 CAS 的会话状态比较。如果两个 entry 除了 `defaultProvider` 外完全相同，应视为匹配。

```typescript
function entriesMatch(a: MappingEntry | null, b: MappingEntry | null): boolean {
  // ... existing checks ...
  // Note: defaultProvider is intentionally NOT compared here
  return true;
}
```

#### 6.3.2 Session Registry（`src/registry/types.ts`）

新增 `lastKnownProvider` 字段，仅用于展示，不影响 spawn 逻辑。

```typescript
// BEFORE
export const SessionEntrySchema = z.object({
  origin: OriginSchema,
  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string().nullable(),
  project_dir: z.string().nullable(),
  pending_jsonl_resolve: z.boolean().optional(),
  last_error: z.string().nullable().optional(),
  feishu_session_id: z.string().nullable().optional(),
  feishu_user_id: z.string().nullable().optional(),
  created_at: z.string(),
  last_active: z.string(),
  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),
  status: StatusSchema.optional(),
});

// AFTER
export const SessionEntrySchema = z.object({
  origin: OriginSchema,
  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string().nullable(),
  project_dir: z.string().nullable(),
  pending_jsonl_resolve: z.boolean().optional(),
  last_error: z.string().nullable().optional(),
  feishu_session_id: z.string().nullable().optional(),
  feishu_user_id: z.string().nullable().optional(),
  created_at: z.string(),
  last_active: z.string(),
  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),
  status: StatusSchema.optional(),
  lastKnownProvider: z.string().nullable().optional(),   // NEW
});
```

**Registry 版本升级：**

```typescript
// Registry version: 2 → 3
export const RegistrySchema = z.object({
  version: z.literal(3),          // CHANGED
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
```

> 注：由于 `lastKnownProvider` 为 `optional().nullable()`，旧数据无需显式迁移即可兼容 parse。`emptyRegistry()` 同步返回 `version: 3`。

### 6.4 命令层设计（飞书 Bot）

#### 6.4.1 新增 `/bridge model` 命令

```typescript
// src/feishu/bot.ts

private async handleCommand(msg: SpoolMessage): Promise<void> {
  const parts = msg.text.split(/\s+/);
  const cmd = parts[1]?.toLowerCase();

  switch (cmd) {
    case 'help':     await this.replyAndFinalize(msg, this.helpText()); return;
    case 'list':     await this.handleList(msg); return;
    case 'new':      await this.handleNew(msg, msg.text.replace(/^\/bridge\s+new\s*/i, '')); return;
    case 'switch':   await this.handleSwitch(msg, parts.slice(2).join(' ')); return;
    case 'model':    await this.handleModel(msg, parts.slice(2).join(' ')); return;  // NEW
    case 'resume':   await this.handleResume(msg, parts.slice(2).join(' ')); return;
    case 'status':   await this.handleStatus(msg); return;
    case 'whoami':   await this.replyAndFinalize(msg, `你的 open_id: ${msg.openId}`); return;
    default:         await this.replyAndFinalize(msg, `未知命令: /bridge ${cmd}\n\n${this.helpText()}`);
  }
}
```

#### 6.4.2 `handleModel` 实现

```typescript
private async handleModel(msg: SpoolMessage, target: string): Promise<void> {
  // 无参数：显示当前默认模型和可用列表
  if (!target) {
    const entry = this.userManager.getEntry(msg.openId);
    const currentAlias = entry?.defaultProvider ?? null;
    const lines: string[] = [];

    if (currentAlias) {
      const provider = this.providerManager.resolve(currentAlias);
      lines.push(`当前默认模型: ${provider?.name ?? currentAlias}`);
    } else {
      lines.push('当前默认模型: 未设置（跟随 Claude 全局配置）');
    }

    const providers = this.providerManager.list();
    if (providers.length > 0) {
      lines.push('');
      lines.push('可用模型:');
      providers.forEach((p, i) => {
        const marker = p.alias === currentAlias ? '●' : ' ';
        lines.push(`  ${marker} ${i + 1}. ${p.name}  (${p.alias})`);
      });
    } else {
      lines.push('');
      lines.push('未检测到可切换模型。');
      lines.push('请安装 CC Switch 或手动创建 ~/.claude/providers/*.json');
    }

    lines.push('');
    lines.push('用法:');
    lines.push('  /bridge model <序号|别名>        设置默认模型');
    lines.push('  /bridge model --clear            清除默认设置');
    lines.push('  /bridge new /path --model <别名> 创建会话时指定模型');

    await this.replyAndFinalize(msg, lines.join('\n'));
    return;
  }

  // --clear: 清除默认设置
  if (target === '--clear') {
    const entry = this.userManager.getEntry(msg.openId);
    if (!entry) {
      await this.replyAndFinalize(msg, '⚠️ 无当前会话状态，无需清除');
      return;
    }

    const swapped = await this.userManager.compareAndSwap(
      msg.openId,
      entry,
      { ...entry, defaultProvider: undefined }
    );

    const reply = swapped
      ? '✅ 已清除默认模型设置，后续将跟随 Claude 全局配置'
      : '⚠️ 清除失败，请重试';
    await this.replyAndFinalize(msg, reply);
    return;
  }

  // 设置默认模型
  const provider = this.providerManager.resolve(target);
  // resolve() 已内建支持序号解析（1-based），无需单独调用 resolveByIndex

  if (!provider) {
    await this.replyAndFinalize(msg, `未知模型: "${target}"\n请使用 /bridge model 查看可用列表`);
    return;
  }

  const entry = this.userManager.getEntry(msg.openId);
  const newEntry: MappingEntry = entry
    ? { ...entry, defaultProvider: provider.alias }
    : {
        type: 'pending_new_session',   // 无活跃会话时不应创建 session type
        sessionUuid: null,
        createdAt: new Date().toISOString(),
        defaultProvider: provider.alias,
      };

  const swapped = await this.userManager.compareAndSwap(
    msg.openId,
    entry ?? null,
    newEntry
  );

  const reply = swapped
    ? `✅ 默认模型已设置为 ${provider.name} (${provider.alias})\n后续所有会话恢复将使用此模型。`
    : '⚠️ 设置失败，请重试';
  await this.replyAndFinalize(msg, reply);
}
```

#### 6.4.3 Help 文本更新

```typescript
private helpText(): string {
  return [
    '可用命令:',
    '  /bridge help                              - 显示此帮助',
    '  /bridge list                              - 列出会话',
    '  /bridge new [路径] [-- prompt]            - 创建新会话',
    '  /bridge new [路径] --model <别名> [-- p]  - 指定模型创建会话',
    '  /bridge switch <序号|UUID>                - 切换会话',
    '  /bridge model                             - 查看可用模型和默认设置',
    '  /bridge model <序号|别名>                 - 设置默认模型',
    '  /bridge model --clear                     - 清除默认设置',
    '  /bridge resume <序号|UUID>                - 获取安全恢复建议',
    '  /bridge status                            - 查看状态',
    '  /bridge whoami                            - 获取你的 open_id',
  ].join('\n');
}
```

#### 6.4.4 `/bridge new --model` 参数解析

```typescript
interface NewCommandResult {
  cwd: string;
  prompt: string;
  providerAlias?: string;
}

private parseNewCommand(rawArgs: string): NewCommandResult {
  // 支持格式:
  // /bridge new /path
  // /bridge new /path -- hello world
  // /bridge new /path --model kimi
  // /bridge new /path --model kimi -- hello world
  // /bridge new --model kimi /path -- hello world

  const result: NewCommandResult = { cwd: '', prompt: '' };

  // 先提取 --model 参数（可以在任意位置）
  const modelMatch = rawArgs.match(/--model\s+(\S+)/);
  if (modelMatch) {
    result.providerAlias = modelMatch[1];
    rawArgs = rawArgs.replace(/--model\s+\S+/, '').trim();
  }

  // 剩余部分按 -- 分割为 cwd 和 prompt
  const doubleDashIndex = rawArgs.indexOf(' -- ');
  if (doubleDashIndex >= 0) {
    result.cwd = rawArgs.slice(0, doubleDashIndex).trim();
    result.prompt = rawArgs.slice(doubleDashIndex + 4).trim();
  } else {
    result.cwd = rawArgs.trim();
  }

  return result;
}
```

#### 6.4.5 `handleNew` 中设置 provider

```typescript
private async handleNew(msg: SpoolMessage, rawArgs: string): Promise<void> {
  const { cwd, prompt, providerAlias } = this.parseNewCommand(rawArgs);

  // 如果指定了 --model，先设置用户的 defaultProvider
  if (providerAlias) {
    const provider = this.providerManager.resolve(providerAlias);
    if (!provider) {
      await this.replyAndFinalize(msg, `未知模型: "${providerAlias}"\n请使用 /bridge model 查看可用列表`);
      return;
    }

    const entry = this.userManager.getEntry(msg.openId);
    const newEntry: MappingEntry = entry
      ? { ...entry, defaultProvider: provider.alias }
      : {
          type: 'pending_new_session',
          sessionUuid: null,
          createdAt: new Date().toISOString(),
          defaultProvider: provider.alias,
        };

    await this.userManager.compareAndSwap(msg.openId, entry ?? null, newEntry);
  }

  // ... 后续逻辑不变（创建会话或设置 pending）
}
```

#### 6.4.6 `handleNew` 创建会话时记录 lastKnownProvider

在 session 创建成功后的 bind 阶段：

```typescript
// 在 bindSessionToClaim 成功后的回调中
await this.registry.update(sessionUuid, {
  lastKnownProvider: providerAlias ?? entry?.defaultProvider ?? null,
});
```

### 6.5 Session Spawn 逻辑修改

#### 6.5.1 核心修改：`src/proxy/session.ts`

```typescript
// BEFORE (line 169)
const args: string[] = [claudeBin, '-p', text, '--output-format', 'json'];

// AFTER
const args: string[] = [claudeBin];

// 根据传入的 settingsPath 决定是否加 --settings（由调用方解析用户配置）
if (settingsPath && existsSync(settingsPath)) {
  args.push('--settings', settingsPath);
} else if (settingsPath) {
  logger.warn(`Provider settings file not found: ${settingsPath}, using global config`);
}

args.push('-p', text, '--output-format', 'json');
```

**注意：** `sendMessage()` 和 `sendStreamingMessage()` 通过新增的 `settingsPath` 参数注入 `--settings`，保持与 feishu 层解耦。调用方（`bot.ts`）通过 `getSettingsPathForUser(openId)` 查询后传入。

#### 6.5.2 方法签名变更

```typescript
// BEFORE
async sendMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  isNew?: boolean,
  lockKey?: string,
): Promise<SendMessageResult>

// AFTER
async sendMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  isNew?: boolean,
  lockKey?: string,
  settingsPath?: string,    // NEW: provider settings 文件路径
): Promise<SendMessageResult>
```

调用方（`src/feishu/bot.ts` 中的 `handleChat`）在调用前通过 `getSettingsPathForUser(msg.openId)` 解析路径后传入。

### 6.6 `/bridge list` 显示模型信息

```typescript
// 在生成 list 回复时，为每个 session 附加 lastKnownProvider
private async handleList(msg: SpoolMessage): Promise<void> {
  // ... 现有逻辑 ...

  const entries = recentSessions.map((s, i) => {
    const providerTag = s.lastKnownProvider
      ? ` [${s.lastKnownProvider}]`
      : '';
    return `${i + 1}. ${s.uuid.slice(0, 8)}  ${s.cwd}${providerTag}  ${timeAgo(s.last_active)}`;
  });

  // ...
}
```

### 6.7 `/bridge status` 显示当前模型

```typescript
private async doStatus(openId: string, messageId?: string): Promise<string> {
  const entry = this.userManager.getEntry(openId);
  const currentSession = entry?.sessionUuid
    ? this.registry.get(entry.sessionUuid)
    : null;

  const provider = entry?.defaultProvider
    ? this.providerManager.resolve(entry.defaultProvider)
    : null;

  const lines: string[] = [];

  if (currentSession) {
    lines.push(`当前会话: ${currentSession.uuid.slice(0, 8)}`);
    lines.push(`工作目录: ${currentSession.cwd}`);
  } else {
    lines.push('当前无活跃会话');
  }

  if (provider) {
    lines.push(`默认模型: ${provider.name} (${provider.alias})`);
  } else {
    lines.push('默认模型: 未设置（跟随 Claude 全局配置）');
  }

  // ... 其余信息（队列大小、总会话数等）不变
}
```

---

## 7. 用户交互流程

### 7.1 场景一：查看可用模型

```
用户: /bridge model

Bot:
当前默认模型: 未设置（跟随 Claude 全局配置）

可用模型:
  1. Kimi For Coding  (kimi-for-coding)
  2. DeepSeek  (deepseek-v4)
  3. Bailian-qwen3.6  (bailian-qwen3-6)
  4. Xiaomi MiMo  (xiaomi-mimo)

用法:
  /bridge model <序号|别名>        设置默认模型
  /bridge model --clear            清除默认设置
  /bridge new /path --model <别名> 创建会话时指定模型
```

### 7.2 场景二：设置默认模型

```
用户: /bridge model kimi

Bot: ✅ 默认模型已设置为 Kimi For Coding (kimi-for-coding)
     后续所有会话恢复将使用此模型。
```

### 7.3 场景三：创建会话并设置模型

```
用户: /bridge new ~/project --model deepseek

Bot: ✅ 已创建会话 (deepseek-v4)
     目录: ~/project
     默认模型已设置为 DeepSeek (deepseek-v4)
     请发送第一条消息开始对话。
```

### 7.4 场景四：切换会话（模型自动生效）

```
用户: /bridge switch 1

Bot: ✅ 已切换到会话 a3f7b2d1

用户: [发送消息]

Bot: [使用用户当前设置的默认模型回复]
```

### 7.5 场景五：清除默认设置

```
用户: /bridge model --clear

Bot: ✅ 已清除默认模型设置，后续将跟随 Claude 全局配置
```

---

## 8. 边界情况与异常处理

### 8.1 Provider 配置不可用

| 场景 | 处理 |
|------|------|
| `~/.claude/providers/` 存在但为空目录 | 视为 Layer 1 存在但无 provider，回退到 Layer 2 |
| `~/.cc-switch/cc-switch.db` 存在但无法读取 | 记录 warn 日志，回退到 Layer 3 |
| CC Switch db 中 `settings_config` 格式异常 | 跳过该条记录，继续处理其他 |
| 用户设置的 `defaultProvider` 已不存在（provider 被删除） | spawn 时检测到不存在，fallback 到不加 `--settings`，记录 warn |

### 8.2 Alias 冲突

| 场景 | 处理 |
|------|------|
| 两个 provider 净化后 alias 相同 | 后覆盖先，记录 warn。建议用户手动配置 providers 避免冲突 |
| 用户输入的 alias 匹配多个 provider | 取第一个匹配（sort_index 排序后的第一个） |
| 用户输入的序号越界 | 提示"无效序号"，列出可用范围 |

### 8.3 并发安全

| 场景 | 处理 |
|------|------|
| 用户快速连续发送 `/bridge model A` 和 `/bridge model B` | 通过 CAS 保证最终一致性，后一个可能失败（expected 不匹配），提示重试 |
| ProviderManager.scan() 和 spawn 并发 | ProviderManager 在 FeishuBot 初始化时 scan 一次，后续只读。临时文件生成是原子操作（先写 tmp 再 rename） |

### 8.4 向后兼容

| 场景 | 处理 |
|------|------|
| 旧版本 user-mapping.json 没有 `defaultProvider` | `getEntry()` 返回 `undefined`，视为未设置 |
| 旧版本 registry.json（version 2）没有 `lastKnownProvider` | migrateV2toV3 自动补 `null` |
| 用户降级 cc-bridge（新版本→旧版本） | 旧版本忽略 `defaultProvider` 和 `lastKnownProvider`，行为退化到当前状态，数据不丢失 |

---

## 9. 兼容性分析

### 9.1 用户环境覆盖

| 用户环境 | Provider 来源 | 是否需要用户额外配置 | 模型切换能力 |
|----------|--------------|-------------------|------------|
| 手动配置了 `~/.claude/providers/` | 手动目录 | 否 | 完全支持 |
| 安装了 CC Switch（无手动 providers） | CC Switch db 自动生成 | 否 | 完全支持 |
| 两者都有 | 手动目录（优先） | 否 | 完全支持 |
| 都没有 | 无 | 是（需安装 CC Switch 或手动创建 providers） | 仅显示当前模型，不可切换 |
| 后续手动创建 providers | 自动切换到手动目录 | 否 | 完全支持 |

### 9.2 与本地工具的对齐

| 本地操作 | 飞书等效操作 | 行为一致性 |
|----------|-------------|----------|
| `cc-switch` 切换全局模型 | `/bridge model <alias>` | 一致：都设置默认模型 |
| `cc-kimi`（启动+切模型） | `/bridge new /path --model kimi` | 一致：创建+设置模型 |
| `claude --resume`（用当前全局模型） | 不发 `/bridge model`，直接对话 | 一致：都跟随全局配置 |

### 9.3 配置隔离保证

- 自动生成的 provider 配置**只包含** `model` 和 `env`，不会覆盖用户全局的：
  - `hooks`（如 cc-bridge 的 SessionStart hook）
  - `permissions`
  - `enabledPlugins`
  - `theme`
  - 其他自定义配置

- 手动 providers 目录中的文件**原样使用**，用户需自行确保不包含会导致问题的字段

---

## 10. 安全考量

### 10.1 敏感信息处理

- CC Switch db 中的 `ANTHROPIC_AUTH_TOKEN` 在自动生成的临时文件中**原样保留**
- 临时文件权限设置为 `0o600`（仅所有者可读写）
- 临时文件目录 `~/.cc-bridge/auto-providers/` 权限 `0o700`
- 不将 token 打印到日志或回复消息中

### 10.2 文件操作安全

- 自动生成时先写 `.tmp` 文件，再 `rename`，避免半写文件被读取
- 清理旧临时文件使用 `rm -rf` 前先验证路径在 `CC_BRIDGE_DIR` 下
- 读取 `~/.cc-switch/cc-switch.db` 时只读打开，不修改源数据库

---

## 11. 实现计划

### Phase 1：核心功能（最小可用）

**目标：** 实现模型查看、设置、spawn 时生效

**任务清单：**

1. [ ] 新增 `src/utils/providers.ts`：ProviderManager 类
   - `scan()` 三层 fallback 逻辑
   - `generateFromCcSwitch()` 数据库读取和配置净化
   - `resolve()` / `resolveByIndex()` / `list()` 查询方法
   - `sanitizeName()` alias 生成

2. [ ] 数据模型变更
   - `MappingEntry` 新增 `defaultProvider?: string`
   - `SessionEntrySchema` 新增 `lastKnownProvider`
   - `RegistrySchema` version 2 → 3
   - `migrateV2toV3()` 迁移函数
   - `entriesMatch()` 不比较 `defaultProvider`

3. [ ] `src/feishu/bot.ts` 命令层
   - 新增 `handleModel()` 方法
   - 更新 `helpText()`
   - 更新 `parseNewCommand()` 支持 `--model`
   - 更新 `handleNew()` 处理 `--model`
   - 更新 `handleList()` 显示 `lastKnownProvider`
   - 更新 `doStatus()` 显示当前模型

4. [ ] `src/proxy/session.ts` spawn 逻辑
   - `sendMessage()` / `sendStreamingMessage()` 新增 `openId` 参数
   - `_doSendMessage()` 根据 `defaultProvider` 添加 `--settings`
   - 调用方（`handleChat`）传入 `msg.openId`

5. [ ] FeishuBot 初始化时调用 `providerManager.scan()`

### Phase 2：体验优化

1. [ ] Alias 前缀匹配：输入 `/bridge model kimi` 时，如果有多个 `kimi-*`，提示用户补全
2. [ ] 检测到 CC Switch db 变更时自动重新 scan（文件 mtime 对比）
3. [ ] `/bridge model` 显示 CC Switch 当前激活的模型（读取 `is_current`）
4. [ ] 交互式卡片中显示模型标签

### Phase 3：进阶功能（可选）

1. [ ] `config.toml` 新增 `[providers]` 配置段，支持自定义 providers 目录路径
2. [ ] 支持 `/bridge model <provider>` 时自动检测 provider 健康状态（调用 Claude 的 stream check）
3. [ ] 支持从环境变量 `CC_BRIDGE_PROVIDERS_DIR` 读取自定义目录

---

## 12. 附录

### 12.1 CC Switch 数据库 Schema 参考

```sql
CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,          -- 'claude' | 'codex' | 'gemini'
    name TEXT NOT NULL,              -- 显示名称，如 "Kimi For Coding"
    settings_config TEXT NOT NULL,   -- JSON 字符串，完整配置
    is_current BOOLEAN DEFAULT 0,    -- 是否当前激活
    sort_index INTEGER,              -- 排序索引
    ...
    PRIMARY KEY (id, app_type)
);
```

### 12.2 Provider 配置净化前后对比

**净化前（来自 CC Switch db）：**
```json
{
  "codemossProviderId": "d41f8333-...",
  "enabledPlugins": { "superpowers-...": true },
  "env": { "ANTHROPIC_AUTH_TOKEN": "sk-...", ... },
  "extraKnownMarketplaces": { ... },
  "hooks": { "SessionStart": [ ... ] },
  "model": "opus[1m]",
  "permissions": { "defaultMode": "acceptEdits" },
  "theme": "light"
}
```

**净化后（写入临时文件）：**
```json
{
  "model": "opus[1m]",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_BASE_URL": "https://...",
    "ANTHROPIC_MODEL": "qwen3.6-plus[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3.6-plus[1m]",
    ...
  }
}
```

### 12.3 手动 Provider 配置格式

```json
{
  "model": "opus",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding/",
    "ANTHROPIC_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-for-coding",
    "ANTHROPIC_REASONING_MODEL": "kimi-for-coding"
  }
}
```

---

## 13. 评审 Checklist

- [ ] 设计方案是否满足所有用户故事？
- [ ] 三层 fallback 逻辑是否覆盖所有用户环境？
- [ ] 配置净化规则是否完整？是否有遗漏的敏感字段？
- [ ] CAS 比较忽略 `defaultProvider` 是否正确？
- [ ] Registry 版本升级和迁移函数是否正确？
- [ ] 向后兼容性是否充分（旧数据、降级场景）？
- [ ] 安全方面：临时文件权限、token 不泄露
- [ ] 实现计划是否合理？Phase 1 是否足够 MVP？
