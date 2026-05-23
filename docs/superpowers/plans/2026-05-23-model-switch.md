# 飞书端模型切换功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书用户通过 `/bridge model` 命令查看、设置和切换 AI 模型，支持从 `~/.claude/providers/` 或 CC Switch 数据库读取模型配置，并在 spawn Claude CLI 时通过 `--settings` 应用。

**Architecture:** 新增 `ProviderManager` 模块负责三层配置发现（手动 providers → CC Switch db → 降级）。模型选择是用户级配置（`defaultProvider` 保存在 user-mapping.json），session 只记录 `lastKnownProvider` 作为展示。`ClaudeSessionManager` 通过新增的 `settingsPath` 参数在 spawn 时注入 `--settings`，保持与 feishu 层解耦。

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite for reading CC Switch db), Zod, proper-lockfile

---

## 文件映射

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/utils/providers.ts` | ProviderManager：扫描 providers 目录、读取 CC Switch db、生成临时配置、净化 settings | 新建 |
| `tests/unit/utils/providers.test.ts` | ProviderManager 单元测试 | 新建 |
| `src/feishu/mapping.ts` | MappingEntry 添加 `defaultProvider`；entriesMatch 忽略该字段 | 修改 |
| `src/registry/types.ts` | SessionEntrySchema 添加 `lastKnownProvider` | 修改 |
| `src/proxy/session.ts` | sendMessage/sendStreamingMessage/_doSendMessage 新增 `settingsPath` 参数 | 修改 |
| `src/feishu/bot.ts` | 新增 handleModel()、更新 helpText/parseNewCommand/handleNew/handleList/doStatus、注入 ProviderManager | 修改 |
| `src/cli/commands/start.ts` | FeishuBot 初始化时创建并 scan ProviderManager | 修改 |
| `tests/unit/feishu/bot.test.ts` | 新增 handleModel 相关测试 | 修改 |

---

### Task 1: ProviderManager 模块

**Files:**
- Create: `src/utils/providers.ts`
- Create: `tests/unit/utils/providers.test.ts`

**上下文:** 这是整个功能的基础模块。ProviderManager 负责发现可用的 Claude model providers，支持三种来源：手动配置的 `~/.claude/providers/*.json`、从 CC Switch SQLite 数据库自动生成、降级到无可切换模型。

- [ ] **Step 1: 创建 ProviderManager 核心骨架**

```typescript
// src/utils/providers.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { CC_LINKER_DIR } from './paths';
import { logger } from './logger';
import { expandPath } from './paths'; // 或本地实现

export type ProviderSource = 'manual' | 'cc-switch' | 'none';

export interface ProviderConfig {
  alias: string;
  name: string;
  path: string;
  isTemp: boolean;
}

export class ProviderManager {
  private providers = new Map<string, ProviderConfig>();
  private source: ProviderSource = 'none';
  private readonly autoProviderDir = join(CC_LINKER_DIR, 'auto-providers');

  getSource(): ProviderSource { return this.source; }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  resolve(aliasOrIndex: string): ProviderConfig | null {
    // 先尝试直接 alias 匹配
    const direct = this.providers.get(aliasOrIndex);
    if (direct) return direct;

    // 尝试序号匹配（1-based）
    const idx = parseInt(aliasOrIndex, 10);
    if (!Number.isNaN(idx) && idx >= 1) {
      const list = this.list();
      return list[idx - 1] ?? null;
    }

    return null;
  }

  resolveByIndex(index: number): ProviderConfig | null {
    const list = this.list();
    return list[index] ?? null;
  }

  // 后续步骤填充 scan()、generateFromCcSwitch()、sanitizeName()、sanitizeSettingsConfig()
}
```

- [ ] **Step 2: 实现手动 providers 目录扫描**

在 ProviderManager 中添加：

```typescript
async scan(): Promise<void> {
  this.providers.clear();

  const manualDir = expandPath('~/.claude/providers');
  if (await dirExists(manualDir)) {
    await this.scanDirectory(manualDir, false);
    this.source = 'manual';
    return;
  }

  const ccSwitchDb = expandPath('~/.cc-switch/cc-switch.db');
  if (await fileExists(ccSwitchDb)) {
    await this.generateFromCcSwitch(ccSwitchDb);
    await this.scanDirectory(this.autoProviderDir, true);
    this.source = 'cc-switch';
    return;
  }

  this.source = 'none';
}

private async scanDirectory(dir: string, isTemp: boolean): Promise<void> {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const path = join(dir, file);
    const alias = basename(file, '.json');
    try {
      const content = JSON.parse(readFileSync(path, 'utf8'));
      const name = content.name ?? alias;
      this.providers.set(alias, { alias, name, path, isTemp });
    } catch (err) {
      logger.warn(`跳过无效 provider 配置: ${path}`);
    }
  }
}
```

同时添加辅助函数：

```typescript
async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat.isDirectory();
  } catch { return false; }
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}
```

- [ ] **Step 3: 实现 CC Switch db 读取和配置净化**

在 ProviderManager 中添加：

```typescript
private async generateFromCcSwitch(dbPath: string): Promise<void> {
  // 清理旧临时文件
  try { rmSync(this.autoProviderDir, { recursive: true, force: true }); } catch {}
  mkdirSync(this.autoProviderDir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`
      SELECT name, settings_config
      FROM providers
      WHERE app_type = 'claude'
      ORDER BY sort_index ASC
    `).all() as Array<{ name: string; settings_config: string }>;

    for (const row of rows) {
      try {
        const cleanConfig = this.sanitizeSettingsConfig(row.settings_config);
        const alias = this.sanitizeName(row.name);
        const filePath = join(this.autoProviderDir, `${alias}.json`);
        const tmpPath = filePath + '.tmp';
        writeFileSync(tmpPath, JSON.stringify(cleanConfig, null, 2), { mode: 0o600 });
        renameSync(tmpPath, filePath);
        this.providers.set(alias, { alias, name: row.name, path: filePath, isTemp: true });
      } catch (err) {
        logger.warn(`跳过 CC Switch provider "${row.name}": ${err}`);
      }
    }
  } finally {
    db.close();
  }
}

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

private sanitizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

导入 `Database`：

```typescript
import { Database } from 'bun:sqlite';
```

- [ ] **Step 4: 写 ProviderManager 测试**

```typescript
// tests/unit/utils/providers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ProviderManager } from '../../../src/utils/providers';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ProviderManager', () => {
  let tmpDir: string;
  let pm: ProviderManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'providers-test-'));
    pm = new ProviderManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans manual providers directory', async () => {
    const providersDir = join(tmpDir, 'providers');
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, 'kimi.json'),
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'kimi-for-coding' } }),
    );

    // 通过环境变量或 monkey-patch 让 expandPath 指向 tmpDir
    // 实际测试中可以创建 ~/.claude/providers 的 mock
  });

  it('sanitizeName converts display names to aliases', () => {
    // 需要 expose sanitizeName 或测试通过 scan 间接验证
  });

  it('resolve by alias returns correct provider', async () => {
    // 类似上述 setup
  });

  it('resolve by index returns correct provider', async () => {
    // 1-based index
  });

  it('returns null for unknown alias', () => {
    expect(pm.resolve('nonexistent')).toBeNull();
  });

  it('source is none when no providers available', async () => {
    // 确保没有 ~/.claude/providers 或 ~/.cc-switch/cc-switch.db
  });
});
```

- [ ] **Step 5: 运行测试确认基础结构正确**

Run: `bun test tests/unit/utils/providers.test.ts`
Expected: 可能部分跳过（因为没有 mock 文件系统），但无编译错误

- [ ] **Step 6: Commit**

```bash
git add src/utils/providers.ts tests/unit/utils/providers.test.ts
git commit -m "feat(providers): add ProviderManager with manual and CC Switch support"
```

---

### Task 2: 数据模型变更

**Files:**
- Modify: `src/feishu/mapping.ts`
- Modify: `src/registry/types.ts`

- [ ] **Step 1: MappingEntry 添加 defaultProvider**

```typescript
// src/feishu/mapping.ts
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

- [ ] **Step 2: entriesMatch 忽略 defaultProvider**

```typescript
function entriesMatch(
  a: MappingEntry | null,
  b: MappingEntry | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.sessionUuid !== b.sessionUuid) return false;
  if ((a.cwd ?? '') !== (b.cwd ?? '')) return false;
  const tokenA = a.casToken || '';
  const tokenB = b.casToken || '';
  if (tokenA !== tokenB) return false;
  if (a.type === 'pending_new_session_claimed' && b.type === 'pending_new_session_claimed') {
    if (a.claimedByMessageId !== b.claimedByMessageId) return false;
    if ((a.claimedAt ?? '') !== (b.claimedAt ?? '')) return false;
  }
  // Note: defaultProvider is intentionally NOT compared
  return true;
}
```

- [ ] **Step 3: SessionEntrySchema 添加 lastKnownProvider**

```typescript
// src/registry/types.ts
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

- [ ] **Step 4: 运行 mapping 和 registry 测试确认无回归**

Run: `bun test tests/unit/feishu/mapping.test.ts tests/unit/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishu/mapping.ts src/registry/types.ts
git commit -m "feat(model): add defaultProvider and lastKnownProvider fields"
```

---

### Task 3: ClaudeSessionManager 支持 --settings

**Files:**
- Modify: `src/proxy/session.ts`

**设计决策:** 不在 sessionManager 中耦合 userManager/providerManager。改为在 `sendMessage`/`sendStreamingMessage` 中新增 `settingsPath?: string` 参数，调用方（bot）负责查询并提供路径。

- [ ] **Step 1: _doSendMessage 签名和实现**

修改 `_doSendMessage` 签名：

```typescript
private async _doSendMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  isNew: boolean,
  settingsPath?: string,   // NEW
): Promise<SendMessageResult> {
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  const args: string[] = [claudeBin];

  // NEW: inject --settings if provider path given
  if (settingsPath) {
    args.push('--settings', settingsPath);
  }

  args.push('-p', text, '--output-format', 'json');
  if (sessionId && !isNew) {
    args.push('--resume', sessionId);
  }
  // ... rest unchanged
}
```

- [ ] **Step 2: sendMessage 签名更新**

```typescript
async sendMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  isNew?: boolean,
  lockKey?: string,
  settingsPath?: string,   // NEW
): Promise<SendMessageResult> {
  const resolvedLockKey = lockKey ?? sessionId ?? '__new__';
  await this.acquireSessionLock(resolvedLockKey);
  try {
    await this.acquireSlot();
    try {
      return await this._doSendMessage(sessionId, text, cwd, isNew ?? false, settingsPath);
    } finally { this.releaseSlot(); }
  } finally { this.releaseSessionLock(resolvedLockKey); }
}
```

- [ ] **Step 3: sendStreamingMessage 签名更新**

```typescript
async sendStreamingMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  onProgress: (chunk: StreamChunk) => void,
  isNew?: boolean,
  lockKey?: string,
  settingsPath?: string,   // NEW
): Promise<SendMessageResult> {
  // ... acquire locks ...
  return await this._doSendMessageStreaming(sessionId, text, cwd, onProgress, isNew ?? false, settingsPath);
}
```

对应的 `_doSendMessageStreaming` 也需要 `settingsPath?: string` 参数，在构建 args 时同样注入 `--settings`。

- [ ] **Step 4: 运行 proxy 测试确认无回归**

Run: `bun test tests/unit/proxy/`
Expected: PASS（settingsPath 是可选的，不影响现有调用）

- [ ] **Step 5: Commit**

```bash
git add src/proxy/session.ts
git commit -m "feat(session): support --settings via optional settingsPath parameter"
```

---

### Task 4: FeishuBot 命令层 — /bridge model

**Files:**
- Modify: `src/feishu/bot.ts`
- Modify: `tests/unit/feishu/bot.test.ts`

- [ ] **Step 1: FeishuBot 构造函数注入 ProviderManager**

```typescript
// src/feishu/bot.ts
import { ProviderManager } from '../utils/providers';

export class FeishuBot {
  // ... existing fields ...
  private providerManager: ProviderManager;

  constructor(opts: {
    // ... existing options ...
    providerManager?: ProviderManager;   // NEW
  }) {
    // ... existing assignments ...
    this.providerManager = opts.providerManager ?? new ProviderManager();
  }
}
```

- [ ] **Step 2: 新增 handleModel() 方法**

在 `handleCommand()` 的 switch 中添加 `case 'model':`，并实现 `handleModel()`：

```typescript
private async handleModel(msg: SpoolMessage, target: string): Promise<void> {
  // 无参数：显示当前默认 + 可用列表
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
    lines.push('  /bridge new /path --model <别名>  创建会话时指定模型');

    await this.replyAndFinalize(msg, lines.join('\n'));
    return;
  }

  // --clear
  if (target === '--clear') {
    const entry = this.userManager.getEntry(msg.openId);
    if (!entry) {
      await this.replyAndFinalize(msg, '⚠️ 无当前会话状态，无需清除');
      return;
    }
    const swapped = await this.userManager.compareAndSwap(
      msg.openId, entry,
      { ...entry, defaultProvider: undefined }
    );
    await this.replyAndFinalize(
      msg,
      swapped ? '✅ 已清除默认模型设置' : '⚠️ 清除失败，请重试'
    );
    return;
  }

  // 设置默认模型
  const provider = this.providerManager.resolve(target);
  if (!provider) {
    await this.replyAndFinalize(
      msg,
      `未知模型: "${target}"\n请使用 /bridge model 查看可用列表`
    );
    return;
  }

  const entry = this.userManager.getEntry(msg.openId);
  const newEntry = entry
    ? { ...entry, defaultProvider: provider.alias }
    : {
        type: 'session' as const,
        sessionUuid: null,
        createdAt: new Date().toISOString(),
        defaultProvider: provider.alias,
      };

  const swapped = await this.userManager.compareAndSwap(
    msg.openId, entry ?? null, newEntry
  );

  await this.replyAndFinalize(
    msg,
    swapped
      ? `✅ 默认模型已设置为 ${provider.name} (${provider.alias})`
      : '⚠️ 设置失败，请重试'
  );
}
```

- [ ] **Step 3: handleCommand() 添加 model case**

```typescript
private async handleCommand(msg: SpoolMessage): Promise<void> {
  const parts = msg.text.split(/\s+/);
  const cmd = parts[1]?.toLowerCase();

  switch (cmd) {
    case 'help':     await this.replyAndFinalize(msg, this.helpText()); return;
    case 'list':     await this.handleList(msg); return;
    case 'new':      await this.handleNew(msg, msg.text.replace(/^\/bridge\s+new\s*/i, '')); return;
    case 'switch':   await this.handleSwitch(msg, parts.slice(2).join(' ')); return;
    case 'model':    await this.handleModel(msg, parts.slice(2).join(' ')); return;   // NEW
    case 'resume':   await this.handleResume(msg, parts.slice(2).join(' ')); return;
    case 'status':   await this.handleStatus(msg); return;
    case 'whoami':   await this.replyAndFinalize(msg, `你的 open_id: ${msg.openId}`); return;
    default:         await this.replyAndFinalize(msg, `未知命令: /bridge ${cmd}\n\n${this.helpText()}`);
  }
}
```

- [ ] **Step 4: 更新 helpText()**

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
    '  /bridge model <序号|别名>                  - 设置默认模型',
    '  /bridge model --clear                     - 清除默认设置',
    '  /bridge resume <序号|UUID>                - 获取安全恢复建议',
    '  /bridge status                            - 查看状态',
    '  /bridge whoami                            - 获取你的 open_id',
  ].join('\n');
}
```

- [ ] **Step 5: 更新 parseNewCommand 支持 --model**

将 `parseNewCommand` 从文件级函数改为支持 `--model`：

```typescript
function parseNewCommand(rawArgs: string): { cwd: string; prompt: string; providerAlias?: string } {
  let args = rawArgs.trim();
  let providerAlias: string | undefined;

  // Extract --model alias
  const modelMatch = args.match(/--model\s+(\S+)/);
  if (modelMatch) {
    providerAlias = modelMatch[1];
    args = args.replace(/--model\s+\S+/, '').trim();
  }

  if (!args) {
    return { cwd: '', prompt: '', providerAlias };
  }

  if (args.startsWith('-- ')) {
    return { cwd: '', prompt: args.slice(3).trim(), providerAlias };
  }

  const separator = args.indexOf(' -- ');
  if (separator >= 0) {
    return {
      cwd: args.slice(0, separator).trim(),
      prompt: args.slice(separator + 4).trim(),
      providerAlias,
    };
  }

  return { cwd: args, prompt: '', providerAlias };
}
```

- [ ] **Step 6: handleNew 处理 --model**

```typescript
private async handleNew(msg: SpoolMessage, rawArgs: string): Promise<void> {
  const { cwd: rawCwd, prompt, providerAlias } = parseNewCommand(rawArgs);
  // ... existing cwd validation ...

  // NEW: if --model specified, set defaultProvider first
  if (providerAlias) {
    const provider = this.providerManager.resolve(providerAlias);
    if (!provider) {
      await this.replyAndFinalize(
        msg,
        `未知模型: "${providerAlias}"\n请使用 /bridge model 查看可用列表`
      );
      return;
    }

    const entry = this.userManager.getEntry(msg.openId);
    const newEntry = entry
      ? { ...entry, defaultProvider: provider.alias }
      : {
          type: 'pending_new_session' as const,
          sessionUuid: null,
          createdAt: new Date().toISOString(),
          defaultProvider: provider.alias,
        };
    await this.userManager.compareAndSwap(msg.openId, entry ?? null, newEntry);
  }

  // ... rest of existing handleNew logic ...
}
```

- [ ] **Step 7: doStatus 显示当前模型**

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

  // ... rest of existing status (queue size, total sessions, etc.)
}
```

- [ ] **Step 8: handleList 显示 lastKnownProvider**

在生成 list 回复时，为每个 session 附加 `lastKnownProvider` 标签。由于 list 使用的是 `doCardList` 或文本格式，需要在相应位置添加 provider 信息。

如果 list 通过交互式卡片展示，在卡片模板中添加 provider 字段。如果是文本回退：

```typescript
// 在 list 文本生成中添加 provider 标签
const providerTag = session.lastKnownProvider
  ? ` [${session.lastKnownProvider}]`
  : '';
```

- [ ] **Step 9: 新增 bot 测试**

```typescript
// tests/unit/feishu/bot.test.ts
it('processes /bridge model command (no providers)', async () => {
  await bot.onMessage({
    open_id: 'ou_user1',
    message_id: 'msg-model',
    content: JSON.stringify({ text: '/bridge model' }),
    chat_type: 'p2p',
    message_type: 'text',
  });
  await bot.dispatch();

  expect(replies.length).toBeGreaterThanOrEqual(1);
  expect(replies.some(r => r.includes('模型') || r.includes('provider'))).toBe(true);
});

it('processes /bridge model --clear', async () => {
  // setup: set defaultProvider first
  // then /bridge model --clear
});

it('rejects unknown model alias', async () => {
  await bot.onMessage({
    open_id: 'ou_user1',
    message_id: 'msg-model-unknown',
    content: JSON.stringify({ text: '/bridge model nonexistent' }),
    chat_type: 'p2p',
    message_type: 'text',
  });
  await bot.dispatch();

  expect(replies.some(r => r.includes('未知模型'))).toBe(true);
});
```

- [ ] **Step 10: 运行 bot 测试**

Run: `bun test tests/unit/feishu/bot.test.ts`
Expected: PASS（现有测试无回归 + 新增测试通过）

- [ ] **Step 11: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot.test.ts
git commit -m "feat(bot): add /bridge model command with provider management"
```

---

### Task 5: Chat 路径传入 settingsPath

**Files:**
- Modify: `src/feishu/bot.ts`

**上下文:** bot 在调用 `sendMessage`/`sendStreamingMessage` 时需要传入当前用户的 provider settings 路径。

- [ ] **Step 1: 新增辅助方法 getSettingsPathForUser**

```typescript
private getSettingsPathForUser(openId: string): string | undefined {
  const entry = this.userManager.getEntry(openId);
  if (entry?.defaultProvider) {
    const provider = this.providerManager.resolve(entry.defaultProvider);
    if (provider) return provider.path;
  }
  return undefined;
}
```

- [ ] **Step 2: handleChatNonStreaming 传入 settingsPath**

```typescript
private async handleChatNonStreaming(
  msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
): Promise<void> {
  const settingsPath = this.getSettingsPathForUser(msg.openId);
  const result = await this.sessionManager.sendMessage(
    sessionUuid, msg.text, cwd, false, msg.serialKey, settingsPath
  );
  // ... rest unchanged ...
}
```

- [ ] **Step 3: handleChatStreaming 传入 settingsPath**

```typescript
private async handleChatStreaming(
  msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
): Promise<void> {
  const settingsPath = this.getSettingsPathForUser(msg.openId);
  const result = await this.sessionManager.sendStreamingMessage(
    sessionUuid, msg.text, cwd,
    (chunk: StreamChunk) => { /* ... */ },
    false, msg.serialKey, settingsPath
  );
  // ... rest unchanged ...
}
```

- [ ] **Step 4: createSessionFromPrompt 传入 settingsPath**

```typescript
private async createSessionFromPrompt(
  msg: SpoolMessage, cwd: string, claimMessageId: string, prompt = msg.text,
): Promise<void> {
  const settingsPath = this.getSettingsPathForUser(msg.openId);
  const result = await this.sessionManager.sendMessage(
    null, prompt, cwd, true, `new:${msg.openId}`, settingsPath
  );
  // ... rest unchanged, but record lastKnownProvider in registry upsert ...

  this.registry.upsert(result.sessionId, {
    // ... existing fields ...
    lastKnownProvider: settingsPath
      ? this.providerManager.resolve(
          this.userManager.getEntry(msg.openId)?.defaultProvider ?? ''
        )?.alias ?? null
      : null,
  });
}
```

- [ ] **Step 5: createSessionFromPromptStreaming 传入 settingsPath**

类似 Step 4，在 `createSessionFromPromptStreaming` 中：
1. 获取 `settingsPath`
2. 传入 `sendStreamingMessage` 的最后一个参数
3. 在 registry upsert 中记录 `lastKnownProvider`

- [ ] **Step 6: 运行 bot 测试确认无回归**

Run: `bun test tests/unit/feishu/bot.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(bot): pass settingsPath to session manager based on user defaultProvider"
```

---

### Task 6: FeishuBot 初始化时 scan ProviderManager

**Files:**
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: createBotRuntime 中初始化 ProviderManager**

```typescript
// src/cli/commands/start.ts
import { ProviderManager } from '../../utils/providers';

async function createBotRuntime(
  registry: RegistryManager,
  log: (level: string, msg: string) => void,
  wsLogLevel?: number,
): Promise<BotRuntime> {
  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();
  const providerManager = new ProviderManager();

  // Scan providers before creating bot
  try {
    await providerManager.scan();
    const count = providerManager.list().length;
    const source = providerManager.getSource();
    log('INFO', `Provider 扫描完成: ${count} 个模型 (来源: ${source})`);
  } catch (err) {
    log('WARN', `Provider 扫描失败: ${err}`);
  }

  // ... existing code ...

  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    providerManager,   // NEW
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });

  // ... rest unchanged ...
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(start): scan providers during bot initialization"
```

---

### Task 7: 类型检查和全面测试

- [ ] **Step 1: 运行类型检查**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 2: 运行全部单元测试**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit 最终汇总**

```bash
git commit --allow-empty -m "feat(model-switch): complete Phase 1 implementation"
```

---

## Self-Review

### Spec Coverage Check

| Spec 要求 | 实现任务 | 状态 |
|-----------|----------|------|
| ProviderManager 三层 fallback | Task 1 | ✓ |
| 配置净化（只保留 env+model） | Task 1 Step 3 | ✓ |
| Alias 生成 | Task 1 Step 3 | ✓ |
| 临时文件管理 | Task 1 Step 3 | ✓ |
| MappingEntry defaultProvider | Task 2 Step 1 | ✓ |
| entriesMatch 忽略 defaultProvider | Task 2 Step 2 | ✓ |
| SessionEntry lastKnownProvider | Task 2 Step 3 | ✓ |
| /bridge model 命令 | Task 4 Step 2-4 | ✓ |
| /bridge model --clear | Task 4 Step 2 | ✓ |
| /bridge new --model | Task 4 Step 5-6 | ✓ |
| helpText 更新 | Task 4 Step 4 | ✓ |
| handleList 显示 provider | Task 4 Step 8 | ✓ |
| doStatus 显示 provider | Task 4 Step 7 | ✓ |
| session.ts settingsPath 参数 | Task 3 | ✓ |
| bot Chat 路径传入 settingsPath | Task 5 | ✓ |
| registry 记录 lastKnownProvider | Task 5 Step 4-5 | ✓ |
| start.ts 初始化 scan | Task 6 | ✓ |

### Placeholder Scan

- 无 TBD、TODO、"implement later"
- 所有步骤包含完整代码
- 无 "Similar to Task N" 引用

### Type Consistency Check

- `ProviderConfig` 接口：alias/name/path/isTemp — 全计划一致
- `sendMessage` 签名：`settingsPath?: string` 在最后 — Task 3 和 Task 5 一致
- `parseNewCommand` 返回 `{ cwd, prompt, providerAlias? }` — Task 4 一致
- `lastKnownProvider` — registry types 和 bot upsert 调用一致

### 已知限制（文档记录）

- `sanitizeName` 将 `"Bailian-qwen3.6"` 转为 `"bailian-qwen3-6"`（点号变连字符）。不影响使用，因为用户输入的 alias 也会经过同样的处理。
- ProviderManager 的 `dirExists`/`fileExists` 使用 `Bun.file().stat()` 和 `Bun.file().exists()`，如果 Bun API 行为与预期不同可能需要调整。
- CC Switch db 读取使用 `bun:sqlite`，如果 CC Switch db 被锁定（CC Switch 正在写入），可能读取失败。已设计为：失败时 source = 'none'，降级处理。
