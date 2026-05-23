# cc-linker 飞书端模型切换功能设计规格

> 版本: v1.0
> 日期: 2026-05-23
> 状态: 已评审，待实现

---

## 1. 背景

cc-linker 当前 spawn Claude CLI 时不传递 `--settings` 参数，完全依赖 Claude 全局配置。用户无法在飞书端独立选择模型。

本地用户通过两种方式切换模型：
- **CC Switch** (GUI App): 修改 `~/.claude/settings.json`，数据库在 `~/.cc-switch/cc-switch.db`
- **`claude --settings`**: 手动创建 `~/.claude/providers/*.json`，通过 shell 别名调用

## 2. 目标

让飞书用户能够查看、设置和切换 AI 模型，体验与本地 `cc-switch` / `cc-kimi` 对齐。

## 3. 核心约束

**Claude session 不绑定模型。** Session 文件只保存对话历史，每次 `resume` 时使用的模型由 spawn 时的 settings 配置决定。因此：

- 模型选择发生在 **每次 spawn 时**
- 「模型」是 **用户级配置**，不是 session 级绑定
- 同一 session 可以用不同模型继续

## 4. 架构

```
┌─────────────────────────────────────────────────────────────┐
│                       FeishuBot                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ /bridge     │  │ /bridge     │  │ /bridge new         │  │
│  │ model       │  │ model <alias│  │ [--model <alias>]   │  │
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
│   用户设置了 defaultProvider?                                │
│     → spawn("claude", "--settings", path, "-p", text, ...) │
│   未设置?                                                    │
│     → spawn("claude", "-p", text, ...) (跟随全局配置)        │
└─────────────────────────────────────────────────────────────┘
```

## 5. ProviderManager 模块

### 5.1 三层 Fallback 配置发现

```typescript
// src/utils/providers.ts

export interface ProviderConfig {
  alias: string;      // 短标识，如 "kimi-for-coding"
  name: string;       // 显示名称
  path: string;       // settings 文件绝对路径
  isTemp: boolean;    // 是否自动生成的临时文件
}

export class ProviderManager {
  async scan(): Promise<void> {
    // Layer 1: 用户手动配置
    const manualDir = expandPath('~/.claude/providers');
    if (await dirExists(manualDir)) {
      await this.scanDirectory(manualDir, false);
      this.source = 'manual';
      return;
    }

    // Layer 2: 从 CC Switch 数据库自动生成
    const ccSwitchDb = expandPath('~/.cc-switch/cc-switch.db');
    if (await fileExists(ccSwitchDb)) {
      const autoDir = expandPath('~/.cc-linker/auto-providers');
      await this.generateFromCcSwitch(ccSwitchDb, autoDir);
      await this.scanDirectory(autoDir, true);
      this.source = 'cc-switch';
      return;
    }

    // Layer 3: 无可切换模型
    this.source = 'none';
  }
}
```

### 5.2 配置净化

从 CC Switch 读取的 `settings_config` 包含 hooks、permissions、plugins 等字段。必须**过滤为只保留 `model` 和 `env`**，避免 `--settings` 覆盖用户全局 `~/.claude/settings.json` 中的配置（如 cc-linker 的 SessionStart hook）。

```typescript
private sanitizeSettingsConfig(raw: string): object {
  const parsed = JSON.parse(raw);
  const env = parsed.env ?? {};

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

### 5.3 Alias 生成

从 CC Switch 的 `name` 字段生成 alias：

```typescript
private sanitizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

示例：
- "Kimi For Coding" → `kimi-for-coding`
- "Bailian-qwen3.6" → `bailian-qwen3-6`
- "DeepSeek" → `deepseek`

### 5.4 临时文件管理

- 目录：`~/.cc-linker/auto-providers/`
- 权限：`0o700`
- 每次 `scan()` 时重新生成（清理旧文件 → 写入新文件）
- 写文件时先写 `.tmp` 再 `renameSync`，保证原子性

## 6. 数据模型变更

### 6.1 User Mapping (`src/feishu/mapping.ts`)

```typescript
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string;
  cwd?: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string;   // NEW
}
```

**CAS 兼容：** `entriesMatch()` **不比较** `defaultProvider`。理由：它是用户偏好设置，不应影响会话状态的一致性检查。

### 6.2 Session Registry (`src/registry/types.ts`)

```typescript
export const SessionEntrySchema = z.object({
  // ... existing fields ...
  lastKnownProvider: z.string().nullable().optional(),   // NEW
});
```

## 7. 命令层设计

### 7.1 新增 `/bridge model` 命令

| 命令 | 行为 |
|------|------|
| `/bridge model` | 显示当前默认模型 + 可用 providers 列表 + 用法提示 |
| `/bridge model <序号\|别名>` | 设置 `defaultProvider`，通过 CAS 保存到 user-mapping.json |
| `/bridge model --clear` | 清除 `defaultProvider`，恢复"跟随 Claude 全局配置" |

### 7.2 `/bridge new --model <alias>`

```typescript
interface NewCommandResult {
  cwd: string;
  prompt: string;
  providerAlias?: string;
}
```

`--model` 参数可以在任意位置：
- `/bridge new /path --model kimi`
- `/bridge new /path --model kimi -- hello world`

如果指定了 `--model`：
1. 验证 provider 存在
2. 通过 CAS 设置用户的 `defaultProvider`
3. 继续原有的 new 会话逻辑

### 7.3 Help 文本

```
/bridge help                              - 显示此帮助
/bridge list                              - 列出会话
/bridge new [路径] [-- prompt]            - 创建新会话
/bridge new [路径] --model <别名> [-- p]  - 指定模型创建会话
/bridge switch <序号|UUID>                - 切换会话
/bridge model                             - 查看可用模型和默认设置
/bridge model <序号|别名>                  - 设置默认模型
/bridge model --clear                     - 清除默认设置
/bridge resume <序号|UUID>                - 获取安全恢复建议
/bridge status                            - 查看状态
/bridge whoami                            - 获取你的 open_id
```

### 7.4 模型信息展示

- **`/bridge list`**: 每个 session 旁显示 `[kimi-for-coding]`（来自 `lastKnownProvider`）
- **`/bridge status`**: 显示当前 `defaultProvider`

## 8. Session Spawn 逻辑

### 8.1 `src/proxy/session.ts` 修改

```typescript
private async _doSendMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  openId: string,        // NEW parameter
  isNew: boolean
): Promise<SendMessageResult> {
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  const args: string[] = [claudeBin];

  // 根据用户当前的 defaultProvider 决定是否加 --settings
  const userEntry = await this.userManager.getEntry(openId);
  if (userEntry?.defaultProvider) {
    const provider = this.providerManager.resolve(userEntry.defaultProvider);
    if (provider) {
      args.push('--settings', provider.path);
    }
  }

  args.push('-p', text, '--output-format', 'json');

  if (sessionId && !isNew) {
    args.push('--resume', sessionId);
  }

  // ... rest of spawn logic unchanged
}
```

### 8.2 方法签名变更

`sendMessage()` 和 `sendStreamingMessage()` 新增 `openId` 参数。

调用方（`bot.ts` 中的 `handleChat`/`handleChatStreaming`）传入 `msg.openId`。

### 8.3 实际效果

| 用户状态 | 未设置 defaultProvider | 设置了 kimi |
|----------|----------------------|------------|
| 新 session | 使用 Claude 全局配置 | 使用 kimi |
| 恢复旧 session | 使用 Claude 全局配置 | 使用 kimi |
| 效果 | 和本地 `cc-switch` 同步 | 飞书端独立配置 |

## 9. 边界情况

### 9.1 Provider 不可用 Fallback

| 场景 | 行为 |
|------|------|
| `defaultProvider` 指向的 provider 文件已被删除 | spawn 时检测到不存在，fallback 到不加 `--settings`（跟随全局），记录 warn |
| CC Switch db 存在但读取失败 | 记录 warn，source = 'none' |
| `settings_config` 解析异常 | 跳过该条，继续处理其他 provider |
| alias 冲突（两个 provider 同名） | 后覆盖先，记录 warn |

### 9.2 降级场景

| 用户环境 | `/bridge model` 显示 |
|----------|---------------------|
| 有手动 providers 或 CC Switch | 可用模型列表 |
| 都没有 | "未检测到可切换模型。请安装 CC Switch 或手动创建 ~/.claude/providers/*.json" |

### 9.3 并发安全

- `/bridge model` 快速连续切换：CAS 保证最终一致性，不匹配时提示重试
- ProviderManager.scan() 在 FeishuBot 初始化时执行一次，后续只读

## 10. 实现范围

### Phase 1（核心，本期实现）

1. 新增 `src/utils/providers.ts`：ProviderManager 类
   - `scan()` 三层 fallback 逻辑
   - `generateFromCcSwitch()` 数据库读取和配置净化
   - `resolve()` / `resolveByIndex()` / `list()` 查询方法
   - `sanitizeName()` alias 生成

2. 数据模型变更
   - `MappingEntry` 新增 `defaultProvider?: string`
   - `SessionEntrySchema` 新增 `lastKnownProvider`
   - `entriesMatch()` 不比较 `defaultProvider`

3. `src/feishu/bot.ts` 命令层
   - 新增 `handleModel()` 方法
   - 更新 `helpText()`
   - 更新 `parseNewCommand()` 支持 `--model`
   - 更新 `handleNew()` 处理 `--model`
   - 更新 `handleList()` 显示 `lastKnownProvider`
   - 更新 `doStatus()` 显示当前模型

4. `src/proxy/session.ts` spawn 逻辑
   - `sendMessage()` / `sendStreamingMessage()` 新增 `openId` 参数
   - `_doSendMessage()` 根据 `defaultProvider` 添加 `--settings`
   - 调用方传入 `msg.openId`

5. FeishuBot 初始化时调用 `providerManager.scan()`

### Phase 2（后续优化）

- Alias 前缀匹配，多匹配时提示用户
- 检测到 CC Switch db 变更时自动重新 scan
- 交互式卡片中显示模型标签

### Phase 3（可选）

- `config.toml` 新增 `[providers]` 配置段
- 支持从环境变量 `CC_LINKER_PROVIDERS_DIR` 读取自定义目录
